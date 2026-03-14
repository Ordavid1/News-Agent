-- ============================================
-- ALIEXPRESS AFFILIATE TABLES
-- Run this in Supabase SQL Editor
-- ============================================
-- These tables support the AE Affiliate add-on feature:
-- Affiliate product search, keyword-based automation,
-- affiliate link generation, and auto-posting to WhatsApp & Telegram.

-- ============================================
-- 1. AFFILIATE ADD-ONS (Subscription tracking)
-- ============================================
CREATE TABLE IF NOT EXISTS public.affiliate_addons (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'expired', 'past_due')),
  ls_subscription_id TEXT UNIQUE,
  ls_variant_id TEXT,
  plan TEXT NOT NULL DEFAULT 'standard' CHECK (plan IN ('standard', 'premium')),
  monthly_price INTEGER NOT NULL DEFAULT 0,
  max_keyword_sets INTEGER DEFAULT 5,
  max_products_per_day INTEGER DEFAULT 20,
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

COMMENT ON TABLE public.affiliate_addons IS 'Tracks AE Affiliate add-on subscriptions. Any paid tier user can purchase affiliate product automation capabilities.';

CREATE INDEX IF NOT EXISTS idx_affiliate_addons_user_id ON affiliate_addons(user_id);
CREATE INDEX IF NOT EXISTS idx_affiliate_addons_status ON affiliate_addons(status);
CREATE INDEX IF NOT EXISTS idx_affiliate_addons_ls_sub ON affiliate_addons(ls_subscription_id);

ALTER TABLE affiliate_addons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own affiliate addon" ON affiliate_addons;
CREATE POLICY "Users can view own affiliate addon"
  ON affiliate_addons FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can insert own affiliate addon" ON affiliate_addons;
CREATE POLICY "Users can insert own affiliate addon"
  ON affiliate_addons FOR INSERT
  TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own affiliate addon" ON affiliate_addons;
CREATE POLICY "Users can update own affiliate addon"
  ON affiliate_addons FOR UPDATE
  TO authenticated
  USING ((select auth.uid()) = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.affiliate_addons TO authenticated;
GRANT ALL ON public.affiliate_addons TO service_role;

-- ============================================
-- 2. AFFILIATE CREDENTIALS (Encrypted AE API keys)
-- ============================================
CREATE TABLE IF NOT EXISTS public.affiliate_credentials (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL DEFAULT 'aliexpress' CHECK (platform IN ('aliexpress')),
  app_key TEXT NOT NULL,
  app_secret TEXT NOT NULL,
  tracking_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error', 'invalid')),
  last_error TEXT,
  last_validated_at TIMESTAMPTZ,
  api_calls_today INTEGER DEFAULT 0,
  api_calls_reset_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, platform)
);

COMMENT ON TABLE public.affiliate_credentials IS 'Stores encrypted AliExpress API credentials per user. app_key, app_secret, and tracking_id are AES-256-GCM encrypted.';

CREATE INDEX IF NOT EXISTS idx_affiliate_credentials_user_id ON affiliate_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_affiliate_credentials_status ON affiliate_credentials(status);

ALTER TABLE affiliate_credentials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own affiliate credentials" ON affiliate_credentials;
CREATE POLICY "Users can view own affiliate credentials"
  ON affiliate_credentials FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can insert own affiliate credentials" ON affiliate_credentials;
CREATE POLICY "Users can insert own affiliate credentials"
  ON affiliate_credentials FOR INSERT
  TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own affiliate credentials" ON affiliate_credentials;
CREATE POLICY "Users can update own affiliate credentials"
  ON affiliate_credentials FOR UPDATE
  TO authenticated
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete own affiliate credentials" ON affiliate_credentials;
CREATE POLICY "Users can delete own affiliate credentials"
  ON affiliate_credentials FOR DELETE
  TO authenticated
  USING ((select auth.uid()) = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.affiliate_credentials TO authenticated;
GRANT ALL ON public.affiliate_credentials TO service_role;

-- ============================================
-- 3. AFFILIATE KEYWORDS (Product search configs)
-- ============================================
CREATE TABLE IF NOT EXISTS public.affiliate_keywords (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Default',
  keywords TEXT[] NOT NULL,
  category TEXT,
  min_price DECIMAL(12,2),
  max_price DECIMAL(12,2),
  min_commission_rate DECIMAL(5,2),
  min_rating DECIMAL(3,1),
  min_orders INTEGER,
  sort_by TEXT DEFAULT 'commission_rate' CHECK (sort_by IN ('commission_rate', 'volume', 'price_asc', 'price_desc', 'rating')),
  target_currency TEXT DEFAULT 'USD',
  is_active BOOLEAN DEFAULT TRUE,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE public.affiliate_keywords IS 'Keyword sets with filters for AliExpress product searches. Each set defines search terms and product quality/price filters.';

CREATE INDEX IF NOT EXISTS idx_affiliate_keywords_user_id ON affiliate_keywords(user_id);
CREATE INDEX IF NOT EXISTS idx_affiliate_keywords_active ON affiliate_keywords(user_id, is_active) WHERE is_active = TRUE;

ALTER TABLE affiliate_keywords ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own affiliate keywords" ON affiliate_keywords;
CREATE POLICY "Users can view own affiliate keywords"
  ON affiliate_keywords FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can insert own affiliate keywords" ON affiliate_keywords;
CREATE POLICY "Users can insert own affiliate keywords"
  ON affiliate_keywords FOR INSERT
  TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own affiliate keywords" ON affiliate_keywords;
CREATE POLICY "Users can update own affiliate keywords"
  ON affiliate_keywords FOR UPDATE
  TO authenticated
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete own affiliate keywords" ON affiliate_keywords;
CREATE POLICY "Users can delete own affiliate keywords"
  ON affiliate_keywords FOR DELETE
  TO authenticated
  USING ((select auth.uid()) = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.affiliate_keywords TO authenticated;
GRANT ALL ON public.affiliate_keywords TO service_role;

-- ============================================
-- 4. AFFILIATE PUBLISHED PRODUCTS (Dedup tracking)
-- ============================================
CREATE TABLE IF NOT EXISTS public.affiliate_published_products (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('whatsapp', 'telegram')),
  product_title TEXT,
  product_url TEXT,
  affiliate_url TEXT,
  commission_rate DECIMAL(5,2),
  sale_price DECIMAL(12,2),
  image_url TEXT,
  keyword_set_id UUID REFERENCES affiliate_keywords(id) ON DELETE SET NULL,
  published_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}',
  UNIQUE(agent_id, product_id, platform)
);

COMMENT ON TABLE public.affiliate_published_products IS 'Tracks which products have been published to which agent/platform for deduplication. Prevents resharing the same product within a configurable window.';

CREATE INDEX IF NOT EXISTS idx_affiliate_published_user_id ON affiliate_published_products(user_id);
CREATE INDEX IF NOT EXISTS idx_affiliate_published_agent ON affiliate_published_products(agent_id);
CREATE INDEX IF NOT EXISTS idx_affiliate_published_product ON affiliate_published_products(product_id);
CREATE INDEX IF NOT EXISTS idx_affiliate_published_date ON affiliate_published_products(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_affiliate_published_agent_date ON affiliate_published_products(agent_id, published_at DESC);

ALTER TABLE affiliate_published_products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own published products" ON affiliate_published_products;
CREATE POLICY "Users can view own published products"
  ON affiliate_published_products FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can insert own published products" ON affiliate_published_products;
CREATE POLICY "Users can insert own published products"
  ON affiliate_published_products FOR INSERT
  TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

GRANT SELECT, INSERT ON public.affiliate_published_products TO authenticated;
GRANT ALL ON public.affiliate_published_products TO service_role;

-- ============================================
-- HELPER FUNCTIONS
-- ============================================

-- Function to clean up old published product records (keep 90 days by default)
CREATE OR REPLACE FUNCTION cleanup_old_affiliate_products(days_to_keep INTEGER DEFAULT 90)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  DELETE FROM public.affiliate_published_products
  WHERE published_at < NOW() - (days_to_keep || ' days')::INTERVAL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION cleanup_old_affiliate_products(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION cleanup_old_affiliate_products(INTEGER) TO authenticated;

-- Function to reset daily API call counters
CREATE OR REPLACE FUNCTION reset_affiliate_api_counters()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE public.affiliate_credentials
  SET api_calls_today = 0,
      api_calls_reset_at = NOW()
  WHERE api_calls_reset_at < NOW() - INTERVAL '24 hours';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION reset_affiliate_api_counters() TO service_role;
GRANT EXECUTE ON FUNCTION reset_affiliate_api_counters() TO authenticated;
