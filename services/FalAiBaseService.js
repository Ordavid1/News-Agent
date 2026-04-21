// services/FalAiBaseService.js
// Shared base class for all fal.ai model wrappers in the V4 Brand Story pipeline.
//
// Encapsulates the submit → poll → download queue pattern that was previously
// duplicated in OmniHumanService.js. Subclasses override buildPayload() and
// extractOutput() to customize per-model request/response handling.
//
// All V4 generation endpoints flow through this base:
//   - KlingFalService (O3 Omni Standard + V3 Pro)
//   - VeoFalService (Veo 3.1 first-last-frame-to-video)
//   - SyncLipsyncFalService (Sync Lipsync v3 — Mode B corrective pass)
//   - SeedreamFalService (Scene Master panels)
//   - FluxFalService (character sheet portraits)
//   - OmniHumanService (Mode A fallback talking-head, refactored)
//
// Auth: Bearer `Key ${FAL_GCS_API_KEY}` (fal.ai scheme, billing routed through GCP Marketplace)
// Endpoint: https://queue.fal.run/{modelSlug}

import axios from 'axios';
import winston from 'winston';

const FAL_QUEUE_BASE = 'https://queue.fal.run';

// Default polling knobs — subclasses can override via constructor options.
const DEFAULT_POLL_INTERVAL_MS = 8000;     // 8s between status checks
const DEFAULT_MAX_POLL_DURATION_MS = 600000; // 10 min overall wait

class FalAiBaseService {
  /**
   * @param {Object} opts
   * @param {string} opts.modelSlug       - fal.ai model path, e.g. 'fal-ai/kling-video/o3/standard/image-to-video'
   * @param {string} opts.displayName     - human-readable name for logs, e.g. 'KlingOmniStandard'
   * @param {number} [opts.pollIntervalMs]       - override default polling interval
   * @param {number} [opts.maxPollDurationMs]    - override default max wait
   * @param {number} [opts.submitTimeoutMs=30000] - HTTP submit timeout
   */
  constructor({ modelSlug, displayName, pollIntervalMs, maxPollDurationMs, submitTimeoutMs } = {}) {
    if (!modelSlug) throw new Error('FalAiBaseService: modelSlug is required');
    if (!displayName) throw new Error('FalAiBaseService: displayName is required');

    // V4 uses FAL_GCS_API_KEY (fal.ai billing routed through GCP Marketplace).
    // Fallback to legacy FAL_API_KEY so pre-V4 services keep working during migration.
    this.apiKey = process.env.FAL_GCS_API_KEY || process.env.FAL_API_KEY;
    this.modelSlug = modelSlug;
    this.displayName = displayName;
    this.pollIntervalMs = pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
    this.maxPollDurationMs = maxPollDurationMs || DEFAULT_MAX_POLL_DURATION_MS;
    this.submitTimeoutMs = submitTimeoutMs || 30000;

    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => {
          return `[${this.displayName}] ${timestamp} [${level}]: ${message}`;
        })
      ),
      transports: [new winston.transports.Console()]
    });

    if (!this.apiKey) {
      this.logger.warn(`FAL_GCS_API_KEY not set — ${this.displayName} will not be available`);
    } else {
      this.logger.info(`initialized — model: ${this.modelSlug}`);
    }
  }

  /**
   * @returns {boolean} true if fal.ai credentials are configured
   */
  isAvailable() {
    return !!this.apiKey;
  }

  /**
   * fal.ai authenticated headers.
   * fal.ai uses `Key ${token}` scheme (not `Bearer`).
   */
  _headers() {
    return {
      'Authorization': `Key ${this.apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
  }

  /**
   * Submit a job to the fal.ai queue and return the tracking handles.
   *
   * @param {Object} inputPayload - model-specific request body (no { input: {} } wrapper)
   * @returns {Promise<{requestId: string, statusUrl: string, resultUrl: string}>}
   */
  async submitJob(inputPayload) {
    if (!this.apiKey) throw new Error(`${this.displayName}: FAL_GCS_API_KEY is not configured`);

    let submitResponse;
    try {
      submitResponse = await axios.post(
        `${FAL_QUEUE_BASE}/${this.modelSlug}`,
        inputPayload,
        {
          headers: this._headers(),
          timeout: this.submitTimeoutMs
        }
      );
    } catch (err) {
      if (err.response) {
        const errBody = typeof err.response.data === 'object'
          ? JSON.stringify(err.response.data)
          : String(err.response.data || '').slice(0, 1000);
        this.logger.error(`submit ${err.response.status}: ${errBody}`);
        throw new Error(`${this.displayName} submit ${err.response.status}: ${errBody}`);
      }
      throw err;
    }

    const submitData = submitResponse.data || {};
    const requestId = submitData.request_id;
    const statusUrl = submitData.status_url;
    const resultUrl = submitData.response_url;

    if (!requestId || !statusUrl || !resultUrl) {
      this.logger.error(`submit response missing fields: ${JSON.stringify(submitData)}`);
      throw new Error(`${this.displayName}: fal.ai did not return request_id/status_url/response_url`);
    }

    this.logger.info(`job submitted — request_id: ${requestId}`);
    return { requestId, statusUrl, resultUrl };
  }

  /**
   * Poll a submitted job until it completes (or fails/times out).
   *
   * @param {string} requestId
   * @param {string} statusUrl
   * @param {string} resultUrl
   * @returns {Promise<Object>} the raw result.data from fal.ai on success
   */
  async pollJob(requestId, statusUrl, resultUrl) {
    const startTime = Date.now();

    while (Date.now() - startTime < this.maxPollDurationMs) {
      await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));

      let statusResp;
      try {
        statusResp = await axios.get(statusUrl, {
          headers: this._headers(),
          timeout: 15000
        });
      } catch (err) {
        // 404 can occur briefly while a job is still queueing on fal.ai's side.
        if (err.response?.status === 404) {
          this.logger.warn(`status 404 (request may still be queueing)`);
          continue;
        }
        if (err.response) {
          const errBody = typeof err.response.data === 'object'
            ? JSON.stringify(err.response.data)
            : String(err.response.data || '').slice(0, 1000);
          this.logger.error(`poll error ${err.response.status}: ${errBody}`);
          throw new Error(`${this.displayName} poll ${err.response.status}: ${errBody}`);
        }
        throw err;
      }

      const status = statusResp.data?.status;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

      if (status === 'COMPLETED') {
        // The result fetch can itself fail in two ways:
        //   - 4xx (422): model rejected the inputs after accepting the job
        //     (image URL fetch failed, audio too long, etc.) → throw immediately.
        //   - 5xx (502/504): fal.ai downstream service hiccup → retry with
        //     exponential backoff. Caught on 2026-04-11 when Sync Lipsync v3
        //     returned 504 "Downstream service unavailable" after 305s of
        //     polling — a transient cloud-side timeout, NOT a permanent failure.
        const MAX_RESULT_RETRIES = 3;
        for (let retryAttempt = 0; retryAttempt <= MAX_RESULT_RETRIES; retryAttempt++) {
          try {
            const resultResp = await axios.get(resultUrl, {
              headers: this._headers(),
              timeout: 30000 // 30s — a bit generous since results can be large
            });
            return resultResp.data;
          } catch (resultErr) {
            if (resultErr.response) {
              const status5xx = resultErr.response.status >= 500;
              const errBody = typeof resultErr.response.data === 'object'
                ? JSON.stringify(resultErr.response.data)
                : String(resultErr.response.data || '').slice(0, 1000);

              // 5xx errors: retry with backoff
              if (status5xx && retryAttempt < MAX_RESULT_RETRIES) {
                const backoffSec = (retryAttempt + 1) * 5;
                this.logger.warn(
                  `result fetch ${resultErr.response.status} (attempt ${retryAttempt + 1}/${MAX_RESULT_RETRIES + 1}) — ` +
                  `retrying in ${backoffSec}s: ${errBody.slice(0, 200)}`
                );
                await new Promise(resolve => setTimeout(resolve, backoffSec * 1000));
                continue;
              }

              // 4xx or final 5xx failure: throw with the real error body
              this.logger.error(`result fetch ${resultErr.response.status}: ${errBody}`);
              throw new Error(`${this.displayName} result fetch ${resultErr.response.status}: ${errBody}`);
            }
            throw resultErr;
          }
        }
      }

      if (status === 'FAILED' || status === 'ERROR') {
        const errorDetail = statusResp.data?.error || JSON.stringify(statusResp.data);
        throw new Error(`${this.displayName} generation failed: ${errorDetail}`);
      }

      this.logger.info(`job ${requestId} status: ${status} (${elapsed}s elapsed)`);
    }

    throw new Error(`${this.displayName} generation timed out after ${this.maxPollDurationMs / 1000}s`);
  }

  /**
   * Download a URL into a Buffer (used for fetching generated media from fal.ai CDN).
   *
   * @param {string} url
   * @param {string} [mediaType='media'] - for logging only, e.g. 'video', 'image', 'audio'
   * @returns {Promise<Buffer>}
   */
  async downloadToBuffer(url, mediaType = 'media') {
    this.logger.info(`downloading ${mediaType} from fal.ai: ${url.slice(0, 80)}...`);
    const resp = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 180000, // 3 min for large video downloads
      headers: { 'User-Agent': 'NewsAgentSaaS/1.0' }
    });
    const buffer = Buffer.from(resp.data);
    const sizeMB = (buffer.length / (1024 * 1024)).toFixed(1);
    this.logger.info(`${mediaType} downloaded — ${sizeMB}MB`);
    return buffer;
  }

  /**
   * High-level one-shot: submit → poll → return raw result.
   * Subclasses typically wrap this with their own semantic method (e.g. generateVideo).
   *
   * @param {Object} inputPayload
   * @returns {Promise<Object>} raw fal.ai result.data
   */
  async run(inputPayload) {
    const startTime = Date.now();
    const { requestId, statusUrl, resultUrl } = await this.submitJob(inputPayload);
    const result = await this.pollJob(requestId, statusUrl, resultUrl);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    this.logger.info(`job completed in ${elapsed}s`);
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Hooks for subclasses — these are optional, most subclasses just call
  // submitJob/pollJob directly in their own semantic methods. Provided for
  // consistency when a model fits the simple `build → submit → extract` flow.
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Build the fal.ai request body from semantic arguments.
   * Subclasses MUST override this if they use the `runWithExtract` helper.
   *
   * @param {Object} args - semantic per-call arguments
   * @returns {Object} fal.ai request body
   */
  buildPayload(args) {
    throw new Error(`${this.displayName}: buildPayload() must be implemented by subclass`);
  }

  /**
   * Extract the semantic output from fal.ai's raw result.
   * Subclasses MUST override this if they use the `runWithExtract` helper.
   *
   * @param {Object} rawResult - the raw fal.ai result.data object
   * @returns {Object} the semantic output (model-specific shape)
   */
  extractOutput(rawResult) {
    throw new Error(`${this.displayName}: extractOutput() must be implemented by subclass`);
  }

  /**
   * Optional high-level helper for subclasses that fit the simple pattern:
   * buildPayload(args) → submit → poll → extractOutput(result).
   *
   * @param {Object} args
   * @returns {Promise<Object>}
   */
  async runWithExtract(args) {
    const payload = this.buildPayload(args);
    const raw = await this.run(payload);
    return this.extractOutput(raw);
  }
}

export default FalAiBaseService;
export { FalAiBaseService, FAL_QUEUE_BASE };
