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
      aspectRatio = '9:16'
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

    const attempts = [
      {
        label: 'original',
        prompt,
        firstFrame: firstFrameUrl,
        lastFrame: lastFrameUrl && firstFrameUrl ? lastFrameUrl : null
      },
      {
        label: 'tier1-sanitised',
        prompt: sanitizeTier1(prompt, personaNames),
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

    while (attemptIndex < attempts.length) {
      const attempt = attempts[attemptIndex];
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
          throw err;
        }

        // IMAGE violation: changing prompt text is ineffective — jump directly
        // to text-only tier to avoid wasting two prompt-sanitisation round-trips.
        if (isImageContentFilterError(err) && attempt.firstFrame !== null) {
          logger.warn(
            `Veo refused ${attempt.label} — IMAGE violation (not prompt text). ` +
            `Escalating directly to text-only tier (tier3-no-image).`
          );
          attemptIndex = attempts.findIndex(a => a.label === 'tier3-no-image');
          continue;
        }

        logger.warn(`Veo refused ${attempt.label} prompt (content filter) — ${err.message.slice(0, 180)}`);
        attemptIndex++;
      }
    }

    if (!result) {
      // All tiers refused (including text-only). Final error carries the
      // original prompt for downstream diagnosis + quality_report.
      const finalErr = new Error(
        `Veo refused all sanitisation tiers including text-only (tier3-no-image). Original prompt first 180 chars: "${prompt.slice(0, 180)}"`
      );
      finalErr.originalError = lastErr;
      finalErr.isVeoContentFilter = true;
      throw finalErr;
    }

    return {
      videoUrl: result.videoUrl,
      videoBuffer: result.videoBuffer,
      duration: result.duration,
      model: 'veo-3.1-vertex',
      fallbackTier: 1,
      sanitizationTier: attemptUsed // 'original' | 'tier1-sanitised' | 'tier2-minimal'
    };
  }
}

// Singleton export — beat generators import the default
const veoService = new VeoService();
export default veoService;
export { VeoService };
