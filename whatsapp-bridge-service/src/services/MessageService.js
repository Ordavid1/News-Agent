import axios from 'axios';
import logger from '../utils/logger.js';

/**
 * Handles sending text and image messages via Baileys socket.
 * All sends go through the rate limiter to prevent bans.
 */
class MessageService {
  constructor(sessionManager, rateLimiter) {
    this.sessionManager = sessionManager;
    this.rateLimiter = rateLimiter;
  }

  /**
   * Send a text message to a WhatsApp group or chat
   * @param {string} to - Recipient JID (e.g., 120363xxxxx@g.us)
   * @param {string} body - Message text
   * @returns {Object} { sent: true, id: string, timestamp: number }
   */
  async sendText(to, body) {
    if (!to) throw new Error('Recipient "to" is required');
    if (!body) throw new Error('Message "body" is required');

    // Enforce WhatsApp text limit
    const truncated = body.length > 4096
      ? body.substring(0, 4090) + '...'
      : body;

    const result = await this.rateLimiter.throttle(async () => {
      const sock = this.sessionManager.getSocket();
      const msg = await sock.sendMessage(to, { text: truncated });
      return msg;
    });

    this.sessionManager.recordMessageSent();
    logger.info(`Text message sent to ${to} (${truncated.length} chars)`);

    return {
      sent: true,
      id: result.key?.id || Date.now().toString(),
      timestamp: result.messageTimestamp || Math.floor(Date.now() / 1000)
    };
  }

  /**
   * Send an image with caption to a WhatsApp group or chat.
   * Downloads the image URL to a buffer since Baileys requires buffer/file input.
   * @param {string} to - Recipient JID
   * @param {string} mediaUrl - URL of the image to send
   * @param {string} caption - Image caption text
   * @returns {Object} { sent: true, id: string, timestamp: number }
   */
  async sendImage(to, mediaUrl, caption = '') {
    if (!to) throw new Error('Recipient "to" is required');
    if (!mediaUrl) throw new Error('Image "media" URL is required');

    // Enforce WhatsApp caption limit
    const truncatedCaption = caption.length > 1024
      ? caption.substring(0, 1020) + '...'
      : caption;

    // Download image to buffer
    const imageBuffer = await this._downloadMedia(mediaUrl);

    const result = await this.rateLimiter.throttle(async () => {
      const sock = this.sessionManager.getSocket();
      const msg = await sock.sendMessage(to, {
        image: imageBuffer,
        caption: truncatedCaption
      });
      return msg;
    });

    this.sessionManager.recordMessageSent();
    logger.info(`Image message sent to ${to} (caption: ${truncatedCaption.length} chars)`);

    return {
      sent: true,
      id: result.key?.id || Date.now().toString(),
      timestamp: result.messageTimestamp || Math.floor(Date.now() / 1000)
    };
  }

  /**
   * Download media from URL to buffer
   * @param {string} url - Media URL
   * @returns {Buffer}
   */
  async _downloadMedia(url) {
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 30000,
        maxContentLength: 5 * 1024 * 1024 // 5MB limit (WhatsApp outbound cap)
      });

      return Buffer.from(response.data);
    } catch (err) {
      if (err.response?.status === 413 || err.message.includes('maxContentLength')) {
        throw new Error('Image exceeds 5MB size limit');
      }
      logger.error(`Failed to download media from ${url}:`, err.message);
      throw new Error(`Failed to download image: ${err.message}`);
    }
  }
}

export default MessageService;
