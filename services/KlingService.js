// services/KlingService.js
// Replicate Kling V3 Omni wrapper for cinematic video generation.
// Uses kwaivgi/kling-v3-omni-video on Replicate — supports multi-shot (up to 6 shots),
// up to 7 reference images for identity lock, native audio, and pro (1080p) resolution.
// Reference images use <<<image_N>>> syntax in prompts (vs fal.ai's @Element syntax).

import Replicate from 'replicate';
import axios from 'axios';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[KlingService] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

const REPLICATE_MODEL = 'kwaivgi/kling-v3-omni-video';

class KlingService {
  constructor() {
    this.replicate = null;

    if (process.env.REPLICATE_API_TOKEN) {
      this.replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
      logger.info(`KlingService initialized — Replicate model: ${REPLICATE_MODEL}`);
    } else {
      logger.warn('REPLICATE_API_TOKEN not set — Kling video generation will not be available');
    }
  }

  /**
   * Check if the service is available
   */
  isAvailable() {
    return !!this.replicate;
  }

  /**
   * Generate a single-shot cinematic video with identity-locked reference images.
   * Backward-compatible with existing v1/v2 pipeline callers.
   *
   * @param {Object} params
   * @param {string[]} params.referenceImages - Array of publicly accessible image URLs (1-7)
   * @param {string} params.prompt - Scene description text prompt
   * @param {Object} [params.options]
   * @param {number} [params.options.duration=5] - Video length: 3-15 seconds
   * @param {string} [params.options.aspectRatio='9:16'] - '9:16' | '16:9' | '1:1'
   * @param {string} [params.options.negativePrompt] - What to avoid
   * @returns {Promise<Object>} { videoUrl, videoBuffer, duration, model }
   */
  async generateReferenceVideo({ referenceImages, prompt, options = {} }) {
    if (!this.replicate) throw new Error('REPLICATE_API_TOKEN is not configured');
    if (!referenceImages || referenceImages.length === 0) {
      throw new Error('At least one reference image is required');
    }

    const {
      duration = 5,
      aspectRatio = '9:16',
      negativePrompt = ''
    } = options;

    // Up to 7 reference images for identity lock
    const refs = referenceImages.slice(0, 7);

    // Replicate Kling uses <<<image_N>>> syntax for referencing images in prompts
    const imagePrefix = refs.map((_, i) => `<<<image_${i + 1}>>>`).join(' ');
    const augmentedPrompt = `${imagePrefix} ${prompt}`;

    logger.info(`Generating Kling Omni video — ${refs.length} ref(s), ${duration}s, ${aspectRatio}`);
    logger.info(`Scene prompt: ${augmentedPrompt.slice(0, 140)}...`);

    const startTime = Date.now();

    const output = await this.replicate.run(REPLICATE_MODEL, {
      input: {
        prompt: augmentedPrompt,
        mode: 'pro',
        duration,
        aspect_ratio: aspectRatio,
        reference_images: refs,
        generate_audio: true,
        ...(negativePrompt ? { negative_prompt: negativePrompt } : {})
      }
    });

    // Replicate returns string URL, FileOutput, or array — normalize to string URL
    const videoUrl = typeof output === 'string' ? output
      : Array.isArray(output) ? String(output[0])
      : String(output);

    logger.info(`Downloading Kling video: ${videoUrl}`);
    const downloadResp = await axios.get(videoUrl, {
      responseType: 'arraybuffer',
      timeout: 120000,
      headers: { 'User-Agent': 'NewsAgentSaaS/1.0' }
    });
    const videoBuffer = Buffer.from(downloadResp.data);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`Kling video ready in ${elapsed}s — ${(videoBuffer.length / (1024 * 1024)).toFixed(1)}MB`);

    return {
      videoUrl,
      videoBuffer,
      duration,
      model: 'kling-v3-omni-pro'
    };
  }

  /**
   * Generate a multi-shot cinematic video from a single start image.
   * Uses Kling Omni 3's multi_prompt — up to 6 shots, up to 7 reference
   * images for identity lock. Produces ONE coherent video.
   *
   * @param {Object} params
   * @param {string} params.imageUrl - Publicly accessible start frame (storyboard Panel 1)
   * @param {string[]} [params.referenceImages] - Up to 7 identity-lock reference images
   * @param {Array<{prompt: string, duration: number}>} params.multiPrompt
   *   Array of shot descriptors. Each has a text prompt and duration (3-15s each).
   * @param {Object} [params.options]
   * @param {string} [params.options.aspectRatio='9:16']
   * @param {boolean} [params.options.generateAudio=true]
   * @param {string} [params.options.negativePrompt]
   * @returns {Promise<Object>} { videoUrl, videoBuffer, duration, model }
   */
  async generateMultiShotVideo({ imageUrl, referenceImages = [], elements = [], multiPrompt, options = {} }) {
    if (!this.replicate) throw new Error('REPLICATE_API_TOKEN is not configured');
    if (!imageUrl) throw new Error('Start image (storyboard Panel 1) is required');
    if (!multiPrompt || multiPrompt.length < 2) {
      throw new Error('multi_prompt requires at least 2 shots');
    }

    const {
      aspectRatio = '9:16',
      generateAudio = true,
      negativePrompt = ''
    } = options;

    // Build reference images list from either referenceImages or elements (backward compat)
    let refs = referenceImages.length > 0
      ? referenceImages
      : elements.map(e => e.frontal_image_url).filter(Boolean);
    refs = [...new Set(refs)].slice(0, 7); // Replicate Kling: up to 7

    const totalDuration = multiPrompt.reduce((sum, s) => sum + (s.duration || 5), 0);

    logger.info(`Generating Kling multi-shot video — ${multiPrompt.length} shots, ${refs.length} ref(s), ${totalDuration}s total, ${aspectRatio}`);
    for (let i = 0; i < multiPrompt.length; i++) {
      logger.info(`  Shot ${i + 1} (${multiPrompt[i].duration}s): ${multiPrompt[i].prompt.slice(0, 100)}...`);
    }

    const startTime = Date.now();

    // Build multi_prompt JSON for Replicate.
    // CRITICAL: Kling enforces 512 chars per shot prompt in multi_prompt.
    const MAX_SHOT_PROMPT = 512;
    const multiPromptPayload = multiPrompt.map(s => {
      let p = (s.prompt || '').slice(0, MAX_SHOT_PROMPT);
      if (p.length === MAX_SHOT_PROMPT) {
        const lastSpace = p.lastIndexOf(' ');
        if (lastSpace > MAX_SHOT_PROMPT - 50) p = p.slice(0, lastSpace);
      }
      return { prompt: p, duration: s.duration || 5 };
    });

    // Replicate requires `prompt` even with multi_prompt.
    // Top-level prompt has no 512-char limit — include <<<image_N>>> tags + full description here.
    const imageTagsForPrompt = refs.length > 0
      ? refs.map((_, i) => `<<<image_${i + 1}>>>`).join(' ') + ' '
      : '';
    const input = {
      prompt: `${imageTagsForPrompt}${multiPromptPayload[0].prompt}`,
      mode: 'pro',
      duration: totalDuration,
      aspect_ratio: aspectRatio,
      generate_audio: generateAudio,
      multi_prompt: JSON.stringify(multiPromptPayload),
      ...(refs.length > 0 ? { reference_images: refs } : {}),
      ...(negativePrompt ? { negative_prompt: negativePrompt } : {})
    };

    logger.info(`Kling multi-shot Replicate input: ${JSON.stringify({ ...input, multi_prompt: `[${multiPromptPayload.length} shots]`, reference_images: `[${refs.length} refs]` })}`);

    const output = await this.replicate.run(REPLICATE_MODEL, { input });

    // Replicate output can be: string URL, FileOutput object, array, or nested object.
    // FileOutput has .url() method and toString() that returns the URL.
    logger.info(`Kling multi-shot raw output type: ${typeof output}, isArray: ${Array.isArray(output)}`);
    let videoUrl;
    if (typeof output === 'string') {
      videoUrl = output;
    } else if (Array.isArray(output)) {
      const first = output[0];
      videoUrl = typeof first === 'string' ? first : String(first);
    } else if (output && typeof output === 'object') {
      // FileOutput objects: toString() returns the URL string
      videoUrl = String(output);
    } else {
      videoUrl = String(output);
    }

    if (!videoUrl || !videoUrl.startsWith('http')) {
      logger.error(`Kling multi-shot unexpected output: type=${typeof output}, value=${String(output).slice(0, 500)}`);
      throw new Error('Kling multi-shot did not return a video URL');
    }

    logger.info(`Downloading Kling multi-shot video: ${videoUrl}`);
    let videoBuffer;
    if (typeof output !== 'string' && output && typeof output.blob === 'function') {
      // FileOutput — use blob() method
      const blob = await output.blob();
      videoBuffer = Buffer.from(await blob.arrayBuffer());
    } else {
      const downloadResp = await axios.get(videoUrl, {
        responseType: 'arraybuffer',
        timeout: 120000,
        headers: { 'User-Agent': 'NewsAgentSaaS/1.0' }
      });
      videoBuffer = Buffer.from(downloadResp.data);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`Kling multi-shot video ready in ${elapsed}s — ${multiPrompt.length} shots, ${(videoBuffer.length / (1024 * 1024)).toFixed(1)}MB`);

    return {
      videoUrl,
      videoBuffer,
      duration: totalDuration,
      model: 'kling-v3-omni-multi-shot'
    };
  }
}

// Singleton export
const klingService = new KlingService();
export default klingService;
export { KlingService };
