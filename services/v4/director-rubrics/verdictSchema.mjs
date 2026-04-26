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
//   - `additionalProperties: false` is supported but discouraged for
//     forward compat — we use `propertyOrdering` instead where it helps.
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
// One schema, four checkpoints. The `checkpoint` enum value differs per
// invocation but the verdict shape is uniform.

const SEVERITY_ENUM = ['critical', 'warning', 'note'];
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

function buildSchema(checkpointValue) {
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
      dimension_scores: {
        type: 'object',
        description: 'Object keyed by dimension name from the lens rubric. Each value is an integer 0-100.'
        // dynamic keys — we don't enumerate per checkpoint to keep one schema,
        // the lens prompt names the expected dimensions.
      },
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
              propertyOrdering: ['action', 'prompt_delta', 'target_fields'],
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
      judge_model: { type: 'string' },
      latency_ms: { type: 'integer' },
      cost_usd: { type: 'number' }
    }
  };
}

export const SCREENPLAY_VERDICT_SCHEMA = buildSchema('screenplay');
export const SCENE_MASTER_VERDICT_SCHEMA = buildSchema('scene_master');
export const BEAT_VERDICT_SCHEMA = buildSchema('beat');
export const EPISODE_VERDICT_SCHEMA = buildSchema('episode');

export const VERDICT_ENUMS = Object.freeze({
  verdict: VERDICT_ENUM,
  severity: SEVERITY_ENUM,
  action: ACTION_ENUM
});
