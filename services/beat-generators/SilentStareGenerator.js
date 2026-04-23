// services/beat-generators/SilentStareGenerator.js
// V4 SILENT_STARE beat generator.
//
// A held closeup with no dialogue and no external causal reaction.
// The "she looks out the window before the cliffhanger" beat — just IS.
// Routes to Kling O3 Omni Standard with silent ambient audio, because
// Omni's micro-expression machinery still animates breathing, eye movement,
// and micro-tension even without spoken audio.
//
// Key distinction from REACTION: a REACTION responds to the previous beat
// (receives emotional momentum). A SILENT_STARE creates its own emotional
// weight from stillness.
//
// Fallback: OmniHuman 1.5 (Mode A) with a silent audio track.

import BaseBeatGenerator from './BaseBeatGenerator.js';
import { buildKlingElementsFromPersonas } from '../KlingFalService.js';

const COST_KLING_OMNI_STANDARD_PER_SEC = 0.168;

class SilentStareGenerator extends BaseBeatGenerator {
  static beatTypes() {
    return ['SILENT_STARE'];
  }

  static estimateCost(beat) {
    const duration = beat.duration_seconds || 3;
    return COST_KLING_OMNI_STANDARD_PER_SEC * duration;
  }

  async _doGenerate({ beat, scene, refStack, personas, episodeContext, previousBeat }) {
    const { kling } = this.falServices;
    if (!kling) throw new Error('SilentStareGenerator: kling service not in deps');

    const persona = this._resolvePersona(beat, personas);
    if (!persona) throw new Error(`beat ${beat.beat_id}: no persona resolved`);

    const duration = beat.duration_seconds || 3;
    const startFrameUrl = this._pickStartFrame(refStack, previousBeat, scene);
    if (!startFrameUrl) {
      throw new Error(`beat ${beat.beat_id}: no start frame for silent stare`);
    }

    const stylePrefix = episodeContext?.visual_style_prefix || '';
    const intensity = beat.emotional_intensity || 'medium';
    const gaze = beat.gaze_direction ? ` Eyes look ${beat.gaze_direction}.` : '';

    // V4 Phase 9 — vertical framing + identity anchoring (condensed for 512-char budget).
    const verticalDirective = 'VERTICAL 9:16 tight portrait. Eyes upper third, chin lower third, face fills vertical frame.';
    const identityDirective = 'Preserve facial structure from refs (bone geometry). Same person, same face.';

    // Silent stare prompt — tight, no dialogue, held emotional weight.
    const prompt = [
      verticalDirective,
      identityDirective,
      stylePrefix,
      'Tight closeup, absolute stillness, held emotional weight.',
      `Intensity: ${intensity}.`,
      gaze.trim(),
      'Breath visible, micro-tension in the jaw, no dialogue, no sound from the character.',
      'Ambient room tone only.'
    ].filter(Boolean).join(' ');

    const { elements } = buildKlingElementsFromPersonas([persona]);

    this.logger.info(`[${beat.beat_id}] Kling O3 Omni silent stare (${duration}s, ${intensity}, ${elements.length} element(s))`);
    const result = await kling.generateDialogueBeat({
      startFrameUrl,
      elements,
      prompt,
      options: {
        duration,
        aspectRatio: '9:16',
        generateAudio: true // ambient only, no speech in prompt
      }
    });

    return {
      videoBuffer: result.videoBuffer,
      durationSec: duration,
      modelUsed: 'kling-o3-omni-standard/silent',
      costUsd: COST_KLING_OMNI_STANDARD_PER_SEC * duration,
      metadata: {
        klingVideoUrl: result.videoUrl,
        intensity
      }
    };
  }
}

export default SilentStareGenerator;
export { SilentStareGenerator };
