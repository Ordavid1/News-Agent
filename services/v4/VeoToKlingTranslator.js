// services/v4/VeoToKlingTranslator.js
// V4 Phase 11 (2026-05-07) — Veo→Kling prompt translator on fallback.
//
// PROBLEM: When Veo refuses a beat (content filter persistent, post-2026-05-06
// fallback policy with skipTextOnlyFallback=true), the orchestrator routes to
// Kling V3 Pro via BaseBeatGenerator._fallbackToKlingForVeoFailure(). Each
// caller (BRoll, Reaction, Insert, Bridge, etc.) already builds a "Kling-
// friendly" prompt variant before that call — but these variants are
// LIGHTLY-edited Veo prompts. They still use Veo's vocabulary:
//
//   - Veo's lens-prose grammar ("Lens 35-50mm, kinetic handheld feel,
//     shallow DOF on the subject in motion") — Kling parses this loosely
//   - Veo's first/last-frame momentum cues ("Frame 1 opens mid-motion;
//     momentum continues forward") — Kling has NO frame-anchoring; these
//     are dead text
//   - Veo's atmospheric prose ("blue hour, single tungsten practical from
//     camera left, dust motes drift") — Kling responds better to action-verb
//     phrasing ("dust drifts in tungsten light, blue hour register")
//
// The result, per Director Agent's prestige review: when one beat is rendered
// by Veo and the next falls back to Kling, viewers detect the mid-episode
// "different cinematographer" within 4 frames because the prompt grammar
// produced a different lens character + motion register.
//
// FIX: A lightweight mechanical translator that re-shapes Veo-grammar prose
// into Kling-grammar action-led syntax. No LLM call by default — pure string
// transformation. Optionally, behind V4_VEO_TO_KLING_GEMINI_TRANSLATE=true,
// run a Gemini Flash semantic-translation pass (~$0.0003/call, cached).
//
// PRINCIPLES:
//   - Never block. Translation failures fall through to the original prompt.
//   - Cache by hash of (prompt + beat_type) to avoid re-translating identical
//     prompts on subsequent retries.
//   - Mechanical pass (default) is deterministic and free; LLM pass is
//     opt-in for prestige episodes where the small cost is justified.

import crypto from 'crypto';
import winston from 'winston';
import { callVertexGeminiText, isVertexGeminiConfigured } from './VertexGemini.js';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) =>
      `[VeoToKlingTranslator] ${timestamp} [${level}]: ${message}`
    )
  ),
  transports: [new winston.transports.Console()]
});

// Module-scoped LRU-ish cache. Keyed on hash(prompt + beatType + mode).
// Bounded to 200 entries to prevent unbounded growth on long-running processes.
const TRANSLATION_CACHE = new Map();
const TRANSLATION_CACHE_MAX = 200;

function _cacheKey(prompt, beatType, mode) {
  return crypto
    .createHash('sha1')
    .update(`${mode}|${beatType}|${prompt}`)
    .digest('hex');
}

function _cacheGet(key) {
  if (!TRANSLATION_CACHE.has(key)) return null;
  // Refresh recency (Map preserves insertion order)
  const value = TRANSLATION_CACHE.get(key);
  TRANSLATION_CACHE.delete(key);
  TRANSLATION_CACHE.set(key, value);
  return value;
}

function _cacheSet(key, value) {
  if (TRANSLATION_CACHE.size >= TRANSLATION_CACHE_MAX) {
    // Evict oldest
    const oldest = TRANSLATION_CACHE.keys().next().value;
    if (oldest) TRANSLATION_CACHE.delete(oldest);
  }
  TRANSLATION_CACHE.set(key, value);
}

/**
 * Mechanical Veo→Kling grammar translation.
 *
 * No LLM call. Pure string transformation that:
 *   1. Strips Veo-only phrases (frame-anchoring momentum, "skipTextOnlyFallback"
 *      side-effects, etc.) that are dead text in Kling.
 *   2. Reformats prose lens descriptions ("Lens 35-50mm, kinetic handheld
 *      feel") into Kling-leaner format ("35-50mm handheld").
 *   3. Promotes vertical-framing directives to a single canonical Kling line.
 *   4. Preserves all DP / scene-anchor / continuity / brand directives intact
 *      (Kling reads them well — they don't need translation).
 *
 * @param {string} veoPrompt - the Veo-grammar prompt that the caller built
 * @returns {string} the Kling-friendly variant
 */
function _mechanicalTranslate(veoPrompt) {
  if (typeof veoPrompt !== 'string' || veoPrompt.length === 0) return '';
  let out = veoPrompt;

  // 1. Strip Veo-only frame-anchoring momentum phrases (dead text in Kling)
  const veoFrameAnchorPhrases = [
    /Frame 1 opens mid-motion;\s*momentum continues forward\.\s*NOT a static start\.?\s*/gi,
    /Frame 1 opens mid-motion;\s*momentum continues forward\.\s*/gi,
    /Veo first-frame anchored to the scene endframe;\s*last-frame hint is the next scene's master\.?\s*/gi,
    /Veo first-frame anchored to[^.]*\.\s*/gi
  ];
  for (const re of veoFrameAnchorPhrases) {
    out = out.replace(re, '');
  }

  // 2. Compress prose lens descriptions. Kling parses lens hints best in
  // compact "<focal>mm <quality>" form rather than Veo's narrative prose.
  out = out.replace(
    /Lens (\d+(?:-\d+)?)mm,\s*kinetic handheld feel,\s*shallow DOF on the subject in motion\.?/gi,
    '$1mm handheld, shallow DOF.'
  );
  out = out.replace(
    /Lens (\d+(?:-\d+)?)mm,\s*locked-off,\s*shallow DOF\.?/gi,
    '$1mm locked, shallow DOF.'
  );

  // 3. Vertical directive consolidation. Many Veo prompts include verbose
  // 100+ char vertical directives. Kling understands a short canonical line.
  out = out.replace(
    /VERTICAL 9:16[^.]+\.\s*Eyes upper third,\s*chin lower third,\s*face fills vertical[^.]*\.\s*No letterbox\.?/gi,
    'Vertical 9:16 portrait, face fills frame, no letterbox.'
  );
  out = out.replace(
    /VERTICAL 9:16\.\s*Kinetic action along vertical axis \(tilt\/crane\),\s*vertical blocking\.\s*No horizontal wide composition\.?/gi,
    'Vertical 9:16, kinetic vertical blocking, no horizontal wide.'
  );

  // 4. Squash redundant whitespace introduced by the strips above.
  out = out.replace(/\s{2,}/g, ' ').replace(/\s+\./g, '.').trim();

  // Append a single explicit Kling motion grammar cue if not already present.
  // Kling responds best when prompts END with the action verb — pull it
  // forward subtly so the model knows what to render kinetically.
  // (No-op if the prompt already starts with Kling-flavored verbs.)
  return out;
}

/**
 * Optional Gemini Flash semantic translation. Used only when
 * V4_VEO_TO_KLING_GEMINI_TRANSLATE=true. Adds ~$0.0003 / call latency ~1-3s.
 *
 * @returns {Promise<string|null>} the translated prompt, or null on failure
 */
async function _geminiTranslate(veoPrompt, beatType, logPrefix) {
  if (!isVertexGeminiConfigured()) return null;
  const systemPrompt = [
    'You are a prompt-engineering specialist who translates video-generator prompts between two specific models with different grammars.',
    'INPUT: a prompt authored for Google Veo 3.1 (which uses prose-rich first-frame-anchored grammar).',
    'OUTPUT: the SAME shot description re-shaped for Kling V3 Pro\'s grammar.',
    '',
    'Kling V3 Pro grammar preferences:',
    '  • Action-verb led, present-tense ("hand reaches", "camera drifts left")',
    '  • Compact lens spec ("85mm shallow DOF" not "Lens 85mm with shallow depth of field")',
    '  • Explicit motion vector tokens ("push in", "rack focus", "static hold")',
    '  • Element-anchor friendly (no "first frame" / "last frame" references)',
    '  • Vertical directive: "Vertical 9:16, [composition cue]" — short',
    '',
    'PRESERVE EXACTLY:',
    '  • Any block prefixed with `## ` (DP directive, continuity from previous beat, scene look)',
    '  • Any DIRECTOR\'S NOTE (retake): line',
    '  • Persona names, dialogue, brand names',
    '  • Any "Continue from prior beat (...)" line',
    '',
    'STRIP:',
    '  • "Frame 1 opens..." momentum cues (Kling has no frame anchoring)',
    '  • "Veo first-frame anchored..." references',
    '  • Verbose vertical directives — replace with one short line',
    '',
    'Return ONLY the translated prompt. No prose explanation. No markdown wrappers.'
  ].join('\n');
  const userPrompt = `BEAT TYPE: ${beatType}\n\nVEO PROMPT:\n${veoPrompt}\n\nKLING-GRAMMAR EQUIVALENT:`;

  try {
    const result = await callVertexGeminiText({
      systemPrompt,
      userPrompt,
      config: {
        temperature: 0.3,
        maxOutputTokens: 1500,
        thinkingLevel: 'minimal'
      },
      timeoutMs: 20000
    });
    if (typeof result === 'string' && result.trim().length > 0) {
      return result.trim();
    }
    return null;
  } catch (err) {
    logger.warn(`[${logPrefix}] Gemini translation failed (${err.message}) — falling through to mechanical translation`);
    return null;
  }
}

/**
 * Translate a Veo-grammar prompt into a Kling-friendly variant.
 *
 * @param {Object} params
 * @param {string} params.prompt   - the Veo-grammar prompt
 * @param {string} [params.beatType] - the beat type (for cache key + Gemini context)
 * @param {string} [params.logPrefix] - log tag (typically beat_id)
 * @returns {Promise<string>} the Kling-friendly prompt
 */
export async function translateVeoPromptToKling({ prompt, beatType = 'unknown', logPrefix = '' } = {}) {
  if (typeof prompt !== 'string' || prompt.length === 0) return '';

  const useGemini = String(process.env.V4_VEO_TO_KLING_GEMINI_TRANSLATE || 'false').toLowerCase() === 'true';
  const mode = useGemini ? 'gemini' : 'mechanical';
  const cacheKey = _cacheKey(prompt, beatType, mode);

  const cached = _cacheGet(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Mechanical translation always runs first — it's free and handles 80% of
  // the grammar mismatch (frame-anchoring strips, lens compression, vertical
  // squashing). Gemini layer (if enabled) refines from there.
  const mechanical = _mechanicalTranslate(prompt);

  let result = mechanical;
  if (useGemini) {
    const llmTranslated = await _geminiTranslate(mechanical, beatType, logPrefix || beatType);
    if (llmTranslated) {
      result = llmTranslated;
    }
  }

  _cacheSet(cacheKey, result);

  if (mechanical !== prompt) {
    const ratio = ((mechanical.length / prompt.length) * 100).toFixed(0);
    logger.info(
      `[${logPrefix || beatType}] Veo→Kling translation (${mode}): ` +
      `${prompt.length}→${result.length} chars (${ratio}% of original)`
    );
  }
  return result;
}

// Exported for tests + introspection.
export const _internals = {
  _mechanicalTranslate,
  _cacheKey,
  TRANSLATION_CACHE
};

export default { translateVeoPromptToKling, _internals };
