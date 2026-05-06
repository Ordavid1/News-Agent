-- Veo Failure-Learning Agent — telemetry tables.
-- 2026-05-06.
--
-- Two tables work together:
--
--   1. veo_failure_log (raw, append-only) — every Veo refusal/error captured
--      synchronously by VeoService catch-blocks via VeoFailureCollector.
--      Source of truth for the agent's clustering pass.
--
--   2. veo_failure_signatures (clustered, agent-maintained) — the de-duplicated
--      pattern catalogue rebuilt by VeoFailureKnowledgeBuilder. Read by the
--      builder when regenerating services/v4/VeoFailureKnowledge.mjs (the
--      checked-in helper module that VeoService and the screenplay-prompt
--      builder consume to avoid known-bad phrasings BEFORE the first Veo
--      submission).
--
-- Column shape harmonises with the video-ai-knowledge MCP's
-- get_failure_signatures_for_model contract (failure_mode, description,
-- prevalence, mitigation) so a future export job can push high-confidence
-- live signatures into the MCP's static reference YAML.

-- ─────────────────────────────────────────────────────────────────
-- Table A: veo_failure_log (raw events)
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS veo_failure_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity (nullable when a failure happens in a system context with no
  -- attached user, e.g. a future synthetic warm-up job).
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  episode_id UUID REFERENCES brand_story_episodes(id) ON DELETE SET NULL,
  beat_id TEXT,
  beat_type TEXT,

  -- Failure shape — the discriminating field. Kept as TEXT (not enum) so the
  -- agent can introduce new modes without a migration.
  failure_mode TEXT NOT NULL,
  -- Matched regex tags from VeoPromptSanitizer / VeoFailureCollector heuristics.
  -- Examples: ['usage_guidelines','support_29310472'], ['high_load'], ['image_violates'].
  error_signatures TEXT[] DEFAULT '{}',
  error_message TEXT NOT NULL, -- truncated to 1000 chars by collector

  -- Prompt context (truncated to keep table size sane).
  original_prompt TEXT,        -- truncated to 600 chars
  persona_names TEXT[] DEFAULT '{}',
  had_first_frame BOOLEAN,
  had_last_frame BOOLEAN,
  duration_sec NUMERIC(5,2),
  aspect_ratio TEXT,
  model_attempted TEXT,        -- 'veo-3.1-vertex' | 'veo-3.1-fast' | 'veo-3.1-standard'

  -- Recovery outcome (mirrors VeoService TIER_MAP labels + downstream fallbacks).
  attempt_tier_reached TEXT,   -- 'original' | 'tier1-sanitised' | 'tier2-minimal' | 'tier2.5-regen-frame' | 'tier3-no-image' | 'kling_fallback' | 'hard_failed'
  recovery_succeeded BOOLEAN,
  fallback_model TEXT,         -- 'kling-v3-pro' | 'omnihuman' | NULL

  -- Telemetry.
  attempt_count INTEGER,
  total_duration_ms INTEGER,
  veo_operation_id TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS veo_failure_log_user_idx
  ON veo_failure_log (user_id);

CREATE INDEX IF NOT EXISTS veo_failure_log_mode_recency_idx
  ON veo_failure_log (failure_mode, created_at DESC);

CREATE INDEX IF NOT EXISTS veo_failure_log_signatures_gin
  ON veo_failure_log USING GIN (error_signatures);

CREATE INDEX IF NOT EXISTS veo_failure_log_episode_idx
  ON veo_failure_log (episode_id)
  WHERE episode_id IS NOT NULL;

ALTER TABLE veo_failure_log ENABLE ROW LEVEL SECURITY;

-- Users can read their own failure rows (for an admin/insight UI later).
DROP POLICY IF EXISTS veo_failure_log_user_select ON veo_failure_log;
CREATE POLICY veo_failure_log_user_select ON veo_failure_log
  FOR SELECT
  USING (auth.uid() = user_id);

-- Service role bypass (collector + builder run with service-role key).
DROP POLICY IF EXISTS veo_failure_log_service_all ON veo_failure_log;
CREATE POLICY veo_failure_log_service_all ON veo_failure_log
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

COMMENT ON TABLE veo_failure_log
  IS 'Veo Failure-Learning Agent (2026-05-06). Append-only log of every Veo refusal/error captured by VeoFailureCollector at every catch-block in VeoService. Source for the nightly clustering agent (VeoFailureKnowledgeBuilder).';

COMMENT ON COLUMN veo_failure_log.failure_mode
  IS 'Discriminator. Known values: content_filter_prompt | content_filter_image | high_load | polling_timeout | rate_limit | auth | network | schema_violation | other. New values added without migration.';

COMMENT ON COLUMN veo_failure_log.attempt_tier_reached
  IS 'Final sanitization tier reached before success/failure. Mirrors VeoService TIER_MAP. Values: original | tier1-sanitised | tier2-minimal | tier2.5-regen-frame | tier3-no-image | kling_fallback | hard_failed.';

-- ─────────────────────────────────────────────────────────────────
-- Table B: veo_failure_signatures (clustered patterns)
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS veo_failure_signatures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Stable cluster key (e.g. 'persona_possessive_bodypart'). Used for upserts
  -- so the agent can merge new evidence into an existing pattern without
  -- duplicating rows.
  signature_key TEXT NOT NULL UNIQUE,

  failure_mode TEXT NOT NULL,
  pattern_description TEXT NOT NULL,
  example_excerpts TEXT[] DEFAULT '{}',

  -- Frequency / recency.
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Guidance — consumed by VeoFailureKnowledge.mjs after regeneration.
  prompt_avoid_phrases TEXT[] DEFAULT '{}',
  prompt_safe_alternatives TEXT[] DEFAULT '{}',
  -- One-sentence rule (≤200 chars) for system-prompt injection.
  gemini_directive TEXT,
  -- Optional deterministic mitigation. When both are non-null, the pre-flight
  -- pass in VeoService rewrites matching prompts BEFORE first submission.
  preflight_rule_regex TEXT,
  preflight_rule_flags TEXT,    -- e.g. 'gi'
  preflight_rewrite TEXT,

  severity TEXT NOT NULL DEFAULT 'medium', -- 'low' | 'medium' | 'high' | 'critical'
  status TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'archived' | 'invalidated'

  -- Multi-model readiness — every signature can be scoped to specific Veo
  -- variants. Default covers the variants currently in production.
  model_scope TEXT[] NOT NULL DEFAULT ARRAY['veo-3.1-vertex','veo-3.1-fast','veo-3.1-standard']::TEXT[],

  -- Provenance — how was this signature authored?
  --   'seed'    — committed by hand from existing VeoPromptSanitizer rules
  --   'agent'   — clustered + summarised by VeoFailureKnowledgeBuilder
  --   'manual'  — manually added by an operator (admin UI, future)
  source TEXT NOT NULL DEFAULT 'agent',

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS veo_failure_signatures_status_idx
  ON veo_failure_signatures (status, severity);

CREATE INDEX IF NOT EXISTS veo_failure_signatures_mode_idx
  ON veo_failure_signatures (failure_mode);

ALTER TABLE veo_failure_signatures ENABLE ROW LEVEL SECURITY;

-- Reference data — only the service role reads/writes it. (The runtime path
-- consumes the regenerated VeoFailureKnowledge.mjs file, not the table
-- directly, so end-user RLS visibility isn't needed.)
DROP POLICY IF EXISTS veo_failure_signatures_service_all ON veo_failure_signatures;
CREATE POLICY veo_failure_signatures_service_all ON veo_failure_signatures
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

COMMENT ON TABLE veo_failure_signatures
  IS 'Veo Failure-Learning Agent (2026-05-06). Clustered failure patterns rebuilt by VeoFailureKnowledgeBuilder from veo_failure_log. The active rows are projected into services/v4/VeoFailureKnowledge.mjs on each agent run.';

COMMENT ON COLUMN veo_failure_signatures.signature_key
  IS 'Stable cluster identifier (e.g. persona_possessive_bodypart). Upsert key for merging new evidence into an existing pattern.';

COMMENT ON COLUMN veo_failure_signatures.preflight_rule_regex
  IS 'Optional deterministic mitigation. When non-null, VeoService.applyPreflightRules() rewrites matches with preflight_rewrite BEFORE first submission, not only after rejection.';
