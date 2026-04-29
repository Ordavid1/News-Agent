// services/v4/CharacterSheetDirector.js
// V4 Phase 5 — persona-driven, arc-state-aware character sheet PROMPT generation.
//
// Replaces the static white-studio prompts in BrandStoryService._generateCharacterSheet
// (lines 2104-2122) with a Gemini-authored brief that weaves the FULL persona bible
// (archetype, wound, want, need, flaw, moral_code, personality, wardrobe_hint,
// relationship_to_subject, speech_patterns, voice_brief) into image-generation
// language, conditioned by story (genre, tone) and brand (mood, palette).
//
// Variant strategy (per arc state):
//   • single-episode story → 1 variant (act1 only)
//   • multi-episode supporting persona → 2 variants (act1 + act3)
//   • multi-episode principal persona → 3 variants (act1 + act2_pivot + act3)
//
// The wardrobe_hint is the IDENTITY ANCHOR — preserved verbatim across all variants.
// The face / body / build is preserved across variants. What CHANGES per variant:
//   • emotional state in eyes / mouth / posture (wound dormant → exposed)
//   • wardrobe wear / styling (creased / disheveled in late acts)
//   • ambient context tone (hopeful → fated)
//
// Cached by hash(persona_id + arc_state + story_genre + brand_mood). Re-runs only
// when persona archetype/wound/wardrobe/genre/mood change.

import crypto from 'crypto';
import winston from 'winston';
import { callVertexGeminiJson } from './VertexGemini.js';
import {
  renderVisualAnchorAsConstraintBlock,
  validateFluxPromptAgainstAnchor,
  VisualAnchorInversionError
} from './PersonaVisualAnchor.js';
import {
  isStylizedStrong,
  isNonPhotorealStyle,
  resolveStyleCategory
} from './CreativeBriefDirector.js';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) =>
      `[CharacterSheetDirector] ${timestamp} [${level}]: ${message}`
    )
  ),
  transports: [new winston.transports.Console()]
});

// ─────────────────────────────────────────────────────────────────────
// Feature flags
// ─────────────────────────────────────────────────────────────────────

export function isEnabled() {
  // Default ON (Phase 5 GA, 2026-04-28). Set BRAND_STORY_CHARACTER_SHEET_DIRECTOR=false
  // to revert to the legacy hardcoded white-studio prompts.
  return String(process.env.BRAND_STORY_CHARACTER_SHEET_DIRECTOR || 'true').toLowerCase() !== 'false';
}

/**
 * Variant policy, controlled by env BRAND_STORY_CHARACTER_SHEET_VARIANTS:
 *   '1'    → always emit one variant (legacy)
 *   '2'    → emit act1 + act3 for multi-episode stories
 *   '3'    → emit act1 + act2_pivot + act3 for multi-episode stories (max quality)
 *   'auto' (default when director is on): role-aware — 3 for principals, 2 for supporting, 1 for single-ep stories
 */
export function resolveVariantPolicy() {
  const raw = String(process.env.BRAND_STORY_CHARACTER_SHEET_VARIANTS || 'auto').toLowerCase();
  if (['1', '2', '3', 'auto'].includes(raw)) return raw;
  return 'auto';
}

/**
 * Decide which arc states to generate variants for, given the variant policy
 * and the persona's role + the story's planned episode count + genre.
 *
 * COMMERCIAL OVERRIDE (Phase 6, 2026-04-28): commercial spots are 30-60s with
 * 1-2 episodes — there is no act1→act3 emotional arc to span. Generating
 * different visual states of the persona (hopeful act1 vs broken act3) for a
 * 50-second commercial creates intra-episode identity drift (different beats
 * pull different sheets). For commercial we ALWAYS emit a single act1 sheet
 * regardless of variant policy. Catastrophic fix root cause from logs.txt
 * 2026-04-28 ("zero correlation between videos").
 *
 * @param {Object} params
 * @param {Object} params.persona      - persona bible
 * @param {Object} params.story        - { storyline?: { episodes? }, total_episodes?, subject? }
 * @param {boolean} params.isPrincipal - role classification (caller decides)
 * @returns {string[]}                 - subset of ['act1', 'act2_pivot', 'act3']
 */
export function resolveArcStatesForPersona({ persona, story, isPrincipal }) {
  // Phase 6 override — commercial gets a single sheet for visual stability
  const genre = String(story?.subject?.genre || story?.storyline?.genre || '').toLowerCase().trim();
  if (genre === 'commercial') return ['act1'];

  const policy = resolveVariantPolicy();
  const totalEpisodes =
    story?.total_episodes
    || story?.storyline?.episodes?.length
    || (Array.isArray(story?.storyline?.beats) ? 1 : 1);
  const isSingleEp = totalEpisodes <= 1;

  if (policy === '1' || isSingleEp) return ['act1'];
  if (policy === '2') return ['act1', 'act3'];
  if (policy === '3') return ['act1', 'act2_pivot', 'act3'];

  // auto: 3 for principals, 2 for supporting
  return isPrincipal ? ['act1', 'act2_pivot', 'act3'] : ['act1', 'act3'];
}

/**
 * Heuristic: a persona is "principal" if their dramatic_archetype is in the
 * lead-character set OR they are explicitly flagged. Caller can override.
 */
const PRINCIPAL_ARCHETYPES = new Set([
  'protagonist', 'antagonist', 'detective', 'mentor', 'lover', 'antihero',
  'fallen-hero', 'reluctant-hero', 'rebel', 'ingénue', 'ingenue', 'survivor'
]);

export function isPrincipalPersona(persona) {
  if (persona?.is_principal === true) return true;
  if (persona?.is_principal === false) return false;
  const arch = String(persona?.dramatic_archetype || persona?.archetype || '').toLowerCase().trim();
  return PRINCIPAL_ARCHETYPES.has(arch);
}

// ─────────────────────────────────────────────────────────────────────
// Cache key
// ─────────────────────────────────────────────────────────────────────

export function cacheKey({ persona, arcState, storyGenre, brandMood, styleCategory = '' }) {
  const norm = {
    persona_index: persona?.persona_index ?? null,
    name: persona?.name || persona?.avatar_name || null,
    archetype: persona?.dramatic_archetype || persona?.archetype || null,
    wound: persona?.wound || null,
    wardrobe_hint: persona?.wardrobe_hint || null,
    arcState,
    storyGenre: String(storyGenre || '').toLowerCase().trim(),
    brandMood: String(brandMood || '').toLowerCase().trim(),
    // V4 Phase 7 — style_category is part of the cache key so a brief
    // revision (style changed from hyperreal_premium to hand_doodle_animated)
    // generates a new sheet prompt instead of serving the cached photoreal one.
    styleCategory: String(styleCategory || '').toLowerCase().trim()
  };
  return crypto.createHash('sha256').update(JSON.stringify(norm)).digest('hex').slice(0, 16);
}

// ─────────────────────────────────────────────────────────────────────
// Prompt builder + Gemini call
// ─────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────
// V4 Phase 7 — STYLE GOVERNANCE
//
// CharacterSheetDirector's SYSTEM_PROMPT is calibrated for prestige live-action
// (motivated soft light, halation, painterly skin separation, 75-85mm portrait
// glass). When commercial_brief.style_category is non-photoreal, that
// vocabulary is wrong — a hand_doodle_animated commercial wants cel-shaded
// portraits, not soft-wrap halation. We append a STYLE GOVERNANCE block that
// tells Gemini which rendering language to use for the per-style preset.
//
// Identity layer (visual_anchor) is unchanged — gender, age, ethnicity,
// hair, skin from PersonaVisualAnchor remain the hard ground truth across
// styles. Style governs RENDERING LANGUAGE, not WHO the character is.
// ─────────────────────────────────────────────────────────────────────

function buildStyleGovernanceBlock(commercialBrief) {
  if (!commercialBrief) return '';
  const styleCategory = resolveStyleCategory(commercialBrief);
  if (!styleCategory) return '';
  const stylized = isStylizedStrong(commercialBrief);
  const nonPhoto = isNonPhotorealStyle(commercialBrief);
  if (!nonPhoto) {
    // Photoreal style — no governance change. The standard prompt's
    // soft-wrap / halation / 75-85mm language is correct.
    return '';
  }

  const PRESET_LANGUAGE = {
    hand_doodle_animated: 'cel-shaded portrait, Studio-Ghibli-style line work, flat shadow planes, ink-line edges, hand-drawn texture; 12fps stop-motion feel acceptable. NO photoreal skin separation, NO halation, NO soft-wrap key — those are live-action terms that fight cel-shaded grammar.',
    surreal_dreamlike:    'painterly portrait, soft impasto brushstrokes, dreamlike chiaroscuro, hand-rendered surface texture; visible artist hand. NOT photoreal. Treat the portrait as oil-on-canvas / gouache / painted-over-photo.',
    vaporwave_nostalgic:  '8mm film grain texture, magenta/teal cast as period artifact, soft halation read as analog (NOT optical realism), faded saturation, scanline-suggestive subtle banding. Live-action filmed but rendered through nostalgia signal — not naturalism.',
    painterly_prestige:   'oil-painting portrait, painterly skin separation as INTENT (visible brushwork is the look), warm umber shadow, cool linen highlight, classical composition. The painterly quality is the brief, not a bug.'
  };

  const presetLanguage = PRESET_LANGUAGE[styleCategory] || `non-photoreal commercial register: ${styleCategory}. Honor brief.visual_style_brief literally.`;

  return `

══════════════════════════════════════════════════════════
STYLE GOVERNANCE (V4 Phase 7) — commercial_brief.style_category = "${styleCategory}"
══════════════════════════════════════════════════════════
The persona bible's identity (gender / age / ethnicity / hair / skin from
visual_anchor when present) is HARD GROUND TRUTH across styles — never
override.

The RENDERING LANGUAGE in flux_prompt + seedream_prompt + negative_prompt
must follow the style preset below, NOT the prestige live-action defaults
in the principles above.

For ${styleCategory}: ${presetLanguage}

The wardrobe_hint stays as the IDENTITY ANCHOR (verbatim) — the wardrobe
ITEMS are preserved; their RENDERING shifts to the style preset (the same
green wool coat in cel-shaded ink-line vs. photoreal soft-falloff).

The face_anchor / wardrobe_anchor / environment_anchor in reference_attributes
stay structured the same way; the prose just describes the stylized variant
of the same character.
══════════════════════════════════════════════════════════
`;
}

const SYSTEM_PROMPT = `You are a Hollywood-grade director of cinematography writing the
character-sheet brief for a portrait artist (Flux 1.1 / Flux 2 Max). You receive a
persona bible and story context; you return a JSON object with three prompts:

  {
    "flux_prompt":      "<the full positive prompt for Flux>",
    "seedream_prompt":  "<a slightly shorter variant for Seedream Edit>",
    "negative_prompt":  "<what to AVOID — generic poses, glamour smiles, hard studio lights, theatrical grief, etc.>",
    "reference_attributes": {
      "face_anchor":        "<one-sentence description of the immutable facial features>",
      "wardrobe_anchor":    "<the wardrobe_hint preserved verbatim, possibly elaborated>",
      "environment_anchor": "<the lived-in environment that frames the portrait>"
    }
  }

CRAFT PRINCIPLES (apply in this order):

  1. The wardrobe_hint is the IDENTITY ANCHOR. Preserve it verbatim across every
     variant of this persona. You may elaborate it (e.g. add wear / creasing for
     act3) but the core garments + accessories must be unchanged.

  2. The wound drives the EYE PERFORMANCE. A detective with "lost his daughter
     to a hit-and-run" has a middle-distance unfocus, not a smile. An ingénue
     with "never told her sister she loved her" has a held breath behind every
     soft smile.

  3. The dramatic_archetype drives the LIGHTING + LENS. detective → motivated
     hard key + 35-50mm. ingénue → soft wrap + halation + 85mm. protagonist
     → balanced motivated key. antagonist → underlit / off-axis key.

  4. The personality (3 adjectives) drives the WARDROBE PALETTE. "rigid, loyal,
     brittle" → muted navy + grey. "open, unguarded, secretly grieving" →
     cream + warm gold.

  5. The relationship_to_subject drives the PROP / HAND placement. "owns the
     company" → hand on product. "encounters product as gift" → product nearby
     but not yet picked up. "tool of the work, reluctant" → product on a desk
     behind them.

  6. The story genre drives the BACKGROUND ENVIRONMENT. Noir → wet-street neon.
     Drama → motivated practical interior. Romance → sun-flooded window. The
     environment is part of the portrait, not a backdrop.

  7. The brand mood adds ONE color accent in wardrobe (a watch, a scarf, a tie),
     never repaints the whole frame.

ARC-STATE DIFFERENCES (when generating multiple variants for the same persona):

  • act1: wound DORMANT. Body open, eyes engaged, wardrobe neat. The character
    has not yet been broken. Lighting motivated but soft. The portrait is "before".

  • act2_pivot (principals only): the moment of recognition. Wound EXPOSED but
    not yet metabolized. Body angled away, eyes locked on something off-camera,
    wardrobe slightly disheveled. Lighting begins to harden. The portrait is "during".

  • act3: wound EXPOSED + acknowledged. Body still, eyes wet or unfocused,
    wardrobe creased / weathered. Lighting hardens further or softens into
    resolve. The portrait is "after".

  Across all variants: face structure, hair, build, ethnicity are INVARIANT.
  Wardrobe ITEMS are invariant; their wear/styling shifts per variant.

OUTPUT: ONLY the JSON described above. No prose, no markdown, no commentary.
Vertical 9:16 framing is implicit — do NOT mention it in the prompt.`;

/**
 * Build the user prompt — packs the persona + story context into a single
 * brief Gemini can reason over.
 *
 * V4 Phase 5b — when persona has a `visual_anchor`, the constraint block is
 * prepended ABOVE the persona bible. Identity is non-negotiable; the bible
 * (archetype / wound / wardrobe / personality) is subordinate. Director Agent's
 * mandate: "Gemini's storyline-character description below is subordinate. Use
 * it for personality / wardrobe / context only. NEVER override the visual truth
 * above. Note `low_confidence_fields` — write AROUND them, do not fabricate."
 */
function buildUserPrompt({ persona, story, brandKit, arcState }) {
  const personality = Array.isArray(persona?.personality) ? persona.personality.join(', ') : (persona?.personality || '');
  const speech = persona?.speech_patterns || {};
  const voice = persona?.voice_brief || {};

  const visualAnchorBlock = persona?.visual_anchor
    ? `\n══════════════════════════════════════════════════════════
${renderVisualAnchorAsConstraintBlock(persona.visual_anchor)}
══════════════════════════════════════════════════════════
The persona bible below describes WHO THE CHARACTER IS DRAMATICALLY (archetype, wound, want, wardrobe, personality). It is SUBORDINATE to the visual truth above. Use it for character WORK, not for identity. NEVER override the visual truth.
\n`
    : '';

  return `${visualAnchorBlock}PERSONA BIBLE:
- Name:                 ${persona?.name || persona?.avatar_name || `Persona ${persona?.persona_index ?? ''}`.trim()}
- Dramatic archetype:   ${persona?.dramatic_archetype || persona?.archetype || 'unspecified'}
- Wound:                ${persona?.wound || '—'}
- Want:                 ${persona?.want || '—'}
- Need:                 ${persona?.need || '—'}
- Flaw:                 ${persona?.flaw || '—'}
- Moral code:           ${persona?.moral_code || '—'}
- Core contradiction:   ${persona?.core_contradiction || '—'}
- Personality (3 adj):  ${personality || '—'}
- Wardrobe hint:        ${persona?.wardrobe_hint || '—'}
- Relationship to subject: ${persona?.relationship_to_subject || '—'}
- Speech vocabulary:    ${speech?.vocabulary || '—'}
- Speech rhythm:        ${speech?.sentence_length || '—'}
- Voice color:          ${voice?.vocal_color || '—'}
- Voice power:          ${voice?.power || '—'}
- Existing description: ${persona?.appearance || persona?.description || '—'}

STORY CONTEXT:
- Genre:    ${story?.subject?.genre || story?.storyline?.genre || 'drama'}
- Tone:     ${story?.subject?.tone || story?.storyline?.tone || 'engaging'}
- Logline:  ${story?.storyline?.logline || story?.storyline?.theme || '—'}

BRAND CONTEXT:
- Brand summary: ${brandKit?.brand_summary || '—'}
- Brand mood:    ${brandKit?.style_characteristics?.mood || '—'}
- Brand aesthetic: ${brandKit?.style_characteristics?.overall_aesthetic || '—'}
- Brand palette: ${(brandKit?.color_palette || []).slice(0, 5).map(c => c.hex || c.name).filter(Boolean).join(', ') || '—'}

ARC STATE TO GENERATE: ${arcState}

Return the JSON brief now.`;
}

/**
 * Generate the per-arc-state image-prompt brief for a persona. Cached on disk
 * if storage is provided; otherwise just returned.
 *
 * @param {Object} params
 * @param {Object} params.persona     - persona bible
 * @param {Object} params.story       - story object
 * @param {Object} [params.brandKit]  - optional brand kit
 * @param {string} params.arcState    - 'act1' | 'act2_pivot' | 'act3'
 * @returns {Promise<{flux_prompt, seedream_prompt, negative_prompt, reference_attributes, model: string, cost_usd: number}>}
 */
export async function generateSheetPrompts({ persona, story, brandKit, arcState, commercialBrief = null }) {
  const userPrompt = buildUserPrompt({ persona, story, brandKit, arcState });
  logger.info(`generating ${arcState} sheet prompt for ${persona?.name || persona?.avatar_name || 'persona'}`);

  // V4 Phase 7 — style governance. Append the per-style preset language to
  // the system prompt so flux_prompt / seedream_prompt come back in the
  // target rendering style (cel-shaded / painterly / vaporwave / etc.) for
  // non-photoreal briefs. Photoreal briefs leave SYSTEM_PROMPT unchanged.
  // commercial_brief lives on story.commercial_brief; pass either form.
  const briefForStyle = commercialBrief || story?.commercial_brief || null;
  const styleBlock = buildStyleGovernanceBlock(briefForStyle);
  const systemPrompt = styleBlock ? (SYSTEM_PROMPT + styleBlock) : SYSTEM_PROMPT;

  let parsed;
  try {
    parsed = await callVertexGeminiJson({
      systemPrompt,
      userPrompt,
      config: { temperature: 0.7, maxOutputTokens: 4096 },
      timeoutMs: 60000
    });
  } catch (err) {
    logger.error(`Gemini call failed for ${arcState} sheet: ${err.message}`);
    throw new Error(`CharacterSheetDirector generation failed: ${err.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || !parsed.flux_prompt) {
    throw new Error('CharacterSheetDirector: Gemini returned no flux_prompt');
  }

  const fluxPrompt = String(parsed.flux_prompt);

  // V4 Phase 5b — post-emission inversion check (Director Agent mandate,
  // user-confirmed strict-halt path 2026-04-29).
  //
  // When persona.visual_anchor is set, validate that Gemini's emitted Flux
  // prompt does not invert the actor's gender or age range. Inversions are
  // HARD ERRORS that escalate to user_review — splicing a corrective hint
  // and proceeding is the silent-correction anti-pattern that produced the
  // cascading drift in story `77d6eaaf` (logs.txt 2026-04-28).
  //
  // Descriptor-class mismatches (ethnicity / hair / build) are NOT escalated
  // here — those are subtler and the splice-corrective-hint path remains
  // acceptable. The validator only flags the inversion class.
  if (persona?.visual_anchor) {
    const validation = validateFluxPromptAgainstAnchor(persona.visual_anchor, fluxPrompt);
    if (!validation.ok && validation.severity === 'inversion') {
      logger.error(
        `${arcState} sheet INVERSION on persona "${persona.name || 'unnamed'}" — ` +
        `inverted_axes=[${validation.inverted_axes.join(', ')}], ` +
        `evidence=${JSON.stringify(validation.evidence)}. Escalating to user_review.`
      );
      throw new VisualAnchorInversionError(
        `CharacterSheetDirector: Gemini's flux_prompt inverts the visual_anchor on axes [${validation.inverted_axes.join(', ')}]. ` +
        `This is an identity-drift hard error and must be resolved by the user. ` +
        `Evidence: ${validation.evidence.join('; ')}`,
        { invertedAxes: validation.inverted_axes, evidence: validation.evidence }
      );
    }
  }

  return {
    flux_prompt:        fluxPrompt,
    seedream_prompt:    String(parsed.seedream_prompt || fluxPrompt),
    negative_prompt:    String(parsed.negative_prompt || ''),
    reference_attributes: parsed.reference_attributes || {},
    model:              process.env.GEMINI_MODEL || 'gemini-3-flash-preview',
    cost_usd:           0.00  // ~free at sub-cent scale; calculated by Vertex if needed
  };
}

/**
 * Generate ALL arc-state variants for a persona in one call. Returns an object
 * keyed by arc state. Per-variant resilience (added 2026-04-28 after observing
 * intermittent Gemini "no flux_prompt" responses):
 *
 *   1. Each variant call is retried ONCE on failure (most failures are
 *      transient Gemini malformed-JSON / missing-key responses).
 *   2. If a non-act1 variant still fails, it falls back to a CLONE of the act1
 *      variant (with the arc-state label corrected) so downstream BeatRouter
 *      always finds a sheet for every arc_position it requests.
 *   3. Only if act1 itself fails entirely does the whole call throw — and the
 *      orchestrator then drops back to the legacy hardcoded sheets.
 *
 * @returns {{ variants: Object, isPrincipal: boolean, fallbacks: string[] }}
 */
export async function generateAllVariants({ persona, story, brandKit }) {
  const isPrincipal = isPrincipalPersona(persona);
  const arcStates = resolveArcStatesForPersona({ persona, story, isPrincipal });
  const variants = {};
  const fallbacks = [];

  // Try each variant with one retry on transient failure.
  // VisualAnchorInversionError is NOT a transient failure — it propagates
  // immediately to the orchestrator so the episode can be escalated to
  // user_review per the Director Agent's strict-halt mandate.
  for (const arcState of arcStates) {
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        variants[arcState] = await generateSheetPrompts({ persona, story, brandKit, arcState });
        lastErr = null;
        break;
      } catch (err) {
        if (err instanceof VisualAnchorInversionError) {
          // Identity inversion = hard halt. Do not retry, do not fallback to
          // act1-clone. Bubble up so BrandStoryService can mark the episode
          // awaiting_user_review.
          throw err;
        }
        lastErr = err;
        if (attempt === 1) {
          logger.warn(`${arcState} variant attempt 1 failed (${err.message}) — retrying once`);
        }
      }
    }
    if (lastErr) {
      logger.warn(`failed to generate ${arcState} variant after retry: ${lastErr.message}`);
    }
  }

  // Non-act1 variants that failed → clone act1 so BeatRouter never sees a hole.
  if (variants.act1) {
    for (const arcState of arcStates) {
      if (!variants[arcState]) {
        variants[arcState] = {
          ...variants.act1,
          // Keep the cloned brief recognizable in logs/UI; the prompt itself
          // is the act1 prompt (acceptable visual continuity sacrifice for
          // resilience — pipeline doesn't break).
          _fallback_from: 'act1'
        };
        fallbacks.push(arcState);
        logger.info(`${arcState} variant filled from act1 fallback (preserves pipeline continuity)`);
      }
    }
  }

  if (Object.keys(variants).length === 0) {
    throw new Error('CharacterSheetDirector: all variants failed (including act1)');
  }
  return { variants, isPrincipal, fallbacks };
}

// ─────────────────────────────────────────────────────────────────────
// Legacy fallback — used when Gemini fails OR when feature flag is off
// ─────────────────────────────────────────────────────────────────────

export function buildLegacyHardcodedSheets({ description, wardrobe, styleHint }) {
  return [
    {
      label: 'hero',
      prompt: `Cinematic film still portrait, full body shot, 3/4 front view at 45 degrees. ${description}. ${wardrobe ? 'Wearing: ' + wardrobe + '.' : ''} ${styleHint ? 'Style: ' + styleHint + '.' : ''} Hyperrealistic, soft wrap-around studio lighting, subtle rim light from behind, even full-body illumination, slight cinematic contrast. Eye-level camera, 85mm equivalent, sharp head-to-toe focus. Pure white seamless studio background, fully isolated character. 8K, sharp material textures, photographic quality. No text, no watermark.`,
      aspect: '9:16'
    },
    {
      label: 'closeup',
      prompt: `Close-up cinematic portrait, head and shoulders, looking directly at camera. ${description}. Dramatic shallow depth of field, catch-lights in eyes, warm skin tones, fine detail on skin texture and facial features. ${styleHint ? 'Style: ' + styleHint + '.' : ''} Soft studio lighting, slight rim light. White background. Photorealistic, 8K detail. No text, no watermark.`,
      aspect: '1:1'
    },
    {
      label: 'fullbody-side',
      prompt: `Full body pure side profile, 90 degree angle. ${description}. ${wardrobe ? 'Wearing: ' + wardrobe + '.' : ''} Standing tall, natural relaxed posture. Sharp head-to-toe focus, even studio lighting. White seamless background. Hyperrealistic, photographic quality. No text, no watermark.`,
      aspect: '9:16'
    }
  ];
}
