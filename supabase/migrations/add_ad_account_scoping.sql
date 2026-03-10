-- ============================================================
-- Zero-Trust Ad Account Scoping Migration
-- ============================================================
-- Adds ad_account_id to audience_templates, marketing_rules,
-- and brand_voice_profiles so ALL marketing data is scoped to
-- a specific ad account. CASCADE ensures cleanup on disconnect.
-- ============================================================

-- ============================================================
-- 1. AUDIENCE_TEMPLATES
-- ============================================================

-- Step 1: Add nullable column
ALTER TABLE audience_templates
  ADD COLUMN IF NOT EXISTS ad_account_id UUID;

-- Step 2: Backfill from user's selected ad account
UPDATE audience_templates at_tbl
SET ad_account_id = (
  SELECT aa.id FROM ad_accounts aa
  WHERE aa.user_id = at_tbl.user_id AND aa.is_selected = true
  LIMIT 1
)
WHERE at_tbl.ad_account_id IS NULL;

-- Step 3: Fallback to first ad account for users without a selected one
UPDATE audience_templates at_tbl
SET ad_account_id = (
  SELECT aa.id FROM ad_accounts aa
  WHERE aa.user_id = at_tbl.user_id
  ORDER BY aa.created_at ASC
  LIMIT 1
)
WHERE at_tbl.ad_account_id IS NULL;

-- Step 4: Remove orphaned rows (users with no ad accounts at all)
DELETE FROM audience_templates WHERE ad_account_id IS NULL;

-- Step 5: Add NOT NULL constraint and foreign key
ALTER TABLE audience_templates
  ALTER COLUMN ad_account_id SET NOT NULL;

ALTER TABLE audience_templates
  ADD CONSTRAINT fk_audience_templates_ad_account
    FOREIGN KEY (ad_account_id)
    REFERENCES ad_accounts(id)
    ON DELETE CASCADE;

-- Step 6: Index for scoped queries
CREATE INDEX IF NOT EXISTS idx_audience_templates_ad_account
  ON audience_templates(ad_account_id);

-- Step 7: Update unique index for Meta audiences (scope to ad account)
DROP INDEX IF EXISTS idx_audience_templates_user_fb_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_audience_templates_account_fb_id
  ON audience_templates(ad_account_id, fb_audience_id) WHERE fb_audience_id IS NOT NULL;


-- ============================================================
-- 2. MARKETING_RULES
-- ============================================================

-- Step 1: Add nullable column
ALTER TABLE marketing_rules
  ADD COLUMN IF NOT EXISTS ad_account_id UUID;

-- Step 2: Backfill from user's selected ad account
UPDATE marketing_rules mr
SET ad_account_id = (
  SELECT aa.id FROM ad_accounts aa
  WHERE aa.user_id = mr.user_id AND aa.is_selected = true
  LIMIT 1
)
WHERE mr.ad_account_id IS NULL;

-- Step 3: Fallback to first ad account
UPDATE marketing_rules mr
SET ad_account_id = (
  SELECT aa.id FROM ad_accounts aa
  WHERE aa.user_id = mr.user_id
  ORDER BY aa.created_at ASC
  LIMIT 1
)
WHERE mr.ad_account_id IS NULL;

-- Step 4: Remove orphaned rows
DELETE FROM marketing_rules WHERE ad_account_id IS NULL;

-- Step 5: Add NOT NULL constraint and foreign key
ALTER TABLE marketing_rules
  ALTER COLUMN ad_account_id SET NOT NULL;

ALTER TABLE marketing_rules
  ADD CONSTRAINT fk_marketing_rules_ad_account
    FOREIGN KEY (ad_account_id)
    REFERENCES ad_accounts(id)
    ON DELETE CASCADE;

-- Step 6: Index for scoped queries
CREATE INDEX IF NOT EXISTS idx_marketing_rules_ad_account
  ON marketing_rules(ad_account_id);


-- ============================================================
-- 3. BRAND_VOICE_PROFILES
-- ============================================================
-- Child tables (brand_voice_posts, brand_voice_generated_posts)
-- cascade through profile_id FK — no schema change needed.

-- Step 1: Add nullable column
ALTER TABLE brand_voice_profiles
  ADD COLUMN IF NOT EXISTS ad_account_id UUID;

-- Step 2: Backfill from user's selected ad account
UPDATE brand_voice_profiles bvp
SET ad_account_id = (
  SELECT aa.id FROM ad_accounts aa
  WHERE aa.user_id = bvp.user_id AND aa.is_selected = true
  LIMIT 1
)
WHERE bvp.ad_account_id IS NULL;

-- Step 3: Fallback to first ad account
UPDATE brand_voice_profiles bvp
SET ad_account_id = (
  SELECT aa.id FROM ad_accounts aa
  WHERE aa.user_id = bvp.user_id
  ORDER BY aa.created_at ASC
  LIMIT 1
)
WHERE bvp.ad_account_id IS NULL;

-- Step 4: Remove orphaned rows
DELETE FROM brand_voice_profiles WHERE ad_account_id IS NULL;

-- Step 5: Add NOT NULL constraint and foreign key
ALTER TABLE brand_voice_profiles
  ALTER COLUMN ad_account_id SET NOT NULL;

ALTER TABLE brand_voice_profiles
  ADD CONSTRAINT fk_brand_voice_profiles_ad_account
    FOREIGN KEY (ad_account_id)
    REFERENCES ad_accounts(id)
    ON DELETE CASCADE;

-- Step 6: Index for scoped queries
CREATE INDEX IF NOT EXISTS idx_brand_voice_profiles_ad_account
  ON brand_voice_profiles(ad_account_id);
