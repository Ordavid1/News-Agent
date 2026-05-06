// tests/v4/SeverityVocabulary.test.mjs
// V4 P0.1 — Canonical severity vocabulary canary.
//
// Asserts:
//   1. severity.mjs exports the canonical levels and helpers
//   2. Legacy 'blocker' aliases to canonical 'critical'
//   3. Every severity literal in /services/v4/ is in the canonical set
//      (or a known legacy alias) — grep-based tripwire prevents accidental
//      vocabulary drift in future PRs
//   4. Note severity does not trigger Doctor (advisory-only)
//   5. The Lens C verdictSchema uses the canonical SEVERITY_LEVELS list
//
// Run: node --test tests/v4/SeverityVocabulary.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SEVERITY_LEVELS,
  normalizeSeverity,
  isBlockerOrCritical,
  isWarning,
  isNote,
  isValidSeverity
} from '../../services/v4/severity.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');

test('SEVERITY_LEVELS exports canonical 3-value list, frozen', () => {
  assert.deepEqual(SEVERITY_LEVELS, ['critical', 'warning', 'note']);
  assert.ok(Object.isFrozen(SEVERITY_LEVELS), 'SEVERITY_LEVELS must be frozen — Vertex schema depends on stability');
});

test('normalizeSeverity returns canonical for canonical input', () => {
  assert.equal(normalizeSeverity('critical'), 'critical');
  assert.equal(normalizeSeverity('warning'), 'warning');
  assert.equal(normalizeSeverity('note'), 'note');
});

test('normalizeSeverity aliases legacy blocker to critical (case-insensitive, trims whitespace)', () => {
  assert.equal(normalizeSeverity('blocker'), 'critical');
  assert.equal(normalizeSeverity('BLOCKER'), 'critical');
  assert.equal(normalizeSeverity('  blocker  '), 'critical');
});

test('normalizeSeverity returns null for unknown values', () => {
  assert.equal(normalizeSeverity('error'), null);
  assert.equal(normalizeSeverity('info'), null);
  assert.equal(normalizeSeverity(''), null);
  assert.equal(normalizeSeverity(null), null);
  assert.equal(normalizeSeverity(undefined), null);
  assert.equal(normalizeSeverity(42), null);
});

test('isBlockerOrCritical accepts both legacy blocker and canonical critical', () => {
  assert.equal(isBlockerOrCritical('blocker'), true);
  assert.equal(isBlockerOrCritical('critical'), true);
  assert.equal(isBlockerOrCritical('warning'), false);
  assert.equal(isBlockerOrCritical('note'), false);
  assert.equal(isBlockerOrCritical(null), false);
  assert.equal(isBlockerOrCritical(undefined), false);
});

test('isWarning is exclusive — does not match critical or note', () => {
  assert.equal(isWarning('warning'), true);
  assert.equal(isWarning('critical'), false);
  assert.equal(isWarning('blocker'), false);
  assert.equal(isWarning('note'), false);
});

test('isNote is exclusive — note severity is advisory-only', () => {
  assert.equal(isNote('note'), true);
  assert.equal(isNote('warning'), false);
  assert.equal(isNote('critical'), false);
  assert.equal(isNote('blocker'), false);
});

test('isValidSeverity accepts canonical and legacy alias, rejects unknown', () => {
  for (const s of ['critical', 'warning', 'note', 'blocker']) {
    assert.equal(isValidSeverity(s), true, `${s} must be valid`);
  }
  for (const bad of ['error', 'fatal', '', null, undefined, 42]) {
    assert.equal(isValidSeverity(bad), false, `${bad} must be invalid`);
  }
});

test('verdictSchema.mjs SEVERITY_ENUM matches canonical SEVERITY_LEVELS', async () => {
  // Load the schema module and confirm it re-exports the canonical list.
  // This prevents schema drift — Vertex AI's responseSchema MUST match
  // the canonical vocabulary or the L3 verdict pipeline silently breaks.
  const schemaSrc = fs.readFileSync(
    path.join(REPO_ROOT, 'services/v4/director-rubrics/verdictSchema.mjs'),
    'utf8'
  );
  assert.ok(
    schemaSrc.includes("import { SEVERITY_LEVELS } from '../severity.mjs'"),
    'verdictSchema.mjs must import SEVERITY_LEVELS from canonical severity.mjs'
  );
  assert.ok(
    schemaSrc.includes('const SEVERITY_ENUM = SEVERITY_LEVELS'),
    'verdictSchema.mjs must alias SEVERITY_ENUM = SEVERITY_LEVELS for back-compat'
  );
});

test('GREP CANARY — every quality-gate severity literal in services/v4 is canonical', () => {
  // Walk services/v4/ and ensure every severity-emitting site uses an
  // accepted vocabulary. Catches accidental introduction of new severity
  // strings (e.g. 'fatal', 'high') in future PRs without a schema update.
  //
  // Domain-specific severity fields that don't represent quality-gate findings
  // (e.g. PersonaVisualAnchor's inversion classification) are explicitly
  // allowlisted here. The allowlist is the audit surface — adding to it
  // requires a comment justifying why the field isn't a quality-gate severity.
  const SERVICES_V4 = path.join(REPO_ROOT, 'services/v4');
  const accepted = new Set(['critical', 'warning', 'note', 'blocker']);

  // Per-file domain-specific severity allowlist. These severities are NOT
  // quality-gate findings; they're domain classifications that happen to
  // share the field name. Don't add entries casually — see the file's
  // doc comments for justification.
  const DOMAIN_ALLOWLIST = {
    'PersonaVisualAnchor.js': new Set(['inversion', 'descriptor_mismatch']),
    // ↑ inversion classification for validateFluxPromptAgainstAnchor:
    //   'inversion' = HARD HALT (gender/age inverted vs anchor)
    //   'descriptor_mismatch' = splice corrective hint, proceed
    //   These are NOT consumed by Doctor / Director / any quality gate;
    //   they drive CharacterSheetDirector's identity-defense routing.
    'VeoFailureKnowledge.mjs': new Set(['low', 'medium', 'high', 'critical'])
    // ↑ Veo Failure-Learning Agent (2026-05-06). The severity field on each
    //   VEO_FAILURE_SIGNATURES entry classifies a failure-PATTERN's impact
    //   on the Veo generation pipeline (occurrence frequency × recovery cost).
    //   It is NOT a quality-gate finding severity. The catalogue is consumed
    //   only by VeoService.applyPreflightRules() and the Gemini system-prompt
    //   block — never by Doctor / Director / Validator / runQualityGate. The
    //   four-level scale matches the MCP's get_failure_signatures_for_model
    //   contract so live signatures can be exported into static reference.
  };

  const violations = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(mjs|js)$/.test(entry.name)) continue;
      const src = fs.readFileSync(full, 'utf8');
      const fileAllowlist = DOMAIN_ALLOWLIST[entry.name] || new Set();
      const matches = src.match(/severity:\s*['"]([^'"]+)['"]/g) || [];
      for (const literal of matches) {
        const value = literal.replace(/^severity:\s*['"]|['"]$/g, '');
        if (accepted.has(value)) continue;
        if (fileAllowlist.has(value)) continue;
        violations.push(`${full}: severity='${value}' is not in canonical vocabulary or domain allowlist`);
      }
    }
  }
  walk(SERVICES_V4);

  assert.deepEqual(violations, [], `Severity vocabulary violations found:\n${violations.join('\n')}`);
});

test('ScreenplayValidator emissions are canonical critical/warning (not legacy blocker)', () => {
  // After P0.1 migration the validator emits canonical 'critical'. Legacy
  // 'blocker' should appear ONLY in comments/docstrings, never as a literal
  // emission. This test guards the migration from regression.
  const src = fs.readFileSync(
    path.join(REPO_ROOT, 'services/v4/ScreenplayValidator.js'),
    'utf8'
  );
  const blockerEmissions = src.match(/severity:\s*['"]blocker['"]/g) || [];
  assert.equal(
    blockerEmissions.length,
    0,
    `ScreenplayValidator must not emit legacy 'blocker' severity. Found ${blockerEmissions.length} occurrences.`
  );
});
