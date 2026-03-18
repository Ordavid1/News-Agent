/**
 * ArticleDeduplicationService
 *
 * Provides persistent, per-agent article deduplication to prevent:
 * 1. Exact URL reuse within a configurable cooldown period
 * 2. Same story from different outlets (cross-outlet detection via fingerprinting)
 *
 * This service integrates with the automation system to ensure agents
 * don't post duplicate or near-duplicate content.
 */

import winston from 'winston';
import OpenAI from 'openai';
import ArticleFingerprintService from './ArticleFingerprintService.js';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[ArticleDedup] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

class ArticleDeduplicationService {
  constructor(db) {
    this.db = db;
    this.fingerprintService = new ArticleFingerprintService();

    // Initialize OpenAI for topic+context analysis
    const apiKey = process.env.OPENAI_API_KEY;
    this.openai = apiKey ? new OpenAI({ apiKey }) : null;

    // Configuration - can be overridden via environment variables
    this.config = {
      cooldownHours: parseInt(process.env.ARTICLE_DEDUP_COOLDOWN_HOURS) || 24,
      similarityWindowHours: parseInt(process.env.ARTICLE_DEDUP_SIMILARITY_WINDOW) || 48,
      maxSimilarityResults: 100,
      keywordOverlapThreshold: parseFloat(process.env.ARTICLE_DEDUP_KEYWORD_OVERLAP) || 0.5,
      entityOverlapThreshold: parseFloat(process.env.ARTICLE_DEDUP_ENTITY_OVERLAP) || 0.6,
      topicContextWindowHours: parseInt(process.env.ARTICLE_DEDUP_TOPIC_CONTEXT_WINDOW) || 72
    };

    logger.info(`ArticleDeduplicationService initialized with config: ${JSON.stringify(this.config)}`);
  }

  /**
   * Check if an article can be used by a specific agent
   * @param {string} agentId - The agent ID (UUID)
   * @param {Object} article - Article with url, title, publishedAt
   * @returns {Object} { canUse: boolean, reason?: string, message?: string }
   */
  async checkArticleUsability(agentId, article) {
    if (!agentId || !article?.url) {
      logger.warn('checkArticleUsability called with missing agentId or article URL');
      return { canUse: true, warning: 'missing_params' };
    }

    const urlHash = this.fingerprintService.generateUrlHash(article.url);
    const fingerprint = this.fingerprintService.generateFingerprint(article);

    try {
      // 1. Check exact URL match (fast, indexed query)
      const exactMatch = await this.checkExactUrlMatch(agentId, urlHash);
      if (exactMatch) {
        logger.debug(`Article blocked - exact URL reuse: ${article.url.substring(0, 60)}...`);
        return {
          canUse: false,
          reason: 'exact_url_reuse',
          message: `URL already used ${exactMatch.hoursAgo.toFixed(1)} hours ago`
        };
      }

      // 2. Check similar story fingerprint
      const similarMatch = await this.checkSimilarStory(agentId, fingerprint);
      if (similarMatch) {
        logger.debug(`Article blocked - similar story: "${article.title?.substring(0, 50)}..." similar to "${similarMatch.title?.substring(0, 50)}..."`);
        return {
          canUse: false,
          reason: 'similar_story',
          message: `Similar story already used: "${similarMatch.title?.substring(0, 60)}..."`
        };
      }

      // 3. Check topic+context overlap (LLM-generated semantic summary)
      const topicContextMatch = await this.checkTopicContextOverlap(agentId, article);
      if (topicContextMatch) {
        logger.debug(`Article blocked - same topic+context: "${article.title?.substring(0, 50)}..." overlaps with "${topicContextMatch.title?.substring(0, 50)}..."`);
        return {
          canUse: false,
          reason: 'topic_context_overlap',
          message: `Same topic already covered: "${topicContextMatch.topicContext}"`
        };
      }

      return { canUse: true };

    } catch (error) {
      logger.error(`Error checking article usability: ${error.message}`);
      // On error, allow the article (fail open to avoid blocking automation)
      return { canUse: true, warning: 'dedup_check_failed' };
    }
  }

  /**
   * Check for exact URL match within cooldown window
   * @param {string} agentId - Agent ID
   * @param {string} urlHash - MD5 hash of normalized URL
   * @returns {Object|null} Match details or null
   */
  async checkExactUrlMatch(agentId, urlHash) {
    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - this.config.cooldownHours);

    const { data, error } = await this.db
      .from('agent_article_usage')
      .select('used_at, article_title')
      .eq('agent_id', agentId)
      .eq('article_url_hash', urlHash)
      .gt('used_at', cutoff.toISOString())
      .limit(1);

    if (error) {
      logger.error(`Error checking exact URL match: ${error.message}`);
      return null;
    }

    if (data && data.length > 0) {
      const hoursAgo = (Date.now() - new Date(data[0].used_at).getTime()) / (1000 * 60 * 60);
      return {
        match: true,
        hoursAgo,
        title: data[0].article_title
      };
    }

    return null;
  }

  /**
   * Check for similar story using fingerprint comparison
   * @param {string} agentId - Agent ID
   * @param {string} fingerprint - Story fingerprint to check
   * @returns {Object|null} Match details or null
   */
  async checkSimilarStory(agentId, fingerprint) {
    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - this.config.similarityWindowHours);

    // Get recent fingerprints for this agent
    const { data, error } = await this.db
      .from('agent_article_usage')
      .select('story_fingerprint, article_title')
      .eq('agent_id', agentId)
      .gt('used_at', cutoff.toISOString())
      .order('used_at', { ascending: false })
      .limit(this.config.maxSimilarityResults);

    if (error) {
      logger.error(`Error checking similar stories: ${error.message}`);
      return null;
    }

    if (!data || data.length === 0) {
      return null;
    }

    // Compare fingerprints
    for (const record of data) {
      const matches = this.fingerprintService.fingerprintsMatch(
        fingerprint,
        record.story_fingerprint,
        {
          entityOverlapThreshold: this.config.entityOverlapThreshold,
          keywordOverlapThreshold: this.config.keywordOverlapThreshold
        }
      );

      if (matches) {
        return {
          match: true,
          fingerprint: record.story_fingerprint,
          title: record.article_title
        };
      }
    }

    return null;
  }

  /**
   * Generate a ~100 char topic+context summary using gpt-5-nano
   * @param {Object} article - Article with title, description, content
   * @returns {string|null} Topic+context string or null on failure
   */
  async generateTopicContext(article) {
    if (!this.openai) {
      logger.debug('OpenAI not available, skipping topic+context generation');
      return null;
    }

    const title = article.title || '';
    const description = article.description || '';
    const snippet = `${title}. ${description}`.substring(0, 500);

    try {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-5-nano',
        messages: [
          {
            role: 'system',
            content: 'You extract the core topic and context of news articles. Respond with ONLY a concise topic+context label, max 100 characters. Format: "[specific subject] — [key context/angle]". Examples: "NFL 2026 Draft WR prospects — rankings and predictions", "Tesla Q4 earnings — revenue miss and stock impact", "Israel-Iran tensions — diplomatic response to drone strikes"'
          },
          {
            role: 'user',
            content: snippet
          }
        ],
        max_completion_tokens: 60,
        temperature: 0
      });

      const topicContext = completion.choices[0]?.message?.content?.trim();
      if (topicContext && topicContext.length <= 150) {
        logger.debug(`Generated topic+context: "${topicContext}" for "${title.substring(0, 50)}..."`);
        return topicContext;
      }
      return topicContext ? topicContext.substring(0, 150) : null;
    } catch (error) {
      logger.error(`Error generating topic+context: ${error.message}`);
      return null;
    }
  }

  /**
   * Check if an article's topic+context overlaps with recently used articles
   * Generates a topic+context for the candidate article, then compares against stored ones
   * @param {string} agentId - Agent ID
   * @param {Object} article - Article to check
   * @returns {Object|null} Match details or null
   */
  async checkTopicContextOverlap(agentId, article) {
    if (!this.openai) return null;

    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - this.config.topicContextWindowHours);

    // Fetch recent topic_context values for this agent
    const { data, error } = await this.db
      .from('agent_article_usage')
      .select('topic_context, article_title')
      .eq('agent_id', agentId)
      .not('topic_context', 'is', null)
      .gt('used_at', cutoff.toISOString())
      .order('used_at', { ascending: false })
      .limit(50);

    if (error || !data || data.length === 0) {
      return null;
    }

    // Generate topic+context for the candidate article
    const candidateContext = await this.generateTopicContext(article);
    if (!candidateContext) return null;

    // Temporarily store on article for later use in markArticleUsed
    article._topicContext = candidateContext;

    // Compare: normalize both strings and check for high token overlap
    const candidateTokens = new Set(candidateContext.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(t => t.length > 2));

    for (const record of data) {
      const existingTokens = new Set(record.topic_context.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(t => t.length > 2));

      // Calculate overlap
      let common = 0;
      for (const token of candidateTokens) {
        if (existingTokens.has(token)) common++;
      }
      const smaller = Math.min(candidateTokens.size, existingTokens.size);
      const overlap = smaller > 0 ? common / smaller : 0;

      // 70% token overlap = same topic
      if (overlap >= 0.7) {
        logger.info(`Topic+context overlap ${(overlap * 100).toFixed(0)}%: "${candidateContext}" ≈ "${record.topic_context}"`);
        return {
          match: true,
          topicContext: record.topic_context,
          title: record.article_title,
          overlap
        };
      }
    }

    return null;
  }

  /**
   * Mark an article as used by an agent
   * @param {string} agentId - Agent ID
   * @param {Object} article - Article with url, title, publishedAt, source
   * @param {string} [topicContext] - Optional pre-generated topic+context
   * @returns {boolean} Success status
   */
  async markArticleUsed(agentId, article, topicContext = null) {
    if (!agentId || !article?.url) {
      logger.warn('markArticleUsed called with missing agentId or article URL');
      return false;
    }

    const urlHash = this.fingerprintService.generateUrlHash(article.url);
    const fingerprint = this.fingerprintService.generateFingerprint(article);
    const publishedDate = article.publishedAt
      ? new Date(article.publishedAt).toISOString().split('T')[0]
      : new Date().toISOString().split('T')[0];

    // Use pre-generated topic_context from dedup check, or generate now
    const resolvedTopicContext = topicContext || article._topicContext || await this.generateTopicContext(article);

    try {
      const { error } = await this.db
        .from('agent_article_usage')
        .upsert({
          agent_id: agentId,
          article_url: article.url,
          article_url_hash: urlHash,
          story_fingerprint: fingerprint,
          article_title: article.title || null,
          article_source: article.source?.name || article.source || 'unknown',
          published_date: publishedDate,
          used_at: new Date().toISOString(),
          topic_context: resolvedTopicContext
        }, {
          onConflict: 'agent_id,article_url_hash',
          ignoreDuplicates: false // Update timestamp on re-use attempt
        });

      if (error) {
        logger.error(`Error marking article as used: ${error.message}`);
        return false;
      }

      logger.debug(`Marked article used for agent ${agentId}: "${article.title?.substring(0, 50)}..."`);
      return true;

    } catch (error) {
      logger.error(`Error in markArticleUsed: ${error.message}`);
      return false;
    }
  }

  /**
   * Batch check multiple articles for usability
   * More efficient than individual checks for filtering lists
   * @param {string} agentId - Agent ID
   * @param {Object[]} articles - Array of articles to check
   * @returns {Object[]} Array of usable articles
   */
  async filterUsableArticles(agentId, articles) {
    if (!agentId || !articles || articles.length === 0) {
      return articles || [];
    }

    const results = [];
    let blockedExact = 0;
    let blockedSimilar = 0;
    let blockedTopicContext = 0;

    for (const article of articles) {
      const check = await this.checkArticleUsability(agentId, article);
      if (check.canUse) {
        results.push(article);
      } else {
        if (check.reason === 'exact_url_reuse') blockedExact++;
        if (check.reason === 'similar_story') blockedSimilar++;
        if (check.reason === 'topic_context_overlap') blockedTopicContext++;
        logger.debug(`Filtered out article (${check.reason}): "${article.title?.substring(0, 50)}..."`);
      }
    }

    if (blockedExact > 0 || blockedSimilar > 0 || blockedTopicContext > 0) {
      logger.info(`Agent ${agentId}: Filtered ${articles.length} -> ${results.length} articles (${blockedExact} exact URL, ${blockedSimilar} similar story, ${blockedTopicContext} topic overlap)`);
    }

    return results;
  }

  /**
   * Get usage statistics for an agent
   * @param {string} agentId - Agent ID
   * @param {number} hours - Hours to look back
   * @returns {Object} Statistics
   */
  async getAgentStats(agentId, hours = 24) {
    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - hours);

    try {
      const { data, error, count } = await this.db
        .from('agent_article_usage')
        .select('article_source, used_at', { count: 'exact' })
        .eq('agent_id', agentId)
        .gt('used_at', cutoff.toISOString());

      if (error) {
        logger.error(`Error getting agent stats: ${error.message}`);
        return { error: error.message };
      }

      // Count by source
      const sourceCount = {};
      for (const record of data || []) {
        const source = record.article_source || 'unknown';
        sourceCount[source] = (sourceCount[source] || 0) + 1;
      }

      return {
        agentId,
        hoursAnalyzed: hours,
        totalArticlesUsed: count || 0,
        bySource: sourceCount
      };

    } catch (error) {
      logger.error(`Error in getAgentStats: ${error.message}`);
      return { error: error.message };
    }
  }

  /**
   * Cleanup old entries (called by maintenance job)
   * @param {number} hoursToKeep - Hours of data to retain
   * @returns {number} Number of records deleted
   */
  async cleanup(hoursToKeep = 48) {
    try {
      // Try using the RPC function first
      const { data, error } = await this.db.rpc('cleanup_old_article_usage', {
        hours_to_keep: hoursToKeep
      });

      if (error) {
        // Fallback to direct delete if RPC fails
        logger.warn(`RPC cleanup failed, using direct delete: ${error.message}`);
        return await this.cleanupDirect(hoursToKeep);
      }

      const count = data || 0;
      if (count > 0) {
        logger.info(`Cleaned up ${count} old article usage records`);
      }
      return count;

    } catch (error) {
      logger.error(`Cleanup error: ${error.message}`);
      return 0;
    }
  }

  /**
   * Direct cleanup without RPC (fallback)
   * @param {number} hoursToKeep - Hours of data to retain
   * @returns {number} Number of records deleted (estimated)
   */
  async cleanupDirect(hoursToKeep) {
    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - hoursToKeep);

    try {
      const { error } = await this.db
        .from('agent_article_usage')
        .delete()
        .lt('used_at', cutoff.toISOString());

      if (error) {
        logger.error(`Direct cleanup failed: ${error.message}`);
        return 0;
      }

      logger.info('Direct cleanup completed (count unavailable)');
      return -1; // Indicate success but count unknown

    } catch (error) {
      logger.error(`Direct cleanup error: ${error.message}`);
      return 0;
    }
  }

  /**
   * Update configuration at runtime
   * @param {Object} newConfig - Configuration overrides
   */
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    logger.info(`Configuration updated: ${JSON.stringify(this.config)}`);
  }
}

export default ArticleDeduplicationService;
