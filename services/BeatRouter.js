// services/BeatRouter.js
// V4 BeatRouter — the traffic cop that maps every beat to the right generator.
//
// Given a scene-graph from Gemini, the BeatRouter walks every beat, determines
// which generator class to use, and validates the total estimated cost against
// the episode's cost cap BEFORE any generation happens.
//
// This is the single source of truth for V4 routing decisions. Every beat
// type maps to exactly one generator. Edge cases (text rendering, emotional
// peaks, Mode A vs Mode B) are handled inline via flags and options.
//
// Phase 1a: hardcoded routing table.
// Phase 4 (future): delegates to mcp__video-ai-knowledge__suggest_pipeline for
// dynamic MCP-driven routing. Leaving the door open via a clean interface.

import winston from 'winston';
import {
  TalkingHeadCloseupGenerator,
  CinematicDialogueGenerator,
  GroupTwoShotGenerator,
  SilentStareGenerator,
  ReactionGenerator,
  InsertShotGenerator,
  ActionGenerator,
  VeoActionGenerator,
  MontageSequenceGenerator,
  BRollGenerator,
  VoiceoverBRollGenerator,
  TextOverlayCardGenerator,
  BridgeBeatGenerator,
  ShotReverseShotCompiler
} from './beat-generators/index.js';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `[BeatRouter] ${timestamp} [${level}]: ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

// ─────────────────────────────────────────────────────────────────────
// Cost cap (runaway guard only — NOT a billing limit)
// ─────────────────────────────────────────────────────────────────────
// Simplified from tier-based map (free/starter/growth/business/enterprise)
// to a flat $20 ceiling on 2026-04-21. Rationale from the user:
//   1. The platform only exposes 3 product tiers, not 5, so the old map
//      referenced tier names that don't exist in the subscription system.
//   2. The Brand Story feature is gated to the Business tier only — there
//      is no "free episode" to protect with a lower cap.
//   3. The cap's only job is to stop runaway Gemini output from burning
//      through the budget if the screenplay pass goes off the rails. $20
//      comfortably covers a normal 10-15 beat episode with margin.
//
// `resolveCostCap({ episodeOverride })` retains the per-episode override
// path so a director can opt a specific story into a higher ceiling if
// a premium campaign needs it, without re-editing this file.
export const COST_CAP_DEFAULT_USD = 20.00;

export function resolveCostCap({ episodeOverride } = {}) {
  if (typeof episodeOverride === 'number' && episodeOverride > 0) return episodeOverride;
  return COST_CAP_DEFAULT_USD;
}

// ─────────────────────────────────────────────────────────────────────
// V4 ROUTING TABLE (the hardcoded map)
// ─────────────────────────────────────────────────────────────────────

// Name-keyed map used by the Phase 5.3 per-beat generator override. The
// Director Panel exposes these human-readable keys on the beat row; the
// router resolves the key to the actual class at routing time. Keys must
// stay stable — they are persisted on the beat row as `preferred_generator`.
const GENERATOR_NAME_MAP = {
  CinematicDialogueGenerator,
  GroupTwoShotGenerator,
  SilentStareGenerator,
  ReactionGenerator,
  InsertShotGenerator,
  ActionGenerator,
  // 2026-05-01 — Rec 1: Veo 3.1 Standard (Vertex AI, FREE) variant for
  // ACTION_NO_DIALOGUE. Opt-in per-beat via
  // beat.preferred_generator='VeoActionGenerator'. Solves Kling V3 Pro's
  // documented face_drift_in_action (frame 60+) by using Veo's first-frame
  // anchoring + mid-action persona-locked still (Director Agent A1.1).
  // Routing hint in v4-beat-recipes.yaml steers Gemini: use Veo for clean
  // kinetic action ≤8s without complex camera moves; stay on Kling for
  // long single-takes (≥9s) and complex camera grammar (Dutch tilt /
  // anamorphic / vertigo zoom).
  VeoActionGenerator,
  BRollGenerator,
  VoiceoverBRollGenerator,
  TextOverlayCardGenerator,
  MontageSequenceGenerator,
  BridgeBeatGenerator,
  // V4 Phase 5b — N5. IDENTITY-class auto-fix fallback. When a Mode B
  // dialogue beat (Kling Omni → Sync) hard_rejects on identity AND the
  // ref-stack rebuild also fails, the orchestrator routes to OmniHuman 1.5
  // alone (Mode A) by setting beat.preferred_generator='TalkingHeadCloseupGenerator'.
  // Per Video MCP audit, OmniHuman 1.5 has best-in-class single-photo
  // lipsync — a genuine alternative when Kling drifts on persona identity.
  TalkingHeadCloseupGenerator
};

// V4 P4.1 — Routing table is data-first. Each entry can declare:
//   text_rendering_override: false  — beat is EXEMPT from the
//                                     requires_text_rendering Kling V3 Pro
//                                     reroute (see TEXT_OVERRIDE_EXEMPT logic).
//                                     Reason field documents WHY each beat
//                                     opts out.
// Adding a new beat type that needs text-rendering exemption: set the field
// in the routing entry below — no code change required.
const ROUTING = {
  // Mode B primary — Kling O3 Omni → Sync Lipsync v3 chain
  // Speech beats: text override would silently drop dialogue. Speech wins.
  TALKING_HEAD_CLOSEUP: {
    generator: CinematicDialogueGenerator, mode: 'B',
    text_rendering_override: false,
    text_rendering_reason: 'Speech beat — text-override route is silent Kling V3 Pro; would drop dialogue.'
  },
  DIALOGUE_IN_SCENE: {
    generator: CinematicDialogueGenerator, mode: 'B',
    text_rendering_override: false,
    text_rendering_reason: 'Speech beat — text-override route is silent Kling V3 Pro; would drop dialogue.'
  },
  GROUP_DIALOGUE_TWOSHOT: {
    generator: GroupTwoShotGenerator,
    text_rendering_override: false,
    text_rendering_reason: 'Multi-speaker beat — text-override would lose the dialogue track.'
  },

  // Silent / reaction — Kling O3 Omni (for silent stare) or Veo 3.1 (for reaction)
  SILENT_STARE: { generator: SilentStareGenerator },
  REACTION:     { generator: ReactionGenerator },

  // Product hero — Veo 3.1 with first/last frame anchor.
  // Caught 2026-04-11: Gemini flagged a MacBook Pro hero as
  // requires_text_rendering → routed to ActionGenerator → lost the MacBook
  // reference and rendered a generic text-on-screen Kling V3 Pro shot.
  // INSERT_SHOT exists specifically for product-anchor preservation; never
  // override.
  INSERT_SHOT: {
    generator: InsertShotGenerator,
    text_rendering_override: false,
    text_rendering_reason: 'Preserves Veo first-frame product anchor; text-override would drop product reference.'
  },

  // Action / montage — Kling V3 Pro (prompt-first)
  ACTION_NO_DIALOGUE: { generator: ActionGenerator },
  MONTAGE_SEQUENCE:   { generator: MontageSequenceGenerator },  // scene-type, handled separately

  // Atmospheric — Veo 3.1 Standard with native ambient
  B_ROLL_ESTABLISHING: { generator: BRollGenerator },

  // Opt-in voice-over beat — text-override would silence the VO track.
  // Caught 2026-04-21: action-genre run produced a speechless episode
  // because Gemini flagged every VO beat with visible signage as
  // requires_text_rendering, dropping the narration.
  VOICEOVER_OVER_BROLL: {
    generator: VoiceoverBRollGenerator,
    text_rendering_override: false,
    text_rendering_reason: 'VO beat — text-override route is silent; would drop the voice-over track.'
  },

  // V4 Phase 6.1 — narrative bridge beats. Veo 3.1 Standard with
  // first+last-frame anchoring, same free tier as B_ROLL_ESTABLISHING.
  SCENE_BRIDGE: { generator: BridgeBeatGenerator },

  // Post-production (ffmpeg only, no API cost). Already a text-card path —
  // override is meaningless here (it's already the explicit text route).
  TEXT_OVERLAY_CARD: {
    generator: TextOverlayCardGenerator, noApiCost: true,
    text_rendering_override: false,
    text_rendering_reason: 'Already an ffmpeg text-card path — override is a no-op.'
  },
  SPEED_RAMP_TRANSITION: { generator: null, noApiCost: true, assemblerOnly: true }
  // SPEED_RAMP_TRANSITION is applied by the assembler between beats,
  // not generated as its own clip.
};

class BeatRouter {
  /**
   * @param {Object} deps - the same dep bag passed to beat generators
   *   (falServices, tts, ffmpeg)
   */
  constructor(deps = {}) {
    this.deps = deps;
    this.generatorCache = new Map();
  }

  /**
   * Get (and cache) an instance of a generator class with the shared deps.
   */
  _getGenerator(GeneratorClass) {
    if (!GeneratorClass) return null;
    if (!this.generatorCache.has(GeneratorClass)) {
      this.generatorCache.set(GeneratorClass, new GeneratorClass(this.deps));
    }
    return this.generatorCache.get(GeneratorClass);
  }

  /**
   * Pre-flight: validate + expand + cost-cap a scene-graph BEFORE any
   * generation runs.
   *
   * Steps:
   *   1. Expand SHOT_REVERSE_SHOT beats into alternating TALKING_HEAD_CLOSEUP beats
   *   2. Walk every beat, resolve its generator
   *   3. Sum estimated cost + compare against the cap
   *   4. Apply requires_text_rendering override (routes to Kling V3 Pro via ActionGenerator with text-rendering flag)
   *
   * @param {Object} params
   * @param {Object[]} params.scenes - scene_description.scenes[] (mutated in place)
   * @param {number} params.costCapUsd
   * @returns {{expanded: Object[], totalEstimatedCost: number, beatCount: number, withinCap: boolean}}
   */
  preflight({ scenes, costCapUsd, genre = '' }) {
    if (!Array.isArray(scenes)) throw new Error('BeatRouter.preflight: scenes array required');
    if (typeof costCapUsd !== 'number' || costCapUsd <= 0) {
      throw new Error('BeatRouter.preflight: costCapUsd must be a positive number');
    }

    // 1. Expand SHOT_REVERSE_SHOT in every scene
    for (const scene of scenes) {
      if (!Array.isArray(scene.beats)) continue;
      scene.beats = ShotReverseShotCompiler.expandScene(scene.beats);
    }

    // V4 Phase 5b — N3 ref-stack precondition assertion. For commercial
    // stories, every scene the router is about to issue beats for MUST have
    // a non-null `scene_master_url`. Defense-in-depth on top of N1 (which
    // already halts at the orchestrator level if Scene Master generation
    // fails). This guard catches the case where a Scene Master result was
    // dropped between StoryboardHelpers and beat generation.
    const isCommercial = String(genre || '').toLowerCase().trim() === 'commercial';
    const orphanedScenes = isCommercial
      ? scenes.filter(s => !s?.scene_master_url && Array.isArray(s?.beats) && s.beats.length > 0)
      : [];
    if (orphanedScenes.length > 0) {
      // Mark every beat in the orphaned scenes so the orchestrator can route
      // them through Fix 8's auto-fix loop (anchor-class remediation).
      orphanedScenes.forEach(s => {
        s.beats.forEach(b => {
          b.requires_scene_master_remediation = true;
        });
      });
      const ids = orphanedScenes.map(s => s.scene_id || '?').join(', ');
      logger.error(
        `BeatRouter.preflight: ${orphanedScenes.length} commercial scene(s) lack scene_master_url — ` +
        `marking beats as requires_scene_master_remediation. scene_ids=[${ids}]`
      );
    }

    // 2+3. Resolve generators + sum cost
    let totalEstimatedCost = 0;
    let beatCount = 0;

    for (const scene of scenes) {
      if (!Array.isArray(scene.beats)) continue;
      for (const beat of scene.beats) {
        beatCount++;
        const routing = this.route(beat);
        if (!routing) {
          logger.warn(`beat ${beat.beat_id} has unknown type "${beat.type}" — skipping cost estimate`);
          continue;
        }
        if (routing.noApiCost) continue;
        const cost = routing.GeneratorClass.estimateCost
          ? routing.GeneratorClass.estimateCost(beat)
          : 0.50;
        beat.estimated_cost_usd = cost;
        totalEstimatedCost += cost;
      }
    }

    const withinCap = totalEstimatedCost <= costCapUsd;

    logger.info(
      `preflight: ${beatCount} beats, estimated $${totalEstimatedCost.toFixed(2)} vs cap $${costCapUsd.toFixed(2)} — ${withinCap ? 'OK' : 'EXCEEDS CAP'}` +
      (orphanedScenes.length > 0 ? `, ${orphanedScenes.length} commercial scene(s) lack scene_master_url` : '')
    );

    return {
      expanded: scenes,
      totalEstimatedCost,
      beatCount,
      withinCap,
      // V4 Phase 5b — N3. Orchestrator can read this to gate beat generation.
      orphanedSceneCount: orphanedScenes.length,
      orphanedSceneIds: orphanedScenes.map(s => s.scene_id)
    };
  }

  /**
   * Route ONE beat to its generator class.
   *
   * @param {Object} beat
   * @returns {{GeneratorClass: Function, mode?: string, noApiCost?: boolean, assemblerOnly?: boolean} | null}
   */
  route(beat) {
    if (!beat || !beat.type) return null;

    // Phase 5.3 — per-beat generator override (Director Panel integration).
    // When the director explicitly picks a generator on the beat row, honor it
    // before the routing table runs. Restricted to the known generator class
    // names in GENERATOR_NAME_MAP so invalid overrides fall through to the
    // default route rather than crashing with an undefined class.
    if (beat.preferred_generator && GENERATOR_NAME_MAP[beat.preferred_generator]) {
      return {
        GeneratorClass: GENERATOR_NAME_MAP[beat.preferred_generator],
        mode: 'override',
        overriddenFrom: beat.type,
        noApiCost: !!ROUTING[beat.type]?.noApiCost
      };
    }

    // Text-rendering override: any beat with requires_text_rendering: true
    // routes to the Action generator (Kling V3 Pro — best in class text rendering).
    //
    // EXCEPTIONS (these beat types DO NOT honor the override):
    //   - TEXT_OVERLAY_CARD — ffmpeg-rendered, doesn't need a video model at all
    //   - INSERT_SHOT — the subject IS the product, branding is already on
    //     the subject reference image that Veo uses as its first frame. Veo
    //     just animates the existing pixels instead of synthesizing the label
    //     from scratch — which preserves brand text PERFECTLY while keeping
    //     Veo's first/last-frame macro-push-in feel. Sending an INSERT_SHOT
    //     to Kling V3 Pro throws away the subject ref anchor and forces the
    //     model to hallucinate the product from the prompt.
    //   - VOICEOVER_OVER_BROLL / TALKING_HEAD_CLOSEUP / DIALOGUE_IN_SCENE /
    //     GROUP_DIALOGUE_TWOSHOT — ALL speech-bearing beats. The text-override
    //     path doesn't invoke TTS + Sync Lipsync v3 + VO mixing — it just
    //     runs Kling V3 Pro's text-to-video, which produces silent visuals
    //     (Kling's native audio is a 20%-ducked afterthought, NOT a scripted
    //     voice/dialogue track). Routing a speech beat through the override
    //     silently drops the spoken content. If Gemini needs brand text AND
    //     speech on the same beat, the speech wins — we lose the in-frame
    //     text rendering, not the dialogue. Caught 2026-04-21 on the first
    //     Action-genre run: the register (which leans on VO for kinetic
    //     montage) produced a speechless episode because Gemini flagged
    //     every VO beat with visible brand signage as requires_text_rendering.
    //
    // Caught on 2026-04-11 first real V4 run: Gemini flagged a MacBook Pro
    // product hero as requires_text_rendering → routed to ActionGenerator →
    // came out as text-only Kling V3 Pro without the MacBook reference. Fix:
    // let INSERT_SHOT always flow through InsertShotGenerator regardless of
    // the flag. In-scene text (storefront signs, billboards, caption cards)
    // still correctly routes through the override on other beat types.
    // V4 P4.1 — Data-driven text-rendering override. The exempt list is now
    // a per-beat-type field on the ROUTING table (text_rendering_override: false)
    // instead of a hardcoded set. Adding/removing beat types from the exempt
    // list happens in the table, no code change. Default behavior when the
    // field is absent: beat IS subject to override (preserves the original
    // Action/B-roll/etc routing-to-Kling-V3-Pro behavior for in-scene text).
    const routingEntry = ROUTING[beat.type];
    const isExemptFromTextOverride =
      routingEntry && routingEntry.text_rendering_override === false;
    if (beat.requires_text_rendering && !isExemptFromTextOverride) {
      return {
        GeneratorClass: ActionGenerator,
        mode: 'text_override',
        originalType: beat.type
      };
    }

    const entry = ROUTING[beat.type];
    if (!entry) return null;

    // 2026-05-05 — Rec 1 autonomous Veo routing (post-validator).
    //
    // The validator + Doctor pass set `preferred_generator` on NEW screenplays,
    // but legacy/regenerate paths bypass that pass — the beat is loaded from
    // DB and routed with whatever fields it had at write time. Without this
    // auto-route, an action beat regenerated from an episode authored before
    // 2026-05-05 falls through to default ActionGenerator (Kling V3 Pro) and
    // pays the face_drift_in_action tax.
    //
    // Logic: when ACTION_NO_DIALOGUE has no explicit preferred_generator AND
    // the beat fits Veo criteria (per v4-beat-recipes.yaml routing_hint),
    // route to VeoActionGenerator automatically. Beats with complex camera
    // grammar, requires_text_rendering, or duration > 8s stay on Kling.
    //
    // Opt-out: BRAND_STORY_AUTO_VEO_ACTION_ROUTING=false (default true).
    // Director Panel can still force Kling by explicitly setting
    // beat.preferred_generator='ActionGenerator'.
    if (
      beat.type === 'ACTION_NO_DIALOGUE'
      && entry.generator === ActionGenerator
      && !beat.preferred_generator
      && String(process.env.BRAND_STORY_AUTO_VEO_ACTION_ROUTING || 'true').toLowerCase() !== 'false'
    ) {
      const duration = Number(beat.duration_seconds) || 5;
      const requiresTextRendering = beat.requires_text_rendering === true;
      const cameraGrammar = `${beat.camera_move || ''} ${beat.camera_notes || ''}`;
      // Same complex-camera detection vocabulary as ScreenplayValidator's
      // checkPreferredGeneratorRouting. Keep these two in sync — they implement
      // the same routing rule from different sides (validator nudges Gemini at
      // write-time; this auto-routes at read-time for legacy beats).
      const COMPLEX_CAMERA_RX = /\b(dutch|vertigo|anamorphic|whip[-\s]?pan|speed[-_\s]?ramp|lens[-_\s]?flare|crash[-_\s]?zoom)\b/i;
      const hasComplexCamera = COMPLEX_CAMERA_RX.test(cameraGrammar);

      const fitsVeoCriteria =
        duration <= 8 &&
        !requiresTextRendering &&
        !hasComplexCamera;

      if (fitsVeoCriteria) {
        logger.info(`auto-routing beat ${beat.beat_id || '?'} (ACTION_NO_DIALOGUE, ${duration}s, simple camera) to VeoActionGenerator (no preferred_generator set; legacy/regenerate path)`);
        return {
          GeneratorClass: VeoActionGenerator,
          mode: 'auto_veo_routing',
          originalType: beat.type
        };
      }
    }

    return {
      GeneratorClass: entry.generator,
      mode: entry.mode,
      noApiCost: !!entry.noApiCost,
      assemblerOnly: !!entry.assemblerOnly
    };
  }

  /**
   * Generate a single beat through its routed generator.
   *
   * @param {Object} args - forwarded to BaseBeatGenerator.generate()
   * @returns {Promise<Object>}
   */
  async generate(args) {
    const { beat } = args;
    const routing = this.route(beat);
    if (!routing) throw new Error(`BeatRouter.generate: no route for beat type "${beat.type}"`);
    if (routing.assemblerOnly) {
      throw new Error(`BeatRouter.generate: beat type "${beat.type}" is assembler-only, not a standalone generator`);
    }

    const generator = this._getGenerator(routing.GeneratorClass);
    if (!generator) throw new Error(`BeatRouter.generate: generator not available for beat type "${beat.type}"`);

    // Pass routing metadata to the generator in case it needs to adjust
    // behavior (e.g. text-rendering override, Mode A vs Mode B).
    return generator.generate({ ...args, routingMetadata: routing });
  }
}

export default BeatRouter;
export { BeatRouter };
