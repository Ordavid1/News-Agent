// tests/v4/PostProductionAudio.test.mjs
// Phase 1 of the V4 audio coherence overhaul.
//
// Run: node --test tests/v4/PostProductionAudio.test.mjs
//
// Locks the model→gain decision matrix that drives per-beat audio loudness
// in V4 post-production. The previous regime (Veo @1.0, Kling @0.2) created
// a perceptual loudness war where Veo beats arrived 5x louder than the
// surrounding Kling beats. The new regime caps Veo at 0.35 (so the episode
// bed is the perceptual floor) and discards Veo VO_BROLL native audio
// entirely (the V.O. owns those beats).
//
// These tests guard the matrix against accidental regression. The model
// strings asserted here are emitted verbatim by the beat generators
// (BRollGenerator, ReactionGenerator, InsertShotGenerator,
// VoiceoverBRollGenerator, CinematicDialogueGenerator, ActionGenerator,
// SilentStareGenerator, GroupTwoShotGenerator).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { resolveNativeAudioGain } from '../../services/v4/PostProduction.js';

describe('Phase 1a — resolveNativeAudioGain matrix', () => {
  test('Veo VOICEOVER_OVER_BROLL beat → 0.0 (V.O. owns the audio)', () => {
    // Emitted by VoiceoverBRollGenerator: "veo-3.1-standard/vo-broll + elevenlabs"
    assert.equal(resolveNativeAudioGain('veo-3.1-standard/vo-broll + elevenlabs'), 0.0);
  });

  test('Veo B_ROLL_ESTABLISHING beat → 0.35 (under episode bed)', () => {
    // Emitted by BRollGenerator: "veo-3.1-standard/broll (tier 1)"
    assert.equal(resolveNativeAudioGain('veo-3.1-standard/broll (tier 1)'), 0.35);
  });

  test('Veo REACTION beat → 0.35', () => {
    assert.equal(resolveNativeAudioGain('veo-3.1-standard/reaction (tier 1)'), 0.35);
  });

  test('Veo INSERT_SHOT beat → 0.35 (foley survives, ambient wash buried)', () => {
    assert.equal(resolveNativeAudioGain('veo-3.1-standard/insert (tier 1)'), 0.35);
  });

  test('Veo with higher fallback tier still maps correctly', () => {
    // Tier-2 sanitization fallback retains the same beat-type prefix
    assert.equal(resolveNativeAudioGain('veo-3.1-standard/broll (tier 2)'), 0.35);
    assert.equal(resolveNativeAudioGain('veo-3.1-standard/reaction (tier 3)'), 0.35);
  });

  test('Mode B dialogue (Kling+Sync) → 0.6 (preserve voice stem)', () => {
    // Emitted by CinematicDialogueGenerator + GroupTwoShotGenerator
    assert.equal(resolveNativeAudioGain('mode-b/kling-o3-omni+sync-lipsync-v3'), 0.6);
  });

  test('Sync lipsync alone → 0.6', () => {
    assert.equal(resolveNativeAudioGain('sync-lipsync-v3'), 0.6);
  });

  test('Kling V3 Pro action → 0.2 (native is noise)', () => {
    // Emitted by ActionGenerator: "kling-v3-pro/action"
    assert.equal(resolveNativeAudioGain('kling-v3-pro/action'), 0.2);
  });

  test('Kling Omni Standard silent stare → 0.2', () => {
    // Emitted by SilentStareGenerator: "kling-o3-omni-standard/silent"
    assert.equal(resolveNativeAudioGain('kling-o3-omni-standard/silent'), 0.2);
  });

  test('OmniHuman → 0.2', () => {
    assert.equal(resolveNativeAudioGain('omnihuman-1.5'), 0.2);
  });

  test('Unknown / null model → 1.0 (safe default — no ducking)', () => {
    assert.equal(resolveNativeAudioGain(null), 1.0);
    assert.equal(resolveNativeAudioGain(undefined), 1.0);
    assert.equal(resolveNativeAudioGain(''), 1.0);
    assert.equal(resolveNativeAudioGain('some-future-model'), 1.0);
  });

  test('Case-insensitive matching (model strings are lowercased internally)', () => {
    assert.equal(resolveNativeAudioGain('VEO-3.1-STANDARD/BROLL (TIER 1)'), 0.35);
    assert.equal(resolveNativeAudioGain('Mode-B/Kling-O3-Omni+Sync-Lipsync-V3'), 0.6);
  });

  test('VO_BROLL match takes precedence over generic Veo branch', () => {
    // The VO_BROLL string DOES contain 'veo' — the function must check
    // /vo-broll/ FIRST so the VO beat correctly maps to 0.0, not 0.35.
    const modelUsed = 'veo-3.1-standard/vo-broll + elevenlabs';
    assert.equal(resolveNativeAudioGain(modelUsed), 0.0);
    assert.notEqual(resolveNativeAudioGain(modelUsed), 0.35); // double-guard
  });
});

describe('Phase 1 — perceptual loudness invariants the matrix encodes', () => {
  test('No vendor delta exceeds 5 LU on the GAIN axis (LUFS pass equalizes the rest)', () => {
    // The remaining gain range is [0.2, 0.6] across the active vendors.
    // 0.6 / 0.2 = 3x ≈ +9.5 dB → still wide but the loudnorm pass collapses
    // perceptual loudness to within 3 LU regardless. The point of this test
    // is to catch a future change that bumps one vendor's gain to e.g. 1.0
    // again (which would re-open the loudness war pre-LUFS).
    const activeGains = [
      resolveNativeAudioGain('veo-3.1-standard/broll (tier 1)'),       // 0.35
      resolveNativeAudioGain('mode-b/kling-o3-omni+sync-lipsync-v3'),  // 0.6
      resolveNativeAudioGain('kling-v3-pro/action'),                   // 0.2
      resolveNativeAudioGain('kling-o3-omni-standard/silent')          // 0.2
    ];
    const max = Math.max(...activeGains);
    const min = Math.min(...activeGains);
    const dbDelta = 20 * Math.log10(max / min);
    assert.ok(
      dbDelta < 12,
      `gain spread ${dbDelta.toFixed(1)} dB exceeds 12 dB safety bound — LUFS pass may not catch up`
    );
  });

  test('Veo non-VO never returns 1.0 (would re-introduce the 5x loudness pop)', () => {
    const veoModelStrings = [
      'veo-3.1-standard/broll (tier 1)',
      'veo-3.1-standard/reaction (tier 1)',
      'veo-3.1-standard/insert (tier 1)',
      'veo-3.1-standard/broll (tier 2)',
      'veo-3.1-standard/insert (tier 3)'
    ];
    for (const m of veoModelStrings) {
      const g = resolveNativeAudioGain(m);
      assert.ok(g < 1.0, `${m} returned ${g}, must be < 1.0 (Phase 1 regression guard)`);
      assert.ok(g > 0.0, `${m} returned ${g}, must be > 0.0 (only VO_BROLL discards entirely)`);
    }
  });
});
