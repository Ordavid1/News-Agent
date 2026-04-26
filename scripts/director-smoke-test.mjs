#!/usr/bin/env node
/**
 * Director Agent Vertex Gemini Smoke Test
 *
 * Makes real Vertex AI calls with minimal payloads to validate:
 *   - GCP credentials + endpoint connectivity
 *   - maxOutputTokens budget doesn't trigger timeout or MAX_TOKENS
 *   - Thinking token overhead stays within expectations
 *   - Verdict shape matches §7 contract
 *
 * Run BEFORE a full episode generation to confirm the Director Agent is healthy.
 *
 * Usage:
 *   node scripts/director-smoke-test.mjs             — Lens A only (text, ~10-20s)
 *   node scripts/director-smoke-test.mjs --lens ab   — Lens A + B (needs --image)
 *   node scripts/director-smoke-test.mjs --lens abc  — A + B + C
 *   node scripts/director-smoke-test.mjs --image https://your-image-url.jpg
 *
 * Exit code 0 = all tested lenses passed. Exit code 1 = at least one failed.
 *
 * Requires: GCP_PROJECT_ID, GOOGLE_APPLICATION_CREDENTIALS_JSON (or ADC)
 * Optional: GEMINI_MODEL (defaults to gemini-3-flash-preview)
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load .env from project root
try {
  const dotenv = require('dotenv');
  dotenv.config({ path: path.join(__dirname, '..', '.env') });
} catch {
  // dotenv not available — rely on env vars being set externally
}

import { DirectorAgent, CHECKPOINTS } from '../services/v4/DirectorAgent.js';

// ─── Minimal fixtures ─────────────────────────────────────────────────────────

const SCENE_GRAPH = {
  title: 'Director Smoke Test Episode',
  central_dramatic_question: 'Can the product transform everyday moments?',
  scenes: [
    {
      scene_id: 'sc_01',
      scene_goal: 'Establish brand world and protagonist desire',
      ambient_bed_prompt: 'soft city morning ambience',
      opposing_intents: ['protagonist wants change', 'routine resists'],
      beats: [
        { beat_id: 'b_01', type: 'B_ROLL_ESTABLISHING', duration_seconds: 4, prompt: 'Wide shot of city at golden hour' },
        { beat_id: 'b_02', type: 'TALKING_HEAD_CLOSEUP', duration_seconds: 5, dialogue: 'Every morning I tell myself — today is different.', subtext: 'Yearning for transformation' }
      ]
    }
  ]
};

const PERSONAS = [
  { name: 'Jordan', role: 'protagonist', want: 'a fresh start', need: 'self-belief', archetype: 'everyman' }
];

const FAKE_SCENE = SCENE_GRAPH.scenes[0];
const FAKE_BEAT  = SCENE_GRAPH.scenes[0].beats[1];

// ─── CLI parsing ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const lensArg   = (args.find((_, i) => args[i - 1] === '--lens') || 'a').toLowerCase();
const imageArg  = args.find((_, i) => args[i - 1] === '--image') || null;

const runA = lensArg.includes('a');
const runB = lensArg.includes('b');
const runC = lensArg.includes('c');

if ((runB || runC) && !imageArg) {
  console.error('ERROR: --lens b or --lens c requires --image <path-or-url>');
  process.exit(1);
}

// Resolve image to a Buffer (local file) or HTTP URL string.
// Vertex AI rejects local file paths as file_data URIs — must be GCS or HTTP.
// Local files are sent as inline_data (base64), which the rubric builders handle
// automatically when they receive a Buffer instead of a URL string.
function resolveImage(imagePathOrUrl) {
  if (!imagePathOrUrl) return null;
  if (/^https?:\/\//i.test(imagePathOrUrl)) return imagePathOrUrl; // HTTP URL — pass through
  const absPath = path.isAbsolute(imagePathOrUrl)
    ? imagePathOrUrl
    : path.join(process.cwd(), imagePathOrUrl);
  if (!fs.existsSync(absPath)) throw new Error(`Image file not found: ${absPath}`);
  return fs.readFileSync(absPath); // Buffer → rubric builder encodes as inline_data
}

const imageInput = imageArg ? resolveImage(imageArg) : null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function bar(label, elapsed, budget, status) {
  const ms = `${elapsed}ms`.padStart(8);
  const mark = status === 'PASS' ? '✓' : '✗';
  console.log(`  ${mark} [${label}] ${ms}  status=${status}  budget=${budget}`);
}

function printVerdict(verdict) {
  if (!verdict) return;
  console.log(`      verdict=${verdict.verdict}  score=${verdict.overall_score}`);
  console.log(`      findings=${verdict.findings?.length ?? 0}  commendations=${verdict.commendations?.length ?? 0}`);
  if (verdict.findings?.length) {
    verdict.findings.slice(0, 2).forEach(f =>
      console.log(`        [${f.severity}] ${f.message?.slice(0, 80)}`)
    );
  }
}

// ─── Test runners ─────────────────────────────────────────────────────────────

async function testLensA(agent) {
  const label = 'Lens A — screenplay';
  const t0 = Date.now();
  let status = 'FAIL';
  let verdict = null;

  try {
    verdict = await agent.judgeScreenplay({ sceneGraph: SCENE_GRAPH, personas: PERSONAS, storyFocus: 'drama' });
    status = verdict?.error ? 'FAIL' : 'PASS';
  } catch (err) {
    verdict = { error: err.message };
  }

  const elapsed = Date.now() - t0;
  bar(label, elapsed, agent.maxOutputTokens, status);
  if (status === 'PASS') printVerdict(verdict);
  else console.log(`      error: ${verdict?.error}`);

  // Warn if latency is suspiciously high (thinking overhead may be growing)
  if (elapsed > 140_000) {
    console.warn(`      ⚠ latency ${Math.round(elapsed / 1000)}s is approaching the 180s timeout — consider reducing maxOutputTokens further`);
  }

  return status === 'PASS';
}

async function testLensB(agent, imageUrl) {
  const label = 'Lens B — scene_master';
  const t0 = Date.now();
  let status = 'FAIL';
  let verdict = null;

  try {
    verdict = await agent.judgeSceneMaster({
      scene: FAKE_SCENE,
      sceneMasterImage: imageUrl,
      personas: PERSONAS,
      lutId: 'bs_urban_grit',
      visualStylePrefix: 'golden hour city',
      storyFocus: 'drama'
    });
    status = verdict?.error ? 'FAIL' : 'PASS';
  } catch (err) {
    verdict = { error: err.message };
  }

  const elapsed = Date.now() - t0;
  bar(label, elapsed, agent.maxOutputTokens, status);
  if (status === 'PASS') printVerdict(verdict);
  else console.log(`      error: ${verdict?.error}`);
  return status === 'PASS';
}

async function testLensC(agent, imageUrl) {
  const label = 'Lens C — beat';
  const t0 = Date.now();
  let status = 'FAIL';
  let verdict = null;

  try {
    verdict = await agent.judgeBeat({
      beat: FAKE_BEAT,
      scene: FAKE_SCENE,
      endframeImage: imageUrl,
      personas: PERSONAS,
      storyFocus: 'drama'
    });
    status = verdict?.error ? 'FAIL' : 'PASS';
  } catch (err) {
    verdict = { error: err.message };
  }

  const elapsed = Date.now() - t0;
  bar(label, elapsed, agent.maxOutputTokens, status);
  if (status === 'PASS') printVerdict(verdict);
  else console.log(`      error: ${verdict?.error}`);
  return status === 'PASS';
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const agent = new DirectorAgent();

  console.log('Director Agent Smoke Test');
  console.log('─────────────────────────────────────────────');
  console.log(`  model       : ${process.env.GEMINI_MODEL || 'gemini-3-flash-preview'}`);
  console.log(`  budget      : ${agent.maxOutputTokens} tokens`);
  console.log(`  temperature : ${agent.temperature}`);
  console.log(`  thinkingLevel: ${agent.thinkingLevel}`);
  console.log(`  timeout     : ${agent.timeoutMs / 1000}s (text/image) / ${agent.timeoutVideoMs / 1000}s (video)`);
  console.log(`  lenses      : ${[runA && 'A', runB && 'B', runC && 'C'].filter(Boolean).join(', ')}`);
  if (imageArg) console.log(`  image       : ${imageArg}`);
  console.log('─────────────────────────────────────────────');

  if (!agent.isAvailable()) {
    console.error('ERROR: Vertex Gemini not configured — set GCP_PROJECT_ID and credentials');
    process.exit(1);
  }

  const results = [];

  if (runA) results.push(await testLensA(agent));
  if (runB) results.push(await testLensB(agent, imageInput));
  if (runC) results.push(await testLensC(agent, imageInput));

  console.log('─────────────────────────────────────────────');
  const passed = results.filter(Boolean).length;
  const total  = results.length;
  const allOk  = passed === total;

  console.log(`  ${allOk ? '✓ ALL PASS' : '✗ SOME FAILED'}  ${passed}/${total} lenses healthy`);
  if (!allOk) {
    console.log('  Pipeline is NOT ready — fix Director Agent errors before running episode generation.');
    process.exit(1);
  }
  console.log('  Pipeline is ready for episode generation.');
}

main().catch(err => {
  console.error('Unhandled error:', err.message);
  process.exit(1);
});
