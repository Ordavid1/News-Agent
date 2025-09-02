// routes/test.js
import express from 'express';
import NewsService from '../services/NewsService.js';
import ContentGenerator from '../services/ContentGenerator.js';
import trendAnalyzer from '../services/TrendAnalyzer.js';
import winston from 'winston';

const router = express.Router();

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[TestRoute] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

// Test mode endpoint
router.get('/mode', (req, res) => {
  res.json({
    testMode: process.env.TEST_MODE === 'true',
    message: process.env.TEST_MODE === 'true' ? 'Test mode is enabled' : 'Test mode is disabled'
  });
});

// Test news fetching from all sources
router.get('/news/:topic', async (req, res) => {
  try {
    const { topic } = req.params;
    const { source, limit = 5 } = req.query;
    
    const newsService = new NewsService();
    
    // Check API key configuration
    const apiStatus = {
      newsapi: newsService.newsApiKey && newsService.newsApiKey !== 'mock-key',
      gnews: newsService.gnewsApiKey && newsService.gnewsApiKey !== 'mock-key',
      google: newsService.googleApiKey && newsService.googleApiKey !== 'mock-key'
    };
    
    logger.info(`Testing news fetch for topic: ${topic}`);
    logger.info(`API Status: ${JSON.stringify(apiStatus)}`);
    
    let sources = ['newsapi', 'gnews'];
    if (source) {
      sources = [source];
    }
    
    const news = await newsService.getNewsForTopics([topic], {
      limit: parseInt(limit),
      language: 'en',
      sortBy: 'relevance',
      sources
    });
    
    res.json({
      topic,
      apiStatus,
      totalResults: news.length,
      hasRealNews: news.some(n => n.source.api !== 'mock'),
      sources: [...new Set(news.map(n => n.source.api))],
      news: news.map(n => ({
        title: n.title,
        description: n.description?.substring(0, 100) + '...',
        source: n.source,
        publishedAt: n.publishedAt,
        url: n.url,
        relevanceScore: n.relevanceScore
      }))
    });
    
  } catch (error) {
    logger.error('News test error:', error);
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

// Test individual news sources
router.get('/news-source/:source/:topic', async (req, res) => {
  try {
    const { source, topic } = req.params;
    const newsService = new NewsService();
    
    let results;
    switch (source) {
      case 'newsapi':
        results = await newsService.fetchFromNewsAPI(topic);
        break;
      case 'gnews':
        results = await newsService.fetchFromGNews(topic);
        break;
      case 'google':
        results = await newsService.fetchFromGoogleCSE(topic);
        break;
      default:
        return res.status(400).json({ error: 'Invalid source' });
    }
    
    res.json({
      source,
      topic,
      count: results.length,
      results: results.slice(0, 3)
    });
    
  } catch (error) {
    logger.error(`${req.params.source} test error:`, error);
    res.status(500).json({ 
      error: error.message,
      source: req.params.source,
      details: error.response?.data || 'No additional details'
    });
  }
});

// Test trend analyzer with real news
router.get('/trends/:topic', async (req, res) => {
  try {
    const { topic } = req.params;
    const { limit = 5 } = req.query;
    
    logger.info(`Testing trend analysis for topic: ${topic}`);
    
    const trends = await trendAnalyzer.getTrendsForTopics([topic], {
      limit: parseInt(limit)
    });
    
    res.json({
      topic,
      trendsCount: trends.length,
      hasRealTrends: trends.some(t => t.source?.api !== 'mock'),
      trends: trends.map(t => ({
        title: t.title,
        description: t.description?.substring(0, 100) + '...',
        source: t.source,
        publishedAt: t.publishedAt,
        url: t.url
      }))
    });
    
  } catch (error) {
    logger.error('Trends test error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Test complete pipeline: news -> content generation
router.post('/pipeline/:topic', async (req, res) => {
  try {
    const { topic } = req.params;
    const { platform = 'twitter', tone = 'professional' } = req.body;
    
    logger.info(`Testing complete pipeline for topic: ${topic}, platform: ${platform}`);
    
    // Step 1: Fetch news
    const newsService = new NewsService();
    const news = await newsService.getNewsForTopics([topic], {
      limit: 5,
      sources: ['newsapi', 'gnews']
    });
    
    // Step 2: Get trends
    const trends = await trendAnalyzer.getTrendsForTopics([topic], {
      limit: 3
    });
    
    // Step 3: Generate content
    const contentGenerator = new ContentGenerator();
    let generatedContent = null;
    
    if (trends.length > 0) {
      const trend = trends[0];
      generatedContent = await contentGenerator.generateContent(
        trend,
        platform,
        tone
      );
    }
    
    res.json({
      topic,
      platform,
      tone,
      pipeline: {
        newsFound: news.length,
        trendsFound: trends.length,
        contentGenerated: !!generatedContent
      },
      news: news.slice(0, 3).map(n => ({
        title: n.title,
        source: n.source
      })),
      trends: trends.slice(0, 3).map(t => ({
        title: t.title,
        source: t.source
      })),
      generatedContent: generatedContent ? {
        text: generatedContent.text,
        platform: generatedContent.platform,
        generatedAt: generatedContent.generatedAt
      } : null
    });
    
  } catch (error) {
    logger.error('Pipeline test error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Test API configuration
router.get('/api-config', (req, res) => {
  const newsService = new NewsService();
  
  const config = {
    newsapi: {
      configured: !!process.env.NEWSAPI_KEY,
      isMock: process.env.NEWSAPI_KEY === 'mock-key',
      keyLength: process.env.NEWSAPI_KEY?.length || 0
    },
    gnews: {
      configured: !!process.env.GNEWS_API_KEY,
      isMock: process.env.GNEWS_API_KEY === 'mock-key',
      keyLength: process.env.GNEWS_API_KEY?.length || 0
    },
    google: {
      configured: !!process.env.GOOGLE_CSE_API_KEY,
      isMock: process.env.GOOGLE_CSE_API_KEY === 'mock-key',
      keyLength: process.env.GOOGLE_CSE_API_KEY?.length || 0,
      cseId: !!process.env.GOOGLE_CSE_ID
    },
    openai: {
      configured: !!process.env.OPENAI_API_KEY,
      keyLength: process.env.OPENAI_API_KEY?.length || 0
    }
  };
  
  res.json({
    config,
    recommendation: 'Replace mock-key values in .env with real API keys for full functionality'
  });
});

export default router;