// services/v4/QualityGate.js
// V4 Phase 8 — Quality Gate.
//
// A lightweight, dependency-free post-generation QC layer that runs on every
// beat's rendered video BEFORE the next beat starts. Catches the silent
// failure modes that currently sneak past the pipeline:
//
//   * Beats that rendered mostly-black (Kling / Veo occasional soft-refusals
//     where the model returns a valid mp4 of empty frames). Today those
//     chain forward as endframes and corrupt the next beat too.
//   * Beats whose output resolution differs from 1080×1920 (model snaps to
//     a different aspect — normalization hides with blur-fill but framing
//     was still wrong upstream).
//   * Beats whose duration drifts far outside the requested window (Veo
//     snaps to {4,6,8}s bins and can silently double-up).
//
// Output contract:
//   { passed, issues: [{ id, severity, message }], metrics }
//
//   'critical' → orchestrator should trigger auto-regenerate
//   'warning'  → orchestrator logs; Director Panel shows caution chip

import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `[QualityGate] ${timestamp} [${level}]: ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

export const THRESHOLDS = {
  targetAspectRatio: 9 / 16,
  aspectTolerance: 0.10,
  maxDurationDriftRatio: 0.35,
  blackFrameThreshold: 0.60,  // > 60% of duration near-black → critical
  blackLumaMax: 16,
  blackPixelRatio: 0.95
};

function probeVideoMetrics(videoPath) {
  const out = execFileSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,duration',
    '-show_entries', 'format=duration',
    '-of', 'json',
    videoPath
  ], { encoding: 'utf-8' });

  const j = JSON.parse(out);
  const stream = j.streams?.[0] || {};
  const widthPx = Number(stream.width) || 0;
  const heightPx = Number(stream.height) || 0;
  const durationSec = Number(stream.duration) || Number(j.format?.duration) || 0;
  return {
    widthPx,
    heightPx,
    durationSec,
    aspectRatio: heightPx > 0 ? widthPx / heightPx : 0
  };
}

/**
 * Tally how much of the clip was black. Uses ffmpeg's blackdetect filter —
 * which writes results to stderr. We capture stderr directly regardless of
 * the process exit code (blackdetect often returns non-zero even on success
 * because ffmpeg complains about the null muxer tail).
 */
function computeBlackFrameRatio(videoPath, totalDurationSec) {
  if (totalDurationSec <= 0) return 0;
  const res = spawnSync('ffmpeg', [
    '-hide_banner',
    '-i', videoPath,
    '-vf', `blackdetect=d=0.05:pic_th=${THRESHOLDS.blackPixelRatio}:pix_th=${(THRESHOLDS.blackLumaMax / 255).toFixed(3)}`,
    '-an',
    '-f', 'null',
    '-'
  ], { encoding: 'utf-8' });
  const stderr = String(res.stderr || '');
  let blackSec = 0;
  const pattern = /black_duration:([\d.]+)/g;
  let m;
  while ((m = pattern.exec(stderr)) !== null) {
    blackSec += parseFloat(m[1]) || 0;
  }
  return Math.min(1, blackSec / totalDurationSec);
}

/**
 * Run the quality gate on a beat's rendered video.
 *
 * @param {Object} params
 * @param {Buffer} params.videoBuffer
 * @param {Object} params.beat - { beat_id, type, duration_seconds }
 * @param {Object} [params.faceEmbeddingProvider] - pluggable hook:
 *   { compareFaces(refJpg, endframeJpg) → Promise<similarity 0..1> }
 * @param {Buffer} [params.referenceFaceJpg]
 * @returns {Promise<{passed, issues, metrics}>}
 */
// Beat types whose entire content is intentionally a static, mostly-dark
// composition (title card, chapter divider, logo reveal). Running the
// black-frame detector on these surfaces "mostly black" as a critical fault
// when it is actually the intended design. Bypass the gate for these beats
// but still let them record passed=true so the Director Panel's QC badge
// stays clean.
const STATIC_CARD_BEAT_TYPES = new Set([
  'TEXT_OVERLAY_CARD',
  'SPEED_RAMP_TRANSITION' // assembler-only, shouldn't reach here but defensive
]);

export async function runQualityGate({
  videoBuffer,
  beat,
  faceEmbeddingProvider = null,
  referenceFaceJpg = null
}) {
  // Bypass QC for static-card beat types. These are rendered by sharp+ffmpeg
  // from a known-safe SVG template; there is no model output to validate.
  // Caught 2026-04-23: a TEXT_OVERLAY_CARD with a dark logo-reveal background
  // failed QC with `mostly_black:critical` even though the card was produced
  // exactly as designed.
  if (beat?.type && STATIC_CARD_BEAT_TYPES.has(beat.type)) {
    return {
      passed: true,
      issues: [],
      metrics: { skipped: true, reason: `static card beat type ${beat.type}` }
    };
  }

  if (!Buffer.isBuffer(videoBuffer)) {
    return {
      passed: false,
      issues: [{ id: 'no_buffer', severity: 'critical', message: 'Beat produced no video buffer.' }],
      metrics: {}
    };
  }

  const tmpDir = os.tmpdir();
  const runId = crypto.randomBytes(4).toString('hex');
  const mp4Path = path.join(tmpDir, `v4-qc-${runId}.mp4`);

  try {
    fs.writeFileSync(mp4Path, videoBuffer);
    const metrics = probeVideoMetrics(mp4Path);
    const issues = [];

    // ─── Aspect-ratio sanity ───
    const targetAR = THRESHOLDS.targetAspectRatio;
    const arDrift = Math.abs(metrics.aspectRatio - targetAR) / targetAR;
    if (metrics.widthPx === 0 || metrics.heightPx === 0) {
      issues.push({
        id: 'invalid_dimensions',
        severity: 'critical',
        message: `Beat ${beat?.beat_id}: ffprobe reported 0×0 dimensions — file is likely corrupt.`
      });
    } else if (arDrift > THRESHOLDS.aspectTolerance) {
      // 2026-05-07 — Director Agent prestige mandate: aspect_mismatch escalated
      // from warning to critical. Off-aspect generator output is the #1 visual
      // tell of "AI commercial" — letterbox bars (or blur-fill compensation)
      // signal "this was filmed wide and cropped" to viewers, the antithesis
      // of native prestige vertical. Critical severity fails the gate so
      // Director Lens C / Panel surface the caution and downstream consumers
      // (auto-retry, scoped retake) can act. The threshold (10% drift) is
      // unchanged — only the severity is upgraded.
      issues.push({
        id: 'aspect_mismatch',
        severity: 'critical',
        message: `Beat ${beat?.beat_id}: ${metrics.widthPx}×${metrics.heightPx} (AR=${metrics.aspectRatio.toFixed(3)}) differs from 9:16 by ${(arDrift * 100).toFixed(0)}%. Off-aspect generator output is a prestige-grade defect — retake required, do not ship via blur-fill.`
      });
    }

    // ─── Duration drift ───
    const requested = Number(beat?.duration_seconds) || 0;
    if (requested > 0 && metrics.durationSec > 0) {
      const drift = Math.abs(metrics.durationSec - requested) / requested;
      if (drift > THRESHOLDS.maxDurationDriftRatio) {
        issues.push({
          id: 'duration_drift',
          severity: 'warning',
          message: `Beat ${beat?.beat_id}: duration ${metrics.durationSec.toFixed(2)}s drifted ${(drift * 100).toFixed(0)}% from requested ${requested}s.`
        });
      }
    }

    // ─── Black-frame detection (content-filter soft-fail catcher) ───
    const blackRatio = computeBlackFrameRatio(mp4Path, metrics.durationSec);
    metrics.blackFrameRatio = blackRatio;
    if (blackRatio > THRESHOLDS.blackFrameThreshold) {
      issues.push({
        id: 'mostly_black',
        severity: 'critical',
        message: `Beat ${beat?.beat_id}: ${(blackRatio * 100).toFixed(0)}% near-black — model likely soft-refused and emitted an empty clip. Auto-retry.`
      });
    }

    // ─── Face-embedding continuity (pluggable) ───
    if (faceEmbeddingProvider && referenceFaceJpg) {
      try {
        const endframeJpg = extractLastFrameJpg(mp4Path);
        const similarity = await faceEmbeddingProvider.compareFaces(referenceFaceJpg, endframeJpg);
        metrics.faceSimilarity = similarity;
        if (typeof similarity === 'number' && similarity < 0.55) {
          issues.push({
            id: 'face_identity_drift',
            severity: 'warning',
            message: `Beat ${beat?.beat_id}: face similarity to character sheet = ${similarity.toFixed(2)}. Possible identity drift.`
          });
        }
      } catch (err) {
        logger.warn(`face embedding provider threw: ${err.message}`);
      }
    }

    const passed = !issues.some(i => i.severity === 'critical');
    return { passed, issues, metrics };
  } finally {
    try { if (fs.existsSync(mp4Path)) fs.unlinkSync(mp4Path); } catch {}
  }
}

function extractLastFrameJpg(videoPath) {
  const probeOut = execFileSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    videoPath
  ], { encoding: 'utf-8' });
  const durationSec = parseFloat(probeOut.trim()) || 0;
  const seekSec = Math.max(0, durationSec - 0.15);

  const jpgPath = path.join(os.tmpdir(), `v4-qc-endframe-${crypto.randomBytes(4).toString('hex')}.jpg`);
  try {
    execFileSync('ffmpeg', [
      '-y',
      '-ss', seekSec.toFixed(3),
      '-i', videoPath,
      '-frames:v', '1',
      '-update', '1',
      '-pix_fmt', 'yuvj420p',
      '-q:v', '2',
      jpgPath
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    return fs.readFileSync(jpgPath);
  } finally {
    try { if (fs.existsSync(jpgPath)) fs.unlinkSync(jpgPath); } catch {}
  }
}

export default { runQualityGate, THRESHOLDS };
