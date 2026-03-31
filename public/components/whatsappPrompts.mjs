// whatsappPrompts.mjs
// WhatsApp-specific prompts with WhatsApp formatting for group messaging
import { buildTopicGuidance, getToneInstructions, isHebrewLanguage, getLanguageInstruction } from './linkedInPrompts.mjs';

/**
 * Generate WhatsApp system prompt
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The system prompt
 */
const getWhatsAppSystemPrompt = (agentSettings = {}) => {
  const topicGuidance = buildTopicGuidance(agentSettings);
  const toneInstructions = getToneInstructions(agentSettings?.contentStyle?.tone);
  const includeHashtags = agentSettings?.contentStyle?.includeHashtags !== false;
  const isHebrew = isHebrewLanguage(agentSettings);
  const languageInstruction = getLanguageInstruction(agentSettings);

  return `${isHebrew ? 'אתה כתב חדשות מקצועי לקבוצות וואטסאפ. צור עדכוני חדשות מרתקים ותמציתיים שמותאמים לפורמט הנייד של וואטסאפ ולקהל שלו.' : 'You are a professional news correspondent for WhatsApp groups. Create engaging, concise news updates optimized for WhatsApp\'s mobile-first format and audience.'}
${languageInstruction}

${isHebrew ? 'מיקוד נושאי:' : 'Topic Focus:'}
${topicGuidance}

${toneInstructions}

${isHebrew ? 'פורמט וואטסאפ (השתמש באלה):' : 'WHATSAPP FORMATTING (use these):'}
- *${isHebrew ? 'טקסט מודגש' : 'bold text'}* ${isHebrew ? 'להדגשה וכותרות' : 'for emphasis and headlines'}
- _${isHebrew ? 'טקסט נטוי' : 'italic text'}_ ${isHebrew ? 'לציטוטים או הדגשה עדינה' : 'for quotes or subtle emphasis'}
- ~${isHebrew ? 'טקסט מחוק' : 'strikethrough'}~ ${isHebrew ? 'לתיקונים' : 'for corrections'}
- ${isHebrew ? 'קישורים: פשוט הדבק את הקישור - וואטסאפ מזהה אוטומטית' : 'Links: just paste the URL - WhatsApp auto-links them'}
- ${isHebrew ? 'השתמש בשורות ריקות לקריאות' : 'Use line breaks for readability'}
- ${isHebrew ? 'אין HTML - וואטסאפ לא תומך בתגי HTML' : 'NO HTML - WhatsApp does not support HTML tags'}

${isHebrew ? 'מבנה הפוסט:' : 'Post Structure:'}
1. ${isHebrew ? 'כותרת מודגשת עם אמוג׳י רלוונטי' : 'Bold headline with relevant emoji'}
2. ${isHebrew ? '2-3 פסקאות קצרות עם מידע מפתח' : '2-3 short paragraphs with key information'}
3. ${isHebrew ? 'קישור למקור (URL ישיר, ללא עטיפת HTML)' : 'Source link (direct URL, no HTML wrapping)'}
4. ${includeHashtags ? (isHebrew ? 'האשטגים לגילוי' : 'Hashtags for discoverability') : (isHebrew ? 'ללא האשטגים' : 'No hashtags')}

${isHebrew ? 'מגבלות תווים:' : 'CHARACTER LIMITS:'}
- ${isHebrew ? 'הודעות רגילות: מקסימום 4096 תווים' : 'Regular messages: 4096 characters max'}
- ${isHebrew ? 'כיתובי תמונות: מקסימום 1024 תווים' : 'Photo captions: 1024 characters max'}
- ${isHebrew ? 'שמור על פוסטים תמציתיים: 300-800 תווים אידיאלי' : 'Keep posts concise: 300-800 characters is ideal'}

${isHebrew ? 'הוראת קישור קריטית:' : 'CRITICAL URL INSTRUCTION:'}
- ${isHebrew ? 'תקבל קישור מדויק למקור בפרומפט' : 'You will receive an exact source URL in the prompt'}
- ${isHebrew ? 'כלול את הקישור המדויק הזה בפוסט שלך - אל תשנה, תקצר, או תיצור קישורים מזויפים' : 'Include that EXACT URL in your post - DO NOT modify, shorten, or create fake URLs'}
- ${isHebrew ? 'אל תשתמש ב-bit.ly, tinyurl, או כל מקצר קישורים' : 'DO NOT use bit.ly, tinyurl, or any URL shortener'}
- ${isHebrew ? 'אם לא סופק קישור, אל תכלול קישור כלל' : 'If no URL is provided, DO NOT include any URL at all'}

${isHebrew ? 'פורמט:' : 'Format:'}
📰 *[${isHebrew ? 'כותרת' : 'Headline'}]*

[${isHebrew ? 'פסקה ראשונה: עובדות החדשות המרכזיות - 2-3 משפטים' : 'First paragraph: Key news facts - 2-3 sentences'}]

[${isHebrew ? 'פסקה שנייה: הקשר או השלכות - 2-3 משפטים' : 'Second paragraph: Context or implications - 2-3 sentences'}]

🔗 [${isHebrew ? 'קישור ישיר למקור' : 'Direct source URL'}]

${includeHashtags ? (isHebrew ? '#האשטג1 #האשטג2 #האשטג3' : '#Hashtag1 #Hashtag2 #Hashtag3') : ''}

${isHebrew ? 'כללים:' : 'RULES:'}
- ${isHebrew ? 'השתמש בפורמט וואטסאפ (*מודגש*, _נטוי_), לא HTML ולא markdown' : 'Use WhatsApp formatting (*bold*, _italic_), NOT HTML and NOT markdown'}
- ${isHebrew ? 'שמור על זה תמציתי וניתן לסריקה - אנשים קוראים בנייד' : 'Keep it concise and scannable - people read on mobile'}
- ${isHebrew ? 'השתמש באמוג׳ים במידה למשיכה חזותית (📰 💡 🔥 ⚡ 🌐 📢)' : 'Use emojis sparingly for visual appeal (📰 💡 🔥 ⚡ 🌐 📢)'}
- ${isHebrew ? 'הדבק את הקישור המדויק למקור ישירות - וואטסאפ יציג תצוגה מקדימה אוטומטית' : 'Paste the exact source URL directly - WhatsApp will auto-preview it'}
- ${includeHashtags ? (isHebrew ? 'הוסף 3-5 האשטגים רלוונטיים בסוף' : 'Add 3-5 relevant hashtags at the end') : (isHebrew ? 'אל תכלול האשטגים' : 'Do NOT include hashtags')}`;
};

/**
 * Generate WhatsApp user prompt
 * @param {Object} article - The article to create content about
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The user prompt
 */
const getWhatsAppUserPrompt = (article, agentSettings = {}) => {
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
${isHebrew ? 'צור פוסט לקבוצת וואטסאפ:' : 'CREATE A WHATSAPP GROUP POST:'}

${isHebrew ? 'מאמר:' : 'Article:'}
${isHebrew ? 'כותרת:' : 'Title:'} ${article.title}
${hasValidUrl ? `URL: ${article.url}` : (isHebrew ? '(אין קישור זמין)' : '(No URL available)')}
${isHebrew ? 'פורסם:' : 'Published:'} ${new Date(article.publishedAt || new Date()).toLocaleString(isHebrew ? 'he-IL' : 'en-US')}
${isHebrew ? 'תקציר:' : 'Summary:'} ${article.description || article.summary || ''}

${isHebrew ? 'טון:' : 'Tone:'} ${toneGuidance[tone] || toneGuidance.professional}

${isHebrew
  ? `צור הודעת וואטסאפ ש:
- משתמשת בפורמט וואטסאפ (*מודגש*, _נטוי_) - לא HTML
- מתחילה עם אמוג׳י וכותרת מודגשת
- יש לה 2-3 פסקאות קצרות וניתנות לסריקה
- תמציתית (300-800 תווים אידיאלי, מקסימום 1500)
- מותאמת לקריאה בנייד`
  : `Create a WhatsApp message that:
- Uses WhatsApp formatting (*bold*, _italic_) - NOT HTML
- Starts with an emoji and bold headline
- Has 2-3 short, scannable paragraphs
- Is concise (300-800 characters ideal, max 1500)
- Is optimized for mobile reading`}

${isHebrew ? 'כללים קריטיים:' : 'CRITICAL RULES:'}
${hasValidUrl ? `- ${isHebrew ? 'כלול את הקישור המדויק הזה בפוסט שלך:' : 'Include this EXACT URL in your post:'} ${article.url}` : `- ${isHebrew ? 'אל תכלול קישור כי לא סופק' : 'Do NOT include any URL since none was provided'}`}
- ${isHebrew ? 'לעולם אל תיצור קישורים מזויפים (לא bit.ly, לא קישורים מקוצרים, לא קישורים בדויים)' : 'NEVER create fake URLs (no bit.ly, no shortened links, no made-up URLs)'}
- ${isHebrew ? 'אל תשתמש בתגי HTML - וואטסאפ לא תומך בהם' : 'Do NOT use HTML tags - WhatsApp does not support them'}

${includeHashtags ? (isHebrew ? `הוסף 3-5 האשטגים בסוף, שחולצו מתוכן המאמר.` : `Add 3-5 hashtags at the end, extracted from article content.`) : (isHebrew ? 'אל תכלול האשטגים.' : 'Do NOT include any hashtags.')}

${isHebrew ? 'פלט בפורמט וואטסאפ:' : 'Output using WhatsApp format:'}
📰 *[${isHebrew ? 'כותרת' : 'Headline'}]*

[${isHebrew ? 'פסקה 1' : 'Paragraph 1'}]

[${isHebrew ? 'פסקה 2' : 'Paragraph 2'}]

${hasValidUrl ? `🔗 ${article.url}` : ''}

${includeHashtags ? (isHebrew ? '#האשטגים #כאן' : '#Hashtags #Here') : ''}
`;
};

/**
 * Generate WhatsApp caption prompt (shorter, for photos)
 * @param {Object} article - The article to create content about
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The caption prompt
 */
const getWhatsAppCaptionPrompt = (article, agentSettings = {}) => {
  const hasValidUrl = article.url && article.url.startsWith('http');
  const includeHashtags = agentSettings?.contentStyle?.includeHashtags !== false;
  const isHebrew = isHebrewLanguage(agentSettings);

  return `
${isHebrew ? 'צור כיתוב קצר לתמונת וואטסאפ (מקסימום 1024 תווים):' : 'CREATE A SHORT WHATSAPP PHOTO CAPTION (MAX 1024 CHARACTERS):'}

${isHebrew ? 'מאמר:' : 'Article:'} ${article.title}
${hasValidUrl ? `URL: ${article.url}` : ''}

${isHebrew ? 'צור כיתוב קצר מאוד:' : 'Create a very short caption:'}
- ${isHebrew ? 'כותרת מודגשת אחת עם אמוג׳י (השתמש ב-*מודגש* לא HTML)' : 'One bold headline with emoji (use *bold* not HTML)'}
- ${isHebrew ? '1-2 משפטים שמסכמים את החדשות' : '1-2 sentences summarizing the news'}
- ${isHebrew ? 'קישור למקור אם סופק URL' : 'Source link if URL provided'}
- ${includeHashtags ? (isHebrew ? '2-3 האשטגים' : '2-3 hashtags') : (isHebrew ? 'ללא האשטגים' : 'No hashtags')}

${isHebrew ? 'חייב להיות מתחת ל-1024 תווים.' : 'MUST be under 1024 characters total.'}
${isHebrew ? 'אל תשתמש בתגי HTML - השתמש בפורמט וואטסאפ בלבד (*מודגש*, _נטוי_).' : 'Do NOT use HTML tags - use WhatsApp formatting only (*bold*, _italic_).'}

${isHebrew ? 'פורמט:' : 'Format:'}
📰 *[${isHebrew ? 'כותרת קצרה' : 'Short headline'}]*

[${isHebrew ? 'סיכום של 1-2 משפטים' : '1-2 sentence summary'}]

${hasValidUrl ? `🔗 ${article.url}` : ''}
${includeHashtags ? (isHebrew ? '#תג1 #תג2' : '#Tag1 #Tag2') : ''}
`;
};

export {
  getWhatsAppSystemPrompt,
  getWhatsAppUserPrompt,
  getWhatsAppCaptionPrompt
};
