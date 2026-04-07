// services/SeedanceService.js
// fal.ai Seedance 1.5 Pro wrapper for cinematic and b-roll video generation.
// Supports text-to-video and image-to-video with native audio (dialogue, SFX, ambient).
// Replaces Kling (for single-entity cinematic shots) and Veo (for broll) in hybrid mode.

import axios from 'axios';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[SeedanceService] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

// fal.ai queue API base (same as KlingService / OmniHumanService)
const FAL_QUEUE_BASE = 'https://queue.fal.run';

// Seedance 1.5 Pro models on fal.ai
const TEXT_TO_VIDEO_MODEL = 'fal-ai/bytedance/seedance/v1.5/pro/text-to-video';
const IMAGE_TO_VIDEO_MODEL = 'fal-ai/bytedance/seedance/v1.5/pro/image-to-video';

// Polling configuration — Seedance is fast: ~30-45s for 5s clip, ~60-90s for 12s
const POLL_INTERVAL_MS = 5000;         // 5 seconds between polls
const MAX_POLL_DURATION_MS = 300000;   // 5 minutes max wait

// Duration bounds enforced by Seedance
const MIN_DURATION = 4;
const MAX_DURATION = 15;

class SeedanceService {
  constructor() {
    this.apiKey = process.env.FAL_API_KEY;
    this.t2vModel = process.env.SEEDANCE_T2V_MODEL || TEXT_TO_VIDEO_MODEL;
    this.i2vModel = process.env.SEEDANCE_I2V_MODEL || IMAGE_TO_VIDEO_MODEL;

    if (!this.apiKey) {
      logger.warn('FAL_API_KEY not set — Seedance video generation will not be available');
    } else {
      logger.info(`SeedanceService initialized — T2V: ${this.t2vModel}, I2V: ${this.i2vModel}`);
    }
  }

  /**
   * Check if the service is available (API key configured)
   */
  isAvailable() {
    return !!this.apiKey;
  }

  /**
   * Get default request headers
   */
  _headers() {
    return {
      'Authorization': `Key ${this.apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
  }

  /**
   * Clamp a requested duration to Seedance's valid range (4–15s).
   * @param {number} requested
   * @returns {number}
   */
  _clampDuration(requested) {
    return Math.min(Math.max(requested || 5, MIN_DURATION), MAX_DURATION);
  }

  /**
   * Generate a video from a text prompt only (no start image).
   * Used for pure broll / environment shots when no reference image is available.
   *
   * @param {Object} params
   * @param {string} params.prompt - Scene description
   * @param {Object} [params.options]
   * @param {string} [params.options.aspectRatio='9:16'] - '9:16' | '16:9' | '21:9' | '4:3' | '1:1' | '3:4'
   * @param {string} [params.options.resolution='720p'] - '480p' | '720p'
   * @param {number} [params.options.duration=12] - 4–15 seconds
   * @param {boolean} [params.options.generateAudio=true] - Native audio (dialogue, SFX, ambient)
   * @param {boolean} [params.options.cameraFixed=false] - Lock camera position
   * @param {number} [params.options.seed] - Reproducibility seed (-1 for random)
   * @returns {Promise<Object>} { videoUrl, videoBuffer, duration, model }
   */
  async generateTextToVideo({ prompt, options = {} }) {
    if (!this.apiKey) throw new Error('FAL_API_KEY is not configured');
    if (!prompt) throw new Error('prompt is required for Seedance text-to-video');

    const {
      aspectRatio = '9:16',
      resolution = '720p',
      duration = 12,
      generateAudio = true,
      cameraFixed = false,
      seed
    } = options;

    const clampedDuration = this._clampDuration(duration);

    return this._generate({
      model: this.t2vModel,
      input: {
        prompt,
        aspect_ratio: aspectRatio,
        resolution,
        duration: String(clampedDuration),
        generate_audio: generateAudio,
        camera_fixed: cameraFixed,
        ...(seed != null ? { seed } : {})
      },
      label: `T2V ${clampedDuration}s ${resolution} ${aspectRatio}`
    });
  }

  /**
   * Generate a video from a start image + text prompt.
   * Used for cinematic shots (persona storyboard as start frame) and
   * broll shots (real product reference image as start frame).
   *
   * @param {Object} params
   * @param {string} params.prompt - Scene description / visual direction
   * @param {string} params.imageUrl - Public URL of the start frame image
   * @param {Object} [params.options]
   * @param {string} [params.options.aspectRatio='9:16']
   * @param {string} [params.options.resolution='720p']
   * @param {number} [params.options.duration=12] - 4–15 seconds
   * @param {boolean} [params.options.generateAudio=true]
   * @param {boolean} [params.options.cameraFixed=false]
   * @param {number} [params.options.seed]
   * @param {string} [params.options.endImageUrl] - Optional end frame for guided motion
   * @returns {Promise<Object>} { videoUrl, videoBuffer, duration, model }
   */
  async generateImageToVideo({ prompt, imageUrl, options = {} }) {
    if (!this.apiKey) throw new Error('FAL_API_KEY is not configured');
    if (!prompt) throw new Error('prompt is required for Seedance image-to-video');
    if (!imageUrl) throw new Error('imageUrl is required for Seedance image-to-video');

    const {
      aspectRatio = '9:16',
      resolution = '720p',
      duration = 12,
      generateAudio = true,
      cameraFixed = false,
      seed,
      endImageUrl
    } = options;

    const clampedDuration = this._clampDuration(duration);

    return this._generate({
      model: this.i2vModel,
      input: {
        prompt,
        image_url: imageUrl,
        aspect_ratio: aspectRatio,
        resolution,
        duration: String(clampedDuration),
        generate_audio: generateAudio,
        camera_fixed: cameraFixed,
        ...(seed != null ? { seed } : {}),
        ...(endImageUrl ? { end_image_url: endImageUrl } : {})
      },
      label: `I2V ${clampedDuration}s ${resolution} ${aspectRatio}`
    });
  }

  /**
   * Internal: submit to fal.ai queue, poll, download result.
   * Shared by both T2V and I2V flows.
   * @param {Object} params
   * @param {string} params.model - fal.ai model path
   * @param {Object} params.input - Request input payload
   * @param {string} params.label - Logging label
   * @returns {Promise<Object>} { videoUrl, videoBuffer, duration, model }
   */
  async _generate({ model, input, label }) {
    logger.info(`Generating Seedance ${label}`);
    logger.info(`Prompt: ${input.prompt.slice(0, 140)}...`);
    if (input.image_url) logger.info(`Start image: ${input.image_url.slice(0, 80)}...`);

    const startTime = Date.now();

    // Submit to fal.ai queue
    let submitResponse;
    try {
      // fal.ai REST API: input parameters go directly in the body (no { input: {} } wrapper).
      submitResponse = await axios.post(
        `${FAL_QUEUE_BASE}/${model}`,
        input,
        {
          headers: this._headers(),
          timeout: 30000
        }
      );
    } catch (err) {
      if (err.response) {
        const errBody = typeof err.response.data === 'object'
          ? JSON.stringify(err.response.data)
          : String(err.response.data || '').slice(0, 1000);
        logger.error(`Seedance submit ${err.response.status}: ${errBody}`);
        throw new Error(`Seedance submit ${err.response.status}: ${errBody}`);
      }
      throw err;
    }

    const submitData = submitResponse.data || {};
    const requestId = submitData.request_id;
    if (!requestId) {
      logger.error(`Seedance submit response: ${JSON.stringify(submitData)}`);
      throw new Error('fal.ai did not return a request_id');
    }

    const statusUrl = submitData.status_url;
    const resultUrl = submitData.response_url;
    if (!statusUrl || !resultUrl) {
      logger.error(`Seedance submit missing status_url/response_url: ${JSON.stringify(submitData)}`);
      throw new Error('fal.ai did not return status_url/response_url');
    }

    logger.info(`Seedance job submitted — request_id: ${requestId}`);

    // Poll for completion
    const result = await this._pollJob(requestId, statusUrl, resultUrl);

    // Extract video URL. fal.ai returns:
    //   { video: { url: "...", content_type: "video/mp4", ... } }
    const videoUrl = result?.video?.url;
    if (!videoUrl) {
      logger.error(`Seedance completed but no video URL: ${JSON.stringify(result)}`);
      throw new Error('Seedance API did not return a video URL');
    }

    // Download video buffer for Supabase upload
    logger.info(`Downloading Seedance video from fal.ai: ${videoUrl}`);
    const downloadResp = await axios.get(videoUrl, {
      responseType: 'arraybuffer',
      timeout: 120000,
      headers: { 'User-Agent': 'NewsAgentSaaS/1.0' }
    });
    const videoBuffer = Buffer.from(downloadResp.data);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const requestedDuration = parseInt(input.duration, 10);
    logger.info(`Seedance video ready in ${elapsed}s — ${(videoBuffer.length / (1024 * 1024)).toFixed(1)}MB, ${requestedDuration}s clip`);

    return {
      videoUrl,
      videoBuffer,
      duration: requestedDuration,
      model: `seedance-1.5-pro-${input.image_url ? 'i2v' : 't2v'}`
    };
  }

  /**
   * Poll the fal.ai queue endpoint until the job completes.
   * Same pattern as KlingService._pollJob / OmniHumanService._pollJob.
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
          logger.warn(`Seedance status 404 (request may still be queueing)`);
          continue;
        }
        if (err.response) {
          const errBody = typeof err.response.data === 'object'
            ? JSON.stringify(err.response.data)
            : String(err.response.data || '').slice(0, 1000);
          logger.error(`Seedance poll error ${err.response.status}: ${errBody}`);
          // Surface the fal.ai error detail in the thrown error so BrandStoryService logs it
          throw new Error(`Seedance poll ${err.response.status}: ${errBody}`);
        }
        throw err;
      }

      const status = statusResp.data?.status;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

      if (status === 'COMPLETED') {
        const resultResp = await axios.get(resultUrl, {
          headers: this._headers(),
          timeout: 15000
        });
        return resultResp.data;
      }

      if (status === 'FAILED' || status === 'ERROR') {
        const errorDetail = statusResp.data?.error || JSON.stringify(statusResp.data);
        throw new Error(`Seedance generation failed: ${errorDetail}`);
      }

      logger.info(`Seedance job ${requestId} status: ${status} (${elapsed}s elapsed)`);
    }

    throw new Error(`Seedance generation timed out after ${MAX_POLL_DURATION_MS / 1000}s`);
  }
}

// Singleton export
const seedanceService = new SeedanceService();
export default seedanceService;
export { SeedanceService };
