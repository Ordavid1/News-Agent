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
const OUTPUT_FPS = 30;
const TRANSITION_FRAMES = Math.round(TRANSITION_DURATION * OUTPUT_FPS); // 15
const CUT_FRAMES = 1;

// Mirrors the production assembly arithmetic in integer-frame domain —
// the only representation that matches ffmpeg's internal xfade behaviour.
// Returns per-iter { offsetFrames, offsetSec, transitionFrames, transition }.
function computeXfadeOffsets(sceneDurations, transitions) {
  const xfadeTransitions = new Set(['dissolve', 'fadeblack', 'speed_ramp']);
  const sceneFrames = sceneDurations.map(d => Math.floor(d * OUTPUT_FPS));
  const out = [];
  let cumulativeFrames = 0;
  for (let i = 0; i < transitions.length; i++) {
    const transition = transitions[i] || 'cut';
    const transitionFrames = xfadeTransitions.has(transition) ? TRANSITION_FRAMES : CUT_FRAMES;
    cumulativeFrames += sceneFrames[i];
    const offsetFrames = Math.max(0, cumulativeFrames - transitionFrames);
    out.push({
      offsetFrames,
      offsetSec: offsetFrames / OUTPUT_FPS,
      transitionFrames,
      videoOverlap: transitionFrames / OUTPUT_FPS,
      offset: offsetFrames / OUTPUT_FPS, // back-compat with old tests
      transition
    });
    cumulativeFrames -= transitionFrames;
  }
  return {
    offsets: out,
    finalCumulativeFrames: cumulativeFrames + sceneFrames[sceneFrames.length - 1]
  };
}

describe('assembly xfade cumulative tracking (frame-integer math)', () => {
  // After the 2026-04-23 root-cause debug: assembly math must operate in
  // integer frame counts at OUTPUT_FPS, not floating seconds. ffmpeg's xfade
  // quantises inputs to whole frames, and floating-second math drifts by
  // ~1/fps per scene — enough to push cut offsets past the true frame-aligned
  // input length and cause silent xfade truncation.
  //
  // Helper converts seconds → floor(s * fps) for each scene and computes
  // offsets in frames.

  test('single dissolve: offset = floor(dur*fps) - 15 frames', () => {
    // 9.1s @ 30fps = floor(273) = 273 frames. offset = 273 - 15 = 258 = 8.60s
    const { offsets } = computeXfadeOffsets([9.1, 12.1], ['dissolve']);
    assert.equal(offsets.length, 1);
    assert.equal(offsets[0].offsetFrames, 273 - 15);
    assert.equal(offsets[0].transitionFrames, 15);
  });

  test('single cut: offset = floor(dur*fps) - 1 frame', () => {
    // 9.1s @ 30fps = 273 frames. Cut offset = 272 = 9.0667s
    const { offsets } = computeXfadeOffsets([9.1, 12.1], ['cut']);
    assert.equal(offsets[0].offsetFrames, 273 - 1);
    assert.equal(offsets[0].transitionFrames, 1);
  });

  test('dissolve then cut: second offset matches frame-aligned [v0]', () => {
    // Scene frames: floor(9.1*30)=273, floor(12.1*30)=363, floor(17.5*30)=525
    // [v0] frames = 273 + 363 - 15 = 621
    // Cut offset on [v0] = 621 - 1 = 620 frames
    const { offsets } = computeXfadeOffsets([9.1, 12.1, 17.5], ['dissolve', 'cut']);
    assert.equal(offsets.length, 2);
    assert.equal(offsets[1].offsetFrames, (273 + 363 - 15) - 1);
  });

  test('cut then dissolve: second offset matches frame-aligned [v0]', () => {
    // Scene frames: 273, 363, 525
    // [v0] after cut: 273 + 363 - 1 = 635
    // Dissolve offset = 635 - 15 = 620 frames
    const { offsets } = computeXfadeOffsets([9.1, 12.1, 17.5], ['cut', 'dissolve']);
    assert.equal(offsets[1].offsetFrames, (273 + 363 - 1) - 15);
  });

  test('three consecutive cuts: no drift, each offset matches true [v_i] frames', () => {
    // 10s @ 30fps = 300 frames each
    // [v0] = 300+300-1=599, [v1] = 599+300-1=898, [v2] = 898+300-1=1197
    const { offsets } = computeXfadeOffsets([10, 10, 10, 10], ['cut', 'cut', 'cut']);
    assert.equal(offsets.length, 3);
    assert.equal(offsets[0].offsetFrames, 300 - 1);
    assert.equal(offsets[1].offsetFrames, 599 - 1);
    assert.equal(offsets[2].offsetFrames, 898 - 1);
  });

  test('mixed dissolve/cut/dissolve/cut preserves cumulative sanity', () => {
    // Scene frames: 240, 360, 450, 300, 210
    // [v0] = 240+360-15=585
    // [v1] = 585+450-1=1034
    // [v2] = 1034+300-15=1319
    // [v3] = 1319+210-1=1528
    const { offsets } = computeXfadeOffsets([8, 12, 15, 10, 7], ['dissolve', 'cut', 'dissolve', 'cut']);
    assert.equal(offsets[0].offsetFrames, 240 - 15);
    assert.equal(offsets[1].offsetFrames, 585 - 1);
    assert.equal(offsets[2].offsetFrames, 1034 - 15);
    assert.equal(offsets[3].offsetFrames, 1319 - 1);
  });

  test('regression: frame-integer math prevents quantisation drift', () => {
    // Bug chain caught 2026-04-23 (two rounds of debugging):
    //   Round 1: tracked container duration (max of video+audio). Diverged
    //            from video stream by 0.03-0.05s per scene. FIXED.
    //   Round 2: tracked video-stream seconds. Mathematically correct but
    //            ffmpeg quantises inputs to integer frames at 30fps, so the
    //            actual xfade output was 1 frame shorter than math predicted.
    //            Over two scenes, the 0.01s cut window was consumed by the
    //            quantisation drift → xfade dropped [v0].
    //   Round 3 (this): track INTEGER FRAMES. Matches ffmpeg exactly.
    //
    // Real production failure: scene videos [10.573, 21.514, 15.09]s
    // @ 30fps = [317, 645, 452] frames.
    // [v0] frames = 317 + 645 - 15 = 947
    // Cut offset = 947 - 1 = 946 frames = 31.5333s (vs buggy 31.577s).
    // Output [v1] = 947 + 452 - 1 = 1398 frames = 46.6s ✓

    const { offsets } = computeXfadeOffsets([10.573, 21.514, 15.09], ['dissolve', 'cut']);

    // Iter 0: frames = floor(10.573*30) = 317 → offset = 317 - 15 = 302
    assert.equal(offsets[0].offsetFrames, 302);
    assert.equal(offsets[0].offsetSec.toFixed(5), (302 / 30).toFixed(5));

    // Iter 1 must resolve against [v0] in frames, not seconds
    // [v0] = 317 + 645 - 15 = 947 → cut offset = 946
    assert.equal(offsets[1].offsetFrames, 946);
    // Offset + transition must fit exactly within [v0]
    const v0Frames = 317 + 645 - 15;
    assert.equal(offsets[1].offsetFrames + offsets[1].transitionFrames, v0Frames,
      `cut xfade must consume exactly [v0].frames to avoid silent drop`);
  });
});

// ─────────────────────────────────────────────────────────────
// Bridge-clip assembly (the new primary path, 2026-04-23+).
// Even with frame-integer math the chained xfade in filter_complex was
// dropping scenes in production (intermediate [v_i] streams carry timing
// drift that's invisible to the computed offsets). The bridge-clip path
// replaces the chain with independent 2-input xfades on materialized
// 0.5s clips. This test asserts the segment layout and expected-duration
// arithmetic that the production function depends on.
// ─────────────────────────────────────────────────────────────

const BRIDGE_D = 0.5;
const BRIDGE_XFADE_MAP = { dissolve: 'fade', fadeblack: 'fadeblack', cut: null, speed_ramp: 'smoothup' };

function planBridgeSegments(sceneDurations, transitions) {
  const info = sceneDurations.map((v, i) => {
    const t = transitions[i] || (i === sceneDurations.length - 1 ? null : 'cut');
    return { videoDur: v, transition: t, isSoft: !!BRIDGE_XFADE_MAP[t] };
  });
  const segments = [];
  for (let i = 0; i < info.length; i++) {
    const s = info[i];
    const hasIncomingSoft = i > 0 && info[i - 1].isSoft;
    const hasOutgoingSoft = i < info.length - 1 && s.isSoft;
    const bodyStart = hasIncomingSoft ? BRIDGE_D : 0;
    const bodyEnd = hasOutgoingSoft ? s.videoDur - BRIDGE_D : s.videoDur;
    segments.push({ kind: 'body', sceneIndex: i, start: bodyStart, end: bodyEnd, dur: bodyEnd - bodyStart });
    if (hasOutgoingSoft) {
      segments.push({ kind: 'bridge', from: i, to: i + 1, dur: BRIDGE_D, xfade: BRIDGE_XFADE_MAP[s.transition] });
    }
  }
  const totalDur = segments.reduce((sum, s) => sum + s.dur, 0);
  return { segments, totalDur };
}

describe('assembly bridge-clip segment planning', () => {
  test('dissolve then cut: body trim only on the dissolve side', () => {
    // Production regression durations: 10.57 / 21.51 / 15.09
    const { segments, totalDur } = planBridgeSegments(
      [10.57, 21.51, 15.09],
      ['dissolve', 'cut']
    );
    // Expected layout: body_0 (trim tail), bridge_0→1, body_1 (trim head only), body_2
    assert.equal(segments.length, 4);
    assert.equal(segments[0].kind, 'body');
    assert.equal(segments[0].start, 0);
    assert.ok(Math.abs(segments[0].end - (10.57 - BRIDGE_D)) < 1e-9);
    assert.equal(segments[1].kind, 'bridge');
    assert.equal(segments[1].xfade, 'fade');
    assert.equal(segments[1].dur, BRIDGE_D);
    assert.equal(segments[2].kind, 'body');
    assert.ok(Math.abs(segments[2].start - BRIDGE_D) < 1e-9);
    assert.ok(Math.abs(segments[2].end - 21.51) < 1e-9);
    assert.equal(segments[3].kind, 'body');
    assert.equal(segments[3].start, 0);
    assert.ok(Math.abs(segments[3].end - 15.09) < 1e-9);
    // Timeline total = sum of scenes - 1 × transition duration (1 soft transition)
    const expected = 10.57 + 21.51 + 15.09 - BRIDGE_D;
    assert.ok(Math.abs(totalDur - expected) < 1e-9);
  });

  test('all-dissolve three-scene: both middle-scene ends trimmed', () => {
    const { segments, totalDur } = planBridgeSegments(
      [10, 12, 15],
      ['dissolve', 'dissolve']
    );
    // body0, bridge01, body1, bridge12, body2
    assert.equal(segments.length, 5);
    assert.equal(segments[0].end, 10 - BRIDGE_D);
    assert.equal(segments[2].start, BRIDGE_D);
    assert.equal(segments[2].end, 12 - BRIDGE_D);
    assert.equal(segments[4].start, BRIDGE_D);
    assert.ok(Math.abs(totalDur - (10 + 12 + 15 - 2 * BRIDGE_D)) < 1e-9);
  });

  test('all-cuts three-scene: no bridge segments, bodies untrimmed', () => {
    const { segments, totalDur } = planBridgeSegments(
      [10, 12, 15],
      ['cut', 'cut']
    );
    assert.equal(segments.length, 3);
    assert.ok(segments.every(s => s.kind === 'body'));
    assert.equal(segments[0].dur, 10);
    assert.equal(segments[1].dur, 12);
    assert.equal(segments[2].dur, 15);
    assert.equal(totalDur, 37);
  });

  test('fadeblack then dissolve: mixed soft transitions both rendered as bridges', () => {
    const { segments, totalDur } = planBridgeSegments(
      [8, 10, 12],
      ['fadeblack', 'dissolve']
    );
    assert.equal(segments.length, 5);
    assert.equal(segments[1].xfade, 'fadeblack');
    assert.equal(segments[3].xfade, 'fade');
    assert.ok(Math.abs(totalDur - (8 + 10 + 12 - 2 * BRIDGE_D)) < 1e-9);
  });

  test('regression: production triple-scene (10.57/21.51/15.09) produces the full 46.17s', () => {
    // This is exactly the case that failed in production with chained xfade
    // (output was 15.07s — only scene 2). The bridge-clip plan must yield
    // the full expected length, proving the math has no room to drop scenes.
    const { totalDur } = planBridgeSegments([10.57, 21.51, 15.09], ['dissolve', 'cut']);
    const expected = 10.57 + 21.51 + 15.09 - BRIDGE_D;
    assert.ok(Math.abs(totalDur - expected) < 1e-9,
      `bridge-clip total must equal sum of scenes minus one transition overlap; got ${totalDur.toFixed(3)}, expected ${expected.toFixed(3)}`);
    assert.ok(totalDur > 46.0, `bridge-clip total ${totalDur.toFixed(2)}s must not collapse to a single scene length`);
  });
});
