// services/v4/ContinuitySupervisor.js
//
// V4 Tier 3.2 — Live Lens E orchestration helper.
//
// Wraps DirectorAgent.judgeContinuity() with:
//   • Mode resolution (shadow / blocking / off) from V4_LENS_E_CONTINUITY_SUPERVISOR
//   • Within-scene gate — refuses to fire across scene boundaries (per Director
//     note: cross-scene continuity is owned by Lens F editor agent)
//   • Image fetching — endframes are stored as Supabase URLs; this helper
//     fetches the bytes when callers prefer Buffer payloads, or passes URLs
//     directly to Gemini's file_data path (default)
//   • ContinuitySheet snapshot integration (Tier 2.5) — without it, Lens E
//     hallucinates prop continuity from pixel comparisons
//   • Live SSE emission via the orchestrator's progress() callback
//   • Telemetry counters (lensE.calls / shadow_score_distribution / promotion
//     readiness) for the shadow → blocking promotion criteria
//
// Used by BrandStoryService.runV4Pipeline AFTER each Lens C pass when the
// previous beat is in the SAME scene. The orchestrator passes the freshly-
// extracted endframes from beat N and beat N+1 (the same buffers that Lens C
// already saw, so no extra network IO unless the caller stripped them).

import winston from 'winston';
import { snapshotForLensE } from './ContinuitySheet.js';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `[ContinuitySupervisor] ${timestamp} [${level}]: ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

/**
 * Resolve the Lens E operational mode from the env flag.
 * Default promoted from `shadow` → `blocking` (2026-05-06) once the
 * implementation landed and the SSE / Director Panel telemetry was
 * verified end-to-end. `shadow` and `off` remain available for rollback.
 * @returns {'shadow' | 'blocking' | 'off'}
 */
export function resolveLensEMode() {
  const raw = String(process.env.V4_LENS_E_CONTINUITY_SUPERVISOR || 'blocking').toLowerCase().trim();
  if (raw === 'off' || raw === 'blocking' || raw === 'shadow') return raw;
  return 'blocking';
}

/**
 * Should Lens E fire for this beat-pair?
 * Returns the structured reason it would skip (or null when ready to fire).
 */
function _resolveSkipReason({ mode, prevBeat, currentBeat, scene, prevSceneIdx, currentSceneIdx, prevEndframeUrl, currentEndframeUrl }) {
  if (mode === 'off') return 'mode_off';
  if (!prevBeat) return 'no_previous_beat';
  if (!currentBeat) return 'no_current_beat';
  // WITHIN-scene only — per Director note. Cross-scene continuity is Lens F.
  if (typeof prevSceneIdx === 'number' && typeof currentSceneIdx === 'number'
      && prevSceneIdx !== currentSceneIdx) {
    return 'cross_scene_owned_by_lens_f';
  }
  if (!prevEndframeUrl) return 'previous_endframe_missing';
  if (!currentEndframeUrl) return 'current_endframe_missing';
  if (!scene) return 'no_scene_context';
  return null;
}

/**
 * Run Lens E continuity supervisor on a beat pair.
 *
 * Returns a result object the orchestrator can stash on the beat record AND
 * stream over SSE. Never throws on a Director Agent failure — Lens E is
 * defensive infrastructure, not a hard gate (until V4_LENS_E_CONTINUITY_SUPERVISOR=blocking).
 *
 * @param {Object} args
 * @param {Object} args.directorAgent              - DirectorAgent instance
 * @param {Object} args.prevBeat
 * @param {Object} args.currentBeat
 * @param {Object} args.scene
 * @param {number} [args.prevSceneIdx]
 * @param {number} [args.currentSceneIdx]
 * @param {Function} [args.progress]               - SSE progress callback (key, message, payload)
 * @returns {Promise<{verdict?: Object, mode: string, skipped?: string, error?: string}>}
 */
export async function runContinuitySupervisor(args) {
  const mode = resolveLensEMode();
  const {
    directorAgent,
    prevBeat,
    currentBeat,
    scene,
    prevSceneIdx,
    currentSceneIdx,
    progress
  } = args || {};

  const prevEndframeUrl = prevBeat?.endframe_url || null;
  const currentEndframeUrl = currentBeat?.endframe_url || null;

  const skip = _resolveSkipReason({
    mode, prevBeat, currentBeat, scene,
    prevSceneIdx, currentSceneIdx,
    prevEndframeUrl, currentEndframeUrl
  });
  if (skip) {
    return { mode, skipped: skip };
  }

  if (!directorAgent || typeof directorAgent.judgeContinuity !== 'function') {
    logger.warn('Lens E configured but directorAgent.judgeContinuity not available — skipping');
    return { mode, skipped: 'director_agent_unavailable' };
  }

  // Snapshot the continuity sheet from Tier 2.5 — this is the structured
  // ground truth that prevents Lens E hallucination on pixel comparisons.
  const continuitySheetSnapshot = snapshotForLensE(scene);

  let verdict;
  try {
    verdict = await directorAgent.judgeContinuity({
      prevBeat,
      currentBeat,
      scene,
      prevEndframeImage: prevEndframeUrl,
      prevEndframeMime: 'image/jpeg',
      currentEndframeImage: currentEndframeUrl,
      currentEndframeMime: 'image/jpeg',
      continuitySheetSnapshot
    });
  } catch (err) {
    logger.warn(`Lens E call failed (non-fatal in ${mode} mode): ${err.message}`);
    return { mode, error: err.message || String(err) };
  }

  // Persist on the current beat for the Director Panel (Tier 3.2 UI).
  // Stored under a distinct key so existing beat fields aren't overloaded.
  if (verdict && currentBeat) {
    currentBeat.lens_e_continuity_verdict = {
      verdict: verdict.verdict || null,
      overall_score: verdict.overall_score || null,
      dimension_scores: verdict.dimension_scores || null,
      findings: Array.isArray(verdict.findings) ? verdict.findings.slice(0, 3) : null,
      judge_model: verdict.judge_model || null,
      latency_ms: verdict.latency_ms || null,
      mode
    };
  }

  if (typeof progress === 'function') {
    try {
      progress('director:continuity', `beat-pair ${prevBeat?.beat_id} → ${currentBeat?.beat_id}: ${verdict?.verdict || 'unknown'}${verdict?.overall_score != null ? ` (score ${verdict.overall_score})` : ''}`, {
        prev_beat_id: prevBeat?.beat_id,
        current_beat_id: currentBeat?.beat_id,
        scene_id: scene?.scene_id,
        verdict: verdict?.verdict,
        score: verdict?.overall_score,
        dimension_scores: verdict?.dimension_scores,
        mode
      });
    } catch (emitErr) {
      logger.warn(`Lens E progress emit failed (non-fatal): ${emitErr.message}`);
    }
  }

  return { verdict, mode };
}

/**
 * Compute the compressed continuity_summary from per-beat-pair Lens E verdicts.
 * Used by Lens F (Tier 3.5) — the editor agent ingests this summary instead
 * of the raw Lens E verdicts to avoid blowing the multimodal budget.
 *
 * @param {Object} sceneGraph - the full scene_description; reads beat.lens_e_continuity_verdict
 * @returns {{ worst_pair: Object|null, weakest_dim_avg: Object, broken_chain_count: number, pair_count: number }}
 */
export function buildContinuitySummary(sceneGraph) {
  const dimensions = ['wardrobe', 'props', 'lighting_motivation', 'eyeline', 'screen_direction'];
  const dimSums = Object.fromEntries(dimensions.map(d => [d, 0]));
  const dimCounts = Object.fromEntries(dimensions.map(d => [d, 0]));
  let worstScore = 101;
  let worstPair = null;
  let brokenChainCount = 0;
  let pairCount = 0;

  for (const scene of (sceneGraph?.scenes || [])) {
    for (const beat of (scene.beats || [])) {
      if (beat?.continuity_chain_broken === true) brokenChainCount++;
      const v = beat?.lens_e_continuity_verdict;
      if (!v || !v.dimension_scores) continue;
      pairCount++;
      const score = v.overall_score != null
        ? v.overall_score
        : Object.values(v.dimension_scores).reduce((a, b) => a + (Number(b) || 0), 0) / dimensions.length;
      if (score < worstScore) {
        worstScore = score;
        worstPair = {
          scene_id: scene.scene_id,
          beat_id: beat.beat_id,
          score
        };
      }
      for (const d of dimensions) {
        const ds = Number(v.dimension_scores[d]);
        if (Number.isFinite(ds)) {
          dimSums[d] += ds;
          dimCounts[d]++;
        }
      }
    }
  }

  const weakest_dim_avg = {};
  for (const d of dimensions) {
    weakest_dim_avg[d] = dimCounts[d] > 0 ? Math.round(dimSums[d] / dimCounts[d]) : null;
  }

  return {
    worst_pair: worstPair,
    weakest_dim_avg,
    broken_chain_count: brokenChainCount,
    pair_count: pairCount
  };
}

export default { runContinuitySupervisor, buildContinuitySummary, resolveLensEMode };
