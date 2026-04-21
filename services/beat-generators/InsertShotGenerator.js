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

    // Start frame for an insert shot: the subject's reference image is the best anchor.
    // Fall back to scene master or previous endframe if the subject has no refs.
    const subjectRefs = episodeContext?.subjectReferenceImages || [];
    const firstFrameUrl = subjectRefs[0]
      || previousBeat?.endframe_url
      || scene?.scene_master_url;

    if (!firstFrameUrl) {
      throw new Error(`beat ${beat.beat_id}: no start frame for INSERT_SHOT (need subject reference image)`);
    }

    const stylePrefix = episodeContext?.visual_style_prefix || '';
    const subjectFocus = beat.subject_focus || 'the product';
    const lightingIntent = beat.lighting_intent || 'soft directional key light';
    const cameraMove = beat.camera_move || 'slow push-in';
    const ambientSound = beat.ambient_sound || 'soft room tone, subtle foley';

    const prompt = [
      stylePrefix,
      `Tight closeup on ${subjectFocus}.`,
      `Lighting: ${lightingIntent}.`,
      `Camera: ${cameraMove}.`,
      'Extreme detail, product hero shot, cinematic macro feel, shallow depth of field.',
      `Ambient: ${ambientSound}.`
    ].filter(Boolean).join(' ');

    this.logger.info(`[${beat.beat_id}] Veo INSERT_SHOT (${duration}s, ${subjectFocus})`);

    const result = await veo.generateWithFrames({
      firstFrameUrl,
      lastFrameUrl: null,
      prompt,
      options: {
        duration,
        aspectRatio: '9:16',
        generateAudio: true,
        tier: 'standard'
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
        requestedDurationSec: duration,
        snappedDurationSec: actualDuration
      }
    };
  }
}

export default InsertShotGenerator;
export { InsertShotGenerator };
