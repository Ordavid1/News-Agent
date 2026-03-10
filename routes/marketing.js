/**
 * Marketing Routes
 *
 * REST endpoints for Meta Marketing API operations:
 * - Ad account management
 * - Post boosting
 * - Campaign management
 * - Audience templates
 * - Auto-boost rules
 * - Performance analytics
 */

import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { csrfProtection } from '../middleware/csrf.js';
import { requireMarketingAddon } from '../middleware/subscription.js';
import marketingService from '../services/MarketingService.js';
import brandVoiceService from '../services/BrandVoiceService.js';
import {
  getUserAdAccounts,
  getSelectedAdAccount,
  selectAdAccount,
  deleteAdAccount,
  deleteAllUserAdAccounts,
  getUserCampaigns,
  getCampaignById,
  updateCampaign,
  deleteCampaign,
  countUserActiveCampaigns,
  getCampaignAdSets,
  getAdSetById,
  updateAdSet,
  deleteAdSet,
  getAdSetAds,
  getAdById,
  updateAd,
  deleteAd,
  getUserAudienceTemplates,
  getAudienceTemplateById,
  createAudienceTemplate,
  updateAudienceTemplate,
  deleteAudienceTemplate,
  countUserAudienceTemplates,
  getUserMarketingRules,
  getMarketingRuleById,
  createMarketingRule,
  updateMarketingRule,
  deleteMarketingRule,
  countUserMarketingRules,
  getRuleTriggerHistory,
  getBoostablePublishedPosts,
  getUserAds,
  getUserBrandVoiceProfiles,
  getBrandVoiceProfileById,
  createBrandVoiceProfile,
  updateBrandVoiceProfile,
  deleteBrandVoiceProfile,
  countUserBrandVoiceProfiles,
  getBrandVoicePosts,
  insertBrandVoiceGeneratedPost,
  getBrandVoiceGeneratedPosts,
  deleteBrandVoiceGeneratedPost
} from '../services/database-wrapper.js';
import winston from 'winston';

const router = express.Router();

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()]
});

// All marketing routes require authentication, CSRF, and marketing add-on
router.use(authenticateToken);
router.use(csrfProtection);
router.use(requireMarketingAddon());

// ============================================
// AD ACCOUNT MANAGEMENT
// ============================================

/**
 * GET /api/marketing/ad-accounts
 * List user's ad accounts
 */
router.get('/ad-accounts', async (req, res) => {
  try {
    // Verify user has an active Facebook connection before returning ad accounts
    const TokenManager = (await import('../services/TokenManager.js')).default;
    const connection = await TokenManager.getTokens(req.user.id, 'facebook');

    if (!connection || connection.status !== 'active') {
      // Clean up stale accounts from a previous connection
      await deleteAllUserAdAccounts(req.user.id);
      return res.json({ success: true, accounts: [], needsConnection: true });
    }

    // Check if marketing permissions are enabled on this connection
    const marketingEnabled = connection.platform_metadata?.marketingEnabled === true;
    const accounts = await getUserAdAccounts(req.user.id);
    res.json({ success: true, accounts, marketingEnabled });
  } catch (error) {
    logger.error('Error getting ad accounts:', error);
    res.status(500).json({ error: 'Failed to get ad accounts' });
  }
});

/**
 * POST /api/marketing/ad-accounts/discover
 * Re-discover ad accounts from Meta API
 */
router.post('/ad-accounts/discover', async (req, res) => {
  try {
    const ConnectionManager = (await import('../services/ConnectionManager.js')).default;
    const TokenManager = (await import('../services/TokenManager.js')).default;

    const connection = await TokenManager.getTokens(req.user.id, 'facebook');
    if (!connection || connection.status !== 'active') {
      return res.status(400).json({ error: 'No active Facebook connection' });
    }

    // Check ad account limit
    const maxAdAccounts = req.marketingAddon?.max_ad_accounts || 1;
    const existingAccounts = await getUserAdAccounts(req.user.id);
    const slotsAvailable = Math.max(0, maxAdAccounts - existingAccounts.length);

    if (slotsAvailable === 0) {
      return res.status(403).json({
        error: 'Ad account limit reached',
        limit: maxAdAccounts,
        current: existingAccounts.length
      });
    }

    const adAccounts = await ConnectionManager.discoverAdAccounts(connection.access_token);

    // Filter out accounts already stored, then limit to available slots
    const existingIds = new Set(existingAccounts.map(a => a.account_id));
    const newAccounts = adAccounts.filter(a => !existingIds.has(a.accountId));
    const accountsToStore = newAccounts.slice(0, slotsAvailable);

    const { upsertAdAccount } = await import('../services/database-wrapper.js');
    for (const account of accountsToStore) {
      await upsertAdAccount({
        userId: req.user.id,
        ...account,
        isSelected: existingAccounts.length === 0 && accountsToStore.length === 1
      });
    }

    res.json({
      success: true,
      accounts: accountsToStore,
      totalDiscovered: adAccounts.length,
      stored: accountsToStore.length,
      limit: maxAdAccounts,
      limitReached: (existingAccounts.length + accountsToStore.length) >= maxAdAccounts
    });
  } catch (error) {
    logger.error('Error discovering ad accounts:', error);
    res.status(500).json({ error: 'Failed to discover ad accounts' });
  }
});

/**
 * POST /api/marketing/ad-accounts/:id/select
 * Set an ad account as active
 */
router.post('/ad-accounts/:id/select', async (req, res) => {
  try {
    const account = await selectAdAccount(req.user.id, req.params.id);
    res.json({ success: true, account });
  } catch (error) {
    logger.error('Error selecting ad account:', error);
    res.status(500).json({ error: 'Failed to select ad account' });
  }
});

// ============================================
// POST BOOSTING
// ============================================

/**
 * GET /api/marketing/boostable-posts
 * List published FB/IG posts eligible for boosting
 */
router.get('/boostable-posts', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const posts = await getBoostablePublishedPosts(req.user.id, limit);
    res.json({ success: true, posts });
  } catch (error) {
    logger.error('Error getting boostable posts:', error);
    res.status(500).json({ error: 'Failed to get boostable posts' });
  }
});

/**
 * GET /api/marketing/page-posts
 * Fetch posts directly from the user's Facebook Page (last N days).
 * Includes ALL posts, not just those published through this app.
 */
router.get('/page-posts', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const posts = await marketingService.fetchPagePosts(req.user.id, days);
    res.json({ success: true, posts, source: 'meta' });
  } catch (error) {
    logger.error('Error fetching page posts:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch page posts' });
  }
});

/**
 * POST /api/marketing/boost
 * Boost a published post (creates campaign → ad set → creative → ad)
 */
router.post('/boost', async (req, res) => {
  try {
    const { platformPostId, sourcePlatform, sourcePublishedPostId, budget, duration, audience } = req.body;

    // Validation
    if (!platformPostId) {
      return res.status(400).json({ error: 'platformPostId is required' });
    }
    if (!budget || !budget.type || !budget.amount) {
      return res.status(400).json({ error: 'budget with type and amount is required' });
    }
    if (!duration || !duration.startTime || !duration.endTime) {
      return res.status(400).json({ error: 'duration with startTime and endTime is required' });
    }
    if (!audience) {
      return res.status(400).json({ error: 'audience targeting is required' });
    }

    // Check campaign limit
    const activeCount = await countUserActiveCampaigns(req.user.id);
    const limit = req.marketingLimits.maxActiveCampaigns;
    if (limit !== -1 && activeCount >= limit) {
      return res.status(403).json({
        error: `Campaign limit reached (${activeCount}/${limit}). Upgrade your marketing plan for more.`
      });
    }

    const result = await marketingService.boostPost(req.user.id, {
      platformPostId,
      sourcePlatform: sourcePlatform || 'facebook',
      sourcePublishedPostId,
      budget,
      duration,
      audience
    });

    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('Error boosting post:', error);
    res.status(500).json({ error: error.message || 'Failed to boost post' });
  }
});

/**
 * GET /api/marketing/boosts
 * List all boosts (campaigns that are boosts)
 */
router.get('/boosts', async (req, res) => {
  try {
    const filters = {};
    if (req.query.adAccountId) filters.adAccountId = req.query.adAccountId;
    const campaigns = await getUserCampaigns(req.user.id, filters);
    // Filter to boost campaigns only
    const boosts = campaigns.filter(c => c.metadata?.boostType === true);
    res.json({ success: true, boosts });
  } catch (error) {
    logger.error('Error getting boosts:', error);
    res.status(500).json({ error: 'Failed to get boosts' });
  }
});

/**
 * GET /api/marketing/boosts/:id
 * Get boost details with metrics
 */
router.get('/boosts/:id', async (req, res) => {
  try {
    const campaign = await getCampaignById(req.params.id);
    if (!campaign || campaign.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Boost not found' });
    }

    const adSets = await getCampaignAdSets(campaign.id);
    const ads = adSets.length > 0 ? await getAdSetAds(adSets[0].id) : [];

    res.json({
      success: true,
      boost: campaign,
      adSet: adSets[0] || null,
      ad: ads[0] || null
    });
  } catch (error) {
    logger.error('Error getting boost:', error);
    res.status(500).json({ error: 'Failed to get boost details' });
  }
});

/**
 * PUT /api/marketing/boosts/:id/pause
 */
router.put('/boosts/:id/pause', async (req, res) => {
  try {
    const campaign = await marketingService.pauseBoost(req.user.id, req.params.id);
    res.json({ success: true, campaign });
  } catch (error) {
    logger.error('Error pausing boost:', error);
    res.status(500).json({ error: error.message || 'Failed to pause boost' });
  }
});

/**
 * PUT /api/marketing/boosts/:id/resume
 */
router.put('/boosts/:id/resume', async (req, res) => {
  try {
    const campaign = await marketingService.resumeBoost(req.user.id, req.params.id);
    res.json({ success: true, campaign });
  } catch (error) {
    logger.error('Error resuming boost:', error);
    res.status(500).json({ error: error.message || 'Failed to resume boost' });
  }
});

/**
 * DELETE /api/marketing/boosts/:id
 */
router.delete('/boosts/:id', async (req, res) => {
  try {
    await marketingService.deleteBoost(req.user.id, req.params.id);
    res.json({ success: true, message: 'Boost deleted' });
  } catch (error) {
    logger.error('Error deleting boost:', error);
    res.status(500).json({ error: error.message || 'Failed to delete boost' });
  }
});

// ============================================
// CAMPAIGN MANAGEMENT
// ============================================

/**
 * GET /api/marketing/campaigns
 */
router.get('/campaigns', async (req, res) => {
  try {
    const filters = {};
    if (req.query.status) filters.status = req.query.status;
    if (req.query.adAccountId) filters.adAccountId = req.query.adAccountId;
    const campaigns = await getUserCampaigns(req.user.id, filters);
    res.json({ success: true, campaigns });
  } catch (error) {
    logger.error('Error getting campaigns:', error);
    res.status(500).json({ error: 'Failed to get campaigns' });
  }
});

/**
 * POST /api/marketing/campaigns/sync
 * Sync campaigns from Meta Ad Account into local database
 */
router.post('/campaigns/sync', async (req, res) => {
  try {
    const result = await marketingService.syncCampaignsFromMeta(req.user.id);
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('Error syncing campaigns from Meta:', error);
    res.status(500).json({ error: error.message || 'Failed to sync campaigns from Meta' });
  }
});

/**
 * POST /api/marketing/campaigns
 */
router.post('/campaigns', async (req, res) => {
  try {
    const { name, objective, platforms, dailyBudget, lifetimeBudget, startTime, endTime } = req.body;

    if (!name || !objective) {
      return res.status(400).json({ error: 'name and objective are required' });
    }

    // Check campaign limit
    const activeCount = await countUserActiveCampaigns(req.user.id);
    const limit = req.marketingLimits.maxActiveCampaigns;
    if (limit !== -1 && activeCount >= limit) {
      return res.status(403).json({ error: `Campaign limit reached (${activeCount}/${limit})` });
    }

    const campaign = await marketingService.createCampaignOnMeta(req.user.id, {
      name, objective, platforms, dailyBudget, lifetimeBudget, startTime, endTime
    });

    res.json({ success: true, campaign });
  } catch (error) {
    logger.error('Error creating campaign:', error);
    res.status(500).json({ error: error.message || 'Failed to create campaign' });
  }
});

/**
 * GET /api/marketing/campaigns/:id
 */
router.get('/campaigns/:id', async (req, res) => {
  try {
    const campaign = await getCampaignById(req.params.id);
    if (!campaign || campaign.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const adSets = await getCampaignAdSets(campaign.id);

    // Fetch ads for each ad set
    const adSetsWithAds = await Promise.all(adSets.map(async (adSet) => {
      const ads = await getAdSetAds(adSet.id);
      return { ...adSet, ads };
    }));

    res.json({ success: true, campaign, adSets: adSetsWithAds });
  } catch (error) {
    logger.error('Error getting campaign:', error);
    res.status(500).json({ error: 'Failed to get campaign' });
  }
});

/**
 * PUT /api/marketing/campaigns/:id
 */
router.put('/campaigns/:id', async (req, res) => {
  try {
    const campaign = await getCampaignById(req.params.id);
    if (!campaign || campaign.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    // If status change, update on Meta too
    if (req.body.status && req.body.status !== campaign.status) {
      const updated = await marketingService.updateCampaignStatus(req.user.id, req.params.id, req.body.status);
      return res.json({ success: true, campaign: updated });
    }

    const updated = await updateCampaign(req.params.id, req.body);
    res.json({ success: true, campaign: updated });
  } catch (error) {
    logger.error('Error updating campaign:', error);
    res.status(500).json({ error: error.message || 'Failed to update campaign' });
  }
});

/**
 * DELETE /api/marketing/campaigns/:id
 */
router.delete('/campaigns/:id', async (req, res) => {
  try {
    await marketingService.deleteBoost(req.user.id, req.params.id); // Same logic for campaigns
    res.json({ success: true, message: 'Campaign deleted' });
  } catch (error) {
    logger.error('Error deleting campaign:', error);
    res.status(500).json({ error: error.message || 'Failed to delete campaign' });
  }
});

// ============================================
// AD SET MANAGEMENT
// ============================================

/**
 * POST /api/marketing/campaigns/:id/ad-sets
 */
router.post('/campaigns/:id/ad-sets', async (req, res) => {
  try {
    const { name, targeting, placements, billingEvent, bidStrategy, bidAmount, dailyBudget, lifetimeBudget, startTime, endTime } = req.body;

    if (!name || !targeting) {
      return res.status(400).json({ error: 'name and targeting are required' });
    }

    const adSet = await marketingService.createAdSetOnMeta(req.user.id, req.params.id, {
      name, targeting, placements, billingEvent, bidStrategy, bidAmount, dailyBudget, lifetimeBudget, startTime, endTime
    });

    res.json({ success: true, adSet });
  } catch (error) {
    logger.error('Error creating ad set:', error);
    res.status(500).json({ error: error.message || 'Failed to create ad set' });
  }
});

/**
 * PUT /api/marketing/ad-sets/:id
 */
router.put('/ad-sets/:id', async (req, res) => {
  try {
    const adSet = await getAdSetById(req.params.id);
    if (!adSet || adSet.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Ad set not found' });
    }

    const updated = await updateAdSet(req.params.id, req.body);
    res.json({ success: true, adSet: updated });
  } catch (error) {
    logger.error('Error updating ad set:', error);
    res.status(500).json({ error: 'Failed to update ad set' });
  }
});

/**
 * DELETE /api/marketing/ad-sets/:id
 */
router.delete('/ad-sets/:id', async (req, res) => {
  try {
    const adSet = await getAdSetById(req.params.id);
    if (!adSet || adSet.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Ad set not found' });
    }

    await deleteAdSet(req.params.id);
    res.json({ success: true, message: 'Ad set deleted' });
  } catch (error) {
    logger.error('Error deleting ad set:', error);
    res.status(500).json({ error: 'Failed to delete ad set' });
  }
});

// ============================================
// AD MANAGEMENT
// ============================================

/**
 * POST /api/marketing/ad-sets/:id/ads
 * Create an ad from a published post
 */
router.post('/ad-sets/:id/ads', async (req, res) => {
  try {
    const { platformPostId, sourcePublishedPostId, sourcePlatform, name } = req.body;

    if (!platformPostId) {
      return res.status(400).json({ error: 'platformPostId is required' });
    }

    const ad = await marketingService.createAdFromPost(req.user.id, req.params.id, {
      platformPostId, sourcePublishedPostId, sourcePlatform, name
    });

    res.json({ success: true, ad });
  } catch (error) {
    logger.error('Error creating ad:', error);
    res.status(500).json({ error: error.message || 'Failed to create ad' });
  }
});

/**
 * PUT /api/marketing/ads/:id
 */
router.put('/ads/:id', async (req, res) => {
  try {
    const ad = await getAdById(req.params.id);
    if (!ad || ad.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Ad not found' });
    }

    const updated = await updateAd(req.params.id, req.body);
    res.json({ success: true, ad: updated });
  } catch (error) {
    logger.error('Error updating ad:', error);
    res.status(500).json({ error: 'Failed to update ad' });
  }
});

/**
 * DELETE /api/marketing/ads/:id
 */
router.delete('/ads/:id', async (req, res) => {
  try {
    const ad = await getAdById(req.params.id);
    if (!ad || ad.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Ad not found' });
    }

    await deleteAd(req.params.id);
    res.json({ success: true, message: 'Ad deleted' });
  } catch (error) {
    logger.error('Error deleting ad:', error);
    res.status(500).json({ error: 'Failed to delete ad' });
  }
});

// ============================================
// AUDIENCE TEMPLATES
// ============================================

/**
 * GET /api/marketing/audiences
 */
router.get('/audiences', async (req, res) => {
  try {
    const templates = await getUserAudienceTemplates(req.user.id);
    res.json({ success: true, audiences: templates });
  } catch (error) {
    logger.error('Error getting audiences:', error);
    res.status(500).json({ error: 'Failed to get audience templates' });
  }
});

/**
 * POST /api/marketing/audiences/sync
 * Sync Custom Audiences from Meta Ad Account
 */
router.post('/audiences/sync', async (req, res) => {
  try {
    const result = await marketingService.syncCustomAudiences(req.user.id);
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('Error syncing audiences from Meta:', error);
    res.status(500).json({ error: error.message || 'Failed to sync audiences from Meta' });
  }
});

/**
 * POST /api/marketing/audiences
 */
router.post('/audiences', async (req, res) => {
  try {
    const { name, description, targeting, platforms, isDefault } = req.body;

    if (!name || !targeting) {
      return res.status(400).json({ error: 'name and targeting are required' });
    }

    // Check audience template limit
    const count = await countUserAudienceTemplates(req.user.id);
    const limit = req.marketingLimits.maxAudienceTemplates;
    if (limit !== -1 && count >= limit) {
      return res.status(403).json({ error: `Audience template limit reached (${count}/${limit})` });
    }

    const template = await createAudienceTemplate({
      userId: req.user.id,
      name, description, targeting,
      platforms: platforms || ['facebook', 'instagram'],
      isDefault: isDefault || false
    });

    res.json({ success: true, audience: template });
  } catch (error) {
    logger.error('Error creating audience:', error);
    res.status(500).json({ error: 'Failed to create audience template' });
  }
});

/**
 * PUT /api/marketing/audiences/:id
 */
router.put('/audiences/:id', async (req, res) => {
  try {
    const template = await getAudienceTemplateById(req.params.id);
    if (!template || template.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Audience template not found' });
    }

    const updated = await updateAudienceTemplate(req.params.id, req.body);
    res.json({ success: true, audience: updated });
  } catch (error) {
    logger.error('Error updating audience:', error);
    res.status(500).json({ error: 'Failed to update audience template' });
  }
});

/**
 * DELETE /api/marketing/audiences/:id
 */
router.delete('/audiences/:id', async (req, res) => {
  try {
    const template = await getAudienceTemplateById(req.params.id);
    if (!template || template.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Audience template not found' });
    }

    await deleteAudienceTemplate(req.params.id);
    res.json({ success: true, message: 'Audience template deleted' });
  } catch (error) {
    logger.error('Error deleting audience:', error);
    res.status(500).json({ error: 'Failed to delete audience template' });
  }
});

/**
 * POST /api/marketing/audiences/estimate-reach
 */
router.post('/audiences/estimate-reach', async (req, res) => {
  try {
    const { targeting } = req.body;
    if (!targeting) {
      return res.status(400).json({ error: 'targeting is required' });
    }

    const reach = await marketingService.estimateReach(req.user.id, targeting);
    res.json({ success: true, ...reach });
  } catch (error) {
    logger.error('Error estimating reach:', error);
    res.status(500).json({ error: error.message || 'Failed to estimate reach' });
  }
});

/**
 * GET /api/marketing/interests/search
 */
router.get('/interests/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters' });
    }

    const interests = await marketingService.searchInterests(req.user.id, q);
    res.json({ success: true, interests });
  } catch (error) {
    logger.error('Error searching interests:', error);
    res.status(500).json({ error: 'Failed to search interests' });
  }
});

/**
 * GET /api/marketing/locations/search
 */
router.get('/locations/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters' });
    }

    const locations = await marketingService.searchLocations(req.user.id, q);
    res.json({ success: true, locations });
  } catch (error) {
    logger.error('Error searching locations:', error);
    res.status(500).json({ error: 'Failed to search locations' });
  }
});

// ============================================
// AUTO-BOOST RULES
// ============================================

/**
 * GET /api/marketing/rules
 */
router.get('/rules', async (req, res) => {
  try {
    const rules = await getUserMarketingRules(req.user.id);
    res.json({ success: true, rules });
  } catch (error) {
    logger.error('Error getting rules:', error);
    res.status(500).json({ error: 'Failed to get marketing rules' });
  }
});

/**
 * POST /api/marketing/rules
 */
router.post('/rules', async (req, res) => {
  try {
    const { name, ruleType, conditions, actions, appliesTo, cooldownHours } = req.body;

    if (!name || !ruleType || !conditions || !actions) {
      return res.status(400).json({ error: 'name, ruleType, conditions, and actions are required' });
    }

    // Check rule limit
    const count = await countUserMarketingRules(req.user.id);
    const limit = req.marketingLimits.maxAutoBoostRules;
    if (limit !== -1 && count >= limit) {
      return res.status(403).json({ error: `Rule limit reached (${count}/${limit})` });
    }

    const rule = await createMarketingRule({
      userId: req.user.id,
      name, ruleType, conditions, actions,
      appliesTo: appliesTo || {},
      cooldownHours: cooldownHours || 24
    });

    res.json({ success: true, rule });
  } catch (error) {
    logger.error('Error creating rule:', error);
    res.status(500).json({ error: 'Failed to create marketing rule' });
  }
});

/**
 * PUT /api/marketing/rules/:id
 */
router.put('/rules/:id', async (req, res) => {
  try {
    const rule = await getMarketingRuleById(req.params.id);
    if (!rule || rule.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Rule not found' });
    }

    const updated = await updateMarketingRule(req.params.id, req.body);
    res.json({ success: true, rule: updated });
  } catch (error) {
    logger.error('Error updating rule:', error);
    res.status(500).json({ error: 'Failed to update marketing rule' });
  }
});

/**
 * DELETE /api/marketing/rules/:id
 */
router.delete('/rules/:id', async (req, res) => {
  try {
    const rule = await getMarketingRuleById(req.params.id);
    if (!rule || rule.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Rule not found' });
    }

    await deleteMarketingRule(req.params.id);
    res.json({ success: true, message: 'Rule deleted' });
  } catch (error) {
    logger.error('Error deleting rule:', error);
    res.status(500).json({ error: 'Failed to delete marketing rule' });
  }
});

/**
 * GET /api/marketing/rules/:id/history
 */
router.get('/rules/:id/history', async (req, res) => {
  try {
    const rule = await getMarketingRuleById(req.params.id);
    if (!rule || rule.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Rule not found' });
    }

    const limit = parseInt(req.query.limit) || 50;
    const history = await getRuleTriggerHistory(req.params.id, limit);
    res.json({ success: true, history });
  } catch (error) {
    logger.error('Error getting rule history:', error);
    res.status(500).json({ error: 'Failed to get rule trigger history' });
  }
});

// ============================================
// ANALYTICS & METRICS
// ============================================

/**
 * GET /api/marketing/analytics/overview
 */
router.get('/analytics/overview', async (req, res) => {
  try {
    const startDate = req.query.startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const endDate = req.query.endDate || new Date().toISOString().split('T')[0];
    const adAccountId = req.query.adAccountId || null;

    const overview = await marketingService.getAnalyticsOverview(req.user.id, startDate, endDate, adAccountId);

    // Also get active campaign count and total ads, filtered by ad account
    const filters = {};
    if (adAccountId) filters.adAccountId = adAccountId;
    const campaigns = await getUserCampaigns(req.user.id, filters);
    const activeCampaigns = campaigns.filter(c => c.status === 'active').length;
    const adFilters = { status: 'active' };
    if (adAccountId) adFilters.adAccountId = adAccountId;
    const ads = await getUserAds(req.user.id, adFilters);

    res.json({
      success: true,
      overview: {
        ...overview,
        activeCampaigns,
        totalCampaigns: campaigns.length,
        activeAds: ads.length
      },
      dateRange: { startDate, endDate }
    });
  } catch (error) {
    const safeMsg = typeof error.message === 'string' && error.message.includes('<!DOCTYPE')
      ? 'Supabase infrastructure error (HTML response)'
      : error.message;
    logger.error(`Error getting analytics overview: ${safeMsg}`);
    res.status(500).json({ error: 'Failed to get analytics overview' });
  }
});

/**
 * GET /api/marketing/analytics/campaigns/:id
 */
router.get('/analytics/campaigns/:id', async (req, res) => {
  try {
    const startDate = req.query.startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const endDate = req.query.endDate || new Date().toISOString().split('T')[0];

    const metrics = await marketingService.getCampaignMetricsTrend(req.user.id, req.params.id, startDate, endDate);
    res.json({ success: true, metrics, dateRange: { startDate, endDate } });
  } catch (error) {
    logger.error('Error getting campaign metrics:', error);
    res.status(500).json({ error: error.message || 'Failed to get campaign metrics' });
  }
});

/**
 * POST /api/marketing/sync-metrics
 * Force a metrics sync from Meta
 */
router.post('/sync-metrics', async (req, res) => {
  try {
    const result = await marketingService.syncMetricsForUser(req.user.id);
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('Error syncing metrics:', error);
    res.status(500).json({ error: error.message || 'Failed to sync metrics' });
  }
});

// ============================================
// BRAND VOICE
// ============================================

/**
 * GET /api/marketing/brand-voice/profiles
 * List user's brand voice profiles
 */
router.get('/brand-voice/profiles', async (req, res) => {
  try {
    logger.info(`[BrandVoice] GET /profiles - user=${req.user.id}`);
    const profiles = await getUserBrandVoiceProfiles(req.user.id);
    logger.info(`[BrandVoice] GET /profiles - returning ${profiles.length} profiles`);
    res.json({ profiles });
  } catch (error) {
    logger.error(`[BrandVoice] GET /profiles failed: ${error.message}`);
    res.status(500).json({ error: error.message || 'Failed to list profiles' });
  }
});

/**
 * GET /api/marketing/brand-voice/profiles/:id
 * Get a single brand voice profile with its analyzed data
 */
router.get('/brand-voice/profiles/:id', async (req, res) => {
  try {
    const profile = await getBrandVoiceProfileById(req.params.id, req.user.id);
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    res.json({ profile });
  } catch (error) {
    logger.error(`[BrandVoice] GET /profiles/${req.params.id} failed: ${error.message}`);
    res.status(500).json({ error: error.message || 'Failed to get profile' });
  }
});

/**
 * POST /api/marketing/brand-voice/profiles
 * Create a new brand voice profile and start the learning pipeline
 */
router.post('/brand-voice/profiles', async (req, res) => {
  try {
    const { name, days, platforms } = req.body;
    logger.info(`[BrandVoice] POST /profiles - user=${req.user.id}, name="${name}", platforms=${platforms ? JSON.stringify(platforms) : 'all'}, days=${days || 180}`);

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'Profile name is required' });
    }

    // Validate platforms array if provided
    const validPlatforms = ['twitter', 'linkedin', 'facebook', 'instagram', 'reddit', 'telegram', 'threads', 'whatsapp', 'tiktok'];
    let selectedPlatforms = null;
    if (platforms && Array.isArray(platforms) && platforms.length > 0) {
      selectedPlatforms = platforms.filter(p => validPlatforms.includes(p));
      if (selectedPlatforms.length === 0) {
        return res.status(400).json({ error: 'At least one valid platform must be selected' });
      }
    }

    // Check limits
    const currentCount = await countUserBrandVoiceProfiles(req.user.id);
    const limits = req.marketingLimits;
    const maxProfiles = limits.maxBrandVoiceProfiles || 2;
    if (maxProfiles !== -1 && currentCount >= maxProfiles) {
      return res.status(403).json({
        error: `Brand voice profile limit reached (${maxProfiles}). Upgrade your marketing plan for more.`,
        currentCount,
        limit: maxProfiles
      });
    }

    // Create profile record
    const profile = await createBrandVoiceProfile(req.user.id, name.trim());

    // Store selected platforms if specified
    if (selectedPlatforms) {
      await updateBrandVoiceProfile(profile.id, req.user.id, { selected_platforms: selectedPlatforms });
    }

    // Start the learning pipeline asynchronously with platform filter
    // The client will poll for status updates
    brandVoiceService.buildProfile(req.user.id, profile.id, days || 180, selectedPlatforms)
      .catch(err => {
        logger.error(`[BrandVoice] Background profile build failed for ${profile.id}: ${err.message}`);
      });

    logger.info(`[BrandVoice] Profile created: id=${profile.id}, pipeline started`);

    res.status(201).json({
      profile: { ...profile, selected_platforms: selectedPlatforms },
      message: 'Profile created. Post collection and analysis started — poll the profile endpoint for status updates.'
    });
  } catch (error) {
    logger.error(`[BrandVoice] POST /profiles failed: ${error.message}`);
    res.status(500).json({ error: error.message || 'Failed to create profile' });
  }
});

/**
 * PATCH /api/marketing/brand-voice/profiles/:id
 * Update profile name or manually adjust voice data
 */
router.patch('/brand-voice/profiles/:id', async (req, res) => {
  try {
    logger.info(`[BrandVoice] PATCH /profiles/${req.params.id} - user=${req.user.id}, fields=${Object.keys(req.body).join(', ')}`);
    const profile = await getBrandVoiceProfileById(req.params.id, req.user.id);
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    const allowedFields = ['name', 'profile_data'];
    const updates = {};

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const updated = await updateBrandVoiceProfile(req.params.id, req.user.id, updates);
    logger.info(`[BrandVoice] PATCH /profiles/${req.params.id} - updated fields: ${Object.keys(updates).join(', ')}`);
    res.json({ profile: updated });
  } catch (error) {
    logger.error(`[BrandVoice] PATCH /profiles/${req.params.id} failed: ${error.message}`);
    res.status(500).json({ error: error.message || 'Failed to update profile' });
  }
});

/**
 * DELETE /api/marketing/brand-voice/profiles/:id
 * Delete a brand voice profile and all its collected posts
 */
router.delete('/brand-voice/profiles/:id', async (req, res) => {
  try {
    logger.info(`[BrandVoice] DELETE /profiles/${req.params.id} - user=${req.user.id}`);
    const profile = await getBrandVoiceProfileById(req.params.id, req.user.id);
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    await deleteBrandVoiceProfile(req.params.id, req.user.id);
    logger.info(`[BrandVoice] Profile ${req.params.id} deleted`);
    res.json({ success: true, message: 'Profile deleted' });
  } catch (error) {
    logger.error(`[BrandVoice] DELETE /profiles/${req.params.id} failed: ${error.message}`);
    res.status(500).json({ error: error.message || 'Failed to delete profile' });
  }
});

/**
 * POST /api/marketing/brand-voice/profiles/:id/refresh
 * Re-collect posts and re-analyze the brand voice
 */
router.post('/brand-voice/profiles/:id/refresh', async (req, res) => {
  try {
    logger.info(`[BrandVoice] POST /profiles/${req.params.id}/refresh - user=${req.user.id}`);
    const profile = await getBrandVoiceProfileById(req.params.id, req.user.id);
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    if (profile.status === 'collecting' || profile.status === 'analyzing') {
      return res.status(409).json({ error: 'Profile is already being processed' });
    }

    const { days } = req.body;

    // Reset status and start refresh asynchronously
    await updateBrandVoiceProfile(req.params.id, req.user.id, { status: 'pending' });

    brandVoiceService.refreshProfile(req.user.id, req.params.id, days || 180)
      .catch(err => {
        logger.error(`[BrandVoice] Background profile refresh failed for ${req.params.id}: ${err.message}`);
      });

    logger.info(`[BrandVoice] Profile ${req.params.id} refresh started`);
    res.json({ success: true, message: 'Profile refresh started. Poll the profile endpoint for status updates.' });
  } catch (error) {
    logger.error(`[BrandVoice] POST /profiles/${req.params.id}/refresh failed: ${error.message}`);
    res.status(500).json({ error: error.message || 'Failed to refresh profile' });
  }
});

/**
 * GET /api/marketing/brand-voice/profiles/:id/posts
 * View the collected posts for a profile
 */
router.get('/brand-voice/profiles/:id/posts', async (req, res) => {
  try {
    const profile = await getBrandVoiceProfileById(req.params.id, req.user.id);
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    const { platform, limit } = req.query;
    const posts = await getBrandVoicePosts(
      req.params.id,
      req.user.id,
      { platform, limit: parseInt(limit) || 100 }
    );

    res.json({ posts, total: posts.length });
  } catch (error) {
    logger.error('Error getting brand voice posts:', error);
    res.status(500).json({ error: error.message || 'Failed to get posts' });
  }
});

/**
 * POST /api/marketing/brand-voice/generate
 * Generate original post(s) using a brand voice profile
 */
router.post('/brand-voice/generate', async (req, res) => {
  try {
    const { profileId, platform, topic, count } = req.body;
    logger.info(`[BrandVoice] POST /generate - user=${req.user.id}, profileId=${profileId}, platform=${platform || 'auto'}, topic=${topic || 'auto'}`);

    if (!profileId) {
      return res.status(400).json({ error: 'profileId is required' });
    }

    // Platform is optional — if not provided, the service auto-detects the dominant platform
    if (platform) {
      const validPlatforms = ['twitter', 'linkedin', 'facebook', 'instagram', 'reddit', 'telegram', 'threads', 'whatsapp', 'tiktok'];
      if (!validPlatforms.includes(platform)) {
        return res.status(400).json({ error: `Invalid platform. Must be one of: ${validPlatforms.join(', ')}` });
      }
    }

    const generatedPosts = await brandVoiceService.generateOriginalPost(
      req.user.id,
      profileId,
      {
        platform: platform || null,
        topic: topic || null,
        count: Math.min(parseInt(count) || 1, 3) // Max 3 variations per request
      }
    );

    // Store each generated post in history
    const postsWithIds = await Promise.all(generatedPosts.map(async (post) => {
      try {
        const row = await insertBrandVoiceGeneratedPost(req.user.id, profileId, {
          platform: post.platform,
          topic: post.topic,
          content: post.text
        });
        return { ...post, id: row.id };
      } catch (storeErr) {
        logger.error(`[BrandVoice] Failed to store generated post: ${storeErr.message}`);
        return post; // Return without id if storage fails — non-blocking
      }
    }));

    logger.info(`[BrandVoice] POST /generate - generated ${postsWithIds.length} post(s) on ${postsWithIds[0]?.platform || 'unknown'}`);
    res.json({ posts: postsWithIds });
  } catch (error) {
    logger.error(`[BrandVoice] POST /generate failed: ${error.message}`);
    res.status(error.message.includes('not found') ? 404 : 500).json({
      error: error.message || 'Failed to generate content'
    });
  }
});

/**
 * GET /api/marketing/brand-voice/profiles/:profileId/generated
 * Get generated posts history for a profile
 */
router.get('/brand-voice/profiles/:profileId/generated', async (req, res) => {
  try {
    const { profileId } = req.params;
    logger.info(`[BrandVoice] GET /profiles/${profileId}/generated - user=${req.user.id}`);

    const posts = await getBrandVoiceGeneratedPosts(profileId, req.user.id);

    logger.info(`[BrandVoice] GET /profiles/${profileId}/generated - returned ${posts.length} post(s)`);
    res.json({ posts });
  } catch (error) {
    logger.error(`[BrandVoice] GET /profiles/:profileId/generated failed: ${error.message}`);
    res.status(500).json({ error: error.message || 'Failed to load generated posts history' });
  }
});

/**
 * DELETE /api/marketing/brand-voice/generated/:postId
 * Delete a single generated post from history
 */
router.delete('/brand-voice/generated/:postId', async (req, res) => {
  try {
    const { postId } = req.params;
    logger.info(`[BrandVoice] DELETE /generated/${postId} - user=${req.user.id}`);

    await deleteBrandVoiceGeneratedPost(postId, req.user.id);

    logger.info(`[BrandVoice] DELETE /generated/${postId} - deleted`);
    res.json({ success: true });
  } catch (error) {
    logger.error(`[BrandVoice] DELETE /generated/:postId failed: ${error.message}`);
    res.status(500).json({ error: error.message || 'Failed to delete generated post' });
  }
});

export default router;
