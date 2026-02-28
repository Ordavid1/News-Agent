import express from 'express';
import config from './src/config/index.js';
import logger from './src/utils/logger.js';
import SessionManager from './src/session/SessionManager.js';
import RateLimiter from './src/safety/RateLimiter.js';
import MessageService from './src/services/MessageService.js';
import GroupService from './src/services/GroupService.js';
import AccountService from './src/services/AccountService.js';
import WebhookForwarder from './src/services/WebhookForwarder.js';
import createRoutes from './src/api/routes.js';
import { authenticateApiKey, errorHandler } from './src/api/middleware.js';

// ──────────────────────────────────────────
// Initialize components
// ──────────────────────────────────────────

const sessionManager = new SessionManager(config);

const rateLimiter = new RateLimiter({
  maxPerMinute: config.messagesPerMinute,
  maxPerHour: config.messagesPerHour,
  minDelayMs: config.minMessageDelayMs,
  maxDelayMs: config.maxMessageDelayMs
});

const messageService = new MessageService(sessionManager, rateLimiter);
const groupService = new GroupService(sessionManager);
const accountService = new AccountService(sessionManager);

// Webhook forwarder registers itself as a message listener
new WebhookForwarder(config, sessionManager);

// ──────────────────────────────────────────
// Express server
// ──────────────────────────────────────────

const app = express();

app.use(express.json({ limit: '2mb' }));
app.use(authenticateApiKey);

// Mount API routes
app.use('/', createRoutes({
  sessionManager,
  messageService,
  groupService,
  accountService,
  rateLimiter
}));

app.use(errorHandler);

// ──────────────────────────────────────────
// Start server and WhatsApp connection
// ──────────────────────────────────────────

const server = app.listen(config.port, () => {
  logger.info(`WhatsApp Bridge Service running on port ${config.port}`);
  logger.info(`Health check: http://localhost:${config.port}/health`);
});

// Initialize WhatsApp connection (non-blocking)
sessionManager.initialize().catch(err => {
  logger.error('Failed to initialize WhatsApp session:', err.message);
});

// ──────────────────────────────────────────
// Graceful shutdown
// ──────────────────────────────────────────

async function gracefulShutdown(signal) {
  logger.info(`${signal} received - starting graceful shutdown`);

  // Stop accepting new HTTP connections
  server.close(() => {
    logger.info('HTTP server closed');
  });

  // Disconnect WhatsApp
  try {
    await sessionManager.shutdown();
  } catch (err) {
    logger.error('Error during shutdown:', err.message);
  }

  // Allow pending operations to complete (max 5s)
  setTimeout(() => {
    logger.info('Shutdown complete');
    process.exit(0);
  }, 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Catch unhandled errors to prevent silent crashes
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err);
  gracefulShutdown('uncaughtException');
});
