-- Add subtitle_url column to brand_story_episodes for downloadable SRT captions.
-- Stores the public Supabase Storage URL of the generated SRT file.

ALTER TABLE brand_story_episodes ADD COLUMN IF NOT EXISTS subtitle_url TEXT;
