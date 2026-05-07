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
import { buildKlingElementsFromPersonas, buildKlingSubjectElement } from '../KlingFalService.js';

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
    // V4 Tier 2.1 (2026-05-06) — pass `beat` for continuity breadcrumb.
    const startFrameUrl = this._pickStartFrame(refStack, previousBeat, scene, beat);
    if (!startFrameUrl) {
      throw new Error(`beat ${beat.beat_id}: no start frame for silent stare`);
    }

    const stylePrefix = episodeContext?.visual_style_prefix || '';
    const intensity = beat.emotional_intensity || 'medium';
    const gaze = beat.gaze_direction ? ` Eyes look ${beat.gaze_direction}.` : '';

    // V4 Phase 9 — vertical framing + identity anchoring.
    // Priority-budgeted: mandatory sections always included within 480-char soft
    // budget; optional sections (gaze, stylePrefix) dropped whole if overflowing.
    // Never truncates — truncation silently corrupts identity/vertical directives.
    const KLING_BUDGET = 480; // 32-char margin below Kling's 512-char hard limit

    const VERTICAL = 'VERTICAL 9:16 tight portrait. Eyes upper third, chin lower third, face fills vertical frame.';
    const IDENTITY = 'Preserve facial structure from refs (bone geometry). Same person, same face.';
    const core = [
      'Tight closeup, absolute stillness, held emotional weight.',
      `Intensity: ${intensity}.`,
      'Breath visible, micro-tension in jaw, no dialogue.',
      'Ambient room tone only.'
    ].join(' ');

    // Mandatory block — must always be present (~334 chars base)
    const mandatory = [VERTICAL, IDENTITY, core].join(' ');

    // V4 Director Agent (L3) nudge — add as a HIGH-priority optional that
    // joins the budget queue ahead of stylePrefix when the orchestrator's
    // Lens C blocking-mode retry stamps a director_nudge onto the beat.
    const directorNudge = (typeof beat?.director_nudge === 'string' && beat.director_nudge.trim().length > 0)
      ? `DIRECTOR'S NOTE (retake): ${beat.director_nudge.trim()}`
      : '';

    // V4 Tier 2.2 (2026-05-06) — wardrobe + brand color join optional queue.
    // SILENT_STARE is closeup-heavy where wardrobe shows; bumped above
    // stylePrefix in the drop-priority order.
    const wardrobeDirective = this._buildWardrobeDirective(persona);
    const brandColorDirective = this._buildBrandColorDirective(episodeContext);

    // V4 Phase 11 (2026-05-07) — prior-beat closing-state. SILENT_STARE is
    // a held moment that ONLY makes sense as a continuation of the prior
    // beat's tension. Without prior closing_state, the model picks a generic
    // "thoughtful pause"; with it, the stare carries the specific charge of
    // the line that just landed.
    const priorBeatContinuity = this._buildContinuityFromPreviousBeat(previousBeat, { mode: 'compact' });
    // V4 Phase 11 (2026-05-07) — scene anchor + sonic overlay (compact).
    const sceneAnchorDirective = this._buildSceneAnchorDirective(scene, episodeContext, { mode: 'compact' });
    // V4 Phase 11 (2026-05-07) — structured DP directive.
    const dpDirective = this._buildDpDirective(beat);

    // Optional sections in drop-priority order: nudge, prior-beat continuity,
    // DP directive, scene anchor, gaze, wardrobe, brand-color, style.
    const optionals = [directorNudge, priorBeatContinuity, dpDirective, sceneAnchorDirective, gaze.trim(), wardrobeDirective, brandColorDirective, stylePrefix].filter(Boolean);
    const optionalParts = [];
    let remaining = KLING_BUDGET - mandatory.length - 1;
    for (const opt of optionals) {
      if (opt.length + 1 <= remaining) {
        optionalParts.push(opt);
        remaining -= opt.length + 1;
      }
    }

    const prompt = optionalParts.length
      ? [...optionalParts, mandatory].join(' ')
      : mandatory;

    const { elements } = buildKlingElementsFromPersonas([persona]);

    // Non-invasive subject anchoring — when subject_present and there's room
    // (silent stare uses 1 persona element, so slot 2-3 are free), append the
    // brand subject as a pure visual ref. No prompt change.
    if (beat.subject_present && elements.length < 3) {
      const subjectElement = buildKlingSubjectElement(episodeContext?.subjectReferenceImages);
      if (subjectElement) {
        elements.push(subjectElement);
        this.logger.info(`[${beat.beat_id}] subject element added to Kling refs (${elements.length}/3)`);
      }
    }

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
