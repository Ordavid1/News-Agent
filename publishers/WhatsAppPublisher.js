// publishers/WhatsAppPublisher.js
import axios from 'axios';
import winston from 'winston';

const WHAPI_API_BASE = 'https://gate.whapi.cloud';

const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[WhatsAppPublisher] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

class WhatsAppPublisher {
  /**
   * Create a WhatsAppPublisher instance
   * @param {Object} credentials - Optional credentials object for per-user publishing
   * @param {string} credentials.groupId - The WhatsApp group ID to post to (e.g., 120363xxx@g.us)
   * @param {string} credentials.groupName - The group name
   * @param {Object} credentials.metadata - Platform metadata
   */
  constructor(credentials = null) {
    // API token comes from environment (master account)
    this.apiToken = process.env.WHAPI_API_TOKEN;

    if (!this.apiToken) {
      logger.warn('WhatsApp API token not configured');
      return;
    }

    if (credentials) {
      // Per-user mode: group info from stored connection
      this.groupId = credentials.groupId || credentials.metadata?.groupId;
      this.groupName = credentials.groupName || credentials.metadata?.groupName;
      logger.debug(`WhatsApp publisher initialized for group: ${this.groupName || this.groupId}`);
    } else {
      logger.warn('WhatsApp publisher initialized without credentials - group ID required for publishing');
    }
  }

  /**
   * Create a new WhatsAppPublisher instance with user-specific credentials
   * @param {Object} credentials - User's group credentials
   * @returns {WhatsAppPublisher} New publisher instance
   */
  static withCredentials(credentials) {
    return new WhatsAppPublisher(credentials);
  }

  /**
   * Get the master account information (phone number)
   * @returns {Object} Account info including phone number and name
   */
  static async getAccountInfo() {
    const apiToken = process.env.WHAPI_API_TOKEN;
    if (!apiToken) {
      throw new Error('WhatsApp API token not configured');
    }

    try {
      const response = await axios.get(`${WHAPI_API_BASE}/settings`, {
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Accept': 'application/json'
        }
      });

      const data = response.data;
      logger.debug(`Account info retrieved: ${data.phone || 'unknown'}`);

      return {
        phoneNumber: data.phone || data.wid?.split('@')[0] || 'Unknown',
        name: data.pushname || data.name || 'AI News Agent',
        wid: data.wid
      };
    } catch (error) {
      logger.error('Failed to get account info:', error.response?.data || error.message);
      throw new Error('Failed to retrieve WhatsApp account information');
    }
  }

  /**
   * Validate that the master account has access to a group
   * @param {string} groupId - The WhatsApp group ID (e.g., 120363xxx@g.us)
   * @returns {Object} Group info including id, name, participant count
   */
  static async validateGroupAccess(groupId) {
    const apiToken = process.env.WHAPI_API_TOKEN;
    if (!apiToken) {
      throw new Error('WhatsApp API token not configured');
    }

    try {
      const response = await axios.get(`${WHAPI_API_BASE}/groups/${groupId}`, {
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Accept': 'application/json'
        }
      });

      const group = response.data;
      logger.debug(`Group info: ${group.name} (ID: ${group.id}, participants: ${group.participants?.length || 0})`);

      return {
        groupId: group.id,
        groupName: group.name || group.subject || 'Unknown Group',
        participantCount: group.participants?.length || 0,
        isAdmin: group.participants?.some(p =>
          p.id === group.owner || (p.admin && p.id === response.data.me)
        ) || false
      };
    } catch (error) {
      if (error.response?.status === 404) {
        throw new Error('Group not found. Make sure the WhatsApp number is added to this group.');
      }
      logger.error('Failed to validate group access:', error.response?.data || error.message);
      throw new Error('Cannot access this WhatsApp group. Make sure the number is added to the group.');
    }
  }

  /**
   * List all groups the master account is a member of
   * @returns {Array} List of groups with id, name, participant count
   */
  static async listGroups() {
    const apiToken = process.env.WHAPI_API_TOKEN;
    if (!apiToken) {
      throw new Error('WhatsApp API token not configured');
    }

    try {
      const response = await axios.get(`${WHAPI_API_BASE}/groups`, {
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Accept': 'application/json'
        }
      });

      const groups = response.data.groups || response.data || [];
      logger.debug(`Found ${groups.length} groups`);

      return groups.map(group => ({
        groupId: group.id,
        groupName: group.name || group.subject || 'Unknown Group',
        participantCount: group.participants?.length || 0
      }));
    } catch (error) {
      logger.error('Failed to list groups:', error.response?.data || error.message);
      throw new Error('Failed to retrieve WhatsApp groups');
    }
  }

  /**
   * Publish a post to the configured WhatsApp group
   * @param {string} content - The content to post
   * @param {string} mediaUrl - Optional URL to an image
   * @returns {Object} Result with success status and post details
   */
  async publishPost(content, mediaUrl = null) {
    try {
      if (!this.apiToken) {
        throw new Error('WhatsApp API token not configured');
      }
      if (!this.groupId) {
        throw new Error('WhatsApp group ID not configured');
      }

      const formattedText = this.formatForWhatsApp(content);
      let result;

      if (mediaUrl && this.isImageUrl(mediaUrl)) {
        result = await this.sendImage(formattedText, mediaUrl);
      } else {
        result = await this.sendMessage(formattedText);
      }

      logger.info(`Successfully published to WhatsApp group: ${this.groupName || this.groupId}`);

      return {
        success: true,
        platform: 'whatsapp',
        postId: result.id || result.message_id || Date.now().toString(),
        groupId: this.groupId,
        groupName: this.groupName
      };
    } catch (error) {
      logger.error('WhatsApp publishing error:', {
        message: error.message,
        groupId: this.groupId,
        response: error.response?.data
      });
      throw error;
    }
  }

  /**
   * Send a text message to the group
   * @param {string} text - The message text
   * @returns {Object} Whapi API response result
   */
  async sendMessage(text) {
    const response = await axios.post(
      `${WHAPI_API_BASE}/messages/text`,
      {
        to: this.groupId,
        body: text
      },
      {
        headers: {
          'Authorization': `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      }
    );

    if (response.data.error) {
      throw new Error(response.data.error.message || 'WhatsApp API error');
    }

    return response.data;
  }

  /**
   * Send an image with caption to the group
   * @param {string} caption - The image caption
   * @param {string} imageUrl - URL to the image
   * @returns {Object} Whapi API response result
   */
  async sendImage(caption, imageUrl) {
    // WhatsApp caption limit is around 1024 characters
    const truncatedCaption = caption.length > 1024
      ? caption.substring(0, 1020) + '...'
      : caption;

    const response = await axios.post(
      `${WHAPI_API_BASE}/messages/image`,
      {
        to: this.groupId,
        media: imageUrl,
        caption: truncatedCaption
      },
      {
        headers: {
          'Authorization': `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      }
    );

    if (response.data.error) {
      throw new Error(response.data.error.message || 'WhatsApp API error');
    }

    return response.data;
  }

  /**
   * Format content for WhatsApp
   * WhatsApp uses: *bold*, _italic_, ~strikethrough~, ```code```
   * @param {string} content - The raw content
   * @returns {string} Formatted content for WhatsApp
   */
  formatForWhatsApp(content) {
    let formatted = content
      // Convert HTML line breaks to newlines
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<p[^>]*>/gi, '')
      // Convert HTML formatting to WhatsApp formatting
      .replace(/<b>(.*?)<\/b>/gi, '*$1*')
      .replace(/<strong>(.*?)<\/strong>/gi, '*$1*')
      .replace(/<i>(.*?)<\/i>/gi, '_$1_')
      .replace(/<em>(.*?)<\/em>/gi, '_$1_')
      .replace(/<s>(.*?)<\/s>/gi, '~$1~')
      .replace(/<strike>(.*?)<\/strike>/gi, '~$1~')
      .replace(/<code>(.*?)<\/code>/gi, '```$1```')
      // Convert links - WhatsApp auto-links URLs, so just extract the URL
      .replace(/<a\s+href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '$2 ($1)')
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

    // WhatsApp message limit is around 65536 characters, but keep it reasonable
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
}

export default WhatsAppPublisher;
