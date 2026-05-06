// services/v4/EditDecisionList.js
//
// V4 Tier 3.5 — Apply Lens F's Edit Decision List to a scene-graph.
//
// Lens F (Editor Agent) emits a structured EDL on the rough cut. When
// V4_LENS_F_EDITOR_AGENT=blocking, the EDL must actually shape the cut.
// This helper is the translation layer between the EDL JSON and the
// scene-graph mutations the reassembly path consumes.
//
// Operations supported:
//   • drop_beat:  remove beats from the live cut (mark status='superseded'
//                 with EDL audit trail, leaving canonical row in place but
//                 invisible to selectLiveBeats — same contract as Tier 1's
//                 supersede flow)
//   • swap_beats: reorder pairs of beats in their parent scene's beats[]
//                 array (in-memory only; persisted via the standard
//                 scene_description JSONB write)
//   • retime_beat: nudge beat.duration_seconds ±0.5s; the next reassemble
//                 honors the new duration in subtitle/SFX windows
//   • j_cut_audio: NOT YET IMPLEMENTED — requires audio splicing surgery
//                 in PostProduction stage 4 (music ducking) which is its
//                 own architectural change. EDL parses this field and the
//                 helper records intent on a beat field for a future
//                 PostProduction stage to consume.
//
// All EDL operations are LIVE-AUDITED — every drop / swap / retime /
// j-cut intent is recorded on the scene-graph's `lens_f_edl_history`
// array for the Director Panel to surface and the user to roll back.

import { supersedeBeat } from './BeatLifecycle.js';

/**
 * Apply an EDL emitted by Lens F to a scene-graph in-place.
 *
 * @param {Object} sceneGraph
 * @param {Object} edl - {drop_beat: [], swap_beats: [], retime_beat: [], j_cut_audio: []}
 * @param {Object} [opts]
 * @param {string} [opts.reason='lens_f_blocking_apply'] - audit reason
 * @returns {{
 *   applied: { dropped: number, swapped: number, retimed: number, j_cut_planned: number },
 *   skipped: Array<{op: string, reason: string, target: any}>
 * }}
 */
export function applyEdl(sceneGraph, edl, opts = {}) {
  const reason = opts.reason || 'lens_f_blocking_apply';
  const result = {
    applied: { dropped: 0, swapped: 0, retimed: 0, j_cut_planned: 0 },
    skipped: []
  };
  if (!sceneGraph || typeof sceneGraph !== 'object') return result;
  if (!edl || typeof edl !== 'object') return result;

  // Locate every beat by id once for O(1) operations.
  const beatById = new Map(); // beat_id → { scene, beat, sceneIdx, beatIdx }
  for (let s = 0; s < (sceneGraph.scenes || []).length; s++) {
    const scene = sceneGraph.scenes[s];
    for (let b = 0; b < (scene?.beats || []).length; b++) {
      const beat = scene.beats[b];
      if (beat?.beat_id) {
        beatById.set(beat.beat_id, { scene, beat, sceneIdx: s, beatIdx: b });
      }
    }
  }

  // ─── 1. drop_beat ───
  for (const beatId of (edl.drop_beat || [])) {
    const ref = beatById.get(beatId);
    if (!ref) {
      result.skipped.push({ op: 'drop_beat', reason: 'beat_id_not_found', target: beatId });
      continue;
    }
    try {
      // Use Tier 1's supersede path so the beat moves out of the live cut
      // via the same contract that user-regenerate uses. selectLiveBeats()
      // skips superseded beats; reassembly produces a shorter cut.
      supersedeBeat(ref.beat, { reason: `${reason}:drop_beat` });
      result.applied.dropped++;
    } catch (err) {
      result.skipped.push({ op: 'drop_beat', reason: err.message || 'supersede_failed', target: beatId });
    }
  }

  // ─── 2. swap_beats ───
  // Only swap pairs WITHIN the same scene (cross-scene swaps would break
  // scene grammar; Lens F is supposed to only emit within-scene swaps but
  // we defend in depth).
  for (const pair of (edl.swap_beats || [])) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      result.skipped.push({ op: 'swap_beats', reason: 'invalid_pair_shape', target: pair });
      continue;
    }
    const [a, b] = pair;
    const refA = beatById.get(a);
    const refB = beatById.get(b);
    if (!refA || !refB) {
      result.skipped.push({ op: 'swap_beats', reason: 'beat_id_not_found', target: pair });
      continue;
    }
    if (refA.sceneIdx !== refB.sceneIdx) {
      result.skipped.push({ op: 'swap_beats', reason: 'cross_scene_swap_rejected', target: pair });
      continue;
    }
    const beats = refA.scene.beats;
    const tmp = beats[refA.beatIdx];
    beats[refA.beatIdx] = beats[refB.beatIdx];
    beats[refB.beatIdx] = tmp;
    // Update the index map after the swap so subsequent ops find them.
    beatById.set(a, { ...refA, beatIdx: refB.beatIdx });
    beatById.set(b, { ...refB, beatIdx: refA.beatIdx });
    result.applied.swapped++;
  }

  // ─── 3. retime_beat ───
  for (const entry of (edl.retime_beat || [])) {
    if (!entry || typeof entry !== 'object') continue;
    const ref = beatById.get(entry.beat_id);
    if (!ref) {
      result.skipped.push({ op: 'retime_beat', reason: 'beat_id_not_found', target: entry });
      continue;
    }
    const delta = Number(entry.delta_seconds);
    if (!Number.isFinite(delta) || delta === 0) {
      result.skipped.push({ op: 'retime_beat', reason: 'invalid_delta', target: entry });
      continue;
    }
    // Clamp to ±0.5s per the schema and floor at 1s minimum duration so we
    // don't produce 0-length beats that confuse PostProduction.
    const clamped = Math.max(-0.5, Math.min(0.5, delta));
    const original = Number(ref.beat.duration_seconds) || 4;
    const next = Math.max(1, original + clamped);
    ref.beat._lens_f_retimed_from = original;
    ref.beat.duration_seconds = next;
    result.applied.retimed++;
  }

  // ─── 4. j_cut_audio ───
  // Implementation note: actually splicing audio across the cut requires
  // PostProduction stage 4 (music + ambient mix) to read a per-beat
  // `audio_lead_in_seconds` field and shift the audio start back by that
  // amount. The PostProduction surgery to do that is non-trivial. For
  // now we RECORD the intent on the beat so a future PostProduction
  // change can consume it without changing the EDL contract.
  for (const cut of (edl.j_cut_audio || [])) {
    if (!cut || typeof cut !== 'object') continue;
    const ref = beatById.get(cut.into_beat);
    if (!ref) {
      result.skipped.push({ op: 'j_cut_audio', reason: 'into_beat_id_not_found', target: cut });
      continue;
    }
    const lead = Math.max(0.1, Math.min(1.5, Number(cut.lead_seconds) || 0.5));
    ref.beat.j_cut_audio_lead_seconds = lead;
    ref.beat.j_cut_audio_from_beat = cut.from_beat || null;
    result.applied.j_cut_planned++;
  }

  // ─── Audit trail ───
  if (!Array.isArray(sceneGraph.lens_f_edl_history)) {
    sceneGraph.lens_f_edl_history = [];
  }
  sceneGraph.lens_f_edl_history.push({
    applied_at: new Date().toISOString(),
    reason,
    applied: result.applied,
    skipped: result.skipped,
    edl
  });

  return result;
}

export default { applyEdl };
