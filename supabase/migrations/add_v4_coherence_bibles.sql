-- add_v4_coherence_bibles.sql
--
-- V4 Cinematic Coherence Overhaul — migrations for the three "bibles" that
-- eliminate cross-beat/cross-episode drift.
--
--   1. Subject Bible — story-level, persistent. Lists the product/landscape
--      key visual features, materials, silhouette, and an integration mandate
--      (min beats per episode that MUST feature the subject). Stored on
--      brand_stories.subject jsonb as `subject.subject_bible`.
--
--   2. Location Bible — story-level, growing. Locations are reused across
--      scenes/episodes. When a scene declares scene.location_id matching an
--      existing entry, the orchestrator reuses the cached Seedream scene
--      master URL instead of regenerating — so "the landscape terrace" renders
--      the same way in episode 3 as it did in episode 1.
--
--   3. Wardrobe Ledger — persona-level, per-episode. Captures what each
--      persona wore in every past episode so the next episode's screenplay
--      prompt can instruct Gemini to either continue the look (same episode)
--      or declare a new look (different episode). Stored inside
--      brand_stories.storyline.persona_wardrobe_ledger.
--
--   4. Persona-locked first frame — per-beat storage for the Seedream pre-pass
--      output. Lets resume skip regeneration and lets the Director Panel show
--      the pre-pass panel as a preview.
--
-- Purely additive. No existing columns touched. Safe to apply to a live DB.

-- 1. Subject Bible — nested under brand_stories.subject jsonb
-- (No column to add; documented via comment so future schema tools know the shape.)
COMMENT ON COLUMN brand_stories.subject IS
  'Story subject spec. Extended in Phase 1.1 with a nested subject_bible: { key_visual_features[], materials_palette[], silhouette_notes, integration_mandate: { min_beats_per_episode, hero_beat_types[], must_show_in_ep1 } }. Seeded once at story creation by BrandStoryService._seedSubjectBible().';

-- 2. Location Bible — story-level dictionary of reusable location masters
ALTER TABLE brand_stories
  ADD COLUMN IF NOT EXISTS location_bible JSONB DEFAULT '{"locations": []}'::jsonb;

COMMENT ON COLUMN brand_stories.location_bible IS
  'Growing dictionary of reusable locations. Shape: { locations: [{ id, name, reference_urls[], visual_anchor_prompt, lighting_profile, scene_master_url, first_seen_episode_number }] }. When a scene emits scene.location_id matching an existing entry, the orchestrator REUSES the cached scene_master_url instead of regenerating via Seedream.';

-- 3. Wardrobe Ledger — tracked inside the existing storyline jsonb via
--    persona_wardrobe_ledger key. No schema change required; comment only.
COMMENT ON COLUMN brand_stories.storyline IS
  'Running narrative state. Extended in V4 with: previously_on_keyframes[], character_voice_samples{}, emotional_intensity_ledger{}, persona_wardrobe_ledger{ personaIndex: { ep_N: wardrobeDescription } } (Phase 1.3 — preserves per-episode costume continuity so wardrobe stays fixed within an episode and can change intentionally between episodes).';

-- 4. Per-beat persona lock cache — stored inside scene_description.scenes[].beats[]
--    as beat.persona_locked_first_frame_url. No table column — it lives in the
--    existing scene_description jsonb so resumes and Director Panel can read it.
COMMENT ON COLUMN brand_story_episodes.scene_description IS
  'V4 scene-graph. Beats may carry a persona_locked_first_frame_url (Phase 2) — the Seedream pre-pass panel used as Veo first_frame for persona-featuring beats. Preserved across resumes so a restart skips regeneration.';
