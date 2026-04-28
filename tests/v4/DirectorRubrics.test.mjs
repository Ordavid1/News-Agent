// tests/v4/DirectorRubrics.test.mjs
//
// Smoke tests for the four checkpoint rubric prompt builders. These verify
// that the builders construct well-formed system+user prompts (or system+parts
// for multimodal lenses) without throwing, that the §7 verdict-contract
// reminder is present, and that lens-specific dimensions appear in the
// system prompt for the model to score against.
//
// These do NOT call Vertex — they validate the prompt construction layer
// in isolation. Pair with DirectorRetryPolicy.test.mjs for full Phase 1
// unit-test coverage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScreenplayJudgePrompt } from '../../services/v4/director-rubrics/screenplayRubric.mjs';
import { buildSceneMasterJudgePrompt } from '../../services/v4/director-rubrics/sceneMasterRubric.mjs';
import { buildBeatJudgePrompt } from '../../services/v4/director-rubrics/beatRubric.mjs';
import { buildEpisodeJudgePrompt } from '../../services/v4/director-rubrics/episodeRubric.mjs';
import {
  SCREENPLAY_VERDICT_SCHEMA,
  SCENE_MASTER_VERDICT_SCHEMA,
  BEAT_VERDICT_SCHEMA,
  EPISODE_VERDICT_SCHEMA,
  VERDICT_ENUMS
} from '../../services/v4/director-rubrics/verdictSchema.mjs';
import { buildSharedSystemHeader, buildGenreRegisterHint } from '../../services/v4/director-rubrics/sharedHeader.mjs';

const FAKE_SCENE_GRAPH = {
  title: 'Test Episode',
  central_dramatic_question: 'Test?',
  scenes: [
    { scene_id: 'sc_01', scene_goal: 'Establish', beats: [{ beat_id: 'b_01', type: 'B_ROLL_ESTABLISHING', duration_seconds: 4 }] }
  ]
};
const FAKE_PERSONAS = [
  { name: 'Test Persona', want: 'a thing', need: 'another thing' }
];

// ─── Verdict schema ───
test('verdict schema — four checkpoint variants present', () => {
  assert.equal(SCREENPLAY_VERDICT_SCHEMA.properties.checkpoint.enum[0], 'screenplay');
  assert.equal(SCENE_MASTER_VERDICT_SCHEMA.properties.checkpoint.enum[0], 'scene_master');
  assert.equal(BEAT_VERDICT_SCHEMA.properties.checkpoint.enum[0], 'beat');
  assert.equal(EPISODE_VERDICT_SCHEMA.properties.checkpoint.enum[0], 'episode');
});

test('verdict schema — verdict enum locked to exactly 4 values', () => {
  assert.deepEqual(SCREENPLAY_VERDICT_SCHEMA.properties.verdict.enum, [
    'pass', 'pass_with_notes', 'soft_reject', 'hard_reject'
  ]);
});

test('verdict schema — required fields locked', () => {
  const required = SCREENPLAY_VERDICT_SCHEMA.required;
  assert.ok(required.includes('checkpoint'));
  assert.ok(required.includes('verdict'));
  assert.ok(required.includes('overall_score'));
  assert.ok(required.includes('dimension_scores'));
  assert.ok(required.includes('findings'));
  assert.ok(required.includes('commendations'));
  assert.ok(required.includes('retry_authorization'));
});

test('verdict schema — finding object enforces snake_case-id + remediation block', () => {
  const findingItem = SCREENPLAY_VERDICT_SCHEMA.properties.findings.items;
  assert.ok(findingItem.required.includes('id'));
  assert.ok(findingItem.required.includes('severity'));
  assert.ok(findingItem.required.includes('scope'));
  assert.ok(findingItem.required.includes('message'));
  assert.ok(findingItem.required.includes('evidence'));
  assert.ok(findingItem.required.includes('remediation'));
  assert.deepEqual(findingItem.properties.severity.enum, ['critical', 'warning', 'note']);

  const remediation = findingItem.properties.remediation;
  assert.ok(remediation.required.includes('action'));
  assert.ok(remediation.required.includes('prompt_delta'));
  assert.ok(remediation.required.includes('target_fields'));
});

test('verdict schema — commendations is a non-empty string array, capped at 2', () => {
  const commendations = SCREENPLAY_VERDICT_SCHEMA.properties.commendations;
  assert.equal(commendations.type, 'array');
  assert.equal(commendations.items.type, 'string');
  assert.equal(commendations.minItems, 1);
  assert.equal(commendations.maxItems, 2);
  assert.equal(commendations.items.maxLength, 100);
});

// ──────────────────────────────────────────────────────────────
// dimension_scores — explicit per-checkpoint enumeration 2026-04-26
// Root cause of MAX_TOKENS blowout: additionalProperties: { type: 'integer' }
// (schema-value form) is intermittently ignored by Vertex AI, causing the model
// to emit verbose prose values (8177 tokens vs expected ~400). Fix: enumerate
// each checkpoint's dimension keys explicitly with additionalProperties: false
// (boolean form — reliably supported by Vertex AI).
// ──────────────────────────────────────────────────────────────
test('verdict schema — dimension_scores uses additionalProperties:false (boolean, not schema-value)', () => {
  for (const schema of [SCREENPLAY_VERDICT_SCHEMA, SCENE_MASTER_VERDICT_SCHEMA, BEAT_VERDICT_SCHEMA, EPISODE_VERDICT_SCHEMA]) {
    const ds = schema.properties.dimension_scores;
    assert.strictEqual(ds.additionalProperties, false, 'must be boolean false, not a schema object');
    assert.ok(Array.isArray(ds.propertyOrdering) && ds.propertyOrdering.length > 0, 'propertyOrdering must be present and non-empty');
    assert.ok(typeof ds.properties === 'object' && Object.keys(ds.properties).length > 0, 'at least one named property must be present');
    const firstKey = ds.propertyOrdering[0];
    assert.equal(ds.properties[firstKey]?.type, 'integer', 'dimension properties must be type:integer');
    assert.equal(ds.properties[firstKey]?.minimum, 0);
    assert.equal(ds.properties[firstKey]?.maximum, 100);
  }
});

test('verdict schema — dimension_scores per-checkpoint keys match rubric', () => {
  assert.deepEqual(SCREENPLAY_VERDICT_SCHEMA.properties.dimension_scores.propertyOrdering, [
    'story_spine', 'character_voice', 'dialogue_craft', 'subtext_density',
    'scene_structure', 'escalation', 'genre_fidelity', 'sonic_world_coherence', 'cliffhanger'
  ]);
  assert.deepEqual(SCENE_MASTER_VERDICT_SCHEMA.properties.dimension_scores.propertyOrdering, [
    'composition', 'nine_sixteen_storytelling', 'persona_fidelity',
    'genre_register_visual', 'lut_mood_fit', 'wardrobe_props_credibility', 'directorial_interest'
  ]);
  assert.deepEqual(BEAT_VERDICT_SCHEMA.properties.dimension_scores.propertyOrdering, [
    'performance_credibility', 'lipsync_integrity', 'eyeline_blocking',
    'lighting_continuity', 'lens_continuity', 'camera_move_intent',
    'identity_lock', 'model_signature_check',
    // Phase 4 (2026-04-27) — natural product placement guardrails.
    'product_identity_lock', 'product_subtlety'
  ]);
  assert.deepEqual(EPISODE_VERDICT_SCHEMA.properties.dimension_scores.propertyOrdering, [
    'rhythm', 'music_dialogue_ducking_feel', 'sonic_continuity',
    'lut_consistency_cross_scene', 'transition_intent', 'subtitle_legibility_taste',
    'title_endcard_taste', 'cross_scene_continuity', 'cliffhanger_sting'
  ]);
});

// ──────────────────────────────────────────────────────────────
// Length-discipline caps — tightened 2026-04-26 after observing hard_reject
// verdicts filling 3200+ visible tokens at budget 24576 (candidate=3208,
// MAX_TOKENS). Root cause: Vertex validates maxItems/maxLength post-hoc, NOT
// during token generation. Model writes AT the cap limits, so reducing them
// directly reduces visible output size. Target: ≤ 1200 tokens total verdict.
// ──────────────────────────────────────────────────────────────
test('verdict schema — findings array capped at 3 items', () => {
  assert.equal(SCREENPLAY_VERDICT_SCHEMA.properties.findings.maxItems, 3);
  assert.equal(BEAT_VERDICT_SCHEMA.properties.findings.maxItems, 3);
  assert.equal(EPISODE_VERDICT_SCHEMA.properties.findings.maxItems, 3);
});

test('verdict schema — finding string fields have tight single-sentence caps', () => {
  const finding = SCREENPLAY_VERDICT_SCHEMA.properties.findings.items.properties;
  assert.equal(finding.message.maxLength, 120);
  assert.equal(finding.evidence.maxLength, 80);
  assert.equal(finding.remediation.properties.prompt_delta.maxLength, 120);
});

test('verdict schema — finding.id and scope have tight caps', () => {
  const finding = SCREENPLAY_VERDICT_SCHEMA.properties.findings.items.properties;
  assert.equal(finding.id.maxLength, 40);
  assert.equal(finding.scope.maxLength, 30);
});

test('verdict schema — propertyOrdering present on root + finding item + remediation (Vertex AI requirement)', () => {
  // Without propertyOrdering, Vertex explores all property orderings during generation,
  // consuming extra structured-output planning tokens and causing MAX_TOKENS truncation.
  for (const schema of [SCREENPLAY_VERDICT_SCHEMA, BEAT_VERDICT_SCHEMA, EPISODE_VERDICT_SCHEMA]) {
    assert.ok(Array.isArray(schema.propertyOrdering), 'root schema missing propertyOrdering');
    assert.ok(schema.propertyOrdering.includes('checkpoint'), 'checkpoint not in root propertyOrdering');
    assert.ok(schema.propertyOrdering.includes('findings'), 'findings not in root propertyOrdering');

    const findingItem = schema.properties.findings.items;
    assert.ok(Array.isArray(findingItem.propertyOrdering), 'finding item missing propertyOrdering');
    assert.ok(findingItem.propertyOrdering.includes('message'), 'message not in finding propertyOrdering');

    const remediation = findingItem.properties.remediation;
    assert.ok(Array.isArray(remediation.propertyOrdering), 'remediation missing propertyOrdering');
    assert.ok(remediation.propertyOrdering.includes('action'), 'action not in remediation propertyOrdering');
    assert.ok(remediation.propertyOrdering.includes('prompt_delta'), 'prompt_delta not in remediation propertyOrdering');
  }
});

test('VERDICT_ENUMS — exposes verdict + severity + action enums', () => {
  assert.equal(VERDICT_ENUMS.verdict.length, 4);
  assert.equal(VERDICT_ENUMS.severity.length, 3);
  assert.ok(VERDICT_ENUMS.action.includes('regenerate_beat'));
  assert.ok(VERDICT_ENUMS.action.includes('user_review'));
});

// ─── Shared header ───
test('shared header — contains layer-3 discipline and verdict contract reminder', () => {
  const header = buildSharedSystemHeader();
  assert.match(header, /LAYER 3/);
  assert.match(header, /findings \(NOT issues\)/);
  assert.match(header, /commendations \(NOT strengths\)/);
  assert.match(header, /pass, pass_with_notes, soft_reject, hard_reject/);
  assert.match(header, /critical, warning, note/);
});

test('genre register hint — drama and action produce distinct directives', () => {
  // Phase 2 — both legacy inline and library renderings must produce DISTINCT
  // directives per genre. The assertion is on differentiation + presence of
  // genre-substantive vocabulary (broadened to match BOTH renderings).
  const drama = buildGenreRegisterHint('drama');
  const action = buildGenreRegisterHint('action');
  assert.match(drama, /drama/i);
  assert.match(drama, /SHOT_REVERSE_SHOT|subtext|deflection|REACTION/i);
  assert.match(action, /action/i);
  assert.match(action, /ACTION_NO_DIALOGUE|130-160 BPM|kinetic|clipped/i);
  assert.notEqual(drama, action);
});

// ─── Lens A — screenplay ───
test('Lens A builder — returns systemPrompt + userPrompt with required dimensions', () => {
  const { systemPrompt, userPrompt } = buildScreenplayJudgePrompt({
    sceneGraph: FAKE_SCENE_GRAPH,
    personas: FAKE_PERSONAS,
    storyFocus: 'drama'
  });
  assert.ok(systemPrompt.length > 1000, 'system prompt must be substantive');
  assert.ok(userPrompt.length > 100, 'user prompt must include scene_graph + personas');
  assert.match(systemPrompt, /CHECKPOINT A/);
  assert.match(systemPrompt, /story_spine/);
  assert.match(systemPrompt, /character_voice/);
  assert.match(systemPrompt, /cliffhanger/);
  assert.match(userPrompt, /<screenplay>/);
  assert.match(userPrompt, /<personas>/);
});

test('Lens A builder — isRetry=true adds retry_authorization=false directive', () => {
  const { systemPrompt } = buildScreenplayJudgePrompt({
    sceneGraph: FAKE_SCENE_GRAPH,
    personas: FAKE_PERSONAS,
    isRetry: true
  });
  assert.match(systemPrompt, /SECOND attempt/);
  assert.match(systemPrompt, /retry_authorization MUST be false/);
});

// ─── Lens B — Scene Master ───
test('Lens B builder — multimodal: returns systemPrompt + userParts with image part', () => {
  const { systemPrompt, userParts } = buildSceneMasterJudgePrompt({
    scene: { scene_id: 'sc_01', scene_goal: 'establish', beats: [] },
    sceneMasterImage: 'https://example.com/scene-master.jpg',
    personas: FAKE_PERSONAS,
    lutId: 'bs_urban_grit',
    visualStylePrefix: 'late autumn',
    storyFocus: 'drama'
  });
  assert.match(systemPrompt, /CHECKPOINT B/);
  assert.match(systemPrompt, /persona_fidelity/);
  assert.match(systemPrompt, /nine_sixteen_storytelling/);
  assert.ok(Array.isArray(userParts));
  assert.ok(userParts.length >= 4);
  // an image part must be present (file_data when URL, inline_data when buffer)
  const hasImagePart = userParts.some(p => p.file_data || p.inline_data);
  assert.ok(hasImagePart, 'multimodal prompt must include a Scene Master image part');
});

test('Lens B builder — Buffer input becomes inline_data part', () => {
  const buf = Buffer.from('fake-jpg-bytes');
  const { userParts } = buildSceneMasterJudgePrompt({
    scene: { scene_id: 'sc_01', scene_goal: 'establish', beats: [] },
    sceneMasterImage: buf,
    personas: FAKE_PERSONAS
  });
  const inlinePart = userParts.find(p => p.inline_data);
  assert.ok(inlinePart);
  assert.equal(inlinePart.inline_data.mime_type, 'image/jpeg');
  assert.ok(inlinePart.inline_data.data.length > 0);
});

test('Lens B builder — throws if no Scene Master image provided', () => {
  assert.throws(() => buildSceneMasterJudgePrompt({
    scene: { scene_id: 'sc_01', scene_goal: 'establish', beats: [] },
    sceneMasterImage: null,
    personas: FAKE_PERSONAS
  }), /sceneMasterImage required/);
});

// ─── Lens C — beat ───
test('Lens C builder — returns systemPrompt + userParts with endframe (required)', () => {
  const { systemPrompt, userParts } = buildBeatJudgePrompt({
    beat: { beat_id: 'b_03', type: 'TALKING_HEAD_CLOSEUP', dialogue: 'Test', subtext: 'Subtext', duration_seconds: 5 },
    scene: { scene_id: 'sc_01', scene_goal: 'establish', ambient_bed_prompt: '', opposing_intents: [] },
    endframeImage: 'https://example.com/endframe.jpg',
    personas: FAKE_PERSONAS,
    storyFocus: 'drama'
  });
  assert.match(systemPrompt, /CHECKPOINT C/);
  assert.match(systemPrompt, /performance_credibility/);
  assert.match(systemPrompt, /lipsync_integrity/);
  assert.match(systemPrompt, /identity_lock/);
  const hasImagePart = userParts.some(p => p.file_data || p.inline_data);
  assert.ok(hasImagePart);
});

test('Lens C builder — throws when endframe missing', () => {
  assert.throws(() => buildBeatJudgePrompt({
    beat: { beat_id: 'b_03', type: 'TALKING_HEAD_CLOSEUP' },
    scene: { scene_id: 'sc_01' },
    endframeImage: null,
    personas: FAKE_PERSONAS
  }), /endframe.*required/i);
});

test('Lens C builder — optional previous endframe + scene master thumbnail attached when provided', () => {
  const { userParts } = buildBeatJudgePrompt({
    beat: { beat_id: 'b_03', type: 'TALKING_HEAD_CLOSEUP', duration_seconds: 5 },
    scene: { scene_id: 'sc_01' },
    endframeImage: 'https://example.com/endframe.jpg',
    previousEndframeImage: 'https://example.com/prev-endframe.jpg',
    sceneMasterThumbnail: 'https://example.com/scene-master.jpg',
    personas: FAKE_PERSONAS
  });
  // Three image parts: scene master, previous endframe, current endframe
  const imageParts = userParts.filter(p => p.file_data || p.inline_data);
  assert.equal(imageParts.length, 3);
});

// ─── Lens D — episode ───
//
// 2026-04-28 transport rewrite: video MUST be inline_data buffer (preferred)
// or a gs:// URI. Arbitrary HTTPS URLs are rejected — Vertex returns 400 for
// video file_uri unless GCS or Files API.
test('Lens D builder — accepts inline_data video buffer', () => {
  const fakeBuffer = Buffer.from('fake-mp4-bytes');
  const { systemPrompt, userParts } = buildEpisodeJudgePrompt({
    episodeVideoBuffer: fakeBuffer,
    sceneGraph: FAKE_SCENE_GRAPH,
    storyFocus: 'drama'
  });
  assert.match(systemPrompt, /CHECKPOINT D/);
  assert.match(systemPrompt, /ADVISORY ONLY/);
  assert.match(systemPrompt, /retry_authorization MUST always be false/);
  assert.match(systemPrompt, /rhythm/);
  assert.match(systemPrompt, /cliffhanger_sting/);
  const videoPart = userParts.find(p => p.inline_data);
  assert.ok(videoPart, 'expected an inline_data video part');
  assert.equal(videoPart.inline_data.mime_type, 'video/mp4');
  assert.equal(videoPart.inline_data.data, fakeBuffer.toString('base64'));
});

test('Lens D builder — accepts gs:// video URL via file_data', () => {
  const { userParts } = buildEpisodeJudgePrompt({
    episodeVideoUrl: 'gs://my-bucket/final.mp4',
    sceneGraph: FAKE_SCENE_GRAPH,
    storyFocus: 'drama'
  });
  const videoPart = userParts.find(p => p.file_data);
  assert.ok(videoPart, 'expected a file_data video part for gs:// URI');
  assert.equal(videoPart.file_data.mime_type, 'video/mp4');
});

test('Lens D builder — throws when no buffer + no gs:// URI supplied', () => {
  assert.throws(() => buildEpisodeJudgePrompt({
    episodeVideoUrl: 'https://supabase.example.com/final.mp4',  // arbitrary HTTPS rejected
    sceneGraph: FAKE_SCENE_GRAPH
  }), /buffer required|gs:\/\//);
});

test('Lens D builder — throws when both video sources missing', () => {
  assert.throws(() => buildEpisodeJudgePrompt({
    sceneGraph: FAKE_SCENE_GRAPH
  }), /episodeVideoBuffer.*or episodeVideoUrl required/);
});
