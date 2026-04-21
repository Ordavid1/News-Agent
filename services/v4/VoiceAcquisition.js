// services/v4/VoiceAcquisition.js
// V4 persona voice acquisition — Gemini-driven ElevenLabs preset matching.
//
// The flow (Decision 3 from sunny-wishing-teacup.md):
//   1. Gemini reads the persona's name, personality, role, appearance
//   2. Gemini writes a 1-sentence voice brief ("warm baritone, slight rasp,
//      mid-30s American, deliberate pacing")
//   3. Gemini picks the closest voice from the curated ElevenLabs preset
//      library in services/voice-library/elevenlabs-presets.json
//   4. We assign the persona.elevenlabs_voice_id and persona.elevenlabs_voice_brief
//
// User override (fallback b) comes from the Director's Panel — the user
// can open the persona card and pick from the full library manually.
//
// Kling voice cloning (Phase 1b) is OPT-IN via `cloneKlingVoice: true` on
// acquirePersonaVoicesForStory. This calls fal-ai/kling-video/create-voice
// to clone the ElevenLabs preset's preview audio into a kling_voice_id.
// IMPORTANT caveat: kling_voice_ids only work on V2.6 Pro endpoints, which
// V4 Mode B does NOT use — V4 relies on Sync Lipsync v3 for voice matching.
// We ship createVoice integration for:
//   (a) A/B comparison runs with a V2.6 Pro voice-bound Mode C pathway
//   (b) Future V4.1 / V5 when Kling adds voice_ids to V3 endpoints
// Default for normal generation: skip the Kling clone (saves an API call).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import winston from 'winston';

import { callVertexGeminiJson } from './VertexGemini.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `[VoiceAcquisition] ${timestamp} [${level}]: ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

// Load the library once at module load
let VOICE_LIBRARY = null;
function loadVoiceLibrary() {
  if (VOICE_LIBRARY) return VOICE_LIBRARY;
  const libraryPath = path.join(__dirname, '..', 'voice-library', 'elevenlabs-presets.json');
  try {
    const raw = fs.readFileSync(libraryPath, 'utf-8');
    const parsed = JSON.parse(raw);
    VOICE_LIBRARY = parsed.voices || [];
    logger.info(`loaded ${VOICE_LIBRARY.length} ElevenLabs preset voices`);
    return VOICE_LIBRARY;
  } catch (err) {
    logger.error(`failed to load voice library: ${err.message}`);
    VOICE_LIBRARY = [];
    return VOICE_LIBRARY;
  }
}

// All Gemini calls route through services/v4/VertexGemini.js (Vertex AI, not
// AI Studio). Kept local wrapper so call-sites stay concise.
//
// Token budget note: Gemini 3 Flash Preview uses configurable reasoning
// ("thinking tokens") that consume output token budget BEFORE the visible
// response starts. The earlier 800-token budget was too tight and caused
// MAX_TOKENS truncation on Day 0 (2026-04-11) — Vertex returned mid-string
// JSON that couldn't parse. Bumped to 4096 to give Gemini 3 Flash room to
// think AND emit the short (~200 char) JSON response. Real V4 callers with
// larger outputs should use 8192+.

async function callGeminiJson(systemPrompt, userPrompt) {
  return callVertexGeminiJson({
    systemPrompt,
    userPrompt,
    config: {
      temperature: 0.4,
      maxOutputTokens: 4096
    },
    timeoutMs: 60000
  });
}

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

/**
 * Pick an ElevenLabs preset voice for a persona based on personality and role.
 *
 * @param {Object} persona - from persona_config.personas[]
 *   (uses: name, personality, description, appearance, visual_description, role)
 * @returns {Promise<{voiceId: string, voiceBrief: string, voiceName: string, justification: string}>}
 */
export async function acquirePersonaVoice(persona) {
  if (!persona) throw new Error('acquirePersonaVoice: persona required');

  const library = loadVoiceLibrary();
  if (library.length === 0) {
    throw new Error('acquirePersonaVoice: voice library is empty');
  }

  // Compact library view for Gemini's prompt (name + tags + descriptor)
  const libraryForPrompt = library.map(v =>
    `  - ${v.voice_id} | ${v.name} (${v.gender}, ${v.age}, ${v.accent}): ${v.descriptor}. Best for: ${(v.best_for || []).join(', ')}.`
  ).join('\n');

  const personaDescription = [
    persona.name && `Name: ${persona.name}`,
    persona.personality && `Personality: ${persona.personality}`,
    persona.role && `Role: ${persona.role}`,
    persona.description && `Description: ${persona.description}`,
    (persona.appearance || persona.visual_description) && `Appearance: ${persona.appearance || persona.visual_description}`
  ].filter(Boolean).join('\n');

  const systemPrompt = `You are a voice-casting director picking the right ElevenLabs voice for a character in a branded short film.

You have a curated library of ElevenLabs premade voices (below). Given a persona description, you will:
  1. Write a 1-sentence voice brief describing the IDEAL voice for this character (pitch, timbre, pace, accent, age, gender, emotional tone). Example: "warm baritone, slight rasp, mid-30s American, deliberate pacing, trustworthy but guarded"
  2. Pick the ONE voice_id from the library that best matches your brief
  3. Write a 1-sentence justification explaining why this voice fits

Respond with ONLY this JSON shape:
{
  "voice_brief": "1-sentence description of the ideal voice",
  "voice_id": "the exact voice_id string from the library",
  "voice_name": "the Name field from the library entry",
  "justification": "1-sentence reason why this preset matches the persona"
}

AVAILABLE VOICES:
${libraryForPrompt}`;

  const userPrompt = `Cast the voice for this persona:

${personaDescription}`;

  logger.info(`acquiring voice for persona "${persona.name || 'unnamed'}"`);

  // V4 policy (Phase 5 review, Day 0 2026-04-11): voice acquisition MUST
  // hard-fail on Gemini errors. The previous fallback-to-Brian behavior was
  // a silent gender-mismatch bug waiting to happen — a female persona would
  // ship with male narration, and the only signal was a warning buried in
  // the logs. The smoke test caught exactly this pattern on 2026-04-10.
  //
  // Caller contract: if this throws, the orchestrator should abort the
  // entire pipeline (not continue with a fallback voice). The cost of a
  // loud failure is one failed episode; the cost of a silent fallback is
  // every female persona shipping in a male voice until a human spots it.
  let result;
  try {
    result = await callGeminiJson(systemPrompt, userPrompt);
  } catch (err) {
    logger.error(`Gemini voice casting HARD-FAILED for persona "${persona.name || 'unnamed'}": ${err.message}`);
    throw new Error(
      `Voice acquisition failed for persona "${persona.name || 'unnamed'}": ${err.message}. ` +
      `Fix the underlying Gemini error (model config, token budget, prompt) before retrying — ` +
      `V4 does NOT fall back to a default voice to prevent silent gender mismatches.`
    );
  }

  // Validate Gemini picked a real voice from the library.
  // Same hard-fail policy as the earlier catch block: if Gemini hallucinated
  // a voice_id that doesn't exist in our curated library, that's a prompt
  // bug (or a library drift) that needs to be fixed, not papered over with
  // Brian. Throwing here matches the gender-safety discipline.
  const libraryEntry = library.find(v => v.voice_id === result.voice_id);
  if (!libraryEntry) {
    logger.error(
      `Gemini picked unknown voice_id "${result.voice_id}" for persona "${persona.name || 'unnamed'}" — ` +
      `not in curated library of ${library.length} voices`
    );
    throw new Error(
      `Voice acquisition failed for persona "${persona.name || 'unnamed'}": ` +
      `Gemini returned voice_id "${result.voice_id}" which is not in the curated library. ` +
      `Check the voice-library/elevenlabs-presets.json file or the acquirePersonaVoice prompt — ` +
      `do NOT fall back silently.`
    );
  }

  logger.info(`cast "${persona.name || 'unnamed'}" as ${libraryEntry.name} (${libraryEntry.voice_id})`);

  return {
    voiceId: result.voice_id,
    voiceBrief: result.voice_brief || libraryEntry.descriptor,
    voiceName: libraryEntry.name,
    justification: result.justification || 'Library match'
  };
}

/**
 * Fetch the ElevenLabs preview audio URL for a given preset voice_id.
 * Needed because fal-ai/kling-video/create-voice requires a public URL,
 * and ElevenLabs exposes a `preview_url` on every preset voice via the
 * shared voices endpoint.
 *
 * @param {string} elevenLabsVoiceId
 * @returns {Promise<string|null>} preview_url, or null if unavailable
 */
async function fetchElevenLabsPreviewUrl(elevenLabsVoiceId) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return null;

  try {
    const resp = await axios.get(
      `https://api.elevenlabs.io/v1/voices/${elevenLabsVoiceId}`,
      {
        headers: { 'xi-api-key': apiKey },
        timeout: 15000
      }
    );
    return resp.data?.preview_url || null;
  } catch (err) {
    logger.warn(`failed to fetch ElevenLabs preview_url for ${elevenLabsVoiceId}: ${err.message}`);
    return null;
  }
}

/**
 * Batch: acquire voices for every persona in a story that doesn't already have one.
 * Mutates personas in place by setting persona.elevenlabs_voice_id and
 * persona.elevenlabs_voice_brief. Optionally clones the chosen ElevenLabs
 * preset into a Kling voice_id (for A/B testing or Mode C pathways).
 *
 * @param {Object[]} personas
 * @param {Object} [options]
 * @param {boolean} [options.cloneKlingVoice=false] - opt-in Kling voice clone.
 *   Default false because Kling voice_ids only work on V2.6 Pro endpoints,
 *   which V4 Mode B (Kling O3 Omni) does not use.
 * @param {Object} [options.klingFalService] - injected KlingFalService instance
 *   (required if cloneKlingVoice is true — passed in to avoid circular import)
 * @returns {Promise<{acquired: number, skipped: number, failed: number, klingCloned: number, klingFailed: number}>}
 */
export async function acquirePersonaVoicesForStory(personas, options = {}) {
  if (!Array.isArray(personas)) return { acquired: 0, skipped: 0, failed: 0, klingCloned: 0, klingFailed: 0 };

  const { cloneKlingVoice = false, klingFalService = null } = options;

  let acquired = 0;
  let skipped = 0;
  let failed = 0;
  let klingCloned = 0;
  let klingFailed = 0;

  for (const persona of personas) {
    // Step 1: ElevenLabs preset picking (idempotent)
    if (!persona.elevenlabs_voice_id) {
      try {
        const result = await acquirePersonaVoice(persona);
        persona.elevenlabs_voice_id = result.voiceId;
        persona.elevenlabs_voice_brief = result.voiceBrief;
        persona.elevenlabs_voice_name = result.voiceName;
        persona.elevenlabs_voice_justification = result.justification;
        acquired++;
      } catch (err) {
        logger.error(`voice acquisition failed for persona "${persona.name}": ${err.message}`);
        failed++;
        continue; // can't clone what we don't have
      }
    } else {
      skipped++;
    }

    // Step 2 (opt-in): Kling voice cloning from the ElevenLabs preview
    if (cloneKlingVoice && !persona.kling_voice_id && klingFalService) {
      try {
        const previewUrl = await fetchElevenLabsPreviewUrl(persona.elevenlabs_voice_id);
        if (!previewUrl) {
          logger.warn(`no ElevenLabs preview_url for persona "${persona.name}" — skipping Kling clone`);
          klingFailed++;
          continue;
        }
        const { voiceId } = await klingFalService.createVoice({ audioSampleUrl: previewUrl });
        persona.kling_voice_id = voiceId;
        persona.kling_voice_source = 'elevenlabs_preview';
        klingCloned++;
      } catch (err) {
        logger.warn(`Kling voice clone failed for persona "${persona.name}": ${err.message}`);
        klingFailed++;
      }
    }
  }

  logger.info(`voice acquisition: acquired=${acquired}, skipped=${skipped}, failed=${failed}, klingCloned=${klingCloned}, klingFailed=${klingFailed}`);
  return { acquired, skipped, failed, klingCloned, klingFailed };
}

/**
 * Get the full voice library (for the Director's Panel override UI).
 */
export function getVoiceLibrary() {
  return loadVoiceLibrary();
}
