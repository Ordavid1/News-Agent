// tests/v4/ClosingStateExtractor.test.mjs
//
// Unit tests for services/v4/ClosingStateExtractor.js.
//
// The Gemini multimodal call requires live Vertex credentials so it's not
// exercised here. These tests cover:
//   - Offline behavior (Vertex not configured → returns null)
//   - Beat-without-endframe behavior (returns null without attempting fetch)
//   - Schema enum surfaces (smoke check on EMOTIONAL_STATES, etc.)
//   - _normalize() backfill from authored beat.dialogue
//   - attachClosingStateToBeat() persona resolution + idempotency
//   - _buildContinuityFromPreviousBeat output shape (verbose + compact)
//
// Plus the public API surface to catch breakage on import-path renames.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractClosingState,
  attachClosingStateToBeat,
  _internals
} from '../../services/v4/ClosingStateExtractor.js';

import BaseBeatGenerator from '../../services/beat-generators/BaseBeatGenerator.js';

// Force the offline path by stripping Vertex credentials.
function withoutVertex(fn) {
  const saved = {
    GCP_PROJECT_ID: process.env.GCP_PROJECT_ID,
    GOOGLE_CLOUD_PROJECT_ID: process.env.GOOGLE_CLOUD_PROJECT_ID,
    GOOGLE_APPLICATION_CREDENTIALS_JSON: process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON,
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS
  };
  delete process.env.GCP_PROJECT_ID;
  delete process.env.GOOGLE_CLOUD_PROJECT_ID;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  return Promise.resolve(fn()).finally(() => {
    if (saved.GCP_PROJECT_ID !== undefined) process.env.GCP_PROJECT_ID = saved.GCP_PROJECT_ID;
    if (saved.GOOGLE_CLOUD_PROJECT_ID !== undefined) process.env.GOOGLE_CLOUD_PROJECT_ID = saved.GOOGLE_CLOUD_PROJECT_ID;
    if (saved.GOOGLE_APPLICATION_CREDENTIALS_JSON !== undefined) process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = saved.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (saved.GOOGLE_APPLICATION_CREDENTIALS !== undefined) process.env.GOOGLE_APPLICATION_CREDENTIALS = saved.GOOGLE_APPLICATION_CREDENTIALS;
  });
}

describe('ClosingStateExtractor — public API surface', () => {
  it('exports extractClosingState + attachClosingStateToBeat + _internals', () => {
    assert.equal(typeof extractClosingState, 'function');
    assert.equal(typeof attachClosingStateToBeat, 'function');
    assert.equal(typeof _internals, 'object');
  });

  it('exports schema enums via _internals', () => {
    assert.ok(Array.isArray(_internals.EMOTIONAL_STATES));
    assert.ok(Array.isArray(_internals.SUBJECT_POSITIONS));
    assert.ok(Array.isArray(_internals.ACTION_STATES));
    assert.ok(Array.isArray(_internals.EYELINE_TARGETS));
    assert.ok(Array.isArray(_internals.BREATH_STATES));
    // Every enum must include 'unspecified' as the safe default
    assert.ok(_internals.EMOTIONAL_STATES.includes('unspecified'));
    assert.ok(_internals.SUBJECT_POSITIONS.includes('unspecified'));
    assert.ok(_internals.ACTION_STATES.includes('unspecified'));
    assert.ok(_internals.EYELINE_TARGETS.includes('unspecified'));
    assert.ok(_internals.BREATH_STATES.includes('unspecified'));
  });

  it('exposes CLOSING_STATE_SCHEMA with required enum fields', () => {
    const schema = _internals.CLOSING_STATE_SCHEMA;
    assert.equal(schema.type, 'object');
    assert.ok(Array.isArray(schema.required));
    for (const field of [
      'closing_emotional_state',
      'closing_subject_position',
      'closing_action_state',
      'closing_eyeline_target',
      'breath_state'
    ]) {
      assert.ok(schema.required.includes(field), `schema must require ${field}`);
      assert.ok(schema.properties[field], `schema must have ${field}`);
      assert.equal(schema.properties[field].type, 'string');
      assert.ok(Array.isArray(schema.properties[field].enum), `${field} must have enum`);
    }
  });
});

describe('ClosingStateExtractor — offline / null-safe behavior', () => {
  it('returns null when beat is missing', async () => {
    const result = await extractClosingState({});
    assert.equal(result, null);
  });

  it('returns null when beat has no endframe_url', async () => {
    const result = await extractClosingState({ beat: { beat_id: 'b1' } });
    assert.equal(result, null);
  });

  it('returns null when Vertex Gemini is not configured (offline path)', async () => {
    await withoutVertex(async () => {
      const beat = { beat_id: 'b1', endframe_url: 'https://example.invalid/frame.jpg' };
      const result = await extractClosingState({ beat });
      assert.equal(result, null);
    });
  });
});

describe('ClosingStateExtractor — _normalize backfill from authored dialogue', () => {
  it('backfills last_dialogue_line from beat.dialogue when model omits it', () => {
    const parsed = {
      closing_emotional_state: 'guarded_resignation',
      closing_subject_position: 'frame_left_medium',
      closing_action_state: 'still_seated',
      closing_eyeline_target: 'camera_left_offscreen',
      breath_state: 'held'
      // no last_dialogue_line
    };
    const beat = { beat_id: 'b1', dialogue: 'I never said that. I never would.' };
    const out = _internals._normalize(parsed, beat);
    assert.ok(out);
    assert.ok(typeof out.last_dialogue_line === 'string');
    assert.ok(out.last_dialogue_line.length > 0);
    // Should contain the tail (not just empty string)
    assert.ok(out.last_dialogue_line.includes('never would'));
  });

  it('returns empty last_dialogue_line for non-dialogue beats', () => {
    const parsed = {
      closing_emotional_state: 'masked_calm',
      closing_subject_position: 'frame_center_close',
      closing_action_state: 'still_seated',
      closing_eyeline_target: 'downward_inward',
      breath_state: 'calm_steady'
    };
    const beat = { beat_id: 'b1', type: 'REACTION' };  // no dialogue, no voiceover
    const out = _internals._normalize(parsed, beat);
    assert.ok(out);
    assert.equal(out.last_dialogue_line, '');
  });

  it('backfills missing required enum fields with "unspecified"', () => {
    const parsed = { last_dialogue_line: 'hello' };  // all enums missing
    const out = _internals._normalize(parsed, { beat_id: 'b1' });
    assert.ok(out);
    assert.equal(out.closing_emotional_state, 'unspecified');
    assert.equal(out.closing_subject_position, 'unspecified');
    assert.equal(out.closing_action_state, 'unspecified');
    assert.equal(out.closing_eyeline_target, 'unspecified');
    assert.equal(out.breath_state, 'unspecified');
  });

  it('returns null on bad input', () => {
    assert.equal(_internals._normalize(null, {}), null);
    assert.equal(_internals._normalize('not-an-object', {}), null);
    assert.equal(_internals._normalize(undefined, {}), null);
  });
});

describe('ClosingStateExtractor — _inferMimeFromUrl', () => {
  it('infers image MIME from extension', () => {
    assert.equal(_internals._inferMimeFromUrl('https://x/y.jpg'), 'image/jpeg');
    assert.equal(_internals._inferMimeFromUrl('https://x/y.JPEG'), 'image/jpeg');
    assert.equal(_internals._inferMimeFromUrl('https://x/y.png'), 'image/png');
    assert.equal(_internals._inferMimeFromUrl('https://x/y.webp'), 'image/webp');
    assert.equal(_internals._inferMimeFromUrl('https://x/y.gif'), null);
    assert.equal(_internals._inferMimeFromUrl('https://x/y.jpg?token=foo'), 'image/jpeg');
  });
});

describe('attachClosingStateToBeat — persona resolution + idempotency', () => {
  it('returns without acting when beat has no endframe_url', async () => {
    const beat = { beat_id: 'b1' };
    await attachClosingStateToBeat({ beat, scene: null, personas: [] });
    assert.equal(beat.closing_state, undefined);
  });

  it('does not throw on offline Vertex (idempotent + safe)', async () => {
    await withoutVertex(async () => {
      const beat = { beat_id: 'b1', endframe_url: 'https://example.invalid/frame.jpg' };
      await attachClosingStateToBeat({ beat, scene: null, personas: [] });
      assert.equal(beat.closing_state, undefined);  // never set, no throw
    });
  });

  it('resolves persona from persona_index', async () => {
    // Cannot assert downstream call (Vertex offline) but the function must
    // not throw on a valid persona_index lookup.
    await withoutVertex(async () => {
      const beat = {
        beat_id: 'b1',
        endframe_url: 'https://example.invalid/frame.jpg',
        persona_index: 0
      };
      const personas = [{ name: 'Alice', dramatic_archetype: 'reluctant_hero' }];
      await attachClosingStateToBeat({ beat, scene: null, personas });
      // Just assert no throw + offline returns null path
      assert.equal(beat.closing_state, undefined);
    });
  });

  it('resolves persona from persona_indexes[0]', async () => {
    await withoutVertex(async () => {
      const beat = {
        beat_id: 'b1',
        endframe_url: 'https://example.invalid/frame.jpg',
        persona_indexes: [1, 2]
      };
      const personas = [
        { name: 'Alice' },
        { name: 'Bob' },
        { name: 'Carol' }
      ];
      await attachClosingStateToBeat({ beat, scene: null, personas });
      assert.equal(beat.closing_state, undefined);
    });
  });
});

describe('BaseBeatGenerator._buildContinuityFromPreviousBeat — output shape', () => {
  // Build a generator instance with no deps (we only need the helper)
  const gen = new BaseBeatGenerator({});

  it('returns empty string when previousBeat is missing', () => {
    assert.equal(gen._buildContinuityFromPreviousBeat(null), '');
    assert.equal(gen._buildContinuityFromPreviousBeat(undefined), '');
    assert.equal(gen._buildContinuityFromPreviousBeat({}), '');
  });

  it('returns empty string when closing_state is missing', () => {
    assert.equal(gen._buildContinuityFromPreviousBeat({ endframe_url: 'x' }), '');
  });

  it('returns empty string when every field is "unspecified" / empty', () => {
    const prev = {
      closing_state: {
        closing_emotional_state: 'unspecified',
        closing_subject_position: 'unspecified',
        closing_action_state: 'unspecified',
        closing_eyeline_target: 'unspecified',
        breath_state: 'unspecified',
        last_dialogue_line: ''
      }
    };
    assert.equal(gen._buildContinuityFromPreviousBeat(prev), '');
  });

  it('verbose mode produces a multi-line block with bullet markers', () => {
    const prev = {
      closing_state: {
        closing_emotional_state: 'guarded_resignation',
        closing_subject_position: 'frame_left_medium',
        closing_action_state: 'still_seated',
        closing_eyeline_target: 'camera_left_offscreen',
        breath_state: 'held',
        last_dialogue_line: 'I will consider it.'
      }
    };
    const out = gen._buildContinuityFromPreviousBeat(prev);
    assert.ok(out.length > 0);
    assert.ok(out.includes('CONTINUITY FROM PREVIOUS BEAT'));
    assert.ok(out.includes('guarded resignation'));
    assert.ok(out.includes('frame left medium'));
    assert.ok(out.includes('I will consider it'));
    assert.ok(out.includes('•'));  // bullet marker
  });

  it('compact mode produces a single-line summary <= 200 chars', () => {
    const prev = {
      closing_state: {
        closing_emotional_state: 'guarded_resignation',
        closing_subject_position: 'frame_left_medium',
        closing_action_state: 'still_seated',
        closing_eyeline_target: 'camera_left_offscreen',
        breath_state: 'held',
        last_dialogue_line: 'I will consider it.'
      }
    };
    const out = gen._buildContinuityFromPreviousBeat(prev, { mode: 'compact' });
    assert.ok(out.length > 0);
    assert.ok(out.length <= 200, `expected <=200 chars, got ${out.length}`);
    assert.ok(!out.includes('\n'), 'compact mode must be single-line');
    assert.ok(!out.includes('•'), 'compact mode must not use bullet markers');
    assert.ok(out.includes('guarded resignation'));
    assert.ok(out.includes('still seated'));
    assert.ok(out.includes('Continue from prior beat'));
  });

  it('compact mode survives Kling 512-char prompt budget for typical input', () => {
    // Sanity check: even with all enums populated, compact stays well under
    // the 480-char Kling soft budget (it has to share with framing + dialogue).
    const prev = {
      closing_state: {
        closing_emotional_state: 'building_anger',
        closing_subject_position: 'frame_center_medium',
        closing_action_state: 'about_to_speak',
        closing_eyeline_target: 'camera_direct',
        breath_state: 'short_quick'
      }
    };
    const out = gen._buildContinuityFromPreviousBeat(prev, { mode: 'compact' });
    assert.ok(out.length < 250, `compact expected <250 chars, got ${out.length}`);
  });

  it('skips fields that are "unspecified" in verbose output', () => {
    const prev = {
      closing_state: {
        closing_emotional_state: 'unspecified',
        closing_subject_position: 'frame_center_close',
        closing_action_state: 'unspecified',
        closing_eyeline_target: 'eyes_closed',
        breath_state: 'unspecified',
        last_dialogue_line: ''
      }
    };
    const out = gen._buildContinuityFromPreviousBeat(prev);
    // Only the two non-unspecified enums should surface
    assert.ok(out.includes('frame center close'));
    assert.ok(out.includes('eyes closed'));
    // Unspecified should NOT appear as text
    assert.ok(!out.includes('unspecified'));
  });
});

describe('BaseBeatGenerator._buildSceneAnchorDirective — scene context propagation', () => {
  const gen = new BaseBeatGenerator({});

  it('returns empty string when scene has no anchor / synopsis / sonic overlay', () => {
    assert.equal(gen._buildSceneAnchorDirective(null, null), '');
    assert.equal(gen._buildSceneAnchorDirective({}, null), '');
    assert.equal(gen._buildSceneAnchorDirective({ scene_id: 's1' }, {}), '');
  });

  it('compact mode produces a single-line directive when anchor is short', () => {
    const scene = {
      scene_id: 's1',
      scene_visual_anchor_prompt: 'Tungsten-warm dawn light through factory window. Steel-blue palette. Dust motes drift.'
    };
    const out = gen._buildSceneAnchorDirective(scene, null, { mode: 'compact' });
    assert.ok(out.length > 0);
    assert.ok(out.includes('Scene look:'));
    assert.ok(out.includes('Tungsten-warm dawn light'));
    assert.ok(!out.includes('\n'));
  });

  it('compact mode condenses long anchors while keeping cinematic signals', () => {
    const longAnchor = [
      'A wide industrial workshop at golden hour.',
      'The protagonist stands center-frame in faded denim.',
      'Tungsten practicals warm the foreground while cool blue daylight fills from behind.',
      'Silhouettes of machinery loom in the mid-ground.',
      'Camera holds at chest height with a slight rake.',
      'Air is thick with dust motes and smoke from a single welder offscreen.',
      'Color palette: warm amber + steel blue. Film stock: 16mm grain feel.'
    ].join(' ');
    const scene = { scene_id: 's1', scene_visual_anchor_prompt: longAnchor };
    const out = gen._buildSceneAnchorDirective(scene, null, { mode: 'compact' });
    // Should NOT include the full long anchor
    assert.ok(out.length < 300, `compact too long: ${out.length}`);
    // Should preserve cinematic signal — at least one of: light/golden/tungsten/blue/palette/film/grain
    assert.ok(/(light|tungsten|blue|palette|amber|film|grain|golden|practical)/i.test(out),
      `cinematic signals lost: ${out}`);
  });

  it('compact mode includes sonic overlay when episodeContext.sonic_world matches', () => {
    const scene = {
      scene_id: 's2',
      scene_visual_anchor_prompt: 'Soft daylight on a kitchen table. Warm wood, ceramic mug.'
    };
    const episodeContext = {
      sonic_world: {
        base_palette: 'low domestic murmur, fridge hum',
        scene_variations: [
          { scene_id: 's1', overlay: 'wrong scene' },
          { scene_id: 's2', overlay: 'kettle steam, single dripping faucet' }
        ]
      }
    };
    const out = gen._buildSceneAnchorDirective(scene, episodeContext, { mode: 'compact' });
    assert.ok(out.includes('Sonic register'));
    assert.ok(out.includes('kettle steam'));
    assert.ok(!out.includes('wrong scene'));
  });

  it('verbose mode surfaces the full anchor + episode bed + scene overlay', () => {
    const scene = {
      scene_id: 's1',
      scene_visual_anchor_prompt: 'Detailed DP brief here.'
    };
    const episodeContext = {
      sonic_world: {
        base_palette: 'distant city hum',
        scene_variations: [{ scene_id: 's1', overlay: 'rain on glass' }]
      }
    };
    const out = gen._buildSceneAnchorDirective(scene, episodeContext, { mode: 'verbose' });
    assert.ok(out.includes('SCENE LOOK & ATMOSPHERE'));
    assert.ok(out.includes('Detailed DP brief here'));
    assert.ok(out.includes('SCENE SONIC OVERLAY'));
    assert.ok(out.includes('distant city hum'));
    assert.ok(out.includes('rain on glass'));
  });

  it('falls back gracefully when scene_id has no matching sonic variation', () => {
    const scene = {
      scene_id: 's_unknown',
      scene_visual_anchor_prompt: 'Some anchor text.'
    };
    const episodeContext = {
      sonic_world: {
        scene_variations: [{ scene_id: 's_other', overlay: 'should not appear' }]
      }
    };
    const out = gen._buildSceneAnchorDirective(scene, episodeContext, { mode: 'compact' });
    assert.ok(out.includes('Scene look:'));
    assert.ok(!out.includes('Sonic register:'));
    assert.ok(!out.includes('should not appear'));
  });
});

describe('BaseBeatGenerator._buildDpDirective — structured DP fields', () => {
  const gen = new BaseBeatGenerator({});

  it('returns empty string when beat has no DP fields', () => {
    assert.equal(gen._buildDpDirective(null), '');
    assert.equal(gen._buildDpDirective({}), '');
    assert.equal(gen._buildDpDirective({ beat_id: 'b1', dialogue: 'hello' }), '');
  });

  it('emits "DP: <fields>" line when lens is set', () => {
    const out = gen._buildDpDirective({ lens: '85mm' });
    assert.equal(out, 'DP: 85mm.');
  });

  it('prefers explicit lens over focal_length_hint', () => {
    const out = gen._buildDpDirective({ lens: '85mm', focal_length_hint: '14mm' });
    assert.ok(out.includes('85mm'));
    assert.ok(!out.includes('14mm'));
  });

  it('falls back to focal_length_hint when lens absent', () => {
    const out = gen._buildDpDirective({ focal_length_hint: '24mm' });
    assert.ok(out.includes('24mm'));
  });

  it('joins all available structured fields in a single line', () => {
    const out = gen._buildDpDirective({
      lens: '50mm',
      coverage_slot: 'single_b',
      camera_temperament: 'locked',
      motion_vector: 'static',
      subject_presence: 'primary_in'
    });
    assert.ok(out.startsWith('DP: '));
    assert.ok(out.includes('50mm'));
    assert.ok(out.includes('single b'));
    assert.ok(out.includes('locked'));
    assert.ok(out.includes('static'));
    assert.ok(out.includes('subject primary in'));
    // Single line, no newlines
    assert.ok(!out.includes('\n'));
  });

  it('underscores in enum values are humanized', () => {
    const out = gen._buildDpDirective({ motion_vector: 'push_in' });
    assert.ok(out.includes('push in'));
    assert.ok(!out.includes('push_in'));
  });

  it('falls back to framing when coverage_slot is missing', () => {
    const out = gen._buildDpDirective({ framing: 'tight_closeup' });
    assert.ok(out.includes('tight closeup'));
  });

  it('output stays within Kling-friendly budget (<200 chars) for typical inputs', () => {
    const out = gen._buildDpDirective({
      lens: '85mm',
      coverage_slot: 'single_a',
      camera_temperament: 'handheld',
      motion_vector: 'drift_left',
      subject_presence: 'primary_in'
    });
    assert.ok(out.length < 200, `DP directive too long: ${out.length}`);
  });
});
