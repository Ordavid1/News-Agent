// config/topicConfig.js

export const TOPIC_CATEGORIES = {
  tech: {
    keywords: ['ai', 'technology', 'startup', 'innovation', 'artificial intelligence', 'machine learning', 'futurology', 'llm', 'generative ai', 'robotics'],
    subreddits: ['technology', 'programming', 'innovation', 'innovations', 'futurology', 'technology', 'artificial', 'MachineLearningnews', 'robotics', 'generativeai', 'openai'],
    weight: 1.3,
    enabled: true
  },
  business: {
    keywords: ['venture capital', 'entrepreneur', 'startup', 'corporate', 'revenue', 'investment', 'funding', 'industry', 
              'series A', 'series B', 'series C', 'IPO', 'merger', 'acquisition', 'business model', 'PMF', 'product market fit', 
              'valuation', 'unicorn', 'business strategy', 'market trends', 'economic growth', 'business innovation',
              'corporate leadership', 'business transformation', 'market analysis', 'industry report', 'business development',
              'economic policy', 'trade', 'commerce', 'business news', 'financial markets', 'stock market', 'earnings report'],
    subreddits: ['business', 'entrepreneur', 'startups', 'finance', 'economics', 'venturecapital', 
                 'smallbusiness', 'investing', 'StockMarket', 'businessnews'],
    weight: 1.1,
    enabled: true
  },
  science: {
    keywords: ['biotechnology', 'deep tech', 'science', 'space', 'breakthrough', 'physics', 'research',
              'scientific discovery', 'innovation', 'medical research', 'climate science', 'astronomy',
              'biology', 'chemistry', 'neuroscience', 'genetics', 'environmental science', 'space exploration',
              'scientific study', 'research paper', 'scientific breakthrough', 'technology advancement',
              'health research', 'medical breakthrough', 'scientific innovation', 'research findings'],
    subreddits: ['science', 'space', 'environment', 'EverythingScience', 'sciences', 'AskScience', 
                 'technology', 'Futurology', 'spacenews', 'biology', 'physics'],
    weight: 0.9,
    enabled: true
  },
  entertainment: {
    keywords: ['gaming', 'sports', 'celebrity', 'netflix', 'show', 'game', 'film', 'series', 'entertainment'],
    subreddits: ['movies', 'television', 'music', 'gaming'],
    weight: 0.6,
    enabled: false  // Disabled by default
  },
  politics: {
    keywords: ['politics', 'election', 'government', 'congress', 'senate', 'campaign', 'policy', 'vote', 'legislation', 
        'administration', 'political reform', 'democracy', 'diplomacy', 'foreign policy', 'domestic policy',
        'political analysis', 'governance', 'public policy', 'bipartisan', 'political debate', 'civic engagement',
        'political science', 'geopolitics', 'international relations', 'political economy'
      ],
    subreddits: ['politics', 'PoliticalDiscussion', 'moderatepolitics', 'geopolitics', 'NeutralPolitics', 'Ask_Politics'],
    weight: 0.7,
    enabled: true
  },
  news: {
    keywords: [
      'breaking news', 'latest news', 'news update', 'news report',
      'headline', 'current events', 'developing story', 'news alert',
      'world news', 'international news', 'global affairs', 'regional news',
      'investigative report', 'news analysis', 'current affairs', 'media coverage',
      'journalism', 'press release', 'news brief', 'special report'
    ],
    subreddits: ['worldnews', 'news', 'UpliftingNews', 'internationalnews', 'globalnews', 
                 'TrueReddit', 'neutralnews', 'qualitynews', 'InDepthStories'],
    weight: 1,
    enabled: true
  }
};

// Parse environment variables for dynamic configuration
const parseEnabledCategories = () => {
  const enabled = process.env.ENABLED_CATEGORIES?.split(',').map(c => c.trim()) || [];
  const disabled = process.env.DISABLED_CATEGORIES?.split(',').map(c => c.trim()) || [];
  
  // Apply environment settings
  Object.keys(TOPIC_CATEGORIES).forEach(category => {
    if (enabled.length > 0) {
      TOPIC_CATEGORIES[category].enabled = enabled.includes(category);
    } else if (disabled.length > 0) {
      TOPIC_CATEGORIES[category].enabled = !disabled.includes(category);
    }
  });
  
  // Parse category weights if provided
  const weights = process.env.CATEGORY_WEIGHTS?.split(',') || [];
  weights.forEach(weight => {
    const [category, value] = weight.split(':');
    if (TOPIC_CATEGORIES[category]) {
      TOPIC_CATEGORIES[category].weight = parseFloat(value) || 1.0;
    }
  });
};

// Apply configuration on module load
parseEnabledCategories();

// Get only enabled categories
export const getEnabledCategories = () => {
  return Object.entries(TOPIC_CATEGORIES)
    .filter(([_, config]) => config.enabled)
    .map(([category, _]) => category);
};

// Get all keywords from enabled categories
export const getEnabledKeywords = () => {
  const keywords = [];
  Object.entries(TOPIC_CATEGORIES).forEach(([_, config]) => {
    if (config.enabled) {
      keywords.push(...config.keywords);
    }
  });
  return [...new Set(keywords)];
};

// Check if a topic belongs to an enabled category
// Replace the existing isTopicInEnabledCategory function with this improved version:
export const isTopicInEnabledCategory = (topic) => {
  const topicLower = topic.toLowerCase();
  const topicWords = topicLower.split(/\s+/);
  
  for (const [category, config] of Object.entries(TOPIC_CATEGORIES)) {
    if (!config.enabled) continue;
    
    // Check if the topic contains any keyword
    const hasKeyword = config.keywords.some(keyword => {
      const keywordLower = keyword.toLowerCase();
      
      // For single-word keywords, require word boundary matching
      if (!keyword.includes(' ')) {
        // Don't match partial words - use word boundaries
        const regex = new RegExp(`\\b${keywordLower}\\b`, 'i');
        return regex.test(topicLower);
      }
      
      // For multi-word keywords, check if topic contains the phrase
      return topicLower.includes(keywordLower);
    });
    
    if (hasKeyword) {
      return { allowed: true, category };
    }
  }
  
  return { allowed: false, category: null };
};