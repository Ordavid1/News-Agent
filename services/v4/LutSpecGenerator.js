// services/v4/LutSpecGenerator.js
// V4 Phase 1 — synthesize a .cube LUT from a declarative colorist spec.
//
// Why: hand-graded .cube files don't scale. Encoding the LUT taxonomy as
// declarative JSON (assets/luts/library.json — `creative[].spec`) lets us
//   (a) version-control the look definitions in human-readable form
//   (b) regenerate the cube files on demand (idempotent, disk-cached)
//   (c) ship new looks by adding a JSON entry, not a binary
//
// The spec is the same primary correction grammar Resolve / Premiere colorists
// use: lift / gamma / gain (per channel) + saturation + region tints
// (shadows / midtones / highlights). Every spec produces a deterministic
// 17×17×17 .cube file, indistinguishable from a colorist-made LUT to ffmpeg's
// lut3d filter.
//
// Spec schema (per LUT entry under `creative[]`):
//   {
//     id: "bs_drama_motivated_natural",
//     genre: "drama",
//     spec: {
//       lift:           [r, g, b],   // additive shift in shadows (signed, ~ -0.10 .. +0.10)
//       gamma:          [r, g, b],   // midtone curve per channel (~ 0.85 .. 1.15)
//       gain:           [r, g, b],   // overall multiplier per channel (~ 0.85 .. 1.15)
//       saturation:     scalar,      // 0=B&W, 1=identity, >1=more saturated
//       shadow_tint:    [r, g, b],   // additive shift weighted to shadows region (~ -0.05 .. +0.05)
//       midtone_tint:   [r, g, b],   // additive shift weighted to midtones region
//       highlight_tint: [r, g, b]    // additive shift weighted to highlights region
//     }
//   }
//
// Region weighting (luma-based):
//   shadow_weight    = max(0, 1 - 2*L)         // 1 at L=0 → 0 at L=0.5
//   midtone_weight   = 1 - abs(2*L - 1)        // 1 at L=0.5 → 0 at extremes
//   highlight_weight = max(0, 2*L - 1)         // 0 at L=0.5 → 1 at L=1
//
// Output order in .cube (Resolve / ffmpeg standard):
//   for B in 0..N-1:
//     for G in 0..N-1:
//       for R in 0..N-1:
//         emit "Rout Gout Bout"

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import winston from 'winston';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `[LutSpecGenerator] ${timestamp} [${level}]: ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

const LUT_SIZE = 17;

// Spec-generated LUTs cache to a separate dir from brand-generative LUTs so
// the two namespaces never collide. Names are deterministic from spec hash.
const SPEC_LUT_DIR = path.join(__dirname, '..', '..', 'assets', 'luts', 'generated_genre');

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function luma(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function asTriple(v, fallback) {
  if (Array.isArray(v) && v.length === 3) return [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0];
  return fallback;
}

function asScalar(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Lift / Gamma / Gain primary correction (per channel).
//   Standard formula: out = pow((in + lift*(1-in)) * gain, 1/gamma)
// Lift raises shadows without crushing highlights; gamma curves midtones;
// gain scales overall (highlights move most).
function applyLgg(channelIn, lift, gamma, gain) {
  const lifted = channelIn + lift * (1 - channelIn);
  const gained = lifted * gain;
  const safe = gained < 1e-6 ? 1e-6 : gained;  // avoid pow(0, x) edge
  const gammaInv = gamma <= 0 ? 1 : 1 / gamma;
  return Math.pow(safe, gammaInv);
}

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

/**
 * Stable deterministic hash of a spec. Identical spec → identical hash → identical
 * cube file → cache reuse across deploys / process restarts.
 */
export function specHash(spec) {
  // Round to 4 decimals before hashing to avoid float-noise cache misses.
  const round = (v) => Number(v.toFixed(4));
  const norm = {
    lift:           asTriple(spec.lift, [0, 0, 0]).map(round),
    gamma:          asTriple(spec.gamma, [1, 1, 1]).map(round),
    gain:           asTriple(spec.gain, [1, 1, 1]).map(round),
    saturation:     round(asScalar(spec.saturation, 1)),
    shadow_tint:    asTriple(spec.shadow_tint, [0, 0, 0]).map(round),
    midtone_tint:   asTriple(spec.midtone_tint, [0, 0, 0]).map(round),
    highlight_tint: asTriple(spec.highlight_tint, [0, 0, 0]).map(round)
  };
  return crypto.createHash('sha256').update(JSON.stringify(norm)).digest('hex').slice(0, 16);
}

/**
 * Generate a .cube file from a spec entry. Idempotent + cached on disk.
 *
 * @param {Object} entry - library.json `creative[]` entry with { id, spec, look }
 * @returns {{ filePath: string, cached: boolean }}
 */
export function generateLutFromSpec(entry) {
  if (!entry || !entry.spec) {
    throw new Error('generateLutFromSpec: entry.spec is required');
  }

  const spec = entry.spec;
  const lift           = asTriple(spec.lift, [0, 0, 0]);
  const gamma          = asTriple(spec.gamma, [1, 1, 1]);
  const gain           = asTriple(spec.gain, [1, 1, 1]);
  const saturation     = asScalar(spec.saturation, 1);
  const shadowTint     = asTriple(spec.shadow_tint, [0, 0, 0]);
  const midtoneTint    = asTriple(spec.midtone_tint, [0, 0, 0]);
  const highlightTint  = asTriple(spec.highlight_tint, [0, 0, 0]);

  // Cache key: spec hash. The id is included in the filename for human readability,
  // but the hash is what determines cache validity (so editing a spec → new file).
  const hash = specHash(spec);
  const filename = `${entry.id}_${hash}.cube`;
  const fullPath = path.join(SPEC_LUT_DIR, filename);

  if (fs.existsSync(fullPath)) {
    return { filePath: fullPath, cached: true };
  }

  fs.mkdirSync(SPEC_LUT_DIR, { recursive: true });

  logger.info(`generating spec LUT: ${entry.id} → ${filename}`);

  const lines = [];
  lines.push(`# V4 spec-generated LUT — ${entry.id}`);
  lines.push(`# Genre: ${entry.genre || 'n/a'}`);
  lines.push(`# Look: ${(entry.look || '').slice(0, 100)}`);
  lines.push(`# Spec hash: ${hash}`);
  lines.push(`TITLE "V4 Spec LUT — ${entry.id}"`);
  lines.push(`LUT_3D_SIZE ${LUT_SIZE}`);
  lines.push(`DOMAIN_MIN 0.0 0.0 0.0`);
  lines.push(`DOMAIN_MAX 1.0 1.0 1.0`);

  for (let bi = 0; bi < LUT_SIZE; bi++) {
    const bIn = bi / (LUT_SIZE - 1);
    for (let gi = 0; gi < LUT_SIZE; gi++) {
      const gIn = gi / (LUT_SIZE - 1);
      for (let ri = 0; ri < LUT_SIZE; ri++) {
        const rIn = ri / (LUT_SIZE - 1);

        // 1. Lift / Gamma / Gain per channel.
        let r = applyLgg(rIn, lift[0], gamma[0], gain[0]);
        let g = applyLgg(gIn, lift[1], gamma[1], gain[1]);
        let b = applyLgg(bIn, lift[2], gamma[2], gain[2]);

        // 2. Region-weighted tints (shadows / midtones / highlights). Use the
        // luma of the post-LGG signal so tints follow brightness redistribution.
        const L = luma(r, g, b);
        const sw = Math.max(0, 1 - 2 * L);
        const mw = 1 - Math.abs(2 * L - 1);
        const hw = Math.max(0, 2 * L - 1);

        r += sw * shadowTint[0] + mw * midtoneTint[0] + hw * highlightTint[0];
        g += sw * shadowTint[1] + mw * midtoneTint[1] + hw * highlightTint[1];
        b += sw * shadowTint[2] + mw * midtoneTint[2] + hw * highlightTint[2];

        // 3. Saturation: shift each channel toward / away from luma.
        const Lpost = luma(r, g, b);
        r = Lpost + (r - Lpost) * saturation;
        g = Lpost + (g - Lpost) * saturation;
        b = Lpost + (b - Lpost) * saturation;

        lines.push(`${clamp01(r).toFixed(6)} ${clamp01(g).toFixed(6)} ${clamp01(b).toFixed(6)}`);
      }
    }
  }

  fs.writeFileSync(fullPath, lines.join('\n') + '\n');
  logger.info(`spec LUT written: ${fullPath}`);
  return { filePath: fullPath, cached: false };
}

/**
 * Resolve a spec-based LUT entry to a usable .cube file path. Generates on
 * demand if not cached. Returns null when entry has no spec field (caller
 * should fall back to legacy `file` lookup).
 */
export function resolveSpecLutPath(entry) {
  if (!entry?.spec) return null;
  try {
    return generateLutFromSpec(entry).filePath;
  } catch (err) {
    logger.error(`resolveSpecLutPath failed for ${entry?.id}: ${err.message}`);
    return null;
  }
}

export const _internals = { LUT_SIZE, SPEC_LUT_DIR, applyLgg, luma, clamp01 };
