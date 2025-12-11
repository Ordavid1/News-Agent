// facebookPrompts.mjs
// Facebook-specific prompts optimized for engagement and sharing
import { buildTopicGuidance, getToneInstructions } from './linkedInPrompts.mjs';

/**
 * Generate Facebook system prompt
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The system prompt
 */
const getFacebookSystemPrompt = (agentSettings = {}) => {
  const topicGuidance = buildTopicGuidance(agentSettings);
  const toneInstructions = getToneInstructions(agentSettings?.contentStyle?.tone);
  const includeHashtags = agentSettings?.contentStyle?.includeHashtags !== false;

  return `You are a professional content creator for Facebook Pages. Create engaging news posts optimized for Facebook's algorithm and audience behavior.

Topic Focus:
${topicGuidance}

${toneInstructions}

Your Facebook posts should:
1. Start with a hook or compelling question to grab attention in the feed
2. Use 2-3 engaging paragraphs with appropriate emojis
3. Write in a conversational, shareable tone
4. End with a call-to-action or question to encourage comments
5. Include the source URL
6. ${includeHashtags ? 'Add 3-5 relevant hashtags at the end' : 'Do NOT include hashtags'}

Facebook Best Practices:
- First 2-3 lines are crucial (visible before "See more")
- Use emojis for visual appeal (📰 💡 🔥 ⚡ 🌟 👀 💬 📢)
- Ask questions to boost engagement
- Make it easy to share and tag friends
- Keep paragraphs short (2-3 sentences max)

Format:
[Hook - question or attention-grabber] 👀

📰 [News summary in 2-3 sentences - conversational tone]

💡 [Why this matters / interesting insight]

🔗 Read the full story: [URL]

💬 What do you think about this? Let us know in the comments!

${includeHashtags ? '#Hashtag1 #Hashtag2 #Hashtag3' : ''}

RULES:
- Keep total length under 500 characters for optimal engagement
- NEVER modify or shorten the provided URL
- Make content shareable and conversation-starting
- ${includeHashtags ? 'Extract hashtags from article content' : 'No hashtags'}`;
};

/**
 * Generate Facebook user prompt
 * @param {Object} article - The article to create content about
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The user prompt
 */
const getFacebookUserPrompt = (article, agentSettings = {}) => {
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
    professional: 'Keep it professional but approachable',
    casual: 'Be friendly and conversational, like sharing news with friends',
    humorous: 'Add some personality and light humor where appropriate',
    educational: 'Explain why this matters in simple terms'
  };

  return `
CREATE A FACEBOOK POST:

Article:
Title: ${article.title}
${hasValidUrl ? `URL: ${article.url}` : '(No URL available)'}
Published: ${new Date(article.publishedAt || new Date()).toLocaleString()}
Summary: ${article.description || article.summary || ''}
${focusContext}

Tone: ${toneGuidance[tone] || toneGuidance.professional}

Create a Facebook post that:
- Starts with a hook (question or compelling statement) to stop the scroll
- Summarizes the news in an engaging, shareable way
- Feels natural for Facebook's audience
- Encourages comments and shares
- Ends with a question or call-to-action

${hasValidUrl ? `Include this EXACT URL: ${article.url}
Do NOT shorten or modify the URL.` : 'Do NOT include any URL since none was provided.'}

${includeHashtags ? `Add 3-5 hashtags at the end, extracted from the article content.` : 'Do NOT include any hashtags.'}
`;
};

export {
  getFacebookSystemPrompt,
  getFacebookUserPrompt
};
