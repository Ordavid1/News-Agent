// redditPrompts.mjs
// Reddit-specific prompts optimized for community engagement
// NO emojis, NO promotional language, discussion-focused
import { buildTopicGuidance, getToneInstructions } from './linkedInPrompts.mjs';

/**
 * Generate Reddit system prompt
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The system prompt
 */
const getRedditSystemPrompt = (agentSettings = {}) => {
  const topicGuidance = buildTopicGuidance(agentSettings);
  const tone = agentSettings?.contentStyle?.tone || 'professional';
  const subreddit = agentSettings?.platformSettings?.reddit?.subreddit || 'news';

  const toneStyles = {
    professional: 'Informative and factual, like a well-researched post',
    casual: 'Conversational, like sharing interesting news with fellow community members',
    humorous: 'Can include light observations, but substance comes first',
    educational: 'Explanatory, helping readers understand the implications'
  };

  return `You are creating a Reddit post for r/${subreddit}. Reddit has a unique culture that values authenticity, substance, and community discussion.

Topic Focus:
${topicGuidance}

Tone: ${toneStyles[tone] || toneStyles.professional}

CRITICAL REDDIT RULES:
1. NO EMOJIS - Reddit culture generally dislikes emoji-heavy posts
2. NO promotional or marketing language
3. NO clickbait titles
4. Write like a community member sharing interesting news, not a brand
5. Encourage genuine discussion

Post Structure:
TITLE: [Factual, informative headline - max 300 characters]
- Should be clear and descriptive
- State the key news point directly
- Avoid sensationalism

BODY:
[2-3 paragraphs that:]
- Summarize the key facts
- Provide relevant context
- Add your own insight or analysis
- End with a discussion question

**Source:** [URL]

Format Example:
---
TITLE: [Clear, factual headline about the news]

[First paragraph: What happened - the key facts]

[Second paragraph: Context and why it matters]

[Third paragraph: Your take or a question for discussion]

**Source:** [URL]

---

RULES:
- Keep title under 300 characters
- Use markdown formatting (bold with **, links, etc.)
- NEVER use emojis
- Be authentic and community-minded
- Include source URL with **Source:** prefix`;
};

/**
 * Generate Reddit user prompt
 * @param {Object} article - The article to create content about
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The user prompt
 */
const getRedditUserPrompt = (article, agentSettings = {}) => {
  const hasValidUrl = article.url && article.url.startsWith('http');
  const subreddit = agentSettings?.platformSettings?.reddit?.subreddit || 'news';
  const tone = agentSettings?.contentStyle?.tone || 'professional';
  const keywords = agentSettings?.keywords || [];

  let focusContext = '';
  if (keywords.length > 0) {
    const keywordList = keywords.map(k => k.replace(/^#/, '')).join(', ');
    focusContext = `\nRelevant topics: ${keywordList}`;
  }

  return `
CREATE A REDDIT POST FOR r/${subreddit}:

Article:
Title: ${article.title}
${hasValidUrl ? `URL: ${article.url}` : '(No URL available)'}
Published: ${new Date(article.publishedAt || new Date()).toLocaleString()}
Summary: ${article.description || article.summary || ''}
${focusContext}

Create a Reddit post with:
1. TITLE (under 300 chars): A clear, factual headline - NO clickbait
2. BODY: 2-3 paragraphs covering:
   - The key news facts
   - Why it matters / relevant context
   - A question to spark discussion

CRITICAL:
- NO EMOJIS AT ALL
- Write like a community member, not a marketer
- Use Reddit markdown: **bold**, *italic*, [link text](url)
- End with a genuine discussion question
${hasValidUrl ? `- Include source: **Source:** ${article.url}` : '- No URL available, do not include source link'}

Target subreddit context: r/${subreddit}
Adapt your tone and focus to fit this community.

Output format:
TITLE: [Your title here]

[Body paragraphs here]

${hasValidUrl ? `**Source:** ${article.url}` : ''}
`;
};

export {
  getRedditSystemPrompt,
  getRedditUserPrompt
};
