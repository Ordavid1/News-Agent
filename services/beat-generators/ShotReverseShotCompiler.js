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

    // V4 Audio Layer Overhaul Day 2 — preserve EXCHANGE CONTEXT.
    //
    // Pre-Day-2: each child closeup was synthesized in ignorance of the
    // prior speaker. Even though `subtext` and `emotion` flowed through to
    // Kling, the TTS call had no awareness of "you're responding to the
    // line that just landed". Result: SHOT_REVERSE_SHOT exchanges sounded
    // like alternating monologues, not a conversation.
    //
    // The fix: each child carries an `exchange_context` block snapshotting
    // the prior turn's emotion + subtext + dialogue tail + position-in-
    // exchange. CinematicDialogueGenerator reads it to bias the Kling
    // micro-expression prompt and (when applicable) inform tag selection
    // for the response line. The parent beat's audio still synthesizes
    // line-by-line — director cut rhythm is preserved — but the per-beat
    // TTS prompt now knows what it's responding to.
    return exchanges.map((exchange, i) => {
      const prior = i > 0 ? exchanges[i - 1] : null;
      const exchangeContext = {
        position_in_exchange: i,                         // 0-indexed; 0 = scene-opener
        total_exchanges: exchanges.length,               // sized by Gemini
        prior_speaker_persona_index: prior?.persona_index ?? null,
        prior_speaker_emotion: prior?.emotion || prior?.mood || null,
        prior_speaker_subtext: prior?.subtext || null,
        // Dialogue tail — the last 12 words of the prior speaker's line.
        // Bounded so the downstream prompt budget isn't blown by a long
        // monologue spilling into the closeup's Kling prompt.
        prior_speaker_dialogue_tail: prior?.dialogue
          ? String(prior.dialogue).trim().split(/\s+/).slice(-12).join(' ')
          : null,
        // The full sequence of speakers across the exchange — useful for
        // detecting overlap patterns ("A interrupts B") and for the
        // director-panel exchange-flow visualization.
        speaker_sequence: exchanges.map(ex => ex?.persona_index ?? null)
      };

      return {
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
        // Day 2 — exchange-aware context (read by CinematicDialogueGenerator).
        exchange_context: exchangeContext,
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
      };
    });
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
