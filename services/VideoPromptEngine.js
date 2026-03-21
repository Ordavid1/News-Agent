// services/VideoPromptEngine.js
// Scene classification and mood extraction for video prompt generation.
// Provides structured metadata (category, mood, lighting, ambient, music)
// that enriches the LLM-generated video prompts in videoPrompts.mjs.

import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[VideoPromptEngine] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

// News scene categories with associated visual direction, audio direction, and safe rephrase alternatives.
// Each category includes both English and Hebrew (עברית) keywords for bilingual matching.
// safeAlternatives: content-filter-safe visual scenes for rephrase fallback — used when
// the original video prompt is blocked and must be rebuilt in a domain-appropriate way.
const SCENE_CATEGORIES = {
  politics: {
    keywords: [
      'election', 'president', 'congress', 'senate', 'parliament', 'government', 'law', 'policy', 'vote', 'legislation', 'diplomat', 'treaty', 'political', 'minister', 'chancellor', 'governor', 'mayor', 'democratic', 'republican', 'coalition', 'opposition', 'white house', 'supreme court', 'executive order', 'campaign', 'bipartisan', 'constitutional', 'ballot', 'swing state', 'impeach', 'veto', 'caucus', 'referendum',
      'בחירות', 'נשיא', 'כנסת', 'ממשלה', 'חוק', 'מדיניות', 'הצבעה', 'חקיקה', 'דיפלומט', 'שר', 'ראש ממשלה', 'קואליציה', 'אופוזיציה', 'מפלגה', 'שלטון', 'פוליטי', 'פרלמנט'
    ],
    lighting: 'natural institutional lighting with warm undertones',
    ambient: 'subtle murmur of formal proceedings, muted ambient noise',
    music: 'understated orchestral undertone, measured and authoritative',
    style: 'formal news documentary, steady and composed',
    safeAlternatives: 'press briefing podium with microphones, legislative chamber with empty seats and polished wood, diplomatic handshake in a formal hall with national flags, government building exterior at golden hour, press corps cameras and notebooks in a briefing room'
  },
  technology: {
    keywords: [
      'ai', 'artificial intelligence', 'software', 'startup', 'app', 'robot', 'digital', 'cyber', 'data', 'algorithm', 'chip', 'semiconductor', 'cloud', 'quantum', 'blockchain', 'tech', 'innovation', 'silicon valley', 'computing', 'neural', 'machine learning', 'automation', 'chatbot', 'gpu', 'saas', 'open source', 'generative', 'llm', 'deepfake', 'metaverse', 'cryptocurrency',
      'בינה מלאכותית', 'תוכנה', 'סטארטאפ', 'אפליקציה', 'רובוט', 'דיגיטל', 'סייבר', 'מידע', 'אלגוריתם', 'שבב', 'ענן', 'בלוקצ\'יין', 'טכנולוגיה', 'חדשנות', 'מחשוב', 'הייטק'
    ],
    lighting: 'clean modern lighting with cool blue and white tones',
    ambient: 'soft electronic hum, quiet digital ambiance',
    music: 'minimal electronic pulse, forward-looking and clean',
    style: 'sleek tech documentary, crisp and modern',
    safeAlternatives: 'conference keynote stage with glowing presentation screens, innovation lab with engineers collaborating at whiteboards, product showcase table with sleek devices under spotlight, tech campus atrium with glass walls and green courtyard, data dashboard wall with flowing analytics visualizations'
  },
  business: {
    keywords: [
      'market', 'stock', 'economy', 'trade', 'ceo', 'company', 'revenue', 'profit', 'merger', 'acquisition', 'ipo', 'investment', 'bank', 'finance', 'gdp', 'inflation', 'corporate', 'earnings', 'wall street', 'nasdaq', 'dow', 'layoff', 'recession', 'bankruptcy', 'shareholder', 'quarterly', 'valuation', 'dividend', 'tariff', 'subsidy',
      'שוק', 'מניה', 'כלכלה', 'סחר', 'מנכ"ל', 'חברה', 'הכנסות', 'רווח', 'מיזוג', 'רכישה', 'השקעה', 'בנק', 'פיננסי', 'אינפלציה', 'בורסה', 'תאגיד', 'עסקים'
    ],
    lighting: 'professional warm lighting, clean and polished',
    ambient: 'distant city hum, professional environment sounds',
    music: 'confident piano and strings, steady momentum',
    style: 'corporate news broadcast, polished and professional',
    safeAlternatives: 'trading floor with glowing green screens at dawn, boardroom with executives reviewing charts, stock exchange exterior with digital ticker, financial district skyline at sunset, press conference with CEO at podium'
  },
  science: {
    keywords: [
      'research', 'study', 'scientist', 'discovery', 'space', 'nasa', 'climate', 'environment', 'biology', 'physics', 'chemistry', 'medical', 'experiment', 'journal', 'peer-reviewed', 'telescope', 'genome', 'evolution', 'species', 'laboratory', 'astronomy', 'dna', 'molecule', 'mars', 'satellite', 'fossil', 'clinical trial', 'hypothesis', 'observatory',
      'מחקר', 'מדען', 'גילוי', 'חלל', 'אקלים', 'סביבה', 'ביולוגיה', 'פיזיקה', 'כימיה', 'ניסוי', 'מעבדה', 'טלסקופ', 'גנום', 'מדע', 'אוניברסיטה'
    ],
    lighting: 'soft natural or laboratory lighting with precise highlights',
    ambient: 'quiet research environment, gentle instrument sounds',
    music: 'ethereal ambient tones, sense of wonder and curiosity',
    style: 'nature documentary meets science broadcast, contemplative',
    safeAlternatives: 'research team celebrating around data screens, university lecture hall with illuminated presentation, observatory dome opening to starry sky, laboratory corridor with glowing equipment behind glass, scientific conference poster session with researchers networking'
  },
  health: {
    keywords: [
      'health', 'disease', 'virus', 'hospital', 'doctor', 'patient', 'treatment', 'vaccine', 'drug', 'fda', 'clinical', 'symptom', 'pandemic', 'epidemic', 'mental health', 'therapy', 'surgery', 'pharmaceutical', 'wellness', 'diagnosis', 'cdc', 'nurse', 'outbreak', 'prescription', 'medicaid', 'medicare', 'oncology', 'cardiology',
      'בריאות', 'מחלה', 'וירוס', 'בית חולים', 'רופא', 'מטופל', 'טיפול', 'חיסון', 'תרופה', 'קליני', 'מגפה', 'בריאות הנפש', 'ניתוח', 'אבחון', 'רפואה'
    ],
    lighting: 'soft warm lighting with clinical precision where needed',
    ambient: 'calm clinical environment, quiet and measured',
    music: 'gentle piano with hopeful undertone, compassionate',
    style: 'medical documentary, caring and informative',
    safeAlternatives: 'hospital exterior with warm morning light, medical research team reviewing results on screens, community wellness center with people exercising, pharmaceutical lab with clean vials under spotlight, public health press conference with officials at podium'
  },
  sports: {
    keywords: [
      'game', 'match', 'team', 'player', 'coach', 'season', 'championship', 'tournament', 'score', 'goal', 'victory', 'defeat', 'athlete', 'olympic', 'league', 'nba', 'nfl', 'mlb', 'nhl', 'mls', 'fifa', 'tennis', 'soccer', 'football', 'baseball', 'basketball', 'hockey', 'boxing', 'ufc', 'rugby', 'cricket', 'golf', 'swimming', 'track', 'marathon', 'draft', 'roster', 'playoff', 'super bowl', 'world cup', 'stadium', 'arena', 'sack', 'touchdown', 'home run', 'slam dunk', 'ncaa', 'bracket', 'espn', 'march madness', 'final four', 'halftime', 'overtime', 'referee', 'mvp', 'seed', 'qualifier', 'varsity', 'collegiate', 'all-star', 'transfer portal', 'free agent', 'wild card',
      'משחק', 'קבוצה', 'שחקן', 'מאמן', 'עונה', 'אליפות', 'טורניר', 'ניצחון', 'תבוסה', 'ספורטאי', 'אולימפי', 'ליגה', 'כדורגל', 'כדורסל', 'גביע', 'אצטדיון', 'אימון', 'שער', 'נבחרת'
    ],
    lighting: 'vibrant stadium or arena lighting, high contrast',
    ambient: 'distant crowd roar, rhythmic energy',
    music: 'driving percussion with rising intensity, adrenaline',
    style: 'sports broadcast highlight, energetic and dynamic',
    safeAlternatives: 'press conference podium with team logos and microphones, locker room post-game interview with warm overhead lighting, stadium exterior at golden hour with fans arriving, sports broadcast desk with multiple analysis screens, trophy ceremony stage with confetti and celebration'
  },
  entertainment: {
    keywords: [
      'movie', 'film', 'music', 'celebrity', 'actor', 'singer', 'album', 'concert', 'award', 'oscar', 'grammy', 'netflix', 'streaming', 'show', 'series', 'premiere', 'box office', 'hollywood', 'broadway', 'festival', 'emmy', 'tony', 'disney', 'hbo', 'viral', 'influencer', 'trailer', 'soundtrack', 'blockbuster', 'director',
      'סרט', 'סלבריטי', 'שחקן', 'זמר', 'אלבום', 'קונצרט', 'פרס', 'אוסקר', 'נטפליקס', 'סדרה', 'הוליווד', 'פסטיבל', 'בידור', 'הופעה'
    ],
    lighting: 'dramatic cinematic lighting with rich colors',
    ambient: 'soft ambient crowd or event atmosphere',
    music: 'stylish contemporary beat, engaging and polished',
    style: 'entertainment news magazine, vibrant and cinematic',
    safeAlternatives: 'red carpet entrance with velvet ropes and camera flashes, backstage preparation area with vanity mirrors and costumes, concert venue exterior with marquee lights at dusk, film premiere audience reacting with applause, awards ceremony stage with golden statuette under spotlight'
  },
  conflict: {
    keywords: [
      'war', 'attack', 'military', 'troops', 'bomb', 'missile', 'conflict', 'terror', 'crisis', 'emergency', 'refugee', 'protest', 'riot', 'violence', 'ceasefire', 'sanctions', 'nato', 'defense', 'invasion', 'occupation', 'hostage', 'airstrike', 'drone strike', 'peacekeeping', 'insurgent', 'coup', 'shelling', 'casualties',
      'מלחמה', 'התקפה', 'צבא', 'פצצה', 'טיל', 'סכסוך', 'טרור', 'משבר', 'חירום', 'פליט', 'מחאה', 'הפגנה', 'אלימות', 'הפסקת אש', 'סנקציות', 'הגנה', 'פלישה', 'כיבוש'
    ],
    lighting: 'muted natural lighting with atmospheric haze',
    ambient: 'distant ambient tension, wind and environmental sounds',
    music: 'somber low strings, restrained and heavy',
    style: 'war correspondence documentary, sobering and respectful',
    safeAlternatives: 'diplomatic meeting room with flags and long polished table, press briefing podium with international organization logos, candlelight memorial vigil in a public square at dusk, humanitarian aid distribution center with supplies and volunteers, UN-style assembly hall with rows of delegation seats'
  },
  weather: {
    keywords: [
      'weather', 'storm', 'hurricane', 'tornado', 'flood', 'drought', 'earthquake', 'wildfire', 'temperature', 'climate change', 'snow', 'rain', 'wind', 'forecast', 'natural disaster', 'heatwave', 'blizzard', 'tsunami', 'monsoon', 'frost', 'cyclone', 'mudslide', 'evacuation', 'power outage', 'thunderstorm',
      'מזג אוויר', 'סופה', 'הוריקן', 'שיטפון', 'בצורת', 'רעידת אדמה', 'שריפה', 'טמפרטורה', 'שלג', 'גשם', 'רוח', 'תחזית', 'אסון טבע', 'גל חום'
    ],
    lighting: 'dramatic natural lighting matching weather conditions',
    ambient: 'wind, rain, or environmental weather sounds',
    music: 'atmospheric swells building with nature, powerful and immersive',
    style: 'nature documentary, awe-inspiring and immersive',
    safeAlternatives: 'weather broadcast studio with radar map on screens, emergency coordination center with maps and radios, community shelter with volunteers distributing supplies, aerial view of landscape recovering after storm, meteorologist at outdoor station with instruments and sky backdrop'
  },
  real_estate: {
    keywords: [
      'real estate', 'property', 'mortgage', 'housing', 'apartment', 'condo', 'rental', 'tenant', 'landlord', 'construction', 'developer', 'zoning', 'residential', 'commercial property', 'home prices', 'home sales', 'foreclosure', 'realty', 'listing', 'square feet', 'renovation', 'building permit', 'homeowner', 'interest rate', 'down payment', 'escrow', 'appraisal', 'closing cost', 'refinance',
      'נדל"ן', 'דירה', 'משכנתא', 'בנייה', 'קבלן', 'פינוי בינוי', 'תמ"א', 'שכירות', 'מכירה', 'נכס', 'קרקע', 'דיור', 'מגדל', 'שיכון', 'מחיר דירה', 'יזם', 'התחדשות עירונית', 'רכישה', 'מתווך', 'טאבו'
    ],
    lighting: 'warm inviting natural lighting, golden tones on structures',
    ambient: 'urban environment sounds, construction activity in distance',
    music: 'optimistic contemporary piano with subtle momentum, aspirational',
    style: 'architectural showcase documentary, inviting and aspirational',
    safeAlternatives: 'modern building exterior with glass facade reflecting sunset, open house walkthrough with sunlit rooms and fresh flowers, construction site aerial view with cranes against blue sky, real estate office with property listings on screens, neighborhood streetscape with tree-lined sidewalks and new homes'
  },
  human_interest: {
    keywords: [
      'community', 'family', 'child', 'education', 'school', 'charity', 'volunteer', 'rescue', 'hero', 'inspire', 'overcome', 'personal', 'story', 'journey', 'milestone', 'achievement', 'tradition', 'culture', 'fundraiser', 'nonprofit', 'reunion', 'survivor', 'scholarship', 'graduation', 'mentor', 'adoption',
      'קהילה', 'משפחה', 'ילד', 'חינוך', 'בית ספר', 'צדקה', 'מתנדב', 'הצלה', 'גיבור', 'השראה', 'הישג', 'מסורת', 'תרבות'
    ],
    lighting: 'warm golden hour lighting, natural and inviting',
    ambient: 'soft everyday life sounds, gentle and familiar',
    music: 'warm acoustic or piano melody, heartfelt and uplifting',
    style: 'human interest documentary, intimate and hopeful',
    safeAlternatives: 'community gathering in a sunlit park with families and picnic tables, graduation ceremony with caps thrown in the air, volunteer team distributing meals at a community center, school classroom with students engaged and hands raised, cultural festival with colorful decorations and smiling crowds'
  },
  general: {
    keywords: [], // Never matched by keywords — used as the universal fallback
    lighting: 'balanced natural lighting, clean and professional',
    ambient: 'subtle ambient environmental sounds, unobtrusive',
    music: 'neutral contemporary underscore, professional and adaptable',
    style: 'professional news broadcast, clean and versatile',
    safeAlternatives: 'modern newsroom with anchor desks and glowing monitors, press conference podium with multiple microphones, city skyline time-lapse from day to night, office workspace with team reviewing information on screens, public library reading room with warm ambient lighting'
  }
};

// Mood mappings based on sentiment words (English + Hebrew)
const MOOD_INDICATORS = {
  urgent: [
    'breaking', 'emergency', 'crisis', 'urgent', 'alert', 'warning', 'critical', 'immediately', 'escalation', 'threat',
    'דחוף', 'חירום', 'משבר', 'אזהרה', 'קריטי', 'מיידי', 'הסלמה', 'איום', 'מבזק'
  ],
  hopeful: [
    'breakthrough', 'solution', 'progress', 'improve', 'advance', 'hope', 'promising', 'recovery', 'success', 'milestone', 'achievement',
    'פריצת דרך', 'פתרון', 'התקדמות', 'שיפור', 'תקווה', 'מבטיח', 'התאוששות', 'הצלחה', 'הישג'
  ],
  somber: [
    'death', 'tragedy', 'loss', 'victim', 'mourning', 'fatal', 'devastating', 'collapse', 'failure', 'declined',
    'מוות', 'טרגדיה', 'אובדן', 'קורבן', 'אבל', 'קטלני', 'הרסני', 'קריסה', 'כישלון'
  ],
  exciting: [
    'launch', 'reveal', 'first-ever', 'record', 'historic', 'unprecedented', 'revolutionary', 'amazing', 'incredible', 'surpass',
    'השקה', 'חשיפה', 'ראשון', 'שיא', 'היסטורי', 'חסר תקדים', 'מהפכני', 'מדהים'
  ],
  neutral: [
    'report', 'announced', 'update', 'released', 'according', 'stated', 'confirmed', 'expected', 'continues',
    'דיווח', 'הודיע', 'עדכון', 'פורסם', 'לפי', 'אישר', 'צפוי', 'ממשיך'
  ]
};

class VideoPromptEngine {
  /**
   * Extract scene metadata from article content for use as LLM context.
   * Uses title-weighted keyword classification to provide category, mood,
   * atmospheric hints, and safe rephrase alternatives.
   *
   * Title keywords are weighted 3x higher than body keywords so the article's
   * primary subject (often named in the headline) outweighs incidental topics
   * mentioned in the body. This prevents cross-domain misclassification
   * (e.g., a sports article mentioning "war" being classified as conflict).
   *
   * @param {Object} params
   * @param {Object} params.article - { title, summary, description }
   * @returns {Object} { category, secondaryCategory, mood, style, lighting, ambient, music, safeAlternatives }
   */
  static getSceneMetadata({ article }) {
    const titleText = (article.title || '').toLowerCase();
    const bodyText = `${article.summary || ''} ${article.description || ''}`.toLowerCase();
    const fullText = `${titleText} ${bodyText}`;

    const { primary, secondary } = this.classifyScene(titleText, bodyText);
    const mood = this.extractMood(fullText);
    const sceneConfig = SCENE_CATEGORIES[primary];

    const secondaryLabel = secondary && secondary !== primary ? secondary : null;
    logger.info(`Scene metadata: category=${primary}${secondaryLabel ? ` (secondary: ${secondaryLabel})` : ''}, mood=${mood}`);

    const secondaryConfig = secondaryLabel ? SCENE_CATEGORIES[secondaryLabel] : null;

    return {
      category: primary,
      secondaryCategory: secondaryLabel,
      mood,
      style: sceneConfig.style,
      lighting: sceneConfig.lighting,
      ambient: sceneConfig.ambient,
      music: sceneConfig.music,
      safeAlternatives: sceneConfig.safeAlternatives,
      secondarySafeAlternatives: secondaryConfig ? secondaryConfig.safeAlternatives : null
    };
  }

  /**
   * Classify the article into primary (and optionally secondary) scene categories.
   *
   * Title-weighted scoring: keyword matches in the title count 3 points,
   * body matches count 1 point. This ensures the headline's subject dominates
   * when the article spans multiple domains.
   *
   * Returns { primary, secondary } where secondary is the runner-up category
   * (or null if only one category meets the threshold).
   */
  static classifyScene(titleText, bodyText) {
    const TITLE_WEIGHT = 3;
    const BODY_WEIGHT = 1;
    const MIN_WEIGHTED_SCORE = 2; // Minimum weighted score to assign a category

    const scores = [];

    for (const [category, config] of Object.entries(SCENE_CATEGORIES)) {
      if (category === 'general') continue;

      let score = 0;
      let titleMatches = 0; // Count of distinct keywords found in the title

      for (const keyword of config.keywords) {
        // For short Latin-alphabet keywords (<=3 chars), use word-boundary matching
        // to prevent false positives (e.g., "ai" matching inside "said", "war" inside "software")
        const useWordBoundary = keyword.length <= 3 && /^[a-zA-Z]+$/.test(keyword);
        let matchesTitle, matchesBody;

        if (useWordBoundary) {
          const re = new RegExp(`\\b${keyword}\\b`, 'i');
          matchesTitle = re.test(titleText);
          matchesBody = re.test(bodyText);
        } else {
          matchesTitle = titleText.includes(keyword);
          matchesBody = bodyText.includes(keyword);
        }

        if (matchesTitle) {
          score += TITLE_WEIGHT;
          titleMatches++;
        } else if (matchesBody) {
          score += BODY_WEIGHT;
        }
      }

      if (score > 0) {
        scores.push({ category, score, titleMatches });
      }
    }

    // Sort descending by score
    scores.sort((a, b) => b.score - a.score);

    // Tiebreaking: when top two categories are within one title-keyword gap,
    // prefer the one with MORE distinct title keyword matches.
    // This prevents a single keyword (e.g., "ai") from beating multiple keywords
    // from another category (e.g., "ncaa" + "basketball" + "bracket").
    if (scores.length >= 2) {
      const gap = scores[0].score - scores[1].score;
      if (gap <= TITLE_WEIGHT && scores[1].titleMatches > scores[0].titleMatches) {
        logger.info(`Swapping primary/secondary: ${scores[1].category} has ${scores[1].titleMatches} title keywords vs ${scores[0].category}'s ${scores[0].titleMatches} (score gap: ${gap})`);
        [scores[0], scores[1]] = [scores[1], scores[0]];
      }
    }

    const primary = scores.length > 0 && scores[0].score >= MIN_WEIGHTED_SCORE
      ? scores[0].category
      : 'general';

    const secondary = scores.length > 1 && scores[1].score >= MIN_WEIGHTED_SCORE
      ? scores[1].category
      : null;

    if (scores.length > 0 && scores[0].score < MIN_WEIGHTED_SCORE) {
      logger.info(`Top keyword score ${scores[0].score} below threshold (${MIN_WEIGHTED_SCORE}), using 'general' fallback`);
    }

    if (primary !== 'general' && secondary) {
      logger.info(`Classification scores: ${primary}=${scores[0].score} (${scores[0].titleMatches} title), ${secondary}=${scores[1].score} (${scores[1].titleMatches} title)`);
    }

    return { primary, secondary };
  }

  /**
   * Extract the dominant mood from the article text.
   */
  static extractMood(text) {
    let bestMood = 'neutral';
    let bestScore = 0;

    for (const [mood, indicators] of Object.entries(MOOD_INDICATORS)) {
      const score = indicators.reduce((count, word) => {
        return count + (text.includes(word) ? 1 : 0);
      }, 0);

      if (score > bestScore) {
        bestScore = score;
        bestMood = mood;
      }
    }

    return bestMood;
  }

  /**
   * Get the safe visual alternatives for a given category.
   * Used by the rephrase system to suggest domain-appropriate fallback scenes.
   * @param {string} category - Scene category name
   * @returns {string} Safe alternatives string
   */
  static getSafeAlternatives(category) {
    const config = SCENE_CATEGORIES[category] || SCENE_CATEGORIES.general;
    return config.safeAlternatives;
  }
}

export default VideoPromptEngine;
