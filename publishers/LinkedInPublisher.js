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
    let mediaCategory = 'NONE';

    // Upload media if provided (image or video)
    if (mediaUrl) {
      logger.debug(`Media URL provided: ${mediaUrl}`);
      const isImage = this.isImageUrl(mediaUrl);

      if (isImage) {
        logger.debug('Detected as image, uploading...');
        mediaAsset = await this.uploadImage(mediaUrl);
        if (mediaAsset) {
          mediaCategory = 'IMAGE';
        }
      } else {
        logger.debug('Detected as video, attempting upload...');
        mediaAsset = await this.uploadVideo(mediaUrl);
        if (mediaAsset) {
          mediaCategory = 'VIDEO';
        }
      }
    }

    const postData = {
      author: `urn:li:person:${this.authorId}`,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: {
            text: this.formatForLinkedIn(content)
          },
          shareMediaCategory: mediaCategory,
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

  /**
   * Upload an image to LinkedIn using their 3-step upload process
   * @param {string} imageUrl - URL of the image to upload
   * @returns {Object|null} Media asset object for the post, or null if upload fails
   */
  async uploadImage(imageUrl) {
    try {
      logger.info(`Uploading image to LinkedIn: ${imageUrl}`);

      // Step 1: Register the image upload
      const registerResponse = await axios.post(
        'https://api.linkedin.com/v2/assets?action=registerUpload',
        {
          registerUploadRequest: {
            recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
            owner: `urn:li:person:${this.authorId}`,
            serviceRelationships: [
              {
                relationshipType: 'OWNER',
                identifier: 'urn:li:userGeneratedContent'
              }
            ]
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
            'X-Restli-Protocol-Version': '2.0.0'
          }
        }
      );

      const uploadUrl = registerResponse.data.value.uploadMechanism['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'].uploadUrl;
      const asset = registerResponse.data.value.asset;

      logger.debug(`Got upload URL and asset: ${asset}`);

      // Step 2: Download the image
      logger.debug(`Downloading image from: ${imageUrl}`);
      const imageResponse = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; LinkedInBot/1.0)',
          'Accept': 'image/*'
        },
        timeout: 15000,
        maxContentLength: 10 * 1024 * 1024 // 10MB limit
      });

      // Step 3: Upload the image to LinkedIn
      logger.debug(`Uploading ${imageResponse.data.length} bytes to LinkedIn...`);
      await axios.put(uploadUrl, imageResponse.data, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/octet-stream'
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      });

      logger.info(`Image uploaded successfully to LinkedIn`);

      // Return the media asset for the post
      return {
        status: 'READY',
        description: {
          text: 'Article image'
        },
        media: asset,
        title: {
          text: 'Article image'
        }
      };

    } catch (error) {
      logger.error('Error uploading image to LinkedIn:', error.message);
      if (error.response) {
        logger.error('Error status:', error.response.status);
        logger.error('Error details:', JSON.stringify(error.response.data, null, 2));
      }
      logger.warn('Image upload failed, post will continue without image');
      // Return null if image upload fails - post will continue without image
      return null;
    }
  }

  /**
   * Check if URL points to an image
   * @param {string} url - The media URL
   * @returns {boolean} True if it's an image URL
   */
  isImageUrl(url) {
    const lowerUrl = url.toLowerCase();

    // Check for image extensions
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    if (imageExtensions.some(ext => lowerUrl.includes(ext))) {
      return true;
    }

    // Check for known image hosting services
    if (lowerUrl.includes('unsplash.com') ||
        lowerUrl.includes('googleusercontent.com') ||
        lowerUrl.includes('ggpht.com') ||
        lowerUrl.includes('gstatic.com') ||
        lowerUrl.includes('images.') ||
        lowerUrl.includes('/photo-') ||
        lowerUrl.includes('imgur.com') ||
        lowerUrl.includes('cloudinary.com') ||
        lowerUrl.includes('twimg.com') ||
        lowerUrl.includes('fbcdn.net') ||
        lowerUrl.includes('pinimg.com') ||
        lowerUrl.includes('pexels.com') ||
        lowerUrl.includes('/image') ||
        lowerUrl.includes('/img') ||
        lowerUrl.includes('/media') ||
        lowerUrl.includes('/uploads')) {
      return true;
    }

    // Check for width/height params (common for images)
    if (/\?.*w=\d+.*h=\d+/.test(lowerUrl)) {
      return true;
    }

    // Check for video extensions (return false for these)
    const videoExtensions = ['.mp4', '.mov', '.avi', '.webm', '.flv'];
    if (videoExtensions.some(ext => lowerUrl.includes(ext))) {
      return false;
    }

    // Default: assume it's an image if no clear video indicators
    return true;
  }
}

export default LinkedInPublisher;