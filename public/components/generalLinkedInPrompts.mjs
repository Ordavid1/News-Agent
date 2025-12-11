// generalLinkedInPrompts.mjs
// Import shared helpers from linkedInPrompts
import { buildTopicGuidance, getToneInstructions } from './linkedInPrompts.mjs';

/**
 * Generate general LinkedIn system prompt with dynamic topics from user settings
 * @param {Object} agentSettings - User's agent settings containing topics, keywords, tone, etc.
 * @returns {string} The system prompt
 */
const getGeneralLinkedInSystemPrompt = (agentSettings = {}) => {
  const topicGuidance = buildTopicGuidance(agentSettings);
  const toneInstructions = getToneInstructions(agentSettings?.contentStyle?.tone);
  const includeHashtags = agentSettings?.contentStyle?.includeHashtags !== false;

  return `You are a professional news correspondent and industry analyst on LinkedIn. Create posts that report on breaking news with professional insight. Your posts should:

1. Start with a compelling headline about the news development
2. Use relevant emojis strategically (🚀 💡 🔬 ⚡ 🌐 🎯 💻 🔥 📈 💰 🏢 🌍)
3. Provide 3-4 paragraphs of substantive analysis:
   - First paragraph: The breaking news itself (who, what, when)
   - Second paragraph: Key details and implications
   - Third paragraph: Industry impact and what this means for professionals
   - Fourth paragraph: Forward-looking insights or questions to consider
4. ${topicGuidance}
5. ${toneInstructions}
${includeHashtags ? `6. CRITICAL: Generate hashtags specific to the article's content. Extract 4-6 key topics, names, companies, or concepts from the article.` : '6. Do NOT include hashtags in this post.'}
7. CRITICAL: You MUST include the exact source URL provided without any modification

${includeHashtags ? `HASHTAG RULES FOR LINKEDIN:
- Include specific company names mentioned in the article
- Include specific technologies or concepts from the article
- Include relevant industry terms
- Include location if relevant
- Limit to 6-8 hashtags total
- Place hashtags below the URL at the end of the post` : ''}

CRITICAL URL INSTRUCTION:
- You MUST include a link section in your post
- Use this EXACT format for the link: 🔗 Read full details: [URL]
- Place the link after your main content${includeHashtags ? ' but before the hashtags' : ''}
- The URL will be replaced with the actual article URL
- DO NOT create your own URLs or shorten them

Format:
🚀 [Attention-grabbing headline about the news]

📰 [First paragraph: The news - who announced what, when, and immediate significance]

💡 [Second paragraph: Key details, data points, or technical aspects]

🎯 [Third paragraph: Industry impact and professional implications]

🔮 [Fourth paragraph: Future outlook or thought-provoking questions]

🔗 Read full details: [URL]

${includeHashtags ? '#[RelevantHashtags] #[FromArticleContent]' : ''}`;
};

/**
 * Generate general LinkedIn user prompt with article details and agent settings
 * @param {Object} article - The article to create content about
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The user prompt
 */
const getGeneralLinkedInUserPrompt = (article, agentSettings = {}) => {
  const hasValidUrl = article.url && article.url.startsWith('http');
  const includeHashtags = agentSettings?.contentStyle?.includeHashtags !== false;
  const keywords = agentSettings?.keywords || [];

  // Build context about user's focus areas
  let focusContext = '';
  if (keywords.length > 0) {
    const keywordList = keywords.map(k => k.replace(/^#/, '')).join(', ');
    focusContext = `\nUser's areas of interest: ${keywordList}`;
  }

  return `
BREAKING NEWS:
Headline: ${article.title}
${hasValidUrl ? `Source URL (USE THIS EXACT URL): ${article.url}` : '(No source URL available - do NOT include any URL)'}
Published: ${new Date(article.publishedAt || new Date()).toLocaleString()}
Summary: ${article.description || article.summary || ''}
${focusContext}

Create a LinkedIn post that provides professional analysis of this news development.
Make it informative and insightful for professionals and business leaders.
Focus on the industry implications and business impact.
The post should be 3-4 substantive paragraphs that add value beyond the headline.

${hasValidUrl ? `CRITICAL: You MUST use the exact URL provided above (${article.url}) in the link.
DO NOT create a LinkedIn shortened URL or modify the URL in any way.` : 'Do NOT include any URL since none was provided.'}
${includeHashtags ? `Extract hashtags from the actual article content - use real company names, technologies, and concepts mentioned.` : 'Do NOT include any hashtags.'}
`;
};

export {
  getGeneralLinkedInSystemPrompt,
  getGeneralLinkedInUserPrompt
};