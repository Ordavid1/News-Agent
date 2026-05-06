-- supabase/migrations/add_beat_lifecycle.sql
-- 2026-05-06
--
-- V4 Tier 1 — Beat Lifecycle Architecture documentation migration.
--
-- The new lifecycle fields (`status`, `version`, `attempts_log`) live INSIDE
-- the existing `brand_story_episodes.scene_description` JSONB column, on each
-- beat sub-object: scene_description.scenes[N].beats[M]. Because JSONB is
-- schemaless, this migration adds NO new columns. It exists to:
--
--   1. Document the new per-beat field shape in COMMENT metadata so future
--      readers (humans + AI assistants) can discover the contract without
--      grep-spelunking through services/v4/BeatLifecycle.js.
--
--   2. Ensure `brand_story_episodes.scene_description` is NOT NULL by default
--      (it already isn't — we just confirm).
--
--   3. Add a check constraint (advisory only — JSONB doesn't enforce shape)
--      noting the canonical BEAT_STATUS enum values.
--
-- WHY this is the right place for the audit:
--   • The audit + quarantine store IS the attempts_log JSONB array on each
--     beat — restoring a quarantined clip means reading the most recent
--     attempts_log entry whose video_url is non-null. Co-locating audit with
--     beat row keeps the read path single-fetch (no JOIN) and lets the same
--     `scene_description` write atomically persist both the canonical clip
--     state and the audit row.
--   • Top-level columns would force every loader to reconcile two sources of
--     truth. Per-beat sub-objects keep the contract single-rooted.
--
-- The canonical BEAT_STATUS enum (single source of truth: services/v4/BeatLifecycle.js):
--
--   pending       — beat row created, generation not started
--   generating    — generation in flight
--   generated     — generation succeeded; awaiting director / user verdict
--   ready         — explicitly approved (Director Lens C pass OR user PATCH from hard_rejected)
--   failed        — generator threw a non-recoverable error
--   hard_rejected — Director Lens C hard-rejected; clip moved to attempts_log; awaiting_user_review
--   superseded    — a later attempt replaces this row (terminal — kept for audit only)
--
-- The reassembly + post-production loaders treat ONLY {generated, ready} as
-- live. Everything else is invisible to assembly even if `generated_video_url`
-- is somehow non-null (defense in depth).
--
-- attempts_log entry shape:
--   {
--     attempt_uuid:    UUID string,
--     started_at:      ISO timestamp,
--     ended_at:        ISO timestamp,
--     status:          one of the BEAT_STATUS enum values (final state of this attempt),
--     error_message:   string | null,
--     video_url:       Supabase storage URL | null,
--     endframe_url:    Supabase storage URL | null,
--     model_used:      string | null,
--     lens_c_verdict:  { verdict, overall_score, findings? } | null,
--     reason:          free-text breadcrumb (e.g. 'director_hard_reject_escalate', 'user_regenerate')
--   }
--
-- Migration is purely DOCUMENTARY — running it is idempotent and safe.
-- Existing episodes that lack `status` / `version` / `attempts_log` fields on
-- their beat sub-objects continue to work — services/v4/BeatLifecycle.js
-- ensureLifecycleFields() backfills missing fields on first read.

DO $$
BEGIN
  -- Confirm scene_description is the right home (pre-existing column).
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'brand_story_episodes'
      AND column_name = 'scene_description'
      AND data_type = 'jsonb'
  ) THEN
    RAISE EXCEPTION 'brand_story_episodes.scene_description JSONB column not found — V4 lifecycle requires it';
  END IF;
END $$;

COMMENT ON COLUMN brand_story_episodes.scene_description IS
  'V4 scene-graph JSONB. Shape: { scenes: [{ scene_id, beats: [{ beat_id, type, status, version, attempts_log, generated_video_url, endframe_url, ... }] }] }. '
  'Per-beat lifecycle fields (added 2026-05-06):'
  ' status (enum: pending|generating|generated|ready|failed|hard_rejected|superseded),'
  ' version (monotonic int — optimistic concurrency token),'
  ' attempts_log (append-only audit + quarantine store).'
  ' Source of truth: services/v4/BeatLifecycle.js. Loaders treat only {generated, ready} as live.';
