// publishers/TwitterPublisher.js
import { TwitterApi } from 'twitter-api-v2';
import axios from 'axios';
import winston from 'winston';
import '../config/env.js';  // This ensures dotenv loads first

const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[TwitterPublisher] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

class TwitterPublisher {
  /**
   * Create a TwitterPublisher instance
   * @param {Object} credentials - Optional credentials object for per-user publishing
   * @param {string} credentials.accessToken - OAuth 2.0 access token
   * @param {string} credentials.appKey - Twitter API Key (optional, uses env if not provided)
   * @param {string} credentials.appSecret - Twitter API Secret (optional, uses env if not provided)
   * @param {boolean} credentials.isPremium - Whether user has Twitter Premium/Blue
   */
  constructor(credentials = null) {
    this.isPremium = false;

    if (credentials) {
      // Per-user credentials mode (OAuth 2.0 Bearer token)
      if (!credentials.accessToken) {
        logger.warn('Twitter credentials provided but accessToken missing');
        return;
      }

      // Twitter OAuth 2.0 uses Bearer token for user context
      this.client = new TwitterApi(credentials.accessToken);
      this.isPremium = credentials.isPremium || false;
      logger.debug('Twitter publisher initialized with user credentials');
    } else {
      // Legacy mode: use environment variables (OAuth 1.0a)
      if (!process.env.TWITTER_ACCESS_TOKEN) {
        logger.warn('Twitter credentials not configured');
        return;
      }

      this.client = new TwitterApi({
        appKey: process.env.TWITTER_API_KEY,
        appSecret: process.env.TWITTER_API_SECRET,
        accessToken: process.env.TWITTER_ACCESS_TOKEN,
        accessSecret: process.env.TWITTER_ACCESS_SECRET,
      });
      this.isPremium = process.env.TWITTER_PREMIUM === 'true';
      logger.debug('Twitter publisher initialized with environment credentials');
    }
  }

  /**
   * Create a new TwitterPublisher instance with user-specific credentials
   * @param {Object} credentials - User's OAuth credentials
   * @returns {TwitterPublisher} New publisher instance
   */
  static withCredentials(credentials) {
    return new TwitterPublisher(credentials);
  }

async publishPost(content, mediaUrl = null) {
  try {
    if (!this.client) {
      throw new Error('Twitter client not initialized - missing credentials');
    }

    // Add comprehensive debug logging
    logger.debug(`Publishing to Twitter:`);
    logger.debug(`- Original content length: ${content.length} characters`);
    logger.debug(`- Has media: ${!!mediaUrl}`);
    logger.debug(`- TWITTER_PREMIUM: ${process.env.TWITTER_PREMIUM}`);
    
    let mediaId = null;

    // Upload media if provided (image or video)
    if (mediaUrl) {
      try {
        logger.debug(`Downloading media from: ${mediaUrl}`);
        const mediaBuffer = await this.downloadMedia(mediaUrl);
        logger.debug(`Media downloaded, size: ${mediaBuffer.length} bytes`);

        // Detect if it's an image or video based on URL
        const mimeType = this.detectMediaMimeType(mediaUrl);
        logger.debug(`Detected mime type: ${mimeType}`);

        mediaId = await this.client.v1.uploadMedia(mediaBuffer, {
          mimeType,
          target: 'tweet'
        });
        logger.debug(`Media uploaded with ID: ${mediaId}`);
      } catch (mediaError) {
        logger.error('Failed to upload media:', mediaError);
        // Continue without media rather than failing entirely
      }
    }
    
    // Format the content
    const formattedText = this.formatForTwitter(content);
    logger.info(`Final tweet length: ${formattedText.length} characters`);
    
    // Log first 100 chars of the tweet for debugging
    logger.debug(`Tweet preview: "${formattedText.substring(0, 100)}${formattedText.length > 100 ? '...' : ''}"`);
    
    // Publish tweet with better error handling
    let tweet;
    try {
      tweet = await this.client.v2.tweet({
        text: formattedText,
        ...(mediaId && { media: { media_ids: [mediaId] } })
      });
    } catch (tweetError) {
      // Check if it's a duplicate content error
      if (tweetError.code === 403 && tweetError.data?.detail?.includes('duplicate')) {
        logger.warn('Twitter rejected as duplicate content');
        throw new Error('Twitter rejected this as duplicate content. Try varying your post.');
      }
      
      // Check if it's a rate limit error
      if (tweetError.code === 429) {
        logger.error('Twitter rate limit exceeded');
        throw new Error('Twitter rate limit exceeded. Please try again later.');
      }
      
      throw tweetError;
    }
    
    const tweetId = tweet.data.id;
    const tweetUrl = `https://twitter.com/i/status/${tweetId}`; // More reliable URL format
    
    logger.info(`✅ Successfully published to Twitter: ${tweetUrl}`);
    
    return {
      success: true,
      platform: 'twitter',
      postId: tweetId,
      url: tweetUrl,
      characterCount: formattedText.length
    };
  } catch (error) {
    logger.error('Twitter publishing error:', {
      message: error.message,
      code: error.code,
      data: error.data
    });
    throw error;
  }
}
  
formatForTwitter(content) {
  // First, convert <br> tags to newlines to preserve intended line breaks
  let plainText = content
    .replace(/<br\s*\/?>/gi, '\n')  // Convert <br> tags to newlines
    .replace(/<\/p>/gi, '\n\n')      // Convert paragraph ends to double newlines
    .replace(/<p[^>]*>/gi, '')       // Remove paragraph start tags
    .replace(/<[^>]*>/g, '')         // Remove all other HTML tags
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\n{3,}/g, '\n\n')      // Limit to maximum 2 consecutive newlines
    .replace(/[ \t]+/g, ' ')         // Normalize spaces (but not newlines)
    .trim();

  // Debug logging
  logger.debug(`Formatting for Twitter - Original length: ${plainText.length}`);
  logger.debug(`isPremium: ${this.isPremium}`);
  logger.debug(`Number of line breaks: ${(plainText.match(/\n/g) || []).length}`);

  // Check if user has Twitter Blue/Premium for longer posts
  const maxLength = this.isPremium ? 4000 : 280;
  logger.debug(`Using ${this.isPremium ? 'Premium' : 'Standard'} mode with max length: ${maxLength}`);

  // If content fits within limit, return as-is
  if (plainText.length <= maxLength) {
    logger.debug(`Content fits within limit (${plainText.length}/${maxLength}), returning as-is`);
    return plainText;
  }

  // For premium users with long content, return full text
  if (this.isPremium) {
    logger.debug(`Premium user - returning full text (${plainText.length} chars)`);
    return plainText;
  }

  // For non-premium users, we need to truncate intelligently
  logger.debug(`Need to truncate - content is ${plainText.length} chars`);

  // Calculate how much room we need for ellipsis
  const ellipsis = '...';
  const targetLength = maxLength - ellipsis.length; // 277 for standard users

  // First, try to find a good breaking point at a paragraph/section boundary
  const paragraphBreak = plainText.lastIndexOf('\n\n', targetLength);
  const singleBreak = plainText.lastIndexOf('\n', targetLength);
  
  let bestCutPoint = -1;
  
  // Prefer paragraph break if it's not too far back
  if (paragraphBreak > targetLength * 0.7) {
    bestCutPoint = paragraphBreak;
  } else if (singleBreak > targetLength * 0.8) {
    bestCutPoint = singleBreak;
  }

  if (bestCutPoint > 0) {
    const truncated = plainText.substring(0, bestCutPoint).trim() + ellipsis;
    logger.debug(`Truncated at line break: ${truncated.length} chars`);
    return truncated;
  }

  // If no good line break, try sentence boundary
  const sentenceEnders = ['. ', '! ', '? '];
  bestCutPoint = -1;

  for (const ender of sentenceEnders) {
    const lastIndex = plainText.lastIndexOf(ender, targetLength);
    if (lastIndex > bestCutPoint && lastIndex > targetLength * 0.7) {
      bestCutPoint = lastIndex + ender.trim().length;
    }
  }

  if (bestCutPoint > 0) {
    const truncated = plainText.substring(0, bestCutPoint).trim() + ellipsis;
    logger.debug(`Truncated at sentence boundary: ${truncated.length} chars`);
    return truncated;
  }

  // Otherwise, find the last complete word within our target length
  let truncated = plainText.substring(0, targetLength);
  const lastSpace = truncated.lastIndexOf(' ');
  
  if (lastSpace > targetLength * 0.8) {
    truncated = truncated.substring(0, lastSpace);
  }

  // Clean up any trailing punctuation
  truncated = truncated.replace(/[,;:\-–—]\s*$/, '');
  
  const finalText = truncated.trim() + ellipsis;
  logger.debug(`Truncated at word boundary: ${finalText.length} chars`);
  
  return finalText;
}

optimizeForTwitter(content) {
  // Remove redundant emojis if too many
  const emojiCount = (content.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  if (emojiCount > 5) { // Increased threshold since news posts use emojis for structure
    // Keep only the first emoji of each type
    const seen = new Set();
    content = content.replace(/[\u{1F300}-\u{1F9FF}]/gu, (emoji) => {
      if (seen.has(emoji)) return '';
      seen.add(emoji);
      return emoji;
    });
  }
  
  // Ensure there's a space after emojis for better readability
  content = content.replace(/([\u{1F300}-\u{1F9FF}])([A-Za-z])/gu, '$1 $2');
  
  // Don't remove line breaks - they're intentional for formatting
  // Just limit excessive line breaks
  content = content.replace(/\n{4,}/g, '\n\n\n'); // Max 3 consecutive line breaks
  
  return content.trim();
}
  
  async downloadMedia(mediaUrl) {
    const response = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TwitterBot/1.0)',
        'Accept': 'image/*,video/*'
      },
      timeout: 15000,
      maxContentLength: 15 * 1024 * 1024 // 15MB limit
    });
    return Buffer.from(response.data);
  }

  /**
   * Detect the MIME type of media based on URL
   * @param {string} url - The media URL
   * @returns {string} MIME type
   */
  detectMediaMimeType(url) {
    const lowerUrl = url.toLowerCase();

    // Video formats
    if (lowerUrl.includes('.mp4') || lowerUrl.includes('video/mp4')) {
      return 'video/mp4';
    }
    if (lowerUrl.includes('.mov')) {
      return 'video/quicktime';
    }
    if (lowerUrl.includes('.webm')) {
      return 'video/webm';
    }

    // Image formats
    if (lowerUrl.includes('.png')) {
      return 'image/png';
    }
    if (lowerUrl.includes('.gif')) {
      return 'image/gif';
    }
    if (lowerUrl.includes('.webp')) {
      return 'image/webp';
    }

    // Default to JPEG for images (most common for article images)
    // Check common image URL patterns
    if (lowerUrl.includes('.jpg') || lowerUrl.includes('.jpeg') ||
        lowerUrl.includes('/image') || lowerUrl.includes('/img') ||
        lowerUrl.includes('/photo') || lowerUrl.includes('/media') ||
        lowerUrl.includes('unsplash') || lowerUrl.includes('pexels') ||
        lowerUrl.includes('cloudinary') || lowerUrl.includes('imgix') ||
        lowerUrl.includes('twimg.com') || lowerUrl.includes('fbcdn') ||
        lowerUrl.includes('googleusercontent') || lowerUrl.includes('cdn')) {
      return 'image/jpeg';
    }

    // Default to JPEG as fallback for images
    return 'image/jpeg';
  }

  /**
   * Check if URL points to a video
   * @param {string} url - The media URL
   * @returns {boolean} True if video
   */
  isVideoUrl(url) {
    const lowerUrl = url.toLowerCase();
    return lowerUrl.includes('.mp4') || lowerUrl.includes('.mov') ||
           lowerUrl.includes('.webm') || lowerUrl.includes('.avi') ||
           lowerUrl.includes('video/');
  }
}

export default TwitterPublisher;