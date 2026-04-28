-- add_v4_cast_bible.sql
--
-- V4 Cast Coherence — Cast Bible at story creation.
--
-- WHY:
--   Episodes occasionally drift from the cast Gemini emitted in the storyline:
--   a phantom character appears at persona_index 1 when only persona 0 exists,
--   the validator (checkPersonaIndexCoverage) raises a loud blocker, and the
--   user has to fix the screenplay manually. The fix is a story-creation-time
--   cast_bible that every per-episode screenplay prompt quotes as a HARD
--   CONSTRAINT — Gemini must reference ONLY the listed persona_index values.
--   One cast, every episode. Cast Bible is to characters what Sonic Series
--   Bible is to audio: a locked structural contract derived once per story
--   and immutable thereafter (mutable only via PATCH).
--
-- SHAPE (derived from storyline.characters[] + persona_config.personas[] at
-- first runV4Pipeline call — NO Gemini call, purely structural snapshot):
--
-- {
--   "status": "derived" | "locked" | "manual_override",
--   "version": 1,
--   "principals": [
--     {
--       "cast_id": "principal_0",
--       "persona_index": 0,
--       "name": "Sydney",
--       "role": "protagonist",
--       "visual_description": "...",
--       "arc": "...",
--       "elevenlabs_voice_id": "EXAVITQ...",
--       "elevenlabs_voice_name": "Daniel",
--       "gender_inferred": "male" | "female" | "unknown",
--       "gender_resolved_from": "persona_explicit" | "persona_signal" | "storyline_signal" | "unknown",
--       "voice_gender_match": true | false | null
--     }
--   ],
--   "guest_pool": [],
--   "locked_at": null | "2026-04-28T...",
--   "inheritance_policy": {
--     "persona_indexes": "immutable",
--     "voice_assignments": "immutable_when_locked",
--     "appearances": "mutable_per_episode"
--   },
--   "_generated_by": "derived_from_storyline" | "manual_override"
-- }
--
-- LIFECYCLE:
--   - NULL by default (legacy stories, freshly-created stories before first episode)
--   - Populated on first runV4Pipeline call (Step 1b, after voice acquisition,
--     before LUT matching — sits ABOVE the future Phase-6 commercial-genre
--     branch so commercials also get a bible)
--   - Idempotency: re-derive when bible is missing OR has empty principals
--     AND _generated_by !== 'manual_override' (manual overrides preserved)
--   - Mutable via PATCH /api/brand-stories/:id/cast-bible (Director Panel
--     Casting Room)
--   - Read by every per-episode screenplay generation as immutable system
--     context (HARD CONSTRAINT block in prompt)
--
-- INVARIANTS:
--   - persona_config.personas[].elevenlabs_voice_id is the CANONICAL TRUTH
--     for voice assignments. cast_bible.principals[].elevenlabs_voice_id is
--     a DERIVED VIEW re-resolved on every read. PATCH /cast-bible REJECTS
--     changes to voice_id at the API boundary.
--   - When status === 'locked', all structural mutations (principal count,
--     persona_index, name, role, gender, voice) are rejected with 409 or 422.
--     Lock can only be undone via PATCH { bible: null }.
--
-- Purely additive. No existing columns touched. Safe to apply to a live DB.

ALTER TABLE brand_stories
  ADD COLUMN IF NOT EXISTS cast_bible JSONB;

COMMENT ON COLUMN brand_stories.cast_bible IS
  'V4 Cast Bible — derived once per story from storyline.characters[] + persona_config.personas[] '
  'at first runV4Pipeline call (no Gemini call, purely structural). Drives the HARD CONSTRAINT '
  'block in every per-episode screenplay prompt — Gemini must reference ONLY the listed '
  'persona_index values, eliminating phantom-character invention at source. principals[] mirrors '
  'persona_config but adds gender_resolved_from provenance and voice_gender_match flag for '
  'Casting Room UX. persona_config.personas[].elevenlabs_voice_id remains the canonical truth; '
  'cast_bible voice fields are derived views re-resolved on read. Mutable via PATCH '
  '/api/brand-stories/:id/cast-bible; locked status rejects structural mutations.';
