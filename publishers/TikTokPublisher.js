// publishers/TikTokPublisher.js
// TikTok video publishing via the Content Posting API.
// Supports PULL_FROM_URL (primary) and FILE_UPLOAD (fallback).

import axios from 'axios';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[TikTokPublisher] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

const TIKTOK_API_BASE = 'https://open.tiktokapis.com/v2';

// Polling configuration for publish status
const PUBLISH_POLL_MAX_ATTEMPTS = 30;
const PUBLISH_POLL_INTERVAL_MS = 3000; // 3 seconds

// Unaudited apps must use the Inbox endpoint (user reviews in TikTok app before posting).
// Audited apps can use Direct Post endpoint (posts immediately).
// Set TIKTOK_APP_AUDITED=true in env after TikTok audit approval.
const IS_AUDITED = process.env.TIKTOK_APP_AUDITED === 'true';
const PUBLISH_ENDPOINT = IS_AUDITED
  ? '/post/publish/video/init/'
  : '/post/publish/inbox/video/init/';

// Default privacy level — unaudited apps are restricted to SELF_ONLY;
// audited apps default to PUBLIC_TO_EVERYONE (direct post to feed).
const DEFAULT_PRIVACY_LEVEL = IS_AUDITED ? 'PUBLIC_TO_EVERYONE' : 'SELF_ONLY';

class TikTokPublisher {
  /**
   * Create a TikTokPublisher instance.
   * @param {Object} credentials
   * @param {string} credentials.accessToken - TikTok OAuth access token
   * @param {string} credentials.openId - TikTok open_id (user identifier)
   * @param {Object} credentials.metadata - Additional platform metadata
   */
  constructor(credentials = null) {
    if (credentials) {
      if (!credentials.accessToken) {
        logger.warn('TikTok credentials provided but accessToken missing');
        return;
      }

      this.accessToken = credentials.accessToken;
      this.openId = credentials.openId || credentials.metadata?.openId;

      logger.debug('TikTok publisher initialized with user credentials');
    } else {
      logger.warn('TikTok credentials not provided');
    }
  }

  /**
   * Factory method — create instance with user credentials.
   * @param {Object} credentials
   * @returns {TikTokPublisher}
   */
  static withCredentials(credentials) {
    return new TikTokPublisher(credentials);
  }

  /**
   * Publish a video to TikTok.
   * Primary method: PULL_FROM_URL (TikTok fetches video from a public URL).
   * Fallback: FILE_UPLOAD (chunked upload if PULL_FROM_URL fails).
   *
   * @param {string} caption - Post caption text
   * @param {string} videoUrl - Publicly accessible video URL (from video generation service)
   * @param {Object} options - Additional options
   * @param {string} options.privacyLevel - Privacy: SELF_ONLY, MUTUAL_FOLLOW_FRIENDS, FOLLOWER_OF_CREATOR, PUBLIC_TO_EVERYONE
   * @param {Buffer} options.videoBuffer - Pre-downloaded video buffer (for FILE_UPLOAD fallback)
   * @param {boolean} options.disableDuet - Disable duet for this video
   * @param {boolean} options.disableComment - Disable comments for this video
   * @param {boolean} options.disableStitch - Disable stitch for this video
   * @param {boolean} options.brandContentToggle - Declare branded content (paid partnership)
   * @param {boolean} options.brandOrganicToggle - Declare promotional content (your own brand)
   * @returns {Promise<Object>} { success, platform, publishId, postId }
   */
  async publishPost(caption, videoUrl, options = {}) {
    if (!videoUrl && !options.videoBuffer) {
      throw new Error('TikTok requires a video URL or video buffer. Text-only posts are not supported.');
    }

    if (!this.accessToken) {
      throw new Error('TikTok access token not available. Please reconnect your TikTok account.');
    }

    try {
      const formattedCaption = this.formatForTikTok(caption, options.sourceUrl);
      let privacyLevel = options.privacyLevel || DEFAULT_PRIVACY_LEVEL;

      // For audited (direct post) apps, query creator info to validate privacy level
      if (IS_AUDITED) {
        try {
          const creatorInfo = await this.getCreatorInfo();
          const availableLevels = creatorInfo?.privacy_level_options || [];
          logger.info(`Creator privacy options: ${JSON.stringify(availableLevels)}`);

          if (availableLevels.length > 0 && !availableLevels.includes(privacyLevel)) {
            privacyLevel = availableLevels.includes('PUBLIC_TO_EVERYONE')
              ? 'PUBLIC_TO_EVERYONE'
              : availableLevels[0];
            logger.info(`Adjusted privacy level to ${privacyLevel} based on creator info`);
          }
        } catch (creatorErr) {
          logger.warn(`Failed to query creator info: ${creatorErr.message}. Using default privacy: ${privacyLevel}`);
        }
      }

      logger.info(`Publishing to TikTok — privacy: ${privacyLevel}, caption: ${formattedCaption.length} chars`);

      let publishId;

      if (videoUrl) {
        // Primary: PULL_FROM_URL
        try {
          publishId = await this.initPullFromUrl(videoUrl, formattedCaption, privacyLevel, options);
        } catch (pullError) {
          // If PULL_FROM_URL fails (e.g., domain not verified), fall back to FILE_UPLOAD
          logger.warn(`PULL_FROM_URL failed: ${pullError.message}. Falling back to FILE_UPLOAD...`);

          if (!options.videoBuffer) {
            // Need to download the video first
            const videoBuffer = await this.downloadVideo(videoUrl);
            publishId = await this.initFileUpload(videoBuffer, formattedCaption, privacyLevel, options);
          } else {
            publishId = await this.initFileUpload(options.videoBuffer, formattedCaption, privacyLevel, options);
          }
        }
      } else {
        // Direct FILE_UPLOAD from buffer
        publishId = await this.initFileUpload(options.videoBuffer, formattedCaption, privacyLevel, options);
      }

      // Poll for publish completion
      const result = await this.waitForPublishComplete(publishId);

      const logMsg = result.sentToInbox
        ? `Video sent to TikTok inbox for user review — publish_id: ${publishId}`
        : `Successfully published to TikTok — publish_id: ${publishId}`;
      logger.info(logMsg);

      return {
        success: true,
        platform: 'tiktok',
        publishId,
        postId: result.postId || publishId,
        sentToInbox: result.sentToInbox || false
      };
    } catch (error) {
      const errorDetails = {
        status: error.response?.status,
        apiError: error.response?.data?.error || error.response?.data,
        message: error.message
      };
      logger.error(`TikTok publishing error: ${JSON.stringify(errorDetails)}`);

      if (error.response?.status === 401) {
        logger.error('TikTok token appears to be invalid or expired');
      }

      throw error;
    }
  }

  // ═══════════════════════════════════════════════════
  // PULL_FROM_URL — TikTok fetches video from a public URL
  // ═══════════════════════════════════════════════════

  /**
   * Initialize video upload via PULL_FROM_URL.
   * TikTok downloads the video from the provided URL.
   * @returns {string} publish_id for status polling
   */
  async initPullFromUrl(videoUrl, caption, privacyLevel, options = {}) {
    logger.info(`Initializing PULL_FROM_URL upload (${IS_AUDITED ? 'direct post' : 'inbox'}) — video: ${videoUrl}`);

    const postInfo = this.buildPostInfo(caption, privacyLevel, options);

    const response = await axios.post(
      `${TIKTOK_API_BASE}${PUBLISH_ENDPOINT}`,
      {
        post_info: postInfo,
        source_info: {
          source: 'PULL_FROM_URL',
          video_url: videoUrl
        }
      },
      {
        headers: this.getHeaders(),
        timeout: 30000
      }
    );

    const data = response.data?.data;
    if (!data?.publish_id) {
      throw new Error(`TikTok PULL_FROM_URL init failed: ${JSON.stringify(response.data)}`);
    }

    logger.info(`PULL_FROM_URL initialized — publish_id: ${data.publish_id}`);
    return data.publish_id;
  }

  // ═══════════════════════════════════════════════════
  // FILE_UPLOAD — Direct upload (fallback)
  // ═══════════════════════════════════════════════════

  /**
   * Initialize video upload via FILE_UPLOAD and upload the video data.
   * @param {Buffer} videoBuffer - Video file content
   * @param {string} caption - Post caption
   * @param {string} privacyLevel - Privacy setting
   * @returns {string} publish_id
   */
  async initFileUpload(videoBuffer, caption, privacyLevel, options = {}) {
    const videoSize = videoBuffer.length;
    const chunkSize = videoSize; // Single-chunk upload: chunk_size = video_size (valid up to 64MB)
    const totalChunkCount = 1;  // AI-generated videos are well under 64MB

    logger.info(`Initializing FILE_UPLOAD — size: ${(videoSize / (1024 * 1024)).toFixed(1)} MB`);

    // Step 1: Initialize upload
    const postInfo = this.buildPostInfo(caption, privacyLevel, options);

    const initResponse = await axios.post(
      `${TIKTOK_API_BASE}${PUBLISH_ENDPOINT}`,
      {
        post_info: postInfo,
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: videoSize,
          chunk_size: chunkSize,
          total_chunk_count: totalChunkCount
        }
      },
      {
        headers: this.getHeaders(),
        timeout: 30000
      }
    );

    const data = initResponse.data?.data;
    if (!data?.publish_id || !data?.upload_url) {
      throw new Error(`TikTok FILE_UPLOAD init failed: ${JSON.stringify(initResponse.data)}`);
    }

    const { publish_id, upload_url } = data;
    logger.info(`FILE_UPLOAD initialized — publish_id: ${publish_id}`);

    // Step 2: Upload video data
    logger.info(`Uploading video to ${upload_url}...`);
    await axios.put(upload_url, videoBuffer, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': videoSize.toString(),
        'Content-Range': `bytes 0-${videoSize - 1}/${videoSize}`
      },
      timeout: 120000, // 2 minutes for upload
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    logger.info('Video data uploaded successfully');
    return publish_id;
  }

  // ═══════════════════════════════════════════════════
  // STATUS POLLING
  // ═══════════════════════════════════════════════════

  /**
   * Poll TikTok for publish completion status.
   * @param {string} publishId
   * @returns {Object} { postId }
   */
  async waitForPublishComplete(publishId) {
    logger.info(`Polling publish status for publish_id: ${publishId}`);

    for (let attempt = 0; attempt < PUBLISH_POLL_MAX_ATTEMPTS; attempt++) {
      const response = await axios.post(
        `${TIKTOK_API_BASE}/post/publish/status/fetch/`,
        { publish_id: publishId },
        {
          headers: this.getHeaders(),
          timeout: 15000
        }
      );

      const status = response.data?.data?.status;

      if (status === 'PUBLISH_COMPLETE') {
        const postId = response.data?.data?.publicaly_available_post_id
          || response.data?.data?.post_id;
        logger.info(`Publish complete — post_id: ${postId || 'pending moderation'}`);
        return { postId };
      }

      // For unaudited apps using the Inbox endpoint, SEND_TO_USER_INBOX is the
      // terminal success state — the video has been delivered to the user's TikTok
      // inbox for review and manual posting from the TikTok app.
      if (status === 'SEND_TO_USER_INBOX') {
        logger.info(`Video sent to TikTok inbox — publish_id: ${publishId}. User must review and post from the TikTok app.`);
        return { postId: null, sentToInbox: true };
      }

      if (status === 'FAILED') {
        const failReason = response.data?.data?.fail_reason || 'Unknown';
        throw new Error(`TikTok publish failed: ${failReason}`);
      }

      logger.debug(`Publish status: ${status} (attempt ${attempt + 1}/${PUBLISH_POLL_MAX_ATTEMPTS})`);
      await new Promise(resolve => setTimeout(resolve, PUBLISH_POLL_INTERVAL_MS));
    }

    // If polling times out but no explicit failure, the video may still be processing
    logger.warn(`Publish status polling timed out after ${PUBLISH_POLL_MAX_ATTEMPTS} attempts — video may still be processing`);
    return { postId: null };
  }

  // ═══════════════════════════════════════════════════
  // CREATOR INFO
  // ═══════════════════════════════════════════════════

  /**
   * Query creator info to check privacy settings and content restrictions.
   * Should be called before publishing to validate the user's account state.
   */
  async getCreatorInfo() {
    const response = await axios.post(
      `${TIKTOK_API_BASE}/post/publish/creator_info/query/`,
      {},
      {
        headers: this.getHeaders(),
        timeout: 15000
      }
    );

    return response.data?.data;
  }

  // ═══════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════

  /**
   * Build the post_info object for TikTok API requests.
   * Reads interaction and commercial disclosure settings from options,
   * applying TikTok Content Sharing Guidelines compliance.
   */
  buildPostInfo(caption, privacyLevel, options = {}) {
    const postInfo = {
      title: caption,
      is_aigc: true,
      disable_duet: options.disableDuet ?? false,
      disable_comment: options.disableComment ?? false,
      disable_stitch: options.disableStitch ?? false
    };

    // Only direct post (audited) uses privacy_level; inbox endpoint doesn't accept it
    if (IS_AUDITED) {
      postInfo.privacy_level = privacyLevel;
    }

    // Commercial content disclosure (Content Sharing Guidelines Point 3)
    if (options.brandContentToggle || options.brandOrganicToggle) {
      postInfo.brand_content_toggle = options.brandContentToggle ?? false;
      postInfo.brand_organic_toggle = options.brandOrganicToggle ?? false;
    }

    return postInfo;
  }

  /**
   * Build standard TikTok API headers.
   */
  getHeaders() {
    return {
      'Authorization': `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8'
    };
  }

  /**
   * Format content for TikTok captions.
   * @param {string} content - Raw content
   * @returns {string} Formatted caption (max 2200 chars)
   */
  formatForTikTok(content, sourceUrl = null) {
    let formatted = content
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<p[^>]*>/gi, '')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // Append source article URL if available
    if (sourceUrl) {
      formatted += `\n\nSource: ${sourceUrl}`;
    }

    // TikTok caption limit is 2200 characters
    if (formatted.length > 2200) {
      const truncated = formatted.substring(0, 2197);
      const lastSentence = truncated.lastIndexOf('. ');
      if (lastSentence > 1800) {
        formatted = truncated.substring(0, lastSentence + 1);
      } else {
        formatted = truncated + '...';
      }
    }

    return formatted;
  }

  /**
   * Download a video from a URL into a Buffer.
   * Used as fallback when PULL_FROM_URL fails.
   */
  async downloadVideo(videoUrl) {
    logger.info(`Downloading video for FILE_UPLOAD fallback: ${videoUrl}`);
    const response = await axios.get(videoUrl, {
      responseType: 'arraybuffer',
      timeout: 120000,
      headers: { 'User-Agent': 'NewsAgentSaaS/1.0' }
    });

    const buffer = Buffer.from(response.data);
    logger.info(`Video downloaded — ${(buffer.length / (1024 * 1024)).toFixed(1)} MB`);
    return buffer;
  }

  /**
   * Verify the access token is valid by querying user info.
   */
  async verifyToken() {
    if (!this.accessToken) {
      throw new Error('No token available to verify');
    }

    const response = await axios.get(
      `${TIKTOK_API_BASE}/user/info/?fields=open_id,display_name,avatar_url`,
      {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`
        },
        timeout: 15000
      }
    );

    return response.data?.data?.user;
  }
}

export default TikTokPublisher;
