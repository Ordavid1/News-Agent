/**
 * TestProgressEmitter
 *
 * In-memory pub/sub for real-time test publishing progress.
 * Each active test session is keyed by `${userId}:${agentId}` to ensure:
 *   - Multi-tenant isolation (user A cannot see user B's progress)
 *   - One active test per agent at a time
 *
 * Uses Node.js EventEmitter internally. SSE endpoints subscribe to events
 * and stream them to the browser.
 */

import { EventEmitter } from 'events';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()]
});

class TestProgressEmitter {
  constructor() {
    this.emitter = new EventEmitter();
    // Each active SSE connection is one listener per session key
    this.emitter.setMaxListeners(100);

    // Track active sessions: Map<sessionKey, { phase, message, startedAt, timeoutId }>
    this.activeSessions = new Map();

    // Safety timeout: auto-cleanup sessions after 5 minutes
    // (text-only platforms: 15-45s, TikTok with video generation: 2-3 min)
    this.SESSION_TIMEOUT_MS = 300000;

    logger.info('[TestProgressEmitter] Initialized');
  }

  /**
   * Generate a unique session key scoped to user + agent
   */
  _sessionKey(userId, agentId) {
    return `${userId}:${agentId}`;
  }

  /**
   * Start tracking a test session. Called at the beginning of the test endpoint.
   */
  startSession(userId, agentId) {
    const key = this._sessionKey(userId, agentId);

    // Clean up any stale session for this key
    this._cleanupSession(key);

    const timeoutId = setTimeout(() => {
      logger.warn(`[TestProgressEmitter] Session ${key} timed out after ${this.SESSION_TIMEOUT_MS}ms`);
      this.emitProgress(userId, agentId, 'error', 'Test timed out');
      this._cleanupSession(key);
    }, this.SESSION_TIMEOUT_MS);

    this.activeSessions.set(key, {
      phase: 'started',
      message: 'Starting test...',
      startedAt: Date.now(),
      timeoutId
    });

    logger.info(`[TestProgressEmitter] Session started: ${key}`);
  }

  /**
   * Emit a progress event for a test session.
   * @param {string} userId
   * @param {string} agentId
   * @param {string} phase - One of: validating, trends, generating, media, publishing, saving, complete, error
   * @param {string} message - Human-readable status text
   * @param {object} [data] - Optional additional data
   */
  emitProgress(userId, agentId, phase, message, data = {}) {
    const key = this._sessionKey(userId, agentId);
    const session = this.activeSessions.get(key);

    if (session) {
      session.phase = phase;
      session.message = message;
    }

    const event = {
      phase,
      message,
      timestamp: Date.now(),
      ...data
    };

    this.emitter.emit(key, event);

    // Auto-cleanup on terminal events (delay ensures SSE client receives the final event)
    if (phase === 'complete' || phase === 'error') {
      setTimeout(() => this._cleanupSession(key), 2000);
    }
  }

  /**
   * Subscribe to progress events for a specific user+agent.
   * Returns an unsubscribe function.
   * @param {string} userId
   * @param {string} agentId
   * @param {function} callback - Called with event object on each progress update
   * @returns {function} unsubscribe function
   */
  subscribe(userId, agentId, callback) {
    const key = this._sessionKey(userId, agentId);
    this.emitter.on(key, callback);

    // If a session is already active, immediately send the current phase
    const session = this.activeSessions.get(key);
    if (session && session.phase !== 'started') {
      callback({
        phase: session.phase,
        message: session.message,
        timestamp: Date.now()
      });
    }

    return () => {
      this.emitter.removeListener(key, callback);
    };
  }

  /**
   * Check if a session is currently active
   */
  isSessionActive(userId, agentId) {
    return this.activeSessions.has(this._sessionKey(userId, agentId));
  }

  /**
   * Check if any test session is active for a given agent ID.
   * Used by AutomationManager to skip agents that are currently being tested.
   */
  isAgentBeingTested(agentId) {
    for (const key of this.activeSessions.keys()) {
      if (key.endsWith(`:${agentId}`)) return true;
    }
    return false;
  }

  /**
   * Internal cleanup
   */
  _cleanupSession(key) {
    const session = this.activeSessions.get(key);
    if (session) {
      clearTimeout(session.timeoutId);
      this.activeSessions.delete(key);
      this.emitter.removeAllListeners(key);
    }
  }
}

// Singleton export (matches pattern of trendAnalyzer)
const testProgressEmitter = new TestProgressEmitter();
export default testProgressEmitter;
