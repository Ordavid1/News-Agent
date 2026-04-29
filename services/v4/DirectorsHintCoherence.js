// services/v4/DirectorsHintCoherence.js
//
// V4 Phase 5b — Director's Hint genre-coherence check.
//
// THE PROBLEM (Director Agent audit, 2026-04-29):
//   The wizard offers the user a free-text "creative direction" field. Users
//   reach for cinematographer references — "Bradford Young's lighting for
//   the shadows", "Roger Deakins arid heat" — that carry a specific craft
//   register (lighting / contrast / lens / pace / palette). When the hint's
//   register conflicts with the active genre register, the storyline writer
//   reaches for the louder voice; downstream layers compound the same wrong
//   register through the LUT picker, scene anchor vocabulary, and Scene Master
//   prompt. Story `77d6eaaf` (logs.txt 2026-04-28): noir-vector hint +
//   commercial genre + hyperreal_premium brief = bs_cool_noir LUT + monoculture
//   noir scene anchors + content-policy 422 on Scene Master.
//
// THE FIX:
//   ONE Vertex Gemini call scores the hint's craft register against the
//   active genre register on five universal axes (lighting / contrast / lens /
//   pace / palette). Returns register_distance (0..1) + conflicting_axes
//   array. When register_distance > 0.5 OR any conflicting_axis matches the
//   genre's `do_nots` from assets/genre-registers/library.json, the hint is
//   flagged. Caller decides: dampen with override directive (silent), prompt
//   user for confirmation, or escalate to user_review.
//
// Generic — vocabulary lives in assets/genre-registers/library.json (data),
// judgment is model-driven (Gemini scores register-distance), conflict axes
// are universal craft dimensions (not genre-specific lists).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import winston from 'winston';
import { callVertexGeminiJson } from './VertexGemini.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) =>
      `[DirectorsHintCoherence] ${timestamp} [${level}]: ${message}`
    )
  ),
  transports: [new winston.transports.Console()]
});

// ─────────────────────────────────────────────────────────────────────
// Genre register loader (mirrors BrandKitLutMatcher pattern)
// ─────────────────────────────────────────────────────────────────────

let GENRE_REGISTER_CACHE = null;

function loadGenreRegisterLibrary() {
  if (GENRE_REGISTER_CACHE) return GENRE_REGISTER_CACHE;
  const libraryPath = path.join(__dirname, '..', '..', 'assets', 'genre-registers', 'library.json');
  try {
    const raw = fs.readFileSync(libraryPath, 'utf-8');
    const parsed = JSON.parse(raw);
    GENRE_REGISTER_CACHE = parsed?.registers || [];
    logger.info(`loaded ${GENRE_REGISTER_CACHE.length} genre register(s)`);
    return GENRE_REGISTER_CACHE;
  } catch (err) {
    logger.warn(`genre register library load failed: ${err.message} — coherence checker will be permissive`);
    GENRE_REGISTER_CACHE = [];
    return GENRE_REGISTER_CACHE;
  }
}

function getGenreRegister(genre) {
  if (!genre) return null;
  const key = String(genre).toLowerCase().trim();
  const all = loadGenreRegisterLibrary();
  return all.find(r => String(r.genre_id || '').toLowerCase().trim() === key) || null;
}

// ─────────────────────────────────────────────────────────────────────
// Coherence schema + system prompt
// ─────────────────────────────────────────────────────────────────────

const RESPONSE_SCHEMA = {
  type: 'object',
  required: ['register_distance', 'conflicting_axes', 'reasoning', 'overall_verdict'],
  properties: {
    register_distance: { type: 'number' },                 // 0..1
    conflicting_axes: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['lighting', 'contrast', 'lens', 'pace', 'palette']
      }
    },
    reasoning: { type: 'string' },
    overall_verdict: {
      type: 'string',
      enum: ['compatible', 'flavor_only', 'conflict', 'antagonistic']
    }
  }
};

const SYSTEM_PROMPT = `You are a cinematographer evaluating whether a director's hint (a free-text creative reference) belongs in the active genre register. You return a JSON verdict.

You compare on FIVE UNIVERSAL CRAFT AXES:
  • lighting     — soft wrap vs hard key vs single-source vs high-key even fill, etc.
  • contrast     — flat doc vs dynamic-range cinematic vs crushed-shadow noir vs blown-highlight commercial
  • lens         — 24-35mm wide vs 50mm naturalistic vs 85-100mm portrait vs anamorphic
  • pace         — montage cutting vs medium pace vs held-frame contemplative
  • palette      — desaturated vs naturalistic skin-led vs saturated punch vs single-color-dominant

Score \`register_distance\` 0..1:
  0.0  — same register; hint is fully compatible
  0.3  — minor flavor difference; hint can be applied on non-conflicting axes
  0.5  — register conflict on 1-2 axes; honor genre register, dampen the hint
  0.8  — antagonistic register; hint and genre cannot be reconciled

Identify \`conflicting_axes\` only when the conflict is real and craft-grounded —
not just because the hint mentions a different word. Bradford Young's "lighting for the shadows"
on a hyperreal_premium commercial = ['lighting', 'contrast', 'palette'] (deep underexposure
+ crushed-shadow noir + desaturated vs high-key + dynamic-range + skin-led).
Roger Deakins arid heat on a thriller/action = [] (compatible — both genres love
oppressive amber midtones + tactical framing).

Provide a one-sentence \`reasoning\` that names the specific craft conflict (or compatibility).
Provide an \`overall_verdict\` enum: compatible | flavor_only | conflict | antagonistic.

OUTPUT: ONLY the JSON object. No prose, no markdown, no commentary.`;

function buildUserPrompt({ hint, genre, register }) {
  const registerSummary = register
    ? [
        `Genre id: ${register.genre_id}`,
        register.display_name && `Display name: ${register.display_name}`,
        register.camera_register?.lighting_motifs &&
          `Lighting motifs: ${register.camera_register.lighting_motifs.join(', ')}`,
        register.camera_register?.typical_lens_mm &&
          `Typical lens: ${register.camera_register.typical_lens_mm}`,
        register.camera_register?.movement_style &&
          `Movement style: ${register.camera_register.movement_style}`,
        Array.isArray(register.lut_recommendations?.preferred) &&
          `Preferred LUTs (palette signal): ${register.lut_recommendations.preferred.join(', ')}`,
        Array.isArray(register.lut_recommendations?.avoid) &&
          `LUT register to AVOID: ${register.lut_recommendations.avoid.join(', ')}`,
        register.pacing_rules?.typical_beat_duration_s &&
          `Typical beat duration: ${register.pacing_rules.typical_beat_duration_s.join('-')}s`,
        Array.isArray(register.do_nots) && register.do_nots.length > 0 &&
          `Genre do_nots: ${register.do_nots.join(' | ')}`
      ].filter(Boolean).join('\n')
    : `(no register profile available for genre="${genre}")`;

  return `DIRECTOR'S HINT (proposed by user):
"${hint}"

ACTIVE GENRE REGISTER:
${registerSummary}

Score the hint's compatibility with this register on the five craft axes (lighting, contrast, lens, pace, palette). Return the JSON verdict.`;
}

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

const DEFAULT_DISTANCE_THRESHOLD = Number(process.env.BRAND_STORY_HINT_REGISTER_DISTANCE_THRESHOLD || '0.5');

/**
 * Validate a director's hint against the active genre register. Returns a
 * verdict the caller can use to dampen, confirm-with-user, or escalate.
 *
 * @param {Object} params
 * @param {string} params.hint
 * @param {string} params.genre
 * @returns {Promise<{
 *   ok: boolean,
 *   register_distance: number,
 *   conflicting_axes: string[],
 *   reasoning: string,
 *   overall_verdict: string,
 *   register_loaded: boolean
 * }>}
 */
export async function validateHintAgainstGenre({ hint, genre } = {}) {
  // Empty hint or no genre → nothing to score; trivially OK.
  if (!hint || typeof hint !== 'string' || !hint.trim()) {
    return {
      ok: true,
      register_distance: 0,
      conflicting_axes: [],
      reasoning: 'no hint provided',
      overall_verdict: 'compatible',
      register_loaded: false
    };
  }
  const register = getGenreRegister(genre);
  if (!register) {
    // No register profile → permissive (legacy stories / unsupported genre).
    logger.info(`no register profile for genre="${genre}" — skipping coherence check (permissive)`);
    return {
      ok: true,
      register_distance: 0,
      conflicting_axes: [],
      reasoning: `no register profile for genre="${genre}" — skipped`,
      overall_verdict: 'compatible',
      register_loaded: false
    };
  }

  const userPrompt = buildUserPrompt({ hint, genre, register });
  let parsed;
  try {
    parsed = await callVertexGeminiJson({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      config: {
        temperature: 0.3,
        maxOutputTokens: 2048,
        responseSchema: RESPONSE_SCHEMA,
        thinkingLevel: 'low'
      },
      timeoutMs: 30000
    });
  } catch (err) {
    // On Gemini failure, default to permissive so we don't block legitimate
    // creative direction over a transient Vertex hiccup. Log loudly so the
    // failure surfaces in production telemetry.
    logger.warn(`Vertex Gemini coherence call failed (${err.message}) — defaulting to permissive`);
    return {
      ok: true,
      register_distance: 0,
      conflicting_axes: [],
      reasoning: `coherence-check failed: ${err.message}`,
      overall_verdict: 'compatible',
      register_loaded: true
    };
  }

  const distance = Number.isFinite(parsed.register_distance)
    ? Math.max(0, Math.min(1, parsed.register_distance))
    : 0;
  const axes = Array.isArray(parsed.conflicting_axes) ? parsed.conflicting_axes : [];
  const verdict = String(parsed.overall_verdict || 'compatible');

  // The hint flags as not-ok when distance crosses the threshold OR the
  // verdict is antagonistic. `flavor_only` and `compatible` always pass.
  const ok = distance < DEFAULT_DISTANCE_THRESHOLD && verdict !== 'antagonistic';

  logger.info(
    `hint coherence: genre=${genre}, distance=${distance.toFixed(2)}, ` +
    `verdict=${verdict}, conflicting_axes=[${axes.join(', ')}], ok=${ok}`
  );

  return {
    ok,
    register_distance: distance,
    conflicting_axes: axes,
    reasoning: String(parsed.reasoning || ''),
    overall_verdict: verdict,
    register_loaded: true
  };
}

/**
 * Render a coherence verdict as a "GENRE OVERRIDE NOTE" block to splice into
 * the storyline system prompt above the director's hint block. Used when the
 * user has NOT explicitly opted in to the conflicting hint (per Fix 5
 * amendment user-confirmed 2026-04-29).
 *
 * When user has explicitly opted in (override flag), this block is skipped
 * entirely and the hint is rendered as-is.
 *
 * @param {Object} verdict
 * @returns {string}
 */
export function renderCoherenceOverrideBlock(verdict) {
  if (!verdict || verdict.ok) return '';
  const axes = (verdict.conflicting_axes || []).join(', ');
  return `\n══════════════════════════════════════════════════════════
GENRE-OVERRIDE NOTE — register-distance ${verdict.register_distance.toFixed(2)} (verdict: ${verdict.overall_verdict})
The director's hint conflicts with the active genre register on these craft axes: [${axes || 'unspecified'}].
Reasoning: ${verdict.reasoning}
HONOR THE GENRE REGISTER. Apply the hint ONLY on the non-conflicting axes (creative flavor — wardrobe accents, character philosophy, scene mood — never lighting/contrast/lens/pace/palette where the conflict lives). The order of authority above this block is binding.
══════════════════════════════════════════════════════════\n`;
}
