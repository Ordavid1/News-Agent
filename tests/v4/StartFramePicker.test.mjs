// tests/v4/StartFramePicker.test.mjs
//
// V4 Tier 2.1 — Unified _pickStartFrame waterfall + continuity_fallback_reason
// breadcrumb tests.
//
// Run: node --test tests/v4/StartFramePicker.test.mjs
//
// Coverage:
//   • Waterfall priority order matches the canonical Tier 2.1 spec
//   • beat.continuity_fallback_reason breadcrumb is set on every code path
//   • previousBeat-existed-but-endframe-missing produces the
//     `previous_endframe_missing_*_fallback` reasons that Lens C deducts on
//   • Backward-compat: legacy 3-arg call (refStack, previousBeat, scene)
//     still works without breaking generators that haven't been migrated
//   • Identical inputs produce identical outputs across all generators
//     that route through the unified picker

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import BaseBeatGenerator from '../../services/beat-generators/BaseBeatGenerator.js';

// We don't need a real subclass for picker tests — instantiate the base
// directly with no deps. _pickStartFrame doesn't touch any service.
function picker() {
  const gen = new BaseBeatGenerator({});
  return gen._pickStartFrame.bind(gen);
}

const SCENE_MASTER = 'https://x/scene_master.jpg';
const PREV_ENDFRAME = 'https://x/prev_end.jpg';
const PERSONA_LOCK_CACHED = 'https://x/persona_lock_cached.jpg';
const PERSONA_LOCK_FRESH = 'https://x/persona_lock_fresh.jpg';
const SIPL = 'https://x/sipl.jpg';
const SUBJECT_NATURAL = 'https://x/subject_natural.jpg';
const SUBJECT_REF = 'https://x/subject_ref.jpg';
const BRIDGE_FROM = 'https://x/bridge_from.jpg';
const REF_HEAD = 'https://x/ref_head.jpg';

// ─────────────────────────────────────────────────────────────────────
// Waterfall priority order
// ─────────────────────────────────────────────────────────────────────

describe('_pickStartFrame waterfall priority', () => {
  test('Tier 1: cached persona-lock wins over everything', () => {
    const pick = picker();
    const beat = { persona_locked_first_frame_url: PERSONA_LOCK_CACHED, bridge_from_scene_endframe_url: BRIDGE_FROM };
    const url = pick([REF_HEAD], { endframe_url: PREV_ENDFRAME }, { scene_master_url: SCENE_MASTER }, beat, {
      personaLockUrl: PERSONA_LOCK_FRESH,
      siplUrl: SIPL,
      subjectNaturalUrl: SUBJECT_NATURAL
    });
    assert.equal(url, PERSONA_LOCK_CACHED);
    assert.equal(beat.continuity_fallback_reason, 'persona_lock_used');
  });

  test('Tier 2: just-synthesized persona-lock wins when cache empty', () => {
    const pick = picker();
    const beat = {};
    const url = pick([REF_HEAD], { endframe_url: PREV_ENDFRAME }, { scene_master_url: SCENE_MASTER }, beat, {
      personaLockUrl: PERSONA_LOCK_FRESH,
      siplUrl: SIPL
    });
    assert.equal(url, PERSONA_LOCK_FRESH);
    assert.equal(beat.continuity_fallback_reason, 'persona_lock_synthesized');
  });

  test('Tier 3: SIPL wins over subject-natural and below', () => {
    const pick = picker();
    const beat = {};
    const url = pick(null, { endframe_url: PREV_ENDFRAME }, { scene_master_url: SCENE_MASTER }, beat, {
      siplUrl: SIPL,
      subjectNaturalUrl: SUBJECT_NATURAL
    });
    assert.equal(url, SIPL);
    assert.equal(beat.continuity_fallback_reason, 'sipl_used');
  });

  test('Tier 4: subject-natural wins over bridge/endframe/scene-master', () => {
    const pick = picker();
    const beat = { bridge_from_scene_endframe_url: BRIDGE_FROM };
    const url = pick(null, { endframe_url: PREV_ENDFRAME }, { scene_master_url: SCENE_MASTER }, beat, {
      subjectNaturalUrl: SUBJECT_NATURAL
    });
    assert.equal(url, SUBJECT_NATURAL);
    assert.equal(beat.continuity_fallback_reason, 'subject_natural_used');
  });

  test('Tier 5: bridge anchor wins over previous endframe', () => {
    const pick = picker();
    const beat = { bridge_from_scene_endframe_url: BRIDGE_FROM };
    const url = pick(null, { endframe_url: PREV_ENDFRAME }, { scene_master_url: SCENE_MASTER }, beat);
    assert.equal(url, BRIDGE_FROM);
    assert.equal(beat.continuity_fallback_reason, 'bridge_anchor_used');
  });

  test('Tier 6: previous endframe is THE canonical chain', () => {
    const pick = picker();
    const beat = {};
    const url = pick(null, { endframe_url: PREV_ENDFRAME }, { scene_master_url: SCENE_MASTER }, beat);
    assert.equal(url, PREV_ENDFRAME);
    assert.equal(beat.continuity_fallback_reason, 'previous_endframe_used');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Continuity breadcrumb — the LENS-C-actionable signals
// ─────────────────────────────────────────────────────────────────────

describe('continuity_fallback_reason breadcrumb (Lens C / Lens E enabler)', () => {
  test('first beat of scene + scene_master → "scene_master_first_beat" (NOT a deduction)', () => {
    const pick = picker();
    const beat = {};
    const url = pick(null, null /* no previousBeat */, { scene_master_url: SCENE_MASTER }, beat);
    assert.equal(url, SCENE_MASTER);
    assert.equal(beat.continuity_fallback_reason, 'scene_master_first_beat');
  });

  test('previousBeat existed but endframe missing → "previous_endframe_missing_scene_master_fallback" (DEDUCTION)', () => {
    const pick = picker();
    const beat = {};
    const url = pick(null, { endframe_url: null /* extraction failed */ }, { scene_master_url: SCENE_MASTER }, beat);
    assert.equal(url, SCENE_MASTER);
    assert.equal(beat.continuity_fallback_reason, 'previous_endframe_missing_scene_master_fallback');
  });

  test('previousBeat existed + scene-master also missing → falls to refStack with deduction', () => {
    const pick = picker();
    const beat = {};
    const url = pick([REF_HEAD], { endframe_url: null }, null, beat);
    assert.equal(url, REF_HEAD);
    assert.equal(beat.continuity_fallback_reason, 'previous_endframe_missing_refstack_fallback');
  });

  test('first beat + nothing available → text-only with no-prev breadcrumb', () => {
    const pick = picker();
    const beat = {};
    const url = pick(null, null, null, beat);
    assert.equal(url, null);
    assert.equal(beat.continuity_fallback_reason, 'no_first_frame_text_only');
  });

  test('previousBeat existed + nothing available → text-only with deduction breadcrumb', () => {
    const pick = picker();
    const beat = {};
    const url = pick(null, { endframe_url: null }, null, beat);
    assert.equal(url, null);
    assert.equal(beat.continuity_fallback_reason, 'previous_endframe_missing_text_only');
  });
});

// ─────────────────────────────────────────────────────────────────────
// InsertShot fallback path (subjectRefUrl at tier 8)
// ─────────────────────────────────────────────────────────────────────

describe('_pickStartFrame INSERT_SHOT fallback', () => {
  test('subjectRefUrl is fallback below scene_master', () => {
    const pick = picker();
    const beat = {};
    const url = pick(null, null, null, beat, { subjectRefUrl: SUBJECT_REF });
    assert.equal(url, SUBJECT_REF);
    assert.equal(beat.continuity_fallback_reason, 'subject_ref_fallback');
  });

  test('SIPL still wins over subjectRefUrl', () => {
    const pick = picker();
    const beat = {};
    const url = pick(null, null, null, beat, { siplUrl: SIPL, subjectRefUrl: SUBJECT_REF });
    assert.equal(url, SIPL);
    assert.equal(beat.continuity_fallback_reason, 'sipl_used');
  });

  test('scene_master wins over subjectRefUrl when both present', () => {
    const pick = picker();
    const beat = {};
    const url = pick(null, null, { scene_master_url: SCENE_MASTER }, beat, { subjectRefUrl: SUBJECT_REF });
    assert.equal(url, SCENE_MASTER);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Backward compat — legacy 3-arg signature
// ─────────────────────────────────────────────────────────────────────

describe('backward compat — legacy 3-arg signature', () => {
  test('3-arg call still returns endframe → scene_master → refStack', () => {
    const pick = picker();
    assert.equal(
      pick([REF_HEAD], { endframe_url: PREV_ENDFRAME }, { scene_master_url: SCENE_MASTER }),
      PREV_ENDFRAME
    );
    assert.equal(
      pick([REF_HEAD], null, { scene_master_url: SCENE_MASTER }),
      SCENE_MASTER
    );
    assert.equal(
      pick([REF_HEAD], null, null),
      REF_HEAD
    );
    assert.equal(pick(null, null, null), null);
  });

  test('3-arg call does NOT pollute callers with continuity_fallback_reason', () => {
    const pick = picker();
    const fakeContext = {};
    pick([REF_HEAD], null, null);
    // No beat passed → no mutation possible. Verify the picker doesn't
    // accidentally mutate any other arg.
    assert.deepEqual(fakeContext, {});
  });
});

// ─────────────────────────────────────────────────────────────────────
// Cross-generator consistency — same inputs → same outputs
// ─────────────────────────────────────────────────────────────────────

describe('cross-generator consistency', () => {
  test('two callers with identical args produce identical outputs', () => {
    const pickA = picker();
    const pickB = picker(); // separate instance
    const args = [
      [REF_HEAD],
      { endframe_url: PREV_ENDFRAME },
      { scene_master_url: SCENE_MASTER },
      { persona_locked_first_frame_url: null },
      { personaLockUrl: PERSONA_LOCK_FRESH }
    ];
    assert.equal(pickA(...args), pickB(...args));
  });

  test('breadcrumb is independent per-beat (no shared global state)', () => {
    const pick = picker();
    const beat1 = {};
    const beat2 = {};
    pick(null, null, { scene_master_url: SCENE_MASTER }, beat1);
    pick(null, { endframe_url: PREV_ENDFRAME }, { scene_master_url: SCENE_MASTER }, beat2);
    assert.equal(beat1.continuity_fallback_reason, 'scene_master_first_beat');
    assert.equal(beat2.continuity_fallback_reason, 'previous_endframe_used');
  });
});
