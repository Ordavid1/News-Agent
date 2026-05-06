// services/v4/ContinuitySheet.js
//
// V4 Tier 2.5 — Per-scene structured continuity state.
//
// The Director's Tier 2.5 note required this BEFORE Tier 3.2's Lens E
// (continuity supervisor) could land. Without a structured per-scene state
// of {props, wardrobe, lighting key direction, time of day}, a multimodal
// Lens E call comparing two endframes will hallucinate prop continuity
// from pixel comparisons under motion blur and partial occlusion. The
// ContinuitySheet gives Lens E ground truth to check pixels AGAINST.
//
// Lifecycle:
//   1. Gemini emits `continuity_sheet` per scene in the screenplay scene-graph
//      (schema lives in brandStoryPromptsV4.mjs — see Tier 2.5 schema additions).
//   2. Per-beat generators read the sheet via _buildContinuityDirective() and
//      splice "actor_idx 0 holds {item} in {hand}; lighting key from {direction}"
//      into prompts so generation stays consistent with the scene's state.
//   3. Lens E (Tier 3.2) reads the sheet to compare prev_endframe vs
//      current_endframe with structured ground truth — a coffee cup that
//      vanishes between beats produces a high-confidence prop_drift verdict.
//   4. The sheet is mutated as the scene progresses: prop pickups become
//      props_in_hand entries; props that get set down are removed; wardrobe
//      adjustments (jacket on/off) update wardrobe_state.
//
// Sheet shape (persisted as scene.continuity_sheet JSONB inside scene_description):
//
//   {
//     props_in_hand: [
//       { actor_idx: number, item: string, hand: 'left' | 'right' | 'both' }
//     ],
//     hair_state: { actor_idx → string },         // per-actor hair description
//     wardrobe_state: {
//       actor_idx → {
//         top: string, bottom: string, accessories: string[]
//       }
//     },
//     time_of_day: 'dawn' | 'morning' | 'noon' | 'afternoon' | 'golden_hour' | 'dusk' | 'night',
//     weather: string | null,
//     lighting_key_direction:
//       'window_left' | 'window_right' | 'overhead' | 'practical_lamp' |
//       'ambient' | 'rim_back' | 'firelight' | string,
//     prop_registry: [
//       { item: string, introduced_in_beat: string, current_state: string }
//     ]
//   }
//
// All fields are OPTIONAL and the helpers handle missing/partial data
// gracefully — legacy episodes without continuity_sheet on their scenes
// continue to work (the directive returns ''; Lens E falls back to pixel-
// comparison only).

/**
 * Default empty sheet shape — used when a scene has no continuity_sheet
 * and a generator wants a stable read target.
 */
export const EMPTY_CONTINUITY_SHEET = Object.freeze({
  props_in_hand: [],
  hair_state: {},
  wardrobe_state: {},
  time_of_day: null,
  weather: null,
  lighting_key_direction: null,
  prop_registry: []
});

/**
 * Backfill missing fields on a scene's continuity_sheet so callers can read
 * without nullish-checks. Idempotent; preserves existing values.
 *
 * @param {Object} scene - the scene object from scene_description
 * @returns {Object} the scene's continuity_sheet (mutated to ensure shape)
 */
export function ensureContinuitySheet(scene) {
  if (!scene) return null;
  if (!scene.continuity_sheet) {
    scene.continuity_sheet = { ...EMPTY_CONTINUITY_SHEET, props_in_hand: [], prop_registry: [] };
  }
  const sheet = scene.continuity_sheet;
  if (!Array.isArray(sheet.props_in_hand)) sheet.props_in_hand = [];
  if (!Array.isArray(sheet.prop_registry)) sheet.prop_registry = [];
  if (!sheet.hair_state || typeof sheet.hair_state !== 'object') sheet.hair_state = {};
  if (!sheet.wardrobe_state || typeof sheet.wardrobe_state !== 'object') sheet.wardrobe_state = {};
  return sheet;
}

/**
 * Get the actors that should appear in this beat (from beat.persona_index /
 * persona_indexes / personas_present). Returns indices, not persona objects
 * — the sheet is keyed by actor_idx.
 *
 * @param {Object} beat
 * @returns {number[]}
 */
function _resolveActorIndexes(beat) {
  const out = new Set();
  if (typeof beat?.persona_index === 'number') out.add(beat.persona_index);
  if (Array.isArray(beat?.persona_indexes)) {
    for (const i of beat.persona_indexes) if (typeof i === 'number') out.add(i);
  }
  if (Array.isArray(beat?.personas_present)) {
    for (const i of beat.personas_present) if (typeof i === 'number') out.add(i);
  }
  return Array.from(out).sort((a, b) => a - b);
}

/**
 * Build the per-beat continuity directive for splicing into the model
 * prompt. Reads the scene's continuity_sheet and returns a short string of
 * the form:
 *
 *   "actor 0 holds laptop in left hand; lighting key from window_left;
 *    time of day: golden_hour."
 *
 * Returns '' when the sheet is empty / missing — callers can append
 * unconditionally with no concern about adding noise.
 *
 * @param {Object} scene
 * @param {Object} beat
 * @returns {string}
 */
export function buildContinuityDirective(scene, beat) {
  if (!scene?.continuity_sheet) return '';
  const sheet = scene.continuity_sheet;
  const parts = [];

  // Props in hand — only mention the actors actually present in this beat.
  const actorIndexes = _resolveActorIndexes(beat);
  if (Array.isArray(sheet.props_in_hand)) {
    for (const entry of sheet.props_in_hand) {
      if (typeof entry?.actor_idx !== 'number') continue;
      if (actorIndexes.length > 0 && !actorIndexes.includes(entry.actor_idx)) continue;
      const hand = entry.hand || 'hand';
      parts.push(`actor ${entry.actor_idx} holds ${entry.item} in ${hand} ${hand === 'left' || hand === 'right' || hand === 'both' ? 'hand' : ''}`.trim());
    }
  }

  // Wardrobe — only mention actors in this beat AND only as a per-beat
  // anchor (BaseBeatGenerator's _buildWardrobeDirective already handles
  // persona-level wardrobe_hint; this is the SCENE-level mid-state, e.g.
  // "jacket draped over chair" if scene started with it on but actor took
  // it off in beat 1).
  if (sheet.wardrobe_state && actorIndexes.length > 0) {
    for (const idx of actorIndexes) {
      const w = sheet.wardrobe_state[idx];
      if (!w) continue;
      const desc = [w.top, w.bottom, ...(Array.isArray(w.accessories) ? w.accessories : [])]
        .filter(Boolean)
        .join(', ');
      if (desc) parts.push(`actor ${idx} wardrobe: ${desc}`);
    }
  }

  // Lighting motivation — single source of truth for the scene's key.
  if (sheet.lighting_key_direction) {
    parts.push(`lighting key from ${sheet.lighting_key_direction}`);
  }
  // Time of day — pins the color temperature.
  if (sheet.time_of_day) {
    parts.push(`time of day: ${sheet.time_of_day}`);
  }
  // Weather (optional, only when emitted).
  if (sheet.weather) {
    parts.push(`weather: ${sheet.weather}`);
  }

  if (parts.length === 0) return '';
  return `Scene continuity: ${parts.join('; ')}.`;
}

/**
 * Snapshot the sheet for Lens E (Tier 3.2). Returns a compact JSON-friendly
 * representation that fits in the multimodal Gemini call without burning
 * the budget.
 *
 * @param {Object} scene
 * @returns {Object}
 */
export function snapshotForLensE(scene) {
  if (!scene?.continuity_sheet) return null;
  const sheet = scene.continuity_sheet;
  return {
    props: (sheet.props_in_hand || []).map(p => `actor_${p.actor_idx}:${p.item}@${p.hand || '?'}`),
    wardrobe: Object.entries(sheet.wardrobe_state || {}).map(([idx, w]) => {
      const desc = [w.top, w.bottom, ...(w.accessories || [])].filter(Boolean).join(',');
      return `actor_${idx}:${desc}`;
    }),
    lighting: sheet.lighting_key_direction || null,
    time_of_day: sheet.time_of_day || null,
    weather: sheet.weather || null
  };
}

/**
 * Mutate the sheet to reflect a beat's prop pickup. Used by the
 * orchestrator AFTER a beat renders successfully when the screenplay
 * declares beat.props_picked_up = ['laptop']. (Tier 3.2 scope; included
 * here so the API surface is complete from day one.)
 *
 * @param {Object} scene
 * @param {Object} beat
 * @param {Array<{actor_idx: number, item: string, hand?: string}>} pickups
 */
export function applyPropPickups(scene, beat, pickups) {
  if (!Array.isArray(pickups) || pickups.length === 0) return;
  const sheet = ensureContinuitySheet(scene);
  for (const pickup of pickups) {
    if (typeof pickup?.actor_idx !== 'number' || !pickup.item) continue;
    sheet.props_in_hand.push({
      actor_idx: pickup.actor_idx,
      item: pickup.item,
      hand: pickup.hand || 'right'
    });
    sheet.prop_registry.push({
      item: pickup.item,
      introduced_in_beat: beat?.beat_id || null,
      current_state: 'in_hand'
    });
  }
}

/**
 * Mutate the sheet to reflect a beat's prop set-down. Mirror of applyPropPickups.
 *
 * @param {Object} scene
 * @param {Object} beat
 * @param {Array<{actor_idx: number, item: string}>} setdowns
 */
export function applyPropSetdowns(scene, beat, setdowns) {
  if (!Array.isArray(setdowns) || setdowns.length === 0) return;
  const sheet = ensureContinuitySheet(scene);
  for (const setdown of setdowns) {
    if (!setdown?.item) continue;
    sheet.props_in_hand = sheet.props_in_hand.filter(p =>
      !(p.item === setdown.item && (typeof setdown.actor_idx !== 'number' || p.actor_idx === setdown.actor_idx))
    );
    const reg = sheet.prop_registry.find(r => r.item === setdown.item);
    if (reg) reg.current_state = `set_down_in_${beat?.beat_id || 'unknown'}`;
  }
}

export default {
  EMPTY_CONTINUITY_SHEET,
  ensureContinuitySheet,
  buildContinuityDirective,
  snapshotForLensE,
  applyPropPickups,
  applyPropSetdowns
};
