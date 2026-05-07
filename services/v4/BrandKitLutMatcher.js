// services/v4/BrandKitLutMatcher.js
// V4 Brand Kit → LUT matcher (Spec system, single canonical path).
//
// matchByGenreAndMood() resolves a story's LUT in two stages:
//   (1) genre → genre LUT pool (sourced from library.json `creative[]`
//       entries with matching `genre`)
//   (2) within pool, pick the LUT whose mood_keywords overlap most with
//       the story's tone / mood / style descriptors.
// Brand identity is NOT used here — it flows to the brand-generative pass
// (services/v4/GenerativeLut.js) and is layered on top of the genre grade
// in PostProduction.
//
// Resolution waterfall (PostProduction time):
//   story.locked_lut_id > story.brand_kit_lut_id > episode.lut_id > safe fallback
//
// Safe fallback: bs_doc_natural_window (the documentary-grade neutral grade)
//
// V4 P1.2 (this commit): retired the legacy 8-LUT brand-vertical matcher.
// The dual-system flag (BRAND_STORY_LUT_SPEC_SYSTEM) and the LEGACY_SAFE_FALLBACK
// constant are gone. Per user 2026-04-29: older stories with persisted legacy
// ids resolve to the spec fallback rather than their original LUT. The render
// stays clean even though the original color identity is lost — a deliberate
// back-compat tradeoff in favor of single-source-of-truth.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import winston from 'winston';

import { callVertexGeminiJson } from './VertexGemini.js';
import { resolveSpecLutPath } from './LutSpecGenerator.js';
import { generateLutFromStyleBrief, isStyleBypassLutId } from './GenerativeLut.js';
import { isStylizedStrong, isNonPhotorealStyle, resolveStyleCategory } from './CreativeBriefDirector.js';

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
// Safe fallback — single canonical id for the spec system
// ─────────────────────────────────────────────────────────────────────

const SPEC_SAFE_FALLBACK = 'bs_doc_natural_window';

export function getSafeFallbackLutId() {
  return SPEC_SAFE_FALLBACK;
}

// V4 P1.2 — back-compat shim. isSpecSystemEnabled() is referenced by code
// outside this module (BrandStoryService) that branches on the flag. After
// the legacy delete the spec system is the only system, so this always
// returns true. Callers can be migrated and the shim removed in a follow-up.
export function isSpecSystemEnabled() {
  return true;
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

// V4 Phase 7 — non-photoreal LUT strength override. When style_category is
// non-photoreal, the live-action GENRE_STRENGTH table is the wrong calibration.
// The style preset itself does the work (cel-shade saturation boost, vaporwave
// duotone, painterly cast); the brand-palette overlay should be near-pass-through.
const STYLE_BYPASS_STRENGTH = 0.10;

/**
 * Resolve the LUT-pass strength taking style_category into account. Returns
 * STYLE_BYPASS_STRENGTH (0.10) for non-photoreal styles regardless of genre,
 * else falls through to the GENRE_STRENGTH table.
 *
 * @param {string} genre
 * @param {Object|null} brief - commercial_brief; when null, falls through
 * @returns {number} effective strength in [0,1]
 */
export function getStrengthForGenreWithStyle(genre, brief = null) {
  if (brief && isNonPhotorealStyle(brief)) {
    return STYLE_BYPASS_STRENGTH;
  }
  return getStrengthForGenre(genre);
}

export function isStyleBypassEnabled() {
  // Default ON. Set BRAND_STORY_LUT_STYLE_BYPASS=false to revert non-photoreal
  // styles to the photoreal genre LUT pool (Phase 6 pre-Phase-7 baseline).
  return String(process.env.BRAND_STORY_LUT_STYLE_BYPASS || 'true').toLowerCase() !== 'false';
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
    const correctionCount = (parsed.corrections || []).length;
    logger.info(`loaded LUT library: ${specCount} spec + ${correctionCount} corrections`);
    return LUT_LIBRARY;
  } catch (err) {
    logger.error(`failed to load LUT library: ${err.message}`);
    LUT_LIBRARY = { creative: [], corrections: [] };
    return LUT_LIBRARY;
  }
}

/**
 * Find a creative entry by id in the spec pool. V4 P1.2: legacy pool retired.
 */
function findEntry(lutId) {
  if (!lutId) return null;
  const lib = loadLutLibrary();
  const specMatch = (lib.creative || []).find(l => l.id === lutId);
  if (specMatch) return { entry: specMatch, kind: 'spec' };
  return null;
}

function getCreativePool() {
  const lib = loadLutLibrary();
  return (lib.creative || []).filter(l => l.spec);
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
// Public API — SPEC system (genre + mood)
// V4 P1.2: legacy matchBrandKitToLut() and the 8-LUT brand-vertical
// curated library have been retired. Single canonical resolution path.
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
 * V4 Phase 11 (2026-05-07) — story-level LUT family pool.
 *
 * For multi-episode prestige series, the LUT FAMILY is the show — episodes
 * MUST stay inside the family or the binge-format viewer reads "different
 * show" between episodes. Per Director Agent's mandate, story creation
 * declares a `lut_family_ids` array (subset of the creative pool) that
 * constrains every episode's pick to those family members. When unset, this
 * function falls through to the genre pool (existing behavior).
 *
 * Resolution:
 *   1. story.lut_family_ids is a non-empty array of strings → return the
 *      intersection with the creative pool (only known IDs survive).
 *   2. otherwise → genre pool (current behavior).
 *
 * Backwards-compatible: legacy stories without lut_family_ids see no change.
 *
 * @param {Object} story - { lut_family_ids?: string[], subject?: { genre }, storyline?: { genre } }
 * @returns {Array} LUT spec entries available for this story
 */
export function getStoryLutPool(story) {
  const family = story?.lut_family_ids;
  if (Array.isArray(family) && family.length > 0) {
    const pool = getCreativePool();
    const familySet = new Set(family.map(id => String(id).trim()).filter(Boolean));
    const filtered = pool.filter(l => familySet.has(l.id));
    if (filtered.length > 0) {
      logger.info(`getStoryLutPool: lut_family_ids active (${familySet.size} declared, ${filtered.length} resolved in pool)`);
      return filtered;
    }
    logger.warn(
      `getStoryLutPool: lut_family_ids declared but none resolved in creative pool — falling through to genre pool. ` +
      `Declared: [${family.join(', ')}]`
    );
  }
  const genre = story?.subject?.genre || story?.storyline?.genre || null;
  return getGenreLutPool(genre);
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

  // V4 Phase 5b — Fix 4 (commercial-only enhancement). When commercial_brief
  // is set, the brief's style_category + visual_style_brief excerpt become
  // additional mood inputs. NO HARDCODED style→LUT map (CLAUDE.md ground rule);
  // Gemini scores the mood-keyword overlap that already lives in library.json.
  // The brief simply enriches the mood signal so the matcher can converge on
  // the right commercial pool entry (hyperreal_premium → bs_commercial_hyperreal_punch,
  // gritty_real → bs_commercial_sundance_indie, etc.).
  const brief = story?.commercial_brief || null;
  const briefStyleCategory = brief?.style_category || '';
  const briefVisualStyle = (brief?.visual_style_brief || '').slice(0, 400);

  // V4 Phase 7 — non-photoreal LUT bypass. When the brief picks a non-photoreal
  // style_category (hand_doodle_animated, surreal_dreamlike, vaporwave_nostalgic,
  // painterly_prestige), the photoreal genre LUT pool is the WRONG calibration —
  // a hand_doodle_animated commercial graded with bs_commercial_hyperreal_punch
  // gets pulled back toward photoreal palette assumptions, defeating the brief.
  // Short-circuit to a synthesized style-aware LUT (gen_style_<hash>) instead.
  // The N7 genre-pool validator must whitelist gen_style_* ids — see
  // isStyleBypassLutId() in GenerativeLut.js.
  if (brief && isNonPhotorealStyle(brief) && isStyleBypassEnabled()) {
    try {
      const styleResult = await generateLutFromStyleBrief({
        style_category: resolveStyleCategory(brief),
        visual_style_brief: brief.visual_style_brief || '',
        brandKit: story?.brand_kit || null
      });
      if (styleResult?.lutId) {
        logger.info(`matchByGenreAndMood: style bypass → ${styleResult.lutId} (style=${styleResult.styleCategory})`);
        return {
          lutId: styleResult.lutId,
          justification: `Non-photoreal style bypass: style_category=${styleResult.styleCategory}; photoreal genre LUT pool would over-grade animated/illustrated frames.`
        };
      }
      logger.warn('matchByGenreAndMood: style bypass returned null — falling through to genre pool');
    } catch (err) {
      logger.error(`matchByGenreAndMood: style bypass failed (${err.message}) → falling through to genre pool`);
    }
  }

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
    aesthetic && `Aesthetic / motifs: ${aesthetic}`,
    // Fix 4 — brief-derived mood signal. Only present for commercial stories
    // with a brief; rendered identically to the other axes so the matcher
    // treats it as one more mood input (no hardcoded mapping).
    briefStyleCategory && `Brief style category: ${briefStyleCategory}`,
    briefVisualStyle && `Brief visual style: ${briefVisualStyle}`
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
 *
 * V4 Phase 5b — N7 genre-pool validation post-emission. Even with Fix 3 (the
 * legacy 8-LUT bypass deleted from the V4 prompt schema), Gemini may still
 * emit a non-genre-pool lut_id under retry / partial-JSON / cache-hit
 * conditions. Without validation, that wrong-pool emission drains through
 * the waterfall unchallenged (story `77d6eaaf` 2026-04-28 root cause:
 * commercial got bs_cool_noir from the legacy enum). When the spec system
 * is on AND a story-level genre is known, validate that the resolved id is
 * in the genre pool; if not, override with the genre default.
 *
 * Override fires only on Gemini-emitted ids (cases 3 + 4). User overrides
 * (case 1) and brandKit-derived caches (case 2) are NEVER overridden — the
 * user explicitly chose those, and the brandKit cache is a deliberate
 * cross-genre tonal choice.
 */
export function resolveEpisodeLut(story, episode) {
  if (story?.locked_lut_id) return story.locked_lut_id;
  if (story?.brand_kit_lut_id) return story.brand_kit_lut_id;

  const geminiEmitted = episode?.lut_id || episode?.scene_description?.lut_id || null;
  if (!geminiEmitted) return getSafeFallbackLutId();

  // V4 Phase 5b — validate against genre pool only when spec system is on.
  if (!isSpecSystemEnabled()) return geminiEmitted;

  // V4 Phase 7 — non-photoreal style bypass. When the brief is non-photoreal
  // AND the matcher emitted a gen_style_* id (synthesized from style brief),
  // the genre-pool validator MUST skip the membership check — these ids are
  // intentionally outside the photoreal genre pool because the genre pool
  // would over-grade animated/illustrated frames. See generateLutFromStyleBrief()
  // in GenerativeLut.js and isStyleBypassLutId().
  if (isStyleBypassLutId(geminiEmitted)) {
    return geminiEmitted;
  }

  const genre = story?.subject?.genre || story?.storyline?.genre || null;
  if (!genre) return geminiEmitted; // no pool resolvable → trust Gemini

  const pool = getGenreLutPool(genre);
  const inPool = pool.some(l => l.id === geminiEmitted);
  if (inPool) return geminiEmitted;

  // Out-of-pool emission. Override with the genre default + log warning so
  // the issue surfaces in production telemetry.
  const def = getDefaultLutForGenre(genre);
  const overrideId = def?.id || getSafeFallbackLutId();
  logger.warn(
    `resolveEpisodeLut: Gemini emitted lut_id "${geminiEmitted}" which is NOT in the ` +
    `${genre} genre pool (size=${pool.length}). Overriding with genre default "${overrideId}". ` +
    `This catches the legacy 8-LUT bypass + retry/cache-hit drift cases.`
  );
  return overrideId;
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
  GENRE_STRENGTH,
  SPEC_SAFE_FALLBACK
};
