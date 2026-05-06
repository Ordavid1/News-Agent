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
import { pickFallbackVoiceIdForPersonaInList } from '../v4/VoiceAcquisition.js';

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
    // Cast Bible follow-up — replace the literal Brian fallback with the
    // intelligent picker. Resolution order:
    //   1. Persona's own voice (if assigned at story-creation time)
    //   2. Episode's defaultNarratorVoiceId (already picker-derived in BrandStoryService)
    //   3. Fresh picker call against personas[voIndex] for gender + persona match
    //   4. Picker against personas[0] (narrator persona) as last logical fallback
    // Each layer is gender-aware and avoids voice collisions.
    const voiceId = voPersona?.elevenlabs_voice_id
      || episodeContext?.defaultNarratorVoiceId
      || (typeof voIndex === 'number'
          ? pickFallbackVoiceIdForPersonaInList(personas, voIndex, { reason: 'voiceover_broll_voPersona' })
          : null)
      || pickFallbackVoiceIdForPersonaInList(personas, 0, { reason: 'voiceover_broll_narrator' })
      || 'nPczCjzI2devNBz1zQrb'; // last-resort literal — only if library is empty (config bug)

    // V4 Day 1 — modelId omitted so TTSService picks per BRAND_STORY_TTS_ENGINE.
    this.logger.info(`[${beat.beat_id}] Stage A: V.O. TTS (${voiceoverText.length} chars)`);
    const ttsResult = await this.tts.synthesizeBeat({
      text: voiceoverText,
      voiceId,
      durationTarget: duration,
      options: {
        language: voPersona?.language || 'en'
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
    // Phase 2 — when the V.O. beat features an on-screen persona (e.g. agent
    // walking the terrace while narrating), synthesize a persona-locked first
    // frame so Veo preserves identity across the beat. The V.O. persona
    // (voiceover_persona_index) is included in the persona resolution.
    const personaLockUrl = await this._buildPersonaLockedFirstFrame({
      beat, scene, previousBeat, personas, episodeContext
    });

    // Subject natural frame — non-invasive Veo anchoring. Fires only when the
    // screenplay explicitly sets `subject_focus` and no persona is locking the
    // first frame. Uses the terse 'natural' Seedream prompt to avoid tripping
    // Vertex's image classifier.
    const hasSubjectFocus = typeof beat.subject_focus === 'string' && beat.subject_focus.trim().length > 0;
    const subjectNaturalUrl = (!personaLockUrl && hasSubjectFocus)
      ? await this._buildSceneIntegratedProductFrame({ beat, scene, episodeContext, intent: 'natural' })
      : null;

    // V4 Tier 2.1 (2026-05-06) — unified canonical waterfall (same shape
    // as BRollGenerator). The picker handles persona-lock-cached → just-
    // synthesized persona-lock → subject-natural → bridge-anchor → previous-
    // endframe → scene-master, and writes beat.continuity_fallback_reason.
    const firstFrameUrl = this._pickStartFrame(refStack, previousBeat, scene, beat, {
      personaLockUrl,
      subjectNaturalUrl
    });

    const stylePrefix = episodeContext?.visual_style_prefix || '';
    const location = beat.location || scene?.location || 'atmospheric establishing';
    const cameraMove = beat.camera_move || 'slow drift forward';

    // V4 Phase 9 — vertical framing + conditional identity anchoring
    // (V.O. beats may feature a persona on-screen while the narration plays).
    const verticalDirective = this._buildVerticalFramingDirective(beat, 'veo');
    const identityDirective = (beat.personas_present && beat.personas_present.length > 0) || personaLockUrl
      ? this._buildIdentityAnchoringDirective()
      : '';
    const subjectDirective = this._buildSubjectPresenceDirective(beat, episodeContext);

    // V4 Tier 2.2 (2026-05-06) — color hint + wardrobe + brand palette.
    const personasInBeat = this._resolvePersonasInBeat(beat, personas);
    const colorHint = this._buildPerModelColorHint('veo', episodeContext?.brandKit);
    const wardrobeDirective = personasInBeat.length > 0
      ? this._buildWardrobeDirective(personasInBeat[0])
      : '';
    const brandColorDirective = this._buildBrandColorDirective(episodeContext);
    // V4 Tier 3.1 (2026-05-06) — anti-reference (Veo-strength).
    const antiRefDirective = this._buildPreviousBeatAntiReferenceDirective(previousBeat, 'veo');

    const veoPrompt = this._appendDirectorNudge([
      verticalDirective,
      stylePrefix,
      `B-roll of ${location}.`,
      `Camera: ${cameraMove}.`,
      identityDirective,
      wardrobeDirective,
      subjectDirective,
      brandColorDirective,
      antiRefDirective,
      'Atmospheric and evocative.',
      'Ambient sound bed only (natural environment).',
      colorHint
    ].filter(Boolean).join(' '), beat);

    this.logger.info(`[${beat.beat_id}] Stage B: Veo 3.1 B-roll (${duration}s)`);
    const personaNames = (personas || [])
      .map(p => p && p.name)
      .filter(n => typeof n === 'string' && n.length > 0);
    let veoResult;
    try {
      veoResult = await veo.generateWithFrames({
        firstFrameUrl,
        prompt: veoPrompt,
        options: {
          duration,
          aspectRatio: '9:16',
          generateAudio: true, // keep ambient; orchestrator will duck it under V.O.
          tier: 'standard',
          personaNames,
          sanitizationContext: {
            subjectName: location,
            subjectDescription: 'atmospheric establishing b-roll',
            stylePrefix
          },
          // 2026-05-06 — Veo→Kling fallback (Step 6). Only the visual stage
          // falls back; the V.O. audio (Stage A above) is already produced
          // and the orchestrator's post-production V.O. overlay + ducking
          // pass runs on the Kling output identically.
          skipTextOnlyFallback: true,
          telemetry: {
            userId: episodeContext?.userId,
            episodeId: episodeContext?.episodeId,
            beatId: beat.beat_id,
            beatType: beat.type
          }
        }
      });
    } catch (err) {
      const fallbackReason = err.isVeoContentFilterPersistent
        ? `Veo content filter persistent on VOICEOVER_OVER_BROLL (${(err.message || '').slice(0, 80)})`
        : `Veo error on VOICEOVER_OVER_BROLL (${(err.message || '').slice(0, 80)})`;
      this.logger.warn(
        `[${beat.beat_id}] ${fallbackReason} — falling back to Kling V3 Pro (V.O. audio preserved)`
      );

      const klingVoBrollPrompt = this._appendDirectorNudge([
        verticalDirective,
        stylePrefix,
        `B-roll of ${location}.`,
        `Camera: ${cameraMove}.`,
        identityDirective,
        wardrobeDirective,
        'Atmospheric and evocative, no characters speaking.',
        'Ambient sound bed only (natural environment).'
      ].filter(Boolean).join(' '), beat);

      const hasPersonasInBeat = (Array.isArray(beat.personas_present) && beat.personas_present.length > 0)
        || !!personaLockUrl;

      const fallbackResult = await this._fallbackToKlingForVeoFailure({
        beat, scene, refStack, personas, episodeContext, previousBeat,
        routingMetadata: undefined,
        prompt: klingVoBrollPrompt,
        duration,
        beatTypeLabel: 'vo-broll',
        includeSubject: false,
        includePersonaElements: hasPersonasInBeat,
        fallbackReason,
        veoSanitizationTier: null,
        generateAudio: true, // Kling provides ambient; post-prod ducks it under V.O.
        extraMetadata: {
          voAudioUrl,
          voiceId,
          voiceoverText,
          personaLocked: !!personaLockUrl,
          subjectNaturalFrame: !!subjectNaturalUrl,
          // CRITICAL: orchestrator hook for V.O. overlay + ducking is
          // preserved on the fallback path. Without this, post-prod skips
          // the V.O. mix and the user gets silent video.
          needsVoiceoverMix: true
        }
      });

      // Adjust modelUsed string to reflect the V.O. component too.
      fallbackResult.modelUsed = `kling-v3-pro/vo-broll (veo-fallback) + elevenlabs`;
      // Add the TTS cost (already paid above in Stage A) to the result.
      fallbackResult.costUsd = (fallbackResult.costUsd || 0) + COST_TTS_PER_CHAR * voiceoverText.length;
      return fallbackResult;
    }

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
        personaLocked: !!personaLockUrl,
        subjectNaturalFrame: !!subjectNaturalUrl,
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
