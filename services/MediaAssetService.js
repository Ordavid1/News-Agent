/**
 * Media Asset Service
 *
 * Orchestrates the full media asset pipeline:
 *   1. Upload reference images to Supabase Storage
 *   2. Train Flux LoRA model on Replicate using uploaded images
 *   3. Generate new brand-consistent images with the trained model
 *
 * Uses Replicate's ostris/flux-dev-lora-trainer for LoRA fine-tuning
 * and the trained model for inference.
 *
 * Gated by the Marketing add-on subscription.
 */

import Replicate from 'replicate';
import axios from 'axios';
import winston from 'winston';
import sharp from 'sharp';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Vibrant } from 'node-vibrant/node';
import { supabaseAdmin } from './supabase.js';
import {
  getUserMediaAssets,
  createMediaAsset,
  deleteMediaAsset as dbDeleteMediaAsset,
  countMediaAssets,
  clearMediaAssetsPool,
  getMediaTrainingJobById,
  getMediaTrainingJobs,
  getActiveMediaTrainingJob,
  createMediaTrainingJob,
  updateMediaTrainingJob,
  setDefaultTrainingJob,
  deleteMediaTrainingJob as dbDeleteMediaTrainingJob,
  getDefaultTrainingJob,
  getGeneratedMedia,
  getGeneratedMediaByJobId,
  createGeneratedMedia,
  deleteGeneratedMedia as dbDeleteGeneratedMedia,
  createPerUsePurchase
} from './database-wrapper.js';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[MediaAssetService] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

// Supabase Storage bucket name
const STORAGE_BUCKET = 'media-assets';

// Minimum images required for training
const MIN_TRAINING_IMAGES = 10;

// Brand Kit visual asset extraction limits
const MAX_BRAND_KIT_ASSETS = 15;
const ASSET_CONFIDENCE_THRESHOLD = 0.75;
const REMBG_MODEL = 'bria/remove-background:5ecc270b34e9d8e1f007d9dbd3c724f0badf638f05ffaa0c5e0634ed64d3d378';
const IDEOGRAM_MODEL = 'ideogram-ai/ideogram-v3-quality';
const NANO_BANANA_MODEL = 'google/nano-banana-pro';

// Replicate trainer model
const TRAINER_OWNER = 'ostris';
const TRAINER_NAME = 'flux-dev-lora-trainer';

// Unified brand training preset — captures BOTH style (colors, layout, aesthetic) AND subject (products, logos, people)
// All layers trained for full brand identity; moderate caption dropout balances trigger-word association with content fidelity
const TRAINING_PRESETS = {
  brand: {
    lora_rank: 32,               // Full capacity for comprehensive brand identity
    steps_per_image: 38,         // Balanced between style (35) and subject (40)
    min_steps: 1000,
    max_steps: 2500,             // Higher ceiling for thorough brand learning
    caption_dropout_rate: 0.10,  // Moderate — preserves trigger word association without over-memorizing captions
    layers_to_optimize_regex: null  // null = train ALL layers — essential for capturing both style AND subject
  },
  // Backward-compat aliases for existing DB records with training_type='style' or 'subject'
  get style() { return this.brand; },
  get subject() { return this.brand; }
};

// FLUX.2 Pro — reference-image generation (no LoRA training needed)
const FLUX2_PRO_MODEL = 'black-forest-labs/flux-2-pro';
const FLUX2_PRO_MAX_REFS = 7; // 7 at 2MP resolution (8 at 1MP, but we use 2MP for better quality)

// Generation defaults (FLUX.1 LoRA path)
const DEFAULT_GUIDANCE_SCALE = 3.0;    // Slightly lower than 3.5 for more natural results
const DEFAULT_INFERENCE_STEPS = 32;    // Higher than 28 for better LoRA coherence
const DEFAULT_LORA_SCALE = 1.0;        // Controls LoRA influence strength (0.5-1.5 range)

class MediaAssetService {
  constructor() {
    this.replicate = null;
    this.replicateOwner = process.env.REPLICATE_MODEL_OWNER || null;

    if (process.env.REPLICATE_API_TOKEN) {
      this.replicate = new Replicate({
        auth: process.env.REPLICATE_API_TOKEN
      });
      logger.info('Replicate client initialized');
    } else {
      logger.warn('REPLICATE_API_TOKEN not set — training and generation unavailable');
    }

    if (!this.replicateOwner) {
      logger.warn('REPLICATE_MODEL_OWNER not set — will be required for training');
    }
  }

  // ============================================
  // STORAGE & UPLOAD
  // ============================================

  /**
   * Ensure the storage bucket exists and is public. Called lazily on first upload.
   */
  async ensureBucket() {
    if (this._bucketVerified) return;

    const { data: buckets } = await supabaseAdmin.storage.listBuckets();
    const existing = buckets?.find(b => b.name === STORAGE_BUCKET);

    if (!existing) {
      const { error } = await supabaseAdmin.storage.createBucket(STORAGE_BUCKET, {
        public: true,
        fileSizeLimit: 10 * 1024 * 1024, // 10MB per file
        allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp']
      });
      if (error) {
        logger.error('Error creating storage bucket:', error);
        throw error;
      }
      logger.info(`Created storage bucket: ${STORAGE_BUCKET}`);
    } else if (!existing.public) {
      // Bucket exists but isn't public — fix it
      const { error } = await supabaseAdmin.storage.updateBucket(STORAGE_BUCKET, {
        public: true,
        fileSizeLimit: 10 * 1024 * 1024,
        allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp']
      });
      if (error) {
        logger.error('Error updating storage bucket to public:', error);
        throw error;
      }
      logger.info(`Updated storage bucket ${STORAGE_BUCKET} to public`);
    }

    this._bucketVerified = true;
  }

  /**
   * Upload a single image file to Supabase Storage and create a DB record.
   *
   * @param {string} userId
   * @param {string} adAccountId
   * @param {object} file - multer file object (buffer, originalname, mimetype, size)
   * @returns {object} Created media_assets row
   */
  async uploadAsset(userId, adAccountId, file) {
    await this.ensureBucket();

    // Check image resolution from buffer header (non-blocking warning)
    const resolution = this._getImageResolution(file.buffer, file.mimetype);
    let warning = null;
    if (resolution) {
      if (resolution.width < 1024 || resolution.height < 1024) {
        warning = `Image is ${resolution.width}x${resolution.height}px. For best training results, use images at least 1024x1024px.`;
        logger.warn(`Low-res upload: ${file.originalname} (${resolution.width}x${resolution.height})`);
      }
    }

    const ext = file.originalname.split('.').pop().toLowerCase();
    const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const storagePath = `${userId}/${adAccountId}/uploads/${uniqueName}`;

    // Upload to Supabase Storage
    const { error: uploadError } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false
      });

    if (uploadError) {
      logger.error('Error uploading to storage:', uploadError);
      throw new Error(`Upload failed: ${uploadError.message}`);
    }

    // Get public URL
    const { data: urlData } = supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .getPublicUrl(storagePath);

    const publicUrl = urlData.publicUrl;

    // Create DB record
    const asset = await createMediaAsset(userId, adAccountId, {
      file_name: file.originalname,
      storage_path: storagePath,
      public_url: publicUrl,
      file_size: file.size,
      mime_type: file.mimetype
    });

    logger.info(`Uploaded asset ${asset.id} for account ${adAccountId}`);
    return { ...asset, warning };
  }

  /**
   * Delete a media asset from Storage and DB.
   */
  async deleteAsset(assetId, userId) {
    const deleted = await dbDeleteMediaAsset(assetId, userId);
    if (!deleted) return null;

    // Remove from storage
    const { error } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .remove([deleted.storage_path]);

    if (error) {
      logger.warn(`Failed to remove file from storage (${deleted.storage_path}):`, error);
      // Non-fatal: DB record is already deleted
    }

    return deleted;
  }

  /**
   * List assets for an ad account.
   */
  async getAssets(userId, adAccountId) {
    return getUserMediaAssets(userId, adAccountId);
  }

  /**
   * Count assets for an ad account.
   */
  async getAssetCount(userId, adAccountId) {
    return countMediaAssets(userId, adAccountId);
  }

  // ============================================
  // TRAINING
  // ============================================

  /**
   * Start LoRA training on Replicate using uploaded images.
   *
   * @param {string} userId
   * @param {string} adAccountId
   * @param {string} name - User-provided session name
   * @param {string} trainingType - 'brand' (unified), or legacy 'style'/'subject' (mapped to brand)
   * @returns {object} Training job record
   */
  async startTraining(userId, adAccountId, name, trainingType = 'brand') {
    if (!this.replicate) {
      throw new Error('Replicate not configured. Set REPLICATE_API_TOKEN environment variable.');
    }
    if (!this.replicateOwner) {
      throw new Error('Replicate model owner not configured. Set REPLICATE_MODEL_OWNER environment variable.');
    }

    // Concurrency guard: only one active training per account at a time
    const activeJob = await getActiveMediaTrainingJob(userId, adAccountId);
    if (activeJob) {
      throw new Error('A training is already in progress for this account. Please wait for it to complete.');
    }

    // Gather NEW image URLs — exclude any already snapshotted by existing models
    const assets = await getUserMediaAssets(userId, adAccountId);
    const existingJobs = await getMediaTrainingJobs(userId, adAccountId);
    const ownedUrls = new Set();
    for (const existingJob of existingJobs) {
      if (existingJob.training_image_urls) {
        for (const url of existingJob.training_image_urls) {
          ownedUrls.add(url);
        }
      }
    }
    const imageUrls = assets.map(a => a.public_url).filter(url => !ownedUrls.has(url));
    const assetCount = imageUrls.length;

    // Check minimum images (against filtered count, not raw pool)
    if (assetCount < MIN_TRAINING_IMAGES) {
      throw new Error(`At least ${MIN_TRAINING_IMAGES} images are required for training. Currently have ${assetCount}.`);
    }

    // Download images and create a zip in memory
    const zipBuffer = await this._createTrainingZip(imageUrls);

    // Upload zip to Replicate Files API
    logger.info(`Uploading training zip (${(zipBuffer.length / 1024).toFixed(1)} KB) to Replicate...`);
    const uploadedFile = await this.replicate.files.create(zipBuffer, {
      filename: `training-${adAccountId}.zip`,
      content_type: 'application/zip'
    });
    const inputImagesUrl = uploadedFile.urls.get;
    logger.info(`Training zip uploaded: ${inputImagesUrl}`);

    // Create or ensure destination model exists
    const modelName = `media-lora-${adAccountId.replace(/-/g, '').slice(0, 16)}`;
    const replicateModelName = `${this.replicateOwner}/${modelName}`;
    await this._ensureDestinationModel(modelName);

    // Get latest trainer version
    const trainerVersion = await this._getLatestTrainerVersion();

    // Generate a trigger word from the account ID
    const triggerWord = `BRAND${adAccountId.replace(/-/g, '').slice(0, 6).toUpperCase()}`;

    // Resolve training preset — all types map to unified 'brand' preset
    const validType = TRAINING_PRESETS[trainingType] ? trainingType : 'brand';
    const preset = TRAINING_PRESETS[validType];

    // Dynamic step calculation based on image count and preset
    const steps = Math.min(preset.max_steps, Math.max(preset.min_steps, assetCount * preset.steps_per_image));

    logger.info(`Training preset: ${validType} (lora_rank=${preset.lora_rank}, steps=${steps}, images=${assetCount})`);

    // Build training input with preset-specific parameters
    const trainingInput = {
      input_images: inputImagesUrl,
      trigger_word: triggerWord,
      steps,
      lora_rank: preset.lora_rank,
      optimizer: 'adamw8bit',
      batch_size: 1,
      resolution: '512,768,1024',
      learning_rate: 0.0004,
      autocaption: true,
      autocaption_prefix: `in the style of ${triggerWord}, `,
      caption_dropout_rate: preset.caption_dropout_rate,
      cache_latents_to_disk: true
    };

    // Only restrict layer training for presets that specify it (e.g., subject mode).
    // Style mode trains ALL layers for full brand identity capture.
    if (preset.layers_to_optimize_regex) {
      trainingInput.layers_to_optimize_regex = preset.layers_to_optimize_regex;
    }

    // Start training with optimized parameters
    const training = await this.replicate.trainings.create(
      TRAINER_OWNER,
      TRAINER_NAME,
      trainerVersion,
      {
        destination: replicateModelName,
        input: trainingInput
      }
    );

    logger.info(`Training started: ${training.id} (status: ${training.status})`);

    // Save training job to DB (INSERT, not upsert — supports multiple sessions)
    const job = await createMediaTrainingJob(userId, adAccountId, {
      name: name || 'Untitled',
      training_type: validType,
      status: 'training',
      replicate_training_id: training.id,
      replicate_model_version: null,
      replicate_model_name: replicateModelName,
      trigger_word: triggerWord,
      training_image_urls: imageUrls,
      image_count: assetCount,
      payment_status: 'free', // Payment gate hook — set to 'paid' when payment UI is implemented
      error_message: null,
      started_at: new Date().toISOString(),
      completed_at: null
    });

    // Clear upload pool after snapshot — prevents cross-model image pollution
    // Storage files remain accessible via training_image_urls snapshot
    try {
      const cleared = await clearMediaAssetsPool(userId, adAccountId);
      logger.info(`Cleared ${cleared} asset(s) from upload pool after training job ${job.id}`);
    } catch (clearErr) {
      logger.warn(`Failed to clear upload pool after training job ${job.id}: ${clearErr.message}`);
    }

    return {
      ...job,
      trigger_word: triggerWord,
      replicate_model: replicateModelName
    };
  }

  /**
   * Check and update training status from Replicate.
   *
   * @param {string} jobId - Training job ID
   * @param {string} userId
   * @returns {object} Updated training job
   */
  async checkTrainingStatus(jobId, userId) {
    if (!this.replicate) {
      throw new Error('Replicate not configured.');
    }

    const job = await getMediaTrainingJobById(jobId, userId);
    if (!job) return null;

    // If already in terminal state, just return
    if (['completed', 'failed'].includes(job.status)) {
      return job;
    }

    if (!job.replicate_training_id) {
      return job;
    }

    // Fetch status from Replicate
    const training = await this.replicate.trainings.get(job.replicate_training_id);

    // Parse progress from logs
    let progress = null;
    if (training.logs) {
      progress = this._parseProgress(training.logs);
    }

    // Map Replicate status to our status
    let newStatus = job.status;
    const updates = {};

    if (training.status === 'succeeded') {
      newStatus = 'completed';
      updates.replicate_model_version = training.output?.version || null;
      updates.completed_at = training.completed_at || new Date().toISOString();
      logger.info(`Training ${job.replicate_training_id} succeeded. Model version: ${updates.replicate_model_version}`);
    } else if (training.status === 'failed' || training.status === 'canceled') {
      newStatus = 'failed';
      updates.error_message = training.error ? String(training.error) : 'Training failed or was canceled';
      updates.completed_at = training.completed_at || new Date().toISOString();
      logger.error(`Training ${job.replicate_training_id} failed: ${updates.error_message}`);
    }
    // 'starting' and 'processing' both map to 'training'

    updates.status = newStatus;
    const updatedJob = await updateMediaTrainingJob(jobId, userId, updates);

    // Auto-set newly completed training as the default model
    if (newStatus === 'completed') {
      try {
        await setDefaultTrainingJob(jobId, userId, job.ad_account_id);
        updatedJob.is_default = true;
        logger.info(`Training ${jobId} auto-set as default model for account ${job.ad_account_id}`);
      } catch (err) {
        logger.warn(`Failed to auto-set default training job: ${err.message}`);
      }

      // Auto-grant 6 free generation credits included with training
      try {
        await createPerUsePurchase(userId, {
          purchaseType: 'asset_image_gen_pack',
          amountCents: 0,
          currency: 'usd',
          status: 'completed',
          paymentProvider: 'system',
          creditsTotal: 8,
          creditsUsed: 0,
          referenceId: jobId,
          referenceType: 'media_training_job',
          idempotencyKey: `training_completion_credits_${jobId}`,
          description: 'Free generation credits (included with training)',
          metadata: {
            ad_account_id: job.ad_account_id,
            auto_granted: true,
            training_job_id: jobId
          }
        });
        logger.info(`Auto-granted 8 free image credits for training ${jobId} (user ${userId})`);
      } catch (creditErr) {
        // Non-fatal: training succeeded, credits can be manually reconciled
        // Idempotency key prevents duplicate grants on re-polls
        if (creditErr.code === '23505') {
          logger.info(`Free credits already granted for training ${jobId} (idempotency)`);
        } else {
          logger.error(`Failed to auto-grant generation credits for training ${jobId}: ${creditErr.message}`);
        }
      }

      // Non-blocking brand kit analysis from training images
      if (job.training_image_urls && job.training_image_urls.length > 0 && !updatedJob.brand_kit) {
        this.analyzeBrandKit(jobId, userId, job.training_image_urls, job.ad_account_id).catch(err => {
          logger.warn(`Brand kit analysis failed (non-blocking): ${err.message}`);
        });
      }
    }

    return {
      ...updatedJob,
      progress
    };
  }

  /**
   * Get all training jobs for an ad account.
   * On first load, remediates any cross-model image pollution in training_image_urls.
   */
  async getTrainingJobs(userId, adAccountId) {
    const jobs = await getMediaTrainingJobs(userId, adAccountId);

    // One-time remediation: deduplicate training_image_urls across models
    // Older models keep their URLs; newer models have duplicates removed
    await this._remediateTrainingImageUrls(userId, jobs);

    return jobs;
  }

  /**
   * Deduplicate training_image_urls across models for an account.
   * Each URL should appear in exactly one model — the oldest one that trained with it.
   * Runs idempotently; no-ops if no pollution is found.
   */
  async _remediateTrainingImageUrls(userId, jobs) {
    if (!jobs || jobs.length < 2) return; // nothing to deduplicate with < 2 models

    // Sort oldest-first so the first model retains its full set
    const sorted = [...jobs].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    const seenUrls = new Set();
    const jobsToUpdate = [];

    for (const job of sorted) {
      if (!job.training_image_urls || job.training_image_urls.length === 0) continue;

      const cleanedUrls = job.training_image_urls.filter(url => !seenUrls.has(url));

      // Track all URLs from this job (after dedup) as "owned"
      for (const url of cleanedUrls) {
        seenUrls.add(url);
      }

      // If URLs were removed, this job needs updating
      if (cleanedUrls.length < job.training_image_urls.length) {
        jobsToUpdate.push({ job, cleanedUrls });
      }
    }

    if (jobsToUpdate.length === 0) return; // no pollution found

    logger.info(`[Remediation] Deduplicating training_image_urls for ${jobsToUpdate.length} model(s) (user=${userId})`);

    for (const { job, cleanedUrls } of jobsToUpdate) {
      try {
        const removed = job.training_image_urls.length - cleanedUrls.length;
        await updateMediaTrainingJob(job.id, userId, {
          training_image_urls: cleanedUrls,
          image_count: cleanedUrls.length
        });

        // Update the in-memory job object so the response reflects the fix immediately
        job.training_image_urls = cleanedUrls;
        job.image_count = cleanedUrls.length;

        logger.info(`[Remediation] Model "${job.name}" (${job.id}): removed ${removed} duplicate URL(s), now ${cleanedUrls.length} images`);

        // Re-analyze brand kit with the clean image set (non-blocking)
        if (job.brand_kit && cleanedUrls.length > 0) {
          await updateMediaTrainingJob(job.id, userId, { brand_kit: null });
          job.brand_kit = null;
          logger.info(`[Remediation] Cleared stale brand_kit for model "${job.name}" — triggering re-analysis`);
          this.analyzeBrandKit(job.id, userId, cleanedUrls, job.ad_account_id).catch(err => {
            logger.warn(`[Remediation] Brand kit re-analysis failed for ${job.id}: ${err.message}`);
          });
        }
      } catch (err) {
        logger.warn(`[Remediation] Failed to update model ${job.id}: ${err.message}`);
      }
    }
  }

  /**
   * Get a specific training job by ID.
   */
  async getTrainingJobById(jobId, userId) {
    return getMediaTrainingJobById(jobId, userId);
  }

  /**
   * Delete a training job along with all associated storage files and generated media.
   * Removes: training images from storage (only those not used by other models),
   * generated images from storage, orphan media_assets entries, and DB records.
   */
  async deleteTrainingJob(jobId, userId) {
    // Fetch job data BEFORE deletion so we can identify its ad_account_id
    const jobToDelete = await getMediaTrainingJobById(jobId, userId);
    if (!jobToDelete) return null;

    // Get all sibling models (same account) to protect their storage files
    const siblingJobs = await getMediaTrainingJobs(userId, jobToDelete.ad_account_id);
    const siblingUrls = new Set();
    for (const sibling of siblingJobs) {
      if (sibling.id === jobId) continue; // skip the one being deleted
      if (sibling.training_image_urls) {
        for (const url of sibling.training_image_urls) {
          siblingUrls.add(url);
        }
      }
    }

    // Now delete the DB records (training job + generated media)
    const result = await dbDeleteMediaTrainingJob(jobId, userId);
    if (!result) return null;

    const { job, generatedMedia } = result;
    const storagePaths = [];

    // Collect training image storage paths — only for URLs NOT referenced by other models
    if (job.training_image_urls && job.training_image_urls.length > 0) {
      for (const url of job.training_image_urls) {
        if (siblingUrls.has(url)) continue; // another model still uses this file
        const marker = `/object/public/${STORAGE_BUCKET}/`;
        const idx = url.indexOf(marker);
        if (idx !== -1) {
          storagePaths.push(decodeURIComponent(url.substring(idx + marker.length)));
        }
      }
    }

    // Collect generated media storage paths
    for (const item of generatedMedia) {
      if (item.storage_path) {
        storagePaths.push(item.storage_path);
      }
    }

    // Batch-remove storage files
    if (storagePaths.length > 0) {
      const { error } = await supabaseAdmin.storage
        .from(STORAGE_BUCKET)
        .remove(storagePaths);

      if (error) {
        logger.warn(`Failed to remove some storage files for training job ${jobId}: ${error.message}`);
      } else {
        logger.info(`Removed ${storagePaths.length} storage files for deleted training job ${jobId}`);
      }
    }

    // Clean up orphaned media_assets entries whose URLs matched this model's training images
    // (for models created before the pool-cleanup fix)
    if (job.training_image_urls && job.training_image_urls.length > 0) {
      try {
        const urlSet = new Set(job.training_image_urls);
        const poolAssets = await getUserMediaAssets(userId, job.ad_account_id);
        const orphanIds = poolAssets
          .filter(a => urlSet.has(a.public_url))
          .map(a => a.id);

        if (orphanIds.length > 0) {
          for (const orphanId of orphanIds) {
            await dbDeleteMediaAsset(orphanId, userId);
          }
          logger.info(`Cleaned up ${orphanIds.length} orphaned media_assets entries for job ${jobId}`);
        }
      } catch (orphanErr) {
        logger.warn(`Failed to clean up orphaned media_assets for job ${jobId}: ${orphanErr.message}`);
      }
    }

    logger.info(`Deleted training job ${jobId} (${job.name || 'Untitled'})`);
    return job;
  }

  /**
   * Get the currently active training job for an account (if any).
   */
  async getActiveTrainingJob(userId, adAccountId) {
    return getActiveMediaTrainingJob(userId, adAccountId);
  }

  /**
   * Set a completed training job as the default model for generation.
   * Unsets any previous default for the same ad account.
   */
  async setDefaultTrainingJob(jobId, userId, adAccountId) {
    return setDefaultTrainingJob(jobId, userId, adAccountId);
  }

  /**
   * Get the default training job for an account (is_default=true, completed).
   * Returns null if no default model exists.
   */
  async getDefaultTrainingJob(userId, adAccountId) {
    return getDefaultTrainingJob(userId, adAccountId);
  }

  // ============================================
  // FLUX.2 PRO — REFERENCE-IMAGE MODEL CREATION
  // ============================================

  /**
   * Create a FLUX.2 Pro "model" using reference images (no training needed).
   *
   * Instead of LoRA training, this snapshots the uploaded reference images
   * and creates a completed model record immediately. At generation time,
   * the reference images are passed to FLUX.2 Pro's input_images parameter.
   *
   * @param {string} userId
   * @param {string} adAccountId
   * @param {string} name - User-provided model name
   * @returns {object} Completed model record
   */
  async createFlux2ProModel(userId, adAccountId, name) {
    if (!this.replicate) {
      throw new Error('Replicate not configured. Set REPLICATE_API_TOKEN environment variable.');
    }

    // Concurrency guard (same as training)
    const activeJob = await getActiveMediaTrainingJob(userId, adAccountId);
    if (activeJob) {
      throw new Error('A training is already in progress for this account. Please wait for it to complete.');
    }

    // Gather NEW image URLs — exclude any already snapshotted by existing models
    const assets = await getUserMediaAssets(userId, adAccountId);
    const existingJobs = await getMediaTrainingJobs(userId, adAccountId);
    const ownedUrls = new Set();
    for (const existingJob of existingJobs) {
      if (existingJob.training_image_urls) {
        for (const url of existingJob.training_image_urls) {
          ownedUrls.add(url);
        }
      }
    }
    const imageUrls = assets.map(a => a.public_url).filter(url => !ownedUrls.has(url));
    const assetCount = imageUrls.length;

    // Check minimum images (against filtered count, not raw pool)
    if (assetCount < MIN_TRAINING_IMAGES) {
      throw new Error(`At least ${MIN_TRAINING_IMAGES} images are required. Currently have ${assetCount}.`);
    }

    const refUrls = imageUrls.slice(0, FLUX2_PRO_MAX_REFS);

    logger.info(`Creating FLUX.2 Pro model with ${refUrls.length} reference images (${assetCount} new uploads, pool had ${assets.length} total)`);

    // Create a completed model record immediately (no training)
    const job = await createMediaTrainingJob(userId, adAccountId, {
      name: name || 'Untitled',
      training_type: 'reference',
      status: 'completed',
      replicate_training_id: null,
      replicate_model_version: FLUX2_PRO_MODEL,
      replicate_model_name: 'flux-2-pro',
      trigger_word: null,
      training_image_urls: imageUrls,
      image_count: assetCount,
      payment_status: 'free',
      error_message: null,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString()
    });

    // Clear upload pool after snapshot — prevents cross-model image pollution
    try {
      const cleared = await clearMediaAssetsPool(userId, adAccountId);
      logger.info(`Cleared ${cleared} asset(s) from upload pool after FLUX.2 Pro model ${job.id}`);
    } catch (clearErr) {
      logger.warn(`Failed to clear upload pool after FLUX.2 Pro model ${job.id}: ${clearErr.message}`);
    }

    // Auto-set as default model
    try {
      await setDefaultTrainingJob(job.id, userId, adAccountId);
      job.is_default = true;
      logger.info(`FLUX.2 Pro model ${job.id} set as default for account ${adAccountId}`);
    } catch (err) {
      logger.warn(`Failed to auto-set default: ${err.message}`);
    }

    // Auto-grant 6 free generation credits
    try {
      await createPerUsePurchase(userId, {
        purchaseType: 'asset_image_gen_pack',
        amountCents: 0,
        currency: 'usd',
        status: 'completed',
        paymentProvider: 'system',
        creditsTotal: 6,
        creditsUsed: 0,
        referenceId: job.id,
        referenceType: 'media_training_job',
        idempotencyKey: `training_completion_credits_${job.id}`,
        description: 'Free generation credits (included with model creation)',
        metadata: {
          ad_account_id: adAccountId,
          auto_granted: true,
          training_job_id: job.id,
          model_type: 'flux-2-pro'
        }
      });
      logger.info(`Auto-granted 8 free image credits for FLUX.2 Pro model ${job.id}`);
    } catch (creditErr) {
      if (creditErr.code === '23505') {
        logger.info(`Free credits already granted for model ${job.id} (idempotency)`);
      } else {
        logger.error(`Failed to auto-grant generation credits: ${creditErr.message}`);
      }
    }

    // Non-blocking brand kit analysis from reference images
    if (imageUrls.length > 0) {
      this.analyzeBrandKit(job.id, userId, imageUrls, adAccountId).catch(err => {
        logger.warn(`Brand kit analysis failed for FLUX.2 Pro model (non-blocking): ${err.message}`);
      });
    }

    return job;
  }

  // ============================================
  // GENERATION
  // ============================================

  /**
   * Generate image(s) using a trained model.
   *
   * Routes to the appropriate generation path based on model type:
   * - FLUX.1 LoRA: Uses the trained model version with trigger word
   * - FLUX.2 Pro: Uses reference images with the FLUX.2 Pro base model
   *
   * @param {string} userId
   * @param {string} adAccountId
   * @param {string} prompt
   * @param {string} trainingJobId - Which model/training session to generate from
   * @param {object} options - Optional generation parameters
   * @param {number} options.loraScale - LoRA influence strength (0.5-1.5, default 1.0) — LoRA only
   * @param {number} options.guidanceScale - Prompt adherence (1.0-5.0, default 3.0) — LoRA only
   * @param {number} options.numOutputs - Number of images to generate (1-4, default 1)
   * @param {string} options.aspectRatio - Aspect ratio (1:1, 16:9, 9:16, etc.)
   * @returns {object|object[]} Generated media record(s) — single object when numOutputs=1, array otherwise
   */
  async generateImage(userId, adAccountId, prompt, trainingJobId, options = {}) {
    if (!this.replicate) {
      throw new Error('Replicate not configured.');
    }

    // Get the specific training job / model
    const job = await getMediaTrainingJobById(trainingJobId, userId);
    if (!job || job.status !== 'completed') {
      throw new Error('Selected model is not completed or not found.');
    }

    // Branch on model type
    const isFlux2Pro = job.replicate_model_name === 'flux-2-pro';

    if (isFlux2Pro) {
      return this._generateFlux2Pro(userId, adAccountId, prompt, job, options);
    }
    return this._generateLoRA(userId, adAccountId, prompt, job, options);
  }

  /**
   * FLUX.2 Pro generation path — uses reference images, no LoRA.
   */
  async _generateFlux2Pro(userId, adAccountId, prompt, job, options) {
    // Reference images from the model snapshot
    const refUrls = (job.training_image_urls || []).slice(0, FLUX2_PRO_MAX_REFS);
    if (refUrls.length === 0) {
      throw new Error('No reference images stored for this model.');
    }

    const numOutputs = typeof options.numOutputs === 'number'
      ? Math.max(1, Math.min(4, Math.floor(options.numOutputs)))
      : 1;

    const VALID_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:5', '5:4', '3:2', '2:3', '4:3', '3:4'];
    const aspectRatio = VALID_ASPECT_RATIOS.includes(options.aspectRatio)
      ? options.aspectRatio
      : '1:1';

    logger.info(`Generating ${numOutputs} image(s) via FLUX.2 Pro with ${refUrls.length} reference images, aspect=${aspectRatio}, prompt: "${prompt.slice(0, 80)}..."`);

    // Enhance prompt with brand context + reference image guidance
    const promptStyle = options.brandPromptStyle || 'concise';
    const brandContext = this._buildBrandContextPrompt(job.brand_kit, null, promptStyle);
    const basePrompt = brandContext
      ? `Using the provided reference images as brand style guides, ${brandContext}generate: ${prompt}`
      : `Using the provided reference images as brand style guides, generate: ${prompt}`;
    const hasQuotedText = /["'][^"']{1,50}["']/.test(prompt);
    const enhancedPrompt = hasQuotedText
      ? basePrompt + '. Render any quoted text exactly as written, in clean legible typography.'
      : basePrompt + '. Avoid including written text or words unless specifically requested.';

    // Base seed for multi-output coherence (related but distinct variations)
    const baseSeed = Math.floor(Math.random() * 2147483647);

    // FLUX.2 Pro generates 1 image per call — loop for multiple outputs
    await this.ensureBucket();
    const records = [];

    for (let i = 0; i < numOutputs; i++) {
      const output = await this.replicate.run(FLUX2_PRO_MODEL, {
        input: {
          prompt: enhancedPrompt,
          input_images: refUrls,
          aspect_ratio: aspectRatio,
          resolution: '2 MP',
          output_format: 'webp',
          output_quality: 95,
          safety_tolerance: 3,
          seed: baseSeed + i
        }
      });

      // FLUX.2 Pro returns a single FileOutput or URL
      const imageSource = Array.isArray(output) ? output[0] : output;
      let imageBuffer;

      if (typeof imageSource === 'string') {
        const response = await axios.get(imageSource, { responseType: 'arraybuffer' });
        imageBuffer = Buffer.from(response.data);
      } else if (imageSource && typeof imageSource.blob === 'function') {
        const blob = await imageSource.blob();
        imageBuffer = Buffer.from(await blob.arrayBuffer());
      } else {
        logger.warn(`Skipping FLUX.2 Pro output ${i}: unexpected format`);
        continue;
      }

      // Upload to Supabase Storage
      const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.webp`;
      const storagePath = `${userId}/${adAccountId}/generated/${uniqueName}`;

      const { error: uploadError } = await supabaseAdmin.storage
        .from(STORAGE_BUCKET)
        .upload(storagePath, imageBuffer, { contentType: 'image/webp', upsert: false });

      if (uploadError) {
        logger.error(`Error uploading FLUX.2 Pro image ${i}:`, uploadError);
        continue;
      }

      const { data: urlData } = supabaseAdmin.storage
        .from(STORAGE_BUCKET)
        .getPublicUrl(storagePath);

      const record = await createGeneratedMedia(userId, adAccountId, {
        training_job_id: job.id,
        prompt,
        storage_path: storagePath,
        public_url: urlData.publicUrl,
        replicate_prediction_id: null,
        lora_scale: null,
        guidance_scale: null
      });

      records.push(record);
    }

    if (records.length === 0) {
      throw new Error('Failed to process any generated images.');
    }

    logger.info(`FLUX.2 Pro: ${records.length} image(s) saved`);
    return records.length === 1 ? records[0] : records;
  }

  /**
   * Build a brand-context base prompt from the training job's brand_kit data.
   * Injects color palette, style characteristics, mood, and brand summary as contextual guidance.
   * Falls back to just the trigger word if no brand kit data is available.
   *
   * @param {object|null} brandKit - The brand_kit JSONB from the training job
   * @param {string|null} triggerWord - The LoRA trigger word
   * @param {string} style - 'concise' or 'elaborated'
   * @returns {string} Brand context prefix to prepend to user prompt
   */
  _buildBrandContextPrompt(brandKit, triggerWord, style = 'concise') {
    const parts = [];

    // Trigger word anchor
    if (triggerWord) {
      parts.push(`in the style of ${triggerWord}`);
    }

    if (!brandKit || style === 'none') {
      return parts.length > 0 ? parts.join(', ') + ', ' : '';
    }

    if (style === 'elaborated') {
      return this._buildElaboratedPrompt(parts, brandKit);
    }
    return this._buildConcisePrompt(parts, brandKit);
  }

  /**
   * Concise prompt: hex codes + short mood keywords.
   */
  _buildConcisePrompt(parts, brandKit) {
    if (brandKit.color_palette && brandKit.color_palette.length > 0) {
      const topColors = brandKit.color_palette.slice(0, 4).map(c => c.hex);
      parts.push(`brand palette ${topColors.join(' ')}`);
    }

    const sc = brandKit.style_characteristics;
    if (sc) {
      const keywords = [];
      if (sc.mood) keywords.push(sc.mood.split(',')[0].trim().toLowerCase());
      if (sc.overall_aesthetic) {
        const shortAesthetic = sc.overall_aesthetic.split(',')[0].trim().toLowerCase();
        if (shortAesthetic.length <= 60) keywords.push(shortAesthetic);
      }
      if (keywords.length > 0) {
        parts.push(keywords.join(', '));
      }
    }

    return parts.length > 0 ? parts.join(', ') + '. ' : '';
  }

  /**
   * Elaborated prompt: full color names, detailed style, photography, illustration, and brand summary.
   */
  _buildElaboratedPrompt(parts, brandKit) {
    if (brandKit.color_palette && brandKit.color_palette.length > 0) {
      const topColors = brandKit.color_palette.slice(0, 4);
      const colorStr = topColors
        .map(c => c.name ? `${c.name.toLowerCase()} (${c.hex})` : c.hex)
        .join(', ');
      parts.push(`using brand colors ${colorStr}`);
    }

    const sc = brandKit.style_characteristics;
    if (sc) {
      const styleParts = [];
      if (sc.mood) styleParts.push(`${sc.mood} mood`);
      if (sc.overall_aesthetic) styleParts.push(`${sc.overall_aesthetic} aesthetic`);
      if (sc.photography_style) styleParts.push(`${sc.photography_style} photography`);
      if (sc.illustration_style) styleParts.push(`${sc.illustration_style} illustration`);
      if (styleParts.length > 0) {
        parts.push(`with ${styleParts.join(', ')}`);
      }
    }

    if (brandKit.brand_summary) {
      const firstSentence = brandKit.brand_summary.split(/[.!?]/)[0].trim();
      if (firstSentence.length > 0) {
        parts.push(`reflecting a brand identity of: ${firstSentence}`);
      }
    }

    return parts.length > 0 ? parts.join(', ') + '. ' : '';
  }

  /**
   * FLUX.1 LoRA generation path — uses trained model with trigger word.
   */
  async _generateLoRA(userId, adAccountId, prompt, job, options) {
    if (!job.replicate_model_version) {
      throw new Error('Training completed but no model version was recorded.');
    }

    // Build brand-context enriched prompt with trigger word and brand kit data
    const promptStyle = options.brandPromptStyle || 'concise';
    const brandContext = this._buildBrandContextPrompt(job.brand_kit, job.trigger_word, promptStyle);
    let finalPrompt = brandContext + prompt;

    // Ensure trigger word is present (fallback for models without brand_kit)
    if (job.trigger_word && !finalPrompt.toLowerCase().includes(job.trigger_word.toLowerCase())) {
      finalPrompt = `in the style of ${job.trigger_word}, ${prompt}`;
    }

    // Smart text handling — detect quoted text in user prompt
    const hasQuotedText = /["'][^"']{1,50}["']/.test(prompt);
    if (hasQuotedText) {
      finalPrompt += '. Render any quoted text exactly as written, in clean legible typography.';
      logger.info('Quoted text detected in prompt — text rendering mode enabled');
    } else {
      finalPrompt += '. Avoid including written text or words unless specifically requested.';
    }

    if (brandContext) {
      logger.info(`Brand context injected (${brandContext.length} chars) into generation prompt`);
    }

    // Build the model reference
    const modelName = job.replicate_model_name
      || `${this.replicateOwner}/media-lora-${adAccountId.replace(/-/g, '').slice(0, 16)}`;
    const modelRef = job.replicate_model_version.includes('/')
      ? job.replicate_model_version
      : `${modelName}:${job.replicate_model_version}`;

    // Resolve generation parameters with clamped defaults
    let loraScale = typeof options.loraScale === 'number'
      ? Math.max(0.5, Math.min(1.5, options.loraScale))
      : DEFAULT_LORA_SCALE;
    let guidanceScale = typeof options.guidanceScale === 'number'
      ? Math.max(1.0, Math.min(5.0, options.guidanceScale))
      : DEFAULT_GUIDANCE_SCALE;

    // Auto-adjust parameters for text rendering
    if (hasQuotedText) {
      if (guidanceScale < 3.5) {
        guidanceScale = 3.5;
        logger.info('Guidance scale auto-boosted to 3.5 for text rendering');
      }
      if (loraScale > 0.85) {
        loraScale = 0.85;
        logger.info('LoRA scale reduced to 0.85 to allow base model text rendering');
      }
    }
    const numOutputs = typeof options.numOutputs === 'number'
      ? Math.max(1, Math.min(4, Math.floor(options.numOutputs)))
      : 1;

    const VALID_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:5', '5:4', '3:2', '2:3', '4:3', '3:4', '21:9', '9:21'];
    const aspectRatio = VALID_ASPECT_RATIOS.includes(options.aspectRatio)
      ? options.aspectRatio
      : '1:1';

    logger.info(`Generating ${numOutputs} image(s) with LoRA model ${modelRef}, lora_scale=${loraScale}, guidance=${guidanceScale}, aspect=${aspectRatio}, prompt: "${finalPrompt.slice(0, 80)}..."`);

    // Run prediction
    const output = await this.replicate.run(modelRef, {
      input: {
        prompt: finalPrompt,
        num_outputs: numOutputs,
        guidance_scale: guidanceScale,
        num_inference_steps: DEFAULT_INFERENCE_STEPS,
        lora_scale: loraScale,
        aspect_ratio: aspectRatio,
        output_format: 'webp',
        output_quality: 90
      }
    });

    if (!output || output.length === 0) {
      throw new Error('No output received from Replicate.');
    }

    // Process all generated images
    await this.ensureBucket();
    const records = [];

    for (let i = 0; i < output.length; i++) {
      const imageSource = output[i];
      let imageBuffer;

      if (typeof imageSource === 'string') {
        // URL string
        const response = await axios.get(imageSource, { responseType: 'arraybuffer' });
        imageBuffer = Buffer.from(response.data);
      } else if (imageSource && typeof imageSource.blob === 'function') {
        // FileOutput object
        const blob = await imageSource.blob();
        imageBuffer = Buffer.from(await blob.arrayBuffer());
      } else {
        logger.warn(`Skipping output[${i}]: unexpected format`);
        continue;
      }

      // Upload to Supabase Storage
      const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.webp`;
      const storagePath = `${userId}/${adAccountId}/generated/${uniqueName}`;

      const { error: uploadError } = await supabaseAdmin.storage
        .from(STORAGE_BUCKET)
        .upload(storagePath, imageBuffer, {
          contentType: 'image/webp',
          upsert: false
        });

      if (uploadError) {
        logger.error(`Error uploading generated image ${i}:`, uploadError);
        continue;
      }

      const { data: urlData } = supabaseAdmin.storage
        .from(STORAGE_BUCKET)
        .getPublicUrl(storagePath);

      // Create DB record (including generation parameters for reproducibility)
      const record = await createGeneratedMedia(userId, adAccountId, {
        training_job_id: job.id,
        prompt: finalPrompt,
        storage_path: storagePath,
        public_url: urlData.publicUrl,
        replicate_prediction_id: null,
        lora_scale: loraScale,
        guidance_scale: guidanceScale
      });

      records.push(record);
    }

    if (records.length === 0) {
      throw new Error('Failed to process any generated images.');
    }

    logger.info(`Generated ${records.length} image(s) saved`);

    // Return single record for backwards compatibility when numOutputs=1
    return records.length === 1 ? records[0] : records;
  }

  /**
   * Get generated images for an ad account (all training sessions).
   */
  async getGeneratedImages(userId, adAccountId) {
    return getGeneratedMedia(userId, adAccountId);
  }

  /**
   * Get generated images filtered to a specific training session.
   */
  async getGeneratedImagesByJob(userId, adAccountId, trainingJobId) {
    return getGeneratedMediaByJobId(userId, adAccountId, trainingJobId);
  }

  /**
   * Delete a generated image from Storage and DB.
   */
  async deleteGeneratedImage(mediaId, userId) {
    const deleted = await dbDeleteGeneratedMedia(mediaId, userId);
    if (!deleted) return null;

    const { error } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .remove([deleted.storage_path]);

    if (error) {
      logger.warn(`Failed to remove generated file from storage (${deleted.storage_path}):`, error);
    }

    return deleted;
  }

  // ============================================
  // PRIVATE HELPERS
  // ============================================

  /**
   * Create a ZIP archive from image URLs (in memory).
   * Uses a minimal ZIP implementation to avoid additional dependencies.
   */
  async _createTrainingZip(imageUrls) {
    // Download all images in parallel
    const downloads = await Promise.all(
      imageUrls.map(async (url, index) => {
        try {
          const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 30000
          });

          // Determine extension from content-type
          const contentType = response.headers['content-type'] || 'image/jpeg';
          const ext = contentType.includes('png') ? 'png'
            : contentType.includes('webp') ? 'webp'
            : 'jpg';

          return {
            name: `image_${String(index).padStart(3, '0')}.${ext}`,
            buffer: Buffer.from(response.data)
          };
        } catch (err) {
          logger.warn(`Failed to download image ${index} (${url}): ${err.message}`);
          return null;
        }
      })
    );

    const validFiles = downloads.filter(Boolean);
    if (validFiles.length < MIN_TRAINING_IMAGES) {
      throw new Error(`Only ${validFiles.length} images could be downloaded. Need at least ${MIN_TRAINING_IMAGES}.`);
    }

    // Build ZIP using minimal approach (no extra dependency)
    return this._buildZipBuffer(validFiles);
  }

  /**
   * Build a ZIP file buffer from an array of { name, buffer } entries.
   * Implements the ZIP format (store method, no compression) to avoid
   * requiring an additional npm package.
   */
  _buildZipBuffer(files) {
    const entries = [];
    let offset = 0;

    for (const file of files) {
      const nameBuffer = Buffer.from(file.name, 'utf8');
      const data = file.buffer;

      // CRC-32 calculation
      const crc = this._crc32(data);

      // Local file header (30 bytes + name length)
      const localHeader = Buffer.alloc(30 + nameBuffer.length);
      localHeader.writeUInt32LE(0x04034b50, 0); // Signature
      localHeader.writeUInt16LE(20, 4);          // Version needed
      localHeader.writeUInt16LE(0, 6);           // Flags
      localHeader.writeUInt16LE(0, 8);           // Compression (store)
      localHeader.writeUInt16LE(0, 10);          // Mod time
      localHeader.writeUInt16LE(0, 12);          // Mod date
      localHeader.writeUInt32LE(crc, 14);        // CRC-32
      localHeader.writeUInt32LE(data.length, 18); // Compressed size
      localHeader.writeUInt32LE(data.length, 22); // Uncompressed size
      localHeader.writeUInt16LE(nameBuffer.length, 26); // Name length
      localHeader.writeUInt16LE(0, 28);          // Extra field length
      nameBuffer.copy(localHeader, 30);

      entries.push({
        nameBuffer,
        data,
        crc,
        localHeaderOffset: offset,
        localHeader
      });

      offset += localHeader.length + data.length;
    }

    // Central directory
    const centralDir = [];
    for (const entry of entries) {
      const cdEntry = Buffer.alloc(46 + entry.nameBuffer.length);
      cdEntry.writeUInt32LE(0x02014b50, 0);  // Signature
      cdEntry.writeUInt16LE(20, 4);           // Version made by
      cdEntry.writeUInt16LE(20, 6);           // Version needed
      cdEntry.writeUInt16LE(0, 8);            // Flags
      cdEntry.writeUInt16LE(0, 10);           // Compression
      cdEntry.writeUInt16LE(0, 12);           // Mod time
      cdEntry.writeUInt16LE(0, 14);           // Mod date
      cdEntry.writeUInt32LE(entry.crc, 16);   // CRC-32
      cdEntry.writeUInt32LE(entry.data.length, 20); // Compressed size
      cdEntry.writeUInt32LE(entry.data.length, 24); // Uncompressed size
      cdEntry.writeUInt16LE(entry.nameBuffer.length, 28); // Name length
      cdEntry.writeUInt16LE(0, 30);           // Extra field length
      cdEntry.writeUInt16LE(0, 32);           // Comment length
      cdEntry.writeUInt16LE(0, 34);           // Disk number
      cdEntry.writeUInt16LE(0, 36);           // Internal attrs
      cdEntry.writeUInt32LE(0, 38);           // External attrs
      cdEntry.writeUInt32LE(entry.localHeaderOffset, 42); // Local header offset
      entry.nameBuffer.copy(cdEntry, 46);
      centralDir.push(cdEntry);
    }

    const centralDirBuffer = Buffer.concat(centralDir);
    const centralDirOffset = offset;

    // End of central directory
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);  // Signature
    eocd.writeUInt16LE(0, 4);           // Disk number
    eocd.writeUInt16LE(0, 6);           // Central dir disk
    eocd.writeUInt16LE(entries.length, 8);  // Entries on disk
    eocd.writeUInt16LE(entries.length, 10); // Total entries
    eocd.writeUInt32LE(centralDirBuffer.length, 12); // Central dir size
    eocd.writeUInt32LE(centralDirOffset, 16); // Central dir offset
    eocd.writeUInt16LE(0, 20);          // Comment length

    // Combine all parts
    const parts = [];
    for (const entry of entries) {
      parts.push(entry.localHeader);
      parts.push(entry.data);
    }
    parts.push(centralDirBuffer);
    parts.push(eocd);

    return Buffer.concat(parts);
  }

  /**
   * Extract image dimensions from buffer headers (no external dependency).
   * Supports JPEG, PNG, and WebP.
   * Returns { width, height } or null if unable to parse.
   */
  _getImageResolution(buffer, mimeType) {
    try {
      if (mimeType === 'image/png' && buffer.length >= 24) {
        // PNG: width at bytes 16-19, height at bytes 20-23 (big-endian)
        return {
          width: buffer.readUInt32BE(16),
          height: buffer.readUInt32BE(20)
        };
      }

      if (mimeType === 'image/jpeg' && buffer.length >= 2) {
        // JPEG: scan for SOF0/SOF2 markers (0xFFC0 or 0xFFC2)
        let offset = 2; // Skip SOI marker
        while (offset < buffer.length - 8) {
          if (buffer[offset] !== 0xFF) break;
          const marker = buffer[offset + 1];
          if (marker === 0xC0 || marker === 0xC2) {
            return {
              height: buffer.readUInt16BE(offset + 5),
              width: buffer.readUInt16BE(offset + 7)
            };
          }
          const segmentLength = buffer.readUInt16BE(offset + 2);
          offset += 2 + segmentLength;
        }
      }

      if (mimeType === 'image/webp' && buffer.length >= 30) {
        // WebP: check for VP8 (lossy) or VP8L (lossless) chunks
        const fourCC = buffer.toString('ascii', 12, 16);
        if (fourCC === 'VP8 ' && buffer.length >= 30) {
          return {
            width: buffer.readUInt16LE(26) & 0x3FFF,
            height: buffer.readUInt16LE(28) & 0x3FFF
          };
        }
        if (fourCC === 'VP8L' && buffer.length >= 25) {
          const bits = buffer.readUInt32LE(21);
          return {
            width: (bits & 0x3FFF) + 1,
            height: ((bits >> 14) & 0x3FFF) + 1
          };
        }
      }
    } catch (err) {
      logger.warn(`Could not parse image resolution: ${err.message}`);
    }
    return null;
  }

  /**
   * CRC-32 calculation (used for ZIP format).
   */
  _crc32(buffer) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buffer.length; i++) {
      crc ^= buffer[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
      }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  /**
   * Ensure the Replicate destination model exists. Creates it if not.
   */
  async _ensureDestinationModel(modelName) {
    try {
      await this.replicate.models.get(this.replicateOwner, modelName);
      logger.info(`Destination model ${this.replicateOwner}/${modelName} already exists`);
    } catch (err) {
      // Model doesn't exist — create it
      try {
        await this.replicate.models.create(this.replicateOwner, modelName, {
          visibility: 'private',
          hardware: 'gpu-l40s',
          description: 'Brand media LoRA fine-tune'
        });
        logger.info(`Created destination model: ${this.replicateOwner}/${modelName}`);
      } catch (createErr) {
        // If it already exists (race condition), that's fine
        if (!String(createErr.message).includes('already exists')) {
          throw createErr;
        }
      }
    }
  }

  /**
   * Get the latest version of the trainer model.
   */
  async _getLatestTrainerVersion() {
    try {
      const model = await this.replicate.models.get(TRAINER_OWNER, TRAINER_NAME);
      if (model.latest_version) {
        return model.latest_version.id;
      }
    } catch (err) {
      logger.warn(`Could not fetch latest trainer version: ${err.message}`);
    }

    // Fallback to known version
    return '4ffd32160efd92e956d39c5338a9b8fbafca58e03f791f6d8011f3e20e8ea6fa';
  }

  /**
   * Parse training progress from Replicate logs.
   *
   * The ostris/flux-dev-lora-trainer outputs tqdm-style progress lines like:
   *   flux_train_replicate:  10%|█         | 100/1000 [01:23<11:07, 1.35it/s]
   *
   * Preprocessing lines like "loaded 10/10 images" must NOT be matched,
   * so we require total >= 100 (training uses ~1000 steps).
   */
  _parseProgress(logs) {
    try {
      // 1. Try Replicate SDK's built-in progress parser first (purpose-built)
      const parsed = Replicate.parseProgressFromLogs?.(logs);
      if (parsed && parsed.percentage != null) {
        return {
          current: parsed.current ?? Math.round(parsed.percentage * TRAINING_PRESETS.subject.min_steps),
          total: parsed.total ?? TRAINING_PRESETS.subject.min_steps,
          percentage: parsed.percentage
        };
      }

      // 2. Match tqdm-style progress: "100/1000 [" (bracket distinguishes from preprocessing)
      const tqdmMatches = logs.match(/\b(\d+)\/(\d+)\s*\[/g);
      if (tqdmMatches && tqdmMatches.length > 0) {
        const lastMatch = tqdmMatches[tqdmMatches.length - 1];
        const parts = lastMatch.match(/(\d+)\/(\d+)\s*\[/);
        if (parts) {
          const current = parseInt(parts[1], 10);
          const total = parseInt(parts[2], 10);
          // Only accept if total looks like actual training steps (not preprocessing like 10/10)
          if (total >= 100) {
            return { current, total, percentage: current / total };
          }
        }
      }

      // 3. Fallback: match percentage patterns like "10%|" from tqdm
      const pctMatches = logs.match(/(\d+)%\|/g);
      if (pctMatches && pctMatches.length > 0) {
        const lastPct = pctMatches[pctMatches.length - 1];
        const pctParts = lastPct.match(/(\d+)%\|/);
        if (pctParts) {
          const pct = parseInt(pctParts[1], 10) / 100;
          return {
            current: Math.round(pct * TRAINING_PRESETS.brand.min_steps),
            total: TRAINING_PRESETS.brand.min_steps,
            percentage: pct
          };
        }
      }
    } catch {
      // Ignore parse errors
    }
    return null;
  }

  // ============================================
  // KONTEXT IMAGE EDITING
  // ============================================

  /**
   * Edit a generated image. Smart routing:
   * - Quoted text in prompt → programmatic text overlay (Sharp SVG, pixel-perfect, any language)
   * - No quoted text → Ideogram V3 inpainting (visual edits like background changes, element removal)
   *
   * @param {string} userId
   * @param {string} adAccountId
   * @param {string} sourceImageUrl - Public URL of the image to edit
   * @param {string} editPrompt - Text instruction (may include 'quoted text' for overlay)
   * @param {string} trainingJobId - Training job to link the edited image to
   * @param {object} options - Optional params
   * @returns {object} New generated_media record
   */
  async editImageWithKontext(userId, adAccountId, sourceImageUrl, editPrompt, trainingJobId, options = {}) {
    logger.info(`Image edit: "${editPrompt.slice(0, 80)}..."`);

    // Download source image
    const sourceResp = await axios.get(sourceImageUrl, { responseType: 'arraybuffer', timeout: 20000 });
    const sourceBuffer = Buffer.from(sourceResp.data);

    // Detect quoted text → route to programmatic overlay vs AI inpainting
    const quotedMatch = editPrompt.match(/[""'']([^""'']{1,100})[""'']/);
    let resultBuffer;
    let editLabel;

    if (quotedMatch) {
      // TEXT OVERLAY PATH — programmatic rendering with real fonts
      const textToRender = quotedMatch[1];
      const position = this._parsePositionFromPrompt(editPrompt);
      resultBuffer = await this._overlayText(sourceBuffer, textToRender, position);
      editLabel = '[Text Overlay]';
      logger.info(`Text overlay: "${textToRender}" at ${position.label}`);
    } else {
      // VISUAL EDIT PATH — Nano Banana Pro or Ideogram V3
      if (!this.replicate) {
        throw new Error('Replicate not configured.');
      }

      const editModel = options.editModel || 'nano-banana';
      let output;
      const tmpPaths = [];

      if (editModel === 'ideogram') {
        // IDEOGRAM — mask-based inpainting for targeted regional edits
        const metadata = await sharp(sourceBuffer).metadata();
        const region = this._parsePositionFromPrompt(editPrompt);

        if (region.label === 'full image') {
          region.x = 0.2; region.y = 0.2; region.w = 0.6; region.h = 0.6;
          region.label = 'center (fallback)';
        }

        const maskBuffer = await this._generateMask(metadata.width, metadata.height, region);

        await this.ensureBucket();
        const tmpSourcePath = `${userId}/${adAccountId}/brand-kit/tmp-edit-src-${crypto.randomUUID().slice(0, 8)}.png`;
        const tmpMaskPath = `${userId}/${adAccountId}/brand-kit/tmp-edit-mask-${crypto.randomUUID().slice(0, 8)}.png`;
        const sourcePng = await sharp(sourceBuffer).png().toBuffer();

        await supabaseAdmin.storage.from(STORAGE_BUCKET).upload(tmpSourcePath, sourcePng, { contentType: 'image/png', upsert: false });
        await supabaseAdmin.storage.from(STORAGE_BUCKET).upload(tmpMaskPath, maskBuffer, { contentType: 'image/png', upsert: false });
        tmpPaths.push(tmpSourcePath, tmpMaskPath);

        const { data: srcUrlData } = supabaseAdmin.storage.from(STORAGE_BUCKET).getPublicUrl(tmpSourcePath);
        const { data: maskUrlData } = supabaseAdmin.storage.from(STORAGE_BUCKET).getPublicUrl(tmpMaskPath);

        logger.info(`Ideogram inpainting: ${region.label} (${Math.round(region.x * 100)}%,${Math.round(region.y * 100)}% ${Math.round(region.w * 100)}%x${Math.round(region.h * 100)}%)`);

        output = await this.replicate.run(IDEOGRAM_MODEL, {
          input: {
            prompt: editPrompt,
            image: srcUrlData.publicUrl,
            mask: maskUrlData.publicUrl,
            magic_prompt_option: 'Auto'
          }
        });
        editLabel = '[Ideogram Edit]';
      } else {
        // NANO BANANA PRO — reference-based editing, no mask needed
        await this.ensureBucket();
        const tmpSourcePath = `${userId}/${adAccountId}/brand-kit/tmp-edit-src-${crypto.randomUUID().slice(0, 8)}.png`;
        const sourcePng = await sharp(sourceBuffer).png().toBuffer();
        await supabaseAdmin.storage.from(STORAGE_BUCKET).upload(tmpSourcePath, sourcePng, { contentType: 'image/png', upsert: false });
        tmpPaths.push(tmpSourcePath);

        const { data: srcUrlData } = supabaseAdmin.storage.from(STORAGE_BUCKET).getPublicUrl(tmpSourcePath);

        logger.info(`Nano Banana Pro edit: "${editPrompt.slice(0, 60)}..."`);

        output = await this.replicate.run(NANO_BANANA_MODEL, {
          input: {
            prompt: editPrompt,
            image_input: [srcUrlData.publicUrl],
            aspect_ratio: 'match_input_image',
            output_format: 'png'
          }
        });
        editLabel = '[Nano Banana Edit]';
      }

      // Clean up temp files
      if (tmpPaths.length > 0) {
        supabaseAdmin.storage.from(STORAGE_BUCKET).remove(tmpPaths).catch(() => {});
      }

      const imageSource = Array.isArray(output) ? output[0] : output;
      if (typeof imageSource === 'string') {
        const resp = await axios.get(imageSource, { responseType: 'arraybuffer', timeout: 30000 });
        resultBuffer = Buffer.from(resp.data);
      } else if (imageSource && typeof imageSource.blob === 'function') {
        const blob = await imageSource.blob();
        resultBuffer = Buffer.from(await blob.arrayBuffer());
      } else {
        throw new Error('Unexpected output format from edit model');
      }
    }

    // Upload final result
    await this.ensureBucket();
    const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
    const storagePath = `${userId}/${adAccountId}/generated/${uniqueName}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, resultBuffer, { contentType: 'image/png', upsert: false });

    if (uploadError) {
      logger.error('Error uploading edited image:', uploadError);
      throw uploadError;
    }

    const { data: urlData } = supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .getPublicUrl(storagePath);

    const record = await createGeneratedMedia(userId, adAccountId, {
      training_job_id: trainingJobId,
      prompt: `${editLabel} ${editPrompt}`,
      storage_path: storagePath,
      public_url: urlData.publicUrl,
      replicate_prediction_id: null,
      lora_scale: null,
      guidance_scale: null
    });

    logger.info(`Image edit saved: ${record.id}`);
    return record;
  }

  /**
   * Overlay text on an image using Sharp SVG composite.
   * Uses Heebo font for Hebrew/RTL text, Inter for Latin.
   * Auto-detects text direction and adjusts color based on background brightness.
   *
   * @param {Buffer} sourceBuffer - Source image buffer
   * @param {string} text - Text to render
   * @param {object} position - { x, y, w, h, label } from _parsePositionFromPrompt
   * @returns {Buffer} PNG buffer with text overlaid
   */
  async _overlayText(sourceBuffer, text, position) {
    const metadata = await sharp(sourceBuffer).metadata();
    const imgWidth = metadata.width;
    const imgHeight = metadata.height;

    // Detect if text contains RTL characters (Hebrew, Arabic)
    const isRTL = /[\u0590-\u05FF\u0600-\u06FF]/.test(text);

    // Load font as base64 for SVG embedding
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const fontPath = isRTL
      ? path.join(__dirname, '..', 'public', 'fonts', 'Heebo-Variable.ttf')
      : path.join(__dirname, '..', 'public', 'fonts', 'Inter-Variable.ttf');
    const fontBase64 = fs.readFileSync(fontPath).toString('base64');
    const fontFamily = isRTL ? 'Heebo' : 'Inter';

    // Calculate text position in pixels
    const textX = Math.round((position.x + position.w / 2) * imgWidth);
    const textY = Math.round((position.y + position.h / 2) * imgHeight);

    // Scale font size relative to image size (~5% of shortest dimension)
    const fontSize = Math.round(Math.min(imgWidth, imgHeight) * 0.06);

    // Sample background color at text position to determine text color
    const sampleRegion = {
      left: Math.max(0, Math.round(position.x * imgWidth)),
      top: Math.max(0, Math.round(position.y * imgHeight)),
      width: Math.min(Math.round(position.w * imgWidth), imgWidth),
      height: Math.min(Math.round(position.h * imgHeight), imgHeight)
    };
    // Ensure valid dimensions
    sampleRegion.width = Math.max(1, Math.min(sampleRegion.width, imgWidth - sampleRegion.left));
    sampleRegion.height = Math.max(1, Math.min(sampleRegion.height, imgHeight - sampleRegion.top));

    const { dominant } = await sharp(sourceBuffer).extract(sampleRegion).stats();
    const bgBrightness = (dominant.r * 299 + dominant.g * 587 + dominant.b * 114) / 1000;
    const textColor = bgBrightness > 128 ? '#1a1a1a' : '#ffffff';
    const shadowColor = bgBrightness > 128 ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.6)';

    // Build SVG with embedded font
    const textDirection = isRTL ? 'rtl' : 'ltr';
    const textAnchor = 'middle';

    const svg = `<svg width="${imgWidth}" height="${imgHeight}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <style>
          @font-face {
            font-family: '${fontFamily}';
            src: url('data:font/ttf;base64,${fontBase64}');
            font-weight: 700;
          }
        </style>
      </defs>
      <text x="${textX}" y="${textY}"
        font-family="${fontFamily}, sans-serif"
        font-size="${fontSize}"
        font-weight="700"
        fill="${textColor}"
        text-anchor="${textAnchor}"
        dominant-baseline="central"
        direction="${textDirection}"
        filter="drop-shadow(2px 2px 4px ${shadowColor})">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</text>
    </svg>`;

    // Composite text SVG onto source image
    return sharp(sourceBuffer)
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .png()
      .toBuffer();
  }

  /**
   * Parse position keywords from a prompt to determine which region of the image to mask.
   * Returns normalized coordinates (0-1) for the mask region.
   *
   * Keywords: top, bottom, left, right, center, corner, middle
   * Examples:
   *   "Write 'Hello' at the top right corner" → top-right quadrant
   *   "Add text at the bottom" → bottom strip
   *   "Change the background" → full image
   */
  _parsePositionFromPrompt(prompt) {
    const p = prompt.toLowerCase();

    const hasTop = /\btop\b/.test(p);
    const hasBottom = /\bbottom\b/.test(p);
    const hasLeft = /\bleft\b/.test(p);
    const hasRight = /\bright\b/.test(p);
    const hasCenter = /\bcenter\b|\bmiddle\b|\bcentre\b/.test(p);

    // Determine vertical position (tighter regions to avoid over-editing)
    let y = 0, h = 1; // default: full height
    if (hasTop && !hasBottom) { y = 0; h = 0.25; }
    else if (hasBottom && !hasTop) { y = 0.75; h = 0.25; }
    else if (hasCenter && !hasTop && !hasBottom) { y = 0.3; h = 0.4; }

    // Determine horizontal position
    let x = 0, w = 1; // default: full width
    if (hasLeft && !hasRight) { x = 0; w = 0.3; }
    else if (hasRight && !hasLeft) { x = 0.7; w = 0.3; }
    else if (hasCenter && !hasLeft && !hasRight) { x = 0.3; w = 0.4; }

    // Build label for logging
    const vLabel = hasTop ? 'top' : hasBottom ? 'bottom' : hasCenter ? 'center' : 'full';
    const hLabel = hasLeft ? 'left' : hasRight ? 'right' : hasCenter ? 'center' : 'full';
    const label = vLabel === 'full' && hLabel === 'full' ? 'full image' : `${vLabel}-${hLabel}`;

    return { x, y, w, h, label };
  }

  /**
   * Generate a black-and-white mask image using Sharp.
   * Black pixels = area to inpaint, white pixels = area to preserve.
   *
   * @param {number} width - Image width in pixels
   * @param {number} height - Image height in pixels
   * @param {object} region - { x, y, w, h } normalized 0-1 coordinates
   * @returns {Buffer} PNG mask buffer
   */
  async _generateMask(width, height, region) {
    const rectX = Math.round(region.x * width);
    const rectY = Math.round(region.y * height);
    const rectW = Math.round(region.w * width);
    const rectH = Math.round(region.h * height);

    // Build mask with raw pixel buffers — guarantees pure black/white, no anti-aliasing
    // Start with all white (0xFF = preserve)
    const pixels = Buffer.alloc(width * height * 3, 0xFF);

    // Paint the inpaint region black (0x00 = repaint)
    for (let row = rectY; row < Math.min(rectY + rectH, height); row++) {
      for (let col = rectX; col < Math.min(rectX + rectW, width); col++) {
        const offset = (row * width + col) * 3;
        pixels[offset] = 0;     // R
        pixels[offset + 1] = 0; // G
        pixels[offset + 2] = 0; // B
      }
    }

    return sharp(pixels, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer();
  }

  // ============================================
  // BRAND KIT ANALYSIS
  // ============================================

  /**
   * Analyze training images to extract a Brand Kit: color palette, people, logos, style, summary.
   * Uses node-vibrant for pixel-accurate color extraction and Gemini 3 Flash for semantic analysis.
   *
   * @param {string} jobId - Training job ID
   * @param {string} userId - User ID (for DB updates)
   * @param {string[]} imageUrls - Training image URLs to analyze
   * @param {string|null} adAccountId - Ad account ID (needed for visual asset storage paths)
   * @returns {object} Brand kit data
   */
  async analyzeBrandKit(jobId, userId, imageUrls, adAccountId = null) {
    if (!imageUrls || imageUrls.length === 0) {
      logger.warn(`Brand kit analysis skipped for job ${jobId}: no image URLs`);
      return null;
    }

    logger.info(`Starting brand kit analysis for job ${jobId} (${imageUrls.length} images)`);

    // Load existing brand kit (if any) to preserve data on partial failure
    const existingJob = await getMediaTrainingJobById(jobId, userId);
    const existingKit = existingJob?.brand_kit || {};

    // Run color extraction and semantic analysis in parallel
    const [colorPalette, semanticAnalysis] = await Promise.all([
      this._extractColorPalette(imageUrls),
      this._analyzeSemantics(imageUrls)
    ]);

    // Merge results — if semantic analysis failed (null), preserve existing text data
    const semanticFailed = !semanticAnalysis;
    const brandKit = {
      color_palette: colorPalette.length > 0 ? colorPalette : (existingKit.color_palette || []),
      people: semanticFailed ? (existingKit.people || []) : (semanticAnalysis.people || []),
      logos: semanticFailed ? (existingKit.logos || []) : (semanticAnalysis.logos || []),
      style_characteristics: semanticFailed ? (existingKit.style_characteristics || {}) : (semanticAnalysis.style_characteristics || {}),
      brand_summary: semanticFailed ? (existingKit.brand_summary || '') : (semanticAnalysis.brand_summary || ''),
      extracted_assets: [],
      asset_extraction_status: adAccountId ? 'pending' : 'skipped',
      analyzed_at: new Date().toISOString()
    };

    if (semanticFailed) {
      logger.warn(`Semantic analysis failed for job ${jobId} — preserving existing text data`);
    }

    // Persist text-based brand kit immediately (don't wait for visual asset extraction)
    await updateMediaTrainingJob(jobId, userId, { brand_kit: brandKit });
    logger.info(`Brand kit analysis completed for job ${jobId}: ${brandKit.color_palette.length} colors, ${brandKit.people.length} people, ${brandKit.logos.length} logos${semanticFailed ? ' (preserved from previous)' : ''}`);

    // Fire visual asset extraction non-blocking (crop + rembg pipeline)
    if (adAccountId && this.replicate) {
      this._extractVisualAssets(jobId, userId, adAccountId, imageUrls).catch(err => {
        logger.warn(`Visual asset extraction failed (non-blocking): ${err.message}`);
        this._updateBrandKitField(jobId, userId, { asset_extraction_status: 'failed' }).catch(() => {});
      });
    }

    return brandKit;
  }

  /**
   * Extract dominant brand colors from training images using node-vibrant.
   * Aggregates swatches across all images, deduplicates similar colors, and ranks by frequency.
   *
   * @param {string[]} imageUrls - Image URLs to analyze
   * @returns {Array<{hex: string, name: string, usage: string, population: number}>}
   */
  async _extractColorPalette(imageUrls) {
    const allSwatches = [];

    // Process all images (node-vibrant can work from URLs directly)
    const results = await Promise.allSettled(
      imageUrls.map(async (url) => {
        try {
          const palette = await Vibrant.from(url).getPalette();
          return palette;
        } catch (err) {
          logger.warn(`Vibrant failed for ${url}: ${err.message}`);
          return null;
        }
      })
    );

    // Collect all swatch entries across images
    const swatchNames = ['Vibrant', 'DarkVibrant', 'LightVibrant', 'Muted', 'DarkMuted', 'LightMuted'];
    for (const result of results) {
      if (result.status !== 'fulfilled' || !result.value) continue;
      const palette = result.value;
      for (const name of swatchNames) {
        const swatch = palette[name];
        if (swatch) {
          allSwatches.push({
            hex: swatch.hex,
            population: swatch.population,
            swatchType: name
          });
        }
      }
    }

    if (allSwatches.length === 0) {
      logger.warn('No color swatches extracted from any images');
      return [];
    }

    // Deduplicate similar colors (ΔE < 25 in simple RGB distance)
    const deduped = this._deduplicateColors(allSwatches);

    // Sort by population (frequency) and take top 8
    deduped.sort((a, b) => b.population - a.population);
    const topColors = deduped.slice(0, 8);

    // Assign usage roles based on swatch type dominance
    return topColors.map((color, idx) => ({
      hex: color.hex,
      name: this._colorName(color.hex),
      usage: this._assignColorRole(color, idx),
      population: color.population
    }));
  }

  /**
   * Deduplicate similar colors by grouping those within a simple RGB distance threshold.
   * Keeps the variant with the highest population.
   */
  _deduplicateColors(swatches) {
    const groups = [];
    const threshold = 50; // RGB distance threshold for "similar enough"

    for (const swatch of swatches) {
      const rgb = this._hexToRgb(swatch.hex);
      let merged = false;

      for (const group of groups) {
        const gRgb = this._hexToRgb(group.hex);
        const dist = Math.sqrt(
          Math.pow(rgb.r - gRgb.r, 2) +
          Math.pow(rgb.g - gRgb.g, 2) +
          Math.pow(rgb.b - gRgb.b, 2)
        );
        if (dist < threshold) {
          group.population += swatch.population;
          // Keep the hex with higher individual population
          if (swatch.population > group.maxPopulation) {
            group.hex = swatch.hex;
            group.maxPopulation = swatch.population;
          }
          // Track dominant swatch type
          group.swatchTypes.push(swatch.swatchType);
          merged = true;
          break;
        }
      }

      if (!merged) {
        groups.push({
          hex: swatch.hex,
          population: swatch.population,
          maxPopulation: swatch.population,
          swatchTypes: [swatch.swatchType]
        });
      }
    }

    return groups;
  }

  _hexToRgb(hex) {
    const c = hex.replace('#', '');
    return {
      r: parseInt(c.substr(0, 2), 16),
      g: parseInt(c.substr(2, 2), 16),
      b: parseInt(c.substr(4, 2), 16)
    };
  }

  /**
   * Assign a usage role (primary, secondary, accent, background) based on swatch type and rank.
   */
  _assignColorRole(color, index) {
    const types = color.swatchTypes || [];
    const hasVibrant = types.some(t => t === 'Vibrant');
    const hasDark = types.some(t => t.startsWith('Dark'));
    const hasMuted = types.some(t => t.includes('Muted'));
    const hasLight = types.some(t => t.startsWith('Light'));

    if (index === 0) return 'primary';
    if (index === 1) return 'secondary';
    if (hasVibrant || hasLight) return 'accent';
    if (hasMuted || hasDark) return 'background';
    return index < 4 ? 'accent' : 'neutral';
  }

  /**
   * Simple color naming based on HSL hue ranges.
   */
  _colorName(hex) {
    const rgb = this._hexToRgb(hex);
    const r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;

    if (d < 0.05) {
      if (l > 0.9) return 'White';
      if (l < 0.15) return 'Black';
      return 'Gray';
    }

    let h = 0;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;

    const s = d / (1 - Math.abs(2 * l - 1));

    if (s < 0.15) {
      if (l > 0.8) return 'Off White';
      if (l < 0.2) return 'Charcoal';
      return 'Gray';
    }

    const prefix = l < 0.3 ? 'Dark ' : l > 0.7 ? 'Light ' : '';

    if (h < 15 || h >= 345) return `${prefix}Red`;
    if (h < 40) return `${prefix}Orange`;
    if (h < 65) return `${prefix}Yellow`;
    if (h < 160) return `${prefix}Green`;
    if (h < 195) return `${prefix}Teal`;
    if (h < 255) return `${prefix}Blue`;
    if (h < 290) return `${prefix}Purple`;
    if (h < 345) return `${prefix}Pink`;
    return `${prefix}Red`;
  }

  /**
   * Semantic analysis of training images using Gemini 3 Flash vision.
   * Extracts people/personas, logos, style characteristics, and brand summary.
   *
   * @param {string[]} imageUrls - All training image URLs
   * @returns {object|null} Parsed semantic analysis
   */
  async _analyzeSemantics(imageUrls) {
    const googleApiKey = process.env.GOOGLE_AI_STUDIO_API_KEY;
    if (!googleApiKey) {
      logger.warn('Brand kit semantic analysis skipped — GOOGLE_AI_STUDIO_API_KEY not set');
      return null;
    }

    // Download ALL training images as base64 — no sampling, so nothing is missed
    const imageParts = [];
    for (const url of imageUrls) {
      try {
        const resp = await axios.get(url, {
          responseType: 'arraybuffer',
          timeout: 15000,
          headers: { 'User-Agent': 'NewsAgentSaaS/1.0' }
        });
        const contentType = resp.headers['content-type'] || '';
        let mimeType = 'image/jpeg';
        if (contentType.includes('png')) mimeType = 'image/png';
        else if (contentType.includes('webp')) mimeType = 'image/webp';

        imageParts.push({
          inlineData: {
            mimeType,
            data: Buffer.from(resp.data).toString('base64')
          }
        });
      } catch (err) {
        logger.warn(`Failed to download image for brand kit analysis: ${url} — ${err.message}`);
      }
    }

    if (imageParts.length === 0) {
      logger.warn('No images could be downloaded for semantic analysis');
      return null;
    }

    // Build Gemini request with all images + structured prompt
    const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent';

    const prompt = `You are a brand identity analyst. Analyze these ${imageParts.length} brand reference images and extract brand identity elements.

Do NOT analyze colors — that is handled separately. Focus ONLY on:

1. **People/Personas**: If any people appear across the images, describe each distinct person briefly (appearance, apparent role like founder/model/mascot). Note how many images each person appears in.
2. **Logos & Brand Marks**: If any logos, wordmarks, icons, or brand symbols are visible, describe each one (what it looks like, its style — wordmark/icon/combination/emblem, any associated colors as hex codes).
3. **Style Characteristics**: Describe the overall visual style:
   - overall_aesthetic: General look and feel
   - photography_style: If photos, describe the photography approach
   - illustration_style: If illustrations, describe the illustration approach
   - typography_hints: Any visible text styles (serif, sans-serif, handwritten, etc.)
   - mood: The emotional tone (professional, playful, luxurious, minimal, bold, etc.)
   - visual_motifs: Recurring patterns, textures, shapes, or compositional elements
4. **Brand Summary**: 2-3 sentence summary of the brand identity based on what you see.

Return ONLY valid JSON (no markdown fences, no explanation) in this exact structure:
{
  "people": [{"description": "...", "role": "founder|model|mascot|employee|other", "appears_in": 1}],
  "logos": [{"description": "...", "style": "wordmark|icon|combination|emblem", "colors": ["#hex"]}],
  "style_characteristics": {
    "overall_aesthetic": "...",
    "photography_style": "...",
    "illustration_style": "...",
    "typography_hints": "...",
    "mood": "...",
    "visual_motifs": "..."
  },
  "brand_summary": "..."
}

If no people are found, return empty array for "people". Same for "logos". Never omit a field — use empty string or empty array.`;

    const parts = [...imageParts, { text: prompt }];

    try {
      const response = await axios.post(endpoint, {
        contents: [{ parts }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 8192 // Needs headroom for detailed analysis across all training images
        }
      }, {
        headers: {
          'x-goog-api-key': googleApiKey,
          'Content-Type': 'application/json'
        },
        timeout: 60000 // 60s — multi-image analysis can be slower
      });

      const rawText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!rawText) {
        logger.warn('Gemini returned empty response for brand kit semantic analysis');
        return null;
      }

      // Parse JSON — robustly handle markdown fences and truncated responses
      let jsonStr = rawText;
      const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenceMatch) {
        jsonStr = fenceMatch[1].trim();
      } else if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '').trim();
      }
      const firstBrace = jsonStr.indexOf('{');
      const lastBrace = jsonStr.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
      }

      let parsed;
      try {
        parsed = JSON.parse(jsonStr);
      } catch (parseErr) {
        // Attempt to repair truncated JSON — close any open arrays/objects
        logger.warn(`Semantic JSON parse failed, attempting truncation repair: ${parseErr.message}`);
        const lastCompleteObj = jsonStr.lastIndexOf('}');
        if (lastCompleteObj > 0) {
          const repaired = jsonStr.slice(0, lastCompleteObj + 1) + '}';
          try {
            parsed = JSON.parse(repaired);
            logger.info('Semantic JSON repaired successfully — recovered partial data');
          } catch {
            throw parseErr;
          }
        } else {
          throw parseErr;
        }
      }
      logger.info(`Semantic analysis: ${(parsed.people || []).length} people, ${(parsed.logos || []).length} logos`);
      return parsed;
    } catch (err) {
      if (err instanceof SyntaxError) {
        logger.error(`Brand kit semantic analysis: JSON parse error — ${err.message}`);
      } else {
        logger.error(`Brand kit semantic analysis failed: ${err.message}`);
      }
      return null;
    }
  }

  // ============================================
  // VISUAL ASSET EXTRACTION (Cutout PNGs)
  // ============================================

  /**
   * Detect bounding boxes for people, logos, and recurring graphics in training images.
   * Uses Gemini 3 Flash vision with a structured prompt requesting normalized coordinates.
   *
   * @param {string[]} imageUrls - All training image URLs
   * @returns {Array<{image_index, type, description, confidence, bounding_box}>}
   */
  async _detectAssetBoundingBoxes(imageUrls) {
    const googleApiKey = process.env.GOOGLE_AI_STUDIO_API_KEY;
    if (!googleApiKey) {
      logger.warn('Asset bounding box detection skipped — GOOGLE_AI_STUDIO_API_KEY not set');
      return [];
    }

    // Download all images as base64
    const imageParts = [];
    for (const url of imageUrls) {
      try {
        const resp = await axios.get(url, {
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
      } catch (err) {
        logger.warn(`Failed to download image for bbox detection: ${url} — ${err.message}`);
        imageParts.push(null); // Placeholder to preserve indexing
      }
    }

    const validParts = imageParts.filter(p => p !== null);
    if (validParts.length === 0) {
      logger.warn('No images could be downloaded for bounding box detection');
      return [];
    }

    const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent';

    // Build image index mapping (skipping failed downloads)
    const indexMap = [];
    imageParts.forEach((p, i) => { if (p) indexMap.push(i); });

    const prompt = `You are a brand asset detection system. Analyze these ${validParts.length} brand reference images and detect visual elements that can be extracted as individual assets.

For EACH detected element, return its bounding box as [y_min, x_min, y_max, x_max] where each value is 0-1000 (normalized to image dimensions).

Detect these element types:
1. **person** — Any person (face and body). Include head-to-waist minimum. Be generous with the bounding box.
2. **logo** — Any logo, wordmark, icon, or brand symbol. Crop tightly around the logo.
3. **graphic** — Distinctive recurring graphic elements, illustrations, icons, or visual motifs that appear recognizable and extractable.

Return ONLY valid JSON (no markdown fences):
{
  "detections": [
    {
      "image_index": 0,
      "type": "person",
      "description": "brief description",
      "confidence": 0.95,
      "bounding_box": [100, 200, 800, 600]
    }
  ]
}

Rules:
- image_index is 0-based position in the image sequence provided
- Only include detections with confidence >= 0.7
- Maximum 3 detections per image
- Bounding boxes must have some padding around the element (5-10%)
- If the same person or logo appears in multiple images, detect it in EACH image but add a "group_id" field (e.g., "person_A", "logo_main") so duplicates can be identified
- For people, always include full head and at least to waist
- For logos, be as tight as possible around the logo boundary`;

    const parts = [...validParts, { text: prompt }];

    try {
      const response = await axios.post(endpoint, {
        contents: [{ parts }],
        generationConfig: {
          temperature: 0.1, // Low temp for precise coordinate detection
          maxOutputTokens: 8192 // Needs headroom for bboxes across all training images
        }
      }, {
        headers: {
          'x-goog-api-key': googleApiKey,
          'Content-Type': 'application/json'
        },
        timeout: 90000 // 90s for multi-image bbox detection
      });

      const rawText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!rawText) {
        logger.warn('Gemini returned empty response for bbox detection');
        return [];
      }

      // Strip markdown fences and extract JSON robustly
      let jsonStr = rawText;
      // Try fence extraction first
      const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenceMatch) {
        jsonStr = fenceMatch[1].trim();
      } else if (jsonStr.startsWith('```')) {
        // Fence opened but not closed (truncated) — strip opening fence
        jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '').trim();
      }
      // Find first { to last } as fallback
      const firstBrace = jsonStr.indexOf('{');
      const lastBrace = jsonStr.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
      }

      let parsed;
      try {
        parsed = JSON.parse(jsonStr);
      } catch (parseErr) {
        // Attempt to repair truncated JSON — find last complete object in the detections array
        logger.warn(`Bbox JSON parse failed, attempting truncation repair: ${parseErr.message}`);
        const lastCompleteObj = jsonStr.lastIndexOf('}');
        if (lastCompleteObj > 0) {
          const repaired = jsonStr.slice(0, lastCompleteObj + 1) + ']}';
          try {
            parsed = JSON.parse(repaired);
            logger.info(`Bbox JSON repaired successfully — recovered partial detections`);
          } catch {
            throw parseErr; // Re-throw original error if repair also fails
          }
        } else {
          throw parseErr;
        }
      }
      let detections = parsed.detections || [];

      // Remap image_index from sequential Gemini index to original image array index
      detections = detections.map(d => ({
        ...d,
        image_index: indexMap[d.image_index] !== undefined ? indexMap[d.image_index] : d.image_index
      }));

      // Filter by confidence
      detections = detections.filter(d => d.confidence >= ASSET_CONFIDENCE_THRESHOLD);

      // Deduplicate: for each group_id, keep only the highest confidence detection
      const groupBest = new Map();
      const ungrouped = [];
      for (const d of detections) {
        if (d.group_id) {
          const existing = groupBest.get(d.group_id);
          if (!existing || d.confidence > existing.confidence) {
            groupBest.set(d.group_id, d);
          }
        } else {
          ungrouped.push(d);
        }
      }
      detections = [...groupBest.values(), ...ungrouped];

      // Cap total
      detections = detections.slice(0, MAX_BRAND_KIT_ASSETS);

      logger.info(`Bounding box detection: ${detections.length} assets detected (${detections.filter(d => d.type === 'person').length} people, ${detections.filter(d => d.type === 'logo').length} logos, ${detections.filter(d => d.type === 'graphic').length} graphics)`);
      return detections;
    } catch (err) {
      if (err instanceof SyntaxError) {
        logger.error(`Bbox detection: JSON parse error — ${err.message}`);
      } else {
        logger.error(`Bbox detection failed: ${err.message}`);
      }
      return [];
    }
  }

  /**
   * Full visual asset extraction pipeline:
   * 1. Detect bounding boxes via Gemini
   * 2. Crop each detection using Sharp
   * 3. Remove background via Replicate rembg
   * 4. Upload transparent PNGs to Supabase Storage
   * 5. Persist asset URLs in brand_kit JSONB
   *
   * @param {string} jobId
   * @param {string} userId
   * @param {string} adAccountId
   * @param {string[]} imageUrls
   */
  async _extractVisualAssets(jobId, userId, adAccountId, imageUrls) {
    logger.info(`Starting visual asset extraction for job ${jobId}`);

    // Clean up previous cutout files from storage (if re-analyzing)
    try {
      const existingJob = await getMediaTrainingJobById(jobId, userId);
      const oldAssets = existingJob?.brand_kit?.extracted_assets || [];
      if (oldAssets.length > 0) {
        const oldPaths = oldAssets.map(a => a.storage_path).filter(Boolean);
        if (oldPaths.length > 0) {
          await supabaseAdmin.storage.from(STORAGE_BUCKET).remove(oldPaths);
          logger.info(`Cleaned up ${oldPaths.length} old cutout files before re-extraction`);
        }
      }
    } catch (cleanupErr) {
      logger.warn(`Failed to clean up old cutouts (non-blocking): ${cleanupErr.message}`);
    }

    // Update status to processing
    await this._updateBrandKitField(jobId, userId, { asset_extraction_status: 'processing' });

    // Step 1: Detect bounding boxes
    const detections = await this._detectAssetBoundingBoxes(imageUrls);
    if (detections.length === 0) {
      logger.info(`No visual assets detected for job ${jobId}`);
      await this._updateBrandKitField(jobId, userId, {
        asset_extraction_status: 'completed',
        extracted_assets: []
      });
      return;
    }

    // Download source images into a cache (avoid re-downloading for multiple detections in same image)
    const imageCache = new Map();
    const uniqueImageIndices = [...new Set(detections.map(d => d.image_index))];
    await Promise.allSettled(uniqueImageIndices.map(async (idx) => {
      try {
        const resp = await axios.get(imageUrls[idx], {
          responseType: 'arraybuffer',
          timeout: 20000,
          headers: { 'User-Agent': 'NewsAgentSaaS/1.0' }
        });
        imageCache.set(idx, Buffer.from(resp.data));
      } catch (err) {
        logger.warn(`Failed to download source image ${idx} for cropping: ${err.message}`);
      }
    }));

    // Step 2-4: Process detections sequentially to preserve detection→image pairing
    // Pace at ~5 per minute to stay under Replicate rate limits (6/min with <$5 credit)
    const extractedAssets = [];
    for (let i = 0; i < detections.length; i++) {
      try {
        const asset = await this._processOneDetection(detections[i], i, jobId, userId, adAccountId, imageCache);
        if (asset) {
          extractedAssets.push(asset);
        }
      } catch (err) {
        logger.warn(`Detection ${i} failed: ${err.message}`);
      }
      // Pace requests: wait 4s between rembg calls (~15/min, safe for $5+ credit tier)
      if (i < detections.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 4000));
      }
    }

    // Step 5: Persist results
    const status = extractedAssets.length > 0 ? 'completed' : 'failed';
    await this._updateBrandKitField(jobId, userId, {
      extracted_assets: extractedAssets,
      asset_extraction_status: status
    });

    logger.info(`Visual asset extraction completed for job ${jobId}: ${extractedAssets.length} assets extracted`);
  }

  /**
   * Process a single detection: crop → rembg → upload → return asset record.
   */
  async _processOneDetection(detection, index, jobId, userId, adAccountId, imageCache) {
    const sourceBuffer = imageCache.get(detection.image_index);
    if (!sourceBuffer) {
      logger.warn(`Source image ${detection.image_index} not available for detection ${index}`);
      return null;
    }

    try {
      // Get source image dimensions
      const metadata = await sharp(sourceBuffer).metadata();
      const imgWidth = metadata.width;
      const imgHeight = metadata.height;

      // Convert normalized bbox [y_min, x_min, y_max, x_max] (0-1000) to pixel coordinates
      const [yMinNorm, xMinNorm, yMaxNorm, xMaxNorm] = detection.bounding_box;
      let left = Math.round((xMinNorm / 1000) * imgWidth);
      let top = Math.round((yMinNorm / 1000) * imgHeight);
      let right = Math.round((xMaxNorm / 1000) * imgWidth);
      let bottom = Math.round((yMaxNorm / 1000) * imgHeight);

      // Add 5% padding
      const padX = Math.round((right - left) * 0.05);
      const padY = Math.round((bottom - top) * 0.05);
      left = Math.max(0, left - padX);
      top = Math.max(0, top - padY);
      right = Math.min(imgWidth, right + padX);
      bottom = Math.min(imgHeight, bottom + padY);

      const cropWidth = right - left;
      const cropHeight = bottom - top;

      if (cropWidth < 20 || cropHeight < 20) {
        logger.warn(`Detection ${index} crop too small (${cropWidth}x${cropHeight}), skipping`);
        return null;
      }

      // Crop the detection region
      const croppedBuffer = await sharp(sourceBuffer)
        .extract({ left, top, width: cropWidth, height: cropHeight })
        .png()
        .toBuffer();

      // Upload crop to temporary path for rembg
      const tmpPath = `${userId}/${adAccountId}/brand-kit/${jobId}/tmp-${crypto.randomUUID()}.png`;
      await this.ensureBucket();
      const { error: tmpUploadErr } = await supabaseAdmin.storage
        .from(STORAGE_BUCKET)
        .upload(tmpPath, croppedBuffer, { contentType: 'image/png', upsert: false });

      if (tmpUploadErr) {
        logger.warn(`Failed to upload temp crop for detection ${index}: ${tmpUploadErr.message}`);
        return null;
      }

      const { data: tmpUrlData } = supabaseAdmin.storage
        .from(STORAGE_BUCKET)
        .getPublicUrl(tmpPath);
      const tmpUrl = tmpUrlData.publicUrl;

      // Run background removal via Replicate (with retry for rate limits)
      let finalBuffer;
      const maxRetries = 3;
      let rembgSuccess = false;

      for (let attempt = 0; attempt < maxRetries && !rembgSuccess; attempt++) {
        try {
          const rembgOutput = await this.replicate.run(REMBG_MODEL, {
            input: { image: tmpUrl }
          });

          // rembg output is a ReadableStream or URL — download the result
          if (typeof rembgOutput === 'string') {
            const rembgResp = await axios.get(rembgOutput, { responseType: 'arraybuffer', timeout: 30000 });
            finalBuffer = Buffer.from(rembgResp.data);
          } else if (rembgOutput && typeof rembgOutput[Symbol.asyncIterator] === 'function') {
            const chunks = [];
            for await (const chunk of rembgOutput) {
              chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'base64') : chunk);
            }
            finalBuffer = Buffer.concat(chunks);
          } else if (Buffer.isBuffer(rembgOutput)) {
            finalBuffer = rembgOutput;
          } else {
            logger.warn(`Unexpected rembg output type for detection ${index}, using cropped version`);
            finalBuffer = croppedBuffer;
          }
          rembgSuccess = true;
        } catch (rembgErr) {
          const is429 = rembgErr.message && rembgErr.message.includes('429');
          if (is429 && attempt < maxRetries - 1) {
            // Parse retry_after from error or default to 10s
            const retryMatch = rembgErr.message.match(/retry_after[":]*\s*(\d+)/i);
            const waitSec = retryMatch ? parseInt(retryMatch[1], 10) + 1 : 10;
            logger.info(`Rate limited on detection ${index}, waiting ${waitSec}s before retry (attempt ${attempt + 1}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, waitSec * 1000));
          } else {
            logger.warn(`Rembg failed for detection ${index}: ${rembgErr.message}. Using cropped image instead.`);
            finalBuffer = croppedBuffer;
          }
        }
      }

      // Clean up temp file
      await supabaseAdmin.storage.from(STORAGE_BUCKET).remove([tmpPath]).catch(() => {});

      // Upload final transparent PNG with unique name to avoid cache/overwrite issues
      const uniqueId = crypto.randomUUID().slice(0, 8);
      const finalPath = `${userId}/${adAccountId}/brand-kit/${jobId}/${detection.type}-${index}-${uniqueId}.png`;
      const { error: uploadErr } = await supabaseAdmin.storage
        .from(STORAGE_BUCKET)
        .upload(finalPath, finalBuffer, { contentType: 'image/png', upsert: false });

      if (uploadErr) {
        logger.error(`Failed to upload final asset ${index}: ${uploadErr.message}`);
        return null;
      }

      const { data: finalUrlData } = supabaseAdmin.storage
        .from(STORAGE_BUCKET)
        .getPublicUrl(finalPath);

      return {
        type: detection.type,
        description: detection.description || '',
        url: finalUrlData.publicUrl,
        storage_path: finalPath,
        source_image_index: detection.image_index,
        confidence: detection.confidence,
        bounding_box: detection.bounding_box
      };
    } catch (err) {
      logger.error(`Failed to process detection ${index}: ${err.message}`);
      return null;
    }
  }

  /**
   * Update specific fields in the brand_kit JSONB without overwriting the entire object.
   * Performs a read-modify-write on the brand_kit column.
   */
  async _updateBrandKitField(jobId, userId, updates) {
    try {
      const job = await getMediaTrainingJobById(jobId, userId);
      if (!job) return;

      const currentKit = job.brand_kit || {};
      const updatedKit = { ...currentKit, ...updates };

      await updateMediaTrainingJob(jobId, userId, { brand_kit: updatedKit });
    } catch (err) {
      logger.error(`Failed to update brand_kit field for job ${jobId}: ${err.message}`);
    }
  }
}

// Export singleton
const mediaAssetService = new MediaAssetService();
export default mediaAssetService;
