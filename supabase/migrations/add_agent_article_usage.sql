-- ============================================
-- CREATE agent_article_usage TABLE
-- Run this in Supabase SQL Editor
-- ============================================
-- This table tracks article usage per agent to prevent:
-- 1. Exact URL reuse within 24 hours
-- 2. Same story from different outlets (cross-outlet detection)
-- Uses story fingerprinting for similarity matching.

-- Create the table
CREATE TABLE IF NOT EXISTS public.agent_article_usage (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Agent identification (per-agent tracking, not per-user)
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,

  -- Article identification
  article_url TEXT NOT NULL,
  article_url_hash TEXT NOT NULL,  -- Hash for fast exact lookup

  -- Story fingerprint for cross-outlet detection
  -- Format: "date|entities|keywords" (e.g., "2024-01-15|apple_iphone|announces_features")
  story_fingerprint TEXT NOT NULL,

  -- Original article metadata (for debugging/analysis)
  article_title TEXT,
  article_source TEXT,
  published_date DATE,

  -- Timestamps
  used_at TIMESTAMPTZ DEFAULT NOW(),

  -- Composite unique constraint - one agent can't use same URL twice
  UNIQUE(agent_id, article_url_hash)
);

-- Add comments for documentation
COMMENT ON TABLE public.agent_article_usage IS 'Tracks article usage per agent to prevent duplicate content. Stores URL hash for exact matching and story fingerprint for cross-outlet detection.';
COMMENT ON COLUMN public.agent_article_usage.article_url_hash IS 'Hash of normalized URL for fast exact-match lookups';
COMMENT ON COLUMN public.agent_article_usage.story_fingerprint IS 'Fingerprint combining date, entities, and keywords for detecting same story from different outlets';

-- Critical indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_agent_article_agent_id ON agent_article_usage(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_article_url_hash ON agent_article_usage(article_url_hash);
CREATE INDEX IF NOT EXISTS idx_agent_article_fingerprint ON agent_article_usage(story_fingerprint);
CREATE INDEX IF NOT EXISTS idx_agent_article_used_at ON agent_article_usage(used_at);

-- Composite index for the most common query pattern (agent + time range)
CREATE INDEX IF NOT EXISTS idx_agent_article_agent_time ON agent_article_usage(agent_id, used_at DESC);

-- Enable Row Level Security
ALTER TABLE agent_article_usage ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see/modify their own agents' article usage
CREATE POLICY "Users can manage their own agents article usage" ON agent_article_usage
  FOR ALL
  USING (
    agent_id IN (
      SELECT id FROM agents WHERE user_id = (select auth.uid())
    )
  )
  WITH CHECK (
    agent_id IN (
      SELECT id FROM agents WHERE user_id = (select auth.uid())
    )
  );

-- Service role gets full access (automation runs as service role)
GRANT ALL ON public.agent_article_usage TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_article_usage TO authenticated;

-- ============================================
-- CLEANUP FUNCTION
-- ============================================
-- Function to clean up old entries (called by maintenance job)
CREATE OR REPLACE FUNCTION cleanup_old_article_usage(hours_to_keep INTEGER DEFAULT 48)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  DELETE FROM public.agent_article_usage
  WHERE used_at < NOW() - (hours_to_keep || ' hours')::INTERVAL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Grant execute to service role
GRANT EXECUTE ON FUNCTION cleanup_old_article_usage(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION cleanup_old_article_usage(INTEGER) TO authenticated;
