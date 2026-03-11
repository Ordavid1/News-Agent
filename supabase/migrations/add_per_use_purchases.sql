-- Per-Use Purchases Table
-- Tracks one-time per-use charges for:
--   - model_training: Brand Asset LoRA training ($5 via Lemon Squeezy)
--   - image_generation: Brand Voice "Generate with Image" ($0.75 via Lemon Squeezy)

CREATE TABLE IF NOT EXISTS public.per_use_purchases (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  purchase_type TEXT NOT NULL CHECK (purchase_type IN ('model_training', 'image_generation')),
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
  payment_provider TEXT NOT NULL CHECK (payment_provider IN ('lemon_squeezy', 'stripe')),
  provider_reference_id TEXT,   -- LS order ID or Stripe PaymentIntent ID
  reference_id UUID,            -- training job ID or generated post ID (set after action completes)
  reference_type TEXT,          -- 'media_training_job' or 'brand_voice_generated_post'
  idempotency_key TEXT UNIQUE,
  description TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_per_use_purchases_user_id ON per_use_purchases(user_id);
CREATE INDEX IF NOT EXISTS idx_per_use_purchases_status ON per_use_purchases(status);
CREATE INDEX IF NOT EXISTS idx_per_use_purchases_provider_ref ON per_use_purchases(provider_reference_id);
CREATE INDEX IF NOT EXISTS idx_per_use_purchases_type_user ON per_use_purchases(purchase_type, user_id);
CREATE INDEX IF NOT EXISTS idx_per_use_purchases_reference ON per_use_purchases(reference_id) WHERE reference_id IS NOT NULL;

-- Row Level Security
ALTER TABLE per_use_purchases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own purchases"
  ON per_use_purchases FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

-- Only service_role can insert/update/delete (backend operations)
GRANT SELECT ON public.per_use_purchases TO authenticated;
GRANT ALL ON public.per_use_purchases TO service_role;
