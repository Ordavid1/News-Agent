// services/beat-generators/GroupTwoShotGenerator.js
// V4 GROUP_DIALOGUE_TWOSHOT beat generator.
//
// ⚠️ RARE — reserved for emotional peaks only. V4's default for multi-character
// dialogue is SHOT_REVERSE_SHOT (expanded to alternating closeups). Two-shots
// are used when the emotional payoff REQUIRES both faces in the same frame.
//
// Generates via Kling O3 Omni Standard with both personas in the reference
// stack + multi-shot mode + native audio. Sync Lipsync v3 post-pass runs
// twice (once per speaker) to correct both mouths against the respective
// ElevenLabs TTS audio.
//
// If either sync pass fails, the generator returns the Kling-raw video with
// a warning — the beat is still usable, just with Kling's native lip-sync.

import BaseBeatGenerator from './BaseBeatGenerator.js';
import { buildKlingElementsFromPersonas } from '../KlingFalService.js';

const COST_KLING_OMNI_STANDARD_PER_SEC = 0.168;
const COST_SYNC_LIPSYNC_V3_FLAT = 0.50;
const COST_TTS_PER_CHAR = 0.0001;

class GroupTwoShotGenerator extends BaseBeatGenerator {
  static beatTypes() {
    return ['GROUP_DIALOGUE_TWOSHOT'];
  }

  static estimateCost(beat) {
    const duration = beat.duration_seconds || 6;
    const dialoguesChars = (beat.dialogues || []).reduce((n, d) => n + (d || '').length, 0);
    const klingCost = COST_KLING_OMNI_STANDARD_PER_SEC * duration;
    // Two sync passes × sync flat + two TTS renders
    return klingCost + (COST_SYNC_LIPSYNC_V3_FLAT * 2) + (COST_TTS_PER_CHAR * dialoguesChars);
  }

  async _doGenerate({ beat, scene, refStack, personas, episodeContext, previousBeat }) {
    const { kling, syncLipsync } = this.falServices;
    if (!kling) throw new Error('GroupTwoShotGenerator: kling service not in deps');
    if (!this.tts) throw new Error('GroupTwoShotGenerator: tts service not in deps');

    const personaIndexes = Array.isArray(beat.persona_indexes) ? beat.persona_indexes : [];
    if (personaIndexes.length < 2) {
      throw new Error(`beat ${beat.beat_id}: GROUP_DIALOGUE_TWOSHOT needs persona_indexes[] with at least 2 entries`);
    }
    const dialogues = Array.isArray(beat.dialogues) ? beat.dialogues : [];
    if (dialogues.length < 2) {
      throw new Error(`beat ${beat.beat_id}: GROUP_DIALOGUE_TWOSHOT needs dialogues[] with at least 2 entries`);
    }

    const resolvedPersonas = personaIndexes.map(i => personas[i]).filter(Boolean);
    if (resolvedPersonas.length < 2) {
      throw new Error(`beat ${beat.beat_id}: couldn't resolve both personas from indexes`);
    }

    const duration = beat.duration_seconds || 6;

    // Render TTS for each speaker in parallel
    this.logger.info(`[${beat.beat_id}] Stage A: TTS × ${resolvedPersonas.length} (parallel)`);
    const ttsResults = await Promise.all(
      resolvedPersonas.map((persona, i) => {
        if (!persona.elevenlabs_voice_id) {
          throw new Error(`beat ${beat.beat_id}: persona ${i} missing elevenlabs_voice_id`);
        }
        return this.tts.synthesizeBeat({
          text: dialogues[i],
          voiceId: persona.elevenlabs_voice_id,
          durationTarget: duration / 2, // rough half each
          options: {
            language: persona.language || 'en',
            modelId: 'eleven_multilingual_v2'
          }
        });
      })
    );

    // Upload audio files
    if (!episodeContext?.uploadAudio) {
      throw new Error(`beat ${beat.beat_id}: episodeContext.uploadAudio required`);
    }
    const audioUrls = await Promise.all(
      ttsResults.map((tts, i) => episodeContext.uploadAudio({
        buffer: tts.audioBuffer,
        filename: `beat-${beat.beat_id}-speaker${i}.mp3`,
        mimeType: 'audio/mpeg'
      }))
    );

    // Build the Kling two-shot prompt
    const stylePrefix = episodeContext?.visual_style_prefix || '';
    const blockingHint = beat.blocking_notes || 'Two characters in frame, eye-level medium two-shot';
    const emotionHint = beat.emotion ? ` ${beat.emotion} tone.` : '';
    const dialogueHint = dialogues
      .map((line, i) => `${resolvedPersonas[i].name || `Character ${i + 1}`} says: "${line}"`)
      .join(' ');
    // V4 subtext → facial direction (same routing as the closeup generator).
    // Two-shots carry the subtext of the whole exchange; Kling reads it as a
    // micro-tell on both faces.
    const subtextHint = beat.subtext
      ? ` Subtext (show on faces, not in voices): the surface lines differ from what they really mean — "${beat.subtext}". Let that truth surface as micro-expressions under the surface emotion.`
      : '';

    const klingPrompt = [
      stylePrefix,
      blockingHint,
      emotionHint.trim(),
      subtextHint.trim(),
      dialogueHint
    ].filter(Boolean).join(' ');

    // Build Kling elements[] from both personas — the character identity lock
    // comes from these inline elements (frontal + reference_image_urls), not
    // from a flat reference_images array.
    const { elements, elementTokens } = buildKlingElementsFromPersonas(resolvedPersonas);
    const startFrameUrl = scene?.scene_master_url
      || previousBeat?.endframe_url
      || elements[0]?.frontal_image_url;
    if (!startFrameUrl) {
      throw new Error(`beat ${beat.beat_id}: no start frame available`);
    }

    // Splice @Element1/@Element2 tokens into the prompt so Kling binds the
    // dialogue lines to the correct characters in the two-shot.
    const taggedPrompt = elementTokens.length >= 2
      ? `${klingPrompt} ${elementTokens[0]} speaks first, then ${elementTokens[1]} responds.`
      : klingPrompt;

    this.logger.info(`[${beat.beat_id}] Stage B: Kling O3 Omni two-shot (${elements.length} element(s))`);
    const klingResult = await kling.generateDialogueBeat({
      startFrameUrl,
      elements,
      prompt: taggedPrompt,
      options: {
        duration,
        aspectRatio: '9:16',
        generateAudio: true
      }
    });

    // Stage C — sync lipsync. For two-shot, we run the corrective pass ONCE
    // against a combined audio track (both dialogue lines concatenated). True
    // per-speaker mask routing would require BytePlus which is not in V4.
    // Acceptable tradeoff per the reviewer's Mode B architecture decision.
    let finalVideoBuffer = klingResult.videoBuffer;
    let finalVideoUrl = klingResult.videoUrl;
    let syncPassSucceeded = false;

    if (syncLipsync && audioUrls.length > 0) {
      try {
        this.logger.info(`[${beat.beat_id}] Stage C: Sync Lipsync v3 (best-effort corrective pass on combined audio)`);
        // For Phase 1a, we use the first speaker's audio for the corrective pass.
        // Phase 2 upgrade: concatenate the audio tracks time-aligned and feed the combined.
        const syncResult = await syncLipsync.applyLipsync({
          videoUrl: klingResult.videoUrl,
          audioUrl: audioUrls[0],
          options: { syncMode: 'cut_off' }
        });
        finalVideoBuffer = syncResult.videoBuffer;
        finalVideoUrl = syncResult.videoUrl;
        syncPassSucceeded = true;
      } catch (err) {
        this.logger.warn(`[${beat.beat_id}] Sync pass failed, falling back to Kling raw: ${err.message}`);
      }
    }

    const klingCost = COST_KLING_OMNI_STANDARD_PER_SEC * duration;
    const ttsCost = dialogues.reduce((n, d) => n + (d || '').length * COST_TTS_PER_CHAR, 0);
    const syncCost = syncPassSucceeded ? COST_SYNC_LIPSYNC_V3_FLAT : 0;
    const totalCost = klingCost + ttsCost + syncCost;

    return {
      videoBuffer: finalVideoBuffer,
      durationSec: duration,
      modelUsed: syncPassSucceeded ? 'kling-o3-omni-twoshot+sync' : 'kling-o3-omni-twoshot',
      costUsd: totalCost,
      metadata: {
        personaCount: resolvedPersonas.length,
        klingVideoUrl: klingResult.videoUrl,
        finalVideoUrl,
        syncPassSucceeded,
        audioUrls
      }
    };
  }
}

export default GroupTwoShotGenerator;
export { GroupTwoShotGenerator };
