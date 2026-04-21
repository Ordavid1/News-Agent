// tests/v4/GeminiJsonRepair.test.mjs
// Unit tests for BrandStoryService._parseGeminiJson's defensive repair chain.
//
// The storyline generation emits Gemini responses ~20-30KB long. Three failure
// modes have been seen in production:
//   1. Raw LF/CR/TAB inside long text fields (season_bible 500+ words) —
//      forbidden in JSON strings, must be escaped.
//   2. Trailing commas before } or ] in arrays.
//   3. Trailing garbage after the JSON body (markdown fences, commentary).
//
// The parser must recover from all three without data loss.
//
// Run: node --test tests/v4/GeminiJsonRepair.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// The parser is a method on BrandStoryService. Import the class and exercise
// the method against a minimal instance (the method is pure — no deps).
import brandStoryService from '../../services/BrandStoryService.js';

const parse = (text) => brandStoryService._parseGeminiJson(text);

describe('GeminiJsonRepair — well-formed passthrough', () => {
  test('valid JSON parses on the fast path', () => {
    const out = parse('{"a":1,"b":"hello"}');
    assert.deepEqual(out, { a: 1, b: 'hello' });
  });

  test('markdown-fenced JSON is unwrapped', () => {
    const out = parse('```json\n{"a":1}\n```');
    assert.deepEqual(out, { a: 1 });
  });

  test('fenced with bare ``` (no language tag) also unwraps', () => {
    const out = parse('```\n{"a":1}\n```');
    assert.deepEqual(out, { a: 1 });
  });
});

describe('GeminiJsonRepair — raw control chars inside string values', () => {
  test('raw LF inside a string value is escaped and parses', () => {
    const broken = '{"bible":"paragraph one.\nparagraph two.\n\nfinal line."}';
    const out = parse(broken);
    assert.equal(out.bible, 'paragraph one.\nparagraph two.\n\nfinal line.');
  });

  test('raw CR + LF inside a string value is escaped and parses', () => {
    const broken = '{"bible":"line one.\r\nline two."}';
    const out = parse(broken);
    assert.equal(out.bible, 'line one.\r\nline two.');
  });

  test('raw TAB inside a string value is escaped and parses', () => {
    const broken = '{"k":"before\tafter"}';
    const out = parse(broken);
    assert.equal(out.k, 'before\tafter');
  });

  test('structural whitespace OUTSIDE strings is preserved (not escaped)', () => {
    const input = '{\n  "a": 1,\n  "b": 2\n}';
    const out = parse(input);
    assert.deepEqual(out, { a: 1, b: 2 });
  });

  test('already-escaped \\n inside a string is untouched (no double-escape)', () => {
    // The raw text is the JSON literal  {"a":"line1\nline2"}  — backslash-n
    const input = String.raw`{"a":"line1\nline2"}`;
    const out = parse(input);
    assert.equal(out.a, 'line1\nline2');
  });

  test('season_bible-style long multi-paragraph field with raw \\n\\n works', () => {
    // Realistic: Gemini writes a 500-word season_bible with real paragraph breaks.
    const longField = 'The world of Skyline Gardens is a vertical Eden.\n\nThe characters pursue visibility.\n\nTHEMATIC ARGUMENT: True leadership is stillness.';
    const broken = `{"season_bible":"${longField}"}`;
    const out = parse(broken);
    assert.ok(out.season_bible.includes('THEMATIC ARGUMENT'));
    assert.ok(out.season_bible.includes('vertical Eden'));
  });
});

describe('GeminiJsonRepair — trailing commas', () => {
  test('trailing comma before } is stripped', () => {
    // Also needs a raw-LF to push parser past pass 1 into pass 3
    const broken = '{"a":1,\n"b":2,\n}';
    const out = parse(broken);
    assert.deepEqual(out, { a: 1, b: 2 });
  });

  test('trailing comma before ] is stripped', () => {
    const broken = '{"items":[\n1,\n2,\n3,\n]}';
    const out = parse(broken);
    assert.deepEqual(out, { items: [1, 2, 3] });
  });
});

describe('GeminiJsonRepair — trailing garbage truncation', () => {
  test('trailing markdown fence after JSON body is truncated', () => {
    const broken = '{"a":1,"b":2}\n```\nsome commentary after the JSON';
    const out = parse(broken);
    assert.deepEqual(out, { a: 1, b: 2 });
  });

  test('nested braces in string values do not confuse the matcher', () => {
    const input = '{"regex":"match {this}","count":2}\nextraneous';
    const out = parse(input);
    assert.deepEqual(out, { regex: 'match {this}', count: 2 });
  });
});

describe('GeminiJsonRepair — combined defects', () => {
  test('raw LFs + trailing comma + trailing garbage all recover', () => {
    const broken = '{"bible":"line one.\nline two.\n",\n"a":1,\n}\n```\nnotes';
    const out = parse(broken);
    assert.equal(out.bible, 'line one.\nline two.\n');
    assert.equal(out.a, 1);
  });

  test('unrecoverable garbage (not starting with { or [) throws', () => {
    assert.throws(() => parse('not json at all'), /does not start with/);
  });
});
