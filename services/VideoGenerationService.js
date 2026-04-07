// services/VideoGenerationService.js
// Abstraction layer over Google Veo 3.1 Fast and Runway 4.5 (Gen-4.5)
// for text+image-to-video generation with native audio.

import axios from 'axios';
import winston from 'winston';
import { GoogleAuth } from 'google-auth-library';

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
const MAX_POLL_DURATION_MS = 600000;  // 10 minutes max wait (Runway Gen-4.5 10s videos can take 5-10 min)

/**
 * Custom error for video generation content filter rejections.
 * Carries the original prompt and model name so callers can rephrase and retry.
 * Follows the same pattern as TokenDecryptionError in TokenManager.js.
 */
class ContentFilterError extends Error {
  constructor(message, { originalPrompt, model } = {}) {
    super(message);
    this.name = 'ContentFilterError';
    this.originalPrompt = originalPrompt || '';
    this.model = model || 'unknown';
    this.isContentFilter = true;
  }
}

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

    if (!['veo', 'runway'].includes(this.model)) {
      logger.warn(`Unknown VIDEO_GENERATION_MODEL: ${this.model}, defaulting to veo`);
      this.model = 'veo';
    }

    // Load API keys for both models — enables cross-model fallback
    this.googleApiKey = process.env.GOOGLE_AI_STUDIO_API_KEY;
    this.runwayApiKey = process.env.RUNWAY_API_KEY;

    // Veo backend selector: "vertex" (GCP Vertex AI — higher quotas) or "ai_studio" (legacy).
    // Defaults to "vertex" once GCP config is present, otherwise falls back to "ai_studio".
    this.veoBackend = (process.env.VIDEO_GENERATION_VEO_BACKEND || 'vertex').toLowerCase();
    if (!['vertex', 'ai_studio'].includes(this.veoBackend)) {
      logger.warn(`Unknown VIDEO_GENERATION_VEO_BACKEND: ${this.veoBackend}, defaulting to vertex`);
      this.veoBackend = 'vertex';
    }

    // Vertex AI config
    this.gcpProjectId = process.env.GCP_PROJECT_ID;
    this.gcpLocation = process.env.GCP_LOCATION || 'us-central1';
    this.vertexAuth = null;

    if (this.veoBackend === 'vertex') {
      // Guardrail from CLAUDE.md: never operate on the crypto-coral-328619 project
      if (this.gcpProjectId === 'crypto-coral-328619') {
        throw new Error('Refusing to initialize VideoGenerationService against GCP project crypto-coral-328619 (wrong app per CLAUDE.md)');
      }

      try {
        const credsRaw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
        if (credsRaw && this.gcpProjectId) {
          const credentials = JSON.parse(credsRaw);
          this.vertexAuth = new GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/cloud-platform']
          });
        } else {
          logger.warn('Veo backend=vertex but GCP_PROJECT_ID or GOOGLE_APPLICATION_CREDENTIALS_JSON is missing — Vertex calls will fail at request time');
        }
      } catch (err) {
        logger.warn(`Failed to parse GOOGLE_APPLICATION_CREDENTIALS_JSON: ${err.message} — Vertex calls will fail at request time`);
      }
    }

    // Warn if primary model's key is missing
    if (this.model === 'veo') {
      if (this.veoBackend === 'ai_studio' && !this.googleApiKey) {
        logger.warn('VIDEO_GENERATION_MODEL=veo (backend=ai_studio) but GOOGLE_AI_STUDIO_API_KEY is not set');
      } else if (this.veoBackend === 'vertex' && !this.vertexAuth) {
        logger.warn('VIDEO_GENERATION_MODEL=veo (backend=vertex) but Vertex auth is not configured');
      }
    } else if (this.model === 'runway' && !this.runwayApiKey) {
      logger.warn('VIDEO_GENERATION_MODEL=runway but RUNWAY_API_KEY is not set');
    }

    // Determine fallback model (the other one, if its credentials are configured)
    this.fallbackModel = this.model === 'veo' ? 'runway' : 'veo';
    const veoCredsAvailable = this.veoBackend === 'vertex' ? !!this.vertexAuth : !!this.googleApiKey;
    const fallbackKeyAvailable = this.fallbackModel === 'veo' ? veoCredsAvailable : !!this.runwayApiKey;
    this.hasFallback = fallbackKeyAvailable;

    const backendLabel = this.model === 'veo' ? ` (backend: ${this.veoBackend})` : '';
    logger.info(`VideoGenerationService initialized — active model: ${this.model}${backendLabel}${this.hasFallback ? `, fallback: ${this.fallbackModel}` : ', no fallback configured'}`);
  }

  /**
   * Generate a video from an image and text prompt using a specific model.
   * @param {Object} params
   * @param {string} params.imageUrl - Publicly accessible image URL
   * @param {string} params.prompt - Video generation prompt (from VideoPromptEngine)
   * @param {boolean} [params.skipImage=false] - Skip reference image (text-only generation)
   * @param {string} [params.useModel] - Override model ('veo' or 'runway'). Defaults to this.model.
   * @returns {Promise<Object>} { videoUrl, videoBuffer, duration, model }
   */
  async generateVideo({ imageUrl, prompt, skipImage = false, useModel = null }) {
    const activeModel = useModel || this.model;
    logger.info(`Generating video with ${activeModel} — prompt: ${prompt.slice(0, 100)}...`);
    logger.info(`Source image: ${skipImage ? '(skipped — text-only mode)' : imageUrl}`);

    const startTime = Date.now();

    try {
      let result;

      if (activeModel === 'runway') {
        result = await this.generateWithRunway({ imageUrl, prompt, skipImage });
      } else {
        result = await this.generateWithVeo({ imageUrl, prompt, skipImage });
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`Video generated successfully in ${elapsed}s (${activeModel}) — URL: ${result.videoUrl}`);

      return {
        videoUrl: result.videoUrl,
        videoBuffer: result.videoBuffer || null,
        duration: result.duration,
        model: activeModel
      };
    } catch (error) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (error.isContentFilter) {
        logger.warn(`Video blocked by content filter after ${elapsed}s (${error.model}): ${error.message}`);
      } else {
        logger.error(`Video generation failed after ${elapsed}s (${activeModel}): ${error.message}`);
      }
      // Log the full API error response body for debugging (Google/Runway return details here)
      if (error.response?.data) {
        logger.error(`API error response: ${JSON.stringify(error.response.data, null, 2)}`);
      }
      throw error;
    }
  }

  // ═══════════════════════════════════════════════════
  // GOOGLE VEO 3.1 FAST
  // Supported backends: Vertex AI (GCP, higher quotas) + Google AI Studio (legacy)
  // ═══════════════════════════════════════════════════

  /**
   * Veo model ID. Identical between Vertex AI and AI Studio backends.
   */
  get veoModelId() {
    // Vertex AI uses the GA model ID; AI Studio uses the preview ID
    return this.veoBackend === 'vertex'
      ? 'veo-3.1-fast-generate-001'
      : 'veo-3.1-fast-generate-preview';
  }

  /**
   * Build the Veo request `instance` object (prompt + optional reference image).
   * Shared between Vertex and AI Studio backends so the two can't drift.
   */
  async _buildVeoInstance({ imageUrl, prompt, skipImage }) {
    const instance = { prompt };
    if (!skipImage && imageUrl) {
      logger.info('Downloading source image for Veo...');
      const { base64, mimeType } = await this.downloadImageForVeo(imageUrl);
      logger.info(`Image downloaded — ${(base64.length / 1024).toFixed(0)} KB base64, type: ${mimeType}`);
      instance.referenceImages = [{
        image: { bytesBase64Encoded: base64, mimeType },
        referenceType: 'asset'
      }];
    } else if (skipImage) {
      logger.info('Skipping reference image — text-only video generation (content filter fallback)');
    }
    return instance;
  }

  /**
   * Build the Veo `parameters` object. Identical across both backends.
   */
  _buildVeoParameters() {
    return {
      aspectRatio: '9:16',
      resolution: '1080p',
      durationSeconds: 8,
      personGeneration: 'allow_adult',  // Reduce false positives on adult faces
      generateAudio: true               // Explicit — Vertex default can differ
    };
  }

  /**
   * Extract RAI content-filter signals from a completed Veo LRO response.
   * Supports both Vertex AI and AI Studio response shapes.
   * Returns a descriptive string if filtered, or null otherwise.
   */
  _extractVeoFilterReason(result) {
    const response = result?.response || {};
    const metadata = result?.metadata || {};

    const blockReason = response.promptFeedback?.blockReason
      || response.generateVideoResponse?.raiMediaFilteredCount
      || response.raiMediaFilteredCount
      || metadata.raiMediaFilteredCount;

    if (!blockReason) return null;

    const reasons = response.generateVideoResponse?.raiMediaFilteredReasons
      || response.raiMediaFilteredReasons
      || metadata.raiMediaFilteredReasons
      || [];

    return reasons.length > 0 ? reasons.join('; ') : String(blockReason);
  }

  /**
   * Top-level Veo dispatcher — routes to Vertex AI or AI Studio backend.
   */
  async generateWithVeo({ imageUrl, prompt, skipImage = false }) {
    if (this.veoBackend === 'vertex') {
      return this._generateWithVeoVertex({ imageUrl, prompt, skipImage });
    }
    return this._generateWithVeoAIStudio({ imageUrl, prompt, skipImage });
  }

  // ───────────────────────────────────────────────────
  // Vertex AI backend (GCP)
  // ───────────────────────────────────────────────────

  async _getVertexAccessToken() {
    if (!this.vertexAuth) {
      throw new Error('Vertex AI auth is not configured — set GCP_PROJECT_ID and GOOGLE_APPLICATION_CREDENTIALS_JSON');
    }
    const client = await this.vertexAuth.getClient();
    const { token } = await client.getAccessToken();
    if (!token) {
      throw new Error('Failed to obtain Vertex AI access token from service account credentials');
    }
    return token;
  }

  async _generateWithVeoVertex({ imageUrl, prompt, skipImage = false }) {
    if (!this.vertexAuth || !this.gcpProjectId) {
      throw new Error('Vertex AI not configured — GCP_PROJECT_ID and GOOGLE_APPLICATION_CREDENTIALS_JSON are required');
    }

    const modelId = this.veoModelId;
    const endpoint = `https://${this.gcpLocation}-aiplatform.googleapis.com/v1/projects/${this.gcpProjectId}/locations/${this.gcpLocation}/publishers/google/models/${modelId}:predictLongRunning`;

    const instance = await this._buildVeoInstance({ imageUrl, prompt, skipImage });
    const requestBody = {
      instances: [instance],
      parameters: this._buildVeoParameters()
    };

    logger.info(`Submitting Veo video generation request (Vertex AI, project=${this.gcpProjectId}, location=${this.gcpLocation})...`);

    const token = await this._getVertexAccessToken();

    // Retry with exponential backoff on 429 (quota/rate limit) errors
    let submitResponse;
    const maxRetries = 3;
    for (let retryAttempt = 0; retryAttempt < maxRetries; retryAttempt++) {
      try {
        submitResponse = await axios.post(endpoint, requestBody, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          timeout: 60000
        });
        break;
      } catch (err) {
        if (err.response?.status === 429 && retryAttempt < maxRetries - 1) {
          const backoff = (retryAttempt + 1) * 5000;
          logger.warn(`Vertex Veo API rate limited (429) — retrying in ${backoff / 1000}s (attempt ${retryAttempt + 1}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, backoff));
        } else {
          throw err;
        }
      }
    }

    const operationName = submitResponse.data.name;
    if (!operationName) {
      throw new Error('Vertex Veo API did not return an operation name');
    }
    logger.info(`Veo operation started (Vertex): ${operationName}`);

    const result = await this._pollVertexOperation(operationName);

    // Vertex AI returns video bytes inline as base64 in the LRO response.
    // Response shapes observed:
    //   result.response.videos[].bytesBase64Encoded
    //   result.response.generateVideoResponse.generatedSamples[].video.bytesBase64Encoded
    //   result.response.predictions[].bytesBase64Encoded
    const videoB64 = result?.response?.videos?.[0]?.bytesBase64Encoded
      || result?.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.bytesBase64Encoded
      || result?.response?.generatedSamples?.[0]?.video?.bytesBase64Encoded
      || result?.response?.predictions?.[0]?.bytesBase64Encoded;

    if (!videoB64) {
      logger.error('Vertex Veo full operation result:', JSON.stringify(result, null, 2));
      const filterReason = this._extractVeoFilterReason(result);
      if (filterReason) {
        logger.warn(`Vertex Veo RAI filter reasons: ${filterReason}`);
        throw new ContentFilterError(
          `Veo video was blocked by content filters: ${filterReason}`,
          { originalPrompt: prompt, model: 'veo' }
        );
      }
      throw new Error('Vertex Veo API did not return video bytes in the response');
    }

    const videoBuffer = Buffer.from(videoB64, 'base64');
    logger.info(`Vertex Veo video decoded — ${(videoBuffer.length / (1024 * 1024)).toFixed(1)} MB`);

    // videoUrl is diagnostic only — callers consume videoBuffer
    return { videoUrl: `vertex-operation:${operationName}`, videoBuffer, duration: 8 };
  }

  /**
   * Poll a Vertex AI Long Running Operation until completion.
   * Refreshes the access token on every poll so requests spanning the token's
   * 1-hour lifetime don't 401.
   */
  async _pollVertexOperation(operationName) {
    const deadline = Date.now() + MAX_POLL_DURATION_MS;
    let attempt = 0;
    // Vertex AI video models use fetchPredictOperation (POST on the model endpoint)
    // NOT the generic GET /operations/ path (which expects a numeric Long ID).
    // operationName is the full resource path returned by predictLongRunning, e.g.:
    //   "projects/P/locations/L/publishers/google/models/M/operations/UUID"
    const modelId = this.veoModelId;
    const fetchUrl = `https://${this.gcpLocation}-aiplatform.googleapis.com/v1/projects/${this.gcpProjectId}/locations/${this.gcpLocation}/publishers/google/models/${modelId}:fetchPredictOperation`;

    while (Date.now() < deadline) {
      attempt++;
      const token = await this._getVertexAccessToken();
      const response = await axios.post(fetchUrl, {
        operationName
      }, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      });

      const operation = response.data;
      if (operation.done) {
        if (operation.error) {
          throw new Error(`Vertex Veo operation failed: ${operation.error.message || JSON.stringify(operation.error)}`);
        }
        logger.info(`Vertex Veo operation completed after ${attempt} polls`);
        return operation;
      }
      logger.debug(`Vertex Veo poll #${attempt}: still processing...`);
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new Error(`Vertex Veo video generation timed out after ${MAX_POLL_DURATION_MS / 1000}s`);
  }

  // ───────────────────────────────────────────────────
  // AI Studio backend (legacy — retained for rollback)
  // ───────────────────────────────────────────────────

  /**
   * Generate video using Google Veo via the Gemini API (Google AI Studio).
   * Auth is a simple API key — no GCP project or service account required.
   * NOTE: Subject to strict per-project rate limits. Prefer the Vertex backend.
   */
  async _generateWithVeoAIStudio({ imageUrl, prompt, skipImage = false }) {
    if (!this.googleApiKey) {
      throw new Error('GOOGLE_AI_STUDIO_API_KEY env var is required for Veo video generation (ai_studio backend)');
    }

    const modelId = this.veoModelId;
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:predictLongRunning`;

    const instance = await this._buildVeoInstance({ imageUrl, prompt, skipImage });
    const requestBody = {
      instances: [instance],
      parameters: this._buildVeoParameters()
    };

    logger.info('Submitting Veo video generation request (Gemini API / AI Studio)...');

    // Retry with exponential backoff on 429 (quota/rate limit) errors
    let submitResponse;
    const maxRetries = 3;
    for (let retryAttempt = 0; retryAttempt < maxRetries; retryAttempt++) {
      try {
        submitResponse = await axios.post(endpoint, requestBody, {
          headers: {
            'x-goog-api-key': this.googleApiKey,
            'Content-Type': 'application/json'
          },
          timeout: 60000  // 60s — large base64 payloads need more time
        });
        break;
      } catch (err) {
        if (err.response?.status === 429 && retryAttempt < maxRetries - 1) {
          const backoff = (retryAttempt + 1) * 5000; // 5s, 10s
          logger.warn(`Veo API rate limited (429) — retrying in ${backoff / 1000}s (attempt ${retryAttempt + 1}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, backoff));
        } else {
          throw err;
        }
      }
    }

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
      || result?.response?.predictions?.[0]?.video?.uri
      // Additional paths observed in Veo API responses:
      || result?.response?.generatedSamples?.[0]?.video?.uri
      || result?.metadata?.generatedSamples?.[0]?.video?.uri
      || result?.result?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;

    if (!videoUri) {
      logger.error('Veo full operation result:', JSON.stringify(result, null, 2));
      const filterReason = this._extractVeoFilterReason(result);
      if (filterReason) {
        logger.warn(`Veo RAI filter reasons: ${filterReason}`);
        throw new ContentFilterError(
          `Veo video was blocked by content filters: ${filterReason}`,
          { originalPrompt: prompt, model: 'veo' }
        );
      }
      throw new Error('Veo API did not return a video URI in the response');
    }

    // Download the video immediately with API key authentication.
    // Veo download URLs at generativelanguage.googleapis.com require the x-goog-api-key header —
    // neither TikTok's PULL_FROM_URL nor our generic downloader passes it.
    logger.info(`Downloading Veo video with API key auth: ${videoUri}`);
    const videoResponse = await axios.get(videoUri, {
      responseType: 'arraybuffer',
      timeout: 120000,
      headers: {
        'x-goog-api-key': this.googleApiKey,
        'User-Agent': 'NewsAgentSaaS/1.0'
      }
    });
    const videoBuffer = Buffer.from(videoResponse.data);
    logger.info(`Veo video downloaded — ${(videoBuffer.length / (1024 * 1024)).toFixed(1)} MB`);

    return { videoUrl: videoUri, videoBuffer, duration: 8 };
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
  // VEO 3.1 STANDARD — FIRST + LAST FRAME (Cinematic Fallback)
  // ═══════════════════════════════════════════════════

  /**
   * Generate a video using Veo 3.1 Standard via Vertex AI with first-frame
   * and optional last-frame anchoring. This is the cinematic v2 fallback
   * path — used when Kling multi-shot fails.
   *
   * Uses storyboard panels as first/last frames for perfect shot-to-shot
   * continuity (Panel N = start, Panel N+1 = end).
   *
   * NOTE: referenceImages CANNOT be used with image/lastFrame (API constraint).
   * We choose first+last frame over identity-lock refs because storyboard
   * panels already contain the character.
   *
   * @param {Object} params
   * @param {string} params.firstImageUrl - Start frame (storyboard panel N)
   * @param {string} [params.lastImageUrl] - End frame (storyboard panel N+1, null for last shot)
   * @param {string} params.prompt - Scene description with style + visual_direction + audio cues
   * @param {string} [params.cameraControl] - Veo camera motion enum (e.g., 'push_in', 'crane_up')
   * @param {Object} [params.options]
   * @param {number} [params.options.durationSeconds=6] - 4-8s per shot
   * @param {string} [params.options.aspectRatio='9:16']
   * @returns {Promise<Object>} { videoUrl, videoBuffer, duration, model }
   */
  async generateWithFirstLastFrame({ firstImageUrl, lastImageUrl, prompt, cameraControl, options = {} }) {
    if (!this.vertexAuth || !this.gcpProjectId) {
      throw new Error('Vertex AI not configured — required for Veo 3.1 Standard first+last frame');
    }

    const {
      durationSeconds = 6,
      aspectRatio = '9:16'
    } = options;

    // Veo 3.1 Standard (Preview) — supports lastFrame + cameraControl.
    // GA version (veo-3.1-generate-001) may not support lastFrame yet.
    const modelId = 'veo-3.1-generate-preview';
    const endpoint = `https://${this.gcpLocation}-aiplatform.googleapis.com/v1/projects/${this.gcpProjectId}/locations/${this.gcpLocation}/publishers/google/models/${modelId}:predictLongRunning`;

    // Download + base64-encode first frame (convert WebP→JPEG if needed — Veo only accepts JPEG/PNG)
    logger.info(`Veo 3.1 Standard: downloading first frame...`);
    const firstImage = await this._downloadImageAsJpegForVeo(firstImageUrl);

    // Build instance
    const instance = {
      prompt,
      image: { bytesBase64Encoded: firstImage.base64, mimeType: firstImage.mimeType }
    };

    // Veo constraint: lastFrame + cameraControl CANNOT be combined.
    // When we have lastFrame (shots 1-2), the model interpolates motion naturally between panels.
    // When we DON'T have lastFrame (shot 3, the final shot), cameraControl can guide the motion.
    if (lastImageUrl) {
      logger.info(`Veo 3.1 Standard: downloading last frame...`);
      const lastImage = await this._downloadImageAsJpegForVeo(lastImageUrl);
      instance.lastFrame = { bytesBase64Encoded: lastImage.base64, mimeType: lastImage.mimeType };
      // cameraControl intentionally omitted — incompatible with lastFrame
      if (cameraControl) {
        logger.info(`Veo 3.1 Standard: dropping cameraControl=${cameraControl} (incompatible with lastFrame)`);
      }
    } else if (cameraControl) {
      // No lastFrame — safe to use cameraControl
      instance.cameraControl = cameraControl;
    }

    const parameters = {
      aspectRatio,
      resolution: '1080p',
      durationSeconds,
      personGeneration: 'allow_adult',
      generateAudio: true
    };

    let requestBody = { instances: [instance], parameters };

    logger.info(`Veo 3.1 Standard: submitting (first_frame=yes, last_frame=${lastImageUrl ? 'yes' : 'no'}, camera=${cameraControl || 'auto'}, ${durationSeconds}s, ${aspectRatio})`);

    const token = await this._getVertexAccessToken();

    // Retry with exponential backoff on 429
    let submitResponse;
    const maxRetries = 3;
    for (let retryAttempt = 0; retryAttempt < maxRetries; retryAttempt++) {
      try {
        submitResponse = await axios.post(endpoint, requestBody, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          timeout: 90000 // Longer timeout for Standard tier (larger payload with 2 images)
        });
        break;
      } catch (err) {
        if (err.response?.status === 429 && retryAttempt < maxRetries - 1) {
          const backoff = (retryAttempt + 1) * 8000;
          logger.warn(`Veo 3.1 Standard rate limited (429) — retrying in ${backoff / 1000}s`);
          await new Promise(resolve => setTimeout(resolve, backoff));
        } else {
          if (err.response) {
            logger.error(`Veo 3.1 Standard submit error ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 500)}`);
          }
          throw err;
        }
      }
    }

    const operationName = submitResponse.data.name;
    if (!operationName) throw new Error('Veo 3.1 Standard did not return an operation name');

    logger.info(`Veo 3.1 Standard operation started: ${operationName}`);

    // Poll using existing infrastructure (reuse _pollVertexOperation but with Standard model ID)
    const result = await this._pollVertexOperationForModel(operationName, modelId);

    // Extract video buffer (same response format as Fast tier)
    const videoB64 = result?.response?.videos?.[0]?.bytesBase64Encoded
      || result?.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.bytesBase64Encoded
      || result?.response?.generatedSamples?.[0]?.video?.bytesBase64Encoded
      || result?.response?.predictions?.[0]?.bytesBase64Encoded;

    if (!videoB64) {
      const filterReason = this._extractVeoFilterReason(result);
      if (filterReason) {
        throw new ContentFilterError(
          `Veo 3.1 Standard blocked by content filters: ${filterReason}`,
          { originalPrompt: prompt, model: 'veo-3.1-standard' }
        );
      }
      logger.error(`Veo 3.1 Standard response: ${JSON.stringify(result).slice(0, 500)}`);
      throw new Error('Veo 3.1 Standard did not return video bytes');
    }

    const videoBuffer = Buffer.from(videoB64, 'base64');
    logger.info(`Veo 3.1 Standard video decoded — ${(videoBuffer.length / (1024 * 1024)).toFixed(1)} MB, ${durationSeconds}s`);

    return {
      videoUrl: `vertex-operation:${operationName}`,
      videoBuffer,
      duration: durationSeconds,
      model: 'veo-3.1-standard'
    };
  }

  /**
   * Poll a Vertex AI LRO for a specific model ID (needed because _pollVertexOperation
   * uses the instance's veoModelId which is the Fast tier).
   */
  async _pollVertexOperationForModel(operationName, modelId) {
    const deadline = Date.now() + MAX_POLL_DURATION_MS;
    let attempt = 0;
    const fetchUrl = `https://${this.gcpLocation}-aiplatform.googleapis.com/v1/projects/${this.gcpProjectId}/locations/${this.gcpLocation}/publishers/google/models/${modelId}:fetchPredictOperation`;

    while (Date.now() < deadline) {
      attempt++;
      const token = await this._getVertexAccessToken();

      const response = await axios.post(fetchUrl, { operationName }, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      });

      const operation = response.data;
      if (operation.done) {
        if (operation.error) {
          throw new Error(`Veo 3.1 Standard operation failed: ${operation.error.message || JSON.stringify(operation.error)}`);
        }
        logger.info(`Veo 3.1 Standard operation completed after ${attempt} polls`);
        return operation;
      }

      logger.info(`Veo 3.1 Standard poll #${attempt}: still processing...`);
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new Error(`Veo 3.1 Standard timed out after ${MAX_POLL_DURATION_MS / 1000}s`);
  }

  /**
   * Map free-form camera_notes from Gemini to Veo's cameraControl enum values.
   * Returns null if no clear mapping (Veo will use prompt-guided motion instead).
   */
  static mapCameraControl(cameraNotes) {
    if (!cameraNotes) return null;
    const lower = cameraNotes.toLowerCase();

    const mappings = [
      { keywords: ['push in', 'push-in', 'dolly forward', 'dolly in', 'move forward'], value: 'push_in' },
      { keywords: ['pull out', 'pull-out', 'pull back', 'pull-back', 'dolly back', 'dolly out', 'move back'], value: 'pull_out' },
      { keywords: ['pan left', 'pan-left'], value: 'pan_left' },
      { keywords: ['pan right', 'pan-right'], value: 'pan_right' },
      { keywords: ['tilt up', 'tilt-up'], value: 'tilt_up' },
      { keywords: ['tilt down', 'tilt-down'], value: 'tilt_down' },
      { keywords: ['orbit left', 'orbit-left', 'orbital left'], value: 'orbit_left' },
      { keywords: ['orbit right', 'orbit-right', 'orbital right'], value: 'orbit_right' },
      { keywords: ['crane up', 'crane-up', 'crane up reveal'], value: 'crane_up' },
      { keywords: ['crane down', 'crane-down'], value: 'crane_down' }
    ];

    for (const { keywords, value } of mappings) {
      if (keywords.some(kw => lower.includes(kw))) return value;
    }

    return null; // No match — Veo uses prompt text for motion guidance
  }

  /**
   * Download an image and ensure it's JPEG or PNG for Veo (which rejects WebP/GIF).
   * If the source is WebP, converts to JPEG via ffmpeg.
   */
  async _downloadImageAsJpegForVeo(imageUrl) {
    const downloaded = await this.downloadImageForVeo(imageUrl);

    // Veo accepts JPEG and PNG — if it's already one of those, return as-is
    if (downloaded.mimeType === 'image/jpeg' || downloaded.mimeType === 'image/png') {
      return downloaded;
    }

    // Convert WebP/GIF/other to JPEG via ffmpeg
    logger.info(`Converting ${downloaded.mimeType} → image/jpeg for Veo compatibility`);
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const fs = await import('fs/promises');
    const path = await import('path');
    const os = await import('os');
    const execFileAsync = promisify(execFile);

    const tmpDir = os.default.tmpdir();
    const ext = downloaded.mimeType.includes('webp') ? 'webp' : downloaded.mimeType.includes('gif') ? 'gif' : 'bin';
    const inputPath = path.default.join(tmpDir, `veo-convert-${Date.now()}.${ext}`);
    const outputPath = path.default.join(tmpDir, `veo-convert-${Date.now()}.jpg`);

    await fs.default.writeFile(inputPath, Buffer.from(downloaded.base64, 'base64'));
    await execFileAsync('ffmpeg', ['-y', '-i', inputPath, '-q:v', '2', outputPath]);
    const jpegBuffer = await fs.default.readFile(outputPath);

    // Cleanup
    await fs.default.unlink(inputPath).catch(() => {});
    await fs.default.unlink(outputPath).catch(() => {});

    return {
      base64: jpegBuffer.toString('base64'),
      mimeType: 'image/jpeg'
    };
  }

  // ═══════════════════════════════════════════════════
  // RUNWAY 4.5 (Gen-4.5)
  // ═══════════════════════════════════════════════════

  /**
   * Generate video using Runway 4.5 via the official @runwayml/sdk.
   * Uses image URL + text prompt, returns a publicly accessible video URL.
   */
  async generateWithRunway({ imageUrl, prompt, skipImage = false }) {
    if (!this.runwayApiKey) {
      throw new Error('RUNWAY_API_KEY env var is required for Runway video generation');
    }

    // Dynamic import to avoid requiring the SDK when using Veo
    const RunwayML = (await import('@runwayml/sdk')).default;

    const client = new RunwayML({ apiKey: this.runwayApiKey });

    // Submit image-to-video task (or text-only if image is skipped)
    // Runway Gen-4.5 has a 1000-char prompt limit (vs Veo's 1400).
    // When used as fallback, the prompt may have been generated for Veo's limit — truncate gracefully.
    const RUNWAY_PROMPT_LIMIT = 1000;
    let runwayPrompt = prompt;

    // Strip Veo audio direction paragraph when falling back from Veo → Runway
    // Veo prompts include "Audio direction:" as the final paragraph; Runway doesn't use audio cues
    const audioDirectionIndex = runwayPrompt.search(/\n\n\s*Audio direction:/i);
    if (audioDirectionIndex > 0) {
      logger.info('Stripping Veo audio direction from prompt for Runway fallback');
      runwayPrompt = runwayPrompt.slice(0, audioDirectionIndex).trim();
    }

    if (runwayPrompt.length > RUNWAY_PROMPT_LIMIT) {
      logger.warn(`Prompt exceeds Runway's ${RUNWAY_PROMPT_LIMIT}-char limit (${runwayPrompt.length} chars) — truncating`);
      const truncated = runwayPrompt.slice(0, RUNWAY_PROMPT_LIMIT);
      const lastPeriod = truncated.lastIndexOf('.');
      runwayPrompt = lastPeriod > RUNWAY_PROMPT_LIMIT * 0.7 ? truncated.slice(0, lastPeriod + 1) : truncated.slice(0, RUNWAY_PROMPT_LIMIT - 3) + '...';
    }

    const taskParams = {
      model: 'gen4.5',
      promptText: runwayPrompt,
      ratio: '720:1280',
      duration: 10
    };

    if (!skipImage && imageUrl) {
      taskParams.promptImage = imageUrl;
      logger.info('Submitting Runway 4.5 image-to-video task...');
    } else {
      logger.info('Submitting Runway 4.5 text-to-video task (content filter fallback)...');
    }

    const task = await client.imageToVideo.create(taskParams);

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
        return { videoUrl, duration: 10 };
      }

      if (taskStatus.status === 'FAILED') {
        const failureMsg = taskStatus.failure || 'Unknown error';
        const failureLower = failureMsg.toLowerCase();

        // Runway signals content moderation via failure message keywords
        const isContentFilter = ['content policy', 'moderation', 'safety filter',
          'content filter', 'violates', 'inappropriate', 'not allowed'].some(
            signal => failureLower.includes(signal)
        );

        if (isContentFilter) {
          throw new ContentFilterError(
            `Runway task blocked by content filters: ${failureMsg}`,
            { originalPrompt: prompt, model: 'runway' }
          );
        }

        throw new Error(`Runway task failed: ${failureMsg}`);
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
export { VideoGenerationService, ContentFilterError };
