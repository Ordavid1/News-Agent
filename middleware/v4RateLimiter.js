// middleware/v4RateLimiter.js
// V4 Brand Story beat-mutation rate limiters.
//
// Why this exists:
//   The 4 mutating V4 routes (regenerate / patch / delete / reassemble) are
//   gated by authenticateToken + requireTier('business') at the router level,
//   so authorization is airtight. But the cost cap enforced in the BeatRouter
//   is PER-EPISODE ($10/$15) — a malicious or bugged client that loops the
//   regenerate endpoint can kick a fresh runV4Pipeline run each call and burn
//   through the cap across many episodes before any alarm fires. Mode B
//   dialogue beats cost ~$1.40 each, so a tight regenerate loop racks up
//   hundreds of dollars in minutes.
//
// Strategy:
//   Per-story sliding-window limits, one limiter per endpoint category with
//   different caps. Keyed on (userId, storyId) so one user's noise on one
//   story doesn't block another. In-memory backing for Phase 1c — upgrade to
//   Redis in Phase 2 when multi-instance deploys are standard.
//
// Limits (sensible defaults; tune after live traffic):
//   - regenerate:  10 per 5 min per story  (the expensive one)
//   - reassemble:   5 per 10 min per story (post-production only, CPU cost)
//   - patch:       30 per 1 min per story  (edits — cheap, allow rapid iteration)
//   - delete:      10 per 5 min per story  (irreversible, but cheap)
//
// The key generator uses req.user.id + req.params.id (the story id). If
// either is missing we fall back to the IP (express-rate-limit's default
// behavior) so nothing crashes — but in practice both are always present
// because authenticateToken + the route params guard it.
//
// Error shape matches the rest of the V4 routes: {success: false, error: '…'}
// so the Director's Panel can display it cleanly.

import rateLimit from 'express-rate-limit';

/**
 * Build a keyGenerator that scopes the limiter to (userId, storyId) for
 * per-story bucketing. Falls back to IP when either is unavailable.
 */
function storyKey(req) {
  const userId = req.user?.id;
  const storyId = req.params?.id;
  if (userId && storyId) return `v4:${userId}:${storyId}`;
  // Fall through to IP-based key so the limiter still runs (fail-closed on
  // the caller, not on the middleware).
  return req.ip || 'unknown';
}

/**
 * V4 beat regeneration limiter — THE expensive endpoint.
 * 10 regenerations per 5 minutes per (user, story). Anything above that is
 * either a UI bug (the user clicking frantically) or an attack.
 */
export const v4RegenerateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,    // 5 minutes
  max: 10,                    // 10 regenerations per window
  keyGenerator: storyKey,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: 'Too many beat regenerations on this story. The regenerate endpoint is rate-limited to 10 calls per 5 minutes per story to prevent runaway generation costs. Wait a few minutes and try again, or open the Director\'s Panel to review what\'s already queued.'
    });
  }
});

/**
 * V4 episode reassemble limiter.
 * 5 reassemblies per 10 minutes per (user, story). Post-production is
 * cheaper than beat regeneration but still re-runs the full ffmpeg chain
 * (correction LUTs → assembly → creative LUT → music mix → cards → subs),
 * which is CPU-bound and takes tens of seconds per run.
 */
export const v4ReassembleLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,   // 10 minutes
  max: 5,                     // 5 reassemblies per window
  keyGenerator: storyKey,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: 'Too many episode reassemblies on this story. Reassemble is rate-limited to 5 calls per 10 minutes per story because post-production is CPU-intensive. Wait a few minutes and try again.'
    });
  }
});

/**
 * V4 beat patch (save edits) limiter.
 * 30 patches per 1 minute per (user, story). Patches are cheap (DB write
 * only, no generation), so this window is wide to support rapid iteration
 * in the Director's Panel. The limit only exists as a safety rail against
 * a stuck auto-save loop.
 */
export const v4PatchLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 minute
  max: 30,                    // 30 patches per window
  keyGenerator: storyKey,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: 'Too many beat edits in a short window. Patch is rate-limited to 30 calls per minute per story. This usually means the UI has a stuck auto-save loop — refresh the Director\'s Panel.'
    });
  }
});

/**
 * V4 beat delete limiter.
 * 10 deletions per 5 minutes per (user, story). Same cadence as regenerate
 * because a rapid-delete loop has similar blast radius (user wipes a scene,
 * regenerates the whole episode, repeats).
 */
export const v4DeleteLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,    // 5 minutes
  max: 10,                    // 10 deletes per window
  keyGenerator: storyKey,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: 'Too many beat deletions on this story. Delete is rate-limited to 10 calls per 5 minutes per story. Wait a few minutes and try again.'
    });
  }
});
