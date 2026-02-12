// services/RateLimiter.js
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[RateLimiter] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

class RateLimiter {
  constructor() {
    // Platform-specific rate limits (per hour)
    this.platformLimits = {
      twitter: {
        posts: 50,        // 50 posts per hour
        window: 3600000   // 1 hour in ms
      },
      linkedin: {
        posts: 10,        // 10 posts per hour
        window: 3600000   // 1 hour in ms
      },
      reddit: {
        posts: 30,        // 30 posts per hour
        window: 3600000   // 1 hour in ms
      },
      facebook: {
        posts: 20,        // 20 posts per hour
        window: 3600000   // 1 hour in ms
      },
      instagram: {
        posts: 20,        // 20 posts per hour
        window: 3600000   // 1 hour in ms
      },
      telegram: {
        posts: 30,        // 30 posts per hour
        window: 3600000   // 1 hour in ms
      },
      threads: {
        posts: 20,        // 20 posts per hour
        window: 3600000   // 1 hour in ms
      },
      whatsapp: {
        posts: 20,        // 20 posts per hour
        window: 3600000   // 1 hour in ms
      }
    };
    
    // Track usage per user per platform
    this.usage = new Map(); // userId -> { platform -> { count, windowStart } }
  }

  async checkLimit(userId, platform) {
    const limit = this.platformLimits[platform];
    if (!limit) {
      logger.warn(`No rate limit defined for platform: ${platform}`);
      return true; // Allow if no limit defined
    }
    
    // Get or create user usage map
    if (!this.usage.has(userId)) {
      this.usage.set(userId, new Map());
    }
    
    const userUsage = this.usage.get(userId);
    const now = Date.now();
    
    // Get or create platform usage
    if (!userUsage.has(platform)) {
      userUsage.set(platform, {
        count: 0,
        windowStart: now
      });
    }
    
    const platformUsage = userUsage.get(platform);
    
    // Check if window has expired
    if (now - platformUsage.windowStart > limit.window) {
      // Reset window
      platformUsage.count = 0;
      platformUsage.windowStart = now;
    }
    
    // Check if limit reached
    if (platformUsage.count >= limit.posts) {
      logger.warn(`Rate limit reached for user ${userId} on ${platform}: ${platformUsage.count}/${limit.posts}`);
      return false;
    }
    
    return true;
  }

  async recordUsage(userId, platform) {
    if (!this.usage.has(userId)) {
      this.usage.set(userId, new Map());
    }
    
    const userUsage = this.usage.get(userId);
    const now = Date.now();
    
    if (!userUsage.has(platform)) {
      userUsage.set(platform, {
        count: 1,
        windowStart: now
      });
    } else {
      const platformUsage = userUsage.get(platform);
      platformUsage.count++;
    }
    
    const platformUsage = userUsage.get(platform);
    logger.info(`Recorded usage for user ${userId} on ${platform}: ${platformUsage.count} posts in current window`);
  }

  async getRemainingLimit(userId, platform) {
    const limit = this.platformLimits[platform];
    if (!limit) return null;
    
    if (!this.usage.has(userId) || !this.usage.get(userId).has(platform)) {
      return limit.posts;
    }
    
    const userUsage = this.usage.get(userId);
    const platformUsage = userUsage.get(platform);
    const now = Date.now();
    
    // Check if window has expired
    if (now - platformUsage.windowStart > limit.window) {
      return limit.posts;
    }
    
    return Math.max(0, limit.posts - platformUsage.count);
  }

  async getUsageStats(userId) {
    const stats = {};
    
    for (const [platform, limit] of Object.entries(this.platformLimits)) {
      const remaining = await this.getRemainingLimit(userId, platform);
      stats[platform] = {
        limit: limit.posts,
        remaining,
        used: limit.posts - remaining,
        windowMs: limit.window
      };
    }
    
    return stats;
  }

  // Clean up old usage data (run periodically)
  async cleanup() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [userId, userUsage] of this.usage.entries()) {
      for (const [platform, usage] of userUsage.entries()) {
        const limit = this.platformLimits[platform];
        if (limit && now - usage.windowStart > limit.window * 2) {
          // Remove usage data older than 2 windows
          userUsage.delete(platform);
          cleaned++;
        }
      }
      
      // Remove user if no platform usage
      if (userUsage.size === 0) {
        this.usage.delete(userId);
      }
    }
    
    if (cleaned > 0) {
      logger.info(`Cleaned up ${cleaned} old usage records`);
    }
  }
}

export default RateLimiter;