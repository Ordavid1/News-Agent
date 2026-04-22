// services/v4/VeoPromptSanitizer.js
//
// Vertex AI Veo 3.1 Standard applies pre-submission content-safety filtering
// that occasionally refuses legitimate brand-film prompts. The most common
// refusal pattern in V4 production is:
//
//   "A luxury silver wristwatch on Leo's wrist."
//                                  ^^^^^^^^^^^^^
//   Persona name + body-part phrasing trips Vertex's person-identity filter.
//   Support code 29310472: "The prompt could not be submitted. This prompt
//   contains words that violate Vertex AI's usage guidelines."
//
// Root cause: Gemini composes INSERT_SHOT subject_focus strings like
// "X on Leo's wrist" / "cradled in Maya's hands" — natural from a narrative
// perspective but Vertex's person-identity filter reads "Leo's wrist" as
// identifying a specific individual combined with a body part.
//
// This module provides three tiers of sanitization, applied progressively
// on retry. A live-streamlined production uses the tiered retry: send
// Gemini's original prompt first (best quality), sanitize on 1st refusal,
// minimal prompt on 2nd refusal, fail only if all three are refused.
//
// IMPORTANT: sanitization is LOSSY. It trades creative specificity for
// submission acceptance. Don't apply proactively; apply only on refusal.

// ──────────────────────────────────────────────────────────────
// Content-filter error detection
// ──────────────────────────────────────────────────────────────

const CONTENT_FILTER_SIGNATURES = [
  /usage guidelines/i,
  /could not be submitted/i,
  /violate[sd]?\s+.*guidelines/i,
  /inappropriate content/i,
  /content polic/i,
  /safety filter/i,
  /prohibited content/i,
  /support codes?:\s*29\d{6}/i // Vertex content-filter support codes start with 29
];

/**
 * Heuristically classify an error as a content-filter rejection.
 * Pre-submission filter errors come through as plain Error objects from the
 * Vertex LRO failure path, not as ContentFilterError — this heuristic catches
 * them by message signature.
 *
 * @param {Error} err
 * @returns {boolean}
 */
export function isVeoContentFilterError(err) {
  if (!err) return false;
  if (err.name === 'ContentFilterError') return true;
  const msg = String(err.message || '');
  return CONTENT_FILTER_SIGNATURES.some(re => re.test(msg));
}

// ──────────────────────────────────────────────────────────────
// Known trigger patterns — progressive sanitization
// ──────────────────────────────────────────────────────────────

// Body-part phrasing that combined with a possessive pronoun / name trips
// the person-identity filter. Match "<Name>'s <body part>" and "on someone's hand"
// style constructions. Genre-agnostic — these patterns are unsafe for any brand.
const POSSESSIVE_BODY_PART_RE = /\b([A-Z][a-zA-Z]+)'s\s+(wrist|hand|hands|arm|arms|fingers|finger|palm|neck|chest|face|lips|eyes|hair|shoulder|shoulders|leg|legs|feet|foot|body|back|hip|hips|waist)\b/g;

// Pronoun + body part (her wrist, his hand) — also triggers the filter when
// combined with other signals (persona reference images via first-frame).
const PRONOUN_BODY_PART_RE = /\b(his|her|their)\s+(wrist|hand|hands|arm|arms|fingers|finger|palm|neck|chest|face|lips|eyes|hair|shoulder|shoulders|leg|legs|feet|foot|body|back|hip|hips|waist)\b/gi;

// Generic product-hero safe phrasings we can swap in.
const NEUTRAL_FRAMINGS = [
  'held in frame',
  'in close detail',
  'cradled by gloved hands',
  'resting on a marble surface',
  'suspended in the frame',
  'at the centre of the composition'
];

/**
 * Strip persona names (from a known list) wherever they appear in the prompt.
 * We can't strip every proper noun blindly because brand/subject names are
 * legitimate. We only strip names we KNOW are personas.
 *
 * @param {string} prompt
 * @param {string[]} personaNames
 * @returns {string}
 */
function stripPersonaNames(prompt, personaNames = []) {
  if (!prompt || personaNames.length === 0) return prompt;
  let out = prompt;
  for (const name of personaNames) {
    if (!name || typeof name !== 'string' || name.length < 2) continue;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Remove "Leo's", "Leo," "Leo ", including trailing possessive
    out = out.replace(new RegExp(`\\b${esc}'s\\b`, 'g'), 'the figure\u2019s');
    out = out.replace(new RegExp(`\\b${esc}\\b`, 'g'), 'the figure');
  }
  return out;
}

/**
 * Replace "<Name>'s <bodypart>" with a product-centric neutral framing.
 * Preserves the rest of the prompt.
 *
 * @param {string} prompt
 * @returns {string}
 */
function neutraliseBodyPartPhrasing(prompt) {
  if (!prompt) return prompt;
  let out = prompt;
  // First pass — possessive name + body part
  out = out.replace(POSSESSIVE_BODY_PART_RE, 'in frame');
  // Second pass — pronoun + body part
  out = out.replace(PRONOUN_BODY_PART_RE, 'in frame');
  return out;
}

/**
 * Collapse whitespace / trailing commas / duplicate spaces left by substitutions.
 */
function tidyPrompt(prompt) {
  if (!prompt) return prompt;
  return prompt
    .replace(/\bon\s+in frame\b/gi, 'in frame')           // "on in frame" artefact
    .replace(/\bat\s+in frame\b/gi, 'in frame')
    .replace(/\bof\s+in frame\b/gi, 'in frame')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
}

// ──────────────────────────────────────────────────────────────
// Tiered sanitization
// ──────────────────────────────────────────────────────────────

/**
 * Tier 1 sanitization: strip persona names and body-part phrasing, keep
 * everything else. Typical success for "X on Maya's wrist" → "X in frame".
 *
 * @param {string} prompt
 * @param {string[]} personaNames
 * @returns {string}
 */
export function sanitizeTier1(prompt, personaNames = []) {
  if (!prompt) return prompt;
  let out = neutraliseBodyPartPhrasing(prompt);
  out = stripPersonaNames(out, personaNames);
  return tidyPrompt(out);
}

/**
 * Tier 2 sanitization: extremely minimal prompt — subject name + generic
 * product-hero cinematography. Sacrifices all narrative specificity in
 * exchange for near-certain submission acceptance.
 *
 * @param {Object} opts
 * @param {string} opts.subjectName - brand subject name (e.g. "Sela Binuy keycard")
 * @param {string} [opts.subjectDescription] - 1-line description
 * @param {string} [opts.stylePrefix] - visual style continuity (safe — colors/lens/film stock)
 * @returns {string}
 */
export function sanitizeTier2({ subjectName = 'the subject', subjectDescription = '', stylePrefix = '' } = {}) {
  const parts = [
    stylePrefix,
    `Tight cinematic macro shot of ${subjectName}`,
    subjectDescription ? `— ${subjectDescription}` : '',
    '. Extreme detail, product hero composition, shallow depth of field, held in frame. Slow push-in. Soft directional key light, subtle ambient foley.'
  ].filter(Boolean).join(' ');
  return tidyPrompt(parts);
}

export default {
  isVeoContentFilterError,
  sanitizeTier1,
  sanitizeTier2
};
