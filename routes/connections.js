/**
 * Social Connections Routes
 *
 * Handles OAuth flows for connecting social media platforms.
 * Endpoints for initiating OAuth, handling callbacks, and managing connections.
 */

import express from 'express';
import ConnectionManager from '../services/ConnectionManager.js';
import TokenManager from '../services/TokenManager.js';
import { authenticateToken } from '../middleware/auth.js';
import winston from 'winston';

const router = express.Router();

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()]
});

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// Supported platforms
const SUPPORTED_PLATFORMS = ['twitter', 'linkedin', 'reddit', 'facebook', 'telegram'];

/**
 * GET /api/connections
 * Get all connections for authenticated user
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const connections = await ConnectionManager.getUserConnections(req.user.id);

    res.json({
      success: true,
      connections: connections.map(conn => ({
        id: conn.id,
        platform: conn.platform,
        username: conn.platform_username,
        displayName: conn.platform_display_name,
        avatarUrl: conn.platform_avatar_url,
        status: conn.status,
        lastUsed: conn.last_used_at,
        connectedAt: conn.created_at
      }))
    });
  } catch (error) {
    logger.error('Error getting connections:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get connections'
    });
  }
});

/**
 * GET /api/connections/:platform/initiate
 * Initiate OAuth flow for a platform
 */
router.get('/:platform/initiate', authenticateToken, async (req, res) => {
  try {
    const { platform } = req.params;
    const { redirect } = req.query;

    // Validate platform
    if (!SUPPORTED_PLATFORMS.includes(platform)) {
      return res.status(400).json({
        success: false,
        error: `Unsupported platform: ${platform}. Supported: ${SUPPORTED_PLATFORMS.join(', ')}`
      });
    }

    // Check if platform credentials are configured
    const clientId = process.env[`${platform.toUpperCase()}_CLIENT_ID`] ||
                     process.env[`${platform.toUpperCase()}_APP_ID`];

    if (!clientId) {
      return res.status(503).json({
        success: false,
        error: `${platform} integration not configured`
      });
    }

    // Generate authorization URL
    const authUrl = ConnectionManager.getAuthorizationUrl(
      req.user.id,
      platform,
      redirect || `${FRONTEND_URL}/profile.html?tab=connections`
    );

    res.json({
      success: true,
      authUrl,
      platform
    });
  } catch (error) {
    logger.error('Error initiating OAuth:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to initiate OAuth'
    });
  }
});

/**
 * GET /api/connections/:platform/callback
 * OAuth callback handler
 */
router.get('/:platform/callback', async (req, res) => {
  try {
    const { platform } = req.params;
    const { code, state, error: oauthError, error_description } = req.query;

    // Handle OAuth errors
    if (oauthError) {
      logger.error(`OAuth error for ${platform}:`, oauthError, error_description);
      return res.redirect(
        `${FRONTEND_URL}/profile.html?tab=connections&error=${encodeURIComponent(error_description || oauthError)}&platform=${platform}`
      );
    }

    // Validate required params
    if (!code || !state) {
      return res.redirect(
        `${FRONTEND_URL}/profile.html?tab=connections&error=missing_params&platform=${platform}`
      );
    }

    // Exchange code for tokens
    const result = await ConnectionManager.exchangeCodeForTokens(platform, code, state);

    logger.info(`Successfully connected ${platform} for user ${result.userId}`);

    // Redirect back to frontend with success
    res.redirect(
      `${result.redirectUrl || FRONTEND_URL + '/profile.html'}?tab=connections&connected=${platform}&username=${encodeURIComponent(result.userInfo.username || '')}`
    );
  } catch (error) {
    logger.error('OAuth callback error:', error);
    const { platform } = req.params;
    res.redirect(
      `${FRONTEND_URL}/profile.html?tab=connections&error=${encodeURIComponent(error.message)}&platform=${platform}`
    );
  }
});

/**
 * DELETE /api/connections/:platform
 * Disconnect a platform
 */
router.delete('/:platform', authenticateToken, async (req, res) => {
  try {
    const { platform } = req.params;

    if (!SUPPORTED_PLATFORMS.includes(platform)) {
      return res.status(400).json({
        success: false,
        error: `Unsupported platform: ${platform}`
      });
    }

    await ConnectionManager.disconnectPlatform(req.user.id, platform);

    res.json({
      success: true,
      message: `Disconnected from ${platform}`
    });
  } catch (error) {
    logger.error('Error disconnecting platform:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to disconnect platform'
    });
  }
});

/**
 * POST /api/connections/:platform/refresh
 * Manually refresh tokens for a platform
 */
router.post('/:platform/refresh', authenticateToken, async (req, res) => {
  try {
    const { platform } = req.params;

    // Get connection
    const connection = await TokenManager.getTokens(req.user.id, platform);
    if (!connection) {
      return res.status(404).json({
        success: false,
        error: `No ${platform} connection found`
      });
    }

    if (!connection.refresh_token) {
      return res.status(400).json({
        success: false,
        error: 'No refresh token available. Please reconnect.'
      });
    }

    // Refresh tokens
    await ConnectionManager.refreshTokens(connection.id);

    res.json({
      success: true,
      message: `${platform} tokens refreshed`
    });
  } catch (error) {
    logger.error('Error refreshing tokens:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to refresh tokens'
    });
  }
});

/**
 * GET /api/connections/status
 * Check connection status for multiple platforms
 */
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const { platforms } = req.query;

    if (!platforms) {
      return res.status(400).json({
        success: false,
        error: 'platforms query parameter required'
      });
    }

    const platformList = platforms.split(',').filter(p => SUPPORTED_PLATFORMS.includes(p));
    const status = await ConnectionManager.checkConnections(req.user.id, platformList);

    res.json({
      success: true,
      ...status
    });
  } catch (error) {
    logger.error('Error checking connection status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check connection status'
    });
  }
});

/**
 * GET /api/connections/supported
 * Get list of supported platforms and their configuration status
 */
router.get('/supported', (req, res) => {
  const platforms = SUPPORTED_PLATFORMS.map(platform => {
    const clientId = process.env[`${platform.toUpperCase()}_CLIENT_ID`] ||
                     process.env[`${platform.toUpperCase()}_APP_ID`];

    return {
      platform,
      configured: !!clientId,
      displayName: platform.charAt(0).toUpperCase() + platform.slice(1)
    };
  });

  res.json({
    success: true,
    platforms
  });
});

/**
 * GET /api/connections/telegram/bot-info
 * Get the app's Telegram bot info (for user guidance in connection modal)
 */
router.get('/telegram/bot-info', async (req, res) => {
  try {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      return res.status(503).json({
        success: false,
        configured: false,
        error: 'Telegram not configured'
      });
    }

    const response = await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`
    );
    const data = await response.json();

    if (!data.ok) {
      return res.status(500).json({
        success: false,
        error: 'Invalid bot configuration'
      });
    }

    res.json({
      success: true,
      configured: true,
      bot: {
        username: `@${data.result.username}`,
        name: data.result.first_name
      }
    });
  } catch (error) {
    logger.error('Error getting Telegram bot info:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get bot info'
    });
  }
});

/**
 * POST /api/connections/telegram
 * Connect Telegram channel (uses app's bot token, user provides channel)
 */
router.post('/telegram', authenticateToken, async (req, res) => {
  try {
    const { channelIdentifier } = req.body;

    if (!channelIdentifier) {
      return res.status(400).json({
        success: false,
        error: 'Channel username or chat ID is required'
      });
    }

    // Check if app has Telegram bot configured
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      return res.status(503).json({
        success: false,
        error: 'Telegram integration not configured'
      });
    }

    // Import TelegramPublisher for validation
    const TelegramPublisher = (await import('../publishers/TelegramPublisher.js')).default;

    // Validate bot has access to the channel
    let channelInfo;
    try {
      channelInfo = await TelegramPublisher.validateBotAccess(channelIdentifier);
    } catch (validationError) {
      return res.status(400).json({
        success: false,
        error: validationError.message
      });
    }

    // Store Telegram connection (no token needed, just channel info)
    await TokenManager.storeTokens({
      userId: req.user.id,
      platform: 'telegram',
      accessToken: null, // Not needed for Telegram - uses app bot token
      platformUserId: channelInfo.chatId.toString(),
      platformUsername: channelInfo.channelUsername || channelInfo.channelTitle,
      platformDisplayName: channelInfo.channelTitle,
      platformMetadata: {
        chatId: channelInfo.chatId,
        channelTitle: channelInfo.channelTitle,
        channelUsername: channelInfo.channelUsername,
        chatType: channelInfo.chatType,
        botId: channelInfo.botId,
        botUsername: channelInfo.botUsername
      }
    });

    logger.info(`Connected Telegram channel ${channelInfo.channelTitle} for user ${req.user.id}`);

    res.json({
      success: true,
      message: 'Telegram channel connected',
      channel: {
        title: channelInfo.channelTitle,
        username: channelInfo.channelUsername,
        botUsername: channelInfo.botUsername
      }
    });
  } catch (error) {
    logger.error('Error connecting Telegram:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to connect Telegram channel'
    });
  }
});

export default router;
