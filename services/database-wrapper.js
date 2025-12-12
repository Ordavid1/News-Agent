/**
 * Database Wrapper
 *
 * Re-exports from the Supabase database implementation.
 * Maintained for backwards compatibility with existing imports.
 *
 * Note: The app has migrated from Firestore to Supabase.
 * This wrapper ensures existing code continues to work without changes.
 */

export {
  initializeDatabase,
  initializeDatabase as initializeFirestore, // Alias for backwards compatibility
  createUser,
  getUserById,
  getUserByEmail,
  getUserByResetToken,
  updateUser,
  createSubscription,
  getSubscription,
  getSubscriptionByLsId, // Lemon Squeezy lookup
  createPost,
  getUserPosts,
  updatePost,
  getPostById,
  logUsage,
  getUsageStats,
  getAnalytics,
  getUserConnections,
  getConnection,
  hasActiveConnection,
  getDb,
  // Agent functions
  getUserAgents,
  getAgentById,
  getAgentByConnectionId,
  createAgent,
  updateAgent,
  deleteAgent,
  countUserAgents,
  incrementAgentPost,
  markAgentTestUsed
} from './database.js';
