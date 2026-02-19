-- ============================================
-- META MARKETING API TABLES
-- Run this in Supabase SQL Editor
-- ============================================
-- These tables support the Marketing add-on feature:
-- Post boosting, campaign management, audience targeting,
-- auto-boost rules, and performance metrics for Facebook & Instagram ads.

-- ============================================
-- 1. MARKETING ADD-ONS (Subscription tracking)
-- ============================================
CREATE TABLE IF NOT EXISTS public.marketing_addons (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'expired', 'past_due')),
  ls_subscription_id TEXT UNIQUE,
  ls_variant_id TEXT,
  plan TEXT NOT NULL DEFAULT 'standard' CHECK (plan IN ('standard', 'premium')),
  monthly_price INTEGER NOT NULL DEFAULT 0,
  max_ad_accounts INTEGER DEFAULT 1,
  max_active_campaigns INTEGER DEFAULT 10,
  max_audience_templates INTEGER DEFAULT 20,
  max_auto_boost_rules INTEGER DEFAULT 10,
  monthly_ad_budget_cap DECIMAL(12,2),
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

COMMENT ON TABLE public.marketing_addons IS 'Tracks marketing add-on subscriptions. Any paid tier user can purchase marketing capabilities.';

CREATE INDEX IF NOT EXISTS idx_marketing_addons_user_id ON marketing_addons(user_id);
CREATE INDEX IF NOT EXISTS idx_marketing_addons_status ON marketing_addons(status);
CREATE INDEX IF NOT EXISTS idx_marketing_addons_ls_sub ON marketing_addons(ls_subscription_id);

ALTER TABLE marketing_addons ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own marketing addon"
  ON marketing_addons FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own marketing addon"
  ON marketing_addons FOR INSERT
  TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own marketing addon"
  ON marketing_addons FOR UPDATE
  TO authenticated
  USING ((select auth.uid()) = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketing_addons TO authenticated;
GRANT ALL ON public.marketing_addons TO service_role;

-- ============================================
-- 2. AD ACCOUNTS
-- ============================================
CREATE TABLE IF NOT EXISTS public.ad_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL DEFAULT 'facebook' CHECK (platform IN ('facebook', 'instagram')),
  account_id TEXT NOT NULL,
  account_name TEXT,
  account_status INTEGER DEFAULT 1,
  currency TEXT DEFAULT 'USD',
  timezone_name TEXT,
  business_id TEXT,
  is_selected BOOLEAN DEFAULT FALSE,
  metadata JSONB DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error', 'disconnected')),
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, account_id)
);

COMMENT ON TABLE public.ad_accounts IS 'Stores Facebook/Instagram Ad Account information per user. Users may have multiple ad accounts but select one as active.';

CREATE INDEX IF NOT EXISTS idx_ad_accounts_user_id ON ad_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_ad_accounts_account_id ON ad_accounts(account_id);
CREATE INDEX IF NOT EXISTS idx_ad_accounts_user_selected ON ad_accounts(user_id, is_selected) WHERE is_selected = TRUE;

ALTER TABLE ad_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own ad accounts"
  ON ad_accounts FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own ad accounts"
  ON ad_accounts FOR INSERT
  TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own ad accounts"
  ON ad_accounts FOR UPDATE
  TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own ad accounts"
  ON ad_accounts FOR DELETE
  TO authenticated
  USING ((select auth.uid()) = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ad_accounts TO authenticated;
GRANT ALL ON public.ad_accounts TO service_role;

-- ============================================
-- 3. MARKETING CAMPAIGNS
-- ============================================
CREATE TABLE IF NOT EXISTS public.marketing_campaigns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ad_account_id UUID NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
  fb_campaign_id TEXT,
  name TEXT NOT NULL,
  objective TEXT NOT NULL CHECK (objective IN (
    'OUTCOME_ENGAGEMENT', 'OUTCOME_TRAFFIC', 'OUTCOME_AWARENESS',
    'OUTCOME_LEADS', 'OUTCOME_SALES', 'OUTCOME_APP_PROMOTION'
  )),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'completed', 'error', 'archived')),
  fb_status TEXT,
  platforms TEXT[] DEFAULT '{facebook}',
  daily_budget DECIMAL(12,2),
  lifetime_budget DECIMAL(12,2),
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  -- Aggregated metrics (synced periodically from Meta API)
  total_spend DECIMAL(12,2) DEFAULT 0,
  total_impressions BIGINT DEFAULT 0,
  total_reach BIGINT DEFAULT 0,
  total_clicks BIGINT DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  last_metrics_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE public.marketing_campaigns IS 'Marketing campaigns created via Meta Marketing API. Each campaign belongs to an ad account and contains ad sets.';

CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_user_id ON marketing_campaigns(user_id);
CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_ad_account ON marketing_campaigns(ad_account_id);
CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_fb_id ON marketing_campaigns(fb_campaign_id);
CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_status ON marketing_campaigns(status);
CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_user_status ON marketing_campaigns(user_id, status);

ALTER TABLE marketing_campaigns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own campaigns"
  ON marketing_campaigns FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own campaigns"
  ON marketing_campaigns FOR INSERT
  TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own campaigns"
  ON marketing_campaigns FOR UPDATE
  TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own campaigns"
  ON marketing_campaigns FOR DELETE
  TO authenticated
  USING ((select auth.uid()) = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketing_campaigns TO authenticated;
GRANT ALL ON public.marketing_campaigns TO service_role;

-- ============================================
-- 4. MARKETING AD SETS
-- ============================================
CREATE TABLE IF NOT EXISTS public.marketing_ad_sets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id UUID NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fb_adset_id TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'completed', 'error', 'archived')),
  fb_status TEXT,
  targeting JSONB NOT NULL DEFAULT '{}',
  placements JSONB DEFAULT '{}',
  billing_event TEXT DEFAULT 'IMPRESSIONS' CHECK (billing_event IN ('IMPRESSIONS', 'LINK_CLICKS', 'POST_ENGAGEMENT')),
  bid_strategy TEXT DEFAULT 'LOWEST_COST_WITHOUT_CAP' CHECK (bid_strategy IN (
    'LOWEST_COST_WITHOUT_CAP', 'LOWEST_COST_WITH_BID_CAP', 'COST_CAP', 'MINIMUM_ROAS'
  )),
  bid_amount DECIMAL(12,2),
  daily_budget DECIMAL(12,2),
  lifetime_budget DECIMAL(12,2),
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  -- Metrics (synced periodically)
  spend DECIMAL(12,2) DEFAULT 0,
  impressions BIGINT DEFAULT 0,
  reach BIGINT DEFAULT 0,
  clicks BIGINT DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  last_metrics_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE public.marketing_ad_sets IS 'Ad sets within campaigns. Each ad set defines targeting, budget, and placement configuration.';

CREATE INDEX IF NOT EXISTS idx_marketing_ad_sets_campaign ON marketing_ad_sets(campaign_id);
CREATE INDEX IF NOT EXISTS idx_marketing_ad_sets_user_id ON marketing_ad_sets(user_id);
CREATE INDEX IF NOT EXISTS idx_marketing_ad_sets_fb_id ON marketing_ad_sets(fb_adset_id);
CREATE INDEX IF NOT EXISTS idx_marketing_ad_sets_status ON marketing_ad_sets(status);

ALTER TABLE marketing_ad_sets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own ad sets"
  ON marketing_ad_sets FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own ad sets"
  ON marketing_ad_sets FOR INSERT
  TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own ad sets"
  ON marketing_ad_sets FOR UPDATE
  TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own ad sets"
  ON marketing_ad_sets FOR DELETE
  TO authenticated
  USING ((select auth.uid()) = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketing_ad_sets TO authenticated;
GRANT ALL ON public.marketing_ad_sets TO service_role;

-- ============================================
-- 5. MARKETING ADS
-- ============================================
CREATE TABLE IF NOT EXISTS public.marketing_ads (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ad_set_id UUID NOT NULL REFERENCES marketing_ad_sets(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fb_ad_id TEXT,
  fb_creative_id TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'completed', 'error', 'archived')),
  fb_status TEXT,
  -- Link to source organic post
  source_published_post_id UUID,
  platform_post_id TEXT,
  source_platform TEXT CHECK (source_platform IN ('facebook', 'instagram')),
  creative_type TEXT DEFAULT 'existing_post' CHECK (creative_type IN ('existing_post', 'custom')),
  creative_data JSONB DEFAULT '{}',
  -- Metrics (synced periodically)
  spend DECIMAL(12,2) DEFAULT 0,
  impressions BIGINT DEFAULT 0,
  reach BIGINT DEFAULT 0,
  clicks BIGINT DEFAULT 0,
  ctr DECIMAL(8,4) DEFAULT 0,
  cpc DECIMAL(8,4) DEFAULT 0,
  cpm DECIMAL(8,4) DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  last_metrics_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE public.marketing_ads IS 'Individual ads that link ad creatives to ad sets. Each ad references an organic post being promoted.';

CREATE INDEX IF NOT EXISTS idx_marketing_ads_ad_set ON marketing_ads(ad_set_id);
CREATE INDEX IF NOT EXISTS idx_marketing_ads_user_id ON marketing_ads(user_id);
CREATE INDEX IF NOT EXISTS idx_marketing_ads_fb_id ON marketing_ads(fb_ad_id);
CREATE INDEX IF NOT EXISTS idx_marketing_ads_status ON marketing_ads(status);
CREATE INDEX IF NOT EXISTS idx_marketing_ads_source_post ON marketing_ads(source_published_post_id);

ALTER TABLE marketing_ads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own ads"
  ON marketing_ads FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own ads"
  ON marketing_ads FOR INSERT
  TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own ads"
  ON marketing_ads FOR UPDATE
  TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own ads"
  ON marketing_ads FOR DELETE
  TO authenticated
  USING ((select auth.uid()) = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketing_ads TO authenticated;
GRANT ALL ON public.marketing_ads TO service_role;

-- ============================================
-- 6. AUDIENCE TEMPLATES
-- ============================================
CREATE TABLE IF NOT EXISTS public.audience_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  targeting JSONB NOT NULL DEFAULT '{}',
  platforms TEXT[] DEFAULT '{facebook,instagram}',
  estimated_reach BIGINT,
  is_default BOOLEAN DEFAULT FALSE,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE public.audience_templates IS 'Reusable audience targeting templates. Users can save and reuse targeting configurations across campaigns and boosts.';

CREATE INDEX IF NOT EXISTS idx_audience_templates_user_id ON audience_templates(user_id);
CREATE INDEX IF NOT EXISTS idx_audience_templates_user_default ON audience_templates(user_id, is_default) WHERE is_default = TRUE;

ALTER TABLE audience_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own audience templates"
  ON audience_templates FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own audience templates"
  ON audience_templates FOR INSERT
  TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own audience templates"
  ON audience_templates FOR UPDATE
  TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own audience templates"
  ON audience_templates FOR DELETE
  TO authenticated
  USING ((select auth.uid()) = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.audience_templates TO authenticated;
GRANT ALL ON public.audience_templates TO service_role;

-- ============================================
-- 7. MARKETING RULES (Auto-Boost)
-- ============================================
CREATE TABLE IF NOT EXISTS public.marketing_rules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  rule_type TEXT NOT NULL CHECK (rule_type IN ('auto_boost', 'pause_if', 'budget_adjust')),
  conditions JSONB NOT NULL DEFAULT '{}',
  actions JSONB NOT NULL DEFAULT '{}',
  applies_to JSONB DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disabled')),
  last_triggered_at TIMESTAMPTZ,
  trigger_count INTEGER DEFAULT 0,
  cooldown_hours INTEGER DEFAULT 24,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE public.marketing_rules IS 'Automated marketing rules. Supports auto-boost (promote high-performing organic posts), budget adjustments, and conditional pausing.';

CREATE INDEX IF NOT EXISTS idx_marketing_rules_user_id ON marketing_rules(user_id);
CREATE INDEX IF NOT EXISTS idx_marketing_rules_status ON marketing_rules(status);
CREATE INDEX IF NOT EXISTS idx_marketing_rules_type ON marketing_rules(rule_type);

ALTER TABLE marketing_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own marketing rules"
  ON marketing_rules FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own marketing rules"
  ON marketing_rules FOR INSERT
  TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own marketing rules"
  ON marketing_rules FOR UPDATE
  TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own marketing rules"
  ON marketing_rules FOR DELETE
  TO authenticated
  USING ((select auth.uid()) = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketing_rules TO authenticated;
GRANT ALL ON public.marketing_rules TO service_role;

-- ============================================
-- 8. MARKETING RULE TRIGGER HISTORY
-- ============================================
CREATE TABLE IF NOT EXISTS public.marketing_rule_triggers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  rule_id UUID NOT NULL REFERENCES marketing_rules(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  published_post_id UUID,
  platform TEXT,
  action_taken JSONB NOT NULL DEFAULT '{}',
  result JSONB DEFAULT '{}',
  success BOOLEAN DEFAULT TRUE,
  error_message TEXT,
  triggered_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE public.marketing_rule_triggers IS 'History of auto-boost and marketing rule triggers. Tracks what action was taken, for which post, and the result.';

CREATE INDEX IF NOT EXISTS idx_rule_triggers_rule_id ON marketing_rule_triggers(rule_id);
CREATE INDEX IF NOT EXISTS idx_rule_triggers_user_id ON marketing_rule_triggers(user_id);
CREATE INDEX IF NOT EXISTS idx_rule_triggers_triggered_at ON marketing_rule_triggers(triggered_at DESC);

ALTER TABLE marketing_rule_triggers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own rule triggers"
  ON marketing_rule_triggers FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own rule triggers"
  ON marketing_rule_triggers FOR INSERT
  TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

GRANT SELECT, INSERT ON public.marketing_rule_triggers TO authenticated;
GRANT ALL ON public.marketing_rule_triggers TO service_role;

-- ============================================
-- 9. MARKETING METRICS HISTORY (Time-series)
-- ============================================
CREATE TABLE IF NOT EXISTS public.marketing_metrics_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('campaign', 'ad_set', 'ad')),
  entity_id UUID NOT NULL,
  fb_entity_id TEXT NOT NULL,
  date DATE NOT NULL,
  spend DECIMAL(12,2) DEFAULT 0,
  impressions BIGINT DEFAULT 0,
  reach BIGINT DEFAULT 0,
  clicks BIGINT DEFAULT 0,
  ctr DECIMAL(8,4) DEFAULT 0,
  cpc DECIMAL(8,4) DEFAULT 0,
  cpm DECIMAL(8,4) DEFAULT 0,
  additional_metrics JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(entity_id, date)
);

COMMENT ON TABLE public.marketing_metrics_history IS 'Daily time-series metrics for campaigns, ad sets, and ads. Synced periodically from Meta Marketing API.';

CREATE INDEX IF NOT EXISTS idx_metrics_history_user_id ON marketing_metrics_history(user_id);
CREATE INDEX IF NOT EXISTS idx_metrics_history_entity ON marketing_metrics_history(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_metrics_history_date ON marketing_metrics_history(date DESC);
CREATE INDEX IF NOT EXISTS idx_metrics_history_entity_date ON marketing_metrics_history(entity_id, date DESC);

ALTER TABLE marketing_metrics_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own metrics history"
  ON marketing_metrics_history FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own metrics history"
  ON marketing_metrics_history FOR INSERT
  TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own metrics history"
  ON marketing_metrics_history FOR UPDATE
  TO authenticated
  USING ((select auth.uid()) = user_id);

GRANT SELECT, INSERT, UPDATE ON public.marketing_metrics_history TO authenticated;
GRANT ALL ON public.marketing_metrics_history TO service_role;

-- ============================================
-- HELPER FUNCTIONS
-- ============================================

-- Function to clean up old metrics history (keep 90 days by default)
CREATE OR REPLACE FUNCTION cleanup_old_marketing_metrics(days_to_keep INTEGER DEFAULT 90)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  DELETE FROM public.marketing_metrics_history
  WHERE date < CURRENT_DATE - days_to_keep;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION cleanup_old_marketing_metrics(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION cleanup_old_marketing_metrics(INTEGER) TO authenticated;

-- Function to clean up old rule trigger history (keep 30 days by default)
CREATE OR REPLACE FUNCTION cleanup_old_rule_triggers(days_to_keep INTEGER DEFAULT 30)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  DELETE FROM public.marketing_rule_triggers
  WHERE triggered_at < NOW() - (days_to_keep || ' days')::INTERVAL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION cleanup_old_rule_triggers(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION cleanup_old_rule_triggers(INTEGER) TO authenticated;
