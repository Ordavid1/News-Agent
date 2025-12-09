// services/TrendAnalyzer.js
import env from '../config/env.js';
import { TOPIC_CATEGORIES, getEnabledCategories, isTopicInEnabledCategory } from '../config/topicConfig.js';
// Import necessary libraries
import { TwitterApi } from 'twitter-api-v2';
import axios from 'axios';
import winston from 'winston';
import puppeteer from 'puppeteer';
import NewsService from './NewsService.js';

// Logger setup
const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[TrendAnalyzer] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'trend-analyzer.log' })
  ]
});

class TrendAnalyzer {
  constructor() {
    this.sources = {
      twitter: this.initializeTwitter(),
      google: true, // Google Trends doesn't need initialization
      reddit: this.initializeReddit(),
      tiktok: this.initializeTikTok()
    };
    
    // Initialize news service
    this.newsService = new NewsService();
    
    this.sourceWeights = {
      twitter: 0.3,
      google: 0.3,
      reddit: 0.2,
      tiktok: 0.2
    };
    
    // Initialize cache for trends
    this.trendCache = new Map();
    this.cacheTimeout = 60 * 60 * 1000; // 1 hour
    // TikTok rate limiting
    this.tiktokLastScrape = 0;
    this.tiktokMinInterval = 60 * 60 * 1000; // 1 hour minimum between scrapes
    // Schedule trends fetching strategy for free tier
    this.trendsFetchSchedule = {
    lastFetch: 0,
    fetchHour: 6, // Fetch trends at 6 AM daily
    fallbackToSearch: true
    };
  }

  initializeTwitter() {
    try {
      if (!process.env.TWITTER_BEARER_TOKEN) {
        logger.warn('Twitter Bearer token not configured');
        return null;
      }
      return new TwitterApi(process.env.TWITTER_BEARER_TOKEN);
    } catch (error) {
      logger.error('Failed to initialize Twitter client:', error);
      return null;
    }
  }

  initializeReddit() {
    return {
      clientId: process.env.REDDIT_CLIENT_ID,
      clientSecret: process.env.REDDIT_CLIENT_SECRET
    };
  }

  initializeTikTok() {
    return {
      enabled: !!process.env.ENABLE_TIKTOK_SCRAPING
    };
  }

// Add this method to the TrendAnalyzer class
async getGenerativeAINews(hoursBack = 24) {
  try {
    logger.info(`Fetching Generative AI news from last ${hoursBack} hours`);
    
    const genAIKeywords = [
      // Core AI Companies & Models
      'OpenAI GPT',
      'Anthropic Claude',
      'Google Gemini AI',
      'Meta Llama',
      'Microsoft Copilot AI',
      'Mistral AI',
      'Stability AI',
      'Cohere Command',
      'AI21 Labs',
      'Adept AI',
      'Inflection AI',
      'Character AI',
      
      // Emerging Gen AI Technologies
      'generative AI breakthrough',
      'large language model',
      'AI model release',
      'transformer model',
      'multimodal AI',
      'AI agents',
      'autonomous AI systems',
      'AI reasoning',
      'chain of thought',
      'retrieval augmented generation',
      'RAG systems',
      'vector databases AI',
      'AI embeddings',
      
      // Gen AI Applications
      'AI code generation',
      'AI writing assistant',
      'AI image generation',
      'AI video synthesis',
      'AI music generation',
      'AI voice cloning',
      'synthetic media',
      'AI content creation',
      'AI automation',
      'AI workflow',
      
      // Industry & Research
      'AI research paper',
      'AI benchmark',
      'AI evaluation',
      'AI safety research',
      'AI alignment',
      'constitutional AI',
      'AI governance',
      'AI regulation',
      'AI ethics framework',
      
      // Enterprise & Business
      'enterprise AI adoption',
      'AI transformation',
      'AI ROI',
      'AI implementation',
      'AI strategy',
      'generative AI startup',
      'AI unicorn',
      'AI funding round',
      'AI acquisition',
      
      // Technical Advances
      'fine-tuning LLM',
      'prompt engineering',
      'AI model optimization',
      'edge AI deployment',
      'AI inference',
      'model quantization',
      'AI hardware accelerator',
      'neural architecture'
    ];
    
    const results = [];
    
    // Search using Google News RSS for each keyword
    for (const keyword of genAIKeywords) {
      try {
        const rssUrl = `https://news.google.com/rss/search?q="${encodeURIComponent(keyword)}"&hl=en-US&gl=US&ceid=US:en`;
        
        const response = await axios.get(rssUrl, {
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; AINewsBot/1.0)'
          }
        });
        
        const items = this.parseRSSItems(response.data);
        
        // Filter for items from last 24 hours
        const cutoffTime = Date.now() - (hoursBack * 60 * 60 * 1000);
        
        items.forEach(item => {
          const pubDate = new Date(item.pubDate);
          if (pubDate.getTime() > cutoffTime) {
            // Check if it's really about Gen AI
            const isGenAI = this.isGenerativeAIContent(item.title + ' ' + (item.description || ''));
            if (isGenAI) {
            // In the forEach loop where we push results
            results.push({
              topic: this.extractAITopic(item.title),
              title: item.title,
              description: item.description,
              url: item.link, // Make sure this is captured
              publishedAt: pubDate.toISOString(),
              query: keyword,
              volume: 10000,
              confidence: 0.9,
              sources: ['google_news_genai'],
              metadata: {
                source: 'google_news_genai',
                category: 'generative_ai',
                isBreaking: true,
                searchKeyword: keyword,
                originalUrl: item.link // Also store in metadata
              }
            });

            // Debug log
            logger.debug(`Gen AI news item: "${item.title}" - URL: ${item.link}`);
            }
          }
        });
        
      } catch (error) {
        logger.debug(`Error fetching Gen AI news for "${keyword}": ${error.message}`);
      }
    }
    
    // Deduplicate and sort by recency
    const seen = new Set();
    const uniqueResults = results.filter(item => {
      const key = this.normalizeText(item.title);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    
    return uniqueResults.sort((a, b) => 
      new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
    );
    
  } catch (error) {
    logger.error('Error fetching Generative AI news:', error);
    return [];
  }
}

// Helper method to check if content is about Generative AI
isGenerativeAIContent(text) {
  const genAITerms = [
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
  
  const textLower = text.toLowerCase();
  
  // Check for any term match
  const hasGenAI = genAITerms.some(term => textLower.includes(term));
  
  // Also check for pattern matches
  const patterns = [
    /ai\s+(model|system|tool|platform|startup|company)/i,
    /artificial intelligence\s+(model|research|breakthrough)/i,
    /\b(text|image|video|audio|code)\s+to\s+(text|image|video|audio|code)\b/i,
    /\bai[\s-]powered\b/i,
    /\bai[\s-]generated\b/i
  ];
  
  const hasPattern = patterns.some(pattern => pattern.test(text));
  
  return hasGenAI || hasPattern;
}

// Helper to extract clean AI topic
extractAITopic(title) {
  // Remove source attributions
  let topic = title
    .replace(/\s*[-–—]\s*[A-Za-z\s]+\s*$/, '')
    .replace(/\s*\|.*$/, '')
    .trim();
  
  // Shorten if too long
  if (topic.length > 100) {
    topic = topic.substring(0, 97) + '...';
  }
  
  return topic;
}

// Add this to normalize text (if not already present)
normalizeText(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async getOptimizedTwitterTrends(location = 'US') {
  const now = new Date();
  const todayFetchTime = new Date();
  todayFetchTime.setHours(this.trendsFetchSchedule.fetchHour, 0, 0, 0);
  
  // Check if we should fetch fresh trends (once per day at specified hour)
  const shouldFetchFresh = 
    now >= todayFetchTime && 
    this.trendsFetchSchedule.lastFetch < todayFetchTime.getTime();
  
  if (shouldFetchFresh) {
    logger.info('Performing daily trends fetch...');
    const trends = await this.getPersonalizedTrends(location);
    if (trends && trends.length > 0) {
      this.trendsFetchSchedule.lastFetch = Date.now();
      return trends;
    }
  }
  
  // For all other times, use search-based trends
  logger.debug('Using search-based trends (preserving daily trends quota)');
  return await this.getSearchBasedTrends(location);
}

  async getAggregatedTrends(options = {}) {
    const {
      location = 'US',
      sources = ['twitter', 'google', 'reddit'],
      category = null,
      limit = 10
    } = options;

    logger.info(`Fetching trends from sources: ${sources.join(', ')}`);
    
    const allTrends = [];
    
    // Fetch from each source in parallel
    const trendPromises = sources.map(source => 
      this.getTrendsFromSource(source, location, category)
        .catch(error => {
          logger.error(`Error fetching from ${source}:`, error.message);
          return [];
        })
    );
    
    const results = await Promise.all(trendPromises);
    
    // Aggregate and normalize trends
    results.forEach((trends, index) => {
      const source = sources[index];
      trends.forEach(trend => {
        allTrends.push({
          ...trend,
          source,
          weight: this.sourceWeights[source] || 0.1
        });
      });
    });
    
    // Score and rank trends
    const rankedTrends = this.rankTrends(allTrends, category);
    
    return rankedTrends.slice(0, limit);
  }

  async getTrendsFromSource(source, location, category) {
    const cacheKey = `${source}_${location}_${category || 'all'}`;
    const cached = this.trendCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      logger.debug(`Using cached trends for ${cacheKey}`);
      return cached.data;
    }
    
    let trends = [];
    
    switch (source) {
      case 'twitter':
        trends = await this.getTwitterTrends(location);
        break;
      case 'google':
        trends = await this.getGoogleTrends(location);
        break;
      case 'reddit':
        trends = await this.getRedditTrends(category);
        break;
      case 'tiktok':
        trends = await this.getTikTokTrends(location);
        break;
      default:
        logger.warn(`Unknown trend source: ${source}`);
    }
    
    // Cache the results
    this.trendCache.set(cacheKey, {
      data: trends,
      timestamp: Date.now()
    });
    
    return trends;
  }

  /**
   * Twitter API v2 Implementation
   */
async getTwitterTrends(location = 'worldwide') {
  if (!this.sources.twitter) {
    logger.warn('Twitter client not initialized');
    return [];
  }

  try {
    // First, try v2 personalized trends (free tier - once per day)
    const personalizedTrends = await this.getPersonalizedTrends(location);
    if (personalizedTrends && personalizedTrends.length > 0) {
      return personalizedTrends;
    }
    } catch (error) {
    logger.debug('Personalized trends not available:', error.message);
  }

  try {
    // Map location to WOEID (Where On Earth ID)
    const woeids = { 
    'worldwide': 1, 'US': 23424977, 'UK': 23424975, 'IL': 23424852, 'CA': 23424775, 'AU': 23424748,
    'IN': 23424848, 'JP': 23424856, 'BR': 23424768, 'MX': 23424900, 'ES': 23424950, 'FR': 23424819, 'DE': 23424829,
    'IT': 23424853, 'NL': 23424909, 'SE': 23424954, 'NO': 23424910, 'DK': 23424796, 'FI': 23424812, 'PL': 23424923,
    'RU': 23424936, 'TR': 23424969, 'SA': 23424938, 'AE': 23424738, 'ZA': 23424942, 'NG': 23424908, 'EG': 23424802,
    'KE': 23424863, 'AR': 23424747, 'CL': 23424782, 'CO': 23424787, 'PE': 23424919, 'VE': 23424982, 'SG': 23424948,
    'MY': 23424901, 'TH': 23424960, 'ID': 23424846, 'PH': 23424934, 'VN': 23424984, 'KR': 23424868, 'CN': 23424781,
    'HK': 23424865, 'TW': 23424971, 'NZ': 23424916 
  };
    
    const woeid = woeids[location] || woeids['worldwide'];
    
    // Check if we have elevated access (trends endpoint requires it)
    try {
      const trendsResponse = await this.sources.twitter.v1.get('trends/place.json', {
        id: woeid
      });
      
      if (!trendsResponse || !trendsResponse[0]?.trends) {
        throw new Error('Invalid trends response');
      }
      
      // Process trends with enhanced metadata
      const trends = trendsResponse[0].trends.map(trend => ({
        topic: trend.name.replace(/^#/, ''),
        query: trend.query,
        volume: trend.tweet_volume || this.estimateVolume(trend),
        metadata: {
          source: 'twitter_trends_api',
          promoted: trend.promoted_content || false,
          url: trend.url,
          woeid: woeid,
          location: location,
          timestamp: new Date().toISOString()
        }
      }));
      
      // Cache successful response
      this.lastSuccessfulTrendsCall = Date.now();
      
      return trends;
      
    } catch (trendsError) {
      // Log specific error for trends endpoint
      if (trendsError.code === 403) {
        logger.warn('Twitter Trends API requires Elevated access. Falling back to search-based trends.');
      } else {
        logger.error('Twitter trends API error:', trendsError.message);
      }
      
      // Fallback to search-based trends
      return await this.getSearchBasedTrends(location);
    }
    
  } catch (error) {
    logger.error('Twitter trends error:', error);
    return [];
  }
}

async getPersonalizedTrends(location = 'US') {
  if (!this.sources.twitter) {
    logger.warn('Twitter client not initialized');
    return [];
  }

  try {
    // Check if we've already fetched trends today
    const lastFetchKey = 'twitter_personalized_trends_last_fetch';
    const cached = this.trendCache.get(lastFetchKey);
    
    if (cached && Date.now() - cached.timestamp < 24 * 60 * 60 * 1000) {
      logger.info('Using cached personalized trends (24-hour limit)');
      return cached.data;
    }

    logger.info('Fetching v2 personalized trends (once per day limit)...');
    
    // v2 endpoint requires user context, but we can try with app-only auth
    const response = await this.sources.twitter.v2.get('users/personalized_trends', {
      'trend.fields': ['context', 'description', 'entity', 'name', 'trend_name']
    });

    if (!response.data) {
      throw new Error('No trends data received');
    }

    const trends = response.data.map(trend => ({
      topic: trend.trend_name || trend.name,
      query: trend.name,
      volume: 0, // v2 doesn't provide volume
      metadata: {
        source: 'twitter_v2_personalized',
        description: trend.description,
        context: trend.context,
        timestamp: new Date().toISOString()
      }
    }));

    // Cache for 24 hours due to rate limit
    this.trendCache.set(lastFetchKey, {
      data: trends,
      timestamp: Date.now()
    });

    logger.info(`✅ Fetched ${trends.length} personalized trends (cached for 24 hours)`);
    return trends;

  } catch (error) {
    logger.error('Personalized trends error:', error);
    // Fall back to search-based trends
    return await this.getSearchBasedTrends(location);
  }
}

// Implement the missing search-based trends fallback
async getSearchBasedTrends(location) {
  try {
    // Rate limit tracking
    if (!this.twitterRateLimitReset) {
      this.twitterRateLimitReset = 0;
    }
    
    // Check if we're rate limited
    if (Date.now() < this.twitterRateLimitReset) {
      logger.warn(`Twitter rate limited until ${new Date(this.twitterRateLimitReset).toISOString()}`);
      return [];
    }
    
    // Use simpler, less restrictive queries to avoid 400 errors
    const searchQueries = this.getSimplifiedLocationQueries(location);
    const trendCandidates = new Map();
    
    // Try each query, but stop if we hit rate limits
    for (const query of searchQueries) {
      try {
        logger.debug(`Trying Twitter search query: "${query}"`);
        
        const tweets = await this.sources.twitter.v2.search(query, {
          max_results: 50, // Reduced from 100
          'tweet.fields': ['created_at', 'public_metrics', 'entities'],
          // Remove expansions to reduce API usage
        });
        
        if (!tweets.data || tweets.data.length === 0) {
          logger.debug('No tweets found for query');
          continue;
        }
        
        logger.debug(`Found ${tweets.data.length} tweets`);
        
        // Extract trends from tweets
        tweets.data.forEach(tweet => {
          // Extract hashtags
          if (tweet.entities?.hashtags) {
            tweet.entities.hashtags.forEach(hashtag => {
              const tag = hashtag.tag.toLowerCase();
              const current = trendCandidates.get(tag) || { count: 0, engagement: 0, tweets: [] };
              current.count++;
              current.engagement += (tweet.public_metrics?.like_count || 0) + 
                                   (tweet.public_metrics?.retweet_count || 0) * 2;
              current.tweets.push(tweet.id);
              trendCandidates.set(tag, current);
            });
          }
          
          // Extract key phrases from tweet text
          const keyPhrases = this.extractKeyPhrasesFromTweet(tweet.text);
          keyPhrases.forEach(phrase => {
            const current = trendCandidates.get(phrase) || { count: 0, engagement: 0, tweets: [] };
            current.count++;
            current.engagement += (tweet.public_metrics?.like_count || 0) + 
                                 (tweet.public_metrics?.retweet_count || 0) * 2;
            current.tweets.push(tweet.id);
            trendCandidates.set(phrase, current);
          });
        });
        
        // If we got good results from one query, that might be enough
        if (trendCandidates.size > 10) {
          break;
        }
        
      } catch (queryError) {
        if (queryError.code === 429) {
          // Extract rate limit reset time if available
          const resetTime = queryError.rateLimit?.reset || Date.now() + (15 * 60 * 1000); // 15 min default
          this.twitterRateLimitReset = resetTime * 1000; // Convert to milliseconds
          logger.warn(`Twitter rate limit hit. Reset at ${new Date(this.twitterRateLimitReset).toISOString()}`);
          break; // Stop trying more queries
        } else if (queryError.code === 400) {
          logger.debug(`Invalid query format: "${query}"`);
          continue; // Try next query
        } else {
          logger.error(`Twitter search error: ${queryError.message}`);
          continue;
        }
      }
    }
    
    // Convert to trends array and sort by relevance
    const trends = Array.from(trendCandidates.entries())
      .filter(([topic, data]) => {
        // More relaxed filtering
        return data.count >= 2 && topic.length > 2; // Lowered from 3 to 2
      })
      .map(([topic, data]) => ({
        topic: topic,
        query: topic,
        volume: data.engagement,
        metadata: {
          source: 'twitter_search',
          tweet_count: data.count,
          engagement_score: data.engagement,
          sample_tweets: data.tweets.slice(0, 3),
          location: location,
          timestamp: new Date().toISOString()
        }
      }))
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 20);
    
    logger.info(`Twitter search found ${trends.length} trends`);
    return trends;
    
  } catch (error) {
    logger.error('Search-based trends error:', error);
    return [];
  }
}

// Simplified query builder to avoid 400 errors
getSimplifiedLocationQueries(location) {
  // Start with very simple queries that are less likely to fail
  const baseQueries = [
    'has:hashtags -is:retweet lang:en',
    'trending -is:retweet lang:en',
    'min_faves:100 -is:retweet',
  ];
  
  // Add location-specific queries if needed
  const locationSpecific = {
    'US': [
      '"United States" -is:retweet',
      'USA -is:retweet',
    ],
    'UK': [
      '"United Kingdom" -is:retweet',
      'UK -is:retweet',
    ],
    'IL': [
      'Israel -is:retweet',
      'ישראל -is:retweet',
    ]
  };
  
  const queries = [...baseQueries];
  
  if (locationSpecific[location]) {
    queries.push(...locationSpecific[location]);
  }
  
  return queries;
}

// Helper to extract meaningful phrases from tweets
extractKeyPhrasesFromTweet(text) {
  if (!text) return [];
  
  // Remove URLs, mentions, and clean text
  const cleaned = text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/@\w+/g, '')
    .replace(/[^\w\s#]/g, ' ')
    .toLowerCase();
  
  // Extract phrases (2-3 word combinations)
  const words = cleaned.split(/\s+/).filter(word => 
    word.length > 3 && 
    !this.isStopWord(word) &&
    !word.startsWith('#')
  );
  
  const phrases = [];
  
  // Single important words
  words.forEach(word => {
    if (word.length > 5) { // Only longer words as standalone trends
      phrases.push(word);
    }
  });
  
  // Bi-grams
  for (let i = 0; i < words.length - 1; i++) {
    if (!this.isStopWord(words[i]) && !this.isStopWord(words[i + 1])) {
      phrases.push(`${words[i]} ${words[i + 1]}`);
    }
  }
  
  return [...new Set(phrases)]; // Remove duplicates
}

// Estimate volume when not provided
estimateVolume(trend) {
  // Simple heuristic based on trend position and name patterns
  const position = trend.position || 50;
  const baseVolume = Math.max(1000, 50000 - (position * 1000));
  
  // Boost for hashtags with certain patterns
  if (trend.name.match(/^#[A-Z]/)) { // Hashtags starting with capital
    return baseVolume * 1.5;
  }
  
  return baseVolume;
}
  /**
   * Google Trends Alternative Implementation
   */
// Updated getGoogleTrends and related methods for TrendAnalyzer.js

async getGoogleTrends(location = 'US') {
  try {
    logger.debug(`Fetching Google trends for location: ${location}`);
    
    // Option 1: Use SerpAPI (if available)
    if (process.env.SERPAPI_KEY) {
      const serpTrends = await this.getGoogleTrendsViaSerpAPI(location);
      if (serpTrends && serpTrends.length > 0) {
        logger.info(`✅ Google Trends via SerpAPI - Found ${serpTrends.length} trends`);
        return serpTrends;
      }
    }
    
    // Option 2: Fallback to Google News RSS (always available)
    const newsTrends = await this.getGoogleNewsTopics(location);
    if (newsTrends && newsTrends.length > 0) {
      logger.info(`✅ Google Trends via News RSS - Found ${newsTrends.length} trends`);
      return newsTrends;
    }
    
    logger.warn('No Google trends found from any source');
    return [];
    
  } catch (error) {
    logger.error('Google trends error:', error);
    return [];
  }
}

async getGoogleTrendsViaSerpAPI(location) {
  try {
    const response = await axios.get('https://serpapi.com/search', {
      params: {
        engine: 'google_trends',
        q: '', // Empty query gets trending searches
        data_type: 'TIMESERIES',
        geo: location,
        api_key: process.env.SERPAPI_KEY
      },
      timeout: 10000 // 10 second timeout
    });
    
    // Check if we have trending searches
    const trendingSearches = response.data.trending_searches?.daily || [];
    
    return trendingSearches.flatMap(day => 
      day.searches?.map(search => ({
        topic: search.query,
        query: search.query,
        volume: parseInt(search.formattedTraffic?.replace(/[+,]/g, '') || '0'),
        metadata: {
          source: 'google_trends_serpapi',
          articles: search.articles?.slice(0, 3).map(a => ({
            title: a.title,
            source: a.source,
            url: a.url
          })) || [],
          timestamp: new Date().toISOString()
        }
      })) || []
    );
    
  } catch (error) {
    if (error.response?.status === 401) {
      logger.error('SerpAPI authentication failed - check API key');
    } else {
      logger.debug('SerpAPI error:', error.message);
    }
    return [];
  }
}

async getGoogleNewsTopics(location = 'US') {
  try {
    // Build RSS URL with proper parameters
    const locationCodes = {
      'US': { hl: 'en-US', gl: 'US', ceid: 'US:en' },
      'UK': { hl: 'en-GB', gl: 'GB', ceid: 'GB:en' },
      'IL': { hl: 'he-IL', gl: 'IL', ceid: 'IL:he' },
      'worldwide': { hl: 'en', gl: 'US', ceid: 'US:en' }
    };
    
    const { hl, gl, ceid } = locationCodes[location] || locationCodes['worldwide'];
    
    // Use trending topics RSS feed
    const rssUrl = `https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRFZxYUdjU0FtVnVHZ0pWVXlnQVAB?hl=${hl}&gl=${gl}&ceid=${ceid}`;
    
    logger.debug(`Fetching Google News RSS from: ${rssUrl}`);
    
    const response = await axios.get(rssUrl, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TrendAnalyzer/1.0)'
      }
    });
    
    const xml = response.data;
    
    // Parse RSS feed
    const items = this.parseRSSItems(xml);
    const topicMap = new Map();
    
    // Extract topics from news items
    items.forEach(item => {
      // Extract key phrases from title
      const title = item.title || '';
      const cleanTitle = this.cleanNewsTitle(title);
      
      // Extract entities and topics
      const topics = this.extractTopicsFromNews(cleanTitle);
      
      topics.forEach(topic => {
        const current = topicMap.get(topic) || { count: 0, articles: [] };
        current.count++;
        current.articles.push({
          title: title,
          link: item.link,
          pubDate: item.pubDate
        });
        topicMap.set(topic, current);
      });
    });
    
    // Convert to trends format
    const trends = Array.from(topicMap.entries())
      .filter(([topic, data]) => {
        // Filter quality
        return data.count >= 2 && // Mentioned in at least 2 articles
               topic.length > 4 && // Not too short
               topic.split(' ').length <= 4; // Not too long
      })
      .map(([topic, data]) => ({
        topic,
        query: topic,
        volume: data.count * 5000, // Estimated volume based on mentions
        metadata: {
          source: 'google_news_rss',
          mentions: data.count,
          articles: data.articles.slice(0, 3),
          location: location,
          timestamp: new Date().toISOString()
        }
      }))
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 20);
    
    return trends;
    
  } catch (error) {
    logger.error('Google News RSS error:', error.message);
    return [];
  }
}

// Helper to parse RSS items
parseRSSItems(xml) {
  const items = [];
  
  // Simple regex-based RSS parsing
  const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
  
  itemMatches.forEach(itemXml => {
    const title = this.extractXMLTag(itemXml, 'title');
    const link = this.extractXMLTag(itemXml, 'link');
    const pubDate = this.extractXMLTag(itemXml, 'pubDate');
    const description = this.extractXMLTag(itemXml, 'description');
    
    if (title) {
      items.push({ title, link, pubDate, description });
    }
  });
  
  return items;
}

// Helper to extract XML tag content
extractXMLTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  if (match) {
    return match[1] || match[2] || '';
  }
  return '';
}

// Clean news title from source attribution
cleanNewsTitle(title) {
  // Remove news source attributions
  return title
    .replace(/\s*[-–—]\s*[A-Za-z\s]+\s*$/, '') // Remove "- CNN" style attributions
    .replace(/\s*\|.*$/, '') // Remove "| Reuters" style
    .replace(/\s*·.*$/, '') // Remove "· 2 hours ago" style
    .trim();
}

// Extract meaningful topics from news title
extractTopicsFromNews(title) {
  const topics = [];
  
  // Your existing extraction logic...
  const cleaned = title
    .replace(/[^\w\s]/g, ' ')
    .toLowerCase()
    .trim();
  
  const words = cleaned.split(/\s+/).filter(word => 
    word.length > 3 && !this.isStopWord(word)
  );
  
  // Extract entities (capitalized in original)
  const entities = title.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g) || [];
  entities.forEach(entity => {
    if (entity.length > 4 && !this.isStopWord(entity.toLowerCase())) {
      // Check if entity matches enabled categories
      const categoryCheck = isTopicInEnabledCategory(entity);
      if (categoryCheck.allowed) {
        topics.push(entity.toLowerCase());
      }
    }
  });
  
  // ADD: Skip generic single words
  const genericSingleWords = ['breaking', 'latest', 'news', 'update', 'report'];

  // Extract meaningful phrases
  for (let i = 0; i < words.length - 1; i++) {
    if (genericSingleWords.includes(words[i])) continue;
    const bigram = `${words[i]} ${words[i + 1]}`;
    
    // Check if phrase matches enabled categories
    const categoryCheck = isTopicInEnabledCategory(bigram);
    if (categoryCheck.allowed && !this.isGenericPhrase(bigram)) {
      topics.push(bigram);
    }
    
    // Try trigrams for better context
    if (i < words.length - 2) {
      const trigram = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
      const trigramCheck = isTopicInEnabledCategory(trigram);
      if (trigramCheck.allowed && !this.isGenericPhrase(trigram) && trigram.length < 30) {
        topics.push(trigram);
      }
    }
  }
  
  // Add important single words
  words.forEach(word => {
    if (word.length > 5 && !this.isStopWord(word)) {
      const categoryCheck = isTopicInEnabledCategory(word);
      if (categoryCheck.allowed) {
        topics.push(word);
      }
    }
  });
  
  return [...new Set(topics)]; // Remove duplicates
}

// Check if phrase is too generic
isGenericPhrase(phrase) {
  const genericPhrases = [
    'has been', 'will be', 'could be', 'may be',
    'said that', 'according to', 'due to',
    'the first', 'the last', 'the best',
    'new study', 'recent report', 'latest news'
  ];
  
  return genericPhrases.some(generic => phrase.includes(generic));
}

  /**
   * Reddit Implementation with proper authentication
   */
  async getRedditTrends(category = null) {
    try {
      // First, get access token
      const token = await this.getRedditToken();
      
      if (!token) {
        logger.warn('Failed to get Reddit token');
        return [];
      }
      
      // Determine subreddits based on category
      const subreddits = this.getRedditSubreddits(category);
      
      // Fetch hot posts from multiple subreddits
      const trendPromises = subreddits.map(subreddit => 
        this.fetchRedditHot(subreddit, token)
      );
      
      const results = await Promise.all(trendPromises);
      const allPosts = results.flat();
      
      // Extract trends from post titles and discussions
      const trends = this.extractRedditTrends(allPosts);
      
      return trends;
      
    } catch (error) {
      logger.error('Reddit trends error:', error);
      return [];
    }
  }

async getRedditToken() {
  if (!this.sources.reddit.clientId || !this.sources.reddit.clientSecret) {
    logger.warn('Reddit credentials not configured');
    return null;
  }

  try {
    const auth = Buffer.from(
      `${this.sources.reddit.clientId}:${this.sources.reddit.clientSecret}`
    ).toString('base64');
    
    const response = await axios.post(
      'https://www.reddit.com/api/v1/access_token',
      'grant_type=client_credentials',
      {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'TrendAnalyzer/1.0'
        }
      }
    );
    
    return response.data.access_token;
  } catch (error) {
    logger.error('Reddit auth error:', error.response?.data || error.message);
    return null;
  }
}

  getRedditSubreddits(category) {
    // If a specific category is requested and it's enabled
    if (category && TOPIC_CATEGORIES[category] && TOPIC_CATEGORIES[category].enabled) {
      return TOPIC_CATEGORIES[category].subreddits;
    }
    
    // Otherwise, get all subreddits from enabled categories
    const enabledSubreddits = [];
    Object.entries(TOPIC_CATEGORIES).forEach(([_, config]) => {
      if (config.enabled) {
        enabledSubreddits.push(...config.subreddits);
      }
    });
    
    // Remove duplicates and return
    return [...new Set(enabledSubreddits)];
  }

async fetchRedditHot(subreddit, token) {
  try {
    const response = await axios.get(
      `https://oauth.reddit.com/r/${subreddit}/hot`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'TrendAnalyzer/1.0'
        },
        params: {
          limit: 25,
          t: 'day'
        }
      }
    );
    
    return response.data.data.children.map(child => child.data);
  } catch (error) {
    logger.error(`Error fetching Reddit r/${subreddit}:`, {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      message: error.message
    });
    return [];
  }
}

  extractRedditTrends(posts) {
    const trendMap = new Map();
    
    posts.forEach(post => {
      // Extract key phrases from titles
      const keywords = this.extractKeyPhrases(post.title);
      
      keywords.forEach(keyword => {
        const current = trendMap.get(keyword) || {
          count: 0,
          score: 0,
          posts: []
        };
        
        current.count += 1;
        current.score += post.score || 0;
        current.posts.push({
          title: post.title,
          url: `https://reddit.com${post.permalink}`,
          subreddit: post.subreddit
        });
        
        trendMap.set(keyword, current);
      });
    });
    
    return Array.from(trendMap.entries())
      .filter(([_, data]) => data.count >= 2)
      .map(([topic, data]) => ({
        topic,
        query: topic,
        volume: data.score,
        metadata: {
          mentions: data.count,
          avgScore: Math.round(data.score / data.count),
          sources: data.posts.slice(0, 3)
        }
      }))
      .sort((a, b) => b.volume - a.volume);
  }

  /**
   * TikTok Trends Implementation
   */
  async getTikTokTrends(location = 'US') {
    if (!this.sources.tiktok?.enabled) {
      logger.warn('TikTok scraping not enabled');
      return [];
    }

    const now = Date.now();
    if (now - this.tiktokLastScrape < this.tiktokMinInterval) {
      logger.debug('Using cached TikTok trends (rate limit protection)');
      return this.trendCache.get(`tiktok_${location}_all`)?.data || [];
    }
    
    this.tiktokLastScrape = now;
    
    try {
      return await this.scrapeTikTokWithPuppeteer(location);
    } catch (error) {
      logger.error('TikTok trends error:', error);
      return [];
    }
  }

  async scrapeTikTokWithPuppeteer(location = 'US') {
    const browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1920,1080'
      ]
    });

    try {
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
      
      const urls = {
        'US': 'https://www.tiktok.com/discover',
        'UK': 'https://www.tiktok.com/discover?lang=en-GB',
        'IL': 'https://www.tiktok.com/discover?lang=he-IL'
      };
      
      const url = urls[location] || urls['US'];
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      
      // Simple extraction - just get visible text that looks like trends
      const trends = await page.evaluate(() => {
        const elements = document.querySelectorAll('a[href*="/tag/"], .challenge-item');
        return Array.from(elements).map(el => ({
          topic: el.textContent.trim().replace('#', ''),
          url: el.href
        })).filter(t => t.topic.length > 2);
      });
      
      return trends.map(trend => ({
        topic: trend.topic,
        query: trend.topic,
        volume: 0,
        metadata: {
          source: 'tiktok_scraper',
          url: trend.url
        }
      }));
      
    } catch (error) {
      logger.error('Error scraping TikTok:', error);
      return [];
    } finally {
      await browser.close();
    }
  }

  /**
   * Helper Methods
   */
  extractKeyPhrases(text) {
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were'
    ]);
    
    const cleaned = text
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[^\w\s]/g, ' ')
      .toLowerCase();
    
    const words = cleaned.split(/\s+/)
      .filter(word => word.length > 3 && !stopWords.has(word));
    
    const phrases = [];
    for (let i = 0; i < words.length - 1; i++) {
      if (!stopWords.has(words[i]) && !stopWords.has(words[i + 1])) {
        phrases.push(`${words[i]} ${words[i + 1]}`);
      }
    }
    
    return [...new Set([...words, ...phrases])];
  }

  isStopWord(word) {
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
      'have', 'has', 'had', 'will', 'would', 'could', 'should', 'may', 'might'
    ]);
    return stopWords.has(word);
  }

  rankTrends(trends, category) {
    const trendScores = new Map();
    
    trends.forEach(trend => {
      const key = this.normalizeTrendTopic(trend.topic);
      const existing = trendScores.get(key) || {
        topic: trend.topic,
        score: 0,
        sources: [],
        volume: 0,
        metadata: {}
      };
      
      const volumeScore = Math.log10(trend.volume + 1) * trend.weight;
      existing.score += volumeScore;
      existing.sources.push(trend.source);
      existing.volume += trend.volume;
      existing.metadata[trend.source] = trend.metadata;
      
      trendScores.set(key, existing);
    });
    
    return Array.from(trendScores.values())
      .map(trend => ({
        ...trend,
        score: trend.score * Math.sqrt(trend.sources.length),
        confidence: this.calculateConfidence(trend),
        sources: [...new Set(trend.sources)]
      }))
      .sort((a, b) => b.score - a.score);
  }

  normalizeTrendTopic(topic) {
    return topic
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  calculateConfidence(trend) {
    const sourceCount = trend.sources.length;
    const hasVolume = trend.volume > 0;
    
    let confidence = 0.5;
    confidence += (sourceCount - 1) * 0.15;
    if (hasVolume) confidence += 0.2;
    
    return Math.min(confidence, 1.0);
  }

  async filterTrends(trends, options = {}) {
    const {
      excludeControversial = true,
      excludeAdult = true,
      minConfidence = 0.6
    } = options;
    
    const blacklist = [
      ...(excludeControversial ? [
       //  'death', 'killed', 'murder', 'suicide', 'violence'
      ] : []),
      ...(excludeAdult ? [
        'nsfw', 'adult', 'explicit', 'nude', 'porn', 'sex'
      ] : [])
    ];
    
    return trends.filter(trend => {
      if (trend.confidence < minConfidence) return false;
      
      const lowerTopic = trend.topic.toLowerCase();
      const isBlacklisted = blacklist.some(word => 
        lowerTopic.includes(word)
      );
      
      return !isBlacklisted;
    });
  }

  // New method for fetching news based on user topics
  async getTrendsForTopics(topics, options = {}) {
    try {
      const { keywords = [], geoFilter = {} } = options;
      logger.info(`Fetching trends for topics: ${topics.join(', ')}, keywords: ${keywords.length > 0 ? keywords.join(', ') : 'none'}, region: ${geoFilter.region || 'global'}`);

      // Get news from news APIs - pass keywords and geoFilter
      const newsArticles = await this.newsService.getNewsForTopics(topics, {
        limit: options.limit || 20,
        language: options.language || 'en',
        sortBy: options.sortBy || 'relevance',
        keywords,
        geoFilter
      });
      
      // Transform news articles to trend format
      const trends = newsArticles.map(article => ({
        title: article.title,
        description: article.description || article.content,
        summary: article.description || article.content,
        url: article.url,
        imageUrl: article.urlToImage,
        publishedAt: article.publishedAt,
        source: article.source.name,
        sourceApi: article.source.api,
        topic: article.topic,
        score: article.relevanceScore || 0,
        engagement: {
          likes: 0,
          shares: 0,
          comments: 0
        }
      }));
      
      // If we have Twitter access, try to get engagement data
      if (this.sources.twitter) {
        await this.enrichWithTwitterEngagement(trends);
      }
      
      return trends;
      
    } catch (error) {
      logger.error('Error fetching trends for topics:', error);
      
      // Fallback to mock data if APIs fail
      if (process.env.NODE_ENV === 'development') {
        logger.info('Using mock trends for development');
        return this.getMockTrends(topics);
      }
      
      throw error;
    }
  }
  
  async enrichWithTwitterEngagement(trends) {
    // Try to find tweets about these topics to get engagement metrics
    // This is optional enhancement
    try {
      for (const trend of trends) {
        // Search for tweets about this news
        const searchQuery = trend.title.substring(0, 100);
        // Implementation would search Twitter for related tweets
        // and aggregate engagement metrics
      }
    } catch (error) {
      logger.debug('Could not enrich with Twitter engagement:', error.message);
    }
  }
  
  getMockTrends(topics) {
    const mockTrends = [];
    
    for (const topic of topics) {
      mockTrends.push({
        title: `Breaking: Major development in ${topic} industry`,
        description: `Important news about ${topic} that impacts the industry.`,
        summary: `This is a significant development in the ${topic} space that professionals should know about.`,
        url: 'https://example.com/news',
        publishedAt: new Date().toISOString(),
        source: 'Mock News',
        sourceApi: 'mock',
        topic,
        score: 100,
        engagement: {
          likes: 1000,
          shares: 500,
          comments: 200
        }
      });
    }
    
    return mockTrends;
  }
}

// Export singleton instance
const trendAnalyzer = new TrendAnalyzer();
export default trendAnalyzer;

// Also export class for testing
export { TrendAnalyzer };