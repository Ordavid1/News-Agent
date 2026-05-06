// services/v4/BeatLifecycle.js
//
// V4 Tier 1 — Beat Lifecycle Architecture.
//
// The single home for the beat-row lifecycle concern. Owns:
//   • BEAT_STATUS — the canonical enum every beat row's `status` field uses
//   • LIVE_STATUSES — the subset that loaders/reassembly treat as "in the cut"
//   • transition()  — optimistic-concurrency-checked status mutation
//   • quarantineBeat() — moves a hard-rejected video out of the canonical row
//   • promoteFromQuarantine() — restores the most recent quarantined clip when
//                               the user clicks Approve on awaiting_user_review
//
// WHY this lives here and NOT on BaseBeatGenerator:
//   The generator's concern is producing a clip. The lifecycle's concern is
//   tracking which clips are live, which are quarantined, and which attempts
//   ever happened. Coupling them led to four code paths writing raw status
//   strings (`beat.status = 'failed'`, `beat.status = 'awaiting_user_review'`,
//   etc.) with no shared semantics — exactly the lattice that produced the
//   "10-beat reassemble with two s2b4s" symptom (logs.txt 2026-04-30).
//
// Per-beat fields managed here (all live INSIDE scene_description.scenes[].beats[]
// JSONB on `brand_story_episodes` — no top-level columns):
//   beat.status              — one of BEAT_STATUS enum
//   beat.version             — monotonically increasing int, optimistic-concurrency token
//   beat.attempts_log        — append-only array of attempt records (audit + quarantine store)
//   beat.generated_video_url — null when status is in {pending, generating, failed, hard_rejected, superseded}
//   beat.endframe_url        — same null contract as generated_video_url
//
// attempts_log entry shape:
//   {
//     attempt_uuid: string,
//     started_at: ISO timestamp,
//     ended_at:   ISO timestamp | null,
//     status:     final terminal status of this attempt ('generated' | 'failed' | 'hard_rejected'),
//     error_message: string | null,
//     video_url:  string | null,    // canonical: the clip this attempt produced
//     endframe_url: string | null,
//     model_used: string | null,
//     lens_c_verdict: { verdict, overall_score, findings? } | null,
//     reason: string | null         // free-text breadcrumb (e.g. "soft_reject retry exhausted")
//   }

import { randomUUID } from 'node:crypto';

/**
 * Canonical lifecycle states for a single beat row.
 *
 * Transitions (allowed):
 *   pending       → generating
 *   generating    → generated | failed
 *   generated     → ready | hard_rejected | superseded
 *   ready         → hard_rejected | superseded
 *   failed        → generating (retry) | superseded
 *   hard_rejected → ready (user-approve = promote-from-quarantine)
 *                 | generating (user-regenerate from quarantine)
 *                 | superseded (user-regenerate)
 *   superseded    → generating (user-regenerate / Edit & Retry)
 *
 * Note: superseded is NOT terminal — supersedeBeat() snapshots the
 * current take into attempts_log, then a subsequent transition() to
 * generating starts the next attempt. The audit trail lives in
 * attempts_log; the canonical row's status walks forward.
 */
export const BEAT_STATUS = Object.freeze({
  PENDING:       'pending',
  GENERATING:    'generating',
  GENERATED:     'generated',
  READY:         'ready',
  FAILED:        'failed',
  HARD_REJECTED: 'hard_rejected',
  SUPERSEDED:    'superseded'
});

/**
 * The set of statuses that the reassembly + post-production loaders treat as
 * "this beat belongs in the cut." Failed and quarantined work is invisible to
 * assembly — single source of truth for the question "is this beat live?"
 *
 * `generated` = produced and persisted; not yet user-approved or director-approved
 * `ready`     = explicitly approved (Director Lens C pass OR user PATCH from
 *               hard_rejected back to ready)
 *
 * NOTE: `pending`, `generating`, `failed`, `hard_rejected`, `superseded` are
 * all NOT live. A beat in any of those states is invisible to assembly even if
 * `generated_video_url` is somehow non-null (defense in depth — the quarantine
 * contract should have nulled the URL, but the loader doesn't trust that).
 */
export const LIVE_STATUSES = Object.freeze(new Set([
  BEAT_STATUS.GENERATED,
  BEAT_STATUS.READY
]));

/**
 * The subset of statuses that should never have a live `generated_video_url`.
 * Exposed so the ScreenplayValidator (Tier 2.3) can flag the impossible state
 * `status='hard_rejected' AND generated_video_url!==null` as `error` severity.
 */
export const QUARANTINED_STATUSES = Object.freeze(new Set([
  BEAT_STATUS.HARD_REJECTED,
  BEAT_STATUS.SUPERSEDED,
  BEAT_STATUS.FAILED
]));

/**
 * Allowed transition graph. Used by transition() to reject illegal mutations.
 * Keys are the FROM status; values are sets of allowed TO statuses.
 */
const TRANSITIONS = Object.freeze({
  [BEAT_STATUS.PENDING]:       new Set([BEAT_STATUS.GENERATING]),
  [BEAT_STATUS.GENERATING]:    new Set([BEAT_STATUS.GENERATED, BEAT_STATUS.FAILED]),
  [BEAT_STATUS.GENERATED]:     new Set([BEAT_STATUS.READY, BEAT_STATUS.HARD_REJECTED, BEAT_STATUS.SUPERSEDED, BEAT_STATUS.GENERATING]),
  [BEAT_STATUS.READY]:         new Set([BEAT_STATUS.HARD_REJECTED, BEAT_STATUS.SUPERSEDED, BEAT_STATUS.GENERATING]),
  [BEAT_STATUS.FAILED]:        new Set([BEAT_STATUS.GENERATING, BEAT_STATUS.SUPERSEDED]),
  [BEAT_STATUS.HARD_REJECTED]: new Set([BEAT_STATUS.READY, BEAT_STATUS.GENERATING, BEAT_STATUS.SUPERSEDED]),
  // V4 hotfix 2026-05-06 — SUPERSEDED was previously terminal (empty Set),
  // which contradicted both the supersedeBeat() docstring AND
  // BaseBeatGenerator's "Accept GENERATING from any current status
  // (... superseded → next attempt)" comment. Production hit this when
  // the user clicked Edit & Retry on a Lens C beat halt: the auto-retry
  // path called supersedeBeat() during the prior failed attempt, then
  // regenerateBeatInEpisode → BaseBeatGenerator transition('GENERATING')
  // threw "illegal transition 'superseded' → 'generating'". The supersede +
  // re-generate IS the canonical user-regenerate flow; allow it.
  [BEAT_STATUS.SUPERSEDED]:    new Set([BEAT_STATUS.GENERATING])
});

/**
 * Error thrown when a status transition is rejected because the beat's current
 * status doesn't match the caller's expectation (optimistic-concurrency miss),
 * the version is stale, or the transition is not in the allowed graph.
 */
export class BeatLifecycleError extends Error {
  constructor(message, { code, beatId, currentStatus, expectedStatus, currentVersion, expectedVersion } = {}) {
    super(message);
    this.name = 'BeatLifecycleError';
    this.code = code;
    this.beatId = beatId;
    this.currentStatus = currentStatus;
    this.expectedStatus = expectedStatus;
    this.currentVersion = currentVersion;
    this.expectedVersion = expectedVersion;
  }
}

/**
 * Return true when `status` is one a loader treats as live.
 */
export function isLiveStatus(status) {
  return LIVE_STATUSES.has(status);
}

/**
 * Return true when `status` is a known terminal-or-quarantine state.
 */
export function isQuarantinedStatus(status) {
  return QUARANTINED_STATUSES.has(status);
}

/**
 * Return true when `status` is a member of the canonical enum.
 */
export function isKnownStatus(status) {
  return typeof status === 'string'
    && Object.values(BEAT_STATUS).includes(status);
}

/**
 * Initialize lifecycle fields on a freshly-loaded beat row that came from
 * legacy data without them. Safe to call repeatedly — only writes fields that
 * are missing. Use during loader startup so legacy beats join the new contract.
 *
 * @param {Object} beat
 * @returns {Object} the same beat (mutated)
 */
export function ensureLifecycleFields(beat) {
  if (!beat) return beat;
  if (typeof beat.status !== 'string' || beat.status.length === 0) {
    beat.status = beat.generated_video_url ? BEAT_STATUS.GENERATED : BEAT_STATUS.PENDING;
  }
  if (typeof beat.version !== 'number' || !Number.isFinite(beat.version)) {
    beat.version = 0;
  }
  if (!Array.isArray(beat.attempts_log)) {
    beat.attempts_log = [];
  }
  return beat;
}

/**
 * Mutate the beat row's status with optimistic-concurrency enforcement.
 *
 * Validates:
 *   1. `to` is a known status
 *   2. The transition fromStatus → toStatus is allowed by TRANSITIONS graph
 *   3. (Optional) `expectedFrom` matches `beat.status` — rejects mid-flight
 *      transitions made on a stale snapshot
 *   4. (Optional) `expectedVersion` matches `beat.version` — same protection
 *      against lost-update races
 *
 * Side effects:
 *   • beat.status   = to
 *   • beat.version += 1
 *   • beat.updated_at = ISO timestamp
 *
 * NOTE: This mutates the in-memory beat object. The CALLER is responsible for
 * persisting the parent `scene_description` JSONB via `updateBrandStoryEpisode`.
 * That's intentional — the lifecycle layer doesn't know about Supabase.
 *
 * @param {Object} beat
 * @param {string} to - target status from BEAT_STATUS
 * @param {Object} [opts]
 * @param {string} [opts.expectedFrom] - if provided, current beat.status must equal this
 * @param {number} [opts.expectedVersion] - if provided, current beat.version must equal this
 * @returns {Object} the mutated beat
 * @throws {BeatLifecycleError}
 */
export function transition(beat, to, opts = {}) {
  if (!beat) {
    throw new BeatLifecycleError('transition: beat is required', { code: 'no_beat' });
  }
  if (!isKnownStatus(to)) {
    throw new BeatLifecycleError(`transition: unknown target status '${to}'`, {
      code: 'unknown_status',
      beatId: beat.beat_id
    });
  }

  ensureLifecycleFields(beat);

  if (opts.expectedFrom !== undefined && beat.status !== opts.expectedFrom) {
    throw new BeatLifecycleError(
      `transition: status mismatch on beat ${beat.beat_id} — expected '${opts.expectedFrom}', got '${beat.status}'`,
      {
        code: 'status_mismatch',
        beatId: beat.beat_id,
        currentStatus: beat.status,
        expectedStatus: opts.expectedFrom
      }
    );
  }

  if (opts.expectedVersion !== undefined && beat.version !== opts.expectedVersion) {
    throw new BeatLifecycleError(
      `transition: version mismatch on beat ${beat.beat_id} — expected ${opts.expectedVersion}, got ${beat.version}`,
      {
        code: 'version_mismatch',
        beatId: beat.beat_id,
        currentVersion: beat.version,
        expectedVersion: opts.expectedVersion
      }
    );
  }

  const allowed = TRANSITIONS[beat.status] || new Set();
  if (!allowed.has(to)) {
    throw new BeatLifecycleError(
      `transition: illegal transition '${beat.status}' → '${to}' on beat ${beat.beat_id}`,
      {
        code: 'illegal_transition',
        beatId: beat.beat_id,
        currentStatus: beat.status,
        expectedStatus: to
      }
    );
  }

  beat.status = to;
  beat.version = (beat.version || 0) + 1;
  beat.updated_at = new Date().toISOString();
  return beat;
}

/**
 * Append an attempt record to beat.attempts_log. The log is the canonical
 * audit trail AND the quarantine store — the most recent entry whose status
 * is `hard_rejected` is what `promoteFromQuarantine` restores.
 *
 * @param {Object} beat
 * @param {Object} attempt - partial attempt record; missing fields get defaults
 * @returns {Object} the appended record (with attempt_uuid + started_at filled)
 */
export function appendAttemptLog(beat, attempt = {}) {
  if (!beat) throw new BeatLifecycleError('appendAttemptLog: beat is required', { code: 'no_beat' });
  ensureLifecycleFields(beat);

  const record = {
    attempt_uuid: attempt.attempt_uuid || randomUUID(),
    started_at:   attempt.started_at  || new Date().toISOString(),
    ended_at:     attempt.ended_at    || new Date().toISOString(),
    status:       attempt.status      || beat.status,
    error_message: attempt.error_message || null,
    video_url:    attempt.video_url   || null,
    endframe_url: attempt.endframe_url || null,
    model_used:   attempt.model_used  || null,
    lens_c_verdict: attempt.lens_c_verdict || null,
    reason:       attempt.reason      || null
  };
  beat.attempts_log.push(record);
  return record;
}

/**
 * Move a hard-rejected clip out of the canonical row's `generated_video_url`
 * and into beat.attempts_log. The Director's "approve" path can promote it
 * back later via promoteFromQuarantine.
 *
 * Idempotent — safe to call repeatedly. If the beat is already hard_rejected
 * with a null video_url, this is a no-op aside from appending another
 * attempt-log entry (which is the right audit behavior — every escalation
 * gets recorded even if the video state is already correct).
 *
 * @param {Object} beat
 * @param {Object} [opts]
 * @param {Object} [opts.verdict] - the Director Lens C verdict (recorded in attempts_log)
 * @param {string} [opts.reason] - free-text breadcrumb
 * @returns {Object} the mutated beat
 */
export function quarantineBeat(beat, opts = {}) {
  if (!beat) throw new BeatLifecycleError('quarantineBeat: beat is required', { code: 'no_beat' });
  ensureLifecycleFields(beat);

  // Snapshot current video state into the audit log BEFORE we null it out.
  appendAttemptLog(beat, {
    status: BEAT_STATUS.HARD_REJECTED,
    video_url: beat.generated_video_url || null,
    endframe_url: beat.endframe_url || null,
    model_used: beat.model_used || null,
    lens_c_verdict: opts.verdict || null,
    error_message: beat.error_message || null,
    reason: opts.reason || 'director_hard_reject_escalate'
  });

  // Null out the canonical row so reassembly's status-based filter is a
  // double-defense (status filter alone would skip it; nulling video_url
  // means even buggy legacy loaders that ignore status can't pick it up).
  beat.generated_video_url = null;
  beat.endframe_url = null;

  // Transition status. We accept any current status here — the orchestrator
  // can call this from `generated` (most common), `ready` (rare — director
  // re-judged after promotion), or even `failed` (defense in depth).
  if (beat.status !== BEAT_STATUS.HARD_REJECTED) {
    // Direct status mutation (skipping transition's `expectedFrom` check)
    // because the caller's intent is unambiguous: "this clip is bad, mark
    // it so." We still bump version for optimistic-concurrency.
    beat.status = BEAT_STATUS.HARD_REJECTED;
    beat.version = (beat.version || 0) + 1;
    beat.updated_at = new Date().toISOString();
  }

  return beat;
}

/**
 * Restore the most recent quarantined clip back onto the canonical row, mark
 * the beat `ready`, and append a promotion record to the audit log.
 *
 * Used by the user-approve flow on the awaiting_user_review modal: the user
 * looks at the Lens-C-rejected clip, decides it's acceptable, clicks Approve,
 * and the route handler PATCHes `{ status: 'ready' }` — which calls this.
 *
 * Throws if no quarantined attempt with a video_url exists (the user should
 * trigger /regenerate instead in that case).
 *
 * @param {Object} beat
 * @returns {Object} the mutated beat
 * @throws {BeatLifecycleError} when the beat isn't currently quarantined OR
 *                              when attempts_log has no restorable clip
 */
export function promoteFromQuarantine(beat) {
  if (!beat) throw new BeatLifecycleError('promoteFromQuarantine: beat is required', { code: 'no_beat' });
  ensureLifecycleFields(beat);

  if (beat.status !== BEAT_STATUS.HARD_REJECTED) {
    throw new BeatLifecycleError(
      `promoteFromQuarantine: beat ${beat.beat_id} is not in hard_rejected state (got '${beat.status}')`,
      { code: 'not_quarantined', beatId: beat.beat_id, currentStatus: beat.status }
    );
  }

  // Find the most recent attempt with a video_url. Walk the log in reverse so
  // we restore the LAST attempt the user might have rejected, not the first.
  let restorable = null;
  for (let i = beat.attempts_log.length - 1; i >= 0; i--) {
    const attempt = beat.attempts_log[i];
    if (attempt && attempt.video_url) {
      restorable = attempt;
      break;
    }
  }

  if (!restorable) {
    throw new BeatLifecycleError(
      `promoteFromQuarantine: beat ${beat.beat_id} has no quarantined attempt with a video_url — user must regenerate`,
      { code: 'no_restorable_attempt', beatId: beat.beat_id }
    );
  }

  beat.generated_video_url = restorable.video_url;
  beat.endframe_url = restorable.endframe_url || null;
  if (restorable.model_used) beat.model_used = restorable.model_used;

  // Append a promotion record so the audit log shows the human decision.
  appendAttemptLog(beat, {
    status: BEAT_STATUS.READY,
    video_url: restorable.video_url,
    endframe_url: restorable.endframe_url || null,
    model_used: restorable.model_used || null,
    reason: 'user_approve_promote_from_quarantine'
  });

  // Transition to ready. We use direct mutation (not transition()) for the
  // same reason as quarantineBeat — the user's intent is unambiguous.
  beat.status = BEAT_STATUS.READY;
  beat.version = (beat.version || 0) + 1;
  beat.updated_at = new Date().toISOString();

  return beat;
}

/**
 * Mark a beat as superseded (e.g. user clicked Regenerate and a new attempt
 * is about to overwrite the canonical row). Snapshots the current video into
 * attempts_log so the audit trail keeps the prior take.
 *
 * Subsequent transition() calls can move from `superseded` → `generating` for
 * the new attempt; the regenerate path treats supersede + new generate as one
 * unit and uses transition() with expectedFrom='superseded'.
 *
 * @param {Object} beat
 * @param {Object} [opts]
 * @param {string} [opts.reason]
 * @returns {Object} mutated beat
 */
export function supersedeBeat(beat, opts = {}) {
  if (!beat) throw new BeatLifecycleError('supersedeBeat: beat is required', { code: 'no_beat' });
  ensureLifecycleFields(beat);

  appendAttemptLog(beat, {
    status: BEAT_STATUS.SUPERSEDED,
    video_url: beat.generated_video_url || null,
    endframe_url: beat.endframe_url || null,
    model_used: beat.model_used || null,
    reason: opts.reason || 'user_regenerate'
  });

  beat.generated_video_url = null;
  beat.endframe_url = null;
  beat.status = BEAT_STATUS.SUPERSEDED;
  beat.version = (beat.version || 0) + 1;
  beat.updated_at = new Date().toISOString();
  return beat;
}

/**
 * Walk every beat in a sceneGraph and return only those that are LIVE.
 * Loaders for reassembly + post-production use this. Returns an array of
 * `{ scene, beat, scene_index, beat_index }` objects in canonical
 * `(scene_index, beat_index)` order. Skips SPEED_RAMP_TRANSITION beats
 * (those are assembler-only, not real beats).
 *
 * The ordering guarantee is the architectural fix that made the
 * "regenerated s2b4 appended at the end of the array" symptom impossible.
 *
 * @param {Object} sceneGraph
 * @returns {Array<{scene: Object, beat: Object, scene_index: number, beat_index: number}>}
 */
export function selectLiveBeats(sceneGraph) {
  const out = [];
  if (!sceneGraph || !Array.isArray(sceneGraph.scenes)) return out;

  for (let s = 0; s < sceneGraph.scenes.length; s++) {
    const scene = sceneGraph.scenes[s];
    if (!Array.isArray(scene?.beats)) continue;
    for (let b = 0; b < scene.beats.length; b++) {
      const beat = scene.beats[b];
      if (!beat) continue;
      if (beat.type === 'SPEED_RAMP_TRANSITION') continue;
      ensureLifecycleFields(beat);
      if (!isLiveStatus(beat.status)) continue;
      if (!beat.generated_video_url) continue; // defense in depth
      out.push({ scene, beat, scene_index: s, beat_index: b });
    }
  }
  return out;
}

/**
 * V4 Tier 3.3 (2026-05-06) — Beat quarantine derived view.
 *
 * The Tier 1 storage is a flat attempts_log array per beat. Tier 3.3
 * promotes the audit trail to a typed {live, quarantine} view that
 * readers can iterate WITHOUT having to interpret the status enum +
 * walk attempts_log themselves. Storage shape is unchanged (flat
 * attempts_log + canonical row remain), so this is purely a derived
 * read API — zero migration, zero risk.
 *
 * Usage: Director Panel UI calls this to render "approved take" + "all
 * quarantined takes" tabs. Reassembly continues to use selectLiveBeats()
 * which is the canonical-row-only fast path.
 *
 * @param {Object} beat
 * @returns {{ live: Object|null, quarantine: Array }}
 */
export function deriveQuarantineView(beat) {
  if (!beat) return { live: null, quarantine: [] };
  ensureLifecycleFields(beat);

  const live = isLiveStatus(beat.status) && beat.generated_video_url
    ? {
        beat_id: beat.beat_id,
        status: beat.status,
        version: beat.version,
        video_url: beat.generated_video_url,
        endframe_url: beat.endframe_url || null,
        model_used: beat.model_used || null
      }
    : null;

  const quarantine = (beat.attempts_log || [])
    .filter(a => a && a.video_url && (a.status === BEAT_STATUS.HARD_REJECTED || a.status === BEAT_STATUS.SUPERSEDED || a.status === BEAT_STATUS.FAILED))
    .map(a => ({
      attempt_uuid: a.attempt_uuid,
      status: a.status,
      video_url: a.video_url,
      endframe_url: a.endframe_url || null,
      model_used: a.model_used || null,
      lens_c_verdict: a.lens_c_verdict || null,
      reason: a.reason || null,
      ended_at: a.ended_at || a.started_at || null
    }));

  return { live, quarantine };
}

export default {
  BEAT_STATUS,
  LIVE_STATUSES,
  QUARANTINED_STATUSES,
  BeatLifecycleError,
  isLiveStatus,
  isQuarantinedStatus,
  isKnownStatus,
  ensureLifecycleFields,
  transition,
  appendAttemptLog,
  quarantineBeat,
  promoteFromQuarantine,
  supersedeBeat,
  selectLiveBeats,
  deriveQuarantineView
};
