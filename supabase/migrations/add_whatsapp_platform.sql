-- ============================================
-- ADD WHATSAPP TO PLATFORM CONSTRAINTS
-- Run this in Supabase SQL Editor
-- ============================================

-- Update social_connections platform constraint to include 'whatsapp'
ALTER TABLE public.social_connections DROP CONSTRAINT IF EXISTS social_connections_platform_check;
ALTER TABLE public.social_connections ADD CONSTRAINT social_connections_platform_check
  CHECK (platform IN ('twitter', 'linkedin', 'reddit', 'facebook', 'instagram', 'tiktok', 'youtube', 'telegram', 'whatsapp'));

-- Update agents platform constraint to include 'whatsapp'
ALTER TABLE public.agents DROP CONSTRAINT IF EXISTS agents_platform_check;
ALTER TABLE public.agents ADD CONSTRAINT agents_platform_check
  CHECK (platform IN ('twitter', 'linkedin', 'reddit', 'facebook', 'instagram', 'tiktok', 'youtube', 'telegram', 'whatsapp'));
