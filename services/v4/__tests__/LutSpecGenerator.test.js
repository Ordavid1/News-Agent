// services/v4/__tests__/LutSpecGenerator.test.js
// Phase 1 smoke test — exercises the declarative LUT spec generator and the
// matcher's spec-system path. Runs as a plain Node script (no test framework
// required) so it can be invoked directly from `node`.

import fs from 'fs';
import path from 'path';
import assert from 'assert';
import { fileURLToPath } from 'url';

import {
  generateLutFromSpec,
  resolveSpecLutPath,
  specHash,
  _internals as genInternals
} from '../LutSpecGenerator.js';

import {
  getLutFilePath,
  getGenreLutPool,
  getDefaultLutForGenre,
  getStrengthForGenre,
  getSafeFallbackLutId,
  isSpecSystemEnabled,
  resolveEpisodeLut,
  _internals as matcherInternals
} from '../BrandKitLutMatcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

// ─────────────────────────────────────────────────────────────────────
// LutSpecGenerator
// ─────────────────────────────────────────────────────────────────────

describe('LutSpecGenerator', () => {
  it('specHash is deterministic for identical specs', () => {
    const a = { lift: [0.01, 0.02, 0.03], gamma: [1, 1, 1], gain: [1, 1, 1], saturation: 1 };
    const b = { lift: [0.01, 0.02, 0.03], gamma: [1, 1, 1], gain: [1, 1, 1], saturation: 1 };
    assert.strictEqual(specHash(a), specHash(b));
  });

  it('specHash differs when spec differs', () => {
    const a = { lift: [0.01, 0.02, 0.03], saturation: 1 };
    const b = { lift: [0.01, 0.02, 0.04], saturation: 1 };
    assert.notStrictEqual(specHash(a), specHash(b));
  });

  it('generates a valid 17×17×17 cube file', () => {
    const entry = {
      id: 'bs_unit_test_neutral',
      genre: 'documentary',
      look: 'identity (neutral)',
      spec: {
        lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1],
        saturation: 1,
        shadow_tint: [0, 0, 0], midtone_tint: [0, 0, 0], highlight_tint: [0, 0, 0]
      }
    };
    const { filePath } = generateLutFromSpec(entry);
    assert.ok(fs.existsSync(filePath), 'cube file was not created');

    const text = fs.readFileSync(filePath, 'utf-8');
    assert.match(text, /LUT_3D_SIZE 17/);
    assert.match(text, /DOMAIN_MIN 0\.0 0\.0 0\.0/);
    assert.match(text, /DOMAIN_MAX 1\.0 1\.0 1\.0/);

    const dataLines = text.split('\n').filter(line => /^[0-9]/.test(line));
    assert.strictEqual(dataLines.length, 17 * 17 * 17, `expected 4913 entries, got ${dataLines.length}`);

    // Identity LUT — verify the (1,0,0) entry is approximately (1/16, 0, 0).
    // Layout: B outer, G middle, R inner. Index for (rIn=1, gIn=0, bIn=0) = 1.
    const firstEntry = dataLines[0].trim().split(/\s+/).map(Number);
    assert.ok(Math.abs(firstEntry[0]) < 1e-4, `first entry r should be 0, got ${firstEntry[0]}`);
    assert.ok(Math.abs(firstEntry[1]) < 1e-4, `first entry g should be 0, got ${firstEntry[1]}`);
    assert.ok(Math.abs(firstEntry[2]) < 1e-4, `first entry b should be 0, got ${firstEntry[2]}`);

    const secondEntry = dataLines[1].trim().split(/\s+/).map(Number);
    const expectedR = 1 / 16;
    assert.ok(Math.abs(secondEntry[0] - expectedR) < 1e-3,
      `second entry r should be ~${expectedR}, got ${secondEntry[0]}`);
  });

  it('caches output by spec hash (idempotent)', () => {
    const entry = {
      id: 'bs_unit_test_cache',
      spec: { lift: [0.05, 0.05, 0.05], gamma: [1.02, 1.02, 1.02], gain: [1, 1, 1], saturation: 1.05 }
    };
    const a = generateLutFromSpec(entry);
    const b = generateLutFromSpec(entry);
    assert.strictEqual(a.filePath, b.filePath);
    assert.strictEqual(b.cached, true);
  });

  it('a saturation=0 spec produces grayscale output (B&W)', () => {
    const entry = {
      id: 'bs_unit_test_bw',
      spec: { lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1], saturation: 0 }
    };
    const { filePath } = generateLutFromSpec(entry);
    const text = fs.readFileSync(filePath, 'utf-8');
    const dataLines = text.split('\n').filter(line => /^[0-9]/.test(line));

    // Pick a colorful entry: input (1, 0, 0) = pure red.
    // Index in the cube: bi=0, gi=0, ri=16 → line index 16.
    const redEntry = dataLines[16].trim().split(/\s+/).map(Number);
    const [r, g, b] = redEntry;
    // sat=0 collapses everything to luma. Pure red luma = 0.2126.
    assert.ok(Math.abs(r - g) < 1e-3, `R should equal G in grayscale, got ${r} vs ${g}`);
    assert.ok(Math.abs(g - b) < 1e-3, `G should equal B in grayscale, got ${g} vs ${b}`);
  });
});

// ─────────────────────────────────────────────────────────────────────
// BrandKitLutMatcher (spec system path)
// ─────────────────────────────────────────────────────────────────────

describe('BrandKitLutMatcher — spec system', () => {
  it('library loads with the expected spec entries', () => {
    const lib = matcherInternals.loadLutLibrary();
    assert.ok(Array.isArray(lib.creative), 'creative pool missing');
    const specs = lib.creative.filter(l => l.spec);
    assert.ok(specs.length >= 22, `expected ≥22 spec LUTs, got ${specs.length}`);
  });

  it('every spec entry has a genre', () => {
    const lib = matcherInternals.loadLutLibrary();
    const missing = (lib.creative || []).filter(l => l.spec && !l.genre);
    assert.strictEqual(missing.length, 0, `entries missing genre: ${missing.map(l => l.id).join(', ')}`);
  });

  it('every genre has at least one default LUT', () => {
    const genres = ['drama', 'action', 'thriller', 'comedy', 'noir', 'horror',
                    'romance', 'documentary', 'sci-fi', 'fantasy', 'period', 'commercial'];
    for (const g of genres) {
      const def = getDefaultLutForGenre(g);
      assert.ok(def, `no default LUT for genre "${g}"`);
      assert.strictEqual(def.is_default_for_genre, true, `default LUT for "${g}" is not marked is_default_for_genre`);
    }
  });

  it('getGenreLutPool returns genre-filtered entries', () => {
    const dramaPool = getGenreLutPool('drama');
    assert.ok(dramaPool.length >= 3, `drama pool should have ≥3, got ${dramaPool.length}`);
    assert.ok(dramaPool.every(l => l.genre === 'drama'));
  });

  it('getStrengthForGenre returns the per-genre default', () => {
    assert.strictEqual(getStrengthForGenre('documentary'), 0.10);
    assert.strictEqual(getStrengthForGenre('drama'), 0.18);
    // 2026-04-28: dropped 0.50 → 0.25 to eliminate inter-beat color cliffs
    assert.strictEqual(getStrengthForGenre('commercial'), 0.25);
    assert.strictEqual(getStrengthForGenre('unknown'), 0.20); // default
    assert.strictEqual(getStrengthForGenre(null), 0.20);
  });

  it('getLutFilePath resolves a spec entry to a real file', () => {
    const filePath = getLutFilePath('bs_drama_motivated_natural');
    assert.ok(filePath, 'resolved path is null');
    assert.ok(fs.existsSync(filePath), `cube file does not exist at ${filePath}`);
    assert.match(filePath, /generated_genre/);
  });

  it('getLutFilePath resolves a legacy entry to its real file (if present)', () => {
    const filePath = getLutFilePath('bs_naturalistic');
    // Only assert when the legacy file actually exists on disk.
    if (filePath) {
      assert.ok(fs.existsSync(filePath));
    }
  });

  it('resolveEpisodeLut waterfall', () => {
    assert.strictEqual(resolveEpisodeLut({ locked_lut_id: 'X' }, {}), 'X');
    assert.strictEqual(resolveEpisodeLut({ brand_kit_lut_id: 'Y' }, {}), 'Y');
    assert.strictEqual(resolveEpisodeLut({}, { lut_id: 'Z' }), 'Z');
    assert.strictEqual(resolveEpisodeLut({}, { scene_description: { lut_id: 'W' } }), 'W');
    // Unspecified → safe fallback (depends on env flag at test time)
    const fallback = resolveEpisodeLut({}, {});
    assert.strictEqual(fallback, getSafeFallbackLutId());
  });

  it('isSpecSystemEnabled honors the env flag', () => {
    const original = process.env.BRAND_STORY_LUT_SPEC_SYSTEM;
    process.env.BRAND_STORY_LUT_SPEC_SYSTEM = 'false';
    assert.strictEqual(isSpecSystemEnabled(), false);
    process.env.BRAND_STORY_LUT_SPEC_SYSTEM = 'true';
    assert.strictEqual(isSpecSystemEnabled(), true);
    if (original === undefined) delete process.env.BRAND_STORY_LUT_SPEC_SYSTEM;
    else process.env.BRAND_STORY_LUT_SPEC_SYSTEM = original;
  });

  it('safe fallback id depends on spec-system flag', () => {
    const original = process.env.BRAND_STORY_LUT_SPEC_SYSTEM;
    process.env.BRAND_STORY_LUT_SPEC_SYSTEM = 'true';
    assert.strictEqual(getSafeFallbackLutId(), 'bs_doc_natural_window');
    process.env.BRAND_STORY_LUT_SPEC_SYSTEM = 'false';
    assert.strictEqual(getSafeFallbackLutId(), 'bs_naturalistic');
    if (original === undefined) delete process.env.BRAND_STORY_LUT_SPEC_SYSTEM;
    else process.env.BRAND_STORY_LUT_SPEC_SYSTEM = original;
  });
});

// ─────────────────────────────────────────────────────────────────────
// Generate cube files for ALL spec entries (smoke test for the full library)
// ─────────────────────────────────────────────────────────────────────

describe('Library smoke — every spec entry generates a valid cube', () => {
  const lib = matcherInternals.loadLutLibrary();
  for (const entry of (lib.creative || [])) {
    if (!entry.spec) continue;
    it(`${entry.id} generates a valid cube file`, () => {
      const cubePath = resolveSpecLutPath(entry);
      assert.ok(cubePath, `failed to resolve ${entry.id}`);
      assert.ok(fs.existsSync(cubePath), `cube missing at ${cubePath}`);

      const text = fs.readFileSync(cubePath, 'utf-8');
      assert.match(text, /LUT_3D_SIZE 17/);
      const dataLines = text.split('\n').filter(line => /^[0-9]/.test(line));
      assert.strictEqual(dataLines.length, 4913, `${entry.id}: expected 4913 entries, got ${dataLines.length}`);

      // Every value must be in [0, 1]
      let outOfRange = 0;
      for (const line of dataLines) {
        const vals = line.trim().split(/\s+/).map(Number);
        for (const v of vals) {
          if (!Number.isFinite(v) || v < 0 || v > 1) outOfRange++;
        }
      }
      assert.strictEqual(outOfRange, 0, `${entry.id}: ${outOfRange} values outside [0,1]`);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
