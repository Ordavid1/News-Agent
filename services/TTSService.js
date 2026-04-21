// services/TTSService.js
// ElevenLabs TTS wrapper — now routed through fal.ai via FAL_GCS_API_KEY.
//
// V4 migration (2026-04-11): the direct ElevenLabs REST path
// (api.elevenlabs.io/v1/text-to-speech/{voiceId}) is replaced by the fal.ai
// proxy endpoint `fal-ai/elevenlabs/tts/multilingual-v2`. This consolidates
// V4's vendor surface to three providers:
//   - fal.ai (all generation — video, image, audio)
//   - Google (Vertex Gemini for screenplay + Vertex Veo for first/last frame)
//   - ElevenLabs (voice library browsing only — the preset catalog isn't on fal.ai)
//
// The external API shape is preserved exactly — synthesize() and
// synthesizeBeat() still return the same { audioBuffer, durationEstimate,
// actualDurationSec, format } shape so existing call sites in
// CinematicDialogueGenerator, VoiceoverBRollGenerator, TalkingHeadCloseupGenerator,
// BrandStoryService, etc. don't need to change.
//
// fal.ai ElevenLabs TTS supports:
//   - voice (voice_id string from ElevenLabs preset library)
//   - stability, similarity_boost, style (all 0-1)
//   - speed (0.7-1.2 — same clamp as the direct ElevenLabs API)
//   - model_id override (multilingual_v2 / flash_v2_5 / turbo_v2_5)
//   - language_code (ISO 639-1)
// Returns: { audio: { url, content_type, file_size } } — we download the URL
// into a Buffer so the caller shape is identical to the old direct-REST shape.

import FalAiBaseService from './FalAiBaseService.js';

// fal.ai TTS endpoint — multilingual v2 is the highest-quality ElevenLabs model
// on fal.ai, same model as the direct `eleven_multilingual_v2` path we used
// before. Flash / Turbo are available as overrides via options.modelId.
const ENDPOINT_ELEVENLABS_TTS_MULTILINGUAL_V2 = 'fal-ai/elevenlabs/tts/multilingual-v2';

// Default "Brian" premade voice — safe fallback, male, American, narrative-friendly.
// Used ONLY when no voiceId is passed AND no persona voice is configured.
// V4 hard-fails before reaching this path (see VoiceAcquisition) to prevent
// silent gender mismatches, but keeping the default for non-V4 legacy paths.
const DEFAULT_VOICE_ID = 'nPczCjzI2devNBz1zQrb';

// ElevenLabs speed constraint — same on fal.ai's proxy. Exported for clarity.
const ELEVENLABS_MIN_SPEED = 0.7;
const ELEVENLABS_MAX_SPEED = 1.2;

class TTSService {
  constructor() {
    // Wrap FalAiBaseService for the queue/submit/poll/download pattern.
    // TTS is fast (~1-3s) so we use a tighter poll interval and shorter max wait.
    this.base = new FalAiBaseService({
      modelSlug: ENDPOINT_ELEVENLABS_TTS_MULTILINGUAL_V2,
      displayName: 'TTSService',
      pollIntervalMs: 2000,
      maxPollDurationMs: 120000, // 2 min hard cap
      submitTimeoutMs: 30000
    });
  }

  /**
   * Check if the service is available (FAL_GCS_API_KEY is set).
   */
  isAvailable() {
    return this.base.isAvailable();
  }

  /**
   * Synthesize text to audio using fal.ai's ElevenLabs TTS proxy.
   * Returns the raw audio buffer so the caller can upload to Supabase.
   *
   * External shape preserved 1:1 with the old direct-REST implementation.
   *
   * @param {Object} params
   * @param {string} params.text - Text to synthesize
   * @param {Object} [params.options]
   * @param {string} [params.options.voiceId] - ElevenLabs voice ID
   * @param {string} [params.options.modelId] - 'eleven_multilingual_v2' | 'eleven_flash_v2_5' | 'eleven_turbo_v2_5'
   * @param {string} [params.options.language] - ISO 639-1 language code (e.g., 'en', 'es', 'he')
   * @param {string} [params.options.outputFormat='mp3_44100_128'] - accepted for API compat (fal.ai always returns mp3)
   * @param {number} [params.options.stability=0.5]
   * @param {number} [params.options.similarityBoost=0.75]
   * @param {number} [params.options.style=0]
   * @param {number} [params.options.speed=1.0] - [0.7, 1.2] — clamped silently, caller should pre-clamp
   * @returns {Promise<{audioBuffer: Buffer, format: string, durationEstimate: number}>}
   */
  async synthesize({ text, options = {} }) {
    if (!this.base.isAvailable()) throw new Error('FAL_GCS_API_KEY is not configured');
    if (!text || text.trim().length === 0) throw new Error('text is required for TTS synthesis');

    const {
      voiceId = DEFAULT_VOICE_ID,
      modelId, // optional, fal.ai defaults to multilingual_v2 on this endpoint
      language,
      outputFormat = 'mp3_44100_128',
      stability = 0.5,
      similarityBoost = 0.75,
      style = 0,
      speed = 1.0
    } = options;

    // fal.ai ElevenLabs TTS request payload.
    // Spec: https://fal.ai/models/fal-ai/elevenlabs/tts/multilingual-v2
    // NOTE: fal.ai proxies to ElevenLabs directly so field names match the
    // ElevenLabs TTS API but are flattened (no nested voice_settings).
    const inputPayload = {
      text,
      voice: voiceId,
      stability,
      similarity_boost: similarityBoost,
      style,
      speed: Math.max(ELEVENLABS_MIN_SPEED, Math.min(ELEVENLABS_MAX_SPEED, speed))
    };
    if (modelId) inputPayload.model_id = modelId;
    if (language) inputPayload.language_code = language;

    const textLength = text.length;
    this.base.logger.info(`Synthesizing TTS via fal.ai — ${textLength} chars, voice: ${voiceId}${modelId ? `, model: ${modelId}` : ''}`);

    const startTime = Date.now();

    // Submit → poll → raw result
    let rawResult;
    try {
      rawResult = await this.base.run(inputPayload);
    } catch (err) {
      this.base.logger.error(`fal.ai TTS generation failed: ${err.message}`);
      throw err;
    }

    // fal.ai ElevenLabs TTS response shape: { audio: { url, content_type, file_size? } }
    // The audio URL points at fal.ai's CDN; we download it into a Buffer to
    // preserve the legacy { audioBuffer } return shape.
    const audioUrl = rawResult?.audio?.url;
    if (!audioUrl) {
      this.base.logger.error(`fal.ai TTS returned no audio URL: ${JSON.stringify(rawResult).slice(0, 300)}`);
      throw new Error('fal.ai ElevenLabs TTS did not return an audio URL');
    }

    const audioBuffer = await this.base.downloadToBuffer(audioUrl, 'audio');

    if (audioBuffer.length === 0) {
      throw new Error('fal.ai ElevenLabs TTS returned empty audio');
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Estimate duration from buffer size.
    // MP3 at 128 kbps: bytes / 16000 ≈ seconds — same heuristic as the direct
    // ElevenLabs path, kept identical so downstream call sites that use
    // `durationEstimate` for sizing (TTSService callers in v3 pipelines etc.)
    // behave the same.
    const estimatedDuration = audioBuffer.length / 16000;

    this.base.logger.info(`TTS audio ready in ${elapsed}s — ${(audioBuffer.length / 1024).toFixed(0)}KB, ~${estimatedDuration.toFixed(1)}s estimated`);

    return {
      audioBuffer,
      format: outputFormat.startsWith('mp3') ? 'mp3' : outputFormat.split('_')[0],
      durationEstimate: Math.round(estimatedDuration)
    };
  }

  /**
   * V4 per-beat synthesis. Each beat has its own dialogue line and persona
   * voice, so the V4 pipeline calls this once per dialogue beat (not one
   * full-episode narration like v3).
   *
   * Logic identical to the old direct-REST version:
   *   - returns actualDurationSec as unrounded float so beat generators
   *     can pass exact lengths to video generators (first/last frame, etc.)
   *   - supports optional durationTarget for auto-calibration of speed
   *     against the fixed beat window
   *   - uses eleven_multilingual_v2 by default for short-line quality
   *
   * @param {Object} params
   * @param {string} params.text - the dialogue line
   * @param {string} params.voiceId - persona's ElevenLabs voice id
   * @param {number} [params.durationTarget] - optional target duration in seconds
   * @param {Object} [params.options]
   * @param {string} [params.options.modelId='eleven_multilingual_v2']
   * @param {string} [params.options.language]
   * @param {number} [params.options.stability=0.5]
   * @param {number} [params.options.similarityBoost=0.75]
   * @param {number} [params.options.speed] - manual speed override
   * @returns {Promise<{audioBuffer: Buffer, actualDurationSec: number, format: string}>}
   */
  async synthesizeBeat({ text, voiceId, durationTarget, options = {} }) {
    if (!this.base.isAvailable()) throw new Error('FAL_GCS_API_KEY is not configured');
    if (!text || text.trim().length === 0) throw new Error('text is required for synthesizeBeat');
    if (!voiceId) throw new Error('voiceId is required for synthesizeBeat');

    const {
      modelId = 'eleven_multilingual_v2',
      language,
      stability = 0.5,
      similarityBoost = 0.75,
      speed: speedOverride,
      paceHint,       // V4: 'slow' | 'normal' | 'fast' — character-consistent pacing nudge
      emotionalHold   // V4: boolean — the line ends on a loaded silence; don't pace-pad
    } = options;

    // Auto-calibrate speed to hit durationTarget if provided.
    // Natural English speech ≈ 2.5 words/sec; Hebrew ≈ 2.0 wps.
    // V4 emotional_hold: skip auto-calibration — the line is INTENTIONALLY
    // short relative to the beat; the remaining duration is director-planned
    // silence (post-production preserves it via emotional_hold honouring).
    let speed = 1.0;
    if (typeof speedOverride === 'number') {
      speed = speedOverride;
    } else if (emotionalHold) {
      speed = 1.0;
      this.base.logger.info(`emotional_hold: skipping speed auto-calibration — intentional trailing silence preserved`);
    } else if (typeof durationTarget === 'number' && durationTarget > 0) {
      const wordsPerSec = (language && language.startsWith('he')) ? 2.0 : 2.5;
      const wordCount = text.trim().split(/\s+/).length;
      const naturalSec = Math.max(wordCount / wordsPerSec, 0.5);
      const rawSpeed = naturalSec / durationTarget;

      // ElevenLabs speed range [0.7, 1.2] — fal.ai proxy enforces the same
      // range. Caught on 2026-04-11 Day 0 smoke test where 1.53x returned a
      // 400 from the direct API; fal.ai's proxy would surface the same error.
      speed = Math.max(ELEVENLABS_MIN_SPEED, Math.min(ELEVENLABS_MAX_SPEED, rawSpeed));

      // V4 pace_hint: nudge within the clamp to match character voice style.
      // Applied AFTER duration clamp so we never violate ElevenLabs' limits.
      //   'slow' → bias toward 0.9x of whatever speed the duration solved for
      //   'fast' → bias toward 1.1x
      //   'normal' or unset → unchanged
      if (paceHint === 'slow') {
        speed = Math.max(ELEVENLABS_MIN_SPEED, Math.min(ELEVENLABS_MAX_SPEED, speed * 0.9));
      } else if (paceHint === 'fast') {
        speed = Math.max(ELEVENLABS_MIN_SPEED, Math.min(ELEVENLABS_MAX_SPEED, speed * 1.1));
      }

      if (Math.abs(speed - rawSpeed) > 0.01) {
        const achievableDurationSec = naturalSec / speed;
        this.base.logger.warn(
          `auto-speed clamp: ${wordCount} words want ${rawSpeed.toFixed(2)}x to hit ${durationTarget}s, ` +
          `clamped to ${speed.toFixed(2)}x (ElevenLabs limit). Resulting duration ~${achievableDurationSec.toFixed(2)}s. ` +
          `Reduce word count or extend beat duration to match.`
        );
      } else {
        this.base.logger.info(
          `auto-speed: ${wordCount} words → ~${naturalSec.toFixed(2)}s natural → target ${durationTarget}s → speed ${speed.toFixed(2)}x`
        );
      }
    }

    const result = await this.synthesize({
      text,
      options: {
        voiceId,
        modelId,
        language,
        stability,
        similarityBoost,
        speed,
        outputFormat: 'mp3_44100_128'
      }
    });

    // Replace the rounded durationEstimate with the unrounded float for precise
    // beat-length matching downstream.
    const actualDurationSec = result.audioBuffer.length / 16000;

    return {
      audioBuffer: result.audioBuffer,
      actualDurationSec,
      format: result.format
    };
  }
}

// Singleton export — preserves the v3/v4 call sites that do
//   `import ttsService from './services/TTSService.js'`
const ttsService = new TTSService();
export default ttsService;
export { TTSService };
