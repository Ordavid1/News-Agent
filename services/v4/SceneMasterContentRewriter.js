// services/v4/SceneMasterContentRewriter.js
//
// V4 Phase 5b — Fix 9 + N4 (Tier 2 of the 5-tier Scene Master content-policy chain).
//
// THE FAILURE MODE (Director Agent audit, 2026-04-29):
//   Seedream's content filter refused story `77d6eaaf` scene 2's prompt
//   ("pitch black + Apple logo + Space Black chassis"). The surveillance
//   regex (Tier 0) didn't match this content category → bubbled the error.
//   The pipeline silently set scene_master_url=null and shipped a 6-of-8 cut
//   with the cliffhanger missing.
//
// THE FIX:
//   When Tier 1 (anchor-rewrite via Director finding) fails (or is unavailable),
//   THIS service is Tier 2 — a generic Gemini-authored rewrite that operates
//   on craft principles (replace trademarks with design language, replace
//   extremes with motivated practical sources). NO HARDCODED brand wordlist
//   per CLAUDE.md ground rule.
//
//   The rewrite is generic — it recognizes brand surfaces and lighting
//   extremes at the rule level, not via lookup. Adding a new brand to the
//   pipeline requires zero code changes here.

import winston from 'winston';
import { callVertexGeminiText } from './VertexGemini.js';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) =>
      `[SceneMasterContentRewriter] ${timestamp} [${level}]: ${message}`
    )
  ),
  transports: [new winston.transports.Console()]
});

// Director-authored generic rewrite system prompt (verbatim per the audit).
const REWRITE_SYSTEM_PROMPT = `You are a cinematographer rewriting an image-generation prompt that a content filter rejected. Preserve the scene's emotional intent, geography, and lighting direction.

Apply these CRAFT-PRINCIPLED rewrites (no hardcoded vocabulary — operate on the rules):

(a) BRAND / TRADEMARK SURFACES — Replace any explicit trademark or brand-name reference with the underlying VISIBLE DESIGN LANGUAGE (materials, silhouette, signature color, bezel curve, chamfer, finish). Never the registered name.
    Example transformations (illustrative, not exhaustive):
      "Apple logo" → "the brand's signature minimal etched icon"
      "MacBook Pro" → "a slim aluminum laptop with a chamfered edge"
      "Coca-Cola can" → "a contoured red beverage can with curved silhouette"

(b) ABSOLUTE LIGHTING EXTREMES — Replace any absolute lighting extreme ("pitch black", "completely white", "pure void") with a MOTIVATED PRACTICAL SOURCE describing the light's origin AND fall-off.
    Example transformations:
      "pitch black room" → "darkened room lit only by the screen glow falling off into shadow at the edges"
      "completely white background" → "high-key seamless backdrop with soft fall-off to neutral gray at frame edges"
      "pure void" → "deep negative space with motivated practical light from a single off-camera source"

(c) PRESERVATION CONTRACT — Keep the persona's wardrobe anchor, lens choice, lens movement, and composition VERBATIM. Do not edit those.

OUTPUT: ONLY the rewritten prompt as a single block of text. No prose, no markdown, no commentary, no headers.`;

/**
 * Rewrite a Scene Master prompt that Seedream rejected to satisfy generic
 * content-policy constraints while preserving the cinematographer's intent.
 *
 * @param {Object} params
 * @param {string} params.prompt - the original (failed) Scene Master prompt
 * @param {string} [params.sanitizedPrompt] - the Tier 0 surveillance-sanitized prompt (if any) — used as alternative input when present
 * @param {string} [params.label] - observability label
 * @returns {Promise<string>} the rewritten prompt
 */
export async function rewriteAnchorForContentPolicy({ prompt, sanitizedPrompt = '', label = 'scene master' } = {}) {
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('rewriteAnchorForContentPolicy: prompt is required');
  }

  // Use the sanitized version as input when it differs (Tier 0 already
  // softened some surveillance vocab; the rewriter starts from there).
  const input = sanitizedPrompt && sanitizedPrompt !== prompt ? sanitizedPrompt : prompt;

  logger.info(`${label}: Tier 2 — Gemini-rewriting Scene Master prompt (input ${input.length} chars)`);

  let rewritten;
  try {
    rewritten = await callVertexGeminiText({
      systemPrompt: REWRITE_SYSTEM_PROMPT,
      userPrompt: `ORIGINAL PROMPT TO REWRITE (rejected by content filter):\n\n${input}\n\nRewrite per the rules. Preserve emotional intent, geography, and lighting direction. Replace trademarks with design language; replace lighting extremes with motivated practical sources.`,
      config: {
        temperature: 0.4,
        maxOutputTokens: 2048,
        modelId: process.env.GEMINI_MODEL || 'gemini-3-flash-preview'
      },
      timeoutMs: 30000
    });
  } catch (err) {
    logger.error(`${label}: Tier 2 Gemini rewrite call failed: ${err.message}`);
    throw new Error(`SceneMasterContentRewriter (Tier 2) failed: ${err.message}`);
  }

  const result = String(rewritten || '').trim();
  if (!result || result.length < 20) {
    throw new Error('SceneMasterContentRewriter (Tier 2): Gemini returned no rewrite');
  }

  logger.info(`${label}: Tier 2 rewrite complete (${result.length} chars, diff vs input=${result !== input})`);
  return result;
}
