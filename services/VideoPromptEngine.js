// services/VideoPromptEngine.js
// Converts article data + caption + image into precise video generation prompts
// for Veo 3.1 and Runway 4.5 text+image-to-video models.

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

// News scene categories with associated visual and audio direction
// Each category includes both English and Hebrew (עברית) keywords for bilingual matching
const SCENE_CATEGORIES = {
  politics: {
    keywords: [
      'election', 'president', 'congress', 'senate', 'parliament', 'government', 'law', 'policy', 'vote', 'legislation', 'diplomat', 'treaty', 'political', 'minister', 'chancellor', 'governor', 'mayor', 'democratic', 'republican', 'coalition', 'opposition',
      'בחירות', 'נשיא', 'כנסת', 'ממשלה', 'חוק', 'מדיניות', 'הצבעה', 'חקיקה', 'דיפלומט', 'שר', 'ראש ממשלה', 'קואליציה', 'אופוזיציה', 'מפלגה', 'שלטון', 'פוליטי', 'פרלמנט'
    ],
    camera: ['slow zoom in on details', 'steady tracking across scene', 'gradual pull back revealing scale'],
    lighting: 'natural institutional lighting with warm undertones',
    ambient: 'subtle murmur of formal proceedings, muted ambient noise',
    music: 'understated orchestral undertone, measured and authoritative',
    style: 'formal news documentary, steady and composed'
  },
  technology: {
    keywords: [
      'ai', 'artificial intelligence', 'software', 'startup', 'app', 'robot', 'digital', 'cyber', 'data', 'algorithm', 'chip', 'semiconductor', 'cloud', 'quantum', 'blockchain', 'tech', 'innovation', 'silicon valley', 'computing', 'neural', 'machine learning', 'automation',
      'בינה מלאכותית', 'תוכנה', 'סטארטאפ', 'אפליקציה', 'רובוט', 'דיגיטל', 'סייבר', 'מידע', 'אלגוריתם', 'שבב', 'ענן', 'בלוקצ\'יין', 'טכנולוגיה', 'חדשנות', 'מחשוב', 'הייטק'
    ],
    camera: ['smooth gliding motion through scene', 'slow cinematic pan revealing details', 'gentle push in with precision focus'],
    lighting: 'clean modern lighting with cool blue and white tones',
    ambient: 'soft electronic hum, quiet digital ambiance',
    music: 'minimal electronic pulse, forward-looking and clean',
    style: 'sleek tech documentary, crisp and modern'
  },
  business: {
    keywords: [
      'market', 'stock', 'economy', 'trade', 'ceo', 'company', 'revenue', 'profit', 'merger', 'acquisition', 'ipo', 'investment', 'bank', 'finance', 'gdp', 'inflation', 'corporate', 'earnings', 'wall street', 'nasdaq', 'dow',
      'שוק', 'מניה', 'כלכלה', 'סחר', 'מנכ"ל', 'חברה', 'הכנסות', 'רווח', 'מיזוג', 'רכישה', 'השקעה', 'בנק', 'פיננסי', 'אינפלציה', 'בורסה', 'תאגיד', 'עסקים'
    ],
    camera: ['measured tracking shot across scene', 'slow zoom establishing context', 'steady pull back revealing environment'],
    lighting: 'professional warm lighting, clean and polished',
    ambient: 'distant city hum, professional environment sounds',
    music: 'confident piano and strings, steady momentum',
    style: 'corporate news broadcast, polished and professional'
  },
  science: {
    keywords: [
      'research', 'study', 'scientist', 'discovery', 'space', 'nasa', 'climate', 'environment', 'biology', 'physics', 'chemistry', 'medical', 'experiment', 'journal', 'peer-reviewed', 'telescope', 'genome', 'evolution', 'species', 'laboratory',
      'מחקר', 'מדען', 'גילוי', 'חלל', 'אקלים', 'סביבה', 'ביולוגיה', 'פיזיקה', 'כימיה', 'ניסוי', 'מעבדה', 'טלסקופ', 'גנום', 'מדע', 'אוניברסיטה'
    ],
    camera: ['slow macro-style push in on details', 'smooth orbital movement around subject', 'gentle floating drift through scene'],
    lighting: 'soft natural or laboratory lighting with precise highlights',
    ambient: 'quiet research environment, gentle instrument sounds',
    music: 'ethereal ambient tones, sense of wonder and curiosity',
    style: 'nature documentary meets science broadcast, contemplative'
  },
  health: {
    keywords: [
      'health', 'disease', 'virus', 'hospital', 'doctor', 'patient', 'treatment', 'vaccine', 'drug', 'fda', 'clinical', 'symptom', 'pandemic', 'epidemic', 'mental health', 'therapy', 'surgery', 'pharmaceutical', 'wellness', 'diagnosis',
      'בריאות', 'מחלה', 'וירוס', 'בית חולים', 'רופא', 'מטופל', 'טיפול', 'חיסון', 'תרופה', 'קליני', 'מגפה', 'בריאות הנפש', 'ניתוח', 'אבחון', 'רפואה'
    ],
    camera: ['gentle steady push toward subject', 'slow empathetic drift through scene', 'careful measured tracking'],
    lighting: 'soft warm lighting with clinical precision where needed',
    ambient: 'calm clinical environment, quiet and measured',
    music: 'gentle piano with hopeful undertone, compassionate',
    style: 'medical documentary, caring and informative'
  },
  sports: {
    keywords: [
      'game', 'match', 'team', 'player', 'coach', 'season', 'championship', 'tournament', 'score', 'goal', 'victory', 'defeat', 'athlete', 'olympic', 'league', 'nba', 'nfl', 'fifa', 'tennis', 'soccer', 'football', 'baseball',
      'משחק', 'קבוצה', 'שחקן', 'מאמן', 'עונה', 'אליפות', 'טורניר', 'ניצחון', 'תבוסה', 'ספורטאי', 'אולימפי', 'ליגה', 'כדורגל', 'כדורסל', 'גביע'
    ],
    camera: ['dynamic tracking following action', 'sweeping pan across scene', 'energetic zoom capturing intensity'],
    lighting: 'vibrant stadium or arena lighting, high contrast',
    ambient: 'distant crowd roar, rhythmic energy',
    music: 'driving percussion with rising intensity, adrenaline',
    style: 'sports broadcast highlight, energetic and dynamic'
  },
  entertainment: {
    keywords: [
      'movie', 'film', 'music', 'celebrity', 'actor', 'singer', 'album', 'concert', 'award', 'oscar', 'grammy', 'netflix', 'streaming', 'show', 'series', 'premiere', 'box office', 'hollywood', 'broadway', 'festival',
      'סרט', 'סלבריטי', 'שחקן', 'זמר', 'אלבום', 'קונצרט', 'פרס', 'אוסקר', 'נטפליקס', 'סדרה', 'הוליווד', 'פסטיבל', 'בידור', 'הופעה'
    ],
    camera: ['glamorous slow dolly through scene', 'smooth cinematic pan with depth', 'artistic drift with shallow focus'],
    lighting: 'dramatic cinematic lighting with rich colors',
    ambient: 'soft ambient crowd or event atmosphere',
    music: 'stylish contemporary beat, engaging and polished',
    style: 'entertainment news magazine, vibrant and cinematic'
  },
  conflict: {
    keywords: [
      'war', 'attack', 'military', 'troops', 'bomb', 'missile', 'conflict', 'terror', 'crisis', 'emergency', 'refugee', 'protest', 'riot', 'violence', 'ceasefire', 'sanctions', 'nato', 'defense', 'invasion', 'occupation',
      'מלחמה', 'התקפה', 'צבא', 'פצצה', 'טיל', 'סכסוך', 'טרור', 'משבר', 'חירום', 'פליט', 'מחאה', 'הפגנה', 'אלימות', 'הפסקת אש', 'סנקציות', 'הגנה', 'פלישה', 'כיבוש'
    ],
    camera: ['steady measured movement through scene', 'slow observational pan', 'static with subtle atmospheric drift'],
    lighting: 'muted natural lighting with atmospheric haze',
    ambient: 'distant ambient tension, wind and environmental sounds',
    music: 'somber low strings, restrained and heavy',
    style: 'war correspondence documentary, sobering and respectful'
  },
  weather: {
    keywords: [
      'weather', 'storm', 'hurricane', 'tornado', 'flood', 'drought', 'earthquake', 'wildfire', 'temperature', 'climate change', 'snow', 'rain', 'wind', 'forecast', 'natural disaster', 'heatwave', 'blizzard', 'tsunami',
      'מזג אוויר', 'סופה', 'הוריקן', 'שיטפון', 'בצורת', 'רעידת אדמה', 'שריפה', 'טמפרטורה', 'שלג', 'גשם', 'רוח', 'תחזית', 'אסון טבע', 'גל חום'
    ],
    camera: ['wide sweeping aerial-style pan', 'slow zoom revealing scale of scene', 'atmospheric drift through environment'],
    lighting: 'dramatic natural lighting matching weather conditions',
    ambient: 'wind, rain, or environmental weather sounds',
    music: 'atmospheric swells building with nature, powerful and immersive',
    style: 'nature documentary, awe-inspiring and immersive'
  },
  real_estate: {
    keywords: [
      'real estate', 'property', 'mortgage', 'housing', 'apartment', 'condo', 'rental', 'tenant', 'landlord', 'construction', 'developer', 'zoning', 'residential', 'commercial property', 'home prices', 'home sales', 'foreclosure', 'realty', 'listing', 'square feet', 'renovation', 'building permit',
      'נדל"ן', 'דירה', 'משכנתא', 'בנייה', 'קבלן', 'פינוי בינוי', 'תמ"א', 'שכירות', 'מכירה', 'נכס', 'קרקע', 'דיור', 'מגדל', 'שיכון', 'מחיר דירה', 'יזם', 'התחדשות עירונית', 'רכישה', 'מתווך', 'טאבו'
    ],
    camera: ['smooth aerial-style glide over structures', 'elegant tracking along building facade', 'slow reveal pull back showing neighborhood context'],
    lighting: 'warm inviting natural lighting, golden tones on structures',
    ambient: 'urban environment sounds, construction activity in distance',
    music: 'optimistic contemporary piano with subtle momentum, aspirational',
    style: 'architectural showcase documentary, inviting and aspirational'
  },
  human_interest: {
    keywords: [
      'community', 'family', 'child', 'education', 'school', 'charity', 'volunteer', 'rescue', 'hero', 'inspire', 'overcome', 'personal', 'story', 'journey', 'milestone', 'achievement', 'tradition', 'culture',
      'קהילה', 'משפחה', 'ילד', 'חינוך', 'בית ספר', 'צדקה', 'מתנדב', 'הצלה', 'גיבור', 'השראה', 'הישג', 'מסורת', 'תרבות'
    ],
    camera: ['intimate slow push in', 'warm gentle tracking', 'soft pull back revealing connection'],
    lighting: 'warm golden hour lighting, natural and inviting',
    ambient: 'soft everyday life sounds, gentle and familiar',
    music: 'warm acoustic or piano melody, heartfelt and uplifting',
    style: 'human interest documentary, intimate and hopeful'
  },
  general: {
    keywords: [], // Never matched by keywords — used as the universal fallback
    camera: ['slow steady tracking across scene', 'measured push in toward subject', 'smooth pull back establishing context'],
    lighting: 'balanced natural lighting, clean and professional',
    ambient: 'subtle ambient environmental sounds, unobtrusive',
    music: 'neutral contemporary underscore, professional and adaptable',
    style: 'professional news broadcast, clean and versatile'
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
   * Generate a video prompt from article data, caption, and image context.
   * @param {Object} params
   * @param {Object} params.article - { title, summary, description, source }
   * @param {string} params.caption - Generated TikTok caption text
   * @param {string} params.imageUrl - Article image URL
   * @param {string} params.model - 'veo' or 'runway'
   * @returns {string} Video generation prompt
   */
  static generatePrompt({ article, caption, imageUrl, model = 'veo' }) {
    const text = `${article.title || ''} ${article.summary || ''} ${article.description || ''}`.toLowerCase();

    // 1. Classify scene category
    const category = this.classifyScene(text);
    const sceneConfig = SCENE_CATEGORIES[category];
    logger.info(`Scene classified as: ${category}`);

    // 2. Determine mood
    const mood = this.extractMood(text);
    logger.info(`Mood extracted: ${mood}`);

    // 3. Select camera movement
    const camera = sceneConfig.camera[Math.floor(Math.random() * sceneConfig.camera.length)];

    // 4. Build the visual description from article context
    const visualContext = this.buildVisualContext(article, category);

    // 5. Assemble prompt based on model
    const prompt = model === 'runway'
      ? this.buildRunwayPrompt({ visualContext, camera, sceneConfig, mood, category })
      : this.buildVeoPrompt({ visualContext, camera, sceneConfig, mood, category });

    logger.info(`Generated ${model} video prompt (${prompt.length} chars) for category: ${category}, mood: ${mood}`);
    return prompt;
  }

  /**
   * Classify the article into a scene category by keyword matching.
   * Requires at least MIN_KEYWORD_MATCHES to assign a specific category.
   * Falls back to 'general' (neutral broadcast style) if no category
   * meets the threshold — avoids forcing a specific mood/style on
   * articles that don't clearly belong to any category.
   */
  static classifyScene(text) {
    const MIN_KEYWORD_MATCHES = 2;
    let bestCategory = 'general';
    let bestScore = 0;

    for (const [category, config] of Object.entries(SCENE_CATEGORIES)) {
      if (category === 'general') continue; // Skip — general has no keywords
      const score = config.keywords.reduce((count, keyword) => {
        return count + (text.includes(keyword) ? 1 : 0);
      }, 0);

      if (score > bestScore) {
        bestScore = score;
        bestCategory = score >= MIN_KEYWORD_MATCHES ? category : 'general';
      }
    }

    if (bestScore > 0 && bestScore < MIN_KEYWORD_MATCHES) {
      logger.info(`Keyword score ${bestScore} below threshold (${MIN_KEYWORD_MATCHES}), using 'general' fallback`);
    }

    return bestCategory;
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
   * Build a concise visual description from the article content.
   * Extracts the most visually meaningful sentence to anchor the video.
   */
  static buildVisualContext(article, category) {
    const title = article.title || '';
    const summary = article.summary || article.description || '';

    // Take the first meaningful sentence from the summary for visual grounding
    const sentences = summary.split(/[.!?]+/).filter(s => s.trim().length > 20);
    const anchorSentence = sentences.length > 0 ? sentences[0].trim() : summary.slice(0, 120).trim();

    return `${title}. ${anchorSentence}`;
  }

  /**
   * Build a Veo 3.1-optimized prompt (longer, detailed, explicit audio cues).
   */
  static buildVeoPrompt({ visualContext, camera, sceneConfig, mood, category }) {
    const moodAdjective = {
      urgent: 'tense and pressing',
      hopeful: 'optimistic and uplifting',
      somber: 'solemn and reflective',
      exciting: 'dynamic and electrifying',
      neutral: 'measured and informative'
    }[mood] || 'measured and informative';

    return `Photorealistic cinematic video in 9:16 portrait orientation. ${sceneConfig.style} visual approach.

Scene: ${visualContext}

The reference image comes to life as a living scene. Camera: ${camera}, creating a ${moodAdjective} visual narrative. The opening seconds establish the scene with the image as the starting composition, then the camera smoothly transitions through the environment, revealing depth, context, and atmosphere. The final moments pull the viewer into the emotional core of the story.

Lighting: ${sceneConfig.lighting}. Natural color grading, no filters or stylization. High detail, sharp focus, photorealistic rendering.

Audio: ${sceneConfig.ambient}. Background music: ${sceneConfig.music}. The audio mood is ${moodAdjective}, complementing the visuals with synchronized environmental sounds. No spoken narration unless dialogue is naturally part of the scene.

Style: Documentary news footage. Cinematic quality, broadcast-grade production value. 1080p resolution, smooth 24fps motion.`;
  }

  /**
   * Build a Runway 4.5-optimized prompt (max 1000 chars, concise, visual-focused).
   */
  static buildRunwayPrompt({ visualContext, camera, sceneConfig, mood, category }) {
    const moodWord = {
      urgent: 'tense',
      hopeful: 'uplifting',
      somber: 'solemn',
      exciting: 'dynamic',
      neutral: 'measured'
    }[mood] || 'measured';

    // Truncate visual context to fit within 1000 char budget
    const shortContext = visualContext.length > 250
      ? visualContext.slice(0, 247) + '...'
      : visualContext;

    const prompt = `Photorealistic 9:16 portrait video. ${sceneConfig.style}.

Scene: ${shortContext}

The reference image transforms into a living cinematic scene. Camera: ${camera}. Mood: ${moodWord}. ${sceneConfig.lighting}. Natural colors, sharp focus, documentary quality.

Audio: ${sceneConfig.ambient}. Music: ${sceneConfig.music}.`;

    // Hard enforce 1000 char limit for Runway
    if (prompt.length > 1000) {
      return prompt.slice(0, 997) + '...';
    }

    return prompt;
  }
}

export default VideoPromptEngine;
