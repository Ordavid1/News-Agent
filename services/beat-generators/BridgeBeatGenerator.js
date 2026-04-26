// services/beat-generators/BridgeBeatGenerator.js
// V4 Phase 6.1 — Narrative bridge beats.
//
// When Gemini's scene graph includes an optional `scene.bridge_to_next`, this
// generator renders the connective-tissue shot between two scenes in different
// locations. The bridge's first frame is the prior scene's endframe and its
// last-frame hint is the next scene's master — so Veo produces a transit shot
// that visually explains HOW the story moved from scene A to scene B.
//
// Without a bridge, scene transitions are a raw 0.5s xfade with no narrative
// connective tissue. The user sees Scene A (office) dissolve into Scene B
// (terrace) with zero idea how the character arrived there. A bridge shot
// fills that gap: "agent exits office door, walks down hallway, steps out
// onto terrace" — a 2-3s Veo B-roll clip that the post-production timeline
// splices between the two scenes.
//
// Routes to Veo 3.1 Standard (free tier) via the same path as BRollGenerator,
// but feeds the NEXT scene's master as `last_frame_hint_url` so Veo's
// first-last-frame mode anchors both endpoints — producing a seamless transit.
//
// Bridges are OPTIONAL. When `scene.bridge_to_next` is absent, no bridge is
// generated and the assembly falls back to the standard 0.5s motion-blur
// xfade (Phase 6.3).

import BaseBeatGenerator from './BaseBeatGenerator.js';

const COST_VEO_STANDARD_PER_SEC = 0.40;

class BridgeBeatGenerator extends BaseBeatGenerator {
  static beatTypes() {
    // Bridges are registered to their own synthetic type so the router /
    // validator don't confuse them with regular B_ROLL beats.
    return ['SCENE_BRIDGE'];
  }

  static estimateCost(beat) {
    const duration = Math.max(2, Math.min(4, beat.duration_seconds || 2.5));
    return COST_VEO_STANDARD_PER_SEC * duration;
  }

  async _doGenerate({ beat, scene, refStack, personas, episodeContext, previousBeat }) {
    const { veo } = this.falServices;
    if (!veo) throw new Error('BridgeBeatGenerator: veo service not in deps');

    const duration = Math.max(2, Math.min(4, beat.duration_seconds || 2.5));

    // Bridges are typically persona-free (a hallway shot, a car exterior),
    // but when Gemini flags a persona-in-transit (agent walking between
    // locations), we run the persona-lock pre-pass so identity carries.
    const personaLockUrl = await this._buildPersonaLockedFirstFrame({
      beat, scene, previousBeat, personas, episodeContext
    });

    // Start frame precedence:
    //   1. persona-locked first frame (when persona appears in bridge)
    //   2. bridge_from_scene_endframe (the outgoing scene's last frame)
    //   3. previous endframe (beat-level fallback)
    //   4. current scene master
    const firstFrameUrl = personaLockUrl
      || beat.bridge_from_scene_endframe_url
      || previousBeat?.endframe_url
      || scene?.scene_master_url
      || null;

    // End frame: the NEXT scene's master is the bridge's destination anchor.
    // Veo's first-last-frame mode interpolates the transit between them,
    // which is exactly what a bridge shot needs to look cinematic.
    const lastFrameUrl = beat.bridge_to_scene_master_url || null;

    const stylePrefix = episodeContext?.visual_style_prefix || '';
    const framingRecipe = this._resolveFramingRecipe(beat)
      || 'Lens 24-35mm, wide shot. Camera: subject exits frame / enters new location.';
    const visualPrompt = beat.visual_prompt || beat.action_notes
      || 'Transit shot connecting the previous scene to the next location';
    const ambientSound = beat.ambient_sound || 'natural transit ambient sound';

    const prompt = this._appendDirectorNudge([
      stylePrefix,
      'Scene bridge — connective transit shot.',
      framingRecipe,
      visualPrompt,
      'Seamless movement, no dialogue.',
      `Ambient: ${ambientSound}.`
    ].filter(Boolean).join(' '), beat);

    this.logger.info(
      `[${beat.beat_id}] Veo SCENE_BRIDGE (${duration}s, ` +
      `anchors: ${firstFrameUrl ? 'first' : 'none'}${lastFrameUrl ? '+last' : ''})`
    );

    const personaNames = (personas || [])
      .map(p => p && p.name)
      .filter(n => typeof n === 'string' && n.length > 0);

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
          subjectName: 'transit shot',
          subjectDescription: visualPrompt,
          stylePrefix
        }
      }
    });

    const actualDuration = result.duration || duration;

    return {
      videoBuffer: result.videoBuffer,
      durationSec: actualDuration,
      modelUsed: `veo-3.1-standard/bridge (tier ${result.fallbackTier})`,
      costUsd: COST_VEO_STANDARD_PER_SEC * actualDuration,
      metadata: {
        veoVideoUrl: result.videoUrl,
        fallbackTier: result.fallbackTier,
        firstFrameUrl,
        lastFrameUrl,
        personaLocked: !!personaLockUrl,
        bridgeKind: 'narrative_transit',
        requestedDurationSec: duration,
        snappedDurationSec: actualDuration
      }
    };
  }
}

export default BridgeBeatGenerator;
export { BridgeBeatGenerator };
