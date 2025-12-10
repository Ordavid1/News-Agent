/**
 * Database Service - Supabase Implementation
 *
 * Provides database operations using Supabase PostgreSQL
 * Maintains backwards compatibility with previous Firestore API
 */

import { supabaseAdmin } from './supabase.js';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()]
});

/**
 * Initialize database connection (Supabase)
 * Unlike Firestore, Supabase doesn't require explicit initialization
 * but we keep this for backwards compatibility and connection testing
 */
export async function initializeDatabase() {
  try {
    // Test connection by querying a simple endpoint
    const { data, error } = await supabaseAdmin.from('profiles').select('count').limit(1);

    if (error && error.code !== 'PGRST116') {
      // PGRST116 means table doesn't exist yet - that's OK for first run
      logger.error('Supabase connection error:', error);
      throw error;
    }

    logger.info('Supabase connection successful');
    return true;
  } catch (error) {
    logger.error('Failed to initialize Supabase:', error);
    throw error;
  }
}

// Alias for backwards compatibility
export const initializeFirestore = initializeDatabase;

// ============================================
// USER MANAGEMENT
// ============================================

/**
 * Create a new user profile or get existing user
 * Note: In Supabase, the user is first created in auth.users via signup,
 * then we create the extended profile in public.profiles
 *
 * Handles cases where:
 * - User doesn't exist at all (creates both auth user and profile)
 * - Auth user exists but profile doesn't (creates profile only)
 * - Both exist (updates profile and returns existing user)
 */
export async function createUser(userData) {
  const { email, password, name, apiKey, ...rest } = userData;

  let authUserId = null;

  // Try to create auth user first
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // Auto-confirm for now
    user_metadata: { name }
  });

  if (authError) {
    // Check if user already exists
    if (authError.message?.includes('already been registered') || authError.code === 'email_exists') {
      logger.info(`Auth user already exists for ${email}, fetching existing user`);

      // Get existing auth user by email
      const { data: existingUsers, error: listError } = await supabaseAdmin.auth.admin.listUsers();
      if (listError) {
        logger.error('Error listing users:', listError);
        throw listError;
      }

      const existingUser = existingUsers.users.find(u => u.email === email);
      if (existingUser) {
        authUserId = existingUser.id;
      } else {
        logger.error('Could not find existing auth user');
        throw authError;
      }
    } else {
      logger.error('Error creating auth user:', authError);
      throw authError;
    }
  } else {
    authUserId = authData.user.id;
  }

  // Prepare profile data
  const profile = {
    id: authUserId,
    email,
    name,
    api_key: apiKey || null,
    subscription_tier: rest.subscriptionTier || 'free',
    subscription_status: rest.subscriptionStatus || 'active',
    posts_remaining: rest.postsRemaining || 5,
    daily_limit: rest.dailyLimit || 5,
    reset_date: getDailyResetDate(),
    default_platforms: rest.defaultPlatforms || [],
    preferred_topics: rest.preferredTopics || [],
    timezone: rest.timezone || 'UTC',
    auto_schedule: rest.autoSchedule || false,
    automation_enabled: rest.automationEnabled || false,
    automation_platforms: rest.automationPlatforms || [],
    automation_topics: rest.automationTopics || [],
    automation_posts_per_day: rest.automationPostsPerDay || 1,
    automation_schedule: rest.automationSchedule || { morning: false, lunch: false, evening: false, night: false },
    automation_tone: rest.automationTone || 'professional'
  };

  // Try to upsert profile (insert or update if exists)
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .upsert(profile, { onConflict: 'id' })
    .select()
    .single();

  if (error) {
    logger.error('Error upserting profile:', error);
    // Only rollback if we created a new auth user
    if (authData?.user?.id) {
      await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
    }
    throw error;
  }

  // Return in legacy format for backwards compatibility
  return formatUserForLegacy(data);
}

/**
 * Get user by ID
 */
export async function getUserById(userId) {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null; // Not found
    logger.error('Error getting user by ID:', error);
    throw error;
  }

  return formatUserForLegacy(data);
}

/**
 * Get user by email
 */
export async function getUserByEmail(email) {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('email', email)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null; // Not found
    logger.error('Error getting user by email:', error);
    throw error;
  }

  return formatUserForLegacy(data);
}

/**
 * Get user by password reset token
 */
export async function getUserByResetToken(token) {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('password_reset_token', token);

  if (error) {
    logger.error('Error getting user by reset token:', error);
    throw error;
  }

  return data.map(formatUserForLegacy);
}

/**
 * Update user profile
 */
export async function updateUser(userId, updates) {
  // Convert legacy format to Supabase format
  const supabaseUpdates = convertUpdatesToSupabase(updates);
  supabaseUpdates.updated_at = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .update(supabaseUpdates)
    .eq('id', userId)
    .select()
    .single();

  if (error) {
    logger.error('Error updating user:', error);
    throw error;
  }

  return formatUserForLegacy(data);
}

// ============================================
// SUBSCRIPTION MANAGEMENT
// ============================================

/**
 * Create a subscription
 * Supports both Stripe (legacy) and Lemon Squeezy fields
 */
export async function createSubscription(subscriptionData) {
  const subscription = {
    user_id: subscriptionData.userId,
    tier: subscriptionData.tier,
    // Stripe fields (legacy)
    stripe_subscription_id: subscriptionData.stripeSubscriptionId || null,
    stripe_customer_id: subscriptionData.stripeCustomerId || null,
    stripe_price_id: subscriptionData.stripePriceId || null,
    // Lemon Squeezy fields
    ls_subscription_id: subscriptionData.lsSubscriptionId || null,
    ls_customer_id: subscriptionData.lsCustomerId || null,
    ls_variant_id: subscriptionData.lsVariantId || null,
    ls_order_id: subscriptionData.lsOrderId || null,
    status: subscriptionData.status || 'active',
    current_period_start: subscriptionData.currentPeriodStart || new Date().toISOString(),
    current_period_end: subscriptionData.currentPeriodEnd || getMonthlyResetDate().toISOString()
  };

  const { data, error } = await supabaseAdmin
    .from('subscriptions')
    .insert(subscription)
    .select()
    .single();

  if (error) {
    logger.error('Error creating subscription:', error);
    throw error;
  }

  // Update user's profile with subscription info
  await updateUser(subscriptionData.userId, {
    subscription: {
      tier: subscriptionData.tier,
      status: 'active',
      postsRemaining: getTierPostLimit(subscriptionData.tier),
      dailyLimit: getTierPostLimit(subscriptionData.tier),
      resetDate: getDailyResetDate()
    }
  });

  return formatSubscriptionForLegacy(data);
}

/**
 * Get active subscription for user
 */
export async function getSubscription(userId) {
  const { data, error } = await supabaseAdmin
    .from('subscriptions')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null; // Not found
    logger.error('Error getting subscription:', error);
    throw error;
  }

  return formatSubscriptionForLegacy(data);
}

/**
 * Get subscription by Lemon Squeezy subscription ID
 * Used for webhook processing
 */
export async function getSubscriptionByLsId(lsSubscriptionId) {
  const { data, error } = await supabaseAdmin
    .from('subscriptions')
    .select('*')
    .eq('ls_subscription_id', lsSubscriptionId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null; // Not found
    logger.error('Error getting subscription by LS ID:', error);
    throw error;
  }

  return formatSubscriptionForLegacy(data);
}

// ============================================
// POST MANAGEMENT
// ============================================

/**
 * Create a new post
 */
export async function createPost(userId, postData) {
  const post = {
    user_id: userId,
    topic: postData.topic,
    content: postData.content,
    tone: postData.tone || 'professional',
    target_platforms: postData.platforms || [],
    published_platforms: [],
    status: 'pending',
    schedule_time: postData.scheduleTime || null,
    source_article_title: postData.metadata?.articleTitle || null,
    source_article_url: postData.metadata?.articleUrl || null,
    platform_results: {}
  };

  const { data, error } = await supabaseAdmin
    .from('posts')
    .insert(post)
    .select()
    .single();

  if (error) {
    logger.error('Error creating post:', error);
    throw error;
  }

  // Decrement user's posts remaining
  await supabaseAdmin.rpc('decrement_posts_remaining', { p_user_id: userId });

  // Log usage
  await logUsage(userId, 'post_created', { postId: data.id });

  return formatPostForLegacy(data);
}

/**
 * Get user's posts with pagination
 */
export async function getUserPosts(userId, limit = 50, offset = 0) {
  const { data, error } = await supabaseAdmin
    .from('posts')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    logger.error('Error getting user posts:', error);
    throw error;
  }

  return data.map(formatPostForLegacy);
}

/**
 * Update a post
 */
export async function updatePost(postId, updates) {
  const supabaseUpdates = convertPostUpdatesToSupabase(updates);
  supabaseUpdates.updated_at = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from('posts')
    .update(supabaseUpdates)
    .eq('id', postId)
    .select()
    .single();

  if (error) {
    logger.error('Error updating post:', error);
    throw error;
  }

  return formatPostForLegacy(data);
}

/**
 * Get post by ID
 */
export async function getPostById(postId) {
  const { data, error } = await supabaseAdmin
    .from('posts')
    .select('*')
    .eq('id', postId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    logger.error('Error getting post:', error);
    throw error;
  }

  return formatPostForLegacy(data);
}

// ============================================
// USAGE & ANALYTICS
// ============================================

/**
 * Log a usage event
 */
export async function logUsage(userId, action, metadata = {}) {
  const { error } = await supabaseAdmin
    .from('usage_logs')
    .insert({
      user_id: userId,
      action,
      metadata
    });

  if (error) {
    logger.error('Error logging usage:', error);
    // Don't throw - usage logging shouldn't break main flows
  }
}

/**
 * Get usage statistics for a period
 */
export async function getUsageStats(userId, startDate, endDate) {
  const { data, error } = await supabaseAdmin
    .from('usage_logs')
    .select('*')
    .eq('user_id', userId)
    .gte('created_at', startDate.toISOString())
    .lte('created_at', endDate.toISOString());

  if (error) {
    logger.error('Error getting usage stats:', error);
    throw error;
  }

  return data;
}

/**
 * Get analytics for user
 */
export async function getAnalytics(userId, period = '30d') {
  const user = await getUserById(userId);
  const posts = await getUserPosts(userId, 1000);

  const analytics = {
    totalPosts: posts.length,
    platformBreakdown: {},
    topicsUsed: {},
    engagementRate: 0,
    successRate: 0,
    postsRemaining: user.subscription?.postsRemaining || 0,
    subscriptionTier: user.subscription?.tier || 'free'
  };

  // Calculate platform breakdown
  posts.forEach(post => {
    const platforms = post.platforms || post.target_platforms || [];
    platforms.forEach(platform => {
      analytics.platformBreakdown[platform] = (analytics.platformBreakdown[platform] || 0) + 1;
    });

    if (post.topic) {
      analytics.topicsUsed[post.topic] = (analytics.topicsUsed[post.topic] || 0) + 1;
    }
  });

  // Calculate success rate
  const successfulPosts = posts.filter(p => p.status === 'published').length;
  analytics.successRate = posts.length > 0 ? (successfulPosts / posts.length) * 100 : 0;

  return analytics;
}

// ============================================
// SOCIAL CONNECTIONS (NEW)
// ============================================

/**
 * Get user's social connections
 */
export async function getUserConnections(userId) {
  const { data, error } = await supabaseAdmin
    .from('social_connections')
    .select('*')
    .eq('user_id', userId);

  if (error) {
    logger.error('Error getting user connections:', error);
    throw error;
  }

  return data;
}

/**
 * Get specific connection
 */
export async function getConnection(userId, platform) {
  const { data, error } = await supabaseAdmin
    .from('social_connections')
    .select('*')
    .eq('user_id', userId)
    .eq('platform', platform)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    logger.error('Error getting connection:', error);
    throw error;
  }

  return data;
}

/**
 * Check if user has active connection for platform
 */
export async function hasActiveConnection(userId, platform) {
  const connection = await getConnection(userId, platform);
  return connection && connection.status === 'active';
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function getTierPostLimit(tier) {
  const limits = {
    free: 5,
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
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  return tomorrow;
}

function getMonthlyResetDate() {
  const now = new Date();
  const nextMonth = new Date(now);
  nextMonth.setMonth(nextMonth.getMonth() + 1);
  return nextMonth;
}

/**
 * Convert Supabase profile to legacy format
 * Maintains backwards compatibility with existing code
 */
function formatUserForLegacy(profile) {
  if (!profile) return null;

  return {
    id: profile.id,
    email: profile.email,
    name: profile.name,
    apiKey: profile.api_key, // Map api_key back to apiKey
    avatar_url: profile.avatar_url,
    createdAt: profile.created_at,
    updatedAt: profile.updated_at,
    subscription: {
      tier: profile.subscription_tier,
      status: profile.subscription_status,
      postsRemaining: profile.posts_remaining,
      dailyLimit: profile.daily_limit,
      resetDate: profile.reset_date
    },
    settings: {
      defaultPlatforms: profile.default_platforms || [],
      preferredTopics: profile.preferred_topics || [],
      autoSchedule: profile.auto_schedule || false,
      timezone: profile.timezone
    },
    automation: {
      enabled: profile.automation_enabled,
      platforms: profile.automation_platforms || [],
      topics: profile.automation_topics || [],
      postsPerDay: profile.automation_posts_per_day,
      schedule: profile.automation_schedule,
      tone: profile.automation_tone
    },
    stripeCustomerId: profile.stripe_customer_id,
    stripeSubscriptionId: profile.stripe_subscription_id,
    passwordResetToken: profile.password_reset_token,
    passwordResetExpiry: profile.password_reset_expiry
  };
}

/**
 * Convert legacy update format to Supabase column names
 */
function convertUpdatesToSupabase(updates) {
  const converted = {};

  // Handle nested subscription object
  if (updates.subscription) {
    if (updates.subscription.tier !== undefined) converted.subscription_tier = updates.subscription.tier;
    if (updates.subscription.status !== undefined) converted.subscription_status = updates.subscription.status;
    if (updates.subscription.postsRemaining !== undefined) converted.posts_remaining = updates.subscription.postsRemaining;
    if (updates.subscription.dailyLimit !== undefined) converted.daily_limit = updates.subscription.dailyLimit;
    if (updates.subscription.resetDate !== undefined) converted.reset_date = updates.subscription.resetDate;
  }

  // Handle nested settings object
  if (updates.settings) {
    if (updates.settings.defaultPlatforms !== undefined) converted.default_platforms = updates.settings.defaultPlatforms;
    if (updates.settings.preferredTopics !== undefined) converted.preferred_topics = updates.settings.preferredTopics;
    if (updates.settings.autoSchedule !== undefined) converted.auto_schedule = updates.settings.autoSchedule;
    if (updates.settings.timezone !== undefined) converted.timezone = updates.settings.timezone;
  }

  // Handle nested automation object
  if (updates.automation) {
    if (updates.automation.enabled !== undefined) converted.automation_enabled = updates.automation.enabled;
    if (updates.automation.platforms !== undefined) converted.automation_platforms = updates.automation.platforms;
    if (updates.automation.topics !== undefined) converted.automation_topics = updates.automation.topics;
    if (updates.automation.postsPerDay !== undefined) converted.automation_posts_per_day = updates.automation.postsPerDay;
    if (updates.automation.schedule !== undefined) converted.automation_schedule = updates.automation.schedule;
    if (updates.automation.tone !== undefined) converted.automation_tone = updates.automation.tone;
  }

  // Handle direct field updates
  if (updates.name !== undefined) converted.name = updates.name;
  if (updates.email !== undefined) converted.email = updates.email;
  if (updates.password !== undefined) converted.password = updates.password;
  if (updates.apiKey !== undefined) converted.api_key = updates.apiKey;
  if (updates.passwordResetToken !== undefined) converted.password_reset_token = updates.passwordResetToken;
  if (updates.passwordResetExpiry !== undefined) converted.password_reset_expiry = updates.passwordResetExpiry;
  if (updates.stripeCustomerId !== undefined) converted.stripe_customer_id = updates.stripeCustomerId;
  if (updates.stripeSubscriptionId !== undefined) converted.stripe_subscription_id = updates.stripeSubscriptionId;

  // Handle dot-notation updates (e.g., 'subscription.postsRemaining')
  for (const [key, value] of Object.entries(updates)) {
    if (key.startsWith('subscription.')) {
      const field = key.replace('subscription.', '');
      const mapping = {
        tier: 'subscription_tier',
        status: 'subscription_status',
        postsRemaining: 'posts_remaining',
        dailyLimit: 'daily_limit',
        resetDate: 'reset_date'
      };
      if (mapping[field]) converted[mapping[field]] = value;
    }
  }

  return converted;
}

/**
 * Format subscription for legacy API
 */
function formatSubscriptionForLegacy(subscription) {
  if (!subscription) return null;

  return {
    id: subscription.id,
    userId: subscription.user_id,
    tier: subscription.tier,
    // Stripe fields (legacy)
    stripeSubscriptionId: subscription.stripe_subscription_id,
    stripeCustomerId: subscription.stripe_customer_id,
    stripePriceId: subscription.stripe_price_id,
    // Lemon Squeezy fields
    lsSubscriptionId: subscription.ls_subscription_id,
    lsCustomerId: subscription.ls_customer_id,
    lsVariantId: subscription.ls_variant_id,
    lsOrderId: subscription.ls_order_id,
    // Status fields
    status: subscription.status,
    currentPeriodStart: subscription.current_period_start,
    currentPeriodEnd: subscription.current_period_end,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    createdAt: subscription.created_at,
    updatedAt: subscription.updated_at
  };
}

/**
 * Format post for legacy API
 */
function formatPostForLegacy(post) {
  if (!post) return null;

  return {
    id: post.id,
    userId: post.user_id,
    topic: post.topic,
    content: post.content,
    tone: post.tone,
    platforms: post.target_platforms,
    publishedPlatforms: post.published_platforms,
    status: post.status,
    scheduleTime: post.schedule_time,
    publishedAt: post.published_at,
    platformResults: post.platform_results,
    metadata: {
      articleTitle: post.source_article_title,
      articleUrl: post.source_article_url,
      articleImage: post.source_article_image
    },
    createdAt: post.created_at,
    updatedAt: post.updated_at
  };
}

/**
 * Convert post updates to Supabase format
 */
function convertPostUpdatesToSupabase(updates) {
  const converted = {};

  if (updates.status !== undefined) converted.status = updates.status;
  if (updates.publishedPlatforms !== undefined) converted.published_platforms = updates.publishedPlatforms;
  if (updates.publishedAt !== undefined) converted.published_at = updates.publishedAt;
  if (updates.platformResults !== undefined) converted.platform_results = updates.platformResults;
  if (updates.content !== undefined) converted.content = updates.content;

  return converted;
}

// ============================================
// AGENT MANAGEMENT
// ============================================

/**
 * Get all agents for a user
 */
export async function getUserAgents(userId) {
  const { data, error } = await supabaseAdmin
    .from('agents')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error('Error getting user agents:', error);
    throw error;
  }

  return data || [];
}

/**
 * Get agent by ID
 */
export async function getAgentById(agentId) {
  const { data, error } = await supabaseAdmin
    .from('agents')
    .select('*')
    .eq('id', agentId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    logger.error('Error getting agent by ID:', error);
    throw error;
  }

  return data;
}

/**
 * Get agent by connection ID
 */
export async function getAgentByConnectionId(connectionId) {
  const { data, error } = await supabaseAdmin
    .from('agents')
    .select('*')
    .eq('connection_id', connectionId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    logger.error('Error getting agent by connection:', error);
    throw error;
  }

  return data;
}

/**
 * Create a new agent
 */
export async function createAgent(agentData) {
  const { userId, connectionId, name, platform, settings } = agentData;

  const defaultSettings = {
    topics: [],
    keywords: [],
    geoFilter: { region: '', includeGlobal: true },
    schedule: { postsPerDay: 3, startTime: '09:00', endTime: '21:00' },
    contentStyle: { tone: 'professional', includeHashtags: true }
  };

  const agent = {
    user_id: userId,
    connection_id: connectionId,
    name,
    platform,
    status: 'active',
    settings: settings || defaultSettings,
    posts_today: 0,
    total_posts: 0
  };

  const { data, error } = await supabaseAdmin
    .from('agents')
    .insert(agent)
    .select()
    .single();

  if (error) {
    logger.error('Error creating agent:', error);
    throw error;
  }

  return data;
}

/**
 * Update an agent
 */
export async function updateAgent(agentId, updates) {
  const updateData = { ...updates, updated_at: new Date().toISOString() };

  const { data, error } = await supabaseAdmin
    .from('agents')
    .update(updateData)
    .eq('id', agentId)
    .select()
    .single();

  if (error) {
    logger.error('Error updating agent:', error);
    throw error;
  }

  return data;
}

/**
 * Delete an agent
 */
export async function deleteAgent(agentId) {
  const { error } = await supabaseAdmin
    .from('agents')
    .delete()
    .eq('id', agentId);

  if (error) {
    logger.error('Error deleting agent:', error);
    throw error;
  }

  return true;
}

/**
 * Count user's agents
 */
export async function countUserAgents(userId) {
  const { count, error } = await supabaseAdmin
    .from('agents')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId);

  if (error) {
    logger.error('Error counting user agents:', error);
    throw error;
  }

  return count || 0;
}

/**
 * Increment agent post count after successful post
 */
export async function incrementAgentPost(agentId) {
  const { error } = await supabaseAdmin.rpc('increment_agent_post', { p_agent_id: agentId });

  if (error) {
    // Fallback to direct update if function doesn't exist
    logger.warn('increment_agent_post RPC failed, using direct update:', error);
    await supabaseAdmin
      .from('agents')
      .update({
        posts_today: supabaseAdmin.sql`posts_today + 1`,
        total_posts: supabaseAdmin.sql`total_posts + 1`,
        last_posted_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', agentId);
  }
}

/**
 * Get the database instance (for backwards compatibility)
 * In Supabase, we just return the admin client
 */
export function getDb() {
  return supabaseAdmin;
}

export default {
  initializeDatabase,
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
  incrementAgentPost
};
