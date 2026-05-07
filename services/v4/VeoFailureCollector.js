// services/v4/VeoFailureCollector.js
//
// Async, fire-and-forget telemetry writer for the Veo Failure-Learning Agent.
//
// Called from every Veo failure path:
//   - services/VeoService.js catch-blocks (every sanitization tier)
//   - services/beat-generators/VeoActionGenerator.js Kling-fallback path
//
// Writes one row per refusal/error to the Supabase `veo_failure_log` table.
// NEVER blocks the caller — every database error is caught and warn-logged
// so a Supabase outage cannot regress beat generation. The data we collect
// here is the substrate the nightly VeoFailureKnowledgeBuilder uses to
// regenerate VeoFailureKnowledge.mjs.
//
// After a successful insert the collector also evaluates a high-severity
// threshold (≥10 same-signature failures in 60 minutes) and, if exceeded,
// fires VeoFailureKnowledgeBuilder.runIncremental(signatureKey) in the
// background. This gives the system a same-day reaction to a sudden new
// failure mode without waiting for the nightly cron.

import winston from 'winston';
import { supabaseAdmin, isConfigured } from '../supabase.js';
import { isVeoContentFilterError, isImageContentFilterError } from './VeoPromptSanitizer.js';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `[VeoFailureCollector] ${timestamp} [${level}]: ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

// ─────────────────────────────────────────────────────────────────────
// Failure-mode classification — heuristic, message-text driven
// ─────────────────────────────────────────────────────────────────────

const SIGNATURE_HEURISTICS = [
  // Order matters — more specific patterns first.
  { tag: 'image_violates',      re: /input image violates|could not generate.*input image|image.*violates.*guidelines/i },
  { tag: 'usage_guidelines',    re: /violate[sd]?\s+.*guidelines|usage guidelines/i },
  { tag: 'could_not_be_submitted', re: /could not be submitted/i },
  { tag: 'support_29xxxxx',     re: /support codes?:\s*29\d{6}/i },
  { tag: 'safety_filter',       re: /safety filter|inappropriate content|content polic|prohibited content/i },
  { tag: 'high_load',           re: /high load|currently experiencing/i },
  { tag: 'rate_limit_429',      re: /\b429\b|too many requests|rate.?limit/i },
  { tag: 'auth_401_403',        re: /\b40[13]\b|unauthorized|permission denied|authentication/i },
  { tag: 'polling_timeout',     re: /timeout|timed out|deadline exceeded/i },
  { tag: 'network',             re: /\bENOTFOUND\b|\bECONNRESET\b|\bECONNREFUSED\b|\bnetwork\b/i },
  { tag: 'schema_violation',    re: /invalid (request|argument)|schema|validation/i }
];

/**
 * Classify an error message into a primary failure_mode + an array of
 * matching signature tags. The tags are persisted as `error_signatures`
 * (Postgres TEXT[]) so the agent can cluster on them later.
 *
 * @param {string} message
 * @param {Error} [err]
 * @returns {{failureMode: string, signatures: string[]}}
 */
export function classifyFailure(message, err = null) {
  const msg = String(message || '');
  const signatures = [];

  for (const { tag, re } of SIGNATURE_HEURISTICS) {
    if (re.test(msg)) signatures.push(tag);
  }

  // Map signatures → primary failure_mode. Order of precedence:
  //   image_violates  → content_filter_image
  //   usage_guidelines / could_not_be_submitted / support_29 / safety_filter → content_filter_prompt
  //   high_load       → high_load
  //   rate_limit_429  → rate_limit
  //   auth_401_403    → auth
  //   polling_timeout → polling_timeout
  //   network         → network
  //   schema_violation → schema_violation
  let failureMode = 'other';
  if (signatures.includes('image_violates')) {
    failureMode = 'content_filter_image';
  } else if (
    signatures.includes('usage_guidelines') ||
    signatures.includes('could_not_be_submitted') ||
    signatures.includes('support_29xxxxx') ||
    signatures.includes('safety_filter')
  ) {
    failureMode = 'content_filter_prompt';
  } else if (signatures.includes('high_load')) {
    failureMode = 'high_load';
  } else if (signatures.includes('rate_limit_429')) {
    failureMode = 'rate_limit';
  } else if (signatures.includes('auth_401_403')) {
    failureMode = 'auth';
  } else if (signatures.includes('polling_timeout')) {
    failureMode = 'polling_timeout';
  } else if (signatures.includes('network')) {
    failureMode = 'network';
  } else if (signatures.includes('schema_violation')) {
    failureMode = 'schema_violation';
  }

  // Defensive — if the helpers from VeoPromptSanitizer flag the error and our
  // heuristics didn't pick it up (different wording), still mark it as a
  // content-filter failure so it doesn't get bucketed as 'other'.
  if (failureMode === 'other' && err) {
    if (isImageContentFilterError(err)) failureMode = 'content_filter_image';
    else if (isVeoContentFilterError(err)) failureMode = 'content_filter_prompt';
  }

  return { failureMode, signatures };
}

// ─────────────────────────────────────────────────────────────────────
// Incremental-regen threshold tracking
//
// 2026-05-07 PIVOT: previous design used an in-memory Map (_recentBySig) to
// count failures per signature in a 60-min sliding window. On Cloud Run with
// autoscaling, failures distribute across instances → no single instance ever
// reaches the threshold → incremental regen never fires.
//
// New design: SELECT count(*) FROM veo_failure_log WHERE error_signatures &&
// ARRAY[$sig] AND created_at > now() - 60min. Each instance does its own
// count after each successful insert. The fleet-wide count is authoritative;
// no cross-instance signaling needed.
//
// Per-instance debounce (_lastTriggerBySig) is retained as a cost-control
// floor — across the fleet we may fire 2-3 incremental runs per hour vs 1
// in the old single-instance world, but Gemini cost is one call per run
// (negligible). Per-instance debounce ensures one instance doesn't spam.
// ─────────────────────────────────────────────────────────────────────

const INCREMENTAL_THRESHOLD = parseInt(process.env.VEO_FAILURE_INCREMENTAL_THRESHOLD || '10', 10);
const INCREMENTAL_WINDOW_MS = parseInt(process.env.VEO_FAILURE_INCREMENTAL_WINDOW_MS || String(60 * 60 * 1000), 10);
const INCREMENTAL_DEBOUNCE_MS = parseInt(process.env.VEO_FAILURE_INCREMENTAL_DEBOUNCE_MS || String(60 * 60 * 1000), 10);

// signatureTag → last regen-trigger timestamp (per-instance debounce only).
// In-memory across instances is acceptable: worst case the fleet fires 1
// extra incremental run per signature per hour, vs the alternative of a
// shared lock that would re-introduce single-instance assumptions.
const _lastTriggerBySig = new Map();

/**
 * Cluster-wide threshold check via SQL. Replaces the in-memory window count
 * the old _trackAndMaybeTrigger used. Cost: one COUNT query per signature in
 * `signatures`, after each successful insert. The veo_failure_log_signatures_gin
 * index makes the && containment check O(log n).
 *
 * @param {string[]} signatures
 * @returns {Promise<string|null>} signature tag that tripped the threshold, or null
 */
async function _checkThresholdViaDb(signatures) {
  if (!signatures || signatures.length === 0) return null;
  if (!isConfigured() || !supabaseAdmin) return null;
  const sinceIso = new Date(Date.now() - INCREMENTAL_WINDOW_MS).toISOString();
  for (const sig of signatures) {
    try {
      const { count, error } = await supabaseAdmin
        .from('veo_failure_log')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', sinceIso)
        .contains('error_signatures', [sig]);
      if (error) {
        logger.warn(`threshold count query failed for ${sig}: ${error.message}`);
        continue;
      }
      if ((count || 0) >= INCREMENTAL_THRESHOLD) {
        const last = _lastTriggerBySig.get(sig) || 0;
        if (Date.now() - last >= INCREMENTAL_DEBOUNCE_MS) {
          _lastTriggerBySig.set(sig, Date.now());
          logger.info(`threshold tripped (fleet count=${count}) for signature='${sig}'`);
          return sig; // first eligible signature wins
        }
      }
    } catch (err) {
      logger.warn(`threshold check threw for ${sig}: ${err.message}`);
    }
  }
  return null;
}

async function _fireIncrementalRegen(signatureTag) {
  // Lazy-import to avoid the circular dep with VeoFailureKnowledgeBuilder
  // (the builder imports the collector for its DB read pattern).
  try {
    const mod = await import('./VeoFailureKnowledgeBuilder.js');
    const builder = mod.default || mod;
    if (typeof builder.runIncremental === 'function') {
      logger.info(`threshold reached for signature='${signatureTag}' — firing runIncremental()`);
      await builder.runIncremental(signatureTag);
    }
  } catch (err) {
    logger.warn(`runIncremental dispatch failed: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Public API: VeoFailureCollector.record(...)
// ─────────────────────────────────────────────────────────────────────

/**
 * Persist one Veo failure event. Fire-and-forget — never blocks the caller
 * and never throws. Callers may `await` if they want to know whether the
 * write succeeded, but the canonical usage is:
 *
 *     VeoFailureCollector.record({ ... }).catch(() => {});
 *
 * @param {Object} params
 * @param {string} [params.userId]
 * @param {string} [params.episodeId]
 * @param {string} [params.beatId]
 * @param {string} [params.beatType]
 * @param {Error}  [params.error] - the raw Error; collector classifies it
 * @param {string} [params.errorMessage] - explicit override (used when the error has been wrapped)
 * @param {string} [params.prompt] - the prompt that failed (truncated to 600 chars)
 * @param {string[]} [params.personaNames]
 * @param {boolean} [params.hadFirstFrame]
 * @param {boolean} [params.hadLastFrame]
 * @param {number} [params.durationSec]
 * @param {string} [params.aspectRatio]
 * @param {string} [params.modelAttempted]
 * @param {string} [params.attemptTierReached]
 * @param {boolean} [params.recoverySucceeded]
 * @param {string} [params.fallbackModel]
 * @param {number} [params.attemptCount]
 * @param {number} [params.totalDurationMs]
 * @param {string} [params.veoOperationId]
 * @returns {Promise<{ok: boolean, id?: string, failureMode?: string}>}
 */
async function record(params = {}) {
  // Gate test-runner writes out of production telemetry. The unit-test suite
  // exercises record() with synthetic fixtures; without this guard those
  // fixtures land in the prod `veo_failure_log` table and pollute the
  // nightly clustering pass (observed 2026-05-07: 'test-beat-1', 'test-beat-2'
  // rows produced two junk signatures). NODE_ENV is set to 'test' by `node --test`
  // out of the box; tests that need to exercise the DB path can override it.
  if (process.env.NODE_ENV === 'test' && process.env.VEO_FAILURE_COLLECTOR_ALLOW_TEST_WRITES !== 'true') {
    return { ok: false, reason: 'test_env_skipped' };
  }
  if (!isConfigured() || !supabaseAdmin) {
    // Supabase isn't wired up (local dev / test runner). Never block — just
    // skip silently. Tests that want to observe the call should stub this
    // module or stub supabaseAdmin.
    return { ok: false };
  }

  const {
    userId,
    episodeId,
    beatId,
    beatType,
    error,
    errorMessage,
    prompt,
    personaNames,
    hadFirstFrame,
    hadLastFrame,
    durationSec,
    aspectRatio,
    modelAttempted,
    attemptTierReached,
    recoverySucceeded,
    fallbackModel,
    attemptCount,
    totalDurationMs,
    veoOperationId
  } = params;

  const rawMessage = errorMessage || (error && error.message) || 'unknown';
  const truncatedMessage = String(rawMessage).slice(0, 1000);
  const truncatedPrompt = prompt ? String(prompt).slice(0, 600) : null;

  const { failureMode, signatures } = classifyFailure(truncatedMessage, error);

  const row = {
    user_id: userId || null,
    episode_id: episodeId || null,
    beat_id: beatId || null,
    beat_type: beatType || null,
    failure_mode: failureMode,
    error_signatures: signatures,
    error_message: truncatedMessage,
    original_prompt: truncatedPrompt,
    persona_names: Array.isArray(personaNames) ? personaNames.filter(Boolean) : [],
    had_first_frame: typeof hadFirstFrame === 'boolean' ? hadFirstFrame : null,
    had_last_frame: typeof hadLastFrame === 'boolean' ? hadLastFrame : null,
    duration_sec: typeof durationSec === 'number' ? durationSec : null,
    aspect_ratio: aspectRatio || null,
    model_attempted: modelAttempted || null,
    attempt_tier_reached: attemptTierReached || null,
    recovery_succeeded: typeof recoverySucceeded === 'boolean' ? recoverySucceeded : null,
    fallback_model: fallbackModel || null,
    attempt_count: typeof attemptCount === 'number' ? attemptCount : null,
    total_duration_ms: typeof totalDurationMs === 'number' ? totalDurationMs : null,
    veo_operation_id: veoOperationId || null
  };

  try {
    const { data, error: dbErr } = await supabaseAdmin
      .from('veo_failure_log')
      .insert(row)
      .select('id')
      .single();

    if (dbErr) {
      logger.warn(`insert failed: ${dbErr.message || dbErr}`);
      return { ok: false, failureMode };
    }

    logger.info(
      `recorded ${failureMode} ` +
      `(beat=${beatId || 'n/a'}, tier=${attemptTierReached || 'n/a'}, ` +
      `signatures=[${signatures.join(',')}])`
    );

    // Threshold check via SQL — fleet-wide count across all Cloud Run
    // instances. Fire incremental regen in the background if tripped.
    _checkThresholdViaDb(signatures)
      .then(trippedSig => {
        if (trippedSig) {
          return _fireIncrementalRegen(trippedSig);
        }
      })
      .catch(err => {
        logger.warn(`threshold/incremental background error: ${err.message}`);
      });

    return { ok: true, id: data?.id, failureMode };
  } catch (err) {
    logger.warn(`record() exception: ${err.message}`);
    return { ok: false, failureMode };
  }
}

/**
 * Test-only helper. Resets the per-instance debounce state. Kept unexported
 * from the default object so it doesn't appear in production call sites —
 * pull it explicitly in tests.
 */
export function _resetThresholdStateForTests() {
  _lastTriggerBySig.clear();
}

export default {
  record,
  classifyFailure
};

export { record };
