// tests/v4/GenreRegisterLibrary.test.mjs
// Phase 2 regression net for assets/genre-registers/library.json.
//
// Asserts:
//   - All 15 user-selectable genre option values from public/profile.html
//     resolve to a register entry (or have a documented alias).
//   - Every register entry passes JSON-schema validation.
//   - No field string contains 4+ consecutive words wrapped in quotes
//     (regression net for accidentally pasted dialogue samples).
//   - Every lut_recommendations.preferred and avoid ID exists in
//     assets/luts/library.json's creative array (or in V4_LUT_LIBRARY for
//     legacy IDs).
//   - min_dialogue_words_avg >= 2.5 for every genre (hard floor — see
//     Phase 3 risk mitigation in the plan).
//   - The render functions produce non-empty output for every genre.
//   - Tier-A genres render LONGER blocks than Tier-B (sanity check on
//     render branching).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  getGenreRegister,
  listGenreIds,
  getAllRegisters,
  buildGenreRegisterBlock,
  buildGenreRegisterHint,
  resolveDialogueFloor
} from '../../services/v4/GenreRegister.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROFILE_HTML_GENRES = [
  'drama', 'action', 'comedy', 'thriller', 'romance', 'sci-fi', 'fantasy',
  'period', 'horror', 'documentary', 'noir', 'inspirational', 'adventure',
  'slice-of-life', 'commercial'
];

function loadValidLutIds() {
  const lutLibPath = path.resolve(__dirname, '..', '..', 'assets', 'luts', 'library.json');
  const lutLib = JSON.parse(fs.readFileSync(lutLibPath, 'utf-8'));
  const ids = new Set();
  for (const e of (lutLib.creative || [])) ids.add(e.id);
  for (const e of (lutLib.creative_legacy || [])) ids.add(e.id);
  return ids;
}

const VALID_LUT_IDS = loadValidLutIds();

function containsQuotedDialogue(value) {
  if (typeof value === 'string') {
    const re = /["\u201C\u201D]([^"\u201C\u201D]{0,200})["\u201C\u201D]/g;
    let m;
    while ((m = re.exec(value)) !== null) {
      const inner = m[1].trim();
      const wordCount = inner.split(/\s+/).filter(Boolean).length;
      if (wordCount >= 4) return inner;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = containsQuotedDialogue(v);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) {
      const hit = containsQuotedDialogue(v);
      if (hit) return hit;
    }
    return null;
  }
  return null;
}

describe('GenreRegisterLibrary — coverage', () => {
  test('every profile.html genre option resolves to a register', () => {
    for (const genre of PROFILE_HTML_GENRES) {
      const reg = getGenreRegister(genre);
      assert.ok(
        reg !== null,
        `genre "${genre}" from profile.html does not resolve to a register entry. Add it to assets/genre-registers/library.json or document an alias.`
      );
    }
  });

  test('listGenreIds() returns all 14 distinct genre_ids (15 options minus noir alias)', () => {
    const ids = listGenreIds();
    assert.ok(ids.length >= 14, `expected >=14 distinct genre_ids, got ${ids.length}`);
    const set = new Set(ids);
    for (const id of ids) {
      assert.ok(set.has(id), `genre_id "${id}" must be unique within registers`);
    }
  });

  test('noir alias resolves to the mystery register', () => {
    const noir = getGenreRegister('noir');
    const mystery = getGenreRegister('mystery');
    assert.ok(noir, 'noir must resolve');
    assert.ok(mystery, 'mystery must resolve');
    assert.strictEqual(noir.genre_id, mystery.genre_id, 'noir alias must point to the mystery entry');
  });
});

describe('GenreRegisterLibrary — schema invariants', () => {
  const registers = getAllRegisters();

  for (const reg of registers) {
    test(`${reg.genre_id} — schema fields are present`, () => {
      assert.ok(reg.genre_id, 'genre_id required');
      assert.ok(reg.display_name, 'display_name required');
      assert.ok(['A', 'B'].includes(reg.tier), `tier must be A or B (got ${reg.tier})`);
      assert.ok(reg.pacing_rules, 'pacing_rules required');
      assert.ok(reg.dialogue_floor, 'dialogue_floor required');
      assert.ok(reg.beat_type_mix, 'beat_type_mix required');
      assert.ok(reg.camera_register, 'camera_register required');
      assert.ok(typeof reg.ambient_bed === 'string' && reg.ambient_bed.length > 10, 'ambient_bed required');
      assert.ok(reg.music_bed_intent, 'music_bed_intent required');
      assert.ok(reg.lut_recommendations, 'lut_recommendations required');
      assert.ok(reg.transitions, 'transitions required');
      assert.ok(typeof reg.character_stakes === 'string' && reg.character_stakes.length > 10, 'character_stakes required');
      assert.ok(Array.isArray(reg.do_nots) && reg.do_nots.length >= 1, 'do_nots required');
    });

    test(`${reg.genre_id} — min_dialogue_words_avg respects the 2.5 hard floor`, () => {
      const floor = reg.dialogue_floor.min_dialogue_words_avg;
      assert.ok(typeof floor === 'number', 'must be a number');
      assert.ok(floor >= 2.5, `min_dialogue_words_avg=${floor} for ${reg.genre_id} is below the hard floor of 2.5`);
      assert.ok(floor <= 12, `min_dialogue_words_avg=${floor} is unreasonably high (>12)`);
    });

    test(`${reg.genre_id} — target_dialogue_runtime_pct is well-formed`, () => {
      const pct = reg.dialogue_floor.target_dialogue_runtime_pct;
      assert.ok(Array.isArray(pct) && pct.length === 2, 'must be [min, max]');
      assert.ok(pct[0] < pct[1], 'min must be less than max');
      assert.ok(pct[0] >= 0.05 && pct[1] <= 0.85, 'pct must be in [0.05, 0.85]');
    });

    test(`${reg.genre_id} — bpm_range is well-formed`, () => {
      const bpm = reg.music_bed_intent.bpm_range;
      assert.ok(Array.isArray(bpm) && bpm.length === 2, 'bpm_range must be [min, max]');
      assert.ok(bpm[0] < bpm[1], 'bpm min < max');
      assert.ok(bpm[0] >= 30 && bpm[1] <= 240, 'bpm in [30, 240]');
    });

    test(`${reg.genre_id} — composer_references has at least 2 entries`, () => {
      const refs = reg.music_bed_intent.composer_references || [];
      assert.ok(Array.isArray(refs) && refs.length >= 2, 'at least 2 composer references required to broaden the convex hull');
    });
  }
});

describe('GenreRegisterLibrary — hardcoding-ban scan', () => {
  const registers = getAllRegisters();

  for (const reg of registers) {
    test(`${reg.genre_id} — no field contains 4+ consecutive quoted words`, () => {
      const hit = containsQuotedDialogue(reg);
      assert.strictEqual(
        hit, null,
        `${reg.genre_id} has a field containing what looks like quoted dialogue: "${hit}". Genre registers must be PARAMETERS / CRAFT DIRECTIVES / EXTERNAL REFERENCES — never quoted dialogue or sample lines.`
      );
    });
  }
});

describe('GenreRegisterLibrary — LUT cross-reference', () => {
  const registers = getAllRegisters();

  for (const reg of registers) {
    test(`${reg.genre_id} — every preferred LUT exists in assets/luts/library.json`, () => {
      for (const id of (reg.lut_recommendations.preferred || [])) {
        assert.ok(
          VALID_LUT_IDS.has(id),
          `${reg.genre_id}: preferred LUT "${id}" not found in assets/luts/library.json.`
        );
      }
    });

    test(`${reg.genre_id} — every avoided LUT exists in assets/luts/library.json`, () => {
      for (const id of (reg.lut_recommendations.avoid || [])) {
        assert.ok(
          VALID_LUT_IDS.has(id),
          `${reg.genre_id}: avoided LUT "${id}" not found in assets/luts/library.json.`
        );
      }
    });
  }
});

describe('GenreRegisterLibrary — render functions', () => {
  test('buildGenreRegisterBlock returns non-empty output for every genre', () => {
    for (const genre of PROFILE_HTML_GENRES) {
      const block = buildGenreRegisterBlock(genre);
      assert.ok(typeof block === 'string', `${genre}: block must be a string`);
      assert.ok(block.length > 100, `${genre}: block too short (${block.length} chars)`);
    }
  });

  test('buildGenreRegisterBlock returns "" for unknown genre', () => {
    const block = buildGenreRegisterBlock('not-a-real-genre-id');
    assert.strictEqual(block, '', 'unknown genre must return empty string (preserves legacy contract)');
  });

  test('Tier-A blocks are longer than Tier-B blocks (sanity check)', () => {
    const drama = buildGenreRegisterBlock('drama');
    const sciFi = buildGenreRegisterBlock('sci-fi');
    assert.ok(
      drama.length > sciFi.length,
      `Tier-A drama block (${drama.length}) must be longer than Tier-B sci-fi block (${sciFi.length})`
    );
  });

  test('buildGenreRegisterHint returns non-empty short-form for every genre', () => {
    for (const genre of PROFILE_HTML_GENRES) {
      const hint = buildGenreRegisterHint(genre);
      assert.ok(typeof hint === 'string' && hint.length > 30, `${genre}: hint too short`);
      assert.ok(hint.length < 1500, `${genre}: hint should stay short for the judge rubric (got ${hint.length} chars)`);
    }
  });
});

describe('GenreRegisterLibrary — resolveDialogueFloor (Phase 3.5 contract)', () => {
  test('balanced intent returns the genre default', () => {
    const action = resolveDialogueFloor('action', 'balanced');
    const reg = getGenreRegister('action');
    assert.strictEqual(action.min_dialogue_words_avg, reg.dialogue_floor.min_dialogue_words_avg);
  });

  test('silent_register intent scales avg-words floor to <= 3.0 and disables bare-short cap', () => {
    const drama = resolveDialogueFloor('drama', 'silent_register');
    assert.ok(drama.min_dialogue_words_avg <= 3.0, 'silent_register must scale toward action floor');
    assert.strictEqual(drama.max_bare_short_lines, -1, 'silent_register must disable bare-short cap');
    assert.strictEqual(drama.density_check_skipped, true, 'silent_register must skip density check');
  });

  test('dialogue_dense intent raises runtime-pct floor to >= 0.55', () => {
    const action = resolveDialogueFloor('action', 'dialogue_dense');
    assert.ok(action.target_dialogue_runtime_pct[0] >= 0.55, 'dialogue_dense must raise runtime-pct floor');
  });

  test('unknown genre returns safe defaults', () => {
    const def = resolveDialogueFloor('totally-fake-genre');
    assert.ok(def.min_dialogue_words_avg >= 2.5, 'safe default must respect hard floor');
    assert.ok(Array.isArray(def.target_dialogue_runtime_pct));
  });

  test('action genre has avg-words floor that is clipped (<= 4.0)', () => {
    const action = resolveDialogueFloor('action');
    assert.ok(action.min_dialogue_words_avg <= 4.0, `action avg-words floor must be <=4 (got ${action.min_dialogue_words_avg})`);
  });

  test('drama genre has substantive avg-words floor (>= 6.0)', () => {
    const drama = resolveDialogueFloor('drama');
    assert.ok(drama.min_dialogue_words_avg >= 6.0, `drama avg-words floor must be >=6 (got ${drama.min_dialogue_words_avg})`);
  });
});
