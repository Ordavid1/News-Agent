/**
 * HybridTemplateEngine — Orchestrates premium playable ad generation.
 *
 * Pipeline:
 *   1. Load template game.js + shared modules
 *   2. Generate JSON config via Gemini Flash
 *   3. Validate config against schema.json
 *   4. If validation fails, merge partial config with defaults.json
 *   5. Compile: shared modules + template code + config → final JavaScript
 *
 * This runs alongside the existing PlayableContentService AI-generation path.
 * The PlayableContentService calls into this engine when generation_mode === 'hybrid'.
 */

import winston from 'winston';
import {
  compile,
  loadTemplateSchema,
  loadTemplateDefaults,
  listTemplateIds
} from './TemplateRenderer.js';
import {
  validateConfig,
  mergeWithDefaults,
  applyBrandColorsToDefaults
} from './ConfigValidator.js';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[HybridTemplateEngine] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

// Template version — increment when template code changes to enable versioning
const TEMPLATE_VERSION = '1.0.0';

class HybridTemplateEngine {
  constructor() {
    logger.info('HybridTemplateEngine initialized');
  }

  /**
   * Get the current template version string.
   */
  getTemplateVersion() {
    return TEMPLATE_VERSION;
  }

  /**
   * Build the AI prompt for generating a JSON config (NOT game code).
   *
   * @param {string} templateId   Template identifier
   * @param {object} assetManifest  Brand kit asset manifest
   * @param {object} brandKit       Full brand kit data
   * @param {object} opts           { title, ctaUrl, storyOptions }
   * @returns {string}              Prompt for Gemini
   */
  buildConfigPrompt(templateId, assetManifest, brandKit, opts) {
    const { title, ctaUrl, storyOptions } = opts;
    const schema = loadTemplateSchema(templateId);
    const defaults = loadTemplateDefaults(templateId);

    // Available assets
    const assetLines = [];
    assetManifest.sprites.forEach((s, i) => {
      assetLines.push(`  - sprite_${i}: ${s.description || s.type} (${s.type})`);
    });
    assetManifest.logos.forEach((l, i) => {
      assetLines.push(`  - logo_${i}: ${l.description || 'brand logo'} (logo)`);
    });

    // Color palette
    const colorLines = assetManifest.palette.map(c => `  - ${c.usage}: ${c.hex} (${c.name})`);

    // Schema description for AI
    const schemaDescription = this._describeSchema(schema);

    const storyDirection = storyOptions?.direction || '';

    return `You are a creative director for interactive brand advertisements. Generate a JSON configuration object that customizes a playable ad template for a specific brand.

TEMPLATE: ${schema.templateName || templateId}
TEMPLATE DESCRIPTION: ${schema.description || ''}
GAME TITLE: ${title || 'Brand Experience'}
CTA URL: ${ctaUrl || ''}

BRAND CONTEXT:
- Brand Summary: ${assetManifest.brandSummary || 'A modern brand'}
- Mood: ${assetManifest.style?.mood || 'professional and engaging'}
- Aesthetic: ${assetManifest.style?.overall_aesthetic || 'clean and modern'}
- Visual Motifs: ${assetManifest.style?.visual_motifs || 'none specified'}
${storyDirection ? `- Story Direction: ${storyDirection}` : ''}

AVAILABLE ASSETS (use these exact keys in asset mapping):
${assetLines.length > 0 ? assetLines.join('\n') : '  - No image assets available'}

BRAND COLOR PALETTE:
${colorLines.length > 0 ? colorLines.join('\n') : '  - primary: #6366F1\n  - secondary: #1E293B\n  - accent: #F59E0B\n  - background: #F8FAFC'}

CONFIGURATION SCHEMA — generate a JSON object with these sections:
${schemaDescription}

DEFAULTS (for reference — override with creative, brand-appropriate values):
${JSON.stringify(defaults, null, 2)}

GUIDELINES:
1. Use the brand's actual colors from the palette above — do NOT use the defaults.
2. Write engaging, brand-relevant text (titles, encouragement messages, CTA text).
3. Map brand assets to game roles creatively (e.g., brand products as collectibles).
4. Adjust gameplay parameters for fun — not too easy, not too hard.
5. Choose theme options that match the brand's mood and aesthetic.
6. All text should be concise (fits on a 640x960 mobile screen).
7. Encouragement messages should be enthusiastic and varied.

Return ONLY a valid JSON object. No markdown fences. No explanation. No comments.`;
  }

  /**
   * Generate the final compiled game code from template + config.
   *
   * @param {string} templateId   Template identifier
   * @param {object} rawConfig    AI-generated config (may be partial/invalid)
   * @param {object} brandColors  { primary, secondary, accent, background }
   * @returns {{ gameCode: string, config: object, usedDefaults: boolean, validationErrors: string[] }}
   */
  compileTemplate(templateId, rawConfig, brandColors) {
    const schema = loadTemplateSchema(templateId);
    const defaults = loadTemplateDefaults(templateId);

    let finalConfig;
    let usedDefaults = false;
    let validationErrors = [];

    if (rawConfig && typeof rawConfig === 'object') {
      // Validate the AI-generated config
      const validation = validateConfig(rawConfig, schema);
      validationErrors = validation.errors;

      if (validation.valid) {
        // Valid config — merge with defaults to fill any optional gaps
        finalConfig = mergeWithDefaults(validation.sanitized, defaults);
        logger.info(`Template ${templateId}: AI config validated successfully`);
      } else {
        // Partially valid — merge what we can with defaults
        logger.warn(`Template ${templateId}: config validation errors: ${validation.errors.join('; ')}`);
        finalConfig = mergeWithDefaults(rawConfig, defaults);
        usedDefaults = true;
      }
    } else {
      // No usable AI config — use defaults with brand colors
      logger.warn(`Template ${templateId}: no valid AI config, using branded defaults`);
      finalConfig = applyBrandColorsToDefaults(defaults, brandColors);
      usedDefaults = true;
    }

    // Compile the final game JS
    const gameCode = compile(templateId, finalConfig);

    return {
      gameCode,
      config: finalConfig,
      usedDefaults,
      validationErrors
    };
  }

  /**
   * Parse JSON from Gemini response, handling common issues.
   */
  parseConfigResponse(rawText) {
    let text = rawText.trim();

    // Remove markdown fences if present
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      text = fenceMatch[1].trim();
    } else if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '').trim();
    }

    // Remove trailing commas (common AI JSON error)
    text = text.replace(/,\s*([}\]])/g, '$1');

    try {
      return JSON.parse(text);
    } catch (err) {
      logger.error(`Failed to parse AI config JSON: ${err.message}`);
      logger.error(`Raw text (first 500 chars): ${text.substring(0, 500)}`);
      return null;
    }
  }

  /**
   * Get available hybrid templates.
   * @returns {string[]}
   */
  getAvailableTemplateIds() {
    try {
      return listTemplateIds();
    } catch {
      return [];
    }
  }

  // ── Internal helpers ──────────────────────────────────────

  /**
   * Produce a human-readable description of the schema for the AI prompt.
   */
  _describeSchema(schema) {
    const lines = [];
    const sections = schema.sections || {};

    for (const [sectionKey, sectionDef] of Object.entries(sections)) {
      lines.push(`\n"${sectionKey}": ${sectionDef.description || ''}`);

      if (sectionDef.properties) {
        for (const [propKey, propDef] of Object.entries(sectionDef.properties)) {
          let desc = `  "${propKey}": (${propDef.type})`;
          if (propDef.description) desc += ` �� ${propDef.description}`;
          if (propDef.enum) desc += ` [options: ${propDef.enum.join(', ')}]`;
          if (propDef.min !== undefined) desc += ` [min: ${propDef.min}]`;
          if (propDef.max !== undefined) desc += ` [max: ${propDef.max}]`;
          if (propDef.required) desc += ' (REQUIRED)';
          lines.push(desc);
        }
      }
    }

    return lines.join('\n');
  }
}

export default HybridTemplateEngine;
