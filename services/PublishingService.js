// services/PublishingService.js
import winston from 'winston';
import TwitterPublisher from '../publishers/TwitterPublisher.js';
import LinkedInPublisher from '../publishers/LinkedInPublisher.js';
import RedditPublisher from '../publishers/RedditPublisher.js';
import MockPublisher from '../publishers/MockPublisher.js';
import { createPost } from './database-wrapper.js';

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
    this.publishers = {};
    this.initializePublishers();
  }

  initializePublishers() {
    // Initialize real publishers if credentials exist
    if (process.env.TWITTER_API_KEY && process.env.TWITTER_API_SECRET) {
      this.publishers.twitter = new TwitterPublisher();
      logger.info('Twitter publisher initialized');
    } else {
      this.publishers.twitter = new MockPublisher('twitter');
      logger.info('Twitter mock publisher initialized');
    }
    
    if (process.env.LINKEDIN_ACCESS_TOKEN) {
      this.publishers.linkedin = new LinkedInPublisher();
      logger.info('LinkedIn publisher initialized');
    } else {
      this.publishers.linkedin = new MockPublisher('linkedin');
      logger.info('LinkedIn mock publisher initialized');
    }
    
    if (process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET) {
      this.publishers.reddit = new RedditPublisher();
      logger.info('Reddit publisher initialized');
    } else {
      this.publishers.reddit = new MockPublisher('reddit');
      logger.info('Reddit mock publisher initialized');
    }
    
    // Facebook and Instagram use mock publishers for now
    this.publishers.facebook = new MockPublisher('facebook');
    this.publishers.instagram = new MockPublisher('instagram');
  }

  async publishToTwitter(content, userId) {
    try {
      const publisher = this.publishers.twitter;
      if (!publisher) {
        throw new Error('Twitter publisher not initialized');
      }
      
      const result = await publisher.publishPost(content.text);
      
      if (result.success) {
        // Save to database
        await this.savePostToDatabase(userId, 'twitter', content, result);
        
        logger.info(`Successfully published to Twitter for user ${userId}`);
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

  async publishToLinkedIn(content, userId) {
    try {
      const publisher = this.publishers.linkedin;
      if (!publisher) {
        throw new Error('LinkedIn publisher not initialized');
      }
      
      const result = await publisher.publishPost(content.text);
      
      if (result.success) {
        // Save to database
        await this.savePostToDatabase(userId, 'linkedin', content, result);
        
        logger.info(`Successfully published to LinkedIn for user ${userId}`);
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

  async publishToReddit(content, subreddit, userId) {
    try {
      const publisher = this.publishers.reddit;
      if (!publisher) {
        throw new Error('Reddit publisher not initialized');
      }
      
      // Parse Reddit content format
      const lines = content.text.split('\n');
      const title = lines[0].replace('Title: ', '');
      const body = lines.slice(1).join('\n').replace('Content: ', '');
      
      const result = await publisher.submitPost(subreddit, title, body);
      
      if (result.success) {
        // Save to database
        await this.savePostToDatabase(userId, 'reddit', content, result);
        
        logger.info(`Successfully published to Reddit for user ${userId}`);
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

  async publishToFacebook(content, userId) {
    try {
      const publisher = this.publishers.facebook;
      const result = await publisher.publishPost(content.text);
      
      if (result.success) {
        await this.savePostToDatabase(userId, 'facebook', content, result);
        
        logger.info(`Successfully published to Facebook (mock) for user ${userId}`);
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
      const publisher = this.publishers.instagram;
      const result = await publisher.publishPost(content.text);
      
      if (result.success) {
        await this.savePostToDatabase(userId, 'instagram', content, result);
        
        logger.info(`Successfully published to Instagram (mock) for user ${userId}`);
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

  async savePostToDatabase(userId, platform, content, publishResult) {
    try {
      const postData = {
        topic: content.trend,
        content: content.text,
        platforms: [platform],
        publishedAt: new Date().toISOString(),
        status: 'published',
        metadata: {
          sourceUrl: content.source,
          postId: publishResult.postId,
          postUrl: publishResult.url,
          generatedAt: content.generatedAt
        }
      };
      
      await createPost(userId, postData);
      logger.info(`Post saved to database for user ${userId} on ${platform}`);
      
    } catch (error) {
      logger.error(`Failed to save post to database:`, error);
      // Don't throw - we still published successfully
    }
  }

  async publishToMultiplePlatforms(content, platforms, userId) {
    const results = [];
    
    for (const platform of platforms) {
      try {
        let result;
        
        switch (platform) {
          case 'twitter':
            result = await this.publishToTwitter(content, userId);
            break;
          case 'linkedin':
            result = await this.publishToLinkedIn(content, userId);
            break;
          case 'reddit':
            result = await this.publishToReddit(content, content.subreddit || 'technology', userId);
            break;
          case 'facebook':
            result = await this.publishToFacebook(content, userId);
            break;
          case 'instagram':
            result = await this.publishToInstagram(content, userId);
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
    
    return results;
  }
}

// Create singleton instance
const publishingService = new PublishingService();

// Export individual platform functions for backward compatibility
export const publishToTwitter = (content, userId) => publishingService.publishToTwitter(content, userId);
export const publishToLinkedIn = (content, userId) => publishingService.publishToLinkedIn(content, userId);
export const publishToReddit = (content, subreddit, userId) => publishingService.publishToReddit(content, subreddit, userId);
export const publishToFacebook = (content, userId) => publishingService.publishToFacebook(content, userId);
export const publishToInstagram = (content, userId) => publishingService.publishToInstagram(content, userId);
export const publishToMultiplePlatforms = (content, platforms, userId) => publishingService.publishToMultiplePlatforms(content, platforms, userId);

export default publishingService;