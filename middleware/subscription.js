// middleware/subscription.js
import { getSubscription, updateUser } from '../services/database-wrapper.js';

export async function checkSubscriptionLimits(req, res, next) {
  try {
    const user = req.user;
    
    // Check if subscription needs reset
    const resetDate = new Date(user.subscription.resetDate);
    const now = new Date();
    
    if (now >= resetDate) {
      // Reset daily post limit
      const postLimits = {
        free: 5,         // 5 posts/day
        starter: 10,     // 10 posts/day  
        growth: 20,      // 20 posts/day
        professional: 30, // 30 posts/day
        business: 45     // 45 posts/day
      };
      
      await updateUser(user.id, {
        'subscription.postsRemaining': postLimits[user.subscription.tier] || 5,
        'subscription.dailyLimit': postLimits[user.subscription.tier] || 5,
        'subscription.resetDate': getNextResetDate()
      });
      
      // Refresh user data
      user.subscription.postsRemaining = postLimits[user.subscription.tier] || 5;
      user.subscription.dailyLimit = postLimits[user.subscription.tier] || 5;
      user.subscription.resetDate = getNextResetDate();
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

function getNextResetDate() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  return tomorrow;
}