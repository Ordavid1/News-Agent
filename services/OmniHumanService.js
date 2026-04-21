// services/OmniHumanService.js
// fal.ai OmniHuman 1.5 wrapper for talking-head video generation.
//
// In V4, OmniHuman is the **Mode A fallback** for TALKING_HEAD_CLOSEUP beats —
// the primary is Mode B (Kling O3 Omni → Sync Lipsync v3 hybrid). OmniHuman
// remains in the codebase for budget-tier users and as the A/B comparison
// benchmark for Mode B dialogue generation.
//
// Consumes a single image + audio clip → produces lip-synced video with
// emotion-aware facial expressions and body language. Zero-shot — no training
// required, unlike HeyGen Photo Avatar.
//
// Model: fal-ai/bytedance/omnihuman/v1.5
// Pricing: $0.16/s of generated video
// Max audio: 30s @ 1080p, 60s @ 720p
// Has `turbo_mode` and optional `prompt` for gesture control

import FalAiBaseService from './FalAiBaseService.js';

const DEFAULT_MODEL = process.env.OMNIHUMAN_MODEL || 'fal-ai/bytedance/omnihuman/v1.5';

class OmniHumanService extends FalAiBaseService {
  constructor() {
    super({
      modelSlug: DEFAULT_MODEL,
      displayName: 'OmniHumanService',
      // OmniHuman typically completes in 1-2 minutes; keep 10 min ceiling.
      pollIntervalMs: 8000,
      maxPollDurationMs: 600000
    });
  }

  /**
   * Generate a lip-synced talking-head video from a single image and audio clip.
   * OmniHuman 1.5 drives facial expressions, lip movements, and body language
   * from the audio's semantic content — not just beat-matching.
   *
   * @param {Object} params
   * @param {string} params.imageUrl - Public URL of the persona's seed image (any aspect ratio)
   * @param {string} params.audioUrl - Public URL of the TTS audio clip (≤30s @ 1080p, ≤60s @ 720p)
   * @param {Object} [params.options]
   * @param {string} [params.options.prompt] - Optional text guidance for scene/gesture control
   * @param {string} [params.options.resolution='720p'] - '720p' (60s max audio) | '1080p' (30s max audio)
   * @param {boolean} [params.options.turboMode=false] - Faster generation at slight quality cost
   * @returns {Promise<{videoUrl: string, videoBuffer: Buffer, duration: number|null, model: string}>}
   */
  async generateTalkingHead({ imageUrl, audioUrl, options = {} }) {
    if (!this.apiKey) throw new Error('FAL_GCS_API_KEY is not configured');
    if (!imageUrl) throw new Error('imageUrl is required for OmniHuman generation');
    if (!audioUrl) throw new Error('audioUrl is required for OmniHuman generation');

    const {
      prompt = '',
      resolution = '720p',
      turboMode = false
    } = options;

    this.logger.info(`Generating talking-head — resolution: ${resolution}${turboMode ? ' (turbo)' : ''}`);
    this.logger.info(`Image: ${imageUrl.slice(0, 80)}...`);
    this.logger.info(`Audio: ${audioUrl.slice(0, 80)}...`);
    if (prompt) this.logger.info(`Prompt: ${prompt.slice(0, 100)}...`);

    // fal.ai REST API: input parameters go directly in the body (no { input: {} } wrapper).
    const inputPayload = {
      image_url: imageUrl,
      audio_url: audioUrl,
      resolution
    };
    if (prompt) inputPayload.prompt = prompt;
    if (turboMode) inputPayload.turbo_mode = true;

    // Base class handles submit + poll + timing logging.
    const result = await this.run(inputPayload);

    // fal.ai OmniHuman returns: { video: { url, content_type, file_size, ... } }
    const videoUrl = result?.video?.url;
    if (!videoUrl) {
      this.logger.error(`completed but no video URL: ${JSON.stringify(result)}`);
      throw new Error('OmniHuman API did not return a video URL');
    }

    // Download to buffer for caller (usually uploaded to Supabase next).
    const videoBuffer = await this.downloadToBuffer(videoUrl, 'video');

    return {
      videoUrl,
      videoBuffer,
      duration: null, // audio-driven; caller knows from TTS output
      model: 'omnihuman-1.5'
    };
  }
}

// Singleton export — existing callers rely on this shape
const omniHumanService = new OmniHumanService();
export default omniHumanService;
export { OmniHumanService };
