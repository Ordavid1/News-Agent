// publishers/RedditPublisher.js
import axios from 'axios';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[RedditPublisher] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

class RedditPublisher {
  /**
   * Create a RedditPublisher instance
   * @param {Object} credentials - Optional credentials object for per-user publishing
   * @param {string} credentials.accessToken - OAuth 2.0 access token (from OAuth flow)
   * @param {string} credentials.refreshToken - OAuth 2.0 refresh token
   * @param {string} credentials.username - Reddit username
   * @param {Object} credentials.metadata - Platform metadata (may contain subreddit preferences)
   */
  constructor(credentials = null) {
    // News-focused subreddit configuration
    this.newsSubreddits = {
      general: ['worldnews', 'news', 'UpliftingNews'],
      tech: ['technology', 'technews', 'gadgets'],
      business: ['business', 'finance', 'Economics'],
      science: ['science', 'EverythingScience', 'sciences'],
      local: {
        US: ['news', 'USNews'],
        UK: ['ukpolitics', 'unitedkingdom'],
        IL: ['Israel', 'Israel_News']
      }
    };

    if (credentials) {
      // Per-user credentials mode (OAuth 2.0 token from user authorization)
      if (!credentials.accessToken) {
        logger.warn('Reddit credentials provided but accessToken missing');
        return;
      }

      this.accessToken = credentials.accessToken;
      this.refreshToken = credentials.refreshToken;
      this.username = credentials.username;
      this.subreddit = credentials.metadata?.defaultSubreddit || null;
      // Token expiry should be tracked externally by TokenManager
      this.tokenExpiry = Infinity; // Assume valid, TokenManager handles refresh

      // For OAuth 2.0 flow, we don't use client credentials directly
      // The token was obtained through the OAuth flow
      this.useOAuthToken = true;

      logger.debug('Reddit publisher initialized with user OAuth credentials');
    } else {
      // Legacy mode: use environment variables (password grant - deprecated by Reddit)
      if (!process.env.REDDIT_CLIENT_ID || !process.env.REDDIT_CLIENT_SECRET) {
        logger.warn('Reddit credentials not configured');
        return;
      }

      this.clientId = process.env.REDDIT_CLIENT_ID;
      this.clientSecret = process.env.REDDIT_CLIENT_SECRET;
      this.username = process.env.REDDIT_USERNAME;
      this.password = process.env.REDDIT_PASSWORD;
      this.subreddit = process.env.REDDIT_SUBREDDIT;
      this.accessToken = null;
      this.tokenExpiry = 0;
      this.useOAuthToken = false;

      logger.debug('Reddit publisher initialized with environment credentials');
    }
  }

  /**
   * Create a new RedditPublisher instance with user-specific credentials
   * @param {Object} credentials - User's OAuth credentials
   * @returns {RedditPublisher} New publisher instance
   */
  static withCredentials(credentials) {
    return new RedditPublisher(credentials);
  }

  async getAccessToken() {
    // For OAuth 2.0 user tokens, just return the existing token
    // Token refresh is handled externally by TokenManager
    if (this.useOAuthToken) {
      if (!this.accessToken) {
        throw new Error('Reddit OAuth token not available');
      }
      return this.accessToken;
    }

    // Legacy password grant flow (deprecated by Reddit but kept for backwards compatibility)
    // Check if we have a valid token
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    try {
      const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

      const response = await axios.post(
        'https://www.reddit.com/api/v1/access_token',
        `grant_type=password&username=${this.username}&password=${this.password}`,
        {
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'NewsAgentSaaS/1.0'
          }
        }
      );

      this.accessToken = response.data.access_token;
      // Token expires in 1 hour, refresh 5 minutes early
      this.tokenExpiry = Date.now() + ((response.data.expires_in - 300) * 1000);

      logger.info('Reddit access token obtained successfully');
      return this.accessToken;

    } catch (error) {
      logger.error('Failed to get Reddit access token:', error.message);
      throw error;
    }
  }

  /**
   * Fetch subreddit post requirements from Reddit API
   * @param {string} subreddit - The subreddit name (without r/)
   * @returns {Promise<Object>} Requirements object
   */
  async getSubredditRequirements(subreddit) {
    try {
      const token = await this.getAccessToken();

      const response = await axios.get(
        `https://oauth.reddit.com/api/v1/${subreddit}/post_requirements`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'NewsBot/1.0 (by /u/' + (this.username || 'unknown') + ')'
          }
        }
      );

      const data = response.data;

      return {
        flairRequired: data.is_flair_required || false,
        titleMinLength: data.title_text_min_length || 0,
        titleMaxLength: data.title_text_max_length || 300,
        bodyMinLength: data.body_text_min_length || 0,
        bodyMaxLength: data.body_text_max_length || 40000,
        bodyRestriction: data.body_restriction_policy || 'none', // required, notAllowed, none
        linkRestriction: data.link_restriction_policy || 'none',
        titleBlacklist: data.title_blacklisted_strings || [],
        titleRequired: data.title_required_strings || [],
        domainBlacklist: data.domain_blacklist || [],
        domainWhitelist: data.domain_whitelist || [],
        guidelines: data.guidelines_text || ''
      };

    } catch (error) {
      logger.error(`Failed to fetch requirements for r/${subreddit}:`, error.message);

      // Handle specific error cases
      if (error.response?.status === 404) {
        throw new Error(`Subreddit r/${subreddit} not found`);
      }
      if (error.response?.status === 403) {
        throw new Error(`Cannot access r/${subreddit} (private or restricted)`);
      }

      throw error;
    }
  }

  /**
   * Fetch available link flairs for a subreddit
   * @param {string} subreddit - The subreddit name (without r/)
   * @returns {Promise<Array>} Array of flair objects
   */
  async getSubredditFlairs(subreddit) {
    try {
      const token = await this.getAccessToken();

      const response = await axios.get(
        `https://oauth.reddit.com/r/${subreddit}/api/link_flair_v2`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'NewsBot/1.0 (by /u/' + (this.username || 'unknown') + ')'
          }
        }
      );

      // Map to a cleaner format
      const flairs = (response.data || []).map(flair => ({
        id: flair.id,
        text: flair.text || '',
        textEditable: flair.text_editable || false,
        backgroundColor: flair.background_color || '',
        textColor: flair.text_color || 'dark',
        modOnly: flair.mod_only || false,
        cssClass: flair.css_class || ''
      }));

      // Filter out mod-only flairs that users can't use
      return flairs.filter(f => !f.modOnly);

    } catch (error) {
      logger.error(`Failed to fetch flairs for r/${subreddit}: ${error.message} (status: ${error.response?.status || 'N/A'})`);

      // If we can't fetch flairs, return empty array (some subreddits don't allow it)
      // Many subreddits restrict flair listing to approved users or don't have flairs
      if (error.response?.status === 403 || error.response?.status === 404 || error.response?.status === 401) {
        logger.debug(`Flair fetch returned ${error.response?.status} for r/${subreddit}, returning empty array`);
        return [];
      }

      // For other errors, also return empty array rather than failing entirely
      logger.warn(`Unexpected error fetching flairs, continuing without flairs`);
      return [];
    }
  }

  /**
   * Fetch combined subreddit info (requirements + flairs)
   * @param {string} subreddit - The subreddit name (without r/)
   * @returns {Promise<Object>} Combined requirements and flairs
   */
  async getSubredditInfo(subreddit) {
    try {
      // Fetch requirements and flairs in parallel
      const [requirements, flairs] = await Promise.all([
        this.getSubredditRequirements(subreddit),
        this.getSubredditFlairs(subreddit)
      ]);

      return {
        subreddit,
        requirements: {
          ...requirements,
          flairs: flairs
        }
      };

    } catch (error) {
      logger.error(`Failed to fetch info for r/${subreddit}:`, error.message);
      throw error;
    }
  }

  /**
   * Publish a post to Reddit
   * @param {string} content - The content to post
   * @param {string|null} mediaUrl - Optional media URL (not used for text posts)
   * @param {string|null} targetSubreddit - Override subreddit to post to
   * @param {string|null} flairId - Optional flair ID to apply to the post
   * @returns {Promise<Object>} Result object with success status
   */
  async publishPost(content, mediaUrl = null, targetSubreddit = null, flairId = null) {
    try {
      const token = await this.getAccessToken();

      // Determine target subreddit: parameter > instance config > auto-select
      const subredditToUse = targetSubreddit || this.subreddit || this.selectBestSubreddit(content);

      // Format content for Reddit news posting
      const formattedContent = this.formatForRedditNews(content);
      
      // Extract a news-style title
      const title = this.extractNewsTitle(formattedContent);
      
      // Reddit API endpoint for submitting posts
      const submitUrl = 'https://oauth.reddit.com/api/submit';
      
      // Determine if this is an image post or text post
      const isImagePost = mediaUrl && this.isImageUrl(mediaUrl);

      let postData;

      if (isImagePost) {
        // For image posts, we use kind: 'link' with the image URL
        // Reddit will automatically create an image post if the URL points to an image
        logger.debug(`Creating image post with URL: ${mediaUrl}`);
        postData = {
          sr: subredditToUse,
          kind: 'link', // Link post (Reddit treats image URLs as image posts)
          title: title,
          url: mediaUrl, // The image URL becomes the post content
          api_type: 'json',
          sendreplies: true,
          nsfw: false,
          spoiler: false
        };
      } else {
        // Text post (self post)
        postData = {
          sr: subredditToUse,
          kind: 'self',
          title: title,
          text: formattedContent,
          api_type: 'json',
          sendreplies: true,
          nsfw: false,
          spoiler: false
        };
      }

      // Add flair if provided (required by some subreddits)
      if (flairId) {
        postData.flair_id = flairId;
        logger.debug(`Applying flair ID: ${flairId}`);
      }

      logger.info(`Posting to r/${subredditToUse} with title: ${title}`);
      
      const response = await axios.post(submitUrl, new URLSearchParams(postData), {
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'NewsBot/1.0 (by /u/' + this.username + ')',
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });
      
      if (response.data.json?.errors?.length > 0) {
        const errors = response.data.json.errors.map(e => e[1]).join(', ');
        throw new Error(`Reddit API errors: ${errors}`);
      }

      const postId = response.data.json?.data?.id;
      const postUrl = `https://reddit.com/r/${subredditToUse}/comments/${postId}`;

      logger.info(`Successfully published to Reddit: ${postUrl}`);

      return {
        success: true,
        platform: 'reddit',
        postId: postId,
        url: postUrl,
        subreddit: subredditToUse
      };
      
    } catch (error) {
      logger.error('Reddit publishing error:', error);
      throw error;
    }
  }

    selectBestSubreddit(content) {
    const contentLower = content.toLowerCase();
    
    // Check for tech keywords
    if (this.containsKeywords(contentLower, ['technology', 'ai', 'software', 'startup', 'app', 'digital'])) {
      return 'technology';
    }
    
    // Check for business keywords
    if (this.containsKeywords(contentLower, ['business', 'economy', 'market', 'company', 'ceo'])) {
      return 'business';
    }
    
    // Check for science keywords
    if (this.containsKeywords(contentLower, ['research', 'study', 'scientist', 'discovery'])) {
      return 'science';
    }
    
    // Check for location-specific content
    if (contentLower.includes('israel') || contentLower.includes('tel aviv')) {
      return 'Israel_News';
    }
    
    // Default to worldnews for general news
    return 'worldnews';
  }

  containsKeywords(text, keywords) {
    return keywords.some(keyword => text.includes(keyword));
  }

  formatForRedditNews(content) {
    // Remove HTML tags but keep line breaks
    let formatted = content
      .replace(/<br\s*\/?>/gi, '\n\n')
      .replace(/<[^>]*>/g, '')
      .trim();
    
    // Remove news emojis for cleaner Reddit posts
    formatted = formatted.replace(/[🚨📰🔴⚡📢🌍🔍]/g, '').trim();
    
    // Convert hashtags to subreddit references
    formatted = formatted.replace(/#(\w+)/g, (match, tag) => {
      // Convert news hashtags to relevant subreddit mentions
      const subredditMap = {
        'breakingnews': '/r/worldnews',
        'technews': '/r/technology',
        'businessnews': '/r/business',
        'sciencenews': '/r/science'
      };
      
      const lower = tag.toLowerCase();
      return subredditMap[lower] || match;
    });
    
    // Add source attribution if URL is present
    const urlMatch = formatted.match(/https?:\/\/\S+/);
    if (urlMatch) {
      formatted = formatted.replace(urlMatch[0], `\n\n**Source:** ${urlMatch[0]}`);
    }
    
    return formatted;
  }

    extractNewsTitle(content) {
    // Try to extract the first substantial line as title
    const lines = content.split('\n').filter(line => line.trim().length > 0);
    
    for (const line of lines) {
      const cleanLine = line.replace(/[🚨📰🔴⚡📢🌍🔍]/g, '').trim();
      
      // Skip if it's just "BREAKING:" or similar
      if (cleanLine.length < 10) continue;
      
      // Remove "BREAKING:" prefix if present
      let title = cleanLine.replace(/^(BREAKING|UPDATE|DEVELOPING|NEWS):?\s*/i, '');
      
      // Ensure title is within Reddit's 300 character limit
      if (title.length > 297) {
        title = title.substring(0, 294) + '...';
      }
      
      return title;
    }
    
    // Fallback: use first 100 chars of content
    const fallback = content.replace(/[^\w\s]/g, ' ').trim();
    return fallback.substring(0, 97) + '...';
  }
  
  formatForReddit(content) {
    // Remove HTML tags but keep line breaks
    let formatted = content
      .replace(/<br\s*\/?>/gi, '\n\n')
      .replace(/<[^>]*>/g, '')
      .trim();
    
    // Convert hashtags to subreddit-friendly format
    formatted = formatted.replace(/#(\w+)/g, '/r/$1');
    
    // Ensure proper Reddit formatting
    // Add > for quotes if needed
    formatted = formatted.replace(/^"(.+)"$/gm, '> $1');
    
    return formatted;
  }
  
  extractTitle(content) {
    // Try to extract a good title from the content
    const lines = content.split('\n').filter(line => line.trim());

    // Use first substantial line as title (skip emojis-only lines)
    for (const line of lines) {
      const cleanLine = line.replace(/[🚨📢🌍🤔💡✨🔍🎯📊]/g, '').trim();
      if (cleanLine.length > 10) {
        // Limit to Reddit's title length (300 chars)
        return cleanLine.substring(0, 297) + (cleanLine.length > 297 ? '...' : '');
      }
    }

    // Fallback: use first 100 chars
    return content.substring(0, 97) + '...';
  }

  /**
   * Check if URL points to an image
   * @param {string} url - The media URL
   * @returns {boolean} True if it's an image URL
   */
  isImageUrl(url) {
    if (!url) return false;
    const lowerUrl = url.toLowerCase();

    // Check for image extensions
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    if (imageExtensions.some(ext => lowerUrl.includes(ext))) {
      return true;
    }

    // Check for known image hosting services
    if (lowerUrl.includes('imgur.com') ||
        lowerUrl.includes('i.redd.it') ||
        lowerUrl.includes('preview.redd.it') ||
        lowerUrl.includes('unsplash.com') ||
        lowerUrl.includes('googleusercontent.com') ||
        lowerUrl.includes('twimg.com') ||
        lowerUrl.includes('fbcdn.net') ||
        lowerUrl.includes('pinimg.com') ||
        lowerUrl.includes('pexels.com') ||
        lowerUrl.includes('cloudinary.com') ||
        lowerUrl.includes('imgix.net') ||
        lowerUrl.includes('/image') ||
        lowerUrl.includes('/img') ||
        lowerUrl.includes('/photo')) {
      return true;
    }

    // Check for video extensions (return false)
    const videoExtensions = ['.mp4', '.mov', '.avi', '.webm', '.flv'];
    if (videoExtensions.some(ext => lowerUrl.includes(ext))) {
      return false;
    }

    // Default: assume image if it has common image URL patterns
    return /\.(jpg|jpeg|png|gif|webp)/i.test(lowerUrl);
  }
}

export default RedditPublisher;