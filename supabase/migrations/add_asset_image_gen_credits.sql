-- Migration: Add credit-pack support to per_use_purchases table
-- Enables the Brand Asset Generator's generation credit system:
-- - 6 free generation credits included with each training purchase
-- - Additional packs of 6 for $4.50 via LemonSqueezy

-- 1. Add credits tracking columns (backward-compatible: existing rows default to single-use)
ALTER TABLE per_use_purchases
  ADD COLUMN IF NOT EXISTS credits_total INTEGER NOT NULL DEFAULT 1;

ALTER TABLE per_use_purchases
  ADD COLUMN IF NOT EXISTS credits_used INTEGER NOT NULL DEFAULT 0;

-- 2. Enforce credits_used cannot exceed credits_total
ALTER TABLE per_use_purchases
  ADD CONSTRAINT chk_credits_used_lte_total CHECK (credits_used <= credits_total);

-- 3. Expand purchase_type to include the new credit-pack type
ALTER TABLE per_use_purchases DROP CONSTRAINT IF EXISTS per_use_purchases_purchase_type_check;
ALTER TABLE per_use_purchases
  ADD CONSTRAINT per_use_purchases_purchase_type_check
  CHECK (purchase_type IN ('model_training', 'image_generation', 'asset_image_gen_pack'));

-- 4. Expand payment_provider to include 'system' for auto-granted free credits
ALTER TABLE per_use_purchases DROP CONSTRAINT IF EXISTS per_use_purchases_payment_provider_check;
ALTER TABLE per_use_purchases
  ADD CONSTRAINT per_use_purchases_payment_provider_check
  CHECK (payment_provider IN ('lemon_squeezy', 'stripe', 'system'));

-- 5. Partial index for efficient credit balance lookups
CREATE INDEX IF NOT EXISTS idx_per_use_purchases_asset_gen_credits
  ON per_use_purchases(user_id, purchase_type, status, created_at)
  WHERE purchase_type = 'asset_image_gen_pack' AND status = 'completed';
