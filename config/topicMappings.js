// config/topicMappings.js

// Aliases map common topic names (e.g. from UI) to their canonical mapping keys
const TOPIC_ALIASES = {
  'technology': 'tech',
  'artificial intelligence': 'ai',
  'machine learning': 'ai',
  'cryptocurrency': 'crypto',
  'blockchain': 'crypto',
  'web3': 'crypto',
  'startups': 'startup',
  'entrepreneurship': 'startup',
  'ux': 'design',
  'ui': 'design',
  'digital marketing': 'marketing',
  'seo': 'marketing',
  'finance': 'business',
  'economy': 'business',
  'wellness': 'health',
  'medical': 'health',
  'research': 'science',
  'government': 'politics',
  'policy': 'politics',
  'climate': 'environment',
  'sustainability': 'environment',
  'tourism': 'travel',
  'cooking': 'food',
  'restaurants': 'food',
  'cars': 'automotive',
  'vehicles': 'automotive',
  'property': 'realestate',
  'housing': 'realestate',
  'lifestyle': 'fashion',
  'style': 'fashion',
};

// Resolve a topic string to its canonical mapping key
function resolveTopic(topic) {
  const key = topic.toLowerCase().trim();
  if (DEMO_TOPIC_MAPPINGS[key]) return key;
  return TOPIC_ALIASES[key] || key;
}

// Map demo topics to searchable keywords and categories
export const DEMO_TOPIC_MAPPINGS = {
  ai: {
    displayName: 'AI',
    icon: '🤖',
    keywords: ['artificial intelligence', 'AI', 'machine learning', 'deep learning', 'neural networks', 
               'GPT', 'LLM', 'generative AI', 'OpenAI', 'Anthropic', 'Google AI', 'Meta AI'],
    category: 'tech',
    searchQueries: ['artificial intelligence news', 'AI breakthrough', 'machine learning', 'generative AI']
  },
  tech: {
    displayName: 'Tech News',
    icon: '💻',
    keywords: ['technology', 'tech news', 'software', 'hardware', 'innovation', 'tech companies',
               'Apple', 'Google', 'Microsoft', 'Amazon', 'Meta', 'tech industry'],
    category: 'tech',
    searchQueries: ['technology news', 'tech industry', 'software development', 'tech innovation']
  },
  startup: {
    displayName: 'Startups',
    icon: '🚀',
    keywords: ['startup', 'startups', 'entrepreneurship', 'venture capital', 'funding', 'unicorn',
               'Series A', 'Series B', 'YC', 'Y Combinator', 'founders', 'startup funding'],
    category: 'business',
    searchQueries: ['startup news', 'startup funding', 'new startups', 'venture capital']
  },
  crypto: {
    displayName: 'Crypto & Web3',
    icon: '₿',
    keywords: ['cryptocurrency', 'crypto', 'bitcoin', 'ethereum', 'blockchain', 'DeFi', 'NFT',
               'Web3', 'crypto market', 'digital currency', 'altcoins', 'crypto trading'],
    category: 'tech',
    searchQueries: ['cryptocurrency news', 'bitcoin', 'ethereum', 'crypto market', 'blockchain']
  },
  productivity: {
    displayName: 'Productivity',
    icon: '⚡',
    keywords: ['productivity', 'efficiency', 'time management', 'workflow', 'productivity tools',
               'remote work', 'work from home', 'productivity apps', 'automation', 'task management'],
    category: 'business',
    searchQueries: ['productivity tips', 'productivity tools', 'efficiency', 'workplace productivity']
  },
  design: {
    displayName: 'Design & UX',
    icon: '🎨',
    keywords: ['design', 'UX', 'UI', 'user experience', 'user interface', 'graphic design',
               'web design', 'product design', 'design trends', 'Figma', 'Adobe', 'design tools'],
    category: 'tech',
    searchQueries: ['design trends', 'UX design', 'UI design', 'product design news']
  },
  business: {
    displayName: 'Business',
    icon: '💼',
    keywords: ['business', 'corporate', 'enterprise', 'business news', 'economy', 'markets',
               'business strategy', 'management', 'leadership', 'business trends', 'industry news'],
    category: 'business',
    searchQueries: ['business news', 'corporate news', 'business strategy', 'market trends']
  },
  marketing: {
    displayName: 'Marketing',
    icon: '📈',
    keywords: ['marketing', 'digital marketing', 'social media marketing', 'content marketing',
               'SEO', 'advertising', 'branding', 'marketing strategy', 'growth marketing', 'marketing trends'],
    category: 'business',
    searchQueries: ['marketing news', 'digital marketing trends', 'marketing strategy', 'social media marketing']
  },
  entertainment: {
    displayName: 'Entertainment',
    icon: '🎬',
    keywords: ['entertainment', 'movies', 'TV shows', 'streaming', 'music', 'celebrities',
               'Netflix', 'Disney', 'Hollywood', 'gaming', 'pop culture', 'entertainment news'],
    category: 'entertainment',
    searchQueries: ['entertainment news', 'movie news', 'streaming news', 'pop culture']
  },
  sports: {
    displayName: 'Sports',
    icon: '🏟️',
    keywords: ['sports', 'football', 'basketball', 'soccer', 'tennis', 'Olympics',
               'NFL', 'NBA', 'FIFA', 'sports news', 'athletics', 'championship'],
    category: 'sports',
    searchQueries: ['sports news', 'football news', 'basketball news', 'sports highlights']
  },
  health: {
    displayName: 'Health',
    icon: '🏥',
    keywords: ['health', 'healthcare', 'medical', 'wellness', 'fitness', 'mental health',
               'nutrition', 'medicine', 'public health', 'health news', 'clinical trials', 'FDA'],
    category: 'health',
    searchQueries: ['health news', 'medical news', 'healthcare news', 'wellness trends']
  },
  science: {
    displayName: 'Science',
    icon: '🔬',
    keywords: ['science', 'research', 'space', 'NASA', 'physics', 'biology',
               'climate', 'environment', 'scientific discovery', 'academic research', 'nature', 'CERN'],
    category: 'science',
    searchQueries: ['science news', 'scientific discovery', 'space news', 'research breakthrough']
  },
  politics: {
    displayName: 'Politics & Government',
    icon: '🏛️',
    keywords: ['politics', 'government', 'election', 'congress', 'parliament', 'legislation',
               'policy', 'diplomacy', 'geopolitics', 'political news', 'senate', 'democracy'],
    category: 'politics',
    searchQueries: ['politics news', 'government policy', 'election news', 'political developments']
  },
  education: {
    displayName: 'Education',
    icon: '🎓',
    keywords: ['education', 'university', 'school', 'learning', 'students', 'academic',
               'higher education', 'EdTech', 'curriculum', 'teaching', 'online learning', 'scholarship'],
    category: 'education',
    searchQueries: ['education news', 'higher education', 'EdTech news', 'school policy']
  },
  environment: {
    displayName: 'Environment & Climate',
    icon: '🌍',
    keywords: ['environment', 'climate change', 'sustainability', 'renewable energy', 'carbon emissions',
               'conservation', 'green energy', 'pollution', 'biodiversity', 'climate policy', 'solar', 'wind energy'],
    category: 'environment',
    searchQueries: ['climate change news', 'environment news', 'renewable energy', 'sustainability news']
  },
  travel: {
    displayName: 'Travel & Tourism',
    icon: '✈️',
    keywords: ['travel', 'tourism', 'airlines', 'hotels', 'destinations', 'vacation',
               'flights', 'travel industry', 'hospitality', 'travel trends', 'cruise', 'tourism industry'],
    category: 'travel',
    searchQueries: ['travel news', 'tourism industry', 'airline news', 'travel trends']
  },
  food: {
    displayName: 'Food & Dining',
    icon: '🍽️',
    keywords: ['food', 'dining', 'restaurants', 'cuisine', 'cooking', 'chef',
               'food industry', 'nutrition', 'food trends', 'food tech', 'recipe', 'gastronomy'],
    category: 'food',
    searchQueries: ['food industry news', 'restaurant news', 'food trends', 'culinary news']
  },
  automotive: {
    displayName: 'Automotive',
    icon: '🚗',
    keywords: ['automotive', 'cars', 'electric vehicles', 'EV', 'Tesla', 'auto industry',
               'self-driving', 'autonomous vehicles', 'car news', 'auto market', 'hybrid', 'automotive technology'],
    category: 'automotive',
    searchQueries: ['automotive news', 'electric vehicle news', 'car industry', 'auto market trends']
  },
  realestate: {
    displayName: 'Real Estate',
    icon: '🏠',
    keywords: ['real estate', 'housing', 'property', 'mortgage', 'housing market', 'commercial real estate',
               'home prices', 'rental market', 'real estate investment', 'construction', 'REIT', 'property market'],
    category: 'realestate',
    searchQueries: ['real estate news', 'housing market', 'property market trends', 'commercial real estate']
  },
  fashion: {
    displayName: 'Fashion & Lifestyle',
    icon: '👗',
    keywords: ['fashion', 'lifestyle', 'luxury', 'beauty', 'clothing', 'fashion industry',
               'fashion trends', 'designer', 'retail fashion', 'streetwear', 'sustainable fashion', 'fashion week'],
    category: 'fashion',
    searchQueries: ['fashion news', 'fashion industry', 'lifestyle trends', 'fashion week news']
  }
};

// Get search queries for a topic (resolves aliases like "technology" → "tech")
export function getTopicSearchQueries(topic) {
  const key = resolveTopic(topic);
  const mapping = DEMO_TOPIC_MAPPINGS[key];
  return mapping ? mapping.searchQueries : [topic];
}

// Get keywords for a topic
export function getTopicKeywords(topic) {
  const key = resolveTopic(topic);
  const mapping = DEMO_TOPIC_MAPPINGS[key];
  return mapping ? mapping.keywords : [topic];
}

// Get category for a topic
export function getTopicCategory(topic) {
  const key = resolveTopic(topic);
  const mapping = DEMO_TOPIC_MAPPINGS[key];
  return mapping ? mapping.category : 'general';
}

// Get all available topics (canonical keys only)
export function getAllTopics() {
  return Object.keys(DEMO_TOPIC_MAPPINGS);
}

// Validate if a topic is supported (checks aliases too)
export function isValidTopic(topic) {
  const key = resolveTopic(topic);
  return DEMO_TOPIC_MAPPINGS.hasOwnProperty(key);
}