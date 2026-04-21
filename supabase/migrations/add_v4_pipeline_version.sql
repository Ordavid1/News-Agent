-- V4 Brand Story Pipeline — scene-graph / beat-based generation.
--
-- This migration prepares the database for the V4 pipeline introduced in
-- Phase 1a of sunny-wishing-teacup.md. Everything that can fit inside the
-- existing scene_description JSONB lives there (no new JSONB columns for
-- the scene→beat graph). Only top-level columns that the backend queries
-- by key are added here.
--
-- Changes:
--   1. Extend brand_story_episodes.pipeline_version to include 'v4'
--      (current values: 'v1' legacy, 'v2' cinematic/v3-mental-model)
--   2. Extend brand_story_episodes.status with V4 stages
--      (new: generating_scene_masters, generating_beats, assembling,
--       applying_lut, brand_safety_check)
--   3. Add LUT resolution columns (brand_kit-driven LUT waterfall)
--   4. Add per-episode cost cap (runaway guard, NOT a billing system)
--   5. Add episode-level music_bed_url (ElevenLabs Music output)
--
-- All new columns are nullable — existing v2/v3 episodes are unaffected
-- and continue to render via the legacy code path.

-- ─── 1. Extend pipeline_version to include 'v4' ───
ALTER TABLE brand_story_episodes DROP CONSTRAINT IF EXISTS brand_story_episodes_pipeline_version_check;

ALTER TABLE brand_story_episodes ADD CONSTRAINT brand_story_episodes_pipeline_version_check
  CHECK (pipeline_version IN ('v1', 'v2', 'v4'));

-- ─── 2. Extend status with V4 stages ───
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
    'regenerating_beat'             -- Director's Panel single-beat regeneration in progress
  ));

-- ─── 3. LUT resolution waterfall columns ───

-- User override from the wizard — locks a single LUT for the entire story.
-- If set, this wins over everything else in the V4 LUT waterfall.
ALTER TABLE brand_stories
  ADD COLUMN IF NOT EXISTS locked_lut_id TEXT;

-- Cached Brand-Kit-derived LUT match. Computed ONCE at story creation
-- from brand_kit.color_palette + style_characteristics.mood + overall_aesthetic.
-- Used for every episode in the story (brand consistency across the season).
ALTER TABLE brand_stories
  ADD COLUMN IF NOT EXISTS brand_kit_lut_id TEXT;

-- Per-episode LUT picked by Gemini at screenplay time when no Brand Kit is
-- attached to the story. Allows per-episode variation for stories without
-- a brand identity lock.
ALTER TABLE brand_story_episodes
  ADD COLUMN IF NOT EXISTS lut_id TEXT;

-- ─── 4. Per-episode cost cap (runaway guard) ───

-- Hard ceiling on estimated generation cost per episode. BeatRouter sums
-- estimatedCost across all routed beats and bails BEFORE any generation
-- if total would exceed this cap. NOT a billing or credit system — just
-- a safety rail against rogue Gemini emissions.
--
-- Tier defaults (enforced in code, not DB):
--   Business tier  → 10.00
--   Enterprise tier → 15.00
ALTER TABLE brand_story_episodes
  ADD COLUMN IF NOT EXISTS cost_cap_usd NUMERIC(8, 2);

-- ─── 5. Episode-level music bed ───

-- Public Supabase URL to the ElevenLabs Music bed for this episode.
-- Generated from scene_description.music_bed_intent after beat assembly,
-- mixed under all beats at -18dB (ducks to -24dB during dialogue beats).
ALTER TABLE brand_story_episodes
  ADD COLUMN IF NOT EXISTS music_bed_url TEXT;

-- ═══════════════════════════════════════════════════════════════════════
-- DOWN MIGRATION (commented out — uncomment and run manually to roll back)
-- ═══════════════════════════════════════════════════════════════════════
--
-- Usage: if V4 needs to be rolled back under a production incident, run the
-- statements below in a single transaction. They revert every change this
-- file made. The BRAND_STORY_PIPELINE env var MUST be flipped off 'v4'
-- BEFORE applying this rollback — any in-flight V4 pipelines will fail
-- immediately on the next DB write.
--
-- WARNING: dropping columns is destructive. Any v4 episodes in the DB
-- will lose their lut_id, cost_cap_usd, and music_bed_url data, and any
-- 'v4' status/pipeline_version values will become invalid (delete or
-- reassign those rows first). The BeatRouter cost-cap logic will fall
-- back to tier defaults without the per-episode cap column.
--
-- Order: drop FK-less columns → restore CHECK constraints to pre-v4 enums.
--
-- BEGIN;
--
-- -- 1. Drop per-episode columns added in section 5
-- ALTER TABLE brand_story_episodes DROP COLUMN IF EXISTS music_bed_url;
--
-- -- 2. Drop per-episode cost cap column added in section 4
-- ALTER TABLE brand_story_episodes DROP COLUMN IF EXISTS cost_cap_usd;
--
-- -- 3. Drop LUT waterfall columns added in section 3
-- ALTER TABLE brand_story_episodes DROP COLUMN IF EXISTS lut_id;
-- ALTER TABLE brand_stories DROP COLUMN IF EXISTS brand_kit_lut_id;
-- ALTER TABLE brand_stories DROP COLUMN IF EXISTS locked_lut_id;
--
-- -- 4. Restore the pre-v4 status CHECK constraint (removes the 5 v4 stages)
-- -- Note: you MUST first update or delete rows whose status is one of the
-- -- v4-only values or the ADD CONSTRAINT will fail. Run:
-- --   UPDATE brand_story_episodes SET status = 'failed'
-- --     WHERE status IN ('brand_safety_check', 'generating_scene_masters',
-- --                      'generating_beats', 'assembling', 'applying_lut');
-- ALTER TABLE brand_story_episodes DROP CONSTRAINT IF EXISTS brand_story_episodes_status_check;
-- ALTER TABLE brand_story_episodes ADD CONSTRAINT brand_story_episodes_status_check
--   CHECK (status IN (
--     'pending',
--     'writing_script',
--     'generating_scene',
--     'generating_narration',
--     'generating_storyboard',
--     'generating_avatar',
--     'generating_video',
--     'post_production',
--     'compositing',
--     'ready',
--     'publishing',
--     'published',
--     'failed'
--   ));
--
-- -- 5. Restore the pre-v4 pipeline_version CHECK constraint (removes 'v4')
-- -- Note: you MUST first update or delete rows whose pipeline_version='v4'
-- -- or the ADD CONSTRAINT will fail. Run:
-- --   DELETE FROM brand_story_episodes WHERE pipeline_version = 'v4';
-- -- OR:
-- --   UPDATE brand_story_episodes SET pipeline_version = 'v2'
-- --     WHERE pipeline_version = 'v4';
-- ALTER TABLE brand_story_episodes DROP CONSTRAINT IF EXISTS brand_story_episodes_pipeline_version_check;
-- ALTER TABLE brand_story_episodes ADD CONSTRAINT brand_story_episodes_pipeline_version_check
--   CHECK (pipeline_version IN ('v1', 'v2'));
--
-- COMMIT;
