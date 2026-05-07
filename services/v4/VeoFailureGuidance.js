// services/v4/VeoFailureGuidance.js
//
// Runtime read path for the Veo Failure-Learning Agent.
//
// PIVOT (2026-05-07): the source of truth is the Supabase
// `veo_failure_signatures` table — NOT the on-disk .mjs file.
//
// Why the change: on Cloud Run with autoscaling, every instance has its own
// ephemeral filesystem. The previous design wrote a regenerated .mjs file on
// the instance that won the nightly cron call; the other N-1 instances never
// saw the rewrite, and a redeploy wiped the change anyway. So instances drifted
// arbitrarily across the fleet.
//
// New design:
//   - Per-instance 5-minute TTL cache. Each instance fetches active signatures
//     from `veo_failure_signatures` independently. With 5-min TTL the cost is
//     ~12 reads/hour/instance — negligible.
//   - Builder writes only to the DB (no file). Every reader sees the same rows.
//   - The checked-in .mjs file is retained as the COLD-START SEED — used only
//     when the DB query fails (Supabase outage, key not configured, etc.) so
//     the runtime path still has guidance to apply.
//
// Public surface UNCHANGED — getVeoFailureKnowledge() returns the same shape
// of object as before (VEO_FAILURE_SIGNATURES, getGeminiSystemPromptBlock,
// applyPreflightRules, shouldUseSafeFrameRegen, getKnowledgeSummary,
// VEO_FAILURE_KNOWLEDGE_VERSION, VEO_FAILURE_LAST_UPDATED, VEO_FAILURE_SOURCE).
// Callers (VeoService, BrandStoryService, SmartSynth, DirectorAgent) need no
// edits.

import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import winston from 'winston';
import { supabaseAdmin, isConfigured } from '../supabase.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `[VeoFailureGuidance] ${timestamp} [${level}]: ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

const TTL_MS = 5 * 60 * 1000; // per-instance cache TTL
const DEFAULT_MODEL_SCOPE = ['veo-3.1-vertex', 'veo-3.1-fast', 'veo-3.1-standard'];

let _cached = null;        // last knowledge surface (built from DB or fallback)
let _cachedAt = 0;          // epoch ms when _cached was populated
let _coldStartSeed = null;  // memoised dynamic-import of the .mjs fallback

/**
 * Project one DB row into the shape the rest of the codebase expects from
 * VEO_FAILURE_SIGNATURES entries in the .mjs. Field names mirror what the
 * old _formatSignatureForFile() emitted (key/avoid_phrases/safe_alternatives/
 * preflight_rule object/etc.) so consumers don't need to change.
 */
function _projectSignatureRow(row) {
  return {
    key: row.signature_key,
    failure_mode: row.failure_mode,
    pattern_description: row.pattern_description || '',
    occurrence_count: Number(row.occurrence_count || 0),
    severity: row.severity || 'medium',
    status: row.status || 'active',
    avoid_phrases: Array.isArray(row.prompt_avoid_phrases) ? row.prompt_avoid_phrases : [],
    safe_alternatives: Array.isArray(row.prompt_safe_alternatives) ? row.prompt_safe_alternatives : [],
    gemini_directive: row.gemini_directive || '',
    preflight_rule: (row.preflight_rule_regex && row.preflight_rewrite != null)
      ? { regex: row.preflight_rule_regex, flags: row.preflight_rule_flags || 'g', rewrite: row.preflight_rewrite }
      : null,
    model_scope: (Array.isArray(row.model_scope) && row.model_scope.length > 0)
      ? row.model_scope
      : DEFAULT_MODEL_SCOPE
  };
}

/**
 * Fetch active signatures from Supabase. Returns null on any error so the
 * caller knows to fall back to the cold-start seed.
 */
async function _fetchActiveSignaturesFromDb() {
  if (!isConfigured() || !supabaseAdmin) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from('veo_failure_signatures')
      .select('signature_key, failure_mode, pattern_description, occurrence_count, severity, status, prompt_avoid_phrases, prompt_safe_alternatives, gemini_directive, preflight_rule_regex, preflight_rule_flags, preflight_rewrite, model_scope, updated_at')
      .eq('status', 'active');
    if (error) {
      logger.warn(`DB fetch failed: ${error.message} — falling back to cold-start seed`);
      return null;
    }
    return data || [];
  } catch (err) {
    logger.warn(`DB fetch threw: ${err.message} — falling back to cold-start seed`);
    return null;
  }
}

/**
 * Build a knowledge surface (object with the same exports as the .mjs file)
 * around an array of projected signatures. Closes over `signatures` so each
 * call's output is self-contained.
 */
function _buildKnowledgeSurface({ signatures, source, lastUpdated, version }) {
  const VEO_FAILURE_SIGNATURES = signatures;

  function getGeminiSystemPromptBlock(opts = {}) {
    const {
      modelId = 'veo-3.1-vertex',
      minSeverity = ['low', 'medium', 'high', 'critical']
    } = opts;
    const directives = VEO_FAILURE_SIGNATURES
      .filter(s => s.status === 'active')
      .filter(s => !modelId || (s.model_scope || []).includes(modelId))
      .filter(s => minSeverity.includes(s.severity))
      .map(s => s.gemini_directive)
      .filter(d => typeof d === 'string' && d.trim().length > 0);
    if (directives.length === 0) return '';
    const header =
      '═══════════════════════════════════════════════════════════════\n' +
      'KNOWN VEO FAILURE PATTERNS — avoid these at authorship time\n' +
      '═══════════════════════════════════════════════════════════════\n' +
      `(Auto-learned from production failures. Knowledge version ${version}, ${directives.length} active rules. ` +
      'These rules describe phrasings Vertex AI Veo has refused on prior beats — avoiding them ' +
      'at screenplay authorship time prevents the V4 pipeline from burning sanitization-tier retries ' +
      'or falling back to Kling on content-filter rejections.)';
    const body = directives.map((d, i) => `${i + 1}) ${d}`).join('\n\n');
    return `\n${header}\n\n${body}\n`;
  }

  function applyPreflightRules(prompt, context = {}) {
    const { modelId = 'veo-3.1-vertex' } = context;
    if (!prompt || typeof prompt !== 'string') return { prompt, rewrites: [] };
    let out = prompt;
    const rewrites = [];
    for (const sig of VEO_FAILURE_SIGNATURES) {
      if (sig.status !== 'active') continue;
      if (!sig.preflight_rule) continue;
      if (modelId && !(sig.model_scope || []).includes(modelId)) continue;
      const { regex, flags = 'g', rewrite = '' } = sig.preflight_rule;
      if (!regex) continue;
      let re;
      try {
        re = new RegExp(regex, flags);
      } catch (err) {
        // Bad regex baked in by the agent — ignore but don't crash the whole pass.
        continue;
      }
      const matches = out.match(re);
      if (matches && matches.length > 0) {
        out = out.replace(re, rewrite);
        rewrites.push({ key: sig.key, count: matches.length });
      }
    }
    out = out
      .replace(/\bon\s+in frame\b/gi, 'in frame')
      .replace(/\bat\s+in frame\b/gi, 'in frame')
      .replace(/\bof\s+in frame\b/gi, 'in frame')
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([.,;:!?])/g, '$1')
      .trim();
    return { prompt: out, rewrites };
  }

  function shouldUseSafeFrameRegen(_beatContext = {}) {
    return { shouldRegen: false, reason: 'no-history-yet' };
  }

  function getKnowledgeSummary() {
    const active = VEO_FAILURE_SIGNATURES.filter(s => s.status === 'active');
    const byMode = {};
    const bySeverity = {};
    for (const s of active) {
      byMode[s.failure_mode] = (byMode[s.failure_mode] || 0) + 1;
      bySeverity[s.severity] = (bySeverity[s.severity] || 0) + 1;
    }
    return {
      version,
      lastUpdated,
      source,
      activeCount: active.length,
      byMode,
      bySeverity
    };
  }

  return {
    VEO_FAILURE_KNOWLEDGE_VERSION: version,
    VEO_FAILURE_LAST_UPDATED: lastUpdated,
    VEO_FAILURE_SOURCE: source,
    VEO_FAILURE_SIGNATURES,
    getGeminiSystemPromptBlock,
    applyPreflightRules,
    shouldUseSafeFrameRegen,
    getKnowledgeSummary
  };
}

/**
 * Path to the checked-in cold-start seed file. Kept as a public export so
 * the (now legacy) build-side regen tool, if ever revived, can locate it.
 */
export function getKnowledgeFilePath() {
  return path.join(__dirname, 'VeoFailureKnowledge.mjs');
}

/**
 * Lazy-load the checked-in .mjs as a cold-start fallback. Used only when
 * the DB fetch fails. Memoised so we don't re-import on every fallback.
 */
async function _getColdStartSeed() {
  if (_coldStartSeed) return _coldStartSeed;
  try {
    const url = pathToFileURL(getKnowledgeFilePath()).href;
    const mod = await import(url);
    _coldStartSeed = mod;
    return mod;
  } catch (err) {
    logger.error(`cold-start seed import failed: ${err.message}`);
    // Empty surface — every consumer's null-check still works.
    return _buildKnowledgeSurface({
      signatures: [],
      source: 'empty',
      lastUpdated: new Date().toISOString(),
      version: 'empty-no-seed'
    });
  }
}

/**
 * Public read API. Returns a knowledge surface — same shape as the previous
 * .mjs default export. Per-instance 5-min TTL cache.
 */
export async function getVeoFailureKnowledge() {
  const now = Date.now();
  if (_cached && (now - _cachedAt) < TTL_MS) return _cached;

  const rows = await _fetchActiveSignaturesFromDb();
  if (rows !== null) {
    const signatures = rows.map(_projectSignatureRow);
    const newestUpdatedAt = rows
      .map(r => r.updated_at)
      .filter(Boolean)
      .sort()
      .pop() || new Date().toISOString();
    const surface = _buildKnowledgeSurface({
      signatures,
      source: 'db',
      lastUpdated: newestUpdatedAt,
      version: `db-${newestUpdatedAt}`
    });
    _cached = surface;
    _cachedAt = now;
    return surface;
  }

  // DB unreachable / empty — use the seed file we shipped in the image.
  const seed = await _getColdStartSeed();
  _cached = seed;
  _cachedAt = now;
  return seed;
}

/**
 * Drop the in-process cache so the next getVeoFailureKnowledge() refetches
 * from the DB. Called by the builder after a successful upsert so the
 * SAME instance picks up the change immediately. Other instances refresh
 * on their own TTL cycle (max 5min stale).
 */
export function invalidateCache() {
  _cached = null;
  _cachedAt = 0;
}

/**
 * Test-only helper — clears both caches AND the seed memo so tests can
 * exercise the full read path.
 */
export function _resetForTests() {
  _cached = null;
  _cachedAt = 0;
  _coldStartSeed = null;
}

export default {
  getVeoFailureKnowledge,
  invalidateCache,
  getKnowledgeFilePath
};
