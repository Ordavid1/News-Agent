// tests/v4/GenreCoverageCanary.test.mjs
// V4 P5.3 — Genre coverage canary.
//
// Tripwire: every genre declared in the genre-register library must have:
//   1. At least 2 LUTs in assets/luts/library.json (genre matches the register's
//      genre_id OR an aliased genre key like 'noir-mystery' → 'noir')
//   2. A non-empty genre register entry (already enforced by the genre register
//      library's own validator — we re-assert here as a cross-check)
//
// Catches regressions where a future PR adds a genre without LUT coverage,
// or removes LUTs and leaves a genre orphaned. Run early in the test suite
// so the failure surface is clear.
//
// Run: node --test tests/v4/GenreCoverageCanary.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');

// Some register IDs map to LUT-library genre buckets that share aesthetics:
//   register 'mystery'   → LUT bucket 'noir' (mystery and noir share visual register)
//   register 'sci-fi'    → LUT bucket 'sci-fi' or 'scifi' (variant spelling tolerance)
// This map records intentional aliases. Add only when justified by an actual
// shared aesthetic register — don't paper over missing coverage.
const REGISTER_TO_LUT_GENRE_ALIASES = Object.freeze({
  'mystery': ['noir', 'mystery'],
  'sci-fi': ['sci-fi', 'scifi']
});

// Tier-A genres documented as "shares LUT bucket with neighbor genre" — this
// is an explicit acknowledgment that a Tier-A genre intentionally has fewer
// dedicated LUTs because its aesthetic is covered by a neighbor. Each entry
// must include the rationale so future audits know if it's still valid.
const TIER_A_THIN_LUT_COVERAGE = new Map([
  ['documentary', { minLuts: 1, rationale: 'documentary aesthetic intentionally narrow — bs_doc_natural_window is the canonical neutral grade; secondary doc LUTs share with drama/period registers' }]
]);

// Tier-B genres are by-design lightweight — they don't require dedicated LUTs.
// They share LUTs from neighbor Tier-A genres. Document each here with the
// rationale; this list is the audit surface for "which genres are
// intentionally LUT-light".
const TIER_B_NO_DEDICATED_LUTS = new Set([
  'inspirational',  // shares with documentary / drama
  'adventure',      // shares with action / fantasy
  'slice-of-life'   // shares with drama / documentary
]);

function loadLutLibrary() {
  const p = path.join(REPO_ROOT, 'assets/luts/library.json');
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function loadGenreRegisters() {
  const p = path.join(REPO_ROOT, 'assets/genre-registers/library.json');
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function lutsMatchingGenre(lutLib, genreKey) {
  const candidates = REGISTER_TO_LUT_GENRE_ALIASES[genreKey] || [genreKey];
  const candidateSet = new Set(candidates);
  return (lutLib.creative || []).filter(l => candidateSet.has(String(l.genre || '').toLowerCase().trim()));
}

test('genre register library and LUT library both load', () => {
  const lutLib = loadLutLibrary();
  const grLib = loadGenreRegisters();
  assert.ok(Array.isArray(lutLib.creative) && lutLib.creative.length > 0,
    'LUT library must have creative entries');
  assert.ok(Array.isArray(grLib.registers) && grLib.registers.length > 0,
    'Genre register library must have registers');
});

test('every Tier-A genre register has the expected LUT coverage (≥2 default; documented thin allowed)', () => {
  const lutLib = loadLutLibrary();
  const grLib = loadGenreRegisters();
  const violations = [];
  for (const reg of grLib.registers) {
    if (reg.tier !== 'A') continue;
    const luts = lutsMatchingGenre(lutLib, reg.genre_id);
    const thinAllowance = TIER_A_THIN_LUT_COVERAGE.get(reg.genre_id);
    const minRequired = thinAllowance ? thinAllowance.minLuts : 2;
    if (luts.length < minRequired) {
      violations.push(`${reg.genre_id} (tier A) has only ${luts.length} LUT(s) — expected ≥${minRequired}` +
        (thinAllowance ? ` (thin-coverage allowance: "${thinAllowance.rationale}")` : ''));
    }
  }
  assert.deepEqual(violations, [], `Tier-A LUT coverage gaps:\n${violations.join('\n')}`);
});

test('every Tier-B genre is either covered by ≥1 LUT or documented as no-dedicated', () => {
  const lutLib = loadLutLibrary();
  const grLib = loadGenreRegisters();
  const undocumented = [];
  for (const reg of grLib.registers) {
    if (reg.tier !== 'B') continue;
    const luts = lutsMatchingGenre(lutLib, reg.genre_id);
    if (luts.length === 0 && !TIER_B_NO_DEDICATED_LUTS.has(reg.genre_id)) {
      undocumented.push(`${reg.genre_id} (tier B) has 0 LUTs and is NOT in TIER_B_NO_DEDICATED_LUTS allowlist — either add a LUT or document the rationale.`);
    }
  }
  assert.deepEqual(undocumented, [],
    `Tier-B genres without LUTs and without explicit allowlist:\n${undocumented.join('\n')}`);
});

test('every register has the canonical fields (genre_id, display_name, tier, pacing_rules)', () => {
  const grLib = loadGenreRegisters();
  const violations = [];
  for (const reg of grLib.registers) {
    for (const field of ['genre_id', 'display_name', 'tier']) {
      if (!reg[field]) violations.push(`${reg.genre_id || '(no id)'}: missing required field ${field}`);
    }
    if (reg.tier === 'A' && !reg.pacing_rules) {
      violations.push(`${reg.genre_id}: tier A but missing pacing_rules`);
    }
  }
  assert.deepEqual(violations, [], `Genre register schema violations:\n${violations.join('\n')}`);
});

test('TIER_B_NO_DEDICATED_LUTS allowlist matches tier-B genres in register library', () => {
  // Sanity check: every entry in the allowlist should actually exist as a
  // Tier-B genre. Stale entries (genres that were upgraded to A or removed)
  // should be cleaned up.
  const grLib = loadGenreRegisters();
  const tierBIds = new Set(grLib.registers.filter(r => r.tier === 'B').map(r => r.genre_id));
  const stale = [];
  for (const allowedId of TIER_B_NO_DEDICATED_LUTS) {
    if (!tierBIds.has(allowedId)) stale.push(allowedId);
  }
  assert.deepEqual(stale, [], `Stale allowlist entries:\n${stale.join('\n')}`);
});
