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
  _buildPreviousEpisodesBlock,
  _buildCommercialBriefBlock
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
  'INSERT_SHOT',               // Veo 3.1 Standard + first/last frame. Tight object/detail beat. Hero use only when product_integration_style=hero_showcase or commercial.
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
// Phase 3 — CINEMATIC FRAMING VOCABULARY
// ═══════════════════════════════════════════════════════════════════════
//
// A named vocabulary Gemini picks from instead of improvising camera
// language. Each entry maps a semantic name ("wide_establishing",
// "medium_two_shot", "over_shoulder", "tight_closeup", "macro_insert") to a
// concrete lens / distance / camera-move recipe that downstream models
// (Kling / Veo) can interpret consistently.
//
// The point: if Gemini says `framing: "wide_establishing"`, the beat
// generator appends the lens + distance + camera_move recipe to the prompt.
// This replaces ad-hoc phrases like "cinematic macro feel" with a locked
// recipe — which is how Hollywood DPs work (they pick from a shared shot
// vocabulary, not reinvent terms).

// Phase 3 expansion (2026-04-27): 7 → 20 lens types. Schema upgrade —
// `camera_move` (string) is preserved for backwards compatibility with the
// beat generators; `move_options` (string[]) is the canonical list. The
// scene-graph beat may emit a `camera_move` override that picks any option
// from `move_options` or any free-form move; otherwise the first option
// is used by default.
//
// Anamorphic note: V4 ships 9:16 vertical. The "anamorphic" entries DO NOT
// change aspect ratio — they capture the optical signature (oval bokeh,
// blue horizontal flares, edge distortion) that anamorphic glass adds to
// the close-up while the frame stays portrait. Reference: Greig Fraser's
// portrait inserts in Dune.
export const V4_FRAMING_VOCAB = {
  wide_establishing: {
    lens_mm: '24-35',
    distance: 'wide',
    camera_move: 'slow dolly back / crane reveal',
    move_options: ['slow dolly back', 'crane reveal', 'static wide'],
    intent: 'Establish environment + subject within context. Generous headroom, subject ≤ 25% of frame.',
    use_when: 'B_ROLL_ESTABLISHING, scene openers, new location reveals.'
  },
  medium_two_shot: {
    lens_mm: '35-50',
    distance: 'medium',
    camera_move: 'locked-off or gentle drift',
    move_options: ['locked-off', 'gentle drift'],
    intent: 'Two characters in frame at conversational distance. Eye-level. Both faces visible.',
    use_when: 'GROUP_DIALOGUE_TWOSHOT, emotional peak multi-persona exchanges.'
  },
  over_shoulder: {
    lens_mm: '50-85',
    distance: 'medium-close',
    camera_move: 'subtle arc over shoulder',
    move_options: ['subtle arc over shoulder', 'locked-off OTS'],
    intent: 'Protagonist in foreground (soft), listener in midground (sharp). Conversational power dynamic.',
    use_when: 'DIALOGUE_IN_SCENE when the scene has two characters and one is speaking.'
  },
  dirty_over_shoulder: {
    lens_mm: '50-75',
    distance: 'medium',
    camera_move: 'subtle drift, foreground out of focus',
    move_options: ['subtle drift', 'locked-off'],
    intent: 'OTS with foreground shoulder LARGE (≥30% of frame), intentionally soft. Spatial dominance.',
    use_when: 'DIALOGUE_IN_SCENE with power asymmetry; interrogation beats.',
    reference: 'The Bear kitchen confrontations, Slow Horses dialogue.'
  },
  tight_closeup: {
    lens_mm: '75-100',  // RELAXED from 85-100 — opens 75mm portrait sweet spot.
    distance: 'close',
    camera_move: 'locked-off, shallow DOF breathing',
    move_options: ['locked-off', 'shallow DOF breathing', 'subtle handheld'],
    intent: 'Head-and-shoulders, eyes and mouth as the story. Intimate, emotional.',
    use_when: 'TALKING_HEAD_CLOSEUP, SILENT_STARE, REACTION where the face IS the beat.'
  },
  portrait_75mm: {
    lens_mm: '75-85',
    distance: 'medium-close',
    camera_move: 'locked-off, breath-only DOF',
    move_options: ['locked-off', 'breath-only DOF'],
    intent: 'Face-as-canvas. Skin separation, soft falloff, painterly. Reserve for moments where the face IS the scene.',
    use_when: 'TALKING_HEAD_CLOSEUP at emotional peak; SILENT_STARE on protagonist; thesis-line beats.',
    reference: 'Deakins / 1917, Bradford Young / Selma.'
  },
  anamorphic_signature_closeup: {
    lens_mm: '40-50 anamorphic (1.85x squeeze)',
    distance: 'close',
    camera_move: 'locked-off, oval bokeh, blue horizontal flares',
    move_options: ['locked-off', 'gentle push-in'],
    intent: 'Close-up with anamorphic optical signature (oval bokeh, edge distortion, horizontal lens flare). Vertical-cropped — signature is in optics, not aspect.',
    use_when: 'Hero portrait beats; thesis moments; prestige-scale character introduction.',
    reference: 'Fraser / Dune portrait inserts, van Hoytema / Tenet.'
  },
  anamorphic_wide_world: {
    lens_mm: '24-35 anamorphic',
    distance: 'wide',
    camera_move: 'slow crane / dolly with horizontal flare',
    move_options: ['slow crane', 'slow dolly', 'static with horizontal flare'],
    intent: 'Wide world reveal with anamorphic edge distortion + flare. Mythic.',
    use_when: 'B_ROLL_ESTABLISHING for prestige stories, world reveals.',
    reference: 'Deakins / Blade Runner 2049 desert wides.'
  },
  macro_insert: {
    lens_mm: '60-180 macro',  // RELAXED from 100-macro — covers cinema macro range.
    distance: 'macro',
    camera_move: 'held with subtle rack focus, minimal drift',
    move_options: ['held with subtle rack focus', 'breathing drift', 'static macro'],
    intent: 'Detail beat — product, hands, object. Tactile detail. Predictable endpoint.',
    use_when: 'INSERT_SHOT, tactile detail beats.'
  },
  cinema_macro_product: {
    lens_mm: '90-180 macro',
    distance: 'macro',
    camera_move: 'rack focus across product surface, breathing-only drift',
    move_options: ['rack focus across surface', 'breathing-only drift', 'static macro'],
    intent: 'Cinema macro on product. The product is subject, framed as object-of-interest, not advertisement. Tactile.',
    use_when: 'Product detail beats where the product is being USED. Hands present in frame.',
    reference: 'The Social Network MacBook insert, Apple keynote macros.'
  },
  cinema_macro_emotion: {
    lens_mm: '60-100 macro',
    distance: 'macro',
    camera_move: 'rack focus eye → tear → eye, locked',
    move_options: ['rack focus eye-to-detail', 'locked macro', 'breathing-only'],
    intent: 'Cinema macro on a human detail (eye, hand tremor, tear, lip bite). Subtext made physical.',
    use_when: 'INSERT_SHOT for emotional stakes; reaction beats post-revelation.',
    reference: 'Lubezki / Tree of Life, Young / Arrival.'
  },
  tilt_shift_miniature: {
    lens_mm: '24-45 tilt-shift',
    distance: 'wide-medium',
    camera_move: 'locked-off, wedge-of-focus diagonally across frame',
    move_options: ['locked-off with wedge-of-focus', 'static tilted plane'],
    intent: 'Surreal "miniature" or psychological compression effect. Selective focus on a diagonal plane.',
    use_when: 'Specialty B_ROLL, dream/memory beats, stylized signature scenes.',
    reference: 'Mr. Robot rooftop, Gone Girl tilt-shift inserts.'
  },
  fisheye_subjective: {
    lens_mm: '8-14 fisheye',
    distance: 'close-wide',
    camera_move: 'handheld, rotational',
    move_options: ['handheld rotational', 'POV handheld', 'static fisheye'],
    intent: 'Subjective POV — intoxication, panic, dream. Horizon curves.',
    use_when: 'POV beats under altered state; claustrophobia; signature moments.',
    reference: 'Spring Breakers / Korine, Uncut Gems Sandler POV.'
  },
  fixed_telephoto_isolation: {
    lens_mm: '200-400',
    distance: 'medium-tight via distance',
    camera_move: 'locked-off long, compressed background',
    move_options: ['locked-off long', 'subtle handheld at distance', 'tripod static'],
    intent: 'Long-lens isolation — subject pulled out of background by extreme compression. Background = blur-painting.',
    use_when: 'SILENT_STARE in crowd; surveillance; cliffhanger reveals.',
    reference: 'Slow Horses surveillance, Mindhunter exteriors.'
  },
  vintage_zoom_creep: {
    lens_mm: '50-150 vintage zoom',
    distance: 'medium → close',
    camera_move: 'slow optical zoom-in (NOT dolly) over 4-6 seconds',
    move_options: ['slow optical zoom-in over 4-6s', 'slow optical zoom-out'],
    intent: '70s/80s optical zoom creep. Suspense build, visible perspective change.',
    use_when: 'Tension build, paranoid beats, reveals. Use sparingly — it announces itself.',
    reference: 'There Will Be Blood reveal zooms.'
  },
  speed_ramp_action: {
    lens_mm: '24-50',
    distance: 'medium',
    camera_move: 'whip pan with speed ramp (60fps → 24fps mid-action)',
    move_options: ['whip pan with speed ramp', 'tracking with speed ramp', 'handheld with speed ramp'],
    intent: 'Real-time → slow-mo → real-time on a single gesture. Energy spike.',
    use_when: 'SPEED_RAMP_TRANSITION beats; action peaks; commercial product reveals.',
    reference: 'Children of Men single-take ramps.'
  },
  product_in_environment: {
    lens_mm: '35-50',
    distance: 'medium',
    camera_move: 'subtle drift, product mid-ground, character interacting',
    move_options: ['subtle drift', 'locked-off', 'subtle handheld'],
    intent: 'PRODUCT-PROTECTION preset — product present and visible but NOT the framed subject. Character action is subject. Product reads as lived-in detail.',
    use_when: 'Beats where product appears but should NOT be flagged "product hero". Default for naturalistic placement.',
    reference: 'The Social Network MacBook (Zuckerberg coding), E.T. Reese\'s Pieces (Elliott\'s hand).'
  },
  product_tactile_handheld: {
    lens_mm: '50-85',
    distance: 'medium-close',
    camera_move: 'handheld OTS onto hands using product',
    move_options: ['handheld OTS onto hands', 'subtle handheld over shoulder'],
    intent: 'PRODUCT-PROTECTION preset — character hands using the product, lens follows hands not brand mark. Brand mark in motion blur or peripheral.',
    use_when: 'Product actively used. Brand registers subliminally.',
    reference: 'Bond Aston Martin gear-shift inserts, prestige shows using a phone naturalistically.'
  },
  tracking_push: {
    lens_mm: '35-50',
    distance: 'medium',
    camera_move: 'slow push-in following subject motion',
    move_options: ['slow push-in', 'tracking push following subject', 'walking handheld'],
    intent: 'Energy building — subject in motion, camera matches. Reserve for kinetic scenes.',
    use_when: 'ACTION_NO_DIALOGUE with directional momentum.'
  },
  bridge_transit: {
    lens_mm: '24-35',
    distance: 'wide',
    camera_move: 'subject exits frame / enters new location',
    move_options: ['subject exits frame', 'subject enters new location', 'static frame with crossing subject'],
    intent: 'Connective tissue between scenes. Shows HOW we got from A to B.',
    use_when: 'scene.bridge_to_next beats.'
  }
};

function _buildCinematicFramingBlock() {
  const entries = Object.entries(V4_FRAMING_VOCAB)
    .map(([name, spec]) =>
      `  • ${name}: lens ${spec.lens_mm}mm, ${spec.distance}, ${spec.camera_move}. ${spec.intent} Use for: ${spec.use_when}`
    )
    .join('\n');

  return `═══════════════════════════════════════════════════════════════
CINEMATIC FRAMING VOCABULARY — pick from this list, don't improvise.
═══════════════════════════════════════════════════════════════

Every beat MUST emit a \`framing\` field with one of the names below. The
downstream video models (Kling, Veo) receive a concrete lens + distance +
camera-move recipe per framing name, which produces consistent, predictable
shots across beats. Improvised camera language ("cinematic macro feel",
"dramatic zoom") produces inconsistent results — the vocabulary eliminates that.

${entries}

HARD RULES:
  - B_ROLL_ESTABLISHING → framing MUST be wide_establishing or bridge_transit.
    Never macro_insert. An establishing shot that closes on the subject
    defeats its purpose.
  - INSERT_SHOT → framing MUST be macro_insert.
  - TALKING_HEAD_CLOSEUP / SILENT_STARE / REACTION → framing SHOULD be
    tight_closeup (occasionally over_shoulder for DIALOGUE_IN_SCENE).
  - Never emit framing values outside this vocabulary. Missing framing
    defaults per beat type (but picking explicitly is ALWAYS better).

Camera zoom / push-in is RESERVED: use it only on tracking_push or when
narratively motivated. A 2-4s push-in on a still subject looks cheap.
Default to HELD shots with subtle rack focus for detail beats — the
Hollywood standard for naturalistic product placement.
`;
}

// ═══════════════════════════════════════════════════════════════════════
// PRODUCT INTEGRATION STYLES — Phase 4 (2026-04-27)
// ═══════════════════════════════════════════════════════════════════════
//
// Replaces the legacy "PRODUCT IS THE HERO" + mandatory "MONEY BEAT" framing
// with a four-level axis for how the product participates in a screenplay.
// The default for every PRODUCT-focus story is `naturalistic_placement`
// (Hollywood prop grammar) — the bias that produced infomercial-style
// dialogue in pre-Phase-4 stories. `hero_showcase` is the legacy mode and
// the default for the upcoming COMMERCIAL genre (Phase 6).
//
// The 8 Hollywood placement rules (rules 1-8 below) apply for every style
// EXCEPT `hero_showcase` and `commercial`.

const PRODUCT_PLACEMENT_RULES = `HOLLYWOOD PRODUCT PLACEMENT GRAMMAR — applies to every dialogue and beat unless the
story is explicitly in hero_showcase / commercial mode:

  1. The product is a NOUN, not an ADJECTIVE. Characters touch / use / hand / drop / fix / share it.
     They do NOT describe it. NO line of dialogue may name the brand or describe a product feature.
     (Exception: a character reading a label diegetically, max once per episode.)

  2. The 4-beat ceiling. The product appears in MAX 4 beats per episode. Below the ceiling is fine;
     above it is infomercial.

  3. NO standalone INSERT_SHOT for the product without character context. Every product beat has a
     hand, face, body, or scene context — the product is being LIVED WITH, not displayed.

  4. The product participates in story. It must serve a character action, an emotional beat, a
     thematic image, or a plot moment. Decorative product appearance is forbidden.

  5. First appearance is incidental. Episode 1 introduces the product passively — on a table, in a
     bag, on a desk — BEFORE any character interacts with it. Viewer notices before story acknowledges.

  6. Brand mark RARELY centered, NEVER in solo close-up — exception: ONE earned hero frame per episode,
     story-justified.

  7. Camera does NOT linger. Product beats hold ≤ 2.5 seconds unless the product is actively involved
     in dramatic action.

  8. Product color may not contradict the LUT. Dress the product into the world; never re-grade the
     scene to flatter it.

ANTI-AD-COPY HARD-BANS in dialogue (validator-enforced):
  - "with the new <brand>"          → cut
  - "introducing"                   → cut
  - "proudly powered by"            → cut
  - "now available"                 → cut
  - "(get|grab|try|buy) yours today"→ cut
  - "limited time"                  → cut
  - "free shipping"                 → cut
  - "the only X that…"              → cut
  - "(thanks to|because of) <brand>"→ cut
  - "changed (my|our) life"         → cut
  - "<brand> understands/believes"  → cut
  - "our patented"                  → cut
  - "built for / designed for"      → cut (when subject == product)
  - "never been easier"             → cut

These are HARD bans, not suggestions. Dialogue containing them will be rewritten by the validator.`;

function _buildProductPlacementBlock(integrationStyle) {
  const style = String(integrationStyle || 'naturalistic_placement').toLowerCase();

  switch (style) {
    case 'hero_showcase':
      return `\nPRODUCT INTEGRATION MODE: HERO_SHOWCASE
The product is the framed subject of the story. Up to 6 beats may feature the product, including up to 2 standalone INSERT_SHOTs. Brand-name MAY appear in dialogue once (no feature-list speeches). The Hollywood placement rules ABOVE are RELAXED in this mode. ⭐ At least ONE INSERT_SHOT beat should feature the product, but it must remain a "subtle money beat" — short hold, character context preferred, never a billboard.`;

    case 'commercial':
      return `\nPRODUCT INTEGRATION MODE: COMMERCIAL
This is a Phase 6 commercial-genre episode. The product is encouraged to dominate. Maximum creative bravery; brand recall is a primary KPI. INSERT_SHOTs are encouraged. Money beats welcome. Anti-ad-copy bans are RELAXED — feature words are permitted when serving a creative concept.`;

    case 'incidental_prop':
      return `\n${PRODUCT_PLACEMENT_RULES}\n\nPRODUCT INTEGRATION MODE: INCIDENTAL_PROP
The product appears in 1-3 beats per episode. ZERO standalone INSERT_SHOTs. The product is a TOOL the character happens to use, never a topic. Brand-name forbidden in dialogue. Product is not even acknowledged.`;

    case 'genre_invisible':
      return `\n${PRODUCT_PLACEMENT_RULES}\n\nPRODUCT INTEGRATION MODE: GENRE_INVISIBLE
The product appears in EXACTLY ONE beat — the final reveal. ONE INSERT_SHOT permitted as cliffhanger / button. Brand-name appears only in the end-card overlay, never in dialogue.`;

    case 'naturalistic_placement':
    default:
      return `\n${PRODUCT_PLACEMENT_RULES}\n\nPRODUCT INTEGRATION MODE: NATURALISTIC_PLACEMENT (DEFAULT)
The product appears in 2-4 beats per episode. 0-1 INSERT_SHOTs, AND ONLY when a hand or face is in frame with the product (no standalone product shots). Brand-name forbidden in dialogue. Treat the product like Reese's Pieces in E.T. — a prop the character happens to use, woven into the story without comment.`;
  }
}

function _buildSubjectIntegrationBlock(subject, storyFocus, integrationStyle) {
  const sigFeatures = Array.isArray(subject?.signature_features) && subject.signature_features.length > 0
    ? `\n- SIGNATURE FEATURES (preserve verbatim across all beats — these define the product's visual identity):\n${subject.signature_features.map(f => `    • ${f}`).join('\n')}`
    : '';

  const integrationGuidance = (subject?.integration_guidance || []).length > 0
    ? `- Integration ideas:\n${subject.integration_guidance.map(g => `    • ${g}`).join('\n')}`
    : '';

  const landscapeNote = storyFocus === 'landscape'
    ? '\nFor landscape-focus stories, the place IS the setting — characters inhabit it.'
    : '';

  return `\nBRAND SUBJECT (must appear in this episode per the integration mode below):
- Name: ${subject.name}
- Category: ${subject.category || ''}
- Visual: ${subject.visual_description || ''}${sigFeatures}
${integrationGuidance}${landscapeNote}

${_buildProductPlacementBlock(integrationStyle)}`;
}

// ═══════════════════════════════════════════════════════════════════════
// V4 SONIC SERIES BIBLE — episode-prompt injector
// ═══════════════════════════════════════════════════════════════════════
//
// Phase 3 of the Audio Coherence Overhaul. The story-level sonic_series_bible
// is rendered into the episode system prompt as IMMUTABLE context — Gemini
// must inherit from it when authoring the episode-level sonic_world block.
//
// When no bible is available (legacy stories, generation failure that fell
// through to default), the block returns an empty string. The episode prompt
// then teaches Gemini to author a stand-alone sonic_world (the schema rules
// in Rule 13 still bind regardless of bible presence).
function _buildSonicSeriesBibleBlock(bible) {
  if (!bible || typeof bible !== 'object') return '';

  const drone = bible.signature_drone || {};
  const palette = bible.base_palette || {};
  const anchor = bible.spectral_anchor || {};
  const policy = bible.inheritance_policy || {};
  const prohibitedInst = Array.isArray(bible.prohibited_instruments) ? bible.prohibited_instruments : [];
  const prohibitedTropes = Array.isArray(bible.prohibited_tropes) ? bible.prohibited_tropes : [];
  const refs = Array.isArray(bible.reference_shows) ? bible.reference_shows : [];

  const fmtList = (a, fallback = '—') => (a && a.length > 0 ? a.join(', ') : fallback);

  return `═══════════════════════════════════════════════════════════════
SONIC SERIES BIBLE (locked at story creation — inherit, do not violate):
═══════════════════════════════════════════════════════════════

This is the show's sound DNA. Every episode shares it. Variations between
episodes must obey the bible's inheritance_policy. The viewer should hear
ONE world across all episodes — not a different audio aesthetic each time.

PALETTE (the show's signature timbre):
- signature_drone: ${drone.description || '—'}
  • frequency band: ${Array.isArray(drone.frequency_band_hz) ? drone.frequency_band_hz.join('–') + ' Hz' : '—'}
  • presence level: ${typeof drone.presence_dB === 'number' ? drone.presence_dB + ' dB' : '—'}
- base_palette ambient keywords: ${fmtList(palette.ambient_keywords)}
- BPM range: ${Array.isArray(palette.bpm_range) ? palette.bpm_range.join('–') + ' BPM' : '—'}
- Modal/key center: ${palette.key_or_modal_center || '—'}
- spectral_anchor (always-on seam-hider): ${anchor.description || '—'} @ ${typeof anchor.level_dB === 'number' ? anchor.level_dB + ' dB' : '—'}

GRAMMAR (rules of engagement):
- Foley density: ${bible.foley_density || '—'}
- Score under dialogue: ${bible.score_under_dialogue || '—'}
- Silence as punctuation: ${bible.silence_as_punctuation || '—'}
- Diegetic ratio (diegetic vs scored): ${typeof bible.diegetic_ratio === 'number' ? bible.diegetic_ratio.toFixed(2) : '—'}
- Transition grammar: ${fmtList(bible.transition_grammar)}

NO-FLY LIST (what this show NEVER does — equally identity-defining):
- Prohibited instruments: ${fmtList(prohibitedInst, 'none')}
- Prohibited audio tropes: ${fmtList(prohibitedTropes, 'none')}

INHERITANCE POLICY (binding):
- grammar: ${policy.grammar || 'immutable'} — do not deviate from foley_density / score_under_dialogue / silence rules
- no_fly_list: ${policy.no_fly_list || 'immutable'} — do not include any prohibited instrument or trope
- base_palette: ${policy.base_palette || 'overridable_with_justification'} — episode-level base_palette may evolve; cite reason if it does
- signature_drone: ${policy.signature_drone || 'must_appear_at_least_once_per_episode'} — your sonic_world.spectral_anchor MUST contain the drone's frequency band

REFERENCE SHOWS (taste anchor): ${fmtList(refs, '—')}
${bible.reference_rationale ? `Rationale: ${bible.reference_rationale}` : ''}

IMPLICATION FOR THIS EPISODE:
Your "sonic_world" block (see schema below) IS NOT a fresh audio design — it is
a VARIATION on this bible. Your sonic_world.base_palette must reference (and
may add to) the bible's base_palette ambient keywords. Your sonic_world.spectral_anchor
must contain the bible's signature_drone frequency band. Your sonic_world.scene_variations[]
overlays must NEVER replace the base palette — only ADD to it (additive layers).

If your music_bed_intent uses a prohibited instrument, you have violated the
bible. If a scene_variations[].overlay swaps the base palette wholesale, you
have violated the bible. The downstream Validator will reject these violations
and the Doctor will rewrite them — but you should author them correctly the
first time.`;
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
    hasBrandKitLut = false,
    // Phase 3 — V4 Audio Coherence Overhaul. The locked sonic_series_bible
    // (story-level, authored once at first episode, mutable via PATCH).
    // When provided, the episode-level sonic_world MUST inherit from it
    // per the bible's inheritance_policy. When null/undefined, Gemini
    // falls back to authoring a stand-alone sonic_world (legacy stories).
    sonicSeriesBible = null,
    // Phase 4 — product integration style. Controls the narrative role of
    // the brand subject in the screenplay:
    //   'naturalistic_placement' (DEFAULT) — Hollywood prop grammar
    //   'hero_showcase' — product-first, money-beat encouraged (legacy mode)
    //   'incidental_prop' — barely visible, no INSERT_SHOT
    //   'genre_invisible' — withheld until final reveal
    //   'commercial' — Phase 6 commercial-genre mode (hero_showcase + relaxed dialogue)
    productIntegrationStyle = 'naturalistic_placement',
    // Phase 6 (2026-04-28) — CreativeBriefDirector output. When provided
    // (commercial-genre stories), the screenplay writer receives the brief
    // as the SUPREME directorial law (creative_concept, visual_signature,
    // narrative_grammar, music_intent, hero_image, brand_world_lock,
    // anti_brief). Without this, the brief was dead weight and commercials
    // came out incoherent (logs.txt 2026-04-28 root cause).
    commercialBrief = null
  } = options;

  const prevBlock = _buildPreviousEpisodesBlock(storyline, previousEpisodes);
  const brandContextBlock = brandKit ? _buildBrandKitContextBlock(brandKit) : '';
  const focusBlock = _buildCinematicFocusBlock(storyFocus);
  const sonicBibleBlock = _buildSonicSeriesBibleBlock(sonicSeriesBible);

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
    ? _buildSubjectIntegrationBlock(subject, storyFocus, productIntegrationStyle)
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

  // Phase 6 (2026-04-28) — render the commercial brief as the SUPREME
  // directorial law for the screenplay writer. Splices in immediately after
  // the showrunner role declaration so it overrides any default convention.
  const commercialBriefBlock = commercialBrief
    ? _buildCommercialBriefBlock(commercialBrief)
    : '';

  return `You are the showrunner, screenwriter, and cinematographer of "${storyline.title || 'an ongoing brand short-film series'}".
You write each episode as a HOLLYWOOD-GRADE BRANDED SHORT FILM in the quality bar of Higgsfield
Original Series and AppReel Original Series. Characters speak on-camera with proper lip-sync,
scenes have cinematic backgrounds, and every beat serves the story.
${commercialBriefBlock}
${focusBlock}
${directorsBlock}
SERIES CONTEXT:
- Logline: ${storyline.logline || storyline.theme || ''}
- Tone: ${storyline.tone || 'engaging'}
- Genre: ${storyline.genre || 'drama'}
- Total planned episodes: ${storyline.episodes?.length || 12}
${emotionalBlock}${visualContinuityBlock}${motifsBlock}

${_buildGenreRegisterBlock(storyline.genre)}

${_buildCinematicFramingBlock()}

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

${sonicBibleBlock}

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

7. **INSERT_SHOT** — Tight closeup of a product, object, or detail beat.
   Hand or face usually in frame (no standalone product shots in naturalistic_placement mode).
   2-4s, pristine composition. Camera HOLDS — never lingers ≥ 2.5s unless dramatically active.
   Fields: subject_focus (what's being shown), lighting_intent, camera_move ("slow push-in" / "rack focus" / "tilt down"),
           duration_seconds (2-4), ambient_sound (glass clink, fabric rustle, etc.)
   The number of product-bearing INSERT_SHOTs allowed per episode is governed by
   product_integration_style (see HOLLYWOOD PRODUCT PLACEMENT GRAMMAR block).

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
  const {
    hasBrandKitLut = false,
    // Phase 3 — when present, the user-prompt schema example reminds Gemini
    // that sonic_world inherits from the bible (the system prompt has the
    // full bible context; this is a short pointer in the JSON schema).
    sonicSeriesBible = null
  } = options;
  const hasBible = !!(sonicSeriesBible && typeof sonicSeriesBible === 'object');

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
  EARNED-HOLD CONTRACT: emotional_hold: true is the ONLY exemption from the
  6-words-per-line dialogue-density floor. To honor the exemption, the beat
  MUST also carry substantive expression_notes (≥5 words) OR substantive
  subtext (≥5 words) that articulates what the silence is doing — what the
  face shows, what the line is NOT saying. A naked emotional_hold flag with
  no justification is treated by the validator as ordinary sparse dialogue
  and counts toward dialogue_too_sparse / too_many_bare_short_lines.
  WHY: the flag exists to honor director-crafted silence, not to dodge the
  density floor on weak beats. Earn the silence or write a full line.

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
  "dramatic_question": "The ONE high-stakes question this episode poses that keeps the viewer watching (one sentence, ends with '?'). Example: 'Will Maya finally confront what she buried six years ago?'",
  "mood": "Episode's emotional register (e.g. 'quiet tension building to release')",
  "continuity_from_previous": "How this connects to what came before",
  "continuity_check": "How this episode's opening resolves the previous cliffhanger",
  "cliffhanger": "What makes the viewer want episode ${episodeNumber + 1}",
  "emotional_state": "Where the viewer's emotional journey stands at the END of this episode",
  "visual_motif_used": "Which recurring visual motif (from season bible) appears and how",
  "visual_style_prefix": "UNIFIED cinematography brief for ALL beats: color temperature, lighting quality, lens feel, film stock reference. Example: 'Warm golden-hour tones, shallow DOF, anamorphic lens flare, Kodak Portra 400 grain, soft backlit highlights'. This prefix applies to every scene_visual_anchor_prompt.",${lutField}
  "music_bed_intent": "Music brief for ElevenLabs Music. Describe instrumentation, mood, arc. Example: 'Low brooding strings with sparse piano, building tension through the confrontation, resolving to a single held cello note at the cliffhanger'. Keep under 200 chars.${hasBible ? ' MUST NOT include any prohibited_instruments from the Sonic Series Bible.' : ''}",
  "sonic_world": {
    "_comment": "EPISODE-LEVEL audio architecture (replaces per-scene ambient_bed_prompt). One bed for the whole episode, scene-specific overlays as ADDITIVE layers. ${hasBible ? 'Must inherit from the Sonic Series Bible (see SONIC SERIES BIBLE block above).' : 'Authored fresh — no story-level bible available.'}",
    "base_palette": "${hasBible ? 'Episode-level bed description that REFERENCES and may add to the bible base_palette ambient_keywords. The continuous always-on layer for the WHOLE episode (10-25s+). Example — low industrial drone with concrete reverb tail, faint distant traffic, deep HVAC undertone (the constant). Keep under 220 chars.' : 'Episode-level bed description — the continuous always-on layer for the WHOLE episode. Example — low industrial drone with concrete reverb tail, faint distant traffic. Keep under 220 chars.'}",
    "spectral_anchor": "${hasBible ? 'The seam-hider — sustained low-frequency content that ALWAYS plays under everything (sub-200Hz anchor). MUST include the bible signature_drone frequency band. Example — sustained 60-120Hz hum + faint 2-4kHz air movement. Keep under 160 chars.' : 'The seam-hider — sustained low-frequency content that ALWAYS plays under everything. Example — sustained 60-120Hz hum + faint 2-4kHz air movement. Keep under 160 chars.'}",
    "scene_variations": [
      { "scene_id": "matches scene.scene_id", "overlay": "ADDITIVE layer that plays ON TOP OF base_palette during this scene only. MUST share at least one texture word with base_palette. FAIL: base='low industrial drone, concrete reverb' + overlay='sterile electrical hum' (no shared texture). PASS: base='low industrial drone, concrete reverb' + overlay='wind through concrete gaps' (shares concrete). Keep under 140 chars.", "intensity": 0.65 }
    ]
  },
  "scenes": [
    {
      "scene_id": "short_identifier",
      "type": "standard | montage",
      "location": "Where this scene takes place (one sentence)",
      "location_id": "OPTIONAL — stable identifier for a RECURRING location (e.g. 'agent_office', 'rooftop_terrace'). When a later scene reuses the same physical space, emit the SAME location_id so the Location Bible reuses the cached scene master. Omit for one-off locations.",
      "scene_synopsis": "One-sentence summary of what happens in this scene",
      "scene_goal": "What the protagonist / camera is trying to achieve in this scene (one sentence)",
      "dramatic_question": "The ONE question this scene raises (one sentence)",
      "hook_types": ["CLIFFHANGER" | "REVELATION" | "CRESCENDO" | "DRAMATIC_IRONY" | "STATUS_FLIP" | "CONTRADICTION_REVEAL" | "ESCALATION_OF_ASK"],
      "opposing_intents": { "[0]": "what persona 0 wants in this scene", "[1]": "what persona 1 wants — must oppose persona 0" },
      "scene_visual_anchor_prompt": "Rich still-image description for Seedream 5 Lite Scene Master panel. 80-150 words. Cover: location + time of day + lighting + color palette + character blocking + wardrobe + atmosphere + film stock feel. Must respect visual_style_prefix. Example: 'Wide establishing of a rooftop bar at golden hour, neon signage reflecting in rain-slicked tiles. Maya stands left frame in a charcoal coat; Daniel sits right frame at a copper-topped bar. Warm amber key light, cool cyan fill from neon. Anamorphic lens feel, shallow DOF, Kodak Portra 400 grain.'",
      "transition_to_next": "dissolve | fadeblack | cut | speed_ramp — DEFAULT TO 'dissolve'. With the V4 audio coherence overhaul, the EPISODE base bed plays UNCUT across every scene boundary regardless of transition; only the scene_variations[] OVERLAY J-cuts (pre-rolls in / tail-rolls out across the cut). 'cut' is now safe for sonic continuity — choose it freely when the narrative wants a hard visual edit. 'dissolve' adds a 0.5s video xfade. 'fadeblack' is for emotional beat breaks or act separations. 'speed_ramp' for energy spikes.",
      "bridge_to_next": {
        "_comment": "OPTIONAL narrative bridge beat (Phase 6.1) — a 2-3s B-roll or walk shot that shows HOW we got from this scene to the next. Emit when the next scene is in a DIFFERENT location, so the viewer understands the spatial/temporal move. The bridge is generated by Veo with first_frame=this scene's endframe and last_frame_hint=next scene's master, producing a seamless transit shot. Without a bridge, the viewer sees a raw dissolve with no narrative connective tissue.",
        "type": "B_ROLL_ESTABLISHING | INSERT_SHOT",
        "framing": "bridge_transit | wide_establishing",
        "duration_seconds": 2,
        "visual_prompt": "e.g. 'Agent exits the office door, walks down the hallway toward the terrace' — describes the transit between the two scenes.",
        "ambient_sound": "transit environment sound"
      },
      "beats": [
        {
          "beat_id": "s1b1",
          "type": "B_ROLL_ESTABLISHING",
          "framing": "wide_establishing",
          "personas_present": [],
          "subject_present": true,
          "location_hero": true,
          "location": "rooftop bar at golden hour",
          "atmosphere": "rain-slicked tiles, neon reflections, distant city hum",
          "camera_move": "slow dolly back revealing the wider terrace and skyline",
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
          "framing": "tight_closeup",
          "persona_index": 1,
          "personas_present": [1],
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

13. EPISODE-LEVEL sonic_world (the Hollywood spine + stems architecture) — MANDATORY:
    Audio coherence in V4 is owned at the EPISODE level, not the scene level.
    There is ONE base bed for the whole episode. There is ONE always-on
    spectral anchor (the seam-hider). Per-scene variations are ADDITIVE
    overlays — they NEVER replace the base palette.

    The viewer should hear ONE world across the episode — not a different
    sonic backdrop in every scene. Scene-boundary timbre cliffs (wind in
    scene 1 → electrical hum in scene 2) are forbidden by this architecture.

    Required structure (emit at the EPISODE level, not per scene):

    "sonic_world": {
      "base_palette":     "<one continuous bed for the whole episode>",
      "spectral_anchor":  "<sub-200Hz + faint air content that plays under everything>",
      "scene_variations": [
        { "scene_id": "<id>", "overlay": "<additive layer>", "intensity": 0.0-1.0 },
        ...
      ]
    }

    Rules:
    • base_palette MUST be one bed that works under EVERY beat in the
      episode (10-25s+ continuous, designed to loop / extend seamlessly).
      Describe environmental sound ONLY — NOT dialogue, footsteps,
      foreground events (those go in per-beat ambient_sound).
    • spectral_anchor MUST contain sustained low-frequency content
      (sub-200Hz). This is the anchor that hides the seams across cuts —
      every beat shares it. If a Sonic Series Bible is locked, the anchor
      MUST contain the bible signature_drone frequency band.
    • scene_variations[] entries are ADDITIVE — they layer ON TOP of the
      base_palette during their scene only. They MUST NOT replace or
      contradict it. "Wind through gaps" is a valid overlay over an
      "industrial drone" base. "Sterile electrical hum" is NOT a valid
      overlay over an "industrial drone" base — it's a replacement, which
      is what causes the timbre cliff. The overlay must SHARE the base's
      low-frequency envelope.
    • ADDITIVE test: can you still hear the base_palette UNDER the overlay?
      If the overlay description completely replaces the base (different
      materials, different space, different frequency character), it fails.
      The overlay is a seasoning, not a new dish.
    • intensity is a 0.0-1.0 float that maps to overlay gain at mix time
      (1.0 = -16dB, 0.5 = -22dB, 0.0 = silent). Most scenes 0.5-0.85.
    • A bible-locked story inherits palette and grammar from the bible.
      A bible-free story authors the sonic_world fresh — but the same
      additive-layer rule still binds.

    Legacy compatibility: if you must emit per-scene ambient_bed_prompt
    (legacy episodes that pre-date this rule), DO NOT — emit only
    sonic_world at the episode level. The orchestrator backward-reads
    legacy fields if present, but you should never produce them.

14. PER-BEAT ambient_sound DISCIPLINE — Foley EVENTS only (1-3s percussive):
    When you emit an "ambient_sound" field on a beat, describe a SPECIFIC
    short foreground sound event tied to that beat's action. This is FOLEY
    (a Hollywood sound discipline), not ambient. It is a discrete diegetic
    EVENT (1-3s, percussive), not a continuous bed.

    Good per-beat ambient_sound (Foley events):
      • B_ROLL reveal of a product: "soft thud as the box lands on marble"
      • ACTION beat showing a door opening: "distinct metallic click of the latch"
      • INSERT_SHOT of a wristwatch: "crisp tick-tock, faint brushed-metal grip sound"
      • REACTION closeup: "shallow breath, fabric shift"
      • ACTION fight beat: "knuckle crack, fabric tension snap"

    Bad per-beat ambient_sound (these are AMBIENT — they belong in
    sonic_world.base_palette or scene_variations[].overlay, not per-beat):
      • "ambient crowd chatter" — that's a bed, not a Foley event
      • "distant city hum" — bed material
      • "soft wind" — bed material
      • "atmospheric drone" — bed material
      • "evocative room tone" — bed material

    The Validator will reject any ambient_sound containing the words
    "ambient", "drone", "atmosphere", "room tone", "wash", "evocative" —
    those are bed words. Foley is concrete, percussive, short.

    Every non-dialogue beat (B_ROLL, ACTION, INSERT_SHOT, REACTION,
    SILENT_STARE) SHOULD have a per-beat ambient_sound for its specific
    foreground EVENT. Dialogue beats can omit it (voice is foreground).

15. EPISODE-LEVEL dramatic_question — MANDATORY: emit a single sentence
    ending in '?' in the "dramatic_question" field at the episode root
    (not inside a scene). This is the question the EPISODE poses — the
    one question the viewer must see answered before they stop watching.
    It is distinct from per-scene dramatic_question fields.
    Example: "Will Maya finally confront what she buried six years ago?"

Respond with ONLY valid JSON. No markdown fences. No preamble.`;
}
