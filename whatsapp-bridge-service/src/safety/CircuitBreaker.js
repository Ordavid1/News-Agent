import logger from '../utils/logger.js';

/**
 * Circuit Breaker for WhatsApp reconnection management.
 * Prevents ban-triggering reconnection storms by limiting retry attempts
 * with exponential backoff and jitter.
 *
 * States:
 * - CLOSED: Normal operation, reconnection attempts allowed
 * - OPEN: Tripped after max failures, no reconnection attempts
 * - HALF_OPEN: Recovery probe - single attempt allowed after cooldown
 */
const STATE = {
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half_open'
};

class CircuitBreaker {
  constructor(options = {}) {
    this.maxRetries = options.maxRetries || 5;
    this.resetTimeoutMs = options.resetTimeoutMs || 300000; // 5 minutes
    this.backoffBaseMs = options.backoffBaseMs || 2000;
    this.backoffMaxMs = options.backoffMaxMs || 60000;
    this.backoffMultiplier = options.backoffMultiplier || 2;
    this.jitterFactor = options.jitterFactor || 0.3; // ±30%

    this.state = STATE.CLOSED;
    this.consecutiveFailures = 0;
    this.lastFailureAt = null;
    this.resetTimer = null;
    this.onStateChange = options.onStateChange || null;
  }

  /**
   * Get current circuit breaker state
   */
  getState() {
    return this.state;
  }

  /**
   * Check if reconnection is allowed
   * @returns {boolean}
   */
  canAttempt() {
    if (this.state === STATE.CLOSED) return true;
    if (this.state === STATE.HALF_OPEN) return true;
    return false;
  }

  /**
   * Calculate backoff delay with jitter for the current retry attempt
   * @returns {number} Delay in milliseconds
   */
  getBackoffDelay() {
    const baseDelay = Math.min(
      this.backoffBaseMs * Math.pow(this.backoffMultiplier, this.consecutiveFailures),
      this.backoffMaxMs
    );

    // Add ±jitterFactor random jitter
    const jitter = baseDelay * this.jitterFactor * (2 * Math.random() - 1);
    return Math.max(0, Math.round(baseDelay + jitter));
  }

  /**
   * Record a successful connection - resets the circuit
   */
  onSuccess() {
    const previousState = this.state;
    this.consecutiveFailures = 0;
    this.lastFailureAt = null;
    this.state = STATE.CLOSED;

    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }

    if (previousState !== STATE.CLOSED) {
      logger.info(`Circuit breaker reset to CLOSED (was ${previousState})`);
      this._emitStateChange(previousState, STATE.CLOSED);
    }
  }

  /**
   * Record a connection failure
   * @returns {{ canRetry: boolean, delayMs: number }} Whether retry is allowed and delay before next attempt
   */
  onFailure() {
    this.consecutiveFailures++;
    this.lastFailureAt = Date.now();

    logger.warn(`Connection failure #${this.consecutiveFailures}/${this.maxRetries}`);

    // If in half-open state and the probe failed, go back to open
    if (this.state === STATE.HALF_OPEN) {
      this._transitionTo(STATE.OPEN);
      this._scheduleReset();
      return { canRetry: false, delayMs: 0 };
    }

    // Check if we've exceeded max retries
    if (this.consecutiveFailures >= this.maxRetries) {
      this._transitionTo(STATE.OPEN);
      this._scheduleReset();
      return { canRetry: false, delayMs: 0 };
    }

    const delayMs = this.getBackoffDelay();
    logger.info(`Retry allowed in ${delayMs}ms (attempt ${this.consecutiveFailures}/${this.maxRetries})`);
    return { canRetry: true, delayMs };
  }

  /**
   * Record a logout event - this is terminal, no retries
   */
  onLogout() {
    logger.error('WhatsApp session logged out (401). Circuit permanently open until manual re-pair.');
    this.consecutiveFailures = this.maxRetries;
    this._transitionTo(STATE.OPEN);

    // Do NOT schedule reset - logout requires manual intervention
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
  }

  /**
   * Manually reset the circuit breaker (e.g., after manual re-pair)
   */
  reset() {
    this.onSuccess();
    logger.info('Circuit breaker manually reset');
  }

  /**
   * Get diagnostic info
   */
  getStatus() {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      maxRetries: this.maxRetries,
      lastFailureAt: this.lastFailureAt ? new Date(this.lastFailureAt).toISOString() : null,
      nextResetAt: this.resetTimer ? new Date(Date.now() + this.resetTimeoutMs).toISOString() : null
    };
  }

  /**
   * Clean up timers
   */
  destroy() {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
  }

  // --- Private methods ---

  _transitionTo(newState) {
    const previousState = this.state;
    this.state = newState;
    logger.warn(`Circuit breaker: ${previousState} → ${newState}`);
    this._emitStateChange(previousState, newState);
  }

  _scheduleReset() {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
    }

    logger.info(`Circuit breaker will attempt half-open in ${this.resetTimeoutMs / 1000}s`);

    this.resetTimer = setTimeout(() => {
      this.resetTimer = null;
      if (this.state === STATE.OPEN) {
        this._transitionTo(STATE.HALF_OPEN);
        logger.info('Circuit breaker now HALF_OPEN - one reconnection probe allowed');
      }
    }, this.resetTimeoutMs);
  }

  _emitStateChange(from, to) {
    if (this.onStateChange) {
      try {
        this.onStateChange(from, to);
      } catch (err) {
        logger.error('Error in circuit breaker state change callback:', err.message);
      }
    }
  }
}

export { STATE };
export default CircuitBreaker;
