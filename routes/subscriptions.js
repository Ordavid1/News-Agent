// routes/subscriptions.js - Lemon Squeezy Integration
import express from 'express';
import crypto from 'crypto';
import { createSubscription, getSubscription, updateUser, getSubscriptionByLsId } from '../services/database-wrapper.js';

const router = express.Router();

// Pricing configuration with Lemon Squeezy variant IDs
const PRICING_TIERS = {
  starter: {
    name: 'Starter Package',
    monthlyPrice: 4900, // $49 in cents
    postsPerDay: 10,
    variantId: process.env.LEMON_SQUEEZY_49_VARIANT_ID,
    features: ['10 posts/day (300/mo)', '2 platforms (LinkedIn, Reddit)', 'Basic analytics', 'Email support']
  },
  growth: {
    name: 'Growth Package',
    monthlyPrice: 14900, // $149
    postsPerDay: 20,
    variantId: process.env.LEMON_SQUEEZY_149_VARIANT_ID,
    features: ['20 posts/day (600/mo)', '3 platforms (+ Twitter)', 'Advanced analytics', 'Post scheduling', 'Priority support']
  },
  professional: {
    name: 'Professional Package',
    monthlyPrice: 39900, // $399
    postsPerDay: 30,
    variantId: process.env.LEMON_SQUEEZY_399_VARIANT_ID,
    features: ['30 posts/day (900/mo)', '5 platforms (+ Facebook, Instagram)', 'Bulk generation', 'API access', 'Custom posting schedules', 'Dedicated support']
  },
  business: {
    name: 'Business Package',
    monthlyPrice: 79900, // $799
    postsPerDay: 45,
    variantId: process.env.LEMON_SQUEEZY_799_VARIANT_ID,
    features: ['45 posts/day (1,350/mo)', 'All platforms (+ Telegram, TikTok, YouTube)', 'White-label options', 'Webhook integrations', 'Custom analytics', '24/7 phone support']
  }
};

// Helper to get post limit by tier
function getTierPostLimit(tier) {
  const limits = {
    free: 5,
    starter: 10,
    growth: 20,
    professional: 30,
    business: 45
  };
  return limits[tier] || 5;
}

// Get current subscription
router.get('/current', async (req, res) => {
  console.log('[SUBSCRIPTION] GET /current - User:', req.user?.id);
  try {
    const subscription = await getSubscription(req.user.id);
    console.log('[SUBSCRIPTION] Current subscription:', JSON.stringify(subscription));

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
router.post('/create-checkout', async (req, res) => {
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

    console.log('[CHECKOUT] Creating LS checkout with payload:', JSON.stringify(checkoutPayload, null, 2));
    console.log('[CHECKOUT] Store ID:', process.env.LEMON_SQUEEZY_STORE_ID);
    console.log('[CHECKOUT] API Key present:', !!process.env.LEMON_SQUEEZY_API_KEY);

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
    console.log('[CHECKOUT] LS API Response:', JSON.stringify(data, null, 2));

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
    console.log('[PORTAL] Subscription:', JSON.stringify(subscription));

    if (!subscription?.lsSubscriptionId) {
      console.log('[PORTAL] No lsSubscriptionId found');
      return res.status(404).json({ error: 'No active subscription found' });
    }

    // Fetch fresh subscription data from Lemon Squeezy (portal URL is valid for 24h)
    const response = await fetch(
      `https://api.lemonsqueezy.com/v1/subscriptions/${subscription.lsSubscriptionId}`,
      {
        headers: {
          'Accept': 'application/vnd.api+json',
          'Authorization': `Bearer ${process.env.LEMON_SQUEEZY_API_KEY}`
        }
      }
    );

    if (!response.ok) {
      console.error('Failed to fetch subscription from Lemon Squeezy');
      return res.status(500).json({ error: 'Failed to fetch portal URL' });
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
    console.log('[CANCEL] Current subscription:', JSON.stringify(subscription));

    if (!subscription || !subscription.lsSubscriptionId) {
      console.log('[CANCEL] No subscription found');
      return res.status(404).json({ error: 'No active subscription found' });
    }

    // Cancel subscription via Lemon Squeezy API
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
              cancelled: true
            }
          }
        })
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      console.error('Lemon Squeezy cancel error:', errorData);
      return res.status(500).json({ error: 'Failed to cancel subscription' });
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
router.post('/change-plan', async (req, res) => {
  console.log('[CHANGE-PLAN] POST /change-plan - User:', req.user?.id, 'New Tier:', req.body?.tier);
  try {
    const { tier: newTier } = req.body;

    if (!PRICING_TIERS[newTier]) {
      console.error('[CHANGE-PLAN] Invalid tier:', newTier);
      return res.status(400).json({ error: 'Invalid subscription tier' });
    }

    const subscription = await getSubscription(req.user.id);
    console.log('[CHANGE-PLAN] Current subscription:', JSON.stringify(subscription));

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
    console.log('[CHANGE-PLAN] LS API Response:', JSON.stringify(data, null, 2));

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

// Test mode: activate subscription (for development)
router.post('/test-activate', async (req, res) => {
  console.log('Test activation endpoint hit');
  console.log('Test mode:', process.env.TEST_MODE);
  console.log('User:', req.user ? req.user.id : 'No user');

  if (process.env.TEST_MODE !== 'true') {
    return res.status(403).json({ error: 'Test mode is not enabled' });
  }

  try {
    const { tier } = req.body;
    console.log('Tier requested:', tier);

    // Check if tier is valid
    const validTiers = ['starter', 'growth', 'professional', 'business'];
    if (!validTiers.includes(tier)) {
      console.log('Invalid tier:', tier);
      return res.status(400).json({ error: 'Invalid tier: ' + tier });
    }

    if (!req.user || !req.user.id) {
      console.error('No user in request');
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Create test subscription
    const subscriptionData = {
      userId: req.user.id,
      tier: tier,
      lsSubscriptionId: `test_sub_${Date.now()}`,
      lsCustomerId: `test_cust_${Date.now()}`,
      lsVariantId: PRICING_TIERS[tier]?.variantId || `test_variant_${tier}`,
      status: 'active'
    };

    console.log('Creating subscription:', subscriptionData);
    await createSubscription(subscriptionData);

    res.json({
      message: 'Test subscription activated',
      subscription: subscriptionData
    });
  } catch (error) {
    console.error('Test subscription error:', error);
    res.status(500).json({ error: 'Failed to activate test subscription: ' + error.message });
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
        // Initial order - subscription_created will follow
        console.log('Order created:', payload.data.id);
        break;

      default:
        console.log(`Unhandled webhook event: ${eventName}`);
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

async function handleSubscriptionCreated(payload, customData) {
  const { user_id, tier } = customData;
  const subscriptionData = payload.data.attributes;
  const subscriptionId = payload.data.id;

  if (!user_id) {
    console.error('No user_id in custom_data for subscription_created');
    return;
  }

  console.log(`Creating subscription for user ${user_id}, tier: ${tier}`);

  // Create subscription record in database
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

  // Update user profile with new subscription details
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

  console.log(`Subscription created successfully for user ${user_id}`);
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

  // Downgrade to free tier
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

export default router;
