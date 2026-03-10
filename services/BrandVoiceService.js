/**
 * Brand Voice Service
 *
 * Core orchestration service for Brand Voice Learning & Original Content Generation.
 * Handles the full pipeline:
 *   1. Post collection from internal DB + platform APIs (Facebook, Instagram)
 *   2. Brand voice analysis via LLM (style, tone, vocabulary, themes)
 *   3. Original content generation using learned voice profiles
 *
 * Uses the same OpenAI infrastructure as ContentGenerator.
 * Gated by the Marketing add-on subscription.
 */

import OpenAI from 'openai';
import winston from 'winston';
import marketingService from './MarketingService.js';
import {
  createBrandVoiceProfile,
  updateBrandVoiceProfile,
  getBrandVoiceProfileById,
  insertBrandVoicePosts,
  getBrandVoicePosts,
  deleteBrandVoicePosts,
  getAllPublishedPosts
} from './database-wrapper.js';
import {
  getBrandVoiceAnalysisSystemPrompt,
  getBrandVoiceAnalysisUserPrompt,
  getBrandVoiceMergeSystemPrompt,
  getBrandVoiceMergeUserPrompt,
  getBrandVoiceGenerationSystemPrompt,
  getBrandVoiceGenerationUserPrompt,
  getBrandVoiceValidationSystemPrompt,
  getBrandVoiceValidationUserPrompt
} from '../public/components/brandVoicePrompts.mjs';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[BrandVoiceService] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

// Chunk size for analysis — large post sets are split to fit LLM context
const ANALYSIS_CHUNK_SIZE = 30;

// Minimum posts needed for meaningful analysis
const MIN_POSTS_FOR_ANALYSIS = 3;

// Minimum validation score to pass (0-100)
const VALIDATION_THRESHOLD = 70;

// Maximum validation retries before accepting best result
const MAX_VALIDATION_RETRIES = 2;

class BrandVoiceService {
  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey && apiKey !== 'sk-test-key') {
      this.openai = new OpenAI({ apiKey });
    } else {
      logger.warn('OpenAI API key not configured — brand voice features will be unavailable');
      this.openai = null;
    }
    logger.info('BrandVoiceService initialized');
  }

  // ============================================
  // POST COLLECTION
  // ============================================

  /**
   * Collect posts from available sources for brand voice analysis.
   * Sources:
   *   - Internal: published_posts table (posts published through our app)
   *   - External: Facebook page posts via MarketingService.fetchPagePosts()
   *   - External: Instagram posts via MarketingService.fetchInstagramPosts()
   *
   * @param {string} userId - User ID
   * @param {string} profileId - Brand voice profile ID
   * @param {number} days - How many days of history to collect (default 180)
   * @param {Array|null} platforms - Specific platforms to collect from, or null for all
   * @returns {Object} Collection stats
   */
  async collectPosts(userId, profileId, days = 90, platforms = null) {
    logger.info(`Starting post collection for user ${userId}, profile ${profileId}, last ${days} days, platforms=${platforms ? platforms.join(', ') : 'all'}`);

    await updateBrandVoiceProfile(profileId, userId, { status: 'collecting' });

    const collectedPosts = [];
    const platformCounts = {};

    try {
      // Source 1: Internal published_posts (filtered by platform if specified)
      const internalPosts = await getAllPublishedPosts(userId, { days, limit: 500 });
      logger.info(`Found ${internalPosts.length} internal published posts`);

      for (const post of internalPosts) {
        if (!post.content || post.content.trim().length === 0) continue;
        if (platforms && !platforms.includes(post.platform)) continue;

        collectedPosts.push({
          user_id: userId,
          profile_id: profileId,
          platform: post.platform,
          source: 'internal',
          external_post_id: post.platform_post_id || `internal_${post.id}`,
          content: post.content,
          media_type: post.image_url ? 'image' : 'text',
          engagement: post.engagement || {},
          posted_at: post.published_at
        });

        platformCounts[post.platform] = (platformCounts[post.platform] || 0) + 1;
      }

      // Source 2: Facebook page posts (external — includes posts not made through our app)
      if (!platforms || platforms.includes('facebook')) {
        try {
          const fbPosts = await marketingService.fetchPagePosts(userId, days);
          logger.info(`Found ${fbPosts.length} Facebook page posts`);

          for (const post of fbPosts) {
            if (!post.content || post.content.trim().length === 0) continue;

            collectedPosts.push({
              user_id: userId,
              profile_id: profileId,
              platform: 'facebook',
              source: 'api',
              external_post_id: post.platform_post_id,
              content: post.content,
              media_type: post.full_picture ? 'image' : 'text',
              engagement: post.engagement || {},
              posted_at: post.published_at
            });

            platformCounts.facebook = (platformCounts.facebook || 0) + 1;
          }
        } catch (err) {
          logger.warn(`Could not fetch Facebook page posts: ${err.message}`);
        }
      } else {
        logger.info('Skipping Facebook collection (not in selected platforms)');
      }

      // Source 3: Instagram posts (external)
      if (!platforms || platforms.includes('instagram')) {
        try {
          const igPosts = await marketingService.fetchInstagramPosts(userId, days);
          logger.info(`Found ${igPosts.length} Instagram posts`);

          for (const post of igPosts) {
            if (!post.content || post.content.trim().length === 0) continue;

            collectedPosts.push({
              user_id: userId,
              profile_id: profileId,
              platform: 'instagram',
              source: 'api',
              external_post_id: post.platform_post_id,
              content: post.content,
              media_type: post.media_type || 'image',
              engagement: post.engagement || {},
              posted_at: post.published_at
            });

            platformCounts.instagram = (platformCounts.instagram || 0) + 1;
          }
        } catch (err) {
          logger.warn(`Could not fetch Instagram posts: ${err.message}`);
        }
      } else {
        logger.info('Skipping Instagram collection (not in selected platforms)');
      }

      // Source 4: Twitter posts (external)
      if (!platforms || platforms.includes('twitter')) {
        try {
          const twitterPosts = await marketingService.fetchTwitterPosts(userId, days);
          logger.info(`Found ${twitterPosts.length} Twitter posts`);

          for (const post of twitterPosts) {
            if (!post.content || post.content.trim().length === 0) continue;

            collectedPosts.push({
              user_id: userId,
              profile_id: profileId,
              platform: 'twitter',
              source: 'api',
              external_post_id: post.platform_post_id,
              content: post.content,
              media_type: 'text',
              engagement: post.engagement || {},
              posted_at: post.published_at
            });

            platformCounts.twitter = (platformCounts.twitter || 0) + 1;
          }
        } catch (err) {
          logger.warn(`Could not fetch Twitter posts: ${err.message}`);
        }
      } else {
        logger.info('Skipping Twitter collection (not in selected platforms)');
      }

      // Source 5: Reddit posts (external)
      if (!platforms || platforms.includes('reddit')) {
        try {
          const redditPosts = await marketingService.fetchRedditPosts(userId, days);
          logger.info(`Found ${redditPosts.length} Reddit posts`);

          for (const post of redditPosts) {
            if (!post.content || post.content.trim().length === 0) continue;

            collectedPosts.push({
              user_id: userId,
              profile_id: profileId,
              platform: 'reddit',
              source: 'api',
              external_post_id: post.platform_post_id,
              content: post.content,
              media_type: 'text',
              engagement: post.engagement || {},
              posted_at: post.published_at
            });

            platformCounts.reddit = (platformCounts.reddit || 0) + 1;
          }
        } catch (err) {
          logger.warn(`Could not fetch Reddit posts: ${err.message}`);
        }
      } else {
        logger.info('Skipping Reddit collection (not in selected platforms)');
      }

      // Source 6: Threads posts (external)
      if (!platforms || platforms.includes('threads')) {
        try {
          const threadsPosts = await marketingService.fetchThreadsPosts(userId, days);
          logger.info(`Found ${threadsPosts.length} Threads posts`);

          for (const post of threadsPosts) {
            if (!post.content || post.content.trim().length === 0) continue;

            collectedPosts.push({
              user_id: userId,
              profile_id: profileId,
              platform: 'threads',
              source: 'api',
              external_post_id: post.platform_post_id,
              content: post.content,
              media_type: 'text',
              engagement: post.engagement || {},
              posted_at: post.published_at
            });

            platformCounts.threads = (platformCounts.threads || 0) + 1;
          }
        } catch (err) {
          logger.warn(`Could not fetch Threads posts: ${err.message}`);
        }
      } else {
        logger.info('Skipping Threads collection (not in selected platforms)');
      }

      // Deduplicate by (platform, external_post_id) — internal and API posts may overlap
      const seen = new Set();
      const deduped = collectedPosts.filter(post => {
        const key = `${post.platform}:${post.external_post_id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const duplicatesRemoved = collectedPosts.length - deduped.length;
      if (duplicatesRemoved > 0) {
        logger.info(`Deduplication: removed ${duplicatesRemoved} duplicate posts (${collectedPosts.length} → ${deduped.length})`);
      }

      // Clear any previously collected posts and insert fresh
      logger.info(`Clearing old posts and inserting ${deduped.length} fresh posts for profile ${profileId}`);
      await deleteBrandVoicePosts(profileId, userId);

      if (deduped.length > 0) {
        await insertBrandVoicePosts(deduped);
        logger.info(`Inserted ${deduped.length} posts into brand_voice_posts`);
      }

      const detectedPlatforms = [...new Set(deduped.map(p => p.platform))];

      await updateBrandVoiceProfile(profileId, userId, {
        platforms_analyzed: detectedPlatforms,
        posts_analyzed_count: deduped.length
      });

      const stats = {
        totalPosts: deduped.length,
        platforms: detectedPlatforms,
        platformCounts,
        sources: {
          internal: deduped.filter(p => p.source === 'internal').length,
          api: deduped.filter(p => p.source === 'api').length
        }
      };

      logger.info(`Post collection complete: ${JSON.stringify(stats)}`);
      return stats;

    } catch (error) {
      logger.error(`Post collection failed: ${error.message}`);
      await updateBrandVoiceProfile(profileId, userId, {
        status: 'failed',
        error_message: `Collection failed: ${error.message}`
      });
      throw error;
    }
  }

  // ============================================
  // BRAND VOICE ANALYSIS
  // ============================================

  /**
   * Analyze collected posts and generate a brand voice profile.
   * Posts are sorted by engagement so the LLM prioritizes top-performing content.
   * After analysis, a validation step generates a test post and scores it against
   * the originals. If validation fails, the analysis is retried up to MAX_VALIDATION_RETRIES times.
   *
   * @param {string} userId - User ID
   * @param {string} profileId - Brand voice profile ID
   * @returns {Object} The generated profile_data (with validation metadata)
   */
  async analyzeVoice(userId, profileId) {
    if (!this.openai) {
      throw new Error('OpenAI not configured — brand voice analysis unavailable');
    }

    const posts = await getBrandVoicePosts(profileId, userId);
    logger.info(`Loaded ${posts.length} collected posts for analysis (profile ${profileId})`);

    if (posts.length < MIN_POSTS_FOR_ANALYSIS) {
      await updateBrandVoiceProfile(profileId, userId, {
        status: 'failed',
        error_message: `Not enough posts for analysis (found ${posts.length}, need at least ${MIN_POSTS_FOR_ANALYSIS})`
      });
      throw new Error(`Need at least ${MIN_POSTS_FOR_ANALYSIS} posts for brand voice analysis, found ${posts.length}`);
    }

    await updateBrandVoiceProfile(profileId, userId, { status: 'analyzing' });

    try {
      // Sort posts by engagement (highest first) so the LLM focuses on best-performing content
      const sortedPosts = this._sortByEngagement(posts);

      // Group sorted posts by platform
      const grouped = {};
      for (const post of sortedPosts) {
        if (!grouped[post.platform]) grouped[post.platform] = [];
        grouped[post.platform].push(post);
      }

      const platformBreakdown = Object.entries(grouped).map(([p, arr]) => `${p}:${arr.length}`).join(', ');
      logger.info(`Posts grouped by platform: ${platformBreakdown}`);

      const stats = {
        totalPosts: sortedPosts.length,
        platformCount: Object.keys(grouped).length
      };

      // Analyze with retry loop for validation
      let profileData;
      let validationResult;
      let bestResult = null;
      let bestScore = 0;

      logger.info(`Starting analysis with validation (max ${MAX_VALIDATION_RETRIES + 1} attempts, threshold: ${VALIDATION_THRESHOLD})`);

      for (let attempt = 0; attempt <= MAX_VALIDATION_RETRIES; attempt++) {
        if (attempt > 0) {
          logger.info(`Validation retry ${attempt}/${MAX_VALIDATION_RETRIES} for profile ${profileId}`);
        }

        // Run analysis
        logger.info(`Attempt ${attempt + 1}: starting LLM analysis (${sortedPosts.length} posts, chunk size: ${ANALYSIS_CHUNK_SIZE})`);
        if (sortedPosts.length <= ANALYSIS_CHUNK_SIZE) {
          profileData = await this._analyzeChunk(grouped, stats);
        } else {
          profileData = await this._analyzeWithChunking(sortedPosts, grouped, stats);
        }
        logger.info(`Attempt ${attempt + 1}: analysis complete, starting validation`);

        // Validate: generate a test post, then score it against originals
        validationResult = await this._validateProfile(profileData, sortedPosts);

        // Track the best result across attempts
        if (validationResult.overall_score > bestScore) {
          bestScore = validationResult.overall_score;
          bestResult = { profileData, validationResult };
        }

        if (validationResult.verdict === 'pass') {
          logger.info(`Validation passed on attempt ${attempt + 1} with score ${validationResult.overall_score}`);
          break;
        }

        logger.warn(`Validation failed on attempt ${attempt + 1}: score ${validationResult.overall_score} < ${VALIDATION_THRESHOLD}`);
      }

      // Use the best result even if all attempts failed validation
      const finalProfile = bestResult.profileData;
      const finalValidation = bestResult.validationResult;

      // Attach validation metadata to the profile
      finalProfile._validation = {
        score: finalValidation.overall_score,
        scores: finalValidation.scores,
        strengths: finalValidation.strengths,
        weaknesses: finalValidation.weaknesses,
        passed: finalValidation.verdict === 'pass'
      };

      // Save the analyzed profile
      await updateBrandVoiceProfile(profileId, userId, {
        status: 'ready',
        profile_data: finalProfile,
        last_analyzed_at: new Date().toISOString(),
        error_message: finalValidation.verdict === 'pass'
          ? null
          : `Profile ready but validation score is ${finalValidation.overall_score}/100 (threshold: ${VALIDATION_THRESHOLD}). Consider refreshing with more posts.`
      });

      logger.info(`Brand voice analysis complete for profile ${profileId}, validation score: ${finalValidation.overall_score}`);
      return finalProfile;

    } catch (error) {
      logger.error(`Brand voice analysis failed: ${error.message}`);
      await updateBrandVoiceProfile(profileId, userId, {
        status: 'failed',
        error_message: `Analysis failed: ${error.message}`
      });
      throw error;
    }
  }

  /**
   * Sort posts by engagement score (descending).
   * Higher-engagement posts appear first, so the LLM emphasizes them.
   * @private
   */
  _sortByEngagement(posts) {
    logger.info(`Sorting ${posts.length} posts by engagement score`);
    const sorted = [...posts].sort((a, b) => {
      return this._engagementScore(b) - this._engagementScore(a);
    });
    const topScore = sorted.length > 0 ? this._engagementScore(sorted[0]) : 0;
    const bottomScore = sorted.length > 0 ? this._engagementScore(sorted[sorted.length - 1]) : 0;
    logger.info(`Engagement sort complete: top=${topScore}, bottom=${bottomScore}, range=${topScore - bottomScore}`);
    return sorted;
  }

  /**
   * Calculate a unified engagement score for a post.
   * Comments weighted 2x, shares weighted 3x (stronger signals of resonance).
   * @private
   */
  _engagementScore(post) {
    const eng = post.engagement || {};
    return (eng.likes || eng.reactions || eng.like_count || 0)
      + (eng.comments || eng.comments_count || 0) * 2
      + (eng.shares || eng.retweets || eng.share_count || 0) * 3;
  }

  /**
   * Validate a brand voice profile by generating a test post and scoring it
   * against the original posts.
   * @private
   * @param {Object} profileData - The analyzed brand voice profile
   * @param {Array} originalPosts - The original collected posts
   * @returns {Object} Validation result with scores and verdict
   */
  async _validateProfile(profileData, originalPosts) {
    logger.info(`Starting profile validation with ${originalPosts.length} original posts`);

    // Pick a representative platform from the originals
    const platformCounts = {};
    for (const p of originalPosts) {
      platformCounts[p.platform] = (platformCounts[p.platform] || 0) + 1;
    }
    const dominantPlatform = Object.entries(platformCounts)
      .sort((a, b) => b[1] - a[1])[0][0];

    logger.info(`Validation platform distribution: ${JSON.stringify(platformCounts)}, using dominant: ${dominantPlatform}`);

    // Generate a test post
    const genSystemPrompt = getBrandVoiceGenerationSystemPrompt(profileData, dominantPlatform);
    const genUserPrompt = getBrandVoiceGenerationUserPrompt({
      samplePosts: this._selectBestSamples(originalPosts, 5),
      profileData
    });

    logger.info(`LLM call: generating test post for validation on ${dominantPlatform} (system=${genSystemPrompt.length} chars, user=${genUserPrompt.length} chars)`);
    const genStartTime = Date.now();

    const genCompletion = await this.openai.chat.completions.create({
      model: 'gpt-5-nano',
      messages: [
        { role: 'system', content: genSystemPrompt },
        { role: 'user', content: genUserPrompt }
      ]
    });

    const testPost = genCompletion.choices[0].message.content;
    const genElapsed = Date.now() - genStartTime;
    logger.info(`LLM call: test post generated in ${genElapsed}ms (${testPost.length} chars, tokens=${genCompletion.usage?.total_tokens || 'N/A'})`);

    // Score the test post against originals
    const valSamples = this._selectBestSamples(originalPosts, 8);
    const valSystemPrompt = getBrandVoiceValidationSystemPrompt();
    const valUserPrompt = getBrandVoiceValidationUserPrompt(
      profileData,
      valSamples,
      testPost
    );

    logger.info(`LLM call: scoring test post against ${valSamples.length} originals (system=${valSystemPrompt.length} chars, user=${valUserPrompt.length} chars)`);
    const valStartTime = Date.now();

    const valCompletion = await this.openai.chat.completions.create({
      model: 'gpt-5-nano',
      messages: [
        { role: 'system', content: valSystemPrompt },
        { role: 'user', content: valUserPrompt }
      ]
    });

    const valElapsed = Date.now() - valStartTime;
    const validationContent = valCompletion.choices[0].message.content;
    logger.info(`LLM call: validation scoring complete in ${valElapsed}ms (${validationContent.length} chars, tokens=${valCompletion.usage?.total_tokens || 'N/A'})`);

    const validation = this._parseJsonResponse(validationContent);

    logger.info(`Validation score for ${dominantPlatform}: ${validation.overall_score} (${validation.verdict}) — tone=${validation.scores?.tone_match}, vocab=${validation.scores?.vocabulary_match}, format=${validation.scores?.formatting_match}, theme=${validation.scores?.theme_relevance}, auth=${validation.scores?.authenticity}`);
    return validation;
  }

  /**
   * Analyze a single chunk of posts.
   * @private
   */
  async _analyzeChunk(groupedPosts, stats) {
    const platforms = Object.keys(groupedPosts).join(', ');
    logger.info(`LLM call: analyzing chunk — ${stats.totalPosts} posts across [${platforms}]`);

    const systemPrompt = getBrandVoiceAnalysisSystemPrompt();
    const userPrompt = getBrandVoiceAnalysisUserPrompt(groupedPosts, stats);

    logger.info(`LLM call: analysis chunk — system=${systemPrompt.length} chars, user=${userPrompt.length} chars`);
    const startTime = Date.now();

    const completion = await this.openai.chat.completions.create({
      model: 'gpt-5-nano',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    });

    const elapsed = Date.now() - startTime;
    const content = completion.choices[0].message.content;
    logger.info(`LLM call: analysis chunk complete in ${elapsed}ms (${content.length} chars, tokens=${completion.usage?.total_tokens || 'N/A'})`);

    return this._parseJsonResponse(content);
  }

  /**
   * Analyze a large set of posts by chunking and merging.
   * @private
   */
  async _analyzeWithChunking(allPosts, groupedByPlatform, stats) {
    // Create chunks
    const chunks = [];
    for (let i = 0; i < allPosts.length; i += ANALYSIS_CHUNK_SIZE) {
      chunks.push(allPosts.slice(i, i + ANALYSIS_CHUNK_SIZE));
    }

    logger.info(`Chunked analysis: ${allPosts.length} posts split into ${chunks.length} chunks of ~${ANALYSIS_CHUNK_SIZE}`);

    // Analyze each chunk
    const partialResults = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      logger.info(`Processing chunk ${i + 1}/${chunks.length} (${chunk.length} posts)`);

      const chunkGrouped = {};
      for (const post of chunk) {
        if (!chunkGrouped[post.platform]) chunkGrouped[post.platform] = [];
        chunkGrouped[post.platform].push(post);
      }

      const chunkStats = {
        totalPosts: chunk.length,
        platformCount: Object.keys(chunkGrouped).length
      };

      const result = await this._analyzeChunk(chunkGrouped, chunkStats);
      partialResults.push(result);
      logger.info(`Chunk ${i + 1}/${chunks.length} analysis complete`);
    }

    // If only one chunk, no merging needed
    if (partialResults.length === 1) {
      return partialResults[0];
    }

    // Merge partial results
    logger.info(`Merging ${partialResults.length} chunk results via LLM`);
    const mergeSystemPrompt = getBrandVoiceMergeSystemPrompt();
    const mergeUserPrompt = getBrandVoiceMergeUserPrompt(partialResults);

    logger.info(`LLM call: merge — system=${mergeSystemPrompt.length} chars, user=${mergeUserPrompt.length} chars`);
    const mergeStartTime = Date.now();

    const mergeCompletion = await this.openai.chat.completions.create({
      model: 'gpt-5-nano',
      messages: [
        { role: 'system', content: mergeSystemPrompt },
        { role: 'user', content: mergeUserPrompt }
      ]
    });

    const mergeElapsed = Date.now() - mergeStartTime;
    const mergedContent = mergeCompletion.choices[0].message.content;
    logger.info(`LLM call: merge complete in ${mergeElapsed}ms (${mergedContent.length} chars, tokens=${mergeCompletion.usage?.total_tokens || 'N/A'})`);

    return this._parseJsonResponse(mergedContent);
  }

  // ============================================
  // FULL PIPELINE: COLLECT + ANALYZE
  // ============================================

  /**
   * Run the full brand voice learning pipeline: collect posts then analyze.
   *
   * @param {string} userId - User ID
   * @param {string} profileId - Brand voice profile ID
   * @param {number} days - Days of history to collect
   * @param {Array|null} platforms - Specific platforms to collect from, or null for all
   * @returns {Object} { stats, profileData }
   */
  async buildProfile(userId, profileId, days = 90, platforms = null) {
    logger.info(`Building profile ${profileId}: days=${days}, platforms=${platforms ? platforms.join(', ') : 'all'}`);
    const stats = await this.collectPosts(userId, profileId, days, platforms);
    const profileData = await this.analyzeVoice(userId, profileId);
    logger.info(`Profile ${profileId} build complete: ${stats.totalPosts} posts analyzed`);
    return { stats, profileData };
  }

  /**
   * Refresh an existing profile: re-collect and re-analyze.
   * Reads selected_platforms from the profile record to maintain platform preferences.
   *
   * @param {string} userId - User ID
   * @param {string} profileId - Brand voice profile ID
   * @param {number} days - Days of history to collect
   * @returns {Object} { stats, profileData }
   */
  async refreshProfile(userId, profileId, days = 90) {
    const profile = await getBrandVoiceProfileById(profileId, userId);
    const platforms = profile?.selected_platforms || null;
    logger.info(`Refreshing profile ${profileId}: days=${days}, platforms=${platforms ? platforms.join(', ') : 'all (inherited)'}`);
    return this.buildProfile(userId, profileId, days, platforms);
  }

  // ============================================
  // ORIGINAL CONTENT GENERATION
  // ============================================

  /**
   * Generate original post(s) matching a brand voice profile.
   *
   * @param {string} userId - User ID
   * @param {string} profileId - Brand voice profile ID
   * @param {Object} options
   * @param {string|null} options.platform - Target platform, or null for auto-detect
   * @param {string} [options.topic] - Optional topic/direction
   * @param {number} [options.count=1] - Number of variations to generate
   * @returns {Array} Generated post objects
   */
  async generateOriginalPost(userId, profileId, { platform, topic, count = 1 }) {
    if (!this.openai) {
      throw new Error('OpenAI not configured — content generation unavailable');
    }

    const profile = await getBrandVoiceProfileById(profileId, userId);

    if (!profile) {
      throw new Error('Brand voice profile not found');
    }

    if (profile.status !== 'ready') {
      throw new Error(`Brand voice profile is not ready (status: ${profile.status}). Please complete the analysis first.`);
    }

    const profileData = profile.profile_data;

    // Auto-detect platform if not specified
    let effectivePlatform = platform;
    if (!effectivePlatform) {
      const posts = await getBrandVoicePosts(profileId, userId, { limit: 500 });
      const platformCounts = {};
      for (const p of posts) {
        platformCounts[p.platform] = (platformCounts[p.platform] || 0) + 1;
      }
      effectivePlatform = Object.entries(platformCounts)
        .sort((a, b) => b[1] - a[1])[0]?.[0] || 'linkedin';
      logger.info(`No platform specified, auto-detected dominant platform: ${effectivePlatform} (from ${JSON.stringify(platformCounts)})`);
    }

    // Get sample posts for few-shot context — prefer the target platform, fall back to others
    let samplePosts = await getBrandVoicePosts(profileId, userId, { limit: 10, platform: effectivePlatform });

    if (samplePosts.length < 3) {
      // Not enough platform-specific posts — get from all platforms
      samplePosts = await getBrandVoicePosts(profileId, userId, { limit: 10 });
    }

    // Pick the best 3-5 samples (prefer those with engagement)
    const samples = this._selectBestSamples(samplePosts, 5);

    const systemPrompt = getBrandVoiceGenerationSystemPrompt(profileData, effectivePlatform);
    const userPrompt = getBrandVoiceGenerationUserPrompt({
      topic,
      samplePosts: samples,
      profileData
    });

    logger.info(`Generating ${count} post(s) for profile "${profile.name}" on ${effectivePlatform}${platform ? '' : ' (auto-detected)'}, topic=${topic || 'auto'}`);

    const results = [];

    for (let i = 0; i < count; i++) {
      logger.info(`Generating variation ${i + 1}/${count} (system=${systemPrompt.length} chars, user=${userPrompt.length} chars)`);
      const genStartTime = Date.now();

      const completion = await this.openai.chat.completions.create({
        model: 'gpt-5-nano',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      });

      const generatedText = completion.choices[0].message.content;
      const genElapsed = Date.now() - genStartTime;
      logger.info(`Variation ${i + 1}/${count} generated in ${genElapsed}ms (${generatedText.length} chars, tokens=${completion.usage?.total_tokens || 'N/A'})`);

      results.push({
        text: generatedText,
        platform: effectivePlatform,
        requestedPlatform: platform || null,
        topic: topic || null,
        profileId,
        profileName: profile.name,
        generatedAt: new Date().toISOString()
      });
    }

    logger.info(`Generated ${results.length} original post(s) for profile "${profile.name}" on ${effectivePlatform}`);
    return results;
  }

  /**
   * Parse a JSON response from the LLM, handling potential markdown code fences.
   * Since gpt-5-nano does not support response_format, the LLM may return JSON
   * wrapped in ```json ... ``` blocks or with leading/trailing text.
   * @private
   * @param {string} content - Raw LLM response
   * @returns {Object} Parsed JSON object
   */
  _parseJsonResponse(content) {
    let cleaned = content.trim();

    // Strip markdown code fences if present (```json ... ``` or ``` ... ```)
    const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) {
      cleaned = fenceMatch[1].trim();
    }

    // If still not starting with { or [, try to find the first JSON object
    if (!cleaned.startsWith('{') && !cleaned.startsWith('[')) {
      const jsonStart = cleaned.indexOf('{');
      if (jsonStart !== -1) {
        cleaned = cleaned.substring(jsonStart);
      }
    }

    try {
      const parsed = JSON.parse(cleaned);
      const keyCount = typeof parsed === 'object' && parsed !== null
        ? (Array.isArray(parsed) ? parsed.length + ' items' : Object.keys(parsed).length + ' keys')
        : 'primitive';
      logger.info(`JSON parse success: ${keyCount}`);
      return parsed;
    } catch (parseError) {
      logger.error(`Failed to parse JSON response: ${parseError.message}`);
      logger.error(`Raw content (first 500 chars): ${content.substring(0, 500)}`);
      throw new Error(`LLM returned invalid JSON: ${parseError.message}`);
    }
  }

  /**
   * Select the best sample posts for few-shot context.
   * Prefers posts with higher engagement.
   * @private
   */
  _selectBestSamples(posts, count) {
    if (posts.length <= count) {
      logger.info(`Sample selection: returning all ${posts.length} posts (requested ${count})`);
      return posts;
    }

    // Score posts by engagement
    const scored = posts.map(post => {
      const eng = post.engagement || {};
      const score = (eng.likes || eng.reactions || 0)
        + (eng.comments || 0) * 2
        + (eng.shares || eng.retweets || 0) * 3;
      return { ...post, _score: score };
    });

    scored.sort((a, b) => b._score - a._score);
    const selected = scored.slice(0, count);
    logger.info(`Sample selection: picked ${selected.length}/${posts.length} posts, top engagement=${selected[0]?._score || 0}`);
    return selected;
  }
}

// Export singleton
const brandVoiceService = new BrandVoiceService();
export default brandVoiceService;
