// services/AliExpressService.js
// AliExpress Affiliate API wrapper using the TOP protocol (Taobao Open Platform).
// Custom implementation — no npm SDK dependency.
// Handles request signing, product search, affiliate link generation, and response normalization.

import crypto from 'crypto';
const PREFIX = '[AliExpressService]';
const logger = {
  info: (...args) => console.log(PREFIX, ...args),
  warn: (...args) => console.warn(PREFIX, ...args),
  error: (...args) => console.error(PREFIX, ...args),
  debug: (...args) => { if (process.env.LOG_LEVEL === 'debug') console.log(PREFIX, ...args); }
};

// AliExpress API gateway (new Open Platform)
const API_BASE_URL = 'https://api-sg.aliexpress.com/sync';
const API_VERSION = '2.0';
const SIGN_METHOD = 'sha256';

class AliExpressService {
  /**
   * @param {string} trackingId - User's affiliate tracking ID (for commission sub-tracking)
   * @param {string|null} sessionToken - OAuth access_token for per-user commission attribution
   * App Key and App Secret are developer credentials read from env vars.
   */
  constructor(trackingId = null, sessionToken = null) {
    const appKey = process.env.ALIEXPRESS_APP_KEY;
    const appSecret = process.env.ALIEXPRESS_APP_SECRET;

    if (!appKey || !appSecret) {
      throw new Error('AliExpressService requires ALIEXPRESS_APP_KEY and ALIEXPRESS_APP_SECRET env vars');
    }
    this.appKey = appKey;
    this.appSecret = appSecret;
    this.trackingId = trackingId || null;
    this.sessionToken = sessionToken;
  }

  // ============================================
  // TOP PROTOCOL SIGNING
  // ============================================

  /**
   * Generate timestamp as Unix milliseconds (required by new AE Open Platform).
   */
  _getTimestamp() {
    return String(Date.now());
  }

  /**
   * Sign a request using the TOP protocol (HMAC-SHA256).
   * 1. Sort params alphabetically by key
   * 2. Concatenate as key1value1key2value2...
   * 3. HMAC-SHA256 using appSecret as the key
   * 4. Uppercase hex digest
   *
   * @param {object} params - All request parameters (excluding 'sign')
   * @returns {string} Uppercase hex HMAC-SHA256 signature
   */
  _signRequest(params) {
    const sortedKeys = Object.keys(params).filter(k => k !== 'sign').sort();
    const concatenated = sortedKeys.reduce((acc, key) => {
      return acc + key + (params[key] !== undefined && params[key] !== null ? String(params[key]) : '');
    }, '');

    return crypto
      .createHmac('sha256', this.appSecret)
      .update(concatenated, 'utf8')
      .digest('hex')
      .toUpperCase();
  }

  /**
   * Make a signed API call to AliExpress
   * @param {string} method - API method name (e.g., 'aliexpress.affiliate.product.query')
   * @param {object} businessParams - Method-specific parameters
   * @returns {object} Parsed JSON response
   */
  async _makeApiCall(method, businessParams = {}) {
    const systemParams = {
      app_key: this.appKey,
      method,
      timestamp: this._getTimestamp(),
      v: API_VERSION,
      sign_method: SIGN_METHOD,
      format: 'json',
      simplify: true
    };

    // Include session token for authorized API calls (per-user commission attribution)
    if (this.sessionToken) {
      systemParams.session = this.sessionToken;
    }

    // Merge system and business params
    const allParams = { ...systemParams, ...businessParams };

    // Generate signature
    allParams.sign = this._signRequest(allParams);

    // Build URL-encoded body
    const body = Object.entries(allParams)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&');

    try {
      const response = await fetch(API_BASE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8'
        },
        body,
        signal: AbortSignal.timeout(15000) // 15s timeout
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`AE API HTTP error ${response.status}: ${errorText}`);
        return { success: false, error: `HTTP ${response.status}: ${errorText}` };
      }

      const data = await response.json();

      // Check for API-level errors
      if (data.error_response) {
        const errCode = data.error_response.code;
        const errMsg = data.error_response.msg || data.error_response.sub_msg || 'Unknown error';
        logger.error(`AE API error [${errCode}]: ${errMsg}`);
        return { success: false, error: errMsg, errorCode: errCode };
      }

      logger.info(`AE API [${method}] response keys: ${JSON.stringify(Object.keys(data))}`);
      return { success: true, data };
    } catch (error) {
      if (error.name === 'TimeoutError') {
        logger.error('AE API call timed out');
        return { success: false, error: 'Request timed out' };
      }
      logger.error('AE API call failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ============================================
  // PRODUCT SEARCH
  // ============================================

  /**
   * Search for affiliate products by keywords
   * @param {string} keywords - Search terms
   * @param {object} options
   * @param {number} [options.pageNo=1] - Page number
   * @param {number} [options.pageSize=20] - Results per page (max 50)
   * @param {string} [options.sortBy] - Sort: SALE_PRICE_ASC, SALE_PRICE_DESC, LAST_VOLUME_ASC, LAST_VOLUME_DESC
   * @param {number} [options.minPrice] - Min price in cents (target currency)
   * @param {number} [options.maxPrice] - Max price in cents (target currency)
   * @param {string} [options.categoryIds] - Comma-separated category IDs
   * @param {string} [options.targetCurrency='USD'] - Target currency code
   * @param {string} [options.targetLanguage='en'] - Target language code
   * @returns {object} { success, products: NormalizedProduct[], totalResults, pageNo, pageSize }
   */
  async searchProducts(keywords, options = {}) {
    const params = {
      keywords,
      target_currency: options.targetCurrency || 'USD',
      target_language: options.targetLanguage || 'en',
      page_no: options.pageNo || 1,
      page_size: Math.min(options.pageSize || 20, 50)
    };

    if (this.trackingId) params.tracking_id = this.trackingId;
    if (options.sortBy) params.sort = options.sortBy;
    if (options.minPrice) params.min_sale_price = options.minPrice;
    if (options.maxPrice) params.max_sale_price = options.maxPrice;
    if (options.categoryIds) params.category_ids = options.categoryIds;

    // Request fields using snake_case names (Streamlined Return format)
    params.fields = 'product_id,product_title,product_detail_url,product_main_image_url,product_small_image_urls,app_sale_price,app_sale_price_currency,original_price,original_price_currency,discount,evaluate_rate,lastest_volume,shop_url,shop_id,commission_rate,promotion_link,first_level_category_name,second_level_category_name';

    const result = await this._makeApiCall('aliexpress.affiliate.product.query', params);

    if (!result.success) return result;

    const responseKey = 'aliexpress_affiliate_product_query_response';
    const responseData = result.data[responseKey] || result.data;
    logger.info(`Search response structure: ${JSON.stringify(Object.keys(responseData || {}))}`);
    if (responseData?.resp_result) {
      logger.info(`resp_result: code=${responseData.resp_result.resp_code}, msg=${responseData.resp_result.resp_msg}`);
      const resultObj = responseData.resp_result.result || {};
      logger.info(`resp_result.result keys: ${JSON.stringify(Object.keys(resultObj))}`);
      logger.info(`total_record_count: ${resultObj.total_record_count}, current_record_count: ${resultObj.current_record_count}`);
      logger.info(`products type: ${typeof resultObj.products}, products value: ${JSON.stringify(resultObj.products)?.slice(0, 500)}`);
    }
    // Handle both simplified (flat array) and non-simplified ({ product: [...] }) formats
    const productsField = responseData?.resp_result?.result?.products;
    const rawProducts = Array.isArray(productsField) ? productsField : (productsField?.product || responseData?.products?.product || []);

    return {
      success: true,
      products: Array.isArray(rawProducts) ? rawProducts.map(p => this._normalizeProduct(p)) : [],
      totalResults: responseData?.resp_result?.result?.total_record_count || responseData?.total_results || 0,
      pageNo: params.page_no,
      pageSize: params.page_size
    };
  }

  /**
   * Get trending/hot products with high commissions
   * @param {object} options
   * @returns {object} { success, products: NormalizedProduct[] }
   */
  async getHotProducts(options = {}) {
    const params = {
      target_currency: options.targetCurrency || 'USD',
      target_language: options.targetLanguage || 'en',
      page_no: options.pageNo || 1,
      page_size: Math.min(options.pageSize || 20, 50)
    };

    if (this.trackingId) params.tracking_id = this.trackingId;
    if (options.categoryIds) params.category_ids = options.categoryIds;
    if (options.sortBy) params.sort = options.sortBy;

    params.fields = 'product_id,product_title,product_detail_url,product_main_image_url,product_small_image_urls,app_sale_price,app_sale_price_currency,original_price,original_price_currency,discount,evaluate_rate,lastest_volume,shop_url,shop_id,commission_rate,promotion_link,first_level_category_name,second_level_category_name';

    const result = await this._makeApiCall('aliexpress.affiliate.hotproduct.query', params);

    if (!result.success) return result;

    const responseKey = 'aliexpress_affiliate_hotproduct_query_response';
    const responseData = result.data[responseKey] || result.data;
    const hotProductsField = responseData?.resp_result?.result?.products;
    const rawProducts = Array.isArray(hotProductsField) ? hotProductsField : (hotProductsField?.product || responseData?.products?.product || []);

    return {
      success: true,
      products: Array.isArray(rawProducts) ? rawProducts.map(p => this._normalizeProduct(p)) : [],
      totalResults: responseData?.resp_result?.result?.total_record_count || responseData?.total_results || 0,
      pageNo: params.page_no,
      pageSize: params.page_size
    };
  }

  // ============================================
  // AFFILIATE LINK GENERATION
  // ============================================

  /**
   * Generate affiliate tracking links for product URLs
   * @param {string[]} productUrls - Array of AliExpress product URLs
   * @returns {object} { success, links: Array<{ originalUrl, affiliateUrl }> }
   */
  async generateAffiliateLinks(productUrls) {
    if (!productUrls?.length) {
      return { success: false, error: 'No product URLs provided' };
    }

    const params = {
      source_values: productUrls.join(','),
      promotion_link_type: 0 // 0 = search link, 2 = hot link
    };

    if (this.trackingId) params.tracking_id = this.trackingId;

    const result = await this._makeApiCall('aliexpress.affiliate.link.generate', params);

    if (!result.success) return result;

    const responseKey = 'aliexpress_affiliate_link_generate_response';
    const responseData = result.data[responseKey] || result.data;
    const linksField = responseData?.resp_result?.result?.promotion_links;
    const rawLinks = Array.isArray(linksField) ? linksField : (linksField?.promotion_link || responseData?.promotion_links?.promotion_link || []);

    return {
      success: true,
      links: Array.isArray(rawLinks) ? rawLinks.map(link => ({
        originalUrl: link.source_value,
        affiliateUrl: link.promotion_link
      })) : []
    };
  }

  // ============================================
  // PRODUCT DETAILS
  // ============================================

  /**
   * Get detailed info for specific products
   * @param {string[]} productIds - Array of AliExpress product IDs
   * @returns {object} { success, products: NormalizedProduct[] }
   */
  async getProductDetails(productIds) {
    if (!productIds?.length) {
      return { success: false, error: 'No product IDs provided' };
    }

    const params = {
      product_ids: productIds.join(','),
      target_currency: 'USD',
      target_language: 'en',
      fields: 'product_id,product_title,product_detail_url,product_main_image_url,product_small_image_urls,app_sale_price,app_sale_price_currency,original_price,original_price_currency,discount,evaluate_rate,lastest_volume,shop_url,shop_id,commission_rate,promotion_link'
    };

    if (this.trackingId) params.tracking_id = this.trackingId;

    const result = await this._makeApiCall('aliexpress.affiliate.productdetail.get', params);

    if (!result.success) return result;

    const responseKey = 'aliexpress_affiliate_productdetail_get_response';
    const responseData = result.data[responseKey] || result.data;
    const detailProductsField = responseData?.resp_result?.result?.products;
    const rawProducts = Array.isArray(detailProductsField) ? detailProductsField : (detailProductsField?.product || responseData?.products?.product || []);

    return {
      success: true,
      products: Array.isArray(rawProducts) ? rawProducts.map(p => this._normalizeProduct(p)) : []
    };
  }

  // ============================================
  // RESPONSE NORMALIZATION
  // ============================================

  /**
   * Normalize raw AE product data into a standard shape
   * @param {object} raw - Raw product from AE API
   * @returns {object} Normalized product
   */
  _normalizeProduct(raw) {
    const originalPrice = this._parsePrice(raw.original_price || raw.originalPrice);
    // Streamlined format uses app_sale_price (the price in target currency)
    const salePrice = this._parsePrice(raw.app_sale_price || raw.sale_price || raw.salePrice);
    const discount = originalPrice > 0 && salePrice > 0
      ? Math.round((1 - salePrice / originalPrice) * 100)
      : parseInt(raw.discount || '0', 10);

    // product_small_image_urls: flat array in Streamlined format, wrapped { string: [...] } in legacy
    const smallImages = raw.product_small_image_urls;
    const fallbackImage = Array.isArray(smallImages) ? smallImages[0] : (smallImages?.string?.[0] || '');

    return {
      productId: String(raw.product_id || raw.productId || ''),
      title: raw.product_title || raw.productTitle || '',
      // Streamlined format: product_detail_url; legacy: product_url / productUrl
      productUrl: raw.product_detail_url || raw.product_url || raw.productUrl || '',
      imageUrl: raw.product_main_image_url || raw.imageUrl || fallbackImage,
      originalPrice,
      salePrice,
      discount,
      currency: raw.app_sale_price_currency || raw.target_sale_price_currency || 'USD',
      commissionRate: parseFloat(raw.commission_rate || raw.commissionRate || '0'),
      commission30d: raw['30d_commission'] || raw['30daysCommission'] || null,
      rating: parseFloat(raw.evaluate_rate || raw.evaluateRate || '0'),
      totalOrders: parseInt(raw.lastest_volume || raw.latest_volume || '0', 10),
      storeName: raw.shop_id ? `Store ${raw.shop_id}` : (raw.shopId ? `Store ${raw.shopId}` : ''),
      storeUrl: raw.shop_url || raw.shopUrl || '',
      category: raw.first_level_category_name || raw.second_level_category_name || null,
      // Affiliate URL is populated separately via generateAffiliateLinks
      affiliateUrl: raw.promotion_link || null
    };
  }

  /**
   * Parse price from various formats (string with currency symbol, number, etc.)
   * @param {string|number} priceStr
   * @returns {number} Price as a float
   */
  _parsePrice(priceStr) {
    if (typeof priceStr === 'number') return priceStr;
    if (!priceStr) return 0;
    // Remove currency symbols and whitespace
    const cleaned = String(priceStr).replace(/[^0-9.]/g, '');
    return parseFloat(cleaned) || 0;
  }
}

export default AliExpressService;
