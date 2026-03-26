-- Migration: Add Meta sync support for audiences and rules
-- Allows pushing local audience templates to Meta as Saved Audiences
-- and pushing pause_if/budget_adjust rules to Meta Ad Rules API

-- 1. Allow 'synced' source on audience_templates for locally-created then pushed to Meta
--    local  = user-created, exists only in our DB
--    synced = user-created, then pushed to Meta (has fb_audience_id)
--    meta   = originally fetched from Meta via sync
ALTER TABLE audience_templates DROP CONSTRAINT IF EXISTS audience_templates_source_check;
ALTER TABLE audience_templates ADD CONSTRAINT audience_templates_source_check
  CHECK (source IN ('local', 'meta', 'synced'));

-- 2. Add Meta Ad Rules sync columns to marketing_rules
ALTER TABLE marketing_rules
  ADD COLUMN IF NOT EXISTS meta_rule_id TEXT,
  ADD COLUMN IF NOT EXISTS meta_sync_status TEXT DEFAULT NULL
    CHECK (meta_sync_status IS NULL OR meta_sync_status IN ('synced', 'error', 'pending'));

-- Index for finding synced rules (e.g., skip in local worker)
CREATE INDEX IF NOT EXISTS idx_marketing_rules_meta_rule_id
  ON marketing_rules(meta_rule_id) WHERE meta_rule_id IS NOT NULL;
