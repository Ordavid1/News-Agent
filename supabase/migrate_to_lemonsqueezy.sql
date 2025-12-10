-- ============================================
-- MIGRATION: Stripe to Lemon Squeezy
-- Run this in Supabase SQL Editor
-- ============================================

-- Add Lemon Squeezy columns to subscriptions table
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS ls_subscription_id TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS ls_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS ls_variant_id TEXT,
  ADD COLUMN IF NOT EXISTS ls_order_id TEXT;

-- Add Lemon Squeezy columns to profiles table
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS ls_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS ls_subscription_id TEXT;

-- Create indexes for efficient webhook lookups
CREATE INDEX IF NOT EXISTS idx_subscriptions_ls_id ON subscriptions(ls_subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_ls_customer ON subscriptions(ls_customer_id);
CREATE INDEX IF NOT EXISTS idx_profiles_ls_subscription ON profiles(ls_subscription_id);

-- ============================================
-- Note: Stripe columns are kept for backwards compatibility
-- They can be dropped later after verifying LS integration works:
--
-- ALTER TABLE subscriptions DROP COLUMN IF EXISTS stripe_subscription_id;
-- ALTER TABLE subscriptions DROP COLUMN IF EXISTS stripe_customer_id;
-- ALTER TABLE subscriptions DROP COLUMN IF EXISTS stripe_price_id;
-- ALTER TABLE profiles DROP COLUMN IF EXISTS stripe_customer_id;
-- ALTER TABLE profiles DROP COLUMN IF EXISTS stripe_subscription_id;
-- ============================================
