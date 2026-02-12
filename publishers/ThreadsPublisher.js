// publishers/ThreadsPublisher.js
import axios from 'axios';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[ThreadsPublisher] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

const GRAPH_API_VERSION = 'v1.0';
const GRAPH_API_BASE = `https://graph.threads.net/${GRAPH_API_VERSION}`;

class ThreadsPublisher {
  /**
   * Create a ThreadsPublisher instance
   * @param {Object} credentials - User credentials
   * @param {string} credentials.accessToken - User OAuth access token
   * @param {string} credentials.threadsUserId - Threads user ID
   * @param {Object} credentials.metadata - Platform metadata (contains threadsUserId)
   */
  constructor(credentials = null) {
    if (credentials) {
      if (!credentials.accessToken) {
        logger.warn('Threads credentials provided but accessToken missing');
        return;
      }

      this.accessToken = credentials.accessToken;
      this.threadsUserId = credentials.threadsUserId || credentials.metadata?.threadsUserId;

      logger.debug('Threads publisher initialized with user credentials');
    } else {
      logger.warn('Threads credentials not provided');
    }
  }

  /**
   * Create a new ThreadsPublisher instance with user-specific credentials
   * @param {Object} credentials - User's OAuth credentials
   * @returns {ThreadsPublisher} New publisher instance
   */
  static withCredentials(credentials) {
    return new ThreadsPublisher(credentials);
  }

  /**
   * Publish a post to Threads
   * Supports text-only, image, and video posts via a two-step container flow:
   *   1. Create thread container
   *   2. Publish the container
   * @param {string} content - Post text content
   * @param {string} mediaUrl - Optional image or video URL
   * @param {Object} options - Additional options
   * @returns {Object} Result with success status and post details
   */
  async publishPost(content, mediaUrl = null, options = {}) {
    if (!this.threadsUserId) {
      throw new Error('Threads user ID not available. Please reconnect your Threads account.');
    }

    try {
      logger.debug(`Threads publish attempt - User: ${this.threadsUserId}`);

      const formattedText = this.formatForThreads(content);

      // Determine media type
      let mediaType = 'TEXT';
      if (mediaUrl) {
        mediaType = this.isVideoUrl(mediaUrl) ? 'VIDEO' : 'IMAGE';
      }

      // Step 1: Create thread container
      const containerId = await this.createThreadContainer(formattedText, mediaUrl, mediaType);
      logger.debug(`Created thread container: ${containerId}`);

      // Step 2: Publish the container
      const result = await this.publishThreadContainer(containerId);

      logger.info(`Successfully published to Threads: ${result.id}`);

      return {
        success: true,
        platform: 'threads',
        postId: result.id,
        url: `https://www.threads.net/post/${result.id}`,
        threadsUserId: this.threadsUserId
      };
    } catch (error) {
      logger.error('Threads publishing error:', {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message
      });

      if (error.response?.status === 401 || error.response?.data?.error?.code === 190) {
        logger.error('Threads token appears to be invalid or expired');
      }

      throw error;
    }
  }

  /**
   * Create a thread container
   * @param {string} text - Post text
   * @param {string} mediaUrl - Optional media URL
   * @param {string} mediaType - TEXT, IMAGE, or VIDEO
   * @returns {string} Container creation ID
   */
  async createThreadContainer(text, mediaUrl, mediaType) {
    const params = {
      media_type: mediaType,
      text,
      access_token: this.accessToken
    };

    if (mediaType === 'IMAGE' && mediaUrl) {
      params.image_url = mediaUrl;
    } else if (mediaType === 'VIDEO' && mediaUrl) {
      params.video_url = mediaUrl;
    }

    const response = await axios.post(
      `${GRAPH_API_BASE}/${this.threadsUserId}/threads`,
      params
    );

    if (!response.data?.id) {
      throw new Error('Failed to create Threads container: no ID returned');
    }

    return response.data.id;
  }

  /**
   * Publish a completed thread container
   * @param {string} containerId - Container ID to publish
   * @returns {Object} Published thread data with id
   */
  async publishThreadContainer(containerId) {
    const response = await axios.post(
      `${GRAPH_API_BASE}/${this.threadsUserId}/threads_publish`,
      {
        creation_id: containerId,
        access_token: this.accessToken
      }
    );

    if (!response.data?.id) {
      throw new Error('Failed to publish Threads container: no ID returned');
    }

    return response.data;
  }

  /**
   * Format content for Threads
   * @param {string} content - Raw content
   * @returns {string} Formatted text (max 500 chars)
   */
  formatForThreads(content) {
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

    // Threads text limit is 500 characters
    if (formatted.length > 500) {
      const truncated = formatted.substring(0, 497);
      const lastSentence = truncated.lastIndexOf('. ');
      if (lastSentence > 400) {
        formatted = truncated.substring(0, lastSentence + 1);
      } else {
        const lastSpace = truncated.lastIndexOf(' ');
        formatted = truncated.substring(0, lastSpace > 400 ? lastSpace : 497) + '...';
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

export default ThreadsPublisher;
