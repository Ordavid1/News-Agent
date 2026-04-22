// tests/v4/VeoPromptSanitizer.test.mjs
// Unit tests for the Vertex AI Veo content-filter mitigation layer.
//
// The three-tier retry strategy trades creative specificity for submission
// acceptance only when Vertex refuses. This suite pins the tier contracts:
//   Tier 0 (original) — untouched
//   Tier 1 (sanitised) — strip persona names + body-part phrasing
//   Tier 2 (minimal) — product-hero boilerplate from subject name + style
//
// Run: node --test tests/v4/VeoPromptSanitizer.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  isVeoContentFilterError,
  sanitizeTier1,
  sanitizeTier2
} from '../../services/v4/VeoPromptSanitizer.js';

describe('isVeoContentFilterError — classification', () => {
  test('detects "usage guidelines" phrase', () => {
    const err = new Error('Veo 3.1 Standard operation failed: The prompt could not be submitted. This prompt contains words that violate Vertex AI\'s usage guidelines.');
    assert.equal(isVeoContentFilterError(err), true);
  });

  test('detects support code 29xxxxxx', () => {
    const err = new Error('Something. Support codes: 29310472.');
    assert.equal(isVeoContentFilterError(err), true);
  });

  test('detects "could not be submitted" phrase', () => {
    const err = new Error('Vertex: The prompt could not be submitted. Try rephrasing.');
    assert.equal(isVeoContentFilterError(err), true);
  });

  test('detects "content policy" phrase', () => {
    const err = new Error('Rejected by content policy');
    assert.equal(isVeoContentFilterError(err), true);
  });

  test('ContentFilterError class is classified', () => {
    const err = new Error('blocked');
    err.name = 'ContentFilterError';
    assert.equal(isVeoContentFilterError(err), true);
  });

  test('unrelated errors are NOT classified', () => {
    assert.equal(isVeoContentFilterError(new Error('429 rate limited')), false);
    assert.equal(isVeoContentFilterError(new Error('connection refused')), false);
    assert.equal(isVeoContentFilterError(new Error('operation timeout')), false);
    assert.equal(isVeoContentFilterError(null), false);
    assert.equal(isVeoContentFilterError(undefined), false);
  });
});

describe('sanitizeTier1 — strip persona names + body-part phrasing', () => {
  test('removes "<Name>\'s <body-part>" pattern', () => {
    const input = 'A luxury silver wristwatch on Leo\'s wrist.';
    const out = sanitizeTier1(input, ['Leo']);
    // Body-part phrasing neutralised and persona name stripped
    assert.ok(!out.includes('Leo'), `persona name should be gone: ${out}`);
    assert.ok(!out.match(/\bwrist\b/), `body part reference should be neutralised: ${out}`);
    assert.ok(out.includes('in frame'), `should substitute neutral framing: ${out}`);
  });

  test('handles multiple persona names', () => {
    const input = 'The keycard cradled in Maya\'s hands as Daniel watches.';
    const out = sanitizeTier1(input, ['Maya', 'Daniel']);
    assert.ok(!out.includes('Maya'));
    assert.ok(!out.includes('Daniel'));
  });

  test('handles pronoun + body part (her wrist, his hand)', () => {
    const input = 'The watch on her wrist.';
    const out = sanitizeTier1(input, []);
    assert.ok(!out.match(/\bher wrist\b/i));
    assert.ok(out.includes('in frame'));
  });

  test('leaves unrelated prompt text alone', () => {
    const input = 'Cinematic closeup of a black leather journal on a teak desk, 85mm lens.';
    const out = sanitizeTier1(input, ['Maya']);
    assert.ok(out.includes('black leather journal'));
    assert.ok(out.includes('teak desk'));
    assert.ok(out.includes('85mm'));
  });

  test('does not strip legitimate proper nouns (brand names, locations)', () => {
    const input = 'A Rolex Submariner in frame against a Tokyo skyline.';
    // "Rolex" and "Tokyo" aren't persona names — they must stay
    const out = sanitizeTier1(input, ['Maya', 'Daniel']);
    assert.ok(out.includes('Rolex'));
    assert.ok(out.includes('Tokyo'));
  });

  test('collapses artefacts from substitutions (no double-space, no stray prepositions)', () => {
    const input = 'A silver watch on Leo\'s wrist with a glowing dial.';
    const out = sanitizeTier1(input, ['Leo']);
    assert.ok(!out.match(/\s{2,}/), `no double spaces: "${out}"`);
    assert.ok(!out.match(/\bon in frame\b/), `no "on in frame" artefact: "${out}"`);
  });

  test('idempotent: sanitising clean input returns unchanged structure', () => {
    const input = 'A silver watch held in frame, cinematic macro, shallow depth of field.';
    const out = sanitizeTier1(input, ['Maya', 'Leo']);
    assert.equal(out, input);
  });

  test('handles empty / null input gracefully', () => {
    assert.equal(sanitizeTier1('', ['Leo']), '');
    assert.equal(sanitizeTier1(null, ['Leo']), null);
    assert.equal(sanitizeTier1(undefined, ['Leo']), undefined);
  });
});

describe('sanitizeTier2 — minimal product-hero boilerplate', () => {
  test('produces a valid product-hero prompt from subject name alone', () => {
    const out = sanitizeTier2({ subjectName: 'Sela Binuy keycard' });
    assert.ok(out.includes('Sela Binuy keycard'));
    assert.ok(out.toLowerCase().includes('cinematic'));
    assert.ok(out.toLowerCase().includes('macro') || out.toLowerCase().includes('hero'));
    // Must NOT include person names or body parts by construction
    assert.ok(!out.match(/\b(Maya|Leo|Daniel)'s\b/));
    assert.ok(!out.match(/\bwrist\b/));
  });

  test('includes subject description when provided', () => {
    const out = sanitizeTier2({
      subjectName: 'Sela Binuy keycard',
      subjectDescription: 'sleek black with gold chevron logo'
    });
    assert.ok(out.includes('sleek black'));
    assert.ok(out.includes('gold chevron'));
  });

  test('preserves style prefix when provided', () => {
    const out = sanitizeTier2({
      subjectName: 'perfume bottle',
      stylePrefix: 'warm golden-hour tones, anamorphic lens flare'
    });
    assert.ok(out.includes('anamorphic'));
    assert.ok(out.includes('golden-hour'));
  });

  test('falls back to "the subject" when no name given', () => {
    const out = sanitizeTier2({});
    assert.ok(out.includes('the subject'));
  });
});

describe('integration — tier 1 fixes the real-world refusal pattern', () => {
  // The two refusal patterns pulled from production logs (2026-04-21 and
  // 2026-04-22). Both involve "on <Name>'s wrist" — Vertex's content filter
  // reads persona-name + body-part as a person-identity signal.
  //
  // Product names like "wristwatch" are LEGITIMATE and must survive
  // sanitisation — the regex uses \b word boundaries to distinguish the
  // compound from the body-part.

  test('"A luxury silver wristwatch on Leo\'s wrist." sanitises to a Veo-safe prompt', () => {
    const refused = 'A luxury silver wristwatch on Leo\'s wrist.';
    const safe = sanitizeTier1(refused, ['Leo']);
    assert.notEqual(safe, refused);
    // Name stripped
    assert.ok(!safe.includes('Leo'));
    // Possessive body-part phrasing neutralised (word-boundary match)
    assert.ok(!safe.match(/\bLeo's wrist\b/));
    assert.ok(!safe.match(/\bher wrist\b/i));
    assert.ok(!safe.match(/\bhis wrist\b/i));
    // Product name survives (wristwatch is a compound, not body-part phrasing)
    assert.ok(safe.toLowerCase().includes('wristwatch'));
    // Safe framing substituted
    assert.ok(safe.toLowerCase().includes('in frame'));
  });

  test('"A high-fashion mechanical watch on Leo\'s wrist." (today\'s log) sanitises correctly', () => {
    const refused = 'A high-fashion mechanical watch on Leo\'s wrist.';
    const safe = sanitizeTier1(refused, ['Leo']);
    assert.ok(!safe.includes('Leo'));
    // "on Leo's wrist" neutralised
    assert.ok(!safe.match(/\bLeo's wrist\b/));
    // Product phrasing preserved
    assert.ok(safe.toLowerCase().includes('mechanical watch'));
    // Neutral framing
    assert.ok(safe.toLowerCase().includes('in frame'));
  });
});
