-- supabase/migrations/add_v4_phase_1to6_columns.sql
-- V4 Brand Story — Cinematic De-biasing & COMMERCIAL Genre rollout (2026-04-27)
--
-- Adds the columns introduced by Phases 2, 4, 5, 6 of the de-biasing plan:
--
--   Phase 2 (LUT two-pass grade):
--     brand_stories.brand_palette_lut_id        -- generative brand-trim LUT id
--                                                  (genre LUT first, then this)
--   Phase 4 (Natural product placement):
--     brand_stories.product_integration_style   -- 'naturalistic_placement' (default)
--                                                | 'hero_showcase'
--                                                | 'incidental_prop'
--                                                | 'genre_invisible'
--                                                | 'commercial' (auto-set by Phase 6)
--     brand_stories.product_signature_features  -- jsonb array of 3-7 verbatim
--                                                  identity strings ("satin silver",
--                                                  "MagSafe port on left", ...)
--                                                  injected into every product-bearing
--                                                  prompt and compared by Director
--                                                  Agent (product_identity_lock)
--   Phase 6 (COMMERCIAL genre):
--     brand_stories.commercial_brief            -- jsonb object from
--                                                  CreativeBriefDirector
--     brand_stories.commercial_episode_count    -- 1 or 2 (Gemini-justified, capped)
--     brand_stories.commercial_episode_reasoning- text rationale for the count
--
-- All columns nullable / defaulted so existing stories behave unchanged.
-- Phase 5 (CharacterSheetDirector) sheet_variants lives inside the existing
-- persona_config JSONB blob — no schema change required.

-- ─────────────────────────────────────────────────────────────────────
-- Phase 2 — brand-palette generative LUT (separate from genre LUT)
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE brand_stories
  ADD COLUMN IF NOT EXISTS brand_palette_lut_id TEXT;

COMMENT ON COLUMN brand_stories.brand_palette_lut_id IS
  'V4 Phase 2 — id of the generative brand-palette LUT (e.g. gen_<hash>) applied as a SECOND pass on top of the genre LUT in PostProduction stage 3. Strength is per-genre (see services/v4/BrandKitLutMatcher.js GENRE_STRENGTH).';

-- ─────────────────────────────────────────────────────────────────────
-- Phase 4 — natural product placement guardrails
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE brand_stories
  ADD COLUMN IF NOT EXISTS product_integration_style TEXT
    DEFAULT 'naturalistic_placement';

COMMENT ON COLUMN brand_stories.product_integration_style IS
  'V4 Phase 4 — controls product role in the screenplay: naturalistic_placement (default — Hollywood prop grammar), hero_showcase (legacy money-beat mode), incidental_prop (action/thriller — barely visible), genre_invisible (mystery — withheld until reveal), commercial (auto-set by Phase 6 commercial pipeline).';

-- Soft constraint: validate the value is in the known set. Use CHECK with NOT
-- VALID + immediate validation so existing rows (none should violate but be safe)
-- aren't blocked.
ALTER TABLE brand_stories
  DROP CONSTRAINT IF EXISTS brand_stories_product_integration_style_check;
ALTER TABLE brand_stories
  ADD CONSTRAINT brand_stories_product_integration_style_check
  CHECK (
    product_integration_style IS NULL
    OR product_integration_style IN (
      'naturalistic_placement',
      'hero_showcase',
      'incidental_prop',
      'genre_invisible',
      'commercial'
    )
  );

ALTER TABLE brand_stories
  ADD COLUMN IF NOT EXISTS product_signature_features JSONB
    DEFAULT '[]'::jsonb;

COMMENT ON COLUMN brand_stories.product_signature_features IS
  'V4 Phase 4 — array of 3-7 verbatim visual identity strings the director must preserve across all product-bearing beats (e.g. ["satin silver finish", "MagSafe port on left", "14-inch lid with notch"]). Compared by Director Agent product_identity_lock dimension; drift > 15% on any feature triggers soft_reject.';

-- ─────────────────────────────────────────────────────────────────────
-- Phase 6 — COMMERCIAL genre (creative brief + episode-count justification)
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE brand_stories
  ADD COLUMN IF NOT EXISTS commercial_brief JSONB;

COMMENT ON COLUMN brand_stories.commercial_brief IS
  'V4 Phase 6 — creative brief authored by CreativeBriefDirector for stories whose genre is commercial. Schema: { creative_concept, visual_signature, style_category, narrative_grammar, emotional_arc, hero_image, music_intent, cliffhanger_style, visual_style_brief, reference_commercials[], episode_count_justification:{count,reasoning}, brand_world_lock_if_two_eps?, anti_brief }.';

ALTER TABLE brand_stories
  ADD COLUMN IF NOT EXISTS commercial_episode_count INTEGER;

COMMENT ON COLUMN brand_stories.commercial_episode_count IS
  'V4 Phase 6 — Gemini-justified episode count (1 or 2) for commercial stories. Mirrors prestige episode-count justification (3-12) but capped at 2.';

ALTER TABLE brand_stories
  ADD COLUMN IF NOT EXISTS commercial_episode_reasoning TEXT;

COMMENT ON COLUMN brand_stories.commercial_episode_reasoning IS
  'V4 Phase 6 — text rationale Gemini emitted for the commercial_episode_count.';

ALTER TABLE brand_stories
  DROP CONSTRAINT IF EXISTS brand_stories_commercial_episode_count_check;
ALTER TABLE brand_stories
  ADD CONSTRAINT brand_stories_commercial_episode_count_check
  CHECK (
    commercial_episode_count IS NULL
    OR (commercial_episode_count >= 1 AND commercial_episode_count <= 2)
  );
