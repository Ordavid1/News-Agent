-- Add image support to brand voice generated posts
-- Allows generated posts to carry an associated LoRA-generated image

ALTER TABLE brand_voice_generated_posts
  ADD COLUMN IF NOT EXISTS image_url TEXT,
  ADD COLUMN IF NOT EXISTS generated_media_id UUID REFERENCES generated_media(id) ON DELETE SET NULL;
