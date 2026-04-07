// services/OmniHumanService.js
// fal.ai OmniHuman 1.5 wrapper for film-grade talking-head video generation.
// Consumes a single image + audio clip → produces lip-synced video with
// emotion-aware facial expressions and body language.
// Zero-shot — no training required, unlike HeyGen Photo Avatar.

import axios from 'axios';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[OmniHumanService] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

// fal.ai queue API base (same as KlingService)
const FAL_QUEUE_BASE = 'https://queue.fal.run';

// OmniHuman 1.5 — film-grade digital human from single image + audio.
// Pricing via fal.ai: $0.14/s of generated video.
// Max audio: 30s @ 1080p, 60s @ 720p.
const DEFAULT_MODEL = 'fal-ai/bytedance/omnihuman/v1.5';

// Polling configuration — OmniHuman typically completes in 1-2 minutes
const POLL_INTERVAL_MS = 8000;         // 8 seconds between polls
const MAX_POLL_DURATION_MS = 600000;   // 10 minutes max wait

class OmniHumanService {
  constructor() {
    this.apiKey = process.env.FAL_API_KEY;
    this.model = process.env.OMNIHUMAN_MODEL || DEFAULT_MODEL;

    if (!this.apiKey) {
      logger.warn('FAL_API_KEY not set — OmniHuman talking-head generation will not be available');
    } else {
      logger.info(`OmniHumanService initialized — model: ${this.model}`);
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
   * Generate a lip-synced talking-head video from a single image and audio clip.
   * OmniHuman 1.5 drives facial expressions, lip movements, and body language
   * from the audio's semantic content — not just beat-matching.
   *
   * @param {Object} params
   * @param {string} params.imageUrl - Public URL of the persona's seed image (any aspect ratio)
   * @param {string} params.audioUrl - Public URL of the TTS audio clip (≤30s @ 1080p, ≤60s @ 720p)
   * @param {Object} [params.options]
   * @param {string} [params.options.prompt] - Optional text guidance for scene composition
   * @param {string} [params.options.resolution='720p'] - '720p' (60s max audio) | '1080p' (30s max audio)
   * @returns {Promise<Object>} { videoUrl, videoBuffer, duration, model }
   */
  async generateTalkingHead({ imageUrl, audioUrl, options = {} }) {
    if (!this.apiKey) throw new Error('FAL_API_KEY is not configured');
    if (!imageUrl) throw new Error('imageUrl is required for OmniHuman generation');
    if (!audioUrl) throw new Error('audioUrl is required for OmniHuman generation');

    const {
      prompt = '',
      resolution = '720p'
    } = options;

    logger.info(`Generating OmniHuman talking-head — resolution: ${resolution}`);
    logger.info(`Image: ${imageUrl.slice(0, 80)}...`);
    logger.info(`Audio: ${audioUrl.slice(0, 80)}...`);
    if (prompt) logger.info(`Prompt: ${prompt.slice(0, 100)}...`);

    const startTime = Date.now();

    // Submit to fal.ai queue — same pattern as KlingService.
    // fal.ai REST API: input parameters go directly in the body (no { input: {} } wrapper).
    const inputPayload = {
      image_url: imageUrl,
      audio_url: audioUrl,
      resolution
    };
    if (prompt) inputPayload.prompt = prompt;

    let submitResponse;
    try {
      submitResponse = await axios.post(
        `${FAL_QUEUE_BASE}/${this.model}`,
        inputPayload,
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
        logger.error(`OmniHuman submit ${err.response.status}: ${errBody}`);
        throw new Error(`OmniHuman submit ${err.response.status}: ${errBody}`);
      }
      throw err;
    }

    const submitData = submitResponse.data || {};
    const requestId = submitData.request_id;
    if (!requestId) {
      logger.error(`OmniHuman submit response: ${JSON.stringify(submitData)}`);
      throw new Error('fal.ai did not return a request_id');
    }

    const statusUrl = submitData.status_url;
    const resultUrl = submitData.response_url;
    if (!statusUrl || !resultUrl) {
      logger.error(`OmniHuman submit missing status_url/response_url: ${JSON.stringify(submitData)}`);
      throw new Error('fal.ai did not return status_url/response_url');
    }

    logger.info(`OmniHuman job submitted — request_id: ${requestId}`);

    // Poll for completion
    const result = await this._pollJob(requestId, statusUrl, resultUrl);

    // Extract video URL. fal.ai returns:
    //   { video: { url: "...", content_type: "video/mp4", ... } }
    const videoUrl = result?.video?.url;
    if (!videoUrl) {
      logger.error(`OmniHuman completed but no video URL: ${JSON.stringify(result)}`);
      throw new Error('OmniHuman API did not return a video URL');
    }

    // Download video buffer for Supabase upload
    logger.info(`Downloading OmniHuman video from fal.ai: ${videoUrl}`);
    const downloadResp = await axios.get(videoUrl, {
      responseType: 'arraybuffer',
      timeout: 120000,
      headers: { 'User-Agent': 'NewsAgentSaaS/1.0' }
    });
    const videoBuffer = Buffer.from(downloadResp.data);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`OmniHuman video ready in ${elapsed}s — ${(videoBuffer.length / (1024 * 1024)).toFixed(1)}MB`);

    return {
      videoUrl,
      videoBuffer,
      duration: null, // Duration is audio-driven; caller knows from TTS output
      model: 'omnihuman-1.5'
    };
  }

  /**
   * Poll the fal.ai queue endpoint until the job completes.
   * Same pattern as KlingService._pollJob.
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
          logger.warn(`OmniHuman status 404 (request may still be queueing)`);
          continue;
        }
        if (err.response) {
          const errBody = typeof err.response.data === 'object'
            ? JSON.stringify(err.response.data)
            : String(err.response.data || '').slice(0, 1000);
          logger.error(`OmniHuman poll error ${err.response.status}: ${errBody}`);
          throw new Error(`OmniHuman poll ${err.response.status}: ${errBody}`);
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
        throw new Error(`OmniHuman generation failed: ${errorDetail}`);
      }

      logger.info(`OmniHuman job ${requestId} status: ${status} (${elapsed}s elapsed)`);
    }

    throw new Error(`OmniHuman generation timed out after ${MAX_POLL_DURATION_MS / 1000}s`);
  }
}

// Singleton export
const omniHumanService = new OmniHumanService();
export default omniHumanService;
export { OmniHumanService };
