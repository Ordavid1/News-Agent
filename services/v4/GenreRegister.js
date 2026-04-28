// services/v4/GenreRegister.js
// V4 Brand Story genre register loader.
//
// Single source of truth for genre-specific craft directives. Both the
// screenplay GENERATOR (public/components/brandStoryPromptsV4.mjs) and the
// Layer-3 JUDGE (services/v4/director-rubrics/sharedHeader.mjs) read from
// here, eliminating the judge/generator drift bug.
//
// Architecture mirrors BrandKitLutMatcher:
//   ▸ Boot-time JSON load + cache (module-load is idempotent).
//   ▸ Alias map for case-insensitive / synonym lookup (noir → mystery).
//   ▸ Safe fallback returns '' when an unknown genre is requested
//     (preserves existing contract on the legacy inline function).
//
// Env flag: BRAND_STORY_GENRE_REGISTER_LIBRARY (default false during
// migration). When false, callers fall back to the legacy inline block
// in brandStoryPromptsV4.mjs. When true, this module is the source of
// truth.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LIBRARY_PATH = path.resolve(__dirname, '..', '..', 'assets', 'genre-registers', 'library.json');

// ─────────────────────────────────────────────────────────────────────
// Feature flag
// ─────────────────────────────────────────────────────────────────────

export function isGenreRegisterLibraryEnabled() {
  return String(process.env.BRAND_STORY_GENRE_REGISTER_LIBRARY || 'false').toLowerCase() === 'true';
}

// ─────────────────────────────────────────────────────────────────────
// Load + index at module load time. Throws if the JSON is malformed —
// service refuses to start on a corrupt library, by design.
// ─────────────────────────────────────────────────────────────────────

let _registers = null;
let _index = null;        // Map<genreId|alias, registerObject>
let _hardFloorChecked = false;

function loadLibrary() {
  if (_registers) return _registers;

  const raw = fs.readFileSync(LIBRARY_PATH, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.registers)) {
    throw new Error('GenreRegister: library.json must export `registers[]`');
  }
  _registers = parsed.registers;

  _index = new Map();
  for (const reg of _registers) {
    if (!reg.genre_id) {
      throw new Error('GenreRegister: every register entry must declare genre_id');
    }
    _index.set(reg.genre_id.toLowerCase(), reg);
    if (Array.isArray(reg.aliases)) {
      for (const alias of reg.aliases) {
        _index.set(String(alias).toLowerCase(), reg);
      }
    }
  }

  // Hard floor enforcement on min_dialogue_words_avg (Phase 3 risk
  // mitigation). Schema validation also enforces this at JSON-schema layer;
  // this is the run-time belt-and-braces.
  if (!_hardFloorChecked) {
    _hardFloorChecked = true;
    for (const reg of _registers) {
      const floor = reg?.dialogue_floor?.min_dialogue_words_avg;
      if (typeof floor === 'number' && floor < 2.5) {
        throw new Error(
          `GenreRegister: ${reg.genre_id}.dialogue_floor.min_dialogue_words_avg=${floor} is below the hard floor of 2.5. ` +
          `This safety net prevents a malformed register from defeating the validator.`
        );
      }
    }
  }

  return _registers;
}

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

/**
 * Returns the structured register object for a genre, or null if unknown.
 * Case-insensitive lookup; honours the aliases array on each register.
 */
export function getGenreRegister(genre) {
  if (!genre) return null;
  loadLibrary();
  return _index.get(String(genre).toLowerCase().trim()) || null;
}

/**
 * Returns all known genre_ids (excluding aliases).
 */
export function listGenreIds() {
  loadLibrary();
  return _registers.map((r) => r.genre_id);
}

/**
 * Returns the structured registers array (for tests + diagnostics).
 */
export function getAllRegisters() {
  loadLibrary();
  return _registers.slice();
}

/**
 * Resolve the dialogue floor for a genre, honouring an optional per-episode
 * dialogue_density_intent override. Used by ScreenplayValidator (Phase 3.1
 * + 3.5).
 *
 *   intent='silent_register'  → scale toward action's clipped floor
 *   intent='dialogue_dense'   → hold floor; raise density target instead
 *                                (handled at the density check site)
 *   intent='balanced' or null → use the genre's declared floor
 *
 * Returns { min_dialogue_words_avg, target_dialogue_runtime_pct, max_bare_short_lines }.
 */
export function resolveDialogueFloor(genre, intent = null) {
  const reg = getGenreRegister(genre);
  const def = {
    min_dialogue_words_avg: 6,
    target_dialogue_runtime_pct: [0.35, 0.65],
    max_bare_short_lines: 2
  };

  const base = reg?.dialogue_floor
    ? {
        min_dialogue_words_avg: reg.dialogue_floor.min_dialogue_words_avg ?? def.min_dialogue_words_avg,
        target_dialogue_runtime_pct: reg.dialogue_floor.target_dialogue_runtime_pct ?? def.target_dialogue_runtime_pct,
        max_bare_short_lines: typeof reg.dialogue_floor.max_bare_short_lines === 'number'
          ? reg.dialogue_floor.max_bare_short_lines
          : def.max_bare_short_lines
      }
    : { ...def };

  const normalizedIntent = String(intent || 'balanced').toLowerCase().trim();

  if (normalizedIntent === 'silent_register') {
    // Drop the avg-words floor toward the action register's clipped tolerance,
    // and effectively disable the bare-short-lines cap (action's posture).
    return {
      ...base,
      min_dialogue_words_avg: Math.min(base.min_dialogue_words_avg, 3.0),
      max_bare_short_lines: -1,
      density_check_skipped: true
    };
  }

  if (normalizedIntent === 'dialogue_dense') {
    // Hold avg-words floor; raise the runtime-pct floor so the validator
    // requires more dialogue real-estate (the room talks).
    const [origMin, origMax] = base.target_dialogue_runtime_pct;
    return {
      ...base,
      target_dialogue_runtime_pct: [Math.max(origMin, 0.55), origMax]
    };
  }

  return base;
}

// ─────────────────────────────────────────────────────────────────────
// Render — build the prompt text the GENERATOR sees.
//
// Output shape mirrors the existing inline _buildGenreRegisterBlock so the
// downstream prompt is identical-shape. Tier-A registers render the full
// director's brief; Tier-B registers render the lightweight version.
// Unknown genres → '' (preserves the legacy fallback contract).
// ─────────────────────────────────────────────────────────────────────

const HR = '═══════════════════════════════════════════════════════════════';

function renderRange(arr) {
  if (!Array.isArray(arr) || arr.length < 2) return '';
  return `${arr[0]}-${arr[1]}`;
}

function renderBeatMix(mix) {
  if (!mix || typeof mix !== 'object') return '';
  return Object.entries(mix)
    .map(([type, [min, max]]) => `  - ${type}: ${(min * 100).toFixed(0)}-${(max * 100).toFixed(0)}%`)
    .join('\n');
}

function renderList(label, arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '';
  return `${label}: ${arr.join(', ')}`;
}

function renderDoNots(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '';
  return arr.map((line) => `  - ${line}`).join('\n');
}

/**
 * Render a Tier-A full register block — director's brief format.
 */
function renderFullRegister(reg) {
  const pacing = reg.pacing_rules || {};
  const dialogue = reg.dialogue_floor || {};
  const camera = reg.camera_register || {};
  const music = reg.music_bed_intent || {};
  const lut = reg.lut_recommendations || {};
  const transitions = reg.transitions || {};

  const beatMix = renderBeatMix(reg.beat_type_mix);
  const doNots = renderDoNots(reg.do_nots);
  const lightingMotifs = renderList('Lighting motifs', camera.lighting_motifs);
  const hookPriorities = renderList('Hook type priorities', reg.hook_type_priorities);

  return `${HR}
GENRE REGISTER — ${reg.display_name.toUpperCase()}
${HR}

PACING & BEAT SHAPE:
  - Typical beat duration: ${renderRange(pacing.typical_beat_duration_s)}s.
  - Dialogue breath rule: ${pacing.dialogue_breath_rule || ''}
  - Typical scene count per episode: ${renderRange(pacing.typical_scene_count)}.
  - Movement breakdown: ${pacing.movement_breakdown || ''}

DIALOGUE FLOOR (validator-aware — these are the genre's craft thresholds):
  - Avg words/line floor: ≥ ${dialogue.min_dialogue_words_avg}.
  - Dialogue runtime share: ${(dialogue.target_dialogue_runtime_pct?.[0] * 100 || '?')}-${(dialogue.target_dialogue_runtime_pct?.[1] * 100 || '?')}% of episode.
  - Line-length register: ${dialogue.line_length_register || ''}

BEAT TYPE MIX (approximate share by type):
${beatMix}

VISUAL / CAMERA REGISTER:
  - Lens: ${camera.typical_lens_mm || ''}.
  - Movement style: ${camera.movement_style || ''}.
  - Default framings (from V4_FRAMING_VOCAB): ${(camera.framing_defaults || []).join(', ')}.
${lightingMotifs ? `  - ${lightingMotifs}.` : ''}

AMBIENT BED (scene.ambient_bed_prompt direction):
${reg.ambient_bed || ''}

MUSIC BED INTENT (music_bed_intent direction):
  - BPM range: ${renderRange(music.bpm_range)} BPM.
  - Instrumentation: ${music.instrumentation || ''}
  - Composer / film references: ${(music.composer_references || []).join('; ')}.

LUT CHOICE:
  - Preferred: ${(lut.preferred || []).join(', ')}.
  - Avoid: ${(lut.avoid || []).join(', ')}.

TRANSITIONS BETWEEN SCENES:
  - Default: ${transitions.default || 'cut'}.
  - Notes: ${transitions.notes || ''}

CHARACTER STAKES UNDER PRESSURE:
${reg.character_stakes || ''}

DO NOT:
${doNots}
${hookPriorities ? `\n${hookPriorities}.` : ''}`;
}

/**
 * Render a Tier-B lightweight register block — compact form.
 */
function renderLightweightRegister(reg) {
  const pacing = reg.pacing_rules || {};
  const dialogue = reg.dialogue_floor || {};
  const camera = reg.camera_register || {};
  const music = reg.music_bed_intent || {};
  const lut = reg.lut_recommendations || {};
  const transitions = reg.transitions || {};

  return `${HR}
GENRE REGISTER — ${reg.display_name.toUpperCase()}
${HR}

PACING: ${pacing.dialogue_breath_rule || ''}
DIALOGUE FLOOR: avg ≥ ${dialogue.min_dialogue_words_avg} words/line; runtime ${(dialogue.target_dialogue_runtime_pct?.[0] * 100 || '?')}-${(dialogue.target_dialogue_runtime_pct?.[1] * 100 || '?')}%. ${dialogue.line_length_register || ''}
CAMERA: ${camera.typical_lens_mm || ''}; ${camera.movement_style || ''}. Framings: ${(camera.framing_defaults || []).join(', ')}.
AMBIENT BED: ${reg.ambient_bed || ''}
MUSIC: ${renderRange(music.bpm_range)} BPM; ${music.instrumentation || ''} (refs: ${(music.composer_references || []).join('; ')}).
LUTs preferred: ${(lut.preferred || []).join(', ')}. Avoid: ${(lut.avoid || []).join(', ')}.
TRANSITIONS: default '${transitions.default || 'cut'}' — ${transitions.notes || ''}
STAKES: ${reg.character_stakes || ''}
DO NOT: ${(reg.do_nots || []).join(' / ')}.`;
}

/**
 * Build the genre register prompt block for the GENERATOR. Returns '' when
 * the genre is unknown (preserves the legacy contract).
 */
export function buildGenreRegisterBlock(genre) {
  const reg = getGenreRegister(genre);
  if (!reg) return '';
  return reg.tier === 'A'
    ? renderFullRegister(reg)
    : renderLightweightRegister(reg);
}

/**
 * Build the short-form hint for the Layer-3 JUDGE rubric. Always compact —
 * the judge needs to know the register's signature in 4-6 lines, not the
 * full director's brief.
 */
export function buildGenreRegisterHint(genre) {
  const reg = getGenreRegister(genre);
  if (!reg) return '';
  const dialogue = reg.dialogue_floor || {};
  const music = reg.music_bed_intent || {};
  const lut = reg.lut_recommendations || {};
  return `GENRE REGISTER — ${reg.display_name}: ` +
    `${dialogue.line_length_register || ''} ` +
    `Pacing: ${reg.pacing_rules?.dialogue_breath_rule || ''} ` +
    `Music: ${renderRange(music.bpm_range)} BPM; ${music.instrumentation || ''}. ` +
    `LUT: prefer ${(lut.preferred || []).slice(0, 3).join('/')}. ` +
    `Stakes: ${reg.character_stakes || ''}`;
}
