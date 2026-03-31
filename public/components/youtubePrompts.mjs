// youtubePrompts.mjs
// YouTube Shorts-specific prompts — clickable titles with short descriptions, optimized for the Shorts feed
import { buildTopicGuidance, getToneInstructions, isHebrewLanguage, getLanguageInstruction } from './linkedInPrompts.mjs';

/**
 * Generate YouTube Shorts system prompt
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The system prompt
 */
const getYouTubeSystemPrompt = (agentSettings = {}) => {
  const topicGuidance = buildTopicGuidance(agentSettings);
  const toneInstructions = getToneInstructions(agentSettings?.contentStyle?.tone);
  const includeHashtags = agentSettings?.contentStyle?.includeHashtags !== false;
  const isHebrew = isHebrewLanguage(agentSettings);
  const languageInstruction = getLanguageInstruction(agentSettings);

  return `${isHebrew ? 'אתה יוצר תוכן מומחה ל-YouTube Shorts, מתמחה בכתיבת כותרות וירליות ותיאורים מרתקים לסרטוני חדשות קצרים. הפורמט: שורה ראשונה = כותרת בלבד. שאר הטקסט = תיאור.' : 'You are an expert YouTube Shorts content creator, specializing in writing viral titles and engaging descriptions for short-form news videos. FORMAT: First line = title only. Everything after = description.'}
${languageInstruction}

${isHebrew ? 'מיקוד נושאי:' : 'Topic Focus:'}
${topicGuidance}

${toneInstructions}

${isHebrew ? 'YOUTUBE SHORTS — מבנה התוכן הנדרש:' : 'YOUTUBE SHORTS — Required content structure:'}

${isHebrew ? 'שורה 1 — כותרת (מחייב):' : 'Line 1 — Title (required):'}
- ${isHebrew ? 'מקסימום 80 תווים' : 'Maximum 80 characters'}
- ${isHebrew ? 'הוק שגורם לאנשים ללחוץ בפיד של Shorts — שאלה, הצהרה נועזת, או פער סקרנות' : 'A hook that makes people click in the Shorts feed — question, bold statement, or curiosity gap'}
- ${isHebrew ? 'אל תוסיף #Shorts לכותרת — המערכת מוסיפה אוטומטית' : 'Do NOT add #Shorts to the title — the system adds it automatically'}

${isHebrew ? 'שורה ריקה' : 'Blank line'}

${isHebrew ? 'תיאור — גוף הטקסט:' : 'Description — body text:'}
- ${isHebrew ? '2-3 משפטים שמספרים את עיקרי הסיפור' : '2-3 sentences telling the story essentials'}
- ${isHebrew ? 'מדוע זה חשוב — משפט משפיע אחד' : 'Why it matters — one impactful sentence'}
- ${isHebrew ? 'קריאה לפעולה — שאלה שמעודדת תגובות' : 'CTA — question that encourages comments'}
${includeHashtags ? `- ${isHebrew ? 'האשטגים: כלול #Shorts בתחילה, ואז 3-5 האשטגים ספציפיים' : 'Hashtags: include #Shorts first, then 3-5 specific hashtags'}` : `- ${isHebrew ? 'אל תכלול האשטגים (מלבד #Shorts שמחייב)' : 'Do NOT include hashtags (except the mandatory #Shorts)'}
- ${isHebrew ? 'אל תכלול האשטגים בתיאור' : 'Do not include hashtags in description'}`}

${isHebrew ? 'כללים קריטיים:' : 'CRITICAL RULES:'}
- ${isHebrew ? 'שורה ראשונה = כותרת בלבד. אף מילה נוספת בשורה הראשונה.' : 'First line = title ONLY. No additional words on the first line.'}
- ${isHebrew ? 'שורה ריקה מפרידה בין הכותרת לתיאור' : 'Blank line separates title from description'}
- ${isHebrew ? 'אין קישורים — קישורים לא עובדים בתיאורי Shorts' : 'No URLs — links do not work in Shorts descriptions'}
- ${isHebrew ? 'לעולם אל תיצור, תבדה, או תקצר קישורים' : 'NEVER create, fabricate, or shorten any URLs'}
- ${isHebrew ? 'אל תתייחס ל"סרטון" — הכיתוב הוא הטקסט מתחת לסרטון' : 'Do not reference "the video" — the caption is the text below the video'}
- ${isHebrew ? 'הכותרת חייבת לגרום לאנשים לרצות לצפות — כמו כותרת של ניוזפיד, לא כתבה' : 'Title must make people want to watch — like a newsfeed headline, not an article'}`;
};

/**
 * Generate YouTube Shorts user prompt
 * @param {Object} article - The article to create content about
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The user prompt
 */
const getYouTubeUserPrompt = (article, agentSettings = {}) => {
  const includeHashtags = agentSettings?.contentStyle?.includeHashtags !== false;
  const tone = agentSettings?.contentStyle?.tone || 'professional';
  const isHebrew = isHebrewLanguage(agentSettings);
  const languageInstruction = getLanguageInstruction(agentSettings);

  const toneGuidance = {
    professional: isHebrew ? 'סמכותי אך נגיש ומרתק' : 'Authoritative yet approachable and engaging',
    casual: isHebrew ? 'ידידותי, אותנטי, שיחתי' : 'Friendly, authentic, conversational',
    humorous: isHebrew ? 'שנינות ואישיות עם שמירה על הסיפור' : 'Wit and personality while keeping the story intact',
    educational: isHebrew ? 'פרט בבהירות — הסבר למה זה חשוב' : 'Break it down clearly — explain why it matters'
  };

  return `
${isHebrew ? 'כתבה לתוכן YouTube Shorts:' : 'ARTICLE FOR YOUTUBE SHORTS:'}
${isHebrew ? 'כותרת:' : 'Headline:'} ${article.title}
${isHebrew ? 'פורסם:' : 'Published:'} ${new Date(article.publishedAt || new Date()).toLocaleString(isHebrew ? 'he-IL' : 'en-US')}
${isHebrew ? 'תקציר:' : 'Summary:'} ${article.description || article.summary || ''}
${languageInstruction}

${isHebrew ? 'טון:' : 'Tone:'} ${toneGuidance[tone] || toneGuidance.professional}

${isHebrew
  ? `צור תוכן YouTube Shorts לסרטון חדשות קצר שנוצר מהכתבה הזו.

פורמט נדרש (חובה לשמור על מבנה זה בדיוק):
[כותרת — מקסימום 80 תווים, הוק שגורם ללחיצה]

[2-3 משפטים שמספרים את עיקרי הסיפור]

[קריאה לפעולה — שאלה שמעודדת תגובות]

${includeHashtags ? '#Shorts #האשטג2 #האשטג3' : ''}`
  : `Create YouTube Shorts content for a short news video generated from this article.

Required format (must follow this structure exactly):
[Title — max 80 chars, click-worthy hook for the Shorts feed]

[2-3 sentences telling the story essentials]

[CTA — question that encourages comments]

${includeHashtags ? '#Shorts #Hashtag2 #Hashtag3' : ''}`}

${isHebrew ? 'כללים קריטיים:' : 'CRITICAL RULES:'}
- ${isHebrew ? 'שורה 1 = כותרת בלבד (מקסימום 80 תווים)' : 'Line 1 = title ONLY (max 80 characters)'}
- ${isHebrew ? 'שורה ריקה בין הכותרת לתיאור' : 'Blank line between title and description'}
- ${isHebrew ? 'אין קישורים — אל תכלול, תיצור, או תבדה קישורים' : 'No URLs — do NOT include, create, or fabricate any URLs'}
${includeHashtags ? `- ${isHebrew ? 'כלול #Shorts כהאשטג הראשון בתיאור, ואז 3-5 האשטגים ספציפיים לתוכן' : 'Include #Shorts as the first hashtag in description, then 3-5 content-specific hashtags'}` : `- ${isHebrew ? 'אל תכלול האשטגים' : 'Do NOT include hashtags'}`}
`;
};

export {
  getYouTubeSystemPrompt,
  getYouTubeUserPrompt
};
