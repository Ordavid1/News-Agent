// services/EnhancedNewsService.js
import axios from 'axios';
import winston from 'winston';
import NewsService from './NewsService.js';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[EnhancedNewsService] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

class EnhancedNewsService extends NewsService {
  constructor() {
    super();
    // Track used articles per user
    this.userArticleUsage = new Map();
  }

  async getNewsForTopics(topics, options = {}) {
    const {
      limit = 10,
      language = 'en',
      sortBy = 'relevance',
      sources = ['newsapi', 'gnews'],
      userId = 'demo-user',
      keywords = [],
      geoFilter = {}
    } = options;

    const { region = '', includeGlobal = true } = geoFilter;

    logger.info(`Enhanced: Fetching news for topics: ${topics.join(', ')}, keywords: ${keywords.length > 0 ? keywords.join(', ') : 'none'}, region: ${region || 'global'}`);

    // Date setup - similar to main app
    const now = new Date();
    const toDate = new Date(now);
    toDate.setUTCHours(23, 59, 59, 999);

    const fromDate = new Date(now);
    fromDate.setUTCDate(fromDate.getUTCDate() - 7);
    fromDate.setUTCHours(0, 0, 0, 0);

    const allNews = [];

    // Call parent method to get raw news - pass through keywords and geoFilter
    const rawNews = await super.getNewsForTopics(topics, {
      ...options,
      keywords,
      geoFilter
    });

    // Enhanced filtering and scoring
    const processedNews = rawNews
      .filter(article => this.validateArticle(article, fromDate, toDate))
      .filter(article => !this.isArticleAlreadyUsed(article, userId))
      .map(article => ({
        ...article,
        relevanceScore: this.calculateEnhancedRelevance(article, topics[0], fromDate, toDate, keywords)
      }))
      .filter(article => article.relevanceScore >= 0.3)
      .sort((a, b) => b.relevanceScore - a.relevanceScore);

    logger.info(`Enhanced: Found ${processedNews.length} relevant articles after filtering`);

    // Mark articles as used
    processedNews.slice(0, limit).forEach(article => {
      this.markArticleAsUsed(article, userId);
    });

    return processedNews.slice(0, limit);
  }

  validateArticle(article, fromDate, toDate) {
    if (!article || !article.title || !article.description) {
      return false;
    }
    
    // Date validation
    if (article.publishedAt) {
      const articleDate = new Date(article.publishedAt);
      if (isNaN(articleDate.getTime()) || articleDate < fromDate || articleDate > toDate) {
        logger.debug(`Article filtered by date: "${article.title}"`);
        return false;
      }
    }
    
    // Language filter - remove non-English articles
    const containsNonEnglishChars = /[À-ÿĀ-žА-я\u0590-\u05FF\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]/;
    if (containsNonEnglishChars.test(article.title) || containsNonEnglishChars.test(article.description)) {
      logger.debug(`Filtered out non-English article: "${article.title}"`);
      return false;
    }
    
    // Filter out generic news aggregation pages
    const genericPatterns = [
      /^breaking news/i,
      /^latest news/i,
      /news roundup/i,
      /news digest/i,
      /top stories/i,
      /news summary/i,
      /^news:/i,
      /^update:/i
    ];
    
    if (genericPatterns.some(pattern => pattern.test(article.title))) {
      logger.debug(`Filtered out generic news page: "${article.title}"`);
      return false;
    }
    
    // Filter out tag/category pages
    if (this.isTagOrCategoryPage(article)) {
      return false;
    }
    
    return true;
  }

  isTagOrCategoryPage(article) {
    const patterns = [
      /\btags?\b/i,
      /\bcategor(y|ies)\b/i,
      /\btopics?\b/i,
      /\barchive\b/i,
      /\ball news\b/i,
      /\blatest from\b/i
    ];
    
    const urlPatterns = [
      /\/tags?\//i,
      /\/category\//i,
      /\/topics?\//i,
      /\/archive\//i
    ];
    
    if (patterns.some(pattern => pattern.test(article.title))) {
      logger.debug(`Filtered out tag/category page by title: "${article.title}"`);
      return true;
    }
    
    if (article.url && urlPatterns.some(pattern => pattern.test(article.url))) {
      logger.debug(`Filtered out tag/category page by URL: "${article.url}"`);
      return true;
    }
    
    return false;
  }

  isArticleAlreadyUsed(article, userId) {
    if (!this.userArticleUsage.has(userId)) {
      this.userArticleUsage.set(userId, new Map());
    }
    
    const userArticles = this.userArticleUsage.get(userId);
    const articleKey = `${article.title}|${article.url}`;
    const timestamp = userArticles.get(articleKey);
    
    if (timestamp && (Date.now() - timestamp) < 4 * 60 * 60 * 1000) {
      logger.debug(`Article rejected - Recently used: "${article.title}"`);
      return true;
    }
    
    return false;
  }

  markArticleAsUsed(article, userId) {
    if (!this.userArticleUsage.has(userId)) {
      this.userArticleUsage.set(userId, new Map());
    }
    
    const userArticles = this.userArticleUsage.get(userId);
    const articleKey = `${article.title}|${article.url}`;
    userArticles.set(articleKey, Date.now());
    
    // Clean up old entries
    if (userArticles.size > 100) {
      const now = Date.now();
      for (const [key, timestamp] of userArticles.entries()) {
        if (now - timestamp > 24 * 60 * 60 * 1000) {
          userArticles.delete(key);
        }
      }
    }
  }

  calculateEnhancedRelevance(article, topic, fromDate, toDate, userKeywords = []) {
    const weights = {
      titleMatch: 0.30,
      descMatch: 0.20,
      dateRecency: 0.20,
      keywordDensity: 0.15,
      userKeywordMatch: 0.15  // New weight for user-defined keywords
    };

    let scores = {
      titleMatch: 0,
      descMatch: 0,
      dateRecency: 0,
      keywordDensity: 0,
      userKeywordMatch: 0
    };

    const titleLower = (article.title || '').toLowerCase();
    const descLower = (article.description || '').toLowerCase();
    const topicLower = topic.toLowerCase();

    // Extract topic keywords
    const topicKeywords = this.getTopicKeywords(topic);
    const allKeywords = [topicLower, ...topicKeywords.map(k => k.toLowerCase())];

    // Title match score
    const titleWords = titleLower.split(/\s+/);
    const titleMatches = allKeywords.filter(keyword => {
      return titleWords.some(word => word.includes(keyword) || keyword.includes(word));
    }).length;
    scores.titleMatch = Math.min(titleMatches / allKeywords.length, 1.0);

    // Description match score
    if (descLower) {
      const descWords = descLower.split(/\s+/);
      const descMatches = allKeywords.filter(keyword => {
        return descWords.some(word => word.includes(keyword) || keyword.includes(word));
      }).length;
      scores.descMatch = Math.min(descMatches / allKeywords.length, 1.0);
    }

    // Date recency score (exponential decay)
    if (article.publishedAt) {
      const ageInHours = (Date.now() - new Date(article.publishedAt).getTime()) / (1000 * 60 * 60);
      scores.dateRecency = Math.exp(-ageInHours / 48); // 48 hour half-life
    } else {
      scores.dateRecency = 0.5;
    }

    // Keyword density score
    const fullText = `${titleLower} ${descLower}`;
    const wordCount = fullText.split(/\s+/).length;
    const keywordCount = allKeywords.reduce((count, keyword) => {
      const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
      const matches = fullText.match(regex);
      return count + (matches ? matches.length : 0);
    }, 0);
    scores.keywordDensity = Math.min(keywordCount / wordCount * 10, 1.0);

    // User-defined keyword match score
    if (userKeywords && userKeywords.length > 0) {
      const cleanUserKeywords = userKeywords.map(k => k.replace(/^#/, '').toLowerCase());
      const userKeywordMatches = cleanUserKeywords.filter(keyword => {
        return fullText.includes(keyword);
      }).length;
      scores.userKeywordMatch = Math.min(userKeywordMatches / cleanUserKeywords.length, 1.0);

      // Boost score if user keywords are found (they are more intentional)
      if (userKeywordMatches > 0) {
        scores.userKeywordMatch = Math.min(scores.userKeywordMatch * 1.5, 1.0);
      }
    } else {
      // If no user keywords, redistribute the weight to other factors
      scores.userKeywordMatch = (scores.titleMatch + scores.descMatch) / 2;
    }

    // Calculate weighted total
    const totalScore = Object.entries(weights).reduce((sum, [key, weight]) => {
      return sum + (scores[key] * weight);
    }, 0);

    logger.debug(`Enhanced relevance for "${article.title}": ${totalScore.toFixed(3)} (title: ${scores.titleMatch.toFixed(2)}, desc: ${scores.descMatch.toFixed(2)}, date: ${scores.dateRecency.toFixed(2)}, density: ${scores.keywordDensity.toFixed(2)}, userKw: ${scores.userKeywordMatch.toFixed(2)})`);

    return totalScore;
  }

  // Override deduplication with better similarity detection
  deduplicateNews(articles) {
    const seen = new Map();
    const uniqueArticles = [];
    
    for (const article of articles) {
      // Check exact URL match first
      let isDuplicate = false;
      
      for (const [key, seenArticle] of seen.entries()) {
        if (article.url === seenArticle.url) {
          logger.debug(`Duplicate URL found: ${article.url}`);
          isDuplicate = true;
          break;
        }
        
        // Check for similar titles
        if (this.areSimilarArticles(article, seenArticle)) {
          logger.debug(`Similar article found: "${article.title}" ~= "${seenArticle.title}"`);
          isDuplicate = true;
          break;
        }
      }
      
      if (!isDuplicate) {
        const key = `${article.title}_${article.source.name}`;
        seen.set(key, article);
        uniqueArticles.push(article);
      }
    }
    
    return uniqueArticles;
  }

  areSimilarArticles(article1, article2) {
    // Exact URL match
    if (article1.url === article2.url) return true;
    
    // Normalize titles for comparison
    const title1 = this.normalizeText(article1.title);
    const title2 = this.normalizeText(article2.title);
    
    // Exact title match after normalization
    if (title1 === title2) return true;
    
    // Calculate word-based similarity
    const words1 = title1.split(' ').filter(w => w.length > 3);
    const words2 = title2.split(' ').filter(w => w.length > 3);
    
    if (words1.length === 0 || words2.length === 0) return false;
    
    const commonWords = words1.filter(word => words2.includes(word)).length;
    const similarity = commonWords / Math.min(words1.length, words2.length);
    
    return similarity > 0.7; // 70% similarity threshold
  }

  normalizeText(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
}

export default EnhancedNewsService;