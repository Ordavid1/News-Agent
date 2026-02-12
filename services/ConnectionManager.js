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

// Meta Graph API version — update this single constant when upgrading
const META_GRAPH_API_VERSION = 'v24.0';

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
    scopes: ['identity', 'submit', 'read', 'flair'],
    usePKCE: false
  },
  facebook: {
    authUrl: `https://www.facebook.com/${META_GRAPH_API_VERSION}/dialog/oauth`,
    tokenUrl: `https://graph.facebook.com/${META_GRAPH_API_VERSION}/oauth/access_token`,
    userInfoUrl: `https://graph.facebook.com/${META_GRAPH_API_VERSION}/me`,
    scopes: ['public_profile', 'pages_manage_posts', 'pages_read_engagement', 'pages_show_list'],
    usePKCE: false
  },
  instagram: {
    authUrl: `https://www.facebook.com/${META_GRAPH_API_VERSION}/dialog/oauth`,
    tokenUrl: `https://graph.facebook.com/${META_GRAPH_API_VERSION}/oauth/access_token`,
    userInfoUrl: `https://graph.facebook.com/${META_GRAPH_API_VERSION}/me/accounts`,
    scopes: ['instagram_basic', 'instagram_content_publish', 'pages_show_list', 'pages_read_engagement'],
    usePKCE: false
  },
  threads: {
    authUrl: 'https://threads.net/oauth/authorize',
    tokenUrl: 'https://graph.threads.net/oauth/access_token',
    userInfoUrl: 'https://graph.threads.net/v1.0/me',
    scopes: ['threads_basic', 'threads_content_publish'],
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

  // For Facebook/Instagram: exchange short-lived token for long-lived token (60 days)
  // Page tokens derived from long-lived user tokens are never-expiring
  let accessToken = tokens.access_token;
  if (platform === 'facebook' || platform === 'instagram') {
    // DEBUG: Test /me/accounts with short-lived token BEFORE exchange
    logger.info('[DEBUG] Testing /me/accounts with SHORT-LIVED token...');
    try {
      const shortLivedTest = await fetch(
        `https://graph.facebook.com/${PLATFORM_CONFIGS[platform]?.authUrl ? META_GRAPH_API_VERSION : 'v24.0'}/me/accounts?fields=id,name&access_token=${accessToken}`
      );
      const shortLivedData = await shortLivedTest.json();
      logger.info(`[DEBUG] /me/accounts with SHORT-LIVED token returned: ${JSON.stringify(shortLivedData)}`);
    } catch (e) {
      logger.warn(`[DEBUG] Short-lived token test failed: ${e.message}`);
    }

    accessToken = await exchangeForLongLivedToken(accessToken);

    // DEBUG: Test /me/accounts with long-lived token AFTER exchange
    logger.info('[DEBUG] Testing /me/accounts with LONG-LIVED token...');
    try {
      const longLivedTest = await fetch(
        `https://graph.facebook.com/${META_GRAPH_API_VERSION}/me/accounts?fields=id,name&access_token=${accessToken}`
      );
      const longLivedData = await longLivedTest.json();
      logger.info(`[DEBUG] /me/accounts with LONG-LIVED token returned: ${JSON.stringify(longLivedData)}`);
    } catch (e) {
      logger.warn(`[DEBUG] Long-lived token test failed: ${e.message}`);
    }
  }

  // Fetch user info (uses long-lived token for facebook/instagram)
  const userInfo = await fetchUserInfo(platform, accessToken);

  // Store tokens
  await TokenManager.storeTokens({
    userId: stateData.userId,
    platform,
    accessToken: accessToken,
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

  // Instagram requires a multi-step lookup to find the IG Business Account
  if (platform === 'instagram') {
    return fetchInstagramUserInfo(accessToken);
  }

  // Threads uses its own API endpoint
  if (platform === 'threads') {
    return fetchThreadsUserInfo(accessToken);
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
  const userInfo = normalizeUserInfo(platform, data);

  // For Facebook, also discover and store the user's Page info during initial connection
  // so that publishing can later use direct page ID fetching instead of /me/accounts
  if (platform === 'facebook') {
    try {
      const pageInfo = await fetchFacebookPageInfo(accessToken);
      if (pageInfo) {
        userInfo.metadata = {
          ...userInfo.metadata,
          pageId: pageInfo.id,
          pageAccessToken: pageInfo.accessToken,
          pageName: pageInfo.name
        };
        logger.info(`Stored Facebook page info: ${pageInfo.name} (${pageInfo.id})`);
      }
    } catch (pageError) {
      logger.warn('Could not fetch Facebook page info during connection:', pageError.message);
      // Non-fatal — user can still reconnect or page token will be fetched at publish time
    }
  }

  return userInfo;
}

/**
 * Fetch Facebook Page info for the connected user.
 * Tries /me/accounts first; if that returns empty (common with Business-type apps),
 * returns null so the caller can handle gracefully.
 * @param {string} accessToken - User's access token
 * @returns {Object|null} Page info { id, name, accessToken } or null if none found
 */
async function fetchFacebookPageInfo(accessToken) {
  // First, check what permissions were actually granted by the user
  try {
    const permResponse = await fetch(
      `https://graph.facebook.com/${META_GRAPH_API_VERSION}/me/permissions?access_token=${accessToken}`
    );
    if (permResponse.ok) {
      const permData = await permResponse.json();
      logger.info(`Facebook granted permissions: ${JSON.stringify(permData.data)}`);
    }
  } catch (permErr) {
    logger.warn(`Could not check Facebook permissions: ${permErr.message}`);
  }

  const pagesUrl = `https://graph.facebook.com/${META_GRAPH_API_VERSION}/me/accounts?fields=id,name,access_token,picture&access_token=${accessToken}`;
  logger.info(`Fetching Facebook pages from: ${pagesUrl.replace(accessToken, 'TOKEN_REDACTED')}`);

  const pagesResponse = await fetch(pagesUrl);

  if (!pagesResponse.ok) {
    const errorText = await pagesResponse.text();
    logger.warn('Failed to fetch pages via /me/accounts:', errorText);
    return null;
  }

  const pagesData = await pagesResponse.json();
  const pages = pagesData.data || [];

  logger.info(`Facebook /me/accounts returned ${pages.length} pages. Full response: ${JSON.stringify(pagesData)}`);

  if (pages.length === 0) {
    logger.warn('/me/accounts returned no pages (common with Business-type Meta apps)');
    return null;
  }

  const page = pages[0];
  return {
    id: page.id,
    name: page.name,
    accessToken: page.access_token,
    pictureUrl: page.picture?.data?.url
  };
}

/**
 * Exchange a short-lived Facebook/Instagram token for a long-lived token.
 * Short-lived tokens last ~1-2 hours. Long-lived tokens last ~60 days.
 * Page tokens derived from long-lived user tokens are never-expiring.
 * @param {string} shortLivedToken - The short-lived access token from OAuth code exchange
 * @returns {string} Long-lived access token (or original token if exchange fails)
 */
async function exchangeForLongLivedToken(shortLivedToken) {
  const clientId = getClientId('facebook');
  const clientSecret = getClientSecret('facebook');

  try {
    const response = await fetch(
      `https://graph.facebook.com/${META_GRAPH_API_VERSION}/oauth/access_token?` +
      `grant_type=fb_exchange_token&client_id=${clientId}&client_secret=${clientSecret}` +
      `&fb_exchange_token=${shortLivedToken}`
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.warn('Failed to exchange for long-lived token:', errorText);
      return shortLivedToken;
    }

    const data = await response.json();
    logger.info(`Exchanged for long-lived Facebook token (expires in ${data.expires_in}s)`);
    return data.access_token;
  } catch (error) {
    logger.warn('Long-lived token exchange error:', error.message);
    return shortLivedToken;
  }
}

/**
 * Fetch a Facebook Page's info directly by page ID.
 * This is the reliable method for Business-type Meta apps where /me/accounts
 * may return empty results.
 * @param {string} pageId - The Facebook Page ID
 * @param {string} accessToken - User's access token with page permissions
 * @returns {Object} Page info with id, name, access_token, instagram_business_account
 */
async function fetchPageById(pageId, accessToken, fields = 'id,name,access_token') {
  const response = await fetch(
    `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${pageId}?fields=${fields}&access_token=${accessToken}`
  );

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(`Failed to fetch page ${pageId} by ID:`, errorText);
    throw new Error(`Failed to fetch page by ID: ${errorText}`);
  }

  return response.json();
}

/**
 * Fetch Instagram Business Account info via Facebook Pages API.
 * Instagram requires: Facebook token → get Pages → find linked IG account → get IG user info.
 *
 * Strategy:
 *   1. Try /me/accounts to discover pages with linked IG accounts.
 *   2. If /me/accounts returns empty (Business-type app), this will throw with a
 *      clear error message guiding the user.
 */
async function fetchInstagramUserInfo(accessToken) {
  // Step 1: Try /me/accounts to get pages with Instagram Business Accounts
  const pagesResponse = await fetch(
    `https://graph.facebook.com/${META_GRAPH_API_VERSION}/me/accounts?fields=id,name,instagram_business_account&access_token=${accessToken}`
  );

  if (!pagesResponse.ok) {
    const errorText = await pagesResponse.text();
    logger.error('Failed to fetch Facebook pages for Instagram:', errorText);
    throw new Error(`Failed to fetch Facebook pages: ${errorText}`);
  }

  const pagesData = await pagesResponse.json();
  const pages = pagesData.data || [];

  // Step 2: Find the first page with an Instagram Business Account
  const pageWithIG = pages.find(page => page.instagram_business_account);

  if (!pageWithIG) {
    if (pages.length === 0) {
      throw new Error(
        'No Facebook pages returned. For Business-type Meta apps, /me/accounts may not list pages. ' +
        'Please ensure you have granted pages_show_list and pages_read_engagement permissions, ' +
        'and that your Facebook Page is associated with your Meta Business account.'
      );
    }
    throw new Error(
      'No Instagram Business Account found linked to your Facebook Pages. ' +
      'Please ensure your Instagram account is connected to a Facebook Page and set as a Business or Creator account.'
    );
  }

  const igAccountId = pageWithIG.instagram_business_account.id;

  // Step 3: Fetch Instagram account details
  const igResponse = await fetch(
    `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${igAccountId}?fields=id,username,name,profile_picture_url&access_token=${accessToken}`
  );

  if (!igResponse.ok) {
    const errorText = await igResponse.text();
    logger.error('Failed to fetch Instagram account info:', errorText);
    throw new Error(`Failed to fetch Instagram account info: ${errorText}`);
  }

  const igData = await igResponse.json();

  return {
    id: igData.id,
    username: igData.username,
    displayName: igData.name || igData.username,
    avatarUrl: igData.profile_picture_url,
    metadata: {
      igUserId: igData.id,
      linkedPageId: pageWithIG.id,
      linkedPageName: pageWithIG.name
    }
  };
}

/**
 * Fetch Threads user info from Threads API
 */
async function fetchThreadsUserInfo(accessToken) {
  const response = await fetch(
    `https://graph.threads.net/v1.0/me?fields=id,username,name,threads_profile_picture_url&access_token=${accessToken}`
  );

  if (!response.ok) {
    const errorText = await response.text();
    logger.error('Failed to fetch Threads user info:', errorText);
    throw new Error(`Failed to fetch Threads user info: ${errorText}`);
  }

  const data = await response.json();

  return {
    id: data.id,
    username: data.username,
    displayName: data.name || data.username,
    avatarUrl: data.threads_profile_picture_url,
    metadata: {
      threadsUserId: data.id
    }
  };
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

    case 'instagram':
      // Instagram user info is handled by fetchInstagramUserInfo() directly
      // This case is a fallback if normalizeUserInfo is called directly
      return {
        id: data.id,
        username: data.username,
        displayName: data.name || data.username,
        avatarUrl: data.profile_picture_url,
        metadata: {
          igUserId: data.id
        }
      };

    case 'threads':
      // Threads user info is handled by fetchThreadsUserInfo() directly
      // This case is a fallback if normalizeUserInfo is called directly
      return {
        id: data.id,
        username: data.username,
        displayName: data.name || data.username,
        avatarUrl: data.threads_profile_picture_url,
        metadata: {
          threadsUserId: data.id
        }
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
    facebook: 'FACEBOOK_APP_ID',
    instagram: 'FACEBOOK_APP_ID',    // Instagram uses the same Meta/Facebook App
    threads: 'FACEBOOK_APP_ID'       // Threads uses the same Meta/Facebook App
  };
  return process.env[envMap[platform]];
}

function getClientSecret(platform) {
  const envMap = {
    twitter: 'TWITTER_CLIENT_SECRET',
    linkedin: 'LINKEDIN_CLIENT_SECRET',
    reddit: 'REDDIT_CLIENT_SECRET',
    facebook: 'FACEBOOK_APP_SECRET',
    instagram: 'FACEBOOK_APP_SECRET', // Instagram uses the same Meta/Facebook App
    threads: 'FACEBOOK_APP_SECRET'    // Threads uses the same Meta/Facebook App
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
