// middleware/subscription.js
import { getSubscription, updateUser, getMarketingAddon } from '../services/database-wrapper.js';

export async function checkSubscriptionLimits(req, res, next) {
  try {
    const user = req.user;
    
    // Check if subscription needs reset
    const resetDate = new Date(user.subscription.resetDate);
    const now = new Date();
    
    if (now >= resetDate) {
      // Reset post limit - free tier gets 1 post/week, paid tiers get daily limits
      const postLimits = {
        free: 1,         // 1 post/week
        starter: 10,     // 10 posts/day
        growth: 20,      // 20 posts/day
        professional: 30, // 30 posts/day
        business: 45     // 45 posts/day
      };

      const tier = user.subscription.tier;
      const limit = postLimits[tier] || 1;

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
        error: 'Daily post limit reached',
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
    professional: 3,
    business: 4
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

function getNextResetDate(tier = 'free') {
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

// Agent limits per subscription tier
export const AGENT_LIMITS = {
  free: 1,
  starter: 2,
  growth: 5,
  professional: 10,
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
    metricsRefreshMinutes: 30
  },
  premium: {
    maxActiveCampaigns: -1, // unlimited
    maxAudienceTemplates: -1,
    maxAutoBoostRules: -1,
    metricsRefreshMinutes: 10
  }
};

/**
 * Middleware to require an active marketing add-on subscription.
 * Also requires the user to be on at least a paid (starter) tier.
 * Attaches the add-on record and limits to req.marketingAddon and req.marketingLimits.
 */
export function requireMarketingAddon() {
  const tierHierarchy = {
    free: 0,
    starter: 1,
    growth: 2,
    professional: 3,
    business: 4
  };

  return async (req, res, next) => {
    try {
      const userTierLevel = tierHierarchy[req.user?.subscription?.tier] || 0;

      if (userTierLevel < 1) {
        return res.status(403).json({
          error: 'Marketing features require a paid subscription (Starter or higher)',
          currentTier: req.user?.subscription?.tier || 'free'
        });
      }

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