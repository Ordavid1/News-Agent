// services/v4/SceneMasterModelFallback.js
//
// V4 Phase 5b — Fix 9 + N4 (Tier 3 of the 5-tier Scene Master content-policy chain).
//
// THE FAILURE MODE (Director Agent + Video MCP audit, 2026-04-29):
//   When Seedream's content filter (ByteDance) refuses a prompt and Tier 0
//   (regex sanitize) + Tier 1 (anchor-rewrite via Director finding) +
//   Tier 2 (Gemini-rewrite generic prompt) all fail to produce a valid panel,
//   the V4 pipeline previously had NO third-model option. The episode shipped
//   with a null Scene Master and structurally-unmoored beats. Story `77d6eaaf`
//   (logs.txt 2026-04-28) is the smoking gun.
//
// THE FIX (Director Agent + Video MCP routing — user-confirmed 2026-04-29):
//   Tier 3 is a different-model fallback. Each candidate has a DISTINCT
//   content-policy boundary — empirically, brand+lighting-extreme prompts
//   that 422 on Seedream often pass on Google's filter (Nano Banana Pro)
//   or BFL's filter (Flux 2 Max edit).
//
//   PRIMARY:   Nano Banana Pro (google/nano-banana-pro via Replicate) —
//              already integrated in MediaAssetService.js, reused here for
//              the Scene Master fallback path.
//   SECONDARY: Flux 2 Max edit (fal-ai/flux-2-max/edit) — already in V4
//              for portrait generation; reused here when Nano also refuses.
//
//   I/O contract matches Seedream's generatePanel: { imageUrl, imageBuffer,
//   prompt, model, sanitized, fallback_tier }. Caller (StoryboardHelpers)
//   treats the response identically — only `model` and `fallback_tier` differ.
//
// User approval (per /Users/ordavid/.claude/plans/i-want-to-consult-lovely-pebble.md
// 2026-04-29): Nano Banana Pro primary + Flux 2 Max edit secondary.

import axios from 'axios';
import Replicate from 'replicate';
import winston from 'winston';
import fluxFalService from '../FluxFalService.js';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) =>
      `[SceneMasterModelFallback] ${timestamp} [${level}]: ${message}`
    )
  ),
  transports: [new winston.transports.Console()]
});

const NANO_BANANA_MODEL = 'google/nano-banana-pro';

let _replicate = null;
function getReplicate() {
  if (_replicate) return _replicate;
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) return null;
  _replicate = new Replicate({ auth: token });
  return _replicate;
}

async function _downloadToBuffer(url) {
  const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
  return Buffer.from(resp.data);
}

// ─────────────────────────────────────────────────────────────────────
// Tier 3a — Nano Banana Pro
// ─────────────────────────────────────────────────────────────────────

/**
 * Generate a Scene Master panel via Nano Banana Pro (google/nano-banana-pro).
 * Reuses the same I/O contract as SeedreamFalService.generatePanel.
 *
 * Nano's `image_input` accepts an array of reference images; aspect_ratio
 * is matched to the input image when refs exist, or defaults to 9:16.
 */
async function _generateViaNanoBanana({ prompt, referenceImages = [], label = 'scene master' }) {
  const replicate = getReplicate();
  if (!replicate) throw new Error('Nano Banana Pro fallback unavailable: REPLICATE_API_TOKEN not configured');

  const input = {
    prompt,
    image_input: referenceImages.length > 0 ? referenceImages.slice(0, 5) : undefined,
    aspect_ratio: referenceImages.length > 0 ? 'match_input_image' : '9:16',
    output_format: 'png'
  };
  // Drop undefined keys (Replicate is strict on unknown fields).
  if (!input.image_input) delete input.image_input;

  logger.info(`${label}: Tier 3a — Nano Banana Pro (${referenceImages.length} ref(s))`);
  const output = await replicate.run(NANO_BANANA_MODEL, { input });

  // Replicate returns either an array of URLs or a stream; the established
  // pattern in MediaAssetService normalizes to a URL string.
  const imageSource = Array.isArray(output) ? output[0] : output;
  let imageBuffer;
  let imageUrl;
  if (typeof imageSource === 'string') {
    imageUrl = imageSource;
    imageBuffer = await _downloadToBuffer(imageUrl);
  } else if (imageSource && typeof imageSource.blob === 'function') {
    const blob = await imageSource.blob();
    imageBuffer = Buffer.from(await blob.arrayBuffer());
    imageUrl = '';
  } else {
    throw new Error('Nano Banana Pro returned unexpected output format');
  }

  return {
    imageUrl,
    imageBuffer,
    prompt,
    model: 'nano-banana-pro',
    sanitized: false,
    fallback_tier: 'tier3a_nano_banana_pro'
  };
}

// ─────────────────────────────────────────────────────────────────────
// Tier 3b — Flux 2 Max edit
// ─────────────────────────────────────────────────────────────────────

/**
 * Generate a Scene Master panel via Flux 2 Max edit. Already a V4 model
 * (used for character portraits) — reused here when Nano Banana also fails.
 */
async function _generateViaFluxEdit({ prompt, referenceImages = [], label = 'scene master' }) {
  if (!fluxFalService.isAvailable()) {
    throw new Error('Flux 2 Max edit fallback unavailable: FAL_GCS_API_KEY not configured');
  }

  logger.info(`${label}: Tier 3b — Flux 2 Max edit (${referenceImages.length} ref(s))`);
  // Flux 2 Max edit accepts up to 8 reference images (`image_urls`).
  const portrait = await fluxFalService.generatePortrait({
    prompt,
    referenceImages: referenceImages.slice(0, 8),
    options: { aspectRatio: '9:16' }
  });
  return {
    imageUrl: portrait.imageUrl,
    imageBuffer: portrait.imageBuffer,
    prompt,
    model: portrait.model,
    sanitized: false,
    fallback_tier: 'tier3b_flux_2_max_edit'
  };
}

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

/**
 * Try Nano Banana Pro first; on failure, fall back to Flux 2 Max edit.
 * Either of those failing means the prompt is universally rejected by
 * three independent content filters (ByteDance / Google / BFL) — at that
 * point the caller escalates to Tier 4 (user_review).
 *
 * @param {Object} params
 * @param {string} params.prompt
 * @param {string[]} [params.referenceImages]
 * @param {string} [params.label]
 * @returns {Promise<{ imageUrl, imageBuffer, prompt, model, sanitized, fallback_tier }>}
 */
export async function generatePanelViaFallbackChain({ prompt, referenceImages = [], label = 'scene master' } = {}) {
  if (!prompt) throw new Error('generatePanelViaFallbackChain: prompt is required');

  // Try Nano Banana Pro first (Google content filter — different from
  // ByteDance's). Empirically catches brand + lighting-extreme prompts that
  // Seedream refuses.
  try {
    return await _generateViaNanoBanana({ prompt, referenceImages, label });
  } catch (nanoErr) {
    logger.warn(`${label}: Tier 3a Nano Banana Pro failed (${nanoErr.message}) — falling through to Tier 3b Flux 2 Max edit`);
  }

  // Try Flux 2 Max edit second (BFL content filter).
  try {
    return await _generateViaFluxEdit({ prompt, referenceImages, label });
  } catch (fluxErr) {
    logger.error(`${label}: Tier 3b Flux 2 Max edit failed (${fluxErr.message}) — Tier 3 chain exhausted`);
    throw new Error(`Scene Master Tier 3 model fallback chain exhausted: Nano Banana Pro + Flux 2 Max edit both refused. Last error: ${fluxErr.message}`);
  }
}
