// services/DialogueTTSService.js
// Multi-speaker dialogue endpoint wrapper for V4 Brand Story.
//
// Wraps `fal-ai/elevenlabs/text-to-dialogue/eleven-v3` — the ElevenLabs v3
// dialogue endpoint that synthesizes multiple speakers in a SINGLE call with
// SHARED PROSODIC CONTEXT. This is architecturally distinct from the regular
// TTS endpoint (`tts/eleven-v3` / `tts/multilingual-v2`) which handles one
// speaker per call — turn-taking, response-to-emotion prosody, and natural
// breath rhythm between speakers are LEARNED across the dialogue rather than
// stitched mechanically post-hoc.
//
// Used by the V4 GROUP_DIALOGUE_TWOSHOT beat type. SHOT_REVERSE_SHOT does NOT
// use this endpoint — it stays on per-beat single-speaker TTS so the editorial
// cut rhythm is owned by the screenplay/director, not the model. See the
// V4 Audio Layer Overhaul plan (Day 2) for the full rationale.
//
// External shape mirrors TTSService:
//   isAvailable()                      — true when FAL_GCS_API_KEY is set
//   synthesizeDialogue({ inputs, ... }) — returns { audioBuffer, format,
//                                                   actualDurationSec }
//
// Pre-flight constraints enforced by this service (NOT by the validator —
// validator catches them at screenplay-write time, this service catches at
// generation time so a hand-edited beat can't bypass them):
//   - inputs[].text total ≤ 2,000 chars (ElevenLabs hard limit)
//   - inputs[] unique voices ≤ 10 (ElevenLabs SDK limit)
//   - language_code is single-string (mixed-language not supported by the
//     endpoint; caller must split into per-beat single-speaker calls)
//
// Spec: https://fal.ai/models/fal-ai/elevenlabs/text-to-dialogue/eleven-v3
// Pricing: $0.10 per 1,000 chars (same per-char rate as multilingual-v2 TTS)

import FalAiBaseService from './FalAiBaseService.js';

const ENDPOINT_DIALOGUE_ELEVEN_V3 = 'fal-ai/elevenlabs/text-to-dialogue/eleven-v3';

// ElevenLabs v3 dialogue endpoint hard limits (per official docs):
//   - 2,000 chars total across all inputs[].text
//   - 10 unique voices per request
//   - stability is quantized to 0.0 / 0.5 / 1.0 (other values round to nearest)
export const DIALOGUE_MAX_TOTAL_CHARS = 2000;
export const DIALOGUE_MAX_UNIQUE_VOICES = 10;
export const DIALOGUE_VALID_STABILITY = [0.0, 0.5, 1.0];

// V4 internal annotation — same one TTSService strips. Re-defined here so this
// service stays self-contained (no cross-service import for a 1-line regex).
const NO_TAG_ANNOTATION_RE = /\[no_tag_intentional\s*:\s*[^\]]+\]\s*/gi;

function stripInternalAnnotations(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(NO_TAG_ANNOTATION_RE, '').replace(/\s{2,}/g, ' ').trim();
}

// Quantize stability to the nearest valid value (0.0 / 0.5 / 1.0). The
// endpoint silently rounds, but we surface the round in logs so callers
// can tell their 0.6 became 0.5.
function _quantizeStability(s, logger) {
  if (typeof s !== 'number' || !Number.isFinite(s)) return 0.5;
  let nearest = DIALOGUE_VALID_STABILITY[0];
  let delta = Math.abs(s - nearest);
  for (const v of DIALOGUE_VALID_STABILITY) {
    const d = Math.abs(s - v);
    if (d < delta) { nearest = v; delta = d; }
  }
  if (Math.abs(s - nearest) > 0.01 && logger) {
    logger.info(`stability ${s} quantized to ${nearest} (eleven-v3 dialogue accepts only ${DIALOGUE_VALID_STABILITY.join(' / ')})`);
  }
  return nearest;
}

/**
 * Validate the dialogue input list before submission. Throws on hard
 * violations so the caller (typically GroupTwoShotGenerator) can fall back
 * to per-beat single-speaker TTS instead of getting a 422 from fal.ai.
 *
 * @param {Array<{text: string, voice: string}>} inputs
 * @returns {{ totalChars: number, uniqueVoiceCount: number }}
 */
export function validateDialogueInputs(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error('DialogueTTSService: inputs[] must be a non-empty array of {text, voice}');
  }
  let totalChars = 0;
  const voiceSet = new Set();
  for (let i = 0; i < inputs.length; i++) {
    const entry = inputs[i] || {};
    if (typeof entry.text !== 'string' || entry.text.trim().length === 0) {
      throw new Error(`DialogueTTSService: inputs[${i}].text is required and must be a non-empty string`);
    }
    if (typeof entry.voice !== 'string' || entry.voice.trim().length === 0) {
      throw new Error(`DialogueTTSService: inputs[${i}].voice is required (voice name or 21-char ID)`);
    }
    // Use the SUBMITTED text length (after annotation strip) for budget math.
    totalChars += stripInternalAnnotations(entry.text).length;
    voiceSet.add(entry.voice);
  }
  if (totalChars > DIALOGUE_MAX_TOTAL_CHARS) {
    throw new Error(
      `DialogueTTSService: total inputs[].text length is ${totalChars} chars — exceeds ` +
      `${DIALOGUE_MAX_TOTAL_CHARS}-char hard limit. Split the dialogue into two consecutive ` +
      `beats with text partitioned across them, or fall back to per-beat TTS.`
    );
  }
  if (voiceSet.size > DIALOGUE_MAX_UNIQUE_VOICES) {
    throw new Error(
      `DialogueTTSService: ${voiceSet.size} unique voices — exceeds ${DIALOGUE_MAX_UNIQUE_VOICES}-voice ` +
      `limit. Reduce the cast in this beat or fall back to per-beat TTS.`
    );
  }
  return { totalChars, uniqueVoiceCount: voiceSet.size };
}

class DialogueTTSService {
  constructor() {
    // Same queue/poll knobs as TTSService — dialogue is fast (~2-5s).
    this.base = new FalAiBaseService({
      modelSlug: ENDPOINT_DIALOGUE_ELEVEN_V3,
      displayName: 'DialogueTTSService',
      pollIntervalMs: 2000,
      maxPollDurationMs: 180000, // 3 min hard cap (slightly longer than single-speaker TTS)
      submitTimeoutMs: 30000
    });
  }

  /** @returns {boolean} true if FAL_GCS_API_KEY is configured */
  isAvailable() {
    return this.base.isAvailable();
  }

  /**
   * Synthesize a multi-speaker dialogue exchange in a single call.
   *
   * @param {Object} params
   * @param {Array<{text: string, voice: string}>} params.inputs
   *   DialogueBlock list — each entry is one turn:
   *     { text: '[firmly] We are leaving now.',  voice: 'EXAVITQu4vr4xnSDxMaL' }
   *     { text: '[exhaling] I know.',             voice: '21m00Tcm4TlvDq8ikWAM' }
   *   Voice is either a preset name ("Aria") OR a 21-char ElevenLabs voice ID.
   *   Inline eleven-v3 performance tags are passed through verbatim; the
   *   internal `[no_tag_intentional: ...]` annotation is stripped pre-submit.
   *
   * @param {Object} [params.options]
   * @param {number} [params.options.stability=0.5] — must round to 0.0/0.5/1.0
   * @param {boolean} [params.options.useSpeakerBoost=true]
   * @param {string}  [params.options.languageCode] — ISO 639-1; single language for the whole call
   * @param {number}  [params.options.seed]
   * @param {boolean} [params.options.audioIsolation=false]
   * @param {string}  [params.options.applyTextNormalization='auto']
   * @param {string}  [params.options.outputFormat='mp3_44100_128']
   *
   * @returns {Promise<{audioBuffer: Buffer, format: string, actualDurationSec: number, seed?: number}>}
   *   audioBuffer: combined MP3 with all turns interleaved
   *   actualDurationSec: unrounded float from buffer-size heuristic (mp3@128kbps: bytes/16000)
   */
  async synthesizeDialogue({ inputs, options = {} }) {
    if (!this.base.isAvailable()) throw new Error('FAL_GCS_API_KEY is not configured');

    // Validates AND throws on hard-limit violations so we don't burn a
    // fal.ai credit on a request the endpoint will reject.
    const { totalChars, uniqueVoiceCount } = validateDialogueInputs(inputs);

    const {
      stability: stabilityRaw = 0.5,
      useSpeakerBoost = true,
      languageCode,
      seed,
      audioIsolation = false,
      applyTextNormalization = 'auto',
      outputFormat = 'mp3_44100_128'
    } = options;

    // Strip our internal annotations from each input.text — the eleven-v3
    // tags ([whispering], [sigh], etc.) survive verbatim because eleven-v3
    // parses them; only the screenplay-authorship marker is removed.
    const cleanedInputs = inputs.map(i => ({
      text: stripInternalAnnotations(i.text),
      voice: i.voice
    }));

    const stability = _quantizeStability(stabilityRaw, this.base.logger);

    const inputPayload = {
      inputs: cleanedInputs,
      stability,
      use_speaker_boost: useSpeakerBoost,
      audio_isolation: audioIsolation,
      apply_text_normalization: applyTextNormalization,
      output_format: outputFormat
    };
    if (languageCode) inputPayload.language_code = languageCode;
    if (typeof seed === 'number') inputPayload.seed = seed;

    this.base.logger.info(
      `synthesizeDialogue — ${cleanedInputs.length} turn(s), ${uniqueVoiceCount} unique voice(s), ` +
      `${totalChars} chars total, stability=${stability}` +
      (languageCode ? `, lang=${languageCode}` : '')
    );

    const startTime = Date.now();

    let rawResult;
    try {
      rawResult = await this.base.run(inputPayload);
    } catch (err) {
      this.base.logger.error(`fal.ai dialogue generation failed: ${err.message}`);
      throw err;
    }

    const audioUrl = rawResult?.audio?.url;
    if (!audioUrl) {
      this.base.logger.error(`fal.ai dialogue endpoint returned no audio URL: ${JSON.stringify(rawResult).slice(0, 300)}`);
      throw new Error('fal.ai eleven-v3 dialogue endpoint did not return an audio URL');
    }

    const audioBuffer = await this.base.downloadToBuffer(audioUrl, 'audio');
    if (audioBuffer.length === 0) {
      throw new Error('fal.ai eleven-v3 dialogue endpoint returned empty audio');
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    // mp3@128kbps heuristic: bytes / 16000 ≈ seconds. Same heuristic as TTSService.
    const actualDurationSec = audioBuffer.length / 16000;

    this.base.logger.info(
      `dialogue audio ready in ${elapsed}s — ${(audioBuffer.length / 1024).toFixed(0)}KB, ` +
      `~${actualDurationSec.toFixed(1)}s`
    );

    return {
      audioBuffer,
      format: outputFormat.startsWith('mp3') ? 'mp3' : outputFormat.split('_')[0],
      actualDurationSec,
      seed: rawResult?.seed
    };
  }
}

const dialogueTTSService = new DialogueTTSService();
export default dialogueTTSService;
export { DialogueTTSService };
