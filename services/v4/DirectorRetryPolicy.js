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

// V4 P4.3 — Structural-defect detection.
//
// Before P4.3 this was an id allowlist (wrong_persona_cast,
// subject_missing_from_frame, genre_mismatch_unfixable, etc.) — but no
// rubric ever emitted those exact ids, so the gate was dormant. The plan
// audit confirmed: zero matches across all rubrics + tests.
//
// Canonical signal post-P4.3 is `remediation.action === 'user_review'`
// (a closed enum value from verdictSchema.mjs). The judge already uses
// this action to mean "this is unfixable by retry — escalate to user".
// We honor that signal instead of trying to match free-form id strings.
//
// The id allowlist remains as a defensive belt-AND-suspenders — if a
// future rubric DOES emit one of these literal ids, it still triggers
// escalation. But the primary gate is the action.
const STRUCTURAL_DEFECT_IDS = new Set([
  // Known unfixable-by-retry markers. Rubrics may emit these as
  // findings[*].id when the verdict carries remediation.action='user_review';
  // including them here makes the legacy id-based check defensive.
  'wrong_persona_cast',
  'subject_missing_from_frame',
  'genre_mismatch_unfixable',
  'persona_identity_unrecoverable',
  'safety_violation',
  // V4 P0.4 + Wave 6 — visual-anchor inversion is hard-halt by design.
  'identity_unrecoverable',
  'visual_anchor_inversion'
]);

// 2026-05-05 — Rec 1 + Rec 3 Phase A + Rec 4 wiring.
//
// Per-dimension auto-fix thresholds. When a verdict comes back as
// `pass` / `pass_with_notes` but specific dimension scores are below
// these thresholds, escalate the verdict to `soft_reject` so the existing
// retry machinery fires automatically. This closes the loop on:
//   • camera_move_motivation (Rec 4) — Phantom Thread textbook camera grammar
//   • audio_coherence_episode (Rec 3 Phase A)
//   • dB_consistency_inter_beat (Rec 3 Phase A)
//   • sfx_motivation_coherence (Rec 3 Phase A)
//   • sound_design_intent_match (Rec 3 Phase A)
//   • spectral_anchor_adherence (Rec 3 Phase A)
//   • no_fly_list_violations (Rec 3 Phase A — stricter at 75; any violation is bad)
//
// Without this, a beat that scores 50/100 on camera_move_motivation but
// 80+ on every other dimension would yield `pass_with_notes` (overall ~70-75)
// and never trigger regen — the bug the Director Agent verdict was designed
// to catch would persist quietly. With this, each named dimension gates
// independently of overall_score.
//
// Thresholds are chosen pessimistically (60 = "noticeable craft failure";
// 75 for no_fly_list because any audible violation is unacceptable).
//
// Per-checkpoint budget cap (1 retry) and nudge_to_brief_ratio runaway guard
// (1.5×) still apply — escalation here doesn't bypass those safeguards.
//
// Opt-out: BRAND_STORY_DIMENSION_THRESHOLD_ESCALATION=false
const DIMENSION_THRESHOLDS = Object.freeze({
  // Beat-level (Rec 4)
  camera_move_motivation: 60,
  // Episode-level audio (Rec 3 Phase A)
  audio_coherence_episode: 60,
  dB_consistency_inter_beat: 60,
  sfx_motivation_coherence: 60,
  sound_design_intent_match: 60,
  spectral_anchor_adherence: 60,
  no_fly_list_violations: 75
});

// Map dimension → remediation.target class (used by the auto-fix dispatcher
// in BrandStoryService to pick the cheapest re-render path). Audio dims map
// to 'continuity' (the closest existing target — "world-level coherence");
// camera dims map to 'composition' (single-beat re-render with framing patch).
// `style` is reserved for commercial style-category drift; not used here.
const DIMENSION_TARGET_MAP = Object.freeze({
  camera_move_motivation: 'composition',
  audio_coherence_episode: 'continuity',
  dB_consistency_inter_beat: 'continuity',
  sfx_motivation_coherence: 'continuity',
  sound_design_intent_match: 'continuity',
  spectral_anchor_adherence: 'continuity',
  no_fly_list_violations: 'continuity'
});

// Per-dimension prompt_delta for the synthesized finding. These splice
// directly into the next-attempt prompt as the auto-fix nudge. Keep tight
// (≤ 120 chars per the verdictSchema.mjs prompt_delta cap).
const DIMENSION_PROMPT_DELTAS = Object.freeze({
  camera_move_motivation:
    'Set camera_motivation_reason explicitly — name the EMOTIONAL TURN this move serves (revelation/intimacy/surprise), not the move itself.',
  audio_coherence_episode:
    'Tighten sonic_world inheritance — base_palette must hold across all scenes; spectral_anchor must be audible at every scene boundary.',
  dB_consistency_inter_beat:
    'Equalize per-beat loudness — episode-level loudnorm pass; reduce inter-beat dB jumps to ≤ 3 LUFS variance.',
  sfx_motivation_coherence:
    'Align foley events to actual frame of impact (footstep on stride, glass clink on touch); cut orphaned SFX unrelated to beat action.',
  sound_design_intent_match:
    'Realize the music_bed_intent / music_composition_plan literally — match instrumentation, mood arc, and prohibited_instruments respect.',
  spectral_anchor_adherence:
    'Spectral anchor (LF + HF presence) must NOT drop below -22dB in any 500ms window; sustain across every cut.',
  no_fly_list_violations:
    'Remove SonicSeriesBible.no_fly_list violations — prohibited instruments / tropes / frequencies are hard-banned in the mix.'
});

/**
 * 2026-05-05 — Rec 1+3+4 wiring.
 *
 * Inspect verdict.dimension_scores for low values against DIMENSION_THRESHOLDS.
 * When at least one dimension is below threshold AND the verdict isn't
 * already a hard reject, escalate to soft_reject and synthesize critical
 * findings so the retry machinery has prompt_deltas to splice.
 *
 * Mutates a copy of the verdict — input is not modified. Returns the
 * possibly-escalated verdict (always returns a non-null object for
 * non-null inputs; passes through nulls for the no-verdict path).
 *
 * Opt-out via env: BRAND_STORY_DIMENSION_THRESHOLD_ESCALATION=false
 */
export function escalateVerdictOnLowDimensions(verdict) {
  if (!verdict || typeof verdict !== 'object') return verdict;
  if (String(process.env.BRAND_STORY_DIMENSION_THRESHOLD_ESCALATION || 'true').toLowerCase() === 'false') {
    return verdict;
  }
  // Already a reject — don't downgrade further.
  if (verdict.verdict === 'hard_reject' || verdict.verdict === 'soft_reject') return verdict;

  const scores = verdict.dimension_scores || {};
  const lowDims = [];
  for (const [dim, threshold] of Object.entries(DIMENSION_THRESHOLDS)) {
    const score = scores[dim];
    if (typeof score === 'number' && score < threshold) {
      lowDims.push({ dim, score, threshold });
    }
  }
  if (lowDims.length === 0) return verdict;

  // Build a shallow copy of the verdict and synthesize findings for each
  // low dimension that doesn't already have a critical finding. We don't
  // overwrite existing findings — just add the synthesized ones the rubric
  // omitted but the score implies.
  const escalated = { ...verdict, findings: Array.isArray(verdict.findings) ? [...verdict.findings] : [] };
  // Keep the cap at 3 (verdictSchema.mjs maxItems on findings).
  const remainingFindingsBudget = Math.max(0, 3 - escalated.findings.length);
  const dimsToEmit = lowDims.slice(0, remainingFindingsBudget);

  for (const { dim, score, threshold } of dimsToEmit) {
    const target = DIMENSION_TARGET_MAP[dim] || 'composition';
    const promptDelta = DIMENSION_PROMPT_DELTAS[dim] || `Improve ${dim} (scored ${score}/${threshold} threshold).`;
    escalated.findings.push({
      id: `${dim}_below_threshold`,
      severity: 'critical',
      scope: verdict.checkpoint === 'episode' ? 'episode' : (escalated.findings[0]?.scope || 'episode'),
      message: `${dim} scored ${score}/100, below auto-fix threshold ${threshold}.`,
      evidence: `dimension_scores.${dim}=${score}`,
      remediation: {
        action: dim.startsWith('camera_') ? 'regenerate_beat' : 'reassemble',
        prompt_delta: promptDelta.slice(0, 120),
        target_fields: [dim],
        target
      }
    });
  }

  // Escalate to soft_reject so decideRetry's retry path fires.
  escalated.verdict = 'soft_reject';

  // Surface the dimension override on a top-level property so observers
  // (Director Panel, logs) can see WHY the verdict was escalated.
  escalated._dimension_threshold_escalation = {
    triggered_by: lowDims.map(d => `${d.dim}=${d.score}/${d.threshold}`),
    original_verdict: verdict.verdict,
    original_overall_score: verdict.overall_score
  };

  return escalated;
}

/**
 * True if this finding is "structural" (cannot be fixed by retry — must escalate).
 * Primary signal: remediation.action === 'user_review' (verdictSchema enum).
 * Secondary: legacy id allowlist (defensive).
 */
function isStructuralDefect(finding) {
  if (!finding) return false;
  if (finding.remediation?.action === 'user_review') return true;
  return STRUCTURAL_DEFECT_IDS.has(finding.id);
}

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
export function decideRetry(params = {}) {
  const {
    verdict,
    checkpoint,
    artifactKey = null,
    retriesState = {},
    // V4 Wave 6 / F6 — original brief is the artifact's effective directive
    // before any auto-fix nudges are spliced. For beats this is typically the
    // composed `prompt + dialogue + scene_visual_anchor_prompt + visual_style_prefix`
    // that flowed through to the generator on the FIRST pass. We compare the
    // proposed nudge mass against this baseline; when nudge mass exceeds
    // BRAND_STORY_NUDGE_RUNAWAY_THRESHOLD × brief mass (default 1.5×), the
    // auto-fix loop is working AGAINST quality — escalate immediately rather
    // than stack more nudges.
    originalBrief = ''
  } = params;
  // 2026-05-05 — Rec 1+3+4 wiring. Pre-escalate the verdict when specific
  // dimensions score below auto-fix thresholds. This converts a "pass" or
  // "pass_with_notes" verdict into a "soft_reject" when craft-critical
  // dimensions like camera_move_motivation or audio_coherence_episode are
  // below the bar — closing the loop on the new rubric dimensions added
  // with Recs 1, 3 Phase A, and 4. Idempotent (no-op when no low dims;
  // no-op when already a reject).
  const v = escalateVerdictOnLowDimensions(verdict) || {};
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

  // V4 Phase 5b — Fix 8. Hard-reject auto-fix on first encounter.
  // V4 hotfix 2026-05-01: default flipped from 'false' to 'true' (user-confirmed).
  // Rationale: the auto-fix path is bounded (1 attempt per beat, anti-runaway
  // nudge_to_brief_ratio guard at 1.5×), so always-on is safer than
  // always-halt. Set BRAND_STORY_AUTOFIX_BEAT_HARDREJECT=false to disable.
  //
  // First hard_reject on a beat (within budget) → ONE auto-fix attempt
  //   using the verdict's findings + remediation.target taxonomy. The
  //   orchestrator (BrandStoryService) reads `nudgePromptDelta` and
  //   `targetClass` from this decision and dispatches per-class.
  // Second hard_reject (budget exhausted) → escalate (no infinite loops).
  if (verdictValue === 'hard_reject') {
    const autofixOptIn =
      String(process.env.BRAND_STORY_AUTOFIX_BEAT_HARDREJECT || 'true').toLowerCase() !== 'false';
    const autofixCommercial = !!params.isCommercialStory;
    const autofixEnabled = autofixOptIn || autofixCommercial;
    if (!autofixEnabled || checkpoint !== 'beat') {
      return {
        shouldRetry: false,
        shouldEscalate: true,
        reason: 'hard_reject — escalate to user_review',
        nudgePromptDelta: '',
        nextRetriesState: retriesState
      };
    }

    // Structural defects bypass auto-fix on hard_reject (same as soft_reject).
    const structuralHard = findings.filter(isStructuralDefect);
    if (structuralHard.length > 0) {
      return {
        shouldRetry: false,
        shouldEscalate: true,
        reason: `hard_reject + structural defect(s): ${structuralHard.map(f => f.id).join(', ')} — escalate`,
        nudgePromptDelta: '',
        nextRetriesState: retriesState
      };
    }

    // Budget check (per-beat cap = 1).
    const usedSoFarHard = _readRetryCount(retriesState, checkpoint, artifactKey);
    if (usedSoFarHard >= (BUDGETS[checkpoint] ?? 1)) {
      return {
        shouldRetry: false,
        shouldEscalate: true,
        reason: `hard_reject + auto-fix budget exhausted (used ${usedSoFarHard}/${BUDGETS[checkpoint] ?? 1}) — escalate`,
        nudgePromptDelta: '',
        nextRetriesState: retriesState
      };
    }

    // Authorize ONE auto-fix attempt. Resolve the dominant remediation
    // target across all critical findings. Caller routes per class.
    const findingTargets = findings
      .filter(f => f.severity === 'critical')
      .map(f => f.remediation?.target)
      .filter(Boolean);
    // Prefer the most-cited class. Tie-break order:
    // anchor > identity > continuity > composition > performance.
    const TARGET_PRIORITY = ['anchor', 'identity', 'continuity', 'composition', 'performance'];
    const counts = {};
    findingTargets.forEach(t => { counts[t] = (counts[t] || 0) + 1; });
    let dominantTarget = null;
    let bestScore = -1;
    for (const t of TARGET_PRIORITY) {
      const c = counts[t] || 0;
      if (c > bestScore) {
        bestScore = c;
        dominantTarget = c > 0 ? t : dominantTarget;
      }
    }
    // Fallback when Director didn't classify: treat as composition (single-beat
    // re-render with patched framing — cheapest non-anchor path).
    const targetClass = dominantTarget || 'composition';

    const criticalDeltasHard = findings
      .filter(f => f.severity === 'critical' && f.remediation?.prompt_delta)
      .map(f => `[${f.id}] ${f.remediation.prompt_delta}`)
      .slice(0, 3);

    // V4 Wave 6 / F6 — compute nudge_to_brief_ratio. When the cumulative
    // nudge mass exceeds the original brief mass × threshold, escalate
    // instead of retrying — auto-fix is no longer composing additively
    // with the brief, it's drowning it.
    const nudgeJoinedHard = criticalDeltasHard.join('\n\n');
    const nudgeRatioHard = _computeNudgeRatio(nudgeJoinedHard, originalBrief);
    const runawayThreshold = Number(process.env.BRAND_STORY_NUDGE_RUNAWAY_THRESHOLD || '1.5');
    if (nudgeRatioHard > runawayThreshold) {
      return {
        shouldRetry: false,
        shouldEscalate: true,
        reason: `hard_reject + nudge_to_brief_ratio=${nudgeRatioHard.toFixed(2)} exceeds runaway threshold ${runawayThreshold} — escalate (auto-fix exhausted: nudge mass exceeded brief mass)`,
        nudgePromptDelta: '',
        nudgeToBriefRatio: nudgeRatioHard,
        nextRetriesState: retriesState
      };
    }

    return {
      shouldRetry: true,
      shouldEscalate: false,
      reason: `hard_reject + auto-fix authorized (target=${targetClass}, ${criticalDeltasHard.length} critical nudge(s), nudge_ratio=${nudgeRatioHard.toFixed(2)})`,
      nudgePromptDelta: nudgeJoinedHard,
      nudgeToBriefRatio: nudgeRatioHard,
      targetClass,
      nextRetriesState: _incrementRetry(retriesState, checkpoint, artifactKey)
    };
  }

  // soft_reject path — check structural defects first.
  const structural = findings.filter(isStructuralDefect);
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

  // V4 Wave 6 / F6 — soft_reject path also gets the nudge_to_brief_ratio
  // anti-runaway guard. Same threshold as the hard_reject path.
  const runawayThresholdSoft = Number(process.env.BRAND_STORY_NUDGE_RUNAWAY_THRESHOLD || '1.5');

  if (criticalDeltas.length === 0) {
    // soft_reject without any critical finding (overall_score 50-69 only) —
    // we authorize retry but the nudge is built from the full message bodies.
    const noteDeltas = findings
      .filter(f => f.remediation?.prompt_delta)
      .map(f => `[${f.id}] ${f.remediation.prompt_delta}`)
      .slice(0, 3); // cap at 3 to keep prompt size sane
    const nudgeJoinedNotes = noteDeltas.join('\n\n');
    const nudgeRatioNotes = _computeNudgeRatio(nudgeJoinedNotes, originalBrief);
    if (nudgeRatioNotes > runawayThresholdSoft) {
      return {
        shouldRetry: false,
        shouldEscalate: true,
        reason: `soft_reject + nudge_to_brief_ratio=${nudgeRatioNotes.toFixed(2)} exceeds runaway threshold ${runawayThresholdSoft} — escalate`,
        nudgePromptDelta: '',
        nudgeToBriefRatio: nudgeRatioNotes,
        nextRetriesState: retriesState
      };
    }
    return {
      shouldRetry: true,
      shouldEscalate: false,
      reason: `soft_reject (no critical findings) — retry with ${noteDeltas.length} nudge(s) (nudge_ratio=${nudgeRatioNotes.toFixed(2)})`,
      nudgePromptDelta: nudgeJoinedNotes,
      nudgeToBriefRatio: nudgeRatioNotes,
      nextRetriesState: _incrementRetry(retriesState, checkpoint, artifactKey)
    };
  }

  const nudgeJoinedCrit = criticalDeltas.join('\n\n');
  const nudgeRatioCrit = _computeNudgeRatio(nudgeJoinedCrit, originalBrief);
  if (nudgeRatioCrit > runawayThresholdSoft) {
    return {
      shouldRetry: false,
      shouldEscalate: true,
      reason: `soft_reject + nudge_to_brief_ratio=${nudgeRatioCrit.toFixed(2)} exceeds runaway threshold ${runawayThresholdSoft} — escalate`,
      nudgePromptDelta: '',
      nudgeToBriefRatio: nudgeRatioCrit,
      nextRetriesState: retriesState
    };
  }
  return {
    shouldRetry: true,
    shouldEscalate: false,
    reason: `soft_reject — retry with ${criticalDeltas.length} critical nudge(s) (nudge_ratio=${nudgeRatioCrit.toFixed(2)})`,
    nudgePromptDelta: nudgeJoinedCrit,
    nudgeToBriefRatio: nudgeRatioCrit,
    nextRetriesState: _incrementRetry(retriesState, checkpoint, artifactKey)
  };
}

/**
 * V4 Wave 6 / F6 — compute nudge_to_brief_ratio.
 *
 * Returns 0 when originalBrief is empty/missing (caller didn't pass it; we
 * can't measure ratio so we don't trip the runaway guard). Returns Infinity
 * if the brief is shorter than 20 chars (defensive — micro-briefs are
 * pathological and would inflate the ratio meaninglessly).
 */
function _computeNudgeRatio(nudge, brief) {
  const nudgeLen = (nudge || '').length;
  const briefLen = (brief || '').length;
  if (briefLen < 20) return 0;  // can't measure → don't gate
  return nudgeLen / briefLen;
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
// 2026-05-05 — exported for tests + Director Panel surfacing.
export { DIMENSION_THRESHOLDS, DIMENSION_TARGET_MAP, DIMENSION_PROMPT_DELTAS };
