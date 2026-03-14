/**
 * Analytics Service
 *
 * Provides SQL-level aggregation queries for the analytics dashboard.
 * All computations are done at the database level where possible,
 * with minimal client-side aggregation on small, filtered result sets.
 */

import { supabaseAdmin } from './supabase.js';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()]
});

// ============================================
// HELPERS
// ============================================

/**
 * Convert a period string to a date range
 */
function periodToDateRange(period) {
  const end = new Date();
  let start;
  switch (period) {
    case '7d':  start = new Date(end.getTime() - 7 * 86400000); break;
    case '30d': start = new Date(end.getTime() - 30 * 86400000); break;
    case '90d': start = new Date(end.getTime() - 90 * 86400000); break;
    case 'all': start = new Date(0); break;
    default:    start = new Date(end.getTime() - 30 * 86400000);
  }
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * Get previous period range for period-over-period comparison
 */
function getPreviousPeriodRange(period) {
  const current = periodToDateRange(period);
  const currentStart = new Date(current.start);
  const currentEnd = new Date(current.end);
  const durationMs = currentEnd.getTime() - currentStart.getTime();
  const prevStart = new Date(currentStart.getTime() - durationMs);
  return { start: prevStart.toISOString(), end: current.start };
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ============================================
// 1. OVERVIEW KPIs
// ============================================

export async function getOverviewAnalytics(userId, period = '30d') {
  const { start, end } = periodToDateRange(period);
  const prev = getPreviousPeriodRange(period);

  // Run all queries in parallel
  const [
    totalResult,
    successResult,
    failedResult,
    prevPeriodResult,
    platformResult,
    scheduledResult
  ] = await Promise.all([
    // Total published posts in period
    supabaseAdmin
      .from('published_posts')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('published_at', start)
      .lte('published_at', end),

    // Successful posts in period
    supabaseAdmin
      .from('published_posts')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('success', true)
      .gte('published_at', start)
      .lte('published_at', end),

    // Failed posts in period
    supabaseAdmin
      .from('published_posts')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('success', false)
      .gte('published_at', start)
      .lte('published_at', end),

    // Previous period total (for growth calculation)
    period !== 'all' ? supabaseAdmin
      .from('published_posts')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('published_at', prev.start)
      .lt('published_at', prev.end)
      : Promise.resolve({ count: null }),

    // Distinct platforms used in period
    supabaseAdmin
      .from('published_posts')
      .select('platform')
      .eq('user_id', userId)
      .eq('success', true)
      .gte('published_at', start)
      .lte('published_at', end),

    // Pending scheduled posts
    supabaseAdmin
      .from('posts')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .in('status', ['pending', 'scheduled'])
  ]);

  const totalPublished = totalResult.count || 0;
  const successCount = successResult.count || 0;
  const failedCount = failedResult.count || 0;
  const prevPeriodCount = prevPeriodResult.count;

  // Calculate platform breakdown for top platform
  const platformCounts = {};
  (platformResult.data || []).forEach(row => {
    platformCounts[row.platform] = (platformCounts[row.platform] || 0) + 1;
  });

  const platforms = Object.entries(platformCounts);
  const topPlatform = platforms.length > 0
    ? platforms.reduce((a, b) => a[1] > b[1] ? a : b)[0]
    : null;

  // Growth calculation
  let periodGrowthPercent = null;
  if (prevPeriodCount !== null && prevPeriodCount > 0) {
    periodGrowthPercent = parseFloat(((totalPublished - prevPeriodCount) / prevPeriodCount * 100).toFixed(1));
  } else if (prevPeriodCount === 0 && totalPublished > 0) {
    periodGrowthPercent = 100;
  }

  return {
    kpis: {
      totalPublished,
      successRate: totalPublished > 0 ? parseFloat((successCount / totalPublished * 100).toFixed(1)) : 0,
      activePlatforms: Object.keys(platformCounts).length,
      topPlatform,
      postsThisPeriod: totalPublished,
      postsLastPeriod: prevPeriodCount,
      periodGrowthPercent,
      failedPosts: failedCount,
      scheduledPending: scheduledResult.count || 0,
      platformBreakdown: platformCounts
    },
    period,
    periodStart: start,
    periodEnd: end
  };
}

// ============================================
// 2. PUBLISHING ACTIVITY
// ============================================

export async function getActivityAnalytics(userId, period = '30d', userTier = 'free') {
  // Free users are capped at 7d
  const effectivePeriod = userTier === 'free' ? '7d' : period;
  const { start, end } = periodToDateRange(effectivePeriod);

  const { data, error } = await supabaseAdmin
    .from('published_posts')
    .select('published_at, success')
    .eq('user_id', userId)
    .gte('published_at', start)
    .lte('published_at', end)
    .order('published_at', { ascending: true });

  if (error) {
    logger.error('Error fetching activity analytics:', error);
    throw error;
  }

  const posts = data || [];

  // Group by date
  const dailyMap = {};
  const hourCounts = new Array(24).fill(0);
  const dayCounts = new Array(7).fill(0);

  posts.forEach(post => {
    const date = new Date(post.published_at);
    const dateKey = date.toISOString().split('T')[0];

    if (!dailyMap[dateKey]) {
      dailyMap[dateKey] = { date: dateKey, published: 0, failed: 0 };
    }

    if (post.success) {
      dailyMap[dateKey].published++;
    } else {
      dailyMap[dateKey].failed++;
    }

    hourCounts[date.getUTCHours()]++;
    dayCounts[date.getUTCDay()]++;
  });

  // Fill in missing dates with zeros
  const daily = [];
  const startDate = new Date(start);
  const endDate = new Date(end);
  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    const dateKey = d.toISOString().split('T')[0];
    daily.push(dailyMap[dateKey] || { date: dateKey, published: 0, failed: 0 });
  }

  // Calculate summary stats
  const totalDays = daily.length || 1;
  const totalPosts = posts.length;
  const avgPostsPerDay = parseFloat((totalPosts / totalDays).toFixed(1));

  const mostActiveHourIdx = hourCounts.indexOf(Math.max(...hourCounts));
  const mostActiveDayIdx = dayCounts.indexOf(Math.max(...dayCounts));

  // Calculate publishing streak (consecutive days with posts)
  let streak = 0;
  for (let i = daily.length - 1; i >= 0; i--) {
    if (daily[i].published > 0 || daily[i].failed > 0) {
      streak++;
    } else {
      break;
    }
  }

  const summary = {
    avgPostsPerDay,
    mostActiveDay: DAY_NAMES[mostActiveDayIdx],
    mostActiveHour: mostActiveHourIdx,
    publishingStreak: streak,
    totalPosts
  };

  return {
    daily,
    summary: userTier === 'free' ? { avgPostsPerDay, totalPosts } : summary,
    cappedPeriod: userTier === 'free' ? '7d' : null
  };
}

// ============================================
// 3. PLATFORM PERFORMANCE
// ============================================

export async function getPlatformAnalytics(userId, period = '30d') {
  const { start, end } = periodToDateRange(period);

  const [postsResult, connectionsResult] = await Promise.all([
    supabaseAdmin
      .from('published_posts')
      .select('platform, success, trend_topic, published_at, engagement')
      .eq('user_id', userId)
      .gte('published_at', start)
      .lte('published_at', end),

    supabaseAdmin
      .from('social_connections')
      .select('platform, status, last_used_at, platform_username, token_expires_at')
      .eq('user_id', userId)
  ]);

  if (postsResult.error) {
    logger.error('Error fetching platform analytics:', postsResult.error);
    throw postsResult.error;
  }

  const posts = postsResult.data || [];
  const connections = connectionsResult.data || [];

  // Build connection lookup
  const connectionMap = {};
  connections.forEach(c => {
    connectionMap[c.platform] = {
      status: c.status,
      username: c.platform_username,
      lastUsedAt: c.last_used_at,
      tokenExpiresAt: c.token_expires_at
    };
  });

  // Aggregate by platform
  const platformMap = {};
  const daysInPeriod = Math.max(1, Math.ceil((new Date(end) - new Date(start)) / 86400000));

  posts.forEach(post => {
    if (!platformMap[post.platform]) {
      platformMap[post.platform] = {
        platform: post.platform,
        totalPosts: 0,
        successCount: 0,
        failedCount: 0,
        trendPosts: 0,
        originalPosts: 0,
        lastPostedAt: null,
        engagement: { likes: 0, comments: 0, shares: 0, views: 0 }
      };
    }

    const p = platformMap[post.platform];
    p.totalPosts++;
    if (post.success) p.successCount++;
    else p.failedCount++;

    if (post.trend_topic) p.trendPosts++;
    else p.originalPosts++;

    if (!p.lastPostedAt || new Date(post.published_at) > new Date(p.lastPostedAt)) {
      p.lastPostedAt = post.published_at;
    }

    // Aggregate engagement if available
    if (post.engagement && typeof post.engagement === 'object') {
      p.engagement.likes += post.engagement.likes || 0;
      p.engagement.comments += post.engagement.comments || 0;
      p.engagement.shares += post.engagement.shares || 0;
      p.engagement.views += post.engagement.views || 0;
    }
  });

  // Build response
  const platforms = Object.values(platformMap).map(p => ({
    ...p,
    successRate: p.totalPosts > 0 ? parseFloat((p.successCount / p.totalPosts * 100).toFixed(1)) : 0,
    avgPostsPerDay: parseFloat((p.totalPosts / daysInPeriod).toFixed(1)),
    connectionStatus: connectionMap[p.platform]?.status || 'disconnected',
    connectionUsername: connectionMap[p.platform]?.username || null
  }));

  // Sort by total posts descending
  platforms.sort((a, b) => b.totalPosts - a.totalPosts);

  return { platforms };
}

// ============================================
// 4. AGENT PERFORMANCE
// ============================================

export async function getAgentAnalytics(userId, period = '30d') {
  const { start, end } = periodToDateRange(period);
  const daysInPeriod = Math.max(1, Math.ceil((new Date(end) - new Date(start)) / 86400000));

  const [agentsResult, postsResult] = await Promise.all([
    supabaseAdmin
      .from('agents')
      .select('id, name, platform, status, settings, posts_today, total_posts, last_posted_at, created_at')
      .eq('user_id', userId),

    supabaseAdmin
      .from('published_posts')
      .select('agent_id, success, topic, trend_topic, published_at')
      .eq('user_id', userId)
      .not('agent_id', 'is', null)
      .gte('published_at', start)
      .lte('published_at', end)
  ]);

  if (agentsResult.error) {
    logger.error('Error fetching agent analytics:', agentsResult.error);
    throw agentsResult.error;
  }

  const agents = agentsResult.data || [];
  const posts = postsResult.data || [];

  // Group posts by agent_id
  const postsByAgent = {};
  posts.forEach(post => {
    if (!postsByAgent[post.agent_id]) {
      postsByAgent[post.agent_id] = [];
    }
    postsByAgent[post.agent_id].push(post);
  });

  // Build agent analytics
  const agentAnalytics = agents.map(agent => {
    const agentPosts = postsByAgent[agent.id] || [];
    const successPosts = agentPosts.filter(p => p.success);
    const configuredPostsPerDay = agent.settings?.schedule?.postsPerDay || 1;
    const actualAvgPerDay = parseFloat((agentPosts.length / daysInPeriod).toFixed(1));
    const efficiency = parseFloat(Math.min(100, (actualAvgPerDay / configuredPostsPerDay * 100)).toFixed(1));

    // Extract top topics
    const topicCounts = {};
    agentPosts.forEach(p => {
      const topic = p.topic || p.trend_topic || 'Unknown';
      topicCounts[topic] = (topicCounts[topic] || 0) + 1;
    });
    const topTopics = Object.entries(topicCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([topic]) => topic);

    return {
      id: agent.id,
      name: agent.name,
      platform: agent.platform,
      status: agent.status,
      configuredPostsPerDay,
      actualPostsToday: agent.posts_today || 0,
      totalPostsInPeriod: agentPosts.length,
      successRate: agentPosts.length > 0 ? parseFloat((successPosts.length / agentPosts.length * 100).toFixed(1)) : 0,
      avgPostsPerDay: actualAvgPerDay,
      efficiency,
      topTopics,
      totalPostsAllTime: agent.total_posts || 0,
      lastPostedAt: agent.last_posted_at
    };
  });

  // Summary
  const statusCounts = { active: 0, paused: 0, error: 0 };
  agents.forEach(a => {
    if (statusCounts[a.status] !== undefined) statusCounts[a.status]++;
  });

  const avgEfficiency = agentAnalytics.length > 0
    ? parseFloat((agentAnalytics.reduce((sum, a) => sum + a.efficiency, 0) / agentAnalytics.length).toFixed(1))
    : 0;

  return {
    agents: agentAnalytics,
    summary: {
      totalAgents: agents.length,
      activeAgents: statusCounts.active,
      pausedAgents: statusCounts.paused,
      errorAgents: statusCounts.error,
      overallEfficiency: avgEfficiency
    }
  };
}

// ============================================
// 5. CONTENT & TIMING INSIGHTS
// ============================================

export async function getContentAnalytics(userId, period = '30d') {
  const { start, end } = periodToDateRange(period);

  const { data, error } = await supabaseAdmin
    .from('published_posts')
    .select('topic, trend_topic, content, success, published_at, engagement')
    .eq('user_id', userId)
    .gte('published_at', start)
    .lte('published_at', end);

  if (error) {
    logger.error('Error fetching content analytics:', error);
    throw error;
  }

  const posts = data || [];

  // Topic analysis
  const topicMap = {};
  let trendDriven = 0;
  let originalPosts = 0;
  let trendSuccess = 0;
  let trendTotal = 0;
  let originalSuccess = 0;
  let originalTotal = 0;

  // Content insights
  let totalContentLength = 0;
  let contentLengthCounts = { short: 0, medium: 0, long: 0 };
  let postsWithHashtags = 0;
  let postsWithLinks = 0;

  // Best posting times
  const hourData = new Array(24).fill(null).map(() => ({ count: 0, engagement: 0 }));
  const dayData = new Array(7).fill(null).map(() => ({ count: 0, engagement: 0 }));

  posts.forEach(post => {
    // Topic aggregation
    const topic = post.topic || post.trend_topic || 'Uncategorized';
    if (!topicMap[topic]) {
      topicMap[topic] = { topic, count: 0, successCount: 0, totalEngagement: 0 };
    }
    topicMap[topic].count++;
    if (post.success) topicMap[topic].successCount++;

    // Engagement sum for topic
    const engagementScore = getEngagementScore(post.engagement);
    topicMap[topic].totalEngagement += engagementScore;

    // Trend vs original
    if (post.trend_topic) {
      trendDriven++;
      trendTotal++;
      if (post.success) trendSuccess++;
    } else {
      originalPosts++;
      originalTotal++;
      if (post.success) originalSuccess++;
    }

    // Content analysis
    if (post.content) {
      const len = post.content.length;
      totalContentLength += len;
      if (len < 150) contentLengthCounts.short++;
      else if (len < 500) contentLengthCounts.medium++;
      else contentLengthCounts.long++;

      if (post.content.includes('#')) postsWithHashtags++;
      if (post.content.match(/https?:\/\//)) postsWithLinks++;
    }

    // Time analysis
    const date = new Date(post.published_at);
    const hour = date.getUTCHours();
    const day = date.getUTCDay();
    hourData[hour].count++;
    hourData[hour].engagement += engagementScore;
    dayData[day].count++;
    dayData[day].engagement += engagementScore;
  });

  // Build topic list sorted by count
  const topics = Object.values(topicMap)
    .map(t => ({
      topic: t.topic,
      count: t.count,
      successRate: t.count > 0 ? parseFloat((t.successCount / t.count * 100).toFixed(1)) : 0,
      avgEngagement: t.count > 0 ? parseFloat((t.totalEngagement / t.count).toFixed(1)) : 0
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  return {
    topics,
    trendAnalysis: {
      trendDrivenPosts: trendDriven,
      originalPosts,
      trendSuccessRate: trendTotal > 0 ? parseFloat((trendSuccess / trendTotal * 100).toFixed(1)) : 0,
      originalSuccessRate: originalTotal > 0 ? parseFloat((originalSuccess / originalTotal * 100).toFixed(1)) : 0
    },
    contentInsights: {
      avgContentLength: posts.length > 0 ? Math.round(totalContentLength / posts.length) : 0,
      shortPosts: contentLengthCounts.short,
      mediumPosts: contentLengthCounts.medium,
      longPosts: contentLengthCounts.long,
      postsWithHashtags,
      postsWithLinks,
      totalPosts: posts.length
    },
    bestPostingTimes: {
      byHour: hourData.map((h, i) => ({
        hour: i,
        count: h.count,
        avgEngagement: h.count > 0 ? parseFloat((h.engagement / h.count).toFixed(1)) : 0
      })),
      byDayOfWeek: dayData.map((d, i) => ({
        day: DAY_NAMES[i],
        dayIndex: i,
        count: d.count,
        avgEngagement: d.count > 0 ? parseFloat((d.engagement / d.count).toFixed(1)) : 0
      }))
    }
  };
}

/**
 * Calculate a simple engagement score from engagement JSONB
 */
function getEngagementScore(engagement) {
  if (!engagement || typeof engagement !== 'object') return 0;
  return (engagement.likes || 0) +
         (engagement.comments || 0) * 2 +
         (engagement.shares || 0) * 3 +
         (engagement.views || 0) * 0.01;
}

// ============================================
// 6. QUOTA & USAGE
// ============================================

export async function getQuotaAnalytics(userId) {
  const [profileResult, agentCountResult] = await Promise.all([
    supabaseAdmin
      .from('profiles')
      .select('posts_remaining, daily_limit, reset_date, videos_remaining, video_monthly_limit, video_reset_date, subscription_tier')
      .eq('id', userId)
      .single(),

    supabaseAdmin
      .from('agents')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
  ]);

  if (profileResult.error) {
    logger.error('Error fetching quota analytics:', profileResult.error);
    throw profileResult.error;
  }

  const profile = profileResult.data;
  const tier = profile.subscription_tier || 'free';

  // Agent limits by tier
  const agentLimits = { free: 0, starter: 3, growth: 5, business: 15 };
  const agentLimit = agentLimits[tier] || 0;

  const postsUsed = (profile.daily_limit || 0) - (profile.posts_remaining || 0);
  const videosUsed = (profile.video_monthly_limit || 0) - (profile.videos_remaining || 0);

  // Burn rate: check last 7 days of published posts
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const { count: weekPosts } = await supabaseAdmin
    .from('published_posts')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('published_at', weekAgo);

  const burnRate = parseFloat(((weekPosts || 0) / 7).toFixed(1));

  return {
    posts: {
      used: Math.max(0, postsUsed),
      limit: profile.daily_limit || 0,
      remaining: profile.posts_remaining || 0,
      resetAt: profile.reset_date,
      burnRate
    },
    videos: {
      used: Math.max(0, videosUsed),
      limit: profile.video_monthly_limit || 0,
      remaining: profile.videos_remaining || 0,
      resetAt: profile.video_reset_date
    },
    agents: {
      used: agentCountResult.count || 0,
      limit: agentLimit,
      remaining: Math.max(0, agentLimit - (agentCountResult.count || 0))
    },
    tier
  };
}

// ============================================
// 7. CONNECTION HEALTH
// ============================================

export async function getConnectionHealthAnalytics(userId) {
  const { data, error } = await supabaseAdmin
    .from('social_connections')
    .select('platform, status, platform_username, token_expires_at, last_used_at, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });

  if (error) {
    logger.error('Error fetching connection health:', error);
    throw error;
  }

  const connections = (data || []).map(conn => {
    const now = new Date();
    const expiresAt = conn.token_expires_at ? new Date(conn.token_expires_at) : null;
    const daysUntilExpiry = expiresAt ? Math.ceil((expiresAt - now) / 86400000) : null;

    let health = 'good';
    let actionRequired = null;

    if (conn.status === 'error' || conn.status === 'revoked') {
      health = 'critical';
      actionRequired = `Reconnect your ${conn.platform} account`;
    } else if (conn.status === 'expired') {
      health = 'critical';
      actionRequired = `Your ${conn.platform} token has expired. Please reconnect.`;
    } else if (daysUntilExpiry !== null && daysUntilExpiry <= 7) {
      health = 'warning';
      actionRequired = `Your ${conn.platform} token expires in ${daysUntilExpiry} day${daysUntilExpiry !== 1 ? 's' : ''}`;
    }

    return {
      platform: conn.platform,
      status: conn.status,
      username: conn.platform_username,
      tokenExpiresAt: conn.token_expires_at,
      daysUntilExpiry,
      lastUsedAt: conn.last_used_at,
      connectedAt: conn.created_at,
      health,
      actionRequired
    };
  });

  const summary = {
    total: connections.length,
    healthy: connections.filter(c => c.health === 'good').length,
    warning: connections.filter(c => c.health === 'warning').length,
    critical: connections.filter(c => c.health === 'critical').length
  };

  return { connections, summary };
}

// ============================================
// 8. MARKETING SUMMARY
// ============================================

export async function getMarketingAnalytics(userId, period = '30d') {
  const { start } = periodToDateRange(period);

  const [campaignsResult, metricsResult, brandVoiceResult] = await Promise.all([
    supabaseAdmin
      .from('marketing_campaigns')
      .select('status, total_spend, total_impressions, total_reach, total_clicks')
      .eq('user_id', userId),

    supabaseAdmin
      .from('marketing_metrics_history')
      .select('date, spend, impressions, clicks')
      .eq('user_id', userId)
      .gte('date', start)
      .order('date', { ascending: true }),

    supabaseAdmin
      .from('brand_voice_profiles')
      .select('status')
      .eq('user_id', userId)
  ]);

  const campaigns = campaignsResult.data || [];
  const metrics = metricsResult.data || [];
  const brandVoice = brandVoiceResult.data || [];

  const activeCampaigns = campaigns.filter(c => c.status === 'active').length;
  const totalSpend = campaigns.reduce((sum, c) => sum + (parseFloat(c.total_spend) || 0), 0);
  const totalImpressions = campaigns.reduce((sum, c) => sum + (c.total_impressions || 0), 0);
  const totalClicks = campaigns.reduce((sum, c) => sum + (c.total_clicks || 0), 0);

  // Last 7 days of metrics for mini trend chart
  const recentMetrics = metrics.slice(-7).map(m => ({
    date: m.date,
    spend: parseFloat(m.spend) || 0,
    impressions: m.impressions || 0,
    clicks: m.clicks || 0
  }));

  return {
    campaigns: {
      total: campaigns.length,
      active: activeCampaigns,
      totalSpend: parseFloat(totalSpend.toFixed(2)),
      totalImpressions,
      totalClicks,
      avgCtr: totalImpressions > 0 ? parseFloat((totalClicks / totalImpressions * 100).toFixed(2)) : 0,
      avgCpc: totalClicks > 0 ? parseFloat((totalSpend / totalClicks).toFixed(2)) : 0
    },
    brandVoice: {
      profilesCount: brandVoice.length,
      readyProfiles: brandVoice.filter(p => p.status === 'ready').length
    },
    recentPerformance: recentMetrics
  };
}

// ============================================
// 9. AFFILIATE SUMMARY
// ============================================

export async function getAffiliateAnalytics(userId, period = '30d') {
  const { start } = periodToDateRange(period);

  const [productsResult, periodProductsResult, keywordsResult, credentialsResult] = await Promise.all([
    // Total products ever
    supabaseAdmin
      .from('affiliate_published_products')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId),

    // Products in period with platform breakdown
    supabaseAdmin
      .from('affiliate_published_products')
      .select('platform, commission_rate, sale_price')
      .eq('user_id', userId)
      .gte('published_at', start),

    // Keywords
    supabaseAdmin
      .from('affiliate_keywords')
      .select('is_active')
      .eq('user_id', userId),

    // API usage
    supabaseAdmin
      .from('affiliate_credentials')
      .select('api_calls_today')
      .eq('user_id', userId)
      .single()
  ]);

  const periodProducts = periodProductsResult.data || [];
  const keywords = keywordsResult.data || [];

  // Platform breakdown
  const byPlatform = {};
  let totalCommission = 0;
  let commissionCount = 0;
  let totalProductValue = 0;

  periodProducts.forEach(p => {
    byPlatform[p.platform] = (byPlatform[p.platform] || 0) + 1;
    if (p.commission_rate) {
      totalCommission += parseFloat(p.commission_rate);
      commissionCount++;
    }
    if (p.sale_price) {
      totalProductValue += parseFloat(p.sale_price);
    }
  });

  return {
    products: {
      totalPublished: productsResult.count || 0,
      publishedThisPeriod: periodProducts.length,
      byPlatform,
      avgCommissionRate: commissionCount > 0 ? parseFloat((totalCommission / commissionCount).toFixed(1)) : 0,
      totalProductValue: parseFloat(totalProductValue.toFixed(2))
    },
    keywords: {
      activeCount: keywords.filter(k => k.is_active).length,
      totalCount: keywords.length
    },
    apiUsage: {
      callsToday: credentialsResult.data?.api_calls_today || 0
    }
  };
}

// ============================================
// 10. EXPORT
// ============================================

export async function getExportData(userId, period = '30d', sections = []) {
  const allSections = sections.length === 0
    ? ['overview', 'activity', 'platforms', 'agents', 'content', 'quota', 'connections']
    : sections;

  const exportData = {
    exportDate: new Date().toISOString(),
    period
  };

  // Fetch each requested section
  const sectionFetchers = {
    overview: () => getOverviewAnalytics(userId, period),
    activity: () => getActivityAnalytics(userId, period, 'business'),
    platforms: () => getPlatformAnalytics(userId, period),
    agents: () => getAgentAnalytics(userId, period),
    content: () => getContentAnalytics(userId, period),
    quota: () => getQuotaAnalytics(userId),
    connections: () => getConnectionHealthAnalytics(userId)
  };

  for (const section of allSections) {
    if (sectionFetchers[section]) {
      try {
        exportData[section] = await sectionFetchers[section]();
      } catch (err) {
        logger.error(`Error fetching ${section} for export:`, err);
        exportData[section] = { error: 'Failed to fetch' };
      }
    }
  }

  return exportData;
}

/**
 * Convert export data to CSV format
 */
export function convertExportToCSV(data) {
  const rows = [];

  // Overview section
  if (data.overview?.kpis) {
    rows.push('=== OVERVIEW ===');
    rows.push('Metric,Value');
    const kpis = data.overview.kpis;
    rows.push(`Total Published,${kpis.totalPublished}`);
    rows.push(`Success Rate,${kpis.successRate}%`);
    rows.push(`Active Platforms,${kpis.activePlatforms}`);
    rows.push(`Top Platform,${kpis.topPlatform || 'N/A'}`);
    rows.push(`Failed Posts,${kpis.failedPosts}`);
    rows.push(`Period Growth,${kpis.periodGrowthPercent !== null ? kpis.periodGrowthPercent + '%' : 'N/A'}`);
    rows.push('');
  }

  // Activity section
  if (data.activity?.daily) {
    rows.push('=== DAILY ACTIVITY ===');
    rows.push('Date,Published,Failed');
    data.activity.daily.forEach(d => {
      rows.push(`${d.date},${d.published},${d.failed}`);
    });
    rows.push('');
  }

  // Platform section
  if (data.platforms?.platforms) {
    rows.push('=== PLATFORM PERFORMANCE ===');
    rows.push('Platform,Total Posts,Success Rate,Avg Posts/Day,Connection Status');
    data.platforms.platforms.forEach(p => {
      rows.push(`${p.platform},${p.totalPosts},${p.successRate}%,${p.avgPostsPerDay},${p.connectionStatus}`);
    });
    rows.push('');
  }

  // Agent section
  if (data.agents?.agents) {
    rows.push('=== AGENT PERFORMANCE ===');
    rows.push('Name,Platform,Status,Posts in Period,Success Rate,Efficiency,Top Topics');
    data.agents.agents.forEach(a => {
      const topics = (a.topTopics || []).join('; ');
      rows.push(`"${a.name}",${a.platform},${a.status},${a.totalPostsInPeriod},${a.successRate}%,${a.efficiency}%,"${topics}"`);
    });
    rows.push('');
  }

  // Content section
  if (data.content?.topics) {
    rows.push('=== TOP TOPICS ===');
    rows.push('Topic,Count,Success Rate');
    data.content.topics.forEach(t => {
      rows.push(`"${t.topic}",${t.count},${t.successRate}%`);
    });
    rows.push('');
  }

  return rows.join('\n');
}
