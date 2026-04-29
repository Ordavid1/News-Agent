// tests/v4/GenerateDirectorsHint.test.mjs
//
// Locks in the V4 enrichment of the legacy wizard director's-hint prompt.
// The prompt construction was extracted into a synchronous helper
// (`_buildDirectorsHintPrompt`) on BrandStoryService so it can be tested
// without mocking Vertex AI. The async `generateDirectorsHint` wrapper still
// fetches the brand-kit context, calls the helper, and dispatches to Vertex
// — none of which is exercised here.
//
// What this test guards:
//   - V4 genre-register block weaves in alongside the existing context.
//   - V4 reference-palette block is present, framed as a synthesis prompt
//     (borrow / blend / transcend), with the load-bearing "do NOT pick the
//     nearest match" instruction so future edits can't silently turn the
//     palette into a quote-bank.
//   - The 5 angle directives still anchor variations 1-5.
//   - The existing subject / persona / brand context blocks are NOT
//     displaced — the V4 enrichment is additive.
//   - The two V4 helpers (buildGenreRegisterHint, formatReferenceLibraryForPrompt)
//     produce the expected register and palette shape on their own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import brandStoryService from '../../services/BrandStoryService.js';
import { buildGenreRegisterHint } from '../../services/v4/director-rubrics/sharedHeader.mjs';
import { formatReferenceLibraryForPrompt } from '../../services/v4/director-rubrics/commercialReferenceLibrary.mjs';

// ─── V4 helpers — independent shape checks ────────────────────────────────────

test('buildGenreRegisterHint — thriller yields a genre-tagged register hint', () => {
  const register = buildGenreRegisterHint('thriller');
  assert.match(register, /thriller/i);
  assert.match(register, /GENRE REGISTER:/);
});

test('buildGenreRegisterHint — drama yields a genre-tagged register hint', () => {
  const register = buildGenreRegisterHint('drama');
  assert.match(register, /drama/i);
  assert.match(register, /GENRE REGISTER:/);
});

test('formatReferenceLibraryForPrompt — limit:6 returns 6 reference cards with titles', () => {
  const palette = formatReferenceLibraryForPrompt({ limit: 6 });
  const entries = palette.split('\n').filter(l => l.trim().startsWith('•'));
  assert.equal(entries.length, 6, 'palette should contain exactly 6 reference cards');
  // At least one well-known title should be present so the wizard hint inherits
  // commercial-craft-grade exemplars rather than only a single fixture.
  assert.match(palette, /Apple "1984"|Honda "Cog"|Guinness "Surfer"|Cadbury "Gorilla"/);
});

// ─── Prompt builder — V4 enrichment locked in ─────────────────────────────────

test('prompt builder — thriller / variation 1 weaves register + palette + cinematography angle', () => {
  const prompt = brandStoryService._buildDirectorsHintPrompt({
    storyFocus: 'product',
    genre: 'thriller',
    tone: 'tense',
    targetAudience: 'urban professionals',
    genreRegister: buildGenreRegisterHint('thriller'),
    referencePalette: formatReferenceLibraryForPrompt({ limit: 6 }),
    variation: 1
  });

  assert.match(prompt, /GENRE REGISTER:.*thriller/i);
  assert.match(prompt, /REFERENCE PALETTE/);
  assert.match(prompt, /Apple "1984"|Honda "Cog"|Guinness "Surfer"|Cadbury "Gorilla"/);
  assert.match(prompt, /cinematograph/i);
});

test('prompt builder — synthesis framing is intact (borrow / blend / transcend + anti-laziness)', () => {
  const prompt = brandStoryService._buildDirectorsHintPrompt({
    genre: 'drama',
    genreRegister: buildGenreRegisterHint('drama'),
    referencePalette: formatReferenceLibraryForPrompt({ limit: 6 }),
    variation: 1
  });

  // Load-bearing framing — guards against accidental edits that turn the
  // palette into a quote-bank or a multiple-choice menu.
  assert.match(prompt, /PALETTE/);
  assert.match(prompt, /borrow/i);
  assert.match(prompt, /blend/i);
  assert.match(prompt, /do NOT pick the nearest match/i);
});

test('prompt builder — variation 3 fires film-references angle alongside enrichment', () => {
  const prompt = brandStoryService._buildDirectorsHintPrompt({
    genre: 'drama',
    genreRegister: buildGenreRegisterHint('drama'),
    referencePalette: formatReferenceLibraryForPrompt({ limit: 6 }),
    variation: 3
  });

  assert.match(prompt, /GENRE REGISTER:.*drama/i);
  assert.match(prompt, /film references/i);
  assert.match(prompt, /REFERENCE PALETTE/);
});

test('prompt builder — existing subject / persona / brand context survives alongside V4 enrichment', () => {
  const prompt = brandStoryService._buildDirectorsHintPrompt({
    storyFocus: 'product',
    genre: 'drama',
    tone: 'engaging',
    targetAudience: 'young professionals',
    subjectContext: 'SUBJECT: "TestProduct" (Category). Description body. Visual: visual body',
    personaContext: 'CHARACTERS: Persona A; Persona B',
    brandContext: 'BRAND CONTEXT: brand body line',
    genreRegister: buildGenreRegisterHint('drama'),
    referencePalette: formatReferenceLibraryForPrompt({ limit: 6 }),
    variation: 1
  });

  // The wizard relies on these three blocks reaching Gemini. The V4
  // enrichment is additive, never displacing.
  assert.match(prompt, /SUBJECT:\s*"TestProduct"/);
  assert.match(prompt, /CHARACTERS:\s*Persona A; Persona B/);
  assert.match(prompt, /BRAND CONTEXT:\s*brand body line/);
  // And the V4 blocks are also there.
  assert.match(prompt, /GENRE REGISTER:/);
  assert.match(prompt, /REFERENCE PALETTE/);
});

test('prompt builder — unknown variation falls back to angle 1 (cinematography)', () => {
  const prompt = brandStoryService._buildDirectorsHintPrompt({
    genre: 'drama',
    genreRegister: buildGenreRegisterHint('drama'),
    referencePalette: formatReferenceLibraryForPrompt({ limit: 6 }),
    variation: 99
  });

  // angle-1 anchor (cinematography) reappears for any unknown variation id —
  // preserves the original `angles[variation] || angles[1]` contract.
  assert.match(prompt, /cinematograph/i);
});

test('prompt builder — defaults render a runnable prompt when called with no args', () => {
  const prompt = brandStoryService._buildDirectorsHintPrompt();
  // Doesn't throw; returns a string with the framing skeleton intact.
  assert.equal(typeof prompt, 'string');
  assert.match(prompt, /STORY CONTEXT:/);
  assert.match(prompt, /YOUR CREATIVE ANGLE:/);
  // Empty strings for genreRegister / referencePalette default to empty —
  // the prompt structure still renders.
  assert.match(prompt, /Focus: product/);
});
