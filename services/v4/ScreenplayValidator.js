// services/v4/ScreenplayValidator.js
//
// Layer 1 of the V4 screenplay quality gate — deterministic, dependency-free
// checks on a scene-graph produced by Gemini. The validator returns:
//
//   {
//     issues: [{ id, severity: 'blocker'|'warning', scope, message, hint }],
//     repaired: sceneGraph,     // copy with auto-repairs applied (beat sizing)
//     stats:   { ... },          // aggregate stats for Director's Panel QA panel
//     needsPunchUp: boolean      // true if ≥1 blocker issue — triggers ScreenplayDoctor
//   }
//
// Philosophy: don't block generation on soft-warnings. Block only on craft
// failures that will visibly torpedo the episode (e.g. missing dramatic_question,
// characters blending into one voice, dialogue ≤ 6 words average across the
// episode). The Doctor pass can usually fix these in a minimal patch.
//
// Genre-agnostic. No use-case-specific logic. Thresholds are intentionally
// conservative so legit creative choices (a deliberately short episode,
// a single-persona landscape story) don't trip the validator.

import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `[ScreenplayValidator] ${timestamp} [${level}]: ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

// ──────────────────────────────────────────────────────────────
// Tunable thresholds (single source of truth — easy to tweak)
// ──────────────────────────────────────────────────────────────
export const THRESHOLDS = {
  minDialogueWordsAvg: 6,            // avg words per dialogue beat
  minDialogueBeatRatio: 0.35,        // ≥ 35% of beats are dialogue when 2+ personas
  maxVoiceOverlapRatio: 0.60,        // ≤ 60% token overlap between two characters in same scene
  minSubtextCoverage: 0.40,          // ≥ 40% of dialogue beats have non-null subtext
  maxBareShortLines: 2,              // ≤ 2 beats with dialogue ≤ 3 words AND not emotional_hold
  beatSizeToleranceMin: 0.7,
  beatSizeToleranceMax: 1.3
};

// English stopwords — used for voice-distinctness tokenisation.
const STOPWORDS = new Set([
  'a','an','the','is','was','are','were','am','be','been','being',
  'i','me','my','mine','you','your','yours','he','him','his','she','her','hers','it','its','we','us','our','they','them','their',
  'and','or','but','if','so','not','no','yes','to','of','in','on','at','for','with','by','from','as','about','into','out','up','down',
  'this','that','these','those','there','here','where','when','why','how','what','who','whom','which',
  'do','does','did','done','have','has','had','will','would','shall','should','can','could','may','might','must',
  'too','also','just','then','than','now','ever','never','always','only','even','still','yet','more','less','very','really'
]);

const DIALOGUE_BEARING_TYPES = new Set([
  'TALKING_HEAD_CLOSEUP',
  'DIALOGUE_IN_SCENE',
  'GROUP_DIALOGUE_TWOSHOT',
  'SHOT_REVERSE_SHOT',
  'VOICEOVER_OVER_BROLL'
]);

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function tokenise(line) {
  if (!line || typeof line !== 'string') return [];
  return line
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 0 && !STOPWORDS.has(t));
}

function wordCount(line) {
  if (!line || typeof line !== 'string') return 0;
  return line.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Collect every dialogue line in a scene keyed by persona_index.
 * Handles TALKING_HEAD_CLOSEUP/DIALOGUE_IN_SCENE (single dialogue field),
 * GROUP_DIALOGUE_TWOSHOT (dialogues[]), and SHOT_REVERSE_SHOT (exchanges[]).
 */
function collectSceneDialogueByPersona(scene) {
  const byPersona = {};
  for (const beat of scene.beats || []) {
    if (beat.dialogue && Number.isInteger(beat.persona_index)) {
      const k = String(beat.persona_index);
      (byPersona[k] = byPersona[k] || []).push(beat.dialogue);
    }
    if (Array.isArray(beat.dialogues) && Array.isArray(beat.persona_indexes)) {
      for (let i = 0; i < beat.dialogues.length; i++) {
        const idx = beat.persona_indexes[i];
        if (beat.dialogues[i] && Number.isInteger(idx)) {
          const k = String(idx);
          (byPersona[k] = byPersona[k] || []).push(beat.dialogues[i]);
        }
      }
    }
    if (Array.isArray(beat.exchanges)) {
      for (const ex of beat.exchanges) {
        if (ex.dialogue && Number.isInteger(ex.persona_index)) {
          const k = String(ex.persona_index);
          (byPersona[k] = byPersona[k] || []).push(ex.dialogue);
        }
      }
    }
  }
  return byPersona;
}

function personaLineCount(scene) {
  const byPersona = collectSceneDialogueByPersona(scene);
  return Object.keys(byPersona).length;
}

/**
 * Returns the overlap ratio between two persona's token bags in the same scene.
 * Symmetric: |A ∩ B| / min(|A|, |B|). High overlap = same voice.
 */
function tokenOverlap(linesA, linesB) {
  const a = new Set(linesA.flatMap(tokenise));
  const b = new Set(linesB.flatMap(tokenise));
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / Math.min(a.size, b.size);
}

function countAllDialogueBeats(sceneGraph) {
  let total = 0;
  let dialogue = 0;
  for (const s of sceneGraph.scenes || []) {
    for (const b of s.beats || []) {
      total++;
      if (DIALOGUE_BEARING_TYPES.has(b.type)) dialogue++;
    }
  }
  return { total, dialogue };
}

function countAllDialogueLines(sceneGraph) {
  const lines = [];
  for (const s of sceneGraph.scenes || []) {
    for (const b of s.beats || []) {
      if (b.dialogue) lines.push({ beat: b, text: b.dialogue, persona_index: b.persona_index });
      if (Array.isArray(b.dialogues)) {
        b.dialogues.forEach((d, i) => lines.push({ beat: b, text: d, persona_index: (b.persona_indexes || [])[i] }));
      }
      if (Array.isArray(b.exchanges)) {
        for (const ex of b.exchanges) {
          if (ex.dialogue) lines.push({ beat: b, text: ex.dialogue, persona_index: ex.persona_index, exchange: ex });
        }
      }
    }
  }
  return lines;
}

// ──────────────────────────────────────────────────────────────
// Individual checks
// ──────────────────────────────────────────────────────────────

function checkDramaticQuestion(sceneGraph, issues) {
  if (!sceneGraph.dramatic_question || !String(sceneGraph.dramatic_question).trim()) {
    issues.push({
      id: 'missing_episode_dramatic_question',
      severity: 'blocker',
      scope: 'episode',
      message: 'Episode is missing a dramatic_question — every episode must raise ONE question the viewer wants answered, left tilted at the cliffhanger.',
      hint: 'Fill the top-level "dramatic_question" field with a one-sentence question this episode poses.'
    });
  }
}

function checkSceneHookTypes(sceneGraph, issues) {
  for (const scene of sceneGraph.scenes || []) {
    const hooks = Array.isArray(scene.hook_types) ? scene.hook_types.filter(Boolean) : [];
    if (hooks.length === 0) {
      issues.push({
        id: 'scene_missing_hook_types',
        severity: 'blocker',
        scope: `scene:${scene.scene_id || '?'}`,
        message: `Scene ${scene.scene_id || '?'} has no hook_types declared — every scene must use at least one hook (CLIFFHANGER / REVELATION / CRESCENDO / DRAMATIC_IRONY / STATUS_FLIP / CONTRADICTION_REVEAL / ESCALATION_OF_ASK).`,
        hint: 'Add ≥ 1 entry to scene.hook_types.'
      });
    }
  }
}

function checkOpposingIntents(sceneGraph, issues) {
  for (const scene of sceneGraph.scenes || []) {
    const personasInScene = personaLineCount(scene);
    if (personasInScene >= 2) {
      const oi = scene.opposing_intents;
      const hasAtLeastTwo = oi && typeof oi === 'object' && Object.keys(oi).length >= 2 && Object.values(oi).every(v => typeof v === 'string' && v.trim().length > 0);
      if (!hasAtLeastTwo) {
        issues.push({
          id: 'scene_missing_opposing_intents',
          severity: 'blocker',
          scope: `scene:${scene.scene_id || '?'}`,
          message: `Scene ${scene.scene_id || '?'} has ${personasInScene} characters speaking but no opposing_intents — dialogue will flatten into agreement.`,
          hint: 'Add scene.opposing_intents: { "[0]": "what A wants here", "[1]": "what B wants (must oppose)" }'
        });
      }
    }
  }
}

function checkVoiceDistinctness(sceneGraph, issues) {
  for (const scene of sceneGraph.scenes || []) {
    const byPersona = collectSceneDialogueByPersona(scene);
    const keys = Object.keys(byPersona);
    if (keys.length < 2) continue;
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const a = keys[i], b = keys[j];
        const overlap = tokenOverlap(byPersona[a], byPersona[b]);
        if (overlap > THRESHOLDS.maxVoiceOverlapRatio) {
          issues.push({
            id: 'voice_overlap_too_high',
            severity: 'blocker',
            scope: `scene:${scene.scene_id || '?'}`,
            message: `Characters [${a}] and [${b}] share ${Math.round(overlap * 100)}% of content tokens in scene ${scene.scene_id || '?'} — their voices are blurring.`,
            hint: 'Differentiate vocabularies / sentence rhythms / tics per the character cheat-sheet. One should be more clipped; one should use their signature register more.'
          });
        }
      }
    }
  }
}

function checkDialogueBeatRatio(sceneGraph, personas, issues, storyFocus) {
  const hasMultiplePersonas = Array.isArray(personas) && personas.length >= 2;
  if (!hasMultiplePersonas) return;
  if (storyFocus === 'landscape') return;
  const { total, dialogue } = countAllDialogueBeats(sceneGraph);
  if (total === 0) return;
  const ratio = dialogue / total;
  if (ratio < THRESHOLDS.minDialogueBeatRatio) {
    issues.push({
      id: 'dialogue_beat_ratio_too_low',
      severity: 'blocker',
      scope: 'episode',
      message: `Only ${dialogue}/${total} beats carry dialogue (${Math.round(ratio * 100)}% vs ${Math.round(THRESHOLDS.minDialogueBeatRatio * 100)}% minimum). Characters are being compressed into silence.`,
      hint: 'Convert some B_ROLL / REACTION beats into TALKING_HEAD_CLOSEUP or SHOT_REVERSE_SHOT beats — or merge two short dialogue beats into one denser 5-6s beat.'
    });
  }
}

function checkAvgDialogueLength(sceneGraph, issues) {
  const lines = countAllDialogueLines(sceneGraph);
  if (lines.length === 0) return;
  const totalWords = lines.reduce((s, l) => s + wordCount(l.text), 0);
  const avg = totalWords / lines.length;
  if (avg < THRESHOLDS.minDialogueWordsAvg) {
    issues.push({
      id: 'dialogue_too_sparse',
      severity: 'blocker',
      scope: 'episode',
      message: `Average dialogue length is ${avg.toFixed(1)} words per line — below the ${THRESHOLDS.minDialogueWordsAvg}-word bar. Lines are too sparse to carry character or conflict.`,
      hint: 'Write FEWER but DENSER dialogue beats (5-8s each). Apply the "One Great Line" principle: one real line beats six fillers.'
    });
  }
}

function checkSubtextCoverage(sceneGraph, issues) {
  const lines = countAllDialogueLines(sceneGraph);
  if (lines.length === 0) return;
  const withSubtext = lines.filter(l => {
    if (l.exchange && l.exchange.subtext) return true;
    return l.beat && l.beat.subtext && String(l.beat.subtext).trim().length > 0;
  }).length;
  const ratio = withSubtext / lines.length;
  if (ratio < THRESHOLDS.minSubtextCoverage) {
    issues.push({
      id: 'subtext_coverage_low',
      severity: 'warning',
      scope: 'episode',
      message: `Only ${Math.round(ratio * 100)}% of dialogue beats carry subtext (target ≥ ${Math.round(THRESHOLDS.minSubtextCoverage * 100)}%). Too much of this episode is on-the-nose.`,
      hint: 'Add subtext on beats where the character says one thing but means another — see DIALOGUE MASTERCLASS "Subtext — The Iron Rule".'
    });
  }
}

function checkOneGreatLinePrinciple(sceneGraph, issues) {
  let bareShort = 0;
  const lines = countAllDialogueLines(sceneGraph);
  for (const l of lines) {
    if (wordCount(l.text) <= 3 && !(l.beat && l.beat.emotional_hold)) bareShort++;
  }
  if (bareShort > THRESHOLDS.maxBareShortLines) {
    issues.push({
      id: 'too_many_bare_short_lines',
      severity: 'warning',
      scope: 'episode',
      message: `${bareShort} dialogue beats are ≤ 3 words without an emotional_hold marker — too many micro-lines dilute rhythm.`,
      hint: 'Either expand short lines into real lines (5-12 words) OR mark the deliberately short ones as emotional_hold: true so post-production reads the silence as craft.'
    });
  }
}

function checkIntensityRamp(sceneGraph, storyline, issues) {
  const ledger = storyline && storyline.emotional_intensity_ledger;
  if (!ledger || typeof ledger !== 'object') return;
  const entries = Object.entries(ledger)
    .map(([k, v]) => [Number(k), Number(v)])
    .filter(([k, v]) => Number.isFinite(k) && Number.isFinite(v))
    .sort((a, b) => a[0] - b[0]);
  if (entries.length === 0) return;
  const lastEntry = entries[entries.length - 1];
  const lastClosing = lastEntry[1];
  if (!Number.isFinite(lastClosing)) return;
  const newEmotional = (sceneGraph.emotional_state || sceneGraph.mood || '').toLowerCase();
  if (lastClosing >= 7 && /(calm|serene|resolved|peaceful|content)/.test(newEmotional)) {
    issues.push({
      id: 'intensity_ramp_drop',
      severity: 'warning',
      scope: 'episode',
      message: `Previous episode closed at intensity ${lastClosing}/10 but this episode's emotional_state reads as calm/resolved — viewer's nervous system was calibrated higher.`,
      hint: 'Open at or above the prior closing intensity. If you want to de-escalate, earn it across the first scene, not in the opening beat.'
    });
  }
}

function _repairSingleDurationAgainstWords(totalWords, currentDurationSec) {
  // Returns the fixed duration_seconds if a repair is needed, else null.
  // Words/second model matches the TTS pacing baseline (2.3 wps English).
  if (totalWords === 0) return null;
  if (!Number.isFinite(currentDurationSec) || currentDurationSec <= 0) return null;
  const expectedSec = totalWords / 2.3;
  const ratio = expectedSec / currentDurationSec;
  if (ratio >= THRESHOLDS.beatSizeToleranceMin && ratio <= THRESHOLDS.beatSizeToleranceMax) {
    return null;
  }
  const fixed = Math.max(3, Math.min(8, Math.round(expectedSec)));
  return fixed !== currentDurationSec ? fixed : null;
}

function repairBeatSizing(sceneGraph, issues) {
  let repaired = 0;
  let repairedExchanges = 0;
  for (const scene of sceneGraph.scenes || []) {
    for (const beat of scene.beats || []) {
      if (beat.emotional_hold) continue;

      // SHOT_REVERSE_SHOT (and any beat carrying exchanges[]): each exchange
      // has its OWN duration_seconds that the compiler propagates to its
      // expanded child closeup. Sizing check must therefore run PER EXCHANGE
      // — not against the aggregate word count of the whole beat.
      //
      // Caught 2026-04-21: a 4-word exchange on a 3s child beat hit the TTS
      // speed clamp (0.53x wanted, 0.7x minimum) leaving 0.7s of trailing
      // silence. The old repair path checked aggregate words and missed it
      // because other exchanges in the same SRS filled out the totals.
      if (Array.isArray(beat.exchanges) && beat.exchanges.length > 0) {
        for (const ex of beat.exchanges) {
          if (ex.emotional_hold) continue;
          const exWords = wordCount(ex.dialogue || '');
          const fixed = _repairSingleDurationAgainstWords(exWords, Number(ex.duration_seconds) || 0);
          if (fixed !== null) {
            ex.duration_seconds = fixed;
            repairedExchanges++;
          }
        }
        continue; // SRS beat-level duration is synthesised from exchanges; don't double-repair
      }

      // Non-SRS beats: aggregate dialogue across the beat's own dialogue fields.
      const lines = [];
      if (beat.dialogue) lines.push(beat.dialogue);
      if (Array.isArray(beat.dialogues)) lines.push(...beat.dialogues);
      if (lines.length === 0) continue;
      const totalWords = lines.reduce((s, l) => s + wordCount(l), 0);
      const fixed = _repairSingleDurationAgainstWords(totalWords, Number(beat.duration_seconds) || 0);
      if (fixed !== null) {
        beat.duration_seconds = fixed;
        repaired++;
      }
    }
  }
  if (repaired > 0 || repairedExchanges > 0) {
    const parts = [];
    if (repaired > 0) parts.push(`${repaired} beat(s)`);
    if (repairedExchanges > 0) parts.push(`${repairedExchanges} SHOT_REVERSE_SHOT exchange(s)`);
    issues.push({
      id: 'beat_sizing_auto_repaired',
      severity: 'warning',
      scope: 'episode',
      message: `Auto-repaired duration_seconds on ${parts.join(' and ')} to match dialogue word count at 2.3 words/sec.`,
      hint: 'No action required — sizing was out of tolerance; durations were clamped into the 3-8s range.'
    });
  }
}

// ──────────────────────────────────────────────────────────────
// Public entry point
// ──────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────
// Phase 4.4 — Mouth-occlusion guard
// ──────────────────────────────────────────────────────────────
//
// Sync Lipsync v3 fails (or visibly warps) when hand gestures overlap the
// mouth region at the moment of dialogue. Gemini occasionally writes
// action_notes like "hands near face", "rubbing chin", "lips pursed behind
// fingers" on dialogue beats — the model then generates frames where the
// mouth is obscured and the corrective lipsync pass cannot find it.
//
// We emit a WARNING (not a blocker) with a hint so the Doctor can rewrite
// the gesture, or the Director Panel can show a caution chip. This keeps the
// episode generating while surfacing the risk.
const MOUTH_OCCLUSION_PATTERNS = [
  /hands?\s+(near|at|over|to)\s+(mouth|face|lips|chin)/i,
  /(touching|rubbing|cover(ing)?|wiping)\s+(mouth|lips|chin|face)/i,
  /fingers?\s+(to|on|over)\s+(lips|mouth)/i,
  /biting\s+(lip|nail|knuckle)/i,
  /chewing\s+(on|fingernail)/i,
  /palm\s+(on|against)\s+face/i
];

function beatHasMouthOcclusion(beat) {
  const candidates = [
    beat?.action_notes,
    beat?.blocking_notes,
    beat?.expression_notes,
    beat?.subtext
  ].filter(s => typeof s === 'string' && s.length > 0);
  for (const text of candidates) {
    for (const pattern of MOUTH_OCCLUSION_PATTERNS) {
      if (pattern.test(text)) return true;
    }
  }
  return false;
}

function checkMouthOcclusion(sceneGraph, issues) {
  let flaggedCount = 0;
  for (const scene of sceneGraph.scenes || []) {
    for (const beat of scene.beats || []) {
      if (!DIALOGUE_BEARING_TYPES.has(beat.type)) continue;
      if (beatHasMouthOcclusion(beat)) {
        flaggedCount++;
        issues.push({
          id: 'mouth_occlusion_risk',
          severity: 'warning',
          scope: `beat:${beat.beat_id}`,
          message: `Beat ${beat.beat_id} [${beat.type}] has a dialogue line alongside a gesture that may occlude the mouth region — Sync Lipsync v3 can fail or warp on frames where the mouth is hidden.`,
          hint: 'Move the hand/face gesture to a non-speaking moment, or replace the gesture (e.g. "hand at collar" instead of "hand at chin"). Alternatively, shift the line to a REACTION beat.'
        });
      }
    }
  }
  if (flaggedCount > 0) {
    logger.info(`mouth-occlusion guard flagged ${flaggedCount} dialogue beat(s)`);
  }
}

// ──────────────────────────────────────────────────────────────
// Phase 1.1 — Subject mandate check
// ──────────────────────────────────────────────────────────────
//
// When the story's Subject Bible sets `integration_mandate.min_beats_per_episode`,
// the episode MUST contain at least that many beats where the product/landscape
// appears. Counted as either:
//   - beat.subject_present === true (explicit flag from Gemini)
//   - beat.type ∈ { INSERT_SHOT, B_ROLL_ESTABLISHING } AND subject naturally implied
//
// Blocker if zero beats mention the subject and the mandate is explicit;
// warning if below threshold (the Doctor can add an INSERT_SHOT to fix).
function checkSubjectMandate(sceneGraph, storyline, options, issues) {
  const bible = options?.subject_bible || storyline?.subject_bible || null;
  const mandate = bible?.integration_mandate;
  if (!mandate || typeof mandate.min_beats_per_episode !== 'number') return;

  const SUBJECT_ANCHORED_TYPES = new Set(['INSERT_SHOT', 'B_ROLL_ESTABLISHING']);
  let subjectBeats = 0;
  for (const scene of sceneGraph.scenes || []) {
    for (const beat of scene.beats || []) {
      if (beat.subject_present === true) {
        subjectBeats++;
        continue;
      }
      if (SUBJECT_ANCHORED_TYPES.has(beat.type)) {
        // Heuristic: INSERT_SHOT always carries the subject; B_ROLL counts when
        // the beat explicitly mentions the subject by name.
        if (beat.type === 'INSERT_SHOT') { subjectBeats++; continue; }
        const subjectName = (bible?.name || options?.subject?.name || '').toLowerCase();
        const combined = `${beat.location || ''} ${beat.visual_prompt || ''} ${beat.subject_focus || ''}`.toLowerCase();
        if (subjectName && combined.includes(subjectName)) subjectBeats++;
      }
    }
  }

  if (subjectBeats === 0) {
    issues.push({
      id: 'subject_missing_from_episode',
      severity: 'blocker',
      scope: 'episode',
      message: `Subject "${bible?.name || 'subject'}" does not appear in ANY beat of this episode. The Subject Bible mandate requires ≥ ${mandate.min_beats_per_episode}.`,
      hint: 'Add at least one INSERT_SHOT hero beat or mark a B_ROLL_ESTABLISHING with subject_present=true and the subject visible in its location/visual_prompt.'
    });
  } else if (subjectBeats < mandate.min_beats_per_episode) {
    issues.push({
      id: 'subject_underrepresented',
      severity: 'warning',
      scope: 'episode',
      message: `Subject appears in ${subjectBeats} beat(s) — below the Subject Bible minimum of ${mandate.min_beats_per_episode} per episode.`,
      hint: 'Promote an existing establishing beat to subject_present=true, or add a dedicated INSERT_SHOT.'
    });
  }
}

/**
 * Validate a V4 scene-graph against the Layer-1 checklist.
 *
 * @param {Object} sceneGraph - the scene-graph emitted by Gemini
 * @param {Object} storyline - the parent storyline (for intensity ledger lookup)
 * @param {Object[]} personas - persona_config.personas[]
 * @param {Object} [options]
 * @param {string} [options.storyFocus='product'] - 'person' | 'product' | 'landscape'
 * @returns {{ issues, repaired, stats, needsPunchUp }}
 */
export function validateScreenplay(sceneGraph, storyline = {}, personas = [], options = {}) {
  const { storyFocus = 'product' } = options;
  if (!sceneGraph || typeof sceneGraph !== 'object') {
    return {
      issues: [{ id: 'no_scene_graph', severity: 'blocker', scope: 'episode', message: 'No scene graph to validate.', hint: '' }],
      repaired: sceneGraph,
      stats: {},
      needsPunchUp: false
    };
  }

  // Work on a deep copy to keep auto-repairs contained to the return value.
  const repaired = JSON.parse(JSON.stringify(sceneGraph));
  const issues = [];

  checkDramaticQuestion(repaired, issues);
  checkSceneHookTypes(repaired, issues);
  checkOpposingIntents(repaired, issues);
  checkVoiceDistinctness(repaired, issues);
  checkDialogueBeatRatio(repaired, personas, issues, storyFocus);
  checkAvgDialogueLength(repaired, issues);
  checkSubtextCoverage(repaired, issues);
  checkOneGreatLinePrinciple(repaired, issues);
  checkIntensityRamp(repaired, storyline, issues);
  checkMouthOcclusion(repaired, issues);
  checkSubjectMandate(repaired, storyline, options, issues);
  repairBeatSizing(repaired, issues);

  const { total, dialogue } = countAllDialogueBeats(repaired);
  const lines = countAllDialogueLines(repaired);
  const avgWords = lines.length > 0 ? lines.reduce((s, l) => s + wordCount(l.text), 0) / lines.length : 0;
  const withSubtext = lines.filter(l => (l.exchange && l.exchange.subtext) || (l.beat && l.beat.subtext)).length;

  const stats = {
    total_beats: total,
    dialogue_beats: dialogue,
    dialogue_beat_ratio: total > 0 ? dialogue / total : 0,
    dialogue_lines: lines.length,
    avg_dialogue_words: Number(avgWords.toFixed(2)),
    subtext_coverage: lines.length > 0 ? withSubtext / lines.length : 0,
    scenes: (repaired.scenes || []).length
  };

  const needsPunchUp = issues.some(i => i.severity === 'blocker');

  logger.info(`${issues.length} issues (${issues.filter(i => i.severity === 'blocker').length} blocker, ${issues.filter(i => i.severity === 'warning').length} warning). Stats: beats=${stats.total_beats} dialogue_beats=${stats.dialogue_beats} avg_words=${stats.avg_dialogue_words} subtext=${Math.round(stats.subtext_coverage * 100)}%`);

  return { issues, repaired, stats, needsPunchUp };
}

export default { validateScreenplay, THRESHOLDS };
