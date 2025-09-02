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
  constructor() {
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
    
    // Upload video if provided
    if (mediaUrl) {
      try {
        logger.debug(`Downloading media from: ${mediaUrl}`);
        const mediaBuffer = await this.downloadMedia(mediaUrl);
        logger.debug(`Media downloaded, size: ${mediaBuffer.length} bytes`);
        
        mediaId = await this.client.v1.uploadMedia(mediaBuffer, {
          mimeType: 'video/mp4',
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
  logger.debug(`TWITTER_PREMIUM env var: "${process.env.TWITTER_PREMIUM}"`);
  logger.debug(`Number of line breaks: ${(plainText.match(/\n/g) || []).length}`);

  // Check if user has Twitter Blue/Premium for longer posts
  const isPremium = process.env.TWITTER_PREMIUM === 'true';
  const maxLength = isPremium ? 4000 : 280;
  // Add warning if TWITTER_PREMIUM is not explicitly set
  if (process.env.TWITTER_PREMIUM === undefined) {
    logger.warn('TWITTER_PREMIUM environment variable not set - defaulting to standard 280 character limit');
  }
  logger.debug(`Using ${isPremium ? 'Premium' : 'Standard'} mode with max length: ${maxLength}`);

  // If content fits within limit, return as-is
  if (plainText.length <= maxLength) {
    logger.debug(`Content fits within limit (${plainText.length}/${maxLength}), returning as-is`);
    return plainText;
  }

  // For premium users with long content, return full text
  if (isPremium) {
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
      responseType: 'arraybuffer'
    });
    return Buffer.from(response.data);
  }
}

export default TwitterPublisher;