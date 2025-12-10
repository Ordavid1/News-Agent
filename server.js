// server.js
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import dotenv from 'dotenv';
import winston from 'winston';
import path from 'path';
import { fileURLToPath } from 'url';
import session from 'express-session';
import cookieParser from 'cookie-parser';
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
import { rateLimiter, demoLimiter } from './middleware/rateLimiter.js';
import { checkSubscriptionLimits } from './middleware/subscription.js';
import { csrfTokenSetter, csrfProtection, getCsrfToken } from './middleware/csrf.js';

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

// SECURITY: Hardened security headers with Helmet
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // SECURITY: Removed 'unsafe-eval', kept 'unsafe-inline' for now (requires frontend refactor to fully remove)
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com", "https://js.stripe.com", "https://www.googletagmanager.com", "https://www.google-analytics.com", "https://app.lemonsqueezy.com"],
      scriptSrcAttr: ["'unsafe-inline'"], // TODO: Remove after refactoring inline event handlers
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", "https://api.stripe.com", "https://api.lemonsqueezy.com", "https://www.google-analytics.com", "https://analytics.google.com", "https://region1.google-analytics.com", process.env.SUPABASE_URL].filter(Boolean),
      frameSrc: ["'self'", "https://js.stripe.com", "https://hooks.stripe.com", "https://app.lemonsqueezy.com", "https://*.lemonsqueezy.com"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
    }
  },
  // Additional security headers
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true
  },
  frameguard: { action: 'deny' },
  noSniff: true,
  xssFilter: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));

// SECURITY: Tightened CORS configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : [process.env.FRONTEND_URL || 'http://localhost:3000'];

if (process.env.NODE_ENV === 'production' && !process.env.ALLOWED_ORIGINS && !process.env.FRONTEND_URL) {
  logger.warn('[SECURITY] No ALLOWED_ORIGINS or FRONTEND_URL configured. Using restrictive CORS.');
}

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, etc.) in development only
    if (!origin) {
      if (process.env.NODE_ENV === 'production') {
        return callback(new Error('Origin required'), false);
      }
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error('Not allowed by CORS'), false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-CSRF-Token']
}));

// Cookie parser for httpOnly cookie authentication
app.use(cookieParser());

// SECURITY: CSRF token setter - sets token cookie for all requests
app.use(csrfTokenSetter);

// Lemon Squeezy webhook endpoint - MUST be before express.json() to access raw body
// This route is mounted separately to handle raw body for signature verification
app.post('/webhooks/lemonsqueezy', express.raw({ type: 'application/json' }), async (req, res) => {
  console.log('[WEBHOOK] Lemon Squeezy webhook received');

  const crypto = await import('crypto');
  const signature = req.headers['x-signature'];

  // SECURITY: Validate webhook secret is configured and strong enough
  const webhookSecret = process.env.LEMON_SQUEEZY_WEBHOOK_SECRET;
  if (!webhookSecret || webhookSecret.length < 32) {
    console.error('[WEBHOOK] Webhook secret not configured or too weak');
    return res.status(503).json({ error: 'Webhook not configured' });
  }

  if (!signature) {
    console.error('[WEBHOOK] Missing webhook signature');
    return res.status(401).json({ error: 'Missing signature' });
  }

  // Verify signature
  const hmac = crypto.createHmac('sha256', webhookSecret);
  const digest = hmac.update(req.body).digest('hex');

  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest))) {
      console.error('Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  } catch (e) {
    console.error('Signature verification error:', e);
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Parse the webhook payload
  let payload;
  try {
    payload = JSON.parse(req.body.toString());
  } catch (e) {
    console.error('Failed to parse webhook payload:', e);
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const eventName = payload.meta?.event_name;
  const customData = payload.meta?.custom_data || {};

  console.log(`[WEBHOOK] Received Lemon Squeezy event: ${eventName}`);
  console.log('[WEBHOOK] Custom data user_id:', customData?.user_id ? 'present' : 'missing');

  // Import database functions dynamically
  const { createSubscription, getSubscriptionByLsId, updateUser } = await import('./services/database-wrapper.js');

  // Helper to get post limit by tier
  const getTierPostLimit = (tier) => {
    const limits = { free: 5, starter: 10, growth: 20, professional: 30, business: 45 };
    return limits[tier] || 5;
  };

  // Variant ID to tier mapping
  const VARIANT_TIERS = {
    [process.env.LEMON_SQUEEZY_49_VARIANT_ID]: 'starter',
    [process.env.LEMON_SQUEEZY_149_VARIANT_ID]: 'growth',
    [process.env.LEMON_SQUEEZY_399_VARIANT_ID]: 'professional',
    [process.env.LEMON_SQUEEZY_799_VARIANT_ID]: 'business'
  };

  try {
    switch (eventName) {
      case 'subscription_created': {
        const { user_id, tier } = customData;
        const subscriptionData = payload.data.attributes;
        const subscriptionId = payload.data.id;

        if (!user_id) {
          console.error('[WEBHOOK] No user_id in custom_data for subscription_created');
          return res.status(200).json({ received: true, error: 'Missing user_id' });
        }

        console.log(`[WEBHOOK] Creating subscription for user ${user_id}, tier: ${tier}`);

        await createSubscription({
          userId: user_id,
          tier: tier,
          lsSubscriptionId: subscriptionId,
          lsCustomerId: String(subscriptionData.customer_id),
          lsVariantId: String(subscriptionData.variant_id),
          lsOrderId: String(subscriptionData.order_id),
          status: 'active',
          currentPeriodStart: subscriptionData.created_at,
          currentPeriodEnd: subscriptionData.renews_at
        });

        await updateUser(user_id, {
          subscription: {
            tier: tier,
            status: 'active',
            postsRemaining: getTierPostLimit(tier),
            dailyLimit: getTierPostLimit(tier),
            cancelAtPeriodEnd: false
          },
          lsCustomerId: String(subscriptionData.customer_id),
          lsSubscriptionId: subscriptionId
        });

        console.log(`[WEBHOOK] Subscription created successfully for user ${user_id}`);
        break;
      }

      case 'subscription_updated': {
        const subscriptionId = payload.data.id;
        const subscriptionData = payload.data.attributes;

        console.log(`[WEBHOOK] Subscription updated: ${subscriptionId}`);

        const subscription = await getSubscriptionByLsId(subscriptionId);
        if (!subscription) {
          console.error(`[WEBHOOK] Subscription not found for LS ID: ${subscriptionId}`);
          return res.status(200).json({ received: true, error: 'Subscription not found' });
        }

        const variantId = String(subscriptionData.variant_id);
        const newTier = VARIANT_TIERS[variantId] || subscription.tier;

        await updateUser(subscription.userId, {
          subscription: {
            tier: newTier,
            status: subscriptionData.status === 'active' ? 'active' : subscriptionData.status,
            postsRemaining: getTierPostLimit(newTier),
            dailyLimit: getTierPostLimit(newTier),
            cancelAtPeriodEnd: subscriptionData.cancelled || false
          }
        });

        console.log(`[WEBHOOK] Subscription updated for user ${subscription.userId}, tier: ${newTier}`);
        break;
      }

      case 'subscription_cancelled': {
        const subscriptionId = payload.data.id;
        const subscriptionData = payload.data.attributes;

        console.log(`[WEBHOOK] Subscription cancelled: ${subscriptionId}`);

        const subscription = await getSubscriptionByLsId(subscriptionId);
        if (!subscription) {
          console.error(`[WEBHOOK] Subscription not found for LS ID: ${subscriptionId}`);
          return res.status(200).json({ received: true, error: 'Subscription not found' });
        }

        await updateUser(subscription.userId, {
          subscription: {
            tier: subscription.tier,
            status: 'cancelled',
            cancelAtPeriodEnd: true,
            endsAt: subscriptionData.ends_at
          }
        });

        console.log(`[WEBHOOK] Subscription cancelled for user ${subscription.userId}`);
        break;
      }

      case 'subscription_resumed': {
        const subscriptionId = payload.data.id;

        console.log(`[WEBHOOK] Subscription resumed: ${subscriptionId}`);

        const subscription = await getSubscriptionByLsId(subscriptionId);
        if (!subscription) {
          console.error(`[WEBHOOK] Subscription not found for LS ID: ${subscriptionId}`);
          return res.status(200).json({ received: true, error: 'Subscription not found' });
        }

        await updateUser(subscription.userId, {
          subscription: {
            tier: subscription.tier,
            status: 'active',
            cancelAtPeriodEnd: false,
            endsAt: null
          }
        });

        console.log(`[WEBHOOK] Subscription resumed for user ${subscription.userId}`);
        break;
      }

      case 'subscription_expired': {
        const subscriptionId = payload.data.id;

        console.log(`[WEBHOOK] Subscription expired: ${subscriptionId}`);

        const subscription = await getSubscriptionByLsId(subscriptionId);
        if (!subscription) {
          console.error(`[WEBHOOK] Subscription not found for LS ID: ${subscriptionId}`);
          return res.status(200).json({ received: true, error: 'Subscription not found' });
        }

        await updateUser(subscription.userId, {
          subscription: {
            tier: 'free',
            status: 'expired',
            postsRemaining: 5,
            dailyLimit: 5,
            cancelAtPeriodEnd: false
          },
          lsSubscriptionId: null
        });

        console.log(`[WEBHOOK] Subscription expired, user ${subscription.userId} downgraded to free`);
        break;
      }

      case 'subscription_payment_success': {
        const subscriptionId = payload.data.attributes.subscription_id;

        console.log(`[WEBHOOK] Payment successful for subscription: ${subscriptionId}`);

        const subscription = await getSubscriptionByLsId(String(subscriptionId));
        if (!subscription) {
          console.error(`[WEBHOOK] Subscription not found for LS ID: ${subscriptionId}`);
          return res.status(200).json({ received: true, error: 'Subscription not found' });
        }

        await updateUser(subscription.userId, {
          subscription: {
            tier: subscription.tier,
            status: 'active',
            postsRemaining: getTierPostLimit(subscription.tier),
            dailyLimit: getTierPostLimit(subscription.tier)
          }
        });

        console.log(`[WEBHOOK] Payment success - limits reset for user ${subscription.userId}`);
        break;
      }

      case 'subscription_payment_failed': {
        const subscriptionId = payload.data.attributes.subscription_id;

        console.log(`[WEBHOOK] Payment failed for subscription: ${subscriptionId}`);

        const subscription = await getSubscriptionByLsId(String(subscriptionId));
        if (!subscription) {
          console.error(`[WEBHOOK] Subscription not found for LS ID: ${subscriptionId}`);
          return res.status(200).json({ received: true, error: 'Subscription not found' });
        }

        await updateUser(subscription.userId, {
          subscription: {
            tier: subscription.tier,
            status: 'past_due'
          }
        });

        console.log(`[WEBHOOK] Payment failed - marked past_due for user ${subscription.userId}`);
        break;
      }

      case 'subscription_plan_changed': {
        const subscriptionId = payload.data.id;
        const subscriptionData = payload.data.attributes;

        console.log(`[WEBHOOK] Subscription plan changed: ${subscriptionId}`);

        const subscription = await getSubscriptionByLsId(subscriptionId);
        if (!subscription) {
          console.error(`[WEBHOOK] Subscription not found for LS ID: ${subscriptionId}`);
          return res.status(200).json({ received: true, error: 'Subscription not found' });
        }

        // Determine new tier from variant ID
        const variantId = String(subscriptionData.variant_id);
        const newTier = VARIANT_TIERS[variantId] || subscription.tier;

        console.log(`[WEBHOOK] Plan changed from ${subscription.tier} to ${newTier}`);

        // Update subscription with new tier and clear any pending change
        await updateUser(subscription.userId, {
          subscription: {
            tier: newTier,
            status: 'active',
            postsRemaining: getTierPostLimit(newTier),
            dailyLimit: getTierPostLimit(newTier),
            cancelAtPeriodEnd: false,
            pendingTier: null,
            pendingChangeAt: null
          }
        });

        console.log(`[WEBHOOK] Plan changed for user ${subscription.userId}, new tier: ${newTier}`);
        break;
      }

      case 'order_created':
        console.log(`[WEBHOOK] Order created: ${payload.data.id}`);
        break;

      default:
        console.log(`[WEBHOOK] Unhandled event: ${eventName}`);
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error(`[WEBHOOK] Error handling ${eventName}:`, error);
    res.status(200).json({ received: true, error: error.message });
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging middleware - log all API requests for debugging
app.use('/api', (req, res, next) => {
  // Log API requests (auth status only, not token values)
  console.log(`[API] ${req.method} ${req.originalUrl} - Auth: ${req.headers.authorization ? 'present' : 'missing'}`);
  next();
});

// SECURITY: SESSION_SECRET must be set in production - no weak fallback
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('FATAL: SESSION_SECRET environment variable must be set in production');
}

// Session configuration
app.use(session({
  secret: SESSION_SECRET || 'dev-only-secret-not-for-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Initialize Passport with configuration
initializePassport();
app.use(passport.initialize());
app.use(passport.session());

// Health check endpoint - MUST be before rate limiter for Render health checks
app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Apply rate limiting to all API routes (except health check defined above)
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

// SECURITY: CSRF token endpoint - frontend calls this to get a fresh token
app.get('/api/csrf-token', getCsrfToken);

// API Routes
app.use('/api/auth', authRoutes);
// SECURITY: Apply CSRF protection to state-changing authenticated routes
app.use('/api/subscriptions', authenticateToken, csrfProtection, subscriptionRoutes);
app.use('/api/posts', authenticateToken, csrfProtection, checkSubscriptionLimits, postsRoutes);
app.use('/api/analytics', authenticateToken, analyticsRoutes); // Read-only, no CSRF needed
app.use('/api/users', authenticateToken, csrfProtection, userRoutes);
app.use('/api/automation', authenticateToken, csrfProtection, automationRoutes);
app.use('/api/agents', authenticateToken, csrfProtection, agentsRoutes); // Agent management (each agent = platform + settings)
app.use('/api/connections', connectionsRoutes); // Social media connections (auth handled per-route, OAuth callbacks exempt)

// SECURITY: Disable test routes in production
if (process.env.NODE_ENV === 'production') {
  app.use('/api/test', (req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
} else {
  app.use('/api/test', testRoutes); // Test routes only in development
}

// Demo endpoint (no auth required but rate limited to prevent abuse)
app.post('/api/demo/generate', demoLimiter, async (req, res) => {
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

// Test news fetching endpoint (rate limited)
app.get('/api/test/news/:topic', demoLimiter, async (req, res) => {
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

// SECURITY: Secure error handling middleware - never expose stack traces in production
app.use((err, req, res, _next) => {
  // Log full error for debugging
  logger.error(`[ERROR] ${req.method} ${req.path}: ${err.message}`);

  // In development, log stack trace
  if (process.env.NODE_ENV !== 'production') {
    logger.error(err.stack);
  }

  // SECURITY: Never expose internal error details to clients in production
  const statusCode = err.status || err.statusCode || 500;
  const response = {
    error: process.env.NODE_ENV === 'production'
      ? 'An error occurred. Please try again later.'
      : err.message
  };

  res.status(statusCode).json(response);
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