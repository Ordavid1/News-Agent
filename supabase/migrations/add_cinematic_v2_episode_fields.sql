-- Migration: Add cinematic v2 fields to brand_story_episodes
-- These columns support the new cinematic pipeline (Kling multi-shot, Flux 2 Max storyboard,
-- ElevenLabs full-episode narration, ffmpeg post-production).

ALTER TABLE brand_story_episodes
  ADD COLUMN IF NOT EXISTS storyboard_panels JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS narration_audio_url TEXT,
  ADD COLUMN IF NOT EXISTS visual_style_prefix TEXT,
  ADD COLUMN IF NOT EXISTS pipeline_version TEXT DEFAULT 'v1';

-- Add comment for documentation
COMMENT ON COLUMN brand_story_episodes.storyboard_panels IS 'Array of {shot_index, image_url, prompt} — Flux 2 Max storyboard panels for v2 cinematic pipeline';
COMMENT ON COLUMN brand_story_episodes.narration_audio_url IS 'Full episode TTS narration MP3 URL (ElevenLabs)';
COMMENT ON COLUMN brand_story_episodes.visual_style_prefix IS 'Gemini-generated unified cinematography brief for the episode';
COMMENT ON COLUMN brand_story_episodes.pipeline_version IS 'Pipeline version: v1 (legacy/hybrid) or v2 (cinematic)';
