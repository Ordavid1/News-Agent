// services/AffiliateCredentialManager.js
// Manages per-user AliExpress affiliate credentials.
// OAuth session token comes from social_connections (via TokenManager) — required for commission attribution.
// Tracking ID is an optional sub-label stored in affiliate_credentials table.
// The AE API credentials (App Key, App Secret) are developer-owned env vars.

import { encryptToken, decryptToken } from './TokenManager.js';
import { getTokens, getConnectionStatus } from './TokenManager.js';
import {
  getAffiliateCredentials,
  upsertAffiliateCredentials,
  updateAffiliateCredentials,
  deleteAffiliateCredentials as dbDeleteCredentials
} from './database-wrapper.js';
const PREFIX = '[AffiliateCredentialManager]';
const logger = {
  info: (...args) => console.log(PREFIX, ...args),
  warn: (...args) => console.warn(PREFIX, ...args),
  error: (...args) => console.error(PREFIX, ...args),
  debug: (...args) => { if (process.env.LOG_LEVEL === 'debug') console.log(PREFIX, ...args); }
};

class AffiliateCredentialManager {

  /**
   * Store or update user's affiliate tracking ID (optional sub-label).
   * If the user has an OAuth connection, the tracking ID is also saved in
   * platform_metadata.trackingId on the social_connections row.
   * @param {string} userId
   * @param {string} trackingId - User's AliExpress affiliate tracking ID
   * @returns {object} Stored record (without decrypted secrets)
   */
  static async storeCredentials(userId, trackingId) {
    if (!trackingId) {
      throw new Error('Tracking ID is required');
    }

    const encryptedTrackingId = encryptToken(trackingId);
    const result = await upsertAffiliateCredentials(userId, {
      appKey: encryptToken('env'),
      appSecret: encryptToken('env'),
      trackingId: encryptedTrackingId,
      status: 'active',
      lastValidatedAt: null
    });

    logger.info(`Stored AE tracking ID for user ${userId}`);
    return {
      id: result.id,
      userId: result.user_id,
      platform: result.platform,
      status: result.status,
      lastValidatedAt: result.last_validated_at,
      createdAt: result.created_at
    };
  }

  /**
   * Get user's credentials for API calls.
   * Primary source: OAuth session token from social_connections (required for commission attribution).
   * Secondary source: tracking ID from affiliate_credentials (optional sub-label).
   * @param {string} userId
   * @returns {object|null} { trackingId, sessionToken, hasOAuth, status, ... } or null
   */
  static async getCredentials(userId) {
    // 1. Check for OAuth connection (session token for commission attribution)
    let sessionToken = null;
    let oauthConnected = false;
    try {
      const oauthTokens = await getTokens(userId, 'aliexpress');
      if (oauthTokens?.access_token) {
        sessionToken = oauthTokens.access_token;
        oauthConnected = true;
      }
    } catch (e) {
      logger.warn(`Failed to get OAuth tokens for user ${userId}: ${e.message}`);
    }

    // 2. Check for tracking ID in affiliate_credentials table
    let trackingId = null;
    let affiliateRecord = null;
    try {
      affiliateRecord = await getAffiliateCredentials(userId);
      if (affiliateRecord?.tracking_id) {
        trackingId = decryptToken(affiliateRecord.tracking_id);
      }
    } catch (e) {
      logger.warn(`Failed to get/decrypt tracking ID for user ${userId}: ${e.message}`);
    }

    // Must have at least OAuth connection to make API calls
    if (!oauthConnected) {
      // No OAuth — can't make API calls that credit the user
      if (!affiliateRecord) return null;
      // Has tracking ID but no OAuth — return with warning
      return {
        id: affiliateRecord?.id,
        userId,
        platform: 'aliexpress',
        trackingId,
        sessionToken: null,
        status: 'no_oauth',
        hasOAuth: false,
        lastError: 'AliExpress account not connected. Please connect your account to generate commission-earning links.',
        lastValidatedAt: affiliateRecord?.last_validated_at,
        apiCallsToday: affiliateRecord?.api_calls_today || 0,
        apiCallsResetAt: affiliateRecord?.api_calls_reset_at,
        metadata: affiliateRecord?.metadata || {},
        createdAt: affiliateRecord?.created_at,
        updatedAt: affiliateRecord?.updated_at
      };
    }

    // OAuth connected — return credentials with session token
    return {
      id: affiliateRecord?.id,
      userId,
      platform: 'aliexpress',
      trackingId,
      sessionToken,
      status: affiliateRecord?.status || 'active',
      hasOAuth: true,
      lastError: affiliateRecord?.last_error,
      lastValidatedAt: affiliateRecord?.last_validated_at,
      apiCallsToday: affiliateRecord?.api_calls_today || 0,
      apiCallsResetAt: affiliateRecord?.api_calls_reset_at,
      metadata: affiliateRecord?.metadata || {},
      createdAt: affiliateRecord?.created_at,
      updatedAt: affiliateRecord?.updated_at
    };
  }

  /**
   * Check credential status (without decrypting tokens).
   * Returns OAuth connection status + tracking ID status for the UI.
   * @param {string} userId
   * @returns {object} { configured, oauthConnected, oauthUsername, trackingId (masked), ... }
   */
  static async getCredentialStatus(userId) {
    // Check OAuth connection via social_connections
    let oauthConnected = false;
    let oauthUsername = null;
    try {
      const connStatus = await getConnectionStatus(userId, 'aliexpress');
      if (connStatus && connStatus.status === 'active') {
        oauthConnected = true;
        oauthUsername = connStatus.platform_display_name || connStatus.platform_username || null;
      }
    } catch (e) {
      logger.warn(`Failed to check OAuth status for user ${userId}: ${e.message}`);
    }

    // Check tracking ID from affiliate_credentials
    let maskedTrackingId = null;
    let affiliateRecord = null;
    try {
      affiliateRecord = await getAffiliateCredentials(userId);
      if (affiliateRecord?.tracking_id) {
        const trackingId = decryptToken(affiliateRecord.tracking_id);
        maskedTrackingId = trackingId.length > 4 ? trackingId.slice(0, 4) + '***' : '***';
      }
    } catch { /* ignore */ }

    const configured = oauthConnected || !!affiliateRecord;

    return {
      configured,
      oauthConnected,
      oauthUsername,
      status: oauthConnected ? 'active' : (affiliateRecord?.status || null),
      trackingId: maskedTrackingId,
      lastValidatedAt: affiliateRecord?.last_validated_at,
      lastError: affiliateRecord?.last_error,
      apiCallsToday: affiliateRecord?.api_calls_today || 0
    };
  }

  /**
   * Delete tracking ID credentials for a user.
   * Note: this does NOT disconnect the OAuth connection — use DELETE /api/connections/aliexpress for that.
   * @param {string} userId
   */
  static async deleteCredentials(userId) {
    await dbDeleteCredentials(userId);
    logger.info(`Deleted AE tracking ID for user ${userId}`);
  }

  /**
   * Validate credentials by making a test API call.
   * Requires OAuth connection (session token) — tracking ID alone is not sufficient.
   * @param {string} userId
   * @returns {object} { valid, error? }
   */
  static async validateCredentials(userId) {
    const credentials = await this.getCredentials(userId);
    if (!credentials) {
      return { valid: false, error: 'No credentials configured. Please connect your AliExpress account first.' };
    }
    if (!credentials.hasOAuth) {
      return { valid: false, error: 'AliExpress account not connected. Please connect your account to enable affiliate features.' };
    }

    try {
      const { default: AliExpressService } = await import('./AliExpressService.js');
      const service = new AliExpressService(
        credentials.trackingId || 'default',
        credentials.sessionToken
      );

      // Test with a simple product query
      const result = await service.searchProducts('test', { pageSize: 1 });

      if (result.success) {
        if (credentials.id) {
          await updateAffiliateCredentials(userId, {
            status: 'active',
            last_validated_at: new Date().toISOString(),
            last_error: null
          });
        }
        return { valid: true };
      } else {
        if (credentials.id) {
          await updateAffiliateCredentials(userId, {
            status: 'error',
            last_error: result.error || 'Validation failed'
          });
        }
        return { valid: false, error: result.error || 'API call failed' };
      }
    } catch (error) {
      logger.error(`Credential validation failed for user ${userId}:`, error.message);
      if (credentials.id) {
        await updateAffiliateCredentials(userId, {
          status: 'error',
          last_error: error.message
        });
      }
      return { valid: false, error: error.message };
    }
  }

  /**
   * Mark credentials as having an error
   * @param {string} userId
   * @param {string} errorMessage
   */
  static async markError(userId, errorMessage) {
    try {
      await updateAffiliateCredentials(userId, {
        status: 'error',
        last_error: errorMessage
      });
    } catch (e) {
      logger.warn(`Could not mark error for user ${userId} (no affiliate_credentials row): ${e.message}`);
    }
  }
}

export default AffiliateCredentialManager;
