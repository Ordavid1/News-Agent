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
// V4 Audio Layer Overhaul Day 1 (2026-04-28): default endpoint upgrades from
// `tts/multilingual-v2` → `tts/eleven-v3`. eleven-v3 supports:
//   - Inline performance tags (`[whispering]`, `[sigh]`, `[exhaling]`,
//     `[firmly]`, etc.) — 22 emotion / event / direction tags total. The
//     screenplay layer (DIALOGUE PERFORMANCE TAGS masterclass) authors them
//     inline in beat.dialogue; we pass the string through untouched.
//   - 70+ languages (vs multilingual-v2's 29) — including Hebrew (`he`),
//     Arabic, Russian. Hebrew was unsupported on multilingual-v2.
//   - Slightly higher cost-per-char on premium tiers; same fal.ai pricing.
// Rollback: set `BRAND_STORY_TTS_ENGINE=multilingual_v2` in the environment
// to flip back to the legacy endpoint without code changes.
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
//   - model_id override (eleven_v3 / multilingual_v2 / flash_v2_5 / turbo_v2_5)
//   - language_code (ISO 639-1)
// Returns: { audio: { url, content_type, file_size } } — we download the URL
// into a Buffer so the caller shape is identical to the old direct-REST shape.

import FalAiBaseService from './FalAiBaseService.js';

// V4 Audio Layer Overhaul Day 1 — endpoint slug routing.
//
// `BRAND_STORY_TTS_ENGINE` selects the default fal.ai endpoint:
//   - `eleven_v3` (DEFAULT) → `fal-ai/elevenlabs/tts/eleven-v3`
//        Supports inline performance tags + 70+ languages including Hebrew.
//   - `multilingual_v2`     → `fal-ai/elevenlabs/tts/multilingual-v2`
//        Legacy fallback. No tags, 29 languages, no Hebrew.
//
// The Day 3 Hebrew rollout adds language-driven routing on top of this:
// when persona.language='he' (or any v2-unsupported language), the router
// always picks eleven-v3 regardless of this flag, because v2 cannot handle
// it. This flag controls the DEFAULT path for languages v2 supports.
const ENDPOINT_ELEVENLABS_TTS_ELEVEN_V3 = 'fal-ai/elevenlabs/tts/eleven-v3';
const ENDPOINT_ELEVENLABS_TTS_MULTILINGUAL_V2 = 'fal-ai/elevenlabs/tts/multilingual-v2';

function _selectDefaultEndpoint() {
  const flag = String(process.env.BRAND_STORY_TTS_ENGINE || 'eleven_v3').toLowerCase();
  if (flag === 'multilingual_v2' || flag === 'eleven_multilingual_v2') {
    return ENDPOINT_ELEVENLABS_TTS_MULTILINGUAL_V2;
  }
  // Default + any unrecognised value → eleven-v3 (the new default).
  return ENDPOINT_ELEVENLABS_TTS_ELEVEN_V3;
}

function _selectDefaultModelId() {
  const flag = String(process.env.BRAND_STORY_TTS_ENGINE || 'eleven_v3').toLowerCase();
  if (flag === 'multilingual_v2' || flag === 'eleven_multilingual_v2') {
    return 'eleven_multilingual_v2';
  }
  return 'eleven_v3';
}

// Default "Brian" premade voice — TRUE LAST-RESORT fallback. Should NEVER
// fire in V4 (synthesizeBeat throws on missing voiceId; V4 callers route
// through pickFallbackVoiceIdForPersonaInList in services/v4/VoiceAcquisition.js
// which is gender + persona-aware). If this constant is ever read, it means
// (a) a legacy non-V4 path called synthesize() with undefined voiceId, OR
// (b) the picker returned null because the library is empty (config bug).
//
// Either way it's wrong-by-construction. The synthesize() function logs a
// loud warning when this fires so the upstream miss is visible in production.
const DEFAULT_VOICE_ID = 'nPczCjzI2devNBz1zQrb';

// ElevenLabs speed constraint — same on fal.ai's proxy. Exported for clarity.
const ELEVENLABS_MIN_SPEED = 0.7;
const ELEVENLABS_MAX_SPEED = 1.2;

// V4 Audio Layer Overhaul Day 1 — eleven-v3 inline-tag prep helpers.
//
// `[no_tag_intentional: stoic_baseline]` is a SCREENPLAY-AUTHORSHIP annotation
// recognised by the Validator (counts as opt-in baseline, not a violation) but
// it is NOT a real eleven-v3 tag. It must be stripped before submission so it
// doesn't appear in the rendered audio (eleven-v3 would either pass it through
// as garbled speech or fail). Real eleven-v3 tags in [brackets] are kept as-is
// — eleven-v3's parser handles them.
const NO_TAG_ANNOTATION_RE = /\[no_tag_intentional\s*:\s*[^\]]+\]\s*/gi;

// Strip the internal annotation, leave eleven-v3 tags alone.
function stripInternalAnnotations(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(NO_TAG_ANNOTATION_RE, '').replace(/\s{2,}/g, ' ').trim();
}

// Strip ALL bracket-enclosed tokens from text — used for word-count
// calibration so tagged dialogue ("[barely whispering] I had no choice.")
// is counted as 4 spoken words, not 6 tokens. eleven-v3 renders tags as
// non-spoken prosody instructions; their word weight is effectively zero.
function stripAllBracketTokens(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(/\[[^\]]+\]/g, '').replace(/\s{2,}/g, ' ').trim();
}

class TTSService {
  constructor() {
    // Wrap FalAiBaseService for the queue/submit/poll/download pattern.
    // TTS is fast (~1-3s) so we use a tighter poll interval and shorter max wait.
    // Day 1 of audio-layer overhaul: endpoint slug is selected from env at
    // module construction so a single restart flip-flops between eleven-v3
    // (default) and multilingual-v2 (rollback). Per-request override via
    // options.modelId still works for callers that want to force a specific
    // model for one synthesis call.
    this.base = new FalAiBaseService({
      modelSlug: _selectDefaultEndpoint(),
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
      voiceId: voiceIdInput,
      modelId, // optional, fal.ai defaults to multilingual_v2 on this endpoint
      language,
      outputFormat = 'mp3_44100_128',
      stability = 0.5,
      similarityBoost = 0.75,
      style = 0,
      speed = 1.0
    } = options;

    // Cast Bible follow-up (2026-04-28) — voiceIdInput should ALWAYS be set
    // by V4 callers (per the picker contract in VoiceAcquisition.js). If we
    // land here without one it's an upstream miss. Loud warn so the
    // production log shows the offending caller stack. Falls through to the
    // literal Brian voice ONLY as a true last resort.
    let voiceId;
    if (voiceIdInput) {
      voiceId = voiceIdInput;
    } else {
      voiceId = DEFAULT_VOICE_ID;
      this.base.logger.warn(
        `[TTSService] synthesize() called without a voiceId — falling back to literal DEFAULT_VOICE_ID=${DEFAULT_VOICE_ID} ("Brian", male). ` +
        `This is wrong-by-construction: the caller should resolve a gender-correct voice via ` +
        `pickFallbackVoiceIdForPersonaInList() in services/v4/VoiceAcquisition.js BEFORE calling synthesize. ` +
        `Stack: ${(new Error().stack || '').split('\n').slice(2, 5).join(' | ')}`
      );
    }

    // V4 Day 1 — strip the internal `[no_tag_intentional: ...]` annotation
    // before submission. eleven-v3 performance tags ([whispering], [sigh],
    // etc.) are kept verbatim because eleven-v3 parses them; the
    // no_tag_intentional annotation is a screenplay-authorship marker that
    // would otherwise be rendered as garbled speech.
    const textForSubmission = stripInternalAnnotations(text);

    // fal.ai ElevenLabs TTS request payload.
    // Spec: https://fal.ai/models/fal-ai/elevenlabs/tts/eleven-v3
    // NOTE: fal.ai proxies to ElevenLabs directly so field names match the
    // ElevenLabs TTS API but are flattened (no nested voice_settings).
    const inputPayload = {
      text: textForSubmission,
      voice: voiceId,
      stability,
      similarity_boost: similarityBoost,
      style,
      speed: Math.max(ELEVENLABS_MIN_SPEED, Math.min(ELEVENLABS_MAX_SPEED, speed))
    };
    if (modelId) inputPayload.model_id = modelId;
    if (language) inputPayload.language_code = language;

    const textLength = textForSubmission.length;
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
   *   - default modelId follows BRAND_STORY_TTS_ENGINE (eleven_v3 default;
   *     eleven_multilingual_v2 when the rollback flag is set)
   *
   * @param {Object} params
   * @param {string} params.text - the dialogue line (may carry inline eleven-v3 tags)
   * @param {string} params.voiceId - persona's ElevenLabs voice id
   * @param {number} [params.durationTarget] - optional target duration in seconds
   * @param {Object} [params.options]
   * @param {string} [params.options.modelId] - default = active engine (eleven_v3 / eleven_multilingual_v2)
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
      modelId = _selectDefaultModelId(),
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
      // V4 Day 1 — count SPOKEN words only. Tagged dialogue like
      // "[barely whispering] I had no choice." is 4 spoken words, not 6.
      // eleven-v3 renders tags as prosody instructions (zero spoken weight);
      // counting them inflates naturalSec and over-clamps the speed.
      const spokenText = stripAllBracketTokens(text);
      const wordCount = spokenText.length > 0
        ? spokenText.trim().split(/\s+/).filter(Boolean).length
        : 1; // safety floor for tag-only edge case
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
