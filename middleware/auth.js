/**
 * Authentication Middleware
 *
 * Supports both legacy JWT authentication and Supabase Auth.
 * The system will gradually migrate to Supabase Auth.
 */

import jwt from 'jsonwebtoken';
import { supabaseAdmin } from '../services/supabase.js';
import { getUserById } from '../services/database.js';

// SECURITY: JWT_SECRET must be set - validated at runtime, not module load
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[AUTH] FATAL: JWT_SECRET environment variable must be set');
}

// Helper to check if auth is configured
function isAuthConfigured() {
  return !!JWT_SECRET;
}

/**
 * Authenticate token middleware
 * Supports: httpOnly cookies (preferred), Authorization header, and Supabase JWT tokens
 */
export async function authenticateToken(req, res, next) {
  // Check if auth is configured (JWT_SECRET required for legacy tokens)
  if (!isAuthConfigured()) {
    return res.status(503).json({ error: 'Authentication service not configured' });
  }

  // SECURITY: Check httpOnly cookie first (most secure), then Authorization header
  const cookieToken = req.cookies?.authToken;
  const authHeader = req.headers['authorization'];
  const headerToken = authHeader && authHeader.split(' ')[1];

  const token = cookieToken || headerToken;

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    // First, try to verify as Supabase JWT
    const { data: { user: supabaseUser }, error: supabaseError } = await supabaseAdmin.auth.getUser(token);

    if (supabaseUser && !supabaseError) {
      // Supabase token - fetch user profile
      const user = await getUserById(supabaseUser.id);
      if (!user) {
        return res.status(403).json({ error: 'User profile not found' });
      }
      req.user = user;
      req.authMethod = 'supabase';
      return next();
    }

    // Fall back to legacy JWT verification
    const decoded = jwt.verify(token, JWT_SECRET);
    const userId = decoded.userId || decoded.id || decoded.sub;

    const user = await getUserById(userId);
    if (!user) {
      return res.status(403).json({ error: 'User not found' });
    }

    req.user = user;
    req.authMethod = 'legacy';
    next();
  } catch (error) {
    // If both methods fail, token is invalid
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Generate a legacy JWT token
 * Used for backwards compatibility during migration
 */
export function generateToken(userId) {
  return jwt.sign(
    { userId },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

/**
 * Optional authentication - continues even without token
 */
export async function optionalAuth(req, res, next) {
  // SECURITY: Check httpOnly cookie first (most secure), then Authorization header
  const cookieToken = req.cookies?.authToken;
  const authHeader = req.headers['authorization'];
  const headerToken = authHeader && authHeader.split(' ')[1];

  const token = cookieToken || headerToken;

  if (!token) {
    req.user = null;
    return next();
  }

  try {
    // Try Supabase first
    const { data: { user: supabaseUser }, error } = await supabaseAdmin.auth.getUser(token);

    if (supabaseUser && !error) {
      const user = await getUserById(supabaseUser.id);
      req.user = user;
      req.authMethod = 'supabase';
      return next();
    }

    // Fall back to legacy JWT
    const decoded = jwt.verify(token, JWT_SECRET);
    const userId = decoded.userId || decoded.id || decoded.sub;
    const user = await getUserById(userId);
    req.user = user;
    req.authMethod = 'legacy';
    next();
  } catch (error) {
    // Continue without user if token is invalid
    req.user = null;
    next();
  }
}

/**
 * Require admin role
 */
export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

/**
 * Require specific subscription tier
 */
export function requireTier(minTier) {
  const tierOrder = ['free', 'starter', 'growth', 'professional', 'business'];

  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const userTier = req.user.subscription?.tier || 'free';
    const userTierIndex = tierOrder.indexOf(userTier);
    const requiredTierIndex = tierOrder.indexOf(minTier);

    if (userTierIndex < requiredTierIndex) {
      return res.status(403).json({
        error: `This feature requires ${minTier} tier or higher`,
        currentTier: userTier,
        requiredTier: minTier
      });
    }

    next();
  };
}

/**
 * Verify Supabase session from cookie/header
 * Used for frontend session validation
 */
export async function verifySupabaseSession(req, res, next) {
  const accessToken = req.headers['x-supabase-access-token'] ||
                      req.cookies?.['sb-access-token'];

  if (!accessToken) {
    return res.status(401).json({ error: 'No session found' });
  }

  try {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(accessToken);

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid session' });
    }

    const profile = await getUserById(user.id);
    req.user = profile;
    req.supabaseUser = user;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Session verification failed' });
  }
}

export default {
  authenticateToken,
  generateToken,
  optionalAuth,
  requireAdmin,
  requireTier,
  verifySupabaseSession
};
