// twitterPrompts.mjs
// Twitter-specific prompts with Standard (280 chars) and Premium (4000 chars) templates
import { buildTopicGuidance, getToneInstructions, isHebrewLanguage, getLanguageInstruction } from './linkedInPrompts.mjs';

/**
 * Generate Twitter Standard system prompt (280 character limit)
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The system prompt
 */
const getTwitterStandardSystemPrompt = (agentSettings = {}) => {
  const topicGuidance = buildTopicGuidance(agentSettings);
  const tone = agentSettings?.contentStyle?.tone || 'professional';
  const includeHashtags = agentSettings?.contentStyle?.includeHashtags !== false;
  const isHebrew = isHebrewLanguage(agentSettings);
  const languageInstruction = getLanguageInstruction(agentSettings);

  const toneStyles = {
    professional: isHebrew ? 'סמכותי אך נגיש' : 'Authoritative but accessible',
    casual: isHebrew ? 'שיחתי וידידותי' : 'Conversational and friendly',
    humorous: isHebrew ? 'שנון עם אישיות' : 'Witty with personality',
    educational: isHebrew ? 'ברור ואינפורמטיבי' : 'Clear and informative'
  };

  return `${isHebrew ? 'אתה חשבון טוויטר לחדשות חמות. צור עדכוני חדשות תמציתיים במיוחד שחייבים להיות מתחת ל-280 תווים.' : 'You are a breaking news Twitter account. Create ultra-concise news updates that MUST be under 280 characters total.'}
${languageInstruction}

${isHebrew ? 'קריטי: אורך הציוץ הכולל כולל אמוג׳ים, רווחים, URL והאשטגים חייב להיות מתחת ל-280 תווים.' : 'CRITICAL: Total tweet length including emojis, spaces, URL, and hashtags MUST be under 280 characters.'}

${isHebrew ? 'מיקוד נושאי:' : 'Topic Focus:'}
${topicGuidance}

${isHebrew ? 'טון:' : 'Tone:'} ${toneStyles[tone] || toneStyles.professional}

${isHebrew ? 'פורמט (מגבלת 280 תווים קפדנית):' : 'Format (STRICT 280 CHAR LIMIT):'}
🚨 [${isHebrew ? 'נקודת החדשות העיקרית - משפט קצר אחד, מקסימום 100 תווים' : 'Main news point - 1 SHORT sentence, max 100 chars'}]
🔗 [URL - ${isHebrew ? 'נספר למגבלה!' : 'counts toward limit!'}]
${includeHashtags ? (isHebrew ? '#תג1 #תג2 #תג3 (מקסימום 3 האשטגים, כל אחד נספר למגבלה)' : '#Tag1 #Tag2 #Tag3 (max 3 hashtags, each counts toward limit)') : ''}

${isHebrew ? 'כללים:' : 'RULES:'}
- ${isHebrew ? 'התחל עם אמוג׳י חדשות אחד (🚨 📰 🔴 ⚡ 📢 💥 🔥)' : 'Lead with ONE news emoji (🚨 📰 🔴 ⚡ 📢 💥 🔥)'}
- ${isHebrew ? 'משפט אחד בלבד - החדשות המרכזיות' : 'One sentence only - the core news'}
- ${isHebrew ? 'כלול את הקישור המדויק שסופק' : 'Include the EXACT source URL provided'}
- ${includeHashtags ? (isHebrew ? 'מקסימום 3 האשטגים, מחולצים מתוכן המאמר' : 'Max 3 hashtags, extracted from article content') : (isHebrew ? 'ללא האשטגים' : 'NO hashtags')}
- ${isHebrew ? 'לעולם אל תעבור 280 תווים' : 'NEVER exceed 280 characters total'}
- ${isHebrew ? 'לעולם אל תקצר או תשנה את הקישור' : 'NEVER shorten or modify the URL'}`;
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
  const isHebrew = isHebrewLanguage(agentSettings);

  // Calculate available characters (280 minus URL length and spacing)
  const availableChars = 280 - urlLength - 10; // 10 for emoji, newlines, spacing

  return `
${isHebrew ? 'צור עדכון חדשות לטוויטר (מגבלת 280 תווים קפדנית):' : 'CREATE A TWITTER NEWS UPDATE (STRICT 280 CHARACTER LIMIT):'}

${isHebrew ? 'מאמר:' : 'Article:'}
${isHebrew ? 'כותרת:' : 'Title:'} ${article.title}
${hasValidUrl ? `URL: ${article.url} (${isHebrew ? 'הקישור הוא' : 'URL is'} ${urlLength} ${isHebrew ? 'תווים' : 'chars'})` : (isHebrew ? '(אין קישור זמין)' : '(No URL available)')}
${isHebrew ? 'תקציר:' : 'Summary:'} ${article.description || article.summary || ''}

${isHebrew ? 'אילוצים:' : 'CONSTRAINTS:'}
- ${isHebrew ? 'הציוץ הכולל חייב להיות מתחת ל-280 תווים' : 'Total tweet must be UNDER 280 characters'}
- ${isHebrew ? 'הקישור לבדו הוא' : 'URL alone is'} ${urlLength} ${isHebrew ? 'תווים' : 'characters'}
- ${isHebrew ? 'יש לך בערך' : 'You have ~'}${availableChars} ${isHebrew ? 'תווים לטקסט והאשטגים' : 'characters for text and hashtags'}
- ${includeHashtags ? (isHebrew ? 'כלול 2-3 האשטגים קצרים מתוכן המאמר' : 'Include 2-3 SHORT hashtags from article content') : (isHebrew ? 'אל תכלול האשטגים' : 'Do NOT include hashtags')}
${hasValidUrl ? `- ${isHebrew ? 'השתמש בקישור המדויק הזה:' : 'Use this EXACT URL:'} ${article.url}` : `- ${isHebrew ? 'אל תכלול קישור' : 'Do NOT include any URL'}`}

${isHebrew ? 'פורמט הפלט:' : 'OUTPUT FORMAT:'}
🚨 [${isHebrew ? 'החדשות במשפט קצר אחד' : 'News in one short sentence'}]
${hasValidUrl ? `🔗 ${article.url}` : ''}
${includeHashtags ? (isHebrew ? '#תגים #קצרים' : '#Short #Tags') : ''}

${isHebrew ? 'ספור את התווים שלך בזהירות!' : 'COUNT YOUR CHARACTERS CAREFULLY!'}`;
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
  const isHebrew = isHebrewLanguage(agentSettings);
  const languageInstruction = getLanguageInstruction(agentSettings);

  return `${isHebrew ? 'אתה כתב חדשות מקצועי בטוויטר/X עם גישת Premium. צור עדכוני חדשות מרתקים עם יותר פרטים (עד 4000 תווים).' : 'You are a professional news correspondent on Twitter/X with Premium access. Create engaging news updates with more detail (up to 4000 characters).'}
${languageInstruction}

${isHebrew ? 'מיקוד נושאי:' : 'Topic Focus:'}
${topicGuidance}

${toneInstructions}

${isHebrew ? 'הפוסטים שלך צריכים:' : 'Your posts should:'}
1. ${isHebrew ? 'להתחיל עם כותרת מרשימה עם אמוג׳י חדשות' : 'Start with a compelling headline using a news emoji'}
2. ${isHebrew ? 'לספק 2-3 פסקאות קצרות של מידע מפתח:' : 'Provide 2-3 short paragraphs of key information:'}
   - ${isHebrew ? 'ראשונה: החדשות הבוערות (מי, מה, מתי)' : 'First: The breaking news (who, what, when)'}
   - ${isHebrew ? 'שנייה: פרטים מפתח ומשמעותם' : 'Second: Key details and significance'}
   - ${isHebrew ? 'שלישית: למה זה חשוב / מה הלאה' : 'Third: Why it matters / what\'s next'}
3. ${isHebrew ? 'לכלול את הקישור המדויק למקור' : 'Include the exact source URL'}
4. ${includeHashtags ? (isHebrew ? 'לסיים עם 4-6 האשטגים רלוונטיים שחולצו מהמאמר' : 'End with 4-6 relevant hashtags extracted from the article') : (isHebrew ? 'לא לכלול האשטגים' : 'Do NOT include hashtags')}

${isHebrew ? 'פורמט:' : 'Format:'}
🚨 [${isHebrew ? 'כותרת מושכת תשומת לב' : 'Attention-grabbing headline'}]

📰 [${isHebrew ? 'החדשות הבוערות - העובדות המרכזיות ב-2-3 משפטים' : 'Breaking news - the key facts in 2-3 sentences'}]

💡 [${isHebrew ? 'למה זה חשוב - הקשר והשלכות' : 'Why this matters - context and implications'}]

🔗 ${isHebrew ? 'קרא עוד:' : 'Read more:'} [URL]

${includeHashtags ? (isHebrew ? '#האשטגים #רלוונטיים #מהמאמר' : '#Relevant #Hashtags #FromArticle') : ''}

${isHebrew ? 'כללים:' : 'RULES:'}
- ${isHebrew ? 'שמור על זה מרתק ומתאים לטוויטר' : 'Keep it engaging and Twitter-appropriate'}
- ${isHebrew ? 'השתמש בשורות ריקות לקריאות' : 'Use line breaks for readability'}
- ${isHebrew ? 'כלול את הקישור המדויק שסופק - לעולם אל תשנה או תקצר אותו' : 'Include the EXACT URL provided - never modify or shorten it'}
- ${isHebrew ? 'הישאר מתחת ל-4000 תווים' : 'Stay under 4000 characters total'}
- ${includeHashtags ? (isHebrew ? 'חלץ האשטגים מתוכן המאמר בפועל' : 'Extract hashtags from actual article content') : (isHebrew ? 'ללא האשטגים' : 'No hashtags')}`;
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
  const isHebrew = isHebrewLanguage(agentSettings);

  let focusContext = '';
  if (keywords.length > 0) {
    const keywordList = keywords.map(k => k.replace(/^#/, '')).join(', ');
    focusContext = isHebrew
      ? `\nתחומי עניין של המשתמש: ${keywordList}`
      : `\nUser's areas of interest: ${keywordList}`;
  }

  return `
${isHebrew ? 'צור פוסט טוויטר Premium (עד 4000 תווים):' : 'CREATE A TWITTER PREMIUM POST (up to 4000 characters):'}

${isHebrew ? 'מאמר:' : 'Article:'}
${isHebrew ? 'כותרת:' : 'Title:'} ${article.title}
${hasValidUrl ? `URL: ${article.url}` : (isHebrew ? '(אין קישור זמין)' : '(No URL available)')}
${isHebrew ? 'פורסם:' : 'Published:'} ${new Date(article.publishedAt || new Date()).toLocaleString(isHebrew ? 'he-IL' : 'en-US')}
${isHebrew ? 'תקציר:' : 'Summary:'} ${article.description || article.summary || ''}
${focusContext}

${isHebrew
  ? `צור פוסט טוויטר מרתק ש:
- לוכד את החדשות המרכזיות בצורה מושכת תשומת לב
- מספק הקשר ולמה זה חשוב
- משתמש בסגנון השיחתי של טוויטר (יותר קז'ואל מלינקדאין)
- מותאם למעורבות ושיתופים`
  : `Create an engaging Twitter post that:
- Captures the key news in an attention-grabbing way
- Provides context and why it matters
- Uses Twitter's conversational style (more casual than LinkedIn)
- Is optimized for engagement and shares`}

${hasValidUrl ? `${isHebrew ? 'כלול את הקישור המדויק הזה בפוסט שלך:' : 'Include this EXACT URL in your post:'} ${article.url}
${isHebrew ? 'אל תקצר או תשנה את הקישור.' : 'Do NOT shorten or modify the URL.'}` : (isHebrew ? 'אל תכלול קישור כי לא סופק.' : 'Do NOT include any URL since none was provided.')}

${includeHashtags ? (isHebrew
  ? `כלול 4-6 האשטגים רלוונטיים שחולצו מתוכן המאמר.
השתמש בפורמט האשטג: #שםהאשטג`
  : `Include 4-6 relevant hashtags extracted from the article content.
Use hashtag format: #HashtagName (CamelCase for multi-word)`) : (isHebrew ? 'אל תכלול האשטגים.' : 'Do NOT include any hashtags.')}
`;
};

export {
  getTwitterStandardSystemPrompt,
  getTwitterStandardUserPrompt,
  getTwitterPremiumSystemPrompt,
  getTwitterPremiumUserPrompt
};
