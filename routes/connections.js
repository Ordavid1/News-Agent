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
const SUPPORTED_PLATFORMS = ['twitter', 'linkedin', 'reddit', 'facebook', 'instagram', 'threads', 'telegram', 'whatsapp'];

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
    // Instagram and Threads use the same Meta/Facebook App credentials
    const sharedCredentialMap = { instagram: 'FACEBOOK_APP_ID', threads: 'FACEBOOK_APP_ID' };
    const clientId = sharedCredentialMap[platform]
      ? process.env[sharedCredentialMap[platform]]
      : (process.env[`${platform.toUpperCase()}_CLIENT_ID`] || process.env[`${platform.toUpperCase()}_APP_ID`]);

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

// ============================================
// WHATSAPP ENDPOINTS
// Uses master account model with verification codes
// ============================================

import { supabaseAdmin } from '../services/supabase.js';
import crypto from 'crypto';

/**
 * GET /api/connections/whatsapp/bot-info
 * Get the app's WhatsApp account info (phone number for user to add to their group)
 */
router.get('/whatsapp/bot-info', async (req, res) => {
  try {
    if (!process.env.WHAPI_API_TOKEN) {
      return res.status(503).json({
        success: false,
        configured: false,
        error: 'WhatsApp not configured'
      });
    }

    const WhatsAppPublisher = (await import('../publishers/WhatsAppPublisher.js')).default;
    const accountInfo = await WhatsAppPublisher.getAccountInfo();

    res.json({
      success: true,
      configured: true,
      account: {
        phoneNumber: accountInfo.phoneNumber,
        name: accountInfo.name
      }
    });
  } catch (error) {
    logger.error('Error getting WhatsApp account info:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get WhatsApp account info'
    });
  }
});

/**
 * POST /api/connections/whatsapp/initiate
 * Generate a verification code for WhatsApp connection
 */
router.post('/whatsapp/initiate', authenticateToken, async (req, res) => {
  try {
    // Check tier - WhatsApp is for Starter plan and above
    const tier = req.user.subscription_tier || 'free';
    const allowedTiers = ['starter', 'growth', 'professional', 'business', 'enterprise'];
    if (!allowedTiers.includes(tier)) {
      return res.status(403).json({
        success: false,
        error: 'WhatsApp is available on Starter plan and above. Please upgrade your subscription.'
      });
    }

    if (!process.env.WHAPI_API_TOKEN) {
      return res.status(503).json({
        success: false,
        error: 'WhatsApp integration not configured'
      });
    }

    // Check for existing active code
    const { data: existingCode } = await supabaseAdmin
      .from('whatsapp_pending_connections')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (existingCode && !existingCode.group_id) {
      // Return existing code if not yet used
      const WhatsAppPublisher = (await import('../publishers/WhatsAppPublisher.js')).default;
      const accountInfo = await WhatsAppPublisher.getAccountInfo();

      return res.json({
        success: true,
        verificationCode: existingCode.verification_code,
        phoneNumber: accountInfo.phoneNumber,
        expiresAt: existingCode.expires_at,
        instructions: [
          `Add ${accountInfo.phoneNumber} to your WhatsApp group as a participant`,
          `Send this verification code in the group: ${existingCode.verification_code}`,
          'Click "Check Status" once you\'ve sent the code'
        ]
      });
    }

    // Generate new verification code (format: NA-XXXXXXXX)
    const verificationCode = 'NA-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

    // Store pending connection
    const { error: insertError } = await supabaseAdmin
      .from('whatsapp_pending_connections')
      .insert({
        user_id: req.user.id,
        verification_code: verificationCode,
        expires_at: expiresAt.toISOString(),
        status: 'pending'
      });

    if (insertError) {
      logger.error('Error creating pending connection:', insertError);
      throw new Error('Failed to create verification code');
    }

    const WhatsAppPublisher = (await import('../publishers/WhatsAppPublisher.js')).default;
    const accountInfo = await WhatsAppPublisher.getAccountInfo();

    res.json({
      success: true,
      verificationCode,
      phoneNumber: accountInfo.phoneNumber,
      expiresAt: expiresAt.toISOString(),
      instructions: [
        `Add ${accountInfo.phoneNumber} to your WhatsApp group as a participant`,
        `Send this verification code in the group: ${verificationCode}`,
        'Click "Check Status" once you\'ve sent the code'
      ]
    });
  } catch (error) {
    logger.error('Error initiating WhatsApp connection:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to initiate WhatsApp connection'
    });
  }
});

/**
 * GET /api/connections/whatsapp/pending
 * Get user's pending WhatsApp connections (detected groups)
 */
router.get('/whatsapp/pending', authenticateToken, async (req, res) => {
  try {
    // Get pending connections where group was detected
    const { data: pending, error } = await supabaseAdmin
      .from('whatsapp_pending_connections')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });

    if (error) {
      throw error;
    }

    // Separate detected groups from active codes
    const detectedGroups = pending.filter(p => p.group_id);
    const activeCode = pending.find(p => !p.group_id);

    res.json({
      success: true,
      pending: detectedGroups.map(p => ({
        id: p.id,
        groupId: p.group_id,
        groupName: p.group_name,
        participantCount: p.group_participant_count,
        detectedAt: p.group_detected_at
      })),
      activeCode: activeCode ? {
        code: activeCode.verification_code,
        expiresAt: activeCode.expires_at
      } : null
    });
  } catch (error) {
    logger.error('Error getting pending connections:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get pending connections'
    });
  }
});

/**
 * POST /api/connections/whatsapp/claim
 * Claim a detected group as a connection
 */
router.post('/whatsapp/claim', authenticateToken, async (req, res) => {
  try {
    const { pendingId } = req.body;

    if (!pendingId) {
      return res.status(400).json({
        success: false,
        error: 'pendingId is required'
      });
    }

    // Get the pending connection
    const { data: pending, error: fetchError } = await supabaseAdmin
      .from('whatsapp_pending_connections')
      .select('*')
      .eq('id', pendingId)
      .eq('user_id', req.user.id)
      .eq('status', 'pending')
      .single();

    if (fetchError || !pending) {
      return res.status(404).json({
        success: false,
        error: 'Pending connection not found'
      });
    }

    if (!pending.group_id) {
      return res.status(400).json({
        success: false,
        error: 'No group detected yet. Please send the verification code in your WhatsApp group.'
      });
    }

    // Validate group is still accessible
    const WhatsAppPublisher = (await import('../publishers/WhatsAppPublisher.js')).default;
    let groupInfo;
    try {
      groupInfo = await WhatsAppPublisher.validateGroupAccess(pending.group_id);
    } catch (validationError) {
      return res.status(400).json({
        success: false,
        error: validationError.message
      });
    }

    // Store the connection
    await TokenManager.storeTokens({
      userId: req.user.id,
      platform: 'whatsapp',
      accessToken: null, // Not needed - uses master account token
      platformUserId: groupInfo.groupId,
      platformUsername: groupInfo.groupName,
      platformDisplayName: groupInfo.groupName,
      platformMetadata: {
        groupId: groupInfo.groupId,
        groupName: groupInfo.groupName,
        participantCount: groupInfo.participantCount
      }
    });

    // Mark pending as claimed
    await supabaseAdmin
      .from('whatsapp_pending_connections')
      .update({
        status: 'claimed',
        claimed_at: new Date().toISOString()
      })
      .eq('id', pendingId);

    logger.info(`Connected WhatsApp group ${groupInfo.groupName} for user ${req.user.id}`);

    res.json({
      success: true,
      message: 'WhatsApp group connected',
      group: {
        id: groupInfo.groupId,
        name: groupInfo.groupName,
        participantCount: groupInfo.participantCount
      }
    });
  } catch (error) {
    logger.error('Error claiming WhatsApp connection:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to connect WhatsApp group'
    });
  }
});

/**
 * POST /api/connections/whatsapp/webhook
 * Receive webhook notifications from Whapi
 * This endpoint detects verification codes in group messages
 */
router.post('/whatsapp/webhook', async (req, res) => {
  // Always return 200 OK for webhooks
  res.status(200).json({ success: true });

  try {
    const payload = req.body;

    // Handle different webhook event structures
    const messages = payload.messages || (payload.message ? [payload.message] : []);

    for (const message of messages) {
      // Only process group messages
      const chatId = message.chat_id || message.from;
      if (!chatId || !chatId.endsWith('@g.us')) {
        continue;
      }

      // Get message text
      const text = message.text?.body || message.body || message.text || '';
      if (!text) continue;

      // Look for verification code pattern (NA-XXXXXXXX)
      const codeMatch = text.match(/NA-[A-F0-9]{8}/i);
      if (!codeMatch) continue;

      const verificationCode = codeMatch[0].toUpperCase();
      logger.info(`Detected verification code ${verificationCode} in group ${chatId}`);

      // Find the pending connection with this code
      const { data: pending, error } = await supabaseAdmin
        .from('whatsapp_pending_connections')
        .select('*')
        .eq('verification_code', verificationCode)
        .eq('status', 'pending')
        .gt('expires_at', new Date().toISOString())
        .single();

      if (error || !pending) {
        logger.warn(`No valid pending connection found for code ${verificationCode}`);
        continue;
      }

      // Get group info
      const WhatsAppPublisher = (await import('../publishers/WhatsAppPublisher.js')).default;
      let groupInfo;
      try {
        groupInfo = await WhatsAppPublisher.validateGroupAccess(chatId);
      } catch (e) {
        logger.error(`Failed to get group info for ${chatId}:`, e.message);
        // Still update with basic info
        groupInfo = {
          groupId: chatId,
          groupName: message.chat_name || 'Unknown Group',
          participantCount: 0
        };
      }

      // Update the pending connection with group info
      const { error: updateError } = await supabaseAdmin
        .from('whatsapp_pending_connections')
        .update({
          group_id: groupInfo.groupId,
          group_name: groupInfo.groupName,
          group_participant_count: groupInfo.participantCount,
          group_detected_at: new Date().toISOString()
        })
        .eq('id', pending.id);

      if (updateError) {
        logger.error('Error updating pending connection:', updateError);
      } else {
        logger.info(`Group ${groupInfo.groupName} linked to user ${pending.user_id}`);
      }
    }
  } catch (error) {
    // Log but don't fail - webhook should always succeed
    logger.error('Error processing WhatsApp webhook:', error);
  }
});

// ============================================
// MARKETING SCOPE UPGRADE (Facebook Ads)
// ============================================

/**
 * GET /api/connections/facebook/marketing/initiate
 * Start the marketing scope upgrade flow for Facebook
 */
router.get('/facebook/marketing/initiate', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    logger.info(`[MARKETING-AUTH] Initiating marketing scope upgrade for user ${userId}`);

    const authUrl = ConnectionManager.getMarketingAuthorizationUrl(
      userId,
      `${FRONTEND_URL}/profile.html?tab=marketing`
    );

    res.json({ success: true, authUrl });
  } catch (error) {
    logger.error('[MARKETING-AUTH] Error initiating marketing auth:', error);
    res.status(500).json({ success: false, error: 'Failed to initiate marketing authorization' });
  }
});

/**
 * GET /api/connections/facebook/marketing/callback
 * Handle the callback from Facebook after marketing scope authorization
 */
router.get('/facebook/marketing/callback', async (req, res) => {
  const { code, state, error: oauthError, error_description } = req.query;

  if (oauthError) {
    logger.error(`[MARKETING-AUTH] OAuth error: ${oauthError} - ${error_description}`);
    return res.redirect(`${FRONTEND_URL}/profile.html?tab=marketing&error=${encodeURIComponent(error_description || oauthError)}`);
  }

  if (!code || !state) {
    return res.redirect(`${FRONTEND_URL}/profile.html?tab=marketing&error=missing_params`);
  }

  try {
    const result = await ConnectionManager.exchangeMarketingCode(code, state);

    logger.info(`[MARKETING-AUTH] Marketing scopes granted for user ${result.userId}. Found ${result.adAccounts.length} ad accounts.`);

    // Check ad account limit from the user's marketing addon
    const { getUserAdAccounts, upsertAdAccount, getMarketingAddon } = await import('../services/database-wrapper.js');

    const addon = await getMarketingAddon(result.userId);
    const maxAdAccounts = addon?.max_ad_accounts || 1;
    const existingAccounts = await getUserAdAccounts(result.userId);

    // Calculate how many slots are available
    const slotsAvailable = Math.max(0, maxAdAccounts - existingAccounts.length);

    if (slotsAvailable === 0) {
      logger.warn(`[MARKETING-AUTH] User ${result.userId} already at ad account limit (${maxAdAccounts})`);
      return res.redirect(`${FRONTEND_URL}/profile.html?tab=marketing&error=${encodeURIComponent('Ad account limit reached. Remove an existing account before adding a new one.')}`);
    }

    // Only store up to the available slot count (skip accounts already stored via upsert's ON CONFLICT)
    const accountsToStore = result.adAccounts.slice(0, slotsAvailable);

    for (const account of accountsToStore) {
      await upsertAdAccount({
        userId: result.userId,
        ...account,
        isSelected: existingAccounts.length === 0 && accountsToStore.length === 1
      });
    }

    const storedCount = accountsToStore.length;
    const totalAfter = existingAccounts.length + storedCount;
    const redirectUrl = totalAfter > 1
      ? `${FRONTEND_URL}/profile.html?tab=marketing&select_account=true`
      : `${FRONTEND_URL}/profile.html?tab=marketing&marketing_connected=true`;

    res.redirect(redirectUrl);
  } catch (error) {
    logger.error('[MARKETING-AUTH] Callback error:', error);
    res.redirect(`${FRONTEND_URL}/profile.html?tab=marketing&error=${encodeURIComponent(error.message)}`);
  }
});

export default router;
