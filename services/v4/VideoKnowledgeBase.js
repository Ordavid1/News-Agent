// services/v4/VideoKnowledgeBase.js
//
// In-process reader over the same YAML knowledge base served by the Video MCP
// (video-ai-knowledge-mcp/data/models/video/*.yaml). Lets the server-side V4
// DirectorAgent — which runs on Vertex Gemini and CANNOT reach stdio MCPs —
// consult model-specific weaknesses, prompt-tips, and capability envelopes
// when judging beats. Single source of truth: the YAML files. Two readers
// over the same data: this module (in-process) and the MCP server (stdio).
//
// Usage from a beat-level rubric prompt builder:
//   import { buildModelKbPart } from '../VideoKnowledgeBase.js';
//   const kbPart = buildModelKbPart(routingMetadata);  // {text: '<model_kb>...'} | null
//   if (kbPart) userParts.push(kbPart);
//
// Cache + error semantics mirror VertexGemini.js auth lazy-cache: parse once
// per process, memoize errors so a corrupt YAML doesn't get reparsed on
// every Lens C call. Public lookup never throws — degrades to null + logs.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `[VideoKnowledgeBase] ${timestamp} [${level}]: ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

const KB_BASE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'video-ai-knowledge-mcp', 'data'
);

// Multi-directory scan: video, image, audio, utility model docs all
// participate in the unified knowledge base. The chain-component lookup
// (e.g. `+sync-lipsync-v3` → audio/sync-lipsync.yaml) and any future Lens B
// image-model integration both depend on this single loader covering all
// model types from the same source of truth.
const MODELS_DIRS = [
  path.join(KB_BASE_DIR, 'models', 'video'),
  path.join(KB_BASE_DIR, 'models', 'image'),
  path.join(KB_BASE_DIR, 'models', 'audio'),
  path.join(KB_BASE_DIR, 'models', 'utility')
];

const TAXONOMIES_DIR = path.join(KB_BASE_DIR, 'taxonomies');

// ─── Constants the normalization pipeline depends on ──────────────────
//
// Single point of extension: when a new beat type is added (and its
// generator emits a new modelUsed suffix), add the suffix here. Tests
// force this set to stay in sync — adding a beat type without listing
// its suffix here will break the corresponding LOOKUP_CASES test.
const PURPOSE_SUFFIXES = new Set([
  'silent', 'action', 'text-override', 'montage',
  'reaction', 'insert', 'broll', 'vo-broll', 'bridge',
  'twoshot', 'text-card'
]);

// Mode prefixes (router-internal classifications, not model identifiers).
const MODE_PREFIX_RE = /^mode-[a-z]\//;

// Non-AI assemblers — recognized so we explicitly skip lookup with a
// reason instead of logging a noisy "miss" for every text-card beat.
const NON_AI_ASSEMBLERS = new Set(['ffmpeg', 'text-card']);

// Veo tier tokens — when present in the input, captured separately so the
// dossier can surface tier-specific envelope data (max duration, audio
// support, max resolution differ across veo-3.1-lite/fast/standard).
const VEO_TIER_TOKENS = ['standard', 'fast', 'lite'];

const DOSSIER_CHAR_CAP = 1500;

// ─── Lazy cache (process-level) ───────────────────────────────────────
let _kbCache = null;
let _kbInitError = null;
let _taxonomyCache = null;
let _taxonomyInitError = null;

/**
 * Public: lazy-loads + caches all model YAML docs across video, image,
 * audio, utility model directories. Mirrors the lazy-cache pattern at
 * services/v4/VertexGemini.js:_initAuth.
 *
 * Returns: { models: ModelDoc[], aliasIndex: Map<lowercaseAlias, modelId>,
 *            loadedAt: number, sourceDirs: string[] }
 *
 * Throws on parse failure (memoized — the first failure persists, subsequent
 * calls re-throw without re-parsing). Callers (lookupModelForJudging) trap
 * the throw and degrade to null.
 */
export function loadKnowledgeBase() {
  if (_kbInitError) throw _kbInitError;
  if (_kbCache) return _kbCache;

  try {
    const models = [];
    for (const dir of MODELS_DIRS) {
      models.push(..._loadYamlDir(dir));
    }
    const aliasIndex = _buildAliasIndex(models);
    _kbCache = {
      models,
      aliasIndex,
      loadedAt: Date.now(),
      sourceDirs: MODELS_DIRS
    };
    logger.info(`Loaded ${models.length} models from ${MODELS_DIRS.length} dirs (video/image/audio/utility)`);
    return _kbCache;
  } catch (err) {
    _kbInitError = err;
    logger.error(`Failed to load knowledge base: ${err.message}`);
    throw err;
  }
}

/**
 * Public: lazy-loads + caches the failure-signature taxonomy. Single canonical
 * source of taxonomy_id values that every model's failure_signatures[].taxonomy_id
 * must resolve into. Backed by data/taxonomies/failure-signatures.yaml.
 *
 * Returns: { schema_version, categories: Array<{id, name, description, ...}>,
 *            byId: Map<id, category>, loadedAt: number }
 */
export function loadFailureTaxonomy() {
  if (_taxonomyInitError) throw _taxonomyInitError;
  if (_taxonomyCache) return _taxonomyCache;

  try {
    const docs = _loadYamlDir(TAXONOMIES_DIR);
    const taxonomy = docs.find(d => Array.isArray(d.categories)) || { categories: [] };
    const byId = new Map();
    for (const c of taxonomy.categories || []) {
      if (c?.id) byId.set(c.id, c);
    }
    _taxonomyCache = {
      schema_version: taxonomy.schema_version || null,
      spine_source: taxonomy.spine_source || null,
      categories: taxonomy.categories || [],
      byId,
      loadedAt: Date.now()
    };
    logger.info(`Loaded failure-signature taxonomy: ${byId.size} categories`);
    return _taxonomyCache;
  } catch (err) {
    _taxonomyInitError = err;
    logger.error(`Failed to load failure taxonomy: ${err.message}`);
    throw err;
  }
}

/**
 * Public: never throws. Returns a judging dossier or null.
 *
 * @param {string} modelUsed - compound string from routingMetadata.modelUsed,
 *   e.g. 'mode-b/kling-o3-omni+sync-lipsync-v3', 'veo-3.1-standard/reaction (tier 2)'
 * @returns {Object|null} dossier or null when input is empty / non-applicable
 *   (assembler beats) / unknown (no YAML match).
 */
export function lookupModelForJudging(modelUsed) {
  if (!modelUsed || typeof modelUsed !== 'string') {
    return null;
  }

  let kb;
  try {
    kb = loadKnowledgeBase();
  } catch {
    // Already logged at error level inside loadKnowledgeBase. Subsequent
    // calls hit _kbInitError fast-path and re-throw immediately; we trap
    // here so the judge degrades gracefully.
    return null;
  }

  const parsed = _normalizeModelUsed(modelUsed, kb.aliasIndex);
  if (!parsed.baseModelId) {
    if (parsed.reason === 'not-applicable') {
      logger.info(`lookup skipped (not-applicable): ${modelUsed}`);
    }
    return null;
  }

  const doc = kb.models.find(m => m.id === parsed.baseModelId);
  if (!doc) {
    logger.warn(`lookup miss: rawInput="${modelUsed}" → baseModelId="${parsed.baseModelId}" (no YAML doc)`);
    return null;
  }

  const dossier = _buildDossier(doc, parsed);
  logger.info(
    `lookup hit: ${modelUsed} → ${doc.id}` +
    (parsed.tier ? `/${parsed.tier}` : '') +
    (parsed.chainComponents.length ? `, chain=[${parsed.chainComponents.join(',')}]` : '')
  );
  return dossier;
}

/**
 * Public: render a dossier as a compact <model_kb>...</model_kb> text block.
 * Plain text (not JSON) — tokenizes more efficiently for the judge LLM.
 * Hard-capped at DOSSIER_CHAR_CAP (1500) to preserve the verdict-output
 * budget discipline at services/v4/DirectorAgent.js:40-67.
 *
 * @param {Object} dossier
 * @returns {string} <model_kb>...</model_kb> block
 */
export function formatModelDossierForPrompt(dossier) {
  if (!dossier) return '';

  const lines = ['<model_kb>'];
  lines.push(`model: ${dossier.id} — ${dossier.name} (${dossier.provider})`);

  // Envelope (capability ceiling)
  const env = dossier.envelope || {};
  const envParts = [];
  if (env.max_duration) envParts.push(`max ${env.max_duration}`);
  if (env.max_resolution) envParts.push(`@ ${env.max_resolution}`);
  if (env.fps) envParts.push(`${env.fps}fps`);
  if (envParts.length) lines.push(`envelope: ${envParts.join(' ')}`);

  // Tier-specific (veo family) — only when matched
  if (dossier.tier) {
    const t = dossier.tier;
    const tierParts = [];
    if (t.max_duration) tierParts.push(`max ${t.max_duration}`);
    if (t.max_resolution) tierParts.push(`@ ${t.max_resolution}`);
    if (typeof t.audio === 'boolean') tierParts.push(`audio=${t.audio ? 'yes' : 'no'}`);
    lines.push(`tier ${t.name}: ${tierParts.join(', ')}` + (t.notes ? ` — ${t.notes}` : ''));
  }

  if ((dossier.capabilities || []).length) {
    // Defensive: kling-3-omni and a few other YAMLs interleave nested-object
    // entries (e.g. inline structured docs) into capabilities[]. Filter to
    // primitive string values so the prompt block doesn't render `[object
    // Object]` artifacts.
    const flatCaps = dossier.capabilities
      .filter(c => typeof c === 'string')
      .slice(0, 8);
    if (flatCaps.length) lines.push(`capabilities: ${flatCaps.join(', ')}`);
  }

  // Structured failure signatures (taxonomy_id + severity tagged) take
  // precedence over the legacy free-prose `weaknesses` array. The judge
  // is encouraged to cite taxonomy_id in its evidence field, which makes
  // findings cross-model-comparable.
  if ((dossier.failure_signatures || []).length) {
    lines.push('weaknesses to watch for (failure_signatures):');
    for (const s of dossier.failure_signatures.slice(0, 5)) {
      const tag = `[${s.taxonomy_id || 'uncategorized'}, severity ${s.severity ?? '?'}]`;
      const fix = s.fix_strategy ? ` — fix: ${s.fix_strategy}` : '';
      lines.push(`  - ${tag} ${s.name}${fix}`);
    }
  } else if ((dossier.weaknesses || []).length) {
    // Fallback to legacy weaknesses prose when failure_signatures absent.
    lines.push('weaknesses to watch for:');
    for (const w of dossier.weaknesses.slice(0, 5)) lines.push(`  - ${w}`);
  }

  if ((dossier.prompt_tips || []).length) {
    lines.push('prompt tips the generator should have honored:');
    for (const t of dossier.prompt_tips.slice(0, 5)) lines.push(`  - ${t}`);
  }

  if ((dossier.unique_features || []).length) {
    lines.push('unique features (worth crediting in commendations):');
    for (const u of dossier.unique_features.slice(0, 3)) lines.push(`  - ${u}`);
  }

  if ((dossier.chain_components || []).length) {
    lines.push(`chain components applied: ${dossier.chain_components.join(', ')}`);
  }

  lines.push('</model_kb>');
  let text = lines.join('\n');

  if (text.length > DOSSIER_CHAR_CAP) {
    // Truncate at the last newline before the cap, then append a structured
    // marker so the LLM understands content was elided rather than parsing a
    // half-line as data.
    const safeCut = text.lastIndexOf('\n', DOSSIER_CHAR_CAP - 60);
    text = text.slice(0, safeCut > 0 ? safeCut : DOSSIER_CHAR_CAP - 60)
      + '\n[truncated for budget]\n</model_kb>';
  }

  return text;
}

/**
 * Public: convenience wrapper that any beat-level rubric prompt builder can
 * call to inject the model dossier with a single line. Returns a Vertex-ready
 * userPart object {text} or null when lookup misses.
 *
 * Used by services/v4/director-rubrics/beatRubric.mjs (prestige) and intended
 * to be reused by services/v4/director-rubrics/commercialBeatRubric.mjs
 * (Phase 7 B3, in-flight) so both rubrics inherit model-aware judging from
 * one canonical injection point.
 *
 * @param {Object|null} routingMetadata - { modelUsed, ... } from beat result
 * @returns {{text: string}|null}
 */
export function buildModelKbPart(routingMetadata) {
  if (!routingMetadata || !routingMetadata.modelUsed) return null;
  const dossier = lookupModelForJudging(routingMetadata.modelUsed);
  if (!dossier) return null;
  const text = formatModelDossierForPrompt(dossier);
  if (!text) return null;
  return { text };
}

/**
 * @internal — test-only. Clears the module-scoped cache and error memo so
 * each test starts with a clean load. Do NOT call from production code.
 */
export function _resetForTests() {
  _kbCache = null;
  _kbInitError = null;
}

// ─── Internal helpers ─────────────────────────────────────────────────

/**
 * Walk a directory and parse every .yaml/.yml file into an array of model
 * docs. Mirrors video-ai-knowledge-mcp/server.js:loadYamlDir — handles both
 * multi-document files (--- separators) AND single-document files that
 * contain a YAML array of models (kling-3, heygen, runway-gen4, seedance).
 */
function _loadYamlDir(dirPath) {
  const results = [];
  if (!fs.existsSync(dirPath)) {
    throw new Error(`Knowledge base directory not found: ${dirPath}`);
  }
  for (const file of fs.readdirSync(dirPath)) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
    const fullPath = path.join(dirPath, file);
    const raw = fs.readFileSync(fullPath, 'utf8');
    let docs;
    try {
      docs = yaml.loadAll(raw);
    } catch (err) {
      throw new Error(`YAML parse failed for ${file}: ${err.message}`);
    }
    for (const doc of docs) {
      if (!doc) continue;
      if (Array.isArray(doc)) results.push(...doc);
      else results.push(doc);
    }
  }
  return results;
}

/**
 * Build a lowercase-alias → canonical-modelId index from each doc's
 * `also_known_as` field. Tolerates both string and array shapes (some YAML
 * files used a comma-separated string before this plan converted them to
 * arrays). Self-aliases the canonical id too so the lookup path is uniform.
 */
function _buildAliasIndex(models) {
  const idx = new Map();
  for (const m of models) {
    if (!m?.id) continue;
    const canonicalId = String(m.id).toLowerCase();
    idx.set(canonicalId, m.id);

    const aliases = m.also_known_as;
    if (!aliases) continue;
    const list = Array.isArray(aliases)
      ? aliases
      : String(aliases).split(',').map(s => s.trim());
    for (const alias of list) {
      if (!alias) continue;
      idx.set(String(alias).toLowerCase(), m.id);
    }
  }
  return idx;
}

/**
 * Generator-side modelUsed strings are compound (e.g.
 * 'mode-b/kling-o3-omni+sync-lipsync-v3', 'veo-3.1-standard/reaction (tier 2)').
 * Parse them down to a canonical baseModelId + side-channel fields the
 * dossier surfaces (tier, chainComponents).
 *
 * @returns {{baseModelId: string|null, tier: string|null,
 *            chainComponents: string[], rawInput: string, reason?: string}}
 */
function _normalizeModelUsed(raw, aliasIndex) {
  const rawInput = raw;
  let s = String(raw).toLowerCase().trim();

  // 1. Strip parens content '(tier 2)' — we don't surface the int, but we
  //    do strip it so it doesn't leak into the suffix-strip step.
  s = s.replace(/\s*\([^)]*\)\s*/g, ' ').trim();

  // 2. Split chain components on '+'. Whitespace around the '+' is allowed
  //    (e.g. 'veo-3.1-standard/vo-broll + elevenlabs').
  const chainSplit = s.split(/\s*\+\s*/);
  const primary = chainSplit[0];
  const chainComponents = chainSplit.slice(1).filter(Boolean);

  let token = primary;

  // 3. Strip mode prefix ('mode-a/', 'mode-b/').
  token = token.replace(MODE_PREFIX_RE, '');

  // 4. Detect non-AI assembler — short-circuit before alias lookup.
  const firstSeg = token.split('/')[0];
  if (NON_AI_ASSEMBLERS.has(firstSeg)) {
    return { baseModelId: null, tier: null, chainComponents, rawInput, reason: 'not-applicable' };
  }

  // 5. Strip purpose suffix from a known set ('silent', 'action', etc.).
  //    The suffix is the LAST '/'-segment when it's in PURPOSE_SUFFIXES.
  const slashIdx = token.lastIndexOf('/');
  if (slashIdx >= 0) {
    const suffix = token.slice(slashIdx + 1).trim();
    if (PURPOSE_SUFFIXES.has(suffix)) {
      token = token.slice(0, slashIdx);
    }
  }

  // 6. Detect tier token suffix on the veo family (-standard / -fast / -lite).
  //    Stripped from token so the alias lookup matches the canonical id.
  let tier = null;
  for (const t of VEO_TIER_TOKENS) {
    const suf = `-${t}`;
    if (token.endsWith(suf)) {
      tier = t;
      // Don't strip yet — also_known_as covers veo-3.1-standard etc. so the
      // alias index will resolve it directly. We just record the tier.
      break;
    }
  }

  // 7. Alias lookup — try the full token first, then the token without any
  //    tier suffix (in case the alias is canonical only, e.g. 'veo-3.1').
  const direct = aliasIndex.get(token);
  if (direct) return { baseModelId: direct, tier, chainComponents, rawInput };

  if (tier) {
    const stripped = token.slice(0, -1 * (tier.length + 1));
    const fallback = aliasIndex.get(stripped);
    if (fallback) return { baseModelId: fallback, tier, chainComponents, rawInput };
  }

  return { baseModelId: null, tier, chainComponents, rawInput, reason: 'unknown-format' };
}

/**
 * Match a tier token (e.g. 'standard') against the model's `tiers` array
 * (currently only veo-3.1 has tiers in the knowledge base). Substring,
 * case-insensitive — name field looks like 'Veo 3.1 Standard/Pro'.
 */
function _findTier(modelDoc, tierToken) {
  if (!modelDoc?.tiers || !Array.isArray(modelDoc.tiers) || !tierToken) return null;
  const needle = tierToken.toLowerCase();
  return modelDoc.tiers.find(t => String(t.name || '').toLowerCase().includes(needle)) || null;
}

/**
 * Allow-list (NOT deny-list) of fields that go into the dossier. Future
 * YAML additions don't accidentally leak vendor URLs or pricing into the
 * judge's prompt budget. If a new field becomes judge-relevant, add it
 * here explicitly.
 */
function _buildDossier(doc, parsed) {
  const tierMatch = _findTier(doc, parsed.tier);
  return {
    id: doc.id,
    name: doc.name,
    provider: doc.provider,
    capabilities: Array.isArray(doc.capabilities) ? doc.capabilities : [],
    envelope: {
      max_duration: doc.max_duration || null,
      max_resolution: doc.max_resolution || null,
      fps: doc.fps != null ? doc.fps : null
    },
    weaknesses: Array.isArray(doc.weaknesses) ? doc.weaknesses : [],
    prompt_tips: Array.isArray(doc.prompt_tips) ? doc.prompt_tips : [],
    unique_features: Array.isArray(doc.unique_features) ? doc.unique_features : [],
    failure_signatures: Array.isArray(doc.failure_signatures)
      ? doc.failure_signatures.map(s => ({
          id: s.id || null,
          taxonomy_id: s.taxonomy_id || null,
          name: s.name || null,
          severity: s.severity ?? null,
          fix_strategy: s.fix_strategy || null
        }))
      : [],
    tier: tierMatch
      ? {
          name: tierMatch.name,
          max_duration: tierMatch.max_duration || null,
          max_resolution: tierMatch.max_resolution || null,
          audio: typeof tierMatch.audio === 'boolean' ? tierMatch.audio : null,
          notes: tierMatch.notes || null
        }
      : null,
    chain_components: parsed.chainComponents || []
  };
}
