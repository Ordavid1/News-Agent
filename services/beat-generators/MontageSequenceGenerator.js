// services/beat-generators/MontageSequenceGenerator.js
// V4 MONTAGE_SEQUENCE generator — scene-level, not beat-level.
//
// MONTAGE is a scene MODIFIER (scene.type === 'montage') rather than a beat
// type. When a scene is flagged as a montage, this generator is invoked to
// produce the ENTIRE scene as a single Kling V3 Pro Custom Multi-Shot call
// (4-6 chronological shots in ONE API call, with per-shot duration control).
//
// Why this matters: calling Kling 4-6 times sequentially for a montage is
// dramatically worse than letting Kling plan the inter-shot transitions
// natively in its multi-shot mode. The multi-shot mode is a Kling V3 Pro
// specialty.
//
// Input: a scene with type === 'montage' and beats[] where each beat
// represents a montage shot (not a dialogue beat). Typically 2-6 beats.
//
// Output: ONE video covering the whole montage scene, ready to insert into
// the episode timeline at scene boundaries.

import BaseBeatGenerator from './BaseBeatGenerator.js';
import { buildKlingElementsFromPersonas, buildKlingSubjectElement } from '../KlingFalService.js';

const COST_KLING_V3_PRO_PER_SEC = 0.224;

class MontageSequenceGenerator extends BaseBeatGenerator {
  static beatTypes() {
    // This isn't a beat type — it's a scene-level generator.
    // The BeatRouter handles MONTAGE_SEQUENCE as a scene modifier directly.
    return ['MONTAGE_SEQUENCE'];
  }

  static estimateCost(scene) {
    // Scene-level estimator. Input is the entire scene, not a single beat.
    if (!scene || !Array.isArray(scene.beats)) return 0;
    const totalDuration = scene.beats.reduce((sum, b) => sum + (b.duration_seconds || 3), 0);
    return COST_KLING_V3_PRO_PER_SEC * totalDuration;
  }

  /**
   * Generate the entire montage scene as ONE Kling V3 Pro multi-shot call.
   * Note: this is called by the orchestrator at the SCENE level, not the beat
   * level. Each beat inside the montage becomes one shot in the multi_prompt.
   */
  async generateScene({ scene, personas, episodeContext, previousScene }) {
    const { kling } = this.falServices;
    if (!kling) throw new Error('MontageSequenceGenerator: kling service not in deps');

    const beats = Array.isArray(scene.beats) ? scene.beats : [];
    if (beats.length < 2) {
      throw new Error(`montage scene ${scene.scene_id}: needs at least 2 beats for multi-shot mode`);
    }
    if (beats.length > 6) {
      this.logger.warn(`montage scene ${scene.scene_id} has ${beats.length} beats — Kling multi-shot max is 6, truncating`);
    }

    const stylePrefix = episodeContext?.visual_style_prefix || '';
    const sceneLocation = scene.location || '';

    // Build multi_prompt from beats.
    const shots = beats.slice(0, 6).map((beat, i) => {
      const beatPrompt = [
        stylePrefix,
        beat.action_prompt || beat.visual_direction || beat.atmosphere || `Montage shot ${i + 1}`,
        beat.camera_move || beat.camera_notes || '',
        beat.ambient_sound ? `Ambient: ${beat.ambient_sound}` : ''
      ].filter(Boolean).join('. ');

      // 2026-04-28: Kling V3 Pro Custom Multi-Shot accepts 1-15s per shot
      // (was capped at 6 here; that was a stricter local cap, not an API
      // limit). KlingFalService.generateMontageSequence still does its own
      // clamp + string-cast on each duration before send.
      return {
        prompt: beatPrompt,
        duration: Math.max(1, Math.min(15, Math.round(beat.duration_seconds || 3)))
      };
    });

    // Start frame: scene master gives the best montage anchor.
    const startFrameUrl = scene.scene_master_url
      || episodeContext?.previousBeatEndframe
      || null;

    // Collect unique personas across all beats in the montage so they get
    // identity-locked across the shot sequence.
    const personasInMontage = [];
    const seenPersonas = new Set();
    for (const beat of beats) {
      const idx = beat.persona_index ?? (beat.persona_indexes?.[0]);
      if (idx != null && !seenPersonas.has(idx) && personas[idx]) {
        seenPersonas.add(idx);
        personasInMontage.push(personas[idx]);
      }
    }
    const { elements } = buildKlingElementsFromPersonas(personasInMontage);

    // Non-invasive subject anchoring — montage runs at scene level. If ANY
    // beat in the montage marks subject_present and there's room in the
    // elements[] cap, append the brand subject as a pure visual ref.
    const sceneHasSubjectPresent = beats.some(b => b && b.subject_present === true);
    if (sceneHasSubjectPresent && elements.length < 3) {
      const subjectElement = buildKlingSubjectElement(episodeContext?.subjectReferenceImages);
      if (subjectElement) {
        elements.push(subjectElement);
        this.logger.info(`[scene ${scene.scene_id}] subject element added to Kling refs (${elements.length}/3)`);
      }
    }

    this.logger.info(
      `[scene ${scene.scene_id}] Kling V3 Pro Custom Multi-Shot — ${shots.length} shots, ${shots.reduce((s, x) => s + x.duration, 0)}s total, ${elements.length} element(s)`
    );

    const result = await kling.generateMontageSequence({
      shots,
      startFrameUrl,
      elements,
      options: {
        aspectRatio: '9:16',
        generateAudio: true
      }
    });

    // Mark every beat in the scene as satisfied by this one video.
    // The orchestrator will split the single video into per-beat slices
    // using scene.montage_slice_durations for downstream endframe extraction.
    for (const beat of beats) {
      beat.status = 'generated';
      beat.model_used = 'kling-v3-pro-multishot/montage';
      beat.cost_usd = (beat.duration_seconds || 3) * COST_KLING_V3_PRO_PER_SEC;
      beat.actual_duration_sec = beat.duration_seconds || 3;
    }

    return {
      videoBuffer: result.videoBuffer,
      durationSec: result.duration,
      modelUsed: 'kling-v3-pro-multishot/montage',
      costUsd: COST_KLING_V3_PRO_PER_SEC * result.duration,
      metadata: {
        klingVideoUrl: result.videoUrl,
        shotCount: shots.length,
        shotDurations: shots.map(s => s.duration),
        sceneLocation
      }
    };
  }

  // The per-beat generate() contract from BaseBeatGenerator is NOT used here.
  // Throw to make misuse obvious — the orchestrator must call generateScene().
  async _doGenerate() {
    throw new Error('MontageSequenceGenerator: use generateScene() at scene level, not generate() at beat level');
  }
}

export default MontageSequenceGenerator;
export { MontageSequenceGenerator };
