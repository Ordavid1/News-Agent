// services/ContentGenerator.js
import OpenAI from 'openai';
import axios from 'axios';
import { extract } from '@extractus/article-extractor';
import winston from 'winston';
import ArticleResolver from './ArticleResolver.js';

// Import platform-specific prompts
import { getLinkedInSystemPrompt, getLinkedInUserPrompt } from '../public/components/linkedInPrompts.mjs';
import { getGeneralLinkedInSystemPrompt, getGeneralLinkedInUserPrompt } from '../public/components/generalLinkedInPrompts.mjs';
import { getTwitterStandardSystemPrompt, getTwitterStandardUserPrompt, getTwitterPremiumSystemPrompt, getTwitterPremiumUserPrompt } from '../public/components/twitterPrompts.mjs';
import { getFacebookSystemPrompt, getFacebookUserPrompt } from '../public/components/facebookPrompts.mjs';
import { getRedditSystemPrompt, getRedditUserPrompt } from '../public/components/redditPrompts.mjs';
import { getTelegramSystemPrompt, getTelegramUserPrompt } from '../public/components/telegramPrompts.mjs';
import { getInstagramSystemPrompt, getInstagramUserPrompt } from '../public/components/instagramPrompts.mjs';
import { getThreadsSystemPrompt, getThreadsUserPrompt } from '../public/components/threadsPrompts.mjs';
import { getWhatsAppSystemPrompt, getWhatsAppUserPrompt } from '../public/components/whatsappPrompts.mjs';
import { getTikTokSystemPrompt, getTikTokUserPrompt } from '../public/components/tiktokPrompts.mjs';
import { getYouTubeSystemPrompt, getYouTubeUserPrompt } from '../public/components/youtubePrompts.mjs';
import { getVideoPromptSystemPrompt, getVideoPromptUserPrompt, getVideoRephraseSystemPrompt, getVideoRephraseUserPrompt } from '../public/components/videoPrompts.mjs';
import {
  getAffiliateWhatsAppSystemPrompt, getAffiliateWhatsAppUserPrompt,
  getAffiliateTelegramSystemPrompt, getAffiliateTelegramUserPrompt,
  getAffiliateTwitterSystemPrompt, getAffiliateTwitterUserPrompt,
  getAffiliateLinkedInSystemPrompt, getAffiliateLinkedInUserPrompt,
  getAffiliateFacebookSystemPrompt, getAffiliateFacebookUserPrompt,
  getAffiliateRedditSystemPrompt, getAffiliateRedditUserPrompt,
  getAffiliateInstagramSystemPrompt, getAffiliateInstagramUserPrompt,
  getAffiliateThreadsSystemPrompt, getAffiliateThreadsUserPrompt
} from '../public/components/affiliateProductPrompts.mjs';

// Platform-to-prompt map for affiliate content generation
const AFFILIATE_PROMPT_MAP = {
  whatsapp:  { system: getAffiliateWhatsAppSystemPrompt,  user: getAffiliateWhatsAppUserPrompt },
  telegram:  { system: getAffiliateTelegramSystemPrompt,  user: getAffiliateTelegramUserPrompt },
  twitter:   { system: getAffiliateTwitterSystemPrompt,   user: getAffiliateTwitterUserPrompt },
  linkedin:  { system: getAffiliateLinkedInSystemPrompt,  user: getAffiliateLinkedInUserPrompt },
  facebook:  { system: getAffiliateFacebookSystemPrompt,  user: getAffiliateFacebookUserPrompt },
  reddit:    { system: getAffiliateRedditSystemPrompt,    user: getAffiliateRedditUserPrompt },
  instagram: { system: getAffiliateInstagramSystemPrompt, user: getAffiliateInstagramUserPrompt },
  threads:   { system: getAffiliateThreadsSystemPrompt,   user: getAffiliateThreadsUserPrompt },
};

// Legacy import for fallback
import { getSystemPrompt, getUserPrompt } from '../public/components/socialMediaPrompts.mjs';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[ContentGenerator] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

class ContentGenerator {
  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey && apiKey !== 'sk-test-key') {
      this.openai = new OpenAI({ apiKey });
    } else {
      logger.warn('OpenAI API key not configured or using test key - using mock generation');
      this.openai = null;
    }
    this.platformPrompts = {
      twitter: this.getTwitterPrompt,
      linkedin: this.getLinkedInPrompt,
      reddit: this.getRedditPrompt,
      facebook: this.getFacebookPrompt,
      instagram: this.getInstagramPrompt,
      telegram: this.getTelegramPrompt,
      threads: this.getThreadsPrompt,
      whatsapp: this.getWhatsAppPrompt,
      tiktok: this.getTikTokPrompt,
      youtube: this.getYouTubePrompt
    };
  }

  /**
   * Generate content for a specific platform
   * @param {Object} trend - The article/trend to create content about
   * @param {string} platform - Target platform (twitter, linkedin, facebook, reddit, telegram, instagram)
   * @param {Object} agentSettings - User's agent settings (topics, keywords, tone, platformSettings)
   * @returns {Object} Generated content with text, platform, trend, source, generatedAt
   */
  async generateContent(trend, platform, agentSettings = {}) {
    try {
      logger.info(`Generating ${platform} content for trend: ${trend.title}`);
      logger.debug(`Article details - URL: ${trend.url}, Source: ${trend.source}, Published: ${trend.publishedAt}`);

      // Build article object for prompts
      const article = {
        title: trend.title,
        description: trend.description || trend.summary || '',
        summary: trend.summary || trend.description || '',
        url: trend.url,
        publishedAt: trend.publishedAt,
        source: trend.source
      };

      let systemPrompt, userPrompt;

      // Platform-specific prompt selection with agentSettings
      if (platform === 'twitter') {
        // Check if user has Twitter Premium
        const isPremium = agentSettings?.platformSettings?.twitter?.isPremium || false;

        if (isPremium) {
          systemPrompt = getTwitterPremiumSystemPrompt(agentSettings);
          userPrompt = getTwitterPremiumUserPrompt(article, agentSettings);
          logger.info('Using Twitter Premium prompts (4000 chars)');
        } else {
          systemPrompt = getTwitterStandardSystemPrompt(agentSettings);
          userPrompt = getTwitterStandardUserPrompt(article, agentSettings);
          logger.info('Using Twitter Standard prompts (280 chars)');
        }

      } else if (platform === 'linkedin') {
        // Use LinkedIn prompts with agentSettings
        systemPrompt = getLinkedInSystemPrompt(agentSettings);
        userPrompt = getLinkedInUserPrompt(article, agentSettings);

      } else if (platform === 'facebook') {
        // Use Facebook-specific prompts
        systemPrompt = getFacebookSystemPrompt(agentSettings);
        userPrompt = getFacebookUserPrompt(article, agentSettings);

      } else if (platform === 'reddit') {
        // Use Reddit-specific prompts (community-appropriate, no emojis)
        systemPrompt = getRedditSystemPrompt(agentSettings);
        userPrompt = getRedditUserPrompt(article, agentSettings);

      } else if (platform === 'telegram') {
        // Use Telegram-specific prompts (HTML formatting)
        systemPrompt = getTelegramSystemPrompt(agentSettings);
        userPrompt = getTelegramUserPrompt(article, agentSettings);

      } else if (platform === 'instagram') {
        // Use Instagram-specific prompts (visual-first, caption-focused)
        systemPrompt = getInstagramSystemPrompt(agentSettings);
        userPrompt = getInstagramUserPrompt(article, agentSettings);

      } else if (platform === 'threads') {
        // Use Threads-specific prompts (conversational, text-first)
        systemPrompt = getThreadsSystemPrompt(agentSettings);
        userPrompt = getThreadsUserPrompt(article, agentSettings);

      } else if (platform === 'whatsapp') {
        // Use WhatsApp-specific prompts (mobile-first, WhatsApp formatting)
        systemPrompt = getWhatsAppSystemPrompt(agentSettings);
        userPrompt = getWhatsAppUserPrompt(article, agentSettings);

      } else if (platform === 'tiktok') {
        // Use TikTok-specific prompts (short-form video captions, viral hooks)
        systemPrompt = getTikTokSystemPrompt(agentSettings);
        userPrompt = getTikTokUserPrompt(article, agentSettings);

      } else if (platform === 'youtube') {
        // Use YouTube Shorts-specific prompts (clickable title + short description)
        systemPrompt = getYouTubeSystemPrompt(agentSettings);
        userPrompt = getYouTubeUserPrompt(article, agentSettings);

      } else {
        // Fallback for unsupported platforms
        throw new Error(`Unsupported platform: ${platform}`);
      }
      
      const config = {
        model: 'gpt-5-nano',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
      };
      
      let content;
      
      if (this.openai) {
        const completion = await this.openai.chat.completions.create(config);
        content = completion.choices[0].message.content;
      } else {
        // Mock content generation for testing
        content = this.generateMockContent(trend, platform, tone);
      }
      
      logger.info(`Successfully generated ${platform} content`);
      
      return {
        text: content,
        platform,
        trend: trend.title,
        source: trend.url,
        generatedAt: new Date().toISOString()
      };
      
    } catch (error) {
      logger.error(`Failed to generate content for ${platform}:`, error);
      throw error;
    }
  }

  /**
   * Generate content for an affiliate product on any supported platform
   * @param {Object} product - Normalized product object from AffiliateProductFetcher
   * @param {string} platform - Target platform (whatsapp, telegram, twitter, linkedin, facebook, reddit, instagram, threads)
   * @param {Object} agentSettings - User's agent settings
   * @returns {Object} { text, platform, product, generatedAt }
   */
  async generateAffiliateContent(product, platform, agentSettings = {}) {
    try {
      const promptFns = AFFILIATE_PROMPT_MAP[platform];
      if (!promptFns) {
        throw new Error(`Affiliate content generation not supported for platform: ${platform}`);
      }

      const systemPrompt = promptFns.system(agentSettings);
      const userPrompt = promptFns.user(product, agentSettings);

      const config = {
        model: 'gpt-5-nano',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
      };

      let content;

      if (this.openai) {
        const completion = await this.openai.chat.completions.create(config);
        content = completion.choices[0].message.content;
      } else {
        // Mock content for testing
        content = `🛒 *${product.title}*\n\n💰 ~$${product.originalPrice}~ → *$${product.salePrice}* (${product.discount}% OFF!)\n⭐ ${product.rating}/5 (${product.totalOrders}+ orders)\n\nGreat deal on this product!\n\n🔗 ${product.affiliateUrl}`;
      }

      logger.info(`Successfully generated ${platform} affiliate content for product ${product.productId}`);

      return {
        text: content,
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

    } catch (error) {
      logger.error(`Failed to generate affiliate content for ${platform}:`, error);
      throw error;
    }
  }

  getSystemPromptForPlatform(platform, tone) {
    const toneDescriptions = {
      professional: 'professional, authoritative, and insightful',
      casual: 'friendly, conversational, and engaging',
      humorous: 'witty, entertaining, and light-hearted',
      educational: 'informative, clear, and educational'
    };
    
    const platformStyles = {
      twitter: 'concise, punchy, and engaging with relevant hashtags',
      linkedin: 'professional, detailed, and business-focused',
      reddit: 'community-oriented, authentic, and discussion-provoking',
      facebook: 'friendly, shareable, and relatable',
      instagram: 'visual-focused, trendy, and hashtag-rich',
      telegram: 'news-focused, informative, and HTML-formatted for channels',
      threads: 'conversational, concise, and discussion-provoking'
    };
    
    return `You are a ${toneDescriptions[tone]} social media content creator specializing in ${platform} posts.
    
Your writing style should be ${platformStyles[platform]}.

Important guidelines:
- Write in a ${tone} tone
- Optimize for ${platform} audience and format
- Include relevant emojis where appropriate
- For Twitter: Stay within 280 characters including hashtags
- For LinkedIn: Write 3-4 paragraphs with professional insights
- For Reddit: Create engaging titles and thoughtful content
- For Facebook: Make it shareable and conversation-starting
- For Instagram: Focus on visual descriptions and trending hashtags
- For Telegram: Use HTML formatting, be informative and news-focused

Never include URLs in the post content - they will be added separately.`;
  }

  getTwitterPrompt(trend, tone) {
    // Only include URL section if we have a real URL
    const hasValidUrl = trend.url && trend.url.startsWith('http');
    const urlSection = hasValidUrl ? `\n🔗 ${trend.url}\n` : '';
    const urlInstruction = hasValidUrl
      ? '4. Include the source URL exactly as provided (DO NOT shorten or modify it)'
      : '4. DO NOT include any URLs - no bit.ly, no shortened links, no made-up URLs';

    return `You are a 24/7 digital news correspondent reporting breaking news on Twitter/X.

BREAKING NEWS ARTICLE:
Headline: ${trend.title}
Time: ${new Date(trend.publishedAt || new Date()).toLocaleString()}
Summary: ${trend.description || trend.summary || ''}
${hasValidUrl ? `Source URL: ${trend.url}` : '(No source URL available)'}

Create a Twitter news update that:
1. Starts with a news emoji (🚨 📰 🔴 ⚡ 📢) and the main news point
2. Delivers key facts concisely (who, what, when, where)
3. Uses active voice and present tense
${urlInstruction}
5. Includes 3-4 SPECIFIC hashtags based on the article content (companies, technologies, locations mentioned)

Format:
🚨 [Main news in active voice - 1-2 sentences max]

📰 [Key detail or development]
${urlSection}
#[SpecificTopic] #[CompanyOrTech] #[Location] #[KeyConcept]

CRITICAL RULES:
- Extract hashtags from the article content - use actual names, companies, technologies mentioned
- Stay within 280 characters total
- NEVER create fake URLs or shortened links (like bit.ly) - only use the exact URL provided above or omit URLs entirely`;
  }

  getLinkedInPrompt(trend, tone) {
    // Use the LinkedIn-specific prompts
    const article = {
      title: trend.title,
      summary: trend.summary || trend.description,
      url: trend.url
    };
    return getLinkedInUserPrompt([], article, []);
  }

  getRedditPrompt(trend, tone) {
    const subreddit = trend.subreddit || 'technology';
    
    return `Create a Reddit post for r/${subreddit} about this topic:

Title: ${trend.title}
Summary: ${trend.summary || trend.description || ''}

Requirements:
- Create an engaging title that follows r/${subreddit} conventions
- Write 2-3 paragraphs of thoughtful commentary
- Ask a question to encourage discussion
- Be authentic and community-minded
- ${tone === 'professional' ? 'Provide expert insights' : ''}
- ${tone === 'casual' ? 'Write like a fellow community member' : ''}
- ${tone === 'educational' ? 'Explain complex concepts clearly' : ''}

Format:
Title: [Your title here]
Content: [Your post content here]`;
  }

  getFacebookPrompt(trend, tone) {
    return `Create a Facebook post about this trending topic:

Title: ${trend.title}
Summary: ${trend.summary || trend.description || ''}

Requirements:
- Write 2-3 engaging paragraphs
- Start with a hook or question
- Make it shareable and relatable
- Include 1-2 emojis
- End with a call-to-action or question
- ${tone === 'professional' ? 'Maintain credibility while being approachable' : ''}
- ${tone === 'casual' ? 'Write like you\'re talking to friends' : ''}
- ${tone === 'humorous' ? 'Include a funny observation or relatable humor' : ''}

Create a post that encourages likes, shares, and comments.`;
  }

  getInstagramPrompt(trend, tone) {
    return `Create an Instagram caption about this trending topic:

Title: ${trend.title}
Summary: ${trend.summary || trend.description || ''}

Requirements:
- Write an engaging caption (150-200 characters)
- Include 15-20 relevant hashtags
- Use line breaks for readability
- Include 2-3 emojis
- ${tone === 'professional' ? 'Be inspiring and authoritative' : ''}
- ${tone === 'casual' ? 'Keep it fun and relatable' : ''}
- ${tone === 'humorous' ? 'Add personality and wit' : ''}

Format the caption with proper spacing and hashtags at the end.`;
  }

  getTelegramPrompt(trend, tone) {
    const hasValidUrl = trend.url && trend.url.startsWith('http');

    return `Create a Telegram channel post about this news:

Title: ${trend.title}
Summary: ${trend.summary || trend.description || ''}
${hasValidUrl ? `Source URL: ${trend.url}` : ''}

Requirements:
- Use Telegram HTML formatting: <b>bold</b>, <i>italic</i>
- Start with a relevant emoji and bold headline
- Write 2-3 informative paragraphs
- ${hasValidUrl ? 'Include the source URL' : 'Do not include any URLs'}
- End with 3-5 relevant hashtags
- ${tone === 'professional' ? 'Maintain credibility and authority' : ''}
- ${tone === 'casual' ? 'Keep it conversational but informative' : ''}
- ${tone === 'educational' ? 'Explain concepts clearly for the audience' : ''}
- ${tone === 'humorous' ? 'Add a light touch while staying informative' : ''}

Format:
📰 <b>[Headline]</b>

[Paragraph 1 - key facts]

[Paragraph 2 - analysis or implications]

${hasValidUrl ? '🔗 Read more: [URL]' : ''}

#Hashtag1 #Hashtag2 #Hashtag3`;
  }

  generateMockContent(trend, platform, tone) {
    const mockTemplates = {
      twitter: `🚀 Breaking: ${trend.title}! This is huge for the industry. What are your thoughts? #TechNews #Innovation`,
      linkedin: `🎯 Exciting Development in Our Industry!\n\n${trend.title}\n\n${trend.summary || trend.description}\n\nThis represents a significant shift in how we approach technology and innovation. As professionals in this space, we must stay ahead of these trends.\n\nWhat implications do you see for your organization?\n\n#Technology #Innovation #ProfessionalDevelopment`,
      reddit: `Title: ${trend.title}\nContent: Just came across this interesting development. ${trend.summary || trend.description}. \n\nWhat does everyone think about this? I'm particularly interested in how this might affect our community.`,
      facebook: `Amazing news! 🎉\n\n${trend.title}\n\n${trend.summary || trend.description}\n\nThis is why I love technology - it never stops evolving! What do you think about this development?`,
      instagram: `${trend.title} 🚀✨\n\n${trend.summary || trend.description}\n\n#Tech #Innovation #Future #Technology #Trending #News #Digital #AI #Startup #TechNews`,
      telegram: `📰 <b>${trend.title}</b>\n\n${trend.summary || trend.description}\n\nThis development marks an important moment in the industry. Stay tuned for more updates.\n\n${trend.url ? `🔗 Read more: ${trend.url}` : ''}\n\n#News #Technology #Update`,
      threads: `${trend.title} — here's why this matters.\n\n${(trend.summary || trend.description || '').substring(0, 300)}\n\nWhat's your take on this?`
    };
    
    return mockTemplates[platform] || mockTemplates.twitter;
  }

  /**
   * Generate content for multiple trends and platforms
   * @param {Array} trends - Array of trends/articles
   * @param {Array} platforms - Array of platform names
   * @param {Object} agentSettings - User's agent settings
   * @returns {Array} Results array with success/failure for each
   */
  async generateBulkContent(trends, platforms, agentSettings = {}) {
    const results = [];

    for (const trend of trends) {
      for (const platform of platforms) {
        try {
          const content = await this.generateContent(trend, platform, agentSettings);
          results.push({
            success: true,
            content,
            trend: trend.title,
            platform
          });
        } catch (error) {
          logger.error(`Failed to generate ${platform} content for trend "${trend.title}":`, error);
          results.push({
            success: false,
            error: error.message,
            trend: trend.title,
            platform
          });
        }
      }
    }

    return results;
  }

  /**
   * Extract the full article content from its URL using @extractus/article-extractor.
   * Resolves redirects (including Google News URLs) before extraction.
   * Handles SPAs, paywalled content, and JS-heavy pages far better than raw Cheerio.
   *
   * Used to provide the video storyline generator with the full article text
   * instead of relying solely on the ~200-char API summary.
   *
   * @param {string} articleUrl - The article URL to extract content from
   * @returns {Promise<string|null>} Cleaned article text (up to ~3000 chars), or null on failure
   */
  async scrapeArticleContent(articleUrl) {
    if (!articleUrl) {
      logger.info('Article extraction skipped — no URL provided');
      return null;
    }

    try {
      // Resolve Google News or redirect URLs to the actual article
      const resolver = new ArticleResolver();
      let actualUrl = await resolver.resolveArticleUrl(articleUrl);
      if (!actualUrl) actualUrl = articleUrl;

      logger.info(`Extracting article content from: ${actualUrl}`);

      // Use @extractus/article-extractor — purpose-built for article content extraction
      // Handles diverse site structures, readability scoring, and content cleanup
      const articleData = await extract(actualUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        timeout: 10000
      });

      if (!articleData || !articleData.content) {
        logger.info('Article extractor returned no content — falling back to API summary');
        return null;
      }

      // article-extractor returns HTML content — strip tags to get clean text
      let articleText = articleData.content
        .replace(/<[^>]+>/g, ' ')   // Strip HTML tags
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')       // Collapse whitespace
        .trim();

      if (articleText.length < 100) {
        logger.info('Article extraction returned insufficient content — falling back to API summary');
        return null;
      }

      // Cap at ~3000 chars (enough for LLM summarization)
      if (articleText.length > 3000) {
        const truncated = articleText.slice(0, 3000);
        const lastPeriod = truncated.lastIndexOf('.');
        if (lastPeriod > 2000) {
          articleText = truncated.slice(0, lastPeriod + 1);
        } else {
          articleText = truncated;
        }
      }

      logger.info(`Extracted article content: ${articleText.length} chars from ${actualUrl}`);
      return articleText;

    } catch (error) {
      // Non-critical — fall back to API summary if extraction fails
      logger.warn(`Article extraction failed (non-blocking): ${error.message}`);
      return null;
    }
  }

  /**
   * Generate an editorial storyline from full article content using Gemini Flash.
   * Produces a rich 500-800 char narrative summary that captures the article's
   * story arc, tone, emotional context, primary/secondary context worlds,
   * and visual elements — designed as input for cinematic video prompt generation.
   *
   * @param {string} articleTitle - The article headline
   * @param {string|null} fullContent - Full scraped article text (null if scraping failed)
   * @param {string} fallbackSummary - API summary to use if fullContent unavailable
   * @returns {Promise<string>} Editorial storyline (500-800 chars), or fallbackSummary on failure
   */
  async generateArticleStoryline(articleTitle, fullContent, fallbackSummary) {
    const googleApiKey = process.env.GOOGLE_AI_STUDIO_API_KEY;
    const sourceText = fullContent || fallbackSummary || '';

    // If we only have a short summary and no API key, return as-is
    if (!googleApiKey || sourceText.length < 50) {
      logger.info('Storyline generation skipped — insufficient source text or no API key');
      return fallbackSummary || '';
    }

    try {
      const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent';

      const prompt = `You are an editorial director preparing a video production brief. Read this article and produce a STORYLINE SUMMARY (500-800 characters) that a cinematic video director will use to create a compelling news video.

ARTICLE TITLE: ${articleTitle}

ARTICLE TEXT:
${sourceText.slice(0, 2500)}

YOUR STORYLINE MUST CAPTURE:
1. NARRATIVE ARC: What happened, who is involved, what's at stake, and what's the outcome or tension
2. TONE & MOOD: Is this urgent/breaking? Hopeful/inspiring? Somber/tragic? Exciting/revolutionary? Convey the emotional register
3. KEY PLAYERS & SETTING: Who are the central figures? Describe the physical setting where this story takes place — the specific venue, location, or environment
4. CAUSE & CONSEQUENCE: What caused this event and what are its consequences? What changed or is at stake?
5. VISUAL ANCHORS: Mention specific settings, people, objects, or scenes described in the article that could be visually represented
6. WHY IT MATTERS: The broader significance — what makes this story compelling, what creates FOMO for viewers who might scroll past

OUTPUT: Write a single flowing paragraph, 500-800 characters. No labels, no bullet points. Write it as a narrative brief — vivid, specific, emotionally resonant. Start with the story's hook, build through the key details, and end with the stakes or significance.`;

      const response = await axios.post(endpoint, {
        contents: [{
          parts: [{ text: prompt }]
        }]
      }, {
        headers: {
          'x-goog-api-key': googleApiKey,
          'Content-Type': 'application/json'
        },
        timeout: 20000
      });

      const candidate = response.data?.candidates?.[0];
      const storyline = candidate?.content?.parts?.[0]?.text?.trim();
      const finishReason = candidate?.finishReason;

      // Debug: log what the model actually returned
      if (!storyline) {
        logger.warn(`Storyline generation returned empty — finishReason: ${finishReason}, candidates: ${JSON.stringify(response.data?.candidates?.length)}, promptFeedback: ${JSON.stringify(response.data?.promptFeedback)}`);
      } else {
        logger.info(`Storyline raw response: ${storyline.length} chars, finishReason: ${finishReason}`);
      }

      if (storyline && storyline.length >= 100) {
        logger.info(`Generated article storyline (${storyline.length} chars)`);
        return storyline;
      }

      logger.warn(`Gemini Flash returned insufficient storyline (${storyline?.length || 0} chars) — falling back to summary`);
      return fallbackSummary || '';

    } catch (error) {
      // Non-critical — fall back to API summary if storyline generation fails
      logger.warn(`Storyline generation failed (non-blocking): ${error.message}`);
      return fallbackSummary || '';
    }
  }

  /**
   * Describe an image using Gemini Flash vision model.
   * Returns a concise 1-2 sentence description of the image contents,
   * focusing on visible subjects, their appearance, the setting, and any logos/text.
   *
   * Used to give the video prompt LLM concrete knowledge of the starting frame
   * instead of forcing it to guess from article context alone.
   *
   * @param {string} imageUrl - Publicly accessible image URL
   * @returns {Promise<string|null>} Image description, or null on failure
   */
  async describeImage(imageUrl) {
    const googleApiKey = process.env.GOOGLE_AI_STUDIO_API_KEY;
    if (!googleApiKey || !imageUrl) {
      logger.info('Image description skipped — no API key or image URL');
      return null;
    }

    try {
      // Download the image as base64 (same pattern as VideoGenerationService.downloadImageForVeo)
      const imageResponse = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 15000,
        headers: { 'User-Agent': 'NewsAgentSaaS/1.0' }
      });

      const contentType = imageResponse.headers['content-type'] || '';
      let mimeType = 'image/jpeg';
      if (contentType.includes('png')) mimeType = 'image/png';
      else if (contentType.includes('webp')) mimeType = 'image/webp';
      else if (contentType.includes('gif')) mimeType = 'image/gif';

      const base64Image = Buffer.from(imageResponse.data).toString('base64');

      // Call Gemini Flash for vision description
      const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent';

      const response = await axios.post(endpoint, {
        contents: [{
          parts: [
            {
              inlineData: {
                mimeType,
                data: base64Image
              }
            },
            {
              text: 'Describe this image in 1-2 concise sentences. Focus on: who or what is visible, their attire and appearance, the setting or background, and any visible logos or text. Be factual and specific — describe what you see, not what you interpret.'
            }
          ]
        }]
      }, {
        headers: {
          'x-goog-api-key': googleApiKey,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      });

      const description = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

      if (description) {
        logger.info(`Image described: ${description.slice(0, 100)}...`);
        return description;
      }

      logger.warn('Gemini Flash returned empty image description');
      return null;
    } catch (error) {
      // Non-critical — fall back to generic image guidance if vision fails
      logger.warn(`Image description failed (non-blocking): ${error.message}`);
      return null;
    }
  }

  /**
   * Generate a video generation prompt for TikTok using LLM.
   * The LLM acts as an expert cinematographer — it reads the article + caption
   * and outputs a vivid, specific, cinematic scene description optimized for
   * the target video model (Runway Gen-4.5 or Google Veo 3.1).
   * @param {Object} trend - Article/trend data
   * @param {string} caption - Generated TikTok caption text
   * @param {Object} agentSettings - Agent settings
   * @param {string|null} imageUrl - Article featured image URL (for vision description)
   * @returns {Promise<string>} Video generation prompt
   */
  async generateVideoPrompt(trend, caption, agentSettings = {}, imageUrl = null) {
    const { default: VideoPromptEngine } = await import('./VideoPromptEngine.js');

    const model = (process.env.VIDEO_GENERATION_MODEL || 'veo').toLowerCase();
    const charLimit = model === 'runway' ? 950 : 1400;
    const googleApiKey = process.env.GOOGLE_AI_STUDIO_API_KEY;

    // Phase 1: Parallel data enrichment — scrape article + describe image simultaneously
    const originalSummary = trend.summary || trend.description || '';
    const [fullContent, imageDescription] = await Promise.all([
      this.scrapeArticleContent(trend.url),
      this.describeImage(imageUrl)
    ]);

    // Phase 2: Generate editorial storyline from full article content
    const storyline = await this.generateArticleStoryline(trend.title, fullContent, originalSummary);

    const article = {
      title: trend.title,
      summary: originalSummary,
      description: storyline, // Rich editorial storyline (different from summary → STORYLINE section renders)
      source: trend.source
    };

    // Get scene classification metadata to enrich the LLM context
    const sceneMetadata = VideoPromptEngine.getSceneMetadata({ article });

    // Cache sceneMetadata and imageDescription for rephrase calls
    this._lastSceneMetadata = sceneMetadata;
    this._lastImageDescription = imageDescription;

    // Build LLM prompts for cinematographic video scene generation
    const systemPrompt = getVideoPromptSystemPrompt(agentSettings, model, sceneMetadata);
    const userPrompt = getVideoPromptUserPrompt(article, caption, model, sceneMetadata, imageDescription);

    let videoPrompt;

    if (googleApiKey) {
      logger.info(`Generating cinematic video directive via Gemini Flash for ${model} (category: ${sceneMetadata.category}${sceneMetadata.secondaryCategory ? `, secondary: ${sceneMetadata.secondaryCategory}` : ''}, mood: ${sceneMetadata.mood})...`);

      // Use Gemini 3 Flash for video prompt generation (same REST pattern as describeImage)
      const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent';

      const response = await axios.post(endpoint, {
        systemInstruction: {
          parts: [{ text: systemPrompt }]
        },
        contents: [{
          role: 'user',
          parts: [{ text: userPrompt }]
        }],
        generationConfig: {
          maxOutputTokens: 2000,
          temperature: 0.9
        }
      }, {
        headers: {
          'x-goog-api-key': googleApiKey,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      });

      const candidate = response.data?.candidates?.[0];
      videoPrompt = candidate?.content?.parts?.[0]?.text?.trim();
      const finishReason = candidate?.finishReason;
      const promptFeedback = response.data?.promptFeedback;

      // Log raw response BEFORE cleanup (matches generateArticleStoryline pattern)
      if (!videoPrompt) {
        logger.warn(`Video directive returned empty — finishReason: ${finishReason}, candidates: ${response.data?.candidates?.length}, promptFeedback: ${JSON.stringify(promptFeedback)}`);
        throw new Error('Gemini Flash returned empty video prompt');
      } else {
        logger.info(`Video directive raw response: ${videoPrompt.length} chars, finishReason: ${finishReason}`);
      }

      // Reject safety-blocked responses before wasting video generation quota
      if (promptFeedback?.blockReason) {
        throw new Error(`Gemini Flash blocked video directive: ${promptFeedback.blockReason}`);
      }

      // Strip common LLM meta-framing if present (e.g., "Here's the video prompt:")
      videoPrompt = videoPrompt
        .replace(/^(here['']?s?\s+(the\s+)?video\s+prompt[:\s]*)/i, '')
        .replace(/^(video\s+prompt[:\s]*)/i, '')
        .replace(/^["'`]+|["'`]+$/g, '')
        .trim();

      // Guard against suspiciously short prompts that would waste video API quota
      if (videoPrompt.length < 20) {
        logger.warn(`Video directive suspiciously short after cleanup (${videoPrompt.length} chars): "${videoPrompt}" — finishReason: ${finishReason}`);
        throw new Error(`Gemini Flash returned unusable video directive (${videoPrompt.length} chars: "${videoPrompt}")`);
      }
    } else {
      // Mock fallback for testing without API keys
      videoPrompt = `Photorealistic 9:16 cinematic news footage. A modern newsroom, screens glowing with breaking updates about ${article.title}. Camera pushes forward past anchor desks into a wall of monitors. Sharp focus, natural lighting, broadcast-quality documentary footage.`;
    }

    // Enforce hard character limit for the video model
    if (videoPrompt.length > charLimit) {
      logger.warn(`Video prompt exceeded ${charLimit} char limit (${videoPrompt.length} chars) — truncating`);
      const truncated = videoPrompt.slice(0, charLimit);
      const lastPeriod = truncated.lastIndexOf('.');
      if (lastPeriod > charLimit * 0.7) {
        videoPrompt = truncated.slice(0, lastPeriod + 1);
      } else {
        videoPrompt = truncated.slice(0, charLimit - 3) + '...';
      }
    }

    logger.info(`Generated cinematic video directive for ${model} (${videoPrompt.length} chars)`);
    logger.debug(`Video prompt: ${videoPrompt}`);
    return videoPrompt;
  }

  /**
   * Rephrase a video prompt that was blocked by content safety filters.
   * Uses LLM reasoning to identify trigger words and produce a safer alternative
   * that preserves cinematic quality and story relevance.
   * Leverages cached sceneMetadata and imageDescription from generateVideoPrompt()
   * to provide domain-aware rephrase suggestions and image-coherent alternatives.
   *
   * @param {string} originalPrompt - The prompt that was rejected by content filters
   * @param {Object} trend - Article/trend data (for story context)
   * @param {Object} options - { model: 'veo'|'runway', attemptNumber: number }
   * @returns {Promise<string>} Rephrased video generation prompt
   */
  async rephraseVideoPrompt(originalPrompt, trend, { model = 'veo', attemptNumber = 1 } = {}) {
    const charLimit = model === 'runway' ? 950 : 1400;

    const article = {
      title: trend.title,
      summary: trend.summary || trend.description || '',
      description: trend.description || trend.summary || '',
      source: trend.source
    };

    // Use cached sceneMetadata from generateVideoPrompt(), or re-compute if unavailable
    let sceneMetadata = this._lastSceneMetadata;
    if (!sceneMetadata) {
      const { default: VideoPromptEngine } = await import('./VideoPromptEngine.js');
      sceneMetadata = VideoPromptEngine.getSceneMetadata({ article });
    }

    const imageDescription = this._lastImageDescription || null;

    const systemPrompt = getVideoRephraseSystemPrompt(model, attemptNumber, sceneMetadata);
    const userPrompt = getVideoRephraseUserPrompt(originalPrompt, article, model, attemptNumber, imageDescription);

    let rephrasedPrompt;
    const googleApiKey = process.env.GOOGLE_AI_STUDIO_API_KEY;

    if (googleApiKey) {
      logger.info(`Rephrasing content-filtered video prompt via Gemini Flash (model: ${model})...`);
      logger.info(`Original prompt (${originalPrompt.length} chars): ${originalPrompt.slice(0, 120)}...`);

      // Use Gemini 3 Flash for rephrase (same pattern as generateVideoPrompt)
      const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent';

      const response = await axios.post(endpoint, {
        systemInstruction: {
          parts: [{ text: systemPrompt }]
        },
        contents: [{
          role: 'user',
          parts: [{ text: userPrompt }]
        }],
        generationConfig: {
          maxOutputTokens: 2000,
          temperature: 0.9
        }
      }, {
        headers: {
          'x-goog-api-key': googleApiKey,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      });

      rephrasedPrompt = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

      if (!rephrasedPrompt) {
        throw new Error('Gemini Flash returned empty rephrased prompt');
      }

      // Strip common LLM meta-framing (same cleanup as generateVideoPrompt)
      rephrasedPrompt = rephrasedPrompt
        .replace(/^(here['']?s?\s+(the\s+)?(rephrased\s+)?video\s+prompt[:\s]*)/i, '')
        .replace(/^(rephrased\s+)?(video\s+prompt[:\s]*)/i, '')
        .replace(/^["'`]+|["'`]+$/g, '')
        .trim();
    } else {
      // Mock fallback — in test mode, return a generic safe prompt
      logger.warn('Gemini API not configured — returning generic safe prompt as mock rephrase');
      rephrasedPrompt = `Photorealistic 9:16 cinematic news footage. A modern conference room, screens displaying charts and data related to ${article.title}. Camera pushes forward past a polished table into a wall of monitors. Sharp focus, natural lighting, broadcast-quality documentary footage.`;
    }

    // Enforce character limit (same logic as generateVideoPrompt)
    if (rephrasedPrompt.length > charLimit) {
      logger.warn(`Rephrased prompt exceeded ${charLimit} char limit (${rephrasedPrompt.length} chars) — truncating`);
      const truncated = rephrasedPrompt.slice(0, charLimit);
      const lastPeriod = truncated.lastIndexOf('.');
      if (lastPeriod > charLimit * 0.7) {
        rephrasedPrompt = truncated.slice(0, lastPeriod + 1);
      } else {
        rephrasedPrompt = truncated.slice(0, charLimit - 3) + '...';
      }
    }

    logger.info(`Rephrased video prompt generated (${rephrasedPrompt.length} chars)`);
    return rephrasedPrompt;
  }
}

export default ContentGenerator;