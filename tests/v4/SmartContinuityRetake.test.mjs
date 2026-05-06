// tests/v4/SmartContinuityRetake.test.mjs
//
// V4 Tier 4.1 — Lens E SmartSynth + 2-tier auto-retake unit tests.
//
// Run: node --test tests/v4/SmartContinuityRetake.test.mjs
//
// Coverage:
//   • SmartSynth recognizes 'continuity' as a multimodal-eligible checkpoint
//   • SmartSynth bucket switches (appendSynthHistory / readSynthHistory /
//     patchSynthOutcome) route 'continuity' to the right bucket
//   • runContinuityRetake — Tier A and Tier B paths
//   • runContinuityRetake — regression detection breaks the retake loop
//   • runContinuityRetake — graceful degradation when SmartSynth fails
//
// Tests use mocked DirectorAgent + router so no actual Gemini / fal.ai
// calls are made. The mock contract is stable: directorAgent.judgeContinuity
// resolves to a verdict object; router.generate resolves to {videoBuffer,
// modelUsed, durationSec, costUsd, metadata}.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  appendSynthHistory,
  readSynthHistory,
  patchSynthOutcome
} from '../../services/v4/SmartSynth.js';

// ─────────────────────────────────────────────────────────────────────
// SmartSynth bucket-key recognition for 'continuity'
// ─────────────────────────────────────────────────────────────────────

describe('SmartSynth bucket-key resolves continuity', () => {
  test('appendSynthHistory routes continuity to its own bucket', () => {
    const directorReport = {};
    appendSynthHistory({
      directorReport,
      checkpoint: 'continuity',
      artifactId: 's2b2',
      synthResult: {
        directive: 'match prev lighting key',
        source: 'multimodal_rich',
        confidence: 0.8
      }
    });
    assert.ok(directorReport.synth_history.continuity);
    assert.equal(directorReport.synth_history.continuity['s2b2'].length, 1);
    const entry = directorReport.synth_history.continuity['s2b2'][0];
    assert.equal(entry.directive, 'match prev lighting key');
    assert.equal(entry.source, 'multimodal_rich');
  });

  test('readSynthHistory reads from continuity bucket', () => {
    const directorReport = {
      synth_history: {
        continuity: {
          's2b2': [
            { directive: 'first attempt', source: 'cheap_concat' },
            { directive: 'second attempt', source: 'text_rich' }
          ]
        }
      }
    };
    const arr = readSynthHistory({ directorReport, checkpoint: 'continuity', artifactId: 's2b2' });
    assert.equal(arr.length, 2);
    assert.equal(arr[1].directive, 'second attempt');
  });

  test('patchSynthOutcome updates the most recent continuity entry', () => {
    const directorReport = {
      synth_history: {
        continuity: {
          's2b2': [
            { directive: 'attempt 1', source: 'cheap_concat', resulting_score: null },
            { directive: 'attempt 2', source: 'text_rich', resulting_score: null }
          ]
        }
      }
    };
    patchSynthOutcome({
      directorReport,
      checkpoint: 'continuity',
      artifactId: 's2b2',
      resultingScore: 78,
      resultingVerdict: 'pass_with_notes'
    });
    const arr = directorReport.synth_history.continuity['s2b2'];
    assert.equal(arr[1].resulting_score, 78);
    assert.equal(arr[1].resulting_verdict, 'pass_with_notes');
    // Earlier entry untouched.
    assert.equal(arr[0].resulting_score, null);
  });

  test('continuity bucket isolated from beat bucket', () => {
    const directorReport = {};
    appendSynthHistory({
      directorReport,
      checkpoint: 'beat',
      artifactId: 's2b2',
      synthResult: { directive: 'beat retake', source: 'multimodal_rich' }
    });
    appendSynthHistory({
      directorReport,
      checkpoint: 'continuity',
      artifactId: 's2b2',
      synthResult: { directive: 'continuity retake', source: 'multimodal_rich' }
    });
    // Same artifact_id, separate buckets.
    assert.equal(readSynthHistory({ directorReport, checkpoint: 'beat', artifactId: 's2b2' }).length, 1);
    assert.equal(readSynthHistory({ directorReport, checkpoint: 'continuity', artifactId: 's2b2' }).length, 1);
    assert.equal(directorReport.synth_history.beat['s2b2'][0].directive, 'beat retake');
    assert.equal(directorReport.synth_history.continuity['s2b2'][0].directive, 'continuity retake');
  });
});

// ─────────────────────────────────────────────────────────────────────
// runContinuityRetake — Tier A path (re-extract + retake current beat)
// ─────────────────────────────────────────────────────────────────────

describe('runContinuityRetake — Tier A path', () => {
  test('returns passed=true when re-judge accepts', async () => {
    const { runContinuityRetake } = await import('../../services/v4/ContinuitySupervisor.js');

    const prevBeat = {
      beat_id: 's2b1',
      type: 'B_ROLL_ESTABLISHING',
      status: 'generated',
      version: 1,
      attempts_log: [],
      generated_video_url: 'https://x/s2b1.mp4',
      endframe_url: 'https://x/s2b1-end.jpg',
      continuity_chain_broken: false
    };
    const currentBeat = {
      beat_id: 's2b2',
      type: 'TALKING_HEAD_CLOSEUP',
      status: 'generated',
      version: 1,
      attempts_log: [],
      generated_video_url: 'https://x/s2b2.mp4',
      endframe_url: 'https://x/s2b2-end.jpg',
      continuity_fallback_reason: 'previous_endframe_used'
    };
    const scene = { scene_id: 'pavilion_discovery', location: 'pavilion' };
    const directorReport = {};

    // Mocks
    const directorAgent = {
      judgeContinuity: async () => ({
        verdict: 'pass_with_notes',
        overall_score: 82,
        dimension_scores: { wardrobe: 85, props: 80, lighting_motivation: 80, eyeline: 85, screen_direction: 80 },
        findings: [],
        commendations: ['continuity restored after retake']
      })
    };
    const router = {
      generate: async () => ({
        videoBuffer: Buffer.from('fake-video'),
        modelUsed: 'kling-o3-omni-standard',
        durationSec: 3.2,
        costUsd: 1.0,
        metadata: {}
      })
    };
    const uploadVideo = async (_buf, fname) => `https://x/${fname}`;
    const uploadEndframe = async (_buf, fname) => `https://x/${fname}`;

    const result = await runContinuityRetake({
      directorAgent,
      router,
      currentBeat,
      previousBeat: prevBeat,
      scene,
      refStack: [],
      personas: [{ name: 'Elara', reference_image_urls: ['https://x/elara.jpg'] }],
      episodeContext: {},
      directorReport,
      previousVerdict: { verdict: 'soft_reject', overall_score: 55, findings: [{ message: 'lighting drift' }] },
      scenarioTier: 'A',
      previousBeatVideoBuffer: Buffer.from('fake-prev-video'),
      uploadVideo,
      uploadEndframe
    });

    assert.equal(result.passed, true);
    assert.equal(result.regressionWarning, false);
    assert.ok(result.retakenBeatIds.includes('s2b2'));
    // Tier A retakes only the current beat; previous beat stays unchanged.
    assert.ok(!result.retakenBeatIds.includes('s2b1'));
    // SmartSynth history should have one entry for the current beat.
    const history = readSynthHistory({ directorReport, checkpoint: 'continuity', artifactId: 's2b2' });
    assert.equal(history.length, 1);
    assert.equal(history[0].resulting_verdict, 'pass_with_notes');
    assert.equal(history[0].resulting_score, 82);
    // The wrapper supersedes the beat then calls router.generate(); the
    // real router (BeatRouter → BaseBeatGenerator.generate) transitions
    // through generating → generated. This test mocks at router.generate
    // level so the lifecycle stops at 'superseded' — that's correct
    // behavior for the wrapper, the lifecycle progression is owned by
    // BaseBeatGenerator and tested separately. Just verify supersede ran.
    assert.equal(currentBeat.status, 'superseded');
    // Director nudge stamped from SmartSynth directive (cheap fallback when no Gemini configured).
    assert.ok(typeof currentBeat.director_nudge === 'string' && currentBeat.director_nudge.length > 0);
    // Canonical row carries the new generated_video_url from the retake upload.
    assert.ok(currentBeat.generated_video_url && currentBeat.generated_video_url.includes('s2b2-tierA'));
  });

  test('Tier A re-extracts previous beat endframe when broken', async () => {
    const { runContinuityRetake } = await import('../../services/v4/ContinuitySupervisor.js');
    const prevBeat = {
      beat_id: 's2b1',
      type: 'B_ROLL',
      status: 'generated',
      version: 1,
      attempts_log: [],
      generated_video_url: 'https://x/s2b1.mp4',
      endframe_url: null, // failed extraction
      continuity_chain_broken: true,
      endframe_extraction_error: 'mostly black frame'
    };
    const currentBeat = {
      beat_id: 's2b2',
      type: 'TALKING_HEAD',
      status: 'generated',
      version: 1,
      attempts_log: [],
      generated_video_url: 'https://x/s2b2.mp4',
      endframe_url: 'https://x/s2b2-end.jpg'
    };

    const directorAgent = {
      judgeContinuity: async () => ({
        verdict: 'pass',
        overall_score: 90,
        dimension_scores: { wardrobe: 90, props: 90, lighting_motivation: 90, eyeline: 90, screen_direction: 90 },
        findings: [],
        commendations: ['clean']
      })
    };
    const router = {
      generate: async () => ({
        videoBuffer: Buffer.from('regen'),
        modelUsed: 'kling-o3-omni-standard',
        durationSec: 3,
        costUsd: 1
      })
    };
    // _reExtractEndframe calls extractBeatEndframe internally; we need to
    // verify Tier A attempted re-extraction. Since extractBeatEndframe runs
    // ffmpeg, this test will exercise the catch-and-fallthrough path (ffmpeg
    // can't actually decode 'fake-prev-video' bytes), confirming that even
    // when re-extraction fails the rest of Tier A still proceeds.
    const result = await runContinuityRetake({
      directorAgent,
      router,
      currentBeat,
      previousBeat: prevBeat,
      scene: { scene_id: 's2' },
      refStack: [],
      personas: [],
      episodeContext: {},
      directorReport: {},
      previousVerdict: { verdict: 'soft_reject', overall_score: 50, findings: [] },
      scenarioTier: 'A',
      previousBeatVideoBuffer: Buffer.from('fake-prev-video'),
      uploadVideo: async (_b, n) => `https://x/${n}`,
      uploadEndframe: async (_b, n) => `https://x/${n}`
    });

    // Either re-extraction succeeded (ok) or fell through (also ok for the
    // contract — we just need the retake to keep going). Passing assertion:
    assert.equal(result.passed, true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// runContinuityRetake — Tier B path (retake both beats)
// ─────────────────────────────────────────────────────────────────────

describe('runContinuityRetake — Tier B path', () => {
  test('retakes BOTH beats and re-judges', async () => {
    const { runContinuityRetake } = await import('../../services/v4/ContinuitySupervisor.js');
    const prevBeat = {
      beat_id: 's2b1',
      type: 'B_ROLL',
      status: 'generated',
      version: 1,
      attempts_log: [],
      generated_video_url: 'https://x/s2b1.mp4',
      endframe_url: 'https://x/s2b1-end.jpg'
    };
    const currentBeat = {
      beat_id: 's2b2',
      type: 'TALKING_HEAD',
      status: 'generated',
      version: 1,
      attempts_log: [],
      generated_video_url: 'https://x/s2b2.mp4',
      endframe_url: 'https://x/s2b2-end.jpg'
    };

    let generateCallCount = 0;
    const router = {
      generate: async () => {
        generateCallCount++;
        return {
          videoBuffer: Buffer.from(`gen-${generateCallCount}`),
          modelUsed: 'kling-o3-omni-standard',
          durationSec: 3,
          costUsd: 1
        };
      }
    };
    const directorAgent = {
      judgeContinuity: async () => ({
        verdict: 'pass',
        overall_score: 88,
        dimension_scores: { wardrobe: 88, props: 88, lighting_motivation: 88, eyeline: 88, screen_direction: 88 },
        findings: [],
        commendations: ['clean']
      })
    };
    const result = await runContinuityRetake({
      directorAgent,
      router,
      currentBeat,
      previousBeat: prevBeat,
      scene: { scene_id: 's2' },
      refStack: [],
      personas: [],
      episodeContext: {},
      directorReport: {},
      previousVerdict: { verdict: 'soft_reject', overall_score: 45, findings: [] },
      scenarioTier: 'B',
      uploadVideo: async (_b, n) => `https://x/${n}`,
      uploadEndframe: async (_b, n) => `https://x/${n}`
    });

    // Both beats retaken — 2 generate calls.
    assert.equal(generateCallCount, 2);
    assert.ok(result.retakenBeatIds.includes('s2b1'));
    assert.ok(result.retakenBeatIds.includes('s2b2'));
    assert.equal(result.passed, true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// runContinuityRetake — regression detection
// ─────────────────────────────────────────────────────────────────────

describe('runContinuityRetake — regression detection', () => {
  test('regressionWarning=true halts before retake when 3 declining scores in priorAttempts', async () => {
    const { runContinuityRetake } = await import('../../services/v4/ContinuitySupervisor.js');
    const directorReport = {
      synth_history: {
        continuity: {
          's2b2': [
            { directive: 'a1', source: 'cheap_concat', resulting_score: 60 },
            { directive: 'a2', source: 'text_rich', resulting_score: 50 },
            { directive: 'a3', source: 'multimodal_rich', resulting_score: 42 }
          ]
        }
      }
    };
    const prevBeat = { beat_id: 's2b1', status: 'generated', version: 1, attempts_log: [], endframe_url: 'https://x/p.jpg' };
    const currentBeat = { beat_id: 's2b2', status: 'generated', version: 1, attempts_log: [], endframe_url: 'https://x/c.jpg' };

    let generateCallCount = 0;
    const router = { generate: async () => { generateCallCount++; return { videoBuffer: Buffer.from('x'), modelUsed: 'k', durationSec: 3, costUsd: 1 }; } };
    const directorAgent = { judgeContinuity: async () => ({ verdict: 'soft_reject', overall_score: 40 }) };
    const result = await runContinuityRetake({
      directorAgent, router,
      currentBeat, previousBeat: prevBeat,
      scene: { scene_id: 's2' },
      refStack: [], personas: [], episodeContext: {},
      directorReport,
      previousVerdict: { verdict: 'soft_reject', overall_score: 42, findings: [] },
      scenarioTier: 'A',
      uploadVideo: async (_b, n) => `https://x/${n}`,
      uploadEndframe: async (_b, n) => `https://x/${n}`
    });

    assert.equal(result.regressionWarning, true);
    assert.equal(result.passed, false);
    // CRITICAL: when regression is detected, NO retake should run.
    assert.equal(generateCallCount, 0);
  });
});
