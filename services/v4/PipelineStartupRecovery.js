// services/v4/PipelineStartupRecovery.js
//
// Server-startup recovery for orphaned in-flight V4 episodes.
//
// Background problem
// ──────────────────
// The V4 pipeline (`runV4Pipeline`) is an in-memory async function chain.
// While it runs, scene-graph state lives in Node memory; status updates are
// the only thing persisted to the DB (and only at coarse milestones — Step 5
// episode insert, Step 6 scene_master persist after Lens B, post-production
// final upload, etc.).
//
// When the server restarts mid-pipeline (Render auto-deploy, OOM, manual
// restart, panic), the in-memory Promise dies WITH the JS runtime. The
// episode row is left stranded in a transient status (`generating_beats`,
// `applying_lut`, `regenerating_beat`, etc.) with NO process working on it.
//
// The frontend polling loop sees the transient status as "still in
// progress" and shows the spinner forever. The user sees no logs, no
// progress, no recovery — just a stuck "Generating Episode…" wheel.
//
// Production incident 2026-05-06 (logs.txt 174-line run):
//   19:25:21 — pipeline mid post-production (beat 2 normalized)
//   19:25:44 — `==> Running 'npm start'` ← Render restart
//   Episode `27d6276b` left stranded in `applying_lut` status. UI spun
//   forever; only manual SQL recovery + the new resume infrastructure
//   could un-stick it.
//
// What this module does
// ─────────────────────
// On server boot, scan for episodes in transient V4 statuses. Any episode
// in such a status BY DEFINITION cannot have a live in-process pipeline —
// the process just started, no pipeline is running yet. So those rows are
// orphans by construction.
//
// For each orphan: kick `runV4Pipeline(episodeId)` resume mode in the
// background. The resume:
//   • skips screenplay generation, Lens A, episode creation
//   • reuses persisted scene_description (with whatever was generated)
//   • generateSceneMasters skips scenes with existing URLs
//   • Lens B re-judges (cheap, ~$0.01-0.02 per scene)
//   • beat loop reuses generated beats via existing skip-check at
//     BrandStoryService.js:5265, renders missing beats
//   • post-production runs on the full set
//   • episode ships
//
// Anti-thrash: if the resume itself crashes the server (boot loop), we
// don't want to keep kicking it forever. Track `recovery_attempts` on the
// episode's directorReport. After MAX_AUTO_RESUME_ATTEMPTS the episode is
// marked `failed` with a clear error.

import winston from 'winston';
import { supabaseAdmin } from '../supabase.js';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[StartupRecovery] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

// V4 transient statuses — pipeline is mid-flight when in any of these.
// Note: `awaiting_user_review` is NOT here — that's a deliberate halt
// where the pipeline correctly stopped and is waiting for the user.
// `ready` / `published` / `failed` are terminal and not orphan-eligible.
const TRANSIENT_V4_STATUSES = [
  'pending',
  'brand_safety_check',
  'generating_scene_masters',
  'generating_beats',
  'assembling',
  'applying_lut',
  'post_production',
  'regenerating_beat'
];

// Hard ceiling on auto-resume attempts per episode. After this many
// consecutive failed attempts (each triggered by a server restart), the
// episode is marked `failed` so it doesn't loop forever on every boot.
// Counter lives on `directorReport.recovery_attempts`.
const MAX_AUTO_RESUME_ATTEMPTS = 3;

// Process-local dedupe — guards against the recovery being called twice
// during a single boot (e.g. if the orchestrator imports this module from
// two paths). Resets on process restart, which is correct: a fresh boot
// SHOULD always re-scan for orphans.
let _hasRunOnce = false;
const _kickedInThisProcess = new Set();

/**
 * Scan for orphaned in-flight V4 episodes and kick `runV4Pipeline` resume
 * for each. Idempotent within a process; safe to call multiple times.
 *
 * @param {Object} args
 * @param {Object} args.brandStoryService - the singleton instance
 * @param {boolean} [args.dryRun=false]   - if true, log what would happen but don't kick resumes
 * @returns {Promise<{ total_orphans: number, recovered: number, skipped_due_to_attempt_cap: number, skipped: boolean? }>}
 */
export async function recoverInflightV4Episodes({ brandStoryService, dryRun = false } = {}) {
  if (_hasRunOnce) {
    logger.info('already ran in this process — skipping');
    return { skipped: true, reason: 'already_ran' };
  }
  _hasRunOnce = true;

  if (!brandStoryService || typeof brandStoryService.runV4Pipeline !== 'function') {
    logger.error('brandStoryService dependency required (with runV4Pipeline method)');
    return { skipped: true, reason: 'no_service' };
  }

  let orphans;
  try {
    const { data, error } = await supabaseAdmin
      .from('brand_story_episodes')
      .select('id, story_id, user_id, status, episode_number, director_report')
      .eq('pipeline_version', 'v4')
      .in('status', TRANSIENT_V4_STATUSES);
    if (error) throw error;
    orphans = Array.isArray(data) ? data : [];
  } catch (err) {
    logger.error(`failed to query orphans: ${err.message}`);
    return { skipped: true, reason: 'query_failed', error: err.message };
  }

  if (orphans.length === 0) {
    logger.info('no orphaned in-flight V4 episodes');
    return { total_orphans: 0, recovered: 0, skipped_due_to_attempt_cap: 0 };
  }

  logger.info(`found ${orphans.length} orphaned in-flight V4 episode(s):`);
  for (const ep of orphans) {
    const dr = ep.director_report || {};
    const attempts = Number(dr.recovery_attempts) || 0;
    logger.info(`  • ${ep.id} (status=${ep.status}, episode#${ep.episode_number}, prior recovery attempts=${attempts})`);
  }

  if (dryRun) {
    logger.info('dryRun=true — not kicking any resumes');
    return { total_orphans: orphans.length, recovered: 0, skipped_due_to_attempt_cap: 0, dry_run: true };
  }

  let kicked = 0;
  let skippedDueToAttemptCap = 0;

  for (const ep of orphans) {
    const dr = ep.director_report || {};
    const attempts = Number(dr.recovery_attempts) || 0;

    if (attempts >= MAX_AUTO_RESUME_ATTEMPTS) {
      logger.warn(
        `episode ${ep.id} has hit ${attempts}/${MAX_AUTO_RESUME_ATTEMPTS} auto-resume attempts — ` +
        `marking failed instead of kicking another resume (likely a deterministic crash; ` +
        `re-trigger episode generation manually after fixing the root cause).`
      );
      try {
        await supabaseAdmin
          .from('brand_story_episodes')
          .update({
            status: 'failed',
            error_message:
              `Pipeline interrupted by repeated server restarts; auto-resume attempted ${attempts}× ` +
              `(stuck at ${ep.status}) and the recovery loop bailed out. ` +
              `Re-trigger episode generation manually after fixing the underlying issue.`
          })
          .eq('id', ep.id);
      } catch (err) {
        logger.error(`failed to mark ${ep.id} as failed: ${err.message}`);
      }
      skippedDueToAttemptCap++;
      continue;
    }

    if (_kickedInThisProcess.has(ep.id)) {
      logger.info(`episode ${ep.id} already kicked in this process — skipping duplicate`);
      continue;
    }
    _kickedInThisProcess.add(ep.id);

    // Bump attempt counter BEFORE kicking the resume so anti-thrash works
    // even if the resume process never returns (e.g. another crash).
    const newAttempts = attempts + 1;
    const updatedDR = {
      ...dr,
      recovery_attempts: newAttempts,
      last_recovery_kick_at: new Date().toISOString(),
      last_recovery_kick_from_status: ep.status
    };
    try {
      await supabaseAdmin
        .from('brand_story_episodes')
        .update({ director_report: updatedDR })
        .eq('id', ep.id);
    } catch (err) {
      logger.warn(`failed to bump attempt counter for ${ep.id}: ${err.message} (continuing anyway)`);
    }

    logger.info(
      `kicking resume for episode ${ep.id} ` +
      `(status=${ep.status}, attempt ${newAttempts}/${MAX_AUTO_RESUME_ATTEMPTS}, episode#${ep.episode_number})`
    );

    // Fire-and-forget. Each resume runs as its own background Promise so
    // one failure doesn't block other orphans' recovery.
    brandStoryService
      .runV4Pipeline(ep.story_id, ep.user_id, null, { episodeId: ep.id })
      .then(() => {
        logger.info(`episode ${ep.id} resumed to completion`);
        // On success, reset the attempt counter so the next genuine
        // pipeline run starts fresh — without this, an episode that
        // recovers on attempt 2 would still carry a "2 prior attempts"
        // ghost forever.
        return supabaseAdmin
          .from('brand_story_episodes')
          .select('director_report')
          .eq('id', ep.id)
          .single()
          .then(({ data }) => {
            if (!data?.director_report) return;
            const cleaned = { ...data.director_report };
            delete cleaned.recovery_attempts;
            delete cleaned.last_recovery_kick_at;
            delete cleaned.last_recovery_kick_from_status;
            return supabaseAdmin
              .from('brand_story_episodes')
              .update({ director_report: cleaned })
              .eq('id', ep.id);
          });
      })
      .catch((err) => {
        const isHalt = err?.constructor?.name === 'DirectorBlockingHaltError';
        if (isHalt) {
          logger.info(
            `episode ${ep.id} resumed but Director halted at ${err.checkpoint || '?'} — ` +
            `panel will surface the verdict for user resolution`
          );
          return;
        }
        logger.error(`episode ${ep.id} resume failed: ${err.message}`);
        supabaseAdmin
          .from('brand_story_episodes')
          .update({
            status: 'failed',
            error_message:
              `Auto-resume after server restart failed (attempt ${newAttempts}/${MAX_AUTO_RESUME_ATTEMPTS}): ${err.message}`
          })
          .eq('id', ep.id)
          .then(() => {})
          .catch(() => {});
      });
    kicked++;
  }

  logger.info(
    `${kicked} resume(s) kicked; ${skippedDueToAttemptCap} skipped due to attempt cap; ` +
    `${orphans.length} total orphans found`
  );
  return {
    total_orphans: orphans.length,
    recovered: kicked,
    skipped_due_to_attempt_cap: skippedDueToAttemptCap
  };
}

/**
 * Test-only helper. Resets the process-local guards so tests can call
 * `recoverInflightV4Episodes` repeatedly. Not exported in normal use.
 */
export function _resetForTests() {
  _hasRunOnce = false;
  _kickedInThisProcess.clear();
}
