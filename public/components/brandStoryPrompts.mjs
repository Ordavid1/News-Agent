// brandStoryPrompts.mjs
// Prompts for Brand Story video series — storyline generation, episode scene creation,
// and storyboard visual direction. Used by BrandStoryService with Gemini 3 Flash.

import { isHebrewLanguage, getLanguageInstruction } from './linkedInPrompts.mjs';

// ============================================================
// STORYLINE GENERATION (full season arc from Brand Kit)
// ============================================================

/**
 * System prompt for generating a complete story arc / "season bible" from brand identity.
 * The LLM creates a narrative framework that drives an ongoing video series.
 *
 * @param {Object} brandKit - Brand Kit data (color_palette, style_characteristics, brand_summary, people, logos)
 * @returns {string} System prompt
 */
export function getStorylineSystemPrompt(brandKit = {}) {
  const brandContextBlock = _buildBrandKitContextBlock(brandKit);

  return `You are an award-winning screenwriter and brand storyteller who creates compelling short-form video series for social media (Reels, Stories, TikTok). You specialize in serialized brand narratives that hook viewers episode after episode.

YOUR TASK: Create a complete STORY BIBLE — a serialized narrative framework that will drive a continuing video series for a brand. Each "episode" is a 10-15 second short-form video that tells one scene of a larger story.

STORYTELLING PRINCIPLES:
- Every great story has CONFLICT, STAKES, and TRANSFORMATION
- The story must subtly showcase the brand's product/subject without being a sales pitch
- Each episode must end with a micro-cliffhanger or revelation that makes viewers want the next one
- Characters must feel real — they have desires, flaws, and growth
- The product/subject is woven into the narrative as a natural element, never forced
- Visual storytelling: show, don't tell. Each scene must be visually distinct and cinematic
${brandContextBlock}
You MUST respond with ONLY valid JSON (no markdown code fences, no extra text). The JSON must conform to the schema described in the user prompt.`;
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
    episodeCount = 12,
    storyFocus = 'product'
  } = options;

  const focusBlock = _buildFocusBlock(storyFocus);

  // Normalize: accept either a single persona object (legacy) or an array
  const personaArray = Array.isArray(personas)
    ? personas
    : (personas ? [personas] : []);

  const personaBlock = personaArray.length > 0
    ? `CHARACTER${personaArray.length > 1 ? 'S' : ''}/PERSONA${personaArray.length > 1 ? 'S' : ''} (${personaArray.length} total${personaArray.length > 1 ? ', Persona 1 is the PRIMARY/narrator' : ''}):
${personaArray.map((p, i) => `
[Persona ${i + 1}${i === 0 && personaArray.length > 1 ? ' — PRIMARY NARRATOR' : ''}]
- Description: ${p.description || 'A compelling character'}
- Appearance: ${p.appearance || p.visual_description || 'To be determined by the story'}
- Voice/Personality: ${p.personality || p.voice_style || 'Charismatic and relatable'}`).join('\n')}

Weave ALL ${personaArray.length} persona${personaArray.length > 1 ? 's' : ''} into the narrative. The primary narrator drives the story; additional personas serve as supporting characters, foils, love interests, mentors, or adversaries.
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

  return `Create a complete story bible for a ${episodeCount}-episode short-form video series.

${focusBlock}

${personaBlock}
${subjectBlock}
${brandPeople}

SERIES PARAMETERS:
- Tone: ${tone}
- Genre: ${genre}
- Target audience: ${targetAudience}
- Episodes: ${episodeCount} (each 10-15 seconds of video)
- Platform: Short-form vertical video (TikTok/Reels/YouTube Shorts)

OUTPUT JSON SCHEMA:
{
  "title": "Series title — catchy, memorable, brandable",
  "theme": "Central theme in one sentence",
  "genre": "${genre}",
  "tone": "${tone}",
  "target_audience": "${targetAudience}",
  "logline": "One-sentence pitch that captures the entire series",
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
      "relationship_to_product": "How they connect to the brand subject"
    }
  ],
  "episodes": [
    {
      "episode_number": 1,
      "title": "Episode title",
      "hook": "Opening 2-3 seconds — what grabs the viewer",
      "narrative_beat": "What story beat this episode covers",
      "visual_direction": "Key visual elements, setting, lighting mood",
      "dialogue_script": "What the narrator/character says (10-15 seconds of speech)",
      "cliffhanger": "What makes the viewer want the next episode",
      "mood": "Emotional tone of this specific episode"
    }
  ],
  "season_bible": "Comprehensive narrative context document (500+ words) that captures EVERYTHING a writer would need to continue this story: world rules, character relationships, running themes, visual motifs, tone guidelines, product integration approach, and unresolved threads"
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
  const { subject = null, storyFocus = 'product', brandKit = null } = options;
  const prevBlock = _buildPreviousEpisodesBlock(storyline, previousEpisodes);
  const brandContextBlock = brandKit ? _buildBrandKitContextBlock(brandKit) : '';

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

SEASON BIBLE:
${storyline.season_bible || JSON.stringify(storyline.arc || {}, null, 2)}
${brandContextBlock}

CHARACTERS:
${(storyline.characters || []).map(c =>
  `- ${c.name} (${c.role}): ${c.personality}. Visual: ${c.visual_description}`
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
function _buildPreviousEpisodesBlock(storyline, previousEpisodes) {
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
  return `PREVIOUSLY ON "${storyline.title || 'the series'}":\n${earlierBlock}${lastDetail}`;
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
function _buildCinematicFocusBlock(storyFocus) {
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
  const { subject = null, storyFocus = 'product', brandKit = null } = options;
  const prevBlock = _buildPreviousEpisodesBlock(storyline, previousEpisodes);
  const brandContextBlock = brandKit ? _buildBrandKitContextBlock(brandKit) : '';
  const focusBlock = _buildCinematicFocusBlock(storyFocus);

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

SERIES CONTEXT:
- Logline: ${storyline.logline || storyline.theme || ''}
- Tone: ${storyline.tone || 'engaging'}
- Genre: ${storyline.genre || 'drama'}
- Total planned episodes: ${storyline.episodes?.length || 12}

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
4. Each episode = exactly 3 shots, total 10-15 seconds.
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

Total duration: 10-15 seconds (Kling multi-shot constraint). Each shot 3-5 seconds.

OUTPUT JSON SCHEMA:
{
  "title": "Episode title — intriguing and specific",
  "hook": "What happens in the first 2-3 seconds to grab attention",
  "narrative_beat": "The story beat this episode covers (one sentence)",
  "dialogue_script": "The full voice-over narration for the ENTIRE episode (10-15 seconds of speech). This narration plays over all 3 cinematic shots as a continuous voice-over track.",
  "mood": "The episode's emotional register",
  "continuity_from_previous": "How this connects to what came before",
  "continuity_check": "How this episode's hook resolves the previous cliffhanger",
  "cliffhanger": "What makes the viewer want episode ${episodeNumber + 1}",
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
- Each shot 3-5 seconds (total 10-15s for Kling multi-shot compatibility)
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

