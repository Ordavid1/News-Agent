// tests/v4/SoundContinuity.test.mjs
// Regression tests for the V4 SFX / sound-stage continuity invariants.
//
// Run: node --test tests/v4/SoundContinuity.test.mjs
//
// Goal: guard the recent sound-stage work (per-beat ambient_sound, scene-level
// ambient_bed_prompt, universal 0.5s acrossfade on scene boundaries, cut→dissolve
// auto-upgrade for differing beds) against the Phase 3 screenplay changes
// (subtext routing, emotional_hold, pace_hint).
//
// Coverage:
//   1. V4 prompt still mandates scene.ambient_bed_prompt (MANDATORY)
//   2. V4 prompt still distinguishes ambient_bed_prompt (scene) from ambient_sound (beat)
//   3. SHOT_REVERSE_SHOT compiler carries subtext/pace_hint/emotional_hold to
//      children but does NOT inject any audio field (so scene ambient bed and
//      per-beat ambient_sound stay authoritative)
//   4. ScreenplayValidator does NOT flag or strip ambient/sound fields
//   5. Beat dialogue subtext doesn't leak into audio-adjacent fields

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { getEpisodeSystemPromptV4, getEpisodeUserPromptV4 } from '../../public/components/brandStoryPromptsV4.mjs';
import { ShotReverseShotCompiler } from '../../services/beat-generators/ShotReverseShotCompiler.js';
import { validateScreenplay } from '../../services/v4/ScreenplayValidator.js';

const STORYLINE = {
  title: 'Sound Continuity Probe',
  logline: 'T',
  genre: 'drama',
  tone: 'quiet',
  characters: [{ name: 'A' }, { name: 'B' }]
};
const PERSONAS = [
  { name: 'A', speech_patterns: { signature_line: 'Right.' } },
  { name: 'B', speech_patterns: { signature_line: 'Later.' } }
];

describe('Sound stage — V4 prompt teaches the new sonic_world architecture', () => {
  // Phase 3 of the V4 Audio Coherence Overhaul: per-scene ambient_bed_prompt
  // is replaced with an EPISODE-level sonic_world block (one bed for the whole
  // episode + scene_variations[] additive overlays). The viewer hears one
  // world, not a different bed per scene.

  test('episode-level sonic_world is taught as MANDATORY in user prompt', () => {
    const usr = getEpisodeUserPromptV4(STORYLINE, '', 1, {});
    assert.ok(usr.includes('EPISODE-LEVEL sonic_world'), 'Rule 13 should teach episode-level sonic_world');
    assert.ok(usr.includes('MANDATORY'));
    assert.ok(usr.includes('"sonic_world"'), 'sonic_world must appear in the JSON schema example');
    assert.ok(usr.includes('base_palette'), 'sonic_world.base_palette must be in the schema');
    assert.ok(usr.includes('spectral_anchor'), 'sonic_world.spectral_anchor must be in the schema');
    assert.ok(usr.includes('scene_variations'), 'sonic_world.scene_variations[] must be in the schema');
  });

  test('per-beat ambient_sound is re-scoped to Foley EVENTS only', () => {
    const usr = getEpisodeUserPromptV4(STORYLINE, '', 1, {});
    assert.ok(usr.includes('PER-BEAT ambient_sound DISCIPLINE'));
    assert.ok(usr.includes('Foley EVENTS only'), 'Rule 14 should re-scope ambient_sound to Foley');
    assert.ok(usr.includes('1-3s'), 'Foley clamp must be 1-3s');
  });

  test('scene-level ambient_bed_prompt is no longer in the schema example', () => {
    const usr = getEpisodeUserPromptV4(STORYLINE, '', 1, {});
    // The legacy per-scene field must NOT be in the example schema anymore —
    // it's been promoted to episode-level sonic_world.scene_variations[].overlay.
    // Note: the rule text itself may mention the legacy name for compat — we
    // only check it's gone from the JSON SCHEMA example block.
    const schemaSection = usr.split('OUTPUT JSON SCHEMA')[1] || '';
    assert.ok(!schemaSection.includes('"ambient_bed_prompt"'), 'legacy ambient_bed_prompt must not appear in the new schema example');
  });

  test('sonic_world appears at episode level (not per scene)', () => {
    const usr = getEpisodeUserPromptV4(STORYLINE, '', 1, {});
    const sonicIdx = usr.indexOf('"sonic_world"');
    const scenesIdx = usr.indexOf('"scenes":');
    assert.ok(sonicIdx > 0, 'sonic_world not found');
    assert.ok(scenesIdx > 0, 'scenes[] not found');
    assert.ok(sonicIdx < scenesIdx, 'sonic_world must render at the EPISODE level (before scenes[]) — not nested per scene');
  });

  test('transition_to_next no longer warns about ambient cliffs (sonic_world made cuts safe)', () => {
    const usr = getEpisodeUserPromptV4(STORYLINE, '', 1, {});
    assert.ok(usr.includes('transition_to_next'));
    // The new architecture means base_palette plays UNCUT across boundaries,
    // so 'cut' is now safe for sonic continuity. The rule must say so.
    assert.ok(usr.includes('cut') && (usr.includes('safe for sonic continuity') || usr.includes('plays UNCUT')),
      'transition rule should mention cut is now safe / base bed plays uncut');
  });

  test('system prompt still routes Gemini to per-beat Foley discipline', () => {
    const sys = getEpisodeSystemPromptV4(STORYLINE, [], PERSONAS, { costCapUsd: 20 });
    // Beat-type descriptions still reference ambient_sound for non-dialogue beats.
    assert.ok(sys.includes('ambient_sound'));
  });

  test('sonic series bible block injects when bible is provided', () => {
    const bible = {
      signature_drone: { description: 'low industrial drone', frequency_band_hz: [40, 120], presence_dB: -22 },
      base_palette: { ambient_keywords: ['concrete reverb', 'distant traffic'] },
      spectral_anchor: { description: 'sustained 60-120Hz', always_present: true, level_dB: -18 },
      foley_density: 'naturalistic',
      score_under_dialogue: 'ducked_-18dB',
      silence_as_punctuation: 'load_bearing',
      diegetic_ratio: 0.7,
      transition_grammar: ['j_cut_dominant'],
      prohibited_instruments: ['orchestral_strings'],
      prohibited_tropes: ['sting_on_reveal'],
      inheritance_policy: {
        grammar: 'immutable',
        no_fly_list: 'immutable',
        base_palette: 'overridable_with_justification',
        signature_drone: 'must_appear_at_least_once_per_episode'
      },
      reference_shows: ['severance_s1']
    };
    const sys = getEpisodeSystemPromptV4(STORYLINE, [], PERSONAS, { costCapUsd: 20, sonicSeriesBible: bible });
    assert.ok(sys.includes('SONIC SERIES BIBLE'), 'bible block should appear in system prompt when bible is provided');
    assert.ok(sys.includes('low industrial drone'), 'drone description should be rendered');
    assert.ok(sys.includes('orchestral_strings'), 'no-fly-list prohibitions should be rendered');
    assert.ok(sys.includes('must_appear_at_least_once_per_episode'), 'binding clause must be rendered');
  });

  test('sonic series bible block is empty when no bible is provided (legacy stories)', () => {
    const sys = getEpisodeSystemPromptV4(STORYLINE, [], PERSONAS, { costCapUsd: 20 });
    assert.ok(!sys.includes('SONIC SERIES BIBLE'), 'no bible header when sonicSeriesBible is null');
  });
});

describe('Sound stage — SHOT_REVERSE_SHOT compiler preserves audio authorship', () => {
  test('compiler does NOT inject ambient_sound or audio fields into child beats', () => {
    const parent = {
      beat_id: 's1b1',
      type: 'SHOT_REVERSE_SHOT',
      subtext: 'parent-level subtext',
      pace_hint: 'slow',
      emotional_hold: true,
      exchanges: [
        { persona_index: 0, dialogue: 'A speaks.', subtext: 'really means x', duration_seconds: 3 },
        { persona_index: 1, dialogue: 'B counters.', duration_seconds: 4 }
      ]
    };
    const children = ShotReverseShotCompiler.expandBeat(parent);
    assert.equal(children.length, 2);
    // Assert NO audio-level fields were injected by the compiler
    for (const child of children) {
      assert.equal(child.ambient_sound, undefined, 'compiler must not synthesize ambient_sound');
      assert.equal(child.ambient_bed_prompt, undefined, 'scene-level beds must not leak to child beats');
      assert.equal(child.voiceover_text, undefined, 'compiler must not synthesize voiceover');
    }
  });

  test('compiler propagates dramatic metadata (subtext/pace/hold) to children', () => {
    const parent = {
      beat_id: 's1b1',
      type: 'SHOT_REVERSE_SHOT',
      subtext: 'parent-level',
      pace_hint: 'slow',
      emotional_hold: true,
      exchanges: [
        { persona_index: 0, dialogue: 'A.', subtext: 'exchange-level', duration_seconds: 3 },
        { persona_index: 1, dialogue: 'B.', duration_seconds: 3 }
      ]
    };
    const children = ShotReverseShotCompiler.expandBeat(parent);
    // Exchange-level subtext wins on first child
    assert.equal(children[0].subtext, 'exchange-level');
    // Parent-level subtext falls through on second child (no exchange subtext)
    assert.equal(children[1].subtext, 'parent-level');
    // Parent pace_hint / emotional_hold fall through to every child
    assert.equal(children[0].pace_hint, 'slow');
    assert.equal(children[0].emotional_hold, true);
    assert.equal(children[1].pace_hint, 'slow');
    assert.equal(children[1].emotional_hold, true);
  });
});

describe('Sound stage — validator does not disturb audio fields (legacy + new)', () => {
  // After Phase 3 the V4 prompt no longer EMITS scene.ambient_bed_prompt — it
  // emits episode-level sonic_world instead. But the validator still preserves
  // the legacy field as a passthrough so episodes generated BEFORE Phase 3 can
  // still re-assemble. Phase 6 will add a warning (not strip) for legacy fields.
  test('validator preserves legacy scene ambient_bed_prompt as passthrough (backward-compat)', () => {
    const sg = {
      title: 'T',
      dramatic_question: 'Q?',
      scenes: [{
        scene_id: 's1',
        hook_types: ['CRESCENDO'],
        ambient_bed_prompt: 'distant city rumble, muffled bass, wind through cables',
        opposing_intents: { '[0]': 'a', '[1]': 'b' },
        beats: [
          { beat_id: 's1b1', type: 'TALKING_HEAD_CLOSEUP', persona_index: 0, dialogue: 'You were not hungry yesterday either.', subtext: 'A', duration_seconds: 4 },
          { beat_id: 's1b2', type: 'TALKING_HEAD_CLOSEUP', persona_index: 1, dialogue: 'Then I am consistent in that at least.', subtext: 'B', duration_seconds: 4 }
        ]
      }]
    };
    const r = validateScreenplay(sg, {}, [{ name: 'A' }, { name: 'B' }]);
    assert.equal(r.repaired.scenes[0].ambient_bed_prompt, 'distant city rumble, muffled bass, wind through cables');
  });

  test('validator preserves per-beat ambient_sound on the repaired scene graph', () => {
    const sg = {
      title: 'T',
      dramatic_question: 'Q?',
      scenes: [{
        scene_id: 's1',
        hook_types: ['REVELATION'],
        beats: [
          { beat_id: 's1b1', type: 'B_ROLL_ESTABLISHING', duration_seconds: 3, ambient_sound: 'soft glass clink' },
          { beat_id: 's1b2', type: 'INSERT_SHOT', duration_seconds: 3, ambient_sound: 'metallic click of the latch' }
        ]
      }]
    };
    const r = validateScreenplay(sg, {}, []);
    assert.equal(r.repaired.scenes[0].beats[0].ambient_sound, 'soft glass clink');
    assert.equal(r.repaired.scenes[0].beats[1].ambient_sound, 'metallic click of the latch');
  });

  test('validator preserves scene transition_to_next (default-dissolve semantics intact)', () => {
    const sg = {
      title: 'T',
      dramatic_question: 'Q?',
      scenes: [
        { scene_id: 's1', hook_types: ['CRESCENDO'], transition_to_next: 'dissolve', beats: [
          { beat_id: 's1b1', type: 'B_ROLL_ESTABLISHING', duration_seconds: 3 }
        ] },
        { scene_id: 's2', hook_types: ['REVELATION'], transition_to_next: 'cut', beats: [
          { beat_id: 's2b1', type: 'B_ROLL_ESTABLISHING', duration_seconds: 3 }
        ] }
      ]
    };
    const r = validateScreenplay(sg, {}, []);
    assert.equal(r.repaired.scenes[0].transition_to_next, 'dissolve');
    assert.equal(r.repaired.scenes[1].transition_to_next, 'cut');
  });
});

describe('Sound stage — subtext routing stays in visual direction only', () => {
  test('subtext field is documented as NOT output to viewer (voice/audio path unchanged)', () => {
    const sys = getEpisodeSystemPromptV4(STORYLINE, [], PERSONAS, { costCapUsd: 20 });
    assert.ok(sys.includes('It is NOT output'));
    // The masterclass explicitly instructs TTS to stay neutral to subtext ("Gemini does not output this to the viewer")
    assert.ok(sys.includes('expression_notes'));
  });
});
