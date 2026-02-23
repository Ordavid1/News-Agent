/**
 * Database Service - Supabase Implementation
 *
 * Provides database operations using Supabase PostgreSQL
 * Maintains backwards compatibility with previous Firestore API
 */

import { supabaseAdmin, isConfigured, getConfigurationError } from './supabase.js';
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
  // Check if Supabase is configured
  if (!isConfigured()) {
    const error = getConfigurationError();
    logger.error('Supabase not configured:', error);
    throw new Error(`Database not configured: ${error}`);
  }

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
  const tier = rest.subscriptionTier || 'free';
  const profile = {
    id: authUserId,
    email,
    name,
    api_key: apiKey || null,
    subscription_tier: tier,
    subscription_status: rest.subscriptionStatus || 'active',
    posts_remaining: rest.postsRemaining || getTierPostLimit(tier),
    daily_limit: rest.dailyLimit || getTierPostLimit(tier),
    reset_date: getResetDateForTier(tier),
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
    free: 1,          // 1 post/week
    starter: 10,      // 10 posts/day
    growth: 20,       // 20 posts/day
    professional: 30, // 30 posts/day
    business: 45      // 45 posts/day
  };
  return limits[tier] || 1;
}

function getDailyResetDate() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  return tomorrow;
}

function getWeeklyResetDate() {
  const now = new Date();
  const nextWeek = new Date(now);
  nextWeek.setUTCDate(nextWeek.getUTCDate() + 7);
  nextWeek.setUTCHours(0, 0, 0, 0);
  return nextWeek;
}

function getResetDateForTier(tier) {
  // Free tier resets weekly, paid tiers reset daily
  return tier === 'free' ? getWeeklyResetDate() : getDailyResetDate();
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
 * Mark agent's test as used (one-time test per agent)
 * Once set, the Test button should be permanently disabled for this agent.
 */
export async function markAgentTestUsed(agentId) {
  const { data, error } = await supabaseAdmin
    .from('agents')
    .update({
      test_used_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('id', agentId)
    .is('test_used_at', null) // Only update if not already set
    .select()
    .single();

  if (error) {
    // PGRST116 means no rows matched (test already used) - that's OK
    if (error.code === 'PGRST116') {
      logger.info(`Agent ${agentId} test already used`);
      return null;
    }
    logger.error('Error marking agent test used:', error);
    throw error;
  }

  return data;
}

/**
 * Get the database instance (for backwards compatibility)
 * In Supabase, we just return the admin client
 */
export function getDb() {
  return supabaseAdmin;
}

// ============================================
// AGENT AUTOMATION FUNCTIONS
// ============================================

/**
 * Calculate posting interval in milliseconds based on schedule
 * Example: 3 posts/day in 12-hour window = 4 hours between posts
 */
function calculatePostingInterval(schedule) {
  const { postsPerDay, startTime, endTime } = schedule;

  // Parse times (HH:MM format)
  const [startH, startM] = startTime.split(':').map(Number);
  const [endH, endM] = endTime.split(':').map(Number);

  // Calculate window duration in minutes
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;
  const windowMinutes = endMinutes - startMinutes;

  // Calculate interval (divide window by posts per day)
  // Minimum interval is 30 minutes to avoid spam
  const intervalMinutes = Math.max(30, windowMinutes / Math.max(1, postsPerDay));
  return intervalMinutes * 60 * 1000; // Convert to milliseconds
}

/**
 * Check if current time is within agent's posting window
 */
function isWithinPostingWindow(schedule, timezone = 'UTC') {
  const { startTime, endTime } = schedule;

  // Get current time in the specified timezone
  const now = new Date();
  const currentTimeStr = now.toLocaleTimeString('en-GB', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone
  });

  return currentTimeStr >= startTime && currentTimeStr <= endTime;
}

/**
 * Get all active agents ready for posting
 *
 * Filters by:
 * - status = 'active'
 * - connection status = 'active'
 * - Current time within startTime-endTime window
 * - posts_today < postsPerDay
 * - Enough time passed since last_posted_at based on posting interval
 */
export async function getAgentsReadyForPosting() {
  try {
    // Get all active agents with their connection info
    const { data: agents, error } = await supabaseAdmin
      .from('agents')
      .select(`
        *,
        social_connections!inner (
          id,
          user_id,
          platform,
          status,
          platform_username,
          platform_user_id,
          platform_display_name
        )
      `)
      .eq('status', 'active')
      .eq('social_connections.status', 'active');

    if (error) {
      logger.error('Error fetching active agents:', error);
      throw error;
    }

    if (!agents || agents.length === 0) {
      logger.debug('No active agents found');
      return [];
    }

    const now = new Date();

    // Filter in application layer for complex conditions
    const readyAgents = agents.filter(agent => {
      const settings = agent.settings || {};
      const schedule = settings.schedule || {
        postsPerDay: 3,
        startTime: '09:00',
        endTime: '21:00'
      };

      // 1. Check if within time window (use UTC for consistency)
      if (!isWithinPostingWindow(schedule, 'UTC')) {
        logger.debug(`Agent ${agent.id}: Outside posting window (${schedule.startTime}-${schedule.endTime})`);
        return false;
      }

      // 2. Check posts_today limit
      const postsToday = agent.posts_today || 0;
      const maxPosts = schedule.postsPerDay || 3;
      if (postsToday >= maxPosts) {
        logger.debug(`Agent ${agent.id}: Daily limit reached (${postsToday}/${maxPosts})`);
        return false;
      }

      // 3. Check interval since last post
      if (agent.last_posted_at) {
        const intervalMs = calculatePostingInterval(schedule);
        const timeSinceLastPost = now - new Date(agent.last_posted_at);
        if (timeSinceLastPost < intervalMs) {
          const minutesLeft = Math.ceil((intervalMs - timeSinceLastPost) / 60000);
          logger.debug(`Agent ${agent.id}: Too soon since last post (${minutesLeft} min left)`);
          return false;
        }
      }

      return true;
    });

    logger.info(`Found ${readyAgents.length} agents ready for posting (out of ${agents.length} active)`);
    return readyAgents;

  } catch (error) {
    logger.error('Error in getAgentsReadyForPosting:', error);
    throw error;
  }
}

/**
 * Get agents for a specific platform that are ready for posting
 */
export async function getAgentsReadyForPlatform(platform) {
  const allReady = await getAgentsReadyForPosting();
  return allReady.filter(agent => agent.platform === platform);
}

/**
 * Reset daily post counts for all agents
 * Should be called at midnight (UTC or configured timezone)
 */
export async function resetDailyAgentPosts() {
  try {
    // Try to use the RPC function first
    const { error: rpcError } = await supabaseAdmin.rpc('reset_daily_agent_posts');

    if (rpcError) {
      // Fallback to direct update if function doesn't exist
      logger.warn('reset_daily_agent_posts RPC failed, using direct update:', rpcError.message);

      const { data, error: updateError } = await supabaseAdmin
        .from('agents')
        .update({
          posts_today: 0,
          updated_at: new Date().toISOString()
        })
        .neq('posts_today', 0) // Only update agents that have posts
        .select('id');

      if (updateError) {
        logger.error('Error resetting daily agent posts:', updateError);
        throw updateError;
      }

      logger.info(`Reset daily posts for ${data?.length || 0} agents (direct update)`);
      return data?.length || 0;
    }

    logger.info('Daily agent posts reset via RPC');
    return true;

  } catch (error) {
    logger.error('Failed to reset daily agent posts:', error);
    throw error;
  }
}

/**
 * Log automation event for an agent
 */
export async function logAgentAutomation(agentId, userId, eventType, details = {}) {
  try {
    const { error } = await supabaseAdmin
      .from('automation_logs')
      .insert({
        agent_id: agentId,
        user_id: userId,
        type: eventType,
        details: details,
        timestamp: new Date().toISOString()
      });

    if (error) {
      // Log but don't throw - this is non-critical
      logger.warn('Failed to log agent automation event:', error.message);
    }
  } catch (error) {
    logger.warn('Error in logAgentAutomation:', error.message);
  }
}

// ============================================
// MARKETING - ADD-ON MANAGEMENT
// ============================================

/**
 * Get marketing add-on for a user
 */
export async function getMarketingAddon(userId) {
  const { data, error } = await supabaseAdmin
    .from('marketing_addons')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    logger.error('Error getting marketing addon:', error);
    throw error;
  }

  return data;
}

/**
 * Get marketing add-on by Lemon Squeezy subscription ID
 */
export async function getMarketingAddonByLsId(lsSubscriptionId) {
  const { data, error } = await supabaseAdmin
    .from('marketing_addons')
    .select('*')
    .eq('ls_subscription_id', lsSubscriptionId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    logger.error('Error getting marketing addon by LS ID:', error);
    throw error;
  }

  return data;
}

/**
 * Create or update marketing add-on for a user
 */
export async function upsertMarketingAddon(addonData) {
  const { userId, ...rest } = addonData;

  const record = {
    user_id: userId,
    status: rest.status || 'active',
    ls_subscription_id: rest.lsSubscriptionId,
    ls_variant_id: rest.lsVariantId,
    plan: rest.plan || 'standard',
    monthly_price: rest.monthlyPrice || 0,
    max_ad_accounts: rest.maxAdAccounts || 1,
    max_active_campaigns: rest.maxActiveCampaigns || 10,
    max_audience_templates: rest.maxAudienceTemplates || 20,
    max_auto_boost_rules: rest.maxAutoBoostRules || 10,
    monthly_ad_budget_cap: rest.monthlyAdBudgetCap || null,
    current_period_start: rest.currentPeriodStart,
    current_period_end: rest.currentPeriodEnd,
    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabaseAdmin
    .from('marketing_addons')
    .upsert(record, { onConflict: 'user_id' })
    .select()
    .single();

  if (error) {
    logger.error('Error upserting marketing addon:', error);
    throw error;
  }

  return data;
}

/**
 * Update marketing add-on status
 */
export async function updateMarketingAddon(userId, updates) {
  const updateData = { ...updates, updated_at: new Date().toISOString() };

  const { data, error } = await supabaseAdmin
    .from('marketing_addons')
    .update(updateData)
    .eq('user_id', userId)
    .select()
    .single();

  if (error) {
    logger.error('Error updating marketing addon:', error);
    throw error;
  }

  return data;
}

// ============================================
// MARKETING - AD ACCOUNTS
// ============================================

/**
 * Get all ad accounts for a user
 */
export async function getUserAdAccounts(userId) {
  const { data, error } = await supabaseAdmin
    .from('ad_accounts')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error('Error getting user ad accounts:', error);
    throw error;
  }

  return data || [];
}

/**
 * Get the user's selected (active) ad account
 */
export async function getSelectedAdAccount(userId) {
  const { data, error } = await supabaseAdmin
    .from('ad_accounts')
    .select('*')
    .eq('user_id', userId)
    .eq('is_selected', true)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    logger.error('Error getting selected ad account:', error);
    throw error;
  }

  return data;
}

/**
 * Get ad account by ID
 */
export async function getAdAccountById(adAccountId) {
  const { data, error } = await supabaseAdmin
    .from('ad_accounts')
    .select('*')
    .eq('id', adAccountId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    logger.error('Error getting ad account by ID:', error);
    throw error;
  }

  return data;
}

/**
 * Upsert an ad account (create or update by user_id + account_id)
 */
export async function upsertAdAccount(accountData) {
  const { userId, ...rest } = accountData;

  const record = {
    user_id: userId,
    platform: rest.platform || 'facebook',
    account_id: rest.accountId,
    account_name: rest.accountName,
    account_status: rest.accountStatus || 1,
    currency: rest.currency || 'USD',
    timezone_name: rest.timezoneName,
    business_id: rest.businessId,
    is_selected: rest.isSelected || false,
    metadata: rest.metadata || {},
    status: rest.status || 'active',
    last_synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabaseAdmin
    .from('ad_accounts')
    .upsert(record, { onConflict: 'user_id,account_id' })
    .select()
    .single();

  if (error) {
    logger.error('Error upserting ad account:', error);
    throw error;
  }

  return data;
}

/**
 * Select an ad account (deselect all others for user, select this one)
 */
export async function selectAdAccount(userId, adAccountId) {
  // Deselect all accounts for this user
  await supabaseAdmin
    .from('ad_accounts')
    .update({ is_selected: false, updated_at: new Date().toISOString() })
    .eq('user_id', userId);

  // Select the specified account
  const { data, error } = await supabaseAdmin
    .from('ad_accounts')
    .update({ is_selected: true, updated_at: new Date().toISOString() })
    .eq('id', adAccountId)
    .eq('user_id', userId)
    .select()
    .single();

  if (error) {
    logger.error('Error selecting ad account:', error);
    throw error;
  }

  return data;
}

/**
 * Delete all ad accounts for a user (used when Facebook is disconnected)
 */
export async function deleteAllUserAdAccounts(userId) {
  const { error } = await supabaseAdmin
    .from('ad_accounts')
    .delete()
    .eq('user_id', userId);

  if (error) {
    logger.error('Error deleting all user ad accounts:', error);
    throw error;
  }
}

/**
 * Delete an ad account
 */
export async function deleteAdAccount(adAccountId) {
  const { error } = await supabaseAdmin
    .from('ad_accounts')
    .delete()
    .eq('id', adAccountId);

  if (error) {
    logger.error('Error deleting ad account:', error);
    throw error;
  }

  return true;
}

// ============================================
// MARKETING - CAMPAIGNS
// ============================================

/**
 * Get all campaigns for a user
 */
export async function getUserCampaigns(userId, filters = {}) {
  let query = supabaseAdmin
    .from('marketing_campaigns')
    .select('*')
    .eq('user_id', userId);

  if (filters.status) {
    query = query.eq('status', filters.status);
  }
  if (filters.adAccountId) {
    query = query.eq('ad_account_id', filters.adAccountId);
  }

  const { data, error } = await query.order('created_at', { ascending: false });

  if (error) {
    logger.error('Error getting user campaigns:', error);
    throw error;
  }

  return data || [];
}

/**
 * Get campaign by ID
 */
export async function getCampaignById(campaignId) {
  const { data, error } = await supabaseAdmin
    .from('marketing_campaigns')
    .select('*')
    .eq('id', campaignId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    logger.error('Error getting campaign by ID:', error);
    throw error;
  }

  return data;
}

/**
 * Create a marketing campaign
 */
export async function createCampaign(campaignData) {
  const { userId, adAccountId, ...rest } = campaignData;

  const record = {
    user_id: userId,
    ad_account_id: adAccountId,
    fb_campaign_id: rest.fbCampaignId || null,
    name: rest.name,
    objective: rest.objective,
    status: rest.status || 'draft',
    fb_status: rest.fbStatus || null,
    platforms: rest.platforms || ['facebook'],
    daily_budget: rest.dailyBudget || null,
    lifetime_budget: rest.lifetimeBudget || null,
    start_time: rest.startTime || null,
    end_time: rest.endTime || null,
    metadata: rest.metadata || {}
  };

  const { data, error } = await supabaseAdmin
    .from('marketing_campaigns')
    .insert(record)
    .select()
    .single();

  if (error) {
    logger.error('Error creating campaign:', error);
    throw error;
  }

  return data;
}

/**
 * Update a marketing campaign
 */
export async function updateCampaign(campaignId, updates) {
  const updateData = { ...updates, updated_at: new Date().toISOString() };

  const { data, error } = await supabaseAdmin
    .from('marketing_campaigns')
    .update(updateData)
    .eq('id', campaignId)
    .select()
    .single();

  if (error) {
    logger.error('Error updating campaign:', error);
    throw error;
  }

  return data;
}

/**
 * Delete a marketing campaign
 */
export async function deleteCampaign(campaignId) {
  const { error } = await supabaseAdmin
    .from('marketing_campaigns')
    .delete()
    .eq('id', campaignId);

  if (error) {
    logger.error('Error deleting campaign:', error);
    throw error;
  }

  return true;
}

/**
 * Count active campaigns for a user
 */
export async function countUserActiveCampaigns(userId) {
  const { count, error } = await supabaseAdmin
    .from('marketing_campaigns')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .in('status', ['draft', 'active', 'paused']);

  if (error) {
    logger.error('Error counting user campaigns:', error);
    throw error;
  }

  return count || 0;
}

// ============================================
// MARKETING - AD SETS
// ============================================

/**
 * Get ad sets for a campaign
 */
export async function getCampaignAdSets(campaignId) {
  const { data, error } = await supabaseAdmin
    .from('marketing_ad_sets')
    .select('*')
    .eq('campaign_id', campaignId)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error('Error getting campaign ad sets:', error);
    throw error;
  }

  return data || [];
}

/**
 * Get ad set by ID
 */
export async function getAdSetById(adSetId) {
  const { data, error } = await supabaseAdmin
    .from('marketing_ad_sets')
    .select('*')
    .eq('id', adSetId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    logger.error('Error getting ad set by ID:', error);
    throw error;
  }

  return data;
}

/**
 * Create an ad set
 */
export async function createAdSet(adSetData) {
  const { userId, campaignId, ...rest } = adSetData;

  const record = {
    user_id: userId,
    campaign_id: campaignId,
    fb_adset_id: rest.fbAdsetId || null,
    name: rest.name,
    status: rest.status || 'draft',
    fb_status: rest.fbStatus || null,
    targeting: rest.targeting || {},
    placements: rest.placements || {},
    billing_event: rest.billingEvent || 'IMPRESSIONS',
    bid_strategy: rest.bidStrategy || 'LOWEST_COST_WITHOUT_CAP',
    bid_amount: rest.bidAmount || null,
    daily_budget: rest.dailyBudget || null,
    lifetime_budget: rest.lifetimeBudget || null,
    start_time: rest.startTime || null,
    end_time: rest.endTime || null,
    metadata: rest.metadata || {}
  };

  const { data, error } = await supabaseAdmin
    .from('marketing_ad_sets')
    .insert(record)
    .select()
    .single();

  if (error) {
    logger.error('Error creating ad set:', error);
    throw error;
  }

  return data;
}

/**
 * Update an ad set
 */
export async function updateAdSet(adSetId, updates) {
  const updateData = { ...updates, updated_at: new Date().toISOString() };

  const { data, error } = await supabaseAdmin
    .from('marketing_ad_sets')
    .update(updateData)
    .eq('id', adSetId)
    .select()
    .single();

  if (error) {
    logger.error('Error updating ad set:', error);
    throw error;
  }

  return data;
}

/**
 * Delete an ad set
 */
export async function deleteAdSet(adSetId) {
  const { error } = await supabaseAdmin
    .from('marketing_ad_sets')
    .delete()
    .eq('id', adSetId);

  if (error) {
    logger.error('Error deleting ad set:', error);
    throw error;
  }

  return true;
}

// ============================================
// MARKETING - ADS
// ============================================

/**
 * Get ads for an ad set
 */
export async function getAdSetAds(adSetId) {
  const { data, error } = await supabaseAdmin
    .from('marketing_ads')
    .select('*')
    .eq('ad_set_id', adSetId)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error('Error getting ad set ads:', error);
    throw error;
  }

  return data || [];
}

/**
 * Get all ads for a user (across all campaigns)
 */
export async function getUserAds(userId, filters = {}) {
  let query = supabaseAdmin
    .from('marketing_ads')
    .select('*')
    .eq('user_id', userId);

  if (filters.status) {
    query = query.eq('status', filters.status);
  }

  // Filter by ad account: resolve through campaign → ad_set hierarchy
  if (filters.adAccountId) {
    const { data: campaigns } = await supabaseAdmin
      .from('marketing_campaigns')
      .select('id')
      .eq('user_id', userId)
      .eq('ad_account_id', filters.adAccountId);

    const campaignIds = (campaigns || []).map(c => c.id);
    if (campaignIds.length === 0) return [];

    const { data: adSets } = await supabaseAdmin
      .from('marketing_ad_sets')
      .select('id')
      .in('campaign_id', campaignIds);

    const adSetIds = (adSets || []).map(s => s.id);
    if (adSetIds.length === 0) return [];

    query = query.in('ad_set_id', adSetIds);
  }

  const { data, error } = await query.order('created_at', { ascending: false });

  if (error) {
    logger.error('Error getting user ads:', error);
    throw error;
  }

  return data || [];
}

/**
 * Get ad by ID
 */
export async function getAdById(adId) {
  const { data, error } = await supabaseAdmin
    .from('marketing_ads')
    .select('*')
    .eq('id', adId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    logger.error('Error getting ad by ID:', error);
    throw error;
  }

  return data;
}

/**
 * Create an ad
 */
export async function createAd(adData) {
  const { userId, adSetId, ...rest } = adData;

  const record = {
    user_id: userId,
    ad_set_id: adSetId,
    fb_ad_id: rest.fbAdId || null,
    fb_creative_id: rest.fbCreativeId || null,
    name: rest.name,
    status: rest.status || 'draft',
    fb_status: rest.fbStatus || null,
    source_published_post_id: rest.sourcePublishedPostId || null,
    platform_post_id: rest.platformPostId || null,
    source_platform: rest.sourcePlatform || 'facebook',
    creative_type: rest.creativeType || 'existing_post',
    creative_data: rest.creativeData || {},
    metadata: rest.metadata || {}
  };

  const { data, error } = await supabaseAdmin
    .from('marketing_ads')
    .insert(record)
    .select()
    .single();

  if (error) {
    logger.error('Error creating ad:', error);
    throw error;
  }

  return data;
}

/**
 * Update an ad
 */
export async function updateAd(adId, updates) {
  const updateData = { ...updates, updated_at: new Date().toISOString() };

  const { data, error } = await supabaseAdmin
    .from('marketing_ads')
    .update(updateData)
    .eq('id', adId)
    .select()
    .single();

  if (error) {
    logger.error('Error updating ad:', error);
    throw error;
  }

  return data;
}

/**
 * Delete an ad
 */
export async function deleteAd(adId) {
  const { error } = await supabaseAdmin
    .from('marketing_ads')
    .delete()
    .eq('id', adId);

  if (error) {
    logger.error('Error deleting ad:', error);
    throw error;
  }

  return true;
}

// ============================================
// MARKETING - AUDIENCE TEMPLATES
// ============================================

/**
 * Get all audience templates for a user
 */
export async function getUserAudienceTemplates(userId) {
  const { data, error } = await supabaseAdmin
    .from('audience_templates')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error('Error getting user audience templates:', error);
    throw error;
  }

  return data || [];
}

/**
 * Get audience template by ID
 */
export async function getAudienceTemplateById(templateId) {
  const { data, error } = await supabaseAdmin
    .from('audience_templates')
    .select('*')
    .eq('id', templateId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    logger.error('Error getting audience template by ID:', error);
    throw error;
  }

  return data;
}

/**
 * Create an audience template
 */
export async function createAudienceTemplate(templateData) {
  const { userId, ...rest } = templateData;

  const record = {
    user_id: userId,
    name: rest.name,
    description: rest.description || null,
    targeting: rest.targeting,
    platforms: rest.platforms || ['facebook', 'instagram'],
    estimated_reach: rest.estimatedReach || null,
    is_default: rest.isDefault || false,
    metadata: rest.metadata || {}
  };

  const { data, error } = await supabaseAdmin
    .from('audience_templates')
    .insert(record)
    .select()
    .single();

  if (error) {
    logger.error('Error creating audience template:', error);
    throw error;
  }

  return data;
}

/**
 * Update an audience template
 */
export async function updateAudienceTemplate(templateId, updates) {
  const updateData = { ...updates, updated_at: new Date().toISOString() };

  const { data, error } = await supabaseAdmin
    .from('audience_templates')
    .update(updateData)
    .eq('id', templateId)
    .select()
    .single();

  if (error) {
    logger.error('Error updating audience template:', error);
    throw error;
  }

  return data;
}

/**
 * Delete an audience template
 */
export async function deleteAudienceTemplate(templateId) {
  const { error } = await supabaseAdmin
    .from('audience_templates')
    .delete()
    .eq('id', templateId);

  if (error) {
    logger.error('Error deleting audience template:', error);
    throw error;
  }

  return true;
}

/**
 * Count audience templates for a user
 */
export async function countUserAudienceTemplates(userId) {
  const { count, error } = await supabaseAdmin
    .from('audience_templates')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId);

  if (error) {
    logger.error('Error counting audience templates:', error);
    throw error;
  }

  return count || 0;
}

// ============================================
// MARKETING - RULES
// ============================================

/**
 * Get all marketing rules for a user
 */
export async function getUserMarketingRules(userId) {
  const { data, error } = await supabaseAdmin
    .from('marketing_rules')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error('Error getting user marketing rules:', error);
    throw error;
  }

  return data || [];
}

/**
 * Get all active marketing rules (for the rules worker)
 */
export async function getActiveMarketingRules() {
  const { data, error } = await supabaseAdmin
    .from('marketing_rules')
    .select('*')
    .eq('status', 'active');

  if (error) {
    logger.error('Error getting active marketing rules:', error);
    throw error;
  }

  return data || [];
}

/**
 * Get marketing rule by ID
 */
export async function getMarketingRuleById(ruleId) {
  const { data, error } = await supabaseAdmin
    .from('marketing_rules')
    .select('*')
    .eq('id', ruleId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    logger.error('Error getting marketing rule by ID:', error);
    throw error;
  }

  return data;
}

/**
 * Create a marketing rule
 */
export async function createMarketingRule(ruleData) {
  const { userId, ...rest } = ruleData;

  const record = {
    user_id: userId,
    name: rest.name,
    rule_type: rest.ruleType,
    conditions: rest.conditions,
    actions: rest.actions,
    applies_to: rest.appliesTo || {},
    status: rest.status || 'active',
    cooldown_hours: rest.cooldownHours || 24,
    metadata: rest.metadata || {}
  };

  const { data, error } = await supabaseAdmin
    .from('marketing_rules')
    .insert(record)
    .select()
    .single();

  if (error) {
    logger.error('Error creating marketing rule:', error);
    throw error;
  }

  return data;
}

/**
 * Update a marketing rule
 */
export async function updateMarketingRule(ruleId, updates) {
  const updateData = { ...updates, updated_at: new Date().toISOString() };

  const { data, error } = await supabaseAdmin
    .from('marketing_rules')
    .update(updateData)
    .eq('id', ruleId)
    .select()
    .single();

  if (error) {
    logger.error('Error updating marketing rule:', error);
    throw error;
  }

  return data;
}

/**
 * Delete a marketing rule
 */
export async function deleteMarketingRule(ruleId) {
  const { error } = await supabaseAdmin
    .from('marketing_rules')
    .delete()
    .eq('id', ruleId);

  if (error) {
    logger.error('Error deleting marketing rule:', error);
    throw error;
  }

  return true;
}

/**
 * Count active marketing rules for a user
 */
export async function countUserMarketingRules(userId) {
  const { count, error } = await supabaseAdmin
    .from('marketing_rules')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'active');

  if (error) {
    logger.error('Error counting marketing rules:', error);
    throw error;
  }

  return count || 0;
}

/**
 * Log a marketing rule trigger
 */
export async function logRuleTrigger(triggerData) {
  const { ruleId, userId, ...rest } = triggerData;

  const record = {
    rule_id: ruleId,
    user_id: userId,
    published_post_id: rest.publishedPostId || null,
    platform: rest.platform || null,
    action_taken: rest.actionTaken || {},
    result: rest.result || {},
    success: rest.success !== undefined ? rest.success : true,
    error_message: rest.errorMessage || null
  };

  const { data, error } = await supabaseAdmin
    .from('marketing_rule_triggers')
    .insert(record)
    .select()
    .single();

  if (error) {
    // Log but don't throw - this is non-critical
    logger.warn('Failed to log rule trigger:', error.message);
    return null;
  }

  return data;
}

/**
 * Get rule trigger history
 */
export async function getRuleTriggerHistory(ruleId, limit = 50) {
  const { data, error } = await supabaseAdmin
    .from('marketing_rule_triggers')
    .select('*')
    .eq('rule_id', ruleId)
    .order('triggered_at', { ascending: false })
    .limit(limit);

  if (error) {
    logger.error('Error getting rule trigger history:', error);
    throw error;
  }

  return data || [];
}

// ============================================
// MARKETING - METRICS HISTORY
// ============================================

/**
 * Upsert daily metrics for a marketing entity
 */
export async function upsertMarketingMetrics(metricsData) {
  const { userId, entityType, entityId, fbEntityId, date, ...metrics } = metricsData;

  const record = {
    user_id: userId,
    entity_type: entityType,
    entity_id: entityId,
    fb_entity_id: fbEntityId,
    date: date,
    spend: metrics.spend || 0,
    impressions: metrics.impressions || 0,
    reach: metrics.reach || 0,
    clicks: metrics.clicks || 0,
    ctr: metrics.ctr || 0,
    cpc: metrics.cpc || 0,
    cpm: metrics.cpm || 0,
    additional_metrics: metrics.additionalMetrics || {}
  };

  const { data, error } = await supabaseAdmin
    .from('marketing_metrics_history')
    .upsert(record, { onConflict: 'entity_id,date' })
    .select()
    .single();

  if (error) {
    logger.error('Error upserting marketing metrics:', error);
    throw error;
  }

  return data;
}

/**
 * Get metrics history for an entity within a date range
 */
export async function getMarketingMetricsHistory(entityId, startDate, endDate) {
  const { data, error } = await supabaseAdmin
    .from('marketing_metrics_history')
    .select('*')
    .eq('entity_id', entityId)
    .gte('date', startDate)
    .lte('date', endDate)
    .order('date', { ascending: true });

  if (error) {
    const errorMsg = typeof error.message === 'string' && error.message.includes('<!DOCTYPE')
      ? 'Supabase returned an HTML error page (possible infrastructure issue or missing table)'
      : error.message;
    logger.error(`Error getting marketing metrics history: ${errorMsg}`, { code: error.code, details: error.details });
    throw error;
  }

  return data || [];
}

/**
 * Get aggregated marketing overview for a user
 * Optionally filtered by ad account (resolves entity hierarchy: campaigns → ad_sets → ads)
 */
export async function getMarketingOverview(userId, startDate, endDate, adAccountId = null) {
  const emptyOverview = { totalSpend: 0, totalImpressions: 0, totalReach: 0, totalClicks: 0, avgCtr: 0, avgCpc: 0, avgCpm: 0 };

  let query = supabaseAdmin
    .from('marketing_metrics_history')
    .select('spend, impressions, reach, clicks')
    .eq('user_id', userId)
    .gte('date', startDate)
    .lte('date', endDate);

  // If filtering by ad account, resolve entity IDs through the campaign hierarchy
  if (adAccountId) {
    const { data: campaigns } = await supabaseAdmin
      .from('marketing_campaigns')
      .select('id')
      .eq('user_id', userId)
      .eq('ad_account_id', adAccountId);

    const campaignIds = (campaigns || []).map(c => c.id);
    if (campaignIds.length === 0) return emptyOverview;

    const { data: adSets } = await supabaseAdmin
      .from('marketing_ad_sets')
      .select('id')
      .in('campaign_id', campaignIds);

    const adSetIds = (adSets || []).map(s => s.id);

    let adIds = [];
    if (adSetIds.length > 0) {
      const { data: ads } = await supabaseAdmin
        .from('marketing_ads')
        .select('id')
        .in('ad_set_id', adSetIds);
      adIds = (ads || []).map(a => a.id);
    }

    const allEntityIds = [...campaignIds, ...adSetIds, ...adIds];
    if (allEntityIds.length === 0) return emptyOverview;

    query = query.in('entity_id', allEntityIds);
  }

  const { data, error } = await query;

  if (error) {
    // Truncate error message if it contains HTML (e.g. Cloudflare error pages)
    const errorMsg = typeof error.message === 'string' && error.message.includes('<!DOCTYPE')
      ? 'Supabase returned an HTML error page (possible infrastructure issue or missing table)'
      : error.message;
    logger.error(`Error getting marketing overview: ${errorMsg}`, { code: error.code, details: error.details });
    throw error;
  }

  // Aggregate the metrics
  const overview = (data || []).reduce((acc, row) => {
    acc.totalSpend += parseFloat(row.spend) || 0;
    acc.totalImpressions += parseInt(row.impressions) || 0;
    acc.totalReach += parseInt(row.reach) || 0;
    acc.totalClicks += parseInt(row.clicks) || 0;
    return acc;
  }, { totalSpend: 0, totalImpressions: 0, totalReach: 0, totalClicks: 0 });

  overview.avgCtr = overview.totalImpressions > 0
    ? (overview.totalClicks / overview.totalImpressions * 100).toFixed(2)
    : 0;
  overview.avgCpc = overview.totalClicks > 0
    ? (overview.totalSpend / overview.totalClicks).toFixed(2)
    : 0;
  overview.avgCpm = overview.totalImpressions > 0
    ? (overview.totalSpend / overview.totalImpressions * 1000).toFixed(2)
    : 0;

  return overview;
}

/**
 * Create a published post record
 * Used by both automation (via DatabaseManager) and manual test posts (via routes/posts.js)
 */
export async function createPublishedPost(postData) {
  const record = {
    user_id: postData.userId,
    platform: postData.platform,
    platform_post_id: postData.platformPostId || null,
    platform_url: postData.platformUrl || null,
    content: postData.content || null,
    trend_topic: postData.trendTopic || null,
    topic: postData.topic || null,
    success: postData.success !== false,
    error_message: postData.errorMessage || null,
    agent_id: postData.agentId || null,
    engagement: postData.engagement || {},
    published_at: postData.publishedAt || new Date().toISOString()
  };

  const { data, error } = await supabaseAdmin
    .from('published_posts')
    .insert(record)
    .select()
    .single();

  if (error) {
    logger.error('Error creating published post:', error);
    throw error;
  }

  return data;
}

/**
 * Get boostable published posts (Facebook/Instagram posts that can be promoted)
 */
export async function getBoostablePublishedPosts(userId, limit = 50) {
  const { data, error } = await supabaseAdmin
    .from('published_posts')
    .select('*')
    .eq('user_id', userId)
    .in('platform', ['facebook', 'instagram'])
    .eq('success', true)
    .not('platform_post_id', 'is', null)
    .order('published_at', { ascending: false })
    .limit(limit);

  if (error) {
    logger.error('Error getting boostable posts:', error);
    throw error;
  }

  return data || [];
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
};
