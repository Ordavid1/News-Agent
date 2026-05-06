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
import { isBlockerOrCritical } from '../services/v4/severity.mjs';
import { getVoiceLibrary, inferPersonaGender } from '../services/v4/VoiceAcquisition.js';
import { resolveEpisodeLut } from '../services/v4/BrandKitLutMatcher.js';
// V4 Tier 1 (2026-05-06) — Beat Lifecycle. Used by PATCH /beats/:beatId to
// (a) accept `status` mutations under optimistic-concurrency control via
// If-Match header, (b) implement the user-approve = promote-from-quarantine
// contract that restores the most-recently-quarantined clip onto the
// canonical beat row.
import {
  BEAT_STATUS,
  BeatLifecycleError,
  promoteFromQuarantine,
  ensureLifecycleFields
} from '../services/v4/BeatLifecycle.js';
import {
  resolveBibleForStory,
  validateBible,
  mergeBibleDefaults,
  DEFAULT_SONIC_SERIES_BIBLE
} from '../services/v4/SonicSeriesBible.js';
import {
  resolveCastBibleForStory,
  validateCastBible,
  mergeCastBibleDefaults,
  DEFAULT_CAST_BIBLE
} from '../services/v4/CastBible.js';
import { extractPersonaVisualAnchor } from '../services/v4/PersonaVisualAnchor.js';
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

    // V4 Phase 5b — pre-flight persona-completeness validation. Every persona
    // must have EITHER (name AND a non-empty description) OR (reference photos
    // for visual_anchor extraction). The placeholder fallbacks at
    // brandStoryPrompts.mjs:303-305 were removed (subtractive change), so a
    // persona with neither path will produce DESCRIPTION_MISSING and break the
    // storyline. Catch it here with a structured error rather than letting the
    // pipeline burn for a minute and crash.
    const personasForValidation = Array.isArray(story.persona_config?.personas)
      ? story.persona_config.personas
      : (story.persona_config ? [story.persona_config] : []);
    const incompletePersonas = [];
    personasForValidation.forEach((p, idx) => {
      const hasDescription = (p?.description && String(p.description).trim().length > 0)
        || (p?.appearance && String(p.appearance).trim().length > 0);
      const hasPhotos = Array.isArray(p?.reference_image_urls) && p.reference_image_urls.filter(Boolean).length > 0;
      const hasAnchor = !!p?.visual_anchor?.apparent_gender_presentation;
      if (!hasDescription && !hasPhotos && !hasAnchor) {
        incompletePersonas.push({ index: idx, name: p?.name || `Persona ${idx + 1}` });
      }
    });
    if (incompletePersonas.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'persona_incomplete',
        message: `Persona(s) missing identity input. Each persona needs either a description OR uploaded reference photos.`,
        incomplete_personas: incompletePersonas
      });
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

    // V4 Tier 1 (2026-05-06) — backfill lifecycle fields on legacy beats so
    // version + status checks below have something to compare against.
    ensureLifecycleFields(foundBeat);

    // V4 Tier 1 (2026-05-06) — optimistic concurrency. The Director Panel
    // and the orchestrator can race on the same beat row (user clicks Save
    // while a regenerate is in flight). If the client provides `If-Match:
    // <version>`, we reject with 409 when the on-server version has moved
    // — protecting against lost updates. Header is OPTIONAL for legacy
    // clients that haven't been updated; when absent, we fall through to
    // the legacy last-write-wins behavior.
    const ifMatchRaw = req.get('If-Match');
    if (ifMatchRaw !== undefined && ifMatchRaw !== null && ifMatchRaw !== '') {
      const expectedVersion = Number.parseInt(ifMatchRaw, 10);
      if (!Number.isFinite(expectedVersion)) {
        return res.status(400).json({ success: false, error: 'If-Match header must be an integer (beat.version)' });
      }
      if (foundBeat.version !== expectedVersion) {
        return res.status(409).json({
          success: false,
          error: 'beat version mismatch — refresh and retry',
          expected: expectedVersion,
          current: foundBeat.version
        });
      }
    }

    const allowedFields = [
      'dialogue', 'expression_notes', 'action_prompt', 'lens', 'emotion',
      'duration_seconds', 'subject_focus', 'lighting_intent', 'camera_move',
      'ambient_sound', 'voiceover_text', 'model_override',
      // V4 Phase 1.1 / 2 / 3.2 / 5.3 / 7 — new editable fields from the
      // expanded Director Panel. All are schema-validated by the generators,
      // so accepting them here is safe.
      'framing',               // cinematic vocabulary (Phase 3.2)
      'preferred_generator',   // per-beat model override (Phase 5.3)
      'subject_present',       // subject mandate toggle (Phase 1.1)
      'location_hero',         // location bible reuse flag
      'personas_present',      // persona_index array override (Phase 2)
      'narrative_purpose',     // screenplay field promoted to editable
      'subtext',               // subtext field promoted to editable
      'last_frame_hint_url'    // Phase 2.3 — INSERT_SHOT end-state anchor
    ];
    let edited = false;
    for (const key of allowedFields) {
      if (req.body[key] !== undefined) {
        foundBeat[key] = req.body[key];
        edited = true;
      }
    }

    // V4 Tier 1 (2026-05-06) — status mutation. The Director Panel's
    // "Approve" button on the awaiting_user_review modal POSTs
    //   PATCH .../beats/:beatId  body: { status: 'ready' }
    // When the current status is `hard_rejected`, this is the
    // promote-from-quarantine path: restore the most recent quarantined
    // clip onto the canonical row, set status='ready'. Other status
    // transitions are intentionally NOT exposed to the route — the
    // orchestrator owns generation states; the user only owns approve.
    let promotedFromQuarantine = false;
    if (typeof req.body.status === 'string') {
      const desired = req.body.status;
      if (desired === BEAT_STATUS.READY && foundBeat.status === BEAT_STATUS.HARD_REJECTED) {
        try {
          promoteFromQuarantine(foundBeat);
          promotedFromQuarantine = true;
          edited = true;
        } catch (err) {
          if (err instanceof BeatLifecycleError && err.code === 'no_restorable_attempt') {
            return res.status(409).json({
              success: false,
              error: 'No quarantined clip to restore — trigger /regenerate to produce a new attempt',
              code: err.code
            });
          }
          throw err;
        }
      } else if (desired !== foundBeat.status) {
        return res.status(400).json({
          success: false,
          error: `unsupported status transition '${foundBeat.status}' → '${desired}' via PATCH — use /regenerate or /reassemble`
        });
      }
    }

    if (edited) {
      await updateBrandStoryEpisode(req.params.episodeId, req.user.id, {
        scene_description: sceneGraph
      });
    }

    res.json({ success: true, beat: foundBeat, edited, promotedFromQuarantine });
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
 * POST /api/brand-stories/:id/episodes/:episodeId/enhance/aleph
 *
 * 2026-05-05 — Aleph Rec 2 Phase 3.
 *
 * Opt-in commercial-only post-completion stylization via Runway gen4_aleph.
 * The user clicks "✨ Enhance with Aleph" in the Director Panel after a
 * commercial episode finishes; this endpoint:
 *
 *   1. Validates the episode is commercial (genre/commercial_brief check)
 *   2. Validates post_lut_intermediate_url exists (set during runV4Pipeline)
 *   3. Validates not already enhanced (idempotent — UI shows toggle, not button)
 *   4. Validates billing entitlement (when BRAND_STORY_ALEPH_BILLING_ENABLED=true;
 *      no-op during free testing phase)
 *   5. Returns 202 + spawns AlephEnhancementOrchestrator in background
 *   6. Progress streams via existing SSE at /episodes/:episodeId/stream
 *
 * Architecture (Option B — Director Agent A2.1 amendment):
 *   - Operates on post-LUT intermediate (graded video, NO music/cards/subs yet)
 *   - Chunks into ≤8s segments with shared style prompt + reference image
 *   - Identity hard gate (A2.2): pass at 85+, fail discards Aleph output
 *   - Re-runs Stages 4-6 (music/cards/subs) on stylized output
 *   - Saves as aleph_enhanced_video_url (sibling to final_video_url)
 *
 * Cost: ~$0.15/sec output × 60s commercial = ~$9 per enhancement (chunked).
 * During free testing phase, no charge regardless of pass/fail. When billing
 * enabled, identity-gate failure → automatic refund.
 */
router.post('/:id/episodes/:episodeId/enhance/aleph', v4ReassembleLimiter, csrfProtection, async (req, res) => {
  try {
    const episode = await getBrandStoryEpisodeById(req.params.episodeId, req.user.id);
    if (!episode) return res.status(404).json({ success: false, error: 'Episode not found' });

    // Eligibility gates (HTTP-layer — orchestrator-level checks happen too)
    if (episode.status !== 'ready') {
      return res.status(400).json({
        success: false,
        error: `Episode is ${episode.status}, not ready. Aleph enhancement only available on completed episodes.`
      });
    }
    if (!episode.post_lut_intermediate_url) {
      return res.status(400).json({
        success: false,
        error: 'Episode has no post-LUT intermediate. Regenerate the episode (commercial briefs only) to enable Aleph enhancement.'
      });
    }
    if (episode.aleph_enhanced_video_url) {
      return res.status(409).json({
        success: false,
        error: 'Episode already enhanced. The Director Panel toggle switches between original and enhanced views.',
        aleph_enhanced_video_url: episode.aleph_enhanced_video_url
      });
    }

    // Billing entitlement (deferred — disabled by default during testing).
    // When BRAND_STORY_ALEPH_BILLING_ENABLED=true, check user.subscription
    // for aleph_credits or pass-through Lemon Squeezy / Paddle SKU.
    if (process.env.BRAND_STORY_ALEPH_BILLING_ENABLED === 'true') {
      const hasEntitlement = req.user?.subscription?.aleph_credits > 0
        || req.user?.subscription?.tier === 'enterprise';
      if (!hasEntitlement) {
        return res.status(403).json({
          success: false,
          error: 'Aleph enhancement requires Enterprise tier or Aleph credits. Current testing phase does not require entitlement — set BRAND_STORY_ALEPH_BILLING_ENABLED=false to enable free pilots.'
        });
      }
    }

    // Return 202 immediately — orchestrator runs in background, streams via SSE.
    res.status(202).json({
      success: true,
      message: 'Aleph enhancement started. Subscribe to /episodes/:episodeId/stream for progress.',
      episodeId: req.params.episodeId,
      estimatedCostUsd: process.env.BRAND_STORY_ALEPH_BILLING_ENABLED === 'true'
        ? 12.0 // flat surcharge ($10.80 cost + buffer)
        : 0,   // free during testing
      billingMode: process.env.BRAND_STORY_ALEPH_BILLING_ENABLED === 'true' ? 'charged' : 'free_pilot'
    });

    // Async kickoff — failures logged + persisted to aleph_job_metadata so UI
    // can surface the failure mode without polling for an HTTP response that
    // never comes.
    brandStoryService.runAlephEnhancement(
      req.params.id,
      req.user.id,
      req.params.episodeId,
      { strength: typeof req.body?.strength === 'number' ? req.body.strength : 0.20 }
    ).catch(err => {
      logger.error(`Aleph enhancement failed: ${err.message}`);
      updateBrandStoryEpisode(req.params.episodeId, req.user.id, {
        aleph_job_metadata: {
          status: 'failed_aleph_error',
          error_message: err.message,
          completed_at: new Date().toISOString()
        }
      }).catch(() => {});
    });
  } catch (error) {
    logger.error('Error starting Aleph enhancement:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to start Aleph enhancement' });
  }
});

/**
 * POST /api/brand-stories/:id/episodes/:episodeId/director-review
 *
 * V4 P0.5 — Director Review Resolution Layer.
 *
 * Resolves a Director-Agent BLOCKING-MODE halt that landed the episode in
 * `awaiting_user_review`. The user provides one of three actions:
 *
 *   • approve         — clear halt at face value (only meaningful at Lens D
 *                       when final_video_url exists)
 *   • edit_and_retry  — capture user notes/edits for a future resume; flips
 *                       status to 'failed' so user can re-trigger generation
 *   • discard         — mark episode 'failed' with user reason
 *
 * Body schema:
 *   {
 *     action: 'approve' | 'edit_and_retry' | 'discard' (required),
 *     notes?: string,           // user remediation note
 *     edited_anchor?: string,   // Lens B halts only — anchor override
 *     edited_dialogue?: string  // Lens C halts only — dialogue override
 *   }
 *
 * Auth: requires authenticated session + CSRF + ownership of the episode.
 * Telemetry: every resolution writes a row to `director_halt_resolutions`.
 */
router.post('/:id/episodes/:episodeId/director-review', csrfProtection, async (req, res) => {
  try {
    const { action, notes, edited_anchor, edited_dialogue } = req.body || {};

    if (!action || !['approve', 'edit_and_retry', 'discard'].includes(action)) {
      return res.status(400).json({
        success: false,
        error: `Invalid or missing 'action' (expected: approve | edit_and_retry | discard)`
      });
    }

    // Length guards — prevent abusive payloads from reaching downstream
    // Gemini calls (which would otherwise charge tokens for 100KB notes).
    const MAX_NOTES_LEN = 4000;
    const MAX_OVERRIDE_LEN = 4000;
    if (typeof notes === 'string' && notes.length > MAX_NOTES_LEN) {
      return res.status(400).json({ success: false, error: `notes exceeds ${MAX_NOTES_LEN} chars` });
    }
    if (typeof edited_anchor === 'string' && edited_anchor.length > MAX_OVERRIDE_LEN) {
      return res.status(400).json({ success: false, error: `edited_anchor exceeds ${MAX_OVERRIDE_LEN} chars` });
    }
    if (typeof edited_dialogue === 'string' && edited_dialogue.length > MAX_OVERRIDE_LEN) {
      return res.status(400).json({ success: false, error: `edited_dialogue exceeds ${MAX_OVERRIDE_LEN} chars` });
    }

    const result = await brandStoryService.resolveDirectorReview(
      req.params.id,
      req.user.id,
      req.params.episodeId,
      {
        action,
        notes: typeof notes === 'string' ? notes : null,
        edited_anchor: typeof edited_anchor === 'string' ? edited_anchor : null,
        edited_dialogue: typeof edited_dialogue === 'string' ? edited_dialogue : null
      }
    );
    return res.json(result);
  } catch (error) {
    const msg = error?.message || 'Failed to resolve director review';
    // Distinguish "expected" client errors (validation, not-found, wrong-state)
    // from server errors so the panel can show appropriate UX.
    const isClientError =
      msg.includes('not found') ||
      msg.includes('access denied') ||
      msg.includes('does not belong') ||
      msg.includes('not in awaiting_user_review') ||
      msg.includes('invalid action');
    const status = isClientError ? 400 : 500;
    logger.error(`director-review resolution error: ${msg}`);
    return res.status(status).json({ success: false, error: msg });
  }
});

/**
 * POST /api/brand-stories/:id/episodes/:episodeId/director-review/auto-edit
 *
 * V4 hotfix 2026-04-30 — Smart Edit & Retry. Returns a synthesized edit
 * directive built from the halt verdict's findings + the failed artifact's
 * content. Replaces the previous flow where the user had to type free-form
 * director notes (which they don't have the directing knowledge to write).
 *
 * Response:
 *   {
 *     success: true,
 *     notes: string,             // ready to feed into resolveDirectorReview as `notes`
 *     edited_anchor: string|null,
 *     edited_dialogue: string|null,
 *     source: 'rich' | 'cheap',  // 'rich' = Gemini-synthesized; 'cheap' = prompt_delta concat
 *     halt_summary: { checkpoint, artifact_id, verdict_score, finding_count }
 *   }
 *
 * Caller (Director Panel) shows the directive in a confirmation modal; user
 * clicks "Apply" to POST to /director-review with action=edit_and_retry +
 * the returned notes (and optional anchor/dialogue overrides).
 */
router.post('/:id/episodes/:episodeId/director-review/auto-edit', csrfProtection, async (req, res) => {
  try {
    const result = await brandStoryService.synthesizeDirectorReviewEdit({
      storyId: req.params.id,
      userId: req.user.id,
      episodeId: req.params.episodeId
    });

    // Surface a small summary alongside the synthesized notes so the panel
    // can render the halt context without re-fetching the episode.
    const ep = await getBrandStoryEpisodeById(req.params.episodeId, req.user.id);
    const halt = ep?.director_report?.halt || {};
    return res.json({
      success: true,
      ...result,
      halt_summary: {
        checkpoint: halt.checkpoint || null,
        artifact_id: halt.scene_id || halt.beat_id || halt.artifactKey || null,
        verdict_score: Number.isFinite(halt.verdict?.overall_score) ? halt.verdict.overall_score : null,
        verdict_kind: halt.verdict?.verdict || null,
        finding_count: Array.isArray(halt.verdict?.findings) ? halt.verdict.findings.length : 0
      }
    });
  } catch (error) {
    const msg = error?.message || 'Failed to synthesize director-review edit';
    const isClientError =
      msg.includes('not found') ||
      msg.includes('access denied') ||
      msg.includes('not in awaiting_user_review');
    const status = isClientError ? 400 : 500;
    logger.error(`director-review auto-edit error: ${msg}`);
    return res.status(status).json({ success: false, error: msg });
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

    // Cast Bible Failure Mode #3 — locked-bible REJECT contract.
    // When the cast bible is locked AND inheritance_policy.voice_assignments
    // is 'immutable_when_locked' (default), all voice changes are rejected.
    // Lock can only be undone via PATCH /cast-bible { bible: null }.
    if (story.cast_bible?.status === 'locked' &&
        (story.cast_bible.inheritance_policy?.voice_assignments || 'immutable_when_locked') === 'immutable_when_locked') {
      return res.status(409).json({
        success: false,
        error: 'Cast bible is locked — voice assignments are immutable. Clear via PATCH /cast-bible { bible: null } first to change voices.',
        conflict: { reason: 'cast_bible_locked' }
      });
    }

    const { voice_id, voice_name } = req.body;
    // Allow voice_id: null to CLEAR a voice (used by the Casting Room
    // re-acquisition confirmation dialog — Phase 4). Skip the rest of the
    // validation in that case and persist the cleared state directly.
    if (voice_id === null) {
      personas[idx].elevenlabs_voice_id = null;
      personas[idx].elevenlabs_voice_name = null;
      personas[idx].elevenlabs_voice_brief = null;
      personas[idx].elevenlabs_voice_justification = null;
      personas[idx].elevenlabs_voice_gender = null;
      personas[idx].kling_voice_id = null;
      await updateBrandStory(req.params.id, req.user.id, {
        persona_config: { ...(story.persona_config || {}), personas }
      });
      return res.json({ success: true, persona: personas[idx], cleared: true });
    }
    if (!voice_id) return res.status(400).json({ success: false, error: 'voice_id required' });

    // ─── Voice-lock validation (Phase 1 hardening — 2026-04-25) ───
    // The acquisition pipeline (acquirePersonaVoicesForStory) enforces
    // cross-persona uniqueness + gender match by construction. The manual
    // override path used to skip both checks, so a user could collide two
    // personas onto the same voice (or assign a male voice to a female
    // persona). Auto-remediation healed this on the next pipeline run, but
    // the bad state persisted in the DB and showed wrong-voice in any
    // intermediate beat regen. Now enforced at the route too.
    const library = getVoiceLibrary();
    const libraryEntry = library.find(v => v.voice_id === voice_id);
    if (!libraryEntry) {
      return res.status(400).json({
        success: false,
        error: `voice_id "${voice_id}" is not in the ElevenLabs preset library. Pick from the curated 26-voice library.`
      });
    }

    // Cross-persona uniqueness — every other persona in this story must NOT
    // already hold this voice_id.
    const collidingIdx = personas.findIndex((p, i) =>
      i !== idx && p && p.elevenlabs_voice_id === voice_id
    );
    if (collidingIdx >= 0) {
      const otherName = personas[collidingIdx]?.name || `Persona ${collidingIdx + 1}`;
      return res.status(409).json({
        success: false,
        error: `Voice "${libraryEntry.name}" is already locked to ${otherName} (persona ${collidingIdx}). Each persona in a story must have a unique voice. Either pick a different voice for this persona or first reassign ${otherName} to a different voice.`,
        conflict: { taken_by_persona_index: collidingIdx, taken_by_persona_name: otherName }
      });
    }

    // Gender enforcement — same rule the acquisition flow uses. inferPersonaGender
    // returns 'unknown' on ambiguous descriptions, in which case any voice is
    // allowed (no hard constraint).
    const inferredGender = inferPersonaGender(personas[idx]);
    if (inferredGender !== 'unknown') {
      const voiceGender = String(libraryEntry.gender || '').toLowerCase();
      if (voiceGender !== inferredGender) {
        return res.status(409).json({
          success: false,
          error: `Voice "${libraryEntry.name}" is ${voiceGender}; persona "${personas[idx].name || `Persona ${idx + 1}`}" is inferred to be ${inferredGender}. The pipeline rejects gender-mismatched voices because they break the dialogue track. Pick a ${inferredGender} voice or update the persona description if the inference is wrong.`,
          conflict: { voice_gender: voiceGender, persona_gender: inferredGender }
        });
      }
    }

    personas[idx].elevenlabs_voice_id = voice_id;
    personas[idx].elevenlabs_voice_name = voice_name || libraryEntry.name;
    personas[idx].elevenlabs_voice_gender = libraryEntry.gender;
    personas[idx].elevenlabs_voice_brief = `User-overridden voice (${voice_name || libraryEntry.name})`;
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
 * PATCH /api/brand-stories/:id/personas/:personaIndex/gender
 *
 * Set or clear an explicit gender on a persona. Used by the Casting Room
 * gender override dropdown (Phase 4) — surfaces the persistent "Persona N
 * → unknown gender → potentially wrong-gender voice pick" bug from the
 * 2026-04-28 production logs and lets the user fix it explicitly.
 *
 * Writes to persona_config.personas[idx].gender — the CANONICAL TRUTH path
 * (Failure Mode #2). cast_bible.principals[].gender_inferred is a derived
 * view re-resolved on next read.
 *
 * Body: { gender: 'male' | 'female' | 'neutral' | 'unknown' }
 *
 * Locked-bible contract (Failure Mode #3): when cast_bible.status === 'locked',
 * returns 409.
 */
router.patch('/:id/personas/:personaIndex/gender', csrfProtection, async (req, res) => {
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

    if (story.cast_bible?.status === 'locked') {
      return res.status(409).json({
        success: false,
        error: 'Cast bible is locked — clear via PATCH /cast-bible { bible: null } first to change persona gender.',
        conflict: { reason: 'cast_bible_locked' }
      });
    }

    const { gender } = req.body;
    const VALID_GENDERS = ['male', 'female', 'neutral', 'unknown'];
    if (gender !== null && (typeof gender !== 'string' || !VALID_GENDERS.includes(gender.toLowerCase()))) {
      return res.status(400).json({
        success: false,
        error: `gender must be one of ${VALID_GENDERS.join(', ')} or null. Got: ${JSON.stringify(gender)}`
      });
    }

    personas[idx].gender = gender ? gender.toLowerCase() : null;

    await updateBrandStory(req.params.id, req.user.id, {
      persona_config: { ...(story.persona_config || {}), personas }
    });

    res.json({ success: true, persona: personas[idx] });
  } catch (error) {
    logger.error('Error setting persona gender:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to set persona gender' });
  }
});

/**
 * POST /api/brand-stories/:id/personas/:personaIndex/re-extract-visual-anchor
 *
 * V4 Phase 5b — manually trigger PersonaVisualAnchor extraction for a
 * persona. Used to backfill existing thin-persona stories (e.g. story
 * `77d6eaaf` "Sydney+macbook3" 2026-04-28) and to re-extract after the
 * user uploads new reference photos.
 *
 * Body (optional): {} — extraction reads persona.reference_image_urls.
 *
 * Response: { success: true, visual_anchor: {...} } | error
 */
router.post('/:id/personas/:personaIndex/re-extract-visual-anchor', csrfProtection, async (req, res) => {
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

    const photos = Array.isArray(personas[idx].reference_image_urls)
      ? personas[idx].reference_image_urls.filter(Boolean)
      : [];
    if (photos.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'persona has no reference_image_urls; upload photos first via POST /personas/upload'
      });
    }

    const isAuto = personas[idx].persona_type === 'brand_kit_auto' || personas[idx].is_auto_generated;
    const source = isAuto ? 'sheet_vision' : 'upload_vision';
    const anchor = await extractPersonaVisualAnchor({
      photoUrls: photos,
      persona: personas[idx],
      source,
      // Pass null so the cache check doesn't short-circuit a manual re-extract.
      existingAnchor: null
    });
    personas[idx].visual_anchor = anchor;

    await updateBrandStory(req.params.id, req.user.id, {
      persona_config: { ...(story.persona_config || {}), personas }
    });

    return res.json({ success: true, visual_anchor: anchor });
  } catch (error) {
    logger.error('Error re-extracting visual anchor:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to extract visual anchor' });
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

/**
 * GET /api/brand-stories/:id/sonic-series-bible
 * Read the story's sonic series bible. Returns the safe-default bible if
 * none has been authored yet (so the Director Panel can always render
 * something — null indicates "not yet generated").
 *
 * Response:
 *   {
 *     success: true,
 *     authored: boolean,                  // true if Gemini-authored, false if default
 *     bible: <SonicSeriesBible>,
 *     default: <DEFAULT_SONIC_SERIES_BIBLE>  // for Director Panel diff display
 *   }
 */
router.get('/:id/sonic-series-bible', async (req, res) => {
  try {
    const story = await getBrandStoryById(req.params.id, req.user.id);
    if (!story) return res.status(404).json({ success: false, error: 'Story not found' });

    const authored = !!story.sonic_series_bible;
    const bible = authored
      ? resolveBibleForStory(story)
      : { ...DEFAULT_SONIC_SERIES_BIBLE };

    res.json({
      success: true,
      authored,
      bible,
      default: { ...DEFAULT_SONIC_SERIES_BIBLE }
    });
  } catch (error) {
    logger.error('Error reading sonic_series_bible:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to read bible' });
  }
});

/**
 * PATCH /api/brand-stories/:id/sonic-series-bible
 * Override the story's sonic series bible.
 *
 * Body shape (any of these forms):
 *   { bible: <full bible object> }   — replace the whole bible
 *   { bible: null }                  — clear the override (regenerate on next episode)
 *
 * Validation:
 *   The body bible runs through validateBible() — blocker-severity issues
 *   reject the PATCH with 422; warning-severity issues are accepted but
 *   surfaced in the response so the Director Panel can flag them.
 */
router.patch('/:id/sonic-series-bible', csrfProtection, async (req, res) => {
  try {
    const story = await getBrandStoryById(req.params.id, req.user.id);
    if (!story) return res.status(404).json({ success: false, error: 'Story not found' });

    const { bible } = req.body;

    // Clear-the-override path: bible=null → next runV4Pipeline will regenerate
    if (bible === null) {
      await updateBrandStory(req.params.id, req.user.id, { sonic_series_bible: null });
      return res.json({
        success: true,
        cleared: true,
        next_episode_will_regenerate: true
      });
    }

    if (!bible || typeof bible !== 'object') {
      return res.status(400).json({ success: false, error: 'Body must be { bible: <object> } or { bible: null }' });
    }

    // Merge defaults so partial overrides are valid (e.g. user only changes
    // prohibited_instruments — the rest of the bible stays canonical).
    const merged = mergeBibleDefaults(bible);
    const issues = validateBible(merged);
    const blockers = issues.filter(i => isBlockerOrCritical(i.severity));

    if (blockers.length > 0) {
      return res.status(422).json({
        success: false,
        error: 'bible failed validation',
        blockers,
        warnings: issues.filter(i => i.severity === 'warning')
      });
    }

    // Annotate provenance so the Director Panel can show "manually overridden"
    merged._generated_by = 'manual_override';

    await updateBrandStory(req.params.id, req.user.id, { sonic_series_bible: merged });

    res.json({
      success: true,
      bible: merged,
      warnings: issues
    });
  } catch (error) {
    logger.error('Error overriding sonic_series_bible:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to override bible' });
  }
});

/**
 * GET /api/brand-stories/:id/cast-bible
 *
 * Read the story's cast bible. Always returns something:
 *   - If a bible exists, runs it through resolveCastBibleForStory which
 *     re-resolves voice fields from persona_config (canonical-truth contract,
 *     Failure Mode #2) and recomputes voice_gender_match per principal.
 *   - If no bible, returns DEFAULT_CAST_BIBLE (empty principals — Director
 *     Panel renders "not yet derived" placeholder).
 *
 * Response:
 *   {
 *     success: true,
 *     authored: boolean,                  // true if story.cast_bible exists
 *     bible: <CastBible>,                  // resolved (voice fields re-synced)
 *     default: <DEFAULT_CAST_BIBLE>        // for Director Panel diff display
 *   }
 */
router.get('/:id/cast-bible', async (req, res) => {
  try {
    const story = await getBrandStoryById(req.params.id, req.user.id);
    if (!story) return res.status(404).json({ success: false, error: 'Story not found' });

    const authored = !!story.cast_bible;
    const bible = resolveCastBibleForStory(story);

    res.json({
      success: true,
      authored,
      bible,
      default: { ...DEFAULT_CAST_BIBLE, principals: [], guest_pool: [] }
    });
  } catch (error) {
    logger.error('Error reading cast_bible:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to read cast bible' });
  }
});

/**
 * PATCH /api/brand-stories/:id/cast-bible
 *
 * Override the story's cast bible.
 *
 * Body shape (any of):
 *   { bible: <full or partial bible> }   — replace bible (subject to validation
 *                                           and locked-bible contract)
 *   { bible: null }                       — clear override; next runV4Pipeline
 *                                           re-derives from storyline+personas
 *
 * INVARIANTS (Cast Bible plan):
 *   - Voice IDs (Failure Mode #2) — REJECT changes to principals[].elevenlabs_voice_id.
 *     Voice IDs are owned by persona_config; use PATCH /personas/:idx/voice.
 *   - Locked bible (Failure Mode #3) — when status === 'locked' on the STORED
 *     bible, REJECT all structural mutations except setting bible: null.
 *     Lock can only be undone via { bible: null }.
 */
router.patch('/:id/cast-bible', csrfProtection, async (req, res) => {
  try {
    const story = await getBrandStoryById(req.params.id, req.user.id);
    if (!story) return res.status(404).json({ success: false, error: 'Story not found' });

    const { bible } = req.body;

    // Clear-the-override path: bible=null. Always permitted (this is the only
    // way to undo a lock).
    if (bible === null) {
      await updateBrandStory(req.params.id, req.user.id, { cast_bible: null });
      return res.json({
        success: true,
        cleared: true,
        next_episode_will_redrive: true
      });
    }

    if (!bible || typeof bible !== 'object') {
      return res.status(400).json({ success: false, error: 'Body must be { bible: <object> } or { bible: null }' });
    }

    // Voice canonical-source contract (Failure Mode #2): voice_id changes
    // come through PATCH /personas/:idx/voice, not here. Reject silently
    // (rather than ignoring) so callers don't believe the write succeeded.
    if (Array.isArray(bible.principals)) {
      for (const p of bible.principals) {
        if (p && Object.prototype.hasOwnProperty.call(p, 'elevenlabs_voice_id')) {
          const stored = story.cast_bible?.principals?.find(sp => sp?.persona_index === p.persona_index);
          if (!stored || stored.elevenlabs_voice_id !== p.elevenlabs_voice_id) {
            return res.status(400).json({
              success: false,
              error: 'Voice IDs are owned by persona_config; use PATCH /api/brand-stories/:id/personas/:idx/voice to change them.'
            });
          }
        }
      }
    }

    // Locked bible REJECT contract (Failure Mode #3). Compare proposed
    // structural fields against stored — if anything differs, reject.
    const stored = story.cast_bible;
    if (stored?.status === 'locked') {
      const storedPrincipals = Array.isArray(stored.principals) ? stored.principals : [];
      const proposedPrincipals = Array.isArray(bible.principals) ? bible.principals : [];

      // Principal count change → 422
      if (proposedPrincipals.length !== storedPrincipals.length) {
        return res.status(422).json({
          success: false,
          error: 'Cast bible is locked — principal count cannot change. Clear via PATCH /cast-bible { bible: null } first to make structural changes.'
        });
      }
      // Per-principal structural mutations → 422 (allows status flip locked→unlocked
      // ONLY via {bible: null} clear path, which is handled above)
      const STRUCTURAL_FIELDS = ['persona_index', 'name', 'role'];
      for (let i = 0; i < storedPrincipals.length; i++) {
        for (const f of STRUCTURAL_FIELDS) {
          const proposed = proposedPrincipals[i]?.[f];
          if (proposed !== undefined && proposed !== storedPrincipals[i][f]) {
            return res.status(422).json({
              success: false,
              error: `Cast bible is locked — ${f} on principal ${i} cannot change. Clear via PATCH /cast-bible { bible: null } first to make structural changes.`,
              conflict: { principal_index: i, field: f }
            });
          }
        }
      }
    }

    // Merge defaults so partial overrides are valid (preserves inheritance_policy
    // and other fields the caller didn't touch).
    const merged = mergeCastBibleDefaults(bible);
    const issues = validateCastBible(merged);
    const blockers = issues.filter(i => isBlockerOrCritical(i.severity));

    if (blockers.length > 0) {
      return res.status(422).json({
        success: false,
        error: 'cast bible failed validation',
        blockers,
        warnings: issues.filter(i => i.severity === 'warning')
      });
    }

    // Annotate provenance so the Director Panel can show "manually overridden"
    merged._generated_by = 'manual_override';
    merged.status = merged.status || 'derived';

    await updateBrandStory(req.params.id, req.user.id, { cast_bible: merged });

    res.json({
      success: true,
      bible: merged,
      warnings: issues
    });
  } catch (error) {
    logger.error('Error overriding cast_bible:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to override cast bible' });
  }
});

export default router;
