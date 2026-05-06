// services/v4/AlephEnhancementOrchestrator.js
// 2026-05-05 — Aleph Rec 2 Phase 3.
//
// Coordinates the user-triggered "Enhance with Aleph" flow for commercial
// episodes. Implements Option B architecture (Director Agent A2.1):
// operates on the post-LUT intermediate (graded video, no music/cards/subs
// baked in), so subtitles and title cards are NEVER stylized. Re-runs
// Stages 4-6 of post-production AFTER Aleph completes.
//
// Flow (5 steps + 2 finalization):
//   1. Load post_lut_intermediate_url → download to local Buffer + temp file
//   2. Probe duration; chunk into ≤8s segments aligned to scene boundaries
//      where possible (chunk boundaries hidden by scene cuts)
//   3. For each chunk:
//        a. Upload chunk to a temp Supabase Storage URL (Aleph requires HTTPS)
//        b. Call RunwayAlephService.applyStylization() with shared prompt +
//           shared reference image (cross-chunk consistency)
//        c. Save stylized chunk locally
//   4. ffmpeg concat all stylized chunks → assembled stylized MP4
//   5. HARD GATE — Director Agent identity_lock:
//        a. Extract 1-3 representative midframes from the stylized assembly
//        b. judgePostStylizationIdentity() against each persona's CIP-front
//        c. If avg score < 85: ABORT, return original final_video_url
//        d. If avg score ≥ 85: continue
//   6. Re-run Stages 4 (music duck) → 5 (title/end cards) → 6 (subtitle burn-in)
//      via PostProduction.applyMusicCardsAndSubsToAssembled()
//   7. Upload as aleph_enhanced_video_url + update episode aleph_job_metadata
//
// Cost control:
//   ~$0.15/sec output × ~60s commercial = ~$9 per enhancement (chunked)
//   Identity-gate failure → no aleph_enhanced_video_url written. When billing
//   enabled (BRAND_STORY_ALEPH_BILLING_ENABLED=true), the failure path
//   refunds via aleph_job_metadata.billing_status='refunded'. During testing
//   (default), all enhancements are free regardless of pass/fail.
//
// Director Agent integration:
//   The post-stylization identity judge reads the persona's
//   canonical_identity_urls[0] (CIP-front) as the reference image. The
//   stylized midframe is the candidate. Pass at 85+ per A2.2 amendment.

import { spawnSync } from 'child_process';
import { promises as fsp, default as fs } from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';
import winston from 'winston';

import runwayAlephService, { ALEPH_MAX_DURATION } from '../RunwayAlephService.js';
import { extractBeatEndframe } from './StoryboardHelpers.js';
import { applyMusicCardsAndSubsToAssembled } from './PostProduction.js';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `[AlephEnhance] ${timestamp} [${level}]: ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

// Identity hard gate threshold (Director Agent A2.2 — 85 is the prestige
// floor; commercial accepts 80 in soft mode if/when we add a soft tier).
const IDENTITY_GATE_PASS_THRESHOLD = 85;

// Number of midframes to extract for the identity hard gate. More frames =
// more robust judgment but more Vertex calls. 3 covers opening / middle /
// end of episode without burning budget.
const IDENTITY_GATE_FRAME_COUNT = 3;

// Aleph chunk target. Aleph caps at 10s output per call; we use 8s with 2s
// of overlap headroom in case the scene-boundary alignment requires
// extending a chunk. If the source is ≤ 10s, a single call suffices.
const ALEPH_CHUNK_TARGET_SEC = 8;

class AlephEnhancementOrchestrator {
  /**
   * @param {Object} params
   * @param {Object} params.directorAgent - DirectorAgent instance (must be configured)
   * @param {Function} params.uploadBufferToStorage - (buffer, subfolder, filename, mimeType) => Promise<publicUrl>
   * @param {Function} [params.progress] - optional (stage, message, detail?) => void for SSE
   * @param {Object} [params.alephService=runwayAlephService] - injectable for tests
   */
  constructor({ directorAgent, uploadBufferToStorage, progress = null, alephService = runwayAlephService }) {
    if (!directorAgent) throw new Error('AlephEnhancementOrchestrator: directorAgent required');
    if (!uploadBufferToStorage) throw new Error('AlephEnhancementOrchestrator: uploadBufferToStorage required');

    this.directorAgent = directorAgent;
    this.alephService = alephService;
    this.uploadBufferToStorage = uploadBufferToStorage;
    this.progress = progress || (() => {});
  }

  /**
   * Main entry point. Run the full Aleph enhancement flow for one commercial episode.
   *
   * @param {Object} params
   * @param {Object} params.episode - episode row (must have post_lut_intermediate_url)
   * @param {Object} params.story - parent story (commercial_brief, brand_kit, personas)
   * @param {Array<Object>} params.personas - persona records (must have canonical_identity_urls)
   * @param {Object|null} params.brandKit
   * @param {Array<Object>} params.beatMetadata - same shape used for the original final
   * @param {Object|null} params.musicBedBuffer - same buffer used for the original final (optional re-fetch)
   * @param {Object|null} params.episodeMeta - { series_title, episode_title, cliffhanger, brand_kit, cta_text }
   * @param {Object} [params.options]
   * @param {number} [params.options.strength=0.20] - Aleph strength (capped by service)
   * @returns {Promise<{ passed: boolean, alephEnhancedVideoUrl: string|null, finalBuffer: Buffer|null, identityScore: number, costUsd: number, taskIds: string[], reason: string }>}
   */
  async enhance({
    episode,
    story,
    personas = [],
    brandKit = null,
    beatMetadata = [],
    musicBedBuffer = null,
    episodeMeta = null,
    options = {}
  }) {
    const startTime = Date.now();
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aleph-enhance-'));
    const tempPaths = [tempDir];
    const taskIds = [];
    let totalCostUsd = 0;

    try {
      this.progress('aleph_started', 'Downloading post-LUT intermediate');

      // ── Step 1: load post-LUT intermediate ──
      if (!episode?.post_lut_intermediate_url) {
        throw new Error('episode has no post_lut_intermediate_url — cannot run Aleph (regenerate the episode first)');
      }
      const sourceBuffer = await this._downloadVideo(episode.post_lut_intermediate_url);
      const sourcePath = path.join(tempDir, 'source.mp4');
      await fsp.writeFile(sourcePath, sourceBuffer);
      logger.info(`source loaded ${(sourceBuffer.length / 1024 / 1024).toFixed(1)}MB from ${episode.post_lut_intermediate_url.slice(0, 80)}...`);

      // ── Step 2: probe + chunk ──
      const totalDurationSec = this._probeDuration(sourcePath);
      logger.info(`source duration: ${totalDurationSec.toFixed(2)}s`);

      const chunks = this._planChunks(totalDurationSec, beatMetadata);
      this.progress('aleph_progress', `Stylizing ${chunks.length} chunk${chunks.length === 1 ? '' : 's'}`, { totalDurationSec, chunkCount: chunks.length });

      // ── Step 3: chunk + stylize ──
      const stylizedChunkPaths = [];
      const stylePrompt = this._buildStylePrompt(story, brandKit);
      const referenceImageUrl = brandKit?.style_reference_url || personas?.[0]?.canonical_identity_urls?.[0] || null;

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const chunkLabel = `chunk ${i + 1}/${chunks.length} [${chunk.startSec.toFixed(1)}-${chunk.endSec.toFixed(1)}s]`;
        this.progress('aleph_progress', `Stylizing ${chunkLabel}`, { chunkIndex: i, totalChunks: chunks.length });

        // 3a. cut chunk
        const chunkPath = path.join(tempDir, `chunk-${i}.mp4`);
        this._extractChunk(sourcePath, chunkPath, chunk.startSec, chunk.endSec - chunk.startSec);
        const chunkBuffer = await fsp.readFile(chunkPath);

        // 3b. upload to temp public URL for Aleph to fetch
        const tempUploadUrl = await this.uploadBufferToStorage(
          chunkBuffer,
          `videos/aleph-temp/${episode.id}`,
          `chunk-${i}.mp4`,
          'video/mp4'
        );

        // 3c. call Aleph with shared prompt + reference (cross-chunk consistency)
        const alephResult = await this.alephService.applyStylization({
          videoUrl: tempUploadUrl,
          prompt: stylePrompt,
          referenceImageUrl,
          options: {
            strength: options.strength ?? 0.20,
            ratio: '720:1280' // V4 9:16 vertical
          }
        });

        taskIds.push(alephResult.taskId);
        totalCostUsd += alephResult.costUsd;

        // 3d. save stylized chunk
        const stylizedPath = path.join(tempDir, `stylized-${i}.mp4`);
        await fsp.writeFile(stylizedPath, alephResult.videoBuffer);
        stylizedChunkPaths.push(stylizedPath);
        tempPaths.push(stylizedPath);

        logger.info(`${chunkLabel} stylized — task=${alephResult.taskId}, cost=$${alephResult.costUsd.toFixed(2)}`);
      }

      // ── Step 4: concat stylized chunks ──
      this.progress('aleph_progress', 'Concatenating stylized chunks');
      const concatPath = path.join(tempDir, 'stylized-assembled.mp4');
      tempPaths.push(concatPath);
      this._concatStylizedChunks(stylizedChunkPaths, concatPath);

      // ── Step 5: identity hard gate ──
      this.progress('aleph_identity_check', 'Running identity hard gate');
      const concatBuffer = await fsp.readFile(concatPath);
      const concatDurationSec = this._probeDuration(concatPath);
      const gateResult = await this._runIdentityHardGate({
        stylizedVideoBuffer: concatBuffer,
        stylizedDurationSec: concatDurationSec,
        personas
      });

      if (!gateResult.passed) {
        this.progress('aleph_failed_identity_gate', `Identity drift detected (score ${gateResult.avgScore.toFixed(0)}/100). Original preserved.`, { avgScore: gateResult.avgScore });
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        logger.warn(`identity hard gate FAILED — avg ${gateResult.avgScore.toFixed(0)} < ${IDENTITY_GATE_PASS_THRESHOLD}; aborted in ${elapsed}s, cost $${totalCostUsd.toFixed(2)} (refundable when billing enabled)`);
        return {
          passed: false,
          alephEnhancedVideoUrl: null,
          finalBuffer: null,
          identityScore: gateResult.avgScore,
          costUsd: totalCostUsd,
          taskIds,
          reason: `identity_lock_score ${gateResult.avgScore.toFixed(0)} below threshold ${IDENTITY_GATE_PASS_THRESHOLD}`
        };
      }

      logger.info(`identity hard gate PASSED — avg ${gateResult.avgScore.toFixed(0)} >= ${IDENTITY_GATE_PASS_THRESHOLD}`);

      // ── Step 6: re-run Stages 4-6 (music + cards + subs) on stylized assembly ──
      this.progress('aleph_post_processing', 'Applying music + cards + subtitles to stylized output');
      const { finalBuffer } = await applyMusicCardsAndSubsToAssembled({
        assembledVideoPath: concatPath,
        musicBedBuffer,
        beatMetadata,
        episodeMeta,
        burnSubtitles: true
      });

      // ── Step 7: upload as aleph_enhanced_video_url ──
      this.progress('aleph_post_processing', 'Uploading enhanced episode');
      const alephEnhancedVideoUrl = await this.uploadBufferToStorage(
        finalBuffer,
        'videos/v4-aleph-enhanced',
        `episode-${episode.episode_number || episode.id}-aleph-enhanced.mp4`,
        'video/mp4'
      );

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      this.progress('aleph_complete', `Cinema-grade enhancement ready in ${elapsed}s`, {
        alephEnhancedVideoUrl,
        identityScore: gateResult.avgScore,
        costUsd: totalCostUsd
      });
      logger.info(`Aleph enhancement COMPLETE in ${elapsed}s — identity ${gateResult.avgScore.toFixed(0)}, cost $${totalCostUsd.toFixed(2)}`);

      return {
        passed: true,
        alephEnhancedVideoUrl,
        finalBuffer,
        identityScore: gateResult.avgScore,
        costUsd: totalCostUsd,
        taskIds,
        reason: 'success'
      };
    } finally {
      // Best-effort cleanup of temp files
      try {
        await fsp.rm(tempDir, { recursive: true, force: true });
      } catch (err) {
        logger.warn(`cleanup failed (non-fatal): ${err.message}`);
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────────────

  /**
   * Plan chunks. Aim for ≤ ALEPH_CHUNK_TARGET_SEC (8s) per chunk; clamp to
   * ALEPH_MAX_DURATION (10s) hard ceiling. Align to scene boundaries from
   * beatMetadata when possible — chunk seams are less visible when they
   * coincide with scene cuts.
   */
  _planChunks(totalDurationSec, beatMetadata = []) {
    if (totalDurationSec <= ALEPH_CHUNK_TARGET_SEC) {
      return [{ startSec: 0, endSec: totalDurationSec }];
    }

    // Build a list of beat boundary timestamps (cumulative duration at the
    // END of each beat). These are the candidate chunk-seam positions.
    const beatEnds = [];
    let cursor = 0;
    for (const beat of beatMetadata) {
      cursor += (beat.actual_duration_sec || beat.duration_seconds || 0);
      beatEnds.push(cursor);
    }

    const chunks = [];
    let chunkStart = 0;
    while (chunkStart < totalDurationSec - 0.1) {
      const chunkMaxEnd = Math.min(chunkStart + ALEPH_MAX_DURATION, totalDurationSec);
      const chunkTargetEnd = Math.min(chunkStart + ALEPH_CHUNK_TARGET_SEC, totalDurationSec);

      // Find a beat boundary close to chunkTargetEnd (within ±2s) to align
      // the chunk seam to a natural cut.
      let chunkEnd = chunkTargetEnd;
      let bestDelta = Infinity;
      for (const beatEnd of beatEnds) {
        if (beatEnd <= chunkStart + 0.5) continue; // skip past beats
        if (beatEnd > chunkMaxEnd) break;          // exceeds Aleph cap
        const delta = Math.abs(beatEnd - chunkTargetEnd);
        if (delta < bestDelta && delta <= 2.0) {
          bestDelta = delta;
          chunkEnd = beatEnd;
        }
      }

      // Ensure final chunk reaches the end exactly.
      if (totalDurationSec - chunkEnd < 2.0) {
        chunkEnd = totalDurationSec;
      }
      // Enforce min/max.
      chunkEnd = Math.min(chunkMaxEnd, Math.max(chunkStart + 2.0, chunkEnd));

      chunks.push({ startSec: chunkStart, endSec: chunkEnd });
      chunkStart = chunkEnd;
    }
    return chunks;
  }

  _probeDuration(videoPath) {
    const result = spawnSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath
    ], { encoding: 'utf-8' });
    if (result.status !== 0) {
      throw new Error(`ffprobe failed on ${videoPath}: ${result.stderr}`);
    }
    return parseFloat(result.stdout.trim()) || 0;
  }

  _extractChunk(sourcePath, outputPath, startSec, durationSec) {
    const result = spawnSync('ffmpeg', [
      '-y',
      '-ss', String(startSec),
      '-i', sourcePath,
      '-t', String(durationSec),
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '18', // visually lossless to preserve LUT-graded color through Aleph
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      outputPath
    ], { encoding: 'utf-8' });
    if (result.status !== 0) {
      throw new Error(`ffmpeg chunk extract failed: ${result.stderr.slice(-500)}`);
    }
  }

  _concatStylizedChunks(chunkPaths, outputPath) {
    if (chunkPaths.length === 1) {
      // No concat needed — single chunk → just copy
      const result = spawnSync('ffmpeg', [
        '-y',
        '-i', chunkPaths[0],
        '-c', 'copy',
        '-movflags', '+faststart',
        outputPath
      ], { encoding: 'utf-8' });
      if (result.status !== 0) {
        throw new Error(`ffmpeg single-chunk copy failed: ${result.stderr.slice(-500)}`);
      }
      return;
    }

    // Multi-chunk concat via ffmpeg concat demuxer (requires re-encode for
    // safety because chunks come back from Aleph with potentially different
    // pix_fmt / SAR / timebase).
    const concatListPath = `${outputPath}.list`;
    const listContent = chunkPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(concatListPath, listContent);

    try {
      const result = spawnSync('ffmpeg', [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', concatListPath,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '18',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', '+faststart',
        outputPath
      ], { encoding: 'utf-8' });
      if (result.status !== 0) {
        throw new Error(`ffmpeg concat failed: ${result.stderr.slice(-500)}`);
      }
    } finally {
      try { fs.unlinkSync(concatListPath); } catch (_) { /* best-effort */ }
    }
  }

  /**
   * Run the post-stylization identity hard gate. Extracts N representative
   * frames from the stylized assembly and runs judgePostStylizationIdentity
   * against each persona's CIP-front. Averages the scores; pass at 85+.
   *
   * Frame strategy: extract from positions roughly spread across the clip
   * so we sample early/middle/late rather than all from the same moment.
   */
  async _runIdentityHardGate({ stylizedVideoBuffer, stylizedDurationSec, personas }) {
    // No personas (B-roll only commercial) → vacuously pass.
    const personasWithCip = personas.filter(p => Array.isArray(p?.canonical_identity_urls) && p.canonical_identity_urls.length > 0);
    if (personasWithCip.length === 0) {
      logger.info(`no personas with CIP — identity gate vacuously passes`);
      return { passed: true, avgScore: 100, perFrameScores: [] };
    }

    // Extract N midframes. Use extractBeatEndframe at slightly varied
    // positions by re-feeding the buffer and adjusting offsets internally.
    // For simplicity here, we extract at 25%, 50%, 75% of the duration.
    const sampleOffsets = [0.25, 0.50, 0.75].slice(0, IDENTITY_GATE_FRAME_COUNT);
    const frameBuffers = [];
    for (const pct of sampleOffsets) {
      const offsetSec = stylizedDurationSec * pct;
      try {
        const frameBuffer = await this._extractFrameAtOffset(stylizedVideoBuffer, offsetSec);
        if (frameBuffer && frameBuffer.length > 2 * 1024) {
          frameBuffers.push(frameBuffer);
        }
      } catch (err) {
        logger.warn(`midframe extract failed at ${offsetSec.toFixed(1)}s — ${err.message} (continuing)`);
      }
    }

    if (frameBuffers.length === 0) {
      // Fallback: try the canonical endframe extractor (well-tested helper)
      try {
        const fallback = await extractBeatEndframe(stylizedVideoBuffer);
        if (fallback) frameBuffers.push(fallback);
      } catch (_) { /* ignore */ }
    }

    if (frameBuffers.length === 0) {
      logger.warn(`no midframes could be extracted — failing the gate (defensive default)`);
      return { passed: false, avgScore: 0, perFrameScores: [], error: 'frame_extraction_failed' };
    }

    // Judge each frame against the FIRST persona's CIP-front (extending to
    // multi-persona is a v2 enhancement — for now the most prominent persona
    // is the identity anchor).
    const primary = personasWithCip[0];
    const cipUrl = primary.canonical_identity_urls[0];
    const cipBuffer = await this._downloadImage(cipUrl);
    const personaName = primary.name || 'the protagonist';

    const perFrameScores = [];
    for (let i = 0; i < frameBuffers.length; i++) {
      try {
        const verdict = await this.directorAgent.judgePostStylizationIdentity({
          stylizedFrameImage: frameBuffers[i],
          personaReferenceImage: cipBuffer,
          personaName
        });
        perFrameScores.push({
          score: verdict.identity_lock_score,
          pass: verdict.pass,
          reasoning: verdict.reasoning
        });
        logger.info(`frame ${i + 1}/${frameBuffers.length}: identity_lock_score=${verdict.identity_lock_score} pass=${verdict.pass}`);
      } catch (err) {
        logger.warn(`identity judge failed on frame ${i + 1}: ${err.message}`);
        // Don't include in average; treat as missing data.
      }
    }

    if (perFrameScores.length === 0) {
      // All judge calls failed — defensive fail (don't ship unverified output)
      return { passed: false, avgScore: 0, perFrameScores: [], error: 'all_identity_judges_failed' };
    }

    const avgScore = perFrameScores.reduce((sum, s) => sum + s.score, 0) / perFrameScores.length;
    return {
      passed: avgScore >= IDENTITY_GATE_PASS_THRESHOLD,
      avgScore,
      perFrameScores,
      threshold: IDENTITY_GATE_PASS_THRESHOLD
    };
  }

  async _extractFrameAtOffset(videoBuffer, offsetSec) {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'frame-'));
    const videoPath = path.join(tempDir, 'input.mp4');
    const framePath = path.join(tempDir, 'frame.jpg');
    try {
      await fsp.writeFile(videoPath, videoBuffer);
      const result = spawnSync('ffmpeg', [
        '-y',
        '-ss', String(offsetSec),
        '-i', videoPath,
        '-vframes', '1',
        '-q:v', '2',
        framePath
      ], { encoding: 'utf-8' });
      if (result.status !== 0) {
        throw new Error(`ffmpeg frame extract: ${result.stderr.slice(-200)}`);
      }
      const frameBuffer = await fsp.readFile(framePath);
      return frameBuffer;
    } finally {
      try { await fsp.rm(tempDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  }

  async _downloadVideo(url) {
    const resp = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 120000,
      validateStatus: () => true
    });
    if (resp.status >= 400) throw new Error(`download failed ${resp.status}: ${url}`);
    return Buffer.from(resp.data);
  }

  async _downloadImage(url) {
    const resp = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 30000,
      validateStatus: () => true
    });
    if (resp.status >= 400) throw new Error(`image download failed ${resp.status}: ${url}`);
    return Buffer.from(resp.data);
  }

  /**
   * Build the Aleph style prompt from the commercial brief + brand kit.
   * Director Agent A2.1 amendment: keep prompt simple — describe the
   * target LOOK, not the content (Aleph already knows what's in the source).
   */
  _buildStylePrompt(story, brandKit) {
    const brief = story?.commercial_brief || {};
    const visualSignature = brief.visual_signature || '';
    const visualStyleBrief = brief.visual_style_brief || '';
    const palette = (brandKit?.color_palette && Array.isArray(brandKit.color_palette))
      ? brandKit.color_palette.slice(0, 3).join(', ')
      : '';

    const parts = [];
    if (visualSignature) parts.push(visualSignature);
    if (visualStyleBrief && visualStyleBrief !== visualSignature) parts.push(visualStyleBrief);
    if (palette) parts.push(`Brand palette: ${palette}.`);

    // Fallback when brief is sparse — use a generic prestige-look prompt.
    if (parts.length === 0) {
      parts.push('Cinematic film-stock look, refined color grade, prestige commercial finish.');
    }

    // Aleph A2.1 prompt discipline: describe the TARGET LOOK, not the source.
    parts.push('Preserve identity, motion, and composition. Apply the look as a unified grade.');
    return parts.join(' ').slice(0, 480); // keep prompt budget tight
  }
}

export default AlephEnhancementOrchestrator;
export { AlephEnhancementOrchestrator, IDENTITY_GATE_PASS_THRESHOLD };
