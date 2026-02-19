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
  markAgentTestUsed,
  // Agent automation functions
  getAgentsReadyForPosting,
  getAgentsReadyForPlatform,
  resetDailyAgentPosts,
  logAgentAutomation,
  // Marketing add-on functions
  getMarketingAddon,
  getMarketingAddonByLsId,
  upsertMarketingAddon,
  updateMarketingAddon,
  // Marketing ad account functions
  getUserAdAccounts,
  getSelectedAdAccount,
  getAdAccountById,
  upsertAdAccount,
  selectAdAccount,
  deleteAdAccount,
  // Marketing campaign functions
  getUserCampaigns,
  getCampaignById,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  countUserActiveCampaigns,
  // Marketing ad set functions
  getCampaignAdSets,
  getAdSetById,
  createAdSet,
  updateAdSet,
  deleteAdSet,
  // Marketing ad functions
  getAdSetAds,
  getUserAds,
  getAdById,
  createAd,
  updateAd,
  deleteAd,
  // Marketing audience template functions
  getUserAudienceTemplates,
  getAudienceTemplateById,
  createAudienceTemplate,
  updateAudienceTemplate,
  deleteAudienceTemplate,
  countUserAudienceTemplates,
  // Marketing rule functions
  getUserMarketingRules,
  getActiveMarketingRules,
  getMarketingRuleById,
  createMarketingRule,
  updateMarketingRule,
  deleteMarketingRule,
  countUserMarketingRules,
  logRuleTrigger,
  getRuleTriggerHistory,
  // Marketing metrics functions
  upsertMarketingMetrics,
  getMarketingMetricsHistory,
  getMarketingOverview,
  createPublishedPost,
  getBoostablePublishedPosts
} from './database.js';
