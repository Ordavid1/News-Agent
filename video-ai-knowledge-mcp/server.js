import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Data Loading ───────────────────────────────────────────────────────────

function loadYamlDir(dirPath) {
  const results = [];
  if (!fs.existsSync(dirPath)) return results;
  for (const file of fs.readdirSync(dirPath)) {
    if (file.endsWith('.yaml') || file.endsWith('.yml')) {
      const raw = fs.readFileSync(path.join(dirPath, file), 'utf8');
      // Handle multi-document YAML files (separated by ---)
      const docs = yaml.loadAll(raw);
      for (const doc of docs) {
        if (!doc) continue;
        if (Array.isArray(doc)) results.push(...doc);
        else results.push(doc);
      }
    }
  }
  return results;
}

function loadAllModels() {
  return {
    video: loadYamlDir(path.join(__dirname, 'data/models/video')),
    image: loadYamlDir(path.join(__dirname, 'data/models/image')),
    audio: loadYamlDir(path.join(__dirname, 'data/models/audio')),
    utility: loadYamlDir(path.join(__dirname, 'data/models/utility')),
  };
}

function loadWorkflows() {
  return loadYamlDir(path.join(__dirname, 'data/workflows'));
}

function loadCapabilities() {
  return loadYamlDir(path.join(__dirname, 'data/capabilities'));
}

function loadFailureTaxonomy() {
  const docs = loadYamlDir(path.join(__dirname, 'data/taxonomies'));
  // First doc with a `categories` array is the canonical failure-signature taxonomy.
  return docs.find(d => Array.isArray(d?.categories)) || { categories: [] };
}

function loadReferences() {
  // Load prestige-reference data from all sub-buckets under data/references/.
  // Each sub-dir's YAMLs contain reference entries (commercials, prestige-tv,
  // prestige-film, ai-native-shorts).
  const refsDir = path.join(__dirname, 'data/references');
  if (!fs.existsSync(refsDir)) return [];
  const all = [];
  for (const subBucket of fs.readdirSync(refsDir)) {
    const subPath = path.join(refsDir, subBucket);
    if (!fs.statSync(subPath).isDirectory()) continue;
    const docs = loadYamlDir(subPath);
    for (const doc of docs) {
      // Each YAML doc may be {references: [...]} OR a direct entry; handle both.
      if (Array.isArray(doc?.references)) all.push(...doc.references);
      else if (doc?.id && doc?.title) all.push(doc);
    }
  }
  return all;
}

function loadV4BeatRecipes() {
  const dir = path.join(__dirname, 'data/workflows/v4-beats');
  if (!fs.existsSync(dir)) return [];
  return loadYamlDir(dir);
}

// ─── Search Helpers ─────────────────────────────────────────────────────────

function matchesQuery(obj, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  const text = JSON.stringify(obj).toLowerCase();
  return q.split(/\s+/).every(term => text.includes(term));
}

function filterModels(models, { type, query, capability, provider }) {
  let pool = [];
  if (!type || type === 'all') {
    pool = [...models.video, ...models.image, ...(models.audio || []), ...(models.utility || [])];
  } else if (type === 'video') {
    pool = models.video;
  } else if (type === 'image') {
    pool = models.image;
  } else if (type === 'audio') {
    pool = models.audio || [];
  } else if (type === 'utility') {
    pool = models.utility || [];
  }

  if (query) pool = pool.filter(m => matchesQuery(m, query));
  if (capability) {
    const cap = capability.toLowerCase();
    pool = pool.filter(m =>
      m.capabilities?.some(c => c.toLowerCase().includes(cap)) ||
      m.supported_inputs?.some(i => i.toLowerCase().includes(cap)) ||
      m.supported_outputs?.some(o => o.toLowerCase().includes(cap))
    );
  }
  if (provider) {
    const p = provider.toLowerCase();
    pool = pool.filter(m =>
      m.provider?.toLowerCase().includes(p) ||
      m.api_providers?.some(ap => ap.name?.toLowerCase().includes(p))
    );
  }
  return pool;
}

// ─── Server Setup ───────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'video-ai-knowledge',
  version: '1.0.0',
  description: 'AI Video & Image Production knowledge base — models, capabilities, workflows, and pipeline composition',
});

// ─── Tool: query_models ─────────────────────────────────────────────────────

server.tool(
  'query_models',
  'Search and filter AI video/image/audio/utility generation models by type, capability, provider, or free-text query. Returns detailed specs including resolution, duration, pricing, API endpoints, official vendor documentation links, strengths, and structured failure_signatures.',
  {
    type: z.enum(['video', 'image', 'audio', 'utility', 'all']).optional().describe('Filter by model type'),
    query: z.string().optional().describe('Free-text search across all model fields'),
    capability: z.string().optional().describe('Filter by capability (e.g. "text-to-video", "image-to-video", "style-transfer", "lip-sync")'),
    provider: z.string().optional().describe('Filter by API provider (e.g. "fal.ai", "replicate", "runway", "google")'),
  },
  async (params) => {
    const models = loadAllModels();
    const results = filterModels(models, params);
    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'No models found matching your criteria.' }] };
    }
    return {
      content: [{
        type: 'text',
        text: results.map(m => yaml.dump(m, { lineWidth: 120 })).join('\n---\n'),
      }],
    };
  }
);

// ─── Tool: compare_models ───────────────────────────────────────────────────

server.tool(
  'compare_models',
  'Compare two or more AI models side-by-side for a specific task. Shows strengths, weaknesses, pricing, quality, speed tradeoffs, and links to official vendor documentation.',
  {
    models: z.array(z.string()).min(2).describe('Model names to compare (e.g. ["kling-3-pro", "runway-gen-4.5"])'),
    task: z.string().optional().describe('Specific task context for comparison (e.g. "product-ad", "talking-head", "cinematic-short")'),
  },
  async ({ models: modelNames, task }) => {
    const allModels = loadAllModels();
    const pool = [...allModels.video, ...allModels.image];

    const found = modelNames.map(name => {
      const n = name.toLowerCase().replace(/[\s_-]+/g, '');
      return pool.find(m => {
        const mid = (m.id || '').toLowerCase().replace(/[\s_-]+/g, '');
        const mname = (m.name || '').toLowerCase().replace(/[\s_-]+/g, '');
        return mid.includes(n) || mname.includes(n) || n.includes(mid) || n.includes(mname);
      });
    });

    const comparison = found.map((m, i) => {
      if (!m) return `### ${modelNames[i]}\nModel not found in knowledge base.`;
      return [
        `### ${m.name}`,
        `- **Provider**: ${m.provider || 'Unknown'}`,
        `- **Type**: ${m.type || 'Unknown'}`,
        `- **Capabilities**: ${(m.capabilities || []).join(', ')}`,
        `- **Max Resolution**: ${m.max_resolution || 'Unknown'}`,
        m.max_duration ? `- **Max Duration**: ${m.max_duration}` : null,
        `- **Strengths**: ${(m.strengths || []).join('; ')}`,
        `- **Weaknesses**: ${(m.weaknesses || []).join('; ')}`,
        m.pricing ? `- **Pricing**: ${typeof m.pricing === 'string' ? m.pricing : yaml.dump(m.pricing).trim()}` : null,
        m.api_providers ? `- **API Access**: ${m.api_providers.map(a => a.name).join(', ')}` : null,
        m.official_documentation?.vendor_docs ? `- **Official Docs**: ${m.official_documentation.vendor_docs}` : null,
        m.official_documentation?.api_reference ? `- **API Reference**: ${m.official_documentation.api_reference}` : null,
      ].filter(Boolean).join('\n');
    });

    let header = `## Model Comparison`;
    if (task) header += ` for "${task}"`;
    return {
      content: [{ type: 'text', text: header + '\n\n' + comparison.join('\n\n') }],
    };
  }
);

// ─── Tool: get_workflows ────────────────────────────────────────────────────

server.tool(
  'get_workflows',
  'Retrieve AI video/image production workflow templates. These are composable multi-step pipelines (like Runway Workflows or fal.ai DAGs) that chain models together for complex production tasks.',
  {
    query: z.string().optional().describe('Search workflows by name, goal, or technique (e.g. "storyboard", "multi-shot", "style-transfer")'),
    source: z.enum(['runway', 'fal', 'custom', 'all']).optional().describe('Filter by workflow source platform'),
  },
  async ({ query, source }) => {
    let workflows = loadWorkflows();
    if (source && source !== 'all') {
      workflows = workflows.filter(w => w.source?.toLowerCase() === source);
    }
    if (query) {
      workflows = workflows.filter(w => matchesQuery(w, query));
    }
    if (workflows.length === 0) {
      return { content: [{ type: 'text', text: 'No workflows found matching your criteria.' }] };
    }
    return {
      content: [{
        type: 'text',
        text: workflows.map(w => yaml.dump(w, { lineWidth: 120 })).join('\n---\n'),
      }],
    };
  }
);

// ─── Tool: suggest_pipeline ─────────────────────────────────────────────────

server.tool(
  'suggest_pipeline',
  'Given a production goal, suggest the optimal multi-model pipeline. Recommends which models to chain, in what order, with rationale for each choice based on the knowledge base.',
  {
    goal: z.string().describe('What you want to produce (e.g. "30-second brand story video from a product description", "talking-head ad with lip-sync")'),
    constraints: z.object({
      budget: z.enum(['low', 'medium', 'high']).optional(),
      speed: z.enum(['fast', 'balanced', 'quality']).optional(),
      style: z.string().optional(),
    }).optional().describe('Optional constraints for pipeline selection'),
  },
  async ({ goal, constraints }) => {
    const models = loadAllModels();
    const workflows = loadWorkflows();
    const capabilities = loadCapabilities();

    // Build a comprehensive context for the suggestion
    const goalLower = goal.toLowerCase();

    // Identify relevant capabilities
    const relevantCaps = capabilities.filter(c => matchesQuery(c, goal));

    // Identify relevant workflows
    const relevantWorkflows = workflows.filter(w => matchesQuery(w, goal));

    // Identify relevant models
    const allModels = [...models.video, ...models.image];
    const relevantModels = allModels.filter(m => matchesQuery(m, goal));

    // Build the suggestion response
    const sections = [];

    if (relevantWorkflows.length > 0) {
      sections.push('## Matching Workflow Templates\n' +
        relevantWorkflows.map(w =>
          `### ${w.name}\n- **Source**: ${w.source}\n- **Description**: ${w.description}\n- **Steps**:\n${(w.steps || []).map((s, i) => `  ${i + 1}. **${s.name}**: ${s.model || s.tool} — ${s.description}`).join('\n')}\n- **Estimated Cost**: ${w.estimated_cost || 'varies'}`
        ).join('\n\n'));
    }

    if (relevantCaps.length > 0) {
      sections.push('## Relevant Capabilities\n' +
        relevantCaps.map(c =>
          `### ${c.name}\n${c.description}\n- **Best models**: ${(c.recommended_models || []).join(', ')}`
        ).join('\n\n'));
    }

    if (relevantModels.length > 0) {
      sections.push('## Candidate Models\n' +
        relevantModels.map(m =>
          `- **${m.name}** (${m.type}): ${(m.capabilities || []).join(', ')} | ${(m.strengths || []).slice(0, 2).join('; ')}`
        ).join('\n'));
    }

    if (constraints) {
      sections.push(`## Applied Constraints\n- Budget: ${constraints.budget || 'any'}\n- Speed: ${constraints.speed || 'any'}\n- Style: ${constraints.style || 'any'}`);
    }

    const text = sections.length > 0
      ? `# Pipeline Suggestion for: "${goal}"\n\n${sections.join('\n\n---\n\n')}`
      : `# Pipeline Suggestion for: "${goal}"\n\nNo exact matches found. Consider breaking down your goal into sub-tasks and querying individual capabilities (text-to-image, image-to-video, audio-tts, etc.)`;

    return { content: [{ type: 'text', text }] };
  }
);

// ─── Tool: get_capabilities ─────────────────────────────────────────────────

server.tool(
  'get_capabilities',
  'List available AI generation capabilities (text-to-video, image-to-video, lip-sync, TTS, etc.) with recommended models for each.',
  {
    query: z.string().optional().describe('Filter capabilities by keyword'),
  },
  async ({ query }) => {
    let caps = loadCapabilities();
    if (query) caps = caps.filter(c => matchesQuery(c, query));
    if (caps.length === 0) {
      return { content: [{ type: 'text', text: 'No capabilities found matching your query.' }] };
    }
    return {
      content: [{
        type: 'text',
        text: caps.map(c => yaml.dump(c, { lineWidth: 120 })).join('\n---\n'),
      }],
    };
  }
);

// ─── Tool: get_model_detail ─────────────────────────────────────────────────

server.tool(
  'get_model_detail',
  'Get complete detailed information about a specific AI model including official vendor documentation, all specs, API endpoints (fal.ai, Replicate, direct), pricing, prompt tips, and usage examples.',
  {
    model_name: z.string().describe('Model name or ID (e.g. "kling-3-pro", "flux-2-max", "veo-3.1")'),
  },
  async ({ model_name }) => {
    const allModels = loadAllModels();
    const pool = [...allModels.video, ...allModels.image];
    const n = model_name.toLowerCase().replace(/[\s_-]+/g, '');
    const model = pool.find(m => {
      const mid = (m.id || '').toLowerCase().replace(/[\s_-]+/g, '');
      const mname = (m.name || '').toLowerCase().replace(/[\s_-]+/g, '');
      return mid.includes(n) || mname.includes(n) || n.includes(mid) || n.includes(mname);
    });

    if (!model) {
      return { content: [{ type: 'text', text: `Model "${model_name}" not found. Use query_models to search available models.` }] };
    }

    const sections = [];

    // Official documentation — shown first and prominently
    if (model.official_documentation) {
      const od = model.official_documentation;
      const docLines = [`## Official Documentation for ${model.name}`];
      if (od.vendor_docs) docLines.push(`- **Vendor Docs**: ${od.vendor_docs}`);
      if (od.api_reference) docLines.push(`- **API Reference**: ${od.api_reference}`);
      if (od.pricing_page) docLines.push(`- **Pricing**: ${od.pricing_page}`);
      if (od.changelog) docLines.push(`- **Changelog**: ${od.changelog}`);
      sections.push(docLines.join('\n'));
    }

    // Full model details
    sections.push(`## Full Model Details\n${yaml.dump(model, { lineWidth: 120 })}`);

    return {
      content: [{ type: 'text', text: sections.join('\n\n') }],
    };
  }
);

// ─── Tool: get_failure_taxonomy ─────────────────────────────────────────────

server.tool(
  'get_failure_taxonomy',
  'Get the canonical AI-video failure-signature taxonomy. Spine: arXiv 2511.18102 "Spotlight" (6 base categories) + V4 extensions (identity_drift, lipsync_drift, text_garble). Used to ground judge findings in a consistent taxonomy_id across all models.',
  {
    category: z.string().optional().describe('Optional taxonomy_id to fetch a single category (e.g. "identity_drift", "physics", "anatomy")'),
  },
  async ({ category }) => {
    const tax = loadFailureTaxonomy();
    if (category) {
      const entry = (tax.categories || []).find(c => c.id === category);
      if (!entry) {
        return { content: [{ type: 'text', text: `Taxonomy category "${category}" not found. Available ids: ${(tax.categories || []).map(c => c.id).join(', ')}` }] };
      }
      return { content: [{ type: 'text', text: yaml.dump(entry, { lineWidth: 120 }) }] };
    }
    return {
      content: [{
        type: 'text',
        text: `# Failure-Signature Taxonomy (${(tax.categories || []).length} categories)\n` +
              `Source: ${tax.spine_source || 'V4 internal'}\n\n` +
              yaml.dump(tax, { lineWidth: 120 })
      }]
    };
  }
);

// ─── Tool: get_failure_signatures_for_model ─────────────────────────────────

server.tool(
  'get_failure_signatures_for_model',
  'Get the documented failure_signatures (taxonomy_id, severity, fix_strategy) for a specific model. Used pre-flight to write prompts that avoid known model weaknesses, or by judges to verify their findings against documented modes.',
  {
    model_name: z.string().describe('Model id or name (e.g. "kling-3-pro", "veo-3.1", "omnihuman-1.5")'),
    category: z.string().optional().describe('Filter to one taxonomy_id (e.g. "identity_drift")'),
  },
  async ({ model_name, category }) => {
    const allModels = loadAllModels();
    const pool = [...allModels.video, ...allModels.image, ...(allModels.audio || []), ...(allModels.utility || [])];
    const n = model_name.toLowerCase().replace(/[\s_-]+/g, '');
    const model = pool.find(m => {
      const mid = (m.id || '').toLowerCase().replace(/[\s_-]+/g, '');
      const mname = (m.name || '').toLowerCase().replace(/[\s_-]+/g, '');
      return mid.includes(n) || mname.includes(n) || n.includes(mid) || n.includes(mname);
    });
    if (!model) {
      return { content: [{ type: 'text', text: `Model "${model_name}" not found.` }] };
    }
    let sigs = Array.isArray(model.failure_signatures) ? model.failure_signatures : [];
    if (category) sigs = sigs.filter(s => s.taxonomy_id === category);
    if (sigs.length === 0) {
      return { content: [{ type: 'text', text: `No failure_signatures documented for ${model.id}${category ? ` (category=${category})` : ''}.` }] };
    }
    return {
      content: [{
        type: 'text',
        text: `# Failure Signatures — ${model.name} (${model.id})\n${sigs.length} signatures${category ? ` in category=${category}` : ''}\n\n` +
              yaml.dump(sigs, { lineWidth: 120 })
      }]
    };
  }
);

// ─── Tool: get_prestige_references ──────────────────────────────────────────

server.tool(
  'get_prestige_references',
  'Get prestige reference entries (Cannes Lions, Higgsfield Original Series, prestige TV/film) keyed by genre, style_category, format, or AI-native filter. Use during Create Mode screenplay architecture to ground style decisions in canonical references.',
  {
    genre: z.string().optional().describe('e.g. "commercial", "drama", "thriller"'),
    style_category: z.string().optional().describe('e.g. "anthemic_epic", "verite_intimate", "hand_doodle_animated"'),
    format: z.enum(['commercial', 'prestige-tv', 'prestige-film', 'ai-native-shorts', 'all']).optional().describe('Filter by reference format'),
    ai_native: z.boolean().optional().describe('Filter to AI-generated references only'),
    limit: z.number().optional().describe('Max entries to return (default 5)'),
  },
  async ({ genre, style_category, format, ai_native, limit = 5 }) => {
    let refs = loadReferences();
    if (genre) refs = refs.filter(r => r.genre === genre || (Array.isArray(r.style_categories) && r.style_categories.some(s => s.toLowerCase().includes(genre.toLowerCase()))));
    if (style_category) refs = refs.filter(r => r.style_category === style_category || (Array.isArray(r.style_categories) && r.style_categories.includes(style_category)));
    if (format && format !== 'all') refs = refs.filter(r => r.format === format);
    if (ai_native === true) refs = refs.filter(r => r.ai_native === true);
    if (ai_native === false) refs = refs.filter(r => r.ai_native !== true);

    if (refs.length === 0) {
      return { content: [{ type: 'text', text: 'No prestige references match those filters.' }] };
    }
    const slice = refs.slice(0, limit);
    return {
      content: [{
        type: 'text',
        text: `# Prestige References (${slice.length} of ${refs.length} matching)\n\n` +
              slice.map(r => yaml.dump(r, { lineWidth: 120 })).join('\n---\n')
      }]
    };
  }
);

// ─── Tool: get_v4_beat_recipe ───────────────────────────────────────────────

server.tool(
  'get_v4_beat_recipe',
  'Get the canonical V4 production recipe for a beat type — primary model, fallback chain, prompt allocation, expected duration, common failure modes, prestige references. Source of truth for V4-pipeline decisions in Create Mode.',
  {
    beat_type: z.string().describe('V4 beat type (e.g. "TALKING_HEAD_CLOSEUP", "ACTION_NO_DIALOGUE", "INSERT_SHOT")'),
  },
  async ({ beat_type }) => {
    const recipes = loadV4BeatRecipes();
    const target = beat_type.toUpperCase();
    const recipe = recipes.find(r => (r.beat_type || '').toUpperCase() === target);
    if (!recipe) {
      const known = recipes.map(r => r.beat_type).filter(Boolean);
      return {
        content: [{
          type: 'text',
          text: `No recipe found for beat_type="${beat_type}". Known beat types:\n${known.map(b => `  - ${b}`).join('\n')}`
        }]
      };
    }
    return {
      content: [{
        type: 'text',
        text: `# V4 Beat Recipe — ${recipe.beat_type}\n\n` + yaml.dump(recipe, { lineWidth: 120 })
      }]
    };
  }
);

// ─── Start Server ───────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
