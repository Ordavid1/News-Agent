// routes/analytics.js
import express from 'express';
import { requireTier, requireMarketingAddon, requireAffiliateAddon } from '../middleware/subscription.js';
import {
  getOverviewAnalytics,
  getActivityAnalytics,
  getPlatformAnalytics,
  getAgentAnalytics,
  getContentAnalytics,
  getQuotaAnalytics,
  getConnectionHealthAnalytics,
  getMarketingAnalytics,
  getAffiliateAnalytics,
  getExportData,
  convertExportToCSV
} from '../services/AnalyticsService.js';

const router = express.Router();

// ============================================
// 1. OVERVIEW KPIs (All tiers)
// ============================================
router.get('/overview', async (req, res) => {
  try {
    const { period = '30d' } = req.query;
    const data = await getOverviewAnalytics(req.user.id, period);
    res.json(data);
  } catch (error) {
    console.error('Analytics overview error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics overview' });
  }
});

// ============================================
// 2. PUBLISHING ACTIVITY (All tiers, free capped to 7d)
// ============================================
router.get('/activity', async (req, res) => {
  try {
    const { period = '30d' } = req.query;
    const tier = req.user.subscription?.tier || 'free';
    const data = await getActivityAnalytics(req.user.id, period, tier);
    res.json(data);
  } catch (error) {
    console.error('Analytics activity error:', error);
    res.status(500).json({ error: 'Failed to fetch activity analytics' });
  }
});

// ============================================
// 3. PLATFORM PERFORMANCE (Starter+)
// ============================================
router.get('/platforms', requireTier('starter'), async (req, res) => {
  try {
    const { period = '30d' } = req.query;
    const data = await getPlatformAnalytics(req.user.id, period);
    res.json(data);
  } catch (error) {
    console.error('Platform analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch platform analytics' });
  }
});

// ============================================
// 4. AGENT PERFORMANCE (Starter+)
// ============================================
router.get('/agents', requireTier('starter'), async (req, res) => {
  try {
    const { period = '30d' } = req.query;
    const data = await getAgentAnalytics(req.user.id, period);
    res.json(data);
  } catch (error) {
    console.error('Agent analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch agent analytics' });
  }
});

// ============================================
// 5. CONTENT & TIMING INSIGHTS (Growth+)
// ============================================
router.get('/content', requireTier('growth'), async (req, res) => {
  try {
    const { period = '30d' } = req.query;
    const data = await getContentAnalytics(req.user.id, period);
    res.json(data);
  } catch (error) {
    console.error('Content analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch content analytics' });
  }
});

// ============================================
// 6. QUOTA & USAGE (All tiers)
// ============================================
router.get('/quota', async (req, res) => {
  try {
    const data = await getQuotaAnalytics(req.user.id);
    res.json(data);
  } catch (error) {
    console.error('Quota analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch quota analytics' });
  }
});

// ============================================
// 7. CONNECTION HEALTH (All tiers)
// ============================================
router.get('/connections', async (req, res) => {
  try {
    const data = await getConnectionHealthAnalytics(req.user.id);
    res.json(data);
  } catch (error) {
    console.error('Connection analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch connection analytics' });
  }
});

// ============================================
// 8. MARKETING SUMMARY (Marketing add-on only)
// ============================================
router.get('/marketing', requireMarketingAddon(), async (req, res) => {
  try {
    const { period = '30d' } = req.query;
    const data = await getMarketingAnalytics(req.user.id, period);
    res.json(data);
  } catch (error) {
    console.error('Marketing analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch marketing analytics' });
  }
});

// ============================================
// 9. AFFILIATE SUMMARY (Affiliate add-on only)
// ============================================
router.get('/affiliate', requireAffiliateAddon(), async (req, res) => {
  try {
    const { period = '30d' } = req.query;
    const data = await getAffiliateAnalytics(req.user.id, period);
    res.json(data);
  } catch (error) {
    console.error('Affiliate analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch affiliate analytics' });
  }
});

// ============================================
// 10. EXPORT (Business tier only)
// ============================================
router.get('/export', requireTier('business'), async (req, res) => {
  try {
    const { format = 'json', period = '30d', sections = '' } = req.query;
    const sectionList = sections ? sections.split(',').map(s => s.trim()) : [];

    const exportData = await getExportData(req.user.id, period, sectionList);

    if (format === 'csv') {
      const csv = convertExportToCSV(exportData);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename=analytics-export-${period}.csv`);
      res.send(csv);
    } else {
      res.json(exportData);
    }
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: 'Failed to export analytics' });
  }
});

export default router;
