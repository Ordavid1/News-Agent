// services/v4/director-rubrics/screenplayRubric.mjs
//
// Lens A — Table Read. Post-screenplay, text-only, runs after L1/L2.
// Judges what L1/L2 cannot: taste, cliffhanger sting, escalation, voice
// distinctness as art (not just token overlap), subtext as opposite-of-said
// (not just non-empty), scene necessity, dramatic question payoff.

import { buildSharedSystemHeader, buildGenreRegisterHint } from './sharedHeader.mjs';

const LENS_A_BLOCK = `CHECKPOINT A — Table Read (post-screenplay, text-only). LENS A.

DIMENSIONS TO SCORE (each 0-100). Use these EXACT keys in dimension_scores:
  story_spine        — central dramatic question sharpness, three-movement shape (20%/55%/25%) intact, narrative_purpose declared per scene
  character_voice    — would each persona's lines pass a blind-attribution test? token-overlap with other personas low? voice consistent with bible's speech_patterns?
  dialogue_craft     — Five Jobs of dialogue served? voice as weapon? clipped under duress in action register? lines feel earned, not announced?
  subtext_density    — dialogue beats with subtext that is genuine opposite-of-said (NOT paraphrase of the line)? scene-level macro-subtext annotated where it elevates the moment?
  scene_structure    — every scene has scene_goal, dramatic_question, hook_types, opposing_intents (multi-persona)? scene goals are dramatic objectives, not stage directions like "Wrap."?
  escalation         — emotional intensity ≥ previous-episode-final-intensity − 1? curve ascends across the episode rather than descending?
  genre_fidelity     — beat-type mix, dialogue floor, pacing, sonic_world.base_palette texture, music_bed_intent match the active GENRE REGISTER?
  sonic_world_coherence — is sonic_world present and structurally sound? base_palette describes a CONTINUOUS episode bed (not a per-scene texture)? spectral_anchor mentions sub-200Hz content? scene_variations are ADDITIVE (overlay shares vocabulary with base_palette — not a full timbre replacement)? music_bed_intent respects bible prohibited_instruments when a sonic_series_bible is present?
  cliffhanger        — final beat lands a sting / hook / reversal that pulls the viewer into the next episode? buttons on a question, not a sigh?

WHAT TO LOOK AT FIRST:
  1. Read the cliffhanger beat → walk back to opening hook → ask "did we earn this cliffhanger?"
  2. Audit each scene's opposing_intents. Multi-persona scenes without opposing intents are vignettes, not scenes.
  3. Voice-distinctness sweep: for each persona, read 3 of their lines. Could you blind-attribute them?
  4. Subtext sweep: scan beat.subtext fields. Flag every dialogue beat where subtext is missing OR is a paraphrase of the said-line.
  5. Escalation sweep: compare each scene's emotional intensity to the previous; flag plateaus and dips.

DEFER TO L1/L2 (do NOT re-emit):
  - dialogue_beat_ratio counts (L1 owns)
  - voice token-overlap percentage (L1 owns — but you may emit a "voice drifts under pressure" finding if a persona breaks bible mid-scene)
  - subtext coverage stats (L1 owns — but you may emit a subtext_quality finding if subtext exists but is paraphrase)
  - mouth_occlusion regex (L1 owns)
  - subject_mandate count (L1 owns)
  - beat sizing math (L1 auto-repairs)
  - any text-level patch L2 already attempted

EVIDENCE FORMAT:
  scope MUST be one of: "episode" | "scene:<scene_id>" | "beat:<beat_id>"
  evidence MUST quote the offending line / cite the field / point at the structural defect.`;

/**
 * Build the system + user prompt for Lens A. Returns a {systemPrompt, userPrompt}
 * pair that the DirectorAgent passes to callVertexGeminiJson with the
 * SCREENPLAY_VERDICT_SCHEMA.
 *
 * @param {Object} params
 * @param {Object} params.sceneGraph        - the V4 scene-graph being judged (post-Doctor)
 * @param {Array}  params.personas          - the persona bibles
 * @param {Object} [params.storyBible]      - season/series-level bible if available
 * @param {string} [params.previousEpisodesSummary] - text summary of previous episodes' continuity
 * @param {string} [params.storyFocus]      - genre / story focus (drama, action, etc.)
 * @param {number} [params.previousFinalIntensity]  - 0-10 intensity ledger value from prior episode
 * @param {boolean} [params.isRetry]        - if this is a second attempt; affects retry_authorization
 */
export function buildScreenplayJudgePrompt({
  sceneGraph,
  personas,
  storyBible = null,
  sonicSeriesBible = null,
  previousEpisodesSummary = '',
  storyFocus = 'drama',
  previousFinalIntensity = null,
  isRetry = false
} = {}) {
  const systemPrompt = [
    buildSharedSystemHeader(),
    '',
    LENS_A_BLOCK,
    '',
    buildGenreRegisterHint(storyFocus),
    '',
    isRetry
      ? 'NOTE: This is the SECOND attempt at this screenplay (one auto-retry already spent). retry_authorization MUST be false in your verdict — escalate to user_review on any critical finding.'
      : ''
  ].filter(Boolean).join('\n');

  const userBlocks = [];
  userBlocks.push(`<screenplay>\n${JSON.stringify(sceneGraph, null, 2)}\n</screenplay>`);
  userBlocks.push(`<personas>\n${JSON.stringify(personas, null, 2)}\n</personas>`);
  if (storyBible) {
    userBlocks.push(`<series_bible>\n${JSON.stringify(storyBible, null, 2)}\n</series_bible>`);
  }
  if (sonicSeriesBible) {
    userBlocks.push(`<sonic_series_bible>\n${JSON.stringify(sonicSeriesBible, null, 2)}\n</sonic_series_bible>`);
  }
  if (previousEpisodesSummary) {
    userBlocks.push(`<previously_on>\n${previousEpisodesSummary}\n</previously_on>`);
  }
  if (previousFinalIntensity != null) {
    userBlocks.push(`<previous_episode_final_intensity>${previousFinalIntensity}/10</previous_episode_final_intensity>`);
  }
  userBlocks.push('Grade per Lens A. Output ONLY the verdict JSON.');

  return { systemPrompt, userPrompt: userBlocks.join('\n\n') };
}
