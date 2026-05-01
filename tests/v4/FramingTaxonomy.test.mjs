// tests/v4/FramingTaxonomy.test.mjs
// V4 P0.3 — FramingTaxonomy threading canary.
//
// Asserts:
//   1. The framing taxonomy module re-exports V4_FRAMING_VOCAB
//   2. getFramingRegistry() returns a frozen Map with all entries
//   3. isRegisteredFraming() correctly identifies registered names
//   4. buildFramingTaxonomyHint() produces a non-empty rubric-injectable string
//   5. getVerificationSignature() returns a structured line for known recipes
//      and null for unknown
//   6. The beat rubrics' user-prompt parts include <framing_taxonomy> when called
//
// Run: node --test tests/v4/FramingTaxonomy.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  V4_FRAMING_VOCAB,
  getFramingRegistry,
  isRegisteredFraming,
  buildFramingTaxonomyHint,
  getVerificationSignature
} from '../../services/v4/masterclass/framingTaxonomy.mjs';
import { buildBeatJudgePrompt } from '../../services/v4/director-rubrics/beatRubric.mjs';
import { buildCommercialBeatJudgePrompt } from '../../services/v4/director-rubrics/commercialBeatRubric.mjs';

// 1×1 transparent JPEG — placeholder image data for required-image guard.
const TINY_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
  0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
  0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27, 0x20,
  0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27,
  0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
  0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x14, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xc4, 0x00, 0x14,
  0x10, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x37, 0xff, 0xd9
]);

test('V4_FRAMING_VOCAB is re-exported and non-empty', () => {
  assert.ok(V4_FRAMING_VOCAB, 'V4_FRAMING_VOCAB must be exported');
  assert.ok(typeof V4_FRAMING_VOCAB === 'object');
  const keys = Object.keys(V4_FRAMING_VOCAB);
  assert.ok(keys.length >= 12, `V4_FRAMING_VOCAB must have ≥12 entries (got ${keys.length})`);
});

test('getFramingRegistry returns a frozen registry with id-stamped entries', () => {
  const reg = getFramingRegistry();
  assert.ok(Object.isFrozen(reg), 'registry must be frozen');
  for (const [id, spec] of Object.entries(reg)) {
    assert.equal(spec.id, id, `entry ${id} must have id field matching key`);
    assert.ok(typeof spec.intent === 'string' || typeof spec.use_when === 'string',
      `entry ${id} must have intent or use_when`);
  }
});

test('isRegisteredFraming correctly identifies registered and unknown ids', () => {
  // Pick a known id from the vocab
  const knownId = Object.keys(V4_FRAMING_VOCAB)[0];
  assert.equal(isRegisteredFraming(knownId), true);
  assert.equal(isRegisteredFraming('not_a_real_recipe_xyz'), false);
  assert.equal(isRegisteredFraming(null), false);
  assert.equal(isRegisteredFraming(undefined), false);
  assert.equal(isRegisteredFraming(''), false);
  assert.equal(isRegisteredFraming(42), false);
});

test('buildFramingTaxonomyHint returns rubric-injectable text', () => {
  const hint = buildFramingTaxonomyHint();
  assert.ok(typeof hint === 'string');
  assert.ok(hint.length > 100, `hint must be substantial (got ${hint.length} chars)`);
  assert.ok(hint.includes('NAMED FRAMING TAXONOMY'), 'hint must include taxonomy header');
  // Should contain at least 5 of the 12+ named recipes
  const recipeCount = Object.keys(V4_FRAMING_VOCAB)
    .filter(name => hint.includes(name))
    .length;
  assert.ok(recipeCount >= 5, `hint must reference ≥5 recipes (got ${recipeCount})`);
});

test('buildFramingTaxonomyHint can filter to relevantSlots', () => {
  const all = Object.keys(V4_FRAMING_VOCAB);
  const subset = all.slice(0, 2);
  const hint = buildFramingTaxonomyHint({ relevantSlots: subset });
  for (const id of subset) assert.ok(hint.includes(id), `filtered hint must include ${id}`);
  // Non-subset entries should NOT appear (depending on data, but at least
  // one non-subset entry name should be absent)
  const others = all.slice(2);
  if (others.length > 0) {
    const someOther = others[0];
    assert.ok(!hint.includes(someOther), `filtered hint must exclude ${someOther}`);
  }
});

test('getVerificationSignature returns structured line for known, null for unknown', () => {
  const knownId = Object.keys(V4_FRAMING_VOCAB)[0];
  const sig = getVerificationSignature(knownId);
  assert.ok(typeof sig === 'string');
  assert.ok(sig.includes(`RECIPE: ${knownId}`), 'sig must include RECIPE prefix');
  assert.ok(sig.includes('|'), 'sig must be pipe-separated');
  assert.equal(getVerificationSignature('definitely_not_a_recipe'), null);
});

test('buildBeatJudgePrompt injects <framing_taxonomy> into userParts', () => {
  const result = buildBeatJudgePrompt({
    beat: { beat_id: 'b1', type: 'TALKING_HEAD_CLOSEUP' },
    scene: { scene_id: 'sc1' },
    endframeImage: TINY_JPEG,
    personas: []
  });
  assert.ok(Array.isArray(result.userParts));
  const allText = result.userParts.map(p => p.text || '').join('\n');
  assert.ok(allText.includes('<framing_taxonomy>'),
    'beatRubric userParts must include <framing_taxonomy> block');
});

test('buildBeatJudgePrompt injects <framing_pinned> when beat.framing_intent.id is set', () => {
  const knownId = Object.keys(V4_FRAMING_VOCAB)[0];
  const result = buildBeatJudgePrompt({
    beat: { beat_id: 'b1', type: 'TALKING_HEAD_CLOSEUP', framing_intent: { id: knownId } },
    scene: { scene_id: 'sc1' },
    endframeImage: TINY_JPEG,
    personas: []
  });
  const allText = result.userParts.map(p => p.text || '').join('\n');
  assert.ok(allText.includes('<framing_pinned>'),
    'beatRubric must include <framing_pinned> when beat.framing_intent.id is set');
  assert.ok(allText.includes(`RECIPE: ${knownId}`),
    'pinned block must include the recipe id');
});

test('buildCommercialBeatJudgePrompt injects framing_taxonomy too', () => {
  const result = buildCommercialBeatJudgePrompt({
    beat: { beat_id: 'b1', type: 'TALKING_HEAD_CLOSEUP' },
    scene: { scene_id: 'sc1' },
    endframeImage: TINY_JPEG,
    personas: [],
    commercialBrief: { creative_concept: 'test', style_category: 'hyperreal_premium' }
  });
  const allText = result.userParts.map(p => p.text || '').join('\n');
  assert.ok(allText.includes('<framing_taxonomy>'),
    'commercialBeatRubric userParts must include <framing_taxonomy> block');
});
