// services/v4/__tests__/GenerativeLut.skin.test.js
// Phase 2 smoke test — exercises the brand-palette quality gates and the
// skin-tone preservation safeguard. Plain Node script (no test framework).

import assert from 'assert';
import {
  generateLutFromPalette,
  generateLutFromBrandKit,
  validateSkinPreservation,
  validateBrandPalette
} from '../GenerativeLut.js';

let pass = 0;
let fail = 0;

function it(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => { console.log(`  ✓ ${name}`); pass++; })
    .catch(err => { console.error(`  ✗ ${name}\n      ${err.message}`); fail++; });
}

function describe(name, fn) {
  console.log(`\n${name}`);
  return fn();
}

function hex(h) { return [{ hex: h }]; }

await describe('validateSkinPreservation (channel-order)', () => Promise.all([
  it('identity (strength=0) is always safe', () => {
    const result = validateSkinPreservation({
      targets: [[0.0, 0.5, 1.0]],
      strength: 0
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.inversions, 0);
  }),

  it('warm earth palette preserves R>G>B on all samples (warm shifts are flattering, not damage)', () => {
    const result = validateSkinPreservation({
      targets: [[0.96, 0.90, 0.83], [0.77, 0.54, 0.44], [0.42, 0.27, 0.14]],
      strength: 0.18
    });
    assert.strictEqual(result.ok, true, `expected pass, got ${result.reason || 'fail'}`);
  }),

  it('saturated cyan palette inverts skin channels', () => {
    const result = validateSkinPreservation({
      targets: [[0.0, 0.85, 0.95], [0.05, 0.75, 1.0]],
      strength: 0.50
    });
    assert.strictEqual(result.ok, false, 'expected reject for saturated cyan @0.50');
    assert.ok(result.inversions > 0);
  }),

  it('strong green palette inverts skin channels (sickly)', () => {
    const result = validateSkinPreservation({
      targets: [[0.10, 0.90, 0.10], [0.05, 0.75, 0.20]],
      strength: 0.40
    });
    assert.strictEqual(result.ok, false);
  }),

  it('low strength (0.10) gives hostile palette a fighting chance', () => {
    const result = validateSkinPreservation({
      targets: [[0.0, 0.85, 0.95]],
      strength: 0.10
    });
    // Sample grid filters out non-skin (R<G or G<B in input) samples, so
    // count varies — just verify the validator ran successfully.
    assert.ok(result.sampleCount > 0, 'no samples were tested');
  })
]));

await describe('validateBrandPalette', () => Promise.all([
  it('rejects empty palette', () => {
    const r = validateBrandPalette({ targets: [], strength: 0.3 });
    assert.strictEqual(r.ok, false);
  }),

  it('rejects palette with too-narrow luma span (mono-luma)', () => {
    // Two same-luma reds — collapses luma differentiation.
    const r = validateBrandPalette({
      targets: [[0.5, 0.05, 0.05], [0.55, 0.10, 0.10]],
      strength: 0.3
    });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /luma span/);
  }),

  it('rejects too-desaturated palette', () => {
    const r = validateBrandPalette({
      targets: [[0.5, 0.5, 0.5], [0.6, 0.6, 0.6], [0.4, 0.4, 0.4]],  // grays
      strength: 0.3
    });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /desaturated/);
  }),

  it('rejects mono-luma palette before reaching skin gate', () => {
    // All in same dark luma band — luma_span gate fires.
    const r = validateBrandPalette({
      targets: [[0.125, 0.0, 0.376], [0.376, 0.0, 0.125], [0.0, 0.125, 0.376]],
      strength: 0.50
    });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /luma span/);
  }),

  it('accepts a skin-friendly warm-earth brand palette at typical drama strength', () => {
    // Warm earth tones — pulls skin toward natural amber, no hue inversion.
    // bs_warm_cinematic hex_signature: #F5E6D3 / #C4896F / #6B4423
    const r = validateBrandPalette({
      targets: [[0.96, 0.90, 0.83], [0.77, 0.54, 0.44], [0.42, 0.27, 0.14]],
      strength: 0.18  // drama default
    });
    assert.strictEqual(r.ok, true, r.reason);
  })
]));

await describe('generateLutFromPalette quality gating', () => Promise.all([
  it('returns rejected:true for hostile palette + high strength', async () => {
    const result = await generateLutFromPalette({
      colorPalette: hex('#00DDFF'),  // pure cyan, single hue
      strength: 0.50,
      brandName: 'unit-test-cyan'
    });
    assert.strictEqual(result.rejected, true);
    assert.strictEqual(result.lutId, null);
  }),

  it('successfully generates for skin-friendly warm-earth palette', async () => {
    const result = await generateLutFromPalette({
      colorPalette: [{ hex: '#F5E6D3' }, { hex: '#C4896F' }, { hex: '#6B4423' }],
      strength: 0.18,
      brandName: 'unit-test-warm-earth'
    });
    assert.ok(!result.rejected, `unexpectedly rejected: ${result.reason}`);
    assert.ok(result.lutId);
    assert.ok(result.lutId.startsWith('gen_'));
  }),

  it('rejects all-dark palette via luma-span gate', async () => {
    const result = await generateLutFromPalette({
      colorPalette: [{ hex: '#200060' }, { hex: '#600020' }, { hex: '#002060' }],
      strength: 0.50,
      brandName: 'unit-test-dark'
    });
    assert.strictEqual(result.rejected, true);
    assert.match(result.reason, /luma span/);
  })
]));

await describe('generateLutFromBrandKit (orchestrator wrapper)', () => Promise.all([
  it('returns null when palette rejected', async () => {
    const brandKit = {
      brand_summary: 'cyan-only test brand',
      color_palette: [{ hex: '#00DDFF' }]
    };
    const result = await generateLutFromBrandKit(brandKit, { strength: 0.50 });
    assert.strictEqual(result, null);
  }),

  it('returns generated LUT for skin-friendly warm-earth brand kit', async () => {
    const brandKit = {
      brand_summary: 'warm earth brand',
      color_palette: [
        { hex: '#F5E6D3' },
        { hex: '#C4896F' },
        { hex: '#6B4423' }
      ]
    };
    const result = await generateLutFromBrandKit(brandKit, { strength: 0.18 });
    assert.ok(result, 'expected a result, got null');
    assert.ok(result.lutId);
  })
]));

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
