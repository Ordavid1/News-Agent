// services/v4/ScreenplayValidator.js
//
// Layer 1 of the V4 screenplay quality gate — deterministic, dependency-free
// checks on a scene-graph produced by Gemini. The validator returns:
//
//   {
//     issues: [{ id, severity: 'critical'|'warning', scope, message, hint }],
//     // Note: severity uses canonical V4 P0.1 vocabulary (services/v4/severity.mjs).
//     // Legacy 'blocker' is aliased to 'critical' via normalizeSeverity for back-compat.
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

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import winston from 'winston';
import { detectAmbientBedPhrasing } from '../SoundEffectsService.js';
import { resolveDialogueFloor, isGenreRegisterLibraryEnabled } from './GenreRegister.js';
import { isBlockerOrCritical } from './severity.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Phase 3 feature flag — when true, the validator reads its thresholds and
// pattern lists from data files (assets/genre-registers/library.json,
// assets/screenplay/forbidden-registers.json) instead of the inline
// THRESHOLDS / AD_COPY_BAN_PATTERNS constants. Default false during
// migration; flip to true after Phase 2 + 3 soak in staging for >=1 release
// cycle. The legacy code paths stay until Phase 4 cleanup.
function isValidatorParameterized() {
  return String(process.env.BRAND_STORY_VALIDATOR_PARAMETERIZED || 'false').toLowerCase() === 'true';
}

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
  beatSizeToleranceMax: 1.3,
  // emotional_hold is the ONLY exemption from the dialogue-density floor.
  // To prevent Gemini from gaming the flag (flipping it on every short beat
  // to dodge dialogue_too_sparse), the hold must be JUSTIFIED — i.e. the
  // beat must carry substantive expression_notes OR subtext explaining what
  // the silence is doing. An unearned hold is treated as ordinary sparse
  // dialogue (counted in avg-words and bare-short tallies).
  emotionalHoldMinJustificationWords: 5
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
// V4 Audio Layer — eleven-v3 inline performance tag taxonomy
// ──────────────────────────────────────────────────────────────
//
// The DIALOGUE PERFORMANCE TAGS masterclass block in
// public/components/brandStoryPromptsV4.mjs teaches Gemini to author dialogue
// with inline tags (e.g. `[barely whispering] I had no choice.`). This block
// is the deterministic check that confirms (a) tags are present where the
// craft warrants them, (b) tag-emotion coherence holds, (c) tags aren't
// stacked beyond eleven-v3's tolerance, and (d) audio events aren't
// over-used. Severity is warning across the board — Stoic-baseline reads
// legitimately want flat dialogue, and a missing tag is rarely fatal. The
// Doctor patches the worst offenders. Hard-blocker behaviour is gated
// behind BRAND_STORY_AUDIO_TAGS_REQUIRED for future tightening.
const ELEVEN_V3_EMOTION_TAGS = new Set([
  'whispering', 'barely whispering', 'softly', 'evenly', 'flatly',
  'firmly', 'slowly', 'quizzically',
  'sad', 'cheerfully', 'cautiously', 'indecisive',
  'sarcastically', 'sigh', 'exhaling', 'slow inhale',
  'chuckles', 'laughing', 'giggling',
  'groaning', 'coughs', 'gulps'
]);
const ELEVEN_V3_AUDIO_EVENT_TAGS = new Set([
  'applause', 'leaves rustling', 'gentle footsteps'
]);
const ELEVEN_V3_DIRECTION_TAGS = new Set([
  'auctioneer', 'jumping in'
]);
const ELEVEN_V3_ALL_TAGS = new Set([
  ...ELEVEN_V3_EMOTION_TAGS,
  ...ELEVEN_V3_AUDIO_EVENT_TAGS,
  ...ELEVEN_V3_DIRECTION_TAGS
]);

// Tag-emotion coherence map. Keys are emotion-family tokens (lowercase
// substring match against beat.emotion); values are tag-name sets that
// CONFLICT with that emotion. A coherence violation is when the dialogue
// carries a tag from the conflict set while the beat's declared emotion
// matches the family. Authored from the DIALOGUE PERFORMANCE TAGS block's
// 12 worked examples — keep in sync if the masterclass adds new families.
const TAG_EMOTION_CONFLICTS = [
  {
    emotion_keywords: ['broken', 'resigned', 'defeated', 'grief', 'crushed', 'sad'],
    conflicting_tags: new Set(['laughing', 'chuckles', 'giggling', 'cheerfully', 'firmly'])
  },
  {
    emotion_keywords: ['cheerful', 'amused', 'delighted', 'happy', 'playful'],
    conflicting_tags: new Set(['sad', 'groaning', 'sigh', 'exhaling', 'barely whispering', 'slow inhale'])
  },
  {
    emotion_keywords: ['urgent', 'panicked', 'frantic', 'desperate', 'fearful'],
    conflicting_tags: new Set(['slowly', 'evenly', 'chuckles', 'cheerfully', 'flatly'])
  },
  {
    emotion_keywords: ['defiant', 'firm', 'commanding', 'resolute'],
    conflicting_tags: new Set(['barely whispering', 'sad', 'indecisive', 'cautiously', 'quizzically'])
  },
  {
    emotion_keywords: ['stunned', 'dazed', 'shellshocked', 'numb'],
    conflicting_tags: new Set(['cheerfully', 'laughing', 'firmly', 'chuckles'])
  }
];

// Annotation pattern that signals an intentionally untagged read (matches
// the DIALOGUE PERFORMANCE TAGS masterclass — `[no_tag_intentional: <baseline>]`).
// Recognised for coverage but stripped before TTS synthesis.
const NO_TAG_ANNOTATION_PATTERN = /\[no_tag_intentional\s*:\s*[a-z0-9_\- ]+\]/i;

// Bracketed-token extractor. eleven-v3 tags live inside [square brackets] in
// the dialogue string. Multi-word tags (`[barely whispering]`) and
// stacked-comma tags (`[sarcastically, slowly]`) both supported.
function extractBracketTokens(text) {
  if (!text || typeof text !== 'string') return [];
  const matches = text.matchAll(/\[([^\]]+)\]/g);
  const tokens = [];
  for (const m of matches) {
    const inner = String(m[1]).trim();
    if (NO_TAG_ANNOTATION_PATTERN.test(`[${inner}]`)) {
      tokens.push({ raw: inner, kind: 'baseline_annotation' });
      continue;
    }
    // Stacked comma form — `[sarcastically, slowly]` → two tokens.
    const parts = inner.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    for (const p of parts) {
      tokens.push({ raw: p, kind: ELEVEN_V3_ALL_TAGS.has(p) ? 'eleven_v3_tag' : 'unknown' });
    }
  }
  return tokens;
}

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
 * `emotional_hold: true` exempts a beat from the dialogue-density floor
 * (avg words + bare-short tally), but only when the silence is EARNED —
 * the beat must carry substantive expression_notes OR subtext that justifies
 * what the held silence is doing. A naked `emotional_hold: true` flag with
 * no justification is gameable and is treated as ordinary sparse dialogue.
 */
function isEmotionalHoldEarned(beat) {
  if (!beat || beat.emotional_hold !== true) return false;
  const min = THRESHOLDS.emotionalHoldMinJustificationWords;
  return wordCount(beat.expression_notes) >= min
      || wordCount(beat.subtext) >= min;
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
      severity: 'critical',
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
        severity: 'critical',
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
          severity: 'critical',
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
            severity: 'critical',
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
      severity: 'critical',
      scope: 'episode',
      message: `Only ${dialogue}/${total} beats carry dialogue (${Math.round(ratio * 100)}% vs ${Math.round(THRESHOLDS.minDialogueBeatRatio * 100)}% minimum). Characters are being compressed into silence.`,
      hint: 'Convert some B_ROLL / REACTION beats into TALKING_HEAD_CLOSEUP or SHOT_REVERSE_SHOT beats — or merge two short dialogue beats into one denser 5-6s beat.'
    });
  }
}

/**
 * V4 Phase 5b — Fix 7. Catches the "all visual, no character voice" pattern
 * that produced the "amateur visuals" perception in story `77d6eaaf` (8 beats,
 * 1 principal, 2 dialogue = 25% — Director Agent's diagnosis: viewers read
 * thin-dialogue as repetition / monoculture).
 *
 * Fires when ratio < SCENE_DIALOGUE_THIN_THRESHOLD (default 0.25 — env-tunable
 * via BRAND_STORY_DIALOGUE_THIN_THRESHOLD) for stories with at least one
 * principal persona. Warning, not blocker — the Doctor patches by converting
 * a B_ROLL / REACTION into a TALKING_HEAD_CLOSEUP. Skipped for commercial
 * voiceover-heavy briefs (those are intentionally low-dialogue by design).
 */
function checkDialogueRatioForOnePrincipal(sceneGraph, personas, options, issues) {
  const hasAnyPersonas = Array.isArray(personas) && personas.length >= 1;
  if (!hasAnyPersonas) return;
  if (personas.length >= 2) return; // covered by checkDialogueBeatRatio (blocker)
  if (options?.storyFocus === 'landscape') return;

  // Exclude voiceover-heavy commercial briefs by design choice. The brief's
  // narrative_grammar.dialogue_density is the explicit signal; when it
  // declares 'low' or 'voiceover_only', the writer authored the spareness
  // intentionally and the warning would be noise.
  const dialogueDensity = String(options?.commercialBrief?.narrative_grammar?.dialogue_density || '').toLowerCase();
  if (dialogueDensity === 'low' || dialogueDensity === 'voiceover_only' || dialogueDensity === 'minimal') return;

  const { total, dialogue } = countAllDialogueBeats(sceneGraph);
  if (total === 0) return;

  const threshold = Number(process.env.BRAND_STORY_DIALOGUE_THIN_THRESHOLD || '0.25');
  const ratio = dialogue / total;
  if (ratio < threshold) {
    issues.push({
      id: 'dialogue_beats_too_thin',
      severity: 'warning',
      scope: 'episode',
      message: `Only ${dialogue}/${total} beats carry dialogue (${Math.round(ratio * 100)}% vs ${Math.round(threshold * 100)}% floor for one-principal stories). The cut will read 'all visual, no character voice'.`,
      hint: 'Convert one or two B_ROLL / REACTION / INSERT beats into TALKING_HEAD_CLOSEUP or SILENT_STARE-with-internal-line beats. The principal needs to be HEARD at least 25% of the runtime.'
    });
  }
}

/**
 * V4 Phase 5b — Fix 7. Detects scene_visual_anchor_prompt monoculture —
 * when every scene reuses the same lighting / mood vocabulary, the viewer
 * reads the assembled cut as one shot repeated. Director Agent's diagnosis
 * of the "amateur visuals" perception in story `77d6eaaf`.
 *
 * Pairwise token-overlap. If any two scenes have ≥ MONOCULTURE_THRESHOLD
 * (default 0.70 — env-tunable) overlap → warning. Doctor rewrites the
 * later scene's anchor with varied vocabulary that still honors the
 * brief's style_category (Fix 7's Doctor extension).
 */
function checkSceneVisualAnchorVariety(sceneGraph, issues) {
  const scenes = (sceneGraph?.scenes || []).filter(s => {
    const a = String(s?.scene_visual_anchor_prompt || '').trim();
    return a.length >= 20;
  });
  if (scenes.length < 2) return;

  const STOP_FOR_MONO = new Set([...STOPWORDS, 'the', 'and', 'with', 'a', 'an']);
  const anchorTokens = scenes.map(s => {
    const anchor = String(s.scene_visual_anchor_prompt).toLowerCase();
    const toks = anchor.match(/[a-z][a-z0-9'-]+/g) || [];
    return new Set(toks.filter(t => t.length >= 4 && !STOP_FOR_MONO.has(t)));
  });

  const threshold = Number(process.env.BRAND_STORY_SCENE_ANCHOR_VARIETY_THRESHOLD || '0.70');
  const offenders = [];
  for (let i = 0; i < anchorTokens.length; i++) {
    for (let j = i + 1; j < anchorTokens.length; j++) {
      const a = anchorTokens[i];
      const b = anchorTokens[j];
      if (a.size === 0 || b.size === 0) continue;
      let overlap = 0;
      for (const t of a) if (b.has(t)) overlap++;
      const ratio = overlap / Math.min(a.size, b.size);
      if (ratio >= threshold) {
        offenders.push({ i, j, ratio: Number(ratio.toFixed(2)) });
      }
    }
  }

  if (offenders.length > 0) {
    issues.push({
      id: 'scene_anchor_monoculture',
      severity: 'warning',
      scope: 'episode',
      message: `Scene visual anchors are tonally monocultural: ${offenders.length} scene-pair(s) share ≥${Math.round(threshold * 100)}% vocabulary (e.g. scenes ${offenders[0].i + 1} ↔ ${offenders[0].j + 1} at ${Math.round(offenders[0].ratio * 100)}%). The cut will read as one shot repeated.`,
      hint: 'Rewrite the later scene_visual_anchor_prompt with varied lighting / mood / color vocabulary while preserving genre register. Vary the lens, the time of day, the practical light source, the dominant color.',
      details: { offending_pairs: offenders }
    });
  }
}

/**
 * V4 Phase 5b — Fix 7. When commercial_brief.style_category is set, scan
 * scene_visual_anchor_prompts for vocabulary that VIOLATES that category.
 * Generic — uses the brief's own style_category + anti_brief signals as
 * the source of forbidden vocabulary, not a hardcoded mapping.
 *
 * Specific cross-checks (universal craft principles, not hardcoded brand
 * vocabulary):
 *   • hyperreal_premium briefs → anchors must NOT contain 'pitch black',
 *     'void', 'noir', 'crushed shadow', 'chiaroscuro' (those are the
 *     opposite craft register: high-key hero light vs deep underexposure).
 *   • gritty_real briefs → anchors must NOT contain 'glossy', 'polished',
 *     'pristine', 'flawless'.
 *
 * Tokens come from the brief's anti_brief field when present, plus the
 * style_category + craft-register universals above. NOT a wordlist; the
 * craft principles map across any future style_category. Warning, not
 * blocker — Doctor patches.
 */
function checkSceneAnchorBriefCoherence(sceneGraph, options, issues) {
  const brief = options?.commercialBrief;
  if (!brief || !brief.style_category) return;

  const styleCategory = String(brief.style_category).toLowerCase();
  // Universal craft-register conflicts. Each entry: when style_category
  // matches, these tokens (lowercase) in scene_visual_anchor_prompt fire
  // the warning. Adding a new style_category? Add the conflicting craft
  // vocabulary here. NOT a brand wordlist; this is craft register law.
  const STYLE_CATEGORY_CRAFT_CONFLICTS = {
    hyperreal_premium: ['pitch black', 'pure void', 'crushed shadow', 'chiaroscuro', 'noir lighting', 'deep underexposure'],
    gritty_real:       ['glossy', 'polished', 'pristine', 'flawless', 'mirror-finish'],
    vaporwave_nostalgic: ['stark', 'austere', 'documentary lens', 'naturalistic'],
    luxury_minimal:    ['gritty', 'handheld', 'documentary', 'rough', 'noisy grain']
  };

  const conflicts = STYLE_CATEGORY_CRAFT_CONFLICTS[styleCategory] || [];
  // Plus any anti_brief tokens authored by the brief writer for this story.
  const antiBriefTokens = Array.isArray(brief.anti_brief)
    ? brief.anti_brief.map(t => String(t).toLowerCase()).filter(t => t.length >= 3)
    : [];
  const allConflictTokens = [...conflicts, ...antiBriefTokens];
  if (allConflictTokens.length === 0) return;

  const offenders = [];
  for (const scene of sceneGraph?.scenes || []) {
    const anchor = String(scene?.scene_visual_anchor_prompt || '').toLowerCase();
    if (!anchor) continue;
    const hits = allConflictTokens.filter(t => anchor.includes(t));
    if (hits.length > 0) {
      offenders.push({ scene_id: scene.id || scene.label || 'unknown', hits });
    }
  }

  if (offenders.length > 0) {
    issues.push({
      id: 'scene_anchor_violates_style_category',
      severity: 'warning',
      scope: 'episode',
      message: `${offenders.length} scene anchor(s) contain vocabulary that violates the commercial brief's style_category="${styleCategory}". Example: scene "${offenders[0].scene_id}" uses [${offenders[0].hits.join(', ')}].`,
      hint: 'Rewrite anchor(s) to align with the brief\'s style_category. Honor the brief\'s craft register — light, gesture, composition — and let the brand subject carry the look without leaning on opposite-register vocabulary.',
      details: { offenders }
    });
  }
}

function checkAvgDialogueLength(sceneGraph, options, issues) {
  const allLines = countAllDialogueLines(sceneGraph);
  // Exempt only EARNED emotional_hold beats (flag + substantive justification).
  // An unearned hold is gameable — count it normally so dialogue_too_sparse
  // can still fire when Gemini sprays the flag to dodge the floor.
  const lines = allLines.filter(l => !isEmotionalHoldEarned(l.beat));
  if (lines.length === 0) return;
  const totalWords = lines.reduce((s, l) => s + wordCount(l.text), 0);
  const avg = totalWords / lines.length;

  // Phase 3.1 — genre-aware floor. When the validator-parameterized flag is
  // ON, the floor comes from assets/genre-registers/library.json per the
  // story's genre, optionally further relaxed/raised by the episode's
  // dialogue_density_intent. When OFF, the legacy uniform floor (6 words)
  // is the source — preserves pre-Phase-3 behavior for in-flight stories.
  let floor = THRESHOLDS.minDialogueWordsAvg;
  let floorSource = 'legacy';
  if (isValidatorParameterized() && isGenreRegisterLibraryEnabled()) {
    const resolved = resolveDialogueFloor(options?.genre, sceneGraph?.dialogue_density_intent);
    if (resolved && typeof resolved.min_dialogue_words_avg === 'number') {
      floor = resolved.min_dialogue_words_avg;
      floorSource = `genre:${options?.genre || 'default'}${sceneGraph?.dialogue_density_intent ? `+${sceneGraph.dialogue_density_intent}` : ''}`;
    }
  }

  if (avg < floor) {
    // Complementary density-pct check — when the genre register EXPLICITLY
    // authorises a clipped register (i.e. genre is known AND its declared
    // floor is < 6.0, the legacy default), dialogue_too_sparse blocks ONLY
    // when BOTH avg-words AND density-pct fall below the genre's floors.
    // This protects ACTION / HORROR / MYSTERY (clipped lines, but still 25%+
    // runtime) without weakening DRAMA, ROMANCE, or unknown-genre defaults.
    if (isValidatorParameterized() && isGenreRegisterLibraryEnabled()) {
      const resolved = resolveDialogueFloor(options?.genre, sceneGraph?.dialogue_density_intent);
      if (resolved?.density_check_skipped) return; // silent_register escape hatch
      // Only run the density-compensation carve-out when the resolved floor
      // is below the legacy uniform floor (6) — i.e. the genre is one that
      // CHOSE clipped dialogue. Genres with floor >= 6 (drama, romance,
      // documentary, period) get the strict "block on avg-words alone"
      // behavior so a clipped passage in a drama doesn't sneak through on
      // density math alone.
      const ALLOW_COMPENSATION = floor < 6;
      if (ALLOW_COMPENSATION) {
        const densityPctMin = (resolved?.target_dialogue_runtime_pct || [0.35])[0];
        const dialogueRuntimePct = computeDialogueRuntimePct(sceneGraph);
        if (dialogueRuntimePct >= densityPctMin) return;
      }
    }
    issues.push({
      id: 'dialogue_too_sparse',
      severity: 'critical',
      scope: 'episode',
      message: `Average dialogue length is ${avg.toFixed(1)} words per line — below the ${floor}-word ${floorSource} floor. Lines are too sparse to carry character or conflict.`,
      hint: 'Write FEWER but DENSER dialogue beats (5-8s each). Apply the "One Great Line" principle: one real line beats six fillers.'
    });
  }
}

/**
 * Sum of duration_seconds across all dialogue-bearing beats / total duration.
 * Used by the density-pct complementary check (Phase 3.1).
 */
function computeDialogueRuntimePct(sceneGraph) {
  let dialogueDur = 0;
  let totalDur = 0;
  for (const scene of sceneGraph.scenes || []) {
    for (const beat of scene.beats || []) {
      const dur = Number(beat.duration_seconds) || 0;
      totalDur += dur;
      if (DIALOGUE_BEARING_TYPES.has(beat.type)) dialogueDur += dur;
    }
  }
  return totalDur > 0 ? dialogueDur / totalDur : 0;
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

/**
 * Surface every `emotional_hold: true` beat that lacks substantive justification.
 * Warning-severity (advisory) — the dialogue-density blockers already account
 * for the unearned holds quantitatively; this check gives the user (and the
 * Director Agent) a per-beat paper trail so the looseness is visible.
 */
function checkEmotionalHoldEarned(sceneGraph, issues) {
  const min = THRESHOLDS.emotionalHoldMinJustificationWords;
  for (const scene of sceneGraph.scenes || []) {
    for (const beat of scene.beats || []) {
      if (beat.emotional_hold !== true) continue;
      if (isEmotionalHoldEarned(beat)) continue;
      issues.push({
        id: 'unearned_emotional_hold',
        severity: 'warning',
        scope: `beat:${beat.beat_id || '?'}`,
        message: `Beat marks emotional_hold: true but lacks ≥${min}-word expression_notes or subtext to justify the silence.`,
        hint: 'Either add expression_notes describing what the silent face/body shows, add subtext explaining what the silence carries, OR drop emotional_hold and write a full line.'
      });
    }
  }
}

function checkOneGreatLinePrinciple(sceneGraph, options, issues) {
  let bareShort = 0;
  const lines = countAllDialogueLines(sceneGraph);
  for (const l of lines) {
    if (wordCount(l.text) <= 3 && !isEmotionalHoldEarned(l.beat)) bareShort++;
  }

  // Phase 3.1 — genre-aware bare-short cap. action / horror / mystery
  // explicitly encourage clipped lines; the legacy uniform cap of 2 was
  // silently penalising them. -1 means no cap.
  let cap = THRESHOLDS.maxBareShortLines;
  if (isValidatorParameterized() && isGenreRegisterLibraryEnabled()) {
    const resolved = resolveDialogueFloor(options?.genre, sceneGraph?.dialogue_density_intent);
    if (resolved && typeof resolved.max_bare_short_lines === 'number') {
      cap = resolved.max_bare_short_lines;
    }
  }
  if (cap === -1) return; // genre disables this check entirely

  if (bareShort > cap) {
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
// Persona-index coverage — ensures every dialogue line declares its speaker
// ──────────────────────────────────────────────────────────────
//
// Caught 2026-04-25 (logs.txt): a SHOT_REVERSE_SHOT child beat (s2b2_b)
// failed CinematicDialogueGenerator with "no persona resolved" — the
// exchange in Gemini's screenplay omitted persona_index, so the compiler
// produced a child TALKING_HEAD_CLOSEUP without a valid speaker. By that
// point the Scene Master + earlier beats had already been rendered.
//
// This check is a blocker: every dialogue-bearing line must declare its
// speaker via persona_index (single), persona_indexes[] (group), or
// exchanges[].persona_index (SRS). If absent, fail at L1 so the user
// either retakes the screenplay or fixes the field manually in the
// Director Panel — never fail mid-generation.
function checkPersonaIndexCoverage(sceneGraph, personas, issues) {
  const personaCount = Array.isArray(personas) ? personas.length : 0;
  const isValidIdx = (i) => Number.isInteger(i) && i >= 0 && i < personaCount;
  let missing = 0;
  for (const scene of sceneGraph.scenes || []) {
    for (const beat of scene.beats || []) {
      // Single-persona dialogue (DIALOGUE_IN_SCENE / TALKING_HEAD_CLOSEUP)
      if (beat.dialogue && typeof beat.dialogue === 'string' && beat.dialogue.length > 0) {
        if (!isValidIdx(beat.persona_index)) {
          missing++;
          issues.push({
            id: 'persona_index_missing',
            severity: 'critical',
            scope: `beat:${beat.beat_id}`,
            message: `Beat ${beat.beat_id} [${beat.type}] has dialogue but no valid persona_index (got ${JSON.stringify(beat.persona_index)}). The beat generator will fail with "no persona resolved" mid-pipeline.`,
            hint: `Set persona_index to an integer 0..${personaCount - 1} on the beat, or fix it in the Director Panel before regenerating.`
          });
        }
      }
      // Group dialogue (GROUP_DIALOGUE_TWOSHOT) — every dialogue entry needs a matching persona_indexes[i]
      if (Array.isArray(beat.dialogues) && beat.dialogues.length > 0) {
        const indexes = Array.isArray(beat.persona_indexes) ? beat.persona_indexes : [];
        for (let i = 0; i < beat.dialogues.length; i++) {
          if (!isValidIdx(indexes[i])) {
            missing++;
            issues.push({
              id: 'persona_index_missing',
              severity: 'critical',
              scope: `beat:${beat.beat_id}`,
              message: `Beat ${beat.beat_id} [${beat.type}] dialogues[${i}] has no valid persona_indexes[${i}] (got ${JSON.stringify(indexes[i])}).`,
              hint: `Provide persona_indexes[] with one integer 0..${personaCount - 1} per dialogue line.`
            });
          }
        }
      }
      // SHOT_REVERSE_SHOT exchanges — every exchange needs persona_index
      if (Array.isArray(beat.exchanges)) {
        for (let i = 0; i < beat.exchanges.length; i++) {
          const ex = beat.exchanges[i] || {};
          if (ex.dialogue && !isValidIdx(ex.persona_index)) {
            missing++;
            issues.push({
              id: 'persona_index_missing',
              severity: 'critical',
              scope: `beat:${beat.beat_id}`,
              message: `Beat ${beat.beat_id} [SHOT_REVERSE_SHOT] exchange[${i}] has dialogue but no valid persona_index (got ${JSON.stringify(ex.persona_index)}). The compiler will produce an unrenderable closeup child.`,
              hint: `Set exchanges[${i}].persona_index to an integer 0..${personaCount - 1}.`
            });
          }
        }
      }
    }
  }
  if (missing > 0) {
    logger.info(`persona-index coverage flagged ${missing} dialogue line(s) with missing speakers`);
  }
}

// ──────────────────────────────────────────────────────────────
// Cast Bible Phase 5a — Kling element-budget check (lossless-split contract)
// ──────────────────────────────────────────────────────────────
//
// When a beat references more distinct persona elements than Kling's @Element
// API accepts (KLING_MAX_ELEMENTS = 3), the renderer today silently truncates
// via slice(0, KLING_MAX_ELEMENTS) — the 4th persona's visual element is
// dropped, although their dialogue still plays. With MAX_PERSONAS bumped to 4
// (Phase 5a), this can now happen on any beat that puts all four cast members
// in one shot.
//
// Phase 5a contract: surface the overflow as a WARNING (not blocker) so the
// user sees it in Script QA. The Doctor's lossless-split remedy is deferred
// to a follow-up; today the truncation continues as the safety net but is
// logged with structured context at the renderer (services/KlingFalService.js).
const KLING_ELEMENT_BUDGET = 3;
function checkKlingElementBudget(sceneGraph, personas, issues) {
  const personaCount = Array.isArray(personas) ? personas.length : 0;
  if (personaCount <= KLING_ELEMENT_BUDGET) return; // common case — no possible overflow

  for (const scene of sceneGraph.scenes || []) {
    for (const beat of scene.beats || []) {
      const elementIndexes = new Set();
      if (Number.isInteger(beat.persona_index)) elementIndexes.add(beat.persona_index);
      if (Array.isArray(beat.persona_indexes)) {
        beat.persona_indexes.forEach(i => Number.isInteger(i) && elementIndexes.add(i));
      }
      if (Array.isArray(beat.personas_present)) {
        beat.personas_present.forEach(i => Number.isInteger(i) && elementIndexes.add(i));
      }
      if (Array.isArray(beat.exchanges)) {
        beat.exchanges.forEach(ex => Number.isInteger(ex?.persona_index) && elementIndexes.add(ex.persona_index));
      }

      if (elementIndexes.size > KLING_ELEMENT_BUDGET) {
        issues.push({
          id: 'kling_element_overflow',
          severity: 'warning',
          scope: `beat:${beat.beat_id}`,
          message: `Beat ${beat.beat_id} [${beat.type}] references ${elementIndexes.size} distinct persona elements (${[...elementIndexes].join(', ')}). Kling's @Element API caps at ${KLING_ELEMENT_BUDGET}; the renderer will truncate the visual element pack to the first ${KLING_ELEMENT_BUDGET} (dialogue track is unaffected — every persona's voice still plays).`,
          hint: `Split this beat into two consecutive beats with persona elements partitioned across them, or remove a persona reference if their visual presence is incidental.`
        });
      }
    }
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
      severity: 'critical',
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

// ──────────────────────────────────────────────────────────────
// Phase 4 — Anti-ad-copy + brand-name dialogue bans
// ──────────────────────────────────────────────────────────────
//
// These bans only fire when product_integration_style is in the "naturalistic"
// family (naturalistic_placement | incidental_prop | genre_invisible). In
// hero_showcase and commercial modes, ad-copy register is permitted because
// the user has explicitly opted in to a commercial format.

const AD_COPY_BAN_PATTERNS = [
  { pattern: /\bwith (the new |our )/i,                         id: 'ad_copy_with_new' },
  { pattern: /\bintroducing\b/i,                                id: 'ad_copy_introducing' },
  { pattern: /\bproudly powered by\b/i,                         id: 'ad_copy_proudly_powered' },
  { pattern: /\bnow available\b/i,                              id: 'ad_copy_now_available' },
  { pattern: /\b(get|grab|try|buy) yours? today\b/i,            id: 'ad_copy_buy_today' },
  { pattern: /\blimited time\b/i,                               id: 'ad_copy_limited_time' },
  { pattern: /\bfree shipping\b/i,                              id: 'ad_copy_free_shipping' },
  { pattern: /\bclick the link\b/i,                             id: 'ad_copy_click_link' },
  { pattern: /\bvisit (us|our)\b/i,                             id: 'ad_copy_visit_us' },
  { pattern: /\bthe only \w+ that\b/i,                          id: 'ad_copy_only_x_that' },
  { pattern: /\b(thanks to|because of) (our|the)\b/i,           id: 'ad_copy_thanks_to' },
  { pattern: /\bchanged (my|our) li(fe|ves)\b/i,                id: 'ad_copy_changed_life' },
  { pattern: /\bour patented\b/i,                               id: 'ad_copy_patented' },
  { pattern: /\bnever been easier\b/i,                          id: 'ad_copy_never_easier' },
  { pattern: /\bgame[- ]?chang(er|ing)\b/i,                     id: 'ad_copy_gamechanger' }
];

// Phase 3.2 — externalised forbidden-register library. Loaded lazily so that
// when the validator-parameterized flag is OFF the file isn't even read
// (preserves zero-touch behavior for pre-Phase-3 deployments).
let _forbiddenRegistersCache = null;
function loadForbiddenRegisters() {
  if (_forbiddenRegistersCache) return _forbiddenRegistersCache;
  const filepath = path.resolve(__dirname, '..', '..', 'assets', 'screenplay', 'forbidden-registers.json');
  const raw = fs.readFileSync(filepath, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.ad_copy)) {
    throw new Error('forbidden-registers.json must export ad_copy[]');
  }
  // Compile regexes once — pattern is a regex source string + flags.
  const compiled = parsed.ad_copy.map((entry) => ({
    id: entry.id,
    pattern: new RegExp(entry.pattern, entry.flags || ''),
    applies_to_styles: Array.isArray(entry.applies_to_styles) ? entry.applies_to_styles : []
  }));
  _forbiddenRegistersCache = { ad_copy: compiled };
  return _forbiddenRegistersCache;
}

// Escape a string for inclusion as a literal in a RegExp source.
function escapeRegExp(str) {
  return str.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function checkAntiAdCopyBans(sceneGraph, options, issues) {
  const style = String(options?.productIntegrationStyle || 'naturalistic_placement').toLowerCase();

  // Phase 3.2 — pattern source is data-driven when the validator-parameterized
  // flag is on, hardcoded array otherwise. Mode-gating moves from a hardcoded
  // if/return into per-pattern applies_to_styles[] in the data file.
  const useLibrary = isValidatorParameterized();
  let patterns;
  if (useLibrary) {
    const lib = loadForbiddenRegisters();
    patterns = lib.ad_copy.filter(p => p.applies_to_styles.includes(style));
    if (patterns.length === 0) return;
  } else {
    if (style === 'hero_showcase' || style === 'commercial') return;
    patterns = AD_COPY_BAN_PATTERNS;
  }

  // Phase 3.3 — diegetic_label_reading per-beat exemption. Allows ONE beat per
  // episode (max) where a character authentically reads a label / billboard /
  // TV ad in-world — exempt from the regex. Mad Men prop grammar.
  let diegeticUsed = false;

  const lines = countAllDialogueLines(sceneGraph);
  for (const line of lines) {
    if (!line.text) continue;
    for (const ban of patterns) {
      const matchResult = ban.pattern.exec(line.text);
      if (matchResult) {
        if (line.beat?.diegetic_label_reading === true && !diegeticUsed) {
          diegeticUsed = true;
          break;
        }
        const beatId = line.beat?.beat_id || 'unknown';
        issues.push({
          id: ban.id,
          severity: 'critical',
          scope: `beat:${beatId}`,
          message: `Ad-copy banned phrase "${matchResult[0]}" detected in dialogue (integration style: ${style}). Hollywood naturalistic placement forbids commercial register in dialogue.`,
          hint: 'Rewrite this line so the character expresses something diegetic (a feeling, a fact, a request) rather than a product claim. The product must be a noun (touched / used) — never an adjective described in speech. If the line is authentic in-world copy-reading (a billboard, a TV ad, a label), set beat.diegetic_label_reading: true to exempt ONE such beat per episode.'
        });
        break;
      }
    }
  }
}

function checkBrandNameInDialogue(sceneGraph, storyline, options, issues) {
  const style = String(options?.productIntegrationStyle || 'naturalistic_placement').toLowerCase();

  // Phase 3.4 — parameterised max-mentions ceiling.
  //   Lookup precedence: subject.integration_mandate.max_brand_name_mentions
  //   -> styleDefaults[style] -> legacy (1 for any non-commercial style).
  // When the validator-parameterized flag is OFF, fall through to the legacy
  // semantics: hero_showcase / commercial bypass; everything else permits 1.
  const STYLE_DEFAULTS = {
    naturalistic_placement: 1,
    incidental_prop: 1,
    genre_invisible: 0,
    hero_showcase: Infinity,
    commercial: Infinity
  };

  let maxMentions;
  if (isValidatorParameterized()) {
    const mandate = options?.subject?.integration_mandate || storyline?.subject_bible?.integration_mandate;
    if (mandate && Number.isFinite(mandate.max_brand_name_mentions)) {
      maxMentions = mandate.max_brand_name_mentions;
    } else if (Object.prototype.hasOwnProperty.call(STYLE_DEFAULTS, style)) {
      maxMentions = STYLE_DEFAULTS[style];
    } else {
      maxMentions = 1;
    }
  } else {
    if (style === 'hero_showcase' || style === 'commercial') return;
    maxMentions = 1;
  }

  if (!Number.isFinite(maxMentions)) return; // Infinity: no cap

  const candidates = new Set();
  const add = (s) => {
    if (!s) return;
    const word = String(s).trim();
    if (word.length >= 3 && /^[A-Z]/.test(word)) candidates.add(word);
  };
  add(storyline?.brand_name);
  add(options?.subject?.name);
  if (options?.brandKit?.brand_summary) {
    const firstCap = String(options.brandKit.brand_summary).match(/\b[A-Z][A-Za-z0-9]{2,}\b/);
    if (firstCap) add(firstCap[0]);
  }
  if (candidates.size === 0) return;

  const reList = Array.from(candidates).map(c => new RegExp(`\\b${escapeRegExp(c)}\\b`, 'i'));

  let mentionsSoFar = 0;
  const lines = countAllDialogueLines(sceneGraph);
  for (const line of lines) {
    if (!line.text) continue;
    for (const re of reList) {
      if (re.test(line.text)) {
        mentionsSoFar++;
        if (mentionsSoFar > maxMentions) {
          const beatId = line.beat?.beat_id || 'unknown';
          issues.push({
            id: 'brand_name_in_dialogue',
            severity: 'warning',
            scope: `beat:${beatId}`,
            message: `Brand name appears ${mentionsSoFar} time(s) in dialogue (integration style: ${style}, cap: ${maxMentions}). Hollywood naturalistic placement permits a finite ceiling per episode.`,
            hint: 'Replace the brand name with a generic descriptor or rewrite around it. Multiple brand-name references in dialogue is the cardinal infomercial sin. Override via subject.integration_mandate.max_brand_name_mentions if a higher count is intentional.'
          });
        }
        break;
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────
// Phase 6 — V4 Audio Coherence Overhaul checks
// ──────────────────────────────────────────────────────────────

/**
 * Check that sonic_world is structurally well-formed at the EPISODE level.
 * The Phase 3 schema replaces per-scene ambient_bed_prompt with this block.
 *
 * Warnings (legacy episodes / Doctor patches):
 *   - sonic_world missing entirely (becomes blocker when bible is present)
 *
 * Blockers:
 *   - base_palette missing or empty
 *   - spectral_anchor missing or empty
 *
 * Warnings:
 *   - scene_variations[] entries reference unknown scene_ids
 *   - scene_variations[] entries have empty overlay text
 */
function checkSonicWorldStructure(sceneGraph, issues) {
  const sw = sceneGraph.sonic_world;
  if (!sw || typeof sw !== 'object') {
    issues.push({
      id: 'sonic_world_missing',
      severity: 'warning',
      scope: 'episode',
      message: 'episode is missing sonic_world block (Phase 3 schema)',
      hint: 'Add an episode-level "sonic_world" with base_palette, spectral_anchor, and scene_variations[]. Per-scene ambient_bed_prompt is deprecated.'
    });
    return;
  }

  if (!sw.base_palette || typeof sw.base_palette !== 'string' || sw.base_palette.trim().length === 0) {
    issues.push({
      id: 'sonic_world_no_base_palette',
      severity: 'critical',
      scope: 'episode.sonic_world',
      message: 'sonic_world.base_palette is required (the continuous bed for the whole episode)',
      hint: 'Author a 1-sentence ambient bed description that plays under every beat.'
    });
  }

  if (!sw.spectral_anchor || (typeof sw.spectral_anchor !== 'string' && typeof sw.spectral_anchor !== 'object')) {
    issues.push({
      id: 'sonic_world_no_spectral_anchor',
      severity: 'critical',
      scope: 'episode.sonic_world',
      message: 'sonic_world.spectral_anchor is required (the seam-hider that always plays)',
      hint: 'Author the sub-200Hz + faint air content that anchors continuity across cuts.'
    });
  }

  if (Array.isArray(sw.scene_variations)) {
    const validSceneIds = new Set((sceneGraph.scenes || []).map(s => s?.scene_id).filter(Boolean));
    for (const v of sw.scene_variations) {
      if (!v || !v.scene_id) {
        issues.push({
          id: 'sonic_world_overlay_no_scene_id',
          severity: 'warning',
          scope: 'episode.sonic_world.scene_variations',
          message: 'scene_variations entry missing scene_id',
          hint: 'Each overlay must reference a scene by scene_id'
        });
        continue;
      }
      if (!validSceneIds.has(v.scene_id)) {
        issues.push({
          id: 'sonic_world_overlay_unknown_scene',
          severity: 'warning',
          scope: `episode.sonic_world.scene_variations[${v.scene_id}]`,
          message: `scene_variations references unknown scene_id "${v.scene_id}"`,
          hint: `Known scene_ids: ${[...validSceneIds].join(', ') || '(none)'}`
        });
      }
      if (!v.overlay || typeof v.overlay !== 'string' || v.overlay.trim().length === 0) {
        issues.push({
          id: 'sonic_world_overlay_empty',
          severity: 'warning',
          scope: `episode.sonic_world.scene_variations[${v.scene_id}]`,
          message: 'overlay text is empty',
          hint: 'Either remove this entry or author the additive scene-specific layer'
        });
      }
    }
  }
}

/**
 * Bible-binding clauses. Only fires when a sonic_series_bible is provided.
 * Most violations are warnings (Doctor will patch); the only blocker is
 * "bible exists but episode has no sonic_world at all" — that's negligence.
 */
function checkSonicWorldBibleInheritance(sceneGraph, bible, issues) {
  if (!bible || typeof bible !== 'object') return;

  const sw = sceneGraph.sonic_world;
  if (!sw || typeof sw !== 'object') {
    issues.push({
      id: 'sonic_world_missing_with_bible',
      severity: 'critical',
      scope: 'episode',
      message: 'story has a Sonic Series Bible — episode MUST emit a sonic_world block that inherits from it',
      hint: 'Author sonic_world with base_palette + spectral_anchor + scene_variations[].'
    });
    return;
  }

  // Binding clause: signature_drone must appear in spectral_anchor
  const policy = bible.inheritance_policy?.signature_drone || 'must_appear_at_least_once_per_episode';
  const droneBand = bible.signature_drone?.frequency_band_hz;
  if (
    policy === 'must_appear_at_least_once_per_episode' &&
    Array.isArray(droneBand) &&
    droneBand.length === 2
  ) {
    const [low, high] = droneBand;
    const anchorText = typeof sw.spectral_anchor === 'string'
      ? sw.spectral_anchor
      : (sw.spectral_anchor?.description || '');
    const hzMatches = (anchorText.match(/\d+\s*[-–]?\s*\d*\s*hz/ig) || []);
    const evidenceTerms = /\b(sub[- ]?bass|low[- ]?frequency|low[- ]?end|hum|drone)\b/i;
    if (hzMatches.length === 0 && !evidenceTerms.test(anchorText)) {
      issues.push({
        id: 'sonic_world_drone_not_in_anchor',
        severity: 'warning',
        scope: 'episode.sonic_world.spectral_anchor',
        message: `bible signature_drone (${low}-${high}Hz) is not represented in spectral_anchor — violates inheritance_policy.signature_drone="must_appear_at_least_once_per_episode"`,
        hint: `Add the drone's low-frequency band to spectral_anchor (e.g. "sustained ${low}-${high}Hz drone + faint air movement").`
      });
    }
  }

  // Additive-overlay invariant
  if (Array.isArray(sw.scene_variations)) {
    for (const v of sw.scene_variations) {
      if (!v?.overlay) continue;
      const baseTokens = new Set(
        (sw.base_palette || '').toLowerCase().match(/\b[a-z]{4,}\b/g) || []
      );
      const overlayTokens = (v.overlay || '').toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
      const noiseWords = new Set(['with','from','through','under','over','against','that','this','sound','audio','layer','tones','tone']);
      const sharedTokens = overlayTokens.filter(t => baseTokens.has(t) && !noiseWords.has(t));
      if (baseTokens.size > 0 && overlayTokens.length >= 4 && sharedTokens.length === 0) {
        issues.push({
          id: 'sonic_world_overlay_replaces_base',
          severity: 'warning',
          scope: `episode.sonic_world.scene_variations[${v.scene_id || '?'}]`,
          message: 'overlay shares no vocabulary with base_palette — likely a REPLACEMENT not an additive layer (timbre cliff risk)',
          hint: 'Re-author overlay so it ADDS to base_palette (e.g. base="industrial drone, distant traffic" + overlay="wind through gaps" — wind ADDS to traffic). Avoid wholesale swaps.'
        });
      }
    }
  }
}

/**
 * Per-beat ambient_sound must be FOLEY (1-3s percussive diegetic) — not bed
 * material. Phase 5 enforces this at the SFX-call site too; the validator
 * catches it at write time so the Doctor can patch before generation.
 */
function checkPerBeatAmbientSoundIsFoley(sceneGraph, issues) {
  for (const scene of sceneGraph.scenes || []) {
    for (const beat of scene.beats || []) {
      const prompt = beat?.ambient_sound;
      if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) continue;
      const offending = detectAmbientBedPhrasing(prompt);
      if (offending) {
        issues.push({
          id: 'beat_ambient_sound_is_bed_material',
          severity: 'warning',
          scope: `beat ${beat.beat_id || '?'}`,
          message: `ambient_sound contains bed-phrase "${offending}" — belongs in sonic_world, not per-beat`,
          hint: 'Per-beat ambient_sound is for FOLEY EVENTS only (1-3s percussive: door click, glass clink, fabric rustle). Move bed material to sonic_world.'
        });
      }
    }
  }
}

/**
 * music_bed_intent must respect the bible's no-fly list of prohibited instruments.
 * Blocker — the bible explicitly forbids these and the music will be regenerated.
 */
function checkMusicBedRespectsNoFlyList(sceneGraph, bible, issues) {
  if (!bible || typeof bible !== 'object') return;
  const music = sceneGraph.music_bed_intent;
  if (!music || typeof music !== 'string') return;
  const prohibited = Array.isArray(bible.prohibited_instruments) ? bible.prohibited_instruments : [];
  if (prohibited.length === 0) return;
  const lowered = music.toLowerCase();
  for (const prohibitedInst of prohibited) {
    if (!prohibitedInst || typeof prohibitedInst !== 'string') continue;
    const variants = [
      prohibitedInst.toLowerCase(),
      prohibitedInst.toLowerCase().replace(/_/g, ' ')
    ];
    if (variants.some(v => lowered.includes(v))) {
      issues.push({
        id: 'music_violates_no_fly_list',
        severity: 'critical',
        scope: 'episode.music_bed_intent',
        message: `music_bed_intent uses prohibited instrument "${prohibitedInst}" from the Sonic Series Bible`,
        hint: `Re-author music_bed_intent without "${prohibitedInst.replace(/_/g, ' ')}". Bible no-fly list: ${prohibited.join(', ')}.`
      });
    }
  }
}

// ──────────────────────────────────────────────────────────────
// V4 Audio Layer — dialogue audio-tag presence + coherence checks
// ──────────────────────────────────────────────────────────────
//
// Pipeline contract (Day 1 of audio-layer overhaul):
//   1. checkDialogueTagPresence walks every dialogue line and confirms
//      either an eleven-v3 tag or a [no_tag_intentional: ...] baseline
//      annotation is present. Severity = warning by default. When
//      BRAND_STORY_AUDIO_TAGS_REQUIRED=true the warning is escalated to
//      blocker so the Doctor (or a manual edit) is forced to author tags.
//   2. checkTagEmotionCoherence catches the four obvious contradictions
//      ([laughing] on a "broken" emotion, [firmly] on "indecisive", etc.).
//      Always warning — coherence is craft, not safety.
//   3. checkTagStackDepth catches >2 comma-stacked tags AND duplicate tags
//      (`[whispering] [whispering]`) — eleven-v3 either ignores or distorts.
//   4. checkAudioEventOveruse caps audio events ([applause], [leaves
//      rustling], [gentle footsteps]) at one occurrence per beat.
//
// All checks read the helper-extracted tokens from extractBracketTokens()
// so the dialogue string is parsed exactly once per line. The Doctor's
// EDITABLE_FIELDS already includes 'dialogue' — no Doctor schema change.
function isAudioTagsRequired() {
  return String(process.env.BRAND_STORY_AUDIO_TAGS_REQUIRED || 'false').toLowerCase() === 'true';
}

function checkDialogueTagPresence(sceneGraph, issues) {
  const required = isAudioTagsRequired();
  const lines = countAllDialogueLines(sceneGraph);
  let untagged = 0;
  for (const line of lines) {
    if (!line.text) continue;
    // Earned emotional_hold beats are exempt — the silence IS the read,
    // and the closing breath is captured by tag-presence on the line itself
    // (separate check at checkEmotionalHoldClosingBreath if desired). We
    // treat the hold beat as opting out of mandatory tagging.
    if (isEmotionalHoldEarned(line.beat)) continue;
    const tokens = extractBracketTokens(line.text);
    const hasV3Tag = tokens.some(t => t.kind === 'eleven_v3_tag');
    const hasBaselineAnnotation = tokens.some(t => t.kind === 'baseline_annotation');
    if (!hasV3Tag && !hasBaselineAnnotation) {
      untagged++;
      const beatId = line.beat?.beat_id || 'unknown';
      issues.push({
        id: 'dialogue_missing_audio_tag',
        severity: required ? 'critical' : 'warning',
        scope: `beat:${beatId}`,
        message: `Beat ${beatId} dialogue carries no eleven-v3 performance tag and no [no_tag_intentional:...] baseline annotation — the audio layer will inherit the model's default contour instead of an authored read.`,
        hint: 'Add an inline tag derived from beat.emotion + subtext + opposing_intents + archetype (see DIALOGUE PERFORMANCE TAGS masterclass), e.g. "[barely whispering] I had no choice.", "[firmly] We need to leave. Now.", or "I\'m fine. [exhaling]". For Stoic / under-tagged baseline reads, use "[no_tag_intentional: stoic_baseline] ..." to signal intent.'
      });
    }
  }
  if (untagged > 0) {
    logger.info(`audio-tag presence: ${untagged}/${lines.length} dialogue line(s) untagged${required ? ' (BLOCKING)' : ''}`);
  }
}

function checkTagEmotionCoherence(sceneGraph, issues) {
  const lines = countAllDialogueLines(sceneGraph);
  for (const line of lines) {
    if (!line.text) continue;
    const tokens = extractBracketTokens(line.text);
    const tagsOnLine = tokens.filter(t => t.kind === 'eleven_v3_tag').map(t => t.raw);
    if (tagsOnLine.length === 0) continue;
    const emotionStr = String(line.beat?.emotion || line.exchange?.emotion || '').toLowerCase();
    if (!emotionStr) continue;
    for (const conflict of TAG_EMOTION_CONFLICTS) {
      const emotionMatches = conflict.emotion_keywords.some(k => emotionStr.includes(k));
      if (!emotionMatches) continue;
      const offenders = tagsOnLine.filter(t => conflict.conflicting_tags.has(t));
      if (offenders.length === 0) continue;
      const beatId = line.beat?.beat_id || 'unknown';
      issues.push({
        id: 'tag_emotion_contradiction',
        severity: 'warning',
        scope: `beat:${beatId}`,
        message: `Beat ${beatId} dialogue carries audio tag(s) [${offenders.join(', ')}] that contradict the beat's declared emotion "${emotionStr}". The audio layer will fight the screenplay's emotional intent.`,
        hint: `Either (a) re-pick the tag — for emotion "${emotionStr}", consider tags that LEAN INTO the read instead of fighting it (see DIALOGUE PERFORMANCE TAGS → derivation rules), or (b) update beat.emotion if the original emotion field was the wrong adjective.`
      });
    }
  }
}

function checkTagStackDepth(sceneGraph, issues) {
  const lines = countAllDialogueLines(sceneGraph);
  for (const line of lines) {
    if (!line.text) continue;
    const tokens = extractBracketTokens(line.text);
    const v3Tags = tokens.filter(t => t.kind === 'eleven_v3_tag');
    const beatId = line.beat?.beat_id || 'unknown';

    // >2 tags total → eleven-v3 mushes them. Threshold from the masterclass
    // BAD example #2 ("[whispering, sad, slowly, defeated]" stacked four-deep).
    if (v3Tags.length > 2) {
      issues.push({
        id: 'tag_stack_too_deep',
        severity: 'warning',
        scope: `beat:${beatId}`,
        message: `Beat ${beatId} dialogue carries ${v3Tags.length} eleven-v3 tags (limit: 2). eleven-v3 mushes ≥3 tags into a generic "soft sad" timbre — pick the one that matters most.`,
        hint: 'Reduce to AT MOST 2 tags per line — typically a prefix tag (entry register) plus one mid-line shift if the line truly turns. Drop the rest.'
      });
    }

    // Duplicate tag — `[whispering] ... [whispering]` — eleven-v3 ignores or distorts.
    const seen = new Set();
    for (const t of v3Tags) {
      if (seen.has(t.raw)) {
        issues.push({
          id: 'tag_duplicated',
          severity: 'warning',
          scope: `beat:${beatId}`,
          message: `Beat ${beatId} dialogue uses tag "[${t.raw}]" more than once on the same line — eleven-v3 ignores or distorts duplicates.`,
          hint: 'Author the tag once at the entry of the line. If the line truly turns mid-way, use a DIFFERENT tag for the shift (e.g. "[firmly] entry, [exhaling] before the final clause").'
        });
        break; // one report per line
      }
      seen.add(t.raw);
    }
  }
}

// V4 Audio Layer Overhaul Day 2 — eleven-v3 dialogue endpoint pre-flight.
//
// GROUP_DIALOGUE_TWOSHOT routes through `fal-ai/elevenlabs/text-to-dialogue/
// eleven-v3` which has hard limits enforced server-side:
//   - 2,000 chars total across all inputs[].text
//   - 10 unique voices per request
//   - single language_code per request (mixed languages → 422)
//
// We catch overflow at the screenplay layer (warning severity) so the Doctor
// can split the offending beat into two consecutive beats BEFORE generation.
// The DialogueTTSService also enforces the same checks at submission time as
// defense-in-depth. Mixed-language is escalated to blocker — there is no
// graceful auto-split for it; the user must re-cast the scene with a single
// language or accept fallback to per-beat TTS.
const DIALOGUE_ENDPOINT_MAX_CHARS = 2000;
const DIALOGUE_ENDPOINT_MAX_VOICES = 10;

function _personaLanguagesForBeat(beat, personas) {
  const seen = new Set();
  const indexes = new Set();
  if (Number.isInteger(beat.persona_index)) indexes.add(beat.persona_index);
  if (Array.isArray(beat.persona_indexes)) {
    beat.persona_indexes.forEach(i => Number.isInteger(i) && indexes.add(i));
  }
  if (Array.isArray(beat.exchanges)) {
    beat.exchanges.forEach(ex => Number.isInteger(ex?.persona_index) && indexes.add(ex.persona_index));
  }
  for (const i of indexes) {
    const lang = personas?.[i]?.language || 'en';
    seen.add(String(lang).toLowerCase());
  }
  return [...seen];
}

function _stripBracketTokensForCharCount(text) {
  if (!text || typeof text !== 'string') return '';
  return text.replace(/\[[^\]]+\]/g, '').replace(/\s{2,}/g, ' ').trim();
}

function checkDialogueEndpointBudget(sceneGraph, personas, issues) {
  for (const scene of sceneGraph.scenes || []) {
    for (const beat of scene.beats || []) {
      if (beat.type !== 'GROUP_DIALOGUE_TWOSHOT') continue;
      // Collect every dialogue line that will be packed into one dialogue
      // endpoint call. Char budget is measured AFTER bracket-token strip
      // (eleven-v3 doesn't bill for tag instructions in the rendered audio).
      const lines = [];
      if (Array.isArray(beat.dialogues)) lines.push(...beat.dialogues);
      else if (beat.dialogue) lines.push(beat.dialogue);
      if (lines.length === 0) continue;

      const totalChars = lines.reduce((s, l) => s + _stripBracketTokensForCharCount(l).length, 0);
      const beatId = beat.beat_id || '?';

      if (totalChars > DIALOGUE_ENDPOINT_MAX_CHARS) {
        issues.push({
          id: 'dialogue_endpoint_char_overflow',
          severity: 'warning',
          scope: `beat:${beatId}`,
          message: `Beat ${beatId} GROUP_DIALOGUE_TWOSHOT total dialogue is ${totalChars} chars — exceeds eleven-v3 dialogue endpoint's ${DIALOGUE_ENDPOINT_MAX_CHARS}-char hard limit.`,
          hint: 'Split this beat into two consecutive GROUP_DIALOGUE_TWOSHOT beats with the dialogue partitioned across them, OR shorten one of the lines. The DialogueTTSService will fall back to per-beat single-speaker TTS if you do not split.'
        });
      }

      // Voice-count check — count unique persona_indexes resolved to voice ids
      // via personas[]. Defensive — V4's MAX_PERSONAS=4 means this should
      // never trip in practice, but it would trip on a contrived hand-edit.
      const voiceIds = new Set();
      for (const i of (beat.persona_indexes || [beat.persona_index]).filter(x => Number.isInteger(x))) {
        const vid = personas?.[i]?.elevenlabs_voice_id;
        if (vid) voiceIds.add(vid);
      }
      if (voiceIds.size > DIALOGUE_ENDPOINT_MAX_VOICES) {
        issues.push({
          id: 'dialogue_endpoint_voice_overflow',
          severity: 'critical',
          scope: `beat:${beatId}`,
          message: `Beat ${beatId} references ${voiceIds.size} unique voices — exceeds eleven-v3 dialogue endpoint's ${DIALOGUE_ENDPOINT_MAX_VOICES}-voice limit.`,
          hint: `Reduce the speaking cast in this beat, or split into multiple beats with ≤ ${DIALOGUE_ENDPOINT_MAX_VOICES} voices each.`
        });
      }

      // Mixed-language check — the dialogue endpoint accepts a single
      // language_code per request. A scene mixing English + Hebrew personas
      // in one beat must fall back to per-beat TTS.
      const langs = _personaLanguagesForBeat(beat, personas);
      if (langs.length > 1) {
        issues.push({
          id: 'dialogue_endpoint_mixed_language',
          severity: 'critical',
          scope: `beat:${beatId}`,
          message: `Beat ${beatId} GROUP_DIALOGUE_TWOSHOT mixes languages [${langs.join(', ')}] across speakers. The eleven-v3 dialogue endpoint accepts only one language_code per request.`,
          hint: 'Either re-cast the scene so both speakers share a language, OR change the beat type so each speaker gets their own per-beat TTS call (TALKING_HEAD_CLOSEUP × 2 with a SHOT_REVERSE_SHOT compiler step).'
        });
      }
    }
  }
}

function checkAudioEventOveruse(sceneGraph, issues) {
  for (const scene of sceneGraph.scenes || []) {
    for (const beat of scene.beats || []) {
      if (!DIALOGUE_BEARING_TYPES.has(beat.type)) continue;
      // Aggregate every audio-event tag across the beat (single dialogue,
      // dialogues[], exchanges[]) — the cap is per-beat, not per-line.
      let eventCount = 0;
      const collected = [];
      const collect = (text) => {
        if (!text) return;
        for (const t of extractBracketTokens(text)) {
          if (t.kind === 'eleven_v3_tag' && ELEVEN_V3_AUDIO_EVENT_TAGS.has(t.raw)) {
            eventCount++;
            collected.push(t.raw);
          }
        }
      };
      collect(beat.dialogue);
      if (Array.isArray(beat.dialogues)) for (const d of beat.dialogues) collect(d);
      if (Array.isArray(beat.exchanges)) for (const ex of beat.exchanges) collect(ex.dialogue);
      if (eventCount > 1) {
        issues.push({
          id: 'audio_event_overused',
          severity: 'warning',
          scope: `beat:${beat.beat_id || '?'}`,
          message: `Beat ${beat.beat_id || '?'} stacks ${eventCount} audio-event tags (${[...new Set(collected)].join(', ')}). eleven-v3 fails or produces noise when audio events stack.`,
          hint: 'Use AT MOST ONE audio-event tag per beat (e.g. [gentle footsteps]). If you need multiple ambient cues, author them in beat.ambient_sound instead — that goes through the SoundEffectsService SFX overlay path.'
        });
      }
    }
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
 * @param {Object} [options.sonicSeriesBible] - locked story-level bible (Phase 6)
 * @returns {{ issues, repaired, stats, needsPunchUp }}
 */
export function validateScreenplay(sceneGraph, storyline = {}, personas = [], options = {}) {
  const {
    storyFocus = 'product',
    // Phase 6 — when provided, validates sonic_world inheritance from the
    // Sonic Series Bible per its inheritance_policy. When absent, sonic_world
    // is still validated structurally (base_palette + spectral_anchor must
    // exist) but the bible-binding rules (signature_drone presence,
    // prohibited_instruments, additive overlay invariant) don't fire.
    sonicSeriesBible = null
  } = options;
  if (!sceneGraph || typeof sceneGraph !== 'object') {
    return {
      issues: [{ id: 'no_scene_graph', severity: 'critical', scope: 'episode', message: 'No scene graph to validate.', hint: '' }],
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
  // V4 Phase 5b — Fix 7. The blocker above only fires for ≥2 personas. The
  // one-principal warning catches the "all visual, no character voice"
  // pattern that hit story `77d6eaaf` (1 principal × 8 beats × 2 dialogue).
  checkDialogueRatioForOnePrincipal(repaired, personas, options, issues);
  // V4 Phase 5b — Fix 7. Tonal-monoculture detector + brief-coherence check.
  // Both are warnings (Doctor patches). Brief-coherence only fires when a
  // commercial_brief is present.
  checkSceneVisualAnchorVariety(repaired, issues);
  checkSceneAnchorBriefCoherence(repaired, options, issues);
  checkAvgDialogueLength(repaired, options, issues);
  checkSubtextCoverage(repaired, issues);
  checkOneGreatLinePrinciple(repaired, options, issues);
  checkEmotionalHoldEarned(repaired, issues);
  checkIntensityRamp(repaired, storyline, issues);
  checkMouthOcclusion(repaired, issues);
  checkPersonaIndexCoverage(repaired, personas, issues);
  checkKlingElementBudget(repaired, personas, issues);
  checkSubjectMandate(repaired, storyline, options, issues);
  // Phase 4 — Hollywood naturalistic placement guardrails. Reject ad-copy
  // phrases in dialogue unless the integration style allows commercial
  // register (hero_showcase / commercial). Brand name in dialogue is
  // forbidden in naturalistic / incidental / genre_invisible modes.
  checkAntiAdCopyBans(repaired, options, issues);
  checkBrandNameInDialogue(repaired, storyline, options, issues);
  // Phase 6 — V4 audio coherence overhaul rules
  checkSonicWorldStructure(repaired, issues);
  checkSonicWorldBibleInheritance(repaired, sonicSeriesBible, issues);
  checkPerBeatAmbientSoundIsFoley(repaired, issues);
  checkMusicBedRespectsNoFlyList(repaired, sonicSeriesBible, issues);
  // V4 Audio Layer Overhaul Day 1 — eleven-v3 inline performance tag checks.
  // Tag-presence is warning by default; escalates to blocker when
  // BRAND_STORY_AUDIO_TAGS_REQUIRED=true. Coherence + stack-depth + audio-event
  // overuse are always warnings — they catch craft failures the Doctor can fix.
  checkDialogueTagPresence(repaired, issues);
  checkTagEmotionCoherence(repaired, issues);
  checkTagStackDepth(repaired, issues);
  checkAudioEventOveruse(repaired, issues);
  // Day 2 — eleven-v3 dialogue endpoint pre-flight checks (GROUP_DIALOGUE_TWOSHOT)
  checkDialogueEndpointBudget(repaired, personas, issues);
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

  const needsPunchUp = issues.some(i => isBlockerOrCritical(i.severity));

  logger.info(`${issues.length} issues (${issues.filter(i => isBlockerOrCritical(i.severity)).length} critical, ${issues.filter(i => i.severity === 'warning').length} warning). Stats: beats=${stats.total_beats} dialogue_beats=${stats.dialogue_beats} avg_words=${stats.avg_dialogue_words} subtext=${Math.round(stats.subtext_coverage * 100)}%`);

  return { issues, repaired, stats, needsPunchUp };
}

export default { validateScreenplay, THRESHOLDS };
