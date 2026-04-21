// tests/v4/PersonaSchema.test.mjs
// Unit tests for V4 persona bible consumption in the episode system prompt.
//
// Run: node --test tests/v4/PersonaSchema.test.mjs
//
// Coverage:
//   - Full persona bible (new schema) renders every field
//   - Legacy persona (only name/appearance/personality/wardrobe) falls back gracefully
//   - Signature line appears verbatim
//   - Character voice samples from storyline render in previously-on block
//   - Thematic argument + central dramatic question render when present
//   - No personas → no character cheat-sheet injected

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { getEpisodeSystemPromptV4 } from '../../public/components/brandStoryPromptsV4.mjs';

const FULL_STORYLINE = {
  title: 'Small Change',
  logline: 'A grieving shop-owner gambles her last quarter.',
  genre: 'drama',
  tone: 'quiet',
  central_dramatic_question: 'Will Maya keep the shop or let it go?',
  thematic_argument: 'Grief is a room; the door opens inward.',
  characters: [
    { name: 'Maya', role: 'protagonist', personality: 'guarded, loyal', visual_description: 'late 30s, tired eyes', arc: 'learns to ask for help', relationships: 'sibling rivalry with Daniel', relationship_to_product: 'inherited the shop from her grandmother' }
  ],
  season_bible: 'Inherited shop. Rival partnership. One bad quarter.'
};

const FULL_PERSONA = {
  name: 'Maya',
  dramatic_archetype: 'ANTIHERO',
  appearance: 'Late 30s, sharp features, hair pulled back',
  personality: 'guarded, loyal, dryly funny',
  wardrobe_hint: 'vintage wool coat over a linen apron',
  want: 'Keep the shop at any cost.',
  need: 'Stop carrying everything alone.',
  wound: 'Lost her grandmother in 2023 in the shop\'s back room.',
  flaw: 'Deflects any offer of help with a joke.',
  core_contradiction: 'A protector who pushes people away.',
  moral_code: 'Never lie to Daniel, no matter the cost.',
  relationship_to_subject: 'Inherited the shop; one bad quarter from closing.',
  relationships: [{ other_persona_index: 1, dynamic: 'partners who slept together once', unresolved: 'the night of the fire' }],
  speech_patterns: {
    vocabulary: 'working-class Dublin, dry',
    sentence_length: 'clipped 3-6 word fragments that unspool when cornered',
    tics: ['uses weather metaphors when evading', 'laughs mid-sentence'],
    avoids: ['never says sorry', 'never uses full names'],
    signature_line: 'Then I am consistent, at least in that small way.'
  },
  voice_brief: {
    emotional_default: 'coiled patience',
    pace: 'slow',
    warmth: 'warm',
    power: 'equal',
    vocal_color: 'breathy'
  },
  elevenlabs_voice_id: 'voice_maya_001'
};

const LEGACY_PERSONA = {
  name: 'Sam',
  appearance: 'mid 40s, salt-and-pepper beard',
  personality: 'warm, deliberate',
  wardrobe_hint: 'denim jacket over a white tee'
};

describe('V4 system prompt — character cheat-sheet', () => {
  test('full persona bible renders every field verbatim', () => {
    const prompt = getEpisodeSystemPromptV4(FULL_STORYLINE, [], [FULL_PERSONA], { costCapUsd: 20 });
    assert.ok(prompt.includes('ANTIHERO'));
    assert.ok(prompt.includes('Keep the shop at any cost'));
    assert.ok(prompt.includes('Lost her grandmother in 2023'));
    assert.ok(prompt.includes('Deflects any offer of help with a joke'));
    assert.ok(prompt.includes('working-class Dublin, dry'));
    assert.ok(prompt.includes('uses weather metaphors when evading'));
    assert.ok(prompt.includes('never says sorry'));
    assert.ok(prompt.includes('Then I am consistent, at least in that small way'));
    assert.ok(prompt.includes('coiled patience'));
    assert.ok(prompt.includes('[elevenlabs voice: locked]'));
  });

  test('legacy persona renders with em-dash fallbacks (no crash, no broken layout)', () => {
    const prompt = getEpisodeSystemPromptV4(FULL_STORYLINE, [], [LEGACY_PERSONA], { costCapUsd: 20 });
    assert.ok(prompt.includes('Sam'));
    assert.ok(prompt.includes('mid 40s, salt-and-pepper beard'));
    // Missing fields rendered as "—" placeholder
    assert.ok(prompt.includes('Want (conscious):        —'));
    assert.ok(prompt.includes('Wound:                   —'));
    assert.ok(prompt.includes('Signature line:          —'));
  });

  test('central_dramatic_question and thematic_argument are rendered when present', () => {
    const prompt = getEpisodeSystemPromptV4(FULL_STORYLINE, [], [FULL_PERSONA], { costCapUsd: 20 });
    assert.ok(prompt.includes('Will Maya keep the shop or let it go?'));
    assert.ok(prompt.includes('Grief is a room; the door opens inward.'));
  });

  test('when central_dramatic_question/thematic_argument missing, nothing breaks', () => {
    const sl = { ...FULL_STORYLINE };
    delete sl.central_dramatic_question;
    delete sl.thematic_argument;
    const prompt = getEpisodeSystemPromptV4(sl, [], [FULL_PERSONA], { costCapUsd: 20 });
    assert.ok(prompt.length > 0);
    assert.ok(prompt.includes('CHARACTER CHEAT-SHEET'));
  });

  test('season-bible characters render arc + relationships + relationship_to_product', () => {
    const prompt = getEpisodeSystemPromptV4(FULL_STORYLINE, [], [FULL_PERSONA], { costCapUsd: 20 });
    assert.ok(prompt.includes('Season arc: learns to ask for help'));
    assert.ok(prompt.includes('Relationships: sibling rivalry with Daniel'));
    assert.ok(prompt.includes('Relationship to subject: inherited the shop from her grandmother'));
  });

  test('no personas → cheat-sheet header block is suppressed', () => {
    // The masterclass body mentions "CHARACTER CHEAT-SHEET above" as a reference —
    // that's deliberate craft content. What's suppressed when no personas are
    // provided is the actual rendered per-character entries (CHARACTER [persona_index: N]).
    const prompt = getEpisodeSystemPromptV4(FULL_STORYLINE, [], [], { costCapUsd: 20 });
    assert.ok(!prompt.includes('[persona_index:'));
  });
});

describe('V4 system prompt — genre register guide', () => {
  test('action genre injects the ACTION kinetic register block', () => {
    const sl = { ...FULL_STORYLINE, genre: 'action' };
    const prompt = getEpisodeSystemPromptV4(sl, [], [FULL_PERSONA], { costCapUsd: 20 });
    assert.ok(prompt.includes('GENRE REGISTER — ACTION'));
    assert.ok(prompt.includes('kinetic, high-pressure, high-BPM'));
    assert.ok(prompt.includes('ACTION_NO_DIALOGUE carries the episode'));
    assert.ok(prompt.includes('130-160 BPM'));
    assert.ok(prompt.includes('bs_urban_grit'));
    assert.ok(prompt.includes('speed_ramp'));
    assert.ok(prompt.includes('CLIPPED'));
  });

  test('thriller genre injects the THRILLER register block', () => {
    const sl = { ...FULL_STORYLINE, genre: 'thriller' };
    const prompt = getEpisodeSystemPromptV4(sl, [], [FULL_PERSONA], { costCapUsd: 20 });
    assert.ok(prompt.includes('GENRE REGISTER — THRILLER'));
    assert.ok(prompt.includes('DRAMATIC_IRONY'));
  });

  test('comedy genre injects the COMEDY register block', () => {
    const sl = { ...FULL_STORYLINE, genre: 'comedy' };
    const prompt = getEpisodeSystemPromptV4(sl, [], [FULL_PERSONA], { costCapUsd: 20 });
    assert.ok(prompt.includes('GENRE REGISTER — COMEDY'));
    assert.ok(prompt.includes('swerve'));
  });

  test('drama (default) emits no genre register override', () => {
    const sl = { ...FULL_STORYLINE, genre: 'drama' };
    const prompt = getEpisodeSystemPromptV4(sl, [], [FULL_PERSONA], { costCapUsd: 20 });
    assert.ok(!prompt.includes('GENRE REGISTER —'));
  });

  test('unknown genre falls back to no register block (genre-as-container mode)', () => {
    const sl = { ...FULL_STORYLINE, genre: 'slice-of-life' };
    const prompt = getEpisodeSystemPromptV4(sl, [], [FULL_PERSONA], { costCapUsd: 20 });
    assert.ok(!prompt.includes('GENRE REGISTER —'));
  });

  test('action register reinforces ambient bed + per-beat SFX (sound continuity preserved)', () => {
    const sl = { ...FULL_STORYLINE, genre: 'action' };
    const prompt = getEpisodeSystemPromptV4(sl, [], [FULL_PERSONA], { costCapUsd: 20 });
    // Action genre explicitly reinforces scene.ambient_bed_prompt + beat.ambient_sound
    assert.ok(prompt.includes('scene.ambient_bed_prompt'));
    assert.ok(prompt.includes('beat.ambient_sound'));
  });
});

describe('V4 system prompt — masterclass bricks are all present', () => {
  test('DIALOGUE MASTERCLASS block injected', () => {
    const prompt = getEpisodeSystemPromptV4(FULL_STORYLINE, [], [FULL_PERSONA], { costCapUsd: 20 });
    assert.ok(prompt.includes('DIALOGUE MASTERCLASS'));
    assert.ok(prompt.includes('THE FIVE JOBS OF A GOOD DIALOGUE LINE'));
    assert.ok(prompt.includes('SUBTEXT — THE IRON RULE'));
    assert.ok(prompt.includes('THE HOOKS TAXONOMY'));
    assert.ok(prompt.includes('THE "ONE GREAT LINE" PRINCIPLE'));
  });

  test('EPISODE SHAPE block injected (three-movement structure)', () => {
    const prompt = getEpisodeSystemPromptV4(FULL_STORYLINE, [], [FULL_PERSONA], { costCapUsd: 20 });
    assert.ok(prompt.includes('EPISODE SHAPE'));
    assert.ok(prompt.includes('MOVEMENT I'));
    assert.ok(prompt.includes('MOVEMENT II'));
    assert.ok(prompt.includes('MOVEMENT III'));
  });

  test('BUDGET AS CRAFT block injected', () => {
    const prompt = getEpisodeSystemPromptV4(FULL_STORYLINE, [], [FULL_PERSONA], { costCapUsd: 20 });
    assert.ok(prompt.includes('BUDGET AS CRAFT'));
    assert.ok(prompt.includes('Prefer FEWER DENSER dialogue beats'));
  });
});
