// services/v4/BrandKitLutMatcher.js
// V4 Brand Kit → LUT matcher.
//
// Closes the loop on brand identity: the same Brand Kit that drives persona
// auto-generation and storyline context ALSO drives the episode color grade.
// One source of truth for brand identity → end-to-end visual consistency.
//
// Flow (runs ONCE at story creation):
//   1. Story has a brand_kit_job_id → load the brand_kit object
//   2. Extract color_palette + style_characteristics.mood + overall_aesthetic
//   3. Ask Gemini to pick the closest LUT from our curated library of 8
//   4. Cache the result on story.brand_kit_lut_id
//   5. Every episode in that story uses it (brand consistency across the season)
//
// If the story has NO brand kit: Gemini picks a LUT per episode inside the
// V4 screenplay prompt instead (episode.lut_id field).
//
// Resolution waterfall (at post-production time):
//   story.locked_lut_id > story.brand_kit_lut_id > episode.lut_id > bs_naturalistic (fallback)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import winston from 'winston';

import { callVertexGeminiJson } from './VertexGemini.js';

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

const SAFE_FALLBACK_LUT_ID = 'bs_naturalistic';

// Load the LUT library once at module load
let LUT_LIBRARY = null;
function loadLutLibrary() {
  if (LUT_LIBRARY) return LUT_LIBRARY;
  const libraryPath = path.join(__dirname, '..', '..', 'assets', 'luts', 'library.json');
  try {
    const raw = fs.readFileSync(libraryPath, 'utf-8');
    const parsed = JSON.parse(raw);
    LUT_LIBRARY = parsed;
    logger.info(`loaded LUT library: ${parsed.creative?.length || 0} creative + ${parsed.corrections?.length || 0} corrections`);
    return LUT_LIBRARY;
  } catch (err) {
    logger.error(`failed to load LUT library: ${err.message}`);
    LUT_LIBRARY = { creative: [], corrections: [] };
    return LUT_LIBRARY;
  }
}

// All Gemini calls route through services/v4/VertexGemini.js (Vertex AI, not
// AI Studio). The legacy callGeminiJson() wrapper below is preserved to keep
// local call-sites concise.
//
// Token budget: bumped 500 → 4096 on Day 0 (2026-04-11) after the VoiceAcquisition
// path hit MAX_TOKENS truncation on Gemini 3 Flash Preview. Gemini 3 Flash uses
// configurable reasoning tokens that consume the output budget before the
// visible response starts — a 500-token cap means the thinking phase eats the
// entire budget and the JSON is either truncated or never emitted. 4096 gives
// room for thinking + the short LUT-pick JSON response.

async function callGeminiJson(systemPrompt, userPrompt) {
  return callVertexGeminiJson({
    systemPrompt,
    userPrompt,
    config: {
      temperature: 0.3,
      maxOutputTokens: 4096
    },
    timeoutMs: 60000
  });
}

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

/**
 * Match a Brand Kit to one LUT from the curated library.
 *
 * @param {Object} brandKit - the brand_kit object from media_training_jobs
 *   (uses: color_palette, style_characteristics.mood, style_characteristics.overall_aesthetic, brand_summary)
 * @returns {Promise<{lutId: string, justification: string}>}
 */
export async function matchBrandKitToLut(brandKit) {
  if (!brandKit) {
    logger.warn('matchBrandKitToLut: null brandKit → returning safe fallback');
    return { lutId: SAFE_FALLBACK_LUT_ID, justification: 'No brand kit available' };
  }

  const library = loadLutLibrary();
  const creativeLuts = library.creative || [];
  if (creativeLuts.length === 0) {
    logger.error('LUT library has no creative LUTs');
    return { lutId: SAFE_FALLBACK_LUT_ID, justification: 'LUT library empty' };
  }

  // Build compact LUT choices for Gemini's prompt
  const lutChoices = creativeLuts.map(l =>
    `  - ${l.id}: ${l.look}. Suits: ${l.suits_brand_types.join(', ')}. Mood: ${l.mood_keywords.join(', ')}.`
  ).join('\n');

  // Build brand context from the brand kit
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
    return { lutId: SAFE_FALLBACK_LUT_ID, justification: 'Brand kit has no usable fields' };
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

  const userPrompt = `Brand context:

${brandContext}

Pick the best LUT.`;

  logger.info(`matching brand kit to LUT...`);
  let result;
  try {
    result = await callGeminiJson(systemPrompt, userPrompt);
  } catch (err) {
    logger.error(`Gemini LUT matching failed: ${err.message} → safe fallback`);
    return { lutId: SAFE_FALLBACK_LUT_ID, justification: `Gemini matching failed: ${err.message}` };
  }

  // Validate Gemini picked a real LUT from the library
  const match = creativeLuts.find(l => l.id === result.lut_id);
  if (!match) {
    logger.warn(`Gemini picked unknown lut_id "${result.lut_id}" → safe fallback`);
    return { lutId: SAFE_FALLBACK_LUT_ID, justification: `Gemini picked unknown LUT "${result.lut_id}"` };
  }

  logger.info(`matched brand → ${match.id} (${match.look})`);
  return {
    lutId: match.id,
    justification: result.justification || match.look
  };
}

/**
 * Resolve the LUT for an episode using the V4 three-way waterfall.
 *
 *   1. story.locked_lut_id  (user override from wizard)
 *   2. story.brand_kit_lut_id  (cached brand-kit match)
 *   3. episode.lut_id  (per-episode Gemini pick when no brand kit)
 *   4. bs_naturalistic  (safe fallback)
 *
 * @param {Object} story
 * @param {Object} episode
 * @returns {string} resolved LUT id
 */
export function resolveEpisodeLut(story, episode) {
  if (story?.locked_lut_id) return story.locked_lut_id;
  if (story?.brand_kit_lut_id) return story.brand_kit_lut_id;
  if (episode?.lut_id) return episode.lut_id;

  // Also check scene_description.lut_id which is where the V4 Gemini prompt emits it
  if (episode?.scene_description?.lut_id) return episode.scene_description.lut_id;

  return SAFE_FALLBACK_LUT_ID;
}

/**
 * Get the absolute filesystem path for a LUT id.
 * Returns null if the LUT isn't in the library OR if the file doesn't exist
 * on disk (graceful fallback — the post-production pipeline skips LUT when null).
 *
 * Recognizes two LUT id namespaces:
 *   1. Curated library entries (e.g. "bs_warm_cinematic") → assets/luts/{file}
 *   2. Generated LUTs (prefix "gen_") → assets/luts/generated/{lutId}.cube
 *      These come from GenerativeLut.generateLutFromPalette() at story creation
 *      and are cached on disk indefinitely (idempotent: same palette+strength
 *      → same cache key → same file).
 *
 * @param {string} lutId
 * @returns {string|null}
 */
export function getLutFilePath(lutId) {
  if (!lutId) return null;

  // Generated LUT path (Phase 2)
  if (lutId.startsWith('gen_')) {
    const generatedPath = path.join(__dirname, '..', '..', 'assets', 'luts', 'generated', `${lutId}.cube`);
    if (fs.existsSync(generatedPath)) return generatedPath;
    logger.warn(`generated LUT file missing on disk: ${generatedPath}`);
    return null;
  }

  // Curated library path
  const library = loadLutLibrary();
  const entry = (library.creative || []).find(l => l.id === lutId);
  if (!entry) return null;

  const fullPath = path.join(__dirname, '..', '..', 'assets', 'luts', entry.file);
  if (!fs.existsSync(fullPath)) {
    logger.warn(`LUT file missing on disk: ${fullPath} (drop real .cube files into assets/luts/ to activate grading)`);
    return null;
  }
  return fullPath;
}

/**
 * Get the per-model correction LUT path for a given beat.model_used string.
 * Returns null if no correction applies (and the post-production pipeline
 * skips the correction pass for that beat).
 *
 * @param {string} modelUsed - e.g. "mode-b/kling-o3-omni+sync-lipsync-v3"
 * @returns {string|null}
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
