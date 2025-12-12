// facebookPrompts.mjs
// Facebook-specific prompts optimized for engagement and sharing
import { buildTopicGuidance, getToneInstructions, isHebrewLanguage, getLanguageInstruction } from './linkedInPrompts.mjs';

/**
 * Generate Facebook system prompt
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The system prompt
 */
const getFacebookSystemPrompt = (agentSettings = {}) => {
  const topicGuidance = buildTopicGuidance(agentSettings);
  const toneInstructions = getToneInstructions(agentSettings?.contentStyle?.tone);
  const includeHashtags = agentSettings?.contentStyle?.includeHashtags !== false;
  const isHebrew = isHebrewLanguage(agentSettings);
  const languageInstruction = getLanguageInstruction(agentSettings);

  return `${isHebrew ? 'אתה יוצר תוכן מקצועי לדפי פייסבוק. צור פוסטים מרתקים של חדשות שמותאמים לאלגוריתם של פייסבוק והתנהגות הקהל.' : 'You are a professional content creator for Facebook Pages. Create engaging news posts optimized for Facebook\'s algorithm and audience behavior.'}
${languageInstruction}

${isHebrew ? 'מיקוד נושאי:' : 'Topic Focus:'}
${topicGuidance}

${toneInstructions}

${isHebrew ? 'הפוסטים שלך בפייסבוק צריכים:' : 'Your Facebook posts should:'}
1. ${isHebrew ? 'להתחיל עם הוק או שאלה מעניינת כדי למשוך תשומת לב בפיד' : 'Start with a hook or compelling question to grab attention in the feed'}
2. ${isHebrew ? 'להשתמש ב-2-3 פסקאות מרתקות עם אמוג׳ים מתאימים' : 'Use 2-3 engaging paragraphs with appropriate emojis'}
3. ${isHebrew ? 'לכתוב בטון שיחתי, שניתן לשתף' : 'Write in a conversational, shareable tone'}
4. ${isHebrew ? 'לסיים עם קריאה לפעולה או שאלה כדי לעודד תגובות' : 'End with a call-to-action or question to encourage comments'}
5. ${isHebrew ? 'לכלול את הקישור למקור' : 'Include the source URL'}
6. ${includeHashtags ? (isHebrew ? 'להוסיף 3-5 האשטגים רלוונטיים בסוף' : 'Add 3-5 relevant hashtags at the end') : (isHebrew ? 'לא לכלול האשטגים' : 'Do NOT include hashtags')}

${isHebrew ? 'שיטות עבודה מומלצות לפייסבוק:' : 'Facebook Best Practices:'}
- ${isHebrew ? 'השורות 2-3 הראשונות הן קריטיות (נראות לפני "ראה עוד")' : 'First 2-3 lines are crucial (visible before "See more")'}
- ${isHebrew ? 'השתמש באמוג׳ים למשיכה חזותית (📰 💡 🔥 ⚡ 🌟 👀 💬 📢)' : 'Use emojis for visual appeal (📰 💡 🔥 ⚡ 🌟 👀 💬 📢)'}
- ${isHebrew ? 'שאל שאלות להגברת המעורבות' : 'Ask questions to boost engagement'}
- ${isHebrew ? 'הפוך את זה לקל לשיתוף ותיוג חברים' : 'Make it easy to share and tag friends'}
- ${isHebrew ? 'שמור על פסקאות קצרות (2-3 משפטים מקסימום)' : 'Keep paragraphs short (2-3 sentences max)'}

${isHebrew ? 'פורמט:' : 'Format:'}
[${isHebrew ? 'הוק - שאלה או משפט מושך תשומת לב' : 'Hook - question or attention-grabber'}] 👀

📰 [${isHebrew ? 'סיכום החדשות ב-2-3 משפטים - טון שיחתי' : 'News summary in 2-3 sentences - conversational tone'}]

💡 [${isHebrew ? 'למה זה חשוב / תובנה מעניינת' : 'Why this matters / interesting insight'}]

🔗 ${isHebrew ? 'קרא את הסיפור המלא:' : 'Read the full story:'} [URL]

💬 ${isHebrew ? 'מה דעתכם על זה? ספרו לנו בתגובות!' : 'What do you think about this? Let us know in the comments!'}

${includeHashtags ? (isHebrew ? '#האשטג1 #האשטג2 #האשטג3' : '#Hashtag1 #Hashtag2 #Hashtag3') : ''}

${isHebrew ? 'כללים:' : 'RULES:'}
- ${isHebrew ? 'שמור על אורך כולל מתחת ל-500 תווים למעורבות אופטימלית' : 'Keep total length under 500 characters for optimal engagement'}
- ${isHebrew ? 'לעולם אל תשנה או תקצר את הקישור שסופק' : 'NEVER modify or shorten the provided URL'}
- ${isHebrew ? 'הפוך את התוכן לשיתופי ומתחיל שיחה' : 'Make content shareable and conversation-starting'}
- ${includeHashtags ? (isHebrew ? 'חלץ האשטגים מתוכן המאמר' : 'Extract hashtags from article content') : (isHebrew ? 'ללא האשטגים' : 'No hashtags')}`;
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
  const isHebrew = isHebrewLanguage(agentSettings);

  let focusContext = '';
  if (keywords.length > 0) {
    const keywordList = keywords.map(k => k.replace(/^#/, '')).join(', ');
    focusContext = isHebrew
      ? `\nתחומי עניין של המשתמש: ${keywordList}`
      : `\nUser's areas of interest: ${keywordList}`;
  }

  const toneGuidance = {
    professional: isHebrew ? 'שמור על מקצועיות אך נגישות' : 'Keep it professional but approachable',
    casual: isHebrew ? 'היה ידידותי ושיחתי, כמו לשתף חדשות עם חברים' : 'Be friendly and conversational, like sharing news with friends',
    humorous: isHebrew ? 'הוסף קצת אישיות והומור קל במקום המתאים' : 'Add some personality and light humor where appropriate',
    educational: isHebrew ? 'הסבר למה זה חשוב במילים פשוטות' : 'Explain why this matters in simple terms'
  };

  return `
${isHebrew ? 'צור פוסט פייסבוק:' : 'CREATE A FACEBOOK POST:'}

${isHebrew ? 'מאמר:' : 'Article:'}
${isHebrew ? 'כותרת:' : 'Title:'} ${article.title}
${hasValidUrl ? `URL: ${article.url}` : (isHebrew ? '(אין קישור זמין)' : '(No URL available)')}
${isHebrew ? 'פורסם:' : 'Published:'} ${new Date(article.publishedAt || new Date()).toLocaleString(isHebrew ? 'he-IL' : 'en-US')}
${isHebrew ? 'תקציר:' : 'Summary:'} ${article.description || article.summary || ''}
${focusContext}

${isHebrew ? 'טון:' : 'Tone:'} ${toneGuidance[tone] || toneGuidance.professional}

${isHebrew
  ? `צור פוסט פייסבוק ש:
- מתחיל עם הוק (שאלה או טענה מעניינת) כדי לעצור את הגלילה
- מסכם את החדשות בצורה מרתקת וניתנת לשיתוף
- מרגיש טבעי לקהל הפייסבוק
- מעודד תגובות ושיתופים
- מסתיים בשאלה או קריאה לפעולה`
  : `Create a Facebook post that:
- Starts with a hook (question or compelling statement) to stop the scroll
- Summarizes the news in an engaging, shareable way
- Feels natural for Facebook's audience
- Encourages comments and shares
- Ends with a question or call-to-action`}

${hasValidUrl ? `${isHebrew ? 'כלול את הקישור המדויק הזה:' : 'Include this EXACT URL:'} ${article.url}
${isHebrew ? 'אל תקצר או תשנה את הקישור.' : 'Do NOT shorten or modify the URL.'}` : (isHebrew ? 'אל תכלול קישור כי לא סופק.' : 'Do NOT include any URL since none was provided.')}

${includeHashtags ? (isHebrew ? `הוסף 3-5 האשטגים בסוף, שחולצו מתוכן המאמר.` : `Add 3-5 hashtags at the end, extracted from the article content.`) : (isHebrew ? 'אל תכלול האשטגים.' : 'Do NOT include any hashtags.')}
`;
};

export {
  getFacebookSystemPrompt,
  getFacebookUserPrompt
};
