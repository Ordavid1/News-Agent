// tests/v4/HebrewRouting.test.mjs
// V4 Audio Layer Overhaul Day 3 — Hebrew register injection + language threading.
//
// Run: node --test tests/v4/HebrewRouting.test.mjs
//
// Coverage (PURE — no Vertex / fal.ai calls):
//   - getEpisodeSystemPromptV4 emits the Hebrew masterclass block when storyLanguage='he'
//   - English / unspecified / null storyLanguage → no Hebrew block (zero-impact for non-Hebrew stories)
//   - Hebrew block carries Hebrew-specific cadence families (rabbinic / IDF / Levantine / Tel Aviv / Mizrahi)
//   - BRAND_STORY_HEBREW_MASTERCLASS=false suppresses the block even for he stories
//   - The block references eleven-v3 audio tags so screenwriters know they apply in Hebrew
//   - Code-switch / language consistency rule is present
//   - Hebrew block does NOT replace the main DIALOGUE MASTERCLASS — both must coexist
//
// PURE — only string assertions on the rendered system prompt.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getEpisodeSystemPromptV4 } from '../../public/components/brandStoryPromptsV4.mjs';

const STORYLINE = {
  brand_name: 'Sydney Atelier',
  brand_summary: 'Family-run leatherworks',
  central_dramatic_question: 'Will Sydney save the workshop?',
  thematic_argument: 'Craft survives by adaptation',
  genre: 'drama',
  visual_motifs: []
};

const PERSONAS = [
  { name: 'Maya', dramatic_archetype: 'Stoic' },
  { name: 'Daniel', dramatic_archetype: 'Skeptic' }
];

function build({ storyLanguage = 'en' } = {}) {
  return getEpisodeSystemPromptV4(STORYLINE, [], PERSONAS, {
    storyFocus: 'product',
    costCapUsd: 10,
    hasBrandKitLut: false,
    storyLanguage
  });
}

describe('Hebrew masterclass — emission gating', () => {
  test('storyLanguage="en" produces NO Hebrew block', () => {
    const prompt = build({ storyLanguage: 'en' });
    assert.ok(!prompt.includes('DIALOGUE MASTERCLASS — HEBREW REGISTER'),
      'Hebrew block must NOT appear for English stories');
  });

  test('storyLanguage="he" produces the Hebrew masterclass block', () => {
    const prompt = build({ storyLanguage: 'he' });
    assert.ok(prompt.includes('DIALOGUE MASTERCLASS — HEBREW REGISTER'),
      'Hebrew block expected when storyLanguage=he');
  });

  test('storyLanguage="heb" (3-letter ISO) also triggers the block', () => {
    const prompt = build({ storyLanguage: 'heb' });
    assert.ok(prompt.includes('DIALOGUE MASTERCLASS — HEBREW REGISTER'),
      'startsWith("he") match should accept "heb" as well');
  });

  test('storyLanguage="HE" (uppercase) is normalized', () => {
    const prompt = build({ storyLanguage: 'HE' });
    assert.ok(prompt.includes('DIALOGUE MASTERCLASS — HEBREW REGISTER'));
  });

  test('storyLanguage missing/null defaults to "en" via destructure default', () => {
    const prompt = getEpisodeSystemPromptV4(STORYLINE, [], PERSONAS, {
      storyFocus: 'product',
      costCapUsd: 10
      // no storyLanguage — should fall through to 'en' default
    });
    assert.ok(!prompt.includes('DIALOGUE MASTERCLASS — HEBREW REGISTER'));
  });

  test('BRAND_STORY_HEBREW_MASTERCLASS=false suppresses the block for Hebrew stories', () => {
    const prev = process.env.BRAND_STORY_HEBREW_MASTERCLASS;
    try {
      process.env.BRAND_STORY_HEBREW_MASTERCLASS = 'false';
      const prompt = build({ storyLanguage: 'he' });
      assert.ok(!prompt.includes('DIALOGUE MASTERCLASS — HEBREW REGISTER'),
        'kill-switch should suppress the Hebrew block');
    } finally {
      if (prev === undefined) delete process.env.BRAND_STORY_HEBREW_MASTERCLASS;
      else process.env.BRAND_STORY_HEBREW_MASTERCLASS = prev;
    }
  });
});

describe('Hebrew masterclass — content', () => {
  test('block carries cadence families (rabbinic / IDF / Levantine / Tel Aviv / Mizrahi)', () => {
    const prompt = build({ storyLanguage: 'he' });
    assert.ok(prompt.includes('RABBINIC / TALMUDIC ARGUMENT'), 'rabbinic family');
    assert.ok(prompt.includes('IDF / SECURITY-SERVICE CLIPPED IMPERATIVE'), 'IDF family');
    assert.ok(prompt.includes('LEVANTINE WARMTH / FAMILY KITCHEN'), 'Levantine family');
    assert.ok(prompt.includes('SECULAR TEL AVIV / INFORMAL URBAN'), 'Tel Aviv family');
    assert.ok(prompt.includes('MIZRAHI / SEPHARDIC FAMILY REGISTER'), 'Mizrahi family');
  });

  test('block references Israeli prestige TV anchors (Shtisel / Fauda / etc.)', () => {
    const prompt = build({ storyLanguage: 'he' });
    assert.ok(prompt.includes('Shtisel'), 'Shtisel reference');
    assert.ok(prompt.includes('Fauda'), 'Fauda reference');
    assert.ok(prompt.includes('Beauty Queen of Jerusalem'), 'BQJ reference');
  });

  test('block teaches eleven-v3 tag compatibility in Hebrew', () => {
    const prompt = build({ storyLanguage: 'he' });
    assert.ok(prompt.includes('ELEVEN-V3 PERFORMANCE TAGS WORK IN HEBREW'));
    assert.ok(prompt.includes('[barely whispering]'));
    assert.ok(prompt.includes('[firmly]'));
  });

  test('block enforces single-language consistency rule', () => {
    const prompt = build({ storyLanguage: 'he' });
    assert.ok(prompt.includes('LANGUAGE CONSISTENCY'));
    assert.ok(prompt.includes('language_code=\'he\''));
    assert.ok(prompt.includes('Code-switching English loanwords is\nLEGITIMATE'),
      'must permit Israeli loanword code-switching while forbidding full English clauses');
  });

  test('Hebrew block does NOT replace the main DIALOGUE MASTERCLASS — both coexist', () => {
    const prompt = build({ storyLanguage: 'he' });
    assert.ok(prompt.includes('DIALOGUE MASTERCLASS (this is the bar'),
      'main masterclass header still present');
    assert.ok(prompt.includes('DIALOGUE MASTERCLASS — HEBREW REGISTER'),
      'Hebrew register block also present');
    assert.ok(prompt.includes('DIALOGUE PERFORMANCE TAGS (the audio layer'),
      'Day-1 audio tags block still present');
  });
});
