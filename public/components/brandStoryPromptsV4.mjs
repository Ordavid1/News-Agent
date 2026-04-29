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

// Phase 2 — single-source-of-truth genre register library. Behind env flag
// `BRAND_STORY_GENRE_REGISTER_LIBRARY` (default false during migration);
// when off, the legacy inline `_buildGenreRegisterBlock` defined below is
// the source. Both consumer paths share the same prompt-shape contract.
import {
  buildGenreRegisterBlock as _buildGenreRegisterBlockFromLibrary,
  isGenreRegisterLibraryEnabled
} from '../../services/v4/GenreRegister.js';

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
// LUT LIBRARY REFERENCE (genre-pool, passed in by caller)
// ═══════════════════════════════════════════════════════════════════════
//
// V4 Phase 5b — Director Agent's verdict (2026-04-29) eliminated the legacy
// hardcoded 8-LUT vocabulary. The Gemini-emitted lut_id at story creation
// previously came from this 8-entry list; the 22 spec LUTs in
// assets/luts/library.json (genre-anchored) were unreachable when no
// brandKit existed. Story `77d6eaaf` (commercial, no brandKit) is the
// smoking gun — it picked `bs_cool_noir` from the legacy list for a
// hyperreal-premium spot.
//
// New contract: caller (BrandStoryService) resolves the genre LUT pool via
// BrandKitLutMatcher.getGenreLutPool(genre) and passes it in. The prompt
// module is server/client-agnostic (data + format only).

/**
 * Render a genre LUT pool as a Gemini-readable list. Each entry is an object
 * shaped { id, look, mood_keywords?, reference_films? } — pulled from the
 * spec library (assets/luts/library.json).
 *
 * When the caller passes an empty/missing pool, return an explicit warning
 * marker the calling block can detect (and emit a "no LUT pool — use the
 * genre default" instruction instead of inviting Gemini to pick from a
 * legacy list).
 */
function _formatLutLibraryForPrompt(genreLutPool) {
  if (!Array.isArray(genreLutPool) || genreLutPool.length === 0) {
    return '  (no genre-pool available — caller will resolve via post-emission validation; do NOT emit a lut_id)';
  }
  return genreLutPool.map(l => {
    const moods = Array.isArray(l.mood_keywords) ? l.mood_keywords.join(', ') : '';
    const refs = Array.isArray(l.reference_films) ? l.reference_films.join(', ') : '';
    const moodLine = moods ? ` — mood: ${moods}` : '';
    const refLine = refs ? ` — ref: ${refs}` : '';
    return `  - ${l.id}: ${l.look}${moodLine}${refLine}`;
  }).join('\n');
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

// Phase 2 wrapper — when BRAND_STORY_GENRE_REGISTER_LIBRARY=true, the
// declarative library at assets/genre-registers/library.json is the source
// of truth. When off (default during migration), fall back to the legacy
// inline _buildGenreRegisterBlock above. The library returns '' for
// unknown genres → mirror that fallthrough so a missing library entry
// doesn't drop a non-zero genre register on the floor.
function _resolveGenreRegisterBlock(genre) {
  if (isGenreRegisterLibraryEnabled()) {
    const fromLibrary = _buildGenreRegisterBlockFromLibrary(genre);
    if (fromLibrary && fromLibrary.trim().length > 0) return fromLibrary;
    // Library returned empty — fall through to legacy so partial coverage
    // (genre present in legacy but missing from library) doesn't regress.
  }
  return _buildGenreRegisterBlock(genre);
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
  },

  // ─────────────────────────────────────────────────────────────────────
  // V4 Phase 7 — illustration / animation framing vocabulary.
  //
  // The 20 entries above are photographic-optics-native (anamorphic, macro,
  // tilt-shift, telephoto, vintage zoom). They assume optical reality. For
  // commercial briefs whose style_category is hand_doodle_animated /
  // surreal_dreamlike (and to a lesser degree vaporwave_nostalgic /
  // painterly_prestige), "lens" is metaphorical — there is no "macro" in
  // a cel-shaded shot. The 8 entries below are the animation/illustration
  // grammar equivalents.
  //
  // These entries are scoped:
  //   - The screenplay writer should ONLY pick from these when
  //     commercial_brief.style_category ∈ NON_PHOTOREAL_STYLE_CATEGORIES.
  //   - The beat generator (_resolveFramingRecipe) reads this vocab the
  //     same way as the photoreal ones; the recipe text just says
  //     "cel-shaded zoom-in" or "12fps stop-motion stepping" instead of
  //     "85mm anamorphic with oval bokeh".
  // ─────────────────────────────────────────────────────────────────────

  anime_eye_zoom: {
    lens_mm: 'cel-shade equivalent ~85mm',
    distance: 'tight closeup',
    camera_move: 'static hold with cel-shaded sparkle highlights in pupils',
    move_options: ['static hold with sparkle highlights', 'subtle drift with rim-glow', 'flash-cut from medium to extreme close on eyes'],
    intent: 'Anime grammar — eyes ARE the moment. Sparkle highlights, oversize iris, lashline graphic detail. Used for emotional revelations in cel-shaded register.',
    use_when: 'hand_doodle_animated emotional beats; the look that earns the moment.',
    reference: 'Studio Ghibli (Spirited Away revelation closeups), Makoto Shinkai (Your Name twilight closeups).'
  },
  manga_panel_punch_in: {
    lens_mm: 'graphic — no optical equivalent',
    distance: 'static medium → static close',
    camera_move: 'hard cut between two static frames, no optical zoom',
    move_options: ['hard cut medium → close', 'three-step graphic punch-in', 'flash white between cuts'],
    intent: 'Manga panel-to-panel grammar. Each frame is a panel; transitions are CUTS not zooms. Energy from juxtaposition, not motion.',
    use_when: 'hand_doodle_animated kinetic montage; punchline beats; reveal beats with graphic register.',
    reference: 'Into the Spider-Verse (panel-cut grammar), Akira (key-frame holds).'
  },
  stop_motion_dolly: {
    lens_mm: 'practical — physical camera implied',
    distance: 'medium',
    camera_move: 'stepped 12fps drift, deliberate frame-to-frame discontinuity',
    move_options: ['stepped 12fps drift', 'on-twos hold then move', 'tilted-rig dolly'],
    intent: 'Stop-motion stepping. Motion is intentionally discontinuous — the texture IS the technique. Reads handcrafted, never smooth.',
    use_when: 'hand_doodle_animated stop-motion register (Chipotle "Back to the Start", Wes Anderson Isle of Dogs spots).',
    reference: 'Chipotle "Back to the Start", Wes Anderson stop-motion, LAIKA (Coraline) action beats.'
  },
  doodle_arrow_overlay: {
    lens_mm: 'photoreal or stylized base',
    distance: 'medium',
    camera_move: 'hold + hand-drawn vector overlay (arrow / circle / underline) animates onto frame',
    move_options: ['hold with hand-drawn arrow overlay', 'hold with hand-drawn circle annotation', 'hold with sketch-style underline + caption'],
    intent: 'Sketch-overlay annotation grammar. Live-action OR animated base; hand-drawn graphic LAYERS in. Used for explainer-style commercial moments.',
    use_when: 'hand_doodle_animated explainer beats; product-feature callouts; user-flow visualizations.',
    reference: 'Mailchimp Freddie spots, Spotify Wrapped (annotation overlays), Squarespace explainer cuts.'
  },
  watercolor_soft_pan: {
    lens_mm: 'painterly — no optical equivalent',
    distance: 'medium-wide',
    camera_move: 'slow horizontal pan with painterly bleed at frame edges',
    move_options: ['slow horizontal pan with edge bleed', 'gentle parallax over watercolor layers', 'static hold with breathing color fields'],
    intent: 'Watercolor / hand-painted register. Edges bleed, color fields breathe, motion is gentle and atmospheric.',
    use_when: 'surreal_dreamlike establishing beats; painterly_prestige world-building beats.',
    reference: 'Loving Vincent painterly grammar, Studio Ghibli backgrounds, Cadbury "Gorilla" texture treatment.'
  },
  surreal_dream_zoom: {
    lens_mm: 'continuously shifting — hyperreal',
    distance: 'subjective',
    camera_move: 'continuous focal-length shift, dreamlike drift',
    move_options: ['continuous focal-length shift', 'dolly-zoom variation', 'swimming subjective drift'],
    intent: 'Subjective dream-state grammar. Geometry shifts as the camera moves — what was wide becomes telephoto becomes wide again. Reads as inside the head, not as observed.',
    use_when: 'surreal_dreamlike emotional climaxes, inside-character-mind beats.',
    reference: 'Eternal Sunshine dream sequences, Honda "Cog" surreal causality, Cadbury "Gorilla" buildup.'
  },
  mixed_media_collage_cut: {
    lens_mm: 'graphic + photographic mix',
    distance: 'varied',
    camera_move: 'graphic-overlay transition between layered textures',
    move_options: ['photo cutout slides over painted background', 'animated graphic dissolves to live action', 'three-layer parallax with hand-drawn foreground'],
    intent: 'Mixed-media grammar. Photo + paint + graphic + line work coexist in one frame. Transitions are graphic events, not optical.',
    use_when: 'hand_doodle_animated commercial register that mixes archival/photo with illustration.',
    reference: 'Wes Anderson Asteroid City graphic inserts, Spotify Wrapped 2023 mixed-media reveals.'
  },
  cel_shade_action_pop: {
    lens_mm: 'graphic — no optical equivalent',
    distance: 'medium',
    camera_move: 'kinetic burst frame with motion lines as graphic element',
    move_options: ['burst frame with radial motion lines', 'speed lines + impact frame freeze', 'graphic shockwave pulse'],
    intent: 'Anime action grammar. Motion is GRAPHIC, not optical — radial lines, impact freezes, speed-line bursts. Reads kinetic without physically moving the camera.',
    use_when: 'hand_doodle_animated action peaks; kinetic_montage reveals when style_category is animated.',
    reference: 'Naruto / One Piece action grammar, Into the Spider-Verse impact frames.'
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
// V4 CAST BIBLE — episode-prompt injector
// ═══════════════════════════════════════════════════════════════════════
//
// Phase 3 of the Cast Coherence Overhaul. The story-level cast_bible is
// rendered into the episode system prompt as a HARD CONSTRAINT — Gemini
// must reference ONLY the listed persona_index values when authoring
// dialogue. Eliminates phantom-character invention at source (the bug
// surfaced in 2026-04-25 production logs).
//
// Empty principals OR null bible → returns empty string (legacy stories
// without a bible are unaffected; checkPersonaIndexCoverage stays as the
// safety net).
//
// Flags (read at prompt-assembly time):
//   BRAND_STORY_CAST_BIBLE_HARD_CONSTRAINT (default 'true')
//     — when 'false', emit guidance framing instead of HARD CONSTRAINT.
//       Validator's checkPersonaIndexCoverage continues as safety net.
//   BRAND_STORY_BIBLES_DISABLE (default 'false')
//     — when 'true', kill switch — emit empty string (also disables SSB).
//       Used to disengage both bibles cleanly without code rollback if
//       SSB pattern regresses.
function _buildCastBibleBlock(bible) {
  if (process.env.BRAND_STORY_BIBLES_DISABLE === 'true') return '';
  if (!bible || typeof bible !== 'object') return '';
  const principals = Array.isArray(bible.principals) ? bible.principals : [];
  if (principals.length === 0) return '';

  const hardConstraint = process.env.BRAND_STORY_CAST_BIBLE_HARD_CONSTRAINT !== 'false';
  const indexes = principals.map(p => p.persona_index).filter(i => Number.isInteger(i));
  const indexList = `[${indexes.join(', ')}]`;

  const principalLines = principals.map(p => {
    const pieces = [
      `[${p.persona_index}] ${p.name || 'Unnamed'}`,
      p.role ? `role=${p.role}` : null,
      p.gender_inferred && p.gender_inferred !== 'unknown' ? `gender=${p.gender_inferred}` : null,
      p.elevenlabs_voice_name ? `voice=${p.elevenlabs_voice_name}` : null
    ].filter(Boolean);
    return `  - ${pieces.join(' · ')}`;
  }).join('\n');

  if (hardConstraint) {
    return `═══════════════════════════════════════════════════════════════
CAST BIBLE — HARD CONSTRAINT (locked at story creation):
═══════════════════════════════════════════════════════════════

This story has a fixed cast. You MUST only reference persona_index values ${indexList}
in this episode's screenplay. Any character not in this list is non-speaking.
Render incidental characters via B_ROLL or REACTION cutaways. Do NOT invent
persona_index values outside this range — the validator will reject any
dialogue line that does, and the user will have to retake the screenplay.

PRINCIPALS (the only characters who may speak in this episode):
${principalLines}

If the storyline mentions a character not in this list, they are NON-SPEAKING.
Frame them as B_ROLL_ESTABLISHING, REACTION cutaways, or off-screen presence —
never give them a dialogue line, never assign them a persona_index outside ${indexList}.
`;
  }

  // Guidance framing (BRAND_STORY_CAST_BIBLE_HARD_CONSTRAINT=false)
  return `═══════════════════════════════════════════════════════════════
CAST BIBLE (story-level guidance):
═══════════════════════════════════════════════════════════════

This story has principals at persona_index values ${indexList}. Strongly prefer
to keep dialogue with these characters. If the narrative genuinely demands a
foil character, prefer B_ROLL/REACTION cutaways over inventing a new speaking
persona_index — but the validator will not block dialogue with a new
persona_index if it is essential to the scene.

PRINCIPALS:
${principalLines}
`;
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
//
// Kill switch: BRAND_STORY_BIBLES_DISABLE=true emits empty string (parity
// with Cast Bible — when SSB pattern regresses, both bibles disengage).
function _buildSonicSeriesBibleBlock(bible) {
  if (process.env.BRAND_STORY_BIBLES_DISABLE === 'true') return '';
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

// ─────────────────────────────────────────────────────────────────────────
// V4 Audio Layer Overhaul Day 3 — Hebrew dialogue register
// ─────────────────────────────────────────────────────────────────────────
//
// The DIALOGUE MASTERCLASS examples in this file are English (Fleabag,
// Succession, The Bear, etc.) and the principles are language-universal —
// Five Jobs, Voice as a Weapon, Subtext Iron Rule. What is NOT universal is
// the prosodic contour of Hebrew dialogue and the way subtext is encoded.
// Hebrew is grammatically more direct (verb-subject-object cadence, fewer
// articles, clipped imperatives), leans on different rhetorical structures
// (rabbinic argument, IDF brevity, Levantine warmth), and the
// subtext-vs-said gap operates differently than in English. Translating
// English masterclass examples into Hebrew makes the dialogue sound like
// a translation. This block adds a Hebrew-specific register so Gemini
// authors Hebrew dialogue from the right priors.
//
// Returns empty string for any non-Hebrew story so the block is a pure
// addition to Hebrew episodes — zero impact on English/other-language
// stories. Gated by BRAND_STORY_HEBREW_MASTERCLASS (default ON for `he`).
function _buildHebrewMasterclassBlock(storyLanguage) {
  if (!storyLanguage || typeof storyLanguage !== 'string') return '';
  if (!storyLanguage.toLowerCase().startsWith('he')) return '';
  if (String(process.env.BRAND_STORY_HEBREW_MASTERCLASS || 'true').toLowerCase() === 'false') return '';

  return `═══════════════════════════════════════════════════════════════
DIALOGUE MASTERCLASS — HEBREW REGISTER (when story.language === 'he')
═══════════════════════════════════════════════════════════════

The principles above (Five Jobs, Voice as a Weapon, Subtext Iron Rule, Hooks
Taxonomy, Archetype Pair Dynamics, Pacing & Rhythm, the One Great Line, the
8 craft moves) ALL apply to Hebrew dialogue. The block below is what
CHANGES — the prosodic contour, the rhetorical cadence, and the references
that anchor Gemini to the right Hebrew register. DO NOT translate the
English masterclass examples. Author each line in Hebrew from this register
directly. The audio layer (eleven-v3 with language_code='he') will render
the line natively; English-style cadence forced into Hebrew syntax sounds
like a foreign news anchor reading from a script.

CADENCE FAMILIES (pick one per character, lock it across the season)

1) RABBINIC / TALMUDIC ARGUMENT
   Hebrew has a thousand years of rhetorical structure built around
   answer-by-counter-question, citing-by-allusion, and refusing-to-conclude.
   In dialogue, this surfaces as: counter-questions instead of answers,
   "וַדאי" / "אבל בדיוק" / "ואם כך" as turn-pivots, and a habit of opening
   with the contrary case before stating one's own. The character's status
   is the precision of their refusal to settle, not the loudness of their
   claim. References: Shtisel (Yehonatan Indursky / Ori Elon — Akiva and Shulem
   table debates); Srugim (rabbinical-college register without the comedy);
   Beauty Queen of Jerusalem (Sephardic family debates with the same
   refuse-to-conclude move).

2) IDF / SECURITY-SERVICE CLIPPED IMPERATIVE
   Hebrew under operational pressure compresses to 1-3 word imperatives,
   call-signs, and verb-only commands. Civilians under stress code-switch
   into this register too — it's the cultural pressure-language. References:
   Fauda (Lior Raz / Avi Issacharoff — Doron's command rhythm); Tehran (Moshe
   Zonder — Tamar's civilian-under-cover pressure speech); Hatufim (Gideon
   Raff — POW de-briefings, where every clipped answer hides a fault line).

3) LEVANTINE WARMTH / FAMILY KITCHEN
   Hebrew warmth is built on diminutives ("חמודה", "מותק"), endearments
   that can sting ("נשמה", "שלי"), and relentless feeding-as-conversation.
   Subtext lives in what's offered (food, coffee, a chair) more than in
   the words. References: Beauty Queen of Jerusalem; Shtisel (Friday-night
   dinner scenes); Hashoter Hatov (the affection-disguised-as-mockery
   between partners).

4) SECULAR TEL AVIV / INFORMAL URBAN
   Code-switched English loanwords ("בייסיק", "סבבה", "אחי", "דאחק"),
   sentence-final particles ("נו", "כאילו"), and an under-statement floor
   that performs being unimpressed. References: Srugim's secular-leaning
   characters; Shababnikim's young-adult banter; the everyday register of
   most modern Tel Aviv prestige TV.

5) MIZRAHI / SEPHARDIC FAMILY REGISTER
   Distinct prosodic stress, code-switching with Arabic and Ladino loanwords
   ("יא חביבי", "אמא'לה"), and the family-elder-as-final-authority structure
   threaded through dialogue. References: Beauty Queen of Jerusalem; Zaguri
   Imperia (Maor Zaguri — multi-generational Mizrahi family rhythm).

GRAMMAR YOU MUST RESPECT (the structural floor)

- VERB-SUBJECT-OBJECT order is normative; SUBJECT-VERB-OBJECT reads as
  English-translation cadence. Author "אמרתי לך כבר", not "אני כבר אמרתי לך".
- Hebrew has no auxiliary "do/does"; questions land via intonation only.
  Use them — the absence of a marker IS the move.
- The "Yes-No question with implied answer" (תשובה ידועה מראש) is a major
  rhetorical device. "אתה לא חושב שזה מספיק?" — the speaker isn't asking.
- Diminutives are weaponizable: "חמודה" between strangers can be patronising
  or warm depending on intonation; the screenplay must signal which via
  expression_notes + subtext.
- Definiteness ("ה־") shifts emphasis. "הילד" vs "ילד" is not "the boy" vs
  "a boy" — it's "the (specific, known) boy" vs "(any) boy". Use the gap
  to encode information asymmetry.

REGISTER COLLISIONS (where Hebrew dialogue naturally tilts)

- Religious vs secular characters: don't make this a costume choice. It's a
  vocabulary choice. A religious character says "בעזרת השם", "אם ירצה השם";
  a secular character avoids the pious register and may parody it. The
  collision IS the dramatic engine in Shtisel-adjacent material.
- Native Hebrew vs immigrant Hebrew: Russian-Israeli, Ethiopian-Israeli,
  Anglo-Israeli, Mizrahi-Sephardic, Arab-Israeli speakers each carry
  distinct prosodic contours and word choices. Author the appropriate
  inflection layer if the character bible names it; do not flatten everyone
  to "neutral Israeli Hebrew".
- Generational shift: 60+ characters use formal verb conjugations and
  direct pronouns; under-30s code-switch and elide. The generational
  collision is one of Israeli prestige TV's most reliable conflict engines.

HEBREW-REGISTER CRAFT MOVES — principles + references (4 categories, 2-3 moves each)
(These are PRINCIPLES, not templates. Author Hebrew dialogue from THIS
character's cadence family + this episode's pressure, not from translated
English priors. The references anchor the corpus Gemini has Hebrew priors
on; cite the rubric, then compose your own line.)

1) IDIOMATIC HEBREW STRUCTURE — the line that does not read like a translation
   MOVE A — VERB-FIRST IMPERATIVES, SUBJECT ELIDED: Hebrew imperatives drop the pronoun. "בוא נזוז" carries decision + status in two words. Authoring "אני מוכן ללכת" reads as English-translated dressing.
   MOVE B — INDIRECTION OVER DECLARATION: empathy / loss / regret are acknowledged BY THEIR EFFECT, not named. "לא חשבתי שזה ייקח אותה ככה" lands harder than "אני מצטערת על מה שקרה לאמא שלך" — Hebrew prestige refuses on-the-nose emotional declarations.
   MOVE C — DEFINITENESS AS INFORMATION ASYMMETRY: the article "ה־" is not just "the". "הילד" presumes a known referent; "ילד" leaves it open. Use the gap to encode who-knows-what between the speakers.
   ANTI-PATTERN: SVO order in narrative speech; Hebrew vocabulary draped over English syntax; over-marked subject pronouns ("אני אמרתי לך"); filler "כן" before every answer.
   REFERENCES: Hagai Levi / In Treatment Hebrew session work; Yehonatan Indursky + Ori Elon / Shtisel kitchen-table register; Lior Raz + Avi Issacharoff / Fauda command-rhythm; Moshe Zonder / Tehran civilian-pressure speech.

2) REGISTER LOCK — character's cadence family does not drift mid-scene
   MOVE A — RELIGIOUS REGISTER USES THE FORMULAS: "בעזרת השם", "אם ירצה השם", "ברוך השם" are mood-rings of observance level. A religious character authored without them reads secular; subtext lives in HOW the formula is delivered.
   MOVE B — IDF / OPERATIONAL REGISTER COMPRESSES UNDER PRESSURE: even civilians code-switch into clipped imperatives when stakes rise — that's the cultural pressure-language. Author the compression, don't translate around it.
   MOVE C — TEL AVIV INFORMAL REGISTER USES THE PARTICLES: "סבבה", "בכלל", "כאילו", "נו" are not filler — they are the secular urban under-30 voice's signature. Their absence reads as stiffness; their misuse reads as parody.
   ANTI-PATTERN: religious character speaking in secular phrasing; full sentences in Hebrew under operational pressure where clipped is normative; over-formal speech in a Tel Aviv young-adult character; mixing all four registers within a single character.
   REFERENCES: Eliezer Shapira + Hava Divon / Srugim rabbinical-college register; Lior Raz / Fauda IDF-civilian code-switch; Maor Zaguri / Zaguri Imperia generational register-stack; Shababnikim young-adult banter.

3) CULTURAL ENCODING — Hebrew family / domestic scenes work through gesture, not declaration
   MOVE A — OFFER IS THE EMOTIONAL ACKNOWLEDGEMENT: "שבי, שתי קפה" is the love. The line names the gesture; expression_notes carries the rest. Hebrew warmth is OFFERED, not announced.
   MOVE B — DIMINUTIVES CARRY DOUBLE-VALENCE: "אמא'לה", "מותק", "חמודה" can be tender or weaponised depending on the speaker's relation and the scene's pressure. Author the diminutive; let subtext flag which valence is loaded.
   MOVE C — FOOD / OBJECT / RITUAL AS PROXY: the kitchen, the chair, the kettle, the shabbos candle do the emotional work the dialogue refuses. The line orbits the object; the affection lives in the orbit.
   ANTI-PATTERN: family scenes that monologue feelings ("אני אוהבת אותך כל כך" stated directly in a domestic beat); diminutives stripped to read as "neutral Israeli Hebrew"; the object that should carry meaning treated as decoration.
   REFERENCES: Beauty Queen of Jerusalem (Sephardic kitchen rhythm); Shtisel Friday-night dinner scenes; Hashoter Hatov partner-banter; Hagai Levi / Our Boys grief-around-objects.

4) GENERATIONAL + ETHNIC REGISTER COLLISION — distinct voices in the same room
   MOVE A — 60+ CHARACTERS USE FORMAL CONJUGATION + DIRECT PRONOUNS: their syntax is unhurried, their pronouns explicit. The under-30s opposite them code-switch and elide. The collision IS the dramatic engine.
   MOVE B — MIZRAHI-SEPHARDIC ELDER STACKS WARMTH WITH AUTHORITY: "אמא שלי, אמא'לה — שב, תקשיב לי טוב" — diminutive + imperative are SIMULTANEOUS, not sequential. Authority is delivered through warmth, not despite it.
   MOVE C — IMMIGRANT INFLECTION IS A VOCAL FACT, NOT A COSTUME: Russian-Israeli, Anglo-Israeli, Ethiopian-Israeli, Arab-Israeli speakers each carry distinct prosodic contours and word-choice patterns. If the character bible names the inflection, author from inside it — don't flatten to "neutral Israeli Hebrew".
   ANTI-PATTERN: family elder addressing adult son in identical register to a stranger; immigrant character authored without the prosodic inflection their bible names; under-30 character speaking like a 60+ formal-conjugation register; Mizrahi register collapsed into Ashkenazi neutral.
   REFERENCES: Maor Zaguri / Zaguri Imperia multi-generational Mizrahi rhythm; Jadayef Bachari + Eitan Anaki / The Boys 1990s ethnic-register collision; Sayed Kashua / Arab Labor Arabic-Hebrew code-switch; Anat Gov / Best Friends generational-cadence pairing.

ELEVEN-V3 PERFORMANCE TAGS WORK IN HEBREW
The DIALOGUE PERFORMANCE TAGS taxonomy above ([whispering], [firmly],
[exhaling], etc.) is voice-and-context dependent but NOT language-dependent.
Author tags inline on Hebrew lines using the same English bracket
notation — eleven-v3 parses tags before language-aware synthesis. Example:
  "[barely whispering] לא ידעתי. באמת לא ידעתי."
  "[firmly] תפסיק. עכשיו."
  "אני בסדר. [exhaling]"
The tag derivation rules (emotion → tag selection, subtext → placement,
archetype → baseline) ALL apply identically to Hebrew dialogue.

LANGUAGE CONSISTENCY (the hard rule)
Every dialogue line in this episode MUST be in Hebrew when story.language is
'he'. Do not slip into English mid-line. Code-switching English loanwords is
LEGITIMATE within secular Tel Aviv register ("סבבה", "בייסיק") — that is
Israeli speech. Authoring full English clauses inside Hebrew dialogue is NOT.
The TTS layer will route Hebrew lines through eleven-v3 with language_code='he';
mid-line English will render in an English contour and break the spell.
`;
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
    commercialBrief = null,
    // Cast Bible Phase 3 — story-level cast contract. When provided, the
    // prompt's HARD CONSTRAINT block lists the permitted persona_index
    // values; Gemini must reference ONLY those when authoring dialogue.
    // Eliminates phantom-character invention at source. Null (legacy
    // stories) → empty block emitted, behavior identical to today.
    castBible = null,
    // V4 Audio Layer Overhaul Day 3 — Hebrew authorship register.
    // ISO 639-1 language code for the story (storyline.language, propagated
    // by BrandStoryService when the user selects Hebrew at story creation).
    // Default 'en' preserves the current English-authorship pipeline. When
    // 'he', _buildHebrewMasterclassBlock injects the Hebrew register block
    // (rabbinic / IDF / Levantine / Israeli prestige TV cadence).
    storyLanguage = 'en',
    // V4 Phase 5b — genre LUT pool, resolved by the caller via
    // BrandKitLutMatcher.getGenreLutPool(genre). When non-empty, the lutBlock
    // shows ONLY the candidate LUTs for the active genre (eliminates the
    // legacy 8-LUT bypass that produced bs_cool_noir on commercial). When
    // empty/null AND hasBrandKitLut is false, the prompt instructs Gemini
    // NOT to emit a lut_id — caller will fill in the genre default.
    genreLutPool = null
  } = options;

  const prevBlock = _buildPreviousEpisodesBlock(storyline, previousEpisodes);
  const brandContextBlock = brandKit ? _buildBrandKitContextBlock(brandKit) : '';
  const focusBlock = _buildCinematicFocusBlock(storyFocus);
  // Cast comes BEFORE sonic — every downstream block (sonic, character cheat-sheet,
  // beat-type guidance) may reference persona names by index, so the cast
  // contract is established first.
  const castBibleBlock = _buildCastBibleBlock(castBible);
  const sonicBibleBlock = _buildSonicSeriesBibleBlock(sonicSeriesBible);
  // Day 3 — Hebrew register block (empty string for English / non-Hebrew stories).
  const hebrewMasterclassBlock = _buildHebrewMasterclassBlock(storyLanguage);

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

  // LUT instruction — V4 Phase 5b. Three cases:
  //   1. story-level LUT already locked      → tell Gemini NOT to emit lut_id
  //   2. genreLutPool provided (non-empty)   → show ONLY the genre-anchored
  //                                             pool (no legacy 8-LUT bypass)
  //   3. no pool resolvable                   → tell Gemini NOT to emit lut_id;
  //                                             caller (BrandStoryService) will
  //                                             fill in the genre default via
  //                                             matchByGenreAndMood post-hoc
  const hasGenrePool = Array.isArray(genreLutPool) && genreLutPool.length > 0;
  const lutBlock = hasBrandKitLut
    ? `\nLUT: This story has a brand-kit-derived LUT already locked. Do NOT emit a lut_id field.`
    : (hasGenrePool
      ? `\nLUT SELECTION (genre-anchored pool — ${storyline.genre || 'unknown genre'}):
Pick ONE LUT from this pool for the episode based on the visual_style_prefix you write.
Emit as "lut_id" at the top level of your JSON. The pool is filtered to the active
genre — there are NO out-of-genre options. If you cannot decide, pick the first entry.

LUT POOL (genre = ${storyline.genre || 'unknown'}):
${_formatLutLibraryForPrompt(genreLutPool)}

Rule: the LUT must match the mood and era suggested by visual_style_prefix.`
      : `\nLUT: No LUT pool resolvable for this story (missing genre). Do NOT emit a lut_id field — the post-production layer will resolve it via the genre default.`);

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

${_resolveGenreRegisterBlock(storyline.genre)}

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

${castBibleBlock}

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

DIALOGUE CRAFT MOVES — principles + references (8 categories, 2-3 moves each)
(These are PRINCIPLES, not templates. Do not echo any phrasing implied by the
references — read them as a direction-of-travel signal, then write your own
dialogue from this story's characters, this episode's pressure, and this
scene's opposing intents. The references are corpora Gemini has rich priors
on; citing 3-4 per category broadens the register's convex hull instead of
collapsing it to one show's voice.)

1) DRAMA — what carries a loss
   MOVE A — DEFLECTION CARRIES THE LOSS: surface line refuses the ask; the refusal IS the answer. The wound deflects with a small, factual statement that admits everything by hiding it.
   MOVE B — CONFESSION-AS-ATTACK: a character truth-tells precisely to wound the listener; the "honesty" is weaponised. The vulnerable thing is said with steel.
   MOVE C — RITUALIZED POLITENESS AS DISTANCE: characters stay inside scripted social register (formality, professional courtesy, family-dinner pleasantries) while the room cracks underneath the words.
   ANTI-PATTERN: the question is asked once, answered once; both lines carry the same emotional charge; nobody loses any ground.
   REFERENCES: Mike White / The White Lotus dinner-table beats; Sharon Horgan / Bad Sisters interrogations; Jesse Armstrong / Succession family-dinner evasions; Hagai Levi / In Treatment session deflections.

2) ACTION — what speech does under pressure
   MOVE A — CLIPPED IMPERATIVES AS POWER ASYMMETRY: 1-3 word commands establish hierarchy without explanation. The shorter line wins the scene.
   MOVE B — BANTER AS RELIEF VALVE: quip mid-firefight is the genre's signature breath; the humour carries character voice the kinetic beats had no room for.
   MOVE C — OVERLAP-AND-INTERRUPT: dialogue clips itself — gunshot, explosion, engine roar, another character cutting in — write the aborted line and trust the cut.
   ANTI-PATTERN: full sentences and complete thoughts under fire; characters explaining what they are doing while doing it; villain monologues longer than three lines.
   REFERENCES: Michael Mann / Heat command-radio rhythms; Doug Liman / Bourne brittle technical chatter; Chad Stahelski / John Wick economy of language; George Miller / Mad Max: Fury Road minimalist exchange.

3) COMEDY — where the laugh lands
   MOVE A — SWERVE ON THE SECOND LINE: setup invites the expected emotional beat; the reply denies it. The denial IS the joke.
   MOVE B — STATUS-FLIP ON THE LAUGH: the character with low status takes the room with one line; the room realigns under the punch.
   MOVE C — SPECIFIC-NOUN COMEDY: ordinary objects named with surgical precision do more work than adjectives; the proper noun (a brand, a model, a year) carries the laugh.
   ANTI-PATTERN: the joke is in the verb, the line is over-explained, the punchline is a feeling instead of a fact.
   REFERENCES: Phoebe Waller-Bridge / Fleabag confessional rhythm; Armando Iannucci / Veep oval-office register; Christopher Storer / The Bear kitchen-chaos overlap; Jesse Armstrong / Succession bureaucratic acid.

4) THRILLER — the room knows more than they do
   MOVE A — DRAMATIC IRONY DOUBLE-MEANING: every word in the line lands at two elevations simultaneously; the viewer hears both, the speakers hear one.
   MOVE B — COILED STILLNESS THEN FLIP: low-affect dialogue holds for 2-3 beats; one line then changes the room's temperature without raising volume.
   MOVE C — WITHHOLDING AS PRESSURE: the character refuses to name the thing in the room; the refusal IS the pressure the scene sustains.
   ANTI-PATTERN: tension released by the dialogue; characters narrating their fear; the threat made explicit before the reveal.
   REFERENCES: David Fincher / Zodiac procedural restraint; Park Chan-wook / The Handmaiden information asymmetry; Tony Gilroy / Andor interrogations; Jane Campion / The Power of the Dog quiet menace.

5) MYSTERY — what a question hides
   MOVE A — THE TILTED QUESTION: a single noun thrown at a character functions as the whole interrogation; refusal-to-elaborate IS the move.
   MOVE B — REFUSAL TO CLARIFY: when asked to explain, the character returns the question; pressure builds through the unanswered ask.
   MOVE C — ANSWER-WITH-QUESTION: the response is itself a question; both speakers now hold information neither will surface; the room becomes the puzzle.
   ANTI-PATTERN: full procedural question-and-answer; the suspect explains motive; the detective summarises what we just saw.
   REFERENCES: Nic Pizzolatto / True Detective S1 interrogation grammar; Phoebe Waller-Bridge / Killing Eve evasion register; David Lynch + Mark Frost / Twin Peaks oblique exchanges; Steven Knight / Peaky Blinders elliptical threats.

6) WARM-HEART / BRAND — loyalty is a noun, not an adjective
   MOVE A — INDIRECTION IS STILL DIRECT: the product is never named in dialogue; the character returns to it, sits with it, depends on it; the action carries the loyalty the words refuse.
   MOVE B — THE SMALL FACT THAT IS THE STORY: a tiny domestic detail (the door, the order, the chair, the Tuesday) becomes the relationship's whole symbol; specific-noun does what claim-language cannot.
   MOVE C — SILENCE AROUND THE PRODUCT: the brand sits in frame, named once if at all; the dialogue moves around it like furniture; the affection is in the orbit, not the praise.
   ANTI-PATTERN: testimonial-register dialogue ("amazing", "the best", "changed my life"); the character speaks about the product instead of with it in their hands.
   REFERENCES: Phoebe Waller-Bridge / Fleabag café scenes; Matthew Weiner / Mad Men prop grammar; Hirokazu Kore-eda / Shoplifters family ritual around objects; Taika Waititi / Hunt for the Wilderpeople loyalty by indirection.

7) HORROR — what stays calm
   MOVE A — UNDERREACTION: the character speaks at scale appropriate to a normal day while the world has tilted; the gap between affect and event is the dread.
   MOVE B — THE TOO-LATE NOTICING: dialogue acknowledges the wrong thing first — a small detail — long after the viewer has seen the larger one. Recognition arrives at the wrong moment.
   MOVE C — THE BANAL AFTER THE UNCANNY: post-event dialogue is procedural, domestic, ordinary; the refusal to dramatize is what plants the dread retroactively.
   ANTI-PATTERN: characters narrating their fear ("Oh god"), full-volume reaction, dialogue that releases the tension the image just earned.
   REFERENCES: Ari Aster / Hereditary kitchen-table aftermath; Jordan Peele / Get Out polite small-talk pressure; Robert Eggers / The Witch period-register dread; Mike Flanagan / The Haunting of Hill House underreacted grief.

8) PERIOD — the era is the voice
   MOVE A — REGISTER AS PLACEMENT: vocabulary, syntax, formality all locate the viewer in time without a title card; modern feeling translated into period speech.
   MOVE B — CLASS AS VOCABULARY: a single word choice signals education, station, region; characters speak from inside their class, not at it.
   MOVE C — FORMAL SYNTAX HIDING MODERN FEELING: the longing, the rage, the desire are present-tense; the construction holds them at the era's distance and amplifies the pressure.
   ANTI-PATTERN: period costume with contemporary cadence; characters speaking in modern apologetics; anachronistic informalities ("yeah", "okay", "cool") in the wrong century.
   REFERENCES: Andrew Davies / Bleak House adaptations; Julian Fellowes / Downton Abbey class-marked dialogue; Yorgos Lanthimos / The Favourite formal cruelty; Greta Gerwig / Little Women interlocking sisterly voices.

═══════════════════════════════════════════════════════════════
DIALOGUE PERFORMANCE TAGS (the audio layer — eleven-v3 ONLY)
═══════════════════════════════════════════════════════════════

The TTS engine that renders your dialogue (ElevenLabs eleven-v3) accepts INLINE
PERFORMANCE TAGS — bracketed instructions inside the dialogue string that shape
the voice's prosody. THIS IS HOW THE AUDIO LAYER MAKES A CHOICE INSTEAD OF
INHERITING A DEFAULT. Without tags, every line — angry, broken, tender, tilted —
synthesizes with the same neutral contour. With tags, suppression has texture,
fear has a held breath, defiance has steel. You author them inline alongside
each line. They are NOT a downstream wrapper.

TAG TAXONOMY — verbatim from the eleven-v3 spec (do not invent new tags)
  EMOTION & DELIVERY (most common):
    [whispering]   [barely whispering]   [softly]   [evenly]   [flatly]
    [firmly]       [slowly]              [quizzically]
    [sad]          [cheerfully]          [cautiously]   [indecisive]
    [sarcastically][sigh]                [exhaling]     [slow inhale]
    [chuckles]     [laughing]            [giggling]
    [groaning]     [coughs]              [gulps]
  AUDIO EVENTS (use sparingly — once per beat at most):
    [applause]     [leaves rustling]     [gentle footsteps]
  DIRECTION (use only when context truly demands it):
    [auctioneer]   [jumping in]

PLACEMENT — where the bracket goes inside the line
  PREFIX (most common): [barely whispering] I had no choice.
  MID-LINE (texture shift inside the line): I'm fine [exhaling] really.
  STACKED (rare — at most TWO tags, separated by comma): [sarcastically, slowly] You really thought that would work.
  END-OF-LINE BREATH (paired with emotional_hold): I'm sorry. [slow inhale]

TAG DERIVATION — translate the V4 craft fields into tags
THIS IS THE LOAD-BEARING TABLE. Read it before you author any tagged dialogue.

  beat.emotion — primary tag selection (the SURFACE register)
    "broken"               → [barely whispering] or [sigh]
    "defiant"              → [firmly]
    "resigned"             → [exhaling] or [slowly]
    "amused but hiding it" → [chuckles] mid-line
    "stunned"              → [slow inhale] before the line
    "cheerful (fake)"      → [cheerfully] (irony lands BECAUSE the subtext disagrees)
    "composed"             → [evenly] or no tag (composed often = the absence)

  beat.subtext — tag PLACEMENT and TEXTURE (overrides naive emotion mapping)
    Same emotion lands different tags depending on whether the character
    is leaning IN (vulnerable, leaning toward truth) or OUT (defended,
    pulling back from truth). Subtext tells you which.
    Example —
      surface:  "I'm fine."
      subtext:  "I am drowning."
      → [exhaling] before the line + [slowly] on it (leaning in, almost saying)
    Example (same surface, opposite subtext) —
      surface:  "I'm fine."
      subtext:  "I am protecting myself from you."
      → [evenly] or [flatly] (leaning out, sealed off)

  beat.beat_intent — tag INTENSITY
    "persuade" / "reveal" → softer, leaning-in tags ([softly], [slowly])
    "wound" / "escalate"  → clipped, defended tags ([firmly], [flatly])
    "cooldown" / "payoff" → contemplative ([exhaling], [slow inhale])

  beat.pace_hint — pairs with the speed param
    pace_hint=slow on a weighted beat → [slowly] inline (tag shapes contour;
    speed param scales clock — they are NOT the same lever)
    pace_hint=fast → no tag (speed param does the work)

  scene.opposing_intents — tag patterns ACROSS speakers
    Per-speaker bias — encode the dynamic in the tags:
      A wants intimacy, B wants distance:
        A's lines lean IN  → [softly], [barely whispering]
        B's lines lean OUT → [evenly], [flatly], [exhaling]
      A wants information, B wants to withhold:
        A's lines press   → [firmly]
        B's lines deflect → [chuckles], [slowly], [quizzically]

  beat.emotional_hold — author the breath that owns the silence
    A line ending in emotional_hold:true earns a paired audio choice:
      "I'm sorry. [slow inhale]" — silence carries breath.
      "I know. [exhaling]"        — silence carries release.
    Silence-with-breath is a different beat from silence. Author both.

  persona.dramatic_archetype — establishes the BASELINE before any tag
    Stoic / Mentor / Authority      → baseline [evenly] floor (under-tag)
    Volatile / Trickster / Rebel    → no baseline (let it run)
    Wounded_healer / Ingenue        → baseline [softly] for vulnerable beats
    Hero / Antihero                 → context-dependent (no baseline)
  Match the archetype's baseline so the four cast members do NOT collapse
  into the same v3 default register.

TAG ECONOMY — when NOT to tag
  Not every line needs a tag. The Stoic baseline IS a choice. When the
  character's intentional read is flat / composed / withheld, mark the
  beat with the literal annotation [no_tag_intentional: stoic_baseline]
  inline at the start of the dialogue:
    "[no_tag_intentional: stoic_baseline] I'll consider it."
  The validator recognises this as a legitimate untagged line. The TTS
  layer strips this annotation before synthesis.

TAG CRAFT MOVES — principles + references (5 categories, 2-3 moves each)
(These are PRINCIPLES, not templates. Do not echo any phrasing implied by
the references — read them as a direction-of-travel signal, then choose
the tag from THIS character's archetype, this beat's emotion+subtext, and
this scene's opposing intents. The references are voice-direction corpora
that anchor each category; cite the rubric, then author from your own
scene.)

1) TAG SELECTION — what the audio choice IS
   MOVE A — TAG IS THE SUPPRESSION, NOT THE DECLARATION: when surface line refuses what subtext is admitting, author the tag for the BREATH that fails the line, not the emotion the words name. Composed surface + drowning subtext earns [exhaling] / [slowly], not [sad].
   MOVE B — TAG MIRRORS ARCHETYPE BASELINE BEFORE BEAT EMOTION: a Stoic does not get [softly] on a tender line — they get [evenly] or [no_tag_intentional: stoic_baseline]. A Volatile does not get a tag at all on the high-affect lines — let the v3 default carry the rage. Archetype is the tuning fork; emotion is the inflection on top.
   MOVE C — IRONIC TAGS LAND BECAUSE SUBTEXT DISAGREES: [cheerfully] on a "fake-cheerful" emotion lands as cruelty BECAUSE the subtext flags the lie. The same tag without a disagreeing subtext just reads as cheerful. Pair the tag with the subtext that exposes it.
   ANTI-PATTERN: tag echoes the surface emotion verbatim ([sad] on a "broken" line); tag homogenisation across cast ([softly] on every persona); tag contradicts the beat_intent (e.g. [chuckles] on an "escalate" beat).
   REFERENCES: the under-acted register of Bryan Cranston / Breaking Bad confessions; Saoirse Ronan / Lady Bird kitchen-fights; Lena Headey / Game of Thrones court delivery; Tilda Swinton / The Souvenir tonal control; Ben Whishaw / This Is Going To Hurt suppressed vocal collapse.

2) TAG PLACEMENT — where the bracket goes
   MOVE A — PREFIX SETS THE ROOM TEMPERATURE: opening tag tells the listener what register to expect before the words land. Use prefix when the WHOLE line carries one read — [firmly] We are leaving now.
   MOVE B — MID-LINE TAG MARKS THE TURN: line that pivots gets the tag where the pivot lives — I'm fine [exhaling] really. The breath IS the admission the words deny.
   MOVE C — END-OF-LINE BREATH OWNS THE SILENCE THAT FOLLOWS: when the beat carries emotional_hold:true, author the breath that lives in that silence — I'm sorry. [slow inhale]. Without it, post-production reads the silence and the audio gives nothing back.
   ANTI-PATTERN: tag at the start of every line by default; mid-line tag inserted at a clause boundary that the line doesn't actually turn on; emotional_hold beat with no closing breath cue.
   REFERENCES: Phoebe Waller-Bridge / Fleabag direct-address breath placement; Christopher Storer / The Bear interrupted-clause rhythm; Jane Campion / The Power of the Dog held-silence work; Hagai Levi / In Treatment session-room pauses.

3) TAG ECONOMY — when NOT to tag, and how few to use
   MOVE A — THE STOIC BASELINE IS A CHOICE: under-tagged is a directorial register, not a gap. [no_tag_intentional: stoic_baseline] is an explicit declaration that this character's read is intentionally flat, and the validator honours it. Use it for archetypes whose vocal restraint IS the character.
   MOVE B — TWO TAGS MAX, ONE PREFERRED: comma-stacked tags ([sarcastically, slowly]) work in eleven-v3 only as a pair — three or more mush into a generic "soft sad" timbre. One tag is almost always the right number.
   MOVE C — ONE AUDIO EVENT PER BEAT, MAX: [applause] / [leaves rustling] / [gentle footsteps] are diegetic-sound tokens, not prosody. Stacking them across one beat fails or produces noise. If the scene needs more environmental sound, that's beat.ambient_sound territory — not the dialogue string.
   ANTI-PATTERN: stacking 3+ tags ([whispering, sad, slowly, defeated]); using audio events as decoration on every beat; reaching for a tag when the archetype's baseline is the right read.
   REFERENCES: Tilda Swinton / Suspiria controlled non-speech; Mads Mikkelsen / Hannibal under-tagged delivery; Daniel Day-Lewis / There Will Be Blood saved-affect economy; Toni Collette / Hereditary baseline-then-rupture rhythm.

4) TAG–CRAFT COHERENCE — tag must serve the screenplay's existing intent
   MOVE A — TAG MUST NOT FIGHT THE BEAT.EMOTION: [laughing] on emotion="urgent" reads as glitch, not character. The Validator's checkTagEmotionCoherence catches the obvious cases — but coherence is craft, not just compliance. Earn the disagreement (irony) or remove it.
   MOVE B — TAG MUST NOT DUPLICATE WITHIN A LINE: [whispering] ... [whispering] is ignored or distorted by eleven-v3. If the line truly turns mid-way, use a DIFFERENT second tag — [firmly] entry, [exhaling] mid-clause.
   MOVE C — TAG INHERITS FROM OPPOSING_INTENTS, NOT JUST OWN EMOTION: speaker A leaning IN gets [softly] / [barely whispering]; speaker B leaning OUT gets [evenly] / [flatly] / [exhaling]. Same scene, opposing intents, distinct tag patterns — voices stay distinct.
   ANTI-PATTERN: tag chosen from beat.emotion alone with no reference to the scene's opposing intents; same tag on both sides of an exchange; tag whose presence the scriptwriter cannot defend in one sentence.
   REFERENCES: Jesse Armstrong / Succession lean-in vs lean-out vocal pairing; Sharon Horgan / Bad Sisters interrogations (one prosecutorial, one withholding); Park Chan-wook / The Handmaiden information-asymmetry exchanges; Tony Gilroy / Andor interrogator-vs-prisoner register split.

5) EXCHANGE-LEVEL TAG RHYTHM — varying tags across the cut
   MOVE A — VARY TAGS ACROSS A SHOT_REVERSE_SHOT, NOT WITHIN A LINE: every closeup tagged [firmly] is no rhythm — the exchange flatlines. Vary the per-closeup tag across the exchange — [firmly] / [exhaling] / [slowly] / [barely whispering] — so the cut earns its prosodic shift.
   MOVE B — INTERLOCK TAGS WITH THE PRIOR SPEAKER'S READ: when exchange_context shows the prior turn ended on [firmly], the response tag carries the receive-the-blow register ([exhaling], [slowly]). The exchange must respond, not parallel.
   MOVE C — A LONG MONOLOGUE GETS AT MOST TWO TAGS TOTAL: rapid tag-cycling within one line produces glitchy contour breaks. Use a prefix tag (entry register) plus ONE mid-line shift only when the line truly turns.
   ANTI-PATTERN: every line in an exchange tagged identically; long monologue with a tag per clause; per-line tag cycling that ignores the prior speaker's exit register.
   REFERENCES: Vince Gilligan / Better Call Saul cross-cut interrogation rhythm; Mike White / The White Lotus dinner-table interlocking voices; Hiro Murai / Atlanta call-and-response cadence; Nicole Holofcener / Enough Said back-and-forth pacing.

EMIT YOUR TAGS INLINE — they go INSIDE the dialogue string, not in a
separate field. Author them from craft (subtext + opposing_intents +
archetype + beat_intent), not from surface emotion alone. The TTS layer
parses the brackets verbatim; the Validator checks that what you authored
is coherent (not contradicting beat.emotion, not stacking 3+ tags, not
using events more than once per beat); the Doctor patches missing tags
on flagged beats. AUTHORSHIP IS YOURS — not the Doctor's, not the model's.

${hebrewMasterclassBlock}

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
    sonicSeriesBible = null,
    // V4 Phase 5b — same genre pool that the system prompt receives. Used
    // to render the schema's lut_id enum from the genre pool ONLY (no
    // legacy 8-LUT bypass). Omitted when hasBrandKitLut is true OR pool
    // is unresolvable.
    genreLutPool = null
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

  // V4 Phase 5b — the legacy hardcoded `bs_warm_cinematic | bs_cool_noir | ...`
  // enum was the smoking-gun bypass that produced bs_cool_noir for the
  // hyperreal-premium commercial in story `77d6eaaf` (logs.txt 2026-04-28).
  // The enum now derives from the genre pool ONLY, or is omitted entirely.
  const hasGenrePoolField = !hasBrandKitLut && Array.isArray(genreLutPool) && genreLutPool.length > 0;
  const lutField = hasGenrePoolField
    ? `\n  "lut_id": "${genreLutPool.map(l => l.id).join(' | ')}",`
    : '';

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

- "dialogue" (inline performance tags): the dialogue field accepts ElevenLabs
  eleven-v3 inline performance tags in square brackets. They shape the audio
  layer's prosody — the difference between an inherited default contour and
  an authored read. Author them INLINE, not in a separate field. See DIALOGUE
  MASTERCLASS → DIALOGUE PERFORMANCE TAGS for the tag taxonomy, derivation
  rules from subtext / beat_intent / opposing_intents / archetype, and the
  12 BAD→GOOD examples. Examples of correct usage:
    "[barely whispering] I had no choice."
    "[firmly] We need to leave. Now."
    "I'm fine. [exhaling]"
    "[no_tag_intentional: stoic_baseline] I'll consider it."
  At most TWO tags per line. Use audio events ([applause], [leaves rustling],
  [gentle footsteps]) sparingly — once per beat at most. Tag must NOT
  contradict beat.emotion (validator flags tag_emotion_contradiction).

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
  "dramatic_question": "<the ONE high-stakes question this episode poses that keeps the viewer watching — one sentence, ends with '?', specific to THIS character's want and THIS episode's pressure>",
  "mood": "Episode's emotional register (e.g. 'quiet tension building to release')",
  "continuity_from_previous": "How this connects to what came before",
  "continuity_check": "How this episode's opening resolves the previous cliffhanger",
  "cliffhanger": "What makes the viewer want episode ${episodeNumber + 1}",
  "emotional_state": "Where the viewer's emotional journey stands at the END of this episode",
  "visual_motif_used": "Which recurring visual motif (from season bible) appears and how",
  "visual_style_prefix": "<UNIFIED cinematography brief that runs across every beat in the episode: color temperature, lighting quality, lens feel, film stock reference; concrete enough that the Scene Master panels carry the same look>",${lutField}
  "dialogue_density_intent": "<balanced (default) | silent_register (Drive-style: dialogue is rare and weighted, scenes carry through image and sound) | dialogue_dense (Sorkin/Mamet: the room talks, lines overlap, density itself is the rhythm)>",
  "music_bed_intent": "<music brief for ElevenLabs Music — instrumentation + mood + arc through the episode; ≤ 200 chars${hasBible ? '; MUST NOT include any prohibited_instruments from the Sonic Series Bible' : ''}>",
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
      "scene_visual_anchor_prompt": "<rich still-image description for Seedream 5 Lite Scene Master panel — 80-150 words; cover location + time of day + lighting + color palette + character blocking + wardrobe + atmosphere + film stock feel; respect visual_style_prefix; concrete and specific to THIS scene's people and place — no generic atmospheres, no template phrasing>",
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
          "location": "<one-line concrete location grounded in this story's world>",
          "atmosphere": "<2-4 specific sensory anchors — texture, light quality, distance — that prime the scene's emotional temperature>",
          "camera_move": "<one camera move that earns the establishing — what the move reveals matters more than the move itself>",
          "duration_seconds": 3,
          "ambient_sound": "<diegetic sounds in this place: 2-3 specific layers, no music>",
          "requires_text_rendering": true,
          "narrative_purpose": "<one sentence: what this beat is doing for the SCENE — set tone, plant a question, hide an object, let the viewer settle>",
          "beat_intent": "setup"
        },
        {
          "beat_id": "s1b2",
          "type": "TALKING_HEAD_CLOSEUP",
          "persona_index": 0,
          "dialogue": "<INLINE-TAGGED line in this character's voice — 4-12 words, short, surface, ordinary; the meaning the character refuses to say lives one breath underneath; lead with an eleven-v3 performance tag derived from beat.emotion + subtext + opposing_intents + archetype baseline (see DIALOGUE PERFORMANCE TAGS masterclass). Example: '[exhaling] [slowly] I'm fine.' or '[firmly] We need to leave. Now.' Stoic baseline: '[no_tag_intentional: stoic_baseline] I'll consider it.'>",
          "emotion": "<one or two adjectives that name the surface posture, not the truth (e.g. composed, conversational, level)>",
          "duration_seconds": 3,
          "lens": "85mm",
          "expression_notes": "<actor direction for the micro-expression: a tell that contradicts the line, a held breath, a beat of stillness before the deflection; ≤ 12 words>",
          "subtext": "<what the character is actually doing under the words — the read of the room, the unsayable thing, the silent decision>",
          "narrative_purpose": "<one sentence: what this line accomplishes for character + scene — sets a want, raises a question, draws a line>",
          "beat_intent": "setup"
        },
        {
          "beat_id": "s1b3",
          "type": "REACTION",
          "framing": "tight_closeup",
          "persona_index": 1,
          "personas_present": [1],
          "duration_seconds": 2,
          "expression_notes": "<actor direction for the silent read: the body's answer to the prior line, smaller than the viewer expects, more honest than any response would be>",
          "narrative_purpose": "<one sentence: what the silent moment accomplishes — what the viewer learns from a face that the dialogue did not say>",
          "beat_intent": "escalate"
        },
        {
          "beat_id": "s1b4",
          "type": "TALKING_HEAD_CLOSEUP",
          "persona_index": 1,
          "dialogue": "<a 4-12 word reply in this character's voice — must INTERLOCK with the prior line, NOT echo it; vary line length from b2; if this character would refuse the question rather than answer it, refuse it>",
          "emotion": "<surface posture; should differ from b2's emotion to give Gemini distinct voice anchors>",
          "duration_seconds": 3,
          "lens": "85mm",
          "expression_notes": "<actor direction; body language that contradicts the surface line>",
          "subtext": "<what this character is really doing — buying time, deflecting, conceding ground, holding line>",
          "narrative_purpose": "<one sentence: how this reply changes the room's temperature; what it costs to say>",
          "beat_intent": "escalate",
          "pace_hint": "slow"
        },
        {
          "beat_id": "s1b5",
          "type": "TALKING_HEAD_CLOSEUP",
          "persona_index": 0,
          "dialogue": "<a 4-12 word escalation from b2 — same character, harder line; demonstrates ESCALATION_OF_ASK without raising volume>",
          "emotion": "<surface posture, escalated from b2 in pressure not in volume>",
          "duration_seconds": 4,
          "lens": "85mm",
          "expression_notes": "<actor direction: micro-shift that reads as pressure to the viewer; a tilt, a hold, a slowing>",
          "subtext": "<the move underneath: the character's awareness of what they're doing and the cost of doing it>",
          "narrative_purpose": "<one sentence: why this is the scene's peak — what gets revealed, what gets refused>",
          "beat_intent": "escalate",
          "emotional_hold": true
        },
        {
          "beat_id": "s1b6",
          "type": "INSERT_SHOT",
          "subject_focus": "<the product or hero object, framed as silent witness to the dialogue beat — what it sees, what it costs, what it survives>",
          "lighting_intent": "<one specific lighting move that makes the object read as significant, not decorative>",
          "camera_move": "<one move that connects the object to the prior dialogue beat — a rack focus, a slow push-in, a settle>",
          "duration_seconds": 3,
          "ambient_sound": "<one diegetic detail that grounds the object in the scene — a small, specific sound>",
          "requires_text_rendering": true,
          "narrative_purpose": "<one sentence: what the object adds that the dialogue could not — the brand as silent third character>",
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
