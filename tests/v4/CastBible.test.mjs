// tests/v4/CastBible.test.mjs
// V4 Cast Coherence — Cast Bible.
//
// Run: node --test tests/v4/CastBible.test.mjs
//
// Tests the schema invariants, gender-inference upgrade (Phase 3.5), and
// derive/resolve idempotency of the story-creation-time Cast Bible. The
// bible is a structural snapshot of who's in the show — derived once from
// storyline.characters[] + persona_config.personas[], every per-episode
// screenplay quotes its principals[] as a HARD CONSTRAINT.
//
// We DON'T test the runV4Pipeline integration here (that's an end-to-end
// path tested via the smoke flow). We test the pure-data layer: defaults,
// validation, merge invariants, derivation logic, and the resolve-time
// canonical-source contract (voice fields re-resolved from persona_config).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CAST_BIBLE,
  validateCastBible,
  mergeCastBibleDefaults,
  deriveCastBibleFromStory,
  resolveCastBibleForStory,
  inferPersonaGenderForCast,
  detectVoiceGenderMismatch
} from '../../services/v4/CastBible.js';

// ─────────────────────────────────────────────────────────────────────
// DEFAULT_CAST_BIBLE
// ─────────────────────────────────────────────────────────────────────

describe('DEFAULT_CAST_BIBLE — structural invariants', () => {
  test('default bible passes its own validator with no blockers', () => {
    const issues = validateCastBible(DEFAULT_CAST_BIBLE);
    const blockers = issues.filter(i => i.severity === 'blocker');
    assert.equal(blockers.length, 0, `default bible has blockers: ${JSON.stringify(blockers)}`);
  });

  test('default bible is frozen (mutation safety)', () => {
    assert.ok(Object.isFrozen(DEFAULT_CAST_BIBLE));
    assert.ok(Object.isFrozen(DEFAULT_CAST_BIBLE.inheritance_policy));
  });

  test('default bible has empty principals (opt-in semantics)', () => {
    assert.deepEqual(DEFAULT_CAST_BIBLE.principals, []);
  });

  test('default bible has empty guest_pool (Phase 5b reserved, currently dropped)', () => {
    assert.deepEqual(DEFAULT_CAST_BIBLE.guest_pool, []);
  });

  test('default bible has the three inheritance_policy keys', () => {
    assert.equal(DEFAULT_CAST_BIBLE.inheritance_policy.persona_indexes, 'immutable');
    assert.equal(DEFAULT_CAST_BIBLE.inheritance_policy.voice_assignments, 'immutable_when_locked');
    assert.equal(DEFAULT_CAST_BIBLE.inheritance_policy.appearances, 'mutable_per_episode');
  });
});

// ─────────────────────────────────────────────────────────────────────
// validateCastBible
// ─────────────────────────────────────────────────────────────────────

describe('validateCastBible — blocker rules', () => {
  test('rejects null bible', () => {
    const blockers = validateCastBible(null).filter(i => i.severity === 'blocker');
    assert.ok(blockers.length > 0);
  });

  test('rejects non-object bible', () => {
    const blockers = validateCastBible('not an object').filter(i => i.severity === 'blocker');
    assert.ok(blockers.length > 0);
  });

  test('rejects bible whose principals is not an array', () => {
    const blockers = validateCastBible({ principals: 'nope' }).filter(i => i.severity === 'blocker');
    assert.ok(blockers.some(i => i.field === 'principals'));
  });

  test('rejects principal without persona_index', () => {
    const blockers = validateCastBible({
      principals: [{ name: 'Sydney' }]
    }).filter(i => i.severity === 'blocker');
    assert.ok(blockers.some(i => i.field.includes('persona_index')));
  });

  test('rejects principals with duplicate persona_index', () => {
    const blockers = validateCastBible({
      principals: [
        { persona_index: 0, name: 'A' },
        { persona_index: 0, name: 'B' }
      ]
    }).filter(i => i.severity === 'blocker');
    assert.ok(blockers.some(i => i.message.includes('duplicated')));
  });

  test('accepts empty principals (default bible shape)', () => {
    const blockers = validateCastBible({ principals: [] }).filter(i => i.severity === 'blocker');
    assert.equal(blockers.length, 0);
  });

  test('accepts a fully-formed principal', () => {
    const blockers = validateCastBible({
      principals: [
        { persona_index: 0, name: 'Sydney', gender_resolved_from: 'storyline_signal' }
      ]
    }).filter(i => i.severity === 'blocker');
    assert.equal(blockers.length, 0);
  });

  test('warns on invalid gender_resolved_from value', () => {
    const warnings = validateCastBible({
      principals: [
        { persona_index: 0, name: 'X', gender_resolved_from: 'made_up' }
      ]
    }).filter(i => i.severity === 'warning');
    assert.ok(warnings.some(i => i.field.includes('gender_resolved_from')));
  });
});

// ─────────────────────────────────────────────────────────────────────
// mergeCastBibleDefaults
// ─────────────────────────────────────────────────────────────────────

describe('mergeCastBibleDefaults', () => {
  test('returns mutable clone of default for null input', () => {
    const merged = mergeCastBibleDefaults(null);
    // Must be mutable (callers mutate the result, e.g. setting status='locked')
    merged.status = 'locked';
    assert.equal(merged.status, 'locked');
  });

  test('preserves authored principals[]', () => {
    const merged = mergeCastBibleDefaults({
      principals: [{ persona_index: 0, name: 'Sydney' }]
    });
    assert.equal(merged.principals.length, 1);
    assert.equal(merged.principals[0].name, 'Sydney');
  });

  test('deep-merges inheritance_policy (partial override preserves defaults)', () => {
    const merged = mergeCastBibleDefaults({
      inheritance_policy: { appearances: 'overridable' }
    });
    assert.equal(merged.inheritance_policy.appearances, 'overridable');
    assert.equal(merged.inheritance_policy.persona_indexes, 'immutable'); // default preserved
    assert.equal(merged.inheritance_policy.voice_assignments, 'immutable_when_locked'); // default preserved
  });

  test('coerces non-array principals to default empty array', () => {
    const merged = mergeCastBibleDefaults({ principals: 'not an array' });
    assert.deepEqual(merged.principals, []);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Phase 3.5 — inferPersonaGenderForCast
// ─────────────────────────────────────────────────────────────────────

describe('Phase 3.5 — inferPersonaGenderForCast', () => {
  test('returns persona_explicit when persona.gender is set directly', () => {
    const result = inferPersonaGenderForCast({ name: 'Persona 1', gender: 'female' }, null);
    assert.equal(result.gender, 'female');
    assert.equal(result.resolved_from, 'persona_explicit');
  });

  test('returns persona_explicit when persona.sex is set directly', () => {
    const result = inferPersonaGenderForCast({ name: 'Persona 1', sex: 'm' }, null);
    assert.equal(result.gender, 'male');
    assert.equal(result.resolved_from, 'persona_explicit');
  });

  test('returns persona_signal when persona text alone is sufficient', () => {
    const result = inferPersonaGenderForCast(
      { name: 'Sydney', description: 'A woman in her thirties. She is determined. Her hair is dark.' },
      null
    );
    assert.equal(result.gender, 'female');
    assert.equal(result.resolved_from, 'persona_signal');
  });

  test('returns storyline_signal when persona is sparse but storyline character carries gender markers', () => {
    const result = inferPersonaGenderForCast(
      { name: 'Persona 1' }, // sparse placeholder
      { name: 'Persona 1', visual_description: 'A young woman in her late twenties, long dark hair, wearing a blue dress. She walks with confidence.', arc: 'She learns to trust herself.' }
    );
    assert.equal(result.gender, 'female');
    assert.equal(result.resolved_from, 'storyline_signal');
  });

  test('returns unknown when neither persona nor storyline has signal', () => {
    const result = inferPersonaGenderForCast(
      { name: 'Persona 1' },
      { name: 'Persona 1', visual_description: 'a person', arc: 'change happens' }
    );
    assert.equal(result.gender, 'unknown');
    assert.equal(result.resolved_from, 'unknown');
  });

  test('falls back to persona-only inference when storyline name does not align (defensive index drift)', () => {
    // Persona is named "Sydney" but storyline.characters[i] is named "Marcus" with strong male markers.
    // We should NOT use the storyline signal because the indexes are misaligned.
    const result = inferPersonaGenderForCast(
      { name: 'Sydney' },
      { name: 'Marcus', visual_description: 'A bearded man in a tuxedo. He is the king of his domain. His gaze is steady.' }
    );
    assert.equal(result.gender, 'unknown'); // NOT 'male' from misaligned storyline
    assert.equal(result.resolved_from, 'unknown');
  });

  test('placeholder persona names ("Persona 1") always align with storyline character (cannot disprove)', () => {
    const result = inferPersonaGenderForCast(
      { name: 'Persona 1' },
      { name: 'Sydney', visual_description: 'A woman with long red hair. She is a single mother. Her eyes are tired.' }
    );
    assert.equal(result.gender, 'female');
    assert.equal(result.resolved_from, 'storyline_signal');
  });

  test('handles null persona gracefully', () => {
    const result = inferPersonaGenderForCast(null, null);
    assert.equal(result.gender, 'unknown');
    assert.equal(result.resolved_from, 'unknown');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Phase 3.5 — detectVoiceGenderMismatch
// ─────────────────────────────────────────────────────────────────────

describe('Phase 3.5 — detectVoiceGenderMismatch', () => {
  test('returns null when persona gender unknown', () => {
    const r = detectVoiceGenderMismatch({ gender_inferred: 'unknown', elevenlabs_voice_gender: 'male' });
    assert.equal(r, null);
  });

  test('returns null when voice gender unknown', () => {
    const r = detectVoiceGenderMismatch({ gender_inferred: 'female', elevenlabs_voice_gender: 'unknown' });
    assert.equal(r, null);
  });

  test('returns true when both genders match', () => {
    const r = detectVoiceGenderMismatch({ gender_inferred: 'female', elevenlabs_voice_gender: 'female' });
    assert.equal(r, true);
  });

  test('returns false when genders disagree (the bug we surface)', () => {
    const r = detectVoiceGenderMismatch({ gender_inferred: 'female', elevenlabs_voice_gender: 'male' });
    assert.equal(r, false);
  });

  test('returns true when one side is neutral (no claim of mismatch)', () => {
    const r = detectVoiceGenderMismatch({ gender_inferred: 'female', elevenlabs_voice_gender: 'neutral' });
    assert.equal(r, true);
  });

  test('returns null on null/missing principal', () => {
    assert.equal(detectVoiceGenderMismatch(null), null);
    assert.equal(detectVoiceGenderMismatch({}), null);
  });
});

// ─────────────────────────────────────────────────────────────────────
// deriveCastBibleFromStory
// ─────────────────────────────────────────────────────────────────────

describe('deriveCastBibleFromStory', () => {
  test('derives one principal per persona, mapped 1:1 with storyline.characters', () => {
    const story = {
      persona_config: {
        personas: [
          { name: 'Sydney', elevenlabs_voice_id: 'EXAVITQ', elevenlabs_voice_name: 'Rachel', elevenlabs_voice_gender: 'female' }
        ]
      },
      storyline: {
        characters: [
          { name: 'Sydney', role: 'protagonist', visual_description: 'A young woman in her thirties, dark hair.', arc: 'She finds her voice.' }
        ]
      }
    };
    const bible = deriveCastBibleFromStory(story);
    assert.equal(bible.principals.length, 1);
    const p = bible.principals[0];
    assert.equal(p.persona_index, 0);
    assert.equal(p.name, 'Sydney');
    assert.equal(p.role, 'protagonist');
    assert.equal(p.elevenlabs_voice_id, 'EXAVITQ');
    assert.equal(p.gender_inferred, 'female');
    // Could be persona_signal OR storyline_signal depending on which fired first; both are valid
    assert.ok(['persona_signal', 'storyline_signal', 'persona_explicit'].includes(p.gender_resolved_from));
    assert.equal(p.voice_gender_match, true);
  });

  test('falls back to persona_config alone when storyline.characters is missing', () => {
    const story = {
      persona_config: {
        personas: [
          { name: 'Sydney', gender: 'female', elevenlabs_voice_id: 'EXAVITQ', elevenlabs_voice_gender: 'female' },
          { name: 'Marcus', gender: 'male', elevenlabs_voice_id: 'TX3LPaO', elevenlabs_voice_gender: 'male' }
        ]
      }
      // storyline missing entirely
    };
    const bible = deriveCastBibleFromStory(story);
    assert.equal(bible.principals.length, 2);
    assert.equal(bible.principals[0].role, 'principal'); // default when storyline.characters[i] missing
    assert.equal(bible.principals[0].arc, '');
    assert.equal(bible.principals[0].gender_inferred, 'female');
    assert.equal(bible.principals[0].gender_resolved_from, 'persona_explicit');
  });

  test('handles legacy single-persona shape (story.persona_config is the persona itself)', () => {
    const story = {
      persona_config: { name: 'Solo', elevenlabs_voice_id: 'X', gender: 'female' }
    };
    const bible = deriveCastBibleFromStory(story);
    assert.equal(bible.principals.length, 1);
    assert.equal(bible.principals[0].name, 'Solo');
  });

  test('produces empty principals when no personas exist', () => {
    const bible = deriveCastBibleFromStory({});
    assert.deepEqual(bible.principals, []);
  });

  test('uses placeholder names for unnamed personas with storyline backup', () => {
    const story = {
      persona_config: {
        personas: [{ /* no name */ }]
      },
      storyline: {
        characters: [{ name: 'Aria', role: 'protagonist', visual_description: 'A woman, age 30, athletic build, short hair.' }]
      }
    };
    const bible = deriveCastBibleFromStory(story);
    assert.equal(bible.principals[0].name, 'Aria'); // pulled from storyline character
  });

  test('records voice_gender_match for each principal', () => {
    const story = {
      persona_config: {
        personas: [
          // Female persona with male voice — the bug we surface
          { name: 'Sydney', gender: 'female', elevenlabs_voice_id: 'X', elevenlabs_voice_gender: 'male' }
        ]
      }
    };
    const bible = deriveCastBibleFromStory(story);
    assert.equal(bible.principals[0].voice_gender_match, false);
  });

  test('produces _generated_by: derived_from_storyline by default', () => {
    const bible = deriveCastBibleFromStory({ persona_config: { personas: [{ name: 'A' }] } });
    assert.equal(bible._generated_by, 'derived_from_storyline');
  });
});

// ─────────────────────────────────────────────────────────────────────
// resolveCastBibleForStory — canonical-source contract
// ─────────────────────────────────────────────────────────────────────

describe('resolveCastBibleForStory — canonical source contract', () => {
  test('returns DEFAULT_CAST_BIBLE clone when story.cast_bible is null', () => {
    const resolved = resolveCastBibleForStory({ cast_bible: null });
    assert.deepEqual(resolved.principals, []);
    // Mutation safety — caller can mutate the result
    resolved.status = 'locked';
    assert.equal(resolved.status, 'locked');
  });

  test('returns DEFAULT clone when story has no cast_bible field at all', () => {
    const resolved = resolveCastBibleForStory({});
    assert.deepEqual(resolved.principals, []);
  });

  test('re-resolves voice fields from persona_config (canonical truth) on every read', () => {
    // Stored bible has stale voice ID; persona_config has the fresh one.
    const story = {
      cast_bible: {
        status: 'derived',
        principals: [
          { persona_index: 0, name: 'Sydney', elevenlabs_voice_id: 'STALE', elevenlabs_voice_name: 'OldVoice', elevenlabs_voice_gender: 'female', gender_inferred: 'female' }
        ],
        inheritance_policy: { persona_indexes: 'immutable', voice_assignments: 'immutable_when_locked', appearances: 'mutable_per_episode' }
      },
      persona_config: {
        personas: [
          { name: 'Sydney', elevenlabs_voice_id: 'FRESH', elevenlabs_voice_name: 'NewVoice', elevenlabs_voice_gender: 'female' }
        ]
      }
    };
    const resolved = resolveCastBibleForStory(story);
    assert.equal(resolved.principals[0].elevenlabs_voice_id, 'FRESH');
    assert.equal(resolved.principals[0].elevenlabs_voice_name, 'NewVoice');
  });

  test('falls back to stored snapshot voice when persona_config has drifted (persona deleted)', () => {
    const story = {
      cast_bible: {
        status: 'derived',
        principals: [
          // persona_index 5 — but persona_config only has 1 persona
          { persona_index: 5, name: 'Ghost', elevenlabs_voice_id: 'SNAPSHOT' }
        ]
      },
      persona_config: {
        personas: [{ name: 'Other' }]
      }
    };
    const resolved = resolveCastBibleForStory(story);
    // Snapshot preserved when persona doesn't exist anymore
    assert.equal(resolved.principals[0].elevenlabs_voice_id, 'SNAPSHOT');
  });

  test('recomputes voice_gender_match using LIVE voice data (catches mismatch added post-derive)', () => {
    const story = {
      cast_bible: {
        status: 'derived',
        principals: [
          // Stored: persona is female, voice was female → match was true at derive time
          { persona_index: 0, name: 'Sydney', gender_inferred: 'female', elevenlabs_voice_id: 'OLD', elevenlabs_voice_gender: 'female', voice_gender_match: true }
        ]
      },
      persona_config: {
        // Live: voice was changed to a male voice (e.g., user manual override)
        personas: [{ name: 'Sydney', elevenlabs_voice_id: 'NEW_MALE', elevenlabs_voice_gender: 'male' }]
      }
    };
    const resolved = resolveCastBibleForStory(story);
    // Mismatch should now be flagged, not the stale stored true
    assert.equal(resolved.principals[0].voice_gender_match, false);
  });

  test('NEVER returns null', () => {
    assert.notEqual(resolveCastBibleForStory(null), null);
    assert.notEqual(resolveCastBibleForStory(undefined), null);
    assert.notEqual(resolveCastBibleForStory({}), null);
  });
});
