// services/BrandStoryService.js
// Core orchestrator for Brand Story video series.
// Manages the full lifecycle: storyline generation, episode creation,
// storyboard frame generation, avatar narration, scene video, compositing, and publishing.

import axios from 'axios';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import winston from 'winston';

import {
  createBrandStory,
  getBrandStoryById,
  getBrandStories,
  updateBrandStory,
  deleteBrandStory,
  createBrandStoryEpisode,
  getBrandStoryEpisodes,
  getBrandStoryEpisodeById,
  updateBrandStoryEpisode,
  getMediaTrainingJobById,
  countBrandStories
} from './database.js';

import leonardoService from './LeonardoService.js';
import heyGenService from './HeyGenService.js';
import videoGenerationService from './VideoGenerationService.js';
import klingService from './KlingService.js';
import omniHumanService from './OmniHumanService.js';
import seedanceService from './SeedanceService.js';
import ttsService from './TTSService.js';

import {
  getStorylineSystemPrompt,
  getStorylineUserPrompt,
  getEpisodeSystemPrompt,
  getEpisodeUserPrompt,
  getStoryboardPrompt,
  getEpisodeSystemPromptV2,
  getEpisodeUserPromptV2,
  _buildBrandKitContextBlock
} from '../public/components/brandStoryPrompts.mjs';

import Replicate from 'replicate';

const execFileAsync = promisify(execFile);

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[BrandStoryService] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent';

class BrandStoryService {
  constructor() {
    this.googleApiKey = process.env.GOOGLE_AI_STUDIO_API_KEY;

    if (!this.googleApiKey) {
      logger.warn('GOOGLE_AI_STUDIO_API_KEY not set — storyline generation will not be available');
    }
  }

  // ═══════════════════════════════════════════════════
  // STORY CRUD
  // ═══════════════════════════════════════════════════

  /**
   * Create a new brand story.
   * @param {string} userId
   * @param {Object} config - { name, persona_type, persona_config, subject, brand_kit_job_id, target_platforms, publish_frequency }
   * @returns {Promise<Object>} The created story record
   */
  async createStory(userId, config) {
    // Validate Brand Kit exists if referenced
    if (config.brand_kit_job_id) {
      const job = await getMediaTrainingJobById(config.brand_kit_job_id, userId);
      if (!job) throw new Error('Referenced Brand Kit job not found');
      if (!job.brand_kit) throw new Error('Brand Kit has not been analyzed yet — run brand kit analysis first');
    }

    const story = await createBrandStory(userId, config);
    logger.info(`Brand story created: ${story.id} (${config.name}) for user ${userId}`);
    return story;
  }

  /**
   * Get all stories for a user.
   */
  async getStories(userId) {
    return getBrandStories(userId);
  }

  /**
   * Get a story by ID with its episodes.
   */
  async getStoryWithEpisodes(storyId, userId) {
    const story = await getBrandStoryById(storyId, userId);
    if (!story) return null;

    const episodes = await getBrandStoryEpisodes(storyId, userId);
    return { ...story, episodes };
  }

  /**
   * Update a story.
   */
  async updateStory(storyId, userId, updates) {
    return updateBrandStory(storyId, userId, updates);
  }

  /**
   * Delete a story and all its episodes.
   */
  async deleteStory(storyId, userId) {
    return deleteBrandStory(storyId, userId);
  }

  /**
   * Count stories for a user.
   */
  async countStories(userId) {
    return countBrandStories(userId);
  }

  // ═══════════════════════════════════════════════════
  // SUBJECT ANALYSIS (Gemini 3 Flash Vision)
  // ═══════════════════════════════════════════════════

  /**
   * Analyze 1-3 images of a subject/product and produce a structured subject description.
   * Optionally leverages Brand Kit context for richer analysis.
   *
   * @param {Object} params
   * @param {Array<{ data: Buffer, mimeType: string }|string>} params.images - Image buffers or URLs (1-3)
   * @param {Object} [params.brandKit] - Optional brand kit data for context
   * @returns {Promise<Object>} Structured subject: { name, category, description, key_features, visual_description }
   */
  async analyzeSubject({ images, brandKit = null, storyFocus = 'product' }) {
    if (!this.googleApiKey) throw new Error('GOOGLE_AI_STUDIO_API_KEY is required for subject analysis');
    if (!images || images.length === 0) throw new Error('At least one image is required');
    if (images.length > 3) throw new Error('Maximum 3 images allowed');

    logger.info(`Analyzing subject from ${images.length} image(s) (focus=${storyFocus})${brandKit ? ' with Brand Kit context' : ''}`);

    // Normalize images to { inlineData: { mimeType, data: base64 } }
    const imageParts = [];
    for (const img of images) {
      if (typeof img === 'string') {
        // URL — download
        const resp = await axios.get(img, {
          responseType: 'arraybuffer',
          timeout: 15000,
          headers: { 'User-Agent': 'NewsAgentSaaS/1.0' }
        });
        const contentType = resp.headers['content-type'] || '';
        let mimeType = 'image/jpeg';
        if (contentType.includes('png')) mimeType = 'image/png';
        else if (contentType.includes('webp')) mimeType = 'image/webp';
        imageParts.push({
          inlineData: { mimeType, data: Buffer.from(resp.data).toString('base64') }
        });
      } else {
        // Buffer + mimeType object
        imageParts.push({
          inlineData: { mimeType: img.mimeType, data: img.data.toString('base64') }
        });
      }
    }

    // Build optional Brand Kit context block
    const brandContext = brandKit ? `
BRAND KIT CONTEXT (use this to inform your analysis):
- Brand summary: ${brandKit.brand_summary || 'N/A'}
- Overall aesthetic: ${brandKit.style_characteristics?.overall_aesthetic || 'N/A'}
- Mood: ${brandKit.style_characteristics?.mood || 'N/A'}
- Visual motifs: ${brandKit.style_characteristics?.visual_motifs || 'N/A'}
- Brand colors: ${(brandKit.color_palette || []).slice(0, 5).map(c => c.hex || c.name).join(', ')}
` : '';

    // Focus-specific integration guidance — teaches Gemini HOW the subject should appear in scenes
    // (like product placement in TV series: natural, diegetic, not forced).
    const focusIntegrationBrief = {
      person:    'This is a PERSON-focus story. The uploaded subject is something the person interacts with, wears, owns, or relates to. It should appear naturally in their hands, on their body, in their environment — as an extension of who they are.',
      product:   'This is a PRODUCT-focus story. The uploaded subject IS the hero of every episode. Think TV-series paid product integration: characters USE it, HOLD it, UNBOX it, REACT to it. It appears in hands, on counters, on tables, on benches, in close-ups — always naturally, never a billboard.',
      landscape: 'This is a LANDSCAPE / PLACE-focus story. The uploaded subject is the SETTING. Characters walk THROUGH it, sit IN it, gaze AT it, inhabit it. It can be a background, an environment the camera explores, an interior that frames the action, or the destination the story arrives at.'
    }[storyFocus] || 'Integrate naturally into the visual narrative.';

    const prompt = `You are a product/subject analyst for a brand storytelling platform. Analyze these ${imageParts.length} image(s) of a subject and produce a structured description that will drive an automated video story series.

${focusIntegrationBrief}
${brandContext}
Your analysis must identify:
1. What the subject IS (name the specific product/object/place — be precise, not generic)
2. Its category (e.g., "Luxury fragrance", "Waterfront villa", "Custom jewelry", "Boutique hotel")
3. A compelling description (2-3 sentences capturing its essence, materials, craftsmanship, atmosphere)
4. Key features (3-5 distinguishing characteristics)
5. Visual description (detailed physical description suitable for image/video generation prompts — materials, colors, textures, shape, packaging, lighting, context)
6. Integration guidance (3-5 concrete suggestions for HOW this subject should appear in short-form video episodes, in a natural narrative way — treat it like TV-series product placement)

Return ONLY valid JSON (no markdown fences, no extra text) in this exact structure:
{
  "name": "Specific product/place name or descriptor",
  "category": "Category/type",
  "description": "2-3 sentence compelling description",
  "key_features": ["Feature 1", "Feature 2", "Feature 3"],
  "visual_description": "Detailed visual description for image generation",
  "integration_guidance": [
    "Concrete scene suggestion 1 (e.g., 'held in the protagonist\\'s hand during a quiet moment')",
    "Concrete scene suggestion 2 (e.g., 'displayed on the marble countertop in the opening shot')",
    "Concrete scene suggestion 3 (e.g., 'reflected in a window during the reveal')"
  ]
}

Be SPECIFIC and EVOCATIVE. Avoid vague language. For a perfume: describe the bottle shape, cap finish, liquid color. For real estate: architectural style, materials, surroundings, interior mood. For jewelry: stones, metalwork, setting. For integration_guidance, write suggestions that a director could actually stage on camera.`;

    const parts = [...imageParts, { text: prompt }];

    const response = await axios.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent',
      {
        contents: [{ parts }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 2000,
          responseMimeType: 'application/json'
        }
      },
      {
        headers: {
          'x-goog-api-key': this.googleApiKey,
          'Content-Type': 'application/json'
        },
        timeout: 60000
      }
    );

    const rawText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!rawText) throw new Error('Subject analysis returned empty response');

    let subject;
    try {
      subject = this._parseGeminiJson(rawText);
    } catch (parseError) {
      logger.error(`Failed to parse subject analysis JSON: ${rawText.slice(0, 200)}`);
      throw new Error('Subject analysis returned invalid JSON');
    }

    logger.info(`Subject analyzed: "${subject.name}" (${subject.category})`);
    return subject;
  }

  // ═══════════════════════════════════════════════════
  // STORYLINE GENERATION (Gemini 3 Flash)
  // ═══════════════════════════════════════════════════

  /**
   * Generate a full storyline / season bible for a brand story using Gemini.
   * Reads the Brand Kit data and creates a narrative framework.
   *
   * @param {string} storyId
   * @param {string} userId
   * @returns {Promise<Object>} The updated story with storyline
   */
  async generateStoryline(storyId, userId) {
    if (!this.googleApiKey) throw new Error('GOOGLE_AI_STUDIO_API_KEY is required for storyline generation');

    const story = await getBrandStoryById(storyId, userId);
    if (!story) throw new Error('Story not found');

    logger.info(`Generating storyline for story ${storyId}: "${story.name}"`);

    // Load Brand Kit data if referenced
    let brandKit = {};
    if (story.brand_kit_job_id) {
      const job = await getMediaTrainingJobById(story.brand_kit_job_id, userId);
      if (job?.brand_kit) {
        brandKit = job.brand_kit;
      }
    }

    // Build prompts — pass the full personas array (up to 3)
    const personas = Array.isArray(story.persona_config?.personas)
      ? story.persona_config.personas
      : [story.persona_config]; // legacy fallback

    const systemPrompt = getStorylineSystemPrompt(brandKit);
    const userPrompt = getStorylineUserPrompt(
      personas,
      story.subject,
      brandKit,
      {
        tone: story.subject?.tone || 'engaging',
        genre: story.subject?.genre || 'drama',
        storyFocus: story.story_focus || 'product'
      }
    );

    // Call Gemini 3 Flash
    const response = await axios.post(GEMINI_ENDPOINT, {
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      },
      contents: [{
        role: 'user',
        parts: [{ text: userPrompt }]
      }],
      generationConfig: {
        maxOutputTokens: 32000,
        temperature: 0.85,
        responseMimeType: 'application/json'
      }
    }, {
      headers: {
        'x-goog-api-key': this.googleApiKey,
        'Content-Type': 'application/json'
      },
      timeout: 120000
    });

    const candidate = response.data?.candidates?.[0];
    const rawText = candidate?.content?.parts?.[0]?.text?.trim();
    const finishReason = candidate?.finishReason;

    if (!rawText) {
      logger.error(`Gemini returned empty storyline — finishReason: ${finishReason}`);
      throw new Error('Storyline generation returned empty response');
    }

    if (finishReason === 'MAX_TOKENS') {
      logger.error(`Storyline hit MAX_TOKENS (${rawText.length} chars generated) — response truncated`);
      throw new Error('Storyline exceeded token limit — try shorter inputs or regenerate');
    }

    // Parse the JSON response (with defensive repair for Gemini's occasional trailing chars)
    let storyline;
    try {
      storyline = this._parseGeminiJson(rawText);
    } catch (parseError) {
      logger.error(`Failed to parse storyline JSON (finishReason: ${finishReason}, length: ${rawText.length})`);
      logger.error(`First 500 chars: ${rawText.slice(0, 500)}`);
      logger.error(`Last 300 chars: ...${rawText.slice(-300)}`);
      throw new Error('Storyline generation returned invalid JSON');
    }

    logger.info(`Storyline generated: "${storyline.title}" — ${storyline.episodes?.length || 0} episodes planned`);

    // Save to database
    const updated = await updateBrandStory(storyId, userId, { storyline });

    // Kick off avatar setup in the background (non-blocking).
    // Users can review the storyline while the avatar trains.
    this._autoSetupAvatar(storyId, userId).catch(err =>
      logger.error(`Auto avatar setup failed for ${storyId}: ${err.message}`)
    );

    return updated;
  }

  /**
   * Automatically set up the HeyGen avatar for each persona in a story.
   * Uses HeyGen's talking_photo upload (no training needed — works instantly,
   * supports Avatar IV motion engine, and accepts both real and AI-generated faces).
   *
   * Flow per persona_type:
   *   - 'selected': persona already has heygen_avatar_id from stock picker. Just record it.
   *   - 'uploaded': uploadTalkingPhoto(first uploaded image) → talking_photo_id.
   *   - 'brand_kit': uploadTalkingPhoto(cutout_url) → talking_photo_id.
   *   - 'described': Leonardo generates 1 headshot → uploadTalkingPhoto → talking_photo_id.
   *
   * Each persona gets its OWN talking_photo_id stored in persona_config.personas[i].
   */
  async _autoSetupAvatar(storyId, userId) {
    const isHybrid = process.env.BRAND_STORY_VIDEO_STACK === 'hybrid';

    // ═══════════════════════════════════════════════════════════
    // HYBRID MODE — skip HeyGen entirely, just persist seed image URLs for OmniHuman.
    // OmniHuman is zero-shot: single image + audio → video. No training, no uploads.
    // ═══════════════════════════════════════════════════════════
    if (isHybrid) {
      const story = await getBrandStoryById(storyId, userId);
      if (!story) return;

      const personas = Array.isArray(story.persona_config?.personas)
        ? story.persona_config.personas
        : [story.persona_config];

      logger.info(`[HYBRID] Avatar setup for story ${storyId} (persona_type=${story.persona_type}, ${personas.length} persona(s)) — skipping HeyGen`);

      try {
        let workingPersonas = [...personas];

        // For 'described': still need Leonardo to generate a face image (OmniHuman needs SOME image)
        if (story.persona_type === 'described') {
          await updateBrandStory(storyId, userId, {
            persona_config: { ...(story.persona_config || {}), training_status: 'generating_persona_image' }
          });

          for (let i = 0; i < workingPersonas.length; i++) {
            const p = workingPersonas[i];
            if (p.reference_image_urls?.length > 0) continue;

            const description = p.description || 'A professional person';
            const personality = p.personality || '';
            const personaPrompt = `Photorealistic portrait headshot of ${description}. ${personality}. Neutral studio background, soft natural lighting, looking directly at camera, shoulders visible, closed mouth, film grain, 50mm lens.`;

            logger.info(`[P${i + 1}] Generating Leonardo face for described persona...`);
            const imageResult = await leonardoService.generateFrame({
              prompt: personaPrompt,
              options: { width: 768, height: 1024, numImages: 1, presetStyle: 'CINEMATIC' }
            });
            workingPersonas[i] = { ...p, reference_image_urls: [imageResult.imageUrl] };
          }
        }

        // Persist seed image URL for OmniHuman on each persona
        for (let i = 0; i < workingPersonas.length; i++) {
          const p = workingPersonas[i];
          const seedUrl = story.persona_type === 'brand_kit'
            ? p?.cutout_url
            : story.persona_type === 'selected'
              ? p?.preview_image_url || p?.avatar_preview_url
              : p?.reference_image_urls?.[0];
          if (seedUrl) {
            workingPersonas[i] = { ...workingPersonas[i], omnihuman_seed_image_url: seedUrl };
          }
        }

        const configuredCount = workingPersonas.filter(p => p.omnihuman_seed_image_url).length;
        await updateBrandStory(storyId, userId, {
          persona_config: {
            ...(story.persona_config || {}),
            personas: workingPersonas,
            training_status: configuredCount > 0 ? 'completed' : 'failed'
          }
        });

        logger.info(`[HYBRID] Avatar setup complete: ${configuredCount}/${workingPersonas.length} personas with OmniHuman seed images (no HeyGen)`);
        return;
      } catch (err) {
        logger.error(`[HYBRID] Avatar setup error for story ${storyId}: ${err.message}`);
        const fresh = await getBrandStoryById(storyId, userId);
        if (fresh) {
          await updateBrandStory(storyId, userId, {
            persona_config: {
              ...(fresh.persona_config || {}),
              training_status: 'failed',
              training_error: err.message
            }
          });
        }
        return;
      }
    }

    // ═══════════════════════════════════════════════════════════
    // LEGACY MODE — HeyGen uploadTalkingPhoto per persona
    // ═══════════════════════════════════════════════════════════
    if (!heyGenService.isAvailable()) {
      logger.info(`Auto avatar setup skipped for ${storyId} — HeyGen not configured`);
      return;
    }

    const story = await getBrandStoryById(storyId, userId);
    if (!story) return;

    const personas = Array.isArray(story.persona_config?.personas)
      ? story.persona_config.personas
      : [story.persona_config];

    logger.info(`Auto avatar setup for story ${storyId} (persona_type=${story.persona_type}, ${personas.length} persona(s))`);

    try {
      // SELECTED: personas already have stock heygen_avatar_id. Mark primary.
      if (story.persona_type === 'selected') {
        const primary = personas[0] || {};
        if (!primary?.heygen_avatar_id) {
          logger.warn(`Primary selected persona has no heygen_avatar_id for story ${storyId}`);
          await updateBrandStory(storyId, userId, {
            persona_config: { ...(story.persona_config || {}), training_status: 'failed' }
          });
          return;
        }
        const stockPersonas = personas.map(p => ({ ...p, is_photo_avatar: false }));
        await updateBrandStory(storyId, userId, {
          heygen_avatar_id: primary.heygen_avatar_id,
          persona_config: {
            ...(story.persona_config || {}),
            personas: stockPersonas,
            training_status: 'completed'
          }
        });
        logger.info(`Selected stock avatars configured for ${personas.length} persona(s)`);
        return;
      }

      // UPLOADED / BRAND_KIT / DESCRIBED: upload each persona's seed image as a talking_photo.
      await updateBrandStory(storyId, userId, {
        persona_config: { ...(story.persona_config || {}), training_status: 'processing' }
      });

      let workingPersonas = [...personas];

      // For 'described': first generate a face image via Leonardo if missing.
      if (story.persona_type === 'described') {
        await updateBrandStory(storyId, userId, {
          persona_config: { ...(story.persona_config || {}), training_status: 'generating_persona_image' }
        });

        for (let i = 0; i < workingPersonas.length; i++) {
          const p = workingPersonas[i];
          if (p.reference_image_urls?.length > 0) continue;

          const description = p.description || 'A professional person';
          const personality = p.personality || '';
          const personaPrompt = `Photorealistic portrait headshot of ${description}. ${personality}. Neutral studio background, soft natural lighting, looking directly at camera, shoulders visible, closed mouth, film grain, 50mm lens.`;

          logger.info(`[P${i + 1}] Generating Leonardo face for described persona...`);
          const imageResult = await leonardoService.generateFrame({
            prompt: personaPrompt,
            options: { width: 768, height: 1024, numImages: 1, presetStyle: 'CINEMATIC' }
          });
          workingPersonas[i] = { ...p, reference_image_urls: [imageResult.imageUrl] };
        }

        await updateBrandStory(storyId, userId, {
          persona_config: {
            ...(story.persona_config || {}),
            personas: workingPersonas,
            training_status: 'processing'
          }
        });
      }

      // Upload each persona's seed image as a HeyGen talking_photo — parallel, fast, no waiting.
      logger.info(`Uploading ${workingPersonas.length} talking photo(s) to HeyGen...`);

      await Promise.all(workingPersonas.map(async (persona, index) => {
        if (persona.heygen_avatar_id) {
          logger.info(`[P${index + 1}] already has avatar_id=${persona.heygen_avatar_id} — skipping`);
          return;
        }

        // Resolve seed image URL for this persona
        const seedImageUrl = story.persona_type === 'brand_kit'
          ? persona?.cutout_url
          : persona?.reference_image_urls?.[0];

        if (!seedImageUrl) {
          logger.warn(`[P${index + 1}] no image available — skipping`);
          return;
        }

        try {
          const { talkingPhotoId } = await heyGenService.uploadTalkingPhoto(seedImageUrl);
          workingPersonas[index] = {
            ...persona,
            heygen_avatar_id: talkingPhotoId,
            is_photo_avatar: true
          };
          logger.info(`[P${index + 1}] talking_photo_id=${talkingPhotoId}`);
        } catch (uploadErr) {
          logger.error(`[P${index + 1}] talking_photo upload failed: ${uploadErr.message}`);
        }
      }));

      // Record the primary persona's avatar on the story (used for dialogue shots).
      const primary = workingPersonas[0] || {};
      const anyConfigured = workingPersonas.some(p => !!p.heygen_avatar_id);

      await updateBrandStory(storyId, userId, {
        heygen_avatar_id: primary.heygen_avatar_id || null,
        heygen_avatar_group_id: null, // no longer used with talking_photo path
        persona_config: {
          ...(story.persona_config || {}),
          personas: workingPersonas,
          training_status: anyConfigured ? 'completed' : 'failed'
        }
      });

      const configuredCount = workingPersonas.filter(p => !!p.heygen_avatar_id).length;
      logger.info(`Avatar setup complete for story ${storyId}: ${configuredCount}/${workingPersonas.length} personas configured`);
    } catch (err) {
      logger.error(`Auto avatar setup error for story ${storyId}: ${err.message}`);
      const fresh = await getBrandStoryById(storyId, userId);
      if (fresh) {
        await updateBrandStory(storyId, userId, {
          persona_config: {
            ...(fresh.persona_config || {}),
            training_status: 'failed',
            training_error: err.message
          }
        });
      }
    }
  }

  // ═══════════════════════════════════════════════════
  // EPISODE GENERATION (next scene)
  // ═══════════════════════════════════════════════════

  /**
   * Generate the next episode's scene description using Gemini.
   * Reads the storyline + all previous episodes for continuity.
   *
   * @param {string} storyId
   * @param {string} userId
   * @returns {Promise<Object>} The created episode record
   */
  async generateNextEpisode(storyId, userId) {
    if (!this.googleApiKey) throw new Error('GOOGLE_AI_STUDIO_API_KEY is required');

    const story = await getBrandStoryById(storyId, userId);
    if (!story) throw new Error('Story not found');
    if (!story.storyline) throw new Error('Story has no storyline — generate one first');

    // Get all previous episodes
    const previousEpisodes = await getBrandStoryEpisodes(storyId, userId);
    const episodeNumber = previousEpisodes.length + 1;

    logger.info(`Generating episode ${episodeNumber} for story "${story.name}" (${storyId})`);

    // Build continuity context — pass full scene_descriptions so the prompt can expand
    // the most recent one with full detail (tiered continuity).
    const prevScenes = previousEpisodes.map(ep => ep.scene_description);
    const lastCliffhanger = previousEpisodes[previousEpisodes.length - 1]?.scene_description?.cliffhanger || '';

    // Surface available narrators to Gemini so it can pick which persona speaks per dialogue shot.
    const storyPersonas = Array.isArray(story.persona_config?.personas)
      ? story.persona_config.personas
      : [story.persona_config];

    // Load Brand Kit (if configured) so each episode honors brand colors, mood, motifs, logos.
    let brandKit = null;
    if (story.brand_kit_job_id) {
      const job = await getMediaTrainingJobById(story.brand_kit_job_id, userId);
      if (job?.brand_kit) brandKit = job.brand_kit;
    }

    // Build prompts — pass subject + storyFocus + brandKit so each episode's shots
    // integrate the subject naturally AND respect the brand identity.
    const systemPrompt = getEpisodeSystemPrompt(story.storyline, prevScenes, storyPersonas, {
      subject: story.subject,
      storyFocus: story.story_focus || 'product',
      brandKit
    });
    const userPrompt = getEpisodeUserPrompt(story.storyline, lastCliffhanger, episodeNumber);

    // Call Gemini 3 Flash
    const response = await axios.post(GEMINI_ENDPOINT, {
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      },
      contents: [{
        role: 'user',
        parts: [{ text: userPrompt }]
      }],
      generationConfig: {
        maxOutputTokens: 4096,
        temperature: 0.85,
        responseMimeType: 'application/json'
      }
    }, {
      headers: {
        'x-goog-api-key': this.googleApiKey,
        'Content-Type': 'application/json'
      },
      timeout: 45000
    });

    const candidate = response.data?.candidates?.[0];
    const rawText = candidate?.content?.parts?.[0]?.text?.trim();

    if (!rawText) throw new Error('Episode generation returned empty response');

    let sceneDescription;
    try {
      sceneDescription = this._parseGeminiJson(rawText);
    } catch (parseError) {
      logger.error(`Failed to parse episode JSON: ${rawText.slice(0, 200)}`);
      throw new Error('Episode generation returned invalid JSON');
    }

    logger.info(`Episode ${episodeNumber} generated: "${sceneDescription.title}"`);

    // Create episode record
    const episode = await createBrandStoryEpisode(storyId, userId, {
      episode_number: episodeNumber,
      scene_description: sceneDescription,
      status: 'generating_scene'
    });

    // Update story total_episodes count
    await updateBrandStory(storyId, userId, { total_episodes: episodeNumber });

    return episode;
  }

  // ═══════════════════════════════════════════════════
  // STORYBOARD FRAME GENERATION (Leonardo.ai)
  // ═══════════════════════════════════════════════════

  /**
   * Generate a storyboard frame for an episode using Leonardo.ai.
   *
   * @param {string} episodeId
   * @param {string} userId
   * @returns {Promise<Object>} Updated episode with storyboard_frame_url
   */
  async generateStoryboardFrame(episodeId, userId) {
    if (!leonardoService.isAvailable()) throw new Error('Leonardo.ai is not configured (LEONARDO_API_KEY)');

    const episode = await getBrandStoryEpisodeById(episodeId, userId);
    if (!episode) throw new Error('Episode not found');

    const story = await getBrandStoryById(episode.story_id, userId);
    if (!story) throw new Error('Story not found');

    logger.info(`Generating storyboard frame for episode ${episode.episode_number} (${episodeId})`);

    // Update status
    await updateBrandStoryEpisode(episodeId, userId, { status: 'generating_storyboard' });

    // Load brand kit for visual context
    let brandKit = {};
    if (story.brand_kit_job_id) {
      const job = await getMediaTrainingJobById(story.brand_kit_job_id, userId);
      if (job?.brand_kit) brandKit = job.brand_kit;
    }

    // Get the primary persona (personas[0]) — it drives character consistency.
    // persona_config shape: { personas: [ {...}, {...}, {...} ] }
    const personas = Array.isArray(story.persona_config?.personas)
      ? story.persona_config.personas
      : [story.persona_config];
    const primaryPersona = personas[0] || {};

    // Ensure character reference image is uploaded to Leonardo (once per story).
    // Source image priority depends on persona_type:
    //   - 'uploaded': use first uploaded reference image of the primary persona
    //   - 'brand_kit': use the selected person cutout URL of the primary persona
    //   - 'selected'/'described': no character reference (Leonardo generates from prompt)
    let characterRefId = story.leonardo_character_ref_id;
    if (!characterRefId) {
      let referenceImageUrl = null;
      if (story.persona_type === 'uploaded') {
        referenceImageUrl = primaryPersona?.reference_image_urls?.[0] || null;
      } else if (story.persona_type === 'brand_kit') {
        referenceImageUrl = primaryPersona?.cutout_url || null;
      }

      if (referenceImageUrl) {
        characterRefId = await leonardoService.uploadReferenceImage(referenceImageUrl);
        await updateBrandStory(story.id, userId, { leonardo_character_ref_id: characterRefId });
      }
    }

    // Build the prompt — pass the full persona_config so all characters are described
    const prompt = getStoryboardPrompt(episode.scene_description, story.persona_config, brandKit);

    // Generate frame
    const result = await leonardoService.generateFrame({
      prompt,
      characterRefId,
      styleRefId: story.leonardo_style_ref_id || null
    });

    // Update episode
    const updated = await updateBrandStoryEpisode(episodeId, userId, {
      storyboard_frame_url: result.imageUrl,
      storyboard_generation_id: result.generationId,
      status: 'generating_avatar'
    });

    logger.info(`Storyboard frame generated for episode ${episode.episode_number}: ${result.imageUrl}`);
    return updated;
  }

  // ═══════════════════════════════════════════════════
  // AVATAR NARRATION (HeyGen)
  // ═══════════════════════════════════════════════════

  /**
   * Generate avatar narration video for an episode using HeyGen.
   *
   * @param {string} episodeId
   * @param {string} userId
   * @returns {Promise<Object>} Updated episode with avatar_video_url
   */
  async generateAvatarNarration(episodeId, userId) {
    if (!heyGenService.isAvailable()) throw new Error('HeyGen is not configured (HEYGEN_API_KEY)');

    const episode = await getBrandStoryEpisodeById(episodeId, userId);
    if (!episode) throw new Error('Episode not found');

    const story = await getBrandStoryById(episode.story_id, userId);
    if (!story) throw new Error('Story not found');

    const dialogueScript = episode.scene_description?.dialogue_script;
    if (!dialogueScript) throw new Error('Episode has no dialogue script');

    // Select which persona narrates this episode.
    // Gemini picks narrator_persona_index (0-based). Fall back to persona 0 or story-level.
    const personas = Array.isArray(story.persona_config?.personas)
      ? story.persona_config.personas
      : [story.persona_config];
    const requestedIdx = Number.isInteger(episode.scene_description?.narrator_persona_index)
      ? episode.scene_description.narrator_persona_index
      : 0;
    const clampedIdx = Math.max(0, Math.min(requestedIdx, personas.length - 1));
    const narratorPersona = personas[clampedIdx] || personas[0] || {};

    // Prefer the persona's own trained avatar; fall back to story-level primary.
    const avatarId = narratorPersona.heygen_avatar_id || story.heygen_avatar_id;
    if (!avatarId) throw new Error('No HeyGen avatar available for any persona');

    const narratorLabel = narratorPersona.description?.slice(0, 40)
      || narratorPersona.avatar_name
      || `Persona ${clampedIdx + 1}`;
    logger.info(`Generating avatar narration for episode ${episode.episode_number} — narrator: [${clampedIdx}] "${narratorLabel}" (avatar=${avatarId})`);

    await updateBrandStoryEpisode(episodeId, userId, { status: 'generating_avatar' });

    // talking_photo avatars require a different character.type + use_avatar_iv_model=true
    // Stock HeyGen avatars (persona_type=selected) use character.type='avatar'.
    const isPhotoAvatar = narratorPersona.is_photo_avatar === true
      || (story.persona_type !== 'selected' && !!narratorPersona.heygen_avatar_id);

    const result = await heyGenService.generateAvatarVideo({
      avatarId,
      script: dialogueScript,
      options: {
        isPhotoAvatar,
        voiceId: narratorPersona.heygen_voice_id || null,
        aspectRatio: '9:16',
        resolution: '1080p'
      }
    });

    // Update episode
    const updated = await updateBrandStoryEpisode(episodeId, userId, {
      avatar_video_url: result.videoUrl,
      heygen_video_id: result.videoId,
      status: 'generating_video'
    });

    logger.info(`Avatar narration generated for episode ${episode.episode_number}: ${result.videoUrl}`);
    return updated;
  }

  // ═══════════════════════════════════════════════════
  // SCENE VIDEO GENERATION — ROUTER
  // Dispatches to Kling (cinematic) / Veo (broll) based on shot_type.
  // Dialogue shots are handled entirely by generateAvatarNarration (HeyGen).
  // ═══════════════════════════════════════════════════

  /**
   * Generate the episode video from the shot sequence Gemini wrote.
   *
   * Flow:
   *   1. Read episode.scene_description.shots[] (fallback: synthesize 1 shot from legacy fields)
   *   2. For each shot, call _generateSingleShot() — dispatches to HeyGen/Kling/Veo
   *   3. ffmpeg concat all shots into one MP4
   *   4. Upload final composite to Supabase → scene_video_url
   *   5. Persist per-shot URLs in scene_description._generated_shots for debugging
   *
   * @param {string} episodeId
   * @param {string} userId
   * @returns {Promise<Object>} Updated episode with scene_video_url
   */
  async generateSceneVideo(episodeId, userId) {
    const episode = await getBrandStoryEpisodeById(episodeId, userId);
    if (!episode) throw new Error('Episode not found');

    const story = await getBrandStoryById(episode.story_id, userId);
    if (!story) throw new Error('Story not found');

    const scene = episode.scene_description || {};

    // Determine shots list — support both new multi-shot schema and legacy single-shot.
    const shots = this._resolveShots(scene);
    logger.info(`Episode ${episode.episode_number}: generating ${shots.length} shot(s) [${shots.map(s => s.shot_type).join(' → ')}]`);

    await updateBrandStoryEpisode(episodeId, userId, { status: 'generating_video' });

    // Generate each shot sequentially (parallel would hammer APIs + Leonardo storyboards share persona state).
    const generatedShots = [];
    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      logger.info(`[Shot ${i + 1}/${shots.length}] type=${shot.shot_type}, duration=${shot.duration_seconds || 7}s`);

      try {
        const result = await this._generateSingleShot(shot, episode, story, userId, i);
        generatedShots.push({
          index: i,
          shot_type: shot.shot_type,
          duration: shot.duration_seconds || 7,
          video_url: result.publicVideoUrl,
          model: result.model
        });
      } catch (shotErr) {
        logger.error(`[Shot ${i + 1}] generation failed: ${shotErr.message}`);
        // Continue with remaining shots — concat will skip failed ones
      }
    }

    if (generatedShots.length === 0) {
      throw new Error('All shots failed to generate');
    }

    // Concat shots into single episode video
    let finalUrl;
    if (generatedShots.length === 1) {
      logger.info(`Single shot — skipping ffmpeg concat`);
      finalUrl = generatedShots[0].video_url;
    } else {
      logger.info(`Concatenating ${generatedShots.length} shots via ffmpeg...`);
      try {
        finalUrl = await this._concatShots(generatedShots, userId, episodeId);
      } catch (concatErr) {
        logger.error(`ffmpeg concat failed: ${concatErr.message} — falling back to first shot`);
        finalUrl = generatedShots[0].video_url;
      }
    }

    // Persist per-shot URLs for debugging + UI display
    const updatedSceneDescription = {
      ...scene,
      _generated_shots: generatedShots
    };

    const updated = await updateBrandStoryEpisode(episodeId, userId, {
      scene_video_url: finalUrl,
      video_generation_id: generatedShots.map(s => s.model).join(','),
      scene_description: updatedSceneDescription,
      status: 'compositing'
    });

    logger.info(`Episode ${episode.episode_number} scene video ready: ${finalUrl}`);
    return updated;
  }

  /**
   * Resolve the shots array from a scene_description.
   * Supports both the new shots[] schema and legacy single-shot_type schema.
   */
  _resolveShots(scene) {
    if (Array.isArray(scene.shots) && scene.shots.length > 0) {
      return scene.shots.map(s => ({
        shot_type: s.shot_type || 'cinematic',
        narrator_persona_index: Number.isInteger(s.narrator_persona_index) ? s.narrator_persona_index : 0,
        visible_persona_indexes: Array.isArray(s.visible_persona_indexes) ? s.visible_persona_indexes : [],
        subject_visible: !!s.subject_visible,
        visual_direction: s.visual_direction || scene.visual_direction || '',
        camera_notes: s.camera_notes || scene.camera_notes || '',
        dialogue_line: s.dialogue_line || '',
        mood: s.mood || scene.mood || '',
        duration_seconds: s.duration_seconds || 7
      }));
    }
    // Legacy: wrap single shot_type into a one-item shots array
    return [{
      shot_type: scene.shot_type || 'cinematic',
      narrator_persona_index: scene.narrator_persona_index || 0,
      visible_persona_indexes: [],
      subject_visible: false,
      visual_direction: scene.visual_direction || '',
      camera_notes: scene.camera_notes || '',
      dialogue_line: scene.dialogue_script || '',
      mood: scene.mood || '',
      duration_seconds: scene.duration_target_seconds || 10
    }];
  }

  /**
   * Generate one shot via the correct backend (HeyGen / Kling / Veo).
   * Returns { publicVideoUrl, model }.
   */
  async _generateSingleShot(shot, episode, story, userId, shotIdx) {
    const videoPrompt = [
      shot.visual_direction,
      shot.camera_notes ? `Camera: ${shot.camera_notes}` : '',
      shot.mood ? `Mood: ${shot.mood}` : '',
      'Photorealistic, cinematic lighting, 9:16 vertical.'
    ].filter(Boolean).join(' ').slice(0, 1400);

    const isHybrid = process.env.BRAND_STORY_VIDEO_STACK === 'hybrid';

    // ═══════════════════════════════════════════════════════════
    // HYBRID MODE — OmniHuman (dialogue) + Seedance (cinematic/broll) + Kling (multi-entity)
    // ═══════════════════════════════════════════════════════════
    if (isHybrid) {
      // Compute entity count for shot-level routing (B2).
      // entityCount >= 2 triggers Kling for cinematic shots (multi-reference identity lock).
      const visiblePersonas = shot.visible_persona_indexes || [];
      const entityCount = visiblePersonas.length + (shot.subject_visible ? 1 : 0);

      // ── DIALOGUE → OmniHuman 1.5 (via ElevenLabs TTS + fal.ai) ──
      // OmniHuman requires a person image. Only available for persona types that have
      // actual person images: uploaded, brand_kit, described.
      // 'selected' (stock HeyGen avatars) → always use HeyGen for dialogue.
      const omniHumanEligible = ['uploaded', 'brand_kit', 'described'].includes(story.persona_type);
      if (shot.shot_type === 'dialogue' && omniHumanEligible) {
        if (omniHumanService.isAvailable() && ttsService.isAvailable()) {
          try {
            return await this._generateOmniHumanDialogue(shot, episode, story, userId, shotIdx, videoPrompt);
          } catch (ohErr) {
            logger.warn(`[Shot ${shotIdx + 1}] OmniHuman dialogue failed (${ohErr.message})`);
            // In hybrid mode with uploaded/brand_kit/described, HeyGen has NO avatar
            // (we skipped HeyGen setup). Fall back to Seedance cinematic instead.
            if (seedanceService.isAvailable()) {
              logger.info(`[Shot ${shotIdx + 1}] Falling back to Seedance cinematic (no HeyGen avatar in hybrid mode)`);
              try {
                return await this._generateSeedanceCinematic(shot, episode, story, userId, shotIdx, videoPrompt);
              } catch (seedErr) {
                logger.warn(`[Shot ${shotIdx + 1}] Seedance fallback also failed (${seedErr.message})`);
              }
            }
            // Last resort: fall through to legacy path (will likely fail too but let it try)
          }
        } else {
          logger.info(`[Shot ${shotIdx + 1}] hybrid dialogue: OmniHuman/TTS unavailable — falling back to Seedance`);
          if (seedanceService.isAvailable()) {
            try {
              return await this._generateSeedanceCinematic(shot, episode, story, userId, shotIdx, videoPrompt);
            } catch (seedErr) {
              logger.warn(`[Shot ${shotIdx + 1}] Seedance fallback failed (${seedErr.message})`);
            }
          }
        }
        // Fall through to legacy HeyGen dialogue below (last resort)
      } else if (shot.shot_type === 'dialogue' && !omniHumanEligible) {
        logger.info(`[Shot ${shotIdx + 1}] hybrid dialogue: persona_type='${story.persona_type}' → using HeyGen (no person image for OmniHuman)`);
        // Fall through to legacy HeyGen dialogue below
      }

      // ── CINEMATIC with entityCount >= 2 → Kling (multi-entity @Elements) ──
      if (shot.shot_type === 'cinematic' && entityCount >= 2) {
        logger.info(`[Shot ${shotIdx + 1}] hybrid cinematic entityCount=${entityCount} → Kling (multi-entity identity lock)`);
        return this._generateCinematicOrBroll(shot, videoPrompt, episode, story, userId, shotIdx);
      }

      // ── CINEMATIC with entityCount <= 1 → Seedance I2V ──
      if (shot.shot_type === 'cinematic' && entityCount <= 1) {
        if (seedanceService.isAvailable()) {
          try {
            return await this._generateSeedanceCinematic(shot, episode, story, userId, shotIdx, videoPrompt);
          } catch (seedErr) {
            logger.warn(`[Shot ${shotIdx + 1}] Seedance cinematic failed (${seedErr.message}) — falling back to Kling/Veo`);
          }
        }
        // Fall through to legacy
      }

      // ── BROLL → Seedance (I2V with real subject image, or T2V) ──
      if (shot.shot_type === 'broll') {
        if (seedanceService.isAvailable()) {
          try {
            return await this._generateSeedanceBroll(shot, episode, story, userId, shotIdx, videoPrompt);
          } catch (seedErr) {
            logger.warn(`[Shot ${shotIdx + 1}] Seedance broll failed (${seedErr.message}) — falling back to Veo`);
          }
        }
        // Fall through to legacy
      }
    }

    // ═══════════════════════════════════════════════════════════
    // LEGACY MODE — HeyGen (dialogue) + Kling (cinematic) + Veo (broll)
    // Also serves as fallback when hybrid generators fail.
    // ═══════════════════════════════════════════════════════════

    // ───────────── DIALOGUE SHOT → HeyGen ─────────────
    if (shot.shot_type === 'dialogue') {
      if (!heyGenService.isAvailable()) {
        logger.warn(`[Shot ${shotIdx + 1}] dialogue requested but HeyGen unavailable — falling back to cinematic`);
        return this._generateCinematicOrBroll(shot, videoPrompt, episode, story, userId, shotIdx);
      }

      // Select narrator persona for THIS shot
      const personas = Array.isArray(story.persona_config?.personas)
        ? story.persona_config.personas
        : [story.persona_config];
      const idx = Math.max(0, Math.min(shot.narrator_persona_index || 0, personas.length - 1));
      const narratorPersona = personas[idx] || personas[0] || {};
      const avatarId = narratorPersona.heygen_avatar_id || story.heygen_avatar_id;

      if (!avatarId) {
        logger.warn(`[Shot ${shotIdx + 1}] dialogue — no trained avatar, falling back to cinematic`);
        return this._generateCinematicOrBroll(shot, videoPrompt, episode, story, userId, shotIdx);
      }

      const dialogueLine = shot.dialogue_line || shot.visual_direction || 'Continue the story.';
      const isPhotoAvatar = narratorPersona.is_photo_avatar === true
        || (story.persona_type !== 'selected' && !!narratorPersona.heygen_avatar_id);
      const personaVoiceId = narratorPersona.heygen_voice_id || null;

      logger.info(`[Shot ${shotIdx + 1}] HeyGen dialogue (persona ${idx}, avatar=${avatarId}, voice=${personaVoiceId || 'auto'}, photo=${isPhotoAvatar})`);
      const heygenResult = await heyGenService.generateAvatarVideo({
        avatarId,
        script: dialogueLine,
        options: { isPhotoAvatar, voiceId: personaVoiceId, aspectRatio: '9:16', resolution: '1080p' }
      });

      const dl = await axios.get(heygenResult.videoUrl, { responseType: 'arraybuffer', timeout: 120000 });
      const buffer = Buffer.from(dl.data);
      const publicUrl = await this._uploadBufferToStorage(
        buffer,
        userId,
        'videos',
        `shot${shotIdx}-dialogue-${episode.id}.mp4`,
        'video/mp4'
      );
      return { publicVideoUrl: publicUrl, model: 'heygen-avatar-iv' };
    }

    // ───────────── CINEMATIC or BROLL ─────────────
    return this._generateCinematicOrBroll(shot, videoPrompt, episode, story, userId, shotIdx);
  }

  // ═══════════════════════════════════════════════════════════
  // HYBRID MODE — New generation methods
  // ═══════════════════════════════════════════════════════════

  /**
   * Generate dialogue shot via OmniHuman 1.5 (ElevenLabs TTS → fal.ai OmniHuman).
   * Flow: text → ElevenLabs TTS audio → upload to Supabase → OmniHuman (image + audio → lip-synced video).
   * Only called for persona_type in {uploaded, brand_kit, described} — NOT 'selected' (stock HeyGen avatars).
   */
  async _generateOmniHumanDialogue(shot, episode, story, userId, shotIdx, videoPrompt) {
    const personas = Array.isArray(story.persona_config?.personas)
      ? story.persona_config.personas
      : [story.persona_config];
    const idx = Math.max(0, Math.min(shot.narrator_persona_index || 0, personas.length - 1));
    const persona = personas[idx] || personas[0] || {};

    const seedImageUrl = persona.omnihuman_seed_image_url
      || persona.reference_image_urls?.[0]
      || persona.cutout_url;
    if (!seedImageUrl) {
      throw new Error(`Persona ${idx} has no seed image for OmniHuman`);
    }

    const dialogueLine = shot.dialogue_line || shot.visual_direction || 'Continue the story.';
    const voiceId = persona.elevenlabs_voice_id || undefined;

    // Step 1: ElevenLabs TTS → audio
    logger.info(`[Shot ${shotIdx + 1}] OmniHuman dialogue — TTS for persona ${idx}, ${dialogueLine.length} chars`);
    const ttsResult = await ttsService.synthesize({
      text: dialogueLine,
      options: { voiceId, language: persona.language || 'en' }
    });

    // Upload TTS audio to Supabase for a public URL (OmniHuman needs a URL, not a buffer)
    const audioPublicUrl = await this._uploadBufferToStorage(
      ttsResult.audioBuffer,
      userId,
      'audio',
      `tts-shot${shotIdx}-${episode.id}.mp3`,
      'audio/mpeg'
    );

    // Step 2: OmniHuman → lip-synced talking-head video
    logger.info(`[Shot ${shotIdx + 1}] OmniHuman generating — image: ${seedImageUrl.slice(0, 60)}..., audio: ${audioPublicUrl.slice(0, 60)}...`);
    const omniResult = await omniHumanService.generateTalkingHead({
      imageUrl: seedImageUrl,
      audioUrl: audioPublicUrl,
      options: {
        prompt: videoPrompt,
        resolution: '720p'
      }
    });

    // Upload video to Supabase
    const publicUrl = await this._uploadBufferToStorage(
      omniResult.videoBuffer,
      userId,
      'videos',
      `shot${shotIdx}-omnihuman-${episode.id}.mp4`,
      'video/mp4'
    );

    return { publicVideoUrl: publicUrl, model: 'omnihuman-1.5' };
  }

  /**
   * Generate single-entity cinematic shot via Seedance 1.5 Pro (image-to-video).
   * Uses a Leonardo storyboard frame or the real subject image as the start frame.
   */
  async _generateSeedanceCinematic(shot, episode, story, userId, shotIdx, videoPrompt) {
    // Choose start frame based on what's visible
    let startFrameUrl;
    const visiblePersonas = shot.visible_persona_indexes || [];

    if (visiblePersonas.length === 0 && shot.subject_visible) {
      // Subject-only shot: use real product reference image for visual authenticity
      const subjectRefs = this._collectSubjectReferenceImages(story);
      startFrameUrl = subjectRefs[0] || null;
      logger.info(`[Shot ${shotIdx + 1}] Seedance cinematic — subject-only, using real subject image`);
    }

    if (!startFrameUrl && visiblePersonas.length >= 1) {
      // Single persona: generate per-shot Leonardo storyboard
      logger.info(`[Shot ${shotIdx + 1}] Seedance cinematic — single persona, generating Leonardo storyboard`);
      try {
        startFrameUrl = await this._generateShotStoryboardFrame(shot, story, userId, shotIdx);
      } catch (frameErr) {
        logger.warn(`[Shot ${shotIdx + 1}] storyboard failed: ${frameErr.message}`);
      }
    }

    if (!startFrameUrl) {
      // Pure environment or fallback — generate storyboard from visual_direction
      logger.info(`[Shot ${shotIdx + 1}] Seedance cinematic — no refs, generating Leonardo storyboard from visual_direction`);
      try {
        startFrameUrl = await this._generateShotStoryboardFrame(shot, story, userId, shotIdx);
      } catch (frameErr) {
        logger.warn(`[Shot ${shotIdx + 1}] storyboard fallback failed: ${frameErr.message}`);
        throw new Error('No start frame available for Seedance cinematic');
      }
    }

    const clampedDuration = Math.min(Math.max(shot.duration_seconds || 5, 4), 15);
    logger.info(`[Shot ${shotIdx + 1}] Seedance I2V cinematic — ${clampedDuration}s, 720p, startFrame: ${startFrameUrl.slice(0, 60)}...`);

    const seedResult = await seedanceService.generateImageToVideo({
      prompt: videoPrompt,
      imageUrl: startFrameUrl,
      options: {
        duration: clampedDuration,
        aspectRatio: '9:16',
        resolution: '720p',
        generateAudio: true
      }
    });

    const publicUrl = await this._uploadBufferToStorage(
      seedResult.videoBuffer,
      userId,
      'videos',
      `shot${shotIdx}-seedance-cin-${episode.id}.mp4`,
      'video/mp4'
    );

    return { publicVideoUrl: publicUrl, model: 'seedance-1.5-pro-i2v' };
  }

  /**
   * Generate broll shot via Seedance 1.5 Pro.
   * Mirrors the current Veo pattern: use real subject reference image as start frame
   * for visual authenticity (not a Leonardo hallucination).
   */
  async _generateSeedanceBroll(shot, episode, story, userId, shotIdx, videoPrompt) {
    const subjectRefs = this._collectSubjectReferenceImages(story);
    const clampedDuration = Math.min(Math.max(shot.duration_seconds || 5, 4), 15);

    let seedResult;
    if (subjectRefs.length > 0) {
      // I2V with real subject image as start frame
      logger.info(`[Shot ${shotIdx + 1}] Seedance broll I2V — real subject image, ${clampedDuration}s`);
      seedResult = await seedanceService.generateImageToVideo({
        prompt: videoPrompt,
        imageUrl: subjectRefs[0],
        options: {
          duration: clampedDuration,
          aspectRatio: '9:16',
          resolution: '720p',
          generateAudio: true
        }
      });
    } else {
      // T2V — no subject reference available
      logger.info(`[Shot ${shotIdx + 1}] Seedance broll T2V — no subject refs, ${clampedDuration}s`);
      seedResult = await seedanceService.generateTextToVideo({
        prompt: videoPrompt,
        options: {
          duration: clampedDuration,
          aspectRatio: '9:16',
          resolution: '720p',
          generateAudio: true
        }
      });
    }

    const publicUrl = await this._uploadBufferToStorage(
      seedResult.videoBuffer,
      userId,
      'videos',
      `shot${shotIdx}-seedance-broll-${episode.id}.mp4`,
      'video/mp4'
    );

    return { publicVideoUrl: publicUrl, model: seedResult.model };
  }

  /**
   * Generate cinematic/broll shot via Kling (cinematic, identity-locked) or Veo (broll).
   * Generates a per-shot storyboard frame as the starting keyframe.
   */
  async _generateCinematicOrBroll(shot, videoPrompt, episode, story, userId, shotIdx) {
    // Generate a per-shot storyboard frame for Kling/Veo starting keyframe
    let storyboardUrl = episode.storyboard_frame_url; // fallback to episode-level frame
    try {
      storyboardUrl = await this._generateShotStoryboardFrame(shot, story, userId, shotIdx);
    } catch (frameErr) {
      logger.warn(`[Shot ${shotIdx + 1}] storyboard frame failed: ${frameErr.message} — using episode frame`);
    }

    let result;

    // Cinematic via Kling (preferred — identity-locked with both persona AND subject refs)
    if (shot.shot_type === 'cinematic' && klingService.isAvailable()) {
      const combinedRefs = this._buildKlingReferenceImages(story);
      if (combinedRefs.length > 0) {
        const focus = story.story_focus || 'product';
        logger.info(`[Shot ${shotIdx + 1}] Kling cinematic (focus=${focus}) with ${combinedRefs.length} combined ref(s)`);
        try {
          const klingDuration = shot.duration_seconds >= 8 ? 10 : 5;
          result = await klingService.generateReferenceVideo({
            referenceImages: combinedRefs,
            prompt: videoPrompt,
            options: { duration: klingDuration, aspectRatio: '9:16' }
          });
        } catch (klingErr) {
          logger.warn(`[Shot ${shotIdx + 1}] Kling failed (${klingErr.message}) — falling back to Veo`);
        }
      }
    }

    // Fallback OR broll → Veo. For broll shots, prefer the user's real subject image
    // as the starting keyframe so Veo animates the ACTUAL product/place, not Leonardo's hallucination.
    if (!result) {
      let veoKeyframeUrl = storyboardUrl;
      if (shot.shot_type === 'broll') {
        const subjectRefs = this._collectSubjectReferenceImages(story);
        if (subjectRefs.length > 0) {
          veoKeyframeUrl = subjectRefs[0];
          logger.info(`[Shot ${shotIdx + 1}] broll via Veo — using REAL subject image as keyframe`);
        } else {
          logger.info(`[Shot ${shotIdx + 1}] broll via Veo — no subject refs, using storyboard frame`);
        }
      } else {
        logger.info(`[Shot ${shotIdx + 1}] ${shot.shot_type} via Veo`);
      }
      result = await videoGenerationService.generateVideo({
        imageUrl: veoKeyframeUrl,
        prompt: videoPrompt
      });
    }

    // Upload to Supabase
    let publicUrl = result.videoUrl;
    if (result.videoBuffer) {
      try {
        publicUrl = await this._uploadBufferToStorage(
          result.videoBuffer,
          userId,
          'videos',
          `shot${shotIdx}-${shot.shot_type}-${episode.id}.mp4`,
          'video/mp4'
        );
      } catch (uploadErr) {
        logger.error(`[Shot ${shotIdx + 1}] upload failed: ${uploadErr.message}`);
      }
    }

    return { publicVideoUrl: publicUrl, model: result.model };
  }

  /**
   * Generate a per-shot storyboard frame via Leonardo Kino XL.
   * For product/landscape focus, upload the user's real subject image as a Leonardo init-image
   * and use it as the styleRefId so the storyboard actually features the real product/place.
   */
  async _generateShotStoryboardFrame(shot, story, userId, shotIdx) {
    if (!leonardoService.isAvailable()) {
      throw new Error('Leonardo not available');
    }

    // Reuse story's character reference (already uploaded once per story)
    let brandKit = {};
    if (story.brand_kit_job_id) {
      const job = await getMediaTrainingJobById(story.brand_kit_job_id, userId);
      if (job?.brand_kit) brandKit = job.brand_kit;
    }

    // Lazy-upload the subject image to Leonardo ONCE per story and cache its init-image id.
    // For product/landscape focus, the subject IS the brand identity — it should anchor
    // every storyboard frame.
    let styleRefId = story.leonardo_style_ref_id || null;
    const focus = story.story_focus || 'product';
    if (!styleRefId && (focus === 'product' || focus === 'landscape')) {
      const subjectRefs = this._collectSubjectReferenceImages(story);
      if (subjectRefs.length > 0) {
        try {
          styleRefId = await leonardoService.uploadReferenceImage(subjectRefs[0]);
          await updateBrandStory(story.id, userId, { leonardo_style_ref_id: styleRefId });
          logger.info(`Leonardo style ref uploaded (subject) for story ${story.id}: ${styleRefId}`);
        } catch (refErr) {
          logger.warn(`Leonardo subject style-ref upload failed: ${refErr.message}`);
        }
      }
    }

    const prompt = getStoryboardPrompt(shot, story.persona_config, brandKit, { subject: story.subject, storyFocus: focus });
    const result = await leonardoService.generateFrame({
      prompt,
      characterRefId: story.leonardo_character_ref_id || null,
      styleRefId
    });
    return result.imageUrl;
  }

  /**
   * Concatenate multiple shot MP4s into one episode video via ffmpeg concat demuxer.
   * Re-encodes to normalize codecs + aspect ratio, then uploads to Supabase.
   */
  async _concatShots(generatedShots, userId, episodeId) {
    const tmpDir = os.tmpdir();
    const rawFiles = [];
    const normalizedFiles = [];
    const listFile = path.join(tmpDir, `concat-${episodeId}.txt`);
    const outputFile = path.join(tmpDir, `episode-${episodeId}.mp4`);

    try {
      // Step 1: Download each shot to tmp
      for (const s of generatedShots) {
        const localPath = path.join(tmpDir, `shot-${episodeId}-${s.index}-raw.mp4`);
        const dl = await axios.get(s.video_url, { responseType: 'arraybuffer', timeout: 120000 });
        await fs.writeFile(localPath, Buffer.from(dl.data));
        rawFiles.push(localPath);
      }

      // Step 2: Normalize each shot individually to identical format.
      // Different generators (Kling, Seedance, HeyGen, Veo) produce different codecs,
      // resolutions, frame rates, and H.264 NAL unit formats. The concat demuxer can't
      // handle these differences — it chokes on mismatched NAL units at file boundaries.
      // By re-encoding each shot to an identical format first, concat can stream-copy safely.
      for (let i = 0; i < rawFiles.length; i++) {
        const normPath = path.join(tmpDir, `shot-${episodeId}-${i}-norm.mp4`);
        normalizedFiles.push(normPath);

        logger.info(`Normalizing shot ${i + 1}/${rawFiles.length}...`);
        await execFileAsync('ffmpeg', [
          '-y',
          '-i', rawFiles[i],
          '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1',
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '18',
          '-profile:v', 'high',
          '-level', '4.2',
          '-pix_fmt', 'yuv420p',
          '-r', '30',
          '-c:a', 'aac',
          '-b:a', '256k',
          '-ar', '48000',
          '-ac', '2',
          normPath
        ], { timeout: 120000 }); // 2 min per shot
      }

      // Step 3: Concat the normalized files (now all identical format — stream copy is safe)
      const listContent = normalizedFiles.map(f => `file '${f}'`).join('\n');
      await fs.writeFile(listFile, listContent);

      await execFileAsync('ffmpeg', [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', listFile,
        '-c', 'copy',
        '-movflags', '+faststart',
        outputFile
      ], { timeout: 60000 }); // Fast — just stream copy

      // Upload composite
      const compositeBuffer = await fs.readFile(outputFile);
      const publicUrl = await this._uploadBufferToStorage(
        compositeBuffer,
        userId,
        'videos',
        `episode-${episodeId}-composite.mp4`,
        'video/mp4'
      );
      logger.info(`Episode composite uploaded (${(compositeBuffer.length / 1024 / 1024).toFixed(1)}MB): ${publicUrl}`);
      return publicUrl;
    } finally {
      // Cleanup tmp files
      await Promise.allSettled([
        ...rawFiles.map(f => fs.unlink(f)),
        ...normalizedFiles.map(f => fs.unlink(f)),
        fs.unlink(listFile),
        fs.unlink(outputFile)
      ]);
    }
  }

  /**
   * Parse JSON from Gemini with defensive repair for known quirks:
   *   - Trailing `}` or `]` characters emitted after the actual JSON object
   *   - Markdown code fences (```json ... ```)
   *   - Leading/trailing whitespace
   */
  _parseGeminiJson(raw) {
    let text = (raw || '').trim();

    // Strip markdown code fences if present
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

    // Try parsing as-is first
    try {
      return JSON.parse(text);
    } catch (err) {
      // Repair: find the matching closing brace by counting nesting depth
      // and truncate anything after it.
      const startChar = text[0];
      if (startChar !== '{' && startChar !== '[') throw err;
      const openChar = startChar;
      const closeChar = startChar === '{' ? '}' : ']';
      let depth = 0;
      let inString = false;
      let escape = false;
      let endIdx = -1;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (escape) { escape = false; continue; }
        if (c === '\\') { escape = true; continue; }
        if (c === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (c === openChar) depth++;
        else if (c === closeChar) {
          depth--;
          if (depth === 0) { endIdx = i; break; }
        }
      }
      if (endIdx === -1) throw err;
      const trimmed = text.slice(0, endIdx + 1);
      return JSON.parse(trimmed);
    }
  }

  /**
   * Collect persona reference image URLs from a story for Kling identity conditioning.
   * Returns up to 4 URLs (Kling's max).
   */
  _collectPersonaReferenceImages(story) {
    const personas = Array.isArray(story.persona_config?.personas)
      ? story.persona_config.personas
      : [story.persona_config];

    const urls = [];
    for (const p of personas) {
      if (!p) continue;
      // brand_kit personas have cutout_url
      if (p.cutout_url) urls.push(p.cutout_url);
      // uploaded/described personas have reference_image_urls[]
      if (Array.isArray(p.reference_image_urls)) urls.push(...p.reference_image_urls);
    }
    // Deduplicate and cap at 4 (Kling Elements max)
    return [...new Set(urls)].slice(0, 4);
  }

  /**
   * Collect subject reference image URLs from a story.
   * These are the user's real product/place photos — the BRAND identity to preserve.
   */
  _collectSubjectReferenceImages(story) {
    const urls = Array.isArray(story.subject?.reference_image_urls)
      ? story.subject.reference_image_urls
      : [];
    return [...new Set(urls)].slice(0, 4);
  }

  /**
   * Build the reference image array for Kling, prioritized by story_focus.
   * Kling 3.0 Pro accepts up to 4 reference images total (@Element1..@Element4 in prompt).
   *
   * Priority rules:
   *   person    → persona refs first (identity locked), subject refs as secondary
   *   product   → subject refs first (product IS the hero), persona refs secondary
   *   landscape → subject refs first (place IS the hero), persona refs secondary
   */
  _buildKlingReferenceImages(story) {
    const focus = story.story_focus || 'product';
    const personaRefs = this._collectPersonaReferenceImages(story);
    const subjectRefs = this._collectSubjectReferenceImages(story);

    let combined;
    if (focus === 'person') {
      // Persona dominant, subject supporting
      combined = [...personaRefs.slice(0, 2), ...subjectRefs.slice(0, 2)];
    } else {
      // Subject dominant, persona supporting (product/landscape)
      combined = [...subjectRefs.slice(0, 2), ...personaRefs.slice(0, 2)];
    }
    // Dedupe + cap at Kling's 4 total
    return [...new Set(combined)].slice(0, 4);
  }

  /**
   * Upload a video buffer to Supabase Storage and return the public URL.
   * Delegates to _uploadBufferToStorage.
   * @param {Buffer} buffer - Video MP4 buffer
   * @param {string} userId
   * @param {string} filename - e.g. "scene-uuid.mp4"
   * @returns {Promise<string>} Public URL
   */
  async _uploadVideoToStorage(buffer, userId, filename) {
    return this._uploadBufferToStorage(buffer, userId, 'videos', filename, 'video/mp4');
  }

  /**
   * Augment a single seed persona image into N angle/expression variations via
   * Leonardo Kino XL Character Reference ControlNet. Used to meet HeyGen's
   * minimum-10-images training requirement when the user provides fewer.
   *
   * Runs variations in parallel for speed.
   *
   * @param {string} seedImageUrl - Public URL of the original persona image
   * @param {string} userId
   * @param {number} personaIndex - For logging/file naming
   * @param {number} count - How many variations to generate
   * @returns {Promise<string[]>} Array of public Supabase URLs for the augmented images
   */
  async _augmentPersonaImagesForTraining(seedImageUrl, userId, personaIndex, count) {
    if (!leonardoService.isAvailable()) {
      throw new Error('LEONARDO_API_KEY required for persona image augmentation');
    }

    // Upload seed to Leonardo ONCE — reuse the character ref across all variations
    logger.info(`[P${personaIndex + 1}] Uploading seed to Leonardo as character reference...`);
    const characterRefId = await leonardoService.uploadReferenceImage(seedImageUrl);

    // Diverse angle/expression prompts for training variety
    const variations = [
      'front view, neutral expression, soft studio lighting, looking at camera',
      '3/4 angle view, slight smile, natural daylight',
      'profile side view, serious expression, dramatic lighting',
      'close-up headshot, confident expression, shallow depth of field',
      'medium shot, looking off-camera, golden hour lighting',
      'looking directly at camera, warm welcoming expression',
      'slight head tilt, contemplative expression, soft lighting',
      'close-up, subtle smile, professional headshot lighting',
      'three-quarter view, thoughtful expression, window light',
      'front view, confident look, editorial portrait lighting',
      'slightly upward angle, inspired expression, rim light',
      'side profile close-up, focused expression'
    ];

    const selectedVariations = variations.slice(0, count);

    logger.info(`[P${personaIndex + 1}] Generating ${count} Leonardo variations in parallel...`);

    // Generate in parallel — independent jobs
    const results = await Promise.allSettled(
      selectedVariations.map((variationPrompt, i) => this._generateAndUploadVariation(
        variationPrompt,
        characterRefId,
        userId,
        personaIndex,
        i
      ))
    );

    // Collect successful URLs (failures log a warning but don't fail the whole batch)
    const urls = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value) {
        urls.push(r.value);
      } else {
        logger.warn(`[P${personaIndex + 1}] Variation ${i + 1} failed: ${r.reason?.message || 'unknown'}`);
      }
    });

    logger.info(`[P${personaIndex + 1}] Augmentation complete — ${urls.length}/${count} variations succeeded`);
    return urls;
  }

  /**
   * Generate one Leonardo variation + upload to Supabase.
   * Extracted so the parallel loop above stays clean.
   */
  async _generateAndUploadVariation(variationPrompt, characterRefId, userId, personaIndex, variationIndex) {
    const prompt = `Photorealistic portrait of the same person, ${variationPrompt}. Same facial features, same identity. Film grain, 50mm lens, cinematic quality.`;

    const result = await leonardoService.generateFrame({
      prompt,
      characterRefId,
      options: { width: 768, height: 1024, numImages: 1, presetStyle: 'CINEMATIC' }
    });

    // Leonardo returns a CDN URL. Download + rehost on Supabase for reliable HeyGen access.
    const imageResp = await axios.get(result.imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30000
    });
    const buffer = Buffer.from(imageResp.data);

    const publicUrl = await this._uploadBufferToStorage(
      buffer,
      userId,
      'persona-augmented',
      `persona${personaIndex}-var${variationIndex}.jpg`,
      'image/jpeg'
    );

    return publicUrl;
  }

  /**
   * Upload any buffer (image or video) to Supabase Storage and return the public URL.
   * @param {Buffer} buffer - File buffer
   * @param {string} userId
   * @param {string} subfolder - e.g. "videos" | "persona-augmented"
   * @param {string} filename - e.g. "scene-uuid.mp4" | "angle-3.jpg"
   * @param {string} contentType - MIME type, e.g. "video/mp4" | "image/jpeg"
   * @returns {Promise<string>} Public URL
   */
  async _uploadBufferToStorage(buffer, userId, subfolder, filename, contentType) {
    const { supabaseAdmin } = await import('./supabase.js');
    const STORAGE_BUCKET = 'media-assets';
    const storagePath = `${userId}/brand-stories/${subfolder}/${Date.now()}-${filename}`;

    const { error } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, buffer, { contentType, upsert: false });

    if (error) throw new Error(`Storage upload failed: ${error.message}`);

    const { data: urlData } = supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .getPublicUrl(storagePath);

    return urlData.publicUrl;
  }

  // ═══════════════════════════════════════════════════
  // VIDEO COMPOSITING (ffmpeg)
  // ═══════════════════════════════════════════════════

  /**
   * Composite the avatar narration over the scene video using ffmpeg.
   * Picture-in-picture: avatar in bottom-right corner over the scene.
   *
   * @param {string} episodeId
   * @param {string} userId
   * @returns {Promise<Object>} Updated episode with final_video_url
   */
  async compositeVideo(episodeId, userId) {
    const episode = await getBrandStoryEpisodeById(episodeId, userId);
    if (!episode) throw new Error('Episode not found');

    if (!episode.scene_video_url) throw new Error('No scene video available');

    // With shot-type routing, the scene_video_url IS already the final video:
    //   - dialogue shots: scene_video_url == avatar_video_url (HeyGen)
    //   - cinematic shots: scene_video_url == Kling output
    //   - broll shots: scene_video_url == Veo output
    // No compositing needed — just promote to final_video_url.
    logger.info(`Finalizing episode ${episode.episode_number} (${episode.scene_description?.shot_type || 'cinematic'} shot)`);
    return updateBrandStoryEpisode(episodeId, userId, {
      final_video_url: episode.scene_video_url,
      status: 'ready'
    });
  }

  /**
   * (Legacy) Compositing via ffmpeg PiP — no longer used with shot-type routing.
   * Kept for reference in case compositing is ever needed again.
   */
  async _compositeVideoPiP(episodeId, userId) {
    const episode = await getBrandStoryEpisodeById(episodeId, userId);
    if (!episode || !episode.scene_video_url || !episode.avatar_video_url) return episode;

    logger.info(`Compositing video for episode ${episode.episode_number} (${episodeId})`);
    await updateBrandStoryEpisode(episodeId, userId, { status: 'compositing' });

    const tmpDir = os.tmpdir();
    const sceneFile = path.join(tmpDir, `scene_${episodeId}.mp4`);
    const avatarFile = path.join(tmpDir, `avatar_${episodeId}.mp4`);
    const outputFile = path.join(tmpDir, `composite_${episodeId}.mp4`);

    try {
      // Download both videos
      const [sceneData, avatarData] = await Promise.all([
        axios.get(episode.scene_video_url, { responseType: 'arraybuffer', timeout: 60000 }),
        axios.get(episode.avatar_video_url, { responseType: 'arraybuffer', timeout: 60000 })
      ]);

      await Promise.all([
        fs.writeFile(sceneFile, Buffer.from(sceneData.data)),
        fs.writeFile(avatarFile, Buffer.from(avatarData.data))
      ]);

      // Picture-in-picture: avatar (scaled to 25% width) in bottom-right corner
      // Use shortest duration to avoid desync
      await execFileAsync('ffmpeg', [
        '-y',
        '-i', sceneFile,
        '-i', avatarFile,
        '-filter_complex',
        '[1:v]scale=iw*0.25:-1[avatar];[0:v][avatar]overlay=W-w-20:H-h-20:shortest=1',
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        // Use audio from avatar (narration), fall back to scene audio
        '-map', '0:v',
        '-map', '1:a?',
        '-map', '0:a?',
        '-shortest',
        outputFile
      ], { timeout: 120000 });

      // Read the composited file
      const compositeBuffer = await fs.readFile(outputFile);

      // Upload to a temporary accessible location
      // For now, we'll use a data URL or return the local path
      // In production, this would upload to Supabase Storage
      const finalVideoUrl = episode.scene_video_url; // Fallback: use scene video URL
      // TODO: Upload compositeBuffer to Supabase Storage and get a public URL

      logger.info(`Video composited for episode ${episode.episode_number} — ${compositeBuffer.length} bytes`);

      const updated = await updateBrandStoryEpisode(episodeId, userId, {
        final_video_url: finalVideoUrl,
        status: 'ready'
      });

      return updated;
    } catch (error) {
      logger.error(`ffmpeg compositing failed for episode ${episodeId}: ${error.message}`);
      // Fall back to scene video without avatar overlay
      const updated = await updateBrandStoryEpisode(episodeId, userId, {
        final_video_url: episode.scene_video_url,
        status: 'ready',
        error_message: `Compositing failed (using scene video): ${error.message}`
      });
      return updated;
    } finally {
      // Clean up temp files
      await Promise.allSettled([
        fs.unlink(sceneFile),
        fs.unlink(avatarFile),
        fs.unlink(outputFile)
      ]);
    }
  }

  // ═══════════════════════════════════════════════════
  // FULL EPISODE PIPELINE
  // ═══════════════════════════════════════════════════

  /**
   * Run the complete episode generation pipeline:
   * 1. Generate scene description (Gemini)
   * 2. Generate storyboard frame (Leonardo.ai)
   * 3. Generate avatar narration (HeyGen) — if avatar configured
   * 4. Generate scene video (Veo/Runway)
   * 5. Composite final video (ffmpeg)
   *
   * @param {string} storyId
   * @param {string} userId
   * @param {Function} [onProgress] - Optional progress callback (stage, detail)
   * @returns {Promise<Object>} The completed episode record
   */
  async runEpisodePipeline(storyId, userId, onProgress) {
    // Pipeline version routing — v2 uses the cinematic pipeline
    const pipelineVersion = process.env.BRAND_STORY_PIPELINE || 'v2';
    if (pipelineVersion === 'v2') {
      return this.runCinematicPipeline(storyId, userId, onProgress);
    }

    // v1 legacy pipeline below
    const progress = (stage, detail) => {
      logger.info(`[Pipeline] ${stage}: ${detail}`);
      if (onProgress) onProgress(stage, detail);
    };

    try {
      // Step 1: Generate scene description (multi-shot structure)
      progress('scene', 'Generating scene description...');
      const episode = await this.generateNextEpisode(storyId, userId);
      const shots = this._resolveShots(episode.scene_description || {});
      const shotSummary = shots.map(s => s.shot_type).join(' → ');
      progress('scene', `Episode ${episode.episode_number}: [${shotSummary}]`);

      // Step 2: If ANY shot is dialogue, wait for avatar training to finish
      const hasDialogueShot = shots.some(s => s.shot_type === 'dialogue');
      if (hasDialogueShot) {
        await this._waitForAvatarReadyIfProcessing(storyId, userId, progress);
      }

      // Step 3: Generate all shots + concat them into the episode video.
      // generateSceneVideo() now handles per-shot dispatch, storyboard frames,
      // and ffmpeg concatenation internally.
      progress('video', `Generating ${shots.length} shot(s)...`);
      await this.generateSceneVideo(episode.id, userId);

      // Step 4: Finalize — promote scene_video_url to final_video_url
      progress('composite', 'Finalizing...');
      await this.compositeVideo(episode.id, userId);

      progress('complete', `Episode ${episode.episode_number} ready!`);

      return getBrandStoryEpisodeById(episode.id, userId);
    } catch (error) {
      logger.error(`Episode pipeline failed for story ${storyId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * If the avatar is currently training (pending/processing), wait briefly for
   * it to complete. Used before dialogue shots to avoid unnecessary failures.
   */
  async _waitForAvatarReadyIfProcessing(storyId, userId, progress) {
    const MAX_WAIT_MS = 180000; // 3 minutes
    const POLL_MS = 15000;
    const started = Date.now();

    while (Date.now() - started < MAX_WAIT_MS) {
      const story = await getBrandStoryById(storyId, userId);
      const trainingStatus = story?.persona_config?.training_status;

      // Already completed/failed — proceed
      if (!trainingStatus || ['completed', 'failed', 'skipped'].includes(trainingStatus)) {
        return;
      }

      // Still pending/processing — wait
      progress('avatar', `Waiting for avatar training (${trainingStatus})...`);
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
    logger.warn(`Avatar still processing after ${MAX_WAIT_MS / 1000}s — proceeding anyway`);
  }

  // ═══════════════════════════════════════════════════
  // HEYGEN AVATAR SETUP
  // ═══════════════════════════════════════════════════

  /**
   * Set up HeyGen avatars for a story — trains ALL personas in persona_config.
   * Delegates to _autoSetupAvatar for the unified multi-persona training flow.
   *
   * @param {string} storyId
   * @param {string} userId
   * @returns {Promise<Object>} Updated story
   */
  async setupAvatar(storyId, userId) {
    await this._autoSetupAvatar(storyId, userId);
    return getBrandStoryById(storyId, userId);
  }

  /**
   * @deprecated Legacy single-persona setup. Use _autoSetupAvatar (multi-persona).
   */
  async _setupAvatarLegacy(storyId, userId) {
    if (!heyGenService.isAvailable()) throw new Error('HeyGen is not configured');

    const story = await getBrandStoryById(storyId, userId);
    if (!story) throw new Error('Story not found');

    // Primary persona (personas[0]) is the narrator/HeyGen avatar.
    // persona_config shape: { personas: [ {...}, ... ] }
    const personas = Array.isArray(story.persona_config?.personas)
      ? story.persona_config.personas
      : [story.persona_config];
    const primary = personas[0] || {};

    if (story.persona_type === 'selected') {
      // Avatar already selected — just verify it's set
      if (!primary?.heygen_avatar_id) {
        throw new Error('Primary selected persona has no heygen_avatar_id');
      }
      const updated = await updateBrandStory(storyId, userId, {
        heygen_avatar_id: primary.heygen_avatar_id,
        persona_config: {
          ...(story.persona_config || {}),
          training_status: 'completed'
        }
      });
      return updated;
    }

    // Both 'uploaded', 'brand_kit', AND 'described' (which _autoSetupAvatar has
    // converted to have reference_image_urls) take the Photo Avatar Group training path.
    if (story.persona_type === 'uploaded' || story.persona_type === 'brand_kit' || story.persona_type === 'described') {
      // Create a Photo Avatar Group from the primary persona's reference images.
      // 'uploaded': user-provided face photos (reference_image_urls)
      // 'brand_kit': cutout image extracted from the user's Brand Kit (cutout_url)
      const imageUrls = story.persona_type === 'brand_kit'
        ? (primary?.cutout_url ? [primary.cutout_url] : [])
        : (primary?.reference_image_urls || []);

      if (imageUrls.length === 0) {
        throw new Error(`Primary ${story.persona_type} persona has no reference images`);
      }

      logger.info(`Creating Photo Avatar Group for story ${storyId} (${story.persona_type})`);
      const group = await heyGenService.createPhotoAvatarGroup(story.name, imageUrls);

      // Train the group
      await heyGenService.trainPhotoAvatarGroup(group.groupId);

      // Wait for training to complete
      const trained = await heyGenService.waitForAvatarGroupTraining(group.groupId);

      // Save the avatar references (store training metadata at persona_config root)
      const updated = await updateBrandStory(storyId, userId, {
        heygen_avatar_group_id: group.groupId,
        heygen_avatar_id: trained.avatarId,
        persona_config: {
          ...(story.persona_config || {}),
          heygen_avatar_group_id: group.groupId,
          training_status: 'completed'
        }
      });

      return updated;
    }

    // 'described' persona type — avatar will be created later or user selects one
    logger.info(`Persona type "${story.persona_type}" does not require immediate avatar setup`);
    return story;
  }

  /**
   * List available HeyGen stock avatars.
   */
  async listStockAvatars() {
    if (!heyGenService.isAvailable()) throw new Error('HeyGen is not configured');
    return heyGenService.listStockAvatars();
  }

  /**
   * List HeyGen voices for the voice-picker UI.
   * Filters: { language?, gender? } — narrows to English+matching gender by default.
   */
  async listVoices({ language = 'en', gender = null } = {}) {
    if (!heyGenService.isAvailable()) throw new Error('HeyGen is not configured');
    const all = await heyGenService.listVoices();
    return all
      .filter(v => !language || (v.language || '').toLowerCase().startsWith(language.toLowerCase()))
      .filter(v => !gender || (v.gender || '').toLowerCase() === gender.toLowerCase())
      .map(v => ({
        voice_id: v.voice_id,
        name: v.name,
        gender: v.gender,
        language: v.language,
        preview_audio: v.preview_audio
      }));
  }

  /**
   * Auto-pick a HeyGen stock avatar that best fits a product/landscape story focus.
   * Used when the user clicks "Auto Assign Best Fit Character" in the wizard.
   *
   * Scoring heuristic:
   *   - Professional/business keywords in name: +2
   *   - Has a preview image: +1
   *   - Subject hint keyword matches name: +3
   *   - Focus-specific nudge keywords: +1
   * Deterministic tie-break via hash(subjectHint + focus) so repeat clicks are stable.
   *
   * @param {Object} params
   * @param {string} params.focus - 'product' | 'landscape' (not valid for 'person')
   * @param {string} [params.subjectHint] - Optional subject category/name for keyword matching
   * @returns {Promise<Object|null>} { avatarId, name, previewUrl, gender } or null
   */
  async autoPickStockAvatar({ focus, subjectHint = '' }) {
    if (!heyGenService.isAvailable()) throw new Error('HeyGen is not configured');

    const all = await heyGenService.listStockAvatars();
    if (!all.length) return null;

    const subjectTerms = String(subjectHint).toLowerCase().split(/\s+/).filter(Boolean);

    // HeyGen avatar names are descriptive (e.g. "Professional Presenter — Business Suit")
    const PRO_KEYWORDS = ['professional', 'business', 'suit', 'office', 'corporate', 'executive', 'studio', 'presenter', 'host'];

    const scored = all
      .filter(a => a.previewUrl) // exclude avatars with missing previews
      .map(a => {
        const name = (a.name || '').toLowerCase();
        let score = 0;
        if (PRO_KEYWORDS.some(kw => name.includes(kw))) score += 2;
        if (a.previewUrl) score += 1;
        if (subjectTerms.some(t => t && t.length > 2 && name.includes(t))) score += 3;
        // Focus-specific nudges
        if (focus === 'landscape' && (name.includes('casual') || name.includes('outdoor') || name.includes('guide'))) score += 1;
        if (focus === 'product' && (name.includes('presenter') || name.includes('host') || name.includes('showcase'))) score += 1;
        return { ...a, _score: score };
      });

    if (scored.length === 0) return null;

    // Pick top tier
    const maxScore = Math.max(...scored.map(a => a._score));
    const topTier = scored.filter(a => a._score === maxScore);

    // Deterministic tie-break — same subjectHint + focus always picks same avatar
    const hashInput = `${subjectHint}|${focus}`;
    const hash = [...hashInput].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0);
    const chosen = topTier[Math.abs(hash) % topTier.length];

    logger.info(`Auto-picked avatar "${chosen.name}" (score=${chosen._score}) for focus=${focus} subject_hint="${subjectHint}"`);
    return {
      avatarId: chosen.avatarId,
      name: chosen.name,
      previewUrl: chosen.previewUrl,
      gender: chosen.gender
    };
  }
  // ═══════════════════════════════════════════════════
  // AUTO-GENERATE PERSONA FROM BRAND KIT
  // ═══════════════════════════════════════════════════

  /**
   * Generate persona(s) that match a Brand Kit's identity.
   * Uses Gemini to design the character(s) from brand analysis,
   * then Flux 2 Max to generate a reference portrait.
   *
   * @param {string} brandKitJobId - ID of the Brand Kit media training job
   * @param {string} userId
   * @param {Object} options - { count: 1-3, storyFocus: 'person'|'product'|'landscape' }
   * @returns {Promise<Object[]>} Array of persona objects with reference_image_urls
   */
  async generatePersonaFromBrandKit(brandKitJobId, userId, options = {}) {
    const { count = 1, storyFocus = 'product' } = options;

    // Load Brand Kit analysis
    const job = await getMediaTrainingJobById(brandKitJobId, userId);
    if (!job?.brand_kit) throw new Error('Brand Kit has no analysis — run Brand Kit analysis first');

    const brandKit = job.brand_kit;
    const brandContext = _buildBrandKitContextBlock(brandKit);

    // Step 1: Gemini 3 Flash generates persona descriptions that fit the brand
    const apiKey = process.env.GOOGLE_AI_STUDIO_API_KEY;
    if (!apiKey) throw new Error('GOOGLE_AI_STUDIO_API_KEY not set');

    const focusGuidance = storyFocus === 'person'
      ? 'This persona IS the star — a compelling, camera-ready individual whose face and presence will anchor every episode. Design someone who looks like a lead actor in a prestige TV series.'
      : storyFocus === 'landscape'
        ? 'This persona is a GUIDE through a beautiful space — think travel host, architecture narrator, or real estate presenter. They should look approachable, expressive, and photogenic but not steal focus from the environment.'
        : 'This persona interacts with a PRODUCT — think lifestyle model, product reviewer, or brand ambassador. They should look authentic, relatable to the target audience, and complement the product aesthetically.';

    const systemPrompt = `You are a casting director for a premium branded short-film series. Design ${count} fictional character(s) whose appearance, vibe, and energy perfectly match the brand identity below.

${brandContext}

${focusGuidance}

For each character, provide:
- "name": A fitting first name
- "appearance": Detailed physical description for AI image generation (age range, ethnicity, build, hair, facial features, expression, clothing style). Be SPECIFIC — this drives a portrait generator. 100+ words.
- "personality": 2-3 personality traits that fit the brand's tone
- "wardrobe_hint": What they'd wear in the first episode (matches brand aesthetic)

CRITICAL: The appearance must feel AUTHENTIC to the brand's target audience and aesthetic. A luxury brand gets refined, elegant personas. A streetwear brand gets edgy, urban personas. A wellness brand gets serene, natural personas.

Respond with ONLY valid JSON: { "personas": [ { "name", "appearance", "personality", "wardrobe_hint" } ] }`;

    const response = await axios.post(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
      contents: [
        { role: 'user', parts: [{ text: systemPrompt }] }
      ],
      generationConfig: {
        maxOutputTokens: 4096,
        temperature: 0.9,
        responseMimeType: 'application/json'
      }
    }, { timeout: 30000 });

    const raw = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) throw new Error('Gemini returned empty response for persona generation');

    const parsed = this._parseGeminiJson(raw);
    const geminiPersonas = parsed.personas || [parsed];

    // Step 2: Generate a portrait for each persona via Flux 2 Max
    const replicateToken = process.env.REPLICATE_API_TOKEN;
    if (!replicateToken) throw new Error('REPLICATE_API_TOKEN not set');
    const replicate = new Replicate({ auth: replicateToken });

    // Collect brand reference images for style consistency
    const brandPeople = (brandKit.people || []).map(p => p.image_url).filter(Boolean);
    const brandLogos = (brandKit.logos || []).map(l => l.image_url).filter(Boolean);
    const inputImages = [...brandPeople, ...brandLogos].slice(0, 4);

    const sc = brandKit.style_characteristics || {};
    const styleHint = [sc.overall_aesthetic, sc.photography_style, sc.mood].filter(Boolean).join(', ');

    const results = [];
    for (let i = 0; i < Math.min(geminiPersonas.length, count); i++) {
      const p = geminiPersonas[i];
      const baseSeed = Math.floor(Math.random() * 2147483647);

      // Character sheet views — inspired by Imagine.art's character design workflow.
      // Multiple views of the same character give Kling's @Element stronger identity data.
      const views = [
        {
          label: 'hero',
          prompt: `Cinematic film still portrait, full body shot, 3/4 front view at 45 degrees. ${p.appearance}. ${p.wardrobe_hint ? 'Wearing: ' + p.wardrobe_hint + '.' : ''} ${styleHint ? 'Style: ' + styleHint + '.' : ''} Hyperrealistic, soft wrap-around studio lighting, subtle rim light from behind, even full-body illumination, slight cinematic contrast. Eye-level camera, 85mm equivalent, sharp head-to-toe focus. Pure white seamless studio background, fully isolated character. 8K, sharp material textures, photographic quality. No text, no watermark.`,
          aspect: '9:16'
        },
        {
          label: 'closeup',
          prompt: `Close-up cinematic portrait, head and shoulders, looking directly at camera. ${p.appearance}. Dramatic shallow depth of field, catch-lights in eyes, warm skin tones, fine detail on skin texture and facial features. ${styleHint ? 'Style: ' + styleHint + '.' : ''} Soft studio lighting, slight rim light. White background. Photorealistic, 8K detail. No text, no watermark.`,
          aspect: '1:1'
        },
        {
          label: 'fullbody-side',
          prompt: `Full body pure side profile, 90 degree angle. ${p.appearance}. ${p.wardrobe_hint ? 'Wearing: ' + p.wardrobe_hint + '.' : ''} Standing tall, natural relaxed posture. Sharp head-to-toe focus, even studio lighting. White seamless background. Hyperrealistic, photographic quality. No text, no watermark.`,
          aspect: '9:16'
        }
      ];

      logger.info(`Generating character sheet for ${p.name} (${views.length} views)...`);

      const personaImageUrls = [];
      let heroInputImages = [...inputImages]; // Start with brand refs

      for (let v = 0; v < views.length; v++) {
        const view = views[v];

        const output = await replicate.run('black-forest-labs/flux-2-max', {
          input: {
            prompt: view.prompt,
            ...(heroInputImages.length > 0 ? { input_images: heroInputImages } : {}),
            aspect_ratio: view.aspect,
            resolution: '2 MP',
            output_format: 'webp',
            output_quality: 95,
            safety_tolerance: 3,
            seed: baseSeed + v
          }
        });

        const imageSource = Array.isArray(output) ? output[0] : output;
        let imageBuffer;

        if (typeof imageSource === 'string') {
          const resp = await axios.get(imageSource, { responseType: 'arraybuffer' });
          imageBuffer = Buffer.from(resp.data);
        } else if (imageSource && typeof imageSource.blob === 'function') {
          const blob = await imageSource.blob();
          imageBuffer = Buffer.from(await blob.arrayBuffer());
        } else {
          logger.warn(`${p.name} ${view.label} view: unexpected output — skipping`);
          continue;
        }

        const filename = `auto-persona-${Date.now()}-${i}-${view.label}.webp`;
        const imageUrl = await this._uploadBufferToStorage(
          imageBuffer, userId, 'personas', filename, 'image/webp'
        );
        personaImageUrls.push(imageUrl);

        // After hero shot, add it as a reference for subsequent views (identity lock)
        if (v === 0) {
          heroInputImages = [imageUrl, ...inputImages].slice(0, 8);
        }

        logger.info(`  ${p.name} ${view.label} uploaded: ${imageUrl}`);
      }

      if (personaImageUrls.length === 0) {
        logger.warn(`Failed to generate any views for persona ${p.name} — skipping`);
        continue;
      }

      results.push({
        name: p.name,
        description: `${p.name} — ${p.personality}`,
        personality: p.personality,
        appearance: p.appearance,
        wardrobe_hint: p.wardrobe_hint,
        reference_image_urls: personaImageUrls,
        omnihuman_seed_image_url: personaImageUrls[0] // hero shot
      });

      logger.info(`Character sheet for ${p.name}: ${personaImageUrls.length} views ready`);
    }

    if (results.length === 0) throw new Error('Failed to generate any persona character sheets');
    return results;
  }

  // ═══════════════════════════════════════════════════
  // CINEMATIC V2 PIPELINE
  // ═══════════════════════════════════════════════════

  /**
   * V2 cinematic pipeline — generates a Hollywood-feel short film episode.
   * Uses Kling multi_prompt for one coherent multi-shot video, Flux 2 Max
   * for storyboard panels, ElevenLabs for full-episode narration, and
   * ffmpeg for audio mixing post-production.
   */
  async runCinematicPipeline(storyId, userId, onProgress) {
    const progress = (stage, detail) => {
      logger.info(`[CinematicV2] ${stage}: ${detail}`);
      if (onProgress) onProgress(stage, detail);
    };

    try {
      // Step 1: Gemini writes cinematic screenplay (v2 schema)
      progress('writing_script', 'Writing cinematic screenplay...');
      const episode = await this._generateCinematicEpisode(storyId, userId);
      const scene = episode.scene_description || {};
      const shots = scene.shots || [];
      progress('writing_script', `Episode ${episode.episode_number}: ${shots.length} shots, style: ${(scene.visual_style_prefix || '').slice(0, 60)}...`);

      // Step 2: Generate full-episode TTS narration (parallel-safe with storyboard)
      progress('generating_narration', 'Recording voice-over narration...');
      const narrationPromise = this._generateFullNarration(episode, storyId, userId);

      // Step 3: Generate storyboard panels via Flux 2 Max (parallel with narration)
      progress('generating_storyboard', 'Creating storyboard panels...');
      const storyboardPromise = this._generateEpisodeStoryboard(episode, storyId, userId);

      // Wait for both parallel tasks
      const [narrationResult, storyboardPanels] = await Promise.all([narrationPromise, storyboardPromise]);
      progress('generating_storyboard', `${storyboardPanels.length} panels ready`);

      // Save storyboard panels and narration URL to episode
      await updateBrandStoryEpisode(episode.id, userId, {
        storyboard_panels: storyboardPanels,
        narration_audio_url: narrationResult.publicUrl,
        visual_style_prefix: scene.visual_style_prefix || '',
        pipeline_version: 'v2',
        status: 'generating_video'
      });

      // Step 4: Generate multi-shot video via Kling 3.0 Pro
      progress('generating_video', 'Generating cinematic video (Kling multi-shot)...');
      const story = await getBrandStoryById(storyId, userId);
      let videoResult;
      try {
        videoResult = await this._generateKlingMultiShot(shots, scene, storyboardPanels, story, userId);
      } catch (klingErr) {
        logger.warn(`Kling multi-shot failed, falling back to Seedance: ${klingErr.message}`);
        progress('generating_video', 'Kling unavailable — using Seedance frame-chaining fallback...');
        videoResult = await this._runSeedanceFallbackPipeline(shots, scene, storyboardPanels, story, episode, userId);
      }

      // Upload raw video to Supabase
      const rawVideoUrl = await this._uploadBufferToStorage(
        videoResult.videoBuffer, userId, 'videos', `ep${episode.episode_number}-raw.mp4`, 'video/mp4'
      );

      await updateBrandStoryEpisode(episode.id, userId, {
        scene_video_url: rawVideoUrl,
        status: 'post_production'
      });

      // Step 5: Post-production (audio mix narration over ambient)
      progress('post_production', 'Mixing narration over cinematic audio...');
      const finalVideoUrl = await this._postProduction(
        videoResult.videoBuffer, narrationResult.audioBuffer, episode, userId
      );

      // Finalize
      await updateBrandStoryEpisode(episode.id, userId, {
        final_video_url: finalVideoUrl,
        status: 'ready'
      });

      progress('complete', `Episode ${episode.episode_number} ready!`);
      return getBrandStoryEpisodeById(episode.id, userId);

    } catch (error) {
      logger.error(`Cinematic v2 pipeline failed for story ${storyId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Generate a cinematic episode scene description using v2 prompts.
   * Returns the created episode record with scene_description containing
   * visual_style_prefix, storyboard_prompt per shot, narration_lines, etc.
   */
  async _generateCinematicEpisode(storyId, userId) {
    const story = await getBrandStoryById(storyId, userId);
    if (!story) throw new Error(`Story ${storyId} not found`);
    if (!story.storyline) throw new Error('Story has no generated storyline');

    const allEpisodes = await getBrandStoryEpisodes(storyId, userId);
    // Only use completed episodes for continuity — skip failed/in-progress ones
    const previousEpisodes = allEpisodes.filter(ep =>
      ep.scene_description?.shots?.length > 0 && ['ready', 'published'].includes(ep.status)
    );
    const prevScenes = previousEpisodes.map(ep => ep.scene_description);
    const lastCliffhanger = previousEpisodes.length > 0
      ? previousEpisodes[previousEpisodes.length - 1]?.scene_description?.cliffhanger || ''
      : '';
    // Episode number = total records in DB + 1 (including failed ones, to avoid duplicates)
    const episodeNumber = allEpisodes.length + 1;

    const storyPersonas = story.persona_config?.personas || [];
    let brandKit = null;
    if (story.brand_kit_job_id) {
      try {
        const job = await getMediaTrainingJobById(story.brand_kit_job_id, userId);
        if (job?.brand_kit) brandKit = job.brand_kit;
      } catch (e) { /* no brand kit — fine */ }
    }

    const systemPrompt = getEpisodeSystemPromptV2(story.storyline, prevScenes, storyPersonas, {
      subject: story.subject,
      storyFocus: story.story_focus || 'product',
      brandKit
    });
    const userPrompt = getEpisodeUserPromptV2(story.storyline, lastCliffhanger, episodeNumber);

    const apiKey = process.env.GOOGLE_AI_STUDIO_API_KEY;
    if (!apiKey) throw new Error('GOOGLE_AI_STUDIO_API_KEY not set');

    const response = await axios.post(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
      contents: [
        { role: 'user', parts: [{ text: systemPrompt }] },
        { role: 'model', parts: [{ text: 'I understand. I will generate the next cinematic episode as valid JSON.' }] },
        { role: 'user', parts: [{ text: userPrompt }] }
      ],
      generationConfig: {
        maxOutputTokens: 8192,
        temperature: 0.85,
        responseMimeType: 'application/json'
      }
    }, { timeout: 120000 });

    const raw = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) throw new Error('Gemini returned empty response for cinematic episode');

    const sceneDescription = this._parseGeminiJson(raw);
    logger.info(`Gemini cinematic response keys: ${Object.keys(sceneDescription).join(', ')}`);
    if (!sceneDescription.shots || sceneDescription.shots.length === 0) {
      logger.error(`Gemini cinematic response (no shots): ${JSON.stringify(sceneDescription).slice(0, 500)}`);
      throw new Error('Gemini cinematic episode missing shots array');
    }

    // Create episode record
    const episodeData = {
      episode_number: episodeNumber,
      scene_description: sceneDescription,
      status: 'generating_storyboard',
      pipeline_version: 'v2'
    };

    const created = await createBrandStoryEpisode(storyId, userId, episodeData);
    await updateBrandStory(storyId, userId, { total_episodes: episodeNumber });

    logger.info(`Cinematic episode ${episodeNumber} created: "${sceneDescription.title}" — ${sceneDescription.shots.length} shots`);
    return { ...created, scene_description: sceneDescription };
  }

  /**
   * Generate full-episode TTS narration via ElevenLabs.
   * Concatenates all shots' narration_lines into one continuous script.
   */
  async _generateFullNarration(episode, storyId, userId) {
    const scene = episode.scene_description || {};
    const shots = scene.shots || [];

    // Build full narration from per-shot narration_lines
    const fullScript = shots
      .map(s => s.narration_line || '')
      .filter(Boolean)
      .join(' ');

    if (!fullScript) {
      logger.warn(`Episode ${episode.episode_number}: no narration text — skipping TTS`);
      return { audioBuffer: null, publicUrl: null };
    }

    // Determine voice from persona config
    const story = await getBrandStoryById(storyId, userId);
    const personas = story?.persona_config?.personas || [];
    const voiceId = personas[0]?.elevenlabs_voice_id || undefined; // TTSService has a default

    const ttsResult = await ttsService.synthesize({
      text: fullScript,
      options: { voiceId, language: personas[0]?.language || 'en' }
    });

    // Upload narration to Supabase
    const publicUrl = await this._uploadBufferToStorage(
      ttsResult.audioBuffer, userId, 'audio', `ep${episode.episode_number}-narration.mp3`, 'audio/mpeg'
    );

    logger.info(`Narration generated: ~${ttsResult.durationEstimate}s, uploaded to ${publicUrl}`);
    return { audioBuffer: ttsResult.audioBuffer, publicUrl };
  }

  /**
   * Generate episode storyboard panels via Replicate Flux 2 Max.
   * Produces one panel per shot (3 total) with style coherence via
   * shared visual_style_prefix, character references, and seed proximity.
   */
  async _generateEpisodeStoryboard(episode, storyId, userId) {
    const scene = episode.scene_description || {};
    const shots = scene.shots || [];
    const stylePrefix = scene.visual_style_prefix || '';
    const story = await getBrandStoryById(storyId, userId);

    // Collect reference images for Flux 2 Max input_images — ordered by story focus.
    // Person focus: persona refs first (character is the star of every frame)
    // Product/landscape focus: subject refs first (product/place dominates the storyboard)
    const personaRefs = this._collectPersonaReferenceImages(story);
    const subjectRefs = this._collectSubjectReferenceImages(story);
    const focus = story.story_focus || 'product';
    const inputImages = focus === 'person'
      ? [...personaRefs, ...subjectRefs].slice(0, 8)
      : [...subjectRefs, ...personaRefs].slice(0, 8);

    // Initialize Replicate client
    const replicateToken = process.env.REPLICATE_API_TOKEN;
    if (!replicateToken) throw new Error('REPLICATE_API_TOKEN not set — cannot generate storyboard');
    const replicate = new Replicate({ auth: replicateToken });

    const baseSeed = Math.floor(Math.random() * 2147483647);
    const panels = [];

    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const storyboardPrompt = shot.storyboard_prompt || shot.visual_direction || '';
      const fullPrompt = stylePrefix
        ? `${stylePrefix}. ${storyboardPrompt}`
        : storyboardPrompt;

      logger.info(`Generating storyboard panel ${i + 1}/${shots.length}: ${fullPrompt.slice(0, 100)}...`);

      const output = await replicate.run('black-forest-labs/flux-2-max', {
        input: {
          prompt: fullPrompt,
          ...(inputImages.length > 0 ? { input_images: inputImages } : {}),
          aspect_ratio: '9:16',
          resolution: '2 MP',
          output_format: 'webp',
          output_quality: 95,
          safety_tolerance: 3,
          seed: baseSeed + i
        }
      });

      // Flux 2 Max returns a single FileOutput or URL
      const imageSource = Array.isArray(output) ? output[0] : output;
      let imageBuffer;

      if (typeof imageSource === 'string') {
        const response = await axios.get(imageSource, { responseType: 'arraybuffer' });
        imageBuffer = Buffer.from(response.data);
      } else if (imageSource && typeof imageSource.blob === 'function') {
        const blob = await imageSource.blob();
        imageBuffer = Buffer.from(await blob.arrayBuffer());
      } else {
        logger.warn(`Storyboard panel ${i + 1}: unexpected output format — skipping`);
        continue;
      }

      // Upload to Supabase
      const filename = `ep${episode.episode_number}-panel${i + 1}-${Date.now()}.webp`;
      const imageUrl = await this._uploadBufferToStorage(
        imageBuffer, userId, 'storyboard', filename, 'image/webp'
      );

      panels.push({
        shot_index: i,
        image_url: imageUrl,
        prompt: fullPrompt.slice(0, 500)
      });

      logger.info(`Storyboard panel ${i + 1} uploaded: ${imageUrl}`);
    }

    if (panels.length === 0) throw new Error('Failed to generate any storyboard panels');
    return panels;
  }

  /**
   * Generate multi-shot video via Kling 3.0 Pro multi_prompt API.
   * Panel 1 from storyboard becomes the start frame; persona/subject refs
   * become @Element identity locks.
   */
  async _generateKlingMultiShot(shots, scene, storyboardPanels, story, userId) {
    if (!klingService.isAvailable()) throw new Error('Kling service not available');

    const stylePrefix = scene.visual_style_prefix || '';

    // Build reference images — Replicate Kling Omni 3 supports up to 7 refs.
    // More refs = stronger identity lock. Order by focus priority.
    const personaRefs = this._collectPersonaReferenceImages(story);
    const subjectRefs = this._collectSubjectReferenceImages(story);
    const focus = story.story_focus || 'product';
    const referenceImages = focus === 'person'
      ? [...personaRefs, ...subjectRefs]
      : [...subjectRefs, ...personaRefs];
    const refs = [...new Set(referenceImages)].slice(0, 7);

    // Start frame = first storyboard panel
    const startImageUrl = storyboardPanels[0]?.image_url;
    if (!startImageUrl) throw new Error('No storyboard panel 1 for Kling start frame');

    // Shot prompts have a 512-char limit in Kling multi_prompt.
    // <<<image_N>>> tags are NOT needed in shot prompts — reference_images handles identity lock.
    // Condense style prefix to ~150 chars to leave ~350 chars for shot-specific content.
    const condensedStyle = stylePrefix.length > 150
      ? stylePrefix.slice(0, 150).replace(/,?\s*$/, '')
      : stylePrefix;

    const multiPrompt = shots.map(shot => {
      const shotContent = [
        shot.visual_direction || '',
        shot.camera_notes ? `Camera: ${shot.camera_notes}` : '',
        shot.ambient_sound ? `Sound: ${shot.ambient_sound}` : '',
        shot.mood ? `Mood: ${shot.mood}` : ''
      ].filter(Boolean).join('. ');
      const prompt = `${condensedStyle}. ${shotContent}`.slice(0, 512);
      return { prompt, duration: Math.min(Math.max(shot.duration_seconds || 5, 3), 15) };
    });

    logger.info(`Kling multi-shot: ${multiPrompt.length} shots, ${refs.length} refs, start frame: ${startImageUrl.slice(0, 60)}...`);

    const result = await klingService.generateMultiShotVideo({
      imageUrl: startImageUrl,
      referenceImages: refs,
      multiPrompt,
      options: {
        aspectRatio: '9:16',
        generateAudio: true
      }
    });

    return result;
  }

  /**
   * Seedance fallback pipeline — used when Kling multi_prompt is unavailable.
   * Uses frame chaining: each shot's start frame = last frame of previous shot.
   * Storyboard panels serve as end_image_url targets for guided motion.
   */
  async _runSeedanceFallbackPipeline(shots, scene, storyboardPanels, story, episode, userId) {
    if (!seedanceService.isAvailable()) throw new Error('Seedance service not available');

    const stylePrefix = scene.visual_style_prefix || '';
    const generatedShots = [];
    const tmpDir = os.tmpdir();

    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const prompt = `${stylePrefix}. ${shot.visual_direction || ''} ${shot.camera_notes ? `Camera: ${shot.camera_notes}` : ''} ${shot.ambient_sound ? `Sound: ${shot.ambient_sound}` : ''} Mood: ${shot.mood || 'cinematic'}. Photorealistic, cinematic lighting, 9:16 vertical.`;

      // Start frame: first shot uses storyboard panel 1, subsequent use previous shot's last frame
      let startFrameUrl;
      if (i === 0) {
        startFrameUrl = storyboardPanels[0]?.image_url;
      } else {
        // Extract last frame from previous shot
        startFrameUrl = generatedShots[i - 1]?.lastFrameUrl || storyboardPanels[i]?.image_url;
      }

      // End frame: next storyboard panel (for guided motion toward that composition)
      const endFrameUrl = (i < storyboardPanels.length - 1) ? storyboardPanels[i + 1]?.image_url : undefined;

      logger.info(`Seedance fallback shot ${i + 1}/${shots.length}: start=${startFrameUrl ? 'yes' : 'no'}, end=${endFrameUrl ? 'yes' : 'no'}`);

      const result = startFrameUrl
        ? await seedanceService.generateImageToVideo({
            prompt,
            imageUrl: startFrameUrl,
            options: {
              duration: Math.min(Math.max(shot.duration_seconds || 5, 4), 15),
              aspectRatio: '9:16',
              generateAudio: true,
              endImageUrl: endFrameUrl || undefined
            }
          })
        : await seedanceService.generateTextToVideo({
            prompt,
            options: {
              duration: Math.min(Math.max(shot.duration_seconds || 5, 4), 15),
              aspectRatio: '9:16',
              generateAudio: true
            }
          });

      // Extract last frame for next shot's continuity
      let lastFrameUrl = null;
      try {
        const shotPath = path.join(tmpDir, `seedance-shot-${episode.episode_number}-${i}.mp4`);
        const framePath = path.join(tmpDir, `seedance-lastframe-${episode.episode_number}-${i}.png`);
        await fs.writeFile(shotPath, result.videoBuffer);
        // Use png encoder (always available) instead of mjpeg (fails on some yuv420p inputs).
        // Seek to last 0.1s of video and grab 1 frame.
        await execFileAsync('ffmpeg', ['-y', '-sseof', '-0.1', '-i', shotPath, '-frames:v', '1', '-update', '1', framePath]);
        const frameBuffer = await fs.readFile(framePath);
        lastFrameUrl = await this._uploadBufferToStorage(
          frameBuffer, userId, 'storyboard', `ep${episode.episode_number}-lastframe${i}.png`, 'image/png'
        );
        // Cleanup
        await fs.unlink(shotPath).catch(() => {});
        await fs.unlink(framePath).catch(() => {});
      } catch (frameErr) {
        logger.warn(`Failed to extract last frame from shot ${i + 1}: ${frameErr.message}`);
      }

      generatedShots.push({
        index: i,
        videoBuffer: result.videoBuffer,
        duration: result.duration,
        lastFrameUrl
      });
    }

    // Assemble with xfade transitions
    const transitions = shots.map(s => s.transition_to_next || 'dissolve');
    const assembledBuffer = await this._assembleWithTransitions(generatedShots, transitions, episode, userId);

    return {
      videoBuffer: assembledBuffer,
      duration: generatedShots.reduce((sum, s) => sum + s.duration, 0),
      model: 'seedance-1.5-pro-frame-chained'
    };
  }

  /**
   * Assemble shots with ffmpeg xfade transitions (replaces raw concat).
   * Uses dissolve/fadeblack transitions between shots instead of hard cuts.
   */
  async _assembleWithTransitions(generatedShots, transitions, episode, userId) {
    if (generatedShots.length === 0) throw new Error('No shots to assemble');
    if (generatedShots.length === 1) return generatedShots[0].videoBuffer;

    const tmpDir = os.tmpdir();
    const shotFiles = [];
    const transitionDuration = 0.5; // seconds

    // Write each shot to temp file and normalize
    for (let i = 0; i < generatedShots.length; i++) {
      const rawPath = path.join(tmpDir, `xfade-raw-${episode.episode_number}-${i}.mp4`);
      const normPath = path.join(tmpDir, `xfade-norm-${episode.episode_number}-${i}.mp4`);
      await fs.writeFile(rawPath, generatedShots[i].videoBuffer);

      // Normalize: consistent codec, resolution, framerate
      await execFileAsync('ffmpeg', [
        '-y', '-i', rawPath,
        '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
        '-profile:v', 'high', '-level', '4.2', '-pix_fmt', 'yuv420p', '-r', '30',
        '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-ac', '2',
        normPath
      ]);

      shotFiles.push(normPath);
      await fs.unlink(rawPath).catch(() => {});
    }

    // Build xfade filter chain
    // For 3 shots: [0][1]xfade=dissolve:duration=0.5:offset=T1[v01]; [v01][2]xfade=dissolve:duration=0.5:offset=T2[vout]
    let filterParts = [];
    let currentOffset = 0;
    const inputs = shotFiles.map((f, i) => ['-i', f]).flat();

    for (let i = 0; i < shotFiles.length - 1; i++) {
      const shotDuration = generatedShots[i].duration || 5;
      currentOffset += shotDuration - transitionDuration;
      const transType = (transitions[i] === 'fadeblack') ? 'fadeblack'
        : (transitions[i] === 'cut') ? 'fade' // 'cut' = very short fade
        : 'dissolve';
      const dur = transitions[i] === 'cut' ? 0.1 : transitionDuration;

      const inputA = i === 0 ? `[${i}:v]` : '[vtemp]';
      const outputLabel = i === shotFiles.length - 2 ? '[vout]' : '[vtemp]';
      filterParts.push(`${inputA}[${i + 1}:v]xfade=transition=${transType}:duration=${dur}:offset=${currentOffset}${outputLabel}`);
    }

    // Audio: concatenate with acrossfade
    let audioFilter = '';
    for (let i = 0; i < shotFiles.length - 1; i++) {
      const inputA = i === 0 ? `[${i}:a]` : '[atemp]';
      const outputLabel = i === shotFiles.length - 2 ? '[aout]' : '[atemp]';
      audioFilter += `${inputA}[${i + 1}:a]acrossfade=d=${transitionDuration}${outputLabel};`;
    }

    const outputPath = path.join(tmpDir, `xfade-assembled-${episode.episode_number}.mp4`);
    const filterComplex = filterParts.join(';') + ';' + audioFilter.replace(/;$/, '');

    try {
      await execFileAsync('ffmpeg', [
        '-y', ...inputs,
        '-filter_complex', filterComplex,
        '-map', '[vout]', '-map', '[aout]',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
        '-c:a', 'aac', '-b:a', '256k',
        '-movflags', '+faststart',
        outputPath
      ]);
    } catch (xfadeErr) {
      // Fallback: simple concat if xfade fails
      logger.warn(`xfade assembly failed, falling back to concat: ${xfadeErr.message}`);
      const listFile = path.join(tmpDir, `xfade-list-${episode.episode_number}.txt`);
      await fs.writeFile(listFile, shotFiles.map(f => `file '${f}'`).join('\n'));
      await execFileAsync('ffmpeg', [
        '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
        '-c', 'copy', '-movflags', '+faststart', outputPath
      ]);
      await fs.unlink(listFile).catch(() => {});
    }

    const assembled = await fs.readFile(outputPath);

    // Cleanup
    for (const f of shotFiles) await fs.unlink(f).catch(() => {});
    await fs.unlink(outputPath).catch(() => {});

    return assembled;
  }

  /**
   * Post-production: mix TTS narration over the cinematic video's ambient audio.
   * Narration at foreground level, native video audio as quiet ambient bed.
   */
  async _postProduction(videoBuffer, narrationBuffer, episode, userId) {
    const tmpDir = os.tmpdir();
    const videoPath = path.join(tmpDir, `postprod-video-${episode.episode_number}.mp4`);
    const outputPath = path.join(tmpDir, `postprod-final-${episode.episode_number}.mp4`);
    await fs.writeFile(videoPath, videoBuffer);

    if (!narrationBuffer) {
      // No narration — just upload the video as-is
      const publicUrl = await this._uploadBufferToStorage(
        videoBuffer, userId, 'videos', `ep${episode.episode_number}-final.mp4`, 'video/mp4'
      );
      await fs.unlink(videoPath).catch(() => {});
      return publicUrl;
    }

    const narrationPath = path.join(tmpDir, `postprod-narration-${episode.episode_number}.mp3`);
    await fs.writeFile(narrationPath, narrationBuffer);

    try {
      // Mix: narration at 85% volume, ambient at 12% volume
      await execFileAsync('ffmpeg', [
        '-y',
        '-i', videoPath,
        '-i', narrationPath,
        '-filter_complex',
        '[0:a]volume=0.12[ambient];[1:a]volume=0.85[narr];[ambient][narr]amix=inputs=2:duration=shortest[aout]',
        '-map', '0:v',
        '-map', '[aout]',
        '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '256k', '-ar', '48000',
        '-movflags', '+faststart',
        '-shortest',
        outputPath
      ]);
    } catch (mixErr) {
      logger.warn(`Audio mix failed, using narration-only: ${mixErr.message}`);
      // Fallback: replace video audio with narration only
      await execFileAsync('ffmpeg', [
        '-y',
        '-i', videoPath,
        '-i', narrationPath,
        '-map', '0:v', '-map', '1:a',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k',
        '-shortest', '-movflags', '+faststart',
        outputPath
      ]);
    }

    const finalBuffer = await fs.readFile(outputPath);
    const publicUrl = await this._uploadBufferToStorage(
      finalBuffer, userId, 'videos', `ep${episode.episode_number}-final.mp4`, 'video/mp4'
    );

    // Cleanup
    await fs.unlink(videoPath).catch(() => {});
    await fs.unlink(narrationPath).catch(() => {});
    await fs.unlink(outputPath).catch(() => {});

    logger.info(`Post-production complete: ${publicUrl}`);
    return publicUrl;
  }
}

// Singleton export
const brandStoryService = new BrandStoryService();
export default brandStoryService;
export { BrandStoryService };
