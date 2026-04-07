-- Add pending_resume column to brand_stories for resumable episode generation.
-- Stores generated artifacts (screenplay, narration, storyboard, raw video URLs)
-- from failed episode attempts so the next generation can resume where it left off.

ALTER TABLE brand_stories ADD COLUMN IF NOT EXISTS pending_resume JSONB;
