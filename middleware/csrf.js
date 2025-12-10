// middleware/csrf.js
// SECURITY: CSRF protection using double-submit cookie pattern
// This is more compatible than csurf (which is deprecated) and works well with SPAs

import crypto from 'crypto';

// Generate a cryptographically secure CSRF token
function generateCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Cookie options for CSRF token
const CSRF_COOKIE_OPTIONS = {
  httpOnly: false, // Must be readable by JavaScript to include in headers
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: 24 * 60 * 60 * 1000, // 24 hours
  path: '/'
};

/**
 * Middleware to set CSRF token cookie if not present
 * Should be applied early in the middleware chain
 */
export function csrfTokenSetter(req, res, next) {
  // If no CSRF token cookie exists, set one
  if (!req.cookies?.csrfToken) {
    const token = generateCsrfToken();
    res.cookie('csrfToken', token, CSRF_COOKIE_OPTIONS);
    req.csrfToken = token;
  } else {
    req.csrfToken = req.cookies.csrfToken;
  }
  next();
}

/**
 * Middleware to validate CSRF token on state-changing requests
 * Compares token in header/body with cookie token (double-submit pattern)
 */
export function csrfProtection(req, res, next) {
  // Skip CSRF for safe methods
  const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
  if (safeMethods.includes(req.method)) {
    return next();
  }

  // Get token from cookie
  const cookieToken = req.cookies?.csrfToken;

  // Get token from header (preferred) or body
  const headerToken = req.headers['x-csrf-token'];
  const bodyToken = req.body?._csrf;
  const submittedToken = headerToken || bodyToken;

  // Validate tokens exist
  if (!cookieToken) {
    console.warn(`[CSRF] Missing cookie token - IP: ${req.ip}, Path: ${req.path}`);
    return res.status(403).json({
      error: 'CSRF validation failed',
      message: 'Session expired. Please refresh the page.'
    });
  }

  if (!submittedToken) {
    console.warn(`[CSRF] Missing request token - IP: ${req.ip}, Path: ${req.path}`);
    return res.status(403).json({
      error: 'CSRF validation failed',
      message: 'Missing security token. Please refresh the page.'
    });
  }

  // Timing-safe comparison to prevent timing attacks
  try {
    const cookieBuffer = Buffer.from(cookieToken);
    const submittedBuffer = Buffer.from(submittedToken);

    if (cookieBuffer.length !== submittedBuffer.length ||
        !crypto.timingSafeEqual(cookieBuffer, submittedBuffer)) {
      console.warn(`[CSRF] Token mismatch - IP: ${req.ip}, Path: ${req.path}`);
      return res.status(403).json({
        error: 'CSRF validation failed',
        message: 'Security token mismatch. Please refresh the page.'
      });
    }
  } catch (error) {
    console.error('[CSRF] Validation error:', error.message);
    return res.status(403).json({
      error: 'CSRF validation failed',
      message: 'Invalid security token.'
    });
  }

  next();
}

/**
 * Endpoint handler to get a fresh CSRF token
 * Frontend should call this on page load or when token expires
 */
export function getCsrfToken(req, res) {
  // Generate new token
  const token = generateCsrfToken();
  res.cookie('csrfToken', token, CSRF_COOKIE_OPTIONS);

  res.json({
    success: true,
    csrfToken: token
  });
}

/**
 * Create CSRF middleware that can be selectively applied
 * Use this for routes that need CSRF protection
 */
export function createCsrfMiddleware() {
  return csrfProtection;
}

export default {
  csrfTokenSetter,
  csrfProtection,
  getCsrfToken,
  createCsrfMiddleware
};
