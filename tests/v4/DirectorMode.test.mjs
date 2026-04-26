// tests/v4/DirectorMode.test.mjs
//
// Tests for resolveDirectorMode (env-flag composition) and
// DirectorBlockingHaltError (escalation contract). These are the two pieces
// that gate Phase 2-5 blocking behavior at the orchestrator level — bugs
// here directly affect production cost and UX (silent failures the user
// can't act on, or unauthorized auto-retry spending budget).
//
// Run with: node --test tests/v4/DirectorMode.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDirectorMode,
  DirectorBlockingHaltError,
  CHECKPOINTS,
  DirectorAgent
} from '../../services/v4/DirectorAgent.js';

const ENV_KEYS = [
  'BRAND_STORY_DIRECTOR_AGENT',
  'BRAND_STORY_DIRECTOR_SCREENPLAY',
  'BRAND_STORY_DIRECTOR_SCENE_MASTER',
  'BRAND_STORY_DIRECTOR_BEAT',
  'BRAND_STORY_DIRECTOR_EPISODE'
];

function withEnv(envOverrides, fn) {
  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

// ─── default off ───
test('resolveDirectorMode — defaults to "off" with no env flags', () => {
  withEnv({}, () => {
    assert.equal(resolveDirectorMode(CHECKPOINTS.SCREENPLAY), 'off');
    assert.equal(resolveDirectorMode(CHECKPOINTS.SCENE_MASTER), 'off');
    assert.equal(resolveDirectorMode(CHECKPOINTS.BEAT), 'off');
    assert.equal(resolveDirectorMode(CHECKPOINTS.EPISODE), 'off');
  });
});

// ─── master flag propagates to all checkpoints ───
test('resolveDirectorMode — master "shadow" applies to all checkpoints', () => {
  withEnv({ BRAND_STORY_DIRECTOR_AGENT: 'shadow' }, () => {
    assert.equal(resolveDirectorMode(CHECKPOINTS.SCREENPLAY), 'shadow');
    assert.equal(resolveDirectorMode(CHECKPOINTS.SCENE_MASTER), 'shadow');
    assert.equal(resolveDirectorMode(CHECKPOINTS.BEAT), 'shadow');
    assert.equal(resolveDirectorMode(CHECKPOINTS.EPISODE), 'shadow');
  });
});

test('resolveDirectorMode — master "blocking" applies to A/B/C; D downgraded to advisory', () => {
  withEnv({ BRAND_STORY_DIRECTOR_AGENT: 'blocking' }, () => {
    assert.equal(resolveDirectorMode(CHECKPOINTS.SCREENPLAY), 'blocking');
    assert.equal(resolveDirectorMode(CHECKPOINTS.SCENE_MASTER), 'blocking');
    assert.equal(resolveDirectorMode(CHECKPOINTS.BEAT), 'blocking');
    assert.equal(resolveDirectorMode(CHECKPOINTS.EPISODE), 'advisory');
  });
});

// ─── Per-checkpoint overrides master ───
test('resolveDirectorMode — per-checkpoint flag overrides master', () => {
  withEnv({
    BRAND_STORY_DIRECTOR_AGENT: 'shadow',
    BRAND_STORY_DIRECTOR_SCREENPLAY: 'blocking'
  }, () => {
    assert.equal(resolveDirectorMode(CHECKPOINTS.SCREENPLAY), 'blocking');
    assert.equal(resolveDirectorMode(CHECKPOINTS.SCENE_MASTER), 'shadow');
    assert.equal(resolveDirectorMode(CHECKPOINTS.BEAT), 'shadow');
    assert.equal(resolveDirectorMode(CHECKPOINTS.EPISODE), 'shadow');
  });
});

test('resolveDirectorMode — per-checkpoint "off" disables a single lens while others stay shadow', () => {
  withEnv({
    BRAND_STORY_DIRECTOR_AGENT: 'shadow',
    BRAND_STORY_DIRECTOR_BEAT: 'off'
  }, () => {
    assert.equal(resolveDirectorMode(CHECKPOINTS.SCREENPLAY), 'shadow');
    assert.equal(resolveDirectorMode(CHECKPOINTS.SCENE_MASTER), 'shadow');
    assert.equal(resolveDirectorMode(CHECKPOINTS.BEAT), 'off');
    assert.equal(resolveDirectorMode(CHECKPOINTS.EPISODE), 'shadow');
  });
});

// ─── Lens D never blocks ───
test('resolveDirectorMode — Lens D blocking always downgrades to advisory (no full-episode auto-retries)', () => {
  withEnv({ BRAND_STORY_DIRECTOR_EPISODE: 'blocking' }, () => {
    assert.equal(resolveDirectorMode(CHECKPOINTS.EPISODE), 'advisory');
  });
});

test('resolveDirectorMode — Lens D advisory respected', () => {
  withEnv({ BRAND_STORY_DIRECTOR_EPISODE: 'advisory' }, () => {
    assert.equal(resolveDirectorMode(CHECKPOINTS.EPISODE), 'advisory');
  });
});

test('resolveDirectorMode — Lens D shadow respected', () => {
  withEnv({ BRAND_STORY_DIRECTOR_EPISODE: 'shadow' }, () => {
    assert.equal(resolveDirectorMode(CHECKPOINTS.EPISODE), 'shadow');
  });
});

// ─── Truthy aliases ───
test('resolveDirectorMode — "true" / "on" normalize to "shadow"', () => {
  withEnv({ BRAND_STORY_DIRECTOR_AGENT: 'true' }, () => {
    assert.equal(resolveDirectorMode(CHECKPOINTS.BEAT), 'shadow');
  });
  withEnv({ BRAND_STORY_DIRECTOR_AGENT: 'on' }, () => {
    assert.equal(resolveDirectorMode(CHECKPOINTS.BEAT), 'shadow');
  });
  withEnv({ BRAND_STORY_DIRECTOR_AGENT: 'false' }, () => {
    assert.equal(resolveDirectorMode(CHECKPOINTS.BEAT), 'off');
  });
});

// ─── Case-insensitive ───
test('resolveDirectorMode — case-insensitive normalization', () => {
  withEnv({ BRAND_STORY_DIRECTOR_AGENT: 'BLOCKING' }, () => {
    assert.equal(resolveDirectorMode(CHECKPOINTS.SCREENPLAY), 'blocking');
  });
  withEnv({ BRAND_STORY_DIRECTOR_AGENT: 'Shadow' }, () => {
    assert.equal(resolveDirectorMode(CHECKPOINTS.BEAT), 'shadow');
  });
});

// ─── Invalid value falls back to off ───
test('resolveDirectorMode — invalid value falls back to "off"', () => {
  withEnv({ BRAND_STORY_DIRECTOR_AGENT: 'enabled' }, () => {
    assert.equal(resolveDirectorMode(CHECKPOINTS.BEAT), 'off');
  });
});

// ─── DirectorBlockingHaltError ───
test('DirectorBlockingHaltError — preserves checkpoint, verdict, artifactKey, reason', () => {
  const verdict = { verdict: 'hard_reject', overall_score: 30 };
  const err = new DirectorBlockingHaltError({
    checkpoint: CHECKPOINTS.BEAT,
    verdict,
    artifactKey: 'b_07',
    reason: 'retake still soft_reject'
  });
  assert.ok(err instanceof Error);
  assert.ok(err instanceof DirectorBlockingHaltError);
  assert.equal(err.name, 'DirectorBlockingHaltError');
  assert.equal(err.checkpoint, CHECKPOINTS.BEAT);
  assert.equal(err.verdict, verdict);
  assert.equal(err.artifactKey, 'b_07');
  assert.equal(err.reason, 'retake still soft_reject');
  assert.match(err.message, /beat:b_07/);
  assert.match(err.message, /retake still soft_reject/);
});

test('DirectorBlockingHaltError — instanceof checks distinguish from generic Error', () => {
  const halt = new DirectorBlockingHaltError({ checkpoint: 'screenplay', verdict: {}, reason: 'test' });
  const generic = new Error('plain error');
  assert.ok(halt instanceof DirectorBlockingHaltError);
  assert.ok(!(generic instanceof DirectorBlockingHaltError));
});

// ─── thinkingLevel propagation (Phase 2 fix for Gemini 3 Flash MAX_TOKENS) ───
// Added 2026-04-25 after a 9/9 truncation pattern in logs.txt was traced to
// Gemini 3 Flash defaulting to thinkingLevel='high' on multimodal director
// rubric calls. The fix is to pass thinkingLevel='low' on every DirectorAgent
// call. These tests verify the constructor wires the default and lets the
// caller override.

test('DirectorAgent — defaults thinkingLevel to "minimal" (Gemini 3 Flash floor; rubric matching does not need deep reasoning)', () => {
  const agent = new DirectorAgent();
  assert.equal(agent.thinkingLevel, 'minimal');
});

test('DirectorAgent — thinkingLevel is overridable via constructor', () => {
  const minimal = new DirectorAgent({ thinkingLevel: 'minimal' });
  const medium = new DirectorAgent({ thinkingLevel: 'medium' });
  const high = new DirectorAgent({ thinkingLevel: 'high' });
  assert.equal(minimal.thinkingLevel, 'minimal');
  assert.equal(medium.thinkingLevel, 'medium');
  assert.equal(high.thinkingLevel, 'high');
});

test('DirectorAgent — defaults: temp=0.7, maxOutputTokens=24576, timeoutMs=360_000 text/image, timeoutVideoMs=360_000 Lens D', () => {
  const agent = new DirectorAgent();
  // 0.7 escapes Gemini 3 Flash Preview infinite reasoning loops (Google AI rep
  // recommendation). Schema enum constraints bound the output shape.
  assert.equal(agent.temperature, 0.7);
  // 24576: visible capacity 3195 tokens (38% margin over 2500-token worst-case
  // hard_reject verdict). thinkingConfig ignored by Vertex global endpoint;
  // ~87% of budget consumed by hidden thinking regardless of setting.
  assert.equal(agent.maxOutputTokens, 24576);
  // 360s: multimodal at 24576 budget takes ~205s at 120 t/s, ~307s at 80 t/s.
  // Both fit within 360s. Retry (min(24576×2,65536)=49152) is a safety net
  // but should rarely trigger since 24576 fits all observed verdict sizes.
  assert.equal(agent.timeoutMs, 360_000);
  assert.equal(agent.timeoutVideoMs, 360_000);
});
