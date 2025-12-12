// services/PublishingService.js
import winston from 'winston';
import TwitterPublisher from '../publishers/TwitterPublisher.js';
import LinkedInPublisher from '../publishers/LinkedInPublisher.js';
import RedditPublisher from '../publishers/RedditPublisher.js';
import FacebookPublisher from '../publishers/FacebookPublisher.js';
import TelegramPublisher from '../publishers/TelegramPublisher.js';
// MockPublisher removed - SaaS mode requires user's own credentials, no fallbacks
import { createPost } from './database-wrapper.js';
import TokenManager, { TokenDecryptionError } from './TokenManager.js';
import ConnectionManager from './ConnectionManager.js';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[PublishingService] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

class PublishingService {
  constructor() {
    // SaaS mode: NO legacy/fallback publishers
    // Each user MUST connect their own accounts - no posting using app owner's credentials
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info('PublishingService initialized in SaaS MODE');
    logger.info('→ NO legacy fallbacks - users must connect their own accounts');
    logger.info('→ All posts use user-specific OAuth credentials only');
    logger.info('═══════════════════════════════════════════════════════════════');
  }

  /**
   * Get a publisher instance for a specific user and platform
   * Creates a new publisher with user's credentials - NO FALLBACK to legacy
   * @param {string} userId - User ID
   * @param {string} platform - Platform name (twitter, linkedin, reddit, etc.)
   * @returns {Promise<Object>} Publisher instance
   * @throws {Error} When connection is missing, expired, or token decryption fails
   */
  async getPublisherForUser(userId, platform) {
    try {
      // Try to get user's connection for this platform
      // This may throw TokenDecryptionError if tokens cannot be decrypted
      const connection = await TokenManager.getTokens(userId, platform);

      if (connection && connection.status === 'active') {
        logger.info(`✓ Found active ${platform} connection for user ${userId}`);
        logger.info(`  → Platform username: @${connection.platform_username || 'unknown'}`);
        logger.info(`  → Using USER'S credentials (not legacy/env)`);

        // Check if token needs refresh
        if (TokenManager.needsRefresh(connection)) {
          logger.info(`Token for ${platform} needs refresh, attempting refresh...`);
          try {
            await ConnectionManager.refreshTokens(connection.id);
            // Re-fetch the connection with updated tokens
            const refreshedConnection = await TokenManager.getTokens(userId, platform);
            return this.createPublisherWithCredentials(platform, refreshedConnection);
          } catch (refreshError) {
            // Handle token decryption errors during refresh
            if (refreshError instanceof TokenDecryptionError) {
              logger.error(`Token decryption failed during refresh for ${platform}:`, refreshError.message);
              throw new Error(`Your ${platform} connection credentials are invalid. Please disconnect and reconnect your ${platform} account in Settings.`);
            }
            logger.error(`Failed to refresh ${platform} token:`, refreshError);
            throw new Error(`${platform} token expired and refresh failed. Please reconnect your account.`);
          }
        }

        return this.createPublisherWithCredentials(platform, connection);
      }

      // Check if connection exists but is in error/expired state
      if (connection && (connection.status === 'error' || connection.status === 'expired')) {
        logger.error(`✗ ${platform} connection for user ${userId} is ${connection.status}`);
        logger.error(`  → Last error: ${connection.last_error || 'none'}`);
        throw new Error(`Your ${platform} connection has ${connection.status === 'expired' ? 'expired' : 'an error'}. Please disconnect and reconnect your ${platform} account in Settings.`);
      }

      // No user connection - DO NOT fall back to legacy for SaaS
      // User must connect their own account
      logger.error(`✗ No ${platform} connection for user ${userId}`);
      logger.error(`  → User must connect their ${platform} account first`);
      throw new Error(`No ${platform} connection. Please connect your ${platform} account in Settings.`);

    } catch (error) {
      // Handle token decryption errors with a clear user message
      if (error instanceof TokenDecryptionError) {
        logger.error(`Token decryption failed for ${platform} (user: ${userId}): ${error.message}`);
        throw new Error(`Your ${platform} connection credentials are invalid. Please disconnect and reconnect your ${platform} account in Settings.`);
      }

      logger.error(`Error getting publisher for ${platform}:`, error.message);
      // Re-throw - don't silently fall back to legacy credentials
      throw error;
    }
  }

  /**
   * Create a publisher instance with user-specific credentials
   * @param {string} platform - Platform name
   * @param {Object} connection - Connection data with decrypted tokens
   * @returns {Object} Publisher instance
   */
  createPublisherWithCredentials(platform, connection) {
    logger.info(`Creating ${platform} publisher with USER credentials:`);
    logger.info(`  → Account: @${connection.platform_username || 'unknown'}`);
    logger.info(`  → Platform ID: ${connection.platform_user_id || 'unknown'}`);
    logger.info(`  → Token present: ${connection.access_token ? 'YES' : 'NO'}`);

    const credentials = {
      accessToken: connection.access_token,
      refreshToken: connection.refresh_token,
      username: connection.platform_username,
      metadata: connection.platform_metadata || {}
    };

    switch (platform) {
      case 'twitter':
        credentials.isPremium = connection.platform_metadata?.isPremium || false;
        logger.info(`  → Twitter Premium: ${credentials.isPremium}`);
        return TwitterPublisher.withCredentials(credentials);

      case 'linkedin':
        credentials.authorId = connection.platform_user_id;
        logger.info(`  → LinkedIn Author URN: ${credentials.authorId}`);
        return LinkedInPublisher.withCredentials(credentials);

      case 'reddit':
        return RedditPublisher.withCredentials(credentials);

      case 'facebook':
        credentials.pageId = connection.platform_metadata?.pageId;
        credentials.pageAccessToken = connection.platform_metadata?.pageAccessToken;
        credentials.metadata = {
          pageId: connection.platform_metadata?.pageId,
          pageAccessToken: connection.platform_metadata?.pageAccessToken,
          pageName: connection.platform_metadata?.pageName
        };
        logger.info(`  → Facebook Page ID: ${credentials.pageId || 'will auto-fetch'}`);
        logger.info(`  → Facebook Page Name: ${credentials.metadata.pageName || 'unknown'}`);
        return FacebookPublisher.withCredentials(credentials);

      case 'telegram':
        // Telegram uses app-wide bot token, user provides channel info
        credentials.chatId = connection.platform_user_id || connection.platform_metadata?.chatId;
        credentials.channelUsername = connection.platform_username;
        credentials.metadata = connection.platform_metadata || {};
        logger.info(`  → Telegram Chat ID: ${credentials.chatId}`);
        logger.info(`  → Telegram Channel: ${credentials.channelUsername || 'private channel'}`);
        return TelegramPublisher.withCredentials(credentials);

      case 'instagram':
        // Instagram is not yet implemented
        logger.error(`${platform} publishing not yet implemented`);
        throw new Error(`${platform} publishing is coming soon. Currently supported: Twitter, LinkedIn, Reddit, Facebook`);

      default:
        logger.error(`Unknown platform: ${platform}`);
        throw new Error(`Unsupported platform: ${platform}`);
    }
  }

  /**
   * Check if user has active connection for a platform
   * @param {string} userId - User ID
   * @param {string} platform - Platform name
   * @returns {Promise<boolean>} True if user has active connection
   */
  async hasUserConnection(userId, platform) {
    const connection = await TokenManager.getTokens(userId, platform);
    return connection && connection.status === 'active';
  }

  /**
   * Validate user has all required connections before publishing
   * @param {string} userId - User ID
   * @param {string[]} platforms - Array of platform names
   * @returns {Promise<Object>} { valid: boolean, missing: string[] }
   */
  async validateConnections(userId, platforms) {
    const status = await ConnectionManager.checkConnections(userId, platforms);
    return {
      valid: status.allConnected,
      missing: status.missing,
      connected: status.connected
    };
  }

  async publishToTwitter(content, userId, imageUrl = null) {
    try {
      const publisher = await this.getPublisherForUser(userId, 'twitter');
      if (!publisher) {
        throw new Error('Twitter publisher not available');
      }

      // Pass imageUrl to publisher - it will handle image upload
      const mediaUrl = imageUrl || content.imageUrl || null;
      const result = await publisher.publishPost(content.text, mediaUrl);

      if (result.success) {
        // Save to database
        await this.savePostToDatabase(userId, 'twitter', content, result, mediaUrl);

        // Update last_used_at for the connection
        await this.updateConnectionLastUsed(userId, 'twitter');

        logger.info(`Successfully published to Twitter for user ${userId}${mediaUrl ? ' with image' : ''}`);
        return {
          success: true,
          platform: 'twitter',
          postId: result.postId,
          url: result.url
        };
      }

      throw new Error('Twitter publishing failed');

    } catch (error) {
      logger.error(`Failed to publish to Twitter for user ${userId}:`, error);
      throw error;
    }
  }

  async publishToLinkedIn(content, userId, imageUrl = null) {
    try {
      const publisher = await this.getPublisherForUser(userId, 'linkedin');
      if (!publisher) {
        throw new Error('LinkedIn publisher not available');
      }

      // Pass imageUrl to publisher - it will handle image upload
      const mediaUrl = imageUrl || content.imageUrl || null;
      const result = await publisher.publishPost(content.text, mediaUrl);

      if (result.success) {
        // Save to database
        await this.savePostToDatabase(userId, 'linkedin', content, result, mediaUrl);

        // Update last_used_at for the connection
        await this.updateConnectionLastUsed(userId, 'linkedin');

        logger.info(`Successfully published to LinkedIn for user ${userId}${mediaUrl ? ' with image' : ''}`);
        return {
          success: true,
          platform: 'linkedin',
          postId: result.postId,
          url: result.url
        };
      }

      throw new Error('LinkedIn publishing failed');

    } catch (error) {
      logger.error(`Failed to publish to LinkedIn for user ${userId}:`, error);
      throw error;
    }
  }

  async publishToReddit(content, subreddit, userId, flairId = null, imageUrl = null) {
    try {
      const publisher = await this.getPublisherForUser(userId, 'reddit');
      if (!publisher) {
        throw new Error('Reddit publisher not available');
      }

      // Use the publisher's publishPost method with subreddit and flair parameters
      // Priority: explicit subreddit param > content.subreddit > auto-select
      const targetSubreddit = subreddit || content.subreddit || null;
      const targetFlairId = flairId || content.flairId || null;
      const mediaUrl = imageUrl || content.imageUrl || null;
      const result = await publisher.publishPost(content.text, mediaUrl, targetSubreddit, targetFlairId);

      if (result.success) {
        // Save to database
        await this.savePostToDatabase(userId, 'reddit', content, result, mediaUrl);

        // Update last_used_at for the connection
        await this.updateConnectionLastUsed(userId, 'reddit');

        logger.info(`Successfully published to Reddit for user ${userId}${targetFlairId ? ' with flair' : ''}${mediaUrl ? ' with image' : ''}`);
        return {
          success: true,
          platform: 'reddit',
          postId: result.postId,
          url: result.url
        };
      }

      throw new Error('Reddit publishing failed');

    } catch (error) {
      logger.error(`Failed to publish to Reddit for user ${userId}:`, error);
      throw error;
    }
  }

  async publishToFacebook(content, userId, imageUrl = null) {
    try {
      const publisher = await this.getPublisherForUser(userId, 'facebook');

      // Pass imageUrl to publisher - Facebook already supports photo posts
      const mediaUrl = imageUrl || content.imageUrl || null;
      const result = await publisher.publishPost(content.text, mediaUrl);

      if (result.success) {
        await this.savePostToDatabase(userId, 'facebook', content, result, mediaUrl);
        await this.updateConnectionLastUsed(userId, 'facebook');

        logger.info(`Successfully published to Facebook for user ${userId}${mediaUrl ? ' with image' : ''}`);
        return {
          success: true,
          platform: 'facebook',
          postId: result.postId,
          url: result.url
        };
      }

      throw new Error('Facebook publishing failed');

    } catch (error) {
      logger.error(`Failed to publish to Facebook for user ${userId}:`, error);
      throw error;
    }
  }

  async publishToInstagram(content, userId) {
    try {
      const publisher = await this.getPublisherForUser(userId, 'instagram');
      const result = await publisher.publishPost(content.text);

      if (result.success) {
        await this.savePostToDatabase(userId, 'instagram', content, result);
        await this.updateConnectionLastUsed(userId, 'instagram');

        logger.info(`Successfully published to Instagram for user ${userId}`);
        return {
          success: true,
          platform: 'instagram',
          postId: result.postId,
          url: result.url
        };
      }

      throw new Error('Instagram publishing failed');

    } catch (error) {
      logger.error(`Failed to publish to Instagram for user ${userId}:`, error);
      throw error;
    }
  }

  async publishToTelegram(content, userId, imageUrl = null) {
    try {
      const publisher = await this.getPublisherForUser(userId, 'telegram');

      // Pass imageUrl to publisher - Telegram already supports photo posts
      const mediaUrl = imageUrl || content.imageUrl || null;
      const result = await publisher.publishPost(content.text, mediaUrl);

      if (result.success) {
        await this.savePostToDatabase(userId, 'telegram', content, result, mediaUrl);
        await this.updateConnectionLastUsed(userId, 'telegram');

        logger.info(`Successfully published to Telegram for user ${userId}${mediaUrl ? ' with image' : ''}`);
        return {
          success: true,
          platform: 'telegram',
          postId: result.postId,
          url: result.url,
          chatId: result.chatId
        };
      }

      throw new Error('Telegram publishing failed');

    } catch (error) {
      logger.error(`Failed to publish to Telegram for user ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Update the last_used_at timestamp for a connection
   * @param {string} userId - User ID
   * @param {string} platform - Platform name
   */
  async updateConnectionLastUsed(userId, platform) {
    try {
      const { supabaseAdmin } = await import('./supabase.js');
      await supabaseAdmin
        .from('social_connections')
        .update({ last_used_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('platform', platform);
    } catch (error) {
      // Don't fail the publish if this update fails
      logger.warn(`Failed to update last_used_at for ${platform}:`, error.message);
    }
  }

  async savePostToDatabase(userId, platform, content, publishResult, imageUrl = null) {
    try {
      // Handle different content object formats
      const topic = content.trend || content.source?.title || content.topic || 'Generated Content';
      const sourceUrl = typeof content.source === 'string' ? content.source : content.source?.url || '';

      const postData = {
        topic,
        content: content.text,
        platforms: [platform],
        publishedAt: new Date().toISOString(),
        status: 'published',
        source_article_image: imageUrl || content.imageUrl || null, // Store image URL
        metadata: {
          sourceUrl,
          postId: publishResult.postId,
          postUrl: publishResult.url,
          generatedAt: content.generatedAt || new Date().toISOString(),
          imageUrl: imageUrl || content.imageUrl || null // Also in metadata for convenience
        }
      };

      await createPost(userId, postData);
      logger.info(`Post saved to database for user ${userId} on ${platform}${imageUrl ? ' with image' : ''}`);

    } catch (error) {
      logger.error(`Failed to save post to database:`, error.message);
      // Don't throw - we still published successfully
    }
  }

  async publishToMultiplePlatforms(content, platforms, userId, options = {}) {
    const results = [];
    const { requireConnections = false, skipMissing = false, imageUrl = null } = options;

    // Get imageUrl from options or content object
    const mediaUrl = imageUrl || content.imageUrl || null;

    // Optionally validate connections before publishing
    if (requireConnections) {
      const validation = await this.validateConnections(userId, platforms);
      if (!validation.valid) {
        if (!skipMissing) {
          return {
            success: false,
            error: `Missing connections for: ${validation.missing.join(', ')}`,
            missing: validation.missing,
            results: []
          };
        }
        // Filter out missing platforms
        platforms = validation.connected;
        logger.warn(`Skipping platforms without connections: ${validation.missing.join(', ')}`);
      }
    }

    if (mediaUrl) {
      logger.info(`Publishing to ${platforms.length} platforms with image: ${mediaUrl}`);
    }

    for (const platform of platforms) {
      try {
        let result;

        switch (platform) {
          case 'twitter':
            result = await this.publishToTwitter(content, userId, mediaUrl);
            break;
          case 'linkedin':
            result = await this.publishToLinkedIn(content, userId, mediaUrl);
            break;
          case 'reddit':
            result = await this.publishToReddit(content, content.subreddit || 'technology', userId, content.flairId || null, mediaUrl);
            break;
          case 'facebook':
            result = await this.publishToFacebook(content, userId, mediaUrl);
            break;
          case 'instagram':
            result = await this.publishToInstagram(content, userId);
            break;
          case 'telegram':
            result = await this.publishToTelegram(content, userId, mediaUrl);
            break;
          default:
            throw new Error(`Unsupported platform: ${platform}`);
        }

        results.push(result);

      } catch (error) {
        logger.error(`Failed to publish to ${platform}:`, error);
        results.push({
          success: false,
          platform,
          error: error.message
        });
      }
    }

    // Calculate overall success
    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    return {
      success: failCount === 0,
      partial: successCount > 0 && failCount > 0,
      results,
      summary: {
        total: results.length,
        succeeded: successCount,
        failed: failCount
      }
    };
  }
}

// Create singleton instance
const publishingService = new PublishingService();

// Export individual platform functions for backward compatibility
export const publishToTwitter = (content, userId, imageUrl = null) => publishingService.publishToTwitter(content, userId, imageUrl);
export const publishToLinkedIn = (content, userId, imageUrl = null) => publishingService.publishToLinkedIn(content, userId, imageUrl);
export const publishToReddit = (content, subreddit, userId, flairId = null, imageUrl = null) => publishingService.publishToReddit(content, subreddit, userId, flairId, imageUrl);
export const publishToFacebook = (content, userId, imageUrl = null) => publishingService.publishToFacebook(content, userId, imageUrl);
export const publishToInstagram = (content, userId) => publishingService.publishToInstagram(content, userId);
export const publishToTelegram = (content, userId, imageUrl = null) => publishingService.publishToTelegram(content, userId, imageUrl);
export const publishToMultiplePlatforms = (content, platforms, userId, options) =>
  publishingService.publishToMultiplePlatforms(content, platforms, userId, options);

// New exports for per-user connection management
export const validateConnections = (userId, platforms) => publishingService.validateConnections(userId, platforms);
export const hasUserConnection = (userId, platform) => publishingService.hasUserConnection(userId, platform);
export const getPublisherForUser = (userId, platform) => publishingService.getPublisherForUser(userId, platform);

export default publishingService;