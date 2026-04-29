-- V4 Phase 5b — Fix 8 + N2 + N5 telemetry columns.
--
-- Adds columns to brand_story_episodes for the auto-fix loop telemetry
-- (Fix 8 hard_reject 5-category triage), the Lens D ship gate (N2), and
-- the IDENTITY-class fallback model routing (N5).
--
-- All columns are nullable / default-0 — existing v2/v3/v4 episodes are
-- unaffected and continue to render via the legacy code paths.

-- ─── Fix 8 — auto-fix loop telemetry ───
ALTER TABLE brand_story_episodes
  ADD COLUMN IF NOT EXISTS auto_fix_attempts INTEGER NOT NULL DEFAULT 0;

ALTER TABLE brand_story_episodes
  ADD COLUMN IF NOT EXISTS auto_fix_cost_usd NUMERIC(8,4) NOT NULL DEFAULT 0;

ALTER TABLE brand_story_episodes
  ADD COLUMN IF NOT EXISTS auto_fix_latency_ms BIGINT NOT NULL DEFAULT 0;

-- Per-scene cap tracking — scene_id → attempts. Per-scene cap = 1 (Director
-- Agent verdict 2026-04-29). Per-episode cap = 3 (auto_fix_attempts above).
ALTER TABLE brand_story_episodes
  ADD COLUMN IF NOT EXISTS auto_fix_attempts_per_scene JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Last auto-fix verdict + nudge_to_brief_ratio telemetry signal. When the
-- ratio crosses 1.5, the auto-fix loop has more nudge mass than original
-- brief mass — escalate immediately rather than keep stacking nudges.
ALTER TABLE brand_story_episodes
  ADD COLUMN IF NOT EXISTS last_auto_fix_class TEXT NULL;

ALTER TABLE brand_story_episodes
  ADD COLUMN IF NOT EXISTS last_nudge_to_brief_ratio NUMERIC(6,3) NULL;

-- ─── N2 — Lens D ship gate audit trail ───
ALTER TABLE brand_story_episodes
  ADD COLUMN IF NOT EXISTS lens_d_ship_gate_verdict TEXT NULL;

ALTER TABLE brand_story_episodes
  ADD COLUMN IF NOT EXISTS lens_d_auto_reassemble_attempted BOOLEAN NOT NULL DEFAULT FALSE;

-- ─── N5 — IDENTITY-class fallback model routing audit ───
-- Records when a beat was re-rendered via OmniHuman 1.5 (Mode A fallback)
-- or Veo 3.1 (non-dialogue identity fallback). Per-beat granularity lives
-- on scene_description.scenes[i].beats[j].fallback_generator (already JSONB);
-- this is an episode-level rollup for telemetry queries.
ALTER TABLE brand_story_episodes
  ADD COLUMN IF NOT EXISTS identity_fallback_routes JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Add an index on auto_fix_attempts > 0 so the Director Panel can quickly
-- query "which episodes hit the auto-fix loop" without a sequential scan.
CREATE INDEX IF NOT EXISTS idx_brand_story_episodes_auto_fix_active
  ON brand_story_episodes (auto_fix_attempts)
  WHERE auto_fix_attempts > 0;

-- Add the new awaiting_user_review status to the existing constraint if
-- it's not already in the allowed set.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'brand_story_episodes_status_check'
  ) THEN
    ALTER TABLE brand_story_episodes DROP CONSTRAINT brand_story_episodes_status_check;
  END IF;
END $$;

-- Re-create the constraint with the V4 Phase 5b statuses included.
-- 'awaiting_user_review' is a SHIP-GATE-DRIVEN status (N2) — episode
-- generated but blocked from publishing until user reviews the Director
-- Panel verdicts.
ALTER TABLE brand_story_episodes ADD CONSTRAINT brand_story_episodes_status_check
  CHECK (status IN (
    'pending',
    'generating_storyboard',
    'generating_avatar',
    'generating_video',
    'compositing',
    'ready',
    'failed',
    -- V4 statuses
    'generating_scene_masters',
    'generating_beats',
    'assembling',
    'applying_lut',
    'brand_safety_check',
    -- V4 Phase 5b
    'awaiting_user_review'
  ));
