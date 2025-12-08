// publishers/FacebookPublisher.js
import axios from 'axios';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[FacebookPublisher] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

const GRAPH_API_VERSION = 'v18.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

class FacebookPublisher {
  /**
   * Create a FacebookPublisher instance
   * @param {Object} credentials - Optional credentials object for per-user publishing
   * @param {string} credentials.accessToken - User OAuth access token
   * @param {string} credentials.pageId - Facebook Page ID to post to
   * @param {string} credentials.pageAccessToken - Page-specific access token (if available)
   * @param {Object} credentials.metadata - Platform metadata
   */
  constructor(credentials = null) {
    if (credentials) {
      // Per-user credentials mode
      if (!credentials.accessToken) {
        logger.warn('Facebook credentials provided but accessToken missing');
        return;
      }

      this.userAccessToken = credentials.accessToken;
      this.pageId = credentials.pageId || credentials.metadata?.pageId;
      this.pageAccessToken = credentials.pageAccessToken || credentials.metadata?.pageAccessToken;
      this.pageName = credentials.metadata?.pageName;

      logger.debug('Facebook publisher initialized with user credentials');
    } else {
      // Legacy mode: use environment variables
      if (!process.env.FACEBOOK_PAGE_ACCESS_TOKEN) {
        logger.warn('Facebook credentials not configured');
        return;
      }

      this.pageAccessToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
      this.pageId = process.env.FACEBOOK_PAGE_ID;
      logger.debug('Facebook publisher initialized with environment credentials');
    }
  }

  /**
   * Create a new FacebookPublisher instance with user-specific credentials
   * @param {Object} credentials - User's OAuth credentials
   * @returns {FacebookPublisher} New publisher instance
   */
  static withCredentials(credentials) {
    return new FacebookPublisher(credentials);
  }

  /**
   * Get list of pages the user manages
   * @returns {Array} List of pages with id, name, and access_token
   */
  async getUserPages() {
    if (!this.userAccessToken) {
      throw new Error('User access token required to fetch pages');
    }

    try {
      const response = await axios.get(`${GRAPH_API_BASE}/me/accounts`, {
        params: {
          access_token: this.userAccessToken,
          fields: 'id,name,access_token,picture'
        }
      });

      const pages = response.data.data || [];
      logger.info(`Found ${pages.length} Facebook pages for user`);

      return pages.map(page => ({
        id: page.id,
        name: page.name,
        accessToken: page.access_token,
        pictureUrl: page.picture?.data?.url
      }));
    } catch (error) {
      logger.error('Failed to fetch user pages:', error.response?.data || error.message);
      throw new Error(`Failed to fetch Facebook pages: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  /**
   * Set the active page for publishing
   * @param {string} pageId - Page ID
   * @param {string} pageAccessToken - Page access token
   * @param {string} pageName - Page name (optional)
   */
  setActivePage(pageId, pageAccessToken, pageName = null) {
    this.pageId = pageId;
    this.pageAccessToken = pageAccessToken;
    this.pageName = pageName;
    logger.info(`Active page set to: ${pageName || pageId}`);
  }

  /**
   * Ensure we have a valid page access token
   * If only user token is available, fetch pages and use the first one
   */
  async ensurePageToken() {
    if (this.pageAccessToken && this.pageId) {
      return { pageId: this.pageId, pageAccessToken: this.pageAccessToken };
    }

    if (!this.userAccessToken) {
      throw new Error('No Facebook access token available');
    }

    // Fetch user's pages and use the first one
    const pages = await this.getUserPages();

    if (pages.length === 0) {
      throw new Error('No Facebook pages found for this account. User must manage at least one Page.');
    }

    // Use the first page by default
    this.pageId = pages[0].id;
    this.pageAccessToken = pages[0].accessToken;
    this.pageName = pages[0].name;

    logger.info(`Auto-selected page: ${this.pageName} (${this.pageId})`);

    return { pageId: this.pageId, pageAccessToken: this.pageAccessToken };
  }

  /**
   * Publish a post to the Facebook Page
   * @param {string} content - Post content/message
   * @param {string} mediaUrl - Optional media URL (image or video)
   * @param {Object} options - Additional options
   * @returns {Object} Result with success status and post details
   */
  async publishPost(content, mediaUrl = null, options = {}) {
    try {
      // Ensure we have page credentials
      const { pageId, pageAccessToken } = await this.ensurePageToken();

      logger.debug(`Facebook publish attempt - Page: ${this.pageName || pageId}`);

      const formattedContent = this.formatForFacebook(content);

      let result;

      if (mediaUrl) {
        // Determine if it's a video or image
        const isVideo = this.isVideoUrl(mediaUrl);

        if (isVideo) {
          result = await this.publishVideoPost(pageId, pageAccessToken, formattedContent, mediaUrl);
        } else {
          result = await this.publishPhotoPost(pageId, pageAccessToken, formattedContent, mediaUrl);
        }
      } else {
        // Text-only post
        result = await this.publishTextPost(pageId, pageAccessToken, formattedContent, options);
      }

      logger.info(`Successfully published to Facebook Page: ${result.id}`);

      return {
        success: true,
        platform: 'facebook',
        postId: result.id,
        url: `https://www.facebook.com/${result.id}`,
        pageName: this.pageName,
        pageId: pageId
      };
    } catch (error) {
      logger.error('Facebook publishing error:', {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message
      });

      // Handle specific error codes
      if (error.response?.status === 401 || error.response?.data?.error?.code === 190) {
        logger.error('Facebook token appears to be invalid or expired');
      }

      throw error;
    }
  }

  /**
   * Publish a text-only post
   */
  async publishTextPost(pageId, pageAccessToken, message, options = {}) {
    const response = await axios.post(
      `${GRAPH_API_BASE}/${pageId}/feed`,
      {
        message,
        link: options.link || undefined,
        published: options.published !== false
      },
      {
        params: { access_token: pageAccessToken }
      }
    );

    return response.data;
  }

  /**
   * Publish a post with a photo
   */
  async publishPhotoPost(pageId, pageAccessToken, message, imageUrl) {
    const response = await axios.post(
      `${GRAPH_API_BASE}/${pageId}/photos`,
      {
        message,
        url: imageUrl
      },
      {
        params: { access_token: pageAccessToken }
      }
    );

    return response.data;
  }

  /**
   * Publish a post with a video
   */
  async publishVideoPost(pageId, pageAccessToken, message, videoUrl) {
    // For video, we use the /videos endpoint
    const response = await axios.post(
      `${GRAPH_API_BASE}/${pageId}/videos`,
      {
        description: message,
        file_url: videoUrl
      },
      {
        params: { access_token: pageAccessToken }
      }
    );

    return response.data;
  }

  /**
   * Format content for Facebook
   * @param {string} content - Raw content
   * @returns {string} Formatted content
   */
  formatForFacebook(content) {
    return content
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
   * Verify the page access token is valid
   * @returns {Object} Token debug info
   */
  async verifyToken() {
    const token = this.pageAccessToken || this.userAccessToken;

    if (!token) {
      throw new Error('No token available to verify');
    }

    try {
      const response = await axios.get(`${GRAPH_API_BASE}/debug_token`, {
        params: {
          input_token: token,
          access_token: token
        }
      });

      return response.data.data;
    } catch (error) {
      logger.error('Token verification failed:', error.response?.data || error.message);
      throw error;
    }
  }
}

export default FacebookPublisher;
