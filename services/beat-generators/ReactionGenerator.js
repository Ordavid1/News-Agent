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

    // V4 Tier 2.1 (2026-05-06) — unified canonical waterfall. The persona's
    // closeup reference images become the refStack tail (slots 8-9) when
    // persona-lock fails AND no endframe / scene-master is available — the
    // unified picker handles that via refStack[0]. We pre-pend the persona
    // closeup refs to the local refStack so the picker finds them at tier 9.
    const localRefStack = [
      ...(refStack || []),
      persona.reference_image_urls?.[1], // closeup view
      persona.reference_image_urls?.[0]
    ].filter(Boolean);
    const firstFrameUrl = this._pickStartFrame(localRefStack, previousBeat, scene, beat, {
      personaLockUrl
    });
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

    // V4 Tier 2.2 (2026-05-06) — wardrobe + brand palette + per-model
    // color hint. Wardrobe is the highest-leverage continuity signal for
    // REACTION beats specifically (the closeup reveals costume detail).
    const colorHint = this._buildPerModelColorHint('veo', episodeContext?.brandKit);
    const wardrobeDirective = this._buildWardrobeDirective(persona);
    const brandColorDirective = this._buildBrandColorDirective(episodeContext);
    // V4 Tier 2.5 (2026-05-06) — scene continuity sheet.
    const continuityDirective = this._buildContinuityDirective(scene, beat);
    // V4 Tier 3.1 (2026-05-06) — anti-reference (Veo-strength). REACTION
    // beats are particularly prone to "same closeup as last beat" because
    // both ReactionGenerator and CinematicDialogueGenerator default to
    // tight portraits — the directive forces the model to differ on at
    // least one axis (subject placement, angle, framing density).
    const antiRefDirective = this._buildPreviousBeatAntiReferenceDirective(previousBeat, 'veo');

    const prompt = this._appendDirectorNudge([
      verticalDirective,
      stylePrefix,
      'Tight closeup on the character in frame.',
      framingRecipe,
      identityDirective,
      wardrobeDirective,
      continuityDirective,
      subjectDirective,
      brandColorDirective,
      antiRefDirective,
      'Silent beat, no dialogue.',
      `Emotional arc: ${expressionArc}.`,
      'Micro-expression emphasis, shallow depth of field, intimate framing.',
      colorHint
    ].filter(Boolean).join(' '), beat);

    this.logger.info(`[${beat.beat_id}] Veo REACTION (${duration}s, first-frame only)`);

    const personaNames = (personas || [])
      .map(p => p && p.name)
      .filter(n => typeof n === 'string' && n.length > 0);

    let result;
    try {
      result = await veo.generateWithFrames({
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
          },
          // 2026-05-06 — Veo→Kling fallback (Step 8). REACTION beats are
          // 2-4s silent persona close-ups; persona elements[] is mandatory
          // (the persona IS the beat). Kling V3 Pro produces this fine.
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
        ? `Veo content filter persistent on REACTION (${(err.message || '').slice(0, 80)})`
        : `Veo error on REACTION (${(err.message || '').slice(0, 80)})`;
      this.logger.warn(
        `[${beat.beat_id}] ${fallbackReason} — falling back to Kling V3 Pro (persona elements[] required)`
      );

      // Kling-friendly tight closeup prompt — persona elements[] is the
      // identity anchor (no first-frame needed; no last-frame on reactions).
      const klingReactionPrompt = this._appendDirectorNudge([
        verticalDirective,
        stylePrefix,
        'Tight closeup on the character. Silent beat, no dialogue.',
        framingRecipe,
        identityDirective,
        wardrobeDirective,
        `Emotional arc: ${expressionArc}.`,
        'Micro-expression emphasis, shallow depth of field, intimate framing.'
      ].filter(Boolean).join(' '), beat);

      return await this._fallbackToKlingForVeoFailure({
        beat, scene, refStack, personas, episodeContext, previousBeat,
        routingMetadata: undefined,
        prompt: klingReactionPrompt,
        duration,
        beatTypeLabel: 'reaction',
        includeSubject: false,
        includePersonaElements: true, // mandatory — persona is the whole point
        fallbackReason,
        veoSanitizationTier: null,
        generateAudio: true, // Kling provides soft ambient; post-prod handles SFX overlay
        extraMetadata: {
          firstFrameUrl,
          personaLocked: !!personaLockUrl
        }
      });
    }

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
