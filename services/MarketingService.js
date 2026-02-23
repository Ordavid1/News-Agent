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
  getMarketingMetricsHistory
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

class MarketingService {
  constructor() {
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
        params: { access_token: accessToken },
        headers: { 'Content-Type': 'application/json' }
      };

      if (data && (method === 'POST' || method === 'PATCH')) {
        // For Meta Marketing API, parameters go as query params or form data, not JSON body
        config.params = { ...config.params, ...data };
      }

      const response = await axios(config);
      return response.data;
    } catch (error) {
      const apiError = error.response?.data?.error;
      if (apiError) {
        logger.error(`Marketing API error: ${apiError.message} (code: ${apiError.code}, subcode: ${apiError.error_subcode})`);
        throw new Error(`Meta Marketing API: ${apiError.message}`);
      }
      logger.error(`Marketing API request failed: ${error.message}`);
      throw error;
    }
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
      special_ad_categories: '[]'
    });

    logger.info(`Created campaign: ${fbCampaign.id}`);

    // Step 2: Create Ad Set with targeting and budget
    const adSetName = `${campaignName} - Ad Set`;
    const adSetParams = {
      campaign_id: fbCampaign.id,
      name: adSetName,
      billing_event: 'IMPRESSIONS',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      targeting: JSON.stringify(targeting),
      status: 'PAUSED',
      start_time: duration.startTime,
      end_time: duration.endTime,
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
      name: `Creative: ${platformPostId.substring(0, 30)}`,
      object_story_id: platformPostId // This is the key: links organic post to ad
    };

    // For Instagram posts, add the instagram_actor_id
    if (sourcePlatform === 'instagram') {
      // The instagram_actor_id is the IG business account ID
      const connection = await TokenManager.getTokens(userId, 'instagram');
      if (connection?.platform_metadata?.instagramAccountId) {
        creativeParams.instagram_actor_id = connection.platform_metadata.instagramAccountId;
      }
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
      special_ad_categories: '[]'
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
      targeting: JSON.stringify(adSetData.targeting),
      status: 'PAUSED',
      start_time: adSetData.startTime || campaign.start_time,
      end_time: adSetData.endTime || campaign.end_time,
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
          const result = await this._callMarketingApi(accessToken, 'GET',
            `/${post.platform_post_id}`, {
              fields: 'shares,likes.summary(true),comments.summary(true),insights.metric(post_impressions,post_engaged_users)'
            }
          );

          engagement = {
            likes: result.likes?.summary?.total_count || 0,
            comments: result.comments?.summary?.total_count || 0,
            shares: result.shares?.count || 0,
            impressions: result.insights?.data?.find(i => i.name === 'post_impressions')?.values?.[0]?.value || 0,
            engagedUsers: result.insights?.data?.find(i => i.name === 'post_engaged_users')?.values?.[0]?.value || 0
          };
        } else if (post.platform === 'instagram') {
          const result = await this._callMarketingApi(accessToken, 'GET',
            `/${post.platform_post_id}`, {
              fields: 'like_count,comments_count,impressions,reach'
            }
          );

          engagement = {
            likes: result.like_count || 0,
            comments: result.comments_count || 0,
            impressions: result.impressions || 0,
            reach: result.reach || 0
          };
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
