// publishers/InstagramPublisher.js
import axios from 'axios';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[InstagramPublisher] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

const GRAPH_API_VERSION = 'v24.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// Video processing polling configuration
const VIDEO_POLL_MAX_ATTEMPTS = 30;
const VIDEO_POLL_INTERVAL_MS = 2000;

class InstagramPublisher {
  /**
   * Create an InstagramPublisher instance
   * @param {Object} credentials - User credentials
   * @param {string} credentials.accessToken - User OAuth access token
   * @param {string} credentials.igUserId - Instagram Business Account ID
   * @param {Object} credentials.metadata - Platform metadata (contains igUserId)
   */
  constructor(credentials = null) {
    if (credentials) {
      if (!credentials.accessToken) {
        logger.warn('Instagram credentials provided but accessToken missing');
        return;
      }

      this.accessToken = credentials.accessToken;
      this.igUserId = credentials.igUserId || credentials.metadata?.igUserId;

      logger.debug('Instagram publisher initialized with user credentials');
    } else {
      logger.warn('Instagram credentials not provided');
    }
  }

  /**
   * Create a new InstagramPublisher instance with user-specific credentials
   * @param {Object} credentials - User's OAuth credentials
   * @returns {InstagramPublisher} New publisher instance
   */
  static withCredentials(credentials) {
    return new InstagramPublisher(credentials);
  }

  /**
   * Publish a post to Instagram
   * Instagram requires an image or video — text-only posts are not supported.
   * Uses a two-step container-based publishing flow:
   *   1. Create media container
   *   2. Publish the container
   * @param {string} content - Post caption
   * @param {string} mediaUrl - Required image or video URL
   * @param {Object} options - Additional options
   * @returns {Object} Result with success status and post details
   */
  async publishPost(content, mediaUrl = null, options = {}) {
    if (!mediaUrl) {
      throw new Error('Instagram requires an image or video. Text-only posts are not supported.');
    }

    if (!this.igUserId) {
      throw new Error('Instagram Business Account ID not available. Please reconnect your Instagram account.');
    }

    try {
      logger.debug(`Instagram publish attempt - Account: ${this.igUserId}`);

      const caption = this.formatForInstagram(content);
      const isVideo = this.isVideoUrl(mediaUrl);

      // Step 1: Create media container
      const containerId = await this.createMediaContainer(mediaUrl, caption, isVideo);
      logger.debug(`Created media container: ${containerId}`);

      // Step 2: For videos, wait for processing to complete
      if (isVideo) {
        await this.waitForContainerReady(containerId);
      }

      // Step 3: Publish the container
      const result = await this.publishMediaContainer(containerId);

      logger.info(`Successfully published to Instagram: ${result.id}`);

      return {
        success: true,
        platform: 'instagram',
        postId: result.id,
        url: `https://www.instagram.com/p/${result.id}/`,
        igUserId: this.igUserId
      };
    } catch (error) {
      logger.error('Instagram publishing error:', {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message
      });

      if (error.response?.status === 401 || error.response?.data?.error?.code === 190) {
        logger.error('Instagram token appears to be invalid or expired');
      }

      throw error;
    }
  }

  /**
   * Create a media container for publishing
   * @param {string} mediaUrl - Image or video URL
   * @param {string} caption - Post caption
   * @param {boolean} isVideo - Whether the media is a video
   * @returns {string} Container creation ID
   */
  async createMediaContainer(mediaUrl, caption, isVideo) {
    const params = {
      caption,
      access_token: this.accessToken
    };

    if (isVideo) {
      params.media_type = 'VIDEO';
      params.video_url = mediaUrl;
    } else {
      params.image_url = mediaUrl;
    }

    const response = await axios.post(
      `${GRAPH_API_BASE}/${this.igUserId}/media`,
      params
    );

    if (!response.data?.id) {
      throw new Error('Failed to create Instagram media container: no ID returned');
    }

    return response.data.id;
  }

  /**
   * Wait for a video container to finish processing
   * Instagram processes videos asynchronously; we must poll until ready.
   * @param {string} containerId - Container ID to check
   */
  async waitForContainerReady(containerId) {
    for (let attempt = 0; attempt < VIDEO_POLL_MAX_ATTEMPTS; attempt++) {
      const status = await this.checkContainerStatus(containerId);

      if (status === 'FINISHED') {
        logger.debug(`Video container ${containerId} ready after ${attempt + 1} polls`);
        return;
      }

      if (status === 'ERROR') {
        throw new Error('Instagram video processing failed. The video may be in an unsupported format or too large.');
      }

      logger.debug(`Video container status: ${status} (attempt ${attempt + 1}/${VIDEO_POLL_MAX_ATTEMPTS})`);
      await new Promise(resolve => setTimeout(resolve, VIDEO_POLL_INTERVAL_MS));
    }

    throw new Error(`Instagram video processing timed out after ${VIDEO_POLL_MAX_ATTEMPTS * VIDEO_POLL_INTERVAL_MS / 1000} seconds`);
  }

  /**
   * Check the processing status of a media container
   * @param {string} containerId - Container ID
   * @returns {string} Status code: IN_PROGRESS, FINISHED, or ERROR
   */
  async checkContainerStatus(containerId) {
    const response = await axios.get(
      `${GRAPH_API_BASE}/${containerId}`,
      {
        params: {
          fields: 'status_code',
          access_token: this.accessToken
        }
      }
    );

    return response.data.status_code;
  }

  /**
   * Publish a completed media container
   * @param {string} containerId - Container ID to publish
   * @returns {Object} Published media data with id
   */
  async publishMediaContainer(containerId) {
    const response = await axios.post(
      `${GRAPH_API_BASE}/${this.igUserId}/media_publish`,
      {
        creation_id: containerId,
        access_token: this.accessToken
      }
    );

    if (!response.data?.id) {
      throw new Error('Failed to publish Instagram media container: no ID returned');
    }

    return response.data;
  }

  /**
   * Format content for Instagram captions
   * @param {string} content - Raw content
   * @returns {string} Formatted caption (max 2200 chars)
   */
  formatForInstagram(content) {
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

    // Instagram caption limit is 2200 characters
    if (formatted.length > 2200) {
      // Try to cut at a sentence boundary
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
   * Check if URL points to a video
   */
  isVideoUrl(url) {
    const videoExtensions = ['.mp4', '.mov', '.avi', '.wmv', '.flv', '.webm'];
    const lowerUrl = url.toLowerCase();
    return videoExtensions.some(ext => lowerUrl.includes(ext));
  }

  /**
   * Verify the access token is valid
   * @returns {Object} Token debug info
   */
  async verifyToken() {
    if (!this.accessToken) {
      throw new Error('No token available to verify');
    }

    try {
      const response = await axios.get(`${GRAPH_API_BASE}/debug_token`, {
        params: {
          input_token: this.accessToken,
          access_token: this.accessToken
        }
      });

      return response.data.data;
    } catch (error) {
      logger.error('Token verification failed:', error.response?.data || error.message);
      throw error;
    }
  }
}

export default InstagramPublisher;
