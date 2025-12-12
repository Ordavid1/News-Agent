/**
 * Reddit API Routes
 *
 * Handles Reddit-specific API endpoints for fetching subreddit information,
 * post requirements, and available flairs.
 */

import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { getTokens, TokenDecryptionError } from '../services/TokenManager.js';
import RedditPublisher from '../publishers/RedditPublisher.js';
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

/**
 * GET /api/reddit/subreddit/:name/requirements
 * Fetch post requirements and available flairs for a subreddit
 *
 * Response format:
 * {
 *   success: true,
 *   subreddit: "technology",
 *   requirements: {
 *     flairRequired: true,
 *     flairs: [{ id, text, textEditable, backgroundColor, textColor }],
 *     titleMinLength: 0,
 *     titleMaxLength: 300,
 *     bodyMinLength: 0,
 *     bodyMaxLength: 40000,
 *     bodyRestriction: "none",
 *     linkRestriction: "none",
 *     titleBlacklist: [],
 *     titleRequired: [],
 *     domainBlacklist: [],
 *     domainWhitelist: [],
 *     guidelines: ""
 *   }
 * }
 */
router.get('/subreddit/:name/requirements', authenticateToken, async (req, res) => {
  try {
    const { name } = req.params;
    const userId = req.user.id;

    // Validate subreddit name format
    if (!name || !/^[a-zA-Z0-9_]{1,21}$/.test(name)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid subreddit name. Must be 1-21 alphanumeric characters or underscores.'
      });
    }

    // Get user's Reddit credentials
    const connection = await getTokens(userId, 'reddit');

    if (!connection || !connection.access_token) {
      return res.status(401).json({
        success: false,
        error: 'Reddit not connected. Please connect your Reddit account first.',
        code: 'REDDIT_NOT_CONNECTED'
      });
    }

    // Create publisher with user's credentials (map DB fields to publisher format)
    const credentials = {
      accessToken: connection.access_token,
      refreshToken: connection.refresh_token,
      username: connection.platform_username,
      metadata: connection.platform_metadata || {}
    };
    const publisher = RedditPublisher.withCredentials(credentials);

    // Fetch subreddit info (requirements + flairs)
    const subredditInfo = await publisher.getSubredditInfo(name);

    logger.info(`Fetched requirements for r/${name} for user ${userId}`);

    res.json({
      success: true,
      ...subredditInfo
    });

  } catch (error) {
    logger.error({
      message: 'Error fetching subreddit requirements: ' + error.message,
      name: error.name,
      stack: error.stack,
      platform: 'reddit',
      connectionId: error.connectionId,
      requiresReconnection: error.requiresReconnection
    });

    // Handle token decryption errors - user needs to reconnect
    if (error instanceof TokenDecryptionError || error.name === 'TokenDecryptionError') {
      return res.status(401).json({
        success: false,
        error: 'Your Reddit connection credentials are invalid. Please disconnect and reconnect your Reddit account.',
        code: 'REDDIT_TOKEN_INVALID'
      });
    }

    // Handle specific error cases
    if (error.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        error: `Subreddit r/${req.params.name} not found`,
        code: 'SUBREDDIT_NOT_FOUND'
      });
    }

    if (error.message.includes('private') || error.message.includes('restricted')) {
      return res.status(403).json({
        success: false,
        error: `Cannot access r/${req.params.name} (private or restricted)`,
        code: 'SUBREDDIT_RESTRICTED'
      });
    }

    if (error.response?.status === 401) {
      return res.status(401).json({
        success: false,
        error: 'Reddit authentication expired. Please reconnect your Reddit account.',
        code: 'REDDIT_AUTH_EXPIRED'
      });
    }

    if (error.response?.status === 429) {
      return res.status(429).json({
        success: false,
        error: 'Reddit API rate limit reached. Please try again in a few minutes.',
        code: 'RATE_LIMITED'
      });
    }

    res.status(500).json({
      success: false,
      error: 'Failed to fetch subreddit requirements'
    });
  }
});

/**
 * GET /api/reddit/subreddit/:name/flairs
 * Fetch only the available flairs for a subreddit
 */
router.get('/subreddit/:name/flairs', authenticateToken, async (req, res) => {
  try {
    const { name } = req.params;
    const userId = req.user.id;

    // Validate subreddit name format
    if (!name || !/^[a-zA-Z0-9_]{1,21}$/.test(name)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid subreddit name'
      });
    }

    // Get user's Reddit credentials
    const connection = await getTokens(userId, 'reddit');

    if (!connection || !connection.access_token) {
      return res.status(401).json({
        success: false,
        error: 'Reddit not connected',
        code: 'REDDIT_NOT_CONNECTED'
      });
    }

    // Create publisher with user's credentials (map DB fields to publisher format)
    const credentials = {
      accessToken: connection.access_token,
      refreshToken: connection.refresh_token,
      username: connection.platform_username,
      metadata: connection.platform_metadata || {}
    };
    const publisher = RedditPublisher.withCredentials(credentials);

    // Fetch flairs only
    const flairs = await publisher.getSubredditFlairs(name);

    res.json({
      success: true,
      subreddit: name,
      flairs
    });

  } catch (error) {
    logger.error('Error fetching subreddit flairs:', error);

    res.status(500).json({
      success: false,
      error: 'Failed to fetch subreddit flairs'
    });
  }
});

export default router;
