// services/PostingStrategy.js - FIXED VERSION
import trendAnalyzer from './TrendAnalyzer.js';
import { FieldValue } from '@google-cloud/firestore';
import winston from 'winston';
import '../config/env.js';
import { TOPIC_CATEGORIES, getEnabledCategories, isTopicInEnabledCategory } from '../config/topicConfig.js';

const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[PostingStrategy] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

export class PostingStrategy {
  constructor(db) {
    this.db = db;
    this.trendCache = new Map();
    this.cacheExpiry = 30 * 60 * 1000; // 30 minutes

    // Trend reuse configuration
    this.reuseConfig = {
    // Time windows
    recentUsageWindow: parseInt(process.env.TREND_USAGE_WINDOW || '24'), // hours
    unusedCheckWindow: parseInt(process.env.TREND_UNUSED_WINDOW || '12'), // hours
    
    // Usage limits
    maxUsageBeforePenalty: parseInt(process.env.TREND_MAX_USAGE || '2'),
    maxUsagePerDay: parseInt(process.env.TREND_MAX_DAILY || '6'),
    
    // Penalties (multipliers)
    penalties: {
      mild: parseFloat(process.env.TREND_PENALTY_MILD || '0.9'),     // 1-2 uses
      moderate: parseFloat(process.env.TREND_PENALTY_MOD || '0.7'),  // 3-4 uses  
      severe: parseFloat(process.env.TREND_PENALTY_SEVERE || '0.4')  // 5+ uses
      },
    
    // Boosts
    highVolumeBoost: parseFloat(process.env.TREND_VOLUME_BOOST || '1.2'),
    highVolumeThreshold: parseInt(process.env.TREND_VOLUME_THRESHOLD || '10000'),
    
    // Special handling for viral topics
    viralTopicHandling: process.env.TREND_VIRAL_HANDLING === 'true',
    viralVolumeThreshold: parseInt(process.env.TREND_VIRAL_THRESHOLD || '50000')
    };
    
    // FIXED: Relaxed quality thresholds for single-source trends
    this.qualityThresholds = {
      minConfidence: 0.5,  // Lowered from 0.7
      minSourceCount: 1,   // Changed from 2 to 1
      minEngagementScore: 100,  // Lowered from 1000
      maxStaleness: 24 * 60 * 60 * 1000 // 24 hours
    };
    
    // Topic categories for better targeting
    this.topicCategories = {
      tech: ['Generative AI', 'LLM', 'AI', 'Quantum Computing', 'Apple Intelligence', 'Open AI', 'Anthropic', 'Google AI', 'Microsoft AI', 'AI Ethics', 'AI Safety', 'MCP'],
      top_stories: ['top stories', 'headlines', 'breaking news', 'latest news', 'current events'],
      politics: ['politics', 'election', 'government', 'congress', 'senate', 'president', 'campaign', 'policy'],
      business: ['business', 'economy', 'finance', 'market', 'investment', 'entrepreneur', 'company'],
      news: ['breaking', 'politics', 'world', 'election', 'policy', 'government', 'middle east']
    };
  }

async getOptimalTrend(options = {}) {
  const {
    preferredCategory = null,
    excludeCategories = [],
    retryAttempts = 3,
    cacheTrends = true,
    returnMultiple = false, // NEW: Option to return multiple trends
    timeout = 30000 // 30 second timeout
  } = options;
  
  try {
    logger.info('Starting optimal trend selection...');
    
    // Check cache first (only if not requesting multiple)
    if (cacheTrends && !returnMultiple) {
      const cachedTrend = this.getCachedTrend(preferredCategory);
      if (cachedTrend) {
        logger.info(`Using cached trend: ${cachedTrend.topic}`);
        return cachedTrend;
      }
    }
    
    let allScoredTrends = [];
    let attempts = 0;
    
    while (allScoredTrends.length === 0 && attempts < retryAttempts) {
      try {
        attempts++;
        logger.debug(`Trend selection attempt ${attempts}/${retryAttempts}`);
        
        // Get trends with dynamic source selection
        const sources = this.getOptimalSources();
        const targetLocation = process.env.TREND_LOCATION || 'US';
        
        const trends = await trendAnalyzer.getAggregatedTrends({
          location: targetLocation,
          sources: sources,
          limit: 200 // Get more trends for better selection
        });
        
        if (!trends || trends.length === 0) {
          logger.warn(`No trends found on attempt ${attempts}`);
          await this.delay(5000 * attempts);
          continue;
        }
        
        logger.info(`Found ${trends.length} raw trends before filtering`);
        
        // Apply multi-stage filtering with relaxed rules
        const filteredTrends = await this.applyAdvancedFiltering(trends, {
          excludeCategories,
          preferredCategory
        });
        
        logger.info(`${filteredTrends.length} trends passed filtering`);
        
        if (filteredTrends.length === 0) {
          logger.warn('No trends passed advanced filtering, relaxing filters...');
          const relaxedTrends = await this.applyRelaxedFiltering(trends, {
            excludeCategories,
            preferredCategory
          });
          
          if (relaxedTrends.length > 0) {
            filteredTrends.push(...relaxedTrends);
            logger.info(`${relaxedTrends.length} trends passed relaxed filtering`);
          } else {
            await this.delay(5000 * attempts);
            continue;
          }
        }
        
        // Score and rank trends
        allScoredTrends = await this.scoreAndRankTrends(filteredTrends);
        
      } catch (error) {
        logger.error(`Error in trend selection attempt ${attempts}:`, error);
        if (attempts < retryAttempts) {
          await this.delay(5000 * attempts);
        }
      }
    }
    
    if (allScoredTrends.length === 0) {
      // Fallback to a safe, evergreen trend
      const fallbackTrend = this.getFallbackTrend(preferredCategory);
      logger.warn('Using fallback trend:', fallbackTrend.topic);
      
      if (returnMultiple) {
        return [fallbackTrend];
      }
      return fallbackTrend;
    }
    
    // If returning multiple trends, return top unused trends
    if (returnMultiple) {
      const unusedTrends = [];
      const maxTrends = Math.min(10, allScoredTrends.length); // Return up to 10 trends
      
      for (const trend of allScoredTrends.slice(0, maxTrends * 2)) {
        const isUnused = await this.checkTrendUnused(trend.topic, 12);
        if (isUnused) {
          unusedTrends.push(trend);
          if (unusedTrends.length >= maxTrends) break;
        }
      }
      
      // If we don't have enough unused trends, add some recently used ones
      if (unusedTrends.length < 5) {
        const additionalTrends = allScoredTrends
          .slice(0, 10)
          .filter(t => !unusedTrends.some(u => u.topic === t.topic));
        unusedTrends.push(...additionalTrends.slice(0, 5 - unusedTrends.length));
      }
      
      logger.info(`Returning ${unusedTrends.length} trends for content generation`);
      return unusedTrends;
    }
    
    // Original single trend selection logic
    const selectedTrend = await this.selectUnusedTrend(allScoredTrends);
    
    if (cacheTrends) {
      this.cacheTrend(selectedTrend, preferredCategory);
    }
    
    logger.info(`Selected optimal trend: ${selectedTrend.topic} (score: ${selectedTrend.score})`);
    return selectedTrend;
    
  } catch (error) {
    logger.error('Critical error in getOptimalTrend:', error);
    const fallback = this.getFallbackTrend();
    return returnMultiple ? [fallback] : fallback;
  }
}

async applyAdvancedFiltering(trends, options) {
  const { excludeCategories, preferredCategory } = options;
  
  // First pass: basic safety filtering
  let safeTrends = await trendAnalyzer.filterTrends(trends, {
    excludeControversial: true,
    excludeAdult: true,
    minConfidence: this.qualityThresholds.minConfidence
  });
  
  logger.debug(`${safeTrends.length} trends passed safety filtering`);
  
  // NEW: Filter out exact duplicates posted recently - with performance optimization
  logger.info(`Checking ${safeTrends.length} trends for duplicates...`);
  
  // Batch check for better performance
  const duplicateCheckPromises = safeTrends.map(async (trend) => {
    const isDuplicate = await this.checkExactDuplicatePosted(trend, 8); // Check last 8 hours
    return { trend, isDuplicate };
  });
  
  // Process in batches of 10 to avoid overwhelming the database
  const batchSize = 10;
  const nonDuplicateTrends = [];
  
  for (let i = 0; i < duplicateCheckPromises.length; i += batchSize) {
    const batch = duplicateCheckPromises.slice(i, i + batchSize);
    const results = await Promise.all(batch);
    
    for (const { trend, isDuplicate } of results) {
      if (!isDuplicate) {
        nonDuplicateTrends.push(trend);
      } else {
        logger.info(`Filtered out duplicate trend: "${trend.topic}"`);
      }
    }
    
    // Log progress
    if (i + batchSize < duplicateCheckPromises.length) {
      logger.debug(`Duplicate check progress: ${Math.min(i + batchSize, duplicateCheckPromises.length)}/${duplicateCheckPromises.length}`);
    }
  }
  
  safeTrends = nonDuplicateTrends;
  logger.info(`${safeTrends.length} trends passed duplicate filtering`);
  
  // NEW: Apply category-based filtering
  const enabledCategories = getEnabledCategories();
  logger.info(`Filtering for enabled categories: ${enabledCategories.join(', ')}`);
  
  safeTrends = safeTrends.filter(trend => {
    const categoryCheck = isTopicInEnabledCategory(trend.topic);
    
    if (!categoryCheck.allowed) {
      logger.debug(`Filtered out "${trend.topic}" - not in enabled categories`);
      return false;
    }
    
    logger.debug(`Trend "${trend.topic}" matched category: ${categoryCheck.category}`);
    
    // Store the matched category for later use
    trend.matchedCategory = categoryCheck.category;
    
    return true;
  });
  
  logger.info(`${safeTrends.length} trends passed category filtering`);
  
  // Additional political content filtering (if politics is disabled)
  if (!TOPIC_CATEGORIES.politics.enabled) {
    const politicalKeywords = TOPIC_CATEGORIES.politics.keywords;
    
    safeTrends = safeTrends.filter(trend => {
      const topicLower = trend.topic.toLowerCase();
      const isPolitical = politicalKeywords.some(keyword => 
        topicLower.includes(keyword.toLowerCase())
      );
      
      if (isPolitical) {
        logger.debug(`Filtered out political trend: "${trend.topic}"`);
        return false;
      }
      
      return true;
    });
  }
  
  // Rest of your existing filtering logic continues here...
  // Second pass: quality filtering with relaxed rules
  safeTrends = safeTrends.filter(trend => {
    // FIXED: More flexible source checking
    const sourceCount = Array.isArray(trend.sources) ? trend.sources.length : 1;
    
    if (sourceCount < this.qualityThresholds.minSourceCount) {
      logger.debug(`Filtered out "${trend.topic}" - only ${sourceCount} source(s)`);
      return false;
    }
    
    // Apply category weight bonus
    if (trend.matchedCategory && TOPIC_CATEGORIES[trend.matchedCategory]) {
      const categoryWeight = TOPIC_CATEGORIES[trend.matchedCategory].weight;
      trend.score = (trend.score || 1) * categoryWeight;
      logger.debug(`Applied category weight ${categoryWeight} to "${trend.topic}"`);
    }
    
    // Rest of your existing quality checks...
    const volume = trend.volume || 0;
    if (volume > 0 && volume < this.qualityThresholds.minEngagementScore) {
      logger.debug(`Filtered out "${trend.topic}" - low engagement: ${volume}`);
      return false;
    }
    
    if (trend.topic.split(' ').length === 1 && trend.topic.length < 4) {
      logger.debug(`Filtered out "${trend.topic}" - too generic`);
      return false;
    }
    
    return true;
  });
  
  // Third pass: content quality check
  return safeTrends.filter(trend => {

    // Filter out single words that are likely not real trends
    const lowQualityWords = ['failed', 'error', 'undefined', 'null', 'test', 'example'];
    if (trend.topic.split(' ').length === 1 && lowQualityWords.includes(trend.topic.toLowerCase())) {
      logger.debug(`Filtered out "${trend.topic}" - low quality single word`);
      return false;
    }

    const clickbaitPatterns = [
      /you won't believe/i,
      /this one trick/i,
      /doctors hate/i,
      /shocking/i,
      /\d+ reasons why/i
    ];
    
    const hasClickbait = clickbaitPatterns.some(pattern => 
      pattern.test(trend.topic)
    );
    
    if (hasClickbait) {
      logger.debug(`Filtered out "${trend.topic}" - clickbait pattern`);
      return false;
    }
    
    return true;
  });
}

  // ADDED: Relaxed filtering for when strict filtering yields no results
  async applyRelaxedFiltering(trends, options) {
    const { excludeCategories } = options;
    
    logger.info('Applying relaxed filtering rules...');
    
    // Very basic filtering - just remove adult/controversial content
    const safeTrends = trends.filter(trend => {
      const topic = trend.topic.toLowerCase();
      
      // Basic blacklist
      const blacklist = ['nsfw', 'adult', 'porn', 'sex', 'nude'];
      if (blacklist.some(word => topic.includes(word))) {
        return false;
      }
      
      // Allow single-source trends
      // Allow any engagement level
      // Allow shorter trends
      
      return true;
    });
    
    return safeTrends;
  }

// 1. Update the scoreAndRankTrends method to be less aggressive with penalties
async scoreAndRankTrends(trends) {
  // Get usage counts for all trends in parallel
  const trendUsageCounts = await Promise.all(
    trends.map(trend => 
      this.getTopicUsageCount(this.normalizeTopic(trend.topic), 24)
    )
  );
  
  return trends.map((trend, index) => {
    let score = 0;
    
    // Base score from confidence
    const confidence = trend.confidence || 0.5;
    score += confidence * 100;
    
    // Source diversity bonus
    const sourceCount = Array.isArray(trend.sources) ? trend.sources.length : 1;
    score += Math.min(sourceCount * 15, 45);
    
    // Engagement/volume score
    if (trend.volume && trend.volume > 0) {
      score += Math.log10(trend.volume + 1) * 10;
    } else {
      score += 5;
    }
    
    // Freshness bonus
    if (trend.metadata?.timestamp) {
      const age = Date.now() - new Date(trend.metadata.timestamp).getTime();
      const freshnessScore = Math.max(0, 100 - (age / (1000 * 60 * 60)));
      score += freshnessScore * 0.5;
    }
    
    // Category bonus
    const category = this.categorizeTrend(trend);
    const categoryBonus = {
      tech: 20,
      business: 15,
      science: 15,
      entertainment: 5,
      news: 10,
      other: 0
    };
    score += categoryBonus[category] || 0;
    
    // Apply usage penalty using the calculateUsagePenalty method
    const recentUsageCount = trendUsageCounts[index];
    const usagePenalty = this.calculateUsagePenalty(recentUsageCount, trend.volume || 0);
    score *= usagePenalty;
    
    if (recentUsageCount > 0) {
      logger.debug(`Topic "${trend.topic}" used ${recentUsageCount} times in last 24h, penalty multiplier: ${usagePenalty}`);
    }
    
    // Length preference
    const wordCount = trend.topic.split(' ').length;
    if (wordCount >= 2 && wordCount <= 5) {
      score += 10;
    }
    
    return {
      ...trend,
      score: Math.round(score),
      scoreBreakdown: {
        confidence: confidence * 100,
        sources: Math.min(sourceCount * 15, 45),
        volume: trend.volume ? Math.log10(trend.volume + 1) * 10 : 5,
        category: categoryBonus[category] || 0,
        recentUsageCount: recentUsageCount,
        wasRecentlyUsed: recentUsageCount > 0,
        usagePenalty: usagePenalty
      }
    };
  }).sort((a, b) => b.score - a.score);
}

// 2. Add method to count topic usage
async getTopicUsageCount(normalizedTopic, hours = 24) {
  try {
    const since = new Date();
    since.setHours(since.getHours() - hours);
    
    const snapshot = await this.db
      .collection('trend_history')
      .where('normalized_topic', '==', normalizedTopic)
      .where('used_at', '>', since)
      .get();
    
    return snapshot.size;
  } catch (error) {
    logger.error('Error counting topic usage:', error);
    return 0;
  }
}

// NEW: Check for exact duplicate articles posted recently
async checkExactDuplicatePosted(trend, hours = 8) {
  try {
    const since = new Date();
    since.setHours(since.getHours() - hours);
    
    // Check published posts for exact title/topic match
    const snapshot = await this.db
      .collection('published_posts')
      .where('published_at', '>', since)
      .limit(100) // Limit to last 100 posts for performance
      .get();
    
    // Early return if no posts
    if (snapshot.empty) return false;
    
    // Normalize the trend topic once
    const trendTopicLower = trend.topic ? trend.topic.toLowerCase() : '';
    const trendTitleLower = trend.title ? trend.title.toLowerCase() : '';
    
    // Check for exact matches in recent posts
    for (const doc of snapshot.docs) {
      const data = doc.data();
      const postedTopic = data.trend?.topic || data.content?.topic || '';
      const postedTitle = data.trend?.title || data.content?.title || '';
      
      // Skip empty posts
      if (!postedTopic && !postedTitle) continue;
      
      // Check exact topic match
      if (postedTopic && trendTopicLower && 
          postedTopic.toLowerCase() === trendTopicLower) {
        logger.warn(`DUPLICATE: Exact topic match found: "${trend.topic}"`);
        return true;
      }
      
      // Check title match (for news articles)
      if (trendTitleLower && postedTitle && 
          postedTitle.toLowerCase() === trendTitleLower) {
        logger.warn(`DUPLICATE: Exact title match found: "${trend.title}"`);
        return true;
      }
      
      // Check for very similar topics (80% similarity) - only for longer topics
      if (postedTopic && trend.topic && trend.topic.length > 10) {
        const similarity = this.calculateSimilarity(postedTopic, trend.topic);
        if (similarity > 0.8) {
          logger.warn(`DUPLICATE: High similarity (${(similarity * 100).toFixed(0)}%) found: "${trend.topic}" vs "${postedTopic}"`);
          return true;
        }
      }
    }
    
    return false;
  } catch (error) {
    logger.error('Error checking exact duplicates:', error);
    return false;
  }
}

// Helper: Simple similarity calculation
calculateSimilarity(str1, str2) {
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();
  
  // Exact match
  if (s1 === s2) return 1.0;
  
  // Check if one contains the other
  if (s1.includes(s2) || s2.includes(s1)) return 0.9;
  
  // Simple word overlap
  const words1 = s1.split(/\s+/);
  const words2 = s2.split(/\s+/);
  const commonWords = words1.filter(w => words2.includes(w));
  
  const similarity = (commonWords.length * 2) / (words1.length + words2.length);
  return similarity;
}

// Calculate usage penalty based on count and volume
calculateUsagePenalty(usageCount, volume = 0) {
  // No penalty for first use
  if (usageCount === 0) {
    return 1.0; // No penalty
  }
  
  // HARD BLOCK: If used in the last 4 hours, severe penalty
  if (usageCount >= 1) {
    // Check if this was used very recently (will be implemented in scoring)
    // For now, apply immediate penalty
  }
  
  // Check if it's a viral/high-volume topic
  const isHighVolume = volume > 10000;
  const isViral = volume > 50000;
  
  // Special handling for viral topics - but still penalize recent use
  if (isViral) {
    if (usageCount === 1) return 0.7; // 30% penalty for first reuse
    if (usageCount === 2) return 0.4; // 60% penalty for second reuse
    return 0.1; // 90% penalty for 3+ uses
  }
  
  // Much more aggressive penalties for regular topics
  if (usageCount === 1) {
    return isHighVolume ? 0.5 : 0.3; // 50-70% penalty for first reuse
  } else if (usageCount === 2) {
    return isHighVolume ? 0.2 : 0.1; // 80-90% penalty for second reuse
  } else {
    // Near-complete block for 3+ uses
    return 0.01; // 99% penalty - effectively blocked
  }
}

// 3. Update selectUnusedTrend to be more flexible
async selectUnusedTrend(scoredTrends) {
  // First try to find completely unused trends
  for (const trend of scoredTrends.slice(0, 10)) { // Check top 10
    const usageCount = await this.getTopicUsageCount(
      this.normalizeTopic(trend.topic), 
      12 // Only check last 12 hours for "unused"
    );
    
    if (usageCount === 0) {
      logger.info(`Selected unused trend: ${trend.topic}`);
      return trend;
    }
  }
  
  // If all top trends have been used, pick the best one regardless
  // The scoring already accounts for usage frequency
  logger.info(`All top trends recently used, selecting highest scored: ${scoredTrends[0].topic}`);
  return scoredTrends[0];
}

// 4. Update checkTrendUnused to be less restrictive
async checkTrendUnused(topic, hours = 12) { // Reduced from 72 to 12 hours
  try {
    const usageCount = await this.getTopicUsageCount(
      this.normalizeTopic(topic),
      hours
    );
    
    // Allow up to 2 uses in the time period
    return usageCount < 2;
    
  } catch (error) {
    logger.error('Error checking trend usage:', error);
    return true;
  }
}

// 5. Add method to check if we should vary the angle
async shouldVaryContent(topic) {
  const usageCount = await this.getTopicUsageCount(
    this.normalizeTopic(topic),
    24
  );
  
  // If we've used this topic more than once today, vary the content angle
  return usageCount > 1;
}

// 6. Update getRecentlyUsedTrends to return more detailed info
async getRecentlyUsedTrends(hours = 24) {
  try {
    const since = new Date();
    since.setHours(since.getHours() - hours);
    
    const snapshot = await this.db
      .collection('trend_history')
      .where('used', '==', true)
      .where('used_at', '>', since)
      .orderBy('used_at', 'desc')
      .limit(100) // Increased from 50
      .get();
    
    // Return topics with usage count
    const topicCounts = new Map();
    
    snapshot.docs.forEach(doc => {
      const data = doc.data();
      const topic = data.topic;
      topicCounts.set(topic, (topicCounts.get(topic) || 0) + 1);
    });
    
    return Array.from(topicCounts.keys());
  } catch (error) {
    logger.error('Error fetching recent trends:', error);
    return [];
  }
}

getOptimalSources() {
  const availableSources = [];
  
  // Always include Google (most reliable, no auth needed)
  availableSources.push('google');
  
  // Check Reddit (usually has good limits)
  if (process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET) {
    availableSources.push('reddit');
  }
  
  // Only include Twitter if not rate limited
  if (process.env.TWITTER_BEARER_TOKEN) {
    // Check if we're currently rate limited
    const now = Date.now();
    const resetTime = trendAnalyzer.twitterRateLimitReset || 0;
    
    if (now > resetTime) {
      availableSources.push('twitter');
    } else {
      const minutesUntilReset = Math.ceil((resetTime - now) / (1000 * 60));
      logger.debug(`Skipping Twitter - rate limited for ${minutesUntilReset} more minutes`);
    }
  }
    
    // Only include TikTok if explicitly enabled and working
    if (process.env.ENABLE_TIKTOK_SCRAPING === 'true') {
      availableSources.push('tiktok');
    }
    
    logger.debug(`Using trend sources: ${availableSources.join(', ')}`);
    return availableSources;
  }

  categorizeTrend(trend) {
    const topicLower = trend.topic.toLowerCase();
    
    for (const [category, keywords] of Object.entries(this.topicCategories)) {
      if (keywords.some(keyword => {
        const keywordLower = keyword.toLowerCase();
        // Use word boundary matching to avoid partial matches
        const regex = new RegExp(`\\b${keywordLower}\\b`, 'i');
        return regex.test(topicLower);
      })) {
        return category;
      }
    }
    
    return 'other';
  }

  normalizeTopic(topic) {
    return topic
      .toLowerCase()
      .replace(/[#@]/g, '')
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

getFallbackTrend(category = null) {
  // Create diverse fallbacks instead of hardcoded Israel/Iran
  const diverseFallbacks = {
    tech: [
      { topic: 'artificial intelligence breakthroughs', query: 'AI breakthrough innovation', confidence: 0.8, sources: ['fallback'], volume: 10000 },
      { topic: 'quantum computing advances', query: 'quantum computing progress', confidence: 0.8, sources: ['fallback'], volume: 9000 },
      { topic: 'renewable energy technology', query: 'clean energy innovation', confidence: 0.8, sources: ['fallback'], volume: 8500 },
      { topic: 'space exploration developments', query: 'space technology mission', confidence: 0.8, sources: ['fallback'], volume: 8000 }
    ],
    business: [
      { topic: 'startup funding rounds', query: 'startup investment funding', confidence: 0.8, sources: ['fallback'], volume: 8000 },
      { topic: 'sustainable business practices', query: 'sustainable business innovation', confidence: 0.8, sources: ['fallback'], volume: 7500 },
      { topic: 'digital transformation trends', query: 'digital business transformation', confidence: 0.8, sources: ['fallback'], volume: 7000 },
      { topic: 'supply chain innovation', query: 'supply chain technology', confidence: 0.8, sources: ['fallback'], volume: 6500 }
    ],
    science: [
      { topic: 'medical research breakthroughs', query: 'medical research discovery', confidence: 0.8, sources: ['fallback'], volume: 9000 },
      { topic: 'climate change solutions', query: 'climate technology solution', confidence: 0.8, sources: ['fallback'], volume: 8500 },
      { topic: 'space discovery missions', query: 'space exploration discovery', confidence: 0.8, sources: ['fallback'], volume: 8000 },
      { topic: 'biotechnology advances', query: 'biotech innovation research', confidence: 0.8, sources: ['fallback'], volume: 7500 }
    ],
    news: [
      { topic: 'global economic developments', query: 'global economy news', confidence: 0.7, sources: ['fallback'], volume: 7000 },
      { topic: 'international climate summit', query: 'climate summit news', confidence: 0.7, sources: ['fallback'], volume: 6500 },
      { topic: 'scientific research breakthroughs', query: 'science breakthrough news', confidence: 0.7, sources: ['fallback'], volume: 6000 },
      { topic: 'global health initiatives', query: 'world health news', confidence: 0.7, sources: ['fallback'], volume: 5500 },
      { topic: 'international space cooperation', query: 'space exploration news', confidence: 0.7, sources: ['fallback'], volume: 5000 },
      { topic: 'sustainable development goals', query: 'sustainability news', confidence: 0.7, sources: ['fallback'], volume: 4500 }
    ]
  };
    
  // Select category-specific fallbacks
  const categoryFallbacks = diverseFallbacks[category];
  if (categoryFallbacks && categoryFallbacks.length > 0) {
    // Rotate through fallbacks to avoid repetition
    const fallbackIndex = Math.floor(Date.now() / (1000 * 60 * 60 * 6)) % categoryFallbacks.length; // Change every 6 hours
    return {
      ...categoryFallbacks[fallbackIndex],
      metadata: { isFallback: true, category }
    };
  }

  // Default diverse fallbacks if no category specified
  const allFallbacks = Object.values(diverseFallbacks).flat();
  const randomIndex = Math.floor(Date.now() / (1000 * 60 * 60 * 4)) % allFallbacks.length; // Change every 4 hours
  
  return {
    ...allFallbacks[randomIndex],
    metadata: { isFallback: true, category: 'general' }
  };
}

  // Caching methods
  getCachedTrend(category) {
    const cacheKey = category || 'general';
    const cached = this.trendCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.cacheExpiry) {
      return cached.trend;
    }
    
    return null;
  }

  cacheTrend(trend, category) {
    const cacheKey = category || 'general';
    this.trendCache.set(cacheKey, {
      trend,
      timestamp: Date.now()
    });
  }

  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

async markTrendAsUsed(trend) {
  try {
    // Clean up the trend object to remove undefined values
    const cleanTrend = {
      topic: trend.topic,
      normalized_topic: this.normalizeTopic(trend.topic),
      sources: trend.sources || [],
      confidence: trend.confidence || 0.5,
      score: trend.score || 0,
      used: true,
      used_at: FieldValue.serverTimestamp(),
      metadata: {}
    };
    
    // Only add metadata fields that are defined
    if (trend.metadata) {
      Object.entries(trend.metadata).forEach(([key, value]) => {
        if (value !== undefined) {
          cleanTrend.metadata[key] = value;
        }
      });
      
      // Handle scoreBreakdown separately
      if (trend.metadata.scoreBreakdown) {
        cleanTrend.metadata.scoreBreakdown = {};
        Object.entries(trend.metadata.scoreBreakdown).forEach(([key, value]) => {
          if (value !== undefined) {
            cleanTrend.metadata.scoreBreakdown[key] = value;
          }
        });
      }
    }
    
    await this.db.collection('trend_history').add(cleanTrend);
    
    logger.debug(`Marked trend as used: ${trend.topic}`);
  } catch (error) {
    logger.error('Error marking trend as used:', error);
  }
}

  shouldGenerateVideo(trend) {
      return false;
    /*
    // More sophisticated video generation decision
    const videoFriendlyCategories = ['tech', 'science', 'entertainment'];
    const category = this.categorizeTrend(trend);
    
    // Higher chance for video-friendly categories
    const baseChance = videoFriendlyCategories.includes(category) ? 0.5 : 0.2;
    
    // Boost chance if high engagement
    const engagementBoost = trend.volume > 10000 ? 0.1 : 0;
    
    // Random decision with calculated probability
    return Math.random() < (baseChance + engagementBoost);
    */
  }

async selectPlatforms(trend) {
  const platforms = [];
  const category = this.categorizeTrend(trend);
  
  logger.debug(`Trend "${trend.topic}" categorized as: ${category}`);
  
  // Check if this is a Generative AI trend
  const isGenAI = this.isGenerativeAITrend(trend);
  
  // Reddit - posts ALL categories
  if (process.env.REDDIT_USERNAME && process.env.REDDIT_PASSWORD) {
    platforms.push('reddit');
    logger.debug('Added Reddit - posts all categories');
  }
  
  // Twitter - posts ALL categories (with rate limit consideration)
  if (process.env.TWITTER_ACCESS_TOKEN) {
    try {
      const lastTwitterPost = await this.getLastPlatformPostFromDB('twitter');
      const hoursSinceLastPost = (Date.now() - lastTwitterPost) / (1000 * 60 * 60);
      
      if (hoursSinceLastPost > 12) {
        platforms.push('twitter');
        logger.debug('Added Twitter - posts all categories');
      } else {
        logger.debug(`Skipping Twitter - posted ${hoursSinceLastPost.toFixed(1)} hours ago (need 12+ hours)`);
      }
    } catch (error) {
      logger.error('Error checking Twitter last post:', error);
      // Default to allowing Twitter if check fails
      platforms.push('twitter');
    }
  }
  
  // LinkedIn - Generative AI news ONLY
  if (process.env.LINKEDIN_ACCESS_TOKEN) {
      logger.info(`📊 LinkedIn Selection Analysis for trend: "${trend.topic}"`);
      logger.info(`Main category: ${category}`);

    const linkedInCategories = ['tech'];
  if (isGenAI || linkedInCategories.includes(category) || (trend.metadata?.category === 'generative_ai')) {
      platforms.push('linkedin');

      logger.debug('Added LinkedIn - Generative AI content detected');
         if (trend.metadata?.category) {
        logger.info(`   📌 Metadata category: "${trend.metadata.category}"`);
      }
        if (trend.matchedCategory) {
        logger.info(`   🏷️ Topic matched category during filtering: "${trend.matchedCategory}"`);
      }
    } else {
      logger.debug(`Skipping LinkedIn - category "${category}" not suitable for LinkedIn`);
    }
  }
  
  // If no platforms available, default to Reddit (most permissive)
  if (platforms.length === 0 && process.env.REDDIT_USERNAME) {
    platforms.push('reddit');
    logger.debug('No platforms available, defaulting to Reddit');
  }
  
  logger.info(`Selected platforms for trend "${trend.topic}" (${category}): ${platforms.join(', ')}`);
  return platforms;
}

// Add this helper method after selectPlatforms
isGenerativeAITrend(trend) {
  const genAIKeywords = [
    // Text Generation
    'gpt', 'claude', 'gemini', 'llama', 'llm', 'large language model',
    'chatbot', 'ai assistant', 'text generation', 'natural language',
    
    // Video/Audio Generation
    'Sora OpenAI', 'Pika Labs', 'Pika 1.0', 'runway', 'voice synthesis', 'speech synthesis',
    'deepfake', 'ai avatar',
    
    // Code & Technical
    'copilot', 'codex', 'code generation', 'mcp', 'Amazon CodeWhisperer', 'Replit AI', 'Ghostwriter',
    'Cursor AI', 'transformer models', 'neural network', 'deep learning', 'machine learning',
    
    // General Gen AI
    'generative ai', 'generative artificial intelligence', 'gen ai',
    'synthetic data', 'ai generated', 'artificially generated', 'vision language model',
    'multimodal ai', 'foundation model', 'pretrained model', 'mmllm',
    
    // Companies & Platforms
    'openai', 'anthropic', 'stability ai', 'hugging face', 'cohere',
    'inflection ai', 'character ai', 'grok', 'meta ai', 'google ai',
    'apple intelligence', 'nvidia', 'perplexity', 'mistral',

    // Industry & Applications
    'AI startup funding',
    'generative AI acquisition',
    'AI regulation', 'AI Act',
  ];
  
  const topicLower = trend.topic.toLowerCase();
  const hasGenAIKeyword = genAIKeywords.some(keyword => topicLower.includes(keyword));
  
  // Also check metadata
  const isGenAICategory = trend.metadata?.category === 'generative_ai';
  const isFromGenAISource = trend.metadata?.source?.includes('genai');
  
  const result = hasGenAIKeyword || isGenAICategory || isFromGenAISource;
  
  if (result) {
    logger.debug(`Trend "${trend.topic}" identified as Generative AI`);
  }
  
  return result;
}

// Add this helper method to track last post times
async getLastPlatformPost(platform) {
  try {
    const oneHourAgo = new Date(Date.now() - (60 * 60 * 1000)); // 1 hour cooldown instead of 12
    
    const snapshot = await this.db
      .collection('published_posts')
      .where('platform', '==', platform)
      .where('published_at', '>', oneHourAgo)
      .orderBy('published_at', 'desc')
      .limit(1)
      .get();
    
    if (!snapshot.empty) {
      const lastPost = snapshot.docs[0].data();
      return lastPost.published_at.toDate();
    }
  } catch (error) {
    logger.debug(`Error checking last ${platform} post:`, error.message);
  }
  
  // Return time that allows posting
  return Date.now() - (2 * 60 * 60 * 1000); // 2 hours ago
}

async getLastPlatformPostFromDB(platform) {
  try {
    const snapshot = await this.db
      .collection('published_posts')
      .where('platform', '==', platform)
      .orderBy('published_at', 'desc')
      .limit(1)
      .get();
    
    if (!snapshot.empty) {
      const lastPost = snapshot.docs[0].data();
      const timestamp = lastPost.published_at?.toDate?.() || lastPost.published_at;
      return new Date(timestamp).getTime();
    }
  } catch (error) {
    logger.error(`Error fetching last ${platform} post:`, error);
  }
  
  // Default to 24 hours ago if no posts found
  return Date.now() - (24 * 60 * 60 * 1000);
}// Update the platform priority weights
getPlatformPriority() {
  return {
    reddit: 1.0,    // Highest priority
    linkedin: 0.5,  // Medium priority
    twitter: 0.3    // Lowest priority due to rate limits
  };
}}export default PostingStrategy;






