// services/beat-generators/BaseBeatGenerator.js
// Abstract base class for all V4 beat generators.
//
// Every beat generator produces ONE piece of media (typically video) from ONE
// beat object in the scene-graph. The base class standardizes:
//   - constructor dependency-injection of fal.ai services, TTS, logger
//   - the generate() interface (async, returns a consistent output shape)
//   - status marking on the beat object (in-place mutation)
//   - error handling that preserves the beat on failure without killing the episode
//
// Subclasses implement `_doGenerate()` with their per-beat logic. The base
// class wraps that in status updates, logging, and error wrapping.
//
// Output shape returned by every beat generator:
//   {
//     videoBuffer: Buffer,       // the generated clip (mp4)
//     durationSec: number,       // actual duration of the clip
//     modelUsed: string,         // which fal.ai model produced it
//     costUsd: number,           // estimated cost for cost-tracking
//     metadata: object           // generator-specific extras (e.g. fallbackTier, syncPass)
//   }

import winston from 'winston';

class BaseBeatGenerator {
  /**
   * @param {Object} deps - dependency injection object
   * @param {Object} deps.falServices - { kling, veo, syncLipsync, seedream, flux, omniHuman }
   * @param {Object} deps.tts - TTSService singleton
   * @param {Object} [deps.ffmpeg] - optional ffmpeg helper bag
   */
  constructor(deps = {}) {
    this.deps = deps;
    this.falServices = deps.falServices || {};
    this.tts = deps.tts;
    this.ffmpeg = deps.ffmpeg;

    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => {
          return `[${this.constructor.name}] ${timestamp} [${level}]: ${message}`;
        })
      ),
      transports: [new winston.transports.Console()]
    });
  }

  /**
   * The canonical beat-type string(s) this generator handles. Subclasses
   * override. Used by the beat-generators index factory to build the map.
   *
   * @returns {string[]}
   */
  static beatTypes() {
    return [];
  }

  /**
   * Estimate the cost of a beat BEFORE generation. Used by BeatRouter's
   * cost-cap enforcement to bail early on runaway episodes. Subclasses
   * override with their model-specific math.
   *
   * @param {Object} beat - the beat object from scene_description
   * @returns {number} estimated cost in USD
   */
  static estimateCost(beat) {
    // Safe default: ~$0.50/beat. Subclasses should override with per-model math.
    return 0.50;
  }

  /**
   * Generate a single beat. Public entrypoint.
   *
   * Mutates the beat object in-place with status, model_used, cost_usd,
   * generated_video_url (set by orchestrator after Supabase upload), and
   * endframe_url (set by orchestrator after ffmpeg extract).
   *
   * @param {Object} args
   * @param {Object} args.beat - the beat object from scene_description.scenes[].beats[]
   * @param {Object} args.scene - parent scene (for scene_master_url, visual_style_prefix)
   * @param {Object[]} args.refStack - ordered reference image URLs for the generator
   * @param {Object[]} args.personas - persona_config.personas[] (for voice_id, ref images)
   * @param {Object} args.episodeContext - { visual_style_prefix, lut_id, episode.id, userId, etc. }
   * @param {Object} [args.previousBeat] - prior beat (for endframe_url chaining)
   * @returns {Promise<{videoBuffer: Buffer, durationSec: number, modelUsed: string, costUsd: number, metadata: Object}>}
   */
  async generate(args) {
    const { beat, scene, refStack, personas, episodeContext, previousBeat, routingMetadata } = args;

    if (!beat) throw new Error(`${this.constructor.name}: beat is required`);
    if (!beat.beat_id) throw new Error(`${this.constructor.name}: beat.beat_id is required`);

    this.logger.info(`▶ beat ${beat.beat_id} [${beat.type}] in scene ${scene?.scene_id || '?'}`);

    // Mark beat as in-progress BEFORE the generation so status reflects
    // the active stage even if the caller inspects mid-flight.
    beat.status = 'generating';
    beat.error_message = null;

    const startTime = Date.now();

    try {
      // IMPORTANT: routingMetadata MUST be forwarded to _doGenerate() —
      // ActionGenerator (and any future override-aware generator) reads
      // `routingMetadata.mode === 'text_override'` to toggle its text-
      // rendering prompt hint. Dropping this at the base-class boundary
      // silently broke the requires_text_rendering override on every beat
      // that Gemini flagged. Caught on 2026-04-11 when INSERT_SHOT beats
      // routed to ActionGenerator (via text override) lost their override
      // intent and came out as generic action beats.
      const result = await this._doGenerate({
        beat, scene, refStack, personas, episodeContext, previousBeat, routingMetadata
      });

      // Validate the subclass returned the expected shape.
      if (!result || !result.videoBuffer || typeof result.durationSec !== 'number') {
        throw new Error(`${this.constructor.name}: _doGenerate() must return { videoBuffer, durationSec, modelUsed, costUsd, metadata }`);
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const sizeMB = (result.videoBuffer.length / 1024 / 1024).toFixed(1);
      this.logger.info(
        `✓ beat ${beat.beat_id} ready in ${elapsed}s — ${result.modelUsed}, ${result.durationSec.toFixed(1)}s, ${sizeMB}MB, $${(result.costUsd || 0).toFixed(3)}`
      );

      // Mutate beat with result metadata (orchestrator sets URLs after upload).
      beat.model_used = result.modelUsed;
      beat.cost_usd = result.costUsd || 0;
      beat.actual_duration_sec = result.durationSec;
      beat.status = 'generated';

      return result;
    } catch (err) {
      beat.status = 'failed';
      beat.error_message = err.message || String(err);
      this.logger.error(`✗ beat ${beat.beat_id} failed: ${beat.error_message}`);
      throw err;
    }
  }

  /**
   * Subclass-implemented generation logic. Must return the output shape
   * documented on generate().
   */
  async _doGenerate(args) {
    throw new Error(`${this.constructor.name}: _doGenerate() must be implemented by subclass`);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Shared helpers (used by multiple subclasses)
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Select the primary persona for a beat. Handles both single-index and
   * multi-index shapes emitted by Gemini.
   *
   * @param {Object} beat
   * @param {Object[]} personas
   * @returns {Object|null}
   */
  _resolvePersona(beat, personas) {
    if (typeof beat.persona_index === 'number' && personas[beat.persona_index]) {
      return personas[beat.persona_index];
    }
    if (Array.isArray(beat.persona_indexes) && beat.persona_indexes.length > 0) {
      return personas[beat.persona_indexes[0]] || null;
    }
    return null;
  }

  /**
   * Build the full prompt that goes to the video model, layering:
   *   [visual_style_prefix] + [scene location/atmosphere] + [beat-specific action/emotion]
   *
   * Subclasses can override or extend this — it's the default that most
   * generators use.
   *
   * @param {Object} beat
   * @param {Object} scene
   * @param {Object} episodeContext
   * @returns {string}
   */
  _buildLayeredPrompt(beat, scene, episodeContext) {
    const parts = [];

    if (episodeContext?.visual_style_prefix) {
      parts.push(episodeContext.visual_style_prefix);
    }
    if (scene?.location) {
      parts.push(`Scene: ${scene.location}`);
    }

    // Beat-specific payload — subclasses should pass the right fields.
    // Default: concatenate any visible prompt-like fields.
    const beatPromptFields = [
      beat.action_prompt,
      beat.action_notes,
      beat.visual_direction,
      beat.expression_notes && `Expression: ${beat.expression_notes}`,
      beat.camera_notes && `Camera: ${beat.camera_notes}`,
      beat.lens && `Lens: ${beat.lens}`,
      beat.ambient_sound && `Ambient: ${beat.ambient_sound}`
    ].filter(Boolean);

    parts.push(...beatPromptFields);

    return parts.join('. ').replace(/\.\./g, '.');
  }

  /**
   * Pick the start frame for a beat from the reference stack. Order of
   * preference: previous beat's endframe → scene master → first persona
   * character sheet → nothing.
   *
   * @param {Object[]} refStack - array of URLs, already ordered by the ref-stack builder
   * @param {Object} [previousBeat]
   * @param {Object} [scene]
   * @returns {string|null}
   */
  _pickStartFrame(refStack, previousBeat, scene) {
    if (previousBeat?.endframe_url) return previousBeat.endframe_url;
    if (scene?.scene_master_url) return scene.scene_master_url;
    if (refStack && refStack.length > 0) return refStack[0];
    return null;
  }
}

export default BaseBeatGenerator;
export { BaseBeatGenerator };
