// tests/v4/Phase2AudioMix.test.mjs
//
// Unit tests for V4 Phase 11 — Phase 2 audio mix changes:
//   - _resolveMixProfile (sidechain ducking profile selector)
//   - PostProduction grain unification env flag (smoke check the export)
//
// The actual sidechaincompress filter is exercised end-to-end during pipeline
// runs (live ffmpeg calls); these tests cover the pure logic only.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { _resolveMixProfile } from '../../services/v4/PostProduction.js';

describe('PostProduction._resolveMixProfile — sidechain profile selector', () => {
  it('returns the standard profile for empty / null beat metadata', () => {
    const a = _resolveMixProfile(null);
    assert.equal(a.name, 'standard');
    assert.ok(a.threshold > 0);
    assert.ok(a.ratio > 1);
    assert.ok(a.attack > 0);
    assert.ok(a.release > 0);

    const b = _resolveMixProfile([]);
    assert.equal(b.name, 'standard');
  });

  it('selects "drama" when ≥40% of beats are emotional_hold', () => {
    const beats = [
      { beat_id: 'b1', dialogue: 'hello', emotional_hold: false },
      { beat_id: 'b2', dialogue: 'pause', emotional_hold: true },
      { beat_id: 'b3', dialogue: 'reflect', emotional_hold: true },
      { beat_id: 'b4', dialogue: 'continue', emotional_hold: false },
      { beat_id: 'b5', dialogue: 'hold', emotional_hold: true }
    ];
    const profile = _resolveMixProfile(beats);
    assert.equal(profile.name, 'drama');
    // Drama has slower release than standard (gives the held silence more
    // breathing room before music swells back).
    assert.ok(profile.release >= 600, `drama release expected ≥600ms, got ${profile.release}`);
  });

  it('selects "action" when ≥40% of beats are pace_hint=fast/kinetic/tight', () => {
    const beats = [
      { beat_id: 'b1', pace_hint: 'fast' },
      { beat_id: 'b2', pace_hint: 'kinetic' },
      { beat_id: 'b3', pace_hint: 'tight' },
      { beat_id: 'b4', pace_hint: null },
      { beat_id: 'b5', pace_hint: 'normal' }
    ];
    const profile = _resolveMixProfile(beats);
    assert.equal(profile.name, 'action');
    // Action has fast attack, short release (music ducks aggressively under
    // dialogue then snaps back).
    assert.ok(profile.attack <= 15, `action attack expected ≤15ms, got ${profile.attack}`);
    assert.ok(profile.release <= 250, `action release expected ≤250ms, got ${profile.release}`);
  });

  it('falls through to "standard" when neither profile dominates', () => {
    const beats = [
      { beat_id: 'b1' },
      { beat_id: 'b2', emotional_hold: true },
      { beat_id: 'b3', pace_hint: 'fast' },
      { beat_id: 'b4' }
    ];
    const profile = _resolveMixProfile(beats);
    assert.equal(profile.name, 'standard');
  });

  it('drama profile dominates when both emotional_hold and kinetic ≥40% (drama wins)', () => {
    // Edge case: equal ratios. The selector checks emotional_hold first.
    const beats = [
      { beat_id: 'b1', emotional_hold: true, pace_hint: 'fast' },
      { beat_id: 'b2', emotional_hold: true, pace_hint: 'kinetic' },
      { beat_id: 'b3', emotional_hold: false, pace_hint: null }
    ];
    const profile = _resolveMixProfile(beats);
    assert.equal(profile.name, 'drama');
  });

  it('all profiles have valid sidechaincompress parameter ranges', () => {
    // Sanity: every profile must be valid for FFmpeg sidechaincompress.
    const profiles = [
      _resolveMixProfile([]),
      _resolveMixProfile([{ emotional_hold: true }]),
      _resolveMixProfile([{ pace_hint: 'fast' }])
    ];
    for (const p of profiles) {
      // threshold: 0..1 (linear amplitude)
      assert.ok(p.threshold > 0 && p.threshold <= 1,
        `${p.name} threshold out of range: ${p.threshold}`);
      // ratio: 1..20 typical
      assert.ok(p.ratio >= 1 && p.ratio <= 20,
        `${p.name} ratio out of range: ${p.ratio}`);
      // attack: 0.01..2000 ms per FFmpeg docs
      assert.ok(p.attack >= 1 && p.attack <= 2000,
        `${p.name} attack out of range: ${p.attack}`);
      // release: 0.01..9000 ms per FFmpeg docs
      assert.ok(p.release >= 1 && p.release <= 9000,
        `${p.name} release out of range: ${p.release}`);
    }
  });
});
