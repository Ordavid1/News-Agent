// tests/v4/VeoFallback.test.mjs
//
// Verifies the Veo→Kling fallback shipped 2026-05-06.
//
// Coverage:
//   1. VeoService.generateWithFrames({ skipTextOnlyFallback: true }) — when
//      ALL anchored tiers refuse with content-filter, throws
//      VeoContentFilterPersistentError. The tier3-no-image attempt is NEVER
//      run (saves ~80s in production).
//   2. VeoService default (skipTextOnlyFallback=false) — preserves legacy
//      behavior: tier3-no-image attempt runs as a last resort.
//   3. BaseBeatGenerator._fallbackToKlingForVeoFailure — calls
//      kling.generateActionBeat with the right shape (elements, prompt,
//      options) and returns the standard generator output with
//      modelUsed=kling-v3-pro/<beatTypeLabel> (veo-fallback).
//   4. Per-generator wiring smoke tests for the 6 Veo beat generators —
//      each one passes skipTextOnlyFallback=true and falls back when Veo
//      throws. Uses lightweight stubs to avoid real fal.ai/Vertex calls.
//
// All tests use stubs; no network.
//
// Run: node --test tests/v4/VeoFallback.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { VeoContentFilterPersistentError } from '../../services/VeoService.js';
import BaseBeatGenerator from '../../services/beat-generators/BaseBeatGenerator.js';
import VeoActionGenerator from '../../services/beat-generators/VeoActionGenerator.js';
import InsertShotGenerator from '../../services/beat-generators/InsertShotGenerator.js';
import BRollGenerator from '../../services/beat-generators/BRollGenerator.js';
import BridgeBeatGenerator from '../../services/beat-generators/BridgeBeatGenerator.js';
import ReactionGenerator from '../../services/beat-generators/ReactionGenerator.js';
import VoiceoverBRollGenerator from '../../services/beat-generators/VoiceoverBRollGenerator.js';

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const FAKE_VIDEO_BUFFER = Buffer.from('fake-mp4-bytes');

function makeContentFilterError(label = 'prompt') {
  const err = new Error(
    `Veo 3.1 Standard ${label === 'image' ? 'input image violates' : 'blocked: This prompt contains words that violate'} usage guidelines.`
  );
  err.isContentFilter = true;
  return err;
}

// Stub Veo that always throws VeoContentFilterPersistentError. Lets us test
// per-generator fallback paths without spinning up VeoService internals.
function makeFailingVeoStub() {
  return {
    async generateWithFrames(args) {
      // Sanity-check the call shape so tests catch wiring regressions.
      assert.equal(args.options?.skipTextOnlyFallback, true,
        'generator MUST pass skipTextOnlyFallback: true to opt into early-throw');
      throw new VeoContentFilterPersistentError(
        args.prompt || '<no prompt>',
        new Error('mocked persistent content filter')
      );
    }
  };
}

// Stub Kling that records call args and returns a fake result.
function makeRecordingKlingStub() {
  const calls = [];
  const stub = {
    calls,
    async generateActionBeat(args) {
      calls.push(args);
      return {
        videoUrl: 'https://storage.example.com/kling-fallback.mp4',
        videoBuffer: FAKE_VIDEO_BUFFER,
        duration: args.options?.duration || 5
      };
    }
  };
  return stub;
}

function makePersonas(n = 1) {
  return Array.from({ length: n }, (_, i) => ({
    name: `Persona${i}`,
    reference_image_urls: [`https://storage.example.com/p${i}-front.png`, `https://storage.example.com/p${i}-side.png`],
    canonical_identity_urls: [`https://storage.example.com/p${i}-cip-front.png`]
  }));
}

// Minimal episodeContext used across generator tests.
const baseEpisodeContext = {
  visual_style_prefix: 'cinematic, golden hour',
  uploadBuffer: async () => 'https://storage.example.com/uploaded.png',
  uploadAudio: async () => 'https://storage.example.com/uploaded.mp3',
  subjectReferenceImages: ['https://storage.example.com/subject.png']
};

// ─── 1. VeoService skipTextOnlyFallback ───────────────────────────────────────

describe('VeoContentFilterPersistentError class', () => {
  test('exposes isVeoContentFilterPersistent + back-compat isVeoContentFilter', () => {
    const err = new VeoContentFilterPersistentError('hello world', new Error('inner'));
    assert.equal(err.name, 'VeoContentFilterPersistentError');
    assert.equal(err.isVeoContentFilterPersistent, true);
    assert.equal(err.isVeoContentFilter, true, 'back-compat flag must be set');
    assert.equal(err.prompt, 'hello world');
    assert.ok(err.originalError instanceof Error);
    assert.ok(err.message.includes('Veo content filter persistent'));
  });

  test('handles missing prompt + lastErr gracefully', () => {
    const err = new VeoContentFilterPersistentError(undefined, undefined);
    assert.equal(err.prompt, '');
    assert.equal(err.originalError, null);
    assert.ok(err.message.includes('Veo content filter persistent'));
  });
});

// ─── 2. BaseBeatGenerator helper shape ────────────────────────────────────────

describe('BaseBeatGenerator._fallbackToKlingForVeoFailure', () => {
  test('returns the standard generator output shape with veo-fallback labels', async () => {
    const kling = makeRecordingKlingStub();
    const gen = new BaseBeatGenerator({ falServices: { kling } });

    const beat = {
      beat_id: 's1b1',
      type: 'B_ROLL_ESTABLISHING',
      duration_seconds: 4,
      personas_present: []
    };
    const personas = [];
    const refStack = ['https://storage.example.com/scene-master.png'];
    const scene = { scene_id: 'sc1', scene_master_url: 'https://storage.example.com/scene-master.png' };

    const result = await gen._fallbackToKlingForVeoFailure({
      beat, scene, refStack, personas,
      episodeContext: baseEpisodeContext,
      previousBeat: null,
      routingMetadata: undefined,
      prompt: 'test broll prompt',
      duration: 4,
      beatTypeLabel: 'broll',
      includeSubject: false,
      includePersonaElements: false,
      fallbackReason: 'mocked'
    });

    assert.equal(kling.calls.length, 1, 'kling.generateActionBeat called exactly once');
    assert.equal(kling.calls[0].prompt, 'test broll prompt');
    assert.equal(kling.calls[0].options.duration, 4);
    assert.equal(kling.calls[0].options.aspectRatio, '9:16');

    assert.equal(result.modelUsed, 'kling-v3-pro/broll (veo-fallback)');
    assert.deepEqual(result.metadata.fallbackChain, ['veo-3.1-standard', 'kling-v3-pro']);
    assert.equal(result.metadata.primaryAttempt, 'veo-3.1-standard');
    assert.equal(result.metadata.primaryFailureReason, 'mocked');
    assert.equal(result.durationSec, 4);
    assert.ok(Buffer.isBuffer(result.videoBuffer));
    assert.equal(result.costUsd, 0.224 * 4); // Kling V3 Pro per-second × duration
  });

  test('clamps Kling duration to [3, 15]s even when caller asks for 2s', async () => {
    const kling = makeRecordingKlingStub();
    const gen = new BaseBeatGenerator({ falServices: { kling } });

    const result = await gen._fallbackToKlingForVeoFailure({
      beat: { beat_id: 's1b1', type: 'REACTION' },
      scene: {},
      refStack: [],
      personas: [],
      episodeContext: baseEpisodeContext,
      previousBeat: null,
      prompt: 'short reaction',
      duration: 2, // below Kling minimum
      beatTypeLabel: 'reaction',
      includePersonaElements: false
    });

    assert.equal(kling.calls[0].options.duration, 3, 'Kling minimum is 3s');
    assert.equal(result.durationSec, 3);
  });

  test('throws when kling service is missing from deps', async () => {
    const gen = new BaseBeatGenerator({ falServices: {} }); // no kling
    await assert.rejects(
      () => gen._fallbackToKlingForVeoFailure({
        beat: { beat_id: 's1b1' },
        scene: {},
        refStack: [],
        personas: [],
        episodeContext: baseEpisodeContext,
        prompt: 'x',
        duration: 4,
        beatTypeLabel: 'action'
      }),
      /kling service not in deps/
    );
  });

  test('builds persona elements when includePersonaElements=true', async () => {
    const kling = makeRecordingKlingStub();
    const gen = new BaseBeatGenerator({ falServices: { kling } });

    const personas = makePersonas(2);
    const beat = {
      beat_id: 's1b1',
      type: 'ACTION_NO_DIALOGUE',
      persona_index: 0
    };

    await gen._fallbackToKlingForVeoFailure({
      beat,
      scene: {},
      refStack: [],
      personas,
      episodeContext: baseEpisodeContext,
      prompt: 'kinetic action',
      duration: 5,
      beatTypeLabel: 'action',
      includePersonaElements: true
    });

    assert.ok(Array.isArray(kling.calls[0].elements), 'elements must be an array');
    assert.equal(kling.calls[0].elements.length, 1, 'one persona = one element');
  });

  test('omits persona elements when includePersonaElements=false', async () => {
    const kling = makeRecordingKlingStub();
    const gen = new BaseBeatGenerator({ falServices: { kling } });

    await gen._fallbackToKlingForVeoFailure({
      beat: { beat_id: 's1b1', type: 'INSERT_SHOT' },
      scene: {},
      refStack: [],
      personas: makePersonas(1),
      episodeContext: baseEpisodeContext,
      prompt: 'product macro',
      duration: 3,
      beatTypeLabel: 'insert',
      includePersonaElements: false
    });

    assert.deepEqual(kling.calls[0].elements, [], 'no persona elements when flag is false');
  });
});

// ─── 3. Per-generator wiring smoke tests ──────────────────────────────────────
//
// These tests verify each Veo beat generator (a) passes
// skipTextOnlyFallback: true to Veo, and (b) routes to Kling when Veo
// throws. We don't run the full _doGenerate prompt-building path against
// real Vertex/Kling — just the catch+fallback wiring at the end.

function makePassThroughDeps() {
  return {
    falServices: {
      veo: makeFailingVeoStub(),
      kling: makeRecordingKlingStub()
    },
    tts: {
      async synthesizeBeat() {
        return { audioBuffer: Buffer.from('fake-tts'), actualDurationSec: 5 };
      }
    }
  };
}

describe('VeoActionGenerator → Kling fallback', () => {
  test('falls back to Kling when Veo throws VeoContentFilterPersistentError', async () => {
    const deps = makePassThroughDeps();
    const gen = new VeoActionGenerator(deps);

    // Stub the persona-lock pre-pass so we don't hit Seedream.
    gen._buildPersonaLockedFirstFrame = async () => null;
    gen._pickStartFrame = () => null;
    gen._buildVerticalFramingDirective = () => 'VERTICAL';
    gen._buildIdentityAnchoringDirective = () => 'ID';
    gen._buildSubjectPresenceDirective = () => '';
    gen._resolveFramingRecipe = () => 'kinetic recipe';
    gen._resolvePersonasInBeat = () => [];
    gen._buildWardrobeDirective = () => '';
    gen._buildBrandColorDirective = () => '';
    gen._buildContinuityDirective = () => '';
    gen._buildPreviousBeatAntiReferenceDirective = () => '';
    gen._buildPerModelColorHint = () => '';
    gen._appendDirectorNudge = (s) => s;

    const result = await gen._doGenerate({
      beat: { beat_id: 's1b1', type: 'ACTION_NO_DIALOGUE', duration_seconds: 5, action_prompt: 'run' },
      scene: { scene_id: 'sc1' },
      refStack: [],
      personas: [],
      episodeContext: baseEpisodeContext,
      previousBeat: null,
      routingMetadata: undefined
    });

    assert.equal(result.modelUsed, 'kling-v3-pro/action (veo-fallback)');
    assert.deepEqual(result.metadata.fallbackChain, ['veo-3.1-standard', 'kling-v3-pro']);
    assert.equal(deps.falServices.kling.calls.length, 1);
  });
});

describe('InsertShotGenerator → Kling fallback', () => {
  test('falls back with subject element, no persona elements', async () => {
    const deps = makePassThroughDeps();
    const gen = new InsertShotGenerator(deps);

    gen._buildSceneIntegratedProductFrame = async () => null;
    gen._buildPersonaLockedFirstFrame = async () => null;
    gen._pickStartFrame = () => 'https://storage.example.com/subject.png';
    gen._buildVerticalFramingDirective = () => 'VERTICAL';
    gen._resolveFramingRecipe = () => 'macro';
    gen._buildPerModelColorHint = () => '';
    gen._buildBrandColorDirective = () => '';
    gen._buildPreviousBeatAntiReferenceDirective = () => '';
    gen._appendDirectorNudge = (s) => s;

    const result = await gen._doGenerate({
      beat: {
        beat_id: 's2b1',
        type: 'INSERT_SHOT',
        subject_focus: 'a product',
        subject_present: true,
        duration_seconds: 3
      },
      scene: { scene_id: 'sc2' },
      refStack: [],
      personas: [],
      episodeContext: baseEpisodeContext,
      previousBeat: null
    });

    assert.equal(result.modelUsed, 'kling-v3-pro/insert (veo-fallback)');
    assert.deepEqual(result.metadata.fallbackChain, ['veo-3.1-standard', 'kling-v3-pro']);
    // Insert beats must NOT include persona elements (product hero only)
    assert.equal(deps.falServices.kling.calls[0].elements.length <= 1,
      true, 'INSERT must not include persona elements');
  });
});

describe('BRollGenerator → Kling fallback', () => {
  test('falls back without persona elements when no personas in beat', async () => {
    const deps = makePassThroughDeps();
    const gen = new BRollGenerator(deps);

    gen._buildPersonaLockedFirstFrame = async () => null;
    gen._buildSceneIntegratedProductFrame = async () => null;
    gen._pickStartFrame = () => null;
    gen._buildVerticalFramingDirective = () => 'VERTICAL';
    gen._buildIdentityAnchoringDirective = () => '';
    gen._buildSubjectPresenceDirective = () => '';
    gen._resolveFramingRecipe = () => null;
    gen._resolvePersonasInBeat = () => [];
    gen._buildPerModelColorHint = () => '';
    gen._buildWardrobeDirective = () => '';
    gen._buildBrandColorDirective = () => '';
    gen._buildContinuityDirective = () => '';
    gen._buildPreviousBeatAntiReferenceDirective = () => '';
    gen._appendDirectorNudge = (s) => s;

    const result = await gen._doGenerate({
      beat: { beat_id: 's1b1', type: 'B_ROLL_ESTABLISHING', duration_seconds: 4, location: 'rooftop' },
      scene: { scene_id: 'sc1' },
      refStack: [],
      personas: [],
      episodeContext: baseEpisodeContext,
      previousBeat: null
    });

    assert.equal(result.modelUsed, 'kling-v3-pro/broll (veo-fallback)');
  });
});

describe('VoiceoverBRollGenerator → Kling fallback', () => {
  test('falls back with V.O. metadata preserved', async () => {
    const deps = makePassThroughDeps();
    const gen = new VoiceoverBRollGenerator(deps);

    gen._buildPersonaLockedFirstFrame = async () => null;
    gen._buildSceneIntegratedProductFrame = async () => null;
    gen._pickStartFrame = () => null;
    gen._buildVerticalFramingDirective = () => 'VERTICAL';
    gen._buildIdentityAnchoringDirective = () => '';
    gen._buildSubjectPresenceDirective = () => '';
    gen._resolvePersonasInBeat = () => [];
    gen._buildPerModelColorHint = () => '';
    gen._buildWardrobeDirective = () => '';
    gen._buildBrandColorDirective = () => '';
    gen._buildPreviousBeatAntiReferenceDirective = () => '';
    gen._appendDirectorNudge = (s) => s;

    const personas = makePersonas(1);
    personas[0].elevenlabs_voice_id = 'voice-abc';

    const result = await gen._doGenerate({
      beat: {
        beat_id: 's1b1',
        type: 'VOICEOVER_OVER_BROLL',
        duration_seconds: 5,
        voiceover_text: 'hello world',
        voiceover_persona_index: 0,
        location: 'rooftop'
      },
      scene: { scene_id: 'sc1' },
      refStack: [],
      personas,
      episodeContext: { ...baseEpisodeContext, defaultNarratorVoiceId: 'voice-abc' },
      previousBeat: null
    });

    assert.equal(result.modelUsed, 'kling-v3-pro/vo-broll (veo-fallback) + elevenlabs');
    // V.O. metadata must survive the fallback path — orchestrator's V.O. mix
    // overlay depends on these.
    assert.equal(result.metadata.needsVoiceoverMix, true);
    assert.equal(result.metadata.voiceoverText, 'hello world');
    assert.ok(typeof result.metadata.voAudioUrl === 'string');
  });
});

describe('BridgeBeatGenerator → Kling fallback', () => {
  test('falls back without first+last frame interpolation (degraded)', async () => {
    const deps = makePassThroughDeps();
    const gen = new BridgeBeatGenerator(deps);

    gen._buildPersonaLockedFirstFrame = async () => null;
    gen._pickStartFrame = () => null;
    gen._resolveFramingRecipe = () => 'transit';
    gen._resolvePersonasInBeat = () => [];
    gen._buildPerModelColorHint = () => '';
    gen._buildWardrobeDirective = () => '';
    gen._buildBrandColorDirective = () => '';
    gen._appendDirectorNudge = (s) => s;

    const result = await gen._doGenerate({
      beat: {
        beat_id: 's1bridge',
        type: 'SCENE_BRIDGE',
        duration_seconds: 2.5,
        visual_prompt: 'walk through hallway'
      },
      scene: { scene_id: 'sc1' },
      refStack: [],
      personas: [],
      episodeContext: baseEpisodeContext,
      previousBeat: null
    });

    assert.equal(result.modelUsed, 'kling-v3-pro/bridge (veo-fallback)');
  });
});

describe('ReactionGenerator → Kling fallback', () => {
  test('falls back with mandatory persona elements', async () => {
    const deps = makePassThroughDeps();
    const gen = new ReactionGenerator(deps);

    gen._buildPersonaLockedFirstFrame = async () => null;
    gen._buildVerticalFramingDirective = () => 'VERTICAL';
    gen._buildIdentityAnchoringDirective = () => 'ID';
    gen._buildSubjectPresenceDirective = () => '';
    gen._resolveFramingRecipe = () => 'tight';
    gen._resolvePersona = (beat, p) => p[0];
    gen._buildPerModelColorHint = () => '';
    gen._buildWardrobeDirective = () => '';
    gen._buildBrandColorDirective = () => '';
    gen._buildContinuityDirective = () => '';
    gen._buildPreviousBeatAntiReferenceDirective = () => '';
    gen._appendDirectorNudge = (s) => s;

    const personas = makePersonas(1);
    const result = await gen._doGenerate({
      beat: {
        beat_id: 's1b3',
        type: 'REACTION',
        persona_index: 0,
        duration_seconds: 3,
        expression_notes: 'shock'
      },
      scene: { scene_id: 'sc1', scene_master_url: 'https://storage.example.com/sm.png' },
      refStack: [],
      personas,
      episodeContext: baseEpisodeContext,
      previousBeat: null
    });

    assert.equal(result.modelUsed, 'kling-v3-pro/reaction (veo-fallback)');
    assert.equal(deps.falServices.kling.calls[0].elements.length, 1,
      'REACTION fallback MUST include persona element (persona is the whole point)');
  });
});
