-- supabase/migrations/add_awaiting_user_review_status.sql
-- 2026-04-28
--
-- Adds the `awaiting_user_review` status to brand_story_episodes.status enum.
--
-- WHY: V4 Director Agent (Layer 3) escalates the episode to `awaiting_user_review`
-- when:
--   • Lens A (screenplay) hard_reject OR soft_reject after retry budget exhausted
--   • Lens B (scene_master) hard_reject after one retry attempt
--   • Lens C (beat) hard_reject OR soft_reject after one retry attempt
--   • DirectorBlockingHaltError thrown by the orchestrator
--
-- The escalation status was added to the codebase as part of the Director Agent
-- rollout (services/BrandStoryService.js — 5 call sites at lines 3499, 3576, 3859,
-- 3979 etc.) but the matching DB enum entry was never shipped. Result: when
-- BRAND_STORY_DIRECTOR_BEAT=blocking and Director hard_rejects a beat, the
-- UPDATE fails with a CHECK CONSTRAINT violation, the failure is caught as
-- "non-fatal", and the bad beat ships in the final cut. The Director's verdict
-- is effectively swallowed.
--
-- This migration restores the contract so blocking-mode escalations actually
-- mark the episode as awaiting_user_review and surface in the Director Panel
-- for the user to review and trigger fixes manually.
--
-- Caught: 2026-04-28 during commercial-genre test run (logs.txt around 08:04).

ALTER TABLE brand_story_episodes DROP CONSTRAINT IF EXISTS brand_story_episodes_status_check;

ALTER TABLE brand_story_episodes ADD CONSTRAINT brand_story_episodes_status_check
  CHECK (status IN (
    -- Shared with v2/v3
    'pending',
    'writing_script',
    'generating_scene',
    'generating_narration',
    'generating_storyboard',
    'generating_avatar',
    'generating_video',
    'post_production',
    'compositing',
    'ready',
    'publishing',
    'published',
    'failed',
    -- V4-specific beat-pipeline stages
    'brand_safety_check',           -- Gemini dialogue safety pass
    'generating_scene_masters',     -- Seedream per-scene panels
    'generating_beats',             -- per-beat generation loop (replaces generating_video)
    'assembling',                   -- ffmpeg beat→scene→episode concat
    'applying_lut',                 -- 2-pass color grade (per-model correction + creative LUT)
    'regenerating_beat',            -- Director's Panel single-beat regeneration in progress
    -- V4 Director Agent escalation (2026-04-28 added)
    'awaiting_user_review'          -- Director Lens A/B/C blocking-mode hard_reject OR retry-exhausted soft_reject
  ));

COMMENT ON CONSTRAINT brand_story_episodes_status_check ON brand_story_episodes IS
  'Episode lifecycle states. Includes V4 beat-pipeline stages and Director Agent escalation status. Last updated 2026-04-28 to add awaiting_user_review.';
