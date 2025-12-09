-- ============================================
-- AGENTS TABLE MIGRATION
-- Run this in Supabase SQL Editor
-- ============================================

-- Create agents table
CREATE TABLE IF NOT EXISTS public.agents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  connection_id UUID REFERENCES social_connections(id) ON DELETE CASCADE NOT NULL,

  -- Basic info
  name TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('twitter', 'linkedin', 'reddit', 'facebook', 'instagram', 'tiktok', 'youtube', 'telegram')),
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused', 'error')),

  -- Agent-specific configuration (JSONB for flexibility)
  settings JSONB DEFAULT '{
    "topics": [],
    "keywords": [],
    "geoFilter": { "region": "", "includeGlobal": true },
    "schedule": { "postsPerDay": 3, "startTime": "09:00", "endTime": "21:00" },
    "contentStyle": { "tone": "professional", "includeHashtags": true }
  }',

  -- Tracking
  posts_today INTEGER DEFAULT 0,
  last_posted_at TIMESTAMPTZ,
  total_posts INTEGER DEFAULT 0,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- One agent per connection (prevents duplicate agents for same platform)
  UNIQUE(connection_id)
);

-- ============================================
-- INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_agents_user_id ON agents(user_id);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_agents_platform ON agents(platform);

-- ============================================
-- ROW LEVEL SECURITY POLICIES
-- ============================================
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own agents"
  ON agents FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own agents"
  ON agents FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own agents"
  ON agents FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own agents"
  ON agents FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- ============================================
-- GRANTS
-- ============================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agents TO authenticated;
GRANT ALL ON public.agents TO service_role;

-- ============================================
-- HELPER FUNCTIONS
-- ============================================

-- Function to reset daily agent post counts (to be called by cron)
CREATE OR REPLACE FUNCTION reset_daily_agent_posts()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE agents
  SET posts_today = 0,
      updated_at = NOW();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Function to increment agent post count
CREATE OR REPLACE FUNCTION increment_agent_post(p_agent_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE agents
  SET posts_today = posts_today + 1,
      total_posts = total_posts + 1,
      last_posted_at = NOW(),
      updated_at = NOW()
  WHERE id = p_agent_id;
END;
$$;

-- Grant execute on functions
GRANT EXECUTE ON FUNCTION reset_daily_agent_posts() TO service_role;
GRANT EXECUTE ON FUNCTION increment_agent_post(UUID) TO service_role;
