// services/v4/VeoFailureGuidance.js
// Thin facade over services/v4/VeoFailureKnowledge.mjs.
//
// Exists so that:
//   1. Consumers (VeoService, BrandStoryService) take a stable dependency on
//      this facade rather than the auto-generated knowledge module directly.
//   2. The knowledge module can be invalidated and re-imported at runtime
//      after VeoFailureKnowledgeBuilder rewrites the file — without a process
//      restart and without requiring every consumer to remember to flush its
//      own cache.
//   3. The facade is the single import point for unit tests to stub the
//      knowledge surface.

import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let _cached = null;

/**
 * Resolve the absolute file URL of the auto-generated knowledge module.
 * Centralised so VeoFailureKnowledgeBuilder writes to the SAME path the
 * facade reads from.
 */
export function getKnowledgeFilePath() {
  return path.join(__dirname, 'VeoFailureKnowledge.mjs');
}

/**
 * Lazily import the auto-generated knowledge module. Adds a cache-buster
 * query param to defeat Node's ESM cache after a regen — without it,
 * Node serves the stale module bytes for the lifetime of the process.
 *
 * @returns {Promise<typeof import('./VeoFailureKnowledge.mjs')>}
 */
export async function getVeoFailureKnowledge() {
  if (_cached) return _cached;
  const url = pathToFileURL(getKnowledgeFilePath()).href + `?v=${Date.now()}`;
  const mod = await import(url);
  _cached = mod;
  return mod;
}

/**
 * Drop the cached module so the next getVeoFailureKnowledge() call picks up
 * a freshly written VeoFailureKnowledge.mjs. Called by
 * VeoFailureKnowledgeBuilder after a successful regen.
 */
export function invalidateCache() {
  _cached = null;
}

export default {
  getVeoFailureKnowledge,
  invalidateCache,
  getKnowledgeFilePath
};
