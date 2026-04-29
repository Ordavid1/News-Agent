// tests/v4/VerdictSizeCanary.test.mjs
// V4 P1.1 — Verdict-size canary.
//
// Background. DirectorAgent.js documents (lines 60-143) that Vertex Gemini's
// thinking-budget settings work AT THE LIMIT — current settings (8192 budget,
// schema-locked verdict, retry doubling on MAX_TOKENS) leave a margin of ~630
// visible tokens before truncation. One schema regression that adds a few
// dimensions or expands the action enum could push verdict size past the
// budget, breaking Lens C silently. This canary fails the build before that
// regression ships.
//
// Strategy. Each rubric's schema defines a closed set of fields with bounded
// max sizes. We synthesize a worst-case-realistic verdict (max-length values
// in every field, 3 critical findings with full prompt_deltas, max
// commendations) and assert the JSON-stringified payload stays under a
// conservative budget. Token count is approximated as ceil(chars / 3.5)
// (BPE-typical ratio for English/structured-JSON content).
//
// Run: node --test tests/v4/VerdictSizeCanary.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCREENPLAY_VERDICT_SCHEMA,
  SCENE_MASTER_VERDICT_SCHEMA,
  BEAT_VERDICT_SCHEMA,
  EPISODE_VERDICT_SCHEMA,
  COMMERCIAL_BRIEF_VERDICT_SCHEMA,
  COMMERCIAL_EPISODE_VERDICT_SCHEMA,
  COMMERCIAL_SCREENPLAY_VERDICT_SCHEMA,
  COMMERCIAL_SCENE_MASTER_VERDICT_SCHEMA,
  COMMERCIAL_BEAT_VERDICT_SCHEMA
} from '../../services/v4/director-rubrics/verdictSchema.mjs';

// Visible-token budget. Vertex Gemini's worst observed margin (per
// DirectorAgent.js comments) is ~630 visible tokens at the 8192 thinking
// budget. We canary at 1000 tokens (margin) — schemas that approach this
// threshold should split into sub-rubrics rather than expand.
const TOKEN_BUDGET = 1000;

// Crude token estimate. JSON content with no whitespace averages ~3.5 chars
// per BPE token in production verdicts (sampled from logs.txt 2026-04-*).
function estimateTokens(jsonString) {
  return Math.ceil(jsonString.length / 3.5);
}

// Synthesize a worst-case-realistic verdict body for a given rubric schema.
// Fills every dimension with a plausible high score, packs 3 critical findings
// each with a full remediation block, and 2 commendations. This is the upper
// bound the judge could realistically emit while staying inside the schema.
function synthesizeWorstCase(schema, checkpointValue) {
  const dimensionKeys = Object.keys(schema.properties.dimension_scores.properties);
  const dimensionScores = Object.fromEntries(dimensionKeys.map(k => [k, 78]));

  const longEvidence = 'Detailed evidence string: '.repeat(8).slice(0, 240);
  const longMessage = 'Concrete failure description with film/scene reference '.repeat(3).slice(0, 200);
  const longPromptDelta = 'Generator-actionable remediation with cinematography directive: '.repeat(3).slice(0, 220);

  const finding = (i) => ({
    id: `worst_case_finding_${i}_with_descriptive_id_string`,
    severity: 'critical',
    scope: 'beat',
    message: longMessage,
    evidence: longEvidence,
    remediation: {
      action: 'regenerate_beat',
      prompt_delta: longPromptDelta,
      target_fields: ['action_prompt', 'visual_direction', 'camera_notes'],
      target: 'composition'
    }
  });

  const verdict = {
    checkpoint: checkpointValue,
    verdict: 'soft_reject',
    overall_score: 62,
    dimension_scores: dimensionScores,
    findings: [finding(1), finding(2), finding(3)],
    commendations: [
      'Excellent visual signature on the opening — anchors the spot',
      'Tagline land in final 2s feels earned by the buildup'
    ],
    retry_authorization: true,
    judge_model: 'gemini-3-flash-preview',
    latency_ms: 12_345,
    cost_usd: 0.0042
  };
  return verdict;
}

const RUBRICS = [
  ['SCREENPLAY', SCREENPLAY_VERDICT_SCHEMA, 'screenplay'],
  ['SCENE_MASTER', SCENE_MASTER_VERDICT_SCHEMA, 'scene_master'],
  ['BEAT', BEAT_VERDICT_SCHEMA, 'beat'],
  ['EPISODE', EPISODE_VERDICT_SCHEMA, 'episode'],
  ['COMMERCIAL_BRIEF', COMMERCIAL_BRIEF_VERDICT_SCHEMA, 'commercial_brief'],
  ['COMMERCIAL_EPISODE', COMMERCIAL_EPISODE_VERDICT_SCHEMA, 'commercial_episode'],
  ['COMMERCIAL_SCREENPLAY', COMMERCIAL_SCREENPLAY_VERDICT_SCHEMA, 'commercial_screenplay'],
  ['COMMERCIAL_SCENE_MASTER', COMMERCIAL_SCENE_MASTER_VERDICT_SCHEMA, 'commercial_scene_master'],
  ['COMMERCIAL_BEAT', COMMERCIAL_BEAT_VERDICT_SCHEMA, 'commercial_beat']
];

for (const [name, schema, checkpointValue] of RUBRICS) {
  test(`worst-case ${name} verdict fits within ${TOKEN_BUDGET}-token budget`, () => {
    const worstCase = synthesizeWorstCase(schema, checkpointValue);
    const json = JSON.stringify(worstCase);
    const tokens = estimateTokens(json);
    assert.ok(
      tokens <= TOKEN_BUDGET,
      `${name}: worst-case verdict is ~${tokens} tokens (${json.length} chars), exceeds budget ${TOKEN_BUDGET}. ` +
      `Schema may have grown beyond Vertex's visible-token margin. Consider splitting into sub-rubrics.`
    );
  });
}

test('every rubric schema has a propertyOrdering matching required fields', () => {
  // Vertex AI relies on propertyOrdering to control emission sequence.
  // If a future PR adds a property without updating propertyOrdering, the
  // model's output may drop fields silently — schema drift. Catch it here.
  for (const [name, schema] of RUBRICS) {
    assert.ok(Array.isArray(schema.propertyOrdering),
      `${name}: schema must declare propertyOrdering`);
    assert.ok(schema.propertyOrdering.length > 0,
      `${name}: propertyOrdering must be non-empty`);
    // Every required field must appear in propertyOrdering
    for (const requiredField of (schema.required || [])) {
      assert.ok(
        schema.propertyOrdering.includes(requiredField),
        `${name}: required field "${requiredField}" missing from propertyOrdering`
      );
    }
  }
});

test('every rubric has integer-only dimension_scores (locked range 0-100)', () => {
  // The integer constraint at verdictSchema.mjs prevents Vertex from emitting
  // verbose prose values. If a rubric ever drops this constraint, verdict
  // sizes balloon unpredictably. Canary the constraint.
  for (const [name, schema] of RUBRICS) {
    const dimsSchema = schema.properties.dimension_scores;
    for (const [dim, dimSchema] of Object.entries(dimsSchema.properties)) {
      assert.equal(dimSchema.type, 'integer',
        `${name}.dimension_scores.${dim}: must be integer (verbose prose breaks token budget)`);
      assert.equal(dimSchema.minimum, 0, `${name}.${dim}: minimum must be 0`);
      assert.equal(dimSchema.maximum, 100, `${name}.${dim}: maximum must be 100`);
    }
  }
});
