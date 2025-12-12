-- ============================================
-- CREATE PLAN INTEREST TRACKING TABLE
-- Run this in Supabase SQL Editor
-- ============================================
-- This table tracks "+1" clicks from users interested in plans
-- that are not yet available (beta version).
-- Each plan's interest is tracked separately.

-- Create the plan_interest table
CREATE TABLE IF NOT EXISTS public.plan_interest (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    plan_name VARCHAR(50) NOT NULL,
    user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    ip_address VARCHAR(45), -- Optional: for anonymous tracking
    user_agent TEXT -- Optional: for analytics
);

-- Add indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_plan_interest_plan_name ON public.plan_interest(plan_name);
CREATE INDEX IF NOT EXISTS idx_plan_interest_user_id ON public.plan_interest(user_id);
CREATE INDEX IF NOT EXISTS idx_plan_interest_created_at ON public.plan_interest(created_at);

-- Add RLS policies
ALTER TABLE public.plan_interest ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to insert their own interest
CREATE POLICY "Users can insert their own interest" ON public.plan_interest
    FOR INSERT
    WITH CHECK (auth.uid() = user_id OR user_id IS NULL);

-- Allow service role to read all (for analytics)
CREATE POLICY "Service role can read all" ON public.plan_interest
    FOR SELECT
    USING (auth.role() = 'service_role');

-- Add comments for documentation
COMMENT ON TABLE public.plan_interest IS 'Tracks user interest (+1 clicks) for plans not yet available during beta';
COMMENT ON COLUMN public.plan_interest.plan_name IS 'The plan identifier (growth, professional, business)';
COMMENT ON COLUMN public.plan_interest.user_id IS 'Optional reference to the user who clicked +1';
COMMENT ON COLUMN public.plan_interest.ip_address IS 'IP address for anonymous interest tracking';
COMMENT ON COLUMN public.plan_interest.user_agent IS 'Browser user agent for analytics purposes';

-- Create a view for plan interest counts (useful for admin dashboard)
CREATE OR REPLACE VIEW public.plan_interest_summary AS
SELECT
    plan_name,
    COUNT(*) as total_interest,
    COUNT(DISTINCT user_id) as unique_users,
    COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') as last_7_days,
    COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days') as last_30_days
FROM public.plan_interest
GROUP BY plan_name
ORDER BY total_interest DESC;

-- Grant access to the view
GRANT SELECT ON public.plan_interest_summary TO authenticated;
GRANT SELECT ON public.plan_interest_summary TO service_role;
