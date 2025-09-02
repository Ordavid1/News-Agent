// routes/analytics.js
import express from 'express';
import { getAnalytics, getUsageStats } from '../services/database-wrapper.js';
import { requireTier } from '../middleware/subscription.js';

const router = express.Router();

// Get basic analytics (available to all tiers)
router.get('/overview', async (req, res) => {
  try {
    const { period = '30d' } = req.query;
    const analytics = await getAnalytics(req.user.id, period);
    
    res.json({
      analytics,
      period
    });
  } catch (error) {
    console.error('Analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// Get detailed usage stats (Growth tier and above)
router.get('/usage', requireTier('growth'), async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();
    
    const usageStats = await getUsageStats(req.user.id, start, end);
    
    // Process usage stats
    const dailyUsage = {};
    const platformUsage = {};
    const hourlyDistribution = new Array(24).fill(0);
    
    usageStats.forEach(log => {
      if (log.action === 'post_created') {
        // Daily usage
        const date = log.timestamp.toISOString().split('T')[0];
        dailyUsage[date] = (dailyUsage[date] || 0) + 1;
        
        // Hourly distribution
        const hour = log.timestamp.getHours();
        hourlyDistribution[hour]++;
        
        // Platform usage
        if (log.metadata?.platforms) {
          log.metadata.platforms.forEach(platform => {
            platformUsage[platform] = (platformUsage[platform] || 0) + 1;
          });
        }
      }
    });
    
    res.json({
      dailyUsage,
      platformUsage,
      hourlyDistribution,
      totalActions: usageStats.length,
      period: {
        start: start.toISOString(),
        end: end.toISOString()
      }
    });
    
  } catch (error) {
    console.error('Usage stats error:', error);
    res.status(500).json({ error: 'Failed to fetch usage statistics' });
  }
});

// Get performance metrics (Professional tier and above)
router.get('/performance', requireTier('professional'), async (req, res) => {
  try {
    // TODO: Implement performance tracking
    // This would include engagement rates, best performing topics, optimal posting times, etc.
    
    res.json({
      message: 'Performance analytics coming soon',
      tier: req.user.subscription.tier
    });
    
  } catch (error) {
    console.error('Performance analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch performance metrics' });
  }
});

// Export analytics data (Business tier only)
router.get('/export', requireTier('business'), async (req, res) => {
  try {
    const { format = 'json', period = '30d' } = req.query;
    
    const analytics = await getAnalytics(req.user.id, period);
    const usageStats = await getUsageStats(
      req.user.id, 
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      new Date()
    );
    
    const exportData = {
      user: {
        id: req.user.id,
        email: req.user.email,
        subscription: req.user.subscription
      },
      analytics,
      usage: usageStats,
      exportDate: new Date().toISOString()
    };
    
    if (format === 'csv') {
      // Convert to CSV format
      const csv = convertToCSV(exportData);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=analytics-export.csv');
      res.send(csv);
    } else {
      res.json(exportData);
    }
    
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: 'Failed to export analytics' });
  }
});

// Helper function to convert data to CSV
function convertToCSV(data) {
  // Simple CSV conversion - in production, use a proper CSV library
  const rows = [];
  rows.push('Date,Posts Created,Platform,Topic');
  
  // This is a simplified example
  Object.entries(data.analytics.platformBreakdown).forEach(([platform, count]) => {
    rows.push(`${new Date().toISOString()},${count},${platform},""`);
  });
  
  return rows.join('\n');
}

export default router;