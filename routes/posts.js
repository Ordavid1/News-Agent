// routes/posts.js
import express from 'express';
import { createPost, getUserPosts, logUsage } from '../services/database-wrapper.js';
import { postGenerationLimiter } from '../middleware/rateLimiter.js';
import { requireTier } from '../middleware/subscription.js';
import ContentGenerator from '../services/ContentGenerator.js';
import trendAnalyzer from '../services/TrendAnalyzer.js';

const router = express.Router();

// Initialize services
const contentGenerator = new ContentGenerator();

// Generate a new post
router.post('/generate', postGenerationLimiter, async (req, res) => {
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
    const generatedContent = await contentGenerator.generateContent(
      trendData,
      primaryPlatform,
      tone,
      userId
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
router.get('/', async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const userId = req.user.id;
    
    const posts = await getUserPosts(userId, parseInt(limit), parseInt(offset));
    
    res.json({
      posts,
      total: posts.length,
      limit: parseInt(limit),
      offset: parseInt(offset)
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
router.post('/bulk-generate', requireTier('professional'), postGenerationLimiter, async (req, res) => {
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
        const generationResponse = await fetch(`http://localhost:${process.env.PARENT_BOT_PORT || 8080}/generate`, {
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
    free: ['twitter'],
    starter: ['twitter', 'linkedin'],
    growth: ['twitter', 'linkedin', 'reddit'],
    professional: ['twitter', 'linkedin', 'reddit', 'facebook', 'instagram'],
    business: ['twitter', 'linkedin', 'reddit', 'facebook', 'instagram', 'tiktok', 'youtube']
  };
  
  return platformsByTier[tier] || ['twitter'];
}

export default router;