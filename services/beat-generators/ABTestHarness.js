// services/beat-generators/ABTestHarness.js
// V4 A/B Test Harness — compares Mode A vs Mode B dialogue generation
// on identical inputs so the user can eyeball quality side-by-side.
//
// Decision 1 from the plan committed to "building an A/B comparison harness
// early" so we could validate the Mode B hybrid (Kling O3 Omni → Sync Lipsync
// v3) against the Mode A fallback (OmniHuman 1.5 alone) on real brand stories.
//
// Usage from a script or unit test:
//   import ABTestHarness from './services/beat-generators/ABTestHarness.js';
//   const harness = new ABTestHarness({ falServices, tts, ffmpeg });
//   const results = await harness.compare({ beat, scene, refStack, personas, episodeContext });
//   // results.modeA = { videoBuffer, durationSec, modelUsed, costUsd, metadata }
//   // results.modeB = { videoBuffer, durationSec, modelUsed, costUsd, metadata }
//   // Save both to disk and eyeball.
//
// This is a testing tool, not part of the normal pipeline. The orchestrator
// never calls it during an episode generation — it's only invoked by the
// smoke test script or the Director's Panel "A/B Compare" button (Phase 1b).

import CinematicDialogueGenerator from './CinematicDialogueGenerator.js';
import TalkingHeadCloseupGenerator from './TalkingHeadCloseupGenerator.js';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `[ABTestHarness] ${timestamp} [${level}]: ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

class ABTestHarness {
  /**
   * @param {Object} deps - { falServices, tts, ffmpeg } — same as beat generators
   */
  constructor(deps = {}) {
    this.deps = deps;
    this.modeBGenerator = new CinematicDialogueGenerator(deps);
    this.modeAGenerator = new TalkingHeadCloseupGenerator(deps);
  }

  /**
   * Run both Mode A and Mode B on the same beat and return side-by-side results.
   *
   * @param {Object} args - same shape as BaseBeatGenerator.generate(args)
   * @param {Object} args.beat
   * @param {Object} args.scene
   * @param {Object[]} args.refStack
   * @param {Object[]} args.personas
   * @param {Object} args.episodeContext
   * @returns {Promise<{modeA: Object, modeB: Object, summary: string}>}
   */
  async compare(args) {
    const beatType = args.beat?.type;
    if (beatType !== 'TALKING_HEAD_CLOSEUP' && beatType !== 'DIALOGUE_IN_SCENE') {
      throw new Error(`ABTestHarness: only applicable to TALKING_HEAD_CLOSEUP and DIALOGUE_IN_SCENE beats (got ${beatType})`);
    }

    logger.info(`starting A/B compare on beat ${args.beat.beat_id} (${beatType})`);

    // Deep-clone beat for each mode so status mutations don't leak.
    const beatForModeA = { ...args.beat, beat_id: `${args.beat.beat_id}_modeA` };
    const beatForModeB = { ...args.beat, beat_id: `${args.beat.beat_id}_modeB` };

    // Run both in parallel to save wall-clock time
    const [modeAResult, modeBResult] = await Promise.allSettled([
      this.modeAGenerator.generate({ ...args, beat: beatForModeA }),
      this.modeBGenerator.generate({ ...args, beat: beatForModeB })
    ]);

    const modeA = modeAResult.status === 'fulfilled'
      ? modeAResult.value
      : { error: modeAResult.reason?.message || String(modeAResult.reason) };
    const modeB = modeBResult.status === 'fulfilled'
      ? modeBResult.value
      : { error: modeBResult.reason?.message || String(modeBResult.reason) };

    const summary = this._buildSummary(modeA, modeB);
    logger.info(`A/B compare complete:\n${summary}`);

    return { modeA, modeB, summary };
  }

  _buildSummary(modeA, modeB) {
    const lines = ['Mode A (OmniHuman only)  |  Mode B (Kling O3 + Sync Lipsync v3)'];
    lines.push('─'.repeat(70));

    if (modeA.error) {
      lines.push(`  A: ✗ ${modeA.error}`);
    } else {
      lines.push(`  A: ✓ ${modeA.durationSec.toFixed(1)}s, $${(modeA.costUsd || 0).toFixed(3)}, ${modeA.modelUsed}`);
    }

    if (modeB.error) {
      lines.push(`  B: ✗ ${modeB.error}`);
    } else {
      lines.push(`  B: ✓ ${modeB.durationSec.toFixed(1)}s, $${(modeB.costUsd || 0).toFixed(3)}, ${modeB.modelUsed}`);
    }

    if (!modeA.error && !modeB.error) {
      const costDelta = ((modeB.costUsd || 0) - (modeA.costUsd || 0)).toFixed(3);
      lines.push(`  Δcost (B - A): $${costDelta}`);
    }

    lines.push('─'.repeat(70));
    lines.push('  Next step: eyeball both videos for lip-sync accuracy, identity preservation,');
    lines.push('  background quality, and emotional believability. Save the winner as primary.');

    return lines.join('\n');
  }
}

export default ABTestHarness;
export { ABTestHarness };
