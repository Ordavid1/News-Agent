import { Router } from 'express';
import logger from '../utils/logger.js';

/**
 * Create REST API routes.
 * Endpoint paths and response shapes are designed to be compatible
 * with the Whapi.cloud API that the SaaS app currently calls.
 *
 * @param {Object} params
 * @param {import('../session/SessionManager.js').default} params.sessionManager
 * @param {import('../services/MessageService.js').default} params.messageService
 * @param {import('../services/GroupService.js').default} params.groupService
 * @param {import('../services/AccountService.js').default} params.accountService
 * @param {import('../safety/RateLimiter.js').default} params.rateLimiter
 */
function createRoutes({ sessionManager, messageService, groupService, accountService, rateLimiter }) {
  const router = Router();

  // ──────────────────────────────────────────
  // Health check (no auth required)
  // ──────────────────────────────────────────
  router.get('/health', (req, res) => {
    const status = sessionManager.getStatus();

    // If there's a QR code and the request accepts HTML, show a scannable page
    if (status.hasQR && req.accepts('html')) {
      const qr = sessionManager.getQRCode();
      return res.type('html').send(`
        <!DOCTYPE html>
        <html><head><title>WhatsApp Bridge - QR Pairing</title>
        <meta http-equiv="refresh" content="30">
        <style>body{font-family:system-ui;text-align:center;padding:40px;background:#111;color:#fff}
        img{border-radius:12px;margin:20px}</style></head>
        <body>
          <h1>WhatsApp Bridge</h1>
          <p>Scan this QR code with WhatsApp to pair:</p>
          <img src="${qr}" alt="QR Code" />
          <p style="color:#888">This page auto-refreshes every 30 seconds</p>
        </body></html>
      `);
    }

    res.json(status);
  });

  // ──────────────────────────────────────────
  // Account settings (Whapi-compatible: GET /settings)
  // ──────────────────────────────────────────
  router.get('/settings', (req, res, next) => {
    try {
      const settings = accountService.getSettings();
      res.json(settings);
    } catch (err) {
      next(err);
    }
  });

  // ──────────────────────────────────────────
  // List all groups (Whapi-compatible: GET /groups)
  // ──────────────────────────────────────────
  router.get('/groups', async (req, res, next) => {
    try {
      const result = await groupService.listGroups();
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // ──────────────────────────────────────────
  // Get specific group info (Whapi-compatible: GET /groups/:id)
  // ──────────────────────────────────────────
  router.get('/groups/:id', async (req, res, next) => {
    try {
      const group = await groupService.getGroupMetadata(req.params.id);
      res.json(group);
    } catch (err) {
      if (err.message?.includes('not-authorized') || err.message?.includes('item-not-found')) {
        return res.status(404).json({ error: 'Group not found or not accessible' });
      }
      next(err);
    }
  });

  // ──────────────────────────────────────────
  // Send text message (Whapi-compatible: POST /messages/text)
  // ──────────────────────────────────────────
  router.post('/messages/text', async (req, res, next) => {
    try {
      const { to, body } = req.body;

      if (!to || !body) {
        return res.status(400).json({ error: '"to" and "body" are required' });
      }

      // Check rate limit status before queuing
      const limitStatus = rateLimiter.getStatus();
      if (!limitStatus.allowed) {
        return res.status(429).json({
          error: 'Rate limit exceeded',
          retryAfterMs: limitStatus.waitMs,
          minuteRemaining: limitStatus.minuteRemaining,
          hourRemaining: limitStatus.hourRemaining
        });
      }

      const result = await messageService.sendText(to, body);
      res.json(result);
    } catch (err) {
      if (err.message === 'WhatsApp not connected') {
        return res.status(503).json({ error: 'WhatsApp not connected' });
      }
      next(err);
    }
  });

  // ──────────────────────────────────────────
  // Send image message (Whapi-compatible: POST /messages/image)
  // ──────────────────────────────────────────
  router.post('/messages/image', async (req, res, next) => {
    try {
      const { to, media, caption } = req.body;

      if (!to || !media) {
        return res.status(400).json({ error: '"to" and "media" are required' });
      }

      // Check rate limit status before queuing
      const limitStatus = rateLimiter.getStatus();
      if (!limitStatus.allowed) {
        return res.status(429).json({
          error: 'Rate limit exceeded',
          retryAfterMs: limitStatus.waitMs,
          minuteRemaining: limitStatus.minuteRemaining,
          hourRemaining: limitStatus.hourRemaining
        });
      }

      const result = await messageService.sendImage(to, media, caption || '');
      res.json(result);
    } catch (err) {
      if (err.message === 'WhatsApp not connected') {
        return res.status(503).json({ error: 'WhatsApp not connected' });
      }
      if (err.message.includes('5MB')) {
        return res.status(413).json({ error: err.message });
      }
      next(err);
    }
  });

  // ──────────────────────────────────────────
  // Admin: manually reset circuit breaker
  // ──────────────────────────────────────────
  router.post('/admin/reset-circuit', (req, res) => {
    sessionManager.circuitBreaker.reset();
    res.json({ success: true, message: 'Circuit breaker reset' });
  });

  // ──────────────────────────────────────────
  // Admin: trigger reconnection
  // ──────────────────────────────────────────
  router.post('/admin/reconnect', async (req, res) => {
    try {
      logger.info('Manual reconnect triggered');
      sessionManager.circuitBreaker.reset();
      await sessionManager.initialize();
      res.json({ success: true, message: 'Reconnection initiated' });
    } catch (err) {
      res.status(500).json({ error: `Reconnection failed: ${err.message}` });
    }
  });

  return router;
}

export default createRoutes;
