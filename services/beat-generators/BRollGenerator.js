// services/beat-generators/BRollGenerator.js
// V4 B_ROLL_ESTABLISHING beat generator.
//
// Atmospheric environment shot — no characters, no dialogue. Opens or closes
// a scene. Routes to Veo 3.1 Standard specifically for its UNIQUE capability:
// native ambient audio generation (wind, traffic, distant voices, room tone)
// synchronized with the video. This is why Veo wins over Kling for B-roll.
//
// The start frame is usually the scene master (so the b-roll matches the
// scene's established look). If there's no scene master yet, Veo improvises
// from the prompt alone (text-only tier).

import BaseBeatGenerator from './BaseBeatGenerator.js';
import { regenerateSafeFirstFrame } from '../v4/StoryboardHelpers.js';

const COST_VEO_STANDARD_PER_SEC = 0.40;

class BRollGenerator extends BaseBeatGenerator {
  static beatTypes() {
    return ['B_ROLL_ESTABLISHING'];
  }

  static estimateCost(beat) {
    const duration = beat.duration_seconds || 4;
    return COST_VEO_STANDARD_PER_SEC * duration;
  }

  async _doGenerate({ beat, scene, refStack, personas, episodeContext, previousBeat }) {
    const { veo } = this.falServices;
    if (!veo) throw new Error('BRollGenerator: veo service not in deps');

    const duration = Math.max(3, Math.min(5, beat.duration_seconds || 4));

    // Phase 2 — when Gemini flags a persona in the B-roll (e.g. "agent walks
    // onto the terrace at golden hour"), synthesize a persona-locked first
    // frame before Veo runs. For pure environment B-roll (no personas), this
    // returns null and the legacy anchor waterfall runs unchanged.
    const personaLockUrl = await this._buildPersonaLockedFirstFrame({
      beat, scene, previousBeat, personas, episodeContext
    });

    // Subject natural frame — non-invasive Veo anchoring. Fires only when the
    // screenplay explicitly sets `subject_focus` (Gemini's "subject is in this
    // shot" signal — narrower than the broader `subject_present`) and no
    // persona is locking the first frame. The 'natural' intent uses a terse
    // Seedream prompt with no compositional emphasis so Vertex's image filter
    // doesn't refuse the frame on noir/surveillance scenes.
    const hasSubjectFocus = typeof beat.subject_focus === 'string' && beat.subject_focus.trim().length > 0;
    const subjectNaturalUrl = (!personaLockUrl && hasSubjectFocus)
      ? await this._buildSceneIntegratedProductFrame({ beat, scene, episodeContext, intent: 'natural' })
      : null;

    // V4 Tier 2.1 (2026-05-06) — unified canonical first-frame waterfall.
    // Local persona-lock + subject-natural pre-passes feed via opts; the rest
    // of the priority order (cached persona-lock, bridge anchor, previous
    // endframe, scene master, refStack) lives in BaseBeatGenerator. Sets
    // beat.continuity_fallback_reason breadcrumb when fallback occurs.
    const firstFrameUrl = this._pickStartFrame(refStack, previousBeat, scene, beat, {
      personaLockUrl,
      subjectNaturalUrl
    });

    const stylePrefix = episodeContext?.visual_style_prefix || '';
    const location = beat.location || scene?.location || 'establishing shot';
    const atmosphere = beat.atmosphere || 'cinematic, evocative';
    // Default camera intent for a B_ROLL_ESTABLISHING is to REVEAL context,
    // not close in on it. The legacy 'slow dolly forward' default aggressively
    // pushed into the subject, cutting off environmental context on 2-4s
    // beats — the opposite of an establishing shot. The new default describes
    // a pullback/reveal at an establishing focal length so Veo opens the frame
    // wide. Screenplay beats can still override with beat.camera_move.
    const cameraMove = beat.camera_move
      || 'slow dolly back revealing wider context, 24-35mm wide lens';
    // Phase 3.2 — prefer the structured framing vocabulary recipe when emitted.
    // For B_ROLL_ESTABLISHING the prompt-schema rule forces wide_establishing
    // or bridge_transit, so the recipe always lands on a reveal camera.
    const framingRecipe = this._resolveFramingRecipe(beat);
    const framingIntent = framingRecipe
      || 'Wide establishing frame — full environment visible, subject positioned within context, generous headroom.';
    const ambientSound = beat.ambient_sound || 'natural ambient sound, evocative and immersive';

    // V4 Phase 9 — vertical framing directive. Veo strongly reaches for
    // 2.39:1 cinemascope on "wide establishing" prompts even when aspect_ratio
    // is 9:16, producing a letterboxed wide mid-band. The directive + the
    // per-beat-type override force low-angle vertical compositions.
    const verticalDirective = this._buildVerticalFramingDirective(beat, 'veo');
    // Persona-featuring B-rolls also need identity anchoring language.
    const identityDirective = (beat.personas_present && beat.personas_present.length > 0)
      ? this._buildIdentityAnchoringDirective()
      : '';
    // Subject locking — when subject_present, reinforce appearance at the prompt level.
    const subjectDirective = this._buildSubjectPresenceDirective(beat, episodeContext);

    // V4 Tier 2.2 (2026-05-06) — per-model color hint, persona wardrobe,
    // brand palette directives. Spliced near the prompt tail where models
    // honor them most strongly. All return '' when their inputs are absent
    // so the join+filter eliminates them cleanly.
    const personasInBeat = this._resolvePersonasInBeat(beat, personas);
    const colorHint = this._buildPerModelColorHint('veo', episodeContext?.brandKit);
    const wardrobeDirective = personasInBeat.length > 0
      ? this._buildWardrobeDirective(personasInBeat[0])
      : '';
    const brandColorDirective = this._buildBrandColorDirective(episodeContext);
    // V4 Tier 2.5 (2026-05-06) — scene-level continuity sheet (props,
    // lighting key, time of day). Empty string when scene lacks the sheet.
    const continuityDirective = this._buildContinuityDirective(scene, beat);
    // V4 Tier 3.1 (2026-05-06) — anti-reference directive. Tells Veo not to
    // reproduce the prior beat's composition, killing the b-roll/action
    // collapse symptom from the prompt-language layer (schema-level
    // adjacency rule lives in ScreenplayValidator).
    const antiRefDirective = this._buildPreviousBeatAntiReferenceDirective(previousBeat, 'veo');

    const prompt = this._appendDirectorNudge([
      verticalDirective,
      stylePrefix,
      `Establishing shot: ${location}.`,
      framingIntent,
      `Atmosphere: ${atmosphere}.`,
      `Camera: ${cameraMove}.`,
      identityDirective,
      wardrobeDirective,
      continuityDirective,
      subjectDirective,
      brandColorDirective,
      antiRefDirective,
      'No visible characters speaking — pure environment (unless persona explicitly flagged above).',
      `Ambient audio: ${ambientSound}.`,
      colorHint
    ].filter(Boolean).join(' '), beat);

    this.logger.info(`[${beat.beat_id}] Veo B_ROLL (${duration}s${firstFrameUrl ? ', anchored' : ', text-only'})`);

    // Plumb persona names + subject context so VeoService's three-tier
    // content-filter retry can sanitise name+body-part phrasing if Vertex
    // refuses the original prompt. See VeoPromptSanitizer.
    const personaNames = (personas || [])
      .map(p => p && p.name)
      .filter(n => typeof n === 'string' && n.length > 0);

    // Tier 2.5 callback: if Vertex rejects the persona/product first frame with
    // an IMAGE violation, VeoService will call this once to get a safer frame
    // before falling all the way to text-only. Not provided when firstFrameUrl
    // is scene master or previous endframe (those rarely trip image safety filters).
    const regenKind = personaLockUrl ? 'persona' : (subjectNaturalUrl ? 'product' : null);
    const safeRegenCallback = (regenKind && episodeContext?.uploadBuffer)
      ? () => regenerateSafeFirstFrame({
          kind: regenKind,
          personas: personas || [],
          subjectReferenceImages: episodeContext?.subjectReferenceImages || [],
          beat,
          uploadBuffer: episodeContext.uploadBuffer
        })
      : null;

    let result;
    try {
      result = await veo.generateWithFrames({
        firstFrameUrl, // null is OK — VeoFalService goes text-only when absent
        lastFrameUrl: null,
        prompt,
        options: {
          duration,
          aspectRatio: '9:16',
          generateAudio: true, // the whole point of using Veo for B-roll
          tier: 'standard',
          personaNames,
          sanitizationContext: {
            subjectName: location, // tier-2 fallback describes the location
            subjectDescription: atmosphere,
            stylePrefix
          },
          regenerateSafeFirstFrame: safeRegenCallback,
          // 2026-05-06 — Veo→Kling fallback (Step 5). Stage 1.5 SFX overlay
          // already runs for kling-v3-pro modelUsed strings, so the post-prod
          // pipeline replaces Veo's native ambient with EL SFX automatically
          // when this fallback fires.
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
        ? `Veo content filter persistent on B_ROLL (${(err.message || '').slice(0, 80)})`
        : `Veo error on B_ROLL (${(err.message || '').slice(0, 80)})`;
      this.logger.warn(
        `[${beat.beat_id}] ${fallbackReason} — falling back to Kling V3 Pro`
      );

      const klingBrollPrompt = this._appendDirectorNudge([
        verticalDirective,
        stylePrefix,
        `Establishing shot: ${location}.`,
        framingIntent,
        `Atmosphere: ${atmosphere}.`,
        `Camera: ${cameraMove}.`,
        identityDirective,
        wardrobeDirective,
        'No characters speaking — pure environment shot.',
        `Ambient: ${ambientSound}.`
      ].filter(Boolean).join(' '), beat);

      const hasPersonasInBeat = Array.isArray(beat.personas_present) && beat.personas_present.length > 0;

      return await this._fallbackToKlingForVeoFailure({
        beat, scene, refStack, personas, episodeContext, previousBeat,
        routingMetadata: undefined,
        prompt: klingBrollPrompt,
        duration,
        beatTypeLabel: 'broll',
        includeSubject: !!beat.subject_focus,
        includePersonaElements: hasPersonasInBeat,
        fallbackReason,
        veoSanitizationTier: null,
        generateAudio: true,
        extraMetadata: {
          location,
          hasAnchor: !!firstFrameUrl,
          personaLocked: !!personaLockUrl,
          subjectNaturalFrame: !!subjectNaturalUrl
        }
      });
    }

    // Use the ACTUAL duration returned by Veo (may be snapped up to {4,6,8}
    // because Vertex only accepts those bins).
    const actualDuration = result.duration || duration;

    return {
      videoBuffer: result.videoBuffer,
      durationSec: actualDuration,
      modelUsed: `veo-3.1-standard/broll (tier ${result.fallbackTier})`,
      costUsd: COST_VEO_STANDARD_PER_SEC * actualDuration,
      metadata: {
        veoVideoUrl: result.videoUrl,
        fallbackTier: result.fallbackTier,
        location,
        hasAnchor: !!firstFrameUrl,
        personaLocked: !!personaLockUrl,
        subjectNaturalFrame: !!subjectNaturalUrl,
        requestedDurationSec: duration,
        snappedDurationSec: actualDuration
      }
    };
  }
}

export default BRollGenerator;
export { BRollGenerator };
