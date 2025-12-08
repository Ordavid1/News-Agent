// services/DatabaseManager.js
// Converted from Firestore to Supabase API
import winston from 'winston';

const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[DatabaseManager] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

class DatabaseManager {
  constructor(db) {
    // db is now the Supabase client (supabaseAdmin)
    this.db = db;
    this.tables = {
      scheduled_posts: 'scheduled_posts',
      published_posts: 'published_posts',
      trend_history: 'trend_history',
      automation_logs: 'automation_logs',
      analytics_reports: 'analytics_reports'
    };

    this.initializeCollections();
  }

  async initializeCollections() {
    try {
      // Supabase tables are created via migrations, just log readiness
      logger.info('Database collections ready');
      return true;
    } catch (error) {
      logger.error('Database initialization error:', error);
      return false;
    }
  }

  async saveScheduledPost(postData) {
    try {
      const { data, error } = await this.db
        .from(this.tables.scheduled_posts)
        .insert({
          ...postData,
          created_at: new Date().toISOString(),
          status: 'pending'
        })
        .select()
        .single();

      if (error) throw error;

      logger.debug(`Scheduled post saved with ID: ${data.id}`);
      return data.id;
    } catch (error) {
      logger.error('Error saving scheduled post:', error);
      throw error;
    }
  }

  async savePublishedPost(postData) {
    try {
      const { data, error } = await this.db
        .from(this.tables.published_posts)
        .insert({
          ...postData,
          published_at: new Date().toISOString()
        })
        .select()
        .single();

      if (error) throw error;

      logger.debug(`Published post saved with ID: ${data.id}`);
      return data.id;
    } catch (error) {
      logger.error('Error saving published post:', error);
      throw error;
    }
  }

  async saveTrendHistory(trendData) {
    try {
      const { data, error } = await this.db
        .from(this.tables.trend_history)
        .insert({
          ...trendData,
          detected_at: new Date().toISOString()
        })
        .select()
        .single();

      if (error) throw error;

      return data.id;
    } catch (error) {
      logger.error('Error saving trend history:', error);
      throw error;
    }
  }

  async getRecentTrends(hours = 24) {
    try {
      const since = new Date();
      since.setHours(since.getHours() - hours);

      const { data, error } = await this.db
        .from(this.tables.trend_history)
        .select('*')
        .gt('detected_at', since.toISOString())
        .order('detected_at', { ascending: false });

      if (error) throw error;

      return data || [];
    } catch (error) {
      logger.error('Error fetching recent trends:', error);
      return [];
    }
  }

  async updatePostEngagement(postId, platform, metrics) {
    try {
      // First get current engagement data
      const { data: currentPost, error: fetchError } = await this.db
        .from(this.tables.published_posts)
        .select('engagement')
        .eq('id', postId)
        .single();

      if (fetchError && fetchError.code !== 'PGRST116') throw fetchError;

      // Merge with existing engagement data
      const currentEngagement = currentPost?.engagement || {};
      const updatedEngagement = {
        ...currentEngagement,
        [platform]: metrics,
        lastUpdated: new Date().toISOString()
      };

      const { error } = await this.db
        .from(this.tables.published_posts)
        .update({ engagement: updatedEngagement })
        .eq('id', postId);

      if (error) throw error;

      logger.debug(`Updated engagement for post ${postId} on ${platform}`);
      return true;
    } catch (error) {
      logger.error('Error updating post engagement:', error);
      return false;
    }
  }

  async getScheduledPosts(status = 'pending') {
    try {
      const { data, error } = await this.db
        .from(this.tables.scheduled_posts)
        .select('*')
        .eq('status', status)
        .order('created_at', { ascending: true });

      if (error) throw error;

      return data || [];
    } catch (error) {
      logger.error('Error fetching scheduled posts:', error);
      return [];
    }
  }

  async updateScheduledPostStatus(postId, status, errorMsg = null) {
    try {
      const updateData = {
        status,
        updated_at: new Date().toISOString()
      };

      if (errorMsg) {
        updateData.error = errorMsg;
      }

      const { error } = await this.db
        .from(this.tables.scheduled_posts)
        .update(updateData)
        .eq('id', postId);

      if (error) throw error;

      logger.debug(`Updated scheduled post ${postId} status to ${status}`);
      return true;
    } catch (error) {
      logger.error('Error updating scheduled post status:', error);
      return false;
    }
  }

  async getPublishedPostsSince(date) {
    try {
      const { data, error } = await this.db
        .from(this.tables.published_posts)
        .select('*')
        .gte('published_at', date instanceof Date ? date.toISOString() : date);

      if (error) throw error;

      return data || [];
    } catch (error) {
      logger.error('Error fetching published posts:', error);
      return [];
    }
  }

  async saveDailyReport(report) {
    try {
      const { error } = await this.db
        .from(this.tables.analytics_reports)
        .insert({
          ...report,
          created_at: new Date().toISOString()
        });

      if (error) throw error;

      logger.info('Daily report saved');
    } catch (error) {
      logger.error('Error saving daily report:', error);
    }
  }

  async cleanupOldPosts(beforeDate) {
    try {
      const dateStr = beforeDate instanceof Date ? beforeDate.toISOString() : beforeDate;

      const { data, error } = await this.db
        .from(this.tables.scheduled_posts)
        .delete()
        .lt('created_at', dateStr)
        .in('status', ['completed', 'failed'])
        .select();

      if (error) throw error;

      const count = data?.length || 0;
      logger.info(`Cleaned up ${count} old scheduled posts`);
    } catch (error) {
      logger.error('Error cleaning up old posts:', error);
    }
  }

  async cleanupOldTrends(beforeDate) {
    try {
      const dateStr = beforeDate instanceof Date ? beforeDate.toISOString() : beforeDate;

      const { data, error } = await this.db
        .from(this.tables.trend_history)
        .delete()
        .lt('detected_at', dateStr)
        .select();

      if (error) throw error;

      const count = data?.length || 0;
      logger.info(`Cleaned up ${count} old trend records`);
    } catch (error) {
      logger.error('Error cleaning up old trends:', error);
    }
  }

  // Get recently used topics for duplicate prevention
  async getRecentlyUsedTopics(hours = 24, platform = null) {
    try {
      const since = new Date();
      since.setHours(since.getHours() - hours);

      let query = this.db
        .from(this.tables.published_posts)
        .select('topic, trend_topic, platform, published_at')
        .gt('published_at', since.toISOString());

      if (platform) {
        query = query.eq('platform', platform);
      }

      const { data, error } = await query.order('published_at', { ascending: false });

      if (error) throw error;

      // Extract unique topics
      const topics = (data || []).map(post => post.topic || post.trend_topic).filter(Boolean);
      logger.debug(`Found ${topics.length} recently used topics`);
      return topics;
    } catch (error) {
      logger.error('Error fetching recently used topics:', error);
      return [];
    }
  }
}

export default DatabaseManager;