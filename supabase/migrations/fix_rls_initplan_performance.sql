-- ============================================
-- FIX: RLS InitPlan Performance Optimization
-- ============================================
-- Supabase linter warning: auth_rls_initplan
--
-- Problem: auth.uid() and auth.role() in RLS policies are re-evaluated
-- for every row scanned, causing suboptimal query performance at scale.
--
-- Fix: Wrap calls in (select ...) so PostgreSQL evaluates them once as
-- an InitPlan instead of per-row.
--
-- Ref: https://supabase.com/docs/guides/database/postgres/row-level-security#call-functions-with-select
-- ============================================

BEGIN;

-- ============================================
-- PROFILES (3 policies)
-- ============================================

DROP POLICY IF EXISTS "Users can view own profile" ON profiles;
CREATE POLICY "Users can view own profile"
  ON profiles FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = id);

DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE
  TO authenticated
  USING ((select auth.uid()) = id);

DROP POLICY IF EXISTS "Users can insert own profile" ON profiles;
CREATE POLICY "Users can insert own profile"
  ON profiles FOR INSERT
  TO authenticated
  WITH CHECK ((select auth.uid()) = id);

-- ============================================
-- SOCIAL_CONNECTIONS (4 policies)
-- ============================================

DROP POLICY IF EXISTS "Users can view own connections" ON social_connections;
CREATE POLICY "Users can view own connections"
  ON social_connections FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can insert own connections" ON social_connections;
CREATE POLICY "Users can insert own connections"
  ON social_connections FOR INSERT
  TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own connections" ON social_connections;
CREATE POLICY "Users can update own connections"
  ON social_connections FOR UPDATE
  TO authenticated
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete own connections" ON social_connections;
CREATE POLICY "Users can delete own connections"
  ON social_connections FOR DELETE
  TO authenticated
  USING ((select auth.uid()) = user_id);

-- ============================================
-- POSTS (4 policies)
-- ============================================

DROP POLICY IF EXISTS "Users can view own posts" ON posts;
CREATE POLICY "Users can view own posts"
  ON posts FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can insert own posts" ON posts;
CREATE POLICY "Users can insert own posts"
  ON posts FOR INSERT
  TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own posts" ON posts;
CREATE POLICY "Users can update own posts"
  ON posts FOR UPDATE
  TO authenticated
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete own posts" ON posts;
CREATE POLICY "Users can delete own posts"
  ON posts FOR DELETE
  TO authenticated
  USING ((select auth.uid()) = user_id);

-- ============================================
-- SUBSCRIPTIONS (1 policy)
-- ============================================

DROP POLICY IF EXISTS "Users can view own subscription" ON subscriptions;
CREATE POLICY "Users can view own subscription"
  ON subscriptions FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id);

-- ============================================
-- USAGE_LOGS (1 policy)
-- ============================================

DROP POLICY IF EXISTS "Users can view own usage" ON usage_logs;
CREATE POLICY "Users can view own usage"
  ON usage_logs FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id);

-- ============================================
-- AGENTS (4 policies)
-- ============================================

DROP POLICY IF EXISTS "Users can view own agents" ON agents;
CREATE POLICY "Users can view own agents"
  ON agents FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can insert own agents" ON agents;
CREATE POLICY "Users can insert own agents"
  ON agents FOR INSERT
  TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own agents" ON agents;
CREATE POLICY "Users can update own agents"
  ON agents FOR UPDATE
  TO authenticated
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete own agents" ON agents;
CREATE POLICY "Users can delete own agents"
  ON agents FOR DELETE
  TO authenticated
  USING ((select auth.uid()) = user_id);

-- ============================================
-- SCHEDULED_POSTS (4 policies)
-- ============================================

DROP POLICY IF EXISTS "Users can view own scheduled posts" ON scheduled_posts;
CREATE POLICY "Users can view own scheduled posts"
  ON scheduled_posts FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can insert own scheduled posts" ON scheduled_posts;
CREATE POLICY "Users can insert own scheduled posts"
  ON scheduled_posts FOR INSERT
  TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own scheduled posts" ON scheduled_posts;
CREATE POLICY "Users can update own scheduled posts"
  ON scheduled_posts FOR UPDATE
  TO authenticated
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete own scheduled posts" ON scheduled_posts;
CREATE POLICY "Users can delete own scheduled posts"
  ON scheduled_posts FOR DELETE
  TO authenticated
  USING ((select auth.uid()) = user_id);

-- ============================================
-- PUBLISHED_POSTS (4 policies)
-- ============================================

DROP POLICY IF EXISTS "Users can view own published posts" ON published_posts;
CREATE POLICY "Users can view own published posts"
  ON published_posts FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can insert own published posts" ON published_posts;
CREATE POLICY "Users can insert own published posts"
  ON published_posts FOR INSERT
  TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own published posts" ON published_posts;
CREATE POLICY "Users can update own published posts"
  ON published_posts FOR UPDATE
  TO authenticated
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete own published posts" ON published_posts;
CREATE POLICY "Users can delete own published posts"
  ON published_posts FOR DELETE
  TO authenticated
  USING ((select auth.uid()) = user_id);

-- ============================================
-- ANALYTICS_REPORTS (2 policies)
-- ============================================

DROP POLICY IF EXISTS "Users can view own analytics" ON analytics_reports;
CREATE POLICY "Users can view own analytics"
  ON analytics_reports FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can insert own analytics" ON analytics_reports;
CREATE POLICY "Users can insert own analytics"
  ON analytics_reports FOR INSERT
  TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

-- ============================================
-- AUTOMATION_LOGS (1 policy)
-- ============================================

DROP POLICY IF EXISTS "Users can view own automation logs" ON automation_logs;
CREATE POLICY "Users can view own automation logs"
  ON automation_logs FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id);

-- ============================================
-- WHATSAPP_PENDING_CONNECTIONS (4 policies)
-- ============================================

DROP POLICY IF EXISTS "Users can view own pending connections" ON whatsapp_pending_connections;
CREATE POLICY "Users can view own pending connections"
  ON whatsapp_pending_connections FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can insert own pending connections" ON whatsapp_pending_connections;
CREATE POLICY "Users can insert own pending connections"
  ON whatsapp_pending_connections FOR INSERT
  TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own pending connections" ON whatsapp_pending_connections;
CREATE POLICY "Users can update own pending connections"
  ON whatsapp_pending_connections FOR UPDATE
  TO authenticated
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete own pending connections" ON whatsapp_pending_connections;
CREATE POLICY "Users can delete own pending connections"
  ON whatsapp_pending_connections FOR DELETE
  TO authenticated
  USING ((select auth.uid()) = user_id);

-- ============================================
-- AGENT_ARTICLE_USAGE (1 policy)
-- ============================================

DROP POLICY IF EXISTS "Users can manage their own agents article usage" ON agent_article_usage;
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

-- ============================================
-- PLAN_INTEREST (2 policies)
-- ============================================

DROP POLICY IF EXISTS "Users can insert their own interest" ON plan_interest;
CREATE POLICY "Users can insert their own interest" ON plan_interest
  FOR INSERT
  WITH CHECK ((select auth.uid()) = user_id OR user_id IS NULL);

DROP POLICY IF EXISTS "Service role can read all" ON plan_interest;
CREATE POLICY "Service role can read all" ON plan_interest
  FOR SELECT
  USING ((select auth.role()) = 'service_role');

COMMIT;
