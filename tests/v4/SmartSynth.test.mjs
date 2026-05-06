// tests/v4/SmartSynth.test.mjs
//
// Unit tests for services/v4/SmartSynth.js.
//
// The Gemini calls (multimodal + text-rich layers) require live Vertex
// credentials so they're not exercised here. Instead these tests cover:
//   - The cheap-layer fallback path (no Gemini configured)
//   - Cross-attempt memory: priorAttempts threaded through cheap layer
//   - Regression detection: monotonic-decline gate
//   - synth_history append/read/patch helpers
//   - Output shape stability across all sources

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  synthesizeRetakeDirective,
  appendSynthHistory,
  readSynthHistory,
  patchSynthOutcome
} from '../../services/v4/SmartSynth.js';

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

const baseSceneVerdict = {
  verdict: 'soft_reject',
  overall_score: 58,
  findings: [
    {
      id: 'composition_too_wide',
      severity: 'critical',
      dimension: 'composition',
      message: 'Subject occupies less than 30% of frame; reads as establishing wide instead of character close.',
      evidence: 'Subject visible at ~25% frame width, midground empty.',
      remediation: {
        action: 'rewrite_anchor',
        prompt_delta: 'Push to medium close-up: subject from chest up, soft shoulder profile.',
        target_fields: ['scene_visual_anchor_prompt'],
        target: 'anchor'
      }
    },
    {
      id: 'lut_mismatch',
      severity: 'warning',
      dimension: 'lut_mood_fit',
      message: 'Lighting reads cool/teal; LUT spec calls for warm golden-hour key.',
      evidence: '',
      remediation: {
        action: 'rewrite_anchor',
        prompt_delta: 'Warm key light from camera-right; soft shadow on left cheek.',
        target_fields: ['scene_visual_anchor_prompt'],
        target: 'anchor'
      }
    }
  ],
  dimension_scores: { composition: 50, lut_mood_fit: 60, identity_fidelity: 80 }
};

const baseBeatVerdict = {
  verdict: 'hard_reject',
  overall_score: 42,
  findings: [
    {
      id: 'identity_drift',
      severity: 'critical',
      dimension: 'identity_fidelity',
      message: 'Persona facial structure drifted significantly from references.',
      evidence: 'Inter-ocular distance and jawline differ from anchor.',
      remediation: {
        action: 'regenerate_beat',
        prompt_delta: 'Re-anchor to the persona reference, preserve exact facial geometry.',
        target_fields: ['anchor_image'],
        target: 'identity'
      }
    }
  ],
  dimension_scores: { identity_fidelity: 30, composition: 80 }
};

// Force cheap-only layer by stripping the Vertex credentials env var that
// `isVertexGeminiConfigured()` checks. Saves the values so we can restore.
function withoutVertex(fn) {
  const saved = {
    GOOGLE_CLOUD_PROJECT_ID: process.env.GOOGLE_CLOUD_PROJECT_ID,
    GOOGLE_APPLICATION_CREDENTIALS_JSON: process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON,
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS
  };
  delete process.env.GOOGLE_CLOUD_PROJECT_ID;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  return Promise.resolve(fn()).finally(() => {
    if (saved.GOOGLE_CLOUD_PROJECT_ID !== undefined) process.env.GOOGLE_CLOUD_PROJECT_ID = saved.GOOGLE_CLOUD_PROJECT_ID;
    if (saved.GOOGLE_APPLICATION_CREDENTIALS_JSON !== undefined) process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = saved.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (saved.GOOGLE_APPLICATION_CREDENTIALS !== undefined) process.env.GOOGLE_APPLICATION_CREDENTIALS = saved.GOOGLE_APPLICATION_CREDENTIALS;
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

describe('SmartSynth — public API surface', () => {
  it('exports synthesizeRetakeDirective + history helpers', () => {
    assert.equal(typeof synthesizeRetakeDirective, 'function');
    assert.equal(typeof appendSynthHistory, 'function');
    assert.equal(typeof readSynthHistory, 'function');
    assert.equal(typeof patchSynthOutcome, 'function');
  });

  it('rejects calls without a verdict', async () => {
    await assert.rejects(() => synthesizeRetakeDirective({ checkpoint: 'beat', artifactId: 'b1' }),
      /verdict required/);
  });

  it('rejects calls without a checkpoint', async () => {
    await assert.rejects(() => synthesizeRetakeDirective({ verdict: baseBeatVerdict }),
      /checkpoint required/);
  });
});

describe('SmartSynth — cheap layer (no Vertex)', () => {
  it('returns a deterministic directive shape', async () => {
    await withoutVertex(async () => {
      const result = await synthesizeRetakeDirective({
        verdict: baseSceneVerdict,
        checkpoint: 'scene_master',
        artifactId: 'plaza_scene',
        artifactUrl: 'https://example.com/scene.png',
        referenceImages: [{ url: 'https://example.com/ref.jpg' }]
      });
      assert.equal(result.source, 'cheap_concat');
      assert.ok(typeof result.directive === 'string');
      assert.ok(result.directive.length > 0);
      assert.ok(result.directive.includes('plaza_scene'), 'cheap directive should cite the artifact id');
      assert.ok(result.directive.includes('Push to medium close-up'),
        'cheap directive should embed the prompt_delta from the critical finding');
      assert.equal(result.edited_anchor, null);  // cheap layer never produces an anchor rewrite
      assert.equal(result.edited_dialogue, null);
      assert.equal(result.regression_warning, false);
      assert.equal(result.prior_attempt_count, 0);
      assert.equal(result.reference_image_count, 0);
    });
  });

  it('falls through to cheap when Gemini configured but no findings + no priors', async () => {
    // Even with Vertex env present, an empty payload short-circuits to cheap.
    const result = await synthesizeRetakeDirective({
      verdict: { verdict: 'soft_reject', overall_score: 60, findings: [] },
      checkpoint: 'beat',
      artifactId: 'b_empty'
    });
    assert.equal(result.source, 'cheap_concat');
    assert.ok(result.directive.includes('Director halted'));
  });

  it('cites prior failed attempts in the cheap directive (cross-attempt memory)', async () => {
    await withoutVertex(async () => {
      const priors = [
        { directive: 'Push tighter framing.', source: 'multimodal_rich', resulting_score: 50, ts: '2026-05-06T10:00:00.000Z' },
        { directive: 'Push tighter framing AND warm the key.', source: 'multimodal_rich', resulting_score: 45, ts: '2026-05-06T10:30:00.000Z' }
      ];
      const result = await synthesizeRetakeDirective({
        verdict: baseSceneVerdict,
        checkpoint: 'scene_master',
        artifactId: 'plaza',
        priorAttempts: priors
      });
      assert.equal(result.source, 'cheap_concat');
      assert.equal(result.prior_attempt_count, 2);
      assert.ok(result.directive.includes('PRIOR ATTEMPTS (2 total)'),
        'cheap directive must surface prior attempts so the next renderer or panel does not repeat them');
      assert.ok(result.directive.includes('Push tighter framing'),
        'cheap directive must list the actual prior directives');
    });
  });
});

describe('SmartSynth — regression detection', () => {
  it('flags monotonic decline across 3 attempts', async () => {
    await withoutVertex(async () => {
      const decliningPriors = [
        { directive: 'a', resulting_score: 58 },
        { directive: 'b', resulting_score: 45 },
        { directive: 'c', resulting_score: 42 }
      ];
      const result = await synthesizeRetakeDirective({
        verdict: baseSceneVerdict,
        checkpoint: 'scene_master',
        artifactId: 'plaza',
        priorAttempts: decliningPriors
      });
      assert.equal(result.regression_warning, true,
        '58→45→42 must trigger regression_warning');
    });
  });

  it('flags monotonic decline across 2 attempts (minimum window)', async () => {
    await withoutVertex(async () => {
      const result = await synthesizeRetakeDirective({
        verdict: baseSceneVerdict,
        checkpoint: 'scene_master',
        artifactId: 'plaza',
        priorAttempts: [
          { resulting_score: 70 },
          { resulting_score: 60 }
        ]
      });
      assert.equal(result.regression_warning, true);
    });
  });

  it('does NOT flag improving scores', async () => {
    await withoutVertex(async () => {
      const result = await synthesizeRetakeDirective({
        verdict: baseSceneVerdict,
        checkpoint: 'scene_master',
        artifactId: 'plaza',
        priorAttempts: [
          { resulting_score: 50 },
          { resulting_score: 60 },
          { resulting_score: 70 }
        ]
      });
      assert.equal(result.regression_warning, false);
    });
  });

  it('does NOT flag a single attempt', async () => {
    await withoutVertex(async () => {
      const result = await synthesizeRetakeDirective({
        verdict: baseSceneVerdict,
        checkpoint: 'scene_master',
        artifactId: 'plaza',
        priorAttempts: [{ resulting_score: 42 }]
      });
      assert.equal(result.regression_warning, false);
    });
  });

  it('does NOT flag mixed (non-monotonic) trajectory', async () => {
    await withoutVertex(async () => {
      const result = await synthesizeRetakeDirective({
        verdict: baseSceneVerdict,
        checkpoint: 'scene_master',
        artifactId: 'plaza',
        priorAttempts: [
          { resulting_score: 60 },
          { resulting_score: 55 },
          { resulting_score: 65 }  // bounce up — not a regression
        ]
      });
      assert.equal(result.regression_warning, false);
    });
  });

  it('ignores priors without resulting_score', async () => {
    await withoutVertex(async () => {
      const result = await synthesizeRetakeDirective({
        verdict: baseSceneVerdict,
        checkpoint: 'scene_master',
        artifactId: 'plaza',
        priorAttempts: [
          { directive: 'a' },     // no score yet (synth attempted but render not judged)
          { directive: 'b' }
        ]
      });
      assert.equal(result.regression_warning, false);
    });
  });
});

describe('SmartSynth — synth_history helpers', () => {
  it('appendSynthHistory creates the bucket lazily', () => {
    const dr = {};
    appendSynthHistory({
      directorReport: dr,
      checkpoint: 'scene_master',
      artifactId: 'plaza',
      synthResult: {
        directive: 'Push tighter.',
        edited_anchor: 'rewritten anchor',
        source: 'multimodal_rich',
        confidence: 0.7,
        prior_attempt_count: 0
      }
    });
    assert.ok(dr.synth_history.scene_master.plaza);
    assert.equal(dr.synth_history.scene_master.plaza.length, 1);
    assert.equal(dr.synth_history.scene_master.plaza[0].directive, 'Push tighter.');
    assert.equal(dr.synth_history.scene_master.plaza[0].source, 'multimodal_rich');
    assert.equal(dr.synth_history.scene_master.plaza[0].edited_anchor, 'rewritten anchor');
  });

  it('appendSynthHistory accumulates across calls (no replace)', () => {
    const dr = {};
    appendSynthHistory({
      directorReport: dr, checkpoint: 'scene_master', artifactId: 'p1',
      synthResult: { directive: 'first', source: 'multimodal_rich' }
    });
    appendSynthHistory({
      directorReport: dr, checkpoint: 'scene_master', artifactId: 'p1',
      synthResult: { directive: 'second', source: 'text_rich' }
    });
    assert.equal(dr.synth_history.scene_master.p1.length, 2);
    assert.equal(dr.synth_history.scene_master.p1[0].directive, 'first');
    assert.equal(dr.synth_history.scene_master.p1[1].directive, 'second');
  });

  it('readSynthHistory returns [] for missing artifact', () => {
    assert.deepEqual(readSynthHistory({ directorReport: {}, checkpoint: 'beat', artifactId: 'b1' }), []);
    assert.deepEqual(readSynthHistory({ directorReport: { synth_history: {} }, checkpoint: 'beat', artifactId: 'b1' }), []);
  });

  it('readSynthHistory returns [] for null directorReport', () => {
    assert.deepEqual(readSynthHistory({ directorReport: null, checkpoint: 'beat', artifactId: 'b1' }), []);
  });

  it('patchSynthOutcome patches the most recent entry only', () => {
    const dr = {};
    appendSynthHistory({
      directorReport: dr, checkpoint: 'beat', artifactId: 'b1',
      synthResult: { directive: 'first', source: 'multimodal_rich' }
    });
    appendSynthHistory({
      directorReport: dr, checkpoint: 'beat', artifactId: 'b1',
      synthResult: { directive: 'second', source: 'text_rich' }
    });
    patchSynthOutcome({
      directorReport: dr, checkpoint: 'beat', artifactId: 'b1',
      resultingScore: 65, resultingVerdict: 'pass_with_notes'
    });
    assert.equal(dr.synth_history.beat.b1[0].resulting_score, null);
    assert.equal(dr.synth_history.beat.b1[1].resulting_score, 65);
    assert.equal(dr.synth_history.beat.b1[1].resulting_verdict, 'pass_with_notes');
  });

  it('patchSynthOutcome is a no-op when no history exists', () => {
    const dr = {};
    // Should not throw.
    patchSynthOutcome({
      directorReport: dr, checkpoint: 'beat', artifactId: 'b1',
      resultingScore: 50, resultingVerdict: 'hard_reject'
    });
    assert.equal(dr.synth_history, undefined);
  });

  it('commercial_scene_master maps to scene_master bucket', () => {
    const dr = {};
    appendSynthHistory({
      directorReport: dr, checkpoint: 'commercial_scene_master', artifactId: 'cs1',
      synthResult: { directive: 'commercial', source: 'multimodal_rich' }
    });
    assert.ok(dr.synth_history.scene_master.cs1, 'commercial_scene_master must alias to scene_master bucket');
    const read = readSynthHistory({ directorReport: dr, checkpoint: 'commercial_scene_master', artifactId: 'cs1' });
    assert.equal(read.length, 1);
  });

  it('commercial_beat maps to beat bucket', () => {
    const dr = {};
    appendSynthHistory({
      directorReport: dr, checkpoint: 'commercial_beat', artifactId: 'cb1',
      synthResult: { directive: 'commercial beat', source: 'multimodal_rich' }
    });
    assert.ok(dr.synth_history.beat.cb1);
  });

  it('handles invalid args gracefully (no throw)', () => {
    appendSynthHistory({ directorReport: null });
    appendSynthHistory({});
    appendSynthHistory({ directorReport: {}, checkpoint: 'beat' });   // missing artifactId
    patchSynthOutcome({ directorReport: null });
    patchSynthOutcome({});
    // No throws — the helpers are defense-in-depth wrappers.
    assert.ok(true);
  });
});

describe('SmartSynth — output shape', () => {
  it('returns the canonical shape from cheap layer', async () => {
    await withoutVertex(async () => {
      const result = await synthesizeRetakeDirective({
        verdict: baseSceneVerdict,
        checkpoint: 'scene_master',
        artifactId: 'p1'
      });
      const required = [
        'directive', 'edited_anchor', 'edited_dialogue',
        'diagnosis', 'confidence', 'source',
        'regression_warning', 'prior_attempt_count',
        'model_latency_ms', 'visible_tokens', 'reference_image_count'
      ];
      for (const k of required) {
        assert.ok(k in result, `result must contain ${k}`);
      }
    });
  });

  it('always returns a string directive (never null)', async () => {
    await withoutVertex(async () => {
      const result = await synthesizeRetakeDirective({
        verdict: { verdict: 'soft_reject', findings: [] },
        checkpoint: 'beat',
        artifactId: 'b1'
      });
      assert.equal(typeof result.directive, 'string');
      assert.ok(result.directive.length > 0);
    });
  });

  it('caps directive at 4000 chars even with massive priors', async () => {
    await withoutVertex(async () => {
      const massivePriors = Array.from({ length: 50 }, (_, i) => ({
        directive: 'X'.repeat(500),
        resulting_score: 50 - i
      }));
      const result = await synthesizeRetakeDirective({
        verdict: baseSceneVerdict,
        checkpoint: 'scene_master',
        artifactId: 'p1',
        priorAttempts: massivePriors
      });
      assert.ok(result.directive.length <= 4000);
    });
  });
});
