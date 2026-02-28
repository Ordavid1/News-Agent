import logger from '../utils/logger.js';

/**
 * Token bucket rate limiter for outbound WhatsApp messages.
 * Enforces per-minute and per-hour limits with randomized delays
 * between messages to mimic natural sending patterns.
 */
class RateLimiter {
  constructor(options = {}) {
    this.maxPerMinute = options.maxPerMinute || 15;
    this.maxPerHour = options.maxPerHour || 100;
    this.minDelayMs = options.minDelayMs || 1000;
    this.maxDelayMs = options.maxDelayMs || 3000;

    // Sliding window trackers
    this.minuteWindow = []; // timestamps of messages sent in last 60s
    this.hourWindow = [];   // timestamps of messages sent in last 3600s
    this.lastSentAt = 0;

    // Queue for serializing sends
    this.queue = [];
    this.processing = false;
  }

  /**
   * Wait until sending is allowed, then execute the send function.
   * Messages are queued and processed one at a time with natural delays.
   * @param {Function} sendFn - Async function that performs the actual send
   * @returns {Promise<*>} Result of sendFn
   */
  async throttle(sendFn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ sendFn, resolve, reject });
      this._processQueue();
    });
  }

  /**
   * Check current rate limit status without consuming a token
   * @returns {{ allowed: boolean, minuteRemaining: number, hourRemaining: number, waitMs: number }}
   */
  getStatus() {
    this._pruneWindows();
    const minuteRemaining = Math.max(0, this.maxPerMinute - this.minuteWindow.length);
    const hourRemaining = Math.max(0, this.maxPerHour - this.hourWindow.length);
    const allowed = minuteRemaining > 0 && hourRemaining > 0;

    let waitMs = 0;
    if (!allowed) {
      if (minuteRemaining === 0 && this.minuteWindow.length > 0) {
        // Wait until oldest minute-window entry expires
        waitMs = Math.max(waitMs, this.minuteWindow[0] + 60000 - Date.now());
      }
      if (hourRemaining === 0 && this.hourWindow.length > 0) {
        waitMs = Math.max(waitMs, this.hourWindow[0] + 3600000 - Date.now());
      }
    }

    return { allowed, minuteRemaining, hourRemaining, waitMs };
  }

  /**
   * Get a randomized delay between min and max to mimic natural behavior
   * @returns {number} Delay in milliseconds
   */
  _getRandomDelay() {
    return this.minDelayMs + Math.random() * (this.maxDelayMs - this.minDelayMs);
  }

  /**
   * Remove expired entries from sliding windows
   */
  _pruneWindows() {
    const now = Date.now();
    while (this.minuteWindow.length > 0 && this.minuteWindow[0] < now - 60000) {
      this.minuteWindow.shift();
    }
    while (this.hourWindow.length > 0 && this.hourWindow[0] < now - 3600000) {
      this.hourWindow.shift();
    }
  }

  /**
   * Process queued sends one at a time
   */
  async _processQueue() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const { sendFn, resolve, reject } = this.queue[0];

      try {
        // Wait for rate limit window
        await this._waitForCapacity();

        // Add natural delay since last message
        const timeSinceLast = Date.now() - this.lastSentAt;
        const requiredDelay = this._getRandomDelay();
        if (timeSinceLast < requiredDelay && this.lastSentAt > 0) {
          const waitTime = requiredDelay - timeSinceLast;
          logger.debug(`Rate limiter: waiting ${Math.round(waitTime)}ms before next send`);
          await this._sleep(waitTime);
        }

        // Execute the send
        const now = Date.now();
        this.minuteWindow.push(now);
        this.hourWindow.push(now);
        this.lastSentAt = now;

        const result = await sendFn();
        resolve(result);
      } catch (err) {
        reject(err);
      }

      this.queue.shift();
    }

    this.processing = false;
  }

  /**
   * Wait until rate limit windows have capacity
   */
  async _waitForCapacity() {
    while (true) {
      this._pruneWindows();

      if (this.minuteWindow.length < this.maxPerMinute && this.hourWindow.length < this.maxPerHour) {
        return;
      }

      // Calculate wait time
      let waitMs = 1000; // Default poll interval
      if (this.minuteWindow.length >= this.maxPerMinute && this.minuteWindow.length > 0) {
        waitMs = Math.max(waitMs, this.minuteWindow[0] + 60000 - Date.now() + 100);
      }
      if (this.hourWindow.length >= this.maxPerHour && this.hourWindow.length > 0) {
        waitMs = Math.max(waitMs, this.hourWindow[0] + 3600000 - Date.now() + 100);
      }

      logger.warn(`Rate limit reached. Waiting ${Math.round(waitMs / 1000)}s for capacity`);
      await this._sleep(waitMs);
    }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default RateLimiter;
