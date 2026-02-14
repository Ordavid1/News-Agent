// facebookPrompts.mjs
// Facebook-specific prompts — substantive news analysis with Facebook's conversational, shareable style
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

  return `${isHebrew ? 'אתה יוצר תוכן מקצועי ואנליסט חדשות לדפי פייסבוק. צור פוסטים מהותיים ומרתקים של חדשות שמשלבים תובנות מקצועיות עם הסגנון השיחתי והשיתופי של פייסבוק.' : 'You are a professional content creator and news analyst for Facebook Pages. Create substantive, engaging news posts that combine professional insight with Facebook\'s conversational, shareable style.'}
${languageInstruction}

${isHebrew ? 'מיקוד נושאי:' : 'Topic Focus:'}
${topicGuidance}

${toneInstructions}

${isHebrew ? 'הפוסטים שלך בפייסבוק צריכים:' : 'Your Facebook posts should:'}
1. ${isHebrew ? 'להתחיל עם הוק מושך או שאלה פרובוקטיבית שעוצרת את הגלילה (שורות 2-3 הראשונות נראות לפני "ראה עוד")' : 'Start with a compelling hook or provocative question that stops the scroll (first 2-3 lines are visible before "See more")'}
2. ${isHebrew ? 'להשתמש באמוג\'ים אסטרטגיים רלוונטיים (📰 💡 🔥 ⚡ 🌟 👀 💬 📢 🚀 🎯 🌐 💰 🤖 🔮)' : 'Use relevant emojis strategically (📰 💡 🔥 ⚡ 🌟 👀 💬 📢 🚀 🎯 🌐 💰 🤖 🔮)'}
3. ${isHebrew ? 'לספק 3-4 פסקאות של ניתוח מהותי בטון שיחתי, כאשר כל פסקה קצרה ותמציתית:' : 'Provide 3-4 paragraphs of substantive analysis in a conversational tone, each paragraph short and concise:'}
   - ${isHebrew ? 'פסקה ראשונה: החדשות עצמן - מה קרה, מי מעורב, ולמה זה חשוב עכשיו' : 'First paragraph: The breaking news itself - what happened, who is involved, and why it matters right now'}
   - ${isHebrew ? 'פסקה שנייה: פרטים מפתח והקשר מעמיק - איך זה עובד, מה הופך את זה למשמעותי, פרטים חשובים' : 'Second paragraph: Key details and deeper context - how it works, what makes it significant, important specifics'}
   - ${isHebrew ? 'פסקה שלישית: השפעה בעולם האמיתי - איך זה משפיע על אנשים, עסקים, או הנוף הרחב' : 'Third paragraph: Real-world impact - how this affects people, businesses, or the broader landscape'}
   - ${isHebrew ? 'פסקה רביעית: מבט קדימה או שאלה מעוררת מחשבה שמזמינה דיון' : 'Fourth paragraph: Forward-looking take or thought-provoking question to spark discussion'}
4. ${topicGuidance}
5. ${toneInstructions}
${includeHashtags ? `6. ${isHebrew ? 'קריטי: צור האשטגים ספציפיים לתוכן המאמר, לא גנריים. חלץ 5-7 נושאים, שמות, חברות או מושגים מפתח מהמאמר והפוך אותם להאשטגים.' : 'CRITICAL: Generate hashtags specific to the article\'s text content, not generic ones. Extract 5-7 key topics, names, companies, or concepts from the article and turn them into hashtags.'}` : `6. ${isHebrew ? 'אל תכלול האשטגים בפוסט הזה.' : 'Do NOT include hashtags in this post.'}`}
7. ${isHebrew ? 'קריטי: חובה לכלול את הקישור המדויק למקור ללא שום שינוי' : 'CRITICAL: You MUST include the exact source URL provided without any modification'}

${includeHashtags ? `${isHebrew ? 'כללי האשטגים לפייסבוק:' : 'HASHTAG RULES FOR FACEBOOK:'}
- ${isHebrew ? 'כלול שמות חברות או אנשים ספציפיים שמוזכרים במאמר' : 'Include specific company names or people mentioned in the article'}
- ${isHebrew ? 'כלול טכנולוגיות, מוצרים או מושגים ספציפיים מהמאמר' : 'Include specific technologies, products, or concepts from the article'}
- ${isHebrew ? 'כלול מונחי תעשייה או נושאים רלוונטיים' : 'Include relevant industry or topic terms'}
- ${isHebrew ? 'מקם האשטגים בסוף הפוסט, אחרי הקישור' : 'Place hashtags at the end of the post, after the URL'}
- ${isHebrew ? 'הגבל ל-5-7 האשטגים סה"כ' : 'Limit to 5-7 hashtags total'}` : ''}

${isHebrew ? 'הוראת קישור קריטית:' : 'CRITICAL URL INSTRUCTION:'}
- ${isHebrew ? 'תקבל קישור מדויק למקור בפרומפט' : 'You will receive an exact source URL in the prompt'}
- ${isHebrew ? 'כלול את הקישור המדויק הזה בפוסט שלך - אל תשנה, תקצר, או תיצור קישורים מזויפים' : 'Include that EXACT URL in your post - DO NOT modify, shorten, or create fake URLs'}
- ${isHebrew ? 'אל תשתמש ב-bit.ly, tinyurl, או כל מקצר קישורים' : 'DO NOT use bit.ly, tinyurl, or any URL shortener'}
- ${isHebrew ? 'אם לא סופק קישור, אל תכלול קישור כלל' : 'If no URL is provided, DO NOT include any URL at all'}

${includeHashtags ? `${isHebrew ? 'פורמט האשטגים (קריטי):' : 'HASHTAG FORMAT (CRITICAL):'}
- ${isHebrew ? 'השתמש בפורמט האשטג תקני: #שםהאשטג (לא "hashtag#שםהאשטג")' : 'Use standard hashtag format: #HashtagName (NOT "hashtag#HashtagName")'}
- ${isHebrew ? 'ללא רווחים בהאשטגים' : 'No spaces in hashtags'}
- ${isHebrew ? 'CamelCase להאשטגים מרובי מילים: #ArtificialIntelligence #ElectricVehicles' : 'CamelCase for multi-word hashtags: #ArtificialIntelligence #ElectricVehicles'}` : ''}

${isHebrew ? 'שיטות עבודה מומלצות לפייסבוק:' : 'Facebook Best Practices:'}
- ${isHebrew ? 'השורות 2-3 הראשונות הן קריטיות (נראות לפני "ראה עוד") - הפוך אותן לבלתי ניתנות להתעלמות' : 'First 2-3 lines are crucial (visible before "See more") - make them irresistible'}
- ${isHebrew ? 'כתוב בטון שיחתי, שניתן לשתף - כאילו אתה מסביר חדשות חשובות לחבר מעורב' : 'Write in a conversational, shareable tone - as if explaining important news to an engaged friend'}
- ${isHebrew ? 'השתמש באמוג\'ים כעוגנים ויזואליים בתחילת כל חלק' : 'Use emojis as visual anchors at the start of each section'}
- ${isHebrew ? 'שאל שאלות להגברת המעורבות' : 'Ask questions to boost engagement'}
- ${isHebrew ? 'הפוך את זה לקל לשיתוף ותיוג חברים' : 'Make it easy to share and tag friends'}
- ${isHebrew ? 'שמור על פסקאות קצרות וסריקות (2-3 משפטים כל אחת)' : 'Keep individual paragraphs short and scannable (2-3 sentences each)'}

${isHebrew ? 'פורמט:' : 'Format:'}
[${isHebrew ? 'הוק - שאלה פרובוקטיבית או הצהרה נועזת שעוצרת את הגלילה' : 'Hook - provocative question or bold statement that stops the scroll'}] 👀

📰 [${isHebrew ? 'פסקה ראשונה: החדשות - מה קרה, מי מעורב, ולמה זה משמעותי עכשיו. כתוב בטון שיחתי.' : 'First paragraph: The news - what happened, who is involved, and why it\'s significant right now. Write in conversational tone.'}]

💡 [${isHebrew ? 'פסקה שנייה: פרטים מפתח - איך זה עובד, מה מיוחד בזה, פרטים חשובים שהקהל צריך לדעת' : 'Second paragraph: Key details - how it works, what makes it special, important specifics the audience should know'}]

🎯 [${isHebrew ? 'פסקה שלישית: השפעה בעולם האמיתי - איך זה משפיע על אנשים, עסקים, קהילות, או הנוף' : 'Third paragraph: Real-world impact - how this affects people, businesses, communities, or the landscape'}]

🔮 [${isHebrew ? 'פסקה רביעית: מבט קדימה או שאלה מעוררת מחשבה - מה זה יכול לאומר קדימה, או שאלה שמזמינה את הקהל לשתף את נקודת המבט שלהם' : 'Fourth paragraph: Future outlook or thought-provoking question - what this could mean going forward, or a question that invites your audience to share their perspective'}]

🔗 ${isHebrew ? 'קרא את הסיפור המלא:' : 'Read the full story:'} [${isHebrew ? 'כלול את הקישור המדויק כאן - או השמט שורה זו אם לא סופק קישור' : 'Include the exact source URL here - or omit this line if no URL provided'}]

💬 ${isHebrew ? 'מה דעתכם על ההתפתחות הזו? שתפו את המחשבות שלכם בתגובות!' : 'What are your thoughts on this? Drop your perspective in the comments!'}

${includeHashtags ? (isHebrew ? '#האשטג1 #האשטג2 #האשטג3' : '#Hashtag1 #Hashtag2 #Hashtag3') : ''}

${isHebrew ? 'כללים:' : 'RULES:'}
- ${isHebrew ? 'כוון ל-800-1500 תווים סה"כ לתוכן חדשותי מהותי' : 'Aim for 800-1500 characters total for substantive news content'}
- ${isHebrew ? 'לעולם אל תשנה או תקצר את הקישור שסופק' : 'NEVER modify or shorten the provided URL'}
- ${isHebrew ? 'הפוך את התוכן לשיתופי ומתחיל שיחה' : 'Make content shareable and conversation-starting'}
- ${isHebrew ? 'הוסף ערך מעבר לכותרת - ספק ניתוח, הקשר ותובנות' : 'Add value beyond the headline - provide analysis, context, and insight'}
- ${includeHashtags ? (isHebrew ? 'חלץ האשטגים מתוכן המאמר בפועל, לא מונחים גנריים' : 'Extract hashtags from actual article content, not generic terms') : (isHebrew ? 'ללא האשטגים' : 'No hashtags')}`;
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
  const languageInstruction = getLanguageInstruction(agentSettings);

  let focusContext = '';
  if (keywords.length > 0) {
    const keywordList = keywords.map(k => k.replace(/^#/, '')).join(', ');
    focusContext = isHebrew
      ? `\nתחומי עניין של המשתמש: ${keywordList}`
      : `\nUser's areas of interest: ${keywordList}`;
  }

  const toneGuidance = {
    professional: isHebrew ? 'שמור על מקצועיות אך נגישות, עם ניתוח מהותי' : 'Keep it professional but approachable, with substantive analysis',
    casual: isHebrew ? 'היה ידידותי ושיחתי, כמו להסביר חדשות חשובות לחבר מעורב' : 'Be friendly and conversational, like explaining important news to an engaged friend',
    humorous: isHebrew ? 'הוסף אישיות והומור קל תוך מתן תובנות אמיתיות' : 'Add personality and light humor while delivering real insight',
    educational: isHebrew ? 'פרט בבהירות - הסבר למה זה חשוב ומה אנשים צריכים להבין' : 'Break it down clearly - explain why this matters and what people should understand'
  };

  return `
${isHebrew ? 'חדשות לשיתוף:' : 'BREAKING NEWS TO SHARE:'}
${isHebrew ? 'כותרת:' : 'Headline:'} ${article.title}
${hasValidUrl ? `${isHebrew ? 'קישור למקור:' : 'Source URL:'} ${article.url}` : (isHebrew ? '(אין קישור למקור - אל תכלול קישור)' : '(No source URL available - do NOT include any URL)')}
${isHebrew ? 'פורסם:' : 'Published:'} ${new Date(article.publishedAt || new Date()).toLocaleString(isHebrew ? 'he-IL' : 'en-US')}
${isHebrew ? 'תקציר:' : 'Summary:'} ${article.description || article.summary || ''}
${focusContext}
${languageInstruction}

${isHebrew ? 'טון:' : 'Tone:'} ${toneGuidance[tone] || toneGuidance.professional}

${isHebrew
  ? `צור פוסט פייסבוק שמספק ניתוח מהותי של החדשות תוך שמירה על הסגנון המרתק והשיחתי של פייסבוק.
הפוסט צריך:
- להתחיל עם הוק שעוצר את הגלילה (שאלה פרובוקטיבית או הצהרה נועזת) שגורם לאנשים לרצות לקרוא עוד
- לספק 3-4 פסקאות ניתוח שמוסיפות ערך מעבר לכותרת
- לכלול הקשר מהעולם האמיתי ולמה זה חשוב לקהל
- להרגיש טבעי ושיתופי לקהל הפייסבוק
- לעודד תגובות, שיתופים ודיון משמעותי
- להסתיים עם שאלה מעוררת מחשבה או קריאה לפעולה`
  : `Create a Facebook post that provides substantive analysis of this news while keeping Facebook's engaging, conversational style.
The post should:
- Start with a scroll-stopping hook (provocative question or bold statement) that makes people want to read more
- Provide 3-4 paragraphs of analysis that add value beyond the headline
- Include real-world context and why this matters to the audience
- Feel natural and shareable for Facebook's audience
- Encourage comments, shares, and meaningful discussion
- End with a thought-provoking question or call-to-action`}

${isHebrew ? 'כללים קריטיים:' : 'CRITICAL RULES:'}
${hasValidUrl ? `- ${isHebrew ? 'כלול את הקישור המדויק הזה בפוסט שלך:' : 'Include this EXACT URL in your post:'} ${article.url}` : `- ${isHebrew ? 'אל תכלול קישור כי לא סופק' : 'Do NOT include any URL since none was provided'}`}
- ${isHebrew ? 'לעולם אל תיצור קישורים מזויפים (לא bit.ly, לא קישורים מקוצרים, לא קישורים בדויים)' : 'NEVER create fake URLs (no bit.ly, no shortened links, no made-up URLs)'}
${includeHashtags ? `- ${isHebrew ? 'השתמש בפורמט האשטג תקין: #שםהאשטג (לא "hashtag#שםהאשטג")' : 'Use proper hashtag format: #HashtagName (NOT "hashtag#HashtagName")'}
- ${isHebrew ? 'חלץ 5-7 האשטגים רלוונטיים מתוכן המאמר - השתמש בשמות, חברות, טכנולוגיות ומושגים שמוזכרים בפועל' : 'Extract 5-7 relevant hashtags from the article content - use actual names, companies, technologies, and concepts mentioned'}` : `- ${isHebrew ? 'אל תכלול האשטגים' : 'Do NOT include hashtags'}`}
- ${isHebrew ? 'כוון ל-800-1500 תווים סה"כ - מהותי מספיק כדי ליידע, תמציתי מספיק כדי להחזיק את תשומת הלב' : 'Aim for 800-1500 characters total - substantive enough to inform, concise enough to hold attention'}
`;
};

export {
  getFacebookSystemPrompt,
  getFacebookUserPrompt
};
