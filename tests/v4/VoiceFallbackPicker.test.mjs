// tests/v4/VoiceFallbackPicker.test.mjs
//
// Cast Bible follow-up (2026-04-28) — defense-in-depth fallback picker that
// replaces three production "Brian fallback" sites:
//   - services/BrandStoryService.js:1149 (OmniHuman dialogue)
//   - services/BrandStoryService.js:5478 (V3 narration)
//   - services/BrandStoryService.js:3660 + 4511 (V4 defaultNarratorVoiceId)
//   - services/beat-generators/VoiceoverBRollGenerator.js:51 (V.O. B-roll)
//
// The picker is gender + persona-aware; produces a creatively-sensible match
// from the curated 26-voice library (13 male + 13 female) without ever
// silently casting a male voice over a female persona.
//
// Run: node --test tests/v4/VoiceFallbackPicker.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  pickFallbackVoiceForPersona,
  pickFallbackVoiceIdForPersonaInList,
  getVoiceLibrary
} from '../../services/v4/VoiceAcquisition.js';

const LIBRARY = getVoiceLibrary();

describe('pickFallbackVoiceForPersona — gender correctness', () => {
  test('female persona returns a female voice', () => {
    const persona = {
      name: 'Sydney',
      description: 'A woman in her thirties. She is determined. Her hair is dark.',
      personality: 'warm, deliberate, focused'
    };
    const picked = pickFallbackVoiceForPersona(persona, { reason: 'test' });
    assert.ok(picked);
    assert.equal(String(picked.gender).toLowerCase(), 'female',
      `expected female voice for female persona; got ${picked.name} (${picked.gender})`);
  });

  test('male persona returns a male voice', () => {
    const persona = {
      name: 'Marcus',
      description: 'A man in his forties. He has a beard. His voice is deep.',
      personality: 'authoritative, calm, deep'
    };
    const picked = pickFallbackVoiceForPersona(persona, { reason: 'test' });
    assert.ok(picked);
    assert.equal(String(picked.gender).toLowerCase(), 'male');
  });

  test('explicit gender override beats inferred gender', () => {
    const persona = { name: 'X', description: 'a man with a beard' }; // male signal
    const picked = pickFallbackVoiceForPersona(persona, {
      genderOverride: 'female',
      reason: 'test'
    });
    assert.ok(picked);
    assert.equal(String(picked.gender).toLowerCase(), 'female');
  });

  // V4 Phase 5b + Wave 6 / F4 — visual_anchor flows through inferPersonaGender
  // (which the picker calls internally) as priority 0, OR can be passed
  // explicitly via genderOverride. Both paths must end in a gender-correct
  // voice. The 77d6eaaf bug shipped because text-only inference returned
  // 'unknown' for a sparse persona — visual_anchor closes that.
  test('visual_anchor on persona drives gender filter (Step 0 cascade)', () => {
    const persona = {
      name: 'Persona 1', // sparse — no description
      visual_anchor: {
        apparent_gender_presentation: 'female',
        vision_confidence: 0.9
      }
    };
    const picked = pickFallbackVoiceForPersona(persona, { reason: 'test' });
    assert.ok(picked);
    assert.equal(String(picked.gender).toLowerCase(), 'female');
  });

  test('visual_anchor with low confidence (< 0.5) falls through to text inference', () => {
    const persona = {
      name: 'Persona 1',
      description: 'a man with a beard', // text says male
      visual_anchor: {
        apparent_gender_presentation: 'female',
        vision_confidence: 0.3 // below floor — anchor is a hint
      }
    };
    const picked = pickFallbackVoiceForPersona(persona, { reason: 'test' });
    assert.ok(picked);
    // Anchor below floor → text inference wins → male voice
    assert.equal(String(picked.gender).toLowerCase(), 'male');
  });

  test('visual_anchor passed via genderOverride (caller-driven path) selects matching voice', () => {
    // Caller (BrandStoryService) extracts apparent_gender_presentation from
    // persona.visual_anchor and passes it as genderOverride. End-to-end
    // smoke check.
    const persona = { name: 'Persona 1' }; // text-sparse
    const visualAnchorGender = 'female'; // would come from persona.visual_anchor.apparent_gender_presentation
    const picked = pickFallbackVoiceForPersona(persona, {
      genderOverride: visualAnchorGender,
      reason: 'visual_anchor_override'
    });
    assert.ok(picked);
    assert.equal(String(picked.gender).toLowerCase(), 'female');
  });

  test('unknown gender allows any voice (no hard constraint)', () => {
    const persona = { name: 'Persona 1' }; // sparse — gender unknown
    const picked = pickFallbackVoiceForPersona(persona, { reason: 'test' });
    assert.ok(picked); // SOMETHING comes back; gender unconstrained
  });
});

describe('pickFallbackVoiceForPersona — uniqueness handling', () => {
  test('avoids voice_ids in takenVoiceIds when the gender pool has alternatives', () => {
    const persona = { name: 'Sydney', description: 'a woman, long hair' };
    const firstPick = pickFallbackVoiceForPersona(persona, { reason: 'test' });
    const taken = new Set([firstPick.voice_id]);
    const secondPick = pickFallbackVoiceForPersona(persona, {
      takenVoiceIds: taken,
      reason: 'test'
    });
    assert.notEqual(secondPick.voice_id, firstPick.voice_id);
    assert.equal(String(secondPick.gender).toLowerCase(), 'female');
  });

  test('softens uniqueness BEFORE softening gender (gender correctness > uniqueness)', () => {
    // Take ALL female voices. Picker should still return a female voice
    // (softens uniqueness) rather than picking a male voice (which would
    // be the actual bug we want to prevent).
    const allFemale = LIBRARY
      .filter(v => String(v.gender).toLowerCase() === 'female')
      .map(v => v.voice_id);
    const taken = new Set(allFemale);
    const persona = { name: 'X', description: 'a woman, long hair, lipstick' };
    const picked = pickFallbackVoiceForPersona(persona, {
      takenVoiceIds: taken,
      reason: 'test'
    });
    assert.ok(picked);
    assert.equal(String(picked.gender).toLowerCase(), 'female',
      'when all female voices are taken, picker should soften uniqueness, NOT switch gender');
  });
});

describe('pickFallbackVoiceForPersona — persona-aware scoring', () => {
  test('picks a voice whose descriptor overlaps with the persona personality', () => {
    // "warm" + "deep" + "resonant" → should bias toward Brian-ish voices
    const persona = {
      name: 'Narrator',
      personality: 'deep resonant warm authoritative narrative-friendly'
    };
    const picked = pickFallbackVoiceForPersona(persona, {
      genderOverride: 'male',
      reason: 'test'
    });
    assert.ok(picked);
    // The picked voice's descriptor should share at least one significant
    // word with the personality.
    const descriptorWords = (picked.descriptor || '').toLowerCase().split(/\s+/);
    const personalityWords = persona.personality.split(/\s+/);
    const overlap = descriptorWords.some(d => d.length > 3 && personalityWords.some(p => p.includes(d)));
    assert.ok(overlap, `expected descriptor "${picked.descriptor}" to share words with personality "${persona.personality}"`);
  });

  test('handles null persona gracefully', () => {
    // Picker takes {} when persona is missing — should still return SOMETHING.
    const picked = pickFallbackVoiceForPersona(null, { reason: 'test' });
    assert.ok(picked); // no throw; returns a library entry
  });
});

describe('pickFallbackVoiceIdForPersonaInList — list-aware convenience wrapper', () => {
  test('returns voice_id avoiding collisions with other personas in the list', () => {
    const personas = [
      { name: 'Sydney', gender: 'female', elevenlabs_voice_id: LIBRARY.find(v => v.gender === 'female').voice_id },
      { name: 'Marcus', gender: 'male' } // no voice_id — needs picker
    ];
    const pickedVoiceId = pickFallbackVoiceIdForPersonaInList(personas, 1, { reason: 'test' });
    assert.ok(pickedVoiceId);
    assert.notEqual(pickedVoiceId, personas[0].elevenlabs_voice_id);
    // Verify it's a male voice (since persona[1].gender = 'male')
    const pickedEntry = LIBRARY.find(v => v.voice_id === pickedVoiceId);
    assert.equal(String(pickedEntry.gender).toLowerCase(), 'male');
  });

  test('returns a voice_id even when the persona at idx is missing entirely', () => {
    const personas = [{ name: 'Sydney' }];
    const pickedVoiceId = pickFallbackVoiceIdForPersonaInList(personas, 5, { reason: 'test' });
    assert.ok(pickedVoiceId, 'should return SOMETHING even when index is out of range');
  });

  test('returns a voice_id when the persona has no signal at all', () => {
    const personas = [{}];
    const pickedVoiceId = pickFallbackVoiceIdForPersonaInList(personas, 0, { reason: 'test' });
    assert.ok(pickedVoiceId);
  });

  test('explicit gender override propagates through the wrapper', () => {
    const personas = [{ name: 'X' }]; // no gender signal
    const pickedVoiceId = pickFallbackVoiceIdForPersonaInList(personas, 0, {
      genderOverride: 'female',
      reason: 'test'
    });
    const pickedEntry = LIBRARY.find(v => v.voice_id === pickedVoiceId);
    assert.equal(String(pickedEntry.gender).toLowerCase(), 'female');
  });
});

describe('integration — three former Brian sites no longer cast male over female', () => {
  test('female persona at narrator slot gets a female narrator fallback (was male Brian)', () => {
    // Simulates BrandStoryService.js:3660 — defaultNarratorVoiceId for V4
    // pipeline. Personas[0] has gender_signal but no elevenlabs_voice_id.
    const personas = [
      { name: 'Sela', description: 'A woman in her thirties, long hair, soft demeanor.' }
    ];
    const fallbackVoiceId = pickFallbackVoiceIdForPersonaInList(personas, 0, { reason: 'v4_default_narrator_test' });
    assert.ok(fallbackVoiceId);
    const entry = LIBRARY.find(v => v.voice_id === fallbackVoiceId);
    assert.equal(String(entry.gender).toLowerCase(), 'female',
      'BUG REGRESSION CHECK — female persona narrator must NOT silently fall back to male Brian voice');
    assert.notEqual(fallbackVoiceId, 'nPczCjzI2devNBz1zQrb',
      'Brian voice should not be selected for a female narrator persona');
  });

  test('female V.O. persona gets a female fallback voice (VoiceoverBRollGenerator path)', () => {
    const personas = [
      { name: 'Lead', gender: 'male', elevenlabs_voice_id: 'TX3LPaO' }, // male lead
      { name: 'V.O.', description: 'a woman whispering in voiceover, intimate, warm' } // female V.O., no voice
    ];
    const fallbackVoiceId = pickFallbackVoiceIdForPersonaInList(personas, 1, { reason: 'voiceover_broll_test' });
    const entry = LIBRARY.find(v => v.voice_id === fallbackVoiceId);
    assert.equal(String(entry.gender).toLowerCase(), 'female',
      'female V.O. persona must get a female fallback voice');
    assert.notEqual(fallbackVoiceId, personas[0].elevenlabs_voice_id,
      'V.O. persona must not collide with the male lead voice');
  });
});
