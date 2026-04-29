// services/v4/director-rubrics/commercialSceneMasterRubric.mjs
//
// V4 Phase 7 — Lens B (Look Dev Review) commercial variant. Replaces the
// prestige Scene Master rubric (genre_register_visual / lut_mood_fit) with
// a commercial-craft set when story.genre === 'commercial'.
//
// What changes vs. prestige Lens B:
//   - genre_register_visual (calibrated to drama / action / noir / etc.) is
//     replaced with style_category_fidelity (the commercial brief's chosen
//     style is the visual register the panel must honor)
//   - lut_mood_fit (calibrated to brand-kit + prestige genre mood) is
//     replaced with style_palette_fit (the panel's color/grade signature
//     must match the brief's visual_signature, which may be intentional
//     chiaroscuro, vaporwave duotone, cel-shade flat color, etc.)
//   - visual_signature_consistency is new — the brief committed to ONE
//     visual signature; this scene master must read as part of THAT spot,
//     not a generic look (a kinetic-montage Scene Master that looks
//     anthemic-epic = visual signature drift)

import { buildSharedSystemHeader, buildGenreRegisterHint } from './sharedHeader.mjs';
import { isStylizedStrong, isNonPhotorealStyle, resolveStyleCategory } from '../CreativeBriefDirector.js';

const COMMERCIAL_LENS_B_BLOCK = `CHECKPOINT B — Commercial Look Dev Review (post-Scene-Master, per scene). LENS B — COMMERCIAL.

DIMENSIONS TO SCORE (each 0-100). Use these EXACT keys in dimension_scores:
  composition                    — focal interest, depth, leading lines, negative space — does the eye know where to land?
  nine_sixteen_storytelling      — vertical-composed (subject above center, foreground/background stacked) or just crop-safed from a 16:9 mindset?
  persona_fidelity               — face / age / wardrobe / hair on-model vs character sheet AND vs visual_anchor (when set)? Identity drift compounds into every beat downstream.
  style_category_fidelity        — does the panel honor commercial_brief.style_category? (anthemic_epic → wide cinematic feel; kinetic_montage → graphic punch-in tempo implied; hand_doodle_animated → cel-shaded line work, NOT photoreal; surreal_dreamlike → painterly hand-rendered texture; etc.)
  style_palette_fit              — does the panel's color/grade/texture signature match brief.visual_style_brief? Intentional chiaroscuro, vaporwave magenta/teal, cel-shade flat color etc. are FEATURES not faults when the brief asked for them.
  wardrobe_props_credibility     — wardrobe + props consistent with archetype + scene context + commercial style?
  directorial_interest           — is there a *choice* here, or is this commercial wallpaper? Cannes Lion-eligible work pauses the room.
  visual_signature_consistency   — does this Scene Master read as part of THE SAME spot brief.visual_signature describes? (anchor-by-anchor, the spot must look like ONE film, not a stitched-together shot library)

WHAT TO LOOK AT FIRST (in order):
  1. STYLE — match the panel against brief.style_category. cel-shaded brief + photoreal panel = critical fail. anthemic_epic brief + flat-light panel = soft_reject.
  2. FACES — every persona on-model? (deduct heavily; identity drift compounds into beats)
  3. PALETTE — does the grade/texture match brief.visual_style_brief?
  4. SIGNATURE — does this panel feel like part of brief.visual_signature, or a generic stock-aesthetic?
  5. 9:16 DISCIPLINE — vertical-composed for the format?
  6. INTEREST — is there a directorial choice, or is this wallpaper?

DEFER TO LOWER LAYERS (do NOT re-emit):
  - aspect ratio / dimensions (Seedream / Nano Banana Pro output guard already enforces 9:16 / 3K)
  - file integrity / corruption (Storage upload validates)
  - persona ground-truth gender/age (PersonaVisualAnchor enforces; you may emit "stylized rendering inverts visual_anchor.gender" findings only when the inversion is in the panel itself)

EVIDENCE FORMAT:
  scope = "scene:<scene_id>"
  evidence = specific element ("background reads photoreal but brief specified hand_doodle_animated", "warm golden grade fights cel-shade brief", "persona_1 hairline doesn't match character sheet")`;

/**
 * Build the multimodal prompt parts for COMMERCIAL Lens B.
 *
 * @param {Object} params
 * @param {Object} params.scene
 * @param {Buffer|string} params.sceneMasterImage
 * @param {string} [params.sceneMasterMime='image/jpeg']
 * @param {Array}  params.personas
 * @param {Object} params.commercialBrief
 * @param {string} [params.lutId]
 * @param {string} [params.visualStylePrefix]
 * @param {string} [params.storyFocus='commercial']
 * @param {boolean} [params.isRetry=false]
 */
export function buildCommercialSceneMasterJudgePrompt({
  scene,
  sceneMasterImage,
  sceneMasterMime = 'image/jpeg',
  personas,
  commercialBrief,
  lutId = null,
  visualStylePrefix = '',
  storyFocus = 'commercial',
  isRetry = false
} = {}) {
  const styleCategory = resolveStyleCategory(commercialBrief);
  const stylized = isStylizedStrong(commercialBrief);
  const nonPhoto = isNonPhotorealStyle(commercialBrief);

  const styleHint = stylized
    ? `STYLIZED PANEL: brief.style_category = "${styleCategory}" — panel SHOULD render in animation grammar (cel-shaded, line work, flat shadow planes, hand-rendered). Score style_category_fidelity heavily on style match. Do NOT penalize for "non-photoreal lighting", "no optical realism", "graphic flatness" — these are intentional craft for ${styleCategory}.`
    : nonPhoto
      ? `SEMI-STYLIZED PANEL: brief.style_category = "${styleCategory}" (live-action filmed, stylized in look/grade). Photoreal identity expected; style_palette_fit scores grade/texture match.`
      : '';

  const systemPrompt = [
    buildSharedSystemHeader(),
    '',
    COMMERCIAL_LENS_B_BLOCK,
    '',
    buildGenreRegisterHint(storyFocus),
    '',
    styleHint,
    '',
    isRetry
      ? 'NOTE: This is the SECOND Scene Master attempt for this scene. retry_authorization MUST be false on critical findings — escalate to user_review.'
      : ''
  ].filter(Boolean).join('\n');

  const userParts = [];
  userParts.push({ text: `<scene>\n${JSON.stringify(scene, null, 2)}\n</scene>` });
  userParts.push({ text: `<personas>\n${JSON.stringify(personas, null, 2)}\n</personas>` });
  userParts.push({ text: `<commercial_brief>\n${JSON.stringify({
    creative_concept: commercialBrief?.creative_concept,
    visual_signature: commercialBrief?.visual_signature,
    style_category: styleCategory,
    visual_style_brief: commercialBrief?.visual_style_brief,
    anti_brief: commercialBrief?.anti_brief
  }, null, 2)}\n</commercial_brief>` });
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
    userParts.push({
      file_data: {
        file_uri: sceneMasterImage,
        mime_type: sceneMasterMime
      }
    });
  } else {
    throw new Error('buildCommercialSceneMasterJudgePrompt: sceneMasterImage required (Buffer or URL string)');
  }

  userParts.push({ text: 'Grade per Commercial Lens B. Output ONLY the verdict JSON.' });

  return { systemPrompt, userParts };
}

export const COMMERCIAL_SCENE_MASTER_DIMENSIONS = Object.freeze([
  'composition', 'nine_sixteen_storytelling', 'persona_fidelity',
  'style_category_fidelity', 'style_palette_fit',
  'wardrobe_props_credibility', 'directorial_interest', 'visual_signature_consistency'
]);
