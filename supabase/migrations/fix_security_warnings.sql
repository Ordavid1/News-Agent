-- ============================================
-- FIX: Supabase Linter Security Warnings
-- ============================================
-- 1. Security Definer View: plan_interest_summary (ERROR)
-- 2. Function Search Path Mutable: cleanup_old_article_usage (WARN)
-- 3. Function Search Path Mutable: cleanup_expired_whatsapp_codes (WARN)
-- 4. Drop stale tables: analysis, analysis-new (INFO)
-- ============================================

BEGIN;

-- ============================================
-- 1. Fix: plan_interest_summary view
--    Add security_invoker = true so RLS applies
--    to the querying user, not the view creator.
-- ============================================

DROP VIEW IF EXISTS public.plan_interest_summary;

CREATE VIEW public.plan_interest_summary
WITH (security_invoker = true)
AS
SELECT
    plan_name,
    COUNT(*) as total_interest,
    COUNT(DISTINCT user_id) as unique_users,
    COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') as last_7_days,
    COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days') as last_30_days
FROM public.plan_interest
GROUP BY plan_name
ORDER BY total_interest DESC;

GRANT SELECT ON public.plan_interest_summary TO authenticated;
GRANT SELECT ON public.plan_interest_summary TO service_role;

-- ============================================
-- 2. Fix: cleanup_old_article_usage function
--    Add SET search_path = '' to prevent
--    search-path injection on SECURITY DEFINER.
-- ============================================

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

-- ============================================
-- 3. Fix: cleanup_expired_whatsapp_codes function
--    Add SET search_path = '' to prevent
--    search-path injection on SECURITY DEFINER.
-- ============================================

CREATE OR REPLACE FUNCTION cleanup_expired_whatsapp_codes()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.whatsapp_pending_connections
  SET status = 'expired'
  WHERE status = 'pending'
    AND expires_at < NOW();
END;
$$;

-- ============================================
-- 4. Drop stale tables with no policies
--    These don't exist in the codebase and
--    appear to be leftover test tables.
-- ============================================

DROP TABLE IF EXISTS public.analysis;
DROP TABLE IF EXISTS public."analysis-new";

COMMIT;
