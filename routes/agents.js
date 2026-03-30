/**
 * Agent Routes
 *
 * CRUD operations for user agents.
 * Each agent is tied to a specific platform connection and has its own settings.
 */

import express from 'express';
import {
  getUserAgents,
  getAgentById,
  createAgent,
  updateAgent,
  deleteAgent,
  countUserAgents,
  getUserConnections,
  getAgentByConnectionId,
  createPost,
  logUsage,
  incrementAgentPost,
  markAgentTestUsed
} from '../services/database-wrapper.js';
import { authenticateToken } from '../middleware/auth.js';
import ContentGenerator from '../services/ContentGenerator.js';
import trendAnalyzer from '../services/TrendAnalyzer.js';
import ArticleDeduplicationService from '../services/ArticleDeduplicationService.js';
import { publishToTwitter, publishToLinkedIn, publishToReddit, publishToFacebook, publishToTelegram, publishToWhatsApp, publishToInstagram, publishToThreads, publishToTikTok, publishToYouTube } from '../services/PublishingService.js';
import ImageExtractor from '../services/ImageExtractor.js';
import testProgressEmitter from '../services/TestProgressEmitter.js';
import TokenManager from '../services/TokenManager.js';
import ConnectionManager from '../services/ConnectionManager.js';
import { getAffiliateCredentials, updateAffiliateKeyword, getAffiliateAddon, recordAffiliatePublishedProduct } from '../services/database-wrapper.js';
import AffiliateCredentialManager from '../services/AffiliateCredentialManager.js';
import AffiliateProductFetcher from '../services/AffiliateProductFetcher.js';
import { checkVideoQuota } from '../middleware/subscription.js';
import winston from 'winston';

// Tiers that have access to image extraction feature (Starter and above)
const TIERS_WITH_IMAGES = ['starter', 'growth', 'business'];
// SECURITY: Input validation
import { agentCreateValidation, agentUpdateValidation, agentStatusValidation, idParam } from '../utils/validators.js';

const router = express.Router();

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()]
});

// Initialize content generator
const contentGenerator = new ContentGenerator();

// Agent limits by subscription tier
const AGENT_LIMITS = {
  free: 1,
  starter: 2,
  growth: 5,
  business: -1 // unlimited
};

// Platforms blocked for free tier (video platforms require paid plan)
const FREE_TIER_BLOCKED_PLATFORMS = ['tiktok', 'youtube'];

// Platforms allowed for affiliate product agents
const AFFILIATE_ALLOWED_PLATFORMS = ['whatsapp', 'telegram', 'twitter', 'linkedin', 'facebook', 'reddit', 'instagram', 'threads'];

/**
 * Get agent limit for a tier
 */
function getAgentLimit(tier) {
  return AGENT_LIMITS[tier] ?? 1;
}

/**
 * GET /api/agents
 * Get all agents for the authenticated user
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const agents = await getUserAgents(req.user.id);
    const tier = req.user.subscription?.tier || 'free';
    const limit = getAgentLimit(tier);

    res.json({
      success: true,
      agents,
      count: agents.length,
      limit: limit === -1 ? 'unlimited' : limit,
      canCreate: limit === -1 || agents.length < limit
    });
  } catch (error) {
    logger.error('Error getting agents:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get agents'
    });
  }
});

/**
 * GET /api/agents/available-connections
 * Get connections that don't have agents yet
 */
router.get('/available-connections', authenticateToken, async (req, res) => {
  try {
    const connections = await getUserConnections(req.user.id);
    const agents = await getUserAgents(req.user.id);
    const tier = req.user.subscription?.tier || 'free';

    const agentConnectionIds = agents.map(a => a.connection_id);
    const availableConnections = connections
      .filter(c => {
        if (c.status !== 'active' || agentConnectionIds.includes(c.id)) return false;
        // Hide blocked video platforms for free tier
        if (tier === 'free' && FREE_TIER_BLOCKED_PLATFORMS.includes(c.platform)) return false;
        return true;
      })
      .map(c => ({
        id: c.id,
        platform: c.platform,
        username: c.platform_username,
        displayName: c.platform_display_name
      }));

    res.json({
      success: true,
      connections: availableConnections
    });
  } catch (error) {
    logger.error('Error getting available connections:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get available connections'
    });
  }
});

/**
 * GET /api/agents/:id
 * Get a specific agent by ID
 */
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const agent = await getAgentById(req.params.id);

    if (!agent) {
      return res.status(404).json({
        success: false,
        error: 'Agent not found'
      });
    }

    // Verify ownership
    if (agent.user_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    res.json({
      success: true,
      agent
    });
  } catch (error) {
    logger.error('Error getting agent:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get agent'
    });
  }
});

/**
 * POST /api/agents
 * Create a new agent with optional settings
 */
router.post('/', authenticateToken, agentCreateValidation, async (req, res) => {
  try {
    const { connectionId, name, settings } = req.body;

    if (!connectionId || !name) {
      return res.status(400).json({
        success: false,
        error: 'connectionId and name are required'
      });
    }

    // Check agent limit
    const tier = req.user.subscription?.tier || 'free';
    const limit = getAgentLimit(tier);
    const currentCount = await countUserAgents(req.user.id);

    if (limit !== -1 && currentCount >= limit) {
      return res.status(403).json({
        success: false,
        error: `Agent limit reached. Your ${tier} plan allows ${limit} agent(s). Upgrade to create more.`,
        limit,
        current: currentCount
      });
    }

    // Verify connection exists and belongs to user
    const connections = await getUserConnections(req.user.id);
    const connection = connections.find(c => c.id === connectionId);

    if (!connection) {
      return res.status(404).json({
        success: false,
        error: 'Connection not found'
      });
    }

    if (connection.status !== 'active') {
      return res.status(400).json({
        success: false,
        error: 'Connection is not active. Please reconnect the platform first.'
      });
    }

    // Block video platforms for free tier
    if (tier === 'free' && FREE_TIER_BLOCKED_PLATFORMS.includes(connection.platform)) {
      return res.status(403).json({
        success: false,
        error: `${connection.platform.charAt(0).toUpperCase() + connection.platform.slice(1)} agents require a paid plan. Upgrade to Starter or above to create video platform agents.`
      });
    }

    // Check if agent already exists for this connection
    const existingAgent = await getAgentByConnectionId(connectionId);
    if (existingAgent) {
      return res.status(409).json({
        success: false,
        error: 'An agent already exists for this platform connection'
      });
    }

    // Validate and prepare settings if provided
    let validatedSettings = null;
    if (settings) {
      const contentSource = settings.contentSource || 'news';

      // Validate affiliate product agents
      if (contentSource === 'affiliate_products') {
        // Must be a supported affiliate platform
        if (!AFFILIATE_ALLOWED_PLATFORMS.includes(connection.platform)) {
          return res.status(400).json({
            success: false,
            error: `Affiliate product agents are not supported for ${connection.platform}. Supported platforms: ${AFFILIATE_ALLOWED_PLATFORMS.join(', ')}`
          });
        }

        // Agent creation is already gated by tier-based AGENT_LIMITS (checked above at line ~193)

        // Must have credentials configured
        const credStatus = await AffiliateCredentialManager.getCredentialStatus(req.user.id);
        if (!credStatus.configured || credStatus.status !== 'active') {
          return res.status(400).json({
            success: false,
            error: 'AE credentials must be configured and validated before creating an affiliate agent'
          });
        }
      }

      // Validate brand voice agents
      if (contentSource === 'brand_voice') {
        const bvSettings = settings.brandVoiceSettings;
        if (!bvSettings || !bvSettings.profileId) {
          return res.status(400).json({
            success: false,
            error: 'Brand voice profile ID is required for voice agents'
          });
        }

        // Verify profile exists, belongs to user, and is ready
        const { getBrandVoiceProfileById } = await import('../services/database-wrapper.js');
        const profile = await getBrandVoiceProfileById(bvSettings.profileId, req.user.id);
        if (!profile) {
          return res.status(404).json({
            success: false,
            error: 'Brand voice profile not found'
          });
        }
        if (profile.status !== 'ready') {
          return res.status(400).json({
            success: false,
            error: `Brand voice profile is not ready (status: ${profile.status}). Complete the voice analysis first.`
          });
        }

        // If generating with images, verify trained model exists
        if (bvSettings.generateWithImage) {
          const { getSelectedAdAccount } = await import('../services/database-wrapper.js');
          const adAccount = await getSelectedAdAccount(req.user.id);
          if (!adAccount) {
            return res.status(400).json({
              success: false,
              error: 'No ad account selected. Please set up Brand Media first to use image generation.'
            });
          }
          const MediaAssetService = (await import('../services/MediaAssetService.js')).default;
          const mediaService = new MediaAssetService();
          const defaultJob = await mediaService.getDefaultTrainingJob(req.user.id, adAccount.id);
          if (!defaultJob) {
            return res.status(400).json({
              success: false,
              error: 'No trained model available. Train a model in Brand Media first to use image generation.'
            });
          }
        }
      }

      const topics = Array.isArray(settings.topics) ? settings.topics : [];
      const keywords = Array.isArray(settings.keywords) ? settings.keywords.slice(0, 10) : [];

      // Require at least one topic OR one keyword (only for news agents)
      if (contentSource === 'news' && topics.length === 0 && keywords.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'At least one topic or keyword is required for the agent to find content'
        });
      }

      validatedSettings = {
        contentSource,
        ...(contentSource === 'affiliate_products' && {
          affiliateSettings: {
            keywordSetIds: settings.affiliateSettings?.keywordSetIds || [],
            includeHotProducts: settings.affiliateSettings?.includeHotProducts ?? true,
            includeSmartMatch: settings.affiliateSettings?.includeSmartMatch ?? true
          }
        }),
        ...(contentSource === 'brand_voice' && {
          brandVoiceSettings: {
            profileId: settings.brandVoiceSettings?.profileId,
            generateWithImage: settings.brandVoiceSettings?.generateWithImage ?? false,
            direction: typeof settings.brandVoiceSettings?.direction === 'string'
              ? settings.brandVoiceSettings.direction.slice(0, 500)
              : null
          }
        }),
        topics,
        keywords,
        geoFilter: {
          region: settings.geoFilter?.region ?? '',
          includeGlobal: settings.geoFilter?.includeGlobal ?? true,
          ...(settings.geoFilter?.contentLanguage && { contentLanguage: settings.geoFilter.contentLanguage })
        },
        schedule: {
          postsPerDay: parseInt(settings.schedule?.postsPerDay) || 3,
          startTime: settings.schedule?.startTime || '09:00',
          endTime: settings.schedule?.endTime || '21:00'
        },
        contentStyle: {
          tone: settings.contentStyle?.tone || 'professional',
          includeHashtags: settings.contentStyle?.includeHashtags ?? true
        },
        platformSettings: {
          reddit: {
            subreddit: settings.platformSettings?.reddit?.subreddit || null,
            flairId: settings.platformSettings?.reddit?.flairId || null,
            flairText: settings.platformSettings?.reddit?.flairText || null
          },
          twitter: {
            isPremium: settings.platformSettings?.twitter?.isPremium ?? false
          },
          instagram: {
            contentTypes: Array.isArray(settings.platformSettings?.instagram?.contentTypes)
              ? settings.platformSettings.instagram.contentTypes.filter(t => ['post', 'reels'].includes(t))
              : ['post']
          }
        }
      };
    }

    // Create the agent
    const agent = await createAgent({
      userId: req.user.id,
      connectionId,
      name: name.trim(),
      platform: connection.platform,
      settings: validatedSettings
    });

    logger.info(`Created agent "${name}" for user ${req.user.id} on ${connection.platform}`);

    res.status(201).json({
      success: true,
      agent,
      message: 'Agent created successfully'
    });
  } catch (error) {
    logger.error('Error creating agent:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create agent'
    });
  }
});

/**
 * PUT /api/agents/:id
 * Update agent settings
 */
router.put('/:id', authenticateToken, agentUpdateValidation, async (req, res) => {
  try {
    const agent = await getAgentById(req.params.id);

    if (!agent) {
      return res.status(404).json({
        success: false,
        error: 'Agent not found'
      });
    }

    // Verify ownership
    if (agent.user_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    const { name, settings } = req.body;
    const updates = {};

    if (name !== undefined) {
      updates.name = name.trim();
    }

    if (settings !== undefined) {
      // Validate and merge settings
      const existingContentSource = agent.settings?.contentSource || 'news';
      const topics = Array.isArray(settings.topics) ? settings.topics : agent.settings?.topics || [];
      const keywords = Array.isArray(settings.keywords) ? settings.keywords.slice(0, 10) : agent.settings?.keywords || [];

      // Require at least one topic OR one keyword (only for news agents — affiliate agents use keyword sets)
      if (existingContentSource === 'news' && topics.length === 0 && keywords.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'At least one topic or keyword is required for the agent to find content'
        });
      }

      const validatedSettings = {
        contentSource: existingContentSource,
        ...(existingContentSource === 'affiliate_products' && {
          affiliateSettings: {
            keywordSetIds: settings.affiliateSettings?.keywordSetIds || agent.settings?.affiliateSettings?.keywordSetIds || [],
            includeHotProducts: settings.affiliateSettings?.includeHotProducts ?? agent.settings?.affiliateSettings?.includeHotProducts ?? true,
            includeSmartMatch: settings.affiliateSettings?.includeSmartMatch ?? agent.settings?.affiliateSettings?.includeSmartMatch ?? true
          }
        }),
        topics,
        keywords,
        geoFilter: {
          region: settings.geoFilter?.region ?? agent.settings?.geoFilter?.region ?? '',
          includeGlobal: settings.geoFilter?.includeGlobal ?? agent.settings?.geoFilter?.includeGlobal ?? true,
          ...((settings.geoFilter?.contentLanguage || agent.settings?.geoFilter?.contentLanguage) && {
            contentLanguage: settings.geoFilter?.contentLanguage ?? agent.settings?.geoFilter?.contentLanguage
          })
        },
        schedule: {
          postsPerDay: parseInt(settings.schedule?.postsPerDay) || agent.settings?.schedule?.postsPerDay || 3,
          startTime: settings.schedule?.startTime || agent.settings?.schedule?.startTime || '09:00',
          endTime: settings.schedule?.endTime || agent.settings?.schedule?.endTime || '21:00'
        },
        contentStyle: {
          tone: settings.contentStyle?.tone || agent.settings?.contentStyle?.tone || 'professional',
          includeHashtags: settings.contentStyle?.includeHashtags ?? agent.settings?.contentStyle?.includeHashtags ?? true
        },
        platformSettings: {
          reddit: {
            subreddit: settings.platformSettings?.reddit?.subreddit ?? agent.settings?.platformSettings?.reddit?.subreddit ?? null,
            flairId: settings.platformSettings?.reddit?.flairId ?? agent.settings?.platformSettings?.reddit?.flairId ?? null,
            flairText: settings.platformSettings?.reddit?.flairText ?? agent.settings?.platformSettings?.reddit?.flairText ?? null
          },
          twitter: {
            isPremium: settings.platformSettings?.twitter?.isPremium ?? agent.settings?.platformSettings?.twitter?.isPremium ?? false
          },
          instagram: {
            contentTypes: Array.isArray(settings.platformSettings?.instagram?.contentTypes)
              ? settings.platformSettings.instagram.contentTypes.filter(t => ['post', 'reels'].includes(t))
              : (agent.settings?.platformSettings?.instagram?.contentTypes || ['post'])
          }
        }
      };
      updates.settings = validatedSettings;
    }

    const updatedAgent = await updateAgent(req.params.id, updates);

    res.json({
      success: true,
      agent: updatedAgent,
      message: 'Agent updated successfully'
    });
  } catch (error) {
    logger.error('Error updating agent:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update agent'
    });
  }
});

/**
 * PUT /api/agents/:id/status
 * Toggle agent status (active/paused)
 */
router.put('/:id/status', authenticateToken, agentStatusValidation, async (req, res) => {
  try {
    const agent = await getAgentById(req.params.id);

    if (!agent) {
      return res.status(404).json({
        success: false,
        error: 'Agent not found'
      });
    }

    // Verify ownership
    if (agent.user_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    const { status } = req.body;

    if (!['active', 'paused'].includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'Status must be "active" or "paused"'
      });
    }

    // When activating, verify agent has required configuration for its content source
    if (status === 'active') {
      const agentContentSource = agent.settings?.contentSource || 'news';
      if (agentContentSource === 'news') {
        const topics = agent.settings?.topics || [];
        const keywords = agent.settings?.keywords || [];
        if (topics.length === 0 && keywords.length === 0) {
          return res.status(400).json({
            success: false,
            error: 'Cannot activate agent without at least one topic or keyword configured'
          });
        }
      } else if (agentContentSource === 'brand_voice') {
        if (!agent.settings?.brandVoiceSettings?.profileId) {
          return res.status(400).json({
            success: false,
            error: 'Cannot activate voice agent without a brand voice profile configured'
          });
        }
      }
      // affiliate_products agents have their own runtime checks
    }

    const updatedAgent = await updateAgent(req.params.id, { status });

    res.json({
      success: true,
      agent: updatedAgent,
      message: `Agent ${status === 'active' ? 'activated' : 'paused'}`
    });
  } catch (error) {
    logger.error('Error updating agent status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update agent status'
    });
  }
});

/**
 * DELETE /api/agents/:id
 * Delete an agent
 */
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const agent = await getAgentById(req.params.id);

    if (!agent) {
      return res.status(404).json({
        success: false,
        error: 'Agent not found'
      });
    }

    // Verify ownership
    if (agent.user_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    await deleteAgent(req.params.id);

    // For affiliate agents, unlink keyword set metadata
    if (agent.settings?.contentSource === 'affiliate_products') {
      const keywordSetIds = agent.settings?.affiliateSettings?.keywordSetIds || [];
      for (const kwId of keywordSetIds) {
        try {
          await updateAffiliateKeyword(kwId, { metadata: {} });
        } catch (e) {
          logger.warn(`Failed to unlink keyword set ${kwId} from deleted agent: ${e.message}`);
        }
      }
    }

    logger.info(`Deleted agent ${req.params.id} for user ${req.user.id}`);

    res.json({
      success: true,
      message: 'Agent deleted successfully'
    });
  } catch (error) {
    logger.error('Error deleting agent:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete agent'
    });
  }
});

/**
 * GET /api/agents/:id/test/progress
 * SSE endpoint for real-time test progress streaming.
 *
 * Auth: httpOnly authToken cookie (automatic for same-origin SSE requests).
 * CSRF: Skipped for GET by csrfProtection middleware.
 */
router.get('/:id/test/progress', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const agentId = req.params.id;

  // Verify agent ownership (prevents subscribing to other users' agents)
  const agent = await getAgentById(agentId);
  if (!agent || agent.user_id !== userId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no' // Disable nginx/proxy buffering on Render
  });

  // Send initial connection event
  res.write(`data: ${JSON.stringify({ phase: 'connected', message: 'Connected to progress stream' })}\n\n`);

  // Keep-alive heartbeat every 15 seconds (prevents proxy timeouts)
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 15000);

  // Subscribe to progress events for this user+agent
  const unsubscribe = testProgressEmitter.subscribe(userId, agentId, (event) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (writeError) {
      // Connection may have closed
      logger.warn(`[SSE] Write error for agent ${agentId}:`, writeError.message);
    }

    // Close connection on terminal events
    if (event.phase === 'complete' || event.phase === 'error') {
      setTimeout(() => {
        clearInterval(heartbeat);
        try { res.end(); } catch (e) { /* already closed */ }
      }, 500);
    }
  });

  // Safety timeout: close SSE connection after 12 minutes
  // Must exceed video generation polling (10 min) + LLM prompt gen + image extraction
  const connectionTimeout = setTimeout(() => {
    res.write(`data: ${JSON.stringify({ phase: 'timeout', message: 'Connection timed out' })}\n\n`);
    clearInterval(heartbeat);
    unsubscribe();
    try { res.end(); } catch (e) { /* already closed */ }
  }, 720000);

  // Handle client disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    clearTimeout(connectionTimeout);
    unsubscribe();
  });
});

/**
 * POST /api/agents/:id/test
 * Test post for a specific agent using its settings
 * NOTE: Each agent can only use the Test button ONCE. This is persisted server-side.
 */
router.post('/:id/test', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const agentId = req.params.id;

  console.log(`[Agent Test] Starting test for agent ${agentId}, user ${userId}`);

  // Start progress tracking session for SSE subscribers
  testProgressEmitter.startSession(userId, agentId);
  testProgressEmitter.emitProgress(userId, agentId, 'validating', 'Validating agent configuration...');

  try {
    // Get agent
    const agent = await getAgentById(agentId);

    if (!agent) {
      testProgressEmitter.emitProgress(userId, agentId, 'error', 'Agent not found');
      return res.status(404).json({
        success: false,
        error: 'Agent not found'
      });
    }

    // Verify ownership
    if (agent.user_id !== userId) {
      testProgressEmitter.emitProgress(userId, agentId, 'error', 'Access denied');
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    // Check if test was already used (one-time test per agent)
    if (agent.test_used_at) {
      testProgressEmitter.emitProgress(userId, agentId, 'error', 'Test already used for this agent');
      return res.status(403).json({
        success: false,
        error: 'Test already used for this agent. Each agent can only be tested once.',
        step: 'test_limit',
        testUsedAt: agent.test_used_at
      });
    }

    // Check agent status
    if (agent.status !== 'active') {
      testProgressEmitter.emitProgress(userId, agentId, 'error', 'Agent is paused');
      return res.status(400).json({
        success: false,
        error: 'Agent is paused. Activate it first to test.',
        step: 'status'
      });
    }

    // Check user's daily post limit
    const postsRemaining = req.user.subscription?.postsRemaining ?? 0;
    if (postsRemaining <= 0) {
      testProgressEmitter.emitProgress(userId, agentId, 'error', 'Daily post limit reached');
      return res.status(403).json({
        success: false,
        error: 'Daily post limit reached',
        step: 'quota'
      });
    }

    // Get agent settings
    const settings = agent.settings || {};
    const topics = Array.isArray(settings.topics) ? settings.topics : [];
    const keywords = Array.isArray(settings.keywords) ? settings.keywords : [];
    const geoFilter = settings.geoFilter || {};
    const tone = settings.contentStyle?.tone || 'professional';
    const platform = agent.platform;
    const platformSettings = settings.platformSettings || {};

    // ── Route to content-source-specific test flows ──
    const contentSource = settings.contentSource || 'news';
    if (contentSource === 'affiliate_products') {
      return await testAffiliateAgent(req, res, agent, settings, userId, agentId, platform);
    }
    if (contentSource === 'brand_voice') {
      return await testVoiceAgent(req, res, agent, settings, userId, agentId, platform);
    }

    // Validate agent has topics or keywords (news agents only)
    if (topics.length === 0 && keywords.length === 0) {
      testProgressEmitter.emitProgress(userId, agentId, 'error', 'No topics or keywords configured');
      return res.status(400).json({
        success: false,
        error: 'Agent has no topics or keywords configured. Please configure the agent settings first.',
        step: 'settings'
      });
    }

    console.log(`[Agent Test] Agent settings:`, { topics, keywords, geoFilter, tone, platform, platformSettings });

    // Step 0: Early connection health check — BEFORE any expensive operations
    // This prevents wasting API calls (content gen, video gen) on a dead connection
    testProgressEmitter.emitProgress(userId, agentId, 'connection_check', 'Verifying platform connection...');
    try {
      const connection = await TokenManager.getTokens(userId, platform);
      if (!connection) {
        testProgressEmitter.emitProgress(userId, agentId, 'error', `No ${platform} connection found`);
        return res.status(400).json({
          success: false,
          error: `No ${platform} connection found. Please connect your ${platform} account in Settings first.`,
          step: 'connection'
        });
      }
      if (connection.status !== 'active') {
        testProgressEmitter.emitProgress(userId, agentId, 'error', `${platform} connection is ${connection.status}`);
        return res.status(400).json({
          success: false,
          error: `Your ${platform} connection is ${connection.status}. Please disconnect and reconnect your account in Settings.`,
          step: 'connection'
        });
      }
      // Pre-emptively refresh if token is about to expire
      if (TokenManager.needsRefresh(connection)) {
        console.log(`[Agent Test] Token for ${platform} needs refresh, attempting pre-emptive refresh...`);
        try {
          await ConnectionManager.refreshTokens(connection.id);
          console.log(`[Agent Test] Token refreshed successfully for ${platform}`);
        } catch (refreshErr) {
          testProgressEmitter.emitProgress(userId, agentId, 'error', `${platform} token expired and could not be refreshed`);
          return res.status(400).json({
            success: false,
            error: `Your ${platform} token has expired and could not be refreshed. Please reconnect your account in Settings.`,
            step: 'connection'
          });
        }
      }
      console.log(`[Agent Test] Connection verified for ${platform} (@${connection.platform_username || 'unknown'})`);
    } catch (connError) {
      // TokenDecryptionError or other connection failures
      testProgressEmitter.emitProgress(userId, agentId, 'error', `${platform} connection credentials are invalid`);
      return res.status(400).json({
        success: false,
        error: `Your ${platform} connection credentials are invalid. Please disconnect and reconnect your account in Settings.`,
        step: 'connection'
      });
    }

    // Step 1: Fetch trends using all configured topics
    console.log(`[Agent Test] Fetching trends for topics: ${topics.join(', ')}`);
    testProgressEmitter.emitProgress(userId, agentId, 'trends', 'Searching for trending news...');

    let trendData;
    try {
      // Try with default lookback, then broaden +24h per retry up to 168h (7 days)
      let allTrends = [];
      const lookbackSteps = [72, 96, 120, 144, 168];
      for (const lookback of lookbackSteps) {
        if (lookback > 72) {
          console.log(`[Agent Test] No results at ${lookback - 24}h, broadening search to ${lookback}h`);
          testProgressEmitter.emitProgress(userId, agentId, 'trends', `Broadening search window to ${Math.round(lookback / 24)} days...`);
        }
        allTrends = await trendAnalyzer.getTrendsForTopics(topics, {
          keywords,
          geoFilter,
          lookbackHours: lookback
        });
        if (allTrends && allTrends.length > 0) break;
      }

      if (allTrends && allTrends.length > 0) {
        // Score and select the best trend
        // Prefer recent articles with good titles
        const scored = allTrends.map(trend => {
          let score = 50;

          // Recency bonus
          if (trend.publishedAt) {
            const ageHours = (Date.now() - new Date(trend.publishedAt).getTime()) / (1000 * 60 * 60);
            if (ageHours < 2) score += 30;
            else if (ageHours < 6) score += 20;
            else if (ageHours < 12) score += 10;
          }

          // Title quality bonus
          const title = trend.title || trend.topic || '';
          if (title.length > 30 && title.length < 150) score += 15;

          // Source diversity
          const sources = Array.isArray(trend.sources) ? trend.sources.length : 1;
          score += Math.min(sources * 5, 20);

          return { ...trend, calculatedScore: score };
        });

        scored.sort((a, b) => b.calculatedScore - a.calculatedScore);

        // Weighted random selection from top candidates for variety across test runs
        const topCandidates = scored.slice(0, Math.min(5, scored.length));
        const totalScore = topCandidates.reduce((sum, t) => sum + t.calculatedScore, 0);
        const random = Math.random() * totalScore;
        let cumulative = 0;
        trendData = topCandidates[topCandidates.length - 1];
        for (const candidate of topCandidates) {
          cumulative += candidate.calculatedScore;
          if (random <= cumulative) {
            trendData = candidate;
            break;
          }
        }

        console.log(`[Agent Test] Selected article: "${trendData.title}" (from ${scored.length} candidates, top 5 scores: ${topCandidates.map(t => t.calculatedScore).join(', ')})`);
      } else {
        const searchDescription = `topics "${topics.join(', ')}"${keywords.length > 0 ? ` with keywords "${keywords.join(', ')}"` : ''}`;
        testProgressEmitter.emitProgress(userId, agentId, 'error', 'No trending news found');
        return res.status(400).json({
          success: false,
          error: `No news found for ${searchDescription} within the last 7 days. Try different topics or keywords in agent settings.`,
          step: 'trends'
        });
      }
    } catch (trendError) {
      console.error('[Agent Test] Trend fetch error:', trendError);
      testProgressEmitter.emitProgress(userId, agentId, 'error', 'Failed to fetch trends');
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch trends',
        message: trendError.message,
        step: 'trends'
      });
    }

    // Step 2: Generate content
    console.log(`[Agent Test] Generating content for ${platform} with tone: ${tone}`);
    testProgressEmitter.emitProgress(userId, agentId, 'generating', 'Generating AI content...');

    // Build agentSettings from agent's saved settings
    const agentSettings = {
      topics: topics,
      keywords: keywords,
      geoFilter: geoFilter,
      contentStyle: {
        tone: tone,
        includeHashtags: settings.contentStyle?.includeHashtags ?? true
      },
      platformSettings: platformSettings
    };

    const generatedContent = await contentGenerator.generateContent(
      trendData,
      platform,
      agentSettings
    );

    if (!generatedContent || !generatedContent.text) {
      testProgressEmitter.emitProgress(userId, agentId, 'error', 'Failed to generate content');
      return res.status(500).json({
        success: false,
        error: 'Failed to generate content',
        step: 'generation'
      });
    }

    // Step 2.5: Extract image from article (Growth tier and above only)
    let imageUrl = null;
    const userTier = req.user.subscription?.tier || 'free';
    const platformDisplayName = platform.charAt(0).toUpperCase() + platform.slice(1);

    if (TIERS_WITH_IMAGES.includes(userTier)) {
      testProgressEmitter.emitProgress(userId, agentId, 'media', 'Extracting media from article...');
      const requiresMedia = ['instagram', 'tiktok', 'youtube'].includes(platform);
      console.log(`[Agent Test] User tier "${userTier}" - extracting image${requiresMedia ? ` [${platform} — retry enabled]` : ''}...`);
      try {
        const imageExtractor = new ImageExtractor();

        if (requiresMedia) {
          // Instagram/TikTok require an image — use robust retry logic with fallback to pre-existing image
          imageUrl = await imageExtractor.extractImageWithRetry({
            articleUrl: trendData.url,
            articleTitle: trendData.title,
            articleSource: trendData.source,
            preExistingImageUrl: trendData.imageUrl || null,
            maxRetries: 2,
            retryDelayMs: 3000
          });
        } else {
          imageUrl = await imageExtractor.extractImageFromArticle(
            trendData.url,
            trendData.title,
            trendData.source
          );
        }

        if (imageUrl) {
          console.log(`[Agent Test] Image extracted: ${imageUrl}`);
        } else {
          console.log(`[Agent Test] No image found for article${requiresMedia ? ` — ${platform} post will be blocked` : ', continuing without image'}`);
        }
      } catch (imageError) {
        console.warn(`[Agent Test] Image extraction failed, continuing without image:`, imageError.message);
        imageUrl = null;
      }
    } else {
      console.log(`[Agent Test] User tier "${userTier}" - image extraction not available (Growth+ required)`);
    }

    // Step 2.5: Determine effective Instagram content type for this test
    let effectiveIgContentType = null;
    if (platform === 'instagram') {
      const igContentTypes = platformSettings.instagram?.contentTypes || ['post'];
      // Allow explicit override via query param (for testing specific content types)
      effectiveIgContentType = req.query.contentType && ['post', 'reels'].includes(req.query.contentType)
        ? req.query.contentType
        : igContentTypes[0];
      console.log(`[Agent Test] Instagram content type: ${effectiveIgContentType}`);
    }

    // Step 2.6: For video platforms (TikTok, YouTube, Instagram Reels) — check video quota then generate video
    const VIDEO_PLATFORMS = ['tiktok', 'youtube'];
    const isVideoMode = VIDEO_PLATFORMS.includes(platform) || effectiveIgContentType === 'reels';
    if (isVideoMode) {
      // Check video quota before expensive video generation
      const videoQuota = await checkVideoQuota(userId, req.user.subscription);
      if (!videoQuota.allowed) {
        testProgressEmitter.emitProgress(userId, agentId, 'error', videoQuota.error);
        return res.status(403).json({
          success: false,
          error: videoQuota.error,
          videosRemaining: videoQuota.videosRemaining,
          videoMonthlyLimit: videoQuota.videoMonthlyLimit,
          step: 'video_quota'
        });
      }

      if (!imageUrl) {
        testProgressEmitter.emitProgress(userId, agentId, 'error', `${platformDisplayName} requires an image for video generation — none found`);
        return res.status(400).json({
          success: false,
          error: `${platformDisplayName} requires an image to generate a video. No media was found for this article.`,
          step: 'video_generation'
        });
      }

      testProgressEmitter.emitProgress(userId, agentId, 'video_generation', 'Generating video from article image...');
      console.log(`[Agent Test] Generating video for ${platformDisplayName}...`);

      try {
        const ContentGenerator = (await import('../services/ContentGenerator.js')).default;
        const contentGen = new ContentGenerator();
        const videoPrompt = await contentGen.generateVideoPrompt(trendData, generatedContent.text, agentSettings, imageUrl);

        const videoGenerationService = (await import('../services/VideoGenerationService.js')).default;

        // ── Video generation with multi-level fallback cascade ──
        // Phase 1: Primary model + image (with rephrase retries)
        // Phase 2: Fallback model + same image (with 1 rephrase)
        // Phase 3: Alternative image from same article → primary model
        // Phase 4: Image from alternative article → primary model

        const MAX_CONTENT_FILTER_RETRIES = 2;
        let videoResult;
        let currentPrompt = videoPrompt;
        let primaryExhausted = false;

        // Phase 1: Primary model with rephrase retries
        for (let attempt = 0; attempt <= MAX_CONTENT_FILTER_RETRIES; attempt++) {
          try {
            videoResult = await videoGenerationService.generateVideo({
              imageUrl,
              prompt: currentPrompt
            });
            break; // Success — exit retry loop
          } catch (filterError) {
            if (filterError.isContentFilter && attempt < MAX_CONTENT_FILTER_RETRIES) {
              console.log(`[Agent Test] Video blocked by content filter (${filterError.model}) — rephrasing prompt (attempt ${attempt + 1}/${MAX_CONTENT_FILTER_RETRIES})...`);
              testProgressEmitter.emitProgress(userId, agentId, 'video_generation', `Video blocked by content filter — rephrasing prompt (attempt ${attempt + 1}/${MAX_CONTENT_FILTER_RETRIES})...`);

              currentPrompt = await contentGen.rephraseVideoPrompt(filterError.originalPrompt, trendData, { model: filterError.model, attemptNumber: attempt + 1 });
              console.log(`[Agent Test] Rephrased video prompt generated (${currentPrompt.length} chars)`);
              testProgressEmitter.emitProgress(userId, agentId, 'video_generation', `Retrying video generation with rephrased prompt (attempt ${attempt + 2})...`);
            } else if (filterError.isContentFilter) {
              primaryExhausted = true;
              break;
            } else {
              throw filterError; // Non-filter errors propagate immediately
            }
          }
        }

        // Phase 2: Fallback model with same image (if primary model exhausted)
        if (primaryExhausted && !videoResult && videoGenerationService.hasFallback) {
          const fallbackModel = videoGenerationService.fallbackModel;
          console.log(`[Agent Test] Primary model exhausted — trying fallback model (${fallbackModel}) with same image...`);
          testProgressEmitter.emitProgress(userId, agentId, 'video_generation', `Trying fallback video model (${fallbackModel})...`);

          try {
            videoResult = await videoGenerationService.generateVideo({
              imageUrl,
              prompt: currentPrompt,
              useModel: fallbackModel
            });
          } catch (fallbackError) {
            if (fallbackError.isContentFilter) {
              // One rephrase attempt for fallback model
              console.log(`[Agent Test] Fallback model (${fallbackModel}) also blocked — rephrasing for fallback...`);
              testProgressEmitter.emitProgress(userId, agentId, 'video_generation', `Fallback model blocked — rephrasing prompt...`);
              try {
                const fallbackPrompt = await contentGen.rephraseVideoPrompt(fallbackError.originalPrompt, trendData, { model: fallbackModel, attemptNumber: 1 });
                videoResult = await videoGenerationService.generateVideo({
                  imageUrl,
                  prompt: fallbackPrompt,
                  useModel: fallbackModel
                });
              } catch (fallbackRetryError) {
                if (!fallbackRetryError.isContentFilter) throw fallbackRetryError;
                console.log(`[Agent Test] Fallback model (${fallbackModel}) rephrase also blocked — image likely triggers filter`);
              }
            } else {
              // Non-filter error on fallback (e.g. 429, missing key) — log and continue to Phase 3
              console.warn(`[Agent Test] Fallback model (${fallbackModel}) failed with non-filter error: ${fallbackError.message}`);
            }
          }
        }

        // Phase 3: Alternative image from same article
        if (!videoResult) {
          console.log(`[Agent Test] Both models failed with original image — searching for alternative image from same article...`);
          testProgressEmitter.emitProgress(userId, agentId, 'video_generation', 'Searching for alternative article image...');

          const altImageExtractor = new ImageExtractor();
          const altImageUrl = await altImageExtractor.extractAlternativeImage(
            trendData.url, trendData.title, trendData.source, imageUrl
          );

          if (altImageUrl) {
            console.log(`[Agent Test] Alternative image found: ${altImageUrl}`);
            testProgressEmitter.emitProgress(userId, agentId, 'video_generation', 'Retrying video with alternative image...');
            try {
              videoResult = await videoGenerationService.generateVideo({
                imageUrl: altImageUrl,
                prompt: currentPrompt
              });
            } catch (altImageError) {
              if (!altImageError.isContentFilter) throw altImageError;
              console.log(`[Agent Test] Alternative image also blocked by content filter`);
            }
          } else {
            console.log(`[Agent Test] No alternative image found in same article`);
          }
        }

        // Phase 4: Search for alternative article covering the same story
        if (!videoResult) {
          console.log(`[Agent Test] Searching for alternative article about same topic...`);
          testProgressEmitter.emitProgress(userId, agentId, 'video_generation', 'Searching alternative article source...');

          try {
            const ArticleSearcher = (await import('../services/ArticleSearcher.js')).default;
            const articleSearcher = new ArticleSearcher();
            const altArticleUrl = await articleSearcher.searchArticleByTitle(trendData.title, trendData.source);

            if (altArticleUrl && altArticleUrl !== trendData.url) {
              console.log(`[Agent Test] Found alternative article: ${altArticleUrl}`);
              const altExtractor = new ImageExtractor();
              const altArticleImage = await altExtractor.extractImageFromArticle(altArticleUrl, trendData.title, trendData.source);

              if (altArticleImage && altArticleImage !== imageUrl) {
                console.log(`[Agent Test] Alternative article image found: ${altArticleImage}`);
                testProgressEmitter.emitProgress(userId, agentId, 'video_generation', 'Retrying video with alternative article image...');
                try {
                  videoResult = await videoGenerationService.generateVideo({
                    imageUrl: altArticleImage,
                    prompt: currentPrompt
                  });
                } catch (altArticleError) {
                  if (!altArticleError.isContentFilter) throw altArticleError;
                  console.log(`[Agent Test] Alternative article image also blocked by content filter`);
                }
              } else {
                console.log(`[Agent Test] Alternative article yielded same or no image`);
              }
            } else {
              console.log(`[Agent Test] No alternative article found`);
            }
          } catch (searchError) {
            console.warn(`[Agent Test] Alternative article search failed: ${searchError.message}`);
          }
        }

        // All phases exhausted
        if (!videoResult) {
          throw new Error('Video generation failed — all models and image alternatives exhausted by content filters');
        }

        imageUrl = null; // TikTok doesn't use image directly — use video instead
        // Store video URL and pre-downloaded buffer on the content object for the publisher
        generatedContent.videoUrl = videoResult.videoUrl;
        generatedContent.videoBuffer = videoResult.videoBuffer || null;
        testProgressEmitter.emitProgress(userId, agentId, 'video_generation', `Video generated (${videoResult.model}, ${videoResult.duration}s)`);
        console.log(`[Agent Test] Video generated — model: ${videoResult.model}, duration: ${videoResult.duration}s`);

        // Decrement video quota after successful generation
        const { supabaseAdmin } = await import('../services/supabase.js');
        await supabaseAdmin.rpc('decrement_videos_remaining', { p_user_id: userId });
        req.user.subscription.videosRemaining = Math.max(0, (req.user.subscription.videosRemaining || 1) - 1);
        console.log(`[Agent Test] Video quota decremented — ${req.user.subscription.videosRemaining} videos remaining`);
      } catch (videoError) {
        console.error(`[Agent Test] Video generation error:`, videoError);
        const errorMsg = videoError.isContentFilter
          ? `Video blocked by content filter even after rephrasing: ${videoError.message}`
          : (videoError.message || 'Video generation failed');
        testProgressEmitter.emitProgress(userId, agentId, 'error', errorMsg);
        return res.status(500).json({
          success: false,
          error: errorMsg,
          step: 'video_generation'
        });
      }
    }

    // Step 3: Publish to the agent's platform
    console.log(`[Agent Test] Publishing to ${platform}...`);
    testProgressEmitter.emitProgress(userId, agentId, 'publishing', `Publishing to ${platformDisplayName}...`);

    let publishResult;
    const content = {
      text: generatedContent.text,
      trend: trendData.title,
      topic: selectedTopic,
      source: trendData,
      imageUrl: imageUrl,
      generatedAt: new Date().toISOString()
    };

    try {
      switch (platform) {
        case 'twitter':
          publishResult = await publishToTwitter(content, userId, imageUrl);
          break;
        case 'linkedin':
          publishResult = await publishToLinkedIn(content, userId, imageUrl);
          break;
        case 'reddit': {
          // Use subreddit and flair from agent settings
          const redditSubreddit = platformSettings.reddit?.subreddit || null;
          const redditFlairId = platformSettings.reddit?.flairId || null;
          publishResult = await publishToReddit(content, redditSubreddit, userId, redditFlairId, imageUrl);
          break;
        }
        case 'facebook':
          publishResult = await publishToFacebook(content, userId, imageUrl);
          break;
        case 'telegram':
          publishResult = await publishToTelegram(content, userId, imageUrl);
          break;
        case 'whatsapp':
          publishResult = await publishToWhatsApp(content, userId, imageUrl);
          break;
        case 'instagram':
          if (effectiveIgContentType === 'reels') {
            if (!generatedContent.videoUrl) {
              testProgressEmitter.emitProgress(userId, agentId, 'error', 'Instagram Reels requires a video — generation failed');
              return res.status(400).json({
                success: false,
                error: 'Instagram Reels requires a video but video generation was not completed.',
                step: 'publishing'
              });
            }
            content.videoUrl = generatedContent.videoUrl;
            publishResult = await publishToInstagram(content, userId, generatedContent.videoUrl, { contentType: 'reels', videoBuffer: generatedContent.videoBuffer });
          } else {
            if (!imageUrl) {
              testProgressEmitter.emitProgress(userId, agentId, 'error', 'Instagram requires an image — none found');
              return res.status(400).json({
                success: false,
                error: 'Instagram requires an image or video. No media was found for this article.',
                step: 'publishing'
              });
            }
            publishResult = await publishToInstagram(content, userId, imageUrl, { contentType: 'post' });
          }
          break;
        case 'threads':
          publishResult = await publishToThreads(content, userId, imageUrl);
          break;
        case 'tiktok':
          if (!generatedContent.videoUrl) {
            testProgressEmitter.emitProgress(userId, agentId, 'error', 'TikTok requires a video — generation failed');
            return res.status(400).json({
              success: false,
              error: 'TikTok requires a video but video generation was not completed.',
              step: 'publishing'
            });
          }
          content.videoUrl = generatedContent.videoUrl;
          publishResult = await publishToTikTok(content, userId, generatedContent.videoUrl, {
            videoBuffer: generatedContent.videoBuffer
          });
          break;
        case 'youtube':
          if (!generatedContent.videoUrl) {
            testProgressEmitter.emitProgress(userId, agentId, 'error', 'YouTube requires a video — generation failed');
            return res.status(400).json({
              success: false,
              error: 'YouTube requires a video but video generation was not completed.',
              step: 'publishing'
            });
          }
          content.videoUrl = generatedContent.videoUrl;
          publishResult = await publishToYouTube(content, userId, generatedContent.videoUrl, {
            videoBuffer: generatedContent.videoBuffer
          });
          break;
        default:
          testProgressEmitter.emitProgress(userId, agentId, 'error', `Platform ${platform} not yet supported`);
          return res.status(400).json({
            success: false,
            error: `Platform ${platform} not yet supported for publishing`,
            step: 'publishing'
          });
      }
    } catch (publishError) {
      console.error(`[Agent Test] Publishing error:`, publishError);
      testProgressEmitter.emitProgress(userId, agentId, 'error', publishError.message || 'Publishing failed');
      return res.status(500).json({
        success: false,
        error: publishError.message || 'Publishing failed',
        step: 'publishing'
      });
    }

    // Step 4: Record the post and update agent stats
    testProgressEmitter.emitProgress(userId, agentId, 'saving', 'Saving results...');
    const post = await createPost(userId, {
      topic: selectedTopic,
      content: generatedContent.text,
      platforms: [platform],
      status: publishResult?.success ? 'published' : 'failed',
      metadata: {
        tone,
        sourceUrl: trendData.url,
        trend: trendData.title,
        agentId: agent.id,
        agentName: agent.name,
        testPost: true
      }
    });

    // Increment agent's post count
    if (publishResult?.success) {
      try {
        await incrementAgentPost(agentId);
      } catch (e) {
        console.warn('[Agent Test] Failed to increment agent post count:', e);
      }
    }

    // Track article in dedup system so automation cycle won't reuse same article/topic
    try {
      const { supabaseAdmin } = await import('../services/supabase.js');
      const articleDedup = new ArticleDeduplicationService(supabaseAdmin);
      await articleDedup.markArticleUsed(agentId, {
        url: trendData.url,
        title: trendData.title || trendData.topic,
        description: trendData.description,
        publishedAt: trendData.publishedAt,
        source: trendData.source
      });
      console.log(`[Agent Test] Marked article in dedup system: "${trendData.title?.substring(0, 50)}..."`);
    } catch (e) {
      console.warn('[Agent Test] Failed to mark article in dedup system:', e.message);
    }

    // Mark test as used (one-time per agent) - do this regardless of success
    // This prevents abuse by repeatedly clicking the test button
    try {
      await markAgentTestUsed(agentId);
      console.log(`[Agent Test] Marked test as used for agent ${agentId}`);
    } catch (e) {
      console.warn('[Agent Test] Failed to mark test as used:', e);
    }

    // Log usage
    await logUsage(userId, 'agent_test_post', {
      agentId,
      platform,
      topic: selectedTopic,
      success: publishResult?.success || false
    });

    // Emit completion event for SSE subscribers
    testProgressEmitter.emitProgress(userId, agentId, 'complete',
      publishResult?.success ? `Published to ${platformDisplayName}!` : `Publishing to ${platformDisplayName} failed`
    );

    // Return result
    res.json({
      success: publishResult?.success || false,
      message: publishResult?.success
        ? `Successfully posted to ${platform}!`
        : `Failed to post to ${platform}`,
      agent: {
        id: agent.id,
        name: agent.name,
        platform
      },
      post: {
        id: post.id,
        topic: selectedTopic,
        content: generatedContent.text,
        tone,
        trend: trendData.title,
        videoUrl: generatedContent.videoUrl || null,
        articleUrl: trendData.url || null
      },
      result: publishResult,
      debug: {
        articleTitle: trendData.title,
        articleScore: trendData.calculatedScore?.toFixed(2) || 'N/A',
        articleUrl: trendData.url || 'none',
        imageUrl: imageUrl || 'none',
        userTier: userTier
      }
    });

  } catch (error) {
    console.error('[Agent Test] Error:', error);
    testProgressEmitter.emitProgress(userId, agentId, 'error', error.message || 'Test post failed');
    res.status(500).json({
      success: false,
      error: 'Test post failed',
      message: error.message,
      step: 'unknown'
    });
  }
});

/**
 * Test flow for affiliate product agents.
 * Mirrors AutomationManager.processAffiliateAgent() but with progress events and test recording.
 */
async function testAffiliateAgent(req, res, agent, settings, userId, agentId, platform) {
  const platformDisplayName = platform.charAt(0).toUpperCase() + platform.slice(1);
  const tone = settings.contentStyle?.tone || 'casual';

  try {
    // 1. Verify affiliate add-on is active
    testProgressEmitter.emitProgress(userId, agentId, 'trends', 'Checking affiliate subscription...');
    const addon = await getAffiliateAddon(userId);
    if (!addon || addon.status !== 'active') {
      testProgressEmitter.emitProgress(userId, agentId, 'error', 'Affiliate add-on not active');
      return res.status(400).json({
        success: false,
        error: 'Affiliate add-on is not active. Please activate it in your subscription settings.',
        step: 'settings'
      });
    }

    // 2. Load AE credentials
    const credentials = await AffiliateCredentialManager.getCredentials(userId);
    if (!credentials || credentials.status !== 'active') {
      testProgressEmitter.emitProgress(userId, agentId, 'error', 'AliExpress credentials not configured');
      return res.status(400).json({
        success: false,
        error: 'AliExpress API credentials are not configured or invalid. Set them up in the AE Affiliate tab.',
        step: 'settings'
      });
    }

    // 3. Connection health check
    testProgressEmitter.emitProgress(userId, agentId, 'connection_check', 'Verifying platform connection...');
    try {
      const connection = await TokenManager.getTokens(userId, platform);
      if (!connection || connection.status !== 'active') {
        testProgressEmitter.emitProgress(userId, agentId, 'error', `No active ${platform} connection`);
        return res.status(400).json({
          success: false,
          error: `No active ${platform} connection found. Please connect your account in Settings.`,
          step: 'connection'
        });
      }
      if (TokenManager.needsRefresh(connection)) {
        try { await ConnectionManager.refreshTokens(connection.id); }
        catch {
          testProgressEmitter.emitProgress(userId, agentId, 'error', `${platform} token expired`);
          return res.status(400).json({ success: false, error: `Your ${platform} token has expired and could not be refreshed.`, step: 'connection' });
        }
      }
    } catch (connError) {
      testProgressEmitter.emitProgress(userId, agentId, 'error', `${platform} connection credentials are invalid`);
      return res.status(400).json({ success: false, error: `Your ${platform} connection credentials are invalid. Please reconnect.`, step: 'connection' });
    }

    // 4. Fetch a product using the agent's keyword sets
    testProgressEmitter.emitProgress(userId, agentId, 'trends', 'Searching for affiliate products...');
    let product;
    try {
      product = await AffiliateProductFetcher.getProductForAgent(agent, credentials);
    } catch (fetchError) {
      console.error('[Agent Test/Affiliate] Product fetch error:', fetchError);
      testProgressEmitter.emitProgress(userId, agentId, 'error', 'Failed to fetch products');
      return res.status(500).json({
        success: false,
        error: `Failed to fetch affiliate products: ${fetchError.message}`,
        step: 'trends'
      });
    }

    if (!product) {
      testProgressEmitter.emitProgress(userId, agentId, 'error', 'No suitable product found');
      return res.status(400).json({
        success: false,
        error: 'No suitable products found for this agent\'s keywords. All matching products may have already been published, or the keywords returned no results.',
        step: 'trends'
      });
    }

    console.log(`[Agent Test/Affiliate] Selected product: "${product.title.slice(0, 60)}..." ($${product.salePrice})`);

    // 5. Generate affiliate content using the dedicated prompts
    testProgressEmitter.emitProgress(userId, agentId, 'generating', 'Generating affiliate post...');
    const contentGenerator = new ContentGenerator();
    const generatedContent = await contentGenerator.generateAffiliateContent(product, platform, agent.settings);

    if (!generatedContent || !generatedContent.text) {
      testProgressEmitter.emitProgress(userId, agentId, 'error', 'Failed to generate content');
      return res.status(500).json({ success: false, error: 'Failed to generate affiliate content', step: 'generation' });
    }

    // 6. Handle product image for platforms that support/require it
    let imageUrl = product.imageUrl || null;
    const userTier = req.user.subscription?.tier || 'free';

    // Instagram requires an image
    if (platform === 'instagram' && !imageUrl) {
      testProgressEmitter.emitProgress(userId, agentId, 'error', 'Instagram requires an image — product has none');
      return res.status(400).json({ success: false, error: 'Instagram requires an image. This product has no image available.', step: 'publishing' });
    }

    // Only send images for tiers that support it
    if (!TIERS_WITH_IMAGES.includes(userTier)) {
      imageUrl = null;
    }

    // 7. Publish
    testProgressEmitter.emitProgress(userId, agentId, 'publishing', `Publishing to ${platformDisplayName}...`);
    const content = {
      text: generatedContent.text,
      trend: product.title,
      topic: 'affiliate_product',
      source: { url: product.affiliateUrl, title: product.title },
      imageUrl,
      generatedAt: new Date().toISOString()
    };

    let publishResult;
    try {
      switch (platform) {
        case 'twitter':    publishResult = await publishToTwitter(content, userId, imageUrl); break;
        case 'linkedin':   publishResult = await publishToLinkedIn(content, userId, imageUrl); break;
        case 'reddit':     publishResult = await publishToReddit(content, settings.platformSettings?.reddit?.subreddit || null, userId, settings.platformSettings?.reddit?.flairId || null, imageUrl); break;
        case 'facebook':   publishResult = await publishToFacebook(content, userId, imageUrl); break;
        case 'telegram':   publishResult = await publishToTelegram(content, userId, imageUrl); break;
        case 'whatsapp':   publishResult = await publishToWhatsApp(content, userId, imageUrl); break;
        case 'instagram':  publishResult = await publishToInstagram(content, userId, imageUrl); break;
        case 'threads':    publishResult = await publishToThreads(content, userId, imageUrl); break;
        default:
          testProgressEmitter.emitProgress(userId, agentId, 'error', `Platform ${platform} not supported`);
          return res.status(400).json({ success: false, error: `Platform ${platform} not supported`, step: 'publishing' });
      }
    } catch (publishError) {
      console.error('[Agent Test/Affiliate] Publishing error:', publishError);
      testProgressEmitter.emitProgress(userId, agentId, 'error', publishError.message || 'Publishing failed');
      return res.status(500).json({ success: false, error: publishError.message || 'Publishing failed', step: 'publishing' });
    }

    // 8. Record post, update stats, record published product for dedup
    testProgressEmitter.emitProgress(userId, agentId, 'saving', 'Saving results...');
    const post = await createPost(userId, {
      topic: 'affiliate_product',
      content: generatedContent.text,
      platforms: [platform],
      status: publishResult?.success ? 'published' : 'failed',
      metadata: {
        tone,
        sourceUrl: product.affiliateUrl,
        trend: product.title,
        agentId: agent.id,
        agentName: agent.name,
        testPost: true,
        contentType: 'affiliate_product',
        productId: product.productId
      }
    });

    if (publishResult?.success) {
      try { await incrementAgentPost(agentId); } catch (e) { console.warn('[Agent Test/Affiliate] Failed to increment post count:', e); }
      try {
        await recordAffiliatePublishedProduct({
          userId, agentId: agent.id, productId: product.productId, platform,
          productTitle: product.title, productUrl: product.productUrl,
          affiliateUrl: product.affiliateUrl, commissionRate: product.commissionRate,
          salePrice: product.salePrice, imageUrl: product.imageUrl
        });
      } catch (e) { console.warn('[Agent Test/Affiliate] Failed to record published product:', e); }
    }

    try { await markAgentTestUsed(agentId); } catch (e) { console.warn('[Agent Test/Affiliate] Failed to mark test used:', e); }
    await logUsage(userId, 'agent_test_post', { agentId, platform, topic: 'affiliate_product', success: publishResult?.success || false });

    testProgressEmitter.emitProgress(userId, agentId, 'complete',
      publishResult?.success ? `Published to ${platformDisplayName}!` : `Publishing to ${platformDisplayName} failed`
    );

    return res.json({
      success: publishResult?.success || false,
      message: publishResult?.success ? `Successfully posted affiliate product to ${platform}!` : `Failed to post to ${platform}`,
      agent: { id: agent.id, name: agent.name, platform },
      post: {
        id: post.id,
        topic: 'affiliate_product',
        content: generatedContent.text,
        tone,
        trend: product.title,
        articleUrl: product.affiliateUrl
      },
      result: publishResult,
      debug: {
        productTitle: product.title,
        productPrice: `$${product.salePrice}`,
        productDiscount: `${product.discount}%`,
        imageUrl: imageUrl || 'none',
        userTier
      }
    });

  } catch (error) {
    console.error('[Agent Test/Affiliate] Error:', error);
    testProgressEmitter.emitProgress(userId, agentId, 'error', error.message || 'Test post failed');
    return res.status(500).json({ success: false, error: 'Test post failed', message: error.message, step: 'unknown' });
  }
}

/**
 * Test a brand voice agent — generates and publishes one post using the linked voice profile.
 */
async function testVoiceAgent(req, res, agent, settings, userId, agentId, platform) {
  const platformDisplayName = platform.charAt(0).toUpperCase() + platform.slice(1);
  const bvSettings = settings.brandVoiceSettings || {};

  try {
    // 1. Verify brand voice profile exists and is ready
    testProgressEmitter.emitProgress(userId, agentId, 'validating', 'Checking brand voice profile...');
    const { getBrandVoiceProfileById, insertBrandVoiceGeneratedPost, getSelectedAdAccount, getAssetImageGenCredits, consumeAssetImageGenCredit } = await import('../services/database-wrapper.js');
    const profile = await getBrandVoiceProfileById(bvSettings.profileId, userId);
    if (!profile || profile.status !== 'ready') {
      testProgressEmitter.emitProgress(userId, agentId, 'error', 'Brand voice profile not ready');
      return res.status(400).json({
        success: false,
        error: `Brand voice profile is not ready (status: ${profile?.status || 'not found'}). Complete the voice analysis first.`,
        step: 'settings'
      });
    }

    // 2. Connection health check
    testProgressEmitter.emitProgress(userId, agentId, 'connection_check', 'Verifying platform connection...');
    try {
      const connection = await TokenManager.getTokens(userId, platform);
      if (!connection || connection.status !== 'active') {
        testProgressEmitter.emitProgress(userId, agentId, 'error', `No active ${platform} connection`);
        return res.status(400).json({ success: false, error: `No active ${platform} connection found. Please connect your account in Settings.`, step: 'connection' });
      }
      if (TokenManager.needsRefresh(connection)) {
        try { await ConnectionManager.refreshTokens(connection.id); }
        catch {
          testProgressEmitter.emitProgress(userId, agentId, 'error', `${platform} token expired`);
          return res.status(400).json({ success: false, error: `Your ${platform} token has expired and could not be refreshed.`, step: 'connection' });
        }
      }
    } catch (connError) {
      testProgressEmitter.emitProgress(userId, agentId, 'error', `${platform} connection credentials are invalid`);
      return res.status(400).json({ success: false, error: `Your ${platform} connection credentials are invalid. Please reconnect.`, step: 'connection' });
    }

    // 3. Generate brand voice content
    testProgressEmitter.emitProgress(userId, agentId, 'generating', 'Generating brand voice post...');
    const BrandVoiceService = (await import('../services/BrandVoiceService.js')).default;
    const brandVoiceService = new BrandVoiceService();

    let generatedPosts;
    try {
      generatedPosts = await brandVoiceService.generateOriginalPost(userId, bvSettings.profileId, {
        platform,
        topic: bvSettings.direction || null,
        count: 1
      });
    } catch (genError) {
      console.error('[Agent Test/Voice] Content generation error:', genError);
      testProgressEmitter.emitProgress(userId, agentId, 'error', 'Content generation failed');
      return res.status(500).json({ success: false, error: `Brand voice content generation failed: ${genError.message}`, step: 'generation' });
    }

    const generatedPost = generatedPosts?.[0];
    if (!generatedPost?.text) {
      testProgressEmitter.emitProgress(userId, agentId, 'error', 'Content generation returned empty');
      return res.status(500).json({ success: false, error: 'Failed to generate brand voice content', step: 'generation' });
    }

    // 4. Handle image generation if configured
    let imageUrl = null;
    const userTier = req.user.subscription?.tier || 'free';

    if (bvSettings.generateWithImage && TIERS_WITH_IMAGES.includes(userTier)) {
      testProgressEmitter.emitProgress(userId, agentId, 'generating', 'Generating brand image...');
      try {
        const adAccount = await getSelectedAdAccount(userId);
        if (adAccount) {
          const { totalRemaining } = await getAssetImageGenCredits(userId);
          if (totalRemaining > 0) {
            const MediaAssetService = (await import('../services/MediaAssetService.js')).default;
            const mediaService = new MediaAssetService();
            const defaultJob = await mediaService.getDefaultTrainingJob(userId, adAccount.id);
            if (defaultJob) {
              const imagePrompt = await brandVoiceService.generateImagePrompt(
                generatedPost.text,
                defaultJob.trigger_word,
                profile.profile_data || {}
              );
              const generatedMedia = await mediaService.generateImage(userId, adAccount.id, imagePrompt, defaultJob.id);
              await consumeAssetImageGenCredit(userId);
              imageUrl = generatedMedia.public_url;
            } else {
              console.warn('[Agent Test/Voice] No trained model available — skipping image');
            }
          } else {
            console.warn('[Agent Test/Voice] No image credits — skipping image');
          }
        }
      } catch (imgError) {
        console.warn('[Agent Test/Voice] Image generation failed (continuing text-only):', imgError.message);
      }
    }

    // Instagram requires media
    if (platform === 'instagram' && !imageUrl) {
      testProgressEmitter.emitProgress(userId, agentId, 'error', 'Instagram requires an image');
      return res.status(400).json({ success: false, error: 'Instagram requires an image. Enable "Post + Image" and ensure you have a trained model and credits.', step: 'publishing' });
    }

    // 5. Handle video generation for video platforms
    let videoUrl = null;
    let videoBuffer = null;
    const VIDEO_PLATFORMS = ['tiktok', 'youtube'];
    const igContentTypes = settings.platformSettings?.instagram?.contentTypes || ['post'];
    const isVideoMode = VIDEO_PLATFORMS.includes(platform) || (platform === 'instagram' && igContentTypes.includes('reels'));

    if (isVideoMode && imageUrl) {
      testProgressEmitter.emitProgress(userId, agentId, 'video_generation', 'Generating video...');
      try {
        const videoQuota = await checkVideoQuota(userId, req.user.subscription);
        if (videoQuota.allowed) {
          const videoPrompt = await contentGenerator.generateVideoPrompt(
            { title: bvSettings.direction || profile.name, topic: bvSettings.direction || 'brand voice content' },
            generatedPost.text, settings, imageUrl
          );
          const VideoGenerationService = (await import('../services/VideoGenerationService.js')).default;
          const videoResult = await VideoGenerationService.generateVideo({ imageUrl, prompt: videoPrompt });
          videoUrl = videoResult.videoUrl;
          videoBuffer = videoResult.videoBuffer || null;

          const { supabaseAdmin } = await import('../services/supabase.js');
          await supabaseAdmin.rpc('decrement_videos_remaining', { p_user_id: userId });
        } else {
          console.warn('[Agent Test/Voice] Video quota exhausted');
        }
      } catch (videoError) {
        console.warn('[Agent Test/Voice] Video generation failed:', videoError.message);
      }
    }

    if (isVideoMode && !videoUrl && VIDEO_PLATFORMS.includes(platform)) {
      testProgressEmitter.emitProgress(userId, agentId, 'error', `${platformDisplayName} requires a video`);
      return res.status(400).json({ success: false, error: `${platformDisplayName} requires a video. Ensure "Post + Image" is enabled and video quota is available.`, step: 'publishing' });
    }

    // 6. Publish
    testProgressEmitter.emitProgress(userId, agentId, 'publishing', `Publishing to ${platformDisplayName}...`);
    const content = {
      text: generatedPost.text,
      trend: profile.name,
      topic: 'brand_voice',
      source: { url: null, title: profile.name },
      imageUrl,
      videoUrl,
      videoBuffer,
      generatedAt: new Date().toISOString()
    };
    if (platform === 'instagram') {
      content._igContentType = (isVideoMode && videoUrl) ? 'reels' : 'post';
    }

    let publishResult;
    try {
      switch (platform) {
        case 'twitter':    publishResult = await publishToTwitter(content, userId, imageUrl); break;
        case 'linkedin':   publishResult = await publishToLinkedIn(content, userId, imageUrl); break;
        case 'reddit':     publishResult = await publishToReddit(content, settings.platformSettings?.reddit?.subreddit || null, userId, settings.platformSettings?.reddit?.flairId || null, imageUrl); break;
        case 'facebook':   publishResult = await publishToFacebook(content, userId, imageUrl); break;
        case 'telegram':   publishResult = await publishToTelegram(content, userId, imageUrl); break;
        case 'whatsapp':   publishResult = await publishToWhatsApp(content, userId, imageUrl); break;
        case 'instagram':  publishResult = await publishToInstagram(content, userId, content._igContentType === 'reels' ? videoUrl : imageUrl, { contentType: content._igContentType, videoBuffer }); break;
        case 'threads':    publishResult = await publishToThreads(content, userId, imageUrl); break;
        case 'tiktok':     publishResult = await publishToTikTok(content, userId, videoUrl); break;
        case 'youtube':    publishResult = await publishToYouTube(content, userId, videoUrl); break;
        default:
          testProgressEmitter.emitProgress(userId, agentId, 'error', `Platform ${platform} not supported`);
          return res.status(400).json({ success: false, error: `Platform ${platform} not supported`, step: 'publishing' });
      }
    } catch (publishError) {
      console.error('[Agent Test/Voice] Publishing error:', publishError);
      testProgressEmitter.emitProgress(userId, agentId, 'error', publishError.message || 'Publishing failed');
      return res.status(500).json({ success: false, error: publishError.message || 'Publishing failed', step: 'publishing' });
    }

    // 7. Record post and update stats
    testProgressEmitter.emitProgress(userId, agentId, 'saving', 'Saving results...');
    const post = await createPost(userId, {
      topic: 'brand_voice',
      content: generatedPost.text,
      platforms: [platform],
      status: publishResult?.success ? 'published' : 'failed',
      metadata: {
        tone: 'brand_voice',
        agentId: agent.id,
        agentName: agent.name,
        testPost: true,
        contentType: 'brand_voice',
        profileId: bvSettings.profileId,
        profileName: profile.name,
        withImage: !!imageUrl
      }
    });

    if (publishResult?.success) {
      try { await incrementAgentPost(agentId); } catch (e) { console.warn('[Agent Test/Voice] Failed to increment post count:', e); }
      try {
        await insertBrandVoiceGeneratedPost(userId, bvSettings.profileId, {
          platform,
          topic: bvSettings.direction || null,
          content: generatedPost.text,
          image_url: imageUrl
        });
      } catch (e) { console.warn('[Agent Test/Voice] Failed to record generated post:', e); }
    }

    try { await markAgentTestUsed(agentId); } catch (e) { console.warn('[Agent Test/Voice] Failed to mark test used:', e); }
    await logUsage(userId, 'agent_test_post', { agentId, platform, topic: 'brand_voice', success: publishResult?.success || false });

    testProgressEmitter.emitProgress(userId, agentId, 'complete',
      publishResult?.success ? `Published to ${platformDisplayName}!` : `Publishing to ${platformDisplayName} failed`
    );

    return res.json({
      success: publishResult?.success || false,
      message: publishResult?.success ? `Successfully posted brand voice content to ${platform}!` : `Failed to post to ${platform}`,
      agent: { id: agent.id, name: agent.name, platform },
      post: {
        id: post.id,
        topic: 'brand_voice',
        content: generatedPost.text,
        tone: 'brand_voice',
        trend: profile.name,
        imageUrl: imageUrl || null
      },
      result: publishResult,
      debug: {
        profileName: profile.name,
        direction: bvSettings.direction || 'auto',
        withImage: !!imageUrl,
        userTier
      }
    });

  } catch (error) {
    console.error('[Agent Test/Voice] Error:', error);
    testProgressEmitter.emitProgress(userId, agentId, 'error', error.message || 'Test post failed');
    return res.status(500).json({ success: false, error: 'Test post failed', message: error.message, step: 'unknown' });
  }
}

/**
 * GET /api/agents/limits
 * Get agent limits for all tiers (for UI display)
 */
router.get('/limits/tiers', authenticateToken, async (req, res) => {
  res.json({
    success: true,
    limits: AGENT_LIMITS
  });
});

export default router;
