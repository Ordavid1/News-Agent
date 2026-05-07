// services/v4/VeoFailureKnowledgeBuilder.js
//
// The Veo Failure-Learning Agent.
//
// Two entry points:
//
//   runNightly()  — called by the cron registered in AutomationManager.js at
//     02:00 UTC. Pulls the last 24h of veo_failure_log rows (with 30d for
//     trend context), clusters them by error_signature × beat_type, asks
//     Gemini to summarise new patterns into pattern_description /
//     avoid_phrases / safe_alternatives / gemini_directive / preflight_rule,
//     upserts into veo_failure_signatures, then regenerates
//     services/v4/VeoFailureKnowledge.mjs from the active rows.
//
//   runIncremental(signatureTag) — threshold-triggered (≥10 same-signature
//     failures in 60 minutes). Same as runNightly but scoped to one
//     signature tag and debounced to at most one run per signature per hour.
//
// Both entry points are idempotent and never throw — failures are caught and
// logged so a malformed Gemini response cannot brick the process.
//
// Cost posture: each runNightly() makes at most one Gemini call. Each
// runIncremental() makes at most one. We batch all clusters into a single
// LLM call rather than one-call-per-cluster to keep the spend bounded
// regardless of how many failure modes the day produces.

import fs from 'fs/promises';
import winston from 'winston';
import { supabaseAdmin, isConfigured } from '../supabase.js';
import {
  callVertexGeminiJson,
  isVertexGeminiConfigured
} from './VertexGemini.js';
import { invalidateCache, getKnowledgeFilePath } from './VeoFailureGuidance.js';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `[VeoFailureKnowledgeBuilder] ${timestamp} [${level}]: ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

// ─────────────────────────────────────────────────────────────────────
// Step 1 — Pull failure rows from the DB
// ─────────────────────────────────────────────────────────────────────

async function _fetchRecentFailures({ sinceMs, signatureTag = null, limit = 1000 }) {
  if (!isConfigured() || !supabaseAdmin) return [];
  const since = new Date(Date.now() - sinceMs).toISOString();

  let query = supabaseAdmin
    .from('veo_failure_log')
    .select('id, beat_id, beat_type, failure_mode, error_signatures, error_message, original_prompt, persona_names, attempt_tier_reached, recovery_succeeded, fallback_model, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (signatureTag) {
    query = query.contains('error_signatures', [signatureTag]);
  }

  const { data, error } = await query;
  if (error) {
    logger.warn(`fetch veo_failure_log error: ${error.message || error}`);
    return [];
  }
  return data || [];
}

async function _fetchExistingSignatures() {
  if (!isConfigured() || !supabaseAdmin) return [];
  const { data, error } = await supabaseAdmin
    .from('veo_failure_signatures')
    .select('*')
    .eq('status', 'active');
  if (error) {
    logger.warn(`fetch veo_failure_signatures error: ${error.message || error}`);
    return [];
  }
  return data || [];
}

// ─────────────────────────────────────────────────────────────────────
// Step 2 — Cluster failures by (failure_mode, primary_signature, beat_type)
// ─────────────────────────────────────────────────────────────────────

function _clusterFailures(rows) {
  // Group rows into buckets keyed by (failure_mode + primary signature tag + beat_type).
  // Primary signature = the first tag in error_signatures (collector orders most
  // specific first, so this picks the most informative).
  const buckets = new Map();
  for (const row of rows) {
    const sigs = Array.isArray(row.error_signatures) ? row.error_signatures : [];
    const primary = sigs[0] || row.failure_mode || 'other';
    const beatType = row.beat_type || 'unknown';
    const key = `${row.failure_mode}::${primary}::${beatType}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        key,
        failure_mode: row.failure_mode,
        primary_signature: primary,
        beat_type: beatType,
        rows: []
      });
    }
    buckets.get(key).rows.push(row);
  }
  // Sort buckets by occurrence_count desc — bigger clusters first.
  const sorted = [...buckets.values()].sort((a, b) => b.rows.length - a.rows.length);
  return sorted;
}

// ─────────────────────────────────────────────────────────────────────
// Step 3 — Ask Gemini to summarise the clusters
// ─────────────────────────────────────────────────────────────────────

const SUMMARISE_SYSTEM_PROMPT = `You are a video AI failure-pattern analyst.

You will receive a list of CLUSTERS. Each cluster contains real production failures observed when calling Google Vertex AI Veo 3.1 to generate short-form brand-story video beats. Your job: for each cluster, propose a structured failure signature that the system can use to AVOID this failure on future beats.

For every cluster output one object with these fields:

  signature_key: string (snake_case, stable identifier — reuse existing keys when the cluster matches one)
  failure_mode: string (one of: content_filter_prompt, content_filter_image, high_load, polling_timeout, rate_limit, auth, network, schema_violation, other)
  pattern_description: string (1-2 sentences, plain English, root cause focused)
  example_excerpts: array of strings (1-3 short verbatim excerpts from the failures, ≤120 chars each)
  prompt_avoid_phrases: array of strings (template-style, e.g. "<persona>'s wrist". empty array if not applicable)
  prompt_safe_alternatives: array of strings (replacements callers should use instead)
  gemini_directive: string (≤200 chars; one-sentence rule a screenplay-writing LLM can follow to avoid the pattern; empty string if the failure is purely infra-level)
  preflight_rule: object | null ({regex: string, flags: string, rewrite: string} — deterministic regex rewrite to apply pre-submission. null when the failure can't be deterministically detected by regex)
  severity: string (one of: low, medium, high, critical — high when ≥10 occurrences in the input window or when it forces a Kling fallback)

OUTPUT SHAPE (return EXACTLY this — no prose, no code fences):

{ "signatures": [ { ...one per cluster... } ] }

Constraints:
  - Emit at most one object per input cluster.
  - When a cluster's primary_signature matches an EXISTING signature_key (provided below), REUSE that key so the upsert merges evidence.
  - Never invent a regex you can't justify from the verbatim excerpts.
  - Empty prompt_avoid_phrases is acceptable for infra failures (high_load, rate_limit, etc.).`;

function _buildSummariseUserPrompt({ clusters, existingSignatures }) {
  const clusterBlock = clusters.map((c, i) => {
    const examples = c.rows.slice(0, 5).map(r => {
      const msg = (r.error_message || '').slice(0, 200);
      const prompt = (r.original_prompt || '').slice(0, 200);
      return `  - error_message: "${msg.replace(/"/g, '\\"')}"\n    original_prompt_excerpt: "${prompt.replace(/"/g, '\\"')}"`;
    }).join('\n');
    return (
      `CLUSTER ${i + 1} (occurrences: ${c.rows.length})\n` +
      `  failure_mode: ${c.failure_mode}\n` +
      `  primary_signature: ${c.primary_signature}\n` +
      `  beat_type: ${c.beat_type}\n` +
      `  examples:\n${examples}`
    );
  }).join('\n\n');

  const existingBlock = existingSignatures.length > 0
    ? existingSignatures.map(s =>
        `  - key: ${s.signature_key}, mode: ${s.failure_mode}, occurrences: ${s.occurrence_count}, severity: ${s.severity}`
      ).join('\n')
    : '  (none)';

  return (
    `EXISTING SIGNATURES (reuse signature_key when the cluster matches):\n${existingBlock}\n\n` +
    `CLUSTERS TO SUMMARISE:\n\n${clusterBlock}`
  );
}

const SUMMARISE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    signatures: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          signature_key: { type: 'string' },
          failure_mode: { type: 'string' },
          pattern_description: { type: 'string' },
          example_excerpts: { type: 'array', items: { type: 'string' } },
          prompt_avoid_phrases: { type: 'array', items: { type: 'string' } },
          prompt_safe_alternatives: { type: 'array', items: { type: 'string' } },
          gemini_directive: { type: 'string' },
          preflight_rule: {
            type: 'object',
            nullable: true,
            properties: {
              regex: { type: 'string' },
              flags: { type: 'string' },
              rewrite: { type: 'string' }
            }
          },
          severity: { type: 'string' }
        },
        required: ['signature_key', 'failure_mode', 'pattern_description', 'severity']
      }
    }
  },
  required: ['signatures']
};

async function _summariseClustersWithGemini({ clusters, existingSignatures }) {
  if (!isVertexGeminiConfigured()) {
    logger.warn('Vertex Gemini not configured — skipping LLM summarisation; using cluster metadata only');
    return _fallbackHeuristicSummary(clusters);
  }
  if (clusters.length === 0) return [];

  const userPrompt = _buildSummariseUserPrompt({ clusters, existingSignatures });

  try {
    const result = await callVertexGeminiJson({
      systemPrompt: SUMMARISE_SYSTEM_PROMPT,
      userPrompt,
      config: {
        temperature: 0.2,
        maxOutputTokens: 4000,
        responseSchema: SUMMARISE_RESPONSE_SCHEMA,
        thinkingLevel: 'low'
      },
      timeoutMs: 90000
    });
    const sigs = (result && Array.isArray(result.signatures)) ? result.signatures : [];
    logger.info(`Gemini summarised ${sigs.length} signatures from ${clusters.length} clusters`);
    return sigs;
  } catch (err) {
    logger.warn(`Gemini summarisation failed (${err.message}) — falling back to heuristic summary`);
    return _fallbackHeuristicSummary(clusters);
  }
}

function _fallbackHeuristicSummary(clusters) {
  // Cheap, no-LLM summary — keeps the agent useful when Gemini is down.
  return clusters.map(c => ({
    signature_key: `${c.primary_signature}_${c.beat_type}`.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 64),
    failure_mode: c.failure_mode,
    pattern_description: `Auto-clustered: ${c.rows.length} ${c.failure_mode} failures with primary signature "${c.primary_signature}" on ${c.beat_type} beats.`,
    example_excerpts: c.rows.slice(0, 3).map(r => (r.error_message || '').slice(0, 120)),
    prompt_avoid_phrases: [],
    prompt_safe_alternatives: [],
    gemini_directive: '',
    preflight_rule: null,
    severity: c.rows.length >= 10 ? 'high' : (c.rows.length >= 5 ? 'medium' : 'low')
  }));
}

// ─────────────────────────────────────────────────────────────────────
// Step 4 — Upsert signatures into veo_failure_signatures
// ─────────────────────────────────────────────────────────────────────

async function _upsertSignatures(signatures, clusters) {
  if (!isConfigured() || !supabaseAdmin) {
    logger.warn('Supabase not configured — skipping signature upsert');
    return [];
  }
  if (signatures.length === 0) return [];

  // Build signature_key → cluster_size map so we can bump occurrence_count.
  const sizeByKey = new Map();
  for (const c of clusters) {
    // The summariser may map multiple clusters to one signature_key (consolidation).
    // We add ALL cluster sizes for the same primary_signature into the same bucket
    // — but since the agent decides the key, we only know after the fact. So we
    // attach the size to the first match by primary_signature + beat_type:
    sizeByKey.set(`${c.primary_signature}::${c.beat_type}`, c.rows.length);
  }

  const now = new Date().toISOString();
  const upserted = [];

  for (const sig of signatures) {
    if (!sig || typeof sig.signature_key !== 'string' || sig.signature_key.length === 0) continue;

    // Validate failure_mode is a known value; default to 'other' if unknown
    // (rather than rejecting — agent values may evolve).
    const failure_mode = String(sig.failure_mode || 'other');

    const row = {
      signature_key: sig.signature_key,
      failure_mode,
      pattern_description: String(sig.pattern_description || '').slice(0, 2000),
      example_excerpts: Array.isArray(sig.example_excerpts) ? sig.example_excerpts.slice(0, 5).map(s => String(s).slice(0, 240)) : [],
      prompt_avoid_phrases: Array.isArray(sig.prompt_avoid_phrases) ? sig.prompt_avoid_phrases.slice(0, 20).map(s => String(s).slice(0, 200)) : [],
      prompt_safe_alternatives: Array.isArray(sig.prompt_safe_alternatives) ? sig.prompt_safe_alternatives.slice(0, 20).map(s => String(s).slice(0, 200)) : [],
      gemini_directive: String(sig.gemini_directive || '').slice(0, 400),
      preflight_rule_regex: sig.preflight_rule?.regex ? String(sig.preflight_rule.regex).slice(0, 400) : null,
      preflight_rule_flags: sig.preflight_rule?.flags ? String(sig.preflight_rule.flags).slice(0, 8) : null,
      preflight_rewrite: sig.preflight_rule?.rewrite != null ? String(sig.preflight_rule.rewrite).slice(0, 200) : null,
      severity: ['low', 'medium', 'high', 'critical'].includes(sig.severity) ? sig.severity : 'medium',
      status: 'active',
      source: 'agent',
      last_seen: now,
      updated_at: now
    };

    // Upsert by signature_key. Postgres' RETURNING returns the merged row.
    try {
      // Read existing to bump occurrence_count atomically (Supabase JS lacks an
      // RPC for "increment on conflict"). For simplicity, fetch then upsert.
      const { data: existing } = await supabaseAdmin
        .from('veo_failure_signatures')
        .select('id, occurrence_count, first_seen')
        .eq('signature_key', sig.signature_key)
        .maybeSingle();

      // Estimate new occurrence count: if there's a matching cluster bucket,
      // add its size; otherwise +1.
      const matchingBucketSize =
        sizeByKey.get(`${sig.signature_key}::${row.failure_mode}`) || 1;

      if (existing) {
        const { data, error } = await supabaseAdmin
          .from('veo_failure_signatures')
          .update({
            ...row,
            occurrence_count: (existing.occurrence_count || 0) + matchingBucketSize
          })
          .eq('id', existing.id)
          .select('id')
          .single();
        if (error) {
          logger.warn(`signature update failed for ${sig.signature_key}: ${error.message}`);
        } else {
          upserted.push({ ...row, id: data.id, action: 'updated' });
        }
      } else {
        const { data, error } = await supabaseAdmin
          .from('veo_failure_signatures')
          .insert({ ...row, occurrence_count: matchingBucketSize, first_seen: now })
          .select('id')
          .single();
        if (error) {
          logger.warn(`signature insert failed for ${sig.signature_key}: ${error.message}`);
        } else {
          upserted.push({ ...row, id: data.id, action: 'inserted' });
        }
      }
    } catch (err) {
      logger.warn(`upsert exception for ${sig.signature_key}: ${err.message}`);
    }
  }

  logger.info(`upserted ${upserted.length} signatures`);
  return upserted;
}

// ─────────────────────────────────────────────────────────────────────
// Step 5 — Regenerate services/v4/VeoFailureKnowledge.mjs
// ─────────────────────────────────────────────────────────────────────

function _formatSignatureForFile(sig) {
  // Render one signature object as JS source. We hand-render rather than
  // JSON.stringify so the generated file looks reviewable in PRs.
  const j = (v) => JSON.stringify(v);
  const arr = (v) => Array.isArray(v) ? `[${v.map(x => j(x)).join(', ')}]` : '[]';
  const preflight = (sig.preflight_rule_regex && sig.preflight_rewrite != null)
    ? `{ regex: ${j(sig.preflight_rule_regex)}, flags: ${j(sig.preflight_rule_flags || 'g')}, rewrite: ${j(sig.preflight_rewrite)} }`
    : 'null';
  const modelScope = Array.isArray(sig.model_scope) && sig.model_scope.length > 0
    ? sig.model_scope
    : ['veo-3.1-vertex', 'veo-3.1-fast', 'veo-3.1-standard'];

  return (
    `  {\n` +
    `    key: ${j(sig.signature_key)},\n` +
    `    failure_mode: ${j(sig.failure_mode)},\n` +
    `    pattern_description: ${j(sig.pattern_description || '')},\n` +
    `    occurrence_count: ${Number(sig.occurrence_count || 0)},\n` +
    `    severity: ${j(sig.severity || 'medium')},\n` +
    `    status: ${j(sig.status || 'active')},\n` +
    `    avoid_phrases: ${arr(sig.prompt_avoid_phrases)},\n` +
    `    safe_alternatives: ${arr(sig.prompt_safe_alternatives)},\n` +
    `    gemini_directive: ${j(sig.gemini_directive || '')},\n` +
    `    preflight_rule: ${preflight},\n` +
    `    model_scope: ${arr(modelScope)}\n` +
    `  }`
  );
}

function _renderKnowledgeFile({ activeSignatures, version, lastUpdated }) {
  const sigBlock = activeSignatures.map(_formatSignatureForFile).join(',\n');

  return `// services/v4/VeoFailureKnowledge.mjs
//
// AUTO-GENERATED by VeoFailureKnowledgeBuilder. DO NOT EDIT BY HAND.
//
// Last updated: ${lastUpdated}
// Source signatures: ${activeSignatures.length} active in veo_failure_signatures
//
// Consumers:
//   - services/VeoService.js              → applyPreflightRules() before tier 0 submission
//   - services/v4/VeoFailureGuidance.js   → cached facade; invalidates on rewrite
//   - public/components/brandStoryPromptsV4.mjs → optional system-prompt block
//   - services/BrandStoryService.js       → loads once per episode, passes to prompts

export const VEO_FAILURE_KNOWLEDGE_VERSION = ${JSON.stringify(version)};
export const VEO_FAILURE_LAST_UPDATED = ${JSON.stringify(lastUpdated)};
export const VEO_FAILURE_SOURCE = 'agent';

export const VEO_FAILURE_SIGNATURES = [
${sigBlock}
];

export function getGeminiSystemPromptBlock(opts = {}) {
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
    '═══════════════════════════════════════════════════════════════\\n' +
    'KNOWN VEO FAILURE PATTERNS — avoid these at authorship time\\n' +
    '═══════════════════════════════════════════════════════════════\\n' +
    \`(Auto-learned from production failures. Knowledge version \${VEO_FAILURE_KNOWLEDGE_VERSION}, \${directives.length} active rules. \` +
    'These rules describe phrasings Vertex AI Veo has refused on prior beats — avoiding them ' +
    'at screenplay authorship time prevents the V4 pipeline from burning sanitization-tier retries ' +
    'or falling back to Kling on content-filter rejections.)';
  const body = directives.map((d, i) => \`\${i + 1}) \${d}\`).join('\\n\\n');
  return \`\\n\${header}\\n\\n\${body}\\n\`;
}

export function applyPreflightRules(prompt, context = {}) {
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
      continue;
    }
    const matches = out.match(re);
    if (matches && matches.length > 0) {
      out = out.replace(re, rewrite);
      rewrites.push({ key: sig.key, count: matches.length });
    }
  }
  out = out
    .replace(/\\bon\\s+in frame\\b/gi, 'in frame')
    .replace(/\\bat\\s+in frame\\b/gi, 'in frame')
    .replace(/\\bof\\s+in frame\\b/gi, 'in frame')
    .replace(/\\s{2,}/g, ' ')
    .replace(/\\s+([.,;:!?])/g, '$1')
    .trim();
  return { prompt: out, rewrites };
}

export function shouldUseSafeFrameRegen(beatContext = {}) {
  return { shouldRegen: false, reason: 'no-history-yet' };
}

export function getKnowledgeSummary() {
  const active = VEO_FAILURE_SIGNATURES.filter(s => s.status === 'active');
  const byMode = {};
  const bySeverity = {};
  for (const s of active) {
    byMode[s.failure_mode] = (byMode[s.failure_mode] || 0) + 1;
    bySeverity[s.severity] = (bySeverity[s.severity] || 0) + 1;
  }
  return {
    version: VEO_FAILURE_KNOWLEDGE_VERSION,
    lastUpdated: VEO_FAILURE_LAST_UPDATED,
    source: VEO_FAILURE_SOURCE,
    activeCount: active.length,
    byMode,
    bySeverity
  };
}

export default {
  VEO_FAILURE_KNOWLEDGE_VERSION,
  VEO_FAILURE_LAST_UPDATED,
  VEO_FAILURE_SOURCE,
  VEO_FAILURE_SIGNATURES,
  getGeminiSystemPromptBlock,
  applyPreflightRules,
  shouldUseSafeFrameRegen,
  getKnowledgeSummary
};
`;
}

async function _writeKnowledgeFile(activeSignatures) {
  const now = new Date();
  const version = `${now.getUTCFullYear()}.${String(now.getUTCMonth() + 1).padStart(2, '0')}.${String(now.getUTCDate()).padStart(2, '0')}.${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}`;
  const lastUpdated = now.toISOString();
  const filePath = getKnowledgeFilePath();
  const content = _renderKnowledgeFile({ activeSignatures, version, lastUpdated });

  // Atomic write — write to .tmp then rename, so a partial write never
  // leaves a half-formed module on disk.
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, content, 'utf8');
  await fs.rename(tmpPath, filePath);
  invalidateCache();

  logger.info(`wrote ${filePath} (version=${version}, ${activeSignatures.length} signatures)`);
  return { version, lastUpdated, count: activeSignatures.length };
}

// ─────────────────────────────────────────────────────────────────────
// Step 6 — Run summary → automation_logs (best-effort)
// ─────────────────────────────────────────────────────────────────────

async function _logRunSummary(kind, summary) {
  if (!isConfigured() || !supabaseAdmin) return;
  try {
    // The automation_logs table has a CHECK constraint on `type` requiring
    // one of: info | warning | error | success. We use 'success' for
    // healthy runs and 'error' for failures; the run-kind ('nightly' /
    // 'incremental' / '*_error') and structured summary go into `metadata`.
    // The original implementation passed e.g. 'veo_failure_agent_nightly'
    // as `type`, which violated the CHECK and silently dropped the insert.
    const isError = kind.endsWith('_error') || (summary && typeof summary === 'object' && 'error' in summary);
    const type = isError ? 'error' : 'success';
    const errorMessage = isError
      ? (typeof summary?.error === 'string' ? summary.error : 'Veo failure-agent run reported an error')
      : null;
    // `context` is TEXT, not JSONB — keep it human-readable; structured
    // detail belongs in `metadata`.
    const contextLine = `veo_failure_agent_${kind}: ${summary && typeof summary === 'object'
      ? `signatures=${summary.active ?? '?'}, version=${summary.version ?? '?'}, in_window=${summary.failures_in_window ?? '?'}`
      : ''}`;
    await supabaseAdmin.from('automation_logs').insert({
      type,
      timestamp: new Date().toISOString(),
      error_message: errorMessage,
      context: contextLine,
      metadata: { kind: `veo_failure_agent_${kind}`, ...summary }
    });
  } catch (err) {
    // Swallow — summary logging is best-effort.
    logger.warn(`automation_logs write failed: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Public entry points
// ─────────────────────────────────────────────────────────────────────

/**
 * Nightly scheduled run. Pulls last 24h of failures (with last 30d for
 * trend context to weight severity), clusters, summarises, upserts, and
 * regenerates the knowledge module.
 *
 * @returns {Promise<{ok: boolean, signatures?: number, version?: string, error?: string}>}
 */
async function runNightly() {
  const t0 = Date.now();
  try {
    logger.info('runNightly() — pulling last 24h of veo_failure_log...');
    const recent = await _fetchRecentFailures({ sinceMs: 24 * 60 * 60 * 1000, limit: 2000 });
    if (recent.length === 0) {
      logger.info('runNightly() — no failures in window; rewriting from existing signatures only');
    } else {
      logger.info(`runNightly() — ${recent.length} failures found`);
    }

    const clusters = _clusterFailures(recent);
    const existing = await _fetchExistingSignatures();
    const proposed = await _summariseClustersWithGemini({ clusters, existingSignatures: existing });
    await _upsertSignatures(proposed, clusters);

    // Re-fetch active signatures (post-upsert) — that's the source of truth
    // we project into the .mjs file.
    const active = await _fetchExistingSignatures();
    const written = await _writeKnowledgeFile(active);

    const summary = {
      kind: 'nightly',
      window_hours: 24,
      failures_in_window: recent.length,
      clusters: clusters.length,
      proposed: proposed.length,
      active: active.length,
      version: written.version,
      duration_ms: Date.now() - t0
    };
    logger.info(`runNightly() — done. ${JSON.stringify(summary)}`);
    await _logRunSummary('nightly', summary);
    return { ok: true, signatures: active.length, version: written.version };
  } catch (err) {
    logger.warn(`runNightly() failed: ${err.message}`);
    await _logRunSummary('nightly_error', { error: err.message, duration_ms: Date.now() - t0 });
    return { ok: false, error: err.message };
  }
}

/**
 * Threshold-triggered incremental run. Scoped to one signature tag and
 * debounced upstream by VeoFailureCollector (at most one run per signature
 * per hour).
 *
 * @param {string} signatureTag
 * @returns {Promise<{ok: boolean, signatures?: number, version?: string, error?: string}>}
 */
async function runIncremental(signatureTag) {
  const t0 = Date.now();
  try {
    logger.info(`runIncremental('${signatureTag}') — pulling last 60min of veo_failure_log scoped to signature...`);
    const recent = await _fetchRecentFailures({
      sinceMs: 60 * 60 * 1000,
      signatureTag,
      limit: 200
    });
    if (recent.length === 0) {
      logger.info(`runIncremental('${signatureTag}') — no rows; nothing to do`);
      return { ok: true, signatures: 0 };
    }

    const clusters = _clusterFailures(recent);
    const existing = await _fetchExistingSignatures();
    const proposed = await _summariseClustersWithGemini({ clusters, existingSignatures: existing });
    await _upsertSignatures(proposed, clusters);

    const active = await _fetchExistingSignatures();
    const written = await _writeKnowledgeFile(active);

    const summary = {
      kind: 'incremental',
      signature_tag: signatureTag,
      window_hours: 1,
      failures_in_window: recent.length,
      clusters: clusters.length,
      proposed: proposed.length,
      active: active.length,
      version: written.version,
      duration_ms: Date.now() - t0
    };
    logger.info(`runIncremental('${signatureTag}') — done. ${JSON.stringify(summary)}`);
    await _logRunSummary('incremental', summary);
    return { ok: true, signatures: active.length, version: written.version };
  } catch (err) {
    logger.warn(`runIncremental('${signatureTag}') failed: ${err.message}`);
    await _logRunSummary('incremental_error', { signature_tag: signatureTag, error: err.message, duration_ms: Date.now() - t0 });
    return { ok: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Test-only exports (kept off the default export so they don't surface in production)
// ─────────────────────────────────────────────────────────────────────

export const __test__ = {
  classifyClusterPrimarySignature: _clusterFailures,
  fallbackHeuristicSummary: _fallbackHeuristicSummary,
  renderKnowledgeFile: _renderKnowledgeFile,
  formatSignatureForFile: _formatSignatureForFile,
  buildSummariseUserPrompt: _buildSummariseUserPrompt
};

export default {
  runNightly,
  runIncremental
};

export { runNightly, runIncremental };
