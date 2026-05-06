// services/VeoService.js
// V4 Veo 3.1 adapter — ALWAYS uses Vertex AI via VideoGenerationService.
//
// Why Vertex (not fal.ai):
//   Veo 3.1 Standard on Vertex AI is FREE for this GCP project under the
//   user's existing quota arrangement. fal.ai's Veo endpoint costs ~$0.40/s
//   with audio. For V4 — which picks Veo for REACTION, INSERT_SHOT,
//   B_ROLL_ESTABLISHING, and VOICEOVER_OVER_BROLL beats — routing through
//   Vertex turns what would be ~$6–10 of beat generation per episode into
//   $0. This is a direct cost-of-goods win that was almost lost in the
//   Phase 1b build before the user caught the mistake.
//
// Architecture:
//   This file is a thin adapter on top of
//   videoGenerationService.generateWithFirstLastFrame() — the v2/v3 Vertex
//   Veo path that's already production-tested. Nothing about the Vertex
//   auth, LRO polling, content filter detection, or error handling is
//   duplicated; it's all inherited from the battle-tested implementation
//   in services/VideoGenerationService.js.
//
//   The adapter's only job is to:
//     1. Expose the same `generateWithFrames({firstFrameUrl, lastFrameUrl,
//        prompt, options})` interface the V4 beat generators were built
//        against (so beat generators stay backend-agnostic).
//     2. Translate field names: firstFrameUrl → firstImageUrl,
//        lastFrameUrl → lastImageUrl, options.duration → options.durationSeconds.
//     3. Normalize the return shape: add `fallbackTier: 1` to match the
//        interface contract the beat generators' metadata expects.
//
// Replaces:
//   services/VeoFalService.js — that file remains on disk but is no longer
//   imported anywhere in V4. Scheduled for deletion in Phase 1c cleanup.

import videoGenerationService from './VideoGenerationService.js';
import winston from 'winston';
import { isVeoContentFilterError, isImageContentFilterError, sanitizeTier1, sanitizeTier2 } from './v4/VeoPromptSanitizer.js';
import VeoFailureCollector from './v4/VeoFailureCollector.js';
import { getVeoFailureKnowledge } from './v4/VeoFailureGuidance.js';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `[VeoService] ${timestamp} [${level}]: ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

class VeoService {
  constructor() {
    this._available = null; // lazy-evaluated
    logger.info('VeoService initialized (Vertex AI backend via VideoGenerationService)');
  }

  /**
   * Check whether Vertex Veo is configured + ready to serve requests.
   * Delegates to VideoGenerationService's internal state — no direct env check.
   */
  isAvailable() {
    if (this._available != null) return this._available;
    // VideoGenerationService exposes `this.vertexAuth` + `this.gcpProjectId`
    // as instance fields. A healthy Vertex config means both are set.
    const ok = !!(videoGenerationService?.vertexAuth && videoGenerationService?.gcpProjectId);
    this._available = ok;
    if (!ok) {
      logger.warn('VeoService: Vertex auth not configured — GCP_PROJECT_ID + GOOGLE_APPLICATION_CREDENTIALS_JSON required');
    }
    return ok;
  }

  /**
   * Generate a beat video using Veo 3.1 Standard on Vertex AI with optional
   * first/last frame anchoring. Interface matches the legacy VeoFalService
   * contract so the V4 beat generators (Reaction, InsertShot, BRoll,
   * VoiceoverBRoll) don't need to change.
   *
   * @param {Object} params
   * @param {string} [params.firstFrameUrl] - public URL of the start frame (required for anchored beats; null for text-only)
   * @param {string} [params.lastFrameUrl] - public URL of the end frame (optional; ignored if firstFrameUrl is null)
   * @param {string} params.prompt - scene description passed to Veo
   * @param {Object} [params.options]
   * @param {number} [params.options.duration=4] - target duration in seconds (2–8 clamped by Veo 3.1 Standard)
   * @param {string} [params.options.aspectRatio='9:16']
   * @param {boolean} [params.options.generateAudio=true] - Veo generates native ambient audio (unique vs Kling)
   * @param {string} [params.options.tier='standard'] - kept for API-compat; Vertex only has Standard
   * @returns {Promise<{videoUrl: string, videoBuffer: Buffer, duration: number, model: string, fallbackTier: number}>}
   */
  async generateWithFrames({
    firstFrameUrl = null,
    lastFrameUrl = null,
    prompt,
    options = {}
  } = {}) {
    if (!prompt) throw new Error('VeoService.generateWithFrames: prompt is required');

    if (!this.isAvailable()) {
      throw new Error('Vertex AI Veo is not configured — set GCP_PROJECT_ID and GOOGLE_APPLICATION_CREDENTIALS_JSON');
    }

    const {
      duration = 4,
      aspectRatio = '9:16',
      // regenerateSafeFirstFrame: optional async () => string callback provided by
      // beat generators. When an IMAGE violation is detected, this is called ONCE
      // to produce a safer reference frame (reduced refs + safe-mode prompt) before
      // falling all the way to text-only (tier3-no-image). If not provided, the
      // existing fast-jump to tier3 applies unchanged (back-compat).
      regenerateSafeFirstFrame = null,
      // telemetry: optional context the caller passes through for the Veo
      // Failure-Learning Agent. The collector ignores missing fields gracefully —
      // any non-empty subset is useful (a userId alone makes the row queryable
      // per-tenant; a beatId + beatType makes it queryable per-cluster).
      // Shape: { userId, episodeId, beatId, beatType }
      telemetry = {}
      // generateAudio and tier are ignored on Vertex — Veo 3.1 Standard always
      // generates audio and is always the highest tier on this backend.
    } = options;

    // Clamp duration to Veo 3.1 Standard's 2–8s window (same as fal.ai first-last-frame).
    const clampedDuration = Math.max(2, Math.min(8, duration));
    if (clampedDuration !== duration) {
      logger.warn(`duration ${duration}s clamped to ${clampedDuration}s (Veo 3.1 Standard 2–8s window)`);
    }

    logger.info(
      `generateWithFrames — ${clampedDuration}s, ${aspectRatio}, first=${firstFrameUrl ? 'yes' : 'no'}, last=${lastFrameUrl && firstFrameUrl ? 'yes' : 'no'}`
    );

    // ──────────────────────────────────────────────────────────
    // Four-tier content-filter retry. Vertex AI Veo produces two
    // distinct rejection types that require different remediation:
    //
    //   PROMPT rejection ("could not be submitted … words that
    //   violate"): text sanitisation fixes this.
    //     Tier 0 → Tier 1 (strip persona names + body parts)
    //                → Tier 2 (minimal boilerplate, no personas)
    //
    //   IMAGE rejection ("input image violates"): the first_frame
    //   image was rejected by Vertex's image-safety filter. No
    //   amount of prompt text changes fixes this. Fast-path to:
    //     Tier 3 (text-only, no first_frame / last_frame)
    //
    // The 4-tier approach ensures image rejections no longer burn
    // two useless prompt-sanitisation round-trips before giving up.
    // Only content-filter errors trigger retry; any other error
    // (429, network, auth) bubbles up immediately.
    // ──────────────────────────────────────────────────────────
    const personaNames = Array.isArray(options.personaNames) ? options.personaNames : [];
    const sanitizationContext = options.sanitizationContext || {};
    const tier2Prompt = sanitizeTier2(sanitizationContext);

    // ──────────────────────────────────────────────────────────
    // Pre-flight rule pass — Veo Failure-Learning Agent (2026-05-06).
    //
    // Apply deterministic regex rewrites for known-bad phrasings BEFORE the
    // first submission, not only after rejection. The knowledge file is
    // regenerated nightly by VeoFailureKnowledgeBuilder from production
    // failure telemetry. When the file is empty / facade fails to load,
    // we fall through to the original prompt unchanged — the pre-flight
    // pass MUST never block generation.
    // ──────────────────────────────────────────────────────────
    let preflightPrompt = prompt;
    try {
      const knowledge = await getVeoFailureKnowledge();
      if (knowledge && typeof knowledge.applyPreflightRules === 'function') {
        const { prompt: rewritten, rewrites } = knowledge.applyPreflightRules(prompt, {
          modelId: 'veo-3.1-vertex',
          personaNames
        });
        if (rewrites && rewrites.length > 0) {
          const summary = rewrites.map(r => `${r.key}×${r.count}`).join(', ');
          logger.info(`pre-flight rules rewrote prompt (${summary})`);
          preflightPrompt = rewritten;
        }
      }
    } catch (preflightErr) {
      // Never block generation — log and continue with the original prompt.
      logger.warn(`pre-flight rules unavailable (${preflightErr.message}) — using original prompt`);
    }

    const attempts = [
      {
        label: 'original',
        prompt: preflightPrompt,
        firstFrame: firstFrameUrl,
        lastFrame: lastFrameUrl && firstFrameUrl ? lastFrameUrl : null
      },
      {
        label: 'tier1-sanitised',
        // Apply the pre-flight pass first (so any agent-learned rewrites
        // carry into tier 1), then layer the static tier-1 sanitiser on top.
        prompt: sanitizeTier1(preflightPrompt, personaNames),
        firstFrame: firstFrameUrl,
        lastFrame: null  // drop last frame on first text retry
      },
      {
        label: 'tier2-minimal',
        prompt: tier2Prompt,
        firstFrame: firstFrameUrl,
        lastFrame: null
      },
      {
        label: 'tier3-no-image',
        prompt: tier2Prompt,
        firstFrame: null,  // text-only — image dropped entirely
        lastFrame: null
      }
    ];

    let lastErr = null;
    let attemptUsed = null;
    let result = null;
    let attemptIndex = 0;
    let _tier25Attempted = false; // guard: only one regen attempt per generateWithFrames call
    const _t0 = Date.now();
    let _attemptCount = 0; // including the original

    while (attemptIndex < attempts.length) {
      const attempt = attempts[attemptIndex];
      _attemptCount++;
      try {
        result = await videoGenerationService.generateWithFirstLastFrame({
          firstImageUrl: attempt.firstFrame,
          lastImageUrl: attempt.lastFrame,
          prompt: attempt.prompt,
          cameraControl: null,
          options: { durationSeconds: clampedDuration, aspectRatio }
        });
        attemptUsed = attempt.label;
        if (attemptIndex > 0) {
          logger.warn(
            `Veo accepted ${attempt.label} after earlier refusal ` +
            `(first_frame=${attempt.firstFrame ? 'yes' : 'none'})`
          );
        }
        break;
      } catch (err) {
        lastErr = err;
        if (!isVeoContentFilterError(err)) {
          // Non-safety errors bubble up immediately (429, network, auth, etc.)
          // Record the non-safety failure so the agent learns these too
          // (e.g. high_load, rate_limit, polling_timeout, auth) — fire-and-forget.
          VeoFailureCollector.record({
            userId: telemetry.userId,
            episodeId: telemetry.episodeId,
            beatId: telemetry.beatId,
            beatType: telemetry.beatType,
            error: err,
            prompt,
            personaNames,
            hadFirstFrame: !!firstFrameUrl,
            hadLastFrame: !!(lastFrameUrl && firstFrameUrl),
            durationSec: clampedDuration,
            aspectRatio,
            modelAttempted: 'veo-3.1-vertex',
            attemptTierReached: attempt.label,
            recoverySucceeded: false,
            attemptCount: _attemptCount,
            totalDurationMs: Date.now() - _t0
          }).catch(() => {});
          throw err;
        }

        // IMAGE violation: changing prompt text is ineffective — the first_frame
        // image itself triggered Vertex's safety filter. Two-step response:
        //
        //   Step 1 (tier 2.5): if the caller provided a `regenerateSafeFirstFrame`
        //     callback, invoke it ONCE to produce a safer reference frame (reduced
        //     reference stack, safe-mode composition prompt). Retry Veo with that.
        //     This preserves persona/product identity on ~80% of IMAGE violations
        //     without burning quota on useless prompt-sanitisation round-trips.
        //
        //   Step 2 (tier 3): if the regen frame is ALSO rejected, OR no callback
        //     was provided, fall to text-only (existing behavior). The flagged URL
        //     is logged so the Director Panel can surface it for user inspection.
        if (isImageContentFilterError(err) && attempt.firstFrame !== null) {
          if (typeof regenerateSafeFirstFrame === 'function' && !_tier25Attempted) {
            _tier25Attempted = true;
            logger.warn(
              `Veo refused ${attempt.label} — IMAGE violation. ` +
              `Flagged first_frame: ${attempt.firstFrame}. ` +
              `Attempting tier2.5-regen-frame before falling to text-only.`
            );
            try {
              const saferFrameUrl = await regenerateSafeFirstFrame();
              if (saferFrameUrl) {
                // Insert a one-shot attempt with the regenerated frame. On success
                // this breaks out of the while-loop; on IMAGE violation we fall
                // through to tier3 (outer catch will set _tier25Attempted=true again
                // but the guard prevents infinite looping since we check !_tier25Attempted).
                result = await videoGenerationService.generateWithFirstLastFrame({
                  firstImageUrl: saferFrameUrl,
                  lastImageUrl: null,
                  prompt: attempt.prompt,
                  cameraControl: null,
                  options: { durationSeconds: clampedDuration, aspectRatio }
                });
                attemptUsed = 'tier2.5-regen-frame';
                logger.warn(`Veo accepted tier2.5-regen-frame (safe-mode first frame preserved persona/product reference)`);
                break;
              }
            } catch (regenErr) {
              if (isImageContentFilterError(regenErr)) {
                logger.warn(`Veo refused tier2.5-regen-frame — IMAGE violation persists. Falling to tier3-no-image.`);
              } else {
                logger.warn(`tier2.5-regen-frame error (${regenErr.message.slice(0, 120)}). Falling to tier3-no-image.`);
              }
            }
          } else {
            logger.warn(
              `Veo refused ${attempt.label} — IMAGE violation (not prompt text). ` +
              `Flagged first_frame: ${attempt.firstFrame}. ` +
              `Escalating directly to text-only tier (tier3-no-image).`
            );
          }
          attemptIndex = attempts.findIndex(a => a.label === 'tier3-no-image');
          continue;
        }

        logger.warn(`Veo refused ${attempt.label} prompt (content filter) — ${err.message.slice(0, 180)}`);
        attemptIndex++;
      }
    }

    if (!result) {
      // All tiers refused (including text-only). Record the hard failure
      // for the Veo Failure-Learning Agent (fire-and-forget) BEFORE throwing,
      // so a Director Agent halt cycle can't suppress the telemetry.
      VeoFailureCollector.record({
        userId: telemetry.userId,
        episodeId: telemetry.episodeId,
        beatId: telemetry.beatId,
        beatType: telemetry.beatType,
        error: lastErr,
        prompt,
        personaNames,
        hadFirstFrame: !!firstFrameUrl,
        hadLastFrame: !!(lastFrameUrl && firstFrameUrl),
        durationSec: clampedDuration,
        aspectRatio,
        modelAttempted: 'veo-3.1-vertex',
        attemptTierReached: 'hard_failed',
        recoverySucceeded: false,
        attemptCount: _attemptCount,
        totalDurationMs: Date.now() - _t0
      }).catch(() => {});

      // Final error carries the original prompt for downstream diagnosis + quality_report.
      const finalErr = new Error(
        `Veo refused all sanitisation tiers including text-only (tier3-no-image). Original prompt first 180 chars: "${prompt.slice(0, 180)}"`
      );
      finalErr.originalError = lastErr;
      finalErr.isVeoContentFilter = true;
      throw finalErr;
    }

    // Recovery telemetry — Veo accepted at a non-original tier. Captures the
    // signal that "tier X works for failure mode Y", which is what makes the
    // agent's prompt_avoid_phrases / prompt_safe_alternatives meaningful.
    if (attemptUsed && attemptUsed !== 'original' && lastErr) {
      VeoFailureCollector.record({
        userId: telemetry.userId,
        episodeId: telemetry.episodeId,
        beatId: telemetry.beatId,
        beatType: telemetry.beatType,
        error: lastErr,
        prompt,
        personaNames,
        hadFirstFrame: !!firstFrameUrl,
        hadLastFrame: !!(lastFrameUrl && firstFrameUrl),
        durationSec: clampedDuration,
        aspectRatio,
        modelAttempted: 'veo-3.1-vertex',
        attemptTierReached: attemptUsed,
        recoverySucceeded: true,
        attemptCount: _attemptCount,
        totalDurationMs: Date.now() - _t0
      }).catch(() => {});
    }

    // 2026-05-06 — surface the REAL content-filter tier so beat generators
    // can decide whether the result is anchor-safe. The previous hardcoded
    // `fallbackTier: 1` made tier3-no-image (text-only, NO first-frame
    // anchor) indistinguishable from tier1 success, which caused
    // VeoActionGenerator to ship unanchored text-only output → guaranteed
    // face drift → Director Agent hard_reject → episode halt.
    //
    // Mapping:
    //   1 = original (with anchor) — clean success
    //   2 = tier1-sanitised (with anchor) — minor prompt scrub, still anchored
    //   3 = tier2-minimal (with anchor) — heavy scrub, still anchored
    //   4 = tier2.5-regen-frame — caller's regen-frame callback recovered the anchor
    //   5 = tier3-no-image — TEXT-ONLY fallback (NO ANCHOR; high identity-drift risk)
    //
    // Callers MUST treat tier === 5 as a content-filter persistent failure
    // and route to a different model (Kling for action; OmniHuman for
    // dialogue) rather than trust the unanchored Veo output.
    const TIER_MAP = {
      'original': 1,
      'tier1-sanitised': 2,
      'tier2-minimal': 3,
      'tier2.5-regen-frame': 4,
      'tier3-no-image': 5
    };
    const realFallbackTier = TIER_MAP[attemptUsed] || 1;
    const usedFirstFrame = attemptUsed !== 'tier3-no-image';

    return {
      videoUrl: result.videoUrl,
      videoBuffer: result.videoBuffer,
      duration: result.duration,
      model: 'veo-3.1-vertex',
      fallbackTier: realFallbackTier,
      usedFirstFrame,
      sanitizationTier: attemptUsed // 'original' | 'tier1-sanitised' | 'tier2-minimal' | 'tier2.5-regen-frame' | 'tier3-no-image'
    };
  }
}

// Singleton export — beat generators import the default
const veoService = new VeoService();
export default veoService;
export { VeoService };
