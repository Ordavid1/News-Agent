// services/AutomationManager.js
// Multi-tenant agent-driven automation system
// All posting is driven by user agents with their configured schedules

import cron from 'node-cron';
import winston from 'winston';
import DatabaseManager from './DatabaseManager.js';
import PostingStrategy from './PostingStrategy.js';
import RateLimiter from './RateLimiter.js';
import trendAnalyzer from './TrendAnalyzer.js';
import ContentGenerator from './ContentGenerator.js';
import ArticleDeduplicationService from './ArticleDeduplicationService.js';
import ImageExtractor from './ImageExtractor.js';
import {
  getAgentById,
  getAgentsReadyForPosting,
  resetDailyAgentPosts,
  incrementAgentPost,
  logAgentAutomation,
  getUserById,
  calculatePostingInterval
} from './database-wrapper.js';
import { checkVideoQuota, checkAndDecrementPostQuota } from '../middleware/subscription.js';
import {
  publishToTwitter,
  publishToLinkedIn,
  publishToReddit,
  publishToFacebook,
  publishToTelegram,
  publishToWhatsApp,
  publishToInstagram,
  publishToThreads,
  publishToTikTok,
  publishToYouTube
} from './PublishingService.js';
import testProgressEmitter from './TestProgressEmitter.js';
import TokenManager from './TokenManager.js';
import { updateAgent as updateAgentInDb } from './database-wrapper.js';
import AffiliateCredentialManager from './AffiliateCredentialManager.js';
import AffiliateProductFetcher from './AffiliateProductFetcher.js';
import { getAffiliateAddon, recordAffiliatePublishedProduct } from './database-wrapper.js';
import '../config/env.js';

// Initialize logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[AutomationManager] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

class AutomationManager {
  constructor(db) {
    this.isEnabled = process.env.AUTOMATION_ENABLED === 'true';
    this.db = db;

    // Initialize services
    this.dbManager = new DatabaseManager(this.db);
    this.postingStrategy = new PostingStrategy(this.db);
    this.contentGenerator = new ContentGenerator();
    this.rateLimiter = new RateLimiter();
    this.articleDedup = new ArticleDeduplicationService(this.db);
    this.imageExtractor = new ImageExtractor();

    // Processing configuration
    this.config = {
      checkIntervalMinutes: parseInt(process.env.AUTOMATION_CHECK_INTERVAL) || 5,
      batchSize: parseInt(process.env.AUTOMATION_BATCH_SIZE) || 10,
      delayBetweenAgentsMs: 3000,    // 3 seconds between agents
      delayBetweenBatchesMs: 10000,  // 10 seconds between batches
      maxRetriesPerTrend: 3
    };

    // Track processing state
    this.isProcessing = false;
    this.lastProcessTime = null;

    if (this.isEnabled) {
      logger.info('═══════════════════════════════════════════════════════════════');
      logger.info('🤖 Multi-Tenant Agent Automation Manager');
      logger.info('═══════════════════════════════════════════════════════════════');
      logger.info(`🕐 Server timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
      logger.info(`🕐 Current server time: ${new Date().toISOString()}`);
      logger.info(`⏰ Check interval: Every ${this.config.checkIntervalMinutes} minutes`);
      logger.info(`📦 Batch size: ${this.config.batchSize} agents per batch`);

      this.initializeAgentScheduler();
      logger.info('✅ Agent-driven automation initialized and running');
    } else {
      logger.info('⚠️ Automation is DISABLED (AUTOMATION_ENABLED != true)');
    }
  }

  /**
   * Initialize the agent-driven scheduler
   * Replaces all hardcoded platform-specific schedules
   */
  initializeAgentScheduler() {
    logger.info('📅 Initializing agent-driven scheduler...');

    // Main agent processing loop - runs every N minutes
    cron.schedule(`*/${this.config.checkIntervalMinutes} * * * *`, () => {
      this.processActiveAgents();
    });

    // Daily reset of agent post counts at midnight UTC
    cron.schedule('0 0 * * *', async () => {
      logger.info('🔄 Resetting daily agent post counts...');
      try {
        await resetDailyAgentPosts();
        logger.info('✅ Daily agent post counts reset successfully');
      } catch (error) {
        logger.error('❌ Failed to reset daily agent counts:', error.message);
      }
    });

    // Rate limiter cleanup at midnight
    cron.schedule('0 0 * * *', () => {
      logger.info('🧹 Cleaning up rate limiter...');
      this.rateLimiter.cleanup();
    });

    // Daily analytics at 11 PM
    cron.schedule('0 23 * * *', () => {
      logger.info('📊 Generating daily analytics...');
      this.generateDailyReport();
    });

    // Weekly maintenance on Sundays at midnight
    cron.schedule('0 0 * * 0', () => {
      logger.info('🔧 Running weekly maintenance...');
      this.performMaintenance();
    });

    logger.info('📅 Agent scheduler initialized:');
    logger.info(`   → Agent check: Every ${this.config.checkIntervalMinutes} minutes`);
    logger.info('   → Daily reset: Midnight UTC');
    logger.info('   → Daily analytics: 11 PM UTC');
    logger.info('   → Weekly maintenance: Sunday midnight UTC');
  }

  /**
   * Main agent processing loop
   * Queries all active agents ready for posting and processes them
   */
  async processActiveAgents() {
    // Prevent concurrent processing
    if (this.isProcessing) {
      logger.warn('⏳ Previous processing cycle still running, skipping this tick');
      return;
    }

    this.isProcessing = true;
    this.lastProcessTime = new Date();

    try {
      logger.info('🔄 Starting agent processing cycle...');

      // Get all agents ready for posting
      const readyAgents = await getAgentsReadyForPosting();

      if (!readyAgents || readyAgents.length === 0) {
        logger.info('😴 No agents ready for posting at this time');
        return;
      }

      logger.info(`📋 Found ${readyAgents.length} agent(s) ready for posting`);

      // Process in batches to avoid overwhelming APIs
      const batches = this.chunkArray(readyAgents, this.config.batchSize);
      let totalProcessed = 0;
      let totalSuccess = 0;
      let totalFailed = 0;

      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        logger.info(`📦 Processing batch ${batchIndex + 1}/${batches.length} (${batch.length} agents)`);

        for (const agent of batch) {
          // Skip agents currently being tested to avoid duplicate processing and wasted API credits
          if (testProgressEmitter.isAgentBeingTested(agent.id)) {
            logger.info(`⏭️ Skipping agent ${agent.id} — currently being tested`);
            continue;
          }

          try {
            const result = await this.processAgent(agent);
            totalProcessed++;

            if (result.success) {
              totalSuccess++;
            } else {
              totalFailed++;
            }
          } catch (error) {
            logger.error(`❌ Agent ${agent.id} failed: ${error.message}`);
            totalFailed++;
            await this.handleAgentError(agent, error);
          }

          // Delay between agents to avoid rate limits
          await this.delay(this.config.delayBetweenAgentsMs);
        }

        // Delay between batches
        if (batchIndex < batches.length - 1) {
          logger.info(`⏳ Waiting ${this.config.delayBetweenBatchesMs / 1000}s before next batch...`);
          await this.delay(this.config.delayBetweenBatchesMs);
        }
      }

      logger.info('═══════════════════════════════════════════════════════════════');
      logger.info(`✅ Agent processing cycle complete`);
      logger.info(`   → Processed: ${totalProcessed} agents`);
      logger.info(`   → Successful: ${totalSuccess}`);
      logger.info(`   → Failed: ${totalFailed}`);
      logger.info('═══════════════════════════════════════════════════════════════');

    } catch (error) {
      logger.error('❌ Agent processing cycle failed:', error);
      await this.logError(error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Process a single agent - get trend, generate content, publish
   * @param {Object} agent - Agent object from database with connection info
   */
  async processAgent(agent) {
    const agentLog = (level, msg) => logger[level](`[Agent:${agent.id.slice(0, 8)}] ${msg}`);

    agentLog('info', `Processing ${agent.platform} agent "${agent.name}" for user ${agent.user_id.slice(0, 8)}...`);

    const settings = agent.settings || {};
    const userId = agent.user_id;
    const platform = agent.platform;

    // 0. Early connection validation — before ANY expensive operations
    // Prevents wasting content gen / video gen API costs on dead connections
    try {
      const connectionCheck = await TokenManager.getTokens(userId, platform);
      if (!connectionCheck || connectionCheck.status !== 'active') {
        const status = connectionCheck?.status || 'missing';
        agentLog('error', `Connection for ${platform} is ${status} — auto-pausing agent`);
        await updateAgentInDb(agent.id, { status: 'paused' });
        return { success: false, error: `connection_${status}` };
      }
    } catch (connError) {
      // Connection pre-check failed (TokenDecryptionError or other read failure).
      // Do NOT call markConnectionError() here — this pre-check is a read-only guard,
      // not an actual publishing attempt. Spurious decryption errors (race conditions,
      // concurrent writes) must not permanently kill a working connection.
      // The publishing path (PublishingService.getPublisherForUser) is the authoritative
      // place for error marking because it represents an actual user-initiated action.
      // Pause the agent conservatively to stop API credit waste, but leave connection
      // status intact. The OAuth callback auto-resumes the agent on reconnect.
      agentLog('warn', `Connection pre-check failed for ${platform}: ${connError.message} — pausing agent (connection status unchanged)`);
      await updateAgentInDb(agent.id, { status: 'paused' });
      return { success: false, error: 'connection_invalid' };
    }

    // 1. Check rate limits for this user/platform
    const canPost = await this.rateLimiter.checkLimit(userId, platform);
    if (!canPost) {
      agentLog('warn', `Rate limited for ${platform}, skipping`);
      return { success: false, error: 'rate_limited' };
    }

    // 1.5. Check if this is an affiliate product agent — use separate flow
    const contentSource = settings.contentSource || 'news';
    if (contentSource === 'affiliate_products') {
      return await this.processAffiliateAgent(agent, agentLog);
    }

    // 2. Get trending content based on agent's topics/keywords
    const trend = await this.getTrendForAgent(agent);
    if (!trend) {
      agentLog('warn', 'No suitable trend found, skipping');
      return { success: false, error: 'no_trend' };
    }

    agentLog('info', `Selected trend: "${(trend.topic || trend.title || '').slice(0, 60)}..."`);

    // 3. Generate content using agent's settings (tone, hashtags, etc.)
    const content = await this.generateContentForAgent(agent, trend);
    if (!content || !content.text) {
      agentLog('warn', 'Content generation failed, skipping');
      return { success: false, error: 'content_generation_failed' };
    }

    agentLog('info', `Generated content (${content.text.length} chars)`);

    // 3.5 Ensure we have an image for ALL platforms (extract if missing)
    if (!content.imageUrl) {
      agentLog('info', `No image available — extracting image from article...`);

      const extractedImage = await this.imageExtractor.extractImageWithRetry({
        articleUrl: trend.url,
        articleTitle: trend.title || trend.topic,
        articleSource: trend.source,
        preExistingImageUrl: trend.imageUrl || null,
        fallbackUrls: this.extractFallbackUrls(trend),
        maxRetries: 2,
        retryDelayMs: 3000
      });

      if (extractedImage) {
        content.imageUrl = extractedImage;
        agentLog('info', `Image extracted successfully: ${extractedImage}`);
      } else if (ImageExtractor.PLATFORMS_REQUIRING_MEDIA.includes(platform)) {
        // Platforms that strictly require media (Instagram, TikTok) — block the post
        agentLog('warn', `No image could be extracted for ${platform} — post blocked`);

        await logAgentAutomation(agent.id, userId, 'image_extraction_failed', {
          platform,
          trend: trend.title || trend.topic,
          trendUrl: trend.url
        });

        return {
          success: false,
          error: `${platform} requires an image but none could be extracted from the article. Post skipped.`
        };
      } else {
        // Other platforms — warn but allow text-only as last resort
        agentLog('warn', `No image could be extracted for ${platform} — publishing without image as fallback`);
      }
    } else {
      agentLog('info', `Image already available from trend data: ${content.imageUrl}`);
    }

    // 3.7 For video platforms (TikTok, YouTube): check video quota then generate video from image + caption
    const VIDEO_PLATFORMS = ['tiktok', 'youtube'];
    if (VIDEO_PLATFORMS.includes(platform)) {
      // Check video quota before expensive video generation
      try {
        const user = await getUserById(userId);
        if (user?.subscription) {
          const videoQuota = await checkVideoQuota(userId, user.subscription);
          if (!videoQuota.allowed) {
            agentLog('warn', `Video quota exhausted: ${videoQuota.error} — skipping ${platform} post`);
            return { success: false, error: 'video_limit_reached' };
          }
        }
      } catch (quotaError) {
        agentLog('error', `Video quota check failed: ${quotaError.message}`);
        // Don't block on quota check failure — allow post to proceed
      }

      if (!content.imageUrl) {
        agentLog('warn', `${platform} requires an image for video generation but none available — post blocked`);
        return { success: false, error: `${platform}_no_image_for_video` };
      }

      agentLog('info', `${platform} — generating video from article image...`);

      try {
        const videoPrompt = await this.contentGenerator.generateVideoPrompt(trend, content.text, settings, content.imageUrl);
        agentLog('info', `Video prompt generated (${videoPrompt.length} chars)`);

        const videoGenerationService = (await import('./VideoGenerationService.js')).default;

        const MAX_CONTENT_FILTER_RETRIES = 2;
        let videoResult;
        let currentPrompt = videoPrompt;
        let contentFilterExhausted = false;

        for (let attempt = 0; attempt <= MAX_CONTENT_FILTER_RETRIES; attempt++) {
          try {
            videoResult = await videoGenerationService.generateVideo({
              imageUrl: content.imageUrl,
              prompt: currentPrompt
            });
            break; // Success — exit retry loop
          } catch (filterError) {
            if (filterError.isContentFilter && attempt < MAX_CONTENT_FILTER_RETRIES) {
              // Content filter block — use LLM to rephrase the prompt and retry
              agentLog('warn', `Video blocked by content filter (${filterError.model}) — rephrasing prompt (attempt ${attempt + 1}/${MAX_CONTENT_FILTER_RETRIES})...`);

              currentPrompt = await this.contentGenerator.rephraseVideoPrompt(filterError.originalPrompt, trend, { model: filterError.model, attemptNumber: attempt + 1 });
              agentLog('info', `Rephrased video prompt generated (${currentPrompt.length} chars)`);
              agentLog('info', `Retrying video generation with rephrased prompt (attempt ${attempt + 2})...`);
            } else if (filterError.isContentFilter) {
              contentFilterExhausted = true; // All rephrase retries exhausted
              break;
            } else {
              throw filterError; // Non-filter errors propagate immediately
            }
          }
        }

        // Final fallback: if all rephrase retries were blocked, the source IMAGE itself
        // is likely triggering the content filter. Try once more without the reference image.
        if (contentFilterExhausted && !videoResult) {
          agentLog('warn', 'All rephrase retries exhausted — source image likely triggers filter. Trying text-only video generation...');

          videoResult = await videoGenerationService.generateVideo({
            imageUrl: content.imageUrl,
            prompt: currentPrompt,
            skipImage: true
          });
        }

        content.videoUrl = videoResult.videoUrl;
        content.videoBuffer = videoResult.videoBuffer || null;
        agentLog('info', `Video generated successfully — model: ${videoResult.model}, duration: ${videoResult.duration}s`);

        // Decrement video quota after successful generation
        try {
          const { supabaseAdmin } = await import('./supabase.js');
          await supabaseAdmin.rpc('decrement_videos_remaining', { p_user_id: userId });
          agentLog('info', 'Video quota decremented');
        } catch (decrementError) {
          agentLog('error', `Failed to decrement video quota: ${decrementError.message}`);
        }
      } catch (videoError) {
        const errorDetail = videoError.isContentFilter
          ? `Video blocked by content filter even after rephrasing: ${videoError.message}`
          : videoError.message;
        agentLog('error', `Video generation failed: ${errorDetail}`);
        await logAgentAutomation(agent.id, userId, 'video_generation_failed', {
          platform,
          trend: trend.title || trend.topic,
          error: errorDetail
        });
        return { success: false, error: `Video generation failed: ${errorDetail}` };
      }
    }

    // 3.9 Re-check agent eligibility from DB before publishing (guards against race
    // conditions where a manual test post was published during content generation)
    const freshAgent = await getAgentById(agent.id);
    if (freshAgent) {
      const freshPostsToday = freshAgent.posts_today || 0;
      const maxPosts = (settings.schedule?.postsPerDay) || 3;
      if (freshPostsToday >= maxPosts) {
        agentLog('warn', `Agent already at ${freshPostsToday}/${maxPosts} posts (concurrent post detected) — skipping`);
        return { success: false, error: 'daily_limit_reached_after_generation' };
      }

      // Guard against duplicate posts: re-check interval since last publish
      if (freshAgent.last_posted_at) {
        const schedule = settings.schedule || { postsPerDay: 3, startTime: '09:00', endTime: '21:00' };
        const intervalMs = calculatePostingInterval(schedule);
        const timeSinceLastPost = Date.now() - new Date(freshAgent.last_posted_at).getTime();
        if (timeSinceLastPost < intervalMs) {
          const minutesLeft = Math.ceil((intervalMs - timeSinceLastPost) / 60000);
          agentLog('warn', `Published too recently (${minutesLeft} min until next allowed) — skipping`);
          return { success: false, error: 'interval_not_met' };
        }
      }
    }

    // 3.10 Check user's subscription post quota before publishing
    const quotaResult = await checkAndDecrementPostQuota(userId);
    if (!quotaResult.allowed) {
      agentLog('warn', `User post quota exhausted (${quotaResult.error}) — skipping`);
      return { success: false, error: quotaResult.error };
    }

    // 4. Publish using user's OAuth credentials
    const publishResult = await this.publishForAgent(agent, content, trend);

    if (publishResult.success) {
      // 5. Update agent statistics
      await incrementAgentPost(agent.id);

      // 6. Record rate limit usage
      await this.rateLimiter.recordUsage(userId, platform);

      // 7. Mark trend as used (if supported)
      if (trend.score !== undefined) {
        await this.postingStrategy.markTrendAsUsed(trend);
      }

      // 8. Mark article as used in persistent deduplication (prevents reuse for 24h)
      if (trend.url) {
        await this.articleDedup.markArticleUsed(agent.id, {
          url: trend.url,
          title: trend.title || trend.topic,
          publishedAt: trend.publishedAt,
          source: trend.source
        });
      }

      // 9. Log publication
      await this.logAgentPublication(agent, trend, content, publishResult);

      agentLog('info', `✅ Successfully posted to ${platform}`);

      return {
        success: true,
        platform,
        postId: publishResult.postId,
        url: publishResult.url
      };
    } else {
      agentLog('error', `Publishing failed: ${publishResult.error}`);

      // Log the failure
      await logAgentAutomation(agent.id, userId, 'publish_failed', {
        platform,
        error: publishResult.error,
        trend: trend.topic || trend.title
      });

      return {
        success: false,
        error: publishResult.error
      };
    }
  }

  /**
   * Process an affiliate product agent — fetches product, generates content, publishes.
   * Separate flow from news agents but reuses the publishing infrastructure.
   * @param {Object} agent - Agent with contentSource: 'affiliate_products'
   * @param {Function} agentLog - Scoped logger
   * @returns {Object} { success, error? }
   */
  async processAffiliateAgent(agent, agentLog) {
    const userId = agent.user_id;
    const platform = agent.platform;

    // 1. Verify user has active affiliate add-on
    const addon = await getAffiliateAddon(userId);
    if (!addon || addon.status !== 'active') {
      agentLog('warn', 'Affiliate add-on not active — pausing agent');
      await updateAgentInDb(agent.id, { status: 'paused' });
      return { success: false, error: 'addon_inactive' };
    }

    // 2. Load AE credentials
    const credentials = await AffiliateCredentialManager.getCredentials(userId);
    if (!credentials || credentials.status !== 'active') {
      agentLog('warn', 'AE credentials not configured or invalid — skipping');
      return { success: false, error: 'credentials_invalid' };
    }

    // 3. Fetch best product for this agent
    let product;
    try {
      product = await AffiliateProductFetcher.getProductForAgent(agent, credentials);
    } catch (fetchError) {
      agentLog('error', `Product fetch failed: ${fetchError.message}`);
      return { success: false, error: 'product_fetch_failed' };
    }

    if (!product) {
      agentLog('info', 'No suitable product found (all published or no matches)');
      return { success: false, error: 'no_product' };
    }

    agentLog('info', `Selected product: "${product.title.slice(0, 60)}..." (${product.commissionRate}% commission)`);

    // 4. Check subscription quota before expensive content generation
    const quotaCheck = await checkAndDecrementPostQuota(userId);
    if (!quotaCheck.allowed) {
      agentLog('warn', `Post quota exceeded: ${quotaCheck.error}`);
      return { success: false, error: quotaCheck.error };
    }

    // 5. Generate content
    let content;
    try {
      content = await this.contentGenerator.generateAffiliateContent(product, platform, agent.settings);
    } catch (genError) {
      agentLog('error', `Affiliate content generation failed: ${genError.message}`);
      return { success: false, error: 'content_generation_failed' };
    }

    // 5.5. Pre-warm the affiliate URL so platforms can fetch OG metadata for link preview
    try {
      agentLog('info', 'Pre-warming affiliate URL for link preview...');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      await fetch(product.affiliateUrl, {
        method: 'HEAD',
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LinkPreview/1.0)' }
      });
      clearTimeout(timeout);
      // Brief delay to let CDN/edge caches propagate the resolved OG data
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (warmErr) {
      agentLog('warn', `Link pre-warm failed (non-blocking): ${warmErr.message}`);
    }

    // 6. Publish via existing infrastructure
    const publishResult = await this.publishForAgent(agent, content, {
      title: product.title,
      url: product.affiliateUrl,
      urlToImage: product.imageUrl
    });

    if (publishResult.success) {
      // 7. Record published product for deduplication
      try {
        await recordAffiliatePublishedProduct({
          userId,
          agentId: agent.id,
          productId: product.productId,
          platform,
          productTitle: product.title,
          productUrl: product.productUrl,
          affiliateUrl: product.affiliateUrl,
          commissionRate: product.commissionRate,
          salePrice: product.salePrice,
          imageUrl: product.imageUrl
        });
      } catch (recordError) {
        agentLog('warn', `Failed to record published product (dedup may not work): ${recordError.message}`);
      }

      // 8. Increment agent post counter + log automation
      await incrementAgentPost(agent.id);
      await logAgentAutomation(agent.id, userId, platform, {
        contentType: 'affiliate_product',
        productId: product.productId,
        productTitle: product.title,
        commissionRate: product.commissionRate
      });

      agentLog('info', `Successfully published affiliate product to ${platform}`);
      return { success: true };
    }

    agentLog('error', `Failed to publish affiliate product: ${publishResult.error}`);
    return { success: false, error: publishResult.error };
  }

  /**
   * Get trending content based on agent's configured topics and keywords
   * @param {Object} agent - Agent with settings
   */
  async getTrendForAgent(agent) {
    const settings = agent.settings || {};
    const topics = settings.topics || [];
    const keywords = settings.keywords || [];
    const geoFilter = settings.geoFilter || { region: '', includeGlobal: true };

    try {
      // If agent has specific topics configured, use them to find trends
      if (topics.length > 0) {
        logger.debug(`Agent ${agent.id}: Searching trends for topics: ${topics.join(', ')}`);

        const trendsForTopics = await trendAnalyzer.getTrendsForTopics(topics, {
          keywords,
          geoFilter,
          limit: 10
        });

        if (trendsForTopics && trendsForTopics.length > 0) {
          // Score and select the best trend
          const scored = await this.scoreAndSelectTrend(trendsForTopics, agent);
          if (scored) {
            return scored;
          }
        }
      }

      // Fallback: get general trends and filter by platform preference
      logger.debug(`Agent ${agent.id}: Using general trends fallback`);

      const generalTrend = await this.postingStrategy.getOptimalTrend({
        preferredCategory: this.mapPlatformToCategory(agent.platform),
        returnMultiple: false,
        userId: agent.user_id
      });

      if (!generalTrend) return null;

      // For platforms that require media (Instagram, TikTok), enrich keyword-only
      // trends with article data so image extraction has a URL to work with
      if (ImageExtractor.PLATFORMS_REQUIRING_MEDIA.includes(agent.platform) && !generalTrend.url) {
        logger.debug(`Agent ${agent.id}: Trend "${generalTrend.topic}" lacks article URL — enriching for ${agent.platform}`);

        try {
          const enrichedTrends = await trendAnalyzer.getTrendsForTopics(
            [generalTrend.topic],
            { limit: 5 }
          );

          if (enrichedTrends && enrichedTrends.length > 0) {
            const article = enrichedTrends[0];
            generalTrend.url = article.url;
            generalTrend.title = article.title || generalTrend.topic;
            generalTrend.description = article.description || generalTrend.description;
            generalTrend.imageUrl = article.imageUrl || null;
            generalTrend.publishedAt = article.publishedAt || null;
            generalTrend.source = article.source || generalTrend.source;
            logger.debug(`Agent ${agent.id}: Enriched trend with article: "${article.title}" (${article.url})`);
          } else {
            logger.warn(`Agent ${agent.id}: No articles found for trend "${generalTrend.topic}" — media platforms may fail`);
          }
        } catch (enrichError) {
          logger.warn(`Agent ${agent.id}: Trend enrichment failed: ${enrichError.message}`);
        }
      }

      return generalTrend;

    } catch (error) {
      logger.error(`Error getting trend for agent ${agent.id}:`, error.message);
      return null;
    }
  }

  /**
   * Score and select the best trend from a list
   * Prefers fresh, unused topics with good source diversity
   */
  async scoreAndSelectTrend(trends, agent) {
    if (!trends || trends.length === 0) return null;

    // Filter through persistent article deduplication first
    // This removes articles that were already used by this agent (exact URL or similar story)
    const usableTrends = await this.articleDedup.filterUsableArticles(agent.id, trends);
    if (usableTrends.length === 0) {
      logger.warn(`[Agent:${agent.id.slice(0, 8)}] All ${trends.length} trends filtered by article deduplication`);
      return null;
    }

    // Get recently used topics to avoid repetition
    const recentlyUsed = await this.getRecentlyUsedTopics(agent.user_id, agent.platform, 24);

    const scored = usableTrends.map(trend => {
      let score = 50; // Base score

      const title = trend.title || trend.topic || '';
      const titleLower = title.toLowerCase();

      // Penalize recently used topics
      const wasRecentlyUsed = recentlyUsed.some(used =>
        used && titleLower.includes(used.toLowerCase().slice(0, 30))
      );
      if (wasRecentlyUsed) {
        score -= 50;
      }

      // Recency bonus
      if (trend.publishedAt) {
        const ageHours = (Date.now() - new Date(trend.publishedAt).getTime()) / (1000 * 60 * 60);
        if (ageHours < 2) score += 30;
        else if (ageHours < 6) score += 20;
        else if (ageHours < 12) score += 10;
      }

      // Source diversity bonus
      const sources = Array.isArray(trend.sources) ? trend.sources.length : 1;
      score += Math.min(sources * 5, 20);

      // Confidence bonus
      if (trend.confidence) {
        score += trend.confidence * 20;
      }

      return { ...trend, calculatedScore: score };
    });

    // Sort by score and return best
    scored.sort((a, b) => b.calculatedScore - a.calculatedScore);
    return scored[0] || null;
  }

  /**
   * Get recently used topics for this user/platform
   */
  async getRecentlyUsedTopics(userId, platform, hours = 24) {
    try {
      const since = new Date();
      since.setHours(since.getHours() - hours);

      const { data, error } = await this.db
        .from('published_posts')
        .select('trend, content')
        .eq('user_id', userId)
        .eq('platform', platform)
        .gt('published_at', since.toISOString())
        .order('published_at', { ascending: false })
        .limit(20);

      if (error) {
        if (error.code === 'PGRST116' || error.code === '42P01') {
          return []; // Table doesn't exist yet
        }
        throw error;
      }

      return (data || []).map(post => {
        return post.trend?.topic || post.trend?.title || '';
      }).filter(t => t);

    } catch (error) {
      logger.debug(`Error fetching recent topics: ${error.message}`);
      return [];
    }
  }

  /**
   * Map platform to preferred content category
   */
  mapPlatformToCategory(platform) {
    const mapping = {
      linkedin: 'tech',      // LinkedIn focuses on professional/tech
      twitter: null,         // Twitter - all categories
      reddit: null,          // Reddit - all categories
      facebook: null,        // Facebook - all categories
      telegram: 'tech',      // Telegram - tech focused
      whatsapp: null,        // WhatsApp - all categories
      instagram: null,       // Instagram - all categories
      tiktok: null,          // TikTok - all categories
      threads: null          // Threads - all categories
    };
    return mapping[platform] || null;
  }

  /**
   * Extract fallback URLs from a trend object for image extraction retries.
   * Trends may carry metadata with original URLs from different sources.
   * @param {Object} trend - Trend object
   * @returns {string[]} Array of alternative URLs to try
   */
  extractFallbackUrls(trend) {
    const urls = [];

    // Check metadata for original URLs from different sources
    if (trend.metadata && typeof trend.metadata === 'object') {
      for (const meta of Object.values(trend.metadata)) {
        if (meta?.originalUrl && meta.originalUrl !== trend.url) {
          urls.push(meta.originalUrl);
        }
        if (meta?.url && meta.url !== trend.url) {
          urls.push(meta.url);
        }
        // Extract article URLs from Google News RSS / SerpAPI metadata
        if (Array.isArray(meta?.articles)) {
          for (const article of meta.articles) {
            const articleUrl = article?.link || article?.url;
            if (articleUrl && articleUrl !== trend.url) {
              urls.push(articleUrl);
            }
          }
        }
      }
    }

    // Check for sourceUrl or originalUrl directly on trend
    if (trend.sourceUrl && trend.sourceUrl !== trend.url) {
      urls.push(trend.sourceUrl);
    }
    if (trend.originalUrl && trend.originalUrl !== trend.url) {
      urls.push(trend.originalUrl);
    }

    return [...new Set(urls)]; // Deduplicate
  }

  /**
   * Generate content using agent's configured style settings
   * @param {Object} agent - Agent with settings
   * @param {Object} trend - Selected trend
   */
  async generateContentForAgent(agent, trend) {
    const settings = agent.settings || {};
    const platform = agent.platform;

    // Build agentSettings object for ContentGenerator
    const agentSettings = {
      topics: settings.topics || [],
      keywords: settings.keywords || [],
      geoFilter: settings.geoFilter || {},
      contentStyle: {
        tone: settings.contentStyle?.tone || 'professional',
        includeHashtags: settings.contentStyle?.includeHashtags ?? true
      },
      platformSettings: settings.platformSettings || {}
    };

    try {
      // Use the ContentGenerator which already supports agentSettings
      const result = await this.contentGenerator.generateContent(
        trend,
        platform,
        agentSettings
      );

      if (result && result.text) {
        return {
          text: result.text,
          trend: trend.title || trend.topic,
          topic: settings.topics?.[0] || 'general',
          source: trend,
          imageUrl: result.imageUrl || trend.imageUrl || null,
          generatedAt: new Date().toISOString()
        };
      }

      return null;

    } catch (error) {
      logger.error(`Content generation failed for agent ${agent.id}:`, error.message);
      return null;
    }
  }

  /**
   * Publish content using user's OAuth credentials via PublishingService
   * @param {Object} agent - Agent with settings
   * @param {Object} content - Generated content
   * @param {Object} trend - Source trend
   */
  async publishForAgent(agent, content, trend) {
    const userId = agent.user_id;
    const platform = agent.platform;
    const settings = agent.settings || {};
    const platformSettings = settings.platformSettings || {};

    try {
      let result;
      const imageUrl = content.imageUrl || null;

      switch (platform) {
        case 'twitter':
          result = await publishToTwitter(content, userId, imageUrl);
          break;

        case 'linkedin':
          result = await publishToLinkedIn(content, userId, imageUrl);
          break;

        case 'reddit':
          // Use subreddit and flair from agent settings
          const subreddit = platformSettings.reddit?.subreddit || null;
          const flairId = platformSettings.reddit?.flairId || null;
          result = await publishToReddit(content, subreddit, userId, flairId, imageUrl);
          break;

        case 'facebook':
          result = await publishToFacebook(content, userId, imageUrl);
          break;

        case 'telegram':
          result = await publishToTelegram(content, userId, imageUrl);
          break;

        case 'whatsapp':
          result = await publishToWhatsApp(content, userId, imageUrl);
          break;

        case 'instagram':
          // Instagram requires an image — skip gracefully if no image available
          if (!imageUrl) {
            logger.warn(`Skipping Instagram for agent ${agent.id}: no image available (Instagram requires media)`);
            return {
              success: false,
              platform,
              error: 'Instagram requires an image or video. Post skipped because no media was available.'
            };
          }
          result = await publishToInstagram(content, userId, imageUrl);
          break;

        case 'threads':
          result = await publishToThreads(content, userId, imageUrl);
          break;

        case 'tiktok':
          // TikTok requires a video URL — generated in step 3.7
          if (!content.videoUrl) {
            logger.warn(`Skipping TikTok for agent ${agent.id}: no video URL available`);
            return {
              success: false,
              platform,
              error: 'TikTok requires a video. Video generation must complete before publishing.'
            };
          }
          result = await publishToTikTok(content, userId, content.videoUrl);
          break;

        case 'youtube':
          // YouTube Shorts requires a video URL — generated in step 3.7
          if (!content.videoUrl) {
            logger.warn(`Skipping YouTube for agent ${agent.id}: no video URL available`);
            return {
              success: false,
              platform,
              error: 'YouTube requires a video. Video generation must complete before publishing.'
            };
          }
          result = await publishToYouTube(content, userId, content.videoUrl);
          break;

        default:
          throw new Error(`Unsupported platform: ${platform}`);
      }

      return result;

    } catch (error) {
      logger.error(`Publishing failed for agent ${agent.id} on ${platform}:`, error.message);
      return {
        success: false,
        platform,
        error: error.message
      };
    }
  }

  /**
   * Log successful publication for analytics
   */
  async logAgentPublication(agent, trend, content, result) {
    try {
      const postData = {
        agent_id: agent.id,
        user_id: agent.user_id,
        trend: trend,
        platform: agent.platform,
        platform_post_id: result.postId,
        platform_url: result.url,
        success: result.success,
        content: content.text
      };

      try {
        await this.dbManager.savePublishedPost(postData);
      } catch (dbError) {
        // If agent_id column doesn't exist yet, retry without it
        if (dbError.message?.includes('agent_id') || dbError.message?.includes('schema cache')) {
          logger.warn('published_posts missing agent_id column — saving without it. Run the migration: supabase/migrations/add_agent_id_to_published_posts.sql');
          const { agent_id, user_id, ...postDataWithoutAgentFields } = postData;
          await this.dbManager.savePublishedPost(postDataWithoutAgentFields);
        } else {
          throw dbError;
        }
      }

      // Also log to automation_logs for tracking
      await logAgentAutomation(agent.id, agent.user_id, 'post_published', {
        platform: agent.platform,
        trend: trend.topic || trend.title,
        postId: result.postId,
        url: result.url
      });

    } catch (error) {
      logger.warn('Error logging agent publication:', error.message);
    }
  }

  /**
   * Handle agent processing errors
   */
  async handleAgentError(agent, error) {
    try {
      await logAgentAutomation(agent.id, agent.user_id, 'error', {
        platform: agent.platform,
        error_message: error.message,
        error_name: error.name
      });
    } catch (logError) {
      logger.error('Failed to log agent error:', logError.message);
    }
  }

  /**
   * Generate daily analytics report
   */
  async generateDailyReport() {
    try {
      logger.info('Generating daily analytics report...');

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const posts = await this.dbManager.getPublishedPostsSince(today);

      const report = {
        date: new Date().toISOString(),
        total_posts: posts.length,
        platforms: {},
        agents_active: new Set(),
        success_rate: 0
      };

      // Analyze posts
      posts.forEach(post => {
        if (!report.platforms[post.platform]) {
          report.platforms[post.platform] = { total: 0, successful: 0 };
        }

        report.platforms[post.platform].total++;
        if (post.success) {
          report.platforms[post.platform].successful++;
        }

        if (post.agent_id) {
          report.agents_active.add(post.agent_id);
        }
      });

      // Calculate success rate
      const totalAttempts = posts.length;
      const successful = posts.filter(p => p.success).length;
      report.success_rate = totalAttempts > 0 ? (successful / totalAttempts) * 100 : 0;
      report.agents_active = report.agents_active.size;

      // Save report
      await this.dbManager.saveDailyReport(report);

      logger.info('✅ Daily report generated:', JSON.stringify(report, null, 2));

    } catch (error) {
      logger.error('Error generating daily report:', error);
    }
  }

  /**
   * Perform weekly maintenance tasks
   */
  async performMaintenance() {
    try {
      logger.info('Performing weekly maintenance...');

      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      await this.dbManager.cleanupOldPosts(thirtyDaysAgo);
      await this.dbManager.cleanupOldTrends(thirtyDaysAgo);

      // Clean up old article usage records (keep 48 hours for deduplication window)
      const cleanedArticles = await this.articleDedup.cleanup(48);
      if (cleanedArticles > 0) {
        logger.info(`Cleaned up ${cleanedArticles} old article usage records`);
      }

      logger.info('✅ Maintenance completed');

    } catch (error) {
      logger.error('Error during maintenance:', error);
    }
  }

  /**
   * Log automation errors
   */
  async logError(error) {
    try {
      await this.db
        .from('automation_logs')
        .insert({
          type: 'error',
          error_message: error.message,
          error_stack: error.stack,
          error_name: error.name,
          timestamp: new Date().toISOString(),
          context: 'agent_automation'
        });
    } catch (logError) {
      logger.error('Failed to log error to database:', logError.message);
    }
  }

  // Utility methods

  chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Status method for debugging
  getStatus() {
    return {
      enabled: this.isEnabled,
      isProcessing: this.isProcessing,
      lastProcessTime: this.lastProcessTime,
      config: this.config
    };
  }
}

export default AutomationManager;
