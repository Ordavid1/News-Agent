-- ============================================
-- ADD test_used_at COLUMN TO AGENTS TABLE
-- Run this in Supabase SQL Editor
-- ============================================
-- This column tracks when the "Test" button was used for an agent.
-- Once set, the Test button should be disabled permanently for that agent.
-- This prevents abuse of the test functionality.

-- Add the test_used_at column (nullable - null means test not yet used)
ALTER TABLE public.agents
ADD COLUMN IF NOT EXISTS test_used_at TIMESTAMPTZ DEFAULT NULL;

-- Add a comment for documentation
COMMENT ON COLUMN public.agents.test_used_at IS 'Timestamp when the Test button was used. Once set, Test button should be disabled to prevent abuse.';
