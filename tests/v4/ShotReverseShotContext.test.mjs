// tests/v4/ShotReverseShotContext.test.mjs
// V4 Audio Layer Overhaul Day 2 — exchange-context preservation tests.
//
// Run: node --test tests/v4/ShotReverseShotContext.test.mjs
//
// Coverage:
//   - SHOT_REVERSE_SHOT compiler stamps `exchange_context` on every child closeup
//   - Position 0 (scene-opener) carries null prior fields
//   - Position N (response shot) carries prior speaker emotion + subtext + tail
//   - Speaker sequence is captured across the whole exchange
//   - Non-SRS beats are passed through unchanged (no exchange_context added)
//   - Empty exchanges array degrades gracefully (returns [])
//
// PURE — no fal.ai / Vertex calls.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import ShotReverseShotCompiler from '../../services/beat-generators/ShotReverseShotCompiler.js';

const exchangeBeat = () => ({
  beat_id: 's1b3',
  type: 'SHOT_REVERSE_SHOT',
  exchanges: [
    {
      persona_index: 0,
      dialogue: '[firmly] You knew this would happen.',
      emotion: 'resigned',
      subtext: 'I have been waiting for this confession.',
      duration_seconds: 4
    },
    {
      persona_index: 1,
      dialogue: '[exhaling] I never wanted any of this.',
      emotion: 'broken',
      subtext: 'I am asking for absolution I did not earn.',
      duration_seconds: 5
    },
    {
      persona_index: 0,
      dialogue: '[evenly] Then why are you here?',
      emotion: 'cutting',
      subtext: 'There is no answer that lets you out.',
      duration_seconds: 3
    }
  ]
});

describe('ShotReverseShotCompiler — exchange_context (Day 2)', () => {
  test('every child closeup carries an exchange_context block', () => {
    const expanded = ShotReverseShotCompiler.expandBeat(exchangeBeat());
    assert.equal(expanded.length, 3);
    for (const child of expanded) {
      assert.ok(child.exchange_context, `child ${child.beat_id} missing exchange_context`);
      assert.equal(typeof child.exchange_context.position_in_exchange, 'number');
      assert.equal(child.exchange_context.total_exchanges, 3);
    }
  });

  test('first child (position 0) has NULL prior-speaker fields', () => {
    const [first] = ShotReverseShotCompiler.expandBeat(exchangeBeat());
    assert.equal(first.exchange_context.position_in_exchange, 0);
    assert.equal(first.exchange_context.prior_speaker_persona_index, null);
    assert.equal(first.exchange_context.prior_speaker_emotion, null);
    assert.equal(first.exchange_context.prior_speaker_subtext, null);
    assert.equal(first.exchange_context.prior_speaker_dialogue_tail, null);
  });

  test('second child (position 1) carries first speaker emotion + subtext + tail', () => {
    const [, second] = ShotReverseShotCompiler.expandBeat(exchangeBeat());
    assert.equal(second.exchange_context.position_in_exchange, 1);
    assert.equal(second.exchange_context.prior_speaker_persona_index, 0);
    assert.equal(second.exchange_context.prior_speaker_emotion, 'resigned');
    assert.equal(second.exchange_context.prior_speaker_subtext, 'I have been waiting for this confession.');
    assert.match(second.exchange_context.prior_speaker_dialogue_tail, /this would happen/i,
      'tail should be the last 12 words of speaker 1\'s dialogue (incl. tags)');
  });

  test('third child (position 2) carries second speaker context', () => {
    const [, , third] = ShotReverseShotCompiler.expandBeat(exchangeBeat());
    assert.equal(third.exchange_context.position_in_exchange, 2);
    assert.equal(third.exchange_context.prior_speaker_persona_index, 1);
    assert.equal(third.exchange_context.prior_speaker_emotion, 'broken');
    assert.match(third.exchange_context.prior_speaker_subtext, /absolution/i);
  });

  test('speaker_sequence captures the alternation pattern across the exchange', () => {
    const expanded = ShotReverseShotCompiler.expandBeat(exchangeBeat());
    for (const child of expanded) {
      assert.deepEqual(child.exchange_context.speaker_sequence, [0, 1, 0]);
    }
  });

  test('dialogue_tail is bounded to 12 words even on a long prior line', () => {
    const beat = exchangeBeat();
    beat.exchanges[0].dialogue = 'A B C D E F G H I J K L M N O P';
    const expanded = ShotReverseShotCompiler.expandBeat(beat);
    const tail = expanded[1].exchange_context.prior_speaker_dialogue_tail;
    assert.equal(tail.split(/\s+/).length, 12, 'tail should clamp to 12 words');
    assert.equal(tail, 'E F G H I J K L M N O P');
  });

  test('subtext and other propagated metadata still flow per pre-Day-2 contract', () => {
    const expanded = ShotReverseShotCompiler.expandBeat(exchangeBeat());
    assert.equal(expanded[0].subtext, 'I have been waiting for this confession.');
    assert.equal(expanded[1].emotion, 'broken');
    assert.equal(expanded[2].dialogue, '[evenly] Then why are you here?');
  });

  test('non-SRS beats pass through unchanged with no exchange_context', () => {
    const passthrough = {
      beat_id: 's1b1',
      type: 'TALKING_HEAD_CLOSEUP',
      persona_index: 0,
      dialogue: 'Hello there.',
      emotion: 'composed',
      duration_seconds: 3
    };
    const out = ShotReverseShotCompiler.expandBeat(passthrough);
    assert.equal(out.length, 1);
    assert.equal(out[0], passthrough, 'non-SRS beats are returned by reference');
    assert.equal(out[0].exchange_context, undefined);
  });

  test('SHOT_REVERSE_SHOT with empty exchanges[] returns []', () => {
    const out = ShotReverseShotCompiler.expandBeat({
      beat_id: 's1b3',
      type: 'SHOT_REVERSE_SHOT',
      exchanges: []
    });
    assert.deepEqual(out, []);
  });
});
