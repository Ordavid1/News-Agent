// tests/v4/SonicSeriesBible.test.mjs
// Phase 2 of the V4 audio coherence overhaul.
//
// Run: node --test tests/v4/SonicSeriesBible.test.mjs
//
// Tests the schema invariants of the story-creation-time Sonic Series Bible.
// The bible is the show's sound DNA — palette + grammar + no-fly list +
// inheritance_policy. Every per-episode sonic_world inherits from it. The
// Director's binding clause: signature_drone.must_appear_at_least_once_per_episode
// is what makes ep7 feel like the same show as ep1.
//
// We DON'T test the Gemini call itself (no live network in unit tests). We
// test the validation, the safe-default fallback, and the merge/inheritance
// invariants that the API surface relies on.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SONIC_SERIES_BIBLE,
  validateBible,
  mergeBibleDefaults,
  resolveBibleForStory
} from '../../services/v4/SonicSeriesBible.js';

describe('Phase 2 — DEFAULT_SONIC_SERIES_BIBLE structural invariants', () => {
  test('default bible is itself a valid bible (passes its own validator)', () => {
    const issues = validateBible(DEFAULT_SONIC_SERIES_BIBLE);
    const blockers = issues.filter(i => i.severity === 'blocker');
    assert.equal(blockers.length, 0, `default bible has blockers: ${JSON.stringify(blockers)}`);
  });

  test('default bible has the three required pillars', () => {
    assert.ok(DEFAULT_SONIC_SERIES_BIBLE.signature_drone);
    assert.ok(DEFAULT_SONIC_SERIES_BIBLE.base_palette);
    assert.ok(DEFAULT_SONIC_SERIES_BIBLE.spectral_anchor);
  });

  test('default bible binds spectral_anchor.always_present === true (the seam-hider invariant)', () => {
    assert.equal(DEFAULT_SONIC_SERIES_BIBLE.spectral_anchor.always_present, true);
  });

  test('default bible binds inheritance_policy.signature_drone to per-episode appearance (the Director\'s binding clause)', () => {
    assert.equal(
      DEFAULT_SONIC_SERIES_BIBLE.inheritance_policy.signature_drone,
      'must_appear_at_least_once_per_episode',
      'this is the rule that makes ep7 feel like the same show as ep1 — it is load-bearing'
    );
  });

  test('default bible is frozen (mutation safety)', () => {
    assert.ok(Object.isFrozen(DEFAULT_SONIC_SERIES_BIBLE));
  });
});

describe('Phase 2 — validateBible blocker rules', () => {
  test('rejects null bible', () => {
    const issues = validateBible(null);
    const blockers = issues.filter(i => i.severity === 'blocker');
    assert.ok(blockers.length > 0);
  });

  test('rejects bible missing signature_drone', () => {
    const bible = { ...DEFAULT_SONIC_SERIES_BIBLE, signature_drone: null };
    const blockers = validateBible(bible).filter(i => i.severity === 'blocker');
    assert.ok(blockers.some(i => i.field === 'signature_drone'));
  });

  test('rejects bible missing base_palette', () => {
    const bible = { ...DEFAULT_SONIC_SERIES_BIBLE, base_palette: null };
    const blockers = validateBible(bible).filter(i => i.severity === 'blocker');
    assert.ok(blockers.some(i => i.field === 'base_palette'));
  });

  test('rejects bible with spectral_anchor.always_present === false (breaks the seam-hider)', () => {
    const bible = {
      ...DEFAULT_SONIC_SERIES_BIBLE,
      spectral_anchor: { ...DEFAULT_SONIC_SERIES_BIBLE.spectral_anchor, always_present: false }
    };
    const blockers = validateBible(bible).filter(i => i.severity === 'blocker');
    assert.ok(blockers.some(i => i.field === 'spectral_anchor.always_present'));
  });

  test('rejects bible with empty base_palette.ambient_keywords', () => {
    const bible = {
      ...DEFAULT_SONIC_SERIES_BIBLE,
      base_palette: { ...DEFAULT_SONIC_SERIES_BIBLE.base_palette, ambient_keywords: [] }
    };
    const blockers = validateBible(bible).filter(i => i.severity === 'blocker');
    assert.ok(blockers.some(i => i.field === 'base_palette.ambient_keywords'));
  });

  test('rejects bible missing inheritance_policy', () => {
    const bible = { ...DEFAULT_SONIC_SERIES_BIBLE, inheritance_policy: null };
    const blockers = validateBible(bible).filter(i => i.severity === 'blocker');
    assert.ok(blockers.some(i => i.field === 'inheritance_policy'));
  });
});

describe('Phase 2 — validateBible warning rules', () => {
  test('warns on invalid foley_density value', () => {
    const bible = { ...DEFAULT_SONIC_SERIES_BIBLE, foley_density: 'random' };
    const warnings = validateBible(bible).filter(i => i.severity === 'warning');
    assert.ok(warnings.some(i => i.field === 'foley_density'));
  });

  test('warns on out-of-range diegetic_ratio', () => {
    const bible = { ...DEFAULT_SONIC_SERIES_BIBLE, diegetic_ratio: 1.5 };
    const warnings = validateBible(bible).filter(i => i.severity === 'warning');
    assert.ok(warnings.some(i => i.field === 'diegetic_ratio'));
  });

  test('warns on invalid score_under_dialogue value', () => {
    const bible = { ...DEFAULT_SONIC_SERIES_BIBLE, score_under_dialogue: 'maybe' };
    const warnings = validateBible(bible).filter(i => i.severity === 'warning');
    assert.ok(warnings.some(i => i.field === 'score_under_dialogue'));
  });
});

describe('Phase 2 — mergeBibleDefaults', () => {
  test('null input returns the default bible', () => {
    const merged = mergeBibleDefaults(null);
    assert.deepEqual(merged.signature_drone, DEFAULT_SONIC_SERIES_BIBLE.signature_drone);
  });

  test('partial override preserves authored fields', () => {
    const partial = {
      prohibited_instruments: ['orchestral_strings', 'synth_pads'],
      reference_shows: ['severance_s1']
    };
    const merged = mergeBibleDefaults(partial);
    assert.deepEqual(merged.prohibited_instruments, ['orchestral_strings', 'synth_pads']);
    assert.deepEqual(merged.reference_shows, ['severance_s1']);
  });

  test('partial override fills missing fields from defaults', () => {
    const partial = { prohibited_instruments: ['orchestral_strings'] };
    const merged = mergeBibleDefaults(partial);
    // signature_drone wasn't in the partial — must come from default
    assert.deepEqual(merged.signature_drone, DEFAULT_SONIC_SERIES_BIBLE.signature_drone);
    // inheritance_policy.signature_drone must come from default (the binding clause)
    assert.equal(merged.inheritance_policy.signature_drone, 'must_appear_at_least_once_per_episode');
  });

  test('inheritance_policy is deep-merged (override one key, keep the rest from default)', () => {
    const partial = {
      inheritance_policy: { base_palette: 'overridable' }
    };
    const merged = mergeBibleDefaults(partial);
    // The overridden field
    assert.equal(merged.inheritance_policy.base_palette, 'overridable');
    // The defaults for fields NOT overridden
    assert.equal(merged.inheritance_policy.grammar, 'immutable');
    assert.equal(merged.inheritance_policy.no_fly_list, 'immutable');
    assert.equal(merged.inheritance_policy.signature_drone, 'must_appear_at_least_once_per_episode');
  });
});

describe('Phase 2 — resolveBibleForStory', () => {
  test('story without sonic_series_bible → returns default', () => {
    const story = { id: 'x', name: 'Test' };
    const bible = resolveBibleForStory(story);
    assert.deepEqual(bible.signature_drone, DEFAULT_SONIC_SERIES_BIBLE.signature_drone);
  });

  test('story with sonic_series_bible → returns merged bible', () => {
    const story = {
      id: 'x',
      sonic_series_bible: {
        prohibited_instruments: ['orchestral_strings'],
        reference_shows: ['andor_s1']
      }
    };
    const bible = resolveBibleForStory(story);
    assert.deepEqual(bible.prohibited_instruments, ['orchestral_strings']);
    assert.deepEqual(bible.reference_shows, ['andor_s1']);
    // And defaults fill the missing fields
    assert.ok(bible.signature_drone);
    assert.equal(bible.inheritance_policy.signature_drone, 'must_appear_at_least_once_per_episode');
  });

  test('null story → safe default', () => {
    const bible = resolveBibleForStory(null);
    assert.equal(bible.spectral_anchor.always_present, true);
  });
});

describe('Phase 2 — bible never blocks the pipeline (failure-mode invariant)', () => {
  test('a story whose bible is corrupt non-object falls through to default', () => {
    const story = { sonic_series_bible: 'this is not a bible' };
    const bible = resolveBibleForStory(story);
    // String input is not an object — resolver must NOT explode, must return default
    assert.deepEqual(bible.signature_drone, DEFAULT_SONIC_SERIES_BIBLE.signature_drone);
  });

  test('inheritance_policy.signature_drone never returns undefined (required for sonic_world inheritance)', () => {
    // Even with a half-broken bible, the binding clause must always resolve
    // to something the screenplay validator can enforce.
    const story = {
      sonic_series_bible: {
        signature_drone: { description: 'x', frequency_band_hz: [40, 120], presence_dB: -22 },
        base_palette: { ambient_keywords: ['x'] },
        spectral_anchor: { description: 'x', always_present: true, level_dB: -18 }
        // No inheritance_policy field at all
      }
    };
    const bible = resolveBibleForStory(story);
    assert.ok(bible.inheritance_policy);
    assert.equal(bible.inheritance_policy.signature_drone, 'must_appear_at_least_once_per_episode');
  });
});
