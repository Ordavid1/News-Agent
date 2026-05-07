// routes/internal-cron.js
//
// HTTP endpoints driven by Cloud Scheduler. Each replaces an in-process
// node-cron / setInterval timer that ran inside Render's single instance.
// On Cloud Run with autoscaling, in-process timers double-fire across
// instances; centralizing in Cloud Scheduler guarantees exactly-once
// firing per tick across the whole deployment.
//
// Auth: every request must carry a valid Google-signed OIDC token whose
// `aud` claim matches our Cloud Run service URL and whose `email` claim
// matches the scheduler-invoker service account. We accept any
// service account in the configured allow-list to keep deploy-time
// flexibility (e.g., manually firing a tick with `gcloud auth print-identity-token`
// during incident response).

import express from 'express';
import { OAuth2Client } from 'google-auth-library';
import winston from 'winston';
import postingWorker from '../workers/postingWorker.js';
import tokenRefreshWorker from '../workers/tokenRefreshWorker.js';
import marketingMetricsWorker from '../workers/marketingMetricsWorker.js';
import marketingRulesWorker from '../workers/marketingRulesWorker.js';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()]
});

const router = express.Router();
const oauthClient = new OAuth2Client();

// Allow-list: which OIDC token issuers may invoke /internal/cron/*.
// Empty list (default) ⇒ middleware is a no-op (useful for local dev).
// Comma-separated emails in INTERNAL_CRON_ALLOWED_INVOKERS in production.
function getAllowedInvokers() {
  const raw = (process.env.INTERNAL_CRON_ALLOWED_INVOKERS || '').trim();
  return raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
}

// Expected OIDC `aud` claim — set to the public URL of this Cloud Run service.
// In Cloud Run the request URL is rewritten internally; the JWT was minted
// against the customer-facing URL so we trust process.env.INTERNAL_CRON_AUD.
function getExpectedAudience() {
  return process.env.INTERNAL_CRON_AUD || '';
}

/**
 * Verify the Bearer token. Skips entirely if no allow-list is configured
 * (local dev / first-deploy bring-up). Once INTERNAL_CRON_ALLOWED_INVOKERS
 * is set in production, every request is authenticated.
 */
async function verifyOidcMiddleware(req, res, next) {
  const allowed = getAllowedInvokers();
  if (allowed.length === 0) {
    logger.warn('[internal-cron] OIDC verification SKIPPED — INTERNAL_CRON_ALLOWED_INVOKERS empty. Set in production.');
    return next();
  }

  const auth = req.header('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    return res.status(401).json({ error: 'missing_bearer' });
  }
  const token = m[1];
  const audience = getExpectedAudience();
  if (!audience) {
    logger.error('[internal-cron] INTERNAL_CRON_AUD not configured — refusing all requests');
    return res.status(500).json({ error: 'audience_not_configured' });
  }

  try {
    const ticket = await oauthClient.verifyIdToken({ idToken: token, audience });
    const payload = ticket.getPayload();
    const email = payload?.email;
    if (!email || !allowed.includes(email)) {
      logger.warn(`[internal-cron] rejected token from email=${email}`);
      return res.status(403).json({ error: 'forbidden_invoker' });
    }
    req.oidcEmail = email;
    return next();
  } catch (err) {
    logger.warn(`[internal-cron] OIDC verify failed: ${err.message}`);
    return res.status(401).json({ error: 'invalid_token' });
  }
}

router.use(verifyOidcMiddleware);

// Helper: standardize handler envelope so each tick logs uniformly and
// returns a consistent JSON response the Scheduler retry policy can read.
function tick(name, fn) {
  return async (req, res) => {
    const startedAt = Date.now();
    logger.info(`[cron-tick] ${name} START invoker=${req.oidcEmail || 'anonymous'}`);
    try {
      const result = await fn(req);
      const durationMs = Date.now() - startedAt;
      logger.info(`[cron-tick] ${name} OK durationMs=${durationMs}`);
      res.json({ ok: true, name, durationMs, result: result ?? null });
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      logger.error(`[cron-tick] ${name} FAIL durationMs=${durationMs} error=${err.message}`);
      res.status(500).json({ ok: false, name, durationMs, error: err.message });
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Replacements for AutomationManager's node-cron schedules
// ─────────────────────────────────────────────────────────────────────────────

// Was: `*/5 * * * *` → AutomationManager.processActiveAgents
router.post('/agent-loop', tick('agent-loop', async (req) => {
  const am = req.app.locals.automationManager;
  if (!am) throw new Error('automationManager not initialized');
  await am.processActiveAgents();
}));

// Was: `0 0 * * *` (daily midnight UTC)
router.post('/daily-reset', tick('daily-reset', async (req) => {
  const am = req.app.locals.automationManager;
  if (!am) throw new Error('automationManager not initialized');
  await am.runDailyResetTick();
  am.runRateLimiterCleanupTick();
}));

// Was: `0 23 * * *` (daily 23:00 UTC)
router.post('/daily-analytics', tick('daily-analytics', async (req) => {
  const am = req.app.locals.automationManager;
  if (!am) throw new Error('automationManager not initialized');
  await am.generateDailyReport();
}));

// Was: `0 0 * * 0` (weekly Sunday midnight UTC)
router.post('/weekly-maintenance', tick('weekly-maintenance', async (req) => {
  const am = req.app.locals.automationManager;
  if (!am) throw new Error('automationManager not initialized');
  await am.performMaintenance();
}));

// Was: `0 2 * * *` (daily 02:00 UTC)
router.post('/veo-failure-learning', tick('veo-failure-learning', async (req) => {
  const am = req.app.locals.automationManager;
  if (!am) throw new Error('automationManager not initialized');
  return await am.runVeoFailureLearningTick();
}));

// ─────────────────────────────────────────────────────────────────────────────
// Replacements for in-process workers (every-N-min setInterval timers)
// ─────────────────────────────────────────────────────────────────────────────

router.post('/posting-tick', tick('posting-tick', async () => {
  await postingWorker.runOnce();
}));

router.post('/token-refresh-tick', tick('token-refresh-tick', async () => {
  await tokenRefreshWorker.runOnce();
}));

router.post('/marketing-metrics-tick', tick('marketing-metrics-tick', async () => {
  await marketingMetricsWorker.runOnce();
}));

router.post('/marketing-rules-tick', tick('marketing-rules-tick', async () => {
  await marketingRulesWorker.runOnce();
}));

export default router;
