// services/beat-generators/InsertShotGenerator.js
// V4 INSERT_SHOT beat generator — ⭐ THE MONEY BEAT for brand stories.
//
// Tight closeup of a product, object, or detail. No character visible (or
// only a hand/gesture). 2-4 seconds, pristine composition. For brand stories,
// this is where the product gets its hero moment.
//
// Routes to Veo 3.1 Standard with first/last frame anchoring — Veo's native
// audio generation adds the foley (glass clink, fabric rustle, click) that
// makes an insert shot feel cinematic rather than slideshow.
//
// The start frame comes from the subject's reference image (brand kit asset
// or uploaded product photo). If a lighting_intent or camera_move is specified,
// those drive the prompt directly.

import BaseBeatGenerator from './BaseBeatGenerator.js';
import { regenerateSafeFirstFrame } from '../v4/StoryboardHelpers.js';

const COST_VEO_STANDARD_PER_SEC = 0.40;

class InsertShotGenerator extends BaseBeatGenerator {
  static beatTypes() {
    return ['INSERT_SHOT'];
  }

  static estimateCost(beat) {
    const duration = beat.duration_seconds || 3;
    return COST_VEO_STANDARD_PER_SEC * duration;
  }

  async _doGenerate({ beat, scene, refStack, personas, episodeContext, previousBeat }) {
    const { veo } = this.falServices;
    if (!veo) throw new Error('InsertShotGenerator: veo service not in deps');

    const duration = Math.max(2, Math.min(4, beat.duration_seconds || 3));

    // V4 Phase 9 — Scene-Integrated Product Lock (SIPL). Composites the
    // subject into the scene master's environment via Seedream so Veo
    // animates FROM an already-integrated frame (product on concrete table
    // in the safehouse, not floating on studio white). Director's keystone
    // fix for the "infomercial grammar" break.
    const siplUrl = await this._buildSceneIntegratedProductFrame({
      beat, scene, episodeContext
    });

    // Phase 2 — persona-lock fires when Gemini flags a persona in the insert
    // beat (e.g. "hand picking up the laptop"). For pure product inserts,
    // the SIPL / subject reference wins.
    const personaLockUrl = await this._buildPersonaLockedFirstFrame({
      beat, scene, previousBeat, personas, episodeContext
    });

    // Start frame precedence for INSERT_SHOT:
    //   1. Scene-Integrated Product Lock (SIPL) — product inside the scene world (BEST)
    //   2. Subject reference image (when no scene master exists to integrate into)
    //   3. Persona-locked first frame — when the beat features a persona
    //   4. Previous endframe — transition continuity
    //   5. Scene master — scene-level look fallback
    //
    // Subject ref no longer becomes a direct first_frame when SIPL is
    // available — that's the Director's "studio limbo teleport" fix.
    const subjectRefs = episodeContext?.subjectReferenceImages || [];
    const firstFrameUrl = siplUrl
      || subjectRefs[0]
      || personaLockUrl
      || previousBeat?.endframe_url
      || scene?.scene_master_url;

    if (!firstFrameUrl) {
      throw new Error(`beat ${beat.beat_id}: no start frame for INSERT_SHOT (need subject reference image)`);
    }

    // Phase 2.3 — last_frame_hint anchors the push-in endpoint so Veo doesn't
    // overshoot a 2-4s macro beat. When Gemini emits beat.last_frame_hint_url
    // (a rendered storyboard panel showing the intended final composition),
    // Veo's first-last-frame mode produces predictable, cinematic endings.
    // Screenplay / Director Panel can set this; it falls through to null.
    const lastFrameUrl = beat.last_frame_hint_url || null;

    const stylePrefix = episodeContext?.visual_style_prefix || '';
    const subjectFocus = beat.subject_focus || 'the product';
    const lightingIntent = beat.lighting_intent || 'soft directional key light';
    // Default camera intent for a 2-4s INSERT is a HELD macro with subtle
    // rack focus — not a push-in. The legacy 'slow push-in' default overshot
    // the frame on short beats, cutting the subject in half mid-clip. Held
    // + rack focus produces a cinematic product-hero beat with a predictable
    // endpoint. Screenplay beats can still override with beat.camera_move.
    const cameraMove = beat.camera_move
      || 'held macro with subtle rack focus, minimal drift';
    const ambientSound = beat.ambient_sound || 'soft room tone, subtle foley';

    // Phase 3.2 — framing vocabulary (defaults to macro_insert recipe for
    // INSERT_SHOT when Gemini omits the field).
    const framingRecipe = this._resolveFramingRecipe(beat)
      || 'Lens 100mm+ macro, macro shot. Camera: held with subtle rack focus, minimal drift.';

    // V4 Phase 9 — vertical framing + identity anchoring directives.
    // INSERT_SHOT specifically benefits from overhead/high-angle framing that
    // fills the vertical axis with the product + its environmental context.
    const verticalDirective = this._buildVerticalFramingDirective(beat, 'veo');

    const prompt = this._appendDirectorNudge([
      verticalDirective,
      stylePrefix,
      `Tight closeup on ${subjectFocus}.`,
      framingRecipe,
      `Lighting: ${lightingIntent}.`,
      `Camera: ${cameraMove}.`,
      'Extreme detail, product hero shot, cinematic macro feel, shallow depth of field.',
      `Ambient: ${ambientSound}.`
    ].filter(Boolean).join(' '), beat);

    this.logger.info(`[${beat.beat_id}] Veo INSERT_SHOT (${duration}s, ${subjectFocus})`);

    // Pass persona names + a tier-2 fallback context to VeoService so its
    // three-tier content-filter retry can sanitise name+body-part phrasing
    // ("on Leo's wrist") that Vertex rejects pre-submission. The tier-2
    // fallback — product-hero boilerplate — uses the subject's real name
    // (NOT persona name) so the brand beat survives even at worst case.
    const personaNames = (personas || [])
      .map(p => p && p.name)
      .filter(n => typeof n === 'string' && n.length > 0);
    const subjectNameForFallback = episodeContext?.subject?.name
      || beat.subject_focus
      || 'the product';
    const subjectDescriptionForFallback = episodeContext?.subject?.description
      || episodeContext?.subject?.visual_description
      || '';

    // Tier 2.5 callback: regenerate first frame in safe-mode when Vertex
    // rejects the SIPL/persona-lock with an IMAGE violation. Prefer 'product'
    // kind for INSERT_SHOT (it's a product hero beat); fall back to 'persona'
    // if the lock source was persona-only (no SIPL / subject refs).
    const regenKind = (siplUrl || subjectRefs[0]) ? 'product' : (personaLockUrl ? 'persona' : null);
    const safeRegenCallback = (regenKind && episodeContext?.uploadBuffer)
      ? () => regenerateSafeFirstFrame({
          kind: regenKind,
          personas: personas || [],
          subjectReferenceImages: subjectRefs,
          beat,
          uploadBuffer: episodeContext.uploadBuffer
        })
      : null;

    const result = await veo.generateWithFrames({
      firstFrameUrl,
      lastFrameUrl,
      prompt,
      options: {
        duration,
        aspectRatio: '9:16',
        generateAudio: true,
        tier: 'standard',
        personaNames,
        sanitizationContext: {
          subjectName: subjectNameForFallback,
          subjectDescription: subjectDescriptionForFallback,
          stylePrefix
        },
        regenerateSafeFirstFrame: safeRegenCallback
      }
    });

    // Use the ACTUAL duration returned by Veo (may be snapped up to {4,6,8}
    // because Vertex only accepts those bins for image_to_video).
    const actualDuration = result.duration || duration;

    return {
      videoBuffer: result.videoBuffer,
      durationSec: actualDuration,
      modelUsed: `veo-3.1-standard/insert (tier ${result.fallbackTier})`,
      costUsd: COST_VEO_STANDARD_PER_SEC * actualDuration,
      metadata: {
        veoVideoUrl: result.videoUrl,
        fallbackTier: result.fallbackTier,
        subjectFocus,
        firstFrameUrl,
        lastFrameUrl,
        personaLocked: !!personaLockUrl,
        sceneIntegratedProductLock: !!siplUrl,
        requestedDurationSec: duration,
        snappedDurationSec: actualDuration
      }
    };
  }
}

export default InsertShotGenerator;
export { InsertShotGenerator };
