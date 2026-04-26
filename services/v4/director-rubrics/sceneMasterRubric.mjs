// services/v4/director-rubrics/sceneMasterRubric.mjs
//
// Lens B — Look Dev Review. Post-Scene-Master, MULTIMODAL (still + text).
// Judges what no deterministic check can: composition taste, persona fidelity
// vs character sheet, LUT mood fit, 9:16 vertical storytelling discipline,
// directorial interest vs wallpaper.

import { buildSharedSystemHeader, buildGenreRegisterHint } from './sharedHeader.mjs';

const LENS_B_BLOCK = `CHECKPOINT B — Look Dev Review (post-Scene-Master, per scene). LENS B.

DIMENSIONS TO SCORE (each 0-100). Use these EXACT keys in dimension_scores:
  composition                 — focal interest, depth, leading lines, negative space — does the eye know where to land?
  nine_sixteen_storytelling   — genuinely vertical-composed (subject above frame center, foreground/background stacked) or just crop-safed from a 16:9 mindset?
  persona_fidelity            — face / age / wardrobe / hair on-model vs character sheet?
  genre_register_visual       — visual register matches genre (action: handheld feel, urban grit; drama: longer focal length, motivated soft light; etc.)?
  lut_mood_fit                — LUT (named in input) actually delivers the brand-kit + genre mood, or fights it?
  wardrobe_props_credibility  — wardrobe consistent with archetype + scene context? props read?
  directorial_interest        — is there a *choice* here, or is this wallpaper? Would a film school review this still and pause?

WHAT TO LOOK AT FIRST (in order — do not skip):
  1. SQUINT — does composition still read?
  2. FACES — every persona on-model? (deduct heavily; identity drift compounds downstream into every beat in this scene)
  3. LUT MOOD — does the grade match the brand kit + genre register?
  4. 9:16 DISCIPLINE — is the subject placed for vertical, or is it center-square crop-safed?
  5. WARDROBE / PROPS — credible for archetype + scene context?
  6. DIRECTORIAL INTEREST — is there a choice?

DEFER TO LOWER LAYERS (do NOT re-emit):
  - aspect ratio / dimensions (Seedream output guard already enforces 9:16 / 3K)
  - file integrity / corruption (Storage upload validates)

EVIDENCE FORMAT:
  scope = "scene:<scene_id>"
  evidence = specific element ("background extra in upper-third reads modern, breaks period lock", "persona_1 hairline doesn't match character sheet", "warm golden grade fights drama register")`;

/**
 * Build the multimodal prompt parts for Lens B.
 *
 * @param {Object} params
 * @param {Object} params.scene                 - scene record (scene_id, scene_goal, beats, ambient_bed_prompt, etc.)
 * @param {Buffer|string} params.sceneMasterImage - JPG/PNG buffer OR public URL of the Scene Master panel
 * @param {string} [params.sceneMasterMime='image/jpeg']
 * @param {Array}  params.personas              - persona bibles (so judge knows what "on-model" means)
 * @param {string} [params.lutId]               - LUT id picked for this story (or generative LUT id)
 * @param {string} [params.visualStylePrefix]
 * @param {string} [params.storyFocus='drama']
 * @param {boolean} [params.isRetry=false]
 * @returns {{systemPrompt: string, userParts: Array}}
 */
export function buildSceneMasterJudgePrompt({
  scene,
  sceneMasterImage,
  sceneMasterMime = 'image/jpeg',
  personas,
  lutId = null,
  visualStylePrefix = '',
  storyFocus = 'drama',
  isRetry = false
} = {}) {
  const systemPrompt = [
    buildSharedSystemHeader(),
    '',
    LENS_B_BLOCK,
    '',
    buildGenreRegisterHint(storyFocus),
    '',
    isRetry
      ? 'NOTE: This is the SECOND Scene Master attempt for this scene. retry_authorization MUST be false on critical findings — escalate to user_review.'
      : ''
  ].filter(Boolean).join('\n');

  const userParts = [];
  userParts.push({ text: `<scene>\n${JSON.stringify(scene, null, 2)}\n</scene>` });
  userParts.push({ text: `<personas>\n${JSON.stringify(personas, null, 2)}\n</personas>` });
  if (visualStylePrefix) {
    userParts.push({ text: `<visual_style_prefix>${visualStylePrefix}</visual_style_prefix>` });
  }
  if (lutId) {
    userParts.push({ text: `<lut_id>${lutId}</lut_id>` });
  }
  userParts.push({ text: 'Scene Master image:' });

  if (Buffer.isBuffer(sceneMasterImage)) {
    userParts.push({
      inline_data: {
        mime_type: sceneMasterMime,
        data: sceneMasterImage.toString('base64')
      }
    });
  } else if (typeof sceneMasterImage === 'string' && sceneMasterImage.length > 0) {
    // Public URL → file_data (Vertex fetches it server-side)
    userParts.push({
      file_data: {
        file_uri: sceneMasterImage,
        mime_type: sceneMasterMime
      }
    });
  } else {
    throw new Error('buildSceneMasterJudgePrompt: sceneMasterImage required (Buffer or URL string)');
  }

  userParts.push({ text: 'Grade per Lens B. Output ONLY the verdict JSON.' });

  return { systemPrompt, userParts };
}
