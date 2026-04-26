// services/v4/director-rubrics/beatRubric.mjs
//
// Lens C — Dailies. Post-beat, MULTIMODAL (endframe + optional midframe + text).
// Runs AFTER QC8 deterministic gate. QC8 already caught aspect drift, duration
// drift, mostly-black, face-similarity. Lens C catches what only a director's
// eye catches: flat performance on a credible-looking line, eyeline that breaks
// blocking, lighting that drifted from previous endframe, identity lock as
// performance not just face match, model-specific failure signatures.

import { buildSharedSystemHeader, buildGenreRegisterHint } from './sharedHeader.mjs';

const LENS_C_BLOCK = `CHECKPOINT C — Dailies (post-beat, per beat). LENS C. Runs AFTER QC8 deterministic checks pass.

DIMENSIONS TO SCORE (each 0-100). Use these EXACT keys in dimension_scores:
  performance_credibility   — does the expression carry the *subtext*, or merely the said-line? Is the actor "in it" or "posed"?
  lipsync_integrity         — on dialogue beats, do mouth shapes track the audio? (deduct heavily for soft-refusals where mouth is closed during speech)
  eyeline_blocking          — eyelines coherent with off-screen targets implied by Scene Master? blocking honors 180° rule with previous beat?
  lighting_continuity       — direction, color temp, intensity continuous from previous endframe? (fluorescent → tungsten mid-scene without motivation = fail)
  lens_continuity           — focal length and depth-of-field feel continuous within scene?
  camera_move_intent        — if camera_move was specified in beat metadata, does the clip deliver it (push-in actually pushes, whip-pan actually whips)?
  identity_lock             — persona face matches character sheet across the full clip, not just first frame?
  model_signature_check     — known model failure modes present? Kling V3 Pro action: face drift past frame 60. Veo 3.1 TTS-driven: occasional mouth-static. Sync Lipsync v3: jaw float when audio shorter than clip. Note signature in evidence.

WHAT TO LOOK AT FIRST (in order):
  1. THE SUBTEXT LINE — read beat.subtext, look at the endframe expression. If the face is "saying" the said-line instead of the subtext, the beat failed the Dialogue Masterclass.
  2. IDENTITY LOCK — does the face match the character sheet (provided in personas array)?
  3. CONTINUITY FROM PREVIOUS ENDFRAME (if provided) — lighting direction, color temp, lens feel.
  4. EYELINE — where are they looking? does it match Scene Master's implied geography?
  5. MODEL SIGNATURE DEFECTS — known failure modes for the routed model.

BEAT-TYPE SCORING GUIDANCE:
  For B_ROLL / INSERT_SHOT / ACTION_NO_DIALOGUE / REACTION beats (no dialogue, often no face):
    - performance_credibility: score 100 if motion/composition is dynamic and on-brief; it's a visual performance, not an actor performance.
    - lipsync_integrity: score 100 (N/A — no spoken audio). Do NOT penalize.
    - Weight the remaining 6 dimensions evenly. A well-composed, correctly-routed visual beat should score 80+.
  For TALKING_HEAD_CLOSEUP / DIALOGUE_IN_SCENE / SHOT_REVERSE_SHOT / VOICEOVER_OVER_BROLL beats (dialogue present):
    - All 8 dimensions apply. Weight performance_credibility and lipsync_integrity most heavily.

DEFER TO QC8 (do NOT re-emit):
  - aspect ratio drift
  - duration drift
  - mostly-black soft-refusal
  - file/buffer integrity
  - face_similarity numeric score (QC8 face-embedding sidecar owns this — but you may emit "performance contradicts character bible" findings even when face matches)

EVIDENCE FORMAT:
  scope = "beat:<beat_id>"
  evidence = specific quote / approximate timecode within the clip ("~3.2s: jaw drifts off audio") / specific element ("eyes drift screen-right but Scene Master implies subject is screen-left").`;

/**
 * Build the multimodal prompt parts for Lens C.
 *
 * @param {Object} params
 * @param {Object} params.beat                  - beat record (beat_id, type, dialogue, subtext, expression_notes, camera_move, persona_index, etc.)
 * @param {Object} params.scene                 - parent scene (scene_id, scene_goal, ambient_bed_prompt)
 * @param {Buffer|string} params.endframeImage  - JPG buffer OR URL of the beat's last frame
 * @param {string} [params.endframeMime='image/jpeg']
 * @param {Buffer|string} [params.midframeImage] - optional midframe JPG (recommended for SHOT_REVERSE_SHOT or longer beats)
 * @param {string} [params.midframeMime='image/jpeg']
 * @param {Buffer|string} [params.previousEndframeImage] - optional previous beat's endframe for continuity check
 * @param {string} [params.previousEndframeMime='image/jpeg']
 * @param {Buffer|string} [params.sceneMasterThumbnail] - optional Scene Master thumbnail for blocking reference
 * @param {string} [params.sceneMasterMime='image/jpeg']
 * @param {Array}  params.personas              - persona bibles (with character sheet URLs)
 * @param {Object} [params.routingMetadata]     - { modelUsed, syncPass, fallbackTier } from generator
 * @param {string} [params.storyFocus='drama']
 * @param {boolean} [params.isRetry=false]
 * @returns {{systemPrompt: string, userParts: Array}}
 */
export function buildBeatJudgePrompt({
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
  routingMetadata = null,
  storyFocus = 'drama',
  isRetry = false
} = {}) {
  const systemPrompt = [
    buildSharedSystemHeader(),
    '',
    LENS_C_BLOCK,
    '',
    buildGenreRegisterHint(storyFocus),
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
  if (routingMetadata) {
    userParts.push({ text: `<routing_metadata>\n${JSON.stringify(routingMetadata, null, 2)}\n</routing_metadata>` });
  }

  attachImage(userParts, sceneMasterThumbnail, sceneMasterMime, 'Scene Master (blocking reference):');
  attachImage(userParts, previousEndframeImage, previousEndframeMime, 'Previous beat endframe (continuity reference):');
  attachImage(userParts, midframeImage, midframeMime, 'Beat midframe:');
  attachImage(userParts, endframeImage, endframeMime, 'Beat endframe (primary judgment frame):', /* required */ true);

  userParts.push({ text: 'Grade per Lens C. Output ONLY the verdict JSON.' });

  return { systemPrompt, userParts };
}

function attachImage(parts, image, mime, label, required = false) {
  if (!image) {
    if (required) throw new Error(`buildBeatJudgePrompt: ${label} image is required`);
    return;
  }
  parts.push({ text: label });
  if (Buffer.isBuffer(image)) {
    parts.push({ inline_data: { mime_type: mime, data: image.toString('base64') } });
  } else if (typeof image === 'string' && image.length > 0) {
    parts.push({ file_data: { file_uri: image, mime_type: mime } });
  }
}
