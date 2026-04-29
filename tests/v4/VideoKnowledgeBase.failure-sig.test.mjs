// tests/v4/VideoKnowledgeBase.failure-sig.test.mjs
//
// Phase 1 (deepen-mcp) — failure-signature integration.
//
// Verifies:
//   - Taxonomy loads with the expected canonical category set.
//   - Every model's failure_signatures[].taxonomy_id resolves to a taxonomy
//     category (data-integrity tripwire — catches typos in YAML).
//   - Dossier surfaces failure_signatures with [taxonomy_id, severity N] tag.
//   - Formatter cap (1500 chars) still respected with the new failure block.
//   - Loader multi-dir scan: video/image/audio/utility dirs all participate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadKnowledgeBase,
  loadFailureTaxonomy,
  lookupModelForJudging,
  formatModelDossierForPrompt,
  _resetForTests
} from '../../services/v4/VideoKnowledgeBase.js';

// ─── Taxonomy loader ──────────────────────────────────────────────────

test('loadFailureTaxonomy — loads 9 canonical categories (6 Spotlight + 3 V4)', () => {
  _resetForTests();
  const tax = loadFailureTaxonomy();
  assert.equal(tax.categories.length, 9);
});

test('loadFailureTaxonomy — every category has id + name + description', () => {
  _resetForTests();
  const tax = loadFailureTaxonomy();
  for (const c of tax.categories) {
    assert.ok(c.id, `category missing id: ${JSON.stringify(c).slice(0, 80)}`);
    assert.ok(c.name, `category missing name: ${c.id}`);
    assert.ok(c.description, `category missing description: ${c.id}`);
  }
});

test('loadFailureTaxonomy — Spotlight base categories present', () => {
  _resetForTests();
  const tax = loadFailureTaxonomy();
  const ids = new Set(tax.categories.map(c => c.id));
  for (const required of ['physics', 'app_disapp', 'logical', 'motion', 'anatomy', 'adherence']) {
    assert.ok(ids.has(required), `missing Spotlight category: ${required}`);
  }
});

test('loadFailureTaxonomy — V4 extension categories present', () => {
  _resetForTests();
  const tax = loadFailureTaxonomy();
  const ids = new Set(tax.categories.map(c => c.id));
  for (const required of ['identity_drift', 'lipsync_drift', 'text_garble']) {
    assert.ok(ids.has(required), `missing V4 extension category: ${required}`);
  }
});

test('loadFailureTaxonomy — byId map provides O(1) lookup', () => {
  _resetForTests();
  const tax = loadFailureTaxonomy();
  assert.equal(tax.byId.get('identity_drift').name, 'Identity drift');
  assert.equal(tax.byId.get('physics').name, 'Physics violation');
  assert.equal(tax.byId.get('nonexistent'), undefined);
});

// ─── Tripwire: every model's signatures resolve to a known taxonomy_id ─

test('TRIPWIRE — every failure_signatures[].taxonomy_id resolves to taxonomy', () => {
  _resetForTests();
  const kb = loadKnowledgeBase();
  const tax = loadFailureTaxonomy();
  const validIds = new Set(tax.categories.map(c => c.id));

  let totalSigs = 0;
  let failures = [];
  for (const m of kb.models) {
    if (!Array.isArray(m.failure_signatures)) continue;
    for (const sig of m.failure_signatures) {
      totalSigs++;
      if (!sig.taxonomy_id) {
        failures.push(`${m.id}/${sig.id || '?'}: missing taxonomy_id`);
        continue;
      }
      if (!validIds.has(sig.taxonomy_id)) {
        failures.push(`${m.id}/${sig.id || '?'}: invalid taxonomy_id="${sig.taxonomy_id}"`);
      }
    }
  }
  assert.equal(failures.length, 0, `Taxonomy integrity violations:\n  - ${failures.join('\n  - ')}`);
  assert.ok(totalSigs >= 50, `expected >=50 total signatures, got ${totalSigs}`);
});

// ─── Tripwire: severity is 1-5 integer ───────────────────────────────

test('TRIPWIRE — every failure_signature severity is integer 1-5', () => {
  _resetForTests();
  const kb = loadKnowledgeBase();
  let bad = [];
  for (const m of kb.models) {
    if (!Array.isArray(m.failure_signatures)) continue;
    for (const sig of m.failure_signatures) {
      if (typeof sig.severity !== 'number' || sig.severity < 1 || sig.severity > 5) {
        bad.push(`${m.id}/${sig.id}: severity=${sig.severity}`);
      }
    }
  }
  assert.equal(bad.length, 0, `severity violations:\n  - ${bad.join('\n  - ')}`);
});

// ─── Coverage: all 23 base models have signatures ────────────────────

test('coverage — all 23 base models have at least 1 failure_signature', () => {
  _resetForTests();
  const kb = loadKnowledgeBase();
  // Filter to "base" model docs (those with type set to video|image, exclude audio/utility for this assertion since we ship those in Phase 2)
  const baseModels = kb.models.filter(m => m.type === 'video' || m.type === 'image');
  const without = baseModels.filter(m => !Array.isArray(m.failure_signatures) || m.failure_signatures.length === 0);
  assert.equal(without.length, 0, `models without failure_signatures: ${without.map(m => m.id).join(', ')}`);
  assert.ok(baseModels.length >= 23, `expected >=23 base models, got ${baseModels.length}`);
});

// ─── Multi-dir loader (Phase 2 hook) ──────────────────────────────────

test('loadKnowledgeBase — sourceDirs covers all 4 model dirs', () => {
  _resetForTests();
  const kb = loadKnowledgeBase();
  assert.ok(Array.isArray(kb.sourceDirs));
  assert.equal(kb.sourceDirs.length, 4);
  assert.ok(kb.sourceDirs[0].endsWith('models/video'));
  assert.ok(kb.sourceDirs[1].endsWith('models/image'));
  assert.ok(kb.sourceDirs[2].endsWith('models/audio'));
  assert.ok(kb.sourceDirs[3].endsWith('models/utility'));
});

// ─── Dossier shape exposes failure_signatures ─────────────────────────

test('dossier — failure_signatures array is exposed (top 5)', () => {
  _resetForTests();
  const d = lookupModelForJudging('mode-b/kling-o3-omni+sync-lipsync-v3');
  assert.ok(Array.isArray(d.failure_signatures));
  assert.ok(d.failure_signatures.length >= 1);
  assert.ok(d.failure_signatures.length <= 5);
  // Each entry has the expected shape
  const sig = d.failure_signatures[0];
  assert.ok(sig.taxonomy_id, 'sig missing taxonomy_id');
  assert.ok(sig.name, 'sig missing name');
  assert.ok(typeof sig.severity === 'number', 'sig missing severity');
});

// ─── Formatter renders failure_signatures with taxonomy + severity tag ─

test('formatter — output contains [taxonomy_id, severity N] tag', () => {
  _resetForTests();
  const d = lookupModelForJudging('mode-b/kling-o3-omni+sync-lipsync-v3');
  const text = formatModelDossierForPrompt(d);
  assert.match(text, /\[lipsync_drift, severity 4\]/);
});

test('formatter — output uses "weaknesses to watch for (failure_signatures):" label', () => {
  _resetForTests();
  const d = lookupModelForJudging('kling-v3-pro/action');
  const text = formatModelDossierForPrompt(d);
  assert.match(text, /weaknesses to watch for \(failure_signatures\):/);
});

test('formatter — output stays under 1500 chars across known LOOKUP_CASES', () => {
  const cases = [
    'mode-b/kling-o3-omni+sync-lipsync-v3',
    'mode-a/omnihuman-1.5',
    'kling-v3-pro/action',
    'kling-v3-pro-multishot/montage',
    'veo-3.1-standard/reaction (tier 2)',
    'veo-3.1-fast/reaction (tier 1)',
    'veo-3.1-lite/broll (tier 3)',
    'veo-3.1-standard/vo-broll + elevenlabs',
    'kling-o3-omni-twoshot+dialogue-v3+sync',
  ];
  for (const c of cases) {
    _resetForTests();
    const d = lookupModelForJudging(c);
    if (!d) continue;
    const text = formatModelDossierForPrompt(d);
    assert.ok(text.length <= 1500, `'${c}' rendered ${text.length} chars (cap 1500)`);
  }
});

test('formatter — fix_strategy surfaced inline with each signature', () => {
  _resetForTests();
  const d = lookupModelForJudging('mode-b/kling-o3-omni+sync-lipsync-v3');
  const text = formatModelDossierForPrompt(d);
  // The first signature for kling-3-omni (lipsync_drift) has a fix_strategy
  // that mentions "Sync Lipsync v3" — verify it surfaces inline.
  assert.match(text, /fix:.*Sync Lipsync v3/);
});

// ─── Capabilities defensive filter (regression test for [object Object] bug) ─

test('formatter — capabilities never render as [object Object]', () => {
  _resetForTests();
  // kling-3-omni's capabilities array contains nested objects — verify filter
  const d = lookupModelForJudging('mode-b/kling-o3-omni+sync-lipsync-v3');
  const text = formatModelDossierForPrompt(d);
  assert.doesNotMatch(text, /\[object Object\]/);
});
