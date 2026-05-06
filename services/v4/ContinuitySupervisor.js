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
// V4 Tier 4.1 (2026-05-06) — SmartSynth integration. The Lens C smart-retake
// pattern (multimodal_rich → text_rich → cheap_concat with priorAttempts +
// regression detection + persistence) is reused here for Lens E's auto-
// retake. The 'continuity' bucket-key + multimodal-eligible classification
// were added to SmartSynth in this same tier so the same helpers compose.
import {
  synthesizeRetakeDirective,
  appendSynthHistory,
  readSynthHistory,
  patchSynthOutcome
} from './SmartSynth.js';
import { extractBeatEndframe } from './StoryboardHelpers.js';
import { runQualityGate } from './QualityGate.js';
import { supersedeBeat } from './BeatLifecycle.js';

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

// ─────────────────────────────────────────────────────────────────────
// V4 Tier 4.1 (2026-05-06) — Lens E Smart Auto-Retake
// ─────────────────────────────────────────────────────────────────────

/**
 * Re-extract a beat's endframe from the most recently downloaded video
 * buffer (cheap, no model call). Used by the Tier A retake path to fix
 * the common root cause where `continuity_chain_broken=true` came from
 * a bad ffmpeg extraction (black frame, off-by-one seek) rather than a
 * content-level drift.
 *
 * @param {Object} args
 * @param {Buffer} args.videoBuffer
 * @param {Object} args.beat - mutated: endframe_url replaced via callback
 * @param {Function} args.uploadEndframe - async (buffer, filename) => url
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function _reExtractEndframe({ videoBuffer, beat, uploadEndframe }) {
  if (!videoBuffer || !Buffer.isBuffer(videoBuffer)) {
    return { ok: false, error: 'no_video_buffer' };
  }
  try {
    const newBuf = await extractBeatEndframe(videoBuffer);
    const newUrl = await uploadEndframe(newBuf, `${beat.beat_id}-reextract-${Date.now()}-end.jpg`);
    beat.endframe_url = newUrl;
    beat.continuity_chain_broken = false;
    beat.endframe_extraction_error = null;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * V4 Tier 4.1 — auto-retake a beat that Lens E flagged for continuity drift.
 *
 * This is the wrapper that brings Lens E up to parity with Lens C's
 * SmartSynth-driven retake pattern. The orchestrator (BrandStoryService
 * runV4Pipeline) calls this when Lens E returns soft_reject in blocking
 * mode. The wrapper handles:
 *
 *   1. SmartSynth call (multimodal: prev endframe + current endframe + scene
 *      master + persona refs) → returns directive + diagnosis + confidence
 *      + regression_warning + source. priorAttempts is read from
 *      directorReport.synth_history.continuity[currentBeat.beat_id].
 *
 *   2. Stamp `currentBeat.director_nudge` with the SmartSynth directive so
 *      the next render's prompt picks it up via _appendDirectorNudge.
 *
 *   3. (scenarioTier='A' only) Re-extract previousBeat's endframe from its
 *      video buffer — fixes the bad-extraction class without regenerating.
 *
 *   4. (scenarioTier='B') Supersede previousBeat too, run a SmartSynth call
 *      for IT (separate priorAttempts bucket), and regenerate it BEFORE
 *      regenerating the current beat. previousBeat then becomes the
 *      regenerated version with a fresh endframe.
 *
 *   5. Supersede currentBeat → router.generate(currentBeat) → upload buffer
 *      → extract endframe → upload endframe → re-judge via Lens E.
 *
 *   6. appendSynthHistory + patchSynthOutcome with the resulting score so
 *      the next attempt's regression detection works.
 *
 * Returns:
 *   { passed, secondVerdict, retakenBeatIds, regressionWarning, source,
 *     directive, prevReExtracted? }
 *
 * NEVER throws on a SmartSynth or Gemini failure — those degrade through
 * the SmartSynth fallback chain. The only errors that bubble up are
 * generator-throws (router.generate threw) and ffmpeg endframe extraction
 * after a successful generate (caller should treat both as "give up,
 * quarantine, halt").
 *
 * @param {Object} args
 * @param {Object} args.directorAgent
 * @param {Object} args.router - BeatRouter instance
 * @param {Object} args.currentBeat
 * @param {Object} args.previousBeat
 * @param {Object} args.scene
 * @param {Object[]} args.refStack
 * @param {Object[]} args.personas
 * @param {Object} args.episodeContext
 * @param {Object} args.directorReport
 * @param {Object} args.previousVerdict - the Lens E verdict that triggered the retake
 * @param {'A' | 'B'} args.scenarioTier
 * @param {Buffer} [args.previousBeatVideoBuffer] - needed for Tier A re-extraction
 * @param {Function} args.uploadVideo - async (buffer, filename) => url
 * @param {Function} args.uploadEndframe - async (buffer, filename) => url
 * @param {Function} [args.progress]
 * @returns {Promise<{passed: boolean, secondVerdict: Object|null, retakenBeatIds: string[], regressionWarning: boolean, source: string, directive: string, prevReExtracted: boolean}>}
 */
export async function runContinuityRetake(args) {
  const {
    directorAgent,
    router,
    currentBeat,
    previousBeat,
    scene,
    refStack,
    personas,
    episodeContext,
    directorReport,
    previousVerdict,
    scenarioTier,
    previousBeatVideoBuffer = null,
    uploadVideo,
    uploadEndframe,
    progress
  } = args || {};

  const retakenBeatIds = [];
  let prevReExtracted = false;
  let directive = '';
  let source = 'cheap_concat';
  let regressionWarning = false;

  const cb = currentBeat;
  const pb = previousBeat;

  if (!cb || !pb || !directorAgent || !router) {
    return { passed: false, secondVerdict: null, retakenBeatIds, regressionWarning, source, directive, prevReExtracted };
  }

  // ── 1. SmartSynth — runs for BOTH tiers; the directive fixes the drift on the next render of currentBeat. ──
  const personaRefUrls = (personas || [])
    .flatMap(p => Array.isArray(p?.reference_image_urls) ? p.reference_image_urls : [])
    .filter(Boolean);

  let synthResult = null;
  try {
    synthResult = await synthesizeRetakeDirective({
      verdict: previousVerdict,
      checkpoint: 'continuity',
      artifactId: cb.beat_id,
      // Lens E's primary "rejected artifact" is the CURRENT beat's
      // endframe — the one that drifted off-chain. The previous endframe
      // becomes a reference image (the "what should match" baseline).
      // SmartSynth's continuity preamble explicitly labels them.
      artifactUrl: cb.endframe_url || null,
      artifactMimeType: 'image/jpeg',
      artifactContent: {
        type: 'continuity_pair',
        previous_beat_id: pb.beat_id,
        current_beat_id: cb.beat_id,
        previous_dialogue: pb.dialogue || null,
        current_dialogue: cb.dialogue || null,
        previous_continuity_chain_broken: pb.continuity_chain_broken === true,
        current_continuity_chain_broken: cb.continuity_chain_broken === true,
        current_continuity_fallback_reason: cb.continuity_fallback_reason || null,
        scene_id: scene?.scene_id || null
      },
      referenceImages: [
        // The PREVIOUS endframe is the most important reference — what the
        // chain SHOULD match. Slot it FIRST.
        ...(pb?.endframe_url ? [{ url: pb.endframe_url, role: 'previous_endframe_baseline' }] : []),
        ...(scene?.scene_master_url ? [{ url: scene.scene_master_url, role: 'scene_master' }] : []),
        ...personaRefUrls.slice(0, 2).map(url => ({ url, role: 'persona_ref' }))
      ],
      priorAttempts: readSynthHistory({
        directorReport,
        checkpoint: 'continuity',
        artifactId: cb.beat_id
      }),
      craftContext: {
        beat_type: cb.type || null,
        scene_id: scene?.scene_id || null,
        scenario_tier: scenarioTier
      },
      logPrefix: `SmartSynth:LensE:${cb.beat_id}`
    });
    directive = synthResult.directive || '';
    source = synthResult.source || 'cheap_concat';
    regressionWarning = !!synthResult.regression_warning;
    appendSynthHistory({
      directorReport,
      checkpoint: 'continuity',
      artifactId: cb.beat_id,
      synthResult
    });
    if (typeof progress === 'function') {
      progress('director:continuity', `beat ${cb.beat_id} smart-retake (${scenarioTier}) directive synthesized (source: ${source}, conf: ${synthResult.confidence ?? '—'}, regression: ${regressionWarning})`, {
        beat_id: cb.beat_id,
        scenario_tier: scenarioTier,
        synth_source: source,
        synth_confidence: synthResult.confidence,
        regression_warning: regressionWarning
      });
    }
  } catch (synthErr) {
    logger.warn(`Lens E smart synthesis failed (${synthErr.message}) — falling back to cheap concat directive`);
    directive = (previousVerdict?.findings || [])
      .map(f => f?.message)
      .filter(Boolean)
      .slice(0, 2)
      .join(' ');
  }

  if (regressionWarning) {
    // Don't keep retaking if the score is monotonically declining.
    // Caller will quarantine + halt.
    return {
      passed: false,
      secondVerdict: null,
      retakenBeatIds,
      regressionWarning: true,
      source,
      directive,
      prevReExtracted
    };
  }

  // ── 2. Tier A — re-extract previous endframe from its video buffer. ──
  if (scenarioTier === 'A' && previousBeatVideoBuffer && pb.continuity_chain_broken === true) {
    const re = await _reExtractEndframe({
      videoBuffer: previousBeatVideoBuffer,
      beat: pb,
      uploadEndframe
    });
    if (re.ok) {
      prevReExtracted = true;
      logger.info(`[Tier A] previousBeat ${pb.beat_id} endframe re-extracted successfully`);
    } else {
      logger.warn(`[Tier A] previousBeat ${pb.beat_id} re-extraction failed (${re.error}) — proceeding to retake current beat anyway`);
    }
  }

  // ── 3. Tier B — also retake the previous beat. ──
  if (scenarioTier === 'B') {
    try {
      // Synthesize a directive for the previous beat too. priorAttempts
      // bucket is per-beat so this stays clean.
      const pbSynth = await synthesizeRetakeDirective({
        verdict: previousVerdict,
        checkpoint: 'continuity',
        artifactId: pb.beat_id,
        artifactUrl: pb.endframe_url || null,
        artifactMimeType: 'image/jpeg',
        artifactContent: {
          type: 'continuity_pair_previous',
          previous_beat_id: pb.beat_id,
          current_beat_id: cb.beat_id,
          scenario: 'tier_b_retake_both'
        },
        referenceImages: [
          ...(scene?.scene_master_url ? [{ url: scene.scene_master_url, role: 'scene_master' }] : []),
          ...personaRefUrls.slice(0, 2).map(url => ({ url, role: 'persona_ref' }))
        ],
        priorAttempts: readSynthHistory({
          directorReport,
          checkpoint: 'continuity',
          artifactId: pb.beat_id
        }),
        craftContext: { beat_type: pb.type || null, scenario_tier: 'B-prev' },
        logPrefix: `SmartSynth:LensE:${pb.beat_id}:tierB-prev`
      });
      pb.director_nudge = pbSynth.directive || directive;
      appendSynthHistory({
        directorReport,
        checkpoint: 'continuity',
        artifactId: pb.beat_id,
        synthResult: pbSynth
      });

      // Supersede the previous beat (moves its current clip into attempts_log)
      // so the regen below transitions cleanly via superseded → generating.
      supersedeBeat(pb, { reason: 'lens_e_tier_b_retake' });
      const pbResult = await router.generate({
        beat: pb, scene, refStack, personas, episodeContext, previousBeat: null
      });
      const pbUrl = await uploadVideo(pbResult.videoBuffer, `${pb.beat_id}-tierB-${Date.now()}.mp4`);
      pb.generated_video_url = pbUrl;
      pb.model_used = pbResult.modelUsed;
      pb.actual_duration_sec = pbResult.durationSec;
      // QC gate (cheap)
      try {
        pb.quality_gate = await runQualityGate({ videoBuffer: pbResult.videoBuffer, beat: pb });
      } catch {}
      // Re-extract endframe so the chain is anchored on the regenerated frame.
      try {
        const pbEndBuf = await extractBeatEndframe(pbResult.videoBuffer);
        pb.endframe_url = await uploadEndframe(pbEndBuf, `${pb.beat_id}-tierB-${Date.now()}-end.jpg`);
        pb.continuity_chain_broken = false;
        pb.endframe_extraction_error = null;
      } catch (endErr) {
        pb.continuity_chain_broken = true;
        pb.endframe_extraction_error = endErr.message;
      }
      retakenBeatIds.push(pb.beat_id);
      logger.info(`[Tier B] previousBeat ${pb.beat_id} retaken successfully`);
    } catch (pbErr) {
      logger.warn(`[Tier B] previousBeat ${pb.beat_id} retake failed (${pbErr.message}) — bailing without ground-truth fix`);
      return {
        passed: false,
        secondVerdict: null,
        retakenBeatIds,
        regressionWarning: false,
        source,
        directive,
        prevReExtracted
      };
    }
  }

  // ── 4. Stamp the current beat's nudge + supersede + regenerate. ──
  cb.director_nudge = directive || cb.director_nudge || '';
  supersedeBeat(cb, { reason: `lens_e_tier_${scenarioTier}_retake` });
  let cbResult;
  try {
    cbResult = await router.generate({
      beat: cb, scene, refStack, personas, episodeContext, previousBeat: pb
    });
  } catch (genErr) {
    logger.warn(`Lens E retake of ${cb.beat_id} failed at router.generate: ${genErr.message}`);
    return {
      passed: false,
      secondVerdict: null,
      retakenBeatIds,
      regressionWarning: false,
      source,
      directive,
      prevReExtracted
    };
  }
  const cbUrl = await uploadVideo(cbResult.videoBuffer, `${cb.beat_id}-tier${scenarioTier}-${Date.now()}.mp4`);
  cb.generated_video_url = cbUrl;
  cb.model_used = cbResult.modelUsed;
  cb.actual_duration_sec = cbResult.durationSec;
  try {
    cb.quality_gate = await runQualityGate({ videoBuffer: cbResult.videoBuffer, beat: cb });
  } catch {}
  try {
    const cbEndBuf = await extractBeatEndframe(cbResult.videoBuffer);
    cb.endframe_url = await uploadEndframe(cbEndBuf, `${cb.beat_id}-tier${scenarioTier}-${Date.now()}-end.jpg`);
    cb.continuity_chain_broken = false;
    cb.endframe_extraction_error = null;
  } catch (endErr) {
    cb.continuity_chain_broken = true;
    cb.endframe_extraction_error = endErr.message;
  }
  retakenBeatIds.push(cb.beat_id);

  // ── 5. Re-judge via Lens E. ──
  let secondVerdict = null;
  try {
    secondVerdict = await directorAgent.judgeContinuity({
      prevBeat: pb,
      currentBeat: cb,
      scene,
      prevEndframeImage: pb.endframe_url || null,
      prevEndframeMime: 'image/jpeg',
      currentEndframeImage: cb.endframe_url || null,
      currentEndframeMime: 'image/jpeg',
      continuitySheetSnapshot: snapshotForLensE(scene),
      isRetry: true
    });
    // Patch the synth history with the resulting score so the next
    // retake (if any) sees regression progression.
    patchSynthOutcome({
      directorReport,
      checkpoint: 'continuity',
      artifactId: cb.beat_id,
      resultingScore: secondVerdict?.overall_score ?? null,
      resultingVerdict: secondVerdict?.verdict ?? null
    });
    if (typeof progress === 'function') {
      progress('director:continuity', `beat ${cb.beat_id} Tier ${scenarioTier} retake re-judged: ${secondVerdict?.verdict || 'unknown'}${secondVerdict?.overall_score != null ? ` (score ${secondVerdict.overall_score})` : ''}`, {
        beat_id: cb.beat_id,
        scenario_tier: scenarioTier,
        retry: true,
        verdict: secondVerdict?.verdict,
        score: secondVerdict?.overall_score
      });
    }
  } catch (judgeErr) {
    logger.warn(`Lens E re-judge failed (${judgeErr.message}) — treating retake as unknown verdict (caller should escalate)`);
  }

  const passed = secondVerdict?.verdict === 'pass' || secondVerdict?.verdict === 'pass_with_notes';

  // Persist the new verdict on the beat for the Director Panel.
  if (secondVerdict && cb) {
    cb.lens_e_continuity_verdict = {
      verdict: secondVerdict.verdict || null,
      overall_score: secondVerdict.overall_score || null,
      dimension_scores: secondVerdict.dimension_scores || null,
      findings: Array.isArray(secondVerdict.findings) ? secondVerdict.findings.slice(0, 3) : null,
      judge_model: secondVerdict.judge_model || null,
      latency_ms: secondVerdict.latency_ms || null,
      mode: 'blocking',
      retake_tier: scenarioTier
    };
  }

  return {
    passed,
    secondVerdict,
    retakenBeatIds,
    regressionWarning,
    source,
    directive,
    prevReExtracted
  };
}

export default { runContinuitySupervisor, buildContinuitySummary, resolveLensEMode, runContinuityRetake };
