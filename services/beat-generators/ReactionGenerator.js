// services/beat-generators/ReactionGenerator.js
// V4 REACTION beat generator.
//
// Silent closeup RESPONDING to the previous beat (shock, recognition, tears).
// 2-4 second emotional-arc beat: start frame neutral → end frame emotional.
//
// Routes to Veo 3.1 Standard with first/last frame anchoring — this is
// exactly what Veo's unique capability was built for: "start here, end there,
// fill 2-4s of micro-motion in between". Kling has no equivalent.
//
// For a REACTION, the start frame comes from the previous beat's endframe
// (or the scene master if this is the scene opener). The last frame is not
// explicitly provided — we let Veo improvise the emotional end state from
// the prompt.

import BaseBeatGenerator from './BaseBeatGenerator.js';

// Veo 3.1 Standard at 1080p with audio: $0.40/s
const COST_VEO_STANDARD_PER_SEC = 0.40;

class ReactionGenerator extends BaseBeatGenerator {
  static beatTypes() {
    return ['REACTION'];
  }

  static estimateCost(beat) {
    const duration = beat.duration_seconds || 3;
    return COST_VEO_STANDARD_PER_SEC * duration;
  }

  async _doGenerate({ beat, scene, refStack, personas, episodeContext, previousBeat }) {
    const { veo } = this.falServices;
    if (!veo) throw new Error('ReactionGenerator: veo service not in deps');

    const persona = this._resolvePersona(beat, personas);
    if (!persona) throw new Error(`beat ${beat.beat_id}: no persona resolved for REACTION`);

    const duration = Math.max(2, Math.min(4, beat.duration_seconds || 3));

    // Phase 2 keystone — persona-locked first frame (Veo has no reference-image
    // API, so we synthesize a Seedream still that shows the persona in the
    // scene master's look at this beat's expression state, then feed it as Veo's
    // first_frame. This eliminates identity drift on REACTION beats, which was
    // the loudest "characters appear out of thin air" symptom.
    const personaLockUrl = await this._buildPersonaLockedFirstFrame({
      beat, scene, previousBeat, personas, episodeContext
    });

    // Start frame waterfall: persona-lock (best) → previous endframe → scene
    // master → persona closeup. The waterfall is unchanged when persona-lock
    // returns null (V4_PERSONA_LOCK_FRAME=false or Seedream failure).
    const firstFrameUrl = personaLockUrl
      || previousBeat?.endframe_url
      || scene?.scene_master_url
      || persona.reference_image_urls?.[1] // closeup view
      || persona.reference_image_urls?.[0];
    if (!firstFrameUrl) {
      throw new Error(`beat ${beat.beat_id}: no start frame for REACTION`);
    }

    const stylePrefix = episodeContext?.visual_style_prefix || '';
    const expressionArc = beat.expression_notes || 'subtle emotional shift';
    // REACTION beats center on a persona by design, but we avoid embedding
    // the persona name in the prompt — the first-frame reference already
    // identifies the character and Vertex's content filter tends to refuse
    // "Tight closeup on <Name>" combined with a person-identifying image.
    // Phase 3.2 — framing recipe (defaults to tight_closeup for REACTION)
    const framingRecipe = this._resolveFramingRecipe(beat)
      || 'Lens 85-100mm, close shot. Locked-off, shallow DOF, intimate framing.';

    // V4 Phase 9 — vertical framing + identity anchoring. REACTION beats are
    // the biggest identity-drift risk on Veo (no reference-image API), so the
    // textual identity lock reinforces the Seedream persona-locked first frame.
    const verticalDirective = this._buildVerticalFramingDirective(beat, 'veo');
    const identityDirective = this._buildIdentityAnchoringDirective();
    const subjectDirective = this._buildSubjectPresenceDirective(beat, episodeContext);

    const prompt = this._appendDirectorNudge([
      verticalDirective,
      stylePrefix,
      'Tight closeup on the character in frame.',
      framingRecipe,
      identityDirective,
      subjectDirective,
      'Silent beat, no dialogue.',
      `Emotional arc: ${expressionArc}.`,
      'Micro-expression emphasis, shallow depth of field, intimate framing.'
    ].filter(Boolean).join(' '), beat);

    this.logger.info(`[${beat.beat_id}] Veo REACTION (${duration}s, first-frame only)`);

    const personaNames = (personas || [])
      .map(p => p && p.name)
      .filter(n => typeof n === 'string' && n.length > 0);

    const result = await veo.generateWithFrames({
      firstFrameUrl,
      lastFrameUrl: null, // let Veo improvise the end state
      prompt,
      options: {
        duration,
        aspectRatio: '9:16',
        generateAudio: true, // Veo's native ambient for the reaction (soft room tone)
        tier: 'standard',
        personaNames,
        sanitizationContext: {
          subjectName: 'the character',
          subjectDescription: expressionArc,
          stylePrefix
        }
      }
    });

    // Use the ACTUAL duration returned by Veo (may be snapped up to {4,6,8}
    // since Vertex only accepts those bins for image_to_video). The
    // scene-graph and post-production alignment need the true clip length.
    const actualDuration = result.duration || duration;

    return {
      videoBuffer: result.videoBuffer,
      durationSec: actualDuration,
      modelUsed: `veo-3.1-standard/reaction (tier ${result.fallbackTier})`,
      costUsd: COST_VEO_STANDARD_PER_SEC * actualDuration,
      metadata: {
        veoVideoUrl: result.videoUrl,
        fallbackTier: result.fallbackTier,
        firstFrameUrl,
        personaLocked: !!personaLockUrl,
        requestedDurationSec: duration,
        snappedDurationSec: actualDuration
      }
    };
  }
}

export default ReactionGenerator;
export { ReactionGenerator };
