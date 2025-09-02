// middleware/rateLimiter.js
import rateLimit from 'express-rate-limit';

// General API rate limiter
export const rateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter rate limiter for auth endpoints
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 requests per windowMs
  message: 'Too many authentication attempts, please try again later.',
  skipSuccessfulRequests: true,
});

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
    message: `Rate limit exceeded. Your ${tier} plan allows ${limit} post generations per hour.`,
    keyGenerator: (req) => req.user.id, // Rate limit by user ID, not IP
  });
  
  limiter(req, res, next);
};