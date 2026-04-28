// services/beat-generators/TalkingHeadCloseupGenerator.js
// V4 Mode A fallback — OmniHuman 1.5 direct talking-head generation.
//
// This is the legacy OmniHuman-only path, kept in V4 as:
//   - Budget-tier fallback when Mode B cost is prohibitive
//   - A/B benchmark against Mode B's cinematic dialogue output
//   - Safety net when Kling O3 Omni or Sync Lipsync v3 have failures
//
// Flow:
//   Stage A — ElevenLabs TTS synthesizes the dialogue line
//   Stage B — OmniHuman 1.5 drives the persona's hero portrait with the audio
//             → returns a lip-synced talking-head video
//
// Known limitation: static background. Use only when a cinematic BG isn't
// needed or when cost pressure forces the fallback.
//
// NOTE: Despite the name TalkingHeadCloseupGenerator, this is NOT the primary
// for TALKING_HEAD_CLOSEUP in V4. The primary is CinematicDialogueGenerator
// (Mode B). This class is registered as a FALLBACK in the beat-generators
// index and can be selected explicitly via beat.model_override.

import BaseBeatGenerator from './BaseBeatGenerator.js';

const COST_OMNIHUMAN_PER_SEC = 0.16;
const COST_TTS_PER_CHAR = 0.0001;

class TalkingHeadCloseupGenerator extends BaseBeatGenerator {
  static beatTypes() {
    return ['TALKING_HEAD_CLOSEUP']; // also handles SILENT_STARE via subclass
  }

  static estimateCost(beat) {
    const duration = beat.duration_seconds || 4;
    const dialogueChars = (beat.dialogue || '').length;
    return COST_OMNIHUMAN_PER_SEC * duration + COST_TTS_PER_CHAR * dialogueChars;
  }

  async _doGenerate({ beat, scene, refStack, personas, episodeContext, previousBeat }) {
    const { omniHuman } = this.falServices;
    if (!omniHuman) throw new Error('TalkingHeadCloseupGenerator: omniHuman service not in deps');
    if (!this.tts) throw new Error('TalkingHeadCloseupGenerator: tts service not in deps');

    const persona = this._resolvePersona(beat, personas);
    if (!persona) throw new Error(`beat ${beat.beat_id}: no persona resolved`);
    if (!persona.elevenlabs_voice_id) {
      throw new Error(`beat ${beat.beat_id}: persona "${persona.name}" missing elevenlabs_voice_id`);
    }

    const dialogue = beat.dialogue;
    if (!dialogue) throw new Error(`beat ${beat.beat_id}: missing dialogue field`);

    const targetDuration = beat.duration_seconds || 4;

    // ─── Stage A — ElevenLabs TTS ───
    // V4 Day 1 — modelId omitted so TTSService picks per BRAND_STORY_TTS_ENGINE
    // (default eleven_v3, with multilingual_v2 rollback path).
    this.logger.info(`[${beat.beat_id}] Stage A: TTS (${dialogue.length} chars)`);
    const ttsResult = await this.tts.synthesizeBeat({
      text: dialogue,
      voiceId: persona.elevenlabs_voice_id,
      durationTarget: targetDuration,
      options: {
        language: persona.language || 'en'
      }
    });

    // Upload to get a public URL for OmniHuman.
    if (!episodeContext?.uploadAudio) {
      throw new Error(`beat ${beat.beat_id}: episodeContext.uploadAudio helper required for Mode A`);
    }
    const audioUrl = await episodeContext.uploadAudio({
      buffer: ttsResult.audioBuffer,
      filename: `beat-${beat.beat_id}-tts.mp3`,
      mimeType: 'audio/mpeg'
    });

    // ─── Stage B — OmniHuman 1.5 talking-head ───
    const seedImageUrl = persona.omnihuman_seed_image_url
      || persona.reference_image_urls?.[0]
      || refStack?.[0];
    if (!seedImageUrl) {
      throw new Error(`beat ${beat.beat_id}: no seed image for OmniHuman (need omnihuman_seed_image_url or reference_image_urls)`);
    }

    const stylePrefix = episodeContext?.visual_style_prefix || '';
    const expressionHint = beat.expression_notes ? ` ${beat.expression_notes}.` : '';
    const emotionHint = beat.emotion ? ` ${beat.emotion} tone.` : '';
    const prompt = this._appendDirectorNudge(`${stylePrefix}${emotionHint}${expressionHint}`.trim(), beat);

    this.logger.info(`[${beat.beat_id}] Stage B: OmniHuman 1.5`);
    const ohResult = await omniHuman.generateTalkingHead({
      imageUrl: seedImageUrl,
      audioUrl,
      options: {
        resolution: ttsResult.actualDurationSec > 30 ? '720p' : '1080p',
        prompt
      }
    });

    const totalCost = COST_OMNIHUMAN_PER_SEC * ttsResult.actualDurationSec
                    + COST_TTS_PER_CHAR * dialogue.length;

    return {
      videoBuffer: ohResult.videoBuffer,
      durationSec: ttsResult.actualDurationSec,
      modelUsed: 'mode-a/omnihuman-1.5',
      costUsd: totalCost,
      metadata: {
        mode: 'A',
        ohVideoUrl: ohResult.videoUrl,
        ttsAudioUrl: audioUrl,
        ttsActualDurationSec: ttsResult.actualDurationSec
      }
    };
  }
}

export default TalkingHeadCloseupGenerator;
export { TalkingHeadCloseupGenerator };
