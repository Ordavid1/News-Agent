-- ============================================
-- BRAND VOICE LEARNING TABLES
-- Run this in Supabase SQL Editor
-- ============================================
-- These tables support the Brand Voice feature within the Marketing add-on:
-- Learning brand voice from historical posts across all platforms,
-- storing analyzed voice profiles, and generating original content.

-- ============================================
-- 1. BRAND VOICE PROFILES
-- ============================================
CREATE TABLE IF NOT EXISTS public.brand_voice_profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'collecting', 'analyzing', 'ready', 'failed')),
  profile_data JSONB DEFAULT '{}',
  platforms_analyzed TEXT[] DEFAULT '{}',
  posts_analyzed_count INTEGER DEFAULT 0,
  error_message TEXT,
  last_analyzed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE public.brand_voice_profiles IS 'Stores learned brand voice profiles. Each profile is built by analyzing historical posts from connected social platforms. Used for generating original content that matches a brand''s tone and style.';

CREATE INDEX IF NOT EXISTS idx_brand_voice_profiles_user_id ON brand_voice_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_brand_voice_profiles_status ON brand_voice_profiles(status);

ALTER TABLE brand_voice_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own brand voice profiles"
  ON brand_voice_profiles FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own brand voice profiles"
  ON brand_voice_profiles FOR INSERT
  TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own brand voice profiles"
  ON brand_voice_profiles FOR UPDATE
  TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own brand voice profiles"
  ON brand_voice_profiles FOR DELETE
  TO authenticated
  USING ((select auth.uid()) = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.brand_voice_profiles TO authenticated;
GRANT ALL ON public.brand_voice_profiles TO service_role;

-- ============================================
-- 2. BRAND VOICE POSTS (Collected training data)
-- ============================================
CREATE TABLE IF NOT EXISTS public.brand_voice_posts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  profile_id UUID NOT NULL REFERENCES brand_voice_profiles(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'internal' CHECK (source IN ('api', 'internal')),
  external_post_id TEXT,
  content TEXT NOT NULL,
  media_type TEXT CHECK (media_type IN ('text', 'image', 'video', 'carousel', NULL)),
  engagement JSONB DEFAULT '{}',
  posted_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE public.brand_voice_posts IS 'Historical posts collected for brand voice analysis. Sourced from platform APIs (api) or the app''s own published_posts table (internal). Linked to a brand_voice_profiles record.';

CREATE INDEX IF NOT EXISTS idx_brand_voice_posts_profile ON brand_voice_posts(profile_id);
CREATE INDEX IF NOT EXISTS idx_brand_voice_posts_user ON brand_voice_posts(user_id);
CREATE INDEX IF NOT EXISTS idx_brand_voice_posts_platform ON brand_voice_posts(platform);
CREATE INDEX IF NOT EXISTS idx_brand_voice_posts_posted_at ON brand_voice_posts(posted_at DESC);

-- Prevent duplicate posts within a profile (only for API-sourced posts with real external IDs)
CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_voice_posts_unique_external
  ON brand_voice_posts(profile_id, platform, external_post_id);

ALTER TABLE brand_voice_posts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own brand voice posts"
  ON brand_voice_posts FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own brand voice posts"
  ON brand_voice_posts FOR INSERT
  TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own brand voice posts"
  ON brand_voice_posts FOR DELETE
  TO authenticated
  USING ((select auth.uid()) = user_id);

GRANT SELECT, INSERT, DELETE ON public.brand_voice_posts TO authenticated;
GRANT ALL ON public.brand_voice_posts TO service_role;
