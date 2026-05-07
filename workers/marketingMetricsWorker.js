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
    // Get users with active marketing add-ons
    const { data: addonUsers, error: addonError } = await supabaseAdmin
      .from('marketing_addons')
      .select('user_id')
      .eq('status', 'active')
      .limit(WORKER_CONFIG.batchSize);

    if (addonError) {
      logger.error('Error fetching marketing addon users:', addonError);
      return [];
    }

    const userIds = (addonUsers || []).map(row => row.user_id);
    if (userIds.length === 0) return [];

    // Filter to only users whose Facebook connection is active.
    // Attempting metrics sync on errored/disconnected connections just
    // produces repeated decryption failures in the logs.
    const { data: activeConns, error: connError } = await supabaseAdmin
      .from('social_connections')
      .select('user_id')
      .in('user_id', userIds)
      .eq('platform', 'facebook')
      .eq('status', 'active');

    if (connError) {
      logger.error('Error checking Facebook connection status:', connError);
      // Fall through — getMarketingCredentials() will catch non-active connections
      return userIds;
    }

    const activeUserIds = new Set((activeConns || []).map(c => c.user_id));
    const filtered = userIds.filter(id => activeUserIds.has(id));

    if (filtered.length < userIds.length) {
      logger.info(`[MarketingMetrics] Skipping ${userIds.length - filtered.length} user(s) with non-active Facebook connections`);
    }

    return filtered;
  } catch (error) {
    logger.error('Error getting users for metrics sync:', error);
    return [];
  }
}

/**
 * The actual per-tick work — separated from workerTick so that Cloud
 * Scheduler (via runOnce) can drive it without the inline-worker isRunning
 * guard tripping when in-process workers are disabled.
 */
async function _doTickWork() {
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
        logger.error(`[MarketingMetrics] Error syncing user ${userId}: ${error.message}`);
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
 * Main worker tick — gated on isRunning so a leftover setInterval doesn't
 * fire after stopWorker. Inline-worker mode (RUN_INLINE_WORKERS=true) uses
 * this; Cloud Scheduler mode calls _doTickWork directly via runOnce().
 */
async function workerTick() {
  if (!isRunning) return;
  await _doTickWork();
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

/**
 * Run one tick worth of work — invoked by Cloud Scheduler hitting
 * /internal/cron/marketing-metrics-tick when in-process workers are disabled.
 */
export async function runOnce() {
  await _doTickWork();
}

export default {
  startWorker,
  stopWorker,
  isWorkerRunning,
  runOnce
};
