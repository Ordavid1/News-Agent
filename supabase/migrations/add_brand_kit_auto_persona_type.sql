-- Add 'brand_kit_auto' as a valid persona_type for Brand Story
-- Allows AI-generated personas from Brand Kit context (Gemini + Flux 2 Max character sheet).

ALTER TABLE brand_stories DROP CONSTRAINT IF EXISTS brand_stories_persona_type_check;

ALTER TABLE brand_stories ADD CONSTRAINT brand_stories_persona_type_check
  CHECK (persona_type IN ('described', 'selected', 'uploaded', 'brand_kit', 'brand_kit_auto'));
