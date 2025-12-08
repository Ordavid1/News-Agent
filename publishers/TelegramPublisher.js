// publishers/TelegramPublisher.js
import axios from 'axios';
import winston from 'winston';

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';

const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[TelegramPublisher] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

class TelegramPublisher {
  /**
   * Create a TelegramPublisher instance
   * @param {Object} credentials - Optional credentials object for per-user publishing
   * @param {string} credentials.chatId - The channel/group chat ID to post to
   * @param {string} credentials.channelUsername - The channel username (e.g., @mychannel)
   * @param {Object} credentials.metadata - Platform metadata
   */
  constructor(credentials = null) {
    // Bot token always comes from environment (app-wide)
    this.botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (!this.botToken) {
      logger.warn('Telegram bot token not configured');
      return;
    }

    if (credentials) {
      // Per-user mode: channel info from stored connection
      this.chatId = credentials.chatId || credentials.metadata?.chatId;
      this.channelUsername = credentials.channelUsername || credentials.metadata?.channelUsername;
      logger.debug(`Telegram publisher initialized for channel: ${this.channelUsername || this.chatId}`);
    } else {
      logger.warn('Telegram publisher initialized without credentials - chat ID required for publishing');
    }
  }

  /**
   * Create a new TelegramPublisher instance with user-specific credentials
   * @param {Object} credentials - User's channel credentials
   * @returns {TelegramPublisher} New publisher instance
   */
  static withCredentials(credentials) {
    return new TelegramPublisher(credentials);
  }

  /**
   * Validate that the bot has access to a channel and is an admin
   * @param {string} channelIdentifier - Channel username (@mychannel) or chat ID
   * @returns {Object} Channel info including chatId, title, username, botInfo
   */
  static async validateBotAccess(channelIdentifier) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      throw new Error('Telegram bot token not configured');
    }

    // Get bot info
    const botInfoResponse = await axios.get(
      `${TELEGRAM_API_BASE}${botToken}/getMe`
    );

    if (!botInfoResponse.data.ok) {
      throw new Error('Invalid bot token');
    }

    const botInfo = botInfoResponse.data.result;
    logger.debug(`Bot info: @${botInfo.username} (ID: ${botInfo.id})`);

    // Try to get chat info to validate access
    let chatResponse;
    try {
      chatResponse = await axios.get(
        `${TELEGRAM_API_BASE}${botToken}/getChat`,
        { params: { chat_id: channelIdentifier } }
      );
    } catch (error) {
      if (error.response?.data?.description) {
        throw new Error(`Cannot access channel: ${error.response.data.description}`);
      }
      throw new Error('Bot cannot access this channel. Make sure the bot is added as an admin.');
    }

    if (!chatResponse.data.ok) {
      throw new Error('Bot cannot access this channel. Make sure the bot is added as an admin.');
    }

    const chatInfo = chatResponse.data.result;
    logger.debug(`Chat info: ${chatInfo.title} (ID: ${chatInfo.id}, type: ${chatInfo.type})`);

    // For channels and groups, verify bot has posting permissions
    if (chatInfo.type === 'channel' || chatInfo.type === 'supergroup' || chatInfo.type === 'group') {
      let memberResponse;
      try {
        memberResponse = await axios.get(
          `${TELEGRAM_API_BASE}${botToken}/getChatMember`,
          { params: { chat_id: channelIdentifier, user_id: botInfo.id } }
        );
      } catch (error) {
        throw new Error('Could not verify bot permissions');
      }

      if (!memberResponse.data.ok) {
        throw new Error('Could not verify bot permissions');
      }

      const member = memberResponse.data.result;
      logger.debug(`Bot member status: ${member.status}`);

      if (!['administrator', 'creator'].includes(member.status)) {
        throw new Error('Bot must be an administrator of the channel');
      }

      // For channels, check can_post_messages permission
      if (chatInfo.type === 'channel' && member.can_post_messages === false) {
        throw new Error('Bot does not have permission to post messages');
      }
    }

    return {
      chatId: chatInfo.id,
      channelTitle: chatInfo.title || chatInfo.first_name || 'Private Chat',
      channelUsername: chatInfo.username ? `@${chatInfo.username}` : null,
      chatType: chatInfo.type,
      botId: botInfo.id,
      botUsername: `@${botInfo.username}`
    };
  }

  /**
   * Get bot information
   * @returns {Object} Bot info including username and name
   */
  static async getBotInfo() {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      throw new Error('Telegram bot token not configured');
    }

    const response = await axios.get(`${TELEGRAM_API_BASE}${botToken}/getMe`);

    if (!response.data.ok) {
      throw new Error('Invalid bot token');
    }

    return {
      id: response.data.result.id,
      username: `@${response.data.result.username}`,
      name: response.data.result.first_name
    };
  }

  /**
   * Publish a post to the configured Telegram channel
   * @param {string} content - The content to post
   * @param {string} mediaUrl - Optional URL to an image
   * @returns {Object} Result with success status and post details
   */
  async publishPost(content, mediaUrl = null) {
    try {
      if (!this.botToken) {
        throw new Error('Telegram bot token not configured');
      }
      if (!this.chatId) {
        throw new Error('Telegram chat ID not configured');
      }

      const formattedText = this.formatForTelegram(content);
      let result;

      if (mediaUrl && this.isImageUrl(mediaUrl)) {
        result = await this.sendPhoto(formattedText, mediaUrl);
      } else {
        result = await this.sendMessage(formattedText);
      }

      logger.info(`Successfully published to Telegram: ${result.message_id}`);

      return {
        success: true,
        platform: 'telegram',
        postId: result.message_id.toString(),
        url: this.getMessageUrl(result.message_id),
        chatId: this.chatId
      };
    } catch (error) {
      logger.error('Telegram publishing error:', {
        message: error.message,
        chatId: this.chatId,
        response: error.response?.data
      });
      throw error;
    }
  }

  /**
   * Send a text message to the channel
   * @param {string} text - The message text
   * @returns {Object} Telegram API response result
   */
  async sendMessage(text) {
    const response = await axios.post(
      `${TELEGRAM_API_BASE}${this.botToken}/sendMessage`,
      {
        chat_id: this.chatId,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: false
      }
    );

    if (!response.data.ok) {
      throw new Error(response.data.description || 'Telegram API error');
    }

    return response.data.result;
  }

  /**
   * Send a photo with caption to the channel
   * @param {string} caption - The photo caption
   * @param {string} photoUrl - URL to the image
   * @returns {Object} Telegram API response result
   */
  async sendPhoto(caption, photoUrl) {
    // Telegram caption limit is 1024 characters
    const truncatedCaption = caption.length > 1024
      ? caption.substring(0, 1020) + '...'
      : caption;

    const response = await axios.post(
      `${TELEGRAM_API_BASE}${this.botToken}/sendPhoto`,
      {
        chat_id: this.chatId,
        photo: photoUrl,
        caption: truncatedCaption,
        parse_mode: 'HTML'
      }
    );

    if (!response.data.ok) {
      throw new Error(response.data.description || 'Telegram API error');
    }

    return response.data.result;
  }

  /**
   * Format content for Telegram
   * Telegram supports HTML formatting: <b>, <i>, <a>, <code>, <pre>
   * @param {string} content - The raw content
   * @returns {string} Formatted content for Telegram
   */
  formatForTelegram(content) {
    let formatted = content
      // Convert HTML line breaks to newlines
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<p[^>]*>/gi, '')
      // Preserve Telegram-supported tags
      .replace(/<b>(.*?)<\/b>/gi, '<b>$1</b>')
      .replace(/<strong>(.*?)<\/strong>/gi, '<b>$1</b>')
      .replace(/<i>(.*?)<\/i>/gi, '<i>$1</i>')
      .replace(/<em>(.*?)<\/em>/gi, '<i>$1</i>')
      .replace(/<a\s+href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '<a href="$1">$2</a>')
      .replace(/<code>(.*?)<\/code>/gi, '<code>$1</code>')
      // Remove all other HTML tags
      .replace(/<[^>]*>/g, '')
      // Decode HTML entities
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      // Clean up excessive newlines
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // Telegram message limit is 4096 characters
    if (formatted.length > 4096) {
      formatted = formatted.substring(0, 4090) + '...';
    }

    return formatted;
  }

  /**
   * Check if a URL points to an image
   * @param {string} url - The URL to check
   * @returns {boolean} True if URL appears to be an image
   */
  isImageUrl(url) {
    if (!url) return false;
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const lowerUrl = url.toLowerCase();
    return imageExtensions.some(ext => lowerUrl.includes(ext));
  }

  /**
   * Get the public URL for a message
   * @param {number} messageId - The message ID
   * @returns {string|null} Public URL or null for private channels
   */
  getMessageUrl(messageId) {
    // For public channels with username
    if (this.channelUsername && this.channelUsername.startsWith('@')) {
      return `https://t.me/${this.channelUsername.slice(1)}/${messageId}`;
    }
    // For private channels/groups, no public URL available
    return null;
  }
}

export default TelegramPublisher;
