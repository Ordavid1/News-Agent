// services/VideoGenerationService.js
// Abstraction layer over Google Veo 3.1 Fast and Runway 4.5 (Gen-4.5)
// for text+image-to-video generation with native audio.

import axios from 'axios';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[VideoGenerationService] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

// Polling configuration
const POLL_INTERVAL_MS = 5000;        // 5 seconds between polls
const MAX_POLL_DURATION_MS = 300000;  // 5 minutes max wait

/**
 * VideoGenerationService
 *
 * Generates short-form videos from an image + text prompt using either
 * Google Veo 3.1 Fast or Runway 4.5. Both models produce MP4 with native audio.
 *
 * The active model is controlled by the VIDEO_GENERATION_MODEL env var ("veo" or "runway").
 */
class VideoGenerationService {
  constructor() {
    this.model = (process.env.VIDEO_GENERATION_MODEL || 'veo').toLowerCase();

    if (this.model === 'veo') {
      this.googleApiKey = process.env.GOOGLE_AI_STUDIO_API_KEY;
      if (!this.googleApiKey) {
        logger.warn('VIDEO_GENERATION_MODEL=veo but GOOGLE_AI_STUDIO_API_KEY is not set');
      }
    } else if (this.model === 'runway') {
      this.runwayApiKey = process.env.RUNWAY_API_KEY;
      if (!this.runwayApiKey) {
        logger.warn('VIDEO_GENERATION_MODEL=runway but RUNWAY_API_KEY is not set');
      }
    } else {
      logger.warn(`Unknown VIDEO_GENERATION_MODEL: ${this.model}, defaulting to veo`);
      this.model = 'veo';
    }

    logger.info(`VideoGenerationService initialized — active model: ${this.model}`);
  }

  /**
   * Generate a video from an image and text prompt.
   * @param {Object} params
   * @param {string} params.imageUrl - Publicly accessible image URL
   * @param {string} params.prompt - Video generation prompt (from VideoPromptEngine)
   * @returns {Promise<Object>} { videoUrl, duration, model }
   */
  async generateVideo({ imageUrl, prompt }) {
    logger.info(`Generating video with ${this.model} — prompt: ${prompt.slice(0, 100)}...`);
    logger.info(`Source image: ${imageUrl}`);

    const startTime = Date.now();

    try {
      let result;

      if (this.model === 'runway') {
        result = await this.generateWithRunway({ imageUrl, prompt });
      } else {
        result = await this.generateWithVeo({ imageUrl, prompt });
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`Video generated successfully in ${elapsed}s — URL: ${result.videoUrl}`);

      return {
        videoUrl: result.videoUrl,
        duration: result.duration,
        model: this.model
      };
    } catch (error) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.error(`Video generation failed after ${elapsed}s: ${error.message}`);
      throw error;
    }
  }

  // ═══════════════════════════════════════════════════
  // GOOGLE VEO 3.1 FAST (via Gemini API / AI Studio)
  // ═══════════════════════════════════════════════════

  /**
   * Generate video using Google Veo 3.1 Fast via the Gemini API (Google AI Studio).
   * Auth is a simple API key — no GCP project or service account required.
   * Uses image (base64) + text prompt, returns a publicly accessible video URL.
   */
  async generateWithVeo({ imageUrl, prompt }) {
    if (!this.googleApiKey) {
      throw new Error('GOOGLE_AI_STUDIO_API_KEY env var is required for Veo video generation');
    }

    // 1. Download the source image and detect MIME type
    logger.info('Downloading source image for Veo...');
    const { base64, mimeType } = await this.downloadImageForVeo(imageUrl);
    logger.info(`Image downloaded — ${(base64.length / 1024).toFixed(0)} KB base64, type: ${mimeType}`);

    // 2. Submit video generation request via Gemini API
    const modelId = 'veo-3.1-fast-generate-preview';
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:predictLongRunning`;

    const requestBody = {
      instances: [{
        prompt,
        image: {
          inlineData: {
            mimeType,
            data: base64
          }
        }
      }],
      parameters: {
        aspectRatio: '9:16',
        resolution: '1080p',
        durationSeconds: '8',
        generateAudio: true,
        sampleCount: 1
      }
    };

    logger.info('Submitting Veo video generation request (Gemini API)...');
    const submitResponse = await axios.post(endpoint, requestBody, {
      headers: {
        'x-goog-api-key': this.googleApiKey,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    const operationName = submitResponse.data.name;
    if (!operationName) {
      throw new Error('Veo API did not return an operation name');
    }

    logger.info(`Veo operation started: ${operationName}`);

    // 3. Poll for completion
    const result = await this.pollVeoOperation(operationName);

    // 4. Extract video URL from response
    // Gemini API response format: generateVideoResponse.generatedSamples[0].video.uri
    const videoUri = result?.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri
      || result?.response?.predictions?.[0]?.videoUri
      || result?.response?.predictions?.[0]?.video?.uri;

    if (!videoUri) {
      logger.error('Veo response structure:', JSON.stringify(result?.response, null, 2));
      throw new Error('Veo API did not return a video URI in the response');
    }

    return { videoUrl: videoUri, duration: 8 };
  }

  /**
   * Poll a Veo Long Running Operation via Gemini API until completion.
   */
  async pollVeoOperation(operationName) {
    const deadline = Date.now() + MAX_POLL_DURATION_MS;
    let attempt = 0;
    const operationUrl = `https://generativelanguage.googleapis.com/v1beta/${operationName}`;

    while (Date.now() < deadline) {
      attempt++;
      const response = await axios.get(operationUrl, {
        headers: { 'x-goog-api-key': this.googleApiKey },
        timeout: 15000
      });

      const operation = response.data;

      if (operation.done) {
        if (operation.error) {
          throw new Error(`Veo operation failed: ${operation.error.message || JSON.stringify(operation.error)}`);
        }
        logger.info(`Veo operation completed after ${attempt} polls`);
        return operation;
      }

      logger.debug(`Veo poll #${attempt}: still processing...`);
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new Error(`Veo video generation timed out after ${MAX_POLL_DURATION_MS / 1000}s`);
  }

  /**
   * Download an image and return base64 + detected MIME type for the Gemini API.
   */
  async downloadImageForVeo(imageUrl) {
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: { 'User-Agent': 'NewsAgentSaaS/1.0' }
    });

    const contentType = response.headers['content-type'] || '';
    let mimeType = 'image/jpeg'; // default

    if (contentType.includes('png')) mimeType = 'image/png';
    else if (contentType.includes('webp')) mimeType = 'image/webp';
    else if (contentType.includes('gif')) mimeType = 'image/gif';
    else if (contentType.includes('jpeg') || contentType.includes('jpg')) mimeType = 'image/jpeg';

    return {
      base64: Buffer.from(response.data).toString('base64'),
      mimeType
    };
  }

  // ═══════════════════════════════════════════════════
  // RUNWAY 4.5 (Gen-4.5)
  // ═══════════════════════════════════════════════════

  /**
   * Generate video using Runway 4.5 via the official @runwayml/sdk.
   * Uses image URL + text prompt, returns a publicly accessible video URL.
   */
  async generateWithRunway({ imageUrl, prompt }) {
    if (!this.runwayApiKey) {
      throw new Error('RUNWAY_API_KEY env var is required for Runway video generation');
    }

    // Dynamic import to avoid requiring the SDK when using Veo
    const RunwayML = (await import('@runwayml/sdk')).default;

    const client = new RunwayML({ apiKey: this.runwayApiKey });

    // Submit image-to-video task
    logger.info('Submitting Runway 4.5 image-to-video task...');

    const task = await client.imageToVideo.create({
      model: 'gen4.5',
      promptImage: imageUrl,
      promptText: prompt,
      ratio: '720:1280',
      duration: 5
    });

    const taskId = task.id;
    logger.info(`Runway task created: ${taskId}`);

    // Poll for completion
    const deadline = Date.now() + MAX_POLL_DURATION_MS;
    let attempt = 0;

    while (Date.now() < deadline) {
      attempt++;
      const taskStatus = await client.tasks.retrieve(taskId);

      if (taskStatus.status === 'SUCCEEDED') {
        logger.info(`Runway task completed after ${attempt} polls`);
        const videoUrl = taskStatus.output?.[0];
        if (!videoUrl) {
          throw new Error('Runway task succeeded but no video URL in output');
        }
        return { videoUrl, duration: 5 };
      }

      if (taskStatus.status === 'FAILED') {
        throw new Error(`Runway task failed: ${taskStatus.failure || 'Unknown error'}`);
      }

      if (taskStatus.status === 'CANCELED') {
        throw new Error('Runway task was canceled');
      }

      logger.debug(`Runway poll #${attempt}: status=${taskStatus.status}`);
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new Error(`Runway video generation timed out after ${MAX_POLL_DURATION_MS / 1000}s`);
  }

  // ═══════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════

  /**
   * Download an image from a URL and return as base64 string.
   */
  async downloadImageAsBase64(imageUrl) {
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: {
        'User-Agent': 'NewsAgentSaaS/1.0'
      }
    });

    return Buffer.from(response.data).toString('base64');
  }

  /**
   * Download a video from a URL and return as a Buffer.
   * Useful for FILE_UPLOAD fallback if PULL_FROM_URL fails.
   */
  async downloadVideoAsBuffer(videoUrl) {
    logger.info(`Downloading video from ${videoUrl}...`);
    const response = await axios.get(videoUrl, {
      responseType: 'arraybuffer',
      timeout: 60000,
      headers: {
        'User-Agent': 'NewsAgentSaaS/1.0'
      }
    });

    const buffer = Buffer.from(response.data);
    logger.info(`Video downloaded — ${(buffer.length / (1024 * 1024)).toFixed(1)} MB`);
    return buffer;
  }

  /**
   * Get the currently active video generation model name.
   */
  getActiveModel() {
    return this.model;
  }
}

// Export singleton instance
const videoGenerationService = new VideoGenerationService();
export default videoGenerationService;
export { VideoGenerationService };
