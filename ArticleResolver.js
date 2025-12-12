// services/ArticleResolver.js
import axios from 'axios';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[ArticleResolver] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

class ArticleResolver {
  constructor() {
    this.maxRedirects = 5;
  }

  /**
   * Resolves a Google News RSS URL to the actual article URL
   * @param {string} url - The URL to resolve (could be Google News RSS or direct)
   * @returns {Promise<string>} - The actual article URL
   */
  async resolveArticleUrl(url) {
    try {
      // Check if it's a Google News RSS URL
      if (url.includes('news.google.com/rss/articles/')) {
        logger.info('Resolving Google News RSS URL to actual article...');
        
        // First, decode the Google News URL
        const decodedUrl = this.decodeGoogleNewsUrl(url);
        if (decodedUrl && !decodedUrl.includes('news.google.com')) {
          logger.info(`Decoded to: ${decodedUrl}`);
          return decodedUrl;
        }
        
        // If decoding didn't work, follow redirects
        return await this.followRedirects(url);
      }
      
      // If it's already a direct URL, return it
      return url;
      
    } catch (error) {
      logger.error(`Error resolving article URL: ${error.message}`);
      // Return original URL as fallback
      return url;
    }
  }

  /**
   * Decodes HTML entities in a URL
   * @param {string} str - The string with HTML entities
   * @returns {string} - The decoded string
   */
  decodeHtmlEntities(str) {
    if (!str) return str;
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&#x2F;/g, '/')
      .replace(/&#x5C;/g, '\\')
      .replace(/&#x3D;/g, '=');
  }

  /**
   * Attempts to decode a Google News URL
   * Google News URLs often contain the actual URL in base64 or encoded format
   */
  decodeGoogleNewsUrl(url) {
    try {
      // Extract the article ID from the URL
      const match = url.match(/articles\/([^?]+)/);
      if (!match) return null;
      
      const encodedPart = match[1];
      
      // Try base64 decoding (Google sometimes uses this)
      try {
        // Remove URL-safe base64 characters
        const base64 = encodedPart.replace(/-/g, '+').replace(/_/g, '/');
        const decoded = Buffer.from(base64, 'base64').toString('utf-8');
        
        // Look for URL patterns in decoded string
        const urlMatch = decoded.match(/https?:\/\/[^\s\0]+/);
        if (urlMatch) {
          return urlMatch[0];
        }
      } catch (e) {
        // Not base64 encoded
      }
      
      return null;
    } catch (error) {
      logger.debug('Could not decode Google News URL');
      return null;
    }
  }

  /**
   * Follows redirects to get the final URL
   * @param {string} url - The URL to follow
   * @returns {Promise<string>} - The final URL after redirects
   */
  async followRedirects(url) {
    try {
      logger.debug(`Following redirects for: ${url}`);
      
      // For Google News URLs, try a different approach
      if (url.includes('news.google.com/rss/articles/')) {
        // Try to extract the actual URL using a simpler method
        // Google News sometimes includes the actual URL in the response headers
        try {
          const response = await axios.get(url, {
            maxRedirects: 0, // Don't follow redirects automatically
            validateStatus: (status) => status < 400, // Accept redirect statuses
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)',
            }
          });
          
          // Check for Location header
          if (response.headers.location) {
            const locationUrl = response.headers.location;
            if (!locationUrl.includes('google.com')) {
              logger.info(`Found redirect URL in Location header: ${locationUrl}`);
              return locationUrl;
            }
          }
        } catch (err) {
          logger.debug('Direct redirect check failed');
        }
      }
      
      // First try a HEAD request to get redirects without downloading content
      try {
        const headResponse = await axios.head(url, {
          maxRedirects: this.maxRedirects,
          timeout: 5000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          }
        });
        
        const finalHeadUrl = headResponse.request.res?.responseUrl || headResponse.config.url;
        if (finalHeadUrl && finalHeadUrl !== url && !finalHeadUrl.includes('google.com')) {
          logger.info(`Resolved via HEAD to: ${finalHeadUrl}`);
          return finalHeadUrl;
        }
      } catch (headError) {
        logger.debug('HEAD request failed, trying GET');
      }
      
      // For Google News, we need to fetch the actual page content
      // But limit the content size and use a stream to avoid memory issues
      const getResponse = await axios.get(url, {
        maxRedirects: this.maxRedirects,
        timeout: 10000,
        maxContentLength: 2000000, // Increase to 2MB for better compatibility
        maxBodyLength: 2000000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml'
        },
        // Only get the first part of the response for redirect detection
        responseType: 'text',
        transformResponse: [(data) => {
          // Only process first 100KB for redirect detection
          if (data && data.length > 100000) {
            return data.substring(0, 100000);
          }
          return data;
        }]
      });
      
      const finalGetUrl = getResponse.request.res?.responseUrl || getResponse.config.url;
      
      if (finalGetUrl && finalGetUrl !== url && !finalGetUrl.includes('google.com')) {
        logger.info(`Resolved via GET to: ${finalGetUrl}`);
        return finalGetUrl;
      }
      
      // Check if the response contains a meta refresh or JavaScript redirect
      const redirectUrl = this.extractRedirectFromHtml(getResponse.data);
      if (redirectUrl) {
        logger.info(`Found redirect in HTML: ${redirectUrl}`);
        return redirectUrl;
      }
      
      return url;
      
    } catch (error) {
      if (error.response?.status === 301 || error.response?.status === 302) {
        const redirectUrl = error.response.headers.location;
        if (redirectUrl) {
          logger.info(`Found redirect in error response: ${redirectUrl}`);
          return redirectUrl;
        }
      }
      
      logger.error(`Error following redirects: ${error.message}`);
      return url;
    }
  }

  /**
   * Extracts redirect URL from HTML meta refresh or JavaScript
   * @param {string} html - The HTML content
   * @returns {string|null} - The redirect URL if found
   */
  extractRedirectFromHtml(html) {
    if (!html || typeof html !== 'string') return null;
    
    // Check for meta refresh
    const metaMatch = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["']\d+;\s*url=([^"']+)["']/i);
    if (metaMatch) {
      return metaMatch[1];
    }
    
    // Google News specific patterns
    // Pattern 1: Look for the article URL in a specific Google News format
    const googleNewsPattern = html.match(/data-n-au=["']([^"']+)["']/);
    if (googleNewsPattern) {
      const decodedUrl = this.decodeHtmlEntities(googleNewsPattern[1]);
      if (decodedUrl && !decodedUrl.includes('google.com')) {
        logger.debug(`Found Google News article URL: ${decodedUrl}`);
        return decodedUrl;
      }
    }
    
    // Pattern 2: Look for jsdata attribute that contains the actual URL
    const jsdataPattern = html.match(/jsdata="[^"]*;(https?:\/\/[^;"\s]+)/);
    if (jsdataPattern) {
      const cleanUrl = this.decodeHtmlEntities(jsdataPattern[1]);
      if (cleanUrl && !cleanUrl.includes('google.com')) {
        logger.debug(`Found URL in jsdata: ${cleanUrl}`);
        return cleanUrl;
      }
    }
    
    // Pattern 3: Look for any external links (not Google)
    const externalLinks = html.match(/href=["'](https?:\/\/(?!(?:www\.)?google\.com)[^"']+)["']/i);
    if (externalLinks) {
      const cleanUrl = this.decodeHtmlEntities(externalLinks[1]);
      // Make sure it's not a Google URL
      if (!cleanUrl.includes('google.com') && !cleanUrl.includes('gstatic.com')) {
        logger.debug(`Found external link: ${cleanUrl}`);
        return cleanUrl;
      }
    }
    
    // Pattern 2: Look for links to known news sites
    const newsLinks = html.match(/href=["'](https?:\/\/(?:www\.)?(?:techcrunch|theverge|wired|arstechnica|venturebeat|reuters|bloomberg|cnbc|forbes|wsj|nytimes|washingtonpost|bbc|cnn|engadget|thenextweb|zdnet|cnet|pcworld|computerworld|infoworld|networkworld|axios|politico|businessinsider|fortune|fastcompany|inc|entrepreneur|techradar|tomshardware|anandtech|theinformation|protocol|semafor|platformer|stratechery|vocal\.media|medium\.com|substack\.com)[^"']*)/i);
    if (newsLinks) {
      const cleanUrl = newsLinks[1].replace(/&amp;/g, '&');
      logger.debug(`Found news site link: ${cleanUrl}`);
      return cleanUrl;
    }
    
    // Pattern 2: Look for article links in data attributes or JavaScript
    const dataUrlMatch = html.match(/data-(?:url|href|link)=["']([^"']+techcrunch[^"']+)["']/i);
    if (dataUrlMatch) {
      const cleanUrl = dataUrlMatch[1].replace(/&amp;/g, '&');
      return cleanUrl;
    }
    
    // Pattern 3: Check for JavaScript redirects
    const jsMatch = html.match(/window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i);
    if (jsMatch) {
      return jsMatch[1];
    }
    
    // Pattern 4: Look for canonical URL
    const canonicalMatch = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
    if (canonicalMatch && !canonicalMatch[1].includes('google.com')) {
      return canonicalMatch[1];
    }
    
    // Pattern 5: Check for common redirect patterns
    const commonMatch = html.match(/(?:redirect|location|url)["']?\s*[:=]\s*["']?(https?:\/\/[^"'\s>]+)/i);
    if (commonMatch && !commonMatch[1].includes('google.com')) {
      return commonMatch[1];
    }
    
    // Pattern 6: Look for OpenGraph URL
    const ogUrlMatch = html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i);
    if (ogUrlMatch && !ogUrlMatch[1].includes('google.com')) {
      return ogUrlMatch[1];
    }
    
    return null;
  }
}

export default ArticleResolver;