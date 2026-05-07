// services/v4/director-rubrics/verdictSchema.mjs
//
// Mechanical enforcement of the §7 verdict contract from the
// branded-film-director agent. Passed to Vertex AI Gemini as
// `generationConfig.responseSchema`. Vertex rejects outputs that deviate
// from this schema, so the model cannot rename `findings` → `issues`,
// invent enum values like "REVISE", or emit numeric finding ids.
//
// Schema dialect: Vertex AI's subset of OpenAPI 3 / JSON Schema. Notable
// constraints (vs. full JSON Schema):
//   - `type` must be a single string, not array (no nullable via type).
//   - `enum` is supported on string properties.
//   - `additionalProperties: false` (boolean) is supported and reliably
//     enforced by Vertex AI. Use it on objects with known key sets.
//     `additionalProperties: { type: 'integer' }` (schema-value form) is
//     NOT reliably enforced — Vertex AI intermittently ignores it, causing
//     the model to emit verbose prose values and exhaust the token budget.
//   - `minimum` / `maximum` supported on number.
//   - `required` array supported.
//   - `propertyOrdering` (Vertex extension, NOT standard JSON Schema) is
//     REQUIRED for reliable structured output on Gemini 3. Without it the
//     model must explore all possible property orderings during generation,
//     consuming extra structured-output planning tokens and producing
//     inconsistent field ordering. Every `type: 'object'` node in this
//     schema includes `propertyOrdering` listing its properties in the
//     exact order the model should emit them.
//
// Four checkpoints, four schemas. Each schema enumerates its lens-specific
// dimension_scores keys explicitly (additionalProperties: false) so Vertex AI
// cannot emit verbose prose values. Dimension keys match the rubric files.

// V4 P0.1 — single source of truth at services/v4/severity.mjs. The Vertex AI
// responseSchema below references SEVERITY_ENUM directly, so we keep the same
// name as a re-export of SEVERITY_LEVELS for back-compat with the schema lookup.
import { SEVERITY_LEVELS } from '../severity.mjs';
const SEVERITY_ENUM = SEVERITY_LEVELS;
const VERDICT_ENUM = ['pass', 'pass_with_notes', 'soft_reject', 'hard_reject'];
const ACTION_ENUM = [
  'regenerate_beat',
  'regenerate_scene_master',
  'rewrite_dialogue',
  'rewrite_subtext',
  'regrade_lut',
  'remix_music',
  'reassemble',
  'user_review'
];

function buildDimensionScoresSchema(dimensionKeys) {
  return {
    type: 'object',
    propertyOrdering: dimensionKeys,
    additionalProperties: false,
    properties: Object.fromEntries(
      dimensionKeys.map(k => [k, { type: 'integer', minimum: 0, maximum: 100 }])
    )
  };
}

function buildSchema(checkpointValue, dimensionKeys) {
  return {
    type: 'object',
    // propertyOrdering tells Vertex the exact sequence to emit fields.
    // Required fields come first (matching the `required` array order),
    // optional metadata fields last. Must match the order described in
    // sharedHeader.mjs's VERDICT_CONTRACT_REMINDER LENGTH DISCIPLINE block.
    propertyOrdering: [
      'checkpoint',
      'verdict',
      'overall_score',
      'dimension_scores',
      'findings',
      'commendations',
      'retry_authorization',
      // V4 Phase 11 (2026-05-07) — scoped retake. When findings have
      // beat-level scope, the model populates target_beats with the
      // unique beat_ids so the Director Panel can surface a "Retake N
      // flagged beats" affordance (existing single-beat regenerate
      // endpoint already supports this). OPTIONAL — Lens A/B/C verdicts
      // typically don't need it; Lens D / commercial Lens D need it most.
      'target_beats',
      'judge_model',
      'latency_ms',
      'cost_usd'
    ],
    required: [
      'checkpoint',
      'verdict',
      'overall_score',
      'dimension_scores',
      'findings',
      'commendations',
      'retry_authorization'
    ],
    properties: {
      checkpoint: {
        type: 'string',
        enum: [checkpointValue]
      },
      verdict: {
        type: 'string',
        enum: VERDICT_ENUM,
        description: 'Exactly one of: pass, pass_with_notes, soft_reject, hard_reject.'
      },
      overall_score: {
        type: 'integer',
        minimum: 0,
        maximum: 100
      },
      dimension_scores: buildDimensionScoresSchema(dimensionKeys),
      findings: {
        type: 'array',
        // CAP: at most 3 findings. Vertex AI validates maxItems/maxLength post-hoc
        // (NOT during token generation) — the model must self-limit. Three findings
        // is the directorial minimum for actionable feedback; if > 3 critical defects
        // exist, emit hard_reject and pick the 3 worst. More than 3 findings causes
        // the visible token count to exceed the generation budget, truncating the JSON.
        maxItems: 3,
        items: {
          type: 'object',
          propertyOrdering: ['id', 'severity', 'scope', 'message', 'evidence', 'remediation'],
          required: ['id', 'severity', 'scope', 'message', 'evidence', 'remediation'],
          properties: {
            id: {
              type: 'string',
              maxLength: 40,
              description: 'snake_case defect descriptor, e.g. cliffhanger_lacks_sting. NOT issue numbers like I1.'
            },
            severity: {
              type: 'string',
              enum: SEVERITY_ENUM
            },
            scope: {
              type: 'string',
              maxLength: 30,
              description: 'episode | scene:<scene_id> | beat:<beat_id>'
            },
            message: {
              type: 'string',
              maxLength: 120,
              description: 'One punchy sentence. No preamble or elaboration.'
            },
            evidence: {
              type: 'string',
              maxLength: 80,
              description: 'One concrete citation: beat_id, scene_id, timecode, or quoted element.'
            },
            remediation: {
              type: 'object',
              propertyOrdering: ['action', 'prompt_delta', 'target_fields', 'target'],
              required: ['action', 'prompt_delta', 'target_fields'],
              properties: {
                action: {
                  type: 'string',
                  enum: ACTION_ENUM
                },
                prompt_delta: {
                  type: 'string',
                  maxLength: 120,
                  description: 'Generator-actionable exact words only. Splice directly into a Kling/Veo/Seedream prompt.'
                },
                target_fields: {
                  type: 'array',
                  maxItems: 3,
                  items: { type: 'string', maxLength: 40 }
                },
                // V4 Phase 5b — Fix 8. 5-category remediation taxonomy. The
                // Director Agent classifies each finding's cheapest re-render
                // path so the orchestrator knows whether to re-render the
                // Scene Master (anchor), the single beat (composition /
                // performance / continuity), or rebuild ref-stack and
                // potentially re-route to a fallback model (identity).
                //
                // V4 Phase 7 extends with `style` for commercial-genre beats:
                // art-direction drift, LUT mismatch, framing-vocab style
                // mismatch. For non-photoreal commercial styles this replaces
                // `continuity` (lighting_continuity is meaningless when art
                // direction itself is the continuity contract).
                target: {
                  type: 'string',
                  // V4 Phase 11 (2026-05-07) — `prop_continuity` promoted to
                  // first-class target. Distinguishes "props vanished / moved
                  // between cuts" from generic continuity drift (lighting,
                  // wardrobe, eyeline). The Director Panel can surface a
                  // dedicated "Prop continuity flag" badge instead of the
                  // generic continuity catch-all.
                  enum: ['anchor', 'composition', 'performance', 'identity', 'continuity', 'prop_continuity', 'style']
                }
              }
            }
          }
        }
      },
      commendations: {
        type: 'array',
        description: 'Minimum 1, max 2. What is working. Each item is one short clause ≤ 100 chars.',
        items: { type: 'string', maxLength: 100 },
        minItems: 1,
        maxItems: 2
      },
      retry_authorization: {
        type: 'boolean',
        description: 'true = caller may auto-retry once with the prompt_deltas above; false = escalate to user.'
      },
      // V4 Phase 11 (2026-05-07) — scoped retake target list. When findings
      // identify specific beats by scope ("beat:s2b3"), populate this array
      // with the unique beat_ids so the orchestrator / Director Panel can
      // re-render only the offending beats instead of the whole episode.
      // Most useful on Lens D (Picture Lock) where a 30-60s commercial would
      // otherwise need full regeneration on a single bad beat. Empty array
      // means no scoped retakes — the verdict is global / structural.
      target_beats: {
        type: 'array',
        description: 'Unique beat_ids referenced in findings whose scope == "beat:<id>". Empty when verdict is global. The Director Panel surfaces this as a "retake N flagged beats" affordance.',
        maxItems: 8,
        items: {
          type: 'string',
          maxLength: 40
        }
      },
      judge_model: { type: 'string' },
      latency_ms: { type: 'integer' },
      cost_usd: { type: 'number' }
    }
  };
}

export const SCREENPLAY_VERDICT_SCHEMA = buildSchema('screenplay', [
  'story_spine', 'character_voice', 'dialogue_craft', 'subtext_density',
  'scene_structure', 'escalation', 'genre_fidelity', 'sonic_world_coherence', 'cliffhanger'
]);

export const SCENE_MASTER_VERDICT_SCHEMA = buildSchema('scene_master', [
  'composition', 'nine_sixteen_storytelling', 'persona_fidelity',
  'genre_register_visual', 'lut_mood_fit', 'wardrobe_props_credibility', 'directorial_interest'
]);

export const BEAT_VERDICT_SCHEMA = buildSchema('beat', [
  'performance_credibility', 'lipsync_integrity', 'eyeline_blocking',
  'lighting_continuity', 'lens_continuity', 'camera_move_intent',
  // Director Agent verdict 2026-05-01 — Rec 4: motivated camera grammar is
  // separate from delivery. camera_move_intent grades "did the push-in
  // actually push?" (delivery). camera_move_motivation grades "should there
  // have been a push-in at all?" (Phantom Thread textbook — every move
  // motivated by character interiority). The rubric flagged this as the
  // single biggest Higgsfield-gap closer. Score 100 on locked beats with
  // declared emotional_hold_reason.
  'camera_move_motivation',
  'identity_lock', 'model_signature_check',
  // Phase 4 — natural product placement guardrails. These dimensions are
  // scored 100 (N/A pass-through) when the beat is not product-bearing
  // OR when product_integration_style is hero_showcase / commercial.
  'product_identity_lock', 'product_subtlety'
]);

export const EPISODE_VERDICT_SCHEMA = buildSchema('episode', [
  'rhythm', 'music_dialogue_ducking_feel', 'sonic_continuity',
  'lut_consistency_cross_scene', 'transition_intent', 'subtitle_legibility_taste',
  'title_endcard_taste', 'cross_scene_continuity', 'cliffhanger_sting',
  // Director Agent verdict 2026-05-01 — Rec 3 Phase A: 6 audio dimensions
  // make the SonicSeriesBible enforceable from the grading side. Without
  // these, the bible is a contract that nothing measures. The first 4 grade
  // the unified-mix architecture (if/when Phase B ships); the last 2
  // enforce the bible's load-bearing invariants (spectral_anchor presence
  // + no-fly-list absence) regardless of Phase B status.
  'audio_coherence_episode',
  'dB_consistency_inter_beat',
  'sfx_motivation_coherence',
  'sound_design_intent_match',
  'spectral_anchor_adherence',
  'no_fly_list_violations'
]);

// Phase 6 — COMMERCIAL genre verdict schemas (replaces Lens A and Lens D for
// stories whose genre == 'commercial'). The Lens 0 brief verdict shares the
// same dimension set as Lens A (commercial) — one rubric across pre-screenplay
// brief AND assembled spot.
export const COMMERCIAL_BRIEF_VERDICT_SCHEMA = buildSchema('commercial_brief', [
  'creative_bravery', 'brand_recall', 'story_compression', 'visual_signature',
  'hook_first_1_5s', 'music_visual_sync', 'tagline_landing', 'product_role'
]);
export const COMMERCIAL_EPISODE_VERDICT_SCHEMA = buildSchema('commercial_episode', [
  'creative_bravery', 'brand_recall', 'story_compression', 'visual_signature',
  'hook_first_1_5s', 'music_visual_sync', 'tagline_landing', 'product_role'
]);

// V4 Phase 7 — full commercial Director ladder: Lens A (screenplay), Lens B
// (scene master), and Lens C (beat) commercial-specific rubrics. These
// replace the prestige equivalents when story.genre === 'commercial'. The
// dimensions are calibrated for commercial work (visual_signature_consistency,
// hook_first_1_5s, style_category_fidelity, etc.) instead of the prestige
// continuity grammar (genre_register_visual, lighting_continuity, etc.) that
// the standard rubrics use.
//
// commercialBeatRubric carries Phase 5b's `target` enum on findings with the
// new `style` value enabled — see remediation.target enum above.
export const COMMERCIAL_SCREENPLAY_VERDICT_SCHEMA = buildSchema('commercial_screenplay', [
  'creative_concept_clarity', 'visual_signature_strength', 'hook_first_1_5s',
  'story_compression', 'tagline_landing_setup', 'product_role',
  'style_category_fidelity', 'anti_brief_adherence'
]);

export const COMMERCIAL_SCENE_MASTER_VERDICT_SCHEMA = buildSchema('commercial_scene_master', [
  'composition', 'nine_sixteen_storytelling', 'persona_fidelity',
  'style_category_fidelity', 'style_palette_fit',
  'wardrobe_props_credibility', 'directorial_interest', 'visual_signature_consistency'
]);

export const COMMERCIAL_BEAT_VERDICT_SCHEMA = buildSchema('commercial_beat', [
  'performance_credibility', 'lipsync_integrity', 'eyeline_blocking',
  'art_direction_consistency', 'framing_intent', 'camera_move_intent',
  // Director Agent verdict 2026-05-01 — Rec 4: motivated camera grammar
  // applies to commercial work too. Phantom Thread / Sicario / The Bear
  // commercial beats are recognized by their camera authorship — every
  // dolly is justified by the brief's emotional curve.
  'camera_move_motivation',
  'identity_lock_stylized', 'model_signature_check',
  'product_identity_lock', 'product_subtlety'
]);

// V4 Tier 3.2 (2026-05-06) — Lens E Continuity Supervisor verdict schema.
// 5 dimensions: wardrobe / props / lighting_motivation / eyeline / screen_direction.
// Same shape contract as the other lenses (verdict + dimension_scores +
// findings + commendations + retry_authorization + judge_model + latency).
export const CONTINUITY_VERDICT_SCHEMA = buildSchema('continuity', [
  'wardrobe', 'props', 'lighting_motivation', 'eyeline', 'screen_direction'
]);

// V4 Tier 3.5 (2026-05-06) — Lens F Editor Agent verdict schema.
// Authorized to emit a structured Edit Decision List (EDL) on the assembled
// rough cut. Dimensions evaluate the CUT, not individual beats:
//   - pace_per_act (does the cut breathe at the right rate per movement)
//   - bridge_quality (do scene-to-scene transitions land)
//   - rhythm_variation (avoid mechanical "every beat is 4s" feel)
//   - dialogue_landing (do exchange beats land their punctuation)
//   - cliffhanger_sting (does the final beat earn its end card)
// EDL itself lives on the verdict's `edl` field (added below).
export const ROUGH_CUT_EDL_SCHEMA = (() => {
  const base = buildSchema('rough_cut', [
    'pace_per_act', 'bridge_quality', 'rhythm_variation', 'dialogue_landing', 'cliffhanger_sting'
  ]);
  // Extend with the EDL field — the editor's authored cut decisions.
  base.properties.edl = {
    type: 'object',
    description: 'Edit Decision List authored by Lens F. Applied in PostProduction stage 2.5 before the LUT.',
    additionalProperties: false,
    propertyOrdering: ['drop_beat', 'swap_beats', 'retime_beat', 'j_cut_audio'],
    properties: {
      drop_beat: {
        type: 'array',
        description: 'Beat ids to drop from the final cut (do not earn their runtime).',
        items: { type: 'string' },
        maxItems: 4
      },
      swap_beats: {
        type: 'array',
        description: 'Pairs of beat ids to swap order in the final assembly.',
        items: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 2
        },
        maxItems: 3
      },
      retime_beat: {
        type: 'array',
        description: 'Per-beat ±0.5s retime nudges to tighten / loosen the cut.',
        items: {
          type: 'object',
          additionalProperties: false,
          propertyOrdering: ['beat_id', 'delta_seconds'],
          properties: {
            beat_id: { type: 'string' },
            delta_seconds: { type: 'number', minimum: -0.5, maximum: 0.5 }
          }
        },
        maxItems: 6
      },
      j_cut_audio: {
        type: 'array',
        description: 'Audio of beat N+1 starts under beat N tail (J-cut). lead_seconds is how far before the cut the audio enters.',
        items: {
          type: 'object',
          additionalProperties: false,
          propertyOrdering: ['from_beat', 'into_beat', 'lead_seconds'],
          properties: {
            from_beat: { type: 'string' },
            into_beat: { type: 'string' },
            lead_seconds: { type: 'number', minimum: 0.1, maximum: 1.5 }
          }
        },
        maxItems: 4
      }
    }
  };
  return base;
})();

export const VERDICT_ENUMS = Object.freeze({
  verdict: VERDICT_ENUM,
  severity: SEVERITY_ENUM,
  action: ACTION_ENUM
});

// 2026-05-05 — Aleph Rec 2 Phase 3 hard-gate schema. NOT part of the §7
// verdict contract. Single-dimension Vertex Gemini call that judges
// whether a stylized frame preserves the persona's CIP identity. Used by
// AlephEnhancementOrchestrator after gen4_aleph stylization to decide
// whether to ship the stylized output (pass at 85+) or discard and ship
// the original (Director Agent A2.2 amendment hard gate).
//
// Tiny schema = tiny token budget = fast verdict (~10-30s vs 60-120s for
// full Lens C). The orchestrator runs this 1-3 times against representative
// stylized frames and averages the scores.
export const POST_STYLIZATION_IDENTITY_SCHEMA = {
  type: 'object',
  required: ['identity_lock_score', 'pass', 'reasoning'],
  propertyOrdering: ['identity_lock_score', 'pass', 'reasoning'],
  additionalProperties: false,
  properties: {
    identity_lock_score: {
      type: 'integer',
      minimum: 0,
      maximum: 100,
      description: 'How well does the stylized face preserve the reference persona\'s bone geometry, eye spacing, nose/jawline/lip shape, brow arch? 100=perfect, 85+=acceptable, <85=identity drift.'
    },
    pass: {
      type: 'boolean',
      description: 'true when score >= 85; false otherwise. Hard gate boundary per Director Agent A2.2.'
    },
    reasoning: {
      type: 'string',
      maxLength: 200,
      description: 'One sentence — what facial features match or drift. No preamble.'
    }
  }
};
