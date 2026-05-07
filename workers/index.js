/**
 * Background Workers Entry Point
 *
 * Exports all background workers and provides unified start/stop functions.
 */

import tokenRefreshWorker from './tokenRefreshWorker.js';
import postingWorker from './postingWorker.js';
import marketingMetricsWorker from './marketingMetricsWorker.js';
import marketingRulesWorker from './marketingRulesWorker.js';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()]
});

/**
 * Start all background workers — gated by RUN_INLINE_WORKERS.
 *
 * On Render and any single-instance deployment, in-process workers with
 * setInterval timers work fine. On Cloud Run with autoscaling, we want
 * Cloud Scheduler to drive ticks via /internal/cron/*-tick endpoints
 * instead, so each tick fires exactly once across the whole deployment.
 *
 * Setting RUN_INLINE_WORKERS=false (default for Cloud Run when Cloud
 * Scheduler is configured) makes this a no-op. The Cloud Run service
 * still boots cleanly; cron is driven externally.
 */
export function startAllWorkers() {
  const inline = process.env.RUN_INLINE_WORKERS !== 'false';
  if (!inline) {
    logger.info('Inline workers DISABLED (RUN_INLINE_WORKERS=false). Cloud Scheduler should drive /internal/cron/*-tick endpoints.');
    return;
  }
  logger.info('Starting all background workers (inline mode)...');

  tokenRefreshWorker.startWorker();
  postingWorker.startWorker();
  marketingMetricsWorker.startWorker();
  marketingRulesWorker.startWorker();

  logger.info('All background workers started');
}

/**
 * Stop all background workers
 */
export function stopAllWorkers() {
  logger.info('Stopping all background workers...');

  tokenRefreshWorker.stopWorker();
  postingWorker.stopWorker();
  marketingMetricsWorker.stopWorker();
  marketingRulesWorker.stopWorker();

  logger.info('All background workers stopped');
}

/**
 * Get status of all workers
 */
export function getWorkersStatus() {
  return {
    tokenRefreshWorker: tokenRefreshWorker.isWorkerRunning(),
    postingWorker: postingWorker.isWorkerRunning(),
    marketingMetricsWorker: marketingMetricsWorker.isWorkerRunning(),
    marketingRulesWorker: marketingRulesWorker.isWorkerRunning()
  };
}

// Re-export individual workers
export { tokenRefreshWorker, postingWorker, marketingMetricsWorker, marketingRulesWorker };

export default {
  startAllWorkers,
  stopAllWorkers,
  getWorkersStatus,
  tokenRefreshWorker,
  postingWorker,
  marketingMetricsWorker,
  marketingRulesWorker
};
