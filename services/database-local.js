// services/database-local.js
// Local in-memory database for development/testing without Firebase

import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()]
});

// In-memory storage
const collections = {
  users: new Map(),
  subscriptions: new Map(),
  posts: new Map(),
  usage_logs: new Map(),
  analytics: new Map(),
  payment_history: new Map(),
  api_keys: new Map()
};

// Mock database object
const db = {
  collection: (name) => {
    if (!collections[name]) {
      collections[name] = new Map();
    }
    return {
      add: async (data) => {
        const id = generateId();
        collections[name].set(id, { ...data, _id: id });
        return { id };
      },
      doc: (id) => ({
        get: async () => {
          const data = collections[name].get(id);
          return {
            exists: !!data,
            id: data?._id,
            data: () => {
              const { _id, ...rest } = data || {};
              return rest;
            }
          };
        },
        update: async (updates) => {
          const existing = collections[name].get(id);
          if (existing) {
            collections[name].set(id, { ...existing, ...updates });
          }
        },
        delete: async () => {
          collections[name].delete(id);
        }
      }),
      where: (field, op, value) => ({
        limit: (n) => ({
          get: async () => {
            const results = [];
            for (const [id, doc] of collections[name].entries()) {
              if (checkCondition(doc[field], op, value)) {
                results.push({ id, data: () => ({ ...doc }) });
                if (results.length >= n) break;
              }
            }
            return {
              empty: results.length === 0,
              docs: results
            };
          }
        }),
        orderBy: (field, direction = 'asc') => ({
          limit: (n) => ({
            offset: (o) => ({
              get: async () => {
                const sorted = Array.from(collections[name].entries())
                  .filter(([_, doc]) => checkCondition(doc[field], op, value))
                  .sort(([, a], [, b]) => {
                    const compareValue = direction === 'asc' ? 1 : -1;
                    return (a[field] > b[field] ? 1 : -1) * compareValue;
                  })
                  .slice(o, o + n);
                
                return {
                  docs: sorted.map(([id, doc]) => ({
                    id,
                    data: () => ({ ...doc })
                  }))
                };
              }
            })
          })
        })
      })
    };
  },
  listCollections: async () => {
    return Object.keys(collections).map(name => ({ id: name }));
  }
};

function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

function checkCondition(value, op, compareValue) {
  switch (op) {
    case '==': return value === compareValue;
    case '!=': return value !== compareValue;
    case '>': return value > compareValue;
    case '>=': return value >= compareValue;
    case '<': return value < compareValue;
    case '<=': return value <= compareValue;
    default: return false;
  }
}

export async function initializeFirestore() {
  try {
    logger.info('🏠 Using local in-memory database for development');
    logger.info('⚠️  Data will not persist between restarts');
    
    // Initialize collections
    await initializeCollections();
    
    return db;
  } catch (error) {
    logger.error('Failed to initialize local database:', error);
    throw error;
  }
}

async function initializeCollections() {
  const collectionNames = [
    'users',
    'subscriptions',
    'posts',
    'usage_logs',
    'analytics',
    'payment_history',
    'api_keys'
  ];
  
  for (const collectionName of collectionNames) {
    if (!collections[collectionName]) {
      collections[collectionName] = new Map();
    }
    logger.info(`Initialized collection: ${collectionName}`);
  }
}

// User management functions
export async function createUser(userData) {
  const user = {
    ...userData,
    createdAt: new Date(),
    updatedAt: new Date(),
    subscription: {
      tier: 'free',
      status: 'active',
      postsRemaining: 5,
      dailyLimit: 5,
      resetDate: getDailyResetDate()
    },
    settings: {
      defaultPlatforms: [],
      preferredTopics: [],
      autoSchedule: false
    }
  };
  
  const docRef = await db.collection('users').add(user);
  return { id: docRef.id, ...user };
}

export async function getUserById(userId) {
  const doc = await db.collection('users').doc(userId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

export async function getUserByEmail(email) {
  const snapshot = await db.collection('users')
    .where('email', '==', email)
    .limit(1)
    .get();
  
  if (snapshot.empty) return null;
  const doc = snapshot.docs[0];
  return { id: doc.id, ...doc.data() };
}

export async function getUserByResetToken(token) {
  const users = [];
  for (const [id, user] of collections.users.entries()) {
    if (user.passwordResetToken === token) {
      users.push({ id, ...user });
    }
  }
  return users;
}

export async function updateUser(userId, updates) {
  await db.collection('users').doc(userId).update({
    ...updates,
    updatedAt: new Date()
  });
}

// Subscription management
export async function createSubscription(subscriptionData) {
  const subscription = {
    ...subscriptionData,
    createdAt: new Date(),
    updatedAt: new Date(),
    status: 'active',
    currentPeriodStart: new Date(),
    currentPeriodEnd: getMonthlyResetDate()
  };
  
  const docRef = await db.collection('subscriptions').add(subscription);
  
  await updateUser(subscriptionData.userId, {
    subscription: {
      tier: subscriptionData.tier,
      status: 'active',
      postsRemaining: getTierPostLimit(subscriptionData.tier),
      dailyLimit: getTierPostLimit(subscriptionData.tier),
      resetDate: getDailyResetDate()
    }
  });
  
  return { id: docRef.id, ...subscription };
}

export async function getSubscription(userId) {
  const snapshot = await db.collection('subscriptions')
    .where('userId', '==', userId)
    .where('status', '==', 'active')
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();
  
  if (snapshot.empty) return null;
  const doc = snapshot.docs[0];
  return { id: doc.id, ...doc.data() };
}

// Post management
export async function createPost(userId, postData) {
  const post = {
    userId,
    ...postData,
    createdAt: new Date(),
    status: 'pending',
    platforms: postData.platforms || [],
    publishedPlatforms: []
  };
  
  const docRef = await db.collection('posts').add(post);
  
  const user = await getUserById(userId);
  await updateUser(userId, {
    'subscription.postsRemaining': Math.max(0, user.subscription.postsRemaining - 1)
  });
  
  await logUsage(userId, 'post_created', { postId: docRef.id });
  
  return { id: docRef.id, ...post };
}

export async function getUserPosts(userId, limit = 50, offset = 0) {
  const snapshot = await db.collection('posts')
    .where('userId', '==', userId)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .offset(offset)
    .get();
  
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

// Usage tracking
export async function logUsage(userId, action, metadata = {}) {
  await db.collection('usage_logs').add({
    userId,
    action,
    metadata,
    timestamp: new Date()
  });
}

export async function getUsageStats(userId, startDate, endDate) {
  const allLogs = [];
  for (const [id, log] of collections.usage_logs.entries()) {
    if (log.userId === userId && 
        log.timestamp >= startDate && 
        log.timestamp <= endDate) {
      allLogs.push(log);
    }
  }
  return allLogs;
}

// Analytics functions
export async function getAnalytics(userId, period = '30d') {
  const user = await getUserById(userId);
  const posts = await getUserPosts(userId, 1000);
  
  const analytics = {
    totalPosts: posts.length,
    platformBreakdown: {},
    topicsUsed: {},
    engagementRate: 0,
    successRate: 0,
    postsRemaining: user.subscription.postsRemaining,
    subscriptionTier: user.subscription.tier
  };
  
  posts.forEach(post => {
    post.platforms.forEach(platform => {
      analytics.platformBreakdown[platform] = (analytics.platformBreakdown[platform] || 0) + 1;
    });
    
    if (post.topic) {
      analytics.topicsUsed[post.topic] = (analytics.topicsUsed[post.topic] || 0) + 1;
    }
  });
  
  const successfulPosts = posts.filter(p => p.status === 'published').length;
  analytics.successRate = posts.length > 0 ? (successfulPosts / posts.length) * 100 : 0;
  
  return analytics;
}

// Helper functions
function getTierPostLimit(tier) {
  const limits = {
    starter: 10,
    growth: 20,
    professional: 30,
    business: 45
  };
  return limits[tier] || 5;
}

function getDailyResetDate() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  return tomorrow;
}

function getMonthlyResetDate() {
  const now = new Date();
  const nextMonth = new Date(now);
  nextMonth.setMonth(nextMonth.getMonth() + 1);
  return nextMonth;
}

export function getDb() {
  return db;
}