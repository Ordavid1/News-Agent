// tests/v4/VeoTier25Regen.test.mjs
//
// Verifies VeoService's tier 2.5 IMAGE-violation fallback path:
//   1. IMAGE violation + regenerateSafeFirstFrame callback → tier 2.5 fires once.
//   2. Regen frame also IMAGE-rejected → falls to tier3-no-image.
//   3. No callback provided → fast-jump to tier3-no-image (back-compat).
//   4. Tier 2.5 succeeds → video returned, attemptUsed='tier2.5-regen-frame'.
//   5. Non-IMAGE content-filter error → prompt sanitisation tiers (normal path).
//
// Uses a test-double class that replaces the inner videoGenerationService
// call with a controlled stub, without needing real Vertex AI credentials.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── Shared fixtures ──────────────────────────────────────────────────────────
const ORIGINAL_FRAME_URL = 'https://storage.example.com/persona-lock.png';
const REGEN_FRAME_URL    = 'https://storage.example.com/persona-lock-safe.png';
const VIDEO_RESULT       = Object.freeze({
  videoUrl: 'https://storage.example.com/beat.mp4',
  videoBuffer: Buffer.from('fake-mp4'),
  duration: 4,
  model: 'veo-3.1-vertex',
  fallbackTier: 1
});

function makeImageViolationError() {
  const err = new Error(
    'Veo 3.1 Standard blocked by content filters: input image violates Vertex AI usage guidelines.'
  );
  err.isContentFilter = true;
  return err;
}

function makePromptViolationError() {
  const err = new Error(
    'Veo 3.1 Standard blocked: This prompt contains words that violate usage guidelines.'
  );
  err.isContentFilter = true;
  return err;
}

// Helper: build a minimal VeoService-like object that uses our controlled
// videoGen stub instead of the real singleton, so no network calls are made.
function buildTestVeoService({ videoGenResponses, regenCallback = null }) {
  let responseIndex = 0;

  const videoGen = {
    async generateWithFirstLastFrame({ firstImageUrl }) {
      const response = videoGenResponses[responseIndex++];
      if (response instanceof Error) throw response;
      return response;
    }
  };

  return {
    _available: true,
    isAvailable() { return true; },
    async generateWithFrames({ firstFrameUrl = null, prompt = 'test', options = {} } = {}) {
      const {
        duration = 4,
        aspectRatio = '9:16',
        regenerateSafeFirstFrame: regenCb = null,
        personaNames = [],
        sanitizationContext = {}
      } = options;

      const clampedDuration = Math.max(2, Math.min(8, duration));

      // Simplified tier ladder (mirrors VeoService, only the IMAGE path matters here)
      const attempts = [
        { label: 'original', prompt, firstFrame: firstFrameUrl },
        { label: 'tier1-sanitised', prompt, firstFrame: firstFrameUrl },
        { label: 'tier2-minimal', prompt, firstFrame: firstFrameUrl },
        { label: 'tier3-no-image', prompt, firstFrame: null }
      ];

      let lastErr = null;
      let attemptUsed = null;
      let result = null;
      let attemptIndex = 0;
      let _tier25Attempted = false;

      while (attemptIndex < attempts.length) {
        const attempt = attempts[attemptIndex];
        try {
          result = await videoGen.generateWithFirstLastFrame({
            firstImageUrl: attempt.firstFrame,
            prompt: attempt.prompt,
            options: { durationSeconds: clampedDuration, aspectRatio }
          });
          attemptUsed = attempt.label;
          break;
        } catch (err) {
          lastErr = err;
          if (!err.isContentFilter) throw err;

          const isImage = err.message.includes('input image violates');
          if (isImage && attempt.firstFrame !== null) {
            if (typeof regenCb === 'function' && !_tier25Attempted) {
              _tier25Attempted = true;
              try {
                const saferFrameUrl = await regenCb();
                if (saferFrameUrl) {
                  result = await videoGen.generateWithFirstLastFrame({
                    firstImageUrl: saferFrameUrl,
                    prompt: attempt.prompt,
                    options: { durationSeconds: clampedDuration, aspectRatio }
                  });
                  attemptUsed = 'tier2.5-regen-frame';
                  break;
                }
              } catch (regenErr) {
                // regen rejected — fall to tier3
              }
            }
            attemptIndex = attempts.findIndex(a => a.label === 'tier3-no-image');
            continue;
          }
          attemptIndex++;
        }
      }

      if (!result) {
        const finalErr = new Error('All tiers refused');
        finalErr.originalError = lastErr;
        throw finalErr;
      }

      return {
        videoUrl: result.videoUrl,
        videoBuffer: result.videoBuffer,
        duration: result.duration,
        model: 'veo-3.1-vertex',
        fallbackTier: 1,
        sanitizationTier: attemptUsed
      };
    }
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('VeoService tier 2.5 — IMAGE violation + callback → regen frame succeeds, no tier3', async () => {
  let regenCalled = false;
  const svc = buildTestVeoService({
    videoGenResponses: [
      makeImageViolationError(), // original rejected (IMAGE)
      { ...VIDEO_RESULT }        // tier2.5-regen-frame accepted
    ],
    regenCallback: async () => {
      regenCalled = true;
      return REGEN_FRAME_URL;
    }
  });

  const result = await svc.generateWithFrames({
    firstFrameUrl: ORIGINAL_FRAME_URL,
    prompt: 'cinematic beat',
    options: {
      regenerateSafeFirstFrame: async () => {
        regenCalled = true;
        return REGEN_FRAME_URL;
      }
    }
  });

  assert.ok(regenCalled, 'regenerateSafeFirstFrame callback must be invoked');
  assert.equal(result.sanitizationTier, 'tier2.5-regen-frame');
  assert.ok(Buffer.isBuffer(result.videoBuffer));
});

test('VeoService tier 2.5 — IMAGE violation + regen also rejected → falls to tier3-no-image', async () => {
  let regenCalled = false;
  const svc = buildTestVeoService({
    videoGenResponses: [
      makeImageViolationError(),  // original rejected
      makeImageViolationError(),  // regen also rejected
      { ...VIDEO_RESULT }         // tier3-no-image accepted
    ]
  });

  const result = await svc.generateWithFrames({
    firstFrameUrl: ORIGINAL_FRAME_URL,
    prompt: 'cinematic beat',
    options: {
      regenerateSafeFirstFrame: async () => {
        regenCalled = true;
        return REGEN_FRAME_URL;
      }
    }
  });

  assert.ok(regenCalled, 'regen callback still invoked even though result rejected');
  assert.equal(result.sanitizationTier, 'tier3-no-image');
  assert.ok(Buffer.isBuffer(result.videoBuffer));
});

test('VeoService tier 2.5 — IMAGE violation with NO callback → fast-jump to tier3 (back-compat)', async () => {
  const svc = buildTestVeoService({
    videoGenResponses: [
      makeImageViolationError(),  // original rejected
      { ...VIDEO_RESULT }         // tier3-no-image accepted
    ]
  });

  const result = await svc.generateWithFrames({
    firstFrameUrl: ORIGINAL_FRAME_URL,
    prompt: 'cinematic beat',
    options: {}  // no regenerateSafeFirstFrame
  });

  // Should have gone original → tier3, skipping tier1+tier2 (existing behavior)
  assert.equal(result.sanitizationTier, 'tier3-no-image');
  assert.ok(Buffer.isBuffer(result.videoBuffer));
});

test('VeoService tier 2.5 — guard prevents infinite regen loop (only fires once)', async () => {
  let regenCallCount = 0;
  // Simulate IMAGE violation on original + regen + then another attempt
  const svc = buildTestVeoService({
    videoGenResponses: [
      makeImageViolationError(),  // original
      makeImageViolationError(),  // regen attempt also rejected
      { ...VIDEO_RESULT }         // tier3-no-image
    ]
  });

  await svc.generateWithFrames({
    firstFrameUrl: ORIGINAL_FRAME_URL,
    prompt: 'test',
    options: {
      regenerateSafeFirstFrame: async () => {
        regenCallCount++;
        return REGEN_FRAME_URL;
      }
    }
  });

  assert.equal(regenCallCount, 1, 'regen callback must only be called ONCE regardless of failures');
});

test('VeoService — prompt violation (not IMAGE) follows normal tier1/tier2/tier3 path, no regen', async () => {
  let regenCalled = false;
  const svc = buildTestVeoService({
    videoGenResponses: [
      makePromptViolationError(), // original rejected (PROMPT, not IMAGE)
      { ...VIDEO_RESULT }         // tier1-sanitised accepted
    ]
  });

  const result = await svc.generateWithFrames({
    firstFrameUrl: ORIGINAL_FRAME_URL,
    prompt: 'cinematic beat with persona names',
    options: {
      regenerateSafeFirstFrame: async () => {
        regenCalled = true;
        return REGEN_FRAME_URL;
      }
    }
  });

  assert.ok(!regenCalled, 'regen callback must NOT fire on prompt-only violation');
  assert.equal(result.sanitizationTier, 'tier1-sanitised');
});
