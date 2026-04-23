// services/beat-generators/ActionGenerator.js
// V4 ACTION_NO_DIALOGUE beat generator.
//
// Physical action, movement, environmental interaction with no spoken dialogue.
// Routes to Kling V3 Pro — prompt-first cinematic action with native physics,
// up to 15s continuous, and the best-in-class on-screen text rendering for
// brand signage / product labels / captions.
//
// This generator also handles the text-rendering override: any beat flagged
// with requires_text_rendering: true routes through here (via BeatRouter's
// override), regardless of its original beat type.

import BaseBeatGenerator from './BaseBeatGenerator.js';
import { buildKlingElementsFromPersonas } from '../KlingFalService.js';

const COST_KLING_V3_PRO_PER_SEC = 0.224;

class ActionGenerator extends BaseBeatGenerator {
  static beatTypes() {
    return ['ACTION_NO_DIALOGUE'];
  }

  static estimateCost(beat) {
    const duration = beat.duration_seconds || 5;
    return COST_KLING_V3_PRO_PER_SEC * duration;
  }

  async _doGenerate({ beat, scene, refStack, personas, episodeContext, previousBeat, routingMetadata }) {
    const { kling } = this.falServices;
    if (!kling) throw new Error('ActionGenerator: kling service not in deps');

    const duration = Math.max(3, Math.min(15, beat.duration_seconds || 5));
    const isTextOverride = routingMetadata?.mode === 'text_override';

    // Start frame: previous endframe (continuity) → scene master → first persona ref → null (text-only)
    const startFrameUrl = this._pickStartFrame(refStack, previousBeat, scene);

    const stylePrefix = episodeContext?.visual_style_prefix || '';
    const actionPrompt = beat.action_prompt || beat.visual_direction || 'cinematic action beat';
    const cameraNotes = beat.camera_notes || '';
    const ambientSound = beat.ambient_sound || '';

    // If this is a text-override beat, emphasize text rendering in the prompt.
    const textHint = isTextOverride
      ? ' IMPORTANT: render any visible in-scene text clearly and accurately (signs, labels, captions).'
      : '';

    // V4 Phase 9 — vertical framing + identity anchoring (when personas are
    // in the action). Kling V3 Pro has a higher prompt budget than O3 Omni,
    // but we still use the condensed directive to leave room for action prose.
    const verticalDirective = 'VERTICAL 9:16. Kinetic action along vertical axis (tilt/crane), vertical blocking. No horizontal wide composition.';
    const hasPersonas = (Array.isArray(beat.persona_indexes) && beat.persona_indexes.length > 0)
      || (typeof beat.persona_index === 'number');
    const identityDirective = hasPersonas
      ? 'Identity lock: match facial structure from refs (bone geometry). Same person.'
      : '';

    const prompt = [
      verticalDirective,
      stylePrefix,
      actionPrompt,
      cameraNotes,
      identityDirective,
      ambientSound ? `Ambient: ${ambientSound}` : '',
      textHint.trim()
    ].filter(Boolean).join('. ');

    // Action beats may include personas if visible_persona_indexes is present
    const personasInShot = [];
    if (Array.isArray(beat.persona_indexes)) {
      for (const idx of beat.persona_indexes) {
        if (personas[idx]) personasInShot.push(personas[idx]);
      }
    } else if (typeof beat.persona_index === 'number' && personas[beat.persona_index]) {
      personasInShot.push(personas[beat.persona_index]);
    }
    const { elements } = buildKlingElementsFromPersonas(personasInShot);

    this.logger.info(
      `[${beat.beat_id}] Kling V3 Pro ACTION (${duration}s${isTextOverride ? ', TEXT OVERRIDE' : ''}${startFrameUrl ? ', anchored' : ', text-only'}, ${elements.length} element(s))`
    );

    const result = await kling.generateActionBeat({
      startFrameUrl,
      elements,
      prompt,
      options: {
        duration,
        aspectRatio: '9:16',
        generateAudio: true
      }
    });

    return {
      videoBuffer: result.videoBuffer,
      durationSec: duration,
      modelUsed: isTextOverride ? 'kling-v3-pro/text-override' : 'kling-v3-pro/action',
      costUsd: COST_KLING_V3_PRO_PER_SEC * duration,
      metadata: {
        klingVideoUrl: result.videoUrl,
        textOverride: isTextOverride,
        originalType: routingMetadata?.originalType || beat.type
      }
    };
  }
}

export default ActionGenerator;
export { ActionGenerator };
