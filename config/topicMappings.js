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