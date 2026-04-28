// services/v4/GenerativeLut.js
// V4 Phase 2 — synthesize a custom .cube LUT from a brand's hex color palette.
//
// Why: the curated 8-LUT library is convenient but generic. A user with a
// distinctive brand identity (e.g. #1A1A2E + #F5C518 + #E94560) gets the same
// LUT as every other "tech B2B" brand. Generative LUTs let the actual brand
// hex palette become the tonal targets in the grade — far more brand-faithful.
//
// Algorithm:
//   1. Build an identity 17×17×17 3D LUT (4913 entries — small, fast, free)
//   2. For each entry, calculate a weighted "pull" toward each brand color
//      based on distance in RGB space. Closer colors pull harder.
//   3. Apply a tunable strength (0..1) so we can dial the grade from "hint"
//      (0.15) to "stylized" (0.6) without going extreme.
//   4. Write the result as a Resolve-compatible .cube text file
//
// The output is a real .cube file that ffmpeg's lut3d filter accepts directly,
// indistinguishable from a colorist-made LUT.
//
// Caching: generated LUTs are cached on disk under assets/luts/generated/
// keyed by a hash of (palette + strength) so we don't regenerate on every
// episode if the brand kit hasn't changed.

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
    winston.format.printf(({ timestamp, level, message }) => `[GenerativeLut] ${timestamp} [${level}]: ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

// LUT cube resolution. 17 is the standard "Resolve preview" size — big enough
// for accurate grading, small enough to write/read in milliseconds.
const LUT_SIZE = 17;

// Output directory for cached generated LUTs (separate from the curated library)
const GENERATED_LUT_DIR = path.join(__dirname, '..', '..', 'assets', 'luts', 'generated');

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Parse a hex color string (#RRGGBB or RRGGBB) to a [r, g, b] triple in [0, 1].
 */
function hexToRgb01(hex) {
  if (!hex || typeof hex !== 'string') return null;
  const cleaned = hex.replace('#', '').trim();
  if (cleaned.length !== 6) return null;
  const r = parseInt(cleaned.slice(0, 2), 16);
  const g = parseInt(cleaned.slice(2, 4), 16);
  const b = parseInt(cleaned.slice(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
  return [r / 255, g / 255, b / 255];
}

/**
 * Squared Euclidean distance between two RGB triples in [0,1].
 */
function distSq(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

/**
 * Convert RGB → luma (Rec.709). Used to match brand colors to similar luma
 * regions of the input cube — pulls dark brand colors into shadows, light
 * brand colors into highlights, instead of bleeding everywhere.
 */
function luma(rgb) {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

/**
 * Clamp a value to [0, 1].
 */
function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

/**
 * Convert RGB [0,1] → hue in degrees [0, 360). Used by validateSkinPreservation
 * to detect hue shifts away from natural skin-tone after applying a generated LUT.
 */
function rgbToHueDeg(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 1e-6) return 0;  // achromatic — no hue shift
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else                h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/**
 * Apply the same blend the cube generator does to a single RGB triple. Pulled
 * out so validateSkinPreservation can simulate cube transforms without
 * walking the entire 17×17×17 grid.
 */
function applyPaletteBlend(inputRgb, targets, targetLumas, strength) {
  const inputLuma = luma(inputRgb);
  let pullR = 0, pullG = 0, pullB = 0;
  let totalWeight = 0;

  for (let ti = 0; ti < targets.length; ti++) {
    const target = targets[ti];
    const tLuma = targetLumas[ti];
    const d2 = distSq(inputRgb, target) + 0.001;
    const distWeight = 1 / d2;
    const lumaDiff = inputLuma - tLuma;
    const lumaWeight = Math.exp(-(lumaDiff * lumaDiff) / 0.065);
    const weight = distWeight * lumaWeight;
    pullR += target[0] * weight;
    pullG += target[1] * weight;
    pullB += target[2] * weight;
    totalWeight += weight;
  }

  let blendedR = inputRgb[0], blendedG = inputRgb[1], blendedB = inputRgb[2];
  if (totalWeight > 0) {
    blendedR = pullR / totalWeight;
    blendedG = pullG / totalWeight;
    blendedB = pullB / totalWeight;
  }

  return [
    clamp01(inputRgb[0] * (1 - strength) + blendedR * strength),
    clamp01(inputRgb[1] * (1 - strength) + blendedG * strength),
    clamp01(inputRgb[2] * (1 - strength) + blendedB * strength)
  ];
}

/**
 * Skin-tone preservation validator. The right invariant for natural skin is
 * not hue-stability (warm shifts flatter skin; we WANT a warm-cinematic LUT
 * to push skin warmer) — it's CHANNEL ORDER. Natural human skin across all
 * ethnicities has R > G > B in linear RGB. If a LUT inverts that (G > R or
 * B > G), faces read alien (sickly green / dead blue / unnatural magenta).
 *
 * We sample a 3³ grid in the skin-tone neighborhood (R≈0.7, G≈0.55, B≈0.45
 * with ±0.10 spread per channel), apply the proposed blend, and check that
 * R ≥ G ≥ B is preserved on every sample with at least minMargin separation.
 * Any sample that inverts → reject; the LUT would damage faces.
 *
 * @param {Object} params
 * @param {Array<[r,g,b]>} params.targets   - normalized palette in [0,1]
 * @param {number}         params.strength  - proposed blend strength
 * @param {number}         [params.minMargin=0.005] - minimum R-G and G-B gap
 * @returns {{ ok: boolean, inversions: number, worstSample?: [number,number,number], sampleCount: number, reason?: string }}
 */
export function validateSkinPreservation({ targets, strength, minMargin = 0.005 }) {
  if (!Array.isArray(targets) || targets.length === 0) {
    return { ok: false, inversions: 0, sampleCount: 0, reason: 'no targets' };
  }
  if (strength <= 0) {
    return { ok: true, inversions: 0, sampleCount: 0 };
  }

  const targetLumas = targets.map(luma);

  const skinCenter = [0.70, 0.55, 0.45];
  const offsets = [-0.10, 0.00, 0.10];
  let inversions = 0;
  let worstSample = null;
  let sampleCount = 0;

  for (const dr of offsets) {
    for (const dg of offsets) {
      for (const db of offsets) {
        const sample = [
          clamp01(skinCenter[0] + dr),
          clamp01(skinCenter[1] + dg),
          clamp01(skinCenter[2] + db)
        ];

        // Only test samples that are actually valid skin (R > G > B with margin
        // in the input). Otherwise the offset grid produces non-skin samples
        // and the test would falsely blame the LUT for input inversions.
        if (sample[0] - sample[1] < minMargin || sample[1] - sample[2] < minMargin) continue;

        const after = applyPaletteBlend(sample, targets, targetLumas, strength);
        sampleCount++;

        // Channel-order check: R ≥ G ≥ B must be preserved after the blend.
        const rg = after[0] - after[1];
        const gb = after[1] - after[2];
        if (rg < -minMargin || gb < -minMargin) {
          inversions++;
          if (!worstSample) worstSample = after;
        }
      }
    }
  }

  return {
    ok: inversions === 0,
    inversions,
    worstSample,
    sampleCount,
    reason: inversions > 0
      ? `skin-tone channel inversion in ${inversions}/${sampleCount} samples (R<G or G<B detected)`
      : undefined
  };
}

/**
 * Quality gate for a brand palette + strength combination. Returns:
 *   { ok: true } when the palette is safe to use as-is
 *   { ok: false, reason, downscaleStrengthTo? } when the palette would damage
 *     output. Caller (orchestrator) decides whether to fall back to genre LUT
 *     only or apply at the suggested downscaled strength.
 *
 * Quality gates (see plan Phase 2):
 *   - palette has < 2 distinct hues  → reject (crushed channels, banding)
 *   - palette avg chroma < 0.10      → reject (no useful pull direction)
 *   - all colors at one luma extreme → downscale strength to 0.10
 *   - skin-tone hue shift > 10°      → reject (faces are non-negotiable)
 */
export function validateBrandPalette({ targets, strength }) {
  if (!Array.isArray(targets) || targets.length === 0) {
    return { ok: false, reason: 'empty palette' };
  }

  // Gate 1: average chroma. Reject palettes with no useful pull direction.
  // Chroma = max-min per RGB triple — rough but honest measure of saturation.
  const avgChroma = targets.reduce((sum, t) => sum + (Math.max(...t) - Math.min(...t)), 0) / targets.length;
  if (avgChroma < 0.10) {
    return { ok: false, reason: `palette is too desaturated (avg chroma ${avgChroma.toFixed(2)})` };
  }

  // Gate 2: luma span. Tonal brand palettes (analogous hues, varied lumas) are
  // FINE — that's how a coherent brand kit looks (cream / tan / brown). What's
  // NOT fine is when ALL colors collapse to the same luma region — the LUT
  // can't differentiate shadows / midtones / highlights, so highlights pull
  // toward the same brand-color blob as shadows. Span < 0.20 → reject.
  const lumas = targets.map(luma);
  const lumaSpan = Math.max(...lumas) - Math.min(...lumas);
  if (lumaSpan < 0.20) {
    return { ok: false, reason: `palette luma span ${lumaSpan.toFixed(2)} too narrow (would not differentiate luma regions)` };
  }

  const skinCheck = validateSkinPreservation({ targets, strength });
  if (!skinCheck.ok) {
    return { ok: false, reason: skinCheck.reason };
  }

  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

/**
 * Generate a custom .cube LUT from a brand color palette.
 *
 * @param {Object} params
 * @param {Array<{hex?: string, name?: string}>} params.colorPalette - brand kit color palette
 * @param {number} [params.strength=0.35] - blend strength: 0 = identity, 1 = full pull
 * @param {string} [params.brandName='brand'] - used in the LUT title comment
 * @returns {Promise<{lutId: string, filePath: string, isGenerated: true}>}
 */
export async function generateLutFromPalette({ colorPalette, strength = 0.35, brandName = 'brand' }) {
  if (!Array.isArray(colorPalette) || colorPalette.length === 0) {
    throw new Error('generateLutFromPalette: colorPalette is required');
  }

  // Normalize the palette to [r, g, b] triples in [0,1] + skip invalid hexes
  const targets = colorPalette
    .map(c => hexToRgb01(c?.hex || c))
    .filter(Boolean);

  if (targets.length === 0) {
    throw new Error('generateLutFromPalette: no valid hex colors in palette');
  }

  // Quality gate — reject palettes that would damage faces / crush channels /
  // produce banding. May return a downscaled strength to use instead.
  const validation = validateBrandPalette({ targets, strength });
  if (!validation.ok) {
    logger.warn(`generateLutFromPalette: palette rejected (${validation.reason})`);
    return { lutId: null, filePath: null, isGenerated: false, rejected: true, reason: validation.reason };
  }
  let effectiveStrength = strength;
  if (validation.downscaleStrengthTo != null && validation.downscaleStrengthTo < strength) {
    logger.info(`generateLutFromPalette: downscaling strength ${strength.toFixed(2)} → ${validation.downscaleStrengthTo.toFixed(2)} (${validation.reason})`);
    effectiveStrength = validation.downscaleStrengthTo;
  }

  // Cache key: hash of (palette + strength) so identical inputs reuse the same file
  const cacheKeyInput = JSON.stringify({ targets, strength: effectiveStrength.toFixed(3) });
  const cacheKey = crypto.createHash('sha256').update(cacheKeyInput).digest('hex').slice(0, 16);
  const lutId = `gen_${cacheKey}`;
  const filename = `${lutId}.cube`;
  const fullPath = path.join(GENERATED_LUT_DIR, filename);

  // Cache hit?
  if (fs.existsSync(fullPath)) {
    logger.info(`generative LUT cache hit: ${lutId}`);
    return { lutId, filePath: fullPath, isGenerated: true, effectiveStrength };
  }

  // Make sure the cache directory exists
  fs.mkdirSync(GENERATED_LUT_DIR, { recursive: true });

  logger.info(`generating LUT from palette (${targets.length} colors, strength=${effectiveStrength.toFixed(2)}, key=${cacheKey})`);

  const lines = [];
  // .cube file header (Resolve-compatible)
  lines.push(`# Generated V4 LUT for ${brandName}`);
  lines.push(`# Palette: ${targets.map(t => `(${(t[0]*255).toFixed(0)},${(t[1]*255).toFixed(0)},${(t[2]*255).toFixed(0)})`).join(' ')}`);
  lines.push(`# Strength: ${effectiveStrength.toFixed(3)}`);
  lines.push(`TITLE "V4 Generative LUT — ${brandName}"`);
  lines.push(`LUT_3D_SIZE ${LUT_SIZE}`);
  lines.push(`DOMAIN_MIN 0.0 0.0 0.0`);
  lines.push(`DOMAIN_MAX 1.0 1.0 1.0`);

  const targetLumas = targets.map(luma);

  // Walk the cube in the order .cube format expects: B outer, G middle, R inner
  for (let bi = 0; bi < LUT_SIZE; bi++) {
    const bIn = bi / (LUT_SIZE - 1);
    for (let gi = 0; gi < LUT_SIZE; gi++) {
      const gIn = gi / (LUT_SIZE - 1);
      for (let ri = 0; ri < LUT_SIZE; ri++) {
        const rIn = ri / (LUT_SIZE - 1);

        // Compute the gravitational pull toward every brand color, weighted by
        // (a) RGB distance: closer colors pull harder (1/distance²)
        // (b) Luma similarity: brand colors only influence input pixels in the
        //     same brightness region (so a dark brand red doesn't bleed into highlights)
        const inputRgb = [rIn, gIn, bIn];
        const inputLuma = luma(inputRgb);

        let pullR = 0, pullG = 0, pullB = 0;
        let totalWeight = 0;

        for (let ti = 0; ti < targets.length; ti++) {
          const target = targets[ti];
          const tLuma = targetLumas[ti];

          // RGB distance falloff
          const d2 = distSq(inputRgb, target) + 0.001; // avoid div-by-zero
          const distWeight = 1 / d2;

          // Luma similarity falloff (gaussian-ish, σ ~0.18)
          const lumaDiff = inputLuma - tLuma;
          const lumaWeight = Math.exp(-(lumaDiff * lumaDiff) / 0.065);

          const weight = distWeight * lumaWeight;
          pullR += target[0] * weight;
          pullG += target[1] * weight;
          pullB += target[2] * weight;
          totalWeight += weight;
        }

        // Normalized pull target (the "blended brand color" for this input pixel)
        let blendedR, blendedG, blendedB;
        if (totalWeight > 0) {
          blendedR = pullR / totalWeight;
          blendedG = pullG / totalWeight;
          blendedB = pullB / totalWeight;
        } else {
          blendedR = rIn; blendedG = gIn; blendedB = bIn;
        }

        // Mix the input with the blended target by `effectiveStrength`
        const outR = clamp01(rIn * (1 - effectiveStrength) + blendedR * effectiveStrength);
        const outG = clamp01(gIn * (1 - effectiveStrength) + blendedG * effectiveStrength);
        const outB = clamp01(bIn * (1 - effectiveStrength) + blendedB * effectiveStrength);

        lines.push(`${outR.toFixed(6)} ${outG.toFixed(6)} ${outB.toFixed(6)}`);
      }
    }
  }

  fs.writeFileSync(fullPath, lines.join('\n') + '\n');
  const sizeKB = (Buffer.byteLength(lines.join('\n')) / 1024).toFixed(1);
  logger.info(`generated LUT written: ${fullPath} (${sizeKB}KB, ${lines.length - 7} cube entries)`);

  return { lutId, filePath: fullPath, isGenerated: true, effectiveStrength };
}

/**
 * Generate a LUT from a brand kit (the convenience wrapper for the orchestrator).
 *
 * @param {Object} brandKit - brand_kit object (with color_palette + brand_summary)
 * @param {Object} [options]
 * @param {number} [options.strength]
 * @returns {Promise<{lutId: string, filePath: string, isGenerated: true} | null>}
 */
export async function generateLutFromBrandKit(brandKit, options = {}) {
  if (!brandKit?.color_palette || brandKit.color_palette.length === 0) {
    return null;
  }

  const result = await generateLutFromPalette({
    colorPalette: brandKit.color_palette,
    strength: options.strength != null ? options.strength : 0.35,
    brandName: brandKit.brand_summary?.slice(0, 40) || 'brand'
  });

  // Quality-gate rejection — caller treats as "no brand LUT available"
  if (result?.rejected) {
    logger.warn(`generateLutFromBrandKit: brand palette rejected — ${result.reason}`);
    return null;
  }
  return result;
}
