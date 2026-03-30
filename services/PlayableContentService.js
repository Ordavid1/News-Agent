/**
 * Playable Content Service
 *
 * Generates interactive playable ads and brand story experiences from Brand Kit assets.
 *
 * Pipeline:
 *   1. Load Brand Kit → build asset manifest (sprites, logos, colors, style)
 *   2. Download & resize extracted assets → encode as base64 data URIs
 *   3. Generate Phaser.js game code via Gemini Flash
 *   4. Validate generated code (syntax, structure, security)
 *   5. Wrap in MRAID shells for ad networks (Google, Meta, Unity)
 *   6. Upload to Supabase Storage → return preview + download URLs
 *
 * Uses Gemini Flash for code generation (~$0.01-0.05 per generation).
 * All output is a self-contained single HTML file (Phaser + assets inlined as data URIs).
 */

import axios from 'axios';
import winston from 'winston';
import sharp from 'sharp';
import { supabaseAdmin } from './supabase.js';
import {
  getMediaTrainingJobById,
  createPlayableContent,
  updatePlayableContent,
  getPlayableContentById,
  getUserPlayableContent,
  deletePlayableContent as dbDeletePlayableContent,
  getPlayableContentCredits,
  consumePlayableContentCredit,
  createPerUsePurchase
} from './database-wrapper.js';
import testProgressEmitter from './TestProgressEmitter.js';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[PlayableContentService] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

// Storage
const STORAGE_BUCKET = 'media-assets';
const PHASER_CDN_URL = 'https://cdn.jsdelivr.net/npm/phaser@3.80.1/dist/phaser.min.js';

// Generation limits
const MAX_ASSET_SIZE_BYTES = 2 * 1024 * 1024; // 2MB total for inlined assets
const MAX_SPRITE_DIMENSION = 256;
const MAX_LOGO_DIMENSION = 128;
const MAX_CODE_SIZE_BYTES = 200 * 1024; // 200KB for game code
const MAX_RETRIES = 1;
const GEMINI_TIMEOUT_MS = 180000; // 180s for code generation (Gemini Flash can be slow for large outputs)

// ============================================
// GAME TEMPLATE REGISTRY
// ============================================

const GAME_TEMPLATES = {
  // === Mini-Games ===
  catch_falling: {
    id: 'catch_falling',
    type: 'mini_game',
    name: 'Catch the Falling Items',
    description: 'Products and logos fall from the top of the screen. Players drag a basket to catch them before they hit the ground.',
    duration: '60-90s',
    requiredAssets: { minSprites: 1 },
    optionalAssets: { maxSprites: 5 },
    mechanics: ['touch_drag', 'score', 'timer'],
    phaserScenes: ['BootScene', 'GameScene', 'EndScene'],
    ctaPlacement: 'end_screen'
  },
  tap_the_logo: {
    id: 'tap_the_logo',
    type: 'mini_game',
    name: 'Tap the Logo',
    description: 'Brand logos appear at random positions. Tap them before they vanish. Speed increases over time.',
    duration: '30-60s',
    requiredAssets: { minLogos: 1 },
    optionalAssets: { maxSprites: 3 },
    mechanics: ['tap', 'score', 'timer', 'speed_ramp'],
    phaserScenes: ['BootScene', 'GameScene', 'EndScene'],
    ctaPlacement: 'end_screen'
  },
  color_match: {
    id: 'color_match',
    type: 'mini_game',
    name: 'Brand Color Match',
    description: 'A memory/puzzle game using your brand color palette. Match pairs of brand colors to win.',
    duration: '60-90s',
    requiredAssets: {}, // Only needs color palette
    requiredBrandKit: ['color_palette'],
    optionalAssets: { maxLogos: 1 },
    mechanics: ['tap', 'match', 'score', 'timer'],
    phaserScenes: ['BootScene', 'GameScene', 'EndScene'],
    ctaPlacement: 'end_screen'
  },
  swipe_sort: {
    id: 'swipe_sort',
    type: 'mini_game',
    name: 'Swipe & Sort',
    description: 'Items appear on screen. Swipe left or right to sort them into matching categories.',
    duration: '45-60s',
    requiredAssets: { minSprites: 2 },
    optionalAssets: { maxSprites: 6 },
    mechanics: ['swipe', 'score', 'timer'],
    phaserScenes: ['BootScene', 'GameScene', 'EndScene'],
    ctaPlacement: 'end_screen'
  },

  // === Interactive Stories ===
  brand_story: {
    id: 'brand_story',
    type: 'interactive_story',
    name: 'Brand Story Experience',
    description: 'An interactive narrative with brand visuals, tap-to-advance pages, and choice points for the viewer.',
    duration: '60-120s',
    requiredAssets: { minSprites: 1 },
    optionalAssets: { maxSprites: 5, maxLogos: 1 },
    requiredBrandKit: ['brand_summary', 'style_characteristics'],
    mechanics: ['tap_advance', 'choice_branch', 'parallax'],
    phaserScenes: ['BootScene', 'StoryScene', 'EndScene'],
    ctaPlacement: 'end_screen'
  },
  product_reveal: {
    id: 'product_reveal',
    type: 'interactive_story',
    name: 'Product Reveal',
    description: 'An animated product or service reveal with interactive elements and brand-themed transitions.',
    duration: '30-60s',
    requiredAssets: { minSprites: 1 },
    optionalAssets: { maxSprites: 3, maxLogos: 1 },
    mechanics: ['tap_reveal', 'animation_sequence', 'parallax'],
    phaserScenes: ['BootScene', 'RevealScene', 'EndScene'],
    ctaPlacement: 'end_screen'
  }
};

// ============================================
// SERVICE CLASS
// ============================================

class PlayableContentService {
  constructor() {
    this._phaserJsCache = null;
    logger.info('PlayableContentService initialized');
  }

  // ============================================
  // PUBLIC API
  // ============================================

  /**
   * Get available templates, filtered by what the brand kit supports.
   */
  getAvailableTemplates(brandKit, contentType) {
    const templates = Object.values(GAME_TEMPLATES);
    const filtered = contentType ? templates.filter(t => t.type === contentType) : templates;

    const extractedAssets = brandKit?.extracted_assets || [];
    const colorPalette = brandKit?.color_palette || [];

    const sprites = extractedAssets.filter(a => a.type === 'person' || a.type === 'graphic');
    const logos = extractedAssets.filter(a => a.type === 'logo');

    return filtered.map(template => {
      const requirements = template.requiredAssets || {};
      let available = true;
      let missingReason = null;

      if (requirements.minSprites && sprites.length < requirements.minSprites) {
        available = false;
        missingReason = `Requires at least ${requirements.minSprites} visual asset cutout(s) (people or graphics)`;
      }
      if (requirements.minLogos && logos.length < requirements.minLogos) {
        available = false;
        missingReason = `Requires at least ${requirements.minLogos} logo cutout(s)`;
      }
      if (template.requiredBrandKit?.includes('color_palette') && colorPalette.length < 3) {
        available = false;
        missingReason = 'Requires at least 3 brand colors in the palette';
      }
      if (template.requiredBrandKit?.includes('brand_summary') && !brandKit?.brand_summary) {
        available = false;
        missingReason = 'Requires brand summary analysis';
      }
      if (brandKit?.asset_extraction_status === 'processing' || brandKit?.asset_extraction_status === 'pending') {
        if (requirements.minSprites || requirements.minLogos) {
          available = false;
          missingReason = 'Asset extraction is still in progress';
        }
      }

      return {
        ...template,
        available,
        missingReason,
        assetCounts: { sprites: sprites.length, logos: logos.length, colors: colorPalette.length }
      };
    });
  }

  /**
   * Get a single template by ID.
   */
  getTemplateById(templateId) {
    return GAME_TEMPLATES[templateId] || null;
  }

  /**
   * Main generation pipeline. Runs asynchronously (fire-and-forget from the route).
   * Progress is streamed via TestProgressEmitter SSE.
   */
  async generate(userId, adAccountId, trainingJobId, options) {
    const { templateId, contentType, title, ctaUrl, mraidFormats = ['google'], storyOptions = {} } = options;

    const template = this.getTemplateById(templateId);
    if (!template) throw new Error(`Unknown template: ${templateId}`);
    if (template.type !== contentType) throw new Error(`Template ${templateId} is type ${template.type}, not ${contentType}`);

    // Create DB record
    const record = await createPlayableContent(userId, {
      adAccountId,
      trainingJobId,
      contentType,
      templateId,
      title,
      ctaUrl,
      storyOptions,
      mraidFormats
    });

    const contentId = record.id;
    // Session key for SSE progress — uses playable: prefix to avoid collision with agent test sessions
    const sessionKey = `playable:${contentId}`;

    // Start SSE session
    testProgressEmitter.startSession(userId, sessionKey);

    const startTime = Date.now();

    // Fire-and-forget the pipeline
    this._runPipeline(userId, adAccountId, trainingJobId, contentId, sessionKey, template, {
      title, ctaUrl, mraidFormats, storyOptions, startTime
    }).catch(err => {
      logger.error(`Pipeline failed for ${contentId}: ${err.message}`);
    });

    return record;
  }

  // ============================================
  // GENERATION PIPELINE
  // ============================================

  async _runPipeline(userId, adAccountId, trainingJobId, contentId, sessionKey, template, opts) {
    const { title, ctaUrl, mraidFormats, storyOptions, startTime } = opts;

    try {
      // Phase 1: Load brand kit
      this._emitProgress(userId, sessionKey, 'preparing', 'Loading brand kit and selecting assets...');
      await updatePlayableContent(contentId, userId, { status: 'generating' });

      const job = await getMediaTrainingJobById(trainingJobId, userId);
      if (!job || !job.brand_kit) {
        throw new Error('Training job or brand kit not found');
      }
      const brandKit = job.brand_kit;

      // Phase 2: Build asset manifest
      const assetManifest = this._buildAssetManifest(brandKit, template);

      // Phase 3: Download and encode assets as data URIs
      this._emitProgress(userId, sessionKey, 'encoding_assets', 'Preparing visual assets...');
      const inlinedAssets = await this._inlineAssetsAsDataURIs(assetManifest);

      // Phase 4: Generate game code via Gemini
      this._emitProgress(userId, sessionKey, 'generating_code', 'Generating interactive code with AI...');
      const prompt = this._buildPrompt(template, assetManifest, brandKit, { title, ctaUrl, storyOptions });

      let gameCode = await this._callGemini(prompt);
      gameCode = this._cleanCodeResponse(gameCode);

      // Phase 5: Validate
      this._emitProgress(userId, sessionKey, 'validating', 'Validating generated code...');
      await updatePlayableContent(contentId, userId, { status: 'validating' });

      let validation = this._validateGeneratedCode(gameCode, template);

      if (!validation.valid) {
        // Retry once with error feedback
        this._emitProgress(userId, sessionKey, 'retry', 'Fixing code issues and retrying...');
        const retryPrompt = this._buildRetryPrompt(prompt, gameCode, validation.errors);
        gameCode = await this._callGemini(retryPrompt);
        gameCode = this._cleanCodeResponse(gameCode);
        validation = this._validateGeneratedCode(gameCode, template);

        if (!validation.valid) {
          // Use fallback skeleton
          logger.warn(`Playable ${contentId}: validation failed after retry, using fallback skeleton`);
          gameCode = this._buildFallbackCode(template, assetManifest);
          validation = this._validateGeneratedCode(gameCode, template);
        }
      }

      if (!validation.valid) {
        throw new Error(`Code validation failed: ${validation.errors.map(e => e.message).join('; ')}`);
      }

      // Phase 6: Package
      this._emitProgress(userId, sessionKey, 'packaging', 'Assembling playable ad packages...');
      await updatePlayableContent(contentId, userId, { status: 'packaging' });

      const phaserJs = await this._getPhaserJs();
      const previewHtml = this._buildPreviewHTML(gameCode, inlinedAssets, phaserJs, assetManifest.palette, ctaUrl);

      const mraidHtmls = {};
      for (const format of mraidFormats) {
        mraidHtmls[format] = this._wrapWithMRAID(gameCode, inlinedAssets, phaserJs, assetManifest.palette, ctaUrl, format);
      }

      // Phase 7: Upload to storage
      this._emitProgress(userId, sessionKey, 'uploading', 'Saving to storage...');
      const basePath = `${userId}/${adAccountId}/playable-content/${contentId}`;

      const previewUrl = await this._uploadToStorage(`${basePath}/preview.html`, previewHtml, 'text/html');

      for (const [format, html] of Object.entries(mraidHtmls)) {
        await this._uploadToStorage(`${basePath}/${format}-mraid.html`, html, 'text/html');
      }

      // Calculate total size
      const totalSize = Buffer.byteLength(previewHtml, 'utf8') +
        Object.values(mraidHtmls).reduce((sum, html) => sum + Buffer.byteLength(html, 'utf8'), 0);

      // Phase 8: Consume credit (only on success)
      const consumed = await consumePlayableContentCredit(userId);
      if (!consumed) {
        logger.warn(`Playable ${contentId}: no credit to consume (may have been pre-consumed)`);
      }

      // Phase 9: Complete
      const duration = Date.now() - startTime;
      await updatePlayableContent(contentId, userId, {
        status: 'completed',
        game_code: gameCode,
        final_html: previewHtml,
        gemini_prompt: prompt,
        asset_manifest: {
          sprites: assetManifest.sprites.map(s => ({ type: s.type, description: s.description })),
          logos: assetManifest.logos.map(l => ({ type: l.type, description: l.description })),
          palette: assetManifest.palette
        },
        storage_path: basePath,
        public_url: previewUrl,
        file_size_bytes: totalSize,
        generation_duration_ms: duration
      });

      this._emitProgress(userId, sessionKey, 'complete', 'Playable content ready!', {
        contentId,
        previewUrl,
        duration
      });

      logger.info(`Playable ${contentId} completed in ${duration}ms, size: ${(totalSize / 1024).toFixed(0)}KB`);

    } catch (err) {
      logger.error(`Playable ${contentId} pipeline error: ${err.message}`);
      await updatePlayableContent(contentId, userId, {
        status: 'failed',
        error_message: err.message
      }).catch(e => logger.error(`Failed to update failed status: ${e.message}`));

      this._emitProgress(userId, sessionKey, 'error', err.message);
    }
  }

  // ============================================
  // ASSET PIPELINE
  // ============================================

  /**
   * Build asset manifest from brand kit, mapping assets to game roles.
   */
  _buildAssetManifest(brandKit, template) {
    const extractedAssets = brandKit.extracted_assets || [];
    const colorPalette = brandKit.color_palette || [];

    // Split by type
    const allSprites = extractedAssets
      .filter(a => a.type === 'person' || a.type === 'graphic')
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

    const allLogos = extractedAssets
      .filter(a => a.type === 'logo')
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

    // Limit to what the template can use
    const maxSprites = template.optionalAssets?.maxSprites || 5;
    const maxLogos = template.optionalAssets?.maxLogos || 2;

    const sprites = allSprites.slice(0, maxSprites);
    const logos = allLogos.slice(0, maxLogos);

    // Build color palette map
    const palette = colorPalette.slice(0, 8).map(c => ({
      hex: c.hex,
      name: c.name,
      usage: c.usage
    }));

    // Ensure at least primary/secondary/accent defaults
    const primary = palette.find(c => c.usage === 'primary')?.hex || '#6366F1';
    const secondary = palette.find(c => c.usage === 'secondary')?.hex || '#1E293B';
    const accent = palette.find(c => c.usage === 'accent')?.hex || '#F59E0B';
    const background = palette.find(c => c.usage === 'background')?.hex || '#F8FAFC';

    return {
      sprites,
      logos,
      palette,
      colors: { primary, secondary, accent, background },
      style: brandKit.style_characteristics || {},
      brandSummary: brandKit.brand_summary || ''
    };
  }

  /**
   * Download extracted assets, resize, and encode as base64 data URIs.
   * Enforces a total size budget.
   */
  async _inlineAssetsAsDataURIs(manifest) {
    const assets = {};
    let totalBytes = 0;

    // Process sprites
    for (let i = 0; i < manifest.sprites.length; i++) {
      const sprite = manifest.sprites[i];
      if (!sprite.url) continue;

      try {
        const dataUri = await this._downloadAndEncode(sprite.url, MAX_SPRITE_DIMENSION);
        const sizeBytes = Buffer.byteLength(dataUri, 'utf8');

        if (totalBytes + sizeBytes > MAX_ASSET_SIZE_BYTES) {
          logger.warn(`Asset budget exceeded at sprite_${i}, skipping remaining sprites`);
          break;
        }
        assets[`sprite_${i}`] = dataUri;
        totalBytes += sizeBytes;
      } catch (err) {
        logger.warn(`Failed to encode sprite ${i}: ${err.message}`);
      }
    }

    // Process logos
    for (let i = 0; i < manifest.logos.length; i++) {
      const logo = manifest.logos[i];
      if (!logo.url) continue;

      try {
        const dataUri = await this._downloadAndEncode(logo.url, MAX_LOGO_DIMENSION);
        const sizeBytes = Buffer.byteLength(dataUri, 'utf8');

        if (totalBytes + sizeBytes > MAX_ASSET_SIZE_BYTES) {
          logger.warn(`Asset budget exceeded at logo_${i}, skipping remaining logos`);
          break;
        }
        assets[`logo_${i}`] = dataUri;
        totalBytes += sizeBytes;
      } catch (err) {
        logger.warn(`Failed to encode logo ${i}: ${err.message}`);
      }
    }

    logger.info(`Inlined ${Object.keys(assets).length} assets, total: ${(totalBytes / 1024).toFixed(0)}KB`);
    return assets;
  }

  /**
   * Download an image URL, resize it to maxDimension, return as data URI.
   */
  async _downloadAndEncode(url, maxDimension) {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 20000,
      headers: { 'User-Agent': 'NewsAgentSaaS/1.0' }
    });

    const buffer = await sharp(Buffer.from(response.data))
      .resize(maxDimension, maxDimension, { fit: 'inside', withoutEnlargement: true })
      .png({ quality: 80 })
      .toBuffer();

    const base64 = buffer.toString('base64');
    return `data:image/png;base64,${base64}`;
  }

  // ============================================
  // GEMINI CODE GENERATION
  // ============================================

  /**
   * Build the generation prompt for Gemini.
   */
  _buildPrompt(template, assetManifest, brandKit, opts) {
    const { title, ctaUrl, storyOptions } = opts;

    const assetLines = [];
    assetManifest.sprites.forEach((s, i) => {
      assetLines.push(`- sprite_${i}: ${s.description || s.type} (${s.type})`);
    });
    assetManifest.logos.forEach((l, i) => {
      assetLines.push(`- logo_${i}: ${l.description || 'brand logo'} (logo)`);
    });

    const colorLines = assetManifest.palette.map(c => `- ${c.usage}: ${c.hex} (${c.name})`);

    if (template.type === 'interactive_story') {
      return this._buildStoryPrompt(template, assetManifest, brandKit, assetLines, colorLines, opts);
    }

    return `You are an expert Phaser 3 game developer. Generate a complete, production-quality, self-contained Phaser 3 hyper-casual game as a single JavaScript code block.

GAME TYPE: ${template.name}
GAME DESCRIPTION: ${template.description}
GAME MECHANICS: ${template.mechanics.join(', ')}
TARGET DURATION: ${template.duration}
TITLE: ${title || 'Brand Game'}

BRAND CONTEXT:
- Brand Summary: ${assetManifest.brandSummary || 'A modern brand'}
- Mood: ${assetManifest.style?.mood || 'professional and engaging'}
- Aesthetic: ${assetManifest.style?.overall_aesthetic || 'clean and modern'}

AVAILABLE ASSETS (pre-loaded as data URIs, reference by key):
${assetLines.length > 0 ? assetLines.join('\n') : '- No image assets (use colored shapes instead)'}

COLOR PALETTE:
${colorLines.length > 0 ? colorLines.join('\n') : '- primary: #6366F1\n- secondary: #1E293B\n- accent: #F59E0B'}

TECHNICAL REQUIREMENTS:
1. Phaser 3 is available as window.Phaser (do NOT import or require it).
2. Game canvas: 320x480 pixels (portrait/mobile). Use scale config: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH, width: 320, height: 480 }.
3. Create these scenes: ${template.phaserScenes.join(' -> ')}.
4. In BootScene.preload(): Load each asset using this.load.image(key, window.ASSET_DATA_URIS[key]). ASSET_DATA_URIS is already defined on window — do NOT redeclare it with const/let/var.
5. GameScene: Implement the ${template.mechanics[0]} mechanic. Include score tracking displayed as text. Add a countdown timer (visible to player).
6. EndScene: Show "Game Over" text, final score, and a CTA button. The button must call window.mraidAction() when tapped.
7. Touch/pointer input ONLY (no keyboard). All interactions via this.input.on('pointer*') or gameObject.setInteractive().
8. Use brand colors throughout: background (${assetManifest.colors.background}), UI elements (${assetManifest.colors.primary}), text (${assetManifest.colors.secondary}), highlights (${assetManifest.colors.accent}).
9. Include particle effects or simple tweens to make it feel polished.
10. At the end, assign the full Phaser.Game configuration object to window.GAME_CONFIG (do NOT instantiate the game, just assign the config).

FORBIDDEN (DO NOT USE):
- fetch(), XMLHttpRequest, WebSocket — no network access
- document.cookie, localStorage, sessionStorage — no storage
- window.location, window.open (except window.mraidAction) — no navigation
- eval(), new Function() — no dynamic code execution
- import, require() — no module loading

Return ONLY valid JavaScript code. No markdown fences. No explanation. No comments outside the code.`;
  }

  _buildStoryPrompt(template, assetManifest, brandKit, assetLines, colorLines, opts) {
    const { title, storyOptions } = opts;
    const storyDirection = storyOptions?.direction || '';

    return `You are an expert Phaser 3 interactive storytelling developer. Generate a complete, self-contained Phaser 3 interactive story experience as a single JavaScript code block.

STORY TYPE: ${template.name}
DESCRIPTION: ${template.description}
TARGET DURATION: ${template.duration}
TITLE: ${title || 'Brand Story'}

BRAND CONTEXT:
- Brand Summary: ${assetManifest.brandSummary || 'A modern brand'}
- Mood: ${assetManifest.style?.mood || 'engaging and authentic'}
- Aesthetic: ${assetManifest.style?.overall_aesthetic || 'clean and modern'}
- Visual Motifs: ${assetManifest.style?.visual_motifs || 'none specified'}
${storyDirection ? `\nSTORY DIRECTION FROM USER: ${storyDirection}` : ''}

AVAILABLE ASSETS (pre-loaded as data URIs, reference by key):
${assetLines.length > 0 ? assetLines.join('\n') : '- No image assets (use colored shapes and text instead)'}

COLOR PALETTE:
${colorLines.length > 0 ? colorLines.join('\n') : '- primary: #6366F1\n- secondary: #1E293B\n- accent: #F59E0B'}

STORY STRUCTURE:
1. Opening Scene: Hook with brand problem or opportunity (text overlay with fade-in, background in brand colors)
2. Rising Scene: Brand character or product enters with smooth tween animation
3. Interaction Point: A choice for the user — two tappable areas (left/right) with different labels
4. Resolution Scene: Both paths converge to brand value proposition
5. End Scene: Brand logo (if available) + CTA button calling window.mraidAction()

ANIMATION GUIDELINES:
- Mood: ${assetManifest.style?.mood || 'engaging'} feel
- Use smooth Phaser tweens (duration: 800-1200ms, ease: 'Power2')
- Text: Use brand primary color with subtle shadow, fade in with stagger delay
- Character sprites: Floating bob animation when idle (y tween, yoyo: true)
- Backgrounds: Use brand palette gradients via Phaser.Display.Color for each scene
- Tap anywhere to advance (show subtle "tap to continue" hint text)
- At choice points: two semi-transparent rounded rectangles, side by side, with text labels

TECHNICAL REQUIREMENTS:
1. Phaser 3 is available as window.Phaser (do NOT import or require it).
2. Canvas: 320x480 portrait. Scale config: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH, width: 320, height: 480 }.
3. Scenes: ${template.phaserScenes.join(' -> ')}.
4. Load assets in first scene preload(): this.load.image(key, ASSET_DATA_URIS[key]).
5. Touch/pointer input ONLY. Tap to advance, tap to choose.
6. EndScene: CTA button calling window.mraidAction().
7. Assign game config to window.GAME_CONFIG (do NOT instantiate).

FORBIDDEN (DO NOT USE):
- fetch(), XMLHttpRequest, WebSocket — no network access
- document.cookie, localStorage, sessionStorage — no storage
- window.location, window.open (except window.mraidAction) — no navigation
- eval(), new Function() — no dynamic code execution
- import, require() — no module loading

Return ONLY valid JavaScript code. No markdown fences. No explanation.`;
  }

  /**
   * Build a retry prompt with error feedback.
   */
  _buildRetryPrompt(originalPrompt, failedCode, errors) {
    const errorList = errors.map(e => `- ${e.message}`).join('\n');
    return `${originalPrompt}

IMPORTANT: Your previous attempt had these errors:
${errorList}

Fix ONLY the errors listed above. Keep the rest of the game logic and structure intact.
Return the COMPLETE corrected JavaScript code.`;
  }

  /**
   * Call Gemini Flash to generate code.
   */
  async _callGemini(prompt) {
    const apiKey = process.env.GOOGLE_AI_STUDIO_API_KEY;
    if (!apiKey) throw new Error('GOOGLE_AI_STUDIO_API_KEY not configured');

    const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent';

    const response = await axios.post(endpoint, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 65536
      }
    }, {
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json'
      },
      timeout: GEMINI_TIMEOUT_MS
    });

    const rawText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!rawText) {
      throw new Error('Gemini returned empty response');
    }

    return rawText;
  }

  /**
   * Clean code from markdown fences and extra text.
   */
  _cleanCodeResponse(raw) {
    let code = raw;

    // Remove markdown fences
    const fenceMatch = code.match(/```(?:javascript|js)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      code = fenceMatch[1].trim();
    } else if (code.startsWith('```')) {
      code = code.replace(/^```(?:javascript|js)?\s*/, '').replace(/```\s*$/, '').trim();
    }

    // Remove ASSET_DATA_URIS redeclarations (we provide it on window already)
    code = code.replace(/^(?:const|let|var)\s+ASSET_DATA_URIS\s*=\s*window\.ASSET_DATA_URIS[^;]*;?\s*$/gm, '');

    return code;
  }

  // ============================================
  // CODE VALIDATION
  // ============================================

  /**
   * Validate generated Phaser.js code for syntax, required structure, and security.
   */
  _validateGeneratedCode(code, template) {
    const errors = [];

    // 1. Size check
    const codeSize = Buffer.byteLength(code, 'utf8');
    if (codeSize > MAX_CODE_SIZE_BYTES) {
      errors.push({ message: `Code exceeds ${MAX_CODE_SIZE_BYTES / 1024}KB limit (${(codeSize / 1024).toFixed(0)}KB)` });
    }

    // 2. Syntax check via Function constructor (does NOT execute the code)
    try {
      new Function(code);
    } catch (syntaxErr) {
      errors.push({ message: `JavaScript syntax error: ${syntaxErr.message}` });
      return { valid: false, errors }; // No point checking further
    }

    // 3. Required structure checks
    if (!/(?:new\s+Phaser\.Game|Phaser\.Game)/.test(code) && !/window\.GAME_CONFIG/.test(code)) {
      errors.push({ message: 'Missing Phaser.Game config or window.GAME_CONFIG assignment' });
    }
    if (!/(?:extends\s+Phaser\.Scene|Phaser\.Scene\.call)/.test(code) && !/(?:class\s+\w+Scene)/.test(code)) {
      errors.push({ message: 'Missing Phaser.Scene class definition' });
    }
    if (!/preload\s*\(/.test(code)) {
      errors.push({ message: 'Missing preload() method for asset loading' });
    }
    if (!/create\s*\(/.test(code)) {
      errors.push({ message: 'Missing create() method' });
    }
    if (!/ASSET_DATA_URIS/.test(code)) {
      errors.push({ message: 'Code does not reference ASSET_DATA_URIS for asset loading' });
    }
    if (!/mraidAction/.test(code)) {
      errors.push({ message: 'Missing window.mraidAction() CTA call in end scene' });
    }

    // 4. Forbidden pattern checks (security)
    const forbidden = [
      { pattern: /\bfetch\s*\(/, message: 'Forbidden: fetch() network call detected' },
      { pattern: /\bXMLHttpRequest\b/, message: 'Forbidden: XMLHttpRequest detected' },
      { pattern: /\bWebSocket\b/, message: 'Forbidden: WebSocket detected' },
      { pattern: /\bdocument\.cookie\b/, message: 'Forbidden: document.cookie access' },
      { pattern: /\blocalStorage\b/, message: 'Forbidden: localStorage access' },
      { pattern: /\bsessionStorage\b/, message: 'Forbidden: sessionStorage access' },
      { pattern: /\bwindow\.location\b/, message: 'Forbidden: window.location access' },
      { pattern: /\bwindow\.open\s*\(/, message: 'Forbidden: window.open() call' },
      { pattern: /\beval\s*\(/, message: 'Forbidden: eval() call' },
      { pattern: /\bimport\s+/, message: 'Forbidden: import statement' },
      { pattern: /\brequire\s*\(/, message: 'Forbidden: require() call' }
    ];

    for (const { pattern, message } of forbidden) {
      if (pattern.test(code)) {
        errors.push({ message });
      }
    }

    return { valid: errors.length === 0, errors };
  }

  // ============================================
  // FALLBACK CODE
  // ============================================

  /**
   * Generate a minimal but working fallback game when Gemini code fails validation.
   */
  _buildFallbackCode(template, assetManifest) {
    const { primary, secondary, accent, background } = assetManifest.colors;
    const spriteKeys = assetManifest.sprites.map((_, i) => `sprite_${i}`);
    const hasSpriteAssets = spriteKeys.length > 0;

    // Convert hex to Phaser color number
    const hexToNum = (hex) => `0x${hex.replace('#', '')}`;

    if (template.type === 'interactive_story') {
      return this._buildFallbackStory(assetManifest);
    }

    // Default fallback: simple tap game
    return `
// Fallback: Simple Tap Game
class BootScene extends Phaser.Scene {
  constructor() { super('BootScene'); }
  preload() {
    ${hasSpriteAssets ? spriteKeys.map(k => `if (ASSET_DATA_URIS['${k}']) this.load.image('${k}', ASSET_DATA_URIS['${k}']);`).join('\n    ') : '// No image assets'}
  }
  create() { this.scene.start('GameScene'); }
}

class GameScene extends Phaser.Scene {
  constructor() { super('GameScene'); }
  create() {
    this.score = 0;
    this.timeLeft = 30;
    this.cameras.main.setBackgroundColor('${background}');

    this.scoreText = this.add.text(160, 30, 'Score: 0', {
      fontSize: '24px', fontFamily: 'Arial', color: '${secondary}', fontStyle: 'bold'
    }).setOrigin(0.5);

    this.timerText = this.add.text(160, 460, 'Time: 30', {
      fontSize: '18px', fontFamily: 'Arial', color: '${primary}'
    }).setOrigin(0.5);

    this.time.addEvent({ delay: 1000, callback: () => {
      this.timeLeft--;
      this.timerText.setText('Time: ' + this.timeLeft);
      if (this.timeLeft <= 0) this.scene.start('EndScene', { score: this.score });
    }, loop: true });

    this.time.addEvent({ delay: 800, callback: () => this._spawnTarget(), loop: true });
    this._spawnTarget();
  }
  _spawnTarget() {
    const x = Phaser.Math.Between(40, 280);
    const y = Phaser.Math.Between(80, 420);
    let target;
    ${hasSpriteAssets ? `
    if (this.textures.exists('sprite_0')) {
      target = this.add.image(x, y, 'sprite_0').setDisplaySize(64, 64);
    } else {
      target = this.add.circle(x, y, 24, ${hexToNum(accent)});
    }` : `target = this.add.circle(x, y, 24, ${hexToNum(accent)});`}
    target.setInteractive();
    target.on('pointerdown', () => {
      this.score += 10;
      this.scoreText.setText('Score: ' + this.score);
      this.tweens.add({ targets: target, scale: 1.5, alpha: 0, duration: 200, onComplete: () => target.destroy() });
    });
    this.tweens.add({ targets: target, alpha: 0, duration: 2500, onComplete: () => { if (target.active) target.destroy(); } });
  }
}

class EndScene extends Phaser.Scene {
  constructor() { super('EndScene'); }
  create(data) {
    this.cameras.main.setBackgroundColor('${background}');
    this.add.text(160, 160, 'Game Over!', {
      fontSize: '32px', fontFamily: 'Arial', color: '${primary}', fontStyle: 'bold'
    }).setOrigin(0.5);
    this.add.text(160, 220, 'Score: ' + (data.score || 0), {
      fontSize: '28px', fontFamily: 'Arial', color: '${secondary}'
    }).setOrigin(0.5);
    const btn = this.add.rectangle(160, 340, 200, 50, ${hexToNum(primary)}, 1).setInteractive();
    this.add.text(160, 340, 'Learn More', {
      fontSize: '20px', fontFamily: 'Arial', color: '#FFFFFF', fontStyle: 'bold'
    }).setOrigin(0.5);
    btn.on('pointerdown', () => { if (window.mraidAction) window.mraidAction(); });
  }
}

window.GAME_CONFIG = {
  type: Phaser.AUTO,
  width: 320,
  height: 480,
  backgroundColor: '${background}',
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: [BootScene, GameScene, EndScene]
};`;
  }

  _buildFallbackStory(assetManifest) {
    const { primary, secondary, accent, background } = assetManifest.colors;
    const hexToNum = (hex) => `0x${hex.replace('#', '')}`;
    const hasSpriteAssets = assetManifest.sprites.length > 0;

    return `
// Fallback: Simple Interactive Story
class BootScene extends Phaser.Scene {
  constructor() { super('BootScene'); }
  preload() {
    ${hasSpriteAssets ? `if (ASSET_DATA_URIS['sprite_0']) this.load.image('sprite_0', ASSET_DATA_URIS['sprite_0']);` : '// No image assets'}
  }
  create() { this.scene.start('StoryScene'); }
}

class StoryScene extends Phaser.Scene {
  constructor() { super('StoryScene'); }
  create() {
    this.page = 0;
    this.pages = [
      { text: 'Discover something\\namazing...', bg: ${hexToNum(primary)} },
      { text: 'Built with passion\\nand purpose.', bg: ${hexToNum(secondary)} },
      { text: 'Experience the\\ndifference.', bg: ${hexToNum(accent)} }
    ];
    this.cameras.main.setBackgroundColor('${background}');
    this.storyText = this.add.text(160, 200, '', {
      fontSize: '26px', fontFamily: 'Arial', color: '#FFFFFF', fontStyle: 'bold',
      align: 'center', wordWrap: { width: 280 }
    }).setOrigin(0.5).setAlpha(0);
    this.hintText = this.add.text(160, 440, 'Tap to continue', {
      fontSize: '14px', fontFamily: 'Arial', color: '${secondary}'
    }).setOrigin(0.5).setAlpha(0.6);
    ${hasSpriteAssets ? `
    if (this.textures.exists('sprite_0')) {
      this.sprite = this.add.image(160, 350, 'sprite_0').setDisplaySize(80, 80).setAlpha(0);
    }` : ''}
    this._showPage();
    this.input.on('pointerdown', () => {
      this.page++;
      if (this.page >= this.pages.length) { this.scene.start('EndScene'); return; }
      this._showPage();
    });
  }
  _showPage() {
    const p = this.pages[this.page];
    this.cameras.main.setBackgroundColor(p.bg);
    this.storyText.setText(p.text);
    this.tweens.add({ targets: this.storyText, alpha: 1, y: 200, duration: 600, ease: 'Power2' });
    ${hasSpriteAssets ? `if (this.sprite) this.tweens.add({ targets: this.sprite, alpha: 1, duration: 800 });` : ''}
  }
}

class EndScene extends Phaser.Scene {
  constructor() { super('EndScene'); }
  create() {
    this.cameras.main.setBackgroundColor('${background}');
    this.add.text(160, 180, 'Thank you!', {
      fontSize: '32px', fontFamily: 'Arial', color: '${primary}', fontStyle: 'bold'
    }).setOrigin(0.5);
    const btn = this.add.rectangle(160, 320, 200, 50, ${hexToNum(primary)}, 1).setInteractive();
    this.add.text(160, 320, 'Learn More', {
      fontSize: '20px', fontFamily: 'Arial', color: '#FFFFFF', fontStyle: 'bold'
    }).setOrigin(0.5);
    btn.on('pointerdown', () => { if (window.mraidAction) window.mraidAction(); });
  }
}

window.GAME_CONFIG = {
  type: Phaser.AUTO,
  width: 320,
  height: 480,
  backgroundColor: '${background}',
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: [BootScene, StoryScene, EndScene]
};`;
  }

  // ============================================
  // HTML ASSEMBLY & MRAID WRAPPING
  // ============================================

  /**
   * Build the preview HTML (no MRAID, for iframe preview in the app).
   */
  _buildPreviewHTML(gameCode, inlinedAssets, phaserJs, palette, ctaUrl) {
    const primary = palette.find(c => c.usage === 'primary')?.hex || '#6366F1';
    const background = palette.find(c => c.usage === 'background')?.hex || '#F8FAFC';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>Playable Preview</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;overflow:hidden;background:${background}}
#game-container{width:100vw;height:100vh;display:flex;align-items:center;justify-content:center}
canvas{display:block;max-width:100%;max-height:100%}
</style>
</head>
<body>
<div id="game-container"></div>
<script>${phaserJs}</script>
<script>
window.ASSET_DATA_URIS = ${JSON.stringify(inlinedAssets)};
window.CTA_URL = ${JSON.stringify(ctaUrl || '')};
window.mraidAction = function() {
  if (window.CTA_URL) window.open(window.CTA_URL, '_blank');
};
</script>
<script>
${gameCode}
if (window.GAME_CONFIG) {
  window.GAME_CONFIG.parent = 'game-container';
  new Phaser.Game(window.GAME_CONFIG);
}
</script>
</body>
</html>`;
  }

  /**
   * Wrap game code with MRAID for specific ad network format.
   */
  _wrapWithMRAID(gameCode, inlinedAssets, phaserJs, palette, ctaUrl, format) {
    const background = palette.find(c => c.usage === 'background')?.hex || '#F8FAFC';

    const mraidBridge = this._getMRAIDBridge(format, ctaUrl);
    const metaTags = this._getMRAIDMetaTags(format);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="ad.size" content="width=320,height=480">
${metaTags}
<title>Playable Ad</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;overflow:hidden;background:${background}}
#game-container{width:100vw;height:100vh;display:flex;align-items:center;justify-content:center}
canvas{display:block;max-width:100%;max-height:100%}
</style>
<script src="mraid.js"></script>
</head>
<body>
<div id="game-container"></div>
<script>${phaserJs}</script>
<script>
window.ASSET_DATA_URIS = ${JSON.stringify(inlinedAssets)};
window.CTA_URL = ${JSON.stringify(ctaUrl || '')};
${mraidBridge}
</script>
<script>
${gameCode}

function initGame() {
  if (window.GAME_CONFIG) {
    window.GAME_CONFIG.parent = 'game-container';
    new Phaser.Game(window.GAME_CONFIG);
  }
}
if (typeof mraid !== 'undefined') {
  if (mraid.getState() === 'ready') { initGame(); }
  else { mraid.addEventListener('ready', initGame); }
} else {
  document.addEventListener('DOMContentLoaded', initGame);
}
</script>
</body>
</html>`;
  }

  /**
   * Get MRAID bridge code for the specific format.
   */
  _getMRAIDBridge(format, ctaUrl) {
    switch (format) {
      case 'meta':
        return `window.mraidAction = function() {
  try {
    if (typeof FbPlayableAd !== 'undefined') { FbPlayableAd.onCTAClick(); }
    else if (typeof mraid !== 'undefined') { mraid.open(window.CTA_URL || ''); }
  } catch(e) { console.log('CTA error:', e); }
};`;
      case 'unity':
        return `window.mraidAction = function() {
  try {
    if (typeof mraid !== 'undefined') { mraid.open(window.CTA_URL || ''); }
  } catch(e) { console.log('CTA error:', e); }
};`;
      case 'google':
      default:
        return `window.mraidAction = function() {
  try {
    if (typeof ExitApi !== 'undefined') { ExitApi.exit(); }
    else if (typeof mraid !== 'undefined') { mraid.open(window.CTA_URL || ''); }
  } catch(e) { console.log('CTA error:', e); }
};`;
    }
  }

  /**
   * Get format-specific meta tags.
   */
  _getMRAIDMetaTags(format) {
    switch (format) {
      case 'meta':
        return '<meta name="fb-instant-games-api-version" content="1.0">';
      default:
        return '';
    }
  }

  // ============================================
  // PHASER.JS CACHING
  // ============================================

  /**
   * Get Phaser.js minified source, cached in memory after first download.
   */
  async _getPhaserJs() {
    if (this._phaserJsCache) return this._phaserJsCache;

    try {
      // Try to load from Supabase Storage first
      const { data } = supabaseAdmin.storage.from(STORAGE_BUCKET).getPublicUrl('shared/phaser.min.js');
      if (data?.publicUrl) {
        try {
          const resp = await axios.get(data.publicUrl, { timeout: 15000, responseType: 'text' });
          if (resp.data && resp.data.length > 100000) {
            this._phaserJsCache = resp.data;
            logger.info(`Loaded Phaser.js from storage (${(resp.data.length / 1024).toFixed(0)}KB)`);
            return this._phaserJsCache;
          }
        } catch { /* fall through to CDN */ }
      }
    } catch { /* fall through */ }

    // Download from CDN and cache
    logger.info('Downloading Phaser.js from CDN...');
    const resp = await axios.get(PHASER_CDN_URL, { timeout: 30000, responseType: 'text' });
    this._phaserJsCache = resp.data;
    logger.info(`Downloaded Phaser.js (${(resp.data.length / 1024).toFixed(0)}KB)`);

    // Upload to storage for future use (non-blocking)
    this._uploadToStorage('shared/phaser.min.js', resp.data, 'application/javascript').catch(err => {
      logger.warn(`Failed to cache Phaser.js to storage: ${err.message}`);
    });

    return this._phaserJsCache;
  }

  // ============================================
  // STORAGE
  // ============================================

  /**
   * Upload a file to Supabase Storage and return its public URL.
   */
  async _uploadToStorage(path, content, contentType) {
    const buffer = Buffer.from(content, 'utf8');
    const { error } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .upload(path, buffer, {
        contentType,
        upsert: true
      });

    if (error) {
      logger.error(`Storage upload failed for ${path}: ${error.message}`);
      throw error;
    }

    const { data } = supabaseAdmin.storage.from(STORAGE_BUCKET).getPublicUrl(path);
    return data?.publicUrl || null;
  }

  /**
   * Delete storage files for a playable content item.
   */
  async _deleteStorageFiles(basePath) {
    try {
      const { data: files } = await supabaseAdmin.storage
        .from(STORAGE_BUCKET)
        .list(basePath);

      if (files && files.length > 0) {
        const paths = files.map(f => `${basePath}/${f.name}`);
        await supabaseAdmin.storage.from(STORAGE_BUCKET).remove(paths);
      }
    } catch (err) {
      logger.warn(`Failed to clean up storage at ${basePath}: ${err.message}`);
    }
  }

  // ============================================
  // HELPERS
  // ============================================

  _emitProgress(userId, sessionKey, phase, message, data = {}) {
    testProgressEmitter.emitProgress(userId, sessionKey, phase, message, data);
  }

  /**
   * Delete a playable content item including storage files.
   */
  async deletePlayable(contentId, userId) {
    const record = await getPlayableContentById(contentId, userId);
    if (!record) return null;

    if (record.storage_path) {
      await this._deleteStorageFiles(record.storage_path);
    }

    return dbDeletePlayableContent(contentId, userId);
  }

  /**
   * Get credits balance. Auto-grants 5 free starter credits on first check.
   */
  async getCredits(userId) {
    const credits = await getPlayableContentCredits(userId);

    if (credits.totalRemaining === 0 && credits.packs.length === 0) {
      // First time — auto-grant free starter credits
      try {
        await createPerUsePurchase(userId, {
          purchaseType: 'playable_content_gen',
          amountCents: 0,
          currency: 'usd',
          status: 'completed',
          paymentProvider: 'system',
          creditsTotal: 3,
          creditsUsed: 0,
          idempotencyKey: `playable_starter_credits_${userId}`,
          description: 'Free starter credits for Playable Ads',
          metadata: { auto_granted: true }
        });
        logger.info(`Auto-granted 3 free playable credits for user ${userId}`);
        return getPlayableContentCredits(userId);
      } catch (err) {
        if (err.code === '23505') {
          // Idempotency: already granted, just re-fetch
          return getPlayableContentCredits(userId);
        }
        logger.error(`Failed to auto-grant playable credits: ${err.message}`);
      }
    }

    return credits;
  }

  /**
   * Consume one credit.
   */
  async consumeCredit(userId) {
    return consumePlayableContentCredit(userId);
  }

  /**
   * List user's playable content.
   */
  async listPlayables(userId, filters = {}) {
    return getUserPlayableContent(userId, filters);
  }

  /**
   * Get a single playable by ID.
   */
  async getPlayable(contentId, userId) {
    return getPlayableContentById(contentId, userId);
  }
}

// Singleton
const playableContentService = new PlayableContentService();
export default playableContentService;
