// tests/v4/Phase7StyleRouting.test.mjs
//
// V4 Phase 7 — style-routing predicates + non-photoreal LUT bypass + Director
// Agent commercial wiring. Covers:
//   1. NON_PHOTOREAL_STYLE_CATEGORIES + isNonPhotorealStyle + isStylizedStrong
//      against all 10 COMMERCIAL_STYLE_CATEGORIES values
//   2. generateLutFromStyleBrief identity-cube generation + sha256 cache hit
//   3. isStyleBypassLutId predicate + N7 genre-pool whitelist behavior
//   4. getStrengthForGenreWithStyle (0.10 override for non-photoreal)
//   5. DirectorAgent.judgeCommercial* methods exist + checkpoint labels
//   6. Commercial verdict schemas have the right dimension keys
//   7. resolveDirectorMode resolves the new commercial checkpoints
//      to the correct env flags
//
// Run with: node --test tests/v4/Phase7StyleRouting.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NON_PHOTOREAL_STYLE_CATEGORIES,
  STYLIZED_STRONG_STYLE_CATEGORIES,
  isNonPhotorealStyle,
  isStylizedStrong,
  resolveStyleCategory
} from '../../services/v4/CreativeBriefDirector.js';
import {
  COMMERCIAL_STYLE_CATEGORIES
} from '../../services/v4/director-rubrics/commercialReferenceLibrary.mjs';
import {
  generateLutFromStyleBrief,
  isStyleBypassLutId
} from '../../services/v4/GenerativeLut.js';
import {
  getStrengthForGenreWithStyle,
  getStrengthForGenre,
  isStyleBypassEnabled,
  resolveEpisodeLut
} from '../../services/v4/BrandKitLutMatcher.js';
import {
  DirectorAgent,
  CHECKPOINTS,
  resolveDirectorMode
} from '../../services/v4/DirectorAgent.js';
import {
  COMMERCIAL_SCREENPLAY_VERDICT_SCHEMA,
  COMMERCIAL_SCENE_MASTER_VERDICT_SCHEMA,
  COMMERCIAL_BEAT_VERDICT_SCHEMA
} from '../../services/v4/director-rubrics/verdictSchema.mjs';
import {
  COMMERCIAL_SCREENPLAY_DIMENSIONS
} from '../../services/v4/director-rubrics/commercialScreenplayRubric.mjs';
import {
  COMMERCIAL_SCENE_MASTER_DIMENSIONS
} from '../../services/v4/director-rubrics/commercialSceneMasterRubric.mjs';
import {
  COMMERCIAL_BEAT_DIMENSIONS
} from '../../services/v4/director-rubrics/commercialBeatRubric.mjs';
import { buildGenreRegisterHint } from '../../services/v4/director-rubrics/sharedHeader.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GENERATED_LUT_DIR = path.join(__dirname, '..', '..', 'assets', 'luts', 'generated');

// ─────────────────────────────────────────────────────────────────────
// 1. Style-routing predicates
// ─────────────────────────────────────────────────────────────────────

test('Phase 7 — NON_PHOTOREAL_STYLE_CATEGORIES contains exactly 4 entries', () => {
  assert.strictEqual(NON_PHOTOREAL_STYLE_CATEGORIES.length, 4);
  assert.ok(NON_PHOTOREAL_STYLE_CATEGORIES.includes('hand_doodle_animated'));
  assert.ok(NON_PHOTOREAL_STYLE_CATEGORIES.includes('surreal_dreamlike'));
  assert.ok(NON_PHOTOREAL_STYLE_CATEGORIES.includes('vaporwave_nostalgic'));
  assert.ok(NON_PHOTOREAL_STYLE_CATEGORIES.includes('painterly_prestige'));
});

test('Phase 7 — STYLIZED_STRONG_STYLE_CATEGORIES is the strict subset {hand_doodle_animated, surreal_dreamlike}', () => {
  assert.strictEqual(STYLIZED_STRONG_STYLE_CATEGORIES.length, 2);
  assert.ok(STYLIZED_STRONG_STYLE_CATEGORIES.includes('hand_doodle_animated'));
  assert.ok(STYLIZED_STRONG_STYLE_CATEGORIES.includes('surreal_dreamlike'));
  for (const c of STYLIZED_STRONG_STYLE_CATEGORIES) {
    assert.ok(NON_PHOTOREAL_STYLE_CATEGORIES.includes(c), `strong-stylized ${c} must also be non-photoreal`);
  }
});

test('Phase 7 — isNonPhotorealStyle covers all 10 style_category values correctly', () => {
  const expectedNonPhoto = new Set(NON_PHOTOREAL_STYLE_CATEGORIES);
  for (const cat of COMMERCIAL_STYLE_CATEGORIES) {
    const got = isNonPhotorealStyle({ style_category: cat });
    const expected = expectedNonPhoto.has(cat);
    assert.strictEqual(got, expected, `${cat}: expected isNonPhotorealStyle=${expected}, got ${got}`);
  }
});

test('Phase 7 — isStylizedStrong is true ONLY for hand_doodle_animated and surreal_dreamlike', () => {
  for (const cat of COMMERCIAL_STYLE_CATEGORIES) {
    const got = isStylizedStrong({ style_category: cat });
    const expected = cat === 'hand_doodle_animated' || cat === 'surreal_dreamlike';
    assert.strictEqual(got, expected, `${cat}: expected isStylizedStrong=${expected}, got ${got}`);
  }
});

test('Phase 7 — predicates accept either brief OR story.commercial_brief shape', () => {
  // Direct brief
  assert.ok(isStylizedStrong({ style_category: 'hand_doodle_animated' }));
  // Story shape (commercial_brief nested)
  assert.ok(isStylizedStrong({ commercial_brief: { style_category: 'hand_doodle_animated' } }));
  // Empty
  assert.ok(!isStylizedStrong(null));
  assert.ok(!isStylizedStrong({}));
  assert.ok(!isStylizedStrong({ commercial_brief: null }));
});

test('Phase 7 — resolveStyleCategory returns lowercase trimmed string or empty', () => {
  assert.strictEqual(resolveStyleCategory({ style_category: '  Hand_Doodle_Animated  ' }), 'hand_doodle_animated');
  assert.strictEqual(resolveStyleCategory({ commercial_brief: { style_category: 'SURREAL_DREAMLIKE' } }), 'surreal_dreamlike');
  assert.strictEqual(resolveStyleCategory(null), '');
  assert.strictEqual(resolveStyleCategory({}), '');
});

// ─────────────────────────────────────────────────────────────────────
// 2. generateLutFromStyleBrief
// ─────────────────────────────────────────────────────────────────────

test('Phase 7 — generateLutFromStyleBrief returns null for unknown style_category', async () => {
  const result = await generateLutFromStyleBrief({ style_category: 'not_a_style' });
  assert.strictEqual(result, null);
});

test('Phase 7 — generateLutFromStyleBrief produces gen_style_<hash>.cube for hand_doodle_animated (identity cube)', async () => {
  const result = await generateLutFromStyleBrief({
    style_category: 'hand_doodle_animated',
    visual_style_brief: 'cel-shaded portrait, Studio Ghibli aesthetic'
  });
  assert.ok(result, 'expected a result');
  assert.ok(result.lutId.startsWith('gen_style_'), `expected gen_style_ prefix, got ${result.lutId}`);
  assert.strictEqual(result.isStyleBypass, true);
  assert.strictEqual(result.styleCategory, 'hand_doodle_animated');
  assert.ok(fs.existsSync(result.filePath), `expected .cube on disk: ${result.filePath}`);

  // Identity cube — first non-comment line after TITLE/LUT_3D_SIZE/DOMAIN should be 0.0 0.0 0.0
  const cubeContent = fs.readFileSync(result.filePath, 'utf-8');
  const lines = cubeContent.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('TITLE') && !l.startsWith('LUT_3D_SIZE') && !l.startsWith('DOMAIN'));
  assert.ok(lines.length > 0, 'expected cube data lines');
  // First entry of an identity cube is (0,0,0)
  const firstParts = lines[0].trim().split(/\s+/).map(Number);
  assert.strictEqual(firstParts[0], 0, 'identity cube first R should be 0');
  assert.strictEqual(firstParts[1], 0, 'identity cube first G should be 0');
  assert.strictEqual(firstParts[2], 0, 'identity cube first B should be 0');
});

test('Phase 7 — generateLutFromStyleBrief is idempotent on cache hit', async () => {
  const first = await generateLutFromStyleBrief({
    style_category: 'vaporwave_nostalgic',
    visual_style_brief: 'magenta/teal duotone'
  });
  assert.ok(first);
  const mtime1 = fs.statSync(first.filePath).mtime;

  // Sleep a hair so mtime would differ if we re-wrote
  await new Promise(r => setTimeout(r, 50));

  const second = await generateLutFromStyleBrief({
    style_category: 'vaporwave_nostalgic',
    visual_style_brief: 'magenta/teal duotone'
  });
  assert.strictEqual(second.lutId, first.lutId, 'cache key must produce same id');
  const mtime2 = fs.statSync(second.filePath).mtime;
  assert.strictEqual(mtime1.getTime(), mtime2.getTime(), 'cached file should not be rewritten');
});

test('Phase 7 — different style_category → different lutId', async () => {
  const a = await generateLutFromStyleBrief({ style_category: 'hand_doodle_animated' });
  const b = await generateLutFromStyleBrief({ style_category: 'painterly_prestige' });
  assert.ok(a && b);
  assert.notStrictEqual(a.lutId, b.lutId, 'distinct styles must produce distinct LUT ids');
});

// ─────────────────────────────────────────────────────────────────────
// 3. isStyleBypassLutId + N7 whitelist behavior
// ─────────────────────────────────────────────────────────────────────

test('Phase 7 — isStyleBypassLutId recognizes gen_style_* ids', () => {
  assert.ok(isStyleBypassLutId('gen_style_abcd1234'));
  assert.ok(!isStyleBypassLutId('gen_abcd1234'));    // brand-palette LUT, not style bypass
  assert.ok(!isStyleBypassLutId('bs_commercial_hyperreal_punch'));
  assert.ok(!isStyleBypassLutId(null));
  assert.ok(!isStyleBypassLutId(''));
});

test('Phase 7 — resolveEpisodeLut whitelists gen_style_* ids (does NOT override to genre default)', () => {
  // Spec system on (default), commercial genre, gen_style_<hash> emitted by
  // matchByGenreAndMood. The N7 validator must NOT override to bs_commercial_*.
  const story = {
    subject: { genre: 'commercial' },
    storyline: {}
  };
  const episode = { lut_id: 'gen_style_test1234abcd' };
  const resolved = resolveEpisodeLut(story, episode);
  assert.strictEqual(resolved, 'gen_style_test1234abcd', 'gen_style_* must pass N7 whitelist');
});

// ─────────────────────────────────────────────────────────────────────
// 4. getStrengthForGenreWithStyle
// ─────────────────────────────────────────────────────────────────────

test('Phase 7 — getStrengthForGenreWithStyle returns 0.10 for non-photoreal styles', () => {
  // Commercial genre default is 0.25; non-photoreal force overrides to 0.10.
  assert.strictEqual(
    getStrengthForGenreWithStyle('commercial', { style_category: 'hand_doodle_animated' }),
    0.10
  );
  assert.strictEqual(
    getStrengthForGenreWithStyle('commercial', { style_category: 'surreal_dreamlike' }),
    0.10
  );
  assert.strictEqual(
    getStrengthForGenreWithStyle('drama', { style_category: 'hand_doodle_animated' }),
    0.10,
    'genre alone should not matter when style is non-photoreal'
  );
});

test('Phase 7 — getStrengthForGenreWithStyle falls through to GENRE_STRENGTH for photoreal styles', () => {
  // hyperreal_premium is photoreal → use commercial genre default (0.25).
  assert.strictEqual(
    getStrengthForGenreWithStyle('commercial', { style_category: 'hyperreal_premium' }),
    getStrengthForGenre('commercial')
  );
  // null brief → use genre default
  assert.strictEqual(
    getStrengthForGenreWithStyle('commercial', null),
    getStrengthForGenre('commercial')
  );
});

test('Phase 7 — isStyleBypassEnabled defaults true; respects BRAND_STORY_LUT_STYLE_BYPASS=false', () => {
  const saved = process.env.BRAND_STORY_LUT_STYLE_BYPASS;
  delete process.env.BRAND_STORY_LUT_STYLE_BYPASS;
  assert.strictEqual(isStyleBypassEnabled(), true, 'default ON');
  process.env.BRAND_STORY_LUT_STYLE_BYPASS = 'false';
  assert.strictEqual(isStyleBypassEnabled(), false);
  process.env.BRAND_STORY_LUT_STYLE_BYPASS = 'true';
  assert.strictEqual(isStyleBypassEnabled(), true);
  if (saved == null) delete process.env.BRAND_STORY_LUT_STYLE_BYPASS;
  else process.env.BRAND_STORY_LUT_STYLE_BYPASS = saved;
});

// ─────────────────────────────────────────────────────────────────────
// 5. DirectorAgent commercial methods + checkpoint labels
// ─────────────────────────────────────────────────────────────────────

test('Phase 7 — CHECKPOINTS includes commercial Lens A/B/C entries', () => {
  assert.strictEqual(CHECKPOINTS.COMMERCIAL_SCREENPLAY, 'commercial_screenplay');
  assert.strictEqual(CHECKPOINTS.COMMERCIAL_SCENE_MASTER, 'commercial_scene_master');
  assert.strictEqual(CHECKPOINTS.COMMERCIAL_BEAT, 'commercial_beat');
  // Phase 6 entries still there
  assert.strictEqual(CHECKPOINTS.COMMERCIAL_BRIEF, 'commercial_brief');
  assert.strictEqual(CHECKPOINTS.COMMERCIAL_EPISODE, 'commercial_episode');
});

test('Phase 7 — DirectorAgent exposes judgeCommercialScreenplay/SceneMaster/Beat', () => {
  const agent = new DirectorAgent();
  assert.strictEqual(typeof agent.judgeCommercialScreenplay, 'function');
  assert.strictEqual(typeof agent.judgeCommercialSceneMaster, 'function');
  assert.strictEqual(typeof agent.judgeCommercialBeat, 'function');
});

test('Phase 7 — resolveDirectorMode routes commercial checkpoints to their inherited env flag', () => {
  const saved = {
    agent: process.env.BRAND_STORY_DIRECTOR_AGENT,
    sm: process.env.BRAND_STORY_DIRECTOR_SCENE_MASTER,
    beat: process.env.BRAND_STORY_DIRECTOR_BEAT
  };
  delete process.env.BRAND_STORY_DIRECTOR_AGENT;
  process.env.BRAND_STORY_DIRECTOR_SCENE_MASTER = 'shadow';
  process.env.BRAND_STORY_DIRECTOR_BEAT = 'blocking';
  // Commercial Scene Master should inherit BRAND_STORY_DIRECTOR_SCENE_MASTER
  assert.strictEqual(resolveDirectorMode(CHECKPOINTS.COMMERCIAL_SCENE_MASTER), 'shadow');
  // Commercial Beat should inherit BRAND_STORY_DIRECTOR_BEAT
  assert.strictEqual(resolveDirectorMode(CHECKPOINTS.COMMERCIAL_BEAT), 'blocking');
  // Commercial Episode never blocks (downgrade to advisory)
  process.env.BRAND_STORY_DIRECTOR_EPISODE = 'blocking';
  assert.strictEqual(resolveDirectorMode(CHECKPOINTS.COMMERCIAL_EPISODE), 'advisory');

  // Restore
  for (const [k, v] of Object.entries({
    BRAND_STORY_DIRECTOR_AGENT: saved.agent,
    BRAND_STORY_DIRECTOR_SCENE_MASTER: saved.sm,
    BRAND_STORY_DIRECTOR_BEAT: saved.beat
  })) {
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
  delete process.env.BRAND_STORY_DIRECTOR_EPISODE;
});

// ─────────────────────────────────────────────────────────────────────
// 6. Commercial verdict schemas
// ─────────────────────────────────────────────────────────────────────

test('Phase 7 — COMMERCIAL_SCREENPLAY_VERDICT_SCHEMA has the expected dimensions', () => {
  const dims = COMMERCIAL_SCREENPLAY_VERDICT_SCHEMA.properties.dimension_scores.propertyOrdering;
  assert.deepStrictEqual([...dims].sort(), [...COMMERCIAL_SCREENPLAY_DIMENSIONS].sort());
  assert.ok(dims.includes('style_category_fidelity'));
  assert.ok(dims.includes('hook_first_1_5s'));
  assert.ok(dims.includes('anti_brief_adherence'));
  // Dropped prestige dimensions
  assert.ok(!dims.includes('subtext_density'));
  assert.ok(!dims.includes('dialogue_craft'));
  assert.ok(!dims.includes('story_spine'));
});

test('Phase 7 — COMMERCIAL_SCENE_MASTER_VERDICT_SCHEMA replaces genre_register_visual / lut_mood_fit', () => {
  const dims = COMMERCIAL_SCENE_MASTER_VERDICT_SCHEMA.properties.dimension_scores.propertyOrdering;
  assert.deepStrictEqual([...dims].sort(), [...COMMERCIAL_SCENE_MASTER_DIMENSIONS].sort());
  assert.ok(dims.includes('style_category_fidelity'));
  assert.ok(dims.includes('style_palette_fit'));
  assert.ok(dims.includes('visual_signature_consistency'));
  assert.ok(!dims.includes('genre_register_visual'));
  assert.ok(!dims.includes('lut_mood_fit'));
});

test('Phase 7 — COMMERCIAL_BEAT_VERDICT_SCHEMA replaces lighting_continuity / lens_continuity / identity_lock', () => {
  const dims = COMMERCIAL_BEAT_VERDICT_SCHEMA.properties.dimension_scores.propertyOrdering;
  assert.deepStrictEqual([...dims].sort(), [...COMMERCIAL_BEAT_DIMENSIONS].sort());
  assert.ok(dims.includes('art_direction_consistency'));
  assert.ok(dims.includes('framing_intent'));
  assert.ok(dims.includes('identity_lock_stylized'));
  assert.ok(!dims.includes('lighting_continuity'));
  assert.ok(!dims.includes('lens_continuity'));
  assert.ok(!dims.includes('identity_lock'));
});

test('Phase 7 — commercial Beat verdict schema target enum includes Phase 7 "style" + Fix 8 categories', () => {
  // Schema is shared — find the target enum on the remediation node.
  const targetEnum = COMMERCIAL_BEAT_VERDICT_SCHEMA
    .properties.findings.items.properties.remediation.properties.target.enum;
  for (const v of ['anchor', 'composition', 'performance', 'identity', 'continuity', 'style']) {
    assert.ok(targetEnum.includes(v), `expected target enum to include '${v}'`);
  }
});

// ─────────────────────────────────────────────────────────────────────
// 7. Commercial genre register hint (legacy path; library path tested
//    by existing GenreRegisterLibrary.test.mjs)
// ─────────────────────────────────────────────────────────────────────

test('Phase 7 — buildGenreRegisterHint emits commercial-aware hint for commercial focus', () => {
  // Force legacy path by disabling the library
  const saved = process.env.BRAND_STORY_GENRE_REGISTER_LIBRARY;
  process.env.BRAND_STORY_GENRE_REGISTER_LIBRARY = 'false';
  try {
    const hint = buildGenreRegisterHint('commercial');
    assert.ok(hint.includes('commercial'), 'hint must reference commercial register');
    assert.ok(/visual_signature/i.test(hint) || /tagline/i.test(hint) || /1\.5s/i.test(hint),
      'commercial hint must mention visual_signature / tagline / hook_first_1_5s');
  } finally {
    if (saved == null) delete process.env.BRAND_STORY_GENRE_REGISTER_LIBRARY;
    else process.env.BRAND_STORY_GENRE_REGISTER_LIBRARY = saved;
  }
});

// ─────────────────────────────────────────────────────────────────────
// 8. Sanity check — generated LUT directory exists (for cache hits to work)
// ─────────────────────────────────────────────────────────────────────

test('Phase 7 — GENERATED_LUT_DIR exists or is creatable', () => {
  if (!fs.existsSync(GENERATED_LUT_DIR)) {
    fs.mkdirSync(GENERATED_LUT_DIR, { recursive: true });
  }
  assert.ok(fs.existsSync(GENERATED_LUT_DIR));
});
