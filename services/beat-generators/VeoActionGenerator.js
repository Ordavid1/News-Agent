// services/beat-generators/VeoActionGenerator.js
// V4 ACTION_NO_DIALOGUE beat generator — Veo 3.1 (Vertex AI) variant.
//
// Alternative to ActionGenerator (Kling V3 Pro) for action beats. Routes to
// Veo 3.1 Standard via Vertex AI (FREE under the user's GCP quota — same
// path REACTION / INSERT_SHOT / B_ROLL_ESTABLISHING / VOICEOVER_OVER_BROLL
// already use). The directional gain over Kling V3 Pro is identity stability:
// Kling has a documented severity-marker failure mode (face_drift_in_action,
// frame 60+) that production has been working around by capping action
// durations at ~2.5s. Veo's first/last-frame anchoring + persona-locked
// first frame eliminates that drift, so action beats can run to Veo's full
// 8s ceiling without identity loss.
//
// Routing posture (BeatRouter):
//   - ACTION_NO_DIALOGUE primary stays on ActionGenerator (Kling V3 Pro) by
//     default. Beats that explicitly opt into Veo set
//     beat.preferred_generator = 'VeoActionGenerator' via the Phase 5.3
//     override surface.
//   - Recommended for: clean kinetic action 2–8s with persona identity
//     critical, no complex camera-grammar (Dutch tilt / vertigo zoom /
//     anamorphic flare / whip-pan), no requires_text_rendering.
//   - Stay on Kling for: > 8s sustained-tension single-take (BR2049 opening
//     / Sicario tunnel grammar — A1.2 amendment), complex camera moves,
//     requires_text_rendering.
//
// Cost: $0 via Vertex (Google quota). For BeatRouter.preflight cost-cap math
// we use $0.40/s pessimistic (matches sibling Veo generators) so the cap
// math doesn't differ from sibling beats; actual operational cost is zero.
//
// Mid-action posture (Director Agent verdict A1.1, 2026-05-01):
//   The persona-lock first frame for ACTION beats is generated WITH a kinetic
//   posture directive baked in (mid-stride / hand mid-arc / torso pre-rotated),
//   so the Veo first frame is already in motion. Without this, Veo would
//   "unfreeze" from a portrait pose, burning 0.5–1.5s of perceived stillness
//   before kinesis registers (12–18% kinetic tax per beat). With it, frame 1
//   reads as 1/24th of a second already in motion — Drive elevator-fight
//   ignition, not a yearbook photo.
//
// Audio: action is silent by definition. We pass generateAudio: false to
// Veo. Ambient layering is handled by post-production's per-beat SFX
// overlay (Stage 1.5) for non-Veo beats; Veo beats normally rely on Veo's
// native ambient. Since we're disabling Veo audio for ACTION (it's silent),
// the SoundEffectsService whitelist treats this beat as Veo (skip overlay).
// The episode-level sonic_world (Stage 2.5b) handles the bed.

import BaseBeatGenerator from './BaseBeatGenerator.js';
import { buildKlingElementsFromPersonas } from '../KlingFalService.js';
import VeoFailureCollector from '../v4/VeoFailureCollector.js';

// Pessimistic cost (Veo Standard at fal.ai pricing) for cost-cap math only.
// Real cost via Vertex is $0 under the user's GCP quota.
const COST_VEO_STANDARD_PER_SEC = 0.40;

// Director Agent verdict A1.1 (2026-05-01) — mid-action posture directive
// threaded into the persona-lock pre-pass prompt so Seedream renders a still
// that's already in motion. Verbatim from the verdict's prompt_delta.
const KINETIC_POSTURE_DIRECTIVE =
  'MID-ACTION POSTURE: weight already shifted, one foot off ground OR hand mid-arc OR ' +
  'torso pre-rotated. NOT a portrait. The first frame must read as 1/24th of a second ' +
  'already in motion — Drive elevator-fight ignition, not a yearbook photo.';

class VeoActionGenerator extends BaseBeatGenerator {
  static beatTypes() {
    // Note: BeatRouter ROUTING table still maps ACTION_NO_DIALOGUE to
    // ActionGenerator by default. This generator is opted into per-beat via
    // beat.preferred_generator = 'VeoActionGenerator'. The static
    // beatTypes() value here is informational (used by tests + index.js
    // factory) — not the routing source of truth.
    return ['ACTION_NO_DIALOGUE'];
  }

  static estimateCost(beat) {
    const duration = beat.duration_seconds || 5;
    return COST_VEO_STANDARD_PER_SEC * duration;
  }

  async _doGenerate({ beat, scene, refStack, personas, episodeContext, previousBeat, routingMetadata }) {
    const { veo } = this.falServices;
    if (!veo) throw new Error('VeoActionGenerator: veo service not in deps');

    // Veo 3.1 hard duration window. Beats authored > 8s should route to
    // Kling via the routing_hint in v4-beat-recipes.yaml (A1.2 amendment).
    // We still clamp here for safety.
    const duration = Math.max(2, Math.min(8, beat.duration_seconds || 5));

    // ── A1.1 keystone — kinetic persona-lock first frame ──
    // Mandatory persona-lock for ACTION (vs ReactionGenerator's optional path)
    // because Veo has no reference-image API — the first frame IS the
    // identity anchor. Without it, Veo would invent the persona's face
    // from prompt alone and drift across the 8s clip.
    //
    // postureDirective replaces the default portrait composition language
    // in the Seedream pre-pass so the still is born mid-action.
    let firstFrameUrl = null;
    if (this._resolvePersonasInBeat(beat, personas).length > 0) {
      firstFrameUrl = await this._buildPersonaLockedFirstFrame({
        beat,
        scene,
        previousBeat,
        personas,
        episodeContext,
        postureDirective: KINETIC_POSTURE_DIRECTIVE
      });
    }

    // V4 Tier 2.1 (2026-05-06) — when persona-lock returned a URL, route it
    // through the unified picker via opts.personaLockUrl so the breadcrumb
    // is set consistently. When persona-lock is null, the picker falls
    // through tiers 5+ as expected.
    const resolvedFirstFrame = this._pickStartFrame(refStack, previousBeat, scene, beat, {
      personaLockUrl: firstFrameUrl
    });

    // ── Prompt construction ──
    // Mirrors ActionGenerator's prompt structure but with Veo-specific
    // language: lean into Veo's strengths (photorealism, physics simulation,
    // first-frame anchoring continuity) and out of its weaknesses (camera
    // control fidelity vs Kling). When the beat needs a complex camera move,
    // it should have been routed to Kling instead — we still emit the move
    // but Veo will approximate it.

    const stylePrefix = episodeContext?.visual_style_prefix || '';
    const actionPrompt = beat.action_prompt || beat.visual_direction || 'cinematic action beat';
    const cameraNotes = beat.camera_notes || '';
    const ambientSound = beat.ambient_sound || '';

    // V4 Phase 9 directives — vertical framing + identity anchoring. Veo's
    // identity-drift risk on action is the primary thing we're fighting; the
    // textual identity directive reinforces the persona-locked first frame.
    const verticalDirective = this._buildVerticalFramingDirective(beat, 'veo');
    const identityDirective = this._buildIdentityAnchoringDirective();
    const subjectDirective = this._buildSubjectPresenceDirective(beat, episodeContext);

    // A1.1 — also state the kinetic-opening intent in the Veo prompt itself
    // so Veo's frame-1 → frame-2 motion vector is consistent with the
    // mid-action pose in the persona-lock still.
    const kineticOpeningHint = firstFrameUrl
      ? 'Frame 1 opens mid-motion; momentum continues forward. NOT a static start.'
      : '';

    // Phase 3.2 — framing recipe (defaults to a kinetic recipe for ACTION
    // when none specified by the screenplay).
    const framingRecipe = this._resolveFramingRecipe(beat)
      || 'Lens 35-50mm, kinetic handheld feel, shallow DOF on the subject in motion.';

    // V4 Tier 2.2 (2026-05-06) — wardrobe + brand color + per-model color
    // hint. Wardrobe matters for action because handheld coverage often
    // pulls back to wide-medium and reveals full costume.
    const personasInBeat = this._resolvePersonasInBeat(beat, personas);
    const colorHint = this._buildPerModelColorHint('veo', episodeContext?.brandKit);
    const wardrobeDirective = personasInBeat.length > 0
      ? this._buildWardrobeDirective(personasInBeat[0])
      : '';
    const brandColorDirective = this._buildBrandColorDirective(episodeContext);
    // V4 Tier 2.5 (2026-05-06) — scene continuity sheet.
    const continuityDirective = this._buildContinuityDirective(scene, beat);
    // V4 Tier 3.1 (2026-05-06) — anti-reference directive (Veo-strength).
    const antiRefDirective = this._buildPreviousBeatAntiReferenceDirective(previousBeat, 'veo');

    const prompt = this._appendDirectorNudge([
      verticalDirective,
      stylePrefix,
      kineticOpeningHint,
      actionPrompt,
      cameraNotes,
      framingRecipe,
      identityDirective,
      wardrobeDirective,
      continuityDirective,
      subjectDirective,
      brandColorDirective,
      antiRefDirective,
      ambientSound ? `Ambient: ${ambientSound}.` : '',
      'Silent beat, no dialogue.',
      colorHint
    ].filter(Boolean).join(' '), beat);

    const personaNames = (personas || [])
      .map(p => p && p.name)
      .filter(n => typeof n === 'string' && n.length > 0);

    this.logger.info(
      `[${beat.beat_id}] Veo ACTION (${duration}s, ${resolvedFirstFrame ? 'anchored' : 'text-only'}, persona-locked=${!!firstFrameUrl})`
    );

    let result;
    try {
      result = await veo.generateWithFrames({
        firstFrameUrl: resolvedFirstFrame,
        lastFrameUrl: null, // let Veo carry momentum to its own end state
        prompt,
        options: {
          duration,
          aspectRatio: '9:16',
          // Action is silent by definition — Veo's audio gen risk
          // (audio_uncanny severity 3) is irrelevant when we're not asking
          // for ambient anyway.
          generateAudio: false,
          tier: 'standard', // Vertex only exposes Standard
          personaNames,
          sanitizationContext: {
            subjectName: 'the character',
            subjectDescription: actionPrompt,
            stylePrefix
          },
          // 2026-05-06 — Veo→Kling fallback (Step 3). Skip the wasteful
          // tier3-no-image attempt; on persistent content-filter refusal
          // the catch block falls back to Kling V3 Pro via the shared
          // BaseBeatGenerator helper.
          skipTextOnlyFallback: true,
          // Veo Failure-Learning Agent telemetry context.
          telemetry: {
            userId: episodeContext?.userId,
            episodeId: episodeContext?.episodeId,
            beatId: beat.beat_id,
            beatType: beat.type
          }
        }
      });
    } catch (err) {
      // VeoContentFilterPersistentError (or any other Veo failure that
      // exposed itself before we could ship): record the Kling-fallback
      // trigger so the agent learns, then route to the shared helper.
      // Non-content-filter errors (auth, network) also get sent to Kling
      // here — degraded mode is better than failing the beat.
      const fallbackReason = err.isVeoContentFilterPersistent
        ? `Veo content filter persistent (${(err.message || '').slice(0, 80)})`
        : `Veo error (${(err.message || '').slice(0, 80)})`;

      this.logger.warn(
        `[${beat.beat_id}] ${fallbackReason} — falling back to Kling V3 Pro for action beat`
      );

      // Veo Failure-Learning Agent (2026-05-07 fix) — prefer the UNDERLYING
      // Vertex error message over the local wrapper. The wrapper text
      // ("Veo content filter persistent — all anchored tiers refused") doesn't
      // match any of the collector's failure-signature regexes, so without
      // this propagation 22/32 prod rows landed as failure_mode='other' with
      // empty error_signatures — which then produced two junk clusters during
      // the nightly agent run. The underlying err.originalError.message
      // contains the verbatim Vertex wording (e.g. "violate Vertex AI's usage
      // guidelines") which classifies correctly as content_filter_prompt.
      const underlyingMessage = err?.originalError?.message || err?.message || fallbackReason;

      VeoFailureCollector.record({
        userId: episodeContext?.userId,
        episodeId: episodeContext?.episodeId,
        beatId: beat.beat_id,
        beatType: beat.type,
        error: err.originalError || err,
        errorMessage: underlyingMessage,
        prompt,
        personaNames,
        hadFirstFrame: !!resolvedFirstFrame,
        hadLastFrame: false,
        durationSec: duration,
        aspectRatio: '9:16',
        modelAttempted: 'veo-3.1-vertex',
        attemptTierReached: 'kling_fallback',
        recoverySucceeded: null,
        fallbackModel: 'kling-v3-pro'
      }).catch(() => {});

      // Build a Kling-friendly prompt — terser than the Veo prompt; Kling's
      // elements[] anchor handles identity, so we don't need the verbose
      // identity directive Veo needed.
      const verticalDirectiveKling = 'VERTICAL 9:16. Kinetic action along vertical axis (tilt/crane), vertical blocking. No horizontal wide composition.';
      const hasPersonas = (Array.isArray(beat.persona_indexes) && beat.persona_indexes.length > 0)
        || (typeof beat.persona_index === 'number');
      const identityDirectiveKling = hasPersonas
        ? 'Identity lock: match facial structure from refs (bone geometry). Same person.'
        : '';

      const klingPrompt = this._appendDirectorNudge([
        verticalDirectiveKling,
        stylePrefix,
        actionPrompt,
        cameraNotes,
        identityDirectiveKling,
        ambientSound ? `Ambient: ${ambientSound}` : ''
      ].filter(Boolean).join('. '), beat);

      return await this._fallbackToKlingForVeoFailure({
        beat, scene, refStack, personas, episodeContext, previousBeat, routingMetadata,
        prompt: klingPrompt,
        duration,
        beatTypeLabel: 'action',
        includeSubject: true,        // ACTION beats with subject_present should anchor on it
        includePersonaElements: true, // persona-driven action — elements[] is the identity anchor
        fallbackReason,
        veoSanitizationTier: null,    // tier3 was skipped; not applicable
        generateAudio: true            // Kling's audio is fine for ambient under silent action
      });
    }

    // Use the actual duration Veo returned (Vertex snaps to {4,6,8} bins).
    const actualDuration = result.duration || duration;

    return {
      videoBuffer: result.videoBuffer,
      durationSec: actualDuration,
      modelUsed: `veo-3.1-standard/action (tier ${result.fallbackTier})`,
      costUsd: COST_VEO_STANDARD_PER_SEC * actualDuration,
      metadata: {
        veoVideoUrl: result.videoUrl,
        fallbackTier: result.fallbackTier,
        sanitizationTier: result.sanitizationTier,
        usedFirstFrame: result.usedFirstFrame !== false,
        firstFrameUrl: resolvedFirstFrame,
        personaLocked: !!firstFrameUrl,
        kineticPostureApplied: !!firstFrameUrl,
        requestedDurationSec: duration,
        snappedDurationSec: actualDuration,
        originalType: routingMetadata?.originalType || beat.type
      }
    };
  }
}

export default VeoActionGenerator;
export { VeoActionGenerator, KINETIC_POSTURE_DIRECTIVE };
