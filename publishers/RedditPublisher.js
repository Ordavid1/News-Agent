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
  constructor() {
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
    
    // Default to worldnews if no specific subreddit set
    this.subreddit = process.env.REDDIT_SUBREDDIT;
  }

  async getAccessToken() {
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
            'User-Agent': 'SocialMediaBot/1.0'
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

  async publishPost(content, mediaUrl = null) {
    try {
      const token = await this.getAccessToken();
      
      // Determine best subreddit based on content
      const targetSubreddit = this.subreddit || this.selectBestSubreddit(content);
      
      // Format content for Reddit news posting
      const formattedContent = this.formatForRedditNews(content);
      
      // Extract a news-style title
      const title = this.extractNewsTitle(formattedContent);
      
      // Reddit API endpoint for submitting posts
      const submitUrl = 'https://oauth.reddit.com/api/submit';
      
      const postData = {
        sr: targetSubreddit,
        kind: 'self', // Text post
        title: title,
        text: formattedContent,
        api_type: 'json',
        sendreplies: true, // Enable inbox replies for engagement
        nsfw: false,
        spoiler: false
      };
      
      logger.info(`Posting to r/${targetSubreddit} with title: ${title}`);
      
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
      const postUrl = `https://reddit.com/r/${this.subreddit}/comments/${postId}`;
      
      logger.info(`Successfully published to Reddit: ${postUrl}`);
      
      return {
        success: true,
        platform: 'reddit',
        postId: postId,
        url: postUrl
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
}

export default RedditPublisher;