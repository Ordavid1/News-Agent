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
import multer from 'multer';
import { authenticateToken } from '../middleware/auth.js';
import { csrfProtection } from '../middleware/csrf.js';
import { requireMarketingAddon } from '../middleware/subscription.js';
import marketingService from '../services/MarketingService.js';
import brandVoiceService from '../services/BrandVoiceService.js';
import mediaAssetService from '../services/MediaAssetService.js';
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
  deleteBrandVoiceGeneratedPost,
  updateBrandVoiceGeneratedPost,
  getPerUsePurchase,
  updatePerUsePurchase,
  getAssetImageGenCredits,
  consumeAssetImageGenCredit
} from '../services/database-wrapper.js';
import winston from 'winston';

const router = express.Router();

// Multer config for media asset uploads (memory storage, no disk)
const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB per file
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${file.mimetype}. Allowed: JPEG, PNG, WebP`));
    }
  }
});

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

/**
 * Resolve the ad account from the request.
 * Checks query param (GET) or body (POST/PUT), falls back to user's selected account.
 * Returns the DB UUID of the ad account, or null if none available.
 */
async function resolveAdAccountId(req) {
  const explicit = req.query.adAccountId || req.body?.adAccountId;
  if (explicit) return explicit;
  const selected = await getSelectedAdAccount(req.user.id);
  return selected ? selected.id : null;
}

// ============================================
// AD ACCOUNT MANAGEMENT
// ============================================

/**
 * GET /api/marketing/ad-accounts
 * List user's ad accounts
 */
router.get('/ad-accounts', async (req, res) => {
  try {
    // Always return stored ad accounts from DB so users can access their saved
    // marketing data (audiences, rules, brand voice, brand assets) even when
    // the Facebook connection is temporarily inactive (token expired, etc.).
    const accounts = await getUserAdAccounts(req.user.id);

    // Check Facebook connection status separately — this controls whether
    // Meta-specific features (boosting, campaign sync, audience sync) are available,
    // but should NOT block access to locally-stored marketing data.
    const TokenManager = (await import('../services/TokenManager.js')).default;
    const connection = await TokenManager.getConnectionStatus(req.user.id, 'facebook');
    const facebookActive = connection && connection.status === 'active';
    const marketingEnabled = connection?.platform_metadata?.marketingEnabled === true;

    if (!facebookActive) {
      logger.info(`[ad-accounts] Facebook connection status for user ${req.user.id}: ${connection?.status || 'null'}`);
    }

    res.json({
      success: true,
      accounts,
      marketingEnabled,
      needsConnection: !facebookActive && accounts.length === 0,
      facebookActive
    });
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
    const days = parseInt(req.query.days) || 0;
    const posts = await getBoostablePublishedPosts(req.user.id, limit, days);
    res.json({ success: true, posts });
  } catch (error) {
    logger.error('Error getting boostable posts:', error);
    res.status(500).json({ error: 'Failed to get boostable posts' });
  }
});

/**
 * GET /api/marketing/page-posts
 * Fetch posts directly from Meta (Facebook Page + Instagram) for the last N days.
 * Includes ALL posts, not just those published through this app.
 */
router.get('/page-posts', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;

    // Fetch Facebook and Instagram posts in parallel — settle both so one
    // failing doesn't block the other (e.g. user has FB but no IG connection).
    const [fbResult, igResult] = await Promise.allSettled([
      marketingService.fetchPagePosts(req.user.id, days),
      marketingService.fetchInstagramPosts(req.user.id, days)
    ]);

    const fbPosts = fbResult.status === 'fulfilled' ? fbResult.value : [];
    const igPosts = igResult.status === 'fulfilled' ? igResult.value : [];

    if (fbResult.status === 'rejected') {
      logger.warn('Failed to fetch Facebook page posts:', fbResult.reason?.message);
    }
    if (igResult.status === 'rejected') {
      logger.warn('Failed to fetch Instagram posts:', igResult.reason?.message);
    }

    const posts = [...fbPosts, ...igPosts];
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
    const adAccountId = await resolveAdAccountId(req);
    if (!adAccountId) {
      return res.json({ success: true, audiences: [] });
    }
    const templates = await getUserAudienceTemplates(req.user.id, { adAccountId });
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
    const adAccountId = await resolveAdAccountId(req);
    if (!adAccountId) {
      return res.status(400).json({ error: 'No ad account selected. Please select an ad account first.' });
    }

    const { name, description, targeting, platforms, isDefault } = req.body;

    if (!name || !targeting) {
      return res.status(400).json({ error: 'name and targeting are required' });
    }

    // Check audience template limit (scoped to ad account)
    const count = await countUserAudienceTemplates(req.user.id, adAccountId);
    const limit = req.marketingLimits.maxAudienceTemplates;
    if (limit !== -1 && count >= limit) {
      return res.status(403).json({ error: `Audience template limit reached (${count}/${limit})` });
    }

    const template = await createAudienceTemplate({
      userId: req.user.id,
      adAccountId,
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

    // Propagate edits to Meta if this audience is synced
    if (template.source === 'synced' && template.fb_audience_id) {
      try {
        await marketingService.updateAudienceOnMeta(req.user.id, req.params.id);
      } catch (metaErr) {
        logger.warn(`Failed to propagate audience update to Meta: ${metaErr.message}`);
      }
    }

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

    // Clean up from Meta if synced
    if (template.source === 'synced' && template.fb_audience_id) {
      try {
        await marketingService.deleteAudienceFromMeta(req.user.id, req.params.id);
      } catch (metaErr) {
        logger.warn(`Failed to delete audience from Meta (proceeding with local delete): ${metaErr.message}`);
      }
    }

    await deleteAudienceTemplate(req.params.id);
    res.json({ success: true, message: 'Audience template deleted' });
  } catch (error) {
    logger.error('Error deleting audience:', error);
    res.status(500).json({ error: 'Failed to delete audience template' });
  }
});

/**
 * POST /api/marketing/audiences/:id/push-to-meta
 * Push a local audience template to Meta as a Saved Audience
 */
router.post('/audiences/:id/push-to-meta', async (req, res) => {
  try {
    const template = await getAudienceTemplateById(req.params.id);
    if (!template || template.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Audience template not found' });
    }

    const updated = await marketingService.pushAudienceToMeta(req.user.id, req.params.id);
    res.json({ success: true, audience: updated });
  } catch (error) {
    logger.error('Error pushing audience to Meta:', error);
    res.status(error.message?.includes('Only locally') ? 400 : 500)
      .json({ error: error.message || 'Failed to push audience to Meta' });
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
    const adAccountId = await resolveAdAccountId(req);
    if (!adAccountId) {
      return res.json({ success: true, rules: [] });
    }
    const rules = await getUserMarketingRules(req.user.id, { adAccountId });
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
    const adAccountId = await resolveAdAccountId(req);
    if (!adAccountId) {
      return res.status(400).json({ error: 'No ad account selected. Please select an ad account first.' });
    }

    const { name, ruleType, conditions, actions, appliesTo, cooldownHours } = req.body;

    if (!name || !ruleType || !conditions || !actions) {
      return res.status(400).json({ error: 'name, ruleType, conditions, and actions are required' });
    }

    // Check rule limit (scoped to ad account)
    const count = await countUserMarketingRules(req.user.id, adAccountId);
    const limit = req.marketingLimits.maxAutoBoostRules;
    if (limit !== -1 && count >= limit) {
      return res.status(403).json({ error: `Rule limit reached (${count}/${limit})` });
    }

    const rule = await createMarketingRule({
      userId: req.user.id,
      adAccountId,
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

    // Propagate edits to Meta if this rule is synced
    if (rule.meta_rule_id && rule.meta_sync_status === 'synced') {
      try {
        await marketingService.updateRuleOnMeta(req.user.id, req.params.id);
      } catch (metaErr) {
        logger.warn(`Failed to propagate rule update to Meta: ${metaErr.message}`);
        // Mark sync as errored but don't fail the local update
        await updateMarketingRule(req.params.id, { meta_sync_status: 'error' });
      }
    }

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

    // Clean up from Meta if synced
    if (rule.meta_rule_id) {
      try {
        await marketingService.deleteRuleFromMeta(req.user.id, req.params.id);
      } catch (metaErr) {
        logger.warn(`Failed to delete rule from Meta (proceeding with local delete): ${metaErr.message}`);
      }
    }

    await deleteMarketingRule(req.params.id);
    res.json({ success: true, message: 'Rule deleted' });
  } catch (error) {
    logger.error('Error deleting rule:', error);
    res.status(500).json({ error: 'Failed to delete marketing rule' });
  }
});

/**
 * POST /api/marketing/rules/:id/push-to-meta
 * Push a pause_if or budget_adjust rule to Meta's Ad Rules API.
 * Auto-boost rules cannot be pushed (they evaluate organic metrics).
 */
router.post('/rules/:id/push-to-meta', async (req, res) => {
  try {
    const rule = await getMarketingRuleById(req.params.id);
    if (!rule || rule.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Rule not found' });
    }

    const updated = await marketingService.pushRuleToMeta(req.user.id, req.params.id);
    res.json({ success: true, rule: updated });
  } catch (error) {
    logger.error('Error pushing rule to Meta:', error);
    const status = error.message?.includes('Auto-boost') || error.message?.includes('already synced') ? 400 : 500;
    res.status(status).json({ error: error.message || 'Failed to push rule to Meta' });
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
    const adAccountId = await resolveAdAccountId(req);
    const filters = {};
    if (adAccountId) filters.adAccountId = adAccountId;

    logger.info(`[BrandVoice] GET /profiles - user=${req.user.id}, adAccount=${adAccountId || 'none'}`);
    const profiles = await getUserBrandVoiceProfiles(req.user.id, filters);
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
    const adAccountId = await resolveAdAccountId(req);
    if (!adAccountId) {
      return res.status(400).json({ error: 'No ad account selected. Please select an ad account first.' });
    }

    const { name, days, platforms } = req.body;
    logger.info(`[BrandVoice] POST /profiles - user=${req.user.id}, adAccount=${adAccountId}, name="${name}", platforms=${platforms ? JSON.stringify(platforms) : 'all'}, days=${days || 180}`);

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

    // Check limits (scoped to ad account)
    const currentCount = await countUserBrandVoiceProfiles(req.user.id, adAccountId);
    const limits = req.marketingLimits;
    const maxProfiles = limits.maxBrandVoiceProfiles || 2;
    if (maxProfiles !== -1 && currentCount >= maxProfiles) {
      return res.status(403).json({
        error: `Brand voice profile limit reached (${maxProfiles}). Upgrade your marketing plan for more.`,
        currentCount,
        limit: maxProfiles
      });
    }

    // Create profile record (scoped to ad account)
    const profile = await createBrandVoiceProfile(req.user.id, name.trim(), adAccountId);

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
    const { profileId, platform, topic, count, generateWithImage, purchaseId, loraScale, guidanceScale, aspectRatio } = req.body;
    logger.info(`[BrandVoice] POST /generate - user=${req.user.id}, profileId=${profileId}, platform=${platform || 'auto'}, topic=${topic || 'auto'}, withImage=${!!generateWithImage}`);

    if (!profileId) {
      return res.status(400).json({ error: 'profileId is required' });
    }

    // If generating with image, verify the per-use purchase ($0.75)
    if (generateWithImage) {
      if (!purchaseId) {
        return res.status(402).json({ error: 'Image generation requires a $0.75 per-use purchase', code: 'PURCHASE_REQUIRED' });
      }

      const purchase = await getPerUsePurchase(purchaseId, req.user.id);
      if (!purchase) {
        return res.status(404).json({ error: 'Purchase not found' });
      }
      if (purchase.purchase_type !== 'image_generation') {
        return res.status(400).json({ error: 'Invalid purchase type for image generation' });
      }
      if (purchase.status !== 'completed') {
        return res.status(402).json({ error: 'Purchase payment not completed', code: 'PURCHASE_PENDING' });
      }
      if (purchase.reference_id) {
        return res.status(409).json({ error: 'This purchase has already been used' });
      }

      // Pre-flight: verify ad account and trained model exist before generating text
      const preflightAdAccount = await getSelectedAdAccount(req.user.id);
      if (!preflightAdAccount) {
        return res.status(400).json({ error: 'No ad account selected. Please select an ad account in Brand Media first.' });
      }
      const preflightDefaultJob = await mediaAssetService.getDefaultTrainingJob(req.user.id, preflightAdAccount.id);
      if (!preflightDefaultJob) {
        return res.status(400).json({ error: 'No trained model available. Train a model in Brand Media first.' });
      }
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

    // If image generation was purchased, generate a brand-consistent image using the default LoRA model
    if (generateWithImage && purchaseId && postsWithIds[0]?.id) {
      try {
        // Mark purchase as consumed first
        await updatePerUsePurchase(purchaseId, {
          reference_id: postsWithIds[0].id,
          reference_type: 'brand_voice_generated_post'
        });

        // Get the user's selected ad account
        const adAccount = await getSelectedAdAccount(req.user.id);
        if (!adAccount) {
          logger.warn(`[BrandVoice] No ad account selected — skipping image generation`);
          postsWithIds[0].imageError = true;
          postsWithIds[0].imageErrorMessage = 'No ad account selected. Please select an ad account in Brand Media first.';
        } else {
          // Get the default LoRA model
          const defaultJob = await mediaAssetService.getDefaultTrainingJob(req.user.id, adAccount.id);
          if (!defaultJob) {
            logger.warn(`[BrandVoice] No default training model — skipping image generation`);
            postsWithIds[0].imageError = true;
            postsWithIds[0].imageErrorMessage = 'No trained model available. Train a model in Brand Media first.';
          } else {
            // Generate an image prompt from the post text using the brand voice profile
            const profile = await getBrandVoiceProfileById(profileId, req.user.id);
            const imagePrompt = await brandVoiceService.generateImagePrompt(
              postsWithIds[0].text,
              defaultJob.trigger_word,
              profile?.profile_data || {}
            );

            // Generate the image using the LoRA model (pass through user's generation preferences)
            const generatedMedia = await mediaAssetService.generateImage(
              req.user.id,
              adAccount.id,
              imagePrompt,
              defaultJob.id,
              {
                loraScale: loraScale != null ? parseFloat(loraScale) : undefined,
                guidanceScale: guidanceScale != null ? parseFloat(guidanceScale) : undefined,
                aspectRatio: aspectRatio || undefined
              }
            );

            // Attach image URL to the post response
            postsWithIds[0].imageUrl = generatedMedia.public_url;

            // Update the DB record with the image
            await updateBrandVoiceGeneratedPost(postsWithIds[0].id, req.user.id, {
              image_url: generatedMedia.public_url,
              generated_media_id: generatedMedia.id
            });

            logger.info(`[BrandVoice] Image generated successfully: ${generatedMedia.public_url}`);
          }
        }
      } catch (imageErr) {
        // Image generation failed — still return the text post
        logger.error(`[BrandVoice] Image generation failed: ${imageErr.message}`);
        postsWithIds[0].imageError = true;
        postsWithIds[0].imageErrorMessage = `Image generation failed: ${imageErr.message}`;
      }
    }

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

// ============================================
// MEDIA ASSETS
// ============================================

/**
 * POST /api/marketing/media-assets/upload
 * Upload reference images for LoRA training.
 * Accepts up to 20 images per request.
 */
router.post('/media-assets/upload', mediaUpload.array('images', 20), async (req, res) => {
  try {
    const { adAccountId } = req.body;
    if (!adAccountId) {
      return res.status(400).json({ error: 'adAccountId is required' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    logger.info(`[MediaAssets] POST /upload - user=${req.user.id}, account=${adAccountId}, files=${req.files.length}`);

    const results = [];
    const errors = [];
    const warnings = [];

    for (const file of req.files) {
      try {
        const asset = await mediaAssetService.uploadAsset(req.user.id, adAccountId, file);
        if (asset.warning) {
          warnings.push({ file: file.originalname, warning: asset.warning });
        }
        results.push(asset);
      } catch (err) {
        errors.push({ file: file.originalname, error: err.message });
      }
    }

    logger.info(`[MediaAssets] POST /upload - uploaded ${results.length}, errors ${errors.length}, warnings ${warnings.length}`);
    res.json({ assets: results, errors, warnings, uploaded: results.length });
  } catch (error) {
    logger.error(`[MediaAssets] POST /upload failed: ${error.message}`);
    res.status(500).json({ error: error.message || 'Upload failed' });
  }
});

/**
 * GET /api/marketing/media-assets
 * List uploaded assets for an ad account.
 */
router.get('/media-assets', async (req, res) => {
  try {
    const { adAccountId } = req.query;
    if (!adAccountId) {
      return res.status(400).json({ error: 'adAccountId query parameter is required' });
    }

    const assets = await mediaAssetService.getAssets(req.user.id, adAccountId);
    const count = assets.length;

    res.json({ assets, count });
  } catch (error) {
    logger.error(`[MediaAssets] GET /media-assets failed: ${error.message}`);
    res.status(500).json({ error: error.message || 'Failed to load assets' });
  }
});

/**
 * DELETE /api/marketing/media-assets/:id
 * Delete a single uploaded asset.
 */
router.delete('/media-assets/:id', async (req, res) => {
  try {
    const { id } = req.params;
    logger.info(`[MediaAssets] DELETE /media-assets/${id} - user=${req.user.id}`);

    const deleted = await mediaAssetService.deleteAsset(id, req.user.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    res.json({ success: true });
  } catch (error) {
    logger.error(`[MediaAssets] DELETE /media-assets/:id failed: ${error.message}`);
    res.status(500).json({ error: error.message || 'Failed to delete asset' });
  }
});

/**
 * POST /api/marketing/media-assets/training/start
 * Start model creation — either LoRA training or FLUX.2 Pro reference-image model.
 * Accepts { adAccountId, name, purchaseId, trainingType, generationModel }
 *   generationModel: 'lora' (default) or 'flux-2-pro'
 */
router.post('/media-assets/training/start', async (req, res) => {
  try {
    const { adAccountId, name, purchaseId, trainingType, generationModel } = req.body;
    if (!adAccountId) {
      return res.status(400).json({ error: 'adAccountId is required' });
    }

    // Validate session name
    const sessionName = (name || '').trim();
    if (!sessionName) {
      return res.status(400).json({ error: 'Model name is required' });
    }
    if (sessionName.length > 100) {
      return res.status(400).json({ error: 'Model name must be 100 characters or less' });
    }

    // Determine model creation path
    const isFlux2Pro = generationModel === 'flux-2-pro';

    // Validate training type (only relevant for LoRA path)
    const validTrainingType = ['style', 'subject'].includes(trainingType) ? trainingType : 'subject';

    // Verify per-use purchase ($5 charge)
    if (!purchaseId) {
      return res.status(402).json({ error: 'Model creation requires a $5 per-use purchase', code: 'PURCHASE_REQUIRED' });
    }

    const purchase = await getPerUsePurchase(purchaseId, req.user.id);
    if (!purchase) {
      return res.status(404).json({ error: 'Purchase not found' });
    }
    if (purchase.purchase_type !== 'model_training') {
      return res.status(400).json({ error: 'Invalid purchase type' });
    }
    if (purchase.status !== 'completed') {
      return res.status(402).json({ error: 'Purchase payment not completed', code: 'PURCHASE_PENDING' });
    }
    if (purchase.reference_id) {
      return res.status(409).json({ error: 'This purchase has already been used' });
    }

    logger.info(`[MediaAssets] POST /training/start - user=${req.user.id}, account=${adAccountId}, name="${sessionName}", model=${isFlux2Pro ? 'flux-2-pro' : 'lora'}, type=${validTrainingType}, purchaseId=${purchaseId}`);

    let job;
    if (isFlux2Pro) {
      // FLUX.2 Pro: create reference-image model instantly (no training)
      job = await mediaAssetService.createFlux2ProModel(req.user.id, adAccountId, sessionName);
    } else {
      // FLUX.1 LoRA: start Replicate training (5-10 min)
      job = await mediaAssetService.startTraining(req.user.id, adAccountId, sessionName, validTrainingType);
    }

    // Mark purchase as consumed
    await updatePerUsePurchase(purchaseId, {
      reference_id: job.id,
      reference_type: 'media_training_job'
    });

    logger.info(`[MediaAssets] Model created: job=${job.id}, model=${isFlux2Pro ? 'flux-2-pro' : 'lora'}, purchase=${purchaseId}`);
    res.json({ job });
  } catch (error) {
    logger.error(`[MediaAssets] POST /training/start failed: ${error.message}`);
    const status = error.message.includes('At least') || error.message.includes('already in progress')
      ? 400 : 500;
    res.status(status).json({ error: error.message || 'Failed to create model' });
  }
});

/**
 * GET /api/marketing/media-assets/training/status
 * Get training job status. Accepts optional jobId for specific job,
 * otherwise returns the active (in-progress) job for the account.
 */
router.get('/media-assets/training/status', async (req, res) => {
  try {
    const { adAccountId, jobId } = req.query;
    if (!adAccountId) {
      return res.status(400).json({ error: 'adAccountId query parameter is required' });
    }

    let job = null;

    if (jobId) {
      // Specific job requested
      job = await mediaAssetService.getTrainingJobById(jobId, req.user.id);
    } else {
      // Find the active training for this account (if any)
      job = await mediaAssetService.getActiveTrainingJob(req.user.id, adAccountId);
    }

    // If training is in progress, try to check Replicate for updates
    // but don't fail the entire request if Replicate is unavailable
    if (job && job.status === 'training') {
      try {
        job = await mediaAssetService.checkTrainingStatus(job.id, req.user.id);
      } catch (replicateErr) {
        logger.warn(`[MediaAssets] Replicate status check failed (returning cached job): ${replicateErr.message}`);
      }
    }

    res.json({ job });
  } catch (error) {
    logger.error(`[MediaAssets] GET /training/status failed: ${error.message}`);
    res.status(500).json({ error: error.message || 'Failed to get training status' });
  }
});

/**
 * GET /api/marketing/media-assets/training/history
 * List all training jobs for an ad account (newest first).
 */
router.get('/media-assets/training/history', async (req, res) => {
  try {
    const { adAccountId } = req.query;
    if (!adAccountId) {
      return res.status(400).json({ error: 'adAccountId query parameter is required' });
    }

    const jobs = await mediaAssetService.getTrainingJobs(req.user.id, adAccountId);
    res.json({ jobs });
  } catch (error) {
    logger.error(`[MediaAssets] GET /training/history failed: ${error.message}`);
    res.status(500).json({ error: error.message || 'Failed to get training history' });
  }
});

/**
 * PUT /api/marketing/media-assets/training/:id/set-default
 * Mark a completed training job as the default model for generation.
 */
router.put('/media-assets/training/:id/set-default', async (req, res) => {
  try {
    const { id } = req.params;
    const { adAccountId } = req.body;
    if (!adAccountId) {
      return res.status(400).json({ error: 'adAccountId is required' });
    }

    logger.info(`[MediaAssets] PUT /training/${id}/set-default - user=${req.user.id}, account=${adAccountId}`);

    const job = await mediaAssetService.setDefaultTrainingJob(id, req.user.id, adAccountId);
    res.json({ success: true, job });
  } catch (error) {
    logger.error(`[MediaAssets] PUT /training/:id/set-default failed: ${error.message}`);
    const status = error.code === 'PGRST116' ? 404 : 500;
    res.status(status).json({ error: error.message || 'Failed to set default training' });
  }
});

/**
 * POST /api/marketing/media-assets/generate
 * Generate an image using a specific trained LoRA model.
 * Requires { adAccountId, prompt, trainingJobId }.
 */
router.post('/media-assets/generate', async (req, res) => {
  try {
    const { adAccountId, prompt, trainingJobId, loraScale, guidanceScale, numOutputs, aspectRatio } = req.body;
    if (!adAccountId || !prompt) {
      return res.status(400).json({ error: 'adAccountId and prompt are required' });
    }
    if (!trainingJobId) {
      return res.status(400).json({ error: 'trainingJobId is required — select a trained model first' });
    }

    // Credit gate: check remaining credits against requested image count
    const requestedImages = numOutputs != null ? Math.max(1, Math.min(4, parseInt(numOutputs, 10))) : 1;
    const { totalRemaining } = await getAssetImageGenCredits(req.user.id);
    if (totalRemaining <= 0) {
      return res.status(402).json({
        error: 'No image credits remaining. Purchase a credit pack to continue.',
        code: 'CREDITS_EXHAUSTED',
        credits: 0
      });
    }
    if (totalRemaining < requestedImages) {
      return res.status(402).json({
        error: `Not enough credits. You have ${totalRemaining} image credit${totalRemaining === 1 ? '' : 's'} but requested ${requestedImages} image${requestedImages === 1 ? '' : 's'}.`,
        code: 'INSUFFICIENT_CREDITS',
        credits: totalRemaining
      });
    }

    logger.info(`[MediaAssets] POST /generate - user=${req.user.id}, account=${adAccountId}, job=${trainingJobId}, requested=${requestedImages} images, credits=${totalRemaining}, lora=${loraScale ?? 'default'}, guidance=${guidanceScale ?? 'default'}, aspect=${aspectRatio ?? '1:1'}`);

    const media = await mediaAssetService.generateImage(req.user.id, adAccountId, prompt, trainingJobId, {
      loraScale: loraScale != null ? parseFloat(loraScale) : undefined,
      guidanceScale: guidanceScale != null ? parseFloat(guidanceScale) : undefined,
      numOutputs: requestedImages,
      aspectRatio: aspectRatio || undefined
    });

    // Normalize response: always return array
    const mediaArray = Array.isArray(media) ? media : [media];

    // Consume credits based on actual images generated (not requested — generation may produce fewer)
    const actualImages = mediaArray.length;
    for (let i = 0; i < actualImages; i++) {
      await consumeAssetImageGenCredit(req.user.id);
    }

    // Return updated credit count
    const { totalRemaining: creditsAfter } = await getAssetImageGenCredits(req.user.id);
    logger.info(`[MediaAssets] ${actualImages} image(s) generated, ${actualImages} credit(s) consumed, credits remaining: ${creditsAfter}`);
    res.json({ media: mediaArray, credits: creditsAfter });
  } catch (error) {
    logger.error(`[MediaAssets] POST /generate failed: ${error.message}`);
    const status = error.message.includes('not completed') || error.message.includes('not found') ? 400 : 500;
    res.status(status).json({ error: error.message || 'Failed to generate image' });
  }
});

/**
 * GET /api/marketing/media-assets/generation-credits
 * Return the user's remaining Brand Asset image generation credits.
 */
router.get('/media-assets/generation-credits', async (req, res) => {
  try {
    const { totalRemaining } = await getAssetImageGenCredits(req.user.id);
    res.json({ credits: totalRemaining });
  } catch (error) {
    logger.error(`[MediaAssets] GET /generation-credits failed: ${error.message}`);
    res.status(500).json({ error: 'Failed to get generation credits' });
  }
});

/**
 * GET /api/marketing/media-assets/generated
 * List generated images for an ad account.
 * Accepts optional trainingJobId to filter by training session.
 */
router.get('/media-assets/generated', async (req, res) => {
  try {
    const { adAccountId, trainingJobId } = req.query;
    if (!adAccountId) {
      return res.status(400).json({ error: 'adAccountId query parameter is required' });
    }

    let media;
    if (trainingJobId) {
      media = await mediaAssetService.getGeneratedImagesByJob(req.user.id, adAccountId, trainingJobId);
    } else {
      media = await mediaAssetService.getGeneratedImages(req.user.id, adAccountId);
    }
    res.json({ media });
  } catch (error) {
    logger.error(`[MediaAssets] GET /generated failed: ${error.message}`);
    res.status(500).json({ error: error.message || 'Failed to load generated images' });
  }
});

/**
 * DELETE /api/marketing/media-assets/generated/:id
 * Delete a generated image.
 */
router.delete('/media-assets/generated/:id', async (req, res) => {
  try {
    const { id } = req.params;
    logger.info(`[MediaAssets] DELETE /generated/${id} - user=${req.user.id}`);

    const deleted = await mediaAssetService.deleteGeneratedImage(id, req.user.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Generated image not found' });
    }

    res.json({ success: true });
  } catch (error) {
    logger.error(`[MediaAssets] DELETE /generated/:id failed: ${error.message}`);
    res.status(500).json({ error: error.message || 'Failed to delete generated image' });
  }
});

export default router;
