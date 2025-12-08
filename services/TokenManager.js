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

// Encryption key for token storage (should be in env in production)
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
 * Decrypt a stored token
 * @param {string} encryptedToken - Encrypted token string
 * @returns {string} Decrypted plain text token
 */
export function decryptToken(encryptedToken) {
  if (!encryptedToken) return null;

  try {
    const [ivHex, authTagHex, encrypted] = encryptedToken.split(':');

    if (!ivHex || !authTagHex || !encrypted) {
      // Token might be stored unencrypted (legacy)
      return encryptedToken;
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
    logger.error('Error decrypting token:', error);
    // Return original if decryption fails (might be unencrypted)
    return encryptedToken;
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

  logger.info(`Stored ${platform} tokens for user ${userId}`);
  return data;
}

/**
 * Get decrypted tokens for a connection
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

  // Decrypt tokens
  return {
    ...data,
    access_token: decryptToken(data.access_token),
    refresh_token: decryptToken(data.refresh_token)
  };
}

/**
 * Get tokens by connection ID
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

  return {
    ...data,
    access_token: decryptToken(data.access_token),
    refresh_token: decryptToken(data.refresh_token)
  };
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
 * Mark connection as expired/error
 */
export async function markConnectionError(connectionId, errorMessage) {
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
}

/**
 * Mark connection as expired
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

export default {
  encryptToken,
  decryptToken,
  storeTokens,
  getTokens,
  getTokensByConnectionId,
  updateTokens,
  markConnectionError,
  markConnectionExpired,
  needsRefresh,
  getConnectionsNeedingRefresh,
  deleteConnection,
  revokeConnection
};
