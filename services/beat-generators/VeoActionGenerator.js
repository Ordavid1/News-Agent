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
    let veoFatalError = null;
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
          // Veo Failure-Learning Agent telemetry context — VeoService records
          // refusals + recoveries against this so the nightly agent can cluster
          // failures per-episode / per-tenant.
          telemetry: {
            userId: episodeContext?.userId,
            episodeId: episodeContext?.episodeId,
            beatId: beat.beat_id,
            beatType: beat.type
          }
        }
      });
    } catch (err) {
      // Veo refused ALL sanitization tiers including text-only — fall back to Kling.
      // (VeoService throws with isVeoContentFilter=true when the chain exhausts.)
      veoFatalError = err;
    }

    // 2026-05-06 — Kling V3 Pro fallback for content-filter persistent failures.
    //
    // Two failure modes both fall back to Kling:
    //   1. Veo threw — all sanitization tiers refused, including tier3-no-image.
    //   2. Veo accepted ONLY at tier3-no-image — text-only output with NO
    //      first-frame anchor. Identity is invented from text alone → guaranteed
    //      face drift → Director Agent hard_reject (observed 2026-05-05 in
    //      production: beat s1b2 hit hard_reject score 42 then halted episode).
    //
    // Kling has different content-filter sensitivity AND accepts the persona
    // elements[] anchor (not just first-frame), so it succeeds where Veo
    // refuses on the same persona-lock still. This converts a guaranteed
    // failure into a working beat with the documented Kling face_drift_in_action
    // risk (severity 4, frame 60+) — far better than text-only Veo.
    const veoTier3 = result && result.sanitizationTier === 'tier3-no-image';
    const veoUnusable = veoFatalError || veoTier3;

    if (veoUnusable) {
      const fallbackReason = veoFatalError
        ? `Veo refused all tiers (${(veoFatalError.message || '').slice(0, 80)})`
        : `Veo accepted only tier3-no-image (text-only, NO anchor) — would face-drift`;
      this.logger.warn(
        `[${beat.beat_id}] ${fallbackReason} — falling back to Kling V3 Pro for action beat`
      );

      // Veo Failure-Learning Agent — record the Kling-fallback trigger BEFORE
      // attempting Kling, so the agent's data captures the trigger event even
      // if the Kling call itself throws downstream.
      VeoFailureCollector.record({
        userId: episodeContext?.userId,
        episodeId: episodeContext?.episodeId,
        beatId: beat.beat_id,
        beatType: beat.type,
        error: veoFatalError,
        errorMessage: fallbackReason,
        prompt,
        personaNames,
        hadFirstFrame: !!resolvedFirstFrame,
        hadLastFrame: false,
        durationSec: duration,
        aspectRatio: '9:16',
        modelAttempted: 'veo-3.1-vertex',
        attemptTierReached: 'kling_fallback',
        recoverySucceeded: null, // outcome unknown until Kling completes
        fallbackModel: 'kling-v3-pro'
      }).catch(() => {});

      return await this._fallbackToKlingAction({
        beat, scene, refStack, personas, episodeContext, previousBeat, routingMetadata,
        duration, fallbackReason, veoSanitizationTier: result?.sanitizationTier || null
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

  /**
   * 2026-05-06 — Kling V3 Pro in-process fallback for content-filter persistent
   * failures on Veo.
   *
   * Triggered when Veo content-filter forces tier3-no-image (text-only output)
   * OR when all Veo tiers refuse outright. Inlined here rather than throwing
   * so the beat completes successfully on the first attempt instead of
   * triggering Director Agent hard_reject → orchestrator escalate → episode
   * halt cycle (which is what production hit on 2026-05-05 beat s1b2).
   *
   * Mirrors ActionGenerator's _doGenerate logic: builds Kling V3 Pro prompt
   * with elements[] persona anchor, calls kling.generateActionBeat(). Identity
   * is preserved via Kling's elements API (not first-frame) — different anchor
   * mechanism than Veo, so the same persona-lock IMAGE that Veo's filter
   * rejected may not even be referenced (Kling uses persona reference URLs).
   */
  async _fallbackToKlingAction({ beat, scene, refStack, personas, episodeContext, previousBeat, routingMetadata, duration, fallbackReason, veoSanitizationTier }) {
    const { kling } = this.falServices;
    if (!kling) {
      throw new Error(`VeoActionGenerator: Veo unusable AND kling service not in deps — beat ${beat.beat_id} cannot fall back. ${fallbackReason}`);
    }

    // Lazy import to avoid circular ref between VeoActionGenerator and ActionGenerator.
    const { buildKlingElementsFromPersonas, buildKlingSubjectElement } = await import('../KlingFalService.js');

    // Kling clamps action beats to [3, 15]s; we widen the lower bound from
    // Veo's 8s ceiling so a 5s Veo beat stays 5s on Kling.
    const klingDuration = Math.max(3, Math.min(15, duration));

    // V4 Tier 2.1 (2026-05-06) — Kling fallback path uses the same unified
    // picker so the continuity breadcrumb stays set even on the secondary
    // route. Note: Kling DOES accept first frames even though the filter on
    // Veo rejected the persona-lock — Kling's moderation runs on prompt
    // content, not image content, the same way.
    const startFrameUrl = this._pickStartFrame(refStack, previousBeat, scene, beat);

    const stylePrefix = episodeContext?.visual_style_prefix || '';
    const actionPrompt = beat.action_prompt || beat.visual_direction || 'cinematic action beat';
    const cameraNotes = beat.camera_notes || '';
    const ambientSound = beat.ambient_sound || '';

    // Same vertical + identity anchoring as ActionGenerator's prompt.
    const verticalDirective = 'VERTICAL 9:16. Kinetic action along vertical axis (tilt/crane), vertical blocking. No horizontal wide composition.';
    const hasPersonas = (Array.isArray(beat.persona_indexes) && beat.persona_indexes.length > 0)
      || (typeof beat.persona_index === 'number');
    const identityDirective = hasPersonas
      ? 'Identity lock: match facial structure from refs (bone geometry). Same person.'
      : '';
    const subjectDirective = this._buildSubjectPresenceDirective(beat, episodeContext);

    const prompt = this._appendDirectorNudge([
      verticalDirective,
      stylePrefix,
      actionPrompt,
      cameraNotes,
      identityDirective,
      subjectDirective,
      ambientSound ? `Ambient: ${ambientSound}` : ''
    ].filter(Boolean).join('. '), beat);

    // Build Kling elements[] persona anchor (different mechanism than Veo's first-frame).
    const personasInShot = [];
    if (Array.isArray(beat.persona_indexes)) {
      for (const idx of beat.persona_indexes) {
        if (personas[idx]) personasInShot.push(personas[idx]);
      }
    } else if (typeof beat.persona_index === 'number' && personas[beat.persona_index]) {
      personasInShot.push(personas[beat.persona_index]);
    }
    const { elements } = buildKlingElementsFromPersonas(personasInShot);

    // Subject anchor when room in elements[].
    if (beat.subject_present && elements.length < 3) {
      const subjectElement = buildKlingSubjectElement(episodeContext?.subjectReferenceImages);
      if (subjectElement) {
        elements.push(subjectElement);
      }
    }

    this.logger.info(
      `[${beat.beat_id}] Kling V3 Pro ACTION (Veo fallback, ${klingDuration}s, ${startFrameUrl ? 'anchored' : 'text-only'}, ${elements.length} element(s))`
    );

    const COST_KLING_V3_PRO_PER_SEC = 0.224;
    const result = await kling.generateActionBeat({
      startFrameUrl,
      elements,
      prompt,
      options: {
        duration: klingDuration,
        aspectRatio: '9:16',
        generateAudio: true
      }
    });

    return {
      videoBuffer: result.videoBuffer,
      durationSec: klingDuration,
      modelUsed: `kling-v3-pro/action (veo-fallback)`,
      costUsd: COST_KLING_V3_PRO_PER_SEC * klingDuration,
      metadata: {
        klingVideoUrl: result.videoUrl,
        primaryAttempt: 'veo-3.1-standard',
        primaryFailureReason: fallbackReason,
        veoSanitizationTier,
        fallbackChain: ['veo-3.1-standard', 'kling-v3-pro'],
        originalType: routingMetadata?.originalType || beat.type
      }
    };
  }
}

export default VeoActionGenerator;
export { VeoActionGenerator, KINETIC_POSTURE_DIRECTIVE };
