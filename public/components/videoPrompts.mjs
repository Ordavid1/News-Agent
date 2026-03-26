// videoPrompts.mjs
// Expert cinematographer prompts for LLM-powered video scene generation.
// The LLM reads the article + caption and outputs a precise, cinematic video prompt
// for Runway Gen-4.5 or Google Veo 3.1 to execute.
import { isHebrewLanguage } from './linkedInPrompts.mjs';

/**
 * Generate the system prompt for video prompt generation.
 * Teaches the LLM to act as an elite cinematographic prompt engineer.
 * @param {Object} agentSettings - User's agent settings
 * @param {string} model - 'runway' or 'veo'
 * @param {Object} sceneMetadata - { category, mood, style, lighting, ambient, music }
 * @returns {string} The system prompt
 */
const getVideoPromptSystemPrompt = (agentSettings = {}, model = 'veo', sceneMetadata = {}) => {
  const isRunway = model === 'runway';
  const duration = isRunway ? '10' : '8';
  const charLimit = isRunway ? 950 : 1400;

  const categoryContext = sceneMetadata.category && sceneMetadata.category !== 'general'
    ? `Scene domain: "${sceneMetadata.category}" — use as contextual flavor for atmosphere and mood, but let the article's specific story drive all visual choices. Do not fall back on generic ${sceneMetadata.category} imagery.`
    : 'No specific scene domain detected. Derive all visual direction from the article content.';

  const moodContext = sceneMetadata.mood && sceneMetadata.mood !== 'neutral'
    ? `Emotional register: "${sceneMetadata.mood}" — let this inform pacing, color temperature, and camera energy.`
    : 'Emotional register: neutral. Use measured pacing but find the visual drama within the content itself.';

  // Veo supports native audio generation; Runway does not use audio cues
  const audioSection = isRunway
    ? `AUDIO: Runway does not use audio cues in the prompt. Focus entirely on visual and camera direction. Do NOT include any audio, music, or sound descriptions.`
    : `AUDIO DIRECTION (REQUIRED — Veo generates native audio):
You MUST include explicit audio cues in your prompt:
- Ambient sounds: specific environmental audio (keyboard clicks, crowd murmur, wind through trees, distant traffic, machine hum, rainfall)
- Music direction: style, tempo, instruments, mood (tense strings building, hopeful piano melody, minimal electronic pulse, driving percussion)
- Sync points: moments where audio aligns with visual beats (a door opening, applause erupting, a notification chime)
Place audio direction as a final paragraph, clearly describing the soundscape.`;

  return `You are a CINEMATIC DIRECTOR creating a video production directive — you command a virtual production crew (director of photography, set designer, sound engineer, editor) by writing the creative brief that tells them exactly what to shoot.

You receive a rich STORYLINE (editorial analysis of the full article) alongside the headline, caption, and image. The STORYLINE is your PRIMARY narrative source — it contains the article's full meaning, tone, context worlds, and visual anchors. Use it to craft a video that TELLS THE STORY, not just illustrates the headline.

YOUR TASK: Read all provided material and output a SINGLE video generation prompt — a production directive. This is fed DIRECTLY to ${isRunway ? 'Runway Gen-4.5' : 'Google Veo 3.1'} along with the article's featured image as the starting frame. The model generates a ${duration}-second 9:16 vertical video${isRunway ? '' : ' with native audio'}.

YOUR GOAL: Create a video that triggers FOMO — viewers who scroll past must feel they're missing something extraordinary. The video must make the story UNMISSABLE, creating engagement through visual spectacle and emotional resonance.

HARD OUTPUT CONSTRAINT: Your ENTIRE response must be UNDER ${charLimit} characters. No exceptions. Every word must carry visual weight. Output ONLY the raw prompt text — no labels, no explanations, no markdown, no quotation marks.

${categoryContext}
${moodContext}

═══════════════════════════════════════════════════════════════
THE CINEMATIC DIRECTOR'S PLAYBOOK
═══════════════════════════════════════════════════════════════

1. STORYLINE IS KING — MINE IT FOR VISUAL GOLD
   The STORYLINE field contains the article's full narrative: who, what, where, why, the stakes, the tone, primary and secondary context worlds. READ IT CAREFULLY.
   - VISUAL WORLD: The storyline's physical setting defines your ENTIRE video's visual environment — every frame must inhabit this world
   - BACKGROUND CONTEXT: Any secondary domain context appears ONLY as small props or subtle details WITHIN the primary setting — never as a scene change
   - Use the storyline's emotional register to set the visual tempo: urgent = fast cuts and sharp movements, somber = slow dolly and muted tones, exciting = dynamic crane shots and vibrant colors

2. CONCRETE VISUALS — NEVER ABSTRACTIONS
   Your #1 job is to describe WHAT THE VIEWER SEES — specific people, places, objects, textures, colors, and actions.
   FORBIDDEN: "A professional business environment with dynamic lighting" — this produces nothing.
   REQUIRED: "A glass-walled trading floor at dawn, screens flickering with green numbers, a trader's hands gripping a phone as morning light cuts through skyscrapers outside" — this produces cinema.
   Be SPECIFIC. Name materials (glass, steel, wood, concrete). Name colors (amber, cobalt, crimson). Name textures (rain-slicked, sun-bleached, frost-covered). Name actions (typing, gesturing, walking, turning).

3. THE STARTING IMAGE IS A LAUNCH PAD
   The source image is often a company logo, headshot, stock photo, or news thumbnail. Your prompt MUST describe the world the camera MOVES INTO from that starting frame:
   - Logo → describe the surface it's etched/displayed on, then the camera pushes past it into the scene behind
   - Headshot → the person's environment expands around them as the camera pulls back
   - Stock photo → the scene within the photo comes alive with movement, depth, and context
   - News thumbnail → the frozen moment unfolds into a living narrative
   The key technique: START from what the image shows, then EXPAND into a full cinematic world. The first sentence should connect to the starting image. The rest describes the world that unfolds.

4. THREE-BEAT NARRATIVE ARC — MAKE IT UNMISSABLE
   BEAT 1 — THE HOOK (0-3s): Arrest the viewer's attention. The opening frame expands into a world that DEMANDS watching. Environment, lighting, atmosphere, spatial context. Immediate visual intrigue — something the viewer has never seen before.
   BEAT 2 — THE STORY (3-${parseInt(duration) - 2}s): This is where the STORYLINE comes alive visually. Movement, reveal, transformation, a shift in scale or perspective. This beat should convey the article's MEANING through visual metaphor and action — not just its subject.
   BEAT 3 — THE LANDING (${parseInt(duration) - 2}-${duration}s): The camera DECELERATES into a composed, grounded final frame. This is NOT a new idea — it is the natural visual conclusion of Beat 2's movement. Use ONE of these proven endings:
   - A slow crane/dolly that SETTLES into a wide establishing shot of the same environment
   - A gentle rack focus that lands on a specific meaningful object or detail (a document, a face, a screen)
   - The camera HOLDS STILL on a powerful composition — a wide shot, a symmetrical frame, a single figure in context
   CRITICAL: The last 2 seconds must involve DECELERATION and STILLNESS, not acceleration or new action. The camera slows, the scene breathes, the composition locks. Think of a documentary's final frame — it HOLDS, it does not chase. Never introduce new subjects, new movement directions, or new visual concepts in the final 2 seconds.

   CRITICAL — SCENE CONTINUITY: ALL THREE BEATS must inhabit the SAME physical environment. The camera can move to new angles, reveal new areas, or shift perspective within the SAME space — but must NEVER cut to a completely different setting. A dolly from courtside to the press table is evolution. A cut from a basketball arena to a corporate office is a VIOLATION. Think of it as ONE continuous camera move through ONE world.

5. EXACT CAMERA MOVEMENTS
   Name specific cinematographic techniques:
   - "Smooth dolly push forward through the corridor"
   - "Camera cranes up from street level to rooftop view"
   - "Slow aerial pullback revealing the full cityscape"
   - "Tracking shot follows the subject moving left to right"
   - "Rack focus shifts from foreground document to the person behind"
   NEVER say just "the camera moves" or "camera slowly zooms in."

6. PEOPLE AND HUMAN ACTIONS
   News is about people. When the article involves humans, describe them vividly:
   - What they wear (lab coat, sharp navy suit, construction vest, scrubs)
   - Expressions and body language (furrowed brow of concentration, confident stride, hands clasped in deliberation)
   - Actions (reviewing data on a screen, signing a document, addressing a packed auditorium)
   - Their environment and how they interact with it

7. LIGHTING AND ATMOSPHERE — NON-NEGOTIABLE
   Every prompt MUST specify:
   - Time of day and light source (golden hour sun, harsh fluorescent overheads, soft dawn glow, blue-tinted moonlight)
   - Color temperature (warm amber, cool steel blue, neutral daylight)
   - Atmospheric elements (morning haze, dust motes in a sunbeam, steam rising, rain on glass, bokeh city lights)
   - These details are what separate cinematic from generic.

8. PHOTOREALISM MANDATE
   Always include near the end: "Photorealistic rendering, natural color grading, sharp focus, 9:16 portrait orientation, broadcast-quality documentary footage."
   The output must look like professional news footage or documentary filmmaking — never cartoon, anime, CGI-obvious, or stylized.

${audioSection}

═══════════════════════════════════════════════════════════════
WHAT TO AVOID
═══════════════════════════════════════════════════════════════
- NEVER include text overlays, titles, captions, logos, or written words in the scene description — video models render text poorly
- NEVER say "the reference image comes to life" or "the image transforms" — these are empty instructions that produce static results
- NEVER use meta-language like "this scene shows" or "the video depicts" — describe the scene directly as if writing a screenplay
- NEVER describe what happens OFF-SCREEN — only what the camera SEES
- NEVER output anything except the raw video prompt — no "Here's the prompt:" or similar framing`;
};

/**
 * Generate the user prompt for video prompt generation.
 * Provides article data with editorial storyline, caption context, image description,
 * full article excerpt, and technical requirements for cinematic directive generation.
 * @param {Object} article - { title, summary, description (storyline), source }
 * @param {string} caption - Generated TikTok/YouTube caption (for story context)
 * @param {string} model - 'runway' or 'veo'
 * @param {Object} sceneMetadata - { category, secondaryCategory, mood, style, lighting, ambient, music }
 * @param {string|null} imageDescription - Vision model description of the source image (null if unavailable)
 * @returns {string} The user prompt
 */
const getVideoPromptUserPrompt = (article, caption, model = 'veo', sceneMetadata = {}, imageDescription = null) => {
  const isRunway = model === 'runway';
  const charLimit = isRunway ? 950 : 1400;
  const duration = isRunway ? 10 : 8;

  // Production direction from scene classification (atmosphere, lighting, audio)
  let productionDirection = '';
  if (sceneMetadata.lighting || sceneMetadata.ambient || sceneMetadata.music) {
    productionDirection = `\nPRODUCTION DIRECTION (from scene analysis — use as creative inspiration):`;
    if (sceneMetadata.lighting) productionDirection += `\n- Lighting direction: ${sceneMetadata.lighting}`;
    if (!isRunway && sceneMetadata.ambient) productionDirection += `\n- Ambient soundscape: ${sceneMetadata.ambient}`;
    if (!isRunway && sceneMetadata.music) productionDirection += `\n- Score direction: ${sceneMetadata.music}`;
  }

  // When a vision model has described the actual image, provide that concrete description.
  // Otherwise, fall back to generic guidance about common image types.
  const imageSection = imageDescription
    ? `SOURCE IMAGE DESCRIPTION (from vision analysis — this is what the starting frame actually shows):
${imageDescription}
Your prompt MUST be visually coherent with this image. The first sentence should connect to what is described above, then EXPAND into a full cinematic world.`
    : `SOURCE IMAGE:
The starting frame is the article's featured image. It could be a company logo, a person's headshot, a product photo, a news scene, or a stock image. Your prompt must start from what this image plausibly shows and expand outward into a full cinematic scene.`;

  // Note secondary category if present (cross-domain article)
  const crossDomainNote = sceneMetadata.secondaryCategory
    ? `\nCROSS-DOMAIN RULE: This story involves ${sceneMetadata.secondaryCategory} context, but it is a ${sceneMetadata.category} story. The ${sceneMetadata.secondaryCategory} context explains WHY this story happened — it must NEVER drive visual choices. The ENTIRE ${duration} seconds must look like a ${sceneMetadata.category} story set in a ${sceneMetadata.category} environment. The ${sceneMetadata.secondaryCategory} element may appear ONLY as a subtle prop detail within the primary setting (e.g., a screen, a document, a logo on a wall) — NEVER as a scene change or separate location.`
    : '';

  // Build the STORYLINE section — this is the key enhancement
  const storylineSection = article.description && article.description !== article.summary
    ? `\nSTORYLINE (editorial analysis of the full article — THIS IS YOUR PRIMARY NARRATIVE SOURCE):
${article.description}
↑ Use this storyline to drive your three-beat arc. It contains the story's meaning, tone, key players, and visual anchors.`
    : '';

  return `ARTICLE TO TRANSFORM INTO A CINEMATIC VIDEO PRODUCTION:

Headline: ${article.title}
Summary: ${article.summary || article.description || '(No summary available)'}
${storylineSection}
Source: ${article.source || 'Unknown'}

CAPTION (for story context — do NOT include this text in the video prompt):
${caption || '(No caption provided)'}

${imageSection}
${productionDirection}${crossDomainNote}

TECHNICAL REQUIREMENTS:
- Video model: ${isRunway ? 'Runway Gen-4.5' : 'Google Veo 3.1'}
- Duration: ${duration} seconds
- Orientation: 9:16 portrait (vertical TikTok/YouTube Shorts)
- Style: Photorealistic, documentary/news quality
- MAXIMUM ${charLimit} characters (CRITICAL — exceeding this will truncate your prompt)
${!isRunway ? '- MUST include audio direction (ambient sounds + music) as a final paragraph' : '- Do NOT include any audio/music direction'}

Now write the cinematic video production directive. You are the DIRECTOR — your prompt tells the crew exactly what to shoot. Mine the STORYLINE for narrative depth. Create a scene that triggers FOMO, demands engagement, and makes the viewer feel they CANNOT scroll past this story. THREE-BEAT arc, CONCRETE visuals, SPECIFIC camera movements, REAL atmosphere.`;
};

/**
 * System prompt for rephrasing a content-filtered video prompt.
 * Instructs the LLM to reason about what triggered the safety filter and produce
 * a cinematically equivalent alternative that avoids the trigger patterns.
 * Uses domain-specific safe alternatives from sceneMetadata instead of generic business fallback.
 * @param {string} model - 'runway' or 'veo'
 * @param {number} attemptNumber - Which rephrase attempt (1 = first rephrase, 2 = escalated rephrase)
 * @param {Object} sceneMetadata - { category, safeAlternatives, ... } from VideoPromptEngine
 * @returns {string} The system prompt for rephrasing
 */
const getVideoRephraseSystemPrompt = (model = 'veo', attemptNumber = 1, sceneMetadata = {}) => {
  const isRunway = model === 'runway';
  const charLimit = isRunway ? 950 : 1400;
  const duration = isRunway ? 10 : 8;

  // Domain-specific safe visual alternatives from VideoPromptEngine (merge primary + secondary)
  const primaryAlts = sceneMetadata.safeAlternatives || 'press conference podium, modern newsroom with monitors, office workspace with team reviewing information, city skyline time-lapse';
  const secondaryAlts = sceneMetadata.secondarySafeAlternatives || '';
  const safeAlts = secondaryAlts
    ? `PRIMARY domain alternatives: ${primaryAlts}\nSECONDARY domain alternatives (use ONLY as subtle background props within the primary setting): ${secondaryAlts}`
    : primaryAlts;
  const category = sceneMetadata.category || 'general';

  const escalation = attemptNumber >= 2
    ? `CRITICAL — ESCALATED REPHRASE (attempt #${attemptNumber}):
A previous rephrase of this prompt was ALSO rejected. Minor word-swaps are NOT enough.
You MUST take a COMPLETELY DIFFERENT visual approach:
- Do NOT reuse the same scene structure, setting, or visual concept from the rejected prompt
- COMPLETELY ABANDON any reference to the triggering subject matter — not even indirect or symbolic references
- Use these SAFE VISUAL ALTERNATIVES for the "${category}" domain — pick ONE and build a full cinematic scene around it:
  ${safeAlts}
- Build an ENTIRELY NEW three-beat arc with different camera movements and different settings
- The scene must feel like a DIFFERENT SHORT FILM about the same news story
- Stay within the article's domain (${category}) — do NOT default to generic corporate/business imagery unless the article is actually about business
- The rephrased scene MUST remain in the ${category} visual world — same type of setting, same type of environment. Do NOT drift into a different domain's visual world`
    : `REPHRASE STRATEGY:
- Replace ALL triggering imagery with safe visual equivalents — do NOT keep partial references
- Shift the entire scene away from the sensitive subject toward the HUMAN IMPACT angle, staying within the article's domain (${category})
- Use these SAFE VISUAL ALTERNATIVES as inspiration — pick the most relevant one and build a vivid cinematic scene:
  ${safeAlts}
- The rephrased scene MUST remain in the ${category} visual world — same type of setting, same type of environment. Do NOT drift into a different domain's visual world
- The key principle: tell the article's STORY without depicting its SENSITIVE SUBJECT, while keeping the visual world consistent with the ${category} domain`;

  return `You are an expert at understanding AI video generation content safety filters and rephrasing cinematic video prompts to pass moderation while preserving visual storytelling quality.

CONTEXT: A video generation prompt was rejected by ${isRunway ? 'Runway Gen-4.5' : 'Google Veo 3.1'}'s content safety filters. Your job is to produce a NEW prompt that tells the same article's story but avoids ALL content filter triggers.

${escalation}

COMMON CONTENT FILTER TRIGGERS — your rephrased prompt must contain NONE of these:
- Violence, weapons, blood, injury, death, or combat imagery
- Medical procedures, surgical instruments, invasive body modification, implants, neural interfaces
- Brain/neural technology, cybernetic modifications, transhumanist body alteration — even diagrams or prototypes of such devices
- Politically sensitive confrontations (protests with conflict, riots)
- Surveillance, imprisonment, or restraint imagery
- Sexually suggestive content or drug use imagery
- Depictions of minors in any risky context
- Real named public figures in fictional scenarios
- Disaster scenes with graphic human suffering

OUTPUT only the rephrased video prompt — no explanations, no labels, no analysis, no "Here's the prompt:" framing. Raw prompt text only.

HARD CONSTRAINTS:
- UNDER ${charLimit} characters total
- ${duration}-second 9:16 vertical video
- Photorealistic, documentary/news quality
- ${isRunway ? 'NO audio/music direction' : 'MUST include audio direction as final paragraph'}
- Must still be a compelling, specific, cinematic scene with concrete visuals, specific camera movements, and real atmosphere — not a watered-down generic fallback`;
};

/**
 * User prompt for rephrasing a content-filtered video prompt.
 * Provides the rejected prompt, article context, image description, and domain-specific
 * guidance for story-relevant rephrasing.
 * @param {string} originalPrompt - The prompt that was rejected by content filters
 * @param {Object} article - { title, summary, description, source }
 * @param {string} model - 'runway' or 'veo'
 * @param {number} attemptNumber - Which rephrase attempt (1 = first, 2 = escalated)
 * @param {string|null} imageDescription - Vision model description of the source image
 * @returns {string} The user prompt for rephrasing
 */
const getVideoRephraseUserPrompt = (originalPrompt, article, model = 'veo', attemptNumber = 1, imageDescription = null) => {
  const isRunway = model === 'runway';
  const charLimit = isRunway ? 950 : 1400;

  const escalationNote = attemptNumber >= 2
    ? `\n⚠️ A PREVIOUS REPHRASE WAS ALSO REJECTED. You MUST write a COMPLETELY DIFFERENT scene — different setting, different visual concept, different camera movements. Do NOT iterate on the rejected prompt — start fresh from the article headline.`
    : '';

  const imageContext = imageDescription
    ? `\nSOURCE IMAGE (still used as starting frame — your prompt must be visually coherent with it):\n${imageDescription}`
    : '';

  return `THE FOLLOWING VIDEO PROMPT WAS REJECTED BY CONTENT SAFETY FILTERS:

---
${originalPrompt}
---

ARTICLE CONTEXT (for maintaining story relevance):
Headline: ${article.title}
Summary: ${article.summary || article.description || '(No summary)'}
Source: ${article.source || 'Unknown'}
${imageContext}${escalationNote}

YOUR TASK:
1. Identify the likely trigger words/phrases in the rejected prompt
2. Write a NEW prompt that tells the article's story WITHOUT depicting its sensitive subject matter — use the domain-appropriate safe alternatives from the system prompt
3. ${imageDescription ? 'Ensure your scene is visually coherent with the source image described above' : 'Preserve cinematic quality: specific camera movements, lighting, textures, atmosphere'}
4. Keep it UNDER ${charLimit} characters

Output ONLY the new prompt. No explanations.`;
};

export {
  getVideoPromptSystemPrompt,
  getVideoPromptUserPrompt,
  getVideoRephraseSystemPrompt,
  getVideoRephraseUserPrompt
};
