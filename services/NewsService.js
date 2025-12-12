// services/NewsService.js
import axios from 'axios';
import winston from 'winston';
import { getTopicSearchQueries, getTopicKeywords } from '../config/topicMappings.js';
// Import Hebrew search module for Israeli news sources
import { fetchFromGoogleCSE_HEBREW, SOURCE_TIERS as HEBREW_SOURCE_TIERS } from '../public/components/hebrewSearch.mjs';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[NewsService] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

class NewsService {
  constructor() {
    this.newsApiKey = process.env.NEWSAPI_KEY;
    this.gnewsApiKey = process.env.GNEWS_API_KEY;
    this.googleApiKey = process.env.GOOGLE_CSE_API_KEY;
    this.googleCseId = process.env.GOOGLE_CSE_ID;
    
    // Topic mappings are now loaded dynamically from config
    // This allows for better scalability and easier maintenance
    
    // Cache for news to avoid hitting API limits
    this.newsCache = new Map();
    this.cacheTimeout = 30 * 60 * 1000; // 30 minutes
  }

  async getNewsForTopics(topics, options = {}) {
    const {
      limit = 10,
      language = 'en',
      sortBy = 'relevance',
      sources = ['newsapi', 'gnews'],
      keywords = [],
      geoFilter = {}
    } = options;

    const { region = '', includeGlobal = true } = geoFilter;

    // Determine if we should use Hebrew search
    const isHebrewRegion = region.toLowerCase() === 'il';
    const effectiveLanguage = isHebrewRegion ? 'he' : language;

    logger.info(`Fetching news for topics: ${topics.join(', ')}, keywords: ${keywords.length > 0 ? keywords.join(', ') : 'none'}, region: ${region || 'global'}, language: ${effectiveLanguage}`);

    const allNews = [];

    // Build search queries from topics and keywords
    const searchTerms = [...topics];
    if (keywords.length > 0) {
      // Add keywords to search (strip # from hashtags for search)
      const cleanKeywords = keywords.map(k => k.replace(/^#/, ''));
      searchTerms.push(...cleanKeywords);
    }

    // Fetch news for each topic
    for (const topic of topics) {
      const cacheKey = `${topic}_${effectiveLanguage}_${sortBy}_${region}_${keywords.join(',')}`;
      const cached = this.getFromCache(cacheKey);

      if (cached) {
        logger.debug(`Using cached news for topic: ${topic}`);
        allNews.push(...cached);
        continue;
      }

      const topicNews = [];

      // For Israel region, prioritize Hebrew search sources
      if (isHebrewRegion) {
        try {
          logger.info(`Using Hebrew search for topic: ${topic}`);
          const hebrewResults = await this.fetchFromHebrewSources(topic, { keywords, region });
          topicNews.push(...hebrewResults);
        } catch (error) {
          logger.error(`Hebrew search error for topic ${topic}:`, error.message);
        }
      }

      // Try different news sources (as fallback or primary for non-Hebrew)
      if (topicNews.length === 0 || !isHebrewRegion) {
        if (sources.includes('newsapi') && this.newsApiKey && this.newsApiKey !== 'mock-key') {
          try {
            const newsApiResults = await this.fetchFromNewsAPI(topic, effectiveLanguage, sortBy, { keywords, region });
            topicNews.push(...newsApiResults);
          } catch (error) {
            logger.error(`NewsAPI error for topic ${topic}:`, error.message);
          }
        }

        if (sources.includes('gnews') && this.gnewsApiKey && this.gnewsApiKey !== 'mock-key') {
          try {
            const gnewsResults = await this.fetchFromGNews(topic, effectiveLanguage, sortBy, { keywords, region });
            topicNews.push(...gnewsResults);
          } catch (error) {
            logger.error(`GNews error for topic ${topic}:`, error.message);
          }
        }

        // If no real APIs available or no results, use Google Custom Search
        if (topicNews.length === 0 && this.googleApiKey && this.googleApiKey !== 'mock-key') {
          try {
            const googleResults = await this.fetchFromGoogleCSE(topic, effectiveLanguage, { keywords, region });
            topicNews.push(...googleResults);
          } catch (error) {
            logger.error(`Google CSE error for topic ${topic}:`, error.message);
          }
        }
      }

      // If includeGlobal is true and we're in Hebrew mode, also fetch some global news
      if (isHebrewRegion && includeGlobal && topicNews.length < limit) {
        try {
          logger.info(`Fetching global news to supplement Hebrew results for topic: ${topic}`);
          const globalResults = await this.fetchFromGoogleCSE(topic, 'en', { keywords, region: '' });
          // Add global results but mark them
          globalResults.forEach(article => {
            article.isGlobal = true;
          });
          topicNews.push(...globalResults.slice(0, Math.max(3, limit - topicNews.length)));
        } catch (error) {
          logger.debug(`Global news supplement error for topic ${topic}:`, error.message);
        }
      }

      // Cache the results
      if (topicNews.length > 0) {
        this.saveToCache(cacheKey, topicNews);
      }

      allNews.push(...topicNews);
    }

    // Apply keyword filtering to results if keywords were specified
    let filteredNews = allNews;
    if (keywords.length > 0) {
      filteredNews = this.filterByKeywords(allNews, keywords);
      logger.info(`Filtered ${allNews.length} articles down to ${filteredNews.length} using keywords`);
    }

    // Deduplicate and sort by relevance/date
    const uniqueNews = this.deduplicateNews(filteredNews);
    const sortedNews = this.sortNews(uniqueNews, sortBy);

    return sortedNews.slice(0, limit);
  }

  /**
   * Fetch news from Hebrew sources using the dedicated Hebrew search module
   * @param {string} topic - Topic to search for
   * @param {Object} filters - Additional filters (keywords, region)
   * @returns {Array} Array of news articles
   */
  async fetchFromHebrewSources(topic, filters = {}) {
    const { keywords = [] } = filters;

    // Build Hebrew search query
    let searchQuery = topic;
    if (keywords.length > 0) {
      const cleanKeywords = keywords.map(k => k.replace(/^#/, ''));
      searchQuery = `${topic} ${cleanKeywords.join(' ')}`;
    }

    try {
      logger.info(`Hebrew CSE search for: ${searchQuery}`);
      const hebrewResults = await fetchFromGoogleCSE_HEBREW(searchQuery);

      if (!hebrewResults || hebrewResults.length === 0) {
        logger.info('No Hebrew results found');
        return [];
      }

      logger.info(`Hebrew search returned ${hebrewResults.length} articles`);

      // Transform to standard article format
      return hebrewResults.map(article => ({
        title: article.title,
        description: article.description,
        content: article.description,
        url: article.url,
        urlToImage: null, // Hebrew search doesn't typically return images
        publishedAt: article.publishedAt,
        source: {
          name: article.source?.name || 'Hebrew Source',
          api: 'hebrew-cse',
          tier: article.source?.tier || HEBREW_SOURCE_TIERS[article.source?.name] || 0.5
        },
        topic,
        language: 'he',
        relevanceScore: this.calculateHebrewRelevanceScore(article, topic)
      }));

    } catch (error) {
      logger.error('Hebrew sources fetch error:', error.message);
      return [];
    }
  }

  /**
   * Calculate relevance score for Hebrew articles
   * Uses Hebrew source tiers for credibility scoring
   */
  calculateHebrewRelevanceScore(article, topic) {
    let score = 0;
    const text = `${article.title} ${article.description || ''}`.toLowerCase();

    // Check topic matches (simple word matching)
    const topicWords = topic.toLowerCase().split(/\s+/);
    topicWords.forEach(word => {
      if (text.includes(word)) {
        score += 10;
      }
    });

    // Boost for recent articles
    const publishedDate = new Date(article.publishedAt);
    const hoursAgo = (Date.now() - publishedDate.getTime()) / (1000 * 60 * 60);
    if (hoursAgo < 24) score += 20;
    else if (hoursAgo < 72) score += 10;
    else if (hoursAgo < 168) score += 5;

    // Boost for reputable Hebrew sources using imported tiers
    const sourceTier = article.source?.tier || 0.5;
    score += sourceTier * 20; // Max 20 points for tier 1 sources

    return score;
  }

  /**
   * Filter articles by keywords - article must contain at least one keyword
   */
  filterByKeywords(articles, keywords) {
    if (!keywords || keywords.length === 0) return articles;

    const cleanKeywords = keywords.map(k => k.replace(/^#/, '').toLowerCase());

    return articles.filter(article => {
      const text = `${article.title || ''} ${article.description || ''} ${article.content || ''}`.toLowerCase();
      return cleanKeywords.some(keyword => text.includes(keyword));
    });
  }

  async fetchFromNewsAPI(topic, language = 'en', sortBy = 'relevance', filters = {}) {
    const { keywords = [], region = '' } = filters;

    // Use dynamic topic queries from config
    const searchQueries = getTopicSearchQueries(topic);

    // Build query with keywords if provided
    let queryParts = [...searchQueries];
    if (keywords.length > 0) {
      const cleanKeywords = keywords.map(k => k.replace(/^#/, ''));
      queryParts.push(...cleanKeywords);
    }
    const query = queryParts.join(' OR ') || topic;

    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 7); // Last 7 days

    const params = {
      q: query,
      apiKey: this.newsApiKey,
      language,
      sortBy,
      from: fromDate.toISOString().split('T')[0],
      pageSize: 20
    };

    // NewsAPI doesn't support country for 'everything' endpoint, but we can use 'top-headlines' for country-specific
    // For now, we'll filter by region in post-processing if needed

    try {
      const response = await axios.get('https://newsapi.org/v2/everything', { params });

      logger.info(`NewsAPI returned ${response.data.articles.length} articles for topic: ${topic}`);

      return response.data.articles.map(article => ({
        title: article.title,
        description: article.description,
        content: article.content,
        url: article.url,
        urlToImage: article.urlToImage,
        publishedAt: article.publishedAt,
        source: {
          name: article.source.name,
          api: 'newsapi'
        },
        topic,
        relevanceScore: this.calculateRelevanceScore(article, topic)
      }));

    } catch (error) {
      if (error.response?.status === 429) {
        logger.warn('NewsAPI rate limit reached');
        throw new Error('NewsAPI rate limit exceeded');
      }
      throw error;
    }
  }

  async fetchFromGNews(topic, language = 'en', sortBy = 'relevance', filters = {}) {
    const { keywords = [], region = '' } = filters;

    // Use dynamic topic queries from config
    const searchQueries = getTopicSearchQueries(topic);

    // Build query with keywords if provided
    let queryParts = [...searchQueries];
    if (keywords.length > 0) {
      const cleanKeywords = keywords.map(k => k.replace(/^#/, ''));
      queryParts.push(...cleanKeywords);
    }
    const query = queryParts.join(' OR ') || topic;

    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 7); // Last 7 days
    const toDate = new Date();

    const params = {
      q: query,
      token: this.gnewsApiKey,
      lang: language,
      sortby: sortBy,
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      max: 20
    };

    // GNews supports country filtering - add if region is specified
    // Note: 'eu' is not a valid GNews country code, so we skip it
    const gnewsCountries = ['us', 'gb', 'ca', 'au', 'in', 'de', 'fr', 'jp', 'br', 'mx', 'za', 'sg', 'ae', 'il'];
    if (region && gnewsCountries.includes(region.toLowerCase())) {
      params.country = region.toLowerCase();
      logger.info(`GNews: Filtering by country: ${region}`);
    }

    try {
      const response = await axios.get('https://gnews.io/api/v4/search', { params });

      logger.info(`GNews returned ${response.data.articles.length} articles for topic: ${topic}`);

      return response.data.articles.map(article => ({
        title: article.title,
        description: article.description,
        content: article.content,
        url: article.url,
        urlToImage: article.image,
        publishedAt: article.publishedAt,
        source: {
          name: article.source.name,
          api: 'gnews'
        },
        topic,
        relevanceScore: this.calculateRelevanceScore(article, topic)
      }));

    } catch (error) {
      if (error.response?.status === 429) {
        logger.warn('GNews rate limit reached');
        throw new Error('GNews rate limit exceeded');
      }
      throw error;
    }
  }

  async fetchFromGoogleCSE(topic, language = 'en', filters = {}) {
    const { keywords = [], region = '' } = filters;

    // Use dynamic topic queries from config
    const searchQueries = getTopicSearchQueries(topic);

    // Build query with keywords if provided
    let queryParts = [...searchQueries];
    if (keywords.length > 0) {
      const cleanKeywords = keywords.map(k => k.replace(/^#/, ''));
      queryParts.push(...cleanKeywords);
    }
    const query = queryParts.join(' OR ') || topic;

    const params = {
      key: this.googleApiKey,
      cx: this.googleCseId,
      q: `${query} news`,
      lr: `lang_${language}`,
      num: 10,
      dateRestrict: 'w1', // Last week
      sort: 'date'
    };

    // Google CSE supports country restriction via 'cr' parameter
    // Format: countryXX where XX is the ISO 3166-1 alpha-2 country code
    const googleCountryMap = {
      'us': 'countryUS',
      'gb': 'countryGB',
      'ca': 'countryCA',
      'au': 'countryAU',
      'in': 'countryIN',
      'de': 'countryDE',
      'fr': 'countryFR',
      'jp': 'countryJP',
      'br': 'countryBR',
      'mx': 'countryMX',
      'za': 'countryZA',
      'sg': 'countrySG',
      'ae': 'countryAE',
      'il': 'countryIL'
    };

    if (region && googleCountryMap[region.toLowerCase()]) {
      params.cr = googleCountryMap[region.toLowerCase()];
      logger.info(`Google CSE: Filtering by country: ${region}`);
    }

    try {
      const response = await axios.get('https://www.googleapis.com/customsearch/v1', { params });

      logger.info(`Google CSE returned ${response.data.items?.length || 0} results for topic: ${topic}`);

      return (response.data.items || []).map(item => ({
        title: item.title,
        description: item.snippet,
        content: item.snippet,
        url: item.link,
        urlToImage: item.pagemap?.cse_image?.[0]?.src || null,
        publishedAt: new Date().toISOString(), // Google CSE doesn't provide date
        source: {
          name: new URL(item.link).hostname,
          api: 'google-cse'
        },
        topic,
        relevanceScore: this.calculateRelevanceScore(item, topic)
      }));

    } catch (error) {
      logger.error('Google CSE error:', error.message);
      throw error;
    }
  }

  calculateRelevanceScore(article, topic) {
    let score = 0;
    const topicKeywords = this.getTopicKeywords(topic);
    const text = `${article.title} ${article.description || ''} ${article.content || ''}`.toLowerCase();
    
    // Check keyword matches
    topicKeywords.forEach(keyword => {
      if (text.includes(keyword.toLowerCase())) {
        score += 10;
      }
    });
    
    // Boost for recent articles
    const publishedDate = new Date(article.publishedAt);
    const hoursAgo = (Date.now() - publishedDate.getTime()) / (1000 * 60 * 60);
    if (hoursAgo < 24) score += 20;
    else if (hoursAgo < 72) score += 10;
    else if (hoursAgo < 168) score += 5;
    
    // Boost for reputable sources
    const reputableSources = ['reuters', 'bloomberg', 'techcrunch', 'wired', 'verge', 'arstechnica', 'engadget'];
    const sourceName = (article.source?.name || '').toLowerCase();
    if (reputableSources.some(source => sourceName.includes(source))) {
      score += 15;
    }
    
    return score;
  }

  getTopicKeywords(topic) {
    // Use dynamic keywords from config
    const keywords = getTopicKeywords(topic);
    return keywords.length > 0 ? keywords : [topic];
  }

  deduplicateNews(articles) {
    const seen = new Map();
    const unique = [];
    
    for (const article of articles) {
      // Create a normalized key from title
      const key = article.title.toLowerCase().replace(/[^\w\s]/g, '').substring(0, 50);
      
      if (!seen.has(key)) {
        seen.set(key, true);
        unique.push(article);
      }
    }
    
    return unique;
  }

  sortNews(articles, sortBy) {
    switch (sortBy) {
      case 'relevance':
        return articles.sort((a, b) => b.relevanceScore - a.relevanceScore);
      case 'date':
      case 'publishedAt':
        return articles.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
      default:
        return articles;
    }
  }

  getFromCache(key) {
    const cached = this.newsCache.get(key);
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.data;
    }
    this.newsCache.delete(key);
    return null;
  }

  saveToCache(key, data) {
    this.newsCache.set(key, {
      data,
      timestamp: Date.now()
    });
    
    // Clean old cache entries
    if (this.newsCache.size > 100) {
      const oldestKey = this.newsCache.keys().next().value;
      this.newsCache.delete(oldestKey);
    }
  }

  // Mock news for testing when APIs are not configured
  getMockNews(topic) {
    const mockNews = {
      ai: [
        {
          title: "OpenAI Announces GPT-5 with Advanced Reasoning Capabilities",
          description: "The latest AI model shows significant improvements in logical reasoning and problem-solving.",
          url: "https://example.com/gpt5-announcement",
          publishedAt: new Date().toISOString(),
          source: { name: "Tech News", api: "mock" },
          topic: "ai"
        }
      ],
      tech: [
        {
          title: "Apple Unveils Revolutionary M4 Chip with 50% Performance Boost",
          description: "The new M4 chip promises unprecedented performance for Mac computers.",
          url: "https://example.com/apple-m4",
          publishedAt: new Date().toISOString(),
          source: { name: "Tech Daily", api: "mock" },
          topic: "tech"
        }
      ],
      crypto: [
        {
          title: "Bitcoin Reaches New All-Time High Amid Institutional Adoption",
          description: "Major financial institutions continue to embrace cryptocurrency.",
          url: "https://example.com/bitcoin-ath",
          publishedAt: new Date().toISOString(),
          source: { name: "Crypto News", api: "mock" },
          topic: "crypto"
        }
      ]
    };
    
    return mockNews[topic] || [{
      title: `Latest ${topic} News Update`,
      description: `Important developments in the ${topic} industry.`,
      url: "https://example.com/news",
      publishedAt: new Date().toISOString(),
      source: { name: "News Source", api: "mock" },
      topic
    }];
  }
}

export default NewsService;