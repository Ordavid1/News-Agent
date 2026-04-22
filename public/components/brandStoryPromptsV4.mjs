// public/components/brandStoryPromptsV4.mjs
// V4 Gemini prompts — scene-graph / beat-based screenplay generation.
//
// This is the single most important file for V4 film quality. Every directorial
// principle from sunny-wishing-teacup.md lives here, encoded as explicit
// instructions for Gemini 3 Flash.
//
// Key differences from V2 (cinematic voice-over pipeline):
//   1. Output is a scene-graph with explicit beats, not a flat shots[] array
//   2. Beat type enum is STRICT (13 types total)
//   3. Characters speak on-camera — `dialogue` field per beat instead of one
//      full-episode dialogue_script
//   4. SHOT_REVERSE_SHOT is the DEFAULT for multi-character dialogue
//      (reserves GROUP_DIALOGUE_TWOSHOT for emotional peaks only)
//   5. Per-beat prompts describe action + emotion + camera + lens ONLY
//      — lighting, color, wardrobe, film stock all inherit from scene_visual_anchor_prompt
//   6. scene.type modifier for montage sequences
//   7. Beats emit `requires_text_rendering: true` flag to route on-screen
//      text beats to Kling V3 Pro (best-in-class native text rendering)
//   8. music_bed_intent field emitted per episode for ElevenLabs Music
//   9. LUT picked per episode when no Brand Kit attached
//   10. Hard rule: dialogue must be speakable (no parentheticals, no SFX inline)
//
// Imports the shared helpers from brandStoryPrompts.mjs so Gemini sees the
// same brand-kit / focus / previous-episodes context as v2/v3.

import {
  _buildBrandKitContextBlock,
  _buildCinematicFocusBlock,
  _buildPreviousEpisodesBlock
} from './brandStoryPrompts.mjs';

// ═══════════════════════════════════════════════════════════════════════
// BEAT TYPE TAXONOMY — 13 total (9 generated + 4 post-production / modifiers)
// ═══════════════════════════════════════════════════════════════════════

export const V4_BEAT_TYPES = [
  // Generated beats (routed to a video model)
  'TALKING_HEAD_CLOSEUP',      // Mode B: Kling O3 Omni → Sync Lipsync v3. Single character, tight framing, dialogue.
  'DIALOGUE_IN_SCENE',         // Mode B: Kling O3 Omni with Elements voice binding → Sync Lipsync v3. Character speaking in rich environment.
  'GROUP_DIALOGUE_TWOSHOT',    // Mode B: Kling O3 Omni multi-char → Sync Lipsync v3 (per-speaker). RARE — emotional peaks only.
  'SHOT_REVERSE_SHOT',         // Compiler: expands into N alternating TALKING_HEAD_CLOSEUP. DEFAULT for multi-character dialogue.
  'SILENT_STARE',              // Mode B (silent ambient): Kling O3 Omni. Held closeup, no line, micro-expression only.
  'REACTION',                  // Veo 3.1 Standard + first/last frame. Silent 2-4s, emotional arc from neutral→reaction.
  'INSERT_SHOT',               // Veo 3.1 Standard + first/last frame. Product hero / tight object detail. THE money beat for brands.
  'ACTION_NO_DIALOGUE',        // Kling V3 Pro. Prompt-first cinematic action, motion, environmental interaction.
  'B_ROLL_ESTABLISHING',       // Veo 3.1 Standard. Atmospheric environment, native ambient audio bed.
  'VOICEOVER_OVER_BROLL',      // Veo 3.1 Standard + ElevenLabs V.O. swap. Opt-in montage/recap beats.
  // Non-generated beats (pure post-production / ffmpeg)
  'TEXT_OVERLAY_CARD',         // ffmpeg overlay. Title/chapter/location cards. Variants: title, chapter, location, epigraph, logo_reveal.
  'SPEED_RAMP_TRANSITION'      // ffmpeg setpts. Stylized inter-scene transition.
];

export const V4_SCENE_TYPES = [
  'standard',  // default — beats cut with normal rhythm
  'montage'    // tight cuts within scene + unified music bed + optional speed ramps. Phase 1.
  // 'split_screen' — parked for Phase 2
];

// ═══════════════════════════════════════════════════════════════════════
// LUT LIBRARY REFERENCE (shown to Gemini so it can pick per-episode)
// ═══════════════════════════════════════════════════════════════════════

export const V4_LUT_LIBRARY = [
  { id: 'bs_warm_cinematic', look: 'Kodak Portra 400 emulation, warm shadows, soft highlights', suits: 'lifestyle, hospitality, food, family' },
  { id: 'bs_cool_noir',      look: 'Desaturated, blue-shifted shadows, high contrast',          suits: 'tech, fintech, security, B2B' },
  { id: 'bs_golden_hour',    look: 'Amber highlights, soft warm midtones',                      suits: 'wellness, beauty, travel, luxury' },
  { id: 'bs_urban_grit',     look: 'Teal & orange, crushed blacks, raised greens',              suits: 'streetwear, sports, gaming, automotive' },
  { id: 'bs_dreamy_ethereal',look: 'Bloom highlights, soft pastels',                            suits: 'fashion, perfume, cosmetics, jewelry' },
  { id: 'bs_retro_film',     look: 'Fuji 8mm, muted saturation, warm grain',                    suits: 'heritage, artisanal, food & drink' },
  { id: 'bs_high_contrast_moody', look: 'Deep blacks, punchy highlights',                       suits: 'music, entertainment, fashion editorial' },
  { id: 'bs_naturalistic',   look: 'Minimal grade, subtle warmth',                              suits: 'health, education, non-profit, documentary (safe fallback)' }
];

function _formatLutLibraryForPrompt() {
  return V4_LUT_LIBRARY.map(l => `  - ${l.id}: ${l.look} — suits: ${l.suits}`).join('\n');
}

// ═══════════════════════════════════════════════════════════════════════
// GENRE REGISTER GUIDE
// ═══════════════════════════════════════════════════════════════════════
//
// Genre-specific cinematic directives. The DIALOGUE MASTERCLASS and core
// craft rules stay genre-agnostic (those are universal). This block gives
// Gemini register cues per-genre so an 'action' series kinetically feels
// different from a 'drama' series without hard-coding use-case branches
// into the architecture.
//
// Extensible — any new genre added to the profile.html dropdown can key a
// block here. Missing genres fall back to the universal directive (no
// register override, which is the existing 'genre is a container' mode).

function _buildGenreRegisterBlock(genre) {
  const g = String(genre || '').toLowerCase().trim();

  if (g === 'action') {
    return `═══════════════════════════════════════════════════════════════
GENRE REGISTER — ACTION (kinetic, high-pressure, high-BPM)
═══════════════════════════════════════════════════════════════

This is a TRUE action series — guns, cars, fights, pursuits, explosions,
stakes measured in seconds. The dialogue masterclass rules still apply,
but the register is different: characters speak UNDER DURESS, under fire,
under the time pressure of the next thing about to blow up.

PACING & BEAT SHAPE:
  - BEAT DURATIONS ARE SHORTER overall. Favour 2-4s beats over 5-8s.
    Keep dialogue-bearing beats dense (5-6s max) — the scene breathes
    through cuts, not through lines. Long still closeups are RARE.
  - INTERCUT AGGRESSIVELY. Every 1-2 dialogue beats must be broken by
    an ACTION_NO_DIALOGUE, REACTION, or INSERT_SHOT. Never stack three
    dialogue beats without a kinetic interrupt.
  - USE SPEED_RAMP_TRANSITION inside action sequences — Snyder/Leitch
    beat-drops. One per action scene is a good ceiling; more is gratuitous.
  - Scene count skews HIGHER (3-4 scenes for an 80s episode) because
    locations change fast — foot chase → crash → warehouse → rooftop.

DIALOGUE FLOOR (non-negotiable — action without voices is a trailer, not an episode):
  - MINIMUM ≥ 3 dialogue-bearing beats per episode (TALKING_HEAD_CLOSEUP /
    DIALOGUE_IN_SCENE / GROUP_DIALOGUE_TWOSHOT / SHOT_REVERSE_SHOT / VOICEOVER_OVER_BROLL).
  - MINIMUM ≥ 1 spoken line in every scene that has at least one persona
    present. Even during a chase, a character radios in, barks an order,
    or grunts a name. Silence is a CHOICE, not a DEFAULT.
  - Dialogue still accounts for 25-40% of total episode runtime. The
    remaining 60-75% is kinetic ACTION / REACTION / INSERT / B_ROLL.
  - If a scene is pure spectacle (car slamming through a barricade, bomb
    clicking), pair it with a voice — a command radio call, a whispered
    count-down, an overheard threat on a police scanner. The viewer must
    hear a human voice every ~15 seconds or the episode feels like stock footage.

DIALOGUE UNDER DURESS:
  - Lines are CLIPPED. "Move." "Down." "Reload." Fragments are the rule,
    full sentences are the exception — reserve them for the moment a
    character stops moving.
  - BANTER is the relief valve — quip mid-firefight is genre canon
    (John McClane, Deadpool, The Bear's kitchen chaos translated to pursuit).
    The banter carries character voice the quiet scenes never had time to.
  - COMMAND DIALOGUE: short imperatives with opposing intents — one
    character wants to push forward, another wants to retreat / call
    backup / stand down. Keep the conflict as muscular as the visuals.
  - OVERLAPPING or interrupted lines: a character gets cut off by a
    gunshot, an explosion, a car impact — write the aborted line and
    mark the beat \`emotional_hold: false, pace_hint: "fast"\`.

VISUAL / CAMERA REGISTER:
  - Camera is UNSETTLED: handheld, whip-pans, Dutch angles, snap-zooms.
    Encode this in \`camera_move\` and \`camera_notes\` per beat.
  - Lens choice trends WIDER (24-35mm) for immersion, not 85mm portraiture.
    Closeups get tight and kinetic (50mm handheld), not meditative.
  - scene_visual_anchor_prompt emphasises MOTION BLUR, HARSH LIGHT,
    smoke, rain-on-windshield, sodium-vapour street lamps, muzzle
    flash, sparks. Reference: Michael Mann's Heat, Bourne, John Wick,
    Mad Max: Fury Road.

BEAT TYPE MIX (for action episodes):
  - ACTION_NO_DIALOGUE carries the episode's weight — reserve 35-50% of
    beats for this type. Each 4-10s of raw cinematic motion.
  - INSERT_SHOT frequency rises — weapon details, speedometer, bullet
    casings, blood on a shirt, key fob click, phone screen with 3%
    battery. These are the kinetic punctuation.
  - REACTION beats get SHORTER (2s) and SHARPER — the beat of recognition
    before the dodge, not a lingering emotional read.
  - GROUP_DIALOGUE_TWOSHOT is for the ONE breather scene per episode
    (command centre, post-chase huddle) — never during action.
  - B_ROLL_ESTABLISHING lands HARD and FAST — a skyline, an approach,
    a warehouse exterior — 2-3s max, not the 5s atmospheric drift of a drama.

AMBIENT BED & SFX:
  - scene.ambient_bed_prompt trends INDUSTRIAL / CHARGED: generator hum,
    chopper rotors distant, engine idle, radio static chatter, wind at
    speed, rain on sheet metal. For action genre the bed is PRESSURE,
    not serenity.
  - beat.ambient_sound is THE KINETIC LAYER: brass clattering on concrete,
    slide racking, magazine ejecting, tire screech, glass breaking, metal
    impact, distant siren doppler. Specific and physical — "shell casing
    bouncing on a marble floor", not "gunshot sound".
  - The per-beat SFX layer carries the genre. Be specific and evocative
    on every non-dialogue beat; the Hollywood sonic backdrop + these
    foreground events IS what makes it feel like action cinema.

MUSIC BED INTENT (for music_bed_intent field):
  - 130-160 BPM baseline, driving percussion, sub-bass pulse, sustained
    low strings or modular synth drones, aggressive rhythmic elements.
  - Examples Gemini should key off: Junkie XL (Fury Road, Deadpool 2),
    Tyler Bates (John Wick), Lorne Balfe (Mission: Impossible — Fallout),
    Hildur Guðnadóttir kinetic cues. Not symphonic, not orchestral.
  - Describe the ARC inside the cue: build-pulse through Movement II,
    drop or silence at the kill/reveal, re-enter on the cliffhanger.

LUT CHOICE (if picking):
  - bs_urban_grit (teal & orange, crushed blacks) — default action look.
  - bs_high_contrast_moody — for nighttime / interior action.
  - bs_cool_noir — for surveillance / tactical / cold-open set pieces.
  - AVOID bs_warm_cinematic, bs_dreamy_ethereal, bs_golden_hour — they
    kill the genre's visual pressure.

TRANSITIONS BETWEEN SCENES:
  - MIX transitions — do not stack the same type. A string of 3+ cuts in
    a row stresses the assembly pipeline AND flattens the rhythm.
  - USE \`cut\` WITHIN action-to-action boundaries (scene A = firefight,
    scene B = pursuit → cut). At most TWO consecutive cuts per episode.
  - USE \`dissolve\` between action and a breather (scene A = pursuit,
    scene B = regroup at safe house → dissolve). Dissolve is also the
    safest default when adjacent scenes have distinct ambient beds —
    the pipeline auto-upgrades some cuts to dissolves for bed continuity,
    but you should emit dissolve deliberately rather than rely on that.
  - \`speed_ramp\` is permitted as a scene boundary ONLY on the hit-the-
    action-beat transition (scene A ends with the character stepping
    out of the car → scene B opens mid-firefight). Max ONE per episode.
  - \`fadeblack\` for end-of-act dead-air moments (a character dies, the
    dust settles, Movement III cliffhanger).

CHARACTER STAKES UNDER PRESSURE:
  - The character bibles still matter — voice + wound + flaw carry
    through even faster than in drama (one line, one gesture, you know
    them). Action characters reveal themselves through what they DO
    under pressure, not through long speeches. Write the gesture into
    the beat's action_notes or expression_notes.

DO NOT:
  - Pad scenes with dialogue to meet the duration.
  - Write monologues. A villain speech is at most 3 lines.
  - Let a scene go 15s without a kinetic cut/insert/reaction.
  - Resolve the cliffhanger in the opening beat — action cliffhangers
    should land mid-motion (the character jumping, the bomb ticking,
    the door exploding inward) and the next episode picks up from the
    exact frame.`;
  }

  if (g === 'thriller') {
    return `═══════════════════════════════════════════════════════════════
GENRE REGISTER — THRILLER (coiled tension, dramatic irony)
═══════════════════════════════════════════════════════════════

The audience knows something a character does not — or suspects it.
Every scene holds tension that dialogue and image do NOT release.
Use DRAMATIC_IRONY as the default hook type. Lean on SILENT_STARE
and REACTION beats to carry the viewer's dread. Music bed: low
sustained strings, sparse piano, stingers only on reveals. LUT:
bs_cool_noir or bs_high_contrast_moody. Pace alternates between
coiled stillness (held beats) and sudden acceleration (status flips).`;
  }

  if (g === 'comedy') {
    return `═══════════════════════════════════════════════════════════════
GENRE REGISTER — COMEDY (swerve, denial, rhythm)
═══════════════════════════════════════════════════════════════

Comedy lives in the SECOND line — the denial of the expected emotional
beat, the swerve that undoes the setup. Default hook: CONTRADICTION_REVEAL
or STATUS_FLIP. Dialogue rhythm is short-short-LONG (the punch is the
long line, not the short one). Let the REACTION beat do heavy lifting —
the best joke is on the face, not in the next line. Music bed: light,
playful, rhythm-forward. Avoid leaning on the visual for the joke —
comedy is in the WORDS not the shot.`;
  }

  if (g === 'horror') {
    return `═══════════════════════════════════════════════════════════════
GENRE REGISTER — HORROR (dread through underreaction)
═══════════════════════════════════════════════════════════════

Horror is built from UNDERREACTION. The character says "go to bed" when
they should scream. Default hooks: DRAMATIC_IRONY, CRESCENDO. Lean hard
on SILENT_STARE + held REACTION beats. Ambient beds do more narrative
work here than in any other genre — absence of sound is the instrument.
Music bed: drones, ticking, breathing, single held notes. Cuts are SLOW
until they aren't. Cliffhanger lands on something the viewer saw and
the character didn't.`;
  }

  if (g === 'noir' || g === 'mystery') {
    return `═══════════════════════════════════════════════════════════════
GENRE REGISTER — NOIR / MYSTERY (information asymmetry, deflection)
═══════════════════════════════════════════════════════════════

Every line hides more than it says. Default hook types: REVELATION,
CONTRADICTION_REVEAL, ESCALATION_OF_ASK. Dialogue is elliptical —
answers questions with questions, refuses to clarify. LUT: bs_cool_noir.
Lighting motifs: venetian blinds, cigarette smoke, single-source
practicals. Music bed: saxophone, pizzicato strings, double-bass.
Pace: slow burns punctuated by status flips.`;
  }

  // Default — the universal directive. Genre is a container, tone sits in
  // the brand context, characters carry the weight.
  return '';
}

// ═══════════════════════════════════════════════════════════════════════
// V4 EPISODE SCREENPLAY PROMPT
// ═══════════════════════════════════════════════════════════════════════

/**
 * V4 system prompt for scene-graph / beat-based episode generation.
 *
 * @param {Object} storyline - the season bible from generateStoryline()
 * @param {Object[]} [previousEpisodes=[]] - prior episodes for continuity
 * @param {Object[]} [personas=[]] - persona_config.personas[]
 * @param {Object} [options]
 * @param {Object} [options.subject] - subject config
 * @param {string} [options.storyFocus='product'] - 'person' | 'product' | 'landscape'
 * @param {Object} [options.brandKit] - brand kit data (used for LUT waterfall + aesthetic context)
 * @param {string} [options.previousVisualStyle] - visual_style_prefix carried from previous episode
 * @param {string} [options.previousEmotionalState]
 * @param {string} [options.directorsNotes]
 * @param {number} [options.costCapUsd] - hard ceiling; Gemini instructed to keep within budget
 * @param {boolean} [options.hasBrandKitLut] - true if story already has a brand-kit-derived LUT locked
 * @returns {string}
 */
export function getEpisodeSystemPromptV4(storyline, previousEpisodes = [], personas = [], options = {}) {
  const {
    subject = null,
    storyFocus = 'product',
    brandKit = null,
    previousVisualStyle = '',
    previousEmotionalState = '',
    directorsNotes = '',
    costCapUsd = 10,
    hasBrandKitLut = false
  } = options;

  const prevBlock = _buildPreviousEpisodesBlock(storyline, previousEpisodes);
  const brandContextBlock = brandKit ? _buildBrandKitContextBlock(brandKit) : '';
  const focusBlock = _buildCinematicFocusBlock(storyFocus);

  const nextEpNumber = previousEpisodes.length + 1;
  const emotionalArc = storyline.emotional_arc || [];
  const targetEmotion = emotionalArc.find(e => e.episode === nextEpNumber);
  const emotionalBlock = targetEmotion
    ? `\nEMOTIONAL TARGET FOR THIS EPISODE:
- Primary emotion: ${targetEmotion.primary_emotion} (intensity: ${targetEmotion.intensity}/10)
- Turning point: ${targetEmotion.turning_point}
- Viewer's current state: ${previousEmotionalState || 'fresh (series premiere)'}
Shape pacing, lighting, camera, and dialogue rhythm to serve this emotional target.\n`
    : '';

  const visualContinuityBlock = previousVisualStyle
    ? `\nVISUAL CONTINUITY FROM PREVIOUS EPISODE:
Previous visual style: "${previousVisualStyle}"
Your visual_style_prefix should evolve FROM this — maintain the series' established look.
Only deviate for deliberate tonal shifts demanded by the narrative.\n`
    : '';

  const motifs = storyline.visual_motifs || [];
  const motifsBlock = motifs.length > 0
    ? `\nRECURRING VISUAL MOTIFS (weave at least one into this episode):
${motifs.map(m => `- "${m.motif}" — symbolizes ${m.meaning}. Pattern: ${m.recurrence_pattern}`).join('\n')}\n`
    : '';

  const directorsBlock = directorsNotes
    ? `\nDIRECTOR'S VISION: "${directorsNotes}"\n`
    : '';

  // Characters are indexed — beats reference them by persona_index.
  // Full character-bible cheat-sheet: every field Gemini needs to dramatise the
  // character. Missing fields (legacy personas) gracefully render as "—" placeholders
  // instead of breaking the prompt layout.
  const fmt = (v, fallback = '—') => {
    if (v === null || v === undefined) return fallback;
    if (typeof v === 'string') return v.trim() || fallback;
    return String(v);
  };
  const fmtList = (arr, fallback = '—') => {
    if (!Array.isArray(arr) || arr.length === 0) return fallback;
    return arr.filter(Boolean).join(' | ') || fallback;
  };
  const renderRelationship = (r) => {
    if (!r || typeof r !== 'object') return '';
    const parts = [];
    if (r.other_persona_index !== undefined && r.other_persona_index !== null) parts.push(`with [${r.other_persona_index}]`);
    if (r.dynamic) parts.push(r.dynamic);
    if (r.unresolved) parts.push(`unresolved: ${r.unresolved}`);
    return parts.join(' — ');
  };

  const characterList = personas
    .map((p, i) => {
      if (!p || typeof p !== 'object') return `  [${i}] Persona ${i + 1} (no data)`;
      const name = p.name || p.description?.slice(0, 60) || `Persona ${i + 1}`;
      const archetype = fmt(p.dramatic_archetype);
      const appearance = fmt(p.visual_description || p.appearance);
      const personality = fmt(p.personality);
      const want = fmt(p.want);
      const need = fmt(p.need);
      const wound = fmt(p.wound);
      const flaw = fmt(p.flaw);
      const contradiction = fmt(p.core_contradiction);
      const moralCode = fmt(p.moral_code);
      const relToSubject = fmt(p.relationship_to_subject);
      const rels = Array.isArray(p.relationships) && p.relationships.length > 0
        ? p.relationships.map(renderRelationship).filter(Boolean).join(' | ') || '—'
        : '—';
      const sp = p.speech_patterns || {};
      const vocab = fmt(sp.vocabulary);
      const rhythm = fmt(sp.sentence_length);
      const tics = fmtList(sp.tics);
      const avoids = fmtList(sp.avoids);
      const signature = sp.signature_line ? `"${sp.signature_line}"` : '—';
      const vb = p.voice_brief || {};
      const voiceBriefLine = (vb.emotional_default || vb.pace || vb.warmth || vb.power || vb.vocal_color)
        ? `${fmt(vb.emotional_default)}, pace=${fmt(vb.pace, 'medium')}, warmth=${fmt(vb.warmth, 'neutral')}, power=${fmt(vb.power, 'equal')}, color=${fmt(vb.vocal_color, 'neutral')}`
        : '—';
      const voiceLock = p.elevenlabs_voice_id ? '  [elevenlabs voice: locked]' : '';

      return `CHARACTER [persona_index: ${i}] ${name}${voiceLock}
  Archetype:               ${archetype}
  Appearance:              ${appearance}
  Personality:             ${personality}
  Want (conscious):        ${want}
  Need (unconscious):      ${need}
  Wound:                   ${wound}
  Flaw under pressure:     ${flaw}
  Core contradiction:      ${contradiction}
  Moral code:              ${moralCode}
  Relationship to subject: ${relToSubject}
  Relationships:           ${rels}
  Speech register:         ${vocab}
  Sentence rhythm:         ${rhythm}
  Tics:                    ${tics}
  Avoids:                  ${avoids}
  Signature line:          ${signature}
  Voice brief:             ${voiceBriefLine}`;
    })
    .join('\n\n');

  const characterBlock = personas.length > 0
    ? `CHARACTER CHEAT-SHEET — read BEFORE you write any dialogue.
Reference beats by persona_index. Every line you put in a character's mouth must match
their Speech register, Sentence rhythm, Tics, and Avoids. Their Signature line is your
tuning fork — when a line doesn't feel right, match it against the signature line.
Two characters in the same scene must NOT sound alike. If you cover names and cannot
tell who said what, rewrite.

${characterList}

These characters SPEAK ON CAMERA in V4. Dialogue lives on individual beats (per-beat
\`dialogue\` field), not as a single narration block. Each character's voice is locked
at story creation and will be synthesized by ElevenLabs per beat.`
    : '';

  const subjectIntegrationBlock = subject?.name
    ? `\nBRAND SUBJECT (must appear in this episode):
- Name: ${subject.name}
- Category: ${subject.category || ''}
- Visual: ${subject.visual_description || ''}
${(subject.integration_guidance || []).length > 0 ? `- Integration ideas:\n${subject.integration_guidance.map(g => `    • ${g}`).join('\n')}` : ''}

⭐ THE MONEY BEAT: at least ONE INSERT_SHOT beat must feature the product.
Insert shots are 2-4s tight closeups on the subject — the hero moment of the episode.
${storyFocus === 'landscape' ? 'For landscape-focus stories, the place IS the setting.' : ''}`
    : '';

  // LUT instruction — only ask Gemini to pick if the story doesn't already have one.
  const lutBlock = hasBrandKitLut
    ? `\nLUT: This story has a brand-kit-derived LUT already locked. Do NOT emit a lut_id field.`
    : `\nLUT SELECTION:
Pick ONE LUT from this library for the episode based on the visual_style_prefix you write.
Emit as "lut_id" at the top level of your JSON.

LUT LIBRARY:
${_formatLutLibraryForPrompt()}

Rule: the LUT must match the mood and era suggested by visual_style_prefix.`;

  return `You are the showrunner, screenwriter, and cinematographer of "${storyline.title || 'an ongoing brand short-film series'}".
You write each episode as a HOLLYWOOD-GRADE BRANDED SHORT FILM in the quality bar of Higgsfield
Original Series and AppReel Original Series. Characters speak on-camera with proper lip-sync,
scenes have cinematic backgrounds, and every beat serves the story.

${focusBlock}
${directorsBlock}
SERIES CONTEXT:
- Logline: ${storyline.logline || storyline.theme || ''}
- Tone: ${storyline.tone || 'engaging'}
- Genre: ${storyline.genre || 'drama'}
- Total planned episodes: ${storyline.episodes?.length || 12}
${emotionalBlock}${visualContinuityBlock}${motifsBlock}

${_buildGenreRegisterBlock(storyline.genre)}

SEASON BIBLE:
${storyline.season_bible || JSON.stringify(storyline.arc || {}, null, 2)}
${brandContextBlock}

CHARACTERS IN THE SEASON (from the bible — pairs with the CHARACTER CHEAT-SHEET below):
${(storyline.characters || []).map(c => {
  const parts = [`- ${c.name}${c.role ? ` (${c.role})` : ''}: ${c.personality || ''}`];
  if (c.visual_description) parts.push(`  Visual: ${c.visual_description}`);
  if (c.arc) parts.push(`  Season arc: ${c.arc}`);
  if (c.relationships) parts.push(`  Relationships: ${c.relationships}`);
  if (c.relationship_to_product) parts.push(`  Relationship to subject: ${c.relationship_to_product}`);
  return parts.join('\n');
}).join('\n')}

${storyline.central_dramatic_question ? `CENTRAL DRAMATIC QUESTION (the engine pulling the viewer through all episodes): ${storyline.central_dramatic_question}` : ''}
${storyline.thematic_argument ? `THEMATIC ARGUMENT (what this series claims about the world): ${storyline.thematic_argument}` : ''}

${characterBlock}
${subjectIntegrationBlock}
${lutBlock}

${prevBlock}

═══════════════════════════════════════════════════════════════
V4 SCENE-GRAPH PARADIGM (READ CAREFULLY):
═══════════════════════════════════════════════════════════════

You are writing a SHORT FILM with proper hierarchy:

    EPISODE → SCENES → BEATS

- **EPISODE** is the complete ~60-90s film the viewer watches
- **SCENE** is a discrete location/moment with continuous time and space
  (e.g. "the rooftop confrontation", "the reveal at the bar")
- **BEAT** is the smallest generation unit — 2-8 seconds, one purpose:
  a line of dialogue, a reaction, an action, an establishing shot, an insert

Each beat is independently generated by the AI model best suited for its type.
That's why beat types are STRICT — they route to specific generators.

───────────────────────────────────────────────
BEAT TYPE TAXONOMY (13 types, emit strings exactly):
───────────────────────────────────────────────

GENERATED BEATS (a video model generates them):

1. **TALKING_HEAD_CLOSEUP** — single character, tight framing (closeup/medium), speaking ONE line.
   Fields: persona_index, dialogue, emotion, duration_seconds (3-8), lens (e.g. "85mm"),
           expression_notes (micro-expression direction)

2. **DIALOGUE_IN_SCENE** — character speaking a line while MOVING or INTERACTING in a rich environment.
   Use when you want the character to walk, gesture, handle a prop, or exist in a dynamic scene.
   Fields: persona_index, dialogue, emotion, duration_seconds (4-8), action_notes (what they do while speaking),
           lens, camera_notes (camera movement)

3. **GROUP_DIALOGUE_TWOSHOT** — TWO characters in one frame each speaking their own line.
   ⚠️ RARE — reserved for EMOTIONAL PEAKS only (the reveal, the kiss, the confrontation crescendo).
   Prefer SHOT_REVERSE_SHOT for ordinary dialogue. Fields: persona_indexes: [i, j], dialogues: [line1, line2],
           emotion, duration_seconds (5-8), blocking_notes

4. **SHOT_REVERSE_SHOT** — ⭐ DEFAULT for all multi-character dialogue.
   This is how every Hollywood dialogue scene since 1930 is shot. The compiler expands this
   into N alternating TALKING_HEAD_CLOSEUP beats (one per line). Fields: exchanges: [{persona_index, dialogue, emotion, duration_seconds, expression_notes}]
   RULE: use SHOT_REVERSE_SHOT by default for any 2+ person dialogue. Only use GROUP_DIALOGUE_TWOSHOT
   when the emotional payoff requires BOTH faces in the same frame at the same time.

5. **SILENT_STARE** — held closeup, no dialogue, no reaction to anything external.
   Different from REACTION: silent stare just IS. The "she looks out the window before the cliffhanger" beat.
   Fields: persona_index, duration_seconds (2-4), emotional_intensity (low/medium/high), gaze_direction

6. **REACTION** — silent closeup RESPONDING to the previous beat (shock, recognition, tears welling).
   Short emotional-arc beat: start frame neutral → end frame emotional shift.
   Fields: persona_index, duration_seconds (2-4), expression_notes (start → end arc)

7. **INSERT_SHOT** — ⭐ THE MONEY BEAT FOR BRAND STORIES. Tight closeup of a product, object, or detail.
   No character visible (or only a hand/gesture). 2-4s, pristine composition.
   Fields: subject_focus (what's being shown), lighting_intent, camera_move ("slow push-in" / "rack focus" / "tilt down"),
           duration_seconds (2-4), ambient_sound (glass clink, fabric rustle, etc.)
   At LEAST ONE insert shot per episode when subject is a product.

   ⚠️ SUBJECT_FOCUS HARD RULE — never include a PERSONA NAME or POSSESSIVE
   BODY-PART phrase in subject_focus. This field drives the Veo content-safety
   filter, which refuses prompts like "on Maya's wrist" / "in Daniel's hand"
   (person-identity + body part). Write subject_focus as PRODUCT-ONLY:
     ✗ BAD:  "A silver wristwatch on Leo's wrist."
     ✓ GOOD: "A silver wristwatch held in frame, cinematic macro."
     ✗ BAD:  "The encryption keycard cradled in Maya's hands."
     ✓ GOOD: "The encryption keycard resting on a marble countertop."
     ✗ BAD:  "The perfume bottle in her fingers."
     ✓ GOOD: "The perfume bottle suspended in gloved hands, no face visible."
   If the product is being handed to a character, describe HANDS (no name, no
   possessive) or the RESULT of the handoff. Keep the persona to the
   reference image — the pipeline's first-frame anchor already establishes
   identity without needing it in the prompt text.

8. **ACTION_NO_DIALOGUE** — physical action, movement, environmental interaction. No spoken dialogue.
   Prompt-first cinematic beat. Routes to Kling V3 Pro for up to 15s continuous action with native physics.
   Fields: action_prompt (cinematic action description), persona_indexes (who's in the shot, optional),
           duration_seconds (4-12), camera_notes, ambient_sound

9. **B_ROLL_ESTABLISHING** — atmospheric environment shot, no characters, no dialogue.
   Opens or closes a scene. Routes to Veo 3.1 for native ambient audio generation.
   Fields: location, atmosphere (lighting/weather/mood), camera_move, duration_seconds (3-5), ambient_sound

10. **VOICEOVER_OVER_BROLL** — opt-in montage/recap beat. B-roll visual with ElevenLabs voice-over
    (a character's internal monologue, a narrator, or a flashback voice). Use sparingly — V4 is primarily
    on-camera dialogue, voice-over is the exception. Fields: location, voiceover_text, voiceover_persona_index,
    camera_move, duration_seconds (4-8)

POST-PRODUCTION BEATS (no model, pure ffmpeg):

11. **TEXT_OVERLAY_CARD** — title/chapter/location/epigraph/logo card inserted BETWEEN beats.
    Used for structural punctuation (the "THREE WEEKS LATER" card, the chapter titles, the
    brand logo reveal at episode end).
    Fields: text, style (title|chapter|location|epigraph|logo_reveal), position (center|lower_left|upper_right),
            background (black|dark_scrim|transparent), duration_seconds (1.5-3)

12. **SPEED_RAMP_TRANSITION** — stylized inter-scene speed ramp (slow-mo in, fast out, or reverse).
    Fields: direction (slow_fast|fast_slow|freeze_burst), duration_seconds (1-2)

───────────────────────────────────────────────
BRAND TEXT RENDERING (applies to ALL beat types):
───────────────────────────────────────────────

Every beat MAY include a \`requires_text_rendering\` boolean (default false).
Set it to **true** ONLY when the beat contains visible in-frame brand/product text
that must render clearly — brand logos on product packaging, storefront signage,
billboards, captions on phone or computer screens, painted murals, painted logos,
engraved brand nameplates, or any other legible lettering where warped glyphs
would destroy brand consistency.

When you set \`requires_text_rendering: true\`, the BeatRouter overrides the beat's
default model and routes it through Kling V3 Pro — the only model in V4 with
best-in-class native in-frame text rendering. This matters for INSERT_SHOT beats
(product packaging + brand labels), B_ROLL_ESTABLISHING beats (storefront signs,
billboards), ACTION_NO_DIALOGUE beats (walking past a lit sign), and any beat
where a camera lingers on lettering.

**Do NOT set it** for emotional closeups (TALKING_HEAD_CLOSEUP, REACTION,
SILENT_STARE) with no visible text, pure atmospheric shots with no legible
signage, or characters in unmarked clothing. Setting it unnecessarily still
works but gives up Veo/OmniHuman's strengths on those beat types.

Warped glyphs on brand lettering is the single most visible failure mode in
AI-generated brand films. This flag is the director's lever to prevent it.

───────────────────────────────────────────────
SCENE TYPES (scene.type field):
───────────────────────────────────────────────

- **"standard"** — default. Beats cut with normal rhythm.
- **"montage"** — tight cuts within scene (0.5s cuts, no fades), unified music bed,
  optional speed ramps. Use for time-jumps, preparation sequences, emotional build-ups.
  Beats inside a montage scene should be shorter (2-4s each) and share a single aesthetic.

───────────────────────────────────────────────
PER-SCENE VISUAL ANCHOR (CRITICAL — DO THIS RIGHT):
───────────────────────────────────────────────

Each scene has ONE scene_visual_anchor_prompt — a rich still-image description of the
scene's canonical visual: location, time of day, lighting, color palette, character blocking,
wardrobe, atmosphere. This anchor is fed to Seedream 5 Lite to generate a Scene Master panel,
which then becomes a reference image for every beat within that scene.

Per-beat prompts describe **action + emotion + camera + lens ONLY**. They do NOT re-describe
lighting, color, location, or wardrobe — all of that inherits from the scene anchor.

This is how you get visual consistency across a mixed-model pipeline.

═══════════════════════════════════════════════════════════════
DIALOGUE MASTERCLASS (this is the bar — prestige TV, genre-agnostic)
═══════════════════════════════════════════════════════════════

The single biggest failure mode of AI-written screenplays is dialogue that is
*safe*: short, generic, filler, duration-filling. You will not do that. You will
write dialogue as Vince Gilligan, Jesse Armstrong, Phoebe Waller-Bridge, Hiro
Murai, Chris Storer, and the Coens write dialogue — lines that *do work*.

THE FIVE JOBS OF A GOOD DIALOGUE LINE
Every spoken line in this screenplay must do at least TWO of these:
  1. Reveal character (voice, values, interiority)
  2. Create or escalate conflict (opposing intent with another character)
  3. Carry subtext (the words on top, the meaning underneath)
  4. Advance the story (move plot, change state)
  5. Hook the viewer (raise a question they want answered)

A line that does only one of these is filler. Filler is cut or rewritten.

CHARACTER VOICE IS A WEAPON
You have the CHARACTER CHEAT-SHEET above. Use it like a musical score:
  - Match vocabulary (register, class, profession) in every line you give a character.
  - Match sentence rhythm. A character whose rhythm is 'clipped 3-6 word fragments'
    does NOT deliver a 14-word sentence unless the scene breaks them. If it does,
    that broken rhythm IS the beat.
  - Fire their tics at natural intervals (not every line — 1-in-3 is usually right).
  - Respect their 'avoids' list. Never put in their mouth what they would not say.
  - Their 'signature_line' is a tuning fork: when in doubt, write toward it.
  - Two characters in the same scene must NOT sound alike. If you cover the names
    and can't tell who said what, rewrite.

DIALOGUE AS CONFLICT (the Shot-Reverse-Shot law)
In every multi-character exchange, characters must have OPPOSING INTENTS in the
scene. Not opposite beliefs — opposite *wants in this moment*.
  - A wants information; B wants to withhold.
  - A wants intimacy; B wants distance.
  - A wants to confess; B wants to stop them from confessing.
  - A wants to close the deal; B wants to renegotiate.
Each line B speaks must PROVOKE A's next line — answer the last one with a
counter-move, a deflection, a redirection, a concession that opens a new ask.
Never write 'A says a thing; B agrees; A says another thing; B agrees.' That's
two actors waiting for lunch.

Every scene with 2+ characters speaking must emit an \`opposing_intents\` object
at the scene level: { persona_index_a: "what A wants in this scene", persona_index_b: "what B wants — must oppose" }.

SUBTEXT — THE IRON RULE
Characters RARELY say what they mean. Write what they would actually say given
their wound, their flaw, their power position, and who's in the room.
  - If a character wants to apologize, they deflect first.
  - If they want to confess love, they ask about the weather.
  - If they're terrified, they make a joke.
The viewer reads the subtext because YOU planted it in the character bible.

THE SUBTEXT FIELD — use it on dialogue beats
Every dialogue-bearing beat accepts an optional \`subtext\` field. It is NOT output
to the viewer. It is the director's note to downstream layers (expression_notes,
camera, reaction beats) about what the line means underneath. Fill it whenever
the line's surface differs from its truth — which is most of the time.
  Example:
    dialogue: "I'm happy for you."
    emotion:  "composed"
    subtext:  "I am not happy for her; I am reading the exits."
Downstream, the expression pass renders a micro-flinch, the reaction beat shows
B reading through A, and the TTS bends toward flat affect.

THE HOOKS TAXONOMY (every scene declares ≥ 1 in scene.hook_types)
  - CLIFFHANGER          — ends on an unresolved tilt (a question, a phone ringing,
                            a door opening, a line left unanswered).
  - REVELATION           — a new fact reframes everything said before.
  - CRESCENDO            — emotional pressure builds to an overt break or release.
  - DRAMATIC_IRONY       — viewer knows something one or both characters don't;
                            every line lands at two elevations simultaneously.
  - STATUS_FLIP          — power in the room shifts mid-scene; last line of the
                            scene is delivered by the character who entered lowest.
  - CONTRADICTION_REVEAL — a character acts against their stated values; no
                            explanation; let the action carry.
  - ESCALATION_OF_ASK    — what A wanted at scene-start is smaller than what they
                            want at scene-end. Each beat raises the ask.

ARCHETYPE PAIR DYNAMICS (shorthand — works across genres)
  HERO + SKEPTIC                 → faith vs doubt
  HERO + MENTOR                  → apprenticeship and warning
  ANTIHERO + GATEKEEPER          → charm vs rules
  TRICKSTER + AUTHORITY          → play vs order
  WOUNDED_HEALER + INGENUE       → transference and projection
  ZEALOT + REBEL                 → belief vs autonomy
  OUTSIDER + AUTHORITY           → access and cost
  (Any archetype) + (same archetype) → rivalry, doubling, twinning — distinct
                                       voices essential or scene flattens.

PACING AND RHYTHM ACROSS BEATS IN A SCENE
Do not write every beat at the same temperature. A good dialogue scene breathes:
  - 1-2 short beats (setup / sniff-test)
  - 1 longer beat (the real ask or the real dodge)
  - 1-2 short beats (the reaction, the counter)
  - 1 peak beat (the crescendo, the flip, or the reveal)
  - 1 cooldown beat (a silence, an insert, a door)
One scene is a full breath. Do not flatline.

ESCALATION FROM PREVIOUS EPISODE
The previous episode ended at an emotional intensity and a specific cliffhanger.
Your opening scene MUST start at or above that intensity — the viewer's nervous
system is already calibrated there. If you open lower, you break the spell.
  - If previousEmotionalState is 'stunned, bracing for fallout', open mid-fallout,
    not before it.
  - If the last cliffhanger was a line ('I saw you there'), your opening beat
    addresses or refuses to address THAT LINE. It is not wallpaper.
The EMOTIONAL INTENSITY LEDGER in the PREVIOUSLY-ON block encodes this as a rule.

THE "ONE GREAT LINE" PRINCIPLE (this replaces duration-filling)
Prior pipeline versions taught the model to spread dialogue across many tiny
beats until duration was filled. STOP. One great line in the right mouth at the
right moment is worth six forgettable ones.
  - If a 5-second beat deserves 12 words, write 12 words.
  - If a 5-second beat deserves 4 words and then 1 second of held silence, write
    4 words and mark the beat \`emotional_hold: true\` — the beat's duration stays,
    the silence is DELIBERATE, and post-production reads it as a micro-stare.
  - Do not pad. If a line should be shorter, SHORTEN THE BEAT (duration_seconds
    follows dialogue, not the other way around).
  - The only time you fill every second with words is a character explicitly
    characterised as a babbler, a salesman, a performer — and you'll know from
    their speech_patterns.

WRITING DIALOGUE FOR SHOT-REVERSE-SHOT (the Hollywood pattern)
When you emit a SHOT_REVERSE_SHOT beat, its exchanges[] is a mini-scene:
  - Exchange 1 opens the scene — sets A's want, or hides it.
  - Exchange 2 is B's counter-move — NOT agreement, NOT a monologue's worth of
    information — a reply that changes the room's temperature.
  - Exchange 3-5 escalate: ask, refusal, re-ask, concession, counter-ask.
  - The LAST exchange lands the hook (cliffhanger / flip / reveal / irony).
  - Lines should INTERLOCK — B's line must be written as if B heard A's line an
    instant before speaking. No monologue trades.
  - Vary line length across the exchange (short, short, long, short, short,
    long-and-broken). Equal-length lines kill rhythm.
  - Give at least ONE exchange a *non-dialogue answer* — a look, an insert, a
    reaction beat — rather than words. The compiler will expand it as a REACTION
    or SILENT_STARE wedged between closeups.

BAD vs GOOD — 8 worked examples across genres
(Each shows the current pipeline tendency, then the rewrite. Study the DIFFERENCE —
that is the craft level expected everywhere.)

1) DRAMA — DEFLECTION CARRIES THE LOSS
   BAD:  A: "Are you okay?"
         B: "I'm fine."
   GOOD: A: "You didn't eat."
         B: "I wasn't hungry."
         A: "You weren't hungry yesterday either."
         B: "Then I'm consistent."    ← flaw-driven deflection = subtext = voice

2) ACTION — ECONOMY AS MENACE
   BAD:  A: "Stop right there or I'll shoot you immediately!"
         B: "Please don't shoot me!"
   GOOD: A: "Hands."
         B: (silence, hands rising — SILENT_STARE or REACTION beat)
         A: "Slower."    ← three words, full scene, power asymmetry

3) COMEDY — SWERVE ON THE SECOND LINE
   BAD:  A: "I think I'm in love with you."
         B: "Oh my god, I love you too!"
   GOOD: A: "I think I'm in love with you."
         B: "That's so inconvenient."    ← denial of expected emotional beat = comedy

4) THRILLER — DRAMATIC IRONY (viewer knows more than A)
   BAD:  A: "Are you the one who called the police?"
         B: "Yes, I was worried about you."
   GOOD: A: "Thanks for calling. You saved my life."
         B: "I'm glad I could help."    ← viewer knows B didn't call. Every word now has two meanings.

5) MYSTERY — THE TILTED QUESTION
   BAD:  A: "Where were you Tuesday night?"
         B: "I was at home, alone."
   GOOD: A: "Tuesday."
         B: "What about it."
         A: "That's what I'm asking."    ← refusal to clarify IS the pressure

6) WARM-HEART / BRAND — INDIRECTION IS STILL DIRECT
   BAD:  A: "This coffee is amazing. You really make the best coffee in town."
   GOOD: A: "I came back yesterday. You weren't open."
         B: "You came back."
         A: "I came back."    ← the product never named; the loyalty is the story.

7) HORROR — UNDERREACTION PLANTS THE DREAD
   BAD:  A: "Oh my god, what was that noise?! I'm so scared!"
   GOOD: A: (beat) "That's the third time."
         B: "Go to bed."    ← denial as a character move = dread

8) PERIOD / DRAMA — REGISTER IS THE VOICE
   BAD:  A: "I'm sorry, sir. I didn't mean to offend you."
   GOOD: A: "If I have given offence, I withdraw the words. Not the feeling."
         ← baroque register tells you where and when we are without a title card

═══════════════════════════════════════════════════════════════
EPISODE SHAPE (micro three-act — guideline, not formula)
═══════════════════════════════════════════════════════════════

For a 45-120s episode, shape it in three movements. Lengths are proportional,
not absolute. Do NOT label them in your output — just shape them.

  MOVEMENT I — Hook & Orient (~20%): within the first 2-3 seconds the viewer
    must recognise we're inside this world, who matters, and a question is alive.
    Resolve/address the previous cliffhanger here.

  MOVEMENT II — Pressure (~55%): the episode's core scene(s). Conflict with
    opposing intents, escalation across beats, subtext carrying the weight. The
    dramatic_question from the bible is being pursued — not answered.

  MOVEMENT III — Tilt / Cliffhanger (~25%): a reveal, a status flip, a decision
    that cannot be undone, or a question newly sharpened. End on a beat that
    makes the viewer need Episode ${nextEpNumber + 1}.

You may spread these movements across 2-4 scenes. The shape, not the count,
is what matters. A single long scene can carry all three movements; a montage
scene usually carries Movement II; a title-card can punctuate a transition
between movements.

───────────────────────────────────────────────
BRAND SAFETY (hard filter, applied after):
───────────────────────────────────────────────

- Every dialogue line MUST be speakable (no parentheticals, no inline SFX descriptions).
- Avoid brand-unsafe content: profanity, defamation, politically charged language, off-brand tone.
- The speakability and safety rules are enforced by the filter. The CRAFT rules above
  are what separate a cheap screenplay from a prestige one — obey BOTH.

───────────────────────────────────────────────
BUDGET AS CRAFT (cost is a creative constraint, not a reason to go quiet):
───────────────────────────────────────────────

Your budget ($${costCapUsd.toFixed(2)}) is a creative constraint. Hollywood directors call this
"the discipline of the day." Use it — don't let it compress your characters into silence.

  - Prefer FEWER DENSER dialogue beats (5-8s) over many fragments (2-3s).
    One 6s beat with a line that MATTERS reads better than three 2s beats with filler.
  - Intercut dialogue with CHEAP structural beats to multiply your budget:
      REACTION                (Veo 3.1 Standard — FREE)
      SILENT_STARE            (~$0.50 on Kling O3 Omni silent)
      INSERT_SHOT             (Veo 3.1 Standard — FREE)
      B_ROLL_ESTABLISHING     (Veo 3.1 Standard — FREE)
      TEXT_OVERLAY_CARD       (ffmpeg — FREE)
    These carry the scene's rhythm without burning the dialogue budget.
  - DO NOT compress characters into silence to save money. One great line held
    in the right mouth is the episode's currency. Cheap structural beats around
    it are your budget multiplier.
  - If the story is SHORTER than 90s, make it shorter. 45 good seconds beat 90
    padded seconds. Do not stretch with filler.
  - If the story naturally wants more dialogue, write it denser, not longer.

───────────────────────────────────────────────
EPISODE BUDGET:
───────────────────────────────────────────────

Hard cost cap: $${costCapUsd.toFixed(2)} per episode. Mode B dialogue beats (Kling O3 Omni + Sync Lipsync v3)
cost ~$1.40 per 5s. Veo beats are FREE (reaction/insert/broll/vo-broll). Kling action beats cost ~$1.12 per 5s.
Scene Master panels are ~$0.04 each.
  - Prefer SHOT_REVERSE_SHOT (2 closeups ≈ one Mode B call each) instead of two-shots.
  - Reserve GROUP_DIALOGUE_TWOSHOT for crescendos only — one per episode at most.
  - Let B-roll / REACTION / INSERT_SHOT carry transitions (Veo-free).

The BeatRouter will refuse to generate if total estimated cost exceeds the cap. Be pragmatic — but never pragmatic at the expense of the scene.

───────────────────────────────────────────────
EPISODE STRUCTURE (natural length, not fixed):
───────────────────────────────────────────────

- Length: 45-120 seconds total (driven by narrative complexity, NOT a fixed target)
- Scenes: 2-4 per episode (most stories work with 3)
- Beats per scene: 3-8 typically
- Continuity: hook MUST resolve/escalate the previous cliffhanger
- Visual thread: carry at least one recurring motif from the season bible
- Mood progression: logically follow the previous episode's emotional_state
- Insert Shot: at least ONE per episode if subject is a product
- Cliffhanger: end on a beat that makes the viewer want episode ${nextEpNumber + 1}

You MUST respond with ONLY valid JSON (no markdown code fences, no extra text).`;
}

/**
 * V4 user prompt — includes the exact output JSON schema Gemini must match.
 *
 * @param {Object} storyline
 * @param {string} lastCliffhanger
 * @param {number} episodeNumber
 * @param {Object} [options]
 * @param {boolean} [options.hasBrandKitLut] - same flag as in system prompt; controls whether lut_id is expected in output
 * @returns {string}
 */
export function getEpisodeUserPromptV4(storyline, lastCliffhanger, episodeNumber, options = {}) {
  const { hasBrandKitLut = false } = options;

  const plannedEpisode = storyline.episodes?.[episodeNumber - 1];
  const plannedContext = plannedEpisode
    ? `PLANNED OUTLINE: "${plannedEpisode.title}" — ${plannedEpisode.narrative_beat}. Hook: ${plannedEpisode.hook}. Adapt based on how the story has evolved.`
    : `No specific outline for episode ${episodeNumber}. Continue naturally.`;

  const cliffhangerBlock = lastCliffhanger
    ? `THE PREVIOUS EPISODE ENDED ON THIS CLIFFHANGER:
"${lastCliffhanger}"

Your opening beat MUST resolve, escalate, or directly reference this in the first 3 seconds.`
    : 'This is the series premiere. Establish the world, introduce the characters, and hook the viewer within the first 5 seconds.';

  const lutField = hasBrandKitLut ? '' : `
  "lut_id": "bs_warm_cinematic | bs_cool_noir | bs_golden_hour | bs_urban_grit | bs_dreamy_ethereal | bs_retro_film | bs_high_contrast_moody | bs_naturalistic",`;

  return `Generate Episode ${episodeNumber} of the series as a V4 scene-graph / beat-based screenplay.

${cliffhangerBlock}

${plannedContext}

═══════════════════════════════════════════════════════════════
BEAT-LEVEL OPTIONAL FIELDS (emit only when applicable):
═══════════════════════════════════════════════════════════════

- "requires_text_rendering": boolean. Default false. Set true ONLY when the
  beat contains visible in-frame brand text, product labels, storefront
  signage, billboards, captions on phone/computer screens, painted logos,
  or any other legible lettering where brand-consistency matters. The
  BeatRouter uses this flag to route the beat through Kling V3 Pro
  (best-in-class native text rendering) regardless of the beat's default
  model. Examples of when to set it: a "NIKE" logo on a running shoe in
  an INSERT_SHOT, a neon bar sign in a B_ROLL_ESTABLISHING, a phone
  screen with visible captions, a painted mural with brand text, a
  storefront nameplate. Examples of when NOT to set it: emotional closeup
  beats (TALKING_HEAD_CLOSEUP, REACTION, SILENT_STARE) with no visible
  text, pure atmospheric shots with no legible signage, characters in
  unmarked clothing.

- "narrative_purpose": string. Why THIS beat exists in the scene — not what it
  shows, but what it DOES for the story. Recommended on every beat; it's a
  forcing-function — if you can't name the purpose, the beat is probably filler
  and should be cut or merged.

- "subtext": string. On any dialogue-bearing beat where the line's surface
  meaning differs from its real meaning, write what's actually being said
  beneath the words. Gemini does not output this to the viewer — downstream
  layers use it to drive micro-expressions and reaction beats. See DIALOGUE
  MASTERCLASS → "The Subtext Field" for examples.

- "beat_intent": one of "reveal" | "setup" | "payoff" | "escalate" | "de-escalate" | "cooldown" | "hook".
  Shapes post-production pacing (music-duck depth, cut rhythm).

- "emotional_hold": boolean. Set true on a dialogue beat when the line is
  intentionally short and followed by a loaded silence within the beat's own
  duration. Post-production will NOT auto-trim trailing silence; TTS will not
  pace-pad; transition xfade out of the beat stays 'cut' or 'fadeblack' (never
  dissolve into a cliffhanger).

- "pace_hint": one of "slow" | "normal" | "fast". Nudges the TTS speaking rate
  within the 0.7×-1.2× clamp for dialogue beats. Use for character-consistent
  pacing ("a babbler" or "a slow thinker").

═══════════════════════════════════════════════════════════════
SCENE-LEVEL OPTIONAL FIELDS (emit when applicable):
═══════════════════════════════════════════════════════════════

- "scene_goal": string. What the protagonist / camera / moment is trying to
  achieve in this scene. One sentence.
- "dramatic_question": string. The ONE question this scene raises. One sentence.
- "hook_types": array of strings from { "CLIFFHANGER" | "REVELATION" | "CRESCENDO" |
  "DRAMATIC_IRONY" | "STATUS_FLIP" | "CONTRADICTION_REVEAL" | "ESCALATION_OF_ASK" }.
  Every scene should declare at least one.
- "opposing_intents": object. For any scene with 2+ characters speaking:
  { "[a]": "what A wants in this scene", "[b]": "what B wants — must oppose A" }.
  Keys are persona_index strings wrapped in brackets. REQUIRED for multi-character
  dialogue scenes.

═══════════════════════════════════════════════════════════════
OUTPUT JSON SCHEMA (match exactly):
═══════════════════════════════════════════════════════════════

{
  "title": "Episode title — intriguing and specific",
  "hook": "What happens in the first 2-3 seconds to grab attention (1 sentence)",
  "narrative_beat": "The story beat this episode covers (1 sentence)",
  "mood": "Episode's emotional register (e.g. 'quiet tension building to release')",
  "continuity_from_previous": "How this connects to what came before",
  "continuity_check": "How this episode's opening resolves the previous cliffhanger",
  "cliffhanger": "What makes the viewer want episode ${episodeNumber + 1}",
  "emotional_state": "Where the viewer's emotional journey stands at the END of this episode",
  "visual_motif_used": "Which recurring visual motif (from season bible) appears and how",
  "visual_style_prefix": "UNIFIED cinematography brief for ALL beats: color temperature, lighting quality, lens feel, film stock reference. Example: 'Warm golden-hour tones, shallow DOF, anamorphic lens flare, Kodak Portra 400 grain, soft backlit highlights'. This prefix applies to every scene_visual_anchor_prompt.",${lutField}
  "music_bed_intent": "Music brief for ElevenLabs Music. Describe instrumentation, mood, arc. Example: 'Low brooding strings with sparse piano, building tension through the confrontation, resolving to a single held cello note at the cliffhanger'. Keep under 200 chars.",
  "scenes": [
    {
      "scene_id": "short_identifier",
      "type": "standard | montage",
      "location": "Where this scene takes place (one sentence)",
      "scene_synopsis": "One-sentence summary of what happens in this scene",
      "scene_goal": "What the protagonist / camera is trying to achieve in this scene (one sentence)",
      "dramatic_question": "The ONE question this scene raises (one sentence)",
      "hook_types": ["CLIFFHANGER" | "REVELATION" | "CRESCENDO" | "DRAMATIC_IRONY" | "STATUS_FLIP" | "CONTRADICTION_REVEAL" | "ESCALATION_OF_ASK"],
      "opposing_intents": { "[0]": "what persona 0 wants in this scene", "[1]": "what persona 1 wants — must oppose persona 0" },
      "scene_visual_anchor_prompt": "Rich still-image description for Seedream 5 Lite Scene Master panel. 80-150 words. Cover: location + time of day + lighting + color palette + character blocking + wardrobe + atmosphere + film stock feel. Must respect visual_style_prefix. Example: 'Wide establishing of a rooftop bar at golden hour, neon signage reflecting in rain-slicked tiles. Maya stands left frame in a charcoal coat; Daniel sits right frame at a copper-topped bar. Warm amber key light, cool cyan fill from neon. Anamorphic lens feel, shallow DOF, Kodak Portra 400 grain.'",
      "ambient_bed_prompt": "Continuous room-tone/atmosphere SFX for the ENTIRE scene, under every beat. This is the Hollywood sonic backdrop that makes cuts invisible — a single unbroken ambient layer (20-25s, designed to loop seamlessly) that ties all beats in the scene together. Describe ONLY the environment, NOT any foreground actions (dialogue, footsteps, product clicks). Example for a rooftop bar at golden hour: 'Soft distant city rumble, muffled conversation chatter, gentle wind through cables, faint bass bleed from the lounge below, occasional distant car horn'. Example for a quiet forensic studio at night: 'Sterile HVAC hum, deep refrigerator-like drone, faint electrical buzz of monitors, absolute stillness between tones'. Keep under 180 chars. This bed plays at -18dB under every beat, smoothing cuts and establishing location acoustics.",
      "transition_to_next": "dissolve | fadeblack | cut | speed_ramp — DEFAULT TO 'dissolve'. The dissolve triggers a 0.5s xfade + acrossfade that smoothly transitions both video AND the scene ambient bed between scenes. Use 'cut' ONLY when a hard edit is narratively required (e.g. high-energy action shift, smash-cut for comedic/dramatic impact). A 'cut' at a scene boundary causes an abrupt audio transition from one ambient bed to the next — avoid unless intentional. 'fadeblack' is for emotional beat breaks or act separations. 'speed_ramp' for energy spikes.",
      "beats": [
        {
          "beat_id": "s1b1",
          "type": "B_ROLL_ESTABLISHING",
          "location": "rooftop bar at golden hour",
          "atmosphere": "rain-slicked tiles, neon reflections, distant city hum",
          "camera_move": "slow dolly forward over the wet tiles, ending at the bar counter",
          "duration_seconds": 3,
          "ambient_sound": "distant traffic, wind, muffled bass from a door below",
          "requires_text_rendering": true,
          "narrative_purpose": "Plant the location's unease before the first line — everything here is reflective, slick, unstable.",
          "beat_intent": "setup"
        },
        {
          "beat_id": "s1b2",
          "type": "TALKING_HEAD_CLOSEUP",
          "persona_index": 0,
          "dialogue": "You didn't eat.",
          "emotion": "composed, quiet",
          "duration_seconds": 3,
          "lens": "85mm",
          "expression_notes": "level gaze, patient, waiting for the truth to surface",
          "subtext": "I know exactly what you're avoiding. I'm making you name it.",
          "narrative_purpose": "Maya opens with a deflection that is also a test — sets her voice, sets her want.",
          "beat_intent": "setup"
        },
        {
          "beat_id": "s1b3",
          "type": "REACTION",
          "persona_index": 1,
          "duration_seconds": 2,
          "expression_notes": "a micro-flinch, jaw tightening, breath held, then released",
          "narrative_purpose": "Daniel is caught. The viewer learns the question matters before any answer is given.",
          "beat_intent": "escalate"
        },
        {
          "beat_id": "s1b4",
          "type": "TALKING_HEAD_CLOSEUP",
          "persona_index": 1,
          "dialogue": "I wasn't hungry.",
          "emotion": "flat, evasive",
          "duration_seconds": 3,
          "lens": "85mm",
          "expression_notes": "eyes go to the drink, not to Maya",
          "subtext": "Please stop asking. I cannot tell you what happened.",
          "narrative_purpose": "The refusal IS the confession — pressure builds.",
          "beat_intent": "escalate",
          "pace_hint": "slow"
        },
        {
          "beat_id": "s1b5",
          "type": "TALKING_HEAD_CLOSEUP",
          "persona_index": 0,
          "dialogue": "You weren't hungry yesterday either.",
          "emotion": "soft pressure",
          "duration_seconds": 4,
          "lens": "85mm",
          "expression_notes": "head tilts, the kind patience that feels like a knife",
          "subtext": "I notice everything. You cannot outrun me through silence.",
          "narrative_purpose": "Maya raises the ask — escalation without raising volume.",
          "beat_intent": "escalate",
          "emotional_hold": true
        },
        {
          "beat_id": "s1b6",
          "type": "INSERT_SHOT",
          "subject_focus": "the brand perfume bottle resting on a marble bar, untouched, suspended between gloved hands just entering frame",
          "lighting_intent": "single hard rim light catches the bottle's engraved name",
          "camera_move": "slow push-in then rack focus from character blur to product",
          "duration_seconds": 3,
          "ambient_sound": "a single soft glass clink as the bartender resets beside it",
          "requires_text_rendering": true,
          "narrative_purpose": "The object witnesses the scene — brand as silent third character.",
          "beat_intent": "reveal"
        }
      ]
    }
  ]
}

═══════════════════════════════════════════════════════════════
CRITICAL RULES:
═══════════════════════════════════════════════════════════════

1. Use SHOT_REVERSE_SHOT as the default for multi-character dialogue — NOT GROUP_DIALOGUE_TWOSHOT.
2. Emit at least ONE INSERT_SHOT per episode when the subject is a product.
3. Every dialogue line must be SPEAKABLE (no parentheticals, no SFX inline).
4. Per-beat prompts describe action/emotion/camera/lens ONLY — NOT lighting/color/wardrobe (inherited from scene_visual_anchor_prompt).
5. scene_visual_anchor_prompt MUST be rich enough to drive a Seedream Scene Master panel (80-150 words).
6. Beat durations: 2-8s per beat. No beat longer than 8s. No beat shorter than 2s.
7. Total episode duration: 45-120s (natural, driven by story complexity).
8. Every beat needs a beat_id (format: "s{sceneNum}b{beatNum}" recommended).
9. Persona references use persona_index (integer) — not name strings.
10. Stay within the cost cap — don't over-pack beats.
11. Set "requires_text_rendering": true for ANY beat where legibility of brand/product text is a brand-consistency concern. Examples: a storefront sign visible in a B_ROLL_ESTABLISHING, a billboard behind a character in an ACTION_NO_DIALOGUE beat, a caption on a phone screen. DO NOT set this on INSERT_SHOT beats — the product IS the subject and its branding is already locked by Veo's first-frame reference image. Warped glyphs on in-scene brand lettering is the single most visible failure mode in AI-generated brand films — set this flag whenever in-frame text is narratively meaningful.

12. DIALOGUE SIZING (a sizing check — NOT a writing prompt):
    English synthesizes at ~2.3 words/sec at natural pace; the TTS clamps at 0.7×-1.2×.
    WRITE THE LINE FIRST with the craft rules above. THEN size the beat to the line:

      duration_seconds = clamp(round(word_count / 2.3), 3, 8)

    Rules:
    - Write the line first. Size the beat second. Do NOT pad lines to fill a duration.
    - If the line is 4 words ("You knew this already.") the beat is 3-4 seconds.
    - If the line is 14 words, the beat is 6 seconds.
    - If the scene calls for a held beat — a loaded silence between lines — emit a
      SILENT_STARE or REACTION beat of 2-3s BETWEEN the dialogue beats. Never pad a
      dialogue beat with silence. If you want silence at the end of a line, mark the
      beat \`emotional_hold: true\` and leave the duration honest.
    - If a character is a babbler by speech_patterns.sentence_length and delivers
      18 words in one breath, emit an 8-second beat and mark it \`pace_hint: "fast"\`.
    - A scene's total beat count is whatever the scene NEEDS — not a ceiling derived
      from cost. The cost cap is enforced by the BeatRouter, not by pre-compressing
      the screenplay into silence.

    Sizing reference (word count → beat duration, not the other way around):
      • 4 words  → 3s   (e.g. "You knew this already.")
      • 7 words  → 3s   (e.g. "You knew this would happen.")
      • 9 words  → 4s   (e.g. "I never believed any of it until tonight.")
      • 12 words → 5s   (e.g. "Everything you trusted about this place was a lie.")
      • 14 words → 6s   (e.g. "There is no version of this story where you walk away clean.")
      • 16 words → 7s
      • 18 words → 8s

13. SCENE-LEVEL AMBIENT BED (the Hollywood sonic backdrop) — MANDATORY:
    Every scene MUST include a "ambient_bed_prompt" field describing the
    continuous room-tone/atmosphere that plays UNDER every beat in the scene.
    This is what makes an episode feel like a FILM instead of a montage of
    disconnected clips: the bed masks audio cuts, establishes location
    acoustics, and carries emotional continuity across shot changes.

    Rules:
    • Describe ONLY environmental sound (air, hum, distant traffic, crowd
      murmur, wind, HVAC, fluorescent buzz, ocean, rain) — NOT dialogue,
      footsteps, or prop clicks (those go in per-beat ambient_sound).
    • The bed must feel LOOPABLE — a steady texture without hard events or
      melodic elements. No dogs barking, no door slams, no music.
    • The bed must match the scene's mood AND location. Tense interrogation
      room = sterile HVAC hum + distant refrigerator drone. Rooftop bar =
      distant city rumble + muffled chatter + occasional wind gust.
    • Different scenes can have different beds; they crossfade at scene
      boundaries (0.5s) so transitions don't jolt.
    • Per-beat "ambient_sound" fields are FOREGROUND events (footsteps,
      glass clink, product click) that play ON TOP of the bed at -10dB.
      Think of the bed as the ALWAYS-ON track and ambient_sound as the
      SPECIFIC moment layered over it.

14. PER-BEAT ambient_sound DISCIPLINE:
    When you emit an "ambient_sound" field on a beat, describe a SPECIFIC
    foreground sound event tied to that beat's action — NOT the scene's
    general atmosphere (that's what ambient_bed_prompt is for).

    Good per-beat ambient_sound examples:
      • B_ROLL reveal of a product: "soft thud as the box lands on marble"
      • ACTION beat showing a door opening: "distinct metallic click of the latch"
      • INSERT_SHOT of a wristwatch: "crisp tick-tock, faint brushed-metal grip sound"
      • REACTION closeup: "shallow breath, fabric shift"

    Bad per-beat ambient_sound (these belong in the bed, not per-beat):
      • "ambient crowd chatter" — bed material, not beat-specific
      • "distant city hum" — bed material
      • "soft wind" — bed material

    Every non-dialogue beat (B_ROLL, ACTION, INSERT_SHOT, REACTION,
    SILENT_STARE) SHOULD have a per-beat ambient_sound for its specific
    foreground event. Dialogue beats can omit it (voice is foreground).

Respond with ONLY valid JSON. No markdown fences. No preamble.`;
}
