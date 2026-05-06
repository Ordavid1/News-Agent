// services/v4/director-rubrics/continuityRubric.mjs
//
// V4 Tier 3.2 — Lens E "Continuity Supervisor" rubric.
//
// Lens E is the LIVE per-beat-pair continuity check that runs BETWEEN
// beat generations (after beat N's Lens C pass, before beat N+1 starts).
// Where Lens C judges singletons, Lens E judges PAIRS — the relationship
// between consecutive beats. Director note (Tier 3.2): "Lens C judges
// singletons; nothing compares beat N to beat N±1."
//
// Cadence: per beat-pair WITHIN the same scene only. Cross-scene
// continuity is owned by Lens F (Editor Agent). When scene_idx changes
// between beats, Lens E does NOT fire.
//
// Inputs (multimodal Gemini):
//   - prev_beat.endframe_url      (image)
//   - current_beat.endframe_url   (image)
//   - prev_beat.dialogue          (text)
//   - current_beat.dialogue       (text)
//   - scene.continuity_sheet      (Tier 2.5 structured ground truth)
//   - current_beat.continuity_chain_broken / endframe_extraction_error / continuity_fallback_reason
//
// Outputs (verdict JSON):
//   - 5-dimension scores (each 0-100):
//       wardrobe, props, lighting_motivation, eyeline, screen_direction
//   - findings + commendations + retry_authorization (standard contract)
//
// Phased rollout:
//   Mode `shadow`   (default) — judge + persist; never block.
//   Mode `blocking`           — soft_reject triggers ONE auto-retry of beat N+1
//                               with continuity-aware prompt deltas.
//   Mode `off`                — skip the call entirely.
//
// Promotion criteria from shadow → blocking (per Director note):
//   ALL of: ≥50 episodes shadow-judged, soft_reject rate within 5–25%,
//   user-override rate <30%. Tracked via DirectorAgent.metrics.lensE.

import { buildSharedSystemHeader } from './sharedHeader.mjs';

const LENS_E_BLOCK = `CHECKPOINT E — Continuity Supervisor (per beat-pair, within-scene only). LENS E. Runs AFTER Lens C accepts beat N, BEFORE beat N+1 starts.

YOU ARE THE SCRIPT SUPERVISOR. Your job is to compare beat N to beat N+1 and catch the defects that destroy the chain:
  - prop continuity (coffee cup vanishes between beats)
  - wardrobe continuity (jacket on/off, hair state, accessories)
  - lighting motivation (key direction, color temperature, hour of day)
  - eyeline match (where character looked → where the next beat reveals)
  - screen direction (frame-right exit → frame-left enter, or deliberate break)

DIMENSIONS TO SCORE (each 0-100). Use these EXACT keys in dimension_scores:
  wardrobe              — costume / hair / accessories continuous between the two endframes? Read <continuity_sheet> for ground truth — wardrobe_state describes what each actor SHOULD be wearing. Deduct heavily for visible drift (a tie that disappears, hair length change).
  props                 — props_in_hand from <continuity_sheet> still in the right hand of the right actor in beat N+1? An actor who held a laptop at end of beat N MUST still hold it at start of N+1 unless beat N+1's prompt explicitly shows them setting it down. Phantom props or vanishing props = critical.
  lighting_motivation   — lighting_key_direction continuous from <continuity_sheet>? Color temperature continuous from prev endframe? A "window_left" key that becomes "overhead practical" mid-scene without motivation = critical.
  eyeline               — character looked toward off-screen target in beat N → does beat N+1 reveal that target on the implied screen-direction? OR if both beats are reverse coverage of dialogue, do the eyelines INVERT (left→right and right→left) per the 180° rule?
  screen_direction      — moving subject exits frame-right at beat N's end → enters beat N+1 from frame-left (per direction-of-travel convention)? Deliberate breaks (per beat.cross_line_intent) are exempt — score 100.

OUTPUT VERDICT:
  pass             — all 5 dimensions ≥ 75
  pass_with_notes  — at least one dimension 50-74 with corrective note
  soft_reject      — at least one dimension < 50 (auto-retry of beat N+1 in blocking mode)
  hard_reject      — multiple critical defects OR continuity_chain_broken=true on beat N AND no compensation in beat N+1

EVIDENCE FORMAT:
  scope = "beat:<beat_n_plus_1_id>" — the verdict targets the beat that BREAKS the chain (so it's the regen target).
  evidence = specific anchor: "actor 0 holds laptop at end of beat s2b1 — vanished in s2b2 endframe" / "lighting key window_left → overhead unmotivated".

DEFER TO Lens C (do NOT re-emit):
  - performance credibility within a beat
  - lipsync within a beat
  - identity lock within a beat
  - per-beat camera move motivation`;

/**
 * Build the multimodal prompt for Lens E continuity judgment.
 *
 * @param {Object} params
 * @param {Object} params.prevBeat
 * @param {Object} params.currentBeat
 * @param {Object} params.scene
 * @param {Buffer|string} params.prevEndframeImage
 * @param {string} [params.prevEndframeMime='image/jpeg']
 * @param {Buffer|string} params.currentEndframeImage
 * @param {string} [params.currentEndframeMime='image/jpeg']
 * @param {Object} [params.continuitySheetSnapshot]  - Tier 2.5 structured ground truth
 * @param {boolean} [params.isRetry=false]
 * @returns {{systemPrompt: string, userParts: Array}}
 */
export function buildContinuityJudgePrompt({
  prevBeat,
  currentBeat,
  scene,
  prevEndframeImage,
  prevEndframeMime = 'image/jpeg',
  currentEndframeImage,
  currentEndframeMime = 'image/jpeg',
  continuitySheetSnapshot = null,
  isRetry = false
} = {}) {
  const systemPrompt = [
    buildSharedSystemHeader(),
    '',
    LENS_E_BLOCK,
    '',
    isRetry
      ? 'NOTE: This is the SECOND attempt at this beat-pair. retry_authorization MUST be false.'
      : ''
  ].filter(Boolean).join('\n');

  const userParts = [];
  userParts.push({ text: `<previous_beat>\n${JSON.stringify({
    beat_id: prevBeat?.beat_id,
    type: prevBeat?.type,
    dialogue: prevBeat?.dialogue || null,
    coverage_slot: prevBeat?.coverage_slot || null,
    motion_vector: prevBeat?.motion_vector || null,
    continuity_chain_broken: prevBeat?.continuity_chain_broken === true,
    endframe_extraction_error: prevBeat?.endframe_extraction_error || null
  }, null, 2)}\n</previous_beat>` });
  userParts.push({ text: `<current_beat>\n${JSON.stringify({
    beat_id: currentBeat?.beat_id,
    type: currentBeat?.type,
    dialogue: currentBeat?.dialogue || null,
    coverage_slot: currentBeat?.coverage_slot || null,
    motion_vector: currentBeat?.motion_vector || null,
    continuity_fallback_reason: currentBeat?.continuity_fallback_reason || null,
    continuity_chain_broken: currentBeat?.continuity_chain_broken === true
  }, null, 2)}\n</current_beat>` });
  userParts.push({ text: `<scene_context>\n${JSON.stringify({
    scene_id: scene?.scene_id,
    location: scene?.location || null,
    location_id: scene?.location_id || null
  }, null, 2)}\n</scene_context>` });
  if (continuitySheetSnapshot) {
    userParts.push({ text: `<continuity_sheet>\n${JSON.stringify(continuitySheetSnapshot, null, 2)}\n</continuity_sheet>` });
  }

  // Attach the two endframes — required.
  attachImage(userParts, prevEndframeImage, prevEndframeMime, 'Previous beat endframe:', /* required */ true);
  attachImage(userParts, currentEndframeImage, currentEndframeMime, 'Current beat endframe:', /* required */ true);

  userParts.push({ text: 'Grade per Lens E. Output ONLY the verdict JSON.' });

  return { systemPrompt, userParts };
}

function attachImage(parts, image, mime, label, required = false) {
  if (!image) {
    if (required) throw new Error(`buildContinuityJudgePrompt: ${label} image is required`);
    return;
  }
  parts.push({ text: label });
  if (Buffer.isBuffer(image)) {
    parts.push({ inline_data: { mime_type: mime, data: image.toString('base64') } });
  } else if (typeof image === 'string' && image.length > 0) {
    parts.push({ file_data: { file_uri: image, mime_type: mime } });
  }
}

export default { buildContinuityJudgePrompt };
