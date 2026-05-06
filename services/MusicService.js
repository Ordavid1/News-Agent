// services/MusicService.js
// ElevenLabs Music wrapper — now routed through fal.ai via FAL_GCS_API_KEY.
//
// V4 migration (2026-04-11): the direct ElevenLabs REST path
// (api.elevenlabs.io/v1/music) is replaced by the fal.ai proxy endpoint
// `fal-ai/elevenlabs/music`. Consolidates V4's vendor surface to fal.ai +
// Google + ElevenLabs voice library only.
//
// The V4 post-production pipeline uses one music bed per episode:
//   1. Gemini emits `episode.music_bed_intent` as a music brief
//      (e.g. "low brooding strings, building to a crescendo at the cliffhanger")
//   2. MusicService.generateMusicBed() calls fal.ai ElevenLabs Music with the brief
//      and the episode's target duration
//   3. Returned MP3 is uploaded to Supabase → episode.music_bed_url
//   4. Post-production mixes the bed under all beats at ~-18dB, ducking to
//      ~-24dB during dialogue beats via ffmpeg volume expressions
//
// External API preserved 1:1 — `generateMusicBed({ musicBedIntent, durationSec })`
// still returns `{ audioBuffer, durationSec, format, prompt }`.
//
// 2026-05-01 — Rec 3 Phase A: composition_plan upgrade.
//   The fal.ai EL Music endpoint also accepts a structured `composition_plan`
//   payload in lieu of a flat prompt — sections per scene with positive/
//   negative styles, duration 3-120s/section, optional lyrics, plus
//   force_instrumental + respect_sections_durations flags. This unlocks
//   scene-aligned music (Sicario / Jóhannsson model) where each scene gets
//   its own section but the global negative_global pedal tone sustains a
//   single ground key across all sections — the viewer hears ONE piece
//   evolving, not N pieces stitched. Use generateMusicWithCompositionPlan()
//   when SonicSeriesBible.transition_grammar contains "musical_match_cut" or
//   when scene count ≥ 3. Falls back to generateMusicBed() (flat prompt)
//   for short stories or when Gemini fails to emit a composition_plan.
//
// 2026-05-01 — also bumped MAX_DURATION_MS from 300_000 (5 min) to 600_000
//   (10 min) to match the fal.ai endpoint's actual ceiling. Prestige series
//   episodes can now exceed the old 5-min clamp.
//
// fal.ai ElevenLabs Music input (flat-prompt path):
//   - prompt (required)
//   - music_length_ms (required, 3_000..600_000)
//   - output_format (optional, default mp3_44100_128)
//
// fal.ai ElevenLabs Music input (composition_plan path):
//   - composition_plan (required, MusicCompositionPlan object)
//   - force_instrumental (optional, boolean)
//   - respect_sections_durations (optional, boolean, default true)
//   - output_format (optional, default mp3_44100_128)
//
// fal.ai response shape (both paths): { audio: { url, content_type, file_size } }

import FalAiBaseService from './FalAiBaseService.js';

const ENDPOINT_ELEVENLABS_MUSIC = 'fal-ai/elevenlabs/music';

// ElevenLabs Music limits — fal.ai endpoint accepts 3_000..600_000 ms.
// V4 historically clamped to 300_000 (5 min) but the actual ceiling is
// 600_000 (10 min) per fal.ai docs. Prestige series episodes can exceed 5
// min; bumped 2026-05-01.
const MIN_DURATION_MS = 3_000;     // 3s minimum (per fal.ai docs)
const MAX_DURATION_MS = 600_000;   // 10 min maximum (per fal.ai docs)
const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128';

// composition_plan section limits per fal.ai docs.
const SECTION_MIN_DURATION_SEC = 3;
const SECTION_MAX_DURATION_SEC = 120;
const SECTION_LYRIC_MAX_CHARS = 200;

class MusicService {
  constructor() {
    // Music generation takes 5-30s — use a tighter poll than video.
    this.base = new FalAiBaseService({
      modelSlug: ENDPOINT_ELEVENLABS_MUSIC,
      displayName: 'MusicService',
      pollIntervalMs: 3000,
      maxPollDurationMs: 300000, // 5 min hard cap
      submitTimeoutMs: 30000
    });
  }

  isAvailable() {
    return this.base.isAvailable();
  }

  /**
   * Generate a music bed for an episode via fal.ai ElevenLabs Music.
   *
   * @param {Object} params
   * @param {string} params.musicBedIntent - Gemini-generated music brief
   * @param {number} params.durationSec - target length in seconds
   * @param {Object} [params.options]
   * @param {string} [params.options.outputFormat='mp3_44100_128']
   * @returns {Promise<{audioBuffer: Buffer, durationSec: number, format: string, prompt: string}>}
   */
  async generateMusicBed({ musicBedIntent, durationSec, options = {} }) {
    if (!this.base.isAvailable()) throw new Error('FAL_GCS_API_KEY is not configured');
    if (!musicBedIntent || musicBedIntent.trim().length === 0) {
      throw new Error('musicBedIntent is required for music generation');
    }
    if (!durationSec || durationSec <= 0) {
      throw new Error('durationSec must be a positive number');
    }

    const requestedMs = Math.round(durationSec * 1000);
    const durationMs = Math.max(MIN_DURATION_MS, Math.min(MAX_DURATION_MS, requestedMs));
    if (durationMs !== requestedMs) {
      this.base.logger.warn(`duration ${durationSec}s clamped to ${durationMs}ms for ElevenLabs Music limits`);
    }

    const { outputFormat = DEFAULT_OUTPUT_FORMAT } = options;

    this.base.logger.info(`generating music bed via fal.ai — ${durationMs}ms, intent: "${musicBedIntent.slice(0, 80)}..."`);
    const startTime = Date.now();

    // fal.ai ElevenLabs Music payload — matches the direct ElevenLabs API shape.
    const inputPayload = {
      prompt: musicBedIntent,
      music_length_ms: durationMs,
      output_format: outputFormat
    };

    let rawResult;
    try {
      rawResult = await this.base.run(inputPayload);
    } catch (err) {
      this.base.logger.error(`fal.ai music generation failed: ${err.message}`);
      throw err;
    }

    const audioUrl = rawResult?.audio?.url;
    if (!audioUrl) {
      this.base.logger.error(`fal.ai music returned no audio URL: ${JSON.stringify(rawResult).slice(0, 300)}`);
      throw new Error('fal.ai ElevenLabs Music did not return an audio URL');
    }

    const audioBuffer = await this.base.downloadToBuffer(audioUrl, 'audio');
    if (audioBuffer.length === 0) {
      throw new Error('fal.ai ElevenLabs Music returned empty audio');
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const sizeKB = (audioBuffer.length / 1024).toFixed(0);
    this.base.logger.info(`music bed ready in ${elapsed}s — ${sizeKB}KB`);

    return {
      audioBuffer,
      durationSec: durationMs / 1000,
      format: outputFormat.startsWith('mp3') ? 'mp3' : outputFormat.split('_')[0],
      prompt: musicBedIntent
    };
  }

  /**
   * 2026-05-01 — Rec 3 Phase A. composition_plan music generation.
   *
   * Structured-sections endpoint: each scene gets its own MusicSection with
   * positive/negative_local style + duration + optional lyrics. Global
   * positive/negative_global styles ride across all sections — this is where
   * the cross-section continuity contract lives. Per the Director Agent
   * verdict (A3.3 Sicario / Jóhannsson model): every section MUST share
   * key_or_modal_center with the previous section unless an explicit
   * `musical_match_cut` transition is declared. Sustain a pedal tone in the
   * negative_global so the viewer hears ONE piece evolving, not N pieces
   * stitched.
   *
   * The validator below rejects plans with > 1 unique key_or_modal_center
   * across sections (counted from per-section positive_local strings) unless
   * the plan declares allow_key_changes: true. This is a soft guardrail that
   * Gemini learns to obey by failing fast.
   *
   * @param {Object} params
   * @param {Object} params.compositionPlan
   * @param {string} [params.compositionPlan.positive_global] - styles applied to all sections (the show's sonic DNA)
   * @param {string} [params.compositionPlan.negative_global] - styles never to use (the no-fly list pedal tone)
   * @param {string} [params.compositionPlan.key_or_modal_center] - shared key the bed sustains across sections
   * @param {boolean} [params.compositionPlan.allow_key_changes=false] - when true, validator skips the single-key check
   * @param {Array<Object>} params.compositionPlan.sections - each: { name, duration_seconds, positive_local, negative_local?, lyrics?, transition_type? }
   * @param {Object} [params.options]
   * @param {boolean} [params.options.forceInstrumental=true] - default true for V4 episode beds (no vocals fighting dialogue)
   * @param {boolean} [params.options.respectSectionsDurations=true]
   * @param {string} [params.options.outputFormat='mp3_44100_128']
   * @returns {Promise<{audioBuffer: Buffer, durationSec: number, format: string, plan: Object}>}
   */
  async generateMusicWithCompositionPlan({ compositionPlan, options = {} }) {
    if (!this.base.isAvailable()) throw new Error('FAL_GCS_API_KEY is not configured');
    this._validateCompositionPlan(compositionPlan);

    const {
      forceInstrumental = true,
      respectSectionsDurations = true,
      outputFormat = DEFAULT_OUTPUT_FORMAT
    } = options;

    // Total duration = sum of section durations (informational; the endpoint
    // honors per-section durations when respectSectionsDurations=true).
    const totalDurationSec = compositionPlan.sections.reduce(
      (acc, s) => acc + (s.duration_seconds || 0),
      0
    );

    this.base.logger.info(
      `generating composition_plan music — ${compositionPlan.sections.length} sections, ${totalDurationSec}s total, ` +
      `key=${compositionPlan.key_or_modal_center || 'unspecified'}, instrumental=${forceInstrumental}`
    );
    const startTime = Date.now();

    // Strip our internal validator-only fields before sending to fal.ai.
    // The endpoint accepts the standard MusicCompositionPlan shape; our
    // `key_or_modal_center` and `allow_key_changes` are bib-checked locally
    // and don't ride to the API.
    const apiPlan = {
      positive_global: compositionPlan.positive_global || '',
      negative_global: compositionPlan.negative_global || '',
      sections: compositionPlan.sections.map(s => ({
        name: s.name,
        duration: s.duration_seconds,
        positive_local: s.positive_local || '',
        negative_local: s.negative_local || '',
        lyrics: s.lyrics || ''
      }))
    };

    const inputPayload = {
      composition_plan: apiPlan,
      force_instrumental: forceInstrumental,
      respect_sections_durations: respectSectionsDurations,
      output_format: outputFormat
    };

    let rawResult;
    try {
      rawResult = await this.base.run(inputPayload);
    } catch (err) {
      this.base.logger.error(`fal.ai music composition_plan generation failed: ${err.message}`);
      throw err;
    }

    const audioUrl = rawResult?.audio?.url;
    if (!audioUrl) {
      this.base.logger.error(`fal.ai music returned no audio URL: ${JSON.stringify(rawResult).slice(0, 300)}`);
      throw new Error('fal.ai ElevenLabs Music did not return an audio URL');
    }

    const audioBuffer = await this.base.downloadToBuffer(audioUrl, 'audio');
    if (audioBuffer.length === 0) {
      throw new Error('fal.ai ElevenLabs Music returned empty audio');
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const sizeKB = (audioBuffer.length / 1024).toFixed(0);
    this.base.logger.info(`composition_plan music ready in ${elapsed}s — ${sizeKB}KB, ${totalDurationSec}s`);

    return {
      audioBuffer,
      durationSec: totalDurationSec,
      format: outputFormat.startsWith('mp3') ? 'mp3' : outputFormat.split('_')[0],
      plan: compositionPlan
    };
  }

  /**
   * Validate composition_plan structure + cross-section continuity rules
   * (A3.3 amendment: Sicario / Jóhannsson model). Throws on hard violations.
   *
   * Rules:
   *   1. Plan must have a non-empty `sections` array.
   *   2. Each section needs `name` + `duration_seconds` (3-120s) + `positive_local`.
   *   3. Section lyrics ≤ 200 chars when present.
   *   4. Total duration ≤ MAX_DURATION_MS / 1000.
   *   5. Cross-section continuity: if a `key_or_modal_center` is provided on
   *      the plan AND any section's `positive_local` declares a different
   *      explicit key, reject UNLESS allow_key_changes=true OR the section
   *      sets transition_type='musical_match_cut'.
   *
   * @param {Object} plan
   * @throws {Error} on validation failure
   */
  _validateCompositionPlan(plan) {
    if (!plan || typeof plan !== 'object') {
      throw new Error('compositionPlan is required');
    }
    if (!Array.isArray(plan.sections) || plan.sections.length === 0) {
      throw new Error('compositionPlan.sections must be a non-empty array');
    }

    let totalSec = 0;
    plan.sections.forEach((s, i) => {
      if (!s || typeof s !== 'object') {
        throw new Error(`compositionPlan.sections[${i}] must be an object`);
      }
      if (!s.name || typeof s.name !== 'string') {
        throw new Error(`compositionPlan.sections[${i}].name is required`);
      }
      if (typeof s.duration_seconds !== 'number'
          || s.duration_seconds < SECTION_MIN_DURATION_SEC
          || s.duration_seconds > SECTION_MAX_DURATION_SEC) {
        throw new Error(
          `compositionPlan.sections[${i}].duration_seconds must be ${SECTION_MIN_DURATION_SEC}-${SECTION_MAX_DURATION_SEC}s`
        );
      }
      if (!s.positive_local || typeof s.positive_local !== 'string' || s.positive_local.trim().length === 0) {
        throw new Error(`compositionPlan.sections[${i}].positive_local is required`);
      }
      if (s.lyrics && s.lyrics.length > SECTION_LYRIC_MAX_CHARS) {
        throw new Error(`compositionPlan.sections[${i}].lyrics exceeds ${SECTION_LYRIC_MAX_CHARS} chars`);
      }
      totalSec += s.duration_seconds;
    });

    const totalMs = totalSec * 1000;
    if (totalMs < MIN_DURATION_MS || totalMs > MAX_DURATION_MS) {
      throw new Error(
        `compositionPlan total duration ${totalSec}s outside [${MIN_DURATION_MS / 1000}, ${MAX_DURATION_MS / 1000}]`
      );
    }

    // Cross-section continuity (A3.3): when the plan declares a shared key
    // AND any section's positive_local mentions an explicit different key
    // ("D minor", "F# major", etc.), reject. The intent is to flag obvious
    // multi-key compositions. Subtle modal mode shifts within the same key
    // center are not policed — only explicit key declarations.
    if (plan.key_or_modal_center && !plan.allow_key_changes) {
      const declaredKey = plan.key_or_modal_center.toLowerCase().trim();
      const KEY_PATTERN = /\b([a-g](?:\s*(?:#|sharp|b|flat))?)\s+(major|minor|dorian|phrygian|lydian|mixolydian|aeolian|locrian)\b/gi;
      const violations = [];
      plan.sections.forEach((s, i) => {
        if (s.transition_type === 'musical_match_cut') return; // explicit transition allowed
        const matches = s.positive_local.match(KEY_PATTERN) || [];
        for (const m of matches) {
          if (m.toLowerCase().trim() !== declaredKey) {
            violations.push(`section[${i}] declares "${m}" but plan key is "${plan.key_or_modal_center}"`);
            break;
          }
        }
      });
      if (violations.length > 0) {
        throw new Error(
          `compositionPlan key continuity violation: the plan declares ` +
          `key_or_modal_center="${plan.key_or_modal_center}" but ${violations.join('; ')}. ` +
          `Either set allow_key_changes=true OR mark the diverging section's ` +
          `transition_type="musical_match_cut".`
        );
      }
    }
  }
}

const musicService = new MusicService();
export default musicService;
export { MusicService };
