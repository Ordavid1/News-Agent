// services/v4/masterclass/framingTaxonomy.mjs
// V4 P0.3 — FramingTaxonomy threading (judge-side surface).
//
// V4_FRAMING_VOCAB lives in public/components/brandStoryPromptsV4.mjs (the
// frontend prompt module, ~333 lines of cinematography vocab). The generator
// briefs against it; the JUDGE never saw it before P0.3. This module is a
// thin shim that:
//   1. Re-exports V4_FRAMING_VOCAB so the rubric layer (services/v4/) can
//      consume it WITHOUT depending on the public/ frontend tree directly.
//   2. Provides buildFramingTaxonomyHint() — a compact summary string for
//      rubric prompt injection. Lists named recipes + their verification
//      signatures (lens_mm, distance, intent in 1 line each) so the judge
//      can verify whether a generator delivered the named recipe.
//   3. Provides getFramingRegistry() — a frozen Map for runtime validation
//      (e.g. in BeatRouter when beat.framing_intent.id is set).
//
// This is a step toward P0.2 (full masterclass extraction). For P0.3 we just
// want the JUDGE to see the same vocabulary the generator did, without
// rewriting the masterclass content. P0.2 will move the masterclass blocks
// into shared modules and improve the prose; this module is the read-only
// re-export until then.

import { V4_FRAMING_VOCAB } from '../../../public/components/brandStoryPromptsV4.mjs';

export { V4_FRAMING_VOCAB };

/**
 * Frozen registry: framing recipe id → { lens_mm, distance, intent, ... }
 * Used for runtime validation (does beat.framing_intent.id exist in the
 * registry?) and by judges when scoring framing_intent dimension.
 */
const FRAMING_REGISTRY = Object.freeze(
  Object.fromEntries(
    Object.entries(V4_FRAMING_VOCAB).map(([id, spec]) => [id, Object.freeze({ id, ...spec })])
  )
);

export function getFramingRegistry() {
  return FRAMING_REGISTRY;
}

/**
 * True if the recipe id is a registered framing name.
 */
export function isRegisteredFraming(id) {
  if (typeof id !== 'string' || !id) return false;
  return Object.prototype.hasOwnProperty.call(FRAMING_REGISTRY, id);
}

/**
 * Build a compact taxonomy hint for rubric prompt injection.
 *
 * Output (~80 chars per recipe):
 *   wide_establishing — lens 24-35mm, wide; intent: Establish env + subject in context.
 *   medium_two_shot   — lens 35-50mm, medium; intent: Two characters, conversational distance.
 *   ...
 *
 * @param {Object} [opts]
 * @param {string[]} [opts.relevantSlots] - filter to recipes matching these names. When null, returns the full taxonomy.
 * @param {number}   [opts.maxEntries]    - cap output count. Default 12.
 * @returns {string}
 */
export function buildFramingTaxonomyHint({ relevantSlots = null, maxEntries = 12 } = {}) {
  let entries = Object.entries(V4_FRAMING_VOCAB);
  if (Array.isArray(relevantSlots) && relevantSlots.length > 0) {
    const want = new Set(relevantSlots);
    entries = entries.filter(([id]) => want.has(id));
  }
  if (entries.length > maxEntries) entries = entries.slice(0, maxEntries);

  const lines = entries.map(([id, spec]) => {
    const lens = spec.lens_mm ? `lens ${spec.lens_mm}mm` : 'lens —';
    const distance = spec.distance || '—';
    const intent = (spec.intent || '').replace(/\s+/g, ' ').slice(0, 100);
    return `  ${id} \u2014 ${lens}, ${distance}; ${intent}`;
  });

  return [
    'NAMED FRAMING TAXONOMY (verify against these when scoring framing_intent / camera_move_intent):',
    ...lines
  ].join('\n');
}

/**
 * Build a verification signature line for a SPECIFIC framing recipe.
 * Used by judges when they have a beat.framing_intent.id and need to
 * verify the rendered clip delivered the recipe's signature properties.
 *
 * Returns null when the id isn't registered (caller should treat as
 * "no recipe pinned — score on general framing principles").
 *
 * @param {string} framingId
 * @returns {string|null}
 */
export function getVerificationSignature(framingId) {
  if (!isRegisteredFraming(framingId)) return null;
  const spec = FRAMING_REGISTRY[framingId];
  const parts = [
    `RECIPE: ${framingId}`,
    spec.lens_mm ? `lens ${spec.lens_mm}mm` : null,
    spec.distance ? `distance: ${spec.distance}` : null,
    spec.camera_move ? `move: ${spec.camera_move}` : null,
    spec.intent ? `intent: ${spec.intent}` : null,
    spec.reference ? `reference: ${spec.reference}` : null
  ].filter(Boolean);
  return parts.join(' | ');
}
