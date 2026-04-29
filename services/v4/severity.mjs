// V4 P0.1 — Canonical severity vocabulary, single source of truth.
//
// Before P0.1, three quality gates spoke three slightly different severity
// languages:
//   L1 ScreenplayValidator: 'blocker' | 'warning'
//   L2 ScreenplayDoctor:    bridged 'blocker' (L1) ↔ 'critical' (L3) at line 342
//   L3 DirectorAgent:       'critical' | 'warning' | 'note' (verdictSchema.mjs:32)
//
// The bridge worked but `note` severity was orphaned and the translation
// contract was a single line of code with no test coverage. This module
// centralizes the vocabulary so every consumer reads the same definitions.
//
// Canonical levels (DO NOT add without updating verdictSchema.mjs SEVERITY_ENUM
// in lockstep — Vertex AI's responseSchema is locked to this list):
//   - 'critical' — must be addressed; gates production
//   - 'warning'  — should be addressed; consumer-specific triggers (e.g.
//                  Doctor's DOCTOR_WARNING_TRIGGERS allowlist)
//   - 'note'     — advisory; surfaces in directorReport but never gates

export const SEVERITY_LEVELS = Object.freeze(['critical', 'warning', 'note']);

const SEVERITY_SET = new Set(SEVERITY_LEVELS);

// Legacy aliases. The L1 ScreenplayValidator emitted 'blocker' for years;
// canonical now is 'critical'. Both must continue to be acceptable input
// to consumers (e.g. Doctor) until every emitter is migrated.
const LEGACY_ALIASES = Object.freeze({
  blocker: 'critical'
});

/**
 * Normalize any severity value to canonical form.
 * - Returns 'critical' for both 'blocker' (legacy L1) and 'critical' (L3).
 * - Returns 'warning' as-is.
 * - Returns 'note' as-is.
 * - Returns null for anything unrecognized (caller decides whether to log
 *   or treat as advisory).
 */
export function normalizeSeverity(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (SEVERITY_SET.has(v)) return v;
  if (LEGACY_ALIASES[v]) return LEGACY_ALIASES[v];
  return null;
}

/**
 * True if the severity gates production-quality (must be fixed). Accepts
 * legacy 'blocker' transparently. The single, canonical predicate that
 * replaces the bespoke check at ScreenplayDoctor.js:342.
 */
export function isBlockerOrCritical(value) {
  return normalizeSeverity(value) === 'critical';
}

/**
 * True if the severity is 'warning'. Doctor consumers MUST also gate on
 * an id-allowlist (e.g. DOCTOR_WARNING_TRIGGERS) since most warnings are
 * not Doctor-actionable.
 */
export function isWarning(value) {
  return normalizeSeverity(value) === 'warning';
}

/**
 * True if the severity is 'note'. Notes never gate but MUST be surfaced
 * in directorReport.notes so the user sees the advisory context.
 */
export function isNote(value) {
  return normalizeSeverity(value) === 'note';
}

/**
 * True if value is a recognized severity (canonical or legacy alias).
 * Used by tests and by the rubric-emission canary in P5.1.
 */
export function isValidSeverity(value) {
  return normalizeSeverity(value) !== null;
}
