import axios from 'axios';
import logger from '../utils/logger.js';

/**
 * Monitors incoming WhatsApp group messages for verification codes
 * and forwards them to the SaaS app's webhook endpoint.
 *
 * This replaces the Whapi.cloud push webhook model — instead of Whapi
 * calling the SaaS app, this service actively listens and pushes matches.
 *
 * Verification code pattern: NA-XXXXXXXX (8 hex chars)
 */
const VERIFICATION_CODE_REGEX = /NA-[A-F0-9]{8}/i;

class WebhookForwarder {
  constructor(config, sessionManager) {
    this.webhookUrl = config.saasWebhookUrl;
    this.webhookSecret = config.saasWebhookSecret;
    this.sessionManager = sessionManager;

    if (!this.webhookUrl) {
      logger.warn('SAAS_WEBHOOK_URL not configured - verification code forwarding disabled');
      return;
    }

    // Register as a message listener on the session manager
    this.sessionManager.onMessage(this._handleMessages.bind(this));
    logger.info(`Webhook forwarder initialized → ${this.webhookUrl}`);
  }

  /**
   * Handle incoming messages from Baileys
   * @param {Array} messages - Array of Baileys message objects
   * @param {string} type - Message type ('notify' for new messages)
   */
  async _handleMessages(messages, type) {
    // Only process new incoming messages
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        await this._processMessage(msg);
      } catch (err) {
        logger.error(`Error processing message for webhook: ${err.message}`);
      }
    }
  }

  /**
   * Process a single message — check for verification codes in group messages
   * @param {Object} msg - Baileys message object
   */
  async _processMessage(msg) {
    // Skip own messages
    if (msg.key.fromMe) return;

    // Only process group messages
    const jid = msg.key.remoteJid;
    if (!jid || !jid.endsWith('@g.us')) return;

    // Extract message text from various Baileys message types
    const text = this._extractText(msg);
    if (!text) return;

    // Check for verification code
    const codeMatch = text.match(VERIFICATION_CODE_REGEX);
    if (!codeMatch) return;

    const verificationCode = codeMatch[0].toUpperCase();
    logger.info(`Detected verification code ${verificationCode} in group ${jid}`);

    // Get group name for the webhook payload
    let groupName = 'Unknown Group';
    try {
      const sock = this.sessionManager.getSocket();
      const meta = await sock.groupMetadata(jid);
      groupName = meta.subject || groupName;
    } catch {
      // Non-critical - continue with unknown group name
    }

    // Forward to SaaS app with Whapi-compatible payload format
    await this._forwardToSaaS(jid, text, groupName);
  }

  /**
   * Extract text content from a Baileys message object
   * Handles the various message content types
   * @param {Object} msg - Baileys message object
   * @returns {string|null}
   */
  _extractText(msg) {
    if (!msg.message) return null;

    return msg.message.conversation
      || msg.message.extendedTextMessage?.text
      || msg.message.imageMessage?.caption
      || msg.message.videoMessage?.caption
      || null;
  }

  /**
   * Forward a verification code detection to the SaaS app's webhook endpoint.
   * Payload format matches what the existing webhook handler expects
   * (see routes/connections.js lines 695-706)
   */
  async _forwardToSaaS(chatId, messageText, chatName) {
    const webhookEndpoint = `${this.webhookUrl}/api/connections/whatsapp/webhook`;

    const payload = {
      messages: [{
        chat_id: chatId,
        text: { body: messageText },
        chat_name: chatName
      }]
    };

    const headers = {
      'Content-Type': 'application/json'
    };

    // Include webhook secret if configured
    if (this.webhookSecret) {
      headers['X-Webhook-Secret'] = this.webhookSecret;
    }

    try {
      const response = await axios.post(webhookEndpoint, payload, {
        headers,
        timeout: 10000
      });

      logger.info(`Webhook forwarded to SaaS app: ${response.status} for code in ${chatId}`);
    } catch (err) {
      const status = err.response?.status || 'network error';
      logger.error(`Failed to forward webhook to SaaS app (${status}): ${err.message}`);
      // Don't throw - webhook failures shouldn't crash the service
    }
  }
}

export default WebhookForwarder;
