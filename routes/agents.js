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
import { publishToTwitter, publishToLinkedIn, publishToReddit, publishToFacebook, publishToTelegram } from '../services/PublishingService.js';
import ImageExtractor from '../services/ImageExtractor.js';
import winston from 'winston';

// Tiers that have access to image extraction feature (Starter and above)
const TIERS_WITH_IMAGES = ['starter', 'growth', 'professional', 'business'];
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
  professional: 10,
  business: -1 // unlimited
};

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

    const agentConnectionIds = agents.map(a => a.connection_id);
    const availableConnections = connections
      .filter(c => c.status === 'active' && !agentConnectionIds.includes(c.id))
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
      validatedSettings = {
        topics: Array.isArray(settings.topics) ? settings.topics : [],
        keywords: Array.isArray(settings.keywords) ? settings.keywords.slice(0, 10) : [],
        geoFilter: {
          region: settings.geoFilter?.region ?? '',
          includeGlobal: settings.geoFilter?.includeGlobal ?? true
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
      const validatedSettings = {
        topics: Array.isArray(settings.topics) ? settings.topics : agent.settings?.topics || [],
        keywords: Array.isArray(settings.keywords) ? settings.keywords.slice(0, 10) : agent.settings?.keywords || [],
        geoFilter: {
          region: settings.geoFilter?.region ?? agent.settings?.geoFilter?.region ?? '',
          includeGlobal: settings.geoFilter?.includeGlobal ?? agent.settings?.geoFilter?.includeGlobal ?? true
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
 * POST /api/agents/:id/test
 * Test post for a specific agent using its settings
 * NOTE: Each agent can only use the Test button ONCE. This is persisted server-side.
 */
router.post('/:id/test', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const agentId = req.params.id;

  console.log(`[Agent Test] Starting test for agent ${agentId}, user ${userId}`);

  try {
    // Get agent
    const agent = await getAgentById(agentId);

    if (!agent) {
      return res.status(404).json({
        success: false,
        error: 'Agent not found'
      });
    }

    // Verify ownership
    if (agent.user_id !== userId) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    // Check if test was already used (one-time test per agent)
    if (agent.test_used_at) {
      return res.status(403).json({
        success: false,
        error: 'Test already used for this agent. Each agent can only be tested once.',
        step: 'test_limit',
        testUsedAt: agent.test_used_at
      });
    }

    // Check agent status
    if (agent.status !== 'active') {
      return res.status(400).json({
        success: false,
        error: 'Agent is paused. Activate it first to test.',
        step: 'status'
      });
    }

    // Check user's daily post limit
    const postsRemaining = req.user.subscription?.postsRemaining ?? 0;
    if (postsRemaining <= 0) {
      return res.status(403).json({
        success: false,
        error: 'Daily post limit reached',
        step: 'quota'
      });
    }

    // Get agent settings
    const settings = agent.settings || {};
    const topics = settings.topics || ['technology'];
    const keywords = settings.keywords || [];
    const geoFilter = settings.geoFilter || {};
    const tone = settings.contentStyle?.tone || 'professional';
    const platform = agent.platform;
    const platformSettings = settings.platformSettings || {};

    console.log(`[Agent Test] Agent settings:`, { topics, keywords, geoFilter, tone, platform, platformSettings });

    // Step 1: Fetch trends using agent's settings
    const selectedTopic = topics[Math.floor(Math.random() * topics.length)] || 'technology';

    console.log(`[Agent Test] Fetching trends for topic: ${selectedTopic}`);

    let trendData;
    try {
      const allTrends = await trendAnalyzer.getTrendsForTopics([selectedTopic], {
        keywords,
        geoFilter
      });

      if (allTrends && allTrends.length > 0) {
        // Use AutomationManager's scoring if available
        const automationManager = req.app.locals.automationManager;
        trendData = automationManager
          ? await automationManager.selectBestAINews(allTrends)
          : allTrends[0];

        if (!trendData) trendData = allTrends[0];
        console.log(`[Agent Test] Selected article: "${trendData.title}"`);
      } else {
        return res.status(400).json({
          success: false,
          error: `No news found for topic "${selectedTopic}". Try different topics in agent settings.`,
          step: 'trends'
        });
      }
    } catch (trendError) {
      console.error('[Agent Test] Trend fetch error:', trendError);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch trends',
        message: trendError.message,
        step: 'trends'
      });
    }

    // Step 2: Generate content
    console.log(`[Agent Test] Generating content for ${platform} with tone: ${tone}`);

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
      return res.status(500).json({
        success: false,
        error: 'Failed to generate content',
        step: 'generation'
      });
    }

    // Step 2.5: Extract image from article (Growth tier and above only)
    let imageUrl = null;
    const userTier = req.user.subscription?.tier || 'free';

    if (TIERS_WITH_IMAGES.includes(userTier)) {
      console.log(`[Agent Test] User tier "${userTier}" - extracting image from article...`);
      try {
        const imageExtractor = new ImageExtractor();
        imageUrl = await imageExtractor.extractImageFromArticle(
          trendData.url,
          trendData.title,
          trendData.source
        );

        if (imageUrl) {
          console.log(`[Agent Test] Image extracted: ${imageUrl}`);
        } else {
          console.log(`[Agent Test] No image found for article, continuing without image`);
        }
      } catch (imageError) {
        console.warn(`[Agent Test] Image extraction failed, continuing without image:`, imageError.message);
        imageUrl = null;
      }
    } else {
      console.log(`[Agent Test] User tier "${userTier}" - image extraction not available (Growth+ required)`);
    }

    // Step 3: Publish to the agent's platform
    console.log(`[Agent Test] Publishing to ${platform}...`);

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
          publishResult = await publishToTwitter(content, userId);
          break;
        case 'linkedin':
          publishResult = await publishToLinkedIn(content, userId);
          break;
        case 'reddit':
          // Use subreddit and flair from agent settings
          const redditSubreddit = platformSettings.reddit?.subreddit || null;
          const redditFlairId = platformSettings.reddit?.flairId || null;
          publishResult = await publishToReddit(content, redditSubreddit, userId, redditFlairId);
          break;
        case 'facebook':
          publishResult = await publishToFacebook(content, userId);
          break;
        case 'telegram':
          publishResult = await publishToTelegram(content, userId);
          break;
        default:
          return res.status(400).json({
            success: false,
            error: `Platform ${platform} not yet supported for publishing`,
            step: 'publishing'
          });
      }
    } catch (publishError) {
      console.error(`[Agent Test] Publishing error:`, publishError);
      return res.status(500).json({
        success: false,
        error: publishError.message || 'Publishing failed',
        step: 'publishing'
      });
    }

    // Step 4: Record the post and update agent stats
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
        trend: trendData.title
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
    res.status(500).json({
      success: false,
      error: 'Test post failed',
      message: error.message,
      step: 'unknown'
    });
  }
});

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
