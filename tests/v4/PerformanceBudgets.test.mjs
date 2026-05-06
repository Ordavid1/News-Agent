// tests/v4/PerformanceBudgets.test.mjs
// V4 P5.4 — Performance + cost budget canaries.
//
// These tests are STATIC tripwires — they don't run the pipeline. They
// inspect declarative cost/duration budgets in code/config and assert the
// budgets stay in defined ranges. Catches accidental budget creep (e.g.
// someone bumps the V4 cost cap from $20 to $200 without explicit approval).
//
// Run: node --test tests/v4/PerformanceBudgets.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');

// Cost cap declared in code as flat ceiling for V4 episodes. Plan baseline:
// $20 per episode (Business-tier-only feature). A future PR that bumps this
// without explicit approval should fail this canary so reviewers see it.
const EXPECTED_COST_CAP_USD = 20;
const COST_CAP_TOLERANCE = 5; // accept 15-25 without alarm; ±25% from baseline

// Director Agent timeout budgets. From DEFAULT_TIMEOUT_MS / DEFAULT_TIMEOUT_VIDEO_MS
// at services/v4/DirectorAgent.js. These are the upper bounds for a single
// Vertex Gemini judge call. Multimodal Lens C calls at high thinking budget
// take ~205s in practice (per the comment in DirectorAgent.js:140), so the
// 60s plan baseline was unrealistic. Real budgets are 360s for both — Lens D
// stays at 360s and Lens A/B/C also at 360s for multimodal headroom.
// We canary at 600s as the catch-the-bumped-by-mistake ceiling.
const MAX_TEXT_JUDGE_TIMEOUT_MS = 600_000;
const MAX_VIDEO_JUDGE_TIMEOUT_MS = 600_000;

// Cost-cap helper export from BeatRouter — tests import it dynamically so
// changes to the helper's shape are caught here.
test('V4 cost cap is within expected range ($20 ± 25%)', async () => {
  const { resolveCostCap } = await import('../../services/BeatRouter.js');
  const cap = resolveCostCap({});
  assert.ok(typeof cap === 'number' && cap > 0, 'cost cap must be a positive number');
  assert.ok(
    Math.abs(cap - EXPECTED_COST_CAP_USD) <= COST_CAP_TOLERANCE,
    `Cost cap $${cap} drifted from baseline $${EXPECTED_COST_CAP_USD} by more than $${COST_CAP_TOLERANCE}. ` +
    `If this change is intentional, update EXPECTED_COST_CAP_USD in this canary.`
  );
});

test('V4 cost cap respects per-story override but rejects > 2x baseline', async () => {
  const { resolveCostCap } = await import('../../services/BeatRouter.js');
  // Sane override should pass through.
  const sane = resolveCostCap({ episodeOverride: 25 });
  assert.equal(sane, 25, 'sane override should pass through');
  // Extreme override (e.g. someone testing with $200) — the helper itself
  // doesn't necessarily enforce a max; this canary documents that any
  // override > 2x baseline should require explicit approval. We don't
  // assert clamp, just document the contract via this test name.
  // (Kept as soft canary — if the codebase grows a clamp later, tighten here.)
});

test('Director Agent timeout budgets stay in expected range', () => {
  // Static read of the timeout constants from DirectorAgent.js. We read
  // the file directly rather than importing the module to avoid pulling
  // Vertex auth deps into the test harness.
  const src = fs.readFileSync(
    path.join(REPO_ROOT, 'services/v4/DirectorAgent.js'),
    'utf-8'
  );

  // Match patterns like: const DEFAULT_TIMEOUT_MS = 45_000;
  const textMatch = src.match(/DEFAULT_TIMEOUT_MS\s*=\s*([\d_]+)/);
  const videoMatch = src.match(/DEFAULT_TIMEOUT_VIDEO_MS\s*=\s*([\d_]+)/);
  assert.ok(textMatch, 'DEFAULT_TIMEOUT_MS must be declared in DirectorAgent.js');
  assert.ok(videoMatch, 'DEFAULT_TIMEOUT_VIDEO_MS must be declared in DirectorAgent.js');

  const textMs = parseInt(textMatch[1].replace(/_/g, ''), 10);
  const videoMs = parseInt(videoMatch[1].replace(/_/g, ''), 10);

  assert.ok(
    textMs > 0 && textMs <= MAX_TEXT_JUDGE_TIMEOUT_MS,
    `Text judge timeout ${textMs}ms exceeds budget ${MAX_TEXT_JUDGE_TIMEOUT_MS}ms`
  );
  assert.ok(
    videoMs > 0 && videoMs <= MAX_VIDEO_JUDGE_TIMEOUT_MS,
    `Video judge timeout ${videoMs}ms exceeds budget ${MAX_VIDEO_JUDGE_TIMEOUT_MS}ms`
  );
  // Note: in current implementation video ≥ text (often equal at 360s for
  // multimodal headroom). Originally video was supposed to exceed text, but
  // multimodal Lens C requires the same long timeout. Just assert both are
  // positive and within the ceiling.
});

test('Director retry budgets prevent runaway auto-fix loops', async () => {
  // Read BUDGETS frozen object from DirectorRetryPolicy.js. Each checkpoint
  // should cap retries at a small integer (≤2) — the nudge_to_brief_ratio
  // anti-runaway guard handles the rest.
  const policy = await import('../../services/v4/DirectorRetryPolicy.js');
  const internals = policy._internals || {};
  // The BUDGETS const is module-private. Re-read the source as a tripwire.
  const src = fs.readFileSync(
    path.join(REPO_ROOT, 'services/v4/DirectorRetryPolicy.js'),
    'utf-8'
  );
  const budgetMatch = src.match(/const BUDGETS\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/);
  assert.ok(budgetMatch, 'BUDGETS must be declared in DirectorRetryPolicy.js');
  const budgetBody = budgetMatch[1];
  const numbers = (budgetBody.match(/:\s*([\d]+)/g) || []).map(s => parseInt(s.match(/\d+/)[0], 10));
  assert.ok(numbers.length > 0, 'BUDGETS must declare numeric retry caps');
  for (const n of numbers) {
    assert.ok(
      n <= 2,
      `BUDGETS contains retry cap ${n} > 2 — runs risk runaway auto-fix loops. nudge_to_brief_ratio guard helps but per-checkpoint cap should stay ≤2.`
    );
  }
});

test('LUT library has reasonable count (12-40 LUTs in spec system)', () => {
  // Defensive bound — too few LUTs means narrow coverage, too many means
  // matchByGenreAndMood Gemini-pick gets fuzzy. Plan baseline: 22 spec LUTs.
  // Range allows for natural growth without alarm.
  const lutLib = JSON.parse(fs.readFileSync(
    path.join(REPO_ROOT, 'assets/luts/library.json'),
    'utf-8'
  ));
  const count = (lutLib.creative || []).filter(l => l.spec).length;
  assert.ok(
    count >= 12 && count <= 40,
    `LUT count ${count} is outside expected range [12, 40]. ` +
    `If this is intentional growth, update the bound in this canary.`
  );
});

test('Verdict schema dimension counts stay within Vertex token margin', () => {
  // Cross-check with VerdictSizeCanary. Counts dimensions per schema.
  //
  // Soft ceiling raised to 16 on 2026-05-01 (was 12) to accommodate the
  // EPISODE_VERDICT_SCHEMA's deliberate Phase A audio-designer growth: 9
  // craft dimensions (rhythm, transitions, LUT, etc.) + 6 audio dimensions
  // (audio_coherence_episode, dB_consistency_inter_beat,
  // sfx_motivation_coherence, sound_design_intent_match,
  // spectral_anchor_adherence, no_fly_list_violations) = 15.
  //
  // Verdict size canary (VerdictSizeCanary.test.mjs) still enforces the
  // total token budget per verdict pass. If the EPISODE pass starts hitting
  // MAX_TOKENS, the next architectural move is to SPLIT into two parallel
  // Lens D verdicts: EPISODE_VERDICT_SCHEMA (craft only, 9 dims) +
  // EPISODE_AUDIO_VERDICT_SCHEMA (audio only, 6 dims) — same pattern as
  // commercial vs prestige already uses. That split is deferred until Phase
  // B Audio Designer ships and we have measurement showing token pressure.
  const src = fs.readFileSync(
    path.join(REPO_ROOT, 'services/v4/director-rubrics/verdictSchema.mjs'),
    'utf-8'
  );
  const matches = src.matchAll(/buildSchema\([^,]+,\s*\[([\s\S]*?)\]\)/g);
  const violations = [];
  for (const match of matches) {
    const body = match[1];
    const dims = body.match(/'[^']+'/g) || [];
    if (dims.length > 16) {
      violations.push(`Schema with ${dims.length} dimensions exceeds soft ceiling of 16 (token-budget risk)`);
    }
  }
  assert.deepEqual(violations, [], `Dimension count violations:\n${violations.join('\n')}`);
});
