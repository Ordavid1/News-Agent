-- Add story_focus top-level field to brand_stories.
-- Drives persona-type filtering in the creation wizard and shapes the Gemini storyline prompt.
--   'person'    — story is ABOUT a specific person (influencer, model, brand ambassador)
--   'product'   — story showcases a physical product
--   'landscape' — story showcases a place/space (real estate, architecture, spa, etc.)

ALTER TABLE brand_stories
  ADD COLUMN IF NOT EXISTS story_focus TEXT
    CHECK (story_focus IN ('person', 'product', 'landscape'));

-- Backfill existing rows with 'product' as a safe default (most generic).
UPDATE brand_stories SET story_focus = 'product' WHERE story_focus IS NULL;

-- Enforce NOT NULL going forward.
ALTER TABLE brand_stories ALTER COLUMN story_focus SET NOT NULL;
ALTER TABLE brand_stories ALTER COLUMN story_focus SET DEFAULT 'product';

-- Index for dashboard filtering by focus.
CREATE INDEX IF NOT EXISTS idx_brand_stories_story_focus
  ON brand_stories (story_focus);
