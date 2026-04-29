-- supabase/migrations/add_ready_with_director_warning_status.sql
-- 2026-04-29
--
-- V4 P1.3 — Adds the `ready_with_director_warning` status to
-- brand_story_episodes.status enum.
--
-- WHY: V4 P1.3 extends the Lens D ship gate to all genres (Wave 5's
-- commercial-only scoping was reversed by user 2026-04-29 under the
-- quality-first principle — reassemble cost ~$0.10-0.50 per soft-reject,
-- ffmpeg-only, justified by cross-genre quality gain).
--
-- The new ladder:
--   pass | pass_with_notes ≥ 75 → ready
--   soft_reject 60-75 → ONE auto-reassemble → re-judge:
--     ↳ ≥ 75                    → ready
--     ↳ 60-75 still              → ready_with_director_warning  ← NEW
--     ↳ < 60 OR hard_reject      → awaiting_user_review
--   soft_reject < 60             → awaiting_user_review
--   hard_reject                  → awaiting_user_review
--
-- The new `ready_with_director_warning` band sits BETWEEN ship and escalate.
-- The episode is shippable (creator can still publish) but the panel surfaces
-- the verdict prominently so the creator sees craft-axis warnings before
-- watching the whole cut. Score-only ladder, no regression-protection rule
-- (post-reassemble score is trusted absolutely).
--
-- Source: services/BrandStoryService.js Lens D ship gate block (around line
-- 5172 after P1.3 ships). Plan: /Users/ordavid/.claude/plans/prepare-a-plan-to-hidden-snowglobe.md
-- under "P1.3 — Lens D full-parity ship gate".

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
    'brand_safety_check',
    'generating_scene_masters',
    'generating_beats',
    'assembling',
    'applying_lut',
    'regenerating_beat',
    -- V4 Director Agent escalation
    'awaiting_user_review',
    -- V4 P1.3 — Lens D warning band (post-reassemble score 60-75)
    'ready_with_director_warning'   -- shippable but verdict drilldown surfaces in panel
  ));

COMMENT ON CONSTRAINT brand_story_episodes_status_check ON brand_story_episodes IS
  'Episode lifecycle states. Includes V4 beat-pipeline stages, Director Agent escalation, and (P1.3) the Lens D warning band. Last updated 2026-04-29 to add ready_with_director_warning.';
