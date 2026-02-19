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
 * Start all background workers
 */
export function startAllWorkers() {
  logger.info('Starting all background workers...');

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
