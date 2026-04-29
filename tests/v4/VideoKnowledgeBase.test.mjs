// tests/v4/VideoKnowledgeBase.test.mjs
//
// Unit tests for the in-process Video Knowledge Base reader.
// Covers loader (multi-doc YAML, cache identity), the full LOOKUP_CASES
// table of every generator-side modelUsed string emitted by the V4 beat
// generators, graceful nulls, tier-aware lookup for the veo family,
// chain-component detection, formatter length cap, and the
// buildModelKbPart convenience helper that beat-level rubrics consume.
//
// Patterns mirror tests/v4/DirectorRubrics.test.mjs and
// tests/v4/DirectorMode.test.mjs — node:test + node:assert/strict, one
// assertion per test() call, top-level imports, _resetForTests between
// tests so each starts from a cold cache.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadKnowledgeBase,
  lookupModelForJudging,
  formatModelDossierForPrompt,
  buildModelKbPart,
  _resetForTests
} from '../../services/v4/VideoKnowledgeBase.js';

// ─── Loader ──────────────────────────────────────────────────────────

test('loadKnowledgeBase — loads a non-trivial set of video model docs', () => {
  _resetForTests();
  const kb = loadKnowledgeBase();
  assert.ok(kb.models.length >= 10, `expected >=10 models, got ${kb.models.length}`);
});

test('loadKnowledgeBase — every doc has id + name + provider (universal fields)', () => {
  _resetForTests();
  const kb = loadKnowledgeBase();
  for (const m of kb.models) {
    assert.ok(m.id, `missing id on ${JSON.stringify(m).slice(0, 80)}`);
    assert.ok(m.name, `missing name on ${m.id}`);
    assert.ok(m.provider, `missing provider on ${m.id}`);
  }
});

test('loadKnowledgeBase — second call returns the same cached object (reference equality)', () => {
  _resetForTests();
  const a = loadKnowledgeBase();
  const b = loadKnowledgeBase();
  assert.equal(a, b);
});

test('loadKnowledgeBase — multi-document kling-3.yaml yields 2 video docs (kling-3-pro + kling-3-omni)', () => {
  _resetForTests();
  const kb = loadKnowledgeBase();
  // Filter by type to exclude the kling-create-voice utility (Phase 2 addition)
  const ids = kb.models
    .filter(m => m.provider === 'Kuaishou' && m.type === 'video')
    .map(m => m.id)
    .sort();
  assert.deepEqual(ids, ['kling-3-omni', 'kling-3-pro']);
});

test('loadKnowledgeBase — alias index maps kling-o3-omni → kling-3-omni', () => {
  _resetForTests();
  const kb = loadKnowledgeBase();
  assert.equal(kb.aliasIndex.get('kling-o3-omni'), 'kling-3-omni');
});

test('loadKnowledgeBase — alias index maps kling-v3-pro → kling-3-pro', () => {
  _resetForTests();
  const kb = loadKnowledgeBase();
  assert.equal(kb.aliasIndex.get('kling-v3-pro'), 'kling-3-pro');
});

test('loadKnowledgeBase — alias index maps veo-3.1-standard → veo-3.1', () => {
  _resetForTests();
  const kb = loadKnowledgeBase();
  assert.equal(kb.aliasIndex.get('veo-3.1-standard'), 'veo-3.1');
});

// ─── Lookup table — every generator-side modelUsed string ────────────

const LOOKUP_CASES = [
  { input: 'mode-b/kling-o3-omni+sync-lipsync-v3', id: 'kling-3-omni', chain: ['sync-lipsync-v3'] },
  { input: 'kling-o3-omni-twoshot+sync',           id: 'kling-3-omni', chain: ['sync'] },
  { input: 'kling-o3-omni-twoshot',                id: 'kling-3-omni', chain: [] },
  { input: 'kling-o3-omni-twoshot+dialogue-v3+sync', id: 'kling-3-omni', chain: ['dialogue-v3', 'sync'] },
  { input: 'kling-o3-omni-twoshot+dialogue-v3',    id: 'kling-3-omni', chain: ['dialogue-v3'] },
  { input: 'mode-a/omnihuman-1.5',                 id: 'omnihuman-1.5' },
  { input: 'kling-o3-omni-standard/silent',        id: 'kling-3-omni' },
  { input: 'kling-v3-pro/text-override',           id: 'kling-3-pro' },
  { input: 'kling-v3-pro/action',                  id: 'kling-3-pro' },
  { input: 'kling-v3-pro-multishot/montage',       id: 'kling-3-pro' },
  { input: 'veo-3.1-standard/reaction (tier 2)',   id: 'veo-3.1', tierName: /Standard/i },
  { input: 'veo-3.1-fast/reaction (tier 1)',       id: 'veo-3.1', tierName: /Fast/i },
  { input: 'veo-3.1-lite/broll (tier 3)',          id: 'veo-3.1', tierName: /Lite/i },
  { input: 'veo-3.1-standard/vo-broll + elevenlabs', id: 'veo-3.1', tierName: /Standard/i, chain: ['elevenlabs'] },
  { input: 'veo-3.1-standard/bridge (tier 2)',     id: 'veo-3.1', tierName: /Standard/i }
];

for (const c of LOOKUP_CASES) {
  test(`lookup — '${c.input}' → ${c.id}${c.tierName ? ` (tier matches ${c.tierName})` : ''}`, () => {
    _resetForTests();
    const d = lookupModelForJudging(c.input);
    assert.ok(d, `expected dossier, got null for '${c.input}'`);
    assert.equal(d.id, c.id);
    if (c.chain) assert.deepEqual(d.chain_components, c.chain);
    if (c.tierName) {
      assert.ok(d.tier, `expected tier object on dossier for '${c.input}'`);
      assert.match(d.tier.name, c.tierName);
    }
  });
}

// ─── Graceful nulls — never throw, always return null ────────────────

test('lookup — null input returns null without throwing', () => {
  _resetForTests();
  assert.equal(lookupModelForJudging(null), null);
});

test('lookup — undefined input returns null without throwing', () => {
  _resetForTests();
  assert.equal(lookupModelForJudging(undefined), null);
});

test('lookup — empty-string input returns null without throwing', () => {
  _resetForTests();
  assert.equal(lookupModelForJudging(''), null);
});

test('lookup — ffmpeg/text-card returns null (not-applicable)', () => {
  _resetForTests();
  assert.equal(lookupModelForJudging('ffmpeg/text-card'), null);
});

test('lookup — unknown id returns null without throwing', () => {
  _resetForTests();
  assert.equal(lookupModelForJudging('foobar-9000/wat'), null);
});

// ─── Chain components — explicit assertions ──────────────────────────

test('chain — sync-lipsync-v3 detected from + separator', () => {
  _resetForTests();
  const d = lookupModelForJudging('mode-b/kling-o3-omni+sync-lipsync-v3');
  assert.deepEqual(d.chain_components, ['sync-lipsync-v3']);
});

test('chain — elevenlabs detected from + separator with surrounding whitespace', () => {
  _resetForTests();
  const d = lookupModelForJudging('veo-3.1-standard/vo-broll + elevenlabs');
  assert.deepEqual(d.chain_components, ['elevenlabs']);
});

test('chain — multiple components stack in order: dialogue-v3 then sync', () => {
  _resetForTests();
  const d = lookupModelForJudging('kling-o3-omni-twoshot+dialogue-v3+sync');
  assert.deepEqual(d.chain_components, ['dialogue-v3', 'sync']);
});

// ─── Formatter ───────────────────────────────────────────────────────

test('formatModelDossierForPrompt — output is bracketed by <model_kb> tags', () => {
  _resetForTests();
  const d = lookupModelForJudging('mode-b/kling-o3-omni+sync-lipsync-v3');
  const text = formatModelDossierForPrompt(d);
  assert.match(text, /^<model_kb>/);
  assert.match(text, /<\/model_kb>$/);
});

test('formatModelDossierForPrompt — never exceeds 1500 chars across all known modelUsed cases', () => {
  for (const c of LOOKUP_CASES) {
    _resetForTests();
    const d = lookupModelForJudging(c.input);
    if (!d) continue;
    const text = formatModelDossierForPrompt(d);
    assert.ok(text.length <= 1500, `dossier for '${c.input}' was ${text.length} chars (cap 1500)`);
  }
});

test('formatModelDossierForPrompt — handles model with no prompt_tips without empty section header', () => {
  // Synthetic dossier with no prompt_tips (some heygen / runway docs lack it).
  const d = {
    id: 'test-model',
    name: 'Test',
    provider: 'TestCo',
    capabilities: ['text-to-video'],
    envelope: { max_duration: '5s', max_resolution: '1080p', fps: 24 },
    weaknesses: ['x'],
    prompt_tips: [],
    unique_features: [],
    tier: null,
    chain_components: []
  };
  const text = formatModelDossierForPrompt(d);
  assert.ok(text.length > 0);
  assert.doesNotMatch(text, /prompt tips[^\n]*\n\s*<\/model_kb>/);
});

test('formatModelDossierForPrompt — surfaces tier sub-info when matched', () => {
  _resetForTests();
  const d = lookupModelForJudging('veo-3.1-fast/reaction (tier 1)');
  const text = formatModelDossierForPrompt(d);
  assert.match(text, /tier .*Fast/i);
});

test('formatModelDossierForPrompt — surfaces chain components when present', () => {
  _resetForTests();
  const d = lookupModelForJudging('mode-b/kling-o3-omni+sync-lipsync-v3');
  const text = formatModelDossierForPrompt(d);
  assert.match(text, /chain components applied: sync-lipsync-v3/);
});

test('formatModelDossierForPrompt — null dossier returns empty string', () => {
  assert.equal(formatModelDossierForPrompt(null), '');
});

// ─── buildModelKbPart — the integration helper for rubric prompt builders ─

test('buildModelKbPart — known modelUsed returns a Vertex-shaped {text} part', () => {
  _resetForTests();
  const part = buildModelKbPart({ modelUsed: 'mode-b/kling-o3-omni+sync-lipsync-v3' });
  assert.ok(part);
  assert.deepEqual(Object.keys(part), ['text']);
  assert.match(part.text, /^<model_kb>/);
});

test('buildModelKbPart — null routingMetadata returns null', () => {
  assert.equal(buildModelKbPart(null), null);
});

test('buildModelKbPart — routingMetadata without modelUsed returns null', () => {
  assert.equal(buildModelKbPart({ costUsd: 1.4 }), null);
});

test('buildModelKbPart — non-applicable modelUsed (ffmpeg/text-card) returns null', () => {
  _resetForTests();
  assert.equal(buildModelKbPart({ modelUsed: 'ffmpeg/text-card' }), null);
});

test('buildModelKbPart — unknown modelUsed returns null', () => {
  _resetForTests();
  assert.equal(buildModelKbPart({ modelUsed: 'foobar-9000/wat' }), null);
});

// ─── Allow-list discipline — sensitive fields not leaked to dossier ──

test('dossier — does NOT include pricing field (allow-list discipline)', () => {
  _resetForTests();
  const d = lookupModelForJudging('mode-b/kling-o3-omni+sync-lipsync-v3');
  assert.equal(d.pricing, undefined);
});

test('dossier — does NOT include api_providers field (allow-list discipline)', () => {
  _resetForTests();
  const d = lookupModelForJudging('mode-b/kling-o3-omni+sync-lipsync-v3');
  assert.equal(d.api_providers, undefined);
});

test('dossier — does NOT include official_documentation field (allow-list discipline)', () => {
  _resetForTests();
  const d = lookupModelForJudging('mode-b/kling-o3-omni+sync-lipsync-v3');
  assert.equal(d.official_documentation, undefined);
});
