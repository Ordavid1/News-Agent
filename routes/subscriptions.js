// routes/subscriptions.js
import express from 'express';
import Stripe from 'stripe';
import { createSubscription, getSubscription, updateUser } from '../services/database-wrapper.js';

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

// Pricing configuration
const PRICING_TIERS = {
  starter: {
    name: '🚀 Starter Package',
    monthlyPrice: 4900, // $49 in cents
    postsPerDay: 10,
    features: ['10 posts/day', '2 platforms (Twitter, LinkedIn)', 'Basic analytics', 'Email support']
  },
  growth: {
    name: '📈 Growth Package',
    monthlyPrice: 14900, // $149
    postsPerDay: 20,
    features: ['20 posts/day', '3 platforms (+ Reddit)', 'Advanced analytics', 'Post scheduling', 'Priority support']
  },
  professional: {
    name: '💼 Professional Package',
    monthlyPrice: 39900, // $399
    postsPerDay: 30,
    features: ['30 posts/day', '5 platforms (+ Facebook, Instagram)', 'Bulk generation', 'API access', 'Custom posting schedules', 'Dedicated support']
  },
  business: {
    name: '🏢 Business Package',
    monthlyPrice: 79900, // $799
    postsPerDay: 45,
    features: ['45 posts/day', 'All platforms', 'White-label options', 'Webhook integrations', 'Custom analytics', '24/7 phone support']
  }
};

// Get current subscription
router.get('/current', async (req, res) => {
  try {
    const subscription = await getSubscription(req.user.id);
    
    res.json({
      subscription: req.user.subscription,
      fullSubscription: subscription,
      pricingTiers: PRICING_TIERS
    });
  } catch (error) {
    console.error('Error fetching subscription:', error);
    res.status(500).json({ error: 'Failed to fetch subscription' });
  }
});

// Create checkout session
router.post('/create-checkout', async (req, res) => {
  try {
    const { tier } = req.body;
    
    if (!PRICING_TIERS[tier]) {
      return res.status(400).json({ error: 'Invalid subscription tier' });
    }
    
    const priceConfig = PRICING_TIERS[tier];
    
    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: priceConfig.name,
            description: priceConfig.features.join(', '),
          },
          unit_amount: priceConfig.monthlyPrice,
          recurring: {
            interval: 'month',
          },
        },
        quantity: 1,
      }],
      mode: 'subscription',
      success_url: `${process.env.FRONTEND_URL}/dashboard?subscription=success`,
      cancel_url: `${process.env.FRONTEND_URL}/pricing?subscription=cancelled`,
      customer_email: req.user.email,
      metadata: {
        userId: req.user.id,
        tier: tier
      }
    });
    
    res.json({ 
      checkoutUrl: session.url,
      sessionId: session.id 
    });
    
  } catch (error) {
    console.error('Stripe checkout error:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Stripe webhook handler
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  
  // Handle the event
  switch (event.type) {
    case 'checkout.session.completed':
      const session = event.data.object;
      await handleSubscriptionCreated(session);
      break;
      
    case 'customer.subscription.updated':
      const subscription = event.data.object;
      await handleSubscriptionUpdated(subscription);
      break;
      
    case 'customer.subscription.deleted':
      const deletedSubscription = event.data.object;
      await handleSubscriptionCancelled(deletedSubscription);
      break;
      
    default:
      console.log(`Unhandled event type ${event.type}`);
  }
  
  res.json({ received: true });
});

// Test mode: activate subscription
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
    
    // Check if tier is valid - handle both formats
    const validTiers = ['basic', 'pro', 'enterprise', 'starter', 'growth', 'professional', 'business'];
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
      stripeSubscriptionId: `test_sub_${Date.now()}`,
      stripePriceId: `test_price_${tier}`,
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

// Cancel subscription
router.post('/cancel', async (req, res) => {
  try {
    const subscription = await getSubscription(req.user.id);
    
    if (!subscription || !subscription.stripeSubscriptionId) {
      return res.status(404).json({ error: 'No active subscription found' });
    }
    
    // Cancel at period end
    const updatedSubscription = await stripe.subscriptions.update(
      subscription.stripeSubscriptionId,
      { cancel_at_period_end: true }
    );
    
    // Update user record
    await updateUser(req.user.id, {
      'subscription.cancelAtPeriodEnd': true
    });
    
    res.json({ 
      message: 'Subscription will be cancelled at the end of the billing period',
      subscription: updatedSubscription
    });
    
  } catch (error) {
    console.error('Subscription cancellation error:', error);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// Reactivate subscription
router.post('/reactivate', async (req, res) => {
  try {
    const subscription = await getSubscription(req.user.id);
    
    if (!subscription || !subscription.stripeSubscriptionId) {
      return res.status(404).json({ error: 'No subscription found' });
    }
    
    // Reactivate subscription
    const updatedSubscription = await stripe.subscriptions.update(
      subscription.stripeSubscriptionId,
      { cancel_at_period_end: false }
    );
    
    // Update user record
    await updateUser(req.user.id, {
      'subscription.cancelAtPeriodEnd': false
    });
    
    res.json({ 
      message: 'Subscription reactivated',
      subscription: updatedSubscription
    });
    
  } catch (error) {
    console.error('Subscription reactivation error:', error);
    res.status(500).json({ error: 'Failed to reactivate subscription' });
  }
});

// Helper functions
async function handleSubscriptionCreated(session) {
  const { userId, tier } = session.metadata;
  
  await createSubscription({
    userId,
    tier,
    stripeCustomerId: session.customer,
    stripeSubscriptionId: session.subscription,
    amount: session.amount_total,
    currency: session.currency
  });
}

async function handleSubscriptionUpdated(subscription) {
  // Find user by Stripe customer ID and update subscription details
  // Implementation depends on your database structure
}

async function handleSubscriptionCancelled(subscription) {
  // Find user and downgrade to free tier
  // Implementation depends on your database structure
}

export default router;