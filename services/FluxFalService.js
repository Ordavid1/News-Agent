// services/FluxFalService.js
// fal.ai Flux 2 Max wrapper — V4's character sheet portrait generator.
//
// V4 uses Flux 2 Max for ONE job: generate 3 portrait views per persona
// (hero / closeup / side-3⁄4) at story creation time. These reference_image_urls
// feed every downstream generation stage — Scene Master panels, Kling dialogue
// beats, OmniHuman Mode A fallback, Veo first/last frame anchors.
//
// Ports the existing _generateCharacterSheet() logic at BrandStoryService.js:2002
// off Replicate onto fal.ai with zero behavior change — just the wrapper swap.
//
// Endpoint: fal-ai/flux-2-max
// Pricing: $0.07 first megapixel + $0.03 each additional MP (megapixel-billed)
// Max resolution: up to ~14K max dimension
// Reference images: supported via /edit variant (for consistent-style portraits)
//
// Reference images are critical here: when the story has a Brand Kit person
// cutout, it's passed as a ref so the generated portrait LOOKS LIKE the real
// brand founder/spokesperson.

import FalAiBaseService from './FalAiBaseService.js';

const ENDPOINT_FLUX_2_MAX = 'fal-ai/flux-2-max';
// The /edit variant accepts reference images for style-consistent portraits.
// We use the base endpoint when no refs are provided; /edit when refs exist.
const ENDPOINT_FLUX_2_MAX_EDIT = 'fal-ai/flux-2-max/edit';

class FluxFalService {
  constructor() {
    this.base = new FalAiBaseService({
      modelSlug: ENDPOINT_FLUX_2_MAX,
      displayName: 'FluxFalBase',
      pollIntervalMs: 5000,
      maxPollDurationMs: 300000
    });

    this.edit = new FalAiBaseService({
      modelSlug: ENDPOINT_FLUX_2_MAX_EDIT,
      displayName: 'FluxFalEdit',
      pollIntervalMs: 5000,
      maxPollDurationMs: 300000
    });
  }

  isAvailable() {
    return this.base.isAvailable();
  }

  /**
   * Generate a character portrait (one of the 3 views in a character sheet).
   *
   * @param {Object} params
   * @param {string} params.prompt - full portrait prompt including view angle,
   *   wardrobe, lighting, style
   * @param {string[]} [params.referenceImages=[]] - optional refs (brand kit person cutout, prior-view for consistency)
   * @param {Object} [params.options]
   * @param {string} [params.options.aspectRatio='9:16'] - portrait by default
   * @param {number} [params.options.seed] - deterministic seed for cross-view consistency within one character sheet
   * @returns {Promise<{imageUrl: string, imageBuffer: Buffer, model: string}>}
   */
  async generatePortrait({ prompt, referenceImages = [], options = {} }) {
    if (!prompt) throw new Error('FluxFalService: prompt is required');

    const {
      aspectRatio = '9:16',
      seed
    } = options;

    const useEdit = referenceImages && referenceImages.length > 0;
    const service = useEdit ? this.edit : this.base;

    service.logger.info(
      `portrait — ${aspectRatio}${useEdit ? `, ${referenceImages.length} ref(s)` : ''}${seed != null ? `, seed=${seed}` : ''}`
    );

    const inputPayload = {
      prompt,
      aspect_ratio: aspectRatio
    };

    if (useEdit) {
      // Flux 2 Max /edit uses image_urls (plural) for multi-ref style consistency.
      inputPayload.image_urls = referenceImages.slice(0, 8); // Flux 2 supports up to 8
    }

    if (seed != null) inputPayload.seed = seed;

    const result = await service.run(inputPayload);

    // fal.ai Flux 2 returns: { images: [{ url, width, height, content_type }], ... }
    const imageUrl = result?.images?.[0]?.url || result?.image?.url;
    if (!imageUrl) {
      service.logger.error(`completed but no image URL: ${JSON.stringify(result)}`);
      throw new Error('Flux 2 Max did not return an image URL');
    }

    const imageBuffer = await service.downloadToBuffer(imageUrl, 'image');

    return {
      imageUrl,
      imageBuffer,
      model: useEdit ? 'flux-2-max-edit' : 'flux-2-max'
    };
  }

  /**
   * Convenience: generate all 3 portrait views of a character sheet in one call.
   * Uses a shared seed family (+0, +1, +2) so the three views hang together
   * visually even though they're generated independently.
   *
   * @param {Object} params
   * @param {string} params.personaName
   * @param {string} params.appearance - appearance description
   * @param {string} [params.wardrobeHint]
   * @param {string} [params.styleHint]
   * @param {string[]} [params.referenceImages=[]]
   * @param {number} [params.baseSeed]
   * @returns {Promise<{heroUrl: string, closeupUrl: string, sideUrl: string, buffers: Buffer[]}>}
   */
  async generateCharacterSheet({ personaName, appearance, wardrobeHint = '', styleHint = 'cinematic, soft key light, shallow DOF', referenceImages = [], baseSeed }) {
    const viewPrompts = [
      `Character portrait of ${personaName} (${appearance}). ${wardrobeHint ? `Wearing ${wardrobeHint}. ` : ''}Full body hero shot, neutral confident pose, 9:16 vertical composition. ${styleHint}. Professional headshot quality.`,
      `Character portrait of ${personaName} (${appearance}). ${wardrobeHint ? `Wearing ${wardrobeHint}. ` : ''}Tight closeup, head and shoulders, eye-level, 9:16 vertical composition. ${styleHint}. Professional headshot quality.`,
      `Character portrait of ${personaName} (${appearance}). ${wardrobeHint ? `Wearing ${wardrobeHint}. ` : ''}3/4 side view, medium shot, 9:16 vertical composition. ${styleHint}. Professional headshot quality.`
    ];

    const seed = baseSeed != null ? baseSeed : Math.floor(Math.random() * 1_000_000);

    // Generate sequentially so each view can use prior views as refs (not just the brand kit cutout).
    const results = [];
    let runningRefs = [...referenceImages];

    for (let i = 0; i < viewPrompts.length; i++) {
      const result = await this.generatePortrait({
        prompt: viewPrompts[i],
        referenceImages: runningRefs,
        options: {
          aspectRatio: '9:16',
          seed: seed + i
        }
      });
      results.push(result);
      // Feed this view into subsequent generations for cross-view coherence.
      runningRefs = [...referenceImages, result.imageUrl];
    }

    return {
      heroUrl: results[0].imageUrl,
      closeupUrl: results[1].imageUrl,
      sideUrl: results[2].imageUrl,
      buffers: results.map(r => r.imageBuffer)
    };
  }
}

// Singleton export
const fluxFalService = new FluxFalService();
export default fluxFalService;
export { FluxFalService };
