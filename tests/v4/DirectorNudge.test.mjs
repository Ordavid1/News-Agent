// tests/v4/DirectorNudge.test.mjs
//
// Verify that BaseBeatGenerator._appendDirectorNudge correctly splices a
// director_nudge into a beat's prompt only when present, and that the
// helper preserves the existing prompt verbatim when no nudge is set.
// All beat-generator subclasses (CinematicDialogue, Action, Reaction,
// BRoll, InsertShot, SilentStare, TalkingHead, GroupTwoShot, BRoll-VO,
// SceneBridge) call this helper at their prompt-finalization site so a
// regression here would silently break Phase 3 blocking-mode auto-retry.
//
// Run with: node --test tests/v4/DirectorNudge.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BaseBeatGenerator } from '../../services/beat-generators/BaseBeatGenerator.js';

const gen = new BaseBeatGenerator({});

test('appendDirectorNudge — no nudge: prompt returned verbatim', () => {
  const out = gen._appendDirectorNudge('VERTICAL 9:16 portrait', { beat_id: 'b_01' });
  assert.equal(out, 'VERTICAL 9:16 portrait');
});

test('appendDirectorNudge — empty-string nudge: no append', () => {
  const out = gen._appendDirectorNudge('VERTICAL 9:16', { director_nudge: '' });
  assert.equal(out, 'VERTICAL 9:16');
});

test('appendDirectorNudge — whitespace-only nudge: no append', () => {
  const out = gen._appendDirectorNudge('VERTICAL 9:16', { director_nudge: '   \n  ' });
  assert.equal(out, 'VERTICAL 9:16');
});

test('appendDirectorNudge — non-string nudge: no append', () => {
  const out = gen._appendDirectorNudge('VERTICAL 9:16', { director_nudge: { obj: 'value' } });
  assert.equal(out, 'VERTICAL 9:16');
});

test('appendDirectorNudge — nudge present: appended with DIRECTOR\'S NOTE marker', () => {
  const out = gen._appendDirectorNudge(
    'VERTICAL 9:16 portrait',
    { director_nudge: 'tighten to cowboy-shot, neutralize smile' }
  );
  assert.match(out, /VERTICAL 9:16 portrait/);
  assert.match(out, /DIRECTOR'S NOTE \(retake\)/);
  assert.match(out, /tighten to cowboy-shot, neutralize smile/);
});

test('appendDirectorNudge — appends with sentence separator when prompt does not end in punctuation', () => {
  const out = gen._appendDirectorNudge('first sentence', { director_nudge: 'second' });
  // Should insert ". " between "first sentence" and "DIRECTOR'S NOTE..."
  assert.match(out, /first sentence\. DIRECTOR'S NOTE/);
});

test('appendDirectorNudge — preserves trailing punctuation, just adds space', () => {
  const out = gen._appendDirectorNudge('first sentence.', { director_nudge: 'second' });
  // Existing period preserved; just a single space before DIRECTOR'S NOTE
  assert.match(out, /first sentence\. DIRECTOR'S NOTE/);
});

test('appendDirectorNudge — beat without director_nudge field returns prompt verbatim', () => {
  const out = gen._appendDirectorNudge('prompt', { beat_id: 'b_03', expression_notes: 'curious' });
  assert.equal(out, 'prompt');
});

test('appendDirectorNudge — null beat returns prompt verbatim', () => {
  const out = gen._appendDirectorNudge('prompt', null);
  assert.equal(out, 'prompt');
});
