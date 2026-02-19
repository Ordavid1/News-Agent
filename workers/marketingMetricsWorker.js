/**
 * Marketing Metrics Worker
 *
 * Background worker that periodically syncs ad performance metrics
 * from Meta Marketing API and organic engagement from published posts.
 * Runs every 15 minutes for users with active marketing add-ons.
 */

import { supabaseAdmin } from '../services/supabase.js';
import marketingService from '../services/MarketingService.js';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()]
});

const WORKER_CONFIG = {
  pollInterval: 15 * 60 * 1000, // 15 minutes
  batchSize: 10 // Process up to 10 users per tick
};

let isRunning = false;
let intervalId = null;

/**
 * Get users with active marketing add-ons that have active campaigns
 */
async function getUsersNeedingMetricsSync() {
  try {
    const { data, error } = await supabaseAdmin
      .from('marketing_addons')
      .select('user_id')
      .eq('status', 'active')
      .limit(WORKER_CONFIG.batchSize);

    if (error) {
      logger.error('Error fetching marketing addon users:', error);
      return [];
    }

    return (data || []).map(row => row.user_id);
  } catch (error) {
    logger.error('Error getting users for metrics sync:', error);
    return [];
  }
}

/**
 * Main worker tick - runs on interval
 */
async function workerTick() {
  if (!isRunning) return;

  try {
    const userIds = await getUsersNeedingMetricsSync();

    if (userIds.length === 0) {
      logger.debug('[MarketingMetrics] No users need metrics sync');
      return;
    }

    logger.info(`[MarketingMetrics] Syncing metrics for ${userIds.length} users`);

    for (const userId of userIds) {
      try {
        // Sync ad performance metrics
        const adResult = await marketingService.syncMetricsForUser(userId);
        logger.info(`[MarketingMetrics] User ${userId}: synced ${adResult.syncedCampaigns} campaigns`);

        // Sync organic engagement metrics (for auto-boost rules)
        const organicResult = await marketingService.syncOrganicMetrics(userId);
        logger.info(`[MarketingMetrics] User ${userId}: synced ${organicResult.synced} organic posts`);
      } catch (error) {
        logger.error(`[MarketingMetrics] Error syncing user ${userId}:`, error.message);
      }
    }

    // Cleanup old metrics (keep 90 days)
    try {
      await supabaseAdmin.rpc('cleanup_old_marketing_metrics', { days_to_keep: 90 });
    } catch (cleanupError) {
      logger.debug('[MarketingMetrics] Metrics cleanup skipped (function may not exist yet)');
    }

    // Cleanup old rule triggers (keep 30 days)
    try {
      await supabaseAdmin.rpc('cleanup_old_rule_triggers', { days_to_keep: 30 });
    } catch (cleanupError) {
      logger.debug('[MarketingMetrics] Rule trigger cleanup skipped (function may not exist yet)');
    }

  } catch (error) {
    logger.error('[MarketingMetrics] Worker tick error:', error);
  }
}

/**
 * Start the marketing metrics worker
 */
export function startWorker() {
  if (isRunning) {
    logger.warn('[MarketingMetrics] Worker already running');
    return;
  }

  isRunning = true;
  logger.info('[MarketingMetrics] Starting marketing metrics worker');

  // Run first tick after a delay to allow app startup
  setTimeout(workerTick, 30 * 1000);

  intervalId = setInterval(workerTick, WORKER_CONFIG.pollInterval);

  logger.info(`[MarketingMetrics] Worker started with ${WORKER_CONFIG.pollInterval / 1000}s interval`);
}

/**
 * Stop the marketing metrics worker
 */
export function stopWorker() {
  if (!isRunning) {
    logger.warn('[MarketingMetrics] Worker not running');
    return;
  }

  isRunning = false;

  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }

  logger.info('[MarketingMetrics] Worker stopped');
}

/**
 * Check if worker is running
 */
export function isWorkerRunning() {
  return isRunning;
}

export default {
  startWorker,
  stopWorker,
  isWorkerRunning
};
