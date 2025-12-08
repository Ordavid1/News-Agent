-- ============================================
-- ADDITIONAL TABLES FOR AUTOMATION MANAGER
-- Run this in Supabase SQL Editor after schema.sql
-- ============================================

-- ============================================
-- SCHEDULED POSTS (for automation queue)
-- ============================================
CREATE TABLE IF NOT EXISTS public.scheduled_posts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Trend data (JSONB to store trend object)
  trend JSONB NOT NULL,

  -- Content (JSONB to store generated posts)
  content JSONB NOT NULL,

  -- Target platforms
  platforms TEXT[] NOT NULL,

  -- Scheduling
  scheduled_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Status
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'partial_failure', 'failed')),
  error TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- PUBLISHED POSTS (for automation tracking)
-- ============================================
CREATE TABLE IF NOT EXISTS public.published_posts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Reference to scheduled post
  scheduled_post_id UUID REFERENCES scheduled_posts(id) ON DELETE SET NULL,

  -- Trend data
  trend JSONB,
  trend_topic TEXT,
  topic TEXT,

  -- Platform info
  platform TEXT NOT NULL,
  platform_post_id TEXT,
  platform_url TEXT,

  -- Content
  content TEXT,

  -- Status
  success BOOLEAN DEFAULT TRUE,
  error TEXT,

  -- Engagement metrics
  engagement JSONB DEFAULT '{}',

  published_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- TREND HISTORY (for duplicate prevention)
-- ============================================
CREATE TABLE IF NOT EXISTS public.trend_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Trend identification
  topic TEXT NOT NULL,
  title TEXT,

  -- Source info
  sources TEXT[],
  source_api TEXT,

  -- Metadata
  score NUMERIC,
  category TEXT,
  url TEXT,

  detected_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- AUTOMATION LOGS (for error tracking)
-- ============================================
CREATE TABLE IF NOT EXISTS public.automation_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Log type
  type TEXT NOT NULL CHECK (type IN ('info', 'warning', 'error', 'success')),

  -- Error details
  error_message TEXT,
  error_stack TEXT,
  error_name TEXT,

  -- Context
  context TEXT,
  metadata JSONB DEFAULT '{}',

  timestamp TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- ANALYTICS REPORTS (for daily summaries)
-- ============================================
CREATE TABLE IF NOT EXISTS public.analytics_reports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Report date
  date DATE NOT NULL,

  -- Summary data
  total_posts INTEGER DEFAULT 0,
  platforms JSONB DEFAULT '{}',
  trends_used TEXT[],
  success_rate NUMERIC DEFAULT 0,

  -- Additional metrics
  metrics JSONB DEFAULT '{}',

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_status ON scheduled_posts(status);
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_scheduled_time ON scheduled_posts(scheduled_time);
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_created_at ON scheduled_posts(created_at);

CREATE INDEX IF NOT EXISTS idx_published_posts_platform ON published_posts(platform);
CREATE INDEX IF NOT EXISTS idx_published_posts_published_at ON published_posts(published_at);
CREATE INDEX IF NOT EXISTS idx_published_posts_topic ON published_posts(topic);

CREATE INDEX IF NOT EXISTS idx_trend_history_topic ON trend_history(topic);
CREATE INDEX IF NOT EXISTS idx_trend_history_detected_at ON trend_history(detected_at);

CREATE INDEX IF NOT EXISTS idx_automation_logs_type ON automation_logs(type);
CREATE INDEX IF NOT EXISTS idx_automation_logs_timestamp ON automation_logs(timestamp);

CREATE INDEX IF NOT EXISTS idx_analytics_reports_date ON analytics_reports(date);

-- ============================================
-- GRANT PERMISSIONS (service role access)
-- ============================================
GRANT ALL ON public.scheduled_posts TO service_role;
GRANT ALL ON public.published_posts TO service_role;
GRANT ALL ON public.trend_history TO service_role;
GRANT ALL ON public.automation_logs TO service_role;
GRANT ALL ON public.analytics_reports TO service_role;
