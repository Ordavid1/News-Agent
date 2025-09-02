// services/database-wrapper.js
// Wrapper that selects the appropriate database implementation based on environment

import * as firebaseDb from './database.js';
import * as localDb from './database-local.js';

const useLocalDb = process.env.USE_LOCAL_DB === 'true' || !process.env.GOOGLE_APPLICATION_CREDENTIALS;

// Export all functions from the appropriate database implementation
export const {
  initializeFirestore,
  createUser,
  getUserById,
  getUserByEmail,
  getUserByResetToken,
  updateUser,
  createSubscription,
  getSubscription,
  createPost,
  getUserPosts,
  logUsage,
  getUsageStats,
  getAnalytics,
  getDb
} = useLocalDb ? localDb : firebaseDb;