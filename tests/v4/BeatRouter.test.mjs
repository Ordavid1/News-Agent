// tests/v4/BeatRouter.test.mjs
// V4 BeatRouter unit tests — pure logic, no fal.ai calls.
//
// Run: node --test tests/v4/BeatRouter.test.mjs
//
// Coverage:
//   - route() returns the right generator class for each beat type
//   - text-rendering override redirects to ActionGenerator
//   - SHOT_REVERSE_SHOT compiler expands into N alternating closeups
//   - Cost cap preflight enforces total cost
//   - Unknown beat types route to null without throwing
//   - SPEED_RAMP_TRANSITION is marked assemblerOnly

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import BeatRouter, { resolveCostCap, COST_CAP_DEFAULT_USD } from '../../services/BeatRouter.js';
import {
  CinematicDialogueGenerator,
  GroupTwoShotGenerator,
  SilentStareGenerator,
  ReactionGenerator,
  InsertShotGenerator,
  ActionGenerator,
  BRollGenerator,
  VoiceoverBRollGenerator,
  TextOverlayCardGenerator,
  ShotReverseShotCompiler
} from '../../services/beat-generators/index.js';

// ─────────────────────────────────────────────────────────────────────
// Routing table — each beat type maps to its expected generator class
// ─────────────────────────────────────────────────────────────────────

describe('BeatRouter.route()', () => {
  const router = new BeatRouter({}); // no deps needed for routing decisions

  test('TALKING_HEAD_CLOSEUP routes to CinematicDialogueGenerator (Mode B)', () => {
    const r = router.route({ type: 'TALKING_HEAD_CLOSEUP' });
    assert.equal(r.GeneratorClass, CinematicDialogueGenerator);
    assert.equal(r.mode, 'B');
  });

  test('DIALOGUE_IN_SCENE routes to CinematicDialogueGenerator (Mode B)', () => {
    const r = router.route({ type: 'DIALOGUE_IN_SCENE' });
    assert.equal(r.GeneratorClass, CinematicDialogueGenerator);
    assert.equal(r.mode, 'B');
  });

  test('GROUP_DIALOGUE_TWOSHOT routes to GroupTwoShotGenerator', () => {
    const r = router.route({ type: 'GROUP_DIALOGUE_TWOSHOT' });
    assert.equal(r.GeneratorClass, GroupTwoShotGenerator);
  });

  test('SILENT_STARE routes to SilentStareGenerator', () => {
    const r = router.route({ type: 'SILENT_STARE' });
    assert.equal(r.GeneratorClass, SilentStareGenerator);
  });

  test('REACTION routes to ReactionGenerator (Veo first/last frame)', () => {
    const r = router.route({ type: 'REACTION' });
    assert.equal(r.GeneratorClass, ReactionGenerator);
  });

  test('INSERT_SHOT routes to InsertShotGenerator (Veo product hero)', () => {
    const r = router.route({ type: 'INSERT_SHOT' });
    assert.equal(r.GeneratorClass, InsertShotGenerator);
  });

  test('ACTION_NO_DIALOGUE routes to ActionGenerator (Kling V3 Pro)', () => {
    const r = router.route({ type: 'ACTION_NO_DIALOGUE' });
    assert.equal(r.GeneratorClass, ActionGenerator);
  });

  test('B_ROLL_ESTABLISHING routes to BRollGenerator (Veo native ambient)', () => {
    const r = router.route({ type: 'B_ROLL_ESTABLISHING' });
    assert.equal(r.GeneratorClass, BRollGenerator);
  });

  test('VOICEOVER_OVER_BROLL routes to VoiceoverBRollGenerator', () => {
    const r = router.route({ type: 'VOICEOVER_OVER_BROLL' });
    assert.equal(r.GeneratorClass, VoiceoverBRollGenerator);
  });

  test('TEXT_OVERLAY_CARD routes to TextOverlayCardGenerator with noApiCost', () => {
    const r = router.route({ type: 'TEXT_OVERLAY_CARD' });
    assert.equal(r.GeneratorClass, TextOverlayCardGenerator);
    assert.equal(r.noApiCost, true);
  });

  test('SPEED_RAMP_TRANSITION is marked assemblerOnly with no generator', () => {
    const r = router.route({ type: 'SPEED_RAMP_TRANSITION' });
    assert.equal(r.GeneratorClass, null);
    assert.equal(r.assemblerOnly, true);
    assert.equal(r.noApiCost, true);
  });

  test('Unknown beat type returns null without throwing', () => {
    const r = router.route({ type: 'NONEXISTENT_TYPE' });
    assert.equal(r, null);
  });

  test('Null/missing beat returns null', () => {
    assert.equal(router.route(null), null);
    assert.equal(router.route({}), null);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Text-rendering override
// ─────────────────────────────────────────────────────────────────────

describe('BeatRouter text-rendering override', () => {
  const router = new BeatRouter({});

  test('requires_text_rendering=true on a non-TEXT_OVERLAY_CARD beat routes to ActionGenerator', () => {
    const r = router.route({ type: 'B_ROLL_ESTABLISHING', requires_text_rendering: true });
    assert.equal(r.GeneratorClass, ActionGenerator);
    assert.equal(r.mode, 'text_override');
    assert.equal(r.originalType, 'B_ROLL_ESTABLISHING');
  });

  test('TEXT_OVERLAY_CARD is NOT overridden by requires_text_rendering (it IS the text card)', () => {
    const r = router.route({ type: 'TEXT_OVERLAY_CARD', requires_text_rendering: true });
    assert.equal(r.GeneratorClass, TextOverlayCardGenerator);
  });

  test('INSERT_SHOT is NOT overridden by requires_text_rendering (subject ref anchors the brand text)', () => {
    // Caught on 2026-04-11 first real V4 run: a MacBook Pro insert shot
    // was flagged requires_text_rendering=true, routed to ActionGenerator,
    // and lost its subject reference anchor (came out as text-only Kling
    // V3 Pro). For product hero shots the branding is ALREADY on the
    // subject reference image used as Veo's first frame — Veo just
    // animates the existing pixels. No text synthesis required.
    const r = router.route({ type: 'INSERT_SHOT', requires_text_rendering: true });
    assert.notEqual(r.GeneratorClass, ActionGenerator);
    assert.notEqual(r.mode, 'text_override');
  });

  // ─────────────────────────────────────────────────────────────────
  // Speech-bearing beats must NEVER be hijacked by the text override.
  // The override path doesn't invoke TTS + Sync Lipsync v3 + VO mixing;
  // routing a speech beat through it silently drops the spoken content.
  // If Gemini needs brand text AND speech on the same beat, the speech
  // wins — we lose the in-frame text rendering, not the dialogue.
  // Caught 2026-04-21 on first Action-genre run: the register leans on
  // VO for kinetic montage and Gemini flagged every VO beat with visible
  // brand signage as requires_text_rendering, producing a speechless ep.
  // ─────────────────────────────────────────────────────────────────

  test('VOICEOVER_OVER_BROLL is NOT overridden by requires_text_rendering (VO must survive)', () => {
    const r = router.route({ type: 'VOICEOVER_OVER_BROLL', requires_text_rendering: true });
    assert.notEqual(r.GeneratorClass, ActionGenerator);
    assert.notEqual(r.mode, 'text_override');
  });

  test('TALKING_HEAD_CLOSEUP is NOT overridden by requires_text_rendering (TTS + Sync Lipsync must survive)', () => {
    const r = router.route({ type: 'TALKING_HEAD_CLOSEUP', requires_text_rendering: true });
    assert.equal(r.GeneratorClass, CinematicDialogueGenerator);
    assert.notEqual(r.mode, 'text_override');
  });

  test('DIALOGUE_IN_SCENE is NOT overridden by requires_text_rendering', () => {
    const r = router.route({ type: 'DIALOGUE_IN_SCENE', requires_text_rendering: true });
    assert.equal(r.GeneratorClass, CinematicDialogueGenerator);
    assert.notEqual(r.mode, 'text_override');
  });

  test('GROUP_DIALOGUE_TWOSHOT is NOT overridden by requires_text_rendering', () => {
    const r = router.route({ type: 'GROUP_DIALOGUE_TWOSHOT', requires_text_rendering: true });
    assert.equal(r.GeneratorClass, GroupTwoShotGenerator);
    assert.notEqual(r.mode, 'text_override');
  });

  test('non-speech-bearing beat types STILL honour the override (B_ROLL, ACTION, etc.)', () => {
    // Sanity: the override still applies to everything outside the exemption set.
    for (const beatType of ['B_ROLL_ESTABLISHING', 'ACTION_NO_DIALOGUE', 'REACTION', 'SILENT_STARE']) {
      const r = router.route({ type: beatType, requires_text_rendering: true });
      assert.equal(r.GeneratorClass, ActionGenerator, `${beatType} should route to ActionGenerator when text-override flagged`);
      assert.equal(r.mode, 'text_override', `${beatType} should be text_override mode`);
      assert.equal(r.originalType, beatType);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Cost cap defaults
// ─────────────────────────────────────────────────────────────────────

describe('resolveCostCap()', () => {
  test('Default cap is $20 (flat, Brand Story is Business-tier-only)', () => {
    assert.equal(resolveCostCap(), COST_CAP_DEFAULT_USD);
    assert.equal(resolveCostCap({}), COST_CAP_DEFAULT_USD);
    assert.equal(COST_CAP_DEFAULT_USD, 20.00);
  });

  test('episodeOverride takes precedence over default', () => {
    assert.equal(resolveCostCap({ episodeOverride: 25 }), 25);
    assert.equal(resolveCostCap({ episodeOverride: 50 }), 50);
  });

  test('Negative or zero episodeOverride falls back to default', () => {
    assert.equal(resolveCostCap({ episodeOverride: 0 }), COST_CAP_DEFAULT_USD);
    assert.equal(resolveCostCap({ episodeOverride: -5 }), COST_CAP_DEFAULT_USD);
  });

  test('Legacy { tier } argument is ignored (no longer tier-based)', () => {
    assert.equal(resolveCostCap({ tier: 'business' }), COST_CAP_DEFAULT_USD);
    assert.equal(resolveCostCap({ tier: 'enterprise' }), COST_CAP_DEFAULT_USD);
    assert.equal(resolveCostCap({ tier: 'mystery_tier' }), COST_CAP_DEFAULT_USD);
  });
});

// ─────────────────────────────────────────────────────────────────────
// ShotReverseShotCompiler — beat transformer expansion
// ─────────────────────────────────────────────────────────────────────

describe('ShotReverseShotCompiler.expandBeat()', () => {
  test('Non-SHOT_REVERSE_SHOT beats pass through unchanged', () => {
    const beat = { beat_id: 'b1', type: 'TALKING_HEAD_CLOSEUP', dialogue: 'hi' };
    const result = ShotReverseShotCompiler.expandBeat(beat);
    assert.equal(result.length, 1);
    assert.equal(result[0], beat);
  });

  test('SHOT_REVERSE_SHOT with 3 exchanges expands to 3 TALKING_HEAD_CLOSEUP beats', () => {
    const beat = {
      beat_id: 's1b3',
      type: 'SHOT_REVERSE_SHOT',
      exchanges: [
        { persona_index: 0, dialogue: 'You knew this would happen.', emotion: 'resigned', duration_seconds: 4 },
        { persona_index: 1, dialogue: 'I never wanted any of this.', emotion: 'broken', duration_seconds: 5 },
        { persona_index: 0, dialogue: 'Then why are you here?', emotion: 'cutting', duration_seconds: 3 }
      ]
    };
    const result = ShotReverseShotCompiler.expandBeat(beat);
    assert.equal(result.length, 3);

    // Each child beat is TALKING_HEAD_CLOSEUP
    assert.equal(result[0].type, 'TALKING_HEAD_CLOSEUP');
    assert.equal(result[1].type, 'TALKING_HEAD_CLOSEUP');
    assert.equal(result[2].type, 'TALKING_HEAD_CLOSEUP');

    // persona_index alternates correctly
    assert.equal(result[0].persona_index, 0);
    assert.equal(result[1].persona_index, 1);
    assert.equal(result[2].persona_index, 0);

    // dialogue + duration preserved
    assert.equal(result[0].dialogue, 'You knew this would happen.');
    assert.equal(result[2].duration_seconds, 3);

    // beat_id has child suffix preserving parent for traceability
    assert.equal(result[0].beat_id, 's1b3_a');
    assert.equal(result[1].beat_id, 's1b3_b');
    assert.equal(result[2].beat_id, 's1b3_c');

    // Parent metadata preserved on children
    assert.equal(result[0]._parent_beat_id, 's1b3');
    assert.equal(result[0]._compiled_from, 'SHOT_REVERSE_SHOT');

    // Child beats start in pending state
    assert.equal(result[0].status, 'pending');
    assert.equal(result[0].generated_video_url, null);
    assert.equal(result[0].endframe_url, null);
  });

  test('SHOT_REVERSE_SHOT with empty exchanges returns empty array (graceful)', () => {
    const beat = { beat_id: 's1b1', type: 'SHOT_REVERSE_SHOT', exchanges: [] };
    const result = ShotReverseShotCompiler.expandBeat(beat);
    assert.equal(result.length, 0);
  });

  test('expandScene() expands all SHOT_REVERSE_SHOT in a beats array', () => {
    const beats = [
      { beat_id: 'b1', type: 'B_ROLL_ESTABLISHING' },
      {
        beat_id: 'b2',
        type: 'SHOT_REVERSE_SHOT',
        exchanges: [
          { persona_index: 0, dialogue: 'A', duration_seconds: 3 },
          { persona_index: 1, dialogue: 'B', duration_seconds: 3 }
        ]
      },
      { beat_id: 'b3', type: 'INSERT_SHOT' }
    ];
    const expanded = ShotReverseShotCompiler.expandScene(beats);
    assert.equal(expanded.length, 4); // 1 + 2 (expansion) + 1
    assert.equal(expanded[0].beat_id, 'b1');
    assert.equal(expanded[1].beat_id, 'b2_a');
    assert.equal(expanded[2].beat_id, 'b2_b');
    assert.equal(expanded[3].beat_id, 'b3');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Preflight: SHOT_REVERSE_SHOT expansion + cost cap enforcement
// ─────────────────────────────────────────────────────────────────────

describe('BeatRouter.preflight()', () => {
  const router = new BeatRouter({});

  test('Expands SHOT_REVERSE_SHOT in scenes during preflight', () => {
    const scenes = [{
      scene_id: 's1',
      beats: [
        {
          beat_id: 's1b1',
          type: 'SHOT_REVERSE_SHOT',
          exchanges: [
            { persona_index: 0, dialogue: 'Hi.', duration_seconds: 3 },
            { persona_index: 1, dialogue: 'Hi.', duration_seconds: 3 }
          ]
        }
      ]
    }];
    const result = router.preflight({ scenes, costCapUsd: 100 });
    assert.equal(result.beatCount, 2); // expanded
    assert.equal(scenes[0].beats.length, 2);
    assert.equal(scenes[0].beats[0].type, 'TALKING_HEAD_CLOSEUP');
  });

  test('Sums estimated cost across all beats', () => {
    // Two TALKING_HEAD_CLOSEUP beats × ~$0.84 each (Mode B) ≈ $1.68 total
    const scenes = [{
      scene_id: 's1',
      beats: [
        { beat_id: 'b1', type: 'TALKING_HEAD_CLOSEUP', dialogue: 'hi', duration_seconds: 4 },
        { beat_id: 'b2', type: 'TALKING_HEAD_CLOSEUP', dialogue: 'hi', duration_seconds: 4 }
      ]
    }];
    const result = router.preflight({ scenes, costCapUsd: 100 });
    assert.ok(result.totalEstimatedCost > 1.0, 'expected total > $1');
    assert.ok(result.totalEstimatedCost < 5.0, 'expected total < $5');
    assert.equal(result.withinCap, true);
  });

  test('Cost cap exceeded → withinCap=false', () => {
    // 50 dialogue beats × ~$0.84 = ~$42 → exceeds $10 cap
    const beats = [];
    for (let i = 0; i < 50; i++) {
      beats.push({ beat_id: `b${i}`, type: 'TALKING_HEAD_CLOSEUP', dialogue: 'long line of dialogue here', duration_seconds: 4 });
    }
    const scenes = [{ scene_id: 's1', beats }];
    const result = router.preflight({ scenes, costCapUsd: 10 });
    assert.equal(result.withinCap, false);
    assert.ok(result.totalEstimatedCost > 10);
  });

  test('TEXT_OVERLAY_CARD beats contribute zero cost (noApiCost)', () => {
    const scenes = [{
      scene_id: 's1',
      beats: [
        { beat_id: 'b1', type: 'TEXT_OVERLAY_CARD', text: 'CHAPTER I', duration_seconds: 2 },
        { beat_id: 'b2', type: 'TEXT_OVERLAY_CARD', text: 'CHAPTER II', duration_seconds: 2 }
      ]
    }];
    const result = router.preflight({ scenes, costCapUsd: 100 });
    assert.equal(result.totalEstimatedCost, 0);
    assert.equal(result.withinCap, true);
  });

  test('Throws on missing scenes array', () => {
    assert.throws(() => router.preflight({ scenes: null, costCapUsd: 10 }));
  });

  test('Throws on invalid cost cap', () => {
    assert.throws(() => router.preflight({ scenes: [], costCapUsd: 0 }));
    assert.throws(() => router.preflight({ scenes: [], costCapUsd: -5 }));
  });
});
