// telegramPrompts.mjs
// Telegram-specific prompts with HTML formatting for channels
import { buildTopicGuidance, getToneInstructions } from './linkedInPrompts.mjs';

/**
 * Generate Telegram system prompt
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The system prompt
 */
const getTelegramSystemPrompt = (agentSettings = {}) => {
  const topicGuidance = buildTopicGuidance(agentSettings);
  const toneInstructions = getToneInstructions(agentSettings?.contentStyle?.tone);
  const includeHashtags = agentSettings?.contentStyle?.includeHashtags !== false;

  return `You are a professional news correspondent for a Telegram channel. Create engaging news updates optimized for Telegram's format and audience.

Topic Focus:
${topicGuidance}

${toneInstructions}

TELEGRAM HTML FORMATTING (use these):
- <b>bold text</b> for emphasis and headlines
- <i>italic text</i> for quotes or subtle emphasis
- <a href="URL">link text</a> for hyperlinks
- <code>inline code</code> for technical terms
- Use line breaks for readability

Post Structure:
1. Bold headline with relevant emoji
2. 2-3 short paragraphs with key information
3. Source link
4. ${includeHashtags ? 'Hashtags for discoverability' : 'No hashtags'}

CHARACTER LIMITS:
- Regular messages: 4096 characters max
- Photo captions: 1024 characters max
- Keep posts concise: 300-600 characters is ideal

Format:
📰 <b>[Headline]</b>

[First paragraph: Key news facts - 2-3 sentences]

[Second paragraph: Context or implications - 2-3 sentences]

🔗 <a href="[URL]">Read more</a>

${includeHashtags ? '#Hashtag1 #Hashtag2 #Hashtag3' : ''}

RULES:
- Use HTML tags for formatting, NOT markdown
- Keep it concise and scannable
- Use emojis sparingly for visual appeal (📰 💡 🔥 ⚡ 🌐 📢)
- Include the exact source URL in an <a> tag
- ${includeHashtags ? 'Add 3-5 relevant hashtags at the end' : 'Do NOT include hashtags'}`;
};

/**
 * Generate Telegram user prompt
 * @param {Object} article - The article to create content about
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The user prompt
 */
const getTelegramUserPrompt = (article, agentSettings = {}) => {
  const hasValidUrl = article.url && article.url.startsWith('http');
  const includeHashtags = agentSettings?.contentStyle?.includeHashtags !== false;
  const keywords = agentSettings?.keywords || [];
  const tone = agentSettings?.contentStyle?.tone || 'professional';

  let focusContext = '';
  if (keywords.length > 0) {
    const keywordList = keywords.map(k => k.replace(/^#/, '')).join(', ');
    focusContext = `\nUser's areas of interest: ${keywordList}`;
  }

  const toneGuidance = {
    professional: 'Authoritative and informative',
    casual: 'Conversational and engaging',
    humorous: 'Light and witty where appropriate',
    educational: 'Clear explanations for context'
  };

  return `
CREATE A TELEGRAM CHANNEL POST:

Article:
Title: ${article.title}
${hasValidUrl ? `URL: ${article.url}` : '(No URL available)'}
Published: ${new Date(article.publishedAt || new Date()).toLocaleString()}
Summary: ${article.description || article.summary || ''}
${focusContext}

Tone: ${toneGuidance[tone] || toneGuidance.professional}

Create a Telegram post that:
- Uses HTML formatting (<b>, <i>, <a href="">)
- Starts with an emoji and bold headline
- Has 2-3 short, scannable paragraphs
- Is concise (300-600 characters ideal, max 1000)

${hasValidUrl ? `Include source link using HTML:
<a href="${article.url}">Read more</a>` : 'Do NOT include any link since no URL was provided.'}

${includeHashtags ? `Add 3-5 hashtags at the end, extracted from article content.` : 'Do NOT include any hashtags.'}

Output using Telegram HTML format:
📰 <b>[Headline]</b>

[Paragraph 1]

[Paragraph 2]

${hasValidUrl ? `🔗 <a href="${article.url}">Read more</a>` : ''}

${includeHashtags ? '#Hashtags #Here' : ''}
`;
};

/**
 * Generate Telegram caption prompt (shorter, for photos)
 * @param {Object} article - The article to create content about
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The caption prompt
 */
const getTelegramCaptionPrompt = (article, agentSettings = {}) => {
  const hasValidUrl = article.url && article.url.startsWith('http');
  const includeHashtags = agentSettings?.contentStyle?.includeHashtags !== false;

  return `
CREATE A SHORT TELEGRAM PHOTO CAPTION (MAX 1024 CHARACTERS):

Article: ${article.title}
${hasValidUrl ? `URL: ${article.url}` : ''}

Create a very short caption:
- One bold headline with emoji
- 1-2 sentences summarizing the news
- Source link if URL provided
- ${includeHashtags ? '2-3 hashtags' : 'No hashtags'}

MUST be under 1024 characters total.

Format:
📰 <b>[Short headline]</b>

[1-2 sentence summary]

${hasValidUrl ? `🔗 <a href="${article.url}">Read more</a>` : ''}
${includeHashtags ? '#Tag1 #Tag2' : ''}
`;
};

export {
  getTelegramSystemPrompt,
  getTelegramUserPrompt,
  getTelegramCaptionPrompt
};
