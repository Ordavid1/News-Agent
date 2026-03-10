-- ============================================
-- BRAND VOICE: ADD SELECTED PLATFORMS COLUMN
-- Run this in Supabase SQL Editor
-- ============================================
-- Allows users to choose which platforms to analyze when creating a brand voice profile.
-- NULL means all available platforms (backward-compatible with existing profiles).

ALTER TABLE brand_voice_profiles
ADD COLUMN IF NOT EXISTS selected_platforms TEXT[] DEFAULT NULL;

COMMENT ON COLUMN brand_voice_profiles.selected_platforms IS
  'User-selected platforms to learn from during post collection. NULL means all available platforms.';
