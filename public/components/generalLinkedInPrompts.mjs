// generalLinkedInPrompts.mjs
// Import shared helpers from linkedInPrompts
import { buildTopicGuidance, getToneInstructions, isHebrewLanguage, getLanguageInstruction } from './linkedInPrompts.mjs';

/**
 * Generate general LinkedIn system prompt with dynamic topics from user settings
 * @param {Object} agentSettings - User's agent settings containing topics, keywords, tone, etc.
 * @returns {string} The system prompt
 */
const getGeneralLinkedInSystemPrompt = (agentSettings = {}) => {
  const topicGuidance = buildTopicGuidance(agentSettings);
  const toneInstructions = getToneInstructions(agentSettings?.contentStyle?.tone);
  const includeHashtags = agentSettings?.contentStyle?.includeHashtags !== false;
  const isHebrew = isHebrewLanguage(agentSettings);
  const languageInstruction = getLanguageInstruction(agentSettings);

  return `${isHebrew ? 'אתה כתב חדשות מקצועי ואנליסט תעשייתי בלינקדאין. צור פוסטים שמדווחים על חדשות חמות עם תובנה מקצועית.' : 'You are a professional news correspondent and industry analyst on LinkedIn. Create posts that report on breaking news with professional insight.'}
${languageInstruction}

${isHebrew ? 'הפוסטים שלך צריכים:' : 'Your posts should:'}

1. ${isHebrew ? 'להתחיל עם כותרת מרשימה על ההתפתחות החדשותית' : 'Start with a compelling headline about the news development'}
2. ${isHebrew ? 'להשתמש באמוג׳ים רלוונטיים באופן אסטרטגי (🚀 💡 🔬 ⚡ 🌐 🎯 💻 🔥 📈 💰 🏢 🌍)' : 'Use relevant emojis strategically (🚀 💡 🔬 ⚡ 🌐 🎯 💻 🔥 📈 💰 🏢 🌍)'}
3. ${isHebrew ? 'לספק 3-4 פסקאות קצרות של ניתוח מהותי:' : 'Provide 3-4 short paragraphs of substantive analysis:'}
   - ${isHebrew ? 'פסקה ראשונה: החדשות הבוערות עצמן (מי, מה, מתי)' : 'First paragraph: The breaking news itself (who, what, when)'}
   - ${isHebrew ? 'פסקה שנייה: פרטים מפתח והשלכות' : 'Second paragraph: Key details and implications'}
   - ${isHebrew ? 'פסקה שלישית: השפעה תעשייתית ומה זה אומר לאנשי מקצוע' : 'Third paragraph: Industry impact and what this means for professionals'}
   - ${isHebrew ? 'פסקה רביעית: תובנות צופות פני עתיד או שאלות לשיקול' : 'Fourth paragraph: Forward-looking insights or questions to consider'}
4. ${topicGuidance}
5. ${toneInstructions}
${includeHashtags ? `6. ${isHebrew ? 'קריטי: צור האשטגים ספציפיים לתוכן המאמר. חלץ 4-6 נושאים, שמות, חברות או מושגים מפתח מהמאמר.' : 'CRITICAL: Generate hashtags specific to the article\'s content. Extract 4-6 key topics, names, companies, or concepts from the article.'}` : `6. ${isHebrew ? 'אל תכלול האשטגים בפוסט זה.' : 'Do NOT include hashtags in this post.'}`}
7. ${isHebrew ? 'קריטי: חייב לכלול את הקישור המדויק למקור שסופק ללא שינוי' : 'CRITICAL: You MUST include the exact source URL provided without any modification'}

${includeHashtags ? `${isHebrew ? 'כללי האשטגים ללינקדאין:' : 'HASHTAG RULES FOR LINKEDIN:'}
- ${isHebrew ? 'כלול שמות חברות ספציפיים שהוזכרו במאמר' : 'Include specific company names mentioned in the article'}
- ${isHebrew ? 'כלול טכנולוגיות או מושגים ספציפיים מהמאמר' : 'Include specific technologies or concepts from the article'}
- ${isHebrew ? 'כלול מונחי תעשייה רלוונטיים' : 'Include relevant industry terms'}
- ${isHebrew ? 'כלול מיקום אם רלוונטי' : 'Include location if relevant'}
- ${isHebrew ? 'הגבל ל-6-8 האשטגים בסך הכל' : 'Limit to 6-8 hashtags total'}
- ${isHebrew ? 'מקם האשטגים מתחת לקישור בסוף הפוסט' : 'Place hashtags below the URL at the end of the post'}` : ''}

${isHebrew ? 'הוראות קישור קריטיות:' : 'CRITICAL URL INSTRUCTION:'}
- ${isHebrew ? 'חייב לכלול קטע קישור בפוסט שלך' : 'You MUST include a link section in your post'}
- ${isHebrew ? 'השתמש בפורמט המדויק הזה לקישור: 🔗 קרא פרטים מלאים: [URL]' : 'Use this EXACT format for the link: 🔗 Read full details: [URL]'}
- ${isHebrew ? 'מקם את הקישור אחרי התוכן העיקרי שלך' : 'Place the link after your main content'}${includeHashtags ? (isHebrew ? ' אבל לפני האשטגים' : ' but before the hashtags') : ''}
- ${isHebrew ? 'הקישור יוחלף ב-URL של המאמר בפועל' : 'The URL will be replaced with the actual article URL'}
- ${isHebrew ? 'אל תיצור קישורים משלך או תקצר אותם' : 'DO NOT create your own URLs or shorten them'}

${isHebrew ? 'פורמט:' : 'Format:'}
🚀 [${isHebrew ? 'כותרת מושכת תשומת לב על החדשות' : 'Attention-grabbing headline about the news'}]

📰 [${isHebrew ? 'פסקה ראשונה: החדשות - מי הכריז מה, מתי, ומשמעות מיידית' : 'First paragraph: The news - who announced what, when, and immediate significance'}]

💡 [${isHebrew ? 'פסקה שנייה: פרטים מפתח, נקודות מידע או היבטים טכניים' : 'Second paragraph: Key details, data points, or technical aspects'}]

🎯 [${isHebrew ? 'פסקה שלישית: השפעה תעשייתית והשלכות מקצועיות' : 'Third paragraph: Industry impact and professional implications'}]

🔮 [${isHebrew ? 'פסקה רביעית: מבט לעתיד או שאלות מעוררות מחשבה' : 'Fourth paragraph: Future outlook or thought-provoking questions'}]

🔗 ${isHebrew ? 'קרא פרטים מלאים:' : 'Read full details:'} [URL]

${includeHashtags ? (isHebrew ? '#[האשטגים רלוונטיים] #[מתוכן המאמר]' : '#[RelevantHashtags] #[FromArticleContent]') : ''}`;
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
  const isHebrew = isHebrewLanguage(agentSettings);

  // Build context about user's focus areas
  let focusContext = '';
  if (keywords.length > 0) {
    const keywordList = keywords.map(k => k.replace(/^#/, '')).join(', ');
    focusContext = isHebrew
      ? `\nתחומי עניין של המשתמש: ${keywordList}`
      : `\nUser's areas of interest: ${keywordList}`;
  }

  return `
${isHebrew ? 'חדשות בוערות:' : 'BREAKING NEWS:'}
${isHebrew ? 'כותרת:' : 'Headline:'} ${article.title}
${hasValidUrl ? `${isHebrew ? 'קישור למקור (השתמש בקישור המדויק הזה):' : 'Source URL (USE THIS EXACT URL):'} ${article.url}` : (isHebrew ? '(אין קישור למקור - אל תכלול קישור)' : '(No source URL available - do NOT include any URL)')}
${isHebrew ? 'פורסם:' : 'Published:'} ${new Date(article.publishedAt || new Date()).toLocaleString(isHebrew ? 'he-IL' : 'en-US')}
${isHebrew ? 'תקציר:' : 'Summary:'} ${article.description || article.summary || ''}
${focusContext}

${isHebrew
  ? `צור פוסט LinkedIn שמספק ניתוח מקצועי של התפתחות חדשותית זו.
הפוך אותו לאינפורמטיבי ותובנתי עבור אנשי מקצוע ומנהלים עסקיים.
התמקד בהשלכות התעשייתיות ובהשפעה העסקית.
הפוסט צריך להיות 3-4 פסקאות מהותיות שמוסיפות ערך מעבר לכותרת.`
  : `Create a LinkedIn post that provides professional analysis of this news development.
Make it informative and insightful for professionals and business leaders.
Focus on the industry implications and business impact.
The post should be 3-4 substantive paragraphs that add value beyond the headline.`}

${hasValidUrl ? `${isHebrew ? `קריטי: חייב להשתמש בקישור המדויק שסופק למעלה (${article.url}) בקישור.
אל תיצור קישור מקוצר של LinkedIn או תשנה את הקישור בכל צורה.` : `CRITICAL: You MUST use the exact URL provided above (${article.url}) in the link.
DO NOT create a LinkedIn shortened URL or modify the URL in any way.`}` : (isHebrew ? 'אל תכלול קישור כי לא סופק.' : 'Do NOT include any URL since none was provided.')}
${includeHashtags ? (isHebrew ? `חלץ האשטגים מתוכן המאמר בפועל - השתמש בשמות חברות, טכנולוגיות ומושגים אמיתיים שהוזכרו.` : `Extract hashtags from the actual article content - use real company names, technologies, and concepts mentioned.`) : (isHebrew ? 'אל תכלול האשטגים.' : 'Do NOT include any hashtags.')}
`;
};

export {
  getGeneralLinkedInSystemPrompt,
  getGeneralLinkedInUserPrompt
};