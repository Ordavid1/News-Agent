// services/v4/director-rubrics/commercialBeatRubric.mjs
//
// V4 Phase 7 — Lens C (Dailies) commercial variant. Replaces prestige
// continuity dimensions (lighting_continuity / lens_continuity / identity_lock)
// with commercial-aware ones (art_direction_consistency / framing_intent /
// identity_lock_stylized) when story.genre === 'commercial'.
//
// What changes vs. prestige Lens C:
//   - lighting_continuity → art_direction_consistency. Commercial work
//     uses intentional lighting shifts (anthemic_epic chiaroscuro,
//     kinetic_montage flash cuts, hand_doodle_animated flat shadow
//     planes). The continuity contract is at the art-direction level
//     (same world / same look / same grammar), not at motivated-key-light
//     level.
//   - lens_continuity → framing_intent. Commercial framing is recipe-
//     driven (anime_eye_zoom, manga_panel_punch_in, speed_ramp_action,
//     stop_motion_dolly). The check is "does the clip honor the named
//     framing recipe", not "does the focal length feel continuous with
//     previous clip's optical character".
//   - identity_lock → identity_lock_stylized. For non-photoreal styles,
//     identity is judged against the stylized character sheet (the
//     persona AS THE SPOT'S DESIGNED CHARACTER), not against a photoreal
//     embedding match.
//
// CRITICAL Phase 5b Fix 8 integration: findings.remediation.target uses
// the same enum as prestige beats (anchor / composition / performance /
// identity / continuity) PLUS Phase 7's `style` extension. Use `style`
// for art-direction drift, palette mismatch, framing-vocab mismatch
// — these are commercial-only failure classes. The auto-fix loop reads
// `target` to decide cheapest re-render path; `style` routes to a
// regrade-LUT or framing-recipe re-roll, not a beat re-render.

import { buildSharedSystemHeader, buildGenreRegisterHint } from './sharedHeader.mjs';
import { buildFramingTaxonomyHint, getVerificationSignature } from '../masterclass/framingTaxonomy.mjs';
import { isStylizedStrong, isNonPhotorealStyle, resolveStyleCategory } from '../CreativeBriefDirector.js';

const COMMERCIAL_LENS_C_BLOCK = `CHECKPOINT C — Commercial Dailies (post-beat, per beat). LENS C — COMMERCIAL. Runs AFTER QC8 deterministic checks pass.

DIMENSIONS TO SCORE (each 0-100). Use these EXACT keys in dimension_scores:
  performance_credibility       — does the expression carry the *intent*, or merely the said-line / said-action? Is the actor "in it" or "posed"?
  lipsync_integrity             — on dialogue beats, do mouth shapes track the audio? (deduct heavily for soft-refusals where mouth is closed during speech). For non-photoreal animated beats, lipsync is judged against the cel-shade convention (mouth shape consistency, not phoneme-level realism). Score 100 for non-dialogue beats.
  eyeline_blocking              — eyelines coherent with off-screen targets implied by Scene Master? Blocking honors 180° rule with previous beat (prestige carries; commercial montage may intentionally break — verify against framing_intent recipe).
  art_direction_consistency     — does this beat feel like part of the same SPOT? same world / same look / same art-direction grammar as prior beats and Scene Master. Intentional lighting shifts (chiaroscuro mood pop, flash cuts, day→night for emotional beat) are FEATURES when the brief asks for them. Penalize accidental drift (a beat that looks lit/graded for a different commercial).
  framing_intent                — if beat.framing was specified (anime_eye_zoom, manga_panel_punch_in, speed_ramp_action, stop_motion_dolly, anamorphic_signature_closeup, etc.), does the clip deliver the named recipe? Verify recipe properties (oval bokeh on anamorphic, 12fps stepping on stop_motion, optical-zoom feel on vintage_zoom_creep).
  camera_move_intent            — if camera_move was specified, does the clip deliver it (push-in actually pushes, whip-pan actually whips)?
  camera_move_motivation        — was the camera move EARNED by the brief's emotional curve? Push-in must be motivated by revelation/intimacy/punchline. Whip-pan must be motivated by surprise/redirection. Dolly-out must be motivated by isolation/release/reveal-of-scale. Lock-offs must declare emotional_hold_reason (control, refusal to flinch, ritual stillness). Cannes-grade commercial benchmark: Sony Bravia "Balls" lock-offs are motivated by gravity-as-spectacle; Apple "1984" hammer-throw push-in is motivated by revolution. Score 0 for unmotivated moves (camera_motivation_reason missing or generic like "make it dynamic"). Score 100 for moves a brand director would recognize as authored. Lock-offs with declared emotional_hold_reason → 100; without → 70 (acceptable but not authored). Distinct from camera_move_intent (delivery) — this grades MOTIVATION.
  identity_lock_stylized        — persona identity matches the COMMITTED CHARACTER SHEET. For photoreal styles → photoreal face match. For non-photoreal styles (hand_doodle_animated, surreal_dreamlike) → match the STYLIZED character sheet (silhouette, hair shape, wardrobe motif, signature accessory). Photoreal embedding match is NOT the bar for cel-shaded characters; the bar is "same designed character".
  model_signature_check         — known model failure modes? Kling V3 Pro action: face drift past frame 60. Veo 3.1 TTS-driven: occasional mouth-static. Sync Lipsync v3: jaw float when audio shorter than clip. Note signature in evidence.
  product_identity_lock         — (Phase 4) when beat carries the brand subject, does the rendered product preserve the SPECIFIC visual identity from uploaded reference + product_signature_features list? Score 100 if no product OR if product_integration_style = hero_showcase / commercial. Drift > 15% on any signature feature → soft_reject.
  product_subtlety              — (Phase 4, INSERT_SHOT only) does the product beat read as Hollywood naturalistic placement OR as cheesy infomercial? Subtle hits add ~12 pts (hand/body in frame, product in motion, off-center brand mark, cinema macro w/ shallow DOF, ≤2s held, LUT continuous, no music swell on appearance, mid-scene not scene-button). Cheesy hits subtract ~12 pts. Score 100 if not INSERT_SHOT OR not product-bearing OR if product_integration_style = hero_showcase / commercial.

WHAT TO LOOK AT FIRST (in order):
  1. THE INTENT LINE — read beat.beat_intent / beat.expression_notes / beat.dialogue subtext. Does the endframe deliver the intent or the literal said-line?
  2. STYLE FIDELITY — does this beat look like it belongs in THIS spot? (commercial_brief.style_category + Scene Master art direction = the world)
  3. IDENTITY (STYLIZED) — does the persona match the designed character (photoreal OR stylized)?
  4. FRAMING RECIPE — if beat.framing was named, did the clip deliver?
  5. PRODUCT (when present) — naturalistic + on-model OR cheesy + drifted?
  6. MODEL SIGNATURE DEFECTS — known failure modes for the routed model.

REMEDIATION TARGET ROUTING (Phase 5b Fix 8 + Phase 7 'style'):
  - Performance / lipsync / eyeline / camera_move issues  → target: "performance"
  - Composition / framing-recipe miss / blocking          → target: "composition"
  - Persona identity drift / character-sheet mismatch     → target: "identity"
  - Cross-shot continuity break (lighting/world)          → target: "continuity"
  - Scene anchor mismatch (beat doesn't fit Scene Master) → target: "anchor"
  - Art-direction drift / palette mismatch / framing-vocab style mismatch / LUT fights brief → target: "style"   ← Phase 7 NEW

DEFER TO QC8 (do NOT re-emit):
  - aspect ratio drift / duration drift / mostly-black / file integrity / face_similarity numeric score

EVIDENCE FORMAT:
  scope = "beat:<beat_id>"
  evidence = specific quote / approximate timecode within the clip / specific element.`;

/**
 * Build the multimodal prompt parts for COMMERCIAL Lens C.
 *
 * @param {Object} params
 * @param {Object} params.beat
 * @param {Object} params.scene
 * @param {Buffer|string} params.endframeImage
 * @param {string} [params.endframeMime='image/jpeg']
 * @param {Buffer|string} [params.midframeImage]
 * @param {string} [params.midframeMime='image/jpeg']
 * @param {Buffer|string} [params.previousEndframeImage]
 * @param {string} [params.previousEndframeMime='image/jpeg']
 * @param {Buffer|string} [params.sceneMasterThumbnail]
 * @param {string} [params.sceneMasterMime='image/jpeg']
 * @param {Array}  params.personas
 * @param {Object} params.commercialBrief
 * @param {Object} [params.routingMetadata]
 * @param {string} [params.storyFocus='commercial']
 * @param {string} [params.productIntegrationStyle='naturalistic_placement']
 * @param {string[]} [params.productSignatureFeatures]
 * @param {string|null} [params.subjectName]
 * @param {boolean} [params.isRetry=false]
 */
export function buildCommercialBeatJudgePrompt({
  beat,
  scene,
  endframeImage,
  endframeMime = 'image/jpeg',
  midframeImage = null,
  midframeMime = 'image/jpeg',
  previousEndframeImage = null,
  previousEndframeMime = 'image/jpeg',
  sceneMasterThumbnail = null,
  sceneMasterMime = 'image/jpeg',
  personas,
  commercialBrief,
  routingMetadata = null,
  storyFocus = 'commercial',
  productIntegrationStyle = 'naturalistic_placement',
  productSignatureFeatures = [],
  subjectName = null,
  isRetry = false
} = {}) {
  const styleCategory = resolveStyleCategory(commercialBrief);
  const stylized = isStylizedStrong(commercialBrief);
  const nonPhoto = isNonPhotorealStyle(commercialBrief);

  const styleHint = stylized
    ? `STYLIZED BEAT: brief.style_category = "${styleCategory}". Identity is judged against the STYLIZED character sheet (same designed character, not photoreal embedding match). Lighting / continuity expectations are art-direction-level, NOT motivated-key-light level. Use target="style" for art-direction or palette drift findings.`
    : nonPhoto
      ? `SEMI-STYLIZED BEAT: brief.style_category = "${styleCategory}". Photoreal identity expected; grade/texture is the style-bearing layer. Use target="style" for grade/palette drift findings.`
      : '';

  const systemPrompt = [
    buildSharedSystemHeader(),
    '',
    COMMERCIAL_LENS_C_BLOCK,
    '',
    buildGenreRegisterHint(storyFocus),
    '',
    styleHint,
    '',
    isRetry
      ? 'NOTE: This is the SECOND attempt at this beat. retry_authorization MUST be false — escalate to user_review on any critical finding.'
      : ''
  ].filter(Boolean).join('\n');

  const userParts = [];
  userParts.push({ text: `<beat>\n${JSON.stringify(beat, null, 2)}\n</beat>` });
  userParts.push({ text: `<scene_context>\n${JSON.stringify({
    scene_id: scene?.scene_id,
    scene_goal: scene?.scene_goal,
    ambient_bed_prompt: scene?.ambient_bed_prompt,
    opposing_intents: scene?.opposing_intents
  }, null, 2)}\n</scene_context>` });
  userParts.push({ text: `<personas>\n${JSON.stringify(personas, null, 2)}\n</personas>` });
  userParts.push({ text: `<commercial_brief>\n${JSON.stringify({
    creative_concept: commercialBrief?.creative_concept,
    visual_signature: commercialBrief?.visual_signature,
    style_category: styleCategory,
    visual_style_brief: commercialBrief?.visual_style_brief
  }, null, 2)}\n</commercial_brief>` });
  if (routingMetadata) {
    userParts.push({ text: `<routing_metadata>\n${JSON.stringify(routingMetadata, null, 2)}\n</routing_metadata>` });
  }

  // V4 P0.3 — FramingTaxonomy threading (commercial variant). Commercial
  // framing is recipe-driven by design (the brief explicitly names recipes
  // like anamorphic_signature_closeup, speed_ramp_action). Surface the
  // taxonomy + pinned recipe verification signature.
  userParts.push({ text: `<framing_taxonomy>\n${buildFramingTaxonomyHint()}\n</framing_taxonomy>` });
  const pinnedFramingId = beat?.framing_intent?.id || beat?.framing?.id || beat?.framing_id || null;
  if (pinnedFramingId) {
    const sig = getVerificationSignature(pinnedFramingId);
    if (sig) {
      userParts.push({ text: `<framing_pinned>\n${sig}\nVerify the rendered clip honors this recipe; deduct heavily from framing_intent / camera_move_intent if it does not.\n</framing_pinned>` });
    }
  }

  userParts.push({ text: `<product_placement_context>\n${JSON.stringify({
    product_integration_style: productIntegrationStyle,
    subject_name: subjectName,
    signature_features: productSignatureFeatures,
    note: 'When integration_style is hero_showcase or commercial, score both product_* dimensions = 100. When the beat does not contain the product, score both = 100. Otherwise score per Lens C rubric guidance.'
  }, null, 2)}\n</product_placement_context>` });

  attachImage(userParts, sceneMasterThumbnail, sceneMasterMime, 'Scene Master (blocking + art-direction reference):');
  attachImage(userParts, previousEndframeImage, previousEndframeMime, 'Previous beat endframe (continuity reference):');
  attachImage(userParts, midframeImage, midframeMime, 'Beat midframe:');
  attachImage(userParts, endframeImage, endframeMime, 'Beat endframe (primary judgment frame):', /* required */ true);

  userParts.push({ text: 'Grade per Commercial Lens C. Output ONLY the verdict JSON.' });

  return { systemPrompt, userParts };
}

function attachImage(parts, image, mime, label, required = false) {
  if (!image) {
    if (required) throw new Error(`buildCommercialBeatJudgePrompt: ${label} image is required`);
    return;
  }
  parts.push({ text: label });
  if (Buffer.isBuffer(image)) {
    parts.push({ inline_data: { mime_type: mime, data: image.toString('base64') } });
  } else if (typeof image === 'string' && image.length > 0) {
    parts.push({ file_data: { file_uri: image, mime_type: mime } });
  }
}

export const COMMERCIAL_BEAT_DIMENSIONS = Object.freeze([
  'performance_credibility', 'lipsync_integrity', 'eyeline_blocking',
  'art_direction_consistency', 'framing_intent', 'camera_move_intent',
  'camera_move_motivation',
  'identity_lock_stylized', 'model_signature_check',
  'product_identity_lock', 'product_subtlety'
]);
