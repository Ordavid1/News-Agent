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

// All brand story routes require authentication
router.use(authenticateToken);

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

    if (!['described', 'selected', 'uploaded', 'brand_kit'].includes(persona_type)) {
      return res.status(400).json({
        success: false,
        error: 'persona_type must be described, selected, uploaded, or brand_kit'
      });
    }

    // Enforce focus↔persona_type mapping — prevents invalid combinations.
    const allowedByFocus = {
      person:    ['uploaded', 'brand_kit'],
      product:   ['selected'],
      landscape: ['selected']
    };
    if (!allowedByFocus[story_focus].includes(persona_type)) {
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

export default router;
