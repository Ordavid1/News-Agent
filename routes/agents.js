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

    // When activating, verify agent has topics or keywords configured
    if (status === 'active') {
      const topics = agent.settings?.topics || [];
      const keywords = agent.settings?.keywords || [];
      if (topics.length === 0 && keywords.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Cannot activate agent without at least one topic or keyword configured'
        });
      }
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

    // ── Affiliate agent test flow ──
    const contentSource = settings.contentSource || 'news';
    if (contentSource === 'affiliate_products') {
      return await testAffiliateAgent(req, res, agent, settings, userId, agentId, platform);
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

    // Step 1: Fetch trends using agent's settings
    // If topics exist, pick one randomly; otherwise use keywords-only search with 'general' topic
    const searchTopics = topics.length > 0 ? [topics[Math.floor(Math.random() * topics.length)]] : ['general'];

    const selectedTopic = searchTopics[0];

    console.log(`[Agent Test] Fetching trends for ${topics.length > 0 ? 'topic: ' + selectedTopic : 'keywords only'}`);
    testProgressEmitter.emitProgress(userId, agentId, 'trends', 'Searching for trending news...');

    let trendData;
    try {
      const allTrends = await trendAnalyzer.getTrendsForTopics(searchTopics, {
        keywords,
        geoFilter
      });

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
        trendData = scored[0];

        console.log(`[Agent Test] Selected article: "${trendData.title}"`);
      } else {
        const searchDescription = topics.length > 0
          ? `topic "${searchTopics[0]}"${keywords.length > 0 ? ` with keywords "${keywords.join(', ')}"` : ''}`
          : `keywords "${keywords.join(', ')}"`;
        testProgressEmitter.emitProgress(userId, agentId, 'error', 'No trending news found');
        return res.status(400).json({
          success: false,
          error: `No news found for ${searchDescription}. Try different topics or keywords in agent settings.`,
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

    // Step 2.5: For video platforms (TikTok, YouTube) — check video quota then generate video from image + caption
    const VIDEO_PLATFORMS = ['tiktok', 'youtube'];
    if (VIDEO_PLATFORMS.includes(platform)) {
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

        const MAX_CONTENT_FILTER_RETRIES = 2;
        let videoResult;
        let currentPrompt = videoPrompt;
        let contentFilterExhausted = false;

        for (let attempt = 0; attempt <= MAX_CONTENT_FILTER_RETRIES; attempt++) {
          try {
            videoResult = await videoGenerationService.generateVideo({
              imageUrl,
              prompt: currentPrompt
            });
            break; // Success — exit retry loop
          } catch (filterError) {
            if (filterError.isContentFilter && attempt < MAX_CONTENT_FILTER_RETRIES) {
              // Content filter block — use LLM to rephrase the prompt and retry
              console.log(`[Agent Test] Video blocked by content filter (${filterError.model}) — rephrasing prompt (attempt ${attempt + 1}/${MAX_CONTENT_FILTER_RETRIES})...`);
              testProgressEmitter.emitProgress(userId, agentId, 'video_generation', `Video blocked by content filter — rephrasing prompt (attempt ${attempt + 1}/${MAX_CONTENT_FILTER_RETRIES})...`);

              currentPrompt = await contentGen.rephraseVideoPrompt(filterError.originalPrompt, trendData, { model: filterError.model, attemptNumber: attempt + 1 });
              console.log(`[Agent Test] Rephrased video prompt generated (${currentPrompt.length} chars)`);
              testProgressEmitter.emitProgress(userId, agentId, 'video_generation', `Retrying video generation with rephrased prompt (attempt ${attempt + 2})...`);
            } else if (filterError.isContentFilter) {
              contentFilterExhausted = true; // All rephrase retries exhausted
              break;
            } else {
              throw filterError; // Non-filter errors propagate immediately
            }
          }
        }

        // Final fallback: if all rephrase retries were blocked, the source IMAGE itself
        // is likely triggering the content filter. Try once more without the reference image.
        if (contentFilterExhausted && !videoResult) {
          console.log(`[Agent Test] All rephrase retries exhausted — source image likely triggers filter. Trying text-only video generation...`);
          testProgressEmitter.emitProgress(userId, agentId, 'video_generation', 'Source image may trigger filter — retrying without image...');

          videoResult = await videoGenerationService.generateVideo({
            imageUrl,
            prompt: currentPrompt,
            skipImage: true
          });
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
          if (!imageUrl) {
            testProgressEmitter.emitProgress(userId, agentId, 'error', 'Instagram requires an image — none found');
            return res.status(400).json({
              success: false,
              error: 'Instagram requires an image or video. No media was found for this article.',
              step: 'publishing'
            });
          }
          publishResult = await publishToInstagram(content, userId, imageUrl);
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
