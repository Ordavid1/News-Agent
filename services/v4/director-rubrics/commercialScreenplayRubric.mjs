// services/v4/director-rubrics/commercialScreenplayRubric.mjs
//
// V4 Phase 7 — Lens A (Table Read) commercial variant. Replaces the prestige
// screenplay rubric (story_spine / character_voice / dialogue_craft /
// subtext_density / scene_structure / escalation / genre_fidelity /
// sonic_world_coherence / cliffhanger) with a commercial-craft set when
// story.genre === 'commercial'.
//
// What changes vs. prestige Lens A:
//   - dialogue_craft + subtext_density are dropped (commercial spots are
//     visual-rhythm-driven, not dialogue-driven; tagline-led not arc-led)
//   - story_spine is replaced by creative_concept_clarity + visual_signature_strength
//   - cliffhanger is replaced by tagline_landing_setup + product_role
//   - genre_fidelity is replaced by style_category_fidelity (the brief picks
//     style; the screenplay must honor it, not drift toward prestige register)
//   - anti_brief_adherence is new — the brief commits to what the spot is NOT;
//     the screenplay must not slip into the rejected cliché

import { buildSharedSystemHeader, buildGenreRegisterHint } from './sharedHeader.mjs';
import { isStylizedStrong, isNonPhotorealStyle, resolveStyleCategory } from '../CreativeBriefDirector.js';

const COMMERCIAL_LENS_A_BLOCK = `CHECKPOINT A — Commercial Table Read (post-screenplay, text-only). LENS A — COMMERCIAL.

DIMENSIONS TO SCORE (each 0-100). Use these EXACT keys in dimension_scores:
  creative_concept_clarity    — One concept on a sticky note. Is the spot's central idea legible from the screenplay alone, or does it read as a feature list / generic mood piece?
  visual_signature_strength   — Does the screenplay commit to ONE visual signature an art director could quote (anamorphic / kinetic / single-take / cel-shaded silhouettes / etc.)? Or is it visually anonymous?
  hook_first_1_5s             — Is the opening beat (or opening pair of micro-beats) an attention-stopper? Image, sound, or motion that earns the next 28 seconds.
  story_compression           — Does an emotional arc actually land in 30-60s? No bloat. No throat-clearing. Every beat earns its seconds.
  tagline_landing_setup       — Is the spot architected so the final 2s tagline lands as inevitable, not slapped on? Final beat earns the tagline.
  product_role                — Is the product woven into the thesis (Honda Cog) / a tool for the hero (Beats) / stapled to the end? Best work makes product = thesis.
  style_category_fidelity     — Does the screenplay honor commercial_brief.style_category? An anthemic_epic spot should not read as kinetic_montage; a hand_doodle_animated brief should not be written as a live-action photoreal spot. The brief picked the register; the writer must serve it.
  anti_brief_adherence        — The brief committed to what this spot is NOT (the cliché it rejects). Does the screenplay slip into that rejected territory? (e.g., "this is NOT a smiling family at sunrise" — but the screenplay opens on a family at sunrise = hard fail)

WHAT TO LOOK AT FIRST (in order):
  1. CONCEPT — read the brief's creative_concept. Then read the screenplay. Are they describing the same spot?
  2. STYLE — does the screenplay's scene_visual_anchor_prompt language match the brief's style_category? (cel-shaded brief → anchors say "cel-shaded"; photoreal brief → anchors say "photoreal")
  3. HOOK — is the first 1.5s a feed-scroll-stopper, or is it setup-for-setup?
  4. TAGLINE LAND — is the final beat architected to deliver the tagline as payoff?
  5. PRODUCT ROLE — is the product the thesis, a tool, or a sticker?
  6. ANTI-BRIEF — does the spot slip into the cliché the brief rejected?

DEFER TO L1/L2 (do NOT re-emit):
  - dialogue_beat_ratio counts (commercial floor is lower; L1 already enforces)
  - voice token-overlap (less load-bearing for commercials than prestige)
  - structural beat-mix sanity (L1 owns)

DROPPED (intentionally not scored — these are prestige metrics that punish commercial work):
  story_spine            — commercial concepts are not three-movement structures
  character_voice        — commercial personas are archetypes, not arc characters; voice distinctness is not the bar
  dialogue_craft         — many spots are silent or dialogue-light; "Five Jobs of dialogue" punishes this
  subtext_density        — commercial dialogue is often direct or absent; subtext-as-opposite-of-said is a prestige craft expectation
  cliffhanger            — commercials end on a tagline land + brand stamp, not a "next episode" hook

EVIDENCE FORMAT:
  scope MUST be one of: "episode" | "scene:<scene_id>" | "beat:<beat_id>"
  evidence MUST quote the offending line / cite the brief field / point at the structural defect.`;

/**
 * Build the system + user prompt for the COMMERCIAL Lens A. Returns a
 * {systemPrompt, userPrompt} pair that DirectorAgent passes to
 * callVertexGeminiJson with COMMERCIAL_SCREENPLAY_VERDICT_SCHEMA.
 *
 * @param {Object} params
 * @param {Object} params.sceneGraph         - the V4 commercial scene-graph
 * @param {Array}  params.personas           - persona bibles (with visual_anchor when set)
 * @param {Object} params.commercialBrief    - the CreativeBriefDirector output
 * @param {Object} [params.brandKit]         - brand kit for context
 * @param {string} [params.storyFocus='commercial'] - drives genre register hint
 * @param {boolean} [params.isRetry=false]
 */
export function buildCommercialScreenplayJudgePrompt({
  sceneGraph,
  personas,
  commercialBrief,
  brandKit = null,
  storyFocus = 'commercial',
  isRetry = false
} = {}) {
  const styleCategory = resolveStyleCategory(commercialBrief);
  const stylized = isStylizedStrong(commercialBrief);
  const nonPhoto = isNonPhotorealStyle(commercialBrief);

  // Style governance hint — when the brief picks a non-photoreal style,
  // remind the judge that prestige live-action craft expectations would
  // soft_reject legitimate stylized choices (animation grammar, intentional
  // discontinuity, graphic-overlay transitions). Keep `style_category_fidelity`
  // as the load-bearing dimension for stylized work.
  const styleHint = stylized
    ? `STYLIZED COMMERCIAL: brief.style_category = "${styleCategory}" (animation-class). Score style_category_fidelity heavily. Do NOT penalize for "no photographic optical realism", "discontinuous lighting between shots", "non-naturalistic motion grammar" — these are intended craft for ${styleCategory}.`
    : nonPhoto
      ? `SEMI-STYLIZED COMMERCIAL: brief.style_category = "${styleCategory}" (live-action filmed but stylized in look/grade). Score style_category_fidelity for grade-level + texture-level fidelity, not optical realism deltas.`
      : '';

  const systemPrompt = [
    buildSharedSystemHeader(),
    '',
    COMMERCIAL_LENS_A_BLOCK,
    '',
    buildGenreRegisterHint(storyFocus),
    '',
    styleHint,
    '',
    isRetry
      ? 'NOTE: This is the SECOND attempt at this commercial screenplay. retry_authorization MUST be false — escalate to user_review on any critical finding.'
      : ''
  ].filter(Boolean).join('\n');

  const userBlocks = [];
  userBlocks.push(`<screenplay>\n${JSON.stringify(sceneGraph, null, 2)}\n</screenplay>`);
  userBlocks.push(`<personas>\n${JSON.stringify(personas, null, 2)}\n</personas>`);
  userBlocks.push(`<commercial_brief>\n${JSON.stringify(commercialBrief, null, 2)}\n</commercial_brief>`);
  if (brandKit) {
    userBlocks.push(`<brand_kit>\n${JSON.stringify({
      brand_summary: brandKit.brand_summary,
      mood: brandKit.style_characteristics?.mood,
      aesthetic: brandKit.style_characteristics?.overall_aesthetic,
      palette: brandKit.color_palette
    }, null, 2)}\n</brand_kit>`);
  }
  userBlocks.push('Grade per Commercial Lens A. Output ONLY the verdict JSON.');

  return { systemPrompt, userPrompt: userBlocks.join('\n\n') };
}

export const COMMERCIAL_SCREENPLAY_DIMENSIONS = Object.freeze([
  'creative_concept_clarity', 'visual_signature_strength', 'hook_first_1_5s',
  'story_compression', 'tagline_landing_setup', 'product_role',
  'style_category_fidelity', 'anti_brief_adherence'
]);
