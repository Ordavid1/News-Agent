-- Update subscription_tier constraint to include all tiers
-- Run this in Supabase SQL Editor

-- Drop the existing constraint
ALTER TABLE public.profiles
DROP CONSTRAINT IF EXISTS profiles_subscription_tier_check;

-- Add the updated constraint with all tiers
ALTER TABLE public.profiles
ADD CONSTRAINT profiles_subscription_tier_check
CHECK (subscription_tier IN ('free', 'basic', 'starter', 'growth', 'professional', 'business', 'enterprise'));
