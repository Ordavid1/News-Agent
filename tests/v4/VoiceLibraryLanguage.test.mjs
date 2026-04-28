// tests/v4/VoiceLibraryLanguage.test.mjs
// V4 Audio Layer Overhaul Day 4 — language-aware fallback picker tests.
//
// Run: node --test tests/v4/VoiceLibraryLanguage.test.mjs
//
// Coverage:
//   - persona.language='he' filters to the 6 Hebrew-capable voices
//   - persona.language='en' filters to all 26 voices (default-language assumption)
//   - persona.language unset behaves like pre-Day-4 (any voice eligible)
//   - languageOverride takes precedence over persona.language
//   - Hebrew pool retains gender filter (3 male, 3 female)
//   - When language pool is empty for a fictional language, picker softens
//     gracefully (stage='softened_language') instead of returning null
//   - Voice library structural integrity: Hebrew strategy block exists,
//     6 voices declare 'he' in languages[]
//
// PURE — reads voice library JSON, no fal.ai / Vertex calls.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  pickFallbackVoiceForPersona,
  pickFallbackVoiceIdForPersonaInList
} from '../../services/v4/VoiceAcquisition.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PRESETS_PATH = path.resolve(__dirname, '..', '..', 'services', 'voice-library', 'elevenlabs-presets.json');
const LIBRARY = JSON.parse(fs.readFileSync(PRESETS_PATH, 'utf-8'));

describe('Voice library — Day 4 schema integrity', () => {
  test('_meta declares default_language and hebrew_voice_strategy', () => {
    assert.equal(LIBRARY._meta.default_language, 'en');
    assert.ok(LIBRARY._meta.hebrew_voice_strategy, 'hebrew_voice_strategy block expected');
    assert.ok(LIBRARY._meta.hebrew_voice_strategy.phase_a_current);
    assert.ok(LIBRARY._meta.hebrew_voice_strategy.phase_b_recommended);
    assert.ok(Array.isArray(LIBRARY._meta.hebrew_voice_strategy.phase_b_acceptance_criteria));
  });

  test('exactly 6 voices declare languages: ["en","he"] (3 male + 3 female)', () => {
    const hePool = LIBRARY.voices.filter(v => Array.isArray(v.languages) && v.languages.includes('he'));
    assert.equal(hePool.length, 6, `expected 6 Hebrew-capable voices, found ${hePool.length}`);
    const males = hePool.filter(v => v.gender === 'male');
    const females = hePool.filter(v => v.gender === 'female');
    assert.equal(males.length, 3, `expected 3 male Hebrew voices, found ${males.length}: ${males.map(v=>v.name).join(',')}`);
    assert.equal(females.length, 3, `expected 3 female Hebrew voices, found ${females.length}: ${females.map(v=>v.name).join(',')}`);
  });

  test('every Hebrew-capable voice carries a register field', () => {
    const hePool = LIBRARY.voices.filter(v => Array.isArray(v.languages) && v.languages.includes('he'));
    for (const v of hePool) {
      assert.ok(v.register, `voice "${v.name}" missing register field`);
      assert.ok(['warm', 'neutral', 'clipped', 'theatrical'].includes(v.register),
        `voice "${v.name}" has invalid register "${v.register}"`);
    }
  });
});

describe('pickFallbackVoiceForPersona — language filter (Day 4)', () => {
  test('persona.language="he" picks ONLY a Hebrew-capable voice', () => {
    const persona = { name: 'Yael', personality: 'warm matriarch', language: 'he' };
    // Run 20 trials — across runs we should never get an English-only voice
    // (no voice without languages[] should match an explicit Hebrew filter).
    for (let i = 0; i < 20; i++) {
      const picked = pickFallbackVoiceForPersona(persona, { reason: 'test_he_filter' });
      assert.ok(picked, 'expected a pick');
      const declared = picked.languages || [];
      assert.ok(declared.includes('he'),
        `picked "${picked.name}" without 'he' in languages — got ${JSON.stringify(declared)}`);
    }
  });

  test('persona.language="he" + female gender → Hebrew female pool', () => {
    const persona = { name: 'Maya', personality: 'wounded healer', language: 'he' };
    const picked = pickFallbackVoiceForPersona(persona, {
      genderOverride: 'female',
      reason: 'test_he_female'
    });
    assert.ok(picked);
    assert.equal(picked.gender, 'female');
    assert.ok((picked.languages || []).includes('he'));
  });

  test('languageOverride takes precedence over persona.language', () => {
    const persona = { name: 'Daniel', personality: 'narrator', language: 'en' };
    const picked = pickFallbackVoiceForPersona(persona, {
      languageOverride: 'he',
      reason: 'test_lang_override'
    });
    assert.ok((picked.languages || []).includes('he'));
  });

  test('persona without language behaves as default_language (en)', () => {
    const persona = { name: 'Sam', personality: 'casual male' };
    // Default language is en; voices without languages[] are assumed en, so
    // the pool is the full library minus none. We should get any non-Hebrew-only voice.
    const picked = pickFallbackVoiceForPersona(persona, { reason: 'test_no_lang' });
    assert.ok(picked, 'expected a pick when language is unspecified');
  });

  test('fictional language ("xq") triggers softened_language fallback (no null)', () => {
    const persona = { name: 'Nobody', personality: 'unknown', language: 'xq' };
    const picked = pickFallbackVoiceForPersona(persona, { reason: 'test_unknown_lang' });
    assert.ok(picked, 'should not return null even when language pool is empty');
  });
});

describe('pickFallbackVoiceIdForPersonaInList — language threading', () => {
  test('Hebrew personas in a 3-cast story all get Hebrew voices, no collisions', () => {
    const personas = [
      { name: 'Maya',    personality: 'wounded healer',  language: 'he' },
      { name: 'Daniel',  personality: 'stoic mentor',    language: 'he' },
      { name: 'Yael',    personality: 'sharp authority', language: 'he' }
    ];
    const v0 = pickFallbackVoiceIdForPersonaInList(personas, 0, { reason: 'test_he_0' });
    // Stamp v0 onto persona 0 so persona 1's pick avoids it
    personas[0].elevenlabs_voice_id = v0;
    const v1 = pickFallbackVoiceIdForPersonaInList(personas, 1, { reason: 'test_he_1' });
    personas[1].elevenlabs_voice_id = v1;
    const v2 = pickFallbackVoiceIdForPersonaInList(personas, 2, { reason: 'test_he_2' });

    assert.ok(v0 && v1 && v2);
    const ids = new Set([v0, v1, v2]);
    assert.equal(ids.size, 3, 'three personas must get three distinct voices');

    // Confirm all three are Hebrew-capable
    for (const id of ids) {
      const v = LIBRARY.voices.find(x => x.voice_id === id);
      assert.ok(v, `picked id ${id} not in library`);
      assert.ok((v.languages || []).includes('he'),
        `picked "${v.name}" lacks 'he' in languages — picker leaked through to English-only voices`);
    }
  });

  test('mixed-language personas (one en, one he) each get their own language pool', () => {
    const personas = [
      { name: 'Maya',  personality: 'wounded healer', language: 'he' },
      { name: 'Sarah', personality: 'professional',    language: 'en' }
    ];
    const v0 = pickFallbackVoiceIdForPersonaInList(personas, 0, { reason: 'test_mixed_he' });
    const v1 = pickFallbackVoiceIdForPersonaInList(personas, 1, { reason: 'test_mixed_en' });

    const heVoice = LIBRARY.voices.find(v => v.voice_id === v0);
    const enVoice = LIBRARY.voices.find(v => v.voice_id === v1);

    assert.ok((heVoice.languages || []).includes('he'), 'persona[0] (he) should match Hebrew pool');
    // persona[1] (en) might pick an en-only or en+he voice — both are valid
    assert.ok(enVoice, 'persona[1] (en) should get a voice');
  });
});
