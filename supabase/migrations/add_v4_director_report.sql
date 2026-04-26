-- V4 Director Agent (Layer 3) — episode-level verdict report.
--
-- Adds a JSONB column to brand_story_episodes for the Director Agent's
-- verdicts emitted at the four V4 checkpoints (screenplay / scene_master /
-- beat / episode). Each verdict follows the §7 contract documented in
-- .claude/agents/branded-film-director.md and .claude/plans/v4-director-agent.md.
--
-- Why JSONB instead of new tables:
--   - Verdicts are produced sequentially per episode and consumed atomically
--     by the Director Panel UI alongside the existing quality_report column.
--   - No cross-episode aggregate queries planned in phase 1; simple per-episode
--     reads dominate.
--   - Schema can evolve (per-checkpoint sub-keys) without further migrations.
--
-- Shape (when populated):
--   {
--     "screenplay": { /* §7 verdict JSON */ },
--     "scene_master": { "<scene_id>": { /* verdict */ }, ... },
--     "beat": { "<beat_id>": { /* verdict */ }, ... },
--     "episode": { /* verdict */ },
--     "retries": {
--       "screenplay": 0|1,
--       "scene_master": { "<scene_id>": 0|1, ... },
--       "beat": { "<beat_id>": 0|1, ... }
--     }
--   }
--
-- Reversible: column is nullable, no constraints, no default. Roll back with
--   ALTER TABLE brand_story_episodes DROP COLUMN director_report;

ALTER TABLE brand_story_episodes
  ADD COLUMN IF NOT EXISTS director_report JSONB;

-- Optional GIN index for verdict-level queries (e.g. find all episodes where
-- the screenplay checkpoint hard-rejected). Cheap to add, easy to drop.
CREATE INDEX IF NOT EXISTS idx_brand_story_episodes_director_report_gin
  ON brand_story_episodes USING GIN (director_report);

COMMENT ON COLUMN brand_story_episodes.director_report IS
  'V4 Director Agent (L3) verdicts per checkpoint (screenplay, scene_master, beat, episode) and retry counters. See .claude/agents/branded-film-director.md §7 for verdict schema.';
