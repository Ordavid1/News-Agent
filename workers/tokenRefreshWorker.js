/**
 * Token Refresh Worker
 *
 * Background worker that processes token refresh queue.
 * Runs periodically to refresh OAuth tokens before they expire.
 */

import TokenManager from '../services/TokenManager.js';
import ConnectionManager from '../services/ConnectionManager.js';
import { supabaseAdmin } from '../services/supabase.js';
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
  pollInterval: 5 * 60 * 1000, // 5 minutes
  batchSize: 10,
  maxRetries: 3,
  retryDelay: 5 * 60 * 1000, // 5 minutes between retries
  refreshBuffer: 60 // Refresh tokens expiring within 60 minutes
};

let isRunning = false;
let intervalId = null;

/**
 * Process a single token refresh job
 * @param {Object} job - Token refresh queue job
 */
async function processRefreshJob(job) {
  const { id, connection_id, attempts } = job;

  try {
    // Mark job as processing
    await supabaseAdmin
      .from('token_refresh_queue')
      .update({ status: 'processing' })
      .eq('id', id);

    logger.info(`Processing token refresh job ${id} for connection ${connection_id}`);

    // Get connection details
    const connection = await TokenManager.getTokensByConnectionId(connection_id);
    if (!connection) {
      throw new Error('Connection not found');
    }

    if (!connection.refresh_token) {
      throw new Error('No refresh token available');
    }

    // Attempt to refresh the token
    await ConnectionManager.refreshTokens(connection_id);

    // Mark job as completed
    await supabaseAdmin
      .from('token_refresh_queue')
      .update({
        status: 'completed',
        processed_at: new Date().toISOString()
      })
      .eq('id', id);

    logger.info(`Successfully refreshed tokens for connection ${connection_id}`);
    return { success: true, connectionId: connection_id };

  } catch (error) {
    logger.error(`Token refresh failed for job ${id}:`, error.message);

    const newAttempts = attempts + 1;

    if (newAttempts >= WORKER_CONFIG.maxRetries) {
      // Mark as failed and update connection status
      await supabaseAdmin
        .from('token_refresh_queue')
        .update({
          status: 'failed',
          attempts: newAttempts,
          last_error: error.message,
          processed_at: new Date().toISOString()
        })
        .eq('id', id);

      // Mark connection as expired
      await TokenManager.markConnectionExpired(job.connection_id);

      logger.error(`Token refresh permanently failed for connection ${job.connection_id} after ${newAttempts} attempts`);
    } else {
      // Schedule retry
      const nextAttempt = new Date(Date.now() + WORKER_CONFIG.retryDelay).toISOString();
      await supabaseAdmin
        .from('token_refresh_queue')
        .update({
          status: 'pending',
          attempts: newAttempts,
          last_error: error.message,
          next_attempt_at: nextAttempt
        })
        .eq('id', id);

      logger.info(`Scheduled retry ${newAttempts + 1}/${WORKER_CONFIG.maxRetries} for job ${id} at ${nextAttempt}`);
    }

    return { success: false, connectionId: job.connection_id, error: error.message };
  }
}

/**
 * Queue connections that need token refresh
 */
async function queueExpiringConnections() {
  try {
    const connections = await TokenManager.getConnectionsNeedingRefresh(WORKER_CONFIG.refreshBuffer);

    if (connections.length === 0) {
      logger.debug('No connections need token refresh');
      return 0;
    }

    let queued = 0;

    for (const connection of connections) {
      // Check if already in queue
      const { data: existing } = await supabaseAdmin
        .from('token_refresh_queue')
        .select('id')
        .eq('connection_id', connection.id)
        .in('status', ['pending', 'processing'])
        .single();

      if (!existing) {
        await supabaseAdmin
          .from('token_refresh_queue')
          .insert({
            connection_id: connection.id,
            status: 'pending',
            next_attempt_at: new Date().toISOString()
          });
        queued++;
      }
    }

    if (queued > 0) {
      logger.info(`Queued ${queued} connections for token refresh`);
    }

    return queued;
  } catch (error) {
    logger.error('Error queueing expiring connections:', error);
    return 0;
  }
}

/**
 * Process pending jobs from the queue
 */
async function processQueue() {
  try {
    // Get pending jobs ready for processing
    const { data: jobs, error } = await supabaseAdmin
      .from('token_refresh_queue')
      .select('*')
      .eq('status', 'pending')
      .lte('next_attempt_at', new Date().toISOString())
      .order('created_at', { ascending: true })
      .limit(WORKER_CONFIG.batchSize);

    if (error) {
      logger.error('Error fetching refresh queue:', error);
      return;
    }

    if (!jobs || jobs.length === 0) {
      logger.debug('No pending token refresh jobs');
      return;
    }

    logger.info(`Processing ${jobs.length} token refresh jobs`);

    const results = await Promise.all(jobs.map(processRefreshJob));

    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    logger.info(`Token refresh batch complete: ${succeeded} succeeded, ${failed} failed`);

  } catch (error) {
    logger.error('Error processing refresh queue:', error);
  }
}

/**
 * Main worker tick - runs on interval
 */
async function workerTick() {
  if (!isRunning) return;

  try {
    // First, queue any connections that need refresh
    await queueExpiringConnections();

    // Then process the queue
    await processQueue();

  } catch (error) {
    logger.error('Token refresh worker error:', error);
  }
}

/**
 * Start the token refresh worker
 */
export function startWorker() {
  if (isRunning) {
    logger.warn('Token refresh worker already running');
    return;
  }

  isRunning = true;
  logger.info('Starting token refresh worker');

  // Run immediately on start
  workerTick();

  // Then run on interval
  intervalId = setInterval(workerTick, WORKER_CONFIG.pollInterval);

  logger.info(`Token refresh worker started with ${WORKER_CONFIG.pollInterval / 1000}s interval`);
}

/**
 * Stop the token refresh worker
 */
export function stopWorker() {
  if (!isRunning) {
    logger.warn('Token refresh worker not running');
    return;
  }

  isRunning = false;

  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }

  logger.info('Token refresh worker stopped');
}

/**
 * Check if worker is running
 */
export function isWorkerRunning() {
  return isRunning;
}

/**
 * Manually trigger a refresh for a specific connection
 * @param {string} connectionId - Connection ID to refresh
 */
export async function triggerRefresh(connectionId) {
  // Queue the refresh
  await supabaseAdmin
    .from('token_refresh_queue')
    .insert({
      connection_id: connectionId,
      status: 'pending',
      next_attempt_at: new Date().toISOString()
    });

  logger.info(`Manually queued token refresh for connection ${connectionId}`);

  // If worker is running, it will pick it up; otherwise process immediately
  if (!isRunning) {
    await processQueue();
  }
}

export default {
  startWorker,
  stopWorker,
  isWorkerRunning,
  triggerRefresh,
  processQueue,
  queueExpiringConnections
};
