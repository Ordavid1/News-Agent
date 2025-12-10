// middleware/rateLimiter.js
// SECURITY: Rate limiting to prevent brute force and DoS attacks
import rateLimit from 'express-rate-limit';

// General API rate limiter
export const rateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests from this IP, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// SECURITY: Stricter rate limiter for auth endpoints
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 requests per windowMs
  message: { error: 'Too many authentication attempts, please try again later.' },
  skipSuccessfulRequests: false, // SECURITY: Count ALL attempts, not just failures
  standardHeaders: true,
  legacyHeaders: false,
});

// SECURITY: Very strict rate limiter for sensitive operations (password reset, etc.)
export const sensitiveOperationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // Only 3 attempts per hour
  message: { error: 'Too many attempts. Please try again later.' },
  skipSuccessfulRequests: false,
  standardHeaders: true,
  legacyHeaders: false,
});

// SECURITY: Demo endpoint rate limiter (aggressive to prevent abuse)
export const demoLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 requests per hour per IP
  message: { error: 'Demo limit reached. Please sign up for more access.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// SECURITY: Account lockout tracking (in production, use Redis)
const accountLockouts = new Map();

export function checkAccountLockout(identifier) {
  const lockout = accountLockouts.get(identifier);
  if (!lockout) {
    return { locked: false };
  }

  if (lockout.lockedUntil && lockout.lockedUntil > Date.now()) {
    const remainingMs = lockout.lockedUntil - Date.now();
    const remainingMinutes = Math.ceil(remainingMs / 60000);
    return { locked: true, remainingMinutes };
  }

  // Lockout expired, clear it
  accountLockouts.delete(identifier);
  return { locked: false };
}

export function recordFailedAttempt(identifier) {
  const lockout = accountLockouts.get(identifier) || { failedAttempts: 0 };
  lockout.failedAttempts += 1;
  lockout.lastAttempt = Date.now();

  // Lock account after 5 failed attempts for 15 minutes
  if (lockout.failedAttempts >= 5) {
    lockout.lockedUntil = Date.now() + (15 * 60 * 1000);
    console.log(`[SECURITY] Account locked: ${identifier} for 15 minutes`);
  }

  accountLockouts.set(identifier, lockout);
  return lockout;
}

export function clearFailedAttempts(identifier) {
  accountLockouts.delete(identifier);
}

// Post generation rate limiter (based on subscription)
export const postGenerationLimiter = (req, res, next) => {
  const tier = req.user?.subscription?.tier || 'free';

  // Define rate limits per tier (requests per hour)
  const tierLimits = {
    free: 5,
    starter: 20,
    growth: 50,
    professional: 100,
    business: 200
  };

  const limit = tierLimits[tier] || 5;

  const limiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: limit,
    message: { error: `Rate limit exceeded. Your ${tier} plan allows ${limit} post generations per hour.` },
    keyGenerator: (req) => req.user.id, // Rate limit by user ID, not IP
    standardHeaders: true,
    legacyHeaders: false,
  });

  limiter(req, res, next);
};

export default {
  rateLimiter,
  authLimiter,
  sensitiveOperationLimiter,
  demoLimiter,
  postGenerationLimiter,
  checkAccountLockout,
  recordFailedAttempt,
  clearFailedAttempts
};
