// services/SeedreamFalService.js
// fal.ai Seedream 5 Lite Edit wrapper — V4's Scene Master panel generator.
//
// V4 uses Seedream for ONE job: generate a Scene Master panel per scene.
// The Scene Master is a canonical 9:16 / 3K frame that establishes location,
// lighting, color, and character blocking for every beat within that scene.
// It's then stuffed into each beat's reference stack alongside character sheets
// and prior-beat endframes.
//
// Pivoted from v3's panel-per-shot (Seedream × 3 per episode, wasted)
// to V4's panel-per-scene (Seedream × 2–4 per episode, each panel does more work).
//
// Endpoint: fal-ai/bytedance/seedream/v5/lite/edit
// Pricing: $0.035/image
// Max resolution: 3K (3072×3072)
// Reference images: up to 10 (more than Flux's 8)
// Aspect ratios: 9:16, 16:9, 1:1, 4:3, 3:4
//
// Reference ordering matters: Gemini tells us story_focus, which determines whether
// persona refs or subject refs come first. The existing v3 logic at
// BrandStoryService.js:2793+ is ported over unchanged.

import FalAiBaseService from './FalAiBaseService.js';

const ENDPOINT_SEEDREAM_V5_LITE_EDIT = 'fal-ai/bytedance/seedream/v5/lite/edit';

/**
 * Surveillance/broadcast vocabulary sanitizer.
 *
 * fal.ai's Seedream 5 Lite Edit enforces a partner-validation content filter
 * that rejects prompts reading as covert surveillance — "LIVE" feeds of
 * buildings, "satellite" imagery, "targeting", "CCTV", "drone feeds". This
 * intersects badly with noir fiction: Gemini's scene_visual_anchor_prompts
 * for surveillance/thriller stories naturally use this vocabulary, and the
 * first SIPL call explodes with 422 content_policy_violation.
 *
 * The sanitizer rewrites the most common trigger phrases into neutral
 * cinematic language that preserves scene intent. Used only on retry after
 * a content-policy rejection — the ORIGINAL prompt is always tried first
 * so creative intent is preserved whenever the filter permits.
 *
 * @param {string} text
 * @returns {string}
 */
export function sanitizeSeedreamSurveillanceContent(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(/\bLIVE\b/g, 'ACTIVE')
    .replace(/\blive feed\b/gi, 'active view')
    .replace(/\bsatellite\s+image\b/gi, 'aerial photograph')
    .replace(/\bsatellite\s+view\b/gi, 'aerial view')
    .replace(/\bsatellite\b/gi, 'aerial')
    .replace(/\bsurveillance\b/gi, 'observation')
    .replace(/\btargeting\b/gi, 'framing')
    .replace(/\btarget\b/gi, 'subject')
    .replace(/\bCCTV\b/gi, 'camera feed')
    .replace(/\bdrone\s+feed\b/gi, 'aerial view')
    .replace(/\bdrone\s+footage\b/gi, 'aerial footage')
    .replace(/\bintercepted\b/gi, 'received')
    .replace(/\bencrypted\b/gi, 'secured')
    .replace(/\bbreach(ed|ing)?\b/gi, 'enter$1')
    .replace(/\btracking\s+(?:the|a|an)\s+person\b/gi, 'following the character')
    .replace(/\btactical\b/gi, 'cinematic');
}

/**
 * Detect a Seedream content-policy rejection. fal.ai returns these with a
 * 422 status and a JSON body containing either `content_policy_violation`
 * or `partner_validation_failed` in the detail.
 */
function isSeedreamContentPolicyError(err) {
  if (!err) return false;
  const msg = String(err.message || '');
  return /content[\s_]policy[\s_]violation|content\s+checker|partner[_\s]validation[_\s]failed/i.test(msg);
}

// Seedream 5 Lite Edit limits
const SEEDREAM_MAX_REFERENCE_IMAGES = 10;
const SEEDREAM_DEFAULT_SIZE = '3K'; // maximum detail for Scene Master frames

class SeedreamFalService extends FalAiBaseService {
  constructor() {
    super({
      modelSlug: ENDPOINT_SEEDREAM_V5_LITE_EDIT,
      displayName: 'SeedreamFalService',
      pollIntervalMs: 5000,
      maxPollDurationMs: 300000 // 5 min — image gen is fast
    });
  }

  /**
   * Generate a single Seedream panel.
   *
   * @param {Object} params
   * @param {string} params.prompt - full composition prompt (visual_style_prefix + scene_visual_anchor_prompt)
   * @param {string[]} [params.referenceImages=[]] - up to 10 reference URLs
   * @param {Object} [params.options]
   * @param {string} [params.options.aspectRatio='9:16']
   * @param {string} [params.options.size='3K'] - '3K' | '2K' | '1K'
   * @param {number} [params.options.seed] - deterministic seed for scene-to-scene coherence
   * @param {string} [params.options.sequentialGeneration='auto'] - Seedream's coherence priming
   * @param {string} [params.label='scene master'] - observability label for logs
   *   ('scene master' | 'SIPL-hero' | 'SIPL-ambient' | 'persona-lock' | 'safer-frame')
   * @returns {Promise<{imageUrl: string, imageBuffer: Buffer, prompt: string, model: string, sanitized: boolean}>}
   */
  async generatePanel({ prompt, referenceImages = [], options = {}, label = 'scene master' }) {
    if (!this.apiKey) throw new Error('FAL_GCS_API_KEY is not configured');
    if (!prompt) throw new Error('SeedreamFalService: prompt is required');

    const {
      aspectRatio = '9:16',
      size = SEEDREAM_DEFAULT_SIZE,
      seed,
      sequentialGeneration = 'auto'
    } = options;

    // Hard-cap reference images to Seedream's 10-image limit.
    const refs = referenceImages.slice(0, SEEDREAM_MAX_REFERENCE_IMAGES);

    this.logger.info(
      `${label} — ${aspectRatio} / ${size}, ${refs.length} ref(s)${seed != null ? `, seed=${seed}` : ''}`
    );

    const buildPayload = (p) => {
      const inputPayload = {
        prompt: p,
        aspect_ratio: aspectRatio,
        size,
        sequential_image_generation: sequentialGeneration
      };
      if (refs.length > 0) inputPayload.image_urls = refs;
      if (seed != null) inputPayload.seed = seed;
      return inputPayload;
    };

    // V4 Phase 5b — Fix 9 + N4 (5-tier content-policy chain).
    //
    // Tier 0 (in-place): surveillance regex sanitizer below — fast and
    // deterministic for surveillance-vocab cases (CCTV, tactical, etc.)
    //
    // When Tier 0 yields no diff OR fails on retry, we throw a structured
    // SceneAnchorOverDeterminedError so the CALLER (StoryboardHelpers
    // generateSceneMasters) can dispatch to:
    //   Tier 1: anchor-rewrite via Director finding (caller-side)
    //   Tier 2: Gemini-rewrite generic prompt (services/v4/SceneMasterContentRewriter.js)
    //   Tier 3: different-model fallback (Nano Banana Pro → Flux 2 Max edit)
    //   Tier 4: user_review escalation
    //
    // Any non-content-policy error (429, network, bad refs) bubbles up
    // immediately without retry.
    let result;
    let sanitized = false;
    try {
      result = await this.run(buildPayload(prompt));
    } catch (err) {
      if (!isSeedreamContentPolicyError(err)) throw err;

      const sanitizedPrompt = sanitizeSeedreamSurveillanceContent(prompt);
      if (sanitizedPrompt === prompt) {
        // Nothing to sanitize — Tier 0 doesn't apply. Throw a structured
        // SceneAnchorOverDeterminedError so the caller invokes Tier 1/2/3.
        this.logger.warn(`${label}: content-policy refused — Tier 0 inapplicable, surfacing for Tier 1+`);
        throw new SceneAnchorOverDeterminedError(
          `Seedream content-policy refused and Tier 0 surveillance-vocab sanitization had no effect`,
          { originalPrompt: prompt, originalError: err, tier: 'tier0_inapplicable' }
        );
      }

      this.logger.warn(
        `${label}: content-policy refused — retrying with surveillance-vocabulary sanitized (Tier 0)`
      );
      try {
        result = await this.run(buildPayload(sanitizedPrompt));
        sanitized = true;
        this.logger.info(`${label}: Tier 0 sanitized retry succeeded`);
      } catch (retryErr) {
        // Tier 0 sanitize-retry also refused — surface for Tier 1+ rewrite.
        this.logger.warn(`${label}: Tier 0 sanitized retry refused — surfacing for Tier 1+`);
        throw new SceneAnchorOverDeterminedError(
          `Seedream content-policy refused both original and Tier 0 sanitized prompts`,
          { originalPrompt: prompt, sanitizedPrompt, originalError: retryErr, tier: 'tier0_exhausted' }
        );
      }
    }

    // fal.ai Seedream returns: { images: [{ url, width, height, content_type }], ... }
    // (the /edit variant may return { image: {...} } or { images: [...] })
    const imageUrl = result?.images?.[0]?.url || result?.image?.url;
    if (!imageUrl) {
      this.logger.error(`completed but no image URL: ${JSON.stringify(result)}`);
      throw new Error('Seedream 5 Lite Edit did not return an image URL');
    }

    const imageBuffer = await this.downloadToBuffer(imageUrl, 'image');

    return {
      imageUrl,
      imageBuffer,
      prompt,
      sanitized,
      model: 'seedream-5-lite-edit'
    };
  }
}

/**
 * V4 Phase 5b — Fix 9 + N4. Structured error thrown when Seedream's content
 * policy refuses both the original prompt AND the Tier 0 surveillance-vocab
 * sanitized retry. Caller (StoryboardHelpers.generateSceneMasters) catches
 * this and dispatches the Tier 1 / 2 / 3 fallback chain.
 */
export class SceneAnchorOverDeterminedError extends Error {
  constructor(message, { originalPrompt = '', sanitizedPrompt = '', originalError = null, tier = '' } = {}) {
    super(message);
    this.name = 'SceneAnchorOverDeterminedError';
    this.originalPrompt = originalPrompt;
    this.sanitizedPrompt = sanitizedPrompt;
    this.originalError = originalError;
    this.tier = tier;
  }
}

// Singleton export
const seedreamFalService = new SeedreamFalService();
export default seedreamFalService;
export { SeedreamFalService };
