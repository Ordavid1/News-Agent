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
    return this._signRequestWithSecret(params, this.appSecret);
  }

  /**
   * Sign a request with a specific secret (supports credential overrides).
   * @param {object} params - All request parameters (excluding 'sign')
   * @param {string} secret - The app secret to use for HMAC signing
   * @returns {string} Uppercase hex HMAC-SHA256 signature
   */
  _signRequestWithSecret(params, secret) {
    const sortedKeys = Object.keys(params).filter(k => k !== 'sign').sort();
    const concatenated = sortedKeys.reduce((acc, key) => {
      return acc + key + (params[key] !== undefined && params[key] !== null ? String(params[key]) : '');
    }, '');

    return crypto
      .createHmac('sha256', secret)
      .update(concatenated, 'utf8')
      .digest('hex')
      .toUpperCase();
  }

  /**
   * Make a signed API call to AliExpress
   * @param {string} method - API method name (e.g., 'aliexpress.affiliate.product.query')
   * @param {object} businessParams - Method-specific parameters
   * @param {object} [options] - Optional overrides
   * @param {string} [options.appKey] - Override app key (e.g., for DS API with separate credentials)
   * @param {string} [options.appSecret] - Override app secret
   * @param {string} [options.accessToken] - Override access token (e.g., DS app's own OAuth token)
   * @returns {object} Parsed JSON response
   */
  async _makeApiCall(method, businessParams = {}, options = {}) {
    const appKey = options.appKey || this.appKey;
    const appSecret = options.appSecret || this.appSecret;

    const systemParams = {
      app_key: appKey,
      method,
      timestamp: this._getTimestamp(),
      v: API_VERSION,
      sign_method: SIGN_METHOD,
      format: 'json',
      simplify: true
    };

    // Include session/access token:
    // - Override access token takes priority (e.g., DS app's own OAuth token)
    // - Otherwise use the instance session token for affiliate API calls
    if (options.accessToken) {
      systemParams.session = options.accessToken;
    } else if (this.sessionToken && !options.appKey) {
      systemParams.session = this.sessionToken;
    }

    // Merge system and business params
    const allParams = { ...systemParams, ...businessParams };

    // Generate signature using the appropriate secret
    allParams.sign = this._signRequestWithSecret(allParams, appSecret);

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

  /**
   * Get featured/promo products — supports richer sort options including commission
   * Uses aliexpress.affiliate.featuredpromo.products.get
   * @param {object} options
   * @param {string} [options.keywords] - Filter by keywords
   * @param {string} [options.sortBy] - commissionAsc, commissionDesc, priceAsc, priceDesc, volumeAsc, volumeDesc, discountAsc, discountDesc, ratingAsc, ratingDesc
   * @param {string} [options.promotionName] - "Hot Product", "New Arrival", "Best Seller", "weeklydeals"
   * @param {string} [options.categoryIds] - Category filter
   * @param {number} [options.pageNo=1]
   * @param {number} [options.pageSize=20]
   * @returns {object} { success, products, totalResults, totalPages, pageNo, pageSize }
   */
  async getFeaturedProducts(options = {}) {
    const params = {
      target_currency: options.targetCurrency || 'USD',
      target_language: options.targetLanguage || 'en',
      page_no: options.pageNo || 1,
      page_size: Math.min(options.pageSize || 20, 50)
    };

    if (this.trackingId) params.tracking_id = this.trackingId;
    if (options.keywords) params.keywords = options.keywords;
    if (options.categoryIds) params.category_id = options.categoryIds;
    if (options.sortBy) params.sort = options.sortBy;
    if (options.promotionName) params.promotion_name = options.promotionName;
    if (options.country) params.country = options.country;

    params.fields = 'product_id,product_title,product_detail_url,product_main_image_url,product_small_image_urls,app_sale_price,app_sale_price_currency,original_price,original_price_currency,discount,evaluate_rate,lastest_volume,shop_url,shop_id,commission_rate,promotion_link,first_level_category_name,second_level_category_name';

    const result = await this._makeApiCall('aliexpress.affiliate.featuredpromo.products.get', params);

    if (!result.success) return result;

    const responseKey = 'aliexpress_affiliate_featuredpromo_products_get_response';
    const responseData = result.data[responseKey] || result.data;
    const productsField = responseData?.resp_result?.result?.products;
    const rawProducts = Array.isArray(productsField) ? productsField : (productsField?.product || []);

    return {
      success: true,
      products: Array.isArray(rawProducts) ? rawProducts.map(p => this._normalizeProduct(p)) : [],
      totalResults: parseInt(responseData?.resp_result?.result?.total_record_count || '0', 10),
      totalPages: parseInt(responseData?.resp_result?.result?.total_page_no || '0', 10),
      pageNo: params.page_no,
      pageSize: params.page_size
    };
  }

  // ============================================
  // CATEGORIES
  // ============================================

  /**
   * Get all affiliate product categories
   * Uses aliexpress.affiliate.category.get
   * @returns {object} { success, categories: Array<{ categoryId, categoryName, parentCategoryId }> }
   */
  async getCategories() {
    const result = await this._makeApiCall('aliexpress.affiliate.category.get', {});

    if (!result.success) return result;

    const responseKey = 'aliexpress_affiliate_category_get_response';
    const responseData = result.data[responseKey] || result.data;
    const categoriesField = responseData?.resp_result?.result?.categories;
    const rawCategories = Array.isArray(categoriesField) ? categoriesField : (categoriesField?.category || []);

    return {
      success: true,
      categories: rawCategories.map(c => ({
        categoryId: String(c.category_id),
        categoryName: c.category_name,
        parentCategoryId: c.parent_category_id ? String(c.parent_category_id) : null
      }))
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
      promotion_link_type: 0, // 0 = normal link (standard commission), 2 = hot link (hot product commission)
      tracking_id: this.trackingId || 'default' // Required per AE docs
    };

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
  // PRODUCT DESCRIPTION (Dropshipper API)
  // ============================================

  /**
   * Fetch rich product description via the AE Dropshipper API.
   * Returns the product's actual description text, attributes/specs, and metadata.
   *
   * Supports dual-credential mode: if ALIEXPRESS_DS_APP_KEY, ALIEXPRESS_DS_APP_SECRET,
   * and ALIEXPRESS_DS_ACCESS_TOKEN are set, uses those credentials (a separate AE Open
   * Platform app approved for the Dropshipper API). Otherwise falls back to the main
   * affiliate app credentials. The DS API requires an OAuth access_token obtained by
   * authorizing once through the DS app's OAuth flow.
   *
   * @param {string} productId - AliExpress product ID
   * @param {object} [options]
   * @param {string} [options.targetLanguage='en'] - Language code
   * @returns {object} { success, description, attributes, rawDetail }
   */
  async getProductDescription(productId, options = {}) {
    const { targetLanguage = 'en' } = options;

    // Use dedicated DS API credentials if available (separate app approved for Dropshipper API)
    const dsAppKey = process.env.ALIEXPRESS_DS_APP_KEY;
    const dsAppSecret = process.env.ALIEXPRESS_DS_APP_SECRET;
    const dsAccessToken = process.env.ALIEXPRESS_DS_ACCESS_TOKEN;
    const credentialOverrides = (dsAppKey && dsAppSecret && dsAccessToken)
      ? { appKey: dsAppKey, appSecret: dsAppSecret, accessToken: dsAccessToken }
      : {};

    const usingDsCreds = !!credentialOverrides.appKey;
    logger.info(`Fetching product description via DS API for product ${productId} (credentials: ${usingDsCreds ? 'DS app' : 'main app'})`);

    const params = {
      product_id: productId,
      target_language: targetLanguage,
      // ship_to_country helps get localized content
      ship_to_country: 'US'
    };

    const result = await this._makeApiCall('aliexpress.ds.product.get', params, credentialOverrides);

    if (!result.success) {
      logger.warn(`DS API failed for product ${productId}: ${result.error} (code: ${result.errorCode || 'N/A'})`);
      logger.warn('This may mean the Dropshipper API is not enabled for this app. Falling back to title-only content.');
      return { success: false, error: result.error, errorCode: result.errorCode };
    }

    // Parse the DS API response — structure: aliexpress_ds_product_get_response.result
    const responseKey = 'aliexpress_ds_product_get_response';
    const responseData = result.data[responseKey] || result.data;
    const productData = responseData?.result || responseData;

    if (!productData) {
      logger.warn(`DS API returned empty data for product ${productId}`);
      return { success: false, error: 'Empty response from DS API' };
    }

    // Extract the HTML description from ae_item_base_info_dto
    const baseInfo = productData.ae_item_base_info_dto || {};
    const multimediaInfo = productData.ae_multimedia_info_dto || {};
    const rawDetail = productData.detail
      || productData.mobile_detail
      || baseInfo.detail
      || baseInfo.mobile_detail
      || multimediaInfo.detail
      || '';

    // Strip HTML tags to get plain text description
    const description = rawDetail
      ? rawDetail
          .replace(/<img[^>]*>/gi, '') // Remove image tags
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '') // Remove style blocks
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '') // Remove script blocks
          .replace(/<[^>]+>/g, ' ') // Remove remaining HTML tags
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/\s+/g, ' ') // Collapse whitespace
          .trim()
      : '';

    // Extract product attributes/specs — may be nested under ae_item_properties or ae_item_base_info_dto
    const rawAttributes = productData.ae_item_properties?.ae_item_property
      || productData.ae_item_properties
      || baseInfo.ae_item_properties?.ae_item_property
      || baseInfo.ae_item_properties
      || [];
    const attributes = Array.isArray(rawAttributes)
      ? rawAttributes.map(attr => ({
          name: attr.attr_name || attr.property_name || '',
          value: attr.attr_value || attr.property_value || ''
        })).filter(a => a.name && a.value)
      : [];

    // Truncate description to a reasonable size for the LLM prompt (first ~1500 chars)
    const truncatedDescription = description.length > 1500
      ? description.substring(0, 1500) + '...'
      : description;

    logger.info(`DS API success for product ${productId}: description=${truncatedDescription.length} chars, attributes=${attributes.length} specs`);
    logger.debug(`DS API raw detail length: ${rawDetail.length} chars`);
    logger.debug(`DS API attributes: ${JSON.stringify(attributes.slice(0, 5))}${attributes.length > 5 ? '...' : ''}`);

    return {
      success: true,
      description: truncatedDescription,
      attributes,
      subject: productData.subject || '', // Product title from DS API
      rawDetailLength: rawDetail.length
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

    // Promo code info (coupon data from AE)
    const promoCodeInfo = raw.promo_code_info || null;

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
      // Real store name from API (shop_name field); falls back to shop_id placeholder
      storeName: raw.shop_name || (raw.shop_id ? `Store ${raw.shop_id}` : (raw.shopId ? `Store ${raw.shopId}` : '')),
      storeUrl: raw.shop_url || raw.shopUrl || '',
      category: raw.first_level_category_name || raw.second_level_category_name || null,
      smallImages: Array.isArray(smallImages) ? smallImages : (smallImages?.string || []),
      // Video URL for the product (if available)
      videoUrl: raw.product_video_url || null,
      // Estimated shipping days
      shipToDays: raw.ship_to_days ? parseInt(raw.ship_to_days, 10) : null,
      // Promo code / coupon info
      promoCode: promoCodeInfo ? {
        code: promoCodeInfo.promo_code || null,
        value: promoCodeInfo.code_value || null,
        minSpend: promoCodeInfo.code_min_spend || null,
        startTime: promoCodeInfo.code_starttime || null,
        endTime: promoCodeInfo.code_endtime || null
      } : null,
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
