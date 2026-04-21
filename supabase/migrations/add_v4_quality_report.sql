-- add_v4_quality_report.sql
--
-- Adds a JSONB column to brand_story_episodes that stores the output of the
-- V4 screenplay quality gate:
--   - quality_report.validator: Layer-1 deterministic checks (issues + stats)
--   - quality_report.doctor: Layer-2 Gemini punch-up patch (applied ops + notes)
--   - quality_report.validator_post_doctor: re-run of Layer-1 after the doctor
--   - quality_report.error: populated if the gate threw (non-fatal)
--
-- Populated by BrandStoryService.runV4Pipeline between screenplay generation
-- and brand safety filter. Surfaced in the Director's Panel UI as the
-- "Script QA" section.
--
-- Purely additive — does not touch any existing column, constraint, or index.
-- Safe to apply while pipeline is running.

ALTER TABLE brand_story_episodes
  ADD COLUMN IF NOT EXISTS quality_report JSONB DEFAULT '{}'::jsonb;

COMMENT ON COLUMN brand_story_episodes.quality_report IS
  'V4 screenplay quality gate output (Layer-1 validator + optional Layer-2 Gemini doctor). Populated at episode creation; read by Director''s Panel Script QA section.';
