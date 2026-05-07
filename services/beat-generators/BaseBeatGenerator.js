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
import { validateFluxPromptAgainstAnchor, VisualAnchorInversionError } from '../v4/PersonaVisualAnchor.js';
import {
  BEAT_STATUS,
  ensureLifecycleFields,
  transition as transitionBeatStatus
} from '../v4/BeatLifecycle.js';
import { buildContinuityDirective as _buildContinuityDirectiveImpl } from '../v4/ContinuitySheet.js';

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

    // V4 Phase 5b — N3 ref-stack precondition assertion.
    // For commercial stories, the minimum reference stack must contain
    // [persona_ref OR scene_master_url]. A beat in a commercial scene whose
    // ref stack is empty will produce visually-unmoored output (logs.txt
    // 2026-04-28 root cause for scene 2 beats). We assert here so the
    // failure surfaces at the boundary rather than rendering a bad beat.
    const isCommercialBeat = String(episodeContext?.genre || '').toLowerCase().trim() === 'commercial';
    if (isCommercialBeat) {
      const stackEmpty = !Array.isArray(refStack) || refStack.length === 0;
      const sceneMasterMissing = !scene?.scene_master_url;
      if (stackEmpty && sceneMasterMissing) {
        const msg = `${this.constructor.name}: commercial beat ${beat.beat_id} has empty ref stack AND no scene_master_url — refusing to render. Caller must remediate the upstream Scene Master before retrying.`;
        this.logger.error(msg);
        throw new Error(msg);
      }
      if (beat.requires_scene_master_remediation === true) {
        const msg = `${this.constructor.name}: commercial beat ${beat.beat_id} flagged requires_scene_master_remediation=true by router — refusing to render until upstream remediation completes.`;
        this.logger.error(msg);
        throw new Error(msg);
      }
    }

    this.logger.info(`▶ beat ${beat.beat_id} [${beat.type}] in scene ${scene?.scene_id || '?'}`);

    // Mark beat as in-progress BEFORE the generation so status reflects
    // the active stage even if the caller inspects mid-flight.
    //
    // V4 Tier 1 (2026-05-06) — route status mutation through BeatLifecycle so
    // version + attempts_log + transition validity are enforced uniformly.
    // Accept GENERATING from any current status (pending → first generate,
    // generated → director-driven retake, hard_rejected → user regenerate,
    // superseded → next attempt) — illegal moves throw and surface at the
    // boundary instead of silently corrupting the beat row.
    ensureLifecycleFields(beat);
    if (beat.status !== BEAT_STATUS.GENERATING) {
      try {
        transitionBeatStatus(beat, BEAT_STATUS.GENERATING);
      } catch (lifecycleErr) {
        // Fail loud — an illegal transition means a caller above us has
        // mishandled the beat row. This is a programming error worth
        // surfacing immediately rather than producing a clip on a confused
        // status.
        this.logger.error(`beat ${beat.beat_id} lifecycle transition rejected: ${lifecycleErr.message}`);
        throw lifecycleErr;
      }
    }
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
      transitionBeatStatus(beat, BEAT_STATUS.GENERATED, { expectedFrom: BEAT_STATUS.GENERATING });

      return result;
    } catch (err) {
      // Best-effort transition to FAILED. The lifecycle layer rejects illegal
      // moves (e.g. if we never reached GENERATING because the lifecycle call
      // itself threw); fall back to direct status set so the failure metadata
      // is still recorded for the caller's catch.
      try {
        transitionBeatStatus(beat, BEAT_STATUS.FAILED, { expectedFrom: BEAT_STATUS.GENERATING });
      } catch (_) {
        beat.status = BEAT_STATUS.FAILED;
      }
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
   * V4 P0.4 — Identity-defense gate.
   *
   * Validate a per-beat video prompt against the persona's visual_anchor.
   * Catches gender/age inversions BEFORE the prompt reaches the video model,
   * preventing identity-drift cascades. Subclasses should call this from
   * `_doGenerate` for identity-class beats (TALKING_HEAD_CLOSEUP,
   * DIALOGUE_IN_SCENE, REACTION) right after building the prompt and BEFORE
   * the API call.
   *
   * Mirrors the post-emission inversion check in CharacterSheetDirector.js:394.
   * Same hard-halt semantics: inversion → throw VisualAnchorInversionError,
   * which the orchestrator routes to user_review (no silent splice-correct).
   *
   * Descriptor-class mismatches (ethnicity / hair / build) are NOT escalated
   * here — those are subtler and the corrective-hint splice path remains
   * acceptable upstream.
   *
   * @param {string}  prompt   - the prompt about to be sent to the video model
   * @param {Object} [persona] - persona record (must have .visual_anchor for the gate to fire)
   * @param {string} [beatId]  - beat id for logging/error context
   * @throws {VisualAnchorInversionError} on detected inversion
   */
  _validatePromptAgainstAnchor(prompt, persona, beatId = '?') {
    if (!persona?.visual_anchor) return; // no anchor → nothing to validate against
    if (typeof prompt !== 'string' || prompt.length === 0) return;

    const validation = validateFluxPromptAgainstAnchor(persona.visual_anchor, prompt);
    if (!validation.ok && validation.severity === 'inversion') {
      this.logger.error(
        `${this.constructor.name}: beat ${beatId} INVERSION on persona "${persona.name || 'unnamed'}" — ` +
        `inverted_axes=[${validation.inverted_axes.join(', ')}], ` +
        `evidence=${JSON.stringify(validation.evidence)}. Halting beat — orchestrator routes to user_review.`
      );
      throw new VisualAnchorInversionError(
        `${this.constructor.name}: prompt inverts visual_anchor on axes [${validation.inverted_axes.join(', ')}]. ` +
        `Evidence: ${validation.evidence.join('; ')}`,
        { invertedAxes: validation.inverted_axes, evidence: validation.evidence }
      );
    }
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
   * V4 Phase 11 (2026-05-07) — closing-state continuity directive.
   *
   * Build a structured "CONTINUITY FROM PREVIOUS BEAT" block from the
   * previous beat's extracted closing_state (see services/v4/ClosingStateExtractor.js).
   * Subclasses call this in their _doGenerate prompt assembly and splice
   * the returned string into the model prompt.
   *
   * Returns an empty string when:
   *   - previousBeat is null (first beat of scene)
   *   - previousBeat.closing_state is missing (extractor offline / failed)
   *   - all closing_state fields are 'unspecified' (extractor returned nothing useful)
   *
   * The directive describes WHAT the next beat must inherit, not WHERE the
   * camera was. Pixels carry geometry; this carries intent (emotional state,
   * subject position, action state, eyeline target, breath, last spoken line).
   *
   * @param {Object} [previousBeat]
   * @param {Object} [opts]
   * @param {'verbose'|'compact'} [opts.mode='verbose']
   *   - 'verbose' — multi-line block (~250-400 chars) for Veo / Seedream-pass
   *     prompts that have plenty of token budget.
   *   - 'compact' — single-line ~80-150 char summary for Kling-budgeted
   *     generators (CinematicDialogue, GroupTwoShot, Action, TalkingHead).
   * @returns {string} directive text suitable for prepending/splicing into a
   *   beat prompt, or '' when not applicable
   */
  _buildContinuityFromPreviousBeat(previousBeat, opts = {}) {
    const cs = previousBeat?.closing_state;
    if (!cs || typeof cs !== 'object') return '';
    const mode = opts.mode === 'compact' ? 'compact' : 'verbose';

    // Skip when every enum is 'unspecified' AND no detail/dialogue — nothing useful
    // to inject. Saves prompt budget on beats that legitimately had no clear
    // closing state (e.g. a fade-to-black ending).
    const hasSignal =
      (cs.closing_emotional_state && cs.closing_emotional_state !== 'unspecified') ||
      (cs.closing_subject_position && cs.closing_subject_position !== 'unspecified') ||
      (cs.closing_action_state && cs.closing_action_state !== 'unspecified') ||
      (cs.closing_eyeline_target && cs.closing_eyeline_target !== 'unspecified') ||
      (cs.breath_state && cs.breath_state !== 'unspecified') ||
      (cs.closing_emotional_detail && cs.closing_emotional_detail.length > 0) ||
      (cs.closing_action_detail && cs.closing_action_detail.length > 0) ||
      (cs.last_dialogue_line && cs.last_dialogue_line.length > 0);
    if (!hasSignal) return '';

    if (mode === 'compact') {
      // Single-line summary for Kling-budgeted prompts. Ordered by signal
      // value: emotional state and action are the most actionable for the
      // model; position/eyeline/breath are bonus when there's room. Last
      // dialogue is excluded from compact (the prior_speaker_dialogue_tail
      // already covers SHOT_REVERSE_SHOT children; non-SRS dialogue beats
      // need it less).
      const parts = [];
      if (cs.closing_emotional_state && cs.closing_emotional_state !== 'unspecified') {
        parts.push(cs.closing_emotional_state.replace(/_/g, ' '));
      }
      if (cs.closing_action_state && cs.closing_action_state !== 'unspecified') {
        parts.push(cs.closing_action_state.replace(/_/g, ' '));
      }
      if (cs.closing_eyeline_target && cs.closing_eyeline_target !== 'unspecified') {
        parts.push(`eyeline ${cs.closing_eyeline_target.replace(/_/g, ' ')}`);
      }
      if (cs.breath_state && cs.breath_state !== 'unspecified') {
        parts.push(`breath ${cs.breath_state.replace(/_/g, ' ')}`);
      }
      if (parts.length === 0) return '';
      return `Continue from prior beat (${parts.join(', ')}) — same continuous moment, no reset.`;
    }

    const lines = [];
    lines.push('## CONTINUITY FROM PREVIOUS BEAT (the chain you must continue — DO NOT RESET):');
    lines.push('The prior beat ended in this state. Continue the performance arc forward — do not start fresh.');

    if (cs.closing_subject_position && cs.closing_subject_position !== 'unspecified') {
      lines.push(`  • Subject position: ${cs.closing_subject_position.replace(/_/g, ' ')}`);
    }
    if (cs.closing_action_state && cs.closing_action_state !== 'unspecified') {
      const detail = cs.closing_action_detail ? ` (${cs.closing_action_detail})` : '';
      lines.push(`  • Action state: ${cs.closing_action_state.replace(/_/g, ' ')}${detail}`);
    }
    if (cs.closing_eyeline_target && cs.closing_eyeline_target !== 'unspecified') {
      lines.push(`  • Eyeline aimed: ${cs.closing_eyeline_target.replace(/_/g, ' ')}`);
    }
    if (cs.closing_emotional_state && cs.closing_emotional_state !== 'unspecified') {
      const detail = cs.closing_emotional_detail ? ` — ${cs.closing_emotional_detail}` : '';
      lines.push(`  • Emotional state: ${cs.closing_emotional_state.replace(/_/g, ' ')}${detail}`);
    }
    if (cs.breath_state && cs.breath_state !== 'unspecified') {
      lines.push(`  • Breath: ${cs.breath_state.replace(/_/g, ' ')}`);
    }
    if (cs.last_dialogue_line && cs.last_dialogue_line.length > 0) {
      lines.push(`  • Last spoken line: "${cs.last_dialogue_line}"`);
    }

    lines.push('Open this beat as the moment that follows. The audience must read this as one continuous performance, not a fresh take.');
    return lines.join('\n');
  }

  /**
   * V4 Phase 11 (2026-05-07) — scene anchor + sonic overlay propagation.
   *
   * The screenplay scene-graph emits `scene.scene_visual_anchor_prompt` — a
   * rich 80-150 word DP-grade brief covering location + time of day + lighting
   * + color palette + character blocking + wardrobe + atmosphere + film stock.
   * Today this brief drives Scene Master generation (Seedream pre-pass) but
   * does NOT reach the per-beat video prompts. The episode's `sonic_world`
   * carries scene-specific ambient overlays (`scene_variations[].overlay`)
   * that similarly never reach the beat audio register.
   *
   * Both signals are available on the orchestrator's `scene` and the
   * `episodeContext` / scene-graph sonic_world structures. This helper
   * extracts the matching overlay + a condensed scene-anchor summary so
   * generators can splice them into their model prompts. The result tells
   * the model the LOOK and the SONIC REGISTER of the scene, not just the
   * location string.
   *
   * Two modes:
   *  - 'compact' (default for Kling-budget generators) — single line
   *    "Scene look: <truncated anchor>. Sonic register: <overlay>." Aim
   *    ~150-220 chars total.
   *  - 'verbose' (for Veo prompts with generous budget) — multi-line block
   *    with the full scene_visual_anchor_prompt + sonic overlay + sonic
   *    base palette context.
   *
   * Returns empty string when neither anchor nor sonic overlay is available.
   *
   * @param {Object} scene
   * @param {Object} [episodeContext]
   * @param {Object} [opts]
   * @param {'verbose'|'compact'} [opts.mode='compact']
   * @returns {string}
   */
  _buildSceneAnchorDirective(scene, episodeContext = null, opts = {}) {
    const mode = opts.mode === 'verbose' ? 'verbose' : 'compact';
    const anchor = scene?.scene_visual_anchor_prompt;
    const synopsis = scene?.scene_synopsis;
    const sonicOverlay = this._resolveSonicOverlayForScene(scene, episodeContext);
    const sonicBase = this._resolveSonicBaseForEpisode(episodeContext);

    if (!anchor && !synopsis && !sonicOverlay) return '';

    if (mode === 'compact') {
      const parts = [];
      // Truncate anchor aggressively in compact mode — Kling budget is tight.
      // Aim ~120 chars max; preserve the LIGHTING + COLOR PALETTE substrings
      // when present (those are the most cinematically actionable signals).
      if (anchor) {
        const condensed = this._condenseSceneAnchor(anchor, 130);
        if (condensed) parts.push(`Scene look: ${condensed}`);
      } else if (synopsis) {
        parts.push(`Scene: ${String(synopsis).slice(0, 140)}`);
      }
      if (sonicOverlay) {
        parts.push(`Sonic register: ${String(sonicOverlay).slice(0, 90)}`);
      }
      if (parts.length === 0) return '';
      return parts.join('. ') + '.';
    }

    // Verbose
    const lines = [];
    lines.push('## SCENE LOOK & ATMOSPHERE (DP brief — match this register):');
    if (anchor) {
      lines.push(String(anchor).slice(0, 700));
    } else if (synopsis) {
      lines.push(`Synopsis: ${String(synopsis).slice(0, 400)}`);
    }
    if (sonicOverlay || sonicBase) {
      lines.push('');
      lines.push('## SCENE SONIC OVERLAY (audio register the visuals must support):');
      if (sonicBase) lines.push(`Episode bed: ${String(sonicBase).slice(0, 220)}`);
      if (sonicOverlay) lines.push(`Scene overlay: ${String(sonicOverlay).slice(0, 220)}`);
    }
    return lines.join('\n');
  }

  /**
   * Internal — pick the sonic_world overlay that matches the current scene
   * by scene_id. Returns the overlay string or null.
   */
  _resolveSonicOverlayForScene(scene, episodeContext) {
    const sceneId = scene?.scene_id;
    if (!sceneId) return null;
    // Sonic_world lives on the screenplay scene-graph root, threaded through
    // episodeContext.sonic_world by the orchestrator (when present). Defense:
    // also check episodeContext.sceneGraph.sonic_world for older orchestrator
    // shapes during the migration window.
    const sw = episodeContext?.sonic_world
      || episodeContext?.sceneGraph?.sonic_world
      || null;
    if (!sw || !Array.isArray(sw.scene_variations)) return null;
    const variation = sw.scene_variations.find(v => v && v.scene_id === sceneId);
    return (variation && typeof variation.overlay === 'string') ? variation.overlay.trim() : null;
  }

  /**
   * Internal — episode-wide sonic base palette (the always-on bed). Used by
   * verbose mode only since it's fixed for the entire episode.
   */
  _resolveSonicBaseForEpisode(episodeContext) {
    const sw = episodeContext?.sonic_world
      || episodeContext?.sceneGraph?.sonic_world
      || null;
    if (!sw) return null;
    return (typeof sw.base_palette === 'string') ? sw.base_palette.trim() : null;
  }

  /**
   * V4 Phase 11 (2026-05-07) — DP directive consolidation.
   *
   * The screenplay scene-graph already emits structured DP fields per beat:
   *   - beat.lens             (e.g., "85mm" — dialogue beats)
   *   - beat.focal_length_hint (e.g., "14mm" | "24mm" | "35mm" | "50mm" | "85mm" | "macro" — V4 Tier 3.1)
   *   - beat.coverage_slot    (wide | cowboy | single_a | single_b | two_shot | close | insert | pov | cutaway)
   *   - beat.camera_temperament (handheld | locked | dolly | gimbal)
   *   - beat.motion_vector    (static | drift_left | drift_right | push_in | pull_out | whip_left | whip_right | rack_focus)
   *   - beat.framing          (free-form, e.g., "tight_closeup")
   *   - beat.subject_presence (primary_in | primary_out | primary_off_screen_audible)
   *
   * Today these fields are scattered across generator-specific reads —
   * CinematicDialogue uses beat.lens; ActionGenerator reads camera_notes;
   * BRoll consults framing — so the same DP intent reaches the model at
   * different fidelity per beat type. The Director Agent's prestige
   * mandate calls for a UNIFIED DP directive that surfaces every available
   * structured field consistently across all generators, so the generators
   * stop falling back to model priors (Veo defaults to social-content
   * medium-wide, Kling V3 to music-video shallow-DoF — visible mismatch
   * across cuts).
   *
   * This helper produces a single-line "DP: 85mm, single_b, locked, static"
   * style directive that every generator splices into its prompt. Empty
   * string when no structured fields are populated (so it's a no-op for
   * legacy beat objects that predate the structured schema).
   *
   * @param {Object} beat
   * @returns {string}
   */
  _buildDpDirective(beat) {
    if (!beat || typeof beat !== 'object') return '';
    const parts = [];

    // Lens / focal length — prefer explicit `lens` over `focal_length_hint`
    // because lens is hand-authored on dialogue beats while focal_length_hint
    // is the Tier 3.1 enum. When both present, lens wins.
    if (typeof beat.lens === 'string' && beat.lens.trim()) {
      parts.push(beat.lens.trim());
    } else if (typeof beat.focal_length_hint === 'string' && beat.focal_length_hint.trim()) {
      parts.push(beat.focal_length_hint.trim());
    }

    // Coverage slot — the screenplay's structural shot-list label.
    if (typeof beat.coverage_slot === 'string' && beat.coverage_slot.trim()) {
      parts.push(beat.coverage_slot.replace(/_/g, ' ').trim());
    } else if (typeof beat.framing === 'string' && beat.framing.trim()) {
      // Fallback to free-form framing when coverage_slot absent.
      parts.push(beat.framing.replace(/_/g, ' ').trim());
    }

    // Camera temperament — handheld / locked / dolly / gimbal.
    if (typeof beat.camera_temperament === 'string' && beat.camera_temperament.trim()) {
      parts.push(beat.camera_temperament.trim());
    }

    // Motion vector — static / drift / push / pull / whip / rack.
    if (typeof beat.motion_vector === 'string' && beat.motion_vector.trim()) {
      parts.push(beat.motion_vector.replace(/_/g, ' ').trim());
    }

    // Subject presence — primary_in / primary_out / primary_off_screen_audible.
    if (typeof beat.subject_presence === 'string' && beat.subject_presence.trim()) {
      parts.push(`subject ${beat.subject_presence.replace(/_/g, ' ').trim()}`);
    }

    if (parts.length === 0) return '';
    return `DP: ${parts.join(', ')}.`;
  }

  /**
   * Internal — condense a long scene anchor prose blob to ~maxChars while
   * preserving the most cinematic signals. Heuristic: prefer sentences that
   * mention light/lighting/lit/illumin/key, color/palette/grade, time-of-day
   * markers (dawn, dusk, golden, blue, night, noon), or atmosphere markers
   * (smoke, mist, dust, rain). Falls back to the head of the prose.
   */
  _condenseSceneAnchor(anchor, maxChars = 130) {
    if (typeof anchor !== 'string' || anchor.length === 0) return '';
    if (anchor.length <= maxChars) return anchor.trim();
    const sentences = anchor.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
    if (sentences.length === 0) return anchor.slice(0, maxChars).trim();

    const cinematicKeywords = /\b(light|lit|illumin|key|fill|kicker|color|palette|grade|tone|dawn|dusk|golden|blue hour|night|noon|smoke|mist|dust|rain|fog|haze|practical|ambient|tungsten|fluorescent|sodium|silhouette|backlit|shadow|halation|bloom)\b/i;
    const scored = sentences
      .map((s, i) => ({ s, score: (cinematicKeywords.test(s) ? 100 : 0) - i }))
      .sort((a, b) => b.score - a.score);

    let out = '';
    for (const { s } of scored) {
      const candidate = out ? `${out} ${s.trim()}` : s.trim();
      if (candidate.length > maxChars) {
        if (out) break;
        return s.slice(0, maxChars).trim();
      }
      out = candidate;
    }
    return out;
  }

  /**
   * V4 Tier 2.1 (2026-05-06) — Unified canonical first-frame waterfall.
   *
   * BEFORE: each of 8 generators (Reaction, Bridge, InsertShot, BRoll,
   * VoiceoverBRoll, SilentStare, Action, VeoAction) picked its own order
   * — persona-lock-first vs scene-master-first vs subject-natural-first
   * vs SIPL-first — making per-generator continuity behavior inconsistent
   * (a REACTION beat after a BRoll beat could anchor on a different
   * priority than the BRoll itself, breaking the chain). The plan's
   * single canonical waterfall fixes this.
   *
   * Waterfall priority (every generator goes through the same order):
   *   1. beat.persona_locked_first_frame_url   (cached on beat — survives across runs)
   *   2. opts.personaLockUrl                   (just synthesized this run)
   *   3. opts.siplUrl                          (Seedream Scene-Integrated Product Lock — INSERT_SHOT)
   *   4. opts.subjectNaturalUrl                (Seedream subject natural anchor — B_ROLL natural intent)
   *   5. beat.bridge_from_scene_endframe_url   (Bridge beats only — prior scene's last frame)
   *   6. previousBeat?.endframe_url            (THE canonical continuity chain)
   *   7. scene?.scene_master_url               (FALLBACK — flags `previous_endframe_missing` when prevBeat existed)
   *   8. opts.subjectRefUrl                    (InsertShot fallback — raw product photo)
   *   9. refStack?.[0]
   *
   * BREADCRUMB (V4 Tier 2.1 Lens C / Lens E enabler):
   *   Sets beat.continuity_fallback_reason whenever the picker drops below
   *   the endframe-chain tier when a previous beat existed. The two values
   *   the Director rubric (Tier 2.4) reads:
   *     - 'previous_endframe_missing_scene_master_fallback'
   *     - 'previous_endframe_missing_refstack_fallback'
   *   Other reasons (persona_lock_used, sipl_used, subject_natural_used,
   *   bridge_anchor_used, previous_endframe_used) are recorded for audit but
   *   do NOT trigger continuity deductions — they're the legitimate
   *   non-endframe paths.
   *
   * The signature stays backward-compatible: callers that pass only the old
   * 3 args (refStack, previousBeat, scene) get the same minimum waterfall
   * (steps 6-9) without breadcrumb. 8 generators are migrated to pass beat
   * + opts so they all benefit from the unified contract.
   *
   * @param {Object[]} refStack - array of URLs, already ordered by the ref-stack builder
   * @param {Object} [previousBeat]
   * @param {Object} [scene]
   * @param {Object} [beat] - the current beat (mutated with continuity_fallback_reason breadcrumb)
   * @param {Object} [opts]
   * @param {string|null} [opts.personaLockUrl] - persona-locked first frame just synthesized this run
   * @param {string|null} [opts.siplUrl] - Scene-Integrated Product Lock (INSERT_SHOT)
   * @param {string|null} [opts.subjectNaturalUrl] - subject natural anchor (B_ROLL natural intent)
   * @param {string|null} [opts.subjectRefUrl] - raw subject reference (InsertShot fallback)
   * @returns {string|null}
   */
  _pickStartFrame(refStack, previousBeat, scene, beat = null, opts = {}) {
    const setReason = (reason) => {
      if (beat && reason) beat.continuity_fallback_reason = reason;
    };
    const clearReason = () => {
      if (beat) beat.continuity_fallback_reason = null;
    };

    // Tier 1: persona-lock cached on the beat (idempotent across runs).
    if (beat?.persona_locked_first_frame_url) {
      setReason('persona_lock_used');
      return beat.persona_locked_first_frame_url;
    }
    // Tier 2: persona-lock synthesized this run (caller already did the work).
    if (opts.personaLockUrl) {
      setReason('persona_lock_synthesized');
      return opts.personaLockUrl;
    }
    // Tier 3: Scene-Integrated Product Lock for INSERT_SHOT.
    if (opts.siplUrl) {
      setReason('sipl_used');
      return opts.siplUrl;
    }
    // Tier 4: Subject natural anchor for B_ROLL natural intent.
    if (opts.subjectNaturalUrl) {
      setReason('subject_natural_used');
      return opts.subjectNaturalUrl;
    }
    // Tier 5: Bridge beats — prior scene's last endframe explicitly captured.
    if (beat?.bridge_from_scene_endframe_url) {
      setReason('bridge_anchor_used');
      return beat.bridge_from_scene_endframe_url;
    }
    // Tier 6: THE canonical continuity chain — previous beat's endframe.
    if (previousBeat?.endframe_url) {
      setReason('previous_endframe_used');
      return previousBeat.endframe_url;
    }

    // Below this line we're in fallback territory. If a previousBeat
    // EXISTED but its endframe was missing (silent extraction failure
    // previously), we set the diagnostic breadcrumb so Lens C (Tier 2.4)
    // can deduct cross_beat_continuity. If there's no previousBeat (this
    // is the scene's first beat), falling to scene_master is correct +
    // expected — no breadcrumb.
    const previousExpected = !!previousBeat;

    // Tier 7: Scene Master.
    if (scene?.scene_master_url) {
      setReason(previousExpected ? 'previous_endframe_missing_scene_master_fallback' : 'scene_master_first_beat');
      return scene.scene_master_url;
    }
    // Tier 8: InsertShot raw subject ref fallback.
    if (opts.subjectRefUrl) {
      setReason(previousExpected ? 'previous_endframe_missing_subject_ref_fallback' : 'subject_ref_fallback');
      return opts.subjectRefUrl;
    }
    // Tier 9: Reference stack head.
    if (refStack && refStack.length > 0) {
      setReason(previousExpected ? 'previous_endframe_missing_refstack_fallback' : 'refstack_first_beat');
      return refStack[0];
    }

    setReason(previousExpected ? 'previous_endframe_missing_text_only' : 'no_first_frame_text_only');
    if (!beat) clearReason(); // legacy 3-arg callers should not see breadcrumbs
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
   * V4 Tier 2.2 (2026-05-06) — Per-model color hint.
   *
   * Different video models default to different color signatures. Without
   * an explicit prompt-level normalization, Veo (warm tungsten by default)
   * and Kling (cool/neutral daylight) produce visibly different grades
   * within the SAME scene-master-anchored beat — a continuity break the
   * post-production LUT can mask but not fix (LUT operates on rendered
   * pixels; lighting-direction errors stay baked in).
   *
   * The hint is appended at the tail of the prompt where models honor it
   * most strongly. Brand palette is interpolated when available so the
   * grade leans toward the brand's identity colors WITHOUT overriding the
   * scene's lighting motivation.
   *
   * @param {'kling' | 'veo' | 'seedream' | 'omnihuman' | 'generic'} modelHint
   * @param {Object} [brandKit] - story.brand_kit (optional; used for palette interpolation)
   * @returns {string} a short directive to append to the beat prompt
   */
  _buildPerModelColorHint(modelHint, brandKit = null) {
    const palette = Array.isArray(brandKit?.color_palette)
      ? brandKit.color_palette.slice(0, 4).map(c => c?.hex || c?.name).filter(Boolean)
      : [];
    const paletteFragment = palette.length > 0
      ? ` Brand palette accents available: ${palette.join(', ')} — let them guide grade direction without overpowering scene lighting.`
      : '';

    switch ((modelHint || 'generic').toLowerCase()) {
      case 'kling':
        // Kling's defaults skew slightly cool / neutral. Reinforce the
        // intent so multi-beat scenes keep a consistent key direction.
        return `Color signature: neutral daylight 5200K-5800K, true-to-life skin tones, avoid amber wash unless practical-lit motivation is in frame.${paletteFragment}`;
      case 'veo':
        // Veo strongly biases toward tungsten warmth even on outdoor /
        // daytime scenes — the most common cross-model continuity break.
        // Tell it explicitly to inherit the prior beat's temperature.
        return `Color signature: continuous with previous beat's color temperature; avoid Veo's default tungsten warm shift unless a practical lamp / firelight is visibly in scene.${paletteFragment}`;
      case 'seedream':
        return `Color palette: cohesive with scene-master endframe, lighting direction matches the master plate.${paletteFragment}`;
      case 'omnihuman':
        return `Color signature: portrait-grade neutral skin tones, soft key, no color cast.${paletteFragment}`;
      default:
        return paletteFragment ? paletteFragment.trim() : '';
    }
  }

  /**
   * V4 Tier 2.2 (2026-05-06) — Wardrobe directive.
   *
   * Persona's wardrobe_hint is stored on the Cast Bible at story creation
   * but was previously never read by per-beat generators — wardrobe drift
   * across beats relied entirely on character-sheet reference images,
   * which Kling/Veo/Seedream often "interpret" rather than reproduce.
   * Splicing wardrobe_hint into every persona-bearing prompt anchors the
   * costume at the language layer too, defensively.
   *
   * Returns '' when persona has no wardrobe_hint OR when no persona is
   * provided (caller responsibility to gate by persona presence).
   *
   * @param {Object} [persona]
   * @returns {string}
   */
  _buildWardrobeDirective(persona) {
    const hint = persona?.wardrobe_hint;
    if (typeof hint !== 'string' || hint.trim().length === 0) return '';
    return `Wardrobe: ${hint.trim()}`;
  }

  /**
   * V4 Tier 2.5 (2026-05-06) — Continuity directive.
   *
   * Reads the scene's structured continuity_sheet (Tier 2.5 schema) and
   * produces a short prompt addendum: "actor 0 holds laptop in left hand;
   * lighting key from window_left; time of day: golden_hour."
   *
   * The directive is the LANGUAGE-LAYER complement to the persona-locked
   * first frame and the unified _pickStartFrame waterfall. Together they
   * give the model three reinforcement channels for continuity (image
   * input, in-prompt visual state, and now structured scene state).
   *
   * Returns '' when the scene lacks a continuity_sheet — legacy episodes
   * pass through untouched.
   *
   * @param {Object} scene
   * @param {Object} beat
   * @returns {string}
   */
  _buildContinuityDirective(scene, beat) {
    try {
      return _buildContinuityDirectiveImpl(scene, beat);
    } catch {
      // Defense in depth — never let a continuity-sheet quirk break the
      // beat. Empty string falls through cleanly.
      return '';
    }
  }

  /**
   * V4 Tier 3.1 (2026-05-06) — Anti-reference image for the unified
   * coverage-slot mechanism.
   *
   * When generating beat N, pass the previous beat's endframe as a
   * NEGATIVE reference image to the model so it doesn't reproduce the
   * same composition. Combined with the schema-level coverage_slot +
   * motion_vector adjacency rule (ScreenplayValidator Tier 3.1), this is
   * the single highest-leverage architectural fix for the b-roll/action
   * collapse symptom: the model sees BOTH "must differ in coverage" AND
   * "do not reproduce this composition" — a two-pronged defense.
   *
   * Per-model strength (per Director note):
   *   - Veo: 'strong' — Veo honors anti-references aggressively
   *   - Kling: 'moderate' — Kling honors them less; strong setting confuses
   *   - Seedream / OmniHuman: not supported (return null)
   *
   * Returns null when there's no previousBeat OR no usable endframe URL.
   * Callers thread the result into their model API call (per-vendor
   * field shape varies; not standardized at this layer).
   *
   * @param {Object} [previousBeat]
   * @param {'kling' | 'veo' | 'seedream' | 'omnihuman'} modelHint
   * @returns {{ url: string, strength: 'strong'|'moderate' } | null}
   */
  _buildPreviousBeatAntiReference(previousBeat, modelHint) {
    if (process.env.V4_ANTI_REFERENCE === 'false') return null;
    const url = previousBeat?.endframe_url;
    if (!url || typeof url !== 'string') return null;
    const m = String(modelHint || '').toLowerCase();
    if (m === 'veo') return { url, strength: 'strong' };
    if (m === 'kling') return { url, strength: 'moderate' };
    return null; // Seedream / OmniHuman / unknown — anti-ref not supported
  }

  /**
   * V4 Tier 3.1 — Anti-reference TEXT directive (the wired counterpart to
   * _buildPreviousBeatAntiReference, which produces structured data).
   *
   * Both Kling V3 (via fal-ai/kling-video) and Veo 3.1 (via Vertex AI) ingest
   * a single first-frame URL and a text prompt. Neither exposes a documented
   * `negative_reference_image` field at the layer this codebase calls. The
   * pragmatic wire-up is therefore via PROMPT LANGUAGE — a short directive
   * appended to the tail of the prompt that explicitly forbids reproducing
   * the prior beat's composition.
   *
   * Combined with Tier 3.1's coverage_slot + motion_vector adjacency rule
   * (ScreenplayValidator), this gives the model a two-pronged defense
   * against the b-roll/action collapse symptom: schema-level structural
   * constraints (you MUST differ in coverage) + prompt-level instruction
   * (do NOT reproduce that composition).
   *
   * Strength varies per model:
   *   - Veo: 'strong' — Veo honors anti-language aggressively
   *   - Kling: 'moderate' — Kling is more literal; over-strong wording confuses it
   *
   * Returns '' when no previousBeat is available, when previousBeat has no
   * endframe (so there's no anchor to anti-reference against), or when the
   * env flag V4_ANTI_REFERENCE_DIRECTIVE=false disables the feature.
   *
   * @param {Object} [previousBeat]
   * @param {'kling' | 'veo' | 'seedream' | 'omnihuman'} modelHint
   * @returns {string}
   */
  _buildPreviousBeatAntiReferenceDirective(previousBeat, modelHint) {
    if (process.env.V4_ANTI_REFERENCE_DIRECTIVE === 'false') return '';
    if (!previousBeat?.endframe_url) return '';
    const m = String(modelHint || '').toLowerCase();
    if (m === 'veo') {
      return 'Anti-reference: this beat must NOT reproduce the composition of the previous beat. Differ in subject placement, camera angle, framing density, OR motion vector — at least one axis of visible difference is required.';
    }
    if (m === 'kling') {
      return 'Anti-reference: vary composition from prior beat. Differ in subject scale or screen position.';
    }
    return '';
  }

  /**
   * V4 Tier 2.2 (2026-05-06) — Brand color directive.
   *
   * Brand kit color palette previously fed only the LUT (post-hoc grade).
   * Splicing it into the prompt as a soft directive nudges the model to
   * include incidental brand colors in the frame — a sign on a wall, a
   * cup in the foreground, a wardrobe accent — so the grade has something
   * to land on. Phrased as ACCENT to avoid hero-prop product placement
   * (Tier 3.4's narrative grammar handles that).
   *
   * Returns '' when brand_kit lacks a palette or when palette is empty.
   *
   * @param {Object} [episodeContext]
   * @returns {string}
   */
  _buildBrandColorDirective(episodeContext) {
    const palette = Array.isArray(episodeContext?.brandKit?.color_palette)
      ? episodeContext.brandKit.color_palette.slice(0, 4)
          .map(c => c?.hex || c?.name)
          .filter(Boolean)
      : [];
    if (palette.length === 0) return '';
    return `Brand palette accents (use sparingly, never logo-prominent): ${palette.join(', ')}.`;
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
  async _buildPersonaLockedFirstFrame({ beat, scene, previousBeat, personas, episodeContext, postureDirective = null }) {
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
        // V4 Phase 7 — thread commercial_brief so the persona-lock pre-pass
        // honors the same style-aware identity directive as the Scene Master.
        // Non-photoreal styles get archetype-preserving language; photoreal
        // keeps "preserve EXACT facial structure". The brief lives on
        // episodeContext.commercial_brief (set by runV4Pipeline).
        commercialBrief: episodeContext.commercial_brief || null,
        uploadBuffer: episodeContext.uploadBuffer,
        // 2026-05-01 — A1.1 amendment. Subclasses can pass a kinetic posture
        // directive (e.g. VeoActionGenerator) so the persona-lock still is
        // born mid-action instead of as a portrait.
        postureDirective
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

  /**
   * 2026-05-06 — Veo→Kling fallback (Step 2).
   *
   * Shared Kling V3 Pro fallback used by every Veo beat generator
   * (VeoActionGenerator, InsertShotGenerator, BRollGenerator,
   * VoiceoverBRollGenerator, BridgeBeatGenerator, ReactionGenerator).
   *
   * Triggered when `veo.generateWithFrames(... { skipTextOnlyFallback: true })`
   * throws `VeoContentFilterPersistentError` — Veo's content filter
   * persistently refused all anchored tiers, and we'd rather route to a
   * different model than ship unanchored text-only output that's guaranteed
   * to face-drift / lose subject matter (Director Agent hard-rejects it
   * with score 35-42, halting the episode — see logs.txt 2026-05-06).
   *
   * Kling V3 Pro has a different content-filter posture AND uses
   * persona/subject elements as the anchor (not first-frame), so the same
   * persona-lock still that Veo refused never gets re-submitted to Kling.
   *
   * @param {Object} args
   * @param {Object} args.beat
   * @param {Object} args.scene
   * @param {Array}  args.refStack
   * @param {Object[]} args.personas
   * @param {Object} args.episodeContext
   * @param {Object} [args.previousBeat]
   * @param {Object} [args.routingMetadata]
   * @param {string} args.prompt - the prompt to feed Kling (caller-built)
   * @param {number} args.duration - target duration seconds
   * @param {string} args.beatTypeLabel - short label appended to modelUsed (e.g. 'action', 'insert', 'broll', 'vo-broll', 'bridge', 'reaction')
   * @param {boolean} [args.includeSubject=false] - add buildKlingSubjectElement when beat.subject_present
   * @param {boolean} [args.includePersonaElements=true] - add buildKlingElementsFromPersonas
   * @param {string}  [args.fallbackReason] - human-readable reason from caller's catch block
   * @param {string|null} [args.veoSanitizationTier]
   * @param {boolean} [args.generateAudio=true]
   * @param {Array}   [args.extraMetadata] - merged into result.metadata for caller-specific fields
   * @returns {Promise<{videoBuffer: Buffer, durationSec: number, modelUsed: string, costUsd: number, metadata: Object}>}
   */
  async _fallbackToKlingForVeoFailure({
    beat,
    scene,
    refStack,
    personas = [],
    episodeContext,
    previousBeat,
    routingMetadata,
    prompt,
    duration,
    beatTypeLabel,
    includeSubject = false,
    includePersonaElements = true,
    fallbackReason = '',
    veoSanitizationTier = null,
    generateAudio = true,
    extraMetadata = {}
  }) {
    const { kling } = this.falServices;
    if (!kling) {
      throw new Error(
        `${this.constructor.name}: Veo unusable AND kling service not in deps — beat ${beat?.beat_id || '?'} cannot fall back. ${fallbackReason}`
      );
    }

    // Lazy import to avoid circular module-load between BaseBeatGenerator and KlingFalService.
    const { buildKlingElementsFromPersonas, buildKlingSubjectElement } = await import('../KlingFalService.js');

    // V4 Phase 11 (2026-05-07) — translate Veo-grammar prompt to Kling grammar.
    // Each generator's caller built a "Kling-friendly" variant before this
    // call, but those variants are still lightly-edited Veo prose. The
    // translator strips Veo-only frame-anchoring momentum phrases, compresses
    // verbose lens directives, and (optionally) runs a Gemini Flash semantic
    // translation pass when V4_VEO_TO_KLING_GEMINI_TRANSLATE=true. Without
    // this, fallback beats read as a different cinematographer mid-episode.
    // Cached by hash; falls through to original prompt on translator failure.
    let translatedPrompt = prompt;
    try {
      const { translateVeoPromptToKling } = await import('../v4/VeoToKlingTranslator.js');
      translatedPrompt = await translateVeoPromptToKling({
        prompt,
        beatType: beatTypeLabel || beat?.type || 'unknown',
        logPrefix: beat?.beat_id || '?'
      });
    } catch (translatorErr) {
      this.logger.warn(
        `[${beat?.beat_id || '?'}] Veo→Kling translator threw (${translatorErr.message}) — using original prompt verbatim`
      );
      translatedPrompt = prompt;
    }

    // Kling clamps action beats to [3, 15]s. Most Veo beats run [2, 8]s, so
    // ensure 3s minimum for Kling.
    const klingDuration = Math.max(3, Math.min(15, duration || 5));

    // Build elements[] anchor — different from Veo's first-frame anchor.
    let elements = [];
    if (includePersonaElements) {
      const personasInShot = [];
      if (Array.isArray(beat?.persona_indexes)) {
        for (const idx of beat.persona_indexes) {
          if (personas[idx]) personasInShot.push(personas[idx]);
        }
      } else if (typeof beat?.persona_index === 'number' && personas[beat.persona_index]) {
        personasInShot.push(personas[beat.persona_index]);
      } else if (Array.isArray(beat?.personas_present) && beat.personas_present.length > 0) {
        // personas_present is an integer array on B_ROLL / VOICEOVER_OVER_BROLL
        for (const idx of beat.personas_present) {
          if (typeof idx === 'number' && personas[idx]) personasInShot.push(personas[idx]);
        }
      }
      const built = buildKlingElementsFromPersonas(personasInShot);
      elements = built.elements || [];
    }

    if (includeSubject && (beat?.subject_present || beat?.subject_focus) && elements.length < 3) {
      const subjectElement = buildKlingSubjectElement(episodeContext?.subjectReferenceImages);
      if (subjectElement) elements.push(subjectElement);
    }

    // Start frame: re-use the unified picker — same selection logic as the
    // Veo path (previous endframe → scene master → refStack → null).
    const startFrameUrl = this._pickStartFrame(refStack, previousBeat, scene, beat, {});

    this.logger.info(
      `[${beat?.beat_id || '?'}] Kling V3 Pro ${beatTypeLabel.toUpperCase()} (Veo fallback, ${klingDuration}s, ` +
      `${startFrameUrl ? 'anchored' : 'text-only'}, ${elements.length} element(s))`
    );

    const result = await kling.generateActionBeat({
      startFrameUrl,
      elements,
      prompt: translatedPrompt,
      options: {
        duration: klingDuration,
        aspectRatio: '9:16',
        generateAudio
      }
    });

    const COST_KLING_V3_PRO_PER_SEC = 0.224;

    return {
      videoBuffer: result.videoBuffer,
      durationSec: klingDuration,
      modelUsed: `kling-v3-pro/${beatTypeLabel} (veo-fallback)`,
      costUsd: COST_KLING_V3_PRO_PER_SEC * klingDuration,
      metadata: {
        klingVideoUrl: result.videoUrl,
        primaryAttempt: 'veo-3.1-standard',
        primaryFailureReason: fallbackReason || 'Veo content filter persistent on anchored tiers',
        veoSanitizationTier,
        fallbackChain: ['veo-3.1-standard', 'kling-v3-pro'],
        originalType: routingMetadata?.originalType || beat?.type,
        ...extraMetadata
      }
    };
  }
}

export default BaseBeatGenerator;
export { BaseBeatGenerator };
