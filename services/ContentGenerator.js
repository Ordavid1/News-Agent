// services/ContentGenerator.js
import OpenAI from 'openai';
import winston from 'winston';

// Import platform-specific prompts
import { getLinkedInSystemPrompt, getLinkedInUserPrompt } from '../public/components/linkedInPrompts.mjs';
import { getGeneralLinkedInSystemPrompt, getGeneralLinkedInUserPrompt } from '../public/components/generalLinkedInPrompts.mjs';
import { getTwitterStandardSystemPrompt, getTwitterStandardUserPrompt, getTwitterPremiumSystemPrompt, getTwitterPremiumUserPrompt } from '../public/components/twitterPrompts.mjs';
import { getFacebookSystemPrompt, getFacebookUserPrompt } from '../public/components/facebookPrompts.mjs';
import { getRedditSystemPrompt, getRedditUserPrompt } from '../public/components/redditPrompts.mjs';
import { getTelegramSystemPrompt, getTelegramUserPrompt } from '../public/components/telegramPrompts.mjs';

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
      telegram: this.getTelegramPrompt
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
        // Instagram - use legacy socialMediaPrompts as fallback for now
        systemPrompt = getSystemPrompt(false); // English version

        // Extract keywords from the trend
        const keywords = [];
        if (trend.title) {
          const words = trend.title.split(' ');
          words.forEach(word => {
            if (word.length > 4 && /[A-Z]/.test(word[0])) {
              keywords.push(word.replace(/[^a-zA-Z0-9]/g, ''));
            }
          });
        }

        userPrompt = getUserPrompt(keywords, {
          title: trend.title,
          description: trend.description || trend.summary,
          publishedAt: trend.publishedAt,
          url: trend.url,
          source: { name: trend.source }
        });

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
      telegram: 'news-focused, informative, and HTML-formatted for channels'
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
      telegram: `📰 <b>${trend.title}</b>\n\n${trend.summary || trend.description}\n\nThis development marks an important moment in the industry. Stay tuned for more updates.\n\n${trend.url ? `🔗 Read more: ${trend.url}` : ''}\n\n#News #Technology #Update`
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
}

export default ContentGenerator;