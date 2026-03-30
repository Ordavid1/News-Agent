-- Migration: Add playable_content table and playable_content_gen purchase type
-- Enables the Playable Content Generator feature:
-- - Stores generated playable ads and interactive stories from Brand Kit assets
-- - Tracks generation status, Gemini prompts/responses, MRAID packaging
-- - Per-use credit system for generation

-- 1. Create playable_content table
CREATE TABLE IF NOT EXISTS public.playable_content (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    ad_account_id UUID NOT NULL,
    training_job_id UUID NOT NULL,

    -- Content type and template
    content_type TEXT NOT NULL CHECK (content_type IN ('mini_game', 'interactive_story')),
    template_id TEXT NOT NULL,

    -- User inputs
    title TEXT NOT NULL,
    cta_url TEXT,
    story_options JSONB DEFAULT '{}',

    -- Generation audit trail
    gemini_prompt TEXT,
    gemini_response_raw TEXT,

    -- Generated code
    game_code TEXT,
    final_html TEXT,

    -- Asset manifest (which brand kit assets were used, mapped roles)
    asset_manifest JSONB DEFAULT '{}',

    -- MRAID packaging formats requested
    mraid_formats JSONB DEFAULT '[]',

    -- Storage (final packaged files in Supabase Storage)
    storage_path TEXT,
    public_url TEXT,

    -- Stats
    file_size_bytes INTEGER DEFAULT 0,
    generation_duration_ms INTEGER DEFAULT 0,

    -- Lifecycle
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'generating', 'validating', 'packaging', 'completed', 'failed')),
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Indexes
CREATE INDEX IF NOT EXISTS idx_playable_content_user_account
    ON playable_content(user_id, ad_account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_playable_content_training_job
    ON playable_content(training_job_id);

-- 3. RLS
ALTER TABLE public.playable_content ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own playable content"
    ON public.playable_content FOR SELECT TO authenticated
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own playable content"
    ON public.playable_content FOR INSERT TO authenticated
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own playable content"
    ON public.playable_content FOR UPDATE TO authenticated
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own playable content"
    ON public.playable_content FOR DELETE TO authenticated
    USING (auth.uid() = user_id);

GRANT ALL ON public.playable_content TO authenticated;
GRANT ALL ON public.playable_content TO service_role;

-- 4. Expand purchase_type to include playable_content_gen
ALTER TABLE per_use_purchases DROP CONSTRAINT IF EXISTS per_use_purchases_purchase_type_check;
ALTER TABLE per_use_purchases
    ADD CONSTRAINT per_use_purchases_purchase_type_check
    CHECK (purchase_type IN ('model_training', 'image_generation', 'asset_image_gen_pack', 'voice_training', 'playable_content_gen'));

-- 5. Partial index for efficient playable content credit lookups
CREATE INDEX IF NOT EXISTS idx_per_use_purchases_playable_credits
    ON per_use_purchases(user_id, purchase_type, status, created_at)
    WHERE purchase_type = 'playable_content_gen' AND status = 'completed';
