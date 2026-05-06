// services/RunwayAlephService.js
// Direct Runway API wrapper for the gen4_aleph video-to-video stylization model.
//
// V4 use case (Aleph Rec 2): opt-in commercial-only post-completion enhancement.
// Triggered by user click in Director Panel after a commercial episode finishes.
// AlephEnhancementOrchestrator chunks the post-LUT intermediate (graded video,
// no music/cards/subs yet), calls this service per chunk with shared style
// prompt + reference image for cross-chunk consistency, and re-runs the
// Director Agent identity_lock rubric as a hard gate post-stylization.
//
// Why direct Runway (not fal.ai):
//   Aleph is NOT in fal.ai's catalog (verified 2026-05-05 against
//   fal.ai/models). Runway hosts it directly at api.dev.runwayml.com. New
//   auth surface (RUNWAYML_API_SECRET) added to .env specifically for this
//   integration. Other fal.ai vendors continue to use FAL_GCS_API_KEY.
//
// Endpoint: POST https://api.dev.runwayml.com/v1/video_to_video
// Auth:     Authorization: Bearer ${RUNWAYML_API_SECRET}
//           X-Runway-Version: 2024-11-06
// Cost:     15 credits/sec output → ~$0.15/sec at $0.01/credit
// Pricing:  60s commercial (chunked into ~6 × 10s calls) ≈ $9
// Cap:      10s output per call (chunked architecture required for >10s inputs)
// Pattern:  Async — POST returns { id }; GET /v1/tasks/{id} until SUCCEEDED;
//           output[] contains signed URLs (24-48h expiry — must download + persist)
//
// Failure signatures (see runway-aleph.yaml dossier):
//   - aleph_face_drift_at_strength (severity 4): cap strength ≤ 0.20
//   - aleph_text_glyph_warp (severity 3): apply subs/cards AFTER Aleph
//   - aleph_chunk_boundary_pop (severity 2): use shared prompt + ref across chunks
//   - aleph_audio_passthrough_only (severity 1): by design, not a defect
//   - aleph_strength_color_overshoot (severity 3): NEVER Aleph before LUT
//
// Director Agent integration:
//   The model_signature_check rubric reads runway-aleph.yaml dossier when
//   a beat's routingMetadata.modelUsed contains 'runway-aleph' or
//   'gen4_aleph'. The post-stylization identity_lock judge expects the
//   dossier's failure signatures to surface in evidence when defects
//   appear.

import axios from 'axios';
import winston from 'winston';

const RUNWAY_API_BASE = 'https://api.dev.runwayml.com';
const RUNWAY_API_VERSION = '2024-11-06';
const ALEPH_MODEL_ID = 'gen4_aleph';
const VIDEO_TO_VIDEO_PATH = '/v1/video_to_video';
const TASKS_PATH = '/v1/tasks';

// Aleph hard limits (verified against Runway API reference 2026-05-05).
const ALEPH_MIN_DURATION = 2;
const ALEPH_MAX_DURATION = 10;
const ALEPH_DEFAULT_STRENGTH = 0.20;       // Director Agent A2.1 ceiling
const ALEPH_MAX_STRENGTH = 0.30;           // Hard ceiling — beyond this, identity_lock collapses
const ALEPH_DEFAULT_RATIO = '720:1280';    // V4 9:16 vertical

const POLL_INTERVAL_MS = 5000;             // Runway recommends 5s
const MAX_POLL_DURATION_MS = 900000;       // 15 min ceiling per chunk
const SUBMIT_TIMEOUT_MS = 30000;
const DOWNLOAD_TIMEOUT_MS = 120000;        // Output URLs are signed S3-style; allow 2 min for large videos

class RunwayAlephService {
  constructor() {
    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => `[RunwayAleph] ${timestamp} [${level}]: ${message}`)
      ),
      transports: [new winston.transports.Console()]
    });
  }

  isAvailable() {
    return Boolean(process.env.RUNWAYML_API_SECRET);
  }

  _headers() {
    if (!this.isAvailable()) {
      throw new Error('RUNWAYML_API_SECRET is not configured — Aleph enhancement requires direct Runway API auth');
    }
    return {
      'Authorization': `Bearer ${process.env.RUNWAYML_API_SECRET}`,
      'X-Runway-Version': RUNWAY_API_VERSION,
      'Content-Type': 'application/json'
    };
  }

  /**
   * Apply Aleph stylization to a single chunk (≤ 10s).
   *
   * Async flow:
   *   1. POST /v1/video_to_video → returns { id: "task_xxx" }
   *   2. Poll GET /v1/tasks/{id} until status = SUCCEEDED | FAILED
   *   3. On SUCCEEDED, output[] contains signed URLs
   *   4. Download the first output URL into a Buffer (URLs expire 24-48h)
   *
   * @param {Object} params
   * @param {string} params.videoUrl              - public URL of the source clip (must be HTTPS, ≤ 32MB)
   * @param {string} params.prompt                - style prompt — what to STYLIZE TOWARD (not what's in the source)
   * @param {string} [params.referenceImageUrl]   - optional style anchor image (preferred over text-only for consistency)
   * @param {Object} [params.options]
   * @param {number} [params.options.strength=0.20] - 0-1; Director Agent ceiling 0.20 (LUT already moved color)
   * @param {string} [params.options.ratio='720:1280'] - aspect ratio (V4 default 9:16 vertical)
   * @param {string} [params.options.seed]        - integer seed for deterministic re-runs
   * @returns {Promise<{ videoBuffer: Buffer, taskId: string, costUsd: number, durationSec: number, model: string }>}
   */
  async applyStylization({ videoUrl, prompt, referenceImageUrl = null, options = {} }) {
    if (!videoUrl) throw new Error('RunwayAlephService.applyStylization: videoUrl required');
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new Error('RunwayAlephService.applyStylization: prompt required (style prompt)');
    }

    const strength = Math.max(0, Math.min(ALEPH_MAX_STRENGTH, options.strength ?? ALEPH_DEFAULT_STRENGTH));
    if (strength !== options.strength && options.strength != null) {
      this.logger.warn(`strength ${options.strength} clamped to ${strength} (Aleph hard ceiling ${ALEPH_MAX_STRENGTH}; recommended ≤ 0.20 per Director A2.1)`);
    }

    const ratio = options.ratio || ALEPH_DEFAULT_RATIO;
    const seed = typeof options.seed === 'number' ? options.seed : undefined;

    // Per Runway API reference: video_to_video accepts model + videoUri + promptText + ratio.
    // Optional: promptImage (style reference), seed.
    const body = {
      model: ALEPH_MODEL_ID,
      videoUri: videoUrl,
      promptText: prompt,
      ratio,
      // Strength is documented in Runway's pricing/usage docs as a parameter
      // but the field name on the API is `strength` per the API reference.
      // If Runway's schema rejects this field, the API returns 400 with
      // INPUT.VALIDATION — caller handles that as a non-retryable error.
      strength
    };
    if (referenceImageUrl) body.promptImage = referenceImageUrl;
    if (seed !== undefined) body.seed = seed;

    this.logger.info(`POST ${VIDEO_TO_VIDEO_PATH} — model=${ALEPH_MODEL_ID}, ratio=${ratio}, strength=${strength}, ref=${referenceImageUrl ? 'image+text' : 'text-only'}`);
    const startTime = Date.now();

    let submitResp;
    try {
      submitResp = await axios.post(`${RUNWAY_API_BASE}${VIDEO_TO_VIDEO_PATH}`, body, {
        headers: this._headers(),
        timeout: SUBMIT_TIMEOUT_MS,
        validateStatus: () => true
      });
    } catch (err) {
      this.logger.error(`Runway submit failed: ${err.message}`);
      throw err;
    }

    if (submitResp.status >= 400) {
      const errorBody = typeof submitResp.data === 'string' ? submitResp.data : JSON.stringify(submitResp.data);
      this.logger.error(`Runway submit ${submitResp.status}: ${errorBody.slice(0, 400)}`);
      throw new Error(`Runway video_to_video submit failed (${submitResp.status}): ${errorBody.slice(0, 200)}`);
    }

    const taskId = submitResp.data?.id;
    if (!taskId) {
      this.logger.error(`Runway submit succeeded but no task id: ${JSON.stringify(submitResp.data).slice(0, 200)}`);
      throw new Error('Runway video_to_video did not return a task id');
    }

    this.logger.info(`task ${taskId} submitted — polling`);

    const task = await this._pollTask(taskId);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    const outputUrl = Array.isArray(task.output) ? task.output[0] : null;
    if (!outputUrl) {
      this.logger.error(`task ${taskId} SUCCEEDED but no output URL: ${JSON.stringify(task).slice(0, 300)}`);
      throw new Error(`Runway task ${taskId} returned no output URL`);
    }

    this.logger.info(`task ${taskId} SUCCEEDED in ${elapsed}s — downloading output`);

    const videoBuffer = await this._downloadVideo(outputUrl);
    const sizeMb = (videoBuffer.length / 1024 / 1024).toFixed(1);
    this.logger.info(`output downloaded — ${sizeMb}MB`);

    // Estimate output duration from task.output if available; otherwise fall
    // back to a sensible default based on cost calculation. Runway's task
    // response sometimes includes duration in the output object.
    const outputDurationSec = task.outputDurationSec
      || (typeof task.output?.[0]?.duration === 'number' ? task.output[0].duration : null)
      || ALEPH_MAX_DURATION; // worst-case for cost estimation

    const costUsd = outputDurationSec * 0.15; // 15 credits/sec × $0.01/credit

    return {
      videoBuffer,
      taskId,
      costUsd,
      durationSec: outputDurationSec,
      model: 'runway-aleph/gen4_aleph'
    };
  }

  /**
   * Poll a Runway task until SUCCEEDED, FAILED, or CANCELLED.
   *
   * @param {string} taskId
   * @returns {Promise<Object>} the final task object
   */
  async _pollTask(taskId) {
    const startTime = Date.now();
    let attempt = 0;
    while (true) {
      attempt++;
      const elapsed = Date.now() - startTime;
      if (elapsed > MAX_POLL_DURATION_MS) {
        throw new Error(`Runway task ${taskId} timed out after ${(elapsed / 1000).toFixed(0)}s`);
      }

      let resp;
      try {
        resp = await axios.get(`${RUNWAY_API_BASE}${TASKS_PATH}/${taskId}`, {
          headers: this._headers(),
          timeout: SUBMIT_TIMEOUT_MS,
          validateStatus: () => true
        });
      } catch (err) {
        // Transient network errors — retry after a short wait.
        this.logger.warn(`poll ${taskId} (attempt ${attempt}) network error: ${err.message} — retrying`);
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        continue;
      }

      if (resp.status >= 400) {
        const errorBody = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
        // 5xx and 429 are retryable per Runway's error guide.
        if (resp.status === 429 || resp.status >= 500) {
          this.logger.warn(`poll ${taskId} ${resp.status} (transient) — retrying`);
          await new Promise(r => setTimeout(r, POLL_INTERVAL_MS * 2));
          continue;
        }
        throw new Error(`Runway task ${taskId} poll failed (${resp.status}): ${errorBody.slice(0, 200)}`);
      }

      const task = resp.data;
      const status = task?.status;

      if (status === 'SUCCEEDED') {
        return task;
      }
      if (status === 'FAILED') {
        const failure = task.failure || task.failureCode || 'unknown';
        // SAFETY.INPUT.* is non-retryable per the docs; SAFETY.OUTPUT.* and
        // INTERNAL are retryable but at the orchestrator level, not here.
        throw new Error(`Runway task ${taskId} FAILED: ${failure}`);
      }
      if (status === 'CANCELLED') {
        throw new Error(`Runway task ${taskId} CANCELLED`);
      }

      // PENDING | RUNNING | THROTTLED — continue polling.
      if (attempt % 6 === 0) {
        this.logger.info(`task ${taskId} still ${status} (${(elapsed / 1000).toFixed(0)}s elapsed)`);
      }
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  /**
   * Download the signed output URL into a Buffer. Output URLs expire in
   * 24-48h per Runway docs; the orchestrator should re-upload to its own
   * storage immediately.
   */
  async _downloadVideo(url) {
    const resp = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: DOWNLOAD_TIMEOUT_MS,
      validateStatus: () => true
    });
    if (resp.status >= 400) {
      throw new Error(`Aleph output download failed ${resp.status} from ${url.slice(0, 60)}...`);
    }
    return Buffer.from(resp.data);
  }
}

const runwayAlephService = new RunwayAlephService();
export default runwayAlephService;
export {
  RunwayAlephService,
  ALEPH_MIN_DURATION,
  ALEPH_MAX_DURATION,
  ALEPH_DEFAULT_STRENGTH,
  ALEPH_MAX_STRENGTH,
  ALEPH_DEFAULT_RATIO
};
