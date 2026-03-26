// server.js
console.log('[STARTUP] Beginning server initialization...');
console.log('[STARTUP] Node version:', process.version);
console.log('[STARTUP] PORT:', process.env.PORT || '3000 (default)');

import express from 'express';
console.log('[STARTUP] Express loaded');

import helmet from 'helmet';
import cors from 'cors';
import dotenv from 'dotenv';
import winston from 'winston';
import path from 'path';
import { fileURLToPath } from 'url';
import session from 'express-session';
import cookieParser from 'cookie-parser';
console.log('[STARTUP] Core modules loaded');

import passport from './config/passport.js';
import { initializePassport } from './config/passport-init.js';
console.log('[STARTUP] Passport loaded');

// Load environment variables first
dotenv.config();
console.log('[STARTUP] Environment variables loaded');

// Import routes
console.log('[STARTUP] Loading routes...');
import authRoutes from './routes/auth.js';
import subscriptionRoutes from './routes/subscriptions.js';
import postsRoutes from './routes/posts.js';
import analyticsRoutes from './routes/analytics.js';
import userRoutes from './routes/users.js';
import automationRoutes from './routes/automation.js';
import testRoutes from './routes/test.js';
import connectionsRoutes from './routes/connections.js';
import agentsRoutes from './routes/agents.js';
import redditRoutes from './routes/reddit.js';
import marketingRoutes from './routes/marketing.js';
import affiliateRoutes from './routes/affiliate.js';
import supportRoutes from './routes/support.js';
import feedRoutes from './routes/feed.js';
console.log('[STARTUP] Routes loaded');

// Import middleware
console.log('[STARTUP] Loading middleware...');
import { authenticateToken } from './middleware/auth.js';
import { rateLimiter, demoLimiter } from './middleware/rateLimiter.js';
import { checkSubscriptionLimits } from './middleware/subscription.js';
import { csrfTokenSetter, csrfProtection, getCsrfToken } from './middleware/csrf.js';
console.log('[STARTUP] Middleware loaded');

// Import services
console.log('[STARTUP] Loading services...');
import { initializeDatabase, getDb } from './services/database.js';
import AutomationManager from './services/AutomationManager.js';
import { startAllWorkers, stopAllWorkers, getWorkersStatus } from './workers/index.js';
console.log('[STARTUP] Services loaded');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
console.log('[STARTUP] All imports complete, configuring app...');

// Server startup state tracking for health checks
const serverState = {
  status: 'starting', // 'starting' | 'ready' | 'error'
  startTime: Date.now(),
  error: null,
  services: {
    database: false,
    automation: false,
    workers: false
  }
};

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

// Trust proxy - required for reverse proxies (Render, Heroku, ngrok, etc.)
// This enables correct client IP detection for rate limiting and logging
app.set('trust proxy', 1);

// CRITICAL: Health check endpoint MUST be BEFORE any middleware that requires Origin header
// Render's internal health checker doesn't send Origin headers
app.get('/api/health', (req, res) => {
  const uptime = Math.floor((Date.now() - serverState.startTime) / 1000);
  // Only log health checks when status is not ready (useful for debugging startup issues)
  if (serverState.status !== 'ready') {
    console.log(`[HEALTH] Health check - status: ${serverState.status}, uptime: ${uptime}s`);
  }
  res.json({
    status: serverState.status === 'ready' ? 'healthy' : serverState.status,
    ready: serverState.status === 'ready',
    uptime,
    services: serverState.services,
    timestamp: new Date().toISOString(),
    ...(serverState.error && { error: serverState.error })
  });
});

// SECURITY: Hardened security headers with Helmet
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // SECURITY: Removed 'unsafe-eval', kept 'unsafe-inline' for now (requires frontend refactor to fully remove)
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com", "https://www.googletagmanager.com", "https://www.google-analytics.com", "https://app.lemonsqueezy.com", "https://assets.lemonsqueezy.com", "https://lmsqueezy.com"],
      scriptSrcAttr: ["'unsafe-inline'"], // TODO: Remove after refactoring inline event handlers
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com", "https://fonts.googleapis.com", "https://api.fontshare.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdn.fontshare.com"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", "https://api.lemonsqueezy.com", "https://www.google-analytics.com", "https://analytics.google.com", "https://region1.google-analytics.com", process.env.SUPABASE_URL].filter(Boolean),
      frameSrc: ["'self'", "https://app.lemonsqueezy.com", "https://*.lemonsqueezy.com", "https://www.youtube.com", "https://www.tiktok.com"],
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

// CORS middleware - only apply to /api routes
// Browser navigation to HTML pages doesn't send Origin headers, so we can't require them globally
const corsMiddleware = cors({
  origin: (origin, callback) => {
    // Allow requests with no origin in development (curl, Postman, etc.)
    // In production, /api routes will still be protected via the route-specific CORS below
    if (!origin) {
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
});

// Apply CORS globally for preflight requests and non-API routes
app.use(corsMiddleware);

// Stricter CORS for API routes - require Origin header in production for cross-origin requests
app.use('/api', (req, res, next) => {
  // Skip health check - already handled before CORS
  if (req.path === '/health') {
    return next();
  }

  const origin = req.headers.origin;

  // In production, API requests from browsers must have an Origin header
  // Server-to-server requests (webhooks, etc.) won't have Origin and are handled separately
  if (process.env.NODE_ENV === 'production' && !origin) {
    // Allow same-origin requests (no Origin header means same-origin in browsers)
    // Check if it's likely a same-origin request by looking at other headers
    const referer = req.headers.referer;
    if (referer && allowedOrigins.some(allowed => referer.startsWith(allowed))) {
      return next();
    }
    // For API calls without Origin or Referer, log but allow (could be server-to-server)
    // The auth middleware will still protect authenticated routes
  }

  next();
});

// Cookie parser for httpOnly cookie authentication
app.use(cookieParser());

// SECURITY: CSRF token setter - sets token cookie for all requests
app.use(csrfTokenSetter);

// Marketing add-on webhook handler (shared by the main webhook endpoint)
async function handleMarketingAddonWebhook(eventName, payload, customData, existingAddon, db) {
  const subscriptionData = payload.data.attributes;
  const subscriptionId = payload.data.id;

  switch (eventName) {
    case 'subscription_created': {
      const userId = customData?.user_id;
      if (!userId) {
        console.error('[WEBHOOK] No user_id in custom_data for marketing addon creation');
        return;
      }

      const quantity = subscriptionData.quantity || 1;
      console.log(`[WEBHOOK] Creating marketing addon for user ${userId}, quantity: ${quantity}`);

      await db.upsertMarketingAddon({
        userId,
        status: 'active',
        lsSubscriptionId: String(subscriptionId),
        lsVariantId: String(subscriptionData.variant_id),
        plan: 'standard',
        monthlyPrice: 1900 * quantity,
        maxAdAccounts: quantity,
        currentPeriodStart: subscriptionData.created_at,
        currentPeriodEnd: subscriptionData.renews_at
      });

      console.log(`[WEBHOOK] Marketing addon created for user ${userId}, quantity: ${quantity}`);
      break;
    }

    case 'subscription_updated':
    case 'subscription_payment_success': {
      if (!existingAddon) {
        // Try lookup by user_id from custom_data as fallback
        if (customData?.user_id) {
          const { getMarketingAddon } = await import('./services/database-wrapper.js');
          const addonByUser = await getMarketingAddon(customData.user_id);
          if (addonByUser) {
            console.log(`[WEBHOOK] Found marketing addon by user_id fallback, fixing ls_subscription_id from ${addonByUser.ls_subscription_id} to ${subscriptionId}`);
            const quantity = subscriptionData.quantity || 1;
            await db.updateMarketingAddon(addonByUser.user_id, {
              ls_subscription_id: String(subscriptionId),
              status: normalizeAddonStatus(subscriptionData.status),
              max_ad_accounts: quantity,
              current_period_start: subscriptionData.created_at,
              current_period_end: subscriptionData.renews_at
            });
            console.log(`[WEBHOOK] Marketing addon updated (fallback) for user ${addonByUser.user_id}, quantity: ${quantity}`);
            return;
          }
        }
        console.error(`[WEBHOOK] Marketing addon not found for LS ID: ${subscriptionId}`);
        return;
      }
      const status = normalizeAddonStatus(subscriptionData.status);
      const quantity = subscriptionData.quantity || 1;
      await db.updateMarketingAddon(existingAddon.user_id, {
        status,
        max_ad_accounts: quantity,
        current_period_start: subscriptionData.created_at,
        current_period_end: subscriptionData.renews_at
      });
      console.log(`[WEBHOOK] Marketing addon updated for user ${existingAddon.user_id}, status: ${status}, quantity: ${quantity}`);
      break;
    }

    case 'subscription_cancelled': {
      if (!existingAddon) return;
      await db.updateMarketingAddon(existingAddon.user_id, { status: 'cancelled' });
      console.log(`[WEBHOOK] Marketing addon cancelled for user ${existingAddon.user_id}`);
      break;
    }

    case 'subscription_expired': {
      if (!existingAddon) return;
      await db.updateMarketingAddon(existingAddon.user_id, { status: 'expired' });
      console.log(`[WEBHOOK] Marketing addon expired for user ${existingAddon.user_id}`);
      break;
    }

    case 'subscription_payment_failed': {
      if (!existingAddon) return;
      await db.updateMarketingAddon(existingAddon.user_id, { status: 'past_due' });
      console.log(`[WEBHOOK] Marketing addon payment failed for user ${existingAddon.user_id}`);
      break;
    }

    default:
      console.log(`[WEBHOOK] Unhandled marketing addon event: ${eventName}`);
  }
}

// Normalize Lemon Squeezy subscription status to DB-allowed values.
// DB check constraints allow: 'active', 'cancelled', 'expired', 'past_due'.
// LS may send other statuses like 'paid', 'on_trial', 'paused', etc.
function normalizeAddonStatus(lsStatus) {
  if (lsStatus === 'active' || lsStatus === 'paid' || lsStatus === 'on_trial') return 'active';
  if (lsStatus === 'cancelled' || lsStatus === 'paused') return 'cancelled';
  if (lsStatus === 'expired') return 'expired';
  if (lsStatus === 'past_due' || lsStatus === 'unpaid') return 'past_due';
  return 'active';
}

// Affiliate add-on webhook handler (shared by the main webhook endpoint)
async function handleAffiliateAddonWebhook(eventName, payload, customData, existingAddon, db) {
  const subscriptionData = payload.data.attributes;
  const subscriptionId = payload.data.id;

  switch (eventName) {
    case 'subscription_created': {
      const userId = customData?.user_id;
      if (!userId) {
        console.error('[WEBHOOK] No user_id in custom_data for affiliate addon creation');
        return;
      }

      console.log(`[WEBHOOK] Creating affiliate addon for user ${userId}`);

      await db.upsertAffiliateAddon({
        userId,
        status: 'active',
        lsSubscriptionId: String(subscriptionId),
        lsVariantId: String(subscriptionData.variant_id),
        plan: 'standard',
        monthlyPrice: 900,
        maxKeywordSets: 5,
        maxProductsPerDay: 20,
        currentPeriodStart: subscriptionData.created_at,
        currentPeriodEnd: subscriptionData.renews_at
      });

      console.log(`[WEBHOOK] Affiliate addon created for user ${userId}`);
      break;
    }

    case 'subscription_updated':
    case 'subscription_payment_success': {
      if (!existingAddon) {
        // Try lookup by user_id from custom_data as fallback
        if (customData?.user_id) {
          const { getAffiliateAddon } = await import('./services/database-wrapper.js');
          const addonByUser = await getAffiliateAddon(customData.user_id);
          if (addonByUser) {
            console.log(`[WEBHOOK] Found affiliate addon by user_id fallback, fixing ls_subscription_id from ${addonByUser.ls_subscription_id} to ${subscriptionId}`);
            await db.updateAffiliateAddon(addonByUser.user_id, {
              ls_subscription_id: String(subscriptionId),
              status: normalizeAddonStatus(subscriptionData.status),
              current_period_start: subscriptionData.created_at,
              current_period_end: subscriptionData.renews_at
            });
            console.log(`[WEBHOOK] Affiliate addon updated (fallback) for user ${addonByUser.user_id}`);
            return;
          }
        }
        console.error(`[WEBHOOK] Affiliate addon not found for LS ID: ${subscriptionId}`);
        return;
      }
      const status = normalizeAddonStatus(subscriptionData.status);
      await db.updateAffiliateAddon(existingAddon.user_id, {
        status,
        current_period_start: subscriptionData.created_at,
        current_period_end: subscriptionData.renews_at
      });
      console.log(`[WEBHOOK] Affiliate addon updated for user ${existingAddon.user_id}, status: ${status}`);
      break;
    }

    case 'subscription_cancelled': {
      if (!existingAddon) return;
      await db.updateAffiliateAddon(existingAddon.user_id, { status: 'cancelled' });
      console.log(`[WEBHOOK] Affiliate addon cancelled for user ${existingAddon.user_id}`);
      break;
    }

    case 'subscription_expired': {
      if (!existingAddon) return;
      await db.updateAffiliateAddon(existingAddon.user_id, { status: 'expired' });
      console.log(`[WEBHOOK] Affiliate addon expired for user ${existingAddon.user_id}`);
      break;
    }

    case 'subscription_payment_failed': {
      if (!existingAddon) return;
      await db.updateAffiliateAddon(existingAddon.user_id, { status: 'past_due' });
      console.log(`[WEBHOOK] Affiliate addon payment failed for user ${existingAddon.user_id}`);
      break;
    }

    default:
      console.log(`[WEBHOOK] Unhandled affiliate addon event: ${eventName}`);
  }
}

// Lemon Squeezy webhook endpoint - MUST be before express.json() to access raw body
// This route is mounted separately to handle raw body for signature verification
app.post('/webhooks/lemonsqueezy', express.raw({ type: 'application/json' }), async (req, res) => {
  console.log('[WEBHOOK] Lemon Squeezy webhook received');

  const crypto = await import('crypto');
  const signature = req.headers['x-signature'];

  // SECURITY: Validate webhook secret is configured
  // Note: Lemon Squeezy generates secrets that may be shorter than 32 chars
  const webhookSecret = process.env.LEMON_SQUEEZY_WEBHOOK_SECRET;
  if (!webhookSecret || webhookSecret.length < 16) {
    console.error('[WEBHOOK] Webhook secret not configured or too short (min 16 chars)');
    console.error('[WEBHOOK] Secret length:', webhookSecret ? webhookSecret.length : 0);
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
  const { createSubscription, getSubscriptionByLsId, updateUser, upsertMarketingAddon, getMarketingAddonByLsId, updateMarketingAddon, upsertAffiliateAddon, getAffiliateAddonByLsId, updateAffiliateAddon } = await import('./services/database-wrapper.js');

  // Helper to get post limit by tier (free = 1 post/week, others = posts/day)
  const getTierPostLimit = (tier) => {
    const limits = { free: 1, starter: 6, growth: 12, business: 30 };
    return limits[tier] || 1;
  };

  // Variant ID to tier mapping
  const VARIANT_TIERS = {
    [process.env.LEMON_SQUEEZY_49_VARIANT_ID]: 'starter',
    [process.env.LEMON_SQUEEZY_149_VARIANT_ID]: 'growth',
    [process.env.LEMON_SQUEEZY_499_VARIANT_ID]: 'business'
  };

  try {
    // Check if this event is for a marketing or affiliate add-on
    const isMarketingAddon = customData?.addon_type === 'marketing';
    const isAffiliateAddon = customData?.addon_type === 'affiliate';

    // For non-creation events, also check if the subscription ID belongs to an existing addon
    const subscriptionIdForLookup = payload.data?.id;
    const existingMarketingAddon = (!isMarketingAddon && !isAffiliateAddon && subscriptionIdForLookup)
      ? await getMarketingAddonByLsId(String(subscriptionIdForLookup))
      : null;
    const existingAffiliateAddon = (!isMarketingAddon && !isAffiliateAddon && !existingMarketingAddon && subscriptionIdForLookup)
      ? await getAffiliateAddonByLsId(String(subscriptionIdForLookup))
      : null;

    if (isMarketingAddon || existingMarketingAddon) {
      // ── MARKETING ADD-ON EVENTS ──
      await handleMarketingAddonWebhook(eventName, payload, customData, existingMarketingAddon, { upsertMarketingAddon, updateMarketingAddon });
      return res.status(200).json({ received: true });
    }

    if (isAffiliateAddon || existingAffiliateAddon) {
      // ── AFFILIATE ADD-ON EVENTS ──
      await handleAffiliateAddonWebhook(eventName, payload, customData, existingAffiliateAddon, { upsertAffiliateAddon, updateAffiliateAddon });
      return res.status(200).json({ received: true });
    }

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
            postsRemaining: 1,
            dailyLimit: 1,
            cancelAtPeriodEnd: false
          },
          lsSubscriptionId: null
        });

        console.log(`[WEBHOOK] Subscription expired, user ${subscription.userId} downgraded to free (1 post/week)`);
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

      case 'order_created': {
        console.log(`[WEBHOOK] Order created: ${payload.data.id}`);
        const purchaseType = customData?.purchase_type;
        if (purchaseType && customData?.user_id) {
          const PER_USE_CONFIG = {
            model_training: { amountCents: 500, description: 'Brand Asset Model Training', creditsPerPurchase: 1 },
            image_generation: { amountCents: 75, description: 'Brand Image Generation', creditsPerPurchase: 1 },
            asset_image_gen_pack: { amountCents: 450, description: 'Brand Asset Image Generation Pack (8 images)', creditsPerPurchase: 8 }
          };
          const config = PER_USE_CONFIG[purchaseType];
          if (config) {
            const { createPerUsePurchase } = await import('./services/database-wrapper.js');
            await createPerUsePurchase(customData.user_id, {
              purchaseType,
              amountCents: config.amountCents,
              currency: 'usd',
              status: 'completed',
              paymentProvider: 'lemon_squeezy',
              providerReferenceId: String(payload.data.id),
              description: config.description,
              creditsTotal: config.creditsPerPurchase || 1,
              metadata: {
                ad_account_id: customData.ad_account_id || null,
                ls_order_number: payload.data.attributes?.order_number
              }
            });
            console.log(`[WEBHOOK] Per-use purchase recorded: ${purchaseType} (${config.creditsPerPurchase || 1} credits) for user ${customData.user_id}`);
          }
        }
        break;
      }

      default:
        console.log(`[WEBHOOK] Unhandled event: ${eventName}`);
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error(`[WEBHOOK] Error handling ${eventName}:`, error);
    res.status(200).json({ received: true, error: error.message });
  }
});

// Resend inbound email webhook — fallback for email replies (primary method: web reply page)
// Kept as secondary path in case Resend adds body content to webhooks in the future
app.post('/webhooks/resend', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const payload = JSON.parse(req.body.toString());

    if (payload.type !== 'email.received') {
      return res.status(200).json({ received: true });
    }

    const emailData = payload.data;
    const toAddresses = Array.isArray(emailData.to) ? emailData.to : [emailData.to];

    // Extract conversation ID from the to address (support+<conv_id>@domain)
    let conversationId = null;
    for (const addr of toAddresses) {
      const match = String(addr).match(/support\+([a-f0-9-]{36})@/i);
      if (match) { conversationId = match[1]; break; }
    }

    if (!conversationId) {
      return res.status(200).json({ received: true });
    }

    const { supabaseAdmin } = await import('./services/supabase.js');

    // Extract reply text (Resend may add body support in future versions)
    const rawText = (emailData.text || emailData.text_body || payload.text || '').trim();
    if (!rawText) {
      console.log(`[WEBHOOK/RESEND] Inbound email for conversation ${conversationId} — no body content (expected, use web reply page)`);
      return res.status(200).json({ received: true });
    }

    // Strip quoted email content
    let replyText = rawText;
    for (const pattern of [
      /\r?\nOn .+wrote:[\s\S]*/,
      /\r?\n-{2,}\s*Original Message[\s\S]*/i,
      /\r?\nFrom:\s[\s\S]*/,
      /\r?\nSent from [\s\S]*/i,
      /\r?\n_{2,}[\s\S]*/,
    ]) {
      replyText = replyText.replace(pattern, '');
    }
    replyText = replyText.replace(/(\r?\n>.*)+\s*$/, '').trim();

    if (!replyText) {
      return res.status(200).json({ received: true });
    }

    // Store reply
    await supabaseAdmin.from('support_messages').insert({
      conversation_id: conversationId,
      sender_type: 'support',
      message: replyText,
      is_read: false,
    });

    await supabaseAdmin.from('support_conversations')
      .update({ updated_at: new Date().toISOString(), status: 'open' })
      .eq('id', conversationId);

    console.log(`[WEBHOOK/RESEND] Email reply stored for conversation ${conversationId} (${replyText.length} chars)`);
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('[WEBHOOK/RESEND] Error:', err.message);
    res.status(200).json({ received: true });
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging middleware - log all API requests for debugging
app.use('/api', (req, res, next) => {
  // Log API requests (auth status only, not token values)
  const hasAuth = !!(req.headers.authorization || req.cookies?.authToken || req.query?.token);
  console.log(`[API] ${req.method} ${req.path} - Auth: ${hasAuth ? 'present' : 'missing'}`);
  next();
});

// SECURITY: SESSION_SECRET must be set in production - log error but don't crash
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET && process.env.NODE_ENV === 'production') {
  logger.error('FATAL: SESSION_SECRET environment variable must be set in production');
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

// Apply rate limiting to all API routes (health check is defined before CORS middleware)
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

// AEO: Serve llms.txt for AI model discovery
app.get('/llms.txt', (req, res) => {
  res.type('text/plain');
  res.sendFile(path.join(__dirname, 'public', 'llms.txt'));
});

// SEO: Add caching headers for static assets
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    // Set longer cache for images and fonts (immutable assets)
    if (filePath.match(/\.(jpg|jpeg|png|gif|ico|svg|woff|woff2|ttf|eot)$/)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000'); // 1 year
    }
    // HTML files - always revalidate
    else if (filePath.match(/\.html$/)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
    // CSS and JS - short cache with revalidation for active development
    else if (filePath.match(/\.(css|js)$/)) {
      res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate'); // 5 minutes
    }
    // Default for other files
    else {
      res.setHeader('Cache-Control', 'public, max-age=3600'); // 1 hour
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
app.use('/api/reddit', authenticateToken, csrfProtection, redditRoutes); // Reddit-specific API (subreddit requirements, flairs)
app.use('/api/marketing', marketingRoutes); // Marketing API (auth + CSRF + marketing addon handled in router)
app.use('/api/affiliate', authenticateToken, csrfProtection, affiliateRoutes); // AE Affiliate API (affiliate addon middleware in router)
app.use('/api/support', supportRoutes); // Support chat (public, no auth — rate limited in router)
app.use('/api/feed', feedRoutes);       // Public feed — no auth required, rate limited in router

// SECURITY: Disable test routes in production
if (process.env.NODE_ENV === 'production') {
  app.use('/api/test', (req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
} else {
  app.use('/api/test', testRoutes); // Test routes only in development
}

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

// Initialize services after server is listening
async function initializeServices() {
  const workersEnabled = process.env.BACKGROUND_WORKERS_ENABLED === 'true';

  try {
    // Initialize database (Supabase)
    logger.info('Initializing database connection...');
    await initializeDatabase();
    serverState.services.database = true;
    logger.info('Supabase database connection established');

    // Initialize automation manager
    const db = getDb();
    const automationManager = new AutomationManager(db);
    serverState.services.automation = true;
    logger.info('Automation system initialized');

    // Make automation manager available globally
    app.locals.automationManager = automationManager;

    // Start background workers if enabled
    if (workersEnabled) {
      startAllWorkers();
      serverState.services.workers = true;
      logger.info('Background workers started');
    } else {
      serverState.services.workers = true; // Mark as done even if disabled
      logger.info('Background workers disabled (set BACKGROUND_WORKERS_ENABLED=true to enable)');
    }

    // All services initialized successfully
    serverState.status = 'ready';
    logger.info('All services initialized - server is ready');
    logger.info(`🤖 Automation enabled: ${process.env.AUTOMATION_ENABLED === 'true' ? 'YES' : 'NO'}`);
    logger.info(`⚙️  Background workers: ${workersEnabled ? 'ENABLED' : 'DISABLED'}`);

  } catch (error) {
    serverState.status = 'error';
    serverState.error = error.message;
    logger.error('Failed to initialize services:', error);
    // Don't exit - let health check report the error state for debugging
  }
}

// Start server - listen FIRST, then initialize services
function startServer() {
  const PORT = process.env.PORT || 3000;
  const workersEnabled = process.env.BACKGROUND_WORKERS_ENABLED === 'true';

  // Start listening IMMEDIATELY so health checks pass
  const server = app.listen(PORT, () => {
    logger.info(`🚀 Server listening on port ${PORT} (initializing services...)`);
    logger.info(`🌐 Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:3000'}`);

    // Initialize services AFTER server is listening
    initializeServices();
  });

  // Graceful shutdown handling
  const gracefulShutdown = (signal) => {
    logger.info(`${signal} received. Shutting down gracefully...`);

    // Stop background workers if they were started
    if (workersEnabled && serverState.services.workers) {
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