// services/v4/ClosingStateExtractor.js
// V4 Phase 11 (2026-05-07) — closing-state propagation, the keystone fix.
//
// PROBLEM: Per Director Agent's prestige-bar architecture review, the
// orchestrator hands `previousBeat = { endframe_url }` to each beat
// generator. That endframe is a pixel — it carries geometry but not
// intent. The next beat inherits where the camera ended; it does NOT
// inherit what the character was DOING, FEELING, or LOOKING AT. As a
// result, every cut reads as a reset: a character who held breath at
// end of beat N takes a fresh breath at start of beat N+1, breaking
// the performance arc the writer's room built. The dailies feel
// stitched, not directed.
//
// FIX: After each beat renders and its endframe is extracted, we ask
// Vertex Gemini Flash (multimodal: endframe image + structured beat
// metadata) to extract a SEMANTIC closing state — a small, structured
// JSON describing what the next beat needs to inherit:
//
//   {
//     closing_emotional_state:    e.g., "guarded_resignation"
//     closing_subject_position:   e.g., "frame_left_medium"
//     closing_action_state:       e.g., "still_seated_mid_exhale"
//     closing_eyeline_target:     e.g., "camera_left_offscreen"
//     last_dialogue_line:         echo of beat.dialogue tail
//     breath_state:               e.g., "held"
//   }
//
// This state is then injected into the next beat's prompt as a
// "CONTINUITY FROM PREVIOUS BEAT" directive (see BaseBeatGenerator
// `_buildContinuityFromPreviousBeat`). The next render now KNOWS the
// performance state it must continue, not just the frame it must
// match. Pixels carry geometry; fields carry intent.
//
// PRINCIPLES:
//   - Never block the pipeline. If Gemini is offline, fetch fails, or
//     the model returns malformed JSON, we return null and the orchestrator
//     proceeds with the legacy { endframe_url } payload only.
//   - Cheap (~$0.0003-$0.001 per call): Gemini 3 Flash with thinking_level
//     'low', 1500 max output tokens, single endframe ~150 KB JPEG.
//   - Schema-locked output via responseSchema enums to prevent drift.
//   - Idempotent: safe to call on already-extracted beats; caller checks
//     beat.closing_state before invoking.

import axios from 'axios';
import winston from 'winston';
import { callVertexGeminiJson, isVertexGeminiConfigured } from './VertexGemini.js';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) =>
      `[ClosingStateExtractor] ${timestamp} [${level}]: ${message}`
    )
  ),
  transports: [new winston.transports.Console()]
});

const FETCH_TIMEOUT_MS = 20000;
const GEMINI_TIMEOUT_MS = 30000;
const MAX_OUTPUT_TOKENS = 1500;
const TEMPERATURE = 0.3;  // Analytical extraction — low variance preferred

// Schema-locked enums. The model must pick from these closed vocabularies
// for downstream consumers (next-beat continuity directive) to interpret
// reliably. Free-form drift defeats the propagation purpose.
const EMOTIONAL_STATES = [
  'tense_hold', 'released_relief', 'guarded_resignation',
  'building_anger', 'simmering_grief', 'masked_calm',
  'wary_alertness', 'private_decision', 'open_vulnerability',
  'controlled_assertion', 'hidden_amusement', 'spent_exhaustion',
  'reluctant_compliance', 'defiant_steadiness', 'unspecified'
];

const SUBJECT_POSITIONS = [
  'frame_left_close', 'frame_right_close', 'frame_center_close',
  'frame_left_medium', 'frame_right_medium', 'frame_center_medium',
  'frame_left_wide', 'frame_right_wide', 'frame_center_wide',
  'off_screen_audible', 'no_subject_in_frame', 'unspecified'
];

const ACTION_STATES = [
  'still_seated', 'still_standing', 'mid_step', 'mid_gesture',
  'mid_turn', 'just_completed_action', 'about_to_speak',
  'just_finished_speaking', 'silent_listening', 'object_in_hand',
  'object_just_set_down', 'object_just_picked_up',
  'walking_into_frame', 'walking_out_of_frame', 'unspecified'
];

const EYELINE_TARGETS = [
  'camera_direct', 'camera_left_offscreen', 'camera_right_offscreen',
  'subject_in_frame', 'object_in_frame', 'downward_inward',
  'upward_distant', 'middle_distance_through', 'eyes_closed',
  'eyes_not_visible', 'unspecified'
];

const BREATH_STATES = [
  'held', 'exhaling', 'inhaling', 'calm_steady',
  'short_quick', 'sigh_just_finished', 'not_visible', 'unspecified'
];

const CLOSING_STATE_SCHEMA = {
  type: 'object',
  required: [
    'closing_emotional_state',
    'closing_subject_position',
    'closing_action_state',
    'closing_eyeline_target',
    'breath_state'
  ],
  properties: {
    closing_emotional_state: { type: 'string', enum: EMOTIONAL_STATES },
    closing_subject_position: { type: 'string', enum: SUBJECT_POSITIONS },
    closing_action_state: { type: 'string', enum: ACTION_STATES },
    closing_eyeline_target: { type: 'string', enum: EYELINE_TARGETS },
    breath_state: { type: 'string', enum: BREATH_STATES },
    // Free-form fields — the model authors these in 1-12 words MAX.
    closing_action_detail: { type: 'string', maxLength: 140 },
    closing_emotional_detail: { type: 'string', maxLength: 140 },
    last_dialogue_line: { type: 'string', maxLength: 220 }
  }
};

/**
 * Extract the closing state of a rendered beat from its endframe + metadata.
 *
 * @param {Object} params
 * @param {Object} params.beat              - the beat object (post-render, with beat.endframe_url set)
 * @param {Object} [params.scene]           - parent scene (for atmosphere / location context)
 * @param {Object} [params.persona]         - resolved primary persona (for archetype context)
 * @param {string} [params.logPrefix]       - log tag, e.g. "s2b3"
 * @returns {Promise<Object|null>}
 *   On success: structured closing_state object (see CLOSING_STATE_SCHEMA above).
 *   On any failure (offline Gemini, fetch fail, schema fail): null.
 *   Callers MUST tolerate null — pipeline never blocks on this extraction.
 */
export async function extractClosingState({ beat, scene = null, persona = null, logPrefix = '' } = {}) {
  if (!beat) {
    logger.warn(`[${logPrefix}] extractClosingState: beat required, returning null`);
    return null;
  }
  if (!beat.endframe_url) {
    // Beat hasn't successfully rendered or endframe extraction failed.
    // Quiet — the orchestrator already logged the underlying issue.
    return null;
  }

  const tag = logPrefix || beat.beat_id || '?';

  // Bail cheaply when Vertex isn't configured (CI, local dev without GCP).
  if (!isVertexGeminiConfigured()) {
    logger.info(`[${tag}] Vertex Gemini not configured — closing-state extraction skipped`);
    return null;
  }

  // Fetch endframe as inline_data part. Best-effort: any fetch failure
  // returns null and the orchestrator falls through to legacy behavior.
  const endframePart = await _fetchAsInlinePart(beat.endframe_url, 'image/jpeg', tag);
  if (!endframePart) {
    logger.warn(`[${tag}] endframe fetch failed; closing-state extraction skipped`);
    return null;
  }

  const systemPrompt = _buildSystemPrompt();
  const beatMetadataText = _buildBeatMetadataText({ beat, scene, persona });

  const userParts = [
    { text: '── ENDFRAME (the last frame of the beat just rendered) ──' },
    endframePart,
    { text: '── BEAT METADATA (what the writers room authored) ──' },
    { text: beatMetadataText }
  ];

  const t0 = Date.now();
  let parsed;
  try {
    parsed = await callVertexGeminiJson({
      systemPrompt,
      userParts,
      config: {
        temperature: TEMPERATURE,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        responseSchema: CLOSING_STATE_SCHEMA,
        thinkingLevel: 'low'
      },
      timeoutMs: GEMINI_TIMEOUT_MS
    });
  } catch (err) {
    logger.warn(`[${tag}] Gemini call failed (${err.message}); closing-state extraction skipped`);
    return null;
  }
  const latency = Date.now() - t0;

  // Best-effort echo of last dialogue if the model omitted it. Cheaper to
  // splice from the authored line than to require it from the model.
  const result = _normalize(parsed, beat);
  if (!result) {
    logger.warn(`[${tag}] Gemini returned malformed/empty closing_state; skipping`);
    return null;
  }
  result._extracted_ms = latency;
  result._extracted_at = new Date().toISOString();

  logger.info(
    `[${tag}] closing_state extracted in ${latency}ms — ` +
    `emo=${result.closing_emotional_state} pos=${result.closing_subject_position} ` +
    `action=${result.closing_action_state} eyeline=${result.closing_eyeline_target} ` +
    `breath=${result.breath_state}`
  );
  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────

function _buildSystemPrompt() {
  return [
    'You are a script-supervisor / continuity reader for a prestige short-film pipeline.',
    'You receive ONE endframe image (the last frame of a beat that just rendered) plus the beat metadata that was authored before the render.',
    '',
    'Your job: extract a STRUCTURED CLOSING STATE that describes what the NEXT beat must inherit to feel like the same continuous performance, not a fresh take.',
    'You are not judging quality. You are not rewriting the beat. You are documenting the END-OF-BEAT performance state for the next director.',
    '',
    'RULES:',
    ' • Read the IMAGE for: subject position in frame, action state, eyeline, breath state visible on the body.',
    ' • Read the METADATA for: emotional intent, dialogue, subtext.',
    ' • RECONCILE the two when they agree. PREFER the IMAGE when they disagree (the metadata is what was wanted; the image is what shipped).',
    ' • For enum fields, pick the SINGLE closest enum value. If genuinely uncertain or off-distribution, return "unspecified".',
    ' • For free-form details (closing_action_detail, closing_emotional_detail), be 1-12 words max, observational tone.',
    ' • last_dialogue_line: echo the FINAL spoken phrase from beat.dialogue (last 3-12 words). Empty string if non-dialogue beat or VO-only.',
    ' • Never invent props, locations, or characters that are not visible in the image or named in the metadata.',
    '',
    'Return ONLY the JSON object matching the schema. No prose. No markdown.'
  ].join('\n');
}

function _buildBeatMetadataText({ beat, scene, persona }) {
  const lines = [
    `beat_id: ${beat.beat_id || '?'}`,
    `beat_type: ${beat.type || '?'}`,
    `duration_seconds: ${beat.duration_seconds ?? '?'}`
  ];
  if (beat.dialogue) lines.push(`dialogue: "${String(beat.dialogue).slice(0, 400)}"`);
  if (beat.voiceover_text) lines.push(`voiceover_text: "${String(beat.voiceover_text).slice(0, 400)}"`);
  if (beat.emotion) lines.push(`emotion: ${beat.emotion}`);
  if (beat.subtext) lines.push(`subtext: ${String(beat.subtext).slice(0, 240)}`);
  if (beat.expression_notes) lines.push(`expression_notes: ${String(beat.expression_notes).slice(0, 240)}`);
  if (beat.action_notes) lines.push(`action_notes: ${String(beat.action_notes).slice(0, 240)}`);
  if (beat.blocking_notes) lines.push(`blocking_notes: ${String(beat.blocking_notes).slice(0, 240)}`);
  if (beat.camera_move) lines.push(`camera_move: ${beat.camera_move}`);
  if (beat.framing) lines.push(`framing: ${beat.framing}`);
  if (beat.lens) lines.push(`lens: ${beat.lens}`);
  if (beat.emotional_hold === true) lines.push('emotional_hold: true (the camera lingers after speech)');
  if (beat.pace_hint) lines.push(`pace_hint: ${beat.pace_hint}`);

  if (scene) {
    lines.push('');
    lines.push('-- scene context --');
    if (scene.scene_id) lines.push(`scene_id: ${scene.scene_id}`);
    if (scene.location) lines.push(`location: ${scene.location}`);
    if (scene.scene_synopsis) lines.push(`scene_synopsis: ${String(scene.scene_synopsis).slice(0, 240)}`);
  }

  if (persona) {
    lines.push('');
    lines.push('-- persona context --');
    if (persona.name) lines.push(`name: ${persona.name}`);
    if (persona.dramatic_archetype) lines.push(`archetype: ${persona.dramatic_archetype}`);
  }

  return lines.join('\n');
}

function _normalize(parsed, beat) {
  if (!parsed || typeof parsed !== 'object') return null;

  const requiredEnums = [
    'closing_emotional_state',
    'closing_subject_position',
    'closing_action_state',
    'closing_eyeline_target',
    'breath_state'
  ];

  for (const field of requiredEnums) {
    if (typeof parsed[field] !== 'string' || parsed[field].length === 0) {
      // Tolerate model omission by stamping 'unspecified' rather than
      // failing the whole extraction. Downstream consumers treat
      // 'unspecified' as "no constraint".
      parsed[field] = 'unspecified';
    }
  }

  // Backfill last_dialogue_line from the authored beat if model omitted it.
  if (typeof parsed.last_dialogue_line !== 'string' || parsed.last_dialogue_line.length === 0) {
    const authored = beat?.dialogue || beat?.voiceover_text || '';
    if (authored) {
      const tail = String(authored).split(/[.!?]\s*/).filter(Boolean).pop() || authored;
      parsed.last_dialogue_line = String(tail).slice(0, 220);
    } else {
      parsed.last_dialogue_line = '';
    }
  }

  // Trim free-form details defensively (responseSchema maxLength should
  // already enforce, but this is the contract boundary into persistence).
  if (typeof parsed.closing_action_detail === 'string') {
    parsed.closing_action_detail = parsed.closing_action_detail.trim().slice(0, 140);
  }
  if (typeof parsed.closing_emotional_detail === 'string') {
    parsed.closing_emotional_detail = parsed.closing_emotional_detail.trim().slice(0, 140);
  }

  return parsed;
}

async function _fetchAsInlinePart(url, mimeOverride, logPrefix) {
  if (!url || typeof url !== 'string') return null;
  try {
    const resp = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: FETCH_TIMEOUT_MS,
      maxContentLength: 50 * 1024 * 1024,
      validateStatus: (s) => s >= 200 && s < 300
    });
    const mime = mimeOverride || resp.headers?.['content-type'] || _inferMimeFromUrl(url);
    if (!mime || !/^image\//.test(mime)) {
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
  return null;
}

/**
 * Convenience wrapper for the orchestrator: resolve the beat's primary
 * persona from the personas[] array, call extractClosingState, and persist
 * the result onto `beat.closing_state` in-place. Never throws — extractor
 * already returns null on any failure; this wrapper additionally swallows
 * unexpected exceptions so the beat loop never goes down on an extraction
 * problem. The next beat will simply inherit no closing_state and fall
 * back to legacy endframe-only continuity.
 *
 * @param {Object} params
 * @param {Object} params.beat
 * @param {Object} [params.scene]
 * @param {Object[]} [params.personas]
 * @returns {Promise<void>}
 */
export async function attachClosingStateToBeat({ beat, scene = null, personas = [] } = {}) {
  if (!beat?.endframe_url) return;
  const personaIdx = typeof beat.persona_index === 'number'
    ? beat.persona_index
    : (Array.isArray(beat.persona_indexes) && beat.persona_indexes.length > 0
        ? beat.persona_indexes[0]
        : null);
  const persona = (personaIdx != null && Array.isArray(personas))
    ? personas[personaIdx]
    : null;
  try {
    const closingState = await extractClosingState({
      beat,
      scene,
      persona,
      logPrefix: beat.beat_id || '?'
    });
    if (closingState) {
      beat.closing_state = closingState;
    }
  } catch (err) {
    // Defense in depth — should never reach here because the extractor
    // already swallows. Log + swallow if it does.
    logger.warn(`attachClosingStateToBeat threw for beat ${beat?.beat_id}: ${err.message}`);
  }
}

// Exported for tests + introspection.
export const _internals = {
  EMOTIONAL_STATES,
  SUBJECT_POSITIONS,
  ACTION_STATES,
  EYELINE_TARGETS,
  BREATH_STATES,
  CLOSING_STATE_SCHEMA,
  _normalize,
  _inferMimeFromUrl
};

export default { extractClosingState, attachClosingStateToBeat, _internals };
