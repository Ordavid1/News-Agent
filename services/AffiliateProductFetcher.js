// services/AffiliateProductFetcher.js
// Fetches, scores, filters, and deduplicates AliExpress affiliate products.
// Analogous to TrendAnalyzer + NewsService for news content.

import AliExpressService from './AliExpressService.js';
import {
  getActiveAffiliateKeywords,
  getAgentPublishedProductIds,
  incrementAffiliateApiCalls,
  getAffiliateCredentials,
  updateAffiliateCredentials
} from './database-wrapper.js';
const PREFIX = '[AffiliateProductFetcher]';
const logger = {
  info: (...args) => console.log(PREFIX, ...args),
  warn: (...args) => console.warn(PREFIX, ...args),
  error: (...args) => console.error(PREFIX, ...args),
  debug: (...args) => { if (process.env.LOG_LEVEL === 'debug') console.log(PREFIX, ...args); }
};

// In-memory product cache: key = userId:keywordHash, value = { products, fetchedAt }
const productCache = new Map();
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_API_CALLS_PER_DAY = 5000;

class AffiliateProductFetcher {

  /**
   * Get the best product for an agent to publish
   * @param {object} agent - Agent record with user_id, platform, settings
   * @param {object} credentials - User's credential record { trackingId, ... }
   * @returns {object|null} Product with affiliate link or null if none available
   */
  static async getProductForAgent(agent, credentials) {
    const userId = agent.user_id;
    const agentId = agent.id;
    const platform = agent.platform;

    // 1. Get keyword sets (from agent settings or all active for user)
    const agentKeywordSetIds = agent.settings?.affiliateSettings?.keywordSetIds;
    let keywordSets = await getActiveAffiliateKeywords(userId);

    if (agentKeywordSetIds?.length) {
      keywordSets = keywordSets.filter(ks => agentKeywordSetIds.includes(ks.id));
    }

    if (!keywordSets.length) {
      logger.warn(`No active keyword sets for user ${userId}`);
      return null;
    }

    // 2. Check API rate limit
    const credsRecord = await getAffiliateCredentials(userId);
    if (credsRecord && credsRecord.api_calls_today >= MAX_API_CALLS_PER_DAY) {
      logger.warn(`User ${userId} has reached daily API call limit (${MAX_API_CALLS_PER_DAY})`);
      return null;
    }

    // 3. Get previously published product IDs for dedup
    const publishedIds = await getAgentPublishedProductIds(agentId);
    const publishedIdSet = new Set(publishedIds);

    // 4. Fetch products for each keyword set (with caching)
    const service = new AliExpressService(credentials.trackingId, credentials.sessionToken || null);
    let allProducts = [];

    for (const keywordSet of keywordSets) {
      const products = await this._fetchForKeywordSet(service, userId, keywordSet);
      allProducts.push(...products);
    }

    // 5. Filter out already published products
    allProducts = allProducts.filter(p => !publishedIdSet.has(p.productId));

    if (!allProducts.length) {
      logger.info(`No new products available for agent ${agentId} after dedup`);
      return null;
    }

    // 6. Deduplicate by productId (same product from different keyword sets)
    const uniqueProducts = this._deduplicateProducts(allProducts);

    // 7. Score and rank products
    const scoredProducts = this._scoreProducts(uniqueProducts, keywordSets[0]);

    // 8. Select the best product
    const bestProduct = scoredProducts[0];

    if (!bestProduct) return null;

    // 9. Generate affiliate link for the selected product
    const linkResult = await service.generateAffiliateLinks([bestProduct.productUrl]);
    await incrementAffiliateApiCalls(userId);

    if (linkResult.success && linkResult.links.length > 0) {
      bestProduct.affiliateUrl = linkResult.links[0].affiliateUrl;
    } else {
      logger.warn(`Failed to generate affiliate link for product ${bestProduct.productId}`);
      // Use the product URL as fallback (no commission tracking)
      bestProduct.affiliateUrl = bestProduct.productUrl;
    }

    logger.info(`Selected product "${bestProduct.title}" (${bestProduct.productId}) for agent ${agentId}, commission: ${bestProduct.commissionRate}%`);

    return bestProduct;
  }

  /**
   * Fetch products for a keyword set (with caching)
   * @param {AliExpressService} service
   * @param {string} userId
   * @param {object} keywordSet - Keyword set record from DB
   * @returns {array} Normalized products
   */
  static async _fetchForKeywordSet(service, userId, keywordSet) {
    const keywords = keywordSet.keywords.join(' ');
    const cacheKey = `${userId}:${keywords}:${keywordSet.sort_by || 'default'}`;

    // Check cache
    const cached = productCache.get(cacheKey);
    if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
      logger.debug(`Cache hit for "${keywords}" (${cached.products.length} products)`);
      return cached.products;
    }

    // Build search options from keyword set filters
    const options = {
      pageSize: 40, // Fetch a batch to have selection options
      targetCurrency: keywordSet.target_currency || 'USD'
    };

    // Map sort_by to AE sort parameter
    const sortMapping = {
      commission_rate: undefined, // No direct AE sort, handled in scoring
      volume: 'LAST_VOLUME_DESC',
      price_asc: 'SALE_PRICE_ASC',
      price_desc: 'SALE_PRICE_DESC',
      rating: undefined // No direct AE sort, handled in scoring
    };

    if (sortMapping[keywordSet.sort_by]) {
      options.sortBy = sortMapping[keywordSet.sort_by];
    }

    if (keywordSet.min_price) options.minPrice = keywordSet.min_price;
    if (keywordSet.max_price) options.maxPrice = keywordSet.max_price;

    // Make API call
    const result = await service.searchProducts(keywords, options);
    await incrementAffiliateApiCalls(userId);

    if (!result.success) {
      logger.error(`Product search failed for "${keywords}": ${result.error}`);
      return [];
    }

    let products = result.products;

    // Apply local filters that AE API doesn't support natively
    if (keywordSet.min_commission_rate) {
      products = products.filter(p => p.commissionRate >= keywordSet.min_commission_rate);
    }
    if (keywordSet.min_rating) {
      products = products.filter(p => p.rating >= keywordSet.min_rating);
    }
    if (keywordSet.min_orders) {
      products = products.filter(p => p.totalOrders >= keywordSet.min_orders);
    }

    // Cache the results
    productCache.set(cacheKey, {
      products,
      fetchedAt: Date.now()
    });

    logger.debug(`Fetched ${products.length} products for "${keywords}" (after filters)`);
    return products;
  }

  /**
   * Search products for manual preview (not cached, not deduped)
   * @param {object} credentials - User credential record { trackingId }
   * @param {string} keywords - Search keywords
   * @param {object} options - Search options
   * @returns {object} { success, products, totalResults }
   */
  static async searchProducts(credentials, keywords, options = {}) {
    const service = new AliExpressService(credentials.trackingId, credentials.sessionToken || null);
    return await service.searchProducts(keywords, options);
  }

  /**
   * Get hot/trending products for manual preview
   * @param {object} credentials - User credential record { trackingId }
   * @param {object} options - Search options
   * @returns {object} { success, products }
   */
  static async getHotProducts(credentials, options = {}) {
    const service = new AliExpressService(credentials.trackingId, credentials.sessionToken || null);
    return await service.getHotProducts(options);
  }

  /**
   * Generate affiliate link for a specific product URL
   * @param {object} credentials - User credential record { trackingId }
   * @param {string} productUrl - Product URL to convert
   * @returns {object} { success, affiliateUrl }
   */
  static async generateLink(credentials, productUrl) {
    const service = new AliExpressService(credentials.trackingId, credentials.sessionToken || null);
    const result = await service.generateAffiliateLinks([productUrl]);

    if (result.success && result.links.length > 0) {
      return { success: true, affiliateUrl: result.links[0].affiliateUrl };
    }
    return { success: false, error: result.error || 'No link generated' };
  }

  // ============================================
  // SCORING & DEDUP
  // ============================================

  /**
   * Score products for ranking (higher = better)
   * Composite score: commission rate * discount * rating * log(orders + 1)
   */
  static _scoreProducts(products, keywordSet) {
    const scored = products.map(product => {
      const commissionScore = product.commissionRate || 1;
      const discountScore = Math.max(product.discount || 1, 1);
      const ratingScore = Math.max(product.rating || 3, 1);
      const volumeScore = Math.log10(Math.max(product.totalOrders || 1, 1) + 1);
      const priceScore = product.salePrice > 0 ? 1 : 0.5;

      product._score = commissionScore * discountScore * ratingScore * volumeScore * priceScore;
      return product;
    });

    // Sort by score descending
    scored.sort((a, b) => b._score - a._score);

    // Add some randomization among top results to avoid always posting the same product
    if (scored.length > 3) {
      const topN = scored.slice(0, Math.min(5, scored.length));
      const randomIndex = Math.floor(Math.random() * topN.length);
      const selected = topN[randomIndex];
      scored.splice(scored.indexOf(selected), 1);
      scored.unshift(selected);
    }

    return scored;
  }

  /**
   * Deduplicate products by productId (keep highest scored duplicate)
   */
  static _deduplicateProducts(products) {
    const seen = new Map();
    for (const product of products) {
      if (!seen.has(product.productId)) {
        seen.set(product.productId, product);
      }
    }
    return Array.from(seen.values());
  }

  /**
   * Clear expired cache entries
   */
  static cleanupCache() {
    const now = Date.now();
    for (const [key, value] of productCache.entries()) {
      if ((now - value.fetchedAt) >= CACHE_TTL_MS) {
        productCache.delete(key);
      }
    }
  }
}

export default AffiliateProductFetcher;
