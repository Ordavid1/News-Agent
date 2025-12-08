/**
 * Connection Manager Service
 *
 * Manages OAuth flows and social media platform connections.
 * Handles initiation, callback processing, and token management
 * for Twitter, LinkedIn, Reddit, Facebook, and Telegram.
 */

import { supabaseAdmin } from './supabase.js';
import TokenManager from './TokenManager.js';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()]
});

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// Platform OAuth configurations
const PLATFORM_CONFIGS = {
  twitter: {
    authUrl: 'https://twitter.com/i/oauth2/authorize',
    tokenUrl: 'https://api.twitter.com/2/oauth2/token',
    userInfoUrl: 'https://api.twitter.com/2/users/me',
    scopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
    usePKCE: true
  },
  linkedin: {
    authUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    userInfoUrl: 'https://api.linkedin.com/v2/userinfo',
    scopes: ['openid', 'profile', 'w_member_social'],
    usePKCE: false
  },
  reddit: {
    authUrl: 'https://www.reddit.com/api/v1/authorize',
    tokenUrl: 'https://www.reddit.com/api/v1/access_token',
    userInfoUrl: 'https://oauth.reddit.com/api/v1/me',
    scopes: ['identity', 'submit', 'read'],
    usePKCE: false
  },
  facebook: {
    authUrl: 'https://www.facebook.com/v18.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v18.0/oauth/access_token',
    userInfoUrl: 'https://graph.facebook.com/me',
    scopes: ['pages_manage_posts', 'pages_read_engagement', 'pages_show_list'],
    usePKCE: false
  }
};

// Store PKCE verifiers temporarily (in production, use Redis or database)
const pkceStore = new Map();

/**
 * Generate PKCE code verifier and challenge
 */
function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto
    .createHash('sha256')
    .update(verifier)
    .digest('base64url');

  return { verifier, challenge };
}

/**
 * Generate OAuth state token
 * Contains user ID, platform, and redirect URL
 */
function generateStateToken(userId, platform, redirectUrl = null) {
  const payload = {
    userId,
    platform,
    redirectUrl: redirectUrl || `${FRONTEND_URL}/settings`,
    timestamp: Date.now()
  };

  return jwt.sign(payload, JWT_SECRET, { expiresIn: '10m' });
}

/**
 * Verify and decode state token
 */
function verifyStateToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    logger.error('Invalid state token:', error.message);
    return null;
  }
}

/**
 * Get OAuth authorization URL for a platform
 */
export function getAuthorizationUrl(userId, platform, redirectUrl = null) {
  const config = PLATFORM_CONFIGS[platform];
  if (!config) {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  const clientId = getClientId(platform);
  if (!clientId) {
    throw new Error(`Missing client ID for ${platform}`);
  }

  const state = generateStateToken(userId, platform, redirectUrl);
  const callbackUrl = getCallbackUrl(platform);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    response_type: 'code',
    scope: config.scopes.join(' '),
    state
  });

  // Add PKCE if required
  if (config.usePKCE) {
    const pkce = generatePKCE();
    pkceStore.set(state, pkce.verifier);

    // Clean up after 10 minutes
    setTimeout(() => pkceStore.delete(state), 10 * 60 * 1000);

    params.append('code_challenge', pkce.challenge);
    params.append('code_challenge_method', 'S256');
  }

  // Platform-specific parameters
  if (platform === 'reddit') {
    params.append('duration', 'permanent'); // For refresh tokens
  }

  return `${config.authUrl}?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForTokens(platform, code, state) {
  // Verify state token
  const stateData = verifyStateToken(state);
  if (!stateData) {
    throw new Error('Invalid or expired state token');
  }

  const config = PLATFORM_CONFIGS[platform];
  const clientId = getClientId(platform);
  const clientSecret = getClientSecret(platform);
  const callbackUrl = getCallbackUrl(platform);

  const tokenParams = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: callbackUrl
  });

  // Add PKCE verifier if applicable
  if (config.usePKCE) {
    const verifier = pkceStore.get(state);
    if (verifier) {
      tokenParams.append('code_verifier', verifier);
      pkceStore.delete(state);
    }
  }

  // Platform-specific token request handling
  let headers = {
    'Content-Type': 'application/x-www-form-urlencoded'
  };

  if (platform === 'twitter') {
    // Twitter uses Basic Auth for token exchange
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    headers['Authorization'] = `Basic ${credentials}`;
  } else if (platform === 'reddit') {
    // Reddit uses Basic Auth
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    headers['Authorization'] = `Basic ${credentials}`;
    headers['User-Agent'] = 'NewsAgentSaaS/1.0';
  } else {
    // Other platforms use client credentials in body
    tokenParams.append('client_id', clientId);
    tokenParams.append('client_secret', clientSecret);
  }

  logger.info(`Exchanging code for ${platform} tokens`);

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers,
    body: tokenParams.toString()
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(`Token exchange failed for ${platform}:`, errorText);
    throw new Error(`Failed to exchange code: ${errorText}`);
  }

  const tokens = await response.json();

  // Fetch user info
  const userInfo = await fetchUserInfo(platform, tokens.access_token);

  // Store tokens
  await TokenManager.storeTokens({
    userId: stateData.userId,
    platform,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
    platformUserId: userInfo.id,
    platformUsername: userInfo.username,
    platformDisplayName: userInfo.displayName,
    platformMetadata: userInfo.metadata || {},
    scopes: config.scopes
  });

  return {
    userId: stateData.userId,
    platform,
    userInfo,
    redirectUrl: stateData.redirectUrl
  };
}

/**
 * Fetch user info from platform API
 */
async function fetchUserInfo(platform, accessToken) {
  const config = PLATFORM_CONFIGS[platform];

  let headers = {
    'Authorization': `Bearer ${accessToken}`
  };

  // Reddit requires User-Agent
  if (platform === 'reddit') {
    headers['User-Agent'] = 'NewsAgentSaaS/1.0';
  }

  let url = config.userInfoUrl;

  // Platform-specific URL modifications
  if (platform === 'twitter') {
    url += '?user.fields=profile_image_url,username,name';
  } else if (platform === 'facebook') {
    url += '?fields=id,name,picture';
  }

  const response = await fetch(url, { headers });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(`Failed to fetch user info for ${platform}:`, errorText);
    throw new Error(`Failed to fetch user info: ${errorText}`);
  }

  const data = await response.json();

  // Normalize user info across platforms
  return normalizeUserInfo(platform, data);
}

/**
 * Normalize user info from different platforms
 */
function normalizeUserInfo(platform, data) {
  switch (platform) {
    case 'twitter':
      return {
        id: data.data?.id,
        username: data.data?.username,
        displayName: data.data?.name,
        avatarUrl: data.data?.profile_image_url,
        metadata: {}
      };

    case 'linkedin':
      return {
        id: data.sub,
        username: data.email || data.sub,
        displayName: data.name,
        avatarUrl: data.picture,
        metadata: {
          authorUrn: `urn:li:person:${data.sub}`
        }
      };

    case 'reddit':
      return {
        id: data.id,
        username: data.name,
        displayName: data.subreddit?.display_name_prefixed || data.name,
        avatarUrl: data.icon_img,
        metadata: {
          karma: data.total_karma
        }
      };

    case 'facebook':
      return {
        id: data.id,
        username: data.name,
        displayName: data.name,
        avatarUrl: data.picture?.data?.url,
        metadata: {}
      };

    default:
      return {
        id: data.id,
        username: data.username || data.name,
        displayName: data.name || data.display_name,
        avatarUrl: data.avatar_url || data.picture,
        metadata: {}
      };
  }
}

/**
 * Refresh tokens for a connection
 */
export async function refreshTokens(connectionId) {
  const connection = await TokenManager.getTokensByConnectionId(connectionId);
  if (!connection || !connection.refresh_token) {
    throw new Error('No refresh token available');
  }

  const platform = connection.platform;
  const config = PLATFORM_CONFIGS[platform];
  const clientId = getClientId(platform);
  const clientSecret = getClientSecret(platform);

  const tokenParams = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: connection.refresh_token
  });

  let headers = {
    'Content-Type': 'application/x-www-form-urlencoded'
  };

  if (platform === 'twitter' || platform === 'reddit') {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    headers['Authorization'] = `Basic ${credentials}`;
    if (platform === 'reddit') {
      headers['User-Agent'] = 'NewsAgentSaaS/1.0';
    }
  } else {
    tokenParams.append('client_id', clientId);
    tokenParams.append('client_secret', clientSecret);
  }

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers,
    body: tokenParams.toString()
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(`Token refresh failed for ${platform}:`, errorText);

    // Mark connection as error
    await TokenManager.markConnectionError(connectionId, errorText);
    throw new Error(`Failed to refresh token: ${errorText}`);
  }

  const tokens = await response.json();

  // Update stored tokens
  await TokenManager.updateTokens(connectionId, {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || connection.refresh_token,
    expiresIn: tokens.expires_in
  });

  logger.info(`Refreshed tokens for connection ${connectionId}`);
  return tokens;
}

/**
 * Get user's connections
 */
export async function getUserConnections(userId) {
  const { data, error } = await supabaseAdmin
    .from('social_connections')
    .select('id, platform, platform_username, platform_display_name, platform_avatar_url, status, last_used_at, created_at')
    .eq('user_id', userId);

  if (error) {
    logger.error('Error getting user connections:', error);
    throw error;
  }

  return data || [];
}

/**
 * Disconnect a platform
 */
export async function disconnectPlatform(userId, platform) {
  await TokenManager.deleteConnection(userId, platform);
  logger.info(`Disconnected ${platform} for user ${userId}`);
}

/**
 * Check if user has active connection for platforms
 */
export async function checkConnections(userId, platforms) {
  const { data, error } = await supabaseAdmin
    .from('social_connections')
    .select('platform')
    .eq('user_id', userId)
    .eq('status', 'active')
    .in('platform', platforms);

  if (error) {
    logger.error('Error checking connections:', error);
    throw error;
  }

  const connectedPlatforms = data.map(c => c.platform);
  const missingPlatforms = platforms.filter(p => !connectedPlatforms.includes(p));

  return {
    connected: connectedPlatforms,
    missing: missingPlatforms,
    allConnected: missingPlatforms.length === 0
  };
}

// Helper functions to get credentials from environment
function getClientId(platform) {
  const envMap = {
    twitter: 'TWITTER_CLIENT_ID',
    linkedin: 'LINKEDIN_CLIENT_ID',
    reddit: 'REDDIT_CLIENT_ID',
    facebook: 'FACEBOOK_APP_ID'
  };
  return process.env[envMap[platform]];
}

function getClientSecret(platform) {
  const envMap = {
    twitter: 'TWITTER_CLIENT_SECRET',
    linkedin: 'LINKEDIN_CLIENT_SECRET',
    reddit: 'REDDIT_CLIENT_SECRET',
    facebook: 'FACEBOOK_APP_SECRET'
  };
  return process.env[envMap[platform]];
}

function getCallbackUrl(platform) {
  const baseUrl = process.env.BACKEND_URL || process.env.FRONTEND_URL || 'http://localhost:3000';
  return `${baseUrl}/api/connections/${platform}/callback`;
}

export default {
  getAuthorizationUrl,
  exchangeCodeForTokens,
  refreshTokens,
  getUserConnections,
  disconnectPlatform,
  checkConnections,
  PLATFORM_CONFIGS
};
