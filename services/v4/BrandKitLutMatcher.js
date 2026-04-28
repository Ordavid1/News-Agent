// services/v4/BrandKitLutMatcher.js
// V4 Brand Kit → LUT matcher.
//
// Two coexisting systems (gated by env BRAND_STORY_LUT_SPEC_SYSTEM):
//
//   ▸ LEGACY (default — spec system OFF):
//     matchBrandKitToLut() asks Gemini to pick from 8 hand-graded LUTs by
//     brand-vertical and mood. Cached on story.brand_kit_lut_id at story
//     creation. This preserves existing behavior for in-flight stories.
//
//   ▸ SPEC (new — spec system ON):
//     matchByGenreAndMood() resolves a story's LUT in two stages:
//       (1) genre → genre LUT pool (sourced from library.json `creative[]`
//           entries with matching `genre`)
//       (2) within pool, pick the LUT whose mood_keywords overlap most with
//           the story's tone / mood / style descriptors.
//     Brand identity is NOT used here — it flows to the brand-generative pass
//     (services/v4/GenerativeLut.js) and is layered on top of the genre grade
//     in PostProduction (Phase 2 of this redesign).
//
// Resolution waterfall (PostProduction time, both systems):
//   story.locked_lut_id > story.brand_kit_lut_id > episode.lut_id > safe fallback
//
// Safe fallback:
//   - SPEC ON  → bs_doc_natural_window (the documentary-grade neutral grade)
//   - SPEC OFF → bs_naturalistic (legacy neutral grade)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import winston from 'winston';

import { callVertexGeminiJson } from './VertexGemini.js';
import { resolveSpecLutPath } from './LutSpecGenerator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `[BrandKitLutMatcher] ${timestamp} [${level}]: ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

// ─────────────────────────────────────────────────────────────────────
// Feature flags + safe fallbacks
// ─────────────────────────────────────────────────────────────────────

export function isSpecSystemEnabled() {
  // Default ON (Phase 1 GA, 2026-04-28). Set BRAND_STORY_LUT_SPEC_SYSTEM=false
  // to revert to the legacy 8-LUT library matcher.
  return String(process.env.BRAND_STORY_LUT_SPEC_SYSTEM || 'true').toLowerCase() !== 'false';
}

const LEGACY_SAFE_FALLBACK = 'bs_naturalistic';
const SPEC_SAFE_FALLBACK = 'bs_doc_natural_window';

export function getSafeFallbackLutId() {
  return isSpecSystemEnabled() ? SPEC_SAFE_FALLBACK : LEGACY_SAFE_FALLBACK;
}

// Per-genre default strength for the brand generative LUT pass (Phase 2).
// Lower strength preserves face/skin separation; higher strength lets the
// brand identity dominate. Documentary at 0.10, action at 0.30 max default.
//
// 2026-04-28: commercial dropped 0.50 → 0.25. The 0.50 default produced
// inter-beat color cliffs in commercial spots (logs.txt root cause: combined
// with bs_commercial_hyperreal_punch's already-saturated grade, 0.50 brand
// pull amplified per-beat color shifts into visible "color → B&W → color"
// transitions across cuts). 0.25 keeps brand identity visible without
// destabilizing the source-frame color profile.
const GENRE_STRENGTH = Object.freeze({
  documentary: 0.10,
  noir:        0.15,
  drama:       0.18,
  period:      0.20,
  horror:      0.20,
  romance:     0.22,
  thriller:    0.25,
  commercial:  0.25,
  action:      0.30,
  'sci-fi':    0.30,
  scifi:       0.30,
  fantasy:     0.30,
  comedy:      0.35
});

const DEFAULT_GENRE_STRENGTH = 0.20;

export function getStrengthForGenre(genre) {
  if (!genre) return DEFAULT_GENRE_STRENGTH;
  const key = String(genre).toLowerCase().trim();
  if (Object.prototype.hasOwnProperty.call(GENRE_STRENGTH, key)) {
    return GENRE_STRENGTH[key];
  }
  return DEFAULT_GENRE_STRENGTH;
}

// ─────────────────────────────────────────────────────────────────────
// Library loader
// ─────────────────────────────────────────────────────────────────────

let LUT_LIBRARY = null;

function loadLutLibrary() {
  if (LUT_LIBRARY) return LUT_LIBRARY;
  const libraryPath = path.join(__dirname, '..', '..', 'assets', 'luts', 'library.json');
  try {
    const raw = fs.readFileSync(libraryPath, 'utf-8');
    const parsed = JSON.parse(raw);
    LUT_LIBRARY = parsed;
    const specCount = (parsed.creative || []).filter(l => l.spec).length;
    const legacyCount = (parsed.creative_legacy || []).length;
    const correctionCount = (parsed.corrections || []).length;
    logger.info(`loaded LUT library: ${specCount} spec + ${legacyCount} legacy + ${correctionCount} corrections`);
    return LUT_LIBRARY;
  } catch (err) {
    logger.error(`failed to load LUT library: ${err.message}`);
    LUT_LIBRARY = { creative: [], creative_legacy: [], corrections: [] };
    return LUT_LIBRARY;
  }
}

/**
 * Find any creative entry by id across both spec and legacy pools.
 */
function findEntry(lutId) {
  if (!lutId) return null;
  const lib = loadLutLibrary();
  const specMatch = (lib.creative || []).find(l => l.id === lutId);
  if (specMatch) return { entry: specMatch, kind: 'spec' };
  const legacyMatch = (lib.creative_legacy || []).find(l => l.id === lutId);
  if (legacyMatch) return { entry: legacyMatch, kind: 'legacy' };
  return null;
}

function getCreativePool() {
  const lib = loadLutLibrary();
  return (lib.creative || []).filter(l => l.spec);
}

function getLegacyPool() {
  const lib = loadLutLibrary();
  return lib.creative_legacy || [];
}

// ─────────────────────────────────────────────────────────────────────
// Gemini helper
// ─────────────────────────────────────────────────────────────────────

async function callGeminiJson(systemPrompt, userPrompt) {
  return callVertexGeminiJson({
    systemPrompt,
    userPrompt,
    config: { temperature: 0.3, maxOutputTokens: 4096 },
    timeoutMs: 60000
  });
}

// ─────────────────────────────────────────────────────────────────────
// Public API — LEGACY system
// ─────────────────────────────────────────────────────────────────────

/**
 * Match a Brand Kit to one LUT from the legacy 8-LUT curated library.
 * Used when BRAND_STORY_LUT_SPEC_SYSTEM is OFF.
 */
export async function matchBrandKitToLut(brandKit) {
  if (!brandKit) {
    logger.warn('matchBrandKitToLut: null brandKit → safe fallback');
    return { lutId: LEGACY_SAFE_FALLBACK, justification: 'No brand kit available' };
  }

  const legacyLuts = getLegacyPool();
  if (legacyLuts.length === 0) {
    logger.error('legacy LUT pool is empty');
    return { lutId: LEGACY_SAFE_FALLBACK, justification: 'Legacy LUT pool empty' };
  }

  const lutChoices = legacyLuts.map(l =>
    `  - ${l.id}: ${l.look}. Suits: ${(l.suits_brand_types || []).join(', ')}. Mood: ${(l.mood_keywords || []).join(', ')}.`
  ).join('\n');

  const colorPalette = (brandKit.color_palette || []).slice(0, 5).map(c => c.hex || c.name).filter(Boolean);
  const brandContext = [
    brandKit.brand_summary && `Brand summary: ${brandKit.brand_summary}`,
    brandKit.style_characteristics?.overall_aesthetic && `Aesthetic: ${brandKit.style_characteristics.overall_aesthetic}`,
    brandKit.style_characteristics?.mood && `Mood: ${brandKit.style_characteristics.mood}`,
    brandKit.style_characteristics?.visual_motifs && `Visual motifs: ${brandKit.style_characteristics.visual_motifs}`,
    colorPalette.length > 0 && `Brand colors: ${colorPalette.join(', ')}`
  ].filter(Boolean).join('\n');

  if (!brandContext) {
    logger.warn('matchBrandKitToLut: brandKit has no usable fields → safe fallback');
    return { lutId: LEGACY_SAFE_FALLBACK, justification: 'Brand kit has no usable fields' };
  }

  const systemPrompt = `You are a colorist picking the right color grade (LUT) for a branded short film.
Given a brand's identity — its color palette, mood, aesthetic, and visual motifs — pick the ONE LUT
from the curated library that best matches. The LUT will be applied to every episode of this story,
so pick something that represents the brand across a whole season, not just one scene.

Respond with ONLY this JSON:
{
  "lut_id": "the exact id string from the library below",
  "justification": "1-sentence reason why this LUT fits the brand"
}

CURATED LUT LIBRARY:
${lutChoices}`;

  const userPrompt = `Brand context:\n\n${brandContext}\n\nPick the best LUT.`;

  logger.info('matching brand kit to legacy LUT...');
  let result;
  try {
    result = await callGeminiJson(systemPrompt, userPrompt);
  } catch (err) {
    logger.error(`Gemini LUT matching failed: ${err.message} → safe fallback`);
    return { lutId: LEGACY_SAFE_FALLBACK, justification: `Gemini matching failed: ${err.message}` };
  }

  const match = legacyLuts.find(l => l.id === result.lut_id);
  if (!match) {
    logger.warn(`Gemini picked unknown lut_id "${result.lut_id}" → safe fallback`);
    return { lutId: LEGACY_SAFE_FALLBACK, justification: `Gemini picked unknown LUT "${result.lut_id}"` };
  }

  logger.info(`matched brand → ${match.id} (${match.look})`);
  return { lutId: match.id, justification: result.justification || match.look };
}

// ─────────────────────────────────────────────────────────────────────
// Public API — SPEC system (genre + mood)
// ─────────────────────────────────────────────────────────────────────

/**
 * Build the genre LUT pool. Filters spec entries by genre. If no entries
 * match the requested genre, returns the entire spec pool (so Gemini still
 * has something to pick from).
 */
export function getGenreLutPool(genre) {
  const all = getCreativePool();
  if (!genre) return all;
  const key = String(genre).toLowerCase().trim();
  const filtered = all.filter(l => String(l.genre || '').toLowerCase().trim() === key);
  return filtered.length > 0 ? filtered : all;
}

/**
 * Get the default LUT for a genre (the entry marked is_default_for_genre).
 * Returns null if no default exists for that genre.
 */
export function getDefaultLutForGenre(genre) {
  const pool = getGenreLutPool(genre);
  return pool.find(l => l.is_default_for_genre) || pool[0] || null;
}

/**
 * Match a story's LUT by genre + mood overlap. This is the SPEC-system entry
 * point used when BRAND_STORY_LUT_SPEC_SYSTEM is ON.
 *
 * Stage 1: genre → pool of candidate LUTs.
 * Stage 2: pool → single best LUT by mood-keyword overlap with story tone.
 *
 * Brand identity is NOT consulted here — it goes to the brand-generative pass
 * in PostProduction (Phase 2). Genre owns the cinematic register; brand owns
 * the tonal trim.
 *
 * @param {Object} story - { storyline?: {genre, tone, ...}, subject?: {genre, tone}, ... }
 * @returns {Promise<{ lutId: string, justification: string }>}
 */
export async function matchByGenreAndMood(story) {
  const genre = story?.subject?.genre || story?.storyline?.genre || null;
  const tone = story?.subject?.tone || story?.storyline?.tone || '';
  const mood = story?.subject?.mood || story?.storyline?.mood || '';
  const aesthetic = story?.brand_kit?.style_characteristics?.overall_aesthetic
    || story?.storyline?.visual_motifs || '';

  const pool = getGenreLutPool(genre);
  if (pool.length === 0) {
    logger.warn(`matchByGenreAndMood: empty pool for genre="${genre}" → safe fallback`);
    return { lutId: SPEC_SAFE_FALLBACK, justification: 'Empty genre pool' };
  }

  // Single-entry pool — return it directly, no Gemini call.
  if (pool.length === 1) {
    const only = pool[0];
    logger.info(`matchByGenreAndMood: only one LUT in genre="${genre}" pool → ${only.id}`);
    return { lutId: only.id, justification: `Sole LUT for genre ${genre}: ${only.look}` };
  }

  // Multi-entry pool — let Gemini score mood overlap. Cheap call, low temperature.
  const lutChoices = pool.map(l =>
    `  - ${l.id}: ${l.look}. Mood: ${(l.mood_keywords || []).join(', ')}. Reference: ${(l.reference_films || []).join(', ')}.`
  ).join('\n');

  const storyContext = [
    genre && `Genre: ${genre}`,
    tone && `Tone: ${tone}`,
    mood && `Mood: ${mood}`,
    aesthetic && `Aesthetic / motifs: ${aesthetic}`
  ].filter(Boolean).join('\n') || 'No tone/mood available — pick the genre default.';

  const systemPrompt = `You are a colorist picking the cinematic look (LUT) for a story.
The genre is fixed. Pick the ONE LUT from the pool below whose mood keywords overlap most with the story's tone and aesthetic.
Brand identity is NOT your concern here — that is handled separately. Focus on emotional register and lighting motivation.

Respond with ONLY this JSON:
{
  "lut_id": "<exact id from the pool below>",
  "justification": "<1 sentence: why this LUT fits the tone>"
}

CANDIDATE LUTS (genre = ${genre || 'unknown'}):
${lutChoices}`;

  const userPrompt = `Story context:\n\n${storyContext}\n\nPick the best LUT.`;

  let result;
  try {
    result = await callGeminiJson(systemPrompt, userPrompt);
  } catch (err) {
    logger.error(`matchByGenreAndMood Gemini call failed: ${err.message} → genre default`);
    const def = getDefaultLutForGenre(genre);
    return { lutId: def?.id || SPEC_SAFE_FALLBACK, justification: `Gemini failed; defaulted to genre primary` };
  }

  const match = pool.find(l => l.id === result.lut_id);
  if (!match) {
    logger.warn(`matchByGenreAndMood: Gemini picked unknown lut "${result.lut_id}" → genre default`);
    const def = getDefaultLutForGenre(genre);
    return { lutId: def?.id || SPEC_SAFE_FALLBACK, justification: 'Unknown lut from Gemini; defaulted' };
  }

  logger.info(`matched genre/mood → ${match.id}`);
  return { lutId: match.id, justification: result.justification || match.look };
}

// ─────────────────────────────────────────────────────────────────────
// Resolution waterfall + path resolution (used by PostProduction)
// ─────────────────────────────────────────────────────────────────────

/**
 * Resolve the LUT for an episode. Same waterfall under both systems —
 * the only difference is the safe fallback id.
 *
 *   1. story.locked_lut_id   (user override)
 *   2. story.brand_kit_lut_id (cached match)
 *   3. episode.lut_id         (per-episode pick)
 *   4. episode.scene_description.lut_id (V4 Gemini emission location)
 *   5. system safe fallback
 */
export function resolveEpisodeLut(story, episode) {
  if (story?.locked_lut_id) return story.locked_lut_id;
  if (story?.brand_kit_lut_id) return story.brand_kit_lut_id;
  if (episode?.lut_id) return episode.lut_id;
  if (episode?.scene_description?.lut_id) return episode.scene_description.lut_id;
  return getSafeFallbackLutId();
}

/**
 * Get the absolute filesystem path for a LUT id. Recognizes:
 *   1. Generated brand LUTs (prefix "gen_") → assets/luts/generated/{id}.cube
 *   2. Spec LUTs (entry has .spec)         → generated on demand to assets/luts/generated_genre/
 *   3. Legacy curated LUTs (entry has .file) → assets/luts/{file}
 *
 * Returns null when not found / not on disk (PostProduction passes through
 * the video ungraded in that case).
 */
export function getLutFilePath(lutId) {
  if (!lutId) return null;

  // Brand-generative LUTs (palette synthesis, Phase 2)
  if (lutId.startsWith('gen_')) {
    const generatedPath = path.join(__dirname, '..', '..', 'assets', 'luts', 'generated', `${lutId}.cube`);
    if (fs.existsSync(generatedPath)) return generatedPath;
    logger.warn(`generated LUT file missing on disk: ${generatedPath}`);
    return null;
  }

  // Look up the entry in either pool.
  const found = findEntry(lutId);
  if (!found) {
    logger.warn(`unknown lut id: ${lutId}`);
    return null;
  }

  if (found.kind === 'spec') {
    // Spec entries — generate on demand (cached on disk by spec hash).
    const cubePath = resolveSpecLutPath(found.entry);
    if (!cubePath) {
      logger.warn(`spec LUT generation failed for ${lutId}`);
      return null;
    }
    return cubePath;
  }

  // Legacy entries — direct file path.
  const fullPath = path.join(__dirname, '..', '..', 'assets', 'luts', found.entry.file);
  if (!fs.existsSync(fullPath)) {
    logger.warn(`legacy LUT file missing on disk: ${fullPath}`);
    return null;
  }
  return fullPath;
}

/**
 * Per-model correction LUT (unchanged from legacy — used by PostProduction
 * stage 1 to neutralize each AI video model's color science before the
 * unified creative grade is applied).
 */
export function getCorrectionLutForModel(modelUsed) {
  if (!modelUsed) return null;
  const library = loadLutLibrary();
  const corrections = library.corrections || [];

  const lowered = modelUsed.toLowerCase();
  for (const c of corrections) {
    const prefixes = c.applies_to_model_prefix || [];
    if (prefixes.some(p => lowered.includes(p.toLowerCase()))) {
      const fullPath = path.join(__dirname, '..', '..', 'assets', 'luts', c.file);
      if (fs.existsSync(fullPath)) return fullPath;
      logger.warn(`correction LUT missing on disk: ${fullPath}`);
      return null;
    }
  }
  return null;
}

// Test / diagnostic exports
export const _internals = {
  loadLutLibrary,
  findEntry,
  getCreativePool,
  getLegacyPool,
  GENRE_STRENGTH,
  LEGACY_SAFE_FALLBACK,
  SPEC_SAFE_FALLBACK
};
