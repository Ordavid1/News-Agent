// tests/v4/LutSystemSingleSource.test.mjs
// V4 P1.2 — Single-source LUT system canary.
//
// Asserts:
//   1. Legacy `matchBrandKitToLut` is not exported from BrandKitLutMatcher
//   2. Legacy `getLegacyPool` and `LEGACY_SAFE_FALLBACK` are removed from _internals
//   3. assets/luts/library.json has NO `creative_legacy` array
//   4. None of the 8 legacy .cube files exist on disk
//   5. The spec-safe fallback resolves cleanly via getSafeFallbackLutId()
//   6. genre-registers/library.json contains zero references to legacy LUT ids
//      (substitution successors land in test 6 — guards against re-introduction)
//
// Run: node --test tests/v4/LutSystemSingleSource.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as LutMatcher from '../../services/v4/BrandKitLutMatcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');

const LEGACY_LUT_IDS = [
  'bs_warm_cinematic',
  'bs_cool_noir',
  'bs_golden_hour',
  'bs_urban_grit',
  'bs_dreamy_ethereal',
  'bs_retro_film',
  'bs_high_contrast_moody',
  'bs_naturalistic'
];

test('matchBrandKitToLut is not exported (legacy matcher retired)', () => {
  assert.equal(typeof LutMatcher.matchBrandKitToLut, 'undefined',
    'Legacy matchBrandKitToLut must be removed from the public surface');
});

test('_internals does not expose legacy artifacts', () => {
  const internals = LutMatcher._internals;
  assert.equal(typeof internals.getLegacyPool, 'undefined',
    'getLegacyPool must be removed from _internals');
  assert.equal(typeof internals.LEGACY_SAFE_FALLBACK, 'undefined',
    'LEGACY_SAFE_FALLBACK constant must be removed from _internals');
  assert.equal(internals.SPEC_SAFE_FALLBACK, 'bs_doc_natural_window',
    'Spec safe fallback must be the canonical bs_doc_natural_window');
});

test('library.json has no creative_legacy array', () => {
  const libPath = path.join(REPO_ROOT, 'assets/luts/library.json');
  const lib = JSON.parse(fs.readFileSync(libPath, 'utf-8'));
  assert.equal(lib.creative_legacy, undefined,
    'library.json must not contain creative_legacy after P1.2');
  assert.ok(Array.isArray(lib.creative) && lib.creative.length > 0,
    'library.json.creative must remain populated');
});

test('legacy .cube files are deleted from disk', () => {
  const lutDir = path.join(REPO_ROOT, 'assets/luts');
  for (const id of LEGACY_LUT_IDS) {
    const cubePath = path.join(lutDir, `${id}.cube`);
    assert.equal(fs.existsSync(cubePath), false,
      `Legacy ${id}.cube must be deleted from disk`);
  }
});

test('getSafeFallbackLutId returns the canonical spec fallback', () => {
  const fallback = LutMatcher.getSafeFallbackLutId();
  assert.equal(fallback, 'bs_doc_natural_window');
});

test('isSpecSystemEnabled always returns true (back-compat shim)', () => {
  // The shim stays around so external callers don't break, but the spec
  // system is the only system. Set BRAND_STORY_LUT_SPEC_SYSTEM=false and
  // confirm it's ignored.
  const original = process.env.BRAND_STORY_LUT_SPEC_SYSTEM;
  process.env.BRAND_STORY_LUT_SPEC_SYSTEM = 'false';
  try {
    assert.equal(LutMatcher.isSpecSystemEnabled(), true,
      'isSpecSystemEnabled must always return true post-P1.2');
  } finally {
    if (original === undefined) delete process.env.BRAND_STORY_LUT_SPEC_SYSTEM;
    else process.env.BRAND_STORY_LUT_SPEC_SYSTEM = original;
  }
});

test('genre-registers/library.json contains zero legacy LUT id references', () => {
  const grPath = path.join(REPO_ROOT, 'assets/genre-registers/library.json');
  const txt = fs.readFileSync(grPath, 'utf-8');
  const found = [];
  for (const id of LEGACY_LUT_IDS) {
    const re = new RegExp(`"${id}"`, 'g');
    const count = (txt.match(re) || []).length;
    if (count > 0) found.push(`${id} (${count} occurrences)`);
  }
  assert.deepEqual(found, [], `Legacy LUT ids must not appear in genre register library: ${found.join(', ')}`);
});

test('legacy LUT id lookup via findEntry returns null (no spec entry shadows them)', () => {
  for (const id of LEGACY_LUT_IDS) {
    const result = LutMatcher._internals.findEntry(id);
    assert.equal(result, null, `findEntry('${id}') must return null after legacy delete`);
  }
});
