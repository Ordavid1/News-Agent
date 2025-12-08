// services/AutomationManager.js
import cron from 'node-cron';
import winston from 'winston';
// Import necessary modules
import RedditPublisher from '../publishers/RedditPublisher.js';
import TwitterPublisher from '../publishers/TwitterPublisher.js';
import LinkedInPublisher from '../publishers/LinkedInPublisher.js';
import DatabaseManager from './DatabaseManager.js';
import PostingStrategy from './PostingStrategy.js';
import CloudTasksQueue from './CloudTasksQueue.js';
// MockPublisher removed - SaaS mode requires user's own credentials, no fallbacks
import RateLimiter from './RateLimiter.js';
import trendAnalyzer from './TrendAnalyzer.js';
import '../config/env.js';  // This ensures dotenv loads first
import OpenAI from 'openai';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Initialize logger with Winston
const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[AutomationManager] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

class AutomationManager {
  constructor(db) {
    this.isEnabled = process.env.AUTOMATION_ENABLED === 'true';
    this.db = db;
    
    // Initialize services
    this.dbManager = new DatabaseManager(this.db);
    this.postingStrategy = new PostingStrategy(this.db);
    this.taskQueue = new CloudTasksQueue();
    this.rateLimiter = new RateLimiter();
    
    // Initialize publishers - SaaS mode: only initialize when user has credentials
    this.publishers = {};

    logger.info('Publisher initialization (SaaS mode - no mock fallbacks):');

    // Initialize Twitter if credentials present
    if (process.env.TWITTER_ACCESS_TOKEN) {
      this.publishers.twitter = new TwitterPublisher();
      logger.info('✅ Twitter publisher initialized');
    } else {
      logger.info('⚠️ Twitter: No credentials configured');
    }

    // Initialize LinkedIn if credentials present
    if (process.env.LINKEDIN_ACCESS_TOKEN) {
      this.publishers.linkedin = new LinkedInPublisher();
      logger.info('✅ LinkedIn publisher initialized');
    } else {
      logger.info('⚠️ LinkedIn: No credentials configured');
    }

    // Initialize Reddit if all credentials present
    if (process.env.REDDIT_CLIENT_ID &&
        process.env.REDDIT_CLIENT_SECRET &&
        process.env.REDDIT_USERNAME &&
        process.env.REDDIT_PASSWORD) {
      this.publishers.reddit = new RedditPublisher();
      logger.info('✅ Reddit publisher initialized');
      logger.info(`   Target subreddit: r/${process.env.REDDIT_SUBREDDIT}`);
    } else {
      const missing = [];
      if (!process.env.REDDIT_CLIENT_ID) missing.push('REDDIT_CLIENT_ID');
      if (!process.env.REDDIT_CLIENT_SECRET) missing.push('REDDIT_CLIENT_SECRET');
      if (!process.env.REDDIT_USERNAME) missing.push('REDDIT_USERNAME');
      if (!process.env.REDDIT_PASSWORD) missing.push('REDDIT_PASSWORD');
      logger.info(`⚠️ Reddit: Missing credentials (${missing.join(', ')})`);
    }

    const initializedPlatforms = Object.keys(this.publishers);
    if (initializedPlatforms.length > 0) {
      logger.info(`✅ Active publishers: ${initializedPlatforms.join(', ')}`);
    } else {
      logger.warn('⚠️ No publishers initialized - configure platform credentials to enable posting');
    }
    
    // Add after this.isEnabled check
    if (this.isEnabled) {
      // Log timezone info for debugging
      logger.info(`🕐 Server timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
      logger.info(`🕐 Current server time: ${new Date().toISOString()}`);
      
      this.initializeSchedules();
      logger.info('🤖 Automation Manager initialized and running');
    }
  }

  initializeSchedules() {
    logger.info('📅 Initializing scheduled tasks...');
    
    // Reddit - Between 7am-midnight Central Time, every hour (17-hour window)
    // Central Time is UTC-6 (or UTC-5 during DST)
    // 7am-midnight CT = 17 posts per day
    // Using specific hours to ensure Central Time compliance
    cron.schedule('0 7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23 * * *', () => {
      logger.info('Running Reddit post (Central Time 7am-midnight window)...');
      this.executeRedditPost();
    }, {
      timezone: "America/Chicago" // Central Time
    });
    
    // LinkedIn - Focus on Generative AI news (check every 4 hours)
    cron.schedule('0 */4 * * *', () => {
      logger.info('Running LinkedIn Generative AI post generation...');
      this.executeLinkedInAIPost();
    });
    
    // Twitter - check every 12 hours for posting opportunities
    cron.schedule('0 */12 * * *', () => {
      logger.info('Running Twitter post check...');
      this.executeAutomatedPost({ 
        preferredPlatforms: ['twitter'], 
        requireHighValue: false,
        minTrendScore: 50
      });
    });
    
    
    // Rate limiter cleanup
    cron.schedule('0 0 * * *', () => {
      this.rateLimiter.cleanup();
    });
    
    // Daily analytics at 11 PM
    cron.schedule('0 23 * * *', () => {
      logger.info('Running daily analytics...');
      this.generateDailyReport();
    });
    
    // Clean up old data weekly
    cron.schedule('0 0 * * 0', () => {
      logger.info('Running weekly maintenance...');
      this.performMaintenance();
    });
    
    logger.info('📅 Scheduled tasks initialized');
    logger.info('📍 Reddit posts scheduled for 7am-midnight Central Time');
    logger.info('📊 Schedule Summary:');
    logger.info('  - Reddit: Every hour 7am-11pm CT (17 posts/day)');
    logger.info('  - LinkedIn Gen AI: Every 4 hours (6 posts/day)');
    logger.info('  - Twitter: Every 12 hours (2 posts/day)');
  }

// The executeAutomatedPost method
async executeAutomatedPost(options = {}) {
  try {
    const { 
      preferredPlatforms = [], 
      requireHighValue = false,
      minTrendScore = 60,
      preferredCategories = []
    } = options;
    
    logger.info('🚀 Starting automated post generation...');
    logger.info(`Options: ${JSON.stringify(options)}`);
    
    // Get rate limit status
    const rateLimitStatus = this.rateLimiter.getUsageStats();
    logger.info('Rate limit status:', JSON.stringify(rateLimitStatus, null, 2));
    
    // Get a list of potential trends
    let availableTrends = [];
    let trendRetries = 3;
    
    while (availableTrends.length === 0 && trendRetries > 0) {
      try {
        // Get more trends than needed so we have backups
        const trends = await this.postingStrategy.getOptimalTrend({
          preferredCategory: preferredCategories[0] || null,
          excludeCategories: [],
          cacheTrends: false,
          returnMultiple: true
        });
        
        // Handle both single trend and array of trends
        if (Array.isArray(trends)) {
          availableTrends = trends;
        } else if (trends) {
          availableTrends = [trends];
        }
        
        if (availableTrends.length === 0) {
          logger.warn(`No suitable trends found (attempt ${4 - trendRetries}/3)`);
          trendRetries--;
          if (trendRetries > 0) {
            await new Promise(resolve => setTimeout(resolve, 5000));
          }
        }
      } catch (error) {
        logger.error(`Error getting trends (attempt ${4 - trendRetries}/3):`, error);
        trendRetries--;
        if (trendRetries > 0) {
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
    }
    
    if (availableTrends.length === 0) {
      logger.error('❌ Failed to find any suitable trends after 3 attempts');
      await this.logError(new Error('No suitable trends found'));
      return {
        success: false,
        error: 'No suitable trends found'
      };
    }
    
    logger.info(`Found ${availableTrends.length} potential trends to try`);
    
    // Try each trend until we successfully generate content
    let postContent = null;
    let selectedTrend = null;
    let attemptedTrends = [];
    
    for (const trend of availableTrends) {
      // Check if trend meets minimum score requirement
      if (minTrendScore && trend.score < minTrendScore) {
        logger.warn(`Trend "${trend.topic}" score ${trend.score} below minimum ${minTrendScore}`);
        if (requireHighValue) {
          continue; // Skip this trend
        }
      }
      
      logger.info(`Attempting to generate content for trend: "${trend.topic}" (score: ${trend.score})`);
      attemptedTrends.push(trend.topic);
      
      try {
        postContent = await this.generatePostForTrend(trend);
        
        if (postContent && postContent.posts && postContent.posts.length > 0) {
          selectedTrend = trend;
          logger.info(`✅ Successfully generated content for trend: "${trend.topic}"`);
          break; // Success! Exit the loop
        } else {
          logger.warn(`No content generated for trend "${trend.topic}", trying next trend...`);
        }
      } catch (error) {
        logger.error(`Error generating content for trend "${trend.topic}":`, error.message);
      }
    }
    
    if (!postContent || !selectedTrend) {
      logger.error(`❌ Failed to generate content for any of the ${attemptedTrends.length} trends tried`);
      logger.error(`Attempted trends: ${attemptedTrends.join(', ')}`);
      return {
        success: false,
        error: 'No content could be generated for any available trends',
        attemptedTrends
      };
    }
    
    logger.info('✅ Post content generated successfully');
    
    // Determine platforms based on strategy and preferences
    let targetPlatforms = await this.postingStrategy.selectPlatforms(selectedTrend);
    
    // Apply preferences if provided
    if (preferredPlatforms.length > 0) {
      targetPlatforms = targetPlatforms.filter(p => preferredPlatforms.includes(p));
      if (targetPlatforms.length === 0 && preferredPlatforms.includes('reddit')) {
        targetPlatforms = ['reddit'];
      }
    }
    
    // Apply rate limit filtering
    targetPlatforms = await this.filterByRateLimits(targetPlatforms, preferredPlatforms);
    
    if (targetPlatforms.length === 0) {
      logger.warn('No platforms available due to rate limits');
      return {
        success: false,
        error: 'All platforms rate limited',
        rateLimitStatus
      };
    }
    
    logger.info(`📱 Target platforms after filtering: ${targetPlatforms.join(', ')}`);
    
    // Create scheduled post record
    const scheduledPost = {
      trend: selectedTrend,
      content: postContent,
      platforms: targetPlatforms,
      scheduledTime: new Date()
    };
    
    // Save to database
    const postId = await this.dbManager.saveScheduledPost(scheduledPost);
    scheduledPost.id = postId;
    logger.info(`💾 Scheduled post saved with ID: ${postId}`);
    
    // Publish immediately
    let publishResults = [];
    
    if (process.env.USE_CLOUD_TASKS === 'true') {
      logger.info('📋 Adding post to Cloud Tasks queue...');
      await this.taskQueue.addPostTask(scheduledPost);
      publishResults = [{
        platform: 'cloud_tasks',
        success: true,
        message: 'Post queued for publishing'
      }];
    } else {
      logger.info('📤 Publishing immediately...');
      publishResults = await this.publishScheduledPost(scheduledPost);
    }
    
    // Mark trend as used
    await this.postingStrategy.markTrendAsUsed(selectedTrend);
    
    // Log results
    const successCount = publishResults.filter(r => r.success).length;
    const failureCount = publishResults.filter(r => !r.success).length;
    
    logger.info(`📊 Publishing complete: ${successCount} successful, ${failureCount} failed`);
    
    return {
      success: successCount > 0,
      trend: selectedTrend.topic,
      platforms: targetPlatforms,
      results: publishResults,
      postId: postId,
      summary: {
        requested: targetPlatforms.length,
        successful: successCount,
        failed: failureCount,
        trendsAttempted: attemptedTrends.length
      }
    };
    
  } catch (error) {
    logger.error('❌ Automated posting failed:', error);
    await this.logError(error);
    
    return {
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    };
  }
}

// New method specifically for Reddit posts
async executeRedditPost() {
  try {
    // Check if we're in the allowed time window (redundant check but good for logging)
    const now = new Date();
    const centralTime = new Date(now.toLocaleString("en-US", {timeZone: "America/Chicago"}));
    const hour = centralTime.getHours();
    
    if (hour < 7 || hour > 23) {
      logger.warn(`Reddit post called outside allowed hours. Current CT hour: ${hour}`);
      return { success: false, error: 'Outside allowed posting hours' };
    }
    
    logger.info(`🔴 Starting Reddit post (${hour}:00 Central Time)...`);
    
    // Check if we've already posted this hour
    const lastRedditPost = await this.postingStrategy.getLastPlatformPostFromDB('reddit');
    const hoursSinceLastPost = (Date.now() - lastRedditPost) / (1000 * 60 * 60);
    
    if (hoursSinceLastPost < 0.9) { // 0.9 to account for slight timing variations
      logger.info(`Already posted to Reddit ${hoursSinceLastPost.toFixed(2)} hours ago, skipping`);
      return { success: false, error: 'Already posted this hour' };
    }
    
    // Execute the post with Reddit preference
    const result = await this.executeAutomatedPost({ 
      preferredPlatforms: ['reddit'],
      requireHighValue: false,
      minTrendScore: 40, // Lower threshold for Reddit
      preferredCategories: [] // All categories for Reddit
    });
    
    if (result.success) {
      logger.info(`✅ Reddit post completed successfully at ${hour}:00 CT`);
    } else {
      logger.warn(`❌ Reddit post failed at ${hour}:00 CT: ${result.error}`);
    }
    
    return result;
    
  } catch (error) {
    logger.error('Reddit posting failed:', error);
    return { success: false, error: error.message };
  }
}

async executeLinkedInAIPost() {
  try {
    logger.info('🤖 Starting LinkedIn Generative AI post generation...');
    
    // First try to get Gen AI news
    const genAINews = await trendAnalyzer.getGenerativeAINews(24);
    
    // If no Gen AI specific news, try aggregated trends filtered for AI
    if (!genAINews || genAINews.length === 0) {
      logger.info('No Gen AI news found, checking aggregated trends for AI content...');
      
      // Get all trends and filter for Gen AI
      const allTrends = await trendAnalyzer.getAggregatedTrends({
        sources: ['twitter', 'google', 'reddit'],
        limit: 100
      });
      
      // Filter for Gen AI content - FIX: Add null check
      const aiTrends = allTrends.filter(trend => {
        if (!trend || !trend.topic) return false;
        return this.postingStrategy.isGenerativeAITrend(trend);
      });
      
      if (aiTrends.length === 0) {
        logger.warn('No Generative AI trends found from any source');
        return { success: false, error: 'No Gen AI content available' };
      }
      
      // Convert to news format - FIX: Add null checks
      genAINews = aiTrends.map(trend => ({
        topic: trend.topic || '',
        title: trend.title || trend.topic || '',
        description: trend.description || trend.metadata?.description || '',
        url: trend.url || trend.metadata?.url || '',
        publishedAt: trend.publishedAt || trend.metadata?.timestamp || new Date().toISOString(),
        query: trend.query || '',
        volume: trend.volume || 0,
        confidence: trend.confidence || 0.5,
        metadata: trend.metadata || {},
        sources: Array.isArray(trend.sources) ? trend.sources : ['unknown']
      }));
    }
    
    logger.info(`Found ${genAINews.length} Gen AI items from various sources`);
    
    // Select the best one based on multiple factors
    const selectedNews = await this.selectBestAINews(genAINews);
    
    if (!selectedNews) {
      logger.error('Could not select suitable AI news');
      return { success: false, error: 'No suitable AI news found' };
    }

    // Ensure URL exists
    if (!selectedNews.url && !selectedNews.metadata?.url && !selectedNews.metadata?.originalUrl) {
      logger.error('Selected news item missing URL:', selectedNews);
      // Try to find a URL in the metadata
      const possibleUrl = selectedNews.metadata?.articles?.[0]?.url || 
                          selectedNews.metadata?.articles?.[0]?.link ||
                          '';
      if (possibleUrl) {
        selectedNews.url = possibleUrl;
        logger.info('Recovered URL from metadata:', possibleUrl);
      } else {
        return { success: false, error: 'No URL found for selected news' };
      }
    }
    
    // Create a trend object that preserves all the original data
    const aiTrend = {
      ...selectedNews, // Spread all properties
      score: this.calculateAINewsScore(selectedNews), // Calculate score dynamically
      sources: Array.isArray(selectedNews.sources) ? selectedNews.sources : ['unknown'],
      // Ensure metadata is properly structured
      metadata: {
        ...(selectedNews.metadata || {}),
        // Add scoreBreakdown with all defined values
        scoreBreakdown: {
          confidence: (selectedNews.confidence || 0.5) * 100,
          sources: Array.isArray(selectedNews.sources) ? selectedNews.sources.length : 1,
          volume: selectedNews.volume || 0,
          category: 'generative_ai',
          recentUsageCount: 0,
          wasRecentlyUsed: false,
          usagePenalty: 1.0
        }
      }
    };
    
    logger.info(`Selected Gen AI news: "${aiTrend.topic}" from sources: ${aiTrend.sources.join(', ')}`);
    
    // Generate LinkedIn-specific content
    const postContent = await this.generateLinkedInAIPost(aiTrend);
    
    if (!postContent) {
      logger.error('Failed to generate LinkedIn content');
      return { success: false, error: 'Content generation failed' };
    }
    
    // Create scheduled post
    const scheduledPost = {
      trend: aiTrend,
      content: postContent,
      platforms: ['linkedin'],
      scheduledTime: new Date()
    };
    
    // Save to database
    const postId = await this.dbManager.saveScheduledPost(scheduledPost);
    scheduledPost.id = postId;
    
    // Publish immediately
    const publishResults = await this.publishScheduledPost(scheduledPost);
    
    // Only mark as used if it has the required fields
    if (aiTrend.score !== undefined) {
      await this.postingStrategy.markTrendAsUsed(aiTrend);
    }
    
    const success = publishResults.some(r => r.success);
    logger.info(`LinkedIn Gen AI post ${success ? 'succeeded' : 'failed'}`);
    
    return {
      success,
      trend: aiTrend.topic,
      sources: aiTrend.sources,
      results: publishResults
    };
    
  } catch (error) {
    logger.error('LinkedIn AI posting failed:', error);
    return { success: false, error: error.message };
  }
}

// Smart selection method - handles both getTrendsForTopics and getGenerativeAINews formats
async selectBestAINews(newsItems) {
  if (!newsItems || newsItems.length === 0) return null;

  // Check recently used topics from the database
  const recentlyUsed = await this.getRecentlyUsedAITopics(24); // Last 24 hours

  // Score each news item based on multiple factors
  const scoredItems = newsItems.map(item => {
    let score = 0;

    // IMPORTANT: Handle different field names from different sources
    // getTrendsForTopics uses: title, source (string), topic (search term)
    // getGenerativeAINews uses: topic (title), sources (array)
    const itemTitle = item.title || item.topic || '';
    const itemTopic = item.title || item.topic || ''; // Use title as the key identifier
    const itemSources = Array.isArray(item.sources) ? item.sources : (item.source ? [item.source] : []);
    const itemConfidence = item.confidence || item.score / 100 || 0.5;
    const itemEngagement = item.engagement || {};

    // Skip items without a title/topic
    if (!itemTitle) {
      logger.warn('News item missing title/topic:', item);
      return { ...item, calculatedScore: 0, wasRecentlyUsed: false };
    }

    // PENALTY for recently used topics
    const topicKey = itemTitle.toLowerCase().slice(0, 50);
    const wasRecentlyUsed = recentlyUsed.some(used => {
      if (!used || typeof used !== 'string') return false;

      const usedLower = used.toLowerCase();
      const topicLower = itemTitle.toLowerCase();

      // Check for similar content patterns
      return (usedLower.includes('gemini') && topicLower.includes('gemini')) ||
             (usedLower.includes('gpt') && topicLower.includes('gpt')) ||
             (usedLower.includes('openai') && topicLower.includes('openai')) ||
             (usedLower.slice(0, 50) === topicKey);
    });

    if (wasRecentlyUsed) {
      score -= 100; // Heavy penalty for recently used topics
      logger.debug(`Penalizing recently used topic: "${itemTitle.slice(0, 80)}..."`);
    }

    // Recency score (more recent = higher score)
    let ageInHours = 24; // Default to 24 hours old if no date
    if (item.publishedAt) {
      const publishedTime = new Date(item.publishedAt).getTime();
      if (!isNaN(publishedTime)) {
        ageInHours = (Date.now() - publishedTime) / (1000 * 60 * 60);
      }
    }
    // Recency bonus: 0-1 hour = 100pts, 6 hours = 76pts, 12 hours = 52pts, 24 hours = 4pts
    score += Math.max(0, 100 - (ageInHours * 4));

    // Source credibility score
    const trustedSources = ['reuters', 'associated press', 'bbc', 'financial times', 'techcrunch',
                            'the verge', 'wired', 'ars technica', 'bloomberg', 'new york times',
                            'business insider', 'cbs news', 'cnbc'];
    const sourceStr = itemSources.join(' ').toLowerCase();
    const sourceName = (item.source || '').toLowerCase();

    if (trustedSources.some(s => sourceStr.includes(s) || sourceName.includes(s))) {
      score += 30; // Bonus for trusted sources
    } else if (itemSources.length > 0) {
      score += 15; // Base score for having a source
    }

    // Source diversity score
    score += Math.min(itemSources.length * 10, 50); // Up to 50 points for multiple sources

    // Confidence score (0-50 points)
    score += itemConfidence * 50;

    // Engagement score (if available)
    const totalEngagement = (itemEngagement.likes || 0) + (itemEngagement.shares || 0) * 2 + (itemEngagement.comments || 0);
    if (totalEngagement > 0) {
      score += Math.min(Math.log10(totalEngagement + 1) * 15, 30); // Up to 30 points
    }

    // Keyword relevance for major AI companies
    const majorAICompanies = ['openai', 'anthropic', 'google', 'gemini', 'claude', 'gpt', 'meta', 'llama', 'microsoft', 'nvidia'];
    const titleLower = itemTitle.toLowerCase();
    const majorCompanyBonus = majorAICompanies.filter(company =>
      titleLower.includes(company)
    ).length * 20;
    score += majorCompanyBonus;

    // Title quality bonus - prefer descriptive titles over generic ones
    if (itemTitle.length > 50 && itemTitle.length < 200) {
      score += 15; // Good title length
    }
    if (itemTitle.includes(':') || itemTitle.includes('—')) {
      score += 10; // Headline format bonus
    }

    // Diversity bonus - prefer different companies if recently posted about one
    if (recentlyUsed.some(used => used && typeof used === 'string' && used.toLowerCase().includes('gemini')) &&
        !titleLower.includes('gemini')) {
      score += 50; // Bonus for non-Gemini content
    }

    // Breaking news bonus
    if (item.metadata?.isBreaking || titleLower.includes('breaking') || titleLower.includes('just in')) {
      score += 30;
    }

    // Category diversity scoring
    const itemCategory = this.postingStrategy.categorizeTrend({ topic: itemTitle });

    // Get last 5 posts categories
    const recentCategories = recentlyUsed.slice(0, 5).map(topic =>
      topic ? this.postingStrategy.categorizeTrend({ topic }) : null
    ).filter(Boolean);

    // Diversity bonus - prefer different categories
    if (!recentCategories.includes(itemCategory)) {
      score += 40; // Significant bonus for category diversity
      logger.debug(`Category diversity bonus for "${itemCategory}" category`);
    }

    return {
      ...item,
      // Normalize fields for downstream consumption
      topic: itemTitle, // Use title as topic for consistency
      sources: itemSources,
      confidence: itemConfidence,
      calculatedScore: score,
      wasRecentlyUsed
    };
  });

  // Filter out items with invalid scores
  const validItems = scoredItems.filter(item =>
    item.calculatedScore !== undefined &&
    (item.topic || item.title)
  );

  // Sort by score and return the best one
  validItems.sort((a, b) => b.calculatedScore - a.calculatedScore);

  logger.debug(`Top 5 AI news candidates after scoring:`);
  validItems.slice(0, 5).forEach((item, i) => {
    const displayTitle = (item.title || item.topic || '').slice(0, 80);
    const displaySources = item.sources?.join(', ') || item.source || 'unknown';
    logger.debug(`${i + 1}. "${displayTitle}" (score: ${item.calculatedScore.toFixed(2)}, used: ${item.wasRecentlyUsed}, sources: ${displaySources})`);
  });

  return validItems[0] || null;
}

// Helper method to check recently used AI topics - FIXED for Supabase
async getRecentlyUsedAITopics(hours = 24) {
  try {
    const since = new Date();
    since.setHours(since.getHours() - hours);

    // Use Supabase query syntax
    const { data, error } = await this.db
      .from('published_posts')
      .select('trend, content, platform, published_at')
      .eq('platform', 'linkedin')
      .gt('published_at', since.toISOString())
      .order('published_at', { ascending: false })
      .limit(20);

    if (error) {
      // If the table doesn't exist yet, return empty array
      if (error.code === 'PGRST116' || error.code === '42P01') {
        logger.debug('Published posts table not found or empty, returning empty array');
        return [];
      }
      throw error;
    }

    const topics = (data || []).map(post => {
      // Handle both JSONB trend object and string content
      const topic = post.trend?.topic ||
                    (typeof post.content === 'object' ? post.content?.topic : null) ||
                    '';
      return topic;
    }).filter(topic => topic && typeof topic === 'string' && topic.length > 0);

    logger.debug(`Found ${topics.length} recently used LinkedIn topics`);
    return topics;

  } catch (error) {
    logger.error('Error fetching recently used topics:', error);
    return [];
  }
}

// Add dynamic score calculation
calculateAINewsScore(news) {
  let score = 0;
  
  // Base score from confidence
  score += (news.confidence || 0.5) * 100;
  
  // Recency bonus
  const ageInHours = (Date.now() - new Date(news.publishedAt).getTime()) / (1000 * 60 * 60);
  if (ageInHours < 1) score += 50;
  else if (ageInHours < 6) score += 30;
  else if (ageInHours < 12) score += 20;
  
  // Source credibility
  const trustedSources = ['google_news', 'google_news_genai', 'twitter_trends', 'reddit'];
  if (news.sources?.some(s => trustedSources.includes(s))) {
    score += 20;
  }
  
  // Major AI company bonus
  const majorAI = ['openai', 'anthropic', 'google', 'meta', 'microsoft'];
  if (majorAI.some(company => news.topic.toLowerCase().includes(company))) {
    score += 30;
  }
  
  return Math.round(score);
}

async filterByRateLimits(platforms, preferredPlatforms = []) {
  const availablePlatforms = [];
  
  for (const platform of platforms) {
    const canPost = await this.rateLimiter.canPost(platform);
    
    if (canPost) {
      availablePlatforms.push(platform);
      logger.debug(`✅ Platform ${platform} is available`);
    } else {
      logger.warn(`❌ Platform ${platform} is rate limited`);
    }
  }
  
  // If we have preferred platforms, prioritize those
  if (preferredPlatforms.length > 0) {
    const preferred = availablePlatforms.filter(p => 
      preferredPlatforms.includes(p)
    );
    return preferred.length > 0 ? preferred : availablePlatforms;
  }
  
  // If no platforms available, try Reddit as fallback (most permissive)
  if (availablePlatforms.length === 0 && platforms.includes('reddit')) {
    const redditAvailable = await this.rateLimiter.canPost('reddit');
    if (redditAvailable) {
      logger.info('Using Reddit as fallback platform');
      return ['reddit'];
    }
  }
  
  return availablePlatforms;
}

async generatePostForTrend(trend) {
  try {
    logger.info(`Generating news-style post for trend: ${trend.topic}`);
    
    // Never generate video (as requested)
    const shouldGenerateVideo = false;
    
    logger.info(`Video generation: ${shouldGenerateVideo ? 'Yes' : 'No'} (disabled per configuration)`);
    
    // Build the query - add news context
    // IMPROVE: Don't just append "latest news" to every trend
    let newsQuery = trend.topic;
    
    // Only add "news" context if the trend isn't already news-related
    const newsKeywords = ['news', 'breaking', 'latest', 'update', 'report'];
    const hasNewsContext = newsKeywords.some(kw => trend.topic.toLowerCase().includes(kw));
    
    if (!hasNewsContext) {
      newsQuery = `${trend.topic} latest developments`;
    }
    
    // Make request to generate endpoint
    const response = await fetch(`http://localhost:${process.env.PORT || 8080}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: newsQuery,
        generateVideo: shouldGenerateVideo,
        videoDuration: '5',
        userId: 'automation-bot'
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`Generation API error (${response.status}): ${errorText}`);
      throw new Error(`Generation API returned ${response.status}`);
    }
    
    const data = await response.json();
    
    // Check if we actually got posts
    if (!data.posts || data.posts.length === 0) {
      logger.warn(`No posts generated for trend: ${trend.topic}`);
      // Check if it's because no articles were found
      if (data.message && data.message.includes('Could not find relevant articles')) {
        logger.info('No articles found for this trend, will try next trend');
      }
      return null;
    }
    
    logger.info(`Generated ${data.posts.length} posts`);
    
    // Return the entire response data which includes the posts array
    return data;
    
  } catch (error) {
    logger.error('Error generating post:', error);
    return null;
  }
}

async generateLinkedInAIPost(trend) {
  try {
    logger.info(`Generating LinkedIn Gen AI post for: ${trend.topic}`);
    
    // Import LinkedIn-specific prompts
    const { getLinkedInSystemPrompt, getLinkedInUserPrompt } = 
      await import('../public/components/linkedInPrompts.mjs');
    
    // Get the article data - ensure URL is properly extracted
    const article = {
      title: trend.title || trend.topic,
      description: trend.description || 'Breaking news in Generative AI',
      url: trend.url || trend.metadata?.url || trend.metadata?.originalUrl || '',
      publishedAt: trend.publishedAt || trend.metadata?.timestamp || new Date().toISOString()
    };
    
    // Additional URL recovery attempts
    if (!article.url) {
      // Try to extract from metadata articles
      if (trend.metadata?.articles && trend.metadata.articles.length > 0) {
        article.url = trend.metadata.articles[0].url || 
                      trend.metadata.articles[0].link || 
                      '';
      }
      
      // Try to extract from sources
      if (!article.url && trend.metadata?.sources && trend.metadata.sources.length > 0) {
        const source = trend.metadata.sources[0];
        if (typeof source === 'object' && source.url) {
          article.url = source.url;
        }
      }
    }
    
    // Debug log to verify we have the URL
    logger.debug(`Article data for LinkedIn post:`, {
      title: article.title,
      hasDescription: !!article.description,
      url: article.url,
      urlLength: article.url.length
    });
    
    if (!article.url) {
      logger.error('No URL found for LinkedIn post after all recovery attempts!');
      logger.error('Trend data:', JSON.stringify(trend, null, 2));
      throw new Error('Missing article URL');
    }
    
    // Make request to OpenAI with LinkedIn-specific prompts
    const systemPrompt = getLinkedInSystemPrompt();
    const userPrompt = getLinkedInUserPrompt(article);
    
    const completion = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: 800
    });
    
    let postText = completion.choices[0].message.content;
    
    // CRITICAL FIX: Ensure URL is in the post
    const actualUrl = article.url;
    const linkHtml = `<a href="${actualUrl}" style="color: #0077B5; text-decoration: underline; font-weight: 600;" rel="noopener noreferrer" target="_blank">Read full details</a>`;
    
    // More robust URL insertion logic
    let urlInserted = false;
    
    // Method 1: Replace any existing link placeholder
    if (postText.includes('<a href=') || postText.includes('[INSERT_EXACT_URL_HERE]')) {
      // Replace any link or placeholder with our actual link
      postText = postText.replace(/<a href="[^"]*"[^>]*>.*?<\/a>/g, linkHtml);
      postText = postText.replace(/\[INSERT_EXACT_URL_HERE\]/g, actualUrl);
      urlInserted = true;
      logger.info('Replaced placeholder/link with actual URL');
    }
    
    // Method 2: If no link found, insert before hashtags
    if (!urlInserted && !postText.includes(actualUrl)) {
      const hashtagMatch = postText.match(/(#\w+[\s#\w]*)/);
      if (hashtagMatch) {
        const hashtagIndex = postText.indexOf(hashtagMatch[0]);
        postText = postText.slice(0, hashtagIndex).trim() + '\n\n' + linkHtml + '\n\n' + postText.slice(hashtagIndex);
        urlInserted = true;
        logger.info('Inserted link before hashtags');
      }
    }
    
    // Method 3: If still no link, append it
    if (!urlInserted && !postText.includes(actualUrl)) {
      // Remove any trailing whitespace and add the link
      postText = postText.trim() + '\n\n' + linkHtml + '\n\n#GenerativeAI #AINews #ArtificialIntelligence';
      urlInserted = true;
      logger.info('Appended link to end of post');
    }
    
    // Final verification - check for the actual URL
    if (!postText.includes(actualUrl)) {
      logger.error('CRITICAL: Post still missing URL after all processing!');
      logger.error('Post text:', postText);
      
      // Force insert as last resort
      postText = postText.trim() + '\n\nSource: ' + actualUrl + '\n\n#GenerativeAI #AINews';
    } else {
      logger.info('✅ URL successfully included in post');
    }
    
    return {
      posts: [{
        text: postText,
        video: null,
        isLinkedIn: true
      }]
    };
    
  } catch (error) {
    logger.error('Error generating LinkedIn AI post:', error);
    return null;
  }
}

async publishScheduledPost(scheduledPost) {
  const results = [];
  
  logger.info(`Publishing to platforms: ${scheduledPost.platforms.join(', ')}`);
  
  for (const platform of scheduledPost.platforms) {
    try {
      // Double-check rate limits before publishing
      const canPost = await this.rateLimiter.canPost(platform);
      if (!canPost) {
        logger.warn(`Skipping ${platform} due to rate limit`);
        results.push({
          platform,
          success: false,
          error: 'Rate limited'
        });
        continue;
      }
      
      // Get the publisher for this platform
      const publisher = this.publishers[platform];
      
      if (!publisher) {
        logger.error(`No publisher available for platform: ${platform}`);
        results.push({
          platform,
          success: false,
          error: 'Publisher not configured'
        });
        continue;
      }
      
      // FIXED: Extract the actual post text from the response structure
      let postText = '';
      let videoUrl = null;
      
      // Check if content has posts array (from generate endpoint)
      if (scheduledPost.content && scheduledPost.content.posts && scheduledPost.content.posts.length > 0) {
        // Use the first post from the array
        const firstPost = scheduledPost.content.posts[0];
        postText = firstPost.text || '';
        videoUrl = firstPost.video || null;
      } else if (scheduledPost.content && typeof scheduledPost.content === 'string') {
        // Fallback if content is already a string
        postText = scheduledPost.content;
      } else if (scheduledPost.content && scheduledPost.content.text) {
        // Another possible structure
        postText = scheduledPost.content.text;
        videoUrl = scheduledPost.content.video || null;
      } else {
        logger.error(`Unable to extract post text from content structure:`, scheduledPost.content);
        results.push({
          platform,
          success: false,
          error: 'Invalid content structure'
        });
        continue;
      }
      
      logger.info(`Publishing to ${platform}...`);
      logger.debug(`Post text length: ${postText.length} characters`);
      
      // Publish the post
      const result = await publisher.publishPost(postText, videoUrl);
      
      results.push({
        ...result,
        platform // Ensure platform is always included
      });
      
      // Log successful publication
      if (result.success) {
        logger.info(`✅ Successfully published to ${platform}`);
        await this.logPublication(scheduledPost, result);
      } else {
        logger.error(`❌ Failed to publish to ${platform}: ${result.error}`);
      }
      
    } catch (error) {
      logger.error(`Failed to publish to ${platform}:`, error);
      results.push({
        platform,
        success: false,
        error: error.message || 'Unknown error'
      });
    }
  }
  
  // Update scheduled post status based on results
  const successCount = results.filter(r => r.success).length;
  const status = successCount === 0 ? 'failed' : 
                 successCount === scheduledPost.platforms.length ? 'completed' : 
                 'partial_failure';
  
  await this.dbManager.updateScheduledPostStatus(scheduledPost.id, status);
  
  logger.info(`Publishing summary: ${successCount}/${scheduledPost.platforms.length} successful`);
  
  return results;
}

async logPublication(scheduledPost, result) {
  try {
    // Extract the actual post content for logging
    let contentToLog = '';
    
    if (scheduledPost.content && scheduledPost.content.posts && scheduledPost.content.posts.length > 0) {
      contentToLog = scheduledPost.content.posts[0].text || '';
    } else if (typeof scheduledPost.content === 'string') {
      contentToLog = scheduledPost.content;
    } else if (scheduledPost.content && scheduledPost.content.text) {
      contentToLog = scheduledPost.content.text;
    }
    
    await this.dbManager.savePublishedPost({
      scheduled_post_id: scheduledPost.id,
      trend: scheduledPost.trend,
      platform: result.platform,
      platform_post_id: result.postId,
      platform_url: result.url,
      success: result.success,
      error: result.error || null,
      content: contentToLog
    });
  } catch (error) {
    logger.error('Error logging publication:', error);
  }
}

  async generateDailyReport() {
    try {
      logger.info('Generating daily analytics report...');
      
      // Get today's posts
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      const posts = await this.dbManager.getPublishedPostsSince(today);
      
      const report = {
        date: new Date().toISOString(),
        total_posts: posts.length,
        platforms: {},
        trends_used: new Set(),
        success_rate: 0
      };
      
      // Analyze posts
      posts.forEach(post => {
        if (!report.platforms[post.platform]) {
          report.platforms[post.platform] = {
            total: 0,
            successful: 0
          };
        }
        
        report.platforms[post.platform].total++;
        if (post.success) {
          report.platforms[post.platform].successful++;
        }
        
        if (post.trend?.topic) {
          report.trends_used.add(post.trend.topic);
        }
      });
      
      // Calculate success rate
      const totalAttempts = posts.length;
      const successful = posts.filter(p => p.success).length;
      report.success_rate = totalAttempts > 0 ? (successful / totalAttempts) * 100 : 0;
      
      // Convert Set to Array for storage
      report.trends_used = Array.from(report.trends_used);
      
      // Save report
      await this.dbManager.saveDailyReport(report);
      
      logger.info('✅ Daily report generated:', report);
      
    } catch (error) {
      logger.error('Error generating daily report:', error);
    }
  }

  async performMaintenance() {
    try {
      logger.info('Performing weekly maintenance...');
      
      // Clean up old scheduled posts
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      
      await this.dbManager.cleanupOldPosts(thirtyDaysAgo);
      
      // Clear old trend history
      await this.dbManager.cleanupOldTrends(thirtyDaysAgo);
      
      logger.info('✅ Maintenance completed');
      
    } catch (error) {
      logger.error('Error during maintenance:', error);
    }
  }

  async logError(error) {
    try {
      // Use Supabase syntax instead of Firestore
      const { error: dbError } = await this.db
        .from('automation_logs')
        .insert({
          type: 'error',
          error_message: error.message,
          error_stack: error.stack,
          error_name: error.name,
          timestamp: new Date().toISOString(),
          context: 'automated_posting'
        });

      if (dbError) {
        // Don't throw - just log locally if db logging fails
        logger.error('Failed to log error to database:', dbError);
      }
    } catch (logError) {
      logger.error('Failed to log error to database:', logError);
    }
  }

  checkRecentUsage(topic) {
    // This would check against recent posts in the database
    // For now, return false to allow all topics
    return false;
  }
}

export default AutomationManager;