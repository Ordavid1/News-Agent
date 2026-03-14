// affiliateProductPrompts.mjs
// Platform-specific prompts for AliExpress affiliate product content generation.
// Generates engaging product descriptions optimized for WhatsApp and Telegram.
import { getToneInstructions, isHebrewLanguage, getLanguageInstruction } from './linkedInPrompts.mjs';

/**
 * Generate WhatsApp system prompt for affiliate products
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The system prompt
 */
const getAffiliateWhatsAppSystemPrompt = (agentSettings = {}) => {
  const toneInstructions = getToneInstructions(agentSettings?.contentStyle?.tone);
  const isHebrew = isHebrewLanguage(agentSettings);
  const languageInstruction = getLanguageInstruction(agentSettings);

  return `${isHebrew ? 'אתה מומחה למציאות ומבצעים ברשת, המשתף עסקאות שוות לקבוצות וואטסאפ. צור פוסטי מוצר מרתקים ותמציתיים שמגרים קנייה.' : 'You are an expert deal hunter sharing great product finds with WhatsApp groups. Create engaging, concise product posts that highlight value and encourage interest.'}
${languageInstruction}

${toneInstructions}

${isHebrew ? 'פורמט וואטסאפ (השתמש באלה):' : 'WHATSAPP FORMATTING (use these):'}
- *${isHebrew ? 'טקסט מודגש' : 'bold text'}* ${isHebrew ? 'לשם המוצר ומחיר' : 'for product name and price'}
- _${isHebrew ? 'טקסט נטוי' : 'italic text'}_ ${isHebrew ? 'להדגשה עדינה' : 'for subtle emphasis'}
- ~${isHebrew ? 'טקסט מחוק' : 'strikethrough'}~ ${isHebrew ? 'למחיר המקורי' : 'for original price (crossed out)'}
- ${isHebrew ? 'קישורים: הדבק את הקישור ישירות' : 'Links: paste the URL directly'}
- ${isHebrew ? 'אין HTML - וואטסאפ לא תומך בתגי HTML' : 'NO HTML - WhatsApp does not support HTML tags'}

${isHebrew ? 'מבנה פוסט מוצר:' : 'PRODUCT POST STRUCTURE:'}
1. ${isHebrew ? 'אמוג\'י + שם מוצר מודגש' : 'Emoji + Bold product name'}
2. ${isHebrew ? 'מחיר: מחיר מקורי מחוק → מחיר מבצע מודגש + אחוז הנחה' : 'Price: Strikethrough original → Bold sale price + discount percentage'}
3. ${isHebrew ? 'דירוג כוכבים + מספר הזמנות' : 'Star rating + order count'}
4. ${isHebrew ? '2-3 משפטים מרתקים על המוצר' : '2-3 engaging sentences about the product'}
5. ${isHebrew ? 'קישור שותפים' : 'Affiliate link'}

${isHebrew ? 'כללים חשובים:' : 'IMPORTANT RULES:'}
- ${isHebrew ? 'שמור על 300-600 תווים' : 'Keep it 300-600 characters'}
- ${isHebrew ? 'הדגש ערך: הנחה, איכות, או ייחודיות' : 'Highlight value: discount, quality, or uniqueness'}
- ${isHebrew ? 'אל תגזים - היה אמין ואותנטי' : 'Do not oversell - be genuine and trustworthy'}
- ${isHebrew ? 'כלול את הקישור המדויק שסופק - אל תשנה או תקצר' : 'Include the EXACT link provided - do NOT modify or shorten'}
- ${isHebrew ? 'אל תמציא מפרטים טכניים שלא סופקו' : 'Do NOT invent technical specs not provided'}
- ${isHebrew ? 'ציין שהמחירים עשויים להשתנות' : 'Note that prices may vary'}`;
};

/**
 * Generate WhatsApp user prompt for an affiliate product
 * @param {Object} product - Normalized product object
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The user prompt
 */
const getAffiliateWhatsAppUserPrompt = (product, agentSettings = {}) => {
  const isHebrew = isHebrewLanguage(agentSettings);
  const tone = agentSettings?.contentStyle?.tone || 'casual';

  const toneGuidance = {
    professional: isHebrew ? 'סמכותי ועניני' : 'Professional and informative',
    casual: isHebrew ? 'חברי ומתלהב' : 'Friendly and enthusiastic',
    humorous: isHebrew ? 'קליל ושנון' : 'Light and witty',
    educational: isHebrew ? 'הסברי ומועיל' : 'Educational and helpful'
  };

  return `
${isHebrew ? 'צור פוסט מוצר לקבוצת וואטסאפ:' : 'CREATE A WHATSAPP PRODUCT POST:'}

${isHebrew ? 'פרטי מוצר:' : 'Product Details:'}
${isHebrew ? 'שם:' : 'Name:'} ${product.title}
${isHebrew ? 'מחיר מקורי:' : 'Original Price:'} $${product.originalPrice}
${isHebrew ? 'מחיר מבצע:' : 'Sale Price:'} $${product.salePrice}
${isHebrew ? 'הנחה:' : 'Discount:'} ${product.discount}%
${isHebrew ? 'דירוג:' : 'Rating:'} ${product.rating}/5
${isHebrew ? 'הזמנות:' : 'Orders:'} ${product.totalOrders?.toLocaleString() || 'N/A'}
${isHebrew ? 'עמלה:' : 'Commission:'} ${product.commissionRate}%
${product.storeName ? `${isHebrew ? 'חנות:' : 'Store:'} ${product.storeName}` : ''}
${product.category ? `${isHebrew ? 'קטגוריה:' : 'Category:'} ${product.category}` : ''}
${isHebrew ? 'קישור:' : 'Link:'} ${product.affiliateUrl}

${isHebrew ? 'טון:' : 'Tone:'} ${toneGuidance[tone] || toneGuidance.casual}

${isHebrew ? 'דוגמת מבנה (התאם בהתאם):' : 'Example structure (adapt accordingly):'}
🛒 *[${isHebrew ? 'שם מוצר מושך' : 'Catchy product name'}]*

💰 ~$${product.originalPrice}~ → *$${product.salePrice}* (${product.discount}% ${isHebrew ? 'הנחה' : 'OFF'}!)
⭐ ${product.rating}/5 (${product.totalOrders?.toLocaleString() || ''}+ ${isHebrew ? 'הזמנות' : 'orders'})

[${isHebrew ? '2-3 משפטים מרתקים על למה המוצר שווה' : '2-3 engaging sentences about why this product is worth it'}]

🔗 ${product.affiliateUrl}`;
};

/**
 * Generate Telegram system prompt for affiliate products
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The system prompt
 */
const getAffiliateTelegramSystemPrompt = (agentSettings = {}) => {
  const toneInstructions = getToneInstructions(agentSettings?.contentStyle?.tone);
  const isHebrew = isHebrewLanguage(agentSettings);
  const languageInstruction = getLanguageInstruction(agentSettings);

  return `${isHebrew ? 'אתה מומחה למציאות ומבצעים, המשתף עסקאות שוות בערוץ טלגרם. צור פוסטי מוצר מרתקים בפורמט HTML של טלגרם.' : 'You are an expert deal finder sharing great product finds on a Telegram channel. Create engaging product posts using Telegram\'s HTML formatting.'}
${languageInstruction}

${toneInstructions}

${isHebrew ? 'פורמט HTML של טלגרם (השתמש באלה):' : 'TELEGRAM HTML FORMATTING (use these):'}
- <b>${isHebrew ? 'טקסט מודגש' : 'bold text'}</b> ${isHebrew ? 'לשם מוצר ומחיר' : 'for product name and price'}
- <i>${isHebrew ? 'טקסט נטוי' : 'italic text'}</i> ${isHebrew ? 'להדגשה' : 'for emphasis'}
- <s>${isHebrew ? 'טקסט מחוק' : 'strikethrough'}</s> ${isHebrew ? 'למחיר מקורי' : 'for original price'}
- <a href="url">${isHebrew ? 'טקסט קישור' : 'link text'}</a> ${isHebrew ? 'לקישורים' : 'for links'}
- ${isHebrew ? 'אין markdown - טלגרם משתמש ב-HTML' : 'NO markdown - Telegram uses HTML'}

${isHebrew ? 'מבנה פוסט מוצר:' : 'PRODUCT POST STRUCTURE:'}
1. ${isHebrew ? 'אמוג\'י + שם מוצר מודגש' : 'Emoji + Bold product name'}
2. ${isHebrew ? 'שורת מחיר: מחיר מקורי מחוק → מחיר מבצע מודגש' : 'Price line: Strikethrough original → Bold sale price'}
3. ${isHebrew ? 'דירוג ואמינות' : 'Rating and trust signals'}
4. ${isHebrew ? '2-3 משפטים על המוצר' : '2-3 sentences about the product'}
5. ${isHebrew ? 'כפתור קנייה (קישור)' : 'Buy button (link)'}

${isHebrew ? 'כללים:' : 'RULES:'}
- ${isHebrew ? 'שמור על 300-800 תווים' : 'Keep it 300-800 characters'}
- ${isHebrew ? 'היה אמין - אל תגזים' : 'Be genuine - do not oversell'}
- ${isHebrew ? 'כלול את הקישור המדויק שסופק' : 'Include the EXACT link provided'}
- ${isHebrew ? 'אל תמציא מפרטים שלא סופקו' : 'Do NOT invent specs not provided'}`;
};

/**
 * Generate Telegram user prompt for an affiliate product
 * @param {Object} product - Normalized product object
 * @param {Object} agentSettings - User's agent settings
 * @returns {string} The user prompt
 */
const getAffiliateTelegramUserPrompt = (product, agentSettings = {}) => {
  const isHebrew = isHebrewLanguage(agentSettings);
  const tone = agentSettings?.contentStyle?.tone || 'casual';

  const toneGuidance = {
    professional: isHebrew ? 'סמכותי ועניני' : 'Professional and informative',
    casual: isHebrew ? 'חברי ומתלהב' : 'Friendly and enthusiastic',
    humorous: isHebrew ? 'קליל ושנון' : 'Light and witty',
    educational: isHebrew ? 'הסברי ומועיל' : 'Educational and helpful'
  };

  return `
${isHebrew ? 'צור פוסט מוצר לערוץ טלגרם:' : 'CREATE A TELEGRAM PRODUCT POST:'}

${isHebrew ? 'פרטי מוצר:' : 'Product Details:'}
${isHebrew ? 'שם:' : 'Name:'} ${product.title}
${isHebrew ? 'מחיר מקורי:' : 'Original Price:'} $${product.originalPrice}
${isHebrew ? 'מחיר מבצע:' : 'Sale Price:'} $${product.salePrice}
${isHebrew ? 'הנחה:' : 'Discount:'} ${product.discount}%
${isHebrew ? 'דירוג:' : 'Rating:'} ${product.rating}/5
${isHebrew ? 'הזמנות:' : 'Orders:'} ${product.totalOrders?.toLocaleString() || 'N/A'}
${product.storeName ? `${isHebrew ? 'חנות:' : 'Store:'} ${product.storeName}` : ''}
${product.category ? `${isHebrew ? 'קטגוריה:' : 'Category:'} ${product.category}` : ''}
${isHebrew ? 'קישור:' : 'Link:'} ${product.affiliateUrl}

${isHebrew ? 'טון:' : 'Tone:'} ${toneGuidance[tone] || toneGuidance.casual}

${isHebrew ? 'דוגמת מבנה (התאם בהתאם):' : 'Example structure (adapt accordingly):'}
🛒 <b>[${isHebrew ? 'שם מוצר' : 'Product Name'}]</b>

💰 <s>$${product.originalPrice}</s> → <b>$${product.salePrice}</b> (${product.discount}% ${isHebrew ? 'הנחה' : 'OFF'}!)
⭐ ${product.rating}/5 | ${product.totalOrders?.toLocaleString() || ''}+ ${isHebrew ? 'הזמנות' : 'orders'}

[${isHebrew ? '2-3 משפטים על המוצר' : '2-3 sentences about the product'}]

🛍 <a href="${product.affiliateUrl}">${isHebrew ? 'לרכישה' : 'Buy Now'}</a>`;
};

export {
  getAffiliateWhatsAppSystemPrompt,
  getAffiliateWhatsAppUserPrompt,
  getAffiliateTelegramSystemPrompt,
  getAffiliateTelegramUserPrompt
};
