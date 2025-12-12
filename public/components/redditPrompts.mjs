// redditPrompts.mjs
// Reddit-specific prompts optimized for community engagement
// NO emojis, NO promotional language, discussion-focused
import { buildTopicGuidance, getToneInstructions, isHebrewLanguage, getLanguageInstruction } from './linkedInPrompts.mjs';

/**
 * Generate Reddit system prompt
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The system prompt
 */
const getRedditSystemPrompt = (agentSettings = {}) => {
  const topicGuidance = buildTopicGuidance(agentSettings);
  const tone = agentSettings?.contentStyle?.tone || 'professional';
  const subreddit = agentSettings?.platformSettings?.reddit?.subreddit || 'news';
  const isHebrew = isHebrewLanguage(agentSettings);
  const languageInstruction = getLanguageInstruction(agentSettings);

  const toneStyles = {
    professional: isHebrew ? 'אינפורמטיבי ועובדתי, כמו פוסט מחוקר היטב' : 'Informative and factual, like a well-researched post',
    casual: isHebrew ? 'שיחתי, כמו לשתף חדשות מעניינות עם חברי הקהילה' : 'Conversational, like sharing interesting news with fellow community members',
    humorous: isHebrew ? 'יכול לכלול הערות קלות, אבל התוכן קודם' : 'Can include light observations, but substance comes first',
    educational: isHebrew ? 'הסברי, עוזר לקוראים להבין את ההשלכות' : 'Explanatory, helping readers understand the implications'
  };

  return `${isHebrew ? `אתה יוצר פוסט Reddit עבור r/${subreddit}. ל-Reddit יש תרבות ייחודית שמעריכה אותנטיות, תוכן ודיון קהילתי.` : `You are creating a Reddit post for r/${subreddit}. Reddit has a unique culture that values authenticity, substance, and community discussion.`}
${languageInstruction}

${isHebrew ? 'מיקוד נושאי:' : 'Topic Focus:'}
${topicGuidance}

${isHebrew ? 'טון:' : 'Tone:'} ${toneStyles[tone] || toneStyles.professional}

${isHebrew ? 'כללי Reddit קריטיים:' : 'CRITICAL REDDIT RULES:'}
1. ${isHebrew ? 'ללא אמוג׳ים - תרבות Reddit בדרך כלל לא אוהבת פוסטים עם הרבה אמוג׳ים' : 'NO EMOJIS - Reddit culture generally dislikes emoji-heavy posts'}
2. ${isHebrew ? 'ללא שפה פרסומית או שיווקית' : 'NO promotional or marketing language'}
3. ${isHebrew ? 'ללא כותרות קליקבייט' : 'NO clickbait titles'}
4. ${isHebrew ? 'כתוב כחבר קהילה שמשתף חדשות מעניינות, לא כמותג' : 'Write like a community member sharing interesting news, not a brand'}
5. ${isHebrew ? 'עודד דיון אמיתי' : 'Encourage genuine discussion'}

${isHebrew ? 'מבנה הפוסט:' : 'Post Structure:'}
${isHebrew ? 'כותרת:' : 'TITLE:'} [${isHebrew ? 'כותרת עובדתית ואינפורמטיבית - מקסימום 300 תווים' : 'Factual, informative headline - max 300 characters'}]
- ${isHebrew ? 'צריך להיות ברור ותיאורי' : 'Should be clear and descriptive'}
- ${isHebrew ? 'ציין את נקודת החדשות המרכזית ישירות' : 'State the key news point directly'}
- ${isHebrew ? 'הימנע מסנסציות' : 'Avoid sensationalism'}

${isHebrew ? 'גוף:' : 'BODY:'}
[${isHebrew ? '2-3 פסקאות ש:' : '2-3 paragraphs that:'}]
- ${isHebrew ? 'מסכמות את העובדות המרכזיות' : 'Summarize the key facts'}
- ${isHebrew ? 'מספקות הקשר רלוונטי' : 'Provide relevant context'}
- ${isHebrew ? 'מוסיפות תובנה או ניתוח משלך' : 'Add your own insight or analysis'}
- ${isHebrew ? 'מסתיימות בשאלת דיון' : 'End with a discussion question'}

**${isHebrew ? 'מקור:' : 'Source:'}** [URL]

${isHebrew ? 'דוגמת פורמט:' : 'Format Example:'}
---
${isHebrew ? 'כותרת:' : 'TITLE:'} [${isHebrew ? 'כותרת ברורה ועובדתית על החדשות' : 'Clear, factual headline about the news'}]

[${isHebrew ? 'פסקה ראשונה: מה קרה - העובדות המרכזיות' : 'First paragraph: What happened - the key facts'}]

[${isHebrew ? 'פסקה שנייה: הקשר ולמה זה חשוב' : 'Second paragraph: Context and why it matters'}]

[${isHebrew ? 'פסקה שלישית: דעתך או שאלה לדיון' : 'Third paragraph: Your take or a question for discussion'}]

**${isHebrew ? 'מקור:' : 'Source:'}** [URL]

---

${isHebrew ? 'כללים:' : 'RULES:'}
- ${isHebrew ? 'שמור על כותרת מתחת ל-300 תווים' : 'Keep title under 300 characters'}
- ${isHebrew ? 'השתמש בפורמט markdown (מודגש עם **, קישורים, וכו\')' : 'Use markdown formatting (bold with **, links, etc.)'}
- ${isHebrew ? 'לעולם אל תשתמש באמוג׳ים' : 'NEVER use emojis'}
- ${isHebrew ? 'היה אותנטי ומכוון לקהילה' : 'Be authentic and community-minded'}
- ${isHebrew ? 'כלול קישור למקור עם קידומת **מקור:**' : 'Include source URL with **Source:** prefix'}`;
};

/**
 * Generate Reddit user prompt
 * @param {Object} article - The article to create content about
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The user prompt
 */
const getRedditUserPrompt = (article, agentSettings = {}) => {
  const hasValidUrl = article.url && article.url.startsWith('http');
  const subreddit = agentSettings?.platformSettings?.reddit?.subreddit || 'news';
  const tone = agentSettings?.contentStyle?.tone || 'professional';
  const keywords = agentSettings?.keywords || [];
  const isHebrew = isHebrewLanguage(agentSettings);

  let focusContext = '';
  if (keywords.length > 0) {
    const keywordList = keywords.map(k => k.replace(/^#/, '')).join(', ');
    focusContext = isHebrew
      ? `\nנושאים רלוונטיים: ${keywordList}`
      : `\nRelevant topics: ${keywordList}`;
  }

  return `
${isHebrew ? `צור פוסט Reddit עבור r/${subreddit}:` : `CREATE A REDDIT POST FOR r/${subreddit}:`}

${isHebrew ? 'מאמר:' : 'Article:'}
${isHebrew ? 'כותרת:' : 'Title:'} ${article.title}
${hasValidUrl ? `URL: ${article.url}` : (isHebrew ? '(אין קישור זמין)' : '(No URL available)')}
${isHebrew ? 'פורסם:' : 'Published:'} ${new Date(article.publishedAt || new Date()).toLocaleString(isHebrew ? 'he-IL' : 'en-US')}
${isHebrew ? 'תקציר:' : 'Summary:'} ${article.description || article.summary || ''}
${focusContext}

${isHebrew ? 'צור פוסט Reddit עם:' : 'Create a Reddit post with:'}
1. ${isHebrew ? 'כותרת (מתחת ל-300 תווים): כותרת ברורה ועובדתית - ללא קליקבייט' : 'TITLE (under 300 chars): A clear, factual headline - NO clickbait'}
2. ${isHebrew ? 'גוף: 2-3 פסקאות שמכסות:' : 'BODY: 2-3 paragraphs covering:'}
   - ${isHebrew ? 'העובדות המרכזיות של החדשות' : 'The key news facts'}
   - ${isHebrew ? 'למה זה חשוב / הקשר רלוונטי' : 'Why it matters / relevant context'}
   - ${isHebrew ? 'שאלה לעורר דיון' : 'A question to spark discussion'}

${isHebrew ? 'קריטי:' : 'CRITICAL:'}
- ${isHebrew ? 'ללא אמוג׳ים בכלל' : 'NO EMOJIS AT ALL'}
- ${isHebrew ? 'כתוב כחבר קהילה, לא כמשווק' : 'Write like a community member, not a marketer'}
- ${isHebrew ? 'השתמש ב-markdown של Reddit: **מודגש**, *נטוי*, [טקסט קישור](url)' : 'Use Reddit markdown: **bold**, *italic*, [link text](url)'}
- ${isHebrew ? 'סיים עם שאלת דיון אמיתית' : 'End with a genuine discussion question'}
${hasValidUrl ? `- ${isHebrew ? 'כלול מקור:' : 'Include source:'} **${isHebrew ? 'מקור:' : 'Source:'}** ${article.url}` : `- ${isHebrew ? 'אין קישור זמין, אל תכלול קישור למקור' : 'No URL available, do not include source link'}`}

${isHebrew ? `הקשר תת-הרדיט היעד: r/${subreddit}` : `Target subreddit context: r/${subreddit}`}
${isHebrew ? 'התאם את הטון והמיקוד שלך לקהילה הזו.' : 'Adapt your tone and focus to fit this community.'}

${isHebrew ? 'פורמט הפלט:' : 'Output format:'}
${isHebrew ? 'כותרת:' : 'TITLE:'} [${isHebrew ? 'הכותרת שלך כאן' : 'Your title here'}]

[${isHebrew ? 'פסקאות הגוף כאן' : 'Body paragraphs here'}]

${hasValidUrl ? `**${isHebrew ? 'מקור:' : 'Source:'}** ${article.url}` : ''}
`;
};

export {
  getRedditSystemPrompt,
  getRedditUserPrompt
};
