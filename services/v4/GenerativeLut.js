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
  //
  // V4 P3.5 — Graceful-degrade on skin-preservation failure.
  //
  // Before P3.5: skin failure → reject the palette outright → orchestrator
  // falls back to genre-LUT only → brand identity is LOST entirely.
  // Real-world impact: a magenta-heavy brand palette at strength 0.35 fails
  // skin preservation; the system reverts to pure genre LUT and the
  // commercial loses its brand color identity even though a softer pull
  // (strength 0.18 or 0.09) would have been safe AND brand-coherent.
  //
  // After P3.5: on skin failure ONLY, retry with strength * 0.5 up to 3 times
  // (strength chain: e.g. 0.35 → 0.175 → 0.0875 → 0.044). Each retry runs
  // the full validateBrandPalette (NOT just skin) so we don't accidentally
  // accept a luma-span violation. If strength drops below 0.05, give up
  // (the LUT would be visually negligible anyway). Other quality gates
  // (chroma, luma span) still hard-reject on first failure — they're
  // strength-independent properties.
  let validation = validateBrandPalette({ targets, strength });
  let effectiveStrength = strength;
  let degradationSteps = 0;
  const MIN_USEFUL_STRENGTH = 0.05;
  const MAX_DEGRADATION_STEPS = 3;

  if (!validation.ok && /skin/i.test(validation.reason || '')) {
    // Strength-dependent failure → try graceful-degrade. Keep halving until
    // we either pass validation OR drop below the useful-floor.
    while (
      !validation.ok &&
      /skin/i.test(validation.reason || '') &&
      effectiveStrength * 0.5 >= MIN_USEFUL_STRENGTH &&
      degradationSteps < MAX_DEGRADATION_STEPS
    ) {
      const reduced = +(effectiveStrength * 0.5).toFixed(3);
      logger.info(
        `generateLutFromPalette: skin gate failed at strength ${effectiveStrength.toFixed(2)} ` +
        `(${validation.reason}) — retrying at ${reduced.toFixed(2)} (degrade step ${degradationSteps + 1}/${MAX_DEGRADATION_STEPS})`
      );
      effectiveStrength = reduced;
      degradationSteps += 1;
      validation = validateBrandPalette({ targets, strength: effectiveStrength });
    }
    if (validation.ok && degradationSteps > 0) {
      logger.info(
        `generateLutFromPalette: graceful-degrade succeeded at strength ${effectiveStrength.toFixed(2)} ` +
        `after ${degradationSteps} step(s). Brand identity preserved at reduced pull.`
      );
    }
  }

  if (!validation.ok) {
    logger.warn(
      `generateLutFromPalette: palette rejected (${validation.reason})` +
      (degradationSteps > 0 ? ` after ${degradationSteps} graceful-degrade attempt(s) — strength bottomed out at ${effectiveStrength.toFixed(2)}` : '')
    );
    return { lutId: null, filePath: null, isGenerated: false, rejected: true, reason: validation.reason };
  }

  if (validation.downscaleStrengthTo != null && validation.downscaleStrengthTo < effectiveStrength) {
    logger.info(`generateLutFromPalette: downscaling strength ${effectiveStrength.toFixed(2)} → ${validation.downscaleStrengthTo.toFixed(2)} (${validation.reason})`);
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

// ─────────────────────────────────────────────────────────────────────
// V4 hotfix 2026-04-30 — Story-content-derived tonal trim presets.
//
// Why: when a story has NO brand_kit configured, the post-production
// pipeline previously applied ONLY the genre creative LUT
// (e.g. bs_action_teal_orange_punch) at full strength. Genre LUTs are
// designed as the AGGRESSIVE first-pass grade, intended to be tempered
// by a brand-palette trim layer at lower strength. With no trim layer
// the genre LUT dominates: bs_action_teal_orange_punch crushes shadows
// to near-black on dim Veo shots, reading as noir/B&W on screen even
// though the source clips look fine in the panel preview. Reported
// 2026-04-30 production test on action-genre story `4f24ebfa...`.
//
// The fix: when brandKit is null, derive a 3-color tonal palette from
// the genre's character (warmth, contrast direction, saturation register)
// using built-in presets that map each genre to a coherent "story-mood"
// palette. Caller passes this palette through `generateLutFromPalette`
// to produce a `gen_*` LUT that serves as the trim layer at low strength
// (0.10-0.20), softening the genre LUT's aggression.
//
// These presets are TONAL TRIMS — they pull the grade gently toward a
// genre-coherent direction (action: warm umber + cool steel; drama:
// gentle gold + soft shadow; horror: cool desaturation; etc.). They are
// NOT "brand-equivalent" — they're a fallback for stories without
// authored brand identity. When a brand_kit IS present, that path wins.

const _STORY_TONAL_TRIM_PRESETS_RAW = ({
  action: {
    description: 'Action genre tonal trim — warm umber shadow + cool steel highlight, balanced midtone. Tempers the teal/orange punch LUT toward a more naturalistic register.',
    targets: [
      [0.18, 0.13, 0.10],  // warm umber shadow
      [0.55, 0.50, 0.48],  // neutral midtone
      [0.78, 0.82, 0.86]   // cool steel highlight
    ],
    strength: 0.15
  },
  thriller: {
    description: 'Thriller — Fincher-amber lift + cool teal mid. Anchors faces against the genre LUT.',
    targets: [
      [0.18, 0.14, 0.10],
      [0.42, 0.50, 0.55],
      [0.70, 0.65, 0.55]
    ],
    strength: 0.15
  },
  drama: {
    description: 'Drama tonal trim — gentle gold warmth in skin midtone + soft natural shadow. Preserves face separation.',
    targets: [
      [0.20, 0.16, 0.12],
      [0.60, 0.50, 0.42],
      [0.85, 0.80, 0.72]
    ],
    strength: 0.12
  },
  romance: {
    description: 'Romance — warm Kodak Portra-style: cream highlight, peach midtone, rose shadow.',
    targets: [
      [0.30, 0.20, 0.20],
      [0.65, 0.50, 0.42],
      [0.92, 0.86, 0.78]
    ],
    strength: 0.18
  },
  horror: {
    description: 'Horror — cool desaturation, sickly green lift in shadow, pale highlight. Subtle to avoid genre-LUT amplification.',
    targets: [
      [0.10, 0.14, 0.12],
      [0.40, 0.45, 0.40],
      [0.78, 0.82, 0.78]
    ],
    strength: 0.12
  },
  noir: {
    description: 'Noir — silver midtones, cyan lift in shadow, paper-white highlight. Honors B&W tradition without crushing.',
    targets: [
      [0.10, 0.14, 0.18],
      [0.50, 0.50, 0.50],
      [0.90, 0.90, 0.88]
    ],
    strength: 0.12
  },
  mystery: {
    description: 'Mystery — same as noir tonal direction but slightly warmer for skin.',
    targets: [
      [0.12, 0.14, 0.16],
      [0.52, 0.48, 0.46],
      [0.86, 0.84, 0.80]
    ],
    strength: 0.12
  },
  comedy: {
    description: 'Comedy — bright clean highlights, neutral midtones, lifted shadow. Soften genre LUT toward Wes-Anderson-pastel range.',
    targets: [
      [0.30, 0.28, 0.25],
      [0.65, 0.62, 0.58],
      [0.95, 0.92, 0.88]
    ],
    strength: 0.10
  },
  fantasy: {
    description: 'Fantasy — emerald lift in shadow, warm highlight, painterly skin midtone.',
    targets: [
      [0.10, 0.18, 0.14],
      [0.55, 0.48, 0.40],
      [0.88, 0.84, 0.75]
    ],
    strength: 0.15
  },
  scifi: {
    description: 'Sci-Fi — cool clinical white, silver-cyan midtone, charcoal shadow.',
    targets: [
      [0.10, 0.12, 0.16],
      [0.50, 0.55, 0.60],
      [0.92, 0.94, 0.96]
    ],
    strength: 0.12
  },
  'sci-fi': null, // alias — resolved below
  period: {
    description: 'Period — sepia warmth in shadow, vintage-film highlight rolloff, kodachrome midtone saturation.',
    targets: [
      [0.22, 0.16, 0.10],
      [0.62, 0.52, 0.42],
      [0.90, 0.85, 0.72]
    ],
    strength: 0.15
  },
  documentary: {
    description: 'Documentary — minimal trim. Preserves source naturalism.',
    targets: [
      [0.18, 0.18, 0.18],
      [0.55, 0.55, 0.55],
      [0.85, 0.85, 0.85]
    ],
    strength: 0.05
  },
  inspirational: {
    description: 'Inspirational — golden hour lift in highlight, warm umber shadow.',
    targets: [
      [0.22, 0.16, 0.10],
      [0.65, 0.55, 0.42],
      [0.95, 0.88, 0.72]
    ],
    strength: 0.15
  },
  'slice-of-life': {
    description: 'Slice-of-life — naturalistic warm cast, gentle.',
    targets: [
      [0.20, 0.18, 0.15],
      [0.60, 0.55, 0.50],
      [0.88, 0.85, 0.80]
    ],
    strength: 0.10
  },
  adventure: {
    description: 'Adventure — outdoor warmth, sky-blue highlight, earthy shadow.',
    targets: [
      [0.18, 0.15, 0.10],
      [0.55, 0.50, 0.42],
      [0.78, 0.82, 0.88]
    ],
    strength: 0.13
  },
  commercial: {
    description: 'Commercial fallback — hyperreal punch with neutral skin protection.',
    targets: [
      [0.18, 0.15, 0.13],
      [0.62, 0.55, 0.50],
      [0.92, 0.90, 0.86]
    ],
    strength: 0.15
  }
});

// Resolve aliases AND freeze. We assign sci-fi before freezing so the frozen
// preset map is fully self-contained (no post-freeze mutation).
_STORY_TONAL_TRIM_PRESETS_RAW['sci-fi'] = _STORY_TONAL_TRIM_PRESETS_RAW.scifi;
const STORY_TONAL_TRIM_PRESETS = Object.freeze(_STORY_TONAL_TRIM_PRESETS_RAW);

const DEFAULT_STORY_TONAL_TRIM = STORY_TONAL_TRIM_PRESETS.drama;

/**
 * V4 hotfix 2026-04-30 — Generate a trim-layer LUT for stories WITHOUT a
 * brand_kit, derived from the story's genre and tonal register. This is
 * the "auto-LUT-from-story-content" path the user remembered:
 *
 *   - When brandKit IS provided → delegate to generateLutFromBrandKit.
 *   - When brandKit is null     → look up the genre's tonal-trim preset
 *                                  and synthesize a low-strength LUT from
 *                                  that 3-color palette. Output id starts
 *                                  with `gen_story_` so it's traceable in
 *                                  logs and post-production stage 3 reads.
 *
 * The synthesized LUT serves as the BRAND-PALETTE-TRIM EQUIVALENT — applied
 * as a SECOND pass on top of the genre creative LUT, gently tempering its
 * aggression. Without this trim layer, action-genre stories crush shadows
 * to near-black (the noir/B&W effect reported on story `4f24ebfa...`).
 *
 * @param {Object} params
 * @param {string} params.genre              - story genre (drama/action/horror/etc.)
 * @param {Object} [params.brandKit]         - optional; if present, takes precedence
 * @param {number} [params.strengthOverride] - optional explicit strength
 * @returns {Promise<{lutId: string, filePath: string, isGenerated: true, isStoryTrim?: boolean} | null>}
 */
export async function generateStoryTrimLut({ genre, brandKit = null, strengthOverride = null } = {}) {
  // brandKit wins when present.
  if (brandKit?.color_palette?.length) {
    return generateLutFromBrandKit(brandKit, { strength: strengthOverride });
  }

  const key = String(genre || '').toLowerCase().trim();
  const preset = STORY_TONAL_TRIM_PRESETS[key] || DEFAULT_STORY_TONAL_TRIM;

  if (!preset || !Array.isArray(preset.targets) || preset.targets.length === 0) {
    return null;
  }

  // Convert preset's normalized [r,g,b] targets to {hex} entries the
  // existing generator expects.
  const colorPalette = preset.targets.map(([r, g, b]) => {
    const hex = '#' +
      Math.round(r * 255).toString(16).padStart(2, '0') +
      Math.round(g * 255).toString(16).padStart(2, '0') +
      Math.round(b * 255).toString(16).padStart(2, '0');
    return { hex };
  });

  const strength = strengthOverride != null ? strengthOverride : preset.strength;

  const result = await generateLutFromPalette({
    colorPalette,
    strength,
    brandName: `story_trim_${key}`
  });

  if (result?.rejected) {
    logger.warn(`generateStoryTrimLut: tonal-trim palette rejected for genre=${key} — ${result.reason}`);
    return null;
  }
  if (result?.lutId) {
    // Re-tag the id for traceability — it's a story-derived trim, not a brand trim.
    return { ...result, isStoryTrim: true, genrePreset: key };
  }
  return null;
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

// ─────────────────────────────────────────────────────────────────────
// V4 Phase 7 — generative LUTs from style_category (non-photoreal bypass)
//
// Why: when CreativeBriefDirector picks a non-photoreal style_category
// (hand_doodle_animated, surreal_dreamlike, vaporwave_nostalgic,
// painterly_prestige), the photoreal genre LUT pool (`bs_commercial_*`,
// `bs_drama_*`, etc.) over-grades animated frames and pulls them back
// toward photoreal palette assumptions. The brief asked for cel-shaded;
// the LUT smashes it to "warm cinematic premium."
//
// generateLutFromStyleBrief() short-circuits the photoreal pipeline:
//   - hand_doodle_animated → identity LUT (pass-through; no grading)
//   - surreal_dreamlike    → near-identity warmth-cast (very mild)
//   - vaporwave_nostalgic  → magenta/teal duotone preset (the look IS the brief)
//   - painterly_prestige   → warm-shadow cool-highlight oil-painting cast
//
// All synthesized LUTs are written under assets/luts/generated/ with a
// `gen_style_<hash>` id, cached by sha256 of (style_category + variant
// settings). The LUT id starts with `gen_style_` so N7's genre-pool
// validator can whitelist them as a non-photoreal bypass id.
// ─────────────────────────────────────────────────────────────────────

/**
 * Built-in non-photoreal style presets. Each preset is a short list of RGB
 * targets (in [0,1]) plus a strength. Identity = empty targets + strength=0.
 *
 * NOTE: these are NOT brand colors — they are STYLE colors. The brand palette
 * doesn't enter here. Brand-palette tinting is a separate downstream pass
 * controlled by `generateLutFromBrandKit`.
 */
const STYLE_PRESETS = Object.freeze({
  hand_doodle_animated: {
    description: 'Identity LUT — cel-shaded animation should ship with no live-action grading. The art direction IS the look.',
    targets: [],          // empty → identity blend
    strength: 0.0
  },
  surreal_dreamlike: {
    description: 'Near-identity dream-warmth cast — subtle shadow lift toward magenta, highlight roll toward soft cream.',
    targets: [
      [0.18, 0.10, 0.20],  // shadow magenta lift
      [0.92, 0.86, 0.74]   // highlight cream roll
    ],
    strength: 0.10
  },
  vaporwave_nostalgic: {
    description: 'Magenta/teal duotone period artifact. The look IS the brief — let the LUT do real work.',
    targets: [
      [0.85, 0.20, 0.55],  // magenta highlight
      [0.10, 0.55, 0.65],  // teal midtone
      [0.05, 0.10, 0.18]   // deep blue shadow
    ],
    strength: 0.30
  },
  painterly_prestige: {
    description: 'Oil-painting cast — warm shadows (umber), cool desaturated highlights (linen). Painterly skin separation as INTENT.',
    targets: [
      [0.32, 0.20, 0.12],  // warm umber shadow
      [0.55, 0.45, 0.38],  // mid skin warmth
      [0.85, 0.82, 0.78]   // cool linen highlight
    ],
    strength: 0.18
  }
});

/**
 * Generate a style-aware LUT for a non-photoreal commercial brief.
 *
 * Returns a `gen_style_*` LUT id that:
 *   - the BrandKitLutMatcher waterfall picks BEFORE the photoreal genre pool
 *     (when isStylizedStrong / isNonPhotorealStyle is true)
 *   - the N7 genre-pool validator whitelists (gen_style_* prefix is the
 *     non-photoreal bypass marker; validator must skip pool membership check
 *     for these ids)
 *   - PostProduction applies at low strength (0.10) regardless of GENRE_STRENGTH
 *     table value (the matcher is responsible for that override)
 *
 * @param {Object} params
 * @param {string} params.style_category - one of NON_PHOTOREAL_STYLE_CATEGORIES
 * @param {string} [params.visual_style_brief] - free-form DP brief (cached as part of the key)
 * @param {Object} [params.brandKit] - optional; brand palette can be lightly mixed in
 *                                     for vaporwave_nostalgic (where brand color choice
 *                                     belongs in the duotone) but is IGNORED for
 *                                     hand_doodle_animated (identity).
 * @returns {Promise<{lutId: string, filePath: string, isGenerated: true, isStyleBypass: true} | null>}
 */
export async function generateLutFromStyleBrief({
  style_category,
  visual_style_brief = '',
  brandKit = null
} = {}) {
  const cat = String(style_category || '').toLowerCase().trim();
  const preset = STYLE_PRESETS[cat];
  if (!preset) {
    logger.warn(`generateLutFromStyleBrief: unknown style_category "${cat}" — caller should fall back to genre LUT pool`);
    return null;
  }

  // Identity LUT short-circuit — hand_doodle_animated wants NO grading. We still
  // emit a real .cube file (so PostProduction can apply lut3d uniformly through
  // its filter chain) but every entry is identity.
  const isIdentity = preset.targets.length === 0 || preset.strength === 0;

  // Cache key — style_category + brief_hash + brand_palette_hash. Identical inputs
  // reuse the same .cube file. The brief excerpt is included so a brief revision
  // produces a different LUT (callers that want immediate refresh on brief change
  // need this cache invalidation; otherwise the LUT would persist forever).
  const briefDigest = visual_style_brief
    ? crypto.createHash('sha256').update(visual_style_brief).digest('hex').slice(0, 8)
    : 'nobrief';
  const palDigest = brandKit?.color_palette?.length
    ? crypto.createHash('sha256').update(JSON.stringify(brandKit.color_palette)).digest('hex').slice(0, 8)
    : 'nopal';
  const cacheKey = crypto.createHash('sha256')
    .update(`${cat}::${briefDigest}::${palDigest}::${preset.strength.toFixed(3)}`)
    .digest('hex').slice(0, 16);
  const lutId = `gen_style_${cacheKey}`;
  const filename = `${lutId}.cube`;
  const fullPath = path.join(GENERATED_LUT_DIR, filename);

  if (fs.existsSync(fullPath)) {
    logger.info(`style-brief LUT cache hit: ${lutId} (style=${cat})`);
    return { lutId, filePath: fullPath, isGenerated: true, isStyleBypass: true, styleCategory: cat };
  }

  fs.mkdirSync(GENERATED_LUT_DIR, { recursive: true });

  // Compose the actual targets. For identity, leave empty — the writer below
  // emits identity entries. For vaporwave_nostalgic, optionally include the
  // brand's primary hex as an additional target so the duotone tracks the brand.
  let targets = preset.targets.slice();
  if (cat === 'vaporwave_nostalgic' && brandKit?.color_palette?.length) {
    const brandHex = brandKit.color_palette[0]?.hex || brandKit.color_palette[0];
    const brandRgb = hexToRgb01(brandHex);
    if (brandRgb) targets.push(brandRgb);
  }

  logger.info(`generating style-brief LUT (style=${cat}, strength=${preset.strength}, targets=${targets.length}, key=${cacheKey})`);

  const lines = [];
  lines.push(`# V4 Phase 7 style-brief LUT`);
  lines.push(`# style_category: ${cat}`);
  lines.push(`# strength: ${preset.strength.toFixed(3)}`);
  lines.push(`# description: ${preset.description}`);
  if (visual_style_brief) {
    lines.push(`# brief_excerpt: ${visual_style_brief.slice(0, 80).replace(/\n/g, ' ')}`);
  }
  lines.push(`TITLE "V4 Style LUT — ${cat}"`);
  lines.push(`LUT_3D_SIZE ${LUT_SIZE}`);
  lines.push(`DOMAIN_MIN 0.0 0.0 0.0`);
  lines.push(`DOMAIN_MAX 1.0 1.0 1.0`);

  if (isIdentity) {
    // Identity cube — every entry passes through unchanged. Still a valid
    // .cube file that ffmpeg's lut3d filter accepts; ensures the filter chain
    // is uniform across all stories.
    for (let bi = 0; bi < LUT_SIZE; bi++) {
      const bIn = bi / (LUT_SIZE - 1);
      for (let gi = 0; gi < LUT_SIZE; gi++) {
        const gIn = gi / (LUT_SIZE - 1);
        for (let ri = 0; ri < LUT_SIZE; ri++) {
          const rIn = ri / (LUT_SIZE - 1);
          lines.push(`${rIn.toFixed(6)} ${gIn.toFixed(6)} ${bIn.toFixed(6)}`);
        }
      }
    }
  } else {
    // Stylized cube — same gravitational-pull math as generateLutFromPalette,
    // but with style_category-specific TARGET COLORS instead of brand palette.
    // Skin-preservation gate runs to make sure the preset doesn't damage faces.
    const targetLumas = targets.map(luma);
    const skinCheck = validateSkinPreservation({ targets, strength: preset.strength });
    if (!skinCheck.ok) {
      // Style preset would damage faces — should never happen on the curated
      // presets, but defensive. Return identity-cube fallback rather than
      // ship the bad LUT.
      logger.warn(`style-brief LUT preset ${cat} failed skin check (${skinCheck.reason}) — falling back to identity`);
      for (let bi = 0; bi < LUT_SIZE; bi++) {
        const bIn = bi / (LUT_SIZE - 1);
        for (let gi = 0; gi < LUT_SIZE; gi++) {
          const gIn = gi / (LUT_SIZE - 1);
          for (let ri = 0; ri < LUT_SIZE; ri++) {
            const rIn = ri / (LUT_SIZE - 1);
            lines.push(`${rIn.toFixed(6)} ${gIn.toFixed(6)} ${bIn.toFixed(6)}`);
          }
        }
      }
    } else {
      for (let bi = 0; bi < LUT_SIZE; bi++) {
        const bIn = bi / (LUT_SIZE - 1);
        for (let gi = 0; gi < LUT_SIZE; gi++) {
          const gIn = gi / (LUT_SIZE - 1);
          for (let ri = 0; ri < LUT_SIZE; ri++) {
            const rIn = ri / (LUT_SIZE - 1);
            const out = applyPaletteBlend([rIn, gIn, bIn], targets, targetLumas, preset.strength);
            lines.push(`${out[0].toFixed(6)} ${out[1].toFixed(6)} ${out[2].toFixed(6)}`);
          }
        }
      }
    }
  }

  fs.writeFileSync(fullPath, lines.join('\n') + '\n');
  const sizeKB = (Buffer.byteLength(lines.join('\n')) / 1024).toFixed(1);
  logger.info(`style-brief LUT written: ${fullPath} (${sizeKB}KB, identity=${isIdentity})`);

  return { lutId, filePath: fullPath, isGenerated: true, isStyleBypass: true, styleCategory: cat };
}

/**
 * Predicate — returns true iff the lutId was synthesized by
 * generateLutFromStyleBrief() (and therefore should bypass N7's genre-pool
 * validator). Validators that enforce genre-pool membership should call this
 * first and skip the membership check when it returns true.
 */
export function isStyleBypassLutId(lutId) {
  return typeof lutId === 'string' && lutId.startsWith('gen_style_');
}
