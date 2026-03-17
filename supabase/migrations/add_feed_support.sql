-- ============================================
-- FEED FEATURE: Add image_url column + feed index
-- Run this in Supabase SQL Editor
-- ============================================

-- 1. Add image_url column to store the image associated with each post
ALTER TABLE public.published_posts
  ADD COLUMN IF NOT EXISTS image_url TEXT;

COMMENT ON COLUMN public.published_posts.image_url IS
  'URL of the image published with this post (extracted article image, YouTube thumbnail, etc.)';

-- 2. Composite index for the feed query:
--    success=true, ordered by published_at DESC
CREATE INDEX IF NOT EXISTS idx_published_posts_feed
  ON public.published_posts (success, published_at DESC)
  WHERE success = true;

-- 3. Backfill: populate image_url from the trend JSONB for historical posts
UPDATE public.published_posts
SET image_url = trend->>'imageUrl'
WHERE image_url IS NULL
  AND trend IS NOT NULL
  AND trend->>'imageUrl' IS NOT NULL
  AND trend->>'imageUrl' != '';
