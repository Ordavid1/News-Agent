// tests/v4/VeoFailureKnowledge.test.mjs
//
// Tests for the Veo Failure-Learning Agent — the per-call telemetry collector,
// the deterministic pre-flight rule pass, and the builder's file-rendering
// pipeline. The full nightly() / runIncremental() entry points are integration
// surfaces that hit Supabase + Vertex Gemini and are NOT exercised here; the
// unit tests focus on the deterministic seams that can fail in pure-JS.
//
// Run with: node --test tests/v4/VeoFailureKnowledge.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { pathToFileURL } from 'url';

import {
  VEO_FAILURE_SIGNATURES,
  VEO_FAILURE_KNOWLEDGE_VERSION,
  applyPreflightRules,
  getGeminiSystemPromptBlock,
  getKnowledgeSummary
} from '../../services/v4/VeoFailureKnowledge.mjs';

import VeoFailureCollector, {
  classifyFailure,
  _resetThresholdStateForTests
} from '../../services/v4/VeoFailureCollector.js';

import { __test__ as builderInternals } from '../../services/v4/VeoFailureKnowledgeBuilder.js';

// ─────────────────────────────────────────────────────────────────────
// VeoFailureKnowledge.mjs — initial seed structure + helpers
// ─────────────────────────────────────────────────────────────────────

describe('VeoFailureKnowledge — seed catalogue', () => {
  test('VEO_FAILURE_SIGNATURES is a non-empty array of well-formed entries', () => {
    assert.ok(Array.isArray(VEO_FAILURE_SIGNATURES));
    assert.ok(VEO_FAILURE_SIGNATURES.length >= 1, 'expected at least one seed signature');

    for (const sig of VEO_FAILURE_SIGNATURES) {
      assert.equal(typeof sig.key, 'string', `signature ${JSON.stringify(sig)} missing string .key`);
      assert.ok(sig.key.length > 0);
      assert.equal(typeof sig.failure_mode, 'string');
      assert.equal(typeof sig.pattern_description, 'string');
      assert.ok(['low', 'medium', 'high', 'critical'].includes(sig.severity));
      assert.ok(['active', 'archived', 'invalidated'].includes(sig.status));
      assert.ok(Array.isArray(sig.avoid_phrases));
      assert.ok(Array.isArray(sig.safe_alternatives));
      assert.equal(typeof sig.gemini_directive, 'string');
      assert.ok(Array.isArray(sig.model_scope));
      // preflight_rule may be null OR a {regex, flags, rewrite} object
      if (sig.preflight_rule !== null) {
        assert.equal(typeof sig.preflight_rule.regex, 'string');
        assert.equal(typeof sig.preflight_rule.rewrite, 'string');
      }
    }
  });

  test('seed includes the persona_possessive_bodypart signature with usable preflight rule', () => {
    const sig = VEO_FAILURE_SIGNATURES.find(s => s.key === 'persona_possessive_bodypart');
    assert.ok(sig, 'expected seed to include persona_possessive_bodypart');
    assert.equal(sig.failure_mode, 'content_filter_prompt');
    assert.ok(sig.preflight_rule);
    assert.ok(typeof sig.preflight_rule.regex === 'string' && sig.preflight_rule.regex.length > 0);
    // Must compile as a regex
    const re = new RegExp(sig.preflight_rule.regex, sig.preflight_rule.flags || 'g');
    assert.ok(re instanceof RegExp);
  });

  test('VEO_FAILURE_KNOWLEDGE_VERSION is a string', () => {
    assert.equal(typeof VEO_FAILURE_KNOWLEDGE_VERSION, 'string');
    assert.ok(VEO_FAILURE_KNOWLEDGE_VERSION.length > 0);
  });

  test('getKnowledgeSummary returns version + active counts shape', () => {
    const s = getKnowledgeSummary();
    assert.equal(s.version, VEO_FAILURE_KNOWLEDGE_VERSION);
    assert.equal(typeof s.activeCount, 'number');
    assert.ok(s.activeCount >= 1);
    assert.equal(typeof s.byMode, 'object');
    assert.equal(typeof s.bySeverity, 'object');
  });
});

// ─────────────────────────────────────────────────────────────────────
// applyPreflightRules — deterministic prompt rewriting
// ─────────────────────────────────────────────────────────────────────

describe('applyPreflightRules — known-bad phrasings rewritten before submission', () => {
  test('rewrites "Leo\'s wrist" → "in frame" (single occurrence)', () => {
    const input = 'A luxury silver wristwatch on Leo\'s wrist.';
    const { prompt, rewrites } = applyPreflightRules(input);
    assert.ok(!/Leo's wrist/.test(prompt), `prompt should not contain "Leo's wrist", got: ${prompt}`);
    assert.ok(/in frame/.test(prompt));
    assert.ok(Array.isArray(rewrites));
    assert.ok(rewrites.some(r => r.key === 'persona_possessive_bodypart'));
  });

  test('rewrites pronoun + body-part ("his hand") → "in frame"', () => {
    const input = 'The watch glints in his hand under the morning light.';
    const { prompt, rewrites } = applyPreflightRules(input);
    assert.ok(!/his hand/i.test(prompt));
    assert.ok(/in frame/.test(prompt));
    assert.ok(rewrites.some(r => r.key === 'pronoun_bodypart'));
  });

  test('multiple occurrences are all rewritten in one pass', () => {
    const input = 'Maya\'s wrist, then Leo\'s hand, then Anna\'s fingers — all three.';
    const { prompt, rewrites } = applyPreflightRules(input);
    assert.ok(!/Maya's wrist/.test(prompt));
    assert.ok(!/Leo's hand/.test(prompt));
    assert.ok(!/Anna's fingers/.test(prompt));
    const possessive = rewrites.find(r => r.key === 'persona_possessive_bodypart');
    assert.ok(possessive);
    assert.equal(possessive.count, 3);
  });

  test('clean prompt is unchanged and produces empty rewrites', () => {
    const input = 'A wide handheld shot of the city, golden hour light.';
    const { prompt, rewrites } = applyPreflightRules(input);
    assert.equal(prompt, input);
    assert.equal(rewrites.length, 0);
  });

  test('non-string input is passed through safely', () => {
    const { prompt: outNull, rewrites: rNull } = applyPreflightRules(null);
    assert.equal(outNull, null);
    assert.equal(rNull.length, 0);

    const { prompt: outUndef, rewrites: rUndef } = applyPreflightRules(undefined);
    assert.equal(outUndef, undefined);
    assert.equal(rUndef.length, 0);
  });

  test('whitespace + grammatical artefacts left by substitution are tidied', () => {
    const input = 'The keycard sits on Leo\'s palm.';
    const { prompt } = applyPreflightRules(input);
    // No "on  in frame" double-space, no "on in frame" leftover
    assert.ok(!/on\s+in frame/.test(prompt));
    assert.ok(/in frame/.test(prompt));
    // No double space anywhere
    assert.ok(!/\s{2,}/.test(prompt));
  });

  test('respects modelId scoping (rules with non-matching model_scope are skipped)', () => {
    const input = 'A close shot of Leo\'s wrist.';
    const { rewrites: matchingScope } = applyPreflightRules(input, { modelId: 'veo-3.1-vertex' });
    assert.ok(matchingScope.length > 0);

    const { rewrites: nonMatchingScope } = applyPreflightRules(input, { modelId: 'made-up-model' });
    assert.equal(nonMatchingScope.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// getGeminiSystemPromptBlock — system-prompt injection
// ─────────────────────────────────────────────────────────────────────

describe('getGeminiSystemPromptBlock — Gemini system-prompt injection', () => {
  test('returns a non-empty block when active directives exist', () => {
    const block = getGeminiSystemPromptBlock();
    assert.equal(typeof block, 'string');
    assert.ok(block.includes('KNOWN VEO FAILURE PATTERNS'));
    assert.ok(block.includes(VEO_FAILURE_KNOWLEDGE_VERSION));
  });

  test('returns empty string when minSeverity excludes all signatures', () => {
    const block = getGeminiSystemPromptBlock({ minSeverity: ['critical'] });
    // Seed has no 'critical' severity entries → empty.
    assert.equal(block, '');
  });

  test('respects modelId scoping', () => {
    const block = getGeminiSystemPromptBlock({ modelId: 'unknown-model' });
    assert.equal(block, '');
  });
});

// ─────────────────────────────────────────────────────────────────────
// VeoFailureCollector.classifyFailure — error classification
// ─────────────────────────────────────────────────────────────────────

describe('VeoFailureCollector.classifyFailure — error → failure_mode + signatures', () => {
  test('content_filter_prompt for "violate Vertex AI\'s usage guidelines"', () => {
    const msg = 'Veo 3.1 Standard operation failed: The prompt could not be submitted. This prompt contains words that violate Vertex AI\'s usage guidelines.';
    const { failureMode, signatures } = classifyFailure(msg);
    assert.equal(failureMode, 'content_filter_prompt');
    assert.ok(signatures.includes('usage_guidelines'));
    assert.ok(signatures.includes('could_not_be_submitted'));
  });

  test('content_filter_image for "input image violates"', () => {
    const msg = 'Veo could not generate videos because the input image violates Vertex AI\'s usage guidelines.';
    const { failureMode, signatures } = classifyFailure(msg);
    assert.equal(failureMode, 'content_filter_image');
    assert.ok(signatures.includes('image_violates'));
  });

  test('high_load for "currently experiencing high load"', () => {
    const msg = 'Veo 3.1 Standard operation failed: The service is currently experiencing high load.';
    const { failureMode, signatures } = classifyFailure(msg);
    assert.equal(failureMode, 'high_load');
    assert.ok(signatures.includes('high_load'));
  });

  test('rate_limit for HTTP 429', () => {
    const msg = 'Request failed with status 429: Too Many Requests';
    const { failureMode } = classifyFailure(msg);
    assert.equal(failureMode, 'rate_limit');
  });

  test('auth for HTTP 401/403', () => {
    const msg = 'Request failed: 403 Permission denied for project';
    const { failureMode } = classifyFailure(msg);
    assert.equal(failureMode, 'auth');
  });

  test('polling_timeout for "deadline exceeded"', () => {
    const msg = 'Operation polling timed out after 600s — deadline exceeded';
    const { failureMode } = classifyFailure(msg);
    assert.equal(failureMode, 'polling_timeout');
  });

  test('network for ENOTFOUND', () => {
    const msg = 'Error: getaddrinfo ENOTFOUND aiplatform.googleapis.com';
    const { failureMode } = classifyFailure(msg);
    assert.equal(failureMode, 'network');
  });

  test('"other" fallback for unknown error shapes', () => {
    const msg = 'something exploded in a way nobody anticipated';
    const { failureMode } = classifyFailure(msg);
    assert.equal(failureMode, 'other');
  });

  test('null / empty defaults to "other" with empty signatures', () => {
    const { failureMode, signatures } = classifyFailure('');
    assert.equal(failureMode, 'other');
    assert.equal(signatures.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// VeoFailureCollector.record — fire-and-forget contract
// ─────────────────────────────────────────────────────────────────────

describe('VeoFailureCollector.record — never throws, never blocks', () => {
  test('returns {ok: false} when Supabase is not configured (test env), no throw', async () => {
    // Without SUPABASE_URL/keys set, the collector should return {ok:false}
    // and not throw. We rely on the test runner being invoked without those vars.
    _resetThresholdStateForTests();
    const result = await VeoFailureCollector.record({
      beatId: 'test-beat-1',
      beatType: 'REACTION',
      error: new Error('test error — should be classified as other'),
      prompt: 'a clean test prompt'
    });
    // Either {ok:false} (no Supabase) or {ok:true, id:'...'} (real Supabase) —
    // both are acceptable; what matters is no throw.
    assert.ok(result && typeof result === 'object');
    assert.ok(typeof result.ok === 'boolean');
  });

  test('truncates long prompts and error messages defensively', async () => {
    _resetThresholdStateForTests();
    const longPrompt = 'x'.repeat(10000);
    const longErr = new Error('y'.repeat(10000));
    // Should not throw regardless of whether DB write succeeds
    const result = await VeoFailureCollector.record({
      beatId: 'test-beat-2',
      beatType: 'INSERT_SHOT',
      error: longErr,
      prompt: longPrompt
    });
    assert.ok(result && typeof result === 'object');
  });
});

// ─────────────────────────────────────────────────────────────────────
// VeoFailureKnowledgeBuilder — internal helpers (deterministic)
// ─────────────────────────────────────────────────────────────────────

describe('VeoFailureKnowledgeBuilder — deterministic internals', () => {
  test('classifyClusterPrimarySignature groups rows by (mode, primary_sig, beat_type)', () => {
    const rows = [
      { failure_mode: 'content_filter_prompt', error_signatures: ['usage_guidelines'], beat_type: 'INSERT_SHOT', error_message: 'a', original_prompt: '' },
      { failure_mode: 'content_filter_prompt', error_signatures: ['usage_guidelines'], beat_type: 'INSERT_SHOT', error_message: 'b', original_prompt: '' },
      { failure_mode: 'content_filter_prompt', error_signatures: ['usage_guidelines'], beat_type: 'REACTION', error_message: 'c', original_prompt: '' },
      { failure_mode: 'high_load', error_signatures: ['high_load'], beat_type: 'INSERT_SHOT', error_message: 'd', original_prompt: '' }
    ];
    const clusters = builderInternals.classifyClusterPrimarySignature(rows);
    assert.equal(clusters.length, 3);
    // Sorted by occurrence_count desc — biggest cluster first
    assert.equal(clusters[0].rows.length, 2);
  });

  test('fallbackHeuristicSummary produces a valid signature shape per cluster', () => {
    const clusters = [
      {
        key: 'content_filter_prompt::usage_guidelines::INSERT_SHOT',
        failure_mode: 'content_filter_prompt',
        primary_signature: 'usage_guidelines',
        beat_type: 'INSERT_SHOT',
        rows: Array.from({ length: 12 }, (_, i) => ({
          error_message: `failure ${i}: usage guidelines violation`,
          original_prompt: 'A close shot of Leo\'s wrist'
        }))
      }
    ];
    const sigs = builderInternals.fallbackHeuristicSummary(clusters);
    assert.equal(sigs.length, 1);
    const sig = sigs[0];
    assert.equal(typeof sig.signature_key, 'string');
    assert.ok(sig.signature_key.length > 0);
    assert.equal(sig.failure_mode, 'content_filter_prompt');
    // 12 occurrences ≥ 10 → severity high
    assert.equal(sig.severity, 'high');
  });

  test('renderKnowledgeFile produces a parseable .mjs source string', () => {
    const activeSignatures = [
      {
        signature_key: 'persona_possessive_bodypart',
        failure_mode: 'content_filter_prompt',
        pattern_description: 'Persona possessive + body part trips Vertex filter.',
        occurrence_count: 47,
        severity: 'high',
        status: 'active',
        prompt_avoid_phrases: ["<persona>'s wrist"],
        prompt_safe_alternatives: ['in frame'],
        gemini_directive: 'Avoid possessive name + body part',
        preflight_rule_regex: "\\b([A-Z][a-zA-Z]+)'s\\s+wrist\\b",
        preflight_rule_flags: 'g',
        preflight_rewrite: 'in frame',
        model_scope: ['veo-3.1-vertex']
      }
    ];
    const src = builderInternals.renderKnowledgeFile({
      activeSignatures,
      version: '2026.05.06.0200',
      lastUpdated: '2026-05-06T02:00:00.000Z'
    });
    assert.ok(typeof src === 'string');
    assert.ok(src.includes('export const VEO_FAILURE_KNOWLEDGE_VERSION'));
    assert.ok(src.includes('export const VEO_FAILURE_SIGNATURES'));
    assert.ok(src.includes('persona_possessive_bodypart'));
    assert.ok(src.includes('export function applyPreflightRules'));
    assert.ok(src.includes('export function getGeminiSystemPromptBlock'));
    // Must include AUTO-GENERATED warning so PR reviewers know not to hand-edit
    assert.ok(src.includes('AUTO-GENERATED'));
  });

  test('renderKnowledgeFile output is importable as ESM (round-trip via tmp file)', async () => {
    // The strongest possible "is this valid JS" test — write the rendered
    // source to a temp .mjs file and import it. If the file is malformed,
    // the import throws and the test fails with a useful diagnostic.
    const activeSignatures = [
      {
        signature_key: 'tricky_quotes',
        failure_mode: 'content_filter_prompt',
        pattern_description: 'A description with "embedded quotes" and \\backslashes\\.',
        occurrence_count: 5,
        severity: 'medium',
        status: 'active',
        prompt_avoid_phrases: ["it's possessive"],
        prompt_safe_alternatives: ['safe'],
        gemini_directive: 'Use proper quoting',
        preflight_rule_regex: null,
        preflight_rule_flags: null,
        preflight_rewrite: null,
        model_scope: ['veo-3.1-vertex']
      },
      {
        signature_key: 'with_regex',
        failure_mode: 'content_filter_prompt',
        pattern_description: 'A signature WITH a preflight regex.',
        occurrence_count: 3,
        severity: 'high',
        status: 'active',
        prompt_avoid_phrases: [],
        prompt_safe_alternatives: [],
        gemini_directive: '',
        preflight_rule_regex: "\\b([A-Z][a-zA-Z]+)'s\\s+wrist\\b",
        preflight_rule_flags: 'g',
        preflight_rewrite: 'in frame',
        model_scope: ['veo-3.1-vertex']
      }
    ];
    const src = builderInternals.renderKnowledgeFile({
      activeSignatures,
      version: '2026.05.06.0200-test',
      lastUpdated: '2026-05-06T02:00:00.000Z'
    });

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'veo-failure-knowledge-test-'));
    const tmpFile = path.join(tmpDir, 'GeneratedKnowledge.mjs');
    try {
      await fs.writeFile(tmpFile, src, 'utf8');
      const mod = await import(pathToFileURL(tmpFile).href);
      assert.equal(mod.VEO_FAILURE_KNOWLEDGE_VERSION, '2026.05.06.0200-test');
      assert.equal(Array.isArray(mod.VEO_FAILURE_SIGNATURES), true);
      assert.equal(mod.VEO_FAILURE_SIGNATURES.length, 2);
      assert.equal(mod.VEO_FAILURE_SIGNATURES[0].key, 'tricky_quotes');
      // Embedded quotes survived round-trip
      assert.ok(mod.VEO_FAILURE_SIGNATURES[0].pattern_description.includes('"embedded quotes"'));
      // Pre-flight regex from the second signature actually rewrites
      const { prompt } = mod.applyPreflightRules('A close shot of Leo\'s wrist.');
      assert.ok(/in frame/.test(prompt));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('buildSummariseUserPrompt renders cluster examples and existing signatures', () => {
    const userPrompt = builderInternals.buildSummariseUserPrompt({
      clusters: [
        {
          failure_mode: 'content_filter_prompt',
          primary_signature: 'usage_guidelines',
          beat_type: 'INSERT_SHOT',
          rows: [{ error_message: 'sample failure', original_prompt: 'on Leo\'s wrist' }]
        }
      ],
      existingSignatures: [
        { signature_key: 'persona_possessive_bodypart', failure_mode: 'content_filter_prompt', occurrence_count: 47, severity: 'high' }
      ]
    });
    assert.ok(userPrompt.includes('CLUSTER 1'));
    assert.ok(userPrompt.includes('usage_guidelines'));
    assert.ok(userPrompt.includes('INSERT_SHOT'));
    assert.ok(userPrompt.includes('persona_possessive_bodypart'));
  });
});
