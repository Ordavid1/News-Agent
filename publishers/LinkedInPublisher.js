// publishers/LinkedInPublisher.js
import axios from 'axios';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[LinkedInPublisher] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

class LinkedInPublisher {
  /**
   * Create a LinkedInPublisher instance
   * @param {Object} credentials - Optional credentials object for per-user publishing
   * @param {string} credentials.accessToken - OAuth 2.0 access token
   * @param {string} credentials.authorId - LinkedIn author URN ID (e.g., person ID from urn:li:person:XXX)
   * @param {Object} credentials.metadata - Platform metadata (may contain authorUrn)
   */
  constructor(credentials = null) {
    if (credentials) {
      // Per-user credentials mode
      if (!credentials.accessToken) {
        logger.warn('LinkedIn credentials provided but accessToken missing');
        return;
      }

      this.accessToken = credentials.accessToken;
      // Author ID can come from credentials directly or from metadata
      this.authorId = credentials.authorId || credentials.metadata?.authorUrn?.replace('urn:li:person:', '');

      if (!this.authorId) {
        logger.warn('LinkedIn credentials missing authorId - will need to fetch from API');
      }

      logger.debug('LinkedIn publisher initialized with user credentials');
    } else {
      // Legacy mode: use environment variables
      if (!process.env.LINKEDIN_ACCESS_TOKEN) {
        logger.warn('LinkedIn credentials not configured');
        return;
      }

      this.accessToken = process.env.LINKEDIN_ACCESS_TOKEN;
      this.authorId = process.env.LINKEDIN_AUTHOR_ID;
      logger.debug('LinkedIn publisher initialized with environment credentials');
    }
  }

  /**
   * Create a new LinkedInPublisher instance with user-specific credentials
   * @param {Object} credentials - User's OAuth credentials
   * @returns {LinkedInPublisher} New publisher instance
   */
  static withCredentials(credentials) {
    return new LinkedInPublisher(credentials);
  }

  /**
   * Fetch the user's LinkedIn profile ID if not already set
   */
  async ensureAuthorId() {
    if (this.authorId) return this.authorId;

    try {
      const response = await axios.get('https://api.linkedin.com/v2/userinfo', {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`
        }
      });

      this.authorId = response.data.sub;
      logger.info(`Fetched LinkedIn author ID: ${this.authorId}`);
      return this.authorId;
    } catch (error) {
      logger.error('Failed to fetch LinkedIn user info:', error.message);
      throw new Error('Could not determine LinkedIn author ID');
    }
  }

async publishPost(content, mediaUrl = null) {
  try {
    if (!this.accessToken) {
      throw new Error('LinkedIn access token not configured');
    }

    // Ensure we have the author ID
    await this.ensureAuthorId();

    // Add debug logging
    logger.debug(`LinkedIn publish attempt - Token exists: ${!!this.accessToken}`);
    logger.debug(`LinkedIn author ID: ${this.authorId}`);
    
    let mediaAsset = null;
      
      // Register media upload if video provided
      if (mediaUrl) {
        mediaAsset = await this.uploadVideo(mediaUrl);
      }
      
      const postData = {
        author: `urn:li:person:${this.authorId}`,
        lifecycleState: 'PUBLISHED',
        specificContent: {
          'com.linkedin.ugc.ShareContent': {
            shareCommentary: {
              text: this.formatForLinkedIn(content)
            },
            shareMediaCategory: mediaAsset ? 'VIDEO' : 'NONE',
            ...(mediaAsset && { media: [mediaAsset] })
          }
        },
        visibility: {
          'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC'
        }
      };
      
      const response = await axios.post(
        'https://api.linkedin.com/v2/ugcPosts',
        postData,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
            'X-Restli-Protocol-Version': '2.0.0'
          }
        }
      );
      
      logger.info(`Successfully published to LinkedIn: ${response.data.id}`);
      
      return {
        success: true,
        platform: 'linkedin',
        postId: response.data.id,
        url: response.data.url || `https://www.linkedin.com/feed/update/${response.data.id}`
      };
  } catch (error) {
    // Enhance error logging
    logger.error('LinkedIn publishing error:', {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      message: error.message
    });
    
    // If 401, token might be expired
    if (error.response?.status === 401) {
      logger.error('LinkedIn token appears to be invalid or expired');
      logger.error('Token preview:', this.accessToken?.substring(0, 20) + '...');
    }
    
    throw error;
  }
}
  
formatForLinkedIn(content) {
  // Strip HTML but keep line breaks and structure
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
    .replace(/\n{3,}/g, '\n\n') // Max 2 consecutive newlines
    .trim();
}
  
  async uploadVideo(videoUrl) {
    // LinkedIn video upload is complex and requires multiple steps
    // This is a simplified version - you'll need to implement the full flow
    logger.warn('Video upload to LinkedIn not fully implemented');
    return null;
  }
}

export default LinkedInPublisher;