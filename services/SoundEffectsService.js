// services/SoundEffectsService.js
// ElevenLabs Sound Effects wrapper — now routed through fal.ai via FAL_GCS_API_KEY.
//
// V4 migration (2026-04-11): the direct ElevenLabs REST path
// (api.elevenlabs.io/v1/sound-generation) is replaced by the fal.ai proxy
// endpoint `fal-ai/elevenlabs/sound-effects`. Consolidates V4's vendor
// surface to fal.ai + Google + ElevenLabs voice library only.
//
// Why SFX exist at all:
//   Veo 3.1 generates rich native ambient audio (wind, traffic, room tone)
//   for free. Kling and OmniHuman do not — their audio output is often basic
//   or missing entirely. For an episode that mixes Veo beats with Kling/
//   OmniHuman beats, the audio layer is uneven: cinematic atmosphere on Veo
//   shots and silence on the rest. This service renders per-beat SFX beds
//   from the beat's `ambient_sound` field, which V4 post-production then
//   mixes under the Kling/OmniHuman beat at -22dB.
//
// External API preserved 1:1 — `generate({ prompt, durationSec, promptInfluence })`
// still returns `{ audioBuffer, durationSec, prompt }`, and the static
// `SoundEffectsService.needsSfxOverlay(modelUsed)` helper is unchanged.
//
// fal.ai ElevenLabs Sound Effects input:
//   - text (prompt, required)
//   - duration_seconds (optional; fal.ai allows the model to pick if omitted)
//   - prompt_influence (0-1, optional)
// fal.ai response shape: { audio: { url, content_type, file_size } }

import FalAiBaseService from './FalAiBaseService.js';

// fal.ai DEPRECATED `fal-ai/elevenlabs/sound-effects` on 2026 — that endpoint
// is pinned to the stale `eleven_text_to_sound_v0` model which ElevenLabs
// rejects with a 400 `invalid_model_id`. The replacement is
// `fal-ai/elevenlabs/sound-effects/v2` which uses ElevenLabs' current
// sound-effects model. Verified 2026-04-21 against fal.ai's OpenAPI schema;
// V1 returned 400 for every call during full-episode generation smoke tests.
// Field shape is identical (text / duration_seconds / prompt_influence /
// output_format / loop) so no payload changes needed.
const ENDPOINT_ELEVENLABS_SFX = 'fal-ai/elevenlabs/sound-effects/v2';

// ElevenLabs Sound Generation limits — same via fal.ai proxy.
const MIN_DURATION_SEC = 0.5;
const MAX_DURATION_SEC = 22;

// Models that benefit from SFX overlay (Kling and OmniHuman are weak on ambient).
// Veo beats are skipped because Veo's native ambient is already strong.
const MODELS_NEEDING_SFX = [
  'kling-o3-omni-standard',
  'kling-o3-omni-pro',
  'kling-v3-pro',
  'kling-v3-pro-text',
  'kling-v3-pro-multishot',
  'omnihuman-1.5',
  'mode-a',
  'mode-b'
];

class SoundEffectsService {
  constructor() {
    // SFX generation is fast (1-3s). Tight poll, short max wait.
    this.base = new FalAiBaseService({
      modelSlug: ENDPOINT_ELEVENLABS_SFX,
      displayName: 'SoundEffectsService',
      pollIntervalMs: 2000,
      maxPollDurationMs: 120000, // 2 min hard cap
      submitTimeoutMs: 30000
    });
  }

  isAvailable() {
    return this.base.isAvailable();
  }

  /**
   * Determine whether a beat (by its model_used string) benefits from a
   * generated SFX overlay. Veo beats are skipped because Veo's native ambient
   * is already strong; Kling/OmniHuman beats get the overlay.
   *
   * @param {string} modelUsed - the beat's model_used string
   * @returns {boolean}
   */
  static needsSfxOverlay(modelUsed) {
    if (!modelUsed) return false;
    const lowered = modelUsed.toLowerCase();
    if (lowered.includes('veo')) return false;
    return MODELS_NEEDING_SFX.some(prefix => lowered.includes(prefix));
  }

  /**
   * Generate a sound effect / ambient bed from a text prompt via fal.ai.
   *
   * @param {Object} params
   * @param {string} params.prompt - SFX description (e.g. "soft glass clink, faint room tone")
   * @param {number} [params.durationSec=4] - clamped to [0.5, 22]
   * @param {number} [params.promptInfluence=0.45] - 0..1, lower = more creative
   * @returns {Promise<{audioBuffer: Buffer, durationSec: number, prompt: string}>}
   */
  async generate({ prompt, durationSec = 4, promptInfluence = 0.45 }) {
    if (!this.base.isAvailable()) throw new Error('FAL_GCS_API_KEY is not configured');
    if (!prompt || prompt.trim().length === 0) {
      throw new Error('SoundEffectsService.generate: prompt required');
    }

    const clampedDuration = Math.max(MIN_DURATION_SEC, Math.min(MAX_DURATION_SEC, durationSec));
    if (clampedDuration !== durationSec) {
      this.base.logger.warn(`duration ${durationSec}s clamped to ${clampedDuration}s for SFX limits`);
    }

    this.base.logger.info(`generating SFX via fal.ai (${clampedDuration.toFixed(1)}s): "${prompt.slice(0, 60)}..."`);
    const startTime = Date.now();

    // fal.ai ElevenLabs SFX v2 payload. No model_id field exists on the
    // endpoint — model selection is implicit in the endpoint path
    // (`fal-ai/elevenlabs/sound-effects/v2` uses text_to_sound_v2 internally;
    // the old `fal-ai/elevenlabs/sound-effects` was pinned to v0).
    // Passing model_id to v1 had no effect (endpoint ignored the field)
    // which is why the first fix attempt on 2026-04-21 still 400'd.
    const inputPayload = {
      text: prompt,
      duration_seconds: clampedDuration,
      prompt_influence: promptInfluence
    };

    let rawResult;
    try {
      rawResult = await this.base.run(inputPayload);
    } catch (err) {
      this.base.logger.error(`fal.ai SFX generation failed: ${err.message}`);
      throw err;
    }

    const audioUrl = rawResult?.audio?.url;
    if (!audioUrl) {
      this.base.logger.error(`fal.ai SFX returned no audio URL: ${JSON.stringify(rawResult).slice(0, 300)}`);
      throw new Error('fal.ai ElevenLabs Sound Effects did not return an audio URL');
    }

    const audioBuffer = await this.base.downloadToBuffer(audioUrl, 'audio');
    if (audioBuffer.length === 0) throw new Error('fal.ai ElevenLabs SFX returned empty audio');

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    this.base.logger.info(`SFX ready in ${elapsed}s — ${(audioBuffer.length / 1024).toFixed(0)}KB`);

    return {
      audioBuffer,
      durationSec: clampedDuration,
      prompt
    };
  }
}

const soundEffectsService = new SoundEffectsService();
export default soundEffectsService;
export { SoundEffectsService };
