// tests/v4/DirectorRetryPolicy.test.mjs
//
// Deterministic tests for the V4 Director Agent retry policy. The policy is
// the single source of truth for whether the orchestrator may auto-retry a
// soft-rejected artifact (screenplay / scene_master / beat / episode) or
// must escalate to user. Bugs here directly affect cost (over-spending
// retries) and UX (silent failures the user can't act on).
//
// Run with: node --test tests/v4/DirectorRetryPolicy.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideRetry,
  RETRY_BUDGETS,
  STRUCTURAL_DEFECTS
} from '../../services/v4/DirectorRetryPolicy.js';

// ─── Budget constants ───
test('RETRY_BUDGETS — screenplay/scene_master/beat=1, episode=0 (advisory)', () => {
  assert.equal(RETRY_BUDGETS.screenplay, 1);
  assert.equal(RETRY_BUDGETS.scene_master, 1);
  assert.equal(RETRY_BUDGETS.beat, 1);
  assert.equal(RETRY_BUDGETS.episode, 0);
});

test('STRUCTURAL_DEFECTS — finite set of unfixable defect ids', () => {
  assert.ok(STRUCTURAL_DEFECTS.has('wrong_persona_cast'));
  assert.ok(STRUCTURAL_DEFECTS.has('subject_missing_from_frame'));
  assert.ok(STRUCTURAL_DEFECTS.has('genre_mismatch_unfixable'));
  assert.ok(STRUCTURAL_DEFECTS.has('persona_identity_unrecoverable'));
  assert.ok(STRUCTURAL_DEFECTS.has('safety_violation'));
});

// ─── Pass / pass_with_notes never retry, never escalate ───
test('pass → no retry, no escalate', () => {
  const r = decideRetry({
    verdict: { verdict: 'pass', findings: [], retry_authorization: true },
    checkpoint: 'screenplay'
  });
  assert.equal(r.shouldRetry, false);
  assert.equal(r.shouldEscalate, false);
});

test('pass_with_notes → no retry, no escalate', () => {
  const r = decideRetry({
    verdict: { verdict: 'pass_with_notes', findings: [], retry_authorization: true },
    checkpoint: 'beat',
    artifactKey: 'b_05'
  });
  assert.equal(r.shouldRetry, false);
  assert.equal(r.shouldEscalate, false);
});

// ─── hard_reject always escalates, never retries ───
test('hard_reject → escalate, no retry', () => {
  const r = decideRetry({
    verdict: { verdict: 'hard_reject', findings: [], retry_authorization: false },
    checkpoint: 'screenplay'
  });
  assert.equal(r.shouldRetry, false);
  assert.equal(r.shouldEscalate, true);
});

// ─── Structural defects on soft_reject → escalate ───
test('soft_reject with structural defect → escalate (skip retry budget)', () => {
  const r = decideRetry({
    verdict: {
      verdict: 'soft_reject',
      findings: [
        { id: 'wrong_persona_cast', severity: 'critical', remediation: { prompt_delta: 'fix' } }
      ],
      retry_authorization: true
    },
    checkpoint: 'beat',
    artifactKey: 'b_03',
    retriesState: {} // budget would normally allow retry
  });
  assert.equal(r.shouldRetry, false);
  assert.equal(r.shouldEscalate, true);
  assert.match(r.reason, /structural defect/);
});

test('soft_reject with subject_missing_from_frame → escalate', () => {
  const r = decideRetry({
    verdict: {
      verdict: 'soft_reject',
      findings: [{ id: 'subject_missing_from_frame', severity: 'critical', remediation: { prompt_delta: 'add subject' } }],
      retry_authorization: true
    },
    checkpoint: 'scene_master',
    artifactKey: 'sc_02'
  });
  assert.equal(r.shouldEscalate, true);
});

// ─── verdict.retry_authorization=false short-circuits even on soft_reject ───
test('soft_reject with retry_authorization=false → escalate', () => {
  const r = decideRetry({
    verdict: {
      verdict: 'soft_reject',
      findings: [{ id: 'cliffhanger_lacks_sting', severity: 'critical', remediation: { prompt_delta: 'sharper' } }],
      retry_authorization: false
    },
    checkpoint: 'screenplay'
  });
  assert.equal(r.shouldRetry, false);
  assert.equal(r.shouldEscalate, true);
});

// ─── Episode checkpoint is advisory-only (budget=0) ───
test('soft_reject on episode checkpoint → escalate (advisory only)', () => {
  const r = decideRetry({
    verdict: {
      verdict: 'soft_reject',
      findings: [{ id: 'rhythm_drag', severity: 'critical', remediation: { prompt_delta: 'tighten' } }],
      retry_authorization: true
    },
    checkpoint: 'episode'
  });
  assert.equal(r.shouldRetry, false);
  assert.equal(r.shouldEscalate, true);
  assert.match(r.reason, /no auto-retry budget/);
});

// ─── Budget exhausted ───
test('soft_reject with screenplay budget already spent → escalate', () => {
  const r = decideRetry({
    verdict: {
      verdict: 'soft_reject',
      findings: [{ id: 'cliffhanger_lacks_sting', severity: 'critical', remediation: { prompt_delta: 'sharper' } }],
      retry_authorization: true
    },
    checkpoint: 'screenplay',
    retriesState: { screenplay: 1 }
  });
  assert.equal(r.shouldRetry, false);
  assert.equal(r.shouldEscalate, true);
  assert.match(r.reason, /budget exhausted/);
});

test('soft_reject with beat budget already spent for THIS beat → escalate', () => {
  const r = decideRetry({
    verdict: {
      verdict: 'soft_reject',
      findings: [{ id: 'flat_performance', severity: 'critical', remediation: { prompt_delta: 'tighten' } }],
      retry_authorization: true
    },
    checkpoint: 'beat',
    artifactKey: 'b_03',
    retriesState: { beat: { b_03: 1 } }
  });
  assert.equal(r.shouldRetry, false);
  assert.equal(r.shouldEscalate, true);
});

test('per-artifact tracking — b_03 budget exhausted does NOT block b_04', () => {
  const r = decideRetry({
    verdict: {
      verdict: 'soft_reject',
      findings: [{ id: 'flat_performance', severity: 'critical', remediation: { prompt_delta: 'tighten' } }],
      retry_authorization: true
    },
    checkpoint: 'beat',
    artifactKey: 'b_04',
    retriesState: { beat: { b_03: 1 } }
  });
  assert.equal(r.shouldRetry, true);
  assert.equal(r.shouldEscalate, false);
});

// ─── Successful retry path ───
test('soft_reject with critical findings + budget available → retry with merged deltas', () => {
  const r = decideRetry({
    verdict: {
      verdict: 'soft_reject',
      findings: [
        { id: 'cliffhanger_lacks_sting', severity: 'critical', remediation: { prompt_delta: 'replace b_09 with covert phone call' } },
        { id: 'scene_3_unearned', severity: 'critical', remediation: { prompt_delta: 'collapse sc_03 into sc_02 tail' } },
        { id: 'voice_drift_minor', severity: 'note', remediation: { prompt_delta: 'tweak phrasing' } }
      ],
      retry_authorization: true
    },
    checkpoint: 'screenplay',
    retriesState: {}
  });
  assert.equal(r.shouldRetry, true);
  assert.equal(r.shouldEscalate, false);
  // critical findings only — note severity is excluded from the merged nudge
  assert.match(r.nudgePromptDelta, /cliffhanger_lacks_sting/);
  assert.match(r.nudgePromptDelta, /scene_3_unearned/);
  assert.doesNotMatch(r.nudgePromptDelta, /voice_drift_minor/);
});

test('successful retry increments the retry counter for next decision', () => {
  const r = decideRetry({
    verdict: {
      verdict: 'soft_reject',
      findings: [{ id: 'cliffhanger_lacks_sting', severity: 'critical', remediation: { prompt_delta: 'sharper' } }],
      retry_authorization: true
    },
    checkpoint: 'screenplay',
    retriesState: {}
  });
  assert.equal(r.shouldRetry, true);
  assert.equal(r.nextRetriesState.screenplay, 1);
});

test('successful per-beat retry increments artifact-keyed counter', () => {
  const r = decideRetry({
    verdict: {
      verdict: 'soft_reject',
      findings: [{ id: 'flat_performance', severity: 'critical', remediation: { prompt_delta: 'tighten' } }],
      retry_authorization: true
    },
    checkpoint: 'beat',
    artifactKey: 'b_07',
    retriesState: {}
  });
  assert.equal(r.shouldRetry, true);
  assert.deepEqual(r.nextRetriesState.beat, { b_07: 1 });
});

// ─── Error-verdict path (DirectorAgent fallback when Vertex fails) ───
// Added 2026-04-25 after logs.txt showed Gemini 3 Flash MAX_TOKENS truncation
// returning DirectorAgent fallback verdicts. Phase 2+ blocking mode must
// safely skip these (no retry, no escalate) rather than treat them as a
// soft_reject the policy might attempt to retry on (and fail again).
test('errored verdict (verdict=null + error msg) → no retry, no escalate', () => {
  const r = decideRetry({
    verdict: {
      verdict: null,
      overall_score: null,
      findings: [],
      commendations: [],
      retry_authorization: false,
      error: 'Vertex Gemini gemini-3-flash-preview response truncated (finishReason=MAX_TOKENS, budget=16384)'
    },
    checkpoint: 'beat',
    artifactKey: 'b_03',
    retriesState: {}
  });
  assert.equal(r.shouldRetry, false);
  assert.equal(r.shouldEscalate, false);
  assert.match(r.reason, /errored/);
});

test('verdict missing entirely (no .verdict field) → no retry, no escalate', () => {
  const r = decideRetry({
    verdict: { findings: [] },
    checkpoint: 'screenplay',
    retriesState: {}
  });
  assert.equal(r.shouldRetry, false);
  assert.equal(r.shouldEscalate, false);
});

// ─── Soft_reject with no critical findings (overall_score 50-69) ───
test('soft_reject without critical findings → retry with up-to-3 note-level deltas', () => {
  const r = decideRetry({
    verdict: {
      verdict: 'soft_reject',
      findings: [
        { id: 'tone_drift', severity: 'warning', remediation: { prompt_delta: 'cooler register' } },
        { id: 'pace_lull_act2', severity: 'warning', remediation: { prompt_delta: 'tighten 02:10-02:35' } }
      ],
      retry_authorization: true
    },
    checkpoint: 'scene_master',
    artifactKey: 'sc_01',
    retriesState: {}
  });
  assert.equal(r.shouldRetry, true);
  assert.match(r.nudgePromptDelta, /tone_drift/);
  assert.match(r.nudgePromptDelta, /pace_lull_act2/);
});
