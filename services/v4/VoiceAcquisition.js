// services/v4/VoiceAcquisition.js
// V4 persona voice acquisition — Gemini-driven ElevenLabs preset matching
// with HARD gender enforcement and cross-persona uniqueness.
//
// The flow (Decision 3 from sunny-wishing-teacup.md, hardened 2026-04-23):
//   1. Infer each persona's gender from appearance/description (locally).
//   2. Feed Gemini a FILTERED voice library (matching gender, excluding
//      voices already taken by earlier personas in this batch).
//   3. Gemini writes a 1-sentence voice brief and picks a voice_id.
//   4. Post-pick validation: reject if gender mismatches OR voice_id was
//      already taken. On failure, do a deterministic fallback pick from
//      the filtered subset (so the episode never ships with a wrong-gender
//      or duplicate voice).
//   5. Assign persona.elevenlabs_voice_id + persona.elevenlabs_voice_brief.
//
// Why this matters (incident 2026-04-23):
//   An Action-genre episode cast ALL THREE personas with the same Brian
//   (male) voice — including a female character (persona 2). Root cause:
//     (a) acquirePersonaVoicesForStory casts one persona at a time with no
//         awareness of voices already taken → Gemini repeatedly picked the
//         same "safe" voice
//     (b) No gender check → Gemini's pick drifted to male for a female persona
//     (c) `skipped` path bypasses re-casting even when the stored voice is
//         clearly wrong (no way to recover without manual intervention)
//
// Fix: gender + uniqueness as hard pre-filters, not soft hints. Add a
// `force` option to opt out of the skip-if-exists shortcut.

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
// Gender inference
// ─────────────────────────────────────────────────────────────────────

// Explicit-marker word lists. These are intentionally conservative — we
// return 'unknown' when signals are weak so Gemini can still decide,
// but we HARD-BLOCK the opposite gender when the signal is clear.
const FEMALE_MARKERS = [
  // Nouns / role words
  '\\bwoman\\b', '\\bwomen\\b', '\\bgirl\\b', '\\bgirls\\b', '\\blady\\b', '\\bladies\\b',
  '\\bfemale\\b', '\\bfeminine\\b', '\\bmother\\b', '\\bdaughter\\b', '\\bsister\\b',
  '\\bwife\\b', '\\bgirlfriend\\b', '\\bqueen\\b', '\\bprincess\\b', '\\bactress\\b',
  '\\bheroine\\b', '\\bmatron\\b', '\\bmaiden\\b', '\\bmadam\\b', '\\bmrs\\b', '\\bms\\b', '\\bmiss\\b',
  // Pronouns
  '\\bshe\\b', '\\bher\\b', '\\bhers\\b', '\\bherself\\b',
  // Visual descriptors used consistently for female presentation
  '\\blong hair\\b', '\\bponytail\\b', '\\bmakeup\\b', '\\blipstick\\b', '\\bearrings\\b',
  '\\bdress\\b', '\\bskirt\\b', '\\bhigh heels\\b', '\\bbra\\b'
];

const MALE_MARKERS = [
  '\\bman\\b', '\\bmen\\b', '\\bboy\\b', '\\bboys\\b', '\\bgentleman\\b',
  '\\bmale\\b', '\\bmasculine\\b', '\\bfather\\b', '\\bson\\b', '\\bbrother\\b',
  '\\bhusband\\b', '\\bboyfriend\\b', '\\bking\\b', '\\bprince\\b', '\\bactor\\b',
  '\\bhero\\b', '\\bsir\\b', '\\bmr\\b',
  // Pronouns (careful — "his" is a false positive for "history", etc. — use word-boundary)
  '\\bhe\\b', '\\bhim\\b', '\\bhis\\b', '\\bhimself\\b',
  // Visual markers
  '\\bbeard\\b', '\\bmustache\\b', '\\bmoustache\\b', '\\bgoatee\\b', '\\bstubble\\b',
  '\\btuxedo\\b', '\\bsuit and tie\\b'
];

function countMatches(text, patterns) {
  if (!text) return 0;
  const lc = text.toLowerCase();
  let total = 0;
  for (const p of patterns) {
    const matches = lc.match(new RegExp(p, 'g'));
    if (matches) total += matches.length;
  }
  return total;
}

/**
 * Infer a persona's gender from its written description.
 *
 * Returns:
 *   'male'    — at least one strong male marker AND more male than female markers
 *   'female'  — at least one strong female marker AND more female than male markers
 *   'unknown' — no clear signal (ambiguous description, or neither marker present)
 *
 * Unknown is the correct answer when the text is truly ambiguous — callers
 * should treat it as "no hard gender constraint" and let Gemini pick freely.
 * We hard-block the opposite-gender voice ONLY when the inference is strong.
 *
 * @param {Object} persona
 * @returns {'male'|'female'|'unknown'}
 */
export function inferPersonaGender(persona) {
  if (!persona || typeof persona !== 'object') return 'unknown';

  // Prefer persona-level explicit gender if provided (some persona generation
  // paths capture this directly). Trust it absolutely.
  const explicit = String(persona.gender || persona.sex || '').toLowerCase().trim();
  if (explicit === 'male' || explicit === 'man' || explicit === 'm') return 'male';
  if (explicit === 'female' || explicit === 'woman' || explicit === 'f') return 'female';

  // Otherwise scan the description text. Concatenate every field the caller
  // might populate — we don't assume any specific one.
  const text = [
    persona.name,
    persona.description,
    persona.personality,
    persona.appearance,
    persona.visual_description,
    persona.role,
    persona.wardrobe_hint,
    persona.core_contradiction,
    persona.moral_code,
    persona.want,
    persona.need,
    persona.wound,
    persona.flaw
  ].filter(Boolean).join(' ');

  const femaleHits = countMatches(text, FEMALE_MARKERS);
  const maleHits = countMatches(text, MALE_MARKERS);

  // Strong signal threshold: at least 2 markers AND > 60% preference
  if (femaleHits >= 2 && femaleHits > maleHits * 1.5) return 'female';
  if (maleHits >= 2 && maleHits > femaleHits * 1.5) return 'male';

  // Weak signal — return unknown so Gemini decides freely.
  return 'unknown';
}

/**
 * Filter the voice library by gender and taken-set. The result is what
 * we show Gemini (and what we use for the deterministic fallback pick).
 *
 * @param {Array} library - voice library entries
 * @param {'male'|'female'|'unknown'} gender
 * @param {Set<string>} takenVoiceIds - voices already assigned this batch
 * @returns {Array} filtered subset
 */
function filterLibrary(library, gender, takenVoiceIds) {
  return library.filter(v => {
    if (takenVoiceIds.has(v.voice_id)) return false;
    if (gender === 'unknown') return true; // no gender constraint
    return String(v.gender || '').toLowerCase() === gender;
  });
}

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

/**
 * Pick an ElevenLabs preset voice for a single persona.
 *
 * HARD CONSTRAINTS (enforced before and after Gemini's pick):
 *   - Cannot reuse a voice_id in `options.takenVoiceIds`
 *   - Must match `options.requiredGender` if specified
 *
 * @param {Object} persona
 * @param {Object} [options]
 * @param {Set<string>} [options.takenVoiceIds] - voices already taken this batch
 * @param {'male'|'female'|'unknown'} [options.requiredGender]
 * @returns {Promise<{voiceId, voiceBrief, voiceName, justification, gender}>}
 */
export async function acquirePersonaVoice(persona, options = {}) {
  if (!persona) throw new Error('acquirePersonaVoice: persona required');

  const library = loadVoiceLibrary();
  if (library.length === 0) {
    throw new Error('acquirePersonaVoice: voice library is empty');
  }

  const takenVoiceIds = options.takenVoiceIds instanceof Set ? options.takenVoiceIds : new Set();
  const requiredGender = options.requiredGender || 'unknown';

  const candidatePool = filterLibrary(library, requiredGender, takenVoiceIds);
  if (candidatePool.length === 0) {
    throw new Error(
      `Voice acquisition for "${persona.name || 'unnamed'}": no available voices ` +
      `match constraints (gender=${requiredGender}, ${takenVoiceIds.size} already taken, ` +
      `library=${library.length}). Add more voices of this gender to the library or ` +
      `reduce the number of personas.`
    );
  }

  const libraryForPrompt = candidatePool.map(v =>
    `  - ${v.voice_id} | ${v.name} (${v.gender}, ${v.age}, ${v.accent}): ${v.descriptor}. Best for: ${(v.best_for || []).join(', ')}.`
  ).join('\n');

  const personaDescription = [
    persona.name && `Name: ${persona.name}`,
    persona.personality && `Personality: ${persona.personality}`,
    persona.role && `Role: ${persona.role}`,
    persona.description && `Description: ${persona.description}`,
    (persona.appearance || persona.visual_description) && `Appearance: ${persona.appearance || persona.visual_description}`
  ].filter(Boolean).join('\n');

  const genderClause = requiredGender === 'unknown'
    ? ''
    : `\n\nHARD CONSTRAINT: the persona is inferred to be ${requiredGender}. Every voice in the library below is pre-filtered to match this gender — you MUST pick from them. Returning a non-matching voice_id is a pipeline error.`;

  const takenClause = takenVoiceIds.size === 0
    ? ''
    : `\n\nHARD CONSTRAINT: the following voice_ids are ALREADY TAKEN by other personas in this story — you MUST NOT pick any of them: ${Array.from(takenVoiceIds).join(', ')}. The library below is pre-filtered to exclude them — pick from the remaining ${candidatePool.length} options only.`;

  const systemPrompt = `You are a voice-casting director picking the right ElevenLabs voice for a character in a branded short film.

You have a curated library of ElevenLabs premade voices (below). Given a persona description, you will:
  1. Write a 1-sentence voice brief describing the IDEAL voice for this character (pitch, timbre, pace, accent, age, gender, emotional tone). Example: "warm baritone, slight rasp, mid-30s American, deliberate pacing, trustworthy but guarded"
  2. Pick the ONE voice_id from the library that best matches your brief
  3. Write a 1-sentence justification explaining why this voice fits
${genderClause}${takenClause}

Respond with ONLY this JSON shape:
{
  "voice_brief": "1-sentence description of the ideal voice",
  "voice_id": "the exact voice_id string from the library",
  "voice_name": "the Name field from the library entry",
  "justification": "1-sentence reason why this preset matches the persona"
}

AVAILABLE VOICES (${candidatePool.length} after gender+uniqueness filter):
${libraryForPrompt}`;

  const userPrompt = `Cast the voice for this persona:

${personaDescription}`;

  logger.info(
    `acquiring voice for persona "${persona.name || 'unnamed'}" ` +
    `(gender=${requiredGender}, ${candidatePool.length}/${library.length} candidates after filter, ` +
    `${takenVoiceIds.size} already taken)`
  );

  let result;
  try {
    result = await callGeminiJson(systemPrompt, userPrompt);
  } catch (err) {
    logger.error(`Gemini voice casting HARD-FAILED for persona "${persona.name || 'unnamed'}": ${err.message}`);
    throw new Error(
      `Voice acquisition failed for persona "${persona.name || 'unnamed'}": ${err.message}. ` +
      `Fix the underlying Gemini error (model config, token budget, prompt) before retrying.`
    );
  }

  // Validate Gemini's pick against the hard constraints we gave it. If it
  // returned something outside the candidate pool (hallucination, constraint
  // ignored), fall back to a deterministic pick from the pool rather than
  // failing the whole story.
  let libraryEntry = candidatePool.find(v => v.voice_id === result.voice_id);
  let geminiRespected = true;

  if (!libraryEntry) {
    geminiRespected = false;
    // Gemini picked something out of the candidate pool — either from the full
    // library (taken or wrong gender) or hallucinated. We pick deterministically
    // from the pool instead: first candidate whose descriptor shares words with
    // the persona's personality. Falls back to first-in-pool if no overlap.
    const personalityLower = String(persona.personality || '').toLowerCase();
    const scored = candidatePool.map(v => {
      const words = (v.descriptor || '').toLowerCase().split(/\s+/);
      const overlap = words.filter(w => w.length > 3 && personalityLower.includes(w)).length;
      return { v, overlap };
    }).sort((a, b) => b.overlap - a.overlap);
    libraryEntry = scored[0].v;
    logger.warn(
      `Gemini returned voice_id "${result.voice_id}" for persona "${persona.name || 'unnamed'}" ` +
      `— outside the filtered candidate pool (gender=${requiredGender}, ${takenVoiceIds.size} taken). ` +
      `Falling back to deterministic pick: ${libraryEntry.name} (${libraryEntry.voice_id}).`
    );
  }

  // Final sanity: the chosen voice must not be taken and must match required gender.
  // These would be bugs in the filter logic, but cheap insurance.
  if (takenVoiceIds.has(libraryEntry.voice_id)) {
    throw new Error(
      `Voice acquisition internal error: selected voice_id "${libraryEntry.voice_id}" is already taken — ` +
      `filter logic is broken.`
    );
  }
  if (requiredGender !== 'unknown' && String(libraryEntry.gender || '').toLowerCase() !== requiredGender) {
    throw new Error(
      `Voice acquisition internal error: selected voice "${libraryEntry.name}" has gender ` +
      `"${libraryEntry.gender}" but required="${requiredGender}" — filter logic is broken.`
    );
  }

  logger.info(
    `cast "${persona.name || 'unnamed'}" (${requiredGender}) as ${libraryEntry.name} ` +
    `(${libraryEntry.voice_id}, ${libraryEntry.gender}) ` +
    `[${geminiRespected ? 'gemini' : 'fallback'}]`
  );

  return {
    voiceId: libraryEntry.voice_id,
    voiceBrief: result.voice_brief || libraryEntry.descriptor,
    voiceName: libraryEntry.name,
    gender: libraryEntry.gender,
    justification: result.justification || (geminiRespected ? 'Library match' : 'Deterministic fallback (Gemini out-of-pool)')
  };
}

/**
 * Fetch the ElevenLabs preview audio URL for a given preset voice_id.
 * Used by the opt-in Kling voice clone path.
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
 * Batch: acquire voices for every persona in a story.
 *
 * Mutates personas in place by setting persona.elevenlabs_voice_id etc.
 * Enforces cross-persona uniqueness and gender correctness by construction:
 *   - Infers each persona's gender before calling Gemini
 *   - Tracks taken voice_ids across the batch
 *   - Re-validates after the batch: if any duplicate or gender-mismatched
 *     voice made it through, auto-remediate by force-recasting those personas
 *
 * @param {Object[]} personas
 * @param {Object} [options]
 * @param {boolean} [options.force=false] - re-acquire even if persona already
 *   has an elevenlabs_voice_id. Use to fix legacy/stuck assignments.
 * @param {boolean} [options.cloneKlingVoice=false]
 * @param {Object}  [options.klingFalService]
 * @returns {Promise<{acquired, already_assigned, failed, klingCloned, klingFailed, remediated}>}
 */
export async function acquirePersonaVoicesForStory(personas, options = {}) {
  if (!Array.isArray(personas)) {
    return { acquired: 0, already_assigned: 0, failed: 0, klingCloned: 0, klingFailed: 0, remediated: 0 };
  }

  const {
    force = false,
    cloneKlingVoice = false,
    klingFalService = null
  } = options;

  const library = loadVoiceLibrary();

  let acquired = 0;
  let already_assigned = 0;
  let failed = 0;
  let klingCloned = 0;
  let klingFailed = 0;
  let remediated = 0;

  // ── Pass 1: acquire for every persona, tracking taken voices + inferred gender ──
  const takenVoiceIds = new Set();
  const personaGenders = personas.map(p => inferPersonaGender(p));
  const personaNames = personas.map(p => p?.name || 'unnamed');

  for (let i = 0; i < personas.length; i++) {
    const persona = personas[i];
    if (!persona) continue;
    const inferredGender = personaGenders[i];
    logger.info(`persona ${i} "${personaNames[i]}" — inferred gender: ${inferredGender}`);

    const hasExistingVoice = !!persona.elevenlabs_voice_id;
    const existingIsValid = (() => {
      if (!hasExistingVoice) return false;
      const entry = library.find(v => v.voice_id === persona.elevenlabs_voice_id);
      if (!entry) return false; // stored voice_id not in library
      if (takenVoiceIds.has(persona.elevenlabs_voice_id)) return false; // duplicate in batch
      if (inferredGender !== 'unknown' && String(entry.gender).toLowerCase() !== inferredGender) return false;
      return true;
    })();

    if (hasExistingVoice && existingIsValid && !force) {
      // Keep the existing valid assignment — re-acquisition not needed.
      takenVoiceIds.add(persona.elevenlabs_voice_id);
      already_assigned++;
      continue;
    }

    if (hasExistingVoice && !existingIsValid) {
      // Mid-batch auto-remediation: the stored voice is invalid (duplicate in
      // this batch, wrong gender, or not in library). Log clearly and re-cast.
      const entry = library.find(v => v.voice_id === persona.elevenlabs_voice_id);
      const reason = !entry ? 'voice_id not in library'
        : takenVoiceIds.has(persona.elevenlabs_voice_id) ? `duplicate of earlier persona in this batch`
        : `gender mismatch (stored=${entry.gender}, inferred=${inferredGender})`;
      logger.warn(
        `persona ${i} "${personaNames[i]}" has an invalid stored voice_id ` +
        `(${persona.elevenlabs_voice_id} — ${reason}) — re-casting`
      );
      remediated++;
    }

    try {
      const result = await acquirePersonaVoice(persona, {
        takenVoiceIds,
        requiredGender: inferredGender
      });
      persona.elevenlabs_voice_id = result.voiceId;
      persona.elevenlabs_voice_brief = result.voiceBrief;
      persona.elevenlabs_voice_name = result.voiceName;
      persona.elevenlabs_voice_justification = result.justification;
      persona.elevenlabs_voice_gender = result.gender;
      takenVoiceIds.add(result.voiceId);
      acquired++;
    } catch (err) {
      logger.error(`voice acquisition failed for persona "${personaNames[i]}": ${err.message}`);
      failed++;
      continue;
    }

    // Opt-in Kling clone (unchanged from previous implementation)
    if (cloneKlingVoice && !persona.kling_voice_id && klingFalService) {
      try {
        const previewUrl = await fetchElevenLabsPreviewUrl(persona.elevenlabs_voice_id);
        if (!previewUrl) {
          logger.warn(`no ElevenLabs preview_url for persona "${personaNames[i]}" — skipping Kling clone`);
          klingFailed++;
          continue;
        }
        const { voiceId } = await klingFalService.createVoice({ audioSampleUrl: previewUrl });
        persona.kling_voice_id = voiceId;
        persona.kling_voice_source = 'elevenlabs_preview';
        klingCloned++;
      } catch (err) {
        logger.warn(`Kling voice clone failed for persona "${personaNames[i]}": ${err.message}`);
        klingFailed++;
      }
    }
  }

  // ── Pass 2: sanity-check for any residual issues (belt-and-braces) ──
  const finalVoiceIds = personas
    .map(p => p?.elevenlabs_voice_id)
    .filter(Boolean);
  const uniqueIds = new Set(finalVoiceIds);
  if (uniqueIds.size !== finalVoiceIds.length) {
    logger.error(
      `VoiceAcquisition internal bug: final persona list contains duplicate voice_ids ` +
      `(${finalVoiceIds.length} total vs ${uniqueIds.size} unique). This should be impossible ` +
      `given the pass-1 filter; investigate.`
    );
  }

  logger.info(
    `voice acquisition: acquired=${acquired}, already_assigned=${already_assigned}, failed=${failed}, ` +
    `klingCloned=${klingCloned}, klingFailed=${klingFailed}, remediated=${remediated}`
  );
  return { acquired, already_assigned, failed, klingCloned, klingFailed, remediated };
}

/**
 * Get the full voice library (for the Director's Panel override UI).
 */
export function getVoiceLibrary() {
  return loadVoiceLibrary();
}

// ─────────────────────────────────────────────────────────────────────
// Cast Bible Phase 5a follow-up — intelligent fallback picker
// ─────────────────────────────────────────────────────────────────────
//
// PROBLEM: three production code paths fall back to the literal Brian voice
// (voice_id = 'nPczCjzI2devNBz1zQrb', male) when a persona record is missing
// `elevenlabs_voice_id`:
//
//   1. services/TTSService.js:38 — DEFAULT_VOICE_ID emergency last resort
//   2. services/beat-generators/VoiceoverBRollGenerator.js:51 — V.O. fallback
//   3. services/BrandStoryService.js:3660 + :4511 — defaultNarratorVoiceId
//
// This means a missing voice acquisition silently casts a male American voice
// over a female persona's narration. The user sees no error; the audio is
// just wrong.
//
// FIX: synchronous gender + persona-aware library picker. Used at every
// fallback site instead of the literal Brian voice. No Gemini call, no
// network — purely deterministic selection from the curated library.
//
// Logic:
//   1. Infer gender (local regex; or use caller-supplied genderOverride)
//   2. Filter library by gender + takenVoiceIds
//   3. If gender filter empties pool, soften by dropping takenVoiceIds
//      (gender correctness > uniqueness for fallback path)
//   4. If gender STILL empties pool (library has no voices of that gender),
//      fall back to library-wide
//   5. Score remaining candidates by descriptor↔personality word overlap
//      (same heuristic as the deterministic-fallback path inside
//      acquirePersonaVoice — produces a creatively-sensible match)
//   6. Loud warn so the upstream miss is visible in production logs
//
// Returns the FULL library entry (voice_id, name, gender, descriptor, etc.)
// so the caller can persist all relevant fields.
//
// Callers must NEVER use the picker as a primary path — voice acquisition
// (acquirePersonaVoice) is the only correct primary site. This is a defense
// in depth.
/**
 * @param {Object} persona - persona_config.personas[i]
 * @param {Object} [options]
 * @param {Set<string>} [options.takenVoiceIds] - voices already assigned to other personas
 * @param {'male'|'female'|'unknown'} [options.genderOverride] - skip local inference
 * @param {string} [options.languageOverride] - ISO 639-1 to skip persona.language read (Day 4)
 * @param {string} [options.reason] - short string for log context (which fallback fired)
 * @returns {Object|null} library entry or null if library is empty
 */
export function pickFallbackVoiceForPersona(persona, options = {}) {
  const library = loadVoiceLibrary();
  if (library.length === 0) {
    logger.error(`pickFallbackVoiceForPersona: voice library is empty — cannot pick`);
    return null;
  }

  const {
    takenVoiceIds = new Set(),
    genderOverride,
    languageOverride,
    reason = 'unspecified'
  } = options;

  const personaName = persona?.name || 'unnamed';
  const gender = genderOverride || inferPersonaGender(persona || {});
  // V4 Audio Layer Overhaul Day 4 — language-aware filter.
  //
  // Resolution order: explicit languageOverride → persona.language → null.
  // null means "any language" — the picker behaves like pre-Day-4 (legacy).
  // When set, the filter chain runs language → gender → uniqueness, with
  // language taking PRECEDENCE over gender on softening: a wrong-LANGUAGE
  // voice synthesizing in a foreign accent sounds worse than a wrong-gender
  // voice in the right language.
  //
  // A voice without an explicit `languages[]` field is assumed to support
  // the library's default_language ('en' — see _meta.language_filter_contract
  // in elevenlabs-presets.json). Hebrew personas only match voices that
  // EXPLICITLY declare 'he' (or any case-insensitive prefix match like 'heb').
  const rawLanguage = languageOverride || persona?.language || null;
  const language = rawLanguage ? String(rawLanguage).trim().toLowerCase() : null;
  const DEFAULT_LIBRARY_LANGUAGE = 'en';

  const voiceSupportsLanguage = (v, langCode) => {
    if (!langCode) return true; // null = any language matches
    const declared = Array.isArray(v.languages) && v.languages.length > 0
      ? v.languages.map(l => String(l).toLowerCase())
      : [DEFAULT_LIBRARY_LANGUAGE];
    return declared.some(d => d === langCode || d.startsWith(langCode) || langCode.startsWith(d));
  };

  // Stage 1 — strict filter (language + gender + uniqueness)
  let pool = library.filter(v => {
    if (takenVoiceIds.has(v.voice_id)) return false;
    if (!voiceSupportsLanguage(v, language)) return false;
    if (gender === 'unknown') return true;
    return String(v.gender || '').toLowerCase() === gender;
  });

  // Stage 2 — gender filter empties pool (all gender-matched voices in this
  // language are taken). Soften by ignoring takenVoiceIds. Language stays
  // strict; gender stays strict; only uniqueness relaxes.
  let stage = 'strict';
  if (pool.length === 0 && gender !== 'unknown') {
    pool = library.filter(v => voiceSupportsLanguage(v, language)
      && String(v.gender || '').toLowerCase() === gender);
    stage = 'softened_uniqueness';
  }

  // Stage 3 — gender STILL empties pool. Soften gender (e.g. Hebrew library
  // has only male voices — better to ship a wrong-gender Hebrew voice than
  // an English voice synthesizing Hebrew). Language stays locked.
  if (pool.length === 0 && language) {
    pool = library.filter(v => voiceSupportsLanguage(v, language));
    stage = 'softened_gender';
  }

  // Stage 4 — language pool is empty (library has zero voices declaring
  // this language). LAST RESORT: fall back to library-wide on the
  // assumption that a TTS engine (eleven-v3) can still render the language
  // with a base voice, even at lower quality. Loud warn so the upstream
  // library-expansion miss is visible.
  if (pool.length === 0) {
    pool = library.filter(v => {
      if (takenVoiceIds.has(v.voice_id)) return false;
      if (gender !== 'unknown' && String(v.gender || '').toLowerCase() !== gender) return false;
      return true;
    });
    stage = 'softened_language';
  }
  if (pool.length === 0) {
    pool = library;
    stage = 'softened_all';
  }

  // Score by descriptor↔personality word overlap. Same heuristic as
  // acquirePersonaVoice's deterministic fallback at line 304-309.
  const personalityLower = String(persona?.personality || persona?.description || '').toLowerCase();
  const scored = pool.map(v => {
    const words = (v.descriptor || '').toLowerCase().split(/\s+/);
    const overlap = words.filter(w => w.length > 3 && personalityLower.includes(w)).length;
    return { v, overlap };
  }).sort((a, b) => b.overlap - a.overlap);

  const picked = scored[0].v;

  // Loud log — fallback firing means something failed upstream. Visibility
  // matters more than terseness here.
  logger.warn(
    `pickFallbackVoiceForPersona [${reason}]: persona "${personaName}" had no elevenlabs_voice_id — ` +
    `picked ${picked.name} (${picked.voice_id}, ${picked.gender}) ` +
    `[language=${language || 'any'}, gender=${gender}, stage=${stage}, ${takenVoiceIds.size} taken, pool=${pool.length}]. ` +
    `This is a defense-in-depth fallback; investigate why voice acquisition didn't run for this persona.`
  );

  return picked;
}

/**
 * Convenience wrapper for the very common case: caller has personas[] and
 * wants the fallback voice for personas[idx], avoiding collisions with the
 * other personas' voices. Returns just the voice_id string for drop-in
 * compatibility with the legacy `'nPczCjzI2devNBz1zQrb'` literal sites.
 *
 * @param {Object[]} personas - the full persona_config.personas[]
 * @param {number} idx - which persona to pick a fallback for
 * @param {Object} [options] - { reason, genderOverride }
 * @returns {string|null} voice_id or null if library is empty
 */
export function pickFallbackVoiceIdForPersonaInList(personas, idx, options = {}) {
  if (!Array.isArray(personas) || !personas[idx]) {
    // No persona at this index — pick a generic library voice (no gender
    // signal, no collisions to avoid). Still better than a hardcoded literal.
    const entry = pickFallbackVoiceForPersona({}, { reason: options.reason || 'no_persona_at_index' });
    return entry?.voice_id || null;
  }
  const taken = new Set(
    personas
      .filter((_, i) => i !== idx)
      .map(p => p?.elevenlabs_voice_id)
      .filter(Boolean)
  );
  const entry = pickFallbackVoiceForPersona(personas[idx], {
    takenVoiceIds: taken,
    ...options
  });
  return entry?.voice_id || null;
}
