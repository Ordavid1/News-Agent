// tests/v4/DialogueTTSService.test.mjs
// V4 Audio Layer Overhaul Day 2 — eleven-v3 dialogue endpoint wrapper tests.
//
// Run: node --test tests/v4/DialogueTTSService.test.mjs
//
// Coverage (PURE — no fal.ai network calls):
//   - validateDialogueInputs accepts well-formed inputs
//   - validateDialogueInputs throws when total chars > 2,000
//   - validateDialogueInputs throws when unique voices > 10
//   - validateDialogueInputs throws on missing fields
//   - The internal `[no_tag_intentional: ...]` annotation does NOT count toward
//     the char-budget total (eleven-v3 strips it before billing/parsing)
//   - module loads cleanly + endpoint slug matches
//   - validation runs before any network request (synthesizeDialogue throws
//     synchronously on validation errors when FAL_GCS_API_KEY is missing too)
//   - DIALOGUE_MAX_TOTAL_CHARS / DIALOGUE_MAX_UNIQUE_VOICES exports match spec

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  default as dialogueTTSService,
  DialogueTTSService,
  validateDialogueInputs,
  DIALOGUE_MAX_TOTAL_CHARS,
  DIALOGUE_MAX_UNIQUE_VOICES,
  DIALOGUE_VALID_STABILITY
} from '../../services/DialogueTTSService.js';

describe('DialogueTTSService — module + constants', () => {
  test('module loads + exports default singleton + class', () => {
    assert.ok(dialogueTTSService, 'default export should exist');
    assert.ok(DialogueTTSService, 'named class export should exist');
    assert.equal(typeof dialogueTTSService.synthesizeDialogue, 'function');
    assert.equal(typeof dialogueTTSService.isAvailable, 'function');
  });

  test('endpoint slug points at the eleven-v3 dialogue model', () => {
    assert.equal(dialogueTTSService.base.modelSlug, 'fal-ai/elevenlabs/text-to-dialogue/eleven-v3');
  });

  test('exported constants match the official eleven-v3 spec', () => {
    assert.equal(DIALOGUE_MAX_TOTAL_CHARS, 2000);
    assert.equal(DIALOGUE_MAX_UNIQUE_VOICES, 10);
    assert.deepEqual(DIALOGUE_VALID_STABILITY, [0.0, 0.5, 1.0]);
  });
});

describe('DialogueTTSService — validateDialogueInputs', () => {
  test('accepts a well-formed two-speaker exchange', () => {
    const r = validateDialogueInputs([
      { text: '[firmly] We are leaving now.', voice: 'EXAVITQu4vr4xnSDxMaL' },
      { text: '[exhaling] I know.',             voice: '21m00Tcm4TlvDq8ikWAM' }
    ]);
    assert.equal(r.uniqueVoiceCount, 2);
    assert.ok(r.totalChars > 0 && r.totalChars < 100, `expected modest char count, got ${r.totalChars}`);
  });

  test('throws when inputs[] is empty or non-array', () => {
    assert.throws(() => validateDialogueInputs([]), /non-empty array/);
    assert.throws(() => validateDialogueInputs(null), /non-empty array/);
    assert.throws(() => validateDialogueInputs({}), /non-empty array/);
  });

  test('throws when an input is missing text', () => {
    assert.throws(
      () => validateDialogueInputs([{ voice: 'Aria' }]),
      /text is required/
    );
  });

  test('throws when an input is missing voice', () => {
    assert.throws(
      () => validateDialogueInputs([{ text: 'Hello.' }]),
      /voice is required/
    );
  });

  test('throws when total chars exceed 2,000', () => {
    const longLine = 'x'.repeat(1100);
    assert.throws(
      () => validateDialogueInputs([
        { text: longLine, voice: 'A' },
        { text: longLine, voice: 'B' }
      ]),
      /exceeds 2000-char hard limit/
    );
  });

  test('throws when unique voice count exceeds 10', () => {
    const inputs = [];
    for (let i = 0; i < 11; i++) {
      inputs.push({ text: `Line ${i}.`, voice: `voice_${i}` });
    }
    assert.throws(
      () => validateDialogueInputs(inputs),
      /exceeds 10-voice/
    );
  });

  test('the [no_tag_intentional: ...] annotation does NOT count toward char budget', () => {
    const annotation = '[no_tag_intentional: stoic_baseline] ';
    const lineLen = 5; // 'Hello'
    const r = validateDialogueInputs([
      { text: `${annotation}Hello`, voice: 'A' }
    ]);
    // Stripped char count should be ~5, not annotation length + 5.
    assert.ok(
      r.totalChars < annotation.length,
      `expected char count to exclude annotation; got ${r.totalChars}`
    );
    assert.equal(r.totalChars, lineLen);
  });

  test('eleven-v3 performance tags ARE counted (they are real text in the spec budget)', () => {
    // The endpoint applies text normalization + parsing over the full string;
    // eleven-v3 tags consume request bytes even though they don't render as
    // spoken audio. The screenplay-side checkDialogueEndpointBudget validator
    // uses a stricter SPOKEN-only count for warnings; this service uses the
    // full submitted-text length so we never hit a 422 from the endpoint.
    const tagged = '[whispering] Hello';
    const untagged = 'Hello';
    const a = validateDialogueInputs([{ text: tagged, voice: 'A' }]);
    const b = validateDialogueInputs([{ text: untagged, voice: 'A' }]);
    assert.ok(a.totalChars > b.totalChars, 'tagged text bills longer than untagged');
  });
});

describe('DialogueTTSService — synthesizeDialogue safety rails', () => {
  test('throws when FAL_GCS_API_KEY is missing (graceful, before any HTTP)', async () => {
    // The singleton was loaded without an API key in the test harness.
    if (dialogueTTSService.isAvailable()) {
      // If somehow the env IS configured we skip — pure unit tests must not
      // depend on a real key. (It is fine for this branch to be a no-op.)
      return;
    }
    await assert.rejects(
      () => dialogueTTSService.synthesizeDialogue({
        inputs: [{ text: 'Hello', voice: 'A' }, { text: 'Hi', voice: 'B' }]
      }),
      /FAL_GCS_API_KEY is not configured/
    );
  });
});
