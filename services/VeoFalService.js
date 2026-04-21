// services/VeoFalService.js
// fal.ai Veo 3.1 wrapper for the V4 Brand Story pipeline.
//
// V4 uses Veo 3.1 Standard for two specific capabilities Kling cannot match:
//
//   1. First/last frame anchoring on short clips — perfect for REACTION beats
//      (2–4s silent closeups with explicit emotional arc start→end control) and
//      INSERT_SHOT beats (2–4s product hero shots with pristine frame control).
//
//   2. Native ambient audio generation — wind, traffic, distant voices, room
//      tone synchronized with the video. Unique to Veo. Used for B_ROLL_ESTABLISHING
//      (atmospheric beats) and VOICEOVER_OVER_BROLL (ambient bed + V.O. swap).
//
// Endpoint: fal-ai/veo3.1/first-last-frame-to-video
// Pricing: $0.20/s no-audio, $0.40/s with audio @ 1080p (Standard tier)
// Max duration: 8s per generation (hard ceiling at this endpoint)
// Aspect ratios: 9:16, 16:9, 1:1
//
// Fast tier cost optimization: B_ROLL_ESTABLISHING beats can route to the Fast
// tier via the `tier: 'fast'` option once the fal.ai parameter shape for Fast
// is confirmed on Day 0 smoke test #5. Until then, all beats use Standard.
//
// Content filter fallback tiers (inherited from v3 _runVeoFallbackPipeline):
//   Tier 1 — first + last frame + full prompt (primary)
//   Tier 2 — first frame only + enriched prompt with end_frame_description
//   Tier 3 — text-only with full storyboard prompt as composition guide

import FalAiBaseService from './FalAiBaseService.js';

const ENDPOINT_FIRST_LAST_FRAME = 'fal-ai/veo3.1/first-last-frame-to-video';

// Veo 3.1 hard limits at the first-last-frame endpoint
const VEO_MIN_DURATION = 2;
const VEO_MAX_DURATION = 8;

/**
 * Clamp a value to [min, max].
 */
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

class VeoFalService extends FalAiBaseService {
  constructor() {
    super({
      modelSlug: ENDPOINT_FIRST_LAST_FRAME,
      displayName: 'VeoFalService',
      // Veo LRO jobs can take 1-4 minutes; keep a generous ceiling.
      pollIntervalMs: 10000,
      maxPollDurationMs: 900000 // 15 min
    });
  }

  /**
   * Generate a beat via Veo 3.1 with first/last frame anchoring.
   * Primary path — tier 1 of the content filter fallback chain.
   *
   * @param {Object} params
   * @param {string} params.firstFrameUrl - start frame (REQUIRED)
   * @param {string} [params.lastFrameUrl] - end frame (optional but recommended for anchoring)
   * @param {string} params.prompt - scene description
   * @param {Object} [params.options]
   * @param {number} [params.options.duration=4] - 2–8s (Veo ceiling)
   * @param {string} [params.options.aspectRatio='9:16']
   * @param {boolean} [params.options.generateAudio=true] - Veo's native ambient audio is the point for B_ROLL
   * @param {string} [params.options.tier='standard'] - 'standard' | 'fast' | 'lite' (Day 0 verification pending)
   * @param {string} [params.options.negativePrompt]
   * @returns {Promise<{videoUrl: string, videoBuffer: Buffer, duration: number, model: string, fallbackTier: number}>}
   */
  async generateWithFrames({ firstFrameUrl = null, lastFrameUrl = null, prompt, options = {} }) {
    // firstFrameUrl is optional — B-roll / text-only beats can pass null.
    // When null, we skip tier 1 + tier 2 and go straight to text-only (tier 3).
    if (!prompt) throw new Error('VeoFalService: prompt is required');

    const {
      duration = 4,
      aspectRatio = '9:16',
      generateAudio = true,
      tier = 'standard',
      negativePrompt = ''
    } = options;

    const clampedDuration = clamp(duration, VEO_MIN_DURATION, VEO_MAX_DURATION);
    if (clampedDuration !== duration) {
      this.logger.warn(`duration ${duration}s clamped to ${clampedDuration}s (Veo 8s ceiling)`);
    }

    // Skip tiers 1+2 when firstFrameUrl is absent — jump straight to text-only.
    if (!firstFrameUrl) {
      this.logger.info(`no firstFrameUrl — going text-only (tier 3)`);
      const result = await this._attemptGeneration({
        firstFrameUrl: null,
        lastFrameUrl: null,
        prompt,
        duration: clampedDuration,
        aspectRatio,
        generateAudio,
        tier,
        negativePrompt
      });
      return { ...result, fallbackTier: 3 };
    }

    // ─── Tier 1 — first + last frame + full prompt ───
    try {
      const result = await this._attemptGeneration({
        firstFrameUrl,
        lastFrameUrl,
        prompt,
        duration: clampedDuration,
        aspectRatio,
        generateAudio,
        tier,
        negativePrompt
      });
      return { ...result, fallbackTier: 1 };
    } catch (err) {
      if (!this._isContentFilterError(err)) throw err;
      this.logger.warn(`Tier 1 content filter — retrying with first frame only`);
    }

    // ─── Tier 2 — first frame only, enriched prompt ───
    // The beat generator should pass an enriched prompt via options.enrichedPromptTier2
    // if end_frame_description was available. Otherwise reuse the primary prompt.
    const tier2Prompt = options.enrichedPromptTier2 || prompt;
    try {
      const result = await this._attemptGeneration({
        firstFrameUrl,
        lastFrameUrl: null,
        prompt: tier2Prompt,
        duration: clampedDuration,
        aspectRatio,
        generateAudio,
        tier,
        negativePrompt
      });
      return { ...result, fallbackTier: 2 };
    } catch (err) {
      if (!this._isContentFilterError(err)) throw err;
      this.logger.warn(`Tier 2 content filter — retrying text-only`);
    }

    // ─── Tier 3 — text-only, no frame anchors ───
    const tier3Prompt = options.enrichedPromptTier3 || tier2Prompt;
    const result = await this._attemptGeneration({
      firstFrameUrl: null,
      lastFrameUrl: null,
      prompt: tier3Prompt,
      duration: clampedDuration,
      aspectRatio,
      generateAudio,
      tier,
      negativePrompt
    });
    return { ...result, fallbackTier: 3 };
  }

  /**
   * Internal: single attempt against fal.ai Veo endpoint.
   * Handles the actual payload build + submit + download.
   */
  async _attemptGeneration({
    firstFrameUrl,
    lastFrameUrl,
    prompt,
    duration,
    aspectRatio,
    generateAudio,
    tier,
    negativePrompt
  }) {
    const inputPayload = {
      prompt,
      aspect_ratio: aspectRatio,
      duration,
      generate_audio: generateAudio
    };

    if (firstFrameUrl) inputPayload.first_frame_image_url = firstFrameUrl;
    if (lastFrameUrl) inputPayload.last_frame_image_url = lastFrameUrl;
    if (negativePrompt) inputPayload.negative_prompt = negativePrompt;

    // Tier selector: Day 0 smoke test #5 will confirm the exact parameter name.
    // Candidates: `model` (values: standard|fast|lite), `tier`, or a path suffix.
    // For Phase 1a we default to Standard and leave Fast/Lite stubbed.
    if (tier && tier !== 'standard') {
      inputPayload.model = tier; // tentative — verify on Day 0
    }

    const anchors = [];
    if (firstFrameUrl) anchors.push('first');
    if (lastFrameUrl) anchors.push('last');
    this.logger.info(
      `Veo ${tier} — ${duration}s, ${aspectRatio}, anchors: [${anchors.join(', ') || 'none'}], audio=${generateAudio}`
    );

    const result = await this.run(inputPayload);

    // fal.ai Veo returns: { video: { url, content_type, ... } }
    const videoUrl = result?.video?.url;
    if (!videoUrl) {
      this.logger.error(`completed but no video URL: ${JSON.stringify(result)}`);
      throw new Error('Veo 3.1 API did not return a video URL');
    }

    const videoBuffer = await this.downloadToBuffer(videoUrl, 'video');

    return {
      videoUrl,
      videoBuffer,
      duration,
      model: `veo-3.1-${tier}`
    };
  }

  /**
   * Heuristic: did this error come from Veo's content filter?
   * Content filter errors are typically surfaced in the error message with
   * keywords like "safety", "content policy", "filtered", "violates".
   */
  _isContentFilterError(err) {
    const msg = (err?.message || '').toLowerCase();
    return (
      msg.includes('safety') ||
      msg.includes('content policy') ||
      msg.includes('filtered') ||
      msg.includes('violates') ||
      msg.includes('blocked') ||
      msg.includes('content filter')
    );
  }
}

// Singleton export
const veoFalService = new VeoFalService();
export default veoFalService;
export { VeoFalService };
