-- ============================================
-- CLEANUP LEGACY TIERS
-- Migrate all legacy/deprecated tier names to canonical tiers:
--   professional → growth
--   pro → growth
--   basic → starter
--   enterprise → business
-- ============================================

-- 1. Remap legacy tiers in profiles table
UPDATE profiles SET subscription_tier = 'growth' WHERE subscription_tier = 'professional';
UPDATE profiles SET subscription_tier = 'growth' WHERE subscription_tier = 'pro';
UPDATE profiles SET subscription_tier = 'starter' WHERE subscription_tier = 'basic';
UPDATE profiles SET subscription_tier = 'business' WHERE subscription_tier = 'enterprise';

-- 2. Remap legacy tiers in subscriptions table
UPDATE subscriptions SET tier = 'growth' WHERE tier = 'professional';
UPDATE subscriptions SET tier = 'growth' WHERE tier = 'pro';
UPDATE subscriptions SET tier = 'starter' WHERE tier = 'basic';
UPDATE subscriptions SET tier = 'business' WHERE tier = 'enterprise';

-- 3. Update CHECK constraint on profiles to only allow canonical tiers
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_subscription_tier_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_subscription_tier_check
  CHECK (subscription_tier IN ('free', 'starter', 'growth', 'business'));

-- 4. Update post limits for remapped users to match their new tier
UPDATE profiles SET
  posts_remaining = CASE subscription_tier
    WHEN 'starter' THEN LEAST(posts_remaining, 6)
    WHEN 'growth' THEN LEAST(posts_remaining, 12)
    WHEN 'business' THEN LEAST(posts_remaining, 30)
    ELSE posts_remaining
  END,
  daily_limit = CASE subscription_tier
    WHEN 'starter' THEN 6
    WHEN 'growth' THEN 12
    WHEN 'business' THEN 30
    ELSE daily_limit
  END
WHERE subscription_tier IN ('starter', 'growth', 'business');
