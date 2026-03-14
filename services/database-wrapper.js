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
  updateSubscriptionRecord, // Update subscriptions table directly
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
  deleteAllUserAdAccounts,
  // Marketing campaign functions
  getUserCampaigns,
  getCampaignById,
  getCampaignByFbId,
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
  getAudienceTemplateByFbId,
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
  getBoostablePublishedPosts,
  // Brand voice functions
  getUserBrandVoiceProfiles,
  getBrandVoiceProfileById,
  createBrandVoiceProfile,
  updateBrandVoiceProfile,
  deleteBrandVoiceProfile,
  countUserBrandVoiceProfiles,
  insertBrandVoicePosts,
  getBrandVoicePosts,
  deleteBrandVoicePosts,
  insertBrandVoiceGeneratedPost,
  getBrandVoiceGeneratedPosts,
  deleteBrandVoiceGeneratedPost,
  updateBrandVoiceGeneratedPost,
  getAllPublishedPosts,
  // Media asset functions
  getUserMediaAssets,
  createMediaAsset,
  deleteMediaAsset,
  countMediaAssets,
  getMediaTrainingJobById,
  getMediaTrainingJobs,
  getActiveMediaTrainingJob,
  createMediaTrainingJob,
  updateMediaTrainingJob,
  setDefaultTrainingJob,
  getDefaultTrainingJob,
  getGeneratedMedia,
  getGeneratedMediaByJobId,
  createGeneratedMedia,
  deleteGeneratedMedia,
  // Per-use purchase functions
  createPerUsePurchase,
  getPerUsePurchase,
  getPerUsePurchaseByProviderId,
  getPerUsePurchaseByIdempotencyKey,
  updatePerUsePurchase,
  getUserPerUsePurchases,
  getLatestUnusedPurchase,
  // Quota enforcement
  decrementPostsRemaining,
  calculatePostingInterval,
  // Affiliate add-on functions
  getAffiliateAddon,
  getAffiliateAddonByLsId,
  upsertAffiliateAddon,
  updateAffiliateAddon,
  // Affiliate credential functions
  getAffiliateCredentials,
  upsertAffiliateCredentials,
  updateAffiliateCredentials,
  deleteAffiliateCredentials,
  incrementAffiliateApiCalls,
  // Affiliate keyword functions
  getAffiliateKeywords,
  getActiveAffiliateKeywords,
  getAffiliateKeywordById,
  createAffiliateKeyword,
  updateAffiliateKeyword,
  deleteAffiliateKeyword,
  countAffiliateKeywords,
  // Affiliate published product functions
  recordAffiliatePublishedProduct,
  isAffiliateProductPublished,
  getAffiliatePublishedProducts,
  getAgentPublishedProductIds,
  getAffiliateStats
} from './database.js';
