// services/v4/DirectorRetryPolicy.js
//
// Centralized retry-budget + escalation logic for the V4 Director Agent (L3).
//
// Rules (from .claude/plans/v4-director-agent.md §9):
//
//   per-checkpoint auto-retry budget:
//     screenplay   : 1
//     scene_master : 1 (per scene)
//     beat         : 1 (per beat)
//     episode      : 0 (advisory only — never auto-retries full episodes)
//
//   second failure = hard_reject + user escalation (no infinite loops)
//   structural defects (wrong persona, missing subject, genre mismatch beyond patch)
//     → hard_reject on first encounter, no retry
//
// State lives on the episode row in the `director_report.retries` JSONB:
//   {
//     "screenplay": 0|1,
//     "scene_master": { "<scene_id>": 0|1 },
//     "beat":         { "<beat_id>":  0|1 },
//     "episode":      0
//   }

const BUDGETS = Object.freeze({
  screenplay: 1,
  scene_master: 1,
  beat: 1,
  episode: 0
});

const STRUCTURAL_DEFECT_IDS = new Set([
  'wrong_persona_cast',
  'subject_missing_from_frame',
  'genre_mismatch_unfixable',
  'persona_identity_unrecoverable',
  'safety_violation'
]);

/**
 * Decide whether a soft_reject verdict authorizes one auto-retry, and merge
 * the judge's prompt_deltas into a generator-actionable nudge string.
 *
 * @param {Object} params
 * @param {Object} params.verdict           - the L3 verdict JSON
 * @param {string} params.checkpoint        - 'screenplay' | 'scene_master' | 'beat' | 'episode'
 * @param {string} [params.artifactKey]     - scene_id (for scene_master) or beat_id (for beat); ignored otherwise
 * @param {Object} [params.retriesState]    - current director_report.retries object on the episode row
 * @returns {{
 *   shouldRetry: boolean,
 *   shouldEscalate: boolean,
 *   reason: string,
 *   nudgePromptDelta: string,
 *   nextRetriesState: Object
 * }}
 */
export function decideRetry({
  verdict,
  checkpoint,
  artifactKey = null,
  retriesState = {}
} = {}) {
  const v = verdict || {};
  const findings = Array.isArray(v.findings) ? v.findings : [];
  const verdictValue = v.verdict;

  // Errored verdict (Vertex Gemini failure / truncation / network) — DirectorAgent
  // returns { verdict: null, error: msg } in this case. No real verdict to act
  // on: don't retry, don't escalate. Phase 1 shadow callers persist the error
  // alongside the report for diagnostics; Phase 2+ blocking callers safely
  // skip this artifact rather than spending budget on a non-verdict.
  if (!verdictValue || v.error) {
    return {
      shouldRetry: false,
      shouldEscalate: false,
      reason: v.error
        ? `judge call errored: ${v.error}`
        : 'no verdict value — judge produced no usable output',
      nudgePromptDelta: '',
      nextRetriesState: retriesState
    };
  }

  // Pass / pass_with_notes — never retry, never escalate.
  if (verdictValue === 'pass' || verdictValue === 'pass_with_notes') {
    return {
      shouldRetry: false,
      shouldEscalate: false,
      reason: `verdict=${verdictValue}; no action`,
      nudgePromptDelta: '',
      nextRetriesState: retriesState
    };
  }

  // Hard reject — never retry, always escalate.
  if (verdictValue === 'hard_reject') {
    return {
      shouldRetry: false,
      shouldEscalate: true,
      reason: 'hard_reject — escalate to user_review',
      nudgePromptDelta: '',
      nextRetriesState: retriesState
    };
  }

  // soft_reject path — check structural defects first.
  const structural = findings.filter(f => STRUCTURAL_DEFECT_IDS.has(f.id));
  if (structural.length > 0) {
    return {
      shouldRetry: false,
      shouldEscalate: true,
      reason: `structural defect(s) on soft_reject: ${structural.map(f => f.id).join(', ')} — escalate`,
      nudgePromptDelta: '',
      nextRetriesState: retriesState
    };
  }

  // The verdict's own retry_authorization can disable retry even if budget allows.
  if (v.retry_authorization === false) {
    return {
      shouldRetry: false,
      shouldEscalate: true,
      reason: 'verdict.retry_authorization=false — escalate',
      nudgePromptDelta: '',
      nextRetriesState: retriesState
    };
  }

  // Budget check.
  const budget = BUDGETS[checkpoint] ?? 0;
  if (budget <= 0) {
    return {
      shouldRetry: false,
      shouldEscalate: true,
      reason: `${checkpoint} has no auto-retry budget (advisory-only)`,
      nudgePromptDelta: '',
      nextRetriesState: retriesState
    };
  }

  const usedSoFar = _readRetryCount(retriesState, checkpoint, artifactKey);
  if (usedSoFar >= budget) {
    return {
      shouldRetry: false,
      shouldEscalate: true,
      reason: `auto-retry budget exhausted for ${checkpoint}${artifactKey ? `:${artifactKey}` : ''} (used ${usedSoFar}/${budget})`,
      nudgePromptDelta: '',
      nextRetriesState: retriesState
    };
  }

  // Authorize one retry. Merge prompt_deltas from CRITICAL findings only —
  // warnings and notes are advisory, not retake-worthy on their own.
  const criticalDeltas = findings
    .filter(f => f.severity === 'critical' && f.remediation?.prompt_delta)
    .map(f => `[${f.id}] ${f.remediation.prompt_delta}`)
    .filter(Boolean);

  if (criticalDeltas.length === 0) {
    // soft_reject without any critical finding (overall_score 50-69 only) —
    // we authorize retry but the nudge is built from the full message bodies.
    const noteDeltas = findings
      .filter(f => f.remediation?.prompt_delta)
      .map(f => `[${f.id}] ${f.remediation.prompt_delta}`)
      .slice(0, 3); // cap at 3 to keep prompt size sane
    return {
      shouldRetry: true,
      shouldEscalate: false,
      reason: `soft_reject (no critical findings) — retry with ${noteDeltas.length} nudge(s)`,
      nudgePromptDelta: noteDeltas.join('\n\n'),
      nextRetriesState: _incrementRetry(retriesState, checkpoint, artifactKey)
    };
  }

  return {
    shouldRetry: true,
    shouldEscalate: false,
    reason: `soft_reject — retry with ${criticalDeltas.length} critical nudge(s)`,
    nudgePromptDelta: criticalDeltas.join('\n\n'),
    nextRetriesState: _incrementRetry(retriesState, checkpoint, artifactKey)
  };
}

function _readRetryCount(state, checkpoint, artifactKey) {
  const node = state?.[checkpoint];
  if (node == null) return 0;
  if (typeof node === 'number') return node;
  if (artifactKey && typeof node === 'object') return Number(node[artifactKey] || 0);
  return 0;
}

function _incrementRetry(state, checkpoint, artifactKey) {
  const next = { ...(state || {}) };
  const current = next[checkpoint];
  if (artifactKey) {
    next[checkpoint] = {
      ...(current && typeof current === 'object' ? current : {}),
      [artifactKey]: _readRetryCount(state, checkpoint, artifactKey) + 1
    };
  } else {
    next[checkpoint] = (typeof current === 'number' ? current : 0) + 1;
  }
  return next;
}

export const RETRY_BUDGETS = BUDGETS;
export const STRUCTURAL_DEFECTS = STRUCTURAL_DEFECT_IDS;
