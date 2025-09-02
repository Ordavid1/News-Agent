// config/topicMappings.js

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
  }
};

// Get search queries for a topic
export function getTopicSearchQueries(topic) {
  const mapping = DEMO_TOPIC_MAPPINGS[topic.toLowerCase()];
  return mapping ? mapping.searchQueries : [topic];
}

// Get keywords for a topic
export function getTopicKeywords(topic) {
  const mapping = DEMO_TOPIC_MAPPINGS[topic.toLowerCase()];
  return mapping ? mapping.keywords : [topic];
}

// Get category for a topic
export function getTopicCategory(topic) {
  const mapping = DEMO_TOPIC_MAPPINGS[topic.toLowerCase()];
  return mapping ? mapping.category : 'general';
}

// Get all available topics
export function getAllTopics() {
  return Object.keys(DEMO_TOPIC_MAPPINGS);
}

// Validate if a topic is supported
export function isValidTopic(topic) {
  return DEMO_TOPIC_MAPPINGS.hasOwnProperty(topic.toLowerCase());
}