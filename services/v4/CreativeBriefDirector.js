// services/v4/CreativeBriefDirector.js
// V4 Phase 6 — pre-screenplay creative brief generator for the COMMERCIAL genre.
//
// Why: a generic Gemini screenplay-writer fed a brand kit + product produces
// generic ad copy. With a director's CREATIVE BRIEF in front of it — the
// concept, the visual signature, the narrative grammar, the music intent, the
// tagline — the same writer produces Honda "Cog" or Nike "Dream Crazy"-caliber
// work.
//
// The brief runs ONCE per commercial story, before the screenplay generator.
// DirectorAgent.judgeCommercialBrief() then validates the brief; if it fails
// the rubric, we re-run the brief with the director's nudge before any
// screenplay tokens are spent.
//
// The brief also justifies the EPISODE COUNT (1 or 2). Mirrors the existing
// prestige-story justification flow; for COMMERCIAL the count is hard-capped
// at 2 (vs prestige 3-12).

import winston from 'winston';
import { callVertexGeminiJson } from './VertexGemini.js';
import {
  COMMERCIAL_STYLE_CATEGORIES,
  formatReferenceLibraryForPrompt
} from './director-rubrics/commercialReferenceLibrary.mjs';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) =>
      `[CreativeBriefDirector] ${timestamp} [${level}]: ${message}`
    )
  ),
  transports: [new winston.transports.Console()]
});

const SYSTEM_PROMPT = `You are an Oscar-, Cannes Lion-, and Emmy-winning commercial DIRECTOR.
Your client has a brand kit and a product. They want a 30-60s spot — at most a
60s hero spot + a 30s angle (TWO episodes max). Your job, BEFORE a screenplay
is written, is to author the CREATIVE BRIEF that the screenplay writer will
follow. This is the difference between generic ad copy and Honda "Cog" /
Nike "Dream Crazy" / Apple "1984"-caliber work.

You return a JSON object with EXACTLY this shape (no extra keys):

  {
    "creative_concept":          "<one-line concept that fits on a sticky note>",
    "visual_signature":          "<the ONE visual idea an art director could re-quote>",
    "style_category":            "<one of: ${COMMERCIAL_STYLE_CATEGORIES.join(' | ')}>",
    "narrative_grammar":         {
      "form":              "<montage | single-take | dialogue-driven | silent | abstract | direct-address | mixed-media>",
      "dialogue_density":  "<high | medium | low | none>"
    },
    "emotional_arc":             "<wonder→epiphany | longing→fulfillment | doubt→conviction | etc>",
    "hero_image":                "<the single image we want burned into the viewer's memory>",
    "music_intent":              { "vibe": "<text>", "drop_point_seconds": <number>, "instrumentation": "<text>" },
    "cliffhanger_style":         "<tagline_reveal | unanswered_question | cta | brand_stamp_only>",
    "visual_style_brief":        "<full DP brief: color targets, contrast direction, lighting key, lens choice, grain/texture, framing language>",
    "reference_commercials":     ["<title>", "<title>", "<title>"],
    "episode_count_justification": {
      "count": 1,
      "reasoning": "<why 1 episode is sufficient OR why a 2-episode campaign is needed (ep1 = 60s hero / ep2 = 30s angle, sharing brand_world_lock)>"
    },
    "brand_world_lock_if_two_eps": "<only when count == 2: the LUT family + casting + signature optic that ep2 must inherit from ep1 verbatim>",
    "anti_brief":                "<what this commercial is NOT — the cliché it consciously rejects>"
  }

CRAFT PRINCIPLES:

  1. ONE concept. Pick the strongest single idea and commit. A great commercial has
     one mind in it.

  2. Maximum creative bravery. Risk = differentiation. If your brief reads "safe",
     start over.

  3. Brand recall comes from a single visual signature, not from feature lists.
     The viewer will remember ONE image — make it the right one.

  4. Episode count: cap is 2. Default to 1 unless a second angle adds something
     the first cannot. When 2, ep1 is the hero piece (60s), ep2 is the angle (30s)
     — independently watchable, sharing brand_world_lock.

  5. Music drops on the visual beat that EARNS it (product reveal, hero gesture,
     tagline land). Silence is louder than sound at the right moment.

  6. Tagline lands in the FINAL 2 seconds, not throughout. Brand stamp + tagline
     must feel inevitable, not slapped on.

  7. Product role: woven into the thesis (Honda Cog) → very strong. Tool for the
     hero (Beats by Dre) → strong. Stapled to the end (most spots) → weak.

  8. The "anti_brief" is the cliché you refuse. State it plainly. ("This is NOT
     a slow-motion smiling family. This is NOT a lifestyle shot of yoga at sunrise.")

REFERENCE LIBRARY — match the bar of these spots:
${formatReferenceLibraryForPrompt({ limit: 8 })}

OUTPUT: ONLY the JSON described above. No prose, no markdown, no commentary.`;

function buildUserPrompt({ story, brandKit, personas }) {
  const personaSummary = (personas || []).map((p, i) =>
    `  - Persona ${i}: archetype=${p?.dramatic_archetype || p?.archetype || '—'}, wardrobe="${p?.wardrobe_hint || '—'}"`
  ).join('\n') || '  - (no personas defined)';

  return `STORY CONTEXT:
- Brand:           ${story?.name || '—'}
- User prompt:     ${story?.user_prompt || '—'}
- Subject:         ${story?.subject?.name || '—'}
- Subject category:${story?.subject?.category || '—'}
- Subject visual:  ${story?.subject?.visual_description || '—'}
- Target audience: ${story?.target_audience || story?.subject?.target_audience || '—'}
- Tone hint:       ${story?.subject?.tone || '—'}

BRAND KIT:
- Brand summary:   ${brandKit?.brand_summary || '—'}
- Mood:            ${brandKit?.style_characteristics?.mood || '—'}
- Aesthetic:       ${brandKit?.style_characteristics?.overall_aesthetic || '—'}
- Visual motifs:   ${brandKit?.style_characteristics?.visual_motifs || '—'}
- Palette:         ${(brandKit?.color_palette || []).slice(0, 6).map(c => c.hex || c.name).filter(Boolean).join(', ') || '—'}

PERSONAS:
${personaSummary}

Author the COMMERCIAL CREATIVE BRIEF now.`;
}

/**
 * Generate the commercial creative brief for a story. Called BEFORE the
 * screenplay writer in the COMMERCIAL pipeline path.
 *
 * @param {Object} params
 * @param {Object} params.story
 * @param {Object} [params.brandKit]
 * @param {Array}  [params.personas]
 * @returns {Promise<{
 *   creative_concept, visual_signature, style_category, narrative_grammar,
 *   emotional_arc, hero_image, music_intent, cliffhanger_style,
 *   visual_style_brief, reference_commercials,
 *   episode_count_justification: { count, reasoning },
 *   brand_world_lock_if_two_eps?, anti_brief
 * }>}
 */
export async function generateCommercialBrief({ story, brandKit = null, personas = [], directorNudge = null, isRetry = false }) {
  // V4 Phase 7 / B1 — when Lens 0/A soft_rejects the previous brief, the
  // orchestrator spawns ONE re-run with a director's nudge (the verdict's
  // findings + remediation prompt_deltas) spliced as an additional block
  // on the user prompt. The system prompt is unchanged — the nudge is
  // user-side feedback, NOT a different system role.
  let userPrompt = buildUserPrompt({ story, brandKit, personas });
  if (directorNudge && typeof directorNudge === 'string' && directorNudge.trim().length > 0) {
    userPrompt += `\n\nDIRECTOR'S NUDGE (the previous brief was soft-rejected — address these specific notes):\n${directorNudge.trim()}`;
  }
  logger.info(`generating commercial creative brief for story "${story?.name || '(unnamed)'}" (retry=${isRetry})`);

  let parsed;
  try {
    parsed = await callVertexGeminiJson({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      config: { temperature: 0.85, maxOutputTokens: 4096 },
      timeoutMs: 60000
    });
  } catch (err) {
    logger.error(`Gemini brief failed: ${err.message}`);
    throw new Error(`CreativeBriefDirector failed: ${err.message}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('CreativeBriefDirector: empty Gemini response');
  }

  // Normalize episode count — clamp to [1, 2].
  const rawCount = Number(parsed.episode_count_justification?.count);
  const count = (Number.isFinite(rawCount) && rawCount >= 1) ? Math.min(2, Math.round(rawCount)) : 1;
  parsed.episode_count_justification = {
    count,
    reasoning: String(parsed.episode_count_justification?.reasoning || 'Default: single hero spot.')
  };

  // Validate style_category — fall back to 'hyperreal_premium' if Gemini emitted unknown.
  const sc = String(parsed.style_category || '').toLowerCase().trim();
  if (!COMMERCIAL_STYLE_CATEGORIES.includes(sc)) {
    logger.warn(`CreativeBriefDirector: unknown style_category "${parsed.style_category}" → defaulting to hyperreal_premium`);
    parsed.style_category = 'hyperreal_premium';
  } else {
    parsed.style_category = sc;
  }

  return parsed;
}

/**
 * Cap-and-validate the episode count for a commercial story. Mirrors the
 * existing prestige-story justification flow:
 *   - prestige stories: justified count in [3, 12]
 *   - commercial stories: justified count in [1, 2]
 *
 * Returns the resolved count (always 1 or 2) plus the reasoning.
 */
export function resolveCommercialEpisodeCount(brief) {
  const c = Number(brief?.episode_count_justification?.count);
  const safe = (Number.isFinite(c) && c >= 1) ? Math.min(2, Math.round(c)) : 1;
  return {
    count: safe,
    reasoning: brief?.episode_count_justification?.reasoning || 'Default: single 60s hero spot.'
  };
}

export function isCommercialGenre(story) {
  const g = String(story?.subject?.genre || story?.storyline?.genre || '').toLowerCase().trim();
  return g === 'commercial';
}

export function isCommercialPipelineEnabled() {
  // Default ON (Phase 6 GA, 2026-04-28). Set BRAND_STORY_COMMERCIAL_GENRE=false
  // to disable the commercial-genre branch (commercial stories then run the
  // standard prestige pipeline without CreativeBriefDirector pre-flight).
  return String(process.env.BRAND_STORY_COMMERCIAL_GENRE || 'true').toLowerCase() !== 'false';
}

// ─────────────────────────────────────────────────────────────────────
// V4 Phase 7 — style-routing predicates
//
// CreativeBriefDirector emits brief.style_category from a 10-value enum
// (see COMMERCIAL_STYLE_CATEGORIES in director-rubrics/commercialReferenceLibrary.mjs).
// Two of those values are non-photoreal in the strong sense and another
// two lean stylized. Phase 7 builds a downstream pipeline branch that
// honors stylized intent — every component that asks "is this style
// photoreal or not?" should consult these predicates rather than
// inlining the enum check.
//
// STRONG (full photoreal-bypass): hand_doodle_animated, surreal_dreamlike
//   These styles want identity LUT (no live-action color grading), stylized
//   character sheets, archetype-not-photo-likeness identity preservation,
//   and an animation-aware framing vocabulary.
//
// SEMI-STYLIZED (rendered live-action, stylized in grade/look):
//   vaporwave_nostalgic, painterly_prestige
//   These keep photoreal CIP / character-sheet identity but get a softened
//   "preserve recognizable structure" Scene Master directive and a
//   style-tinted LUT.
//
// PHOTOREAL (default 6): hyperreal_premium, verite_intimate, anthemic_epic,
// brutalist_minimalist, gritty_real, kinetic_montage. Unchanged behavior.
// ─────────────────────────────────────────────────────────────────────

export const NON_PHOTOREAL_STYLE_CATEGORIES = Object.freeze([
  'hand_doodle_animated',
  'surreal_dreamlike',
  'vaporwave_nostalgic',
  'painterly_prestige'
]);

export const STYLIZED_STRONG_STYLE_CATEGORIES = Object.freeze([
  'hand_doodle_animated',
  'surreal_dreamlike'
]);

function _resolveStyleCategory(briefOrStory) {
  if (!briefOrStory || typeof briefOrStory !== 'object') return '';
  // Accept either a brief object directly OR a story object that holds
  // commercial_brief on it. Either form maps to the same predicate.
  const direct = briefOrStory.style_category;
  const fromBrief = briefOrStory.commercial_brief?.style_category;
  return String(direct || fromBrief || '').toLowerCase().trim();
}

/**
 * True when style_category is one of the four non-photoreal categories.
 * Used by Scene Master directive softening, character sheet style-aware
 * branch, and LUT bypass routing.
 *
 * @param {Object} briefOrStory — commercial_brief, OR a story with commercial_brief
 * @returns {boolean}
 */
export function isNonPhotorealStyle(briefOrStory) {
  const cat = _resolveStyleCategory(briefOrStory);
  return NON_PHOTOREAL_STYLE_CATEGORIES.includes(cat);
}

/**
 * True only for the two strong-stylized categories: hand_doodle_animated and
 * surreal_dreamlike. These trigger:
 *   - identity-LUT bypass (no live-action grading)
 *   - stylized character sheets in target style (Flux 2 Max in-style)
 *   - "preserve archetype, not photographic likeness" Scene Master directive
 *   - animation-aware framing vocab entries
 *
 * @param {Object} briefOrStory
 * @returns {boolean}
 */
export function isStylizedStrong(briefOrStory) {
  const cat = _resolveStyleCategory(briefOrStory);
  return STYLIZED_STRONG_STYLE_CATEGORIES.includes(cat);
}

/**
 * Returns the resolved style_category string (lowercase, trimmed) or ''.
 * Useful when downstream code needs the actual enum value (e.g., to render
 * style-specific prompt language) rather than just a boolean predicate.
 *
 * @param {Object} briefOrStory
 * @returns {string}
 */
export function resolveStyleCategory(briefOrStory) {
  return _resolveStyleCategory(briefOrStory);
}
