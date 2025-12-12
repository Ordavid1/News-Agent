// services/ArticleSearcher.js
import axios from 'axios';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[ArticleSearcher] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

class ArticleSearcher {
  constructor() {
    // Known news domains to prioritize
    this.newsDomains = [
      'engadget.com',
      'techcrunch.com',
      'theverge.com',
      'wired.com',
      'arstechnica.com',
      'venturebeat.com',
      'reuters.com',
      'bloomberg.com',
      'cnbc.com',
      'forbes.com',
      'wsj.com',
      'nytimes.com',
      'washingtonpost.com',
      'bbc.com',
      'cnn.com',
      'thenextweb.com',
      'zdnet.com',
      'cnet.com',
      'axios.com',
      'politico.com',
      'businessinsider.com',
      'fortune.com',
      'fastcompany.com',
      'inc.com',
      'entrepreneur.com',
      'techradar.com',
      'tomshardware.com',
      'anandtech.com',
      'theinformation.com',
      'protocol.com',
      'semafor.com',
      'platformer.news',
      'stratechery.com',
      'vocal.media',
      'medium.com',
      'substack.com',
      'lemonde.fr',
      'ainvest.com'
    ];
  }

  /**
   * Search for the actual article URL using the title and source
   * @param {string} title - The article title
   * @param {string} source - The source publication
   * @returns {Promise<string|null>} - The actual article URL or null
   */
  async searchArticleByTitle(title, source) {
    try {
      logger.info(`Searching for article: "${title}" from ${source}`);
      
      // Clean the title for searching
      const cleanTitle = this.cleanTitle(title);
      
      // Try to find the domain from the source
      const domain = this.findDomainFromSource(source);
      
      if (domain) {
        // Try a direct search on the publication's domain
        const directUrl = await this.searchOnDomain(cleanTitle, domain);
        if (directUrl) {
          logger.info(`Found article on ${domain}: ${directUrl}`);
          return directUrl;
        }
      }
      
      // If no direct match, try a web search
      const searchUrl = await this.performWebSearch(cleanTitle, source);
      if (searchUrl) {
        logger.info(`Found article via web search: ${searchUrl}`);
        return searchUrl;
      }
      
      logger.warn(`Could not find actual article URL for: ${title}`);
      return null;
      
    } catch (error) {
      logger.error(`Error searching for article: ${error.message}`);
      return null;
    }
  }

  /**
   * Clean the title for searching
   */
  cleanTitle(title) {
    // Remove source suffix (e.g., " - TechCrunch")
    const cleanedTitle = title.replace(/\s*[-–—]\s*[^-–—]+$/, '').trim();
    return cleanedTitle;
  }

  /**
   * Find the domain from the source name
   */
  findDomainFromSource(source) {
    if (!source) return null;
    
    const sourceLower = source.toLowerCase().replace(/\s+/g, '');
    
    // Direct mappings
    const domainMappings = {
      'engadget': 'engadget.com',
      'techcrunch': 'techcrunch.com',
      'theverge': 'theverge.com',
      'wired': 'wired.com',
      'arstechnica': 'arstechnica.com',
      'venturebeat': 'venturebeat.com',
      'reuters': 'reuters.com',
      'bloomberg': 'bloomberg.com',
      'cnbc': 'cnbc.com',
      'forbes': 'forbes.com',
      'wsj': 'wsj.com',
      'wallstreetjournal': 'wsj.com',
      'newyorktimes': 'nytimes.com',
      'nytimes': 'nytimes.com',
      'washingtonpost': 'washingtonpost.com',
      'bbc': 'bbc.com',
      'cnn': 'cnn.com',
      'thenextweb': 'thenextweb.com',
      'zdnet': 'zdnet.com',
      'cnet': 'cnet.com',
      'axios': 'axios.com',
      'politico': 'politico.com',
      'businessinsider': 'businessinsider.com',
      'fortune': 'fortune.com',
      'fastcompany': 'fastcompany.com',
      'inc': 'inc.com',
      'entrepreneur': 'entrepreneur.com',
      'techradar': 'techradar.com',
      'tomshardware': 'tomshardware.com',
      'anandtech': 'anandtech.com',
      'theinformation': 'theinformation.com',
      'protocol': 'protocol.com',
      'semafor': 'semafor.com',
      'platformer': 'platformer.news',
      'stratechery': 'stratechery.com',
      'vocal': 'vocal.media',
      'vocalmedia': 'vocal.media',
      'medium': 'medium.com',
      'substack': 'substack.com',
      'lemonde': 'lemonde.fr',
      'lemondefr': 'lemonde.fr',
      'ainvest': 'ainvest.com'
    };
    
    // Check for exact match
    for (const [key, domain] of Object.entries(domainMappings)) {
      if (sourceLower.includes(key)) {
        return domain;
      }
    }
    
    return null;
  }

  /**
   * Search for article on a specific domain
   */
  async searchOnDomain(title, domain) {
    try {
      // Try to construct a search URL for the domain
      const searchQuery = encodeURIComponent(title);
      
      // Try common search patterns
      const searchPatterns = [
        `https://${domain}/search?q=${searchQuery}`,
        `https://${domain}/search/${searchQuery}`,
        `https://${domain}/?s=${searchQuery}`,
        `https://www.${domain}/search?q=${searchQuery}`,
        `https://www.${domain}/?s=${searchQuery}`
      ];
      
      for (const searchUrl of searchPatterns) {
        try {
          const response = await axios.get(searchUrl, {
            timeout: 5000,
            maxRedirects: 3,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
          });
          
          // Look for article links in the response
          const articleUrl = this.extractArticleUrl(response.data, title, domain);
          if (articleUrl) {
            return articleUrl;
          }
        } catch (error) {
          // Continue to next pattern
        }
      }
      
      return null;
    } catch (error) {
      logger.debug(`Error searching on domain ${domain}: ${error.message}`);
      return null;
    }
  }

  /**
   * Extract article URL from search results HTML
   */
  extractArticleUrl(html, title, domain) {
    if (!html) return null;
    
    // Create a regex to find links that might contain the article
    const titleWords = title.toLowerCase().split(/\s+/).slice(0, 5); // Use first 5 words
    
    // Look for links that contain most of the title words
    const linkRegex = new RegExp(`href=["']([^"']*${domain}[^"']+)["']`, 'gi');
    let match;
    const candidates = [];
    
    while ((match = linkRegex.exec(html)) !== null) {
      const url = match[1];
      // Count how many title words appear in the URL
      const matchCount = titleWords.filter(word => 
        url.toLowerCase().includes(word.toLowerCase())
      ).length;
      
      if (matchCount >= 3) { // At least 3 words from title
        candidates.push({ url, matchCount });
      }
    }
    
    // Return the best matching URL
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.matchCount - a.matchCount);
      return candidates[0].url.startsWith('http') ? 
        candidates[0].url : 
        `https://${domain}${candidates[0].url}`;
    }
    
    return null;
  }

  /**
   * Perform a web search for the article
   */
  async performWebSearch(title, source) {
    try {
      // Use DuckDuckGo HTML version (doesn't require API key)
      const searchQuery = source ? 
        `${title} site:${this.findDomainFromSource(source) || ''}` : 
        title;
      
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;
      
      const response = await axios.get(searchUrl, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      // Extract the first relevant result
      const resultRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"/i;
      const match = response.data.match(resultRegex);
      
      if (match && match[1]) {
        // DuckDuckGo URLs are often encoded, decode them
        const url = decodeURIComponent(match[1]);
        // Extract the actual URL from DuckDuckGo's redirect
        const actualUrlMatch = url.match(/uddg=([^&]+)/);
        if (actualUrlMatch) {
          return decodeURIComponent(actualUrlMatch[1]);
        }
        return url;
      }
      
      return null;
    } catch (error) {
      logger.debug(`Web search failed: ${error.message}`);
      return null;
    }
  }
}

export default ArticleSearcher;