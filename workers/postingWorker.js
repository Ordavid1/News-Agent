/**
 * Posting Worker
 *
 * Background worker that processes the posting queue.
 * Handles scheduled posts and retry logic for failed posts.
 */

import { supabaseAdmin } from '../services/supabase.js';
import publishingService from '../services/PublishingService.js';
import TokenManager from '../services/TokenManager.js';
import ConnectionManager from '../services/ConnectionManager.js';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()]
});

// Worker configuration
const WORKER_CONFIG = {
  pollInterval: 30 * 1000, // 30 seconds
  batchSize: 5,
  maxRetries: 3,
  retryDelays: [1, 5, 15], // Minutes between retries
};

let isRunning = false;
let intervalId = null;

/**
 * Process a single posting job
 * @param {Object} job - Posting queue job
 */
async function processPostingJob(job) {
  const { id, post_id, platform, connection_id, attempts } = job;

  try {
    // Mark job as processing
    await supabaseAdmin
      .from('posting_queue')
      .update({ status: 'processing' })
      .eq('id', id);

    logger.info(`Processing posting job ${id} for post ${post_id} on ${platform}`);

    // Get post content
    const { data: post, error: postError } = await supabaseAdmin
      .from('posts')
      .select('*')
      .eq('id', post_id)
      .single();

    if (postError || !post) {
      throw new Error(`Post not found: ${post_id}`);
    }

    // Get connection with decrypted tokens
    const connection = await TokenManager.getTokensByConnectionId(connection_id);
    if (!connection) {
      throw new Error('Connection not found');
    }

    if (connection.status !== 'active') {
      throw new Error(`Connection is ${connection.status}, not active`);
    }

    // Check if token needs refresh
    if (TokenManager.needsRefresh(connection)) {
      logger.info(`Token for ${platform} needs refresh before posting`);
      await ConnectionManager.refreshTokens(connection_id);
    }

    // Create publisher with user credentials
    const publisher = publishingService.createPublisherWithCredentials(platform, connection);

    // Publish the content
    const content = {
      text: post.content,
      topic: post.topic,
      source: post.source_article_url
    };

    const result = await publisher.publishPost(content.text);

    if (result.success) {
      // Update posting queue job
      await supabaseAdmin
        .from('posting_queue')
        .update({
          status: 'completed',
          result: result,
          processed_at: new Date().toISOString()
        })
        .eq('id', id);

      // Update post with platform result
      const platformResults = post.platform_results || {};
      platformResults[platform] = {
        success: true,
        postId: result.postId,
        url: result.url,
        publishedAt: new Date().toISOString()
      };

      const publishedPlatforms = [...(post.published_platforms || [])];
      if (!publishedPlatforms.includes(platform)) {
        publishedPlatforms.push(platform);
      }

      // Determine post status
      let postStatus = 'published';
      if (publishedPlatforms.length < post.target_platforms.length) {
        postStatus = 'partial';
      }

      await supabaseAdmin
        .from('posts')
        .update({
          platform_results: platformResults,
          published_platforms: publishedPlatforms,
          status: postStatus,
          published_at: post.published_at || new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', post_id);

      // Update connection last_used_at
      await supabaseAdmin
        .from('social_connections')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', connection_id);

      logger.info(`Successfully posted to ${platform} for post ${post_id}`);
      return { success: true, postId: post_id, platform, result };
    }

    throw new Error('Publishing returned unsuccessful result');

  } catch (error) {
    logger.error(`Posting job ${id} failed:`, error.message);

    const newAttempts = attempts + 1;

    if (newAttempts >= WORKER_CONFIG.maxRetries) {
      // Mark as permanently failed
      await supabaseAdmin
        .from('posting_queue')
        .update({
          status: 'failed',
          attempts: newAttempts,
          last_error: error.message,
          processed_at: new Date().toISOString()
        })
        .eq('id', id);

      // Update post platform_results with error
      const { data: post } = await supabaseAdmin
        .from('posts')
        .select('platform_results, target_platforms, published_platforms')
        .eq('id', post_id)
        .single();

      if (post) {
        const platformResults = post.platform_results || {};
        platformResults[platform] = {
          success: false,
          error: error.message,
          failedAt: new Date().toISOString()
        };

        // Determine if all platforms have been attempted
        const allAttempted = post.target_platforms.every(
          p => platformResults[p] !== undefined
        );

        let postStatus = post.published_platforms?.length > 0 ? 'partial' : 'failed';
        if (allAttempted && post.published_platforms?.length === post.target_platforms.length) {
          postStatus = 'published';
        }

        await supabaseAdmin
          .from('posts')
          .update({
            platform_results: platformResults,
            status: postStatus,
            updated_at: new Date().toISOString()
          })
          .eq('id', post_id);
      }

      logger.error(`Posting permanently failed for ${platform} on post ${post_id}`);
    } else {
      // Schedule retry with exponential backoff
      const retryDelayMinutes = WORKER_CONFIG.retryDelays[newAttempts - 1] || 15;
      const nextAttempt = new Date(Date.now() + retryDelayMinutes * 60 * 1000).toISOString();

      await supabaseAdmin
        .from('posting_queue')
        .update({
          status: 'pending',
          attempts: newAttempts,
          last_error: error.message
        })
        .eq('id', id);

      logger.info(`Scheduled retry ${newAttempts}/${WORKER_CONFIG.maxRetries} for job ${id} in ${retryDelayMinutes} minutes`);
    }

    return { success: false, postId: post_id, platform, error: error.message };
  }
}

/**
 * Queue scheduled posts that are ready to publish
 */
async function queueScheduledPosts() {
  try {
    // Find posts scheduled for now or earlier that haven't been queued
    const { data: posts, error } = await supabaseAdmin
      .from('posts')
      .select('id, user_id, target_platforms')
      .eq('status', 'scheduled')
      .lte('schedule_time', new Date().toISOString());

    if (error) {
      logger.error('Error fetching scheduled posts:', error);
      return 0;
    }

    if (!posts || posts.length === 0) {
      return 0;
    }

    let queued = 0;

    for (const post of posts) {
      // Update post status to publishing
      await supabaseAdmin
        .from('posts')
        .update({ status: 'publishing' })
        .eq('id', post.id);

      // Queue each platform
      for (const platform of post.target_platforms) {
        // Get user's connection for this platform
        const connection = await TokenManager.getTokens(post.user_id, platform);

        if (!connection || connection.status !== 'active') {
          logger.warn(`No active ${platform} connection for user ${post.user_id}, skipping`);
          continue;
        }

        // Check if already queued
        const { data: existing } = await supabaseAdmin
          .from('posting_queue')
          .select('id')
          .eq('post_id', post.id)
          .eq('platform', platform)
          .single();

        if (!existing) {
          await supabaseAdmin
            .from('posting_queue')
            .insert({
              post_id: post.id,
              platform,
              connection_id: connection.id,
              status: 'pending'
            });
          queued++;
        }
      }
    }

    if (queued > 0) {
      logger.info(`Queued ${queued} platform posts for ${posts.length} scheduled posts`);
    }

    return queued;
  } catch (error) {
    logger.error('Error queueing scheduled posts:', error);
    return 0;
  }
}

/**
 * Process pending jobs from the queue
 */
async function processQueue() {
  try {
    // Get pending jobs
    const { data: jobs, error } = await supabaseAdmin
      .from('posting_queue')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(WORKER_CONFIG.batchSize);

    if (error) {
      logger.error('Error fetching posting queue:', error);
      return;
    }

    if (!jobs || jobs.length === 0) {
      logger.debug('No pending posting jobs');
      return;
    }

    logger.info(`Processing ${jobs.length} posting jobs`);

    // Process jobs sequentially to avoid rate limits
    const results = [];
    for (const job of jobs) {
      const result = await processPostingJob(job);
      results.push(result);

      // Small delay between posts to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    logger.info(`Posting batch complete: ${succeeded} succeeded, ${failed} failed`);

  } catch (error) {
    logger.error('Error processing posting queue:', error);
  }
}

/**
 * Main worker tick - runs on interval
 */
async function workerTick() {
  if (!isRunning) return;

  try {
    // First, queue scheduled posts that are ready
    await queueScheduledPosts();

    // Then process the queue
    await processQueue();

  } catch (error) {
    logger.error('Posting worker error:', error);
  }
}

/**
 * Start the posting worker
 */
export function startWorker() {
  if (isRunning) {
    logger.warn('Posting worker already running');
    return;
  }

  isRunning = true;
  logger.info('Starting posting worker');

  // Run immediately on start
  workerTick();

  // Then run on interval
  intervalId = setInterval(workerTick, WORKER_CONFIG.pollInterval);

  logger.info(`Posting worker started with ${WORKER_CONFIG.pollInterval / 1000}s interval`);
}

/**
 * Stop the posting worker
 */
export function stopWorker() {
  if (!isRunning) {
    logger.warn('Posting worker not running');
    return;
  }

  isRunning = false;

  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }

  logger.info('Posting worker stopped');
}

/**
 * Check if worker is running
 */
export function isWorkerRunning() {
  return isRunning;
}

/**
 * Queue a post for immediate publishing
 * @param {string} postId - Post ID to publish
 * @param {string[]} platforms - Platforms to publish to
 * @param {string} userId - User ID
 */
export async function queuePost(postId, platforms, userId) {
  let queued = 0;

  for (const platform of platforms) {
    const connection = await TokenManager.getTokens(userId, platform);

    if (!connection || connection.status !== 'active') {
      logger.warn(`No active ${platform} connection for user ${userId}`);
      continue;
    }

    await supabaseAdmin
      .from('posting_queue')
      .insert({
        post_id: postId,
        platform,
        connection_id: connection.id,
        status: 'pending'
      });
    queued++;
  }

  logger.info(`Queued post ${postId} for ${queued} platforms`);

  // Process immediately if worker is running
  if (isRunning) {
    // Worker will pick it up on next tick
  } else {
    // Process immediately
    await processQueue();
  }

  return queued;
}

export default {
  startWorker,
  stopWorker,
  isWorkerRunning,
  queuePost,
  processQueue,
  queueScheduledPosts
};
