// services/v4/director-rubrics/commercialReferenceLibrary.mjs
// V4 Phase 6 — exemplar library of Cannes Lion / Super Bowl / D&AD-caliber
// commercials. Used as few-shot grounding for CreativeBriefDirector so its
// brief lives in the world of GREAT commercial work, not generic ad copy.
//
// Each entry is a self-contained reference card the director can quote in
// the brief's `reference_commercials` field.

export const COMMERCIAL_STYLE_CATEGORIES = Object.freeze([
  'hyperreal_premium',     // Apple "Shot on iPhone", Sony Bravia "Balls"
  'verite_intimate',       // Nike "Dream Crazy", Dove "Real Beauty Sketches"
  'anthemic_epic',         // Guinness "Surfer", Apple "1984"
  'surreal_dreamlike',     // Honda "Cog", Cadbury "Gorilla"
  'vaporwave_nostalgic',   // Old Spice rebrand-era, Squarespace 80s spots
  'brutalist_minimalist',  // Nike "Just Do It" anniversaries, IKEA "Lamp"
  'hand_doodle_animated',  // Spotify Wrapped, Mailchimp Freddie spots
  'gritty_real',           // Patagonia "Don't Buy This Jacket", Burberry skate film
  'painterly_prestige',    // Chanel No. 5 (Scorsese), Dior J'adore
  'kinetic_montage'        // Beats by Dre "Hear What You Want", Adidas "Impossible Is Nothing"
]);

export const COMMERCIAL_REFERENCE_LIBRARY = Object.freeze([
  {
    title: 'Apple "1984"',
    director: 'Ridley Scott',
    year: 1984,
    style_category: 'anthemic_epic',
    visual_grammar: "Dystopian B&W with a single splash of color (red shorts, blue-white hammer); long-lens wides; allegorical staging.",
    narrative_grammar: "Single allegorical action; no dialogue; voice-over cliffhanger as tagline.",
    why_great: "The product is never shown. The IDEA of the product (rebellion against conformity) is the entire spot."
  },
  {
    title: 'Honda "Cog"',
    director: 'Antoine Bardou-Jacquet',
    year: 2003,
    style_category: 'surreal_dreamlike',
    visual_grammar: "Single uncut take; hyperreal staging; no music until the end; analog mechanical chain reaction.",
    narrative_grammar: "Mechanical chain reaction as a physical metaphor for engineering. Tagline lands in silence then music.",
    why_great: "Two minutes of cause-and-effect with zero narration. Engineering communicated as poetry."
  },
  {
    title: 'Guinness "Surfer"',
    director: 'Jonathan Glazer',
    year: 1999,
    style_category: 'anthemic_epic',
    visual_grammar: "Anamorphic black-and-white; slow-motion horse-as-wave; monumental.",
    narrative_grammar: "Voiceover thesis ('Tick. Tock.') over visual collage. Patience as theme.",
    why_great: "Visual = patience. Narration = patience. Product = patience (the long pour). Three echoes of one idea."
  },
  {
    title: 'Cadbury "Gorilla"',
    director: 'Juan Cabral',
    year: 2007,
    style_category: 'surreal_dreamlike',
    visual_grammar: "Static anamorphic medium-wide; gorilla suit; Phil Collins drum solo build.",
    narrative_grammar: "Pure visual joke. Brand stamp ONLY at end. No product shown until the wrapper.",
    why_great: "The audacity of a 90-second wait for a single drum hit + brand reveal. Trust in tone over telling."
  },
  {
    title: 'Nike "Dream Crazy" (Kaepernick)',
    director: 'Park Pictures',
    year: 2018,
    style_category: 'verite_intimate',
    visual_grammar: "16mm grain; vérité interviews; archival montage cut to a single voice.",
    narrative_grammar: "Voiceover thesis over visual collage of athletes. Tagline lands on the eyes.",
    why_great: "Risk = differentiation. Product never demonstrated; brand position made unmissable."
  },
  {
    title: 'Old Spice "The Man Your Man Could Smell Like"',
    director: 'Tom Kuntz',
    year: 2010,
    style_category: 'surreal_dreamlike',
    visual_grammar: "Single-take through impossible spaces; hyperreal staging; physical magic tricks.",
    narrative_grammar: "Direct-address monologue with reality breaking around the speaker.",
    why_great: "The transitions ARE the joke. Camera as the magic. Resurrected a dead brand in 30 seconds."
  },
  {
    title: 'Apple "Shot on iPhone" (series)',
    director: 'various',
    year: 2015,
    style_category: 'hyperreal_premium',
    visual_grammar: "Hyperreal photography as story; painterly composition; real photographers credited.",
    narrative_grammar: "Credit IS the story. Each spot ends 'Shot on iPhone by [photographer name]'.",
    why_great: "Product capability proved by living example, not described."
  },
  {
    title: 'Spotify Wrapped (2020)',
    director: 'in-house',
    year: 2020,
    style_category: 'kinetic_montage',
    visual_grammar: "Kinetic typography; brand-color saturation; vertical native; mixed-media.",
    narrative_grammar: "Personal data as social currency; viewer becomes the storyteller.",
    why_great: "Made every user the protagonist of the campaign. Product = mirror."
  },
  {
    title: 'Patagonia "Don\'t Buy This Jacket"',
    director: 'in-house print',
    year: 2011,
    style_category: 'gritty_real',
    visual_grammar: "Reference for tone — counter-positioning print ad; restrained.",
    narrative_grammar: "Anti-pitch as pitch. Brand integrity as differentiator.",
    why_great: "Saying what no competitor would dare. Built brand by attacking own commerce."
  },
  {
    title: 'Beats by Dre "Hear What You Want"',
    director: 'various',
    year: 2014,
    style_category: 'kinetic_montage',
    visual_grammar: "Speed-ramp heavy; music-led cut; hero athletes isolated by long lens.",
    narrative_grammar: "No dialogue; music + hero + product become one thought.",
    why_great: "Product as the bridge between athlete focus and the world they shut out. Show, don't say."
  },
  {
    title: 'Sony Bravia "Balls"',
    director: 'Nicolai Fuglsig',
    year: 2005,
    style_category: 'hyperreal_premium',
    visual_grammar: "250,000 colored superballs cascading down San Francisco hills; high-speed photography; sun-soaked.",
    narrative_grammar: 'Wordless visual symphony to José González\u2019s "Heartbeats". Product appears at the end.',
    why_great: "Color told the story. Spec sheet ('Like no other') was earned by the visual."
  },
  {
    title: 'Dove "Real Beauty Sketches"',
    director: 'John X. Carey',
    year: 2013,
    style_category: 'verite_intimate',
    visual_grammar: "Documentary; hidden camera; FBI sketch artist; vérité interviews.",
    narrative_grammar: "Real women, real comparisons, real reveal. Tear-jerk inevitable.",
    why_great: "Brand thesis ('You are more beautiful than you think') proven via documentary device, not stated."
  }
]);

export function getReferencesByStyleCategory(category) {
  if (!category) return [];
  const key = String(category).toLowerCase().trim();
  return COMMERCIAL_REFERENCE_LIBRARY.filter(r => r.style_category === key);
}

/**
 * Build a Gemini few-shot snippet from N references. Used by CreativeBriefDirector
 * to ground the brief in real prestige commercial work.
 */
export function formatReferenceLibraryForPrompt({ limit = 6 } = {}) {
  const sample = COMMERCIAL_REFERENCE_LIBRARY.slice(0, limit);
  return sample.map(r =>
    `  • "${r.title}" (${r.director}, ${r.year}) — style:${r.style_category}\n` +
    `       Visual:    ${r.visual_grammar}\n` +
    `       Narrative: ${r.narrative_grammar}\n` +
    `       Why great: ${r.why_great}`
  ).join('\n');
}
