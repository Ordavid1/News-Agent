/**
 * Analytics Dashboard Module
 *
 * Handles all analytics data fetching, chart rendering, and section management.
 * Loaded by dashboard.html alongside chart.min.js.
 */

// ============================================
// STATE
// ============================================

let analyticsCurrentPeriod = '30d';
let analyticsCharts = {};  // Chart.js instances keyed by canvas id
let analyticsLoaded = false;

// Platform display config (mirrors dashboard.js PLATFORMS)
const PLATFORM_CONFIG = {
  twitter: { name: 'Twitter', icon: '🐦', color: '#1DA1F2' },
  linkedin: { name: 'LinkedIn', icon: '💼', color: '#0A66C2' },
  reddit: { name: 'Reddit', icon: '🔴', color: '#FF4500' },
  telegram: { name: 'Telegram', icon: '✈️', color: '#0088cc' },
  facebook: { name: 'Facebook', icon: '📘', color: '#1877F2' },
  threads: { name: 'Threads', icon: '@', color: '#000000' },
  whatsapp: { name: 'WhatsApp', icon: '💬', color: '#25D366' },
  instagram: { name: 'Instagram', icon: '📸', color: '#E4405F' },
  tiktok: { name: 'TikTok', icon: '🎵', color: '#010101' },
  youtube: { name: 'YouTube', icon: '▶️', color: '#FF0000' }
};

const TIER_HIERARCHY = { free: 0, starter: 1, growth: 2, business: 3 };

// ============================================
// HELPERS
// ============================================

function getAuthHeaders() {
  // Support both profile.js ('token') and dashboard.js ('authToken') key names
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  return { 'Authorization': `Bearer ${token}` };
}

function getApiUrl() {
  return window.location.origin + '/api';
}

function getUserTier() {
  return window.currentUser?.subscription?.tier || 'free';
}

function hasTier(minTier) {
  return (TIER_HIERARCHY[getUserTier()] || 0) >= (TIER_HIERARCHY[minTier] || 0);
}

function formatNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
}

function formatCurrency(amount) {
  return '$' + parseFloat(amount).toFixed(2);
}

function getPlatformName(platform) {
  return PLATFORM_CONFIG[platform]?.name || platform;
}

function getPlatformIcon(platform) {
  return PLATFORM_CONFIG[platform]?.icon || '📱';
}

function getPlatformColor(platform) {
  return PLATFORM_CONFIG[platform]?.color || '#6B7280';
}

async function fetchAnalytics(endpoint, params = {}) {
  const url = new URL(`${getApiUrl()}/analytics/${endpoint}`, window.location.origin);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const response = await fetch(url.toString(), { headers: getAuthHeaders() });
  if (!response.ok) {
    if (response.status === 403) return null; // Tier/addon gated
    throw new Error(`Analytics fetch failed: ${response.status}`);
  }
  return response.json();
}

// ============================================
// MAIN LOADER
// ============================================

async function loadAnalyticsSection() {
  // Support both profile.html ('content-analytics') and dashboard.html ('analyticsSection')
  const container = document.getElementById('content-analytics') || document.getElementById('analyticsSection');
  if (!container) return;

  // Show loading state
  showAnalyticsLoading(true);

  const tier = getUserTier();
  const period = analyticsCurrentPeriod;

  try {
    // Parallel fetch — all endpoints with graceful fallback
    const [overview, activity, quota, connections, platforms, agents, content, marketing, affiliate] = await Promise.allSettled([
      fetchAnalytics('overview', { period }),
      fetchAnalytics('activity', { period }),
      fetchAnalytics('quota'),
      fetchAnalytics('connections'),
      hasTier('starter') ? fetchAnalytics('platforms', { period }) : Promise.resolve(null),
      hasTier('starter') ? fetchAnalytics('agents', { period }) : Promise.resolve(null),
      hasTier('growth') ? fetchAnalytics('content', { period }) : Promise.resolve(null),
      fetchAnalytics('marketing', { period }).catch(() => null),
      fetchAnalytics('affiliate', { period }).catch(() => null)
    ]);

    // Render each section
    renderOverview(overview.status === 'fulfilled' ? overview.value : null);
    renderActivity(activity.status === 'fulfilled' ? activity.value : null);
    renderPlatforms(platforms.status === 'fulfilled' ? platforms.value : null);
    renderAgents(agents.status === 'fulfilled' ? agents.value : null);
    renderContent(content.status === 'fulfilled' ? content.value : null);
    renderQuota(quota.status === 'fulfilled' ? quota.value : null);
    renderConnections(connections.status === 'fulfilled' ? connections.value : null);
    renderMarketing(marketing.status === 'fulfilled' ? marketing.value : null);
    renderAffiliate(affiliate.status === 'fulfilled' ? affiliate.value : null);
    renderExport();

    analyticsLoaded = true;
  } catch (error) {
    console.error('Failed to load analytics:', error);
    showAnalyticsError();
  } finally {
    showAnalyticsLoading(false);
  }
}

function showAnalyticsLoading(show) {
  const loading = document.getElementById('analyticsLoading');
  const content = document.getElementById('analyticsContent');
  if (loading) loading.classList.toggle('hidden', !show);
  if (content) content.classList.toggle('hidden', show);
}

function showAnalyticsError() {
  const content = document.getElementById('analyticsContent');
  if (content) {
    content.innerHTML = `
      <div class="card-static p-8 text-center">
        <p class="text-ink-600 mb-4">Failed to load analytics data.</p>
        <button onclick="loadAnalyticsSection()" class="btn-primary btn-sm">Retry</button>
      </div>`;
    content.classList.remove('hidden');
  }
}

// ============================================
// PERIOD SELECTOR
// ============================================

function setAnalyticsPeriod(period) {
  analyticsCurrentPeriod = period;

  // Update active button
  document.querySelectorAll('.analytics-period-btn').forEach(btn => {
    btn.classList.toggle('bg-brand-600', btn.dataset.period === period);
    btn.classList.toggle('text-white', btn.dataset.period === period);
    btn.classList.toggle('bg-surface-100', btn.dataset.period !== period);
    btn.classList.toggle('text-ink-600', btn.dataset.period !== period);
  });

  // Destroy existing charts before re-rendering
  Object.values(analyticsCharts).forEach(chart => {
    if (chart && typeof chart.destroy === 'function') chart.destroy();
  });
  analyticsCharts = {};

  loadAnalyticsSection();
}

// ============================================
// 1. OVERVIEW KPIs
// ============================================

function renderOverview(data) {
  const container = document.getElementById('analyticsOverview');
  if (!container) return;

  if (!data?.kpis) {
    container.innerHTML = renderEmptyState('No publishing data yet', 'Start publishing to see your analytics');
    return;
  }

  const k = data.kpis;
  const growthHtml = k.periodGrowthPercent !== null
    ? `<span class="text-sm ml-2 ${k.periodGrowthPercent >= 0 ? 'text-green-500' : 'text-red-500'}">${k.periodGrowthPercent >= 0 ? '+' : ''}${k.periodGrowthPercent}%</span>`
    : '';

  container.innerHTML = `
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <div class="card-static p-5">
        <div class="text-ink-400 text-sm mb-1">Total Published</div>
        <div class="text-3xl font-bold text-ink-800">${formatNumber(k.totalPublished)}${growthHtml}</div>
        ${k.postsLastPeriod !== null ? `<div class="text-xs text-ink-400 mt-1">vs ${formatNumber(k.postsLastPeriod)} prev period</div>` : ''}
      </div>
      <div class="card-static p-5">
        <div class="text-ink-400 text-sm mb-1">Success Rate</div>
        <div class="text-3xl font-bold ${k.successRate >= 90 ? 'text-green-600' : k.successRate >= 70 ? 'text-yellow-600' : 'text-red-600'}">${k.successRate}%</div>
        ${k.failedPosts > 0 ? `<div class="text-xs text-red-400 mt-1">${k.failedPosts} failed</div>` : ''}
      </div>
      <div class="card-static p-5">
        <div class="text-ink-400 text-sm mb-1">Active Platforms</div>
        <div class="text-3xl font-bold text-ink-800">${k.activePlatforms}</div>
      </div>
      <div class="card-static p-5">
        <div class="text-ink-400 text-sm mb-1">Top Platform</div>
        <div class="text-3xl font-bold text-ink-800">${k.topPlatform ? getPlatformIcon(k.topPlatform) + ' ' + getPlatformName(k.topPlatform) : '-'}</div>
        ${k.scheduledPending > 0 ? `<div class="text-xs text-brand-500 mt-1">${k.scheduledPending} scheduled</div>` : ''}
      </div>
    </div>
  `;
}

// ============================================
// 2. ACTIVITY CHART
// ============================================

function renderActivity(data) {
  const container = document.getElementById('analyticsActivity');
  if (!container) return;

  if (!data?.daily || data.daily.length === 0) {
    container.innerHTML = renderEmptyState('No activity data', 'Publish your first post to see activity trends');
    return;
  }

  const cappedNotice = data.cappedPeriod
    ? `<div class="text-sm text-brand-500 mb-3">Free plan shows last 7 days. <a href="/#pricing" class="underline font-medium">Upgrade</a> for full history.</div>`
    : '';

  const summaryHtml = data.summary ? `
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
      <div class="bg-surface-50 rounded-lg p-3 text-center">
        <div class="text-ink-400 text-xs">Avg/Day</div>
        <div class="text-lg font-bold text-ink-700">${data.summary.avgPostsPerDay}</div>
      </div>
      ${data.summary.mostActiveDay ? `
      <div class="bg-surface-50 rounded-lg p-3 text-center">
        <div class="text-ink-400 text-xs">Best Day</div>
        <div class="text-lg font-bold text-ink-700">${data.summary.mostActiveDay}</div>
      </div>` : ''}
      ${data.summary.mostActiveHour !== undefined && data.summary.mostActiveDay ? `
      <div class="bg-surface-50 rounded-lg p-3 text-center">
        <div class="text-ink-400 text-xs">Peak Hour</div>
        <div class="text-lg font-bold text-ink-700">${data.summary.mostActiveHour}:00</div>
      </div>` : ''}
      ${data.summary.publishingStreak !== undefined ? `
      <div class="bg-surface-50 rounded-lg p-3 text-center">
        <div class="text-ink-400 text-xs">Streak</div>
        <div class="text-lg font-bold text-ink-700">${data.summary.publishingStreak} days</div>
      </div>` : ''}
    </div>
  ` : '';

  container.innerHTML = `
    ${cappedNotice}
    <div style="position: relative; height: 280px;">
      <canvas id="activityChart"></canvas>
    </div>
    ${summaryHtml}
  `;

  // Render Chart.js line chart
  const ctx = document.getElementById('activityChart');
  if (!ctx || typeof Chart === 'undefined') return;

  const labels = data.daily.map(d => {
    const date = new Date(d.date);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });

  analyticsCharts.activity = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Published',
          data: data.daily.map(d => d.published),
          borderColor: '#6366f1',
          backgroundColor: 'rgba(99, 102, 241, 0.1)',
          fill: true,
          tension: 0.3,
          pointRadius: data.daily.length > 30 ? 0 : 3,
          pointHoverRadius: 5
        },
        {
          label: 'Failed',
          data: data.daily.map(d => d.failed),
          borderColor: '#ef4444',
          backgroundColor: 'rgba(239, 68, 68, 0.05)',
          borderDash: [5, 5],
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          pointHoverRadius: 4
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { position: 'top', labels: { usePointStyle: true, padding: 15 } },
        tooltip: { backgroundColor: 'rgba(0,0,0,0.8)', padding: 10, cornerRadius: 8 }
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 10 } },
        y: { beginAtZero: true, ticks: { stepSize: 1 } }
      }
    }
  });
}

// ============================================
// 3. PLATFORM PERFORMANCE
// ============================================

function renderPlatforms(data) {
  const container = document.getElementById('analyticsPlatforms');
  if (!container) return;

  if (!hasTier('starter')) {
    container.innerHTML = renderGatedSection('Platform Performance', 'starter', 'See detailed per-platform analytics');
    return;
  }

  if (!data?.platforms || data.platforms.length === 0) {
    container.innerHTML = renderEmptyState('No platform data', 'Connect platforms and publish to see performance');
    return;
  }

  // Chart
  const chartHtml = `<div style="position: relative; height: 250px;"><canvas id="platformChart"></canvas></div>`;

  // Table
  const tableRows = data.platforms.map(p => `
    <tr class="border-b border-surface-100">
      <td class="py-3 pr-4">
        <div class="flex items-center gap-2">
          <span>${getPlatformIcon(p.platform)}</span>
          <span class="font-medium text-ink-700">${getPlatformName(p.platform)}</span>
        </div>
      </td>
      <td class="py-3 px-2 text-center font-medium">${p.totalPosts}</td>
      <td class="py-3 px-2 text-center">
        <span class="${p.successRate >= 90 ? 'text-green-600' : p.successRate >= 70 ? 'text-yellow-600' : 'text-red-600'}">${p.successRate}%</span>
      </td>
      <td class="py-3 px-2 text-center text-ink-500">${p.avgPostsPerDay}/day</td>
      <td class="py-3 pl-2 text-right">
        <span class="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full
          ${p.connectionStatus === 'active' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}">
          <span class="w-1.5 h-1.5 rounded-full ${p.connectionStatus === 'active' ? 'bg-green-500' : 'bg-red-500'}"></span>
          ${p.connectionStatus}
        </span>
      </td>
    </tr>
  `).join('');

  container.innerHTML = `
    ${chartHtml}
    <div class="overflow-x-auto mt-4">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-ink-400 text-xs uppercase border-b border-surface-200">
            <th class="pb-2 text-left">Platform</th>
            <th class="pb-2 text-center">Posts</th>
            <th class="pb-2 text-center">Success</th>
            <th class="pb-2 text-center">Rate</th>
            <th class="pb-2 text-right">Status</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
  `;

  // Render bar chart
  const ctx = document.getElementById('platformChart');
  if (!ctx || typeof Chart === 'undefined') return;

  analyticsCharts.platforms = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: data.platforms.map(p => getPlatformName(p.platform)),
      datasets: [{
        label: 'Posts',
        data: data.platforms.map(p => p.totalPosts),
        backgroundColor: data.platforms.map(p => getPlatformColor(p.platform) + 'CC'),
        borderColor: data.platforms.map(p => getPlatformColor(p.platform)),
        borderWidth: 1,
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: 'rgba(0,0,0,0.8)', padding: 10, cornerRadius: 8 }
      },
      scales: {
        x: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.05)' } },
        y: { grid: { display: false } }
      }
    }
  });
}

// ============================================
// 4. AGENT PERFORMANCE
// ============================================

function renderAgents(data) {
  const container = document.getElementById('analyticsAgents');
  if (!container) return;

  if (!hasTier('starter')) {
    container.innerHTML = renderGatedSection('Agent Performance', 'starter', 'Track how your AI agents are performing');
    return;
  }

  if (!data?.agents || data.agents.length === 0) {
    container.innerHTML = renderEmptyState('No agents configured', 'Create an agent to see performance metrics');
    return;
  }

  const summaryHtml = `
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
      <div class="bg-surface-50 rounded-lg p-3 text-center">
        <div class="text-ink-400 text-xs">Total Agents</div>
        <div class="text-xl font-bold text-ink-700">${data.summary.totalAgents}</div>
      </div>
      <div class="bg-surface-50 rounded-lg p-3 text-center">
        <div class="text-ink-400 text-xs">Active</div>
        <div class="text-xl font-bold text-green-600">${data.summary.activeAgents}</div>
      </div>
      <div class="bg-surface-50 rounded-lg p-3 text-center">
        <div class="text-ink-400 text-xs">Paused</div>
        <div class="text-xl font-bold text-yellow-600">${data.summary.pausedAgents}</div>
      </div>
      <div class="bg-surface-50 rounded-lg p-3 text-center">
        <div class="text-ink-400 text-xs">Avg Efficiency</div>
        <div class="text-xl font-bold text-brand-600">${data.summary.overallEfficiency}%</div>
      </div>
    </div>
  `;

  const agentCards = data.agents.map(agent => {
    // Use static class mappings so Tailwind can detect them
    const statusClasses = {
      active: { bg: 'bg-green-50', text: 'text-green-700', dot: 'bg-green-500' },
      paused: { bg: 'bg-yellow-50', text: 'text-yellow-700', dot: 'bg-yellow-500' },
      error: { bg: 'bg-red-50', text: 'text-red-700', dot: 'bg-red-500' }
    };
    const sc = statusClasses[agent.status] || statusClasses.error;

    const effClasses = agent.efficiency >= 80
      ? { text: 'text-green-600', bar: 'bg-green-500' }
      : agent.efficiency >= 50
        ? { text: 'text-yellow-600', bar: 'bg-yellow-500' }
        : { text: 'text-red-600', bar: 'bg-red-500' };

    return `
      <div class="bg-surface-50 rounded-xl p-4 border border-surface-200">
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2">
            <span>${getPlatformIcon(agent.platform)}</span>
            <span class="font-medium text-ink-700 truncate">${agent.name}</span>
          </div>
          <span class="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${sc.bg} ${sc.text}">
            <span class="w-1.5 h-1.5 rounded-full ${sc.dot}"></span>
            ${agent.status}
          </span>
        </div>
        <div class="grid grid-cols-3 gap-2 text-center mb-3">
          <div>
            <div class="text-xs text-ink-400">Posts</div>
            <div class="font-bold text-ink-700">${agent.totalPostsInPeriod}</div>
          </div>
          <div>
            <div class="text-xs text-ink-400">Success</div>
            <div class="font-bold text-ink-700">${agent.successRate}%</div>
          </div>
          <div>
            <div class="text-xs text-ink-400">Efficiency</div>
            <div class="font-bold ${effClasses.text}">${agent.efficiency}%</div>
          </div>
        </div>
        <div class="w-full bg-surface-200 rounded-full h-1.5 mb-2">
          <div class="${effClasses.bar} h-1.5 rounded-full transition-all" style="width: ${Math.min(100, agent.efficiency)}%"></div>
        </div>
        ${agent.topTopics.length > 0 ? `
          <div class="flex flex-wrap gap-1 mt-2">
            ${agent.topTopics.slice(0, 3).map(t => `<span class="text-xs bg-brand-50 text-brand-600 px-2 py-0.5 rounded-full">${t}</span>`).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');

  container.innerHTML = `
    ${summaryHtml}
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">${agentCards}</div>
  `;
}

// ============================================
// 5. CONTENT & TIMING INSIGHTS
// ============================================

function renderContent(data) {
  const container = document.getElementById('analyticsContentInsights');
  if (!container) return;

  if (!hasTier('growth')) {
    container.innerHTML = renderGatedSection('Content & Timing Insights', 'growth', 'Discover your best topics and optimal posting times');
    return;
  }

  if (!data?.topics || data.topics.length === 0) {
    container.innerHTML = renderEmptyState('Not enough data', 'Publish more content to unlock topic and timing insights');
    return;
  }

  // Left: Topic doughnut + trend analysis
  // Right: Best posting times heatmap
  container.innerHTML = `
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <!-- Topics -->
      <div>
        <h4 class="text-sm font-semibold text-ink-500 uppercase mb-3">Top Topics</h4>
        <div style="position: relative; height: 220px;" class="mb-4">
          <canvas id="topicChart"></canvas>
        </div>
        <!-- Trend vs Original -->
        <div class="bg-surface-50 rounded-xl p-4 mt-4">
          <h4 class="text-sm font-semibold text-ink-500 mb-3">Trend vs Original</h4>
          <div class="grid grid-cols-2 gap-4">
            <div class="text-center">
              <div class="text-2xl font-bold text-brand-600">${data.trendAnalysis.trendDrivenPosts}</div>
              <div class="text-xs text-ink-400">Trend-driven</div>
              <div class="text-xs text-ink-500">${data.trendAnalysis.trendSuccessRate}% success</div>
            </div>
            <div class="text-center">
              <div class="text-2xl font-bold text-ink-600">${data.trendAnalysis.originalPosts}</div>
              <div class="text-xs text-ink-400">Original</div>
              <div class="text-xs text-ink-500">${data.trendAnalysis.originalSuccessRate}% success</div>
            </div>
          </div>
        </div>
        <!-- Content insights -->
        <div class="bg-surface-50 rounded-xl p-4 mt-4">
          <h4 class="text-sm font-semibold text-ink-500 mb-3">Content Insights</h4>
          <div class="space-y-2 text-sm">
            <div class="flex justify-between"><span class="text-ink-500">Avg Length</span><span class="text-ink-700 font-medium">${data.contentInsights.avgContentLength} chars</span></div>
            <div class="flex justify-between"><span class="text-ink-500">With Hashtags</span><span class="text-ink-700 font-medium">${data.contentInsights.totalPosts > 0 ? Math.round(data.contentInsights.postsWithHashtags / data.contentInsights.totalPosts * 100) : 0}%</span></div>
            <div class="flex justify-between"><span class="text-ink-500">With Links</span><span class="text-ink-700 font-medium">${data.contentInsights.totalPosts > 0 ? Math.round(data.contentInsights.postsWithLinks / data.contentInsights.totalPosts * 100) : 0}%</span></div>
          </div>
        </div>
      </div>
      <!-- Best Posting Times Heatmap -->
      <div>
        <h4 class="text-sm font-semibold text-ink-500 uppercase mb-3">Best Posting Times (UTC)</h4>
        <div id="postingTimesHeatmap" class="overflow-x-auto"></div>
        <!-- By day of week -->
        <div class="bg-surface-50 rounded-xl p-4 mt-4">
          <h4 class="text-sm font-semibold text-ink-500 mb-3">Posts by Day</h4>
          <div class="space-y-2">
            ${data.bestPostingTimes.byDayOfWeek.map(d => {
              const maxCount = Math.max(...data.bestPostingTimes.byDayOfWeek.map(x => x.count), 1);
              const pct = Math.round(d.count / maxCount * 100);
              return `
                <div class="flex items-center gap-2">
                  <span class="text-xs text-ink-500 w-12">${d.day.slice(0, 3)}</span>
                  <div class="flex-1 bg-surface-200 rounded-full h-2">
                    <div class="bg-brand-500 h-2 rounded-full" style="width: ${pct}%"></div>
                  </div>
                  <span class="text-xs text-ink-600 w-6 text-right">${d.count}</span>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      </div>
    </div>
  `;

  // Render topic doughnut chart
  renderTopicChart(data.topics);

  // Render posting times heatmap
  renderPostingTimesHeatmap(data.bestPostingTimes.byHour);
}

function renderTopicChart(topics) {
  const ctx = document.getElementById('topicChart');
  if (!ctx || typeof Chart === 'undefined') return;

  const topN = topics.slice(0, 8);
  const colors = ['#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899', '#f43f5e', '#f97316', '#eab308'];

  analyticsCharts.topics = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: topN.map(t => t.topic),
      datasets: [{
        data: topN.map(t => t.count),
        backgroundColor: colors.slice(0, topN.length),
        borderWidth: 2,
        borderColor: '#fff'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '60%',
      plugins: {
        legend: {
          position: 'right',
          labels: {
            usePointStyle: true,
            padding: 8,
            font: { size: 11 },
            generateLabels: function(chart) {
              const data = chart.data;
              return data.labels.map((label, i) => ({
                text: label.length > 18 ? label.slice(0, 18) + '...' : label,
                fillStyle: data.datasets[0].backgroundColor[i],
                strokeStyle: '#fff',
                pointStyle: 'circle',
                index: i
              }));
            }
          }
        },
        tooltip: { backgroundColor: 'rgba(0,0,0,0.8)', padding: 10, cornerRadius: 8 }
      }
    }
  });
}

function renderPostingTimesHeatmap(byHour) {
  const container = document.getElementById('postingTimesHeatmap');
  if (!container) return;

  const maxCount = Math.max(...byHour.map(h => h.count), 1);

  // Show every 3 hours for compactness
  const hours = byHour.filter((_, i) => i % 2 === 0);

  let html = '<div class="grid gap-1" style="grid-template-columns: repeat(12, 1fr);">';

  hours.forEach(h => {
    const intensity = h.count / maxCount;
    const bg = intensity === 0 ? 'bg-surface-100' :
               intensity < 0.25 ? 'bg-brand-100' :
               intensity < 0.5 ? 'bg-brand-200' :
               intensity < 0.75 ? 'bg-brand-400' : 'bg-brand-600';
    const textColor = intensity >= 0.5 ? 'text-white' : 'text-ink-500';

    html += `
      <div class="rounded-lg p-2 text-center ${bg} ${textColor}" title="${h.count} posts at ${h.hour}:00 UTC">
        <div class="text-xs font-medium">${h.hour}:00</div>
        <div class="text-xs">${h.count}</div>
      </div>
    `;
  });

  html += '</div>';
  html += '<div class="flex items-center justify-end gap-2 mt-2 text-xs text-ink-400"><span>Less</span>';
  ['bg-surface-100', 'bg-brand-100', 'bg-brand-200', 'bg-brand-400', 'bg-brand-600'].forEach(c => {
    html += `<span class="w-3 h-3 rounded ${c}"></span>`;
  });
  html += '<span>More</span></div>';

  container.innerHTML = html;
}

// ============================================
// 6. QUOTA & USAGE
// ============================================

function renderQuota(data) {
  const container = document.getElementById('analyticsQuota');
  if (!container) return;

  if (!data) {
    container.innerHTML = renderEmptyState('Quota data unavailable', '');
    return;
  }

  function progressBar(used, limit, label) {
    if (limit === 0) return '';
    const pct = Math.min(100, Math.round(used / limit * 100));
    // Static class mapping for Tailwind detection
    const barClass = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-yellow-500' : 'bg-brand-500';
    return `
      <div class="mb-3">
        <div class="flex justify-between text-sm mb-1">
          <span class="text-ink-600">${label}</span>
          <span class="text-ink-500">${used} / ${limit}</span>
        </div>
        <div class="w-full bg-surface-200 rounded-full h-2.5">
          <div class="${barClass} h-2.5 rounded-full transition-all" style="width: ${pct}%"></div>
        </div>
      </div>
    `;
  }

  container.innerHTML = `
    <div class="space-y-1">
      ${progressBar(data.posts.used, data.posts.limit, 'Daily Posts')}
      ${progressBar(data.videos.used, data.videos.limit, 'Monthly Videos')}
      ${progressBar(data.agents.used, data.agents.limit, 'Agents')}
    </div>
    ${data.posts.burnRate > 0 ? `
      <div class="mt-3 text-xs text-ink-400">
        Avg ${data.posts.burnRate} posts/day (last 7 days)
      </div>
    ` : ''}
    <div class="mt-2 text-xs text-ink-400">
      Plan: <span class="font-medium text-ink-600 capitalize">${data.tier}</span>
    </div>
  `;
}

// ============================================
// 7. CONNECTION HEALTH
// ============================================

function renderConnections(data) {
  const container = document.getElementById('analyticsConnections');
  if (!container) return;

  if (!data?.connections || data.connections.length === 0) {
    container.innerHTML = renderEmptyState('No connections', 'Connect a social platform to get started');
    return;
  }

  const healthIcon = { good: '🟢', warning: '🟡', critical: '🔴' };

  const rows = data.connections.map(c => `
    <div class="flex items-center justify-between py-2.5 border-b border-surface-100 last:border-0">
      <div class="flex items-center gap-2">
        <span>${getPlatformIcon(c.platform)}</span>
        <div>
          <span class="text-sm font-medium text-ink-700">${getPlatformName(c.platform)}</span>
          ${c.username ? `<span class="text-xs text-ink-400 ml-1">@${c.username}</span>` : ''}
        </div>
      </div>
      <div class="flex items-center gap-2">
        ${c.actionRequired ? `<span class="text-xs text-red-500">${c.actionRequired}</span>` : ''}
        <span title="${c.health}">${healthIcon[c.health] || '⚪'}</span>
      </div>
    </div>
  `).join('');

  const summaryBadges = `
    <div class="flex gap-2 mb-3 text-xs">
      <span class="px-2 py-0.5 rounded-full bg-green-50 text-green-700">${data.summary.healthy} healthy</span>
      ${data.summary.warning > 0 ? `<span class="px-2 py-0.5 rounded-full bg-yellow-50 text-yellow-700">${data.summary.warning} warning</span>` : ''}
      ${data.summary.critical > 0 ? `<span class="px-2 py-0.5 rounded-full bg-red-50 text-red-700">${data.summary.critical} needs attention</span>` : ''}
    </div>
  `;

  container.innerHTML = summaryBadges + rows;
}

// ============================================
// 8. MARKETING SUMMARY
// ============================================

function renderMarketing(data) {
  const container = document.getElementById('analyticsMarketing');
  const section = document.getElementById('analyticsMarketingSection');
  if (!container || !section) return;

  if (!data) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');
  const c = data.campaigns;

  container.innerHTML = `
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
      <div class="bg-surface-50 rounded-lg p-3 text-center">
        <div class="text-ink-400 text-xs">Campaigns</div>
        <div class="text-xl font-bold text-ink-700">${c.active} <span class="text-xs text-ink-400">/ ${c.total}</span></div>
      </div>
      <div class="bg-surface-50 rounded-lg p-3 text-center">
        <div class="text-ink-400 text-xs">Total Spend</div>
        <div class="text-xl font-bold text-ink-700">${formatCurrency(c.totalSpend)}</div>
      </div>
      <div class="bg-surface-50 rounded-lg p-3 text-center">
        <div class="text-ink-400 text-xs">Impressions</div>
        <div class="text-xl font-bold text-ink-700">${formatNumber(c.totalImpressions)}</div>
      </div>
      <div class="bg-surface-50 rounded-lg p-3 text-center">
        <div class="text-ink-400 text-xs">Avg CTR</div>
        <div class="text-xl font-bold text-ink-700">${c.avgCtr}%</div>
      </div>
    </div>
    ${data.recentPerformance.length > 0 ? `
      <div style="position: relative; height: 150px;">
        <canvas id="marketingMiniChart"></canvas>
      </div>
    ` : ''}
    <div class="mt-3">
      <a href="/profile.html#marketing" class="text-sm text-brand-600 hover:text-brand-700 font-medium">View full marketing dashboard &rarr;</a>
    </div>
  `;

  // Mini spend chart
  if (data.recentPerformance.length > 0) {
    const ctx = document.getElementById('marketingMiniChart');
    if (ctx && typeof Chart !== 'undefined') {
      analyticsCharts.marketing = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: data.recentPerformance.map(d => {
            const date = new Date(d.date);
            return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          }),
          datasets: [{
            label: 'Spend',
            data: data.recentPerformance.map(d => d.spend),
            backgroundColor: '#6366f1AA',
            borderRadius: 4
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { display: false } },
            y: { beginAtZero: true, ticks: { callback: v => '$' + v } }
          }
        }
      });
    }
  }
}

// ============================================
// 9. AFFILIATE SUMMARY
// ============================================

function renderAffiliate(data) {
  const container = document.getElementById('analyticsAffiliate');
  const section = document.getElementById('analyticsAffiliateSection');
  if (!container || !section) return;

  if (!data) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');
  const p = data.products;

  const platformBreakdown = Object.entries(p.byPlatform).map(([platform, count]) => `
    <div class="flex items-center justify-between text-sm">
      <span class="text-ink-500">${getPlatformIcon(platform)} ${getPlatformName(platform)}</span>
      <span class="font-medium text-ink-700">${count} products</span>
    </div>
  `).join('');

  container.innerHTML = `
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
      <div class="bg-surface-50 rounded-lg p-3 text-center">
        <div class="text-ink-400 text-xs">Published (Period)</div>
        <div class="text-xl font-bold text-ink-700">${p.publishedThisPeriod}</div>
      </div>
      <div class="bg-surface-50 rounded-lg p-3 text-center">
        <div class="text-ink-400 text-xs">All Time</div>
        <div class="text-xl font-bold text-ink-700">${formatNumber(p.totalPublished)}</div>
      </div>
      <div class="bg-surface-50 rounded-lg p-3 text-center">
        <div class="text-ink-400 text-xs">Avg Commission</div>
        <div class="text-xl font-bold text-ink-700">${p.avgCommissionRate}%</div>
      </div>
      <div class="bg-surface-50 rounded-lg p-3 text-center">
        <div class="text-ink-400 text-xs">Keywords Active</div>
        <div class="text-xl font-bold text-ink-700">${data.keywords.activeCount} <span class="text-xs text-ink-400">/ ${data.keywords.totalCount}</span></div>
      </div>
    </div>
    ${platformBreakdown ? `<div class="bg-surface-50 rounded-xl p-4 space-y-2">${platformBreakdown}</div>` : ''}
    <div class="mt-2 text-xs text-ink-400">API calls today: ${data.apiUsage.callsToday}</div>
  `;
}

// ============================================
// 10. EXPORT
// ============================================

function renderExport() {
  const container = document.getElementById('analyticsExport');
  const section = document.getElementById('analyticsExportSection');
  if (!container || !section) return;

  if (!hasTier('business')) {
    section.classList.remove('hidden');
    container.innerHTML = renderGatedSection('Data Export', 'business', 'Export your analytics data as JSON or CSV');
    return;
  }

  section.classList.remove('hidden');
  container.innerHTML = `
    <div class="flex flex-wrap gap-3 items-center">
      <button onclick="exportAnalytics('json')" class="btn-primary btn-sm">Export JSON</button>
      <button onclick="exportAnalytics('csv')" class="btn-secondary btn-sm">Export CSV</button>
      <span class="text-xs text-ink-400">Period: ${analyticsCurrentPeriod}</span>
    </div>
  `;
}

async function exportAnalytics(format) {
  try {
    const url = `${getApiUrl()}/analytics/export?format=${format}&period=${analyticsCurrentPeriod}`;
    const response = await fetch(url, { headers: getAuthHeaders() });

    if (!response.ok) throw new Error('Export failed');

    if (format === 'csv') {
      const blob = await response.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `analytics-export-${analyticsCurrentPeriod}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } else {
      const data = await response.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `analytics-export-${analyticsCurrentPeriod}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    }
  } catch (error) {
    console.error('Export failed:', error);
    alert('Failed to export analytics. Please try again.');
  }
}

// ============================================
// SHARED UI HELPERS
// ============================================

function renderEmptyState(title, subtitle) {
  return `
    <div class="text-center py-8">
      <div class="text-ink-300 text-4xl mb-3">📊</div>
      <p class="text-ink-600 font-medium">${title}</p>
      ${subtitle ? `<p class="text-ink-400 text-sm mt-1">${subtitle}</p>` : ''}
    </div>
  `;
}

function renderGatedSection(featureName, requiredTier, description) {
  return `
    <div class="relative">
      <div class="blur-sm opacity-40 pointer-events-none p-8 text-center">
        <div class="h-32 bg-surface-100 rounded-xl flex items-center justify-center text-ink-300 text-lg">
          ${featureName} Preview
        </div>
      </div>
      <div class="absolute inset-0 flex items-center justify-center">
        <div class="card-static p-6 text-center shadow-lg max-w-xs">
          <p class="text-ink-700 font-semibold mb-1">${featureName}</p>
          <p class="text-ink-400 text-sm mb-3">${description}</p>
          <p class="text-xs text-ink-400 mb-3">Available on <span class="font-semibold capitalize">${requiredTier}</span> plan and above</p>
          <a href="/#pricing" class="btn-primary btn-sm inline-block">Upgrade</a>
        </div>
      </div>
    </div>
  `;
}

// ============================================
// GLOBAL EXPORTS
// ============================================

window.loadAnalyticsSection = loadAnalyticsSection;
window.setAnalyticsPeriod = setAnalyticsPeriod;
window.exportAnalytics = exportAnalytics;
