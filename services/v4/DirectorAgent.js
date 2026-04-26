// services/v4/DirectorAgent.js
//
// V4 Layer-3 craft critic. Wraps Vertex AI Gemini multimodal calls with
// the per-checkpoint rubrics from director-rubrics/. Returns verdict JSON
// per the §7 contract (mechanically enforced by responseSchema).
//
// Sits ABOVE L1 ScreenplayValidator + L2 ScreenplayDoctor + QC8 QualityGate.
// Judges only what requires a director's taste — see lens rubrics for scope.
//
// Operational mode: shadow / blocking / off, controlled by env flags read
// at the orchestrator level (BrandStoryService.runV4Pipeline). This service
// is mode-agnostic — it always returns a verdict; the caller decides whether
// to act on it.

import winston from 'winston';
import { callVertexGeminiJson, isVertexGeminiConfigured } from './VertexGemini.js';
import {
  SCREENPLAY_VERDICT_SCHEMA,
  SCENE_MASTER_VERDICT_SCHEMA,
  BEAT_VERDICT_SCHEMA,
  EPISODE_VERDICT_SCHEMA
} from './director-rubrics/verdictSchema.mjs';
import { buildScreenplayJudgePrompt } from './director-rubrics/screenplayRubric.mjs';
import { buildSceneMasterJudgePrompt } from './director-rubrics/sceneMasterRubric.mjs';
import { buildBeatJudgePrompt } from './director-rubrics/beatRubric.mjs';
import { buildEpisodeJudgePrompt } from './director-rubrics/episodeRubric.mjs';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `[DirectorAgent] ${timestamp} [${level}]: ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

// Judge base temperature. Gemini 3 Flash Preview has a confirmed infinite-
// reasoning-loop bug at low temperatures (< ~0.7): the model can enter
// repetitive verification cycles that exhaust maxOutputTokens without
// converging on a verdict. Google AI rep recommendation: temperature ≥ 0.7.
// The responseSchema enum + maxItems/maxLength constraints bound the output
// shape, so 0.7 does not sacrifice verdict determinism.
const DEFAULT_TEMPERATURE = 0.7;

// V4 Director Agent verdicts are structured JSON with rich content: 4-8
// findings × {message, evidence, prompt_delta, target_fields[]} +
// commendations + dimension_scores.
//
// Production timeline + root-cause analysis (logs.txt 2026-04-26):
//
//   2026-04-25T08:00 — 9/9 calls truncated at 16384 (no visible JSON).
//                      Bumped 6000→16384 + added thinkingLevel='low'.
//   2026-04-25T15:34 — STILL truncating at 16384; visible JSON starting.
//                      'low' was still heavy; dropped to 'minimal'.
//   2026-04-26T06:29 — thoughts=0 (minimal honored) but candidate=25366.
//                      Visible verdict rambling. Added responseSchema caps
//                      (findings.maxItems=5, message.maxLength=280, etc.)
//                      and dropped budget 32768 → 8192.
//   2026-04-26T09:00 — STILL failing with TWO distinct failure modes:
//
//     MODE 1 (Lens A/B, text-only or single image):
//       thoughts=0, candidate=1096, finish=MAX_TOKENS at budget 8192.
//       rawText is present (partial JSON). Root cause: confirmed Google SDK
//       bug googleapis/python-genai#782 — thinkingLevel='minimal' does NOT
//       fully disable Gemini 3 Flash Preview thinking. Model silently
//       allocates ~7096 hidden thinking tokens that thoughtsTokenCount
//       reports as 0. MAX_TOKENS fires at hidden(~7096)+visible(1096)=8192.
//       The previous 8192 budget drop assumed schema caps would prevent
//       rambling on the visible side — they did, but the hidden thinking
//       still consumed the budget.
//
//     MODE 2 (Lens C/D, multimodal multi-image):
//       thoughts=0, candidate=8177, finish=MAX_TOKENS at budget 8192.
//       content.parts ABSENT (Vertex dropped partial structured JSON).
//       Root cause: with heavy multimodal input, hidden thinking is absent
//       → full 8192 output budget consumed by visible text; responseSchema
//       maxLength caps are validated post-hoc, not enforced during token
//       generation. Model rambles to 8177 tokens, hits hard cap, Vertex
//       drops the malformed partial JSON → "no text" wrong error branch.
//
// Three-pronged fix (this commit):
//   1. maxOutputTokens 8192 → X: headroom for hidden thinking + visible verdict.
//   2. temperature 0.3 → 0.7: escape Gemini 3 infinite reasoning loops.
//   3. retry-on-MAX_TOKENS in _call: one automatic retry with budget×2
//      and temp+=0.2 if first attempt hits MAX_TOKENS and time remains.
//
//   2026-04-26T12:44 — BOTH screenplay AND scene_master timing out at
//                      exactly 180s at budget=32768. Root cause: Gemini 3
//                      Flash hidden thinking scales ~87% of maxOutputTokens.
//                      At budget=32768: ~28K thinking tokens → ~280s → timeout.
//                      Dropped to budget=12288 (thinking ≈ 10665 tokens,
//                      visible ≈ 1623 visible → still MAX_TOKENS, verdict
//                      not finishing at 1623 tokens).
//
//   2026-04-26T13:01 — Attempted thinkingBudget: 0 (numeric Gemini 2.5 API
//                      surface). ALSO ignored — thinkingConfig has no effect
//                      on gemini-3-flash-preview at the Vertex global endpoint
//                      regardless of field name or value. Model always consumes
//                      ~87% of maxOutputTokens as hidden thinking.
//
//                      Observed empirically across all budgets tested:
//                        budget=8192:  thinking≈7097, visible≈1095 → truncated
//                        budget=12288: thinking≈10665, visible≈1623 → truncated
//                        budget=16384: thinking≈14254, visible≈2130 available
//                                      verdict used 1578 tokens → finish=STOP ✓
//                        budget=24576: visible≈3195 — BUT verdict STILL hits
//                                      MAX_TOKENS at candidate=3210 (barely over).
//                                      Root cause: dimension_scores had no
//                                      additionalProperties schema constraint →
//                                      model writes verbose prose values (e.g.
//                                      "75 — arc present but...") adding 500-2000
//                                      extra visible tokens. Verdict itself is
//                                      3500+ when prose, ~435 when integers only.
//
//   2026-04-26T15:33 — thinkingLevel: 'MINIMAL' (uppercase, Gemini 3 API) is
//                      ALSO ignored on Vertex global endpoint, same as
//                      thinkingBudget: 0. Both APIs silently accepted, zero
//                      effect. Hidden thinking stays at ~87% regardless.
//                      Root fix: add additionalProperties:{type:integer} to
//                      dimension_scores in verdictSchema.mjs. This forces integer
//                      values and drops worst-case verdict from 3500+ → ~435
//                      tokens. At 87% thinking, budget=8192 → visible=1065 →
//                      435-token hard_reject fits with 630-token margin.
//                      Generation time: 8192/120t/s = 68s << 360s timeout ✓.
//                      Retry at 16384 = 137s; first+buffer+retry = 235s < 360s ✓.
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const DEFAULT_TIMEOUT_MS = 360_000;    // raised from 240s — multimodal at 24576 budget takes ~205s
const DEFAULT_TIMEOUT_VIDEO_MS = 360_000; // Lens D (full episode video)
const DEFAULT_THINKING_LEVEL = 'minimal';

/**
 * The four checkpoint identifiers. Match the values written into
 * director_report and emitted via ProgressEmitter (`director:<checkpoint>`).
 */
export const CHECKPOINTS = Object.freeze({
  SCREENPLAY: 'screenplay',
  SCENE_MASTER: 'scene_master',
  BEAT: 'beat',
  EPISODE: 'episode'
});

const VALID_MODES = new Set(['off', 'shadow', 'blocking', 'advisory']);

/**
 * Thrown by the orchestrator when a Director Agent verdict in BLOCKING mode
 * cannot be auto-recovered (hard_reject OR soft_reject with budget exhausted
 * OR structural defect). The orchestrator marks the episode as
 * `awaiting_user_review` BEFORE throwing, so the route catch should NOT
 * clobber the status. Distinguishable from generic Error via instanceof.
 */
export class DirectorBlockingHaltError extends Error {
  constructor({ checkpoint, verdict, artifactKey = null, reason = '' } = {}) {
    super(`Director Agent halted ${checkpoint}${artifactKey ? `:${artifactKey}` : ''} — ${reason}`);
    this.name = 'DirectorBlockingHaltError';
    this.checkpoint = checkpoint;
    this.verdict = verdict;
    this.artifactKey = artifactKey;
    this.reason = reason;
  }
}

/**
 * Resolve the effective Director Agent mode for a checkpoint by composing the
 * master and per-checkpoint env flags. This is the single source of truth for
 * the orchestrator deciding whether to (a) skip the director, (b) run it
 * observationally (shadow), (c) run it and act on its verdict (blocking), or
 * (d) collect advisory findings for the user (Lens D specifically).
 *
 * Resolution order:
 *   1. If per-checkpoint flag is set → use it (overrides master).
 *   2. Else if master flag is set → use it.
 *   3. Else → 'off'.
 *
 * Per-plan defaults baked into the runtime semantics:
 *   - Lens A/B/C support 'off' | 'shadow' | 'blocking'.
 *   - Lens D supports 'off' | 'shadow' | 'advisory' (NEVER 'blocking' —
 *     full-episode auto-retry is too expensive). Asking for blocking on D
 *     downgrades to 'advisory'.
 *
 * Env flags:
 *   BRAND_STORY_DIRECTOR_AGENT       - master toggle
 *   BRAND_STORY_DIRECTOR_SCREENPLAY  - Lens A
 *   BRAND_STORY_DIRECTOR_SCENE_MASTER - Lens B
 *   BRAND_STORY_DIRECTOR_BEAT        - Lens C
 *   BRAND_STORY_DIRECTOR_EPISODE     - Lens D
 *
 * @param {string} checkpoint - one of CHECKPOINTS.*
 * @returns {'off' | 'shadow' | 'blocking' | 'advisory'}
 */
export function resolveDirectorMode(checkpoint) {
  const perCheckpointKey = ({
    [CHECKPOINTS.SCREENPLAY]:   'BRAND_STORY_DIRECTOR_SCREENPLAY',
    [CHECKPOINTS.SCENE_MASTER]: 'BRAND_STORY_DIRECTOR_SCENE_MASTER',
    [CHECKPOINTS.BEAT]:         'BRAND_STORY_DIRECTOR_BEAT',
    [CHECKPOINTS.EPISODE]:      'BRAND_STORY_DIRECTOR_EPISODE'
  })[checkpoint];

  const raw = (process.env[perCheckpointKey] || process.env.BRAND_STORY_DIRECTOR_AGENT || 'off')
    .toString().toLowerCase().trim();
  const normalized = (raw === 'true' || raw === 'on') ? 'shadow'
    : (raw === 'false' ? 'off' : raw);
  let mode = VALID_MODES.has(normalized) ? normalized : 'off';

  // Lens D never auto-retries; downgrade 'blocking' → 'advisory'.
  if (checkpoint === CHECKPOINTS.EPISODE && mode === 'blocking') {
    mode = 'advisory';
  }
  return mode;
}

export class DirectorAgent {
  constructor({
    temperature = DEFAULT_TEMPERATURE,
    maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    timeoutVideoMs = DEFAULT_TIMEOUT_VIDEO_MS,
    modelId = process.env.GEMINI_MODEL || undefined,
    thinkingLevel = DEFAULT_THINKING_LEVEL
  } = {}) {
    this.temperature = temperature;
    this.maxOutputTokens = maxOutputTokens;
    this.timeoutMs = timeoutMs;
    this.timeoutVideoMs = timeoutVideoMs;
    this.modelId = modelId;
    this.thinkingLevel = thinkingLevel;
  }

  /**
   * Quick configuration check — used by the orchestrator to decide whether
   * to skip director calls in environments where Vertex isn't wired up.
   */
  isAvailable() {
    return isVertexGeminiConfigured();
  }

  /**
   * Lens A — judge a screenplay scene-graph.
   * Text-only. ~30-60s typical latency, single Gemini call.
   */
  async judgeScreenplay(args) {
    const { systemPrompt, userPrompt } = buildScreenplayJudgePrompt(args);
    return this._call({
      systemPrompt,
      userPrompt,
      schema: SCREENPLAY_VERDICT_SCHEMA,
      checkpointLabel: CHECKPOINTS.SCREENPLAY
    });
  }

  /**
   * Lens B — judge a Scene Master panel (multimodal: still + text).
   * One call per scene. ~30s typical latency.
   */
  async judgeSceneMaster(args) {
    const { systemPrompt, userParts } = buildSceneMasterJudgePrompt(args);
    return this._call({
      systemPrompt,
      userParts,
      schema: SCENE_MASTER_VERDICT_SCHEMA,
      checkpointLabel: CHECKPOINTS.SCENE_MASTER
    });
  }

  /**
   * Lens C — judge a beat (multimodal: endframe + optional midframe + text).
   * One call per beat. ~10-15s typical latency. Designed to run in parallel
   * with the next beat's audio prep so wall-clock impact is near-zero.
   */
  async judgeBeat(args) {
    const { systemPrompt, userParts } = buildBeatJudgePrompt(args);
    return this._call({
      systemPrompt,
      userParts,
      schema: BEAT_VERDICT_SCHEMA,
      checkpointLabel: CHECKPOINTS.BEAT
    });
  }

  /**
   * Lens D — judge an assembled episode (multimodal: full video + text).
   * Advisory-only: never authorizes auto-retry of full episodes.
   * ~60-120s typical latency. Single call.
   */
  async judgeEpisode(args) {
    const { systemPrompt, userParts } = buildEpisodeJudgePrompt(args);
    const verdict = await this._call({
      systemPrompt,
      userParts,
      schema: EPISODE_VERDICT_SCHEMA,
      checkpointLabel: CHECKPOINTS.EPISODE,
      // Lens D ingests the full episode video — heavier processing.
      // Override the default text/image timeout with the video timeout.
      timeoutOverrideMs: this.timeoutVideoMs
    });
    // Defensive: even if the model misreads the rubric, force advisory-only.
    if (verdict && typeof verdict === 'object') {
      verdict.retry_authorization = false;
    }
    return verdict;
  }

  /**
   * Internal: shared Vertex call wrapper. Adds timing, error handling,
   * judge_model annotation, and a single MAX_TOKENS retry with a larger
   * budget and slightly higher temperature.
   *
   * Retry policy: if the first attempt hits MAX_TOKENS AND there is at
   * least 30s of wall-clock budget remaining, retry once with
   * min(budget×2, 65536) and min(temp+0.2, 1.0). This covers both
   * failure modes documented in the DEFAULT_MAX_OUTPUT_TOKENS comment:
   *   Mode 1 — hidden thinking ate the budget → larger budget survives it.
   *   Mode 2 — visible ramble hit the cap → larger budget lets JSON complete.
   *
   * After one retry (or if the first error is not MAX_TOKENS, or if there
   * is no time left), falls through to the synthetic error record. The
   * schema enforces the §7 verdict contract mechanically so the caller
   * always gets a well-formed object on success.
   */
  async _call({ systemPrompt, userPrompt, userParts, schema, checkpointLabel, timeoutOverrideMs }) {
    const t0 = Date.now();
    const effectiveTimeout = (typeof timeoutOverrideMs === 'number' && timeoutOverrideMs > 0)
      ? timeoutOverrideMs
      : this.timeoutMs;

    const makeCall = (tokenBudget, temp) => callVertexGeminiJson({
      systemPrompt,
      userPrompt,
      userParts,
      config: {
        temperature: temp,
        maxOutputTokens: tokenBudget,
        modelId: this.modelId,
        responseSchema: schema,
        thinkingLevel: this.thinkingLevel
      },
      timeoutMs: Math.max(10_000, effectiveTimeout - (Date.now() - t0))
    });

    try {
      let verdict;
      try {
        verdict = await makeCall(this.maxOutputTokens, this.temperature);
      } catch (firstErr) {
        const isMaxTokens = firstErr.message.includes('MAX_TOKENS');
        const hasTime = (effectiveTimeout - (Date.now() - t0)) > 30_000;
        if (!isMaxTokens || !hasTime) throw firstErr;
        const retryBudget = Math.min(this.maxOutputTokens * 2, 65536);
        const retryTemp   = Math.min(this.temperature + 0.2, 1.0);
        logger.warn(
          `${checkpointLabel} MAX_TOKENS at budget=${this.maxOutputTokens}; ` +
          `retrying once with budget=${retryBudget}, temp=${retryTemp}`
        );
        verdict = await makeCall(retryBudget, retryTemp);
      }

      const latencyMs = Date.now() - t0;
      // Annotate metadata fields if the model didn't fill them.
      if (verdict && typeof verdict === 'object') {
        if (!verdict.judge_model) verdict.judge_model = this.modelId || (process.env.GEMINI_MODEL || 'gemini-3-flash-preview');
        if (verdict.latency_ms == null) verdict.latency_ms = latencyMs;
        // cost_usd is left for the orchestrator to fill (it has token-usage context).
      }
      logger.info(`${checkpointLabel} verdict in ${latencyMs}ms — ${verdict?.verdict} (score ${verdict?.overall_score})`);
      return verdict;
    } catch (err) {
      const latencyMs = Date.now() - t0;
      logger.error(`${checkpointLabel} call failed after ${latencyMs}ms: ${err.message}`);
      // No synthetic verdict on failure — return a record with `verdict=null`
      // and an `error` message. Callers MUST check verdict.error before treating
      // the result as a real verdict. Returning a synthetic `pass_with_notes`
      // with score 0 (the previous behavior) was misleading: Phase 1 shadow-mode
      // dashboards/logs reported these as low-quality passes, polluting the
      // calibration data that Phase 2-5 activation depends on.
      // DirectorRetryPolicy.decideRetry handles a null verdict by no-op (no
      // retry, no escalate) so blocking mode safely skips the affected
      // artifact rather than spending its retry budget on a non-verdict.
      return {
        checkpoint: checkpointLabel,
        verdict: null,
        overall_score: null,
        dimension_scores: {},
        findings: [],
        commendations: [],
        retry_authorization: false,
        judge_model: this.modelId || 'unavailable',
        latency_ms: latencyMs,
        cost_usd: 0,
        error: err.message
      };
    }
  }
}

export default DirectorAgent;
