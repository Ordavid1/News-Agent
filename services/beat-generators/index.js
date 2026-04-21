// services/beat-generators/index.js
// V4 beat generators — centralized exports + factory.
//
// This file is the single import point for every beat generator, the
// ShotReverseShotCompiler transform, and the beat-type → generator mapping.
// BeatRouter.js imports from here.
//
// Phase 1a generators shipped:
//   - BaseBeatGenerator            (abstract)
//   - ShotReverseShotCompiler      (transformer, not a generator)
//   - CinematicDialogueGenerator   (Mode B primary)
//   - TalkingHeadCloseupGenerator  (Mode A fallback)
//   - SilentStareGenerator
//   - GroupTwoShotGenerator
//   - ReactionGenerator
//   - InsertShotGenerator
//   - BRollGenerator
//   - ActionGenerator
//   - MontageSequenceGenerator     (scene-level, not beat-level)
//   - VoiceoverBRollGenerator
//   - TextOverlayCardGenerator     (ffmpeg-only)

export { default as BaseBeatGenerator } from './BaseBeatGenerator.js';
export { default as ShotReverseShotCompiler } from './ShotReverseShotCompiler.js';

// Dialogue generators
export { default as CinematicDialogueGenerator } from './CinematicDialogueGenerator.js';
export { default as TalkingHeadCloseupGenerator } from './TalkingHeadCloseupGenerator.js';
export { default as GroupTwoShotGenerator } from './GroupTwoShotGenerator.js';
export { default as SilentStareGenerator } from './SilentStareGenerator.js';

// Non-dialogue beats
export { default as ReactionGenerator } from './ReactionGenerator.js';
export { default as InsertShotGenerator } from './InsertShotGenerator.js';
export { default as ActionGenerator } from './ActionGenerator.js';
export { default as MontageSequenceGenerator } from './MontageSequenceGenerator.js';
export { default as BRollGenerator } from './BRollGenerator.js';
export { default as VoiceoverBRollGenerator } from './VoiceoverBRollGenerator.js';

// Post-production beat
export { default as TextOverlayCardGenerator } from './TextOverlayCardGenerator.js';

// ─────────────────────────────────────────────────────────────────────
// Factory: given a beat type, return the generator class.
// Used by unit tests and optional direct lookups — the BeatRouter uses
// its own hardcoded table for routing-time decisions.
// ─────────────────────────────────────────────────────────────────────
import CinematicDialogueGeneratorDefault from './CinematicDialogueGenerator.js';
import TalkingHeadCloseupGeneratorDefault from './TalkingHeadCloseupGenerator.js';
import GroupTwoShotGeneratorDefault from './GroupTwoShotGenerator.js';
import SilentStareGeneratorDefault from './SilentStareGenerator.js';
import ReactionGeneratorDefault from './ReactionGenerator.js';
import InsertShotGeneratorDefault from './InsertShotGenerator.js';
import ActionGeneratorDefault from './ActionGenerator.js';
import MontageSequenceGeneratorDefault from './MontageSequenceGenerator.js';
import BRollGeneratorDefault from './BRollGenerator.js';
import VoiceoverBRollGeneratorDefault from './VoiceoverBRollGenerator.js';
import TextOverlayCardGeneratorDefault from './TextOverlayCardGenerator.js';

const BEAT_TYPE_TO_GENERATOR = {
  TALKING_HEAD_CLOSEUP: CinematicDialogueGeneratorDefault,  // Mode B primary
  DIALOGUE_IN_SCENE: CinematicDialogueGeneratorDefault,     // Mode B primary
  GROUP_DIALOGUE_TWOSHOT: GroupTwoShotGeneratorDefault,
  SILENT_STARE: SilentStareGeneratorDefault,
  REACTION: ReactionGeneratorDefault,
  INSERT_SHOT: InsertShotGeneratorDefault,
  ACTION_NO_DIALOGUE: ActionGeneratorDefault,
  MONTAGE_SEQUENCE: MontageSequenceGeneratorDefault,
  B_ROLL_ESTABLISHING: BRollGeneratorDefault,
  VOICEOVER_OVER_BROLL: VoiceoverBRollGeneratorDefault,
  TEXT_OVERLAY_CARD: TextOverlayCardGeneratorDefault
  // SHOT_REVERSE_SHOT is handled by ShotReverseShotCompiler expansion, NOT routed.
  // SPEED_RAMP_TRANSITION is assembler-only (post-production), NOT routed.
};

// Mode A override map — for when a beat has `model_override: 'mode_a'`
// set by the user in the Director's Panel, or when a story is flagged as
// budget-tier in the BeatRouter.
const BEAT_TYPE_MODE_A_OVERRIDE = {
  TALKING_HEAD_CLOSEUP: TalkingHeadCloseupGeneratorDefault,
  DIALOGUE_IN_SCENE: TalkingHeadCloseupGeneratorDefault
};

/**
 * Resolve a beat type to its generator class.
 *
 * @param {string} beatType
 * @param {Object} [options]
 * @param {boolean} [options.modeA] - use Mode A fallback when available
 * @returns {Function|null} the generator class (not an instance)
 */
export function getGeneratorForBeatType(beatType, options = {}) {
  if (options.modeA && BEAT_TYPE_MODE_A_OVERRIDE[beatType]) {
    return BEAT_TYPE_MODE_A_OVERRIDE[beatType];
  }
  return BEAT_TYPE_TO_GENERATOR[beatType] || null;
}

/**
 * @returns {string[]} all beat types the router can route
 */
export function getSupportedBeatTypes() {
  return [
    ...Object.keys(BEAT_TYPE_TO_GENERATOR),
    'SHOT_REVERSE_SHOT',      // compiles into TALKING_HEAD_CLOSEUP×N
    'SPEED_RAMP_TRANSITION'   // assembler-only
  ];
}
