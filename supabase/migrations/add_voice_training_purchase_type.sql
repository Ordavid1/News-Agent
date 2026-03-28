-- Add 'voice_training' to the per_use_purchases purchase_type check constraint
ALTER TABLE per_use_purchases DROP CONSTRAINT IF EXISTS per_use_purchases_purchase_type_check;

ALTER TABLE per_use_purchases
  ADD CONSTRAINT per_use_purchases_purchase_type_check
  CHECK (purchase_type IN ('model_training', 'image_generation', 'asset_image_gen_pack', 'voice_training'));
