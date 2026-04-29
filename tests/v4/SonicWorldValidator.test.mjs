// tests/v4/SonicWorldValidator.test.mjs
// Phase 6 of the V4 audio coherence overhaul.
//
// Run: node --test tests/v4/SonicWorldValidator.test.mjs
//
// Locks the new ScreenplayValidator rules:
//   1. sonic_world structural integrity (base_palette + spectral_anchor required)
//   2. Bible inheritance (signature_drone in spectral_anchor; additive overlays)
//   3. Per-beat ambient_sound is FOLEY (no bed-phrasing words)
//   4. music_bed_intent respects bible no-fly list

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { validateScreenplay } from '../../services/v4/ScreenplayValidator.js';

const BASE_BIBLE = {
  signature_drone: { description: 'low industrial drone', frequency_band_hz: [40, 120], presence_dB: -22 },
  base_palette: { ambient_keywords: ['concrete', 'traffic'] },
  spectral_anchor: { description: 'sub-bass + air', always_present: true, level_dB: -18 },
  foley_density: 'naturalistic',
  score_under_dialogue: 'ducked_-18dB',
  silence_as_punctuation: 'load_bearing',
  diegetic_ratio: 0.7,
  transition_grammar: ['j_cut_dominant'],
  prohibited_instruments: ['orchestral_strings', 'synth_pads'],
  prohibited_tropes: ['sting_on_reveal'],
  prohibited_frequencies_hz: [],
  inheritance_policy: {
    grammar: 'immutable',
    no_fly_list: 'immutable',
    base_palette: 'overridable_with_justification',
    signature_drone: 'must_appear_at_least_once_per_episode'
  }
};

function basicSceneGraph(extra = {}) {
  return {
    title: 'T',
    dramatic_question: 'Q?',
    scenes: [
      {
        scene_id: 's1',
        hook_types: ['CRESCENDO'],
        opposing_intents: { '[0]': 'a', '[1]': 'b' },
        beats: [
          { beat_id: 's1b1', type: 'TALKING_HEAD_CLOSEUP', persona_index: 0, dialogue: 'You did this on purpose.', subtext: 'Y', duration_seconds: 4 },
          { beat_id: 's1b2', type: 'TALKING_HEAD_CLOSEUP', persona_index: 1, dialogue: 'I was hungry, Maya, that is all.', subtext: 'X', duration_seconds: 4 }
        ]
      }
    ],
    ...extra
  };
}

const PERSONAS = [{ name: 'A' }, { name: 'B' }];

describe('Phase 6 — checkSonicWorldStructure', () => {
  test('warns (not blocks) when no sonic_world AND no bible', () => {
    const sg = basicSceneGraph();
    const r = validateScreenplay(sg, {}, PERSONAS);
    const sw = r.issues.find(i => i.id === 'sonic_world_missing');
    assert.ok(sw, 'should emit sonic_world_missing warning');
    assert.equal(sw.severity, 'warning');
  });

  test('BLOCKS when no sonic_world AND a bible is locked', () => {
    const sg = basicSceneGraph();
    const r = validateScreenplay(sg, {}, PERSONAS, { sonicSeriesBible: BASE_BIBLE });
    const blocker = r.issues.find(i => i.id === 'sonic_world_missing_with_bible');
    assert.ok(blocker, 'should emit blocker when bible is present but episode has no sonic_world');
    assert.equal(blocker.severity, 'critical');
  });

  test('blocks when sonic_world.base_palette is missing', () => {
    const sg = basicSceneGraph({
      sonic_world: { spectral_anchor: 'sub-bass' }
    });
    const r = validateScreenplay(sg, {}, PERSONAS);
    assert.ok(r.issues.find(i => i.id === 'sonic_world_no_base_palette' && i.severity === 'critical'));
  });

  test('blocks when sonic_world.spectral_anchor is missing', () => {
    const sg = basicSceneGraph({
      sonic_world: { base_palette: 'industrial drone, traffic' }
    });
    const r = validateScreenplay(sg, {}, PERSONAS);
    assert.ok(r.issues.find(i => i.id === 'sonic_world_no_spectral_anchor' && i.severity === 'critical'));
  });

  test('warns on overlay referencing unknown scene_id', () => {
    const sg = basicSceneGraph({
      sonic_world: {
        base_palette: 'industrial drone, traffic',
        spectral_anchor: 'sub-bass + air',
        scene_variations: [
          { scene_id: 'doesnt_exist', overlay: 'wind', intensity: 0.5 }
        ]
      }
    });
    const r = validateScreenplay(sg, {}, PERSONAS);
    assert.ok(r.issues.find(i => i.id === 'sonic_world_overlay_unknown_scene'));
  });

  test('clean sonic_world with valid scene_variations passes', () => {
    const sg = basicSceneGraph({
      sonic_world: {
        base_palette: 'industrial drone, distant traffic',
        spectral_anchor: 'sustained 60-120Hz hum + faint air',
        scene_variations: [
          { scene_id: 's1', overlay: 'wind through concrete gaps', intensity: 0.7 }
        ]
      }
    });
    const r = validateScreenplay(sg, {}, PERSONAS);
    const swIssues = r.issues.filter(i => i.id.startsWith('sonic_world_'));
    assert.equal(swIssues.length, 0, `unexpected sonic_world issues: ${JSON.stringify(swIssues)}`);
  });
});

describe('Phase 6 — checkSonicWorldBibleInheritance', () => {
  test('warns when signature_drone band is not represented in spectral_anchor', () => {
    const sg = basicSceneGraph({
      sonic_world: {
        base_palette: 'sterile electrical hum, server fans',
        spectral_anchor: 'high frequency air movement only',
        scene_variations: []
      }
    });
    const r = validateScreenplay(sg, {}, PERSONAS, { sonicSeriesBible: BASE_BIBLE });
    assert.ok(r.issues.find(i => i.id === 'sonic_world_drone_not_in_anchor'));
  });

  test('passes when spectral_anchor explicitly mentions the drone band (e.g. 60-120Hz)', () => {
    const sg = basicSceneGraph({
      sonic_world: {
        base_palette: 'low industrial drone with concrete reverb',
        spectral_anchor: 'sustained 40-120Hz drone + faint 2-4kHz air',
        scene_variations: []
      }
    });
    const r = validateScreenplay(sg, {}, PERSONAS, { sonicSeriesBible: BASE_BIBLE });
    assert.ok(!r.issues.find(i => i.id === 'sonic_world_drone_not_in_anchor'));
  });

  test('passes when spectral_anchor has evidence terms (sub-bass, low-frequency, hum, drone)', () => {
    const sg = basicSceneGraph({
      sonic_world: {
        base_palette: 'low industrial drone, concrete reverb',
        spectral_anchor: 'sustained sub-bass anchor + faint air movement',
        scene_variations: []
      }
    });
    const r = validateScreenplay(sg, {}, PERSONAS, { sonicSeriesBible: BASE_BIBLE });
    assert.ok(!r.issues.find(i => i.id === 'sonic_world_drone_not_in_anchor'));
  });

  test('warns when overlay shares no vocabulary with base_palette (replacement, not additive)', () => {
    const sg = basicSceneGraph({
      sonic_world: {
        base_palette: 'low industrial drone, concrete reverb tail, distant traffic',
        spectral_anchor: 'sustained 40-120Hz drone',
        scene_variations: [
          // "sterile electrical hum" — no shared vocabulary with the industrial base
          { scene_id: 's1', overlay: 'sterile electrical hum, fluorescent ballast buzz', intensity: 0.6 }
        ]
      }
    });
    const r = validateScreenplay(sg, {}, PERSONAS, { sonicSeriesBible: BASE_BIBLE });
    assert.ok(r.issues.find(i => i.id === 'sonic_world_overlay_replaces_base'));
  });

  test('passes when overlay shares vocabulary with base (additive)', () => {
    const sg = basicSceneGraph({
      sonic_world: {
        base_palette: 'low industrial drone, concrete reverb tail, distant traffic',
        spectral_anchor: 'sustained 40-120Hz drone',
        scene_variations: [
          // shares "concrete" with the base — additive
          { scene_id: 's1', overlay: 'wind through concrete gaps', intensity: 0.7 }
        ]
      }
    });
    const r = validateScreenplay(sg, {}, PERSONAS, { sonicSeriesBible: BASE_BIBLE });
    assert.ok(!r.issues.find(i => i.id === 'sonic_world_overlay_replaces_base'));
  });
});

describe('Phase 6 — checkPerBeatAmbientSoundIsFoley', () => {
  test('warns on ambient_sound containing "drone"', () => {
    const sg = basicSceneGraph();
    sg.scenes[0].beats[0].ambient_sound = 'low industrial drone, room tone';
    const r = validateScreenplay(sg, {}, PERSONAS);
    assert.ok(r.issues.find(i => i.id === 'beat_ambient_sound_is_bed_material'));
  });

  test('warns on ambient_sound containing "ambient"', () => {
    const sg = basicSceneGraph();
    sg.scenes[0].beats[0].ambient_sound = 'ambient room tone';
    const r = validateScreenplay(sg, {}, PERSONAS);
    assert.ok(r.issues.find(i => i.id === 'beat_ambient_sound_is_bed_material'));
  });

  test('passes on clean Foley event (door click, glass clink)', () => {
    const sg = basicSceneGraph();
    sg.scenes[0].beats[0].ambient_sound = 'distinct metallic click of the latch';
    sg.scenes[0].beats[1].ambient_sound = 'soft glass clink against tile';
    const r = validateScreenplay(sg, {}, PERSONAS);
    assert.ok(!r.issues.find(i => i.id === 'beat_ambient_sound_is_bed_material'));
  });

  test('passes on no ambient_sound at all (dialogue beats can omit)', () => {
    const sg = basicSceneGraph();
    const r = validateScreenplay(sg, {}, PERSONAS);
    assert.ok(!r.issues.find(i => i.id === 'beat_ambient_sound_is_bed_material'));
  });
});

describe('Phase 6 — checkMusicBedRespectsNoFlyList', () => {
  test('blocks when music_bed_intent uses a prohibited instrument (snake_case)', () => {
    const sg = basicSceneGraph({
      music_bed_intent: 'soaring orchestral_strings building to a crescendo'
    });
    const r = validateScreenplay(sg, {}, PERSONAS, { sonicSeriesBible: BASE_BIBLE });
    assert.ok(r.issues.find(i => i.id === 'music_violates_no_fly_list' && i.severity === 'critical'));
  });

  test('blocks when music_bed_intent uses a prohibited instrument (human form)', () => {
    const sg = basicSceneGraph({
      music_bed_intent: 'soaring orchestral strings building to a crescendo'
    });
    const r = validateScreenplay(sg, {}, PERSONAS, { sonicSeriesBible: BASE_BIBLE });
    assert.ok(r.issues.find(i => i.id === 'music_violates_no_fly_list' && i.severity === 'critical'));
  });

  test('passes when music_bed_intent stays within bible', () => {
    const sg = basicSceneGraph({
      music_bed_intent: 'low brooding piano, sparse industrial percussion, sub-bass drones'
    });
    const r = validateScreenplay(sg, {}, PERSONAS, { sonicSeriesBible: BASE_BIBLE });
    assert.ok(!r.issues.find(i => i.id === 'music_violates_no_fly_list'));
  });

  test('no bible → no music check', () => {
    const sg = basicSceneGraph({
      music_bed_intent: 'lush orchestral strings'
    });
    const r = validateScreenplay(sg, {}, PERSONAS);
    assert.ok(!r.issues.find(i => i.id === 'music_violates_no_fly_list'));
  });
});

describe('Phase 6 — backward compatibility (legacy episodes still validate cleanly)', () => {
  test('a legacy episode with no sonic_world and no bible does NOT block', () => {
    const sg = basicSceneGraph();
    const r = validateScreenplay(sg, {}, PERSONAS);
    // sonic_world_missing is a warning, not a blocker, so needsPunchUp
    // depends on OTHER blockers (and there shouldn't be any in this sg).
    // The audio coherence rules should NOT be the thing that bricks legacy episodes.
    const audioBlockers = r.issues.filter(i =>
      i.severity === 'critical' && (i.id.startsWith('sonic_world_') || i.id.startsWith('music_'))
    );
    assert.equal(audioBlockers.length, 0, `legacy episode should not have audio blockers: ${JSON.stringify(audioBlockers)}`);
  });

  test('a legacy episode with per-scene ambient_bed_prompt still passes through (preserved by repair)', () => {
    const sg = basicSceneGraph();
    sg.scenes[0].ambient_bed_prompt = 'distant city rumble';
    const r = validateScreenplay(sg, {}, PERSONAS);
    assert.equal(r.repaired.scenes[0].ambient_bed_prompt, 'distant city rumble');
  });
});
