import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  Browsers
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import NodeCache from 'node-cache';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import CircuitBreaker from '../safety/CircuitBreaker.js';

// Suppress Baileys verbose logging - use our own logger
const baileysLogger = pino({ level: 'silent' });

class SessionManager {
  constructor(config) {
    this.config = config;
    this.sock = null;
    this.authStorePath = config.authStorePath;
    this.connectionState = 'disconnected';
    this.qrCodeBase64 = null;
    this.startedAt = Date.now();
    this.lastMessageSentAt = null;

    // Group metadata cache (5 min TTL)
    this.groupCache = new NodeCache({ stdTTL: 300, useClones: false });

    // Circuit breaker for reconnection management
    this.circuitBreaker = new CircuitBreaker({
      maxRetries: config.maxReconnectRetries,
      resetTimeoutMs: config.circuitResetTimeoutMs,
      onStateChange: (from, to) => {
        logger.warn(`Circuit breaker state change: ${from} → ${to}`);
      }
    });

    // Event listeners that external components can register
    this.messageListeners = [];
  }

  /**
   * Initialize the WhatsApp connection
   */
  async initialize() {
    // Ensure auth store directory exists
    const authDir = path.resolve(this.authStorePath);
    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true });
      logger.info(`Created auth store directory: ${authDir}`);
    }

    await this._connect();
  }

  /**
   * Register a listener for incoming messages
   * @param {Function} listener - Callback receiving (messages, type) from messages.upsert
   */
  onMessage(listener) {
    this.messageListeners.push(listener);
  }

  /**
   * Get the Baileys socket instance
   * @throws {Error} if not connected
   * @returns {Object} The Baileys socket
   */
  getSocket() {
    if (!this.sock || this.connectionState !== 'connected') {
      throw new Error('WhatsApp not connected');
    }
    return this.sock;
  }

  /**
   * Get the current connection state
   * @returns {string} connected | connecting | disconnected | circuit_open
   */
  getConnectionState() {
    if (this.circuitBreaker.getState() === 'open') {
      return 'circuit_open';
    }
    return this.connectionState;
  }

  /**
   * Get the current QR code as base64 PNG (for admin/setup endpoints)
   * @returns {string|null} Base64 data URI or null
   */
  getQRCode() {
    return this.qrCodeBase64;
  }

  /**
   * Get connected account info
   * @returns {{ phone: string, pushname: string, wid: string }|null}
   */
  getAccountInfo() {
    if (!this.sock?.user) return null;

    const jid = this.sock.user.id;
    // JID format: "number:device@s.whatsapp.net" - extract phone number
    const phone = jid.split(':')[0].split('@')[0];

    return {
      phone,
      pushname: this.sock.user.name || 'WhatsApp Bridge',
      wid: jid
    };
  }

  /**
   * Get diagnostic status
   */
  getStatus() {
    const accountInfo = this.getAccountInfo();
    return {
      status: this.getConnectionState(),
      uptime: Math.round((Date.now() - this.startedAt) / 1000),
      phone: accountInfo?.phone || null,
      pushname: accountInfo?.pushname || null,
      circuitBreaker: this.circuitBreaker.getStatus(),
      lastMessageSentAt: this.lastMessageSentAt
        ? new Date(this.lastMessageSentAt).toISOString()
        : null,
      hasQR: !!this.qrCodeBase64
    };
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    logger.info('Shutting down WhatsApp session...');
    this.circuitBreaker.destroy();

    if (this.sock) {
      try {
        await this.sock.logout();
      } catch {
        // Ignore logout errors during shutdown
      }
      this.sock.end();
      this.sock = null;
    }

    this.connectionState = 'disconnected';
    logger.info('WhatsApp session shut down');
  }

  /**
   * Record that a message was sent (for health monitoring)
   */
  recordMessageSent() {
    this.lastMessageSentAt = Date.now();
  }

  // --- Private methods ---

  async _connect() {
    this.connectionState = 'connecting';
    logger.info('Initializing WhatsApp connection...');

    const { version } = await fetchLatestBaileysVersion();
    logger.info(`Using WA version: ${version.join('.')}`);

    const { state, saveCreds } = await useMultiFileAuthState(
      path.resolve(this.authStorePath)
    );

    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger)
      },
      browser: Browsers.ubuntu('WhatsApp Bridge'),
      logger: baileysLogger,
      printQRInTerminal: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      // Reduce unnecessary data fetching
      shouldIgnoreJid: (jid) => {
        // Ignore status broadcasts and newsletter channels
        return jid === 'status@broadcast' || jid.endsWith('@newsletter');
      }
    });

    // --- Event handlers ---

    // Connection state changes
    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // QR code for pairing
      if (qr) {
        this.connectionState = 'pairing';
        logger.info('QR code generated - scan to pair');

        // Display in terminal logs (for Render log viewer)
        qrcodeTerminal.generate(qr, { small: true }, (qrAscii) => {
          console.log('\n' + qrAscii + '\n');
        });

        // Generate base64 PNG for health endpoint
        try {
          this.qrCodeBase64 = await QRCode.toDataURL(qr, {
            width: 300,
            margin: 2
          });
        } catch (err) {
          logger.error('Failed to generate QR base64:', err.message);
        }
      }

      if (connection === 'open') {
        this.connectionState = 'connected';
        this.qrCodeBase64 = null;
        this.circuitBreaker.onSuccess();

        const account = this.getAccountInfo();
        logger.info(`WhatsApp connected! Phone: ${account?.phone}, Name: ${account?.pushname}`);
      }

      if (connection === 'close') {
        this.connectionState = 'disconnected';
        this.qrCodeBase64 = null;

        const statusCode = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output.statusCode
          : lastDisconnect?.error?.output?.statusCode;

        const reason = DisconnectReason[statusCode] || `unknown (${statusCode})`;
        logger.warn(`WhatsApp disconnected. Reason: ${reason} (code: ${statusCode})`);

        // Handle logout (401) - terminal, no retry
        if (statusCode === DisconnectReason.loggedOut) {
          this.circuitBreaker.onLogout();
          logger.error('Session logged out. Clearing auth store. Manual QR re-scan required.');
          await this._clearAuthStore();
          return;
        }

        // Handle restart required (515) - always reconnect immediately
        if (statusCode === DisconnectReason.restartRequired) {
          logger.info('Restart required - reconnecting immediately');
          await this._connect();
          return;
        }

        // All other disconnects go through circuit breaker
        const { canRetry, delayMs } = this.circuitBreaker.onFailure();

        if (canRetry) {
          logger.info(`Reconnecting in ${delayMs}ms...`);
          setTimeout(() => this._connect(), delayMs);
        } else {
          logger.error('Circuit breaker OPEN - reconnection stopped. Manual intervention required.');
        }
      }
    });

    // Persist credentials on update
    this.sock.ev.on('creds.update', saveCreds);

    // Incoming messages - forward to registered listeners
    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      for (const listener of this.messageListeners) {
        try {
          await listener(messages, type);
        } catch (err) {
          logger.error('Error in message listener:', err.message);
        }
      }
    });

    // Group updates - invalidate cache
    this.sock.ev.on('groups.update', (updates) => {
      for (const update of updates) {
        if (update.id) {
          this.groupCache.del(update.id);
        }
      }
    });

    this.sock.ev.on('group-participants.update', ({ id }) => {
      if (id) {
        this.groupCache.del(id);
      }
    });
  }

  /**
   * Clear the auth store directory (after logout)
   */
  async _clearAuthStore() {
    const authDir = path.resolve(this.authStorePath);
    try {
      const files = fs.readdirSync(authDir);
      for (const file of files) {
        fs.unlinkSync(path.join(authDir, file));
      }
      logger.info('Auth store cleared');
    } catch (err) {
      logger.error('Failed to clear auth store:', err.message);
    }
  }
}

export default SessionManager;
