/**
 * Background Workers Entry Point
 *
 * Exports all background workers and provides unified start/stop functions.
 */

import tokenRefreshWorker from './tokenRefreshWorker.js';
import postingWorker from './postingWorker.js';
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

  logger.info('All background workers started');
}

/**
 * Stop all background workers
 */
export function stopAllWorkers() {
  logger.info('Stopping all background workers...');

  tokenRefreshWorker.stopWorker();
  postingWorker.stopWorker();

  logger.info('All background workers stopped');
}

/**
 * Get status of all workers
 */
export function getWorkersStatus() {
  return {
    tokenRefreshWorker: tokenRefreshWorker.isWorkerRunning(),
    postingWorker: postingWorker.isWorkerRunning()
  };
}

// Re-export individual workers
export { tokenRefreshWorker, postingWorker };

export default {
  startAllWorkers,
  stopAllWorkers,
  getWorkersStatus,
  tokenRefreshWorker,
  postingWorker
};
