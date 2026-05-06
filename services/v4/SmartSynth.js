// services/v4/SmartSynth.js
//
// Robust smart-synthesis module for the V4 Director Agent's retake/halt
// resolution path. Replaces the text-only `_synthesizeEditFromContext` helper
// in BrandStoryService with a properly structured pipeline that:
//
//   1. SEES THE ARTIFACT (multimodal layer) — passes the rejected image/video
//      directly to Gemini as a vision input alongside the persona references
//      that were used in the original render. The synth can therefore write
//      directives grounded in what is *visually wrong* with the artifact vs.
//      the references, not just what the verdict text says.
//
//   2. CARRIES MEMORY ACROSS ATTEMPTS — accepts `priorAttempts` (the synth
//      history for this artifact) and explicitly instructs the model NOT to
//      repeat directives that have already failed. Without this, every
//      retry path produced near-identical synth directives because the
//      verdict findings were near-identical across passes.
//
//   3. DETECTS REGRESSION — if previous attempts show declining scores
//      (e.g. 58 → 45 → 42), surfaces a `regression_warning` flag so the
//      caller can break the loop instead of running yet another retry that
//      will likely regress further.
//
//   4. DEGRADATION CHAIN — multimodal_rich → text_rich → cheap_concat. Any
//      layer can fail (network, MAX_TOKENS, schema parse) and the next
//      layer takes over. The cheap layer is purely deterministic so the
//      caller is guaranteed *some* directive even with Gemini offline.
//
//   5. STRUCTURED OUTPUT — caller gets a single result object with
//      directive, edited_anchor, edited_dialogue, confidence, diagnosis,
//      source, regression_warning, prior_attempt_count. Easy to log,
//      persist, and present in the panel.
//
// Integration:
//   - BrandStoryService Lens B + Lens C auto-retry call this directly.
//   - `synthesizeDirectorReviewEdit` (panel-button path) calls this.
//   - The orchestrator persists each result into `directorReport.synth_history`
//     so subsequent retries / Edit & Retry attempts get the priorAttempts
//     array out of the existing data shape.

import axios from 'axios';
import winston from 'winston';
import { callVertexGeminiJson, isVertexGeminiConfigured } from './VertexGemini.js';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[SmartSynth] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

// ─────────────────────────────────────────────────────────────────────────
// Tunables (env-overridable)
// ─────────────────────────────────────────────────────────────────────────

const MULTIMODAL_BUDGET_TOKENS  = parseInt(process.env.SMART_SYNTH_MULTIMODAL_BUDGET || '16384', 10);
const TEXT_RICH_BUDGET_TOKENS   = parseInt(process.env.SMART_SYNTH_TEXT_BUDGET || '12288', 10);
const SYNTH_TIMEOUT_MS          = parseInt(process.env.SMART_SYNTH_TIMEOUT_MS || '120000', 10);
const SYNTH_TEMPERATURE         = parseFloat(process.env.SMART_SYNTH_TEMPERATURE || '0.5');
const ARTIFACT_FETCH_TIMEOUT_MS = parseInt(process.env.SMART_SYNTH_FETCH_TIMEOUT_MS || '30000', 10);

// Hard caps on returned strings so a runaway model can't blow up downstream
// prompt budgets or DB rows.
const DIRECTIVE_MAX_CHARS = 4000;
const ANCHOR_MAX_CHARS    = 4000;
const DIALOGUE_MAX_CHARS  = 4000;
const DIAGNOSIS_MAX_CHARS = 800;

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

/**
 * Synthesize a director-grade retake directive from a halted artifact.
 *
 * @param {Object} args
 * @param {Object} args.verdict                       - Director verdict (findings + dimension_scores)
 * @param {string} args.checkpoint                    - 'screenplay' | 'scene_master' | 'beat' | 'episode'
 * @param {string} args.artifactId                    - scene_id | beat_id (for logs + payload)
 * @param {string} [args.artifactUrl]                 - Public URL of the rejected image/video — enables multimodal
 * @param {string} [args.artifactMimeType]            - 'image/jpeg' | 'image/png' | 'video/mp4' (defaults inferred)
 * @param {Object} [args.artifactContent]             - Text content of the artifact (anchor, dialogue, etc.)
 * @param {Array<{ url: string, mime?: string, role?: string }>} [args.referenceImages]
 *                                                     - Persona refs / subject refs / scene_master refs that informed the original render
 * @param {Array<Object>} [args.priorAttempts]        - [{directive, edited_anchor?, edited_dialogue?, source, ts, resulting_score?, resulting_verdict?}]
 *                                                     - Synth history for this artifact across previous retries
 * @param {Object} [args.craftContext]                - { lut_id, visual_style_prefix, persona_names, beat_type, genre }
 * @param {string} [args.logPrefix='SmartSynth']      - prefix for logger lines (e.g. include episode_id)
 * @returns {Promise<{
 *   directive: string,
 *   edited_anchor: string|null,
 *   edited_dialogue: string|null,
 *   diagnosis: string|null,
 *   confidence: number|null,
 *   source: 'multimodal_rich' | 'text_rich' | 'cheap_concat',
 *   regression_warning: boolean,
 *   prior_attempt_count: number,
 *   model_latency_ms: number|null,
 *   visible_tokens: number|null,
 *   reference_image_count: number
 * }>}
 */
export async function synthesizeRetakeDirective({
  verdict,
  checkpoint,
  artifactId,
  artifactUrl = null,
  artifactMimeType = null,
  artifactContent = null,
  referenceImages = [],
  priorAttempts = [],
  craftContext = {},
  logPrefix = 'SmartSynth'
} = {}) {
  if (!verdict || typeof verdict !== 'object') {
    throw new Error('synthesizeRetakeDirective: verdict required');
  }
  if (typeof checkpoint !== 'string' || !checkpoint) {
    throw new Error('synthesizeRetakeDirective: checkpoint required');
  }

  const findings = Array.isArray(verdict.findings) ? verdict.findings : [];
  const regressionWarning = _detectRegression(priorAttempts);

  // Cheap layer — always ready as the floor. Pure string composition.
  const cheapDirective = _buildCheapDirective({ findings, checkpoint, artifactId, priorAttempts });

  // No Gemini configured / no findings to work with → return cheap immediately.
  // This still benefits from priorAttempts memory because cheap layer cites
  // them; the caller's panel UX will show "this was the 2nd Edit & Retry".
  if (!isVertexGeminiConfigured() || (findings.length === 0 && priorAttempts.length === 0)) {
    logger.info(`[${logPrefix}] cheap layer (Gemini ${isVertexGeminiConfigured() ? 'configured' : 'NOT configured'}, findings=${findings.length}, priors=${priorAttempts.length})`);
    return _shape({
      source: 'cheap_concat',
      directive: cheapDirective,
      regressionWarning,
      priorAttemptCount: priorAttempts.length
    });
  }

  // Try multimodal first if we have an artifact URL. If that fails (network,
  // MAX_TOKENS, schema parse), fall through to text-rich. If THAT fails, fall
  // through to cheap. Every layer logs the reason for fallthrough so production
  // failures are diagnosable.
  let result = null;

  if (artifactUrl && _isMultimodalEligibleCheckpoint(checkpoint)) {
    try {
      result = await _multimodalLayer({
        verdict, findings, checkpoint, artifactId,
        artifactUrl, artifactMimeType,
        artifactContent, referenceImages,
        priorAttempts, craftContext, logPrefix
      });
      if (result) {
        logger.info(`[${logPrefix}] multimodal layer succeeded (directive=${result.directive.length}ch, refs=${result.reference_image_count}, latency=${result.model_latency_ms}ms, visible_tokens=${result.visible_tokens})`);
        return _shape({
          source: 'multimodal_rich',
          directive: result.directive,
          editedAnchor: result.edited_anchor,
          editedDialogue: result.edited_dialogue,
          diagnosis: result.diagnosis,
          confidence: result.confidence,
          regressionWarning,
          priorAttemptCount: priorAttempts.length,
          modelLatencyMs: result.model_latency_ms,
          visibleTokens: result.visible_tokens,
          referenceImageCount: result.reference_image_count
        });
      }
    } catch (err) {
      logger.warn(`[${logPrefix}] multimodal layer failed (${err.message}) — falling through to text-rich`);
    }
  }

  // Text-rich layer — same payload minus image fetching.
  try {
    result = await _textRichLayer({
      verdict, findings, checkpoint, artifactId,
      artifactContent, priorAttempts, craftContext, logPrefix
    });
    if (result) {
      logger.info(`[${logPrefix}] text-rich layer succeeded (directive=${result.directive.length}ch, latency=${result.model_latency_ms}ms, visible_tokens=${result.visible_tokens})`);
      return _shape({
        source: 'text_rich',
        directive: result.directive,
        editedAnchor: result.edited_anchor,
        editedDialogue: result.edited_dialogue,
        diagnosis: result.diagnosis,
        confidence: result.confidence,
        regressionWarning,
        priorAttemptCount: priorAttempts.length,
        modelLatencyMs: result.model_latency_ms,
        visibleTokens: result.visible_tokens,
        referenceImageCount: 0
      });
    }
  } catch (err) {
    logger.warn(`[${logPrefix}] text-rich layer failed (${err.message}) — falling through to cheap`);
  }

  // Final floor — cheap concat.
  logger.info(`[${logPrefix}] cheap layer (after rich layers exhausted)`);
  return _shape({
    source: 'cheap_concat',
    directive: cheapDirective,
    regressionWarning,
    priorAttemptCount: priorAttempts.length
  });
}

/**
 * Append a synth result to a directorReport's synth_history bucket. Safe to
 * call repeatedly; mutates `directorReport` in place. The bucket schema is:
 *
 *   directorReport.synth_history = {
 *     scene_master: { [sceneId]: [<entry>, ...] },
 *     beat:         { [beatId]:  [<entry>, ...] }
 *   }
 *
 * Where `entry` is a SmartSynth result + metadata (resulting_score is patched
 * back in once the next verdict lands — caller's responsibility).
 */
export function appendSynthHistory({ directorReport, checkpoint, artifactId, synthResult, resultingScore = null, resultingVerdict = null }) {
  if (!directorReport || typeof directorReport !== 'object') return;
  if (!checkpoint || !artifactId || !synthResult) return;

  if (!directorReport.synth_history || typeof directorReport.synth_history !== 'object') {
    directorReport.synth_history = {};
  }
  // V4 Tier 4.1 (2026-05-06) — centralized bucket resolver so 'continuity'
  // (and any future checkpoint) stays in sync across the three persistence
  // helpers.
  const bucketKey = _resolveSynthBucketKey(checkpoint);
  if (!directorReport.synth_history[bucketKey] || typeof directorReport.synth_history[bucketKey] !== 'object') {
    directorReport.synth_history[bucketKey] = {};
  }
  const arr = Array.isArray(directorReport.synth_history[bucketKey][artifactId])
    ? directorReport.synth_history[bucketKey][artifactId]
    : [];

  arr.push({
    directive: synthResult.directive || null,
    edited_anchor: synthResult.edited_anchor || null,
    edited_dialogue: synthResult.edited_dialogue || null,
    diagnosis: synthResult.diagnosis || null,
    source: synthResult.source || 'unknown',
    confidence: synthResult.confidence ?? null,
    regression_warning: !!synthResult.regression_warning,
    prior_attempt_count: synthResult.prior_attempt_count || 0,
    reference_image_count: synthResult.reference_image_count || 0,
    resulting_score: resultingScore,
    resulting_verdict: resultingVerdict,
    ts: new Date().toISOString()
  });
  directorReport.synth_history[bucketKey][artifactId] = arr;
}

/**
 * Read priorAttempts for a given artifact out of a directorReport so callers
 * can pass them into the next synthesizeRetakeDirective call.
 */
export function readSynthHistory({ directorReport, checkpoint, artifactId }) {
  if (!directorReport?.synth_history || !artifactId) return [];
  const bucketKey = _resolveSynthBucketKey(checkpoint);
  const arr = directorReport.synth_history?.[bucketKey]?.[artifactId];
  return Array.isArray(arr) ? arr : [];
}

/**
 * Patch the resulting_score / resulting_verdict back onto the most recent
 * synth_history entry once the next render's verdict lands. This is what
 * powers cross-attempt regression detection.
 */
export function patchSynthOutcome({ directorReport, checkpoint, artifactId, resultingScore, resultingVerdict }) {
  if (!directorReport?.synth_history || !artifactId) return;
  const bucketKey = _resolveSynthBucketKey(checkpoint);
  const arr = directorReport.synth_history?.[bucketKey]?.[artifactId];
  if (!Array.isArray(arr) || arr.length === 0) return;
  const last = arr[arr.length - 1];
  if (resultingScore != null) last.resulting_score = resultingScore;
  if (resultingVerdict != null) last.resulting_verdict = resultingVerdict;
}

// ─────────────────────────────────────────────────────────────────────────
// Internal — multimodal layer
// ─────────────────────────────────────────────────────────────────────────

async function _multimodalLayer({
  verdict, findings, checkpoint, artifactId,
  artifactUrl, artifactMimeType,
  artifactContent, referenceImages,
  priorAttempts, craftContext, logPrefix
}) {
  // ── Fetch the artifact + reference images ──
  const t0 = Date.now();
  const artifactPart = await _fetchAsInlinePart(artifactUrl, artifactMimeType, logPrefix);
  if (!artifactPart) {
    // Couldn't fetch artifact (404, timeout, etc.) — bail out so the caller
    // falls through to the text-rich layer.
    return null;
  }

  // Reference images are best-effort — fetch in parallel, drop any that fail.
  const refParts = [];
  if (Array.isArray(referenceImages) && referenceImages.length > 0) {
    const settled = await Promise.allSettled(
      referenceImages.slice(0, 6).map(ref => _fetchAsInlinePart(ref?.url, ref?.mime, logPrefix))
    );
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value) refParts.push(r.value);
    }
  }
  const refFetchMs = Date.now() - t0;
  logger.info(`[${logPrefix}] multimodal: fetched artifact + ${refParts.length}/${(referenceImages || []).length} ref images in ${refFetchMs}ms`);

  // ── Build the parts array — system label + verdict text + image parts + priors ──
  const userParts = [];

  // Lead with a short instruction part so Gemini knows which image is which.
  userParts.push({ text: _buildMultimodalPreamble({
    checkpoint, artifactId, hasReferences: refParts.length > 0
  })});

  // Artifact image is always FIRST so the model groups subsequent text with it.
  userParts.push({ text: '── REJECTED ARTIFACT (the image/frame the Director scored low) ──' });
  userParts.push(artifactPart);

  if (refParts.length > 0) {
    userParts.push({ text: `── REFERENCE IMAGES (what the artifact was supposed to anchor against — ${refParts.length} provided) ──` });
    for (const p of refParts) userParts.push(p);
  }

  // Verdict + craft context + priors as one structured JSON blob.
  userParts.push({ text: '── DIRECTOR VERDICT + CONTEXT (JSON below) ──' });
  userParts.push({ text: JSON.stringify(_buildVerdictPayload({
    verdict, findings, checkpoint, artifactId,
    artifactContent, priorAttempts, craftContext
  }), null, 2) });

  const t1 = Date.now();
  const parsed = await callVertexGeminiJson({
    systemPrompt: _buildSystemPrompt({ checkpoint, includesImage: true, includesReferences: refParts.length > 0 }),
    userParts,
    config: {
      temperature: SYNTH_TEMPERATURE,
      maxOutputTokens: MULTIMODAL_BUDGET_TOKENS,
      thinkingLevel: 'low'
    },
    timeoutMs: SYNTH_TIMEOUT_MS
  });
  const latency = Date.now() - t1;

  return _normalizeModelResult(parsed, { reference_image_count: refParts.length, model_latency_ms: latency });
}

// ─────────────────────────────────────────────────────────────────────────
// Internal — text-rich layer (no image, just structured JSON payload)
// ─────────────────────────────────────────────────────────────────────────

async function _textRichLayer({
  verdict, findings, checkpoint, artifactId,
  artifactContent, priorAttempts, craftContext, logPrefix
}) {
  const userPayload = _buildVerdictPayload({
    verdict, findings, checkpoint, artifactId,
    artifactContent, priorAttempts, craftContext
  });

  const t0 = Date.now();
  const parsed = await callVertexGeminiJson({
    systemPrompt: _buildSystemPrompt({ checkpoint, includesImage: false, includesReferences: false }),
    userPrompt: JSON.stringify(userPayload),
    config: {
      temperature: SYNTH_TEMPERATURE,
      maxOutputTokens: TEXT_RICH_BUDGET_TOKENS,
      thinkingLevel: 'low'
    },
    timeoutMs: SYNTH_TIMEOUT_MS
  });
  const latency = Date.now() - t0;

  return _normalizeModelResult(parsed, { reference_image_count: 0, model_latency_ms: latency });
}

// ─────────────────────────────────────────────────────────────────────────
// Internal — cheap layer (deterministic concat)
// ─────────────────────────────────────────────────────────────────────────

function _buildCheapDirective({ findings, checkpoint, artifactId, priorAttempts }) {
  const promptDeltas = findings
    .map(f => f?.remediation?.prompt_delta)
    .filter(s => typeof s === 'string' && s.trim().length > 0);
  const messages = findings
    .map(f => f && f.message ? `- [${f.severity || 'note'}] ${f.message}` : null)
    .filter(Boolean)
    .join('\n');

  const lines = [];
  lines.push(`Director-flagged issues at Lens ${checkpoint}${artifactId ? ` (${artifactId})` : ''}:`);
  if (messages) lines.push(messages);
  if (promptDeltas.length > 0) {
    lines.push('');
    lines.push('Apply these corrective directives to the next render:');
    promptDeltas.forEach((d, i) => lines.push(`${i + 1}. ${d}`));
  } else if (!messages) {
    lines.push('(Director halted with no specific findings — re-run with care.)');
  }

  if (priorAttempts.length > 0) {
    const failedDirectives = priorAttempts
      .map(p => p?.directive)
      .filter(s => typeof s === 'string' && s.trim().length > 0)
      .slice(-3);
    if (failedDirectives.length > 0) {
      lines.push('');
      lines.push(`PRIOR ATTEMPTS (${priorAttempts.length} total) — DO NOT REPEAT these directives, they failed:`);
      failedDirectives.forEach((d, i) => lines.push(`${i + 1}. ${d.slice(0, 200)}${d.length > 200 ? '…' : ''}`));
    }
  }

  return lines.join('\n').slice(0, DIRECTIVE_MAX_CHARS);
}

// ─────────────────────────────────────────────────────────────────────────
// Internal — payload + prompt builders
// ─────────────────────────────────────────────────────────────────────────

function _buildSystemPrompt({ checkpoint, includesImage, includesReferences }) {
  const lines = [
    'You are a film DIRECTOR resolving a halted V4 brand-story pipeline.',
    'The Director Agent (Lens A/B/C/D rubric) flagged a halt at the checkpoint below.',
    'Your job: synthesize ONE sharp, generator-actionable retake directive that addresses the CRITICAL findings.',
    ''
  ];

  if (includesImage) {
    lines.push('You can SEE the rejected artifact (image/frame).');
    if (includesReferences) {
      lines.push('You can also SEE the reference images that the artifact was supposed to anchor against.');
      lines.push('Compare the artifact to the references and identify the actual visual gap (composition, lighting, identity, framing, persona likeness, scene mood).');
    } else {
      lines.push('Look at the rejected image itself and identify the actual visual gap (composition, lighting, framing, mood).');
    }
    lines.push('Ground your directive in what you SEE — not just what the verdict text says.');
    lines.push('');
  }

  lines.push('Output ONLY a JSON object with this exact shape (no markdown, no code fences, no prose outside the JSON):');
  lines.push('{');
  lines.push('  "diagnosis": "<1-2 sentences in plain language describing what went wrong on this attempt — start with the most likely root cause>",');
  lines.push('  "directive": "<2-5 sentences, generator-actionable, sharp directorial language; combines the most important findings into ONE coherent retake note. AVOID repeating directives that already failed (see prior_attempts)>",');

  if (checkpoint === 'scene_master' || checkpoint === 'commercial_scene_master') {
    lines.push('  "edited_anchor": "<a complete rewrite of scene_visual_anchor_prompt that resolves the flagged issues — drop-in replacement for the original>",');
    lines.push('  "edited_dialogue": null,');
  } else if (checkpoint === 'beat' || checkpoint === 'commercial_beat') {
    lines.push('  "edited_anchor": null,');
    lines.push('  "edited_dialogue": "<rewrite of beat dialogue ONLY if dialogue is the primary failure mode; null otherwise>",');
  } else if (checkpoint === 'continuity') {
    // V4 Tier 4.1 (2026-05-06) — Lens E. The directive must be a CONTINUITY
    // FIX directive that the next render of the failing beat will splice
    // into its prompt as a director_nudge. Anchor + dialogue rewrites are
    // NOT in scope here; the structural fix is anchored at the prompt-
    // language level (e.g. "match the lighting key direction from the
    // previous beat's window-left key", "actor's coffee cup must remain in
    // left hand from prior beat", "preserve the screen-direction of motion
    // — subject exited frame-right, must enter frame-left").
    lines.push('  "edited_anchor": null,');
    lines.push('  "edited_dialogue": null,');
  } else {
    lines.push('  "edited_anchor": null,');
    lines.push('  "edited_dialogue": null,');
  }

  lines.push('  "confidence": <0.0-1.0 — your self-assessed probability the directive will pass on retake>');
  lines.push('}');
  lines.push('');
  lines.push('Constraints:');
  lines.push('- Address every CRITICAL finding (do not drop any).');
  lines.push('- Use cinematography vocabulary when relevant: lens, blocking, composition, light direction, performance, framing, color temperature.');
  lines.push('- DO NOT invent unrelated craft directions; stay focused on what the verdict flagged.');
  lines.push('- Edited anchor/dialogue MUST be drop-in replacements for the originals.');
  lines.push('- If priorAttempts are present, your directive MUST be MATERIALLY DIFFERENT from theirs — do not just rephrase a previously-failed directive.');
  lines.push('- If priorAttempts show declining scores (regression_warning=true), be conservative — the system is over-correcting; back OFF aggressive directives and target ONLY the most critical finding.');

  return lines.join('\n');
}

function _buildMultimodalPreamble({ checkpoint, artifactId, hasReferences }) {
  // V4 Tier 4.1 (2026-05-06) — `continuity` checkpoint sends TWO artifacts
  // (prev endframe = "what should match" + current endframe = "what
  // drifted"). The preamble explicitly labels the comparison so Gemini
  // grounds the directive in the visual delta between the two frames,
  // not just the verdict text.
  if (checkpoint === 'continuity') {
    return [
      `── HALT CONTEXT ── checkpoint=continuity artifact_id=${artifactId}`,
      '',
      'You will see TWO artifacts below:',
      '  • PREVIOUS BEAT ENDFRAME — the frame the chain SHOULD continue from. The lighting, props, wardrobe, screen-direction at this frame are the BASELINE.',
      '  • CURRENT BEAT ENDFRAME — the frame that DRIFTED. The Lens E continuity supervisor scored this pair as breaking continuity.',
      '',
      `${hasReferences ? 'Reference images (scene master / persona refs) follow as context.' : ''}`,
      'Compare the two endframes side by side. Identify the SPECIFIC continuity break (wardrobe drift / prop missing / lighting key flipped / screen-direction reversed / eyeline inconsistency / color temperature shift). Then write a directive that the NEXT render of the current beat will splice into its prompt as a director_nudge — addressing the SPECIFIC drift you see between the two frames.',
      'Your directive must be specific to the visual gap between the two endframes — not a generic restatement of the verdict.'
    ].join('\n');
  }
  return [
    `── HALT CONTEXT ── checkpoint=${checkpoint} artifact_id=${artifactId}`,
    '',
    `You will see ${hasReferences ? 'the rejected artifact AND its reference images' : 'the rejected artifact image'} below, then the Director verdict + context as JSON.`,
    'Compare what is in the rejected image to what was REQUESTED (verdict + anchor) and to the references (if any).',
    'Your directive must be specific to the visual gap you see — not a generic restatement of the verdict.'
  ].join('\n');
}

function _buildVerdictPayload({
  verdict, findings, checkpoint, artifactId,
  artifactContent, priorAttempts, craftContext
}) {
  const regressionWarning = _detectRegression(priorAttempts);
  return {
    checkpoint,
    artifact_id: artifactId,
    verdict_score: verdict?.overall_score ?? null,
    verdict_kind: verdict?.verdict ?? null,
    findings: findings.map(f => ({
      id: f?.id || null,
      severity: f?.severity || 'note',
      dimension: f?.dimension || null,
      message: f?.message || '',
      evidence: f?.evidence || null,
      remediation_hint: f?.remediation?.prompt_delta || null,
      target: f?.remediation?.target || null
    })),
    dimension_scores: verdict?.dimension_scores || null,
    artifact: artifactContent || null,
    craft_context: craftContext || null,
    prior_attempts: (priorAttempts || []).slice(-5).map(p => ({
      directive: p?.directive ? String(p.directive).slice(0, 600) : null,
      edited_anchor_was_present: !!p?.edited_anchor,
      edited_dialogue_was_present: !!p?.edited_dialogue,
      source: p?.source || null,
      resulting_score: p?.resulting_score ?? null,
      resulting_verdict: p?.resulting_verdict ?? null,
      ts: p?.ts || null
    })),
    regression_warning: regressionWarning
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Internal — utilities
// ─────────────────────────────────────────────────────────────────────────

function _isMultimodalEligibleCheckpoint(checkpoint) {
  // Screenplay halts have no rendered artifact yet — text-only synth is correct.
  // Episode halts have a video, but pulling a 30-90s mp4 into the synth call
  // is expensive; that path stays text-only for now (Lens D has its own
  // reassemble route). Scene_master, beat, and continuity halts are the
  // multimodal targets.
  //
  // V4 Tier 4.1 (2026-05-06) — `continuity` added. Lens E sends two
  // artifacts (prev endframe + current endframe) so it benefits from
  // the multimodal layer even more than Lens C: the model can SEE both
  // ends of the broken chain.
  return checkpoint === 'scene_master'
      || checkpoint === 'commercial_scene_master'
      || checkpoint === 'beat'
      || checkpoint === 'commercial_beat'
      || checkpoint === 'continuity';
}

/**
 * V4 Tier 4.1 (2026-05-06) — bucket-key resolver. Centralizes the
 * checkpoint → synth_history bucket mapping so appendSynthHistory,
 * readSynthHistory, and patchSynthOutcome stay in sync as new
 * checkpoints are added.
 */
function _resolveSynthBucketKey(checkpoint) {
  if (checkpoint === 'scene_master' || checkpoint === 'commercial_scene_master') return 'scene_master';
  if (checkpoint === 'beat' || checkpoint === 'commercial_beat') return 'beat';
  if (checkpoint === 'continuity') return 'continuity';
  return checkpoint;
}

async function _fetchAsInlinePart(url, mimeOverride, logPrefix) {
  if (!url || typeof url !== 'string') return null;
  try {
    const resp = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: ARTIFACT_FETCH_TIMEOUT_MS,
      maxContentLength: 50 * 1024 * 1024,  // 50MB hard ceiling — refuse to encode larger payloads
      validateStatus: (s) => s >= 200 && s < 300
    });
    const mime = mimeOverride || resp.headers?.['content-type'] || _inferMimeFromUrl(url);
    if (!mime || !/^(image|video)\//.test(mime)) {
      logger.warn(`[${logPrefix}] _fetchAsInlinePart: unsupported mime "${mime}" for ${url}`);
      return null;
    }
    return {
      inline_data: {
        mime_type: mime.split(';')[0].trim(),
        data: Buffer.from(resp.data).toString('base64')
      }
    };
  } catch (err) {
    logger.warn(`[${logPrefix}] _fetchAsInlinePart failed for ${url}: ${err.message}`);
    return null;
  }
}

function _inferMimeFromUrl(url) {
  const lower = url.toLowerCase().split('?')[0];
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.webm')) return 'video/webm';
  return null;
}

/**
 * A retry path is regressing if the most recent N attempts show STRICTLY
 * declining resulting_score (each newer attempt scored lower than the
 * previous). Two consecutive declines is enough to flag — three is the
 * production pattern from logs.txt 2026-05-06 (58 → 45 → 42).
 */
function _detectRegression(priorAttempts) {
  if (!Array.isArray(priorAttempts) || priorAttempts.length < 2) return false;
  const scores = priorAttempts
    .map(p => Number(p?.resulting_score))
    .filter(s => Number.isFinite(s));
  if (scores.length < 2) return false;
  // Check the last 3 (or fewer) for monotonic decline.
  const window = scores.slice(-3);
  for (let i = 1; i < window.length; i++) {
    if (window[i] >= window[i - 1]) return false;
  }
  return window.length >= 2;
}

/**
 * Validate + clean the model's parsed output. Returns null if the output is
 * unusable (caller falls through to next layer).
 */
function _normalizeModelResult(parsed, extras = {}) {
  if (!parsed || typeof parsed !== 'object') return null;
  const directive = typeof parsed.directive === 'string' ? parsed.directive.trim() : '';
  if (directive.length === 0) return null;

  const editedAnchor = typeof parsed.edited_anchor === 'string' && parsed.edited_anchor.trim()
    ? parsed.edited_anchor.trim().slice(0, ANCHOR_MAX_CHARS)
    : null;
  const editedDialogue = typeof parsed.edited_dialogue === 'string' && parsed.edited_dialogue.trim()
    ? parsed.edited_dialogue.trim().slice(0, DIALOGUE_MAX_CHARS)
    : null;
  const diagnosis = typeof parsed.diagnosis === 'string' && parsed.diagnosis.trim()
    ? parsed.diagnosis.trim().slice(0, DIAGNOSIS_MAX_CHARS)
    : null;
  const confidence = Number.isFinite(parsed.confidence)
    ? Math.max(0, Math.min(1, Number(parsed.confidence)))
    : null;

  return {
    directive: directive.slice(0, DIRECTIVE_MAX_CHARS),
    edited_anchor: editedAnchor,
    edited_dialogue: editedDialogue,
    diagnosis,
    confidence,
    reference_image_count: extras.reference_image_count || 0,
    model_latency_ms: extras.model_latency_ms ?? null,
    visible_tokens: extras.visible_tokens ?? null
  };
}

/**
 * Final result-shaping helper so every code path returns the same shape.
 */
function _shape({
  source, directive,
  editedAnchor = null, editedDialogue = null,
  diagnosis = null, confidence = null,
  regressionWarning = false, priorAttemptCount = 0,
  modelLatencyMs = null, visibleTokens = null,
  referenceImageCount = 0
}) {
  return {
    directive: (directive || '').slice(0, DIRECTIVE_MAX_CHARS),
    edited_anchor: editedAnchor ? String(editedAnchor).slice(0, ANCHOR_MAX_CHARS) : null,
    edited_dialogue: editedDialogue ? String(editedDialogue).slice(0, DIALOGUE_MAX_CHARS) : null,
    diagnosis: diagnosis ? String(diagnosis).slice(0, DIAGNOSIS_MAX_CHARS) : null,
    confidence,
    source,
    regression_warning: regressionWarning,
    prior_attempt_count: priorAttemptCount,
    model_latency_ms: modelLatencyMs,
    visible_tokens: visibleTokens,
    reference_image_count: referenceImageCount
  };
}
