// tests/v4/VoiceAcquisition.test.mjs
// Unit tests for gender inference + the uniqueness-and-gender contract
// enforced by acquirePersonaVoicesForStory.
//
// The batch path is tested by simulating its behaviour against a fake
// voice library — we can't run Gemini in a unit test. The helper that's
// exported directly (inferPersonaGender) is tested against real persona
// shapes pulled from production personas.
//
// Run: node --test tests/v4/VoiceAcquisition.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { inferPersonaGender, getVoiceLibrary } from '../../services/v4/VoiceAcquisition.js';

describe('inferPersonaGender — explicit gender field', () => {
  test('persona.gender="male" → male', () => {
    assert.equal(inferPersonaGender({ gender: 'male' }), 'male');
    assert.equal(inferPersonaGender({ gender: 'Male' }), 'male');
    assert.equal(inferPersonaGender({ gender: 'M' }), 'male');
    assert.equal(inferPersonaGender({ gender: 'man' }), 'male');
  });

  test('persona.gender="female" → female', () => {
    assert.equal(inferPersonaGender({ gender: 'female' }), 'female');
    assert.equal(inferPersonaGender({ gender: 'FEMALE' }), 'female');
    assert.equal(inferPersonaGender({ gender: 'F' }), 'female');
    assert.equal(inferPersonaGender({ gender: 'woman' }), 'female');
  });

  test('persona.sex also accepted', () => {
    assert.equal(inferPersonaGender({ sex: 'female' }), 'female');
    assert.equal(inferPersonaGender({ sex: 'male' }), 'male');
  });

  test('unknown explicit value → falls through to text inference', () => {
    assert.equal(inferPersonaGender({ gender: 'nonbinary' }), 'unknown');
    assert.equal(inferPersonaGender({ gender: '' }), 'unknown');
  });
});

describe('inferPersonaGender — text inference (female)', () => {
  test('explicit "woman" in description → female', () => {
    const p = { description: 'A woman in her early thirties, intense stare' };
    // Only 1 marker — should still infer female because it's a strong word
    // and paired with "her" makes 2 markers total.
    assert.equal(inferPersonaGender(p), 'female');
  });

  test('pronouns she/her in personality → female', () => {
    const p = {
      personality: 'She is sharp, guarded, unwilling to let her past define her',
      appearance: 'Shoulder-length black hair'
    };
    assert.equal(inferPersonaGender(p), 'female');
  });

  test('wardrobe hints alone can indicate female if paired with pronouns', () => {
    const p = {
      appearance: 'wearing a charcoal dress and earrings',
      personality: 'she carries her clipboard everywhere'
    };
    assert.equal(inferPersonaGender(p), 'female');
  });

  test('role + pronouns', () => {
    const p = {
      name: 'Ayla',
      role: 'protagonist',
      description: 'mother of two',
      personality: 'her loyalty is legendary'
    };
    assert.equal(inferPersonaGender(p), 'female');
  });
});

describe('inferPersonaGender — text inference (male)', () => {
  test('explicit "man" + pronouns → male', () => {
    const p = {
      description: 'A middle-aged man',
      personality: 'He pretends indifference, his silence cuts deeper than words'
    };
    assert.equal(inferPersonaGender(p), 'male');
  });

  test('visual markers (beard, stubble) + pronouns', () => {
    const p = {
      appearance: 'A weathered face, three-day stubble, grey-streaked beard',
      personality: 'his patience is calculated'
    };
    assert.equal(inferPersonaGender(p), 'male');
  });

  test('father, son, husband markers', () => {
    const p = {
      description: 'A father trying to reconnect with his son after years apart',
      personality: 'husband-first, workaholic-second'
    };
    assert.equal(inferPersonaGender(p), 'male');
  });
});

describe('inferPersonaGender — unknown (ambiguous or empty)', () => {
  test('empty persona → unknown', () => {
    assert.equal(inferPersonaGender({}), 'unknown');
    assert.equal(inferPersonaGender(null), 'unknown');
    assert.equal(inferPersonaGender(undefined), 'unknown');
  });

  test('gender-neutral description → unknown', () => {
    const p = {
      name: 'Sam',
      description: 'A junior architect with a taste for brutalist buildings',
      personality: 'precise, detail-obsessed, terse'
    };
    assert.equal(inferPersonaGender(p), 'unknown');
  });

  test('weak one-marker signal → unknown (conservative)', () => {
    // Only one marker, not enough to commit
    const p = { personality: 'she is focused' };
    assert.equal(inferPersonaGender(p), 'unknown');
  });

  test('conflicting markers → unknown', () => {
    // "His" and "her" both present — ambiguous
    const p = {
      description: 'His and her twin protagonists, bound by a single secret',
      personality: 'his quiet, her fire, balanced'
    };
    // Equal counts → unknown
    assert.equal(inferPersonaGender(p), 'unknown');
  });
});

describe('inferPersonaGender — robustness (no false positives)', () => {
  test('word "history" does not trigger "his"', () => {
    const p = { description: 'A scholar of ancient history and mythology' };
    assert.equal(inferPersonaGender(p), 'unknown');
  });

  test('word "here" does not trigger "her"', () => {
    const p = { description: 'The character arrives here at the turning point' };
    assert.equal(inferPersonaGender(p), 'unknown');
  });

  test('word "therefore" does not trigger "here"-family markers', () => {
    const p = { description: 'Therefore they were chosen to lead' };
    assert.equal(inferPersonaGender(p), 'unknown');
  });
});

describe('voice library integrity (gender diversity)', () => {
  test('library has both genders represented', () => {
    const lib = getVoiceLibrary();
    assert.ok(lib.length > 0, 'library must be non-empty');
    const males = lib.filter(v => String(v.gender).toLowerCase() === 'male');
    const females = lib.filter(v => String(v.gender).toLowerCase() === 'female');
    assert.ok(males.length >= 3, `need >=3 male voices to serve multi-persona stories; have ${males.length}`);
    assert.ok(females.length >= 3, `need >=3 female voices to serve multi-persona stories; have ${females.length}`);
  });

  test('every library entry has gender explicitly set', () => {
    const lib = getVoiceLibrary();
    for (const v of lib) {
      const g = String(v.gender || '').toLowerCase();
      assert.ok(g === 'male' || g === 'female',
        `voice ${v.voice_id} (${v.name}) must have gender set to "male" or "female", got "${v.gender}"`);
    }
  });

  test('no duplicate voice_ids in the library', () => {
    const lib = getVoiceLibrary();
    const ids = lib.map(v => v.voice_id);
    const unique = new Set(ids);
    assert.equal(unique.size, ids.length, 'library contains duplicate voice_ids');
  });
});

// ─────────────────────────────────────────────────────────────
// Contract tests for the batch-acquisition invariants.
// We can't run Gemini in a unit test, so we validate the properties
// the batch enforces: gender matching, uniqueness, and the auto-remediation
// triggers. Structural tests at the post-condition level.
// ─────────────────────────────────────────────────────────────

describe('voice-acquisition batch contract (structural, no Gemini)', () => {
  test('real production incident shape: 3 personas all assigned same voice_id → detected as invalid', () => {
    // Reproduces the 2026-04-23 incident: all three personas had the same
    // voice_id assigned. The batch path SHOULD flag each subsequent persona
    // as "duplicate" and mark it for re-casting. We simulate this detection
    // by checking the in-memory state before acquisition is called.
    const lib = getVoiceLibrary();
    const brian = lib.find(v => v.name === 'Brian');
    assert.ok(brian, 'Brian voice must exist in library for this test');

    const personas = [
      { name: 'Leo', gender: 'male', elevenlabs_voice_id: brian.voice_id },
      { name: 'Marcus', gender: 'male', elevenlabs_voice_id: brian.voice_id }, // duplicate
      { name: 'Ayla', gender: 'female', elevenlabs_voice_id: brian.voice_id }  // duplicate AND wrong gender
    ];

    // Simulate the pass-1 validation the batch does
    const taken = new Set();
    const results = personas.map(p => {
      const entry = lib.find(v => v.voice_id === p.elevenlabs_voice_id);
      const inferred = inferPersonaGender(p);
      const isValid = (() => {
        if (!entry) return 'entry-not-in-library';
        if (taken.has(p.elevenlabs_voice_id)) return 'duplicate';
        if (inferred !== 'unknown' && String(entry.gender).toLowerCase() !== inferred) return 'gender-mismatch';
        return true;
      })();
      if (isValid === true) taken.add(p.elevenlabs_voice_id);
      return { name: p.name, valid: isValid };
    });

    assert.equal(results[0].valid, true, 'first persona with matching gender is valid');
    assert.equal(results[1].valid, 'duplicate', 'second persona with same voice_id must be flagged as duplicate');
    assert.equal(results[2].valid, 'duplicate', 'third persona: duplicate takes priority over gender check');
    // In the real batch, #2 and #3 would trigger re-casting.
  });

  test('female persona with Brian (male) voice → detected as gender mismatch (not duplicate)', () => {
    const lib = getVoiceLibrary();
    const brian = lib.find(v => v.name === 'Brian');
    const personas = [{ name: 'Ayla', gender: 'female', elevenlabs_voice_id: brian.voice_id }];
    const taken = new Set();
    const entry = lib.find(v => v.voice_id === personas[0].elevenlabs_voice_id);
    const inferred = inferPersonaGender(personas[0]);
    const isValid = !(inferred !== 'unknown' && String(entry.gender).toLowerCase() !== inferred);
    assert.equal(isValid, false, 'gender mismatch must be detected');
    assert.equal(inferred, 'female');
    assert.equal(String(entry.gender).toLowerCase(), 'male');
  });
});
