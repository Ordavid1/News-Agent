// tests/v4/PreviouslyOnBlock.test.mjs
// Unit tests for the V4 cross-episode continuity memory rendering in
// _buildPreviousEpisodesBlock — keyframes, character voice samples, and the
// emotional intensity ledger.
//
// Run: node --test tests/v4/PreviouslyOnBlock.test.mjs
//
// Coverage:
//   - Series premiere renders the "first episode" string, not continuity
//   - Keyframes render as bullet-point anchors
//   - Voice samples render per persona, grouped by persona name when available
//   - Intensity ledger renders as a ramp + emits the escalation rule
//   - Empty / missing fields don't break the block
//   - Story-so-far still renders at the top of continuity memory when present

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { _buildPreviousEpisodesBlock } from '../../public/components/brandStoryPrompts.mjs';

function minimalStoryline(overrides = {}) {
  return {
    title: 'Small Change',
    characters: [{ name: 'Maya' }, { name: 'Daniel' }],
    ...overrides
  };
}

function ep(n, extras = {}) {
  return {
    title: `Episode ${n}`,
    narrative_beat: `something happens in ${n}`,
    cliffhanger: `hook ${n}`,
    mood: 'reflective',
    dialogue_script: '',
    continuity_from_previous: '',
    shots: [{ shot_type: 'cinematic', duration_seconds: 5 }],
    ...extras
  };
}

describe('_buildPreviousEpisodesBlock — premiere path', () => {
  test('empty previousEpisodes → premiere string', () => {
    const out = _buildPreviousEpisodesBlock(minimalStoryline(), []);
    assert.ok(out.includes('FIRST episode'));
  });
});

describe('_buildPreviousEpisodesBlock — keyframes', () => {
  test('renders each keyframe as a bullet anchor', () => {
    const storyline = minimalStoryline({
      previously_on_keyframes: [
        'Ep1: Maya inherited the shop',
        'Ep2: Daniel proposed the partnership',
        'Ep3: Maya refused'
      ]
    });
    const out = _buildPreviousEpisodesBlock(storyline, [ep(1), ep(2), ep(3)]);
    assert.ok(out.includes('KEYFRAMES'));
    assert.ok(out.includes('Ep1: Maya inherited the shop'));
    assert.ok(out.includes('Ep2: Daniel proposed the partnership'));
    assert.ok(out.includes('Ep3: Maya refused'));
  });

  test('empty keyframes array renders no KEYFRAMES header', () => {
    const storyline = minimalStoryline({ previously_on_keyframes: [] });
    const out = _buildPreviousEpisodesBlock(storyline, [ep(1)]);
    assert.ok(!out.includes('KEYFRAMES'));
  });
});

describe('_buildPreviousEpisodesBlock — character voice samples', () => {
  test('renders per-persona recent-lines bank', () => {
    const storyline = minimalStoryline({
      character_voice_samples: {
        '0': ['You didn\'t eat.', 'Then I am consistent.', 'I came back yesterday.'],
        '1': ['I wasn\'t hungry.', 'You always say yes.']
      }
    });
    const out = _buildPreviousEpisodesBlock(storyline, [ep(1)]);
    assert.ok(out.includes('CHARACTER VOICE SAMPLES'));
    assert.ok(out.includes('[0] Maya:'));
    assert.ok(out.includes('[1] Daniel:'));
    assert.ok(out.includes('"You didn\'t eat."'));
    assert.ok(out.includes('"Then I am consistent."'));
  });

  test('uses Persona N fallback when storyline.characters lacks a name', () => {
    const storyline = {
      title: 'T',
      character_voice_samples: { '0': ['line one.'] }
    };
    const out = _buildPreviousEpisodesBlock(storyline, [ep(1)]);
    assert.ok(out.includes('[0] Persona 1:'));
  });

  test('empty character_voice_samples → no block', () => {
    const storyline = minimalStoryline({ character_voice_samples: {} });
    const out = _buildPreviousEpisodesBlock(storyline, [ep(1)]);
    assert.ok(!out.includes('CHARACTER VOICE SAMPLES'));
  });
});

describe('_buildPreviousEpisodesBlock — intensity ledger', () => {
  test('renders a ramp with the escalation rule', () => {
    const storyline = minimalStoryline({
      emotional_intensity_ledger: { '1': 4, '2': 6, '3': 8 }
    });
    const out = _buildPreviousEpisodesBlock(storyline, [ep(1), ep(2), ep(3)]);
    assert.ok(out.includes('EMOTIONAL INTENSITY LEDGER'));
    assert.ok(out.includes('Ep1:4'));
    assert.ok(out.includes('Ep3:8'));
    assert.ok(out.includes('ESCALATION RULE'));
    assert.ok(out.includes('This episode opens at intensity ≥ 7/10'));
  });

  test('ledger honors numeric sort even with string keys', () => {
    const storyline = minimalStoryline({
      emotional_intensity_ledger: { '10': 9, '2': 4, '1': 3 }
    });
    const out = _buildPreviousEpisodesBlock(storyline, [ep(1)]);
    // Should sort numerically: Ep1:3 → Ep2:4 → Ep10:9
    const idx1 = out.indexOf('Ep1:3');
    const idx2 = out.indexOf('Ep2:4');
    const idx10 = out.indexOf('Ep10:9');
    assert.ok(idx1 < idx2 && idx2 < idx10, `Expected numeric ordering: got idx1=${idx1}, idx2=${idx2}, idx10=${idx10}`);
  });

  test('empty ledger → no block', () => {
    const storyline = minimalStoryline({ emotional_intensity_ledger: {} });
    const out = _buildPreviousEpisodesBlock(storyline, [ep(1)]);
    assert.ok(!out.includes('EMOTIONAL INTENSITY LEDGER'));
  });
});

describe('_buildPreviousEpisodesBlock — story_so_far passthrough', () => {
  test('story_so_far text is rendered at the top of continuity memory', () => {
    const storyline = minimalStoryline({
      story_so_far: 'STORY SO FAR:\nEp1: the shop inherited. Ep2: the refusal.'
    });
    const out = _buildPreviousEpisodesBlock(storyline, [ep(1)]);
    assert.ok(out.includes('STORY SO FAR:'));
    assert.ok(out.includes('the shop inherited'));
  });
});

describe('_buildPreviousEpisodesBlock — mixed stream composition', () => {
  test('all three streams render together without leakage', () => {
    const storyline = minimalStoryline({
      previously_on_keyframes: ['Ep1: x', 'Ep2: y'],
      character_voice_samples: { '0': ['sample line.'] },
      emotional_intensity_ledger: { '1': 5, '2': 7 },
      story_so_far: 'STORY SO FAR:\nEp1: x. Ep2: y.'
    });
    const out = _buildPreviousEpisodesBlock(storyline, [ep(1), ep(2)]);
    assert.ok(out.includes('STORY SO FAR:'));
    assert.ok(out.includes('KEYFRAMES'));
    assert.ok(out.includes('CHARACTER VOICE SAMPLES'));
    assert.ok(out.includes('EMOTIONAL INTENSITY LEDGER'));
    assert.ok(out.includes('ESCALATION RULE'));
  });
});
