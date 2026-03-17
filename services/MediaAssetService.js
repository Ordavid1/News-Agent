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
import { supabaseAdmin } from './supabase.js';
import {
  getUserMediaAssets,
  createMediaAsset,
  deleteMediaAsset as dbDeleteMediaAsset,
  countMediaAssets,
  getMediaTrainingJobById,
  getMediaTrainingJobs,
  getActiveMediaTrainingJob,
  createMediaTrainingJob,
  updateMediaTrainingJob,
  setDefaultTrainingJob,
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

// Replicate trainer model
const TRAINER_OWNER = 'ostris';
const TRAINER_NAME = 'flux-dev-lora-trainer';

// Selective layer training — for subject LoRAs only (proven across 50+ A/B tests)
// Style LoRAs train ALL layers to capture complex brand identity (colors, layout, illustration style)
const SUBJECT_LAYERS_TO_OPTIMIZE = 'transformer.single_transformer_blocks.(7|12|16|20).proj_out';

// Training type presets — optimized per research (2025-2026 best practices)
const TRAINING_PRESETS = {
  style: {
    lora_rank: 32,               // Brand identity needs full capacity (colors, illustration, layout, characters)
    steps_per_image: 35,         // ~35 steps per training image for deeper style learning
    min_steps: 1000,
    max_steps: 2500,
    caption_dropout_rate: 0.15,  // Higher dropout forces trigger→style association over content memorization
    layers_to_optimize_regex: null  // null = train ALL layers — essential for complex brand styles
  },
  subject: {
    lora_rank: 32,               // Subjects/products need higher capacity
    steps_per_image: 40,         // ~40 steps per training image
    min_steps: 1000,
    max_steps: 2000,
    caption_dropout_rate: 0.05,  // Lower dropout — captions help subject identity
    layers_to_optimize_regex: SUBJECT_LAYERS_TO_OPTIMIZE  // Selective training works well for subjects
  }
};

// Generation defaults
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
   * @param {string} trainingType - 'style' or 'subject' (determines preset params)
   * @returns {object} Training job record
   */
  async startTraining(userId, adAccountId, name, trainingType = 'subject') {
    if (!this.replicate) {
      throw new Error('Replicate not configured. Set REPLICATE_API_TOKEN environment variable.');
    }
    if (!this.replicateOwner) {
      throw new Error('Replicate model owner not configured. Set REPLICATE_MODEL_OWNER environment variable.');
    }

    // Check minimum images
    const assetCount = await countMediaAssets(userId, adAccountId);
    if (assetCount < MIN_TRAINING_IMAGES) {
      throw new Error(`At least ${MIN_TRAINING_IMAGES} images are required for training. Currently have ${assetCount}.`);
    }

    // Concurrency guard: only one active training per account at a time
    const activeJob = await getActiveMediaTrainingJob(userId, adAccountId);
    if (activeJob) {
      throw new Error('A training is already in progress for this account. Please wait for it to complete.');
    }

    // Gather all image URLs (shared pool, snapshot for audit trail)
    const assets = await getUserMediaAssets(userId, adAccountId);
    const imageUrls = assets.map(a => a.public_url);

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

    // Resolve training preset (style vs subject)
    const validType = TRAINING_PRESETS[trainingType] ? trainingType : 'subject';
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
          creditsTotal: 6,
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
        logger.info(`Auto-granted 6 free generation credits for training ${jobId} (user ${userId})`);
      } catch (creditErr) {
        // Non-fatal: training succeeded, credits can be manually reconciled
        // Idempotency key prevents duplicate grants on re-polls
        if (creditErr.code === '23505') {
          logger.info(`Free credits already granted for training ${jobId} (idempotency)`);
        } else {
          logger.error(`Failed to auto-grant generation credits for training ${jobId}: ${creditErr.message}`);
        }
      }
    }

    return {
      ...updatedJob,
      progress
    };
  }

  /**
   * Get all training jobs for an ad account.
   */
  async getTrainingJobs(userId, adAccountId) {
    return getMediaTrainingJobs(userId, adAccountId);
  }

  /**
   * Get a specific training job by ID.
   */
  async getTrainingJobById(jobId, userId) {
    return getMediaTrainingJobById(jobId, userId);
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
  // GENERATION
  // ============================================

  /**
   * Generate image(s) using a specific trained LoRA model.
   *
   * @param {string} userId
   * @param {string} adAccountId
   * @param {string} prompt
   * @param {string} trainingJobId - Which training session to generate from
   * @param {object} options - Optional generation parameters
   * @param {number} options.loraScale - LoRA influence strength (0.5-1.5, default 1.0)
   * @param {number} options.guidanceScale - Prompt adherence (1.0-5.0, default 3.0)
   * @param {number} options.numOutputs - Number of images to generate (1-4, default 1)
   * @param {string} options.aspectRatio - Aspect ratio (1:1, 16:9, 9:16, 4:5, 5:4, 3:2, 2:3, 4:3, 3:4)
   * @returns {object|object[]} Generated media record(s) — single object when numOutputs=1, array otherwise
   */
  async generateImage(userId, adAccountId, prompt, trainingJobId, options = {}) {
    if (!this.replicate) {
      throw new Error('Replicate not configured.');
    }

    // Get the specific training job
    const job = await getMediaTrainingJobById(trainingJobId, userId);
    if (!job || job.status !== 'completed') {
      throw new Error('Selected training session is not completed or not found.');
    }

    if (!job.replicate_model_version) {
      throw new Error('Training completed but no model version was recorded.');
    }

    // Auto-inject trigger word if not already present in the prompt.
    // The trigger word is essential for the LoRA to activate the brand style.
    let finalPrompt = prompt;
    if (job.trigger_word && !prompt.toLowerCase().includes(job.trigger_word.toLowerCase())) {
      finalPrompt = `in the style of ${job.trigger_word}, ${prompt}`;
      logger.info(`Trigger word "${job.trigger_word}" auto-injected into prompt`);
    }

    // Build the model reference — use stored model name if available
    const modelName = job.replicate_model_name
      || `${this.replicateOwner}/media-lora-${adAccountId.replace(/-/g, '').slice(0, 16)}`;
    const modelRef = job.replicate_model_version.includes('/')
      ? job.replicate_model_version
      : `${modelName}:${job.replicate_model_version}`;

    // Resolve generation parameters with clamped defaults
    const loraScale = typeof options.loraScale === 'number'
      ? Math.max(0.5, Math.min(1.5, options.loraScale))
      : DEFAULT_LORA_SCALE;
    const guidanceScale = typeof options.guidanceScale === 'number'
      ? Math.max(1.0, Math.min(5.0, options.guidanceScale))
      : DEFAULT_GUIDANCE_SCALE;
    const numOutputs = typeof options.numOutputs === 'number'
      ? Math.max(1, Math.min(4, Math.floor(options.numOutputs)))
      : 1;

    // Validate aspect ratio against supported values
    const VALID_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:5', '5:4', '3:2', '2:3', '4:3', '3:4', '21:9', '9:21'];
    const aspectRatio = VALID_ASPECT_RATIOS.includes(options.aspectRatio)
      ? options.aspectRatio
      : '1:1';

    logger.info(`Generating ${numOutputs} image(s) with model ${modelRef}, lora_scale=${loraScale}, guidance=${guidanceScale}, aspect=${aspectRatio}, prompt: "${finalPrompt.slice(0, 80)}..."`);

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
            current: Math.round(pct * TRAINING_PRESETS.subject.min_steps),
            total: TRAINING_PRESETS.subject.min_steps,
            percentage: pct
          };
        }
      }
    } catch {
      // Ignore parse errors
    }
    return null;
  }
}

// Export singleton
const mediaAssetService = new MediaAssetService();
export default mediaAssetService;
