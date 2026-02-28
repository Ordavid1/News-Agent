import logger from '../utils/logger.js';

/**
 * Provides account information for the connected WhatsApp number.
 * Maps Baileys sock.user data to Whapi-compatible response format.
 */
class AccountService {
  constructor(sessionManager) {
    this.sessionManager = sessionManager;
  }

  /**
   * Get the connected account settings/info
   * Compatible with Whapi's GET /settings response shape
   * @returns {{ phone: string, pushname: string, wid: string, platform: string }}
   */
  getSettings() {
    const info = this.sessionManager.getAccountInfo();
    if (!info) {
      throw new Error('WhatsApp not connected - no account info available');
    }

    logger.debug(`Account info: phone=${info.phone}, name=${info.pushname}`);

    return {
      phone: info.phone,
      pushname: info.pushname,
      wid: info.wid,
      platform: 'baileys'
    };
  }
}

export default AccountService;
