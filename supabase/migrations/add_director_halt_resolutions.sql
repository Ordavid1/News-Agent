-- supabase/migrations/add_director_halt_resolutions.sql
-- 2026-04-29
--
-- V4 P0.5 — Director Review Resolution Layer audit table.
--
-- WHY: The major-enhancement commit shipped the Director-Agent BLOCKING-MODE
-- halt machinery (DirectorBlockingHaltError + 8+ halt sites that flip episode
-- status to 'awaiting_user_review' + the 'awaiting_user_review' enum migration)
-- but never shipped the resolution surface. P0.5 closes that loop with a
-- POST /director-review route + resolveDirectorReview() service method + panel UI.
--
-- This table records every resolution decision for telemetry: which checkpoints
-- halt most often, what users typically do (approve / edit_and_retry / discard),
-- and whether edit_and_retry actually fixes the issue (resumption_outcome).
-- Rolls into the P5.2 telemetry feed.
--
-- Source: services/BrandStoryService.js resolveDirectorReview() method.
-- Plan: /Users/ordavid/.claude/plans/prepare-a-plan-to-hidden-snowglobe.md P0.5.4

CREATE TABLE IF NOT EXISTS director_halt_resolutions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id UUID NOT NULL REFERENCES brand_story_episodes(id) ON DELETE CASCADE,
  story_id UUID NOT NULL REFERENCES brand_stories(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,

  -- Where the pipeline halted
  halted_at_checkpoint TEXT NOT NULL,             -- 'screenplay' | 'scene_master' | 'beat' | 'episode' | 'commercial_brief' | 'commercial_screenplay' | etc.
  halted_artifact_id TEXT,                        -- scene_id (Lens B) | beat_id (Lens C) | NULL otherwise
  halt_verdict_score INT,                         -- the verdict's overall_score that triggered escalation
  halt_verdict_kind TEXT,                         -- 'hard_reject' | 'soft_reject' | 'pass_with_notes' | etc.
  halt_reason TEXT,                               -- decision.reason from DirectorRetryPolicy

  -- User's decision
  user_action TEXT NOT NULL CHECK (user_action IN ('approve', 'edit_and_retry', 'discard')),
  user_notes TEXT,                                -- user's free-form remediation note (becomes director nudge for edit_and_retry)
  user_edited_anchor TEXT,                        -- override of scene_visual_anchor_prompt (Lens B halts only)
  user_edited_dialogue TEXT,                      -- override of beat dialogue (Lens C halts only)

  -- Outcome of resumption (populated AFTER the resumed pipeline completes or re-halts)
  resumption_outcome TEXT,                        -- 'shipped' | 'shipped_with_warning' | 're_halted' | 'failed' | NULL on discard

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ                         -- when resumption_outcome was determined
);

CREATE INDEX IF NOT EXISTS idx_dhr_episode ON director_halt_resolutions(episode_id);
CREATE INDEX IF NOT EXISTS idx_dhr_story ON director_halt_resolutions(story_id);
CREATE INDEX IF NOT EXISTS idx_dhr_user_action ON director_halt_resolutions(user_action);
CREATE INDEX IF NOT EXISTS idx_dhr_checkpoint ON director_halt_resolutions(halted_at_checkpoint);
CREATE INDEX IF NOT EXISTS idx_dhr_created ON director_halt_resolutions(created_at DESC);

COMMENT ON TABLE director_halt_resolutions IS
  'V4 P0.5 — Audit trail for Director-Agent blocking-mode halt resolutions. Every approve/edit_and_retry/discard decision is recorded here for telemetry: halt frequency by checkpoint, user action distribution, edit_and_retry success rate.';

COMMENT ON COLUMN director_halt_resolutions.user_action IS
  'approve = clear halt at face value (only meaningful at Lens D when final_video_url exists). edit_and_retry = re-run halted checkpoint with user-provided notes/edits spliced into nudge. discard = mark episode failed with user reason.';

COMMENT ON COLUMN director_halt_resolutions.resumption_outcome IS
  'Populated by the orchestrator AFTER the resumed pipeline completes. NULL on discard (no resumption). Used to compute edit_and_retry success rate for the telemetry rollup (P5.2).';
