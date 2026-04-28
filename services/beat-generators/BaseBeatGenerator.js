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
   * @param {Object} deps.tts - TTSService singleton (single-speaker eleven-v3)
   * @param {Object} [deps.dialogueTTS] - DialogueTTSService singleton — V4 Audio
   *   Layer Overhaul Day 2. Multi-speaker eleven-v3 dialogue endpoint, used by
   *   GROUP_DIALOGUE_TWOSHOT generator for shared prosodic context. Optional —
   *   when missing, GROUP_DIALOGUE_TWOSHOT falls back to the legacy parallel-TTS
   *   + concat path (defense-in-depth for tests, smoke scripts, partial deps).
   * @param {Object} [deps.ffmpeg] - optional ffmpeg helper bag
   */
  constructor(deps = {}) {
    this.deps = deps;
    this.falServices = deps.falServices || {};
    this.tts = deps.tts;
    this.dialogueTTS = deps.dialogueTTS;
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

    // V4 Director Agent (L3) — director_nudge consumption. When the orchestrator
    // (Phase 3 blocking-mode auto-retry OR Director-Panel manual "Apply L3 nudge"
    // button) stamps a generator-actionable prompt_delta onto the beat, splice
    // it into the prompt as DIRECTOR'S NOTE. Generators that override
    // _buildLayeredPrompt should call _appendDirectorNudge() to keep this
    // behavior consistent across the family.
    return this._appendDirectorNudge(parts.join('. ').replace(/\.\./g, '.'), beat);
  }

  /**
   * Append a Director Agent prompt nudge to a built prompt string. Used by
   * `_buildLayeredPrompt` and by subclasses that build their own prompts.
   * Does nothing when `beat.director_nudge` is empty.
   *
   * @param {string} prompt - the existing prompt string
   * @param {Object} beat
   * @returns {string}
   */
  _appendDirectorNudge(prompt, beat) {
    const nudge = beat?.director_nudge;
    if (typeof nudge !== 'string' || nudge.trim().length === 0) return prompt;
    const trimmed = String(prompt || '').replace(/\s+$/, '');
    const sep = trimmed.length > 0 && !/[.!?]$/.test(trimmed) ? '. ' : ' ';
    return `${trimmed}${sep}DIRECTOR'S NOTE (retake): ${nudge.trim()}`;
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

  /**
   * V4 Phase 9 — Vertical Framing Directive (per Director's notes 2026-04-23).
   *
   * The aspect_ratio='9:16' parameter alone only sets the CONTAINER. Video
   * models were trained overwhelmingly on horizontal cinema language and
   * reach for Roger Deakins' 2.39:1 muscle memory on words like "wide",
   * "cinematic", or "establishing" — producing a wide composition *inside*
   * a 9:16 canvas (subject floating in a letterboxed mid-band).
   *
   * The fix is COMPOSITIONAL DIRECTIVE LANGUAGE added to every prompt — not
   * the parameter. Global boilerplate + per-beat-type overrides that bias
   * composition along the Y axis instead of the X axis. This is the single
   * biggest visual lift per line of code in the pipeline.
   *
   * @param {Object} beat
   * @param {'kling' | 'veo' | 'seedream'} [modelHint]
   * @returns {string}
   */
  _buildVerticalFramingDirective(beat, modelHint = 'generic') {
    const beatType = beat?.type || '';

    // Global directive — appended to every prompt regardless of beat type.
    // Negates the 2.39:1 instinct explicitly and tells the model to compose
    // along the vertical axis (foreground-midground-background stacked in Y,
    // not X). Social-media-native framing.
    const GLOBAL = [
      'VERTICAL 9:16 COMPOSITION.',
      'Full-height framing — subject occupies 70-90% of the vertical axis from frame bottom to frame top.',
      'Headroom tight.',
      'NO letterboxing, NO cinemascope bars, NO horizontal-wide composition placed inside vertical canvas.',
      'Camera held in portrait orientation.',
      'Vertical stacking of visual elements (foreground-midground-background along the Y axis, not the X axis).',
      'Social-media vertical video framing (TikTok / Instagram Reels native).'
    ].join(' ');

    // Per-beat-type override. A true wide in 9:16 is architecturally
    // impossible without sacrificing the subject, so wide/establishing beats
    // become LOW-ANGLE VERTICAL reveals that use the Y axis for scope.
    let perType = '';
    switch (beatType) {
      case 'B_ROLL_ESTABLISHING':
      case 'SCENE_BRIDGE':
        perType = 'Low-angle vertical establishing — camera looking UP along the architecture, subject in lower third, environment filling upper two-thirds. Use vertical scale (ceilings, rooflines, tall objects, columns) as the establishing element.';
        break;
      case 'INSERT_SHOT':
        perType = 'Overhead or high-angle looking DOWN at the object. Object centered and filling 60% of frame width, environmental surface context visible above and below. The object lives on a surface; show the surface, show the environment, do not crop into studio limbo.';
        break;
      case 'TALKING_HEAD_CLOSEUP':
      case 'REACTION':
      case 'SILENT_STARE':
        perType = 'Tight vertical portrait — head-and-shoulders, eyes on the upper-third line, chin at the lower-third, full vertical face. No wide-margin letterbox space on top or bottom.';
        break;
      case 'DIALOGUE_IN_SCENE':
        perType = 'Medium-close vertical portrait — head-to-waist or head-to-hip, subject fills vertical frame, environmental context read in the narrow left/right margins.';
        break;
      case 'GROUP_DIALOGUE_TWOSHOT':
        perType = 'Two-character vertical stacking — characters arranged so both faces read in 9:16 (one slightly forward / one slightly back, or one leaning in / one leaning back). NOT side-by-side wide two-shot.';
        break;
      case 'ACTION_NO_DIALOGUE':
        perType = 'Kinetic vertical action — camera moves along Y axis (tilt/crane), subject moves along vertical diagonals. Use vertical blocking so action reads in 9:16.';
        break;
      case 'VOICEOVER_OVER_BROLL':
        perType = 'Vertical atmospheric establishing — same rules as B_ROLL with V.O. in mind. Compose with room for mood, not breadth.';
        break;
    }

    // Model-specific negative phrasing. Veo trained heavily on cinema —
    // strongly reject 2.39. Kling handles vertical better natively but still
    // benefits from the explicit negation.
    let modelNegative = '';
    if (modelHint === 'veo') {
      modelNegative = ' Shot size is MEDIUM or MEDIUM-CLOSE (never "wide" or "extreme-wide" — those trigger horizontal cinema reflex).';
    } else if (modelHint === 'kling') {
      modelNegative = ' Framing is portrait-native, not cropped from a horizontal source.';
    } else if (modelHint === 'seedream') {
      modelNegative = ' Panel aspect is strict 9:16 with subject occupying the full vertical axis.';
    }

    return [GLOBAL, perType, modelNegative].filter(Boolean).join(' ').trim();
  }

  /**
   * V4 Phase 9 — Identity Anchoring Directive (per Director's notes).
   *
   * Preserves facial structural geometry (inter-ocular distance, nose bridge,
   * jaw line) across beats even when hair/makeup/wardrobe/lighting vary. The
   * underlying mechanism is a reference subset (Canonical Identity Portrait),
   * but the prompt language reinforces the lock at the model level.
   *
   * @returns {string}
   */
  _buildIdentityAnchoringDirective() {
    return [
      'Identity anchoring:',
      'preserve exact facial structure from reference images —',
      'inter-ocular distance, nose geometry, jawline, lip shape, ear placement, brow arch.',
      'These are invariant.',
      'Hair, makeup, wardrobe, and lighting may vary per scene, but facial bone structure must match references exactly.',
      'Same person, same face, same age.',
      'Do not stylistically reinterpret the face.',
      'Reference images 1-3 are the canonical identity anchor.'
    ].join(' ');
  }

  /**
   * Phase 3.2 — resolve `beat.framing` to a concrete "lens X, distance Y,
   * camera_move Z" recipe string the video models can condition on. The
   * vocabulary is single-sourced in brandStoryPromptsV4.mjs so the prompt
   * and the generator always stay in sync.
   *
   * Returns '' when no framing is emitted (generators fall back to their
   * legacy default camera_move strings).
   *
   * @param {Object} beat
   * @returns {string}
   */
  _resolveFramingRecipe(beat) {
    const framing = beat?.framing;
    if (!framing || typeof framing !== 'string') return '';
    // Lazy-require to avoid pulling the prompt module into the generator
    // module graph at require-time (CommonJS / ESM mixed loader care).
    try {
      // eslint-disable-next-line no-undef
      const vocab = globalThis.__V4_FRAMING_VOCAB_CACHE;
      if (vocab && vocab[framing]) {
        const spec = vocab[framing];
        return `Lens ${spec.lens_mm}mm, ${spec.distance} shot. Camera: ${spec.camera_move}. ${spec.intent}`;
      }
    } catch {}
    // Minimal inlined fallback — matches the vocab semantics but avoids the
    // cross-module import. Kept narrow so it doesn't drift from the prompt.
    // Expanded Phase 3 (2026-04-27) to mirror the 20-entry vocabulary.
    const INLINE = {
      wide_establishing:               'Lens 24-35mm, wide shot. Camera: slow dolly back / crane reveal. Establish environment + subject within context.',
      medium_two_shot:                 'Lens 35-50mm, medium shot. Camera: locked-off or gentle drift. Two characters in frame at conversational distance.',
      over_shoulder:                   'Lens 50-85mm, medium-close. Camera: subtle arc over shoulder. Protagonist foreground soft, listener midground sharp.',
      dirty_over_shoulder:             'Lens 50-75mm, medium. Camera: subtle drift, foreground out of focus. OTS with foreground shoulder LARGE (≥30%), spatial dominance.',
      tight_closeup:                   'Lens 75-100mm, close shot. Camera: locked-off, shallow DOF breathing. Head-and-shoulders, eyes and mouth as the story.',
      portrait_75mm:                   'Lens 75-85mm, medium-close. Camera: locked-off, breath-only DOF. Face-as-canvas, painterly skin separation.',
      anamorphic_signature_closeup:    'Lens 40-50mm anamorphic (1.85x squeeze), close. Camera: locked-off, oval bokeh, blue horizontal flares. Anamorphic optical signature in 9:16 vertical.',
      anamorphic_wide_world:           'Lens 24-35mm anamorphic, wide. Camera: slow crane / dolly with horizontal flare. Mythic world reveal with edge distortion.',
      macro_insert:                    'Lens 60-180mm macro, macro shot. Camera: held with subtle rack focus, minimal drift. Tactile detail.',
      cinema_macro_product:            'Lens 90-180mm macro, macro. Camera: rack focus across product surface. Cinema macro on product as object-of-interest, not advertisement. Hands present.',
      cinema_macro_emotion:            'Lens 60-100mm macro, macro. Camera: rack focus eye → tear → eye, locked. Human detail (eye, hand tremor, tear); subtext made physical.',
      tilt_shift_miniature:            'Lens 24-45mm tilt-shift, wide-medium. Camera: locked-off, wedge-of-focus diagonally across frame. Surreal "miniature" / psychological compression.',
      fisheye_subjective:              'Lens 8-14mm fisheye, close-wide. Camera: handheld, rotational. Subjective POV — intoxication, panic, dream. Horizon curves.',
      fixed_telephoto_isolation:       'Lens 200-400mm, medium-tight via distance. Camera: locked-off long, compressed background. Long-lens isolation; background = blur-painting.',
      vintage_zoom_creep:              'Lens 50-150mm vintage zoom, medium → close. Camera: slow optical zoom-in (NOT dolly) over 4-6 seconds. 70s/80s zoom creep.',
      speed_ramp_action:               'Lens 24-50mm, medium. Camera: whip pan with speed ramp (60fps → 24fps mid-action). Real-time → slow-mo → real-time energy spike.',
      product_in_environment:          'Lens 35-50mm, medium. Camera: subtle drift, product mid-ground, character interacting. Product present but NOT framed subject — naturalistic placement.',
      product_tactile_handheld:        'Lens 50-85mm, medium-close. Camera: handheld OTS onto hands using product. Brand mark off-axis or in motion blur.',
      tracking_push:                   'Lens 35-50mm, medium shot. Camera: slow push-in following subject motion.',
      bridge_transit:                  'Lens 24-35mm, wide shot. Camera: subject exits frame / enters new location. Connective transit between scenes.'
    };
    return INLINE[framing] || '';
  }

  /**
   * Resolve the ordered list of personas that appear in this beat.
   * Handles beat.persona_index (single), beat.persona_indexes[] (multi),
   * and falls back to beat.personas_present[] (index array) or beat.voiceover_persona_index.
   *
   * @param {Object} beat
   * @param {Object[]} personas
   * @returns {Object[]} personas in the order they appear in the beat (dedup'd)
   */
  _resolvePersonasInBeat(beat, personas) {
    if (!Array.isArray(personas) || personas.length === 0) return [];
    const indexes = [];
    if (typeof beat?.persona_index === 'number') indexes.push(beat.persona_index);
    if (Array.isArray(beat?.persona_indexes)) indexes.push(...beat.persona_indexes);
    if (Array.isArray(beat?.personas_present)) {
      for (const p of beat.personas_present) {
        if (typeof p === 'number') indexes.push(p);
      }
    }
    if (typeof beat?.voiceover_persona_index === 'number') indexes.push(beat.voiceover_persona_index);

    const seen = new Set();
    const resolved = [];
    for (const idx of indexes) {
      if (seen.has(idx)) continue;
      seen.add(idx);
      if (personas[idx]) resolved.push(personas[idx]);
    }
    return resolved;
  }

  /**
   * V4 Phase 9 keystone — Scene-Integrated Product Lock (SIPL).
   *
   * Composites the user's subject (product/brand asset) into the scene master
   * environment via Seedream, producing a first_frame that shows the subject
   * sitting inside the actual scene world rather than a studio limbo.
   *
   * Two intents:
   *   'hero'    → INSERT_SHOT: product centered at 60% frame width (classic SIPL)
   *   'ambient' → B_ROLL/VO_BROLL: subject visible as supporting element (20-35%)
   *
   * Opt-out: V4_SIPL_STAGE=false disables the pre-pass entirely.
   * Idempotent: caches under different beat keys per intent.
   *
   * @param {Object} args
   * @param {Object} args.beat
   * @param {Object} args.scene
   * @param {Object} args.episodeContext
   * @param {'hero'|'ambient'|'natural'} [args.intent='hero']
   * @returns {Promise<string|null>}
   */
  async _buildSceneIntegratedProductFrame({ beat, scene, episodeContext, intent = 'hero' }) {
    if (process.env.V4_SIPL_STAGE === 'false') return null;

    // 2026-04-25 — ambient SIPL disabled by default. The pre-pass was forcing
    // the subject into B_ROLL / VO_BROLL frames where the screenplay didn't
    // want it as the focal point, derailing scene focus and pulling the
    // viewer's attention away from the actual narrative beat. INSERT_SHOT
    // ('hero' intent) is unaffected — it WANTS the product as the focal
    // point. To re-enable ambient SIPL: V4_SIPL_AMBIENT=true.
    if (intent === 'ambient' && process.env.V4_SIPL_AMBIENT !== 'true') return null;

    // 'natural' intent has NO env gate — the screenplay-level subject_focus
    // check at the call site is the only gate. This is the non-invasive Veo
    // anchoring path: terse Seedream prompt, no compositional emphasis,
    // designed not to trip Vertex's image classifier on noir/surveillance
    // scenes.

    // Idempotent resume — each intent gets its own cache key on the beat object.
    const cacheKey = intent === 'ambient'
      ? 'scene_integrated_subject_ambient_url'
      : (intent === 'natural'
        ? 'scene_integrated_subject_natural_url'
        : 'scene_integrated_product_frame_url');
    if (beat[cacheKey]) return beat[cacheKey];

    const subjectRefs = episodeContext?.subjectReferenceImages || [];
    if (!Array.isArray(subjectRefs) || subjectRefs.length === 0) return null;

    // SIPL only fires when there's a scene master to integrate INTO.
    if (!scene?.scene_master_url) return null;

    if (!episodeContext?.uploadBuffer) {
      this.logger.warn(`[${beat.beat_id}] SIPL (${intent}) skipped — episodeContext.uploadBuffer missing`);
      return null;
    }

    try {
      const { buildSceneIntegratedProductFrame } = await import('../v4/StoryboardHelpers.js');
      const result = await buildSceneIntegratedProductFrame({
        subjectReferenceImages: subjectRefs,
        scene,
        beat,
        visualStylePrefix: episodeContext.visual_style_prefix || '',
        uploadBuffer: episodeContext.uploadBuffer,
        intent
      });
      if (!result) return null;
      beat[cacheKey] = result.first_frame_url;
      const label = intent === 'ambient'
        ? 'subject ambient frame'
        : (intent === 'natural' ? 'subject natural frame' : 'product-lock first frame');
      this.logger.info(`[${beat.beat_id}] scene-integrated ${label} ready`);
      return result.first_frame_url;
    } catch (err) {
      this.logger.warn(`[${beat.beat_id}] SIPL (${intent}) synthesis failed — ${err.message}`);
      beat[`sipl_${intent}_error`] = err.message || String(err);
      return null;
    }
  }

  /**
   * Build a short prompt directive that preserves subject appearance across beats.
   *
   * DISABLED 2026-04-24 — the textual directive was over-steering Veo/Kling,
   * forcing the subject into every frame even when the screenplay beat didn't
   * intend it to be hero. This derailed scene coherence on test episodes.
   *
   * The first-frame anchoring (ambient SIPL pre-pass + persona-lock subject
   * mention in the Seedream first frame) still carries the subject visually
   * where appropriate — that's the lock that actually matters. The prompt
   * directive was belt-and-suspenders that ended up fighting the prompt.
   *
   * To re-enable: toggle the env flag V4_SUBJECT_PRESENCE_DIRECTIVE=true.
   * Current default: disabled.
   *
   * @param {Object} beat
   * @param {Object} episodeContext
   * @returns {string}
   */
  _buildSubjectPresenceDirective(beat, episodeContext) {
    if (process.env.V4_SUBJECT_PRESENCE_DIRECTIVE !== 'true') return '';
    if (!beat?.subject_present) return '';
    const subjectRefs = episodeContext?.subjectReferenceImages || [];
    if (subjectRefs.length === 0) return '';
    const name = beat.subject_focus || 'the subject';
    const desc = beat.subject_description || '';
    return `${name} is present in this scene — maintain its exact appearance${desc ? `: ${desc}` : ''}.`;
  }

  /**
   * Phase 2 keystone — acquire a persona-locked first frame for a Veo beat
   * when the beat features one or more personas.
   *
   * Veo's API rejects reference images, so persona identity would drift on
   * REACTION / B_ROLL (with-persona) / VOICEOVER_OVER_BROLL beats. We
   * synthesize a 9:16 still via Seedream that shows the persona(s) inside
   * the scene master's look at the beat's emotional/blocking state, and
   * feed that still as Veo's first_frame. Veo then propagates identity
   * forward while keeping its native ambient + cinematic camera.
   *
   * Opt-out: environment variable `V4_PERSONA_LOCK_FRAME=false` skips the
   * Seedream pre-pass (kept for cost/debug situations). Default is on.
   *
   * Idempotent: caches the resulting URL on beat.persona_locked_first_frame_url
   * so a resumed run skips regeneration.
   *
   * @param {Object} args
   * @param {Object} args.beat
   * @param {Object} args.scene
   * @param {Object} [args.previousBeat]
   * @param {Object[]} args.personas
   * @param {Object} args.episodeContext - must carry uploadBuffer + subjectReferenceImages + visual_style_prefix
   * @returns {Promise<string|null>} the first-frame URL to feed Veo, or null
   *   if the beat has no personas or persona lock is disabled.
   */
  async _buildPersonaLockedFirstFrame({ beat, scene, previousBeat, personas, episodeContext }) {
    if (process.env.V4_PERSONA_LOCK_FRAME === 'false') return null;

    const personasInBeat = this._resolvePersonasInBeat(beat, personas);
    if (personasInBeat.length === 0) return null;

    // Resume path: reuse cached lock frame if the orchestrator persisted one
    if (beat.persona_locked_first_frame_url) return beat.persona_locked_first_frame_url;

    if (!episodeContext?.uploadBuffer) {
      this.logger.warn(
        `[${beat.beat_id}] persona-lock skipped — episodeContext.uploadBuffer missing`
      );
      return null;
    }

    try {
      const { buildPersonaLockedFirstFrame } = await import('../v4/StoryboardHelpers.js');
      const { first_frame_url } = await buildPersonaLockedFirstFrame({
        personas: personasInBeat,
        scene,
        previousBeat,
        subjectReferenceImages: episodeContext.subjectReferenceImages || [],
        beat,
        visualStylePrefix: episodeContext.visual_style_prefix || '',
        uploadBuffer: episodeContext.uploadBuffer
      });
      beat.persona_locked_first_frame_url = first_frame_url;
      this.logger.info(`[${beat.beat_id}] persona-locked first frame ready (${personasInBeat.length} persona(s))`);
      return first_frame_url;
    } catch (err) {
      // Fail-soft: Veo can still produce output from prompt alone. Log so the
      // Director Panel can surface the drift risk as a warning.
      this.logger.warn(
        `[${beat.beat_id}] persona-lock synthesis failed — falling back: ${err.message}`
      );
      beat.persona_lock_error = err.message || String(err);
      return null;
    }
  }
}

export default BaseBeatGenerator;
export { BaseBeatGenerator };
