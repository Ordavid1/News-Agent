// middleware/subscription.js
import { getSubscription, updateUser, getMarketingAddon, getAffiliateAddon, getUserById, decrementPostsRemaining } from '../services/database-wrapper.js';

export async function checkSubscriptionLimits(req, res, next) {
  try {
    const user = req.user;
    
    // Check if subscription needs reset
    const resetDate = new Date(user.subscription.resetDate);
    const now = new Date();
    
    if (now >= resetDate) {
      // Reset post limit - free tier gets 1 post/week, paid tiers get daily limits
      const tier = user.subscription.tier;
      const limit = POST_LIMITS[tier] || 1;

      await updateUser(user.id, {
        'subscription.postsRemaining': limit,
        'subscription.dailyLimit': limit,
        'subscription.resetDate': getNextResetDate(tier)
      });

      // Refresh user data
      user.subscription.postsRemaining = limit;
      user.subscription.dailyLimit = limit;
      user.subscription.resetDate = getNextResetDate(tier);
    }
    
    // Check if user has posts remaining
    if (user.subscription.postsRemaining <= 0) {
      return res.status(403).json({ 
        error: 'Post limit reached',
        subscription: user.subscription
      });
    }
    
    // Check subscription status
    if (user.subscription.status !== 'active') {
      return res.status(403).json({ 
        error: 'Subscription is not active',
        subscription: user.subscription
      });
    }
    
    next();
  } catch (error) {
    console.error('Subscription check error:', error);
    res.status(500).json({ error: 'Failed to verify subscription' });
  }
}

export function requireTier(minTier) {
  const tierHierarchy = {
    free: 0,
    starter: 1,
    growth: 2,
    business: 3
  };

  return (req, res, next) => {
    const userTierLevel = tierHierarchy[req.user.subscription.tier] || 0;
    const requiredTierLevel = tierHierarchy[minTier] || 0;
    
    if (userTierLevel < requiredTierLevel) {
      return res.status(403).json({ 
        error: `This feature requires ${minTier} tier or higher`,
        currentTier: req.user.subscription.tier
      });
    }
    
    next();
  };
}

/**
 * Post limit constants — shared between middleware and automation service.
 */
export const POST_LIMITS = {
  free: 1,         // 1 post/week
  starter: 6,      // 6 posts/day
  growth: 12,      // 12 posts/day
  business: 30     // 30 posts/day
};

/**
 * Check and atomically decrement a user's post quota.
 * Callable from both HTTP middleware and background automation.
 * Handles reset-date rollover automatically.
 *
 * @param {string} userId
 * @returns {Promise<{allowed: boolean, postsRemaining?: number, error?: string}>}
 */
export async function checkAndDecrementPostQuota(userId) {
  const user = await getUserById(userId);
  if (!user || !user.subscription) {
    return { allowed: false, error: 'user_not_found' };
  }

  const sub = user.subscription;
  const tier = sub.tier || 'free';
  const now = new Date();
  const resetDate = sub.resetDate ? new Date(sub.resetDate) : new Date(0);

  // Reset quota if past reset date
  if (now >= resetDate) {
    const limit = POST_LIMITS[tier] || 1;
    const nextReset = getNextResetDate(tier);

    await updateUser(userId, {
      'subscription.postsRemaining': limit,
      'subscription.dailyLimit': limit,
      'subscription.resetDate': nextReset
    });

    sub.postsRemaining = limit;
    sub.resetDate = nextReset;
  }

  if ((sub.postsRemaining ?? 0) <= 0) {
    return { allowed: false, error: 'post_limit_reached', postsRemaining: 0 };
  }

  // Atomically decrement
  await decrementPostsRemaining(userId);

  return { allowed: true, postsRemaining: (sub.postsRemaining ?? 1) - 1 };
}

export function getNextResetDate(tier = 'free') {
  const now = new Date();
  const resetDate = new Date(now);

  if (tier === 'free') {
    // Free tier: 7-day reset period (1 post per week)
    resetDate.setDate(resetDate.getDate() + 7);
  } else {
    // Paid tiers: daily reset
    resetDate.setDate(resetDate.getDate() + 1);
  }

  resetDate.setHours(0, 0, 0, 0);
  return resetDate;
}

// ============================================
// VIDEO LIMITS
// ============================================

// Monthly video post limits per subscription tier
export const VIDEO_LIMITS = {
  free: 0,
  starter: 2,
  growth: 10,
  business: 30
};

/**
 * Get video limit for a subscription tier
 * @param {string} tier - Subscription tier name
 * @returns {number} Monthly video limit
 */
export function getVideoLimit(tier) {
  return VIDEO_LIMITS[tier] ?? 0;
}

/**
 * Check video quota for a user. Called before video generation (TikTok).
 * Handles monthly reset and returns remaining count or throws.
 * @param {string} userId - User ID
 * @param {object} subscription - User's subscription object
 * @returns {Promise<{allowed: boolean, videosRemaining: number, videoMonthlyLimit: number}>}
 */
export async function checkVideoQuota(userId, subscription) {
  const tier = subscription.tier || 'free';
  const limit = getVideoLimit(tier);

  // Free tier has no video access
  if (limit === 0) {
    return { allowed: false, videosRemaining: 0, videoMonthlyLimit: 0, error: 'Video posts require a paid subscription' };
  }

  const now = new Date();
  const videoResetDate = subscription.videoResetDate ? new Date(subscription.videoResetDate) : new Date(0);

  // Detect uninitialized video quota: tier allows videos but quota was never set
  // (e.g., subscription upgraded without setting video fields)
  const currentMonthlyLimit = subscription.videoMonthlyLimit ?? 0;
  const quotaUninitialized = currentMonthlyLimit !== limit;

  // Reset quota if monthly cycle expired OR if quota was never initialized for this tier
  if (now >= videoResetDate || quotaUninitialized) {
    const nextReset = getMonthlyVideoResetDate();
    await updateUser(userId, {
      'subscription.videosRemaining': limit,
      'subscription.videoMonthlyLimit': limit,
      'subscription.videoResetDate': nextReset
    });

    // Refresh in-memory
    subscription.videosRemaining = limit;
    subscription.videoMonthlyLimit = limit;
    subscription.videoResetDate = nextReset;
  }

  if ((subscription.videosRemaining ?? 0) <= 0) {
    return { allowed: false, videosRemaining: 0, videoMonthlyLimit: limit, error: 'Monthly video limit reached' };
  }

  return { allowed: true, videosRemaining: subscription.videosRemaining, videoMonthlyLimit: limit };
}

function getMonthlyVideoResetDate() {
  const now = new Date();
  const resetDate = new Date(now);
  resetDate.setMonth(resetDate.getMonth() + 1);
  resetDate.setHours(0, 0, 0, 0);
  return resetDate;
}

// ============================================
// AGENT LIMITS
// ============================================

// Agent limits per subscription tier
export const AGENT_LIMITS = {
  free: 1,
  starter: 2,
  growth: 5,
  business: -1 // unlimited
};

/**
 * Get agent limit for a subscription tier
 * @param {string} tier - Subscription tier name
 * @returns {number} Agent limit (-1 for unlimited)
 */
export function getAgentLimit(tier) {
  return AGENT_LIMITS[tier] ?? 1;
}

/**
 * Check if user can create more agents
 * @param {string} tier - User's subscription tier
 * @param {number} currentCount - Current number of agents
 * @returns {boolean} True if can create more agents
 */
export function canCreateAgent(tier, currentCount) {
  const limit = getAgentLimit(tier);
  return limit === -1 || currentCount < limit;
}

// ============================================
// MARKETING ADD-ON
// ============================================

// Marketing add-on feature limits by plan
export const MARKETING_LIMITS = {
  standard: {
    maxActiveCampaigns: 10,
    maxAudienceTemplates: 20,
    maxAutoBoostRules: 10,
    metricsRefreshMinutes: 30,
    maxBrandVoiceProfiles: 2
  },
  premium: {
    maxActiveCampaigns: -1, // unlimited
    maxAudienceTemplates: -1,
    maxAutoBoostRules: -1,
    metricsRefreshMinutes: 10,
    maxBrandVoiceProfiles: -1 // unlimited
  }
};

/**
 * Middleware to require an active marketing add-on subscription.
 * Also requires the user to be on at least a paid (starter) tier.
 * Attaches the add-on record and limits to req.marketingAddon and req.marketingLimits.
 */
export function requireMarketingAddon() {
  return async (req, res, next) => {
    try {
      const addon = await getMarketingAddon(req.user.id);

      if (!addon || addon.status !== 'active') {
        return res.status(403).json({
          error: 'Marketing add-on required',
          hasAddon: !!addon,
          addonStatus: addon?.status || null
        });
      }

      req.marketingAddon = addon;
      req.marketingLimits = MARKETING_LIMITS[addon.plan] || MARKETING_LIMITS.standard;
      next();
    } catch (error) {
      console.error('Marketing addon check error:', error);
      res.status(500).json({ error: 'Failed to verify marketing access' });
    }
  };
}

// ============================================
// AFFILIATE ADD-ON
// ============================================

// Affiliate add-on feature limits by plan (DEPRECATED — kept for backward compat)
export const AFFILIATE_LIMITS = {
  standard: {
    maxKeywordSets: 5,
    maxProductsPerDay: 20,
    maxApiCallsPerDay: 5000
  },
  premium: {
    maxKeywordSets: -1, // unlimited
    maxProductsPerDay: -1,
    maxApiCallsPerDay: 5000
  }
};

// Tier-based affiliate keyword set limits (replaces addon-based AFFILIATE_LIMITS)
export const AFFILIATE_KEYWORD_LIMITS = {
  free: 1,       // matches AGENT_LIMITS.free
  starter: 2,    // matches AGENT_LIMITS.starter
  growth: 5,     // matches AGENT_LIMITS.growth
  business: -1   // unlimited, matches AGENT_LIMITS.business
};

export function getAffiliateKeywordLimit(tier) {
  return AFFILIATE_KEYWORD_LIMITS[tier] ?? 0;
}

/**
 * DEPRECATED: Affiliate addon paywall removed.
 * All affiliate routes are now open to authenticated users.
 * Keyword/agent creation limits are enforced per-route by subscription tier.
 * Kept as a no-op for backward compatibility.
 */
export function requireAffiliateAddon() {
  return (req, res, next) => next();
}