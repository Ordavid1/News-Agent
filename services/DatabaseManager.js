// services/DatabaseManager.js
import { FieldValue } from '@google-cloud/firestore';
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
    this.db = db;
    this.collections = {
      scheduled_posts: 'scheduled_posts',
      published_posts: 'published_posts',
      trend_history: 'trend_history',
      automation_logs: 'automation_logs'
    };
    
    this.initializeCollections();
  }

  async initializeCollections() {
    try {
      // Just log that we're ready - Firestore creates collections automatically
      logger.info('Database collections ready');
      return true;
    } catch (error) {
      logger.error('Database initialization error:', error);
      return false;
    }
  }

  async saveScheduledPost(postData) {
    try {
      const docRef = await this.db.collection(this.collections.scheduled_posts).add({
        ...postData,
        created_at: FieldValue.serverTimestamp(),
        status: 'pending'
      });
      
      logger.debug(`Scheduled post saved with ID: ${docRef.id}`);
      return docRef.id;
    } catch (error) {
      logger.error('Error saving scheduled post:', error);
      throw error;
    }
  }

  async savePublishedPost(postData) {
    try {
      const docRef = await this.db.collection(this.collections.published_posts).add({
        ...postData,
        published_at: FieldValue.serverTimestamp()
      });
      
      logger.debug(`Published post saved with ID: ${docRef.id}`);
      return docRef.id;
    } catch (error) {
      logger.error('Error saving published post:', error);
      throw error;
    }
  }

  async saveTrendHistory(trendData) {
    try {
      const docRef = await this.db.collection(this.collections.trend_history).add({
        ...trendData,
        detected_at: FieldValue.serverTimestamp()
      });
      
      return docRef.id;
    } catch (error) {
      logger.error('Error saving trend history:', error);
      throw error;
    }
  }

  async getRecentTrends(hours = 24) {
    try {
      const since = new Date();
      since.setHours(since.getHours() - hours);
      
      const snapshot = await this.db
        .collection(this.collections.trend_history)
        .where('detected_at', '>', since)
        .orderBy('detected_at', 'desc')
        .get();
      
      return snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
    } catch (error) {
      logger.error('Error fetching recent trends:', error);
      return [];
    }
  }

  async updatePostEngagement(postId, platform, metrics) {
    try {
      const postRef = this.db
        .collection(this.collections.published_posts)
        .doc(postId);
      
      await postRef.update({
        [`engagement.${platform}`]: metrics,
        [`engagement.lastUpdated`]: FieldValue.serverTimestamp()
      });
      
      logger.debug(`Updated engagement for post ${postId} on ${platform}`);
      return true;
    } catch (error) {
      logger.error('Error updating post engagement:', error);
      return false;
    }
  }

  async getScheduledPosts(status = 'pending') {
    try {
      const snapshot = await this.db
        .collection(this.collections.scheduled_posts)
        .where('status', '==', status)
        .orderBy('created_at', 'asc')
        .get();
      
      return snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
    } catch (error) {
      logger.error('Error fetching scheduled posts:', error);
      return [];
    }
  }

  async updateScheduledPostStatus(postId, status, error = null) {
    try {
      const updateData = {
        status,
        updated_at: FieldValue.serverTimestamp()
      };
      
      if (error) {
        updateData.error = error;
      }
      
      await this.db
        .collection(this.collections.scheduled_posts)
        .doc(postId)
        .update(updateData);
      
      logger.debug(`Updated scheduled post ${postId} status to ${status}`);
      return true;
    } catch (error) {
      logger.error('Error updating scheduled post status:', error);
      return false;
    }
  }
  // Add these methods to the DatabaseManager class

async getPublishedPostsSince(date) {
  try {
    const snapshot = await this.db
      .collection(this.collections.published_posts)
      .where('published_at', '>=', date)
      .get();
    
    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
  } catch (error) {
    logger.error('Error fetching published posts:', error);
    return [];
  }
}

async saveDailyReport(report) {
  try {
    await this.db.collection('analytics_reports').add({
      ...report,
      created_at: FieldValue.serverTimestamp()
    });
    logger.info('Daily report saved');
  } catch (error) {
    logger.error('Error saving daily report:', error);
  }
}

async cleanupOldPosts(beforeDate) {
  try {
    const snapshot = await this.db
      .collection(this.collections.scheduled_posts)
      .where('created_at', '<', beforeDate)
      .where('status', 'in', ['completed', 'failed'])
      .get();
    
    const batch = this.db.batch();
    snapshot.docs.forEach(doc => {
      batch.delete(doc.ref);
    });
    
    await batch.commit();
    logger.info(`Cleaned up ${snapshot.size} old scheduled posts`);
  } catch (error) {
    logger.error('Error cleaning up old posts:', error);
  }
}

async cleanupOldTrends(beforeDate) {
  try {
    const snapshot = await this.db
      .collection(this.collections.trend_history)
      .where('detected_at', '<', beforeDate)
      .get();
    
    const batch = this.db.batch();
    snapshot.docs.forEach(doc => {
      batch.delete(doc.ref);
    });
    
    await batch.commit();
    logger.info(`Cleaned up ${snapshot.size} old trend records`);
  } catch (error) {
    logger.error('Error cleaning up old trends:', error);
  }
}
}

export default DatabaseManager;