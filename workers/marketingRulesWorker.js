/**
 * Marketing Rules Worker
 *
 * Background worker that evaluates auto-boost rules every 5 minutes.
 * Checks if any published posts meet the conditions defined in
 * marketing_rules (e.g., "boost if organic reach > 500 within 2 hours")
 * and triggers automatic boosts via MarketingService.
 */

import marketingRulesEngine from '../services/MarketingRulesEngine.js';
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
  pollInterval: 5 * 60 * 1000 // 5 minutes
};

let isRunning = false;
let intervalId = null;

/**
 * Main worker tick
 */
async function workerTick() {
  if (!isRunning) return;

  try {
    const result = await marketingRulesEngine.evaluateAllRules();

    if (result.triggered > 0) {
      logger.info(`[MarketingRules] ${result.triggered} rules triggered out of ${result.evaluated} evaluated`);
    } else {
      logger.debug(`[MarketingRules] ${result.evaluated} rules evaluated, none triggered`);
    }
  } catch (error) {
    logger.error('[MarketingRules] Worker tick error:', error.message);
  }
}

/**
 * Start the marketing rules worker
 */
export function startWorker() {
  if (isRunning) {
    logger.warn('[MarketingRules] Worker already running');
    return;
  }

  isRunning = true;
  logger.info('[MarketingRules] Starting marketing rules worker');

  // Delay first tick to allow startup
  setTimeout(workerTick, 60 * 1000);

  intervalId = setInterval(workerTick, WORKER_CONFIG.pollInterval);

  logger.info(`[MarketingRules] Worker started with ${WORKER_CONFIG.pollInterval / 1000}s interval`);
}

/**
 * Stop the marketing rules worker
 */
export function stopWorker() {
  if (!isRunning) {
    logger.warn('[MarketingRules] Worker not running');
    return;
  }

  isRunning = false;

  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }

  logger.info('[MarketingRules] Worker stopped');
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
