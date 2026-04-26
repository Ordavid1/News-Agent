// tests/v4/SonicWorld.test.mjs
// Phase 4 of the V4 audio coherence overhaul.
//
// Run: node --test tests/v4/SonicWorld.test.mjs
//
// Tests the pure-function pieces of the episode-level sonic_world mix:
//   1. _buildOverlayEnvelope — the J-cut volume expression builder
//   2. _resolveEpisodeSonicWorld — the schema resolver / legacy synthesizer
//
// The ffmpeg-touching helpers (_generateEpisodeBaseBed, applyEpisodeSonicWorld)
// are integration-tested via live episode runs (eyes-closed acceptance test).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  _buildOverlayEnvelope,
  _resolveEpisodeSonicWorld,
  SCENE_OVERLAY_PRE_ROLL_SEC,
  SCENE_OVERLAY_POST_TAIL_SEC,
  SCENE_OVERLAY_RAMP_SEC
} from '../../services/v4/PostProduction.js';

describe('Phase 4 — _buildOverlayEnvelope (J-cut volume expression)', () => {
  test('produces a 4-arm if-tree (zero / ramp-in / hold / ramp-out / zero)', () => {
    const expr = _buildOverlayEnvelope(0, 10, 0.5);
    // The expression is nested if(lt(t,...), ..., if(lt(t,...), ..., ...))
    // with 4 if() opens
    const ifCount = (expr.match(/if\(lt\(/g) || []).length;
    assert.equal(ifCount, 4, `expected 4 nested if() arms, got ${ifCount}: ${expr}`);
  });

  test('intensity is encoded as the peak gain in the expression', () => {
    const expr = _buildOverlayEnvelope(2.0, 6.0, 0.3);
    // 0.3 should appear at least once as the peak gain
    assert.ok(expr.includes('0.3000'), `intensity 0.3 not found in expression: ${expr}`);
  });

  test('start and end times are encoded as the outer if() bounds', () => {
    const startSec = 4.5;
    const endSec = 9.8;
    const expr = _buildOverlayEnvelope(startSec, endSec, 0.5);
    assert.ok(expr.includes(startSec.toFixed(3)), 'startSec not in expression');
    assert.ok(expr.includes(endSec.toFixed(3)), 'endSec not in expression');
  });

  test('ramp duration is the configured constant (not a magic number)', () => {
    const expr = _buildOverlayEnvelope(0, 10, 1.0);
    assert.ok(
      expr.includes(SCENE_OVERLAY_RAMP_SEC.toFixed(3)),
      'ramp constant must appear as the divisor in the linear ramp arm'
    );
  });

  test('zero intensity collapses the peak to literal 0', () => {
    const expr = _buildOverlayEnvelope(0, 10, 0);
    assert.ok(expr.includes('0.0000'), 'intensity 0 should be encoded as 0.0000');
  });

  test('symmetric ramps — same time spent ramping in as ramping out', () => {
    // The expression structure should always have both ramp arms,
    // regardless of the absolute window size
    const expr = _buildOverlayEnvelope(1.0, 11.0, 0.7);
    const rampInBound = (1.0 + SCENE_OVERLAY_RAMP_SEC).toFixed(3);
    const rampOutStart = (11.0 - SCENE_OVERLAY_RAMP_SEC).toFixed(3);
    assert.ok(expr.includes(rampInBound), `ramp-in end ${rampInBound} not in expression`);
    assert.ok(expr.includes(rampOutStart), `ramp-out start ${rampOutStart} not in expression`);
  });
});

describe('Phase 4 — _resolveEpisodeSonicWorld (schema resolver + legacy synth)', () => {
  test('returns null on empty / malformed scene_description', () => {
    assert.equal(_resolveEpisodeSonicWorld(null), null);
    assert.equal(_resolveEpisodeSonicWorld(undefined), null);
    assert.equal(_resolveEpisodeSonicWorld('not-an-object'), null);
  });

  test('passes through an authored sonic_world unchanged', () => {
    const authored = {
      base_palette: 'low industrial drone with concrete reverb',
      spectral_anchor: { description: 'sub-bass anchor', always_present: true, level_dB: -18 },
      scene_variations: [
        { scene_id: 's1', overlay: 'wind', intensity: 0.85 }
      ]
    };
    const resolved = _resolveEpisodeSonicWorld({ sonic_world: authored });
    assert.equal(resolved, authored);
  });

  test('returns null when no sonic_world AND no legacy ambient_bed_prompt', () => {
    const sd = {
      title: 'no-audio episode',
      scenes: [
        { scene_id: 's1', beats: [] },
        { scene_id: 's2', beats: [] }
      ]
    };
    assert.equal(_resolveEpisodeSonicWorld(sd), null);
  });

  test('synthesizes a backward-compat sonic_world from legacy per-scene beds', () => {
    const sd = {
      title: 'legacy episode',
      scenes: [
        { scene_id: 's1', ambient_bed_prompt: 'industrial drone, distant traffic', beats: [] },
        { scene_id: 's2', ambient_bed_prompt: 'sterile hum, server fans', beats: [] }
      ]
    };
    const resolved = _resolveEpisodeSonicWorld(sd);
    assert.ok(resolved, 'legacy synth should produce a sonic_world');
    assert.equal(resolved.base_palette, 'industrial drone, distant traffic', 'first scene bed becomes base palette');
    assert.equal(resolved.spectral_anchor.always_present, true);
    assert.equal(resolved.scene_variations.length, 1, 'second scene becomes an overlay');
    assert.equal(resolved.scene_variations[0].scene_id, 's2');
    assert.equal(resolved.scene_variations[0].overlay, 'sterile hum, server fans');
    assert.equal(resolved._generated_by, 'legacy_synth');
  });

  test('legacy synth deduplicates: identical per-scene beds → no overlays', () => {
    const sd = {
      title: 'all-same-bed legacy episode',
      scenes: [
        { scene_id: 's1', ambient_bed_prompt: 'shared bed', beats: [] },
        { scene_id: 's2', ambient_bed_prompt: 'shared bed', beats: [] }
      ]
    };
    const resolved = _resolveEpisodeSonicWorld(sd);
    assert.equal(resolved.base_palette, 'shared bed');
    assert.equal(resolved.scene_variations.length, 0, 'identical bed across scenes — no overlay needed');
  });

  test('authored sonic_world wins even when legacy fields ALSO present', () => {
    const sd = {
      sonic_world: {
        base_palette: 'authored bed',
        spectral_anchor: { description: 'x', always_present: true, level_dB: -18 },
        scene_variations: []
      },
      scenes: [
        { scene_id: 's1', ambient_bed_prompt: 'legacy bed' }
      ]
    };
    const resolved = _resolveEpisodeSonicWorld(sd);
    assert.equal(resolved.base_palette, 'authored bed', 'authored block must take precedence over legacy');
  });
});

describe('Phase 4 — pre-roll / post-tail constants are sane (J-cut window math)', () => {
  test('pre-roll < 1.5s (otherwise scene cuts feel sloppy)', () => {
    assert.ok(SCENE_OVERLAY_PRE_ROLL_SEC < 1.5);
    assert.ok(SCENE_OVERLAY_PRE_ROLL_SEC > 0);
  });

  test('post-tail > pre-roll (overlay tails are typically longer than the lead-in)', () => {
    assert.ok(SCENE_OVERLAY_POST_TAIL_SEC >= SCENE_OVERLAY_PRE_ROLL_SEC);
  });

  test('ramp duration < pre-roll (the ramp-in completes before the cut)', () => {
    assert.ok(
      SCENE_OVERLAY_RAMP_SEC < SCENE_OVERLAY_PRE_ROLL_SEC,
      'ramp must finish ramping in before the picture cut, otherwise overlay arrives late'
    );
  });
});
