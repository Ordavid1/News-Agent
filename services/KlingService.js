// services/KlingService.js
// fal.ai Kling Reference-to-Video wrapper for cinematic shots with persona identity locked.
// Uses Kling 1.6 Elements — accepts multiple reference images + a text prompt
// and generates video with those subjects baked into the attention layer (no face drift).

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

// fal.ai queue API base
const FAL_QUEUE_BASE = 'https://queue.fal.run';

// Kling 3.0 Pro image-to-video with custom element support.
// This is the SOTA Kling model (Nov 2025) — supports a start frame +
// @Element references for identity-locked subjects via reference_image_urls.
// Pricing: $0.112/s (audio off) — a 5s clip costs ~$0.56
const DEFAULT_MODEL = 'fal-ai/kling-video/v3/pro/image-to-video';

// Polling configuration — Kling generation takes ~3-6 minutes
const POLL_INTERVAL_MS = 10000;        // 10 seconds between polls
const MAX_POLL_DURATION_MS = 600000;   // 10 minutes max wait

class KlingService {
  constructor() {
    this.apiKey = process.env.FAL_API_KEY;
    this.model = process.env.KLING_MODEL || DEFAULT_MODEL;

    if (!this.apiKey) {
      logger.warn('FAL_API_KEY not set — Kling reference-to-video will not be available');
    } else {
      logger.info(`KlingService initialized — model: ${this.model}`);
    }
  }

  /**
   * Check if the service is available (API key configured)
   */
  isAvailable() {
    return !!this.apiKey;
  }

  /**
   * Get default request headers (fal.ai uses `Key` scheme in Authorization header)
   */
  _headers() {
    return {
      'Authorization': `Key ${this.apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
  }

  /**
   * Generate a cinematic video with persona identity preserved via reference images.
   * Uses Kling 3.0 Pro's custom element support — the first image is used as both
   * the start frame AND element reference for identity lock.
   *
   * @param {Object} params
   * @param {string[]} params.referenceImages - Array of publicly accessible image URLs (1-4)
   *   The first image is used as the start frame + @Element1. Additional images become @Element2, @Element3, etc.
   * @param {string} params.prompt - Scene description text prompt
   * @param {Object} [params.options]
   * @param {number} [params.options.duration=5] - Video length: 5 or 10 seconds
   * @param {string} [params.options.aspectRatio='9:16'] - '9:16' | '16:9' | '1:1'
   * @param {string} [params.options.negativePrompt] - What to avoid
   * @returns {Promise<Object>} { videoUrl, videoBuffer, duration, model }
   */
  async generateReferenceVideo({ referenceImages, prompt, options = {} }) {
    if (!this.apiKey) throw new Error('FAL_API_KEY is not configured');
    if (!referenceImages || referenceImages.length === 0) {
      throw new Error('At least one reference image is required');
    }

    const {
      duration = 5,
      aspectRatio = '9:16',
      negativePrompt = ''
    } = options;

    // Kling 3.0 Pro: use first image as the start frame AND primary element reference.
    // Up to 4 element references total for richer identity conditioning.
    const refs = referenceImages.slice(0, 4);
    const startImage = refs[0];

    // Prepend @Element1 reference to prompt so the model attends to the persona explicitly.
    // Additional refs become @Element2, @Element3, etc. (Kling 3.0 elements support).
    const elementPrefix = refs.map((_, i) => `@Element${i + 1}`).join(' + ');
    const augmentedPrompt = `${elementPrefix}: ${prompt}`;

    logger.info(`Generating Kling 3.0 video — ${refs.length} element(s) + start frame, ${duration}s, ${aspectRatio}`);
    logger.info(`Scene prompt: ${augmentedPrompt.slice(0, 140)}...`);

    const startTime = Date.now();

    // Submit to fal.ai queue (Kling 3.0 Pro image-to-video with element support).
    // fal.ai REQUIRES the input payload wrapped as { input: { ... } }.
    // generate_audio=true produces native ambient audio. Pricing: $0.168/s with audio.
    let submitResponse;
    try {
      submitResponse = await axios.post(
        `${FAL_QUEUE_BASE}/${this.model}`,
        {
          input: {
            prompt: augmentedPrompt,
            start_image_url: startImage,
            reference_image_urls: refs,
            duration: String(duration),
            aspect_ratio: aspectRatio,
            generate_audio: true,
            ...(negativePrompt ? { negative_prompt: negativePrompt } : {})
          }
        },
        {
          headers: this._headers(),
          timeout: 30000
        }
      );
    } catch (err) {
      if (err.response) {
        logger.error(`Kling submit ${err.response.status}: ${JSON.stringify(err.response.data)}`);
      }
      throw err;
    }

    const submitData = submitResponse.data || {};
    const requestId = submitData.request_id;
    if (!requestId) {
      logger.error(`Kling submit response: ${JSON.stringify(submitData)}`);
      throw new Error('fal.ai did not return a request_id');
    }

    // fal.ai returns `status_url` and `response_url` directly — use them.
    // For multi-segment model paths, constructing these URLs manually returns 405.
    const statusUrl = submitData.status_url;
    const resultUrl = submitData.response_url;
    if (!statusUrl || !resultUrl) {
      logger.error(`Kling submit missing status_url/response_url: ${JSON.stringify(submitData)}`);
      throw new Error('fal.ai did not return status_url/response_url');
    }

    logger.info(`Kling job submitted — request_id: ${requestId}`);

    // Poll for completion using URLs returned by fal.ai
    const result = await this._pollJob(requestId, statusUrl, resultUrl);

    // Extract video URL from response. fal.ai returns:
    //   { video: { url: "...", content_type: "video/mp4", file_name, file_size } }
    const videoUrl = result?.video?.url;
    if (!videoUrl) {
      logger.error(`Kling completed but no video URL: ${JSON.stringify(result)}`);
      throw new Error('Kling API did not return a video URL');
    }

    // Download the video buffer so the caller can upload to storage
    logger.info(`Downloading Kling video from fal.ai: ${videoUrl}`);
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
      model: 'kling-3.0-pro-elements'
    };
  }

  /**
   * Poll the fal.ai queue endpoint until the job completes.
   * Uses the status_url + response_url returned by fal.ai's submit response
   * (they have the correct shape for multi-segment model paths).
   * @param {string} requestId
   * @param {string} statusUrl
   * @param {string} resultUrl
   * @returns {Promise<Object>} The job's result output object
   */
  async _pollJob(requestId, statusUrl, resultUrl) {
    const startTime = Date.now();

    while (Date.now() - startTime < MAX_POLL_DURATION_MS) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

      let statusResp;
      try {
        statusResp = await axios.get(statusUrl, {
          headers: this._headers(),
          timeout: 15000
        });
      } catch (err) {
        if (err.response?.status === 404) {
          logger.warn(`Kling status 404 (request may still be queueing)`);
          continue;
        }
        if (err.response) {
          logger.error(`Kling status ${err.response.status}: ${JSON.stringify(err.response.data)}`);
          logger.error(`Status URL: ${statusUrl}`);
        }
        throw err;
      }

      const status = statusResp.data?.status;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

      if (status === 'COMPLETED') {
        // Fetch the full result
        const resultResp = await axios.get(resultUrl, {
          headers: this._headers(),
          timeout: 15000
        });
        return resultResp.data;
      }

      if (status === 'FAILED' || status === 'ERROR') {
        const errorDetail = statusResp.data?.error || JSON.stringify(statusResp.data);
        throw new Error(`Kling generation failed: ${errorDetail}`);
      }

      logger.info(`Kling job ${requestId} status: ${status} (${elapsed}s elapsed)`);
    }

    throw new Error(`Kling generation timed out after ${MAX_POLL_DURATION_MS / 1000}s`);
  }
}

// Singleton export
const klingService = new KlingService();
export default klingService;
export { KlingService };
