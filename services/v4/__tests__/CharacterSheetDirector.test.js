// services/v4/__tests__/CharacterSheetDirector.test.js
// Phase 5 smoke test — variant policy + cache-key + helper logic.
// No Gemini call exercised here (covered by integration test against
// live Vertex when env credentials are configured).

import assert from 'assert';
import {
  isEnabled,
  resolveVariantPolicy,
  resolveArcStatesForPersona,
  isPrincipalPersona,
  cacheKey
} from '../CharacterSheetDirector.js';

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

describe('Feature flags', () => {
  it('isEnabled honors BRAND_STORY_CHARACTER_SHEET_DIRECTOR', () => {
    const orig = process.env.BRAND_STORY_CHARACTER_SHEET_DIRECTOR;
    process.env.BRAND_STORY_CHARACTER_SHEET_DIRECTOR = 'false';
    assert.strictEqual(isEnabled(), false);
    process.env.BRAND_STORY_CHARACTER_SHEET_DIRECTOR = 'true';
    assert.strictEqual(isEnabled(), true);
    if (orig === undefined) delete process.env.BRAND_STORY_CHARACTER_SHEET_DIRECTOR;
    else process.env.BRAND_STORY_CHARACTER_SHEET_DIRECTOR = orig;
  });

  it('resolveVariantPolicy honors BRAND_STORY_CHARACTER_SHEET_VARIANTS', () => {
    const orig = process.env.BRAND_STORY_CHARACTER_SHEET_VARIANTS;
    process.env.BRAND_STORY_CHARACTER_SHEET_VARIANTS = '1';
    assert.strictEqual(resolveVariantPolicy(), '1');
    process.env.BRAND_STORY_CHARACTER_SHEET_VARIANTS = '3';
    assert.strictEqual(resolveVariantPolicy(), '3');
    process.env.BRAND_STORY_CHARACTER_SHEET_VARIANTS = 'auto';
    assert.strictEqual(resolveVariantPolicy(), 'auto');
    process.env.BRAND_STORY_CHARACTER_SHEET_VARIANTS = 'garbage';
    assert.strictEqual(resolveVariantPolicy(), 'auto');  // falls back to auto
    if (orig === undefined) delete process.env.BRAND_STORY_CHARACTER_SHEET_VARIANTS;
    else process.env.BRAND_STORY_CHARACTER_SHEET_VARIANTS = orig;
  });
});

describe('isPrincipalPersona', () => {
  it('respects explicit is_principal:true', () => {
    assert.strictEqual(isPrincipalPersona({ is_principal: true }), true);
  });

  it('respects explicit is_principal:false even on principal archetype', () => {
    assert.strictEqual(isPrincipalPersona({ is_principal: false, dramatic_archetype: 'detective' }), false);
  });

  it('detects detective as principal', () => {
    assert.strictEqual(isPrincipalPersona({ dramatic_archetype: 'detective' }), true);
  });

  it('detects ingénue as principal', () => {
    assert.strictEqual(isPrincipalPersona({ dramatic_archetype: 'ingénue' }), true);
    assert.strictEqual(isPrincipalPersona({ dramatic_archetype: 'ingenue' }), true);
  });

  it('treats unknown archetype as supporting', () => {
    assert.strictEqual(isPrincipalPersona({ dramatic_archetype: 'random_villager' }), false);
  });
});

describe('resolveArcStatesForPersona', () => {
  it('single-episode story returns [act1] regardless of role', () => {
    const orig = process.env.BRAND_STORY_CHARACTER_SHEET_VARIANTS;
    delete process.env.BRAND_STORY_CHARACTER_SHEET_VARIANTS;
    const result = resolveArcStatesForPersona({
      persona: { dramatic_archetype: 'detective' },
      story: { total_episodes: 1 },
      isPrincipal: true
    });
    assert.deepStrictEqual(result, ['act1']);
    if (orig !== undefined) process.env.BRAND_STORY_CHARACTER_SHEET_VARIANTS = orig;
  });

  it('multi-episode + principal + auto policy → 3 variants', () => {
    const orig = process.env.BRAND_STORY_CHARACTER_SHEET_VARIANTS;
    process.env.BRAND_STORY_CHARACTER_SHEET_VARIANTS = 'auto';
    const result = resolveArcStatesForPersona({
      persona: { dramatic_archetype: 'detective' },
      story: { total_episodes: 6 },
      isPrincipal: true
    });
    assert.deepStrictEqual(result, ['act1', 'act2_pivot', 'act3']);
    if (orig === undefined) delete process.env.BRAND_STORY_CHARACTER_SHEET_VARIANTS;
    else process.env.BRAND_STORY_CHARACTER_SHEET_VARIANTS = orig;
  });

  it('multi-episode + supporting + auto policy → 2 variants', () => {
    const orig = process.env.BRAND_STORY_CHARACTER_SHEET_VARIANTS;
    process.env.BRAND_STORY_CHARACTER_SHEET_VARIANTS = 'auto';
    const result = resolveArcStatesForPersona({
      persona: { dramatic_archetype: 'random_villager' },
      story: { total_episodes: 6 },
      isPrincipal: false
    });
    assert.deepStrictEqual(result, ['act1', 'act3']);
    if (orig === undefined) delete process.env.BRAND_STORY_CHARACTER_SHEET_VARIANTS;
    else process.env.BRAND_STORY_CHARACTER_SHEET_VARIANTS = orig;
  });

  it('explicit policy=1 forces single variant even for principals', () => {
    const orig = process.env.BRAND_STORY_CHARACTER_SHEET_VARIANTS;
    process.env.BRAND_STORY_CHARACTER_SHEET_VARIANTS = '1';
    const result = resolveArcStatesForPersona({
      persona: { dramatic_archetype: 'detective' },
      story: { total_episodes: 6 },
      isPrincipal: true
    });
    assert.deepStrictEqual(result, ['act1']);
    if (orig === undefined) delete process.env.BRAND_STORY_CHARACTER_SHEET_VARIANTS;
    else process.env.BRAND_STORY_CHARACTER_SHEET_VARIANTS = orig;
  });
});

describe('cacheKey', () => {
  it('is deterministic for identical inputs', () => {
    const a = cacheKey({
      persona: { persona_index: 0, archetype: 'detective', wound: 'lost his daughter' },
      arcState: 'act1', storyGenre: 'noir', brandMood: 'somber'
    });
    const b = cacheKey({
      persona: { persona_index: 0, archetype: 'detective', wound: 'lost his daughter' },
      arcState: 'act1', storyGenre: 'noir', brandMood: 'somber'
    });
    assert.strictEqual(a, b);
  });

  it('differs when arcState differs', () => {
    const a = cacheKey({ persona: { persona_index: 0 }, arcState: 'act1', storyGenre: 'noir' });
    const b = cacheKey({ persona: { persona_index: 0 }, arcState: 'act3', storyGenre: 'noir' });
    assert.notStrictEqual(a, b);
  });

  it('differs when wardrobe_hint differs', () => {
    const a = cacheKey({ persona: { persona_index: 0, wardrobe_hint: 'overcoat' }, arcState: 'act1', storyGenre: 'noir' });
    const b = cacheKey({ persona: { persona_index: 0, wardrobe_hint: 'leather jacket' }, arcState: 'act1', storyGenre: 'noir' });
    assert.notStrictEqual(a, b);
  });
});

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
