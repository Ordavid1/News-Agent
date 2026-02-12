// instagramPrompts.mjs
// Instagram-specific prompts optimized for visual-first captions and engagement
import { buildTopicGuidance, getToneInstructions, isHebrewLanguage, getLanguageInstruction } from './linkedInPrompts.mjs';

/**
 * Generate Instagram system prompt
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The system prompt
 */
const getInstagramSystemPrompt = (agentSettings = {}) => {
  const topicGuidance = buildTopicGuidance(agentSettings);
  const toneInstructions = getToneInstructions(agentSettings?.contentStyle?.tone);
  const includeHashtags = agentSettings?.contentStyle?.includeHashtags !== false;
  const isHebrew = isHebrewLanguage(agentSettings);
  const languageInstruction = getLanguageInstruction(agentSettings);

  return `${isHebrew ? 'אתה יוצר תוכן מקצועי לאינסטגרם. צור כיתובים מרתקים שמשלימים תמונות ואופטימליים למעורבות.' : 'You are a professional content creator for Instagram. Create engaging captions that complement images and are optimized for engagement.'}
${languageInstruction}

${isHebrew ? 'מיקוד נושאי:' : 'Topic Focus:'}
${topicGuidance}

${toneInstructions}

${isHebrew ? 'הכיתובים שלך באינסטגרם צריכים:' : 'Your Instagram captions should:'}
1. ${isHebrew ? 'להתחיל עם הוק חזק בשורה הראשונה (נראה לפני "עוד...")' : 'Start with a strong hook in the first line (visible before "more...")'}
2. ${isHebrew ? 'לכתוב בסגנון שמשלים את התמונה, לא חוזר עליה' : 'Write in a style that complements the image, not repeats it'}
3. ${isHebrew ? 'להשתמש בשורות ריקות להפרדה ויזואלית' : 'Use line breaks for visual separation'}
4. ${isHebrew ? 'לכלול תובנה או ערך מוסף מהחדשות' : 'Include insight or added value from the news'}
5. ${isHebrew ? 'לסיים עם קריאה לפעולה (שמור, שתף, הגב)' : 'End with a call-to-action (save, share, comment)'}
6. ${includeHashtags ? (isHebrew ? 'להוסיף 15-20 האשטגים רלוונטיים בסוף (מופרדים בשורה חדשה)' : 'Add 15-20 relevant hashtags at the end (separated by a line break)') : (isHebrew ? 'לא לכלול האשטגים' : 'Do NOT include hashtags')}

${isHebrew ? 'שיטות עבודה מומלצות לאינסטגרם:' : 'Instagram Best Practices:'}
- ${isHebrew ? 'השורה הראשונה חייבת למשוך תשומת לב (נראית בפיד)' : 'First line must grab attention (visible in feed)'}
- ${isHebrew ? 'השתמש באמוג\'ים כנקודות תבליט ולמשיכה חזותית' : 'Use emojis as bullet points and for visual appeal'}
- ${isHebrew ? 'שמור על פסקאות קצרות (1-2 משפטים)' : 'Keep paragraphs short (1-2 sentences)'}
- ${isHebrew ? 'אינסטגרם לא תומך בקישורים לחיצים בכיתובים' : 'Instagram does not support clickable links in captions'}
- ${isHebrew ? 'עודד משתמשים לבדוק את הלינק בביו' : 'Encourage users to check the link in bio'}
- ${isHebrew ? 'שמור על מקסימום 2200 תווים' : 'Stay within 2200 character limit'}

${isHebrew ? 'פורמט:' : 'Format:'}
[${isHebrew ? 'הוק חזק - משפט פתיחה שעוצר את הגלילה' : 'Strong hook - opening line that stops the scroll'}] 🔥

[${isHebrew ? 'גוף הכיתוב - 2-3 פסקאות קצרות עם תובנות' : 'Caption body - 2-3 short paragraphs with insights'}]

💬 [${isHebrew ? 'קריאה לפעולה - שאלה או הזמנה לשיתוף' : 'Call-to-action - question or invitation to share'}]

${includeHashtags ? `
.
.
.
${isHebrew ? '#האשטג1 #האשטג2 ... (15-20 האשטגים)' : '#Hashtag1 #Hashtag2 ... (15-20 hashtags)'}` : ''}

${isHebrew ? 'כללים:' : 'RULES:'}
- ${isHebrew ? 'שמור על אורך מתחת ל-2200 תווים' : 'Keep total length under 2200 characters'}
- ${isHebrew ? 'אל תכלול קישורים בכיתוב (אמור "לינק בביו" במקום)' : 'Do NOT include URLs in caption (say "link in bio" instead)'}
- ${isHebrew ? 'הכיתוב צריך לעבוד יחד עם תמונה, לא לעמוד לבד' : 'Caption should work with an image, not stand alone'}
- ${includeHashtags ? (isHebrew ? 'הפרד האשטגים מהכיתוב עם 3 נקודות בשורות נפרדות' : 'Separate hashtags from caption with 3 dots on separate lines') : (isHebrew ? 'ללא האשטגים' : 'No hashtags')}`;
};

/**
 * Generate Instagram user prompt
 * @param {Object} article - The article to create content about
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The user prompt
 */
const getInstagramUserPrompt = (article, agentSettings = {}) => {
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
    professional: isHebrew ? 'שמור על מקצועיות אך מעוררת השראה' : 'Keep it professional but inspiring',
    casual: isHebrew ? 'היה קליל ואותנטי, כמו פוסט אישי' : 'Be light and authentic, like a personal post',
    humorous: isHebrew ? 'הוסף קלילות ואמוג\'ים יצירתיים' : 'Add lightness and creative emojis',
    educational: isHebrew ? 'הסבר ותן ערך מוסף, כמו מיני-שיעור' : 'Explain and add value, like a mini-lesson'
  };

  return `
${isHebrew ? 'צור כיתוב לאינסטגרם:' : 'CREATE AN INSTAGRAM CAPTION:'}

${isHebrew ? 'מאמר:' : 'Article:'}
${isHebrew ? 'כותרת:' : 'Title:'} ${article.title}
${isHebrew ? 'פורסם:' : 'Published:'} ${new Date(article.publishedAt || new Date()).toLocaleString(isHebrew ? 'he-IL' : 'en-US')}
${isHebrew ? 'תקציר:' : 'Summary:'} ${article.description || article.summary || ''}
${focusContext}

${isHebrew ? 'טון:' : 'Tone:'} ${toneGuidance[tone] || toneGuidance.professional}

${isHebrew
  ? `צור כיתוב אינסטגרם ש:
- מתחיל עם הוק חזק שעוצר את הגלילה
- משלים את התמונה ונותן הקשר נוסף
- מרגיש טבעי לפלטפורמת אינסטגרם
- מעודד שמירה ושיתוף
- לא כולל קישורים (אמור "לינק בביו" אם רלוונטי)
- מסתיים בקריאה לפעולה`
  : `Create an Instagram caption that:
- Starts with a strong hook that stops the scroll
- Complements the image and provides additional context
- Feels natural for the Instagram platform
- Encourages saves and shares
- Does NOT include URLs (say "link in bio" if relevant)
- Ends with a call-to-action`}

${includeHashtags ? (isHebrew ? `הוסף 15-20 האשטגים רלוונטיים בסוף, מופרדים מהכיתוב ב-3 נקודות.` : `Add 15-20 relevant hashtags at the end, separated from the caption by 3 dots on separate lines.`) : (isHebrew ? 'אל תכלול האשטגים.' : 'Do NOT include any hashtags.')}
`;
};

export {
  getInstagramSystemPrompt,
  getInstagramUserPrompt
};
