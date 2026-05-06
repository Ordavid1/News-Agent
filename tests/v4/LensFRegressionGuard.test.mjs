// tests/v4/LensFRegressionGuard.test.mjs
//
// V4 Tier 4.2 — Lens F regression guard tests.
//
// Run: node --test tests/v4/LensFRegressionGuard.test.mjs
//
// Coverage:
//   • applyEdl from EditDecisionList — drop / swap / retime / j_cut path
//   • regression-guard SCORE COMPARISON policy: secondScore < firstScore → revert
//   • regression-guard PAYLOAD SHAPE for directorReport.editor_lens_f.regression_check
//     and .reverted_due_to_regression (Director Panel UI contract)
//
// The full regression-guard wiring lives inside BrandStoryService.runV4Pipeline
// (a 9000-line orchestrator) and isn't unit-testable in isolation without
// spinning up the whole pipeline. These tests cover the EDL apply mechanics
// (which the guard depends on) and document the score-comparison contract +
// expected payload shapes.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { applyEdl } from '../../services/v4/EditDecisionList.js';

// ─────────────────────────────────────────────────────────────────────
// applyEdl — the EDL apply mechanics that the regression guard wraps
// ─────────────────────────────────────────────────────────────────────

describe('applyEdl — drop_beat', () => {
  test('drops a beat by superseding it (status moves to superseded, video_url null)', () => {
    const sceneGraph = {
      scenes: [{
        scene_id: 's1',
        beats: [
          { beat_id: 'b1', type: 'B_ROLL', status: 'generated', generated_video_url: 'a.mp4', endframe_url: 'a.jpg' },
          { beat_id: 'b2', type: 'TALKING_HEAD', status: 'generated', generated_video_url: 'b.mp4', endframe_url: 'b.jpg' },
          { beat_id: 'b3', type: 'REACTION', status: 'generated', generated_video_url: 'c.mp4', endframe_url: 'c.jpg' }
        ]
      }]
    };
    const edl = { drop_beat: ['b2'], swap_beats: [], retime_beat: [], j_cut_audio: [] };
    const result = applyEdl(sceneGraph, edl);

    assert.equal(result.applied.dropped, 1);
    const b2 = sceneGraph.scenes[0].beats.find(b => b.beat_id === 'b2');
    assert.equal(b2.status, 'superseded');
    assert.equal(b2.generated_video_url, null);
  });

  test('skips drop when beat_id not found', () => {
    const sceneGraph = {
      scenes: [{
        scene_id: 's1',
        beats: [{ beat_id: 'b1', status: 'generated', generated_video_url: 'a.mp4' }]
      }]
    };
    const edl = { drop_beat: ['nonexistent'], swap_beats: [], retime_beat: [], j_cut_audio: [] };
    const result = applyEdl(sceneGraph, edl);
    assert.equal(result.applied.dropped, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].op, 'drop_beat');
    assert.equal(result.skipped[0].reason, 'beat_id_not_found');
  });
});

describe('applyEdl — swap_beats', () => {
  test('swaps two beats within the same scene', () => {
    const sceneGraph = {
      scenes: [{
        scene_id: 's1',
        beats: [
          { beat_id: 'b1', generated_video_url: 'a.mp4' },
          { beat_id: 'b2', generated_video_url: 'b.mp4' },
          { beat_id: 'b3', generated_video_url: 'c.mp4' }
        ]
      }]
    };
    const edl = { drop_beat: [], swap_beats: [['b1', 'b3']], retime_beat: [], j_cut_audio: [] };
    const result = applyEdl(sceneGraph, edl);
    assert.equal(result.applied.swapped, 1);
    assert.deepEqual(sceneGraph.scenes[0].beats.map(b => b.beat_id), ['b3', 'b2', 'b1']);
  });

  test('rejects cross-scene swaps', () => {
    const sceneGraph = {
      scenes: [
        { scene_id: 's1', beats: [{ beat_id: 'a', generated_video_url: 'x' }] },
        { scene_id: 's2', beats: [{ beat_id: 'b', generated_video_url: 'y' }] }
      ]
    };
    const edl = { drop_beat: [], swap_beats: [['a', 'b']], retime_beat: [], j_cut_audio: [] };
    const result = applyEdl(sceneGraph, edl);
    assert.equal(result.applied.swapped, 0);
    assert.equal(result.skipped[0].reason, 'cross_scene_swap_rejected');
  });
});

describe('applyEdl — retime_beat', () => {
  test('clamps delta to ±0.5s and floors duration at 1s', () => {
    const sceneGraph = {
      scenes: [{
        scene_id: 's1',
        beats: [
          { beat_id: 'b1', duration_seconds: 4 },
          { beat_id: 'b2', duration_seconds: 2 }
        ]
      }]
    };
    const edl = {
      drop_beat: [], swap_beats: [], j_cut_audio: [],
      retime_beat: [
        { beat_id: 'b1', delta_seconds: 0.3 },
        { beat_id: 'b2', delta_seconds: -1.0 }  // schema allows ±0.5; helper clamps
      ]
    };
    const result = applyEdl(sceneGraph, edl);
    assert.equal(result.applied.retimed, 2);
    assert.equal(sceneGraph.scenes[0].beats[0].duration_seconds, 4.3);
    // -1.0 clamped to -0.5 → 2 - 0.5 = 1.5s.
    assert.equal(sceneGraph.scenes[0].beats[1].duration_seconds, 1.5);
  });
});

describe('applyEdl — j_cut_audio', () => {
  test('records j_cut intent on into_beat for PostProduction stage 4 to consume', () => {
    const sceneGraph = {
      scenes: [{ scene_id: 's1', beats: [
        { beat_id: 'a' }, { beat_id: 'b' }
      ]}]
    };
    const edl = {
      drop_beat: [], swap_beats: [], retime_beat: [],
      j_cut_audio: [{ from_beat: 'a', into_beat: 'b', lead_seconds: 0.6 }]
    };
    const result = applyEdl(sceneGraph, edl);
    assert.equal(result.applied.j_cut_planned, 1);
    const b = sceneGraph.scenes[0].beats[1];
    assert.equal(b.j_cut_audio_lead_seconds, 0.6);
    assert.equal(b.j_cut_audio_from_beat, 'a');
  });
});

describe('applyEdl — audit history', () => {
  test('appends an entry to lens_f_edl_history with applied + skipped + edl', () => {
    const sceneGraph = {
      scenes: [{ scene_id: 's1', beats: [
        { beat_id: 'b1', generated_video_url: 'a.mp4' },
        { beat_id: 'b2', generated_video_url: 'b.mp4' }
      ]}]
    };
    const edl = { drop_beat: ['b1'], swap_beats: [], retime_beat: [], j_cut_audio: [] };
    applyEdl(sceneGraph, edl, { reason: 'test_apply' });
    assert.ok(Array.isArray(sceneGraph.lens_f_edl_history));
    assert.equal(sceneGraph.lens_f_edl_history.length, 1);
    const entry = sceneGraph.lens_f_edl_history[0];
    assert.equal(entry.reason, 'test_apply');
    assert.equal(entry.applied.dropped, 1);
    assert.deepEqual(entry.edl.drop_beat, ['b1']);
    assert.ok(typeof entry.applied_at === 'string');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Regression-guard policy contract (documentation tests)
// ─────────────────────────────────────────────────────────────────────

describe('Lens F regression guard — score comparison policy', () => {
  // The orchestrator wiring at BrandStoryService.runV4Pipeline ~6520
  // implements this policy. These tests document the contract so any
  // refactor of that block can verify the same behavior in isolation.

  function shouldRevert(firstScore, secondScore) {
    if (firstScore == null || secondScore == null) return false;
    return secondScore < firstScore;
  }

  test('revert when EDL\'d cut score < original cut score', () => {
    assert.equal(shouldRevert(82, 75), true);
    assert.equal(shouldRevert(82, 81), true);
  });

  test('keep when EDL\'d cut score >= original cut score', () => {
    assert.equal(shouldRevert(82, 88), false);
    assert.equal(shouldRevert(82, 82), false);
  });

  test('keep when either score is missing (no comparison possible)', () => {
    assert.equal(shouldRevert(null, 80), false);
    assert.equal(shouldRevert(82, null), false);
    assert.equal(shouldRevert(null, null), false);
  });
});

describe('Lens F regression guard — payload shape (Director Panel UI contract)', () => {
  test('reverted_due_to_regression carries first/second scores + edl + ts', () => {
    // Shape required by public/js/director-panel.js to render the
    // "EDL reverted" badge with explanation.
    const directorReport = { editor_lens_f: {} };
    const edl = { drop_beat: ['b2'], swap_beats: [], retime_beat: [], j_cut_audio: [] };
    directorReport.editor_lens_f.reverted_due_to_regression = {
      first_score: 82,
      second_score: 71,
      edl,
      ts: new Date().toISOString()
    };
    const r = directorReport.editor_lens_f.reverted_due_to_regression;
    assert.equal(typeof r.first_score, 'number');
    assert.equal(typeof r.second_score, 'number');
    assert.ok(r.second_score < r.first_score);
    assert.deepEqual(r.edl.drop_beat, ['b2']);
    assert.ok(typeof r.ts === 'string');
  });

  test('regression_check (kept path) carries first/second/kept=true', () => {
    const directorReport = { editor_lens_f: {} };
    directorReport.editor_lens_f.regression_check = {
      first_score: 75,
      second_score: 83,
      kept: true,
      ts: new Date().toISOString()
    };
    const r = directorReport.editor_lens_f.regression_check;
    assert.equal(r.kept, true);
    assert.ok(r.second_score >= r.first_score);
  });
});
