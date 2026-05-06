-- Aleph Enhancement (Rec 2) — opt-in commercial-only post-completion stylization.
-- 2026-05-05.
--
-- Architecture (Option B — re-run from post-LUT, identical quality to default-on Aleph):
--   1. After Stage 3 (creative LUT), the post-prod pipeline persists an
--      intermediate MP4 to Supabase Storage. That file (graded video, NO
--      music / cards / subtitles burned in yet) is the input for Aleph.
--   2. When the user clicks "✨ Enhance with Aleph" in Director Panel:
--        a. Load post_lut_intermediate_url
--        b. Call Runway Aleph (gen4_aleph, video_to_video) with the brief's
--           visual_signature + brand palette as style prompt
--        c. Run Director Agent identity_lock HARD GATE on the stylized output
--        d. If gate passes: re-run Stages 4 (music) → 5 (cards) → 6 (subs)
--           on the stylized intermediate. Save as aleph_enhanced_video_url.
--        e. If gate fails: discard Aleph output, keep final_video_url, refund
--           (when billing enabled).
--   3. UI offers a toggle between final_video_url and aleph_enhanced_video_url.
--
-- All columns are nullable. Existing episodes are unaffected. Only commercial-
-- genre episodes generated after this migration get post_lut_intermediate_url
-- (gated by genre check in PostProduction.js). Aleph fields populate only on
-- user-triggered enhancement.

ALTER TABLE brand_story_episodes
  -- Persisted post-Stage-3 (post-LUT) intermediate MP4. Written for commercial
  -- episodes during the normal generation flow so the Aleph endpoint has
  -- something to operate on without re-running Stages 1-3 from beat buffers.
  -- For non-commercial (prestige) episodes this stays NULL — no Aleph button.
  ADD COLUMN IF NOT EXISTS post_lut_intermediate_url TEXT,

  -- Final stylized output URL (Aleph + re-run Stages 4-6 applied). Sibling to
  -- final_video_url. NEVER replaces final_video_url. UI shows a toggle. NULL
  -- until user opts in via the Director Panel button.
  ADD COLUMN IF NOT EXISTS aleph_enhanced_video_url TEXT,

  -- Aleph job metadata: status (running | succeeded | failed_identity_gate | failed_aleph_error),
  -- task_ids (JSONB array of Runway task IDs — chunked architecture means N tasks per enhance),
  -- identity_lock_score (the post-Aleph Director judge result for the hard gate),
  -- cost_usd (actual Runway cost at $0.15/output sec, summed across chunks),
  -- billing_status ('free_pilot' | 'charged' | 'refunded' | null),
  -- requested_at / completed_at timestamps for SLA + UI progress.
  ADD COLUMN IF NOT EXISTS aleph_job_metadata JSONB;

-- Index post_lut_intermediate_url so the orchestrator's lookup query is fast.
CREATE INDEX IF NOT EXISTS brand_story_episodes_post_lut_idx
  ON brand_story_episodes (id)
  WHERE post_lut_intermediate_url IS NOT NULL;

-- Index aleph_enhanced_video_url similarly so the Director Panel toggle UI
-- can quickly surface "already enhanced" episodes without scanning.
CREATE INDEX IF NOT EXISTS brand_story_episodes_aleph_enhanced_idx
  ON brand_story_episodes (id)
  WHERE aleph_enhanced_video_url IS NOT NULL;

COMMENT ON COLUMN brand_story_episodes.post_lut_intermediate_url
  IS 'Aleph Rec 2 (2026-05-05). Post-Stage-3 intermediate MP4 (post-LUT, pre-music/cards/subs). Commercial episodes only. Source for the Aleph enhancement endpoint.';

COMMENT ON COLUMN brand_story_episodes.aleph_enhanced_video_url
  IS 'Aleph Rec 2 (2026-05-05). User-opted-in stylized variant. Sibling to final_video_url. NEVER replaces it. UI toggles between the two.';

COMMENT ON COLUMN brand_story_episodes.aleph_job_metadata
  IS 'Aleph Rec 2 (2026-05-05). { status, task_ids[], identity_lock_score, cost_usd, billing_status, requested_at, completed_at }. status enum: running | succeeded | failed_identity_gate | failed_aleph_error.';
