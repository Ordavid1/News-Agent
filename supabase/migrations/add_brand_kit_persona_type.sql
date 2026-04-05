-- Add 'brand_kit' as a valid persona_type for Brand Story
-- Allows users to pick an extracted person cutout from their Brand Kit as the story persona.

ALTER TABLE brand_stories DROP CONSTRAINT IF EXISTS brand_stories_persona_type_check;

ALTER TABLE brand_stories ADD CONSTRAINT brand_stories_persona_type_check
  CHECK (persona_type IN ('described', 'selected', 'uploaded', 'brand_kit'));
