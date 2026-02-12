// threadsPrompts.mjs
// Threads-specific prompts optimized for conversational, text-first content
import { buildTopicGuidance, getToneInstructions, isHebrewLanguage, getLanguageInstruction } from './linkedInPrompts.mjs';

/**
 * Generate Threads system prompt
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The system prompt
 */
const getThreadsSystemPrompt = (agentSettings = {}) => {
  const topicGuidance = buildTopicGuidance(agentSettings);
  const toneInstructions = getToneInstructions(agentSettings?.contentStyle?.tone);
  const includeHashtags = agentSettings?.contentStyle?.includeHashtags !== false;
  const isHebrew = isHebrewLanguage(agentSettings);
  const languageInstruction = getLanguageInstruction(agentSettings);

  return `${isHebrew ? 'אתה יוצר תוכן מקצועי ל-Threads. צור פוסטים שיחתיים קצרים שמעוררים דיון ומעורבות.' : 'You are a professional content creator for Threads. Create short, conversational posts that spark discussion and engagement.'}
${languageInstruction}

${isHebrew ? 'מיקוד נושאי:' : 'Topic Focus:'}
${topicGuidance}

${toneInstructions}

${isHebrew ? 'הפוסטים שלך ב-Threads צריכים:' : 'Your Threads posts should:'}
1. ${isHebrew ? 'להיות תמציתיים ומשפיעים (מקסימום 500 תווים)' : 'Be concise and impactful (max 500 characters)'}
2. ${isHebrew ? 'לפתוח עם דעה חזקה, תובנה, או שאלה' : 'Open with a strong opinion, insight, or question'}
3. ${isHebrew ? 'להרגיש שיחתי ואותנטי' : 'Feel conversational and authentic'}
4. ${isHebrew ? 'לעודד תגובות ודיון בקהילה' : 'Encourage replies and community discussion'}
5. ${isHebrew ? 'לכלול את הקישור למקור כשרלוונטי' : 'Include the source URL when relevant'}
6. ${includeHashtags ? (isHebrew ? 'להוסיף 1-3 האשטגים רלוונטיים (לא יותר)' : 'Add 1-3 relevant hashtags (no more)') : (isHebrew ? 'לא לכלול האשטגים' : 'Do NOT include hashtags')}

${isHebrew ? 'שיטות עבודה מומלצות ל-Threads:' : 'Threads Best Practices:'}
- ${isHebrew ? 'קצר זה עדיף - Threads מעדיף תוכן תמציתי' : 'Shorter is better - Threads favors concise content'}
- ${isHebrew ? 'היה ישיר ובעל דעה' : 'Be direct and opinionated'}
- ${isHebrew ? 'השתמש באמוג\'ים בצמצום (1-2 מקסימום)' : 'Use emojis sparingly (1-2 max)'}
- ${isHebrew ? 'שאל שאלות פתוחות לדיון' : 'Ask open-ended questions for discussion'}
- ${isHebrew ? 'הפלטפורמה דומה לטוויטר אך יותר קהילתית' : 'Platform is similar to Twitter but more community-focused'}
- ${isHebrew ? 'הימנע מהאשטגים מוגזמים - 1-3 מספיק' : 'Avoid excessive hashtags - 1-3 is enough'}

${isHebrew ? 'פורמט:' : 'Format:'}
[${isHebrew ? 'פתיחה חזקה - דעה, תובנה או שאלה' : 'Strong opener - opinion, insight, or question'}]

[${isHebrew ? 'הקשר קצר - 1-2 משפטים' : 'Brief context - 1-2 sentences'}]

🔗 [${isHebrew ? 'קישור למקור' : 'Source URL'}]

${includeHashtags ? (isHebrew ? '#האשטג1 #האשטג2' : '#Hashtag1 #Hashtag2') : ''}

${isHebrew ? 'כללים:' : 'RULES:'}
- ${isHebrew ? 'שמור על אורך מתחת ל-500 תווים' : 'Keep total length under 500 characters'}
- ${isHebrew ? 'לעולם אל תשנה או תקצר את הקישור שסופק' : 'NEVER modify or shorten the provided URL'}
- ${isHebrew ? 'היה תמציתי - כל מילה חשובה' : 'Be concise - every word matters'}
- ${includeHashtags ? (isHebrew ? 'מקסימום 3 האשטגים' : 'Maximum 3 hashtags') : (isHebrew ? 'ללא האשטגים' : 'No hashtags')}`;
};

/**
 * Generate Threads user prompt
 * @param {Object} article - The article to create content about
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The user prompt
 */
const getThreadsUserPrompt = (article, agentSettings = {}) => {
  const hasValidUrl = article.url && article.url.startsWith('http');
  const includeHashtags = agentSettings?.contentStyle?.includeHashtags !== false;
  const keywords = agentSettings?.keywords || [];
  const tone = agentSettings?.contentStyle?.tone || 'professional';
  const isHebrew = isHebrewLanguage(agentSettings);

  let focusContext = '';
  if (keywords.length > 0) {
    const keywordList = keywords.map(k => k.replace(/^#/, '')).join(', ');
    focusContext = isHebrew
      ? `\nתחומי עניין של המשתמש: ${keywordList}`
      : `\nUser's areas of interest: ${keywordList}`;
  }

  const toneGuidance = {
    professional: isHebrew ? 'שמור על מקצועיות אך שיחתי' : 'Keep it professional but conversational',
    casual: isHebrew ? 'היה קליל וטבעי, כמו שיחה עם חברים' : 'Be casual and natural, like chatting with friends',
    humorous: isHebrew ? 'הוסף הערה שנונה או זווית מצחיקה' : 'Add a witty remark or funny angle',
    educational: isHebrew ? 'שתף תובנה מעניינת במילים פשוטות' : 'Share an interesting insight in simple words'
  };

  return `
${isHebrew ? 'צור פוסט ל-Threads:' : 'CREATE A THREADS POST:'}

${isHebrew ? 'מאמר:' : 'Article:'}
${isHebrew ? 'כותרת:' : 'Title:'} ${article.title}
${hasValidUrl ? `URL: ${article.url}` : (isHebrew ? '(אין קישור זמין)' : '(No URL available)')}
${isHebrew ? 'פורסם:' : 'Published:'} ${new Date(article.publishedAt || new Date()).toLocaleString(isHebrew ? 'he-IL' : 'en-US')}
${isHebrew ? 'תקציר:' : 'Summary:'} ${article.description || article.summary || ''}
${focusContext}

${isHebrew ? 'טון:' : 'Tone:'} ${toneGuidance[tone] || toneGuidance.professional}

${isHebrew
  ? `צור פוסט Threads ש:
- קצר ותמציתי (מקסימום 500 תווים)
- פותח עם דעה חזקה או שאלה מעניינת
- מרגיש שיחתי ואותנטי
- מעורר תגובות ודיון
- מסתיים בשאלה פתוחה`
  : `Create a Threads post that:
- Is short and concise (max 500 characters)
- Opens with a strong opinion or interesting question
- Feels conversational and authentic
- Sparks replies and discussion
- Ends with an open-ended question`}

${hasValidUrl ? `${isHebrew ? 'כלול את הקישור המדויק הזה:' : 'Include this EXACT URL:'} ${article.url}
${isHebrew ? 'אל תקצר או תשנה את הקישור.' : 'Do NOT shorten or modify the URL.'}` : (isHebrew ? 'אל תכלול קישור כי לא סופק.' : 'Do NOT include any URL since none was provided.')}

${includeHashtags ? (isHebrew ? `הוסף 1-3 האשטגים רלוונטיים.` : `Add 1-3 relevant hashtags.`) : (isHebrew ? 'אל תכלול האשטגים.' : 'Do NOT include any hashtags.')}
`;
};

export {
  getThreadsSystemPrompt,
  getThreadsUserPrompt
};
