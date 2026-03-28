-- Brand Kit analysis results (extracted from training images via node-vibrant + Gemini vision)
-- Stores color palette, people/personas, logos, style characteristics, and brand summary as JSON
ALTER TABLE media_training_jobs
  ADD COLUMN IF NOT EXISTS brand_kit JSONB;

-- Index for querying jobs with/without brand kit data
CREATE INDEX IF NOT EXISTS idx_media_training_jobs_brand_kit_not_null
  ON media_training_jobs ((brand_kit IS NOT NULL))
  WHERE brand_kit IS NOT NULL;
