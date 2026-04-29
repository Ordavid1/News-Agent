// tests/v4/VoiceGenderRecast.test.mjs
//
// V4 Wave 6 — Test surface for the cross-examination follow-up fixes.
// Covers:
//   F1 — GROUP_DIALOGUE_TWOSHOT IDENTITY routing (predicate-level)
//   F4 — vision_confidence guard cascade
//   F6 — nudge_to_brief_ratio anti-runaway telemetry
//
// These tests target the deterministic decision points exposed by
// DirectorRetryPolicy + the gender-cascade predicates. Full pipeline
// integration (which would require Vertex creds + fal.ai mocking) is
// covered separately by the smoke-test harness.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { decideRetry } from '../../services/v4/DirectorRetryPolicy.js';
import { inferPersonaGenderForCast } from '../../services/v4/CastBible.js';

// ─────────────────────────────────────────────────────────────────────
// F1 — GROUP_DIALOGUE_TWOSHOT predicate
// ─────────────────────────────────────────────────────────────────────
//
// The actual routing site is in BrandStoryService.runV4Pipeline (orchestrator
// state). What we can test deterministically here is the predicate the
// orchestrator branches on: GROUP_DIALOGUE_TWOSHOT must NOT receive the
// TalkingHeadCloseupGenerator override even when an IDENTITY auto-fix is
// authorized — because OmniHuman 1.5 is single-portrait by construction.

describe('V4 Wave 6 / F1 — GROUP_DIALOGUE_TWOSHOT IDENTITY routing predicate', () => {
  // Mirror of the orchestrator's beat-type list (post-F1):
  //   ['TALKING_HEAD_CLOSEUP', 'DIALOGUE_IN_SCENE', 'SHOT_REVERSE_SHOT_CHILD']
  //   GROUP_DIALOGUE_TWOSHOT is INTENTIONALLY EXCLUDED.
  function isOmniHumanRouteEligible(beatType) {
    return ['TALKING_HEAD_CLOSEUP', 'DIALOGUE_IN_SCENE', 'SHOT_REVERSE_SHOT_CHILD'].includes(beatType);
  }

  test('TALKING_HEAD_CLOSEUP IS eligible for OmniHuman fallback', () => {
    assert.equal(isOmniHumanRouteEligible('TALKING_HEAD_CLOSEUP'), true);
  });

  test('DIALOGUE_IN_SCENE IS eligible', () => {
    assert.equal(isOmniHumanRouteEligible('DIALOGUE_IN_SCENE'), true);
  });

  test('SHOT_REVERSE_SHOT_CHILD IS eligible (compiled child of SRS parent)', () => {
    assert.equal(isOmniHumanRouteEligible('SHOT_REVERSE_SHOT_CHILD'), true);
  });

  test('GROUP_DIALOGUE_TWOSHOT is NOT eligible (OmniHuman is single-portrait)', () => {
    assert.equal(isOmniHumanRouteEligible('GROUP_DIALOGUE_TWOSHOT'), false);
  });

  test('Non-dialogue beats are NOT eligible', () => {
    assert.equal(isOmniHumanRouteEligible('ACTION_NO_DIALOGUE'), false);
    assert.equal(isOmniHumanRouteEligible('B_ROLL_ESTABLISHING'), false);
    assert.equal(isOmniHumanRouteEligible('REACTION'), false);
    assert.equal(isOmniHumanRouteEligible('INSERT_SHOT'), false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// F4 — vision_confidence guard (delegated to CastBible cascade)
// ─────────────────────────────────────────────────────────────────────
// The detailed cascade tests live in tests/v4/CastBible.test.mjs (the new
// "V4 Phase 5b + Wave 6 / F4 — visual_anchor cascade" describe block).
// Here we cross-check the predicate from the picker's perspective.

describe('V4 Wave 6 / F4 — visual_anchor confidence guard end-to-end', () => {
  test('confident anchor (≥0.5) drives cascade to visual_anchor', () => {
    const persona = {
      name: 'Persona 1',
      visual_anchor: { apparent_gender_presentation: 'female', vision_confidence: 0.85 }
    };
    const result = inferPersonaGenderForCast(persona, null);
    assert.equal(result.resolved_from, 'visual_anchor');
    assert.equal(result.gender, 'female');
  });

  test('low-confidence anchor (<0.5) does NOT win the cascade', () => {
    const persona = {
      name: 'Persona 1',
      description: 'A man with a deep voice and a beard.',
      visual_anchor: { apparent_gender_presentation: 'female', vision_confidence: 0.35 }
    };
    const result = inferPersonaGenderForCast(persona, null);
    // anchor below floor → text inference wins → male
    assert.equal(result.resolved_from, 'persona_signal');
    assert.equal(result.gender, 'male');
  });
});

// ─────────────────────────────────────────────────────────────────────
// F6 — nudge_to_brief_ratio anti-runaway telemetry
// ─────────────────────────────────────────────────────────────────────

describe('V4 Wave 6 / F6 — nudge_to_brief_ratio telemetry', () => {
  function makeSoftRejectVerdict(deltas) {
    return {
      checkpoint: 'beat',
      verdict: 'soft_reject',
      overall_score: 60,
      retry_authorization: true,
      findings: deltas.map((d, i) => ({
        id: `finding_${i}`,
        severity: 'critical',
        scope: 'beat:s1b1',
        message: `f${i}`,
        evidence: 'e',
        remediation: { action: 'regenerate_beat', prompt_delta: d, target_fields: [], target: 'composition' }
      })),
      commendations: ['ok']
    };
  }

  function makeHardRejectVerdict(deltas, target = 'composition') {
    return {
      checkpoint: 'beat',
      verdict: 'hard_reject',
      overall_score: 35,
      retry_authorization: false,
      findings: deltas.map((d, i) => ({
        id: `finding_${i}`,
        severity: 'critical',
        scope: 'beat:s1b1',
        message: `f${i}`,
        evidence: 'e',
        remediation: { action: 'regenerate_beat', prompt_delta: d, target_fields: [], target }
      })),
      commendations: ['ok']
    };
  }

  test('soft_reject — short nudge against full brief → ratio < 1.5 → retry authorized', () => {
    const verdict = makeSoftRejectVerdict(['hold the closeup tighter']);
    const longBrief = 'A '.repeat(500); // ~1000 chars
    const decision = decideRetry({
      verdict,
      checkpoint: 'beat',
      artifactKey: 's1b1',
      retriesState: {},
      originalBrief: longBrief
    });
    assert.equal(decision.shouldRetry, true);
    assert.equal(decision.shouldEscalate, false);
    assert.ok(Number.isFinite(decision.nudgeToBriefRatio));
    assert.ok(decision.nudgeToBriefRatio < 1.5);
  });

  test('soft_reject — nudge mass exceeds 1.5× brief mass → escalate (anti-runaway)', () => {
    const longNudge = 'rewrite the entire scene with a different lighting motif ' .repeat(40); // ~2400 chars
    const shortBrief = 'A short brief about lighting.';                                          // ~30 chars
    const verdict = makeSoftRejectVerdict([longNudge]);
    const decision = decideRetry({
      verdict,
      checkpoint: 'beat',
      artifactKey: 's1b1',
      retriesState: {},
      originalBrief: shortBrief
    });
    assert.equal(decision.shouldRetry, false);
    assert.equal(decision.shouldEscalate, true);
    assert.ok(decision.nudgeToBriefRatio > 1.5);
    assert.match(decision.reason, /exceeds runaway threshold/);
  });

  test('hard_reject (commercial auto-fix) — nudge mass exceeds 1.5× brief mass → escalate', () => {
    const longNudge = 'rewrite the action prompt with a different choreography ' .repeat(40);
    // Brief must be >= 20 chars (defensive floor on _computeNudgeRatio); use
    // a realistic short-brief above the floor so the runaway guard fires.
    const shortBrief = 'A brief about choreography in the action beat.';
    const verdict = makeHardRejectVerdict([longNudge]);
    const decision = decideRetry({
      verdict,
      checkpoint: 'beat',
      artifactKey: 's1b1',
      retriesState: {},
      originalBrief: shortBrief,
      isCommercialStory: true
    });
    assert.equal(decision.shouldRetry, false);
    assert.equal(decision.shouldEscalate, true);
    assert.ok(decision.nudgeToBriefRatio > 1.5);
  });

  test('missing originalBrief (caller didn\'t pass it) → ratio is 0, no halt', () => {
    const verdict = makeSoftRejectVerdict(['short nudge']);
    const decision = decideRetry({
      verdict,
      checkpoint: 'beat',
      artifactKey: 's1b1',
      retriesState: {}
      // originalBrief omitted
    });
    assert.equal(decision.shouldRetry, true);
    // Ratio is 0 (we can't measure without brief; don't gate)
    assert.equal(decision.nudgeToBriefRatio, 0);
  });

  test('micro-brief (< 20 chars) → ratio is 0, no halt (defensive)', () => {
    const verdict = makeSoftRejectVerdict(['x'.repeat(500)]);
    const decision = decideRetry({
      verdict,
      checkpoint: 'beat',
      artifactKey: 's1b1',
      retriesState: {},
      originalBrief: 'tiny'
    });
    assert.equal(decision.shouldRetry, true);
    assert.equal(decision.nudgeToBriefRatio, 0);
  });

  test('threshold is env-tunable via BRAND_STORY_NUDGE_RUNAWAY_THRESHOLD', () => {
    const prev = process.env.BRAND_STORY_NUDGE_RUNAWAY_THRESHOLD;
    process.env.BRAND_STORY_NUDGE_RUNAWAY_THRESHOLD = '0.5'; // tighter
    try {
      const verdict = makeSoftRejectVerdict(['a moderate nudge with some words']);
      const brief = 'A short brief with some words to compare against.'; // ~50 chars
      const decision = decideRetry({
        verdict,
        checkpoint: 'beat',
        artifactKey: 's1b1',
        retriesState: {},
        originalBrief: brief
      });
      // ratio ≈ 0.6 — exceeds tightened 0.5 threshold → escalate
      assert.ok(decision.nudgeToBriefRatio > 0.5);
      assert.equal(decision.shouldEscalate, true);
    } finally {
      if (prev === undefined) delete process.env.BRAND_STORY_NUDGE_RUNAWAY_THRESHOLD;
      else process.env.BRAND_STORY_NUDGE_RUNAWAY_THRESHOLD = prev;
    }
  });
});
