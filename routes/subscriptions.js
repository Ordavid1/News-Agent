// routes/subscriptions.js - Lemon Squeezy Integration
import express from 'express';
import crypto from 'crypto';
import { createSubscription, getSubscription, updateUser, getSubscriptionByLsId, updateSubscriptionRecord, getMarketingAddon, getMarketingAddonByLsId, upsertMarketingAddon, updateMarketingAddon, createPerUsePurchase, getLatestUnusedPurchase, getUserPerUsePurchases } from '../services/database-wrapper.js';
// SECURITY: Input validation
import { checkoutValidation, changePlanValidation } from '../utils/validators.js';
import { getVideoLimit } from '../middleware/subscription.js';
// Supabase for plan interest tracking
import { supabaseAdmin, isConfigured as isSupabaseConfigured } from '../services/supabase.js';

const router = express.Router();

// Pricing configuration with Lemon Squeezy variant IDs
// Note: Facebook is disabled (Coming Soon) - not included in platform counts
const PRICING_TIERS = {
  starter: {
    name: 'Starter Package',
    monthlyPrice: 2500, // $25 in cents
    postsPerDay: 6,
    videosPerMonth: 2,
    variantId: process.env.LEMON_SQUEEZY_49_VARIANT_ID,
    features: ['6 text posts/day (180/mo)', '2 video posts/month', 'All 9 platforms', 'Basic analytics', 'Email support']
  },
  growth: {
    name: 'Growth Package',
    monthlyPrice: 7500, // $75
    postsPerDay: 12,
    videosPerMonth: 10,
    variantId: process.env.LEMON_SQUEEZY_149_VARIANT_ID,
    features: ['12 text posts/day (360/mo)', '10 video posts/month', 'All 9 platforms', 'Advanced analytics', 'Post scheduling', 'Priority support']
  },
  business: {
    name: 'Business Package',
    monthlyPrice: 25000, // $250
    postsPerDay: 30,
    videosPerMonth: 50,
    variantId: process.env.LEMON_SQUEEZY_799_VARIANT_ID,
    features: ['30 text posts/day (900/mo)', '50 video posts/month', 'All 9 platforms', 'White-label options', 'Webhook integrations', 'Custom analytics', '24/7 phone support']
  }
};

// Helper to get post limit by tier
function getTierPostLimit(tier) {
  const limits = {
    free: 1,          // 1 post/week
    starter: 6,       // 6 posts/day
    growth: 12,       // 12 posts/day
    business: 30      // 30 posts/day
  };
  return limits[tier] || 1;
}

// ============================================
// LS SUBSCRIPTION VALIDATION & RECOVERY
// ============================================

/**
 * Validates the stored LS subscription ID and attempts recovery if stale.
 * Returns { valid: true, lsData } on success, or { stale: true } if unrecoverable.
 */
async function validateOrRecoverLsSubscription(subscription, userId) {
  const lsSubId = subscription.lsSubscriptionId;

  if (!lsSubId) {
    return { stale: true, reason: 'No Lemon Squeezy subscription ID stored' };
  }

  // Step 1: Validate the stored subscription ID
  try {
    const response = await fetch(`https://api.lemonsqueezy.com/v1/subscriptions/${lsSubId}`, {
      headers: {
        'Accept': 'application/vnd.api+json',
        'Authorization': `Bearer ${process.env.LEMON_SQUEEZY_API_KEY}`
      }
    });

    if (response.ok) {
      const data = await response.json();
      return { valid: true, lsData: data };
    }

    if (response.status !== 404) {
      console.error(`[LS-VALIDATE] Unexpected status ${response.status} for subscription ${lsSubId}`);
      return { error: true, reason: `Lemon Squeezy API error (${response.status})` };
    }
  } catch (err) {
    console.error('[LS-VALIDATE] Network error validating subscription:', err.message);
    return { error: true, reason: 'Failed to reach Lemon Squeezy API' };
  }

  // Step 2: Stored ID returned 404 — attempt recovery by customer ID
  console.log(`[LS-VALIDATE] Subscription ${lsSubId} not found in LS, attempting recovery...`);

  const lsCustomerId = subscription.lsCustomerId;
  if (lsCustomerId) {
    try {
      const searchUrl = `https://api.lemonsqueezy.com/v1/subscriptions?filter[store_id]=${process.env.LEMON_SQUEEZY_STORE_ID}&filter[customer_id]=${lsCustomerId}`;
      const searchResponse = await fetch(searchUrl, {
        headers: {
          'Accept': 'application/vnd.api+json',
          'Authorization': `Bearer ${process.env.LEMON_SQUEEZY_API_KEY}`
        }
      });

      if (searchResponse.ok) {
        const searchData = await searchResponse.json();
        const activeSubs = (searchData.data || []).filter(
          s => ['active', 'on_trial', 'paused', 'past_due', 'cancelled'].includes(s.attributes?.status)
        );

        if (activeSubs.length > 0) {
          const recovered = activeSubs[0];
          const recoveredId = recovered.id;
          console.log(`[LS-VALIDATE] Recovered subscription: ${recoveredId} (was: ${lsSubId})`);

          // Update stored IDs in both tables
          await updateSubscriptionRecord(lsSubId, { lsSubscriptionId: String(recoveredId) });
          await updateUser(userId, { lsSubscriptionId: String(recoveredId) });

          return { valid: true, lsData: { data: recovered }, recovered: true };
        }
      }
    } catch (err) {
      console.error('[LS-VALIDATE] Recovery search error:', err.message);
    }
  }

  // Step 3: Also try searching by store to find any subscription matching user email
  // (handles case where customer ID is also from test mode)
  try {
    const storeSearchUrl = `https://api.lemonsqueezy.com/v1/subscriptions?filter[store_id]=${process.env.LEMON_SQUEEZY_STORE_ID}&filter[user_email]=${encodeURIComponent(subscription.userEmail || '')}`;
    if (subscription.userEmail) {
      const storeResponse = await fetch(storeSearchUrl, {
        headers: {
          'Accept': 'application/vnd.api+json',
          'Authorization': `Bearer ${process.env.LEMON_SQUEEZY_API_KEY}`
        }
      });

      if (storeResponse.ok) {
        const storeData = await storeResponse.json();
        const activeSubs = (storeData.data || []).filter(
          s => ['active', 'on_trial', 'paused', 'past_due', 'cancelled'].includes(s.attributes?.status)
        );

        if (activeSubs.length > 0) {
          const recovered = activeSubs[0];
          const recoveredId = recovered.id;
          console.log(`[LS-VALIDATE] Recovered subscription by email: ${recoveredId} (was: ${lsSubId})`);

          // Update stored IDs in both tables
          const newCustomerId = String(recovered.attributes.customer_id);
          await updateSubscriptionRecord(lsSubId, { lsSubscriptionId: String(recoveredId) });
          await updateUser(userId, {
            lsSubscriptionId: String(recoveredId),
            lsCustomerId: newCustomerId
          });

          return { valid: true, lsData: { data: recovered }, recovered: true };
        }
      }
    }
  } catch (err) {
    console.error('[LS-VALIDATE] Email-based recovery error:', err.message);
  }

  // Step 4: No recovery possible — subscription is stale (e.g., test mode data)
  console.warn(`[LS-VALIDATE] Subscription ${lsSubId} is stale and unrecoverable`);

  // Clean up stale data
  await updateSubscriptionRecord(lsSubId, { status: 'expired' });
  await updateUser(userId, {
    subscription: {
      cancelAtPeriodEnd: false,
      endsAt: null,
      pendingTier: null,
      pendingChangeAt: null
    },
    lsSubscriptionId: null
  });

  return { stale: true, reason: 'Subscription record is outdated (possibly from test mode). Please re-subscribe to activate your plan.' };
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

    // Validate & recover the LS subscription ID if needed
    const validation = await validateOrRecoverLsSubscription(
      { ...subscription, userEmail: req.user.email },
      req.user.id
    );

    if (validation.stale) {
      return res.status(410).json({ error: validation.reason, stale: true });
    }

    if (validation.error) {
      return res.status(502).json({ error: validation.reason });
    }

    const portalUrl = validation.lsData.data.attributes.urls?.customer_portal;

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

    // Validate & recover the LS subscription ID if needed
    const validation = await validateOrRecoverLsSubscription(
      { ...subscription, userEmail: req.user.email },
      req.user.id
    );

    if (validation.stale) {
      return res.status(410).json({ error: validation.reason, stale: true });
    }

    if (validation.error) {
      return res.status(502).json({ error: validation.reason });
    }

    // Use the validated (possibly recovered) subscription ID
    const validSubId = validation.lsData.data.id;

    // Cancel subscription via Lemon Squeezy API
    const response = await fetch(
      `https://api.lemonsqueezy.com/v1/subscriptions/${validSubId}`,
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
            id: String(validSubId),
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
      return res.status(500).json({ error: 'Failed to cancel subscription' });
    }

    const data = await response.json();

    // Update both tables
    await updateSubscriptionRecord(String(validSubId), {
      status: 'cancelled',
      cancelAtPeriodEnd: true
    });

    await updateUser(req.user.id, {
      subscription: {
        cancelAtPeriodEnd: true,
        endsAt: data.data.attributes.ends_at
      }
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

    // Validate & recover the LS subscription ID if needed
    const validation = await validateOrRecoverLsSubscription(
      { ...subscription, userEmail: req.user.email },
      req.user.id
    );

    if (validation.stale) {
      return res.status(410).json({ error: validation.reason, stale: true });
    }

    if (validation.error) {
      return res.status(502).json({ error: validation.reason });
    }

    const validSubId = validation.lsData.data.id;

    const currentTier = subscription.tier;
    if (currentTier === newTier) {
      return res.status(400).json({ error: 'You are already on this plan' });
    }

    const newTierConfig = PRICING_TIERS[newTier];
    const currentTierConfig = PRICING_TIERS[currentTier];
    const isUpgrade = newTierConfig.monthlyPrice > currentTierConfig.monthlyPrice;

    console.log(`[CHANGE-PLAN] ${isUpgrade ? 'Upgrade' : 'Downgrade'} from ${currentTier} to ${newTier}`);

    // Change subscription variant via Lemon Squeezy API
    const response = await fetch(
      `https://api.lemonsqueezy.com/v1/subscriptions/${validSubId}`,
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
            id: String(validSubId),
            attributes: {
              variant_id: parseInt(newTierConfig.variantId),
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
      subscription: {
        pendingTier: newTier,
        pendingChangeAt: renewsAt
      }
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
  console.log('[RESUME] POST /resume - User:', req.user?.id);
  try {
    const subscription = await getSubscription(req.user.id);

    if (!subscription || !subscription.lsSubscriptionId) {
      return res.status(404).json({ error: 'No subscription found' });
    }

    // Validate & recover the LS subscription ID if needed
    const validation = await validateOrRecoverLsSubscription(
      { ...subscription, userEmail: req.user.email },
      req.user.id
    );

    if (validation.stale) {
      return res.status(410).json({ error: validation.reason, stale: true });
    }

    if (validation.error) {
      return res.status(502).json({ error: validation.reason });
    }

    // Use the validated (possibly recovered) subscription ID
    const validSubId = validation.lsData.data.id;

    // Resume subscription via Lemon Squeezy API
    const response = await fetch(
      `https://api.lemonsqueezy.com/v1/subscriptions/${validSubId}`,
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
            id: String(validSubId),
            attributes: {
              cancelled: false
            }
          }
        })
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      console.error('[RESUME] Lemon Squeezy resume error:', errorData);
      return res.status(500).json({ error: 'Failed to resume subscription' });
    }

    // Update both tables
    await updateSubscriptionRecord(String(validSubId), {
      status: 'active',
      cancelAtPeriodEnd: false
    });

    await updateUser(req.user.id, {
      subscription: {
        status: 'active',
        cancelAtPeriodEnd: false,
        endsAt: null
      }
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
        // Validate & find the correct LS subscription ID
        const validation = await validateOrRecoverLsSubscription(
          { ...subscription, userEmail: req.user.email },
          req.user.id
        );

        if (validation.valid) {
          const validSubId = validation.lsData.data.id;
          const response = await fetch(
            `https://api.lemonsqueezy.com/v1/subscriptions/${validSubId}`,
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
        } else {
          console.log('[DOWNGRADE] LS subscription is stale, skipping remote cancel');
        }
      } catch (lsError) {
        console.error('[DOWNGRADE] Error cancelling Lemon Squeezy subscription:', lsError);
        // Continue anyway - we'll still downgrade locally
      }
    }

    // Mark the subscription record as expired
    if (subscription.lsSubscriptionId) {
      await updateSubscriptionRecord(subscription.lsSubscriptionId, {
        status: 'expired',
        cancelAtPeriodEnd: false
      });
    }

    // Calculate weekly reset date for free tier
    const now = new Date();
    const resetDate = new Date(now);
    resetDate.setDate(resetDate.getDate() + 7);
    resetDate.setHours(0, 0, 0, 0);

    // Update user to free tier immediately (0 videos for free tier)
    await updateUser(req.user.id, {
      subscription: {
        tier: 'free',
        status: 'active',
        postsRemaining: 1,
        dailyLimit: 1,
        resetDate: resetDate,
        videosRemaining: 0,
        videoMonthlyLimit: 0,
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
    const validPlans = ['growth', 'business'];
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
    monthlyPrice: 3900, // $39 in cents
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
    const tierHierarchy = { free: 0, starter: 1, growth: 2, business: 3 };
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
// PER-USE PURCHASES (TRAINING)
// ============================================

const PER_USE_PRICING = {
  model_training: {
    amountCents: 500, // $5
    variantId: process.env.LEMON_SQUEEZY_TRAINING_VARIANT_ID,
    description: 'Brand Asset Model Training'
  },
  image_generation: {
    amountCents: 75, // $0.75
    variantId: process.env.LEMON_SQUEEZY_IMAGE_GEN_VARIANT_ID,
    description: 'Brand Image Generation'
  }
};

// Create training checkout (one-time LS purchase)
router.post('/training-checkout', async (req, res) => {
  console.log('[TRAINING-CHECKOUT] POST /training-checkout - User:', req.user?.id);
  try {
    // Verify user has marketing addon active
    const addon = await getMarketingAddon(req.user.id);
    if (!addon || addon.status !== 'active') {
      return res.status(403).json({ error: 'Active marketing add-on required for model training' });
    }

    const { adAccountId } = req.body;
    if (!adAccountId) {
      return res.status(400).json({ error: 'adAccountId is required' });
    }

    const pricing = PER_USE_PRICING.model_training;
    if (!pricing.variantId) {
      console.error('[TRAINING-CHECKOUT] Missing training variant ID');
      return res.status(500).json({ error: 'Training checkout configuration error' });
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
              purchase_type: 'model_training',
              ad_account_id: adAccountId
            }
          },
          product_options: {
            name: pricing.description,
            description: 'One-time purchase to train a LoRA model on your brand assets',
            redirect_url: `${process.env.FRONTEND_URL}/profile.html?tab=marketing&subtab=mediaassets&payment=training_success`,
            receipt_thank_you_note: 'Your brand asset model training will begin shortly.'
          },
          checkout_options: {
            embed: false,
            media: false
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
              id: pricing.variantId
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
      console.error('[TRAINING-CHECKOUT] Lemon Squeezy error:', data);
      return res.status(500).json({ error: 'Failed to create training checkout session' });
    }

    const checkoutUrl = data.data.attributes.url;
    console.log('[TRAINING-CHECKOUT] Success! Checkout URL created');

    res.json({
      checkoutUrl,
      expiresAt: data.data.attributes.expires_at
    });
  } catch (error) {
    console.error('[TRAINING-CHECKOUT] Error:', error);
    res.status(500).json({ error: 'Failed to create training checkout session' });
  }
});

// Check training purchase status (polled after redirect from LS checkout)
router.get('/training-purchase-status', async (req, res) => {
  try {
    const purchase = await getLatestUnusedPurchase(req.user.id, 'model_training');
    res.json({
      hasPurchase: !!purchase,
      purchase: purchase || null
    });
  } catch (error) {
    console.error('[TRAINING-PURCHASE] Error checking status:', error);
    res.status(500).json({ error: 'Failed to check training purchase status' });
  }
});

// Create image generation checkout (one-time LS purchase, overlay mode)
router.post('/image-gen-checkout', async (req, res) => {
  console.log('[IMAGE-GEN-CHECKOUT] POST /image-gen-checkout - User:', req.user?.id);
  try {
    // Verify user has marketing addon active
    const addon = await getMarketingAddon(req.user.id);
    if (!addon || addon.status !== 'active') {
      return res.status(403).json({ error: 'Active marketing add-on required for image generation' });
    }

    const pricing = PER_USE_PRICING.image_generation;
    if (!pricing.variantId) {
      console.error('[IMAGE-GEN-CHECKOUT] Missing image gen variant ID');
      return res.status(500).json({ error: 'Image generation checkout configuration error' });
    }

    // Build checkout_data with maximum pre-fill for fastest checkout
    const checkoutData = {
      email: req.user.email,
      name: req.user.name || req.user.email.split('@')[0],
      custom: {
        user_id: req.user.id,
        purchase_type: 'image_generation'
      }
    };

    // Pre-fill billing address from user's most recent LS order (has full billing info)
    const lsCustomerId = req.user.lsCustomerId;
    if (lsCustomerId) {
      try {
        const ordersResponse = await fetch(
          `https://api.lemonsqueezy.com/v1/orders?filter[user_email]=${encodeURIComponent(req.user.email)}&sort=-created_at&page[size]=1`,
          {
            headers: {
              'Accept': 'application/vnd.api+json',
              'Authorization': `Bearer ${process.env.LEMON_SQUEEZY_API_KEY}`
            }
          }
        );
        if (ordersResponse.ok) {
          const ordersData = await ordersResponse.json();
          const lastOrder = ordersData.data?.[0]?.attributes;
          if (lastOrder) {
            const billingAddress = {};
            if (lastOrder.user_name) checkoutData.name = lastOrder.user_name;
            // LS orders store: country, country_formatted, billing info in status_formatted
            // The checkout pre-fill uses country (2-letter ISO), state, zip
            if (lastOrder.country) billingAddress.country = lastOrder.country;
            if (lastOrder.region) billingAddress.state = lastOrder.region;
            if (lastOrder.zip) billingAddress.zip = lastOrder.zip;
            if (Object.keys(billingAddress).length > 0) {
              checkoutData.billing_address = billingAddress;
              console.log('[IMAGE-GEN-CHECKOUT] Pre-filled billing from last LS order:', Object.keys(billingAddress).join(', '));
            }
          }
        }
        // Fallback: if no order found, try customer record for country/region
        if (!checkoutData.billing_address) {
          const custResponse = await fetch(`https://api.lemonsqueezy.com/v1/customers/${lsCustomerId}`, {
            headers: {
              'Accept': 'application/vnd.api+json',
              'Authorization': `Bearer ${process.env.LEMON_SQUEEZY_API_KEY}`
            }
          });
          if (custResponse.ok) {
            const custData = await custResponse.json();
            const attrs = custData.data?.attributes;
            if (attrs) {
              const billingAddress = {};
              if (attrs.country) billingAddress.country = attrs.country;
              if (attrs.region) billingAddress.state = attrs.region;
              if (Object.keys(billingAddress).length > 0) {
                checkoutData.billing_address = billingAddress;
                console.log('[IMAGE-GEN-CHECKOUT] Pre-filled billing from LS customer:', Object.keys(billingAddress).join(', '));
              }
            }
          }
        }
      } catch (e) {
        console.warn('[IMAGE-GEN-CHECKOUT] Failed to fetch LS billing info:', e.message);
        // Non-fatal — checkout proceeds without pre-filled billing
      }
    }

    const checkoutPayload = {
      data: {
        type: 'checkouts',
        attributes: {
          checkout_data: checkoutData,
          product_options: {
            name: pricing.description,
            description: 'Generate a branded image for your post',
            enabled_variants: [parseInt(pricing.variantId)],
            receipt_thank_you_note: 'Your brand image will be generated shortly.'
          },
          checkout_options: {
            embed: true,
            media: false,
            logo: false,
            desc: false,
            discount: false,
            button_color: '#EAB308'
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
              id: pricing.variantId
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
      console.error('[IMAGE-GEN-CHECKOUT] Lemon Squeezy error:', data);
      return res.status(500).json({ error: 'Failed to create image generation checkout session' });
    }

    // Append pre-fill query params to the checkout URL (most reliable pre-fill method)
    const checkoutUrl = new URL(data.data.attributes.url);
    checkoutUrl.searchParams.set('checkout[email]', checkoutData.email);
    checkoutUrl.searchParams.set('checkout[name]', checkoutData.name);
    if (checkoutData.billing_address) {
      const ba = checkoutData.billing_address;
      if (ba.country) checkoutUrl.searchParams.set('checkout[billing_address][country]', ba.country);
      if (ba.state) checkoutUrl.searchParams.set('checkout[billing_address][state]', ba.state);
      if (ba.zip) checkoutUrl.searchParams.set('checkout[billing_address][zip]', ba.zip);
    }

    const finalUrl = checkoutUrl.toString();
    console.log('[IMAGE-GEN-CHECKOUT] Success! Checkout URL created with pre-fill params');

    res.json({
      checkoutUrl: finalUrl,
      expiresAt: data.data.attributes.expires_at
    });
  } catch (error) {
    console.error('[IMAGE-GEN-CHECKOUT] Error:', error);
    res.status(500).json({ error: 'Failed to create image generation checkout session' });
  }
});

// Check image generation purchase status (polled after overlay checkout)
router.get('/image-gen-purchase-status', async (req, res) => {
  try {
    const purchase = await getLatestUnusedPurchase(req.user.id, 'image_generation');
    res.json({
      hasPurchase: !!purchase,
      purchase: purchase || null
    });
  } catch (error) {
    console.error('[IMAGE-GEN-PURCHASE] Error checking status:', error);
    res.status(500).json({ error: 'Failed to check image generation purchase status' });
  }
});

// Get user's per-use purchase history
router.get('/per-use-purchases', async (req, res) => {
  try {
    const { type, status, limit, offset } = req.query;
    const purchases = await getUserPerUsePurchases(req.user.id, {
      purchaseType: type || undefined,
      status: status || undefined,
      limit: parseInt(limit) || 50,
      offset: parseInt(offset) || 0
    });
    res.json({ purchases });
  } catch (error) {
    console.error('[PER-USE-PURCHASES] Error:', error);
    res.status(500).json({ error: 'Failed to fetch purchase history' });
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
            await handleOrderCreated(payload, customData);
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

  // Update user profile with new subscription details (posts + video limits)
  const videoLimit = getVideoLimit(actualTier);
  const videoResetDate = new Date();
  videoResetDate.setMonth(videoResetDate.getMonth() + 1);
  videoResetDate.setHours(0, 0, 0, 0);

  await updateUser(user_id, {
    subscription: {
      tier: actualTier,
      status: 'active',
      postsRemaining: getTierPostLimit(actualTier),
      dailyLimit: getTierPostLimit(actualTier),
      videosRemaining: videoLimit,
      videoMonthlyLimit: videoLimit,
      videoResetDate: videoResetDate,
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

  const status = subscriptionData.status === 'active' ? 'active' : subscriptionData.status;
  const isCancelled = subscriptionData.cancelled || false;

  // Update subscriptions table
  await updateSubscriptionRecord(subscriptionId, {
    tier: newTier,
    status,
    cancelAtPeriodEnd: isCancelled,
    lsVariantId: variantId,
    currentPeriodEnd: subscriptionData.renews_at
  });

  // Update user profile (posts + video limits)
  const updatedVideoLimit = getVideoLimit(newTier);
  const updatedVideoResetDate = new Date();
  updatedVideoResetDate.setMonth(updatedVideoResetDate.getMonth() + 1);
  updatedVideoResetDate.setHours(0, 0, 0, 0);

  await updateUser(subscription.userId, {
    subscription: {
      tier: newTier,
      status,
      postsRemaining: getTierPostLimit(newTier),
      dailyLimit: getTierPostLimit(newTier),
      videosRemaining: updatedVideoLimit,
      videoMonthlyLimit: updatedVideoLimit,
      videoResetDate: updatedVideoResetDate,
      cancelAtPeriodEnd: isCancelled,
      endsAt: isCancelled ? subscriptionData.ends_at : null
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

  // Update subscriptions table
  await updateSubscriptionRecord(subscriptionId, {
    status: 'cancelled',
    cancelAtPeriodEnd: true
  });

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

  // Update subscriptions table
  await updateSubscriptionRecord(subscriptionId, {
    status: 'active',
    cancelAtPeriodEnd: false
  });

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

  // Update subscriptions table
  await updateSubscriptionRecord(subscriptionId, {
    status: 'expired',
    cancelAtPeriodEnd: false
  });

  // Downgrade to free tier (1 post per week, 0 videos)
  await updateUser(subscription.userId, {
    subscription: {
      tier: 'free',
      status: 'expired',
      postsRemaining: 1,
      dailyLimit: 1,
      videosRemaining: 0,
      videoMonthlyLimit: 0,
      cancelAtPeriodEnd: false,
      endsAt: null,
      pendingTier: null,
      pendingChangeAt: null
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

  // Update subscriptions table
  await updateSubscriptionRecord(String(subscriptionId), {
    status: 'active',
    cancelAtPeriodEnd: false
  });

  // Reset daily limits and video limits on successful renewal
  const renewalVideoLimit = getVideoLimit(subscription.tier);
  const renewalVideoResetDate = new Date();
  renewalVideoResetDate.setMonth(renewalVideoResetDate.getMonth() + 1);
  renewalVideoResetDate.setHours(0, 0, 0, 0);

  await updateUser(subscription.userId, {
    subscription: {
      tier: subscription.tier,
      status: 'active',
      postsRemaining: getTierPostLimit(subscription.tier),
      dailyLimit: getTierPostLimit(subscription.tier),
      videosRemaining: renewalVideoLimit,
      videoMonthlyLimit: renewalVideoLimit,
      videoResetDate: renewalVideoResetDate,
      cancelAtPeriodEnd: false,
      endsAt: null
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

  // Update subscriptions table
  await updateSubscriptionRecord(String(subscriptionId), {
    status: 'past_due'
  });

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

// ============================================
// ORDER HANDLER (Per-Use Purchases)
// ============================================

async function handleOrderCreated(payload, customData) {
  const { user_id, purchase_type, ad_account_id } = customData;
  const orderId = payload.data.id;
  const orderAttributes = payload.data.attributes;

  if (!purchase_type) {
    console.log(`[WEBHOOK] order_created without purchase_type — skipping (order ${orderId})`);
    return;
  }

  if (!user_id) {
    console.error(`[WEBHOOK] order_created with purchase_type=${purchase_type} but no user_id`);
    return;
  }

  console.log(`[WEBHOOK] Processing per-use purchase: type=${purchase_type}, user=${user_id}, order=${orderId}`);

  const pricing = PER_USE_PRICING[purchase_type];
  if (!pricing) {
    console.error(`[WEBHOOK] Unknown purchase_type: ${purchase_type}`);
    return;
  }

  try {
    await createPerUsePurchase(user_id, {
      purchaseType: purchase_type,
      amountCents: pricing.amountCents,
      currency: 'usd',
      status: 'completed',
      paymentProvider: 'lemon_squeezy',
      providerReferenceId: String(orderId),
      description: pricing.description,
      metadata: {
        ad_account_id: ad_account_id || null,
        ls_order_number: orderAttributes.order_number,
        ls_status: orderAttributes.status
      }
    });

    console.log(`[WEBHOOK] Per-use purchase recorded: ${purchase_type} for user ${user_id}`);
  } catch (error) {
    console.error(`[WEBHOOK] Failed to record per-use purchase:`, error);
  }
}

export default router;
