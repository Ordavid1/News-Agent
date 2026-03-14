/**
 * Token Manager Service
 *
 * Handles OAuth token storage, retrieval, encryption, and refresh
 * for social media platform connections.
 */

import { supabaseAdmin } from './supabase.js';
import crypto from 'crypto';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()]
});

// Encryption key for token storage — MUST be set explicitly for production stability
if (!process.env.TOKEN_ENCRYPTION_KEY) {
  logger.error('═══════════════════════════════════════════════════════════════');
  logger.error('[TokenManager] WARNING: TOKEN_ENCRYPTION_KEY is not set!');
  logger.error('[TokenManager] Falling back to JWT_SECRET — this is NOT safe for production.');
  logger.error('[TokenManager] If JWT_SECRET changes, ALL stored tokens become unreadable.');
  logger.error('[TokenManager] Set TOKEN_ENCRYPTION_KEY in your environment variables.');
  logger.error('═══════════════════════════════════════════════════════════════');
}
const ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY || process.env.JWT_SECRET || 'default-encryption-key-change-in-production';
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';

/**
 * Encrypt a token for secure storage
 * @param {string} token - Plain text token
 * @returns {string} Encrypted token with IV and auth tag
 */
export function encryptToken(token) {
  if (!token) return null;

  try {
    const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);

    let encrypted = cipher.update(token, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    // Format: iv:authTag:encryptedData
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  } catch (error) {
    logger.error('Error encrypting token:', error);
    throw new Error('Failed to encrypt token');
  }
}

/**
 * Custom error class for token decryption failures
 */
export class TokenDecryptionError extends Error {
  constructor(message = 'Token decryption failed - encryption key may have changed') {
    super(message);
    this.name = 'TokenDecryptionError';
    this.requiresReconnection = true;
  }
}

/**
 * Decrypt a stored token
 * @param {string} encryptedToken - Encrypted token string
 * @returns {string} Decrypted plain text token
 * @throws {TokenDecryptionError} When decryption fails (key mismatch, corrupted token)
 */
export function decryptToken(encryptedToken) {
  if (!encryptedToken) return null;

  try {
    const [ivHex, authTagHex, encrypted] = encryptedToken.split(':');

    if (!ivHex || !authTagHex || !encrypted) {
      // Token might be stored unencrypted (legacy) - check if it looks like a valid OAuth token
      // OAuth tokens are typically long alphanumeric strings
      if (encryptedToken.length > 20 && !encryptedToken.includes(':')) {
        logger.debug('Token appears to be unencrypted (legacy format)');
        return encryptedToken;
      }
      // Otherwise it's likely a corrupted encrypted token
      logger.error('Token format invalid - missing encryption components');
      throw new TokenDecryptionError('Invalid token format - please reconnect your account');
    }

    const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (error) {
    // Check if this is already our custom error
    if (error instanceof TokenDecryptionError) {
      throw error;
    }

    // AES-GCM authentication failure indicates key mismatch or corrupted data
    logger.error('Error decrypting token:', error.message);
    throw new TokenDecryptionError(
      'Unable to decrypt token - your connection credentials are invalid. Please reconnect your account.'
    );
  }
}

/**
 * Store or update social connection tokens
 */
export async function storeTokens({
  userId,
  platform,
  accessToken,
  refreshToken = null,
  expiresIn = null,
  platformUserId = null,
  platformUsername = null,
  platformDisplayName = null,
  platformMetadata = {},
  scopes = []
}) {
  // Encrypt tokens before storage
  const encryptedAccessToken = encryptToken(accessToken);
  const encryptedRefreshToken = refreshToken ? encryptToken(refreshToken) : null;

  // Calculate expiration time
  const tokenExpiresAt = expiresIn
    ? new Date(Date.now() + expiresIn * 1000).toISOString()
    : null;

  const connectionData = {
    user_id: userId,
    platform,
    access_token: encryptedAccessToken,
    refresh_token: encryptedRefreshToken,
    token_expires_at: tokenExpiresAt,
    platform_user_id: platformUserId,
    platform_username: platformUsername,
    platform_display_name: platformDisplayName,
    platform_metadata: platformMetadata,
    scopes,
    status: 'active',
    last_error: null,
    updated_at: new Date().toISOString()
  };

  // Upsert connection (insert or update on conflict)
  const { data, error } = await supabaseAdmin
    .from('social_connections')
    .upsert(connectionData, {
      onConflict: 'user_id,platform',
      ignoreDuplicates: false
    })
    .select()
    .single();

  if (error) {
    logger.error('Error storing tokens:', error);
    throw error;
  }

  // Clean up stale token_refresh_queue entries for this connection.
  // When a user reconnects (OAuth callback), old pending/processing refresh jobs
  // become obsolete — the tokens are brand new and don't need refresh. Stale entries
  // cause the worker to call refreshTokens() unnecessarily, which can race with
  // active publishing operations and kill the connection on transient API errors.
  if (data?.id) {
    try {
      const { error: cleanupErr } = await supabaseAdmin
        .from('token_refresh_queue')
        .delete()
        .eq('connection_id', data.id)
        .in('status', ['pending', 'processing']);

      if (cleanupErr) {
        logger.warn(`Failed to clean up stale refresh queue for connection ${data.id}:`, cleanupErr.message);
      }
    } catch (cleanupEx) {
      // Non-fatal — don't fail the connection on queue cleanup errors
      logger.warn(`Exception cleaning up refresh queue for connection ${data.id}:`, cleanupEx.message);
    }
  }

  logger.info(`Stored ${platform} tokens for user ${userId}`);
  return data;
}

/**
 * Get decrypted tokens for a connection
 * @throws {TokenDecryptionError} When token decryption fails - connection needs reconnection
 */
export async function getTokens(userId, platform) {
  const { data, error } = await supabaseAdmin
    .from('social_connections')
    .select('*')
    .eq('user_id', userId)
    .eq('platform', platform)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null; // Not found
    logger.error('Error getting tokens:', error);
    throw error;
  }

  if (!data) return null;

  // Decrypt tokens - may throw TokenDecryptionError if decryption fails
  // NOTE: getTokens() is a READ operation — it must NEVER call markConnectionError().
  // Destructive error marking must only happen in explicit publishing/action paths.
  try {
    const decryptedAccessToken = decryptToken(data.access_token);
    const decryptedRefreshToken = decryptToken(data.refresh_token);

    return {
      ...data,
      access_token: decryptedAccessToken,
      refresh_token: decryptedRefreshToken
    };
  } catch (decryptError) {
    if (decryptError instanceof TokenDecryptionError) {
      // Diagnostic logging — helps trace intermittent decryption failures
      const atLen = data.access_token?.length || 0;
      const rtLen = data.refresh_token?.length || 0;
      const atParts = data.access_token?.split(':').length || 0;
      const rtParts = data.refresh_token?.split(':').length || 0;
      const callerStack = new Error().stack.split('\n').slice(2, 5).map(l => l.trim()).join(' <- ');
      logger.error(
        `[TokenManager] Token decryption failed for ${platform} (user: ${userId}, conn: ${data.id}). ` +
        `access_token: ${atLen} chars/${atParts} parts, refresh_token: ${rtLen} chars/${rtParts} parts, ` +
        `status: ${data.status}, updated_at: ${data.updated_at}. Caller: ${callerStack}`
      );

      // Single re-read retry — protects against race conditions where a concurrent
      // write (e.g., token refresh worker updating tokens) leaves a transient inconsistency.
      try {
        const { data: retryData } = await supabaseAdmin
          .from('social_connections')
          .select('*')
          .eq('user_id', userId)
          .eq('platform', platform)
          .single();

        if (retryData) {
          const retryAccess = decryptToken(retryData.access_token);
          const retryRefresh = decryptToken(retryData.refresh_token);
          logger.info(`[TokenManager] Retry decryption SUCCEEDED for ${platform} (user: ${userId}) — transient issue resolved`);
          return { ...retryData, access_token: retryAccess, refresh_token: retryRefresh };
        }
      } catch (retryErr) {
        logger.error(`[TokenManager] Retry decryption also FAILED for ${platform} (user: ${userId}): ${retryErr.message}`);
      }

      // Attach connection context to the error so callers can mark if appropriate
      decryptError.platform = platform;
      decryptError.connectionId = data.id;
    }
    throw decryptError;
  }
}

/**
 * Get tokens by connection ID
 * @throws {TokenDecryptionError} When token decryption fails - connection needs reconnection
 */
export async function getTokensByConnectionId(connectionId) {
  const { data, error } = await supabaseAdmin
    .from('social_connections')
    .select('*')
    .eq('id', connectionId)
    .single();

  if (error) {
    logger.error('Error getting tokens by ID:', error);
    throw error;
  }

  if (!data) return null;

  // Decrypt tokens - may throw TokenDecryptionError if decryption fails
  // NOTE: getTokensByConnectionId() is a READ operation — it must NEVER call markConnectionError().
  // Destructive error marking must only happen in explicit publishing/action paths.
  try {
    const decryptedAccessToken = decryptToken(data.access_token);
    const decryptedRefreshToken = decryptToken(data.refresh_token);

    return {
      ...data,
      access_token: decryptedAccessToken,
      refresh_token: decryptedRefreshToken
    };
  } catch (decryptError) {
    if (decryptError instanceof TokenDecryptionError) {
      const atLen = data.access_token?.length || 0;
      const rtLen = data.refresh_token?.length || 0;
      const atParts = data.access_token?.split(':').length || 0;
      const rtParts = data.refresh_token?.split(':').length || 0;
      const callerStack = new Error().stack.split('\n').slice(2, 5).map(l => l.trim()).join(' <- ');
      logger.error(
        `[TokenManager] Token decryption failed for connection ${connectionId} (platform: ${data.platform}). ` +
        `access_token: ${atLen} chars/${atParts} parts, refresh_token: ${rtLen} chars/${rtParts} parts, ` +
        `status: ${data.status}, updated_at: ${data.updated_at}. Caller: ${callerStack}`
      );

      // Single re-read retry — protects against concurrent write race conditions
      try {
        const { data: retryData } = await supabaseAdmin
          .from('social_connections')
          .select('*')
          .eq('id', connectionId)
          .single();

        if (retryData) {
          const retryAccess = decryptToken(retryData.access_token);
          const retryRefresh = decryptToken(retryData.refresh_token);
          logger.info(`[TokenManager] Retry decryption SUCCEEDED for connection ${connectionId} — transient issue resolved`);
          return { ...retryData, access_token: retryAccess, refresh_token: retryRefresh };
        }
      } catch (retryErr) {
        logger.error(`[TokenManager] Retry decryption also FAILED for connection ${connectionId}: ${retryErr.message}`);
      }

      // Attach connection context to the error so callers can mark if appropriate
      decryptError.connectionId = connectionId;
      decryptError.platform = data.platform;
    }
    throw decryptError;
  }
}

/**
 * Update tokens after refresh
 */
export async function updateTokens(connectionId, {
  accessToken,
  refreshToken = null,
  expiresIn = null
}) {
  const updates = {
    access_token: encryptToken(accessToken),
    updated_at: new Date().toISOString(),
    status: 'active',
    last_error: null
  };

  if (refreshToken) {
    updates.refresh_token = encryptToken(refreshToken);
  }

  if (expiresIn) {
    updates.token_expires_at = new Date(Date.now() + expiresIn * 1000).toISOString();
  }

  const { data, error } = await supabaseAdmin
    .from('social_connections')
    .update(updates)
    .eq('id', connectionId)
    .select()
    .single();

  if (error) {
    logger.error('Error updating tokens:', error);
    throw error;
  }

  logger.info(`Updated tokens for connection ${connectionId}`);
  return data;
}

/**
 * Mark connection as expired/error and auto-pause any associated agent
 */
export async function markConnectionError(connectionId, errorMessage) {
  // Log the status change with a stack trace so we can identify the caller
  const callerStack = new Error().stack.split('\n').slice(1, 4).map(l => l.trim()).join(' <- ');
  logger.warn(`[TokenManager] markConnectionError called for connection ${connectionId}: ${errorMessage} | Caller: ${callerStack}`);

  const { error } = await supabaseAdmin
    .from('social_connections')
    .update({
      status: 'error',
      last_error: errorMessage,
      updated_at: new Date().toISOString()
    })
    .eq('id', connectionId);

  if (error) {
    logger.error('Error marking connection error:', error);
    throw error;
  }

  // Auto-pause any active agent tied to this connection
  await pauseAgentForConnection(connectionId, 'error');
}

/**
 * Mark connection as expired and auto-pause any associated agent
 */
export async function markConnectionExpired(connectionId) {
  const { error } = await supabaseAdmin
    .from('social_connections')
    .update({
      status: 'expired',
      updated_at: new Date().toISOString()
    })
    .eq('id', connectionId);

  if (error) {
    logger.error('Error marking connection expired:', error);
    throw error;
  }

  // Auto-pause any active agent tied to this connection
  await pauseAgentForConnection(connectionId, 'expired');
}

/**
 * Check if token needs refresh
 * Returns true if token expires within the buffer time
 */
export function needsRefresh(connection, bufferMinutes = 15) {
  if (!connection || !connection.token_expires_at) {
    return false; // No expiration set, assume it doesn't expire
  }

  const expiresAt = new Date(connection.token_expires_at);
  const bufferMs = bufferMinutes * 60 * 1000;
  const refreshThreshold = new Date(Date.now() + bufferMs);

  return expiresAt <= refreshThreshold;
}

/**
 * Get connections that need token refresh
 */
export async function getConnectionsNeedingRefresh(bufferMinutes = 60) {
  const threshold = new Date(Date.now() + bufferMinutes * 60 * 1000).toISOString();

  const { data, error } = await supabaseAdmin
    .from('social_connections')
    .select('*')
    .eq('status', 'active')
    .not('refresh_token', 'is', null)
    .not('access_token', 'is', null) // Skip connections with no access token — they need reconnection, not refresh
    .lt('token_expires_at', threshold);

  if (error) {
    logger.error('Error getting connections needing refresh:', error);
    throw error;
  }

  return data || [];
}

/**
 * Delete a connection
 */
export async function deleteConnection(userId, platform) {
  const { error } = await supabaseAdmin
    .from('social_connections')
    .delete()
    .eq('user_id', userId)
    .eq('platform', platform);

  if (error) {
    logger.error('Error deleting connection:', error);
    throw error;
  }

  logger.info(`Deleted ${platform} connection for user ${userId}`);
}

/**
 * Revoke a connection (marks as revoked without deleting)
 */
export async function revokeConnection(userId, platform) {
  const { error } = await supabaseAdmin
    .from('social_connections')
    .update({
      status: 'revoked',
      access_token: null,
      refresh_token: null,
      updated_at: new Date().toISOString()
    })
    .eq('user_id', userId)
    .eq('platform', platform);

  if (error) {
    logger.error('Error revoking connection:', error);
    throw error;
  }

  logger.info(`Revoked ${platform} connection for user ${userId}`);
}

/**
 * Auto-pause any active agent tied to a connection that just died.
 * Prevents agents from wasting expensive operations (content gen, video gen)
 * on connections that are known to be broken.
 */
async function pauseAgentForConnection(connectionId, reason) {
  try {
    const { data: agent } = await supabaseAdmin
      .from('agents')
      .select('id, name')
      .eq('connection_id', connectionId)
      .eq('status', 'active')
      .single();

    if (agent) {
      await supabaseAdmin
        .from('agents')
        .update({ status: 'paused' })
        .eq('id', agent.id);

      logger.warn(`Auto-paused agent "${agent.name}" (${agent.id}) — connection ${reason}`);
    }
  } catch (err) {
    // Don't fail the connection status update if agent pause fails
    // PGRST116 = no rows found (no agent for this connection) — not an error
    if (err?.code !== 'PGRST116') {
      logger.error('Failed to auto-pause agent for connection:', err.message);
    }
  }
}

/**
 * Get connection status and metadata WITHOUT decrypting tokens.
 * Safe for read-only checks (UI status display, marketing tab checks).
 * Will never trigger markConnectionError since no decryption occurs.
 */
export async function getConnectionStatus(userId, platform) {
  const { data, error } = await supabaseAdmin
    .from('social_connections')
    .select('id, platform, platform_username, platform_display_name, platform_metadata, status, scopes, token_expires_at, last_error, created_at, updated_at')
    .eq('user_id', userId)
    .eq('platform', platform)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    logger.error('Error getting connection status:', error);
    throw error;
  }

  return data || null;
}

export default {
  TokenDecryptionError,
  encryptToken,
  decryptToken,
  storeTokens,
  getTokens,
  getTokensByConnectionId,
  getConnectionStatus,
  updateTokens,
  markConnectionError,
  markConnectionExpired,
  needsRefresh,
  getConnectionsNeedingRefresh,
  deleteConnection,
  revokeConnection
};
