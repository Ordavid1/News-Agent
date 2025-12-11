// twitterPrompts.mjs
// Twitter-specific prompts with Standard (280 chars) and Premium (4000 chars) templates
import { buildTopicGuidance, getToneInstructions } from './linkedInPrompts.mjs';

/**
 * Generate Twitter Standard system prompt (280 character limit)
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The system prompt
 */
const getTwitterStandardSystemPrompt = (agentSettings = {}) => {
  const topicGuidance = buildTopicGuidance(agentSettings);
  const tone = agentSettings?.contentStyle?.tone || 'professional';
  const includeHashtags = agentSettings?.contentStyle?.includeHashtags !== false;

  const toneStyles = {
    professional: 'Authoritative but accessible',
    casual: 'Conversational and friendly',
    humorous: 'Witty with personality',
    educational: 'Clear and informative'
  };

  return `You are a breaking news Twitter account. Create ultra-concise news updates that MUST be under 280 characters total.

CRITICAL: Total tweet length including emojis, spaces, URL, and hashtags MUST be under 280 characters.

Topic Focus:
${topicGuidance}

Tone: ${toneStyles[tone] || toneStyles.professional}

Format (STRICT 280 CHAR LIMIT):
🚨 [Main news point - 1 SHORT sentence, max 100 chars]
🔗 [URL - counts toward limit!]
${includeHashtags ? '#Tag1 #Tag2 #Tag3 (max 3 hashtags, each counts toward limit)' : ''}

RULES:
- Lead with ONE news emoji (🚨 📰 🔴 ⚡ 📢 💥 🔥)
- One sentence only - the core news
- Include the EXACT source URL provided
- ${includeHashtags ? 'Max 3 hashtags, extracted from article content' : 'NO hashtags'}
- NEVER exceed 280 characters total
- NEVER shorten or modify the URL`;
};

/**
 * Generate Twitter Standard user prompt (280 character limit)
 * @param {Object} article - The article to create content about
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The user prompt
 */
const getTwitterStandardUserPrompt = (article, agentSettings = {}) => {
  const hasValidUrl = article.url && article.url.startsWith('http');
  const includeHashtags = agentSettings?.contentStyle?.includeHashtags !== false;
  const urlLength = hasValidUrl ? article.url.length : 0;

  // Calculate available characters (280 minus URL length and spacing)
  const availableChars = 280 - urlLength - 10; // 10 for emoji, newlines, spacing

  return `
CREATE A TWITTER NEWS UPDATE (STRICT 280 CHARACTER LIMIT):

Article:
Title: ${article.title}
${hasValidUrl ? `URL: ${article.url} (URL is ${urlLength} chars)` : '(No URL available)'}
Summary: ${article.description || article.summary || ''}

CONSTRAINTS:
- Total tweet must be UNDER 280 characters
- URL alone is ${urlLength} characters
- You have ~${availableChars} characters for text and hashtags
- ${includeHashtags ? 'Include 2-3 SHORT hashtags from article content' : 'Do NOT include hashtags'}
${hasValidUrl ? `- Use this EXACT URL: ${article.url}` : '- Do NOT include any URL'}

OUTPUT FORMAT:
🚨 [News in one short sentence]
${hasValidUrl ? `🔗 ${article.url}` : ''}
${includeHashtags ? '#Short #Tags' : ''}

COUNT YOUR CHARACTERS CAREFULLY!`;
};

/**
 * Generate Twitter Premium system prompt (4000 character limit)
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The system prompt
 */
const getTwitterPremiumSystemPrompt = (agentSettings = {}) => {
  const topicGuidance = buildTopicGuidance(agentSettings);
  const toneInstructions = getToneInstructions(agentSettings?.contentStyle?.tone);
  const includeHashtags = agentSettings?.contentStyle?.includeHashtags !== false;

  return `You are a professional news correspondent on Twitter/X with Premium access. Create engaging news updates with more detail (up to 4000 characters).

Topic Focus:
${topicGuidance}

${toneInstructions}

Your posts should:
1. Start with a compelling headline using a news emoji
2. Provide 2-3 short paragraphs of key information:
   - First: The breaking news (who, what, when)
   - Second: Key details and significance
   - Third: Why it matters / what's next
3. Include the exact source URL
4. ${includeHashtags ? 'End with 4-6 relevant hashtags extracted from the article' : 'Do NOT include hashtags'}

Format:
🚨 [Attention-grabbing headline]

📰 [Breaking news - the key facts in 2-3 sentences]

💡 [Why this matters - context and implications]

🔗 Read more: [URL]

${includeHashtags ? '#Relevant #Hashtags #FromArticle' : ''}

RULES:
- Keep it engaging and Twitter-appropriate
- Use line breaks for readability
- Include the EXACT URL provided - never modify or shorten it
- Stay under 4000 characters total
- ${includeHashtags ? 'Extract hashtags from actual article content' : 'No hashtags'}`;
};

/**
 * Generate Twitter Premium user prompt (4000 character limit)
 * @param {Object} article - The article to create content about
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The user prompt
 */
const getTwitterPremiumUserPrompt = (article, agentSettings = {}) => {
  const hasValidUrl = article.url && article.url.startsWith('http');
  const includeHashtags = agentSettings?.contentStyle?.includeHashtags !== false;
  const keywords = agentSettings?.keywords || [];

  let focusContext = '';
  if (keywords.length > 0) {
    const keywordList = keywords.map(k => k.replace(/^#/, '')).join(', ');
    focusContext = `\nUser's areas of interest: ${keywordList}`;
  }

  return `
CREATE A TWITTER PREMIUM POST (up to 4000 characters):

Article:
Title: ${article.title}
${hasValidUrl ? `URL: ${article.url}` : '(No URL available)'}
Published: ${new Date(article.publishedAt || new Date()).toLocaleString()}
Summary: ${article.description || article.summary || ''}
${focusContext}

Create an engaging Twitter post that:
- Captures the key news in an attention-grabbing way
- Provides context and why it matters
- Uses Twitter's conversational style (more casual than LinkedIn)
- Is optimized for engagement and shares

${hasValidUrl ? `Include this EXACT URL in your post: ${article.url}
Do NOT shorten or modify the URL.` : 'Do NOT include any URL since none was provided.'}

${includeHashtags ? `Include 4-6 relevant hashtags extracted from the article content.
Use hashtag format: #HashtagName (CamelCase for multi-word)` : 'Do NOT include any hashtags.'}
`;
};

export {
  getTwitterStandardSystemPrompt,
  getTwitterStandardUserPrompt,
  getTwitterPremiumSystemPrompt,
  getTwitterPremiumUserPrompt
};
