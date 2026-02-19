// routes/subscriptions.js - Lemon Squeezy Integration
import express from 'express';
import crypto from 'crypto';
import { createSubscription, getSubscription, updateUser, getSubscriptionByLsId, getMarketingAddon, getMarketingAddonByLsId, upsertMarketingAddon, updateMarketingAddon } from '../services/database-wrapper.js';
// SECURITY: Input validation
import { checkoutValidation, changePlanValidation } from '../utils/validators.js';
// Supabase for plan interest tracking
import { supabaseAdmin, isConfigured as isSupabaseConfigured } from '../services/supabase.js';

const router = express.Router();

// Pricing configuration with Lemon Squeezy variant IDs
// Note: Facebook is disabled (Coming Soon) - not included in platform counts
const PRICING_TIERS = {
  starter: {
    name: 'Starter Package',
    monthlyPrice: 4900, // $49 in cents
    postsPerDay: 10,
    variantId: process.env.LEMON_SQUEEZY_49_VARIANT_ID,
    features: ['10 posts/day (300/mo)', '3 platforms (LinkedIn, Reddit, Telegram)', 'Basic analytics', 'Email support']
  },
  growth: {
    name: 'Growth Package',
    monthlyPrice: 14900, // $149
    postsPerDay: 20,
    variantId: process.env.LEMON_SQUEEZY_149_VARIANT_ID,
    features: ['20 posts/day (600/mo)', '4 platforms (+ Twitter)', 'Advanced analytics', 'Post scheduling', 'Priority support']
  },
  professional: {
    name: 'Professional Package',
    monthlyPrice: 39900, // $399
    postsPerDay: 30,
    variantId: process.env.LEMON_SQUEEZY_399_VARIANT_ID,
    features: ['30 posts/day (900/mo)', '5 platforms (+ Instagram)', 'Bulk generation', 'API access', 'Custom posting schedules', 'Dedicated support']
  },
  business: {
    name: 'Business Package',
    monthlyPrice: 79900, // $799
    postsPerDay: 45,
    variantId: process.env.LEMON_SQUEEZY_799_VARIANT_ID,
    features: ['45 posts/day (1,350/mo)', '7 platforms (+ TikTok, YouTube)', 'White-label options', 'Webhook integrations', 'Custom analytics', '24/7 phone support']
  }
};

// Helper to get post limit by tier
function getTierPostLimit(tier) {
  const limits = {
    free: 1,          // 1 post/week
    starter: 10,      // 10 posts/day
    growth: 20,       // 20 posts/day
    professional: 30, // 30 posts/day
    business: 45      // 45 posts/day
  };
  return limits[tier] || 1;
}

// Get current subscription
router.get('/current', async (req, res) => {
  console.log('[SUBSCRIPTION] GET /current - User:', req.user?.id);
  try {
    const subscription = await getSubscription(req.user.id);
    console.log('[SUBSCRIPTION] Subscription tier:', subscription?.tier || 'none');

    res.json({
      subscription: req.user.subscription,
      fullSubscription: subscription,
      pricingTiers: PRICING_TIERS
    });
  } catch (error) {
    console.error('[SUBSCRIPTION] Error fetching subscription:', error);
    res.status(500).json({ error: 'Failed to fetch subscription' });
  }
});

// Create Lemon Squeezy checkout session
router.post('/create-checkout', checkoutValidation, async (req, res) => {
  console.log('[CHECKOUT] POST /create-checkout - User:', req.user?.id, 'Tier:', req.body?.tier);
  try {
    const { tier } = req.body;

    if (!PRICING_TIERS[tier]) {
      console.error('[CHECKOUT] Invalid tier:', tier);
      return res.status(400).json({ error: 'Invalid subscription tier' });
    }

    const tierConfig = PRICING_TIERS[tier];
    console.log('[CHECKOUT] Tier config:', tier, 'Variant ID:', tierConfig.variantId);

    if (!tierConfig.variantId) {
      console.error(`[CHECKOUT] Missing variant ID for tier: ${tier}`);
      return res.status(500).json({ error: 'Payment configuration error' });
    }

    const checkoutPayload = {
      data: {
        type: 'checkouts',
        attributes: {
          checkout_data: {
            email: req.user.email,
            name: req.user.name || req.user.email.split('@')[0],
            custom: {
              user_id: req.user.id,
              tier: tier
            }
          },
          product_options: {
            name: tierConfig.name,
            description: tierConfig.features.join(', '),
            redirect_url: `${process.env.FRONTEND_URL}/profile.html?tab=subscription&payment=success`,
            receipt_thank_you_note: 'Thank you for subscribing to News Agent! Your account has been upgraded.'
          },
          checkout_options: {
            embed: false,
            media: false,
            subscription_preview: true
          }
        },
        relationships: {
          store: {
            data: {
              type: 'stores',
              id: process.env.LEMON_SQUEEZY_STORE_ID
            }
          },
          variant: {
            data: {
              type: 'variants',
              id: tierConfig.variantId
            }
          }
        }
      }
    };

    console.log('[CHECKOUT] Creating LS checkout for tier:', tier);
    console.log('[CHECKOUT] Store ID configured:', !!process.env.LEMON_SQUEEZY_STORE_ID);
    console.log('[CHECKOUT] API Key configured:', !!process.env.LEMON_SQUEEZY_API_KEY);

    // Create Lemon Squeezy checkout
    const response = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
        'Authorization': `Bearer ${process.env.LEMON_SQUEEZY_API_KEY}`
      },
      body: JSON.stringify(checkoutPayload)
    });

    const data = await response.json();
    console.log('[CHECKOUT] LS API Response status:', response.status);
    console.log('[CHECKOUT] LS API Response received, checkout URL:', data?.data?.attributes?.url ? 'present' : 'missing');

    if (!response.ok) {
      console.error('[CHECKOUT] Lemon Squeezy checkout error:', data);
      return res.status(500).json({ error: 'Failed to create checkout session', details: data });
    }

    const checkoutUrl = data.data.attributes.url;
    console.log('[CHECKOUT] Success! Checkout URL:', checkoutUrl);

    res.json({
      checkoutUrl: checkoutUrl,
      expiresAt: data.data.attributes.expires_at
    });

  } catch (error) {
    console.error('[CHECKOUT] Checkout creation error:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Get customer portal URL
router.get('/portal', async (req, res) => {
  console.log('[PORTAL] GET /portal - User:', req.user?.id);
  try {
    const subscription = await getSubscription(req.user.id);
    console.log('[PORTAL] Subscription found:', !!subscription?.lsSubscriptionId);
    console.log('[PORTAL] lsSubscriptionId value:', subscription?.lsSubscriptionId);
    console.log('[PORTAL] Subscription tier:', subscription?.tier);

    if (!subscription?.lsSubscriptionId) {
      console.log('[PORTAL] No lsSubscriptionId found');
      return res.status(404).json({ error: 'No active subscription found' });
    }

    // Fetch fresh subscription data from Lemon Squeezy (portal URL is valid for 24h)
    const lsUrl = `https://api.lemonsqueezy.com/v1/subscriptions/${subscription.lsSubscriptionId}`;
    console.log('[PORTAL] Fetching from LS API:', lsUrl);

    const response = await fetch(lsUrl, {
        headers: {
          'Accept': 'application/vnd.api+json',
          'Authorization': `Bearer ${process.env.LEMON_SQUEEZY_API_KEY}`
        }
      }
    );

    console.log('[PORTAL] LS API Response status:', response.status);

    if (!response.ok) {
      const errorData = await response.json();
      console.error('[PORTAL] LS API Error:', JSON.stringify(errorData));
      console.error('[PORTAL] This may indicate the subscription ID does not exist in Lemon Squeezy');
      return res.status(500).json({ error: 'Failed to fetch portal URL', details: errorData });
    }

    const data = await response.json();
    const portalUrl = data.data.attributes.urls?.customer_portal;

    if (!portalUrl) {
      return res.status(404).json({ error: 'Customer portal not available' });
    }

    res.json({ portalUrl });
  } catch (error) {
    console.error('Portal URL error:', error);
    res.status(500).json({ error: 'Failed to get portal URL' });
  }
});

// Cancel subscription (via Lemon Squeezy API)
router.post('/cancel', async (req, res) => {
  console.log('[CANCEL] POST /cancel - User:', req.user?.id);
  try {
    const subscription = await getSubscription(req.user.id);
    console.log('[CANCEL] Subscription found:', !!subscription?.lsSubscriptionId);
    console.log('[CANCEL] lsSubscriptionId value:', subscription?.lsSubscriptionId);
    console.log('[CANCEL] Subscription tier:', subscription?.tier);

    if (!subscription || !subscription.lsSubscriptionId) {
      console.log('[CANCEL] No subscription found');
      return res.status(404).json({ error: 'No active subscription found' });
    }

    // Cancel subscription via Lemon Squeezy API
    const lsUrl = `https://api.lemonsqueezy.com/v1/subscriptions/${subscription.lsSubscriptionId}`;
    console.log('[CANCEL] Sending PATCH to LS API:', lsUrl);

    const response = await fetch(lsUrl, {
        method: 'PATCH',
        headers: {
          'Accept': 'application/vnd.api+json',
          'Content-Type': 'application/vnd.api+json',
          'Authorization': `Bearer ${process.env.LEMON_SQUEEZY_API_KEY}`
        },
        body: JSON.stringify({
          data: {
            type: 'subscriptions',
            id: subscription.lsSubscriptionId,
            attributes: {
              cancelled: true
            }
          }
        })
      }
    );

    console.log('[CANCEL] LS API Response status:', response.status);

    if (!response.ok) {
      const errorData = await response.json();
      console.error('[CANCEL] LS API Error:', JSON.stringify(errorData));
      console.error('[CANCEL] This may indicate the subscription ID does not exist in Lemon Squeezy');
      return res.status(500).json({ error: 'Failed to cancel subscription', details: errorData });
    }

    const data = await response.json();

    // Update local record
    await updateUser(req.user.id, {
      'subscription.cancelAtPeriodEnd': true
    });

    res.json({
      message: 'Subscription will be cancelled at the end of the billing period',
      endsAt: data.data.attributes.ends_at
    });

  } catch (error) {
    console.error('Subscription cancellation error:', error);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// Change subscription plan (upgrade/downgrade)
router.post('/change-plan', changePlanValidation, async (req, res) => {
  console.log('[CHANGE-PLAN] POST /change-plan - User:', req.user?.id, 'New Tier:', req.body?.tier);
  try {
    const { tier: newTier } = req.body;

    if (!PRICING_TIERS[newTier]) {
      console.error('[CHANGE-PLAN] Invalid tier:', newTier);
      return res.status(400).json({ error: 'Invalid subscription tier' });
    }

    const subscription = await getSubscription(req.user.id);
    console.log('[CHANGE-PLAN] Current tier:', subscription?.tier || 'none');

    if (!subscription || !subscription.lsSubscriptionId) {
      console.log('[CHANGE-PLAN] No active subscription found');
      return res.status(404).json({ error: 'No active subscription found. Please subscribe first.' });
    }

    const currentTier = subscription.tier;
    if (currentTier === newTier) {
      return res.status(400).json({ error: 'You are already on this plan' });
    }

    const newTierConfig = PRICING_TIERS[newTier];
    const currentTierConfig = PRICING_TIERS[currentTier];
    const isUpgrade = newTierConfig.monthlyPrice > currentTierConfig.monthlyPrice;

    console.log(`[CHANGE-PLAN] ${isUpgrade ? 'Upgrade' : 'Downgrade'} from ${currentTier} to ${newTier}`);

    // Change subscription variant via Lemon Squeezy API
    // Using invoice_immediately: false ensures the change happens at the next billing cycle
    const response = await fetch(
      `https://api.lemonsqueezy.com/v1/subscriptions/${subscription.lsSubscriptionId}`,
      {
        method: 'PATCH',
        headers: {
          'Accept': 'application/vnd.api+json',
          'Content-Type': 'application/vnd.api+json',
          'Authorization': `Bearer ${process.env.LEMON_SQUEEZY_API_KEY}`
        },
        body: JSON.stringify({
          data: {
            type: 'subscriptions',
            id: subscription.lsSubscriptionId,
            attributes: {
              variant_id: parseInt(newTierConfig.variantId),
              // For downgrades: apply at end of billing period
              // For upgrades: you may want to apply immediately with proration
              // Setting invoice_immediately to false means change takes effect at renewal
              invoice_immediately: false
            }
          }
        })
      }
    );

    const data = await response.json();
    console.log('[CHANGE-PLAN] LS API Response status:', response.status);

    if (!response.ok) {
      console.error('[CHANGE-PLAN] Lemon Squeezy error:', data);
      return res.status(500).json({ error: 'Failed to change subscription plan' });
    }

    const renewsAt = data.data.attributes.renews_at;
    const renewsAtDate = new Date(renewsAt).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    // Update local record with pending change info
    await updateUser(req.user.id, {
      'subscription.pendingTier': newTier,
      'subscription.pendingChangeAt': renewsAt
    });

    const message = isUpgrade
      ? `Your plan will be upgraded to ${newTierConfig.name} on ${renewsAtDate}. You'll continue with your current plan until then.`
      : `Your plan will be changed to ${newTierConfig.name} on ${renewsAtDate}. You'll retain access to your current features until then.`;

    res.json({
      success: true,
      message,
      currentTier,
      newTier,
      effectiveDate: renewsAt,
      isUpgrade
    });

  } catch (error) {
    console.error('[CHANGE-PLAN] Error:', error);
    res.status(500).json({ error: 'Failed to change subscription plan' });
  }
});

// Resume cancelled subscription
router.post('/resume', async (req, res) => {
  try {
    const subscription = await getSubscription(req.user.id);

    if (!subscription || !subscription.lsSubscriptionId) {
      return res.status(404).json({ error: 'No subscription found' });
    }

    // Resume subscription via Lemon Squeezy API
    const response = await fetch(
      `https://api.lemonsqueezy.com/v1/subscriptions/${subscription.lsSubscriptionId}`,
      {
        method: 'PATCH',
        headers: {
          'Accept': 'application/vnd.api+json',
          'Content-Type': 'application/vnd.api+json',
          'Authorization': `Bearer ${process.env.LEMON_SQUEEZY_API_KEY}`
        },
        body: JSON.stringify({
          data: {
            type: 'subscriptions',
            id: subscription.lsSubscriptionId,
            attributes: {
              cancelled: false
            }
          }
        })
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      console.error('Lemon Squeezy resume error:', errorData);
      return res.status(500).json({ error: 'Failed to resume subscription' });
    }

    // Update local record
    await updateUser(req.user.id, {
      'subscription.cancelAtPeriodEnd': false
    });

    res.json({
      message: 'Subscription resumed successfully'
    });

  } catch (error) {
    console.error('Subscription resume error:', error);
    res.status(500).json({ error: 'Failed to resume subscription' });
  }
});

// Downgrade to free tier (cancel subscription and switch to free immediately)
router.post('/downgrade-to-free', async (req, res) => {
  console.log('[DOWNGRADE] POST /downgrade-to-free - User:', req.user?.id);
  try {
    const subscription = await getSubscription(req.user.id);
    console.log('[DOWNGRADE] Current tier:', subscription?.tier || 'none');

    // Check if user is already on free tier
    if (!subscription || subscription.tier === 'free') {
      return res.status(400).json({ error: 'You are already on the Free plan' });
    }

    // If user has an active Lemon Squeezy subscription, cancel it first
    if (subscription.lsSubscriptionId) {
      console.log('[DOWNGRADE] Cancelling Lemon Squeezy subscription:', subscription.lsSubscriptionId);

      try {
        const response = await fetch(
          `https://api.lemonsqueezy.com/v1/subscriptions/${subscription.lsSubscriptionId}`,
          {
            method: 'DELETE',
            headers: {
              'Accept': 'application/vnd.api+json',
              'Authorization': `Bearer ${process.env.LEMON_SQUEEZY_API_KEY}`
            }
          }
        );

        if (!response.ok) {
          const errorData = await response.json();
          console.error('[DOWNGRADE] Lemon Squeezy cancel error:', errorData);
          // Continue anyway - we'll still downgrade locally
        } else {
          console.log('[DOWNGRADE] Lemon Squeezy subscription cancelled successfully');
        }
      } catch (lsError) {
        console.error('[DOWNGRADE] Error cancelling Lemon Squeezy subscription:', lsError);
        // Continue anyway - we'll still downgrade locally
      }
    }

    // Calculate weekly reset date for free tier
    const now = new Date();
    const resetDate = new Date(now);
    resetDate.setDate(resetDate.getDate() + 7);
    resetDate.setHours(0, 0, 0, 0);

    // Update user to free tier immediately
    await updateUser(req.user.id, {
      subscription: {
        tier: 'free',
        status: 'active',
        postsRemaining: 1,
        dailyLimit: 1,
        resetDate: resetDate,
        cancelAtPeriodEnd: false,
        endsAt: null,
        pendingTier: null,
        pendingChangeAt: null
      },
      lsSubscriptionId: null
    });

    console.log(`[DOWNGRADE] User ${req.user.id} downgraded to free tier successfully`);

    res.json({
      success: true,
      message: 'Successfully downgraded to Free plan. You now have 1 post per week.',
      newTier: 'free'
    });

  } catch (error) {
    console.error('[DOWNGRADE] Error:', error);
    res.status(500).json({ error: 'Failed to downgrade subscription' });
  }
});

// ============================================
// PLAN INTEREST TRACKING (Beta Feature)
// ============================================

// Track user interest in unavailable plans (+1 button)
router.post('/plan-interest', async (req, res) => {
  console.log('[PLAN-INTEREST] POST /plan-interest - User:', req.user?.id, 'Plan:', req.body?.plan);
  try {
    const { plan } = req.body;

    // Validate plan name
    const validPlans = ['growth', 'professional', 'business'];
    if (!plan || !validPlans.includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan name' });
    }

    // Check if Supabase is configured
    if (!isSupabaseConfigured()) {
      console.warn('[PLAN-INTEREST] Supabase not configured, skipping tracking');
      return res.json({ success: true, message: 'Interest noted (tracking unavailable)' });
    }

    // Get user IP and user agent for analytics
    const ipAddress = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || null;
    const userAgent = req.headers['user-agent'] || null;

    // Insert into plan_interest table
    const { data, error } = await supabaseAdmin
      .from('plan_interest')
      .insert({
        plan_name: plan,
        user_id: req.user?.id || null,
        ip_address: ipAddress,
        user_agent: userAgent
      });

    if (error) {
      console.error('[PLAN-INTEREST] Supabase insert error:', error);
      // Don't fail the request, just log the error
      return res.json({ success: true, message: 'Interest registered' });
    }

    console.log(`[PLAN-INTEREST] Interest recorded for plan: ${plan}, user: ${req.user?.id || 'anonymous'}`);
    res.json({ success: true, message: 'Thank you for your interest!' });

  } catch (error) {
    console.error('[PLAN-INTEREST] Error:', error);
    // Don't fail the request for tracking errors
    res.json({ success: true, message: 'Interest noted' });
  }
});

// Get plan interest summary (admin only - could be protected later)
router.get('/plan-interest/summary', async (req, res) => {
  try {
    if (!isSupabaseConfigured()) {
      return res.status(503).json({ error: 'Tracking unavailable' });
    }

    const { data, error } = await supabaseAdmin
      .from('plan_interest_summary')
      .select('*');

    if (error) {
      console.error('[PLAN-INTEREST] Summary fetch error:', error);
      return res.status(500).json({ error: 'Failed to fetch summary' });
    }

    res.json({ success: true, summary: data });
  } catch (error) {
    console.error('[PLAN-INTEREST] Summary error:', error);
    res.status(500).json({ error: 'Failed to fetch interest summary' });
  }
});

// ============================================
// MARKETING ADD-ON
// ============================================

const MARKETING_ADDON_CONFIG = {
  standard: {
    name: 'Marketing Add-on',
    monthlyPrice: 29900, // $299 in cents
    variantId: process.env.LEMON_SQUEEZY_MARKETING_VARIANT_ID,
    maxAdAccounts: 1,
    features: [
      'Post boosting (Facebook & Instagram)',
      'Campaign management',
      'Audience library with reach estimator',
      'Auto-boost rules engine',
      'Performance dashboard & analytics'
    ]
  }
};

// Get marketing add-on status
router.get('/marketing-addon', async (req, res) => {
  try {
    const addon = await getMarketingAddon(req.user.id);
    res.json({
      addon: addon || null,
      config: MARKETING_ADDON_CONFIG,
      isActive: addon?.status === 'active'
    });
  } catch (error) {
    console.error('[MARKETING-ADDON] Error fetching addon:', error);
    res.status(500).json({ error: 'Failed to fetch marketing add-on status' });
  }
});

// Create marketing add-on checkout
router.post('/marketing-checkout', async (req, res) => {
  console.log('[MARKETING-CHECKOUT] POST /marketing-checkout - User:', req.user?.id);
  try {
    // Verify user has at least starter tier
    const tierHierarchy = { free: 0, starter: 1, growth: 2, professional: 3, business: 4 };
    const userTierLevel = tierHierarchy[req.user?.subscription?.tier] || 0;

    if (userTierLevel < 1) {
      return res.status(403).json({
        error: 'Marketing add-on requires a paid subscription (Starter or higher)'
      });
    }

    // Check if already has active addon
    const existingAddon = await getMarketingAddon(req.user.id);
    if (existingAddon?.status === 'active') {
      return res.status(400).json({ error: 'Marketing add-on is already active' });
    }

    const addonConfig = MARKETING_ADDON_CONFIG.standard;

    if (!addonConfig.variantId) {
      console.error('[MARKETING-CHECKOUT] Missing marketing variant ID');
      return res.status(500).json({ error: 'Marketing add-on configuration error' });
    }

    const checkoutPayload = {
      data: {
        type: 'checkouts',
        attributes: {
          checkout_data: {
            email: req.user.email,
            name: req.user.name || req.user.email.split('@')[0],
            custom: {
              user_id: req.user.id,
              addon_type: 'marketing'
            }
          },
          product_options: {
            name: addonConfig.name,
            description: addonConfig.features.join(', '),
            redirect_url: `${process.env.FRONTEND_URL}/profile.html?tab=marketing&payment=marketing_success`,
            receipt_thank_you_note: 'Thank you for activating Marketing! Your campaigns dashboard is now available.'
          },
          checkout_options: {
            embed: false,
            media: false,
            subscription_preview: true
          }
        },
        relationships: {
          store: {
            data: {
              type: 'stores',
              id: process.env.LEMON_SQUEEZY_STORE_ID
            }
          },
          variant: {
            data: {
              type: 'variants',
              id: addonConfig.variantId
            }
          }
        }
      }
    };

    const response = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
        'Authorization': `Bearer ${process.env.LEMON_SQUEEZY_API_KEY}`
      },
      body: JSON.stringify(checkoutPayload)
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('[MARKETING-CHECKOUT] Lemon Squeezy error:', data);
      return res.status(500).json({ error: 'Failed to create marketing checkout session' });
    }

    const checkoutUrl = data.data.attributes.url;
    console.log('[MARKETING-CHECKOUT] Success! Checkout URL created');

    res.json({
      checkoutUrl,
      expiresAt: data.data.attributes.expires_at
    });
  } catch (error) {
    console.error('[MARKETING-CHECKOUT] Error:', error);
    res.status(500).json({ error: 'Failed to create marketing checkout session' });
  }
});

// Cancel marketing add-on
router.post('/marketing-cancel', async (req, res) => {
  console.log('[MARKETING-CANCEL] POST /marketing-cancel - User:', req.user?.id);
  try {
    const addon = await getMarketingAddon(req.user.id);

    if (!addon || !addon.ls_subscription_id) {
      return res.status(404).json({ error: 'No active marketing add-on found' });
    }

    const response = await fetch(
      `https://api.lemonsqueezy.com/v1/subscriptions/${addon.ls_subscription_id}`,
      {
        method: 'PATCH',
        headers: {
          'Accept': 'application/vnd.api+json',
          'Content-Type': 'application/vnd.api+json',
          'Authorization': `Bearer ${process.env.LEMON_SQUEEZY_API_KEY}`
        },
        body: JSON.stringify({
          data: {
            type: 'subscriptions',
            id: addon.ls_subscription_id,
            attributes: { cancelled: true }
          }
        })
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      console.error('[MARKETING-CANCEL] LS API Error:', errorData);
      return res.status(500).json({ error: 'Failed to cancel marketing add-on' });
    }

    const data = await response.json();

    await updateMarketingAddon(req.user.id, {
      status: 'cancelled'
    });

    res.json({
      message: 'Marketing add-on will be cancelled at the end of the billing period',
      endsAt: data.data.attributes.ends_at
    });
  } catch (error) {
    console.error('[MARKETING-CANCEL] Error:', error);
    res.status(500).json({ error: 'Failed to cancel marketing add-on' });
  }
});

// ============================================
// WEBHOOK HANDLER
// ============================================

// Verify Lemon Squeezy webhook signature
function verifyWebhookSignature(payload, signature, secret) {
  const hmac = crypto.createHmac('sha256', secret);
  const digest = hmac.update(payload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
}

// Webhook endpoint for Lemon Squeezy events
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-signature'];

  if (!signature) {
    console.error('Missing webhook signature');
    return res.status(401).json({ error: 'Missing signature' });
  }

  // Verify signature
  const isValid = verifyWebhookSignature(
    req.body,
    signature,
    process.env.LEMON_SQUEEZY_WEBHOOK_SECRET
  );

  if (!isValid) {
    console.error('Invalid webhook signature');
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

  console.log(`Received Lemon Squeezy webhook: ${eventName}`);
  console.log('Custom data:', customData);

  try {
    // Route marketing add-on events vs main subscription events
    const isMarketingAddon = customData?.addon_type === 'marketing';

    if (isMarketingAddon && eventName === 'subscription_created') {
      await handleMarketingAddonCreated(payload, customData);
    } else if (!isMarketingAddon) {
      // Check if this is a marketing addon update (by checking existing record)
      const subscriptionId = payload.data?.id;
      const existingMarketingAddon = subscriptionId ? await getMarketingAddonByLsId(String(subscriptionId)) : null;

      if (existingMarketingAddon) {
        // This is a marketing addon event
        switch (eventName) {
          case 'subscription_updated':
          case 'subscription_payment_success':
            await handleMarketingAddonUpdated(payload, existingMarketingAddon);
            break;
          case 'subscription_cancelled':
            await handleMarketingAddonCancelled(existingMarketingAddon);
            break;
          case 'subscription_expired':
            await handleMarketingAddonExpired(existingMarketingAddon);
            break;
          case 'subscription_payment_failed':
            await updateMarketingAddon(existingMarketingAddon.user_id, { status: 'past_due' });
            console.log(`[WEBHOOK] Marketing addon payment failed for user ${existingMarketingAddon.user_id}`);
            break;
          default:
            console.log(`[WEBHOOK] Unhandled marketing addon event: ${eventName}`);
        }
      } else {
        // Standard subscription events
        switch (eventName) {
          case 'subscription_created':
            await handleSubscriptionCreated(payload, customData);
            break;

          case 'subscription_updated':
            await handleSubscriptionUpdated(payload);
            break;

          case 'subscription_cancelled':
            await handleSubscriptionCancelled(payload);
            break;

          case 'subscription_resumed':
            await handleSubscriptionResumed(payload);
            break;

          case 'subscription_expired':
            await handleSubscriptionExpired(payload);
            break;

          case 'subscription_payment_success':
            await handlePaymentSuccess(payload);
            break;

          case 'subscription_payment_failed':
            await handlePaymentFailed(payload);
            break;

          case 'order_created':
            console.log('Order created:', payload.data.id);
            break;

          default:
            console.log(`Unhandled webhook event: ${eventName}`);
        }
      }
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error(`Error handling webhook ${eventName}:`, error);
    // Return 200 to prevent retries for handled errors
    res.status(200).json({ received: true, error: error.message });
  }
});

// ============================================
// WEBHOOK EVENT HANDLERS
// ============================================

// Helper to determine tier from Lemon Squeezy variant ID
function getTierFromVariantId(variantId) {
  const variantIdStr = String(variantId);

  for (const [tierName, tierConfig] of Object.entries(PRICING_TIERS)) {
    if (tierConfig.variantId === variantIdStr) {
      return tierName;
    }
  }

  console.warn(`[WEBHOOK] Unknown variant ID: ${variantId}, defaulting to 'starter'`);
  return 'starter';
}

async function handleSubscriptionCreated(payload, customData) {
  const { user_id, tier: originalTier } = customData;
  const subscriptionData = payload.data.attributes;
  const subscriptionId = payload.data.id;

  if (!user_id) {
    console.error('[WEBHOOK] No user_id in custom_data for subscription_created');
    return;
  }

  // IMPORTANT: Determine actual tier from the variant_id in the payment, not from custom_data
  // This handles cases where the user changes their plan on the Lemon Squeezy checkout page
  const actualVariantId = subscriptionData.variant_id;
  const actualTier = getTierFromVariantId(actualVariantId);

  if (originalTier !== actualTier) {
    console.log(`[WEBHOOK] User changed plan during checkout: ${originalTier} -> ${actualTier}`);
  }

  console.log(`[WEBHOOK] Creating subscription for user ${user_id}, tier: ${actualTier} (variant: ${actualVariantId})`);

  // Create subscription record in database
  await createSubscription({
    userId: user_id,
    tier: actualTier,
    lsSubscriptionId: subscriptionId,
    lsCustomerId: String(subscriptionData.customer_id),
    lsVariantId: String(actualVariantId),
    lsOrderId: String(subscriptionData.order_id),
    status: 'active',
    currentPeriodStart: subscriptionData.created_at,
    currentPeriodEnd: subscriptionData.renews_at
  });

  // Update user profile with new subscription details
  await updateUser(user_id, {
    subscription: {
      tier: actualTier,
      status: 'active',
      postsRemaining: getTierPostLimit(actualTier),
      dailyLimit: getTierPostLimit(actualTier),
      cancelAtPeriodEnd: false
    },
    lsCustomerId: String(subscriptionData.customer_id),
    lsSubscriptionId: subscriptionId
  });

  console.log(`[WEBHOOK] Subscription created successfully for user ${user_id}, tier: ${actualTier}`);
}

async function handleSubscriptionUpdated(payload) {
  const subscriptionId = payload.data.id;
  const subscriptionData = payload.data.attributes;

  console.log(`Subscription updated: ${subscriptionId}`);

  // Find subscription by Lemon Squeezy ID
  const subscription = await getSubscriptionByLsId(subscriptionId);

  if (!subscription) {
    console.error(`Subscription not found for LS ID: ${subscriptionId}`);
    return;
  }

  // Determine new tier from variant ID
  const variantId = String(subscriptionData.variant_id);
  let newTier = subscription.tier;

  for (const [tierName, tierConfig] of Object.entries(PRICING_TIERS)) {
    if (tierConfig.variantId === variantId) {
      newTier = tierName;
      break;
    }
  }

  // Update user profile
  await updateUser(subscription.userId, {
    subscription: {
      tier: newTier,
      status: subscriptionData.status === 'active' ? 'active' : subscriptionData.status,
      postsRemaining: getTierPostLimit(newTier),
      dailyLimit: getTierPostLimit(newTier),
      cancelAtPeriodEnd: subscriptionData.cancelled || false
    }
  });

  console.log(`Subscription updated for user ${subscription.userId}, new tier: ${newTier}`);
}

async function handleSubscriptionCancelled(payload) {
  const subscriptionId = payload.data.id;
  const subscriptionData = payload.data.attributes;

  console.log(`Subscription cancelled: ${subscriptionId}`);

  const subscription = await getSubscriptionByLsId(subscriptionId);

  if (!subscription) {
    console.error(`Subscription not found for LS ID: ${subscriptionId}`);
    return;
  }

  // Mark as cancelled but keep access until period end
  await updateUser(subscription.userId, {
    subscription: {
      tier: subscription.tier,
      status: 'cancelled',
      cancelAtPeriodEnd: true,
      endsAt: subscriptionData.ends_at
    }
  });

  console.log(`Subscription cancelled for user ${subscription.userId}, ends at: ${subscriptionData.ends_at}`);
}

async function handleSubscriptionResumed(payload) {
  const subscriptionId = payload.data.id;

  console.log(`Subscription resumed: ${subscriptionId}`);

  const subscription = await getSubscriptionByLsId(subscriptionId);

  if (!subscription) {
    console.error(`Subscription not found for LS ID: ${subscriptionId}`);
    return;
  }

  await updateUser(subscription.userId, {
    subscription: {
      tier: subscription.tier,
      status: 'active',
      cancelAtPeriodEnd: false,
      endsAt: null
    }
  });

  console.log(`Subscription resumed for user ${subscription.userId}`);
}

async function handleSubscriptionExpired(payload) {
  const subscriptionId = payload.data.id;

  console.log(`Subscription expired: ${subscriptionId}`);

  const subscription = await getSubscriptionByLsId(subscriptionId);

  if (!subscription) {
    console.error(`Subscription not found for LS ID: ${subscriptionId}`);
    return;
  }

  // Downgrade to free tier (1 post per week)
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

  console.log(`Subscription expired, user ${subscription.userId} downgraded to free tier`);
}

async function handlePaymentSuccess(payload) {
  const subscriptionId = payload.data.attributes.subscription_id;

  console.log(`Payment successful for subscription: ${subscriptionId}`);

  const subscription = await getSubscriptionByLsId(String(subscriptionId));

  if (!subscription) {
    console.error(`Subscription not found for LS ID: ${subscriptionId}`);
    return;
  }

  // Reset daily limits on successful renewal
  await updateUser(subscription.userId, {
    subscription: {
      tier: subscription.tier,
      status: 'active',
      postsRemaining: getTierPostLimit(subscription.tier),
      dailyLimit: getTierPostLimit(subscription.tier)
    }
  });

  console.log(`Payment success - limits reset for user ${subscription.userId}`);
}

async function handlePaymentFailed(payload) {
  const subscriptionId = payload.data.attributes.subscription_id;

  console.log(`Payment failed for subscription: ${subscriptionId}`);

  const subscription = await getSubscriptionByLsId(String(subscriptionId));

  if (!subscription) {
    console.error(`Subscription not found for LS ID: ${subscriptionId}`);
    return;
  }

  // Mark subscription as past_due
  await updateUser(subscription.userId, {
    subscription: {
      tier: subscription.tier,
      status: 'past_due'
    }
  });

  console.log(`Payment failed - subscription marked as past_due for user ${subscription.userId}`);
}

// ============================================
// MARKETING ADD-ON WEBHOOK HANDLERS
// ============================================

async function handleMarketingAddonCreated(payload, customData) {
  const { user_id } = customData;
  const subscriptionData = payload.data.attributes;
  const subscriptionId = payload.data.id;

  if (!user_id) {
    console.error('[WEBHOOK] No user_id in custom_data for marketing addon creation');
    return;
  }

  console.log(`[WEBHOOK] Creating marketing addon for user ${user_id}`);

  await upsertMarketingAddon({
    userId: user_id,
    status: 'active',
    lsSubscriptionId: String(subscriptionId),
    lsVariantId: String(subscriptionData.variant_id),
    plan: 'standard',
    monthlyPrice: MARKETING_ADDON_CONFIG.standard.monthlyPrice,
    maxAdAccounts: MARKETING_ADDON_CONFIG.standard.maxAdAccounts,
    currentPeriodStart: subscriptionData.created_at,
    currentPeriodEnd: subscriptionData.renews_at
  });

  console.log(`[WEBHOOK] Marketing addon created successfully for user ${user_id}`);
}

async function handleMarketingAddonUpdated(payload, existingAddon) {
  const subscriptionData = payload.data.attributes;

  const status = subscriptionData.status === 'active' ? 'active' : subscriptionData.status;

  await updateMarketingAddon(existingAddon.user_id, {
    status,
    current_period_start: subscriptionData.created_at,
    current_period_end: subscriptionData.renews_at
  });

  console.log(`[WEBHOOK] Marketing addon updated for user ${existingAddon.user_id}, status: ${status}`);
}

async function handleMarketingAddonCancelled(existingAddon) {
  await updateMarketingAddon(existingAddon.user_id, {
    status: 'cancelled'
  });

  console.log(`[WEBHOOK] Marketing addon cancelled for user ${existingAddon.user_id}`);
}

async function handleMarketingAddonExpired(existingAddon) {
  await updateMarketingAddon(existingAddon.user_id, {
    status: 'expired'
  });

  console.log(`[WEBHOOK] Marketing addon expired for user ${existingAddon.user_id}`);
}

export default router;
