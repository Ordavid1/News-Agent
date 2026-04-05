// services/HeyGenService.js
// HeyGen API wrapper for AI avatar video generation.
// Uses Photo Avatar Groups for persistent brand personas and Avatar IV
// for high-quality talking-head videos with lip sync.

import axios from 'axios';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[HeyGenService] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

const BASE_URL = 'https://api.heygen.com';

// Polling configuration
const POLL_INTERVAL_MS = 5000;        // 5 seconds between polls
const MAX_POLL_DURATION_MS = 300000;  // 5 minutes max wait (avatar videos can take a while)

// Avatar training polling
// HeyGen Photo Avatar training typically takes 10-25 minutes depending on queue load.
const TRAINING_POLL_INTERVAL_MS = 20000;   // 20 seconds between polls
const MAX_TRAINING_POLL_MS = 1800000;      // 30 minutes total wait

class HeyGenService {
  constructor() {
    this.apiKey = process.env.HEYGEN_API_KEY;

    if (!this.apiKey) {
      logger.warn('HEYGEN_API_KEY not set — avatar video generation will not be available');
    } else {
      logger.info('HeyGenService initialized');
    }
  }

  /**
   * Get default request headers
   */
  _headers() {
    return {
      'X-Api-Key': this.apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
  }

  // ═══════════════════════════════════════════════════
  // TALKING PHOTO — SIMPLE PATH (no training, no waiting)
  //
  // HeyGen has TWO paths for custom personas:
  //   1. Photo Avatar Groups + train + poll ready (complex, ~10-20min, rejects AI-generated faces)
  //   2. Talking Photo — upload 1 image → instant talking_photo_id → use with Avatar IV motion engine
  //
  // We use path #2 — it's instant, works with real OR AI-generated faces, and supports Avatar IV
  // via `use_avatar_iv_model: true` in /v2/video/generate. This is the production-ready path.
  // ═══════════════════════════════════════════════════

  /**
   * Upload a photo to HeyGen's talking_photo endpoint. Returns a talking_photo_id
   * that can be used IMMEDIATELY in /v2/video/generate (no training step).
   *
   * @param {string} imageUrl - Publicly accessible image URL (face photo)
   * @returns {Promise<{talkingPhotoId: string, talkingPhotoUrl: string}>}
   */
  async uploadTalkingPhoto(imageUrl) {
    if (!this.apiKey) throw new Error('HEYGEN_API_KEY is not configured');

    logger.info(`Uploading talking photo to HeyGen: ${imageUrl.slice(0, 80)}...`);

    // Download the image
    const dl = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30000 });
    const buffer = Buffer.from(dl.data);
    const ct = dl.headers['content-type'] || '';
    let mimeType = 'image/jpeg';
    if (ct.includes('png')) mimeType = 'image/png';
    else if (ct.includes('webp')) mimeType = 'image/webp';

    // Upload to HeyGen's talking_photo endpoint (different from /asset — this one
    // directly creates a usable talking_photo_id).
    const response = await axios.post('https://upload.heygen.com/v1/talking_photo', buffer, {
      headers: {
        'X-Api-Key': this.apiKey,
        'Content-Type': mimeType
      },
      timeout: 60000
    });

    const data = response.data?.data;
    if (!data?.talking_photo_id) {
      logger.error(`HeyGen talking_photo upload response: ${JSON.stringify(response.data)}`);
      throw new Error('HeyGen did not return a talking_photo_id');
    }

    logger.info(`HeyGen talking_photo uploaded — id: ${data.talking_photo_id}`);
    return {
      talkingPhotoId: data.talking_photo_id,
      talkingPhotoUrl: data.talking_photo_url || null
    };
  }

  // ═══════════════════════════════════════════════════
  // PHOTO AVATAR GROUP MANAGEMENT (LEGACY — kept for reference)
  //
  // HeyGen requires a 5-step flow:
  //   1. Upload image(s) to upload.heygen.com/v1/asset → get image_key(s)
  //   2. POST /v2/photo_avatar/avatar_group/create with ONE image_key → get group_id
  //   3. POST /v2/photo_avatar/train with group_id → triggers training
  //   4. GET /v2/photo_avatar/train/status/{group_id} → poll until status=ready
  //   5. GET /v2/avatar_group/{group_id}/avatars → list trained avatars, pick talking_photo_id
  //
  // This path has known issues: AI-generated/synthetic faces get stuck in pending
  // indefinitely (silent content moderation). We use uploadTalkingPhoto() above instead.
  // ═══════════════════════════════════════════════════

  /**
   * Upload a single image to HeyGen and return its image_key.
   * Accepts either a public URL (downloads it first) or a Buffer.
   *
   * @param {string|Buffer} source - Image URL or raw Buffer
   * @param {string} [mimeType='image/jpeg'] - MIME type if source is a Buffer
   * @returns {Promise<string>} image_key usable with avatar_group/create
   */
  async uploadImageAsset(source, mimeType = 'image/jpeg') {
    if (!this.apiKey) throw new Error('HEYGEN_API_KEY is not configured');

    let buffer;
    let finalMime = mimeType;

    if (typeof source === 'string') {
      // Download the image
      logger.info(`Downloading image for HeyGen upload: ${source.slice(0, 80)}...`);
      const dl = await axios.get(source, { responseType: 'arraybuffer', timeout: 30000 });
      buffer = Buffer.from(dl.data);
      const ct = dl.headers['content-type'] || '';
      if (ct.includes('png')) finalMime = 'image/png';
      else if (ct.includes('webp')) finalMime = 'image/webp';
      else finalMime = 'image/jpeg';
    } else {
      buffer = source;
    }

    // Upload to HeyGen assets host (different base URL than api.heygen.com)
    const response = await axios.post('https://upload.heygen.com/v1/asset', buffer, {
      headers: {
        'X-Api-Key': this.apiKey,
        'Content-Type': finalMime
      },
      timeout: 60000
    });

    const imageKey = response.data?.data?.image_key;
    if (!imageKey) {
      logger.error(`HeyGen upload response: ${JSON.stringify(response.data)}`);
      throw new Error('HeyGen upload did not return an image_key');
    }

    logger.info(`HeyGen image uploaded — image_key: ${imageKey}`);
    return imageKey;
  }

  /**
   * Create a Photo Avatar Group from an uploaded image.
   * HeyGen takes a single image_key (not URL or array).
   *
   * @param {string} name - Name for the avatar group
   * @param {string[]} imageUrls - Array of publicly accessible image URLs; the first is used to seed the group
   * @returns {Promise<Object>} { groupId, status }
   */
  async createPhotoAvatarGroup(name, imageUrls) {
    if (!this.apiKey) throw new Error('HEYGEN_API_KEY is not configured');
    if (!imageUrls || imageUrls.length === 0) throw new Error('At least one image URL is required');

    logger.info(`Creating Photo Avatar Group "${name}" — uploading ${imageUrls.length} image(s) to HeyGen...`);

    // Step 1: upload ALL images to HeyGen's asset endpoint to get image_keys
    const imageKeys = [];
    for (const url of imageUrls) {
      const key = await this.uploadImageAsset(url);
      imageKeys.push(key);
    }
    logger.info(`Uploaded ${imageKeys.length} image(s) to HeyGen assets`);

    // Step 2: create the group seeded with the first image_key
    let response;
    try {
      response = await axios.post(`${BASE_URL}/v2/photo_avatar/avatar_group/create`, {
        name,
        image_key: imageKeys[0]
      }, {
        headers: this._headers(),
        timeout: 30000
      });
    } catch (err) {
      if (err.response) {
        logger.error(`HeyGen avatar_group/create ${err.response.status}: ${JSON.stringify(err.response.data)}`);
      }
      throw err;
    }

    // HeyGen v2 responses can use either `group_id` or `id` in `data`
    const data = response.data?.data;
    const groupId = data?.group_id || data?.id;
    if (!groupId) {
      logger.error(`HeyGen create avatar group response: ${JSON.stringify(response.data)}`);
      throw new Error('HeyGen did not return an avatar group ID');
    }

    logger.info(`Photo Avatar Group created — group_id: ${groupId}`);

    // Step 3: add ALL images as looks (training samples) to the group.
    // HeyGen's /avatar_group/add accepts max 4 image_keys per call, so we
    // batch when there are >4 images. Training requires ≥10 looks for reliable
    // results per HeyGen's guidance.
    const BATCH_SIZE = 4;
    const addedLookIds = [];
    try {
      for (let i = 0; i < imageKeys.length; i += BATCH_SIZE) {
        const batch = imageKeys.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const addResponse = await axios.post(`${BASE_URL}/v2/photo_avatar/avatar_group/add`, {
          group_id: groupId,
          image_keys: batch,
          name: `${name} — batch ${batchNum}`
        }, {
          headers: this._headers(),
          timeout: 30000
        });
        const looksList = addResponse.data?.data?.photo_avatar_list || [];
        const batchIds = looksList.map(l => l.id).filter(Boolean);
        addedLookIds.push(...batchIds);
        logger.info(`Added batch ${batchNum} (${batch.length} look(s)) to group ${groupId}`);
      }
      logger.info(`Total ${addedLookIds.length} look(s) added to group ${groupId}`);
    } catch (err) {
      if (err.response) {
        logger.error(`HeyGen avatar_group/add ${err.response.status}: ${JSON.stringify(err.response.data)}`);
      }
      throw err;
    }

    // Step 4: wait for looks to pass moderation before training can start.
    // Newly-added looks begin with status='pending' and must reach 'completed'.
    if (addedLookIds.length > 0) {
      logger.info(`Waiting for ${addedLookIds.length} look(s) to pass moderation...`);
      await this._waitForLooksReady(addedLookIds);
      logger.info(`All looks passed moderation for group ${groupId}`);
    }

    return {
      groupId,
      status: 'pending'
    };
  }

  /**
   * Poll each look's processing status until all are 'completed' (moderation passed).
   * Throws if any look is moderation_rejected or times out.
   * @param {string[]} lookIds
   */
  async _waitForLooksReady(lookIds) {
    const POLL_MS = 5000;
    const MAX_MS = 180000; // 3 minutes
    const started = Date.now();

    while (Date.now() - started < MAX_MS) {
      const statuses = await Promise.all(
        lookIds.map(id => this._getLookStatus(id).catch(err => {
          logger.warn(`Look ${id} status check failed: ${err.message}`);
          return { id, status: 'unknown' };
        }))
      );

      const pending = statuses.filter(s => s.status === 'pending' || s.status === 'unknown');
      const rejected = statuses.filter(s => s.status === 'moderation_rejected');
      const completed = statuses.filter(s => s.status === 'completed' || s.status === 'ready');

      if (rejected.length > 0) {
        throw new Error(`HeyGen moderation rejected ${rejected.length} look(s): ${rejected.map(r => r.id).join(', ')}`);
      }

      if (pending.length === 0 && completed.length === lookIds.length) {
        return;
      }

      const elapsed = ((Date.now() - started) / 1000).toFixed(0);
      logger.info(`Look moderation progress: ${completed.length}/${lookIds.length} ready, ${pending.length} pending (${elapsed}s elapsed)`);
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }

    throw new Error(`Look moderation timed out after ${MAX_MS / 1000}s`);
  }

  /**
   * Get the status of a single photo avatar look.
   */
  async _getLookStatus(lookId) {
    const response = await axios.get(`${BASE_URL}/v2/photo_avatar/${lookId}`, {
      headers: this._headers(),
      timeout: 15000
    });
    const data = response.data?.data;
    return {
      id: lookId,
      status: data?.status || 'unknown',
      moderation_msg: data?.moderation_msg || null
    };
  }

  /**
   * Train a Photo Avatar Group (start the training process).
   * @param {string} groupId
   * @returns {Promise<Object>} { groupId, status }
   */
  async trainPhotoAvatarGroup(groupId) {
    if (!this.apiKey) throw new Error('HEYGEN_API_KEY is not configured');

    logger.info(`Training Photo Avatar Group: ${groupId}`);

    let response;
    try {
      response = await axios.post(`${BASE_URL}/v2/photo_avatar/train`, {
        group_id: groupId
      }, {
        headers: this._headers(),
        timeout: 30000
      });
    } catch (err) {
      if (err.response) {
        logger.error(`HeyGen train API ${err.response.status}: ${JSON.stringify(err.response.data)}`);
      }
      throw err;
    }

    return {
      groupId,
      flowId: response.data?.data?.flow_id || null,
      status: 'training'
    };
  }

  /**
   * Get the status of a Photo Avatar Group's training job.
   * @param {string} groupId
   * @returns {Promise<Object>} { groupId, status, avatarId }
   */
  async getAvatarGroupStatus(groupId) {
    if (!this.apiKey) throw new Error('HEYGEN_API_KEY is not configured');

    const response = await axios.get(`${BASE_URL}/v2/photo_avatar/train/status/${groupId}`, {
      headers: this._headers(),
      timeout: 15000
    });

    const data = response.data?.data;
    return {
      groupId,
      status: data?.status || 'unknown',
      errorMsg: data?.error_msg || null
    };
  }

  /**
   * List all avatars (trained looks) within a photo avatar group.
   * Used after training completes to get the talking_photo_id to use in video generation.
   * @param {string} groupId
   * @returns {Promise<Array>} avatars list
   */
  async listAvatarsInGroup(groupId) {
    if (!this.apiKey) throw new Error('HEYGEN_API_KEY is not configured');

    const response = await axios.get(`${BASE_URL}/v2/avatar_group/${groupId}/avatars`, {
      headers: this._headers(),
      timeout: 15000
    });

    // Response shape: { data: { avatar_list: [...] } }
    const list = response.data?.data?.avatar_list || response.data?.data?.avatars || [];
    return list;
  }

  /**
   * Wait for avatar group training to complete, then fetch the trained avatar_id.
   * @param {string} groupId
   * @returns {Promise<Object>} { groupId, status, avatarId }
   */
  async waitForAvatarGroupTraining(groupId) {
    const startTime = Date.now();

    while (Date.now() - startTime < MAX_TRAINING_POLL_MS) {
      const status = await this.getAvatarGroupStatus(groupId);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

      if (status.status === 'ready' || status.status === 'completed') {
        // Fetch the trained avatars from the group
        const avatars = await this.listAvatarsInGroup(groupId);
        const avatar = avatars[0] || {};
        const avatarId = avatar.id || avatar.talking_photo_id || avatar.photo_avatar_id;
        if (!avatarId) {
          logger.error(`Training complete but no avatar found in group ${groupId}: ${JSON.stringify(avatars)}`);
          throw new Error('Trained group contains no avatars');
        }
        logger.info(`Avatar group ${groupId} training complete (${elapsed}s) — avatar_id: ${avatarId}`);
        return { groupId, status: 'ready', avatarId };
      }

      if (status.status === 'failed' || status.status === 'error') {
        throw new Error(`Avatar training failed: ${status.errorMsg || status.status}`);
      }

      logger.info(`Avatar group ${groupId} status: ${status.status} (${elapsed}s elapsed)`);
      await new Promise(resolve => setTimeout(resolve, TRAINING_POLL_INTERVAL_MS));
    }

    throw new Error(`Avatar group training timed out after ${MAX_TRAINING_POLL_MS / 1000}s`);
  }

  /**
   * List available stock avatars from HeyGen.
   * Useful for the "select a persona" UI option.
   *
   * @returns {Promise<Object[]>} Array of { avatarId, name, previewUrl }
   */
  async listStockAvatars() {
    if (!this.apiKey) throw new Error('HEYGEN_API_KEY is not configured');

    const response = await axios.get(`${BASE_URL}/v2/avatars`, {
      headers: this._headers(),
      timeout: 15000
    });

    const avatars = response.data?.data?.avatars || [];
    return avatars.map(a => ({
      avatarId: a.avatar_id,
      name: a.avatar_name,
      previewUrl: a.preview_image_url || a.preview_url || null,
      gender: a.gender || null,
      defaultVoiceId: a.default_voice_id || a.voice_id || null
    }));
  }

  /**
   * List available HeyGen voices.
   * Used to fall back to a default voice when an avatar has no default_voice_id.
   * @returns {Promise<Object[]>} Array of voices with { voice_id, name, gender, language }
   */
  async listVoices() {
    if (!this.apiKey) throw new Error('HEYGEN_API_KEY is not configured');

    // Cache voices per service instance — they don't change often
    if (this._cachedVoices) return this._cachedVoices;

    const response = await axios.get(`${BASE_URL}/v2/voices`, {
      headers: this._headers(),
      timeout: 15000
    });
    const voices = response.data?.data?.voices || [];
    this._cachedVoices = voices;
    return voices;
  }

  /**
   * Resolve a usable voice_id for a given avatar_id. Required by /v2/video/generate
   * since voice.type='text' mandates voice_id.
   *
   * Strategy (in order):
   *   1. Avatar's `default_voice_id` (HeyGen's pre-paired voice, gender-matched)
   *   2. First English voice MATCHING the avatar's gender
   *   3. Any English voice
   *   4. Any voice at all
   *
   * @param {string} avatarId
   * @returns {Promise<string|null>}
   */
  async resolveVoiceIdForAvatar(avatarId) {
    try {
      const avatars = await this.listStockAvatars();
      const avatar = avatars.find(a => a.avatarId === avatarId);

      // 1. Use HeyGen's pre-paired default voice if available
      if (avatar?.defaultVoiceId) {
        logger.info(`Using avatar's default voice: ${avatar.defaultVoiceId}`);
        return avatar.defaultVoiceId;
      }

      // 2. Gender-match fallback — critical so a female avatar doesn't get a male voice.
      const voices = await this.listVoices();
      const avatarGender = (avatar?.gender || '').toLowerCase();

      if (avatarGender) {
        const genderMatch = voices.find(v =>
          (v.language || '').toLowerCase().startsWith('en')
          && (v.gender || '').toLowerCase() === avatarGender
        );
        if (genderMatch) {
          logger.info(`Gender-matched voice for ${avatarGender} avatar: ${genderMatch.voice_id} (${genderMatch.name})`);
          return genderMatch.voice_id;
        }
      }

      // 3. Any English voice
      const english = voices.find(v => (v.language || '').toLowerCase().startsWith('en'));
      if (english) {
        logger.warn(`No gender match for avatar ${avatarId} (gender=${avatarGender || 'unknown'}) — using any English voice`);
        return english.voice_id;
      }

      // 4. Any voice at all
      return voices[0]?.voice_id || null;
    } catch (err) {
      logger.warn(`Failed to resolve voice_id for avatar ${avatarId}: ${err.message}`);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════
  // AVATAR VIDEO GENERATION (Avatar IV)
  // ═══════════════════════════════════════════════════

  /**
   * Generate a talking-head avatar video using Avatar IV.
   *
   * @param {Object} params
   * @param {string} params.avatarId - HeyGen avatar/talking-photo ID
   * @param {string} params.script - Text script for the avatar to speak
   * @param {Object} [params.options]
   * @param {string} [params.options.voiceId] - HeyGen voice ID (default: auto-detected)
   * @param {string} [params.options.aspectRatio='9:16'] - Output aspect ratio
   * @param {string} [params.options.resolution='1080p'] - Output resolution
   * @param {boolean} [params.options.isPhotoAvatar=false] - Whether using a photo avatar vs stock
   * @returns {Promise<Object>} { videoUrl, videoId, duration }
   */
  async generateAvatarVideo({ avatarId, script, options = {} }) {
    if (!this.apiKey) throw new Error('HEYGEN_API_KEY is not configured');

    const {
      voiceId,
      aspectRatio = '9:16',
      resolution = '1080p',
      isPhotoAvatar = false
    } = options;

    // voice.type='text' requires voice_id. If not provided, resolve from the avatar's
    // default voice (or fall back to first English voice in library).
    let resolvedVoiceId = voiceId;
    if (!resolvedVoiceId) {
      resolvedVoiceId = await this.resolveVoiceIdForAvatar(avatarId);
      if (!resolvedVoiceId) {
        throw new Error('No voice_id available — HeyGen requires a voice. Check /v2/voices.');
      }
    }

    logger.info(`Generating avatar video — avatar: ${avatarId}, voice: ${resolvedVoiceId}, script: ${script.slice(0, 80)}...`);

    // Build the video generation request.
    // For talking_photo characters, enable Avatar IV motion engine for expressive
    // facial motion and natural head movement (vs the older "Unlimited" engine).
    const body = {
      video_inputs: [{
        character: {
          type: isPhotoAvatar ? 'talking_photo' : 'avatar',
          ...(isPhotoAvatar
            ? { talking_photo_id: avatarId }
            : { avatar_id: avatarId }
          )
        },
        voice: {
          type: 'text',
          input_text: script,
          voice_id: resolvedVoiceId
        }
      }],
      dimension: this._parseDimension(aspectRatio, resolution),
      ...(isPhotoAvatar ? { use_avatar_iv_model: true } : {})
    };

    // Submit video generation
    let submitResponse;
    try {
      submitResponse = await axios.post(`${BASE_URL}/v2/video/generate`, body, {
        headers: this._headers(),
        timeout: 30000
      });
    } catch (err) {
      if (err.response) {
        logger.error(`HeyGen video/generate ${err.response.status}: ${JSON.stringify(err.response.data)}`);
        logger.error(`Request body: ${JSON.stringify(body)}`);
      }
      throw err;
    }

    const videoId = submitResponse.data?.data?.video_id;
    if (!videoId) {
      logger.error('HeyGen generate response:', JSON.stringify(submitResponse.data, null, 2));
      throw new Error('HeyGen did not return a video_id');
    }

    logger.info(`HeyGen video generation submitted — ID: ${videoId}`);

    // Poll for completion
    const result = await this._pollVideoGeneration(videoId);

    return {
      videoUrl: result.video_url,
      videoId,
      duration: result.duration || null,
      thumbnailUrl: result.thumbnail_url || null
    };
  }

  /**
   * Parse aspect ratio + resolution into HeyGen dimension format.
   */
  _parseDimension(aspectRatio, resolution) {
    // HeyGen expects { width, height }
    const resMap = {
      '720p': { '9:16': { width: 720, height: 1280 }, '16:9': { width: 1280, height: 720 }, '1:1': { width: 720, height: 720 } },
      '1080p': { '9:16': { width: 1080, height: 1920 }, '16:9': { width: 1920, height: 1080 }, '1:1': { width: 1080, height: 1080 } }
    };
    return resMap[resolution]?.[aspectRatio] || { width: 1080, height: 1920 };
  }

  /**
   * Poll a video generation until it completes or fails.
   * @param {string} videoId
   * @returns {Promise<Object>} { video_url, duration, thumbnail_url }
   */
  async _pollVideoGeneration(videoId) {
    const startTime = Date.now();

    while (Date.now() - startTime < MAX_POLL_DURATION_MS) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

      const response = await axios.get(`${BASE_URL}/v1/video_status.get`, {
        params: { video_id: videoId },
        headers: this._headers(),
        timeout: 15000
      });

      const data = response.data?.data;
      if (!data) {
        logger.warn(`HeyGen poll returned no data for video ${videoId}`);
        continue;
      }

      const status = data.status;

      if (status === 'completed') {
        if (!data.video_url) {
          throw new Error('HeyGen video completed but no video_url returned');
        }
        logger.info(`HeyGen video completed — URL: ${data.video_url}`);
        return data;
      }

      if (status === 'failed' || status === 'error') {
        throw new Error(`HeyGen video generation failed: ${data.error || data.message || 'Unknown error'}`);
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      logger.info(`HeyGen video ${videoId} status: ${status} (${elapsed}s elapsed)`);
    }

    throw new Error(`HeyGen video generation timed out after ${MAX_POLL_DURATION_MS / 1000}s`);
  }

  /**
   * Get the status of a specific video without waiting.
   *
   * @param {string} videoId
   * @returns {Promise<Object>} { status, videoUrl, error }
   */
  async getVideoStatus(videoId) {
    if (!this.apiKey) throw new Error('HEYGEN_API_KEY is not configured');

    const response = await axios.get(`${BASE_URL}/v1/video_status.get`, {
      params: { video_id: videoId },
      headers: this._headers(),
      timeout: 15000
    });

    const data = response.data?.data;
    return {
      status: data?.status || 'unknown',
      videoUrl: data?.video_url || null,
      error: data?.error || null
    };
  }

  /**
   * Check if the service is available (API key configured)
   */
  isAvailable() {
    return !!this.apiKey;
  }
}

// Singleton export (same pattern as VideoGenerationService)
const heyGenService = new HeyGenService();
export default heyGenService;
export { HeyGenService };
