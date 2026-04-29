// services/v4/PersonaVisualAnchor.js
//
// V4 Phase 5b — Vision-grounded persona ground truth.
//
// THE PROBLEM (Director Agent audit, 2026-04-29):
//   The V4 pipeline has THREE independent text-only decision stages — storyline
//   writer, CharacterSheetDirector, VoiceAcquisition.inferPersonaGender — that
//   all read text fields. When a user uploads a photo with a thin description,
//   each stage fabricates from the placeholder text. Story `77d6eaaf` (2026-04-28):
//   uploaded woman → invented male protagonist "Elias" → male character sheets →
//   voice-gender mismatch caught but not actioned → wrong-gender voice baked
//   into the cut.
//
// THE FIX:
//   ONE multimodal Vertex Gemini call at upload time (or post-CharacterSheetDirector
//   for auto-generated personas) extracts a structured `visual_anchor` record
//   and persists it on `persona.visual_anchor`. Every downstream text-only stage
//   reads this record as ground truth. Identity drift is closed at the source.
//
// The schema is the Director Agent's expanded "casting bible entry" — identity +
// presence + craft register + provenance. Generic, no hardcoded references,
// works for any genre + any persona.
//
// Two source paths share ONE downstream contract (Director Agent mandate —
// upload-personas and auto-generated personas converge on the same shape):
//   • source='upload_vision'  → input is photoUrls (uploaded by user)
//   • source='sheet_vision'   → input is photoUrls of generated character sheets
//                              (after CharacterSheetDirector + Flux 2 Max emit)
//
// Idempotent: cached by sha256(photoUrls.join('|')) so re-running on the same
// inputs returns the same anchor without burning a Gemini call.

import crypto from 'crypto';
import winston from 'winston';
import { callVertexGeminiJson } from './VertexGemini.js';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) =>
      `[PersonaVisualAnchor] ${timestamp} [${level}]: ${message}`
    )
  ),
  transports: [new winston.transports.Console()]
});

// ─────────────────────────────────────────────────────────────────────
// Schema — the Director Agent's casting-bible entry
// ─────────────────────────────────────────────────────────────────────

const RESPONSE_SCHEMA = {
  type: 'object',
  required: [
    'apparent_age_range',
    'apparent_gender_presentation',
    'ethnicity_visual_descriptors',
    'hair_color', 'hair_texture', 'hair_length_style',
    'skin_tone_descriptor',
    'build',
    'distinctive_features',
    'posture_baseline',
    'energy_register',
    'micro_expression_baseline',
    'gaze_quality',
    'recommended_focal_length_mm',
    'recommended_lighting_register',
    'vision_confidence',
    'low_confidence_fields'
  ],
  properties: {
    apparent_age_range: { type: 'string' },                  // '25-35', '40-55'
    apparent_gender_presentation: {
      type: 'string',
      enum: ['female', 'male', 'androgynous', 'unknown']
    },
    ethnicity_visual_descriptors: { type: 'string' },
    hair_color: { type: 'string' },
    hair_texture: { type: 'string' },
    hair_length_style: { type: 'string' },
    eye_color: { type: 'string' },
    skin_tone_descriptor: { type: 'string' },
    build: { type: 'string' },
    distinctive_features: {
      type: 'array',
      items: { type: 'string' }
    },
    posture_baseline: { type: 'string' },
    energy_register: {
      type: 'string',
      enum: ['grounded', 'coiled', 'effervescent', 'withdrawn', 'commanding', 'soft', 'guarded']
    },
    micro_expression_baseline: { type: 'string' },
    gaze_quality: {
      type: 'string',
      enum: ['direct', 'averted', 'middle_distance', 'soft_engaged']
    },
    recommended_focal_length_mm: { type: 'string' },         // '85-100'
    recommended_lighting_register: { type: 'string' },
    vision_confidence: { type: 'number' },                   // 0..1
    low_confidence_fields: {
      type: 'array',
      items: { type: 'string' }
    }
  }
};

const SYSTEM_PROMPT = `You are a casting director examining reference photographs of a person who will appear in a short film. You return a single JSON object — the casting-bible entry — describing who you see. This becomes ground truth for every downstream stage (screenwriter, character-sheet director, voice picker, cinematographer).

You report ONLY what is visible. You do NOT invent personality, backstory, profession, or wardrobe choices that are not on screen. When a field is genuinely unclear from the photos provided (low light, profile only, partial occlusion), include it in low_confidence_fields and provide your best honest read for vision_confidence overall.

Schema you must populate:

  IDENTITY (immutable across variants — describe what is on screen):
    apparent_age_range            e.g. "25-35", "40-55"
    apparent_gender_presentation  one of: female | male | androgynous | unknown
    ethnicity_visual_descriptors  visual descriptors only (e.g. "olive complexion, european features"); never name a nationality you cannot prove from the image
    hair_color                    plain English (e.g. "dark brown", "platinum blonde", "auburn")
    hair_texture                  e.g. "straight", "wavy", "tight curls", "loose curls"
    hair_length_style             e.g. "shoulder-length, parted center", "shaved sides + top knot"
    eye_color                     leave empty string if not clearly visible
    skin_tone_descriptor          e.g. "warm undertone, medium-fair", "cool undertone, deep"
    build                         e.g. "slim athletic", "broad-shouldered", "petite", "tall lean"
    distinctive_features          ARRAY of visible features ONLY: ["scar above left brow", "freckles across nose", "glasses", "visible tattoo on forearm"]. Empty array if none.

  PRESENCE (modulates per beat but anchored — describe baseline visible in the photo):
    posture_baseline              e.g. "open, weight forward", "guarded, weight back, shoulders elevated"
    energy_register               one of: grounded | coiled | effervescent | withdrawn | commanding | soft | guarded
    micro_expression_baseline     e.g. "reserved, neutral mouth, soft eyes", "tight jaw, half smile, eyes alert"
    gaze_quality                  one of: direct | averted | middle_distance | soft_engaged

  CRAFT REGISTER (downstream lens/light routing — best read from the face structure + presence):
    recommended_focal_length_mm   e.g. "85-100" (portrait-heavy register), "35-50" (handheld documentary)
    recommended_lighting_register e.g. "soft wrap, motivated key", "hard key + edge fill", "high-key even fill"

  PROVENANCE:
    vision_confidence             0.0-1.0 — your overall confidence in this entry (low light, profile-only, partial occlusion lower the score)
    low_confidence_fields         ARRAY of field names where you were not sure — e.g. ["eye_color", "ethnicity_visual_descriptors"]. Empty array if all confident.

OUTPUT: ONLY the JSON object. No prose, no markdown, no commentary.`;

function buildUserParts({ photoUrls, persona }) {
  // The persona text fields are PRESENCE HINTS — they help when the photo
  // is ambiguous. The vision pass dominates: any contradiction between text
  // and image, the IMAGE wins.
  const presenceHints = [
    persona?.name && `Provided name (presence hint only): ${persona.name}`,
    persona?.personality && `Provided personality words (presence hint only): ${
      Array.isArray(persona.personality) ? persona.personality.join(', ') : persona.personality
    }`,
    persona?.dramatic_archetype && `Provided archetype (presence hint only): ${persona.dramatic_archetype}`
  ].filter(Boolean).join('\n');

  const headerText = presenceHints
    ? `Examine these reference photographs and return the casting-bible JSON.\n\n${presenceHints}\n\nThe IMAGE is the ground truth — when a presence hint contradicts what you see, the image wins.\n\nReference images:`
    : `Examine these reference photographs and return the casting-bible JSON. The image is the ground truth — describe ONLY what you see.\n\nReference images:`;

  const parts = [{ text: headerText }];
  for (const url of photoUrls) {
    if (typeof url === 'string' && url.length > 0) {
      // Vertex AI Gemini accepts file_data with file_uri for HTTP image URLs.
      // The publisher-bucket Supabase URLs are publicly readable so this works
      // without a separate fetch + base64 inline-data step.
      parts.push({
        file_data: {
          mime_type: _guessMimeType(url),
          file_uri: url
        }
      });
    }
  }
  return parts;
}

function _guessMimeType(url) {
  const lower = String(url || '').toLowerCase();
  if (lower.includes('.png')) return 'image/png';
  if (lower.includes('.webp')) return 'image/webp';
  if (lower.includes('.gif')) return 'image/gif';
  return 'image/jpeg';
}

// ─────────────────────────────────────────────────────────────────────
// Cache key
// ─────────────────────────────────────────────────────────────────────

export function cacheKey(photoUrls) {
  const list = Array.isArray(photoUrls) ? [...photoUrls].filter(Boolean).sort() : [];
  if (list.length === 0) return null;
  return crypto.createHash('sha256').update(list.join('|')).digest('hex').slice(0, 16);
}

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

/**
 * Extract a vision-grounded visual_anchor from one or more reference photos.
 *
 * @param {Object} params
 * @param {string[]} params.photoUrls  - 1-5 publicly-readable image URLs
 * @param {Object}   [params.persona]  - optional persona record (presence hints only — image dominates)
 * @param {string}   [params.source='upload_vision']  - 'upload_vision' | 'sheet_vision' | 'persona_bible_only'
 * @param {Object}   [params.existingAnchor] - if provided AND its vision_call_id matches the cache key, skip re-extraction
 * @returns {Promise<Object>} the visual_anchor record (with provenance fields filled in)
 */
export async function extractPersonaVisualAnchor({ photoUrls, persona = null, source = 'upload_vision', existingAnchor = null } = {}) {
  if (!Array.isArray(photoUrls) || photoUrls.length === 0) {
    throw new Error('extractPersonaVisualAnchor: photoUrls must be a non-empty array');
  }

  // Idempotency — if caller passes an existing anchor AND its vision_call_id
  // matches the current photo set, return it as-is. Re-extraction only happens
  // when the photo set changes.
  const callId = cacheKey(photoUrls);
  if (existingAnchor && existingAnchor.vision_call_id === callId && existingAnchor.apparent_gender_presentation) {
    logger.info(`returning cached anchor (vision_call_id=${callId}, source=${existingAnchor.source})`);
    return existingAnchor;
  }

  logger.info(`extracting visual anchor (photos=${photoUrls.length}, source=${source}, vision_call_id=${callId})`);

  const userParts = buildUserParts({ photoUrls, persona });

  let parsed;
  try {
    parsed = await callVertexGeminiJson({
      systemPrompt: SYSTEM_PROMPT,
      userParts,
      config: {
        temperature: 0.2,
        maxOutputTokens: 4096,
        responseSchema: RESPONSE_SCHEMA,
        thinkingLevel: 'low'
      },
      timeoutMs: 90000
    });
  } catch (err) {
    logger.error(`Vertex Gemini multimodal call failed: ${err.message}`);
    throw new Error(`PersonaVisualAnchor extraction failed: ${err.message}`);
  }

  // Defensive: ensure the schema-required fields are populated. If Gemini
  // returns something structurally incomplete (rare with responseSchema, but
  // possible on truncation / retry), surface a clear error instead of letting
  // a half-baked anchor poison every downstream stage.
  if (!parsed || typeof parsed !== 'object' || !parsed.apparent_gender_presentation) {
    throw new Error('PersonaVisualAnchor: Vertex returned no apparent_gender_presentation — extraction unusable');
  }

  // Normalize / coerce
  const lowConfidence = Array.isArray(parsed.low_confidence_fields) ? parsed.low_confidence_fields : [];
  const distinctive = Array.isArray(parsed.distinctive_features) ? parsed.distinctive_features : [];
  const visionConfidence = Number.isFinite(parsed.vision_confidence)
    ? Math.max(0, Math.min(1, parsed.vision_confidence))
    : 0.5;

  const anchor = {
    // identity
    apparent_age_range:           String(parsed.apparent_age_range || '').trim(),
    apparent_gender_presentation: String(parsed.apparent_gender_presentation || 'unknown').toLowerCase(),
    ethnicity_visual_descriptors: String(parsed.ethnicity_visual_descriptors || '').trim(),
    hair_color:                   String(parsed.hair_color || '').trim(),
    hair_texture:                 String(parsed.hair_texture || '').trim(),
    hair_length_style:            String(parsed.hair_length_style || '').trim(),
    eye_color:                    String(parsed.eye_color || '').trim(),
    skin_tone_descriptor:         String(parsed.skin_tone_descriptor || '').trim(),
    build:                        String(parsed.build || '').trim(),
    distinctive_features:         distinctive.map(f => String(f || '').trim()).filter(Boolean),
    // presence
    posture_baseline:             String(parsed.posture_baseline || '').trim(),
    energy_register:              String(parsed.energy_register || 'grounded').toLowerCase(),
    micro_expression_baseline:    String(parsed.micro_expression_baseline || '').trim(),
    gaze_quality:                 String(parsed.gaze_quality || 'soft_engaged').toLowerCase(),
    // craft register
    recommended_focal_length_mm:  String(parsed.recommended_focal_length_mm || '').trim(),
    recommended_lighting_register: String(parsed.recommended_lighting_register || '').trim(),
    // provenance
    source,
    vision_confidence:            visionConfidence,
    low_confidence_fields:        lowConfidence.map(f => String(f || '').trim()).filter(Boolean),
    vision_call_id:               callId,
    extracted_at:                 new Date().toISOString()
  };

  logger.info(
    `extracted anchor: gender=${anchor.apparent_gender_presentation}, age=${anchor.apparent_age_range}, ` +
    `confidence=${anchor.vision_confidence.toFixed(2)}, low_confidence_fields=${anchor.low_confidence_fields.length}`
  );

  return anchor;
}

/**
 * Render a visual_anchor as a one-line description suitable for storyline
 * persona blocks (replaces the placeholder fallbacks). Per Director Agent's
 * subtractive-storyline-prompt mandate.
 *
 * @param {Object} anchor
 * @returns {string}
 */
export function renderVisualAnchorAsDescription(anchor) {
  if (!anchor || typeof anchor !== 'object' || !anchor.apparent_gender_presentation) {
    // Defense in depth — if for some reason a downstream stage receives a
    // persona without an anchor, refuse to fabricate. Render a clear marker
    // that downstream prompts will treat as an error condition.
    return 'DESCRIPTION_MISSING — persona has no visual_anchor; escalate to user_review';
  }
  const genderWord = {
    female: 'woman',
    male: 'man',
    androgynous: 'androgynous person',
    unknown: 'person'
  }[anchor.apparent_gender_presentation] || 'person';

  const fragments = [
    anchor.apparent_age_range && `${anchor.apparent_age_range}`,
    genderWord
  ];

  if (anchor.ethnicity_visual_descriptors) fragments.push(`(${anchor.ethnicity_visual_descriptors})`);
  if (anchor.hair_color || anchor.hair_length_style) {
    fragments.push(`hair: ${[anchor.hair_color, anchor.hair_length_style].filter(Boolean).join(', ')}`);
  }
  if (anchor.build) fragments.push(`build: ${anchor.build}`);
  if (anchor.distinctive_features?.length > 0) {
    fragments.push(`distinctive: ${anchor.distinctive_features.slice(0, 3).join(', ')}`);
  }
  if (anchor.energy_register) fragments.push(`energy: ${anchor.energy_register}`);
  if (anchor.micro_expression_baseline) fragments.push(`baseline: ${anchor.micro_expression_baseline}`);

  return fragments.filter(Boolean).join(' · ');
}

/**
 * Render a visual_anchor as a HARD CONSTRAINT block for the
 * CharacterSheetDirector / storyline writer system prompts.
 *
 * @param {Object} anchor
 * @returns {string}
 */
export function renderVisualAnchorAsConstraintBlock(anchor) {
  if (!anchor || typeof anchor !== 'object' || !anchor.apparent_gender_presentation) return '';
  const lowConfidenceLine = (anchor.low_confidence_fields || []).length > 0
    ? `\nLOW-CONFIDENCE FIELDS (write AROUND them; do not fabricate): ${anchor.low_confidence_fields.join(', ')}`
    : '';
  return `PERSONA VISUAL TRUTH (extracted from reference photos via vision pass — IS the ground truth, may NOT be contradicted by any subsequent prompt or field):
  apparent_gender_presentation:  ${anchor.apparent_gender_presentation}
  apparent_age_range:            ${anchor.apparent_age_range}
  ethnicity_visual_descriptors:  ${anchor.ethnicity_visual_descriptors}
  hair:                          ${anchor.hair_color} · ${anchor.hair_texture} · ${anchor.hair_length_style}
  eye_color:                     ${anchor.eye_color || '—'}
  skin_tone_descriptor:          ${anchor.skin_tone_descriptor}
  build:                         ${anchor.build}
  distinctive_features:          ${(anchor.distinctive_features || []).join(' | ') || '—'}
  posture_baseline:              ${anchor.posture_baseline}
  energy_register:               ${anchor.energy_register}
  micro_expression_baseline:     ${anchor.micro_expression_baseline}
  gaze_quality:                  ${anchor.gaze_quality}
  recommended_focal_length_mm:   ${anchor.recommended_focal_length_mm || '—'}
  recommended_lighting_register: ${anchor.recommended_lighting_register || '—'}
  vision_confidence:             ${(anchor.vision_confidence ?? 0).toFixed(2)}${lowConfidenceLine}`;
}

/**
 * Compare a persona's visual_anchor against a Gemini-emitted Flux/Seedream
 * prompt to detect identity inversions. Used by CharacterSheetDirector
 * post-emission validation per Director Agent's strict-halt mandate.
 *
 * Returns { ok, inverted_axes: [], severity: 'inversion'|'descriptor_mismatch'|null, evidence: [] }
 *   - 'inversion'           — gender or age range inverted vs anchor (HARD HALT per user 2026-04-29)
 *   - 'descriptor_mismatch' — ethnicity / hair / build mismatch (splice corrective hint, proceed)
 *   - null                  — no detectable mismatch
 *
 * @param {Object} anchor
 * @param {string} fluxPrompt
 * @returns {{ ok: boolean, inverted_axes: string[], severity: string|null, evidence: string[] }}
 */
export function validateFluxPromptAgainstAnchor(anchor, fluxPrompt) {
  if (!anchor || !anchor.apparent_gender_presentation || typeof fluxPrompt !== 'string') {
    return { ok: true, inverted_axes: [], severity: null, evidence: [] };
  }
  const lower = fluxPrompt.toLowerCase();
  const inverted = [];
  const evidence = [];

  // GENDER INVERSION DETECTION
  // We look for OPPOSITE-gender words appearing in the prompt when the anchor
  // is decisive (female/male). Heuristic — words must appear as standalone
  // tokens (word boundaries), not as substrings (avoid "woman" matching "womanly"
  // false-positives across multiple languages).
  const gender = anchor.apparent_gender_presentation;
  if (gender === 'female') {
    const maleMarkers = /\b(man|men|male|gentleman|guy|boy|boys|he|him|his|himself|father|brother|husband|son|sir)\b/g;
    const femaleMarkers = /\b(woman|women|female|lady|girl|girls|she|her|hers|herself|mother|sister|wife|daughter|madam|ma'am)\b/g;
    const maleHits = (lower.match(maleMarkers) || []).length;
    const femaleHits = (lower.match(femaleMarkers) || []).length;
    // Inversion: more male markers than female markers AND at least 2 male markers
    if (maleHits >= 2 && maleHits > femaleHits) {
      inverted.push('gender');
      evidence.push(`anchor=female; prompt contains ${maleHits} male marker(s) vs ${femaleHits} female`);
    }
  } else if (gender === 'male') {
    const maleMarkers = /\b(man|men|male|gentleman|guy|boy|boys|he|him|his|himself|father|brother|husband|son|sir)\b/g;
    const femaleMarkers = /\b(woman|women|female|lady|girl|girls|she|her|hers|herself|mother|sister|wife|daughter|madam|ma'am)\b/g;
    const maleHits = (lower.match(maleMarkers) || []).length;
    const femaleHits = (lower.match(femaleMarkers) || []).length;
    if (femaleHits >= 2 && femaleHits > maleHits) {
      inverted.push('gender');
      evidence.push(`anchor=male; prompt contains ${femaleHits} female marker(s) vs ${maleHits} male`);
    }
  }

  // AGE RANGE INVERSION DETECTION
  // We extract the anchor's lower bound and check whether the prompt names an
  // age-range that's either categorically younger (child/teen) or categorically
  // older (elderly) given the anchor's range. We deliberately do NOT flag
  // small age slips (e.g. anchor 25-35 vs prompt mentions "early 30s").
  const ageRange = String(anchor.apparent_age_range || '').match(/(\d+)\s*[-–]\s*(\d+)/);
  if (ageRange) {
    const lo = parseInt(ageRange[1], 10);
    const hi = parseInt(ageRange[2], 10);
    if (lo >= 25 && /\b(child|kid|toddler|baby|infant|teen|teenager|adolescent)\b/.test(lower)) {
      inverted.push('age');
      evidence.push(`anchor=${lo}-${hi}; prompt invokes child/teen vocabulary`);
    } else if (hi <= 45 && /\b(elderly|old man|old woman|senior|grandfather|grandmother|grandpa|grandma|septuagenarian|octogenarian)\b/.test(lower)) {
      inverted.push('age');
      evidence.push(`anchor=${lo}-${hi}; prompt invokes elderly vocabulary`);
    }
  }

  if (inverted.length > 0) {
    return { ok: false, inverted_axes: inverted, severity: 'inversion', evidence };
  }

  // No inversion detected — caller may still want to splice corrective hints
  // for descriptor-class mismatches, but those don't escalate.
  return { ok: true, inverted_axes: [], severity: null, evidence: [] };
}

/**
 * Custom error class — caller distinguishes inversion-class from generic
 * extraction failures so the orchestrator can route to user_review correctly.
 */
export class VisualAnchorInversionError extends Error {
  constructor(message, { invertedAxes = [], evidence = [] } = {}) {
    super(message);
    this.name = 'VisualAnchorInversionError';
    this.invertedAxes = invertedAxes;
    this.evidence = evidence;
  }
}
