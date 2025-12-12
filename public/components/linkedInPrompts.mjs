// linkedInPrompts.mjs

/**
 * Check if the content should be in Hebrew based on geoFilter region
 * @param {Object} agentSettings - User's agent settings
 * @returns {boolean} Whether to use Hebrew language
 */
const isHebrewLanguage = (agentSettings) => {
  const region = agentSettings?.geoFilter?.region || '';
  return region.toLowerCase() === 'il';
};

/**
 * Get language instruction based on settings
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} Language instruction
 */
const getLanguageInstruction = (agentSettings) => {
  if (isHebrewLanguage(agentSettings)) {
    return `
CRITICAL LANGUAGE INSTRUCTION:
- Write the ENTIRE post in Hebrew (עברית)
- Use Hebrew characters for all text
- Write from right to left (RTL)
- Only the URL should remain in English
- Hashtags should be in Hebrew when appropriate (e.g., #טכנולוגיה #חדשות)
- Maintain professional Hebrew writing style`;
  }
  return '';
};

/**
 * Build topic-specific guidance based on user's selected topics
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} Topic guidance for the prompt
 */
const buildTopicGuidance = (agentSettings) => {
  const isHebrew = isHebrewLanguage(agentSettings);

  // Hebrew topic descriptions
  const topicDescriptionsHebrew = {
    technology: 'טכנולוגיה: תוכנה, חומרה, טרנספורמציה דיגיטלית, מגמות בתעשיית הטכנולוגיה, חדשנות',
    business: 'עסקים: חדשות תאגידיות, מגמות שוק, יזמות, מנהיגות, אסטרטגיה',
    entertainment: 'בידור: מדיה, סטרימינג, משחקים, חדשות סלבריטאים, תרבות פופולרית',
    sports: 'ספורט: אירועי ספורט, קבוצות, שחקנים, ליגות, תחרויות',
    health: 'בריאות: פריצות דרך רפואיות, אורח חיים בריא, תעשיית הבריאות, בריאות הציבור',
    science: 'מדע: תגליות מחקריות, מחקרים מדעיים, חלל, סביבה, אקלים'
  };

  const topicDescriptionsEnglish = {
    technology: 'Technology: Software, hardware, digital transformation, tech industry trends, innovation',
    business: 'Business: Corporate news, market trends, entrepreneurship, leadership, strategy',
    entertainment: 'Entertainment: Media, streaming, gaming, celebrity news, pop culture',
    sports: 'Sports: Athletic events, teams, players, leagues, competitions',
    health: 'Health: Medical breakthroughs, wellness, healthcare industry, public health',
    science: 'Science: Research discoveries, scientific studies, space, environment, climate'
  };

  const topicDescriptions = isHebrew ? topicDescriptionsHebrew : topicDescriptionsEnglish;

  const topics = agentSettings?.topics || [];
  const keywords = agentSettings?.keywords || [];

  if (topics.length === 0 && keywords.length === 0) {
    return isHebrew
      ? 'סקור חדשות בתחומי טכנולוגיה, עסקים ונושאים כלליים.'
      : 'Cover news across technology, business, and general interest topics.';
  }

  let guidance = '';

  if (topics.length > 0) {
    const topicDetails = topics
      .map(t => topicDescriptions[t])
      .filter(Boolean)
      .join('\n   - ');
    guidance += isHebrew
      ? `התמקד בתחומי נושא אלה:\n   - ${topicDetails}`
      : `Focus on these topic areas:\n   - ${topicDetails}`;
  }

  if (keywords.length > 0) {
    const keywordList = keywords.map(k => k.replace(/^#/, '')).join(', ');
    const keywordPrefix = isHebrew
      ? 'שים לב במיוחד לתוכן הקשור ל: '
      : 'Pay special attention to content related to: ';
    guidance += `${topics.length > 0 ? '\n\n' : ''}${keywordPrefix}${keywordList}`;
  }

  return guidance;
};

/**
 * Get tone-specific writing instructions
 * @param {string} tone - The tone setting (professional, casual, humorous, educational)
 * @returns {string} Tone instructions
 */
const getToneInstructions = (tone) => {
  const toneStyles = {
    professional: `Writing style:
- Professional and authoritative
- Technical but accessible
- Focused on business and industry implications
- Thought-provoking and forward-thinking`,
    casual: `Writing style:
- Friendly and conversational
- Easy to read and relatable
- Engaging without being too formal
- Use accessible language, avoid jargon`,
    humorous: `Writing style:
- Light-hearted and witty where appropriate
- Still informative but with personality
- Use clever observations or wordplay when relevant
- Balance humor with substance`,
    educational: `Writing style:
- Clear and explanatory
- Break down complex concepts
- Help readers learn something new
- Include context and background for understanding`
  };

  return toneStyles[tone] || toneStyles.professional;
};

/**
 * Generate LinkedIn system prompt with dynamic topics from user settings
 * @param {Object} agentSettings - User's agent settings containing topics, keywords, tone, etc.
 * @returns {string} The system prompt
 */
const getLinkedInSystemPrompt = (agentSettings = {}) => {
  const topicGuidance = buildTopicGuidance(agentSettings);
  const toneInstructions = getToneInstructions(agentSettings?.contentStyle?.tone);
  const includeHashtags = agentSettings?.contentStyle?.includeHashtags !== false;
  const languageInstruction = getLanguageInstruction(agentSettings);
  const isHebrew = isHebrewLanguage(agentSettings);

  return `You are a professional industry analyst and thought leader on LinkedIn. Create posts that report on breaking news with professional insight.
${languageInstruction}

Your posts should:

1. Start with a compelling headline about the development
2. Use relevant emojis strategically (🚀 💡 🔬 ⚡ 🌐 🎯 💻 🔥 📈 💰 🏢 🌍 🤖 🧠)
3. Provide 3-4 paragraphs of substantive analysis while each paragraph is short and concise:
   - First paragraph: The breaking news itself (who, what, when)
   - Second paragraph: Key details and implications
   - Third paragraph: Industry impact and what this means for professionals
   - Fourth paragraph: Forward-looking insights or questions to consider
4. ${topicGuidance}
5. ${toneInstructions}
${includeHashtags ? `6. CRITICAL: Generate hashtags specific to the article's text content, not generic ones. Extract 4-6 key topics, names, companies, or concepts from the article and turn them into hashtags.` : '6. Do NOT include hashtags in this post.'}
7. CRITICAL: You MUST include the exact source URL provided without any modification

${includeHashtags ? `HASHTAG RULES FOR LINKEDIN:
- Include specific company names mentioned in the article
- Include specific technologies or concepts from the article
- Include relevant industry terms
- Include the hashtags below the URL at the end of the post
- Limit to 6-8 hashtags total` : ''}

CRITICAL URL INSTRUCTION:
- You will receive an exact source URL in the prompt
- Include that EXACT URL in your post - DO NOT modify, shorten, or create fake URLs
- DO NOT use bit.ly, tinyurl, or any URL shortener
- If no URL is provided, DO NOT include any URL at all

${includeHashtags ? `HASHTAG FORMAT (CRITICAL):
- Use standard hashtag format: #HashtagName (NOT "hashtag#HashtagName")
- No spaces in hashtags
- CamelCase for multi-word hashtags: #GenerativeAI #MachineLearning` : ''}

Format:
🚀 [Attention-grabbing headline about the development]

📰 [First paragraph: The news - who announced what, when, and the immediate significance]

💡 [Second paragraph: Key details - how it works, what makes it special, key specifications or improvements]

🎯 [Third paragraph: Industry implications - how this affects businesses, professionals, or the landscape]

🔮 [Fourth paragraph: Future outlook - what this means for the future, questions it raises, or potential next steps]

${isHebrew ? '💬 מה דעתכם על ההתפתחות הזו? איך אתם רואים את ההשפעה שלה על העבודה שלכם?' : '💬 What are your thoughts on this development? How do you see it impacting your work?'}

🔗 [Include the exact source URL here - or omit this line if no URL provided]

${includeHashtags ? (isHebrew ? '#האשטג1 #האשטג2 #האשטג3' : '#Hashtag1 #Hashtag2 #Hashtag3') : ''}

`;
};

/**
 * Generate LinkedIn user prompt with article details and agent settings
 * @param {Object} article - The article to create content about
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The user prompt
 */
const getLinkedInUserPrompt = (article, agentSettings = {}) => {
  const hasValidUrl = article.url && article.url.startsWith('http');
  const includeHashtags = agentSettings?.contentStyle?.includeHashtags !== false;
  const keywords = agentSettings?.keywords || [];
  const isHebrew = isHebrewLanguage(agentSettings);
  const languageInstruction = getLanguageInstruction(agentSettings);

  // Build context about user's focus areas
  let focusContext = '';
  if (keywords.length > 0) {
    const keywordList = keywords.map(k => k.replace(/^#/, '')).join(', ');
    focusContext = isHebrew
      ? `\nתחומי עניין של המשתמש: ${keywordList}`
      : `\nUser's areas of interest: ${keywordList}`;
  }

  return `
${isHebrew ? 'חדשות לשיתוף:' : 'BREAKING NEWS TO SHARE:'}
${isHebrew ? 'כותרת:' : 'Headline:'} ${article.title}
${hasValidUrl ? `${isHebrew ? 'קישור למקור:' : 'Source URL:'} ${article.url}` : (isHebrew ? '(אין קישור למקור - אל תכלול קישור)' : '(No source URL available - do NOT include any URL)')}
${isHebrew ? 'פורסם:' : 'Published:'} ${new Date(article.publishedAt || new Date()).toLocaleString(isHebrew ? 'he-IL' : 'en-US')}
${isHebrew ? 'תקציר:' : 'Summary:'} ${article.description || article.summary || ''}
${focusContext}
${languageInstruction}

${isHebrew
  ? `צור פוסט LinkedIn שמספק ניתוח מקצועי של ההתפתחות הזו.
הפוך אותו לאינפורמטיבי ותובנתי עבור אנשי מקצוע ומנהלים עסקיים.
התמקד בהשלכות ובהשפעה העסקית.
הפוסט צריך להיות 3-4 פסקאות מהותיות שמוסיפות ערך מעבר לכותרת.`
  : `Create a LinkedIn post that provides professional analysis of this development.
Make it informative and insightful for professionals and business leaders.
Focus on the implications and business impact.
The post should be 3-4 substantive paragraphs that add value beyond the headline.`}

${isHebrew ? 'כללים קריטיים:' : 'CRITICAL RULES:'}
${hasValidUrl ? `- ${isHebrew ? 'כלול את הקישור המדויק הזה בפוסט שלך:' : 'Include this EXACT URL in your post:'} ${article.url}` : `- ${isHebrew ? 'אל תכלול קישור כי לא סופק' : 'Do NOT include any URL since none was provided'}`}
- ${isHebrew ? 'לעולם אל תיצור קישורים מזויפים (לא bit.ly, לא קישורים מקוצרים, לא קישורים בדויים)' : 'NEVER create fake URLs (no bit.ly, no shortened links, no made-up URLs)'}
${includeHashtags ? `- ${isHebrew ? 'השתמש בפורמט האשטג תקין: #שםהאשטג' : 'Use proper hashtag format: #HashtagName (NOT "hashtag#HashtagName")'}
- ${isHebrew ? 'חלץ האשטגים רלוונטיים מתוכן המאמר' : 'Extract relevant hashtags from the article content'}` : `- ${isHebrew ? 'אל תכלול האשטגים' : 'Do NOT include hashtags'}`}
`;
};

// Export helper functions for reuse in other platform prompts
export {
  getLinkedInSystemPrompt,
  getLinkedInUserPrompt,
  buildTopicGuidance,
  getToneInstructions,
  isHebrewLanguage,
  getLanguageInstruction
};