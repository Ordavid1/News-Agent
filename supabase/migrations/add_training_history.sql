-- Multi-Training History: Allow multiple named training sessions per ad account
-- Previously: UNIQUE(ad_account_id) enforced one training per account
-- Now: Multiple sessions with naming, payment tracking, and image snapshots

-- ============================================
-- 1. Drop the one-per-account constraint
-- ============================================
ALTER TABLE media_training_jobs
  DROP CONSTRAINT IF EXISTS uq_training_per_account;

-- ============================================
-- 2. Add new columns
-- ============================================

-- User-provided session name (e.g., "Summer Campaign", "Logo Variants")
ALTER TABLE media_training_jobs
  ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT 'Untitled';

-- Trigger word generated for this training (previously only existed in code)
ALTER TABLE media_training_jobs
  ADD COLUMN IF NOT EXISTS trigger_word TEXT;

-- Snapshot of image URLs used at training time (audit trail)
ALTER TABLE media_training_jobs
  ADD COLUMN IF NOT EXISTS training_image_urls JSONB;

-- Payment gate: 'free' (default), 'pending_payment', 'paid'
ALTER TABLE media_training_jobs
  ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'free';

-- Add CHECK constraint for payment_status (separate statement for IF NOT EXISTS compatibility)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'media_training_jobs_payment_status_check'
  ) THEN
    ALTER TABLE media_training_jobs
      ADD CONSTRAINT media_training_jobs_payment_status_check
      CHECK (payment_status IN ('pending_payment', 'paid', 'free'));
  END IF;
END $$;

-- Full owner/model string for Replicate (avoids re-deriving from adAccountId)
ALTER TABLE media_training_jobs
  ADD COLUMN IF NOT EXISTS replicate_model_name TEXT;

-- ============================================
-- 3. New indexes for multi-training queries
-- ============================================

-- List training sessions per account, newest first
CREATE INDEX IF NOT EXISTS idx_media_training_account_created
  ON media_training_jobs(ad_account_id, created_at DESC);

-- Fast lookup for active training (concurrency guard)
CREATE INDEX IF NOT EXISTS idx_media_training_active
  ON media_training_jobs(ad_account_id, status)
  WHERE status = 'training';

-- ============================================
-- 4. Backfill existing rows
-- ============================================
UPDATE media_training_jobs
SET name = 'Initial Training',
    trigger_word = 'BRAND' || UPPER(LEFT(REPLACE(ad_account_id::text, '-', ''), 6))
WHERE name = 'Untitled';
