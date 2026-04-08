-- Add agents_active column to analytics_reports table
-- This column tracks the number of distinct agents that posted on a given day
ALTER TABLE public.analytics_reports
  ADD COLUMN IF NOT EXISTS agents_active INTEGER DEFAULT 0;
