// tests/v4/PromptHardcoding.test.mjs
// Phase 1 regression-net — banned literal phrase tripwire.
//
// Why this exists:
//   The V4 prompt previously shipped with 8 BAD→GOOD dialogue exchanges in the
//   DIALOGUE MASTERCLASS block AND a fully-written 6-beat DRAMA scene inside
//   the JSON schema example. The schema example reused the same DRAMA literals
//   verbatim — Gemini saw the same ~16 lines twice in one prompt. Per the
//   Director's verdict the failure mode was register collapse, not literal
//   echo, but the literal exemplars were the load-bearing anchor.
//
//   Phase 1 of the screenwriting creative-power refactor replaced both blocks
//   with placeholders + principle/citation rubrics that contain ZERO quoted
//   dialogue. This test is the long-term tripwire — any future engineer who
//   pastes a sample dialogue line into the prompt will fail this test at PR
//   time.
//
// Cost: zero. Pure string scan, no LLM calls.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  getEpisodeSystemPromptV4,
  getEpisodeUserPromptV4
} from '../../public/components/brandStoryPromptsV4.mjs';

// ─────────────────────────────────────────────────────────────────────
// The 11 banned literal phrases that lived in the deleted blocks.
// ANY future occurrence of these in the rendered prompt is a hardcoding
// regression — fail loudly.
// ─────────────────────────────────────────────────────────────────────
const BANNED_PHRASES = [
  // ACTION exemplar from deleted BAD→GOOD block
  '"Hands."',
  '"Slower."',

  // DRAMA exemplar — appeared in BOTH the BAD→GOOD block AND the JSON schema
  // example (lines 1650, 1674, 1688 of the pre-refactor prompt). Highest-
  // leverage tripwires because they were the most-anchored literals.
  '"You didn\'t eat."',
  '"I wasn\'t hungry."',
  '"You weren\'t hungry yesterday either."',

  // MYSTERY exemplar
  '"Tuesday."',
  '"What about it."',

  // COMEDY exemplar
  '"That\'s so inconvenient."',

  // HORROR exemplar
  '"Go to bed."',
  '"That\'s the third time."',

  // BRAND exemplar
  '"I came back"', // partial — the deleted block used "I came back" three times in a row

  // PERIOD exemplar
  '"If I have given offence'
];

// ─────────────────────────────────────────────────────────────────────
// All 15 user-selectable genres from public/profile.html. Test every one
// because the deleted BAD→GOOD block spanned 8 of them and we want the
// tripwire to fire regardless of which genre is selected.
// ─────────────────────────────────────────────────────────────────────
const GENRES = [
  'drama', 'action', 'comedy', 'thriller', 'romance', 'sci-fi', 'fantasy',
  'period', 'horror', 'documentary', 'noir', 'mystery', 'inspirational',
  'adventure', 'slice-of-life', 'commercial'
];

// ─────────────────────────────────────────────────────────────────────
// Minimal storyline + persona fixture. We do not need the full V4 shape
// for a string-scan test — getEpisodeSystemPromptV4 / getEpisodeUserPromptV4
// must render gracefully on partial inputs (the production callsite always
// provides a full storyline, so any rendering crash here is a separate bug
// the test will surface).
// ─────────────────────────────────────────────────────────────────────
function makeStoryline(genre) {
  return {
    title: 'Test Series',
    theme: 'placeholder theme',
    genre,
    tone: 'placeholder tone',
    logline: 'placeholder logline',
    season_bible: 'placeholder season bible — ensures the bible block renders.',
    characters: [
      { name: 'A', role: 'protagonist', personality: 'placeholder', visual_description: 'placeholder' },
      { name: 'B', role: 'confidant', personality: 'placeholder', visual_description: 'placeholder' }
    ],
    emotional_arc: [],
    visual_motifs: [],
    episodes: []
  };
}

function makePersonas() {
  return [
    {
      name: 'A',
      personality: 'placeholder',
      appearance: 'placeholder',
      elevenlabs_voice_id: 'voice-a',
      dramatic_archetype: 'HERO',
      want: 'placeholder want',
      need: 'placeholder need',
      wound: 'placeholder wound',
      flaw: 'placeholder flaw',
      core_contradiction: 'placeholder',
      moral_code: 'placeholder',
      relationship_to_subject: 'placeholder',
      speech_patterns: { vocabulary: 'placeholder', sentence_length: 'placeholder', tics: ['x'], avoids: ['y'], signature_line: 'placeholder' },
      voice_brief: { emotional_default: 'placeholder', pace: 'medium', warmth: 'neutral', power: 'equal', vocal_color: 'resonant' }
    },
    {
      name: 'B',
      personality: 'placeholder',
      appearance: 'placeholder',
      elevenlabs_voice_id: 'voice-b',
      dramatic_archetype: 'SKEPTIC',
      want: 'placeholder want',
      need: 'placeholder need',
      wound: 'placeholder wound',
      flaw: 'placeholder flaw',
      core_contradiction: 'placeholder',
      moral_code: 'placeholder',
      relationship_to_subject: 'placeholder',
      speech_patterns: { vocabulary: 'placeholder', sentence_length: 'placeholder', tics: ['x'], avoids: ['y'], signature_line: 'placeholder' },
      voice_brief: { emotional_default: 'placeholder', pace: 'medium', warmth: 'neutral', power: 'equal', vocal_color: 'resonant' }
    }
  ];
}

function makeSubject() {
  return {
    name: 'Placeholder Subject',
    category: 'placeholder',
    visual_description: 'placeholder',
    description: 'placeholder',
    signature_features: ['placeholder feature'],
    integration_guidance: ['placeholder guidance'],
    integration_mandate: { min_beats: 1, hero_shot_required: false }
  };
}

function makeStoryContext() {
  return { episode_number: 1, previous_episodes: [], story_so_far: null };
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────
describe('PromptHardcoding — banned phrase tripwire', () => {
  for (const genre of GENRES) {
    test(`system prompt for genre="${genre}" contains no banned literal phrases`, () => {
      const storyline = makeStoryline(genre);
      const personas = makePersonas();
      const subject = makeSubject();

      const systemPrompt = getEpisodeSystemPromptV4(storyline, [], personas, {
        subject,
        storyFocus: 'product',
        brandKit: null,
        sonicSeriesBible: null,
        castBible: null,
        commercialBrief: null,
        productIntegrationStyle: 'naturalistic_placement',
        costCapUsd: 10,
        hasBrandKitLut: false
      });

      for (const phrase of BANNED_PHRASES) {
        assert.ok(
          !systemPrompt.includes(phrase),
          `BANNED PHRASE FOUND in system prompt for genre="${genre}": ${phrase}\n` +
          `  This means a hardcoded dialogue sample has re-entered the prompt.\n` +
          `  Phase 1 of the V4 screenwriting refactor explicitly removed all 11\n` +
          `  banned literals from brandStoryPromptsV4.mjs. If you are intentionally\n` +
          `  re-introducing dialogue exemplars, you are likely re-creating the\n` +
          `  register-collapse bug Phase 1 fixed. Use the principle+citation\n` +
          `  rubric (DIALOGUE CRAFT MOVES section) instead of quoted dialogue.`
        );
      }
    });

    test(`user prompt for genre="${genre}" contains no banned literal phrases`, () => {
      const storyline = makeStoryline(genre);
      const personas = makePersonas();
      const subject = makeSubject();

      const userPrompt = getEpisodeUserPromptV4(storyline, null, 1, {
        hasBrandKitLut: false,
        sonicSeriesBible: null
      });

      for (const phrase of BANNED_PHRASES) {
        assert.ok(
          !userPrompt.includes(phrase),
          `BANNED PHRASE FOUND in user prompt for genre="${genre}": ${phrase}`
        );
      }
    });
  }

  test('every banned phrase is checked at least once (smoke test)', () => {
    // Sanity: ensure BANNED_PHRASES isn't accidentally empty.
    assert.ok(BANNED_PHRASES.length >= 11, 'BANNED_PHRASES must list at least 11 entries');
    for (const phrase of BANNED_PHRASES) {
      assert.ok(typeof phrase === 'string' && phrase.length > 0, `banned phrase entry must be a non-empty string: ${phrase}`);
    }
  });
});
