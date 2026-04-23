// services/v4/PostProduction.js
// V4 post-production pipeline.
//
// Runs AFTER all beats are generated. Takes the beat video URLs, the episode
// context (LUT, music bed, title/end cards, subtitles) and produces the final
// polished episode video.
//
// Pipeline stages (in order):
//   1. Per-beat color correction  (2-pass grade stage 1 — per-model neutralize)
//   2. Scene-aware beat assembly   (tight cuts within scenes, xfade/fade/speed ramp between scenes)
//   3. Unified creative LUT pass   (2-pass grade stage 2 — brand LUT)
//   4. Music bed mix               (ducked under dialogue beats via volume expressions)
//   5. Title + end card overlays   (episode-level, sharp→PNG→ffmpeg overlay)
//   6. Subtitle burn-in            (per-beat dialogue segmented by scene-graph timing)
//
// Each stage has a graceful fallback — a missing LUT file, a failed music
// generation, a broken transition filter — none of them kill the episode.

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import winston from 'winston';

import { getLutFilePath, getCorrectionLutForModel } from './BrandKitLutMatcher.js';
import soundEffectsService, { SoundEffectsService } from '../SoundEffectsService.js';

// Scene-level ambient bed volume. -18dB ≈ 0.126 linear gain. The bed is a
// CONTINUOUS background layer (room tone / atmosphere) that plays under
// every beat in a scene, masking cuts and establishing location acoustics.
// Mixed under both native beat audio AND per-beat foreground SFX. Kept
// low enough to not compete with dialogue but present enough to give
// the episode a Hollywood-grade unified sonic backdrop.
const SCENE_AMBIENT_BED_DB = -18;
const SCENE_AMBIENT_BED_LINEAR = Math.pow(10, SCENE_AMBIENT_BED_DB / 20); // ≈ 0.126

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `[V4PostProduction] ${timestamp} [${level}]: ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1920;
const OUTPUT_FPS = 30;

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function tmpPath(ext) {
  return path.join(os.tmpdir(), `v4-${crypto.randomBytes(4).toString('hex')}.${ext}`);
}

function writeBuffer(buffer, ext) {
  const p = tmpPath(ext);
  fs.writeFileSync(p, buffer);
  return p;
}

function cleanup(paths) {
  for (const p of paths) {
    try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }
}

/**
 * Normalize a video to the V4 canonical format (1080x1920, 30fps, H.264).
 * Every beat is re-encoded to this format before assembly so concat works
 * cleanly across mixed-model sources.
 */
function normalizeVideo(inputPath, outputPath, options = {}) {
  const { applyCorrectionLut = null, nativeAudioGain = 1.0 } = options;

  const vfChain = [`scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease`, `pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black`, `setsar=1`, `fps=${OUTPUT_FPS}`];
  if (applyCorrectionLut) {
    vfChain.push(`lut3d='${applyCorrectionLut}'`);
  }

  // Force EXACT constant frame rate on the output. The fps=${OUTPUT_FPS}
  // filter alone isn't enough — some beats (particularly Sync Lipsync v3
  // outputs) can still carry a 30000/1001 (29.97fps) tbr through to the
  // normalized mp4 even after filtering. xfade then refuses to splice
  // a 30/1 scene into a 30000/1001 scene with:
  //   "First input link main frame rate (30/1) do not match the
  //    corresponding second input link xfade frame rate (30000/1001)"
  //
  // Belt-and-braces: fps filter (forces frames) + -fps_mode cfr (forces
  // constant cadence) + -r 30 (forces output rate) + explicit
  // -video_track_timescale so the container tbr is also locked to 15360
  // (a clean multiple of 30). All three layers together are what finally
  // produces bit-stable frame rate metadata across mixed-model beats.
  const args = [
    '-y',
    '-i', inputPath,
    '-vf', vfChain.join(','),
    '-fps_mode', 'cfr',
    '-r', String(OUTPUT_FPS),
    '-video_track_timescale', '15360',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-pix_fmt', 'yuv420p'
  ];

  // Native audio gain control. Default 1.0 (pass-through for clean Veo audio).
  // For Kling/OmniHuman beats, callers pass nativeAudioGain = 0.2 to duck the
  // inconsistent native audio so it doesn't fight the scene-level ambient bed
  // we layer on later. Without this ducking, Kling's random birds/impacts/
  // tones compete with the carefully-designed sonic backdrop and break
  // episode coherence.
  if (nativeAudioGain !== 1.0) {
    args.push('-af', `volume=${nativeAudioGain.toFixed(3)}`);
  }

  args.push(
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',
    outputPath
  );

  execFileSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

/**
 * Decide the native-audio gain for a beat based on its model.
 *   - Veo beats: 1.0 — Veo's native ambient is cinematic quality, keep full
 *   - Kling / OmniHuman / Mode B beats: 0.2 — their native audio is erratic
 *     (random birds, odd impacts, inconsistent tones). We duck it to ~20%
 *     so the scene-level ambient bed we layer next can breathe. Mode B
 *     beats still carry Sync Lipsync v3's voice track which this ducks too
 *     — but that's fine because the TTS audio was mixed in at Sync stage
 *     already loud and clear; 20% of it is still very audible.
 *
 *   Actually: Mode B beats MUST keep voice audible. For safety we bump
 *   Mode B to 0.6 (voice is the foreground, we still duck Kling native
 *   ambient a bit but not aggressively).
 */
function resolveNativeAudioGain(modelUsed) {
  if (!modelUsed) return 1.0;
  const m = modelUsed.toLowerCase();
  if (m.includes('veo')) return 1.0;
  if (m.includes('mode-b') || m.includes('sync-lipsync')) return 0.6; // keep dialogue audible
  if (m.includes('kling') || m.includes('omnihuman')) return 0.2;     // duck hard — it's noise
  return 1.0;
}

/**
 * Concat a list of pre-normalized mp4s using ffmpeg's concat demuxer.
 * Used within a single scene (tight cuts, no transitions).
 */
/**
 * Assemble scene paths via ffmpeg's concat filter with re-encode. Every
 * scene boundary is a hard video cut, but audio is acrossfaded (0.5s) so
 * the ambient bed transitions smoothly. This is the primary assembly path
 * (2026-04-23 onward) — replaces the xfade chain that had an intractable
 * truncation bug.
 *
 * The concat filter:
 *   [0:v][0:a][1:v][1:a]...concat=n=N:v=1:a=1[vraw][araw]
 * produces a single video+audio stream where every input plays in full.
 * We then apply an acrossfade pass for audio continuity at scene borders.
 *
 * For acrossfade on the concatenated audio: the concat filter has already
 * produced a single audio track. We can't retroactively crossfade within a
 * single stream via a simple filter. Instead, we achieve the "smooth bed
 * transition" effect by running a separate audio pipeline that chains
 * acrossfade between each pair of scene audio tracks, mirroring the
 * original xfade behaviour.
 *
 * @param {Array<{path: string, transitionToNext?: string, durationSec?: number}>} scenes
 * @param {string} outputPath
 */
function _assembleScenesWithConcatFilter(scenes, outputPath) {
  logger.info(`assembly: concat filter path — ${scenes.length} scenes (hard video cuts, audio acrossfaded for bed continuity)`);

  // Pre-flight: probe each input for diagnostic logging (the per-input stream
  // probe was already introduced in the xfade path — kept here for continuity).
  for (let si = 0; si < scenes.length; si++) {
    const sd = probeStreamDurations(scenes[si].path);
    logger.info(`[concat input ${si}] container=${sd.container.toFixed(2)}s video=${sd.video.toFixed(2)}s audio=${sd.audio.toFixed(2)}s path=${scenes[si].path}`);
  }

  // Build input args
  const inputArgs = scenes.flatMap(s => ['-i', s.path]);

  // Build filter_complex:
  //   Video: plain concat (hard cuts)
  //   Audio: chain of acrossfade between each consecutive pair (bed continuity)
  const videoConcat = scenes.map((_, i) => `[${i}:v]`).join('') + `concat=n=${scenes.length}:v=1:a=0[vout]`;

  // Audio acrossfade chain: [0:a][1:a]acrossfade=d=0.5[a0];[a0][2:a]acrossfade=d=0.5[a1];...
  let audioChain = '';
  if (scenes.length === 1) {
    audioChain = `[0:a]anull[aout]`;
  } else {
    const parts = [];
    for (let i = 0; i < scenes.length - 1; i++) {
      const leftLabel = i === 0 ? `[0:a]` : `[a${i - 1}]`;
      const rightLabel = `[${i + 1}:a]`;
      const outLabel = i === scenes.length - 2 ? `[aout]` : `[a${i}]`;
      parts.push(`${leftLabel}${rightLabel}acrossfade=d=${TRANSITION_DURATION}${outLabel}`);
    }
    audioChain = parts.join(';');
  }

  const filterComplex = `${videoConcat};${audioChain}`;
  logger.info(`[concat] filter_complex: ${filterComplex}`);

  try {
    execFileSync('ffmpeg', [
      '-y',
      ...inputArgs,
      '-filter_complex', filterComplex,
      '-map', '[vout]',
      '-map', '[aout]',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-fps_mode', 'cfr',
      '-r', String(OUTPUT_FPS),
      '-c:a', 'aac',
      '-b:a', '192k',
      outputPath
    ], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'buffer' });

    const out = probeStreamDurations(outputPath);
    logger.info(`assembly: concat filter completed — output video=${out.video.toFixed(2)}s audio=${out.audio.toFixed(2)}s`);
  } catch (err) {
    const stderr = err.stderr
      ? (Buffer.isBuffer(err.stderr) ? err.stderr.toString('utf8') : String(err.stderr))
      : '';
    const stderrTail = stderr ? stderr.split('\n').filter(l => l.trim()).slice(-8).join(' | ') : '(no stderr captured)';
    logger.warn(`concat filter assembly failed: ${err.message}`);
    logger.warn(`  filter_complex was: ${filterComplex}`);
    logger.warn(`  ffmpeg stderr tail: ${stderrTail}`);
    logger.warn(`  → falling back to concat demuxer (last-resort; may fail if codec params differ)`);
    concatNormalizedVideos(scenes.map(s => s.path), outputPath);
  }
}

function concatNormalizedVideos(paths, outputPath) {
  if (paths.length === 0) throw new Error('concatNormalizedVideos: empty list');
  if (paths.length === 1) {
    fs.copyFileSync(paths[0], outputPath);
    return;
  }

  const listPath = tmpPath('txt');
  const listContent = paths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  fs.writeFileSync(listPath, listContent);

  try {
    execFileSync('ffmpeg', [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-c', 'copy',
      outputPath
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
  } finally {
    cleanup([listPath]);
  }
}

/**
 * Probe the duration of an mp4 via ffprobe. Returns seconds (float).
 */
function probeDurationSec(videoPath) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath
    ], { encoding: 'utf-8' });
    return parseFloat(out.trim()) || 0;
  } catch (err) {
    logger.warn(`probeDurationSec failed on ${videoPath}: ${err.message}`);
    return 0;
  }
}

/**
 * Probe a file's video-stream and audio-stream durations SEPARATELY.
 * The container's `format=duration` reports the LONGER of the two streams,
 * hiding any video/audio divergence. This helper exposes both so we can
 * diagnose when one stream is truncated while the other plays on.
 *
 * Caught 2026-04-23: stage-2 xfade produced a container of 27.16s, but the
 * video stream was 27.16s while the audio stream was ~17.57s. Downstream
 * `-shortest` in the music mix clamped the whole episode to 17.57s, dropping
 * 9.6s of content. Visible only with separate stream probes.
 *
 * @param {string} path
 * @returns {{video: number, audio: number, container: number}}
 */
function probeStreamDurations(path) {
  const _probe = (streamSelector) => {
    try {
      const out = execFileSync('ffprobe', [
        '-v', 'error',
        '-select_streams', streamSelector,
        '-show_entries', 'stream=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        path
      ], { encoding: 'utf-8' });
      return parseFloat(out.trim()) || 0;
    } catch {
      return 0;
    }
  };
  return {
    video: _probe('v:0'),
    audio: _probe('a:0'),
    container: probeDurationSec(path)
  };
}

// ─────────────────────────────────────────────────────────────────────
// Bridge-clip assembly helpers (the professional NLE pattern)
// ─────────────────────────────────────────────────────────────────────

const BRIDGE_TRANSITION_DURATION = 0.5;
const BRIDGE_XFADE_MAP = {
  dissolve: 'fade',
  fadeblack: 'fadeblack',
  cut: null,
  speed_ramp: 'smoothup'
};

/**
 * Assemble scenes using the bridge-clip pattern:
 *   segments = [body_0, (bridge_{0,1} if soft), body_1, (bridge_{1,2} if soft), body_2, ...]
 * then final-concat all segments via the concat filter (re-encode once).
 *
 * Every xfade is an independent 2-input filter on fully-materialized 0.5s
 * inputs — zero chaining, zero cumulative drift. This is what fixes the
 * intractable chained-xfade bug where filter_complex silently dropped
 * intermediate streams.
 */
function _assembleScenesWithBridgeClips(scenes, outputPath) {
  logger.info(`assembly: bridge-clip path — ${scenes.length} scenes (independent 2-input xfades per boundary)`);

  // Probe every input up-front so the rest of the function works from a
  // single authoritative duration table. Always prefer video-stream
  // duration over container duration (container = max(video, audio) and
  // audio typically runs 0.03-0.05s longer than video after per-beat AAC
  // re-encoding — feeding that inflated value into xfade math was the
  // original chained-xfade bug's root trigger).
  const sceneInfo = scenes.map((s, i) => {
    const sd = probeStreamDurations(s.path);
    const dur = sd.video > 0 ? sd.video : sd.container;
    const transition = s.transitionToNext || 'cut';
    const xfadeName = BRIDGE_XFADE_MAP[transition] || null;
    logger.info(
      `[bridge input ${i}] container=${sd.container.toFixed(2)}s ` +
      `video=${sd.video.toFixed(2)}s audio=${sd.audio.toFixed(2)}s ` +
      `transition→next=${transition}`
    );
    return {
      path: s.path,
      videoDurationSec: dur,
      transition,
      xfadeName,
      isSoft: xfadeName !== null
    };
  });

  const d = BRIDGE_TRANSITION_DURATION;
  const tempSegments = [];
  const timelineSegments = []; // [{ path, kind, sceneIndex? }]

  try {
    for (let i = 0; i < sceneInfo.length; i++) {
      const scene = sceneInfo[i];
      const hasIncomingSoft = i > 0 && sceneInfo[i - 1].isSoft;
      const hasOutgoingSoft = i < sceneInfo.length - 1 && scene.isSoft;

      // ── Body segment: scene with transition-overlap regions removed ──
      const bodyStart = hasIncomingSoft ? d : 0;
      const bodyEnd = hasOutgoingSoft ? scene.videoDurationSec - d : scene.videoDurationSec;
      const bodyDur = bodyEnd - bodyStart;

      if (bodyDur <= 0.05) {
        throw new Error(
          `scene ${i} too short for bridge transitions: ` +
          `videoDur=${scene.videoDurationSec.toFixed(2)}s, ` +
          `incomingSoft=${hasIncomingSoft}, outgoingSoft=${hasOutgoingSoft}, ` +
          `resulting bodyDur=${bodyDur.toFixed(3)}s`
        );
      }

      let bodyPath;
      const needsTrim = bodyStart > 0.001 || Math.abs(bodyEnd - scene.videoDurationSec) > 0.001;
      if (!needsTrim) {
        // Whole scene — still re-encode through _extractSceneSegment so
        // every timeline segment has identical codec params (crucial for
        // a clean final concat).
        bodyPath = tmpPath('mp4');
        tempSegments.push(bodyPath);
        _extractSceneSegment(scene.path, 0, scene.videoDurationSec, bodyPath);
      } else {
        bodyPath = tmpPath('mp4');
        tempSegments.push(bodyPath);
        _extractSceneSegment(scene.path, bodyStart, bodyDur, bodyPath);
      }
      const bodyProbe = probeStreamDurations(bodyPath);
      logger.info(
        `[bridge body ${i}] slice=[${bodyStart.toFixed(2)}..${bodyEnd.toFixed(2)}]s ` +
        `→ video=${bodyProbe.video.toFixed(2)}s audio=${bodyProbe.audio.toFixed(2)}s`
      );
      timelineSegments.push({ path: bodyPath, kind: 'body', sceneIndex: i });

      // ── Bridge clip: xfade of this scene's tail + next scene's head ──
      if (hasOutgoingSoft) {
        const next = sceneInfo[i + 1];
        const tailStart = Math.max(0, scene.videoDurationSec - d);
        const tailPath = tmpPath('mp4');
        const headPath = tmpPath('mp4');
        const bridgePath = tmpPath('mp4');
        tempSegments.push(tailPath, headPath, bridgePath);

        try {
          _extractSceneSegment(scene.path, tailStart, d, tailPath);
          _extractSceneSegment(next.path, 0, d, headPath);
          _renderBridgeClip(tailPath, headPath, scene.xfadeName, d, bridgePath);
          const bp = probeStreamDurations(bridgePath);
          logger.info(
            `[bridge ${i}→${i + 1}] ${scene.transition} (${scene.xfadeName}) ` +
            `→ video=${bp.video.toFixed(3)}s audio=${bp.audio.toFixed(3)}s`
          );
          timelineSegments.push({ path: bridgePath, kind: 'bridge', sceneIndex: i });
        } catch (bridgeErr) {
          // A single bridge failing is recoverable: we already have both
          // scene bodies trimmed INCLUDING their transition regions being
          // removed. So we need to re-extract the bodies to include the
          // regions we had planned to give to the bridge. Simpler: extend
          // this scene's body to include the tail we tried to extract.
          // Cleanest recovery here is to throw, letting the outer caller
          // fall back to the concat-filter path for the whole episode.
          throw new Error(
            `bridge ${i}→${i + 1} (${scene.transition}) render failed: ${bridgeErr.message}`
          );
        }
      }
    }

    // Final concat of all timeline segments. Use the concat filter (not
    // demuxer) since segments have gone through multiple re-encode paths
    // and we want one authoritative re-encode at the end to smooth out
    // any AAC-frame-boundary seams.
    _concatTimelineSegments(timelineSegments.map(s => s.path), outputPath);

    const out = probeStreamDurations(outputPath);
    const expectedVideoDur = sceneInfo.reduce((sum, s) => sum + s.videoDurationSec, 0)
      - (sceneInfo.filter((s, i) => s.isSoft && i < sceneInfo.length - 1).length * d);
    logger.info(
      `assembly: bridge-clip path completed — video=${out.video.toFixed(2)}s audio=${out.audio.toFixed(2)}s ` +
      `(expected ≈ ${expectedVideoDur.toFixed(2)}s)`
    );
    if (out.video > 0 && Math.abs(out.video - expectedVideoDur) > 0.5) {
      logger.warn(
        `bridge-clip output video duration ${out.video.toFixed(2)}s diverges from expected ` +
        `${expectedVideoDur.toFixed(2)}s by > 0.5s — investigate`
      );
    }
    // The final output has been copied from the last segment's concat
    // target; the individual segments can be cleaned up now.
    cleanup(tempSegments);
  } catch (err) {
    // Clean up on failure too so we don't leak temp files into /tmp.
    cleanup(tempSegments);
    throw err;
  }
}

/**
 * Concat N pre-materialized mp4 segments via the concat FILTER (not the
 * demuxer). The filter re-encodes but is tolerant of any residual codec
 * parameter drift between segments. For a full-episode assembly this is
 * one ~few-second ffmpeg invocation — acceptable overhead for the
 * reliability benefit.
 */
function _concatTimelineSegments(segmentPaths, outputPath) {
  if (segmentPaths.length === 0) throw new Error('_concatTimelineSegments: empty list');
  if (segmentPaths.length === 1) {
    fs.copyFileSync(segmentPaths[0], outputPath);
    return;
  }

  const inputArgs = segmentPaths.flatMap(p => ['-i', p]);
  const vParts = segmentPaths.map((_, i) => `[${i}:v]`).join('');
  const aParts = segmentPaths.map((_, i) => `[${i}:a]`).join('');
  const filterComplex =
    `${vParts}concat=n=${segmentPaths.length}:v=1:a=0[vout];` +
    `${aParts}concat=n=${segmentPaths.length}:v=0:a=1[aout]`;

  execFileSync('ffmpeg', [
    '-y',
    ...inputArgs,
    '-filter_complex', filterComplex,
    '-map', '[vout]',
    '-map', '[aout]',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-fps_mode', 'cfr',
    '-r', String(OUTPUT_FPS),
    '-video_track_timescale', '15360',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '44100',
    '-ac', '2',
    outputPath
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
}

/**
 * Extract a sub-clip of a normalized scene at [startSec, startSec+durationSec].
 * Output re-encoded to the canonical V4 format so every segment produced by
 * the bridge-clip pipeline has identical codec parameters (essential for a
 * clean concat at the end). Used to materialize the per-scene head/tail
 * buffers that feed into `_renderBridgeClip`.
 */
function _extractSceneSegment(inputPath, startSec, durationSec, outputPath) {
  execFileSync('ffmpeg', [
    '-y',
    '-ss', startSec.toFixed(6),
    '-i', inputPath,
    '-t', durationSec.toFixed(6),
    '-vf', `fps=${OUTPUT_FPS},setsar=1`,
    '-fps_mode', 'cfr',
    '-r', String(OUTPUT_FPS),
    '-video_track_timescale', '15360',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '44100',
    '-ac', '2',
    '-avoid_negative_ts', 'make_zero',
    outputPath
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
}

/**
 * Render a stand-alone transition "bridge" clip: a single 2-input xfade of
 * tailClip + headClip, both of which are exactly `durationSec` long. Because
 * every input is fully materialized on disk with matched durations and
 * codec params, the xfade has zero ambiguity — `offset=0, duration=full`.
 * This is the crucial difference from the legacy chained filter_complex
 * approach, where intermediate filter-graph streams carried subtle timing
 * drift that accumulated into silent scene-drops.
 */
function _renderBridgeClip(tailClipPath, headClipPath, xfadeName, durationSec, outputPath) {
  // tpad stop_mode=clone guarantees at least a few tail frames exist even if
  // the extraction produced a clip marginally shorter than requested (can
  // happen when the source's audio-end slightly precedes the video-end).
  // The final -t clamps the output to exactly durationSec so no extra padding
  // leaks into the concat seam.
  const filterComplex =
    `[0:v]tpad=stop_mode=clone:stop_duration=0.1,fps=${OUTPUT_FPS}[av];` +
    `[1:v]tpad=stop_mode=clone:stop_duration=0.1,fps=${OUTPUT_FPS}[bv];` +
    `[av][bv]xfade=transition=${xfadeName}:duration=${durationSec.toFixed(5)}:offset=0[vout];` +
    `[0:a]apad[aa];[1:a]apad[ba];` +
    `[aa][ba]acrossfade=d=${durationSec.toFixed(5)}[aout]`;

  execFileSync('ffmpeg', [
    '-y',
    '-i', tailClipPath,
    '-i', headClipPath,
    '-filter_complex', filterComplex,
    '-map', '[vout]',
    '-map', '[aout]',
    '-t', durationSec.toFixed(6),
    '-fps_mode', 'cfr',
    '-r', String(OUTPUT_FPS),
    '-video_track_timescale', '15360',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '44100',
    '-ac', '2',
    outputPath
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
}

/**
 * Concat scenes with bridge-clip transitions (the professional pattern).
 *
 * Each soft transition is rendered as a STAND-ALONE xfade bridge of the
 * outgoing scene's tail and the incoming scene's head. Scene bodies are
 * trimmed to exclude the overlap regions consumed by the bridges. Final
 * assembly is a pure concat of `[body_0, bridge_01?, body_1, bridge_12?, ...]`.
 *
 * Why this works where chained xfade failed:
 *   - Chained xfade in filter_complex relies on intermediate streams
 *     ([v0], [v1], ...) whose actual timing drifts subtly from the
 *     mathematically-predicted value. At tight boundaries (offset +
 *     duration ≈ inputA.duration), the next xfade in the chain reads
 *     [v_{i-1}] as slightly shorter than expected, silently drops it,
 *     and outputs only the incoming scene. Caught in production
 *     2026-04-22 → 2026-04-23 across three rounds of frame-math fixes.
 *   - Bridge clips are 2-input xfades on fully-materialized 0.5s inputs
 *     with matched durations — offset=0, duration=full — leaving zero
 *     room for drift. Every xfade is atomic and independently verifiable
 *     by probing the resulting bridge.mp4 on disk.
 *   - Scene bodies are trimmed to the non-overlap region, so the final
 *     concat is seam-perfect: body_0 ends exactly where bridge_01 begins,
 *     bridge_01 ends exactly where body_1 begins.
 *
 * This is the pattern used by professional NLEs (Premiere, Resolve, FCP)
 * for render-on-export: each transition is its own clip, and the timeline
 * is assembled via simple concatenation.
 *
 * Trade-off vs chained xfade: 2(N-1)+1 extra ffmpeg invocations, but each
 * operates on trivially-short clips (~0.5s inputs for bridges, scene-size
 * inputs for bodies). Total wall-time impact: a few seconds per episode.
 *
 * Fallbacks:
 *   - Any single bridge failure → hard cut at that boundary only; other
 *     transitions still rendered.
 *   - Complete bridge path failure → `_assembleScenesWithConcatFilter`
 *     (the all-hard-cut path).
 *
 * @param {Array<{path: string, transitionToNext?: string, durationSec?: number}>} scenes
 * @param {string} outputPath
 */
function assembleScenesWithTransitions(scenes, outputPath) {
  if (scenes.length === 0) throw new Error('assembleScenesWithTransitions: empty scenes');
  if (scenes.length === 1) {
    fs.copyFileSync(scenes[0].path, outputPath);
    return;
  }

  // Escape hatches (env-controlled):
  //   BRAND_STORY_ASSEMBLY_MODE=concat  → skip bridges, hard-cut everything
  //   BRAND_STORY_ASSEMBLY_MODE=legacy  → use the old chained filter_complex
  //     (kept only for debugging/reproducing the known xfade chaining bug)
  //   (unset or any other)              → default bridge-clip path
  const assemblyMode = String(process.env.BRAND_STORY_ASSEMBLY_MODE || '').toLowerCase();

  if (assemblyMode === 'concat') {
    logger.info(`assembly: forced concat-filter mode via BRAND_STORY_ASSEMBLY_MODE=concat`);
    _assembleScenesWithConcatFilter(scenes, outputPath);
    return;
  }

  if (assemblyMode !== 'legacy') {
    try {
      _assembleScenesWithBridgeClips(scenes, outputPath);
      return;
    } catch (err) {
      logger.warn(`bridge-clip assembly failed: ${err.message} — falling back to concat-filter path`);
      _assembleScenesWithConcatFilter(scenes, outputPath);
      return;
    }
  }

  // ── LEGACY CHAINED-XFADE PATH ─────────────────────────────────
  // Retained for forensic reproduction of the 2026-04-22 → 2026-04-23
  // bug where chained xfade silently drops scenes. DO NOT default to
  // this path. Activated only via BRAND_STORY_ASSEMBLY_MODE=legacy.
  logger.warn(`assembly: LEGACY chained-xfade path enabled — known to silently drop scenes on certain inputs`);

  // xfade filter_complex path. Probe VIDEO STREAM durations (not container)
  // so offset math matches what ffmpeg's xfade actually sees.
  //
  // Container duration = max(video_stream, audio_stream). Our per-scene files
  // have audio ~0.03-0.05s longer than video (AAC encoder tail + amix buffering).
  // If we feed container duration into offset math, we over-estimate by 0.03-0.05s
  // per scene. That drift compounds across iterations and eventually pushes the
  // last transition's offset PAST the true video stream length — at which point
  // xfade silently drops the first input entirely and outputs only the second.
  //
  // Caught 2026-04-23: three-scene episode with containers [10.60, 21.56, 15.14]
  // but videos [10.57, 21.51, 15.09]. Iter-1 offset computed as 31.65s against
  // a [v0] whose true video stream was 31.58s — xfade dropped [v0] completely,
  // final video = 15.07s (scene 2 alone).
  //
  // Fix: use video-stream duration. Fallback to container if the stream probe
  // fails (rare — some containers don't report per-stream duration).
  for (const s of scenes) {
    if (s.durationSec == null || s.durationSec <= 0) {
      const streams = probeStreamDurations(s.path);
      s.durationSec = streams.video > 0 ? streams.video : streams.container;
    }
  }

  const TRANSITION_DURATION = 0.5; // 0.5s xfade

  // Map scene-graph transition → xfade transition name
  const xfadeMap = {
    dissolve: 'fade',
    fadeblack: 'fadeblack',
    cut: null,
    speed_ramp: 'smoothup'  // approximate; real ramp logic is Phase 2
  };

  // Build -i args
  const inputArgs = [];
  for (const s of scenes) {
    inputArgs.push('-i', s.path);
  }

  // Build a chain of xfade filters: [0:v][1:v] → [v01], [v01][2:v] → [v02], ...
  // Audio gets acrossfade'd in parallel.
  //
  // FRAME-INTEGER INVARIANT (the hard-earned lesson from 2026-04-23):
  //
  //   ffmpeg's xfade internally operates on INTEGER FRAME COUNTS, not floating
  //   seconds. For a 30fps output, every video length is quantised to a whole
  //   number of frames. This means:
  //
  //     xfade_output_frames = floor(input_a.frames) + floor(input_b.frames)
  //                         - round(xfade_duration * fps)
  //
  //   A 10.573s scene @ 30fps reports duration=10.573s but ffmpeg treats it
  //   as floor(10.573*30) = 317 frames = 10.5667s. Over two scenes that
  //   quantisation is ~0.02s. Over three it's ~0.03s. A 0.01s cut transition
  //   has NO ROOM for this drift — offset + 0.01s falls outside the real
  //   (frame-quantised) [v0] length and ffmpeg silently drops [v0] entirely,
  //   outputting only scene 2. Final episode = ~15s instead of ~46s.
  //
  //   Fix: compute everything in INTEGER FRAMES at the pipeline's output fps,
  //   not floating seconds. Match ffmpeg's internal arithmetic exactly.
  //
  //   Secondary guard: for cut transitions (which use the smallest xfade
  //   duration of 1 frame), also clamp offset to `[v_{i-1}].frames - xfade_frames`
  //   as a hard belt-and-braces against any residual off-by-one.
  //
  // Audio stays at acrossfade(TRANSITION_DURATION) universally because the
  // ambient bed is what carries scene-to-scene continuity — video can cut
  // hard but audio should always smooth.
  const videoChain = [];
  const audioChain = [];

  // Convert each scene's seconds-duration to frame count (floor, matching
  // ffmpeg's internal behaviour). This is the FACTUAL length xfade sees.
  const sceneFrameCounts = scenes.map(s => Math.floor(s.durationSec * OUTPUT_FPS));

  // Cut = 1 frame transition (effectively instant, visually indistinguishable
  // from a hard cut at 30fps). Dissolve/fadeblack/speed_ramp = TRANSITION_DURATION.
  // Expressed in frames to keep math in a single integer domain.
  const TRANSITION_FRAMES = Math.round(TRANSITION_DURATION * OUTPUT_FPS); // 15 frames @ 30fps
  const CUT_FRAMES = 1; // one frame — smallest valid xfade duration

  let cumulativeFrames = 0;

  for (let i = 0; i < scenes.length - 1; i++) {
    const leftLabel = i === 0 ? `[0:v]` : `[v${i - 1}]`;
    const rightLabel = `[${i + 1}:v]`;
    const outLabel = `[v${i}]`;
    const transition = scenes[i].transitionToNext || 'cut';
    const xfadeName = xfadeMap[transition];

    const transitionFrames = xfadeName ? TRANSITION_FRAMES : CUT_FRAMES;
    const xfadeFilterName = xfadeName || 'fade';
    const xfadeDurationSec = transitionFrames / OUTPUT_FPS;

    // Grow the cumulative frame counter to represent [v_{i-1}].frames:
    //   iter 0: cumFrames += scenes[0].frames (the first raw input)
    //   iter i>0: cumFrames += scenes[i].frames (the next input grows [v])
    cumulativeFrames += sceneFrameCounts[i];

    // offset_frames = position where xfade begins, relative to first input.
    // Must satisfy: offset_frames + transitionFrames <= input_a.frames.
    // cumulativeFrames currently equals input_a.frames (the growing [v]).
    const offsetFrames = Math.max(0, cumulativeFrames - transitionFrames);
    const offsetSec = offsetFrames / OUTPUT_FPS;

    videoChain.push(
      `${leftLabel}${rightLabel}xfade=transition=${xfadeFilterName}:duration=${xfadeDurationSec.toFixed(5)}:offset=${offsetSec.toFixed(5)}${outLabel}`
    );

    const leftAudioLabel = i === 0 ? `[0:a]` : `[a${i - 1}]`;
    const rightAudioLabel = `[${i + 1}:a]`;
    const audioOutLabel = `[a${i}]`;
    audioChain.push(`${leftAudioLabel}${rightAudioLabel}acrossfade=d=${TRANSITION_DURATION}${audioOutLabel}`);

    // After xfade, [v_i].frames = input_a.frames + input_b.frames - transitionFrames.
    // Our cumulativeFrames already includes input_a (added at the top of this
    // iteration). The NEXT iteration will add the next input's frames. So we
    // subtract transitionFrames to match the xfade output.
    cumulativeFrames -= transitionFrames;
  }

  const lastVideoLabel = `[v${scenes.length - 2}]`;
  const lastAudioLabel = `[a${scenes.length - 2}]`;
  const filterComplex = [...videoChain, ...audioChain].join(';');

  try {
    // Probe every input to ensure we know the true per-scene audio+video
    // durations GOING INTO xfade. If an input's audio is shorter than its
    // video (or vice versa), the xfade/acrossfade chain will compound the
    // divergence across iterations — surfacing the problem here saves hours
    // of downstream debugging.
    for (let si = 0; si < scenes.length; si++) {
      const sd = probeStreamDurations(scenes[si].path);
      logger.info(`[xfade input ${si}] container=${sd.container.toFixed(2)}s video=${sd.video.toFixed(2)}s audio=${sd.audio.toFixed(2)}s path=${scenes[si].path}`);
      if (Math.abs(sd.video - sd.audio) > 0.5) {
        logger.warn(`[xfade input ${si}] ⚠ video/audio divergence of ${Math.abs(sd.video - sd.audio).toFixed(2)}s — xfade+acrossfade chain will misalign downstream`);
      }
    }
    logger.info(`[xfade] filter_complex: ${filterComplex}`);

    // Capture stderr explicitly so a failure surfaces ffmpeg's actual
    // diagnostic (e.g. "offset must be less than input duration") instead
    // of the opaque "Command failed" message from execFileSync.
    // Caught 2026-04-22: a silent xfade failure fell through to the
    // straight-concat fallback, losing dissolve/fadeblack transitions
    // without the operator knowing why. Now we log the ffmpeg stderr.
    execFileSync('ffmpeg', [
      '-y',
      ...inputArgs,
      '-filter_complex', filterComplex,
      '-map', lastVideoLabel,
      '-map', lastAudioLabel,
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      outputPath
    ], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'buffer' });
    logger.info(`assembly: xfade chain applied (${scenes.length - 1} transition(s))`);
  } catch (err) {
    // Silent fallback: xfade filter failed → straight concat without transitions.
    // Log clearly so the user knows transitions were skipped, AND dump ffmpeg
    // stderr so the actual filter-chain error is visible for debugging.
    const stderr = err.stderr
      ? (Buffer.isBuffer(err.stderr) ? err.stderr.toString('utf8') : String(err.stderr))
      : '';
    const stderrTail = stderr ? stderr.split('\n').filter(l => l.trim()).slice(-8).join(' | ') : '(no stderr captured)';
    logger.warn(`xfade assembly failed: ${err.message}`);
    logger.warn(`  filter_complex was: ${filterComplex}`);
    logger.warn(`  ffmpeg stderr tail: ${stderrTail}`);
    logger.warn(`  → falling back to straight concat (dissolve/fadeblack/speed_ramp transitions SKIPPED)`);
    concatNormalizedVideos(scenes.map(s => s.path), outputPath);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Stage 1 — Per-beat color correction (stage 1 of 2-pass grade)
// ─────────────────────────────────────────────────────────────────────

/**
 * Normalize + optionally apply per-model correction LUT to every beat video.
 * Returns an array of normalized mp4 paths in beat order.
 */
function correctAndNormalizeBeats(beatVideoPaths, beatMetadata) {
  const normalizedPaths = [];

  for (let i = 0; i < beatVideoPaths.length; i++) {
    const inputPath = beatVideoPaths[i];
    const modelUsed = beatMetadata[i]?.model_used || '';
    const correctionLut = getCorrectionLutForModel(modelUsed);
    const nativeAudioGain = resolveNativeAudioGain(modelUsed);

    const outputPath = tmpPath('mp4');
    try {
      normalizeVideo(inputPath, outputPath, {
        applyCorrectionLut: correctionLut,
        nativeAudioGain
      });
      normalizedPaths.push(outputPath);
      const gainSuffix = nativeAudioGain !== 1.0
        ? `, native audio ducked to ${Math.round(nativeAudioGain * 100)}%`
        : '';
      if (correctionLut) {
        logger.info(`beat ${i} normalized + corrected (${modelUsed}${gainSuffix})`);
      } else {
        logger.info(`beat ${i} normalized (no correction LUT for ${modelUsed}${gainSuffix})`);
      }
    } catch (err) {
      // If correction fails, retry without the LUT
      logger.warn(`beat ${i} correction failed: ${err.message} — retrying without LUT`);
      try {
        normalizeVideo(inputPath, outputPath, { nativeAudioGain });
        normalizedPaths.push(outputPath);
      } catch (retryErr) {
        logger.error(`beat ${i} normalization failed completely: ${retryErr.message}`);
        throw retryErr;
      }
    }
  }

  return normalizedPaths;
}

// ─────────────────────────────────────────────────────────────────────
// Phase 2 — Per-beat SFX overlay (Kling/OmniHuman beats only)
// ─────────────────────────────────────────────────────────────────────

/**
 * For each beat that needs an ambient SFX overlay (Kling/OmniHuman), generate
 * an SFX clip via ElevenLabs and ffmpeg-mix it into the beat's existing audio
 * at ~-22dB. Veo beats are skipped because Veo's native ambient audio is
 * already strong.
 *
 * Mutates the beatPaths array in place: replaces a beat's path with a new
 * path containing the mixed audio. The original normalized file is cleaned up.
 *
 * Skips entirely if SoundEffectsService isn't available (no ElevenLabs key).
 *
 * @param {string[]} beatPaths - paths from correctAndNormalizeBeats
 * @param {Object[]} beatMetadata - beat objects with model_used + ambient_sound
 * @param {string[]} tempPaths - cleanup tracker (mutated)
 */
async function applyPerBeatSfxOverlays(beatPaths, beatMetadata, tempPaths) {
  if (!soundEffectsService.isAvailable()) {
    logger.info(`SFX service unavailable, skipping per-beat SFX overlays`);
    return;
  }

  for (let i = 0; i < beatPaths.length; i++) {
    const meta = beatMetadata[i];
    if (!meta) continue;

    const modelUsed = meta.model_used || '';
    if (!SoundEffectsService.needsSfxOverlay(modelUsed)) continue;

    const ambientPrompt = meta.ambient_sound;
    if (!ambientPrompt || ambientPrompt.trim().length === 0) continue;

    const beatDuration = meta.actual_duration_sec || meta.duration_seconds;
    if (!beatDuration || beatDuration <= 0) continue;

    let sfxResult;
    try {
      sfxResult = await soundEffectsService.generate({
        prompt: ambientPrompt,
        durationSec: Math.min(beatDuration, 22),
        promptInfluence: 0.45
      });
    } catch (err) {
      logger.warn(`SFX gen failed for beat ${meta.beat_id}: ${err.message} — skipping overlay`);
      continue;
    }

    // Write SFX MP3 → ffmpeg mix → replace the beat path
    const sfxPath = writeBuffer(sfxResult.audioBuffer, 'mp3');
    const mixedPath = tmpPath('mp4');
    tempPaths.push(sfxPath, mixedPath);

    try {
      // Per-beat FOREGROUND SFX mix settings.
      //
      // V4 audio layer stack (from top to bottom):
      //   1. Dialogue (Mode B TTS)        — 0dB, highest priority
      //   2. Per-beat foreground SFX      — -10dB (THIS LAYER)
      //   3. Native beat audio (Veo only) — ~0dB (Kling/Omni ducked to 20% in normalize)
      //   4. Scene-level ambient bed      — -18dB (continuous, applied post-assembly)
      //   5. Music bed                    — -18dB base, -24dB during dialogue
      //
      // Per-beat SFX = SPECIFIC foreground events (footstep, click, glass
      // clink). NOT the general room tone — that's the scene ambient bed.
      // At -10dB (≈32% volume) these events are clearly audible AS events
      // without overpowering dialogue (which is the top priority layer).
      //
      // ffmpeg gotchas (both fixed on 2026-04-21):
      //   - `amix` without `normalize=0` halves every input (N=2 → each
      //     input at 50%). Adding normalize=0 preserves original levels.
      //   - -22dB (original) was ~4% post-normalization = inaudible.
      //   - -14dB (first bump) was audible but didn't feel cinematic.
      //   - -10dB (current) gives a clear foreground-event layer that sits
      //     ON TOP of the ambient bed without fighting dialogue.
      const sfxVolume = Math.pow(10, -10 / 20).toFixed(3);
      // Add 150ms fade-in and fade-out on the SFX overlay so the ambient
      // foreground event eases in/out instead of popping hard at beat
      // boundaries. Without this, adjacent beats where one has SFX and
      // the next doesn't produce an abrupt "strong white cover noise then
      // mellow audio" transition (reported by operator 2026-04-23).
      //
      // Implementation: probe the beat's own duration to schedule the fade-out
      // correctly (can't use `st=end-d` syntax without knowing end time).
      // Fall back to a symmetric fade at the SFX clip boundaries if probe fails.
      const beatDurSec = probeDurationSec(beatPaths[i]);
      const SFX_FADE_SEC = 0.15;
      const fadeOutStart = Math.max(0, (beatDurSec || beatDuration || 4) - SFX_FADE_SEC);
      const filterComplex =
        `[1:a]volume=${sfxVolume},afade=t=in:d=${SFX_FADE_SEC}:st=0,afade=t=out:d=${SFX_FADE_SEC}:st=${fadeOutStart.toFixed(3)}[sfx];` +
        `[0:a][sfx]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`;

      execFileSync('ffmpeg', [
        '-y',
        '-i', beatPaths[i],
        '-i', sfxPath,
        '-filter_complex', filterComplex,
        '-map', '0:v',
        '-map', '[aout]',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-shortest',
        mixedPath
      ], { stdio: ['ignore', 'ignore', 'pipe'] });

      logger.info(`beat ${meta.beat_id} SFX overlay applied (${modelUsed})`);
      // Replace the path so downstream stages use the mixed beat
      beatPaths[i] = mixedPath;
    } catch (err) {
      logger.warn(`SFX mix failed for beat ${meta.beat_id}: ${err.message} — keeping original`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Stage 2.5 — Scene-level ambient bed (the Hollywood continuity layer)
// ─────────────────────────────────────────────────────────────────────

/**
 * Generate a scene-level ambient bed from Gemini's ambient_bed_prompt and
 * mix it under the scene's assembled video at -18dB. This is the layer
 * that transforms an episode from "a series of clips" into "a film" — a
 * single continuous room tone / atmosphere that masks beat cuts and
 * anchors the viewer to a consistent acoustic location.
 *
 * Implementation notes:
 * - ElevenLabs SFX V2 caps at 22s per clip, so we generate a ~22s loopable
 *   clip then use ffmpeg's stream_loop to extend to the scene's duration.
 * - Mixed with normalize=0 so the scene's existing audio (voice, foreground
 *   SFX, native ambient) is preserved at full volume.
 * - -18dB chosen so the bed is CLEARLY perceptible as "there's atmosphere
 *   here" without competing with dialogue or foreground events.
 *
 * @param {string} scenePath - path to the assembled scene mp4
 * @param {Object} scene - the scene object from the scene-graph
 * @param {string} outputPath - where to write the scene + bed mp4
 * @param {string[]} tempPaths - accumulator for cleanup
 * @returns {Promise<boolean>} true if bed was applied, false on skip/fail
 */
async function applySceneAmbientBed(scenePath, scene, outputPath, tempPaths) {
  const prompt = scene?.ambient_bed_prompt;
  if (!prompt || prompt.trim().length === 0) {
    logger.info(`scene ${scene?.scene_id || '?'}: no ambient_bed_prompt — skipping bed`);
    fs.copyFileSync(scenePath, outputPath);
    return false;
  }

  if (!soundEffectsService.isAvailable()) {
    logger.info(`scene ${scene?.scene_id || '?'}: SFX service unavailable — skipping bed`);
    fs.copyFileSync(scenePath, outputPath);
    return false;
  }

  const sceneDuration = probeDurationSec(scenePath);
  if (sceneDuration <= 0) {
    logger.warn(`scene ${scene?.scene_id || '?'}: probe failed, can't size ambient bed — skipping`);
    fs.copyFileSync(scenePath, outputPath);
    return false;
  }

  // Generate the bed. We request min(duration + 1s safety, 22s max from
  // ElevenLabs) — if the scene is longer than 22s we'll loop the bed via
  // ffmpeg stream_loop. The extra 1s prevents premature ending on fadeouts.
  const requestedBedSec = Math.min(sceneDuration + 1, 22);

  let bedResult;
  try {
    bedResult = await soundEffectsService.generate({
      prompt,
      durationSec: requestedBedSec,
      promptInfluence: 0.4
    });
  } catch (err) {
    logger.warn(`scene ${scene?.scene_id || '?'} ambient bed generation failed: ${err.message} — skipping`);
    fs.copyFileSync(scenePath, outputPath);
    return false;
  }

  const bedPath = writeBuffer(bedResult.audioBuffer, 'mp3');
  tempPaths.push(bedPath);

  // Mix bed under the scene. Loop the bed audio if the scene is longer
  // than the bed — `-stream_loop -1` on the audio input causes ffmpeg to
  // repeat it forever.
  //
  // DURATION PARITY CONTRACT (the hard lesson from 2026-04-23):
  //   The OUTPUT must have audio duration EXACTLY == video duration.
  //   If per-beat concat produced video=18.17s with audio=13.5s (possible
  //   when a Sync Lipsync beat's audio is slightly short), the old code
  //   used `amix duration=first` + `-shortest` — which trimmed the VIDEO
  //   down to the short audio length, propagating the divergence through
  //   the downstream xfade/acrossfade chain and ultimately dropping 19s
  //   of episode content. Fix:
  //     1. Pad the scene's existing audio with `apad` so it never runs
  //        short of the video.
  //     2. Use `duration=longest` in amix — the bed is stream-looped
  //        forever, so "longest" is bounded by the bed stream.
  //     3. Cap the OUTPUT to the video's exact duration with `-t`.
  //        `-shortest` is banned here — it's the whole source of bugs.
  //
  // The bed volume factor is pre-computed for -18dB. amix normalize=0
  // preserves the scene's existing audio at 100%.
  try {
    execFileSync('ffmpeg', [
      '-y',
      '-i', scenePath,
      '-stream_loop', '-1',
      '-i', bedPath,
      '-filter_complex',
        `[1:a]volume=${SCENE_AMBIENT_BED_LINEAR.toFixed(4)}[bed];` +
        `[0:a]apad[scene];` +
        `[scene][bed]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[aout]`,
      '-map', '0:v',
      '-map', '[aout]',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-t', sceneDuration.toFixed(3),
      outputPath
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    // Sanity-verify the output honoured the duration contract. If audio
    // and video diverge by >0.3s, log loudly — downstream xfade/acrossfade
    // will compound this into visible truncation.
    const outStreams = probeStreamDurations(outputPath);
    const streamDelta = Math.abs(outStreams.video - outStreams.audio);
    logger.info(
      `scene ${scene?.scene_id || '?'}: ambient bed applied — ` +
      `"${prompt.slice(0, 50)}..." at ${SCENE_AMBIENT_BED_DB}dB over ${sceneDuration.toFixed(1)}s ` +
      `(v=${outStreams.video.toFixed(2)}s, a=${outStreams.audio.toFixed(2)}s)`
    );
    if (streamDelta > 0.3) {
      logger.warn(
        `scene ${scene?.scene_id || '?'}: ⚠ video/audio divergence of ${streamDelta.toFixed(2)}s in bed-applied scene — ` +
        `downstream xfade/acrossfade will misalign. Source video was probably short on audio.`
      );
    }
    return true;
  } catch (err) {
    logger.warn(`scene ${scene?.scene_id || '?'} ambient bed mix failed: ${err.message} — keeping scene without bed`);
    fs.copyFileSync(scenePath, outputPath);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Stage 4 — Unified creative LUT pass (stage 2 of 2-pass grade)
// ─────────────────────────────────────────────────────────────────────

function applyCreativeLut(inputPath, outputPath, lutId) {
  const lutPath = getLutFilePath(lutId);
  if (!lutPath) {
    logger.warn(`creative LUT "${lutId}" not available on disk — skipping grade`);
    fs.copyFileSync(inputPath, outputPath);
    return;
  }

  try {
    execFileSync('ffmpeg', [
      '-y',
      '-i', inputPath,
      '-vf', `lut3d='${lutPath}'`,
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      outputPath
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    logger.info(`applied creative LUT ${lutId}`);
  } catch (err) {
    logger.warn(`creative LUT pass failed: ${err.message} — outputting ungraded`);
    fs.copyFileSync(inputPath, outputPath);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Stage 5 — Music bed mix
// ─────────────────────────────────────────────────────────────────────

/**
 * Flat music bed mix — music at a constant -18dB under the episode audio.
 * Kept as a fallback when beat-timing data isn't available.
 */
function mixMusicBed(inputPath, musicPath, outputPath, options = {}) {
  const { musicDb = -18 } = options;
  const musicVolume = Math.pow(10, musicDb / 20);

  try {
    // Same -shortest guard as the ducked mix (see mixMusicBedWithDucking):
    // if upstream audio ends short of the video, -shortest would chop the
    // entire output. Pad audio to the video's length and cap with -t instead.
    const videoDurationSec = probeDurationSec(inputPath);
    const filterComplex = `[1:a]volume=${musicVolume.toFixed(3)},apad[music];[0:a]apad[main];[main][music]amix=inputs=2:duration=longest:dropout_transition=2[aout]`;

    execFileSync('ffmpeg', [
      '-y',
      '-i', inputPath,
      '-i', musicPath,
      '-filter_complex', filterComplex,
      '-map', '0:v',
      '-map', '[aout]',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-t', videoDurationSec.toFixed(3),
      outputPath
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    logger.info(`mixed music bed flat at ${musicDb}dB — clamped to video duration ${videoDurationSec.toFixed(2)}s`);
  } catch (err) {
    logger.warn(`music mix failed: ${err.message} — outputting without music`);
    fs.copyFileSync(inputPath, outputPath);
  }
}

/**
 * Music bed mix with beat-aware dialogue ducking.
 *
 * Builds a time-varying volume expression for the music track so it ducks
 * down (-24dB) during beats that have dialogue and swells back to the normal
 * bed level (-18dB) during silent / b-roll / action beats. Smooth transitions
 * at the boundaries via a short ramp (~300ms).
 *
 * ffmpeg volume expression format:
 *   volume='if(between(t,2.0,6.0),0.06,0.126)':eval=frame
 *
 * ─ 0.126 ≈ -18dB (nominal bed)
 * ─ 0.06  ≈ -24dB (ducked under dialogue)
 * ─ between(t,start,end) → 1 during dialogue windows
 *
 * Nested `if(..., if(..., ...))` lets us cover multiple dialogue windows in
 * one expression. For N dialogue beats we build N nested ifs, falling through
 * to the nominal bed level.
 *
 * @param {string} inputPath
 * @param {string} musicPath
 * @param {string} outputPath
 * @param {Array} beatMetadata - ordered beats with dialogue + actual_duration_sec
 */
function mixMusicBedWithDucking(inputPath, musicPath, outputPath, beatMetadata) {
  // Walk beats to find the time windows where dialogue is playing.
  const duckedLevel = Math.pow(10, -24 / 20).toFixed(3); // -24dB ≈ 0.063
  const bedLevel = Math.pow(10, -18 / 20).toFixed(3);    // -18dB ≈ 0.126

  const dialogueWindows = [];
  let cursor = 0;
  for (const beat of beatMetadata) {
    const duration = beat.actual_duration_sec || beat.duration_seconds || 0;
    if (duration <= 0) continue;

    const hasDialogue = !!(
      beat.dialogue
      || (Array.isArray(beat.dialogues) && beat.dialogues.some(Boolean))
      || (Array.isArray(beat.exchanges) && beat.exchanges.some(e => e?.dialogue))
      || beat.voiceover_text
    );

    if (hasDialogue) {
      dialogueWindows.push({ start: cursor, end: cursor + duration });
    }
    cursor += duration;
  }

  if (dialogueWindows.length === 0) {
    logger.info(`no dialogue windows detected → flat music mix`);
    mixMusicBed(inputPath, musicPath, outputPath);
    return;
  }

  // Build nested if() expression: during any dialogue window → duckedLevel, else → bedLevel.
  // Use a 0.3s ease at each boundary so ducks feel natural instead of clicking.
  // We cheat the ease: duck with a slightly wider window to give the ramp-in + ramp-out room.
  const easeSec = 0.3;
  const duckExpr = dialogueWindows
    .map(w => `between(t,${(w.start - easeSec).toFixed(2)},${(w.end + easeSec).toFixed(2)})`)
    .join('+');

  // volume = bed - (bed - ducked) * clip(duckExpr, 0, 1)
  // Simplified: `if(${duckExpr}, ${duckedLevel}, ${bedLevel})`
  // We use the if() form because ffmpeg's between() returns 0/1, and summed
  // between()s > 0 means we're in at least one dialogue window.
  const volumeExpr = `if(gt(${duckExpr}\\,0)\\,${duckedLevel}\\,${bedLevel})`;

  try {
    // Probe the video duration so we can clamp the output audio to MATCH.
    // The previous implementation used `-shortest` which trimmed the output
    // to the shortest stream — if upstream xfade/acrossfade produced an audio
    // stream shorter than the video (e.g. because a scene's ambient-bed apply
    // emitted audio shorter than its video), `-shortest` chopped the entire
    // episode to the short-audio length. On 2026-04-23 this silently dropped
    // 9.6s of video during the music-mix stage. Caught by the duration trace:
    //   after stage 3: 27.16s   → after stage 4 (music mix): 17.57s
    //
    // Fix: explicitly cap the OUTPUT to the video stream's duration using `-t`
    // so an audio-short upstream cannot truncate the video. If audio ends
    // early, amix pads with silence under the ducked music bed — acceptable
    // (and far better than losing content).
    const videoDurationSec = probeDurationSec(inputPath);

    // Add apad on the mixed bus so audio padding is guaranteed past end of
    // the original audio stream. Without apad, amix stops producing samples
    // once both inputs end — but we pass duration=longest and let music fill
    // the tail. Belt-and-braces: -t caps the whole thing to the video length.
    const filterComplex = `[1:a]volume='${volumeExpr}':eval=frame,apad[music];[0:a]apad[main];[main][music]amix=inputs=2:duration=longest:dropout_transition=0[aout]`;

    execFileSync('ffmpeg', [
      '-y',
      '-i', inputPath,
      '-i', musicPath,
      '-filter_complex', filterComplex,
      '-map', '0:v',
      '-map', '[aout]',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-t', videoDurationSec.toFixed(3),
      outputPath
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    logger.info(`mixed music bed with dialogue ducking (${dialogueWindows.length} window${dialogueWindows.length > 1 ? 's' : ''}) — clamped to video duration ${videoDurationSec.toFixed(2)}s`);
  } catch (err) {
    logger.warn(`ducked music mix failed: ${err.message} — falling back to flat mix`);
    try {
      mixMusicBed(inputPath, musicPath, outputPath);
    } catch (fallbackErr) {
      logger.warn(`flat music mix also failed: ${fallbackErr.message} — outputting without music`);
      fs.copyFileSync(inputPath, outputPath);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Stage 6 — Title + end card overlays (episode-level)
// ─────────────────────────────────────────────────────────────────────

/**
 * Render a title/end card PNG using sharp + SVG.
 * Caller writes the PNG to disk and feeds it into an ffmpeg overlay filter.
 *
 * @param {Object} params
 * @param {string} params.line1 - main text (e.g. series title)
 * @param {string} [params.line2] - optional secondary text (e.g. episode title)
 * @param {string} [params.position='center'] - 'center' | 'bottom'
 * @param {string} [params.fill='#FFFFFF']
 * @param {number} [params.line1Size=84]
 * @param {number} [params.line2Size=48]
 * @param {string} [params.bg='black']  - 'black' | 'dark_scrim' | 'transparent'
 * @returns {Promise<Buffer>} PNG buffer
 */
async function renderCardPng({
  line1,
  line2 = '',
  position = 'center',
  fill = '#FFFFFF',
  line1Size = 84,
  line2Size = 48,
  bg = 'black'
}) {
  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch {
    throw new Error('renderCardPng requires the `sharp` package (already in dependencies via v3)');
  }

  const width = 1080;
  const height = 1920;

  let bgFill = '#000000';
  let bgOpacity = 1.0;
  if (bg === 'dark_scrim') bgOpacity = 0.75;
  if (bg === 'transparent') bgOpacity = 0.0;

  const centerY = position === 'bottom' ? height - 240 : height / 2;
  const line1Y = line2 ? centerY - line1Size / 2 - 10 : centerY;
  const line2Y = centerY + line2Size / 2 + 20;

  const esc = s => (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="${bgFill}" fill-opacity="${bgOpacity}"/>
    <text x="${width / 2}" y="${line1Y}" font-family="Helvetica, Arial, sans-serif" font-size="${line1Size}" font-weight="700" fill="${fill}" text-anchor="middle" dominant-baseline="middle">${esc(line1)}</text>
    ${line2 ? `<text x="${width / 2}" y="${line2Y}" font-family="Helvetica, Arial, sans-serif" font-size="${line2Size}" font-weight="400" fill="${fill}" text-anchor="middle" dominant-baseline="middle">${esc(line2)}</text>` : ''}
  </svg>`;

  return await sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Render a still PNG card as a short mp4 clip with silent audio, matching
 * the V4 canonical output format (1080×1920, 30fps, H.264+AAC). Used for
 * the title/end cards that are PREPENDED/APPENDED to the assembled episode.
 *
 * Replaces the old overlay-on-top approach that hid the first 3s of real
 * footage behind a title card. Caught on 2026-04-11 when the user reported
 * "can't see the first 2-3 seconds" of the scene opening.
 */
function renderCardClip(pngPath, durationSec, outputPath) {
  execFileSync('ffmpeg', [
    '-y',
    // --- input 0: looping still image ---
    '-loop', '1',
    '-t', String(durationSec),
    '-i', pngPath,
    // --- input 1: silent stereo audio bed ---
    '-f', 'lavfi',
    '-t', String(durationSec),
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    // --- output: force same canonical format as normalized beats ---
    '-vf', `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease,pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${OUTPUT_FPS}`,
    '-fps_mode', 'cfr',
    '-r', String(OUTPUT_FPS),
    '-video_track_timescale', '15360',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',
    '-shortest',
    outputPath
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
}

/**
 * Prepend a title card and append an end card to the episode instead of
 * overlaying them on top of the assembled footage. The old overlay approach
 * hid the first 3s of scene opening (the user's "can't see the first 2-3
 * seconds" complaint on 2026-04-11) and the last 2.5s of the climax/
 * cliffhanger under a full-screen PNG.
 *
 * New flow:
 *   title.mp4 (3s)  +  assembled_episode.mp4  +  end.mp4 (2.5s)  → outputPath
 *
 * Each card clip is re-encoded into the same canonical V4 format (1080×1920,
 * 30fps cfr, H.264+AAC, 15360 timescale) so the concat demuxer splices them
 * cleanly without re-encoding the main episode body.
 *
 * @param {Object} params
 * @param {string} params.inputPath
 * @param {string} params.outputPath
 * @param {string} params.seriesTitle
 * @param {string} params.episodeTitle
 * @param {string} [params.cliffhanger]
 * @param {number} params.videoDurationSec - (unused; kept for API compat)
 */
async function applyTitleAndEndCards({ inputPath, outputPath, seriesTitle, episodeTitle, cliffhanger, videoDurationSec }) {
  const titleCardSec = 3.0;
  const endCardSec = 2.5;

  let titlePngPath = null;
  let titleClipPath = null;
  let endPngPath = null;
  let endClipPath = null;
  const tempToClean = [];

  try {
    // ─── 1. Render title card PNG → 3s mp4 clip ───
    const titlePng = await renderCardPng({
      line1: seriesTitle || 'Untitled Series',
      line2: episodeTitle || '',
      position: 'center',
      bg: 'black'
    });
    titlePngPath = tmpPath('png');
    fs.writeFileSync(titlePngPath, titlePng);
    titleClipPath = tmpPath('mp4');
    renderCardClip(titlePngPath, titleCardSec, titleClipPath);
    tempToClean.push(titlePngPath, titleClipPath);

    // ─── 2. Optionally render end card PNG → 2.5s mp4 clip ───
    let hasEndCard = false;
    if (cliffhanger) {
      const endPng = await renderCardPng({
        line1: cliffhanger.length > 60 ? cliffhanger.slice(0, 57) + '…' : cliffhanger,
        line2: 'Next episode…',
        position: 'bottom',
        bg: 'dark_scrim',
        line1Size: 56,
        line2Size: 36
      });
      endPngPath = tmpPath('png');
      fs.writeFileSync(endPngPath, endPng);
      endClipPath = tmpPath('mp4');
      renderCardClip(endPngPath, endCardSec, endClipPath);
      tempToClean.push(endPngPath, endClipPath);
      hasEndCard = true;
    }

    // ─── 3. Concat with re-encode (filter_complex) ───
    // We INTENTIONALLY do NOT use the `-c copy` stream-copy concat demuxer here.
    // The fast path silently produces truncated / demuxer-broken mp4s when the
    // title/end card clips' codec params drift even slightly from the body:
    // different SPS/PPS, timebase, tbr, audio sample rate, or pixel format.
    // When that happens, ffmpeg returns success but the resulting file only
    // plays up to the first boundary; downstream players report a partial
    // duration (e.g. ~17s of a 44s episode).
    //
    // Caught 2026-04-21 on the first Action-genre V4 run: a 38.7s body +
    // 3s title + 2.5s end produced a 1.4MB file whose player reported 17s.
    // Root cause: stream-copy concat of mismatched codec params.
    //
    // The re-encode path costs ~2-5s extra per episode (one ffmpeg pass over
    // 40-120 seconds of content). Worth every millisecond — the only way to
    // guarantee the final file plays correctly across every player.
    const parts = [titleClipPath, inputPath];
    if (hasEndCard) parts.push(endClipPath);

    const inputs = parts.flatMap(p => ['-i', p]);
    const n = parts.length;
    // [0:v][0:a][1:v][1:a]...concat=n=N:v=1:a=1[vout][aout]
    const filterParts = [];
    for (let i = 0; i < n; i++) filterParts.push(`[${i}:v][${i}:a]`);
    const filterComplex = filterParts.join('') + `concat=n=${n}:v=1:a=1[vout][aout]`;

    execFileSync('ffmpeg', [
      '-y',
      ...inputs,
      '-filter_complex', filterComplex,
      '-map', '[vout]',
      '-map', '[aout]',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-fps_mode', 'cfr',
      '-r', String(OUTPUT_FPS),
      '-c:a', 'aac',
      '-b:a', '192k',
      outputPath
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    logger.info(`prepended title card (${titleCardSec}s)${hasEndCard ? ` + appended end card (${endCardSec}s)` : ''} via re-encode concat`);
  } catch (err) {
    logger.warn(`title/end card prepend/append failed: ${err.message} — copying input through`);
    fs.copyFileSync(inputPath, outputPath);
  } finally {
    cleanup(tempToClean);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Stage 7 — Subtitle burn-in (per-beat dialogue from the scene-graph)
// ─────────────────────────────────────────────────────────────────────

/**
 * Build an SRT file from the episode's beat metadata.
 * Each beat's dialogue becomes one subtitle cue aligned to its runtime window.
 *
 * @param {Array} beatMetadata - ordered beats with { dialogue?, actual_duration_sec, duration_seconds }
 * @returns {string} SRT content
 */
function buildSrtFromBeats(beatMetadata, timelineOffsetSec = 0) {
  // timelineOffsetSec is the absolute offset of the FIRST beat on the final
  // episode timeline. When a 3s title card is prepended in Stage 5, beat 0
  // doesn't start at t=0 — it starts at t=3. Passing the title-card duration
  // here shifts every cue forward so the subtitles align with the actual
  // audio positions post-concat.
  //
  // Caught 2026-04-21: subtitles burned at cue-zero-based timestamps landed
  // on the silent title card instead of the dialogue beats, making the
  // episode appear to have "no texts" even though 4 cues rendered.
  const cues = [];
  let cursorSec = Number.isFinite(timelineOffsetSec) ? timelineOffsetSec : 0;
  let cueIndex = 1;

  for (const beat of beatMetadata) {
    const duration = beat.actual_duration_sec || beat.duration_seconds || 0;
    const startSec = cursorSec;
    const endSec = cursorSec + duration;

    const dialogue = beat.dialogue
      || (Array.isArray(beat.dialogues) ? beat.dialogues.join(' ') : null)
      || (Array.isArray(beat.exchanges) ? beat.exchanges.map(e => e.dialogue).filter(Boolean).join(' ') : null)
      || beat.voiceover_text;

    if (dialogue) {
      cues.push(
        `${cueIndex}\n${_srtTimestamp(startSec)} --> ${_srtTimestamp(endSec)}\n${dialogue}\n`
      );
      cueIndex++;
    }

    cursorSec = endSec;
  }

  return cues.join('\n');
}

// Title card duration prepended by applyTitleAndEndCards() — kept as a
// constant here too so buildSrtFromBeats callers can pass it without reaching
// into that function. Single source of truth would be even better; for now,
// this mirror is intentional and guarded by a unit test.
const TITLE_CARD_SEC = 3.0;

function _srtTimestamp(sec) {
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = Math.floor(sec % 60);
  const ms = Math.floor((sec - Math.floor(sec)) * 1000);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/**
 * ASS timestamp format is `H:MM:SS.cc` (centiseconds, NOT ms). One-digit hours,
 * two-digit everything else, period instead of comma before centiseconds.
 */
function _assTimestamp(sec) {
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = Math.floor(sec % 60);
  const cs = Math.floor((sec - Math.floor(sec)) * 100);
  return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/**
 * Convert an SRT string into an ASS (Advanced SubStation Alpha) file body
 * with styling BAKED INTO THE [V4+ Styles] SECTION. This sidesteps the
 * ffmpeg `subtitles=...:force_style=...` command-line parsing nightmare
 * entirely — the `ass` filter accepts a path and reads everything from the
 * file including styling, so there's ZERO filter-graph escaping needed.
 *
 * Why this exists: ffmpeg 8.1's filter parser rejects both the quoted and
 * backslash-escaped force_style forms on the `subtitles` filter, yielding
 * "No option name near '...force_style=FontName=Helvetica,FontSize=22,...'"
 * even after escaping commas with `\,`. The root cause is that filterchain
 * level-2 unescape turns `\,` back into `,` BEFORE the option parser sees
 * the value, so the commas are indistinguishable from option separators at
 * parse time. The robust fix is to stop using force_style and stop using
 * the `subtitles` filter — use `ass` instead and put the styling in the
 * file where no command-line parser is involved.
 *
 * ASS colour format: &H + AABBGGRR (alpha inverted: 00 = opaque, FF = transparent).
 * Style fields reference: https://en.wikipedia.org/wiki/SubStation_Alpha#V4+_Styles
 */
function srtToAss(srtContent, { playResX = 1080, playResY = 1920 } = {}) {
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${playResX}`,
    `PlayResY: ${playResY}`,
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Default style: Helvetica 48 (ASS font size is roughly in pixels relative
    // to PlayResY; 48 at 1920 ≈ 22pt at 720p, matching the old FontSize=22 intent).
    // PrimaryColour: white  (&H00FFFFFF)
    // OutlineColour: black  (&H00000000)
    // BackColour:    black  (&H00000000)
    // BorderStyle 1 = outline+shadow; 3 = opaque box. We keep 1 for readable outline.
    // Outline thickness 2, Shadow 0, Alignment 2 (bottom-center), MarginV 60.
    'Style: Default,Helvetica,48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,0,2,40,40,80,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ].join('\n');

  // Parse SRT cues into {start, end, text}
  const cues = [];
  const blocks = srtContent.split(/\r?\n\r?\n/).filter(b => b.trim().length > 0);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter(l => l.length > 0);
    // SRT block shape: [index, timecode, text...]
    // Some blocks drop the index; detect by scanning for `-->`.
    const tcIdx = lines.findIndex(l => l.includes('-->'));
    if (tcIdx === -1) continue;

    const tc = lines[tcIdx];
    const tcMatch = tc.match(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/);
    if (!tcMatch) continue;
    const startSec = _parseSrtTimestamp(tcMatch[1]);
    const endSec = _parseSrtTimestamp(tcMatch[2]);

    const text = lines.slice(tcIdx + 1).join('\\N'); // ASS line break
    if (!text.trim()) continue;

    cues.push({ start: startSec, end: endSec, text });
  }

  const events = cues.map(c =>
    `Dialogue: 0,${_assTimestamp(c.start)},${_assTimestamp(c.end)},Default,,0,0,0,,${c.text}`
  );

  return header + '\n' + events.join('\n') + '\n';
}

function _parseSrtTimestamp(tc) {
  // SRT: HH:MM:SS,mmm (or HH:MM:SS.mmm in some variants)
  const m = tc.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4], 10) / 1000;
}

/**
 * Burn subtitles into a video by rendering each cue as a PNG with sharp and
 * compositing them via ffmpeg's overlay filter with time-enable expressions.
 *
 * Why NOT subtitles/ass filter: the user's ffmpeg build (Homebrew 8.1) was
 * NOT compiled with `--enable-libass`. Neither the `subtitles` nor `ass`
 * filter exists. This was confirmed via `ffmpeg -filters | grep -i subtitle`.
 * No amount of command-line escaping fixes a missing compile-time dependency.
 *
 * PNG-overlay approach requires only sharp (already a dependency from title/end
 * card rendering) and ffmpeg's built-in `overlay` filter. Zero external libs.
 *
 * Each SRT cue becomes a PNG at 1080×120 with white text, dark semi-transparent
 * outline, positioned at the bottom. ffmpeg's enable expression
 * `between(t,start,end)` controls visibility per cue.
 *
 * Limitation: ffmpeg filter_complex with many overlay chains gets unwieldy
 * past ~20 cues. For V4 episodes with 3-12 dialogue beats this is fine.
 * If episodes grow beyond 20 cues, we'll batch overlays in groups.
 */
async function burnSubtitles(inputPath, srtContent, outputPath) {
  if (!srtContent || srtContent.trim().length === 0) {
    fs.copyFileSync(inputPath, outputPath);
    return;
  }

  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch {
    logger.warn('sharp not available — skipping subtitle burn-in');
    fs.copyFileSync(inputPath, outputPath);
    return;
  }

  // Parse SRT into cues
  const blocks = srtContent.split(/\r?\n\r?\n/).filter(b => b.trim().length > 0);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter(l => l.length > 0);
    const tcIdx = lines.findIndex(l => l.includes('-->'));
    if (tcIdx === -1) continue;
    const tc = lines[tcIdx];
    const tcMatch = tc.match(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/);
    if (!tcMatch) continue;
    const startSec = _parseSrtTimestamp(tcMatch[1]);
    const endSec = _parseSrtTimestamp(tcMatch[2]);
    const text = lines.slice(tcIdx + 1).join('\n').trim();
    if (!text) continue;
    cues.push({ start: startSec, end: endSec, text });
  }

  if (cues.length === 0) {
    fs.copyFileSync(inputPath, outputPath);
    return;
  }

  const pngPaths = [];
  const pngWidth = OUTPUT_WIDTH;
  const pngHeight = 120;

  try {
    // Render each cue as a transparent PNG with white text + dark outline
    for (let i = 0; i < cues.length; i++) {
      const escaped = cues[i].text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

      // Wrap long lines at ~45 chars to keep text visible at 1080px width
      const words = escaped.split(/\s+/);
      const svgLines = [];
      let currentLine = '';
      for (const word of words) {
        if ((currentLine + ' ' + word).length > 45 && currentLine) {
          svgLines.push(currentLine.trim());
          currentLine = word;
        } else {
          currentLine += ' ' + word;
        }
      }
      if (currentLine.trim()) svgLines.push(currentLine.trim());

      const lineHeight = 40;
      const svgHeight = Math.max(pngHeight, svgLines.length * lineHeight + 30);

      const textElements = svgLines.map((line, li) =>
        `<text x="${pngWidth / 2}" y="${30 + li * lineHeight}"
              font-family="Helvetica, Arial, sans-serif"
              font-size="32"
              font-weight="bold"
              fill="white"
              stroke="black"
              stroke-width="3"
              text-anchor="middle"
              dominant-baseline="hanging">${line}</text>`
      ).join('\n');

      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pngWidth}" height="${svgHeight}">
        <rect width="100%" height="100%" fill="black" fill-opacity="0.5" rx="8"/>
        ${textElements}
      </svg>`;

      const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
      const pngPath = tmpPath('png');
      fs.writeFileSync(pngPath, pngBuffer);
      pngPaths.push(pngPath);
    }

    // Build ffmpeg overlay filter chain.
    // Each cue's PNG is a looped input; enable='between(t,start,end)' controls visibility.
    // Position at bottom of the frame (y = OUTPUT_HEIGHT - subtitle_height - marginV).
    const marginV = 80;
    const inputs = ['-i', inputPath];
    for (const pp of pngPaths) {
      inputs.push('-loop', '1', '-i', pp);
    }

    let filterChain = '';
    let lastLabel = '0:v';
    for (let i = 0; i < cues.length; i++) {
      const inputIdx = i + 1; // input 0 is the video, 1..N are the PNGs
      const outLabel = i === cues.length - 1 ? '[vout]' : `[v${i}]`;
      const start = cues[i].start.toFixed(3);
      const end = cues[i].end.toFixed(3);
      // Position: centered horizontally, at bottom with marginV offset
      filterChain += `[${lastLabel}][${inputIdx}:v]overlay=x=(W-w)/2:y=H-h-${marginV}:enable='between(t\\,${start}\\,${end})'${outLabel}`;
      if (i < cues.length - 1) filterChain += ';';
      lastLabel = outLabel.replace('[', '').replace(']', '');
    }

    execFileSync('ffmpeg', [
      '-y',
      ...inputs,
      '-filter_complex', filterChain,
      '-map', '[vout]',
      '-map', '0:a?',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      '-shortest',
      outputPath
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    logger.info(`burned subtitles via PNG overlay (${cues.length} cue(s))`);
  } catch (err) {
    logger.warn(`subtitle burn-in failed: ${err.message} — outputting without subtitles`);
    fs.copyFileSync(inputPath, outputPath);
  } finally {
    cleanup(pngPaths);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Public API — the full pipeline
// ─────────────────────────────────────────────────────────────────────

/**
 * Run the full V4 post-production pipeline on an episode.
 *
 * @param {Object} params
 * @param {Buffer[]} params.beatVideoBuffers - generated beat videos in order
 * @param {Object[]} params.beatMetadata - ordered beat objects with model_used, duration_seconds, dialogue, etc.
 * @param {string} params.episodeLutId - the resolved LUT id (via resolveEpisodeLut)
 * @param {Buffer} [params.musicBedBuffer] - optional ElevenLabs Music MP3 buffer
 * @param {Array} [params.sceneGraph] - the full scene_description.scenes array (for transitions)
 * @param {Object} [params.episodeMeta] - { series_title, episode_title, cliffhanger } for overlays
 * @param {boolean} [params.burnSubtitles=true] - whether to burn-in SRT subtitles
 * @returns {Promise<{finalBuffer: Buffer, srtContent: string|null}>}
 */
export async function runPostProduction({
  beatVideoBuffers,
  beatMetadata,
  episodeLutId,
  musicBedBuffer,
  sceneGraph = null,
  episodeMeta = null,
  burnSubtitles: shouldBurnSubtitles = true
}) {
  if (!Array.isArray(beatVideoBuffers) || beatVideoBuffers.length === 0) {
    throw new Error('runPostProduction: no beat video buffers');
  }

  logger.info(`starting V4 post-production — ${beatVideoBuffers.length} beats, LUT=${episodeLutId}, music=${!!musicBedBuffer}, scenes=${sceneGraph?.length || 0}`);

  const tempPaths = [];
  const tempBeatPaths = [];

  try {
    // Write beat buffers to disk (index-aligned with beatMetadata)
    for (let i = 0; i < beatVideoBuffers.length; i++) {
      const p = writeBuffer(beatVideoBuffers[i], 'mp4');
      tempBeatPaths.push(p);
      tempPaths.push(p);
    }

    // ─── Stage 1 — per-beat correction + normalize ───
    logger.info(`stage 1/6: per-beat correction + normalize`);
    const normalizedPaths = correctAndNormalizeBeats(tempBeatPaths, beatMetadata);
    tempPaths.push(...normalizedPaths);

    // ─── Stage 1.5 (Phase 2) — per-beat SFX overlay for Kling/OmniHuman beats ───
    // Veo beats are skipped (Veo's native ambient is already strong). The
    // overlay generates an ElevenLabs Sound Effects clip from the beat's
    // ambient_sound field and mixes it under the existing beat audio at -22dB.
    logger.info(`stage 1.5/6: per-beat SFX overlay (non-Veo beats)`);
    await applyPerBeatSfxOverlays(normalizedPaths, beatMetadata, tempPaths);

    // ─── Stage 2 — scene-aware assembly with transitions ───
    logger.info(`stage 2/6: scene-aware assembly with transitions`);
    const assembledPath = tmpPath('mp4');
    tempPaths.push(assembledPath);

    // Build per-scene assemblies. Each scene's beats get concat'd tight,
    // then the scene's ambient bed is layered under the whole thing, then
    // scenes are joined with their Gemini-specified transition.
    if (sceneGraph && sceneGraph.length > 0) {
      const scenePaths = [];

      // Walk normalized beat videos in the same order the orchestrator
      // generated them. Match beats to scenes by position in the scene-graph.
      let beatIdx = 0;
      for (const scene of sceneGraph) {
        const sceneBeatPaths = [];
        const expectedCount = (scene.beats || []).filter(b =>
          b.type !== 'SPEED_RAMP_TRANSITION' && b.generated_video_url
        ).length;

        for (let i = 0; i < expectedCount; i++) {
          if (beatIdx < normalizedPaths.length) {
            sceneBeatPaths.push(normalizedPaths[beatIdx]);
            beatIdx++;
          }
        }

        if (sceneBeatPaths.length === 0) continue;

        // Probe every per-beat normalized file so we can see if any beat
        // has an audio/video duration mismatch (real Kling/Veo outputs
        // sometimes disagree). Logged as a duration trace.
        const beatDurs = sceneBeatPaths.map(p => probeDurationSec(p));
        logger.info(
          `[duration trace] scene ${scene?.scene_id || '?'}: ` +
          `per-beat durations (post-normalize+SFX): ${beatDurs.map(d => d.toFixed(2)).join(', ')}s ` +
          `(sum ${beatDurs.reduce((a, b) => a + b, 0).toFixed(2)}s)`
        );

        // 1. Concat the scene's beats into one scene mp4
        const sceneConcatPath = tmpPath('mp4');
        tempPaths.push(sceneConcatPath);
        concatNormalizedVideos(sceneBeatPaths, sceneConcatPath);
        const sceneConcatDur = probeDurationSec(sceneConcatPath);

        // 2. Apply the Hollywood-grade scene-level ambient bed on top.
        // This is what ties all the beats together acoustically — one
        // continuous room tone / atmosphere that masks the beat cuts.
        const sceneWithBedPath = tmpPath('mp4');
        tempPaths.push(sceneWithBedPath);
        await applySceneAmbientBed(sceneConcatPath, scene, sceneWithBedPath, tempPaths);
        const sceneWithBedDur = probeDurationSec(sceneWithBedPath);
        logger.info(
          `[duration trace] scene ${scene?.scene_id || '?'}: ` +
          `concat=${sceneConcatDur.toFixed(2)}s → +bed=${sceneWithBedDur.toFixed(2)}s ` +
          (Math.abs(sceneConcatDur - sceneWithBedDur) > 0.1 ? `⚠️ DRIFT ${(sceneConcatDur - sceneWithBedDur).toFixed(2)}s` : '')
        );

        // V4 emotional_hold honouring: if the LAST beat of the scene is
        // marked emotional_hold, the scene ends on a loaded silence — a
        // dissolve would smear that silence into the next scene. Force a
        // clean cut/fadeblack instead so the hold lands.
        const lastBeat = Array.isArray(scene.beats) && scene.beats.length > 0
          ? scene.beats[scene.beats.length - 1]
          : null;
        let transitionOut = scene.transition_to_next || 'dissolve';
        if (lastBeat && lastBeat.emotional_hold === true && transitionOut === 'dissolve') {
          transitionOut = 'fadeblack';
          logger.info(`scene ${scene.scene_id || '?'}: last beat carries emotional_hold → forcing transition dissolve → fadeblack`);
        }

        scenePaths.push({
          path: sceneWithBedPath,
          transitionToNext: transitionOut,
          ambientBedPrompt: scene.ambient_bed_prompt || null,
          endsOnHold: lastBeat?.emotional_hold === true
        });
      }

      if (scenePaths.length > 0) {
        // Don't transition OUT of the final scene
        if (scenePaths.length > 0) scenePaths[scenePaths.length - 1].transitionToNext = 'cut';

        // Safeguard: if a scene has a hard 'cut' boundary but the next
        // scene has a DIFFERENT ambient bed, the ambient snaps abruptly
        // mid-listen — a Hollywood no-no. Auto-upgrade 'cut' to 'dissolve'
        // at those boundaries so the xfade path applies acrossfade to both
        // video AND audio. Cuts are preserved when beds match (same room/
        // scene continuation) since there's no audio discontinuity.
        for (let i = 0; i < scenePaths.length - 1; i++) {
          const curBed = scenePaths[i].ambientBedPrompt;
          const nextBed = scenePaths[i + 1].ambientBedPrompt;
          if (
            scenePaths[i].transitionToNext === 'cut' &&
            !scenePaths[i].endsOnHold &&
            curBed && nextBed && curBed !== nextBed
          ) {
            logger.info(
              `scene ${i} → ${i + 1}: upgrading 'cut' → 'dissolve' for ` +
              `ambient-bed continuity (differing beds)`
            );
            scenePaths[i].transitionToNext = 'dissolve';
          }
        }

        assembleScenesWithTransitions(scenePaths, assembledPath);
      } else {
        // Fallback: flat concat if scene walk produced nothing
        logger.warn(`scene walk produced no scenes — falling back to flat beat concat`);
        concatNormalizedVideos(normalizedPaths, assembledPath);
      }
    } else {
      // No scene-graph available → flat concat of all beats
      concatNormalizedVideos(normalizedPaths, assembledPath);
    }

    // DURATION TRACE — separate video/audio/container probes to surface any
    // stream-level divergence. A prior bug (2026-04-23) had container=27.16s
    // while audio=17.57s after the xfade chain; only separate-stream probes
    // exposed it. Every stage-2/3/4 trace now logs all three.
    const durAfterAssembly = probeStreamDurations(assembledPath);
    logger.info(`[duration trace] after stage 2 (assembly): container=${durAfterAssembly.container.toFixed(2)}s video=${durAfterAssembly.video.toFixed(2)}s audio=${durAfterAssembly.audio.toFixed(2)}s`);
    if (Math.abs(durAfterAssembly.video - durAfterAssembly.audio) > 0.5) {
      logger.warn(`[duration trace] ⚠ stage 2 video/audio DIVERGENCE of ${Math.abs(durAfterAssembly.video - durAfterAssembly.audio).toFixed(2)}s — downstream -shortest/amix behaviour WILL truncate the output to the shorter stream`);
    }

    // ─── Stage 3 — unified creative LUT pass ───
    logger.info(`stage 3/6: creative LUT pass (${episodeLutId})`);
    const gradedPath = tmpPath('mp4');
    tempPaths.push(gradedPath);
    applyCreativeLut(assembledPath, gradedPath, episodeLutId);
    const durAfterLut = probeStreamDurations(gradedPath);
    logger.info(`[duration trace] after stage 3 (creative LUT): container=${durAfterLut.container.toFixed(2)}s video=${durAfterLut.video.toFixed(2)}s audio=${durAfterLut.audio.toFixed(2)}s`);

    // ─── Stage 4 — music bed mix (ducked under dialogue beats) ───
    let currentPath = gradedPath;
    if (musicBedBuffer) {
      logger.info(`stage 4/6: music bed mix with dialogue ducking`);
      const musicPath = writeBuffer(musicBedBuffer, 'mp3');
      const mixedPath = tmpPath('mp4');
      tempPaths.push(musicPath, mixedPath);
      mixMusicBedWithDucking(currentPath, musicPath, mixedPath, beatMetadata);
      currentPath = mixedPath;
      const durAfterMusic = probeStreamDurations(currentPath);
      logger.info(`[duration trace] after stage 4 (music mix): container=${durAfterMusic.container.toFixed(2)}s video=${durAfterMusic.video.toFixed(2)}s audio=${durAfterMusic.audio.toFixed(2)}s`);
    } else {
      logger.info(`stage 4/6: no music bed, skipping mix`);
    }

    // ─── Stage 5 — title + end card overlays ───
    // Track whether a title card was prepended so Stage 6's SRT cues can be
    // offset accordingly. Without this shift, subtitles burn at cue-zero-based
    // timestamps and land on the silent title card instead of the dialogue.
    let titleCardOffsetSec = 0;
    if (episodeMeta?.series_title || episodeMeta?.episode_title) {
      logger.info(`stage 5/6: title + end card overlays`);
      const withCardsPath = tmpPath('mp4');
      tempPaths.push(withCardsPath);
      const videoDuration = probeDurationSec(currentPath);
      await applyTitleAndEndCards({
        inputPath: currentPath,
        outputPath: withCardsPath,
        seriesTitle: episodeMeta.series_title,
        episodeTitle: episodeMeta.episode_title,
        cliffhanger: episodeMeta.cliffhanger,
        videoDurationSec: videoDuration
      });
      currentPath = withCardsPath;
      titleCardOffsetSec = TITLE_CARD_SEC;
      const durAfterCards = probeDurationSec(currentPath);
      logger.info(`[duration trace] after stage 5 (title+end cards): ${durAfterCards.toFixed(2)}s`);
    } else {
      logger.info(`stage 5/6: no episodeMeta, skipping overlays`);
    }

    // ─── Stage 6 — subtitle burn-in ───
    let srtContent = null;
    if (shouldBurnSubtitles) {
      logger.info(`stage 6/6: subtitle burn-in`);
      srtContent = buildSrtFromBeats(beatMetadata, titleCardOffsetSec);
      if (srtContent && srtContent.trim().length > 0) {
        const withSubsPath = tmpPath('mp4');
        tempPaths.push(withSubsPath);
        await burnSubtitles(currentPath, srtContent, withSubsPath);
        currentPath = withSubsPath;
        const durAfterSubs = probeDurationSec(currentPath);
        logger.info(`[duration trace] after stage 6 (subtitle burn-in): ${durAfterSubs.toFixed(2)}s`);
      } else {
        logger.info(`no dialogue beats to subtitle`);
      }
    } else {
      logger.info(`stage 6/6: subtitles disabled by caller`);
    }

    const finalBuffer = fs.readFileSync(currentPath);
    logger.info(`post-production complete — ${(finalBuffer.length / 1024 / 1024).toFixed(1)}MB`);
    return { finalBuffer, srtContent };
  } finally {
    cleanup(tempPaths);
  }
}

/**
 * Get the estimated assembled duration of a list of beats.
 * Used by MusicService.generateMusicBed() to size the music bed correctly.
 */
export function estimateEpisodeDuration(beatMetadata) {
  return beatMetadata.reduce((sum, b) => sum + (b.actual_duration_sec || b.duration_seconds || 0), 0);
}
