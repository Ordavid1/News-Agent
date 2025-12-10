/**
 * Admin script to set subscription tier for a user
 * Usage: node scripts/set-admin-subscription.js
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing Supabase credentials in .env file');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Configuration
const ADMIN_EMAIL = 'ordavidone@gmail.com';
const TARGET_TIER = 'business';

// Daily limits by tier
const TIER_LIMITS = {
  free: 5,
  starter: 10,
  growth: 20,
  professional: 30,
  business: 45
};

async function setAdminSubscription() {
  console.log(`Setting subscription for ${ADMIN_EMAIL} to ${TARGET_TIER}...`);

  try {
    // First, find the user
    const { data: user, error: findError } = await supabase
      .from('profiles')
      .select('*')
      .eq('email', ADMIN_EMAIL)
      .single();

    if (findError) {
      console.error('Error finding user:', findError);
      return;
    }

    if (!user) {
      console.error(`User with email ${ADMIN_EMAIL} not found`);
      return;
    }

    console.log('Found user:', user.id, user.email);
    console.log('Current tier:', user.subscription_tier);

    // Update the subscription
    const dailyLimit = TIER_LIMITS[TARGET_TIER] || 45;

    const { data: updated, error: updateError } = await supabase
      .from('profiles')
      .update({
        subscription_tier: TARGET_TIER,
        subscription_status: 'active',
        daily_limit: dailyLimit,
        posts_remaining: dailyLimit,
        updated_at: new Date().toISOString()
      })
      .eq('id', user.id)
      .select()
      .single();

    if (updateError) {
      console.error('Error updating subscription:', updateError);
      return;
    }

    console.log('\nSubscription updated successfully!');
    console.log('New tier:', updated.subscription_tier);
    console.log('Daily limit:', updated.daily_limit);
    console.log('Posts remaining:', updated.posts_remaining);

  } catch (error) {
    console.error('Script error:', error);
  }
}

setAdminSubscription();
