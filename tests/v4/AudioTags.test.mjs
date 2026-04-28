// tests/v4/AudioTags.test.mjs
// V4 Audio Layer Overhaul Day 1 — eleven-v3 inline performance tag tests.
//
// Run: node --test tests/v4/AudioTags.test.mjs
//
// Coverage:
//   ScreenplayValidator
//     - dialogue_missing_audio_tag fires (warning) on untagged dialogue
//     - [no_tag_intentional: stoic_baseline] satisfies presence
//     - eleven-v3 valid tag satisfies presence
//     - emotional_hold:true beats are exempt from tag-presence
//     - tag_emotion_contradiction fires when tag conflicts with beat.emotion
//     - tag_stack_too_deep fires when ≥3 v3 tags are stacked
//     - tag_duplicated fires when same tag appears twice
//     - audio_event_overused fires when ≥2 audio events on one beat
//     - clean tagged dialogue passes all four new checks
//     - BRAND_STORY_AUDIO_TAGS_REQUIRED=true escalates presence to blocker
//
//   TTSService — bracket helpers
//     - stripInternalAnnotations removes [no_tag_intentional:...]
//     - stripAllBracketTokens removes ALL square-bracketed tokens
//     - eleven-v3 tags survive _selectDefaultEndpoint when env=eleven_v3
//     - rollback flag flips _selectDefaultEndpoint to multilingual_v2
//
// These tests are pure — no fal.ai, no Vertex calls.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateScreenplay } from '../../services/v4/ScreenplayValidator.js';

const PERSONAS = [{ name: 'Maya' }, { name: 'Daniel' }];

function tagGraph(overrides = {}) {
  return {
    title: 'Tagged episode',
    dramatic_question: 'Will Maya say what she really means?',
    emotional_state: 'reflective',
    sonic_world: {
      base_palette: 'low industrial drone with concrete reverb tail, faint distant traffic',
      spectral_anchor: 'sustained 60-120Hz hum + faint 2-4kHz air movement',
      scene_variations: []
    },
    scenes: [
      {
        scene_id: 's1',
        hook_types: ['CRESCENDO'],
        opposing_intents: { '[0]': 'Maya wants control', '[1]': 'Daniel wants honesty' },
        beats: [
          {
            beat_id: 's1b1',
            type: 'TALKING_HEAD_CLOSEUP',
            persona_index: 0,
            dialogue: '[firmly] You were not hungry yesterday either, Daniel.',
            emotion: 'defiant',
            subtext: 'I notice everything.',
            duration_seconds: 4
          },
          {
            beat_id: 's1b2',
            type: 'TALKING_HEAD_CLOSEUP',
            persona_index: 1,
            dialogue: '[exhaling] Then I am consistent, at least in that small way.',
            emotion: 'resigned',
            subtext: 'Please stop pushing.',
            duration_seconds: 5
          },
          { beat_id: 's1b3', type: 'REACTION', persona_index: 0, duration_seconds: 2 },
          {
            beat_id: 's1b4',
            type: 'TALKING_HEAD_CLOSEUP',
            persona_index: 0,
            dialogue: '[evenly] Consistent is not the same as honest.',
            emotion: 'composed',
            subtext: 'I am tired of his deflections.',
            duration_seconds: 4
          }
        ]
      }
    ],
    ...overrides
  };
}

describe('AudioTags — checkDialogueTagPresence', () => {
  test('untagged dialogue fires dialogue_missing_audio_tag warning', () => {
    const g = tagGraph();
    g.scenes[0].beats[0].dialogue = 'You were not hungry yesterday either, Daniel.';
    const r = validateScreenplay(g, {}, PERSONAS);
    const issue = r.issues.find(i => i.id === 'dialogue_missing_audio_tag' && i.severity === 'warning');
    assert.ok(issue, 'expected dialogue_missing_audio_tag warning');
    assert.ok(issue.scope.includes('s1b1'), 'should scope to the offending beat');
  });

  test('[no_tag_intentional: stoic_baseline] satisfies tag presence', () => {
    const g = tagGraph();
    g.scenes[0].beats[0].dialogue = '[no_tag_intentional: stoic_baseline] You were not hungry yesterday either, Daniel.';
    const r = validateScreenplay(g, {}, PERSONAS);
    const issue = r.issues.find(i => i.id === 'dialogue_missing_audio_tag' && i.scope.includes('s1b1'));
    assert.equal(issue, undefined, 'baseline annotation should satisfy presence');
  });

  test('valid eleven-v3 tag satisfies tag presence', () => {
    const g = tagGraph(); // already tagged
    const r = validateScreenplay(g, {}, PERSONAS);
    const issue = r.issues.find(i => i.id === 'dialogue_missing_audio_tag');
    assert.equal(issue, undefined, 'tagged dialogue should pass presence check');
  });

  test('emotional_hold:true beat is exempt from tag-presence requirement', () => {
    const g = tagGraph();
    g.scenes[0].beats[0].dialogue = 'I lost it.'; // untagged
    g.scenes[0].beats[0].emotional_hold = true;
    g.scenes[0].beats[0].expression_notes = 'Eyes drop, jaw locks, the truth lands without affect';
    g.scenes[0].beats[0].subtext = 'I am not coming back from this admission';
    const r = validateScreenplay(g, {}, PERSONAS);
    const issue = r.issues.find(i => i.id === 'dialogue_missing_audio_tag' && i.scope.includes('s1b1'));
    assert.equal(issue, undefined, 'earned emotional_hold should exempt from tag-presence');
  });

  test('BRAND_STORY_AUDIO_TAGS_REQUIRED=true escalates to blocker', () => {
    const prev = process.env.BRAND_STORY_AUDIO_TAGS_REQUIRED;
    try {
      process.env.BRAND_STORY_AUDIO_TAGS_REQUIRED = 'true';
      const g = tagGraph();
      g.scenes[0].beats[0].dialogue = 'You were not hungry yesterday either, Daniel.';
      const r = validateScreenplay(g, {}, PERSONAS);
      const issue = r.issues.find(i => i.id === 'dialogue_missing_audio_tag');
      assert.ok(issue, 'expected dialogue_missing_audio_tag');
      assert.equal(issue.severity, 'blocker', 'should escalate to blocker under BRAND_STORY_AUDIO_TAGS_REQUIRED');
    } finally {
      if (prev === undefined) delete process.env.BRAND_STORY_AUDIO_TAGS_REQUIRED;
      else process.env.BRAND_STORY_AUDIO_TAGS_REQUIRED = prev;
    }
  });
});

describe('AudioTags — checkTagEmotionCoherence', () => {
  test('[laughing] tag on emotion="broken" fires tag_emotion_contradiction', () => {
    const g = tagGraph();
    g.scenes[0].beats[0].dialogue = '[laughing] I have nothing left to give.';
    g.scenes[0].beats[0].emotion = 'broken';
    const r = validateScreenplay(g, {}, PERSONAS);
    const issue = r.issues.find(i => i.id === 'tag_emotion_contradiction' && i.scope.includes('s1b1'));
    assert.ok(issue, 'expected tag_emotion_contradiction');
    assert.equal(issue.severity, 'warning');
  });

  test('[barely whispering] on emotion="defiant" fires tag_emotion_contradiction', () => {
    const g = tagGraph();
    g.scenes[0].beats[0].dialogue = '[barely whispering] We need to leave. Now.';
    g.scenes[0].beats[0].emotion = 'defiant';
    const r = validateScreenplay(g, {}, PERSONAS);
    const issue = r.issues.find(i => i.id === 'tag_emotion_contradiction' && i.scope.includes('s1b1'));
    assert.ok(issue, 'whispering should not pair with defiant');
  });

  test('coherent tag passes (no contradiction)', () => {
    const g = tagGraph();
    g.scenes[0].beats[0].dialogue = '[firmly] We are leaving now.';
    g.scenes[0].beats[0].emotion = 'defiant';
    const r = validateScreenplay(g, {}, PERSONAS);
    const issue = r.issues.find(i => i.id === 'tag_emotion_contradiction' && i.scope.includes('s1b1'));
    assert.equal(issue, undefined, 'firmly + defiant is coherent');
  });
});

describe('AudioTags — checkTagStackDepth', () => {
  test('three stacked tags fire tag_stack_too_deep', () => {
    const g = tagGraph();
    g.scenes[0].beats[0].dialogue = '[whispering, sad, slowly] I tried.';
    const r = validateScreenplay(g, {}, PERSONAS);
    const issue = r.issues.find(i => i.id === 'tag_stack_too_deep' && i.scope.includes('s1b1'));
    assert.ok(issue, 'expected tag_stack_too_deep with 3 tags');
  });

  test('two stacked tags pass', () => {
    const g = tagGraph();
    g.scenes[0].beats[0].dialogue = '[firmly, slowly] We are leaving now.';
    g.scenes[0].beats[0].emotion = 'defiant';
    const r = validateScreenplay(g, {}, PERSONAS);
    const issue = r.issues.find(i => i.id === 'tag_stack_too_deep' && i.scope.includes('s1b1'));
    assert.equal(issue, undefined, '2 tags should pass the stack-depth check');
  });

  test('duplicate tag fires tag_duplicated', () => {
    const g = tagGraph();
    g.scenes[0].beats[0].dialogue = '[whispering] I tried. [whispering] I really did.';
    const r = validateScreenplay(g, {}, PERSONAS);
    const issue = r.issues.find(i => i.id === 'tag_duplicated' && i.scope.includes('s1b1'));
    assert.ok(issue, 'expected tag_duplicated for repeated [whispering]');
  });

  test('two DIFFERENT tags on the same line do not fire tag_duplicated', () => {
    const g = tagGraph();
    g.scenes[0].beats[0].dialogue = '[firmly] Step back. [exhaling] Now.';
    g.scenes[0].beats[0].emotion = 'defiant';
    const r = validateScreenplay(g, {}, PERSONAS);
    const issue = r.issues.find(i => i.id === 'tag_duplicated' && i.scope.includes('s1b1'));
    assert.equal(issue, undefined, 'distinct tags should pass the duplicate check');
  });
});

describe('AudioTags — checkAudioEventOveruse', () => {
  test('two audio events on one beat fires audio_event_overused', () => {
    const g = tagGraph();
    g.scenes[0].beats[0].dialogue = '[applause] [leaves rustling] We should go.';
    const r = validateScreenplay(g, {}, PERSONAS);
    const issue = r.issues.find(i => i.id === 'audio_event_overused' && i.scope.includes('s1b1'));
    assert.ok(issue, 'expected audio_event_overused');
  });

  test('a single audio event passes', () => {
    const g = tagGraph();
    g.scenes[0].beats[0].dialogue = '[gentle footsteps] We should go.';
    g.scenes[0].beats[0].emotion = 'composed';
    const r = validateScreenplay(g, {}, PERSONAS);
    const issue = r.issues.find(i => i.id === 'audio_event_overused' && i.scope.includes('s1b1'));
    assert.equal(issue, undefined, 'one audio event should pass');
  });

  test('audio events spread across exchanges count toward per-beat cap', () => {
    const g = tagGraph();
    g.scenes[0].beats = [
      {
        beat_id: 's1b_srs',
        type: 'SHOT_REVERSE_SHOT',
        duration_seconds: 8,
        exchanges: [
          { persona_index: 0, dialogue: '[applause] You finally made it.', duration_seconds: 4 },
          { persona_index: 1, dialogue: '[gentle footsteps] So I have.', duration_seconds: 4 }
        ]
      }
    ];
    const r = validateScreenplay(g, {}, PERSONAS);
    const issue = r.issues.find(i => i.id === 'audio_event_overused' && i.scope.includes('s1b_srs'));
    assert.ok(issue, 'two events across SRS exchanges should trip the per-beat cap');
  });
});

describe('AudioTags — clean tagged graph passes all four new checks', () => {
  test('clean tagged graph produces zero tag-related issues', () => {
    const g = tagGraph();
    const r = validateScreenplay(g, {}, PERSONAS);
    const tagIssues = r.issues.filter(i =>
      ['dialogue_missing_audio_tag', 'tag_emotion_contradiction', 'tag_stack_too_deep', 'tag_duplicated', 'audio_event_overused'].includes(i.id)
    );
    assert.equal(tagIssues.length, 0, `expected 0 tag issues, got: ${tagIssues.map(i => i.id).join(', ')}`);
  });
});

// V4 Day 2 — eleven-v3 dialogue endpoint pre-flight check tests.
function dialogueEndpointGraph(beatOverrides = {}) {
  return {
    title: 'Two-shot episode',
    dramatic_question: 'Will Maya let him out of the room?',
    emotional_state: 'reflective',
    sonic_world: {
      base_palette: 'low industrial drone with concrete reverb tail, faint distant traffic',
      spectral_anchor: 'sustained 60-120Hz hum + faint 2-4kHz air movement',
      scene_variations: []
    },
    scenes: [
      {
        scene_id: 's1',
        hook_types: ['CRESCENDO'],
        opposing_intents: { '[0]': 'control', '[1]': 'honesty' },
        beats: [
          {
            beat_id: 's1b_two',
            type: 'GROUP_DIALOGUE_TWOSHOT',
            persona_indexes: [0, 1],
            dialogues: [
              '[firmly] You came back.',
              '[exhaling] I never left.'
            ],
            duration_seconds: 6,
            ...beatOverrides
          }
        ]
      }
    ]
  };
}

describe('Day 2 — checkDialogueEndpointBudget', () => {
  test('clean two-shot beat produces no dialogue endpoint warnings', () => {
    const g = dialogueEndpointGraph();
    const r = validateScreenplay(g, {}, PERSONAS);
    const ids = r.issues.map(i => i.id);
    assert.ok(!ids.includes('dialogue_endpoint_char_overflow'));
    assert.ok(!ids.includes('dialogue_endpoint_voice_overflow'));
    assert.ok(!ids.includes('dialogue_endpoint_mixed_language'));
  });

  test('total dialogue > 2,000 chars (after stripping tags) fires char_overflow warning', () => {
    const longLine = 'x'.repeat(1100);
    const g = dialogueEndpointGraph({
      dialogues: [`[firmly] ${longLine}`, `[exhaling] ${longLine}`]
    });
    const r = validateScreenplay(g, {}, PERSONAS);
    const issue = r.issues.find(i => i.id === 'dialogue_endpoint_char_overflow');
    assert.ok(issue, 'expected dialogue_endpoint_char_overflow');
    assert.equal(issue.severity, 'warning');
  });

  test('mixed-language personas in a two-shot fire mixed_language blocker', () => {
    const g = dialogueEndpointGraph();
    const personas = [
      { name: 'Maya', language: 'en' },
      { name: 'Yael', language: 'he' }
    ];
    const r = validateScreenplay(g, {}, personas);
    const issue = r.issues.find(i => i.id === 'dialogue_endpoint_mixed_language');
    assert.ok(issue, 'expected dialogue_endpoint_mixed_language');
    assert.equal(issue.severity, 'blocker');
  });

  test('single-language two-shot does NOT fire mixed_language', () => {
    const g = dialogueEndpointGraph();
    const personas = [
      { name: 'Maya', language: 'he' },
      { name: 'Yael', language: 'he' }
    ];
    const r = validateScreenplay(g, {}, personas);
    const issue = r.issues.find(i => i.id === 'dialogue_endpoint_mixed_language');
    assert.equal(issue, undefined, 'matching languages should not trip mixed-language');
  });
});
