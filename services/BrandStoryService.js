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

// V4 imports — pipeline, prompts, helpers
import {
  getEpisodeSystemPromptV4,
  getEpisodeUserPromptV4
} from '../public/components/brandStoryPromptsV4.mjs';
import klingFalService from './KlingFalService.js';
import veoService from './VeoService.js';
import syncLipsyncFalService from './SyncLipsyncFalService.js';
import seedreamFalService from './SeedreamFalService.js';
import fluxFalService from './FluxFalService.js';
import musicService from './MusicService.js';
import BeatRouter, { resolveCostCap } from './BeatRouter.js';
import MontageSequenceGenerator from './beat-generators/MontageSequenceGenerator.js';
import {
  generateSceneMasters,
  buildBeatRefStack,
  extractBeatEndframe
} from './v4/StoryboardHelpers.js';
import { runQualityGate } from './v4/QualityGate.js';
import {
  acquirePersonaVoicesForStory
} from './v4/VoiceAcquisition.js';
import {
  matchBrandKitToLut,
  resolveEpisodeLut,
  getLutFilePath
} from './v4/BrandKitLutMatcher.js';
import {
  runPostProduction,
  estimateEpisodeDuration
} from './v4/PostProduction.js';
import { getOrCreateProgressEmitter } from './v4/ProgressEmitter.js';
import { generateLutFromBrandKit } from './v4/GenerativeLut.js';
import { validateScreenplay } from './v4/ScreenplayValidator.js';
import { punchUpScreenplay } from './v4/ScreenplayDoctor.js';
import { parseGeminiJson } from './v4/GeminiJsonRepair.js';
import {
  callVertexGeminiJson,
  callVertexGeminiText,
  callVertexGeminiRaw,
  isVertexGeminiConfigured
} from './v4/VertexGemini.js';

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
    // this.googleApiKey is ONLY used by the v1 legacy path (generateNextEpisode)
    // and the v2/v3 _generateCinematicEpisode helper. V4 uses Vertex AI Gemini
    // via services/v4/VertexGemini.js (GCP service-account auth, not an API key).
    this.googleApiKey = process.env.GOOGLE_AI_STUDIO_API_KEY;

    if (!this.googleApiKey) {
      logger.warn('GOOGLE_AI_STUDIO_API_KEY not set — legacy v1/v2 paths unavailable (V4 uses Vertex AI)');
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
    // V4 uses Vertex AI Gemini (not AI Studio). Subject analysis is shared
    // with the V4 pipeline, so it needs Vertex credentials.
    if (!isVertexGeminiConfigured()) {
      throw new Error('Vertex Gemini not configured — set GCP_PROJECT_ID and GOOGLE_APPLICATION_CREDENTIALS_JSON (or ADC)');
    }
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

    // Call Vertex Gemini with the multimodal contents (image parts + text).
    // Uses callVertexGeminiText (not callVertexGeminiJson) because we need
    // custom parsing below that strips code fences + unwraps arrays.
    // Token budget: 8192 (was 2000). Gemini 3 Flash thinking tokens + a
    // multi-field JSON response need headroom; 2000 was borderline.
    // See Day 0 2026-04-11 fix notes in services/v4/VoiceAcquisition.js.
    const rawText = (await callVertexGeminiText({
      systemPrompt: '', // subject analysis pushes everything into the user contents
      contents: [{ role: 'user', parts }],
      config: {
        temperature: 0.4,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json'
      },
      timeoutMs: 90000
    }))?.trim();

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
    // V4 uses Vertex AI Gemini (not AI Studio).
    if (!isVertexGeminiConfigured()) {
      throw new Error('Vertex Gemini not configured — set GCP_PROJECT_ID and GOOGLE_APPLICATION_CREDENTIALS_JSON (or ADC)');
    }

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

    const systemPrompt = getStorylineSystemPrompt(brandKit, {
      directorsNotes: story.subject?.directors_notes || ''
    });
    const userPrompt = getStorylineUserPrompt(
      personas,
      story.subject,
      brandKit,
      {
        tone: story.subject?.tone || 'engaging',
        genre: story.subject?.genre || 'drama',
        targetAudience: story.subject?.target_audience || 'young professionals',
        storyFocus: story.story_focus || 'product',
        directorsNotes: story.subject?.directors_notes || ''
      }
    );

    // Call Vertex AI Gemini (V4 uses Vertex, not AI Studio).
    // Using callVertexGeminiRaw so we can inspect finishReason for
    // MAX_TOKENS truncation detection below.
    const vertexResponse = await callVertexGeminiRaw({
      systemPrompt,
      userPrompt,
      config: {
        maxOutputTokens: 32000,
        temperature: 0.85,
        responseMimeType: 'application/json'
      },
      timeoutMs: 120000
    });

    const candidate = vertexResponse?.candidates?.[0];
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
    const story = await getBrandStoryById(storyId, userId);
    if (!story) return;

    const personas = Array.isArray(story.persona_config?.personas)
      ? story.persona_config.personas
      : [story.persona_config];

    logger.info(`[V3] Avatar setup for story ${storyId} (persona_type=${story.persona_type}, ${personas.length} persona(s))`);

    try {
      await updateBrandStory(storyId, userId, {
        persona_config: { ...(story.persona_config || {}), training_status: 'generating_persona_image' }
      });

      let workingPersonas = [...personas];

      for (let i = 0; i < workingPersonas.length; i++) {
        const p = workingPersonas[i];

        // brand_kit_auto already has a full character sheet from generatePersonaFromBrandKit()
        if (story.persona_type === 'brand_kit_auto' && p.reference_image_urls?.length >= 3) {
          logger.info(`[P${i + 1}] brand_kit_auto already has ${p.reference_image_urls.length} refs — skipping character sheet`);
          continue;
        }

        // Generate character sheet (3 views: hero, closeup, side) via Flux 2 Max
        workingPersonas[i] = await this._generateCharacterSheet(p, i, story, userId);
      }

      const configuredCount = workingPersonas.filter(p =>
        p.reference_image_urls?.length > 0 || p.omnihuman_seed_image_url
      ).length;

      await updateBrandStory(storyId, userId, {
        persona_config: {
          ...(story.persona_config || {}),
          personas: workingPersonas,
          training_status: configuredCount > 0 ? 'completed' : 'failed'
        }
      });

      logger.info(`[V3] Avatar setup complete: ${configuredCount}/${workingPersonas.length} personas with character sheets`);
    } catch (err) {
      logger.error(`[V3] Avatar setup error for story ${storyId}: ${err.message}`);
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

    // Extract visual style and emotional state from the most recent completed episode
    // to maintain cross-episode continuity.
    const lastCompletedEp = previousEpisodes[previousEpisodes.length - 1];
    const previousVisualStyle = lastCompletedEp?.scene_description?.visual_style_prefix || '';
    const previousEmotionalState = lastCompletedEp?.scene_description?.emotional_state || '';

    // Build prompts — pass subject + storyFocus + brandKit so each episode's shots
    // integrate the subject naturally AND respect the brand identity.
    const systemPrompt = getEpisodeSystemPrompt(story.storyline, prevScenes, storyPersonas, {
      subject: story.subject,
      storyFocus: story.story_focus || 'product',
      brandKit,
      previousVisualStyle,
      previousEmotionalState,
      directorsNotes: story.subject?.directors_notes || ''
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
      // Identity refs first (persona + subject), then storyboard panel fills remaining slots.
      // Storyboard panels carry baked-in identity from Seedream generation AND guide composition.
      // Same pattern as _generateKlingMultiShot — Kling supports up to 7 reference images.
      const identityRefs = this._buildKlingReferenceImages(story);
      const combinedRefs = [...identityRefs, ...(storyboardUrl && !identityRefs.includes(storyboardUrl) ? [storyboardUrl] : [])].slice(0, 7);
      if (combinedRefs.length > 0) {
        const focus = story.story_focus || 'product';
        logger.info(`[Shot ${shotIdx + 1}] Kling cinematic (focus=${focus}) with ${combinedRefs.length} ref(s) (${identityRefs.length} identity + ${combinedRefs.length - identityRefs.length} storyboard)`);
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
    // Delegates to the shared repair chain in services/v4/GeminiJsonRepair.js
    // so BrandStoryService and VertexGemini.callVertexGeminiJson speak the
    // same defect-recovery contract. See that module for the full rationale.
    return parseGeminiJson(raw);
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
    // Pipeline version routing.
    //   - 'v4' (new V4 scene→beat pipeline)
    //   - 'v2' (legacy cinematic / v3 in mental model)
    //   - else  (v1 legacy hybrid)
    const pipelineVersion = process.env.BRAND_STORY_PIPELINE || 'v2';
    if (pipelineVersion === 'v4') {
      return this.runV4Pipeline(storyId, userId, onProgress);
    }
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

      // Update story-so-far appendix for continuity
      try {
        const finalEp = await getBrandStoryEpisodeById(episode.id, userId);
        await this._updateStorySoFar(storyId, userId, finalEp);
      } catch (soFarErr) {
        logger.warn(`story_so_far update failed (non-fatal): ${soFarErr.message}`);
      }

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
  // CHARACTER SHEET GENERATION (Flux 2 Max — unified for all persona types)
  // ═══════════════════════════════════════════════════

  /**
   * Generate a 3-view character sheet for a persona via Flux 2 Max.
   * Works for ALL persona types: described, uploaded, brand_kit, brand_kit_auto.
   *
   * For described: generates face + body from text description
   * For uploaded: generates consistent additional views from user's photos
   * For brand_kit: generates views from cutout + brand people references
   *
   * @param {Object} persona - Persona object with description, reference_image_urls, cutout_url, etc.
   * @param {number} personaIndex - Index in the personas array (for logging)
   * @param {Object} story - Story object (for brand kit context)
   * @param {string} userId
   * @returns {Promise<Object>} Updated persona with enriched reference_image_urls
   */
  async _generateCharacterSheet(persona, personaIndex, story, userId) {
    // V4: character sheets now go through fal.ai Flux 2 Max (via FAL_GCS_API_KEY)
    // instead of Replicate. Same model (black-forest-labs/flux-2-max → fal-ai/flux-2-max/edit
    // for reference-image runs, fal-ai/flux-2-max for text-only runs). Consolidates
    // V4's vendor surface to fal.ai + Google + ElevenLabs.
    // Migrated 2026-04-11.
    if (!fluxFalService.isAvailable()) {
      throw new Error('FAL_GCS_API_KEY not set — required for V4 character sheet generation via Flux 2 Max');
    }

    const name = persona.description?.slice(0, 30) || persona.avatar_name || `Persona ${personaIndex + 1}`;
    logger.info(`Generating character sheet for ${name} (persona_type=${story.persona_type}) via fal.ai Flux 2 Max...`);

    // 1. Collect existing persona images as Flux input_images references
    const existingImages = [];
    if (Array.isArray(persona.reference_image_urls)) {
      existingImages.push(...persona.reference_image_urls);
    }
    if (persona.cutout_url) existingImages.push(persona.cutout_url);

    // 2. Collect Brand Kit people[] images for style/appearance reference
    let brandPeopleImages = [];
    if (story.brand_kit_job_id) {
      try {
        const job = await getMediaTrainingJobById(story.brand_kit_job_id, userId);
        const brandKit = job?.brand_kit;
        if (brandKit?.people) {
          brandPeopleImages = brandKit.people
            .map(p => p.image_url)
            .filter(Boolean);
        }
      } catch (e) { /* no brand kit — fine */ }
    }

    // 3. Build input_images: persona's own images first, then brand people (up to 8 total)
    const inputImages = [...existingImages, ...brandPeopleImages].slice(0, 8);

    // 4. Build description for prompts
    const description = persona.appearance || persona.description || 'A professional, camera-ready person';
    const personality = persona.personality || '';
    const wardrobe = persona.wardrobe_hint || '';

    // Load brand style hints
    let styleHint = '';
    if (story.brand_kit_job_id) {
      try {
        const job = await getMediaTrainingJobById(story.brand_kit_job_id, userId);
        const sc = job?.brand_kit?.style_characteristics || {};
        styleHint = [sc.overall_aesthetic, sc.photography_style, sc.mood].filter(Boolean).join(', ');
      } catch (e) { /* fine */ }
    }

    // 5. Generate 3 views
    const baseSeed = Math.floor(Math.random() * 2147483647);
    const views = [
      {
        label: 'hero',
        prompt: `Cinematic film still portrait, full body shot, 3/4 front view at 45 degrees. ${description}. ${wardrobe ? 'Wearing: ' + wardrobe + '.' : ''} ${styleHint ? 'Style: ' + styleHint + '.' : ''} Hyperrealistic, soft wrap-around studio lighting, subtle rim light from behind, even full-body illumination, slight cinematic contrast. Eye-level camera, 85mm equivalent, sharp head-to-toe focus. Pure white seamless studio background, fully isolated character. 8K, sharp material textures, photographic quality. No text, no watermark.`,
        aspect: '9:16'
      },
      {
        label: 'closeup',
        prompt: `Close-up cinematic portrait, head and shoulders, looking directly at camera. ${description}. Dramatic shallow depth of field, catch-lights in eyes, warm skin tones, fine detail on skin texture and facial features. ${styleHint ? 'Style: ' + styleHint + '.' : ''} Soft studio lighting, slight rim light. White background. Photorealistic, 8K detail. No text, no watermark.`,
        aspect: '1:1'
      },
      {
        label: 'fullbody-side',
        prompt: `Full body pure side profile, 90 degree angle. ${description}. ${wardrobe ? 'Wearing: ' + wardrobe + '.' : ''} Standing tall, natural relaxed posture. Sharp head-to-toe focus, even studio lighting. White seamless background. Hyperrealistic, photographic quality. No text, no watermark.`,
        aspect: '9:16'
      }
    ];

    const newImageUrls = [];
    let heroInputImages = [...inputImages];

    for (let v = 0; v < views.length; v++) {
      const view = views[v];

      // fal.ai Flux 2 Max via FluxFalService — handles both text-only and
      // reference-image paths internally (switches between fal-ai/flux-2-max
      // and fal-ai/flux-2-max/edit based on whether referenceImages is empty).
      let imageBuffer;
      try {
        const portraitResult = await fluxFalService.generatePortrait({
          prompt: view.prompt,
          referenceImages: heroInputImages,
          options: {
            aspectRatio: view.aspect,
            seed: baseSeed + v
          }
        });
        imageBuffer = portraitResult.imageBuffer;
      } catch (err) {
        logger.warn(`${name} ${view.label} view: fal.ai Flux 2 Max failed — ${err.message} — skipping`);
        continue;
      }

      const filename = `char-sheet-${Date.now()}-${personaIndex}-${view.label}.webp`;
      const imageUrl = await this._uploadBufferToStorage(
        imageBuffer, userId, 'personas', filename, 'image/webp'
      );
      newImageUrls.push(imageUrl);

      // After hero shot, add it as reference for subsequent views
      if (v === 0) {
        heroInputImages = [imageUrl, ...inputImages].slice(0, 8);
      }

      logger.info(`  ${name} ${view.label} uploaded: ${imageUrl}`);
    }

    if (newImageUrls.length === 0) {
      logger.warn(`Failed to generate character sheet for ${name}`);
      return persona; // Return unchanged
    }

    // 6. Merge: Flux-harmonized views FIRST, original uploads second.
    //
    // V4 Phase 9 character-sheet ordering fix (per Director's notes 2026-04-23):
    // previously we put user uploads first, which meant downstream
    // `reference_image_urls.slice(0, N)` calls pulled the user's DIVERSE
    // raw uploads (different hair/makeup/outfit/event magazine shots) before
    // the Flux-generated harmonized views. Result: face drifted per beat
    // because Kling/Veo averaged across inconsistent looks.
    //
    // New ordering puts the internally-consistent Flux views first so any
    // slice/cap picks the harmonized identity before the diverse originals.
    // The originals stay in the array as style context, but no longer win
    // the identity anchor selection.
    const allRefs = [...newImageUrls, ...existingImages];

    logger.info(`Character sheet for ${name}: ${newImageUrls.length} Flux views (identity-anchored) + ${existingImages.length} originals (style context) = ${allRefs.length} total refs`);

    // 7. V4 Phase 9 — Canonical Identity Portrait (CIP) stage.
    //
    // Even with Flux views front-loaded, different beats pull different
    // subsets — hero for B-roll, closeup for TALKING_HEAD, fullbody-side
    // for action. Subtle facial drift accumulates across beats.
    //
    // The CIP stage runs one MORE Flux pass that distills all refs into a
    // SINGLE neutral-lit front-facing canonical portrait, then generates
    // 2 companion views (3/4 left + 3/4 right) from that canon. The result
    // is a 3-view Identity Anchor Set where the ONLY variance between views
    // is angle — no stylistic variance. This is the AI-pipeline equivalent
    // of a casting "screen test" reference.
    //
    // Opt-out via V4_CIP_STAGE=false for debug / cost-conscious runs.
    let canonicalIdentityUrls = [];
    if (process.env.V4_CIP_STAGE !== 'false') {
      try {
        canonicalIdentityUrls = await this._generateCanonicalIdentityPortrait({
          name,
          personaIndex,
          description,
          styleHint,
          allRefs,
          userId,
          baseSeed
        });
        if (canonicalIdentityUrls.length > 0) {
          logger.info(`  ${name} CIP: ${canonicalIdentityUrls.length} canonical view(s) generated — identity locked`);
        }
      } catch (cipErr) {
        logger.warn(`CIP stage failed for ${name} — falling back to ordered reference_image_urls: ${cipErr.message}`);
        canonicalIdentityUrls = [];
      }
    }

    return {
      ...persona,
      reference_image_urls: allRefs,
      canonical_identity_urls: canonicalIdentityUrls,
      omnihuman_seed_image_url: newImageUrls[0] // hero shot
    };
  }

  /**
   * V4 Phase 9 — Canonical Identity Portrait stage.
   *
   * Produces a 3-view Identity Anchor Set (front, 3/4 left, 3/4 right) where
   * the ONLY variance between views is camera angle. No wardrobe / hair /
   * makeup / lighting variance — this is the pure identity anchor used to
   * eliminate face drift across beats.
   *
   * Step 1: One Flux Edit pass with all refs → single neutral portrait
   * Step 2: That portrait becomes the anchor ref for 2 more angled views
   *
   * Returns an array of 1-3 public URLs, ordered [front, left-3/4, right-3/4].
   * Returns empty array if Flux isn't available — caller falls back to
   * ordered reference_image_urls.
   */
  async _generateCanonicalIdentityPortrait({ name, personaIndex, description, styleHint, allRefs, userId, baseSeed }) {
    if (!fluxFalService.isAvailable()) return [];

    logger.info(`  ${name}: canonicalizing identity (CIP stage)...`);

    // Neutral-lit front-facing portrait that distills all refs into ONE face.
    // The prompt explicitly negates stylistic variance and instructs the model
    // to produce a "screen test" reference — flat even lighting, neutral
    // expression, neutral hair, neutral wardrobe. The point is to strip away
    // everything that varies across the input refs so only the facial
    // structure remains.
    const cipFrontPrompt = [
      'CANONICAL IDENTITY PORTRAIT — screen test reference frame.',
      'Front-facing, straight-on, eye-level camera, neutral relaxed expression (slight closed mouth, no smile, no frown).',
      'Flat even studio lighting, no dramatic shadows, no rim light, no colored gels — pure identity reference.',
      'Neutral hair (styled simply, no elaborate styling), neutral clean wardrobe (plain shirt or blouse, no distinctive details).',
      'Clean pure white seamless background, fully isolated.',
      `Subject: ${description}.`,
      styleHint ? `Style context: ${styleHint}.` : '',
      'IMPORTANT: preserve exact facial structure from reference images — inter-ocular distance, nose geometry, jawline, lip shape, brow arch, ear placement. These are invariant.',
      'Reference images may show the subject in varied hair / makeup / wardrobe across different events — extract the CONSTANT facial structure and render it under neutral conditions.',
      'Hyperrealistic photographic quality, sharp facial detail, 85mm lens equivalent, head-and-shoulders framing, VERTICAL 9:16 portrait.',
      'No text, no watermark, no letterbox.'
    ].filter(Boolean).join(' ');

    let frontUrl = null;
    try {
      const frontResult = await fluxFalService.generatePortrait({
        prompt: cipFrontPrompt,
        referenceImages: allRefs.slice(0, 8),
        options: {
          aspectRatio: '9:16',
          seed: baseSeed + 100 // offset from character sheet seeds to get a distinct roll
        }
      });
      const frontFilename = `cip-${Date.now()}-${personaIndex}-front.webp`;
      frontUrl = await this._uploadBufferToStorage(
        frontResult.imageBuffer, userId, 'personas/cip', frontFilename, 'image/webp'
      );
      logger.info(`  ${name} CIP front anchor ready: ${frontUrl}`);
    } catch (err) {
      logger.warn(`  ${name} CIP front anchor failed: ${err.message}`);
      return [];
    }

    // Now generate 2 angled views using the CIP front as the DOMINANT
    // reference (appears twice in the input stack to heavily weight it).
    // The result: 3 views, same face, different angles, same conditions.
    const angledViews = [
      { label: 'three-quarter-left', prompt: 'Same exact person as reference image 1, same exact face, same hair, same wardrobe, same lighting. Turn head 3/4 to camera-left (approximately 45 degrees). Neutral relaxed expression. Clean white background. VERTICAL 9:16 portrait. Head-and-shoulders framing.' },
      { label: 'three-quarter-right', prompt: 'Same exact person as reference image 1, same exact face, same hair, same wardrobe, same lighting. Turn head 3/4 to camera-right (approximately 45 degrees). Neutral relaxed expression. Clean white background. VERTICAL 9:16 portrait. Head-and-shoulders framing.' }
    ];

    const angledUrls = [];
    const cipRefs = [frontUrl, frontUrl, ...allRefs].slice(0, 8); // front doubled → heavy weight
    for (let v = 0; v < angledViews.length; v++) {
      const view = angledViews[v];
      try {
        const result = await fluxFalService.generatePortrait({
          prompt: view.prompt + ` IMPORTANT: preserve exact facial structure from reference 1 — inter-ocular distance, nose geometry, jawline, lip shape, brow arch. Facial bone structure is invariant; only the angle changes.`,
          referenceImages: cipRefs,
          options: {
            aspectRatio: '9:16',
            seed: baseSeed + 200 + v
          }
        });
        const filename = `cip-${Date.now()}-${personaIndex}-${view.label}.webp`;
        const url = await this._uploadBufferToStorage(
          result.imageBuffer, userId, 'personas/cip', filename, 'image/webp'
        );
        angledUrls.push(url);
      } catch (err) {
        logger.warn(`  ${name} CIP ${view.label} failed: ${err.message} — continuing with partial CIP set`);
      }
    }

    return [frontUrl, ...angledUrls];
  }

  // ═══════════════════════════════════════════════════
  // DIRECTOR'S HINTS AUTO-GENERATION
  // ═══════════════════════════════════════════════════

  /**
   * Generate a director's creative brief using all available story context.
   * Each variation (1-5) focuses on a different creative angle.
   */
  async generateDirectorsHint(userId, options = {}) {
    const {
      storyFocus = 'product', genre = 'drama', tone = 'engaging',
      targetAudience = 'young professionals', brandKitJobId,
      subject, personas = [], variation = 1
    } = options;

    let brandContext = '';
    if (brandKitJobId) {
      try {
        const job = await getMediaTrainingJobById(brandKitJobId, userId);
        if (job?.brand_kit) brandContext = _buildBrandKitContextBlock(job.brand_kit);
      } catch (e) { /* fine */ }
    }

    const subjectContext = subject?.name
      ? `SUBJECT: "${subject.name}" (${subject.category || ''}). ${subject.description || ''} Visual: ${subject.visual_description || ''}`
      : '';

    const personaContext = personas.length > 0
      ? `CHARACTERS: ${personas.join('; ')}`
      : '';

    const angles = {
      1: 'Focus on CINEMATOGRAPHY: Describe the lens, lighting setup, color grading, camera movements, and film stock. Reference specific cinematographers (Roger Deakins, Bradford Young). Be technical and visual.',
      2: 'Focus on EMOTION & PACING: Describe the emotional rhythm, tension curve, silence vs intensity. Reference pacing styles (Thelma Schoonmaker jump cuts, Terrence Malick contemplative, Edgar Wright kinetic).',
      3: 'Focus on FILM REFERENCES: Name 2-3 specific films or directors whose style should inspire this. Describe what to borrow from each — the specific visual/tonal quality.',
      4: 'Focus on SENSORY EXPERIENCE: Describe textures, sounds, temperature of each frame. Reference sensory-rich filmmakers (Wong Kar-Wai, Sofia Coppola, Denis Villeneuve).',
      5: 'WILDCARD — find an unexpected creative angle. Maybe a musical analogy, an architectural principle, a painting movement. Surprise the user.'
    };

    const prompt = `You are an Oscar-winning film director writing a 2-3 sentence creative brief for a branded short film series.

STORY CONTEXT:
- Focus: ${storyFocus} (${storyFocus === 'person' ? 'character-driven' : storyFocus === 'landscape' ? 'location cinema' : 'product showcase'})
- Genre: ${genre}
- Tone: ${tone}
- Target audience: ${targetAudience}
${subjectContext ? '\n' + subjectContext : ''}
${personaContext ? '\n' + personaContext : ''}
${brandContext}

YOUR CREATIVE ANGLE:
${angles[variation] || angles[1]}

Write a vivid, specific, 2-3 sentence director's creative brief. It should read like a director pitching their vision to a cinematographer — precise, evocative, referencing specific techniques, films, or visual languages. NO generic advice. NO lists. Just a concentrated cinematic vision statement.

Respond with ONLY the director's brief text — no quotes, no labels, no JSON.`;

    // V4 uses Vertex AI Gemini (not AI Studio).
    if (!isVertexGeminiConfigured()) {
      throw new Error('Vertex Gemini not configured — set GCP_PROJECT_ID and GOOGLE_APPLICATION_CREDENTIALS_JSON (or ADC)');
    }

    // Token budget: 4096 (was 512). Gemini 3 Flash Preview uses thinking
    // tokens before the visible output; 512 truncates even short prompts.
    // See Day 0 2026-04-11 fix notes in services/v4/VoiceAcquisition.js.
    const hint = (await callVertexGeminiText({
      userPrompt: prompt,
      config: {
        maxOutputTokens: 4096,
        temperature: 1.0
      },
      timeoutMs: 30000
    }))?.trim();

    if (!hint) throw new Error('Gemini returned empty hint');

    logger.info(`Director's hint (variation ${variation}): ${hint.slice(0, 80)}...`);
    return hint;
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

    // Step 1: Vertex AI Gemini generates persona descriptions that fit the brand.
    // If the Brand Kit has real people photos, Gemini describes each one so the
    // generated persona LOOKS LIKE the actual brand person (not a random face).
    if (!isVertexGeminiConfigured()) {
      throw new Error('Vertex Gemini not configured — set GCP_PROJECT_ID and GOOGLE_APPLICATION_CREDENTIALS_JSON (or ADC)');
    }

    // Collect real people from Brand Kit extracted assets + descriptions
    const extractedPeople = (brandKit.extracted_assets || []).filter(a => a.type === 'person');
    const peopleDescriptions = brandKit.people || [];

    const focusGuidance = storyFocus === 'person'
      ? 'This persona IS the star — a compelling, camera-ready individual whose face and presence will anchor every episode. Design someone who looks like a lead actor in a prestige TV series.'
      : storyFocus === 'landscape'
        ? 'This persona is a GUIDE through a beautiful space — think travel host, architecture narrator, or real estate presenter. They should look approachable, expressive, and photogenic but not steal focus from the environment.'
        : 'This persona interacts with a PRODUCT — think lifestyle model, product reviewer, or brand ambassador. They should look authentic, relatable to the target audience, and complement the product aesthetically.';

    // If the brand has real people, tell Gemini to design personas BASED ON them
    // — each person photo is a DIFFERENT individual.
    const realPeopleBlock = extractedPeople.length > 0
      ? `\nREAL BRAND PEOPLE (${extractedPeople.length} distinct individuals found in brand assets):
${extractedPeople.map((p, i) => {
  const desc = peopleDescriptions[i]?.description || p.description || '';
  const role = peopleDescriptions[i]?.role || '';
  return `  Person ${i + 1}: ${desc}${role ? ` (role: ${role})` : ''}`;
}).join('\n')}

CRITICAL: Each person above is a DIFFERENT real individual from the brand's own photos.
Your generated persona(s) must closely MATCH these real people — describe their ACTUAL
appearance as seen in the brand photos (skin tone, hair color/style, approximate age,
build, facial features). The AI portrait generator will use the real person's photo as
a reference image, so your text description must align with what's in that photo.
Do NOT invent a completely different-looking person — describe the real person you see,
then add personality, wardrobe, and character depth on top.
${count <= extractedPeople.length ? `Generate exactly ${count} persona(s), one for each of the first ${count} brand person(s) above.` : `Generate ${count} persona(s) — use the ${extractedPeople.length} real brand person(s) first, then create additional character(s) that complement them.`}\n`
      : '';

    const systemPrompt = `You are the show-runner casting the leads of a prestige limited series. You are not writing ad copy. You are building CHARACTERS — the kind an Emmy-nominated actor would sign on to play. Each character must have interiority, contradiction, a voice you can hear in one line, and a specific reason to exist in THIS brand's world.

Design ${count} character(s) whose appearance, vibe, voice, and interior life match the brand below. The characters will speak on camera across 8-12 episodes. They must be able to sustain conflict, comedy, revelation, and escalation — not just say one tagline.

${brandContext}
${realPeopleBlock}
${focusGuidance}

For each character produce a full character bible. Every field is load-bearing — none are decoration.

1. name — fitting first name (cultural fit with brand).
2. appearance — Detailed physical description for AI image generation (age range, ethnicity, build, hair, facial features, expression, clothing style). Be SPECIFIC — this drives a portrait generator. 100+ words.${extractedPeople.length > 0 ? ' For personas based on real brand people, describe what you see in their photos — the generator will use their actual photo as input.' : ''}
3. wardrobe_hint — One-line wardrobe for the first episode (matches brand aesthetic).
4. personality — Three adjectives, each paired with a behavioural specific (NOT "charming" but "charming — disarms hostility with unexpected honesty").
5. dramatic_archetype — choose ONE of: HERO | ANTIHERO | MENTOR | TRICKSTER | SKEPTIC | ZEALOT | INGENUE | OUTSIDER | AUTHORITY | REBEL | WOUNDED_HEALER | GATEKEEPER.
6. want — What they pursue consciously. One sentence. Must be visible on screen within the first two episodes.
7. need — What they actually require to grow, usually at odds with the want. One sentence. The secret engine of their arc.
8. wound — One past fact, never a vague "trauma". Must be a sentence containing a SPECIFIC NOUN (a person, a place, a date, an object). This is the pressure point that shapes their subtext.
9. flaw — The mistake they repeat under pressure. One sentence.
10. core_contradiction — The productive tension inside them (e.g. "an optimist who keeps their bags packed", "a cynic who cannot stop hoping").
11. moral_code — One sentence. The line they CLAIM they won't cross, or actually won't.
12. relationship_to_subject — 1-2 sentences tying them to the brand's subject / product / place in a STORY-BEARING way. Not "enjoys the product"; something like "inherited the shop from her grandmother and is one bad quarter away from closing it".
13. relationships — If other characters exist, one entry per pairing: { other_persona_index, dynamic: "sibling rivalry with love underneath", unresolved: "the thing they never said aloud" }. The unresolved line drives subtext.
14. speech_patterns — the character's voice as a craft weapon:
    - vocabulary: register (e.g. "precise corporate", "working-class Dublin", "academic hedged", "street laconic", "theatrical baroque")
    - sentence_length: rhythm (e.g. "clipped 3-6 word fragments", "long unfurling sentences", "starts long, snaps short when cornered")
    - tics: array of 2-4 recurring verbal habits — a filler, a deflection, a sign-off, a metaphor family
    - avoids: array of 2-3 linguistic moves they never do (e.g. "never says I love you", "never swears", "never uses first names — only titles")
    - signature_line: ONE example line only THEY would say, in their own voice. This is a tuning-fork the screenwriter matches against.
15. voice_brief — delivery direction for the synthesis layer:
    - emotional_default (e.g. "quietly amused", "coiled patience", "brittle cheer")
    - pace: slow | medium | fast | variable
    - warmth: cold | neutral | warm
    - power: low-status | equal | high-status
    - vocal_color: breathy | resonant | nasal | gravelly

HARD RULES:
- Two characters in the same cast MUST have distinct vocabularies, sentence rhythms, archetypes, AND avoidance lists. If two characters sound alike, rewrite one.
- Characters derived from real brand people keep their PHYSICAL likeness; interiority is invented to FIT what's visible in the photo.
- No "quirky" for quirky's sake. Every tic must be justifiable as a defence mechanism, a power move, a class marker, or a wound symptom.
- Genre-neutral fields. Do not assume drama — the same schema serves action, comedy, thriller, mystery, warm-heart, horror. Tone sits in the brand context, not in the character.
- The appearance must feel AUTHENTIC to the brand's target audience. A luxury brand gets refined, elegant personas. A streetwear brand gets edgy, urban personas. A wellness brand gets serene, natural personas.

Respond with ONLY valid JSON:
{ "personas": [ { "name", "appearance", "wardrobe_hint", "personality", "dramatic_archetype", "want", "need", "wound", "flaw", "core_contradiction", "moral_code", "relationship_to_subject", "relationships", "speech_patterns", "voice_brief" } ] }`;

    const raw = await callVertexGeminiText({
      userPrompt: systemPrompt,
      config: {
        maxOutputTokens: 4096,
        temperature: 0.9,
        responseMimeType: 'application/json'
      },
      timeoutMs: 30000
    });
    if (!raw) throw new Error('Gemini returned empty response for persona generation');

    const parsed = this._parseGeminiJson(raw);
    const geminiPersonas = parsed.personas || [parsed];

    // Step 2: Generate a portrait for each persona via fal.ai Flux 2 Max
    // (migrated from Replicate on 2026-04-11 — same model, unified vendor surface).
    if (!fluxFalService.isAvailable()) {
      throw new Error('FAL_GCS_API_KEY not set — required for V4 auto-persona character sheet generation via Flux 2 Max');
    }

    // Build per-persona reference image arrays.
    // Priority: the matching real person's cutout (strongest identity signal) first,
    // then other brand people photos (style/ethnicity context), NO logos (waste slots).
    // Flux 2 Max accepts up to 8 input_images — use all available.
    const allPersonCutouts = extractedPeople.map(p => p.url).filter(Boolean);

    const sc = brandKit.style_characteristics || {};
    const styleHint = [sc.overall_aesthetic, sc.photography_style, sc.mood].filter(Boolean).join(', ');

    const results = [];
    for (let i = 0; i < Math.min(geminiPersonas.length, count); i++) {
      const p = geminiPersonas[i];
      const baseSeed = Math.floor(Math.random() * 2147483647);

      // Build input_images for THIS persona:
      // 1st: this persona's own brand person cutout (if exists) — strongest identity anchor
      // 2nd-Nth: other brand person cutouts (for style/demographic context, not identity)
      // This ensures Flux generates a face that matches the real brand person.
      const thisPersonCutout = allPersonCutouts[i] || null;
      const otherPeopleCutouts = allPersonCutouts.filter((_, idx) => idx !== i);
      const personaInputImages = [
        thisPersonCutout,
        ...otherPeopleCutouts
      ].filter(Boolean).slice(0, 8);

      logger.info(`[Persona ${i + 1}] input_images: ${thisPersonCutout ? '1 primary cutout' : 'no cutout'} + ${Math.max(0, personaInputImages.length - (thisPersonCutout ? 1 : 0))} other refs = ${personaInputImages.length} total`);

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
      let heroInputImages = [...personaInputImages]; // Start with this persona's brand person refs

      for (let v = 0; v < views.length; v++) {
        const view = views[v];

        // V4 migration 2026-04-11: auto-persona character sheets now go through
        // fal.ai Flux 2 Max via FluxFalService (FAL_GCS_API_KEY) instead of
        // Replicate. Same model, unified vendor surface with the rest of V4.
        let imageBuffer;
        try {
          const portraitResult = await fluxFalService.generatePortrait({
            prompt: view.prompt,
            referenceImages: heroInputImages,
            options: {
              aspectRatio: view.aspect,
              seed: baseSeed + v
            }
          });
          imageBuffer = portraitResult.imageBuffer;
        } catch (err) {
          logger.warn(`${p.name} ${view.label} view: fal.ai Flux 2 Max failed — ${err.message} — skipping`);
          continue;
        }

        const filename = `auto-persona-${Date.now()}-${i}-${view.label}.webp`;
        const imageUrl = await this._uploadBufferToStorage(
          imageBuffer, userId, 'personas', filename, 'image/webp'
        );
        personaImageUrls.push(imageUrl);

        // After hero shot, prepend it as the strongest identity anchor for subsequent views.
        // The generated hero IS this persona — subsequent views must match it exactly.
        if (v === 0) {
          heroInputImages = [imageUrl, ...personaInputImages].slice(0, 8);
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
        omnihuman_seed_image_url: personaImageUrls[0], // hero shot
        // Store the original brand person cutout URL so downstream (storyboard, Kling)
        // can use the REAL person photo alongside the generated character sheet
        brand_person_source_url: thisPersonCutout || null,

        // V4 character-bible fields — optional, consumed by the screenplay cheat-sheet
        // and downstream (VoiceAcquisition, validator). All fields fall back to null
        // for legacy personas where Gemini returns only the old schema.
        dramatic_archetype: p.dramatic_archetype || null,
        want: p.want || null,
        need: p.need || null,
        wound: p.wound || null,
        flaw: p.flaw || null,
        core_contradiction: p.core_contradiction || null,
        moral_code: p.moral_code || null,
        relationship_to_subject: p.relationship_to_subject || null,
        relationships: Array.isArray(p.relationships) ? p.relationships : [],
        speech_patterns: p.speech_patterns || null,
        voice_brief: p.voice_brief || null
      });

      logger.info(`Character sheet for ${p.name}: ${personaImageUrls.length} views ready`);
    }

    if (results.length === 0) throw new Error('Failed to generate any persona character sheets');
    return results;
  }

  // ═══════════════════════════════════════════════════
  // V4 PIPELINE (scene → beat architecture)
  // ═══════════════════════════════════════════════════

  /**
   * V4 episode generation pipeline.
   *
   * The full sequence:
   *   1. Acquire persona voices (Gemini brief → ElevenLabs preset, idempotent)
   *   2. Match Brand Kit → LUT (cached on story.brand_kit_lut_id, idempotent)
   *   3. Gemini scene-graph generation (per-scene, per-beat)
   *   4. Brand safety filter (validate generated dialogue lines)
   *   5. BeatRouter preflight (expand SHOT_REVERSE_SHOT, sum cost, enforce cap)
   *   6. Generate Scene Master panels (Seedream 5 Lite × scenes, parallel)
   *   7. Generate beats sequentially within each scene (endframe chaining for continuity)
   *   8. Generate music bed (ElevenLabs Music sized to assembled duration)
   *   9. Run post-production (correction LUTs → assembly → creative LUT → music mix)
   *   10. Upload final episode video, mark ready, update story_so_far
   *
   * Beat-level resume: every successful beat persists its generated_video_url
   * and endframe_url onto episode.scene_description so partial failures can
   * resume from the next beat instead of restarting the episode.
   *
   * @param {string} storyId
   * @param {string} userId
   * @param {Function} [onProgress] - optional progress callback (stage, detail)
   * @returns {Promise<Object>} the completed episode record
   */
  async runV4Pipeline(storyId, userId, onProgress) {
    // SSE emitter is created lazily once we know the episode_id (after the
    // first DB insert). For pre-episode-creation stages we still log + call
    // the legacy callback, but the SSE stream starts at the moment the
    // episode record exists. This matches the natural URL shape:
    // /api/brand-stories/:id/episodes/:episodeId/stream
    let emitter = null;

    const progress = (stage, detail, extras = {}) => {
      logger.info(`[V4Pipeline] ${stage}: ${detail}`);
      if (typeof onProgress === 'function') {
        try { onProgress(stage, detail); } catch {}
      }
      if (emitter) {
        try { emitter.emit(stage, detail, extras); } catch {}
      }
    };

    progress('start', `V4 pipeline starting for story ${storyId}`);

    // ─── Load story + validate ───
    const story = await getBrandStoryById(storyId, userId);
    if (!story) throw new Error(`V4: story ${storyId} not found`);
    if (!story.storyline) throw new Error(`V4: story ${storyId} has no storyline (run generateStoryline first)`);

    // Persist persona_config mutations from voice acquisition / LUT matching
    let personas = Array.isArray(story.persona_config?.personas)
      ? story.persona_config.personas
      : (story.persona_config ? [story.persona_config] : []);

    // Default placeholder names for personas that didn't carry one through
    // the wizard. Only the brand_kit_auto path generates a real name via
    // Gemini; the described/uploaded/brand_kit paths have no name field at
    // all. Without this, every log line about the persona says "unnamed"
    // which makes multi-persona runs nearly unreadable. Assigns "Persona 1",
    // "Persona 2", etc. in the order personas were added to the story.
    // Caught 2026-04-21 — cosmetic only, no downstream dependency on .name.
    personas.forEach((p, i) => {
      if (!p.name || !String(p.name).trim()) p.name = `Persona ${i + 1}`;
    });

    // ─── Step 1: Persona voice acquisition (idempotent) ───
    progress('voices', `acquiring ${personas.length} persona voice(s)`);
    const voiceResult = await acquirePersonaVoicesForStory(personas);
    progress('voices', `acquired=${voiceResult.acquired}, skipped=${voiceResult.skipped}, failed=${voiceResult.failed}`);
    if (voiceResult.acquired > 0) {
      // Persist newly-acquired voices back to the story
      await updateBrandStory(storyId, userId, {
        persona_config: { ...(story.persona_config || {}), personas }
      });
    }

    // ─── Step 2: Brand Kit → LUT (cached, idempotent) ───
    let brandKit = null;
    if (story.brand_kit_job_id) {
      try {
        const job = await getMediaTrainingJobById(story.brand_kit_job_id, userId);
        brandKit = job?.brand_kit || null;
      } catch (err) {
        logger.warn(`V4: brand kit load failed: ${err.message}`);
      }
    }

    if (brandKit && !story.brand_kit_lut_id && !story.locked_lut_id) {
      // V4 LUT resolution — library-first, generative-fallback (per user request 2026-04-23).
      //
      // Previous flow was an exclusive either/or gated on BRAND_STORY_LUT_GENERATIVE:
      //   - Flag on  → synthesize generative LUT
      //   - Flag off → match curated library
      //
      // New flow respects the user's cinematic intent — curated library LUTs
      // are hand-crafted by pros and always beat a math-only generative LUT
      // when they exist on disk — while still giving a graceful color grade
      // when .cube files haven't been dropped yet:
      //   1. Match curated library LUT (always — fast, free, deterministic)
      //   2. Check if that LUT's .cube file exists on disk
      //   3. If missing AND BRAND_STORY_LUT_GENERATIVE=true AND brand kit has
      //      a color palette → synthesize a generative LUT from the palette
      //      and swap the lut_id
      //   4. If still no file + no fallback → store the library id anyway;
      //      PostProduction will gracefully skip the grade and log a clear
      //      drop-in hint
      progress('lut', `matching brand kit → LUT (library)`);
      const lutMatch = await matchBrandKitToLut(brandKit);
      let resolvedLutId = lutMatch.lutId;

      const generativeFallbackMode = process.env.BRAND_STORY_LUT_GENERATIVE === 'true';
      if (generativeFallbackMode) {
        const libraryPath = getLutFilePath(resolvedLutId);
        if (!libraryPath) {
          // Library LUT .cube is missing on disk — synthesize generative as fallback
          try {
            progress('lut', `library LUT ${resolvedLutId} missing on disk — synthesizing generative fallback`);
            const generated = await generateLutFromBrandKit(brandKit, { strength: 0.35 });
            if (generated?.lutId) {
              resolvedLutId = generated.lutId;
              progress('lut', `generative fallback → ${resolvedLutId}`);
            } else {
              progress('lut', `generative fallback produced no LUT (no palette) — keeping ${resolvedLutId} (ungraded)`);
            }
          } catch (err) {
            logger.warn(`V4: generative LUT fallback failed (${err.message}) — keeping library id ${resolvedLutId} (will render ungraded)`);
          }
        } else {
          progress('lut', `matched → ${resolvedLutId} (library .cube on disk — using hand-crafted)`);
        }
      } else {
        progress('lut', `matched → ${resolvedLutId}`);
      }

      await updateBrandStory(storyId, userId, { brand_kit_lut_id: resolvedLutId });
      story.brand_kit_lut_id = resolvedLutId;
    }

    // ─── Step 3: Gemini V4 scene-graph generation ───
    progress('screenplay', 'generating V4 scene-graph via Gemini');
    const previousEpisodes = await getBrandStoryEpisodes(storyId, userId);
    const previousReady = previousEpisodes.filter(e => e.status === 'ready' || e.status === 'published');
    const previousVisualStyle = story.storyline?.visual_style_prefix || '';
    const lastEpisode = previousReady[previousReady.length - 1];
    const previousEmotionalState = lastEpisode?.scene_description?.emotional_state || '';
    const lastCliffhanger = lastEpisode?.scene_description?.cliffhanger || '';
    const directorsNotes = story.subject?.directors_notes || '';

    // Cost cap is now a flat $20 ceiling (not tier-based) since Brand Story
    // is Business-tier-only. The episodeOverride path is kept so a specific
    // story can opt into a higher cap for a premium campaign.
    const costCapUsd = resolveCostCap({
      episodeOverride: story.episode_cost_cap_usd_override || null
    });

    // episode_number must use ALL existing episodes (regardless of status), not
    // just ready/published ones. Using previousReady.length caused duplicate-key
    // collisions when an earlier episode was stuck in a non-ready status
    // (e.g. 'regenerating_beat' or 'failed') — it wasn't counted, so the new
    // episode got episode_number=1 and collided with the existing row.
    // Caught 2026-04-11: Episode 1 stuck in 'regenerating_beat' → Generate
    // Episode 2 → previousReady=[] → episode_number=1 → UNIQUE violation.
    const nextEpisodeNumber = previousEpisodes.length + 1;

    let sceneGraph = await this._generateV4Screenplay({
      story,
      personas,
      previousEpisodes: previousReady.slice(-3), // last 3 READY episodes for continuity
      brandKit,
      previousVisualStyle,
      previousEmotionalState,
      lastCliffhanger,
      directorsNotes,
      costCapUsd,
      hasBrandKitLut: !!story.brand_kit_lut_id || !!story.locked_lut_id,
      episodeNumber: nextEpisodeNumber
    });

    progress('screenplay', `episode "${sceneGraph.title}" — ${sceneGraph.scenes?.length || 0} scenes`);

    // ─── Step 3b: Screenplay quality gate (Layer 1 validator + optional Doctor) ───
    // Layer 1: deterministic checks on the scene graph. Auto-repairs beat sizing.
    // Layer 2 (gated by env flag): Gemini script-doctor minimal-patch punch-up.
    // On any failure the pipeline proceeds with the best scene graph we have —
    // we never loop, we never block. The quality_report is persisted so the
    // Director's Panel can surface Layer-1 issues and Layer-2 edits for review.
    const storyFocus = story.story_focus || 'product';
    let qualityReport = { validator: null, doctor: null };
    try {
      const layer1 = validateScreenplay(sceneGraph, story.storyline || {}, personas, { storyFocus });
      qualityReport.validator = { issues: layer1.issues, stats: layer1.stats };
      sceneGraph = layer1.repaired;
      const blockers = layer1.issues.filter(i => i.severity === 'blocker').length;
      const warnings = layer1.issues.filter(i => i.severity === 'warning').length;
      progress('screenplay_qa', `Layer-1: ${blockers} blocker${blockers === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`, {
        blockers, warnings, stats: layer1.stats
      });

      if (layer1.needsPunchUp) {
        progress('screenplay_qa', 'Layer-2 Doctor pass triggered');
        const layer2 = await punchUpScreenplay(sceneGraph, personas, layer1.issues);
        qualityReport.doctor = {
          applied: layer2.applied,
          rejected: layer2.rejected,
          notes: layer2.notes,
          skipped: layer2.skipped
        };
        if (layer2.skipped) {
          progress('screenplay_qa', `Doctor skipped: ${layer2.skipped}`);
        } else {
          sceneGraph = layer2.patched;
          progress('screenplay_qa', `Doctor applied ${layer2.applied.length} edits`);
          // Re-run Layer 1 once to capture post-doctor state in the report.
          // We do NOT loop — a second blocker list just gets logged.
          const layer1b = validateScreenplay(sceneGraph, story.storyline || {}, personas, { storyFocus });
          qualityReport.validator_post_doctor = { issues: layer1b.issues, stats: layer1b.stats };
          sceneGraph = layer1b.repaired;
        }
      }
    } catch (err) {
      logger.warn(`V4 screenplay quality gate failed (${err.message}) — proceeding with original scene graph`);
      qualityReport.validator = qualityReport.validator || { issues: [], stats: {} };
      qualityReport.error = err.message;
    }

    // ─── Step 4: Brand safety filter (lightweight validation pass) ───
    this._brandSafetyFilter(sceneGraph);

    // ─── Step 5: Create episode record + run BeatRouter preflight ───
    const newEpisode = await createBrandStoryEpisode(storyId, userId, {
      episode_number: nextEpisodeNumber,
      scene_description: sceneGraph,
      pipeline_version: 'v4',
      status: 'generating_scene_masters',
      cost_cap_usd: costCapUsd,
      quality_report: qualityReport
    });

    // Activate SSE emitter now that we have the episode_id. From this point
    // onward every progress(...) call also broadcasts to any connected
    // SSE clients via /api/brand-stories/:id/episodes/:episodeId/stream
    emitter = getOrCreateProgressEmitter(newEpisode.id);
    progress('episode_created', `episode_id=${newEpisode.id}`, { episode_id: newEpisode.id });

    const router = new BeatRouter({
      falServices: {
        kling: klingFalService,
        veo: veoService, // Vertex AI backend (free under GCP quota), NOT fal.ai
        syncLipsync: syncLipsyncFalService,
        seedream: seedreamFalService,
        flux: fluxFalService,
        omniHuman: omniHumanService
      },
      tts: ttsService
    });

    const preflight = router.preflight({
      scenes: sceneGraph.scenes,
      costCapUsd
    });

    progress('preflight', `${preflight.beatCount} beats, est $${preflight.totalEstimatedCost.toFixed(2)} / cap $${costCapUsd.toFixed(2)}`);

    if (!preflight.withinCap) {
      await updateBrandStoryEpisode(newEpisode.id, userId, {
        status: 'failed',
        error_message: `Cost cap exceeded: estimated $${preflight.totalEstimatedCost.toFixed(2)} > cap $${costCapUsd.toFixed(2)}`
      });
      throw new Error(`V4: cost cap exceeded ($${preflight.totalEstimatedCost.toFixed(2)} > $${costCapUsd.toFixed(2)})`);
    }

    // ─── Step 6: Scene Master generation ───
    progress('scene_masters', `generating ${sceneGraph.scenes.length} Scene Master panel(s)`);
    const subjectReferenceImages = (story.subject?.reference_image_urls || []).filter(Boolean);
    const uploadBufferToStorage = (buffer, subfolder, filename, mimeType) =>
      this._uploadBufferToStorage(buffer, userId, subfolder, filename, mimeType);

    await generateSceneMasters({
      scenes: sceneGraph.scenes,
      visualStylePrefix: sceneGraph.visual_style_prefix,
      personas,
      subjectReferenceImages,
      storyFocus: story.story_focus || 'product',
      userId,
      uploadBuffer: uploadBufferToStorage,
      baseSeed: previousReady.length * 100 // varies per episode, deterministic across retries
    });

    // Persist scene master URLs to the episode
    await updateBrandStoryEpisode(newEpisode.id, userId, {
      scene_description: sceneGraph,
      status: 'generating_beats'
    });

    // ─── Step 7: Beat generation (sequential within scene for endframe chaining) ───
    progress('beats', `generating beats sequentially within each scene`);
    const beatVideoBuffers = [];
    const beatMetadata = [];

    // Episode context shared across all beat generators
    const episodeContext = {
      visual_style_prefix: sceneGraph.visual_style_prefix || '',
      storyId,
      episodeId: newEpisode.id,
      userId,
      subjectReferenceImages,
      subject: story.subject || null,
      // Subject Bible (Phase 1.1) — persistent cross-episode subject spec
      subject_bible: story.subject?.subject_bible || story.subject_bible || null,
      // Location Bible (Phase 1.2) — persistent cross-episode location dictionary
      locationBible: story.location_bible || null,
      // Brand Kit — drives branded title/end cards, subtitle styling, color-aware overlays
      brandKit: brandKit || null,
      defaultNarratorVoiceId: personas[0]?.elevenlabs_voice_id || 'nPczCjzI2devNBz1zQrb',
      // Audio uploader injected so beat generators can stash TTS to a public URL
      uploadAudio: async ({ buffer, filename, mimeType }) => {
        return this._uploadBufferToStorage(buffer, userId, 'audio/v4', filename, mimeType);
      },
      // Generic buffer uploader — used by Phase 2's persona-locked first frame
      // helper (Seedream PNG → Supabase) and any future beat-level intermediate
      // artifacts that need a public URL.
      uploadBuffer: uploadBufferToStorage
    };

    // Sequential generation within scenes to support endframe chaining,
    // parallel between scenes for speed.
    for (const scene of sceneGraph.scenes) {
      let previousBeat = null;

      // MONTAGE_SEQUENCE handling: scenes flagged as 'montage' are generated
      // as a single Kling V3 Pro multi-shot call instead of per-beat.
      if (scene.type === 'montage') {
        progress('beats', `scene ${scene.scene_id} → MONTAGE (single multi-shot call)`);
        const montageGen = new MontageSequenceGenerator({
          falServices: {
            kling: klingFalService,
            veo: veoService, // Vertex AI (free under GCP quota), NOT fal.ai
            syncLipsync: syncLipsyncFalService,
            omniHuman: omniHumanService
          },
          tts: ttsService
        });

        try {
          const result = await montageGen.generateScene({
            scene,
            personas,
            episodeContext,
            previousScene: null
          });

          // Upload the montage video and treat it as ONE virtual beat
          const publicUrl = await uploadBufferToStorage(
            result.videoBuffer,
            'videos/v4-beats',
            `montage-${scene.scene_id}.mp4`,
            'video/mp4'
          );

          // Extract endframe for the next scene's anchoring
          let endframeUrl = null;
          try {
            const endframeBuffer = await extractBeatEndframe(result.videoBuffer);
            endframeUrl = await uploadBufferToStorage(
              endframeBuffer,
              'videos/v4-endframes',
              `montage-${scene.scene_id}-end.jpg`,
              'image/jpeg'
            );
          } catch (err) {
            logger.warn(`montage endframe extraction failed: ${err.message}`);
          }

          // Mark all child beats as satisfied via this single call
          for (const beat of scene.beats) {
            beat.generated_video_url = publicUrl;
            beat.endframe_url = endframeUrl;
          }
          beatVideoBuffers.push(result.videoBuffer);
          beatMetadata.push({
            beat_id: `${scene.scene_id}_montage`,
            model_used: result.modelUsed,
            duration_seconds: result.durationSec,
            actual_duration_sec: result.durationSec
          });
          previousBeat = { endframe_url: endframeUrl };
        } catch (err) {
          logger.error(`montage scene ${scene.scene_id} failed: ${err.message}`);
          for (const beat of scene.beats) {
            beat.status = 'failed';
            beat.error_message = err.message;
          }
        }
        continue; // skip per-beat loop for this scene
      }

      // Standard scene: generate beats sequentially with endframe chaining
      for (const beat of scene.beats) {
        // Skip non-generative beat types (text overlays, speed ramps) — handled in post
        if (beat.type === 'SPEED_RAMP_TRANSITION') continue;

        // Resume check: if this beat already has a generated_video_url from a
        // prior failed run, fetch the buffer and skip generation.
        if (beat.generated_video_url && beat.status === 'generated') {
          progress('beats', `beat ${beat.beat_id} → reusing prior generated_video_url`);
          try {
            const cached = await axios.get(beat.generated_video_url, { responseType: 'arraybuffer', timeout: 60000 });
            const cachedBuffer = Buffer.from(cached.data);
            beatVideoBuffers.push(cachedBuffer);
            beatMetadata.push({
              beat_id: beat.beat_id,
              model_used: beat.model_used,
              duration_seconds: beat.duration_seconds,
              actual_duration_sec: beat.actual_duration_sec || beat.duration_seconds
            });
            previousBeat = { endframe_url: beat.endframe_url };
            continue;
          } catch (err) {
            logger.warn(`beat ${beat.beat_id} cached fetch failed, regenerating: ${err.message}`);
          }
        }

        // Build the reference stack for this beat. Phase 1.4 extends the stack
        // to include subject refs (user-uploaded imagery) on subject-anchored
        // beats and the Location Bible master when scene.location_id resolves.
        const refStack = buildBeatRefStack({
          beat,
          scene,
          previousBeat,
          personas,
          subjectReferenceImages,
          locationBible: story.location_bible || null
        });

        // Route + generate
        try {
          const result = await router.generate({
            beat,
            scene,
            refStack,
            personas,
            episodeContext,
            previousBeat
          });

          // Phase 8 — Quality Gate: run deterministic QC on the beat before
          // uploading / chaining forward. Critical issues (mostly-black,
          // corrupt dimensions) mark the beat as failed-qc so the Director
          // Panel surfaces the caution chip; orchestrator currently logs and
          // continues so the user can choose to regenerate via the Director
          // Panel's per-beat regenerate endpoint. Auto-retry is a Phase 8.b
          // enhancement that will reuse the persona-lock path for REACTION /
          // B_ROLL and nudged prompts for INSERT_SHOT.
          try {
            const qc = await runQualityGate({ videoBuffer: result.videoBuffer, beat });
            beat.quality_gate = qc;
            if (!qc.passed) {
              logger.warn(
                `beat ${beat.beat_id} quality gate FAILED: ${qc.issues.map(i => `${i.id}:${i.severity}`).join(', ')}`
              );
            } else if (qc.issues.length > 0) {
              logger.info(
                `beat ${beat.beat_id} quality gate passed with ${qc.issues.length} warning(s)`
              );
            }
          } catch (qcErr) {
            // QC gate is a soft layer — a gate failure MUST NOT block the beat.
            logger.warn(`beat ${beat.beat_id} quality gate threw: ${qcErr.message}`);
            beat.quality_gate_error = qcErr.message;
          }

          // Upload the generated video buffer
          const publicUrl = await uploadBufferToStorage(
            result.videoBuffer,
            'videos/v4-beats',
            `${beat.beat_id}.mp4`,
            'video/mp4'
          );
          beat.generated_video_url = publicUrl;

          // Extract endframe for next-beat continuity
          try {
            const endframeBuffer = await extractBeatEndframe(result.videoBuffer);
            const endframeUrl = await uploadBufferToStorage(
              endframeBuffer,
              'videos/v4-endframes',
              `${beat.beat_id}-end.jpg`,
              'image/jpeg'
            );
            beat.endframe_url = endframeUrl;
          } catch (err) {
            logger.warn(`beat ${beat.beat_id} endframe extraction failed: ${err.message}`);
          }

          beatVideoBuffers.push(result.videoBuffer);
          beatMetadata.push({
            beat_id: beat.beat_id,
            model_used: result.modelUsed,
            duration_seconds: beat.duration_seconds,
            actual_duration_sec: result.durationSec
          });
          previousBeat = beat;

          // Persist beat-level progress so partial failures can resume
          await updateBrandStoryEpisode(newEpisode.id, userId, {
            scene_description: sceneGraph
          });
        } catch (err) {
          logger.error(`beat ${beat.beat_id} failed: ${err.message}`);
          beat.status = 'failed';
          beat.error_message = err.message;
          await updateBrandStoryEpisode(newEpisode.id, userId, {
            scene_description: sceneGraph
          });
        }
      }

      // ─── V4 Phase 6.1 — Narrative bridge beat ───
      // When Gemini emitted scene.bridge_to_next, render a 2-3s Veo B-roll
      // connector that shows HOW the story transitions from this scene's
      // endframe to the next scene's master. The bridge is spliced into the
      // beat stream as a synthetic SCENE_BRIDGE beat so the assembly picks
      // it up without any additional post-production wiring.
      if (process.env.V4_BRIDGE_BEATS !== 'false' && scene.bridge_to_next && typeof scene.bridge_to_next === 'object') {
        const sceneIdx = sceneGraph.scenes.indexOf(scene);
        const nextScene = sceneGraph.scenes[sceneIdx + 1];
        if (nextScene) {
          const bridgeBeat = {
            beat_id: `${scene.scene_id || `s${sceneIdx}`}_bridge`,
            type: 'SCENE_BRIDGE',
            framing: scene.bridge_to_next.framing || 'bridge_transit',
            duration_seconds: Math.max(2, Math.min(4, scene.bridge_to_next.duration_seconds || 2.5)),
            visual_prompt: scene.bridge_to_next.visual_prompt || '',
            ambient_sound: scene.bridge_to_next.ambient_sound || '',
            bridge_from_scene_endframe_url: previousBeat?.endframe_url || null,
            bridge_to_scene_master_url: nextScene.scene_master_url || null,
            personas_present: []
          };
          try {
            const result = await router.generate({
              beat: bridgeBeat,
              scene,
              refStack: [],
              personas,
              episodeContext,
              previousBeat
            });
            const bridgeUrl = await uploadBufferToStorage(
              result.videoBuffer,
              'videos/v4-beats',
              `${bridgeBeat.beat_id}.mp4`,
              'video/mp4'
            );
            bridgeBeat.generated_video_url = bridgeUrl;
            try {
              const endframeBuffer = await extractBeatEndframe(result.videoBuffer);
              bridgeBeat.endframe_url = await uploadBufferToStorage(
                endframeBuffer,
                'videos/v4-endframes',
                `${bridgeBeat.beat_id}-end.jpg`,
                'image/jpeg'
              );
            } catch {}
            beatVideoBuffers.push(result.videoBuffer);
            beatMetadata.push({
              beat_id: bridgeBeat.beat_id,
              model_used: result.modelUsed,
              duration_seconds: bridgeBeat.duration_seconds,
              actual_duration_sec: result.durationSec
            });
            // Splice the bridge into the scene's beats list so the Director
            // Panel sees it and resume paths can find it.
            scene.beats.push(bridgeBeat);
            previousBeat = bridgeBeat;
            await updateBrandStoryEpisode(newEpisode.id, userId, {
              scene_description: sceneGraph
            });
          } catch (err) {
            logger.warn(`scene ${scene.scene_id} bridge beat failed — falling back to xfade: ${err.message}`);
          }
        }
      }
    }

    if (beatVideoBuffers.length === 0) {
      await updateBrandStoryEpisode(newEpisode.id, userId, {
        status: 'failed',
        error_message: 'no beats generated successfully'
      });
      throw new Error('V4: no beats generated successfully');
    }

    // ─── Step 8: Music bed (ElevenLabs Music sized to assembled duration) ───
    let musicBedBuffer = null;
    let musicBedUrl = null;
    if (sceneGraph.music_bed_intent && musicService.isAvailable()) {
      const totalDuration = estimateEpisodeDuration(beatMetadata);
      progress('music', `generating music bed (${totalDuration.toFixed(0)}s)`);
      try {
        const musicResult = await musicService.generateMusicBed({
          musicBedIntent: sceneGraph.music_bed_intent,
          durationSec: totalDuration
        });
        musicBedBuffer = musicResult.audioBuffer;
        musicBedUrl = await uploadBufferToStorage(
          musicResult.audioBuffer,
          'audio/v4-music',
          `episode-${newEpisode.id}-music.mp3`,
          'audio/mpeg'
        );
      } catch (err) {
        logger.warn(`V4: music generation failed (non-fatal): ${err.message}`);
      }
    }

    // ─── Step 9: Post-production (assembly + 2-pass LUT + music mix) ───
    progress('post_production', `assembly + 2-pass LUT grade${musicBedBuffer ? ' + music mix' : ''}`);
    await updateBrandStoryEpisode(newEpisode.id, userId, {
      status: 'applying_lut',
      music_bed_url: musicBedUrl
    });

    const episodeLutId = resolveEpisodeLut(story, { ...newEpisode, scene_description: sceneGraph });
    progress('post_production', `resolved LUT → ${episodeLutId}`);

    // Build beatMetadata with dialogue fields so the subtitle burn-in + music
    // ducking can use them. beatMetadata is currently a thin object, but the
    // scene-graph beats (inside sceneGraph.scenes[].beats) carry the dialogue.
    // Match index-for-index because beat generation iterated scenes in order.
    const enrichedBeatMetadata = [];
    let idx = 0;
    for (const scene of sceneGraph.scenes) {
      for (const beat of (scene.beats || [])) {
        if (beat.type === 'SPEED_RAMP_TRANSITION') continue;
        if (!beat.generated_video_url) continue;
        const base = beatMetadata[idx] || {};
        enrichedBeatMetadata.push({
          ...base,
          beat_id: beat.beat_id,
          dialogue: beat.dialogue || null,
          dialogues: beat.dialogues || null,
          exchanges: beat.exchanges || null,
          voiceover_text: beat.voiceover_text || null,
          ambient_sound: beat.ambient_sound || null
        });
        idx++;
      }
    }

    const episodeMeta = {
      series_title: story.storyline?.title || story.name || 'Untitled Series',
      episode_title: sceneGraph.title || `Episode ${newEpisode.episode_number}`,
      cliffhanger: sceneGraph.cliffhanger || '',
      // Phase 6.4 — branded cards. Brand kit drives font + color palette on
      // title/end cards; CTA text appears as the 3rd line on the end card
      // when the story has one configured.
      brand_kit: brandKit || null,
      cta_text: story.cta_text || story.storyline?.cta_text || null
    };

    const postProductionResult = await runPostProduction({
      beatVideoBuffers,
      beatMetadata: enrichedBeatMetadata,
      episodeLutId,
      musicBedBuffer,
      sceneGraph: sceneGraph.scenes,
      episodeMeta,
      burnSubtitles: true
    });
    const finalVideoBuffer = postProductionResult.finalBuffer;

    // Upload the SRT separately so the UI can expose it as a download
    let subtitleUrl = null;
    if (postProductionResult.srtContent) {
      try {
        subtitleUrl = await uploadBufferToStorage(
          Buffer.from(postProductionResult.srtContent, 'utf-8'),
          'srt/v4',
          `episode-${newEpisode.episode_number}.srt`,
          'text/plain'
        );
      } catch (err) {
        logger.warn(`V4: SRT upload failed (non-fatal): ${err.message}`);
      }
    }

    // ─── Step 10: Upload final + mark ready ───
    progress('upload', 'uploading final episode video');
    const finalVideoUrl = await uploadBufferToStorage(
      finalVideoBuffer,
      'videos/v4-final',
      `episode-${newEpisode.episode_number}-final.mp4`,
      'video/mp4'
    );

    const completedEpisode = await updateBrandStoryEpisode(newEpisode.id, userId, {
      scene_description: sceneGraph,
      final_video_url: finalVideoUrl,
      subtitle_url: subtitleUrl,
      status: 'ready',
      lut_id: episodeLutId
    });

    progress('complete', `Episode ${newEpisode.episode_number} ready: ${finalVideoUrl}`);

    // ─── Step 11: Update story_so_far appendix for continuity ───
    try {
      await this._updateStorySoFar(storyId, userId, completedEpisode);
    } catch (soFarErr) {
      logger.warn(`V4: story_so_far update failed (non-fatal): ${soFarErr.message}`);
    }

    return completedEpisode;
  }

  /**
   * V4: Regenerate a single beat inside an existing episode WITHOUT
   * regenerating the screenplay, Scene Masters, or creating a new episode row.
   *
   * Flow:
   *   1. Load the story + episode + personas
   *   2. For EVERY beat in scene order:
   *        - If beat.beat_id === target: run it fresh through the router
   *        - Otherwise: download its existing generated_video_url and reuse
   *   3. Re-run full post-production (assembly + LUT + music mix + overlays)
   *   4. Upload new final_video_url, mark episode ready
   *
   * This method is the correct endpoint for the Director's Panel "Regenerate
   * beat" button. It replaces the Phase 1b stub that incorrectly invoked
   * runV4Pipeline() — which always tries to INSERT a new episode row and
   * fails on `brand_story_episodes_story_id_episode_number_key` the moment
   * the source episode isn't in `ready` status.
   *
   * Caught on 2026-04-11 first Director's Panel test: both s2b3 and s3b2
   * regenerate attempts hit duplicate-key errors because runV4Pipeline's
   * previousReady filter excluded the in-progress source episode, making
   * it compute episode_number = 1 and collide with itself.
   *
   * @param {string} storyId
   * @param {string} userId
   * @param {string} episodeId
   * @param {string} beatId
   * @param {Object} [overrides] - editable beat fields from req.body
   * @param {Function} [onProgress] - SSE-style progress callback
   * @returns {Promise<Object>} the updated episode record
   */
  async regenerateBeatInEpisode(storyId, userId, episodeId, beatId, overrides = {}, onProgress) {
    let emitter = null;
    try {
      emitter = getOrCreateProgressEmitter(episodeId);
    } catch {}

    const progress = (stage, detail, extras = {}) => {
      logger.info(`[V4Regenerate] ${stage}: ${detail}`);
      if (typeof onProgress === 'function') {
        try { onProgress(stage, detail); } catch {}
      }
      if (emitter) {
        try { emitter.emit(stage, detail, extras); } catch {}
      }
    };

    progress('regenerate_start', `beat=${beatId} episode=${episodeId}`);

    // ─── Step 1: load story + episode + personas ───
    const story = await getBrandStoryById(storyId, userId);
    if (!story) throw new Error(`V4 regen: story ${storyId} not found`);

    const episode = await getBrandStoryEpisodeById(episodeId, userId);
    if (!episode) throw new Error(`V4 regen: episode ${episodeId} not found`);

    const sceneGraph = episode.scene_description || {};
    if (!Array.isArray(sceneGraph.scenes)) throw new Error(`V4 regen: episode has no scene-graph`);

    const personas = Array.isArray(story.persona_config?.personas)
      ? story.persona_config.personas
      : (story.persona_config ? [story.persona_config] : []);

    // Find the target beat (mutated in place below)
    let targetBeat = null;
    for (const scene of sceneGraph.scenes) {
      for (const beat of (scene.beats || [])) {
        if (beat.beat_id === beatId) {
          targetBeat = beat;
          break;
        }
      }
      if (targetBeat) break;
    }
    if (!targetBeat) throw new Error(`V4 regen: beat ${beatId} not found in episode`);

    // Apply allowed field overrides from the Director's Panel edit form
    const ALLOWED_OVERRIDES = [
      'dialogue', 'expression_notes', 'action_prompt', 'lens', 'emotion',
      'duration_seconds', 'subject_focus', 'lighting_intent', 'camera_move',
      'ambient_sound', 'location', 'atmosphere', 'gaze_direction',
      'voiceover_text'
    ];
    for (const k of ALLOWED_OVERRIDES) {
      if (overrides[k] !== undefined) targetBeat[k] = overrides[k];
    }
    // Clear the generated state so downstream code knows to actually generate
    targetBeat.generated_video_url = null;
    targetBeat.endframe_url = null;
    targetBeat.status = 'generating';
    targetBeat.error_message = null;

    // ─── Step 2: mark episode status ───
    await updateBrandStoryEpisode(episodeId, userId, {
      status: 'regenerating_beat',
      scene_description: sceneGraph
    });

    // ─── Step 3: build the BeatRouter with shared deps ───
    const router = new BeatRouter({
      falServices: {
        kling: klingFalService,
        veo: veoService,
        syncLipsync: syncLipsyncFalService,
        seedream: seedreamFalService,
        flux: fluxFalService,
        omniHuman: omniHumanService
      },
      tts: ttsService
    });

    const subjectReferenceImages = (story.subject?.reference_image_urls || []).filter(Boolean);
    const episodeContext = {
      visual_style_prefix: sceneGraph.visual_style_prefix || '',
      storyId,
      episodeId,
      userId,
      subjectReferenceImages,
      defaultNarratorVoiceId: personas[0]?.elevenlabs_voice_id || 'nPczCjzI2devNBz1zQrb',
      uploadAudio: async ({ buffer, filename, mimeType }) => {
        return this._uploadBufferToStorage(buffer, userId, 'audio/v4', filename, mimeType);
      }
    };

    // ─── Step 4: assemble beatVideoBuffers in canonical scene order ───
    // For every beat in the scene-graph: if it's the target, run it fresh;
    // otherwise, fetch its existing Supabase URL and reuse the buffer.
    // This preserves beat order and previousBeat chaining for endframes.
    const beatVideoBuffers = [];
    const beatMetadata = [];
    const uploadBufferToStorage = (buffer, subfolder, filename, mimeType) =>
      this._uploadBufferToStorage(buffer, userId, subfolder, filename, mimeType);

    for (const scene of sceneGraph.scenes) {
      let previousBeat = null;

      // MONTAGE_SEQUENCE scenes are atomic — they don't support per-beat
      // regen in Phase 1b because the whole scene is one multi-shot call.
      // If the target beat is inside a montage scene, throw a clear error
      // rather than silently regenerating the whole montage.
      if (scene.type === 'montage') {
        for (const beat of (scene.beats || [])) {
          if (beat.beat_id === beatId) {
            throw new Error(`V4 regen: beat ${beatId} is inside a MONTAGE scene — montage scenes regenerate as a unit, not per-beat`);
          }
          // Pull the existing montage video for non-target beats
          if (beat.generated_video_url) {
            const cached = await axios.get(beat.generated_video_url, { responseType: 'arraybuffer', timeout: 60000 });
            beatVideoBuffers.push(Buffer.from(cached.data));
            beatMetadata.push({
              beat_id: beat.beat_id,
              model_used: beat.model_used,
              duration_seconds: beat.duration_seconds,
              actual_duration_sec: beat.actual_duration_sec || beat.duration_seconds
            });
            previousBeat = { endframe_url: beat.endframe_url };
            break; // montage is one beat-equivalent, skip the rest
          }
        }
        continue;
      }

      for (const beat of (scene.beats || [])) {
        if (beat.type === 'SPEED_RAMP_TRANSITION') continue;

        if (beat.beat_id === beatId) {
          // ─── This IS the target: regenerate ───
          progress('regenerating_beat', `beat ${beatId} [${beat.type}]`);
          const refStack = buildBeatRefStack({ beat, scene, previousBeat, personas });

          const result = await router.generate({
            beat,
            scene,
            refStack,
            personas,
            episodeContext,
            previousBeat
          });

          const publicUrl = await uploadBufferToStorage(
            result.videoBuffer,
            'videos/v4-beats',
            `${beat.beat_id}-regen-${Date.now()}.mp4`,
            'video/mp4'
          );
          beat.generated_video_url = publicUrl;

          // Extract + upload a fresh endframe (the next beat's previousBeat
          // chain isn't used on regen, but we keep the endframe field
          // consistent so future regens of the NEXT beat can chain correctly).
          try {
            const endframeBuffer = await extractBeatEndframe(result.videoBuffer);
            const endframeUrl = await uploadBufferToStorage(
              endframeBuffer,
              'videos/v4-endframes',
              `${beat.beat_id}-regen-${Date.now()}-end.jpg`,
              'image/jpeg'
            );
            beat.endframe_url = endframeUrl;
          } catch (err) {
            logger.warn(`V4 regen: endframe extraction failed for ${beat.beat_id}: ${err.message}`);
          }

          beatVideoBuffers.push(result.videoBuffer);
          beatMetadata.push({
            beat_id: beat.beat_id,
            model_used: result.modelUsed,
            duration_seconds: beat.duration_seconds,
            actual_duration_sec: result.durationSec
          });
          previousBeat = beat;
          continue;
        }

        // ─── Not the target: reuse the existing generated video ───
        if (!beat.generated_video_url) {
          // This beat failed on the original run and is missing — skip.
          // Post-production will assemble without it, which matches the
          // original episode's shape.
          logger.warn(`V4 regen: beat ${beat.beat_id} has no generated_video_url — skipping`);
          continue;
        }
        try {
          const cached = await axios.get(beat.generated_video_url, { responseType: 'arraybuffer', timeout: 60000 });
          beatVideoBuffers.push(Buffer.from(cached.data));
          beatMetadata.push({
            beat_id: beat.beat_id,
            model_used: beat.model_used,
            duration_seconds: beat.duration_seconds,
            actual_duration_sec: beat.actual_duration_sec || beat.duration_seconds
          });
          previousBeat = { endframe_url: beat.endframe_url };
        } catch (err) {
          logger.warn(`V4 regen: failed to fetch beat ${beat.beat_id} from ${beat.generated_video_url}: ${err.message}`);
        }
      }
    }

    if (beatVideoBuffers.length === 0) {
      throw new Error('V4 regen: no beat buffers assembled — cannot re-run post-production');
    }

    // Persist the regenerated beat URL before heading into post-production
    await updateBrandStoryEpisode(episodeId, userId, {
      scene_description: sceneGraph
    });

    // ─── Step 5: music bed — reuse if already generated on the original run ───
    let musicBedBuffer = null;
    let musicBedUrl = episode.music_bed_url || null;
    if (musicBedUrl) {
      try {
        const cached = await axios.get(musicBedUrl, { responseType: 'arraybuffer', timeout: 60000 });
        musicBedBuffer = Buffer.from(cached.data);
      } catch (err) {
        logger.warn(`V4 regen: failed to fetch cached music bed: ${err.message}`);
      }
    }
    if (!musicBedBuffer && sceneGraph.music_bed_intent && musicService.isAvailable()) {
      const totalDuration = estimateEpisodeDuration(beatMetadata);
      progress('music', `generating music bed (${totalDuration.toFixed(0)}s)`);
      try {
        const musicResult = await musicService.generateMusicBed({
          musicBedIntent: sceneGraph.music_bed_intent,
          durationSec: totalDuration
        });
        musicBedBuffer = musicResult.audioBuffer;
        musicBedUrl = await uploadBufferToStorage(
          musicResult.audioBuffer,
          'audio/v4-music',
          `episode-${episodeId}-music-regen-${Date.now()}.mp3`,
          'audio/mpeg'
        );
      } catch (err) {
        logger.warn(`V4 regen: music gen failed (non-fatal): ${err.message}`);
      }
    }

    // ─── Step 6: enrich metadata for subtitles/ducking + re-run post-prod ───
    progress('post_production', 'reassembling episode with regenerated beat');
    await updateBrandStoryEpisode(episodeId, userId, {
      status: 'applying_lut',
      music_bed_url: musicBedUrl
    });

    const episodeLutId = resolveEpisodeLut(story, { ...episode, scene_description: sceneGraph });
    progress('post_production', `resolved LUT → ${episodeLutId}`);

    const enrichedBeatMetadata = [];
    let idx = 0;
    for (const scene of sceneGraph.scenes) {
      for (const beat of (scene.beats || [])) {
        if (beat.type === 'SPEED_RAMP_TRANSITION') continue;
        if (!beat.generated_video_url) continue;
        const base = beatMetadata[idx] || {};
        enrichedBeatMetadata.push({
          ...base,
          beat_id: beat.beat_id,
          dialogue: beat.dialogue || null,
          dialogues: beat.dialogues || null,
          exchanges: beat.exchanges || null,
          voiceover_text: beat.voiceover_text || null,
          ambient_sound: beat.ambient_sound || null
        });
        idx++;
      }
    }

    const episodeMeta = {
      series_title: story.storyline?.title || story.name || 'Untitled Series',
      episode_title: sceneGraph.title || `Episode ${episode.episode_number}`,
      cliffhanger: sceneGraph.cliffhanger || '',
      brand_kit: brandKit || null,
      cta_text: story.cta_text || story.storyline?.cta_text || null
    };

    const postProductionResult = await runPostProduction({
      beatVideoBuffers,
      beatMetadata: enrichedBeatMetadata,
      episodeLutId,
      musicBedBuffer,
      sceneGraph: sceneGraph.scenes,
      episodeMeta,
      burnSubtitles: true
    });
    const finalVideoBuffer = postProductionResult.finalBuffer;

    let subtitleUrl = null;
    if (postProductionResult.srtContent) {
      try {
        subtitleUrl = await uploadBufferToStorage(
          Buffer.from(postProductionResult.srtContent, 'utf-8'),
          'srt/v4',
          `episode-${episode.episode_number}-regen-${Date.now()}.srt`,
          'text/plain'
        );
      } catch (err) {
        logger.warn(`V4 regen: SRT upload failed (non-fatal): ${err.message}`);
      }
    }

    // ─── Step 7: upload final video, mark ready ───
    progress('upload', 'uploading regenerated final episode video');
    const finalVideoUrl = await uploadBufferToStorage(
      finalVideoBuffer,
      'videos/v4-final',
      `episode-${episode.episode_number}-regen-${Date.now()}.mp4`,
      'video/mp4'
    );

    const completedEpisode = await updateBrandStoryEpisode(episodeId, userId, {
      scene_description: sceneGraph,
      final_video_url: finalVideoUrl,
      subtitle_url: subtitleUrl,
      status: 'ready',
      lut_id: episodeLutId
    });

    progress('complete', `Beat ${beatId} regenerated: ${finalVideoUrl}`);
    return completedEpisode;
  }

  /**
   * V4: Re-run post-production on an existing episode WITHOUT regenerating
   * any beats and WITHOUT calling Gemini/Seedream/Veo/Kling.
   *
   * This is the Director's Panel "Reassemble" button. Use cases:
   *   - A post-production stage (SFX, LUT, subtitles, music mix) had a
   *     transient failure, you've fixed the underlying issue, and want to
   *     retry WITHOUT paying for beat generation again.
   *   - You changed the episode's LUT in the Director's Panel and want the
   *     new grade applied.
   *   - You dropped new correction/creative .cube files onto disk and want
   *     the existing episode to benefit from them.
   *
   * Flow:
   *   1. Load the existing episode + story + personas
   *   2. Download every beat's existing generated_video_url from Supabase
   *   3. Reuse existing music_bed_url if present (skip regeneration)
   *   4. Re-run the full post-production pipeline
   *   5. Upload a new final_video_url (with -reassemble-{timestamp} suffix)
   *   6. Update the SAME episode row — never creates a new one
   *
   * Replaces the Phase 1b stub that invoked runV4Pipeline() which tried to
   * INSERT a new brand_story_episodes row and collided on
   * UNIQUE(story_id, episode_number).
   *
   * Cost: $0 beat generation + whatever post-production API calls retry
   * (SFX via fal.ai ElevenLabs at ~$0.03/beat and music bed regen only if
   * the cached music_bed_url is missing).
   *
   * @param {string} storyId
   * @param {string} userId
   * @param {string} episodeId
   * @param {Function} [onProgress] - SSE-style progress callback
   * @returns {Promise<Object>} the updated episode record
   */
  async reassembleEpisode(storyId, userId, episodeId, onProgress) {
    let emitter = null;
    try {
      emitter = getOrCreateProgressEmitter(episodeId);
    } catch {}

    const progress = (stage, detail, extras = {}) => {
      logger.info(`[V4Reassemble] ${stage}: ${detail}`);
      if (typeof onProgress === 'function') {
        try { onProgress(stage, detail); } catch {}
      }
      if (emitter) {
        try { emitter.emit(stage, detail, extras); } catch {}
      }
    };

    progress('reassemble_start', `episode=${episodeId}`);

    // ─── Step 1: load story + episode ───
    const story = await getBrandStoryById(storyId, userId);
    if (!story) throw new Error(`V4 reassemble: story ${storyId} not found`);

    const episode = await getBrandStoryEpisodeById(episodeId, userId);
    if (!episode) throw new Error(`V4 reassemble: episode ${episodeId} not found`);

    const sceneGraph = episode.scene_description || {};
    if (!Array.isArray(sceneGraph.scenes)) throw new Error(`V4 reassemble: episode has no scene-graph`);

    // Mark episode as regenerating_beat (closest existing status — means
    // "some in-place mutation is happening on this episode"). We could add
    // a dedicated 'reassembling' status but that requires a DB migration
    // and this state is transient anyway.
    await updateBrandStoryEpisode(episodeId, userId, {
      status: 'regenerating_beat',
      error_message: null
    });

    // ─── Step 2: download every beat's existing video ───
    // Walk the scene-graph in canonical order, fetch each beat's buffer from
    // its generated_video_url. We also collect beat metadata for the
    // subtitle/SFX/ducking pipeline to consume.
    progress('loading_beats', `fetching ${sceneGraph.scenes.length} scene(s) of existing beats`);

    const beatVideoBuffers = [];
    const beatMetadata = [];

    for (const scene of sceneGraph.scenes) {
      for (const beat of (scene.beats || [])) {
        if (beat.type === 'SPEED_RAMP_TRANSITION') continue;
        if (!beat.generated_video_url) {
          logger.warn(`V4 reassemble: beat ${beat.beat_id} has no generated_video_url — skipping`);
          continue;
        }
        try {
          const cached = await axios.get(beat.generated_video_url, { responseType: 'arraybuffer', timeout: 60000 });
          beatVideoBuffers.push(Buffer.from(cached.data));
          beatMetadata.push({
            beat_id: beat.beat_id,
            model_used: beat.model_used,
            duration_seconds: beat.duration_seconds,
            actual_duration_sec: beat.actual_duration_sec || beat.duration_seconds
          });
        } catch (err) {
          logger.warn(`V4 reassemble: failed to fetch beat ${beat.beat_id} from ${beat.generated_video_url}: ${err.message}`);
        }
      }
    }

    if (beatVideoBuffers.length === 0) {
      throw new Error('V4 reassemble: no beat buffers downloaded — episode may have no successful beats');
    }

    progress('loading_beats', `loaded ${beatVideoBuffers.length} beat video(s)`);

    // ─── Step 3: music bed — reuse cached URL if present ───
    let musicBedBuffer = null;
    let musicBedUrl = episode.music_bed_url || null;
    if (musicBedUrl) {
      try {
        const cached = await axios.get(musicBedUrl, { responseType: 'arraybuffer', timeout: 60000 });
        musicBedBuffer = Buffer.from(cached.data);
        progress('music', `reusing cached music bed`);
      } catch (err) {
        logger.warn(`V4 reassemble: failed to fetch cached music bed: ${err.message} — regenerating`);
      }
    }
    const uploadBufferToStorage = (buffer, subfolder, filename, mimeType) =>
      this._uploadBufferToStorage(buffer, userId, subfolder, filename, mimeType);

    if (!musicBedBuffer && sceneGraph.music_bed_intent && musicService.isAvailable()) {
      const totalDuration = estimateEpisodeDuration(beatMetadata);
      progress('music', `regenerating music bed (${totalDuration.toFixed(0)}s)`);
      try {
        const musicResult = await musicService.generateMusicBed({
          musicBedIntent: sceneGraph.music_bed_intent,
          durationSec: totalDuration
        });
        musicBedBuffer = musicResult.audioBuffer;
        musicBedUrl = await uploadBufferToStorage(
          musicResult.audioBuffer,
          'audio/v4-music',
          `episode-${episodeId}-music-reassemble-${Date.now()}.mp3`,
          'audio/mpeg'
        );
      } catch (err) {
        logger.warn(`V4 reassemble: music gen failed (non-fatal): ${err.message}`);
      }
    }

    // ─── Step 4: resolve LUT + enrich metadata for subtitles/ducking ───
    progress('post_production', 'reassembling episode');
    await updateBrandStoryEpisode(episodeId, userId, {
      status: 'applying_lut',
      music_bed_url: musicBedUrl
    });

    const episodeLutId = resolveEpisodeLut(story, { ...episode, scene_description: sceneGraph });
    progress('post_production', `resolved LUT → ${episodeLutId}`);

    const enrichedBeatMetadata = [];
    let idx = 0;
    for (const scene of sceneGraph.scenes) {
      for (const beat of (scene.beats || [])) {
        if (beat.type === 'SPEED_RAMP_TRANSITION') continue;
        if (!beat.generated_video_url) continue;
        const base = beatMetadata[idx] || {};
        enrichedBeatMetadata.push({
          ...base,
          beat_id: beat.beat_id,
          dialogue: beat.dialogue || null,
          dialogues: beat.dialogues || null,
          exchanges: beat.exchanges || null,
          voiceover_text: beat.voiceover_text || null,
          ambient_sound: beat.ambient_sound || null
        });
        idx++;
      }
    }

    const episodeMeta = {
      series_title: story.storyline?.title || story.name || 'Untitled Series',
      episode_title: sceneGraph.title || `Episode ${episode.episode_number}`,
      cliffhanger: sceneGraph.cliffhanger || '',
      brand_kit: brandKit || null,
      cta_text: story.cta_text || story.storyline?.cta_text || null
    };

    const postProductionResult = await runPostProduction({
      beatVideoBuffers,
      beatMetadata: enrichedBeatMetadata,
      episodeLutId,
      musicBedBuffer,
      sceneGraph: sceneGraph.scenes,
      episodeMeta,
      burnSubtitles: true
    });
    const finalVideoBuffer = postProductionResult.finalBuffer;

    let subtitleUrl = episode.subtitle_url || null;
    if (postProductionResult.srtContent) {
      try {
        subtitleUrl = await uploadBufferToStorage(
          Buffer.from(postProductionResult.srtContent, 'utf-8'),
          'srt/v4',
          `episode-${episode.episode_number}-reassemble-${Date.now()}.srt`,
          'text/plain'
        );
      } catch (err) {
        logger.warn(`V4 reassemble: SRT upload failed (non-fatal): ${err.message}`);
      }
    }

    // ─── Step 5: upload fresh final video, mark ready ───
    progress('upload', 'uploading reassembled final episode video');
    const finalVideoUrl = await uploadBufferToStorage(
      finalVideoBuffer,
      'videos/v4-final',
      `episode-${episode.episode_number}-reassemble-${Date.now()}.mp4`,
      'video/mp4'
    );

    const completedEpisode = await updateBrandStoryEpisode(episodeId, userId, {
      final_video_url: finalVideoUrl,
      subtitle_url: subtitleUrl,
      status: 'ready',
      lut_id: episodeLutId
    });

    progress('complete', `Episode ${episode.episode_number} reassembled: ${finalVideoUrl}`);
    return completedEpisode;
  }

  /**
   * V4: Generate the scene-graph screenplay via Gemini using brandStoryPromptsV4.
   * Returns the parsed JSON scene-graph that the rest of the V4 pipeline consumes.
   *
   * @private
   */
  async _generateV4Screenplay({
    story,
    personas,
    previousEpisodes,
    brandKit,
    previousVisualStyle,
    previousEmotionalState,
    lastCliffhanger,
    directorsNotes,
    costCapUsd,
    hasBrandKitLut,
    episodeNumber
  }) {
    // V4 uses Vertex AI for Gemini (NOT AI Studio). Require Vertex creds
    // (GCP_PROJECT_ID + GOOGLE_APPLICATION_CREDENTIALS_JSON or ADC) at call time.
    if (!isVertexGeminiConfigured()) {
      throw new Error('V4: Vertex Gemini not configured — set GCP_PROJECT_ID and GOOGLE_APPLICATION_CREDENTIALS_JSON (or use ADC)');
    }

    const systemPrompt = getEpisodeSystemPromptV4(story.storyline, previousEpisodes, personas, {
      subject: story.subject,
      storyFocus: story.story_focus || 'product',
      brandKit,
      previousVisualStyle,
      previousEmotionalState,
      directorsNotes,
      costCapUsd,
      hasBrandKitLut
    });

    const userPrompt = getEpisodeUserPromptV4(story.storyline, lastCliffhanger, episodeNumber, {
      hasBrandKitLut
    });

    const parsed = await callVertexGeminiJson({
      systemPrompt,
      userPrompt,
      config: {
        temperature: 0.85,
        maxOutputTokens: 8192
      },
      timeoutMs: 90000
    });

    if (!Array.isArray(parsed.scenes) || parsed.scenes.length === 0) {
      throw new Error('V4: Gemini returned no scenes');
    }

    for (const scene of parsed.scenes) {
      if (!Array.isArray(scene.beats)) scene.beats = [];
      for (const beat of scene.beats) {
        if (!beat.status) beat.status = 'pending';
        if (beat.generated_video_url == null) beat.generated_video_url = null;
        if (beat.endframe_url == null) beat.endframe_url = null;
        if (beat.model_used == null) beat.model_used = null;
        if (beat.cost_usd == null) beat.cost_usd = null;
      }
    }

    return parsed;
  }

  /**
   * V4: Lightweight in-process brand safety filter.
   * Phase 1a: simple keyword block list as a safety rail.
   * Phase 2 upgrade: Gemini semantic safety check.
   *
   * @private
   */
  _brandSafetyFilter(sceneGraph) {
    const blockedPatterns = [
      /\bf[u\*]ck/i,
      /\bsh[i\*]t/i,
      /\bb[i\*]tch/i,
      /\bn[i\*]gg/i,
      /\bc[u\*]nt/i
    ];

    let flagged = 0;
    for (const scene of sceneGraph.scenes || []) {
      for (const beat of scene.beats || []) {
        const lines = [];
        if (beat.dialogue) lines.push(beat.dialogue);
        if (Array.isArray(beat.dialogues)) lines.push(...beat.dialogues);
        if (Array.isArray(beat.exchanges)) {
          for (const ex of beat.exchanges) if (ex.dialogue) lines.push(ex.dialogue);
        }
        if (beat.voiceover_text) lines.push(beat.voiceover_text);

        for (const line of lines) {
          for (const pattern of blockedPatterns) {
            if (pattern.test(line)) {
              logger.warn(`V4 brand safety: flagged dialogue in beat ${beat.beat_id}: "${line.slice(0, 60)}..."`);
              flagged++;
              break;
            }
          }
        }
      }
    }

    if (flagged > 0) {
      logger.warn(`V4 brand safety: ${flagged} dialogue line(s) flagged (warning only — Phase 2 will replace with semantic Gemini check)`);
    }
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
      // ── RESUMABLE PIPELINE ──
      // On failure, generated artifacts are stashed on story.pending_resume and the
      // failed episode is deleted. Next "Generate" creates a fresh episode but reuses
      // any saved content (screenplay, narration, storyboard, raw video).

      // Check if we have resume data from a previous failed attempt
      const storyForResume = await getBrandStoryById(storyId, userId);
      const resume = storyForResume?.pending_resume || null;
      if (resume) {
        logger.info(`[CinematicV2] Found resume data from failed attempt (error: ${resume.error?.slice(0, 60)})`);
      }

      // Step 1: Gemini writes cinematic screenplay — reuse from resume if available
      let episode;
      if (resume?.scene_description?.shots?.length > 0) {
        progress('writing_script', 'Resuming from previous screenplay...');
        // Create a new episode record with the saved screenplay
        const episodeData = {
          episode_number: (await getBrandStoryEpisodes(storyId, userId)).length + 1,
          scene_description: resume.scene_description,
          status: 'generating_narration',
          pipeline_version: 'v2'
        };
        episode = await createBrandStoryEpisode(storyId, userId, episodeData);
        episode.scene_description = resume.scene_description;
      } else {
        progress('writing_script', 'Writing cinematic screenplay...');
        episode = await this._generateCinematicEpisode(storyId, userId);
      }

      const scene = episode.scene_description || {};
      const shots = scene.shots || [];
      progress('writing_script', `Episode ${episode.episode_number}: ${shots.length} shots, style: ${(scene.visual_style_prefix || '').slice(0, 60)}...`);

      // Step 2: TTS narration — reuse from resume if available
      let narrationResult;
      if (resume?.narration_audio_url) {
        logger.info(`[CinematicV2] Reusing saved narration: ${resume.narration_audio_url}`);
        const narResp = await axios.get(resume.narration_audio_url, { responseType: 'arraybuffer', timeout: 30000 });
        narrationResult = { audioBuffer: Buffer.from(narResp.data), publicUrl: resume.narration_audio_url };
        await updateBrandStoryEpisode(episode.id, userId, { narration_audio_url: resume.narration_audio_url });
      } else {
        progress('generating_narration', 'Recording voice-over narration...');
        narrationResult = await this._generateFullNarration(episode, storyId, userId);
        await updateBrandStoryEpisode(episode.id, userId, { narration_audio_url: narrationResult.publicUrl });
      }

      // Step 3: Storyboard panels — reuse from resume if available
      let storyboardPanels;
      if (Array.isArray(resume?.storyboard_panels) && resume.storyboard_panels.length >= shots.length) {
        logger.info(`[CinematicV2] Reusing saved storyboard: ${resume.storyboard_panels.length} panels`);
        storyboardPanels = resume.storyboard_panels;
      } else {
        progress('generating_storyboard', 'Creating storyboard panels...');
        storyboardPanels = await this._generateEpisodeStoryboard(episode, storyId, userId);
      }

      // Save storyboard + narration + style to episode
      await updateBrandStoryEpisode(episode.id, userId, {
        storyboard_panels: storyboardPanels,
        narration_audio_url: narrationResult.publicUrl,
        visual_style_prefix: scene.visual_style_prefix || '',
        pipeline_version: 'v2',
        status: 'generating_video'
      });

      // Step 4: Video generation — reuse raw video from resume if available
      let videoResult;
      if (resume?.scene_video_url) {
        logger.info(`[CinematicV2] Reusing saved raw video: ${resume.scene_video_url}`);
        const vidResp = await axios.get(resume.scene_video_url, { responseType: 'arraybuffer', timeout: 120000 });
        videoResult = { videoBuffer: Buffer.from(vidResp.data), duration: 15, model: 'reused' };
      } else {
        // TODO: Re-enable Kling primary path after Veo testing
        progress('generating_video', 'Generating cinematic video (Veo 3.1 Standard)...');
        const story = await getBrandStoryById(storyId, userId);
        // Kling disabled for Veo testing — go straight to Veo 3.1 Standard
        videoResult = await this._runVeoFallbackPipeline(shots, scene, storyboardPanels, story, episode, userId);
        /* KLING PRIMARY PATH (re-enable after testing):
        try {
          videoResult = await this._generateKlingMultiShot(shots, scene, storyboardPanels, story, userId);
        } catch (klingErr) {
          logger.warn(`Kling multi-shot failed, falling back to Veo 3.1 Standard: ${klingErr.message}`);
          progress('generating_video', 'Kling unavailable — using Veo 3.1 Standard fallback...');
          videoResult = await this._runVeoFallbackPipeline(shots, scene, storyboardPanels, story, episode, userId);
        }
        */
      }

      // Upload raw video to Supabase
      const rawVideoUrl = resume?.scene_video_url || await this._uploadBufferToStorage(
        videoResult.videoBuffer, userId, 'videos', `ep${episode.episode_number}-raw.mp4`, 'video/mp4'
      );

      await updateBrandStoryEpisode(episode.id, userId, {
        scene_video_url: rawVideoUrl,
        status: 'post_production'
      });

      // Step 4.5: Align narration duration to actual video duration.
      // When Kling fails and Veo fallback runs, the video may be significantly
      // shorter/longer than the TTS narration (Kling does 3-15s shots, Veo does 4-8s).
      // Use atempo to stretch/compress narration so it fills the video naturally.
      let alignedNarrationBuffer = narrationResult.audioBuffer;
      if (alignedNarrationBuffer) {
        try {
          alignedNarrationBuffer = await this._alignNarrationToVideo(
            videoResult.videoBuffer, narrationResult.audioBuffer, episode
          );
        } catch (alignErr) {
          logger.warn(`Narration alignment failed (non-fatal): ${alignErr.message}`);
        }
      }

      // Step 5: Post-production (with title card + end card)
      progress('post_production', 'Mixing narration over cinematic audio...');
      const storyForPostProd = await getBrandStoryById(storyId, userId);
      const finalVideoUrl = await this._postProduction(
        videoResult.videoBuffer, alignedNarrationBuffer, episode, userId, storyForPostProd
      );

      // Clear resume data on success
      await updateBrandStory(storyId, userId, { pending_resume: null });

      // Finalize
      await updateBrandStoryEpisode(episode.id, userId, {
        final_video_url: finalVideoUrl,
        status: 'ready'
      });

      // Update the season bible with a running "story so far" appendix.
      // This prevents late-episode amnesia by keeping a compressed record of
      // key events, unresolved threads, and character state changes.
      try {
        await this._updateStorySoFar(storyId, userId, episode);
      } catch (soFarErr) {
        logger.warn(`story_so_far update failed (non-fatal): ${soFarErr.message}`);
      }

      progress('complete', `Episode ${episode.episode_number} ready!`);
      return getBrandStoryEpisodeById(episode.id, userId);

    } catch (error) {
      logger.error(`Cinematic v2 pipeline failed for story ${storyId}: ${error.message}`);
      // Save generated artifacts to the STORY record for resume, then DELETE the failed episode.
      // Next "Generate" click will create a fresh episode but reuse saved content.
      try {
        const allEps = await getBrandStoryEpisodes(storyId, userId);
        const failedEp = allEps[allEps.length - 1];
        if (failedEp && failedEp.status !== 'ready') {
          // Stash whatever was generated so far on the story for next attempt
          const resume = {
            scene_description: failedEp.scene_description || null,
            narration_audio_url: failedEp.narration_audio_url || null,
            storyboard_panels: failedEp.storyboard_panels || null,
            visual_style_prefix: failedEp.visual_style_prefix || null,
            scene_video_url: failedEp.scene_video_url || null,
            failed_at: new Date().toISOString(),
            error: error.message
          };
          await updateBrandStory(storyId, userId, { pending_resume: resume });
          // Delete the failed episode — user sees a clean slate
          const { supabaseAdmin } = await import('./supabase.js');
          await supabaseAdmin.from('brand_story_episodes').delete().eq('id', failedEp.id).eq('user_id', userId);
          // Update total_episodes count
          const remaining = await getBrandStoryEpisodes(storyId, userId);
          await updateBrandStory(storyId, userId, { total_episodes: remaining.length });
          logger.info(`[CinematicV2] Failed episode ${failedEp.episode_number} deleted. Resume data saved on story.`);
        }
      } catch (cleanupErr) {
        logger.error(`[CinematicV2] Cleanup after failure failed: ${cleanupErr.message}`);
      }
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

    // Extract visual style and emotional state from the most recent completed episode
    const lastCompletedEp = previousEpisodes[previousEpisodes.length - 1];
    const previousVisualStyle = lastCompletedEp?.scene_description?.visual_style_prefix || '';
    const previousEmotionalState = lastCompletedEp?.scene_description?.emotional_state || '';

    const systemPrompt = getEpisodeSystemPromptV2(story.storyline, prevScenes, storyPersonas, {
      subject: story.subject,
      storyFocus: story.story_focus || 'product',
      brandKit,
      previousVisualStyle,
      previousEmotionalState,
      directorsNotes: story.subject?.directors_notes || ''
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

    let sceneDescription = this._parseGeminiJson(raw);

    // Gemini sometimes wraps the episode in an array. Unwrap it.
    if (Array.isArray(sceneDescription)) {
      logger.warn(`Gemini returned array instead of object — unwrapping first element`);
      sceneDescription = sceneDescription[0] || {};
    }
    // Sometimes Gemini nests it under episode/response/data keys
    if (!sceneDescription.shots && sceneDescription.episode?.shots) {
      sceneDescription = sceneDescription.episode;
    }

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
  // Video provider max duration per shot — used to calculate target narration length
  static get VIDEO_DURATION_CONFIG() {
    return {
      kling: { maxPerShot: 15, numShots: 3 },   // Kling Omni 3: 15s × 3 = 45s
      veo: { maxPerShot: 8, numShots: 3 }        // Veo 3.1 Standard I2V: 8s × 3 = 24s
    };
  }

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

    // Calculate target narration duration based on video provider
    // Primary = Kling, fallback = Veo. Target the PRIMARY provider's length.
    const isKlingDisabled = false; // TODO: flip when Kling is re-enabled
    const provider = isKlingDisabled ? 'veo' : 'kling';
    const config = BrandStoryService.VIDEO_DURATION_CONFIG[provider];
    const targetDurationSec = config.maxPerShot * config.numShots;

    // Estimate natural speech duration (avg ~2.5 words/sec at speed=1.0)
    const wordCount = fullScript.split(/\s+/).length;
    const naturalDurationSec = wordCount / 2.5;

    // Calculate TTS speed to match target video length
    // speed < 1.0 = slower (stretches), speed > 1.0 = faster (compresses)
    // Clamp between 0.5 (very slow) and 2.0 (very fast)
    let ttsSpeed = naturalDurationSec / targetDurationSec;
    ttsSpeed = Math.min(Math.max(ttsSpeed, 0.5), 2.0);

    logger.info(`Narration target: ${targetDurationSec}s (${provider}: ${config.maxPerShot}s × ${config.numShots} shots). Script: ${wordCount} words, natural ~${naturalDurationSec.toFixed(0)}s, TTS speed=${ttsSpeed.toFixed(2)}`);

    // Determine voice from persona config
    const story = await getBrandStoryById(storyId, userId);
    const personas = story?.persona_config?.personas || [];
    const voiceId = personas[0]?.elevenlabs_voice_id || undefined;

    const ttsResult = await ttsService.synthesize({
      text: fullScript,
      options: {
        voiceId,
        language: personas[0]?.language || 'en',
        speed: ttsSpeed
      }
    });

    // Upload narration to Supabase
    const publicUrl = await this._uploadBufferToStorage(
      ttsResult.audioBuffer, userId, 'audio', `ep${episode.episode_number}-narration.mp3`, 'audio/mpeg'
    );

    logger.info(`Narration generated: ~${ttsResult.durationEstimate}s (target: ${targetDurationSec}s), uploaded to ${publicUrl}`);
    return { audioBuffer: ttsResult.audioBuffer, publicUrl };
  }

  /**
   * Generate episode storyboard panels via Replicate Seedream 5 Lite.
   * Produces one panel per shot (3 total) with style coherence via
   * shared visual_style_prefix, up to 14 character/subject references,
   * seed proximity, and sequential generation for inter-panel coherence.
   * Uses 3K resolution (3072px) for maximum detail — these panels serve
   * as first/last frames for Kling/Veo video generation.
   */
  async _generateEpisodeStoryboard(episode, storyId, userId) {
    const scene = episode.scene_description || {};
    const shots = scene.shots || [];
    const stylePrefix = scene.visual_style_prefix || '';
    const story = await getBrandStoryById(storyId, userId);

    // Collect reference images for Seedream 5 Lite image_input — ordered by story focus.
    // Seedream supports up to 14 refs (vs Flux's 8) for stronger identity lock.
    // Person focus: persona refs first (character is the star of every frame)
    // Product/landscape focus: subject refs first (product/place dominates the storyboard)
    const personaRefs = this._collectPersonaReferenceImages(story);
    const subjectRefs = this._collectSubjectReferenceImages(story);
    const focus = story.story_focus || 'product';
    const inputImages = focus === 'person'
      ? [...personaRefs, ...subjectRefs].slice(0, 14)
      : [...subjectRefs, ...personaRefs].slice(0, 14);

    // Initialize Replicate client
    const replicateToken = process.env.REPLICATE_API_TOKEN;
    if (!replicateToken) throw new Error('REPLICATE_API_TOKEN not set — cannot generate storyboard');
    const replicate = new Replicate({ auth: replicateToken });

    // Use deterministic seed for cross-episode visual consistency.
    // Same story always uses the same seed family, with episode/shot offsets.
    const baseSeed = this._getStoryboardSeed(story, episode.episode_number, 0);
    const panels = [];

    // Generate first panel with sequential_image_generation enabled.
    // This primes Seedream's internal coherence model so subsequent panels
    // (sharing the same seed family + reference images) maintain visual continuity.
    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const storyboardPrompt = shot.storyboard_prompt || shot.visual_direction || '';
      const fullPrompt = stylePrefix
        ? `${stylePrefix}. ${storyboardPrompt}`
        : storyboardPrompt;

      logger.info(`Generating storyboard panel ${i + 1}/${shots.length}: ${fullPrompt.slice(0, 100)}...`);

      const output = await replicate.run('bytedance/seedream-5-lite', {
        input: {
          prompt: fullPrompt,
          ...(inputImages.length > 0 ? { image_input: inputImages } : {}),
          aspect_ratio: '9:16',
          size: '3K',
          sequential_image_generation: 'auto',
          seed: baseSeed + i
        }
      });

      // Seedream 5 Lite returns a single FileOutput or URL
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
      const filename = `ep${episode.episode_number}-panel${i + 1}-${Date.now()}.png`;
      const imageUrl = await this._uploadBufferToStorage(
        imageBuffer, userId, 'storyboard', filename, 'image/png'
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
    // More refs = stronger identity lock. Order by focus priority:
    //   1. Persona/subject source photos (identity anchors)
    //   2. Storyboard panels (composition + identity reinforcement — panels were
    //      generated WITH the same persona/subject refs, so they carry baked-in
    //      identity data while also guiding Kling on scene composition)
    const personaRefs = this._collectPersonaReferenceImages(story);
    const subjectRefs = this._collectSubjectReferenceImages(story);
    const focus = story.story_focus || 'product';
    const identityRefs = focus === 'person'
      ? [...personaRefs, ...subjectRefs]
      : [...subjectRefs, ...personaRefs];
    const uniqueIdentityRefs = [...new Set(identityRefs)];

    // Fill remaining Kling ref slots (up to 7) with storyboard panels
    const panelUrls = storyboardPanels
      .map(p => p.image_url)
      .filter(url => url && !uniqueIdentityRefs.includes(url));
    const refs = [...uniqueIdentityRefs, ...panelUrls].slice(0, 7);

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
      return { prompt, duration: 15 }; // Max out Kling shot duration (15s per shot)
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
  /**
   * Veo 3.1 Standard fallback pipeline — used when Kling multi-shot fails.
   * Uses storyboard panels as first+last frame anchors for perfect shot-to-shot continuity.
   * No fragile frame extraction — panels drive both ends of every shot.
   *
   * Flow: Panel1→Shot1→Panel2, Panel2→Shot2→Panel3, Panel3→Shot3→(open)
   */
  async _runVeoFallbackPipeline(shots, scene, storyboardPanels, story, episode, userId) {
    const { VideoGenerationService } = await import('./VideoGenerationService.js');

    const stylePrefix = scene.visual_style_prefix || '';
    const generatedShots = [];

    // Check for previously generated shots from resume data (per-shot resume)
    const storyForResume = await getBrandStoryById(story.id, userId);
    const resumeShots = storyForResume?.pending_resume?.generated_shots || [];

    for (let i = 0; i < shots.length; i++) {
      // Per-shot resume: if this shot was already generated, reuse it
      if (resumeShots[i]?.video_url) {
        logger.info(`Veo shot ${i + 1}/${shots.length}: reusing saved shot from resume (${resumeShots[i].video_url.slice(-40)})`);
        const vidResp = await axios.get(resumeShots[i].video_url, { responseType: 'arraybuffer', timeout: 60000 });
        generatedShots.push({
          index: i,
          videoBuffer: Buffer.from(vidResp.data),
          duration: resumeShots[i].duration || 8
        });
        continue;
      }

      const shot = shots[i];

      // Build rich prompt (Veo allows ~1400 chars).
      // Include storyboard_prompt — it describes the KEY FRAME composition (characters,
      // poses, lighting, framing, colors) in 100+ words. Even when first/last frame images
      // are provided, this text gives Veo richer guidance about WHAT to animate.
      const prompt = [
        stylePrefix,
        shot.storyboard_prompt || '',
        shot.visual_direction || '',
        shot.camera_notes ? `Camera movement: ${shot.camera_notes}` : '',
        shot.ambient_sound ? `Ambient sound: ${shot.ambient_sound}` : '',
        shot.mood ? `Mood: ${shot.mood}` : '',
        'Photorealistic, cinematic lighting, 9:16 vertical short film.'
      ].filter(Boolean).join('. ').slice(0, 1400);

      // Enriched prompts for fallback tiers — when image anchors are stripped,
      // maximize the textual composition guidance to compensate.
      const promptWithEndFrame = [
        stylePrefix,
        shot.storyboard_prompt || '',
        shot.visual_direction || '',
        shot.end_frame_description ? `The shot ends on: ${shot.end_frame_description}` : '',
        shot.camera_notes ? `Camera movement: ${shot.camera_notes}` : '',
        shot.ambient_sound ? `Ambient sound: ${shot.ambient_sound}` : '',
        shot.mood ? `Mood: ${shot.mood}` : '',
        'Photorealistic, cinematic lighting, 9:16 vertical short film.'
      ].filter(Boolean).join('. ').slice(0, 1400);

      const firstImageUrl = storyboardPanels[i]?.image_url;
      const lastImageUrl = (i < storyboardPanels.length - 1) ? storyboardPanels[i + 1]?.image_url : null;
      const cameraControl = VideoGenerationService.mapCameraControl(shot.camera_notes);
      const duration = 8;

      logger.info(`Veo fallback shot ${i + 1}/${shots.length}: first_frame=${firstImageUrl ? 'yes' : 'no'}, last_frame=${lastImageUrl ? 'yes' : 'no'}, camera=${cameraControl || 'auto'}, ${duration}s`);

      let result;
      try {
        result = await videoGenerationService.generateWithFirstLastFrame({
          firstImageUrl,
          lastImageUrl,
          prompt,
          cameraControl,
          options: { durationSeconds: duration, aspectRatio: '9:16' }
        });
      } catch (shotErr) {
        if (shotErr.message?.includes('usage guidelines') || shotErr.message?.includes('content filter') || shotErr.isContentFilter) {
          // Tier 2: drop last frame, keep first. Use enriched prompt with end_frame_description
          // since we lost the visual end target.
          logger.warn(`Veo shot ${i + 1} content-filtered — retrying without lastFrame (enriched prompt)...`);
          try {
            result = await videoGenerationService.generateWithFirstLastFrame({
              firstImageUrl,
              lastImageUrl: null,
              prompt: promptWithEndFrame,
              cameraControl,
              options: { durationSeconds: duration, aspectRatio: '9:16' }
            });
          } catch (retryErr) {
            if (retryErr.message?.includes('usage guidelines') || retryErr.isContentFilter) {
              // Tier 3: pure text-only. Use maximum enriched prompt — the storyboard_prompt
              // text is now the ONLY composition guidance Veo has.
              logger.warn(`Veo shot ${i + 1} firstFrame also filtered — text-only with full storyboard prompt...`);
              result = await videoGenerationService.generateWithFirstLastFrame({
                firstImageUrl: null,
                lastImageUrl: null,
                prompt: promptWithEndFrame,
                cameraControl: null,
                options: { durationSeconds: duration, aspectRatio: '9:16' }
              });
            } else {
              throw retryErr;
            }
          }
        } else {
          throw shotErr;
        }
      }

      // Upload this shot immediately so it's saved for per-shot resume
      const shotUrl = await this._uploadBufferToStorage(
        result.videoBuffer, userId, 'videos',
        `ep${episode.episode_number}-veo-shot${i + 1}-${Date.now()}.mp4`, 'video/mp4'
      );

      // Save per-shot progress to story.pending_resume.generated_shots
      const currentResume = (await getBrandStoryById(story.id, userId))?.pending_resume || {};
      const savedShots = currentResume.generated_shots || [];
      savedShots[i] = { video_url: shotUrl, duration: result.duration };
      await updateBrandStory(story.id, userId, {
        pending_resume: { ...currentResume, generated_shots: savedShots }
      });

      generatedShots.push({
        index: i,
        videoBuffer: result.videoBuffer,
        duration: result.duration
      });

      logger.info(`Veo shot ${i + 1} saved for resume: ${shotUrl}`);
    }

    // Assemble with xfade transitions (reuse existing method)
    const transitions = shots.map(s => s.transition_to_next || 'dissolve');
    const assembledBuffer = await this._assembleWithTransitions(generatedShots, transitions, episode, userId);

    return {
      videoBuffer: assembledBuffer,
      duration: generatedShots.reduce((sum, s) => sum + s.duration, 0),
      model: 'veo-3.1-standard-frame-chained'
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
   * Post-production: mix TTS narration over the cinematic video's ambient audio,
   * add opening title card and end card with cliffhanger text.
   *
   * @param {Buffer} videoBuffer - Raw cinematic video
   * @param {Buffer|null} narrationBuffer - TTS narration audio
   * @param {Object} episode - Episode record with scene_description
   * @param {string} userId
   * @param {Object} [story] - Story record (for title card text). Optional for backward compat.
   */
  async _postProduction(videoBuffer, narrationBuffer, episode, userId, story = null) {
    const tmpDir = os.tmpdir();
    const epNum = episode.episode_number;
    const videoPath = path.join(tmpDir, `postprod-video-${epNum}.mp4`);
    const mixedPath = path.join(tmpDir, `postprod-mixed-${epNum}.mp4`);
    const outputPath = path.join(tmpDir, `postprod-final-${epNum}.mp4`);
    await fs.writeFile(videoPath, videoBuffer);

    if (!narrationBuffer) {
      // No narration — just add title/end cards to the raw video
      const withCards = await this._addTitleAndEndCards(videoPath, outputPath, episode, story);
      const finalBuffer = await fs.readFile(withCards);
      const publicUrl = await this._uploadBufferToStorage(
        finalBuffer, userId, 'videos', `ep${epNum}-final.mp4`, 'video/mp4'
      );
      await fs.unlink(videoPath).catch(() => {});
      await fs.unlink(withCards).catch(() => {});
      return publicUrl;
    }

    const narrationPath = path.join(tmpDir, `postprod-narration-${epNum}.mp3`);
    await fs.writeFile(narrationPath, narrationBuffer);

    try {
      // Build narration volume expression with ducking at shot transitions.
      // At each visual cut point, the narration dips briefly (J/L cut feel).
      // Ambient audio rises slightly at those points for a "breathing" effect.
      const narrationVolExpr = this._buildDuckingVolumeExpr(episode, 0.85);
      const ambientVolExpr = this._buildAmbientSwellExpr(episode, 0.12);

      await execFileAsync('ffmpeg', [
        '-y',
        '-i', videoPath,
        '-i', narrationPath,
        '-filter_complex',
        `[0:a]volume='${ambientVolExpr}':eval=frame[ambient];[1:a]volume='${narrationVolExpr}':eval=frame,apad[narr];[ambient][narr]amix=inputs=2:duration=first[aout]`,
        '-map', '0:v',
        '-map', '[aout]',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
        '-c:a', 'aac', '-b:a', '256k', '-ar', '48000',
        '-movflags', '+faststart',
        mixedPath
      ]);
    } catch (mixErr) {
      logger.warn(`Audio mix with ducking failed, trying flat mix: ${mixErr.message}`);
      try {
        // Fallback: flat mix without ducking expressions
        await execFileAsync('ffmpeg', [
          '-y',
          '-i', videoPath,
          '-i', narrationPath,
          '-filter_complex',
          '[0:a]volume=0.12[ambient];[1:a]volume=0.85,apad[narr];[ambient][narr]amix=inputs=2:duration=first[aout]',
          '-map', '0:v',
          '-map', '[aout]',
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
          '-c:a', 'aac', '-b:a', '256k', '-ar', '48000',
          '-movflags', '+faststart',
          mixedPath
        ]);
      } catch (flatMixErr) {
        logger.warn(`Flat audio mix also failed, using narration only: ${flatMixErr.message}`);
        await execFileAsync('ffmpeg', [
          '-y',
          '-i', videoPath,
          '-i', narrationPath,
          '-map', '0:v', '-map', '1:a',
          '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k',
          '-shortest', '-movflags', '+faststart',
          mixedPath
        ]);
      }
    }

    // Add title card + end card overlays
    const cardSource = await this._addTitleAndEndCards(mixedPath, outputPath, episode, story);

    // Generate and burn subtitles
    const subtitledPath = path.join(tmpDir, `postprod-subtitled-${epNum}.mp4`);
    let finalSource = cardSource;
    try {
      const { srtPath, srtUrl } = await this._generateSubtitles(cardSource, episode, userId);
      if (srtPath) {
        finalSource = await this._burnSubtitles(cardSource, srtPath, subtitledPath);
        // Store SRT URL on the episode for user download
        await updateBrandStoryEpisode(episode.id, userId, { subtitle_url: srtUrl });
        await fs.unlink(srtPath).catch(() => {});
      }
    } catch (subErr) {
      logger.warn(`Subtitle generation failed (non-fatal): ${subErr.message}`);
    }

    const finalBuffer = await fs.readFile(finalSource);
    const publicUrl = await this._uploadBufferToStorage(
      finalBuffer, userId, 'videos', `ep${epNum}-final.mp4`, 'video/mp4'
    );

    // Cleanup
    await Promise.allSettled([
      fs.unlink(videoPath),
      fs.unlink(narrationPath),
      fs.unlink(mixedPath),
      fs.unlink(outputPath),
      fs.unlink(subtitledPath)
    ]);

    logger.info(`Post-production complete: ${publicUrl}`);
    return publicUrl;
  }

  /**
   * Add title card (first 2.8s) and end card (last 2.5s) text overlays to a video.
   * Title card: series title + "Episode N: Title" centered on screen.
   * End card: cliffhanger text + "Next episode..." over a dark scrim at bottom.
   *
   * Uses sharp to render text as transparent PNG overlays, then ffmpeg overlay filter
   * to composite them. This avoids drawtext (requires --enable-libfreetype) and
   * subtitles (requires --enable-libass) — neither is available in this ffmpeg build.
   *
   * @returns {string} Path to the output file with overlays applied
   */
  async _addTitleAndEndCards(inputPath, outputPath, episode, story) {
    const scene = episode.scene_description || {};
    const seriesTitle = story?.storyline?.title || story?.name || '';
    const epTitle = `Episode ${episode.episode_number}: ${scene.title || 'Untitled'}`;
    const cliffhanger = scene.cliffhanger || '';

    if (!seriesTitle && !cliffhanger) {
      return inputPath;
    }

    const tmpDir = os.tmpdir();
    const tmpFiles = [];

    try {
      const sharp = (await import('sharp')).default;

      // Get video dimensions and duration
      const probeResult = await execFileAsync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-show_entries', 'stream=width,height',
        '-of', 'json', inputPath
      ]);
      const probeJson = JSON.parse(probeResult.stdout);
      const duration = parseFloat(probeJson.format?.duration) || 15;
      const videoStream = (probeJson.streams || []).find(s => s.width);
      const W = videoStream?.width || 1080;
      const H = videoStream?.height || 1920;
      const endCardStart = Math.max(duration - 2.5, duration * 0.7);

      // Helper: render text as transparent PNG via sharp SVG
      const escXml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

      const renderTextOverlay = async (texts, bgColor = null) => {
        // texts: [{ text, fontSize, color, y }]
        const svgLines = texts.map(t =>
          `<text x="50%" y="${t.y}" font-family="Arial, Helvetica, sans-serif" font-size="${t.fontSize}" fill="${t.color}" text-anchor="middle" dominant-baseline="middle">${escXml(t.text)}</text>`
        ).join('\n');

        const bgRect = bgColor
          ? `<rect x="0" y="0" width="${W}" height="${H}" fill="${bgColor}"/>`
          : '';

        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
          ${bgRect}
          ${svgLines}
        </svg>`;

        return sharp(Buffer.from(svg)).png().toBuffer();
      };

      // Generate title card overlay (centered text on transparent bg)
      let titleOverlayPath = null;
      if (seriesTitle) {
        const titlePng = await renderTextOverlay([
          { text: seriesTitle, fontSize: 42, color: 'white', y: Math.round(H / 2) - 40 },
          { text: epTitle, fontSize: 24, color: 'rgba(255,255,255,0.85)', y: Math.round(H / 2) + 20 }
        ]);
        titleOverlayPath = path.join(tmpDir, `title-overlay-${episode.episode_number}.png`);
        await fs.writeFile(titleOverlayPath, titlePng);
        tmpFiles.push(titleOverlayPath);
      }

      // Generate end card overlay (dark scrim at bottom + text)
      let endOverlayPath = null;
      if (cliffhanger) {
        const cliffText = cliffhanger.length > 70 ? cliffhanger.slice(0, 67) + '...' : cliffhanger;
        const endPng = await renderTextOverlay([
          { text: cliffText, fontSize: 22, color: 'white', y: Math.round(H * 0.82) },
          { text: 'Next episode...', fontSize: 18, color: 'rgba(255,255,255,0.7)', y: Math.round(H * 0.90) }
        ], 'rgba(0,0,0,0.55)');
        endOverlayPath = path.join(tmpDir, `end-overlay-${episode.episode_number}.png`);
        await fs.writeFile(endOverlayPath, endPng);
        tmpFiles.push(endOverlayPath);
      }

      // Build ffmpeg filter_complex using overlay filter (always available, no libfreetype needed)
      const inputs = ['-i', inputPath];
      const filterParts = [];
      let currentLabel = '[0:v]';
      let inputIdx = 1;

      if (titleOverlayPath) {
        inputs.push('-loop', '1', '-t', '3', '-i', titleOverlayPath);
        // Fade in 0.3-0.8s, hold, fade out 2.3-2.8s
        filterParts.push(
          `[${inputIdx}:v]format=rgba,fade=in:st=0.3:d=0.5:alpha=1,fade=out:st=2.3:d=0.5:alpha=1[title]`
        );
        filterParts.push(
          `${currentLabel}[title]overlay=0:0:enable='between(t,0.3,2.8)'[v${inputIdx}]`
        );
        currentLabel = `[v${inputIdx}]`;
        inputIdx++;
      }

      if (endOverlayPath) {
        inputs.push('-loop', '1', '-t', '3', '-i', endOverlayPath);
        filterParts.push(
          `[${inputIdx}:v]format=rgba,fade=in:st=0:d=0.5:alpha=1[endcard]`
        );
        filterParts.push(
          `${currentLabel}[endcard]overlay=0:0:enable='gte(t,${endCardStart.toFixed(2)})'[vfinal]`
        );
        currentLabel = '[vfinal]';
        inputIdx++;
      }

      if (filterParts.length === 0) return inputPath;

      const filterComplex = filterParts.join(';');

      await execFileAsync('ffmpeg', [
        '-y',
        ...inputs,
        '-filter_complex', filterComplex,
        '-map', currentLabel,
        '-map', '0:a',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        '-shortest',
        outputPath
      ], { timeout: 120000 });

      return outputPath;
    } catch (cardErr) {
      logger.warn(`Title/end card overlay failed (non-fatal): ${cardErr.message}`);
      return inputPath;
    } finally {
      await Promise.allSettled(tmpFiles.map(f => fs.unlink(f)));
    }
  }

  // ═══════════════════════════════════════════════════
  // SUBTITLE / CAPTION GENERATION
  // ═══════════════════════════════════════════════════

  /**
   * Generate an SRT subtitle file from the episode's dialogue and burn it into the video.
   * Short-form platforms heavily favor captioned content — this increases engagement.
   *
   * Timing strategy: distribute narration lines proportionally across the episode duration,
   * using shot durations as guides. Each line is split into segments of ~8 words for readability.
   *
   * @param {string} videoPath - Path to the video file (for duration probing)
   * @param {Object} episode - Episode record with scene_description.shots
   * @param {string} userId
   * @returns {Promise<{srtPath: string, srtUrl: string}>} Path to local SRT and public URL
   */
  async _generateSubtitles(videoPath, episode, userId) {
    const scene = episode.scene_description || {};
    const shots = scene.shots || [];

    // Collect narration text with timing info from shots
    const dialogueScript = scene.dialogue_script || '';
    if (!dialogueScript || dialogueScript.trim().length === 0) {
      return { srtPath: null, srtUrl: null };
    }

    // Get actual video duration
    let videoDuration = 15;
    try {
      const probeResult = await execFileAsync('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', videoPath
      ]);
      videoDuration = parseFloat(probeResult.stdout) || 15;
    } catch (e) {
      // Use sum of shot durations as fallback
      videoDuration = shots.reduce((sum, s) => sum + (s.duration_seconds || 5), 0) || 15;
    }

    // Split dialogue into word chunks (max ~8 words per subtitle line for readability)
    const words = dialogueScript.trim().split(/\s+/);
    const WORDS_PER_LINE = 7;
    const segments = [];
    for (let i = 0; i < words.length; i += WORDS_PER_LINE) {
      segments.push(words.slice(i, i + WORDS_PER_LINE).join(' '));
    }

    if (segments.length === 0) return { srtPath: null, srtUrl: null };

    // Distribute segments evenly across the video duration (leaving 0.5s buffer at start/end)
    const startOffset = 0.5;
    const endBuffer = 0.5;
    const totalTextDuration = videoDuration - startOffset - endBuffer;
    const segDuration = totalTextDuration / segments.length;

    // Build SRT content
    let srt = '';
    segments.forEach((text, i) => {
      const start = startOffset + (i * segDuration);
      const end = start + segDuration - 0.05; // tiny gap between subtitles
      srt += `${i + 1}\n`;
      srt += `${this._formatSrtTime(start)} --> ${this._formatSrtTime(end)}\n`;
      srt += `${text}\n\n`;
    });

    // Write SRT to temp file
    const tmpDir = os.tmpdir();
    const srtPath = path.join(tmpDir, `ep${episode.episode_number}-subs.srt`);
    await fs.writeFile(srtPath, srt, 'utf-8');

    // Upload SRT to Supabase for user download
    const srtBuffer = Buffer.from(srt, 'utf-8');
    const srtUrl = await this._uploadBufferToStorage(
      srtBuffer, userId, 'subtitles', `ep${episode.episode_number}-subtitles.srt`, 'text/plain'
    );

    logger.info(`Subtitles generated: ${segments.length} segments, SRT: ${srtUrl}`);
    return { srtPath, srtUrl };
  }

  /**
   * Align narration duration to the actual video duration using ffmpeg atempo.
   * When the video model falls back (e.g. Kling → Veo), the actual video duration
   * may differ significantly from the planned duration the TTS was generated for.
   *
   * If the ratio is within 0.85-1.15 (±15%), skip — the difference is negligible.
   * If outside that range, stretch/compress the narration using atempo.
   * atempo supports 0.5-2.0 range; for larger ratios, chain multiple atempo filters.
   *
   * @param {Buffer} videoBuffer - The actual generated video
   * @param {Buffer} narrationBuffer - Original TTS narration
   * @param {Object} episode - Episode record
   * @returns {Promise<Buffer>} Aligned narration buffer (or original if no change needed)
   */
  async _alignNarrationToVideo(videoBuffer, narrationBuffer, episode) {
    const tmpDir = os.tmpdir();
    const epNum = episode.episode_number;
    const videoTmp = path.join(tmpDir, `align-video-${epNum}.mp4`);
    const narTmp = path.join(tmpDir, `align-nar-${epNum}.mp3`);
    const outTmp = path.join(tmpDir, `align-out-${epNum}.mp3`);

    try {
      await fs.writeFile(videoTmp, videoBuffer);
      await fs.writeFile(narTmp, narrationBuffer);

      // Probe both durations
      const [videoProbe, narProbe] = await Promise.all([
        execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoTmp]),
        execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', narTmp])
      ]);

      const videoDur = parseFloat(videoProbe.stdout) || 0;
      const narDur = parseFloat(narProbe.stdout) || 0;

      if (!videoDur || !narDur) return narrationBuffer;

      const ratio = narDur / videoDur;
      logger.info(`Narration alignment: video=${videoDur.toFixed(1)}s, narration=${narDur.toFixed(1)}s, ratio=${ratio.toFixed(2)}`);

      // Skip if within ±15% — close enough
      if (ratio >= 0.85 && ratio <= 1.15) {
        logger.info(`Narration alignment: ratio ${ratio.toFixed(2)} within tolerance — no adjustment needed`);
        return narrationBuffer;
      }

      // Build atempo filter chain. atempo supports 0.5-2.0 per instance.
      // For ratios outside that range, chain multiple atempos.
      // ratio > 1 means narration is longer → speed it up (atempo > 1)
      // ratio < 1 means narration is shorter → slow it down (atempo < 1)
      const tempoFilters = [];
      let remaining = ratio;
      while (remaining > 2.0) {
        tempoFilters.push('atempo=2.0');
        remaining /= 2.0;
      }
      while (remaining < 0.5) {
        tempoFilters.push('atempo=0.5');
        remaining /= 0.5;
      }
      tempoFilters.push(`atempo=${remaining.toFixed(4)}`);

      const filterStr = tempoFilters.join(',');
      logger.info(`Narration alignment: applying ${filterStr} to match video duration`);

      await execFileAsync('ffmpeg', [
        '-y',
        '-i', narTmp,
        '-af', filterStr,
        '-c:a', 'libmp3lame', '-q:a', '2',
        outTmp
      ], { timeout: 30000 });

      const aligned = await fs.readFile(outTmp);
      return aligned;
    } finally {
      await Promise.allSettled([
        fs.unlink(videoTmp),
        fs.unlink(narTmp),
        fs.unlink(outTmp)
      ]);
    }
  }

  /**
   * Build an ffmpeg volume expression for narration that dips at shot transition points.
   * Creates a J/L cut feel — the narration breathes at each visual transition.
   *
   * At each transition timestamp, volume drops from baseVol to baseVol*0.3 over 0.2s,
   * then recovers over 0.3s. This creates a natural editorial rhythm.
   *
   * @param {Object} episode - Episode with scene_description.shots[]
   * @param {number} baseVol - Base narration volume (e.g. 0.85)
   * @returns {string} ffmpeg volume expression (for eval=frame mode)
   */
  _buildDuckingVolumeExpr(episode, baseVol) {
    const shots = episode.scene_description?.shots || [];
    if (shots.length <= 1) return String(baseVol);

    // Calculate cumulative timestamps where visual transitions occur
    const transitionDuration = 0.5; // matches xfade duration in _assembleWithTransitions
    const transitionPoints = [];
    let cumulative = 0;
    for (let i = 0; i < shots.length - 1; i++) {
      cumulative += (shots[i].duration_seconds || 5) - transitionDuration;
      transitionPoints.push(cumulative);
    }

    if (transitionPoints.length === 0) return String(baseVol);

    // Build nested if() expression that dips volume around each transition point.
    // Duck shape: ramp down 0.2s before transition, hold low for 0.1s, ramp up 0.3s after.
    const duckLow = baseVol * 0.35;
    const duckHalf = 0.2; // seconds before transition to start ducking
    const duckHold = 0.1; // seconds at minimum
    const duckRecover = 0.3; // seconds to recover after transition

    // For each transition, add a piecewise expression
    // The general form: if(between(t, T-0.2, T+0.4), <duck_curve>, <else>)
    // Duck curve: ramp_down from T-0.2 to T, hold from T to T+0.1, ramp_up from T+0.1 to T+0.4
    const parts = transitionPoints.map(T => {
      const start = (T - duckHalf).toFixed(3);
      const holdEnd = (T + duckHold).toFixed(3);
      const end = (T + duckHold + duckRecover).toFixed(3);
      // Piecewise: if in range, compute duck; else pass through
      return `if(between(t,${start},${end}),` +
        `if(lt(t,${T.toFixed(3)}),${baseVol}-(${baseVol}-${duckLow})*(t-${start})/${duckHalf},` +
        `if(lt(t,${holdEnd}),${duckLow},` +
        `${duckLow}+(${baseVol}-${duckLow})*(t-${holdEnd})/${duckRecover}))`;
    });

    // Chain parts: if duck1 applies, use it; else if duck2 applies, use it; else baseVol
    // Build from innermost out
    let expr = String(baseVol);
    for (let i = parts.length - 1; i >= 0; i--) {
      expr = `${parts[i]},${expr})`;
    }

    return expr;
  }

  /**
   * Build ambient audio volume expression that swells slightly at transitions.
   * The inverse of narration ducking — ambient rises when narration dips,
   * creating a natural soundscape shift at visual cuts.
   */
  _buildAmbientSwellExpr(episode, baseVol) {
    const shots = episode.scene_description?.shots || [];
    if (shots.length <= 1) return String(baseVol);

    const transitionDuration = 0.5;
    const transitionPoints = [];
    let cumulative = 0;
    for (let i = 0; i < shots.length - 1; i++) {
      cumulative += (shots[i].duration_seconds || 5) - transitionDuration;
      transitionPoints.push(cumulative);
    }

    if (transitionPoints.length === 0) return String(baseVol);

    // Ambient swells to ~3x base at transitions (e.g. 0.12 → 0.35)
    const swellPeak = Math.min(baseVol * 3, 0.4);

    const parts = transitionPoints.map(T => {
      const start = (T - 0.2).toFixed(3);
      const end = (T + 0.4).toFixed(3);
      return `if(between(t,${start},${end}),` +
        `${baseVol}+(${swellPeak}-${baseVol})*` +
        `if(lt(t,${T.toFixed(3)}),(t-${start})/0.2,1.0-(t-${T.toFixed(3)})/0.4)`;
    });

    let expr = String(baseVol);
    for (let i = parts.length - 1; i >= 0; i--) {
      expr = `${parts[i]},${expr})`;
    }

    return expr;
  }

  /**
   * Format seconds to SRT time format: HH:MM:SS,mmm
   */
  _formatSrtTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.round((seconds % 1) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  }

  /**
   * Burn subtitles into a video using drawtext filter_script.
   * Avoids the libass-dependent `subtitles` filter (not available on all ffmpeg builds).
   * Instead, parses the SRT and generates drawtext filters per segment written to a
   * filter_script file (sidesteps all escaping issues).
   */
  /**
   * Burn subtitles into a video using sharp-rendered PNG overlays + ffmpeg overlay filter.
   * Each subtitle segment becomes a transparent PNG with white text + black outline,
   * composited at the correct time range via ffmpeg overlay enable expressions.
   *
   * For episodes with many segments (typical: 10-15), we batch into groups of 4
   * to avoid ffmpeg filter_complex input limits, doing multiple overlay passes.
   */
  async _burnSubtitles(videoPath, srtPath, outputPath) {
    if (!srtPath) return videoPath;

    const tmpDir = os.tmpdir();
    const tmpFiles = [];

    try {
      const sharp = (await import('sharp')).default;

      // Parse SRT into timed segments
      const srtContent = await fs.readFile(srtPath, 'utf-8');
      const segments = this._parseSrt(srtContent);
      if (segments.length === 0) return videoPath;

      // Get video dimensions
      const probeResult = await execFileAsync('ffprobe', [
        '-v', 'error', '-show_entries', 'stream=width,height',
        '-of', 'json', videoPath
      ]);
      const probeJson = JSON.parse(probeResult.stdout);
      const videoStream = (probeJson.streams || []).find(s => s.width);
      const W = videoStream?.width || 1080;
      const H = videoStream?.height || 1920;

      const escXml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

      // Render each subtitle segment as a transparent PNG
      const segmentPngs = [];
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const yPos = Math.round(H * 0.88);
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
          <text x="50%" y="${yPos}" font-family="Arial, Helvetica, sans-serif" font-size="22" font-weight="bold"
                fill="white" stroke="black" stroke-width="2" paint-order="stroke"
                text-anchor="middle" dominant-baseline="middle">${escXml(seg.text)}</text>
        </svg>`;
        const pngBuf = await sharp(Buffer.from(svg)).png().toBuffer();
        const pngPath = path.join(tmpDir, `sub-${i}.png`);
        await fs.writeFile(pngPath, pngBuf);
        tmpFiles.push(pngPath);
        segmentPngs.push({ path: pngPath, start: seg.start, end: seg.end });
      }

      // Apply overlays in batches of 4 (ffmpeg handles many inputs but gets slow with 15+)
      let currentVideoPath = videoPath;
      const BATCH_SIZE = 4;
      for (let batch = 0; batch < segmentPngs.length; batch += BATCH_SIZE) {
        const batchSegs = segmentPngs.slice(batch, batch + BATCH_SIZE);
        const batchOutput = batch + BATCH_SIZE >= segmentPngs.length
          ? outputPath
          : path.join(tmpDir, `sub-batch-${batch}.mp4`);
        if (batchOutput !== outputPath) tmpFiles.push(batchOutput);

        const inputs = ['-i', currentVideoPath];
        const filterParts = [];
        let currentLabel = '[0:v]';

        for (let j = 0; j < batchSegs.length; j++) {
          const seg = batchSegs[j];
          const inputIdx = j + 1;
          inputs.push('-loop', '1', '-t', (seg.end - seg.start + 0.1).toFixed(2), '-i', seg.path);
          const outLabel = j === batchSegs.length - 1 ? '[vout]' : `[vs${batch + j}]`;
          filterParts.push(
            `${currentLabel}[${inputIdx}:v]overlay=0:0:enable='between(t,${seg.start.toFixed(3)},${seg.end.toFixed(3)})'${outLabel}`
          );
          currentLabel = outLabel;
        }

        await execFileAsync('ffmpeg', [
          '-y', ...inputs,
          '-filter_complex', filterParts.join(';'),
          '-map', '[vout]', '-map', '0:a',
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
          '-c:a', 'copy', '-movflags', '+faststart', '-shortest',
          batchOutput
        ], { timeout: 180000 });

        currentVideoPath = batchOutput;
      }

      return outputPath;
    } catch (subErr) {
      logger.warn(`Subtitle burn failed (non-fatal): ${subErr.message}`);
      return videoPath;
    } finally {
      await Promise.allSettled(tmpFiles.map(f => fs.unlink(f)));
    }
  }

  /**
   * Parse SRT content into an array of { start, end, text } segments.
   * Times are in seconds (float).
   */
  _parseSrt(srtContent) {
    const segments = [];
    const blocks = srtContent.trim().split(/\n\n+/);
    for (const block of blocks) {
      const lines = block.trim().split('\n');
      if (lines.length < 3) continue;
      const timeLine = lines[1];
      const match = timeLine.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
      if (!match) continue;
      const start = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]) + parseInt(match[4]) / 1000;
      const end = parseInt(match[5]) * 3600 + parseInt(match[6]) * 60 + parseInt(match[7]) + parseInt(match[8]) / 1000;
      const text = lines.slice(2).join(' ');
      segments.push({ start, end, text });
    }
    return segments;
  }

  // ═══════════════════════════════════════════════════
  // STORY-SO-FAR APPENDIX (running continuity memory)
  // ═══════════════════════════════════════════════════

  /**
   * After each episode is finalized, append a compressed summary to the storyline's
   * season_bible. This prevents late-episode amnesia — by Episode 8+, the "previously on"
   * block compresses early episodes to one-liners, but key narrative threads (planted in
   * Ep 2, payoff in Ep 10) would be forgotten. The story_so_far keeps the writer's room
   * memory fresh without bloating the prompt.
   */
  async _updateStorySoFar(storyId, userId, episode) {
    const story = await getBrandStoryById(storyId, userId);
    if (!story?.storyline) return;

    const scene = episode.scene_description || {};
    const epSummary = `Ep${episode.episode_number} "${scene.title || ''}": ${scene.narrative_beat || ''}. Mood: ${scene.mood || ''}. Cliffhanger: ${scene.cliffhanger || ''}. Emotional state: ${scene.emotional_state || 'not recorded'}.`;

    // Build or append to the running story_so_far
    const existingSoFar = story.storyline.story_so_far || '';
    const updatedSoFar = existingSoFar
      ? `${existingSoFar}\n${epSummary}`
      : `STORY SO FAR:\n${epSummary}`;

    // ─── V4 cross-episode memory streams ───
    // When the episode is a V4 scene-graph (scenes[]→beats[]), extract:
    //   1. previously_on_keyframes — one structured anchor per episode
    //   2. character_voice_samples — rolling cap of 6 characteristic lines per persona
    //   3. emotional_intensity_ledger — 1-10 closing intensity per episode
    // For legacy v2/v3 episodes these fields just carry forward untouched.
    const existingKeyframes = Array.isArray(story.storyline.previously_on_keyframes)
      ? story.storyline.previously_on_keyframes
      : [];
    const existingVoiceSamples = story.storyline.character_voice_samples && typeof story.storyline.character_voice_samples === 'object'
      ? { ...story.storyline.character_voice_samples }
      : {};
    const existingLedger = story.storyline.emotional_intensity_ledger && typeof story.storyline.emotional_intensity_ledger === 'object'
      ? { ...story.storyline.emotional_intensity_ledger }
      : {};

    const updatedKeyframes = [...existingKeyframes];
    const updatedVoiceSamples = existingVoiceSamples;
    const updatedLedger = existingLedger;

    const v4Scenes = Array.isArray(scene.scenes) ? scene.scenes : null;

    if (v4Scenes && v4Scenes.length > 0) {
      // Keyframe: prefer the episode's own cliffhanger line or a standout dialogue line
      const allDialogueBeats = [];
      for (const sc of v4Scenes) {
        for (const beat of sc.beats || []) {
          if (beat.dialogue && typeof beat.dialogue === 'string' && beat.dialogue.trim()) {
            allDialogueBeats.push({
              persona_index: Number.isInteger(beat.persona_index) ? beat.persona_index : null,
              dialogue: beat.dialogue.trim(),
              subtext: beat.subtext || null,
              emotion: beat.emotion || null,
              words: beat.dialogue.trim().split(/\s+/).length
            });
          }
          if (Array.isArray(beat.exchanges)) {
            for (const ex of beat.exchanges) {
              if (ex.dialogue && typeof ex.dialogue === 'string' && ex.dialogue.trim()) {
                allDialogueBeats.push({
                  persona_index: Number.isInteger(ex.persona_index) ? ex.persona_index : null,
                  dialogue: ex.dialogue.trim(),
                  subtext: ex.subtext || null,
                  emotion: ex.emotion || null,
                  words: ex.dialogue.trim().split(/\s+/).length
                });
              }
            }
          }
        }
      }

      // Keyframe: use the cliffhanger if provided, else the last dialogue line of the episode
      const keyframeAnchor = scene.cliffhanger
        ? `Ep${episode.episode_number}: ${scene.cliffhanger}`
        : allDialogueBeats.length > 0
          ? `Ep${episode.episode_number}: "${allDialogueBeats[allDialogueBeats.length - 1].dialogue}"`
          : `Ep${episode.episode_number}: ${scene.narrative_beat || scene.title || ''}`;
      updatedKeyframes.push(keyframeAnchor);

      // Voice samples: per persona, pick 2-3 characteristic lines
      //   heuristic: longest line + shortest line + one line with subtext (if any)
      const byPersona = {};
      for (const d of allDialogueBeats) {
        if (d.persona_index === null) continue;
        const key = String(d.persona_index);
        if (!byPersona[key]) byPersona[key] = [];
        byPersona[key].push(d);
      }

      for (const [idxKey, lines] of Object.entries(byPersona)) {
        if (lines.length === 0) continue;
        const sorted = [...lines].sort((a, b) => b.words - a.words);
        const longest = sorted[0];
        const shortest = sorted[sorted.length - 1];
        const withSubtext = lines.find(l => l.subtext && l.subtext.length > 0);
        const picks = [longest, shortest, withSubtext].filter(Boolean);
        const uniquePicks = [];
        const seen = new Set();
        for (const p of picks) {
          if (!seen.has(p.dialogue)) {
            seen.add(p.dialogue);
            uniquePicks.push(p.dialogue);
          }
        }
        const prior = Array.isArray(updatedVoiceSamples[idxKey]) ? updatedVoiceSamples[idxKey] : [];
        const combined = [...prior, ...uniquePicks];
        // Rolling cap: keep the 6 most recent per persona
        updatedVoiceSamples[idxKey] = combined.slice(-6);
      }
    } else if (scene.dialogue_script) {
      // Legacy v2/v3 episode — one narration block. Store as persona 0's sample if the
      // story has personas. This preserves *some* voice continuity for older flows.
      updatedKeyframes.push(`Ep${episode.episode_number}: ${scene.cliffhanger || scene.narrative_beat || scene.title || ''}`);
    } else {
      updatedKeyframes.push(`Ep${episode.episode_number}: ${scene.narrative_beat || scene.title || ''}`);
    }

    // Intensity ledger: extract a rough 1-10 signal from emotional_state keywords.
    // Intentionally simple and genre-agnostic — the screenplay prompt can override
    // with explicit closing_intensity when the bible starts emitting it.
    const closingIntensity = this._estimateEmotionalIntensity(scene.emotional_state || scene.mood || '');
    if (closingIntensity !== null) {
      updatedLedger[String(episode.episode_number)] = closingIntensity;
    }

    // Also track the latest visual_style_prefix for cross-episode continuity
    const updatedStoryline = {
      ...story.storyline,
      story_so_far: updatedSoFar,
      last_visual_style_prefix: scene.visual_style_prefix || story.storyline.last_visual_style_prefix || '',
      last_emotional_state: scene.emotional_state || '',
      previously_on_keyframes: updatedKeyframes,
      character_voice_samples: updatedVoiceSamples,
      emotional_intensity_ledger: updatedLedger
    };

    await updateBrandStory(storyId, userId, { storyline: updatedStoryline });
    logger.info(`Story-so-far updated for story ${storyId} after episode ${episode.episode_number} (${updatedKeyframes.length} keyframes, ${Object.keys(updatedVoiceSamples).length} personas with voice samples)`);
  }

  /**
   * Rough 1-10 intensity estimate from a free-text emotional_state string.
   * Genre-agnostic keyword map. Returns null if nothing matches — caller treats
   * null as "no signal recorded for this episode" and the validator skips the ramp
   * check for that datapoint.
   */
  _estimateEmotionalIntensity(text) {
    if (!text || typeof text !== 'string') return null;
    const t = text.toLowerCase();
    // Descending severity — first match wins
    const buckets = [
      { score: 10, keys: ['devastat', 'catastroph', 'ruined', 'shatter', 'annihilat'] },
      { score: 9,  keys: ['reelin', 'breakdown', 'crushed', 'unravel', 'heartbroken'] },
      { score: 8,  keys: ['furious', 'terror', 'despair', 'horrified', 'betrayed'] },
      { score: 7,  keys: ['stunned', 'tense', 'bracing', 'anxious', 'urgent', 'dread', 'panicked'] },
      { score: 6,  keys: ['suspicious', 'wary', 'uneasy', 'apprehensive', 'brittle', 'heartbreak'] },
      { score: 5,  keys: ['ambivalent', 'unsettled', 'uncertain', 'melanchol', 'bittersweet', 'guarded'] },
      { score: 4,  keys: ['reflective', 'quiet', 'subdued', 'contempl'] },
      { score: 3,  keys: ['curious', 'intrig', 'hopeful', 'calm'] },
      { score: 2,  keys: ['warm', 'relieved', 'content', 'gentle', 'tender'] },
      { score: 1,  keys: ['serene', 'peaceful', 'settled', 'resolved'] }
    ];
    for (const b of buckets) {
      for (const k of b.keys) {
        if (t.includes(k)) return b.score;
      }
    }
    return null;
  }

  // ═══════════════════════════════════════════════════
  // CROSS-EPISODE STORYBOARD SEED CONTINUITY
  // ═══════════════════════════════════════════════════

  /**
   * Get a deterministic base seed for storyboard generation that maintains
   * visual consistency across episodes. Uses the story ID hash as a stable
   * root, with episode and shot offsets for variation within consistency.
   */
  _getStoryboardSeed(story, episodeNumber, shotIndex) {
    // Deterministic hash from story ID — same story always gets same visual family
    const hash = [...story.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0);
    const baseSeed = Math.abs(hash) % 2147483647;
    // Offset by episode * 100 + shot to get variation within the same visual family
    return baseSeed + (episodeNumber * 100) + shotIndex;
  }
}

// Singleton export
const brandStoryService = new BrandStoryService();
export default brandStoryService;
export { BrandStoryService };
