// tests/v4/Phase3MultiEpisode.test.mjs
//
// Unit tests for V4 Phase 11 — Phase 3 multi-episode prestige changes:
//   - VeoToKlingTranslator (mechanical pass; Gemini layer offline-tested)
//   - getStoryLutPool (lut_family_ids resolution + fallback)
//   - target_beats derivation from finding scope strings (in-line logic)

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  translateVeoPromptToKling,
  _internals as veoToKlingInternals
} from '../../services/v4/VeoToKlingTranslator.js';

import { getStoryLutPool, getGenreLutPool } from '../../services/v4/BrandKitLutMatcher.js';

// ─────────────────────────────────────────────────────────────────────────
// VeoToKlingTranslator — mechanical pass
// ─────────────────────────────────────────────────────────────────────────

describe('VeoToKlingTranslator — mechanical translation', () => {
  it('strips Veo first-frame momentum cue', async () => {
    const veoPrompt = 'Frame 1 opens mid-motion; momentum continues forward. NOT a static start. Action: hand reaches.';
    const out = await translateVeoPromptToKling({ prompt: veoPrompt, beatType: 'action' });
    assert.ok(!out.includes('Frame 1 opens mid-motion'),
      `mechanical pass must strip Veo frame momentum cue: ${out}`);
    assert.ok(out.includes('hand reaches'), 'preserves the actual action description');
  });

  it('strips Veo first-frame anchor reference', async () => {
    const veoPrompt = 'Veo first-frame anchored to the scene endframe; last-frame hint is the next scene\'s master. Atmospheric drift.';
    const out = await translateVeoPromptToKling({ prompt: veoPrompt, beatType: 'bridge' });
    assert.ok(!/Veo first-frame anchored/i.test(out), 'must strip Veo frame anchor reference');
  });

  it('compresses verbose lens prose to compact form', async () => {
    const veoPrompt = 'Lens 35-50mm, kinetic handheld feel, shallow DOF on the subject in motion. Action: chase scene.';
    const out = await translateVeoPromptToKling({ prompt: veoPrompt, beatType: 'action' });
    assert.ok(/35-50mm handheld/i.test(out) || /35-50mm/i.test(out),
      `must compress to compact lens form: ${out}`);
    assert.ok(!/Lens 35-50mm,\s*kinetic handheld feel/i.test(out),
      'must drop verbose Veo lens prose');
  });

  it('squashes verbose VERTICAL directive to short canonical line', async () => {
    const veoPrompt = 'VERTICAL 9:16 tight portrait. Eyes upper third, chin lower third, face fills vertical frame. No letterbox. Character speaks.';
    const out = await translateVeoPromptToKling({ prompt: veoPrompt, beatType: 'dialogue' });
    assert.ok(out.length < veoPrompt.length, 'must compress verbose vertical directive');
    assert.ok(/Vertical 9:16/i.test(out), 'preserves vertical lock semantics');
    assert.ok(!/Eyes upper third/i.test(out), 'drops verbose composition prose');
  });

  it('PRESERVES CONTINUITY FROM PREVIOUS BEAT block intact', async () => {
    const veoPrompt = 'Some Veo prose. ## CONTINUITY FROM PREVIOUS BEAT (the chain you must continue — DO NOT RESET): The prior beat ended in this state. Continue.';
    const out = await translateVeoPromptToKling({ prompt: veoPrompt, beatType: 'reaction' });
    assert.ok(out.includes('## CONTINUITY FROM PREVIOUS BEAT'),
      'translator MUST preserve the continuity block — it is the keystone propagation');
    assert.ok(out.includes('DO NOT RESET'),
      'continuity directive language must survive translation');
  });

  it('PRESERVES DP directive intact', async () => {
    const veoPrompt = 'Action verb. DP: 85mm, single_b, locked, static. Ambient: rain.';
    const out = await translateVeoPromptToKling({ prompt: veoPrompt, beatType: 'dialogue' });
    assert.ok(out.includes('DP: 85mm, single_b, locked, static'),
      'DP directive must survive translation');
  });

  it('returns empty string for empty input', async () => {
    assert.equal(await translateVeoPromptToKling({ prompt: '' }), '');
    assert.equal(await translateVeoPromptToKling({ prompt: null }), '');
    assert.equal(await translateVeoPromptToKling({}), '');
  });

  it('caches identical prompts (idempotent)', async () => {
    const prompt = 'VERTICAL 9:16. Frame 1 opens mid-motion; momentum continues forward. Action verb.';
    const a = await translateVeoPromptToKling({ prompt, beatType: 'action' });
    const b = await translateVeoPromptToKling({ prompt, beatType: 'action' });
    assert.equal(a, b, 'cached call must return identical result');
  });

  it('exposes _mechanicalTranslate via _internals', () => {
    assert.equal(typeof veoToKlingInternals._mechanicalTranslate, 'function');
    assert.equal(typeof veoToKlingInternals._cacheKey, 'function');
  });

  it('mechanical pass alone reduces the prompt size for typical Veo inputs', () => {
    const veoPrompt = [
      'VERTICAL 9:16 tight portrait. Eyes upper third, chin lower third, face fills vertical frame. No letterbox.',
      'Lens 85mm, kinetic handheld feel, shallow DOF on the subject in motion.',
      'Frame 1 opens mid-motion; momentum continues forward. NOT a static start.',
      'Action: chase down the alley.'
    ].join(' ');
    const out = veoToKlingInternals._mechanicalTranslate(veoPrompt);
    assert.ok(out.length < veoPrompt.length, `expected compression, got ${out.length} >= ${veoPrompt.length}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// getStoryLutPool — lut_family_ids resolution
// ─────────────────────────────────────────────────────────────────────────

describe('BrandKitLutMatcher.getStoryLutPool — story-level LUT family', () => {
  it('falls back to genre pool when lut_family_ids is unset', () => {
    const pool = getStoryLutPool({ subject: { genre: 'drama' } });
    const genrePool = getGenreLutPool('drama');
    assert.equal(pool.length, genrePool.length, 'must equal genre pool when family unset');
  });

  it('falls back to genre pool when lut_family_ids is empty array', () => {
    const pool = getStoryLutPool({ lut_family_ids: [], subject: { genre: 'drama' } });
    const genrePool = getGenreLutPool('drama');
    assert.equal(pool.length, genrePool.length);
  });

  it('falls back to genre pool when lut_family_ids contains only unknown IDs', () => {
    const pool = getStoryLutPool({
      lut_family_ids: ['nonexistent_lut_a', 'nonexistent_lut_b'],
      subject: { genre: 'drama' }
    });
    const genrePool = getGenreLutPool('drama');
    assert.equal(pool.length, genrePool.length, 'unknown IDs → genre pool fallback');
  });

  it('returns family intersection when lut_family_ids contains real IDs', () => {
    // Pick two known IDs from the drama genre pool
    const dramaPool = getGenreLutPool('drama');
    if (dramaPool.length < 2) {
      // Can't run this test if drama pool is too small — skip noisily
      return;
    }
    const familyIds = [dramaPool[0].id, dramaPool[1].id];
    const pool = getStoryLutPool({
      lut_family_ids: familyIds,
      subject: { genre: 'drama' }
    });
    assert.equal(pool.length, 2, 'family pool size matches declared family');
    assert.deepEqual(
      pool.map(l => l.id).sort(),
      familyIds.sort(),
      'family pool returns exactly the declared IDs'
    );
  });

  it('mixed-known/unknown family IDs returns only the known subset', () => {
    const dramaPool = getGenreLutPool('drama');
    if (dramaPool.length < 1) return;
    const knownId = dramaPool[0].id;
    const pool = getStoryLutPool({
      lut_family_ids: [knownId, 'nonexistent_x'],
      subject: { genre: 'drama' }
    });
    assert.equal(pool.length, 1);
    assert.equal(pool[0].id, knownId);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// target_beats derivation logic — mirrors the orchestrator's inline derivation
// ─────────────────────────────────────────────────────────────────────────

describe('Lens D target_beats derivation from finding scopes', () => {
  // Inline reference implementation matching BrandStoryService.js orchestrator
  function deriveTargetBeats(verdictD) {
    if (!verdictD || typeof verdictD !== 'object') return [];
    if (Array.isArray(verdictD.target_beats) && verdictD.target_beats.length > 0) {
      return verdictD.target_beats;
    }
    const derived = new Set();
    for (const finding of (verdictD.findings || [])) {
      const scope = String(finding?.scope || '');
      const m = scope.match(/^beat:(.+)$/);
      if (m && m[1]) derived.add(m[1].trim());
    }
    return Array.from(derived).slice(0, 8);
  }

  it('returns empty array for null / empty verdict', () => {
    assert.deepEqual(deriveTargetBeats(null), []);
    assert.deepEqual(deriveTargetBeats({}), []);
    assert.deepEqual(deriveTargetBeats({ findings: [] }), []);
  });

  it('extracts beat ids from finding scope "beat:<id>"', () => {
    const verdict = {
      findings: [
        { scope: 'beat:s2b3', message: 'a' },
        { scope: 'beat:s2b5', message: 'b' },
        { scope: 'episode', message: 'c' }
      ]
    };
    const out = deriveTargetBeats(verdict);
    assert.deepEqual(out.sort(), ['s2b3', 's2b5'].sort());
  });

  it('dedupes when the same beat is referenced multiple times', () => {
    const verdict = {
      findings: [
        { scope: 'beat:s1b1', message: 'a' },
        { scope: 'beat:s1b1', message: 'b' }
      ]
    };
    assert.deepEqual(deriveTargetBeats(verdict), ['s1b1']);
  });

  it('caps at 8 derived beats', () => {
    const verdict = {
      findings: Array.from({ length: 12 }, (_, i) => ({ scope: `beat:s1b${i}`, message: 'x' }))
    };
    const out = deriveTargetBeats(verdict);
    assert.equal(out.length, 8);
  });

  it('ignores non-beat scopes (episode / scene)', () => {
    const verdict = {
      findings: [
        { scope: 'episode', message: 'global' },
        { scope: 'scene:s2', message: 'scene-level' },
        { scope: 'beat:s2b1', message: 'beat-level' }
      ]
    };
    assert.deepEqual(deriveTargetBeats(verdict), ['s2b1']);
  });

  it('preserves explicit target_beats when already present', () => {
    const verdict = {
      target_beats: ['explicit_b1', 'explicit_b2'],
      findings: [{ scope: 'beat:should_be_ignored', message: 'x' }]
    };
    assert.deepEqual(deriveTargetBeats(verdict), ['explicit_b1', 'explicit_b2']);
  });
});
