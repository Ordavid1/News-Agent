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
  };
}

function loadWorkflows() {
  return loadYamlDir(path.join(__dirname, 'data/workflows'));
}

function loadCapabilities() {
  return loadYamlDir(path.join(__dirname, 'data/capabilities'));
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
    pool = [...models.video, ...models.image];
  } else if (type === 'video') {
    pool = models.video;
  } else if (type === 'image') {
    pool = models.image;
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
  'Search and filter AI video/image generation models by type, capability, provider, or free-text query. Returns detailed specs including resolution, duration, pricing, API endpoints, official vendor documentation links, and strengths.',
  {
    type: z.enum(['video', 'image', 'all']).optional().describe('Filter by model type'),
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

// ─── Start Server ───────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
