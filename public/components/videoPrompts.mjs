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

  return `You are an elite cinematographic prompt engineer — a visual storytelling director who transforms news articles into vivid, specific, cinematic video scene prompts for AI video generation models.

YOUR TASK: Read the article and caption provided, then output a SINGLE video generation prompt. This prompt is fed DIRECTLY to ${isRunway ? 'Runway Gen-4.5' : 'Google Veo 3.1'} along with the article's featured image as the starting frame. The model generates a ${duration}-second 9:16 vertical video${isRunway ? '' : ' with native audio'}.

HARD OUTPUT CONSTRAINT: Your ENTIRE response must be UNDER ${charLimit} characters. No exceptions. Every word must carry visual weight. Output ONLY the raw prompt text — no labels, no explanations, no markdown, no quotation marks.

${categoryContext}
${moodContext}

═══════════════════════════════════════════════════════════════
THE RULES OF CINEMATIC VIDEO PROMPTING
═══════════════════════════════════════════════════════════════

1. CONCRETE VISUALS — NEVER ABSTRACTIONS
   Your #1 job is to describe WHAT THE VIEWER SEES — specific people, places, objects, textures, colors, and actions.
   FORBIDDEN: "A professional business environment with dynamic lighting" — this produces nothing.
   REQUIRED: "A glass-walled trading floor at dawn, screens flickering with green numbers, a trader's hands gripping a phone as morning light cuts through skyscrapers outside" — this produces cinema.
   Be SPECIFIC. Name materials (glass, steel, wood, concrete). Name colors (amber, cobalt, crimson). Name textures (rain-slicked, sun-bleached, frost-covered). Name actions (typing, gesturing, walking, turning).

2. THE STARTING IMAGE IS A LAUNCH PAD
   The source image is often a company logo, headshot, stock photo, or news thumbnail. Your prompt MUST describe the world the camera MOVES INTO from that starting frame:
   - Logo → describe the surface it's etched/displayed on, then the camera pushes past it into the scene behind
   - Headshot → the person's environment expands around them as the camera pulls back
   - Stock photo → the scene within the photo comes alive with movement, depth, and context
   - News thumbnail → the frozen moment unfolds into a living narrative
   The key technique: START from what the image shows, then EXPAND into a full cinematic world. The first sentence should connect to the starting image. The rest describes the world that unfolds.

3. THREE-BEAT NARRATIVE ARC (even in ${duration} seconds)
   BEAT 1 — ESTABLISH (0-3s): The opening frame expands into a world. Environment, lighting, atmosphere, spatial context. Where are we? What time of day? What's the feel?
   BEAT 2 — DEVELOP (3-${parseInt(duration) - 2}s): Something HAPPENS. Movement, reveal, transformation, a shift in scale or perspective. This is the story beat — the moment that carries the article's meaning visually.
   BEAT 3 — RESOLVE (${parseInt(duration) - 2}-${duration}s): The visual culmination. A wider reveal, an emotional reaction, a shift to the bigger picture. Leave the viewer with a sense of the story's significance.

4. EXACT CAMERA MOVEMENTS
   Name specific cinematographic techniques:
   - "Smooth dolly push forward through the corridor"
   - "Camera cranes up from street level to rooftop view"
   - "Slow aerial pullback revealing the full cityscape"
   - "Tracking shot follows the subject moving left to right"
   - "Rack focus shifts from foreground document to the person behind"
   NEVER say just "the camera moves" or "camera slowly zooms in."

5. PEOPLE AND HUMAN ACTIONS
   News is about people. When the article involves humans, describe them vividly:
   - What they wear (lab coat, sharp navy suit, construction vest, scrubs)
   - Expressions and body language (furrowed brow of concentration, confident stride, hands clasped in deliberation)
   - Actions (reviewing data on a screen, signing a document, addressing a packed auditorium)
   - Their environment and how they interact with it

6. LIGHTING AND ATMOSPHERE — NON-NEGOTIABLE
   Every prompt MUST specify:
   - Time of day and light source (golden hour sun, harsh fluorescent overheads, soft dawn glow, blue-tinted moonlight)
   - Color temperature (warm amber, cool steel blue, neutral daylight)
   - Atmospheric elements (morning haze, dust motes in a sunbeam, steam rising, rain on glass, bokeh city lights)
   - These details are what separate cinematic from generic.

7. PHOTOREALISM MANDATE
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
 * Provides article data, caption context, and technical requirements.
 * @param {Object} article - { title, summary, description, source }
 * @param {string} caption - Generated TikTok caption (for story context)
 * @param {string} model - 'runway' or 'veo'
 * @param {Object} sceneMetadata - { category, mood, style, lighting, ambient, music }
 * @returns {string} The user prompt
 */
const getVideoPromptUserPrompt = (article, caption, model = 'veo', sceneMetadata = {}) => {
  const isRunway = model === 'runway';
  const charLimit = isRunway ? 950 : 1400;
  const duration = isRunway ? 10 : 8;

  // Provide scene metadata hints if available (from VideoPromptEngine classification)
  let atmosphereHints = '';
  if (sceneMetadata.lighting || sceneMetadata.ambient || sceneMetadata.music) {
    atmosphereHints = `\nATMOSPHERE HINTS (use as inspiration, not as rigid templates):`;
    if (sceneMetadata.lighting) atmosphereHints += `\n- Lighting suggestion: ${sceneMetadata.lighting}`;
    if (!isRunway && sceneMetadata.ambient) atmosphereHints += `\n- Ambient audio suggestion: ${sceneMetadata.ambient}`;
    if (!isRunway && sceneMetadata.music) atmosphereHints += `\n- Music suggestion: ${sceneMetadata.music}`;
  }

  return `ARTICLE TO TRANSFORM INTO A CINEMATIC VIDEO SCENE:

Headline: ${article.title}
Summary: ${article.summary || article.description || '(No summary available)'}
${article.description && article.description !== article.summary ? `Details: ${article.description}` : ''}
Source: ${article.source || 'Unknown'}

CAPTION (for story context — do NOT include this text in the video prompt):
${caption || '(No caption provided)'}

SOURCE IMAGE:
The starting frame is the article's featured image. It could be a company logo, a person's headshot, a product photo, a news scene, or a stock image. Your prompt must start from what this image plausibly shows and expand outward into a full cinematic scene.
${atmosphereHints}

TECHNICAL REQUIREMENTS:
- Video model: ${isRunway ? 'Runway Gen-4.5' : 'Google Veo 3.1'}
- Duration: ${duration} seconds
- Orientation: 9:16 portrait (vertical TikTok video)
- Style: Photorealistic, documentary/news quality
- MAXIMUM ${charLimit} characters (CRITICAL — exceeding this will truncate your prompt)
${!isRunway ? '- MUST include audio direction (ambient sounds + music) as a final paragraph' : '- Do NOT include any audio/music direction'}

Now write the video generation prompt. Remember: CONCRETE visuals, THREE-BEAT arc, SPECIFIC camera, REAL atmosphere. Transform this article into a scene a viewer can FEEL.`;
};

/**
 * System prompt for rephrasing a content-filtered video prompt.
 * Instructs the LLM to reason about what triggered the safety filter and produce
 * a cinematically equivalent alternative that avoids the trigger patterns.
 * @param {string} model - 'runway' or 'veo'
 * @param {number} attemptNumber - Which rephrase attempt (1 = first rephrase, 2 = escalated rephrase)
 * @returns {string} The system prompt for rephrasing
 */
const getVideoRephraseSystemPrompt = (model = 'veo', attemptNumber = 1) => {
  const isRunway = model === 'runway';
  const charLimit = isRunway ? 950 : 1400;
  const duration = isRunway ? 10 : 8;

  const escalation = attemptNumber >= 2
    ? `CRITICAL — ESCALATED REPHRASE (attempt #${attemptNumber}):
A previous rephrase of this prompt was ALSO rejected. Minor word-swaps are NOT enough.
You MUST take a COMPLETELY DIFFERENT visual approach:
- Do NOT reuse the same scene structure, setting, or visual concept from the rejected prompt
- COMPLETELY ABANDON any reference to the triggering subject matter — not even indirect or symbolic references
- Instead, focus the scene on the BUSINESS, FINANCIAL, or HUMAN STORY angle of the article:
  - Funding/investment → show investors, boardrooms, handshakes, financial displays, celebration
  - Scientific research → show the lab environment, team collaboration, whiteboards, data screens — but NEVER the research subject itself
  - Product launch → show the company campus, press event, audience reactions — but NEVER the product if it's in a sensitive category
  - Military/defense → show strategy rooms, diplomacy, logistics — NEVER combat or weapons
- Build an ENTIRELY NEW three-beat arc with different camera movements and different settings
- The scene must feel like a DIFFERENT SHORT FILM about the same news story`
    : `REPHRASE STRATEGY:
- Replace ALL triggering imagery with safe visual equivalents — do NOT keep partial references
- Shift the entire scene away from the sensitive subject toward the human/business/impact angle
- Example: article about "brain implants" → show the COMPANY (offices, team, investors, funding milestone) — NOT the technology itself
- Example: article about "weapons deal" → show DIPLOMATIC meeting, handshake, document signing — NOT weapons
- Example: article about "surgery breakthrough" → show CELEBRATION, press conference, hospital exterior — NOT the procedure
- The key principle: tell the article's STORY without depicting its SENSITIVE SUBJECT`;

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
 * Provides the rejected prompt and article context for story-relevant rephrasing.
 * @param {string} originalPrompt - The prompt that was rejected by content filters
 * @param {Object} article - { title, summary, description, source }
 * @param {string} model - 'runway' or 'veo'
 * @param {number} attemptNumber - Which rephrase attempt (1 = first, 2 = escalated)
 * @returns {string} The user prompt for rephrasing
 */
const getVideoRephraseUserPrompt = (originalPrompt, article, model = 'veo', attemptNumber = 1) => {
  const isRunway = model === 'runway';
  const charLimit = isRunway ? 950 : 1400;

  const escalationNote = attemptNumber >= 2
    ? `\n⚠️ A PREVIOUS REPHRASE WAS ALSO REJECTED. You MUST write a COMPLETELY DIFFERENT scene — different setting, different visual concept, different camera movements. Do NOT iterate on the rejected prompt — start fresh from the article headline.`
    : '';

  return `THE FOLLOWING VIDEO PROMPT WAS REJECTED BY CONTENT SAFETY FILTERS:

---
${originalPrompt}
---

ARTICLE CONTEXT (for maintaining story relevance):
Headline: ${article.title}
Summary: ${article.summary || article.description || '(No summary)'}
Source: ${article.source || 'Unknown'}
${escalationNote}

YOUR TASK:
1. Identify the likely trigger words/phrases in the rejected prompt
2. Write a NEW prompt that tells the article's story WITHOUT depicting its sensitive subject matter — focus on the business, human, or societal angle instead
3. Preserve cinematic quality: specific camera movements, lighting, textures, atmosphere
4. Keep it UNDER ${charLimit} characters

Output ONLY the new prompt. No explanations.`;
};

export {
  getVideoPromptSystemPrompt,
  getVideoPromptUserPrompt,
  getVideoRephraseSystemPrompt,
  getVideoRephraseUserPrompt
};
