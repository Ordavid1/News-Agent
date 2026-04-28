// services/v4/director-rubrics/commercialRubric.mjs
// V4 Phase 6 — Director Agent rubric variant for the COMMERCIAL genre.
//
// Replaces the prestige-series Lens A and Lens D dimensions with a commercial-
// craft set. The dimensions story_spine / character_voice / dialogue_craft /
// subtext_density don't apply to a 30-60s spot — what matters is creative
// bravery, brand recall, story compression, visual signature, hook in the
// first 1.5 seconds, music-visual sync, tagline landing, and product role.
//
// Lens B (Scene Master) and Lens C (per-beat) keep their standard rubrics —
// commercial mode doesn't change craft expectations at the frame level.

import { buildSharedSystemHeader } from './sharedHeader.mjs';
import { formatReferenceLibraryForPrompt, COMMERCIAL_STYLE_CATEGORIES } from './commercialReferenceLibrary.mjs';

const COMMERCIAL_LENS_A_BLOCK = `CHECKPOINT A — Commercial Brief (Lens 0/A combined). Pre-screenplay verdict for COMMERCIAL genre.

DIMENSIONS TO SCORE (each 0-100):
  creative_bravery        — Would this stop a feed scroll? Does it risk something? Does it commit to a single bold idea?
  brand_recall            — Will the viewer remember the brand 10 minutes later? Is the brand thesis unmissable?
  story_compression       — Does the brief land an emotional arc in 30-60s? No bloat?
  visual_signature        — Does the brief commit to ONE visual signature an art director could quote? (anamorphic / kinetic / single-take / etc.)
  hook_first_1_5s         — Is the first 1.5 seconds an attention-stopper? (the opening image, sound, motion)
  music_visual_sync       — Does the music drop / swell / silence land on the visual beat that earns it?
  tagline_landing         — Does the final 2 seconds land the tagline + brand stamp without feeling slapped on?
  product_role            — Is the product woven into the story or stapled to the end? Best work makes product = thesis.

DROPPED (intentionally not scored for commercial):
  story_spine, character_voice, dialogue_craft, subtext_density — these belong to prestige short-film grammar.

REFERENCE LIBRARY (use these as your bar):
${formatReferenceLibraryForPrompt({ limit: 6 })}

VALID style_category values: ${COMMERCIAL_STYLE_CATEGORIES.join(' | ')}`;

const COMMERCIAL_LENS_D_BLOCK = `CHECKPOINT D — Commercial Picture Lock. Advisory verdict on assembled commercial spot.

DIMENSIONS (same as Lens A; the assembled spot is judged against the same KPIs):
  creative_bravery, brand_recall, story_compression, visual_signature,
  hook_first_1_5s, music_visual_sync, tagline_landing, product_role

ADVISORY-ONLY — never authorizes auto-retry of a full commercial. retry_authorization MUST be false.`;

/**
 * Build the system prompt for the COMMERCIAL pre-screenplay verdict (Lens 0/A).
 * Used by DirectorAgent.judgeCommercialBrief().
 */
export function buildCommercialBriefJudgePrompt({ creativeBrief, story, brandKit, isRetry = false } = {}) {
  const systemPrompt = [
    buildSharedSystemHeader(),
    '',
    COMMERCIAL_LENS_A_BLOCK,
    '',
    isRetry
      ? 'NOTE: This is the SECOND attempt at this commercial brief. retry_authorization MUST be false.'
      : ''
  ].filter(Boolean).join('\n');

  const userParts = [];
  userParts.push({ text: `<commercial_brief>\n${JSON.stringify(creativeBrief, null, 2)}\n</commercial_brief>` });
  userParts.push({ text: `<story_context>\n${JSON.stringify({
    name: story?.name,
    genre: 'commercial',
    subject: story?.subject,
    target_audience: story?.target_audience,
    user_prompt: story?.user_prompt
  }, null, 2)}\n</story_context>` });
  if (brandKit) {
    userParts.push({ text: `<brand_kit>\n${JSON.stringify({
      brand_summary: brandKit.brand_summary,
      mood: brandKit.style_characteristics?.mood,
      aesthetic: brandKit.style_characteristics?.overall_aesthetic,
      palette: brandKit.color_palette
    }, null, 2)}\n</brand_kit>` });
  }
  userParts.push({ text: 'Grade the brief. Output ONLY the verdict JSON.' });

  return { systemPrompt, userParts };
}

/**
 * Build the system prompt for the COMMERCIAL picture-lock verdict (Lens D).
 * Same transport contract as episodeRubric: prefer inline_data buffer over
 * file_uri (Vertex rejects arbitrary HTTPS URIs for video).
 */
export function buildCommercialEpisodeJudgePrompt({
  episodeVideoBuffer = null,
  episodeVideoUrl = null,
  videoMime,
  sceneGraph,
  episodeMeta
} = {}) {
  if (!episodeVideoBuffer && !episodeVideoUrl) {
    throw new Error('buildCommercialEpisodeJudgePrompt: episodeVideoBuffer (preferred) or episodeVideoUrl required');
  }
  const systemPrompt = [
    buildSharedSystemHeader(),
    '',
    COMMERCIAL_LENS_D_BLOCK
  ].join('\n');

  const userParts = [];
  userParts.push({ text: `<scene_graph>\n${JSON.stringify(sceneGraph || {}, null, 2)}\n</scene_graph>` });
  if (episodeMeta) {
    userParts.push({ text: `<episode_meta>\n${JSON.stringify(episodeMeta, null, 2)}\n</episode_meta>` });
  }
  userParts.push({ text: 'Commercial picture lock — assembled episode video below.' });

  const mime = videoMime || 'video/mp4';
  if (Buffer.isBuffer(episodeVideoBuffer) && episodeVideoBuffer.length > 0) {
    userParts.push({ inline_data: { mime_type: mime, data: episodeVideoBuffer.toString('base64') } });
  } else if (typeof episodeVideoUrl === 'string' && episodeVideoUrl.startsWith('gs://')) {
    userParts.push({ file_data: { file_uri: episodeVideoUrl, mime_type: mime } });
  } else {
    throw new Error('buildCommercialEpisodeJudgePrompt: video buffer required (file_uri only supports gs:// for video)');
  }

  userParts.push({ text: 'Grade per Commercial Lens D. Output ONLY the verdict JSON.' });

  return { systemPrompt, userParts };
}

export const COMMERCIAL_DIMENSIONS = Object.freeze([
  'creative_bravery', 'brand_recall', 'story_compression', 'visual_signature',
  'hook_first_1_5s', 'music_visual_sync', 'tagline_landing', 'product_role'
]);
