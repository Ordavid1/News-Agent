// services/v4/SonicSeriesBible.js
// V4 Audio Coherence Overhaul — story-creation-time Sonic Series Bible.
//
// THE DIRECTOR'S VERDICT (consulted 2026-04-26 in the brand-story-overhaul thread):
//   Episodes currently fragment audio because each scene's `ambient_bed_prompt`
//   is rolled fresh by Gemini in isolation. The fix is "spine + stems" — a
//   story-creation-time bible that every per-episode `sonic_world` inherits
//   from and varies only what an explicit `inheritance_policy` permits.
//   One world, many angles. The viewer never hears the cut, they hear the world.
//
// Three pillars of the bible:
//   PALETTE      — signature_drone, base_palette, spectral_anchor
//                  (the show's signature timbre — the Severance drone)
//   GRAMMAR      — foley_density, score_under_dialogue, silence_as_punctuation,
//                  diegetic_ratio, transition_grammar
//                  (the show's rules of engagement — the Better Call Saul foley density)
//   NO-FLY LIST  — prohibited_instruments, prohibited_tropes, prohibited_frequencies_hz
//                  (equally identity-defining — what the show NEVER does)
//
// Lifecycle (mirrors the BrandKitLutMatcher pattern):
//   - NULL by default (legacy stories, freshly-created stories)
//   - Generated lazily on first episode generation in BrandStoryService.runV4Pipeline
//   - Idempotent skip if story.sonic_series_bible already populated
//   - Mutable via PATCH /api/brand-stories/:id/sonic-series-bible
//   - Read by every per-episode screenplay generation as immutable system context
//
// Failure mode: if Gemini fails or returns invalid JSON, fall through to the
// safe default bible (a deliberately neutral "naturalistic restraint" bible
// that won't damage any show). The pipeline never blocks on bible failure.

import winston from 'winston';
import { callVertexGeminiJson } from './VertexGemini.js';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `[SonicSeriesBible] ${timestamp} [${level}]: ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

// ─────────────────────────────────────────────────────────────────────
// Safe-default bible
// ─────────────────────────────────────────────────────────────────────
//
// Returned when:
//   - Gemini call fails
//   - Gemini returns invalid JSON
//   - Gemini returns a bible missing required pillars
//   - The story has no usable context to author from
//
// The default is "naturalistic restraint" — a bible that won't actively
// damage any show: gentle low-end anchor, conservative grammar, no aggressive
// prohibitions. Series with a real authored bible should always feel more
// distinctive than this fallback. The fallback is the safety net, not the goal.

export const DEFAULT_SONIC_SERIES_BIBLE = Object.freeze({
  signature_drone: {
    description: 'soft low-frequency room presence, sub-80Hz HVAC undertone',
    frequency_band_hz: [40, 120],
    presence_dB: -24
  },
  base_palette: {
    ambient_keywords: ['room tone', 'distant ambience', 'soft air movement'],
    bpm_range: [60, 90],
    key_or_modal_center: 'unspecified'
  },
  spectral_anchor: {
    description: 'sustained 60-120Hz low-end presence + faint 1-3kHz air',
    always_present: true,
    level_dB: -20
  },
  foley_density: 'naturalistic',
  score_under_dialogue: 'ducked_-18dB',
  silence_as_punctuation: 'occasional',
  diegetic_ratio: 0.6,
  transition_grammar: ['hard_cut_with_room_tone_carry', 'j_cut_dominant'],
  prohibited_instruments: [],
  prohibited_tropes: [],
  prohibited_frequencies_hz: [],
  inheritance_policy: {
    grammar: 'immutable',
    no_fly_list: 'immutable',
    base_palette: 'overridable_with_justification',
    signature_drone: 'must_appear_at_least_once_per_episode'
  },
  reference_shows: [],
  reference_rationale: 'safe naturalistic default — no authored bible available',
  _generated_by: 'default_fallback'
});

// ─────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────

const VALID_FOLEY_DENSITY = ['sparse', 'naturalistic', 'hyperreal'];
const VALID_SCORE_RULE = ['never', 'ducked_-18dB', 'ducked_-12dB', 'ducked_-6dB', 'permitted'];
const VALID_SILENCE_RULE = ['load_bearing', 'occasional', 'avoided'];
const VALID_INHERITANCE_GRAMMAR = ['immutable', 'overridable_with_justification', 'overridable'];
const VALID_INHERITANCE_DRONE = [
  'must_appear_at_least_once_per_episode',
  'must_appear_in_every_scene',
  'overridable_with_justification',
  'overridable'
];

/**
 * Validate a bible object against the V4 schema. Returns a list of issues
 * (empty array means valid). Used both at generation time (to fall through
 * to default if Gemini's output is malformed) and by the API PATCH endpoint
 * (to reject manual overrides that violate the contract).
 *
 * @param {object} bible
 * @returns {Array<{field: string, severity: 'blocker'|'warning', message: string}>}
 */
export function validateBible(bible) {
  const issues = [];
  if (!bible || typeof bible !== 'object') {
    issues.push({ field: '_root', severity: 'blocker', message: 'bible must be an object' });
    return issues;
  }

  // PALETTE — signature_drone
  const drone = bible.signature_drone;
  if (!drone || typeof drone !== 'object') {
    issues.push({ field: 'signature_drone', severity: 'blocker', message: 'signature_drone is required' });
  } else {
    if (!drone.description || typeof drone.description !== 'string') {
      issues.push({ field: 'signature_drone.description', severity: 'blocker', message: 'signature_drone.description must be a non-empty string' });
    }
    if (!Array.isArray(drone.frequency_band_hz) || drone.frequency_band_hz.length !== 2) {
      issues.push({ field: 'signature_drone.frequency_band_hz', severity: 'warning', message: 'frequency_band_hz must be [low, high]' });
    }
    if (typeof drone.presence_dB !== 'number') {
      issues.push({ field: 'signature_drone.presence_dB', severity: 'warning', message: 'presence_dB must be a number (negative dB)' });
    }
  }

  // PALETTE — base_palette
  const bp = bible.base_palette;
  if (!bp || typeof bp !== 'object') {
    issues.push({ field: 'base_palette', severity: 'blocker', message: 'base_palette is required' });
  } else {
    if (!Array.isArray(bp.ambient_keywords) || bp.ambient_keywords.length === 0) {
      issues.push({ field: 'base_palette.ambient_keywords', severity: 'blocker', message: 'ambient_keywords must be a non-empty array' });
    }
  }

  // PALETTE — spectral_anchor
  const sa = bible.spectral_anchor;
  if (!sa || typeof sa !== 'object') {
    issues.push({ field: 'spectral_anchor', severity: 'blocker', message: 'spectral_anchor is required' });
  } else {
    if (!sa.description || typeof sa.description !== 'string') {
      issues.push({ field: 'spectral_anchor.description', severity: 'blocker', message: 'spectral_anchor.description must be a non-empty string' });
    }
    if (sa.always_present !== true) {
      issues.push({ field: 'spectral_anchor.always_present', severity: 'blocker', message: 'spectral_anchor.always_present must be true (the seam-hider invariant)' });
    }
  }

  // GRAMMAR
  if (bible.foley_density && !VALID_FOLEY_DENSITY.includes(bible.foley_density)) {
    issues.push({ field: 'foley_density', severity: 'warning', message: `foley_density must be one of ${VALID_FOLEY_DENSITY.join(', ')}` });
  }
  if (bible.score_under_dialogue && !VALID_SCORE_RULE.includes(bible.score_under_dialogue)) {
    issues.push({ field: 'score_under_dialogue', severity: 'warning', message: `score_under_dialogue must be one of ${VALID_SCORE_RULE.join(', ')}` });
  }
  if (bible.silence_as_punctuation && !VALID_SILENCE_RULE.includes(bible.silence_as_punctuation)) {
    issues.push({ field: 'silence_as_punctuation', severity: 'warning', message: `silence_as_punctuation must be one of ${VALID_SILENCE_RULE.join(', ')}` });
  }
  if (typeof bible.diegetic_ratio === 'number' && (bible.diegetic_ratio < 0 || bible.diegetic_ratio > 1)) {
    issues.push({ field: 'diegetic_ratio', severity: 'warning', message: 'diegetic_ratio must be in [0, 1]' });
  }

  // INHERITANCE POLICY — load-bearing
  const ip = bible.inheritance_policy;
  if (!ip || typeof ip !== 'object') {
    issues.push({ field: 'inheritance_policy', severity: 'blocker', message: 'inheritance_policy is required' });
  } else {
    if (!VALID_INHERITANCE_GRAMMAR.includes(ip.grammar)) {
      issues.push({ field: 'inheritance_policy.grammar', severity: 'warning', message: `grammar must be one of ${VALID_INHERITANCE_GRAMMAR.join(', ')}` });
    }
    if (!VALID_INHERITANCE_GRAMMAR.includes(ip.no_fly_list)) {
      issues.push({ field: 'inheritance_policy.no_fly_list', severity: 'warning', message: `no_fly_list policy must be one of ${VALID_INHERITANCE_GRAMMAR.join(', ')}` });
    }
    if (ip.signature_drone && !VALID_INHERITANCE_DRONE.includes(ip.signature_drone)) {
      issues.push({ field: 'inheritance_policy.signature_drone', severity: 'warning', message: `signature_drone policy must be one of ${VALID_INHERITANCE_DRONE.join(', ')}` });
    }
  }

  return issues;
}

/**
 * Merge a partial / authored bible with the safe defaults, filling any
 * missing optional fields with the default values. Required fields that
 * fail validation are NOT auto-filled — the caller should fall through to
 * DEFAULT_SONIC_SERIES_BIBLE entirely on validation blocker.
 *
 * @param {object} authored
 * @returns {object} merged bible
 */
export function mergeBibleDefaults(authored) {
  if (!authored || typeof authored !== 'object') return { ...DEFAULT_SONIC_SERIES_BIBLE };
  return {
    ...DEFAULT_SONIC_SERIES_BIBLE,
    ...authored,
    inheritance_policy: {
      ...DEFAULT_SONIC_SERIES_BIBLE.inheritance_policy,
      ...(authored.inheritance_policy || {})
    }
  };
}

// ─────────────────────────────────────────────────────────────────────
// Generation
// ─────────────────────────────────────────────────────────────────────

/**
 * Build the system prompt for Gemini.
 *
 * Treats Gemini as a supervising sound editor in pre-production: given the
 * series concept (genre, thematic argument, brand mood, persona archetypes,
 * reference shows), author the bible the show will defer to for every episode.
 *
 * Constraints baked into the prompt:
 *   1. Output strictly the V4 bible schema as JSON — no commentary
 *   2. signature_drone.always_present is structurally true (not negotiable)
 *   3. inheritance_policy.signature_drone defaults to "must_appear_at_least_once_per_episode"
 *      (this is what makes ep7 feel like ep1 — the binding clause)
 *   4. prohibited_* lists are AUTHORED — not empty by default. If the bible
 *      doesn't say what the show NEVER does, it's not a real bible.
 *
 * @param {object} ctx - { genre, tone, brandMood, referenceShows[] }
 * @returns {string} system prompt
 */
function _buildSonicSeriesBibleDirective(ctx) {
  return `You are a supervising sound editor authoring the sonic series bible for a brand-story show in pre-production.
Your bible will be referenced by every episode that ever generates from this story. Episodes will inherit from
your bible and vary only what your inheritance_policy explicitly permits. This is the show's sound DNA.

A real series sound bible is THREE pillars together — not just palette, but also grammar and a no-fly list:

  PALETTE     — the show's signature timbre. The Severance drone. The hum that says "this is Lumon".
                Lives in: signature_drone, base_palette, spectral_anchor.

  GRAMMAR     — the show's rules of engagement. Better Call Saul's foley density.
                Andor's "score never under dialogue". The Bear's diegetic-kitchen-pressure ratio.
                Lives in: foley_density, score_under_dialogue, silence_as_punctuation,
                diegetic_ratio, transition_grammar.

  NO-FLY LIST — what the show NEVER does. Equally identity-defining. Slow Horses doesn't do
                orchestral string swells. Severance doesn't do needle-drops on montages.
                Lives in: prohibited_instruments, prohibited_tropes, prohibited_frequencies_hz.

The most important field is inheritance_policy.signature_drone. Default it to
"must_appear_at_least_once_per_episode" — that binding clause is what makes
ep7 feel like the same show as ep1 even when the location changes.

Output STRICTLY this JSON shape, no commentary:

{
  "signature_drone": {
    "description": "1 sentence — the show's recognizable low-frequency presence",
    "frequency_band_hz": [low_hz_int, high_hz_int],
    "presence_dB": -24_to_-12_negative_number
  },
  "base_palette": {
    "ambient_keywords": ["3-6 keywords describing the show's constant ambient texture"],
    "bpm_range": [bpm_low_int, bpm_high_int],
    "key_or_modal_center": "musical key or 'unspecified' if not tonal"
  },
  "spectral_anchor": {
    "description": "1 sentence — the LF + HF content that always plays under everything",
    "always_present": true,
    "level_dB": -22_to_-14_negative_number
  },
  "foley_density": "sparse" | "naturalistic" | "hyperreal",
  "score_under_dialogue": "never" | "ducked_-18dB" | "ducked_-12dB" | "ducked_-6dB" | "permitted",
  "silence_as_punctuation": "load_bearing" | "occasional" | "avoided",
  "diegetic_ratio": 0.0_to_1.0_float,
  "transition_grammar": ["j_cut_dominant" | "hard_cut_with_room_tone_carry" | "fade_to_silence" | "musical_match_cut"],
  "prohibited_instruments": ["2-5 specific instrument families this show NEVER uses"],
  "prohibited_tropes": ["2-5 specific audio tropes this show NEVER uses"],
  "prohibited_frequencies_hz": [],
  "inheritance_policy": {
    "grammar": "immutable",
    "no_fly_list": "immutable",
    "base_palette": "overridable_with_justification",
    "signature_drone": "must_appear_at_least_once_per_episode"
  },
  "reference_shows": ["1-3 prestige shows whose sonic discipline this bible draws from"],
  "reference_rationale": "1 sentence — what specifically you're borrowing from those shows"
}

Be opinionated. A bible that says "no prohibited instruments" is not a bible — it's a wish.`;
}

function _buildSonicSeriesBibleUserPrompt(ctx) {
  const lines = [];
  if (ctx.brandName) lines.push(`Brand: ${ctx.brandName}`);
  if (ctx.genre) lines.push(`Genre: ${ctx.genre}`);
  if (ctx.tone) lines.push(`Tone: ${ctx.tone}`);
  if (ctx.thematicArgument) lines.push(`Thematic argument: ${ctx.thematicArgument}`);
  if (ctx.centralDramaticQuestion) lines.push(`Central dramatic question: ${ctx.centralDramaticQuestion}`);
  if (ctx.antagonistCurve) lines.push(`Antagonist curve: ${ctx.antagonistCurve}`);
  if (ctx.brandMood) lines.push(`Brand mood: ${ctx.brandMood}`);
  if (ctx.brandAesthetic) lines.push(`Brand aesthetic: ${ctx.brandAesthetic}`);
  if (Array.isArray(ctx.personaArchetypes) && ctx.personaArchetypes.length > 0) {
    lines.push(`Persona archetypes: ${ctx.personaArchetypes.filter(Boolean).join(', ')}`);
  }
  if (Array.isArray(ctx.referenceShows) && ctx.referenceShows.length > 0) {
    lines.push(`User reference shows (taste anchor): ${ctx.referenceShows.join(', ')}`);
  }
  if (ctx.directorsNotes) lines.push(`Director's notes: ${ctx.directorsNotes}`);

  return `Story context:

${lines.join('\n') || '(minimal context — author a restrained, defensible bible)'}

Author the sonic series bible for this show.`;
}

/**
 * Generate the sonic series bible for a story. Returns the safe default
 * bible if the Gemini call fails or returns invalid JSON — the pipeline
 * never blocks on bible failure.
 *
 * Idempotency is handled by the CALLER (BrandStoryService.runV4Pipeline)
 * via story.sonic_series_bible existence check — this function always
 * generates fresh.
 *
 * @param {object} ctx
 *   @param {string} [ctx.brandName]
 *   @param {string} [ctx.genre]
 *   @param {string} [ctx.tone]
 *   @param {string} [ctx.thematicArgument]
 *   @param {string} [ctx.centralDramaticQuestion]
 *   @param {string} [ctx.antagonistCurve]
 *   @param {string} [ctx.brandMood]
 *   @param {string} [ctx.brandAesthetic]
 *   @param {string[]} [ctx.personaArchetypes]
 *   @param {string[]} [ctx.referenceShows]
 *   @param {string} [ctx.directorsNotes]
 * @returns {Promise<object>} validated bible (always returns something — falls through to defaults on failure)
 */
export async function generateSonicSeriesBible(ctx = {}) {
  const systemPrompt = _buildSonicSeriesBibleDirective(ctx);
  const userPrompt = _buildSonicSeriesBibleUserPrompt(ctx);

  let raw;
  try {
    raw = await callVertexGeminiJson({
      systemPrompt,
      userPrompt,
      config: {
        temperature: 0.6,
        maxOutputTokens: 4096
      },
      timeoutMs: 60000
    });
  } catch (err) {
    logger.warn(`Gemini bible generation failed: ${err.message} → using safe default`);
    return { ...DEFAULT_SONIC_SERIES_BIBLE };
  }

  // Merge with defaults so optional fields are always populated, then validate.
  const merged = mergeBibleDefaults(raw);
  const issues = validateBible(merged);
  const blockers = issues.filter(i => i.severity === 'blocker');

  if (blockers.length > 0) {
    logger.warn(`bible failed validation (${blockers.length} blocker(s)) → using safe default. First blocker: ${blockers[0].field} — ${blockers[0].message}`);
    return { ...DEFAULT_SONIC_SERIES_BIBLE };
  }

  if (issues.length > 0) {
    logger.info(`bible authored with ${issues.length} non-blocking warning(s) — first: ${issues[0].field}`);
  } else {
    logger.info(`bible authored cleanly (refs: ${(merged.reference_shows || []).join(', ') || 'none'})`);
  }

  // Annotate provenance so the Director Panel can show "Gemini-authored" vs "default"
  merged._generated_by = merged._generated_by || 'gemini';
  return merged;
}

/**
 * Resolve the bible for a story. Returns the authored bible if present,
 * else the safe default. NEVER returns null — every story has a bible
 * (even if it's the default fallback).
 *
 * @param {object} story
 * @returns {object}
 */
export function resolveBibleForStory(story) {
  if (story?.sonic_series_bible && typeof story.sonic_series_bible === 'object') {
    return mergeBibleDefaults(story.sonic_series_bible);
  }
  return { ...DEFAULT_SONIC_SERIES_BIBLE };
}
