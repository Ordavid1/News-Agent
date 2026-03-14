// services/AffiliateCredentialManager.js
// Manages per-user AliExpress affiliate credentials.
// Bridges OAuth tokens (social_connections) and legacy tracking IDs (affiliate_credentials).
// The AE API credentials (App Key, App Secret) are developer-owned env vars.

import TokenManager, { encryptToken, decryptToken } from './TokenManager.js';
import { supabaseAdmin } from './supabase.js';
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
   * Store or update user's affiliate tracking ID.
   * If user has an OAuth connection, stores in platform_metadata.
   * Otherwise, stores in legacy affiliate_credentials table.
   * @param {string} userId
   * @param {string} trackingId - User's AliExpress affiliate tracking ID
   * @returns {object} Stored record (without decrypted secrets)
   */
  static async storeCredentials(userId, trackingId) {
    if (!trackingId) {
      throw new Error('Tracking ID is required');
    }

    // Check if user has an active AliExpress OAuth connection
    let oauthConnection = null;
    try {
      oauthConnection = await TokenManager.getTokens(userId, 'aliexpress');
    } catch (e) { /* no OAuth connection */ }

    if (oauthConnection) {
      // Store tracking ID in platform_metadata of the OAuth connection
      const updatedMetadata = {
        ...(oauthConnection.platform_metadata || {}),
        trackingId
      };
      await supabaseAdmin
        .from('social_connections')
        .update({
          platform_metadata: updatedMetadata,
          updated_at: new Date().toISOString()
        })
        .eq('id', oauthConnection.id);

      logger.info(`Stored AE tracking ID in OAuth connection for user ${userId}`);
      return {
        id: oauthConnection.id,
        userId,
        platform: 'aliexpress',
        status: oauthConnection.status,
        createdAt: oauthConnection.created_at
      };
    }

    // Fallback: legacy flow (store in affiliate_credentials table)
    const encryptedTrackingId = encryptToken(trackingId);
    const result = await upsertAffiliateCredentials(userId, {
      appKey: encryptToken('env'),
      appSecret: encryptToken('env'),
      trackingId: encryptedTrackingId,
      status: 'active',
      lastValidatedAt: null
    });

    logger.info(`Stored AE tracking ID (legacy) for user ${userId}`);
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
   * Get user's credentials (composite: OAuth + legacy).
   * Prioritizes OAuth connection for session token.
   * Falls back to legacy affiliate_credentials for tracking ID.
   * @param {string} userId
   * @returns {object|null} { trackingId, sessionToken, hasOAuth, status, ... } or null
   */
  static async getCredentials(userId) {
    // 1. Check for OAuth connection (new flow)
    let oauthConnection = null;
    try {
      oauthConnection = await TokenManager.getTokens(userId, 'aliexpress');
    } catch (e) {
      // Token decryption or other errors — fall through to legacy
      logger.debug(`No OAuth connection for user ${userId}: ${e.message}`);
    }

    // 2. Check legacy affiliate_credentials table
    const record = await getAffiliateCredentials(userId);

    // Nothing configured at all
    if (!oauthConnection && !record) return null;

    // 3. Determine session token and tracking ID
    let sessionToken = null;
    let trackingId = null;

    if (oauthConnection && oauthConnection.status === 'active') {
      sessionToken = oauthConnection.access_token;
      trackingId = oauthConnection.platform_metadata?.trackingId || null;
    }

    // Fall back to legacy tracking ID if OAuth metadata doesn't have one
    if (!trackingId && record) {
      try {
        trackingId = decryptToken(record.tracking_id);
      } catch (e) {
        logger.warn(`Failed to decrypt legacy tracking ID for user ${userId}`);
      }
    }

    // Need at least a session token or tracking ID
    if (!sessionToken && !trackingId) return null;

    return {
      id: oauthConnection?.id || record?.id,
      userId,
      platform: 'aliexpress',
      trackingId: trackingId || 'default',
      sessionToken,
      status: oauthConnection?.status || record?.status || 'active',
      lastError: record?.last_error,
      lastValidatedAt: record?.last_validated_at,
      apiCallsToday: record?.api_calls_today || 0,
      apiCallsResetAt: record?.api_calls_reset_at,
      metadata: oauthConnection?.platform_metadata || record?.metadata || {},
      createdAt: oauthConnection?.created_at || record?.created_at,
      updatedAt: oauthConnection?.updated_at || record?.updated_at,
      hasOAuth: !!sessionToken
    };
  }

  /**
   * Check credential/connection status (without decrypting tokens)
   * @param {string} userId
   * @returns {object} { configured, oauthConnected, status, trackingId (masked), ... }
   */
  static async getCredentialStatus(userId) {
    // Check OAuth connection
    let oauthConnected = false;
    let oauthUsername = null;
    try {
      const oauthConn = await TokenManager.getTokens(userId, 'aliexpress');
      if (oauthConn && oauthConn.status === 'active') {
        oauthConnected = true;
        oauthUsername = oauthConn.platform_username || oauthConn.platform_display_name;
      }
    } catch { /* no OAuth */ }

    // Check legacy credentials
    const record = await getAffiliateCredentials(userId);
    let maskedTrackingId = null;
    if (record) {
      try {
        const trackingId = decryptToken(record.tracking_id);
        maskedTrackingId = trackingId.length > 4 ? trackingId.slice(0, 4) + '***' : '***';
      } catch { /* ignore */ }
    }

    const configured = oauthConnected || !!record;

    return {
      configured,
      oauthConnected,
      oauthUsername,
      status: oauthConnected ? 'active' : (record?.status || null),
      trackingId: maskedTrackingId,
      lastValidatedAt: record?.last_validated_at,
      lastError: record?.last_error,
      apiCallsToday: record?.api_calls_today || 0
    };
  }

  /**
   * Delete credentials for a user (both OAuth connection and legacy)
   * @param {string} userId
   */
  static async deleteCredentials(userId) {
    // Delete legacy credentials
    await dbDeleteCredentials(userId);

    // Note: OAuth connection is managed via /api/connections/aliexpress DELETE route
    logger.info(`Deleted AE credentials for user ${userId}`);
  }

  /**
   * Validate credentials by making a test API call
   * @param {string} userId
   * @returns {object} { valid, error? }
   */
  static async validateCredentials(userId) {
    const credentials = await this.getCredentials(userId);
    if (!credentials) {
      return { valid: false, error: 'No AliExpress connection found. Please connect your account first.' };
    }

    try {
      const { default: AliExpressService } = await import('./AliExpressService.js');
      const service = new AliExpressService(credentials.trackingId, credentials.sessionToken);

      // Test with a simple product query
      const result = await service.searchProducts('test', { pageSize: 1 });

      if (result.success) {
        // Update legacy table if it exists
        if (!credentials.hasOAuth) {
          await updateAffiliateCredentials(userId, {
            status: 'active',
            last_validated_at: new Date().toISOString(),
            last_error: null
          });
        }
        return { valid: true };
      } else {
        if (!credentials.hasOAuth) {
          await updateAffiliateCredentials(userId, {
            status: 'error',
            last_error: result.error || 'Validation failed'
          });
        }
        return { valid: false, error: result.error || 'API call failed' };
      }
    } catch (error) {
      logger.error(`Credential validation failed for user ${userId}:`, error.message);
      if (!credentials.hasOAuth) {
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
    await updateAffiliateCredentials(userId, {
      status: 'error',
      last_error: errorMessage
    });
  }
}

export default AffiliateCredentialManager;
