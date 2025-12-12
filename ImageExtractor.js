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

  async extractImageFromArticle(articleUrl, articleTitle = null, articleSource = null) {
    try {
      logger.info(`Extracting image from: ${articleUrl}`);
      
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
      
      // Try different strategies to find the main article image
      let imageUrl = null;

      // Strategy 1: Open Graph image (most reliable)
      imageUrl = this.getOpenGraphImage($, baseUrl);
      
      // Strategy 2: Twitter Card image
      if (!imageUrl) {
        imageUrl = this.getTwitterCardImage($, baseUrl);
      }
      
      // Strategy 3: Schema.org structured data
      if (!imageUrl) {
        imageUrl = this.getSchemaOrgImage($, baseUrl);
      }
      
      // Strategy 4: First large image in article content
      if (!imageUrl) {
        imageUrl = await this.getFirstArticleImage($, baseUrl);
      }
      
      // Strategy 5: Main/article tag images
      if (!imageUrl) {
        imageUrl = this.getMainContentImage($, baseUrl);
      }

      if (imageUrl && this.isValidImage(imageUrl)) {
        logger.info(`Found valid image: ${imageUrl}`);
        return imageUrl;
      }
      
      logger.debug('No suitable image found in article');
      return null;
      
    } catch (error) {
      logger.error(`Error extracting image from article: ${error.message}`);
      return null;
    }
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
    
    // Don't skip logos/icons anymore - we want ANY image from the article
    // Users specifically want the first image, whatever it is
    
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