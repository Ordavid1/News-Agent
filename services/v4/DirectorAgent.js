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
  EPISODE_VERDICT_SCHEMA,
  COMMERCIAL_BRIEF_VERDICT_SCHEMA,
  COMMERCIAL_EPISODE_VERDICT_SCHEMA,
  COMMERCIAL_SCREENPLAY_VERDICT_SCHEMA,
  COMMERCIAL_SCENE_MASTER_VERDICT_SCHEMA,
  COMMERCIAL_BEAT_VERDICT_SCHEMA,
  POST_STYLIZATION_IDENTITY_SCHEMA,
  // V4 Tier 3.2 + 3.5 (2026-05-06) — live in-pipeline lenses.
  CONTINUITY_VERDICT_SCHEMA,
  ROUGH_CUT_EDL_SCHEMA
} from './director-rubrics/verdictSchema.mjs';
import { buildScreenplayJudgePrompt } from './director-rubrics/screenplayRubric.mjs';
import { buildSceneMasterJudgePrompt } from './director-rubrics/sceneMasterRubric.mjs';
import { buildBeatJudgePrompt } from './director-rubrics/beatRubric.mjs';
import { buildEpisodeJudgePrompt } from './director-rubrics/episodeRubric.mjs';
// V4 Tier 3.2 (2026-05-06) — Lens E continuity rubric.
import { buildContinuityJudgePrompt } from './director-rubrics/continuityRubric.mjs';
import {
  buildCommercialBriefJudgePrompt,
  buildCommercialEpisodeJudgePrompt
} from './director-rubrics/commercialRubric.mjs';
import { buildCommercialScreenplayJudgePrompt } from './director-rubrics/commercialScreenplayRubric.mjs';
import { buildCommercialSceneMasterJudgePrompt } from './director-rubrics/commercialSceneMasterRubric.mjs';
import { buildCommercialBeatJudgePrompt } from './director-rubrics/commercialBeatRubric.mjs';
// Veo Failure-Learning Agent (2026-05-06). The DirectorAgent's verdicts
// produce remediation `prompt_delta` strings that the orchestrator feeds back
// into the next Veo render via SmartSynth. Without the failure-knowledge
// guidance in scope, Lens B/C/E can recommend a `prompt_delta` that re-enters
// a known content-filter pattern — the s2b1 dead-sparrow loop is the
// canonical example. Loaded lazily and prepended in _call() for every Veo-
// adjacent lens (off for the post-stylization identity gate, where it adds
// no value and risks muddying a focused face-comparison prompt).
import { getVeoFailureKnowledge } from './VeoFailureGuidance.js';

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
  EPISODE: 'episode',
  // Phase 6 — COMMERCIAL pipeline checkpoints. The brief check (Lens 0/A combined)
  // runs BEFORE the screenplay writer; the commercial-episode check is the
  // Lens D variant for assembled commercial spots.
  COMMERCIAL_BRIEF: 'commercial_brief',
  COMMERCIAL_EPISODE: 'commercial_episode',
  // V4 Phase 7 — full commercial Director ladder. Lens A / B / C variants
  // for stories whose genre === 'commercial'. The orchestrator routes by
  // genre and these checkpoints persist into director_report.
  COMMERCIAL_SCREENPLAY: 'commercial_screenplay',
  COMMERCIAL_SCENE_MASTER: 'commercial_scene_master',
  COMMERCIAL_BEAT: 'commercial_beat'
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
  // V4 Phase 7 — the genre-routed commercial checkpoints inherit the same
  // env flag as their prestige counterparts because the orchestrator picks
  // ONE method per checkpoint by genre. A single BRAND_STORY_DIRECTOR_BEAT
  // flag governs both judgeBeat AND judgeCommercialBeat. The COMMERCIAL_BRIEF
  // checkpoint (Lens 0/A) keeps its own flag so it can be gated independently.
  const perCheckpointKey = ({
    [CHECKPOINTS.SCREENPLAY]:            'BRAND_STORY_DIRECTOR_SCREENPLAY',
    [CHECKPOINTS.SCENE_MASTER]:          'BRAND_STORY_DIRECTOR_SCENE_MASTER',
    [CHECKPOINTS.BEAT]:                  'BRAND_STORY_DIRECTOR_BEAT',
    [CHECKPOINTS.EPISODE]:               'BRAND_STORY_DIRECTOR_EPISODE',
    [CHECKPOINTS.COMMERCIAL_BRIEF]:      'BRAND_STORY_DIRECTOR_COMMERCIAL_BRIEF',
    [CHECKPOINTS.COMMERCIAL_EPISODE]:    'BRAND_STORY_DIRECTOR_EPISODE',
    [CHECKPOINTS.COMMERCIAL_SCREENPLAY]: 'BRAND_STORY_DIRECTOR_SCREENPLAY',
    [CHECKPOINTS.COMMERCIAL_SCENE_MASTER]: 'BRAND_STORY_DIRECTOR_SCENE_MASTER',
    [CHECKPOINTS.COMMERCIAL_BEAT]:       'BRAND_STORY_DIRECTOR_BEAT'
  })[checkpoint];

  const raw = (process.env[perCheckpointKey] || process.env.BRAND_STORY_DIRECTOR_AGENT || 'off')
    .toString().toLowerCase().trim();
  const normalized = (raw === 'true' || raw === 'on') ? 'shadow'
    : (raw === 'false' ? 'off' : raw);
  let mode = VALID_MODES.has(normalized) ? normalized : 'off';

  // Lens D never auto-retries; downgrade 'blocking' → 'advisory'. Same for
  // the commercial Lens D variant.
  if ((checkpoint === CHECKPOINTS.EPISODE || checkpoint === CHECKPOINTS.COMMERCIAL_EPISODE)
      && mode === 'blocking') {
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
   * V4 Tier 3.2 (2026-05-06) — Lens E "Continuity Supervisor".
   *
   * The user's strategic ask: move the Director from a checkpoint critic
   * to a LIVE pipeline supervisor. Lens E runs BETWEEN beat generations
   * (after beat N's Lens C pass, before beat N+1 starts) — judging the
   * RELATIONSHIP between consecutive beats rather than each in isolation.
   *
   * Cadence: WITHIN-SCENE only. Cross-scene continuity is owned by Lens F
   * (Editor Agent). Caller is responsible for not invoking this when
   * scene_idx changes between prevBeat and currentBeat.
   *
   * Live-streamed via the orchestrator's progressEmitter so the Director
   * Panel UI renders per-pair continuity badges as they happen.
   *
   * @param {Object} args - see buildContinuityJudgePrompt
   */
  async judgeContinuity(args) {
    const { systemPrompt, userParts } = buildContinuityJudgePrompt(args);
    return this._call({
      systemPrompt,
      userParts,
      schema: CONTINUITY_VERDICT_SCHEMA,
      checkpointLabel: 'continuity',
      timeoutOverrideMs: this.timeoutVideoMs
    });
  }

  /**
   * V4 Tier 3.5 (2026-05-06) — Lens F "Editor Agent".
   *
   * Runs once per episode on the assembled rough cut (PostProduction
   * stage 2 output, BEFORE stage 3 LUT). Authorized to emit a structured
   * Edit Decision List (drop_beat / swap_beats / retime_beat /
   * j_cut_audio) that PostProduction stage 2.5 applies before LUT.
   *
   * Lens D becomes the SCREENING verdict on the cut, not the assembly.
   *
   * Live-streamed via the orchestrator's progressEmitter so the Director
   * Panel UI renders the proposed EDL and the user can approve / override
   * / reject in real time.
   *
   * @param {Object} args
   * @param {string|Buffer} args.roughCutVideo - URL or Buffer of the assembled pre-LUT MP4
   * @param {string} [args.roughCutMime='video/mp4']
   * @param {Object} args.sceneGraph - the full scene-graph for context
   * @param {Object[]} [args.lensCVerdicts] - per-beat Lens C verdicts indexed by beat_id
   * @param {Object} [args.continuitySummary] - { worst_pair, weakest_dim_avg, broken_chain_count } from Lens E
   */
  async judgeRoughCut(args) {
    // Build prompt inline to avoid spinning up a separate rubric module
    // for what is structurally a wrapper around the EDL schema.
    const {
      roughCutVideo,
      roughCutMime = 'video/mp4',
      sceneGraph,
      lensCVerdicts = {},
      continuitySummary = null
    } = args || {};
    if (!roughCutVideo) throw new Error('judgeRoughCut: roughCutVideo is required');

    const systemPrompt = [
      'You are the EDITOR. The director shot the coverage; you cut the picture. Your job: watch the rough cut as a SEQUENCE and emit an Edit Decision List (EDL) that tightens the storytelling.',
      '',
      'CHECKPOINT F — Editor (per episode, pre-LUT). LENS F. Runs on the assembled rough cut BEFORE the LUT pass.',
      '',
      'AUTHORIZED EDITS (emit on the EDL field):',
      '  drop_beat:    beats that do not earn their runtime (max 4)',
      '  swap_beats:   pairs to reorder (max 3 swaps)',
      '  retime_beat:  ±0.5s nudges per beat (max 6)',
      '  j_cut_audio:  audio of beat N+1 starts under beat N tail (max 4 J-cuts)',
      '',
      'DIMENSIONS TO SCORE (each 0-100):',
      '  pace_per_act        — does the cut breathe at the right rate per movement?',
      '  bridge_quality      — do scene-to-scene transitions land?',
      '  rhythm_variation    — avoid mechanical "every beat is 4s" feel',
      '  dialogue_landing    — do exchange beats land their punctuation?',
      '  cliffhanger_sting   — does the final beat earn its end card?',
      '',
      'OUTPUT ONLY THE VERDICT JSON (with edl populated when shouldEdit). No prose preamble.'
    ].join('\n');

    const userParts = [];
    userParts.push({ text: `<scene_graph_summary>\n${JSON.stringify({
      scenes: (sceneGraph?.scenes || []).map(s => ({
        scene_id: s.scene_id,
        beat_count: (s.beats || []).length,
        beat_ids: (s.beats || []).map(b => b.beat_id)
      })),
      total_beats: (sceneGraph?.scenes || []).reduce((acc, s) => acc + (s.beats || []).length, 0)
    }, null, 2)}\n</scene_graph_summary>` });

    if (continuitySummary) {
      // Compressed summary, not raw Lens E verdicts (per Director note —
      // raw verdicts blow the multimodal budget).
      userParts.push({ text: `<continuity_summary_from_lens_e>\n${JSON.stringify(continuitySummary, null, 2)}\n</continuity_summary_from_lens_e>` });
    }

    const lensCSummary = Object.entries(lensCVerdicts || {})
      .filter(([, v]) => v && v.verdict)
      .map(([beatId, v]) => ({ beat_id: beatId, verdict: v.verdict, score: v.overall_score || null }));
    if (lensCSummary.length > 0) {
      userParts.push({ text: `<lens_c_summary>\n${JSON.stringify(lensCSummary, null, 2)}\n</lens_c_summary>` });
    }

    // Attach the rough cut video.
    if (Buffer.isBuffer(roughCutVideo)) {
      userParts.push({ text: 'Rough cut (pre-LUT, pre-music-mix):' });
      userParts.push({ inline_data: { mime_type: roughCutMime, data: roughCutVideo.toString('base64') } });
    } else if (typeof roughCutVideo === 'string') {
      userParts.push({ text: 'Rough cut (pre-LUT, pre-music-mix):' });
      userParts.push({ file_data: { file_uri: roughCutVideo, mime_type: roughCutMime } });
    }

    userParts.push({ text: 'Grade per Lens F. Output ONLY the verdict JSON with edl field populated.' });

    return this._call({
      systemPrompt,
      userParts,
      schema: ROUGH_CUT_EDL_SCHEMA,
      checkpointLabel: 'rough_cut_editor',
      timeoutOverrideMs: this.timeoutVideoMs
    });
  }

  // V4 Tier 3.6 — Lens G "Sound Supervisor" (NAMED, BUILD DEFERRED).
  //
  // The org-chart gap noted by the Director: this pipeline has no sound
  // supervisor. Lens G would run audio-only on the music + SFX mix between
  // PostProduction stage 4 (music mix) and stage 5 (cards). 5-dim rubric:
  // dialogue_intelligibility / music_emotion_fit / sfx_motivation /
  // silence_use / sting_landing. Authorized to trigger one re-mix pass with
  // adjusted ducking parameters.
  //
  // Build deferred to a future tier — named here so the gap is on the record
  // and the orchestrator can wire it without service surgery later.

  /**
   * Phase 6 — COMMERCIAL pre-screenplay brief verdict (Lens 0/A combined).
   * Runs ONCE per commercial story BEFORE the screenplay writer is invoked.
   * Validates the CreativeBriefDirector output against the commercial rubric;
   * a soft_reject triggers a brief re-run with the director's nudge before
   * any screenplay tokens are spent.
   */
  async judgeCommercialBrief(args) {
    const { systemPrompt, userParts } = buildCommercialBriefJudgePrompt(args);
    return this._call({
      systemPrompt,
      userParts,
      schema: COMMERCIAL_BRIEF_VERDICT_SCHEMA,
      checkpointLabel: CHECKPOINTS.COMMERCIAL_BRIEF
    });
  }

  /**
   * Phase 6 — COMMERCIAL picture-lock verdict (Lens D variant). Always advisory.
   */
  async judgeCommercialEpisode(args) {
    const { systemPrompt, userParts } = buildCommercialEpisodeJudgePrompt(args);
    const verdict = await this._call({
      systemPrompt,
      userParts,
      schema: COMMERCIAL_EPISODE_VERDICT_SCHEMA,
      checkpointLabel: CHECKPOINTS.COMMERCIAL_EPISODE,
      timeoutOverrideMs: this.timeoutVideoMs
    });
    if (verdict && typeof verdict === 'object') {
      verdict.retry_authorization = false;  // commercial picture lock is advisory
    }
    return verdict;
  }

  /**
   * V4 Phase 7 — COMMERCIAL Lens A (screenplay). Replaces the prestige
   * screenplayRubric (story_spine / character_voice / dialogue_craft /
   * subtext_density / etc.) with commercial-craft dimensions
   * (creative_concept_clarity / visual_signature_strength / hook_first_1_5s
   * / story_compression / tagline_landing_setup / product_role /
   * style_category_fidelity / anti_brief_adherence). Routed by genre at the
   * BrandStoryService call site. Text-only; same latency profile as
   * judgeScreenplay.
   */
  async judgeCommercialScreenplay(args) {
    const { systemPrompt, userPrompt } = buildCommercialScreenplayJudgePrompt(args);
    return this._call({
      systemPrompt,
      userPrompt,
      schema: COMMERCIAL_SCREENPLAY_VERDICT_SCHEMA,
      checkpointLabel: CHECKPOINTS.COMMERCIAL_SCREENPLAY
    });
  }

  /**
   * V4 Phase 7 — COMMERCIAL Lens B (Scene Master). Replaces the prestige
   * sceneMasterRubric (genre_register_visual / lut_mood_fit) with commercial
   * dimensions (style_category_fidelity / style_palette_fit /
   * visual_signature_consistency). Multimodal (still + text); same latency
   * profile as judgeSceneMaster.
   */
  async judgeCommercialSceneMaster(args) {
    const { systemPrompt, userParts } = buildCommercialSceneMasterJudgePrompt(args);
    return this._call({
      systemPrompt,
      userParts,
      schema: COMMERCIAL_SCENE_MASTER_VERDICT_SCHEMA,
      checkpointLabel: CHECKPOINTS.COMMERCIAL_SCENE_MASTER
    });
  }

  /**
   * V4 Phase 7 — COMMERCIAL Lens C (beat). Replaces the prestige beatRubric
   * continuity dimensions (lighting_continuity / lens_continuity /
   * identity_lock) with commercial-aware ones (art_direction_consistency /
   * framing_intent / identity_lock_stylized). Findings emit Phase 5b's
   * `target` enum WITH the new `style` value for art-direction / palette
   * / framing-vocab drift. Multimodal (endframe + optional midframe + text);
   * same latency profile as judgeBeat.
   */
  async judgeCommercialBeat(args) {
    const { systemPrompt, userParts } = buildCommercialBeatJudgePrompt(args);
    return this._call({
      systemPrompt,
      userParts,
      schema: COMMERCIAL_BEAT_VERDICT_SCHEMA,
      checkpointLabel: CHECKPOINTS.COMMERCIAL_BEAT
    });
  }

  /**
   * 2026-05-05 — Aleph Rec 2 Phase 3 hard gate.
   *
   * Single-dimension multimodal judge that scores how well a stylized
   * frame preserves a reference persona's facial bone structure. Used by
   * AlephEnhancementOrchestrator after gen4_aleph stylization to decide
   * whether to ship the stylized output (pass at 85+) or discard it and
   * keep the original final_video_url. Implements the hard gate from
   * Director Agent verdict A2.2.
   *
   * Tiny schema (POST_STYLIZATION_IDENTITY_SCHEMA) keeps this fast — typical
   * latency 10-30s vs 60-120s for full Lens C. The orchestrator runs this
   * 1-3 times against representative stylized frames and averages.
   *
   * @param {Object} params
   * @param {Buffer|string} params.stylizedFrameImage - JPG buffer OR URL of the post-Aleph midframe
   * @param {string} [params.stylizedFrameMime='image/jpeg']
   * @param {Buffer|string} params.personaReferenceImage - persona's CIP-front (canonical identity portrait)
   * @param {string} [params.personaReferenceMime='image/jpeg']
   * @param {string} [params.personaName='the persona']
   * @returns {Promise<{ identity_lock_score: number, pass: boolean, reasoning: string }>}
   */
  async judgePostStylizationIdentity({
    stylizedFrameImage,
    stylizedFrameMime = 'image/jpeg',
    personaReferenceImage,
    personaReferenceMime = 'image/jpeg',
    personaName = 'the persona'
  }) {
    if (!stylizedFrameImage) throw new Error('judgePostStylizationIdentity: stylizedFrameImage required');
    if (!personaReferenceImage) throw new Error('judgePostStylizationIdentity: personaReferenceImage required');

    const systemPrompt = [
      'You are a casting director and identity-fidelity judge.',
      '',
      'Your single task: judge whether the STYLIZED FRAME preserves the persona\'s facial identity from the REFERENCE IMAGE.',
      '',
      'What counts as identity:',
      '  • Inter-ocular distance (eye spacing)',
      '  • Nose geometry (length, bridge, nostrils)',
      '  • Jawline and chin shape',
      '  • Lip shape and proportions',
      '  • Brow arch and forehead ratio',
      '  • Ear placement and size',
      '',
      'What DOES NOT count as identity drift:',
      '  • Lighting / color / grade differences (the stylization changes look intentionally)',
      '  • Hair styling / makeup / wardrobe differences',
      '  • Background / scene differences',
      '  • Pose / expression / mouth-open vs closed',
      '  • Stylized rendering style (cel-shade, painterly, etc.) — judge the underlying bone structure, not the rendering',
      '',
      'Scoring:',
      '  100  — perfect identity preservation; could be the same actor in the same casting session',
      '  85+  — acceptable; same person despite stylization',
      '  70-84 — borderline; family member or close lookalike but not the same person',
      '  <70  — clear identity drift; different person',
      '',
      'Hard gate: pass=true at 85+, pass=false below 85. NO middle ground.',
      'Output ONLY the JSON verdict matching the schema. No preamble, no explanation outside the reasoning field.'
    ].join('\n');

    const userParts = [
      { text: `Persona name: ${personaName}` },
      { text: 'REFERENCE IMAGE (canonical identity portrait — what the persona\'s face SHOULD look like):' }
    ];

    // Attach reference image (CIP front view)
    if (Buffer.isBuffer(personaReferenceImage)) {
      userParts.push({
        inline_data: { mime_type: personaReferenceMime, data: personaReferenceImage.toString('base64') }
      });
    } else if (typeof personaReferenceImage === 'string') {
      userParts.push({
        file_data: { file_uri: personaReferenceImage, mime_type: personaReferenceMime }
      });
    }

    userParts.push({ text: 'STYLIZED FRAME (post-Aleph output — does this preserve the same facial identity?):' });

    if (Buffer.isBuffer(stylizedFrameImage)) {
      userParts.push({
        inline_data: { mime_type: stylizedFrameMime, data: stylizedFrameImage.toString('base64') }
      });
    } else if (typeof stylizedFrameImage === 'string') {
      userParts.push({
        file_data: { file_uri: stylizedFrameImage, mime_type: stylizedFrameMime }
      });
    }

    userParts.push({ text: 'Score identity_lock_score 0-100. Set pass=true at 85+. Output ONLY the JSON verdict.' });

    return this._call({
      systemPrompt,
      userParts,
      schema: POST_STYLIZATION_IDENTITY_SCHEMA,
      checkpointLabel: 'post_stylization_identity',
      // Identity gate compares two faces — Veo failure-knowledge phrasing
      // rules are off-topic here and would only muddy a focused prompt.
      injectVeoFailureGuidance: false
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
  async _call({ systemPrompt, userPrompt, userParts, schema, checkpointLabel, timeoutOverrideMs, injectVeoFailureGuidance = true }) {
    const t0 = Date.now();
    const effectiveTimeout = (typeof timeoutOverrideMs === 'number' && timeoutOverrideMs > 0)
      ? timeoutOverrideMs
      : this.timeoutMs;

    // Veo Failure-Learning Agent (2026-05-06) — prepend the auto-learned
    // guidance block so Lens B/C/D/E verdicts emit remediation `prompt_delta`
    // strings that don't re-enter known-failing content-filter patterns.
    // Best-effort: a load failure NEVER blocks the verdict. The post-
    // stylization identity gate opts out (injectVeoFailureGuidance=false)
    // because it compares two faces and Veo phrasing rules are off-topic.
    let effectiveSystemPrompt = systemPrompt;
    if (injectVeoFailureGuidance && systemPrompt) {
      try {
        const knowledge = await getVeoFailureKnowledge();
        if (knowledge && typeof knowledge.getGeminiSystemPromptBlock === 'function') {
          const block = knowledge.getGeminiSystemPromptBlock({
            modelId: 'veo-3.1-vertex',
            minSeverity: ['medium', 'high', 'critical']
          });
          if (block && typeof block === 'string' && block.length > 0) {
            effectiveSystemPrompt = `${systemPrompt}\n\n${block}\n\nWhen recommending a prompt_delta in remediation, ensure the suggested phrasing does not match any of the avoid-patterns above. The remediation must preserve the beat's narrative intent while expressing it in filter-safe language.`;
          }
        }
      } catch (failureKnowledgeErr) {
        logger.warn(`${checkpointLabel}: Veo failure-knowledge unavailable (${failureKnowledgeErr.message}) — verdict rendered without guidance block`);
      }
    }

    const makeCall = (tokenBudget, temp) => callVertexGeminiJson({
      systemPrompt: effectiveSystemPrompt,
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
