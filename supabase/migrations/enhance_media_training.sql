-- Enhance media training and generation with advanced parameters
-- Adds training type presets and generation parameter tracking

-- Add training type to training jobs (style vs subject/product)
ALTER TABLE media_training_jobs ADD COLUMN IF NOT EXISTS training_type TEXT DEFAULT 'subject';

-- Add generation parameters to generated media for reproducibility
ALTER TABLE generated_media ADD COLUMN IF NOT EXISTS lora_scale NUMERIC(4,2);
ALTER TABLE generated_media ADD COLUMN IF NOT EXISTS guidance_scale NUMERIC(4,2);
