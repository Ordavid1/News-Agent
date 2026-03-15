// routes/affiliate.js
// API routes for the AE Affiliate feature: credentials, keywords, product search, manual posting, stats.
// All routes require authenticateToken (applied in server.js) + requireAffiliateAddon() middleware.

import express from 'express';
import { requireAffiliateAddon, AFFILIATE_LIMITS } from '../middleware/subscription.js';
import AffiliateCredentialManager from '../services/AffiliateCredentialManager.js';
import AffiliateProductFetcher from '../services/AffiliateProductFetcher.js';
import ContentGenerator from '../services/ContentGenerator.js';
import {
  getAffiliateKeywords,
  getAffiliateKeywordById,
  createAffiliateKeyword,
  updateAffiliateKeyword,
  deleteAffiliateKeyword,
  countAffiliateKeywords,
  getAffiliatePublishedProducts,
  getAffiliateStats,
  recordAffiliatePublishedProduct
} from '../services/database-wrapper.js';
import {
  publishToWhatsApp,
  publishToTelegram
} from '../services/PublishingService.js';

const router = express.Router();

// Apply affiliate add-on middleware to all routes
router.use(requireAffiliateAddon());

// ============================================
// CREDENTIAL MANAGEMENT
// ============================================

// Store user's affiliate tracking ID (encrypted)
router.post('/credentials', async (req, res) => {
  try {
    const { trackingId } = req.body;

    if (!trackingId) {
      return res.status(400).json({
        error: 'Missing required field: trackingId'
      });
    }

    const result = await AffiliateCredentialManager.storeCredentials(req.user.id, trackingId.trim());

    res.json({
      success: true,
      credentials: result
    });
  } catch (error) {
    console.error('[AFFILIATE] Error storing credentials:', error);
    res.status(500).json({ error: 'Failed to store credentials' });
  }
});

// Check credential status (no secrets returned)
router.get('/credentials/status', async (req, res) => {
  try {
    const status = await AffiliateCredentialManager.getCredentialStatus(req.user.id);
    res.json(status);
  } catch (error) {
    console.error('[AFFILIATE] Error checking credential status:', error);
    res.status(500).json({ error: 'Failed to check credential status' });
  }
});

// Delete credentials
router.delete('/credentials', async (req, res) => {
  try {
    await AffiliateCredentialManager.deleteCredentials(req.user.id);
    res.json({ success: true, message: 'Credentials deleted' });
  } catch (error) {
    console.error('[AFFILIATE] Error deleting credentials:', error);
    res.status(500).json({ error: 'Failed to delete credentials' });
  }
});

// Validate credentials with a test API call
router.post('/credentials/validate', async (req, res) => {
  try {
    const result = await AffiliateCredentialManager.validateCredentials(req.user.id);
    res.json(result);
  } catch (error) {
    console.error('[AFFILIATE] Error validating credentials:', error);
    res.status(500).json({ error: 'Failed to validate credentials' });
  }
});

// ============================================
// CATEGORIES
// ============================================

// Get product categories for filter dropdown (cached per-process)
let _cachedCategories = null;
let _categoriesCachedAt = 0;
const CATEGORY_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

router.get('/categories', async (req, res) => {
  try {
    // Return cached if fresh
    if (_cachedCategories && (Date.now() - _categoriesCachedAt) < CATEGORY_CACHE_TTL) {
      return res.json(_cachedCategories);
    }

    const credentials = await AffiliateCredentialManager.getCredentials(req.user.id);
    if (!credentials) {
      return res.status(400).json({ error: 'AE credentials not configured' });
    }

    const AliExpressService = (await import('../services/AliExpressService.js')).default;
    const service = new AliExpressService(credentials.trackingId, credentials.sessionToken || null);
    const result = await service.getCategories();

    if (!result.success) {
      return res.status(502).json({ error: result.error || 'Failed to fetch categories' });
    }

    // Build hierarchical structure: top-level categories with children
    const topLevel = result.categories.filter(c => !c.parentCategoryId || c.parentCategoryId === '0');
    const children = result.categories.filter(c => c.parentCategoryId && c.parentCategoryId !== '0');
    const childMap = {};
    for (const child of children) {
      if (!childMap[child.parentCategoryId]) childMap[child.parentCategoryId] = [];
      childMap[child.parentCategoryId].push(child);
    }

    const structured = topLevel.map(cat => ({
      ...cat,
      children: (childMap[cat.categoryId] || []).sort((a, b) => a.categoryName.localeCompare(b.categoryName))
    })).sort((a, b) => a.categoryName.localeCompare(b.categoryName));

    _cachedCategories = { success: true, categories: structured };
    _categoriesCachedAt = Date.now();

    res.json(_cachedCategories);
  } catch (error) {
    console.error('[AFFILIATE] Error fetching categories:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// ============================================
// PRODUCT SEARCH (Manual Preview)
// ============================================

// Search products by keywords
router.get('/products/search', async (req, res) => {
  try {
    const { keywords, pageNo, pageSize, sortBy, minPrice, maxPrice, currency, categoryIds } = req.query;

    if (!keywords) {
      return res.status(400).json({ error: 'keywords parameter is required' });
    }

    const credentials = await AffiliateCredentialManager.getCredentials(req.user.id);
    if (!credentials) {
      return res.status(400).json({ error: 'AE credentials not configured. Please set up your credentials first.' });
    }

    console.log(`[AFFILIATE] Product search for user ${req.user.id}, keywords: "${keywords}", sort: "${sortBy || 'relevance'}", trackingId: ${credentials.trackingId ? 'present' : 'missing'}`);

    // Commission sort is not supported by product.query API — sort client-side
    const CLIENT_SORT_VALUES = ['commissionDesc'];
    const isClientSort = CLIENT_SORT_VALUES.includes(sortBy);

    const result = await AffiliateProductFetcher.searchProducts(credentials, keywords, {
      pageNo: parseInt(pageNo) || 1,
      pageSize: Math.min(parseInt(pageSize) || 20, 50),
      sortBy: isClientSort ? undefined : sortBy,
      minPrice: minPrice ? parseFloat(minPrice) : undefined,
      maxPrice: maxPrice ? parseFloat(maxPrice) : undefined,
      categoryIds: categoryIds || undefined,
      targetCurrency: currency || 'USD'
    });

    // Client-side sort for commission (AE product.query doesn't support commission sort)
    if (isClientSort && result.success && result.products?.length > 0) {
      result.products.sort((a, b) => (b.commissionRate || 0) - (a.commissionRate || 0));
    }

    if (!result.success) {
      console.error('[AFFILIATE] Product search API error:', result.error, result.errorCode || '');
      return res.status(502).json({ error: result.error || 'AliExpress API error' });
    }

    console.log(`[AFFILIATE] Search returned ${result.products?.length || 0} products`);
    res.json(result);
  } catch (error) {
    console.error('[AFFILIATE] Error searching products:', error);
    res.status(500).json({ error: 'Failed to search products' });
  }
});

// Get hot/trending products
router.get('/products/hot', async (req, res) => {
  try {
    const { pageNo, pageSize, categoryIds, currency } = req.query;

    const credentials = await AffiliateCredentialManager.getCredentials(req.user.id);
    if (!credentials) {
      return res.status(400).json({ error: 'AE credentials not configured' });
    }

    console.log(`[AFFILIATE] Hot products search for user ${req.user.id}`);

    const result = await AffiliateProductFetcher.getHotProducts(credentials, {
      pageNo: parseInt(pageNo) || 1,
      pageSize: Math.min(parseInt(pageSize) || 20, 50),
      categoryIds,
      targetCurrency: currency || 'USD'
    });

    if (!result.success) {
      console.error('[AFFILIATE] Hot products API error:', result.error, result.errorCode || '');
      return res.status(502).json({ error: result.error || 'AliExpress API error' });
    }

    console.log(`[AFFILIATE] Hot products returned ${result.products?.length || 0} products`);
    res.json(result);
  } catch (error) {
    console.error('[AFFILIATE] Error fetching hot products:', error);
    res.status(500).json({ error: 'Failed to fetch hot products' });
  }
});

// ============================================
// KEYWORD MANAGEMENT
// ============================================

// Get all keyword sets for user
router.get('/keywords', async (req, res) => {
  try {
    const keywords = await getAffiliateKeywords(req.user.id);
    res.json({ keywords });
  } catch (error) {
    console.error('[AFFILIATE] Error fetching keywords:', error);
    res.status(500).json({ error: 'Failed to fetch keyword sets' });
  }
});

// Create a keyword set
router.post('/keywords', async (req, res) => {
  try {
    const { name, keywords, category, minPrice, maxPrice, minCommissionRate, minRating, minOrders, sortBy, targetCurrency } = req.body;

    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
      return res.status(400).json({ error: 'keywords must be a non-empty array of search terms' });
    }

    // Check keyword set limit
    const currentCount = await countAffiliateKeywords(req.user.id);
    const limit = req.affiliateLimits.maxKeywordSets;
    if (limit !== -1 && currentCount >= limit) {
      return res.status(403).json({
        error: `Keyword set limit reached (${currentCount}/${limit}). Upgrade your plan for more.`
      });
    }

    const result = await createAffiliateKeyword(req.user.id, {
      name: name || `Keywords ${currentCount + 1}`,
      keywords: keywords.map(k => k.trim()).filter(Boolean),
      category,
      minPrice: minPrice ? parseFloat(minPrice) : null,
      maxPrice: maxPrice ? parseFloat(maxPrice) : null,
      minCommissionRate: minCommissionRate ? parseFloat(minCommissionRate) : null,
      minRating: minRating ? parseFloat(minRating) : null,
      minOrders: minOrders ? parseInt(minOrders) : null,
      sortBy: sortBy || 'commission_rate',
      targetCurrency: targetCurrency || 'USD'
    });

    res.json({ success: true, keyword: result });
  } catch (error) {
    console.error('[AFFILIATE] Error creating keyword set:', error);
    res.status(500).json({ error: 'Failed to create keyword set' });
  }
});

// Update a keyword set
router.put('/keywords/:id', async (req, res) => {
  try {
    const keywordId = req.params.id;

    // Verify ownership
    const existing = await getAffiliateKeywordById(keywordId);
    if (!existing || existing.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Keyword set not found' });
    }

    const updates = {};
    const allowedFields = ['name', 'keywords', 'category', 'min_price', 'max_price', 'min_commission_rate', 'min_rating', 'min_orders', 'sort_by', 'target_currency', 'is_active'];

    // Map camelCase request body to snake_case DB fields
    const fieldMapping = {
      name: 'name',
      keywords: 'keywords',
      category: 'category',
      minPrice: 'min_price',
      maxPrice: 'max_price',
      minCommissionRate: 'min_commission_rate',
      minRating: 'min_rating',
      minOrders: 'min_orders',
      sortBy: 'sort_by',
      targetCurrency: 'target_currency',
      isActive: 'is_active'
    };

    for (const [camelKey, snakeKey] of Object.entries(fieldMapping)) {
      if (req.body[camelKey] !== undefined) {
        updates[snakeKey] = req.body[camelKey];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const result = await updateAffiliateKeyword(keywordId, updates);
    res.json({ success: true, keyword: result });
  } catch (error) {
    console.error('[AFFILIATE] Error updating keyword set:', error);
    res.status(500).json({ error: 'Failed to update keyword set' });
  }
});

// Delete a keyword set
router.delete('/keywords/:id', async (req, res) => {
  try {
    const keywordId = req.params.id;

    // Verify ownership
    const existing = await getAffiliateKeywordById(keywordId);
    if (!existing || existing.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Keyword set not found' });
    }

    await deleteAffiliateKeyword(keywordId);
    res.json({ success: true, message: 'Keyword set deleted' });
  } catch (error) {
    console.error('[AFFILIATE] Error deleting keyword set:', error);
    res.status(500).json({ error: 'Failed to delete keyword set' });
  }
});

// ============================================
// CONTENT GENERATION PREVIEW
// ============================================

// Generate AI-powered social media content for a product without posting
router.post('/products/generate-content', async (req, res) => {
  try {
    const { productId, platform } = req.body;

    if (!productId) {
      return res.status(400).json({ error: 'productId is required' });
    }

    if (!platform || !['whatsapp', 'telegram'].includes(platform)) {
      return res.status(400).json({ error: 'platform must be "whatsapp" or "telegram"' });
    }

    const credentials = await AffiliateCredentialManager.getCredentials(req.user.id);
    if (!credentials) {
      return res.status(400).json({ error: 'AE credentials not configured' });
    }

    const productUrl = `https://www.aliexpress.com/item/${productId}.html`;

    // Generate affiliate link
    console.log(`[AFFILIATE] Generating content for product ${productId} on ${platform}`);
    const linkResult = await AffiliateProductFetcher.generateLink(credentials, productUrl);
    if (!linkResult.success) {
      return res.status(400).json({ error: `Failed to generate affiliate link: ${linkResult.error}` });
    }

    // Get product details (Affiliate API)
    const AliExpressService = (await import('../services/AliExpressService.js')).default;
    const service = new AliExpressService(credentials.trackingId, credentials.sessionToken || null);

    let product;
    const detailResult = await service.getProductDetails([productId]);
    if (detailResult.success && detailResult.products.length > 0) {
      product = detailResult.products[0];
      product.affiliateUrl = linkResult.affiliateUrl;
      console.log(`[AFFILIATE] Got affiliate product details: "${product.title}" ($${product.salePrice})`);
    }

    if (!product) {
      product = {
        productId,
        title: 'AliExpress Product',
        originalPrice: 0,
        salePrice: 0,
        discount: 0,
        commissionRate: 0,
        rating: 0,
        totalOrders: 0,
        imageUrl: '',
        affiliateUrl: linkResult.affiliateUrl,
        productUrl
      };
    }

    // Fetch rich product description via Dropshipper API (best-effort)
    // This gives us the actual product page content — description text + specs/attributes
    let descriptionData = null;
    try {
      console.log(`[AFFILIATE] Attempting to fetch product description via DS API for product ${productId}...`);
      const dsResult = await service.getProductDescription(productId);
      if (dsResult.success) {
        descriptionData = dsResult;
        console.log(`[AFFILIATE] DS API SUCCESS — description: ${dsResult.description.length} chars, attributes: ${dsResult.attributes.length} specs`);
        if (dsResult.attributes.length > 0) {
          console.log(`[AFFILIATE] Product specs sample: ${dsResult.attributes.slice(0, 3).map(a => `${a.name}=${a.value}`).join(', ')}`);
        }
      } else {
        console.log(`[AFFILIATE] DS API not available (${dsResult.error}). Will generate content from title + stats only.`);
      }
    } catch (dsError) {
      console.log(`[AFFILIATE] DS API call threw error: ${dsError.message}. Continuing without description.`);
    }

    // Attach description data to product object for prompt consumption
    if (descriptionData) {
      product.description = descriptionData.description;
      product.attributes = descriptionData.attributes;
      console.log(`[AFFILIATE] Enriched product with description (${product.description.length} chars) and ${product.attributes.length} attributes`);
    } else {
      console.log(`[AFFILIATE] No description available — LLM will generate based on title + stats`);
    }

    // Generate content (preview only, no publishing)
    const contentGenerator = new ContentGenerator();
    console.log(`[AFFILIATE] Generating ${platform} content with${product.description ? '' : 'out'} product description`);
    const content = await contentGenerator.generateAffiliateContent(product, platform, {});
    console.log(`[AFFILIATE] Content generated: ${content.text.length} chars`);

    res.json({
      success: true,
      text: content.text,
      affiliateUrl: product.affiliateUrl,
      product: content.product,
      // Include metadata so frontend/debug can see what was used
      _meta: {
        hasDescription: !!product.description,
        descriptionLength: product.description?.length || 0,
        attributeCount: product.attributes?.length || 0,
        source: product.description ? 'ds_api+affiliate_api' : 'affiliate_api_only'
      }
    });
  } catch (error) {
    console.error('[AFFILIATE] Error generating content preview:', error);
    res.status(500).json({ error: 'Failed to generate content' });
  }
});

// ============================================
// MANUAL PRODUCT POSTING
// ============================================

// Post a specific product to a platform
router.post('/products/post', async (req, res) => {
  try {
    const { productId, productUrl: rawProductUrl, platform, customContent } = req.body;

    // Accept either productId or productUrl — construct URL from ID if needed
    const productUrl = rawProductUrl || (productId ? `https://www.aliexpress.com/item/${productId}.html` : null);
    const resolvedProductId = productId || rawProductUrl?.match(/\/(\d+)\.html/)?.[1];

    if (!productUrl || !resolvedProductId) {
      return res.status(400).json({ error: 'productId or productUrl is required' });
    }

    if (!platform || !['whatsapp', 'telegram'].includes(platform)) {
      return res.status(400).json({ error: 'platform must be "whatsapp" or "telegram"' });
    }

    const credentials = await AffiliateCredentialManager.getCredentials(req.user.id);
    if (!credentials) {
      return res.status(400).json({ error: 'AE credentials not configured' });
    }

    // Generate affiliate link
    const linkResult = await AffiliateProductFetcher.generateLink(credentials, productUrl);
    if (!linkResult.success) {
      return res.status(400).json({ error: `Failed to generate affiliate link: ${linkResult.error}` });
    }

    // Get product details
    const AliExpressService = (await import('../services/AliExpressService.js')).default;
    const service = new AliExpressService(credentials.trackingId, credentials.sessionToken || null);

    let product;
    const detailResult = await service.getProductDetails([resolvedProductId]);
    if (detailResult.success && detailResult.products.length > 0) {
      product = detailResult.products[0];
      product.affiliateUrl = linkResult.affiliateUrl;
    }

    if (!product) {
      // Fallback: create minimal product object
      product = {
        productId: resolvedProductId || 'unknown',
        title: 'AliExpress Product',
        originalPrice: 0,
        salePrice: 0,
        discount: 0,
        commissionRate: 0,
        rating: 0,
        totalOrders: 0,
        imageUrl: '',
        affiliateUrl: linkResult.affiliateUrl,
        productUrl
      };
    }

    // Use custom content if provided (from detail modal preview), otherwise generate fresh
    let content;
    if (customContent) {
      content = {
        text: customContent,
        platform,
        contentType: 'affiliate_product',
        product: {
          productId: product.productId,
          title: product.title,
          affiliateUrl: product.affiliateUrl,
          imageUrl: product.imageUrl,
          salePrice: product.salePrice
        },
        generatedAt: new Date().toISOString()
      };
    } else {
      const contentGenerator = new ContentGenerator();
      content = await contentGenerator.generateAffiliateContent(product, platform, {});
    }

    // Publish
    let publishResult;
    if (platform === 'whatsapp') {
      publishResult = await publishToWhatsApp(content, req.user.id, product.imageUrl || null);
    } else {
      publishResult = await publishToTelegram(content, req.user.id, product.imageUrl || null);
    }

    if (publishResult?.success) {
      // Record for dedup (no agent_id for manual posts — use user ID as placeholder)
      res.json({
        success: true,
        message: `Product posted to ${platform}`,
        affiliateUrl: product.affiliateUrl
      });
    } else {
      res.status(500).json({
        error: `Failed to publish to ${platform}`,
        details: publishResult?.error
      });
    }
  } catch (error) {
    console.error('[AFFILIATE] Error posting product:', error);
    res.status(500).json({ error: 'Failed to post product' });
  }
});

// ============================================
// ANALYTICS
// ============================================

// Get published product stats
router.get('/stats', async (req, res) => {
  try {
    const stats = await getAffiliateStats(req.user.id);
    res.json(stats);
  } catch (error) {
    console.error('[AFFILIATE] Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch affiliate stats' });
  }
});

// Get published products history
router.get('/history', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;

    const products = await getAffiliatePublishedProducts(req.user.id, { limit, offset });
    res.json({ products });
  } catch (error) {
    console.error('[AFFILIATE] Error fetching history:', error);
    res.status(500).json({ error: 'Failed to fetch product history' });
  }
});

export default router;
