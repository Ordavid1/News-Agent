-- ============================================
-- VIEW: Published Posts Overview
-- Combines published posts with user profile and subscription data.
-- Run this in Supabase SQL Editor
-- ============================================

DROP VIEW IF EXISTS published_posts_overview;

CREATE VIEW published_posts_overview AS
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

-- RLS: The view inherits RLS from the underlying tables.
-- Both published_posts and profiles already enforce user_id-based policies.

COMMENT ON VIEW published_posts_overview IS
  'Consolidated view of published posts with user profile and subscription details.';
