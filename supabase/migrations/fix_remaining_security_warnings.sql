-- ============================================
-- FIX: Remaining Supabase Linter Security Warnings
-- ============================================
-- 1. RLS on media_assets (ERROR)
-- 2. RLS on generated_media (ERROR)
-- 3. RLS on brand_voice_generated_posts (ERROR)
-- 4. RLS on media_training_jobs (ERROR)
-- 5. Security Definer View: published_posts_overview (ERROR)
-- 6. Function Search Path Mutable: decrement_videos_remaining (WARN)
-- ============================================

BEGIN;

-- ============================================
-- 1. Enable RLS on media_assets
-- ============================================

ALTER TABLE public.media_assets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own media_assets"
  ON public.media_assets FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own media_assets"
  ON public.media_assets FOR INSERT
  TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own media_assets"
  ON public.media_assets FOR UPDATE
  TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own media_assets"
  ON public.media_assets FOR DELETE
  TO authenticated
  USING ((select auth.uid()) = user_id);

GRANT ALL ON public.media_assets TO authenticated;
GRANT ALL ON public.media_assets TO service_role;

-- ============================================
-- 2. Enable RLS on generated_media
-- ============================================

ALTER TABLE public.generated_media ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own generated_media"
  ON public.generated_media FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own generated_media"
  ON public.generated_media FOR INSERT
  TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own generated_media"
  ON public.generated_media FOR UPDATE
  TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own generated_media"
  ON public.generated_media FOR DELETE
  TO authenticated
  USING ((select auth.uid()) = user_id);

GRANT ALL ON public.generated_media TO authenticated;
GRANT ALL ON public.generated_media TO service_role;

-- ============================================
-- 3. Enable RLS on brand_voice_generated_posts
-- ============================================

ALTER TABLE public.brand_voice_generated_posts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own brand_voice_generated_posts"
  ON public.brand_voice_generated_posts FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own brand_voice_generated_posts"
  ON public.brand_voice_generated_posts FOR INSERT
  TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own brand_voice_generated_posts"
  ON public.brand_voice_generated_posts FOR UPDATE
  TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own brand_voice_generated_posts"
  ON public.brand_voice_generated_posts FOR DELETE
  TO authenticated
  USING ((select auth.uid()) = user_id);

GRANT ALL ON public.brand_voice_generated_posts TO authenticated;
GRANT ALL ON public.brand_voice_generated_posts TO service_role;

-- ============================================
-- 4. Enable RLS on media_training_jobs
-- ============================================

ALTER TABLE public.media_training_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own media_training_jobs"
  ON public.media_training_jobs FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own media_training_jobs"
  ON public.media_training_jobs FOR INSERT
  TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own media_training_jobs"
  ON public.media_training_jobs FOR UPDATE
  TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own media_training_jobs"
  ON public.media_training_jobs FOR DELETE
  TO authenticated
  USING ((select auth.uid()) = user_id);

GRANT ALL ON public.media_training_jobs TO authenticated;
GRANT ALL ON public.media_training_jobs TO service_role;

-- ============================================
-- 5. Fix: published_posts_overview view
--    Add security_invoker = true so RLS applies
--    to the querying user, not the view creator.
-- ============================================

DROP VIEW IF EXISTS public.published_posts_overview;

CREATE VIEW public.published_posts_overview
WITH (security_invoker = true)
AS
SELECT
  pp.id                     AS post_id,
  pp.content                AS post_content,
  pp.topic                  AS post_topic,
  pp.platform               AS platform_name,
  pp.published_at           AS published_on,
  pp.platform_url           AS platform_url,
  pp.success                AS publish_success,
  p.email                   AS profile_email,
  p.name                    AS profile_name,
  p.subscription_tier       AS subscription_tier,
  p.subscription_status     AS subscription_status,
  COALESCE(a.agent_count, 0)       AS total_agents,
  COALESCE(sc.platform_count, 0)   AS total_platforms_connected,
  pp.user_id                AS user_id
FROM published_posts pp
JOIN profiles p ON pp.user_id = p.id
LEFT JOIN (
  SELECT user_id, COUNT(*) AS agent_count
  FROM agents
  GROUP BY user_id
) a ON a.user_id = pp.user_id
LEFT JOIN (
  SELECT user_id, COUNT(*) AS platform_count
  FROM social_connections
  WHERE status = 'active'
  GROUP BY user_id
) sc ON sc.user_id = pp.user_id;

COMMENT ON VIEW public.published_posts_overview IS
  'Consolidated view of published posts with user profile and subscription details.';

GRANT SELECT ON public.published_posts_overview TO authenticated;
GRANT SELECT ON public.published_posts_overview TO service_role;

-- ============================================
-- 6. Fix: decrement_videos_remaining function
--    Add SET search_path = '' to prevent
--    search-path injection on SECURITY DEFINER.
-- ============================================

CREATE OR REPLACE FUNCTION decrement_videos_remaining(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.profiles
  SET videos_remaining = GREATEST(0, videos_remaining - 1),
      updated_at = NOW()
  WHERE id = p_user_id;
END;
$$;

COMMIT;
