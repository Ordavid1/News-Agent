// routes/subscriptions.js - Lemon Squeezy Integration
import express from 'express';
import crypto from 'crypto';
import { createSubscription, getSubscription, updateUser, getSubscriptionByLsId, updateSubscriptionRecord, getMarketingAddon, getMarketingAddonByLsId, upsertMarketingAddon, updateMarketingAddon, getAffiliateAddon, getAffiliateAddonByLsId, upsertAffiliateAddon, updateAffiliateAddon, createPerUsePurchase, getLatestUnusedPurchase, getUserPerUsePurchases } from '../services/database-wrapper.js';
// SECURITY: Input validation
import { checkoutValidation, changePlanValidation } from '../utils/validators.js';
import { getVideoLimit } from '../middleware/subscription.js';
// Supabase for plan interest tracking
import { supabaseAdmin, isConfigured as isSupabaseConfigured } from '../services/supabase.js';

const router = express.Router();

// Cache for LS store slug (fetched once from API)
let _lsStoreSlug = null;

/**
 * Get the LS store slug for constructing product checkout URLs.
 * Fetches from the LS API and caches the result.
 */
async function getLsStoreSlug() {
  if (_lsStoreSlug) return _lsStoreSlug;

  const apiKey = process.env.LEMON_SQUEEZY_API_KEY;
  const storeId = process.env.LEMON_SQUEEZY_STORE_ID;
  if (!apiKey || !storeId) return null;

  try {
    const response = await fetch(`https://api.lemonsqueezy.com/v1/stores/${storeId}`, {
      headers: {
        'Accept': 'application/vnd.api+json',
        'Authorization': `Bearer ${apiKey}`
      }
    });
    if (response.ok) {
      const data = await response.json();
      _lsStoreSlug = data.data?.attributes?.slug;
      console.log('[LS-STORE] Fetched store slug:', _lsStoreSlug);
      return _lsStoreSlug;
    }
  } catch (e) {
    console.warn('[LS-STORE] Failed to fetch store slug:', e.message);
  }
  return null;
}

/**
 * Fetch billing address from LS for pre-filling checkout.
 * Tries the user's most recent LS order first (has full billing address),
 * then falls back to LS customer record (country + region only).
 *
 * @param {string} email - User's email for order lookup
 * @param {string|null} lsCustomerId - LS customer ID for fallback
 * @returns {{ country?: string, state?: string, zip?: string } | null}
 */
async function fetchLsBillingAddress(email, lsCustomerId) {
  const apiKey = process.env.LEMON_SQUEEZY_API_KEY;
  if (!apiKey) return null;

  const headers = {
    'Accept': 'application/vnd.api+json',
    'Authorization': `Bearer ${apiKey}`
  };

  try {
    // Try most recent order (has full billing info)
    if (email) {
      const ordersResponse = await fetch(
        `https://api.lemonsqueezy.com/v1/orders?filter[user_email]=${encodeURIComponent(email)}&sort=-created_at&page[size]=1`,
        { headers }
      );
      if (ordersResponse.ok) {
        const ordersData = await ordersResponse.json();
        const lastOrder = ordersData.data?.[0]?.attributes;
        if (lastOrder) {
          const addr = {};
          if (lastOrder.country) addr.country = lastOrder.country;
          if (lastOrder.region) addr.state = lastOrder.region;
          if (lastOrder.zip) addr.zip = lastOrder.zip;
          if (Object.keys(addr).length > 0) {
            console.log('[LS-PREFILL] Billing from recent order:', JSON.stringify(addr));
            return addr;
          }
        }
      }
    }

    // Fallback: customer record (country + region only)
    if (lsCustomerId) {
      const custResponse = await fetch(
        `https://api.lemonsqueezy.com/v1/customers/${lsCustomerId}`,
        { headers }
      );
      if (custResponse.ok) {
        const custData = await custResponse.json();
        const attrs = custData.data?.attributes;
        if (attrs) {
          const addr = {};
          if (attrs.country) addr.country = attrs.country;
          if (attrs.region) addr.state = attrs.region;
          if (Object.keys(addr).length > 0) {
            console.log('[LS-PREFILL] Billing from customer record:', JSON.stringify(addr));
            return addr;
          }
        }
      }
    }
  } catch (e) {
    console.warn('[LS-PREFILL] Failed to fetch billing info:', e.message);
  }
  console.log('[LS-PREFILL] No billing info found for', email ? `${email.substring(0, 3)}***` : 'unknown');
  return null;
}

/**
 * Build a pre-filled LS product checkout URL using query parameters.
 * This is the documented mechanism for pre-filling checkout fields:
 * https://docs.lemonsqueezy.com/help/checkout/prefilled-checkout-fields
 *
 * Uses product URLs (checkout/buy/{variant_id}) with checkout[] query params
 * instead of the API-created checkout approach, because checkout_data in the
 * Create Checkout API does NOT actually pre-fill the checkout form UI.
 *
 * @param {string} storeSlug - LS store slug (subdomain)
 * @param {string} variantId - LS variant ID
 * @param {object} user - req.user object from auth middleware
 * @param {object|null} billing - billing address from fetchLsBillingAddress
 * @param {object} customFields - custom data for webhooks (user_id, tier, etc.)
 * @param {object} [options] - Additional checkout options
 * @param {string} [options.redirectUrl] - Post-purchase redirect URL
 * @param {string} [options.discountCode] - Discount code to pre-fill
 * @param {string} logPrefix - log tag for diagnostics
 * @returns {string} Full pre-filled checkout URL
 */
function buildPrefilledCheckoutUrl(storeSlug, variantId, user, billing, customFields, options = {}, logPrefix = '[CHECKOUT]') {
  const baseUrl = `https://${storeSlug}.lemonsqueezy.com/checkout/buy/${variantId}`;
  const params = new URLSearchParams();

  // Pre-fill customer fields (visible in checkout form)
  const email = user.email;
  const name = user.name || (email ? email.split('@')[0] : null);

  if (email) params.append('checkout[email]', email);
  if (name) params.append('checkout[name]', name);

  // Pre-fill billing address
  if (billing) {
    if (billing.country) params.append('checkout[billing_address][country]', billing.country);
    if (billing.state) params.append('checkout[billing_address][state]', billing.state);
    if (billing.zip) params.append('checkout[billing_address][zip]', billing.zip);
  }

  // Custom data (hidden from customer, passed to webhooks)
  for (const [key, value] of Object.entries(customFields)) {
    if (value != null) {
      params.append(`checkout[custom][${key}]`, String(value));
    }
  }

  // Optional discount code
  if (options.discountCode) {
    params.append('checkout[discount_code]', options.discountCode);
  }

  const checkoutUrl = `${baseUrl}?${params.toString()}`;

  console.log(`${logPrefix} Pre-filled checkout URL built:`, JSON.stringify({
    email: email ? `${email.substring(0, 3)}***` : null,
    name: name || null,
    hasBilling: !!billing,
    customKeys: Object.keys(customFields),
    variantId
  }));

  return checkoutUrl;
}

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
    videosPerMonth: 30,
    variantId: process.env.LEMON_SQUEEZY_499_VARIANT_ID,
    features: ['30 text posts/day (900/mo)', '30 video posts/month', 'All 9 platforms', 'White-label options', 'Webhook integrations', 'Custom analytics', 'Direct support']
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
  const lsSubId = String(subscription.lsSubscriptionId || '');

  if (!lsSubId) {
    return { stale: true, reason: 'No Lemon Squeezy subscription ID stored' };
  }

  console.log(`[LS-VALIDATE] Validating subscription ID: ${lsSubId} for user: ${userId}`);

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
      let body = '';
      try { body = await response.text(); } catch (_) {}
      console.error(`[LS-VALIDATE] Unexpected status ${response.status} for subscription ${lsSubId}. Body: ${body}`);
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

  // Step 4: No recovery possible — report as stale but do NOT destroy data.
  // Callers decide how to handle stale results (some may proceed with local-only operations).
  console.warn(`[LS-VALIDATE] Subscription ${String(lsSubId)} not found in LS. ` +
    `Recovery by customer_id (${lsCustomerId || 'none'}) and email both failed. ` +
    `Reporting as stale but NOT cleaning up data.`);

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

    // Use LS Checkout API for reliable checkout URL generation
    const lsHeaders = {
      'Accept': 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
      'Authorization': `Bearer ${process.env.LEMON_SQUEEZY_API_KEY}`
    };

    const billing = await fetchLsBillingAddress(req.user.email, req.user.lsCustomerId);

    const checkoutData = {
      email: req.user.email,
      name: req.user.name || (req.user.email ? req.user.email.split('@')[0] : undefined),
      custom: {
        user_id: req.user.id,
        tier: tier
      }
    };

    if (billing) {
      checkoutData.billing_address = {};
      if (billing.country) checkoutData.billing_address.country = billing.country;
      if (billing.state) checkoutData.billing_address.state = billing.state;
      if (billing.zip) checkoutData.billing_address.zip = billing.zip;
    }

    const checkoutPayload = {
      data: {
        type: 'checkouts',
        attributes: {
          checkout_data: checkoutData,
          checkout_options: {
            embed: false,
            media: true,
            desc: false
          },
          product_options: {
            enabled_variants: [Number(tierConfig.variantId)],
            redirect_url: `${req.protocol}://${req.get('host')}/profile.html?tab=agents&section=subscription`
          }
        },
        relationships: {
          store: {
            data: {
              type: 'stores',
              id: String(process.env.LEMON_SQUEEZY_STORE_ID)
            }
          },
          variant: {
            data: {
              type: 'variants',
              id: String(tierConfig.variantId)
            }
          }
        }
      }
    };

    console.log(`[CHECKOUT] Creating LS checkout for user ${req.user.id}, tier: ${tier}`);

    const checkoutResponse = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
      method: 'POST',
      headers: lsHeaders,
      body: JSON.stringify(checkoutPayload)
    });

    if (!checkoutResponse.ok) {
      const errorData = await checkoutResponse.json();
      console.error('[CHECKOUT] LS Checkout API error:', JSON.stringify(errorData));
      return res.status(500).json({ error: 'Failed to create checkout session' });
    }

    const checkoutResult = await checkoutResponse.json();
    const checkoutUrl = checkoutResult.data?.attributes?.url;

    if (!checkoutUrl) {
      console.error('[CHECKOUT] No checkout URL in LS response');
      return res.status(500).json({ error: 'Failed to get checkout URL' });
    }

    console.log('[CHECKOUT] Checkout created for tier:', tier, '| URL:', checkoutUrl);

    res.json({ checkoutUrl });

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
    console.log('[PORTAL] lsCustomerId value:', subscription?.lsCustomerId);
    console.log('[PORTAL] Subscription tier:', subscription?.tier);
    console.log('[PORTAL] Subscription status:', subscription?.status);

    if (!subscription?.lsSubscriptionId) {
      console.log('[PORTAL] No lsSubscriptionId found');
      return res.status(404).json({ error: 'No active subscription found' });
    }

    const lsHeaders = {
      'Accept': 'application/vnd.api+json',
      'Authorization': `Bearer ${process.env.LEMON_SQUEEZY_API_KEY}`
    };

    // Validate & recover the LS subscription ID if needed
    const validation = await validateOrRecoverLsSubscription(
      { ...subscription, userEmail: req.user.email },
      req.user.id
    );

    let portalUrl = null;

    if (validation.valid) {
      portalUrl = validation.lsData.data.attributes.urls?.customer_portal;
      console.log('[PORTAL] Portal URL from subscription:', portalUrl ? 'found' : 'not available');
    } else {
      console.log('[PORTAL] Subscription validation failed:', validation.stale ? 'stale' : 'error', validation.reason);
    }

    // Fallback: fetch portal URL from the LS customer object directly
    // (works even when the subscription is cancelled/expired in LS)
    if (!portalUrl && subscription.lsCustomerId) {
      console.log('[PORTAL] Attempting fallback via customer API, customerId:', subscription.lsCustomerId);
      try {
        const customerResponse = await fetch(
          `https://api.lemonsqueezy.com/v1/customers/${subscription.lsCustomerId}`,
          { headers: lsHeaders }
        );
        if (customerResponse.ok) {
          const customerData = await customerResponse.json();
          portalUrl = customerData.data?.attributes?.urls?.customer_portal;
          console.log('[PORTAL] Portal URL from customer:', portalUrl ? 'found' : 'not available');
        } else {
          console.warn('[PORTAL] Customer API failed:', customerResponse.status);
        }
      } catch (custErr) {
        console.error('[PORTAL] Customer API error:', custErr.message);
      }
    }

    if (!portalUrl) {
      const errorMsg = validation.stale
        ? 'Your subscription data is out of sync. Please contact support.'
        : 'Customer portal not available';
      return res.status(validation.stale ? 410 : 404).json({
        error: errorMsg,
        stale: validation.stale || false
      });
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

    if (validation.error) {
      return res.status(502).json({ error: validation.reason });
    }

    // Calculate weekly reset date for free tier
    const now = new Date();
    const resetDate = new Date(now);
    resetDate.setDate(resetDate.getDate() + 7);
    resetDate.setHours(0, 0, 0, 0);

    if (validation.stale) {
      // LS subscription is stale — skip remote cancel, just downgrade locally
      console.warn('[CANCEL] LS subscription is stale, performing local-only downgrade to free');

      if (subscription.lsSubscriptionId) {
        await updateSubscriptionRecord(subscription.lsSubscriptionId, {
          status: 'expired',
          cancelAtPeriodEnd: false
        });
      }

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

      return res.json({
        message: 'Your subscription has been cancelled and you are now on the Free plan.'
      });
    }

    // Use the validated (possibly recovered) subscription ID
    const validSubId = validation.lsData.data.id;

    // Cancel subscription at period end via Lemon Squeezy API
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
    const endsAt = data.data.attributes.ends_at;

    // LS subscription is marked cancelled at period end.
    // Locally, downgrade user to free immediately so the UI reflects the change.
    await updateSubscriptionRecord(String(validSubId), {
      status: 'cancelled',
      cancelAtPeriodEnd: true
    });

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

    console.log(`[CANCEL] User ${req.user.id} cancelled at period end (${endsAt}), locally downgraded to free`);

    res.json({
      message: 'Your subscription has been cancelled and you are now on the Free plan.'
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

// Downgrade to free tier (cancel subscription immediately + pro-rata refund)
router.post('/downgrade-to-free', async (req, res) => {
  console.log('[DOWNGRADE] POST /downgrade-to-free - User:', req.user?.id);
  try {
    const subscription = await getSubscription(req.user.id);
    console.log('[DOWNGRADE] Current tier:', subscription?.tier || 'none');

    // Check if user is already on free tier
    if (!subscription || subscription.tier === 'free') {
      return res.status(400).json({ error: 'You are already on the Free plan' });
    }

    const lsHeaders = {
      'Accept': 'application/vnd.api+json',
      'Authorization': `Bearer ${process.env.LEMON_SQUEEZY_API_KEY}`
    };

    let refundedAmount = 0;

    // If user has an active Lemon Squeezy subscription, cancel it with pro-rata refund
    if (subscription.lsSubscriptionId) {
      console.log('[DOWNGRADE] Processing LS subscription:', subscription.lsSubscriptionId);

      // Mark the subscription record as expired BEFORE calling LS DELETE,
      // so that incoming webhooks (subscription_cancelled, subscription_updated, etc.)
      // triggered by the DELETE see the expired status and skip overwriting
      const expireResult = await updateSubscriptionRecord(subscription.lsSubscriptionId, {
        status: 'expired',
        cancelAtPeriodEnd: false
      });
      console.log('[DOWNGRADE] Subscription record marked as expired (pre-DELETE), result:', expireResult ? `status=${expireResult.status}` : 'NO RECORD UPDATED');

      try {
        // Validate & find the correct LS subscription ID
        const validation = await validateOrRecoverLsSubscription(
          { ...subscription, userEmail: req.user.email },
          req.user.id
        );

        if (validation.valid) {
          const validSubId = validation.lsData.data.id;
          const lsAttrs = validation.lsData.data.attributes;
          const renewsAt = lsAttrs.renews_at;

          // --- Pro-rata refund calculation ---
          // Fetch invoices for this subscription (filter/sort in code to avoid LS API 400 errors)
          try {
            const invoiceUrl = `https://api.lemonsqueezy.com/v1/subscription-invoices?filter[subscription_id]=${validSubId}`;
            const invoiceResponse = await fetch(invoiceUrl, { headers: lsHeaders });

            if (invoiceResponse.ok) {
              const invoiceData = await invoiceResponse.json();
              // Find the latest paid invoice (sort by created_at descending, filter status=paid)
              const paidInvoices = (invoiceData.data || [])
                .filter(inv => inv.attributes?.status === 'paid')
                .sort((a, b) => new Date(b.attributes.created_at) - new Date(a.attributes.created_at));
              const latestInvoice = paidInvoices[0];

              if (latestInvoice && renewsAt) {
                const invoiceId = latestInvoice.id;
                const invoiceCreatedAt = new Date(latestInvoice.attributes.created_at);
                const periodEnd = new Date(renewsAt);
                const now = new Date();

                const totalDays = Math.max(1, (periodEnd - invoiceCreatedAt) / (1000 * 60 * 60 * 24));
                const usedDays = Math.max(0, (now - invoiceCreatedAt) / (1000 * 60 * 60 * 24));
                const remainingDays = Math.max(0, totalDays - usedDays);
                const invoiceTotal = latestInvoice.attributes.total; // in cents
                refundedAmount = Math.round((remainingDays / totalDays) * invoiceTotal);

                console.log(`[DOWNGRADE] Refund calculation: total=${totalDays.toFixed(1)}d, used=${usedDays.toFixed(1)}d, remaining=${remainingDays.toFixed(1)}d, invoiceTotal=${invoiceTotal}, refundAmount=${refundedAmount}`);

                if (refundedAmount > 0) {
                  // Issue partial refund via LS Subscription Invoices API
                  const refundResponse = await fetch(
                    `https://api.lemonsqueezy.com/v1/subscription-invoices/${invoiceId}/refund`,
                    {
                      method: 'POST',
                      headers: {
                        ...lsHeaders,
                        'Content-Type': 'application/vnd.api+json'
                      },
                      body: JSON.stringify({ data: { type: 'subscription-invoices', id: String(invoiceId), attributes: { amount: refundedAmount } } })
                    }
                  );

                  if (refundResponse.ok) {
                    console.log(`[DOWNGRADE] Pro-rata refund of ${refundedAmount} cents issued for invoice ${invoiceId}`);
                  } else {
                    const refundError = await refundResponse.text();
                    console.error(`[DOWNGRADE] Refund failed (status ${refundResponse.status}):`, refundError);
                    // Continue with cancellation even if refund fails — log for manual resolution
                    refundedAmount = 0;
                  }
                } else {
                  console.log('[DOWNGRADE] No refund needed (remaining days <= 0)');
                }
              } else {
                console.log('[DOWNGRADE] No paid invoice found or no renewsAt — skipping refund');
              }
            } else {
              console.warn('[DOWNGRADE] Failed to fetch invoices:', invoiceResponse.status);
            }
          } catch (refundErr) {
            console.error('[DOWNGRADE] Error during refund calculation:', refundErr.message);
            // Continue with cancellation even if refund fails
          }

          // Cancel (DELETE) the subscription immediately
          const cancelResponse = await fetch(
            `https://api.lemonsqueezy.com/v1/subscriptions/${validSubId}`,
            {
              method: 'DELETE',
              headers: lsHeaders
            }
          );

          if (!cancelResponse.ok) {
            const errorData = await cancelResponse.text();
            console.error('[DOWNGRADE] LS DELETE error:', errorData);
            // Continue anyway — we'll still downgrade locally
          } else {
            console.log('[DOWNGRADE] LS subscription cancelled (DELETE) successfully');
          }
        } else {
          console.log('[DOWNGRADE] LS subscription is stale, skipping remote cancel & refund');
        }
      } catch (lsError) {
        console.error('[DOWNGRADE] Error processing LS subscription:', lsError);
        // Continue anyway — we'll still downgrade locally
      }
    }

    // If there was no LS subscription, still mark expired in the subscriptions table
    // (LS subscriptions were already marked expired before the DELETE call above)

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

    const refundMsg = refundedAmount > 0
      ? ` A refund of $${(refundedAmount / 100).toFixed(2)} has been issued.`
      : '';
    console.log(`[DOWNGRADE] User ${req.user.id} downgraded to free tier successfully.${refundMsg}`);

    res.json({
      success: true,
      message: `Successfully downgraded to Free plan.${refundMsg}`,
      newTier: 'free',
      refundedAmount: refundedAmount || undefined
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
    monthlyPrice: 1900, // $19 per ad account in cents
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
      isActive: addon?.status === 'active',
      pricePerAccount: MARKETING_ADDON_CONFIG.standard.monthlyPrice / 100
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

    // Use LS Checkout API for reliable checkout URL generation
    const lsHeaders = {
      'Accept': 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
      'Authorization': `Bearer ${process.env.LEMON_SQUEEZY_API_KEY}`
    };

    const billing = await fetchLsBillingAddress(req.user.email, req.user.lsCustomerId);

    const checkoutData = {
      email: req.user.email,
      name: req.user.name || (req.user.email ? req.user.email.split('@')[0] : undefined),
      custom: {
        user_id: req.user.id,
        addon_type: 'marketing'
      }
    };

    if (billing) {
      checkoutData.billing_address = {};
      if (billing.country) checkoutData.billing_address.country = billing.country;
      if (billing.state) checkoutData.billing_address.state = billing.state;
      if (billing.zip) checkoutData.billing_address.zip = billing.zip;
    }

    const checkoutPayload = {
      data: {
        type: 'checkouts',
        attributes: {
          checkout_data: checkoutData,
          checkout_options: {
            embed: false,
            media: true,
            desc: false
          },
          product_options: {
            enabled_variants: [Number(addonConfig.variantId)],
            redirect_url: `${req.protocol}://${req.get('host')}/profile.html?tab=marketing`
          }
        },
        relationships: {
          store: {
            data: {
              type: 'stores',
              id: String(process.env.LEMON_SQUEEZY_STORE_ID)
            }
          },
          variant: {
            data: {
              type: 'variants',
              id: String(addonConfig.variantId)
            }
          }
        }
      }
    };

    console.log(`[MARKETING-CHECKOUT] Creating LS checkout for user ${req.user.id}`);

    const checkoutResponse = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
      method: 'POST',
      headers: lsHeaders,
      body: JSON.stringify(checkoutPayload)
    });

    if (!checkoutResponse.ok) {
      const errorData = await checkoutResponse.json();
      console.error('[MARKETING-CHECKOUT] LS Checkout API error:', JSON.stringify(errorData));
      return res.status(500).json({ error: 'Failed to create checkout session' });
    }

    const checkoutResult = await checkoutResponse.json();
    const checkoutUrl = checkoutResult.data?.attributes?.url;

    if (!checkoutUrl) {
      console.error('[MARKETING-CHECKOUT] No checkout URL in LS response');
      return res.status(500).json({ error: 'Failed to get checkout URL' });
    }

    console.log(`[MARKETING-CHECKOUT] Checkout created for user ${req.user.id}: ${checkoutUrl.substring(0, 60)}...`);

    res.json({ checkoutUrl });
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

// Get customer billing portal URL for an add-on subscription
// Tries the add-on's own LS subscription first, falls back to main subscription portal
async function getAddonPortalUrl(lsSubscriptionId, userId) {
  const lsHeaders = {
    'Accept': 'application/vnd.api+json',
    'Authorization': `Bearer ${process.env.LEMON_SQUEEZY_API_KEY}`
  };

  // Try the add-on's subscription first
  if (lsSubscriptionId) {
    try {
      console.log(`[ADDON-PORTAL] Fetching portal URL for addon subscription: ${lsSubscriptionId}`);
      const response = await fetch(
        `https://api.lemonsqueezy.com/v1/subscriptions/${lsSubscriptionId}`,
        { method: 'GET', headers: lsHeaders }
      );
      if (response.ok) {
        const data = await response.json();
        const portalUrl = data.data.attributes.urls?.customer_portal;
        if (portalUrl) return portalUrl;
        console.log(`[ADDON-PORTAL] Addon subscription ${lsSubscriptionId} has no customer_portal URL`);
      } else {
        console.log(`[ADDON-PORTAL] LS API returned ${response.status} for addon subscription ${lsSubscriptionId}`);
      }
    } catch (err) {
      console.error(`[ADDON-PORTAL] Error fetching addon subscription:`, err.message);
    }
  } else {
    console.log(`[ADDON-PORTAL] No addon ls_subscription_id for user ${userId}`);
  }

  // Fallback: use main subscription's portal (same customer, same billing portal)
  try {
    const subscription = await getSubscription(userId);
    if (subscription?.lsSubscriptionId) {
      console.log(`[ADDON-PORTAL] Trying main subscription: ${subscription.lsSubscriptionId}`);
      const response = await fetch(
        `https://api.lemonsqueezy.com/v1/subscriptions/${subscription.lsSubscriptionId}`,
        { method: 'GET', headers: lsHeaders }
      );
      if (response.ok) {
        const data = await response.json();
        const portalUrl = data.data.attributes.urls?.customer_portal;
        if (portalUrl) return portalUrl;
        console.log(`[ADDON-PORTAL] Main subscription has no customer_portal URL`);
      } else {
        console.log(`[ADDON-PORTAL] LS API returned ${response.status} for main subscription ${subscription.lsSubscriptionId}`);
      }
    } else {
      console.log(`[ADDON-PORTAL] No main subscription found for user ${userId}`);
    }
  } catch (err) {
    console.error(`[ADDON-PORTAL] Error fetching main subscription:`, err.message);
  }

  return null;
}

// Marketing add-on billing portal
router.get('/marketing-portal', async (req, res) => {
  try {
    const addon = await getMarketingAddon(req.user.id);
    const portalUrl = await getAddonPortalUrl(addon?.ls_subscription_id, req.user.id);

    if (!portalUrl) {
      return res.status(404).json({ error: 'Billing portal not available' });
    }

    res.json({ portalUrl });
  } catch (error) {
    console.error('[MARKETING-PORTAL] Error:', error);
    res.status(500).json({ error: 'Failed to get billing portal URL' });
  }
});

// Create checkout for adding an ad account seat (opens LS checkout UI with updated quantity)
router.post('/marketing-add-account-checkout', async (req, res) => {
  console.log('[MARKETING-ADD-ACCOUNT-CHECKOUT] POST /marketing-add-account-checkout - User:', req.user?.id);
  try {
    const addon = await getMarketingAddon(req.user.id);

    if (!addon || addon.status !== 'active') {
      return res.status(404).json({ error: 'No active marketing add-on found' });
    }

    if (!addon.ls_subscription_id) {
      return res.status(400).json({ error: 'Marketing add-on has no linked subscription' });
    }

    const addonConfig = MARKETING_ADDON_CONFIG.standard;

    if (!addonConfig.variantId) {
      console.error('[MARKETING-ADD-ACCOUNT-CHECKOUT] Missing marketing variant ID');
      return res.status(500).json({ error: 'Marketing add-on configuration error' });
    }

    const currentMaxAccounts = addon.max_ad_accounts || 1;
    const additionalAccounts = Math.max(1, Math.min(20, parseInt(req.body.additionalAccounts) || 1));
    const newQuantity = currentMaxAccounts + additionalAccounts;

    // Use LS Checkout API to create a checkout with quantity support
    const lsHeaders = {
      'Accept': 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
      'Authorization': `Bearer ${process.env.LEMON_SQUEEZY_API_KEY}`
    };

    // Fetch billing address for pre-fill
    const billing = await fetchLsBillingAddress(req.user.email, req.user.lsCustomerId);

    const checkoutData = {
      email: req.user.email,
      name: req.user.name || (req.user.email ? req.user.email.split('@')[0] : undefined),
      custom: {
        user_id: req.user.id,
        addon_type: 'marketing',
        replaces_ls_subscription_id: addon.ls_subscription_id
      },
      variant_quantities: [
        {
          variant_id: Number(addonConfig.variantId),
          quantity: newQuantity
        }
      ]
    };

    // Add billing address if available
    if (billing) {
      checkoutData.billing_address = {};
      if (billing.country) checkoutData.billing_address.country = billing.country;
      if (billing.state) checkoutData.billing_address.state = billing.state;
      if (billing.zip) checkoutData.billing_address.zip = billing.zip;
    }

    const checkoutPayload = {
      data: {
        type: 'checkouts',
        attributes: {
          checkout_data: checkoutData,
          checkout_options: {
            embed: false,
            media: true,
            desc: false
          },
          product_options: {
            enabled_variants: [Number(addonConfig.variantId)],
            redirect_url: `${req.protocol}://${req.get('host')}/profile.html?tab=marketing`
          }
        },
        relationships: {
          store: {
            data: {
              type: 'stores',
              id: String(process.env.LEMON_SQUEEZY_STORE_ID)
            }
          },
          variant: {
            data: {
              type: 'variants',
              id: String(addonConfig.variantId)
            }
          }
        }
      }
    };

    console.log(`[MARKETING-ADD-ACCOUNT-CHECKOUT] Creating LS checkout for user ${req.user.id}: quantity=${newQuantity}`);

    const checkoutResponse = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
      method: 'POST',
      headers: lsHeaders,
      body: JSON.stringify(checkoutPayload)
    });

    if (!checkoutResponse.ok) {
      const errorData = await checkoutResponse.json();
      console.error('[MARKETING-ADD-ACCOUNT-CHECKOUT] LS Checkout API error:', JSON.stringify(errorData));
      return res.status(500).json({ error: 'Failed to create checkout session' });
    }

    const checkoutResult = await checkoutResponse.json();
    const checkoutUrl = checkoutResult.data?.attributes?.url;

    if (!checkoutUrl) {
      console.error('[MARKETING-ADD-ACCOUNT-CHECKOUT] No checkout URL in LS response');
      return res.status(500).json({ error: 'Failed to get checkout URL' });
    }

    const pricePerAccount = addonConfig.monthlyPrice / 100;

    console.log(`[MARKETING-ADD-ACCOUNT-CHECKOUT] Checkout created for user ${req.user.id}: quantity=${newQuantity}, total=$${newQuantity * pricePerAccount}/mo, url=${checkoutUrl.substring(0, 60)}...`);

    res.json({
      checkoutUrl,
      currentAccounts: currentMaxAccounts,
      newQuantity,
      pricePerAccount,
      newMonthlyTotal: newQuantity * pricePerAccount
    });
  } catch (error) {
    console.error('[MARKETING-ADD-ACCOUNT-CHECKOUT] Error:', error);
    res.status(500).json({ error: 'Failed to create add-account checkout session' });
  }
});

// ============================================
// AE AFFILIATE ADD-ON
// ============================================

const AFFILIATE_ADDON_CONFIG = {
  standard: {
    name: 'AE Affiliate Add-on',
    monthlyPrice: 900, // $9/month in cents
    variantId: process.env.LEMON_SQUEEZY_AFFILIATE_VARIANT_ID,
    maxKeywordSets: 5,
    maxProductsPerDay: 20,
    features: [
      'AliExpress product search by keywords',
      'Affiliate link generation with commission tracking',
      'Auto-post products to WhatsApp & Telegram',
      'Product deduplication (no repeat posts)',
      'Keyword-based automation scheduling'
    ]
  }
};

// Get affiliate add-on status
router.get('/affiliate-addon', async (req, res) => {
  try {
    let addon = null;
    try {
      addon = await getAffiliateAddon(req.user.id);
    } catch (dbErr) {
      // Table may not exist yet — fall through
      console.warn('[AFFILIATE-ADDON] DB lookup failed (table may not exist):', dbErr.message);
    }

    res.json({
      addon: addon || null,
      config: AFFILIATE_ADDON_CONFIG,
      isActive: addon?.status === 'active'
    });
  } catch (error) {
    console.error('[AFFILIATE-ADDON] Error fetching addon:', error);
    res.status(500).json({ error: 'Failed to fetch affiliate add-on status' });
  }
});

// DEPRECATED: Affiliate add-on checkout retired — features now included with all subscription plans.
// Existing subscribers are still serviced via webhook handlers and portal/cancel endpoints below.
router.post('/affiliate-checkout', async (req, res) => {
  return res.status(410).json({
    error: 'The AE Affiliate add-on has been retired. Affiliate features are now included with all subscription plans.'
  });
});

// Cancel affiliate add-on
// Affiliate add-on billing portal
router.get('/affiliate-portal', async (req, res) => {
  try {
    const addon = await getAffiliateAddon(req.user.id);
    const portalUrl = await getAddonPortalUrl(addon?.ls_subscription_id, req.user.id);

    if (!portalUrl) {
      return res.status(404).json({ error: 'Billing portal not available' });
    }

    res.json({ portalUrl });
  } catch (error) {
    console.error('[AFFILIATE-PORTAL] Error:', error);
    res.status(500).json({ error: 'Failed to get billing portal URL' });
  }
});

router.post('/affiliate-cancel', async (req, res) => {
  console.log('[AFFILIATE-CANCEL] POST /affiliate-cancel - User:', req.user?.id);
  try {
    const addon = await getAffiliateAddon(req.user.id);

    if (!addon || !addon.ls_subscription_id) {
      return res.status(404).json({ error: 'No active affiliate add-on found' });
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
      console.error('[AFFILIATE-CANCEL] LS API Error:', errorData);
      return res.status(500).json({ error: 'Failed to cancel affiliate add-on' });
    }

    const data = await response.json();

    await updateAffiliateAddon(req.user.id, {
      status: 'cancelled'
    });

    res.json({
      message: 'AE Affiliate add-on will be cancelled at the end of the billing period',
      endsAt: data.data.attributes.ends_at
    });
  } catch (error) {
    console.error('[AFFILIATE-CANCEL] Error:', error);
    res.status(500).json({ error: 'Failed to cancel affiliate add-on' });
  }
});

// ============================================
// PER-USE PURCHASES (TRAINING)
// ============================================

const PER_USE_PRICING = {
  model_training: {
    amountCents: 500, // $5
    variantId: process.env.LEMON_SQUEEZY_TRAINING_VARIANT_ID,
    description: 'Brand Asset Model Training',
    creditsPerPurchase: 1
  },
  image_generation: {
    amountCents: 75, // $0.75
    variantId: process.env.LEMON_SQUEEZY_IMAGE_GEN_VARIANT_ID,
    description: 'Brand Image Generation',
    creditsPerPurchase: 1
  },
  asset_image_gen_pack: {
    amountCents: 450, // $4.50
    variantId: process.env.LEMON_SQUEEZY_IMAGE_GEN_PACK_VARIANT_ID,
    description: 'Brand Asset Image Generation Pack (8 images)',
    creditsPerPurchase: 8
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

    const lsHeaders = {
      'Accept': 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
      'Authorization': `Bearer ${process.env.LEMON_SQUEEZY_API_KEY}`
    };

    const billing = await fetchLsBillingAddress(req.user.email, req.user.lsCustomerId);

    const checkoutData = {
      email: req.user.email,
      name: req.user.name || (req.user.email ? req.user.email.split('@')[0] : undefined),
      custom: { user_id: req.user.id, purchase_type: 'model_training', ad_account_id: adAccountId }
    };

    if (billing) {
      checkoutData.billing_address = {};
      if (billing.country) checkoutData.billing_address.country = billing.country;
      if (billing.state) checkoutData.billing_address.state = billing.state;
      if (billing.zip) checkoutData.billing_address.zip = billing.zip;
    }

    const checkoutResponse = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
      method: 'POST',
      headers: lsHeaders,
      body: JSON.stringify({
        data: {
          type: 'checkouts',
          attributes: {
            checkout_data: checkoutData,
            checkout_options: { embed: false, media: true, desc: false },
            product_options: {
              enabled_variants: [Number(pricing.variantId)],
              redirect_url: `${req.protocol}://${req.get('host')}/profile.html?tab=marketing`
            }
          },
          relationships: {
            store: { data: { type: 'stores', id: String(process.env.LEMON_SQUEEZY_STORE_ID) } },
            variant: { data: { type: 'variants', id: String(pricing.variantId) } }
          }
        }
      })
    });

    if (!checkoutResponse.ok) {
      const errorData = await checkoutResponse.json();
      console.error('[TRAINING-CHECKOUT] LS Checkout API error:', JSON.stringify(errorData));
      return res.status(500).json({ error: 'Failed to create checkout session' });
    }

    const checkoutResult = await checkoutResponse.json();
    const checkoutUrl = checkoutResult.data?.attributes?.url;

    if (!checkoutUrl) {
      console.error('[TRAINING-CHECKOUT] No checkout URL in LS response');
      return res.status(500).json({ error: 'Failed to get checkout URL' });
    }

    console.log(`[TRAINING-CHECKOUT] Checkout created for user ${req.user.id}`);
    res.json({ checkoutUrl });
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

    const lsHeaders = {
      'Accept': 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
      'Authorization': `Bearer ${process.env.LEMON_SQUEEZY_API_KEY}`
    };

    const billing = await fetchLsBillingAddress(req.user.email, req.user.lsCustomerId);

    const checkoutData = {
      email: req.user.email,
      name: req.user.name || (req.user.email ? req.user.email.split('@')[0] : undefined),
      custom: { user_id: req.user.id, purchase_type: 'image_generation' }
    };

    if (billing) {
      checkoutData.billing_address = {};
      if (billing.country) checkoutData.billing_address.country = billing.country;
      if (billing.state) checkoutData.billing_address.state = billing.state;
      if (billing.zip) checkoutData.billing_address.zip = billing.zip;
    }

    const checkoutResponse = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
      method: 'POST',
      headers: lsHeaders,
      body: JSON.stringify({
        data: {
          type: 'checkouts',
          attributes: {
            checkout_data: checkoutData,
            checkout_options: { embed: false, media: true, desc: false },
            product_options: {
              enabled_variants: [Number(pricing.variantId)],
              redirect_url: `${req.protocol}://${req.get('host')}/profile.html?tab=marketing`
            }
          },
          relationships: {
            store: { data: { type: 'stores', id: String(process.env.LEMON_SQUEEZY_STORE_ID) } },
            variant: { data: { type: 'variants', id: String(pricing.variantId) } }
          }
        }
      })
    });

    if (!checkoutResponse.ok) {
      const errorData = await checkoutResponse.json();
      console.error('[IMAGE-GEN-CHECKOUT] LS Checkout API error:', JSON.stringify(errorData));
      return res.status(500).json({ error: 'Failed to create checkout session' });
    }

    const checkoutResult = await checkoutResponse.json();
    const checkoutUrl = checkoutResult.data?.attributes?.url;

    if (!checkoutUrl) {
      console.error('[IMAGE-GEN-CHECKOUT] No checkout URL in LS response');
      return res.status(500).json({ error: 'Failed to get checkout URL' });
    }

    console.log(`[IMAGE-GEN-CHECKOUT] Checkout created for user ${req.user.id}`);
    res.json({ checkoutUrl });
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

// Create image generation pack checkout (6 credits for $4.50, LS one-time purchase)
router.post('/asset-image-gen-pack-checkout', async (req, res) => {
  console.log('[ASSET-IMGGEN-PACK-CHECKOUT] POST - User:', req.user?.id);
  try {
    const addon = await getMarketingAddon(req.user.id);
    if (!addon || addon.status !== 'active') {
      return res.status(403).json({ error: 'Active marketing add-on required for image generation' });
    }

    const pricing = PER_USE_PRICING.asset_image_gen_pack;
    if (!pricing.variantId) {
      console.error('[ASSET-IMGGEN-PACK-CHECKOUT] Missing image gen pack variant ID');
      return res.status(500).json({ error: 'Image generation pack checkout configuration error' });
    }

    const lsHeaders = {
      'Accept': 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
      'Authorization': `Bearer ${process.env.LEMON_SQUEEZY_API_KEY}`
    };

    const billing = await fetchLsBillingAddress(req.user.email, req.user.lsCustomerId);

    const checkoutData = {
      email: req.user.email,
      name: req.user.name || (req.user.email ? req.user.email.split('@')[0] : undefined),
      custom: { user_id: req.user.id, purchase_type: 'asset_image_gen_pack' }
    };

    if (billing) {
      checkoutData.billing_address = {};
      if (billing.country) checkoutData.billing_address.country = billing.country;
      if (billing.state) checkoutData.billing_address.state = billing.state;
      if (billing.zip) checkoutData.billing_address.zip = billing.zip;
    }

    const checkoutResponse = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
      method: 'POST',
      headers: lsHeaders,
      body: JSON.stringify({
        data: {
          type: 'checkouts',
          attributes: {
            checkout_data: checkoutData,
            checkout_options: { embed: false, media: true, desc: false },
            product_options: {
              enabled_variants: [Number(pricing.variantId)],
              redirect_url: `${req.protocol}://${req.get('host')}/profile.html?tab=marketing`
            }
          },
          relationships: {
            store: { data: { type: 'stores', id: String(process.env.LEMON_SQUEEZY_STORE_ID) } },
            variant: { data: { type: 'variants', id: String(pricing.variantId) } }
          }
        }
      })
    });

    if (!checkoutResponse.ok) {
      const errorData = await checkoutResponse.json();
      console.error('[ASSET-IMGGEN-PACK-CHECKOUT] LS Checkout API error:', JSON.stringify(errorData));
      return res.status(500).json({ error: 'Failed to create checkout session' });
    }

    const checkoutResult = await checkoutResponse.json();
    const checkoutUrl = checkoutResult.data?.attributes?.url;

    if (!checkoutUrl) {
      console.error('[ASSET-IMGGEN-PACK-CHECKOUT] No checkout URL in LS response');
      return res.status(500).json({ error: 'Failed to get checkout URL' });
    }

    console.log(`[ASSET-IMGGEN-PACK-CHECKOUT] Checkout created for user ${req.user.id}`);
    res.json({ checkoutUrl });
  } catch (error) {
    console.error('[ASSET-IMGGEN-PACK-CHECKOUT] Error:', error);
    res.status(500).json({ error: 'Failed to create image generation pack checkout session' });
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
    // Route add-on events vs main subscription events
    const isMarketingAddon = customData?.addon_type === 'marketing';
    const isAffiliateAddon = customData?.addon_type === 'affiliate';

    if (isMarketingAddon && eventName === 'subscription_created') {
      await handleMarketingAddonCreated(payload, customData);
    } else if (isAffiliateAddon && eventName === 'subscription_created') {
      await handleAffiliateAddonCreated(payload, customData);
    } else if (!isMarketingAddon && !isAffiliateAddon) {
      // Check if this is an add-on update (by checking existing records)
      const subscriptionId = payload.data?.id;
      const existingMarketingAddon = subscriptionId ? await getMarketingAddonByLsId(String(subscriptionId)) : null;
      const existingAffiliateAddon = !existingMarketingAddon && subscriptionId ? await getAffiliateAddonByLsId(String(subscriptionId)) : null;

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
      } else if (existingAffiliateAddon) {
        // This is an affiliate addon event
        switch (eventName) {
          case 'subscription_updated':
          case 'subscription_payment_success':
            await handleAffiliateAddonUpdated(payload, existingAffiliateAddon);
            break;
          case 'subscription_cancelled':
            await handleAffiliateAddonCancelled(existingAffiliateAddon);
            break;
          case 'subscription_expired':
            await handleAffiliateAddonExpired(existingAffiliateAddon);
            break;
          case 'subscription_payment_failed':
            await updateAffiliateAddon(existingAffiliateAddon.user_id, { status: 'past_due' });
            console.log(`[WEBHOOK] Affiliate addon payment failed for user ${existingAffiliateAddon.user_id}`);
            break;
          default:
            console.log(`[WEBHOOK] Unhandled affiliate addon event: ${eventName}`);
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

  console.log(`[WEBHOOK] subscription_updated DB status for ${subscriptionId}: '${subscription.status}', lsSubId: '${subscription.lsSubscriptionId}'`);

  // If the subscription was already marked as expired by downgrade-to-free,
  // do not let incoming LS webhooks overwrite the downgrade
  if (subscription.status === 'expired') {
    console.log(`[WEBHOOK] Ignoring subscription_updated for expired subscription ${subscriptionId} (already downgraded)`);
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

  console.log(`[WEBHOOK] subscription_cancelled DB status for ${subscriptionId}: '${subscription.status}', lsSubId: '${subscription.lsSubscriptionId}'`);

  // If the subscription was already marked as expired by downgrade-to-free,
  // do not let incoming LS webhooks overwrite the downgrade
  if (subscription.status === 'expired') {
    console.log(`[WEBHOOK] Ignoring subscription_cancelled for expired subscription ${subscriptionId} (already downgraded)`);
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

  // If the subscription was already marked as expired by downgrade-to-free,
  // do not let incoming LS webhooks overwrite the downgrade
  if (subscription.status === 'expired') {
    console.log(`[WEBHOOK] Ignoring subscription_resumed for expired subscription ${subscriptionId} (already downgraded)`);
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
  const { user_id, replaces_ls_subscription_id } = customData;
  const subscriptionData = payload.data.attributes;
  const subscriptionId = payload.data.id;

  if (!user_id) {
    console.error('[WEBHOOK] No user_id in custom_data for marketing addon creation');
    return;
  }

  console.log(`[WEBHOOK] Creating/replacing marketing addon for user ${user_id}`);

  const quantity = subscriptionData.quantity || 1;

  await upsertMarketingAddon({
    userId: user_id,
    status: 'active',
    lsSubscriptionId: String(subscriptionId),
    lsVariantId: String(subscriptionData.variant_id),
    plan: 'standard',
    monthlyPrice: MARKETING_ADDON_CONFIG.standard.monthlyPrice * quantity,
    maxAdAccounts: quantity,
    currentPeriodStart: subscriptionData.created_at,
    currentPeriodEnd: subscriptionData.renews_at
  });

  // If this subscription replaces an older one (user upgraded quantity via new checkout),
  // cancel the old subscription in LS to prevent double-billing on next renewal
  if (replaces_ls_subscription_id && String(replaces_ls_subscription_id) !== String(subscriptionId)) {
    try {
      console.log(`[WEBHOOK] Cancelling replaced subscription: ${replaces_ls_subscription_id}`);
      const cancelResponse = await fetch(
        `https://api.lemonsqueezy.com/v1/subscriptions/${replaces_ls_subscription_id}`,
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
              id: String(replaces_ls_subscription_id),
              attributes: {
                cancelled: true
              }
            }
          })
        }
      );
      if (cancelResponse.ok) {
        console.log(`[WEBHOOK] Old subscription ${replaces_ls_subscription_id} cancelled successfully`);
      } else {
        const errBody = await cancelResponse.text();
        console.error(`[WEBHOOK] Failed to cancel old subscription ${replaces_ls_subscription_id}: ${cancelResponse.status} - ${errBody}`);
      }
    } catch (cancelErr) {
      // Non-fatal: the upsert already succeeded, old sub will expire naturally
      console.error(`[WEBHOOK] Error cancelling old subscription ${replaces_ls_subscription_id}:`, cancelErr.message);
    }
  }

  console.log(`[WEBHOOK] Marketing addon created for user ${user_id}, quantity: ${quantity}, max_ad_accounts: ${quantity}`);
}

async function handleMarketingAddonUpdated(payload, existingAddon) {
  const subscriptionData = payload.data.attributes;

  const status = subscriptionData.status === 'active' ? 'active' : subscriptionData.status;
  const quantity = subscriptionData.quantity || 1;

  const updates = {
    status,
    current_period_start: subscriptionData.created_at,
    current_period_end: subscriptionData.renews_at,
    max_ad_accounts: quantity,
    monthly_price: MARKETING_ADDON_CONFIG.standard.monthlyPrice * quantity
  };

  await updateMarketingAddon(existingAddon.user_id, updates);

  console.log(`[WEBHOOK] Marketing addon updated for user ${existingAddon.user_id}, status: ${status}, quantity: ${quantity}, max_ad_accounts: ${quantity}`);
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
// AFFILIATE ADD-ON WEBHOOK HANDLERS
// ============================================

async function handleAffiliateAddonCreated(payload, customData) {
  const { user_id } = customData;
  const subscriptionData = payload.data.attributes;
  const subscriptionId = payload.data.id;

  if (!user_id) {
    console.error('[WEBHOOK] No user_id in custom_data for affiliate addon creation');
    return;
  }

  console.log(`[WEBHOOK] Creating affiliate addon for user ${user_id}`);

  await upsertAffiliateAddon({
    userId: user_id,
    status: 'active',
    lsSubscriptionId: String(subscriptionId),
    lsVariantId: String(subscriptionData.variant_id),
    plan: 'standard',
    monthlyPrice: AFFILIATE_ADDON_CONFIG.standard.monthlyPrice,
    maxKeywordSets: AFFILIATE_ADDON_CONFIG.standard.maxKeywordSets,
    maxProductsPerDay: AFFILIATE_ADDON_CONFIG.standard.maxProductsPerDay,
    currentPeriodStart: subscriptionData.created_at,
    currentPeriodEnd: subscriptionData.renews_at
  });

  console.log(`[WEBHOOK] Affiliate addon created successfully for user ${user_id}`);
}

async function handleAffiliateAddonUpdated(payload, existingAddon) {
  const subscriptionData = payload.data.attributes;

  const status = subscriptionData.status === 'active' ? 'active' : subscriptionData.status;

  await updateAffiliateAddon(existingAddon.user_id, {
    status,
    current_period_start: subscriptionData.created_at,
    current_period_end: subscriptionData.renews_at
  });

  console.log(`[WEBHOOK] Affiliate addon updated for user ${existingAddon.user_id}, status: ${status}`);
}

async function handleAffiliateAddonCancelled(existingAddon) {
  await updateAffiliateAddon(existingAddon.user_id, {
    status: 'cancelled'
  });

  console.log(`[WEBHOOK] Affiliate addon cancelled for user ${existingAddon.user_id}`);
}

async function handleAffiliateAddonExpired(existingAddon) {
  await updateAffiliateAddon(existingAddon.user_id, {
    status: 'expired'
  });

  console.log(`[WEBHOOK] Affiliate addon expired for user ${existingAddon.user_id}`);
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
      creditsTotal: pricing.creditsPerPurchase || 1,
      metadata: {
        ad_account_id: ad_account_id || null,
        ls_order_number: orderAttributes.order_number,
        ls_status: orderAttributes.status
      }
    });

    console.log(`[WEBHOOK] Per-use purchase recorded: ${purchase_type} (${pricing.creditsPerPurchase || 1} credits) for user ${user_id}`);
  } catch (error) {
    console.error(`[WEBHOOK] Failed to record per-use purchase:`, error);
  }
}

export default router;
