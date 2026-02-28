import config from '../config/index.js';
import logger from '../utils/logger.js';

/**
 * API key authentication middleware.
 * Validates Bearer token against the configured API_KEY.
 * Skips auth for the /health endpoint (needed for Render health checks).
 */
function authenticateApiKey(req, res, next) {
  // Skip auth for health check
  if (req.path === '/health') {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn(`Unauthorized request to ${req.method} ${req.path} from ${req.ip}`);
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const key = authHeader.substring(7); // Remove 'Bearer '
  if (key !== config.apiKey) {
    logger.warn(`Invalid API key for ${req.method} ${req.path} from ${req.ip}`);
    return res.status(403).json({ error: 'Invalid API key' });
  }

  next();
}

/**
 * Error handling middleware — catches unhandled route errors
 */
function errorHandler(err, req, res, _next) {
  logger.error(`Unhandled error on ${req.method} ${req.path}: ${err.message}`, {
    stack: err.stack
  });

  res.status(500).json({
    error: err.message || 'Internal server error'
  });
}

export { authenticateApiKey, errorHandler };
