-- ============================================
-- VIDEO POST TRACKING
-- Adds monthly video quota tracking to profiles
-- ============================================

-- Add video tracking columns to profiles
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS videos_remaining INTEGER DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS video_monthly_limit INTEGER DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS video_reset_date TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 days');

-- Function to decrement videos remaining (mirrors decrement_posts_remaining)
CREATE OR REPLACE FUNCTION decrement_videos_remaining(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE profiles
  SET videos_remaining = GREATEST(0, videos_remaining - 1),
      updated_at = NOW()
  WHERE id = p_user_id;
END;
$$;

-- Initialize video limits for existing paid users based on their tier
UPDATE profiles
SET video_monthly_limit = CASE subscription_tier
      WHEN 'starter' THEN 2
      WHEN 'growth' THEN 10
      WHEN 'business' THEN 50
      ELSE 0
    END,
    videos_remaining = CASE subscription_tier
      WHEN 'starter' THEN 2
      WHEN 'growth' THEN 10
      WHEN 'business' THEN 50
      ELSE 0
    END,
    video_reset_date = NOW() + INTERVAL '30 days'
WHERE subscription_tier IS NOT NULL;
