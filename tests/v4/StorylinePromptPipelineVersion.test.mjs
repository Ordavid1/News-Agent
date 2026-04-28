// tests/v4/StorylinePromptPipelineVersion.test.mjs
// Pipeline-aware storyline prompt regression tests.
//
// Background: getStorylineSystemPrompt and getStorylineUserPrompt are SHARED
// across the v3 and V4 brand-story pipelines. They run upstream of the
// pipeline-version branch in runEpisodePipeline, so they previously fed Gemini
// v3-era calibration anchors (10-15s narrator-driven episodes) even when the
// destination was V4 (60-120s, 5-12 beats, on-camera dialogue). The fix made
// both prompts pipeline-aware via an `options.pipelineVersion` field. These
// tests lock that contract so future edits cannot accidentally regress either
// branch.
//
// Plan: .claude/plans/regarding-this-infrastructure-i-magical-flame.md
//
// Run: node --test tests/v4/StorylinePromptPipelineVersion.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  getStorylineSystemPrompt,
  getStorylineUserPrompt
} from '../../public/components/brandStoryPrompts.mjs';

const personasMulti = [
  { description: 'Maya — chef', personality: 'driven, guarded' },
  { description: 'Daniel — partner', personality: 'cautious, devoted' }
];
const subject = { name: 'Restaurant', category: 'hospitality', description: 'Family-owned' };

describe('getStorylineSystemPrompt — pipeline-aware episode grammar', () => {
  test('V4 branch uses 60-120s episode-grammar anchor and emits scene-graph note', () => {
    const out = getStorylineSystemPrompt({}, { pipelineVersion: 'v4' });
    assert.match(out, /60-120 second/, 'V4 anchor must mention 60-120 seconds');
    assert.match(out, /5-12 cinematic beats/, 'V4 anchor must mention the 5-12 beat range');
    assert.match(out, /on-camera dialogue/, 'V4 anchor must mention on-camera dialogue');
    assert.match(out, /EPISODE GRAMMAR \(V4\)/, 'V4 must emit the EPISODE GRAMMAR note');
    assert.doesNotMatch(out, /10-15 second/, 'V4 must NOT contain the v3-era 10-15 second anchor');
  });

  test('legacy branch (no pipelineVersion) keeps 10-15s anchor and omits scene-graph note', () => {
    const out = getStorylineSystemPrompt({}, {});
    assert.match(out, /10-15 second short-form video/, 'Legacy must keep the 10-15s anchor');
    assert.doesNotMatch(out, /60-120 second/, 'Legacy must NOT contain the V4 anchor');
    assert.doesNotMatch(out, /EPISODE GRAMMAR \(V4\)/, 'Legacy must NOT emit the V4 grammar note');
  });

  test('explicit non-v4 pipelineVersion (v2/v3) keeps legacy wording', () => {
    for (const v of ['v2', 'v3', '', 'V3', 'unknown']) {
      const out = getStorylineSystemPrompt({}, { pipelineVersion: v });
      assert.match(out, /10-15 second/, `pipelineVersion=${JSON.stringify(v)} must keep legacy anchor`);
      assert.doesNotMatch(out, /60-120 second/, `pipelineVersion=${JSON.stringify(v)} must NOT contain V4 anchor`);
    }
  });

  test('case-insensitive V4 detection', () => {
    const out = getStorylineSystemPrompt({}, { pipelineVersion: 'V4' });
    assert.match(out, /60-120 second/);
  });
});

describe('getStorylineUserPrompt — pipeline-aware persona framing', () => {
  test('V4 branch frames Persona 1 as PROTAGONIST (not NARRATOR)', () => {
    const out = getStorylineUserPrompt(personasMulti, subject, {}, { pipelineVersion: 'v4' });
    assert.match(out, /PROTAGONIST/, 'V4 must frame the lead persona as PROTAGONIST');
    assert.doesNotMatch(out, /PRIMARY NARRATOR/, 'V4 must NOT mention PRIMARY NARRATOR');
    assert.doesNotMatch(out, /PRIMARY\/narrator/, 'V4 must NOT mention PRIMARY/narrator');
    assert.match(out, /all speak on-camera/, 'V4 weave line must declare on-camera speech for all personas');
  });

  test('legacy branch keeps PRIMARY NARRATOR framing', () => {
    const out = getStorylineUserPrompt(personasMulti, subject, {}, {});
    assert.match(out, /PRIMARY NARRATOR/, 'Legacy must keep PRIMARY NARRATOR header');
    assert.match(out, /Persona 1 is the PRIMARY\/narrator/, 'Legacy must keep PRIMARY/narrator inline label');
    assert.doesNotMatch(out, /PROTAGONIST/, 'Legacy must NOT mention PROTAGONIST');
  });

  test('single-persona stories do not get a lead-label in either branch', () => {
    const single = [personasMulti[0]];
    const v4Out = getStorylineUserPrompt(single, subject, {}, { pipelineVersion: 'v4' });
    const legacyOut = getStorylineUserPrompt(single, subject, {}, {});
    for (const out of [v4Out, legacyOut]) {
      assert.doesNotMatch(out, /PROTAGONIST/);
      assert.doesNotMatch(out, /PRIMARY NARRATOR/);
    }
  });
});

describe('getStorylineUserPrompt — pipeline-aware dialogue_script schema description', () => {
  test('V4 schema description reframes dialogue_script as a planning summary, not a length target', () => {
    const out = getStorylineUserPrompt(personasMulti, subject, {}, { pipelineVersion: 'v4' });
    assert.match(out, /Episode-level dialogue summary/, 'V4 schema description must reframe dialogue_script as a summary');
    assert.match(out, /NOT a target speech length/, 'V4 schema description must explicitly disclaim length');
    assert.doesNotMatch(out, /10-15 seconds of speech/, 'V4 must NOT instruct Gemini to produce 10-15s of speech');
  });

  test('legacy schema description keeps the 10-15s narrator framing', () => {
    const out = getStorylineUserPrompt(personasMulti, subject, {}, {});
    assert.match(out, /10-15 seconds of speech/, 'Legacy must keep the v3 fallback wording');
    assert.match(out, /v3 fallback summary/, 'Legacy must keep the v3 fallback note');
  });
});

describe('episode-list line preserves V4 wording at line ~211 (already correct, regression-locked)', () => {
  test('V4 user prompt mentions 60-90 seconds and $20 budget for non-commercial stories', () => {
    const out = getStorylineUserPrompt(
      personasMulti,
      subject,
      {},
      { pipelineVersion: 'v4', genre: 'drama', episodeCount: 8 }
    );
    assert.match(out, /each ~60-90 seconds/, 'episode-list line must keep V4-aligned 60-90s anchor');
    assert.match(out, /5-12 beats/, 'episode-list line must mention the 5-12 beat range');
    assert.match(out, /\$20 production budget/, 'episode-list line must mention the $20 cap');
  });
});
