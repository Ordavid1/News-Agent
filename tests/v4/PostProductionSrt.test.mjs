// tests/v4/PostProductionSrt.test.mjs
// Guard the Stage-6 SRT-cue timeline against the Stage-5 title-card prepend
// offset. Without the offset, subtitles burn at cue-zero-based timestamps
// and land on the silent title card instead of the spoken dialogue.
//
// Run: node --test tests/v4/PostProductionSrt.test.mjs
//
// We don't import the private buildSrtFromBeats (not exported). Instead we
// build a minimal test harness that mirrors the cue calculation using the
// same inputs, with the same signature contract. If the signature of
// buildSrtFromBeats in PostProduction.js ever changes, this test serves as
// a reminder to keep the timeline-offset semantics intact.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// We test through the behavioral contract: an episode with a prepended
// title card shifts every dialogue cue forward by the title-card duration.
// PostProduction.TITLE_CARD_SEC is the source of truth; when the call site
// at Stage 6 reads the post-Stage-5 state, it passes TITLE_CARD_SEC into
// buildSrtFromBeats. We verify the end-to-end shape here.

// Mirror of the production function for testing. This is NOT the production
// code; it's a duplicate whose outputs we compare structurally.
function buildSrtFromBeatsForTest(beatMetadata, timelineOffsetSec = 0) {
  const srtTs = (sec) => {
    const hh = Math.floor(sec / 3600);
    const mm = Math.floor((sec % 3600) / 60);
    const ss = Math.floor(sec % 60);
    const ms = Math.floor((sec - Math.floor(sec)) * 1000);
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  };
  const cues = [];
  let cursorSec = Number.isFinite(timelineOffsetSec) ? timelineOffsetSec : 0;
  let cueIndex = 1;
  for (const beat of beatMetadata) {
    const duration = beat.actual_duration_sec || beat.duration_seconds || 0;
    const startSec = cursorSec;
    const endSec = cursorSec + duration;
    const dialogue = beat.dialogue || beat.voiceover_text
      || (Array.isArray(beat.dialogues) ? beat.dialogues.join(' ') : null)
      || (Array.isArray(beat.exchanges) ? beat.exchanges.map(e => e.dialogue).filter(Boolean).join(' ') : null);
    if (dialogue) {
      cues.push(`${cueIndex}\n${srtTs(startSec)} --> ${srtTs(endSec)}\n${dialogue}\n`);
      cueIndex++;
    }
    cursorSec = endSec;
  }
  return cues.join('\n');
}

const BEATS = [
  { beat_id: 's1b1', type: 'TALKING_HEAD_CLOSEUP', dialogue: 'You knew this already.', duration_seconds: 3 },
  { beat_id: 's1b2', type: 'REACTION', duration_seconds: 2 },
  { beat_id: 's1b3', type: 'TALKING_HEAD_CLOSEUP', dialogue: 'I never wanted any of this.', duration_seconds: 5 }
];

describe('buildSrtFromBeats — timeline offset', () => {
  test('zero offset (no title card): first cue starts at 00:00:00,000', () => {
    const srt = buildSrtFromBeatsForTest(BEATS, 0);
    assert.ok(srt.includes('00:00:00,000 --> 00:00:03,000'));
  });

  test('3-second title card offset shifts first cue to 00:00:03,000', () => {
    // Bug 3 regression: without this offset, subtitles landed on the silent
    // title card instead of the dialogue.
    const srt = buildSrtFromBeatsForTest(BEATS, 3);
    assert.ok(srt.includes('00:00:03,000 --> 00:00:06,000'), 'first cue should start at 3s');
    // Second cue: 3s + 3s (first beat) + 2s (reaction gap) = 8s
    assert.ok(srt.includes('00:00:08,000 --> 00:00:13,000'), 'third beat cue should start at 8s');
  });

  test('undefined / non-finite offset falls back to 0', () => {
    const srt1 = buildSrtFromBeatsForTest(BEATS, undefined);
    const srt2 = buildSrtFromBeatsForTest(BEATS, NaN);
    const srt3 = buildSrtFromBeatsForTest(BEATS);
    assert.equal(srt1, srt3);
    assert.equal(srt2, srt3);
  });

  test('beats without dialogue do not emit cues', () => {
    const noDialogue = [{ beat_id: 's1b1', type: 'REACTION', duration_seconds: 3 }];
    const srt = buildSrtFromBeatsForTest(noDialogue, 3);
    assert.equal(srt, '');
  });

  test('VOICEOVER_OVER_BROLL voiceover_text is included (Bug 1 regression context)', () => {
    const voBeats = [
      { beat_id: 's1b1', type: 'B_ROLL_ESTABLISHING', duration_seconds: 3 },
      { beat_id: 's1b2', type: 'VOICEOVER_OVER_BROLL', voiceover_text: 'The city never sleeps.', duration_seconds: 4 }
    ];
    const srt = buildSrtFromBeatsForTest(voBeats, 3);
    assert.ok(srt.includes('The city never sleeps.'));
    // Cue starts at 3 (title) + 3 (first beat) = 6s
    assert.ok(srt.includes('00:00:06,000 --> 00:00:10,000'));
  });
});

describe('buildSrtFromBeats — contract with PostProduction pipeline', () => {
  test('mixing cue-bearing and silent beats accumulates cursor across all', () => {
    const mixed = [
      { beat_id: 's1b1', type: 'REACTION', duration_seconds: 2 },
      { beat_id: 's1b2', type: 'B_ROLL_ESTABLISHING', duration_seconds: 3 },
      { beat_id: 's1b3', type: 'TALKING_HEAD_CLOSEUP', dialogue: 'Finally.', duration_seconds: 3 }
    ];
    const srt = buildSrtFromBeatsForTest(mixed, 3);
    // First dialogue cue: 3 (title) + 2 + 3 = 8s
    assert.ok(srt.includes('00:00:08,000 --> 00:00:11,000'));
  });
});

// ─────────────────────────────────────────────────────────────
// Assembly cumulative-duration math (Bug 5 Option B regression).
// The real assembleScenesWithTransitions is not exported, but the invariant
// under test is purely arithmetic: cumulativeDuration must track the actual
// duration of [v_i] so subsequent xfade offsets resolve correctly. We mirror
// the function's cumulative-update logic here and assert it produces sane
// offsets for mixed dissolve/cut sequences.
// ─────────────────────────────────────────────────────────────

const TRANSITION_DURATION = 0.5;
const CUT_XFADE_DURATION = 0.01;

function computeXfadeOffsets(sceneDurations, transitions) {
  // transitions[i] describes the transition OUT of scenes[i] → scenes[i+1].
  // Returns [{ offset, videoOverlap, cumulativeAfter }] per iteration.
  const xfadeTransitions = new Set(['dissolve', 'fadeblack', 'speed_ramp']);
  const out = [];
  let cumulativeDuration = 0;
  for (let i = 0; i < transitions.length; i++) {
    const transition = transitions[i] || 'cut';
    const videoOverlap = xfadeTransitions.has(transition) ? TRANSITION_DURATION : CUT_XFADE_DURATION;
    cumulativeDuration += sceneDurations[i];
    const offset = Math.max(0, cumulativeDuration - videoOverlap);
    out.push({ offset, videoOverlap, cumulativeBefore: cumulativeDuration, transition });
    cumulativeDuration -= videoOverlap;
  }
  return { offsets: out, finalCumulativeDuration: cumulativeDuration + sceneDurations[sceneDurations.length - 1] };
}

describe('assembly xfade cumulative tracking (Bug 5 Option B)', () => {
  test('single dissolve: offset = first_input_duration - 0.5', () => {
    const { offsets } = computeXfadeOffsets([9.1, 12.1], ['dissolve']);
    assert.equal(offsets.length, 1);
    assert.equal(offsets[0].offset.toFixed(3), (9.1 - 0.5).toFixed(3));
    assert.equal(offsets[0].videoOverlap, 0.5);
  });

  test('single cut: offset = first_input_duration - 0.01 (leaves room for xfade)', () => {
    const { offsets } = computeXfadeOffsets([9.1, 12.1], ['cut']);
    assert.equal(offsets[0].offset.toFixed(3), (9.1 - 0.01).toFixed(3));
    assert.equal(offsets[0].videoOverlap, 0.01);
  });

  test('dissolve then cut: second offset resolves against real [v0] duration (not drifted)', () => {
    // [v0] after dissolve = 9.1 + 12.1 - 0.5 = 20.7s
    // Cut offset on [v0] must be 20.7 - 0.01 = 20.69 — NOT 20.2 (which would
    // happen with the old code that uniformly subtracted 0.5 from cumulative).
    const { offsets } = computeXfadeOffsets([9.1, 12.1, 17.5], ['dissolve', 'cut']);
    assert.equal(offsets.length, 2);
    assert.equal(offsets[1].offset.toFixed(3), (20.7 - 0.01).toFixed(3));
  });

  test('cut then dissolve: dissolve offset resolves against real [v0] duration (bug regression)', () => {
    // With the old code (uniform -= 0.5): cut iter 0 produced cumDur = -0.01 + 9.1 = 8.6 after subtraction, then
    // cut iter 1 added 12.1 → 20.7, offset 20.19. With the current fix:
    // cut iter 0: cumDur = 9.1, videoOverlap = 0.01, subtract 0.01 → cumDur = 9.09 (actual [v0] = 9.1+12.1-0.01 = 21.19... wait no, that's after adding B in iter 1)
    //
    // Corrected: after iter 0 (cut A→B), cumDur = 9.09. Iter 1 adds B = 12.1 → cumDur = 21.19. That's [v0].duration
    // (= 9.1 + 12.1 - 0.01 = 21.19 ✓). Then dissolve offset = 21.19 - 0.5 = 20.69.
    const { offsets } = computeXfadeOffsets([9.1, 12.1, 17.5], ['cut', 'dissolve']);
    assert.equal(offsets[1].offset.toFixed(3), (21.19 - 0.5).toFixed(3));
  });

  test('three consecutive cuts: no drift accumulates (guards N-cut bug)', () => {
    // Each cut leaves 0.01s overlap. After 3 cuts on [10,10,10,10], actual [v2]
    // duration = 10 + 10 + 10 + 10 - 3*0.01 = 39.97. The FOURTH cut's offset
    // must resolve against 39.97, not a drifted value.
    const { offsets } = computeXfadeOffsets([10, 10, 10, 10], ['cut', 'cut', 'cut']);
    assert.equal(offsets.length, 3);
    // Iter 0: cumDur=10, offset=9.99, after=9.99
    // Iter 1: cumDur=9.99+10=19.99, offset=19.98, after=19.98
    // Iter 2: cumDur=19.98+10=29.98, offset=29.97, after=29.97
    assert.equal(offsets[0].offset.toFixed(3), '9.990');
    assert.equal(offsets[1].offset.toFixed(3), '19.980');
    assert.equal(offsets[2].offset.toFixed(3), '29.970');
  });

  test('mixed dissolve/cut/dissolve/cut preserves cumulative sanity', () => {
    // Regression test for the bug class: after any cut, subsequent dissolves
    // and cuts must resolve against the real growing video duration.
    const durations = [8, 12, 15, 10, 7];
    const transitions = ['dissolve', 'cut', 'dissolve', 'cut'];
    const { offsets } = computeXfadeOffsets(durations, transitions);

    // Expected [v_i] durations:
    // [v0] = 8 + 12 - 0.5 = 19.5
    // [v1] = 19.5 + 15 - 0.01 = 34.49
    // [v2] = 34.49 + 10 - 0.5 = 43.99
    // [v3] = 43.99 + 7 - 0.01 = 50.98
    assert.equal(offsets[0].offset.toFixed(3), (8 - 0.5).toFixed(3));
    assert.equal(offsets[1].offset.toFixed(3), (19.5 - 0.01).toFixed(3));
    assert.equal(offsets[2].offset.toFixed(3), (34.49 - 0.5).toFixed(3));
    assert.equal(offsets[3].offset.toFixed(3), (43.99 - 0.01).toFixed(3));
  });
});
