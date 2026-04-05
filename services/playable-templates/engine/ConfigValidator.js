/**
 * ConfigValidator — JSON Schema validation for template configs.
 *
 * Validates AI-generated configuration objects against per-template schemas.
 * Provides detailed error messages and a merge-with-defaults fallback.
 */

/**
 * Validate a config object against a schema.
 * @param {object} config    The AI-generated config to validate
 * @param {object} schema    JSON Schema-like definition from schema.json
 * @returns {{ valid: boolean, errors: string[], sanitized: object }}
 */
export function validateConfig(config, schema) {
  const errors = [];

  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['Config must be a non-null object'], sanitized: {} };
  }

  const sanitized = {};

  // Walk top-level required sections
  const sections = schema.sections || {};
  for (const [sectionKey, sectionDef] of Object.entries(sections)) {
    if (!config[sectionKey]) {
      if (sectionDef.required) {
        errors.push(`Missing required section: ${sectionKey}`);
      }
      continue;
    }

    sanitized[sectionKey] = {};
    const sectionConfig = config[sectionKey];

    if (sectionDef.type === 'object' && sectionDef.properties) {
      for (const [propKey, propDef] of Object.entries(sectionDef.properties)) {
        const value = sectionConfig[propKey];

        if (value === undefined || value === null) {
          if (propDef.required) {
            errors.push(`Missing required property: ${sectionKey}.${propKey}`);
          }
          continue;
        }

        // Type checking
        const validType = _checkType(value, propDef.type);
        if (!validType) {
          errors.push(`${sectionKey}.${propKey} expected type '${propDef.type}', got '${typeof value}'`);
          continue;
        }

        // Range checking for numbers
        if (propDef.type === 'number') {
          if (propDef.min !== undefined && value < propDef.min) {
            errors.push(`${sectionKey}.${propKey} must be >= ${propDef.min} (got ${value})`);
            continue;
          }
          if (propDef.max !== undefined && value > propDef.max) {
            errors.push(`${sectionKey}.${propKey} must be <= ${propDef.max} (got ${value})`);
            continue;
          }
        }

        // String length / pattern
        if (propDef.type === 'string') {
          if (propDef.maxLength && value.length > propDef.maxLength) {
            sanitized[sectionKey][propKey] = value.substring(0, propDef.maxLength);
            continue;
          }
          if (propDef.pattern && !new RegExp(propDef.pattern).test(value)) {
            errors.push(`${sectionKey}.${propKey} doesn't match pattern: ${propDef.pattern}`);
            continue;
          }
        }

        // Enum
        if (propDef.enum && !propDef.enum.includes(value)) {
          errors.push(`${sectionKey}.${propKey} must be one of: ${propDef.enum.join(', ')}`);
          continue;
        }

        // Array validation
        if (propDef.type === 'array') {
          if (!Array.isArray(value)) {
            errors.push(`${sectionKey}.${propKey} must be an array`);
            continue;
          }
          if (propDef.maxItems && value.length > propDef.maxItems) {
            sanitized[sectionKey][propKey] = value.slice(0, propDef.maxItems);
            continue;
          }
        }

        sanitized[sectionKey][propKey] = value;
      }
    } else {
      // Passthrough for non-object sections
      sanitized[sectionKey] = sectionConfig;
    }
  }

  return { valid: errors.length === 0, errors, sanitized };
}

/**
 * Merge AI-generated config with defaults, filling any missing values.
 * @param {object} config   AI-generated (possibly partial) config
 * @param {object} defaults Template defaults from defaults.json
 * @returns {object}        Complete config with all required fields populated
 */
export function mergeWithDefaults(config, defaults) {
  if (!config || typeof config !== 'object') return { ...defaults };
  return _deepMerge(defaults, config);
}

/**
 * Apply brand kit colors to defaults when AI config fails entirely.
 * @param {object} defaults  Template defaults
 * @param {object} brandKit  Asset manifest colors
 * @returns {object}         Defaults with brand colors applied
 */
export function applyBrandColorsToDefaults(defaults, brandColors) {
  const result = JSON.parse(JSON.stringify(defaults));

  if (result.colors) {
    if (brandColors.primary) result.colors.primary = brandColors.primary;
    if (brandColors.secondary) result.colors.secondary = brandColors.secondary;
    if (brandColors.accent) result.colors.accent = brandColors.accent;
    if (brandColors.background) result.colors.background = brandColors.background;
  }

  return result;
}

// ── Internal helpers ────────────────────────────────────────

function _checkType(value, expectedType) {
  switch (expectedType) {
    case 'string':  return typeof value === 'string';
    case 'number':  return typeof value === 'number' && !isNaN(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array':   return Array.isArray(value);
    case 'object':  return typeof value === 'object' && value !== null && !Array.isArray(value);
    default: return true;
  }
}

function _deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] === undefined || source[key] === null) continue;

    if (
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      result[key] = _deepMerge(result[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
