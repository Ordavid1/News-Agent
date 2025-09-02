// hebrewSearch.mjs
import puppeteer from 'puppeteer';
import winston from 'winston';
import axios from 'axios';

let cseUsageCount = 0;
let cseUsageDate = new Date().toISOString().split('T')[0];
const CSE_DAILY_LIMIT = 100;

function checkAndResetCseUsage() {
  const currentDate = new Date().toISOString().split('T')[0];
  if (cseUsageDate !== currentDate) {
    cseUsageDate = currentDate;
    cseUsageCount = 0;
    logger.info('Google CSE usage counter reset for the new day.');
  }
}

// Logger Configuration
const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'hebrew-search.log' })
  ]
});

// Source Configuration
const SOURCE_TIERS = {
  'ynet.co.il': 1,
  'walla.co.il': 1,
  'maariv.co.il': 1,
  'israelhayom.co.il': 1,
  'calcalist.co.il': 1,
  'globes.co.il': 1,
  'n12.co.il': 0.9,
  '*.walla.co.il/*': 0.9,
  'haaretz.co.il': 1,
  'kikar.co.il': 0.7,
  'bhol.co.il': 0.6,
  'kipa.co.il': 0.8,
  'ice.co.il': 0.8,
  'bizportal.co.il': 1,
  'themarker.com': 1,
  '*.geektime.co.il': 1,
  '*.mako.co.il/*': 1,
};

// Hebrew News Sites Configuration
const HEBREW_NEWS_SITES = [
  {
    url: 'https://www.ynet.co.il',
    selectors: {
      articles: '.MultiArticle, .slotView, .titleRow, article, .textDiv, .article-item, .medium-marketing-articl',
      title: '.title, h1, h2, .mainTitle, .smallHeadline, .article-title',
      description: '.subtitle, .sub-title, .text, article-body, .article-subtitle, .content',
      date: 'time, .DateDisplay, span.date, .date, .article-date'
    },
    fallbackUrls: [
      'https://www.ynet.co.il/news/realestate',
      'https://www.ynet.co.il/economy'
    ]
  },
  {
    url: '*.walla.co.il/*',
    selectors: {
      articles: '.main-item, article, .with-image, .sequence-item, .MultiArticle, .slotView, .titleRow, article, .textDiv, .article-item, .medium-marketing-articl',
      title: 'h2, .title, .main-title, .smallHeadline, .article-title',
      description: '.subtitle, .article-content, .sub-title, .text, article-body, .article-subtitle, .content',
      date: 'time, .date, DateDisplay, span.date, .article-date'
    },
    fallbackUrls: [
      '*walla.co.il/*'
    ]
  },
  {
    url: 'https://www.calcalist.co.il',
    selectors: {
      articles: ['.MultiArticle', '.slotView', '.titleRow', 'article', '.textDiv', '.article-item', '.medium-marketing-article', '.main-article', '[data-article]', '.news-item'],
      title: ['.title', 'h1', 'h2', '.mainTitle', '.smallHeadline', '.article-title', '.entry-title', '[itemprop="headline"]'],
      description: ['.subtitle', '.sub-title', '.text', 'article-body', '.article-subtitle', '.content', '.summary', '.excerpt', '[itemprop="description"]'],
      date: ['time', '.DateDisplay', 'span.date', '.date', '.article-date', '[itemprop="datePublished"]', '.publish-date', '.entry-date'],
    },
    fallbackUrls: [
      'https://www.calcalist.co.il/home/0,7340,L-3077,00.html', 
      'https://www.calcalist.co.il/economy',
      'https://www.calcalist.co.il/real-estate'
    ]
  },
  {
    url: 'https://www.geektime.co.il',
    selectors: {
      articles: ['.MultiArticle', '.slotView', '.titleRow', 'article', '.textDiv', '.article-item', '.medium-marketing-article', '.post', '.news-item', '[data-post]'],
      title: ['.title', 'h1', 'h2', '.mainTitle', '.smallHeadline', '.article-title', '.entry-title', '[itemprop="headline"]'],
      description: ['.subtitle', '.sub-title', '.text', 'article-body', '.article-subtitle', '.content', '.summary', '.excerpt', '[itemprop="description"]'],
      date: ['time', '.DateDisplay', 'span.date', '.date', '.article-date', '[itemprop="datePublished"]', '.publish-date', '.entry-date'],
    },
    fallbackUrls: [
      'https://www.geektime.co.il/home',
      'https://www.geektime.co.il/tech-news',
      'https://www.geektime.co.il/startups'
    ]
  },
  {
    url: 'https://www.haaretz.co.il',
    selectors: {
      articles: ['.MultiArticle', '.slotView', '.titleRow', 'article', '.textDiv', '.article-item', '.medium-marketing-article', '.main-article', '[data-article]', '.news-item'],
      title: ['.title', 'h1', 'h2', '.mainTitle', '.smallHeadline', '.article-title', '.entry-title', '[itemprop="headline"]'],
      description: ['.subtitle', '.sub-title', '.text', 'article-body', '.article-subtitle', '.content', '.summary', '.excerpt', '[itemprop="description"]'],
      date: ['time', '.DateDisplay', 'span.date', '.date', '.article-date', '[itemprop="datePublished"]', '.publish-date', '.entry-date'],
    },
    fallbackUrls: [
      'https://www.haaretz.co.il/news',
      'https://www.haaretz.co.il/realestate',
      'https://www.haaretz.co.il/economy'
    ]
  },
  {
    url: 'https://www.globes.co.il',
    selectors: {
      articles: ['.MultiArticle', '.slotView', '.titleRow', 'article', '.textDiv', '.article-item', '.medium-marketing-article', '.main-article', '[data-article]', '.news-item'],
      title: ['.title', 'h1', 'h2', '.mainTitle', '.smallHeadline', '.article-title', '.entry-title', '[itemprop="headline"]'],
      description: ['.subtitle', '.sub-title', '.text', 'article-body', '.article-subtitle', '.content', '.summary', '.excerpt', '[itemprop="description"]'],
      date: ['time', '.DateDisplay', 'span.date', '.date', '.article-date', '[itemprop="datePublished"]', '.publish-date', '.entry-date'],
    },
    fallbackUrls: [
      'https://www.globes.co.il/news',
      'https://www.globes.co.il/realestate',
      'https://www.globes.co.il/economy'
    ]
  }
];

// Helper Functions
function normalizeText(text) {
  if (!text) return '';
  
  return text
    .toLowerCase()
    .replace(/[״""'']/g, '')  // More inclusive quote removal
    .replace(/[־–—]/g, ' ')   // Replace dashes with spaces
    .replace(/[^\p{L}\p{N}\s]/gu, '') // Remove non-letter/non-number chars    
    .replace(/\s+/g, ' ')     // Normalize spaces
    .replace(/\s*\|\s*\d*\s*(מעריב|הארץ|וואלה|ynet|103fm).*$/, '')
    .replace(/\s*-\s*חדשות.*$/, '')
    .replace(/"|״|״|"|'/g, '')
    .replace(/ - (וואלה!?|ynet|הארץ|מעריב|גלובס|ערוץ \d+)$/i, '')
    .trim();
}

/**
 * Checks if two articles are similar or duplicates
 * @param {Object} article1 First article to compare
 * @param {Object} article2 Second article to compare
 * @returns {boolean} True if articles are similar
 */
function areSimilarArticles(article1, article2) {
  // Log the comparison
  logger.debug(`Comparing articles for similarity:`);
  logger.debug(`Article 1: "${article1.title}"`);
  logger.debug(`Article 2: "${article2.title}"`);

  // Only check for exact URL matches
  if (article1.url === article2.url) {
    logger.debug('Same URL - articles are identical');
    return true;
  }

  // All other articles are considered different
  logger.debug('Articles determined to be different');
  return false;
}

// Enhanced article filtering with Hebrew-specific patterns
function isTagOrCategoryPage(article) {
  // Early return if no article
  if (!article || (!article.title && !article.url)) {
    return true;
  }

  // Common Hebrew news section/tag patterns
  const hebrewSectionPatterns = [
    /האזינו לכל האייטמים/i,                  // Added this pattern
    /בנושא מכל התוכניות/i,                   // Added this pattern
    /כל הכתבות והמידע הקשורים ל/i,
    /תגיות/i,
    /\/tags?\//i,
    /נושאים/i,
    /ארכיון/i,
    /וואלה! תגיות/i,
    /וואלה תגיות/i,
    /^תגית:/i,
  ];

  // Check title against all patterns
  for (const pattern of hebrewSectionPatterns) {
    if (article.title && pattern.test(article.title)) {
      logger.debug(`Article rejected - Topic/section pattern in title: "${article.title}"`);
      return true;
    }
  }

  // News sections that typically indicate non-article pages
  const newsStructurePatterns = [
    / - וואלה!/i,
    / - וואלה חדשות/i,
    / - ynet/i,
    /^כתבות - /i,
    /\| מעריב$/i,
    /\| חדשות מעריב$/i,
    /- גלובס$/i,
    /- הארץ$/i,
    /- ערוץ/i
  ];

  // URL patterns indicating tag/category pages
  const urlPatterns = [
    /\/topics?\//i,
    /\/tags?\//i,
    /\/category\//i,
    /\/sections?\//i,
    /\/subject\//i,
    /\/all-news\//i,
    /\/%D7%AA%D7%92%D7%99%D7%95%D7%AA/i,   // URL encoded 'תגיות'
    /\/%D7%A0%D7%95%D7%A9%D7%90%D7%99%D7%9D/i,  // URL encoded 'נושאים' 
    /portal\/topics/i,
    /list\.aspx/i,
  ];

  if (article.url && urlPatterns.some(pattern => pattern.test(article.url))) {
    logger.debug(`Article rejected - Topic/section pattern in URL: "${article.url}"`);
    return true;
  }

  /* Check title patterns
  if (article.title) {
    // Remove common news site suffixes for cleaner matching
    const cleanTitle = article.title
      .replace(/\s*\|\s*\d*\s*(מעריב|הארץ|וואלה|ynet|103fm).*$/, '')
      .replace(/\s*-\s*חדשות.*$/, '')
      .replace(/"|״|״|"|'/g, '')
      .toLowerCase()
      .replace(/ - (וואלה!?|ynet|הארץ|מעריב|גלובס|ערוץ \d+)$/i, '')
      .trim();

    // Check for section patterns in cleaned title
    if (hebrewSectionPatterns.some(pattern => pattern.test(normalizeText)) ||
        newsStructurePatterns.some(pattern => pattern.test(article.title))) {
      logger.debug(`Article rejected - Title matches section pattern: "${article.title}"`);
      return true;
    }

    // Check for additional indicators in title
    if (/^(כל |כתבות |ארכיון |חדשות )/.test(normalizeText)) {
      logger.debug(`Article rejected - Title starts with section indicator: "${article.title}"`);
      return true;
    }
  }
  */

  // ------------------------------------------------------------------------
  // Example: If you want to keep more logic for "title patterns," do it here:
  // ------------------------------------------------------------------------
  if (article.title) {
    // If any patterns from newsStructurePatterns match the actual title
    if (article.title) {
      for (const pattern of hebrewSectionPatterns) {
        if (pattern.test(article.title)) {      
        logger.debug(`Article rejected - Title matches news structure pattern: "${article.title}"`);
      return true;
    }
  }
}
    // Extra "additional indicators" check
    if (/^(כל |כתבות |ארכיון |חדשות )/.test(normalizeText(article.title))) {
      logger.debug(`Article rejected - Title starts with section indicator: "${article.title}"`);
      return true;
    }
  }

  /* if (pattern.test(article.title)) {
    logger.debug(`Article rejected by pattern ${pattern} in title: "${article.title}"`);
    return true;
  }  */

  // Check URL patterns
  if (article.url) {
    if (urlPatterns.some(pattern => pattern.test(article.url))) {
      logger.debug(`Article rejected - URL matches section pattern: "${article.url}"`);
      return true;
    }

    // Check for date-based archive URLs
    const datePattern = /\/\d{4}\/\d{2}(\/\d{2})?$/;
    if (datePattern.test(article.url)) {
      logger.debug(`Article rejected - URL appears to be date archive: "${article.url}"`);
      return true;
    }
  }

  // Check for common archive/listing page indicators in any metadata
  if (article.meta) {
    const metaValues = Object.values(article.meta).join(' ').toLowerCase();
    if (/ארכיון|תגיות|נושאים|רשימת|מדורים/.test(metaValues)) {
      logger.debug(`Article rejected - Metadata indicates listing page: "${article.title}"`);
      return true;
  }
}
  return false;
  
}


// Helper function to extract site name from URL
function extractSiteName(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace(/^www\./, '');
  } catch (error) {
    logger.error(`Error extracting site name from URL: ${error.message}`);
    return null;
  }
}

// Helper function to check if URL is from major Israeli news sites
function isIsraeliNewsSite(url) {
  const israeliNewsDomains = [
    'ynet.co.il',
    'walla.co.il',
    'haaretz.co.il',
    'maariv.co.il',
    'globes.co.il',
    'israelhayom.co.il',
    'news.walla.co.il',
    'sport5.co.il',
    'n12.co.il'
  ];

  const siteName = extractSiteName(url);
  return siteName && israeliNewsDomains.includes(siteName);
}

// function expandHebrewQuery(query) ERASED

function extractArticleDate(item) {
  // First, check metatags
  if (item.pagemap?.metatags?.[0]) {
    const meta = item.pagemap.metatags[0];
    const dateFields = [
      'article:published_time',
      'og:published_time',
      'datePublished',
      'pubdate',
      'date',
      'dateModified',
      'lastModified'
    ];
    
    for (const field of dateFields) {
      if (meta[field]) {
        const date = new Date(meta[field]);
        if (!isNaN(date.getTime())) return date;
      }
    }
  }

  // Hebrew and English relative time indicators
  const relativeTimePatterns = [
    /(\d+)\s*(hours?|days?)\s*ago/i,
    /לפני\s+(\d+)\s+(שעה|שעות|יום|ימים)/i,
    /((היום)|(אתמול)|(לפני\s+יומיים))/i
  ];

  for (const regex of relativeTimePatterns) {
    const match = item.snippet?.match(regex);
    if (match) {
      const now = new Date();
      
      // Handle specific Hebrew time references
      if (match[0] === 'היום') return now;
      if (match[0] === 'אתמול') {
        now.setDate(now.getDate() - 1);
        return now;
      }
      if (match[0] === 'לפני יומיים') {
        now.setDate(now.getDate() - 2);
        return now;
      }

      // Handle numeric relative times
      const [, amount, timeUnit] = match;
      const numAmount = parseInt(amount || '1');
      
      if (['hours', 'hour', 'שעה', 'שעות'].some(u => timeUnit.includes(u))) {
        now.setHours(now.getHours() - numAmount);
      } else if (['days', 'day', 'יום', 'ימים'].some(u => timeUnit.includes(u))) {
        now.setDate(now.getDate() - numAmount);
      }
      
      return now;
    }
  }

  // Date formats to try
  const dateFormats = [
    /(\d{1,2})[./](\d{1,2})[./](\d{4})/,  // DD/MM/YYYY
    /(\d{4})[-/](\d{2})[-/](\d{2})/,       // YYYY-MM-DD
    /(\d{1,2})\s*(?:ב)?(ינואר|פברואר|מרץ|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר)\s*(\d{4})/i
  ];

  for (const regex of dateFormats) {
    const match = item.snippet?.match(regex);
    if (match) {
      let date;
      
      // DD/MM/YYYY or MM/DD/YYYY
      if (match.length === 4) {
        const [, day, month, year] = match;
        // Determine if it's DD/MM or MM/DD based on values
        if (parseInt(month) > 12) {
          date = new Date(year, parseInt(day) - 1, parseInt(month));
        } else {
          date = new Date(year, parseInt(month) - 1, parseInt(day));
        }
      }
      
      // Hebrew month name format
      if (match.length === 3) {
        const hebrewMonths = {
          'ינואר': 0, 'פברואר': 1, 'מרץ': 2, 'אפריל': 3, 'מאי': 4,
          'יוני': 5, 'יולי': 6, 'אוגוסט': 7, 'ספטמבר': 8, 
          'אוקטובר': 9, 'נובמבר': 10, 'דצמבר': 11
        };
        
        const [, day, monthName, year] = match;
        date = new Date(parseInt(year), hebrewMonths[monthName.toLowerCase()], parseInt(day || '1'));
      }

      if (date && !isNaN(date.getTime())) return date;
    }
  }

  // Try extracting from URL
  const urlDateMatch = item.link?.match(/(\d{4})[-/](\d{2})[-/](\d{2})/);
  if (urlDateMatch) {
    const [, year, month, day] = urlDateMatch;
    const date = new Date(year, parseInt(month) - 1, parseInt(day));
    if (!isNaN(date.getTime())) return date;
  }

  // Additional method to extract year from text
  const yearMatch = item.snippet?.match(/ב\s*(\d{4})/);
  if (yearMatch) {
    const extractedYear = parseInt(yearMatch[1]);
    if (extractedYear === 2024) {
      return new Date(2024, 11, 31); // End of 2024
    }
  }

  // Final fallback: Very recent date within 30 days
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  
  // Log when no date is found for debugging
  logger.debug(`No valid date found for article: ${item.title || 'Untitled'}. Using fallback date.`);
  
  return monthAgo;
}

// Main CSE Function
async function fetchFromGoogleCSE_HEBREW(searchQuery) {
  checkAndResetCseUsage();
  console.log('Original Query:', searchQuery);
  console.log('Normalized Query:', normalizeText(searchQuery));
  if (cseUsageCount >= CSE_DAILY_LIMIT) {
    logger.warn('Google CSE daily limit (100) reached. Skipping search for today.');
    return [];
  }

  logger.debug(`Entering fetchFromGoogleCSE_HEBREW with query: "${searchQuery}"`);

  // Create search variations with date hint
  const variations = [
    searchQuery,
    `"${searchQuery}"`,
    searchQuery.split(/\s+/).join(' AND '),
    searchQuery.split(/\s+/).map(w => `intitle:${w}`).join(' ')
  ];

  logger.info(`CSE Search Variations: ${variations.join(', ')}`);
  let allResults = [];

  for (const variation of variations) {
    try {
      cseUsageCount += 1;
      const params = {
        key: process.env.GOOGLE_CSE_API_KEY,
        cx: process.env.GOOGLE_CSE_ID,
        q: variation,
        lr: 'lang_he',
        num: 10,
        sort: 'date:d:s',
        dateRestrict: 'd7',  // Restrict to last 7 days
        fields: 'items(title,snippet,link,pagemap)'
      };

      const response = await axios.get('https://www.googleapis.com/customsearch/v1', { params });
      
      if (response.data.items) {
        const results = await Promise.all(response.data.items.map(async item => {
          // Enhanced date extraction
          const date = await extractArticleDate(item);
          if (!date) {
            logger.debug(`No valid date found for article: ${item.title}`);
            return null;
          }

          // Strict date validation
          const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
          const now = new Date();
          
          // Check for future dates (invalid) and old content
          if (date > now || date < weekAgo) {
            logger.debug(`Article rejected - date out of range: ${date.toISOString()}, Title: ${item.title}`);
            return null;
          }

         /* // Check for staleness indicators in text
          const staleContent = detectStaleContent(item.title + ' ' + item.snippet);
          if (staleContent) {
            logger.debug(`Article rejected - stale content indicators found: ${item.title}`);
            return null;
          }

          // Add stale content check here
          const isStaleContent = detectStaleContent(item.snippet, date);
          if (isStaleContent) {
            logger.debug(`Article rejected - confirmed to be old content: ${item.title}`);
            return null;
          }
            */

          // If passed all checks, return the article
          return {
            title: item.title || 'No Title',
            description: item.snippet || 'No Description',
            url: item.link || '',
            publishedAt: date.toISOString(),
            source: {
              name: new URL(item.link).hostname.replace(/^www\./, ''),
              tier: SOURCE_TIERS[new URL(item.link).hostname.replace(/^www\./, '')] || 0.5
            }
          };
        }));

        allResults = allResults.concat(results.filter(Boolean));
      }
    } catch (error) {
      logger.error(`CSE search error with variation "${variation}": ${error.message}`);
      continue;
    }
  }

  // Additional date-based scoring and sorting
  return allResults
    .sort((a, b) => {
      const dateA = new Date(a.publishedAt);
      const dateB = new Date(b.publishedAt);
      const now = new Date();
      
      // Calculate freshness score (0-1)
      const freshnessA = 1 - ((now - dateA) / (7 * 24 * 60 * 60 * 1000));
      const freshnessB = 1 - ((now - dateB) / (7 * 24 * 60 * 60 * 1000));
      
      // Combine with source tier for final score
      const scoreA = (freshnessA * 0.7) + (a.source.tier * 0.3);
      const scoreB = (freshnessB * 0.7) + (b.source.tier * 0.3);
      
      return scoreB - scoreA;
    });
}

/* // Helper function to detect stale content
function detectStaleContent(text, publishDate) {
  // First and most important check - actual publication date
  const articleDate = new Date(publishDate);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  if (articleDate < weekAgo) {
    return true;
  }

  // Only check for definitive indicators that the article itself is old
  const staleIndicators = [
    /פורסם לראשונה ב.*2023/i,    // "First published in 2023"
    /פורסם לפני \d+ (חודשים|שבועות|שנים)/i,  // "Published X months/weeks/years ago"
    /עודכן לאחרונה ב.*2023/i,    // "Last updated in 2023"
    /מהארכיון/i,                  // "From the archive"
  ];

  return staleIndicators.some(pattern => pattern.test(text));
}
  */

// Process CSE results with improved validation
// In hebrewSearch.mjs, improve article processing:
async function processCSEResults(items, fromDate, toDate) {
  logger.debug(`Processing ${items?.length || 0} CSE results`);
  logger.debug(`Date range: ${fromDate} to ${toDate}`);

  const results = [];
  for (const item of items) {
    try {
            // First check if it's a tag/category page
            if (isTagOrCategoryPage(item)) {
              continue;
            }
      const date = extractArticleDate(item);
      logger.debug(`Article "${item.title}": Extracted date ${date}`);

      // Strict date validation
      const fromDateObj = new Date(fromDate);
      const toDateObj = new Date(toDate);
      
      if (!date || date < fromDateObj || date > toDateObj) {
        logger.debug(`Article rejected - Invalid date or out of range: "${item.title}"`);
        continue;
      }

      // Calculate source tier
      const url = new URL(item.link);
      const hostname = url.hostname.replace(/^www\./, '');
      const sourceTier = SOURCE_TIERS[hostname] || 0.5;
      
      logger.debug(`Article accepted - Source: ${hostname}, Tier: ${sourceTier}`);
      
      results.push({
        title: item.title,
        description: item.snippet || '',
        url: item.link,
        publishedAt: date.toISOString(),
        source: {
          name: hostname,
          tier: sourceTier
        }
      });
    } catch (error) {
      logger.error(`Error processing article "${item.title}": ${error.message}`);
    }
  }

  return results;
}

// Enhanced scoring function
function calculateRelevanceScore(article, query, fromDate, toDate) {
  let totalScore = 0;
  const weights = {
    titleMatch: 0.25,    
    descMatch: 0.25,     
    dateRecency: 0.25,   
    keywordMatch: 0.15,  
    sourceTier: 0.10    
  };
 
  logger.debug(`\nCalculating relevance score for article: "${article.title}"`);
  logger.debug(`Query: "${query}"`);
  logger.debug(`Date range: ${fromDate} to ${toDate}`);
 
  // First validate the date
  const articleDate = new Date(article.publishedAt);
  const startDate = new Date(fromDate);
  const endDate = new Date(toDate);
 
  // Validate dates
  if ([articleDate, startDate, endDate].some(date => isNaN(date.getTime()))) {
    logger.debug('Invalid date encountered in score calculation');
    return 0;
  }
 
  // Normalize dates to UTC
  startDate.setUTCHours(0, 0, 0, 0);
  endDate.setUTCHours(23, 59, 59, 999);
 
  if (articleDate < startDate || articleDate > endDate) {
    logger.debug(`Article date ${articleDate.toISOString()} outside range ${startDate.toISOString()} - ${endDate.toISOString()}`);
    return 0;
  }
 
  // Calculate exponential keyword match score
  function calculateKeywordMatchScore(text, keywords) {
    const textLength = text.length;
    const matchedKeywords = keywords.filter(kw => 
      text.toLowerCase().includes(kw.toLowerCase())
    ).length;
    const totalKeywords = keywords.length;
    
    // Base requirement decreases as text gets longer
    const baseRequirement = Math.exp(-textLength / 1000);
    
    // Exponential score calculation
    const score = (matchedKeywords / totalKeywords) * (1 - baseRequirement);
    
    logger.debug(`Keyword match details:
      Text length: ${textLength}
      Matched keywords: ${matchedKeywords}/${totalKeywords}
      Base requirement: ${baseRequirement.toFixed(3)}
      Score: ${score.toFixed(3)}
    `);
 
    return score;
  }
 
  // Normalize text and prepare keywords
  const normalizedQuery = normalizeText(query);
  const normalizedTitle = normalizeText(article.title);
  const normalizedDesc = normalizeText(article.description || '');
  const keywords = normalizedQuery.split(/\s+/).filter(Boolean);
 
  // Get all text content for keyword matching
  const fullText = `${normalizedTitle} ${normalizedDesc}`;
  
  // Calculate keyword match score
  const keywordMatchScore = calculateKeywordMatchScore(fullText, keywords);
 
  // Calculate title match score
  const titleMatchCount = keywords.filter(word => normalizedTitle.includes(word)).length;
  const titleScore = titleMatchCount / keywords.length;
  logger.debug(`Title match score: ${titleScore.toFixed(3)} (${titleMatchCount}/${keywords.length} words matched)`);
 
  // Calculate description match score
  const descMatchCount = keywords.filter(word => normalizedDesc.includes(word)).length;
  const descScore = descMatchCount / keywords.length;
  logger.debug(`Description match score: ${descScore.toFixed(3)} (${descMatchCount}/${keywords.length} words matched)`);
 
  // Calculate date recency score
  const timeRange = endDate.getTime() - startDate.getTime();
  const articleAge = endDate.getTime() - articleDate.getTime();
  const dateScore = Math.min(1, 1.2 - (articleAge / timeRange));
  logger.debug(`Date recency score: ${dateScore.toFixed(3)}`);
 
  // Get source tier score
  const sourceTier = Math.max(0.3, article.source?.tier || 0.5);
  logger.debug(`Source tier score: ${sourceTier.toFixed(3)} (${article.source?.name || 'unknown source'})`);
 
  // Calculate final weighted score
  totalScore = (titleScore * weights.titleMatch) +
               (descScore * weights.descMatch) +
               (dateScore * weights.dateRecency) +
               (keywordMatchScore * weights.keywordMatch) +
               (sourceTier * weights.sourceTier);
 
  // Cap score between 0 and 1
  totalScore = Math.min(1, Math.max(0, totalScore));
 
  // Log breakdown
  logger.debug('Score breakdown:');
  logger.debug(`- Title match: ${(titleScore * weights.titleMatch).toFixed(3)}`);
  logger.debug(`- Description match: ${(descScore * weights.descMatch).toFixed(3)}`);
  logger.debug(`- Date recency: ${(dateScore * weights.dateRecency).toFixed(3)}`);
  logger.debug(`- Keyword match: ${(keywordMatchScore * weights.keywordMatch).toFixed(3)}`);
  logger.debug(`- Source tier: ${(sourceTier * weights.sourceTier).toFixed(3)}`);
  logger.debug(`Final weighted score: ${totalScore.toFixed(3)}`);
 
  return totalScore;
 }

// Date scoring function
function getDateRelevanceScore(article) {
  try {
    const pubDate = new Date(article.publishedAt || article.date || new Date());
    const now = new Date();
    const ageInDays = (now - pubDate) / (1000 * 60 * 60 * 24); // Correct ms to days conversion
    return ageInDays <= 7 ? Math.max(0, (7 - ageInDays) / 7) : 0;
  } catch (error) {
    logger.error(`Error calculating date relevance score: ${error.message}`);
    return 0;
  }
}

// Crawler Implementation
async function crawlHebrewSources(searchQuery, fromDate, toDate) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1920,1080',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process'
    ],
    defaultViewport: { width: 1920, height: 1080 }
  });

  const results = [];
  const MAX_RETRIES = 1;
  const PAGE_TIMEOUT = 60000;

  const normalizedQuery = normalizeText(searchQuery);

  try {
    for (const site of HEBREW_NEWS_SITES) {
      let retries = 0;
      while (retries < MAX_RETRIES) {
        let page = null;
        try {
          page = await browser.newPage();
          await page.setDefaultNavigationTimeout(PAGE_TIMEOUT);
          
          // Enhanced page configuration
          await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
          await page.setExtraHTTPHeaders({
            'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
          });

          try {
            await page.goto(site.url, {
              waitUntil: 'networkidle2',
              timeout: 30000
            });
          } catch (navError) {
            logger.warn(`Initial navigation failed, retrying with longer timeout: ${navError.message}`);
            await page.goto(site.url, {
              waitUntil: 'domcontentloaded',
              timeout: PAGE_TIMEOUT
            });
          }

            // 2) Scroll to load lazy content
            //    This block tries to scroll multiple times,
            //    waiting ~2 seconds between each scroll
            await page.evaluate(async () => {
              for (let i = 0; i < 5; i++) {
                window.scrollBy(0, document.body.scrollHeight);
                await new Promise((resolve) => setTimeout(resolve, 2000));
              }
            });
            
            // 3) Wait for the article selector to appear (optional)
            //    Increase this timeout if 15s is too short for the site
          await Promise.race([
            page.waitForSelector(site.selectors.articles),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 20000))
          ]);

          const articles = await page.evaluate((selectors) => {
            const extractTextFromSelectors = (element, selectorString) => {
              const selectors = selectorString.split(',').map(s => s.trim());
              for (const selector of selectors) {
                const found = element.querySelector(selector);
                if (found) return found.textContent.trim();
              }
              return '';
            };
          
            const articleSelectors = selectors.articles.split(',').map(s => s.trim());
            const foundArticles = [];
          
            for (const articleSelector of articleSelectors) {
              const articleElements = document.querySelectorAll(articleSelector);
              
              articleElements.forEach(article => {
                const articleData = {
                  title: extractTextFromSelectors(article, selectors.title),
                  description: extractTextFromSelectors(article, selectors.description),
                  date: extractTextFromSelectors(article, selectors.date),
                  url: article.querySelector('a')?.href
                };
          
                if (articleData.title && articleData.url) {
                  foundArticles.push(articleData);
                }
              });
            }
          
            return foundArticles;
          }, site.selectors);

          for (const article of articles) {
            const pubDate = parseHebrewDate(article.date);
            if (!pubDate) continue;

            const normalizedTitle = normalizeText(article.title);
            const normalizedDesc = normalizeText(article.description);

            if (normalizedTitle.includes(normalizedQuery) || 
                normalizedDesc.includes(normalizedQuery)) {
              
              const hostname = new URL(article.url).hostname;
              const sourceTier = SOURCE_TIERS[hostname] || 0;
              
              results.push({
                title: article.title,
                description: article.description || '',
                url: article.url,
                publishedAt: pubDate.toISOString(),
                source: {
                  name: hostname,
                  tier: sourceTier
                }
              });
            }
          }

          break; // Success, exit retry loop

        } catch (error) {
          retries++;
          logger.error(`Error crawling ${site.url} (attempt ${retries}): ${error.message}`);
          if (retries === MAX_RETRIES) {
            logger.error(`Failed to crawl ${site.url} after ${MAX_RETRIES} attempts`);
          }
          await new Promise(resolve => setTimeout(resolve, 5000 * retries));
        } finally {
          if (page) await page.close().catch(() => {}); // Clean up even if there's an error
        }
      }
    }
  } finally {
    await browser.close().catch(() => {}); // Clean up browser even if there's an error
  }

  // Filter by date range and sort by date
  return results
    .filter(article => {
      const pubDate = new Date(article.publishedAt);
      return pubDate >= new Date(fromDate) && pubDate <= new Date(toDate);
    })
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
}

// Export all necessary functions and constants
export {
  getDateRelevanceScore,
  checkAndResetCseUsage,
  fetchFromGoogleCSE_HEBREW,
  areSimilarArticles,
  crawlHebrewSources,
  isTagOrCategoryPage,
  extractSiteName,
  isIsraeliNewsSite,
  normalizeText,
  processCSEResults,
  calculateRelevanceScore,
  SOURCE_TIERS,
  HEBREW_NEWS_SITES
};