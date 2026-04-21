// services/v4/GeminiJsonRepair.js
//
// Shared JSON-repair chain for Gemini responses. Gemini 3 Flash has three known
// defect modes on long JSON outputs (20-30KB+) that fall outside responseMimeType
// enforcement:
//
//   1. Raw LF/CR/TAB characters INSIDE string values (e.g. paragraph breaks in
//      a 500+ word season_bible). JSON forbids these — they must be escaped.
//   2. Trailing commas before } or ] in long arrays.
//   3. Trailing garbage after the JSON body (markdown fences, commentary).
//
// Callers:
//   - BrandStoryService._parseGeminiJson (storyline, subject, persona,
//     legacy scene generation)
//   - VertexGemini.callVertexGeminiJson (V4 screenplay + every other V4 LLM call)
//
// Keep this file dependency-free (no winston, no imports). It's a pure repair
// utility — both callers log around it in their own voice.

/**
 * Walk a JSON-ish text and escape raw LF / CR / TAB (and other 0x00-0x1F
 * control chars) that appear INSIDE string values. Whitespace OUTSIDE strings
 * (between structural tokens) is preserved as-is so the JSON layout itself is
 * unchanged.
 *
 * @param {string} text
 * @returns {string}
 */
export function escapeRawControlCharsInJsonStrings(text) {
  const out = [];
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escape) {
      out.push(c);
      escape = false;
      continue;
    }
    if (c === '\\' && inString) {
      out.push(c);
      escape = true;
      continue;
    }
    if (c === '"') {
      out.push(c);
      inString = !inString;
      continue;
    }
    if (inString) {
      const code = c.charCodeAt(0);
      if (c === '\n') { out.push('\\n'); continue; }
      if (c === '\r') { out.push('\\r'); continue; }
      if (c === '\t') { out.push('\\t'); continue; }
      if (c === '\b') { out.push('\\b'); continue; }
      if (c === '\f') { out.push('\\f'); continue; }
      if (code < 0x20) {
        out.push('\\u' + code.toString(16).padStart(4, '0'));
        continue;
      }
    }
    out.push(c);
  }
  return out.join('');
}

/**
 * Find the matching close of the first structural brace and truncate trailing
 * garbage (commentary, markdown fences, second JSON blocks) after it. Returns
 * the trimmed text if a match was found AND extra bytes existed past it; else
 * returns the input unchanged.
 *
 * @param {string} text
 * @returns {string}
 */
export function truncateToFirstBalancedObject(text) {
  const startChar = text[0];
  if (startChar !== '{' && startChar !== '[') return text;
  const openChar = startChar;
  const closeChar = startChar === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;
  let endIdx = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === openChar) depth++;
    else if (c === closeChar) {
      depth--;
      if (depth === 0) { endIdx = i; break; }
    }
  }
  if (endIdx === -1 || endIdx === text.length - 1) return text;
  return text.slice(0, endIdx + 1);
}

/**
 * Strip trailing commas before } or ].
 *
 * @param {string} text
 * @returns {string}
 */
export function stripTrailingCommas(text) {
  return text.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Parse Gemini's JSON output with defensive repairs for the three known defect
 * modes. Returns the parsed object on success. Throws a SyntaxError (possibly
 * the original JSON.parse error or one wrapping it) on unrecoverable input.
 *
 * @param {string} raw
 * @returns {any}
 */
export function parseGeminiJson(raw) {
  let text = (raw || '').trim();

  // Strip markdown code fences if present
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  // 1) Fast path — well-formed response
  try { return JSON.parse(text); } catch (_) { /* fall through */ }

  // 2) Brace-match truncate — strip trailing garbage after the JSON body
  if (text[0] !== '{' && text[0] !== '[') {
    throw new SyntaxError(`parseGeminiJson: response does not start with { or [ (starts with '${text[0] || 'EOF'}')`);
  }
  const truncated = truncateToFirstBalancedObject(text);
  if (truncated !== text) {
    try { return JSON.parse(truncated); } catch (_) { text = truncated; }
  }

  // 3) String-aware control-char escape — the #1 Gemini defect on long text fields
  const escaped = escapeRawControlCharsInJsonStrings(text);
  try { return JSON.parse(escaped); } catch (err3) {
    // 4) Trailing-comma strip — last-ditch for long arrays
    const noTrailingCommas = stripTrailingCommas(escaped);
    if (noTrailingCommas !== escaped) {
      try { return JSON.parse(noTrailingCommas); } catch (_) { /* fall through */ }
    }
    throw err3;
  }
}

export default { parseGeminiJson, escapeRawControlCharsInJsonStrings, truncateToFirstBalancedObject, stripTrailingCommas };
