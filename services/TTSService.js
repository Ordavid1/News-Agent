// services/TTSService.js
// ElevenLabs TTS wrapper for text-to-speech synthesis.
// Used by the hybrid Brand Story pipeline to produce audio for OmniHuman
// dialogue shots (OmniHuman consumes audio, unlike HeyGen which has built-in TTS).
// Uses the ElevenLabs direct REST API (api.elevenlabs.io).

import axios from 'axios';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[TTSService] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

// ElevenLabs API base
const API_BASE = 'https://api.elevenlabs.io/v1';

// Default voice — "Brian" (premade, male, American, narrative-friendly).
// Premade voices work on ALL tiers including free.
// Library voices (like "Rachel") require a paid plan.
// Full premade list: https://elevenlabs-sdk.mintlify.app/voices/premade-voices
const DEFAULT_VOICE_ID = 'nPczCjzI2devNBz1zQrb';

// Default model — Flash v2.5 (ultra-low latency ~75ms, 32 languages).
// Alternatives: eleven_multilingual_v2 (higher quality, slower), eleven_turbo_v2_5
const DEFAULT_MODEL = 'eleven_flash_v2_5';

class TTSService {
  constructor() {
    this.apiKey = process.env.ELEVENLABS_API_KEY || '';

    if (!this.apiKey) {
      logger.warn('ELEVENLABS_API_KEY not set — ElevenLabs TTS will not be available');
    } else {
      logger.info('TTSService initialized (ElevenLabs TTS)');
    }
  }

  /**
   * Check if the service is available
   */
  isAvailable() {
    return !!this.apiKey;
  }

  /**
   * Synthesize text to audio using ElevenLabs TTS API.
   * Returns the raw audio buffer — caller uploads to Supabase and gets a public URL.
   *
   * ElevenLabs returns raw audio bytes directly (application/octet-stream).
   *
   * @param {Object} params
   * @param {string} params.text - Text to synthesize
   * @param {Object} [params.options]
   * @param {string} [params.options.voiceId] - ElevenLabs voice ID
   * @param {string} [params.options.modelId] - Model: 'eleven_flash_v2_5' | 'eleven_multilingual_v2' | 'eleven_turbo_v2_5'
   * @param {string} [params.options.language] - ISO 639-1 language code (e.g., 'en', 'es', 'he')
   * @param {string} [params.options.outputFormat='mp3_44100_128'] - Audio format
   * @param {number} [params.options.stability=0.5] - Voice stability (0-1)
   * @param {number} [params.options.similarityBoost=0.75] - Voice similarity (0-1)
   * @param {number} [params.options.speed=1.0] - Speech rate multiplier
   * @returns {Promise<Object>} { audioBuffer, format, durationEstimate }
   */
  async synthesize({ text, options = {} }) {
    if (!this.apiKey) throw new Error('ELEVENLABS_API_KEY is not configured');
    if (!text || text.trim().length === 0) throw new Error('text is required for TTS synthesis');

    const {
      voiceId = DEFAULT_VOICE_ID,
      modelId = DEFAULT_MODEL,
      language,
      outputFormat = 'mp3_44100_128',
      stability = 0.5,
      similarityBoost = 0.75,
      speed = 1.0
    } = options;

    const textLength = text.length;
    logger.info(`Synthesizing TTS — ${textLength} chars, voice: ${voiceId}, model: ${modelId}`);

    const startTime = Date.now();

    const requestBody = {
      text,
      model_id: modelId,
      voice_settings: {
        stability,
        similarity_boost: similarityBoost,
        speed
      }
    };
    if (language) requestBody.language_code = language;

    let response;
    try {
      response = await axios.post(
        `${API_BASE}/text-to-speech/${voiceId}`,
        requestBody,
        {
          headers: {
            'xi-api-key': this.apiKey,
            'Content-Type': 'application/json',
            'Accept': 'audio/mpeg'
          },
          params: {
            output_format: outputFormat
          },
          responseType: 'arraybuffer',
          timeout: 60000
        }
      );
    } catch (err) {
      if (err.response) {
        const errBody = err.response.data instanceof Buffer
          ? err.response.data.toString('utf-8')
          : JSON.stringify(err.response.data);
        logger.error(`ElevenLabs TTS error ${err.response.status}: ${errBody.slice(0, 500)}`);
      }
      throw err;
    }

    const audioBuffer = Buffer.from(response.data);

    if (audioBuffer.length === 0) {
      throw new Error('ElevenLabs TTS returned empty audio');
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Estimate duration from buffer size.
    // MP3 at 128kbps: bytes / 16000 ≈ seconds
    // MP3 at 44100/128: bytes / 16000 is a reasonable approximation.
    const estimatedDuration = audioBuffer.length / 16000;

    logger.info(`TTS audio ready in ${elapsed}s — ${(audioBuffer.length / 1024).toFixed(0)}KB, ~${estimatedDuration.toFixed(1)}s estimated`);

    return {
      audioBuffer,
      format: outputFormat.startsWith('mp3') ? 'mp3' : outputFormat.split('_')[0],
      durationEstimate: Math.round(estimatedDuration)
    };
  }
}

// Singleton export
const ttsService = new TTSService();
export default ttsService;
export { TTSService };
