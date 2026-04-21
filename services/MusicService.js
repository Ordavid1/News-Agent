// services/MusicService.js
// ElevenLabs Music wrapper — now routed through fal.ai via FAL_GCS_API_KEY.
//
// V4 migration (2026-04-11): the direct ElevenLabs REST path
// (api.elevenlabs.io/v1/music) is replaced by the fal.ai proxy endpoint
// `fal-ai/elevenlabs/music`. Consolidates V4's vendor surface to fal.ai +
// Google + ElevenLabs voice library only.
//
// The V4 post-production pipeline uses one music bed per episode:
//   1. Gemini emits `episode.music_bed_intent` as a music brief
//      (e.g. "low brooding strings, building to a crescendo at the cliffhanger")
//   2. MusicService.generateMusicBed() calls fal.ai ElevenLabs Music with the brief
//      and the episode's target duration
//   3. Returned MP3 is uploaded to Supabase → episode.music_bed_url
//   4. Post-production mixes the bed under all beats at ~-18dB, ducking to
//      ~-24dB during dialogue beats via ffmpeg volume expressions
//
// External API preserved 1:1 — `generateMusicBed({ musicBedIntent, durationSec })`
// still returns `{ audioBuffer, durationSec, format, prompt }`.
//
// fal.ai ElevenLabs Music input:
//   - prompt (required)
//   - music_length_ms (required, 10_000..300_000)
//   - output_format (optional, default mp3_44100_128)
// fal.ai response shape: { audio: { url, content_type, file_size } }

import FalAiBaseService from './FalAiBaseService.js';

const ENDPOINT_ELEVENLABS_MUSIC = 'fal-ai/elevenlabs/music';

// ElevenLabs Music limits — same on the direct API and the fal.ai proxy.
const MIN_DURATION_MS = 10_000;   // 10s minimum
const MAX_DURATION_MS = 300_000;  // 5 min maximum
const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128';

class MusicService {
  constructor() {
    // Music generation takes 5-30s — use a tighter poll than video.
    this.base = new FalAiBaseService({
      modelSlug: ENDPOINT_ELEVENLABS_MUSIC,
      displayName: 'MusicService',
      pollIntervalMs: 3000,
      maxPollDurationMs: 300000, // 5 min hard cap
      submitTimeoutMs: 30000
    });
  }

  isAvailable() {
    return this.base.isAvailable();
  }

  /**
   * Generate a music bed for an episode via fal.ai ElevenLabs Music.
   *
   * @param {Object} params
   * @param {string} params.musicBedIntent - Gemini-generated music brief
   * @param {number} params.durationSec - target length in seconds
   * @param {Object} [params.options]
   * @param {string} [params.options.outputFormat='mp3_44100_128']
   * @returns {Promise<{audioBuffer: Buffer, durationSec: number, format: string, prompt: string}>}
   */
  async generateMusicBed({ musicBedIntent, durationSec, options = {} }) {
    if (!this.base.isAvailable()) throw new Error('FAL_GCS_API_KEY is not configured');
    if (!musicBedIntent || musicBedIntent.trim().length === 0) {
      throw new Error('musicBedIntent is required for music generation');
    }
    if (!durationSec || durationSec <= 0) {
      throw new Error('durationSec must be a positive number');
    }

    const requestedMs = Math.round(durationSec * 1000);
    const durationMs = Math.max(MIN_DURATION_MS, Math.min(MAX_DURATION_MS, requestedMs));
    if (durationMs !== requestedMs) {
      this.base.logger.warn(`duration ${durationSec}s clamped to ${durationMs}ms for ElevenLabs Music limits`);
    }

    const { outputFormat = DEFAULT_OUTPUT_FORMAT } = options;

    this.base.logger.info(`generating music bed via fal.ai — ${durationMs}ms, intent: "${musicBedIntent.slice(0, 80)}..."`);
    const startTime = Date.now();

    // fal.ai ElevenLabs Music payload — matches the direct ElevenLabs API shape.
    const inputPayload = {
      prompt: musicBedIntent,
      music_length_ms: durationMs,
      output_format: outputFormat
    };

    let rawResult;
    try {
      rawResult = await this.base.run(inputPayload);
    } catch (err) {
      this.base.logger.error(`fal.ai music generation failed: ${err.message}`);
      throw err;
    }

    const audioUrl = rawResult?.audio?.url;
    if (!audioUrl) {
      this.base.logger.error(`fal.ai music returned no audio URL: ${JSON.stringify(rawResult).slice(0, 300)}`);
      throw new Error('fal.ai ElevenLabs Music did not return an audio URL');
    }

    const audioBuffer = await this.base.downloadToBuffer(audioUrl, 'audio');
    if (audioBuffer.length === 0) {
      throw new Error('fal.ai ElevenLabs Music returned empty audio');
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const sizeKB = (audioBuffer.length / 1024).toFixed(0);
    this.base.logger.info(`music bed ready in ${elapsed}s — ${sizeKB}KB`);

    return {
      audioBuffer,
      durationSec: durationMs / 1000,
      format: outputFormat.startsWith('mp3') ? 'mp3' : outputFormat.split('_')[0],
      prompt: musicBedIntent
    };
  }
}

const musicService = new MusicService();
export default musicService;
export { MusicService };
