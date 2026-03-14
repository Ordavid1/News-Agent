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
// PRODUCT SEARCH (Manual Preview)
// ============================================

// Search products by keywords
router.get('/products/search', async (req, res) => {
  try {
    const { keywords, pageNo, pageSize, sortBy, minPrice, maxPrice, currency } = req.query;

    if (!keywords) {
      return res.status(400).json({ error: 'keywords parameter is required' });
    }

    const credentials = await AffiliateCredentialManager.getCredentials(req.user.id);
    if (!credentials) {
      return res.status(400).json({ error: 'AE credentials not configured. Please set up your credentials first.' });
    }

    const result = await AffiliateProductFetcher.searchProducts(credentials, keywords, {
      pageNo: parseInt(pageNo) || 1,
      pageSize: Math.min(parseInt(pageSize) || 20, 50),
      sortBy,
      minPrice: minPrice ? parseFloat(minPrice) : undefined,
      maxPrice: maxPrice ? parseFloat(maxPrice) : undefined,
      targetCurrency: currency || 'USD'
    });

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

    const result = await AffiliateProductFetcher.getHotProducts(credentials, {
      pageNo: parseInt(pageNo) || 1,
      pageSize: Math.min(parseInt(pageSize) || 20, 50),
      categoryIds,
      targetCurrency: currency || 'USD'
    });

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
// MANUAL PRODUCT POSTING
// ============================================

// Post a specific product to a platform
router.post('/products/post', async (req, res) => {
  try {
    const { productUrl, platform } = req.body;

    if (!productUrl) {
      return res.status(400).json({ error: 'productUrl is required' });
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

    // Extract product ID from URL
    const productIdMatch = productUrl.match(/\/(\d+)\.html/);
    let product;

    if (productIdMatch) {
      const detailResult = await service.getProductDetails([productIdMatch[1]]);
      if (detailResult.success && detailResult.products.length > 0) {
        product = detailResult.products[0];
        product.affiliateUrl = linkResult.affiliateUrl;
      }
    }

    if (!product) {
      // Fallback: create minimal product object
      product = {
        productId: productIdMatch?.[1] || 'unknown',
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

    // Generate content
    const contentGenerator = new ContentGenerator();
    const content = await contentGenerator.generateAffiliateContent(product, platform, {});

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
