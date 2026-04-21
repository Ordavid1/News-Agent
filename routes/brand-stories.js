/**
 * Brand Story Routes
 *
 * REST endpoints for the Brand Story video series feature:
 * - Story CRUD (create, read, update, delete)
 * - Storyline generation (Gemini)
 * - Episode generation pipeline (Leonardo.ai + HeyGen + Veo/Runway)
 * - Avatar setup and listing
 * - Story activation/pause for automated publishing
 */

import express from 'express';
import multer from 'multer';
import { authenticateToken } from '../middleware/auth.js';
import { requireTier } from '../middleware/subscription.js';
import { csrfProtection } from '../middleware/csrf.js';
import brandStoryService from '../services/BrandStoryService.js';
import {
  getBrandStoryById,
  getBrandStoryEpisodes,
  getBrandStoryEpisodeById,
  updateBrandStory,
  updateBrandStoryEpisode,
  getMediaTrainingJobById,
  createAgent,
  updateAgent,
  getConnection
} from '../services/database-wrapper.js';
import winston from 'winston';

// V4 imports
import { getProgressEmitter } from '../services/v4/ProgressEmitter.js';
import { getVoiceLibrary } from '../services/v4/VoiceAcquisition.js';
import { resolveEpisodeLut } from '../services/v4/BrandKitLutMatcher.js';
import {
  v4RegenerateLimiter,
  v4ReassembleLimiter,
  v4PatchLimiter,
  v4DeleteLimiter
} from '../middleware/v4RateLimiter.js';

const router = express.Router();

// Multer config for subject image uploads (1-3 images, memory storage)
const subjectUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 3 }, // 10MB each, max 3 files
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${file.mimetype}. Allowed: JPEG, PNG, WebP`));
    }
  }
});

// Multer config for persona face uploads (up to 15 images for HeyGen training)
const personaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 15 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${file.mimetype}. Allowed: JPEG, PNG, WebP`));
    }
  }
});

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()]
});

// All brand story routes require authentication AND the Business subscription tier ($250/mo).
// Brand Story is an exclusive Business-tier feature — gate every endpoint here so the tier
// check is enforced uniformly regardless of which sub-route the client hits.
router.use(authenticateToken);
router.use(requireTier('business'));

// ============================================================
// HEYGEN AVATAR MANAGEMENT (must be before /:id routes)
// ============================================================

/**
 * GET /api/brand-stories/avatars/stock
 * List available HeyGen stock avatars
 */
router.get('/avatars/stock', async (req, res) => {
  try {
    const avatars = await brandStoryService.listStockAvatars();
    res.json({ success: true, avatars });
  } catch (error) {
    logger.error('Error listing stock avatars:', error);
    res.status(500).json({ success: false, error: 'Failed to list stock avatars' });
  }
});

/**
 * GET /api/brand-stories/voices
 * List HeyGen voices for the UI voice picker. Supports optional filters.
 * Query params (optional): language=en, gender=female|male
 */
router.get('/voices', async (req, res) => {
  try {
    const voices = await brandStoryService.listVoices({
      language: req.query.language,
      gender: req.query.gender
    });
    res.json({ success: true, voices });
  } catch (error) {
    logger.error('Error listing voices:', error);
    res.status(500).json({ success: false, error: 'Failed to list voices' });
  }
});

/**
 * GET /api/brand-stories/avatars/auto-pick?focus=product&subject_hint=perfume
 * Auto-pick a single HeyGen stock avatar best suited for the given story focus.
 * Only for focus=product or focus=landscape. Person focus must use real photos.
 */
router.get('/avatars/auto-pick', async (req, res) => {
  try {
    const focus = req.query.focus || 'product';
    const subjectHint = req.query.subject_hint || '';

    if (!['person', 'product', 'landscape'].includes(focus)) {
      return res.status(400).json({ success: false, error: 'focus must be person, product, or landscape' });
    }
    if (focus === 'person') {
      return res.status(400).json({
        success: false,
        error: 'Auto-pick is not available for "person" focus — upload real photos instead'
      });
    }

    const avatar = await brandStoryService.autoPickStockAvatar({ focus, subjectHint });
    if (!avatar) {
      return res.status(404).json({ success: false, error: 'No suitable avatar found' });
    }
    res.json({ success: true, avatar });
  } catch (error) {
    logger.error('Error auto-picking avatar:', error);
    res.status(500).json({ success: false, error: 'Failed to auto-pick avatar' });
  }
});

/**
 * GET /api/brand-stories/brand-kits
 * List all of the user's completed Brand Kits (across all ad accounts).
 * Used to populate the Brand Kit dropdown in the story creation wizard.
 */
router.get('/brand-kits', async (req, res) => {
  try {
    const { supabaseAdmin } = await import('../services/supabase.js');

    const { data: jobs, error } = await supabaseAdmin
      .from('media_training_jobs')
      .select('id, name, brand_kit, ad_account_id, status, created_at')
      .eq('user_id', req.user.id)
      .not('brand_kit', 'is', null)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('Error fetching brand kits:', error);
      return res.status(500).json({ success: false, error: 'Failed to fetch brand kits' });
    }

    const brandKits = (jobs || []).map(job => ({
      id: job.id,
      name: job.name || 'Untitled',
      status: job.status,
      ad_account_id: job.ad_account_id,
      brand_summary: job.brand_kit?.brand_summary || '',
      has_people: (job.brand_kit?.extracted_assets || []).some(a => a.type === 'person'),
      created_at: job.created_at
    }));

    res.json({ success: true, brandKits });
  } catch (error) {
    logger.error('Error listing brand kits:', error);
    res.status(500).json({ success: false, error: 'Failed to list brand kits' });
  }
});

/**
 * GET /api/brand-stories/personas/brand-kit
 * List person cutouts extracted from the user's Brand Kits.
 * Scans all of the user's media training jobs and returns their person assets.
 */
router.get('/personas/brand-kit', async (req, res) => {
  try {
    const { supabaseAdmin } = await import('../services/supabase.js');

    // Get all training jobs for this user that have a brand_kit with extracted_assets
    const { data: jobs, error } = await supabaseAdmin
      .from('media_training_jobs')
      .select('id, name, brand_kit, ad_account_id')
      .eq('user_id', req.user.id)
      .not('brand_kit', 'is', null)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('Error fetching brand kits for personas:', error);
      return res.status(500).json({ success: false, error: 'Failed to fetch brand kits' });
    }

    // Extract all person cutouts from all brand kits
    const personas = [];
    for (const job of (jobs || [])) {
      const extractedAssets = job.brand_kit?.extracted_assets || [];
      const peopleDescriptions = job.brand_kit?.people || [];

      extractedAssets
        .filter(asset => asset.type === 'person')
        .forEach((asset, idx) => {
          // Match a people-description entry if available (same order preferred)
          const matchingDesc = peopleDescriptions[idx] || peopleDescriptions[0] || {};
          personas.push({
            id: asset.id,
            url: asset.url,
            storage_path: asset.storage_path,
            description: asset.description || matchingDesc.description || 'Brand person',
            context: matchingDesc.context || '',
            confidence: asset.confidence || null,
            brand_kit_job_id: job.id,
            brand_kit_name: job.name || 'Untitled Brand Kit'
          });
        });
    }

    res.json({ success: true, personas });
  } catch (error) {
    logger.error('Error listing brand kit personas:', error);
    res.status(500).json({ success: false, error: 'Failed to list brand kit personas' });
  }
});

/**
 * GET /api/brand-stories/subjects/brand-kit
 * List non-person assets (logos, graphics, products) from the user's Brand Kits.
 * These are candidate images for subject analysis.
 */
router.get('/subjects/brand-kit', async (req, res) => {
  try {
    const { supabaseAdmin } = await import('../services/supabase.js');

    const { data: jobs, error } = await supabaseAdmin
      .from('media_training_jobs')
      .select('id, name, brand_kit')
      .eq('user_id', req.user.id)
      .not('brand_kit', 'is', null)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('Error fetching brand kits for subjects:', error);
      return res.status(500).json({ success: false, error: 'Failed to fetch brand kits' });
    }

    // Extract non-person assets (logos + graphics)
    const subjects = [];
    for (const job of (jobs || [])) {
      const extractedAssets = job.brand_kit?.extracted_assets || [];
      extractedAssets
        .filter(asset => asset.type !== 'person')
        .forEach(asset => {
          subjects.push({
            id: asset.id,
            url: asset.url,
            storage_path: asset.storage_path,
            type: asset.type, // 'logo' or 'graphic'
            description: asset.description || `${asset.type} asset`,
            confidence: asset.confidence || null,
            brand_kit_job_id: job.id,
            brand_kit_name: job.name || 'Untitled Brand Kit'
          });
        });
    }

    res.json({ success: true, subjects });
  } catch (error) {
    logger.error('Error listing brand kit subjects:', error);
    res.status(500).json({ success: false, error: 'Failed to list brand kit subjects' });
  }
});

/**
 * POST /api/brand-stories/personas/auto-generate
 * Auto-generate persona(s) from Brand Kit context.
 * Uses Gemini to design the character, Flux 2 Max to generate a portrait.
 * Body: { brand_kit_job_id, count: 1-3, story_focus }
 */
/**
 * POST /api/brand-stories/generate-directors-hint
 * Auto-generate a director's creative brief using all available story context.
 * Each call produces a different creative angle (variation 1-5).
 */
router.post('/generate-directors-hint', csrfProtection, async (req, res) => {
  try {
    const { story_focus, genre, tone, target_audience, brand_kit_job_id, subject, personas, variation } = req.body;

    const hint = await brandStoryService.generateDirectorsHint(req.user.id, {
      storyFocus: story_focus || 'product',
      genre: genre || 'drama',
      tone: tone || 'engaging',
      targetAudience: target_audience || 'young professionals',
      brandKitJobId: brand_kit_job_id,
      subject,
      personas: personas || [],
      variation: variation || 1
    });

    res.json({ success: true, hint });
  } catch (error) {
    logger.error('Error generating directors hint:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to generate hint' });
  }
});

router.post('/personas/auto-generate', csrfProtection, async (req, res) => {
  try {
    const { brand_kit_job_id, count = 1, story_focus = 'product' } = req.body;
    if (!brand_kit_job_id) {
      return res.status(400).json({ success: false, error: 'brand_kit_job_id is required' });
    }

    const personas = await brandStoryService.generatePersonaFromBrandKit(
      brand_kit_job_id,
      req.user.id,
      { count: Math.min(Math.max(count, 1), 3), storyFocus: story_focus }
    );

    res.json({ success: true, personas });
  } catch (error) {
    logger.error('Error auto-generating persona:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to generate persona' });
  }
});

/**
 * POST /api/brand-stories/personas/upload
 * Upload face photos for a persona (uploaded persona type).
 * Accepts multipart form-data with "images" field (1-5 photos).
 * Returns the uploaded image URLs for use in persona_config.
 */
router.post('/personas/upload', csrfProtection, personaUpload.array('images', 15), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: 'At least one image is required' });
    }

    const { supabaseAdmin } = await import('../services/supabase.js');
    const STORAGE_BUCKET = 'media-assets';

    const urls = [];
    for (const file of req.files) {
      const ext = file.originalname.split('.').pop().toLowerCase();
      const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const storagePath = `${req.user.id}/brand-stories/personas/${uniqueName}`;

      const { error: uploadError } = await supabaseAdmin.storage
        .from(STORAGE_BUCKET)
        .upload(storagePath, file.buffer, {
          contentType: file.mimetype,
          upsert: false
        });

      if (uploadError) {
        logger.error('Error uploading persona image:', uploadError);
        return res.status(500).json({ success: false, error: `Upload failed: ${uploadError.message}` });
      }

      const { data: urlData } = supabaseAdmin.storage
        .from(STORAGE_BUCKET)
        .getPublicUrl(storagePath);

      urls.push(urlData.publicUrl);
    }

    res.json({ success: true, urls });
  } catch (error) {
    logger.error('Error uploading persona images:', error);
    res.status(500).json({ success: false, error: error.message || 'Upload failed' });
  }
});

/**
 * POST /api/brand-stories/subjects/analyze
 * Analyze 1-3 subject images via Gemini and return structured subject metadata.
 * Accepts either:
 *   - multipart/form-data with "images" files (1-3 uploads)
 *   - application/json with { imageUrls: [url1, url2, url3], brandKitJobId?: uuid }
 */
// Conditional multer: only parse multipart, let JSON pass through.
// (Running multer on JSON requests was silently eating the body.)
const conditionalMultipart = (req, res, next) => {
  const contentType = req.headers['content-type'] || '';
  if (contentType.startsWith('multipart/form-data')) {
    return subjectUpload.array('images', 3)(req, res, next);
  }
  return next();
};

router.post('/subjects/analyze', csrfProtection, conditionalMultipart, async (req, res) => {
  try {
    let images = [];
    let referenceUrls = [];  // Persistent public URLs for the actual subject images
    let brandKit = null;

    // Case 1: Multipart file upload — upload to Supabase Storage FIRST so we preserve the real pixels
    // for later use as visual references in Leonardo/Kling/Veo.
    if (req.files && req.files.length > 0) {
      const { supabaseAdmin } = await import('../services/supabase.js');
      const STORAGE_BUCKET = 'media-assets';

      for (const file of req.files) {
        // Upload the raw buffer to Supabase → get a public URL that outlives this request.
        const ext = (file.originalname || 'img.jpg').split('.').pop().toLowerCase();
        const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const storagePath = `${req.user.id}/brand-stories/subjects/${uniqueName}`;
        const { error: uploadError } = await supabaseAdmin.storage
          .from(STORAGE_BUCKET)
          .upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: false });
        if (uploadError) {
          logger.error(`Subject image upload failed: ${uploadError.message}`);
          return res.status(500).json({ success: false, error: `Upload failed: ${uploadError.message}` });
        }
        const { data: urlData } = supabaseAdmin.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);
        referenceUrls.push(urlData.publicUrl);
        images.push({ data: file.buffer, mimeType: file.mimetype });
      }

      // Optional brand kit context via form field
      const brandKitJobId = req.body.brandKitJobId;
      if (brandKitJobId) {
        const job = await getMediaTrainingJobById(brandKitJobId, req.user.id);
        if (job?.brand_kit) brandKit = job.brand_kit;
      }
    }
    // Case 2: JSON body with image URLs (typically from Brand Kit cutouts) — URLs are already persistent.
    else if (req.body?.imageUrls && Array.isArray(req.body.imageUrls) && req.body.imageUrls.length > 0) {
      images = req.body.imageUrls.slice(0, 3);
      referenceUrls = images.slice(); // Brand Kit URLs are already public
      const brandKitJobId = req.body.brandKitJobId;
      if (brandKitJobId) {
        const job = await getMediaTrainingJobById(brandKitJobId, req.user.id);
        if (job?.brand_kit) brandKit = job.brand_kit;
      }
    } else {
      logger.warn(`subjects/analyze — no images provided. req.files: ${req.files?.length || 0}, req.body keys: ${Object.keys(req.body || {}).join(',')}`);
      return res.status(400).json({
        success: false,
        error: 'Provide either image files (multipart) or imageUrls (JSON)'
      });
    }

    if (images.length === 0) {
      return res.status(400).json({ success: false, error: 'At least one image is required' });
    }

    // Focus hint from query/body — shapes Gemini's integration_guidance field.
    const storyFocus = req.body?.storyFocus || req.query?.focus || 'product';

    const subject = await brandStoryService.analyzeSubject({ images, brandKit, storyFocus });
    // Attach persistent URLs to the returned subject so the frontend persists them with the story.
    subject.reference_image_urls = referenceUrls;

    res.json({ success: true, subject });
  } catch (error) {
    logger.error('Error analyzing subject:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to analyze subject' });
  }
});

// ============================================================
// STORY CRUD
// ============================================================

/**
 * GET /api/brand-stories
 * List all brand stories for the current user
 */
router.get('/', async (req, res) => {
  try {
    const stories = await brandStoryService.getStories(req.user.id);
    res.json({ success: true, stories });
  } catch (error) {
    logger.error('Error listing brand stories:', error);
    res.status(500).json({ success: false, error: 'Failed to list brand stories' });
  }
});

/**
 * GET /api/brand-stories/:id
 * Get a brand story with its episodes
 */
router.get('/:id', async (req, res) => {
  try {
    const story = await brandStoryService.getStoryWithEpisodes(req.params.id, req.user.id);
    if (!story) {
      return res.status(404).json({ success: false, error: 'Story not found' });
    }
    res.json({ success: true, story });
  } catch (error) {
    logger.error('Error getting brand story:', error);
    res.status(500).json({ success: false, error: 'Failed to get brand story' });
  }
});

/**
 * POST /api/brand-stories
 * Create a new brand story
 */
router.post('/', csrfProtection, async (req, res) => {
  try {
    const { name, story_focus, persona_type, persona_config, subject,
            brand_kit_job_id, target_platforms, publish_frequency } = req.body;

    if (!name || !persona_type) {
      return res.status(400).json({ success: false, error: 'name and persona_type are required' });
    }

    if (!['person', 'product', 'landscape'].includes(story_focus)) {
      return res.status(400).json({
        success: false,
        error: 'story_focus must be person, product, or landscape'
      });
    }

    if (!['described', 'selected', 'uploaded', 'brand_kit', 'brand_kit_auto'].includes(persona_type)) {
      return res.status(400).json({
        success: false,
        error: 'persona_type must be described, selected, uploaded, brand_kit, or brand_kit_auto'
      });
    }

    // Enforce focus↔persona_type mapping.
    // V3 cinematic pipeline allows all persona types for all focuses.
    const allowedByFocus = {
      person:    ['described', 'selected', 'uploaded', 'brand_kit', 'brand_kit_auto'],
      product:   ['described', 'selected', 'uploaded', 'brand_kit', 'brand_kit_auto'],
      landscape: ['described', 'selected', 'uploaded', 'brand_kit', 'brand_kit_auto']
    };
    if (!(allowedByFocus[story_focus] || allowedByFocus.product).includes(persona_type)) {
      return res.status(400).json({
        success: false,
        error: `persona_type "${persona_type}" is not valid for story_focus "${story_focus}"`
      });
    }

    const story = await brandStoryService.createStory(req.user.id, {
      name,
      story_focus,
      persona_type,
      persona_config: persona_config || {},
      subject: subject || {},
      brand_kit_job_id: brand_kit_job_id || null,
      target_platforms: target_platforms || [],
      publish_frequency: publish_frequency || 'daily'
    });

    res.status(201).json({ success: true, story });
  } catch (error) {
    logger.error('Error creating brand story:', error);
    res.status(error.message.includes('not found') ? 400 : 500).json({
      success: false,
      error: error.message || 'Failed to create brand story'
    });
  }
});

/**
 * PUT /api/brand-stories/:id
 * Update a brand story
 */
router.put('/:id', csrfProtection, async (req, res) => {
  try {
    const allowedFields = ['name', 'story_focus', 'persona_type', 'persona_config', 'subject',
      'brand_kit_job_id', 'target_platforms', 'publish_frequency', 'heygen_avatar_id', 'heygen_avatar_group_id'];

    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    const story = await brandStoryService.updateStory(req.params.id, req.user.id, updates);
    if (!story) {
      return res.status(404).json({ success: false, error: 'Story not found' });
    }

    res.json({ success: true, story });
  } catch (error) {
    logger.error('Error updating brand story:', error);
    res.status(500).json({ success: false, error: 'Failed to update brand story' });
  }
});

/**
 * DELETE /api/brand-stories/:id
 * Delete a brand story and all its episodes
 */
router.delete('/:id', csrfProtection, async (req, res) => {
  try {
    await brandStoryService.deleteStory(req.params.id, req.user.id);
    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting brand story:', error);
    res.status(500).json({ success: false, error: 'Failed to delete brand story' });
  }
});

// ============================================================
// STORYLINE GENERATION
// ============================================================

/**
 * POST /api/brand-stories/:id/generate-storyline
 * Trigger Gemini to generate a full season arc / story bible
 */
router.post('/:id/generate-storyline', csrfProtection, async (req, res) => {
  try {
    const story = await brandStoryService.generateStoryline(req.params.id, req.user.id);
    res.json({ success: true, story });
  } catch (error) {
    logger.error('Error generating storyline:', error);
    res.status(error.message.includes('not found') ? 404 : 500).json({
      success: false,
      error: error.message || 'Failed to generate storyline'
    });
  }
});

// ============================================================
// EPISODE GENERATION
// ============================================================

/**
 * POST /api/brand-stories/:id/generate-episode
 * Manually trigger generation of the next episode (full pipeline)
 */
router.post('/:id/generate-episode', csrfProtection, async (req, res) => {
  try {
    // Start the pipeline in the background and return immediately
    const storyId = req.params.id;
    const userId = req.user.id;

    // Verify story exists
    const story = await getBrandStoryById(storyId, userId);
    if (!story) {
      return res.status(404).json({ success: false, error: 'Story not found' });
    }
    if (!story.storyline) {
      return res.status(400).json({ success: false, error: 'Generate a storyline first' });
    }

    // Return accepted — pipeline runs async
    res.json({ success: true, message: 'Episode generation started' });

    // Run pipeline in background (don't await in the request handler).
    // Log only the concise error message — the pipeline itself already
    // logs detailed errors for the specific stage that failed.
    brandStoryService.runEpisodePipeline(storyId, userId).catch(err => {
      logger.error(`Background episode pipeline failed for story ${storyId}: ${err.message}`);
    });
  } catch (error) {
    logger.error('Error starting episode generation:', error);
    res.status(500).json({ success: false, error: 'Failed to start episode generation' });
  }
});

/**
 * GET /api/brand-stories/:id/episodes
 * List all episodes for a story
 */
router.get('/:id/episodes', async (req, res) => {
  try {
    const episodes = await getBrandStoryEpisodes(req.params.id, req.user.id);
    res.json({ success: true, episodes });
  } catch (error) {
    logger.error('Error listing episodes:', error);
    res.status(500).json({ success: false, error: 'Failed to list episodes' });
  }
});

/**
 * GET /api/brand-stories/:id/episodes/:episodeId
 * Get a specific episode with all video URLs
 */
router.get('/:id/episodes/:episodeId', async (req, res) => {
  try {
    const episode = await getBrandStoryEpisodeById(req.params.episodeId, req.user.id);
    if (!episode || episode.story_id !== req.params.id) {
      return res.status(404).json({ success: false, error: 'Episode not found' });
    }
    res.json({ success: true, episode });
  } catch (error) {
    logger.error('Error getting episode:', error);
    res.status(500).json({ success: false, error: 'Failed to get episode' });
  }
});

/**
 * DELETE /api/brand-stories/:id/episodes/:episodeId
 * Delete a single episode.
 */
router.delete('/:id/episodes/:episodeId', csrfProtection, async (req, res) => {
  try {
    const episode = await getBrandStoryEpisodeById(req.params.episodeId, req.user.id);
    if (!episode || episode.story_id !== req.params.id) {
      return res.status(404).json({ success: false, error: 'Episode not found' });
    }

    const { supabaseAdmin } = await import('../services/supabase.js');
    const { error } = await supabaseAdmin
      .from('brand_story_episodes')
      .delete()
      .eq('id', req.params.episodeId)
      .eq('user_id', req.user.id);

    if (error) {
      logger.error('Error deleting episode:', error);
      return res.status(500).json({ success: false, error: 'Failed to delete episode' });
    }

    // Update total_episodes count on the story to stay in sync
    const remainingEpisodes = await getBrandStoryEpisodes(req.params.id, req.user.id);
    await updateBrandStory(req.params.id, req.user.id, {
      total_episodes: remainingEpisodes.length
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting episode:', error);
    res.status(500).json({ success: false, error: 'Failed to delete episode' });
  }
});

// ============================================================
// STORY ACTIVATION / PAUSE
// ============================================================

/**
 * POST /api/brand-stories/:id/activate
 * Activate automated publishing for a story.
 * Creates an agent in the agents table with contentSource='brand_story'.
 */
router.post('/:id/activate', csrfProtection, async (req, res) => {
  try {
    const story = await getBrandStoryById(req.params.id, req.user.id);
    if (!story) {
      return res.status(404).json({ success: false, error: 'Story not found' });
    }
    if (!story.storyline) {
      return res.status(400).json({ success: false, error: 'Generate a storyline before activating' });
    }

    // Create or reactivate the linked agent
    let agentId = story.agent_id;

    if (agentId) {
      // Reactivate existing agent
      await updateAgent(agentId, { status: 'active' });
    } else {
      // Create a new agent for this story.
      // Find the first target_platform the user has a live connection for.
      const targets = story.target_platforms || [];
      if (targets.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'No target platforms configured for this story'
        });
      }

      let connection = null;
      let targetPlatform = null;
      for (const platform of targets) {
        const conn = await getConnection(req.user.id, platform);
        if (conn && conn.status === 'active') {
          connection = conn;
          targetPlatform = platform;
          break;
        }
      }

      if (!connection) {
        return res.status(400).json({
          success: false,
          error: `You must connect at least one of these platforms first: ${targets.join(', ')}. Go to the Connections tab to link your social account.`
        });
      }

      const agent = await createAgent({
        userId: req.user.id,
        connectionId: connection.id,
        name: `Brand Story: ${story.name}`,
        platform: targetPlatform,
        settings: {
          contentSource: 'brand_story',
          brandStoryId: story.id,
          schedule: {
            postsPerDay: 1,
            startTime: '10:00',
            endTime: '22:00'
          }
        }
      });
      agentId = agent.id;
    }

    const updated = await updateBrandStory(req.params.id, req.user.id, {
      status: 'active',
      agent_id: agentId
    });

    res.json({ success: true, story: updated });
  } catch (error) {
    logger.error('Error activating brand story:', error);
    res.status(500).json({ success: false, error: 'Failed to activate brand story' });
  }
});

/**
 * POST /api/brand-stories/:id/pause
 * Pause automated publishing for a story.
 */
router.post('/:id/pause', csrfProtection, async (req, res) => {
  try {
    const story = await getBrandStoryById(req.params.id, req.user.id);
    if (!story) {
      return res.status(404).json({ success: false, error: 'Story not found' });
    }

    // Pause the linked agent
    if (story.agent_id) {
      await updateAgent(story.agent_id, { status: 'paused' });
    }

    const updated = await updateBrandStory(req.params.id, req.user.id, { status: 'paused' });
    res.json({ success: true, story: updated });
  } catch (error) {
    logger.error('Error pausing brand story:', error);
    res.status(500).json({ success: false, error: 'Failed to pause brand story' });
  }
});

// ============================================================
// HEYGEN AVATAR MANAGEMENT
// ============================================================

/**
 * POST /api/brand-stories/:id/setup-avatar
 * Set up the HeyGen avatar for a story (train Photo Avatar Group if needed)
 */
router.post('/:id/setup-avatar', csrfProtection, async (req, res) => {
  try {
    const story = await brandStoryService.setupAvatar(req.params.id, req.user.id);
    res.json({ success: true, story });
  } catch (error) {
    logger.error('Error setting up avatar:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to set up avatar' });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// V4 ROUTES — Director's Panel + SSE + beat-level controls
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /api/brand-stories/:id/episodes/:episodeId/stream
 * SSE endpoint — streams V4 pipeline progress events to the Director's Panel.
 *
 * The client opens an EventSource and receives events as they fire from
 * BrandStoryService.runV4Pipeline (via ProgressEmitter). Replays history on
 * connect so late subscribers catch up to current state.
 *
 * Event format:
 *   data: {"ts": 1712345678901, "episode_id": "...", "stage": "beats", "detail": "beat b1 generated", "beat_id": "b1"}
 *
 * Stream closes automatically 60s after the episode reaches 'complete' or 'failed'.
 */
router.get('/:id/episodes/:episodeId/stream', async (req, res) => {
  try {
    // Validate the user owns this episode before opening the stream
    const episode = await getBrandStoryEpisodeById(req.params.episodeId, req.user.id);
    if (!episode) {
      return res.status(404).json({ success: false, error: 'Episode not found' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx proxy buffering
    res.flushHeaders();

    // Send an initial comment to keep some proxies from closing the stream
    res.write(': v4-progress-stream\n\n');

    const emitter = getProgressEmitter(req.params.episodeId);
    if (!emitter) {
      // No active pipeline for this episode — send the current DB state once
      // and close. Useful when the user opens the panel for an already-completed
      // episode.
      res.write(`data: ${JSON.stringify({
        episode_id: req.params.episodeId,
        stage: episode.status === 'ready' || episode.status === 'published' ? 'complete' : episode.status,
        detail: 'no active pipeline; sending DB snapshot',
        snapshot: {
          status: episode.status,
          final_video_url: episode.final_video_url,
          subtitle_url: episode.subtitle_url,
          error_message: episode.error_message
        }
      })}\n\n`);
      res.write('event: done\ndata: {}\n\n');
      res.end();
      return;
    }

    // Subscribe and forward events
    const unsubscribe = emitter.subscribe((event) => {
      try {
        if (event.stage === '__terminal__') {
          res.write('event: done\ndata: {}\n\n');
          res.end();
          return;
        }
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch (writeErr) {
        logger.warn(`SSE write failed for episode ${req.params.episodeId}: ${writeErr.message}`);
      }
    });

    // Heartbeat every 25s so proxies don't kill the connection during quiet stretches
    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch {}
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  } catch (error) {
    logger.error('Error in V4 SSE stream:', error);
    res.status(500).end();
  }
});

/**
 * POST /api/brand-stories/:id/episodes/:episodeId/beats/:beatId/regenerate
 * Regenerate a single beat without touching the rest of the episode.
 *
 * Delegates to brandStoryService.regenerateBeatInEpisode() which:
 *   1. Loads the existing episode + scene_description (NO fresh Gemini call)
 *   2. Runs the target beat through BeatRouter with optional field overrides
 *   3. Downloads the other beats' existing generated_video_urls and reuses them
 *   4. Re-runs full post-production (assembly + LUT + music + overlays)
 *   5. Updates the SAME episode row's final_video_url (no duplicate INSERT)
 *
 * Replaced the Phase 1b stub that invoked runV4Pipeline() and hit a
 * duplicate-key error on brand_story_episodes_story_id_episode_number_key
 * because the source episode was no longer in `ready` status when the full
 * pipeline tried to compute `episode_number = previousReady.length + 1`.
 */
router.post('/:id/episodes/:episodeId/beats/:beatId/regenerate', v4RegenerateLimiter, csrfProtection, async (req, res) => {
  try {
    const episode = await getBrandStoryEpisodeById(req.params.episodeId, req.user.id);
    if (!episode) return res.status(404).json({ success: false, error: 'Episode not found' });

    // Validate the beat exists before kicking off the async job so the user
    // gets a 404 instead of an opaque SSE error 30s later.
    const sceneGraph = episode.scene_description || {};
    let foundBeat = null;
    for (const scene of (sceneGraph.scenes || [])) {
      for (const beat of (scene.beats || [])) {
        if (beat.beat_id === req.params.beatId) {
          foundBeat = beat;
          break;
        }
      }
      if (foundBeat) break;
    }
    if (!foundBeat) {
      return res.status(404).json({ success: false, error: `Beat ${req.params.beatId} not found in episode` });
    }

    // Return 202 immediately — the actual work runs in the background and
    // streams progress via the SSE endpoint at
    //   GET /api/brand-stories/:id/episodes/:episodeId/stream
    res.status(202).json({ success: true, beat_id: req.params.beatId, message: 'Beat regeneration started' });

    brandStoryService.regenerateBeatInEpisode(
      req.params.id,
      req.user.id,
      req.params.episodeId,
      req.params.beatId,
      req.body || {}
    ).catch(err => {
      logger.error(`V4 beat regenerate failed: ${err.message}`);
      // Mark the episode as failed so the UI shows a red state instead of
      // hanging on 'regenerating_beat' forever.
      updateBrandStoryEpisode(req.params.episodeId, req.user.id, {
        status: 'failed',
        error_message: `Beat regeneration failed: ${err.message}`
      }).catch(() => {});
    });
  } catch (error) {
    logger.error('Error regenerating beat:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to regenerate beat' });
  }
});

/**
 * PATCH /api/brand-stories/:id/episodes/:episodeId/beats/:beatId
 * Update a beat's editable fields without regenerating.
 * The user clicks "Save edits" then separately clicks "Regenerate" if needed.
 */
router.patch('/:id/episodes/:episodeId/beats/:beatId', v4PatchLimiter, csrfProtection, async (req, res) => {
  try {
    const episode = await getBrandStoryEpisodeById(req.params.episodeId, req.user.id);
    if (!episode) return res.status(404).json({ success: false, error: 'Episode not found' });

    const sceneGraph = episode.scene_description || {};
    let foundBeat = null;
    for (const scene of (sceneGraph.scenes || [])) {
      for (const beat of (scene.beats || [])) {
        if (beat.beat_id === req.params.beatId) {
          foundBeat = beat;
          break;
        }
      }
      if (foundBeat) break;
    }
    if (!foundBeat) return res.status(404).json({ success: false, error: 'Beat not found' });

    const allowedFields = ['dialogue', 'expression_notes', 'action_prompt', 'lens', 'emotion', 'duration_seconds', 'subject_focus', 'lighting_intent', 'camera_move', 'ambient_sound', 'voiceover_text', 'model_override'];
    let edited = false;
    for (const key of allowedFields) {
      if (req.body[key] !== undefined) {
        foundBeat[key] = req.body[key];
        edited = true;
      }
    }

    if (edited) {
      await updateBrandStoryEpisode(req.params.episodeId, req.user.id, {
        scene_description: sceneGraph
      });
    }

    res.json({ success: true, beat: foundBeat, edited });
  } catch (error) {
    logger.error('Error patching beat:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to patch beat' });
  }
});

/**
 * DELETE /api/brand-stories/:id/episodes/:episodeId/beats/:beatId
 * Remove a beat from a scene. Power-user editing.
 */
router.delete('/:id/episodes/:episodeId/beats/:beatId', v4DeleteLimiter, csrfProtection, async (req, res) => {
  try {
    const episode = await getBrandStoryEpisodeById(req.params.episodeId, req.user.id);
    if (!episode) return res.status(404).json({ success: false, error: 'Episode not found' });

    const sceneGraph = episode.scene_description || {};
    let removed = false;
    for (const scene of (sceneGraph.scenes || [])) {
      const beforeLen = (scene.beats || []).length;
      scene.beats = (scene.beats || []).filter(b => b.beat_id !== req.params.beatId);
      if (scene.beats.length < beforeLen) {
        removed = true;
        break;
      }
    }

    if (!removed) return res.status(404).json({ success: false, error: 'Beat not found' });

    await updateBrandStoryEpisode(req.params.episodeId, req.user.id, {
      scene_description: sceneGraph
    });

    res.json({ success: true, beat_id: req.params.beatId });
  } catch (error) {
    logger.error('Error deleting beat:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to delete beat' });
  }
});

/**
 * POST /api/brand-stories/:id/episodes/:episodeId/reassemble
 * Re-run post-production (assembly + LUT + music + SFX + cards + subtitles)
 * WITHOUT regenerating any beats and WITHOUT calling Gemini/Seedream/Veo/Kling.
 *
 * Use cases:
 *   - A post-production stage had a transient upstream failure (e.g. fal.ai
 *     SFX 400, libass missing) and you've fixed the cause — retry at $0 cost.
 *   - User edited the episode's LUT in the Director's Panel.
 *   - New correction/creative .cube files were dropped onto disk.
 *
 * Delegates to brandStoryService.reassembleEpisode() which:
 *   1. Downloads every beat's existing generated_video_url
 *   2. Reuses the cached music_bed_url (or regenerates if missing)
 *   3. Re-runs the full post-production pipeline
 *   4. Updates the SAME episode row's final_video_url (no INSERT)
 *
 * Replaces the Phase 1b stub that invoked runV4Pipeline() and hit a
 * duplicate-key error on brand_story_episodes_story_id_episode_number_key.
 */
router.post('/:id/episodes/:episodeId/reassemble', v4ReassembleLimiter, csrfProtection, async (req, res) => {
  try {
    const episode = await getBrandStoryEpisodeById(req.params.episodeId, req.user.id);
    if (!episode) return res.status(404).json({ success: false, error: 'Episode not found' });

    // Return 202 immediately — the reassembly runs in the background and
    // streams progress via GET /api/brand-stories/:id/episodes/:episodeId/stream
    res.status(202).json({ success: true, message: 'Reassembly started' });

    brandStoryService.reassembleEpisode(
      req.params.id,
      req.user.id,
      req.params.episodeId
    ).catch(err => {
      logger.error(`V4 reassemble failed: ${err.message}`);
      // Mark the episode as failed so the UI doesn't hang on 'regenerating_beat'
      updateBrandStoryEpisode(req.params.episodeId, req.user.id, {
        status: 'failed',
        error_message: `Reassembly failed: ${err.message}`
      }).catch(() => {});
    });
  } catch (error) {
    logger.error('Error reassembling episode:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to reassemble' });
  }
});

/**
 * GET /api/brand-stories/personas/voice-library
 * Return the curated ElevenLabs preset voice library for the Director's Panel
 * persona override picker.
 */
router.get('/personas/voice-library', async (req, res) => {
  try {
    const voices = getVoiceLibrary();
    res.json({ success: true, voices });
  } catch (error) {
    logger.error('Error fetching voice library:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch voice library' });
  }
});

/**
 * PATCH /api/brand-stories/:id/personas/:personaIndex/voice
 * Override the ElevenLabs voice_id for a persona. The Director's Panel calls
 * this when the user picks a different voice from the library.
 */
router.patch('/:id/personas/:personaIndex/voice', csrfProtection, async (req, res) => {
  try {
    const story = await getBrandStoryById(req.params.id, req.user.id);
    if (!story) return res.status(404).json({ success: false, error: 'Story not found' });

    const idx = parseInt(req.params.personaIndex, 10);
    const personas = Array.isArray(story.persona_config?.personas)
      ? story.persona_config.personas
      : [story.persona_config];

    if (!personas[idx]) {
      return res.status(404).json({ success: false, error: `Persona ${idx} not found` });
    }

    const { voice_id, voice_name } = req.body;
    if (!voice_id) return res.status(400).json({ success: false, error: 'voice_id required' });

    personas[idx].elevenlabs_voice_id = voice_id;
    if (voice_name) personas[idx].elevenlabs_voice_name = voice_name;
    personas[idx].elevenlabs_voice_brief = `User-overridden voice (${voice_name || voice_id})`;
    personas[idx].elevenlabs_voice_justification = 'Manually selected via Director\'s Panel';
    // Invalidate any prior Kling clone — the user may want a fresh clone next gen
    personas[idx].kling_voice_id = null;

    await updateBrandStory(req.params.id, req.user.id, {
      persona_config: { ...(story.persona_config || {}), personas }
    });

    res.json({ success: true, persona: personas[idx] });
  } catch (error) {
    logger.error('Error overriding persona voice:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to override voice' });
  }
});

/**
 * PATCH /api/brand-stories/:id/lut
 * Lock or clear a story-level LUT override.
 * Body: { locked_lut_id: "bs_warm_cinematic" } or { locked_lut_id: null }
 */
router.patch('/:id/lut', csrfProtection, async (req, res) => {
  try {
    const story = await getBrandStoryById(req.params.id, req.user.id);
    if (!story) return res.status(404).json({ success: false, error: 'Story not found' });

    const { locked_lut_id } = req.body;
    await updateBrandStory(req.params.id, req.user.id, { locked_lut_id: locked_lut_id || null });

    res.json({
      success: true,
      locked_lut_id: locked_lut_id || null,
      // Show the user what the resolved LUT would be on the next episode
      resolved_lut: resolveEpisodeLut({ ...story, locked_lut_id }, {})
    });
  } catch (error) {
    logger.error('Error setting LUT lock:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to set LUT lock' });
  }
});

export default router;
