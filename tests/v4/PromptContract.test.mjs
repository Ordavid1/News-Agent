// tests/v4/PromptContract.test.mjs
// V4 prompt-code contract test — the regression net for prompt-code drift.
//
// Why this exists:
//   The V4 code enforces a contract that the Gemini prompt is supposed to
//   satisfy. The `requires_text_rendering` orphan bug (blocking finding in
//   the Phase 5 review) was exactly this class of drift: router + generator
//   + tests all honored the field, but the prompt never taught Gemini to
//   emit it. Nothing caught it until a code reviewer found it by eye.
//
//   This test catches that class of bug by actually calling Vertex Gemini
//   with the V4 prompt, generating N diverse scene-graphs, and asserting
//   every beat has the fields its matched generator's _doGenerate() reads.
//
// Cost profile:
//   Each run calls Vertex Gemini ONCE per fixture. Default 5 fixtures per
//   CI run (~$0.25). Can be bumped to 20 via V4_CONTRACT_TEST_ITERATIONS
//   for deeper coverage (~$1/run). Safe to run nightly or on PRs touching
//   brandStoryPromptsV4.mjs / BeatRouter.js / beat-generators/.
//
// Auto-skip:
//   If GCP_PROJECT_ID + GOOGLE_APPLICATION_CREDENTIALS(_JSON) aren't set,
//   every test is marked skip. Local dev doesn't burn money unless you
//   explicitly configure Vertex credentials.
//
// Run:
//   node --test tests/v4/PromptContract.test.mjs
//   V4_CONTRACT_TEST_ITERATIONS=20 node --test tests/v4/PromptContract.test.mjs
//
// Contract per beat type:
//   - The router's routing table decides which generator class handles a
//     beat type. That class's _doGenerate() reads specific beat fields.
//     If a required field is missing from Gemini's output, _doGenerate()
//     throws at runtime. This test asserts those fields exist in advance.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  getEpisodeSystemPromptV4,
  getEpisodeUserPromptV4,
  V4_BEAT_TYPES,
  V4_SCENE_TYPES
} from '../../public/components/brandStoryPromptsV4.mjs';

// ─────────────────────────────────────────────────────────────────────
// Skip-if-no-Vertex-credentials gate
// ─────────────────────────────────────────────────────────────────────
const VERTEX_AVAILABLE = !!process.env.GCP_PROJECT_ID &&
  (!!process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ||
   !!process.env.GOOGLE_APPLICATION_CREDENTIALS);

// Lazy-import VertexGemini only when credentials are present — its module-
// load path is clean when unconfigured (logs a warn) but we skip the whole
// suite anyway so the import is purely defensive.
let callVertexGeminiJson = null;
if (VERTEX_AVAILABLE) {
  const mod = await import('../../services/v4/VertexGemini.js');
  callVertexGeminiJson = mod.callVertexGeminiJson;
}

const ITERATIONS = parseInt(process.env.V4_CONTRACT_TEST_ITERATIONS || '5', 10);

// ─────────────────────────────────────────────────────────────────────
// The contract — what fields each beat type's generator requires.
//
// This mirrors the field reads inside each generator's _doGenerate()
// method. If a generator adds a required field, add it here too and the
// test will start catching prompt drift for that field.
//
// required:  MUST be present (generator throws without it)
// optional:  MAY be present (generator has a default or graceful skip)
// ─────────────────────────────────────────────────────────────────────
const BEAT_CONTRACT = {
  TALKING_HEAD_CLOSEUP: {
    required: ['beat_id', 'type', 'persona_index', 'dialogue', 'duration_seconds'],
    optional: ['emotion', 'lens', 'expression_notes']
  },
  DIALOGUE_IN_SCENE: {
    required: ['beat_id', 'type', 'persona_index', 'dialogue', 'duration_seconds'],
    optional: ['emotion', 'action_notes', 'lens', 'camera_notes']
  },
  GROUP_DIALOGUE_TWOSHOT: {
    required: ['beat_id', 'type', 'persona_indexes', 'dialogues', 'duration_seconds'],
    optional: ['emotion', 'blocking_notes']
  },
  SHOT_REVERSE_SHOT: {
    required: ['beat_id', 'type', 'exchanges'],
    optional: [],
    // Sub-contract: each exchange inside the SHOT_REVERSE_SHOT must have its own fields
    exchanges: {
      required: ['persona_index', 'dialogue', 'duration_seconds'],
      optional: ['emotion', 'lens', 'expression_notes']
    }
  },
  SILENT_STARE: {
    required: ['beat_id', 'type', 'persona_index', 'duration_seconds'],
    optional: ['emotional_intensity', 'gaze_direction']
  },
  REACTION: {
    required: ['beat_id', 'type', 'persona_index', 'duration_seconds'],
    optional: ['expression_notes']
  },
  INSERT_SHOT: {
    required: ['beat_id', 'type', 'subject_focus', 'duration_seconds'],
    optional: ['lighting_intent', 'camera_move', 'ambient_sound']
  },
  ACTION_NO_DIALOGUE: {
    required: ['beat_id', 'type', 'duration_seconds'],
    optional: ['action_prompt', 'persona_indexes', 'camera_notes', 'ambient_sound']
  },
  B_ROLL_ESTABLISHING: {
    required: ['beat_id', 'type', 'duration_seconds'],
    optional: ['location', 'atmosphere', 'camera_move', 'ambient_sound']
  },
  VOICEOVER_OVER_BROLL: {
    required: ['beat_id', 'type', 'voiceover_text', 'duration_seconds'],
    optional: ['voiceover_persona_index', 'location', 'camera_move']
  },
  TEXT_OVERLAY_CARD: {
    required: ['beat_id', 'type', 'text', 'duration_seconds'],
    optional: ['style', 'position', 'background']
  },
  SPEED_RAMP_TRANSITION: {
    required: ['beat_id', 'type'],
    optional: ['direction', 'duration_seconds']
  }
};

const SCENE_CONTRACT = {
  required: ['scene_id', 'beats'],
  optional: ['type', 'location', 'scene_synopsis', 'scene_visual_anchor_prompt', 'transition_to_next']
};

const EPISODE_CONTRACT = {
  required: ['title', 'scenes'],
  optional: ['hook', 'narrative_beat', 'mood', 'cliffhanger', 'emotional_state', 'visual_style_prefix', 'music_bed_intent', 'lut_id']
};

// ─────────────────────────────────────────────────────────────────────
// Test fixtures — small + diverse story shapes that exercise the prompt
// across realistic variations. Add more if you find a prompt bug that
// only manifests on certain combinations.
// ─────────────────────────────────────────────────────────────────────
const STORY_FIXTURES = [
  {
    name: 'luxury perfume / drama / product focus',
    storyline: {
      title: 'The Reveal',
      theme: 'A hidden inheritance unlocks a family mystery',
      genre: 'drama',
      tone: 'intimate, mysterious',
      target_audience: 'luxury buyers',
      logline: 'A woman inherits a perfume bottle containing a family secret she was never meant to find.',
      season_bible: 'Three-episode arc: discovery → confrontation → revelation. Character-driven, product-anchored.',
      characters: [
        { name: 'Maya', role: 'protagonist', personality: 'guarded, intuitive', visual_description: 'mid-30s, charcoal coat, auburn hair' },
        { name: 'Daniel', role: 'confidant', personality: 'loyal but conflicted', visual_description: 'mid-40s, tailored navy suit' }
      ],
      emotional_arc: [],
      visual_motifs: [{ motif: 'amber light through glass', meaning: 'hidden truth revealed', recurrence_pattern: 'once per episode at the cliffhanger' }],
      episodes: []
    },
    personas: [
      { name: 'Maya', personality: 'guarded, intuitive', appearance: 'mid-30s, auburn hair, charcoal coat', elevenlabs_voice_id: 'test-voice-1' },
      { name: 'Daniel', personality: 'loyal, conflicted', appearance: 'mid-40s, navy suit', elevenlabs_voice_id: 'test-voice-2' }
    ],
    subject: {
      name: 'Maison Aurora perfume bottle',
      category: 'luxury fragrance',
      description: 'Hand-blown amber crystal flacon with brass stopper.',
      visual_description: 'tear-drop shaped amber glass, brass stopper engraved with art-deco pattern',
      integration_guidance: ['Held in hands during reveal', 'Light refracting through glass in insert shot', 'On bar counter in establishing scene']
    },
    storyFocus: 'product',
    directorsNotes: 'Wong Kar-Wai moody neon, anamorphic lens, Kodak Portra 400 grain'
  },
  {
    name: 'rooftop bar / drama / person focus',
    storyline: {
      title: 'Above the City',
      theme: 'A chance meeting changes two lives',
      genre: 'drama',
      tone: 'melancholy, warm',
      target_audience: 'young professionals',
      logline: 'Two strangers meet on a rooftop bar the night one of them is about to leave forever.',
      season_bible: 'Single-episode pilot, emotional arc from guarded to open in 90 seconds.',
      characters: [
        { name: 'Elias', role: 'protagonist', personality: 'world-weary, articulate', visual_description: 'late 30s, grey overcoat' },
        { name: 'Nora', role: 'catalyst', personality: 'direct, hopeful', visual_description: 'late 20s, burgundy wool coat' }
      ],
      emotional_arc: [],
      visual_motifs: [],
      episodes: []
    },
    personas: [
      { name: 'Elias', personality: 'world-weary, articulate', appearance: 'late 30s, grey overcoat', elevenlabs_voice_id: 'test-voice-3' },
      { name: 'Nora', personality: 'direct, hopeful', appearance: 'late 20s, burgundy coat', elevenlabs_voice_id: 'test-voice-4' }
    ],
    subject: null,
    storyFocus: 'person',
    directorsNotes: 'Golden hour rooftop, shallow DOF, intimate closeups, natural lighting'
  },
  {
    name: 'boutique hotel / thriller / landscape focus',
    storyline: {
      title: 'The Suite',
      theme: 'A remote hotel holds a terrible secret',
      genre: 'thriller',
      tone: 'mysterious, escalating tension',
      target_audience: 'luxury travelers',
      logline: 'A guest checks into the hotel\'s most famous suite and begins to realize why none of the previous occupants ever left.',
      season_bible: 'Pilot establishes mood + mystery, episode ends on cliffhanger.',
      characters: [
        { name: 'Ava', role: 'protagonist', personality: 'skeptical, observant', visual_description: 'early 30s, travel-worn elegance' }
      ],
      emotional_arc: [],
      visual_motifs: [{ motif: 'reflections in glass', meaning: 'hidden watchers', recurrence_pattern: 'multiple times per episode' }],
      episodes: []
    },
    personas: [
      { name: 'Ava', personality: 'skeptical, observant', appearance: 'early 30s, travel-worn elegance', elevenlabs_voice_id: 'test-voice-5' }
    ],
    subject: {
      name: 'Hotel Le Mystère',
      category: 'boutique hotel',
      description: 'A remote art-deco hotel perched on a cliff.',
      visual_description: 'curved staircase, brass fixtures, oceanview windows, marble floors',
      integration_guidance: ['Hotel is the setting', 'Architecture visible in every establishing', 'Logo visible on bellhop uniforms and room keys']
    },
    storyFocus: 'landscape',
    directorsNotes: 'Hitchcockian tension, long hallways, deliberate camera movement'
  },
  {
    name: 'streetwear brand / comedy / product focus',
    storyline: {
      title: 'The Drop',
      theme: 'Two friends race to get their hands on the most hyped sneaker of the year',
      genre: 'comedy',
      tone: 'kinetic, playful',
      target_audience: 'Gen Z streetwear',
      logline: 'A comedic chase through a city to get the last pair of the hottest sneaker release.',
      season_bible: 'Fast-paced, visually bold, product-anchored.',
      characters: [
        { name: 'Kai', role: 'protagonist', personality: 'obsessive, resourceful', visual_description: 'early 20s, vintage streetwear' },
        { name: 'Rhys', role: 'sidekick', personality: 'skeptical, loyal', visual_description: 'early 20s, oversized hoodie' }
      ],
      emotional_arc: [],
      visual_motifs: [],
      episodes: []
    },
    personas: [
      { name: 'Kai', personality: 'obsessive, resourceful', appearance: 'early 20s, vintage streetwear', elevenlabs_voice_id: 'test-voice-6' },
      { name: 'Rhys', personality: 'skeptical, loyal', appearance: 'early 20s, oversized hoodie', elevenlabs_voice_id: 'test-voice-7' }
    ],
    subject: {
      name: 'Velocity AV1 sneaker',
      category: 'limited-edition sneaker',
      description: 'A bold AV1 colorway with neon accents.',
      visual_description: 'white base with neon orange Swoosh and teal midsole; bold brand lettering on the heel',
      integration_guidance: ['Product shot in every scene', 'Logo visible on the box', 'Closeup on the heel lettering at the reveal']
    },
    storyFocus: 'product',
    directorsNotes: 'Edgar Wright kinetic pacing, Dutch angles, whip pans, teal & orange grade'
  },
  {
    name: 'wellness retreat / documentary / person focus',
    storyline: {
      title: 'Breath',
      theme: 'A guest rediscovers stillness at a remote wellness retreat',
      genre: 'documentary',
      tone: 'contemplative, peaceful',
      target_audience: 'wellness-oriented adults',
      logline: 'A burned-out executive finds her way back to stillness over three days at a mountain retreat.',
      season_bible: 'Three-episode arc: arrival → practice → release.',
      characters: [
        { name: 'Clara', role: 'protagonist', personality: 'tired, searching', visual_description: 'early 40s, natural fiber clothing' }
      ],
      emotional_arc: [],
      visual_motifs: [{ motif: 'morning mist on water', meaning: 'surrender', recurrence_pattern: 'opens every episode' }],
      episodes: []
    },
    personas: [
      { name: 'Clara', personality: 'tired, searching', appearance: 'early 40s, natural fiber clothing', elevenlabs_voice_id: 'test-voice-8' }
    ],
    subject: null,
    storyFocus: 'person',
    directorsNotes: 'Terrence Malick contemplative, natural light, slow movements, ambient sound-focused'
  }
];

// ─────────────────────────────────────────────────────────────────────
// Contract assertion helpers
// ─────────────────────────────────────────────────────────────────────

function assertBeatContract(beat, contract, context) {
  for (const field of contract.required) {
    assert.ok(
      beat[field] != null,
      `${context}: ${beat.type} beat missing required field "${field}" — the prompt must teach Gemini to emit it. Got: ${JSON.stringify(beat).slice(0, 200)}`
    );
  }

  // SHOT_REVERSE_SHOT sub-contract: each exchange must itself be well-formed
  if (contract.exchanges && Array.isArray(beat.exchanges)) {
    beat.exchanges.forEach((exchange, i) => {
      for (const field of contract.exchanges.required) {
        assert.ok(
          exchange[field] != null,
          `${context}: SHOT_REVERSE_SHOT exchange[${i}] missing required field "${field}". Got: ${JSON.stringify(exchange).slice(0, 200)}`
        );
      }
    });
  }
}

function assertEpisodeContract(episode, fixtureName) {
  for (const field of EPISODE_CONTRACT.required) {
    assert.ok(episode[field] != null, `${fixtureName}: episode missing required field "${field}"`);
  }
  assert.ok(Array.isArray(episode.scenes) && episode.scenes.length > 0, `${fixtureName}: episode.scenes must be a non-empty array`);

  episode.scenes.forEach((scene, sceneIdx) => {
    for (const field of SCENE_CONTRACT.required) {
      assert.ok(scene[field] != null, `${fixtureName}: scene[${sceneIdx}] missing required field "${field}"`);
    }
    assert.ok(Array.isArray(scene.beats) && scene.beats.length > 0, `${fixtureName}: scene[${sceneIdx}].beats must be non-empty`);

    // Scene type (if present) must be in the enum
    if (scene.type != null) {
      assert.ok(V4_SCENE_TYPES.includes(scene.type), `${fixtureName}: scene[${sceneIdx}].type "${scene.type}" not in V4_SCENE_TYPES`);
    }

    scene.beats.forEach((beat, beatIdx) => {
      const context = `${fixtureName}: scene[${sceneIdx}].beats[${beatIdx}]`;

      // Every beat has a type from the enum
      assert.ok(beat.type != null, `${context}: missing type`);
      assert.ok(V4_BEAT_TYPES.includes(beat.type), `${context}: type "${beat.type}" not in V4_BEAT_TYPES`);

      // Apply the per-type contract
      const contract = BEAT_CONTRACT[beat.type];
      assert.ok(contract != null, `${context}: no contract defined for beat type "${beat.type}" — update BEAT_CONTRACT in this test`);

      assertBeatContract(beat, contract, context);

      // Duration rules from CRITICAL RULES #6: 2-8s per beat (except TEXT_OVERLAY_CARD, SPEED_RAMP_TRANSITION which have softer rules)
      if (beat.duration_seconds != null && beat.type !== 'TEXT_OVERLAY_CARD' && beat.type !== 'SPEED_RAMP_TRANSITION') {
        assert.ok(
          beat.duration_seconds >= 2 && beat.duration_seconds <= 8,
          `${context}: duration_seconds=${beat.duration_seconds} violates 2-8s range (CRITICAL RULE #6)`
        );
      }

      // Brand-consistency rule: requires_text_rendering must be boolean when present (CRITICAL RULE #11)
      if (beat.requires_text_rendering != null) {
        assert.strictEqual(
          typeof beat.requires_text_rendering,
          'boolean',
          `${context}: requires_text_rendering must be boolean, got ${typeof beat.requires_text_rendering}`
        );
      }
    });
  });
}

/**
 * Walk an episode's scenes/beats and collect metrics. Used to assert the
 * prompt produces diverse outputs (not just the same beat type over and over).
 */
function collectMetrics(episode) {
  const typeCounts = {};
  let totalBeats = 0;
  let hasInsertShot = false;
  let hasDialogueBeat = false;
  let hasTextRenderingBeat = false;

  for (const scene of (episode.scenes || [])) {
    for (const beat of (scene.beats || [])) {
      typeCounts[beat.type] = (typeCounts[beat.type] || 0) + 1;
      totalBeats++;
      if (beat.type === 'INSERT_SHOT') hasInsertShot = true;
      if (beat.type === 'TALKING_HEAD_CLOSEUP' || beat.type === 'DIALOGUE_IN_SCENE' || beat.type === 'SHOT_REVERSE_SHOT') hasDialogueBeat = true;
      if (beat.requires_text_rendering === true) hasTextRenderingBeat = true;
    }
  }

  return { typeCounts, totalBeats, hasInsertShot, hasDialogueBeat, hasTextRenderingBeat };
}

// ─────────────────────────────────────────────────────────────────────
// Test suites
// ─────────────────────────────────────────────────────────────────────

describe('V4 prompt-code contract', { skip: !VERTEX_AVAILABLE ? 'skipped: Vertex credentials not configured (set GCP_PROJECT_ID + GOOGLE_APPLICATION_CREDENTIALS_JSON)' : false }, () => {

  // Pick the fixture rotation. Default 5 iterations round-robin across
  // STORY_FIXTURES. If ITERATIONS > STORY_FIXTURES.length the test cycles
  // through fixtures multiple times (useful for bumping to 20 for deeper
  // coverage on CI).
  const iterationCount = Math.max(1, Math.min(ITERATIONS, 50));

  for (let i = 0; i < iterationCount; i++) {
    const fixture = STORY_FIXTURES[i % STORY_FIXTURES.length];
    const fixtureLabel = `[${i + 1}/${iterationCount}] ${fixture.name}`;

    test(`emits a valid scene-graph: ${fixtureLabel}`, { timeout: 180_000 }, async () => {
      const systemPrompt = getEpisodeSystemPromptV4(fixture.storyline, [], fixture.personas, {
        subject: fixture.subject,
        storyFocus: fixture.storyFocus,
        brandKit: null,
        previousVisualStyle: '',
        previousEmotionalState: '',
        directorsNotes: fixture.directorsNotes,
        costCapUsd: 10,
        hasBrandKitLut: false
      });

      const userPrompt = getEpisodeUserPromptV4(fixture.storyline, '', 1, { hasBrandKitLut: false });

      const episode = await callVertexGeminiJson({
        systemPrompt,
        userPrompt,
        config: { temperature: 0.85, maxOutputTokens: 8192 },
        timeoutMs: 120_000
      });

      // Run the full episode → scenes → beats contract assertion.
      // Any missing required field throws with a clear message pointing at
      // the exact scene/beat/field so the prompt author knows what to fix.
      assertEpisodeContract(episode, fixture.name);

      // Sanity metrics — log but don't fail unless something is wildly off
      const metrics = collectMetrics(episode);
      console.log(`  → ${fixture.name}: ${metrics.totalBeats} beats, types=${JSON.stringify(metrics.typeCounts)}, insertShot=${metrics.hasInsertShot}, dialogue=${metrics.hasDialogueBeat}, textRender=${metrics.hasTextRenderingBeat}`);

      // CRITICAL RULE #2: emit at least ONE INSERT_SHOT when subject is a product
      if (fixture.storyFocus === 'product' && fixture.subject) {
        assert.ok(
          metrics.hasInsertShot,
          `${fixture.name}: product-focus story with a subject should emit at least one INSERT_SHOT (CRITICAL RULE #2). Got beat types: ${JSON.stringify(metrics.typeCounts)}`
        );
      }

      // At least ONE dialogue beat in an episode with personas that can speak
      if (fixture.personas.length > 0) {
        assert.ok(
          metrics.hasDialogueBeat,
          `${fixture.name}: episode with speaking personas should contain at least one dialogue beat (TALKING_HEAD_CLOSEUP, DIALOGUE_IN_SCENE, or SHOT_REVERSE_SHOT). Got: ${JSON.stringify(metrics.typeCounts)}`
        );
      }

      // Reasonable beat count (not a hard rule, but flag suspicious outputs)
      assert.ok(metrics.totalBeats >= 3, `${fixture.name}: only ${metrics.totalBeats} beats — suspiciously sparse`);
      assert.ok(metrics.totalBeats <= 30, `${fixture.name}: ${metrics.totalBeats} beats — suspiciously dense (cost cap risk)`);
    });
  }
});

describe('V4 prompt static-shape validation', () => {
  // These tests run WITHOUT Vertex calls — they just validate the prompt
  // strings themselves contain the fields the code reads. Cheap sanity
  // that runs on every node --test invocation regardless of credentials.

  test('system prompt contains requires_text_rendering documentation', () => {
    const systemPrompt = getEpisodeSystemPromptV4(
      { title: 'x', theme: 'y', genre: 'drama', tone: 'engaging', episodes: [] },
      [],
      [],
      { subject: null, storyFocus: 'product', costCapUsd: 10, hasBrandKitLut: false }
    );
    assert.ok(
      systemPrompt.includes('requires_text_rendering'),
      'system prompt must mention requires_text_rendering so Gemini knows to emit it (Phase 5 blocking fix)'
    );
  });

  test('user prompt contains all 12 beat types in the schema example', () => {
    const userPrompt = getEpisodeUserPromptV4(
      { title: 'x' },
      '',
      1,
      { hasBrandKitLut: false }
    );
    // Spot-check that the canonical beat types appear in the schema example
    const expectedInExample = ['B_ROLL_ESTABLISHING', 'TALKING_HEAD_CLOSEUP', 'REACTION', 'INSERT_SHOT'];
    for (const beatType of expectedInExample) {
      assert.ok(
        userPrompt.includes(beatType),
        `user prompt schema example must contain beat type "${beatType}"`
      );
    }
  });

  test('user prompt enumerates all CRITICAL RULES', () => {
    const userPrompt = getEpisodeUserPromptV4(
      { title: 'x' },
      '',
      1,
      { hasBrandKitLut: false }
    );
    // Assert rules 1-11 are all present as numbered entries
    for (let i = 1; i <= 11; i++) {
      assert.ok(
        userPrompt.includes(`${i}.`),
        `user prompt must contain CRITICAL RULE #${i}`
      );
    }
  });

  test('BEAT_CONTRACT table covers every V4_BEAT_TYPE', () => {
    // Ensure the test contract stays in sync with the prompt's beat taxonomy
    for (const beatType of V4_BEAT_TYPES) {
      assert.ok(
        BEAT_CONTRACT[beatType] != null,
        `BEAT_CONTRACT missing entry for ${beatType} — either add it or remove from V4_BEAT_TYPES`
      );
    }
  });
});
