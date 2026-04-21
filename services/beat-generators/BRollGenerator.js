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

    // B-roll anchor: scene master is ideal (matches scene look), fall back to
    // previous endframe for transition continuity, then text-only.
    const firstFrameUrl = scene?.scene_master_url
      || previousBeat?.endframe_url
      || null;

    const stylePrefix = episodeContext?.visual_style_prefix || '';
    const location = beat.location || scene?.location || 'establishing shot';
    const atmosphere = beat.atmosphere || 'cinematic, evocative';
    const cameraMove = beat.camera_move || 'slow dolly forward';
    const ambientSound = beat.ambient_sound || 'natural ambient sound, evocative and immersive';

    const prompt = [
      stylePrefix,
      `Establishing shot: ${location}.`,
      `Atmosphere: ${atmosphere}.`,
      `Camera: ${cameraMove}.`,
      'No visible characters in frame — pure environment.',
      `Ambient audio: ${ambientSound}.`
    ].filter(Boolean).join(' ');

    this.logger.info(`[${beat.beat_id}] Veo B_ROLL (${duration}s${firstFrameUrl ? ', anchored' : ', text-only'})`);

    const result = await veo.generateWithFrames({
      firstFrameUrl, // null is OK — VeoFalService goes text-only when absent
      lastFrameUrl: null,
      prompt,
      options: {
        duration,
        aspectRatio: '9:16',
        generateAudio: true, // the whole point of using Veo for B-roll
        tier: 'standard'
      }
    });

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
        requestedDurationSec: duration,
        snappedDurationSec: actualDuration
      }
    };
  }
}

export default BRollGenerator;
export { BRollGenerator };
