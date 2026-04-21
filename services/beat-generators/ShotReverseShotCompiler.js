// services/beat-generators/ShotReverseShotCompiler.js
// V4 beat transformer — expands SHOT_REVERSE_SHOT parent beats into
// alternating TALKING_HEAD_CLOSEUP child beats.
//
// This is NOT a generator (it produces no media). It's a pre-processing step
// that the BeatRouter runs in its preflight() pass, before any routing or
// cost estimation happens.
//
// Why: SHOT_REVERSE_SHOT is V4's default for multi-character dialogue. The
// compiler expands it into N TALKING_HEAD_CLOSEUP beats so the standard
// CinematicDialogueGenerator handles each line independently. Every Hollywood
// dialogue scene since 1930 is shot this way — alternating closeups with
// perfect lip-sync on one face at a time.
//
// Input  (one beat):
//   {
//     beat_id: "s1b3",
//     type: "SHOT_REVERSE_SHOT",
//     exchanges: [
//       { persona_index: 0, dialogue: "You knew this would happen.", emotion: "resigned", duration_seconds: 4, expression_notes: "..." },
//       { persona_index: 1, dialogue: "I never wanted any of this.", emotion: "broken", duration_seconds: 5, expression_notes: "..." },
//       { persona_index: 0, dialogue: "Then why are you here?", emotion: "cutting", duration_seconds: 3, expression_notes: "..." }
//     ]
//   }
//
// Output (three beats):
//   [
//     { beat_id: "s1b3_a", type: "TALKING_HEAD_CLOSEUP", persona_index: 0, dialogue: "...", emotion: "resigned", duration_seconds: 4, ... },
//     { beat_id: "s1b3_b", type: "TALKING_HEAD_CLOSEUP", persona_index: 1, dialogue: "...", emotion: "broken", duration_seconds: 5, ... },
//     { beat_id: "s1b3_c", type: "TALKING_HEAD_CLOSEUP", persona_index: 0, dialogue: "...", emotion: "cutting", duration_seconds: 3, ... }
//   ]

class ShotReverseShotCompiler {
  /**
   * Expand a single SHOT_REVERSE_SHOT beat into N TALKING_HEAD_CLOSEUP beats.
   * Returns the input unchanged if the beat is not a SHOT_REVERSE_SHOT.
   *
   * @param {Object} parentBeat
   * @returns {Object[]} array of beats (1 or more)
   */
  static expandBeat(parentBeat) {
    if (!parentBeat || parentBeat.type !== 'SHOT_REVERSE_SHOT') return [parentBeat];

    const exchanges = Array.isArray(parentBeat.exchanges) ? parentBeat.exchanges : [];
    if (exchanges.length === 0) {
      // Malformed SHOT_REVERSE_SHOT — warn and pass through as empty array.
      return [];
    }

    const parentId = parentBeat.beat_id || 'srs';
    const suffixes = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];

    return exchanges.map((exchange, i) => ({
      // Generate unique child beat IDs that preserve the parent for traceability
      beat_id: `${parentId}_${suffixes[i] || i}`,
      type: 'TALKING_HEAD_CLOSEUP',
      persona_index: exchange.persona_index,
      dialogue: exchange.dialogue,
      emotion: exchange.emotion || exchange.mood || 'neutral',
      duration_seconds: exchange.duration_seconds || 4,
      lens: exchange.lens || '85mm',
      expression_notes: exchange.expression_notes || '',
      // V4 director metadata — propagated from exchange (preferred) or parent
      // so downstream generators / post-production / director panel see the
      // same intent on each child closeup as on the parent SHOT_REVERSE_SHOT.
      subtext: exchange.subtext || parentBeat.subtext || null,
      narrative_purpose: exchange.narrative_purpose || parentBeat.narrative_purpose || null,
      beat_intent: exchange.beat_intent || parentBeat.beat_intent || null,
      emotional_hold: exchange.emotional_hold ?? parentBeat.emotional_hold ?? null,
      pace_hint: exchange.pace_hint || parentBeat.pace_hint || null,
      // Preserve parent context so the generator can still see it if needed.
      _parent_beat_id: parentId,
      _compiled_from: 'SHOT_REVERSE_SHOT',
      // Beat-pipeline state fields default to pending
      status: 'pending',
      generated_video_url: null,
      endframe_url: null,
      model_used: null,
      cost_usd: null,
      error_message: null
    }));
  }

  /**
   * Expand every SHOT_REVERSE_SHOT in a scene's beats array.
   * Returns a new array (does not mutate the input).
   *
   * @param {Object[]} beats
   * @returns {Object[]}
   */
  static expandScene(beats) {
    if (!Array.isArray(beats)) return beats;
    const expanded = [];
    for (const beat of beats) {
      const childBeats = ShotReverseShotCompiler.expandBeat(beat);
      expanded.push(...childBeats);
    }
    return expanded;
  }
}

export default ShotReverseShotCompiler;
export { ShotReverseShotCompiler };
