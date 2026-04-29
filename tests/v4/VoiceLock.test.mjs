// tests/v4/VoiceLock.test.mjs
//
// Documents and tests the character↔voice lock contract end-to-end at the
// pure-function layer (no live Vertex / DB calls). The contract is:
//
//   1. Within a single story, every persona's elevenlabs_voice_id is unique.
//   2. The voice's gender matches the persona's inferred gender (when the
//      inference is strong; 'unknown' inferences allow any voice).
//   3. The lock is enforced at TWO entry points:
//        (a) Auto-acquisition: acquirePersonaVoicesForStory + acquirePersonaVoice
//            — uses takenVoiceIds Set to filter Gemini's candidate pool.
//        (b) Manual override: PATCH /personas/:idx/voice route validates
//            against existing personas + gender before persisting.
//   4. The pre-acquisition idempotent re-validation re-runs (a) and auto-
//      remediates any persona whose stored voice is invalid.
//
// These tests exercise the building blocks. Route-level integration tests
// live in tests/integration/ if/when they're added.
//
// Run: node --test tests/v4/VoiceLock.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  inferPersonaGender,
  getVoiceLibrary
} from '../../services/v4/VoiceAcquisition.js';

describe('Voice library — sanity', () => {
  test('library is loaded with at least 20 voices, balanced by gender', () => {
    const lib = getVoiceLibrary();
    assert.ok(lib.length >= 20, `expected ≥20 voices, got ${lib.length}`);
    const male = lib.filter(v => String(v.gender || '').toLowerCase() === 'male').length;
    const female = lib.filter(v => String(v.gender || '').toLowerCase() === 'female').length;
    assert.ok(male >= 10, `expected ≥10 male voices, got ${male}`);
    assert.ok(female >= 10, `expected ≥10 female voices, got ${female}`);
  });

  test('every library entry has voice_id, name, gender', () => {
    for (const v of getVoiceLibrary()) {
      assert.ok(v.voice_id, `entry missing voice_id: ${JSON.stringify(v)}`);
      assert.ok(v.name, `entry missing name: ${JSON.stringify(v)}`);
      assert.ok(v.gender, `entry missing gender: ${JSON.stringify(v)}`);
    }
  });

  test('no duplicate voice_ids in the library (the lock would be unenforceable)', () => {
    const ids = getVoiceLibrary().map(v => v.voice_id);
    assert.equal(new Set(ids).size, ids.length, 'voice_ids must be unique');
  });
});

describe('Voice-lock — uniqueness pre-condition for the manual override route', () => {
  // The PATCH route at routes/brand-stories.js validates voice_id is not
  // already held by another persona via this same predicate.
  function findCollidingPersona(personas, targetIdx, voice_id) {
    return personas.findIndex((p, i) =>
      i !== targetIdx && p && p.elevenlabs_voice_id === voice_id
    );
  }

  test('two personas with the same voice → collision detected', () => {
    const personas = [
      { name: 'Maya',   elevenlabs_voice_id: 'voice_A' },
      { name: 'Daniel', elevenlabs_voice_id: 'voice_B' }
    ];
    const colliding = findCollidingPersona(personas, /* assigning to */ 1, 'voice_A');
    assert.equal(colliding, 0, 'persona 1 trying to take voice_A should collide with persona 0');
  });

  test('reassigning a persona to its OWN current voice is a no-op (no false collision)', () => {
    const personas = [
      { name: 'Maya',   elevenlabs_voice_id: 'voice_A' },
      { name: 'Daniel', elevenlabs_voice_id: 'voice_B' }
    ];
    const colliding = findCollidingPersona(personas, /* assigning to */ 0, 'voice_A');
    assert.equal(colliding, -1, 'persona 0 keeping voice_A should not be flagged as colliding with itself');
  });

  test('first-time assignment (no other persona has this voice) → no collision', () => {
    const personas = [
      { name: 'Maya',   elevenlabs_voice_id: null },
      { name: 'Daniel', elevenlabs_voice_id: 'voice_B' }
    ];
    const colliding = findCollidingPersona(personas, 0, 'voice_C');
    assert.equal(colliding, -1);
  });

  test('three personas, lock holds across all pairings', () => {
    const personas = [
      { name: 'A', elevenlabs_voice_id: 'v1' },
      { name: 'B', elevenlabs_voice_id: 'v2' },
      { name: 'C', elevenlabs_voice_id: 'v3' }
    ];
    // Try assigning persona 2 to voice already held by persona 0
    assert.equal(findCollidingPersona(personas, 2, 'v1'), 0);
    // Try assigning persona 0 to voice already held by persona 1
    assert.equal(findCollidingPersona(personas, 0, 'v2'), 1);
    // Try assigning persona 1 to a fresh voice
    assert.equal(findCollidingPersona(personas, 1, 'v_fresh'), -1);
  });
});

describe('Voice-lock — gender enforcement on manual override', () => {
  // The PATCH route uses inferPersonaGender + library entry's gender to
  // reject mismatches. inferPersonaGender returns 'unknown' on ambiguous
  // text, which the route treats as "no constraint" (any voice allowed).
  test('explicit female persona → inferred female → male voice rejected', () => {
    const persona = {
      name: 'Claire',
      gender: 'female',
      description: 'A 42-year-old woman running a seaside hotel'
    };
    const inferred = inferPersonaGender(persona);
    assert.equal(inferred, 'female');
    // Pseudo library entry the route would look up for the picked voice
    const voiceEntry = { voice_id: 'brian_male', name: 'Brian', gender: 'male' };
    const voiceGender = String(voiceEntry.gender || '').toLowerCase();
    assert.notEqual(voiceGender, inferred, 'route must reject this combination');
  });

  test('ambiguous persona description → inferred unknown → any voice allowed', () => {
    const persona = {
      name: 'The Voice',
      description: 'A mysterious narrator'
    };
    const inferred = inferPersonaGender(persona);
    assert.equal(inferred, 'unknown');
    // The route's gender check is skipped when inferred==='unknown',
    // so any voice (male or female) is acceptable.
  });

  test('explicit male persona → inferred male → female voice rejected', () => {
    const persona = {
      name: 'Noah',
      gender: 'male',
      description: 'A 44-year-old man, ex-architect, husband'
    };
    const inferred = inferPersonaGender(persona);
    assert.equal(inferred, 'male');
    const voiceEntry = { voice_id: 'rachel_female', name: 'Rachel', gender: 'female' };
    const voiceGender = String(voiceEntry.gender || '').toLowerCase();
    assert.notEqual(voiceGender, inferred);
  });
});

describe('Voice-lock — full chain invariant (post-acquisition state)', () => {
  // After acquirePersonaVoicesForStory mutates the personas in place, the
  // following invariants MUST hold. These tests document the contract for
  // any future code that reads or mutates persona_config.
  function assertLockInvariants(personas, library) {
    const voiceIds = personas.map(p => p?.elevenlabs_voice_id).filter(Boolean);
    // 1. Every voice is in the library
    for (const id of voiceIds) {
      const entry = library.find(v => v.voice_id === id);
      assert.ok(entry, `voice_id ${id} must be in the library`);
    }
    // 2. No duplicates across personas
    assert.equal(new Set(voiceIds).size, voiceIds.length,
      `every persona must have a UNIQUE elevenlabs_voice_id`);
    // 3. Gender matches inference (when inferred is not 'unknown')
    for (const p of personas) {
      if (!p?.elevenlabs_voice_id) continue;
      const entry = library.find(v => v.voice_id === p.elevenlabs_voice_id);
      const inferred = inferPersonaGender(p);
      if (inferred !== 'unknown') {
        assert.equal(
          String(entry.gender || '').toLowerCase(),
          inferred,
          `persona "${p.name || 'unnamed'}" voice gender mismatch: voice=${entry.gender}, inferred=${inferred}`
        );
      }
    }
  }

  test('hand-built valid 3-persona lock satisfies all invariants', () => {
    const lib = getVoiceLibrary();
    const female1 = lib.find(v => String(v.gender).toLowerCase() === 'female');
    const female2 = lib.filter(v => String(v.gender).toLowerCase() === 'female')[1];
    const male1 = lib.find(v => String(v.gender).toLowerCase() === 'male');

    const personas = [
      { name: 'Claire', gender: 'female', elevenlabs_voice_id: female1.voice_id },
      { name: 'Maya',   gender: 'female', elevenlabs_voice_id: female2.voice_id },
      { name: 'Noah',   gender: 'male',   elevenlabs_voice_id: male1.voice_id }
    ];

    assertLockInvariants(personas, lib);
  });

  test('duplicate voice_id across personas violates invariant', () => {
    const lib = getVoiceLibrary();
    const female1 = lib.find(v => String(v.gender).toLowerCase() === 'female');
    const personas = [
      { name: 'Claire', gender: 'female', elevenlabs_voice_id: female1.voice_id },
      { name: 'Maya',   gender: 'female', elevenlabs_voice_id: female1.voice_id } // duplicate
    ];
    assert.throws(() => assertLockInvariants(personas, lib), /UNIQUE/);
  });

  test('female persona cast with male voice violates invariant', () => {
    const lib = getVoiceLibrary();
    const male1 = lib.find(v => String(v.gender).toLowerCase() === 'male');
    const personas = [
      { name: 'Claire', gender: 'female', elevenlabs_voice_id: male1.voice_id }
    ];
    assert.throws(() => assertLockInvariants(personas, lib), /gender mismatch/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// V4 Wave 6 / F3 — Fix 6 auto-recast skips when bible is locked
// ─────────────────────────────────────────────────────────────────────
//
// The auto-recast logic itself lives in BrandStoryService.runV4Pipeline (it
// orchestrates persona-config mutation + acquirePersonaVoicesForStory + bible
// re-derivation). Direct testing of that orchestration would require the
// full pipeline harness — out of scope for this unit suite. What we CAN test
// here is the structural invariant: when cast_bible.status === 'locked', the
// auto-recast trigger condition (the boolean predicate) must evaluate to
// false. This guards the behavioral contract at the predicate level.

describe('V4 Wave 6 / F3 — auto-recast trigger predicate (locked-bible guard)', () => {
  // Mirrors the predicate inside BrandStoryService cast_bible block:
  //   const bibleLocked = story.cast_bible?.status === 'locked';
  //   const mismatchedHighConfidence = bibleLocked
  //     ? []
  //     : bible.principals.filter(p =>
  //         p.voice_gender_match === false
  //         && p.gender_resolved_from === 'visual_anchor'
  //       );
  //   if (mismatchedHighConfidence.length > 0) { /* recast */ }
  function shouldAutoRecast(bible, status) {
    if (status === 'locked') return false;
    return (bible.principals || []).some(p =>
      p.voice_gender_match === false
      && p.gender_resolved_from === 'visual_anchor'
    );
  }

  test('locked bible + high-confidence mismatch → NO auto-recast', () => {
    const bible = {
      principals: [{
        persona_index: 0,
        voice_gender_match: false,
        gender_resolved_from: 'visual_anchor'
      }]
    };
    assert.equal(shouldAutoRecast(bible, 'locked'), false);
  });

  test('unlocked bible + high-confidence mismatch → auto-recast fires', () => {
    const bible = {
      principals: [{
        persona_index: 0,
        voice_gender_match: false,
        gender_resolved_from: 'visual_anchor'
      }]
    };
    assert.equal(shouldAutoRecast(bible, 'derived'), true);
  });

  test('unlocked bible + weak-signal mismatch (storyline_signal) → NO auto-recast (chip path)', () => {
    const bible = {
      principals: [{
        persona_index: 0,
        voice_gender_match: false,
        gender_resolved_from: 'storyline_signal'
      }]
    };
    assert.equal(shouldAutoRecast(bible, 'derived'), false);
  });

  test('unlocked bible + persona_signal mismatch → NO auto-recast (chip path)', () => {
    const bible = {
      principals: [{
        persona_index: 0,
        voice_gender_match: false,
        gender_resolved_from: 'persona_signal'
      }]
    };
    assert.equal(shouldAutoRecast(bible, 'derived'), false);
  });

  test('mixed mismatches: only high-confidence ones flip the trigger', () => {
    const bible = {
      principals: [
        { persona_index: 0, voice_gender_match: false, gender_resolved_from: 'storyline_signal' },
        { persona_index: 1, voice_gender_match: false, gender_resolved_from: 'visual_anchor' }
      ]
    };
    assert.equal(shouldAutoRecast(bible, 'derived'), true); // index 1 is enough
  });

  test('locked bible with mixed mismatches → still NO auto-recast (lock is total)', () => {
    const bible = {
      principals: [
        { persona_index: 0, voice_gender_match: false, gender_resolved_from: 'storyline_signal' },
        { persona_index: 1, voice_gender_match: false, gender_resolved_from: 'visual_anchor' }
      ]
    };
    assert.equal(shouldAutoRecast(bible, 'locked'), false);
  });

  test('all matches + unlocked → no trigger', () => {
    const bible = {
      principals: [
        { persona_index: 0, voice_gender_match: true, gender_resolved_from: 'visual_anchor' }
      ]
    };
    assert.equal(shouldAutoRecast(bible, 'derived'), false);
  });
});
