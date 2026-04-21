// services/v4/VertexGemini.js
// Shared Vertex AI Gemini helper for the V4 pipeline.
//
// V4 explicitly does NOT use the AI Studio (generativelanguage.googleapis.com)
// backend — every Gemini call in V4 goes through Vertex AI instead. Rationale:
//   - consistent with the existing Vertex Veo path in VideoGenerationService
//   - GCP service-account auth (no plaintext API key in env)
//   - higher quotas than AI Studio free/paid tier
//   - project-level audit + billing through GCP
//
// Auth model (mirrors VideoGenerationService Vertex backend):
//   - GCP_PROJECT_ID (required)
//   - GCP_LOCATION (optional, default 'us-central1')
//   - GOOGLE_APPLICATION_CREDENTIALS_JSON (inline service-account JSON) OR
//   - GOOGLE_APPLICATION_CREDENTIALS (file path) OR
//   - ADC (Application Default Credentials on GCP runtime)
//
// Model id is configurable via env var GEMINI_MODEL (default 'gemini-3-flash-preview').
// If Vertex requires a different model identifier than AI Studio for the same model,
// the user can set GEMINI_MODEL accordingly without touching any caller code.
//
// Every Vertex Gemini call in V4 flows through callVertexGeminiJson() below.

import axios from 'axios';
import { GoogleAuth } from 'google-auth-library';
import winston from 'winston';
import { parseGeminiJson } from './GeminiJsonRepair.js';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `[VertexGemini] ${timestamp} [${level}]: ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

const DEFAULT_MODEL = 'gemini-3-flash-preview';

// Default Vertex location for Gemini calls. Changed from 'us-central1' to
// 'global' on Day 0 (2026-04-11) after a 404 against gemini-3-flash-preview
// exposed the model's availability topology: per Google's own docs,
// gemini-3-flash-preview is ONLY available on global endpoints on Vertex AI.
// Regional endpoints (like us-central1-aiplatform.googleapis.com) return
// NOT_FOUND for it.
//
// This default is SEPARATE from GCP_LOCATION (which is used by the Veo Vertex
// path in VideoGenerationService.js and correctly wants 'us-central1' because
// Veo 3.1 Standard IS regionally available). V4 Gemini calls use their own
// location resolver so the two paths can diverge.
//
// Override: set VERTEX_GEMINI_LOCATION in .env to force a specific region
// (only useful if Google makes Gemini 3 Flash Preview regionally available
// in your project, OR if you want to pin to a different global-capable model).
const DEFAULT_GEMINI_LOCATION = 'global';

/**
 * Resolve the location to use for V4 Vertex Gemini calls.
 * Priority: VERTEX_GEMINI_LOCATION env var > 'global' default.
 * Explicitly does NOT read GCP_LOCATION because that var is for the Veo
 * Vertex path which has different regional requirements.
 */
function _resolveGeminiLocation() {
  return process.env.VERTEX_GEMINI_LOCATION || DEFAULT_GEMINI_LOCATION;
}

// Lazy-initialized GoogleAuth client (one per process)
let _authClient = null;
let _authInitError = null;

/**
 * Initialize the GoogleAuth client, using inline credentials JSON if available
 * or falling back to Application Default Credentials.
 */
function _initAuth() {
  if (_authClient) return _authClient;
  if (_authInitError) throw _authInitError;

  try {
    const credsRaw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (credsRaw) {
      const credentials = JSON.parse(credsRaw);
      _authClient = new GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/cloud-platform']
      });
      logger.info('Vertex Gemini auth: using inline GOOGLE_APPLICATION_CREDENTIALS_JSON');
    } else {
      // Application Default Credentials — picks up:
      //   - GOOGLE_APPLICATION_CREDENTIALS file path
      //   - GCP runtime metadata server
      //   - gcloud user credentials
      _authClient = new GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/cloud-platform']
      });
      const hint = process.env.GOOGLE_APPLICATION_CREDENTIALS
        ? `file: ${process.env.GOOGLE_APPLICATION_CREDENTIALS}`
        : 'ADC (runtime metadata / gcloud)';
      logger.info(`Vertex Gemini auth: using ${hint}`);
    }
    return _authClient;
  } catch (err) {
    _authInitError = new Error(`Vertex Gemini auth initialization failed: ${err.message}`);
    throw _authInitError;
  }
}

async function _getAccessToken() {
  const auth = _initAuth();
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Failed to obtain Vertex AI access token from service account credentials');
  return token;
}

function _resolveProjectLocation() {
  const projectId = process.env.GCP_PROJECT_ID;
  if (!projectId) {
    throw new Error('GCP_PROJECT_ID is not set — V4 Gemini calls require Vertex AI configuration');
  }
  // V4 Gemini uses its own location resolver (see comment on DEFAULT_GEMINI_LOCATION).
  const location = _resolveGeminiLocation();
  return { projectId, location };
}

/**
 * Build the Vertex AI generateContent endpoint URL for a given model.
 *
 * Two distinct URL shapes depending on location:
 *   - Regional (e.g. 'us-central1'):
 *       https://us-central1-aiplatform.googleapis.com/v1/projects/{proj}/locations/us-central1/...
 *   - Global:
 *       https://aiplatform.googleapis.com/v1/projects/{proj}/locations/global/...
 *
 * The global hostname drops the region prefix AND the URL path uses
 * 'locations/global' instead of a region name. Mixing them (e.g. sending
 * 'locations/global' to a regional hostname, or vice versa) returns 404
 * or cryptic errors.
 */
function _vertexEndpoint(modelId) {
  const { projectId, location } = _resolveProjectLocation();
  const host = location === 'global'
    ? 'aiplatform.googleapis.com'
    : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${projectId}/locations/${location}/publishers/google/models/${modelId}:generateContent`;
}

/**
 * Call Vertex AI Gemini with a system + user prompt and return parsed JSON.
 *
 * Vertex's Gemini generateContent endpoint uses the same request/response
 * shape as AI Studio's, so the body structure is identical. The difference
 * is the URL + auth header (bearer token instead of x-goog-api-key).
 *
 * @param {Object} params
 * @param {string} params.systemPrompt
 * @param {string} params.userPrompt
 * @param {Object} [params.config]
 * @param {number} [params.config.temperature=0.4]
 * @param {number} [params.config.maxOutputTokens=2000]
 * @param {string} [params.config.modelId]  - override the default model id
 * @param {number} [params.timeoutMs=60000]
 * @returns {Promise<Object>} parsed JSON from the model's first candidate
 */
export async function callVertexGeminiJson({ systemPrompt, userPrompt, config = {}, timeoutMs = 60000 } = {}) {
  if (!systemPrompt) throw new Error('callVertexGeminiJson: systemPrompt required');
  if (!userPrompt) throw new Error('callVertexGeminiJson: userPrompt required');

  const {
    temperature = 0.4,
    maxOutputTokens = 2000,
    modelId = process.env.GEMINI_MODEL || DEFAULT_MODEL
  } = config;

  const endpoint = _vertexEndpoint(modelId);
  const token = await _getAccessToken();

  const requestBody = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature,
      maxOutputTokens,
      responseMimeType: 'application/json'
    }
  };

  let response;
  try {
    response = await axios.post(endpoint, requestBody, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: timeoutMs
    });
  } catch (err) {
    if (err.response) {
      const errBody = typeof err.response.data === 'object'
        ? JSON.stringify(err.response.data).slice(0, 800)
        : String(err.response.data || '').slice(0, 800);
      logger.error(`Vertex Gemini ${modelId} error ${err.response.status}: ${errBody}`);
      throw new Error(`Vertex Gemini ${modelId} ${err.response.status}: ${errBody}`);
    }
    throw err;
  }

  const candidate = response.data?.candidates?.[0];
  const rawText = candidate?.content?.parts?.[0]?.text;
  const finishReason = candidate?.finishReason;

  if (!rawText) {
    logger.error(`Vertex Gemini returned no text: ${JSON.stringify(response.data).slice(0, 800)}`);
    throw new Error('Vertex Gemini returned no text');
  }

  // Gemini 3 Flash uses configurable reasoning ("thinking tokens") that
  // consume the output token budget BEFORE the visible response starts.
  // A too-tight maxOutputTokens silently truncates mid-string, which then
  // surfaces downstream as an opaque JSON.parse error. Detect MAX_TOKENS
  // here and throw a specific, actionable error so the caller knows to
  // bump maxOutputTokens instead of debugging phantom JSON bugs.
  if (finishReason === 'MAX_TOKENS') {
    logger.error(
      `Vertex Gemini ${modelId} hit MAX_TOKENS at ${maxOutputTokens} tokens — response truncated. ` +
      `Raw (first 200 chars): ${rawText.slice(0, 200)}`
    );
    throw new Error(
      `Vertex Gemini ${modelId} response truncated (finishReason=MAX_TOKENS, budget=${maxOutputTokens}). ` +
      `Gemini 3 Flash uses thinking tokens before output — raise maxOutputTokens to at least 4096 ` +
      `for short JSON responses and 8192+ for complex generations.`
    );
  }

  // Delegate to the shared repair chain — handles markdown fences, raw LF/CR/TAB
  // inside string values (the #1 Gemini 3 Flash defect on long text fields like
  // season_bible 500+ words), trailing commas, and trailing garbage. Same defect
  // contract as BrandStoryService._parseGeminiJson so every Gemini JSON call site
  // recovers identically.
  try {
    return parseGeminiJson(rawText);
  } catch (parseErr) {
    logger.error(
      `Vertex Gemini ${modelId} returned unparseable JSON (finishReason=${finishReason}). ` +
      `Raw (first 300 chars): ${rawText.slice(0, 300)}`
    );
    throw new Error(
      `Vertex Gemini ${modelId} returned unparseable JSON (finishReason=${finishReason}): ${parseErr.message}`
    );
  }
}

/**
 * Call Vertex AI Gemini and return the raw response text (for non-JSON callers,
 * like the existing Veo prompt-enrichment paths or subject analysis flows that
 * want the raw text before custom parsing).
 *
 * Exposed separately so callers with complex response handling don't pay the
 * cost of a JSON.parse that might reject valid non-JSON output.
 *
 * @param {Object} params
 * @param {string} params.systemPrompt
 * @param {string} params.userPrompt
 * @param {Object} [params.config]
 * @param {Object[]} [params.contents] - override contents (e.g. multimodal with image parts)
 * @returns {Promise<string>} raw response text
 */
export async function callVertexGeminiText({ systemPrompt, userPrompt, config = {}, contents, timeoutMs = 60000 } = {}) {
  const {
    temperature = 0.4,
    maxOutputTokens = 2000,
    modelId = process.env.GEMINI_MODEL || DEFAULT_MODEL,
    responseMimeType
  } = config;

  const endpoint = _vertexEndpoint(modelId);
  const token = await _getAccessToken();

  const requestBody = {
    generationConfig: { temperature, maxOutputTokens }
  };
  if (responseMimeType) requestBody.generationConfig.responseMimeType = responseMimeType;
  if (systemPrompt) requestBody.systemInstruction = { parts: [{ text: systemPrompt }] };

  requestBody.contents = Array.isArray(contents) && contents.length > 0
    ? contents
    : [{ role: 'user', parts: [{ text: userPrompt || '' }] }];

  let response;
  try {
    response = await axios.post(endpoint, requestBody, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: timeoutMs
    });
  } catch (err) {
    if (err.response) {
      const errBody = typeof err.response.data === 'object'
        ? JSON.stringify(err.response.data).slice(0, 800)
        : String(err.response.data || '').slice(0, 800);
      logger.error(`Vertex Gemini ${modelId} error ${err.response.status}: ${errBody}`);
      throw new Error(`Vertex Gemini ${modelId} ${err.response.status}: ${errBody}`);
    }
    throw err;
  }

  const candidate = response.data?.candidates?.[0];
  const rawText = candidate?.content?.parts?.[0]?.text;
  const finishReason = candidate?.finishReason;

  if (!rawText) throw new Error('Vertex Gemini returned no text');

  // Same MAX_TOKENS safety rail as callVertexGeminiJson — truncation is a
  // silent killer on Gemini 3 Flash Preview due to thinking-token overhead.
  if (finishReason === 'MAX_TOKENS') {
    logger.error(
      `Vertex Gemini ${modelId} hit MAX_TOKENS at ${maxOutputTokens} tokens (text caller) — ` +
      `response truncated. Raw (first 200 chars): ${rawText.slice(0, 200)}`
    );
    throw new Error(
      `Vertex Gemini ${modelId} response truncated (finishReason=MAX_TOKENS, budget=${maxOutputTokens}). ` +
      `Raise maxOutputTokens — Gemini 3 Flash thinking tokens consume budget before visible output.`
    );
  }

  return rawText;
}

/**
 * Call Vertex Gemini and return the RAW response data object.
 * Used by callers that need to inspect `finishReason`, safety ratings,
 * usage metadata, or other fields outside the first candidate's text
 * (e.g. the storyline generator that detects MAX_TOKENS truncation).
 *
 * @param {Object} params
 * @param {string} [params.systemPrompt]
 * @param {string} [params.userPrompt]
 * @param {Object[]} [params.contents] - override contents (multimodal with image parts, etc.)
 * @param {Object} [params.config]
 * @param {number} [params.timeoutMs=120000]
 * @returns {Promise<Object>} the raw Vertex response data
 */
export async function callVertexGeminiRaw({ systemPrompt, userPrompt, contents, config = {}, timeoutMs = 120000 } = {}) {
  const {
    temperature = 0.4,
    maxOutputTokens = 8000,
    modelId = process.env.GEMINI_MODEL || DEFAULT_MODEL,
    responseMimeType
  } = config;

  const endpoint = _vertexEndpoint(modelId);
  const token = await _getAccessToken();

  const requestBody = {
    generationConfig: { temperature, maxOutputTokens }
  };
  if (responseMimeType) requestBody.generationConfig.responseMimeType = responseMimeType;
  if (systemPrompt) requestBody.systemInstruction = { parts: [{ text: systemPrompt }] };

  requestBody.contents = Array.isArray(contents) && contents.length > 0
    ? contents
    : [{ role: 'user', parts: [{ text: userPrompt || '' }] }];

  let response;
  try {
    response = await axios.post(endpoint, requestBody, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: timeoutMs
    });
  } catch (err) {
    if (err.response) {
      const errBody = typeof err.response.data === 'object'
        ? JSON.stringify(err.response.data).slice(0, 800)
        : String(err.response.data || '').slice(0, 800);
      logger.error(`Vertex Gemini ${modelId} error ${err.response.status}: ${errBody}`);
      throw new Error(`Vertex Gemini ${modelId} ${err.response.status}: ${errBody}`);
    }
    throw err;
  }

  return response.data;
}

/**
 * Probe whether Vertex Gemini is available (for startup health checks).
 * Doesn't make an API call — just verifies env vars are set and auth init
 * succeeds. Caches the result.
 */
export function isVertexGeminiConfigured() {
  try {
    _resolveProjectLocation();
    _initAuth();
    return true;
  } catch {
    return false;
  }
}
