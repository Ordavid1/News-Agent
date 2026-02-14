-- ============================================
-- Add agent_id and user_id to published_posts table
-- Run this in Supabase SQL Editor
-- ============================================
-- The AutomationManager's logAgentPublication() passes agent_id and user_id
-- when saving published posts, but these columns were missing from the table.

-- Add agent_id column (nullable, references agents table)
ALTER TABLE public.published_posts
  ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES public.agents(id) ON DELETE SET NULL;

-- Add user_id column (nullable, references auth.users)
ALTER TABLE public.published_posts
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_published_posts_agent_id ON public.published_posts(agent_id);
CREATE INDEX IF NOT EXISTS idx_published_posts_user_id ON public.published_posts(user_id);
