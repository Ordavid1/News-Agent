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
 * Concat scenes with an ffmpeg xfade transition between each adjacent pair.
 * Each scene is pre-assembled (per-scene tight cut) and passed in as a
 * normalized mp4 path. Transitions come from the scene-graph:
 *   'dissolve' / 'fadeblack' / 'cut' / 'speed_ramp'
 *
 * 'cut' just concats straight (no xfade filter). 'dissolve' uses xfade=fade.
 * 'fadeblack' uses xfade=fadeblack. 'speed_ramp' applies setpts to the tail
 * of the outgoing scene + head of the incoming scene before concat.
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

  // For Phase 1b, we implement dissolve + fadeblack + cut.
  // Speed ramps are approximated as a 0.5s xfade for Phase 1b. Phase 2 adds
  // real setpts ramp logic.
  //
  // Strategy: fall back to concat demuxer whenever transitions collapse to
  // all-cut, because xfade filter_complex chains are fragile with many inputs
  // and a straight concat is indistinguishable from all-cut.
  const allCuts = scenes.every((s, i) => i === scenes.length - 1 || !s.transitionToNext || s.transitionToNext === 'cut');
  if (allCuts) {
    logger.info(`assembly: all cuts → concat demuxer`);
    concatNormalizedVideos(scenes.map(s => s.path), outputPath);
    return;
  }

  // xfade filter_complex path. Probe durations so we know when each transition starts.
  for (const s of scenes) {
    if (s.durationSec == null || s.durationSec <= 0) {
      s.durationSec = probeDurationSec(s.path);
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
  // cumulativeDuration invariant: after each iteration, cumulativeDuration
  // equals the actual duration of [v_i] (the growing video output). This is
  // how subsequent xfade offsets resolve correctly. For the invariant to hold,
  // the per-iter subtraction must equal the ACTUAL video overlap of that
  // transition — NOT a hard-coded TRANSITION_DURATION.
  //
  // Previously the code used `cumulativeDuration -= TRANSITION_DURATION` (0.5s)
  // uniformly. That broke for cut transitions (video overlap 0.01s) because
  // the cumulative went 0.49s BEHIND the actual [v_i] duration. After one
  // cut, every subsequent xfade offset was 0.49s too early, truncating the
  // previous scene's tail. After N cuts the accumulated error meant big
  // chunks of video simply never played. Caught 2026-04-21 when a single
  // cut in a 3-scene Action episode produced a 17s output (vs 44s expected).
  //
  // Fix: derive both offset AND subtraction from the transition's actual
  // video overlap. Dissolve/fadeblack/speed_ramp use TRANSITION_DURATION;
  // cuts use CUT_XFADE_DURATION. No more drift.
  //
  // Audio stays at acrossfade(TRANSITION_DURATION) universally because the
  // ambient bed is what carries scene-to-scene continuity — video can cut
  // hard but audio should always smooth. The resulting video/audio length
  // divergence per cut is (TRANSITION_DURATION - CUT_XFADE_DURATION) = 0.49s;
  // `-shortest` downstream trims the final by that amount from the tail,
  // which is acceptable (end card absorbs it).
  const CUT_XFADE_DURATION = 0.01;
  const videoChain = [];
  const audioChain = [];
  let cumulativeDuration = 0;

  for (let i = 0; i < scenes.length - 1; i++) {
    const leftLabel = i === 0 ? `[0:v]` : `[v${i - 1}]`;
    const rightLabel = `[${i + 1}:v]`;
    const outLabel = `[v${i}]`;
    const transition = scenes[i].transitionToNext || 'cut';
    const xfadeName = xfadeMap[transition];

    // Video overlap = actual duration the xfade filter consumes from the
    // outgoing input. Dissolve/fadeblack/speed_ramp = TRANSITION_DURATION.
    // Cut = CUT_XFADE_DURATION (sub-frame — visually indistinguishable from
    // a hard cut at 30fps).
    const videoOverlap = xfadeName ? TRANSITION_DURATION : CUT_XFADE_DURATION;
    const xfadeFilterName = xfadeName || 'fade';
    const xfadeDuration = videoOverlap;

    // cumulativeDuration now represents [v_{i-1}].duration (the growing video
    // output up to this point). Adding scenes[i].durationSec doesn't quite
    // describe it since cumulativeDuration was already tracking the running
    // output — but at iteration 0, no xfade has happened yet so we're adding
    // the first input's duration. At iteration i>0, we're adding the NEXT
    // raw input (scene i+1-th, but indexed as scenes[i] per the loop's
    // scene pairing convention): this grows cumulativeDuration from
    // [v_{i-1}].duration to [v_{i-1}].duration + next_input.duration, which
    // is the value ffmpeg's xfade needs for offset arithmetic.
    cumulativeDuration += scenes[i].durationSec;
    const offset = Math.max(0, cumulativeDuration - videoOverlap);

    videoChain.push(
      `${leftLabel}${rightLabel}xfade=transition=${xfadeFilterName}:duration=${xfadeDuration}:offset=${offset.toFixed(3)}${outLabel}`
    );

    // Audio crossfade mirrors the video transition for xfade-based transitions
    // but keeps TRANSITION_DURATION for cuts so the ambient bed doesn't snap
    // at scene boundaries where beds might differ (already resolved upstream
    // by the cut→dissolve upgrade when beds differ, but cheap insurance).
    const leftAudioLabel = i === 0 ? `[0:a]` : `[a${i - 1}]`;
    const rightAudioLabel = `[${i + 1}:a]`;
    const audioOutLabel = `[a${i}]`;
    audioChain.push(`${leftAudioLabel}${rightAudioLabel}acrossfade=d=${TRANSITION_DURATION}${audioOutLabel}`);

    // Keep cumulativeDuration consistent with the VIDEO overlap so offsets
    // for subsequent transitions resolve against the real [v_i] duration.
    cumulativeDuration -= videoOverlap;
  }

  const lastVideoLabel = `[v${scenes.length - 2}]`;
  const lastAudioLabel = `[a${scenes.length - 2}]`;
  const filterComplex = [...videoChain, ...audioChain].join(';');

  try {
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
      const filterComplex = `[1:a]volume=${sfxVolume}[sfx];[0:a][sfx]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`;

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
  // repeat it forever; `-shortest` (via amix duration=first) terminates
  // at the scene's video duration so it never overshoots.
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
        `[0:a][bed]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`,
      '-map', '0:v',
      '-map', '[aout]',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      outputPath
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    logger.info(
      `scene ${scene?.scene_id || '?'}: ambient bed applied — ` +
      `"${prompt.slice(0, 50)}..." at ${SCENE_AMBIENT_BED_DB}dB over ${sceneDuration.toFixed(1)}s`
    );
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
    const filterComplex = `[1:a]volume=${musicVolume.toFixed(3)}[music];[0:a][music]amix=inputs=2:duration=first:dropout_transition=2[aout]`;

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
      '-shortest',
      outputPath
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    logger.info(`mixed music bed flat at ${musicDb}dB`);
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
    const filterComplex = `[1:a]volume='${volumeExpr}':eval=frame[music];[0:a][music]amix=inputs=2:duration=first:dropout_transition=0[aout]`;

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
      '-shortest',
      outputPath
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    logger.info(`mixed music bed with dialogue ducking (${dialogueWindows.length} window${dialogueWindows.length > 1 ? 's' : ''})`);
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

    // DURATION TRACE — helps pinpoint where truncation happens if the final
    // episode is shorter than expected. Added 2026-04-21 after a full-flow
    // test produced a 17s final from what should have been a 43s episode.
    const durAfterAssembly = probeDurationSec(assembledPath);
    logger.info(`[duration trace] after stage 2 (assembly): ${durAfterAssembly.toFixed(2)}s`);

    // ─── Stage 3 — unified creative LUT pass ───
    logger.info(`stage 3/6: creative LUT pass (${episodeLutId})`);
    const gradedPath = tmpPath('mp4');
    tempPaths.push(gradedPath);
    applyCreativeLut(assembledPath, gradedPath, episodeLutId);
    const durAfterLut = probeDurationSec(gradedPath);
    logger.info(`[duration trace] after stage 3 (creative LUT): ${durAfterLut.toFixed(2)}s`);

    // ─── Stage 4 — music bed mix (ducked under dialogue beats) ───
    let currentPath = gradedPath;
    if (musicBedBuffer) {
      logger.info(`stage 4/6: music bed mix with dialogue ducking`);
      const musicPath = writeBuffer(musicBedBuffer, 'mp3');
      const mixedPath = tmpPath('mp4');
      tempPaths.push(musicPath, mixedPath);
      mixMusicBedWithDucking(currentPath, musicPath, mixedPath, beatMetadata);
      currentPath = mixedPath;
      const durAfterMusic = probeDurationSec(currentPath);
      logger.info(`[duration trace] after stage 4 (music mix): ${durAfterMusic.toFixed(2)}s`);
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
