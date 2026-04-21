// services/beat-generators/CinematicDialogueGenerator.js
// V4 Mode B dialogue generator — the heart of on-camera dialogue in V4.
//
// Handles: TALKING_HEAD_CLOSEUP and DIALOGUE_IN_SCENE beat types.
//
// Mode B hybrid chain (3 stages):
//
//   Stage A — ElevenLabs TTS synthesizes the beat's dialogue line in the
//             persona's locked voice. Returns an MP3 + actualDurationSec.
//   Stage B — Kling O3 Omni Standard generates a cinematic dialogue beat
//             (character speaking in rich environment, identity-locked by
//             reference images). Kling's native lip-sync is rough but the
//             cinematic background and character motion are excellent.
//   Stage C — Sync Lipsync v3 takes Stage B's video + Stage A's audio and
//             applies a corrective lip-sync pass. Preserves background and
//             body motion; replaces mouth shapes to match the TTS audio.
//
// Final output: a cinematic dialogue beat with perfect lip-sync + rich
// background. This is how Hollywood does ADR (generate the picture, fix
// dialogue in post), ported to AI generation.
//
// Mode A fallback (OmniHuman 1.5 alone) is a separate generator
// (TalkingHeadCloseupGenerator) used when a story is flagged Mode A by
// cost tier or when Mode B has failed for this persona before.
//
// Requires the orchestrator to upload Stage A's TTS audio to Supabase and
// pass the public URL via episodeContext.audioUploadFn — OR the dialogue
// generator does it inline if a supabaseUpload helper is in deps.

import BaseBeatGenerator from './BaseBeatGenerator.js';
import { buildKlingElementsFromPersonas } from '../KlingFalService.js';

// Cost constants for estimator (per-second rates × typical duration)
const COST_KLING_OMNI_STANDARD_PER_SEC = 0.168;
const COST_SYNC_LIPSYNC_V3_FLAT = 0.50; // rough per-beat flat (fal.ai specifics TBD Day 0)
const COST_TTS_PER_CHAR = 0.0001; // rough ElevenLabs multilingual v2 cost

class CinematicDialogueGenerator extends BaseBeatGenerator {
  static beatTypes() {
    return ['TALKING_HEAD_CLOSEUP', 'DIALOGUE_IN_SCENE'];
  }

  static estimateCost(beat) {
    const duration = beat.duration_seconds || 4;
    const dialogueChars = (beat.dialogue || '').length;
    const klingCost = COST_KLING_OMNI_STANDARD_PER_SEC * duration;
    const ttsCost = COST_TTS_PER_CHAR * dialogueChars;
    return klingCost + COST_SYNC_LIPSYNC_V3_FLAT + ttsCost;
  }

  async _doGenerate({ beat, scene, refStack, personas, episodeContext, previousBeat }) {
    const { kling, syncLipsync } = this.falServices;
    if (!kling) throw new Error('CinematicDialogueGenerator: kling service not in deps');
    if (!syncLipsync) throw new Error('CinematicDialogueGenerator: syncLipsync service not in deps');
    if (!this.tts) throw new Error('CinematicDialogueGenerator: tts service not in deps');

    const persona = this._resolvePersona(beat, personas);
    if (!persona) throw new Error(`beat ${beat.beat_id}: no persona resolved`);
    if (!persona.elevenlabs_voice_id) {
      throw new Error(`beat ${beat.beat_id}: persona "${persona.name}" missing elevenlabs_voice_id`);
    }

    const dialogue = beat.dialogue;
    if (!dialogue) throw new Error(`beat ${beat.beat_id}: missing dialogue field`);

    const targetDuration = beat.duration_seconds || 4;

    // ─── Stage A — ElevenLabs TTS ───
    this.logger.info(`[${beat.beat_id}] Stage A: TTS synthesis (${dialogue.length} chars, target ${targetDuration}s)`);
    const ttsResult = await this.tts.synthesizeBeat({
      text: dialogue,
      voiceId: persona.elevenlabs_voice_id,
      durationTarget: targetDuration,
      options: {
        language: persona.language || 'en',
        modelId: 'eleven_multilingual_v2',
        paceHint: beat.pace_hint || null,
        emotionalHold: beat.emotional_hold === true
      }
    });

    // Upload TTS audio to Supabase to get a public URL for Sync Lipsync v3.
    // The orchestrator injects an upload helper via episodeContext.uploadAudio.
    if (!episodeContext?.uploadAudio) {
      throw new Error(`beat ${beat.beat_id}: episodeContext.uploadAudio helper required for Mode B`);
    }
    const audioUrl = await episodeContext.uploadAudio({
      buffer: ttsResult.audioBuffer,
      filename: `beat-${beat.beat_id}-tts.mp3`,
      mimeType: 'audio/mpeg'
    });

    // ─── Stage B — Kling O3 Omni Standard cinematic visual ───
    const startFrameUrl = this._pickStartFrame(refStack, previousBeat, scene);
    if (!startFrameUrl) {
      throw new Error(`beat ${beat.beat_id}: no start frame available (need character sheet or scene master)`);
    }

    const stylePrefix = episodeContext?.visual_style_prefix || '';
    const expressionHint = beat.expression_notes ? ` Expression: ${beat.expression_notes}.` : '';
    const lensHint = beat.lens ? ` Lens: ${beat.lens}.` : '';
    const emotionHint = beat.emotion ? ` Emotion: ${beat.emotion}.` : '';
    const actionHint = beat.action_notes ? ` Action: ${beat.action_notes}.` : '';
    // V4 subtext routing — when the scriptwriter has marked a line's surface meaning
    // as different from its truth, surface the subtext as a facial direction so Kling
    // can render a micro-tell (a flinch, a held breath, eyes cutting away). The TTS
    // stays neutral to the written line; the face carries the subtext underneath.
    const subtextHint = beat.subtext
      ? ` Subtext (show on the face, not in the voice): the line is "${dialogue}" but what the character really means is "${beat.subtext}". Let that truth surface as a micro-expression under the surface emotion.`
      : '';

    // For TALKING_HEAD_CLOSEUP, the prompt focuses on the face and emotion.
    // For DIALOGUE_IN_SCENE, the prompt includes movement/interaction.
    const isInScene = beat.type === 'DIALOGUE_IN_SCENE';
    const framingHint = isInScene
      ? 'Medium shot, character in scene, environmental context visible.'
      : 'Tight closeup, head and shoulders, shallow depth of field.';

    const klingPrompt = [
      stylePrefix,
      framingHint,
      emotionHint.trim(),
      expressionHint.trim(),
      subtextHint.trim(),
      actionHint.trim(),
      lensHint.trim(),
      `Character speaks the line: "${dialogue}"`
    ].filter(Boolean).join(' ');

    // Build the Kling elements[] array from the speaking persona (and any
    // other personas present in the shot). Character identity lock comes from
    // these inline elements, not a flat reference_images array.
    const personasInShot = [persona]; // primary speaker always first
    if (Array.isArray(beat.persona_indexes)) {
      for (const idx of beat.persona_indexes) {
        if (personas[idx] && personas[idx] !== persona) personasInShot.push(personas[idx]);
      }
    }
    const { elements, elementTokens } = buildKlingElementsFromPersonas(personasInShot);

    // Splice @Element tokens into the prompt so Kling knows which character
    // speaks the line. Use @Element1 for the primary speaker.
    const primarySpeakerToken = elementTokens[0] || '';
    const finalKlingPrompt = primarySpeakerToken
      ? `${klingPrompt.replace(/Character speaks/, `${primarySpeakerToken} speaks`)}`
      : klingPrompt;

    this.logger.info(`[${beat.beat_id}] Stage B: Kling O3 Omni Standard (${elements.length} element(s))`);
    const klingResult = await kling.generateDialogueBeat({
      startFrameUrl,
      elements,
      prompt: finalKlingPrompt,
      options: {
        duration: Math.round(ttsResult.actualDurationSec),
        aspectRatio: '9:16',
        generateAudio: true
      }
    });

    // ─── Stage C — Sync Lipsync v3 corrective pass ───
    this.logger.info(`[${beat.beat_id}] Stage C: Sync Lipsync v3 corrective pass`);
    const syncResult = await syncLipsync.applyLipsync({
      videoUrl: klingResult.videoUrl, // Kling's CDN URL is already public
      audioUrl,
      options: { syncMode: 'cut_off' }
    });

    // Total cost accounting
    const klingCost = COST_KLING_OMNI_STANDARD_PER_SEC * ttsResult.actualDurationSec;
    const syncCost = COST_SYNC_LIPSYNC_V3_FLAT;
    const ttsCost = COST_TTS_PER_CHAR * dialogue.length;
    const totalCost = klingCost + syncCost + ttsCost;

    return {
      videoBuffer: syncResult.videoBuffer,
      durationSec: ttsResult.actualDurationSec,
      modelUsed: 'mode-b/kling-o3-omni+sync-lipsync-v3',
      costUsd: totalCost,
      metadata: {
        mode: 'B',
        klingVideoUrl: klingResult.videoUrl,
        syncVideoUrl: syncResult.videoUrl,
        ttsAudioUrl: audioUrl,
        ttsActualDurationSec: ttsResult.actualDurationSec,
        elementBound: !!persona.kling_element_id,
        voiceBound: !!persona.kling_voice_id
      }
    };
  }
}

export default CinematicDialogueGenerator;
export { CinematicDialogueGenerator };
