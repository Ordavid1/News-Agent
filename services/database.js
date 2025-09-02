// services/database.js
import { Firestore } from '@google-cloud/firestore';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()]
});

let db;

export async function initializeFirestore() {
  try {
    const secretClient = new SecretManagerServiceClient();
    
    // Fetch credentials from Secret Manager
    const [version] = await secretClient.accessSecretVersion({
      name: 'projects/vaulted-bivouac-417511/secrets/firebase-key/versions/latest'
    });
    
    const serviceAccountJSON = version.payload.data.toString();
    const serviceAccount = JSON.parse(serviceAccountJSON);
    
    // Initialize Firestore with multi-tenant database
    db = new Firestore({
      projectId: 'vaulted-bivouac-417511',
      credentials: {
        client_email: serviceAccount.client_email,
        private_key: serviceAccount.private_key
      },
      databaseId: 'postgendb' // Use the same database as parent bot
    });
    
    // Test connection
    await db.listCollections();
    logger.info('✅ Firestore connection successful');
    
    // Initialize collections if they don't exist
    await initializeCollections();
    
    return db;
  } catch (error) {
    logger.error('Failed to initialize Firestore:', error);
    throw error;
  }
}

async function initializeCollections() {
  const collections = [
    'users',
    'subscriptions',
    'posts',
    'usage_logs',
    'analytics',
    'payment_history',
    'api_keys'
  ];
  
  for (const collectionName of collections) {
    const collection = db.collection(collectionName);
    const snapshot = await collection.limit(1).get();
    if (snapshot.empty) {
      logger.info(`Initialized collection: ${collectionName}`);
    }
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
      postsRemaining: 5, // Free tier gets 5 posts per day
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
  const snapshot = await db.collection('users')
    .where('passwordResetToken', '==', token)
    .get();
  
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
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
  
  // Update user's subscription info
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

// Post management with multi-tenant support
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
  
  // Update user's post count
  const user = await getUserById(userId);
  await updateUser(userId, {
    'subscription.postsRemaining': Math.max(0, user.subscription.postsRemaining - 1)
  });
  
  // Log usage
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
  const snapshot = await db.collection('usage_logs')
    .where('userId', '==', userId)
    .where('timestamp', '>=', startDate)
    .where('timestamp', '<=', endDate)
    .get();
  
  return snapshot.docs.map(doc => doc.data());
}

// Analytics functions
export async function getAnalytics(userId, period = '30d') {
  const user = await getUserById(userId);
  const posts = await getUserPosts(userId, 1000); // Get more posts for analytics
  
  const analytics = {
    totalPosts: posts.length,
    platformBreakdown: {},
    topicsUsed: {},
    engagementRate: 0,
    successRate: 0,
    postsRemaining: user.subscription.postsRemaining,
    subscriptionTier: user.subscription.tier
  };
  
  // Calculate platform breakdown
  posts.forEach(post => {
    post.platforms.forEach(platform => {
      analytics.platformBreakdown[platform] = (analytics.platformBreakdown[platform] || 0) + 1;
    });
    
    // Track topics
    if (post.topic) {
      analytics.topicsUsed[post.topic] = (analytics.topicsUsed[post.topic] || 0) + 1;
    }
  });
  
  // Calculate success rate
  const successfulPosts = posts.filter(p => p.status === 'published').length;
  analytics.successRate = posts.length > 0 ? (successfulPosts / posts.length) * 100 : 0;
  
  return analytics;
}

// Helper functions
function getTierPostLimit(tier) {
  const limits = {
    starter: 10,      // 10 posts/day
    growth: 20,       // 20 posts/day
    professional: 30, // 30 posts/day
    business: 45      // 45 posts/day
  };
  return limits[tier] || 5; // Default to free tier limit (5 posts/day)
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
  if (!db) {
    throw new Error('Database not initialized. Call initializeFirestore first.');
  }
  return db;
}