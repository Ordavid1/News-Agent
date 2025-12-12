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
  constructor() {
    if (!process.env.LINKEDIN_ACCESS_TOKEN) {
      logger.warn('LinkedIn credentials not configured');
      return;
    }
    
    this.accessToken = process.env.LINKEDIN_ACCESS_TOKEN;
    this.authorId = process.env.LINKEDIN_AUTHOR_ID;
  }

async publishPost(content, mediaUrl = null) {
  try {
    // Add debug logging
    logger.debug(`LinkedIn publish attempt - Token exists: ${!!this.accessToken}`);
    logger.debug(`LinkedIn author ID: ${this.authorId}`);
    logger.debug(`Media URL provided: ${mediaUrl ? 'Yes' : 'No'}`);
    
    let mediaAsset = null;
      
      // Register media upload if media provided
      if (mediaUrl) {
        // Check if it's an image or video
        // Look for image extensions or known image hosting services
        const isImage = /\.(jpg|jpeg|png|gif|webp)/i.test(mediaUrl) || // Has image extension (anywhere in URL)
                        mediaUrl.includes('unsplash.com') ||              // Unsplash images
                        mediaUrl.includes('googleusercontent.com') ||     // Google-hosted images
                        mediaUrl.includes('ggpht.com') ||                 // Google Photos
                        mediaUrl.includes('gstatic.com') ||               // Google static content
                        mediaUrl.includes('images.') ||                   // Common image subdomain
                        mediaUrl.includes('/photo-') ||                   // Unsplash photo pattern
                        mediaUrl.includes('imgur.com') ||                 // Imgur
                        mediaUrl.includes('cloudinary.com') ||            // Cloudinary
                        mediaUrl.includes('twimg.com') ||                 // Twitter images
                        mediaUrl.includes('fbcdn.net') ||                 // Facebook CDN
                        mediaUrl.includes('pinimg.com') ||                // Pinterest images
                        mediaUrl.includes('pexels.com') ||                // Pexels images
                        /\?.*w=\d+.*h=\d+/.test(mediaUrl);               // Has width/height params (common for images)
        
        if (isImage) {
          logger.debug('Detected as image, uploading...');
          mediaAsset = await this.uploadImage(mediaUrl);
        } else {
          logger.debug('Detected as video, attempting upload...');
          mediaAsset = await this.uploadVideo(mediaUrl);
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
            shareMediaCategory: mediaAsset ? 'IMAGE' : 'NONE',
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
      const uploadResponse = await axios.put(uploadUrl, imageResponse.data, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/octet-stream'
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      });

      logger.info(`Image uploaded successfully to LinkedIn (status: ${uploadResponse.status})`);

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
}

export default LinkedInPublisher;