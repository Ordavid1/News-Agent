/**
 * Marketing Service
 *
 * Core orchestration service for Meta Marketing API operations.
 * Handles post boosting, campaign management, audience targeting,
 * and metrics syncing for Facebook and Instagram ads.
 *
 * Uses direct Graph API calls via axios (same pattern as FacebookPublisher)
 * instead of the heavy facebook-nodejs-business-sdk.
 */

import axios from 'axios';
import winston from 'winston';
import TokenManager, { TokenDecryptionError } from './TokenManager.js';
import {
  getSelectedAdAccount,
  getCampaignById,
  getCampaignByFbId,
  getAdSetById,
  getAdById,
  createCampaign,
  updateCampaign,
  createAdSet,
  updateAdSet,
  createAd,
  updateAd,
  upsertMarketingMetrics,
  getUserCampaigns,
  getCampaignAdSets,
  getAdSetAds,
  getBoostablePublishedPosts,
  getMarketingOverview,
  getMarketingMetricsHistory,
  getAudienceTemplateByFbId,
  createAudienceTemplate,
  updateAudienceTemplate
} from './database-wrapper.js';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[MarketingService] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

const GRAPH_API_VERSION = 'v24.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

const PAGE_POSTS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

class MarketingService {
  constructor() {
    // In-memory cache for page posts (TTL: 5 minutes per user)
    this._pagePostsCache = new Map();
    logger.info('MarketingService initialized');
  }

  // ============================================
  // CREDENTIAL MANAGEMENT
  // ============================================

  /**
   * Get marketing credentials for a user (page access token + ad account)
   * @param {string} userId - User ID
   * @returns {Object} { accessToken, pageId, pageAccessToken, adAccount }
   */
  async getMarketingCredentials(userId) {
    try {
      const connection = await TokenManager.getTokens(userId, 'facebook');

      if (!connection || connection.status !== 'active') {
        throw new Error('No active Facebook connection. Please connect your Facebook account first.');
      }

      const metadata = connection.platform_metadata || {};

      if (!metadata.marketingEnabled) {
        throw new Error('Marketing not enabled for this Facebook connection. Please authorize marketing permissions.');
      }

      const adAccount = await getSelectedAdAccount(userId);

      if (!adAccount) {
        throw new Error('No ad account selected. Please select an ad account in Marketing settings.');
      }

      return {
        accessToken: connection.access_token,
        pageId: metadata.pageId,
        pageAccessToken: metadata.pageAccessToken,
        pageName: metadata.pageName,
        adAccountId: adAccount.account_id, // act_XXXX format
        adAccountDbId: adAccount.id,
        currency: adAccount.currency
      };
    } catch (error) {
      if (error instanceof TokenDecryptionError) {
        throw new Error('Facebook connection credentials are invalid. Please disconnect and reconnect your Facebook account.');
      }
      throw error;
    }
  }

  // ============================================
  // META MARKETING API WRAPPER
  // ============================================

  /**
   * Make a call to the Meta Marketing API
   * @param {string} accessToken - Page or user access token
   * @param {string} method - HTTP method (GET, POST, DELETE)
   * @param {string} endpoint - API endpoint (e.g., /act_123/campaigns)
   * @param {Object} data - Request body data
   * @returns {Object} API response data
   */
  async _callMarketingApi(accessToken, method, endpoint, data = null) {
    const url = `${GRAPH_API_BASE}${endpoint}`;

    try {
      const config = {
        method,
        url,
        params: { access_token: accessToken }
      };

      if (data) {
        if (method === 'GET' || method === 'DELETE') {
          // GET/DELETE: merge data into query params
          config.params = { ...config.params, ...data };
        } else {
          // POST/PATCH: send as form-encoded body (Meta's standard)
          const formData = new URLSearchParams();
          for (const [key, value] of Object.entries(data)) {
            if (value !== undefined && value !== null) {
              formData.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
            }
          }
          config.data = formData.toString();
          config.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
        }
      }

      logger.debug(`Marketing API ${method} ${endpoint}`, { params: method === 'GET' ? Object.keys(data || {}) : undefined });

      const response = await axios(config);
      return response.data;
    } catch (error) {
      const apiError = error.response?.data?.error;
      if (apiError) {
        logger.error(`Marketing API error: ${apiError.message} (code: ${apiError.code}, subcode: ${apiError.error_subcode})`, {
          endpoint,
          method,
          errorType: apiError.type,
          errorDetail: apiError.error_user_title || apiError.error_user_msg || JSON.stringify(apiError).substring(0, 500),
          fbTraceId: apiError.fbtrace_id
        });
        const detail = apiError.error_user_msg || apiError.message;
        throw new Error(`Meta Marketing API: ${detail}`);
      }
      logger.error(`Marketing API request failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Fetch all pages of a paginated Meta API response.
   * Meta uses cursor-based pagination with paging.next URLs.
   * @param {string} accessToken
   * @param {string} endpoint - Initial endpoint (e.g. '/{pageId}/published_posts')
   * @param {Object} params - Query parameters for the first request
   * @param {number} maxItems - Safety limit to prevent runaway pagination (default 500)
   * @returns {Array} All items from all pages combined
   */
  async _fetchAllPages(accessToken, endpoint, params = {}, maxItems = 500) {
    const allItems = [];

    let result = await this._callMarketingApi(accessToken, 'GET', endpoint, params);

    if (result.data) {
      allItems.push(...result.data);
    }

    // Follow pagination cursors until exhausted or safety limit reached
    while (result.paging?.next && allItems.length < maxItems) {
      try {
        const response = await axios.get(result.paging.next);
        result = response.data;
        if (result.data) {
          allItems.push(...result.data);
        }
      } catch (error) {
        logger.warn(`Pagination fetch failed at ${allItems.length} items: ${error.message}`);
        break;
      }
    }

    return allItems;
  }

  // ============================================
  // POST BOOSTING
  // ============================================

  /**
   * Boost a published Facebook/Instagram post.
   * Creates the full Campaign → Ad Set → Ad Creative → Ad hierarchy atomically.
   *
   * @param {string} userId - User ID
   * @param {Object} params - Boost parameters
   * @param {string} params.platformPostId - The Facebook post ID (pageId_postId format)
   * @param {string} params.sourcePlatform - 'facebook' or 'instagram'
   * @param {string} params.sourcePublishedPostId - UUID of the published_posts record
   * @param {Object} params.budget - { type: 'daily'|'lifetime', amount: number, currency: string }
   * @param {Object} params.duration - { startTime: ISO string, endTime: ISO string }
   * @param {Object} params.audience - Targeting spec or { templateId: UUID }
   * @returns {Object} Created campaign, ad set, and ad records
   */
  async boostPost(userId, params) {
    const { platformPostId, sourcePlatform, sourcePublishedPostId, budget, duration, audience } = params;
    const creds = await this.getMarketingCredentials(userId);

    logger.info(`Boosting post ${platformPostId} for user ${userId} on ${sourcePlatform}`);

    // Resolve audience targeting
    let targeting = audience.targeting || audience;
    if (audience.templateId) {
      const { getAudienceTemplateById } = await import('./database-wrapper.js');
      const template = await getAudienceTemplateById(audience.templateId);
      if (!template) throw new Error('Audience template not found');
      targeting = template.targeting;
    }

    // Determine placements based on source platform
    const placements = this._buildPlacements(sourcePlatform);

    // Step 1: Create Campaign (PAUSED initially)
    const campaignName = `Boost: ${platformPostId.substring(0, 20)}... (${new Date().toISOString().split('T')[0]})`;
    const fbCampaign = await this._callMarketingApi(creds.accessToken, 'POST', `/${creds.adAccountId}/campaigns`, {
      name: campaignName,
      objective: 'OUTCOME_ENGAGEMENT',
      status: 'PAUSED',
      special_ad_categories: [],
      is_adset_budget_sharing_enabled: false
    });

    logger.info(`Created campaign: ${fbCampaign.id}`);

    // Step 2: Create Ad Set with targeting and budget
    const adSetName = `${campaignName} - Ad Set`;
    const adSetParams = {
      campaign_id: fbCampaign.id,
      name: adSetName,
      billing_event: 'IMPRESSIONS',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      targeting: JSON.stringify({ ...targeting, targeting_automation: { advantage_audience: 0 } }),
      status: 'PAUSED',
      start_time: duration.startTime,
      end_time: duration.endTime,
      is_adset_budget_sharing_enabled: false, // Required when budget is at ad set level (not campaign budget optimization)
      ...placements
    };

    // Set budget
    if (budget.type === 'daily') {
      adSetParams.daily_budget = Math.round(budget.amount * 100); // Meta expects cents
    } else {
      adSetParams.lifetime_budget = Math.round(budget.amount * 100);
    }

    const fbAdSet = await this._callMarketingApi(creds.accessToken, 'POST', `/${creds.adAccountId}/adsets`, adSetParams);
    logger.info(`Created ad set: ${fbAdSet.id}`);

    // Step 3: Create Ad Creative from the existing post
    const creativeParams = {
      name: `Creative: ${platformPostId.substring(0, 30)}`
    };

    if (sourcePlatform === 'instagram') {
      // Instagram uses source_instagram_media_id + instagram_actor_id (NOT object_story_id)
      const connection = await TokenManager.getTokens(userId, 'instagram');
      const igAccountId = connection?.platform_metadata?.instagramAccountId;
      if (!igAccountId) {
        throw new Error('Instagram business account ID not found. Please reconnect your Instagram account.');
      }
      creativeParams.source_instagram_media_id = platformPostId;
      creativeParams.instagram_actor_id = igAccountId;
    } else {
      // Facebook uses object_story_id (pageId_postId format)
      creativeParams.object_story_id = platformPostId;
    }

    const fbCreative = await this._callMarketingApi(creds.accessToken, 'POST', `/${creds.adAccountId}/adcreatives`, creativeParams);
    logger.info(`Created creative: ${fbCreative.id}`);

    // Step 4: Create Ad
    const adName = `Ad: ${platformPostId.substring(0, 30)}`;
    const fbAd = await this._callMarketingApi(creds.accessToken, 'POST', `/${creds.adAccountId}/ads`, {
      name: adName,
      adset_id: fbAdSet.id,
      creative: JSON.stringify({ creative_id: fbCreative.id }),
      status: 'ACTIVE'
    });
    logger.info(`Created ad: ${fbAd.id}`);

    // Step 5: Activate the campaign
    await this._callMarketingApi(creds.accessToken, 'POST', `/${fbCampaign.id}`, {
      status: 'ACTIVE'
    });
    logger.info('Campaign activated');

    // Step 6: Activate the ad set
    await this._callMarketingApi(creds.accessToken, 'POST', `/${fbAdSet.id}`, {
      status: 'ACTIVE'
    });

    // Save to database
    const dbCampaign = await createCampaign({
      userId,
      adAccountId: creds.adAccountDbId,
      fbCampaignId: fbCampaign.id,
      name: campaignName,
      objective: 'OUTCOME_ENGAGEMENT',
      status: 'active',
      fbStatus: 'ACTIVE',
      platforms: [sourcePlatform],
      dailyBudget: budget.type === 'daily' ? budget.amount : null,
      lifetimeBudget: budget.type === 'lifetime' ? budget.amount : null,
      startTime: duration.startTime,
      endTime: duration.endTime,
      metadata: { boostType: true, sourcePlatform }
    });

    const dbAdSet = await createAdSet({
      userId,
      campaignId: dbCampaign.id,
      fbAdsetId: fbAdSet.id,
      name: adSetName,
      status: 'active',
      fbStatus: 'ACTIVE',
      targeting,
      placements,
      billingEvent: 'IMPRESSIONS',
      bidStrategy: 'LOWEST_COST_WITHOUT_CAP',
      dailyBudget: budget.type === 'daily' ? budget.amount : null,
      lifetimeBudget: budget.type === 'lifetime' ? budget.amount : null,
      startTime: duration.startTime,
      endTime: duration.endTime
    });

    const dbAd = await createAd({
      userId,
      adSetId: dbAdSet.id,
      fbAdId: fbAd.id,
      fbCreativeId: fbCreative.id,
      name: adName,
      status: 'active',
      fbStatus: 'ACTIVE',
      sourcePublishedPostId,
      platformPostId,
      sourcePlatform,
      creativeType: 'existing_post'
    });

    logger.info(`Boost complete! Campaign: ${dbCampaign.id}, AdSet: ${dbAdSet.id}, Ad: ${dbAd.id}`);

    return {
      campaign: dbCampaign,
      adSet: dbAdSet,
      ad: dbAd,
      fbIds: {
        campaignId: fbCampaign.id,
        adSetId: fbAdSet.id,
        creativeId: fbCreative.id,
        adId: fbAd.id
      }
    };
  }

  /**
   * Pause a boost (pauses the campaign)
   */
  async pauseBoost(userId, campaignId) {
    const creds = await this.getMarketingCredentials(userId);
    const campaign = await getCampaignById(campaignId);

    if (!campaign || campaign.user_id !== userId) {
      throw new Error('Campaign not found');
    }

    if (campaign.fb_campaign_id) {
      await this._callMarketingApi(creds.accessToken, 'POST', `/${campaign.fb_campaign_id}`, {
        status: 'PAUSED'
      });
    }

    return updateCampaign(campaignId, { status: 'paused', fb_status: 'PAUSED' });
  }

  /**
   * Resume a paused boost
   */
  async resumeBoost(userId, campaignId) {
    const creds = await this.getMarketingCredentials(userId);
    const campaign = await getCampaignById(campaignId);

    if (!campaign || campaign.user_id !== userId) {
      throw new Error('Campaign not found');
    }

    if (campaign.fb_campaign_id) {
      await this._callMarketingApi(creds.accessToken, 'POST', `/${campaign.fb_campaign_id}`, {
        status: 'ACTIVE'
      });
    }

    return updateCampaign(campaignId, { status: 'active', fb_status: 'ACTIVE' });
  }

  /**
   * Delete a boost (deletes the campaign and all children on Meta)
   */
  async deleteBoost(userId, campaignId) {
    const creds = await this.getMarketingCredentials(userId);
    const campaign = await getCampaignById(campaignId);

    if (!campaign || campaign.user_id !== userId) {
      throw new Error('Campaign not found');
    }

    // Delete from Meta (cascades to ad sets and ads)
    if (campaign.fb_campaign_id) {
      try {
        await this._callMarketingApi(creds.accessToken, 'DELETE', `/${campaign.fb_campaign_id}`);
      } catch (error) {
        logger.warn(`Failed to delete campaign from Meta: ${error.message}`);
        // Continue with local deletion even if Meta deletion fails
      }
    }

    // Mark as archived locally (cascade via DB foreign keys)
    return updateCampaign(campaignId, { status: 'archived', fb_status: 'DELETED' });
  }

  // ============================================
  // PAGE POSTS (Fetch from Meta for Boost)
  // ============================================

  /**
   * Fetch published posts directly from the user's Facebook Page via Meta Graph API.
   * Returns all posts from the past N days — including posts not published through this app.
   * Results are cached per-user for 5 minutes to reduce API calls.
   *
   * @param {string} userId
   * @param {number} days - How many days back to fetch (default 30)
   * @returns {Array} Posts normalized for frontend consumption
   */
  async fetchPagePosts(userId, days = 30) {
    // Check cache first
    const cacheKey = `${userId}:${days}`;
    const cached = this._pagePostsCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < PAGE_POSTS_CACHE_TTL) {
      logger.debug(`Returning cached page posts for user ${userId}`);
      return cached.data;
    }

    const creds = await this.getMarketingCredentials(userId);

    if (!creds.pageId || !creds.pageAccessToken) {
      throw new Error('No Facebook Page connected. Please ensure your Facebook connection includes a Page.');
    }

    const sinceTimestamp = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000);

    // Use direct fetch to bypass _callMarketingApi wrapper — Page content endpoints
    // in v24.0 trigger internal deprecation errors through the marketing API path.
    // Fetch from /{pageId}/posts (page's own posts only).
    const postsUrl = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/${creds.pageId}/posts`);
    postsUrl.searchParams.set('access_token', creds.pageAccessToken);
    postsUrl.searchParams.set('fields', 'id,message,created_time,permalink_url,full_picture');
    postsUrl.searchParams.set('since', sinceTimestamp);
    postsUrl.searchParams.set('limit', '100');

    const allPosts = [];
    let nextUrl = postsUrl.toString();

    while (nextUrl && allPosts.length < 300) {
      const response = await fetch(nextUrl);
      const result = await response.json();

      if (result.error) {
        logger.error(`Page posts API error: ${result.error.message} (code: ${result.error.code})`);
        throw new Error(`Meta API: ${result.error.message}`);
      }

      if (result.data) {
        allPosts.push(...result.data);
      }

      nextUrl = result.paging?.next || null;
    }

    const posts = allPosts;

    // Normalize response to match the published_posts shape the frontend expects
    const normalized = posts.map(post => ({
      id: post.id,                        // Facebook post ID (pageId_postId format)
      platform_post_id: post.id,          // Used for boosting — this is the object_story_id
      platform: 'facebook',
      content: post.message || '',
      published_at: post.created_time,
      permalink_url: post.permalink_url,
      full_picture: post.full_picture || null,
      engagement: {
        reactions: 0,
        comments: 0,
        shares: 0
      },
      source: 'meta'  // Distinguish from app-published posts
    }));

    // Cache the result
    this._pagePostsCache.set(cacheKey, { data: normalized, timestamp: Date.now() });

    logger.info(`Fetched ${normalized.length} page posts for user ${userId} (last ${days} days)`);
    return normalized;
  }

  /**
   * Fetch Instagram media posts for a user's connected IG business account.
   * Uses the Instagram Graph API via the linked Facebook Page token.
   *
   * @param {string} userId - User ID
   * @param {number} days - How many days of history to fetch (default 90)
   * @returns {Array} Normalized post objects
   */
  async fetchInstagramPosts(userId, days = 90) {
    const cacheKey = `ig:${userId}:${days}`;
    const cached = this._pagePostsCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < PAGE_POSTS_CACHE_TTL) {
      logger.debug(`Returning cached Instagram posts for user ${userId}`);
      return cached.data;
    }

    // Instagram uses the Facebook page access token + the IG user ID stored in metadata
    const connection = await TokenManager.getTokens(userId, 'instagram');

    if (!connection || connection.status !== 'active') {
      logger.info(`No active Instagram connection for user ${userId}, skipping IG post fetch`);
      return [];
    }

    const igUserId = connection.platform_user_id || connection.platform_metadata?.igUserId;
    if (!igUserId) {
      logger.warn(`Instagram connection for user ${userId} has no igUserId`);
      return [];
    }

    // Instagram Business accounts use the Facebook page access token for API calls
    const accessToken = connection.access_token;
    const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const postsUrl = new URL(`${GRAPH_API_BASE}/${igUserId}/media`);
    postsUrl.searchParams.set('access_token', accessToken);
    postsUrl.searchParams.set('fields', 'id,caption,media_type,timestamp,permalink,like_count,comments_count');
    postsUrl.searchParams.set('limit', '100');

    const allPosts = [];
    let nextUrl = postsUrl.toString();

    while (nextUrl && allPosts.length < 300) {
      const response = await fetch(nextUrl);
      const result = await response.json();

      if (result.error) {
        logger.error(`Instagram media API error: ${result.error.message} (code: ${result.error.code})`);
        throw new Error(`Instagram API: ${result.error.message}`);
      }

      if (result.data) {
        // Filter by date client-side since IG media endpoint doesn't support `since`
        const filtered = result.data.filter(post => new Date(post.timestamp) >= sinceDate);
        allPosts.push(...filtered);

        // If we're getting posts older than our cutoff, stop paginating
        const oldestInBatch = result.data[result.data.length - 1];
        if (oldestInBatch && new Date(oldestInBatch.timestamp) < sinceDate) {
          break;
        }
      }

      nextUrl = result.paging?.next || null;
    }

    const normalized = allPosts.map(post => ({
      id: post.id,
      platform_post_id: post.id,
      platform: 'instagram',
      content: post.caption || '',
      published_at: post.timestamp,
      permalink_url: post.permalink,
      media_type: (post.media_type || 'IMAGE').toLowerCase(),
      engagement: {
        likes: post.like_count || 0,
        comments: post.comments_count || 0
      },
      source: 'meta'
    }));

    this._pagePostsCache.set(cacheKey, { data: normalized, timestamp: Date.now() });

    logger.info(`Fetched ${normalized.length} Instagram posts for user ${userId} (last ${days} days)`);
    return normalized;
  }

  // ============================================
  // CAMPAIGN MANAGEMENT
  // ============================================

  /**
   * Create a new marketing campaign on Meta
   */
  async createCampaignOnMeta(userId, campaignData) {
    const creds = await this.getMarketingCredentials(userId);

    const fbCampaign = await this._callMarketingApi(creds.accessToken, 'POST', `/${creds.adAccountId}/campaigns`, {
      name: campaignData.name,
      objective: campaignData.objective,
      status: 'PAUSED',
      special_ad_categories: [],
      is_adset_budget_sharing_enabled: false
    });

    const dbCampaign = await createCampaign({
      userId,
      adAccountId: creds.adAccountDbId,
      fbCampaignId: fbCampaign.id,
      name: campaignData.name,
      objective: campaignData.objective,
      status: 'draft',
      fbStatus: 'PAUSED',
      platforms: campaignData.platforms || ['facebook'],
      dailyBudget: campaignData.dailyBudget,
      lifetimeBudget: campaignData.lifetimeBudget,
      startTime: campaignData.startTime,
      endTime: campaignData.endTime,
      metadata: campaignData.metadata || {}
    });

    return dbCampaign;
  }

  /**
   * Sync campaigns from Meta Ad Account into local database.
   * Fetches all campaigns and upserts them into marketing_campaigns.
   * Synced campaigns are tagged with metadata.source = 'meta_sync'.
   *
   * @param {string} userId
   * @returns {Object} { synced, created, updated, total }
   */
  async syncCampaignsFromMeta(userId) {
    const creds = await this.getMarketingCredentials(userId);

    logger.info(`Syncing campaigns from Meta for user ${userId}, ad account ${creds.adAccountId}`);

    const campaigns = await this._fetchAllPages(
      creds.accessToken,
      `/${creds.adAccountId}/campaigns`,
      {
        fields: 'id,name,objective,status,created_time,updated_time,daily_budget,lifetime_budget,start_time,stop_time,budget_remaining',
        limit: 100
      },
      200
    );

    // Map Meta statuses to local statuses
    const statusMap = {
      'ACTIVE': 'active',
      'PAUSED': 'paused',
      'DELETED': 'archived',
      'ARCHIVED': 'archived'
    };

    let created = 0, updated = 0;

    for (const fbCampaign of campaigns) {
      // Check if we already have this campaign locally
      const existing = await getCampaignByFbId(userId, fbCampaign.id);

      const campaignData = {
        name: fbCampaign.name,
        objective: fbCampaign.objective || 'OUTCOME_ENGAGEMENT',
        status: statusMap[fbCampaign.status] || 'draft',
        fb_status: fbCampaign.status,
        daily_budget: fbCampaign.daily_budget ? parseFloat(fbCampaign.daily_budget) / 100 : null,
        lifetime_budget: fbCampaign.lifetime_budget ? parseFloat(fbCampaign.lifetime_budget) / 100 : null,
        start_time: fbCampaign.start_time || null,
        end_time: fbCampaign.stop_time || null,
        metadata: { source: 'meta_sync', budget_remaining: fbCampaign.budget_remaining }
      };

      if (existing) {
        await updateCampaign(existing.id, campaignData);
        updated++;
      } else {
        await createCampaign({
          userId,
          adAccountId: creds.adAccountDbId,
          fbCampaignId: fbCampaign.id,
          fbStatus: fbCampaign.status,
          ...campaignData
        });
        created++;
      }
    }

    logger.info(`Campaign sync complete for user ${userId}: ${created} created, ${updated} updated out of ${campaigns.length} total`);
    return { synced: created + updated, created, updated, total: campaigns.length };
  }

  /**
   * Create an ad set within a campaign on Meta
   */
  async createAdSetOnMeta(userId, campaignId, adSetData) {
    const creds = await this.getMarketingCredentials(userId);
    const campaign = await getCampaignById(campaignId);

    if (!campaign || campaign.user_id !== userId) {
      throw new Error('Campaign not found');
    }

    const placements = adSetData.placements || this._buildPlacements(campaign.platforms?.[0] || 'facebook');

    const fbParams = {
      campaign_id: campaign.fb_campaign_id,
      name: adSetData.name,
      billing_event: adSetData.billingEvent || 'IMPRESSIONS',
      bid_strategy: adSetData.bidStrategy || 'LOWEST_COST_WITHOUT_CAP',
      targeting: JSON.stringify({ ...adSetData.targeting, targeting_automation: { advantage_audience: 0 } }),
      status: 'PAUSED',
      start_time: adSetData.startTime || campaign.start_time,
      end_time: adSetData.endTime || campaign.end_time,
      is_adset_budget_sharing_enabled: false,
      ...placements
    };

    if (adSetData.dailyBudget) {
      fbParams.daily_budget = Math.round(adSetData.dailyBudget * 100);
    }
    if (adSetData.lifetimeBudget) {
      fbParams.lifetime_budget = Math.round(adSetData.lifetimeBudget * 100);
    }
    if (adSetData.bidAmount) {
      fbParams.bid_amount = Math.round(adSetData.bidAmount * 100);
    }

    const fbAdSet = await this._callMarketingApi(creds.accessToken, 'POST', `/${creds.adAccountId}/adsets`, fbParams);

    return createAdSet({
      userId,
      campaignId,
      fbAdsetId: fbAdSet.id,
      name: adSetData.name,
      status: 'draft',
      fbStatus: 'PAUSED',
      targeting: adSetData.targeting,
      placements,
      billingEvent: adSetData.billingEvent || 'IMPRESSIONS',
      bidStrategy: adSetData.bidStrategy || 'LOWEST_COST_WITHOUT_CAP',
      bidAmount: adSetData.bidAmount,
      dailyBudget: adSetData.dailyBudget,
      lifetimeBudget: adSetData.lifetimeBudget,
      startTime: adSetData.startTime,
      endTime: adSetData.endTime
    });
  }

  /**
   * Create an ad from a published post within an ad set
   */
  async createAdFromPost(userId, adSetId, postData) {
    const creds = await this.getMarketingCredentials(userId);
    const adSet = await getAdSetById(adSetId);

    if (!adSet || adSet.user_id !== userId) {
      throw new Error('Ad set not found');
    }

    // Create creative from existing post
    const creativeParams = {
      name: `Creative: ${postData.name || postData.platformPostId.substring(0, 30)}`,
      object_story_id: postData.platformPostId
    };

    const fbCreative = await this._callMarketingApi(creds.accessToken, 'POST', `/${creds.adAccountId}/adcreatives`, creativeParams);

    // Create ad
    const fbAd = await this._callMarketingApi(creds.accessToken, 'POST', `/${creds.adAccountId}/ads`, {
      name: postData.name || `Ad: ${postData.platformPostId.substring(0, 30)}`,
      adset_id: adSet.fb_adset_id,
      creative: JSON.stringify({ creative_id: fbCreative.id }),
      status: 'PAUSED'
    });

    return createAd({
      userId,
      adSetId,
      fbAdId: fbAd.id,
      fbCreativeId: fbCreative.id,
      name: postData.name || `Ad: ${postData.platformPostId.substring(0, 30)}`,
      status: 'draft',
      fbStatus: 'PAUSED',
      sourcePublishedPostId: postData.sourcePublishedPostId,
      platformPostId: postData.platformPostId,
      sourcePlatform: postData.sourcePlatform || 'facebook',
      creativeType: 'existing_post'
    });
  }

  /**
   * Update campaign status on Meta (activate, pause, etc.)
   */
  async updateCampaignStatus(userId, campaignId, newStatus) {
    const creds = await this.getMarketingCredentials(userId);
    const campaign = await getCampaignById(campaignId);

    if (!campaign || campaign.user_id !== userId) {
      throw new Error('Campaign not found');
    }

    const fbStatusMap = {
      active: 'ACTIVE',
      paused: 'PAUSED',
      archived: 'DELETED'
    };

    const fbStatus = fbStatusMap[newStatus];
    if (!fbStatus) throw new Error(`Invalid status: ${newStatus}`);

    if (campaign.fb_campaign_id) {
      await this._callMarketingApi(creds.accessToken, 'POST', `/${campaign.fb_campaign_id}`, {
        status: fbStatus
      });
    }

    return updateCampaign(campaignId, { status: newStatus, fb_status: fbStatus });
  }

  // ============================================
  // AUDIENCE & TARGETING
  // ============================================

  /**
   * Estimate audience reach for a targeting specification
   */
  async estimateReach(userId, targeting) {
    const creds = await this.getMarketingCredentials(userId);

    const result = await this._callMarketingApi(creds.accessToken, 'GET',
      `/${creds.adAccountId}/reachestimate`, {
        targeting_spec: JSON.stringify(targeting)
      }
    );

    return {
      estimatedReach: result.data?.users || 0,
      estimatedReachLower: result.data?.users_lower_bound || 0,
      estimatedReachUpper: result.data?.users_upper_bound || 0
    };
  }

  /**
   * Search Meta's interest targeting database
   */
  async searchInterests(userId, query) {
    const creds = await this.getMarketingCredentials(userId);

    const result = await this._callMarketingApi(creds.accessToken, 'GET', '/search', {
      type: 'adinterest',
      q: query,
      limit: 25
    });

    return (result.data || []).map(interest => ({
      id: interest.id,
      name: interest.name,
      audienceSize: interest.audience_size || 0,
      path: interest.path || [],
      topic: interest.topic
    }));
  }

  /**
   * Search geo locations for targeting
   */
  async searchLocations(userId, query, type = 'adgeolocation') {
    const creds = await this.getMarketingCredentials(userId);

    const result = await this._callMarketingApi(creds.accessToken, 'GET', '/search', {
      type,
      q: query,
      limit: 25
    });

    return result.data || [];
  }

  /**
   * Sync Custom Audiences from Meta Ad Account into local database.
   * These are actual audience lists (lookalike, website visitors, customer lists)
   * stored in Meta, different from the app's local targeting templates.
   * Synced audiences are tagged with source = 'meta'.
   *
   * @param {string} userId
   * @returns {Object} { synced, created, updated, total }
   */
  async syncCustomAudiences(userId) {
    const creds = await this.getMarketingCredentials(userId);

    logger.info(`Syncing custom audiences from Meta for user ${userId}, ad account ${creds.adAccountId}`);

    const audiences = await this._fetchAllPages(
      creds.accessToken,
      `/${creds.adAccountId}/customaudiences`,
      {
        fields: 'id,name,description,approximate_count,subtype,time_created,time_updated',
        limit: 100
      },
      200
    );

    let created = 0, updated = 0;

    for (const fbAudience of audiences) {
      const existing = await getAudienceTemplateByFbId(userId, fbAudience.id);

      const audienceData = {
        name: fbAudience.name,
        description: fbAudience.description || null,
        source: 'meta',
        fb_audience_id: fbAudience.id,
        approximate_count: fbAudience.approximate_count || null,
        subtype: fbAudience.subtype || null,
        targeting: {},  // Meta custom audiences are used by reference, not by targeting spec
        metadata: { source: 'meta_sync', subtype: fbAudience.subtype }
      };

      if (existing) {
        await updateAudienceTemplate(existing.id, audienceData);
        updated++;
      } else {
        await createAudienceTemplate({
          userId,
          ...audienceData
        });
        created++;
      }
    }

    logger.info(`Audience sync complete for user ${userId}: ${created} created, ${updated} updated out of ${audiences.length}`);
    return { synced: created + updated, created, updated, total: audiences.length };
  }

  // ============================================
  // METRICS SYNC
  // ============================================

  /**
   * Sync metrics for all active campaigns of a user from Meta
   */
  async syncMetricsForUser(userId) {
    const creds = await this.getMarketingCredentials(userId);
    const campaigns = await getUserCampaigns(userId, { status: 'active' });

    let synced = 0;

    for (const campaign of campaigns) {
      if (!campaign.fb_campaign_id) continue;

      try {
        // Fetch campaign insights
        const insights = await this._callMarketingApi(creds.accessToken, 'GET',
          `/${campaign.fb_campaign_id}/insights`, {
            fields: 'spend,impressions,reach,clicks,ctr,cpc,cpm',
            date_preset: 'last_7d',
            time_increment: 1 // Daily breakdown
          }
        );

        const insightRows = insights.data || [];

        for (const row of insightRows) {
          await upsertMarketingMetrics({
            userId,
            entityType: 'campaign',
            entityId: campaign.id,
            fbEntityId: campaign.fb_campaign_id,
            date: row.date_start,
            spend: parseFloat(row.spend) || 0,
            impressions: parseInt(row.impressions) || 0,
            reach: parseInt(row.reach) || 0,
            clicks: parseInt(row.clicks) || 0,
            ctr: parseFloat(row.ctr) || 0,
            cpc: parseFloat(row.cpc) || 0,
            cpm: parseFloat(row.cpm) || 0
          });
        }

        // Aggregate totals on campaign record
        const totals = insightRows.reduce((acc, r) => ({
          spend: acc.spend + (parseFloat(r.spend) || 0),
          impressions: acc.impressions + (parseInt(r.impressions) || 0),
          reach: acc.reach + (parseInt(r.reach) || 0),
          clicks: acc.clicks + (parseInt(r.clicks) || 0)
        }), { spend: 0, impressions: 0, reach: 0, clicks: 0 });

        await updateCampaign(campaign.id, {
          total_spend: totals.spend,
          total_impressions: totals.impressions,
          total_reach: totals.reach,
          total_clicks: totals.clicks,
          last_metrics_sync_at: new Date().toISOString()
        });

        // Also sync ad set and ad level metrics
        await this._syncAdSetMetrics(creds, campaign.id);

        synced++;
      } catch (error) {
        logger.error(`Failed to sync metrics for campaign ${campaign.id}: ${error.message}`);
      }
    }

    logger.info(`Synced metrics for ${synced}/${campaigns.length} campaigns for user ${userId}`);
    return { syncedCampaigns: synced, totalCampaigns: campaigns.length };
  }

  /**
   * Sync metrics for ad sets within a campaign
   */
  async _syncAdSetMetrics(creds, campaignId) {
    const adSets = await getCampaignAdSets(campaignId);

    for (const adSet of adSets) {
      if (!adSet.fb_adset_id) continue;

      try {
        const insights = await this._callMarketingApi(creds.accessToken, 'GET',
          `/${adSet.fb_adset_id}/insights`, {
            fields: 'spend,impressions,reach,clicks,ctr,cpc,cpm',
            date_preset: 'last_7d'
          }
        );

        const data = insights.data?.[0];
        if (data) {
          await updateAdSet(adSet.id, {
            spend: parseFloat(data.spend) || 0,
            impressions: parseInt(data.impressions) || 0,
            reach: parseInt(data.reach) || 0,
            clicks: parseInt(data.clicks) || 0,
            last_metrics_sync_at: new Date().toISOString()
          });
        }

        // Sync individual ads
        const ads = await getAdSetAds(adSet.id);
        for (const ad of ads) {
          if (!ad.fb_ad_id) continue;

          try {
            const adInsights = await this._callMarketingApi(creds.accessToken, 'GET',
              `/${ad.fb_ad_id}/insights`, {
                fields: 'spend,impressions,reach,clicks,ctr,cpc,cpm',
                date_preset: 'last_7d'
              }
            );

            const adData = adInsights.data?.[0];
            if (adData) {
              await updateAd(ad.id, {
                spend: parseFloat(adData.spend) || 0,
                impressions: parseInt(adData.impressions) || 0,
                reach: parseInt(adData.reach) || 0,
                clicks: parseInt(adData.clicks) || 0,
                ctr: parseFloat(adData.ctr) || 0,
                cpc: parseFloat(adData.cpc) || 0,
                cpm: parseFloat(adData.cpm) || 0,
                last_metrics_sync_at: new Date().toISOString()
              });
            }
          } catch (adError) {
            logger.warn(`Failed to sync metrics for ad ${ad.id}: ${adError.message}`);
          }
        }
      } catch (error) {
        logger.warn(`Failed to sync metrics for ad set ${adSet.id}: ${error.message}`);
      }
    }
  }

  /**
   * Fetch organic engagement metrics for published posts.
   * Needed for auto-boost rules to evaluate post performance.
   */
  async syncOrganicMetrics(userId) {
    const posts = await getBoostablePublishedPosts(userId, 20);
    const connection = await TokenManager.getTokens(userId, 'facebook');

    if (!connection || connection.status !== 'active') return { synced: 0 };

    const accessToken = connection.platform_metadata?.pageAccessToken || connection.access_token;
    let synced = 0;

    for (const post of posts) {
      if (!post.platform_post_id) continue;

      try {
        let engagement = {};

        if (post.platform === 'facebook') {
          // Use Page Post insights endpoint — direct post field aggregations are deprecated in v24.0
          try {
            const insights = await this._callMarketingApi(accessToken, 'GET',
              `/${post.platform_post_id}/insights`, {
                metric: 'post_impressions,post_engaged_users,post_reactions_by_type_total'
              }
            );
            if (insights.data) {
              const reactionsData = insights.data.find(i => i.name === 'post_reactions_by_type_total')?.values?.[0]?.value || {};
              const totalReactions = Object.values(reactionsData).reduce((sum, count) => sum + (count || 0), 0);
              engagement = {
                reactions: totalReactions,
                impressions: insights.data.find(i => i.name === 'post_impressions')?.values?.[0]?.value || 0,
                engagedUsers: insights.data.find(i => i.name === 'post_engaged_users')?.values?.[0]?.value || 0
              };
            }
          } catch (insightsErr) {
            logger.debug(`Could not fetch insights for FB post ${post.platform_post_id}: ${insightsErr.message}`);
          }
        } else if (post.platform === 'instagram') {
          // Fetch basic IG media fields (impressions/reach are NOT direct fields)
          const result = await this._callMarketingApi(accessToken, 'GET',
            `/${post.platform_post_id}`, {
              fields: 'like_count,comments_count'
            }
          );

          engagement = {
            likes: result.like_count || 0,
            comments: result.comments_count || 0
          };

          // Fetch IG media insights separately
          try {
            const insights = await this._callMarketingApi(accessToken, 'GET',
              `/${post.platform_post_id}/insights`, {
                metric: 'impressions,reach'
              }
            );
            if (insights.data) {
              engagement.impressions = insights.data.find(i => i.name === 'impressions')?.values?.[0]?.value || 0;
              engagement.reach = insights.data.find(i => i.name === 'reach')?.values?.[0]?.value || 0;
            }
          } catch (insightsErr) {
            logger.debug(`Could not fetch insights for IG post ${post.platform_post_id}: ${insightsErr.message}`);
          }
        }

        // Update the published_posts engagement field
        const { supabaseAdmin } = await import('./supabase.js');
        await supabaseAdmin
          .from('published_posts')
          .update({
            engagement,
            updated_at: new Date().toISOString()
          })
          .eq('id', post.id);

        synced++;
      } catch (error) {
        logger.warn(`Failed to sync organic metrics for post ${post.id}: ${error.message}`);
      }
    }

    return { synced, total: posts.length };
  }

  /**
   * Get analytics overview for a user
   */
  async getAnalyticsOverview(userId, startDate, endDate, adAccountId = null) {
    return getMarketingOverview(userId, startDate, endDate, adAccountId);
  }

  /**
   * Get metrics trend data for a campaign
   */
  async getCampaignMetricsTrend(userId, campaignId, startDate, endDate) {
    const campaign = await getCampaignById(campaignId);
    if (!campaign || campaign.user_id !== userId) {
      throw new Error('Campaign not found');
    }
    return getMarketingMetricsHistory(campaignId, startDate, endDate);
  }

  // ============================================
  // HELPERS
  // ============================================

  /**
   * Build placement configuration for ad sets
   */
  _buildPlacements(platform) {
    if (platform === 'instagram') {
      return {
        publisher_platforms: JSON.stringify(['instagram']),
        instagram_positions: JSON.stringify(['stream', 'story', 'explore'])
      };
    }

    if (platform === 'facebook') {
      return {
        publisher_platforms: JSON.stringify(['facebook']),
        facebook_positions: JSON.stringify(['feed'])
      };
    }

    // Both platforms
    return {
      publisher_platforms: JSON.stringify(['facebook', 'instagram']),
      facebook_positions: JSON.stringify(['feed']),
      instagram_positions: JSON.stringify(['stream', 'story'])
    };
  }
}

// Singleton export (same pattern as PublishingService)
const marketingService = new MarketingService();
export default marketingService;
