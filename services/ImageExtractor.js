// services/ImageExtractor.js
import axios from 'axios';
import * as cheerio from 'cheerio';
import winston from 'winston';
import { URL } from 'url';
import ArticleResolver from './ArticleResolver.js';
import ArticleSearcher from './ArticleSearcher.js';

const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[ImageExtractor] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

class ImageExtractor {
  /**
   * Platforms that require media (image/video) — text-only posts not supported
   */
  static PLATFORMS_REQUIRING_MEDIA = ['instagram', 'tiktok'];

  constructor() {
    this.articleResolver = new ArticleResolver();
    this.articleSearcher = new ArticleSearcher();

    // Common ad/tracking domains to exclude
    this.adDomains = [
      'doubleclick.net',
      'googlesyndication.com',
      'googleadservices.com',
      'amazon-adsystem.com',
      'adsystem.com',
      'adnxs.com',
      'adsrvr.org',
      'facebook.com/tr',
      'google-analytics.com',
      'googletagmanager.com',
      'scorecardresearch.com',
      'outbrain.com',
      'taboola.com',
      'criteo.com',
      'quantserve.com',
      'pixel',
      'tracking',
      'analytics',
      'adsafeprotected.com',
      'moatads.com',
      'addthis.com',
      'sharethis.com'
    ];

    // Minimum dimensions for valid images - lowered to capture more images
    this.minWidth = 200;
    this.minHeight = 100;
  }

  async extractImageFromArticle(articleUrl, articleTitle = null, articleSource = null, { excludeUrls = [] } = {}) {
    try {
      const isAltSearch = excludeUrls.length > 0;
      logger.info(`${isAltSearch ? 'Extracting alternative image' : 'Extracting image'} from: ${articleUrl}${isAltSearch ? ` (excluding ${excludeUrls.length} URL(s))` : ''}`);

      let actualUrl = articleUrl;

      // If it's a Google News URL and we have title/source, try searching for the actual article
      if (articleUrl.includes('news.google.com') && articleTitle) {
        logger.info(`Google News URL detected, searching for actual article...`);
        const searchedUrl = await this.articleSearcher.searchArticleByTitle(articleTitle, articleSource);
        if (searchedUrl) {
          actualUrl = searchedUrl;
          logger.info(`Found actual article via search: ${actualUrl}`);
        } else {
          // Fall back to resolver
          actualUrl = await this.articleResolver.resolveArticleUrl(articleUrl);
          if (actualUrl !== articleUrl) {
            logger.info(`Resolved to actual article: ${actualUrl}`);
          }
        }
      } else {
        // Try normal resolution for non-Google News URLs
        actualUrl = await this.articleResolver.resolveArticleUrl(articleUrl);
        if (actualUrl !== articleUrl) {
          logger.info(`Resolved to actual article: ${actualUrl}`);
        }
      }

      // Fetch the article HTML
      const response = await axios.get(actualUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        timeout: 15000,
        maxRedirects: 5,
        maxContentLength: 5000000, // 5MB limit for article pages
        maxBodyLength: 5000000
      });

      const $ = cheerio.load(response.data);
      const baseUrl = new URL(actualUrl);

      // Helper to check if an image URL should be excluded
      const isExcluded = (url) => excludeUrls.some(excluded => url === excluded || url.includes(excluded) || excluded.includes(url));

      // Try different strategies to find the main article image
      // When excludeUrls is provided, collect ALL candidates and return the first non-excluded one
      const candidates = [];

      // Strategy 1: Open Graph image (most reliable)
      const ogImage = this.getOpenGraphImage($, baseUrl);
      if (ogImage) candidates.push(ogImage);

      // Strategy 2: Twitter Card image
      const twitterImage = this.getTwitterCardImage($, baseUrl);
      if (twitterImage) candidates.push(twitterImage);

      // Strategy 3: Schema.org structured data
      const schemaImage = this.getSchemaOrgImage($, baseUrl);
      if (schemaImage) candidates.push(schemaImage);

      // Strategy 4: First large image in article content
      const articleImage = await this.getFirstArticleImage($, baseUrl);
      if (articleImage) candidates.push(articleImage);

      // Strategy 5: Main/article tag images
      const mainImage = this.getMainContentImage($, baseUrl);
      if (mainImage) candidates.push(mainImage);

      // Deduplicate and filter excluded URLs
      const seen = new Set();
      for (const candidate of candidates) {
        if (seen.has(candidate)) continue;
        seen.add(candidate);

        if (isExcluded(candidate)) {
          logger.debug(`Skipping excluded image: ${candidate}`);
          continue;
        }

        if (this.isValidImage(candidate)) {
          const isReachable = await this.validateImageUrl(candidate);
          if (isReachable) {
            logger.info(`Found valid and reachable${isAltSearch ? ' alternative' : ''} image: ${candidate}`);
            return candidate;
          }
          logger.warn(`Image URL passed pattern validation but is unreachable: ${candidate}`);
        }
      }

      logger.debug(`No suitable${isAltSearch ? ' alternative' : ''} image found in article`);
      return null;

    } catch (error) {
      logger.error(`Error extracting image from article: ${error.message}`);
      return null;
    }
  }

  /**
   * Extract an alternative image from the article, excluding previously tried URLs.
   * Used as a fallback when video generation content filters reject the original image.
   * @param {string} articleUrl - Article URL to extract from
   * @param {string} articleTitle - Article title for Google News resolution
   * @param {string} articleSource - Article source
   * @param {string|string[]} excludeUrls - Image URL(s) to exclude (already tried and rejected)
   * @returns {Promise<string|null>} Alternative image URL or null
   */
  async extractAlternativeImage(articleUrl, articleTitle, articleSource, excludeUrls) {
    const excluded = Array.isArray(excludeUrls) ? excludeUrls : [excludeUrls];
    logger.info(`Searching for alternative article image (excluding ${excluded.length} previously tried URL(s))...`);
    return this.extractImageFromArticle(articleUrl, articleTitle, articleSource, { excludeUrls: excluded });
  }

  /**
   * Extract image from an article with retry logic and optional fallback URLs.
   * Designed for platforms like Instagram that REQUIRE media.
   *
   * Strategy:
   *  1. If a preExistingImageUrl is provided (e.g. news API thumbnail), validate it first
   *  2. Try extractImageFromArticle on the primary URL with retries
   *  3. If that fails and fallbackUrls are provided, try each fallback URL once
   *  4. Return null only if all strategies are exhausted
   *
   * @param {Object} options
   * @param {string} options.articleUrl - Primary article URL to extract from
   * @param {string} [options.articleTitle] - Article title (helps with Google News resolution)
   * @param {string} [options.articleSource] - Article source name
   * @param {string} [options.preExistingImageUrl] - Image URL already known (e.g. from news API)
   * @param {string[]} [options.fallbackUrls] - Alternative article URLs to try if primary fails
   * @param {number} [options.maxRetries=2] - Number of retry attempts for the primary URL
   * @param {number} [options.retryDelayMs=3000] - Delay between retries in milliseconds
   * @returns {Promise<string|null>} Image URL or null if all strategies fail
   */
  async extractImageWithRetry({
    articleUrl,
    articleTitle = null,
    articleSource = null,
    preExistingImageUrl = null,
    fallbackUrls = [],
    maxRetries = 2,
    retryDelayMs = 3000
  } = {}) {
    // Step 1: If we already have an image URL (from news API), validate pattern + reachability
    if (preExistingImageUrl && this.isValidImage(preExistingImageUrl)) {
      const isReachable = await this.validateImageUrl(preExistingImageUrl);
      if (isReachable) {
        logger.info(`Pre-existing image URL is valid and reachable: ${preExistingImageUrl}`);
        return preExistingImageUrl;
      }
      logger.warn(`Pre-existing image URL is unreachable, will try extraction: ${preExistingImageUrl}`);
    }

    if (!articleUrl) {
      logger.warn('No article URL provided for image extraction');
      return null;
    }

    // Step 2: Try primary URL with retries
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        logger.info(`Image extraction attempt ${attempt}/${maxRetries + 1} for: ${articleUrl}`);
        const imageUrl = await this.extractImageFromArticle(articleUrl, articleTitle, articleSource);
        if (imageUrl) {
          logger.info(`Image found on attempt ${attempt}: ${imageUrl}`);
          return imageUrl;
        }
        logger.debug(`No image found on attempt ${attempt}`);
      } catch (error) {
        logger.warn(`Image extraction attempt ${attempt} failed: ${error.message}`);
      }

      // Delay before retry (but not after the last attempt)
      if (attempt <= maxRetries) {
        logger.debug(`Waiting ${retryDelayMs}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    }

    // Step 3: Try fallback URLs (one attempt each)
    for (const fallbackUrl of fallbackUrls) {
      if (!fallbackUrl || fallbackUrl === articleUrl) continue;
      try {
        logger.info(`Trying fallback URL for image: ${fallbackUrl}`);
        const imageUrl = await this.extractImageFromArticle(fallbackUrl, articleTitle, articleSource);
        if (imageUrl) {
          logger.info(`Image found from fallback URL: ${imageUrl}`);
          return imageUrl;
        }
      } catch (error) {
        logger.warn(`Fallback URL image extraction failed: ${error.message}`);
      }
    }

    logger.warn(`All image extraction strategies exhausted for: ${articleUrl}`);
    return null;
  }

  getOpenGraphImage($, baseUrl) {
    const ogImage = $('meta[property="og:image"]').attr('content') ||
                    $('meta[property="og:image:url"]').attr('content');
    if (ogImage) {
      return this.resolveUrl(ogImage, baseUrl);
    }
    return null;
  }

  getTwitterCardImage($, baseUrl) {
    const twitterImage = $('meta[name="twitter:image"]').attr('content') ||
                         $('meta[name="twitter:image:src"]').attr('content');
    if (twitterImage) {
      return this.resolveUrl(twitterImage, baseUrl);
    }
    return null;
  }

  getSchemaOrgImage($, baseUrl) {
    try {
      const scripts = $('script[type="application/ld+json"]');
      for (let i = 0; i < scripts.length; i++) {
        const scriptContent = $(scripts[i]).html();
        if (scriptContent) {
          const data = JSON.parse(scriptContent);
          if (data.image) {
            const imageUrl = Array.isArray(data.image) ? data.image[0] :
                           (typeof data.image === 'object' ? data.image.url : data.image);
            if (imageUrl) {
              return this.resolveUrl(imageUrl, baseUrl);
            }
          }
        }
      }
    } catch (error) {
      logger.debug('Error parsing schema.org data:', error.message);
    }
    return null;
  }

  async getFirstArticleImage($, baseUrl) {
    // Look for images in common article containers - expanded list
    const selectors = [
      'article img',
      'main img',
      '.post-content img',
      '.entry-content img',
      '.article-content img',
      '.article-body img',
      '.content img',
      '[role="main"] img',
      '.story-body img',
      '.body-content img',
      '.article__body img',
      '.article-text img',
      '.story-content img',
      '.post img',
      'section img',
      '.container img',
      'body img'  // Last resort - any image on the page
    ];

    for (const selector of selectors) {
      const images = $(selector);
      for (let i = 0; i < images.length; i++) {
        const img = $(images[i]);
        const src = img.attr('src') || img.attr('data-src') || img.attr('data-lazy-src') ||
                    img.attr('data-original') || img.attr('data-srcset');

        // Also check srcset for responsive images
        if (!src && img.attr('srcset')) {
          const srcset = img.attr('srcset');
          const firstSrc = srcset.split(',')[0].trim().split(' ')[0];
          if (firstSrc) {
            const imageUrl = this.resolveUrl(firstSrc, baseUrl);
            if (this.isValidImage(imageUrl) && await this.checkImageDimensions(img)) {
              logger.info(`Found image from srcset: ${imageUrl}`);
              return imageUrl;
            }
          }
        }

        if (src) {
          const imageUrl = this.resolveUrl(src, baseUrl);
          if (this.isValidImage(imageUrl) && await this.checkImageDimensions(img)) {
            logger.info(`Found article image: ${imageUrl}`);
            return imageUrl;
          }
        }
      }
    }
    return null;
  }

  getMainContentImage($, baseUrl) {
    // Look for featured images or hero images
    const selectors = [
      '.featured-image img',
      '.hero-image img',
      '.post-thumbnail img',
      '.wp-post-image',
      'figure img',
      '.lead-image img',
      '.article-hero img'
    ];

    for (const selector of selectors) {
      const img = $(selector).first();
      const src = img.attr('src') || img.attr('data-src');
      if (src) {
        const imageUrl = this.resolveUrl(src, baseUrl);
        if (this.isValidImage(imageUrl)) {
          return imageUrl;
        }
      }
    }
    return null;
  }

  resolveUrl(url, baseUrl) {
    if (!url) return null;

    try {
      // Handle protocol-relative URLs
      if (url.startsWith('//')) {
        return `https:${url}`;
      }

      // Handle absolute URLs
      if (url.startsWith('http://') || url.startsWith('https://')) {
        return url;
      }

      // Handle relative URLs
      return new URL(url, baseUrl).href;
    } catch (error) {
      logger.debug(`Error resolving URL: ${url}`, error.message);
      return null;
    }
  }

  isValidImage(imageUrl) {
    if (!imageUrl) return false;

    // Check if it's an ad or tracking pixel
    const isAd = this.adDomains.some(domain => imageUrl.includes(domain));
    if (isAd) {
      logger.debug(`Skipping ad/tracking image: ${imageUrl}`);
      return false;
    }

    // Check for common tracking pixel patterns
    if (imageUrl.includes('1x1') ||
        imageUrl.includes('pixel') ||
        imageUrl.includes('tracking') ||
        imageUrl.includes('beacon')) {
      logger.debug(`Skipping tracking pixel: ${imageUrl}`);
      return false;
    }

    // Check for valid image extensions
    const validExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg', '.bmp', '.tiff'];
    const hasValidExtension = validExtensions.some(ext =>
      imageUrl.toLowerCase().includes(ext)
    );

    // Be more permissive - accept any URL that might be an image
    // Many modern sites serve images without extensions
    const isImageUrl = hasValidExtension ||
                      imageUrl.includes('googleusercontent.com') ||  // Google-hosted images
                      imageUrl.includes('ggpht.com') ||  // Google Photos
                      imageUrl.includes('gstatic.com') ||  // Google static content
                      imageUrl.includes('/image') ||
                      imageUrl.includes('/img') ||
                      imageUrl.includes('/media') ||
                      imageUrl.includes('/uploads') ||
                      imageUrl.includes('/wp-content') ||
                      imageUrl.includes('/assets') ||
                      imageUrl.includes('/static') ||
                      imageUrl.includes('/public') ||
                      imageUrl.includes('imageserver') ||
                      imageUrl.includes('cloudinary') ||
                      imageUrl.includes('imgix') ||
                      imageUrl.includes('cdn') ||
                      imageUrl.includes('amazonaws') ||
                      imageUrl.includes('s3') ||
                      imageUrl.includes('storage') ||
                      imageUrl.includes('twimg.com') ||  // Twitter images
                      imageUrl.includes('fbcdn.net') ||  // Facebook CDN
                      imageUrl.includes('pinimg.com') ||  // Pinterest images
                      imageUrl.includes('unsplash.com') ||  // Unsplash images
                      imageUrl.includes('pexels.com');  // Pexels images

    if (!isImageUrl) {
      logger.debug(`URL doesn't appear to be an image: ${imageUrl}`);
    }

    return isImageUrl;
  }

  /**
   * Validate that an image URL is actually reachable via a lightweight HEAD request.
   * Catches expired, broken, or paywalled image URLs before they reach publishers.
   * @param {string} imageUrl - The image URL to validate
   * @param {number} timeoutMs - Request timeout in milliseconds
   * @returns {Promise<boolean>} true if the URL responds with 2xx/3xx status
   */
  async validateImageUrl(imageUrl, timeoutMs = 5000) {
    try {
      const response = await axios.head(imageUrl, {
        timeout: timeoutMs,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'image/*,*/*'
        },
        maxRedirects: 3,
        validateStatus: (status) => status < 400
      });
      return true;
    } catch (error) {
      // Some servers block HEAD requests — retry with a small-range GET as fallback
      try {
        const getResponse = await axios.get(imageUrl, {
          timeout: timeoutMs,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': 'image/*,*/*',
            'Range': 'bytes=0-1023'
          },
          maxRedirects: 3,
          responseType: 'arraybuffer',
          maxContentLength: 512000, // 512KB — servers often ignore Range header and return full image
          validateStatus: (status) => status < 400
        });
        return true;
      } catch (getError) {
        logger.debug(`Image URL validation failed for ${imageUrl}: ${getError.message}`);
        return false;
      }
    }
  }

  async checkImageDimensions(img) {
    // Check width/height attributes
    const width = parseInt(img.attr('width')) || 0;
    const height = parseInt(img.attr('height')) || 0;

    // If dimensions are specified and too small, skip
    if (width > 0 && height > 0 && (width < this.minWidth || height < this.minHeight)) {
      logger.debug(`Image too small: ${width}x${height}`);
      return false;
    }

    // Check CSS styles
    const style = img.attr('style');
    if (style) {
      const widthMatch = style.match(/width:\s*(\d+)px/);
      const heightMatch = style.match(/height:\s*(\d+)px/);

      const styleWidth = widthMatch ? parseInt(widthMatch[1]) : 0;
      const styleHeight = heightMatch ? parseInt(heightMatch[1]) : 0;

      // If style dimensions are specified and too small, skip
      if (styleWidth > 0 && styleHeight > 0 &&
          (styleWidth < this.minWidth || styleHeight < this.minHeight)) {
        logger.debug(`Image too small (style): ${styleWidth}x${styleHeight}`);
        return false;
      }
    }

    // If no dimensions found or dimensions are large enough, accept the image
    // Most article images don't have explicit dimensions in HTML
    return true;
  }
}

export default ImageExtractor;
