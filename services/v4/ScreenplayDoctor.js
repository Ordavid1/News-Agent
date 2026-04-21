// services/v4/ScreenplayDoctor.js
//
// Layer 2 of the V4 screenplay quality gate — a Gemini "script doctor" that
// punches up dialogue in a minimal, targeted way when the Layer-1 validator
// flags blocker issues. The Doctor is strict by design:
//
//   - It does NOT change structure (beat types, counts, persona_index, duration,
//     scene_id, or any routing-critical field).
//   - It edits ONLY dialogue/subtext/expression_notes/emotion on specific beats.
//   - It returns a JSON PATCH (a list of { scene_id, beat_id, field, new_value }),
//     not a full scene graph. The patch is applied surgically.
//   - It runs AT MOST ONCE per episode. If its output still fails Layer 1, we
//     log the failure and proceed with the (partially) improved scene graph —
//     we never loop.
//
// Gated behind the BRAND_STORY_SCREENPLAY_DOCTOR env flag. Default off until
// validated in production.
//
// Cost: one Gemini 3 Flash call per triggered episode. Sub-cent per episode.

import winston from 'winston';
import { callVertexGeminiJson, isVertexGeminiConfigured } from './VertexGemini.js';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `[ScreenplayDoctor] ${timestamp} [${level}]: ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

const EDITABLE_FIELDS = new Set(['dialogue', 'subtext', 'expression_notes', 'emotion', 'action_notes']);

/**
 * Render a compact character bible for the Doctor prompt. Only the fields
 * that inform line rewriting — no appearance, no voice ids.
 */
function renderPersonaBible(personas = []) {
  if (!Array.isArray(personas) || personas.length === 0) return '(no personas available)';
  return personas.map((p, i) => {
    if (!p) return `[${i}] (missing)`;
    const sp = p.speech_patterns || {};
    return `[${i}] ${p.name || `Persona ${i + 1}`}
  archetype: ${p.dramatic_archetype || '—'}
  want: ${p.want || '—'}
  need: ${p.need || '—'}
  wound: ${p.wound || '—'}
  flaw: ${p.flaw || '—'}
  moral_code: ${p.moral_code || '—'}
  speech register: ${sp.vocabulary || '—'}
  rhythm: ${sp.sentence_length || '—'}
  tics: ${Array.isArray(sp.tics) ? sp.tics.join(' | ') : '—'}
  avoids: ${Array.isArray(sp.avoids) ? sp.avoids.join(' | ') : '—'}
  signature line: ${sp.signature_line ? `"${sp.signature_line}"` : '—'}`;
  }).join('\n\n');
}

/**
 * Render a minimal, edit-focused view of the scene graph: just scene_id + beat_id
 * + persona_index + type + current dialogue/subtext/emotion/expression. The Doctor
 * doesn't need the full visual anchor or ambient beds.
 */
function renderSceneGraphMinimal(sceneGraph) {
  const out = [];
  for (const scene of sceneGraph.scenes || []) {
    out.push(`SCENE ${scene.scene_id || '?'} — ${scene.location || ''}
  hook_types: ${Array.isArray(scene.hook_types) ? scene.hook_types.join(',') : '—'}
  opposing_intents: ${scene.opposing_intents ? JSON.stringify(scene.opposing_intents) : '—'}`);
    for (const beat of scene.beats || []) {
      const parts = [`  beat_id=${beat.beat_id || '?'} type=${beat.type}`];
      if (Number.isInteger(beat.persona_index)) parts.push(`persona=[${beat.persona_index}]`);
      if (beat.duration_seconds) parts.push(`dur=${beat.duration_seconds}s`);
      if (beat.dialogue) parts.push(`dialogue="${beat.dialogue}"`);
      if (beat.subtext) parts.push(`subtext="${beat.subtext}"`);
      if (beat.emotion) parts.push(`emotion="${beat.emotion}"`);
      if (beat.expression_notes) parts.push(`expr="${beat.expression_notes}"`);
      if (Array.isArray(beat.exchanges)) {
        parts.push('exchanges:');
        beat.exchanges.forEach((ex, i) => {
          parts.push(`    [${i}] persona=[${ex.persona_index}] dialogue="${ex.dialogue || ''}" subtext="${ex.subtext || ''}" emotion="${ex.emotion || ''}"`);
        });
      }
      out.push(parts.join(' '));
    }
  }
  return out.join('\n');
}

function renderIssues(issues) {
  if (!Array.isArray(issues) || issues.length === 0) return '(no issues — do nothing)';
  return issues
    .filter(i => i && typeof i === 'object')
    .map(i => `- [${i.severity}] ${i.scope}: ${i.message}${i.hint ? ` (hint: ${i.hint})` : ''}`)
    .join('\n');
}

/**
 * Apply a Doctor patch to the scene graph in-place-on-copy.
 * Each op: { scene_id, beat_id, field, new_value, exchange_index? }.
 * Invalid ops are logged and skipped; we never error out the pipeline.
 */
function applyPatch(sceneGraph, operations = []) {
  const applied = [];
  const rejected = [];
  if (!Array.isArray(operations)) return { patched: sceneGraph, applied, rejected };

  for (const op of operations) {
    if (!op || typeof op !== 'object') {
      rejected.push({ op, reason: 'op is not an object' });
      continue;
    }
    const { scene_id, beat_id, field, new_value } = op;
    if (!scene_id || !beat_id || !field) {
      rejected.push({ op, reason: 'missing scene_id/beat_id/field' });
      continue;
    }
    if (!EDITABLE_FIELDS.has(field)) {
      rejected.push({ op, reason: `field '${field}' is not in the editable allowlist` });
      continue;
    }
    const scene = (sceneGraph.scenes || []).find(s => s.scene_id === scene_id);
    if (!scene) {
      rejected.push({ op, reason: `scene ${scene_id} not found` });
      continue;
    }
    const beat = (scene.beats || []).find(b => b.beat_id === beat_id);
    if (!beat) {
      rejected.push({ op, reason: `beat ${beat_id} not found in scene ${scene_id}` });
      continue;
    }
    if (Number.isInteger(op.exchange_index) && Array.isArray(beat.exchanges)) {
      const ex = beat.exchanges[op.exchange_index];
      if (!ex) {
        rejected.push({ op, reason: `exchange index ${op.exchange_index} out of range` });
        continue;
      }
      ex[field] = new_value;
      applied.push({ ...op, scope: 'exchange' });
    } else {
      beat[field] = new_value;
      applied.push({ ...op, scope: 'beat' });
    }
  }
  return { patched: sceneGraph, applied, rejected };
}

const DOCTOR_SYSTEM_PROMPT = `You are a script doctor for a prestige TV pipeline.

You do NOT rewrite the story. You do NOT change scenes, beat types, counts,
durations, persona_index, beat_id, or structure. You rewrite ONLY dialogue,
subtext, expression_notes, emotion, and action_notes on specific beats, and
you do it minimally — the smallest edits that resolve the listed issues.

Given the scene graph (in compact form below), the character bibles, and the
list of quality issues, return ONLY a JSON object of the form:

{
  "patch": [
    { "scene_id": "s1", "beat_id": "s1b3", "field": "dialogue", "new_value": "..." },
    { "scene_id": "s1", "beat_id": "s1b3", "field": "subtext", "new_value": "..." },
    { "scene_id": "s1", "beat_id": "s1b4", "field": "expression_notes", "new_value": "..." }
  ],
  "notes": "one-sentence summary of what you changed and why"
}

For SHOT_REVERSE_SHOT beats (which carry exchanges[]), include "exchange_index" on
the op to target a specific exchange:
  { "scene_id":"s2","beat_id":"s2b4","exchange_index":1,"field":"dialogue","new_value":"..." }

RULES you MUST follow:
- Editable fields are ONLY: dialogue, subtext, expression_notes, emotion, action_notes. Never anything else.
- Match each character's speech_patterns (vocabulary, sentence length, tics, avoids, signature line) exactly. If two characters in the same scene sound alike, rewrite one to sound more like themselves.
- If a scene has opposing_intents and dialogue doesn't reflect them, rewrite the offending lines so the conflict is audible (via subtext if the line surface must stay polite).
- Lift any beat with dialogue ≤ 3 words that isn't an emotional_hold into a proper line (5-12 words) while preserving the character's voice.
- Keep brand safety: no profanity, no defamation, no politically charged content.
- Keep speakability: no parentheticals, no SFX inline.
- The word count of new dialogue must roughly fit the beat duration at 2.3 words/sec (+/- 30%). Do NOT request duration changes — match the existing duration.
- Respond with ONLY the JSON object. No preamble, no code fences.`;

/**
 * Build the user prompt for one Doctor call.
 */
function buildUserPrompt({ sceneGraph, personas, issues }) {
  return `EPISODE QUALITY ISSUES TO FIX:
${renderIssues(issues)}

CHARACTER BIBLES (the voice law):
${renderPersonaBible(personas)}

CURRENT SCENE GRAPH (edit in place, minimally):
${renderSceneGraphMinimal(sceneGraph)}

Return the JSON patch now.`;
}

/**
 * Entry point. Calls Gemini, applies the patch to a deep copy of the scene graph,
 * and returns { patched, applied, rejected, notes }. Never throws — on any
 * failure (env flag off, no creds, bad JSON, network error) returns the input
 * scene graph untouched with a human-readable reason.
 *
 * @param {Object} sceneGraph
 * @param {Object[]} personas
 * @param {Object[]} issues - Layer-1 issues (blockers drive the rewrite)
 * @param {Object} [options]
 * @returns {Promise<{ patched, applied, rejected, notes, skipped }>}
 */
export async function punchUpScreenplay(sceneGraph, personas = [], issues = [], options = {}) {
  const enabled = String(process.env.BRAND_STORY_SCREENPLAY_DOCTOR || '').toLowerCase() === 'true';
  if (!enabled) {
    return { patched: sceneGraph, applied: [], rejected: [], notes: '', skipped: 'env flag BRAND_STORY_SCREENPLAY_DOCTOR not set' };
  }
  if (!sceneGraph || typeof sceneGraph !== 'object') {
    return { patched: sceneGraph, applied: [], rejected: [], notes: '', skipped: 'invalid scene graph' };
  }
  if (!isVertexGeminiConfigured()) {
    return { patched: sceneGraph, applied: [], rejected: [], notes: '', skipped: 'Vertex Gemini not configured' };
  }
  // Only run when there's at least one blocker to fix. Warnings don't trigger
  // the Doctor — they're advisory and don't block generation.
  const blockers = (issues || []).filter(i => i && i.severity === 'blocker');
  if (blockers.length === 0) {
    return { patched: sceneGraph, applied: [], rejected: [], notes: '', skipped: 'no blockers — nothing to punch up' };
  }

  const working = JSON.parse(JSON.stringify(sceneGraph));
  const userPrompt = buildUserPrompt({ sceneGraph: working, personas, issues });

  let parsed;
  try {
    parsed = await callVertexGeminiJson({
      systemPrompt: DOCTOR_SYSTEM_PROMPT,
      userPrompt,
      config: {
        temperature: 0.4,
        maxOutputTokens: 4096
      },
      timeoutMs: 60000
    });
  } catch (err) {
    logger.warn(`Doctor call failed (${err.message}) — returning original scene graph`);
    return { patched: sceneGraph, applied: [], rejected: [], notes: '', skipped: `doctor call failed: ${err.message}` };
  }

  if (!parsed || !Array.isArray(parsed.patch)) {
    logger.warn('Doctor returned no patch array — skipping');
    return { patched: sceneGraph, applied: [], rejected: [], notes: parsed?.notes || '', skipped: 'no patch returned' };
  }

  const { patched, applied, rejected } = applyPatch(working, parsed.patch);
  logger.info(`Doctor applied ${applied.length}/${parsed.patch.length} ops (${rejected.length} rejected). Notes: ${parsed.notes || '(none)'}`);
  return { patched, applied, rejected, notes: parsed.notes || '', skipped: null };
}

export default { punchUpScreenplay };
