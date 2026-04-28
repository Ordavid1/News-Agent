// services/v4/__tests__/CreativeBriefDirector.test.js
// Phase 6 smoke test — helper functions + reference library structure.
// The Gemini-call path is exercised by integration tests that require credentials.

import assert from 'assert';
import {
  resolveCommercialEpisodeCount,
  isCommercialGenre,
  isCommercialPipelineEnabled
} from '../CreativeBriefDirector.js';
import {
  COMMERCIAL_REFERENCE_LIBRARY,
  COMMERCIAL_STYLE_CATEGORIES,
  formatReferenceLibraryForPrompt,
  getReferencesByStyleCategory
} from '../director-rubrics/commercialReferenceLibrary.mjs';
import {
  COMMERCIAL_BRIEF_VERDICT_SCHEMA,
  COMMERCIAL_EPISODE_VERDICT_SCHEMA
} from '../director-rubrics/verdictSchema.mjs';

let pass = 0;
let fail = 0;

function it(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (err) {
    console.error(`  ✗ ${name}\n      ${err.message}`);
    fail++;
  }
}

function describe(name, fn) {
  console.log(`\n${name}`);
  fn();
}

describe('Feature flags + helpers', () => {
  it('isCommercialGenre detects subject.genre', () => {
    assert.strictEqual(isCommercialGenre({ subject: { genre: 'commercial' } }), true);
    assert.strictEqual(isCommercialGenre({ subject: { genre: 'COMMERCIAL' } }), true);
    assert.strictEqual(isCommercialGenre({ subject: { genre: 'drama' } }), false);
    assert.strictEqual(isCommercialGenre({}), false);
  });

  it('isCommercialGenre detects storyline.genre', () => {
    assert.strictEqual(isCommercialGenre({ storyline: { genre: 'commercial' } }), true);
  });

  it('isCommercialPipelineEnabled honors env flag', () => {
    const orig = process.env.BRAND_STORY_COMMERCIAL_GENRE;
    process.env.BRAND_STORY_COMMERCIAL_GENRE = 'true';
    assert.strictEqual(isCommercialPipelineEnabled(), true);
    process.env.BRAND_STORY_COMMERCIAL_GENRE = 'false';
    assert.strictEqual(isCommercialPipelineEnabled(), false);
    if (orig === undefined) delete process.env.BRAND_STORY_COMMERCIAL_GENRE;
    else process.env.BRAND_STORY_COMMERCIAL_GENRE = orig;
  });
});

describe('resolveCommercialEpisodeCount', () => {
  it('clamps to 1 when count is < 1', () => {
    const r = resolveCommercialEpisodeCount({ episode_count_justification: { count: 0, reasoning: 'x' } });
    assert.strictEqual(r.count, 1);
  });

  it('clamps to 2 when count is > 2', () => {
    const r = resolveCommercialEpisodeCount({ episode_count_justification: { count: 5, reasoning: 'x' } });
    assert.strictEqual(r.count, 2);
  });

  it('preserves count=1', () => {
    const r = resolveCommercialEpisodeCount({ episode_count_justification: { count: 1, reasoning: 'hero spot' } });
    assert.strictEqual(r.count, 1);
    assert.strictEqual(r.reasoning, 'hero spot');
  });

  it('preserves count=2', () => {
    const r = resolveCommercialEpisodeCount({ episode_count_justification: { count: 2, reasoning: 'campaign' } });
    assert.strictEqual(r.count, 2);
  });

  it('defaults to 1 when no brief provided', () => {
    const r = resolveCommercialEpisodeCount(null);
    assert.strictEqual(r.count, 1);
  });

  it('defaults to 1 when count is missing', () => {
    const r = resolveCommercialEpisodeCount({ episode_count_justification: {} });
    assert.strictEqual(r.count, 1);
  });
});

describe('Commercial reference library', () => {
  it('exports a non-empty library of 10+ commercials', () => {
    assert.ok(Array.isArray(COMMERCIAL_REFERENCE_LIBRARY));
    assert.ok(COMMERCIAL_REFERENCE_LIBRARY.length >= 10);
  });

  it('every entry uses a valid style_category', () => {
    for (const entry of COMMERCIAL_REFERENCE_LIBRARY) {
      assert.ok(
        COMMERCIAL_STYLE_CATEGORIES.includes(entry.style_category),
        `entry "${entry.title}" uses unknown style_category "${entry.style_category}"`
      );
    }
  });

  it('every entry has the required fields', () => {
    for (const entry of COMMERCIAL_REFERENCE_LIBRARY) {
      assert.ok(entry.title, 'missing title');
      assert.ok(entry.director, `${entry.title} missing director`);
      assert.ok(typeof entry.year === 'number', `${entry.title} missing year`);
      assert.ok(entry.style_category, `${entry.title} missing style_category`);
      assert.ok(entry.visual_grammar, `${entry.title} missing visual_grammar`);
      assert.ok(entry.narrative_grammar, `${entry.title} missing narrative_grammar`);
      assert.ok(entry.why_great, `${entry.title} missing why_great`);
    }
  });

  it('formatReferenceLibraryForPrompt produces a non-empty string', () => {
    const text = formatReferenceLibraryForPrompt({ limit: 5 });
    assert.ok(text.length > 100);
    assert.match(text, /Apple/);
  });

  it('getReferencesByStyleCategory filters correctly', () => {
    const anthemic = getReferencesByStyleCategory('anthemic_epic');
    assert.ok(anthemic.length >= 2);
    assert.ok(anthemic.every(r => r.style_category === 'anthemic_epic'));
  });
});

describe('Commercial verdict schemas', () => {
  it('COMMERCIAL_BRIEF schema has all 8 commercial dimensions', () => {
    assert.deepStrictEqual(
      COMMERCIAL_BRIEF_VERDICT_SCHEMA.properties.dimension_scores.propertyOrdering,
      ['creative_bravery', 'brand_recall', 'story_compression', 'visual_signature',
       'hook_first_1_5s', 'music_visual_sync', 'tagline_landing', 'product_role']
    );
  });

  it('COMMERCIAL_EPISODE schema has the same dimensions', () => {
    assert.deepStrictEqual(
      COMMERCIAL_EPISODE_VERDICT_SCHEMA.properties.dimension_scores.propertyOrdering,
      ['creative_bravery', 'brand_recall', 'story_compression', 'visual_signature',
       'hook_first_1_5s', 'music_visual_sync', 'tagline_landing', 'product_role']
    );
  });

  it('checkpoint enums match', () => {
    assert.deepStrictEqual(
      COMMERCIAL_BRIEF_VERDICT_SCHEMA.properties.checkpoint.enum,
      ['commercial_brief']
    );
    assert.deepStrictEqual(
      COMMERCIAL_EPISODE_VERDICT_SCHEMA.properties.checkpoint.enum,
      ['commercial_episode']
    );
  });
});

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
