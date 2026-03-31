// telegramPrompts.mjs
// Telegram-specific prompts with HTML formatting for channels
import { buildTopicGuidance, getToneInstructions, isHebrewLanguage, getLanguageInstruction } from './linkedInPrompts.mjs';

/**
 * Generate Telegram system prompt
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The system prompt
 */
const getTelegramSystemPrompt = (agentSettings = {}) => {
  const topicGuidance = buildTopicGuidance(agentSettings);
  const toneInstructions = getToneInstructions(agentSettings?.contentStyle?.tone);
  const includeHashtags = agentSettings?.contentStyle?.includeHashtags !== false;
  const isHebrew = isHebrewLanguage(agentSettings);
  const languageInstruction = getLanguageInstruction(agentSettings);

  return `${isHebrew ? 'אתה כתב חדשות מקצועי עבור ערוץ טלגרם. צור עדכוני חדשות מרתקים שמותאמים לפורמט ולקהל של טלגרם.' : 'You are a professional news correspondent for a Telegram channel. Create engaging news updates optimized for Telegram\'s format and audience.'}
${languageInstruction}

${isHebrew ? 'מיקוד נושאי:' : 'Topic Focus:'}
${topicGuidance}

${toneInstructions}

${isHebrew ? 'פורמט HTML של טלגרם (השתמש באלה):' : 'TELEGRAM HTML FORMATTING (use these):'}
- <b>${isHebrew ? 'טקסט מודגש' : 'bold text'}</b> ${isHebrew ? 'להדגשה וכותרות' : 'for emphasis and headlines'}
- <i>${isHebrew ? 'טקסט נטוי' : 'italic text'}</i> ${isHebrew ? 'לציטוטים או הדגשה עדינה' : 'for quotes or subtle emphasis'}
- <a href="URL">${isHebrew ? 'טקסט קישור' : 'link text'}</a> ${isHebrew ? 'להיפרלינקים' : 'for hyperlinks'}
- <code>${isHebrew ? 'קוד inline' : 'inline code'}</code> ${isHebrew ? 'למונחים טכניים' : 'for technical terms'}
- ${isHebrew ? 'השתמש בשורות ריקות לקריאות' : 'Use line breaks for readability'}

${isHebrew ? 'מבנה הפוסט:' : 'Post Structure:'}
1. ${isHebrew ? 'כותרת מודגשת עם אמוג׳י רלוונטי' : 'Bold headline with relevant emoji'}
2. ${isHebrew ? '2-3 פסקאות קצרות עם מידע מפתח' : '2-3 short paragraphs with key information'}
3. ${isHebrew ? 'קישור למקור' : 'Source link'}
4. ${includeHashtags ? (isHebrew ? 'האשטגים לגילוי' : 'Hashtags for discoverability') : (isHebrew ? 'ללא האשטגים' : 'No hashtags')}

${isHebrew ? 'מגבלות תווים:' : 'CHARACTER LIMITS:'}
- ${isHebrew ? 'הודעות רגילות: מקסימום 4096 תווים' : 'Regular messages: 4096 characters max'}
- ${isHebrew ? 'כיתובי תמונות: מקסימום 1024 תווים' : 'Photo captions: 1024 characters max'}
- ${isHebrew ? 'שמור על פוסטים תמציתיים: 300-600 תווים אידיאלי' : 'Keep posts concise: 300-600 characters is ideal'}

${isHebrew ? 'פורמט:' : 'Format:'}
📰 <b>[${isHebrew ? 'כותרת' : 'Headline'}]</b>

[${isHebrew ? 'פסקה ראשונה: עובדות החדשות המרכזיות - 2-3 משפטים' : 'First paragraph: Key news facts - 2-3 sentences'}]

[${isHebrew ? 'פסקה שנייה: הקשר או השלכות - 2-3 משפטים' : 'Second paragraph: Context or implications - 2-3 sentences'}]

🔗 <a href="[URL]">${isHebrew ? 'קרא עוד' : 'Read more'}</a>

${includeHashtags ? (isHebrew ? '#האשטג1 #האשטג2 #האשטג3' : '#Hashtag1 #Hashtag2 #Hashtag3') : ''}

${isHebrew ? 'כללים:' : 'RULES:'}
- ${isHebrew ? 'השתמש בתגי HTML לפורמט, לא markdown' : 'Use HTML tags for formatting, NOT markdown'}
- ${isHebrew ? 'שמור על זה תמציתי וניתן לסריקה' : 'Keep it concise and scannable'}
- ${isHebrew ? 'השתמש באמוג׳ים במידה למשיכה חזותית (📰 💡 🔥 ⚡ 🌐 📢)' : 'Use emojis sparingly for visual appeal (📰 💡 🔥 ⚡ 🌐 📢)'}
- ${isHebrew ? 'כלול את הקישור המדויק למקור בתג <a>' : 'Include the exact source URL in an <a> tag'}
- ${includeHashtags ? (isHebrew ? 'הוסף 3-5 האשטגים רלוונטיים בסוף' : 'Add 3-5 relevant hashtags at the end') : (isHebrew ? 'אל תכלול האשטגים' : 'Do NOT include hashtags')}`;
};

/**
 * Generate Telegram user prompt
 * @param {Object} article - The article to create content about
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The user prompt
 */
const getTelegramUserPrompt = (article, agentSettings = {}) => {
  const hasValidUrl = article.url && article.url.startsWith('http');
  const includeHashtags = agentSettings?.contentStyle?.includeHashtags !== false;
  const tone = agentSettings?.contentStyle?.tone || 'professional';
  const isHebrew = isHebrewLanguage(agentSettings);

  const toneGuidance = {
    professional: isHebrew ? 'סמכותי ואינפורמטיבי' : 'Authoritative and informative',
    casual: isHebrew ? 'שיחתי ומרתק' : 'Conversational and engaging',
    humorous: isHebrew ? 'קליל ושנון במקום המתאים' : 'Light and witty where appropriate',
    educational: isHebrew ? 'הסברים ברורים להקשר' : 'Clear explanations for context'
  };

  return `
${isHebrew ? 'צור פוסט לערוץ טלגרם:' : 'CREATE A TELEGRAM CHANNEL POST:'}

${isHebrew ? 'מאמר:' : 'Article:'}
${isHebrew ? 'כותרת:' : 'Title:'} ${article.title}
${hasValidUrl ? `URL: ${article.url}` : (isHebrew ? '(אין קישור זמין)' : '(No URL available)')}
${isHebrew ? 'פורסם:' : 'Published:'} ${new Date(article.publishedAt || new Date()).toLocaleString(isHebrew ? 'he-IL' : 'en-US')}
${isHebrew ? 'תקציר:' : 'Summary:'} ${article.description || article.summary || ''}

${isHebrew ? 'טון:' : 'Tone:'} ${toneGuidance[tone] || toneGuidance.professional}

${isHebrew
  ? `צור פוסט טלגרם ש:
- משתמש בפורמט HTML (<b>, <i>, <a href="">)
- מתחיל עם אמוג׳י וכותרת מודגשת
- יש לו 2-3 פסקאות קצרות וניתנות לסריקה
- תמציתי (300-600 תווים אידיאלי, מקסימום 1000)`
  : `Create a Telegram post that:
- Uses HTML formatting (<b>, <i>, <a href="">)
- Starts with an emoji and bold headline
- Has 2-3 short, scannable paragraphs
- Is concise (300-600 characters ideal, max 1000)`}

${hasValidUrl ? `${isHebrew ? 'כלול קישור למקור באמצעות HTML:' : 'Include source link using HTML:'}
<a href="${article.url}">${isHebrew ? 'קרא עוד' : 'Read more'}</a>` : (isHebrew ? 'אל תכלול קישור כי לא סופק URL.' : 'Do NOT include any link since no URL was provided.')}

${includeHashtags ? (isHebrew ? `הוסף 3-5 האשטגים בסוף, שחולצו מתוכן המאמר.` : `Add 3-5 hashtags at the end, extracted from article content.`) : (isHebrew ? 'אל תכלול האשטגים.' : 'Do NOT include any hashtags.')}

${isHebrew ? 'פלט בפורמט HTML של טלגרם:' : 'Output using Telegram HTML format:'}
📰 <b>[${isHebrew ? 'כותרת' : 'Headline'}]</b>

[${isHebrew ? 'פסקה 1' : 'Paragraph 1'}]

[${isHebrew ? 'פסקה 2' : 'Paragraph 2'}]

${hasValidUrl ? `🔗 <a href="${article.url}">${isHebrew ? 'קרא עוד' : 'Read more'}</a>` : ''}

${includeHashtags ? (isHebrew ? '#האשטגים #כאן' : '#Hashtags #Here') : ''}
`;
};

/**
 * Generate Telegram caption prompt (shorter, for photos)
 * @param {Object} article - The article to create content about
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The caption prompt
 */
const getTelegramCaptionPrompt = (article, agentSettings = {}) => {
  const hasValidUrl = article.url && article.url.startsWith('http');
  const includeHashtags = agentSettings?.contentStyle?.includeHashtags !== false;
  const isHebrew = isHebrewLanguage(agentSettings);

  return `
${isHebrew ? 'צור כיתוב קצר לתמונת טלגרם (מקסימום 1024 תווים):' : 'CREATE A SHORT TELEGRAM PHOTO CAPTION (MAX 1024 CHARACTERS):'}

${isHebrew ? 'מאמר:' : 'Article:'} ${article.title}
${hasValidUrl ? `URL: ${article.url}` : ''}

${isHebrew ? 'צור כיתוב קצר מאוד:' : 'Create a very short caption:'}
- ${isHebrew ? 'כותרת מודגשת אחת עם אמוג׳י' : 'One bold headline with emoji'}
- ${isHebrew ? '1-2 משפטים שמסכמים את החדשות' : '1-2 sentences summarizing the news'}
- ${isHebrew ? 'קישור למקור אם סופק URL' : 'Source link if URL provided'}
- ${includeHashtags ? (isHebrew ? '2-3 האשטגים' : '2-3 hashtags') : (isHebrew ? 'ללא האשטגים' : 'No hashtags')}

${isHebrew ? 'חייב להיות מתחת ל-1024 תווים.' : 'MUST be under 1024 characters total.'}

${isHebrew ? 'פורמט:' : 'Format:'}
📰 <b>[${isHebrew ? 'כותרת קצרה' : 'Short headline'}]</b>

[${isHebrew ? 'סיכום של 1-2 משפטים' : '1-2 sentence summary'}]

${hasValidUrl ? `🔗 <a href="${article.url}">${isHebrew ? 'קרא עוד' : 'Read more'}</a>` : ''}
${includeHashtags ? (isHebrew ? '#תג1 #תג2' : '#Tag1 #Tag2') : ''}
`;
};

export {
  getTelegramSystemPrompt,
  getTelegramUserPrompt,
  getTelegramCaptionPrompt
};
