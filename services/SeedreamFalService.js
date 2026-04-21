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
   * Generate a single Scene Master panel.
   *
   * @param {Object} params
   * @param {string} params.prompt - full composition prompt (visual_style_prefix + scene_visual_anchor_prompt)
   * @param {string[]} [params.referenceImages=[]] - up to 10 reference URLs (character sheets + subject refs + brand kit)
   * @param {Object} [params.options]
   * @param {string} [params.options.aspectRatio='9:16']
   * @param {string} [params.options.size='3K'] - '3K' | '2K' | '1K'
   * @param {number} [params.options.seed] - deterministic seed for scene-to-scene coherence
   * @param {string} [params.options.sequentialGeneration='auto'] - Seedream's coherence priming
   * @returns {Promise<{imageUrl: string, imageBuffer: Buffer, prompt: string, model: string}>}
   */
  async generatePanel({ prompt, referenceImages = [], options = {} }) {
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
      `scene master — ${aspectRatio} / ${size}, ${refs.length} ref(s)${seed != null ? `, seed=${seed}` : ''}`
    );

    // fal.ai Seedream 5 Lite Edit expects `image_urls` (NOT `image_input`).
    // Sending the wrong name returns a 422 with
    //   {"loc":["body","image_urls"],"msg":"Field required"}
    // The wrong name was inherited from the Replicate Seedream shape during
    // the fal.ai migration; caught on 2026-04-11 when every Scene Master in
    // the first real V4 production run silently 422'd and every beat lost
    // its scene anchor. That's the root cause of the "no visual cohesion"
    // feeling on Episode 1 — beats had no shared composition reference.
    const inputPayload = {
      prompt,
      aspect_ratio: aspectRatio,
      size,
      sequential_image_generation: sequentialGeneration
    };

    if (refs.length > 0) inputPayload.image_urls = refs;
    if (seed != null) inputPayload.seed = seed;

    const result = await this.run(inputPayload);

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
      model: 'seedream-5-lite-edit'
    };
  }
}

// Singleton export
const seedreamFalService = new SeedreamFalService();
export default seedreamFalService;
export { SeedreamFalService };
