// tests/v4/ScreenplayValidator.test.mjs
// Deterministic unit tests for the V4 screenplay quality gate Layer-1 validator.
//
// Run: node --test tests/v4/ScreenplayValidator.test.mjs
//
// Coverage:
//   - missing dramatic_question → blocker
//   - missing hook_types on a scene → blocker
//   - 2+ person dialogue scene w/o opposing_intents → blocker
//   - voice overlap between two characters in same scene → blocker
//   - sub-threshold dialogue beat ratio → blocker
//   - sub-threshold avg dialogue words → blocker
//   - low subtext coverage → warning (not blocker)
//   - too many bare short lines → warning
//   - intensity ramp drop → warning
//   - beat sizing out of tolerance → auto-repair (duration clamped 3-8)
//   - clean scene graph produces 0 blockers
//   - landscape story_focus skips dialogue-beat-ratio check

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { validateScreenplay, THRESHOLDS } from '../../services/v4/ScreenplayValidator.js';

const PERSONAS = [{ name: 'Maya' }, { name: 'Daniel' }];

function cleanGraph(overrides = {}) {
  return {
    title: 'Clean episode',
    dramatic_question: 'Will Maya keep the shop?',
    emotional_state: 'reflective',
    scenes: [
      {
        scene_id: 's1',
        hook_types: ['CRESCENDO'],
        opposing_intents: { '[0]': 'Maya wants control', '[1]': 'Daniel wants honesty' },
        beats: [
          { beat_id: 's1b1', type: 'TALKING_HEAD_CLOSEUP', persona_index: 0, dialogue: 'You were not hungry yesterday either, Daniel.', subtext: 'I notice everything.', duration_seconds: 4 },
          { beat_id: 's1b2', type: 'TALKING_HEAD_CLOSEUP', persona_index: 1, dialogue: 'Then I am consistent, at least in that small way.', subtext: 'Please stop pushing.', duration_seconds: 5 },
          { beat_id: 's1b3', type: 'REACTION', persona_index: 0, duration_seconds: 2 },
          { beat_id: 's1b4', type: 'TALKING_HEAD_CLOSEUP', persona_index: 0, dialogue: 'Consistent is not the same as honest.', subtext: 'I am tired of his deflections.', duration_seconds: 4 }
        ]
      }
    ],
    ...overrides
  };
}

describe('ScreenplayValidator — blocker checks', () => {
  test('missing dramatic_question produces blocker', () => {
    const g = cleanGraph();
    delete g.dramatic_question;
    const r = validateScreenplay(g, {}, PERSONAS);
    assert.ok(r.issues.find(i => i.id === 'missing_episode_dramatic_question' && i.severity === 'blocker'));
    assert.equal(r.needsPunchUp, true);
  });

  test('missing hook_types on scene produces blocker', () => {
    const g = cleanGraph();
    delete g.scenes[0].hook_types;
    const r = validateScreenplay(g, {}, PERSONAS);
    assert.ok(r.issues.find(i => i.id === 'scene_missing_hook_types' && i.severity === 'blocker'));
  });

  test('multi-persona scene without opposing_intents produces blocker', () => {
    const g = cleanGraph();
    delete g.scenes[0].opposing_intents;
    const r = validateScreenplay(g, {}, PERSONAS);
    assert.ok(r.issues.find(i => i.id === 'scene_missing_opposing_intents' && i.severity === 'blocker'));
  });

  test('single-persona scene is EXEMPT from opposing_intents requirement', () => {
    const g = cleanGraph();
    // Remove persona 1's lines so only persona 0 speaks
    g.scenes[0].beats = [
      { beat_id: 's1b1', type: 'TALKING_HEAD_CLOSEUP', persona_index: 0, dialogue: 'Everything you trusted about this place was a lie.', subtext: 'Including me.', duration_seconds: 5 },
      { beat_id: 's1b2', type: 'REACTION', persona_index: 0, duration_seconds: 2 }
    ];
    delete g.scenes[0].opposing_intents;
    const r = validateScreenplay(g, {}, PERSONAS);
    assert.ok(!r.issues.find(i => i.id === 'scene_missing_opposing_intents'));
  });

  test('voice overlap between two characters in same scene produces blocker', () => {
    // Both characters use the same vocabulary → > 60% token overlap
    const g = cleanGraph();
    g.scenes[0].beats = [
      { beat_id: 's1b1', type: 'TALKING_HEAD_CLOSEUP', persona_index: 0, dialogue: 'The coffee shop was beautiful that morning.', subtext: '—', duration_seconds: 4 },
      { beat_id: 's1b2', type: 'TALKING_HEAD_CLOSEUP', persona_index: 1, dialogue: 'The coffee shop was beautiful that morning.', subtext: '—', duration_seconds: 4 }
    ];
    const r = validateScreenplay(g, {}, PERSONAS);
    assert.ok(r.issues.find(i => i.id === 'voice_overlap_too_high' && i.severity === 'blocker'));
  });

  test('dialogue beat ratio below 35% (with 2+ personas, product focus) produces blocker', () => {
    const g = cleanGraph();
    g.scenes[0].beats = [
      { beat_id: 's1b1', type: 'B_ROLL_ESTABLISHING', duration_seconds: 3 },
      { beat_id: 's1b2', type: 'B_ROLL_ESTABLISHING', duration_seconds: 3 },
      { beat_id: 's1b3', type: 'INSERT_SHOT', duration_seconds: 3 },
      { beat_id: 's1b4', type: 'REACTION', persona_index: 0, duration_seconds: 2 },
      { beat_id: 's1b5', type: 'TALKING_HEAD_CLOSEUP', persona_index: 0, dialogue: 'You were not hungry yesterday either.', subtext: '—', duration_seconds: 4 },
      { beat_id: 's1b6', type: 'TALKING_HEAD_CLOSEUP', persona_index: 1, dialogue: 'Then I am consistent, I suppose.', subtext: '—', duration_seconds: 4 }
    ];
    const r = validateScreenplay(g, {}, PERSONAS);
    assert.ok(r.issues.find(i => i.id === 'dialogue_beat_ratio_too_low' && i.severity === 'blocker'));
  });

  test('landscape focus is EXEMPT from dialogue-beat-ratio check', () => {
    const g = cleanGraph();
    g.scenes[0].beats = [
      { beat_id: 's1b1', type: 'B_ROLL_ESTABLISHING', duration_seconds: 3 },
      { beat_id: 's1b2', type: 'INSERT_SHOT', duration_seconds: 3 },
      { beat_id: 's1b3', type: 'TALKING_HEAD_CLOSEUP', persona_index: 0, dialogue: 'The light on the water is different here.', subtext: '—', duration_seconds: 5 }
    ];
    delete g.scenes[0].opposing_intents; // only 1 persona
    const r = validateScreenplay(g, {}, PERSONAS, { storyFocus: 'landscape' });
    assert.ok(!r.issues.find(i => i.id === 'dialogue_beat_ratio_too_low'));
  });

  test('avg dialogue words below 6 produces blocker', () => {
    const g = cleanGraph();
    g.scenes[0].beats = [
      { beat_id: 's1b1', type: 'TALKING_HEAD_CLOSEUP', persona_index: 0, dialogue: 'Hi.', duration_seconds: 4 },
      { beat_id: 's1b2', type: 'TALKING_HEAD_CLOSEUP', persona_index: 1, dialogue: 'Hi.', duration_seconds: 4 },
      { beat_id: 's1b3', type: 'TALKING_HEAD_CLOSEUP', persona_index: 0, dialogue: 'Bye now.', duration_seconds: 4 }
    ];
    const r = validateScreenplay(g, {}, PERSONAS);
    assert.ok(r.issues.find(i => i.id === 'dialogue_too_sparse' && i.severity === 'blocker'));
  });
});

describe('ScreenplayValidator — warnings', () => {
  test('low subtext coverage produces warning only', () => {
    const g = cleanGraph();
    g.scenes[0].beats.forEach(b => { delete b.subtext; });
    const r = validateScreenplay(g, {}, PERSONAS);
    const subtextIssue = r.issues.find(i => i.id === 'subtext_coverage_low');
    assert.ok(subtextIssue);
    assert.equal(subtextIssue.severity, 'warning');
  });

  test('many bare short lines without emotional_hold produces warning', () => {
    const g = cleanGraph();
    g.scenes[0].beats = [
      { beat_id: 's1b1', type: 'TALKING_HEAD_CLOSEUP', persona_index: 0, dialogue: 'Go now.', duration_seconds: 3 },
      { beat_id: 's1b2', type: 'TALKING_HEAD_CLOSEUP', persona_index: 1, dialogue: 'I cannot.', duration_seconds: 3 },
      { beat_id: 's1b3', type: 'TALKING_HEAD_CLOSEUP', persona_index: 0, dialogue: 'Why not?', duration_seconds: 3 },
      { beat_id: 's1b4', type: 'TALKING_HEAD_CLOSEUP', persona_index: 1, dialogue: 'Not safe.', duration_seconds: 3 }
    ];
    const r = validateScreenplay(g, {}, PERSONAS);
    const warn = r.issues.find(i => i.id === 'too_many_bare_short_lines');
    assert.ok(warn);
    assert.equal(warn.severity, 'warning');
  });

  test('bare short lines marked emotional_hold are NOT counted', () => {
    const g = cleanGraph();
    g.scenes[0].beats = [
      { beat_id: 's1b1', type: 'TALKING_HEAD_CLOSEUP', persona_index: 0, dialogue: 'Go now.', emotional_hold: true, duration_seconds: 3 },
      { beat_id: 's1b2', type: 'TALKING_HEAD_CLOSEUP', persona_index: 1, dialogue: 'I cannot.', emotional_hold: true, duration_seconds: 3 },
      { beat_id: 's1b3', type: 'TALKING_HEAD_CLOSEUP', persona_index: 0, dialogue: 'Why not?', emotional_hold: true, duration_seconds: 3 }
    ];
    const r = validateScreenplay(g, {}, PERSONAS);
    assert.ok(!r.issues.find(i => i.id === 'too_many_bare_short_lines'));
  });

  test('intensity ramp drop from prior ep 8 → this ep "calm" produces warning', () => {
    const g = cleanGraph({ emotional_state: 'calm, resolved' });
    const storyline = { emotional_intensity_ledger: { '1': 8 } };
    const r = validateScreenplay(g, storyline, PERSONAS);
    const warn = r.issues.find(i => i.id === 'intensity_ramp_drop');
    assert.ok(warn);
    assert.equal(warn.severity, 'warning');
  });
});

describe('ScreenplayValidator — auto-repair', () => {
  test('under-sized beat (3 words in an 8s beat) is clamped', () => {
    const g = cleanGraph();
    g.scenes[0].beats = [
      { beat_id: 's1b1', type: 'TALKING_HEAD_CLOSEUP', persona_index: 0, dialogue: 'You knew this would happen.', subtext: '—', duration_seconds: 8 }, // 5 words, should be ~2-3s
      { beat_id: 's1b2', type: 'TALKING_HEAD_CLOSEUP', persona_index: 1, dialogue: 'I never believed any of this until tonight, not really.', subtext: '—', duration_seconds: 5 }
    ];
    const r = validateScreenplay(g, {}, PERSONAS);
    const autoFixed = r.issues.find(i => i.id === 'beat_sizing_auto_repaired');
    assert.ok(autoFixed);
    // First beat's 8s duration should be clamped down (5 words / 2.3 ≈ 2.2s, clamped to 3s)
    assert.equal(r.repaired.scenes[0].beats[0].duration_seconds, 3);
  });

  test('emotional_hold beats are NEVER auto-repaired', () => {
    const g = cleanGraph();
    g.scenes[0].beats = [
      { beat_id: 's1b1', type: 'TALKING_HEAD_CLOSEUP', persona_index: 0, dialogue: 'Hands.', emotional_hold: true, duration_seconds: 6 },
      { beat_id: 's1b2', type: 'TALKING_HEAD_CLOSEUP', persona_index: 1, dialogue: 'I already have my hands up above my head, please do not shoot.', subtext: '—', duration_seconds: 7 }
    ];
    const r = validateScreenplay(g, {}, PERSONAS);
    assert.equal(r.repaired.scenes[0].beats[0].duration_seconds, 6);
  });

  test('SHOT_REVERSE_SHOT exchange durations are repaired per-exchange', () => {
    // Bug 7 regression: a 4-word exchange on a 3s child beat hit the TTS
    // speed clamp. The repair must see each exchange independently, not
    // the aggregate word count of all exchanges in the SRS beat.
    const g = cleanGraph();
    g.scenes[0].beats = [
      {
        beat_id: 's1b1',
        type: 'SHOT_REVERSE_SHOT',
        exchanges: [
          { persona_index: 0, dialogue: 'You will not survive this.', duration_seconds: 3 }, // 5 words at 3s → ratio 0.72 within tolerance, no repair
          { persona_index: 1, dialogue: 'Try me.', duration_seconds: 6 }  // 2 words at 6s → ratio 0.14, must be repaired
        ]
      }
    ];
    const r = validateScreenplay(g, {}, PERSONAS);
    const repaired = r.repaired.scenes[0].beats[0];
    assert.equal(repaired.exchanges[1].duration_seconds, 3, 'under-sized exchange should clamp to 3s');
    assert.ok(r.issues.find(i => i.id === 'beat_sizing_auto_repaired'), 'beat_sizing_auto_repaired issue should fire');
  });

  test('SHOT_REVERSE_SHOT exchange with emotional_hold is NEVER auto-repaired', () => {
    const g = cleanGraph();
    g.scenes[0].beats = [
      {
        beat_id: 's1b1',
        type: 'SHOT_REVERSE_SHOT',
        exchanges: [
          { persona_index: 0, dialogue: 'Go.', emotional_hold: true, duration_seconds: 6 }, // deliberate silence
          { persona_index: 1, dialogue: 'I never wanted any of this, not really.', duration_seconds: 4 }
        ]
      }
    ];
    const r = validateScreenplay(g, {}, PERSONAS);
    assert.equal(r.repaired.scenes[0].beats[0].exchanges[0].duration_seconds, 6, 'emotional_hold exchange preserves duration');
  });
});

describe('ScreenplayValidator — clean path', () => {
  test('clean scene graph has zero blockers', () => {
    const r = validateScreenplay(cleanGraph(), {}, PERSONAS);
    const blockers = r.issues.filter(i => i.severity === 'blocker');
    assert.equal(blockers.length, 0);
    assert.equal(r.needsPunchUp, false);
  });

  test('stats surface on every validation call', () => {
    const r = validateScreenplay(cleanGraph(), {}, PERSONAS);
    assert.ok(r.stats.total_beats >= 1);
    assert.ok(r.stats.dialogue_beats >= 1);
    assert.ok(r.stats.avg_dialogue_words > 0);
    assert.ok(r.stats.subtext_coverage > 0);
  });

  test('null sceneGraph returns a single blocker without throwing', () => {
    const r = validateScreenplay(null, {}, PERSONAS);
    assert.equal(r.issues.length, 1);
    assert.equal(r.issues[0].severity, 'blocker');
  });
});

describe('ScreenplayValidator — thresholds are exported', () => {
  test('THRESHOLDS export has all required fields', () => {
    assert.equal(typeof THRESHOLDS.minDialogueWordsAvg, 'number');
    assert.equal(typeof THRESHOLDS.minDialogueBeatRatio, 'number');
    assert.equal(typeof THRESHOLDS.maxVoiceOverlapRatio, 'number');
    assert.equal(typeof THRESHOLDS.minSubtextCoverage, 'number');
  });
});
