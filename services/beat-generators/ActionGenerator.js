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
import { buildKlingElementsFromPersonas, buildKlingSubjectElement } from '../KlingFalService.js';

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

    // V4 Tier 2.1 (2026-05-06) — unified canonical waterfall (priority:
    // persona-lock → SIPL → subject-natural → bridge-anchor → previous
    // endframe → scene master → refStack). Passing `beat` enables the
    // continuity_fallback_reason breadcrumb that Lens C / Lens E read.
    const startFrameUrl = this._pickStartFrame(refStack, previousBeat, scene, beat);

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
    const subjectDirective = this._buildSubjectPresenceDirective(beat, episodeContext);

    // V4 Tier 2.2 (2026-05-06) — per-model color hint, persona wardrobe,
    // brand palette directives. Spliced near the prompt tail. Empty
    // strings filtered out by .filter(Boolean).
    const personasInBeat = this._resolvePersonasInBeat(beat, personas);
    const colorHint = this._buildPerModelColorHint('kling', episodeContext?.brandKit);
    const wardrobeDirective = personasInBeat.length > 0
      ? this._buildWardrobeDirective(personasInBeat[0])
      : '';
    const brandColorDirective = this._buildBrandColorDirective(episodeContext);
    // V4 Tier 2.5 (2026-05-06) — scene continuity sheet (props/lighting/time).
    const continuityDirective = this._buildContinuityDirective(scene, beat);
    // V4 Phase 11 (2026-05-07) — prior-beat closing-state continuity. Compact
    // mode for Kling's prompt budget. Tells the model what performance state
    // the prior beat ended in so this action beat picks up the chain instead
    // of rendering a fresh take.
    const priorBeatContinuity = this._buildContinuityFromPreviousBeat(previousBeat, { mode: 'compact' });
    // V4 Phase 11 (2026-05-07) — scene anchor + sonic overlay. Surfaces the
    // DP brief's lighting/palette/atmosphere + the scene's audio register
    // so the beat is rendered IN the scene's specific look, not a generic
    // "kinetic action" register.
    const sceneAnchorDirective = this._buildSceneAnchorDirective(scene, episodeContext, { mode: 'compact' });
    // V4 Phase 11 (2026-05-07) — structured DP directive. Consolidates
    // beat.lens / focal_length_hint / coverage_slot / camera_temperament /
    // motion_vector / subject_presence into a single line so the generator
    // gets explicit lens character instead of falling back to its model
    // prior (Kling V3 defaults to music-video shallow-DoF).
    const dpDirective = this._buildDpDirective(beat);
    // V4 Tier 3.1 (2026-05-06) — anti-reference directive. Kling-strength.
    const antiRefDirective = this._buildPreviousBeatAntiReferenceDirective(previousBeat, 'kling');

    const prompt = this._appendDirectorNudge([
      verticalDirective,
      stylePrefix,
      sceneAnchorDirective,
      dpDirective,
      actionPrompt,
      cameraNotes,
      identityDirective,
      wardrobeDirective,
      continuityDirective,
      priorBeatContinuity,
      subjectDirective,
      brandColorDirective,
      antiRefDirective,
      ambientSound ? `Ambient: ${ambientSound}` : '',
      textHint.trim(),
      colorHint
    ].filter(Boolean).join('. '), beat);

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

    // Non-invasive subject anchoring — when the screenplay marks subject_present
    // and there's room in elements[], append the subject as a pure visual ref.
    // No prompt change: Kling locks the form factor via the reference alone.
    if (beat.subject_present && elements.length < 3) {
      const subjectElement = buildKlingSubjectElement(episodeContext?.subjectReferenceImages);
      if (subjectElement) {
        elements.push(subjectElement);
        this.logger.info(`[${beat.beat_id}] subject element added to Kling refs (${elements.length}/3)`);
      }
    }

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
