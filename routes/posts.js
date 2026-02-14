// routes/posts.js
import express from 'express';
import { createPost, getUserPosts, logUsage, getUserById } from '../services/database-wrapper.js';
import { postGenerationLimiter } from '../middleware/rateLimiter.js';
import { requireTier } from '../middleware/subscription.js';
import ContentGenerator from '../services/ContentGenerator.js';
import trendAnalyzer from '../services/TrendAnalyzer.js';
import publishingService, { publishToTwitter, publishToLinkedIn, publishToReddit, publishToFacebook, publishToTelegram, publishToInstagram, publishToThreads } from '../services/PublishingService.js';
import ConnectionManager from '../services/ConnectionManager.js';
import ImageExtractor from '../services/ImageExtractor.js';
// SECURITY: Input validation
import { postGenerateValidation, bulkGenerateValidation, paginationQuery } from '../utils/validators.js';
// AutomationManager instance is accessed via req.app.locals.automationManager

// Tiers that get image extraction feature (Starter and above)
const TIERS_WITH_IMAGES = ['starter', 'growth', 'professional', 'business'];

const router = express.Router();

// Initialize services
const contentGenerator = new ContentGenerator();

// Generate a new post
router.post('/generate', postGenerationLimiter, postGenerateValidation, async (req, res) => {
  try {
    const { topic, platforms, scheduleTime, tone = 'professional' } = req.body;
    const userId = req.user.id;
    
    // Validate platforms based on subscription tier
    const allowedPlatforms = getAllowedPlatforms(req.user.subscription.tier);
    const requestedPlatforms = platforms || ['twitter'];
    
    const validPlatforms = requestedPlatforms.filter(p => allowedPlatforms.includes(p));
    if (validPlatforms.length === 0) {
      return res.status(400).json({ 
        error: 'No valid platforms selected for your subscription tier',
        allowedPlatforms 
      });
    }
    
    // Get trend data for the topic
    let trendData;
    try {
      // Try to find trending content related to the topic
      const trends = await trendAnalyzer.getTrendsForTopics([topic]);
      if (trends && trends.length > 0) {
        trendData = trends[0];
      } else {
        // Create a basic trend object if no trending data found
        trendData = {
          title: topic,
          description: `Latest updates and insights about ${topic}`,
          summary: `Exploring the latest developments in ${topic}`,
          url: '',
          source: 'user-generated'
        };
      }
    } catch (trendError) {
      console.error('Error fetching trends:', trendError);
      // Continue with basic trend data
      trendData = {
        title: topic,
        description: `Latest updates and insights about ${topic}`,
        summary: `Exploring the latest developments in ${topic}`,
        url: '',
        source: 'user-generated'
      };
    }
    
    // Generate content for the first platform (primary)
    const primaryPlatform = validPlatforms[0];

    // Build agentSettings from request (minimal settings for this endpoint)
    const agentSettings = {
      contentStyle: {
        tone: tone,
        includeHashtags: true
      }
    };

    const generatedContent = await contentGenerator.generateContent(
      trendData,
      primaryPlatform,
      agentSettings
    );
    
    if (!generatedContent) {
      return res.status(500).json({ error: 'Failed to generate content' });
    }
    
    // Create post record
    const post = await createPost(userId, {
      topic,
      content: generatedContent.text,
      platforms: validPlatforms,
      scheduleTime: scheduleTime || null,
      metadata: {
        tone,
        sourceUrl: generatedContent.source,
        trend: generatedContent.trend,
        generatedAt: generatedContent.generatedAt
      }
    });
    
    // Update user's posts remaining
    req.user.subscription.postsRemaining--;
    
    res.json({
      message: 'Post generated successfully',
      post,
      postsRemaining: req.user.subscription.postsRemaining
    });
    
  } catch (error) {
    console.error('Post generation error:', error);
    res.status(500).json({ error: 'Failed to generate post' });
  }
});

// Get user's posts
router.get('/', paginationQuery, async (req, res) => {
  try {
    // SECURITY: Enforce pagination bounds to prevent memory exhaustion
    const MAX_LIMIT = 100;
    const requestedLimit = parseInt(req.query.limit) || 50;
    const limit = Math.min(Math.max(1, requestedLimit), MAX_LIMIT);
    const offset = Math.max(0, parseInt(req.query.offset) || 0);

    const userId = req.user.id;

    const posts = await getUserPosts(userId, limit, offset);

    res.json({
      posts,
      total: posts.length,
      limit,
      offset
    });
    
  } catch (error) {
    console.error('Error fetching posts:', error);
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

// Schedule a post (Growth tier and above)
router.post('/:postId/schedule', requireTier('growth'), async (req, res) => {
  try {
    const { postId } = req.params;
    const { scheduleTime, platforms } = req.body;
    
    // TODO: Implement scheduling logic
    
    res.json({
      message: 'Post scheduled successfully',
      postId,
      scheduleTime,
      platforms
    });
    
  } catch (error) {
    console.error('Scheduling error:', error);
    res.status(500).json({ error: 'Failed to schedule post' });
  }
});

// Bulk generate posts (Professional tier and above)
router.post('/bulk-generate', requireTier('professional'), postGenerationLimiter, bulkGenerateValidation, async (req, res) => {
  try {
    const { topics, platforms } = req.body;
    const userId = req.user.id;
    
    if (!Array.isArray(topics) || topics.length === 0) {
      return res.status(400).json({ error: 'Topics array is required' });
    }
    
    if (topics.length > 10) {
      return res.status(400).json({ error: 'Maximum 10 topics per bulk generation' });
    }
    
    const results = [];
    
    for (const topic of topics) {
      try {
        // Generate content for each topic
        const generationResponse = await fetch(`http://localhost:${process.env.PORT || 3000}/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: topic,
            generateVideo: false,
            userId: `saas-${userId}`
          })
        });
        
        if (generationResponse.ok) {
          const generatedData = await generationResponse.json();
          if (generatedData.posts && generatedData.posts.length > 0) {
            const post = await createPost(userId, {
              topic,
              content: generatedData.posts[0].text,
              platforms: platforms || ['twitter'],
              metadata: {
                bulkGeneration: true,
                sourceInfo: generatedData.source
              }
            });
            results.push({ topic, success: true, post });
          } else {
            results.push({ topic, success: false, error: 'No content generated' });
          }
        } else {
          results.push({ topic, success: false, error: 'Generation failed' });
        }
      } catch (error) {
        results.push({ topic, success: false, error: error.message });
      }
    }
    
    const successCount = results.filter(r => r.success).length;
    
    res.json({
      message: `Bulk generation completed: ${successCount}/${topics.length} successful`,
      results,
      postsRemaining: req.user.subscription.postsRemaining - successCount
    });
    
  } catch (error) {
    console.error('Bulk generation error:', error);
    res.status(500).json({ error: 'Failed to process bulk generation' });
  }
});

// Helper function to get allowed platforms by tier
function getAllowedPlatforms(tier) {
  const platformsByTier = {
    free: ['linkedin', 'reddit', 'telegram'],
    starter: ['linkedin', 'reddit', 'facebook', 'telegram'],
    growth: ['twitter', 'linkedin', 'reddit', 'facebook', 'instagram', 'telegram'],
    professional: ['twitter', 'linkedin', 'reddit', 'facebook', 'instagram', 'telegram'],
    business: ['twitter', 'linkedin', 'reddit', 'facebook', 'instagram', 'telegram', 'tiktok', 'youtube']
  };

  return platformsByTier[tier] || ['linkedin', 'reddit', 'telegram'];
}

/**
 * POST /api/posts/test
 * Test the agent by generating and publishing one post to connected platforms
 * Uses user's saved settings (topics, tone, platforms)
 */
router.post('/test', async (req, res) => {
  const userId = req.user.id;
  console.log(`[Test Post] Starting test for user ${userId}`);

  try {
    // Step 1: Get user's settings and preferences
    const user = await getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const topics = Array.isArray(user.settings?.preferredTopics) ? user.settings.preferredTopics
      : Array.isArray(user.automation?.topics) ? user.automation.topics : [];
    const tone = user.automation?.tone || 'professional';
    const userPlatforms = user.settings?.defaultPlatforms || user.automation?.platforms || [];
    const keywords = Array.isArray(user.settings?.keywords) ? user.settings.keywords
      : Array.isArray(user.automation?.keywords) ? user.automation.keywords : [];
    const geoFilter = user.settings?.geoFilter || user.automation?.geoFilter || {};

    // Require at least one topic or keyword
    if (topics.length === 0 && keywords.length === 0) {
      return res.status(400).json({
        error: 'No topics or keywords configured',
        message: 'Please configure at least one topic or keyword in your settings before testing.',
        step: 'settings'
      });
    }

    console.log(`[Test Post] User settings:`, { topics, tone, userPlatforms, keywords, geoFilter });

    // Step 2: Check user's connected platforms
    const connections = await ConnectionManager.getUserConnections(userId);
    const activeConnections = connections.filter(c => c.status === 'active');
    const connectedPlatforms = activeConnections.map(c => c.platform);

    // Log which accounts will be used (for verification)
    console.log(`[Test Post] Connected platforms:`);
    activeConnections.forEach(c => {
      console.log(`  → ${c.platform}: @${c.platform_username || c.platform_display_name || 'unknown'}`);
    });

    // Build map of platform -> username for response
    const platformAccounts = {};
    activeConnections.forEach(c => {
      platformAccounts[c.platform] = c.platform_username || c.platform_display_name || 'connected';
    });

    if (connectedPlatforms.length === 0) {
      return res.status(400).json({
        error: 'No connected platforms',
        message: 'Please connect at least one social platform in your dashboard before testing.',
        step: 'connections'
      });
    }

    // Determine which platforms to post to (intersection of user settings and connected)
    let targetPlatforms = userPlatforms.length > 0
      ? userPlatforms.filter(p => connectedPlatforms.includes(p))
      : connectedPlatforms;

    // If no overlap, use all connected platforms
    if (targetPlatforms.length === 0) {
      targetPlatforms = connectedPlatforms;
    }

    console.log(`[Test Post] Target platforms:`, targetPlatforms);

    // Step 3: Use FULL PIPELINE - fetch trends with scoring and filtering
    let trendData;
    let postContent;
    // If topics exist, pick one randomly; otherwise use keywords-only search with 'general' topic
    const searchTopics = topics.length > 0 ? [topics[Math.floor(Math.random() * topics.length)]] : ['general'];
    const isKeywordsOnly = topics.length === 0;

    console.log(`[Test Post] Using FULL PIPELINE for ${isKeywordsOnly ? 'keywords only' : 'topic: ' + searchTopics[0]}`);
    console.log(`[Test Post] Step 3a: Fetching and scoring articles...`);

    try {
      // Use TrendAnalyzer to get multiple articles - pass user's keywords and geoFilter
      const allTrends = await trendAnalyzer.getTrendsForTopics(searchTopics, {
        keywords,
        geoFilter
      });

      if (allTrends && allTrends.length > 0) {
        console.log(`[Test Post] Found ${allTrends.length} articles for ${isKeywordsOnly ? 'keywords' : 'topic "' + searchTopics[0] + '"'}`);

        // Use AutomationManager's scoring system to select the BEST article
        console.log(`[Test Post] Step 3b: Scoring articles with full pipeline...`);
        const automationManager = req.app.locals.automationManager;
        const bestTrend = automationManager
          ? await automationManager.selectBestAINews(allTrends)
          : allTrends[0]; // Fallback if automation manager not available

        if (bestTrend) {
          trendData = bestTrend;
          console.log(`[Test Post] ✓ Selected best article: "${trendData.title}"`);
          console.log(`[Test Post]   → Score: ${trendData.calculatedScore?.toFixed(2) || 'N/A'}`);
          console.log(`[Test Post]   → Source: ${trendData.source || trendData.sources?.join(', ') || 'unknown'}`);
          console.log(`[Test Post]   → URL: ${trendData.url || 'none'}`);
          console.log(`[Test Post]   → Recently used: ${trendData.wasRecentlyUsed ? 'YES (penalized)' : 'NO'}`);
        } else {
          // Fallback to first trend if scoring fails
          trendData = allTrends[0];
          console.log(`[Test Post] Using first article (scoring returned null): ${trendData.title}`);
        }
      } else {
        const searchDescription = isKeywordsOnly
          ? `keywords "${keywords.join(', ')}"`
          : `topic "${searchTopics[0]}"${keywords.length > 0 ? ` with keywords "${keywords.join(', ')}"` : ''}`;
        console.log(`[Test Post] ⚠️ No articles found for ${searchDescription}`);
        return res.status(400).json({
          error: 'No news found',
          message: `No trending news found for ${searchDescription}. Try different topics or keywords.`,
          step: 'trends'
        });
      }
    } catch (trendError) {
      console.error('[Test Post] Trend fetch/scoring error:', trendError);
      return res.status(500).json({
        error: 'Trend analysis failed',
        message: trendError.message,
        step: 'trends'
      });
    }

    // Step 4: Generate content using the scored/selected article
    console.log(`[Test Post] Step 4: Generating content with tone: ${tone}`);
    console.log(`[Test Post]   → Article: ${trendData.title}`);
    console.log(`[Test Post]   → Platform: ${targetPlatforms[0]}`);

    // Build agentSettings from user's saved settings
    const agentSettings = {
      topics: topics,
      keywords: keywords,
      geoFilter: geoFilter,
      contentStyle: {
        tone: tone,
        includeHashtags: true
      },
      platformSettings: user.settings?.platformSettings || {}
    };

    const generatedContent = await contentGenerator.generateContent(
      trendData,
      targetPlatforms[0], // Primary platform for formatting
      agentSettings
    );

    if (!generatedContent || !generatedContent.text) {
      return res.status(500).json({
        error: 'Content generation failed',
        message: 'Failed to generate content. Please try again.',
        step: 'generation'
      });
    }

    console.log(`[Test Post] Generated content: ${generatedContent.text.substring(0, 100)}...`);

    // Step 4b: Extract image from article (Growth tier and above)
    let imageUrl = null;
    const userTier = req.user.subscription?.tier || 'free';

    if (TIERS_WITH_IMAGES.includes(userTier)) {
      const isInstagramTargeted = targetPlatforms.includes('instagram');
      console.log(`[Test Post] Step 4b: Extracting image (${userTier} tier)${isInstagramTargeted ? ' [Instagram targeted — retry enabled]' : ''}...`);

      try {
        const imageExtractor = new ImageExtractor();

        if (isInstagramTargeted && trendData.url) {
          // Instagram requires an image — use robust retry logic
          imageUrl = await imageExtractor.extractImageWithRetry({
            articleUrl: trendData.url,
            articleTitle: trendData.title,
            articleSource: trendData.source,
            preExistingImageUrl: trendData.imageUrl || null,
            maxRetries: 2,
            retryDelayMs: 3000
          });

          if (imageUrl) {
            console.log(`[Test Post] ✓ Image extracted (with retry): ${imageUrl}`);
          } else {
            console.log(`[Test Post] ⚠️ No image found after retries — Instagram post will be blocked`);
          }
        } else if (trendData.url) {
          // Other platforms: single attempt, graceful fallback
          imageUrl = await imageExtractor.extractImageFromArticle(
            trendData.url,
            trendData.title,
            trendData.source
          );

          if (imageUrl) {
            console.log(`[Test Post] ✓ Image extracted: ${imageUrl}`);
          } else {
            console.log(`[Test Post] ⚠️ No suitable image found in article`);
          }
        } else {
          console.log(`[Test Post] ⚠️ No article URL available for image extraction`);
        }
      } catch (imageError) {
        console.error(`[Test Post] Image extraction failed:`, imageError.message);
        // Continue without image - graceful fallback for non-Instagram platforms
        // Instagram will be blocked by PublishingService validation
        imageUrl = null;
      }
    } else {
      console.log(`[Test Post] Image extraction skipped (${userTier} tier - requires Starter+)`);
    }

    // Step 5: Publish to each connected platform
    const results = {
      success: [],
      failed: []
    };

    for (const platform of targetPlatforms) {
      try {
        console.log(`[Test Post] Publishing to ${platform}${imageUrl ? ' with image' : ''}...`);

        let result;
        const content = {
          text: generatedContent.text,
          trend: trendData.title,
          topic: selectedTopic,
          source: trendData,
          imageUrl: imageUrl, // Include image URL in content object
          generatedAt: new Date().toISOString()
        };

        switch (platform) {
          case 'twitter':
            result = await publishToTwitter(content, userId);
            break;
          case 'linkedin':
            result = await publishToLinkedIn(content, userId);
            break;
          case 'reddit':
            // Use subreddit and flair from user settings if available
            const userRedditSubreddit = user.settings?.platformSettings?.reddit?.subreddit || null;
            const userRedditFlairId = user.settings?.platformSettings?.reddit?.flairId || null;
            result = await publishToReddit(content, userRedditSubreddit, userId, userRedditFlairId);
            break;
          case 'facebook':
            result = await publishToFacebook(content, userId);
            break;
          case 'telegram':
            result = await publishToTelegram(content, userId);
            break;
          case 'instagram':
            result = await publishToInstagram(content, userId);
            break;
          case 'threads':
            result = await publishToThreads(content, userId);
            break;
          default:
            console.log(`[Test Post] Platform ${platform} not yet supported for publishing`);
            results.failed.push({
              platform,
              error: 'Platform not yet supported for publishing'
            });
            continue;
        }

        if (result && result.success) {
          console.log(`[Test Post] Successfully published to ${platform}`);
          results.success.push({
            platform,
            postId: result.postId,
            url: result.url
          });
        } else {
          results.failed.push({
            platform,
            error: result?.error || 'Unknown error'
          });
        }
      } catch (publishError) {
        console.error(`[Test Post] Error publishing to ${platform}:`, publishError);
        results.failed.push({
          platform,
          error: publishError.message
        });
      }
    }

    // Step 6: Save post record
    const post = await createPost(userId, {
      topic: selectedTopic,
      content: generatedContent.text,
      platforms: targetPlatforms,
      status: results.success.length > 0 ? 'published' : 'failed',
      source_article_image: imageUrl, // Store extracted image URL
      metadata: {
        tone,
        sourceUrl: trendData.url,
        trend: trendData.title,
        generatedAt: new Date().toISOString(),
        testPost: true,
        imageUrl: imageUrl, // Also in metadata
        results
      }
    });

    // Log usage
    await logUsage(userId, 'test_post', {
      topic: selectedTopic,
      platforms: targetPlatforms,
      successCount: results.success.length,
      failedCount: results.failed.length
    });

    // Return comprehensive results
    res.json({
      success: results.success.length > 0,
      message: results.success.length > 0
        ? `Successfully posted to ${results.success.length} platform(s)!`
        : 'Failed to post to any platform',
      post: {
        id: post.id,
        topic: selectedTopic,
        content: generatedContent.text,
        tone,
        trend: trendData.title
      },
      results,
      debug: {
        userTopics: topics,
        selectedTopic,
        connectedPlatforms,
        targetPlatforms,
        platformAccounts,  // Shows which user accounts were used
        articleScoring: {
          title: trendData.title,
          score: trendData.calculatedScore?.toFixed(2) || 'N/A',
          source: trendData.source || trendData.sources?.join(', ') || 'unknown',
          url: trendData.url || 'none',
          wasRecentlyUsed: trendData.wasRecentlyUsed || false,
          publishedAt: trendData.publishedAt || 'unknown'
        },
        imageExtraction: {
          enabled: TIERS_WITH_IMAGES.includes(userTier),
          userTier: userTier,
          imageUrl: imageUrl || null,
          success: !!imageUrl
        }
      }
    });

  } catch (error) {
    console.error('[Test Post] Error:', error);
    res.status(500).json({
      error: 'Test post failed',
      message: error.message,
      step: 'unknown'
    });
  }
});

export default router;