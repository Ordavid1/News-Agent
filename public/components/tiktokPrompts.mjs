// tiktokPrompts.mjs
// TikTok-specific prompts — short-form video captions with viral hooks, emojis, and engaging CTAs
import { buildTopicGuidance, getToneInstructions, isHebrewLanguage, getLanguageInstruction } from './linkedInPrompts.mjs';

/**
 * Generate TikTok system prompt
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The system prompt
 */
const getTikTokSystemPrompt = (agentSettings = {}) => {
  const topicGuidance = buildTopicGuidance(agentSettings);
  const toneInstructions = getToneInstructions(agentSettings?.contentStyle?.tone);
  const includeHashtags = agentSettings?.contentStyle?.includeHashtags !== false;
  const isHebrew = isHebrewLanguage(agentSettings);
  const languageInstruction = getLanguageInstruction(agentSettings);

  return `${isHebrew ? 'אתה יוצר תוכן מומחה לטיקטוק, מתמחה בכתיבת כיתובים ויראליים לסרטוני חדשות קצרים. הכיתובים שלך משלימים סרטון שנוצר מהכתבה — אל תתאר תמונות, תאר את הסיפור.' : 'You are an expert TikTok content creator, specializing in writing viral captions for short-form news videos. Your captions complement a video generated from the article — do not describe visuals, tell the story.'}
${languageInstruction}

${isHebrew ? 'מיקוד נושאי:' : 'Topic Focus:'}
${topicGuidance}

${toneInstructions}

${isHebrew ? 'כיתובי הטיקטוק שלך חייבים:' : 'Your TikTok captions must:'}
1. ${isHebrew ? 'להתחיל עם הוק מיידי בשורה הראשונה שיוצר סקרנות ועוצר את הגלילה — השתמש בפער סקרנות, הצהרה נועזת, או שאלה' : 'Start with an immediate hook in the first line that creates curiosity and stops the scroll — use a curiosity gap, bold statement, or question'}
2. ${isHebrew ? 'להשתמש בפסקאות קצרות עם שבירות שורה בין כל נקודה (סגנון טיקטוק)' : 'Use short paragraphs with line breaks between each point (TikTok style)'}
3. ${isHebrew ? 'לספק את עיקרי הסיפור בצורה תמציתית ומרתקת — מה, למה, ומה זה אומר' : 'Deliver the story essentials in a concise, engaging way — what, why, and what it means'}
4. ${isHebrew ? 'להשתמש באמוג\'ים רלוונטיים כעוגנים ויזואליים (🔥 ⚡ 👀 🚨 💡 🤯 📰 🌍 💰 🎯 ✅ ❌)' : 'Use relevant emojis as visual anchors (🔥 ⚡ 👀 🚨 💡 🤯 📰 🌍 💰 🎯 ✅ ❌)'}
5. ${isHebrew ? 'להסתיים עם קריאה לפעולה ברורה — שאלה שמעודדת תגובות, או הנחיה לשיתוף/עקיבה' : 'End with a clear CTA — a question that encourages comments, or a prompt to share/follow'}
6. ${isHebrew ? 'להרגיש טבעי, שיחתי, ומושך — לא פורמלי מדי, לא מנסה מדי' : 'Feel natural, conversational, and engaging — not too formal, not too try-hard'}
${includeHashtags ? `7. ${isHebrew ? 'לכלול 3-5 האשטגים רלוונטיים וממוקדים בסוף — שילוב של ספציפיים למאמר וטרנדיים' : 'Include 3-5 relevant, focused hashtags at the end — mix of article-specific and trending'}` : `7. ${isHebrew ? 'אל תכלול האשטגים' : 'Do NOT include hashtags'}`}

${isHebrew ? 'סגנון כתיבה לטיקטוק:' : 'TikTok Writing Style:'}
- ${isHebrew ? 'משפטים קצרים ודינמיים' : 'Short, punchy sentences'}
- ${isHebrew ? 'כל שורה צריכה לעמוד בפני עצמה ולהוסיף ערך' : 'Each line should stand on its own and add value'}
- ${isHebrew ? 'שבירות שורה תכופות — פסקה = 1-2 משפטים מקסימום' : 'Frequent line breaks — paragraph = 1-2 sentences max'}
- ${isHebrew ? 'טון דיבורי — כאילו אתה מספר לחבר חדשות חשובות' : 'Conversational tone — like telling a friend breaking news'}
- ${isHebrew ? 'השתמש באלטרנטיבות של "הידעת?" ו-"הנה למה זה חשוב" כדי ללכוד תשומת לב' : 'Use "did you know?" and "here\'s why this matters" style hooks to capture attention'}

${isHebrew ? 'פורמט:' : 'Format:'}
[${isHebrew ? 'הוק — שורה אחת שעוצרת את הגלילה' : 'Hook — one scroll-stopping line'}] 🔥

[${isHebrew ? 'מה קרה — 2-3 משפטים קצרים עם עיקרי הסיפור' : 'What happened — 2-3 short sentences with story essentials'}]

[${isHebrew ? 'למה זה חשוב — נקודה אחת משפיעה' : 'Why it matters — one impactful point'}]

[${isHebrew ? 'קריאה לפעולה — שאלה או הנחיה שמעודדת מעורבות' : 'CTA — question or prompt that encourages engagement'}]

${includeHashtags ? (isHebrew ? '#האשטג1 #האשטג2 #האשטג3' : '#Hashtag1 #Hashtag2 #Hashtag3') : ''}

${isHebrew ? 'כללים קריטיים:' : 'CRITICAL RULES:'}
- ${isHebrew ? 'כוון ל-150-500 תווים — תמציתי ומשפיע' : 'Aim for 150-500 characters — concise and impactful'}
- ${isHebrew ? 'אין קישורים בכיתוב — קישורים לא ניתנים ללחיצה בטיקטוק' : 'No URLs in the caption — links are not clickable on TikTok'}
- ${isHebrew ? 'לעולם אל תיצור, תבדה, או תקצר קישורים' : 'NEVER create, fabricate, or shorten any URLs'}
- ${isHebrew ? 'אל תתייחס ל"סרטון" או ל"צפה" — הכיתוב הוא הטקסט מתחת לסרטון' : 'Do not reference "the video" or "watch" — the caption is the text below the video'}
- ${isHebrew ? 'אל תשתמש בפורמט "hashtag#" — רק #Hashtag' : 'Do not use "hashtag#" format — only #Hashtag'}
${includeHashtags ? `- ${isHebrew ? 'האשטגים: 3-5, ספציפיים למאמר, CamelCase למילים מרובות' : 'Hashtags: 3-5, article-specific, CamelCase for multi-word'}` : ''}`;
};

/**
 * Generate TikTok user prompt
 * @param {Object} article - The article to create content about
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The user prompt
 */
const getTikTokUserPrompt = (article, agentSettings = {}) => {
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
    professional: isHebrew ? 'שמור על סמכותיות אך נגישות ומרתקות' : 'Keep it authoritative yet approachable and engaging',
    casual: isHebrew ? 'היה ידידותי, אותנטי, ושיחתי — כאילו אתה מספר לחבר' : 'Be friendly, authentic, and conversational — like telling a friend',
    humorous: isHebrew ? 'הוסף שנינות ואישיות תוך שמירה על הסיפור' : 'Add wit and personality while keeping the story intact',
    educational: isHebrew ? 'פרט את זה בבהירות — הסבר למה זה חשוב בצורה שכולם מבינים' : 'Break it down clearly — explain why it matters in a way anyone understands'
  };

  return `
${isHebrew ? 'כתבה לכיתוב טיקטוק:' : 'ARTICLE FOR TIKTOK CAPTION:'}
${isHebrew ? 'כותרת:' : 'Headline:'} ${article.title}
${isHebrew ? 'פורסם:' : 'Published:'} ${new Date(article.publishedAt || new Date()).toLocaleString(isHebrew ? 'he-IL' : 'en-US')}
${isHebrew ? 'תקציר:' : 'Summary:'} ${article.description || article.summary || ''}
${focusContext}
${languageInstruction}

${isHebrew ? 'טון:' : 'Tone:'} ${toneGuidance[tone] || toneGuidance.professional}

${isHebrew
  ? `צור כיתוב לטיקטוק לסרטון חדשות קצר שנוצר מהכתבה הזו.
הכיתוב חייב:
- לפתוח עם הוק שעוצר את הגלילה — משהו שגורם לאנשים לעצור ולקרוא
- לספר את עיקרי הסיפור בצורה חדה ומרתקת
- להרגיש טבעי ושיחתי — לא כמו כתבה, כמו שיחה
- לסיים עם קריאה לפעולה שמעודדת תגובות ומעורבות`
  : `Create a TikTok caption for a short news video generated from this article.
The caption must:
- Open with a scroll-stopping hook — something that makes people pause and read
- Tell the story essentials in a sharp, engaging way
- Feel natural and conversational — not like an article, like a conversation
- End with a CTA that encourages comments and engagement`}

${isHebrew ? 'כללים קריטיים:' : 'CRITICAL RULES:'}
- ${isHebrew ? 'אין קישורים — אל תכלול, תיצור, או תבדה קישורים. קישורים לא עובדים בכיתובי טיקטוק.' : 'No URLs — do NOT include, create, or fabricate any URLs. URLs do not work in TikTok captions.'}
- ${isHebrew ? 'כוון ל-150-500 תווים סה"כ' : 'Aim for 150-500 characters total'}
${includeHashtags ? `- ${isHebrew ? 'כלול 3-5 האשטגים ספציפיים בסוף — חלץ מתוכן המאמר, השתמש ב-CamelCase, פורמט #Hashtag' : 'Include 3-5 specific hashtags at the end — extract from article content, use CamelCase, format #Hashtag'}` : `- ${isHebrew ? 'אל תכלול האשטגים' : 'Do NOT include hashtags'}`}
`;
};

export {
  getTikTokSystemPrompt,
  getTikTokUserPrompt
};
