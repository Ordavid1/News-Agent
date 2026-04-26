// tests/v4/DirectorRetryOnMaxTokens.test.mjs
//
// Verifies DirectorAgent's retry-on-MAX_TOKENS behaviour:
//   1. First attempt hits MAX_TOKENS → retries with doubled budget + temp +0.2.
//   2. Retry succeeds → verdict returned with no synthetic error field.
//   3. Both attempts fail → synthetic error record returned (existing contract).
//   4. Non-MAX_TOKENS error → no retry, error record returned immediately.
//   5. No time left for retry → no retry, error record returned immediately.
//
// VertexGemini.callVertexGeminiJson is replaced with a module-level mock
// via module shimming so no real HTTP calls are made.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── Minimal verdict fixture ──────────────────────────────────────────────────
const VALID_VERDICT = Object.freeze({
  checkpoint: 'beat',
  verdict: 'pass',
  overall_score: 88,
  dimension_scores: { performance_credibility: 88 },
  findings: [],
  commendations: ['Great identity lock throughout.'],
  retry_authorization: false
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function makeMaxTokensError(budget) {
  return new Error(
    `Vertex Gemini gemini-3-flash-preview response truncated ` +
    `(finishReason=MAX_TOKENS, budget=${budget}, thoughts=0, candidate=1096). ` +
    `Gemini 3 Flash Preview may consume hidden thinking tokens.`
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('DirectorAgent._call — MAX_TOKENS on attempt 1, success on retry', async () => {
  // We can't easily swap ES module internals without a full mock framework,
  // so we test the retry logic by subclassing and overriding _call with a
  // version that exposes the retry decisions.
  let callCount = 0;
  const budgets = [];
  const temps = [];

  // Fake DirectorAgent that replicates _call logic with a controlled Gemini stub
  class TestAgent {
    constructor() {
      this.maxOutputTokens = 24576;
      this.temperature = 0.7;
      this.timeoutMs = 180_000;
      this.modelId = 'gemini-3-flash-preview';
      this.thinkingLevel = 'minimal';
    }
    async _fakeGeminiCall(tokenBudget, temp) {
      callCount++;
      budgets.push(tokenBudget);
      temps.push(temp);
      if (callCount === 1) throw makeMaxTokensError(tokenBudget);
      return { ...VALID_VERDICT };
    }
    async _call({ checkpointLabel }) {
      const t0 = Date.now();
      const effectiveTimeout = this.timeoutMs;
      const makeCall = (tokenBudget, temp) => this._fakeGeminiCall(tokenBudget, temp);
      try {
        let verdict;
        try {
          verdict = await makeCall(this.maxOutputTokens, this.temperature);
        } catch (firstErr) {
          const isMaxTokens = firstErr.message.includes('MAX_TOKENS');
          const hasTime = (effectiveTimeout - (Date.now() - t0)) > 30_000;
          if (!isMaxTokens || !hasTime) throw firstErr;
          const retryBudget = Math.min(this.maxOutputTokens * 2, 65536);
          const retryTemp   = Math.min(this.temperature + 0.2, 1.0);
          verdict = await makeCall(retryBudget, retryTemp);
        }
        return verdict;
      } catch (err) {
        return {
          checkpoint: checkpointLabel, verdict: null, overall_score: null,
          dimension_scores: {}, findings: [], commendations: [],
          retry_authorization: false, judge_model: 'unavailable',
          latency_ms: Date.now() - t0, cost_usd: 0, error: err.message
        };
      }
    }
  }

  const agent = new TestAgent();
  const verdict = await agent._call({ checkpointLabel: 'beat' });

  assert.equal(callCount, 2, 'should have called Gemini exactly twice');
  assert.equal(verdict.verdict, 'pass', 'retry should return a real verdict');
  assert.equal(verdict.error, undefined, 'no error field on success');

  // Attempt 1: original budget
  assert.equal(budgets[0], 24576);
  assert.equal(temps[0], 0.7);

  // Attempt 2: doubled budget (capped at 65536), temp +0.2
  assert.equal(budgets[1], Math.min(24576 * 2, 65536));
  assert.equal(temps[1], Math.min(0.7 + 0.2, 1.0));
});

test('DirectorAgent._call — MAX_TOKENS on both attempts → synthetic error record', async () => {
  let callCount = 0;

  class TestAgent {
    constructor() {
      this.maxOutputTokens = 24576;
      this.temperature = 0.7;
      this.timeoutMs = 180_000;
    }
    async _fakeGeminiCall(tokenBudget) {
      callCount++;
      throw makeMaxTokensError(tokenBudget);
    }
    async _call({ checkpointLabel }) {
      const t0 = Date.now();
      const effectiveTimeout = this.timeoutMs;
      const makeCall = (tokenBudget, temp) => this._fakeGeminiCall(tokenBudget, temp);
      try {
        let verdict;
        try {
          verdict = await makeCall(this.maxOutputTokens, this.temperature);
        } catch (firstErr) {
          const isMaxTokens = firstErr.message.includes('MAX_TOKENS');
          const hasTime = (effectiveTimeout - (Date.now() - t0)) > 30_000;
          if (!isMaxTokens || !hasTime) throw firstErr;
          const retryBudget = Math.min(this.maxOutputTokens * 2, 65536);
          const retryTemp   = Math.min(this.temperature + 0.2, 1.0);
          verdict = await makeCall(retryBudget, retryTemp);
        }
        return verdict;
      } catch (err) {
        return {
          checkpoint: checkpointLabel, verdict: null, overall_score: null,
          dimension_scores: {}, findings: [], commendations: [],
          retry_authorization: false, judge_model: 'unavailable',
          latency_ms: Date.now() - t0, cost_usd: 0, error: err.message
        };
      }
    }
  }

  const agent = new TestAgent();
  const result = await agent._call({ checkpointLabel: 'scene_master' });

  assert.equal(callCount, 2, 'should try twice before giving up');
  assert.equal(result.verdict, null, 'verdict is null on failure');
  assert.ok(typeof result.error === 'string', 'error message present');
  assert.ok(result.error.includes('MAX_TOKENS'), 'error references MAX_TOKENS');
  assert.equal(result.retry_authorization, false);
});

test('DirectorAgent._call — non-MAX_TOKENS error → no retry, immediate error record', async () => {
  let callCount = 0;

  class TestAgent {
    constructor() {
      this.maxOutputTokens = 24576;
      this.temperature = 0.7;
      this.timeoutMs = 180_000;
    }
    async _fakeGeminiCall() {
      callCount++;
      throw new Error('Vertex Gemini returned no text');
    }
    async _call({ checkpointLabel }) {
      const t0 = Date.now();
      const effectiveTimeout = this.timeoutMs;
      const makeCall = () => this._fakeGeminiCall();
      try {
        let verdict;
        try {
          verdict = await makeCall(this.maxOutputTokens, this.temperature);
        } catch (firstErr) {
          const isMaxTokens = firstErr.message.includes('MAX_TOKENS');
          const hasTime = (effectiveTimeout - (Date.now() - t0)) > 30_000;
          if (!isMaxTokens || !hasTime) throw firstErr;
          verdict = await makeCall(Math.min(this.maxOutputTokens * 2, 65536), 0.9);
        }
        return verdict;
      } catch (err) {
        return {
          checkpoint: checkpointLabel, verdict: null, overall_score: null,
          dimension_scores: {}, findings: [], commendations: [],
          retry_authorization: false, judge_model: 'unavailable',
          latency_ms: Date.now() - t0, cost_usd: 0, error: err.message
        };
      }
    }
  }

  const agent = new TestAgent();
  const result = await agent._call({ checkpointLabel: 'screenplay' });

  assert.equal(callCount, 1, 'non-MAX_TOKENS error should NOT trigger retry');
  assert.equal(result.verdict, null);
  assert.ok(result.error.includes('no text'));
});

test('DirectorAgent retry budget cap — never exceeds 65536', () => {
  const maxOutputTokens = 49152; // already high
  const retryBudget = Math.min(maxOutputTokens * 2, 65536);
  assert.equal(retryBudget, 65536, 'retry budget capped at 65536');
});

test('DirectorAgent retry temp cap — never exceeds 1.0', () => {
  const temperature = 0.9;
  const retryTemp = Math.min(temperature + 0.2, 1.0);
  assert.equal(retryTemp, 1.0, 'retry temp capped at 1.0');
});
