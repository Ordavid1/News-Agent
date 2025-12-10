// middleware/auditLog.js
// SECURITY: Audit logging for security-sensitive operations

import winston from 'winston';

const auditLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          return `${timestamp} [AUDIT] ${level}: ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
        })
      )
    }),
    // In production, add file transport or external logging service
    new winston.transports.File({ filename: 'audit.log' })
  ]
});

/**
 * Create audit log middleware for specific actions
 * @param {string} action - The action being performed
 * @returns {Function} Express middleware
 */
export function auditLog(action) {
  return (req, res, next) => {
    const startTime = Date.now();

    // Capture response
    const originalSend = res.send;
    res.send = function(body) {
      const duration = Date.now() - startTime;

      const logEntry = {
        timestamp: new Date().toISOString(),
        action,
        userId: req.user?.id || 'anonymous',
        userEmail: req.user?.email || 'unknown',
        ip: req.ip || req.connection?.remoteAddress,
        userAgent: req.get('User-Agent'),
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        duration: `${duration}ms`
      };

      // Log security-relevant events
      if (res.statusCode >= 400) {
        auditLogger.warn(`${action} failed`, logEntry);
      } else {
        auditLogger.info(`${action} succeeded`, logEntry);
      }

      return originalSend.call(this, body);
    };

    next();
  };
}

/**
 * Log authentication events
 */
export function logAuthEvent(event, details) {
  auditLogger.info(`Auth event: ${event}`, {
    timestamp: new Date().toISOString(),
    event,
    ...details
  });
}

/**
 * Log security-sensitive events
 */
export function logSecurityEvent(event, details) {
  auditLogger.warn(`Security event: ${event}`, {
    timestamp: new Date().toISOString(),
    event,
    ...details
  });
}

export default {
  auditLog,
  logAuthEvent,
  logSecurityEvent
};
