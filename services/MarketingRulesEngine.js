/**
 * Marketing Rules Engine
 *
 * Evaluates auto-boost rules against recent published post performance.
 * When conditions are met (e.g., "organic reach > 500 within 2 hours"),
 * automatically triggers a boost via MarketingService.
 *
 * Supports rule types:
 * - auto_boost: Automatically boost posts meeting engagement thresholds
 * - pause_if: Pause ads if performance drops below thresholds
 * - budget_adjust: Adjust budgets based on performance metrics
 */

import winston from 'winston';
import marketingService from './MarketingService.js';
import {
  getActiveMarketingRules,
  getMarketingAddon,
  getAudienceTemplateById,
  logRuleTrigger,
  updateMarketingRule
} from './database-wrapper.js';
import { supabaseAdmin } from './supabase.js';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[RulesEngine] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

class MarketingRulesEngine {

  /**
   * Evaluate all active marketing rules across all users
   */
  async evaluateAllRules() {
    const rules = await getActiveMarketingRules();

    if (rules.length === 0) {
      logger.debug('No active marketing rules to evaluate');
      return { evaluated: 0, triggered: 0 };
    }

    logger.info(`Evaluating ${rules.length} active marketing rules`);

    let evaluated = 0;
    let triggered = 0;

    // Group rules by user for efficiency
    const rulesByUser = {};
    for (const rule of rules) {
      if (!rulesByUser[rule.user_id]) rulesByUser[rule.user_id] = [];
      rulesByUser[rule.user_id].push(rule);
    }

    for (const [userId, userRules] of Object.entries(rulesByUser)) {
      // Verify user still has active marketing addon
      const addon = await getMarketingAddon(userId);
      if (!addon || addon.status !== 'active') continue;

      for (const rule of userRules) {
        try {
          const wasTriggered = await this.evaluateRule(userId, rule);
          evaluated++;
          if (wasTriggered) triggered++;
        } catch (error) {
          logger.error(`Error evaluating rule ${rule.id} for user ${userId}: ${error.message}`);
        }
      }
    }

    logger.info(`Rules evaluation complete: ${evaluated} evaluated, ${triggered} triggered`);
    return { evaluated, triggered };
  }

  /**
   * Evaluate a single rule for a user
   * @returns {boolean} Whether the rule was triggered
   */
  async evaluateRule(userId, rule) {
    // Check cooldown
    if (rule.last_triggered_at) {
      const cooldownMs = (rule.cooldown_hours || 24) * 60 * 60 * 1000;
      const timeSinceLastTrigger = Date.now() - new Date(rule.last_triggered_at).getTime();
      if (timeSinceLastTrigger < cooldownMs) {
        return false; // Still in cooldown
      }
    }

    switch (rule.rule_type) {
      case 'auto_boost':
        return this._evaluateAutoBoostRule(userId, rule);
      case 'pause_if':
        return this._evaluatePauseRule(userId, rule);
      case 'budget_adjust':
        return this._evaluateBudgetAdjustRule(userId, rule);
      default:
        logger.warn(`Unknown rule type: ${rule.rule_type}`);
        return false;
    }
  }

  /**
   * Evaluate an auto-boost rule.
   * Checks if any recent published posts meet the engagement threshold.
   */
  async _evaluateAutoBoostRule(userId, rule) {
    const conditions = rule.conditions;
    const actions = rule.actions;

    // Get recent published posts with engagement data
    const withinHours = conditions.within_hours || 24;
    const cutoffTime = new Date(Date.now() - withinHours * 60 * 60 * 1000).toISOString();

    // Filter by platforms if specified in applies_to
    const platforms = rule.applies_to?.platforms || ['facebook', 'instagram'];

    const { data: posts, error } = await supabaseAdmin
      .from('published_posts')
      .select('*')
      .eq('user_id', userId)
      .in('platform', platforms)
      .eq('success', true)
      .not('platform_post_id', 'is', null)
      .gte('published_at', cutoffTime)
      .not('engagement', 'is', null)
      .order('published_at', { ascending: false });

    if (error || !posts || posts.length === 0) return false;

    // Check each post against conditions
    for (const post of posts) {
      const engagement = post.engagement || {};

      // Check if this post has already been boosted
      const { data: existingAds } = await supabaseAdmin
        .from('marketing_ads')
        .select('id')
        .eq('platform_post_id', post.platform_post_id)
        .eq('user_id', userId)
        .limit(1);

      if (existingAds && existingAds.length > 0) continue; // Already boosted

      // Evaluate metric condition
      const metricValue = this._getMetricValue(engagement, conditions.metric);
      const threshold = conditions.value;
      const operator = conditions.operator || '>';

      if (this._compareValues(metricValue, operator, threshold)) {
        logger.info(`Auto-boost rule ${rule.id} triggered for post ${post.id}: ${conditions.metric}=${metricValue} ${operator} ${threshold}`);

        try {
          // Resolve audience
          let audience = {};
          if (actions.audience_template_id) {
            const template = await getAudienceTemplateById(actions.audience_template_id);
            if (template) {
              audience = { targeting: template.targeting };
            }
          }
          if (!audience.targeting) {
            // Default targeting: broad audience in user's location
            audience = {
              targeting: {
                geo_locations: { countries: ['US'] },
                age_min: 18,
                age_max: 65
              }
            };
          }

          // Calculate duration
          const now = new Date();
          const endDate = new Date(now.getTime() + (actions.duration_days || 7) * 24 * 60 * 60 * 1000);

          // Execute boost
          const result = await marketingService.boostPost(userId, {
            platformPostId: post.platform_post_id,
            sourcePlatform: post.platform,
            sourcePublishedPostId: post.id,
            budget: {
              type: actions.budget_type || 'daily',
              amount: actions.budget || 10,
              currency: 'USD'
            },
            duration: {
              startTime: now.toISOString(),
              endTime: endDate.toISOString()
            },
            audience
          });

          // Log trigger
          await logRuleTrigger({
            ruleId: rule.id,
            userId,
            publishedPostId: post.id,
            platform: post.platform,
            actionTaken: {
              action: 'boost',
              budget: actions.budget,
              durationDays: actions.duration_days,
              campaignId: result.campaign.id
            },
            result: { fbCampaignId: result.fbIds.campaignId },
            success: true
          });

          // Update rule trigger info
          await updateMarketingRule(rule.id, {
            last_triggered_at: new Date().toISOString(),
            trigger_count: (rule.trigger_count || 0) + 1
          });

          return true;
        } catch (boostError) {
          logger.error(`Auto-boost failed for rule ${rule.id}: ${boostError.message}`);

          await logRuleTrigger({
            ruleId: rule.id,
            userId,
            publishedPostId: post.id,
            platform: post.platform,
            actionTaken: { action: 'boost', budget: actions.budget },
            success: false,
            errorMessage: boostError.message
          });
        }
      }
    }

    return false;
  }

  /**
   * Evaluate a pause rule.
   * Checks if any active ads have performance below threshold.
   */
  async _evaluatePauseRule(userId, rule) {
    const conditions = rule.conditions;

    // Get active ads for this user
    const { data: ads } = await supabaseAdmin
      .from('marketing_ads')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'active');

    if (!ads || ads.length === 0) return false;

    for (const ad of ads) {
      const metricValue = this._getAdMetricValue(ad, conditions.metric);
      const threshold = conditions.value;
      const operator = conditions.operator || '>';

      if (this._compareValues(metricValue, operator, threshold)) {
        logger.info(`Pause rule ${rule.id} triggered for ad ${ad.id}: ${conditions.metric}=${metricValue} ${operator} ${threshold}`);

        try {
          // Pause the ad's parent campaign
          const adSet = await supabaseAdmin
            .from('marketing_ad_sets')
            .select('campaign_id')
            .eq('id', ad.ad_set_id)
            .single();

          if (adSet.data) {
            await marketingService.pauseBoost(userId, adSet.data.campaign_id);
          }

          await logRuleTrigger({
            ruleId: rule.id,
            userId,
            actionTaken: { action: 'pause', adId: ad.id },
            success: true
          });

          await updateMarketingRule(rule.id, {
            last_triggered_at: new Date().toISOString(),
            trigger_count: (rule.trigger_count || 0) + 1
          });

          return true;
        } catch (error) {
          logger.error(`Pause rule failed: ${error.message}`);
        }
      }
    }

    return false;
  }

  /**
   * Evaluate a budget adjustment rule (placeholder for future implementation)
   */
  async _evaluateBudgetAdjustRule(userId, rule) {
    // Budget adjustment rules are more complex and will be implemented
    // as a future enhancement. For now, log and skip.
    logger.debug(`Budget adjust rules not yet implemented (rule ${rule.id})`);
    return false;
  }

  // ============================================
  // HELPERS
  // ============================================

  _getMetricValue(engagement, metric) {
    switch (metric) {
      case 'likes': return engagement.likes || 0;
      case 'comments': return engagement.comments || 0;
      case 'shares': return engagement.shares || 0;
      case 'impressions': return engagement.impressions || 0;
      case 'reach': return engagement.reach || 0;
      case 'engaged_users': return engagement.engagedUsers || 0;
      case 'total_engagement':
        return (engagement.likes || 0) + (engagement.comments || 0) + (engagement.shares || 0);
      default: return 0;
    }
  }

  _getAdMetricValue(ad, metric) {
    switch (metric) {
      case 'cpc': return parseFloat(ad.cpc) || 0;
      case 'cpm': return parseFloat(ad.cpm) || 0;
      case 'ctr': return parseFloat(ad.ctr) || 0;
      case 'spend': return parseFloat(ad.spend) || 0;
      case 'impressions': return parseInt(ad.impressions) || 0;
      case 'clicks': return parseInt(ad.clicks) || 0;
      default: return 0;
    }
  }

  _compareValues(actual, operator, threshold) {
    switch (operator) {
      case '>': return actual > threshold;
      case '>=': return actual >= threshold;
      case '<': return actual < threshold;
      case '<=': return actual <= threshold;
      case '==': return actual === threshold;
      case '!=': return actual !== threshold;
      default: return false;
    }
  }
}

export default new MarketingRulesEngine();
