-- ============================================
-- ADD ALIEXPRESS TO PLATFORM CONSTRAINTS
-- Run this in Supabase SQL Editor
-- ============================================
-- Adds 'aliexpress' to the platform CHECK constraints on
-- social_connections and agents tables for AE Affiliate OAuth.

-- Update social_connections platform constraint
ALTER TABLE public.social_connections DROP CONSTRAINT IF EXISTS social_connections_platform_check;
ALTER TABLE public.social_connections ADD CONSTRAINT social_connections_platform_check
  CHECK (platform IN ('twitter', 'linkedin', 'reddit', 'facebook', 'instagram', 'tiktok', 'youtube', 'telegram', 'whatsapp', 'threads', 'aliexpress'));

-- Update agents platform constraint
ALTER TABLE public.agents DROP CONSTRAINT IF EXISTS agents_platform_check;
ALTER TABLE public.agents ADD CONSTRAINT agents_platform_check
  CHECK (platform IN ('twitter', 'linkedin', 'reddit', 'facebook', 'instagram', 'tiktok', 'youtube', 'telegram', 'whatsapp', 'threads', 'aliexpress'));
