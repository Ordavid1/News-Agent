// server.js
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import dotenv from 'dotenv';
import winston from 'winston';
import path from 'path';
import { fileURLToPath } from 'url';
import session from 'express-session';
import passport from './config/passport.js';
import { initializePassport } from './config/passport-init.js';

// Load environment variables first
dotenv.config();

// Import routes
import authRoutes from './routes/auth.js';
import subscriptionRoutes from './routes/subscriptions.js';
import postsRoutes from './routes/posts.js';
import analyticsRoutes from './routes/analytics.js';
import userRoutes from './routes/users.js';
import automationRoutes from './routes/automation.js';
import testRoutes from './routes/test.js';
import connectionsRoutes from './routes/connections.js';
import agentsRoutes from './routes/agents.js';

// Import middleware
import { authenticateToken } from './middleware/auth.js';
import { rateLimiter } from './middleware/rateLimiter.js';
import { checkSubscriptionLimits } from './middleware/subscription.js';

// Import services
import { initializeDatabase, getDb } from './services/database.js';
import AutomationManager from './services/AutomationManager.js';
import { startAllWorkers, stopAllWorkers, getWorkersStatus } from './workers/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Initialize logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'app.log' })
  ]
});

// Initialize Express app
const app = express();

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://unpkg.com", "https://cdn.tailwindcss.com", "https://js.stripe.com"],
      scriptSrcAttr: ["'unsafe-inline'"], // Allow inline event handlers
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", "https://api.stripe.com"],
      frameSrc: ["'self'", "https://js.stripe.com", "https://hooks.stripe.com"]
    }
  }
}));

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-session-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Initialize Passport with configuration
initializePassport();
app.use(passport.initialize());
app.use(passport.session());

// Apply rate limiting to all API routes
app.use('/api', rateLimiter);

// SEO: Serve robots.txt with correct content type
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.sendFile(path.join(__dirname, 'public', 'robots.txt'));
});

// SEO: Serve sitemap.xml with correct content type
app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml');
  res.sendFile(path.join(__dirname, 'public', 'sitemap.xml'));
});

// SEO: Serve manifest.json with correct content type
app.get('/manifest.json', (req, res) => {
  res.type('application/manifest+json');
  res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});

// SEO: Add caching headers for static assets
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d', // Cache static files for 1 day
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    // Set longer cache for images and fonts
    if (filePath.match(/\.(jpg|jpeg|png|gif|ico|svg|woff|woff2|ttf|eot)$/)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000'); // 1 year
    }
    // Set shorter cache for HTML files
    if (filePath.match(/\.html$/)) {
      res.setHeader('Cache-Control', 'public, max-age=3600'); // 1 hour
    }
    // Set cache for CSS and JS
    if (filePath.match(/\.(css|js)$/)) {
      res.setHeader('Cache-Control', 'public, max-age=86400'); // 1 day
    }
  }
}));

// Auth Routes (no /api prefix for OAuth)
app.use('/auth', authRoutes);

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/subscriptions', authenticateToken, subscriptionRoutes);
app.use('/api/posts', authenticateToken, checkSubscriptionLimits, postsRoutes);
app.use('/api/analytics', authenticateToken, analyticsRoutes);
app.use('/api/users', authenticateToken, userRoutes);
app.use('/api/automation', authenticateToken, automationRoutes);
app.use('/api/agents', authenticateToken, agentsRoutes); // Agent management (each agent = platform + settings)
app.use('/api/connections', connectionsRoutes); // Social media connections (auth handled per-route)
app.use('/api/test', testRoutes); // Test routes (no auth for testing)

// Demo endpoint (no auth required for testing)
app.post('/api/demo/generate', async (req, res) => {
  try {
    const { topics, platforms, plan } = req.body;
    
    // Import necessary services
    const EnhancedNewsService = (await import('./services/EnhancedNewsService.js')).default;
    const ContentGenerator = (await import('./services/ContentGenerator.js')).default;
    const newsService = new EnhancedNewsService();
    const contentGenerator = new ContentGenerator();
    
    // Validate inputs
    if (!topics || topics.length === 0) {
      return res.status(400).json({ error: 'Please select at least one topic' });
    }
    
    if (!platforms || platforms.length === 0) {
      return res.status(400).json({ error: 'Please select at least one platform' });
    }
    
    const selectedTopic = topics[0]; // Use first selected topic
    
    // For demo, always generate for all 3 platforms to show capabilities
    const demoPlatforms = ['twitter', 'reddit', 'linkedin'];
    
    logger.info(`[DEMO] Received request with topics: ${JSON.stringify(topics)}, platforms: ${platforms.join(', ')}`);
    logger.info(`[DEMO] Generating real content for topic: ${selectedTopic}, platforms: ${demoPlatforms.join(', ')} (showing all for demo)`);
    
    // Fetch real news for the selected topic with enhanced filtering
    const news = await newsService.getNewsForTopics([selectedTopic], {
      limit: 10, // Fetch more to ensure we have good articles after filtering
      language: 'en',
      sortBy: 'relevance',
      userId: 'demo-user'
    });
    
    if (news.length === 0) {
      logger.warn(`[DEMO] No news found for topic: ${selectedTopic}`);
      return res.status(404).json({ error: 'No recent news found for selected topic. Please try another topic.' });
    }
    
    // Use the first news article for content generation
    const article = news[0];
    const trend = {
      title: article.title,
      description: article.description,
      summary: article.content || article.description,
      url: article.url,
      source: article.source.name,
      publishedAt: article.publishedAt
    };
    
    // Generate content for all demo platforms
    const platformContents = {};
    for (const platform of demoPlatforms) {
      try {
        const generatedContent = await contentGenerator.generateContent(
          trend,
          platform,
          'professional',
          'demo-user'
        );
        platformContents[platform] = generatedContent.text;
      } catch (error) {
        logger.error(`[DEMO] Failed to generate content for ${platform}:`, error);
        platformContents[platform] = `Failed to generate ${platform} content`;
      }
    }
    
    // Format the response to match expected demo format
    res.json({
      success: true,
      post: {
        id: `demo_${Date.now()}`,
        content: platformContents['twitter'] || platformContents[demoPlatforms[0]], // Keep backward compatibility
        platforms: platformContents, // Will have all 3 platforms
        topic: selectedTopic,
        createdAt: new Date().toISOString(),
        newsTitle: article.title,
        newsSource: article.source.name,
        newsUrl: article.url,
        metadata: {
          newsSource: article.source,
          articleTitle: article.title,
          articleUrl: article.url,
          isRealNews: article.source.api !== 'mock'
        }
      }
    });
  } catch (error) {
    console.error('Demo generation error:', error);
    res.status(500).json({ error: 'Failed to generate demo post' });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Test news fetching endpoint
app.get('/api/test/news/:topic', async (req, res) => {
  try {
    const { topic } = req.params;
    const newsService = new (await import('./services/NewsService.js')).default();
    
    const news = await newsService.getNewsForTopics([topic], {
      limit: 5,
      language: 'en',
      sortBy: 'relevance'
    });
    
    res.json({
      topic,
      count: news.length,
      hasRealNews: news.some(n => n.source.api !== 'mock'),
      news: news.map(n => ({
        title: n.title,
        source: n.source,
        publishedAt: n.publishedAt,
        url: n.url
      }))
    });
  } catch (error) {
    logger.error('News test error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Serve the main app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Initialize database and start server
async function startServer() {
  try {
    // Initialize database (Supabase)
    await initializeDatabase();
    logger.info('Supabase database connection established');

    // Initialize automation manager
    const db = getDb();
    const automationManager = new AutomationManager(db);
    logger.info('Automation system initialized');

    // Make automation manager available globally
    app.locals.automationManager = automationManager;

    // Start background workers if enabled
    const workersEnabled = process.env.BACKGROUND_WORKERS_ENABLED === 'true';
    if (workersEnabled) {
      startAllWorkers();
      logger.info('Background workers started');
    } else {
      logger.info('Background workers disabled (set BACKGROUND_WORKERS_ENABLED=true to enable)');
    }

    const PORT = process.env.PORT || 3000;
    const server = app.listen(PORT, () => {
      logger.info(`🚀 AIPostGen SaaS server running on port ${PORT}`);
      logger.info(`🌐 Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:3000'}`);
      logger.info(`🤖 Automation enabled: ${process.env.AUTOMATION_ENABLED === 'true' ? 'YES' : 'NO'}`);
      logger.info(`⚙️  Background workers: ${workersEnabled ? 'ENABLED' : 'DISABLED'}`);
    });

    // Graceful shutdown handling
    const gracefulShutdown = (signal) => {
      logger.info(`${signal} received. Shutting down gracefully...`);

      // Stop background workers
      if (workersEnabled) {
        stopAllWorkers();
        logger.info('Background workers stopped');
      }

      server.close(() => {
        logger.info('HTTP server closed');
        process.exit(0);
      });

      // Force shutdown after 10 seconds
      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Health check endpoint for workers status
app.get('/api/workers/status', authenticateToken, (req, res) => {
  res.json({
    success: true,
    workers: getWorkersStatus(),
    enabled: process.env.BACKGROUND_WORKERS_ENABLED === 'true'
  });
});

startServer();

export default app;