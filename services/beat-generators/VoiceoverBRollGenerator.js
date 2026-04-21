// services/beat-generators/VoiceoverBRollGenerator.js
// V4 VOICEOVER_OVER_BROLL beat generator — opt-in montage/recap beats.
//
// A V4 escape hatch for scenes that want the old v3 voice-over aesthetic:
// b-roll visual + a character's internal monologue or narration overlay.
// Used sparingly — V4 is primarily on-camera dialogue, this is the exception.
//
// Flow:
//   Stage A — ElevenLabs TTS synthesizes the voiceover line in the designated
//             persona's voice (or a narrator voice if voiceover_persona_index
//             isn't specified)
//   Stage B — Veo 3.1 Standard generates the b-roll visual with native ambient
//   Stage C — Post-production (orchestrator) mixes the V.O. MP3 over the Veo
//             video's ambient track, ducking the ambient by ~6dB under the V.O.
//
// The generator returns the Veo video + the separate V.O. audio URL — the
// orchestrator handles the mix in post-production because the ducking logic
// lives there with the rest of the audio-mix chain.

import BaseBeatGenerator from './BaseBeatGenerator.js';

const COST_VEO_STANDARD_PER_SEC = 0.40;
const COST_TTS_PER_CHAR = 0.0001;

class VoiceoverBRollGenerator extends BaseBeatGenerator {
  static beatTypes() {
    return ['VOICEOVER_OVER_BROLL'];
  }

  static estimateCost(beat) {
    const duration = beat.duration_seconds || 5;
    const vo = (beat.voiceover_text || '').length;
    return COST_VEO_STANDARD_PER_SEC * duration + COST_TTS_PER_CHAR * vo;
  }

  async _doGenerate({ beat, scene, refStack, personas, episodeContext, previousBeat }) {
    const { veo } = this.falServices;
    if (!veo) throw new Error('VoiceoverBRollGenerator: veo service not in deps');
    if (!this.tts) throw new Error('VoiceoverBRollGenerator: tts service not in deps');

    const voiceoverText = beat.voiceover_text;
    if (!voiceoverText) throw new Error(`beat ${beat.beat_id}: missing voiceover_text`);

    const duration = Math.max(4, Math.min(8, beat.duration_seconds || 5));

    // ─── Stage A — ElevenLabs V.O. synthesis ───
    const voIndex = beat.voiceover_persona_index;
    const voPersona = (typeof voIndex === 'number' && personas[voIndex]) ? personas[voIndex] : null;
    const voiceId = voPersona?.elevenlabs_voice_id
      || episodeContext?.defaultNarratorVoiceId
      || 'nPczCjzI2devNBz1zQrb'; // Brian fallback

    this.logger.info(`[${beat.beat_id}] Stage A: V.O. TTS (${voiceoverText.length} chars)`);
    const ttsResult = await this.tts.synthesizeBeat({
      text: voiceoverText,
      voiceId,
      durationTarget: duration,
      options: {
        language: voPersona?.language || 'en',
        modelId: 'eleven_multilingual_v2'
      }
    });

    if (!episodeContext?.uploadAudio) {
      throw new Error(`beat ${beat.beat_id}: episodeContext.uploadAudio required`);
    }
    const voAudioUrl = await episodeContext.uploadAudio({
      buffer: ttsResult.audioBuffer,
      filename: `beat-${beat.beat_id}-vo.mp3`,
      mimeType: 'audio/mpeg'
    });

    // ─── Stage B — Veo B-roll visual with native ambient ───
    const firstFrameUrl = scene?.scene_master_url
      || previousBeat?.endframe_url
      || null;

    const stylePrefix = episodeContext?.visual_style_prefix || '';
    const location = beat.location || scene?.location || 'atmospheric establishing';
    const cameraMove = beat.camera_move || 'slow drift forward';

    const veoPrompt = [
      stylePrefix,
      `B-roll of ${location}.`,
      `Camera: ${cameraMove}.`,
      'No visible characters speaking — atmospheric and evocative.',
      'Ambient sound bed only (natural environment).'
    ].filter(Boolean).join(' ');

    this.logger.info(`[${beat.beat_id}] Stage B: Veo 3.1 B-roll (${duration}s)`);
    const veoResult = await veo.generateWithFrames({
      firstFrameUrl,
      prompt: veoPrompt,
      options: {
        duration,
        aspectRatio: '9:16',
        generateAudio: true, // keep ambient; orchestrator will duck it under V.O.
        tier: 'standard'
      }
    });

    // Use the ACTUAL duration returned by Veo (may be snapped up to {4,6,8}
    // because Vertex only accepts those bins for image_to_video).
    const actualDuration = veoResult.duration || duration;

    // The orchestrator will mix voAudioUrl over veoResult.videoBuffer in
    // post-production. We return both so it knows what to compose.
    const veoCost = COST_VEO_STANDARD_PER_SEC * actualDuration;
    const ttsCost = COST_TTS_PER_CHAR * voiceoverText.length;

    return {
      videoBuffer: veoResult.videoBuffer,
      durationSec: actualDuration,
      modelUsed: `veo-3.1-standard/vo-broll + elevenlabs`,
      costUsd: veoCost + ttsCost,
      metadata: {
        veoVideoUrl: veoResult.videoUrl,
        voAudioUrl,
        voiceId,
        voiceoverText,
        fallbackTier: veoResult.fallbackTier,
        requestedDurationSec: duration,
        snappedDurationSec: actualDuration,
        // Orchestrator hook: this tells post-production to do a V.O. overlay
        // pass with ducking instead of using the Veo video's audio as-is.
        needsVoiceoverMix: true
      }
    };
  }
}

export default VoiceoverBRollGenerator;
export { VoiceoverBRollGenerator };
