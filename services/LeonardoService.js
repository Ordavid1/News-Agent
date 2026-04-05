// services/LeonardoService.js
// Leonardo.ai API wrapper for storyboard frame generation.
// Uses Character Reference (ControlNet ID 133) + Style Reference (ID 67)
// with the Kino XL model for cinematic storyboard frames.

import axios from 'axios';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[LeonardoService] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

const BASE_URL = 'https://cloud.leonardo.ai/api/rest/v1';

// Kino XL — optimized for cinematic compositions and dramatic lighting
const KINO_XL_MODEL_ID = 'aa77f04e-3eec-4034-9c07-d0f619684628';

// ControlNet preprocessor IDs
const CHARACTER_REFERENCE_ID = 133;
const STYLE_REFERENCE_ID = 67;

// Polling configuration
const POLL_INTERVAL_MS = 3000;        // 3 seconds between polls
const MAX_POLL_DURATION_MS = 120000;  // 2 minutes max wait

class LeonardoService {
  constructor() {
    this.apiKey = process.env.LEONARDO_API_KEY;

    if (!this.apiKey) {
      logger.warn('LEONARDO_API_KEY not set — storyboard frame generation will not be available');
    } else {
      logger.info('LeonardoService initialized');
    }
  }

  /**
   * Get default request headers
   */
  _headers() {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
  }

  /**
   * Upload a reference image (for character or style consistency).
   * Returns the Leonardo init-image ID for use in generation requests.
   *
   * @param {string} imageUrl - Publicly accessible URL of the reference image
   * @returns {Promise<string>} Leonardo init-image ID
   */
  async uploadReferenceImage(imageUrl) {
    if (!this.apiKey) throw new Error('LEONARDO_API_KEY is not configured');

    logger.info(`Uploading reference image: ${imageUrl.slice(0, 80)}...`);

    // Step 1: Get a presigned upload URL from Leonardo
    const initResponse = await axios.post(`${BASE_URL}/init-image`, {
      extension: 'jpg'
    }, { headers: this._headers(), timeout: 15000 });

    const { url: presignedUrl, fields, id: imageId } = initResponse.data?.uploadInitImage || {};
    if (!presignedUrl || !imageId) {
      throw new Error('Leonardo init-image did not return upload URL');
    }

    // Step 2: Download the source image
    const imageResponse = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30000
    });
    const imageBuffer = Buffer.from(imageResponse.data);

    // Step 3: Upload to Leonardo's presigned URL
    const formData = new FormData();
    // Append all presigned fields
    if (fields) {
      const parsedFields = typeof fields === 'string' ? JSON.parse(fields) : fields;
      for (const [key, value] of Object.entries(parsedFields)) {
        formData.append(key, value);
      }
    }
    formData.append('file', new Blob([imageBuffer], { type: 'image/jpeg' }));

    await axios.post(presignedUrl, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 30000
    });

    logger.info(`Reference image uploaded — Leonardo ID: ${imageId}`);
    return imageId;
  }

  /**
   * Generate a storyboard frame using Kino XL with optional character/style references.
   *
   * @param {Object} params
   * @param {string} params.prompt - Scene description prompt for the frame
   * @param {string} [params.characterRefId] - Leonardo init-image ID for character consistency
   * @param {string} [params.styleRefId] - Leonardo init-image ID for style consistency
   * @param {Object} [params.options]
   * @param {number} [params.options.width=768] - Output width
   * @param {number} [params.options.height=1360] - Output height (9:16 vertical by default)
   * @param {number} [params.options.numImages=1] - Number of variations
   * @param {string} [params.options.presetStyle='CINEMATIC'] - Leonardo preset style
   * @returns {Promise<Object>} { imageUrl, generationId, allImages[] }
   */
  async generateFrame({ prompt, characterRefId, styleRefId, options = {} }) {
    if (!this.apiKey) throw new Error('LEONARDO_API_KEY is not configured');

    const {
      width = 768,
      height = 1360,
      numImages = 1,
      presetStyle = 'CINEMATIC'
    } = options;

    logger.info(`Generating storyboard frame — prompt: ${prompt.slice(0, 100)}...`);

    // Build request body
    const body = {
      modelId: KINO_XL_MODEL_ID,
      prompt,
      width,
      height,
      num_images: numImages,
      presetStyle,
      alchemy: true,  // Enhanced quality pipeline
      contrast: 3.5    // Leonardo expects float (range 1.0-4.5). 3.5 = High contrast
    };

    // Add Character Reference (ControlNet) if provided.
    // Leonardo requires: initImageId + initImageType + preprocessorId + strengthType
    // strengthType enum: "Low" | "Mid" | "High" | "Max"
    const controlnets = [];
    if (characterRefId) {
      controlnets.push({
        initImageId: characterRefId,
        initImageType: 'UPLOADED',
        preprocessorId: CHARACTER_REFERENCE_ID,
        strengthType: 'High'
      });
    }
    if (styleRefId) {
      controlnets.push({
        initImageId: styleRefId,
        initImageType: 'UPLOADED',
        preprocessorId: STYLE_REFERENCE_ID,
        strengthType: 'Mid'
      });
    }
    if (controlnets.length > 0) {
      body.controlnets = controlnets;
    }

    // Submit generation request
    let submitResponse;
    try {
      submitResponse = await axios.post(`${BASE_URL}/generations`, body, {
        headers: this._headers(),
        timeout: 30000
      });
    } catch (err) {
      if (err.response) {
        logger.error(`Leonardo API ${err.response.status} error: ${JSON.stringify(err.response.data)}`);
        logger.error(`Request body was: ${JSON.stringify(body).slice(0, 500)}`);
      }
      throw err;
    }

    const generationId = submitResponse.data?.sdGenerationJob?.generationId;
    if (!generationId) {
      logger.error('Leonardo generation response:', JSON.stringify(submitResponse.data, null, 2));
      throw new Error('Leonardo API did not return a generationId');
    }

    logger.info(`Leonardo generation submitted — ID: ${generationId}`);

    // Poll for completion
    const result = await this._pollGeneration(generationId);

    const images = result.generated_images || [];
    if (images.length === 0) {
      throw new Error('Leonardo generation completed but returned no images');
    }

    logger.info(`Storyboard frame generated — ${images.length} image(s)`);

    return {
      imageUrl: images[0].url,
      generationId,
      allImages: images.map(img => ({
        url: img.url,
        id: img.id,
        nsfw: img.nsfw || false
      }))
    };
  }

  /**
   * Poll a generation until it completes or fails.
   * @param {string} generationId
   * @returns {Promise<Object>} The completed generation object
   */
  async _pollGeneration(generationId) {
    const startTime = Date.now();

    while (Date.now() - startTime < MAX_POLL_DURATION_MS) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

      const response = await axios.get(`${BASE_URL}/generations/${generationId}`, {
        headers: this._headers(),
        timeout: 15000
      });

      const generation = response.data?.generations_by_pk;
      if (!generation) {
        logger.warn(`Leonardo poll returned no data for generation ${generationId}`);
        continue;
      }

      const status = generation.status;

      if (status === 'COMPLETE') {
        return generation;
      }

      if (status === 'FAILED') {
        throw new Error(`Leonardo generation failed: ${generation.error || 'Unknown error'}`);
      }

      // NSFW content detected
      if (status === 'CONTENT_FILTERED') {
        throw new Error('Leonardo generation was blocked by content filter (NSFW detected)');
      }

      // Still processing
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      logger.info(`Leonardo generation ${generationId} status: ${status} (${elapsed}s elapsed)`);
    }

    throw new Error(`Leonardo generation timed out after ${MAX_POLL_DURATION_MS / 1000}s`);
  }

  /**
   * Check if the service is available (API key configured)
   */
  isAvailable() {
    return !!this.apiKey;
  }
}

// Singleton export (same pattern as VideoGenerationService)
const leonardoService = new LeonardoService();
export default leonardoService;
export { LeonardoService };
