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
    assert.ok(r.issues.find(i => i.id === 'missing_episode_dramatic_question' && i.severity === 'critical'));
    assert.equal(r.needsPunchUp, true);
  });

  test('missing hook_types on scene produces blocker', () => {
    const g = cleanGraph();
    delete g.scenes[0].hook_types;
    const r = validateScreenplay(g, {}, PERSONAS);
    assert.ok(r.issues.find(i => i.id === 'scene_missing_hook_types' && i.severity === 'critical'));
  });

  test('multi-persona scene without opposing_intents produces blocker', () => {
    const g = cleanGraph();
    delete g.scenes[0].opposing_intents;
    const r = validateScreenplay(g, {}, PERSONAS);
    assert.ok(r.issues.find(i => i.id === 'scene_missing_opposing_intents' && i.severity === 'critical'));
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
    assert.ok(r.issues.find(i => i.id === 'voice_overlap_too_high' && i.severity === 'critical'));
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
    assert.ok(r.issues.find(i => i.id === 'dialogue_beat_ratio_too_low' && i.severity === 'critical'));
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
    assert.ok(r.issues.find(i => i.id === 'dialogue_too_sparse' && i.severity === 'critical'));
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

  test('bare short lines marked emotional_hold WITH justification are NOT counted', () => {
    const g = cleanGraph();
    // Earned holds — each beat has expression_notes ≥ 5 words explaining the silence.
    g.scenes[0].beats = [
      { beat_id: 's1b1', type: 'TALKING_HEAD_CLOSEUP', persona_index: 0, dialogue: 'Go now.', emotional_hold: true, expression_notes: 'eyes locked on the open doorway, jaw tight', duration_seconds: 3 },
      { beat_id: 's1b2', type: 'TALKING_HEAD_CLOSEUP', persona_index: 1, dialogue: 'I cannot.', emotional_hold: true, expression_notes: 'breath catches, gaze drops to the floor', duration_seconds: 3 },
      { beat_id: 's1b3', type: 'TALKING_HEAD_CLOSEUP', persona_index: 0, dialogue: 'Why not?', emotional_hold: true, expression_notes: 'face hardens, shoulders square against the answer', duration_seconds: 3 }
    ];
    const r = validateScreenplay(g, {}, PERSONAS);
    assert.ok(!r.issues.find(i => i.id === 'too_many_bare_short_lines'));
    assert.ok(!r.issues.find(i => i.id === 'unearned_emotional_hold'));
  });

  test('bare short lines marked emotional_hold WITHOUT justification ARE counted (unearned)', () => {
    const g = cleanGraph();
    // Naked emotional_hold flag — no expression_notes, no subtext. Gameable.
    g.scenes[0].beats = [
      { beat_id: 's1b1', type: 'TALKING_HEAD_CLOSEUP', persona_index: 0, dialogue: 'Go now.', emotional_hold: true, duration_seconds: 3 },
      { beat_id: 's1b2', type: 'TALKING_HEAD_CLOSEUP', persona_index: 1, dialogue: 'I cannot.', emotional_hold: true, duration_seconds: 3 },
      { beat_id: 's1b3', type: 'TALKING_HEAD_CLOSEUP', persona_index: 0, dialogue: 'Why not?', emotional_hold: true, duration_seconds: 3 }
    ];
    const r = validateScreenplay(g, {}, PERSONAS);
    assert.ok(r.issues.find(i => i.id === 'too_many_bare_short_lines'));
    const unearned = r.issues.filter(i => i.id === 'unearned_emotional_hold');
    assert.equal(unearned.length, 3);
    assert.equal(unearned[0].severity, 'warning');
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
    const blockers = r.issues.filter(i => i.severity === 'critical');
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
    assert.equal(r.issues[0].severity, 'critical');
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

// ──────────────────────────────────────────────────────────────
// Persona-index coverage check (added 2026-04-25 after logs.txt
// caught a SHOT_REVERSE_SHOT child failing "no persona resolved"
// at beat-generation time — by then the Scene Master + earlier
// beats had already burned API budget. The check moves the
// catch upstream to L1 validation.)
// ──────────────────────────────────────────────────────────────
describe('ScreenplayValidator — persona-index coverage', () => {
  test('single-persona dialogue beat without persona_index → blocker', () => {
    const g = cleanGraph();
    delete g.scenes[0].beats[0].persona_index;
    const r = validateScreenplay(g, {}, PERSONAS);
    const f = r.issues.find(i => i.id === 'persona_index_missing' && i.severity === 'critical');
    assert.ok(f, 'expected persona_index_missing blocker');
    assert.match(f.scope, /^beat:s1b1$/);
  });

  test('SHOT_REVERSE_SHOT exchange without persona_index → blocker', () => {
    const g = cleanGraph();
    g.scenes[0].beats = [
      {
        beat_id: 'srs1',
        type: 'SHOT_REVERSE_SHOT',
        exchanges: [
          { persona_index: 0, dialogue: 'You knew this.', emotion: 'cold', duration_seconds: 4 },
          { /* no persona_index */ dialogue: 'I never wanted any of this.', emotion: 'broken', duration_seconds: 4 }
        ]
      }
    ];
    const r = validateScreenplay(g, {}, PERSONAS);
    const f = r.issues.find(i => i.id === 'persona_index_missing' && i.severity === 'critical' && i.scope === 'beat:srs1');
    assert.ok(f, 'expected SHOT_REVERSE_SHOT exchange blocker');
    assert.match(f.message, /exchange\[1\]/);
  });

  test('GROUP_DIALOGUE_TWOSHOT missing persona_indexes alignment → blocker', () => {
    const g = cleanGraph();
    g.scenes[0].beats = [
      {
        beat_id: 'g1',
        type: 'GROUP_DIALOGUE_TWOSHOT',
        dialogues: ['First line.', 'Second line.'],
        persona_indexes: [0],  // missing index for second dialogue
        duration_seconds: 6
      }
    ];
    const r = validateScreenplay(g, {}, PERSONAS);
    assert.ok(r.issues.find(i =>
      i.id === 'persona_index_missing' && i.severity === 'critical' && /dialogues\[1\]/.test(i.message)
    ));
  });

  test('persona_index pointing outside personas[] → blocker', () => {
    const g = cleanGraph();
    g.scenes[0].beats[0].persona_index = 99; // PERSONAS has 2 entries (0, 1)
    const r = validateScreenplay(g, {}, PERSONAS);
    assert.ok(r.issues.find(i => i.id === 'persona_index_missing' && i.severity === 'critical'));
  });

  test('clean graph has no persona_index_missing blockers', () => {
    const g = cleanGraph();
    const r = validateScreenplay(g, {}, PERSONAS);
    assert.ok(!r.issues.find(i => i.id === 'persona_index_missing'));
  });
});

// ────────────────────────────────────────────────────────────────────────
// Phase 3 — validator parameterization tests
// These run with BRAND_STORY_VALIDATOR_PARAMETERIZED + BRAND_STORY_GENRE_REGISTER_LIBRARY
// both set to 'true' so the genre-aware code paths fire. Each test sets/restores
// the env vars itself so the suite stays order-independent.
// ────────────────────────────────────────────────────────────────────────

function withFlags(flags, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(flags)) { prev[k] = process.env[k]; process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const FLAGS_ON = {
  BRAND_STORY_VALIDATOR_PARAMETERIZED: 'true',
  BRAND_STORY_GENRE_REGISTER_LIBRARY: 'true'
};

function actionGraph(overrides = {}) {
  // Clipped action register — 3-word avg, 35% dialogue runtime is healthy.
  return {
    title: 'Action episode',
    dramatic_question: 'Will Maya make the extraction?',
    emotional_state: 'taut',
    scenes: [
      {
        scene_id: 's1',
        hook_types: ['CLIFFHANGER'],
        opposing_intents: { '[0]': 'Maya wants the package', '[1]': 'Daniel wants Maya alive' },
        beats: [
          { beat_id: 's1b1', type: 'TALKING_HEAD_CLOSEUP', persona_index: 0, dialogue: 'Hands.', duration_seconds: 2 },
          { beat_id: 's1b2', type: 'TALKING_HEAD_CLOSEUP', persona_index: 1, dialogue: 'Down.', duration_seconds: 2 },
          { beat_id: 's1b3', type: 'TALKING_HEAD_CLOSEUP', persona_index: 0, dialogue: 'Slower.', duration_seconds: 2 },
          { beat_id: 's1b4', type: 'ACTION_NO_DIALOGUE', duration_seconds: 4, action_prompt: 'Maya pivots.' },
          { beat_id: 's1b5', type: 'TALKING_HEAD_CLOSEUP', persona_index: 1, dialogue: 'Reload.', duration_seconds: 2 },
          { beat_id: 's1b6', type: 'TALKING_HEAD_CLOSEUP', persona_index: 0, dialogue: 'Move.', duration_seconds: 2 }
        ]
      }
    ],
    ...overrides
  };
}

describe('Phase 3 — Genre-aware dialogue floor', () => {
  test('ACTION with avg 3-word clipped dialogue + 30% density does NOT trip dialogue_too_sparse', () => {
    withFlags(FLAGS_ON, () => {
      const g = actionGraph();
      const r = validateScreenplay(g, {}, PERSONAS, { genre: 'action', storyFocus: 'product' });
      assert.ok(
        !r.issues.find(i => i.id === 'dialogue_too_sparse'),
        `action with clipped lines should NOT trigger dialogue_too_sparse — issues: ${JSON.stringify(r.issues.map(i => i.id))}`
      );
    });
  });

  test('DRAMA with avg 3-word clipped dialogue AND <45% density STILL trips dialogue_too_sparse', () => {
    withFlags(FLAGS_ON, () => {
      // Drama test fixture: clipped dialogue (3 words avg) AND low dialogue
      // runtime % (~25%, below drama's 0.45 floor). The Phase 3.1 contract is
      // "block only when BOTH avg-words AND density-pct fall below floors" —
      // drama's high target_dialogue_runtime_pct (0.45) is the safety net so
      // a clipped-but-dialogue-heavy drama (lots of short lines) is still
      // permitted as a stylistic choice, but truly sparse drama gets blocked.
      const g = {
        title: 'Sparse drama',
        dramatic_question: 'Will Maya leave?',
        emotional_state: 'cold',
        scenes: [{
          scene_id: 's1',
          hook_types: ['REVELATION'],
          opposing_intents: { '[0]': 'Maya wants out', '[1]': 'Daniel wants her to stay' },
          beats: [
            { beat_id: 's1b1', type: 'B_ROLL_ESTABLISHING', duration_seconds: 6, location: 'kitchen', atmosphere: 'cold morning' },
            { beat_id: 's1b2', type: 'B_ROLL_ESTABLISHING', duration_seconds: 6, location: 'hallway', atmosphere: 'silent' },
            { beat_id: 's1b3', type: 'TALKING_HEAD_CLOSEUP', persona_index: 0, dialogue: 'Hands.', duration_seconds: 2 },
            { beat_id: 's1b4', type: 'TALKING_HEAD_CLOSEUP', persona_index: 1, dialogue: 'Down.', duration_seconds: 2 },
            { beat_id: 's1b5', type: 'TALKING_HEAD_CLOSEUP', persona_index: 0, dialogue: 'Slower.', duration_seconds: 2 }
          ]
        }]
      };
      const r = validateScreenplay(g, {}, PERSONAS, { genre: 'drama', storyFocus: 'product' });
      assert.ok(
        r.issues.find(i => i.id === 'dialogue_too_sparse'),
        `drama with clipped lines AND low density MUST trigger dialogue_too_sparse — issues: ${JSON.stringify(r.issues.map(i => i.id))}`
      );
    });
  });

  test('FLAGS OFF preserves legacy uniform floor (drama+action both blocked when sparse)', () => {
    // Legacy path: uniform 6-word floor regardless of genre. Explicit
    // flag-off invocation so the test is order- and parent-env-independent.
    withFlags({
      BRAND_STORY_VALIDATOR_PARAMETERIZED: 'false',
      BRAND_STORY_GENRE_REGISTER_LIBRARY: 'false'
    }, () => {
      const g = actionGraph();
      const r = validateScreenplay(g, {}, PERSONAS, { genre: 'action', storyFocus: 'product' });
      assert.ok(
        r.issues.find(i => i.id === 'dialogue_too_sparse'),
        'with flags OFF, uniform legacy floor should still block clipped action — proves backwards compatibility'
      );
    });
  });

  test('ACTION genre disables the bare-short-lines cap (max_bare_short_lines=-1)', () => {
    withFlags(FLAGS_ON, () => {
      const g = actionGraph();
      const r = validateScreenplay(g, {}, PERSONAS, { genre: 'action', storyFocus: 'product' });
      assert.ok(
        !r.issues.find(i => i.id === 'too_many_bare_short_lines'),
        'action register disables the bare-short cap'
      );
    });
  });
});

describe('Phase 3 — dialogue_density_intent escape hatch', () => {
  test('silent_register intent lets a sparse drama episode pass dialogue_too_sparse', () => {
    withFlags(FLAGS_ON, () => {
      const g = actionGraph(); // sparse, drama-genre, but silent_register
      g.dialogue_density_intent = 'silent_register';
      const r = validateScreenplay(g, {}, PERSONAS, { genre: 'drama', storyFocus: 'product' });
      assert.ok(
        !r.issues.find(i => i.id === 'dialogue_too_sparse'),
        'silent_register intent must let drama with clipped dialogue pass'
      );
    });
  });

  test('balanced (default) intent on drama still blocks sparse+clipped dialogue', () => {
    withFlags(FLAGS_ON, () => {
      const g = {
        title: 'Sparse drama',
        dramatic_question: 'Will Maya leave?',
        emotional_state: 'cold',
        dialogue_density_intent: 'balanced',
        scenes: [{
          scene_id: 's1',
          hook_types: ['REVELATION'],
          opposing_intents: { '[0]': 'Maya wants out', '[1]': 'Daniel wants her to stay' },
          beats: [
            { beat_id: 's1b1', type: 'B_ROLL_ESTABLISHING', duration_seconds: 6, location: 'kitchen', atmosphere: 'cold morning' },
            { beat_id: 's1b2', type: 'B_ROLL_ESTABLISHING', duration_seconds: 6, location: 'hallway', atmosphere: 'silent' },
            { beat_id: 's1b3', type: 'TALKING_HEAD_CLOSEUP', persona_index: 0, dialogue: 'Hands.', duration_seconds: 2 },
            { beat_id: 's1b4', type: 'TALKING_HEAD_CLOSEUP', persona_index: 1, dialogue: 'Down.', duration_seconds: 2 },
            { beat_id: 's1b5', type: 'TALKING_HEAD_CLOSEUP', persona_index: 0, dialogue: 'Slower.', duration_seconds: 2 }
          ]
        }]
      };
      const r = validateScreenplay(g, {}, PERSONAS, { genre: 'drama', storyFocus: 'product' });
      assert.ok(
        r.issues.find(i => i.id === 'dialogue_too_sparse'),
        'balanced drama with sparse+clipped dialogue MUST block'
      );
    });
  });
});

describe('Phase 3 — Brand-name dialogue rule (parameterised)', () => {
  function makeBrandGraph(brandMentions) {
    const beats = brandMentions.map((line, i) => ({
      beat_id: `s1b${i + 1}`,
      type: 'TALKING_HEAD_CLOSEUP',
      persona_index: i % 2,
      dialogue: line,
      subtext: 'placeholder subtext for substance',
      duration_seconds: 5
    }));
    return {
      title: 'Brand mentions',
      dramatic_question: 'Will Maya stay loyal to Aurora?',
      emotional_state: 'reflective',
      scenes: [{
        scene_id: 's1',
        hook_types: ['REVELATION'],
        opposing_intents: { '[0]': 'Maya wants', '[1]': 'Daniel wants' },
        beats
      }]
    };
  }

  test('max_brand_name_mentions=0 blocks the FIRST occurrence', () => {
    withFlags(FLAGS_ON, () => {
      const g = makeBrandGraph([
        'I love Aurora coffee in the morning, every single day',
        'Maya, you really should drink something else for once'
      ]);
      const opts = {
        genre: 'drama',
        productIntegrationStyle: 'naturalistic_placement',
        subject: { name: 'Aurora', integration_mandate: { max_brand_name_mentions: 0 } }
      };
      const r = validateScreenplay(g, { brand_name: 'Aurora' }, PERSONAS, opts);
      assert.ok(
        r.issues.find(i => i.id === 'brand_name_in_dialogue'),
        'max_brand_name_mentions=0 must block the FIRST occurrence'
      );
    });
  });

  test('max_brand_name_mentions=3 allows 3, blocks the 4th', () => {
    withFlags(FLAGS_ON, () => {
      const g = makeBrandGraph([
        'I tasted Aurora yesterday and it was perfect for me',
        'Aurora is what brings me back here every Tuesday morning',
        'Daniel, did you order Aurora again at this hour today?',
        'Aurora, Aurora, Aurora — I cannot stop saying that name lately'
      ]);
      const opts = {
        genre: 'drama',
        productIntegrationStyle: 'naturalistic_placement',
        subject: { name: 'Aurora', integration_mandate: { max_brand_name_mentions: 3 } }
      };
      const r = validateScreenplay(g, { brand_name: 'Aurora' }, PERSONAS, opts);
      const brandIssues = r.issues.filter(i => i.id === 'brand_name_in_dialogue');
      assert.ok(brandIssues.length >= 1, 'the 4th brand mention must trigger the warning');
    });
  });
});

describe('Phase 3 — Diegetic label reading exemption', () => {
  function makeAdCopyGraph(diegetic) {
    return {
      title: 'Ad-copy guard',
      dramatic_question: 'Will Maya read the billboard?',
      emotional_state: 'reflective',
      scenes: [{
        scene_id: 's1',
        hook_types: ['REVELATION'],
        opposing_intents: { '[0]': 'Maya wants', '[1]': 'Daniel wants' },
        beats: [
          {
            beat_id: 's1b1',
            type: 'TALKING_HEAD_CLOSEUP',
            persona_index: 0,
            dialogue: 'Now available — limited time, free shipping for everyone',
            subtext: 'Reading the billboard text aloud',
            duration_seconds: 5,
            diegetic_label_reading: diegetic
          },
          {
            beat_id: 's1b2',
            type: 'TALKING_HEAD_CLOSEUP',
            persona_index: 1,
            dialogue: 'I cannot believe what they put on that sign over the highway',
            subtext: 'placeholder',
            duration_seconds: 5
          }
        ]
      }]
    };
  }

  test('diegetic_label_reading=true exempts ONE beat from ad-copy regex', () => {
    withFlags(FLAGS_ON, () => {
      const g = makeAdCopyGraph(true);
      const r = validateScreenplay(g, {}, PERSONAS, {
        genre: 'drama',
        productIntegrationStyle: 'naturalistic_placement'
      });
      const adCopyIssues = r.issues.filter(i => i.id?.startsWith('ad_copy_'));
      assert.strictEqual(adCopyIssues.length, 0, 'diegetic_label_reading must exempt the beat');
    });
  });

  test('diegetic_label_reading=false (or absent) still blocks ad-copy', () => {
    withFlags(FLAGS_ON, () => {
      const g = makeAdCopyGraph(false);
      const r = validateScreenplay(g, {}, PERSONAS, {
        genre: 'drama',
        productIntegrationStyle: 'naturalistic_placement'
      });
      const adCopyIssues = r.issues.filter(i => i.id?.startsWith('ad_copy_'));
      assert.ok(adCopyIssues.length >= 1, 'without exemption, ad-copy phrases must block');
    });
  });
});

describe('Phase 3 — Externalised forbidden-registers.json drives bans', () => {
  test('a banned phrase from the JSON file fires when integration style matches applies_to_styles', () => {
    withFlags(FLAGS_ON, () => {
      const g = {
        title: 'Test',
        dramatic_question: 'Will Maya act?',
        emotional_state: 'engaged',
        scenes: [{
          scene_id: 's1',
          hook_types: ['REVELATION'],
          opposing_intents: { '[0]': 'Maya wants', '[1]': 'Daniel wants' },
          beats: [
            {
              beat_id: 's1b1',
              type: 'TALKING_HEAD_CLOSEUP',
              persona_index: 0,
              dialogue: 'It is a real game-changer if you ask me, Daniel',
              subtext: 'placeholder',
              duration_seconds: 5
            },
            {
              beat_id: 's1b2',
              type: 'TALKING_HEAD_CLOSEUP',
              persona_index: 1,
              dialogue: 'You always say that about everything you bring home',
              subtext: 'placeholder',
              duration_seconds: 5
            }
          ]
        }]
      };
      const r = validateScreenplay(g, {}, PERSONAS, {
        genre: 'drama',
        productIntegrationStyle: 'naturalistic_placement'
      });
      assert.ok(
        r.issues.find(i => i.id === 'ad_copy_gamechanger'),
        'externalised regex from JSON must fire on game-changer phrase'
      );
    });
  });

  test('hero_showcase mode bypasses ad-copy bans (data-driven applies_to_styles)', () => {
    withFlags(FLAGS_ON, () => {
      const g = {
        title: 'Test',
        dramatic_question: 'Will Maya act?',
        emotional_state: 'engaged',
        scenes: [{
          scene_id: 's1',
          hook_types: ['REVELATION'],
          opposing_intents: { '[0]': 'Maya wants', '[1]': 'Daniel wants' },
          beats: [
            { beat_id: 's1b1', type: 'TALKING_HEAD_CLOSEUP', persona_index: 0, dialogue: 'Now available everywhere', subtext: 'p', duration_seconds: 4 },
            { beat_id: 's1b2', type: 'TALKING_HEAD_CLOSEUP', persona_index: 1, dialogue: 'Tell me more about this product really', subtext: 'p', duration_seconds: 5 }
          ]
        }]
      };
      const r = validateScreenplay(g, {}, PERSONAS, {
        genre: 'commercial',
        productIntegrationStyle: 'hero_showcase'
      });
      const adCopyIssues = r.issues.filter(i => i.id?.startsWith('ad_copy_'));
      assert.strictEqual(adCopyIssues.length, 0, 'hero_showcase bypasses ad-copy bans');
    });
  });
});
