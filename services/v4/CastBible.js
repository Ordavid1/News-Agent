// services/v4/CastBible.js
// V4 Cast Coherence — story-creation-time Cast Bible.
//
// THE PROBLEM (production logs, 2026-04-25 → 2026-04-28):
//   Gemini occasionally emits dialogue with persona_index 1 in stories that
//   have only persona 0. The validator (checkPersonaIndexCoverage) catches
//   it as a loud blocker, but by that point the user has wasted time on a
//   doomed run. The phantom-character invention is upstream — in the
//   screenplay prompt, where Gemini has no hard list of permitted
//   persona_index values.
//
//   Separately, when a persona record is sparse (placeholder name "Persona 1",
//   no visual_description, no rich personality fields), inferPersonaGender
//   returns 'unknown' and voice acquisition picks without gender filter.
//   The picked voice may not match the storyline character's gender.
//
// THE FIX:
//   A story-level cast_bible derived ONCE from storyline.characters[] +
//   persona_config.personas[] at first runV4Pipeline call. NO Gemini call —
//   this is a purely structural snapshot that:
//     1. Lists permitted persona_index values for the screenplay prompt's
//        HARD CONSTRAINT block
//     2. Records gender_resolved_from provenance using the COMBINED persona
//        + storyline character signal — salvages signal for sparse personas
//     3. Flags voice_gender_match for Casting Room UX so wrong-gender voice
//        picks become user-visible (and user-fixable)
//
// Lifecycle (mirrors SonicSeriesBible pattern):
//   - NULL by default (legacy stories, freshly-created stories before first
//     episode)
//   - Derived lazily on first runV4Pipeline call (Step 1b — AFTER voice
//     acquisition so voice IDs are present, BEFORE the future Phase-6
//     commercial-genre branch)
//   - Idempotency: re-derive when bible is missing OR has empty principals
//     AND _generated_by !== 'manual_override' (manual overrides preserved)
//   - Mutable via PATCH /api/brand-stories/:id/cast-bible
//   - Read by every per-episode screenplay generation as immutable system
//     context (HARD CONSTRAINT block in prompt)
//
// Canonical-source contract (Failure Mode #2 in plan):
//   persona_config.personas[].elevenlabs_voice_id is the WRITE-TRUTH for
//   voice assignments. cast_bible.principals[].elevenlabs_voice_id is a
//   DERIVED VIEW — populated by resolveCastBibleForStory by re-resolving
//   from persona_config on every read. PATCH /cast-bible REJECTS voice_id
//   changes at the API boundary (eliminates the second write path).
//
// Locked-bible contract (Failure Mode #3 in plan):
//   When status === 'locked', all structural mutations (principal count,
//   persona_index, name, role, gender, voice) are rejected with 409 or 422.
//   Lock can only be undone via PATCH { bible: null }. No auto-unlock.

import winston from 'winston';
import { inferPersonaGender } from './VoiceAcquisition.js';
import { isBlockerOrCritical } from './severity.mjs';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `[CastBible] ${timestamp} [${level}]: ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

// ─────────────────────────────────────────────────────────────────────
// Safe-default bible
// ─────────────────────────────────────────────────────────────────────
//
// Returned by resolveCastBibleForStory when no story.cast_bible exists.
// Empty principals — opt-in. Legacy stories without a bible see this
// default; the prompt's HARD CONSTRAINT block emits an empty string for
// empty-principals bibles, so behavior is identical to today (no constraint
// applied) for unprocessed legacy stories.

export const DEFAULT_CAST_BIBLE = Object.freeze({
  status: 'derived',
  version: 1,
  principals: [],
  guest_pool: [],
  locked_at: null,
  inheritance_policy: Object.freeze({
    persona_indexes: 'immutable',
    voice_assignments: 'immutable_when_locked',
    appearances: 'mutable_per_episode'
  }),
  _generated_by: 'derived_from_storyline'
});

// ─────────────────────────────────────────────────────────────────────
// Phase 3.5 — Gender inference upgrade
// ─────────────────────────────────────────────────────────────────────

/**
 * Wrapper around VoiceAcquisition.inferPersonaGender that uses BOTH the
 * persona record AND the matching storyline character entry as signal
 * sources. Salvages gender signal for sparse personas (placeholder names
 * like "Persona 1" with empty appearance fields) by reading the richer
 * storyline.characters[i] data.
 *
 * Resolution priority (V4 Phase 5b — vision_anchor added as priority 0):
 *   0. visual_anchor     — persona.visual_anchor.apparent_gender_presentation
 *                          (extracted from uploaded photos via Vertex Gemini
 *                          multimodal). HIGHEST PRIORITY because it is the only
 *                          signal grounded in the actual visual reference.
 *   1. persona_explicit  — persona.gender or persona.sex set directly
 *   2. persona_signal    — inferPersonaGender(persona) returns confident
 *   3. storyline_signal  — inferPersonaGender(combined) returns confident
 *                          where combined merges persona with storyline
 *                          character fields
 *   4. unknown           — no signal anywhere
 *
 * Defensive index-drift check: if storyCharacter is missing OR its name
 * doesn't fuzzy-match persona.name (case-insensitive substring either
 * direction), skip the storyline-signal step and emit a warning. This
 * protects against the case where storyline.characters[] and
 * persona_config.personas[] drift out of 1:1 alignment.
 *
 * @param {Object} persona - persona_config.personas[i]
 * @param {Object|null} storyCharacter - storyline.characters[i]
 * @returns {{ gender: 'male'|'female'|'unknown', resolved_from: 'visual_anchor'|'persona_explicit'|'persona_signal'|'storyline_signal'|'unknown' }}
 */
export function inferPersonaGenderForCast(persona, storyCharacter) {
  if (!persona || typeof persona !== 'object') {
    return { gender: 'unknown', resolved_from: 'unknown' };
  }

  // Step 0 (V4 Phase 5b): visual_anchor is the highest-priority signal because
  // it is grounded in the actual reference photographs. When present and
  // decisive, it OVERRIDES any text-only inference (which is the cause of the
  // cascading invention bug — story `77d6eaaf` 2026-04-28).
  //
  // V4 Wave 6 / F4 — vision_confidence guard. A 0.45-confidence anchor
  // (low-light upload, profile-only, partial occlusion) used to drive
  // `gender_resolved_from='visual_anchor'` with maximum authority — Cast
  // Bible's "highest priority", VoiceAcquisition's hard filter, ORDER OF
  // AUTHORITY's "non-negotiable" ranking. If Vision misread, all four
  // downstream stages cascade the wrong gender confidently. Below the floor
  // (default 0.5, env-tunable via BRAND_STORY_VISION_CONFIDENCE_FLOOR), the
  // anchor is a HINT not ground truth — fall through to text-only inference
  // so storyline / explicit fields take precedence on uncertain photos.
  const VISUAL_ANCHOR_CONFIDENCE_FLOOR = Number(process.env.BRAND_STORY_VISION_CONFIDENCE_FLOOR || '0.5');
  const anchor = persona.visual_anchor;
  const anchorGender = String(anchor?.apparent_gender_presentation || '').toLowerCase().trim();
  const anchorConfident = Number.isFinite(anchor?.vision_confidence)
    ? anchor.vision_confidence >= VISUAL_ANCHOR_CONFIDENCE_FLOOR
    : true; // missing confidence → treat as confident (legacy anchors)
  if ((anchorGender === 'male' || anchorGender === 'female') && anchorConfident) {
    return { gender: anchorGender, resolved_from: 'visual_anchor' };
  }

  // Step 1: explicit field
  const explicit = String(persona.gender || persona.sex || '').toLowerCase().trim();
  if (explicit === 'male' || explicit === 'man' || explicit === 'm') {
    return { gender: 'male', resolved_from: 'persona_explicit' };
  }
  if (explicit === 'female' || explicit === 'woman' || explicit === 'f') {
    return { gender: 'female', resolved_from: 'persona_explicit' };
  }

  // Step 2: persona-only inference
  const fromPersona = inferPersonaGender(persona);
  if (fromPersona !== 'unknown') {
    return { gender: fromPersona, resolved_from: 'persona_signal' };
  }

  // Step 3: storyline-augmented inference
  if (storyCharacter && typeof storyCharacter === 'object') {
    if (_namesAlignForGenderInference(persona, storyCharacter)) {
      // Merge: persona fields take precedence; storyline fills gaps. We
      // pass the combined object to inferPersonaGender unchanged so the
      // existing field-list + threshold logic applies.
      const combined = {
        ...storyCharacter,
        ...persona,
        // Concatenate text-bearing fields rather than overwriting — captures
        // signal from BOTH sources. Empty/missing values drop out of the join.
        description: [persona.description, storyCharacter.visual_description, storyCharacter.arc].filter(Boolean).join(' '),
        visual_description: [persona.visual_description, storyCharacter.visual_description].filter(Boolean).join(' '),
        personality: [persona.personality, storyCharacter.personality].filter(Boolean).join(' '),
        role: persona.role || storyCharacter.role
      };
      const fromCombined = inferPersonaGender(combined);
      if (fromCombined !== 'unknown') {
        return { gender: fromCombined, resolved_from: 'storyline_signal' };
      }
    } else {
      logger.warn(`cast_bible_index_drift: persona "${persona.name}" name does not align with storyline character "${storyCharacter.name}" — falling back to persona-only inference`);
    }
  }

  // Step 4: nothing worked
  return { gender: 'unknown', resolved_from: 'unknown' };
}

/**
 * Defensive name alignment check between a persona and its supposed
 * storyline character counterpart. Returns true if the names plausibly
 * refer to the same character.
 *
 * Accepts:
 *   - case-insensitive substring match in either direction
 *   - placeholder personas ("Persona 1", "Persona 2", ...) — always align
 *     because the wizard didn't capture a name and the storyline character
 *     is our only signal source
 *
 * Rejects: distinct named characters (e.g. persona.name='Sydney',
 * storyCharacter.name='Marcus') — which signals 1:1 index drift.
 *
 * @param {Object} persona
 * @param {Object} storyCharacter
 * @returns {boolean}
 */
function _namesAlignForGenderInference(persona, storyCharacter) {
  const pName = String(persona.name || '').toLowerCase().trim();
  const sName = String(storyCharacter.name || '').toLowerCase().trim();
  if (!pName || !sName) return true; // either missing → can't disprove alignment
  if (/^persona\s*\d+$/i.test(persona.name || '')) return true; // placeholder
  return pName.includes(sName) || sName.includes(pName);
}

/**
 * Compute voice/persona gender match.
 *
 * Returns:
 *   true  — both genders known AND agree (or one side neutral, which we
 *           treat as agreeing with anything)
 *   false — both genders known AND disagree (the bug we want to surface)
 *   null  — either side is unknown/missing → no claim
 *
 * Returning null (not false) for the unknown case avoids false-positive
 * mismatch chips on legacy stories where gender_inferred was 'unknown'.
 *
 * @param {Object} principal - cast_bible.principals[i] candidate
 * @returns {true|false|null}
 */
export function detectVoiceGenderMismatch(principal) {
  if (!principal || typeof principal !== 'object') return null;
  const personaGender = String(principal.gender_inferred || '').toLowerCase();
  const voiceGender = String(principal.elevenlabs_voice_gender || '').toLowerCase();
  if (!personaGender || personaGender === 'unknown') return null;
  if (!voiceGender || voiceGender === 'unknown') return null;
  if (voiceGender === 'neutral' || personaGender === 'neutral') return true; // neutral agrees with anything
  return personaGender === voiceGender;
}

// ─────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────

const VALID_STATUS = ['derived', 'locked', 'manual_override'];
const VALID_RESOLVED_FROM = ['persona_explicit', 'persona_signal', 'storyline_signal', 'unknown'];
const VALID_INHERITANCE_PERSONA_INDEXES = ['immutable', 'overridable_with_justification', 'overridable'];
const VALID_INHERITANCE_VOICE = ['immutable_when_locked', 'immutable', 'overridable'];
const VALID_INHERITANCE_APPEARANCES = ['mutable_per_episode', 'immutable', 'overridable'];

/**
 * Validate a cast bible against the V4 schema. Returns a list of issues
 * (empty array means valid). Used by the PATCH endpoint to reject manual
 * overrides that violate the contract.
 *
 * @param {object} bible
 * @returns {Array<{field: string, severity: 'critical'|'warning', message: string}>} (V4 P0.1 canonical; legacy 'blocker' aliased via severity.mjs)
 */
export function validateCastBible(bible) {
  const issues = [];
  if (!bible || typeof bible !== 'object') {
    issues.push({ field: '_root', severity: 'critical', message: 'cast bible must be an object' });
    return issues;
  }

  // Status enum
  if (bible.status !== undefined && !VALID_STATUS.includes(bible.status)) {
    issues.push({ field: 'status', severity: 'warning', message: `status must be one of ${VALID_STATUS.join(', ')}` });
  }

  // Principals array (allowed to be empty for default bible)
  if (!Array.isArray(bible.principals)) {
    issues.push({ field: 'principals', severity: 'critical', message: 'principals must be an array (may be empty)' });
  } else {
    const seenIndexes = new Set();
    bible.principals.forEach((p, i) => {
      if (!p || typeof p !== 'object') {
        issues.push({ field: `principals[${i}]`, severity: 'critical', message: 'principal must be an object' });
        return;
      }
      if (!Number.isInteger(p.persona_index) || p.persona_index < 0) {
        issues.push({ field: `principals[${i}].persona_index`, severity: 'critical', message: 'persona_index must be a non-negative integer' });
      } else {
        if (seenIndexes.has(p.persona_index)) {
          issues.push({ field: `principals[${i}].persona_index`, severity: 'critical', message: `persona_index ${p.persona_index} duplicated across principals` });
        }
        seenIndexes.add(p.persona_index);
      }
      if (!p.name || typeof p.name !== 'string' || !p.name.trim()) {
        issues.push({ field: `principals[${i}].name`, severity: 'warning', message: 'name should be a non-empty string' });
      }
      if (p.gender_resolved_from !== undefined && !VALID_RESOLVED_FROM.includes(p.gender_resolved_from)) {
        issues.push({ field: `principals[${i}].gender_resolved_from`, severity: 'warning', message: `gender_resolved_from must be one of ${VALID_RESOLVED_FROM.join(', ')}` });
      }
    });
  }

  // Inheritance policy
  const ip = bible.inheritance_policy;
  if (ip && typeof ip === 'object') {
    if (ip.persona_indexes && !VALID_INHERITANCE_PERSONA_INDEXES.includes(ip.persona_indexes)) {
      issues.push({ field: 'inheritance_policy.persona_indexes', severity: 'warning', message: `persona_indexes policy must be one of ${VALID_INHERITANCE_PERSONA_INDEXES.join(', ')}` });
    }
    if (ip.voice_assignments && !VALID_INHERITANCE_VOICE.includes(ip.voice_assignments)) {
      issues.push({ field: 'inheritance_policy.voice_assignments', severity: 'warning', message: `voice_assignments policy must be one of ${VALID_INHERITANCE_VOICE.join(', ')}` });
    }
    if (ip.appearances && !VALID_INHERITANCE_APPEARANCES.includes(ip.appearances)) {
      issues.push({ field: 'inheritance_policy.appearances', severity: 'warning', message: `appearances policy must be one of ${VALID_INHERITANCE_APPEARANCES.join(', ')}` });
    }
  } else if (ip !== undefined) {
    issues.push({ field: 'inheritance_policy', severity: 'warning', message: 'inheritance_policy must be an object when provided' });
  }

  // Locked-status invariants
  if (bible.status === 'locked' && !bible.locked_at) {
    issues.push({ field: 'locked_at', severity: 'warning', message: 'locked_at should be set when status is locked' });
  }

  return issues;
}

/**
 * Merge a partial / authored cast bible with the safe defaults, filling
 * any missing optional fields with default values. Inheritance policy is
 * deep-merged so partial overrides preserve defaults.
 *
 * @param {object} authored
 * @returns {object} merged bible
 */
export function mergeCastBibleDefaults(authored) {
  if (!authored || typeof authored !== 'object') {
    // Deep-clone the frozen default so callers can mutate the result safely
    return _cloneDefault();
  }
  const base = _cloneDefault();
  return {
    ...base,
    ...authored,
    inheritance_policy: {
      ...base.inheritance_policy,
      ...(authored.inheritance_policy && typeof authored.inheritance_policy === 'object' ? authored.inheritance_policy : {})
    },
    principals: Array.isArray(authored.principals) ? authored.principals : base.principals,
    guest_pool: Array.isArray(authored.guest_pool) ? authored.guest_pool : base.guest_pool
  };
}

function _cloneDefault() {
  return {
    status: DEFAULT_CAST_BIBLE.status,
    version: DEFAULT_CAST_BIBLE.version,
    principals: [],
    guest_pool: [],
    locked_at: null,
    inheritance_policy: { ...DEFAULT_CAST_BIBLE.inheritance_policy },
    _generated_by: DEFAULT_CAST_BIBLE._generated_by
  };
}

// ─────────────────────────────────────────────────────────────────────
// Derivation — the heart of the bible
// ─────────────────────────────────────────────────────────────────────

/**
 * Derive a cast bible from a story object — purely structural, no Gemini.
 *
 * Reads from:
 *   - story.persona_config.personas[]    — voice IDs, names, explicit genders
 *   - story.storyline.characters[]       — role, visual_description, arc
 *
 * Resilient to missing storyline.characters (commercial flow may not produce
 * the same shape per Phase 6 of the cinematic plan): falls back to
 * persona_config.personas[] alone, with role defaulted to 'principal' and
 * arc/visual_description omitted.
 *
 * Voice IDs are written into the principal as a SNAPSHOT — the canonical
 * truth remains persona_config.personas[].elevenlabs_voice_id, which
 * resolveCastBibleForStory re-reads on every load. The snapshot here is
 * for the locked-status case where the bible needs to remember what was
 * locked even if persona_config drifts.
 *
 * @param {object} story
 * @returns {object} derived cast bible
 */
export function deriveCastBibleFromStory(story) {
  const personas = _extractPersonas(story);
  const storyCharacters = Array.isArray(story?.storyline?.characters) ? story.storyline.characters : [];

  const principals = personas.map((persona, i) => {
    const storyCharacter = storyCharacters[i] || null;
    const { gender, resolved_from } = inferPersonaGenderForCast(persona, storyCharacter);

    const principal = {
      cast_id: `principal_${i}`,
      persona_index: i,
      name: persona.name || storyCharacter?.name || `Persona ${i + 1}`,
      role: storyCharacter?.role || persona.role || 'principal',
      visual_description: storyCharacter?.visual_description || persona.visual_description || '',
      arc: storyCharacter?.arc || '',
      elevenlabs_voice_id: persona.elevenlabs_voice_id || null,
      elevenlabs_voice_name: persona.elevenlabs_voice_name || null,
      elevenlabs_voice_gender: persona.elevenlabs_voice_gender || null,
      gender_inferred: gender,
      gender_resolved_from: resolved_from,
      voice_gender_match: null // computed below
    };
    principal.voice_gender_match = detectVoiceGenderMismatch(principal);
    return principal;
  });

  return {
    status: 'derived',
    version: 1,
    principals,
    guest_pool: [],
    locked_at: null,
    inheritance_policy: {
      persona_indexes: 'immutable',
      voice_assignments: 'immutable_when_locked',
      appearances: 'mutable_per_episode'
    },
    _generated_by: 'derived_from_storyline'
  };
}

/**
 * Resolve the cast bible for a story. Returns the authored bible if present,
 * else the safe default. NEVER returns null.
 *
 * Importantly, voice fields on the returned bible are RE-RESOLVED from
 * story.persona_config.personas[] on every call (canonical-source contract,
 * Failure Mode #2). voice_gender_match is recomputed on every call for the
 * same reason. The stored bible's voice fields are a snapshot used only as
 * a fallback when persona_config has drifted (e.g., a persona was deleted).
 *
 * @param {object} story
 * @returns {object} resolved cast bible
 */
export function resolveCastBibleForStory(story) {
  if (!story?.cast_bible || typeof story.cast_bible !== 'object') {
    return _cloneDefault();
  }
  const merged = mergeCastBibleDefaults(story.cast_bible);
  const personas = _extractPersonas(story);

  // Re-resolve voice fields from persona_config (canonical truth) on every
  // read. The bible's stored voice fields are snapshots; they re-sync here.
  merged.principals = (merged.principals || []).map(principal => {
    const persona = personas[principal.persona_index];
    if (!persona) return principal; // persona was deleted — keep snapshot
    const live = {
      ...principal,
      elevenlabs_voice_id: persona.elevenlabs_voice_id || principal.elevenlabs_voice_id || null,
      elevenlabs_voice_name: persona.elevenlabs_voice_name || principal.elevenlabs_voice_name || null,
      elevenlabs_voice_gender: persona.elevenlabs_voice_gender || principal.elevenlabs_voice_gender || null
    };
    // Recompute mismatch flag with live voice data
    live.voice_gender_match = detectVoiceGenderMismatch(live);
    return live;
  });

  return merged;
}

/**
 * Extract personas[] from the various shapes story.persona_config can take.
 * Defensive: persona_config can be either { personas: [...] } (multi) or a
 * single persona object (legacy single-persona shape).
 *
 * @param {object} story
 * @returns {Array}
 */
function _extractPersonas(story) {
  const cfg = story?.persona_config;
  if (!cfg) return [];
  if (Array.isArray(cfg.personas)) return cfg.personas;
  if (typeof cfg === 'object' && (cfg.elevenlabs_voice_id || cfg.name || cfg.description)) {
    return [cfg]; // single-persona legacy shape
  }
  return [];
}
