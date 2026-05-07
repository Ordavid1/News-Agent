// brandStoryPrompts.mjs
// Prompts for Brand Story video series — storyline generation, episode scene creation,
// and storyboard visual direction. Used by BrandStoryService with Gemini 3 Flash.

import { isHebrewLanguage, getLanguageInstruction } from './linkedInPrompts.mjs';

/**
 * V4 Phase 5b — render a persona's visual_anchor as a one-line description
 * that REPLACES the placeholder fallbacks (`'A compelling character'`, etc.)
 * Subtractive change per Director Agent's mandate: the placeholders literally
 * invited Gemini to fabricate. With Fix 1+2's contract, every persona has a
 * visual_anchor; this helper renders it.
 *
 * V4 Wave 6 / hotfix-2026-04-29 #2 — text-field fallback. When the anchor is
 * absent (described persona path with no photos, or extraction failed), the
 * old sentinel "DESCRIPTION_MISSING — escalate to user_review" caused Gemini
 * to short-circuit the entire storyline (logs 2026-04-29 story `fcb0b42b`:
 * title=undefined, 0 episodes). Falling back to the persona's own description
 * / appearance / personality text fields restores the legacy described-
 * persona path while keeping the anchor-grounded path for uploaded personas.
 *
 * @param {Object|null} anchor - visual_anchor record from PersonaVisualAnchor
 * @param {Object} [persona]   - the persona record (for text-field fallback when anchor is missing)
 * @returns {string}
 */
function _renderVisualAnchorAsDescription(anchor, persona = null) {
  if (!anchor || typeof anchor !== 'object' || !anchor.apparent_gender_presentation) {
    // Text-field fallback for described personas / failed extraction. Same
    // shape as the legacy persona block (description + appearance) so Gemini
    // gets a usable identity hint instead of an "escalate" directive.
    if (persona && typeof persona === 'object') {
      const fragments = [];
      const desc = String(persona.description || '').trim();
      if (desc) fragments.push(desc);
      const appearance = String(persona.appearance || persona.visual_description || '').trim();
      if (appearance && appearance !== desc) fragments.push(`appearance: ${appearance}`);
      if (fragments.length > 0) return fragments.join(' · ');
    }
    // No anchor and no text fields — emit the legacy permissive default
    // rather than the strict "escalate" sentinel. Lets Gemini build a
    // serviceable storyline; the wizard pre-flight at /generate-episode
    // (Fix 1+2 route validation) catches the truly-empty-persona case
    // before any model tokens are spent.
    return 'a character to be developed in the story';
  }
  const genderWord = {
    female: 'woman',
    male: 'man',
    androgynous: 'androgynous person',
    unknown: 'person'
  }[anchor.apparent_gender_presentation] || 'person';

  const fragments = [];
  if (anchor.apparent_age_range) fragments.push(anchor.apparent_age_range);
  fragments.push(genderWord);
  if (anchor.ethnicity_visual_descriptors) fragments.push(`(${anchor.ethnicity_visual_descriptors})`);
  if (anchor.hair_color || anchor.hair_length_style) {
    fragments.push(`hair: ${[anchor.hair_color, anchor.hair_length_style].filter(Boolean).join(', ')}`);
  }
  if (anchor.build) fragments.push(`build: ${anchor.build}`);
  if ((anchor.distinctive_features || []).length > 0) {
    fragments.push(`distinctive: ${anchor.distinctive_features.slice(0, 3).join(', ')}`);
  }
  if (anchor.energy_register) fragments.push(`energy: ${anchor.energy_register}`);
  if (anchor.micro_expression_baseline) fragments.push(`baseline: ${anchor.micro_expression_baseline}`);
  return fragments.filter(Boolean).join(' · ');
}

/**
 * V4 Phase 5b — ORDER OF AUTHORITY block, rendered at the TOP of the storyline
 * system prompt. Defines explicit precedence between competing imperatives so
 * Gemini knows which directive wins on conflict (Director Agent cross-cutting
 * concern #1). Without this, visual_anchor + brief.brand_world_lock + genre
 * register + director's hint + sonic series bible became a stack of louder
 * voices and the strongest writing would win — usually the director's hint.
 *
 * Generic. No genre-specific content. Always rendered when V4 personas have
 * visual_anchors (which by Fix 1+2's contract is always).
 */
function _buildOrderOfAuthorityBlock() {
  return `\n═══════════════════════════════════════════════════════════════
ORDER OF AUTHORITY (read FIRST — this is non-negotiable)
═══════════════════════════════════════════════════════════════
When the directives that follow conflict, this is the order of precedence —
the higher-listed directive ALWAYS wins:

  1. PERSONA VISUAL TRUTH (visual_anchor) — strongest. The actor's identity
     (gender, age range, ethnicity, distinctive features) is non-negotiable.
     You author the character's NAME, ROLE, ARC, PERSONALITY, WARDROBE,
     PROFESSION. You do NOT redefine WHO THE ACTOR IS. NEVER invert gender.
     NEVER write a child when the anchor says adult. NEVER write an elderly
     character when the anchor says 25-35. NEVER write a man when the anchor
     says woman. The actor is the actor.

  2. COMMERCIAL BRIEF / BRAND_WORLD_LOCK — when present (commercial genre),
     binding contract for visual signature, narrative grammar, and inheritance
     across episode 2.

  3. GENRE REGISTER — cinematic register law (lighting, contrast, lens, pace,
     palette norms for the active genre). Honor the register; treat exceptions
     as creative flavor on non-conflicting axes only.

  4. DIRECTOR'S HINT — creative flavor only. Hints inherit from craft references
     (e.g. "Deakins arid heat", "Bradford Young shadows") that may carry their
     own register cone. When the hint conflicts with the genre register on
     lighting / contrast / lens / pace / palette — HONOR THE GENRE REGISTER.
     Apply the hint only on its NON-CONFLICTING axes.

  5. SONIC SERIES BIBLE — audio register, not narrative. Does not override
     the four directives above.
═══════════════════════════════════════════════════════════════\n`;
}

// ============================================================
// STORYLINE GENERATION (full season arc from Brand Kit)
// ============================================================

/**
 * System prompt for generating a complete story arc / "season bible" from brand identity.
 * The LLM creates a narrative framework that drives an ongoing video series.
 *
 * @param {Object} brandKit - Brand Kit data (color_palette, style_characteristics, brand_summary, people, logos)
 * @param {Object} [options] - { directorsNotes, pipelineVersion }
 *   - pipelineVersion: 'v4' switches the calibration anchors (episode length, beat-grammar)
 *     to the V4 scene-graph reality (60-120s, 5-12 beats, on-camera dialogue). Anything else
 *     (or omitted) keeps the legacy v1/v2/v3 wording (10-15s narration-style episodes).
 * @returns {string} System prompt
 */
export function getStorylineSystemPrompt(brandKit = {}, options = {}) {
  const {
    directorsNotes = '',
    pipelineVersion = '',
    commercialBrief = null,
    // V4 Phase 5b — Fix 5. When the director's hint conflicts with the active
    // genre register on the five universal craft axes (lighting / contrast /
    // lens / pace / palette), the BrandStoryService coherence check splices a
    // GENRE-OVERRIDE NOTE block here. Renders ABOVE the director's hint so
    // Gemini reads the dampening directive before the hint itself. Empty
    // string when the hint is compatible OR the user explicitly opted in.
    directorsHintOverrideBlock = ''
  } = options;
  const isV4 = String(pipelineVersion).toLowerCase() === 'v4';
  const brandContextBlock = _buildBrandKitContextBlock(brandKit);

  const directorsBlock = directorsNotes
    ? `${directorsHintOverrideBlock}\nDIRECTOR'S CREATIVE VISION (from the brand owner — treat as your primary artistic brief):
"${directorsNotes}"
Interpret this as your cinematic north star. Let it shape the visual style, emotional register,
color palette choices, camera language, and narrative voice throughout the entire season.\n`
    : '';

  // Phase 6 (2026-04-28) — when a commercial brief is provided, prepend it as
  // the SUPREME directorial law. The brief was authored by CreativeBriefDirector
  // before storyline generation specifically so the storyline writer can build
  // around the creative_concept / visual_signature / narrative_grammar /
  // music_intent / brand_world_lock instead of producing a generic series bible.
  const commercialBriefBlock = commercialBrief
    ? _buildCommercialBriefBlock(commercialBrief)
    : '';

  // Pipeline-aware episode-grammar anchor — see plan
  // .claude/plans/regarding-this-infrastructure-i-magical-flame.md
  // V4 produces scene-graph episodes (~60-120s, 5-12 beats, on-camera dialogue);
  // v1/v2/v3 produce 10-15s narrator-driven shorts. Wrong anchor here mis-calibrates
  // the entire season bible (cliffhanger density, scene_plan beat counts, dialogue weight).
  const episodeGrammarLine = isV4
    ? `Each "episode" is a 60-120 second short-form video, built from 5-12 cinematic beats with on-camera dialogue, cuts, reactions, and B-roll — NOT a single static shot with narration.`
    : `Each "episode" is a 10-15 second short-form video that tells one scene of a larger story.`;

  const episodeGrammarNote = isV4
    ? `\nEPISODE GRAMMAR (V4): Episodes are scene-graphs (scenes → beats), with multiple characters speaking on-camera. Plan stakes, dialogue weight, and scene depth for ~60-120 seconds of screen time per episode.\n`
    : '';

  // V4 Phase 5b — ORDER OF AUTHORITY block. Rendered at the TOP of the system
  // prompt so Gemini reads it before any of the (often louder) downstream
  // imperatives. V4 only — legacy v1/v2/v3 stories don't yet enforce
  // visual_anchor as a contract.
  const orderOfAuthorityBlock = isV4 ? _buildOrderOfAuthorityBlock() : '';

  return `You are an award-winning screenwriter and brand storyteller who creates compelling short-form video series for social media (Reels, Stories, TikTok). You specialize in serialized brand narratives that hook viewers episode after episode.
${orderOfAuthorityBlock}${commercialBriefBlock}
YOUR TASK: Create a complete STORY BIBLE — a serialized narrative framework that will drive a continuing video series for a brand. ${episodeGrammarLine}${episodeGrammarNote}

STORYTELLING PRINCIPLES:
- Every great story has CONFLICT, STAKES, and TRANSFORMATION
- The story must subtly showcase the brand's product/subject without being a sales pitch
- Each episode must end with a micro-cliffhanger or revelation that makes viewers want the next one
- Characters must feel real — they have desires, flaws, and growth
- The product/subject is woven into the narrative as a natural element, never forced
- Visual storytelling: show, don't tell. Each scene must be visually distinct and cinematic
- Every series has an EMOTIONAL RHYTHM — not every episode is the same intensity. Plan the emotional arc deliberately: intrigue, warmth, tension, relief, heartbreak, triumph
- Establish RECURRING VISUAL MOTIFS — specific objects, colors, lighting patterns, or compositions that appear across episodes as visual signatures of the series

SHOWRUNNING PRINCIPLES (non-negotiable, genre-agnostic — apply before you draft any episode):
- Lock a CENTRAL DRAMATIC QUESTION the viewer will want answered by the finale. One sentence. This is the engine that pulls the audience through all episodes.
- Lock a THEMATIC ARGUMENT — the ONE claim this series is making about the world. Prestige TV always argues something: *The Bear* argues grief can coexist with growth; *Severance* argues the work-self and home-self are both incomplete; *Succession* argues legacy corrodes love. Without a thematic argument, episodes wander.
- Every episode must have a NARRATIVE_PURPOSE (why this episode exists for the SEASON) distinct from its NARRATIVE_BEAT (what happens in it). If you cannot name why an episode exists, cut it or combine it.
- Every episode must raise a DRAMATIC_QUESTION and end with that question *tilted* — not answered, not untouched. A tilted question is a cliffhanger done right.
- The ANTAGONIST_CURVE escalates: intensity rises on average across episodes, non-monotonically. A drop is allowed ONLY if it sets up the next escalation.
- Characters with similar archetypes in the same season MUST have different voices (vocabulary, sentence rhythm, tics, avoidance lists). Distinctness is a writing rule, not a hope.
- Genre is a container, not a content directive. Drama, Action, Comedy, Thriller, Mystery, Warm-Heart, Horror — they all obey the same rules above, just with different emotional registers.
${directorsBlock}${brandContextBlock}
You MUST respond with ONLY valid JSON (no markdown code fences, no extra text). The JSON must conform to the schema described in the user prompt.`;
}

/**
 * V4 Phase 6 (2026-04-28) — render the COMMERCIAL CREATIVE BRIEF authored by
 * CreativeBriefDirector as the SUPREME directorial law for the storyline +
 * screenplay layers. Every commercial story stage downstream of this block
 * must inherit the brief's vision (creative_concept, visual_signature,
 * narrative_grammar, music_intent, hero_image, brand_world_lock, anti_brief).
 *
 * Without this block, the brief is dead weight — generated and persisted but
 * never reaching Gemini. The result of THAT bug was incoherent commercials
 * (logs.txt 2026-04-28, "The Geometry of Light" / "The Sanctuary of Light").
 *
 * Rendered identically into the storyline system prompt AND episode (V4)
 * system prompt so both layers obey the same brief.
 *
 * @param {Object} brief - CreativeBriefDirector output
 * @returns {string} block to splice into the system prompt
 */
export function _buildCommercialBriefBlock(brief) {
  if (!brief || typeof brief !== 'object') return '';

  const lines = [
    '',
    '═══════════════════════════════════════════════════════════════════',
    'COMMERCIAL CREATIVE BRIEF — SUPREME DIRECTORIAL LAW. Override any',
    'instruction below that conflicts with this brief. The user is paying',
    'for a Cannes Lion-caliber spot, not a generic ad.',
    '═══════════════════════════════════════════════════════════════════'
  ];

  if (brief.creative_concept) {
    lines.push(`CREATIVE CONCEPT (the ONE idea this spot commits to):`);
    lines.push(`  "${brief.creative_concept}"`);
  }
  if (brief.visual_signature) {
    lines.push(`VISUAL SIGNATURE (an art director can re-quote this):`);
    lines.push(`  ${brief.visual_signature}`);
  }
  if (brief.style_category) {
    lines.push(`STYLE CATEGORY: ${brief.style_category}`);
  }
  if (brief.narrative_grammar) {
    lines.push(`NARRATIVE GRAMMAR: ${brief.narrative_grammar}`);
  }
  if (brief.emotional_arc) {
    lines.push(`EMOTIONAL ARC: ${brief.emotional_arc}`);
  }
  if (brief.hero_image) {
    lines.push(`HERO IMAGE (the single image to burn into the viewer's memory):`);
    lines.push(`  ${brief.hero_image}`);
  }
  if (brief.music_intent) {
    const mi = brief.music_intent;
    const miStr = typeof mi === 'string'
      ? mi
      : `vibe: ${mi.vibe || '—'}, instrumentation: ${mi.instrumentation || '—'}, drop at ${mi.drop_point_seconds ?? '—'}s`;
    lines.push(`MUSIC INTENT: ${miStr}`);
    lines.push(`  → The music drop lands ON the visual beat that earns it (product reveal / hero gesture / tagline). Plan the cliffhanger and beat density to honor that landing.`);
  }
  if (brief.cliffhanger_style) {
    lines.push(`CLIFFHANGER STYLE: ${brief.cliffhanger_style}`);
  }
  if (brief.visual_style_brief) {
    lines.push(`VISUAL STYLE BRIEF (carries DP-level direction — color, contrast, lighting, lens, grain, framing):`);
    lines.push(`  ${brief.visual_style_brief}`);
  }
  if (brief.brand_world_lock_if_two_eps) {
    lines.push(`BRAND WORLD LOCK (when count = 2 — ep2 inherits these from ep1 verbatim):`);
    lines.push(`  ${brief.brand_world_lock_if_two_eps}`);
  }
  if (Array.isArray(brief.reference_commercials) && brief.reference_commercials.length > 0) {
    lines.push(`REFERENCE SPOTS (match the bar of these): ${brief.reference_commercials.join(', ')}`);
  }
  if (brief.anti_brief) {
    lines.push(`ANTI-BRIEF (the cliché this spot REFUSES — DO NOT regress to this):`);
    lines.push(`  ${brief.anti_brief}`);
  }
  if (brief.episode_count_justification?.count) {
    lines.push(`EPISODE COUNT (locked by brief justification): ${brief.episode_count_justification.count}`);
    if (brief.episode_count_justification.reasoning) {
      lines.push(`  Reasoning: ${brief.episode_count_justification.reasoning}`);
    }
  }
  lines.push('═══════════════════════════════════════════════════════════════════');
  lines.push('');

  return lines.join('\n');
}

/**
 * Build a comprehensive Brand Kit context block used by BOTH the storyline prompt
 * and the episode prompt so Gemini maintains brand identity at every layer.
 * Exported so callers can embed it wherever brand context is needed.
 */
export function _buildBrandKitContextBlock(brandKit = {}) {
  if (!brandKit || Object.keys(brandKit).length === 0) return '';

  const sc = brandKit.style_characteristics || {};
  const colors = (brandKit.color_palette || []).slice(0, 6);
  const logos = (brandKit.logos || []).slice(0, 3);
  const people = (brandKit.people || []).slice(0, 4);

  const lines = ['\n═══════════════════════════════════════════════\nBRAND IDENTITY (from the user\'s Brand Kit — respect this across every episode):\n═══════════════════════════════════════════════'];

  if (brandKit.brand_summary) {
    lines.push(`Brand identity: ${brandKit.brand_summary}`);
  }
  if (sc.overall_aesthetic) lines.push(`Visual aesthetic: ${sc.overall_aesthetic}`);
  if (sc.mood) lines.push(`Brand mood: ${sc.mood}`);
  if (sc.photography_style) lines.push(`Photography style: ${sc.photography_style}`);
  if (sc.visual_motifs) lines.push(`Recurring visual motifs: ${sc.visual_motifs} (weave these into scene descriptions)`);
  if (sc.typography_hints) lines.push(`Typography style: ${sc.typography_hints}`);

  if (colors.length > 0) {
    const colorList = colors.map(c => `${c.hex || c.name || ''} (${c.usage || 'accent'})`).join(', ');
    lines.push(`Color palette: ${colorList} — use these colors in lighting, wardrobe, props, and environment descriptions`);
  }

  if (logos.length > 0) {
    const logoList = logos.map(l => l.description || 'brand mark').join('; ');
    lines.push(`Brand marks/logos: ${logoList} — consider placing subtly (on walls, packaging, signage) in at least some episodes`);
  }

  if (people.length > 0) {
    const peopleList = people.map(p => p.description).join('; ');
    lines.push(`Existing brand people (from brand assets): ${peopleList}`);
  }

  return lines.join('\n') + '\n═══════════════════════════════════════════════\n';
}

/**
 * User prompt for storyline generation — includes persona, subject, and brand context.
 *
 * @param {Object} persona - { description, appearance, voice_style, personality } or similar
 * @param {Object} subject - { name, category, description, key_features[], visual_description }
 * @param {Object} brandKit - Full brand kit data
 * @param {Object} [options] - { tone, genre, targetAudience, episodeCount }
 * @returns {string} User prompt
 */
export function getStorylineUserPrompt(personas, subject, brandKit = {}, options = {}) {
  const {
    tone = 'engaging',
    genre = 'drama',
    targetAudience = 'young professionals',
    episodeCount: episodeCountInput = 12,
    storyFocus = 'product',
    directorsNotes = '',
    pipelineVersion = '',
    commercialBrief = null
  } = options;
  const isV4 = String(pipelineVersion).toLowerCase() === 'v4';

  // Phase 6 (2026-04-28) — render the commercial brief as a USER-PROMPT preamble
  // (in addition to the system-prompt block) so it sits ABOVE the storyline
  // schema and explicitly instructs Gemini what episode_count, episodes[],
  // emotional_arc, visual_motifs, season_bible should reflect.
  const commercialBriefUserBlock = commercialBrief
    ? _buildCommercialBriefBlock(commercialBrief)
    : '';

  // ─── Genre-aware episode-count cap (Phase 6, 2026-04-28) ───
  //
  // Two existing forces in this prompt fight each other on episode count:
  //   1. The hard count: "Create a story bible for ${episodeCount} episodes"
  //   2. The soft override (SHOWRUNNING PRINCIPLES, system prompt): "If you cannot
  //      name why an episode exists, cut it or combine it."
  //
  // Force (2) was added during the screenwriting overhaul and lets Gemini drop
  // below the hard count when justification fails. That's correct for prestige
  // (12 → can shrink to 3 if the plot is tight). But for a 60-second commercial
  // spot, 12 is the wrong starting ceiling — the right ceiling is 1-2.
  //
  // Solution: make the cap genre-aware. For commercial we send a 1-2 cap with
  // explicit "default to 1, escalate to 2 only when justified" language. The
  // existing soft-override clause then naturally lands at 1 or 2.
  const isCommercial = String(genre || '').toLowerCase().trim() === 'commercial';
  const episodeCount = isCommercial
    ? Math.min(2, Math.max(1, Number(episodeCountInput) || 1))
    : episodeCountInput;
  const commercialCapNote = isCommercial
    ? `\n\nCOMMERCIAL EPISODE-COUNT CAP — HARD CEILING:
This is a COMMERCIAL VIDEO AD genre story. The cap is 1 OR 2 episodes — NEVER more.
  • DEFAULT to 1 episode (a single 60-second hero spot is sufficient for almost every commercial concept).
  • ESCALATE to 2 episodes ONLY when a second episode is creatively justified — a campaign of two
    independent angles (ep1 = 60s hero piece, ep2 = 30s angle / cutdown / counter-position) that
    SHARE a brand_world_lock (same LUT family, same casting, same signature optic) but each stand
    alone watchable. If the second episode is just "more of the same", combine into 1 instead.
  • Apply your SHOWRUNNING PRINCIPLE — "if you cannot name why an episode exists, cut it or combine it"
    — even more aggressively here. A commercial earns its second episode or it doesn't get it.
  • Justify your choice in the season_bible: name explicitly why count = 1 OR count = 2.

The episodes[] array MUST contain exactly ${episodeCount} entr${episodeCount === 1 ? 'y' : 'ies'} (your justified count).`
    : '';

  // ─── Prestige episode-count floor (regression repair, 2026-04-29) ───
  //
  // Symmetric to commercialCapNote. Without an explicit prestige floor, the
  // SHOWRUNNING PRINCIPLE soft-override ("if you cannot name why an episode
  // exists, cut it or combine it") was free to compress prestige seasons all
  // the way down to 1-2 episodes whenever the persona/subject canvas felt
  // thin to Gemini. That is the right behavior for commercial spots, the
  // wrong behavior for serialized prestige (which earns its episode count
  // from genre conventions and structural scaffolds — a thriller with a
  // midpoint reversal, a drama with emotional pivots — even when the input
  // material is sparse).
  //
  // The floor is 3 (matches the user-stated soft cap of 3-12). The ceiling
  // remains the requested episodeCount (default 12). Server-side validation
  // in BrandStoryService.generateStoryline rejects sub-floor responses as
  // defense-in-depth.
  const prestigeCountNote = !isCommercial
    ? `\n\nPRESTIGE EPISODE-COUNT FLOOR + CEILING — HARD FLOOR, SOFT CEILING:
This is a ${String(genre || 'drama').toLowerCase().toUpperCase()}-genre prestige series (NOT a commercial spot). The starting count is ${episodeCount} episodes; you may compress, but a STRICT FLOOR applies.
  • HARD FLOOR — 3 episodes minimum. The episodes[] array MUST contain AT LEAST 3 entries. A 1-episode or 2-episode prestige season is invalid output and will be rejected by the post-validation layer.
  • SOFT CEILING — ${episodeCount} episodes maximum. Apply the SHOWRUNNING PRINCIPLE ("if you cannot name why an episode exists, cut it or combine it") to compress DOWN to a justified count, but never below 3.
  • When persona/subject material feels thin, you are EXPECTED to invent compelling NARRATIVE_PURPOSES from genre conventions — a thriller earns a midpoint reversal and an act-3 twist; an action series earns inciting incident → escalation → climax → resolution; a drama earns emotional pivots and relational stakes. These are mandatory season-bible scaffolds for the genre, not optional filler. Sparse input is a brief to invent, not a license to ship a 2-episode season.
  • Justify your final count inside the season_bible document (free-text — name explicitly why this season earns N episodes and not N-1 or N+1).

The episodes[] array MUST contain BETWEEN 3 AND ${episodeCount} entries (your justified count, with 3 as the strict minimum).`
    : '';

  const focusBlock = _buildFocusBlock(storyFocus);

  // Normalize: accept either a single persona object (legacy) or an array
  const personaArray = Array.isArray(personas)
    ? personas
    : (personas ? [personas] : []);

  // Pipeline-aware persona framing — see plan
  // .claude/plans/regarding-this-infrastructure-i-magical-flame.md
  // V4 builds on-camera dialogue with opposing-intent character exchanges
  // (SHOT_REVERSE_SHOT, GROUP_DIALOGUE_TWOSHOT, DIALOGUE_IN_SCENE), so the
  // "Persona 1 is the PRIMARY NARRATOR" framing biases Gemini away from V4's
  // dialogue model. Legacy v1/v2/v3 keep the narrator framing.
  const personaLeadLabelInline = personaArray.length > 1
    ? (isV4 ? ', Persona 1 is the PROTAGONIST' : ', Persona 1 is the PRIMARY/narrator')
    : '';
  const personaLeadHeader = (i) => (i === 0 && personaArray.length > 1)
    ? (isV4 ? ' — PROTAGONIST' : ' — PRIMARY NARRATOR')
    : '';
  const personaWeaveLine = isV4
    ? `Weave ALL ${personaArray.length} persona${personaArray.length > 1 ? 's' : ''} into the narrative as on-camera characters. The protagonist's arc anchors the season; additional personas are co-leads, antagonists, foils, mentors, or love interests — all speak on-camera, none are narrators by default.`
    : `Weave ALL ${personaArray.length} persona${personaArray.length > 1 ? 's' : ''} into the narrative. The primary narrator drives the story; additional personas serve as supporting characters, foils, love interests, mentors, or adversaries.`;

  // V4 Phase 5b — subtractive change per Director Agent's mandate. Placeholders
  // ('A compelling character', 'To be determined by the story', etc.) literally
  // invited Gemini to fabricate. Story `77d6eaaf` (2026-04-28) is the smoking gun:
  // uploaded woman → Gemini received placeholder text → Gemini invented "Elias",
  // a male protagonist → cascading identity drift through every downstream stage.
  //
  // With Fix 1+2's contract, every persona has a visual_anchor (extracted via
  // Vertex Gemini multimodal at upload time OR after CharacterSheetDirector emits
  // sheets). The renderer below uses the anchor as ground truth and refuses to
  // fabricate when the anchor is missing (defense-in-depth).
  const personaBlock = personaArray.length > 0
    ? `CHARACTER${personaArray.length > 1 ? 'S' : ''}/PERSONA${personaArray.length > 1 ? 'S' : ''} (${personaArray.length} total${personaLeadLabelInline}):
${personaArray.map((p, i) => {
  // V4 Wave 6 / hotfix-2026-04-29 #2 — pass the persona record so the renderer
  // can fall back to text fields (description / appearance) when the anchor
  // is missing. Without this, described personas (no photos) used to render
  // "DESCRIPTION_MISSING — escalate to user_review" which short-circuited
  // Gemini.
  const visualLine = _renderVisualAnchorAsDescription(p.visual_anchor, p);
  // The anchor describes IDENTITY (who the actor is). The persona's personality
  // / voice_style remain author-authored hints (HOW the character sounds and
  // behaves). They are NOT permitted to invert what the anchor says.
  const personalityLine = p.personality || p.voice_style || '—';
  // When we DO have a vision-grounded anchor, label it as ground truth so
  // Gemini knows it's non-negotiable. Otherwise label as a description hint
  // so Gemini treats it as guidance, not law.
  const hasAnchor = !!p.visual_anchor?.apparent_gender_presentation;
  const visualLineLabel = hasAnchor
    ? 'Visual identity (ground truth, vision-grounded)'
    : 'Description';
  // Phase 5b regression repair (2026-04-29) — when the visual_anchor IS present,
  // _renderVisualAnchorAsDescription returns physical traits ONLY (gender, age,
  // hair, build, distinctive features). The persona's `description` and
  // `appearance` text fields — which carry NARRATIVE material (profession,
  // backstory hook, story role) — were dropped from the prompt entirely after
  // the Phase 5b subtractive change. That starved Gemini of season-bible
  // material and let the SHOWRUNNING soft-override compress prestige seasons
  // to 1-2 episodes.
  //
  // Restore the narrative material under explicit, non-identity labels so
  // Gemini cannot misread it as an identity override (the original Director
  // Agent concern). Anchor-absent path skips this — the renderer fallback
  // already includes description/appearance in `visualLine`.
  const narrativeFragments = [];
  if (hasAnchor) {
    const desc = String(p.description || '').trim();
    if (desc) narrativeFragments.push(desc);
    const appearance = String(p.appearance || p.visual_description || '').trim();
    if (appearance && appearance !== desc) narrativeFragments.push(`appearance hint: ${appearance}`);
  }
  const storyRoleLine = narrativeFragments.length > 0
    ? `\n- Story role / backstory hint (NARRATIVE only — does NOT override visual identity above): ${narrativeFragments.join(' · ')}`
    : '';
  return `
[Persona ${i + 1}${personaLeadHeader(i)}]
- ${visualLineLabel}: ${visualLine}${storyRoleLine}
- Voice/Personality: ${personalityLine}`;
}).join('\n')}

${personaWeaveLine}
`
    : '';

  const integrationBullets = (subject?.integration_guidance || []).length > 0
    ? `\n- How it should appear in scenes (director's brief):\n${(subject.integration_guidance || []).map(g => `    • ${g}`).join('\n')}`
    : '';

  const subjectBlock = subject
    ? `BRAND SUBJECT (HERO OF THE STORY):
- Name: ${subject.name || 'The subject'}
- Category: ${subject.category || 'Consumer product'}
- Description: ${subject.description || ''}
- Key Features: ${(subject.key_features || []).join(', ') || 'Quality craftsmanship'}
- Visual Description: ${subject.visual_description || ''}${integrationBullets}

THIS SUBJECT IS A BRAND ASSET. Treat it like paid product placement in prestige TV:
it must appear in EVERY episode in a way that feels NATURAL and INHERENT to the story,
never forced, never a sales pitch. Reference it by name in dialogue when authentic.
Show it visually in environments, hands, spaces, reflections, or as the setting itself.
The viewer should finish the season remembering this specific subject.
`
    : '';

  const brandPeople = (brandKit.people || []).length > 0
    ? `EXISTING BRAND PERSONAS (from brand assets): ${brandKit.people.map(p => p.description).join('; ')}`
    : '';

  const directorsBlock = directorsNotes
    ? `\nDIRECTOR'S CREATIVE VISION: "${directorsNotes}"
Use this as the cinematic north star for visual style, pacing, and emotional register.\n`
    : '';

  return `Create a complete story bible for a ${episodeCount}-episode ${isCommercial ? 'commercial video ad' : 'short-form video series'}.${commercialCapNote}${prestigeCountNote}
${commercialBriefUserBlock}
${focusBlock}
${directorsBlock}
${personaBlock}
${subjectBlock}
${brandPeople}

SERIES PARAMETERS:
- Tone: ${tone}
- Genre: ${genre}
- Target audience: ${targetAudience}
- Episodes: ${episodeCount}${isCommercial ? ' (HARD CAP — see COMMERCIAL EPISODE-COUNT CAP above)' : ` (soft ceiling ${episodeCount} / hard floor 3 — see PRESTIGE EPISODE-COUNT FLOOR + CEILING above; each ~60-90 seconds of finished video, built from 5-12 beats; ~$20 production budget per episode — plan stakes, dialogue weight, and scene depth accordingly)`}
- Platform: Short-form vertical video (TikTok/Reels/YouTube Shorts)

OUTPUT JSON SCHEMA:
{
  "title": "Series title — catchy, memorable, brandable",
  "theme": "Central theme in one sentence",
  "genre": "${genre}",
  "tone": "${tone}",
  "target_audience": "${targetAudience}",
  "logline": "One-sentence pitch that captures the entire series",
  "central_dramatic_question": "ONE sentence the viewer wants answered by the finale (e.g. 'Will Maya keep the shop or let it go?'). Drives every episode's narrative_purpose.",
  "thematic_argument": "ONE sentence arguing something about the world. Shapes tone and what lines MEAN beyond plot.",
  "antagonist_curve": [
    { "episode": 1, "pressure": "what the opposing force does this episode", "intensity": 3 },
    { "episode": 2, "pressure": "...", "intensity": 4 }
  ],
  "arc": {
    "premise": "The setup — what world are we in, what's the status quo",
    "inciting_incident": "What disrupts the status quo and kicks off the story",
    "rising_action": "How tension builds across episodes",
    "climax_hints": "What the story builds toward (don't spoil — just direction)",
    "resolution_hints": "How the story could conclude (leave room for continuation)"
  },
  "characters": [
    {
      "name": "Character name",
      "role": "protagonist|antagonist|mentor|sidekick|love_interest",
      "personality": "3-4 defining traits",
      "visual_description": "Specific physical appearance for consistent image generation",
      "arc": "How this character changes across the series",
      "relationship_to_product": "How they connect to the brand subject",
      "relationships": "Key dynamics with other characters — who they conflict with, support, love, or distrust"
    }
  ],
  "emotional_arc": [
    {
      "episode": 1,
      "primary_emotion": "curiosity|warmth|tension|relief|heartbreak|triumph|mystery|intimacy|excitement|melancholy",
      "intensity": 7,
      "turning_point": "What emotional shift happens in this episode"
    }
  ],
  "visual_motifs": [
    {
      "motif": "Name of the recurring visual element (e.g. 'the red door', 'rain on glass', 'golden light through curtains')",
      "meaning": "What it symbolizes in the story",
      "first_appearance": 1,
      "recurrence_pattern": "When/how it reappears (e.g. 'every time the protagonist faces a choice', 'in establishing shots of the location')"
    }
  ],
  "subplots": [
    {
      "name": "Subplot title",
      "description": "What this secondary thread is about",
      "episodes_active": [2, 4, 7, 10],
      "resolution_hint": "How it might resolve"
    }
  ],
  "episodes": [
    {
      "episode_number": 1,
      "title": "Episode title",
      "hook": "Opening 2-3 seconds — what grabs the viewer",
      "narrative_beat": "What story beat this episode covers (WHAT happens)",
      "narrative_purpose": "WHY this episode exists in the season (the season-level job it does — e.g. 'force Maya to choose between the shop and the partnership; reveal Daniel's loyalty is conditional')",
      "dramatic_question": "The ONE question THIS episode raises ('Is Daniel lying?'). The cliffhanger should leave the answer tilted but unconfirmed.",
      "protagonist_pressure": "What force drives the protagonist to act this episode",
      "stakes_external": "What's at risk in the world",
      "stakes_internal": "What's at risk inside the protagonist's self-image",
      "scenes_plan": [
        { "purpose": "Establish the protagonist's state through action, no dialogue", "beats_count_hint": 3 },
        { "purpose": "The central ask — the refusal — the counter-offer", "beats_count_hint": 6 },
        { "purpose": "Cliffhanger: the phone call changes everything", "beats_count_hint": 3 }
      ],
      "visual_direction": "Key visual elements, setting, lighting mood",
      "dialogue_script": "${isV4 ? 'Episode-level dialogue summary in plain prose (~3-5 sentences capturing the gist of what is said across the episode). V4 generates per-beat dialogue downstream; this field is a planning summary, NOT a target speech length.' : 'What the narrator/character says (10-15 seconds of speech) — NOTE: V4 overrides this per-beat; still useful as a v3 fallback summary'}",
      "cliffhanger": "What makes the viewer want the next episode",
      "mood": "Emotional tone of this specific episode",
      "target_emotion": "The primary emotion viewers should feel (from emotional_arc)"
    }
  ],
  "season_bible": "Comprehensive narrative context document (500+ words) that captures EVERYTHING a writer would need to continue this story: world rules, character relationships, running themes, visual motifs, tone guidelines, product integration approach, and unresolved threads. Include the director's vision interpretation and how it shapes the series' visual language. END the document with 'THEMATIC ARGUMENT: <one sentence>' and 'CENTRAL DRAMATIC QUESTION: <one sentence>' so a reader can lock onto both engines immediately."
}`;
}

/**
 * Build focus-specific narrative guidance for the storyline prompt.
 * Shapes how Gemini positions the persona relative to the subject.
 */
function _buildFocusBlock(storyFocus) {
  switch (storyFocus) {
    case 'person':
      return `STORY FOCUS: PERSON — This series is ABOUT the persona shown above. The persona IS the subject of the story. Every episode centers on their journey, transformation, expertise, or authority. Any products or settings should feel incidental — this is character-driven content where the viewer follows THIS person's narrative arc.`;
    case 'product':
      return `STORY FOCUS: PRODUCT — This is a PRODUCT showcase series. The persona should relate to the product naturally — as a discoverer, advocate, user, or witness. Every episode must foreground the product as a narrative element without being a sales pitch. Stories should make viewers feel the product's impact, craftsmanship, or promise through visual storytelling.`;
    case 'landscape':
      return `STORY FOCUS: LANDSCAPE / PLACE — This series is about a PLACE or SPACE (real estate, architecture, spa, school, destination, interior). The persona acts as a guide, inhabitant, or witness to the space. Episodes should evoke atmosphere, wonder, and the sensory experience of BEING there. The place itself is the protagonist — the persona helps the viewer feel what it's like to inhabit it.`;
    default:
      return '';
  }
}

// ============================================================
// EPISODE GENERATION (next scene in the continuing story)
// ============================================================

/**
 * System prompt for generating the next episode in an ongoing series.
 * Receives the full storyline context + previous episodes for continuity.
 *
 * @param {Object} storyline - The generated storyline/season bible
 * @param {Object[]} previousEpisodes - Array of previous episode scene_descriptions
 * @returns {string} System prompt
 */
export function getEpisodeSystemPrompt(storyline, previousEpisodes = [], personas = [], options = {}) {
  const { subject = null, storyFocus = 'product', brandKit = null, previousVisualStyle = '', previousEmotionalState = '', directorsNotes = '' } = options;
  const prevBlock = _buildPreviousEpisodesBlock(storyline, previousEpisodes);
  const brandContextBlock = brandKit ? _buildBrandKitContextBlock(brandKit) : '';

  // Emotional arc awareness — inject the planned emotion for the next episode
  const nextEpNumber = previousEpisodes.length + 1;
  const emotionalArc = storyline.emotional_arc || [];
  const targetEmotion = emotionalArc.find(e => e.episode === nextEpNumber);
  const emotionalBlock = targetEmotion
    ? `\nEMOTIONAL TARGET FOR THIS EPISODE:
- Primary emotion: ${targetEmotion.primary_emotion} (intensity: ${targetEmotion.intensity}/10)
- Turning point: ${targetEmotion.turning_point}
The viewer's emotional state from the last episode was: ${previousEmotionalState || 'fresh (series premiere)'}
Plan this episode's pacing and intensity to serve this emotional target.\n`
    : '';

  // Visual continuity from previous episode
  const visualContinuityBlock = previousVisualStyle
    ? `\nVISUAL CONTINUITY:
Previous episode's visual style: "${previousVisualStyle}"
Maintain this as the series' baseline look. Only deviate if the story demands a deliberate tonal shift, and explain any shift in visual_direction.\n`
    : '';

  // Visual motifs awareness
  const motifs = storyline.visual_motifs || [];
  const motifsBlock = motifs.length > 0
    ? `\nRECURRING VISUAL MOTIFS (weave at least one into this episode):
${motifs.map(m => `- "${m.motif}" — symbolizes ${m.meaning}. Pattern: ${m.recurrence_pattern}`).join('\n')}\n`
    : '';

  // Director's notes
  const directorsBlock = directorsNotes
    ? `\nDIRECTOR'S VISION: "${directorsNotes}"\n`
    : '';

  // Personas with trained HeyGen avatars (narrator candidates for dialogue shots)
  const narratorList = personas
    .map((p, i) => {
      const hasAvatar = !!p?.heygen_avatar_id;
      const name = p?.description?.slice(0, 50)
        || p?.avatar_name
        || `Persona ${i + 1}`;
      const personality = p?.personality ? ` (${p.personality})` : '';
      return `  [${i}] ${name}${personality}${hasAvatar ? '' : ' — NO trained avatar, cannot narrate dialogue shots'}`;
    })
    .join('\n');

  const narratorBlock = personas.length > 0
    ? `AVAILABLE NARRATORS (choose ONE per dialogue shot via narrator_persona_index):
${narratorList}

For dialogue shots, pick the narrator whose personality best fits the beat. Rotate
narrators across episodes to spotlight different characters — don't always use Persona 0.
For cinematic/broll shots, narrator_persona_index defaults to 0 (doesn't matter, not used).`
    : '';

  // Subject integration block — the subject must appear naturally in EVERY episode
  // (or nearly every), just like paid product placement in prestige TV.
  const subjectIntegrationBlock = subject?.name
    ? `\nBRAND SUBJECT (must appear in this episode):
- Name: ${subject.name}
- Category: ${subject.category || ''}
- Visual: ${subject.visual_description || ''}
${(subject.integration_guidance || []).length > 0 ? `- Integration ideas from the director:\n${subject.integration_guidance.map(g => `    • ${g}`).join('\n')}` : ''}

This subject IS a brand asset. ${storyFocus === 'person'
  ? 'It should appear at least ONCE in this episode — in hands, worn, nearby, or in the environment. Integrate it naturally as something the persona owns/uses/interacts with.'
  : storyFocus === 'landscape'
    ? 'This place IS the setting — at least ONE shot must be INSIDE or AT this location, or viewing it. The camera can move through it, or the persona can inhabit it.'
    : 'At least ONE shot must feature this product prominently — in a hand, on a counter, close-up, or as the focal point. Other shots should reference it in the background or environment.'}
Name the subject in visual_direction for at least one shot per episode. Write it like a TV-series director planning paid product placement — natural, diegetic, story-serving.`
    : '';

  return `You are the showrunner of "${storyline.title || 'an ongoing brand video series'}". You are writing the next episode in a serialized short-form video series.

SERIES CONTEXT:
- Logline: ${storyline.logline || storyline.theme || ''}
- Tone: ${storyline.tone || 'engaging'}
- Genre: ${storyline.genre || 'drama'}
- Total planned episodes: ${storyline.episodes?.length || 12}
${directorsBlock}
SEASON BIBLE:
${storyline.season_bible || JSON.stringify(storyline.arc || {}, null, 2)}
${brandContextBlock}${emotionalBlock}${visualContinuityBlock}${motifsBlock}
CHARACTERS:
${(storyline.characters || []).map(c =>
  `- ${c.name} (${c.role}): ${c.personality}. Visual: ${c.visual_description}${c.relationships ? `. Relationships: ${c.relationships}` : ''}`
).join('\n')}

${narratorBlock}
${subjectIntegrationBlock}

${prevBlock}

SHOT TYPES (compose a sequence of 2-3 shots per episode):
- "dialogue": Persona speaks directly to camera. Close/medium framing, lip sync matters.
  Use for direct-address lines, confessions, pitches, revelations — when a specific LINE
  carries the beat. The persona MUST be the subject visible on camera speaking.
- "cinematic": Persona inhabits a dynamic action scene — walking, interacting with
  environment, wide/crane shots, emotional atmospheres. NO on-camera speaking.
  Voiceover from episode dialogue_script plays over the visuals. Use for action,
  transformation, conflict, discovery beats.
- "broll": NO persona visible. Environment, product close-up, establishing shot.
  Use for scene-setting, product reveals, world-building, transitions between dialogue/cinematic shots.

ENTITY VISIBILITY (you MUST declare these per shot — they control which video generator runs):
- "visible_persona_indexes": array of integers — which personas are PHYSICALLY IN FRAME in this shot.
  Empty array [] = no characters visible (broll). [0] = only persona 0. [0, 1] = both personas 0 and 1.
  For dialogue shots, the narrator MUST appear in this array.
- "subject_visible": boolean — whether the branded product/subject is prominently visible in this shot.
  true = the product/subject is in frame. false = not featured.
- Entity count per shot affects which video generator the app uses — prefer single-entity cinematic
  shots when one character or the product alone works. Only pack 2+ entities (multiple personas,
  or persona + product together) into a frame when dramatic necessity demands it (confrontation,
  product reveal with character, partnership scene).

EVERY episode has 2-3 shots. MIX shot types within the same episode. A strong short-form
episode typically opens with a broll or cinematic hook, delivers a dialogue beat in the middle,
and closes with a cinematic cliffhanger. Vary across the season too — don't repeat the same
shot sequence.

EPISODE WRITING RULES:
1. CONTINUITY IS PARAMOUNT. The opening 'hook' of THIS episode MUST directly answer
   or escalate the previous episode's cliffhanger. Do not ignore it, do not reset the scene.
2. VISUAL THREAD: Carry at least one concrete visual motif from the previous episode
   (a location, prop, lighting, color, or character pose). Name it explicitly in visual_direction.
3. DIALOGUE THREAD: Keep the character voice, speech cadence, and vocabulary consistent
   with prior dialogue_scripts. The persona sounds like the SAME person episode-to-episode.
4. MOOD PROGRESSION: Your 'mood' should logically follow the previous mood — escalate,
   contrast intentionally, or resolve. Never drift randomly.
5. HOOK: 2-3 seconds that answers the prior cliffhanger AND grabs attention.
6. CLIFFHANGER: End with something that creates anticipation for the next episode.
7. VISUAL SPECIFICITY: Name materials, colors, time-of-day, weather, textures. Concrete.
8. DIALOGUE: 10-15 seconds of natural in-character speech (for dialogue shots) or voiceover narration (for cinematic shots).
9. PRODUCT INTEGRATION: Natural, never forced — the subject/product appears as part of the world.
10. SELF-CRITIQUE before finalizing: Does this episode feel like the next chapter of the SAME
    story, or could it have been episode 1? If the latter, rewrite. Fill the 'continuity_check'
    field honestly.

You MUST respond with ONLY valid JSON (no markdown code fences, no extra text).`;
}

/**
 * Build a tiered "previously on" block:
 * - Earlier episodes: compressed one-liner each
 * - Most recent episode: full expansion (all key fields) — this is what the LLM
 *   most needs to maintain continuity against.
 */
export function _buildPreviousEpisodesBlock(storyline, previousEpisodes) {
  if (!previousEpisodes || previousEpisodes.length === 0) {
    return 'This is the FIRST episode of the series. Establish the world and hook the viewer.';
  }

  const summarizeShots = (ep) => {
    if (Array.isArray(ep.shots) && ep.shots.length > 0) {
      return ep.shots.map(s => `${s.shot_type || '?'}:${s.duration_seconds || 5}s`).join(' → ');
    }
    // Legacy single-shot episode
    return ep.shot_type || 'cinematic';
  };

  const lastIdx = previousEpisodes.length - 1;
  const earlier = previousEpisodes.slice(0, lastIdx).map((ep, i) =>
    `  Episode ${i + 1}: "${ep.title || 'Untitled'}" | shots: [${summarizeShots(ep)}] | beat: ${ep.narrative_beat || ''} | cliffhanger: ${ep.cliffhanger || ''}`
  ).join('\n');

  const last = previousEpisodes[lastIdx];
  const shotsDetail = Array.isArray(last.shots) && last.shots.length > 0
    ? `\n    Shots breakdown:\n${last.shots.map((s, si) => `      [${si + 1}] ${s.shot_type} (${s.duration_seconds || 5}s): ${s.visual_direction || ''}`).join('\n')}`
    : `\n    Shot type: ${last.shot_type || 'cinematic'}`;

  const lastDetail = `  Episode ${lastIdx + 1} (MOST RECENT — pay closest attention): "${last.title || 'Untitled'}"${shotsDetail}
    Narrative beat: ${last.narrative_beat || ''}
    Mood: ${last.mood || ''}
    Dialogue: ${last.dialogue_script || ''}
    How it connected from before: ${last.continuity_from_previous || ''}
    Cliffhanger ending: ${last.cliffhanger || ''}`;

  const earlierBlock = earlier ? `${earlier}\n` : '';

  // Include the running story-so-far appendix if available (prevents late-episode amnesia)
  const storySoFar = storyline.story_so_far
    ? `\n${storyline.story_so_far}\n`
    : '';

  // ─── V4 cross-episode memory streams ───
  // Rendered only when present (populated by BrandStoryService._updateStorySoFar
  // after each V4 episode). Preserves voice continuity + emotional escalation across eps.

  const keyframes = Array.isArray(storyline.previously_on_keyframes) && storyline.previously_on_keyframes.length > 0
    ? `\nKEYFRAMES (concrete anchors — ref these in this episode's opening beats):\n${storyline.previously_on_keyframes.slice(-12).map(k => `  • ${k}`).join('\n')}\n`
    : '';

  const voiceSamples = storyline.character_voice_samples && typeof storyline.character_voice_samples === 'object' && Object.keys(storyline.character_voice_samples).length > 0
    ? `\nCHARACTER VOICE SAMPLES (recent lines — maintain each character's voice continuity; do not drift, do not reset):\n${Object.entries(storyline.character_voice_samples).map(([idx, lines]) => {
        const linesArr = Array.isArray(lines) ? lines : [];
        if (linesArr.length === 0) return '';
        const personaName = storyline.characters?.[Number(idx)]?.name || `Persona ${Number(idx) + 1}`;
        const rendered = linesArr.map(l => `"${l}"`).join(' | ');
        return `  [${idx}] ${personaName}: ${rendered}`;
      }).filter(Boolean).join('\n')}\n`
    : '';

  const ledger = storyline.emotional_intensity_ledger && typeof storyline.emotional_intensity_ledger === 'object' && Object.keys(storyline.emotional_intensity_ledger).length > 0
    ? (() => {
        const entries = Object.entries(storyline.emotional_intensity_ledger)
          .sort((a, b) => Number(a[0]) - Number(b[0]));
        const last = entries[entries.length - 1];
        const prev = entries[entries.length - 2];
        const ramp = entries.map(([ep, intensity]) => `Ep${ep}:${intensity}`).join(' → ');
        const escalationHint = last
          ? `  ESCALATION RULE: This episode opens at intensity ≥ ${Math.max(1, Number(last[1]) - 1)}/10 and rises from there. The previous episode closed at ${last[1]}/10${prev ? ` (prior was ${prev[1]}/10)` : ''}. Never open lower — the viewer is already calibrated there.`
          : '';
        return `\nEMOTIONAL INTENSITY LEDGER (1-10): ${ramp}\n${escalationHint}\n`;
      })()
    : '';

  // V4 Phase 11 (2026-05-07) — persona physical-state ledger. Renders the
  // running per-persona physical-change observations across episodes (wounds,
  // wardrobe damage, intoxication, fatigue, etc.) so the screenplay writer
  // KNOWS that, e.g., "Mark has a bandaged left hand" must persist into the
  // current episode. Without this, the writer treats every episode as a
  // physical reset and the visual continuity fails on multi-ep arcs.
  const physicalStateLedger = storyline.persona_physical_state_ledger
    && typeof storyline.persona_physical_state_ledger === 'object'
    && Object.keys(storyline.persona_physical_state_ledger).length > 0
    ? `\nPERSONA PHYSICAL STATE LEDGER (carry these forward — DO NOT reset on a fresh episode opening):\n${Object.entries(storyline.persona_physical_state_ledger).map(([idx, byEp]) => {
        if (!byEp || typeof byEp !== 'object') return '';
        const personaName = storyline.characters?.[Number(idx)]?.name || `Persona ${Number(idx) + 1}`;
        const sortedEps = Object.entries(byEp)
          .map(([ep, obs]) => [Number(ep), String(obs || '')])
          .filter(([n, o]) => Number.isFinite(n) && o.length > 0)
          .sort((a, b) => a[0] - b[0]);
        if (sortedEps.length === 0) return '';
        const trail = sortedEps.map(([ep, obs]) => `Ep${ep}: ${obs}`).join(' → ');
        return `  [${idx}] ${personaName}: ${trail}`;
      }).filter(Boolean).join('\n')}\n`
    : '';

  const continuityMemory = `${storySoFar}${keyframes}${voiceSamples}${ledger}${physicalStateLedger}`;

  return `PREVIOUSLY ON "${storyline.title || 'the series'}":\n${continuityMemory}${earlierBlock}${lastDetail}`;
}

/**
 * User prompt for generating the next episode.
 *
 * @param {Object} storyline - The generated storyline
 * @param {string} lastEpisodeSummary - Summary of the last episode for continuity
 * @param {number} episodeNumber - The episode number being generated
 * @returns {string} User prompt
 */
export function getEpisodeUserPrompt(storyline, lastCliffhanger, episodeNumber) {
  // Check if we have a pre-planned episode in the storyline
  const plannedEpisode = storyline.episodes?.[episodeNumber - 1];
  const plannedContext = plannedEpisode
    ? `PLANNED OUTLINE for this episode: "${plannedEpisode.title}" — ${plannedEpisode.narrative_beat}. Hook: ${plannedEpisode.hook}. Adapt based on how the story has evolved.`
    : `No specific outline for episode ${episodeNumber}. Continue the story naturally from where we left off, following the season arc.`;

  const cliffhangerBlock = lastCliffhanger
    ? `THE PREVIOUS EPISODE ENDED ON THIS CLIFFHANGER:
"${lastCliffhanger}"

Your 'hook' field MUST reference, answer, or escalate this cliffhanger in the opening
2-3 seconds. The viewer just watched that cliffhanger — they are WAITING to see what
happens next. Deliver.`
    : 'This is the series premiere. Establish the world and hook the viewer immediately.';

  return `Generate Episode ${episodeNumber} of the series.

${cliffhangerBlock}

${plannedContext}

MULTI-SHOT STRUCTURE:
This episode is composed of 2-3 distinct SHOTS that will be stitched together into one 15-25s
short-form video. Each shot is 5-10 seconds. Plan the shot SEQUENCE like a short-form director:
- Open with a hook shot (often broll establishing OR dialogue close-up that answers the cliffhanger)
- Middle shot carries the narrative beat (the emotional core)
- Close with a shot that leads into the cliffhanger (often cinematic or a dialogue reveal)

MIX shot types within the episode — don't make all 3 shots the same type unless the episode's emotional
register demands it. A dialogue-only episode feels static; a broll-only episode feels empty.

OUTPUT JSON SCHEMA:
{
  "title": "Episode title — intriguing and specific",
  "hook": "What happens in the first 2-3 seconds to grab attention. MUST reference/resolve the previous cliffhanger.",
  "narrative_beat": "The story beat this episode covers (one sentence)",
  "dialogue_script": "The full voiceover/dialogue script for the ENTIRE episode (15-25 seconds of speech total across all shots). This is the narrative voice that ties shots together.",
  "mood": "The episode's emotional register: tense, hopeful, mysterious, triumphant, intimate, etc.",
  "continuity_from_previous": "One sentence summarizing how this connects to what came before",
  "continuity_check": "One sentence explaining specifically how this episode's hook resolves the previous cliffhanger AND which visual/dialogue thread it carries forward. If this is episode 1, write 'N/A — series premiere'.",
  "cliffhanger": "What makes the viewer want episode ${episodeNumber + 1}",
  "emotional_state": "Where the viewer's emotional journey stands at the END of this episode (e.g. 'relieved but anxious about what's coming', 'deeply moved, craving resolution'). This state is fed into the next episode for emotional continuity.",
  "visual_motif_used": "Which recurring visual motif (from the season bible) appears in this episode and how",
  "shots": [
    {
      "shot_type": "dialogue | cinematic | broll",
      "narrator_persona_index": 0, /* only meaningful for dialogue shots — 0-based index into available narrators */
      "visible_persona_indexes": [0], /* REQUIRED: which personas are physically in THIS shot's frame. [] = no characters. [0] = persona 0 alone. [0, 1] = both. For dialogue shots, narrator_persona_index MUST be included here. */
      "subject_visible": false, /* REQUIRED: is the branded product/subject prominently visible in this shot? */
      "visual_direction": "SHOT-SPECIFIC detailed description: setting, lighting, colors, textures, camera angles, character positions, key objects. Name materials, colors, time of day. For cinematic: video prompt. For dialogue: background around speaker. For broll: environment or product.",
      "camera_notes": "Camera movement for THIS shot: slow push-in, orbital pan, crane up, static close-up, etc.",
      "dialogue_line": "The LINE spoken on-camera for dialogue shots (subset of episode dialogue_script). Empty string for cinematic/broll shots.",
      "mood": "Shot-specific emotional register (may differ from episode mood)",
      "duration_seconds": 7 /* 5-10 seconds per shot */
    }
    /* 2-3 shots total */
  ]
}`;
}

// ============================================================
// CINEMATIC V2 — FOCUS-SPECIFIC DIRECTION
// ============================================================

/**
 * V2 focus block — shapes the cinematic approach based on story_focus.
 * Unlike v1 (which shapes narrative), v2 shapes CINEMATOGRAPHY: what the
 * camera sees, what dominates the frame, what the storyboard must show.
 */
export function _buildCinematicFocusBlock(storyFocus) {
  switch (storyFocus) {
    case 'person':
      return `═══════════════════════════════════════════════
STORY FOCUS: PERSON — CHARACTER-DRIVEN CINEMA
═══════════════════════════════════════════════
This series is ABOUT the persona. The persona IS the star of every frame.

CINEMATOGRAPHY RULES FOR PERSON FOCUS:
- The persona must appear in at LEAST 2 of 3 shots per episode (visible_persona_indexes must include them)
- Use MEDIUM CLOSE-UPS and CLOSE-UPS that show emotion, reaction, micro-expressions
- Camera FOLLOWS the person — tracking shots, over-shoulder, eye-level intimacy
- Storyboard panels must feature the persona PROMINENTLY — face, hands, body language
- Products/settings are BACKGROUND elements — never steal the frame from the persona
- Visual style should serve the character: warm skin tones, shallow DOF on face, catch-lights in eyes
- The narration is this person's INNER VOICE — their thoughts, reflections, revelations
- Think: documentary portrait, character study, personal essay film`;

    case 'product':
      return `═══════════════════════════════════════════════
STORY FOCUS: PRODUCT — PRODUCT CINEMA
═══════════════════════════════════════════════
This is a PRODUCT showcase series. The product is the visual HERO.

CINEMATOGRAPHY RULES FOR PRODUCT FOCUS:
- The product/subject must be PROMINENTLY visible in at least 2 of 3 shots (subject_visible: true)
- Use MACRO/CLOSE-UP shots that reveal product detail, texture, craftsmanship, material
- Camera ORBITS the product — tabletop cinematography, slow reveals, dramatic lighting on surfaces
- Storyboard panels must feature the product as the DOMINANT visual element in frame
- The persona is a SUPPORTING element — discoverer, user, witness. They interact WITH the product
  but the product holds the visual weight
- At least 1 broll shot should be a pure PRODUCT HERO shot (no persona, just the product in
  cinematic lighting — like a luxury ad)
- Visual style should serve the product: high contrast, specular highlights, reflective surfaces,
  dramatic shadows, macro depth of field
- The narration tells the product's STORY — its origin, craft, impact, promise
- Think: Apple product film, luxury brand commercial, Kickstarter hero video`;

    case 'landscape':
      return `═══════════════════════════════════════════════
STORY FOCUS: LANDSCAPE / PLACE — LOCATION CINEMA
═══════════════════════════════════════════════
This series is about a PLACE or SPACE. The location is the protagonist.

CINEMATOGRAPHY RULES FOR LANDSCAPE FOCUS:
- The location/space must DOMINATE at least 2 of 3 shots — wide establishing shots, sweeping vistas,
  architectural details, atmospheric interiors
- Use WIDE and ULTRA-WIDE framing that reveals the SCALE and beauty of the space
- Camera EXPLORES the space — crane shots, slow tracking through rooms/corridors, drone-like reveals
- Storyboard panels must feature the SPACE as the dominant visual element — the persona (if present)
  is small within the grand composition, providing SCALE
- At least 1 broll shot should be a PURE ENVIRONMENT shot (no persona, just the space breathing —
  light shifting, textures, atmosphere)
- The persona acts as a GUIDE or INHABITANT — walking through, touching surfaces, gazing out windows.
  They help the viewer feel what it's like to BE there, but never dominate the frame
- Visual style should serve the space: golden hour light, leading lines, symmetry, architectural
  composition, atmospheric depth (fog, dust motes, light beams)
- The narration evokes the SENSORY experience of the place — what it feels like to stand there
- Think: real estate cinematic tour, travel film, architectural documentary, Wes Anderson composition`;

    default:
      return '';
  }
}

// ============================================================
// CINEMATIC V2 — EPISODE GENERATION (voice-over narration model)
// ============================================================

/**
 * V2 system prompt for cinematic episodes.
 * Key differences from v1:
 * - NO "dialogue" shot type — all shots are cinematic or broll
 * - Voice-over narration instead of on-camera talking heads
 * - visual_style_prefix for unified look across all shots
 * - storyboard_prompt per shot (drives Flux 2 Max image generation)
 * - end_frame_description per shot (for inter-shot continuity)
 */
export function getEpisodeSystemPromptV2(storyline, previousEpisodes = [], personas = [], options = {}) {
  const { subject = null, storyFocus = 'product', brandKit = null, previousVisualStyle = '', previousEmotionalState = '', directorsNotes = '' } = options;
  const prevBlock = _buildPreviousEpisodesBlock(storyline, previousEpisodes);
  const brandContextBlock = brandKit ? _buildBrandKitContextBlock(brandKit) : '';
  const focusBlock = _buildCinematicFocusBlock(storyFocus);

  // Emotional arc awareness
  const nextEpNumber = previousEpisodes.length + 1;
  const emotionalArc = storyline.emotional_arc || [];
  const targetEmotion = emotionalArc.find(e => e.episode === nextEpNumber);
  const emotionalBlock = targetEmotion
    ? `\nEMOTIONAL TARGET FOR THIS EPISODE:
- Primary emotion: ${targetEmotion.primary_emotion} (intensity: ${targetEmotion.intensity}/10)
- Turning point: ${targetEmotion.turning_point}
- Viewer's current state: ${previousEmotionalState || 'fresh (series premiere)'}
Shape the pacing, lighting, and camera language to serve this emotional target.\n`
    : '';

  // Visual continuity from previous episode
  const visualContinuityBlock = previousVisualStyle
    ? `\nVISUAL CONTINUITY FROM PREVIOUS EPISODE:
Previous visual style: "${previousVisualStyle}"
Your visual_style_prefix should evolve FROM this — maintain the series' established look.
Only deviate for deliberate tonal shifts demanded by the narrative.\n`
    : '';

  // Visual motifs
  const motifs = storyline.visual_motifs || [];
  const motifsBlock = motifs.length > 0
    ? `\nRECURRING VISUAL MOTIFS (weave at least one into this episode):
${motifs.map(m => `- "${m.motif}" — symbolizes ${m.meaning}. Pattern: ${m.recurrence_pattern}`).join('\n')}\n`
    : '';

  // Director's notes
  const directorsBlock = directorsNotes
    ? `\nDIRECTOR'S VISION: "${directorsNotes}"\n`
    : '';

  // Personas are characters IN the cinematic scenes — not talking-head narrators
  const characterList = personas
    .map((p, i) => {
      const name = p?.description?.slice(0, 60) || p?.avatar_name || `Persona ${i + 1}`;
      const personality = p?.personality ? ` — ${p.personality}` : '';
      const appearance = p?.visual_description || p?.appearance || '';
      return `  [${i}] ${name}${personality}${appearance ? `. Appearance: ${appearance}` : ''}`;
    })
    .join('\n');

  const characterBlock = personas.length > 0
    ? `CHARACTERS (available for cinematic scenes — referenced by visible_persona_indexes):
${characterList}

These characters appear IN scenes — walking, interacting, emoting, living.
They do NOT speak to camera. All speech is voice-over narration layered on cinematic visuals.`
    : '';

  const subjectIntegrationBlock = subject?.name
    ? `\nBRAND SUBJECT (must appear in this episode):
- Name: ${subject.name}
- Category: ${subject.category || ''}
- Visual: ${subject.visual_description || ''}
${(subject.integration_guidance || []).length > 0 ? `- Integration ideas:\n${subject.integration_guidance.map(g => `    • ${g}`).join('\n')}` : ''}

Integrate this subject like a prestige-TV product placement — natural, diegetic, story-serving.
At least ONE shot must feature it prominently. ${storyFocus === 'landscape' ? 'This place IS the setting.' : ''}`
    : '';

  return `You are the showrunner and cinematographer of "${storyline.title || 'an ongoing brand video series'}". You write and direct each episode as a CINEMATIC SHORT FILM — not a social media clip.

${focusBlock}
${directorsBlock}
SERIES CONTEXT:
- Logline: ${storyline.logline || storyline.theme || ''}
- Tone: ${storyline.tone || 'engaging'}
- Genre: ${storyline.genre || 'drama'}
- Total planned episodes: ${storyline.episodes?.length || 12}
${emotionalBlock}${visualContinuityBlock}${motifsBlock}

SEASON BIBLE:
${storyline.season_bible || JSON.stringify(storyline.arc || {}, null, 2)}
${brandContextBlock}

CHARACTERS:
${(storyline.characters || []).map(c =>
  `- ${c.name} (${c.role}): ${c.personality}. Visual: ${c.visual_description}`
).join('\n')}

${characterBlock}
${subjectIntegrationBlock}

${prevBlock}

═══════════════════════════════════════════════
CINEMATIC PARADIGM (READ CAREFULLY):
═══════════════════════════════════════════════

You are making a SHORT FILM, not a social media clip. Think like a film director:

1. VISUAL STYLE PREFIX — Before writing shots, define ONE unified cinematography brief
   for the entire episode: color temperature (warm/cool), lighting quality (golden hour,
   overcast, neon noir), lens feel (anamorphic, telephoto, handheld), and film stock
   reference (Kodak Portra 400, Fuji Velvia, grainy 16mm). This brief applies to ALL
   shots and ALL storyboard panels to ensure visual coherence.

2. VOICE-OVER NARRATION — Characters do NOT speak to camera. All dialogue is voice-over
   narration that plays OVER cinematic visuals. The character's emotional state described
   in narration is reflected in the cinematic visual (e.g., narration says "I couldn't
   believe it" while the visual shows the character's face shifting from shock to wonder).

3. SHOT TYPES (compose exactly 3 shots per episode):
   - "cinematic": Character(s) inhabiting a dynamic scene — walking, discovering,
     reacting, interacting with environment/product. Wide, medium, or close framing.
     Camera moves. Lighting shifts. This is your primary shot type.
   - "broll": NO characters visible. Environment, product close-up, establishing shot,
     atmosphere. Use for scene-setting, product reveals, transitions.

   There is NO "dialogue" shot type. Characters are NEVER static talking heads.

4. STORYBOARD PROMPT — For each shot, write a detailed still-image prompt describing
   the KEY VISUAL COMPOSITION of that shot's most impactful moment. This drives AI
   image generation (Flux 2 Max) for the storyboard panel. Include: characters'
   appearance & pose, environment, lighting, colors, framing, depth of field.

5. END FRAME DESCRIPTION — Describe what the camera shows at the VERY END of each shot.
   This is used for visual continuity — the next shot begins roughly where this one ends.

6. TRANSITIONS — Specify how each shot flows into the next: "dissolve" (default, smooth),
   "fadeblack" (dramatic pause), "cut" (jarring reveal).

7. AMBIENT SOUND DESIGN — For each shot, describe the ambient sounds the viewer should
   hear: "footsteps on marble echoing in a vast hall", "wind through glass corridors",
   "distant city traffic humming below". The video generator uses these cues to produce
   native audio that matches the scene. Be specific and evocative — this is the sound
   design layer of your film.

8. SPOKEN DIALOGUE — If a character speaks ON-CAMERA in a shot (not voice-over, but
   actually talking within the scene), write their line in QUOTATION MARKS inside the
   visual_direction field. Example: visual_direction includes 'Elias turns and says
   "This is where it all begins."' The video generator will lip-sync the character when
   it detects quoted dialogue. Use sparingly — max 1 shot per episode with on-camera
   dialogue. Most dialogue should remain as voice-over narration.

9. CAMERA MOVEMENT — Be EXPLICIT about camera motion using industry verbs in camera_notes:
   "slow dolly forward", "crane up reveal", "orbital pan left 180°", "handheld tracking
   following character", "static tripod close-up", "tilt down from sky to ground",
   "push-in to extreme close-up", "pull-back wide reveal". The video generator translates
   these into actual camera motion — vague directions produce static shots.

EPISODE WRITING RULES:
1. CONTINUITY IS PARAMOUNT. The hook MUST resolve/escalate the previous cliffhanger.
2. VISUAL THREAD: Carry at least one visual motif from the previous episode.
3. MOOD PROGRESSION: Logically follow the previous mood.
4. Each episode = exactly 3 shots, total 24-45 seconds (8-15s per shot depending on video provider).
5. The visual_style_prefix MUST be respected in every storyboard_prompt and visual_direction.
6. Product/subject integration: natural, never forced.
7. EVERY shot must have an ambient_sound description — silence is never acceptable in cinema.
8. camera_notes must use SPECIFIC camera verbs, not vague descriptions.

You MUST respond with ONLY valid JSON (no markdown code fences, no extra text).`;
}

/**
 * V2 user prompt for cinematic episodes with the new JSON schema.
 */
export function getEpisodeUserPromptV2(storyline, lastCliffhanger, episodeNumber) {
  const plannedEpisode = storyline.episodes?.[episodeNumber - 1];
  const plannedContext = plannedEpisode
    ? `PLANNED OUTLINE: "${plannedEpisode.title}" — ${plannedEpisode.narrative_beat}. Hook: ${plannedEpisode.hook}. Adapt based on how the story has evolved.`
    : `No specific outline for episode ${episodeNumber}. Continue naturally.`;

  const cliffhangerBlock = lastCliffhanger
    ? `THE PREVIOUS EPISODE ENDED ON THIS CLIFFHANGER:
"${lastCliffhanger}"

Your 'hook' MUST reference, answer, or escalate this in the opening seconds.`
    : 'This is the series premiere. Establish the world and hook the viewer immediately.';

  return `Generate Episode ${episodeNumber} as a cinematic short film.

${cliffhangerBlock}

${plannedContext}

SHOT SEQUENCE DIRECTION:
- Shot 1 (4-5s): Opening hook — establish or answer the cliffhanger. Often broll or cinematic wide.
- Shot 2 (4-5s): Narrative core — the emotional center of this episode. Character-driven cinematic.
- Shot 3 (4-5s): Cliffhanger close — build tension, leave the viewer wanting more.

Total duration: 24-45 seconds (8-15s per shot). Write narration and visual direction to fill this duration.

OUTPUT JSON SCHEMA:
{
  "title": "Episode title — intriguing and specific",
  "hook": "What happens in the first 2-3 seconds to grab attention",
  "narrative_beat": "The story beat this episode covers (one sentence)",
  "dialogue_script": "The full voice-over narration for the ENTIRE episode (30-45 seconds of speech — this must fill the full video duration). Write narration that matches the pacing of a cinematic film: deliberate pauses, atmospheric beats, emotionally weighted delivery. At ~2.5 words per second, aim for 75-110 words total.",
  "mood": "The episode's emotional register",
  "continuity_from_previous": "How this connects to what came before",
  "continuity_check": "How this episode's hook resolves the previous cliffhanger",
  "cliffhanger": "What makes the viewer want episode ${episodeNumber + 1}",
  "emotional_state": "Where the viewer's emotional journey stands at the END of this episode (e.g. 'relieved but anxious', 'deeply moved, craving resolution'). Fed into the next episode for emotional continuity.",
  "visual_motif_used": "Which recurring visual motif (from the season bible) appears in this episode and how it manifests visually",
  "visual_style_prefix": "UNIFIED cinematography brief for ALL shots: color temperature, lighting quality, lens feel, film stock reference. Example: 'Warm golden-hour tones, shallow depth of field, anamorphic lens flare, Kodak Portra 400 grain, soft backlit highlights'. This prefix ensures all 3 shots and storyboard panels share the same cinematic look.",
  "shots": [
    {
      "shot_type": "cinematic | broll",
      "visible_persona_indexes": [0],
      "subject_visible": false,
      "narration_line": "The voice-over text that plays during THIS specific shot (a portion of dialogue_script). The character's emotional state should be reflected in the visual_direction.",
      "storyboard_prompt": "Detailed still-image prompt for Flux 2 Max: the KEY FRAME composition of this shot. Describe character appearance/pose, environment, lighting, colors, framing, depth of field. Must respect visual_style_prefix. Example: 'A woman in a camel coat stands at a rain-streaked window, warm interior light casting amber across her face, city lights blurred behind her, shallow DOF, Kodak Portra 400 grain, 9:16 vertical composition.'",
      "visual_direction": "VIDEO motion prompt: what MOVES in this shot. Camera movement, character action, environment changes. If a character speaks on-camera, include their line in QUOTATION MARKS for lip-sync: 'Elias turns to camera and says \"This is where it all begins.\"' Example: 'Camera slowly pushes in as she turns from the window, her expression shifting from doubt to resolve, rain streaks blurring in the foreground.'",
      "camera_notes": "SPECIFIC camera verb: 'slow dolly forward', 'crane up reveal', 'orbital pan left 180°', 'handheld tracking following character', 'static tripod close-up', 'tilt down from sky to ground', 'push-in to extreme close-up', 'pull-back wide reveal'",
      "ambient_sound": "Describe the soundscape of this shot for native audio generation: 'footsteps echoing on marble, distant elevator hum, muffled city traffic through glass walls'. Be specific and cinematic — this IS the sound design.",
      "end_frame_description": "What the camera shows at the VERY END of this shot for continuity to the next. Example: 'Close-up on her hand reaching for the door handle, warm light spilling through the gap.'",
      "mood": "Shot-specific emotional register",
      "duration_seconds": 5,
      "transition_to_next": "dissolve | fadeblack | cut"
    }
  ]
}

CRITICAL CONSTRAINTS:
- Exactly 3 shots per episode
- Each shot 8-15 seconds (total 24-45s per episode)
- shot_type is ONLY "cinematic" or "broll" — NO "dialogue" type
- storyboard_prompt must be a RICH image prompt (100+ words) — this drives the storyboard quality
- visual_style_prefix MUST be reflected in every storyboard_prompt
- narration_line for each shot should collectively form the full dialogue_script`;
}

// ============================================================
// STORYBOARD FRAME PROMPT (for Leonardo.ai image generation — v1 legacy)
// ============================================================

/**
 * Build a prompt for Leonardo.ai to generate a storyboard frame from scene description.
 * Combines the episode's visual direction with brand context.
 *
 * @param {Object} sceneDescription - Episode scene_description from Gemini
 * @param {Object} persona - Persona config (appearance, description)
 * @param {Object} brandKit - Brand Kit data for visual consistency
 * @returns {string} Leonardo.ai generation prompt
 */
export function getStoryboardPrompt(sceneDescription, persona = {}, brandKit = {}, options = {}) {
  const { subject = null, storyFocus = 'product' } = options;
  const visualDirection = sceneDescription.visual_direction || sceneDescription.hook || '';
  const mood = sceneDescription.mood || 'cinematic';
  const cameraNote = sceneDescription.camera_notes || '';

  // Build brand context hints
  const colorHint = (brandKit.color_palette || []).slice(0, 3)
    .map(c => c.hex || c.name)
    .join(', ');

  const styleHint = brandKit.style_characteristics?.overall_aesthetic || '';

  // Build persona appearance hint.
  // Accept either a single persona (legacy) or { personas: [] } array.
  // For storyboard, we describe all characters but Leonardo's Character Reference
  // will lock the primary persona's likeness.
  const personaArray = Array.isArray(persona?.personas) ? persona.personas : [persona];
  const personaHints = personaArray
    .map(p => p?.appearance || p?.visual_description || p?.description)
    .filter(Boolean);

  let prompt = `Cinematic storyboard frame, vertical 9:16 composition. ${visualDirection}`;

  // SUBJECT HERO — name the subject explicitly so Leonardo features it in the frame.
  // For product/landscape focus, the subject is the hero; for person focus it's a secondary element.
  if (subject?.name && subject?.visual_description) {
    if (storyFocus === 'product') {
      prompt += ` Featuring the PRODUCT: ${subject.name} — ${subject.visual_description}.`;
    } else if (storyFocus === 'landscape') {
      prompt += ` SET IN / AGAINST: ${subject.name} — ${subject.visual_description}.`;
    } else {
      prompt += ` Includes ${subject.name} (${subject.visual_description}) naturally in the scene.`;
    }
  }

  if (personaHints.length > 0) {
    prompt += ` Characters: ${personaHints.join('; ')}.`;
  }

  if (mood) {
    prompt += ` Mood: ${mood}.`;
  }

  if (cameraNote) {
    prompt += ` Camera: ${cameraNote}.`;
  }

  if (colorHint) {
    prompt += ` Brand colors: ${colorHint}.`;
  }

  if (styleHint) {
    prompt += ` Style: ${styleHint}.`;
  }

  prompt += ' Photorealistic, dramatic lighting, shallow depth of field, film grain.';

  return prompt;
}

