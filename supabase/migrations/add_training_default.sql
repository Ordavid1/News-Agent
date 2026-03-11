-- Add default model flag to training jobs
-- Allows users to mark one completed training as their default for generation.
-- The latest completed training is auto-set as default on completion.

ALTER TABLE media_training_jobs
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;

-- Partial index for fast lookup of the default training per account
CREATE INDEX IF NOT EXISTS idx_media_training_default
  ON media_training_jobs(ad_account_id)
  WHERE is_default = true;
