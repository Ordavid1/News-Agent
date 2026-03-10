-- Media Assets Feature: Upload, Train (Flux LoRA), and Generate brand-consistent images
-- Part of the Marketing add-on

-- ============================================
-- Table: media_assets
-- Stores uploaded reference images per ad account
-- ============================================
CREATE TABLE IF NOT EXISTS media_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    ad_account_id UUID NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    public_url TEXT NOT NULL,
    file_size INTEGER NOT NULL DEFAULT 0,
    mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_media_assets_user_account
    ON media_assets(user_id, ad_account_id);

-- ============================================
-- Table: media_training_jobs
-- One active training per ad account (UNIQUE constraint)
-- Tracks Flux LoRA training lifecycle on Replicate
-- ============================================
CREATE TABLE IF NOT EXISTS media_training_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    ad_account_id UUID NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'training', 'completed', 'failed')),
    replicate_training_id TEXT,
    replicate_model_version TEXT,
    image_count INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_training_per_account UNIQUE (ad_account_id)
);

CREATE INDEX IF NOT EXISTS idx_media_training_user
    ON media_training_jobs(user_id);

-- ============================================
-- Table: generated_media
-- Stores AI-generated images from the trained model
-- ============================================
CREATE TABLE IF NOT EXISTS generated_media (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    ad_account_id UUID NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
    training_job_id UUID NOT NULL REFERENCES media_training_jobs(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    public_url TEXT NOT NULL,
    replicate_prediction_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_generated_media_user_account
    ON generated_media(user_id, ad_account_id);
