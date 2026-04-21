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

describe('Sound stage — V4 prompt still teaches ambient bed + per-beat SFX', () => {
  test('scene ambient_bed_prompt is still marked MANDATORY in user prompt', () => {
    const usr = getEpisodeUserPromptV4(STORYLINE, '', 1, {});
    assert.ok(usr.includes('SCENE-LEVEL AMBIENT BED'));
    assert.ok(usr.includes('MANDATORY'));
    assert.ok(usr.includes('ambient_bed_prompt'));
  });

  test('per-beat ambient_sound discipline still in the user prompt', () => {
    const usr = getEpisodeUserPromptV4(STORYLINE, '', 1, {});
    assert.ok(usr.includes('PER-BEAT ambient_sound DISCIPLINE'));
    assert.ok(usr.includes('FOREGROUND events'));
  });

  test('transition_to_next default-to-dissolve rule still in the user prompt', () => {
    const usr = getEpisodeUserPromptV4(STORYLINE, '', 1, {});
    assert.ok(usr.includes('transition_to_next'));
    assert.ok(usr.includes('DEFAULT TO \'dissolve\''));
    assert.ok(usr.includes('acrossfade'));
  });

  test('scene schema example still surfaces ambient_bed_prompt BEFORE beats[]', () => {
    const usr = getEpisodeUserPromptV4(STORYLINE, '', 1, {});
    const bedIdx = usr.indexOf('"ambient_bed_prompt"');
    const beatsIdx = usr.indexOf('"beats":');
    assert.ok(bedIdx > 0, 'ambient_bed_prompt not found in example');
    assert.ok(beatsIdx > 0, 'beats[] not found in example');
    assert.ok(bedIdx < beatsIdx, 'ambient_bed_prompt must render before beats[] in example schema');
  });

  test('system prompt still routes Gemini to ambient discipline', () => {
    const sys = getEpisodeSystemPromptV4(STORYLINE, [], PERSONAS, { costCapUsd: 20 });
    // The system prompt references ambient per-beat guidance at the beat-type
    // descriptions (B_ROLL / INSERT_SHOT / ACTION carry ambient_sound fields).
    assert.ok(sys.includes('ambient_sound'));
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

describe('Sound stage — validator does not disturb audio fields', () => {
  test('validator preserves scene ambient_bed_prompt on the repaired scene graph', () => {
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
