/**
 * Token Refresh Worker
 *
 * Background worker that processes token refresh queue.
 * Runs periodically to refresh OAuth tokens before they expire.
 */

import TokenManager, { TokenDecryptionError } from '../services/TokenManager.js';
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
  refreshBuffer: 15, // Refresh tokens expiring within 15 minutes (aligned with PublishingService.needsRefresh default)
  failedJobCooldown: 60 * 60 * 1000 // 1 hour cooldown after all retries exhausted before re-queueing same connection
  // NOTE: Google/YouTube tokens expire in 3599s (~1hr). A 60-min buffer caused the worker to
  // immediately pick up freshly-stored Google tokens and attempt a refresh while they were
  // still fully valid, sometimes racing with active publishing operations.
  // 15 minutes provides a 3-cycle safety window (worker polls every 5 min) without
  // triggering false-positive refreshes on short-lived tokens.
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

    // Facebook, Instagram, and AliExpress use long-lived tokens that cannot be reliably refreshed
    // via refresh_token. They must be renewed by re-authenticating.
    // Do NOT mark these as expired — the token is still valid until its natural expiry.
    const NON_REFRESHABLE_PLATFORMS = ['facebook', 'instagram', 'aliexpress'];
    if (NON_REFRESHABLE_PLATFORMS.includes(connection.platform) || !connection.refresh_token) {
      logger.info(`Skipping refresh for ${connection.platform} connection ${connection_id} — platform uses long-lived tokens without refresh`);
      // Mark job as completed (not failed) so it doesn't retry and expire the connection
      await supabaseAdmin
        .from('token_refresh_queue')
        .update({
          status: 'completed',
          processed_at: new Date().toISOString()
        })
        .eq('id', id);
      return { success: true, connectionId: connection_id, skipped: true };
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

    // Detect irrecoverable connections: NULL access_token means the row exists
    // but has no token at all — reconnection is genuinely required.
    //
    // TokenDecryptionError is NOT treated as irrecoverable here.  Decryption
    // failures typically indicate a TOKEN_ENCRYPTION_KEY mismatch between
    // environments (e.g., local dev vs production sharing the same database).
    // Marking the connection as 'error' would make the user see it as
    // "logged out" and trigger a reconnect cycle that never resolves.
    // Instead, we fail the job without touching the connection status.
    const isTokenDecryptionError = error instanceof TokenDecryptionError || error.name === 'TokenDecryptionError';

    if (isTokenDecryptionError) {
      logger.warn(
        `Connection ${connection_id}: token decryption failed — likely TOKEN_ENCRYPTION_KEY mismatch. ` +
        `Connection left active (not marked as error). Job marked as failed.`
      );
      await supabaseAdmin
        .from('token_refresh_queue')
        .update({
          status: 'failed',
          attempts: attempts + 1,
          last_error: `DECRYPTION_MISMATCH: ${error.message}`,
          processed_at: new Date().toISOString()
        })
        .eq('id', id);
      return { success: false, connectionId: connection_id, error: error.message };
    }

    // Check for NULL access_token — genuinely irrecoverable, requires reconnection
    let connectionIrrecoverable = false;
    try {
      const { data: connCheck } = await supabaseAdmin
        .from('social_connections')
        .select('access_token')
        .eq('id', connection_id)
        .single();
      if (connCheck && !connCheck.access_token) {
        connectionIrrecoverable = true;
      }
    } catch (checkErr) {
      // Non-fatal — proceed with normal retry logic
    }

    if (connectionIrrecoverable) {
      logger.warn(`Connection ${connection_id} is irrecoverable (NULL access_token) — marking as error`);

      try {
        await TokenManager.markConnectionError(
          connection_id,
          `Token refresh failed: ${error.message}. Connection has no valid access token — please reconnect your account.`
        );
      } catch (markErr) {
        logger.error(`Failed to mark connection ${connection_id} as error: ${markErr.message}`);
      }

      await supabaseAdmin
        .from('token_refresh_queue')
        .update({
          status: 'failed',
          attempts: attempts + 1,
          last_error: `IRRECOVERABLE: ${error.message}`,
          processed_at: new Date().toISOString()
        })
        .eq('id', id);

      return { success: false, connectionId: connection_id, error: error.message };
    }

    const newAttempts = attempts + 1;

    if (newAttempts >= WORKER_CONFIG.maxRetries) {
      // Mark job as permanently failed — do NOT mark the connection as error/expired here.
      // The background worker is a proactive refresher only; it must never be the authority
      // that kills a working connection. Definitive error marking is handled by the
      // on-demand paths (PublishingService, agents.js) which have full user context.
      // If the token genuinely can't be refreshed, those paths will detect it at publish time.
      await supabaseAdmin
        .from('token_refresh_queue')
        .update({
          status: 'failed',
          attempts: newAttempts,
          last_error: error.message,
          processed_at: new Date().toISOString()
        })
        .eq('id', id);

      logger.warn(`Token refresh permanently failed for job ${id} (connection ${job.connection_id}) after ${newAttempts} attempts — connection status NOT changed. On-demand paths will handle this if the token is truly broken.`);
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
      // Check if already in queue (pending/processing) or recently failed (cooldown)
      const { data: existing } = await supabaseAdmin
        .from('token_refresh_queue')
        .select('id, status, processed_at')
        .eq('connection_id', connection.id)
        .in('status', ['pending', 'processing', 'failed'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existing) {
        if (existing.status === 'pending' || existing.status === 'processing') {
          continue; // Already queued
        }
        // Failed job — apply cooldown before re-queueing
        if (existing.status === 'failed' && existing.processed_at) {
          const failedAt = new Date(existing.processed_at).getTime();
          if (Date.now() < failedAt + WORKER_CONFIG.failedJobCooldown) {
            continue; // Cooldown still active
          }
          logger.info(`Cooldown expired for connection ${connection.id} — re-queueing refresh`);
        }
      }

      await supabaseAdmin
        .from('token_refresh_queue')
        .insert({
          connection_id: connection.id,
          status: 'pending',
          next_attempt_at: new Date().toISOString()
        });
      queued++;
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
