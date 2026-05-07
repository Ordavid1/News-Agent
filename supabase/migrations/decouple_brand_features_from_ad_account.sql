-- ============================================================
-- Decouple Brand-Creative Features from Meta ad_accounts
-- ============================================================
-- Brand Voice, Media Assets, Playables (and indirectly Brand Story)
-- were originally scoped to a Meta ad_account by the
-- "zero-trust ad account scoping" migration. They are now being
-- moved into a new top-level "Brand Arena" tab and tied only to
-- the signed-in user, so a user can produce brand creatives
-- without ever connecting Meta or selecting an ad account.
--
-- This migration:
--   1. Relaxes ad_account_id from NOT NULL to NULL on the five tables.
--   2. Replaces ON DELETE CASCADE with ON DELETE SET NULL so
--      disconnecting an ad account no longer wipes brand creatives.
--   3. Adds user-scoped indexes to keep listing/lookup paths fast
--      for rows where ad_account_id IS NULL.
--
-- Existing rows are preserved; their ad_account_id stays populated
-- and remains queryable.
-- ============================================================

-- ============================================================
-- 1. brand_voice_profiles
-- ============================================================
ALTER TABLE brand_voice_profiles
  ALTER COLUMN ad_account_id DROP NOT NULL;

ALTER TABLE brand_voice_profiles
  DROP CONSTRAINT IF EXISTS fk_brand_voice_profiles_ad_account;

ALTER TABLE brand_voice_profiles
  ADD CONSTRAINT fk_brand_voice_profiles_ad_account
    FOREIGN KEY (ad_account_id)
    REFERENCES ad_accounts(id)
    ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_brand_voice_profiles_user
  ON brand_voice_profiles(user_id, created_at DESC);


-- ============================================================
-- 2. media_assets
-- ============================================================
ALTER TABLE media_assets
  ALTER COLUMN ad_account_id DROP NOT NULL;

ALTER TABLE media_assets
  DROP CONSTRAINT IF EXISTS media_assets_ad_account_id_fkey;

ALTER TABLE media_assets
  ADD CONSTRAINT media_assets_ad_account_id_fkey
    FOREIGN KEY (ad_account_id)
    REFERENCES ad_accounts(id)
    ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_media_assets_user
  ON media_assets(user_id, created_at DESC);


-- ============================================================
-- 3. media_training_jobs
--    (UNIQUE(ad_account_id) was already dropped in
--     add_training_history.sql — multiple sessions per scope.)
-- ============================================================
ALTER TABLE media_training_jobs
  ALTER COLUMN ad_account_id DROP NOT NULL;

ALTER TABLE media_training_jobs
  DROP CONSTRAINT IF EXISTS media_training_jobs_ad_account_id_fkey;

ALTER TABLE media_training_jobs
  ADD CONSTRAINT media_training_jobs_ad_account_id_fkey
    FOREIGN KEY (ad_account_id)
    REFERENCES ad_accounts(id)
    ON DELETE SET NULL;

-- User-scoped listing (newest first)
CREATE INDEX IF NOT EXISTS idx_media_training_user_created
  ON media_training_jobs(user_id, created_at DESC);

-- Active-training concurrency guard on the user-scoped path
CREATE INDEX IF NOT EXISTS idx_media_training_user_active
  ON media_training_jobs(user_id, status) WHERE status = 'training';

-- Default-training lookup on the user-scoped path
CREATE INDEX IF NOT EXISTS idx_media_training_user_default
  ON media_training_jobs(user_id) WHERE is_default = true;


-- ============================================================
-- 4. generated_media
-- ============================================================
ALTER TABLE generated_media
  ALTER COLUMN ad_account_id DROP NOT NULL;

ALTER TABLE generated_media
  DROP CONSTRAINT IF EXISTS generated_media_ad_account_id_fkey;

ALTER TABLE generated_media
  ADD CONSTRAINT generated_media_ad_account_id_fkey
    FOREIGN KEY (ad_account_id)
    REFERENCES ad_accounts(id)
    ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_generated_media_user
  ON generated_media(user_id, created_at DESC);


-- ============================================================
-- 5. playable_content
--    (Originally declared with NOT NULL but no enforced FK;
--     adding a proper FK with ON DELETE SET NULL.)
-- ============================================================
ALTER TABLE playable_content
  ALTER COLUMN ad_account_id DROP NOT NULL;

-- Defensive: if a prior migration ever added an FK by name, drop it.
ALTER TABLE playable_content
  DROP CONSTRAINT IF EXISTS playable_content_ad_account_id_fkey;

ALTER TABLE playable_content
  ADD CONSTRAINT playable_content_ad_account_id_fkey
    FOREIGN KEY (ad_account_id)
    REFERENCES ad_accounts(id)
    ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_playable_content_user
  ON playable_content(user_id, created_at DESC);
