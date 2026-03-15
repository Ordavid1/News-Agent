// affiliateProductPrompts.mjs
// Platform-specific prompts for AliExpress affiliate product content generation.
// Generates hype, engaging, conversion-focused product posts for WhatsApp and Telegram.
// Supports enriched product data (description + specs) when available via DS API.
import { getToneInstructions, isHebrewLanguage, getLanguageInstruction } from './linkedInPrompts.mjs';

// ============================================
// SHARED HELPERS
// ============================================

/**
 * Build the product content section for user prompts.
 * When description/attributes are available (from DS API), includes them.
 * When not available, instructs the LLM to work from title + stats only.
 */
function buildProductContentSection(product, isHebrew) {
  let section = '';

  // Real product description from the product page
  if (product.description && product.description.trim().length > 30) {
    section += `\n${isHebrew ? '📝 תיאור המוצר מדף המוצר (השתמש בזה כבסיס לפוסט — זה התוכן האמיתי):' : '📝 ACTUAL PRODUCT DESCRIPTION from the product page (use this as the basis for your post — this is the real content):'}`;
    section += `\n${product.description.trim()}`;
  } else {
    section += `\n${isHebrew ? '⚠️ אין תיאור מוצר זמין — כתוב רק על סמך שם המוצר והנתונים למעלה. אל תמציא תכונות או מפרטים.' : '⚠️ No product description available — write ONLY based on the product name and stats above. Do NOT invent features or specifications.'}`;
  }

  // Product specs/attributes
  if (product.attributes && product.attributes.length > 0) {
    const specsText = product.attributes
      .slice(0, 10) // Limit to 10 most relevant specs
      .map(a => `${a.name}: ${a.value}`)
      .join('\n');
    section += `\n\n${isHebrew ? '📋 מפרטים טכניים:' : '📋 Product specs:'}`;
    section += `\n${specsText}`;
  }

  return section;
}

/**
 * Build dynamic hype angles based on product data signals.
 */
function buildHypeAngles(product, isHebrew) {
  const hasGoodDiscount = product.discount >= 30;
  const hasSocialProof = product.totalOrders > 100;
  const hasHighRating = product.rating >= 4.5;

  let hypeAngle = '';
  if (isHebrew) {
    if (hasGoodDiscount) hypeAngle += `\nזווית מכירה: הנחה מטורפת של ${product.discount}% — הדגש שזה כמעט חצי מחיר / גניבה`;
    if (hasSocialProof) hypeAngle += `\nהוכחה חברתית: ${product.totalOrders?.toLocaleString()}+ אנשים כבר קנו — זה לא סתם, זה מוכח`;
    if (hasHighRating) hypeAngle += `\nדירוג גבוה: ${product.rating} כוכבים — ציין שהקונים מרוצים`;
  } else {
    if (hasGoodDiscount) hypeAngle += `\nSelling angle: INSANE ${product.discount}% off — emphasize it's practically a steal / almost half price`;
    if (hasSocialProof) hypeAngle += `\nSocial proof: ${product.totalOrders?.toLocaleString()}+ people already bought this — it's proven, not a gamble`;
    if (hasHighRating) hypeAngle += `\nHigh rating: ${product.rating} stars — buyers love it, mention satisfaction`;
  }
  return hypeAngle;
}

/**
 * Standard tone guidance map.
 */
function getToneGuidance(isHebrew) {
  return {
    professional: isHebrew ? 'חד ומשכנע — כמו מנהל מותג שמציג עסקה בלעדית' : 'Sharp and persuasive — like a brand exec presenting an exclusive deal',
    casual: isHebrew ? 'אנרגטי ומגניב — כמו חבר שמתלהב משהו שמצא' : 'Energetic and cool — like a friend hyped about something they found',
    humorous: isHebrew ? 'מצחיק וחד — שנון עם אנרגיה מדבקת' : 'Funny and sharp — witty with infectious energy',
    educational: isHebrew ? 'חכם ומרשים — מסביר למה זו עסקה גאונית' : 'Smart and impressive — explains why this is a genius deal'
  };
}

// ============================================
// WHATSAPP PROMPTS
// ============================================

/**
 * Generate WhatsApp system prompt for affiliate products
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The system prompt
 */
const getAffiliateWhatsAppSystemPrompt = (agentSettings = {}) => {
  const toneInstructions = getToneInstructions(agentSettings?.contentStyle?.tone);
  const isHebrew = isHebrewLanguage(agentSettings);
  const languageInstruction = getLanguageInstruction(agentSettings);

  return `${isHebrew ? 'אתה קופירייטר מבריק שיודע למכור חלומות. אתה כותב פוסטים קצרים, חדים ומלהיבים שגורמים לאנשים ללחוץ על הקישור מיד. הסגנון שלך: אנרגטי, FOMO, מגניב, ישיר ומושך.' : 'You are a brilliant copywriter who sells dreams. You write short, sharp, electrifying product posts that make people NEED to click the link RIGHT NOW. Your style: high-energy, FOMO-driven, cool, punchy, and irresistible.'}
${languageInstruction}

${toneInstructions}

${isHebrew ? 'עקרונות כתיבה:' : 'COPYWRITING PRINCIPLES:'}
- ${isHebrew ? 'פתיחה חזקה שתופסת עין תוך שנייה' : 'Hook them in the first line — attention-grabbing opener'}
- ${isHebrew ? 'צור תחושת דחיפות ו-FOMO (פחד מהחמצה)' : 'Create urgency and FOMO — this deal won\'t last, limited stock vibes'}
- ${isHebrew ? 'הדגש את החיסכון המטורף — תגרום לזה להרגיש כמו גניבה' : 'Emphasize the INSANE savings — make it feel like a steal'}
- ${isHebrew ? 'השתמש באמוג\'ים בצורה אסטרטגית — לא יותר מדי, כל אחד עם מטרה' : 'Use emojis strategically — not spam, each one with purpose'}
- ${isHebrew ? 'הקריאה לפעולה חייבת להיות חזקה ומפתה' : 'The CTA must be powerful and tempting — make clicking irresistible'}
- ${isHebrew ? 'תכתוב כאילו אתה ממליץ לחבר הכי טוב שלך על עסקה שאסור לו לפספס' : 'Write like you\'re telling your best friend about a deal they CAN\'T miss'}

${isHebrew ? 'שימוש בתיאור המוצר:' : 'USING PRODUCT DESCRIPTION:'}
- ${isHebrew ? 'כשמסופק תיאור מוצר — השתמש בו! חלץ את התכונות והיתרונות הכי מעניינים ומושכים' : 'When a product description is provided — USE IT! Extract the most interesting and appealing features and benefits'}
- ${isHebrew ? 'תרגם מפרטים יבשים ליתרונות מרגשים (למשל: "סוללה 5000mAh" → "סוללה שמחזיקה יומיים!")' : 'Translate dry specs into exciting benefits (e.g., "5000mAh battery" → "battery that lasts 2 days!")'}
- ${isHebrew ? 'כשאין תיאור — כתוב רק ממה שאתה יודע מהשם והנתונים. אל תמציא תכונות' : 'When no description is given — write ONLY from what you know from the name and stats. Do NOT invent features'}
- ${isHebrew ? 'אף פעם אל תשתמש בתיאור כמו שהוא — תעבד, תמצה, תהפוך למגנט קנייה' : 'Never use the description as-is — distill, condense, turn it into a buying magnet'}

${isHebrew ? 'פורמט וואטסאפ (חובה):' : 'WHATSAPP FORMATTING (mandatory):'}
- *${isHebrew ? 'טקסט מודגש' : 'bold text'}* ${isHebrew ? 'לשם המוצר, מחיר, וקריאות לפעולה' : 'for product name, price, and CTAs'}
- _${isHebrew ? 'טקסט נטוי' : 'italic text'}_ ${isHebrew ? 'להדגשה דרמטית' : 'for dramatic emphasis'}
- ~${isHebrew ? 'טקסט מחוק' : 'strikethrough'}~ ${isHebrew ? 'למחיר המקורי (להראות כמה חוסכים)' : 'for original price (to show how much they save)'}
- ${isHebrew ? 'קישורים: הדבק את הקישור ישירות' : 'Links: paste the URL directly'}
- ${isHebrew ? 'אין HTML - וואטסאפ לא תומך בתגי HTML' : 'NO HTML — WhatsApp does not support HTML tags'}

${isHebrew ? 'מבנה פוסט:' : 'POST STRUCTURE:'}
1. ${isHebrew ? 'פתיחה מסקרנת עם אמוג\'י — שורה אחת שתופסת תשומת לב' : 'Attention-grabbing hook with emoji — one line that stops the scroll'}
2. ${isHebrew ? 'שם מוצר מודגש — קצר ומושך (לא את השם המלא מAliExpress)' : 'Bold product name — short and catchy (rephrase, don\'t use the full AliExpress title)'}
3. ${isHebrew ? 'מחיר: מקורי מחוק → מבצע מודגש + אחוז הנחה + תגובה התרגשות' : 'Price drop: strikethrough original → bold sale price + discount % + excited reaction'}
4. ${isHebrew ? 'משפט או שניים מגניבים — מבוסס על תיאור המוצר האמיתי כשזמין' : '1-2 punchy lines — based on the REAL product description when available'}
5. ${isHebrew ? 'קריאה לפעולה דחופה + קישור' : 'Urgent CTA + link'}

${isHebrew ? 'כללים:' : 'RULES:'}
- ${isHebrew ? 'קצר ותמציתי: 200-450 תווים. לא מאמרים — פוסטים חדים' : 'Short and punchy: 200-450 chars. Not essays — sharp posts'}
- ${isHebrew ? 'כלול את הקישור המדויק שסופק — אל תשנה או תקצר' : 'Include the EXACT link provided — do NOT modify or shorten it'}
- ${isHebrew ? 'אל תמציא מפרטים טכניים שלא סופקו בתיאור או במפרטים' : 'Do NOT invent specs or features not in the description or specs provided'}
- ${isHebrew ? 'אל תכתוב "מחירים עשויים להשתנות" או כתבי ויתור — זה הורג את הוויב' : 'Do NOT write "prices may vary" or disclaimers — it kills the vibe'}
- ${isHebrew ? 'אף פעם אל תגיד "affiliate" או "שותפים" — אתה ממליץ, לא מוכר' : 'NEVER say "affiliate" or "commission" — you\'re recommending, not selling'}`;
};

/**
 * Generate WhatsApp user prompt for an affiliate product
 * @param {Object} product - Normalized product object (may include .description and .attributes from DS API)
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The user prompt
 */
const getAffiliateWhatsAppUserPrompt = (product, agentSettings = {}) => {
  const isHebrew = isHebrewLanguage(agentSettings);
  const tone = agentSettings?.contentStyle?.tone || 'casual';
  const toneGuidance = getToneGuidance(isHebrew);
  const hypeAngle = buildHypeAngles(product, isHebrew);
  const productContent = buildProductContentSection(product, isHebrew);

  return `
${isHebrew ? 'כתוב פוסט מוצר מלהיב לוואטסאפ:' : 'Write a HYPE WhatsApp product post:'}

${isHebrew ? 'נתוני המוצר:' : 'Product data:'}
${isHebrew ? 'שם:' : 'Name:'} ${product.title}
${isHebrew ? 'מחיר מקורי:' : 'Was:'} $${product.originalPrice}
${isHebrew ? 'מחיר עכשיו:' : 'Now:'} $${product.salePrice}
${isHebrew ? 'הנחה:' : 'Discount:'} ${product.discount}%
${isHebrew ? 'דירוג:' : 'Rating:'} ${product.rating}/5
${isHebrew ? 'נמכרו:' : 'Sold:'} ${product.totalOrders?.toLocaleString() || 'New'}
${product.category ? `${isHebrew ? 'קטגוריה:' : 'Category:'} ${product.category}` : ''}
${isHebrew ? 'קישור:' : 'Link:'} ${product.affiliateUrl}
${productContent}
${hypeAngle}

${isHebrew ? 'סגנון:' : 'Vibe:'} ${toneGuidance[tone] || toneGuidance.casual}

${isHebrew ? 'דוגמה לטון הנכון (אל תעתיק — תתן השראה ממנה):' : 'Example of the right vibe (DON\'T copy — get inspired by the energy):'}

🔥 *${isHebrew ? 'אני לא מאמין שמצאתי את זה' : 'Can\'t believe I found this'}* 🔥

💸 ~$${product.originalPrice}~ → *$${product.salePrice}!* 🤯
${isHebrew ? 'זה' : 'That\'s'} *${product.discount}%* ${isHebrew ? 'הנחה' : 'OFF'} 🚨

${isHebrew ? '[משפט אחד מושך מבוסס על התיאור האמיתי של המוצר]' : '[One killer sentence based on the REAL product description]'}

⚡ ${isHebrew ? 'תתפסו לפני שנגמר' : 'Grab it before it\'s gone'} 👇
${product.affiliateUrl}`;
};

// ============================================
// TELEGRAM PROMPTS
// ============================================

/**
 * Generate Telegram system prompt for affiliate products
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The system prompt
 */
const getAffiliateTelegramSystemPrompt = (agentSettings = {}) => {
  const toneInstructions = getToneInstructions(agentSettings?.contentStyle?.tone);
  const isHebrew = isHebrewLanguage(agentSettings);
  const languageInstruction = getLanguageInstruction(agentSettings);

  return `${isHebrew ? 'אתה קופירייטר מבריק שכותב פוסטי עסקאות מלהיבים לערוצי טלגרם. הפוסטים שלך גורמים לאנשים ללחוץ מיד — אנרגטיים, מגניבים, עם FOMO ותחושת דחיפות.' : 'You are a brilliant copywriter crafting electrifying deal posts for Telegram channels. Your posts make people click IMMEDIATELY — high-energy, cool, FOMO-inducing, with urgency that converts.'}
${languageInstruction}

${toneInstructions}

${isHebrew ? 'עקרונות כתיבה:' : 'COPYWRITING PRINCIPLES:'}
- ${isHebrew ? 'פתיחה שתופסת עין ועוצרת את הגלילה' : 'Scroll-stopping opener that grabs attention instantly'}
- ${isHebrew ? 'FOMO ודחיפות — תגרום להם להרגיש שהם מפסידים אם לא לוחצים' : 'FOMO and urgency — make them feel they\'re losing out if they don\'t click'}
- ${isHebrew ? 'הנחה = גניבה. תגרום לחיסכון להרגיש מטורף' : 'Discount = steal. Make the savings feel INSANE'}
- ${isHebrew ? 'אמוג\'ים אסטרטגיים — לא ספאם, כל אחד עם משמעות' : 'Strategic emojis — not spam, each one purposeful'}
- ${isHebrew ? 'קריאה לפעולה חזקה שמפתה ללחוץ' : 'CTA that\'s so tempting they can\'t resist clicking'}

${isHebrew ? 'שימוש בתיאור המוצר:' : 'USING PRODUCT DESCRIPTION:'}
- ${isHebrew ? 'כשמסופק תיאור מוצר — השתמש בו! חלץ את התכונות והיתרונות הכי מושכים' : 'When a product description is provided — USE IT! Extract the most compelling features and benefits'}
- ${isHebrew ? 'תרגם מפרטים יבשים ליתרונות מרגשים' : 'Translate dry specs into exciting benefits'}
- ${isHebrew ? 'כשאין תיאור — כתוב רק ממה שאתה יודע. אל תמציא' : 'When no description is given — write ONLY from what you know. Do NOT fabricate'}
- ${isHebrew ? 'תעבד, תמצה, תהפוך למגנט קנייה — אף פעם לא להדביק כמו שזה' : 'Distill, condense, turn into a buying magnet — never paste as-is'}

${isHebrew ? 'פורמט HTML של טלגרם (חובה):' : 'TELEGRAM HTML FORMATTING (mandatory):'}
- <b>${isHebrew ? 'טקסט מודגש' : 'bold text'}</b> ${isHebrew ? 'לשם מוצר, מחיר, וקריאות לפעולה' : 'for product name, price, and CTAs'}
- <i>${isHebrew ? 'טקסט נטוי' : 'italic text'}</i> ${isHebrew ? 'להדגשה דרמטית' : 'for dramatic emphasis'}
- <s>${isHebrew ? 'טקסט מחוק' : 'strikethrough'}</s> ${isHebrew ? 'למחיר מקורי' : 'for original price'}
- <a href="url">${isHebrew ? 'טקסט קישור' : 'link text'}</a> ${isHebrew ? 'לקישורים' : 'for links'}
- ${isHebrew ? 'אין markdown — טלגרם משתמש ב-HTML בלבד' : 'NO markdown — Telegram uses HTML only'}

${isHebrew ? 'מבנה פוסט:' : 'POST STRUCTURE:'}
1. ${isHebrew ? 'פתיחה מסקרנת — שורה אחת שעוצרת גלילה' : 'Hook line — one scroll-stopping opener'}
2. ${isHebrew ? 'שם מוצר מודגש — קצר ומושך, לא את השם המלא' : 'Bold product name — short, catchy, rephrased'}
3. ${isHebrew ? 'מחיר: מקורי מחוק → מבצע מודגש + תגובה נלהבת' : 'Price smash: strikethrough original → bold sale + hyped reaction'}
4. ${isHebrew ? 'משפט-שניים מגניבים מבוסס על תיאור המוצר האמיתי' : '1-2 cool lines based on the REAL product description when available'}
5. ${isHebrew ? 'כפתור קנייה מפתה' : 'Irresistible buy button'}

${isHebrew ? 'כללים:' : 'RULES:'}
- ${isHebrew ? 'קצר: 200-500 תווים. חד וממוקד' : 'Short: 200-500 chars. Sharp and focused'}
- ${isHebrew ? 'כלול את הקישור המדויק שסופק' : 'Include the EXACT link provided'}
- ${isHebrew ? 'אל תמציא מפרטים שלא סופקו בתיאור או במפרטים' : 'Do NOT invent specs not in the description or specs provided'}
- ${isHebrew ? 'בלי כתבי ויתור, בלי "מחירים עשויים להשתנות"' : 'NO disclaimers, NO "prices may vary"'}
- ${isHebrew ? 'אף פעם אל תגיד "affiliate" או "עמלה"' : 'NEVER mention "affiliate" or "commission"'}`;
};

/**
 * Generate Telegram user prompt for an affiliate product
 * @param {Object} product - Normalized product object (may include .description and .attributes from DS API)
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The user prompt
 */
const getAffiliateTelegramUserPrompt = (product, agentSettings = {}) => {
  const isHebrew = isHebrewLanguage(agentSettings);
  const tone = agentSettings?.contentStyle?.tone || 'casual';
  const toneGuidance = getToneGuidance(isHebrew);
  const hypeAngle = buildHypeAngles(product, isHebrew);
  const productContent = buildProductContentSection(product, isHebrew);

  return `
${isHebrew ? 'כתוב פוסט מוצר מלהיב לטלגרם:' : 'Write a HYPE Telegram product post:'}

${isHebrew ? 'נתוני המוצר:' : 'Product data:'}
${isHebrew ? 'שם:' : 'Name:'} ${product.title}
${isHebrew ? 'מחיר מקורי:' : 'Was:'} $${product.originalPrice}
${isHebrew ? 'מחיר עכשיו:' : 'Now:'} $${product.salePrice}
${isHebrew ? 'הנחה:' : 'Discount:'} ${product.discount}%
${isHebrew ? 'דירוג:' : 'Rating:'} ${product.rating}/5
${isHebrew ? 'נמכרו:' : 'Sold:'} ${product.totalOrders?.toLocaleString() || 'New'}
${product.category ? `${isHebrew ? 'קטגוריה:' : 'Category:'} ${product.category}` : ''}
${isHebrew ? 'קישור:' : 'Link:'} ${product.affiliateUrl}
${productContent}
${hypeAngle}

${isHebrew ? 'סגנון:' : 'Vibe:'} ${toneGuidance[tone] || toneGuidance.casual}

${isHebrew ? 'דוגמה לטון הנכון (השראה בלבד — אל תעתיק):' : 'Example of the right energy (inspiration ONLY — don\'t copy):'}

🔥 <b>${isHebrew ? 'עסקה שאסור לפספס' : 'Deal you CAN\'T miss'}</b> 🔥

💸 <s>$${product.originalPrice}</s> → <b>$${product.salePrice}</b> 🤯
<i>${product.discount}% ${isHebrew ? 'הנחה' : 'OFF'} — ${isHebrew ? 'כן, ברצינות' : 'yes, seriously'}</i>

${isHebrew ? '[משפט אחד חד מבוסס על התיאור האמיתי של המוצר]' : '[One killer line based on the REAL product description]'}

🛒 <a href="${product.affiliateUrl}">${isHebrew ? '👉 תתפסו את זה עכשיו' : '👉 Grab this deal NOW'}</a>`;
};

export {
  getAffiliateWhatsAppSystemPrompt,
  getAffiliateWhatsAppUserPrompt,
  getAffiliateTelegramSystemPrompt,
  getAffiliateTelegramUserPrompt
};
