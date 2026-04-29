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
import { isBlockerOrCritical, isWarning } from './severity.mjs';

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
const EPISODE_ROOT_EDITABLE_FIELDS = new Set(['dramatic_question', 'music_bed_intent', 'hook', 'cliffhanger', 'mood']);
// V4 Phase 5b — Fix 7. Scene-level rewrite scope for Doctor anchor patches.
// `scene_visual_anchor_prompt` is the canvas Seedream uses for the Scene
// Master panel. The monoculture detector + brief-coherence check (Fix 7) emit
// warnings; Doctor patches them by rewriting the offending anchor with varied
// vocabulary that still honors the brief's style_category + the genre register.
const SCENE_LEVEL_EDITABLE_FIELDS = new Set(['scene_visual_anchor_prompt', 'opposing_intents', 'tagline']);
// Warning IDs that ALSO trigger the Doctor (in addition to blocker/critical).
// Without this allowlist, warning-severity issues are advisory-only.
const DOCTOR_WARNING_TRIGGERS = new Set([
  'scene_anchor_monoculture',
  'scene_anchor_violates_style_category',
  'dialogue_beats_too_thin'
]);

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
    if (!scene_id || !field) {
      rejected.push({ op, reason: 'missing scene_id/field' });
      continue;
    }

    // Episode-root patch: scene_id '__episode__' (or bare 'episode'), no beat_id required.
    if (scene_id === '__episode__' || scene_id === 'episode') {
      if (EPISODE_ROOT_EDITABLE_FIELDS.has(field)) {
        sceneGraph[field] = new_value;
        applied.push({ ...op, scope: 'episode_root' });
      } else {
        rejected.push({ op, reason: `field '${field}' is not in the episode root allowlist` });
      }
      continue;
    }

    // V4 Phase 5b — Fix 7. Scene-level patch (no beat_id, scene-level field).
    // Lets the Doctor rewrite scene_visual_anchor_prompt for monoculture +
    // brief-coherence warnings. We resolve the scene first so the same
    // not-found / found-but-wrong-field paths still log clearly.
    if (!beat_id && SCENE_LEVEL_EDITABLE_FIELDS.has(field)) {
      const sceneRef = (sceneGraph.scenes || []).find(s => s.scene_id === scene_id);
      if (!sceneRef) {
        rejected.push({ op, reason: `scene ${scene_id} not found (scene-level patch)` });
        continue;
      }
      sceneRef[field] = new_value;
      applied.push({ ...op, scope: 'scene' });
      continue;
    }
    if (!beat_id) {
      rejected.push({ op, reason: 'missing beat_id (required for non-episode-root ops)' });
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

For EPISODE-ROOT fields (dramatic_question, music_bed_intent, hook, cliffhanger, mood),
use scene_id "__episode__" with NO beat_id key:
  { "scene_id": "__episode__", "field": "dramatic_question", "new_value": "Will Maya finally confront what she buried?" }

For SCENE-LEVEL fields (scene_visual_anchor_prompt, opposing_intents, tagline),
use the real scene_id with NO beat_id key:
  { "scene_id": "s1", "field": "scene_visual_anchor_prompt", "new_value": "..." }

Use scene-level patches when the issue is scene_anchor_monoculture (rewrite the
later scene's anchor with VARIED lighting/mood vocabulary while preserving genre
register) or scene_anchor_violates_style_category (rewrite the offending anchor
to align with the brief's style_category — e.g. for hyperreal_premium replace
"pitch black" with "high-key hero light, even fill, glossy product reflection").

IMPORTANT: For ALL beat-level ops, beat_id MUST be the real beat identifier string (e.g. "s1b3").
NEVER include "beat_id": null on any op — episode-root ops omit beat_id entirely; beat-level ops require it.

RULES you MUST follow:
- Beat-level editable fields are ONLY: dialogue, subtext, expression_notes, emotion, action_notes.
- Episode-root editable fields are ONLY: dramatic_question, music_bed_intent, hook, cliffhanger, mood.
- Never edit any other field.
- Match each character's speech_patterns (vocabulary, sentence length, tics, avoids, signature line) exactly. If two characters in the same scene sound alike, rewrite one to sound more like themselves.
- If a scene has opposing_intents and dialogue doesn't reflect them, rewrite the offending lines so the conflict is audible (via subtext if the line surface must stay polite).
- Lift any beat with dialogue ≤ 3 words that isn't an emotional_hold into a proper line (5-12 words) while preserving the character's voice.
- Keep brand safety: no profanity, no defamation, no politically charged content.
- Keep speakability: no parentheticals, no SFX inline.
- The word count of new dialogue must roughly fit the beat duration at 2.3 words/sec (+/- 30%). Do NOT request duration changes — match the existing duration.

ELEVEN-V3 INLINE PERFORMANCE TAGS (audio layer):
- The "dialogue" field accepts ElevenLabs eleven-v3 inline performance tags in
  square brackets — they shape the audio render. Examples:
    "[barely whispering] I had no choice."
    "[firmly] We need to leave. Now."
    "I'm fine. [exhaling]"
    "[no_tag_intentional: stoic_baseline] I'll consider it."
- VALID TAGS (use ONLY these — do not invent):
    EMOTION:  whispering, barely whispering, softly, evenly, flatly, firmly,
              slowly, quizzically, sad, cheerfully, cautiously, indecisive,
              sarcastically, sigh, exhaling, slow inhale, chuckles, laughing,
              giggling, groaning, coughs, gulps
    EVENTS:   applause, leaves rustling, gentle footsteps  (max ONE per beat)
    DIRECTION: auctioneer, jumping in
- TAG DERIVATION (when patching dialogue, derive tags from craft, not surface):
    beat.emotion → primary tag; beat.subtext → texture/placement;
    beat.beat_intent → tag intensity; persona.dramatic_archetype → baseline.
    A "broken" emotion + "leaning in" subtext → "[exhaling] [slowly] ..."
    A "broken" emotion + "leaning out" subtext → "[evenly] ..." or "[flatly] ..."
- TAG ECONOMY: at most 2 tags per line. Tags must NOT contradict beat.emotion
  (e.g. [laughing] on emotion="broken" is wrong). Audio events (applause /
  leaves rustling / gentle footsteps) at most ONCE per beat.
- WHEN PATCHING tag-related issues (dialogue_missing_audio_tag,
  tag_emotion_contradiction, tag_stack_too_deep, tag_duplicated,
  audio_event_overused): rewrite the dialogue with corrected inline tags
  while preserving the line's word-count and meaning. Do NOT strip tags
  from dialogue when patching unrelated issues — they are part of the line.
- For Stoic / under-tagged baseline reads, use the explicit annotation
  "[no_tag_intentional: stoic_baseline] ..." — it satisfies presence but
  produces an untagged TTS render.

SCENE-LEVEL CO-EDIT CONTRACT (V4 Wave 6 / F7):
When patching a scene's \`opposing_intents\` field, you MUST also re-tag the
dialogue beats in that scene (per the DIALOGUE PERFORMANCE TAGS taxonomy
above) within the SAME patch. New opposing_intents change the speaker-side
tag derivation: a character whose intent was "leaning_in" tagged with
[softly] becomes [firmly] when you flip them to "leaning_out". A character
whose intent was "deflecting" tagged with [evenly] becomes [exhaling] when
you flip them to "conceding". Treat opposing_intents + dialogue tags as a
single semantic unit — never patch one without the other. If you don't see
which dialogue beats need re-tagging from the scene-graph, REWRITE the
opposing_intents conservatively (preserve speaker-side intent direction)
rather than introduce stale tags.

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
 * @param {boolean} [options.force=false] - bypass the BRAND_STORY_SCREENPLAY_DOCTOR env-flag
 *   gate. Used by the V4 Director Agent (L3) Lens-A retry path: when
 *   `BRAND_STORY_DIRECTOR_SCREENPLAY=blocking` is on we want to re-doctor
 *   the screenplay using the director's findings even if the original Doctor
 *   flag is off. Director findings (severity 'critical') are recognized as
 *   blocker-equivalents alongside L1's `severity: 'blocker'`.
 * @returns {Promise<{ patched, applied, rejected, notes, skipped }>}
 */
export async function punchUpScreenplay(sceneGraph, personas = [], issues = [], options = {}) {
  const force = !!options.force;
  const enabled = force || String(process.env.BRAND_STORY_SCREENPLAY_DOCTOR || '').toLowerCase() === 'true';
  if (!enabled) {
    return { patched: sceneGraph, applied: [], rejected: [], notes: '', skipped: 'env flag BRAND_STORY_SCREENPLAY_DOCTOR not set' };
  }
  if (!sceneGraph || typeof sceneGraph !== 'object') {
    return { patched: sceneGraph, applied: [], rejected: [], notes: '', skipped: 'invalid scene graph' };
  }
  if (!isVertexGeminiConfigured()) {
    return { patched: sceneGraph, applied: [], rejected: [], notes: '', skipped: 'Vertex Gemini not configured' };
  }
  // V4 P0.1 — canonical severity check via services/v4/severity.mjs.
  // isBlockerOrCritical accepts both legacy 'blocker' (L1) and canonical
  // 'critical' (L3) transparently. Notes are NEVER triggers (note severity
  // is advisory; surfaces in directorReport.notes via the consumer, not here).
  const triggers = (issues || []).filter(i => {
    if (!i) return false;
    if (isBlockerOrCritical(i.severity)) return true;
    if (isWarning(i.severity) && DOCTOR_WARNING_TRIGGERS.has(i.id)) return true;
    return false;
  });
  if (triggers.length === 0) {
    return { patched: sceneGraph, applied: [], rejected: [], notes: '', skipped: 'no blockers/triggers — nothing to punch up' };
  }
  const blockers = triggers; // alias preserved for the rest of the function

  const working = JSON.parse(JSON.stringify(sceneGraph));
  // Pass only blockers to the Doctor prompt — warnings are advisory and
  // distract Gemini from the primary fix, wasting patch-op budget on fields
  // the Doctor isn't supposed to touch (e.g. sonic_world_overlay_replaces_base
  // causing the Doctor to attempt sonic_world repairs that get rejected).
  const userPrompt = buildUserPrompt({ sceneGraph: working, personas, issues: blockers });

  let parsed;
  try {
    parsed = await callVertexGeminiJson({
      systemPrompt: DOCTOR_SYSTEM_PROMPT,
      userPrompt,
      config: {
        temperature: 0.4,
        // Gemini 3 Flash consumes "thinking tokens" BEFORE emitting visible
        // output. For a multi-beat JSON patch (2+ blockers → 5-10 ops each
        // with dialogue rewrites), 4096 overflows during the thinking phase
        // and truncates mid-string. 16384 gives a ~4x safety margin over
        // observed worst-case Doctor output (~3000 tokens of thinking + ~1500
        // of JSON).
        maxOutputTokens: 16384
      },
      timeoutMs: 90000
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
