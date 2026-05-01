// services/BrandStoryService.js
// Core orchestrator for Brand Story video series.
// Manages the full lifecycle: storyline generation, episode creation,
// storyboard frame generation, avatar narration, scene video, compositing, and publishing.

import axios from 'axios';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import winston from 'winston';

import {
  createBrandStory,
  getBrandStoryById,
  getBrandStories,
  updateBrandStory,
  deleteBrandStory,
  createBrandStoryEpisode,
  getBrandStoryEpisodes,
  getBrandStoryEpisodeById,
  updateBrandStoryEpisode,
  getMediaTrainingJobById,
  countBrandStories
} from './database.js';

import leonardoService from './LeonardoService.js';
import heyGenService from './HeyGenService.js';
import videoGenerationService from './VideoGenerationService.js';
import klingService from './KlingService.js';
import omniHumanService from './OmniHumanService.js';
import seedanceService from './SeedanceService.js';
import ttsService from './TTSService.js';
import dialogueTTSService from './DialogueTTSService.js';

import {
  getStorylineSystemPrompt,
  getStorylineUserPrompt,
  getEpisodeSystemPrompt,
  getEpisodeUserPrompt,
  getStoryboardPrompt,
  getEpisodeSystemPromptV2,
  getEpisodeUserPromptV2,
  _buildBrandKitContextBlock
} from '../public/components/brandStoryPrompts.mjs';

// V4 imports — pipeline, prompts, helpers
import {
  getEpisodeSystemPromptV4,
  getEpisodeUserPromptV4
} from '../public/components/brandStoryPromptsV4.mjs';
import klingFalService from './KlingFalService.js';
import veoService from './VeoService.js';
import syncLipsyncFalService from './SyncLipsyncFalService.js';
import seedreamFalService from './SeedreamFalService.js';
import fluxFalService from './FluxFalService.js';
import musicService from './MusicService.js';
import BeatRouter, { resolveCostCap } from './BeatRouter.js';
import MontageSequenceGenerator from './beat-generators/MontageSequenceGenerator.js';
import {
  generateSceneMasters,
  buildBeatRefStack,
  extractBeatEndframe,
  SceneMasterFatalError
} from './v4/StoryboardHelpers.js';
import { runQualityGate } from './v4/QualityGate.js';
import { isBlockerOrCritical } from './v4/severity.mjs';
import {
  acquirePersonaVoicesForStory,
  pickFallbackVoiceIdForPersonaInList
} from './v4/VoiceAcquisition.js';
import {
  matchByGenreAndMood,
  resolveEpisodeLut,
  getStrengthForGenreWithStyle,
  getGenreLutPool,
  getDefaultLutForGenre
} from './v4/BrandKitLutMatcher.js';
import { generateSonicSeriesBible } from './v4/SonicSeriesBible.js';
import { deriveCastBibleFromStory } from './v4/CastBible.js';
import {
  runPostProduction,
  estimateEpisodeDuration
} from './v4/PostProduction.js';
import { getOrCreateProgressEmitter } from './v4/ProgressEmitter.js';
import { generateLutFromBrandKit, generateStoryTrimLut } from './v4/GenerativeLut.js';
import {
  isEnabled as isCharacterSheetDirectorEnabled,
  generateAllVariants as csdGenerateAllVariants,
  CHARACTER_BODY_ANGLES,
  composeAngleVariantPrompt,
  buildDetailMacroPrompts
} from './v4/CharacterSheetDirector.js';
import {
  extractPersonaVisualAnchor,
  cacheKey as visualAnchorCacheKey,
  VisualAnchorInversionError
} from './v4/PersonaVisualAnchor.js';
import {
  generateCommercialBrief,
  resolveCommercialEpisodeCount,
  isCommercialGenre,
  isCommercialPipelineEnabled,
  isStylizedStrong,
  isNonPhotorealStyle,
  resolveStyleCategory
} from './v4/CreativeBriefDirector.js';
import {
  validateHintAgainstGenre,
  renderCoherenceOverrideBlock
} from './v4/DirectorsHintCoherence.js';
import { validateScreenplay } from './v4/ScreenplayValidator.js';
import { punchUpScreenplay } from './v4/ScreenplayDoctor.js';
import { parseGeminiJson } from './v4/GeminiJsonRepair.js';
import {
  DirectorAgent,
  CHECKPOINTS as DIRECTOR_CHECKPOINTS,
  resolveDirectorMode,
  DirectorBlockingHaltError
} from './v4/DirectorAgent.js';
import { decideRetry as decideDirectorRetry } from './v4/DirectorRetryPolicy.js';
import {
  callVertexGeminiJson,
  callVertexGeminiText,
  callVertexGeminiRaw,
  isVertexGeminiConfigured
} from './v4/VertexGemini.js';
import { formatReferenceLibraryForPrompt } from './v4/director-rubrics/commercialReferenceLibrary.mjs';
import { buildGenreRegisterHint } from './v4/director-rubrics/sharedHeader.mjs';

import Replicate from 'replicate';

const execFileAsync = promisify(execFile);

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[BrandStoryService] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent';

class BrandStoryService {
  constructor() {
    // this.googleApiKey is ONLY used by the v1 legacy path (generateNextEpisode)
    // and the v2/v3 _generateCinematicEpisode helper. V4 uses Vertex AI Gemini
    // via services/v4/VertexGemini.js (GCP service-account auth, not an API key).
    this.googleApiKey = process.env.GOOGLE_AI_STUDIO_API_KEY;

    if (!this.googleApiKey) {
      logger.warn('GOOGLE_AI_STUDIO_API_KEY not set — legacy v1/v2 paths unavailable (V4 uses Vertex AI)');
    }
  }

  // ═══════════════════════════════════════════════════
  // STORY CRUD
  // ═══════════════════════════════════════════════════

  /**
   * Create a new brand story.
   * @param {string} userId
   * @param {Object} config - { name, persona_type, persona_config, subject, brand_kit_job_id, target_platforms, publish_frequency }
   * @returns {Promise<Object>} The created story record
   */
  async createStory(userId, config) {
    // Validate Brand Kit exists if referenced
    if (config.brand_kit_job_id) {
      const job = await getMediaTrainingJobById(config.brand_kit_job_id, userId);
      if (!job) throw new Error('Referenced Brand Kit job not found');
      if (!job.brand_kit) throw new Error('Brand Kit has not been analyzed yet — run brand kit analysis first');
    }

    const story = await createBrandStory(userId, config);
    logger.info(`Brand story created: ${story.id} (${config.name}) for user ${userId}`);
    return story;
  }

  /**
   * Get all stories for a user.
   */
  async getStories(userId) {
    return getBrandStories(userId);
  }

  /**
   * Get a story by ID with its episodes.
   */
  async getStoryWithEpisodes(storyId, userId) {
    const story = await getBrandStoryById(storyId, userId);
    if (!story) return null;

    const episodes = await getBrandStoryEpisodes(storyId, userId);
    return { ...story, episodes };
  }

  /**
   * Update a story.
   */
  async updateStory(storyId, userId, updates) {
    return updateBrandStory(storyId, userId, updates);
  }

  /**
   * Delete a story and all its episodes.
   */
  async deleteStory(storyId, userId) {
    return deleteBrandStory(storyId, userId);
  }

  /**
   * Count stories for a user.
   */
  async countStories(userId) {
    return countBrandStories(userId);
  }

  // ═══════════════════════════════════════════════════
  // SUBJECT ANALYSIS (Gemini 3 Flash Vision)
  // ═══════════════════════════════════════════════════

  /**
   * Analyze 1-3 images of a subject/product and produce a structured subject description.
   * Optionally leverages Brand Kit context for richer analysis.
   *
   * @param {Object} params
   * @param {Array<{ data: Buffer, mimeType: string }|string>} params.images - Image buffers or URLs (1-3)
   * @param {Object} [params.brandKit] - Optional brand kit data for context
   * @returns {Promise<Object>} Structured subject: { name, category, description, key_features, visual_description }
   */
  async analyzeSubject({ images, brandKit = null, storyFocus = 'product' }) {
    // V4 uses Vertex AI Gemini (not AI Studio). Subject analysis is shared
    // with the V4 pipeline, so it needs Vertex credentials.
    if (!isVertexGeminiConfigured()) {
      throw new Error('Vertex Gemini not configured — set GCP_PROJECT_ID and GOOGLE_APPLICATION_CREDENTIALS_JSON (or ADC)');
    }
    if (!images || images.length === 0) throw new Error('At least one image is required');
    if (images.length > 3) throw new Error('Maximum 3 images allowed');

    logger.info(`Analyzing subject from ${images.length} image(s) (focus=${storyFocus})${brandKit ? ' with Brand Kit context' : ''}`);

    // Normalize images to { inlineData: { mimeType, data: base64 } }
    const imageParts = [];
    for (const img of images) {
      if (typeof img === 'string') {
        // URL — download
        const resp = await axios.get(img, {
          responseType: 'arraybuffer',
          timeout: 15000,
          headers: { 'User-Agent': 'NewsAgentSaaS/1.0' }
        });
        const contentType = resp.headers['content-type'] || '';
        let mimeType = 'image/jpeg';
        if (contentType.includes('png')) mimeType = 'image/png';
        else if (contentType.includes('webp')) mimeType = 'image/webp';
        imageParts.push({
          inlineData: { mimeType, data: Buffer.from(resp.data).toString('base64') }
        });
      } else {
        // Buffer + mimeType object
        imageParts.push({
          inlineData: { mimeType: img.mimeType, data: img.data.toString('base64') }
        });
      }
    }

    // Build optional Brand Kit context block
    const brandContext = brandKit ? `
BRAND KIT CONTEXT (use this to inform your analysis):
- Brand summary: ${brandKit.brand_summary || 'N/A'}
- Overall aesthetic: ${brandKit.style_characteristics?.overall_aesthetic || 'N/A'}
- Mood: ${brandKit.style_characteristics?.mood || 'N/A'}
- Visual motifs: ${brandKit.style_characteristics?.visual_motifs || 'N/A'}
- Brand colors: ${(brandKit.color_palette || []).slice(0, 5).map(c => c.hex || c.name).join(', ')}
` : '';

    // Focus-specific integration guidance — teaches Gemini HOW the subject should
    // appear in scenes. Phase 4 rewrite (2026-04-27): the product brief is rewritten
    // away from "IS the hero" framing toward Hollywood naturalistic-placement
    // grammar (Reese's Pieces in E.T., Aston Martin in Bond, MacBook in The Social
    // Network). The product is a side-actor / well-placed prop that lives inside
    // a real character story — not the centerpiece. The actual integration depth
    // is governed at the screenplay layer by `product_integration_style`
    // (naturalistic_placement | hero_showcase | incidental_prop | genre_invisible).
    const focusIntegrationBrief = {
      person:    'This is a PERSON-focus story. The uploaded subject is something the person interacts with, wears, owns, or relates to. It should appear naturally in their hands, on their body, in their environment — as an extension of who they are.',
      product:   'This is a PRODUCT-focus story, told as a CHARACTER STORY featuring this subject. The product is a naturalistic prop — characters USE it as part of their lives, never to demonstrate it. Think Hollywood-grade product placement: Reese\'s Pieces in E.T. (Elliott\'s hand, no dialogue describing the candy), MacBook in The Social Network (Zuckerberg coding, the laptop is just present), Aston Martin in Bond (driven, not described). The product participates in the story; the story is not about the product. It does NOT need to appear in every beat.',
      landscape: 'This is a LANDSCAPE / PLACE-focus story. The uploaded subject is the SETTING. Characters walk THROUGH it, sit IN it, gaze AT it, inhabit it. It can be a background, an environment the camera explores, an interior that frames the action, or the destination the story arrives at.'
    }[storyFocus] || 'Integrate naturally into the visual narrative.';

    const prompt = `You are a product/subject analyst for a brand storytelling platform. Analyze these ${imageParts.length} image(s) of a subject and produce a structured description that will drive an automated video story series.

${focusIntegrationBrief}
${brandContext}
Your analysis must identify:
1. What the subject IS (name the specific product/object/place — be precise, not generic)
2. Its category (e.g., "Luxury fragrance", "Waterfront villa", "Custom jewelry", "Boutique hotel")
3. A compelling description (2-3 sentences capturing its essence, materials, craftsmanship, atmosphere)
4. Key features (3-5 distinguishing characteristics)
5. Visual description (detailed physical description suitable for image/video generation prompts — materials, colors, textures, shape, packaging, lighting, context)
6. Integration guidance (3-5 concrete suggestions for HOW this subject should appear in short-form video episodes, in a natural narrative way — treat it like TV-series product placement)

Return ONLY valid JSON (no markdown fences, no extra text) in this exact structure:
{
  "name": "Specific product/place name or descriptor",
  "category": "Category/type",
  "description": "2-3 sentence compelling description",
  "key_features": ["Feature 1", "Feature 2", "Feature 3"],
  "visual_description": "Detailed visual description for image generation",
  "integration_guidance": [
    "Concrete scene suggestion 1 (e.g., 'held in the protagonist\\'s hand during a quiet moment')",
    "Concrete scene suggestion 2 (e.g., 'displayed on the marble countertop in the opening shot')",
    "Concrete scene suggestion 3 (e.g., 'reflected in a window during the reveal')"
  ]
}

Be SPECIFIC and EVOCATIVE. Avoid vague language. For a perfume: describe the bottle shape, cap finish, liquid color. For real estate: architectural style, materials, surroundings, interior mood. For jewelry: stones, metalwork, setting. For integration_guidance, write suggestions that a director could actually stage on camera.`;

    const parts = [...imageParts, { text: prompt }];

    // Call Vertex Gemini with the multimodal contents (image parts + text).
    // Uses callVertexGeminiText (not callVertexGeminiJson) because we need
    // custom parsing below that strips code fences + unwraps arrays.
    // Token budget: 8192 (was 2000). Gemini 3 Flash thinking tokens + a
    // multi-field JSON response need headroom; 2000 was borderline.
    // See Day 0 2026-04-11 fix notes in services/v4/VoiceAcquisition.js.
    const rawText = (await callVertexGeminiText({
      systemPrompt: '', // subject analysis pushes everything into the user contents
      contents: [{ role: 'user', parts }],
      config: {
        temperature: 0.4,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json'
      },
      timeoutMs: 90000
    }))?.trim();

    if (!rawText) throw new Error('Subject analysis returned empty response');

    let subject;
    try {
      subject = this._parseGeminiJson(rawText);
    } catch (parseError) {
      logger.error(`Failed to parse subject analysis JSON: ${rawText.slice(0, 200)}`);
      throw new Error('Subject analysis returned invalid JSON');
    }

    logger.info(`Subject analyzed: "${subject.name}" (${subject.category})`);
    return subject;
  }

  // ═══════════════════════════════════════════════════
  // STORYLINE GENERATION (Gemini 3 Flash)
  // ═══════════════════════════════════════════════════

  /**
   * Generate a full storyline / season bible for a brand story using Gemini.
   * Reads the Brand Kit data and creates a narrative framework.
   *
   * @param {string} storyId
   * @param {string} userId
   * @returns {Promise<Object>} The updated story with storyline
   */
  async generateStoryline(storyId, userId) {
    // V4 uses Vertex AI Gemini (not AI Studio).
    if (!isVertexGeminiConfigured()) {
      throw new Error('Vertex Gemini not configured — set GCP_PROJECT_ID and GOOGLE_APPLICATION_CREDENTIALS_JSON (or ADC)');
    }

    const story = await getBrandStoryById(storyId, userId);
    if (!story) throw new Error('Story not found');

    logger.info(`Generating storyline for story ${storyId}: "${story.name}"`);

    // Load Brand Kit data if referenced
    let brandKit = {};
    if (story.brand_kit_job_id) {
      const job = await getMediaTrainingJobById(story.brand_kit_job_id, userId);
      if (job?.brand_kit) {
        brandKit = job.brand_kit;
      }
    }

    // Build prompts — pass the full personas array (up to 3)
    const personas = Array.isArray(story.persona_config?.personas)
      ? story.persona_config.personas
      : [story.persona_config]; // legacy fallback

    // V4 Wave 6 / hotfix-2026-04-29 #2 — extract visual_anchor BEFORE the
    // storyline user prompt is built. The persona block at
    // brandStoryPrompts.mjs:413-424 reads `p.visual_anchor` to render the
    // "Visual identity (ground truth, vision-grounded): ..." line. Without
    // an extracted anchor, the renderer emits "DESCRIPTION_MISSING — escalate
    // to user_review" — which Gemini interprets as a directive to NOT
    // generate. Symptom from logs (2026-04-29 story `fcb0b42b`): title=
    // undefined, 0 episodes planned, empty story bible.
    //
    // The hotfix-2026-04-29 fix #1 hoisted extraction into _autoSetupAvatar,
    // but _autoSetupAvatar runs AFTER generateStoryline. This hoist places
    // it earlier still — at the very start of the storyline pipeline — so
    // the prompt sees the anchor.
    //
    // Idempotent: skips personas whose anchor matches the current photo set
    // (vision_call_id check). For described personas (no photos), no
    // extraction runs and the renderer falls back to text fields (see the
    // updated persona block in brandStoryPrompts.mjs).
    try {
      await this._ensureVisualAnchorsForPersonas(storyId, userId, story, personas);
    } catch (err) {
      // Inversion-class extraction failures are user-review escalations.
      // Bubble up so the route handler returns a 400-class error instead of
      // silently shipping a doomed storyline.
      if (err && /inversion/i.test(err.message)) throw err;
      // Other extraction failures (network, transient Vertex error) — log
      // and proceed. The renderer's text-field fallback below catches the
      // missing-anchor case so the storyline can still generate.
      logger.warn(`generateStoryline: visual_anchor extraction failed (${err.message}) — proceeding with text-field fallback`);
    }

    // Pipeline-aware storyline prompts — V4 needs different episode-grammar
    // anchors (60-120s, 5-12 beats, on-camera dialogue) than legacy v1/v2/v3
    // (10-15s narration). Mirrors the same env-var that runEpisodePipeline
    // routes on at line ~1813. See .claude/plans/regarding-this-infrastructure-i-magical-flame.md
    const storylinePipelineVersion = process.env.BRAND_STORY_PIPELINE === 'v4' ? 'v4' : 'v3';

    // ─── Phase 6 (2026-04-28 reorder) — COMMERCIAL pre-flight: brief BEFORE storyline ───
    //
    // Original Phase 6 design ran CreativeBriefDirector inside runV4Pipeline,
    // AFTER the storyline was already locked. That meant the storyline writer
    // never saw the creative_concept, visual_signature, narrative_grammar,
    // music_intent, hero_image, brand_world_lock, anti_brief, or style_category.
    // The brief was generated and persisted but its directorial vision never
    // reached the screenplay layer. Result: incoherent commercials.
    //
    // The brief now runs HERE — before storyline — so it can shape the
    // storyline (and through the storyline, every downstream stage).
    // Idempotent: skipped when story.commercial_brief already exists.
    let commercialBrief = story.commercial_brief || null;
    if (!commercialBrief && isCommercialGenre(story) && isCommercialPipelineEnabled()) {
      logger.info('commercial genre detected — running CreativeBriefDirector pre-flight (before storyline)');
      try {
        commercialBrief = await generateCommercialBrief({
          story,
          brandKit,
          personas
        });
        const { count: briefCount, reasoning: briefReasoning } = resolveCommercialEpisodeCount(commercialBrief);
        logger.info(`commercial brief: concept="${(commercialBrief.creative_concept || '').slice(0, 60)}" style=${commercialBrief.style_category} episodes=${briefCount}`);

        // V4 Phase 7 / B1 — Lens 0/A. Validate the brief BEFORE the screenplay
        // writer is invoked. Soft_reject → ONE re-run of the brief with the
        // director's nudge (mirroring the Phase 5 nudge contract). Hard_reject
        // → halt + escalate (storyline never runs; user_review required).
        // This is the first gate where bad creative direction can be caught
        // before screenplay tokens are spent.
        const briefMode = resolveDirectorMode(DIRECTOR_CHECKPOINTS.COMMERCIAL_BRIEF);
        if (briefMode !== 'off' && isVertexGeminiConfigured()) {
          try {
            const briefDirector = new DirectorAgent();
            const briefVerdict = await briefDirector.judgeCommercialBrief({
              creativeBrief: commercialBrief,
              story,
              brandKit
            });
            const verdictKind = briefVerdict?.verdict || 'pass';
            logger.info(`Lens 0/A commercial-brief verdict: ${verdictKind} (score=${briefVerdict?.overall_score ?? 'n/a'}, mode=${briefMode})`);

            if (briefMode === 'blocking' && verdictKind === 'hard_reject') {
              // Halt + escalate (BLOCKING ONLY). Storyline must not run on a
              // hard_rejected brief in blocking mode.
              // Advisory mode: log the hard_reject for the panel but proceed
              // with the rejected brief — the user sees the verdict and decides
              // whether to ship downstream.
              await updateBrandStory(storyId, userId, {
                status: 'awaiting_user_review',
                commercial_brief: commercialBrief,
                commercial_brief_verdict: briefVerdict
              });
              throw new DirectorBlockingHaltError(
                `Lens 0/A hard_reject on commercial brief: ${briefVerdict?.findings?.[0]?.message || 'see verdict'}`
              );
            }

            // V4 hotfix 2026-04-30 — Advisory mode now also auto-retries on
            // soft_reject (parity with blocking on the AUTO-RETRY axis; differs
            // only on the HALT axis). The check below was previously
            // `briefMode === 'blocking'`; expanded to include 'advisory' so
            // self-improving behavior runs even when the user opted out of
            // halts.
            if ((briefMode === 'blocking' || briefMode === 'advisory') && verdictKind === 'soft_reject' && briefVerdict?.retry_authorization === true) {
              // ONE re-run with the director's nudge spliced in. The findings
              // become an additional STORY_DIRECTOR_NUDGE block on the brief
              // generator's user prompt — mirroring the Phase 5 nudge contract.
              const nudge = (briefVerdict.findings || [])
                .map(f => `- ${f.severity}: ${f.message} → ${f?.remediation?.prompt_delta || ''}`)
                .filter(Boolean)
                .join('\n');
              logger.info(`Lens 0/A soft_reject — re-running brief with director's nudge (${(briefVerdict.findings || []).length} findings)`);
              try {
                commercialBrief = await generateCommercialBrief({
                  story,
                  brandKit,
                  personas,
                  directorNudge: nudge,
                  isRetry: true
                });
                logger.info(`brief re-run complete: concept="${(commercialBrief.creative_concept || '').slice(0, 60)}" style=${commercialBrief.style_category}`);
              } catch (retryErr) {
                logger.warn(`brief re-run failed (${retryErr.message}) — using original brief`);
              }
            }

            // Persist the verdict regardless of outcome (audit trail) under
            // commercial_brief_verdict. Used by Director Panel + telemetry.
            commercialBrief.__verdict = briefVerdict;
          } catch (verdictErr) {
            if (verdictErr instanceof DirectorBlockingHaltError) throw verdictErr;
            logger.warn(`Lens 0/A commercial-brief verdict failed (${verdictErr.message}) — proceeding without brief validation`);
          }
        }

        await updateBrandStory(storyId, userId, {
          commercial_brief: commercialBrief,
          product_integration_style: 'commercial',
          commercial_episode_count: briefCount,
          commercial_episode_reasoning: briefReasoning
        });
        story.commercial_brief = commercialBrief;
        story.product_integration_style = 'commercial';
        story.commercial_episode_count = briefCount;
        story.commercial_episode_reasoning = briefReasoning;
      } catch (err) {
        if (err instanceof DirectorBlockingHaltError) throw err;
        logger.warn(`commercial brief failed (${err.message}) — storyline will run without brief context`);
      }
    }

    // V4 Phase 5b — Fix 5. Director's Hint genre-coherence check. Score the
    // hint against the active genre register on the five universal craft axes.
    // When register_distance > 0.5 OR verdict is antagonistic (and the user
    // hasn't explicitly opted in), splice a GENRE-OVERRIDE NOTE block into
    // the storyline system prompt so Gemini honors the genre register over
    // the conflicting hint. User opt-in (story.subject.directors_hint_user_override
    // === true) skips the dampening.
    const directorsNotes = story.subject?.directors_notes || '';
    const directorsHintUserOverride = !!story.subject?.directors_hint_user_override;
    let directorsHintVerdict = null;
    let directorsHintOverrideBlock = '';
    if (directorsNotes && !directorsHintUserOverride) {
      try {
        directorsHintVerdict = await validateHintAgainstGenre({
          hint: directorsNotes,
          genre: story.subject?.genre || 'drama'
        });
        if (!directorsHintVerdict.ok) {
          logger.warn(
            `director's hint conflicts with genre register: ` +
            `distance=${directorsHintVerdict.register_distance.toFixed(2)}, ` +
            `axes=[${directorsHintVerdict.conflicting_axes.join(', ')}], ` +
            `verdict=${directorsHintVerdict.overall_verdict}. Splicing GENRE-OVERRIDE NOTE.`
          );
          directorsHintOverrideBlock = renderCoherenceOverrideBlock(directorsHintVerdict);
        }
      } catch (err) {
        logger.warn(`director's hint coherence check threw (${err.message}) — proceeding without dampening`);
      }
    }

    const systemPrompt = getStorylineSystemPrompt(brandKit, {
      directorsNotes,
      pipelineVersion: storylinePipelineVersion,
      commercialBrief,
      // V4 Phase 5b — pass the override block so the system prompt can render
      // it above the hint block when register-distance is too high. Empty
      // string when the hint is compatible OR the user explicitly opted in.
      directorsHintOverrideBlock
    });
    const userPrompt = getStorylineUserPrompt(
      personas,
      story.subject,
      brandKit,
      {
        tone: story.subject?.tone || 'engaging',
        genre: story.subject?.genre || 'drama',
        targetAudience: story.subject?.target_audience || 'young professionals',
        storyFocus: story.story_focus || 'product',
        directorsNotes: story.subject?.directors_notes || '',
        pipelineVersion: storylinePipelineVersion,
        commercialBrief
      }
    );

    // Call Vertex AI Gemini (V4 uses Vertex, not AI Studio).
    // Using callVertexGeminiRaw so we can inspect finishReason for
    // MAX_TOKENS truncation detection below.
    const vertexResponse = await callVertexGeminiRaw({
      systemPrompt,
      userPrompt,
      config: {
        maxOutputTokens: 32000,
        temperature: 0.85,
        responseMimeType: 'application/json'
      },
      timeoutMs: 120000
    });

    const candidate = vertexResponse?.candidates?.[0];
    const rawText = candidate?.content?.parts?.[0]?.text?.trim();
    const finishReason = candidate?.finishReason;

    if (!rawText) {
      logger.error(`Gemini returned empty storyline — finishReason: ${finishReason}`);
      throw new Error('Storyline generation returned empty response');
    }

    if (finishReason === 'MAX_TOKENS') {
      logger.error(`Storyline hit MAX_TOKENS (${rawText.length} chars generated) — response truncated`);
      throw new Error('Storyline exceeded token limit — try shorter inputs or regenerate');
    }

    // Parse the JSON response (with defensive repair for Gemini's occasional trailing chars)
    let storyline;
    try {
      storyline = this._parseGeminiJson(rawText);
    } catch (parseError) {
      logger.error(`Failed to parse storyline JSON (finishReason: ${finishReason}, length: ${rawText.length})`);
      logger.error(`First 500 chars: ${rawText.slice(0, 500)}`);
      logger.error(`Last 300 chars: ...${rawText.slice(-300)}`);
      throw new Error('Storyline generation returned invalid JSON');
    }

    // ─── Server-side safety net: clamp commercial-genre episode count ───
    //
    // Phase 6 (2026-04-28). The storyline prompt now teaches Gemini to cap
    // commercial at 1-2 (see brandStoryPrompts.mjs `commercialCapNote`). If
    // Gemini ignores that — emits 3+ episodes anyway — we trim here. The
    // dependent arrays (emotional_arc, antagonist_curve, subplots.episodes_active)
    // are also trimmed to stay consistent with the new episode count.
    const isCommercialStory = String(story.subject?.genre || story.storyline?.genre || '').toLowerCase().trim() === 'commercial';
    if (isCommercialStory && Array.isArray(storyline.episodes) && storyline.episodes.length > 2) {
      const before = storyline.episodes.length;
      storyline.episodes = storyline.episodes.slice(0, 2);
      if (Array.isArray(storyline.emotional_arc)) {
        storyline.emotional_arc = storyline.emotional_arc.filter(e => (e?.episode || 0) <= 2);
      }
      if (Array.isArray(storyline.antagonist_curve)) {
        storyline.antagonist_curve = storyline.antagonist_curve.filter(e => (e?.episode || 0) <= 2);
      }
      if (Array.isArray(storyline.subplots)) {
        storyline.subplots = storyline.subplots.map(s => ({
          ...s,
          episodes_active: Array.isArray(s.episodes_active) ? s.episodes_active.filter(n => n <= 2) : s.episodes_active
        }));
      }
      logger.warn(`commercial storyline emitted ${before} episodes — clamped to 2 (HARD CAP)`);
    }

    // ─── Server-side safety net: enforce prestige episode-count floor ───
    //
    // Regression repair (2026-04-29). Symmetric defense-in-depth to the
    // commercial clamp above. The storyline prompt now carries an explicit
    // FLOOR directive (`prestigeCountNote` in brandStoryPrompts.mjs) telling
    // Gemini that prestige seasons must contain at least 3 episodes. If
    // Gemini ignores it and emits 1 or 2 episodes (root cause: thin persona
    // canvas after the Phase 5b subtractive change starved the SHOWRUNNING
    // soft-override), we reject the storyline so the caller can re-generate
    // with adjusted inputs instead of silently shipping a broken season
    // bible.
    //
    // Asymmetric to commercial: for commercial, over-emission is trimmable
    // (drop excess episodes). For prestige, under-emission cannot be padded
    // (you cannot invent narrative purpose from nothing) — the only safe
    // move is to reject and force a retry. The error message names the
    // likely root cause so the user knows what to enrich.
    const PRESTIGE_EPISODE_FLOOR = 3;
    if (!isCommercialStory && Array.isArray(storyline.episodes) && storyline.episodes.length < PRESTIGE_EPISODE_FLOOR) {
      const got = storyline.episodes.length;
      const detectedGenre = story.subject?.genre || storyline.genre || 'prestige';
      logger.error(
        `prestige storyline emitted only ${got} episode${got === 1 ? '' : 's'} — ` +
        `floor is ${PRESTIGE_EPISODE_FLOOR} (genre=${detectedGenre}). Likely cause: ` +
        `thin persona/subject material starved the SHOWRUNNING soft-override. ` +
        `Enrich persona.description / persona.appearance / subject.description and re-generate.`
      );
      throw new Error(
        `Storyline returned ${got} episode${got === 1 ? '' : 's'} for a ${detectedGenre} story; ` +
        `the prestige floor is ${PRESTIGE_EPISODE_FLOOR}. Re-generate, ideally with a richer ` +
        `persona description so Gemini has more narrative material to expand into a full season.`
      );
    }

    logger.info(`Storyline generated: "${storyline.title}" — ${storyline.episodes?.length || 0} episodes planned${isCommercialStory ? ' (commercial)' : ''}`);

    // Save to database
    const updated = await updateBrandStory(storyId, userId, { storyline });

    // Kick off avatar setup in the background (non-blocking).
    // Users can review the storyline while the avatar trains.
    this._autoSetupAvatar(storyId, userId).catch(err =>
      logger.error(`Auto avatar setup failed for ${storyId}: ${err.message}`)
    );

    return updated;
  }

  /**
   * Automatically set up the HeyGen avatar for each persona in a story.
   * Uses HeyGen's talking_photo upload (no training needed — works instantly,
   * supports Avatar IV motion engine, and accepts both real and AI-generated faces).
   *
   * Flow per persona_type:
   *   - 'selected': persona already has heygen_avatar_id from stock picker. Just record it.
   *   - 'uploaded': uploadTalkingPhoto(first uploaded image) → talking_photo_id.
   *   - 'brand_kit': uploadTalkingPhoto(cutout_url) → talking_photo_id.
   *   - 'described': Leonardo generates 1 headshot → uploadTalkingPhoto → talking_photo_id.
   *
   * Each persona gets its OWN talking_photo_id stored in persona_config.personas[i].
   */
  async _autoSetupAvatar(storyId, userId) {
    const story = await getBrandStoryById(storyId, userId);
    if (!story) return;

    const personas = Array.isArray(story.persona_config?.personas)
      ? story.persona_config.personas
      : [story.persona_config];

    logger.info(`[V3] Avatar setup for story ${storyId} (persona_type=${story.persona_type}, ${personas.length} persona(s))`);

    try {
      await updateBrandStory(storyId, userId, {
        persona_config: { ...(story.persona_config || {}), training_status: 'generating_persona_image' }
      });

      let workingPersonas = [...personas];

      // V4 Wave 6 / hotfix-2026-04-29 — extract visual_anchor BEFORE the
      // character-sheet loop. Until now this lived only in runV4Pipeline Step 0b,
      // which fires at /generate-episode time — much later than the Flux 2 Max
      // call below. Without an anchor at this point, CharacterSheetDirector's
      // HARD CONSTRAINT block + post-emission inversion check are silent
      // no-ops; Gemini fabricates from sparse text fields and Flux follows the
      // prompt over the photo refs. Symptom from production logs (story
      // `fcb0b42b` 2026-04-29): female upload → male character sheet every time.
      //
      // Idempotent — _ensureVisualAnchorsForPersonas skips personas whose
      // existing anchor matches the current photo set (vision_call_id check).
      // The Step 0b backfill in runV4Pipeline still runs and is now defense-
      // in-depth for legacy stories that were created before this fix.
      await this._ensureVisualAnchorsForPersonas(storyId, userId, story, workingPersonas);

      for (let i = 0; i < workingPersonas.length; i++) {
        const p = workingPersonas[i];

        // brand_kit_auto already has a full character sheet from generatePersonaFromBrandKit()
        if (story.persona_type === 'brand_kit_auto' && p.reference_image_urls?.length >= 3) {
          logger.info(`[P${i + 1}] brand_kit_auto already has ${p.reference_image_urls.length} refs — skipping character sheet`);
          continue;
        }

        // Generate character sheet (3 views: hero, closeup, side) via Flux 2 Max
        workingPersonas[i] = await this._generateCharacterSheet(p, i, story, userId);
      }

      const configuredCount = workingPersonas.filter(p =>
        p.reference_image_urls?.length > 0 || p.omnihuman_seed_image_url
      ).length;

      await updateBrandStory(storyId, userId, {
        persona_config: {
          ...(story.persona_config || {}),
          personas: workingPersonas,
          training_status: configuredCount > 0 ? 'completed' : 'failed'
        }
      });

      logger.info(`[V3] Avatar setup complete: ${configuredCount}/${workingPersonas.length} personas with character sheets`);
    } catch (err) {
      logger.error(`[V3] Avatar setup error for story ${storyId}: ${err.message}`);
      const fresh = await getBrandStoryById(storyId, userId);
      if (fresh) {
        await updateBrandStory(storyId, userId, {
          persona_config: {
            ...(fresh.persona_config || {}),
            training_status: 'failed',
            training_error: err.message
          }
        });
      }
    }
  }

  /**
   * V4 Wave 6 / hotfix-2026-04-29 — extracted from runV4Pipeline Step 0b.
   *
   * Extract a vision-grounded `visual_anchor` for every persona that has
   * reference photos but no anchor (or whose anchor doesn't match the current
   * photo set per its vision_call_id cache key). Mutates `personas` in place +
   * persists the persona_config back to the story row.
   *
   * Two consumers:
   *   1. _autoSetupAvatar (BEFORE character-sheet generation) — the load-
   *      bearing call. CharacterSheetDirector's HARD CONSTRAINT block reads
   *      persona.visual_anchor; without it, Gemini fabricates and Flux 2 Max
   *      follows the fabrication over the photo refs.
   *   2. runV4Pipeline Step 0b (BEFORE voice acquisition) — defense-in-depth
   *      for legacy stories that were created before the hotfix-2026-04-29
   *      ordering fix. Idempotent: skipped when the anchor already matches.
   *
   * Idempotency: skipped per-persona when the anchor's vision_call_id (sha256
   * of sorted photo URLs) already matches the current photos[].
   *
   * Inversion-class extraction failures (gender/age inversion detected at
   * extraction time — extremely rare, defense-in-depth) throw upward so the
   * caller can mark the story awaiting_user_review. Other failures are logged
   * and the persona proceeds without anchor (text-only fallback).
   *
   * @param {string} storyId
   * @param {string} userId
   * @param {Object} story         - the loaded story row (used for persona_type defaults)
   * @param {Object[]} personas    - persona_config.personas[] — mutated in place
   * @returns {Promise<{ extracted: number, lowConfidence: number, inversionEscalated: boolean }>}
   */
  async _ensureVisualAnchorsForPersonas(storyId, userId, story, personas) {
    let extracted = 0;
    let lowConfidence = 0;
    let inversionEscalated = false;
    const inversionDetails = [];

    for (const p of personas) {
      const photos = Array.isArray(p?.reference_image_urls) ? p.reference_image_urls.filter(Boolean) : [];
      if (photos.length === 0) continue; // no photos → anchor not extractable here

      // Skip if anchor already matches the current photo set.
      if (p.visual_anchor?.apparent_gender_presentation && p.visual_anchor?.vision_call_id) {
        const expectedCallId = visualAnchorCacheKey(photos);
        if (expectedCallId === p.visual_anchor.vision_call_id) continue;
      }

      try {
        const source = (p.persona_type === 'brand_kit_auto' || p.is_auto_generated) ? 'sheet_vision' : 'upload_vision';
        logger.info(`[visual_anchor] extracting for "${p.name || 'unnamed'}" (${photos.length} photo${photos.length === 1 ? '' : 's'}, source=${source})`);
        const anchor = await extractPersonaVisualAnchor({
          photoUrls: photos,
          persona: p,
          source,
          existingAnchor: p.visual_anchor || null
        });
        p.visual_anchor = anchor;
        extracted++;
        if (anchor.vision_confidence < 0.5) {
          lowConfidence++;
          inversionDetails.push({
            persona: p.name || 'unnamed',
            confidence: anchor.vision_confidence,
            low_confidence_fields: anchor.low_confidence_fields
          });
        }
      } catch (err) {
        if (err instanceof VisualAnchorInversionError) {
          inversionEscalated = true;
          inversionDetails.push({ persona: p.name || 'unnamed', error: err.message });
          logger.error(`[visual_anchor] inversion-escalation for "${p.name || 'unnamed'}": ${err.message}`);
        } else {
          logger.warn(`[visual_anchor] extraction failed for "${p.name || 'unnamed'}" (${err.message}) — proceeding without anchor (text-only fallback)`);
        }
      }
    }

    if (extracted > 0) {
      await updateBrandStory(storyId, userId, {
        persona_config: { ...(story.persona_config || {}), personas }
      });
      logger.info(`[visual_anchor] ${extracted} persona(s) anchored${lowConfidence > 0 ? ` — ${lowConfidence} low-confidence` : ''}`);
    }

    if (inversionEscalated) {
      throw new Error(
        `visual_anchor inversion(s) detected — escalating to user_review. ` +
        `Details: ${JSON.stringify(inversionDetails)}`
      );
    }

    return { extracted, lowConfidence, inversionEscalated };
  }

  // ═══════════════════════════════════════════════════
  // EPISODE GENERATION (next scene)
  // ═══════════════════════════════════════════════════

  /**
   * Generate the next episode's scene description using Gemini.
   * Reads the storyline + all previous episodes for continuity.
   *
   * @param {string} storyId
   * @param {string} userId
   * @returns {Promise<Object>} The created episode record
   */
  async generateNextEpisode(storyId, userId) {
    if (!this.googleApiKey) throw new Error('GOOGLE_AI_STUDIO_API_KEY is required');

    const story = await getBrandStoryById(storyId, userId);
    if (!story) throw new Error('Story not found');
    if (!story.storyline) throw new Error('Story has no storyline — generate one first');

    // Get all previous episodes
    const previousEpisodes = await getBrandStoryEpisodes(storyId, userId);
    const episodeNumber = previousEpisodes.length + 1;

    logger.info(`Generating episode ${episodeNumber} for story "${story.name}" (${storyId})`);

    // Build continuity context — pass full scene_descriptions so the prompt can expand
    // the most recent one with full detail (tiered continuity).
    const prevScenes = previousEpisodes.map(ep => ep.scene_description);
    const lastCliffhanger = previousEpisodes[previousEpisodes.length - 1]?.scene_description?.cliffhanger || '';

    // Surface available narrators to Gemini so it can pick which persona speaks per dialogue shot.
    const storyPersonas = Array.isArray(story.persona_config?.personas)
      ? story.persona_config.personas
      : [story.persona_config];

    // Load Brand Kit (if configured) so each episode honors brand colors, mood, motifs, logos.
    let brandKit = null;
    if (story.brand_kit_job_id) {
      const job = await getMediaTrainingJobById(story.brand_kit_job_id, userId);
      if (job?.brand_kit) brandKit = job.brand_kit;
    }

    // Extract visual style and emotional state from the most recent completed episode
    // to maintain cross-episode continuity.
    const lastCompletedEp = previousEpisodes[previousEpisodes.length - 1];
    const previousVisualStyle = lastCompletedEp?.scene_description?.visual_style_prefix || '';
    const previousEmotionalState = lastCompletedEp?.scene_description?.emotional_state || '';

    // Build prompts — pass subject + storyFocus + brandKit so each episode's shots
    // integrate the subject naturally AND respect the brand identity.
    const systemPrompt = getEpisodeSystemPrompt(story.storyline, prevScenes, storyPersonas, {
      subject: story.subject,
      storyFocus: story.story_focus || 'product',
      brandKit,
      previousVisualStyle,
      previousEmotionalState,
      directorsNotes: story.subject?.directors_notes || ''
    });
    const userPrompt = getEpisodeUserPrompt(story.storyline, lastCliffhanger, episodeNumber);

    // Call Gemini 3 Flash
    const response = await axios.post(GEMINI_ENDPOINT, {
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      },
      contents: [{
        role: 'user',
        parts: [{ text: userPrompt }]
      }],
      generationConfig: {
        maxOutputTokens: 4096,
        temperature: 0.85,
        responseMimeType: 'application/json'
      }
    }, {
      headers: {
        'x-goog-api-key': this.googleApiKey,
        'Content-Type': 'application/json'
      },
      timeout: 45000
    });

    const candidate = response.data?.candidates?.[0];
    const rawText = candidate?.content?.parts?.[0]?.text?.trim();

    if (!rawText) throw new Error('Episode generation returned empty response');

    let sceneDescription;
    try {
      sceneDescription = this._parseGeminiJson(rawText);
    } catch (parseError) {
      logger.error(`Failed to parse episode JSON: ${rawText.slice(0, 200)}`);
      throw new Error('Episode generation returned invalid JSON');
    }

    logger.info(`Episode ${episodeNumber} generated: "${sceneDescription.title}"`);

    // Create episode record
    const episode = await createBrandStoryEpisode(storyId, userId, {
      episode_number: episodeNumber,
      scene_description: sceneDescription,
      status: 'generating_scene'
    });

    // Update story total_episodes count
    await updateBrandStory(storyId, userId, { total_episodes: episodeNumber });

    return episode;
  }

  // ═══════════════════════════════════════════════════
  // STORYBOARD FRAME GENERATION (Leonardo.ai)
  // ═══════════════════════════════════════════════════

  /**
   * Generate a storyboard frame for an episode using Leonardo.ai.
   *
   * @param {string} episodeId
   * @param {string} userId
   * @returns {Promise<Object>} Updated episode with storyboard_frame_url
   */
  async generateStoryboardFrame(episodeId, userId) {
    if (!leonardoService.isAvailable()) throw new Error('Leonardo.ai is not configured (LEONARDO_API_KEY)');

    const episode = await getBrandStoryEpisodeById(episodeId, userId);
    if (!episode) throw new Error('Episode not found');

    const story = await getBrandStoryById(episode.story_id, userId);
    if (!story) throw new Error('Story not found');

    logger.info(`Generating storyboard frame for episode ${episode.episode_number} (${episodeId})`);

    // Update status
    await updateBrandStoryEpisode(episodeId, userId, { status: 'generating_storyboard' });

    // Load brand kit for visual context
    let brandKit = {};
    if (story.brand_kit_job_id) {
      const job = await getMediaTrainingJobById(story.brand_kit_job_id, userId);
      if (job?.brand_kit) brandKit = job.brand_kit;
    }

    // Get the primary persona (personas[0]) — it drives character consistency.
    // persona_config shape: { personas: [ {...}, {...}, {...} ] }
    const personas = Array.isArray(story.persona_config?.personas)
      ? story.persona_config.personas
      : [story.persona_config];
    const primaryPersona = personas[0] || {};

    // Ensure character reference image is uploaded to Leonardo (once per story).
    // Source image priority depends on persona_type:
    //   - 'uploaded': use first uploaded reference image of the primary persona
    //   - 'brand_kit': use the selected person cutout URL of the primary persona
    //   - 'selected'/'described': no character reference (Leonardo generates from prompt)
    let characterRefId = story.leonardo_character_ref_id;
    if (!characterRefId) {
      let referenceImageUrl = null;
      if (story.persona_type === 'uploaded') {
        referenceImageUrl = primaryPersona?.reference_image_urls?.[0] || null;
      } else if (story.persona_type === 'brand_kit') {
        referenceImageUrl = primaryPersona?.cutout_url || null;
      }

      if (referenceImageUrl) {
        characterRefId = await leonardoService.uploadReferenceImage(referenceImageUrl);
        await updateBrandStory(story.id, userId, { leonardo_character_ref_id: characterRefId });
      }
    }

    // Build the prompt — pass the full persona_config so all characters are described
    const prompt = getStoryboardPrompt(episode.scene_description, story.persona_config, brandKit);

    // Generate frame
    const result = await leonardoService.generateFrame({
      prompt,
      characterRefId,
      styleRefId: story.leonardo_style_ref_id || null
    });

    // Update episode
    const updated = await updateBrandStoryEpisode(episodeId, userId, {
      storyboard_frame_url: result.imageUrl,
      storyboard_generation_id: result.generationId,
      status: 'generating_avatar'
    });

    logger.info(`Storyboard frame generated for episode ${episode.episode_number}: ${result.imageUrl}`);
    return updated;
  }

  // ═══════════════════════════════════════════════════
  // AVATAR NARRATION (HeyGen)
  // ═══════════════════════════════════════════════════

  /**
   * Generate avatar narration video for an episode using HeyGen.
   *
   * @param {string} episodeId
   * @param {string} userId
   * @returns {Promise<Object>} Updated episode with avatar_video_url
   */
  async generateAvatarNarration(episodeId, userId) {
    if (!heyGenService.isAvailable()) throw new Error('HeyGen is not configured (HEYGEN_API_KEY)');

    const episode = await getBrandStoryEpisodeById(episodeId, userId);
    if (!episode) throw new Error('Episode not found');

    const story = await getBrandStoryById(episode.story_id, userId);
    if (!story) throw new Error('Story not found');

    const dialogueScript = episode.scene_description?.dialogue_script;
    if (!dialogueScript) throw new Error('Episode has no dialogue script');

    // Select which persona narrates this episode.
    // Gemini picks narrator_persona_index (0-based). Fall back to persona 0 or story-level.
    const personas = Array.isArray(story.persona_config?.personas)
      ? story.persona_config.personas
      : [story.persona_config];
    const requestedIdx = Number.isInteger(episode.scene_description?.narrator_persona_index)
      ? episode.scene_description.narrator_persona_index
      : 0;
    const clampedIdx = Math.max(0, Math.min(requestedIdx, personas.length - 1));
    const narratorPersona = personas[clampedIdx] || personas[0] || {};

    // Prefer the persona's own trained avatar; fall back to story-level primary.
    const avatarId = narratorPersona.heygen_avatar_id || story.heygen_avatar_id;
    if (!avatarId) throw new Error('No HeyGen avatar available for any persona');

    const narratorLabel = narratorPersona.description?.slice(0, 40)
      || narratorPersona.avatar_name
      || `Persona ${clampedIdx + 1}`;
    logger.info(`Generating avatar narration for episode ${episode.episode_number} — narrator: [${clampedIdx}] "${narratorLabel}" (avatar=${avatarId})`);

    await updateBrandStoryEpisode(episodeId, userId, { status: 'generating_avatar' });

    // talking_photo avatars require a different character.type + use_avatar_iv_model=true
    // Stock HeyGen avatars (persona_type=selected) use character.type='avatar'.
    const isPhotoAvatar = narratorPersona.is_photo_avatar === true
      || (story.persona_type !== 'selected' && !!narratorPersona.heygen_avatar_id);

    const result = await heyGenService.generateAvatarVideo({
      avatarId,
      script: dialogueScript,
      options: {
        isPhotoAvatar,
        voiceId: narratorPersona.heygen_voice_id || null,
        aspectRatio: '9:16',
        resolution: '1080p'
      }
    });

    // Update episode
    const updated = await updateBrandStoryEpisode(episodeId, userId, {
      avatar_video_url: result.videoUrl,
      heygen_video_id: result.videoId,
      status: 'generating_video'
    });

    logger.info(`Avatar narration generated for episode ${episode.episode_number}: ${result.videoUrl}`);
    return updated;
  }

  // ═══════════════════════════════════════════════════
  // SCENE VIDEO GENERATION — ROUTER
  // Dispatches to Kling (cinematic) / Veo (broll) based on shot_type.
  // Dialogue shots are handled entirely by generateAvatarNarration (HeyGen).
  // ═══════════════════════════════════════════════════

  /**
   * Generate the episode video from the shot sequence Gemini wrote.
   *
   * Flow:
   *   1. Read episode.scene_description.shots[] (fallback: synthesize 1 shot from legacy fields)
   *   2. For each shot, call _generateSingleShot() — dispatches to HeyGen/Kling/Veo
   *   3. ffmpeg concat all shots into one MP4
   *   4. Upload final composite to Supabase → scene_video_url
   *   5. Persist per-shot URLs in scene_description._generated_shots for debugging
   *
   * @param {string} episodeId
   * @param {string} userId
   * @returns {Promise<Object>} Updated episode with scene_video_url
   */
  async generateSceneVideo(episodeId, userId) {
    const episode = await getBrandStoryEpisodeById(episodeId, userId);
    if (!episode) throw new Error('Episode not found');

    const story = await getBrandStoryById(episode.story_id, userId);
    if (!story) throw new Error('Story not found');

    const scene = episode.scene_description || {};

    // Determine shots list — support both new multi-shot schema and legacy single-shot.
    const shots = this._resolveShots(scene);
    logger.info(`Episode ${episode.episode_number}: generating ${shots.length} shot(s) [${shots.map(s => s.shot_type).join(' → ')}]`);

    await updateBrandStoryEpisode(episodeId, userId, { status: 'generating_video' });

    // Generate each shot sequentially (parallel would hammer APIs + Leonardo storyboards share persona state).
    const generatedShots = [];
    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      logger.info(`[Shot ${i + 1}/${shots.length}] type=${shot.shot_type}, duration=${shot.duration_seconds || 7}s`);

      try {
        const result = await this._generateSingleShot(shot, episode, story, userId, i);
        generatedShots.push({
          index: i,
          shot_type: shot.shot_type,
          duration: shot.duration_seconds || 7,
          video_url: result.publicVideoUrl,
          model: result.model
        });
      } catch (shotErr) {
        logger.error(`[Shot ${i + 1}] generation failed: ${shotErr.message}`);
        // Continue with remaining shots — concat will skip failed ones
      }
    }

    if (generatedShots.length === 0) {
      throw new Error('All shots failed to generate');
    }

    // Concat shots into single episode video
    let finalUrl;
    if (generatedShots.length === 1) {
      logger.info(`Single shot — skipping ffmpeg concat`);
      finalUrl = generatedShots[0].video_url;
    } else {
      logger.info(`Concatenating ${generatedShots.length} shots via ffmpeg...`);
      try {
        finalUrl = await this._concatShots(generatedShots, userId, episodeId);
      } catch (concatErr) {
        logger.error(`ffmpeg concat failed: ${concatErr.message} — falling back to first shot`);
        finalUrl = generatedShots[0].video_url;
      }
    }

    // Persist per-shot URLs for debugging + UI display
    const updatedSceneDescription = {
      ...scene,
      _generated_shots: generatedShots
    };

    const updated = await updateBrandStoryEpisode(episodeId, userId, {
      scene_video_url: finalUrl,
      video_generation_id: generatedShots.map(s => s.model).join(','),
      scene_description: updatedSceneDescription,
      status: 'compositing'
    });

    logger.info(`Episode ${episode.episode_number} scene video ready: ${finalUrl}`);
    return updated;
  }

  /**
   * Resolve the shots array from a scene_description.
   * Supports both the new shots[] schema and legacy single-shot_type schema.
   */
  _resolveShots(scene) {
    if (Array.isArray(scene.shots) && scene.shots.length > 0) {
      return scene.shots.map(s => ({
        shot_type: s.shot_type || 'cinematic',
        narrator_persona_index: Number.isInteger(s.narrator_persona_index) ? s.narrator_persona_index : 0,
        visible_persona_indexes: Array.isArray(s.visible_persona_indexes) ? s.visible_persona_indexes : [],
        subject_visible: !!s.subject_visible,
        visual_direction: s.visual_direction || scene.visual_direction || '',
        camera_notes: s.camera_notes || scene.camera_notes || '',
        dialogue_line: s.dialogue_line || '',
        mood: s.mood || scene.mood || '',
        duration_seconds: s.duration_seconds || 7
      }));
    }
    // Legacy: wrap single shot_type into a one-item shots array
    return [{
      shot_type: scene.shot_type || 'cinematic',
      narrator_persona_index: scene.narrator_persona_index || 0,
      visible_persona_indexes: [],
      subject_visible: false,
      visual_direction: scene.visual_direction || '',
      camera_notes: scene.camera_notes || '',
      dialogue_line: scene.dialogue_script || '',
      mood: scene.mood || '',
      duration_seconds: scene.duration_target_seconds || 10
    }];
  }

  /**
   * Generate one shot via the correct backend (HeyGen / Kling / Veo).
   * Returns { publicVideoUrl, model }.
   */
  async _generateSingleShot(shot, episode, story, userId, shotIdx) {
    const videoPrompt = [
      shot.visual_direction,
      shot.camera_notes ? `Camera: ${shot.camera_notes}` : '',
      shot.mood ? `Mood: ${shot.mood}` : '',
      'Photorealistic, cinematic lighting, 9:16 vertical.'
    ].filter(Boolean).join(' ').slice(0, 1400);

    const isHybrid = process.env.BRAND_STORY_VIDEO_STACK === 'hybrid';

    // ═══════════════════════════════════════════════════════════
    // HYBRID MODE — OmniHuman (dialogue) + Seedance (cinematic/broll) + Kling (multi-entity)
    // ═══════════════════════════════════════════════════════════
    if (isHybrid) {
      // Compute entity count for shot-level routing (B2).
      // entityCount >= 2 triggers Kling for cinematic shots (multi-reference identity lock).
      const visiblePersonas = shot.visible_persona_indexes || [];
      const entityCount = visiblePersonas.length + (shot.subject_visible ? 1 : 0);

      // ── DIALOGUE → OmniHuman 1.5 (via ElevenLabs TTS + fal.ai) ──
      // OmniHuman requires a person image. Only available for persona types that have
      // actual person images: uploaded, brand_kit, described.
      // 'selected' (stock HeyGen avatars) → always use HeyGen for dialogue.
      const omniHumanEligible = ['uploaded', 'brand_kit', 'described'].includes(story.persona_type);
      if (shot.shot_type === 'dialogue' && omniHumanEligible) {
        if (omniHumanService.isAvailable() && ttsService.isAvailable()) {
          try {
            return await this._generateOmniHumanDialogue(shot, episode, story, userId, shotIdx, videoPrompt);
          } catch (ohErr) {
            logger.warn(`[Shot ${shotIdx + 1}] OmniHuman dialogue failed (${ohErr.message})`);
            // In hybrid mode with uploaded/brand_kit/described, HeyGen has NO avatar
            // (we skipped HeyGen setup). Fall back to Seedance cinematic instead.
            if (seedanceService.isAvailable()) {
              logger.info(`[Shot ${shotIdx + 1}] Falling back to Seedance cinematic (no HeyGen avatar in hybrid mode)`);
              try {
                return await this._generateSeedanceCinematic(shot, episode, story, userId, shotIdx, videoPrompt);
              } catch (seedErr) {
                logger.warn(`[Shot ${shotIdx + 1}] Seedance fallback also failed (${seedErr.message})`);
              }
            }
            // Last resort: fall through to legacy path (will likely fail too but let it try)
          }
        } else {
          logger.info(`[Shot ${shotIdx + 1}] hybrid dialogue: OmniHuman/TTS unavailable — falling back to Seedance`);
          if (seedanceService.isAvailable()) {
            try {
              return await this._generateSeedanceCinematic(shot, episode, story, userId, shotIdx, videoPrompt);
            } catch (seedErr) {
              logger.warn(`[Shot ${shotIdx + 1}] Seedance fallback failed (${seedErr.message})`);
            }
          }
        }
        // Fall through to legacy HeyGen dialogue below (last resort)
      } else if (shot.shot_type === 'dialogue' && !omniHumanEligible) {
        logger.info(`[Shot ${shotIdx + 1}] hybrid dialogue: persona_type='${story.persona_type}' → using HeyGen (no person image for OmniHuman)`);
        // Fall through to legacy HeyGen dialogue below
      }

      // ── CINEMATIC with entityCount >= 2 → Kling (multi-entity @Elements) ──
      if (shot.shot_type === 'cinematic' && entityCount >= 2) {
        logger.info(`[Shot ${shotIdx + 1}] hybrid cinematic entityCount=${entityCount} → Kling (multi-entity identity lock)`);
        return this._generateCinematicOrBroll(shot, videoPrompt, episode, story, userId, shotIdx);
      }

      // ── CINEMATIC with entityCount <= 1 → Seedance I2V ──
      if (shot.shot_type === 'cinematic' && entityCount <= 1) {
        if (seedanceService.isAvailable()) {
          try {
            return await this._generateSeedanceCinematic(shot, episode, story, userId, shotIdx, videoPrompt);
          } catch (seedErr) {
            logger.warn(`[Shot ${shotIdx + 1}] Seedance cinematic failed (${seedErr.message}) — falling back to Kling/Veo`);
          }
        }
        // Fall through to legacy
      }

      // ── BROLL → Seedance (I2V with real subject image, or T2V) ──
      if (shot.shot_type === 'broll') {
        if (seedanceService.isAvailable()) {
          try {
            return await this._generateSeedanceBroll(shot, episode, story, userId, shotIdx, videoPrompt);
          } catch (seedErr) {
            logger.warn(`[Shot ${shotIdx + 1}] Seedance broll failed (${seedErr.message}) — falling back to Veo`);
          }
        }
        // Fall through to legacy
      }
    }

    // ═══════════════════════════════════════════════════════════
    // LEGACY MODE — HeyGen (dialogue) + Kling (cinematic) + Veo (broll)
    // Also serves as fallback when hybrid generators fail.
    // ═══════════════════════════════════════════════════════════

    // ───────────── DIALOGUE SHOT → HeyGen ─────────────
    if (shot.shot_type === 'dialogue') {
      if (!heyGenService.isAvailable()) {
        logger.warn(`[Shot ${shotIdx + 1}] dialogue requested but HeyGen unavailable — falling back to cinematic`);
        return this._generateCinematicOrBroll(shot, videoPrompt, episode, story, userId, shotIdx);
      }

      // Select narrator persona for THIS shot
      const personas = Array.isArray(story.persona_config?.personas)
        ? story.persona_config.personas
        : [story.persona_config];
      const idx = Math.max(0, Math.min(shot.narrator_persona_index || 0, personas.length - 1));
      const narratorPersona = personas[idx] || personas[0] || {};
      const avatarId = narratorPersona.heygen_avatar_id || story.heygen_avatar_id;

      if (!avatarId) {
        logger.warn(`[Shot ${shotIdx + 1}] dialogue — no trained avatar, falling back to cinematic`);
        return this._generateCinematicOrBroll(shot, videoPrompt, episode, story, userId, shotIdx);
      }

      const dialogueLine = shot.dialogue_line || shot.visual_direction || 'Continue the story.';
      const isPhotoAvatar = narratorPersona.is_photo_avatar === true
        || (story.persona_type !== 'selected' && !!narratorPersona.heygen_avatar_id);
      const personaVoiceId = narratorPersona.heygen_voice_id || null;

      logger.info(`[Shot ${shotIdx + 1}] HeyGen dialogue (persona ${idx}, avatar=${avatarId}, voice=${personaVoiceId || 'auto'}, photo=${isPhotoAvatar})`);
      const heygenResult = await heyGenService.generateAvatarVideo({
        avatarId,
        script: dialogueLine,
        options: { isPhotoAvatar, voiceId: personaVoiceId, aspectRatio: '9:16', resolution: '1080p' }
      });

      const dl = await axios.get(heygenResult.videoUrl, { responseType: 'arraybuffer', timeout: 120000 });
      const buffer = Buffer.from(dl.data);
      const publicUrl = await this._uploadBufferToStorage(
        buffer,
        userId,
        'videos',
        `shot${shotIdx}-dialogue-${episode.id}.mp4`,
        'video/mp4'
      );
      return { publicVideoUrl: publicUrl, model: 'heygen-avatar-iv' };
    }

    // ───────────── CINEMATIC or BROLL ─────────────
    return this._generateCinematicOrBroll(shot, videoPrompt, episode, story, userId, shotIdx);
  }

  // ═══════════════════════════════════════════════════════════
  // HYBRID MODE — New generation methods
  // ═══════════════════════════════════════════════════════════

  /**
   * Generate dialogue shot via OmniHuman 1.5 (ElevenLabs TTS → fal.ai OmniHuman).
   * Flow: text → ElevenLabs TTS audio → upload to Supabase → OmniHuman (image + audio → lip-synced video).
   * Only called for persona_type in {uploaded, brand_kit, described} — NOT 'selected' (stock HeyGen avatars).
   */
  async _generateOmniHumanDialogue(shot, episode, story, userId, shotIdx, videoPrompt) {
    const personas = Array.isArray(story.persona_config?.personas)
      ? story.persona_config.personas
      : [story.persona_config];
    const idx = Math.max(0, Math.min(shot.narrator_persona_index || 0, personas.length - 1));
    const persona = personas[idx] || personas[0] || {};

    const seedImageUrl = persona.omnihuman_seed_image_url
      || persona.reference_image_urls?.[0]
      || persona.cutout_url;
    if (!seedImageUrl) {
      throw new Error(`Persona ${idx} has no seed image for OmniHuman`);
    }

    const dialogueLine = shot.dialogue_line || shot.visual_direction || 'Continue the story.';
    // Cast Bible follow-up — replace silent Brian fallback with intelligent
    // gender + persona-aware library picker. Avoids voice-id collisions with
    // other personas in the story; logs a warn so the upstream miss is visible.
    const voiceId = persona.elevenlabs_voice_id
      || pickFallbackVoiceIdForPersonaInList(personas, idx, { reason: 'omnihuman_dialogue' })
      || undefined;

    // Step 1: ElevenLabs TTS → audio
    logger.info(`[Shot ${shotIdx + 1}] OmniHuman dialogue — TTS for persona ${idx}, ${dialogueLine.length} chars`);
    const ttsResult = await ttsService.synthesize({
      text: dialogueLine,
      options: { voiceId, language: persona.language || 'en' }
    });

    // Upload TTS audio to Supabase for a public URL (OmniHuman needs a URL, not a buffer)
    const audioPublicUrl = await this._uploadBufferToStorage(
      ttsResult.audioBuffer,
      userId,
      'audio',
      `tts-shot${shotIdx}-${episode.id}.mp3`,
      'audio/mpeg'
    );

    // Step 2: OmniHuman → lip-synced talking-head video
    logger.info(`[Shot ${shotIdx + 1}] OmniHuman generating — image: ${seedImageUrl.slice(0, 60)}..., audio: ${audioPublicUrl.slice(0, 60)}...`);
    const omniResult = await omniHumanService.generateTalkingHead({
      imageUrl: seedImageUrl,
      audioUrl: audioPublicUrl,
      options: {
        prompt: videoPrompt,
        resolution: '720p'
      }
    });

    // Upload video to Supabase
    const publicUrl = await this._uploadBufferToStorage(
      omniResult.videoBuffer,
      userId,
      'videos',
      `shot${shotIdx}-omnihuman-${episode.id}.mp4`,
      'video/mp4'
    );

    return { publicVideoUrl: publicUrl, model: 'omnihuman-1.5' };
  }

  /**
   * Generate single-entity cinematic shot via Seedance 1.5 Pro (image-to-video).
   * Uses a Leonardo storyboard frame or the real subject image as the start frame.
   */
  async _generateSeedanceCinematic(shot, episode, story, userId, shotIdx, videoPrompt) {
    // Choose start frame based on what's visible
    let startFrameUrl;
    const visiblePersonas = shot.visible_persona_indexes || [];

    if (visiblePersonas.length === 0 && shot.subject_visible) {
      // Subject-only shot: use real product reference image for visual authenticity
      const subjectRefs = this._collectSubjectReferenceImages(story);
      startFrameUrl = subjectRefs[0] || null;
      logger.info(`[Shot ${shotIdx + 1}] Seedance cinematic — subject-only, using real subject image`);
    }

    if (!startFrameUrl && visiblePersonas.length >= 1) {
      // Single persona: generate per-shot Leonardo storyboard
      logger.info(`[Shot ${shotIdx + 1}] Seedance cinematic — single persona, generating Leonardo storyboard`);
      try {
        startFrameUrl = await this._generateShotStoryboardFrame(shot, story, userId, shotIdx);
      } catch (frameErr) {
        logger.warn(`[Shot ${shotIdx + 1}] storyboard failed: ${frameErr.message}`);
      }
    }

    if (!startFrameUrl) {
      // Pure environment or fallback — generate storyboard from visual_direction
      logger.info(`[Shot ${shotIdx + 1}] Seedance cinematic — no refs, generating Leonardo storyboard from visual_direction`);
      try {
        startFrameUrl = await this._generateShotStoryboardFrame(shot, story, userId, shotIdx);
      } catch (frameErr) {
        logger.warn(`[Shot ${shotIdx + 1}] storyboard fallback failed: ${frameErr.message}`);
        throw new Error('No start frame available for Seedance cinematic');
      }
    }

    const clampedDuration = Math.min(Math.max(shot.duration_seconds || 5, 4), 15);
    logger.info(`[Shot ${shotIdx + 1}] Seedance I2V cinematic — ${clampedDuration}s, 720p, startFrame: ${startFrameUrl.slice(0, 60)}...`);

    const seedResult = await seedanceService.generateImageToVideo({
      prompt: videoPrompt,
      imageUrl: startFrameUrl,
      options: {
        duration: clampedDuration,
        aspectRatio: '9:16',
        resolution: '720p',
        generateAudio: true
      }
    });

    const publicUrl = await this._uploadBufferToStorage(
      seedResult.videoBuffer,
      userId,
      'videos',
      `shot${shotIdx}-seedance-cin-${episode.id}.mp4`,
      'video/mp4'
    );

    return { publicVideoUrl: publicUrl, model: 'seedance-1.5-pro-i2v' };
  }

  /**
   * Generate broll shot via Seedance 1.5 Pro.
   * Mirrors the current Veo pattern: use real subject reference image as start frame
   * for visual authenticity (not a Leonardo hallucination).
   */
  async _generateSeedanceBroll(shot, episode, story, userId, shotIdx, videoPrompt) {
    const subjectRefs = this._collectSubjectReferenceImages(story);
    const clampedDuration = Math.min(Math.max(shot.duration_seconds || 5, 4), 15);

    let seedResult;
    if (subjectRefs.length > 0) {
      // I2V with real subject image as start frame
      logger.info(`[Shot ${shotIdx + 1}] Seedance broll I2V — real subject image, ${clampedDuration}s`);
      seedResult = await seedanceService.generateImageToVideo({
        prompt: videoPrompt,
        imageUrl: subjectRefs[0],
        options: {
          duration: clampedDuration,
          aspectRatio: '9:16',
          resolution: '720p',
          generateAudio: true
        }
      });
    } else {
      // T2V — no subject reference available
      logger.info(`[Shot ${shotIdx + 1}] Seedance broll T2V — no subject refs, ${clampedDuration}s`);
      seedResult = await seedanceService.generateTextToVideo({
        prompt: videoPrompt,
        options: {
          duration: clampedDuration,
          aspectRatio: '9:16',
          resolution: '720p',
          generateAudio: true
        }
      });
    }

    const publicUrl = await this._uploadBufferToStorage(
      seedResult.videoBuffer,
      userId,
      'videos',
      `shot${shotIdx}-seedance-broll-${episode.id}.mp4`,
      'video/mp4'
    );

    return { publicVideoUrl: publicUrl, model: seedResult.model };
  }

  /**
   * Generate cinematic/broll shot via Kling (cinematic, identity-locked) or Veo (broll).
   * Generates a per-shot storyboard frame as the starting keyframe.
   */
  async _generateCinematicOrBroll(shot, videoPrompt, episode, story, userId, shotIdx) {
    // Generate a per-shot storyboard frame for Kling/Veo starting keyframe
    let storyboardUrl = episode.storyboard_frame_url; // fallback to episode-level frame
    try {
      storyboardUrl = await this._generateShotStoryboardFrame(shot, story, userId, shotIdx);
    } catch (frameErr) {
      logger.warn(`[Shot ${shotIdx + 1}] storyboard frame failed: ${frameErr.message} — using episode frame`);
    }

    let result;

    // Cinematic via Kling (preferred — identity-locked with both persona AND subject refs)
    if (shot.shot_type === 'cinematic' && klingService.isAvailable()) {
      // Identity refs first (persona + subject), then storyboard panel fills remaining slots.
      // Storyboard panels carry baked-in identity from Seedream generation AND guide composition.
      // Same pattern as _generateKlingMultiShot — Kling supports up to 7 reference images.
      const identityRefs = this._buildKlingReferenceImages(story);
      const combinedRefs = [...identityRefs, ...(storyboardUrl && !identityRefs.includes(storyboardUrl) ? [storyboardUrl] : [])].slice(0, 7);
      if (combinedRefs.length > 0) {
        const focus = story.story_focus || 'product';
        logger.info(`[Shot ${shotIdx + 1}] Kling cinematic (focus=${focus}) with ${combinedRefs.length} ref(s) (${identityRefs.length} identity + ${combinedRefs.length - identityRefs.length} storyboard)`);
        try {
          const klingDuration = shot.duration_seconds >= 8 ? 10 : 5;
          result = await klingService.generateReferenceVideo({
            referenceImages: combinedRefs,
            prompt: videoPrompt,
            options: { duration: klingDuration, aspectRatio: '9:16' }
          });
        } catch (klingErr) {
          logger.warn(`[Shot ${shotIdx + 1}] Kling failed (${klingErr.message}) — falling back to Veo`);
        }
      }
    }

    // Fallback OR broll → Veo. For broll shots, prefer the user's real subject image
    // as the starting keyframe so Veo animates the ACTUAL product/place, not Leonardo's hallucination.
    if (!result) {
      let veoKeyframeUrl = storyboardUrl;
      if (shot.shot_type === 'broll') {
        const subjectRefs = this._collectSubjectReferenceImages(story);
        if (subjectRefs.length > 0) {
          veoKeyframeUrl = subjectRefs[0];
          logger.info(`[Shot ${shotIdx + 1}] broll via Veo — using REAL subject image as keyframe`);
        } else {
          logger.info(`[Shot ${shotIdx + 1}] broll via Veo — no subject refs, using storyboard frame`);
        }
      } else {
        logger.info(`[Shot ${shotIdx + 1}] ${shot.shot_type} via Veo`);
      }
      result = await videoGenerationService.generateVideo({
        imageUrl: veoKeyframeUrl,
        prompt: videoPrompt
      });
    }

    // Upload to Supabase
    let publicUrl = result.videoUrl;
    if (result.videoBuffer) {
      try {
        publicUrl = await this._uploadBufferToStorage(
          result.videoBuffer,
          userId,
          'videos',
          `shot${shotIdx}-${shot.shot_type}-${episode.id}.mp4`,
          'video/mp4'
        );
      } catch (uploadErr) {
        logger.error(`[Shot ${shotIdx + 1}] upload failed: ${uploadErr.message}`);
      }
    }

    return { publicVideoUrl: publicUrl, model: result.model };
  }

  /**
   * Generate a per-shot storyboard frame via Leonardo Kino XL.
   * For product/landscape focus, upload the user's real subject image as a Leonardo init-image
   * and use it as the styleRefId so the storyboard actually features the real product/place.
   */
  async _generateShotStoryboardFrame(shot, story, userId, shotIdx) {
    if (!leonardoService.isAvailable()) {
      throw new Error('Leonardo not available');
    }

    // Reuse story's character reference (already uploaded once per story)
    let brandKit = {};
    if (story.brand_kit_job_id) {
      const job = await getMediaTrainingJobById(story.brand_kit_job_id, userId);
      if (job?.brand_kit) brandKit = job.brand_kit;
    }

    // Lazy-upload the subject image to Leonardo ONCE per story and cache its init-image id.
    // For product/landscape focus, the subject IS the brand identity — it should anchor
    // every storyboard frame.
    let styleRefId = story.leonardo_style_ref_id || null;
    const focus = story.story_focus || 'product';
    if (!styleRefId && (focus === 'product' || focus === 'landscape')) {
      const subjectRefs = this._collectSubjectReferenceImages(story);
      if (subjectRefs.length > 0) {
        try {
          styleRefId = await leonardoService.uploadReferenceImage(subjectRefs[0]);
          await updateBrandStory(story.id, userId, { leonardo_style_ref_id: styleRefId });
          logger.info(`Leonardo style ref uploaded (subject) for story ${story.id}: ${styleRefId}`);
        } catch (refErr) {
          logger.warn(`Leonardo subject style-ref upload failed: ${refErr.message}`);
        }
      }
    }

    const prompt = getStoryboardPrompt(shot, story.persona_config, brandKit, { subject: story.subject, storyFocus: focus });
    const result = await leonardoService.generateFrame({
      prompt,
      characterRefId: story.leonardo_character_ref_id || null,
      styleRefId
    });
    return result.imageUrl;
  }

  /**
   * Concatenate multiple shot MP4s into one episode video via ffmpeg concat demuxer.
   * Re-encodes to normalize codecs + aspect ratio, then uploads to Supabase.
   */
  async _concatShots(generatedShots, userId, episodeId) {
    const tmpDir = os.tmpdir();
    const rawFiles = [];
    const normalizedFiles = [];
    const listFile = path.join(tmpDir, `concat-${episodeId}.txt`);
    const outputFile = path.join(tmpDir, `episode-${episodeId}.mp4`);

    try {
      // Step 1: Download each shot to tmp
      for (const s of generatedShots) {
        const localPath = path.join(tmpDir, `shot-${episodeId}-${s.index}-raw.mp4`);
        const dl = await axios.get(s.video_url, { responseType: 'arraybuffer', timeout: 120000 });
        await fs.writeFile(localPath, Buffer.from(dl.data));
        rawFiles.push(localPath);
      }

      // Step 2: Normalize each shot individually to identical format.
      // Different generators (Kling, Seedance, HeyGen, Veo) produce different codecs,
      // resolutions, frame rates, and H.264 NAL unit formats. The concat demuxer can't
      // handle these differences — it chokes on mismatched NAL units at file boundaries.
      // By re-encoding each shot to an identical format first, concat can stream-copy safely.
      for (let i = 0; i < rawFiles.length; i++) {
        const normPath = path.join(tmpDir, `shot-${episodeId}-${i}-norm.mp4`);
        normalizedFiles.push(normPath);

        logger.info(`Normalizing shot ${i + 1}/${rawFiles.length}...`);
        await execFileAsync('ffmpeg', [
          '-y',
          '-i', rawFiles[i],
          '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1',
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '18',
          '-profile:v', 'high',
          '-level', '4.2',
          '-pix_fmt', 'yuv420p',
          '-r', '30',
          '-c:a', 'aac',
          '-b:a', '256k',
          '-ar', '48000',
          '-ac', '2',
          normPath
        ], { timeout: 120000 }); // 2 min per shot
      }

      // Step 3: Concat the normalized files (now all identical format — stream copy is safe)
      const listContent = normalizedFiles.map(f => `file '${f}'`).join('\n');
      await fs.writeFile(listFile, listContent);

      await execFileAsync('ffmpeg', [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', listFile,
        '-c', 'copy',
        '-movflags', '+faststart',
        outputFile
      ], { timeout: 60000 }); // Fast — just stream copy

      // Upload composite
      const compositeBuffer = await fs.readFile(outputFile);
      const publicUrl = await this._uploadBufferToStorage(
        compositeBuffer,
        userId,
        'videos',
        `episode-${episodeId}-composite.mp4`,
        'video/mp4'
      );
      logger.info(`Episode composite uploaded (${(compositeBuffer.length / 1024 / 1024).toFixed(1)}MB): ${publicUrl}`);
      return publicUrl;
    } finally {
      // Cleanup tmp files
      await Promise.allSettled([
        ...rawFiles.map(f => fs.unlink(f)),
        ...normalizedFiles.map(f => fs.unlink(f)),
        fs.unlink(listFile),
        fs.unlink(outputFile)
      ]);
    }
  }

  /**
   * Parse JSON from Gemini with defensive repair for known quirks:
   *   - Trailing `}` or `]` characters emitted after the actual JSON object
   *   - Markdown code fences (```json ... ```)
   *   - Leading/trailing whitespace
   */
  _parseGeminiJson(raw) {
    // Delegates to the shared repair chain in services/v4/GeminiJsonRepair.js
    // so BrandStoryService and VertexGemini.callVertexGeminiJson speak the
    // same defect-recovery contract. See that module for the full rationale.
    return parseGeminiJson(raw);
  }

  /**
   * Collect persona reference image URLs from a story for Kling identity conditioning.
   * Returns up to 4 URLs (Kling's max).
   */
  _collectPersonaReferenceImages(story) {
    const personas = Array.isArray(story.persona_config?.personas)
      ? story.persona_config.personas
      : [story.persona_config];

    const urls = [];
    for (const p of personas) {
      if (!p) continue;
      // brand_kit personas have cutout_url
      if (p.cutout_url) urls.push(p.cutout_url);
      // uploaded/described personas have reference_image_urls[]
      if (Array.isArray(p.reference_image_urls)) urls.push(...p.reference_image_urls);
    }
    // Deduplicate and cap at 4 (Kling Elements max)
    return [...new Set(urls)].slice(0, 4);
  }

  /**
   * Collect subject reference image URLs from a story.
   * These are the user's real product/place photos — the BRAND identity to preserve.
   */
  _collectSubjectReferenceImages(story) {
    const urls = Array.isArray(story.subject?.reference_image_urls)
      ? story.subject.reference_image_urls
      : [];
    return [...new Set(urls)].slice(0, 4);
  }

  /**
   * Build the reference image array for Kling, prioritized by story_focus
   * AND product_integration_style (Phase 4).
   * Kling 3.0 Pro accepts up to 4 reference images total (@Element1..@Element4 in prompt).
   *
   * Priority rules:
   *   person                                        → persona refs first (identity locked), subject refs as secondary
   *   landscape                                     → subject refs first (place IS the setting), persona refs secondary
   *   product + hero_showcase                       → subject refs first (product IS the framed subject)
   *   product + commercial (Phase 6, 2026-04-28)    → persona refs first — commercials need the talent to look like
   *                                                   themselves; product fidelity is enforced by the Director Agent
   *                                                   product_identity_lock dimension and by including product refs
   *                                                   in slots 3-4. Subject-first was a root cause of identity drift
   *                                                   in commercials (logs.txt 2026-04-28).
   *   product + naturalistic_placement / incidental → persona refs first (Hollywood-style: characters are subject)
   *   product + genre_invisible                     → persona refs first (product withheld until reveal)
   *   product (legacy default before style set)     → subject refs first (preserves pre-Phase-4 behavior)
   */
  _buildKlingReferenceImages(story) {
    const focus = story.story_focus || 'product';
    const personaRefs = this._collectPersonaReferenceImages(story);
    const subjectRefs = this._collectSubjectReferenceImages(story);
    const integrationStyle = story.product_integration_style || null;

    let combined;
    if (focus === 'person') {
      combined = [...personaRefs.slice(0, 2), ...subjectRefs.slice(0, 2)];
    } else if (focus === 'product') {
      // hero_showcase keeps product-first (legacy money-beat mode).
      // commercial flips to persona-first (2026-04-28 fix).
      // null integration_style preserves pre-Phase-4 product-first default.
      const productHero =
        integrationStyle === 'hero_showcase' ||
        integrationStyle == null;
      if (productHero) {
        combined = [...subjectRefs.slice(0, 2), ...personaRefs.slice(0, 2)];
      } else {
        // commercial / naturalistic_placement / incidental_prop / genre_invisible —
        // characters are the framed subject; product is a prop / participating element.
        combined = [...personaRefs.slice(0, 2), ...subjectRefs.slice(0, 2)];
      }
    } else {
      // landscape — subject (place) is the setting
      combined = [...subjectRefs.slice(0, 2), ...personaRefs.slice(0, 2)];
    }
    // Dedupe + cap at Kling's 4 total
    return [...new Set(combined)].slice(0, 4);
  }

  /**
   * Upload a video buffer to Supabase Storage and return the public URL.
   * Delegates to _uploadBufferToStorage.
   * @param {Buffer} buffer - Video MP4 buffer
   * @param {string} userId
   * @param {string} filename - e.g. "scene-uuid.mp4"
   * @returns {Promise<string>} Public URL
   */
  async _uploadVideoToStorage(buffer, userId, filename) {
    return this._uploadBufferToStorage(buffer, userId, 'videos', filename, 'video/mp4');
  }

  /**
   * Augment a single seed persona image into N angle/expression variations via
   * Leonardo Kino XL Character Reference ControlNet. Used to meet HeyGen's
   * minimum-10-images training requirement when the user provides fewer.
   *
   * Runs variations in parallel for speed.
   *
   * @param {string} seedImageUrl - Public URL of the original persona image
   * @param {string} userId
   * @param {number} personaIndex - For logging/file naming
   * @param {number} count - How many variations to generate
   * @returns {Promise<string[]>} Array of public Supabase URLs for the augmented images
   */
  async _augmentPersonaImagesForTraining(seedImageUrl, userId, personaIndex, count) {
    if (!leonardoService.isAvailable()) {
      throw new Error('LEONARDO_API_KEY required for persona image augmentation');
    }

    // Upload seed to Leonardo ONCE — reuse the character ref across all variations
    logger.info(`[P${personaIndex + 1}] Uploading seed to Leonardo as character reference...`);
    const characterRefId = await leonardoService.uploadReferenceImage(seedImageUrl);

    // Diverse angle/expression prompts for training variety
    const variations = [
      'front view, neutral expression, soft studio lighting, looking at camera',
      '3/4 angle view, slight smile, natural daylight',
      'profile side view, serious expression, dramatic lighting',
      'close-up headshot, confident expression, shallow depth of field',
      'medium shot, looking off-camera, golden hour lighting',
      'looking directly at camera, warm welcoming expression',
      'slight head tilt, contemplative expression, soft lighting',
      'close-up, subtle smile, professional headshot lighting',
      'three-quarter view, thoughtful expression, window light',
      'front view, confident look, editorial portrait lighting',
      'slightly upward angle, inspired expression, rim light',
      'side profile close-up, focused expression'
    ];

    const selectedVariations = variations.slice(0, count);

    logger.info(`[P${personaIndex + 1}] Generating ${count} Leonardo variations in parallel...`);

    // Generate in parallel — independent jobs
    const results = await Promise.allSettled(
      selectedVariations.map((variationPrompt, i) => this._generateAndUploadVariation(
        variationPrompt,
        characterRefId,
        userId,
        personaIndex,
        i
      ))
    );

    // Collect successful URLs (failures log a warning but don't fail the whole batch)
    const urls = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value) {
        urls.push(r.value);
      } else {
        logger.warn(`[P${personaIndex + 1}] Variation ${i + 1} failed: ${r.reason?.message || 'unknown'}`);
      }
    });

    logger.info(`[P${personaIndex + 1}] Augmentation complete — ${urls.length}/${count} variations succeeded`);
    return urls;
  }

  /**
   * Generate one Leonardo variation + upload to Supabase.
   * Extracted so the parallel loop above stays clean.
   */
  async _generateAndUploadVariation(variationPrompt, characterRefId, userId, personaIndex, variationIndex) {
    const prompt = `Photorealistic portrait of the same person, ${variationPrompt}. Same facial features, same identity. Film grain, 50mm lens, cinematic quality.`;

    const result = await leonardoService.generateFrame({
      prompt,
      characterRefId,
      options: { width: 768, height: 1024, numImages: 1, presetStyle: 'CINEMATIC' }
    });

    // Leonardo returns a CDN URL. Download + rehost on Supabase for reliable HeyGen access.
    const imageResp = await axios.get(result.imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30000
    });
    const buffer = Buffer.from(imageResp.data);

    const publicUrl = await this._uploadBufferToStorage(
      buffer,
      userId,
      'persona-augmented',
      `persona${personaIndex}-var${variationIndex}.jpg`,
      'image/jpeg'
    );

    return publicUrl;
  }

  /**
   * Upload any buffer (image or video) to Supabase Storage and return the public URL.
   * @param {Buffer} buffer - File buffer
   * @param {string} userId
   * @param {string} subfolder - e.g. "videos" | "persona-augmented"
   * @param {string} filename - e.g. "scene-uuid.mp4" | "angle-3.jpg"
   * @param {string} contentType - MIME type, e.g. "video/mp4" | "image/jpeg"
   * @returns {Promise<string>} Public URL
   */
  async _uploadBufferToStorage(buffer, userId, subfolder, filename, contentType) {
    const { supabaseAdmin } = await import('./supabase.js');
    const STORAGE_BUCKET = 'media-assets';
    const storagePath = `${userId}/brand-stories/${subfolder}/${Date.now()}-${filename}`;

    const { error } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, buffer, { contentType, upsert: false });

    if (error) throw new Error(`Storage upload failed: ${error.message}`);

    const { data: urlData } = supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .getPublicUrl(storagePath);

    return urlData.publicUrl;
  }

  // ═══════════════════════════════════════════════════
  // VIDEO COMPOSITING (ffmpeg)
  // ═══════════════════════════════════════════════════

  /**
   * Composite the avatar narration over the scene video using ffmpeg.
   * Picture-in-picture: avatar in bottom-right corner over the scene.
   *
   * @param {string} episodeId
   * @param {string} userId
   * @returns {Promise<Object>} Updated episode with final_video_url
   */
  async compositeVideo(episodeId, userId) {
    const episode = await getBrandStoryEpisodeById(episodeId, userId);
    if (!episode) throw new Error('Episode not found');

    if (!episode.scene_video_url) throw new Error('No scene video available');

    // With shot-type routing, the scene_video_url IS already the final video:
    //   - dialogue shots: scene_video_url == avatar_video_url (HeyGen)
    //   - cinematic shots: scene_video_url == Kling output
    //   - broll shots: scene_video_url == Veo output
    // No compositing needed — just promote to final_video_url.
    logger.info(`Finalizing episode ${episode.episode_number} (${episode.scene_description?.shot_type || 'cinematic'} shot)`);
    return updateBrandStoryEpisode(episodeId, userId, {
      final_video_url: episode.scene_video_url,
      status: 'ready'
    });
  }

  /**
   * (Legacy) Compositing via ffmpeg PiP — no longer used with shot-type routing.
   * Kept for reference in case compositing is ever needed again.
   */
  async _compositeVideoPiP(episodeId, userId) {
    const episode = await getBrandStoryEpisodeById(episodeId, userId);
    if (!episode || !episode.scene_video_url || !episode.avatar_video_url) return episode;

    logger.info(`Compositing video for episode ${episode.episode_number} (${episodeId})`);
    await updateBrandStoryEpisode(episodeId, userId, { status: 'compositing' });

    const tmpDir = os.tmpdir();
    const sceneFile = path.join(tmpDir, `scene_${episodeId}.mp4`);
    const avatarFile = path.join(tmpDir, `avatar_${episodeId}.mp4`);
    const outputFile = path.join(tmpDir, `composite_${episodeId}.mp4`);

    try {
      // Download both videos
      const [sceneData, avatarData] = await Promise.all([
        axios.get(episode.scene_video_url, { responseType: 'arraybuffer', timeout: 60000 }),
        axios.get(episode.avatar_video_url, { responseType: 'arraybuffer', timeout: 60000 })
      ]);

      await Promise.all([
        fs.writeFile(sceneFile, Buffer.from(sceneData.data)),
        fs.writeFile(avatarFile, Buffer.from(avatarData.data))
      ]);

      // Picture-in-picture: avatar (scaled to 25% width) in bottom-right corner
      // Use shortest duration to avoid desync
      await execFileAsync('ffmpeg', [
        '-y',
        '-i', sceneFile,
        '-i', avatarFile,
        '-filter_complex',
        '[1:v]scale=iw*0.25:-1[avatar];[0:v][avatar]overlay=W-w-20:H-h-20:shortest=1',
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        // Use audio from avatar (narration), fall back to scene audio
        '-map', '0:v',
        '-map', '1:a?',
        '-map', '0:a?',
        '-shortest',
        outputFile
      ], { timeout: 120000 });

      // Read the composited file
      const compositeBuffer = await fs.readFile(outputFile);

      // Upload to a temporary accessible location
      // For now, we'll use a data URL or return the local path
      // In production, this would upload to Supabase Storage
      const finalVideoUrl = episode.scene_video_url; // Fallback: use scene video URL
      // TODO: Upload compositeBuffer to Supabase Storage and get a public URL

      logger.info(`Video composited for episode ${episode.episode_number} — ${compositeBuffer.length} bytes`);

      const updated = await updateBrandStoryEpisode(episodeId, userId, {
        final_video_url: finalVideoUrl,
        status: 'ready'
      });

      return updated;
    } catch (error) {
      logger.error(`ffmpeg compositing failed for episode ${episodeId}: ${error.message}`);
      // Fall back to scene video without avatar overlay
      const updated = await updateBrandStoryEpisode(episodeId, userId, {
        final_video_url: episode.scene_video_url,
        status: 'ready',
        error_message: `Compositing failed (using scene video): ${error.message}`
      });
      return updated;
    } finally {
      // Clean up temp files
      await Promise.allSettled([
        fs.unlink(sceneFile),
        fs.unlink(avatarFile),
        fs.unlink(outputFile)
      ]);
    }
  }

  // ═══════════════════════════════════════════════════
  // FULL EPISODE PIPELINE
  // ═══════════════════════════════════════════════════

  /**
   * Run the complete episode generation pipeline:
   * 1. Generate scene description (Gemini)
   * 2. Generate storyboard frame (Leonardo.ai)
   * 3. Generate avatar narration (HeyGen) — if avatar configured
   * 4. Generate scene video (Veo/Runway)
   * 5. Composite final video (ffmpeg)
   *
   * @param {string} storyId
   * @param {string} userId
   * @param {Function} [onProgress] - Optional progress callback (stage, detail)
   * @returns {Promise<Object>} The completed episode record
   */
  async runEpisodePipeline(storyId, userId, onProgress) {
    // Pipeline version routing.
    //   - 'v4' (new V4 scene→beat pipeline)
    //   - 'v2' (legacy cinematic / v3 in mental model)
    //   - else  (v1 legacy hybrid)
    const pipelineVersion = process.env.BRAND_STORY_PIPELINE || 'v2';
    if (pipelineVersion === 'v4') {
      return this.runV4Pipeline(storyId, userId, onProgress);
    }
    if (pipelineVersion === 'v2') {
      return this.runCinematicPipeline(storyId, userId, onProgress);
    }

    // v1 legacy pipeline below
    const progress = (stage, detail) => {
      logger.info(`[Pipeline] ${stage}: ${detail}`);
      if (onProgress) onProgress(stage, detail);
    };

    try {
      // Step 1: Generate scene description (multi-shot structure)
      progress('scene', 'Generating scene description...');
      const episode = await this.generateNextEpisode(storyId, userId);
      const shots = this._resolveShots(episode.scene_description || {});
      const shotSummary = shots.map(s => s.shot_type).join(' → ');
      progress('scene', `Episode ${episode.episode_number}: [${shotSummary}]`);

      // Step 2: If ANY shot is dialogue, wait for avatar training to finish
      const hasDialogueShot = shots.some(s => s.shot_type === 'dialogue');
      if (hasDialogueShot) {
        await this._waitForAvatarReadyIfProcessing(storyId, userId, progress);
      }

      // Step 3: Generate all shots + concat them into the episode video.
      // generateSceneVideo() now handles per-shot dispatch, storyboard frames,
      // and ffmpeg concatenation internally.
      progress('video', `Generating ${shots.length} shot(s)...`);
      await this.generateSceneVideo(episode.id, userId);

      // Step 4: Finalize — promote scene_video_url to final_video_url
      progress('composite', 'Finalizing...');
      await this.compositeVideo(episode.id, userId);

      // Update story-so-far appendix for continuity
      try {
        const finalEp = await getBrandStoryEpisodeById(episode.id, userId);
        await this._updateStorySoFar(storyId, userId, finalEp);
      } catch (soFarErr) {
        logger.warn(`story_so_far update failed (non-fatal): ${soFarErr.message}`);
      }

      progress('complete', `Episode ${episode.episode_number} ready!`);

      return getBrandStoryEpisodeById(episode.id, userId);
    } catch (error) {
      logger.error(`Episode pipeline failed for story ${storyId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * If the avatar is currently training (pending/processing), wait briefly for
   * it to complete. Used before dialogue shots to avoid unnecessary failures.
   */
  async _waitForAvatarReadyIfProcessing(storyId, userId, progress) {
    const MAX_WAIT_MS = 180000; // 3 minutes
    const POLL_MS = 15000;
    const started = Date.now();

    while (Date.now() - started < MAX_WAIT_MS) {
      const story = await getBrandStoryById(storyId, userId);
      const trainingStatus = story?.persona_config?.training_status;

      // Already completed/failed — proceed
      if (!trainingStatus || ['completed', 'failed', 'skipped'].includes(trainingStatus)) {
        return;
      }

      // Still pending/processing — wait
      progress('avatar', `Waiting for avatar training (${trainingStatus})...`);
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
    logger.warn(`Avatar still processing after ${MAX_WAIT_MS / 1000}s — proceeding anyway`);
  }

  // ═══════════════════════════════════════════════════
  // HEYGEN AVATAR SETUP
  // ═══════════════════════════════════════════════════

  /**
   * Set up HeyGen avatars for a story — trains ALL personas in persona_config.
   * Delegates to _autoSetupAvatar for the unified multi-persona training flow.
   *
   * @param {string} storyId
   * @param {string} userId
   * @returns {Promise<Object>} Updated story
   */
  async setupAvatar(storyId, userId) {
    await this._autoSetupAvatar(storyId, userId);
    return getBrandStoryById(storyId, userId);
  }

  /**
   * @deprecated Legacy single-persona setup. Use _autoSetupAvatar (multi-persona).
   */
  async _setupAvatarLegacy(storyId, userId) {
    if (!heyGenService.isAvailable()) throw new Error('HeyGen is not configured');

    const story = await getBrandStoryById(storyId, userId);
    if (!story) throw new Error('Story not found');

    // Primary persona (personas[0]) is the narrator/HeyGen avatar.
    // persona_config shape: { personas: [ {...}, ... ] }
    const personas = Array.isArray(story.persona_config?.personas)
      ? story.persona_config.personas
      : [story.persona_config];
    const primary = personas[0] || {};

    if (story.persona_type === 'selected') {
      // Avatar already selected — just verify it's set
      if (!primary?.heygen_avatar_id) {
        throw new Error('Primary selected persona has no heygen_avatar_id');
      }
      const updated = await updateBrandStory(storyId, userId, {
        heygen_avatar_id: primary.heygen_avatar_id,
        persona_config: {
          ...(story.persona_config || {}),
          training_status: 'completed'
        }
      });
      return updated;
    }

    // Both 'uploaded', 'brand_kit', AND 'described' (which _autoSetupAvatar has
    // converted to have reference_image_urls) take the Photo Avatar Group training path.
    if (story.persona_type === 'uploaded' || story.persona_type === 'brand_kit' || story.persona_type === 'described') {
      // Create a Photo Avatar Group from the primary persona's reference images.
      // 'uploaded': user-provided face photos (reference_image_urls)
      // 'brand_kit': cutout image extracted from the user's Brand Kit (cutout_url)
      const imageUrls = story.persona_type === 'brand_kit'
        ? (primary?.cutout_url ? [primary.cutout_url] : [])
        : (primary?.reference_image_urls || []);

      if (imageUrls.length === 0) {
        throw new Error(`Primary ${story.persona_type} persona has no reference images`);
      }

      logger.info(`Creating Photo Avatar Group for story ${storyId} (${story.persona_type})`);
      const group = await heyGenService.createPhotoAvatarGroup(story.name, imageUrls);

      // Train the group
      await heyGenService.trainPhotoAvatarGroup(group.groupId);

      // Wait for training to complete
      const trained = await heyGenService.waitForAvatarGroupTraining(group.groupId);

      // Save the avatar references (store training metadata at persona_config root)
      const updated = await updateBrandStory(storyId, userId, {
        heygen_avatar_group_id: group.groupId,
        heygen_avatar_id: trained.avatarId,
        persona_config: {
          ...(story.persona_config || {}),
          heygen_avatar_group_id: group.groupId,
          training_status: 'completed'
        }
      });

      return updated;
    }

    // 'described' persona type — avatar will be created later or user selects one
    logger.info(`Persona type "${story.persona_type}" does not require immediate avatar setup`);
    return story;
  }

  /**
   * List available HeyGen stock avatars.
   */
  async listStockAvatars() {
    if (!heyGenService.isAvailable()) throw new Error('HeyGen is not configured');
    return heyGenService.listStockAvatars();
  }

  /**
   * List HeyGen voices for the voice-picker UI.
   * Filters: { language?, gender? } — narrows to English+matching gender by default.
   */
  async listVoices({ language = 'en', gender = null } = {}) {
    if (!heyGenService.isAvailable()) throw new Error('HeyGen is not configured');
    const all = await heyGenService.listVoices();
    return all
      .filter(v => !language || (v.language || '').toLowerCase().startsWith(language.toLowerCase()))
      .filter(v => !gender || (v.gender || '').toLowerCase() === gender.toLowerCase())
      .map(v => ({
        voice_id: v.voice_id,
        name: v.name,
        gender: v.gender,
        language: v.language,
        preview_audio: v.preview_audio
      }));
  }

  /**
   * Auto-pick a HeyGen stock avatar that best fits a product/landscape story focus.
   * Used when the user clicks "Auto Assign Best Fit Character" in the wizard.
   *
   * Scoring heuristic:
   *   - Professional/business keywords in name: +2
   *   - Has a preview image: +1
   *   - Subject hint keyword matches name: +3
   *   - Focus-specific nudge keywords: +1
   * Deterministic tie-break via hash(subjectHint + focus) so repeat clicks are stable.
   *
   * @param {Object} params
   * @param {string} params.focus - 'product' | 'landscape' (not valid for 'person')
   * @param {string} [params.subjectHint] - Optional subject category/name for keyword matching
   * @returns {Promise<Object|null>} { avatarId, name, previewUrl, gender } or null
   */
  async autoPickStockAvatar({ focus, subjectHint = '' }) {
    if (!heyGenService.isAvailable()) throw new Error('HeyGen is not configured');

    const all = await heyGenService.listStockAvatars();
    if (!all.length) return null;

    const subjectTerms = String(subjectHint).toLowerCase().split(/\s+/).filter(Boolean);

    // HeyGen avatar names are descriptive (e.g. "Professional Presenter — Business Suit")
    const PRO_KEYWORDS = ['professional', 'business', 'suit', 'office', 'corporate', 'executive', 'studio', 'presenter', 'host'];

    const scored = all
      .filter(a => a.previewUrl) // exclude avatars with missing previews
      .map(a => {
        const name = (a.name || '').toLowerCase();
        let score = 0;
        if (PRO_KEYWORDS.some(kw => name.includes(kw))) score += 2;
        if (a.previewUrl) score += 1;
        if (subjectTerms.some(t => t && t.length > 2 && name.includes(t))) score += 3;
        // Focus-specific nudges
        if (focus === 'landscape' && (name.includes('casual') || name.includes('outdoor') || name.includes('guide'))) score += 1;
        if (focus === 'product' && (name.includes('presenter') || name.includes('host') || name.includes('showcase'))) score += 1;
        return { ...a, _score: score };
      });

    if (scored.length === 0) return null;

    // Pick top tier
    const maxScore = Math.max(...scored.map(a => a._score));
    const topTier = scored.filter(a => a._score === maxScore);

    // Deterministic tie-break — same subjectHint + focus always picks same avatar
    const hashInput = `${subjectHint}|${focus}`;
    const hash = [...hashInput].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0);
    const chosen = topTier[Math.abs(hash) % topTier.length];

    logger.info(`Auto-picked avatar "${chosen.name}" (score=${chosen._score}) for focus=${focus} subject_hint="${subjectHint}"`);
    return {
      avatarId: chosen.avatarId,
      name: chosen.name,
      previewUrl: chosen.previewUrl,
      gender: chosen.gender
    };
  }
  // ═══════════════════════════════════════════════════
  // CHARACTER SHEET GENERATION (Flux 2 Max — unified for all persona types)
  // ═══════════════════════════════════════════════════

  /**
   * Generate a 3-view character sheet for a persona via Flux 2 Max.
   * Works for ALL persona types: described, uploaded, brand_kit, brand_kit_auto.
   *
   * For described: generates face + body from text description
   * For uploaded: generates consistent additional views from user's photos
   * For brand_kit: generates views from cutout + brand people references
   *
   * @param {Object} persona - Persona object with description, reference_image_urls, cutout_url, etc.
   * @param {number} personaIndex - Index in the personas array (for logging)
   * @param {Object} story - Story object (for brand kit context)
   * @param {string} userId
   * @returns {Promise<Object>} Updated persona with enriched reference_image_urls
   */
  async _generateCharacterSheet(persona, personaIndex, story, userId) {
    // V4: character sheets now go through fal.ai Flux 2 Max (via FAL_GCS_API_KEY)
    // instead of Replicate. Same model (black-forest-labs/flux-2-max → fal-ai/flux-2-max/edit
    // for reference-image runs, fal-ai/flux-2-max for text-only runs). Consolidates
    // V4's vendor surface to fal.ai + Google + ElevenLabs.
    // Migrated 2026-04-11.
    if (!fluxFalService.isAvailable()) {
      throw new Error('FAL_GCS_API_KEY not set — required for V4 character sheet generation via Flux 2 Max');
    }

    const name = persona.description?.slice(0, 30) || persona.avatar_name || `Persona ${personaIndex + 1}`;
    logger.info(`Generating character sheet for ${name} (persona_type=${story.persona_type}) via fal.ai Flux 2 Max...`);

    // 1. Collect existing persona images as Flux input_images references
    const existingImages = [];
    if (Array.isArray(persona.reference_image_urls)) {
      existingImages.push(...persona.reference_image_urls);
    }
    if (persona.cutout_url) existingImages.push(persona.cutout_url);

    // 2. Collect Brand Kit people[] images for style/appearance reference
    let brandPeopleImages = [];
    if (story.brand_kit_job_id) {
      try {
        const job = await getMediaTrainingJobById(story.brand_kit_job_id, userId);
        const brandKit = job?.brand_kit;
        if (brandKit?.people) {
          brandPeopleImages = brandKit.people
            .map(p => p.image_url)
            .filter(Boolean);
        }
      } catch (e) { /* no brand kit — fine */ }
    }

    // 3. Build input_images: persona's own images first, then brand people (up to 8 total)
    const inputImages = [...existingImages, ...brandPeopleImages].slice(0, 8);

    // 4. Build description for prompts
    const description = persona.appearance || persona.description || 'A professional, camera-ready person';
    const personality = persona.personality || '';
    const wardrobe = persona.wardrobe_hint || '';

    // Load brand style hints
    let styleHint = '';
    if (story.brand_kit_job_id) {
      try {
        const job = await getMediaTrainingJobById(story.brand_kit_job_id, userId);
        const sc = job?.brand_kit?.style_characteristics || {};
        styleHint = [sc.overall_aesthetic, sc.photography_style, sc.mood].filter(Boolean).join(', ');
      } catch (e) { /* fine */ }
    }

    // 5. Build the view list — Phase 5 routes through CharacterSheetDirector
    // (when enabled). Each variant becomes one or more views; legacy mode emits
    // the static white-studio prompts unchanged.
    const baseSeed = Math.floor(Math.random() * 2147483647);
    let views;
    let csdMeta = null;  // captured for persona record (sheet_variants field)

    if (isCharacterSheetDirectorEnabled()) {
      try {
        // Load brand kit once for the director
        let brandKit = null;
        if (story.brand_kit_job_id) {
          try {
            const job = await getMediaTrainingJobById(story.brand_kit_job_id, userId);
            brandKit = job?.brand_kit || null;
          } catch { /* fine */ }
        }
        const { variants, isPrincipal } = await csdGenerateAllVariants({ persona, story, brandKit });
        csdMeta = { variants: Object.keys(variants), is_principal: isPrincipal };

        // V4 character-sheet richness — 3-axis view grid (2026-04-29).
        //
        // Replaces the prior `arc_state × {hero, closeup}` emit (4 views, all
        // front-facing) with a 3-axis structure that restores the original
        // n8n workflow's geometric + detail coverage WHILE keeping V4's arc
        // emotional variation:
        //
        //   Axis 1 — Body angles    × CHARACTER_BODY_ANGLES (3 entries)
        //                             front 3/4 (45°), pure rear, side 90°
        //   Axis 2 — Arc states     × variants (1 for non-principal, 2-3 for principal)
        //   Axis 3 — Detail macros  × buildDetailMacroPrompts (4 entries — once per persona)
        //                             head, upper chest, signature item, lower legs/boots
        //
        // Result per persona:
        //   - Non-principal: 3 angles × 1 arc + 4 details =  7 views
        //   - Principal:     3 angles × 2 arcs + 4 details = 10 views
        //   - HIGH_QUALITY:  3 angles × 3 arcs + 4 details = 13 views
        //
        // Plus the existing CIP 3-angle bank (canonical_identity_urls) — kept
        // independent. Beat generators consume both: reference_image_urls
        // (this stack) for matched-angle / detail anchors, canonical_identity_urls
        // for Kling element-binding identity lock.
        //
        // Cost: ~$0.04 per Flux call × 7-13 calls per persona = $0.28-$0.52,
        // ~6-11 minutes per persona. Quality-first tradeoff.
        views = [];
        for (const [arcState, brief] of Object.entries(variants)) {
          for (const angle of CHARACTER_BODY_ANGLES) {
            views.push({
              label: `${arcState}-${angle.slot}`,
              prompt: composeAngleVariantPrompt(brief.flux_prompt, angle),
              negative_prompt: brief.negative_prompt || undefined,
              aspect: angle.aspect,
              arc_state: arcState,
              angle_slot: angle.slot
            });
          }
        }

        // Detail macros — generated once per persona (not per arc state).
        // The macros reference the persona's seed photo + freshly-rendered
        // angle views (heroInputImages stack, accumulated by the loop).
        const detailMacros = buildDetailMacroPrompts(persona, { description, wardrobe });
        for (const macro of detailMacros) {
          views.push({
            label: `detail-${macro.slot}`,
            prompt: macro.prompt,
            aspect: '1:1',
            detail_slot: macro.slot
          });
        }

        logger.info(
          `CharacterSheetDirector: 3-axis grid emitted — ` +
          `${Object.keys(variants).length} arc(s) × ${CHARACTER_BODY_ANGLES.length} angles + ${detailMacros.length} details = ` +
          `${views.length} views for ${name} (principal=${isPrincipal})`
        );
      } catch (err) {
        logger.warn(`CharacterSheetDirector failed (${err.message}) — falling back to legacy hardcoded prompts`);
        views = null;
      }
    }

    if (!views) {
      // Legacy hardcoded fallback (preserves pre-Phase-5 behavior).
      views = [
        {
          label: 'hero',
          prompt: `Cinematic film still portrait, full body shot, 3/4 front view at 45 degrees. ${description}. ${wardrobe ? 'Wearing: ' + wardrobe + '.' : ''} ${styleHint ? 'Style: ' + styleHint + '.' : ''} Hyperrealistic, soft wrap-around studio lighting, subtle rim light from behind, even full-body illumination, slight cinematic contrast. Eye-level camera, 85mm equivalent, sharp head-to-toe focus. Pure white seamless studio background, fully isolated character. 8K, sharp material textures, photographic quality. No text, no watermark.`,
          aspect: '9:16'
        },
        {
          label: 'closeup',
          prompt: `Close-up cinematic portrait, head and shoulders, looking directly at camera. ${description}. Dramatic shallow depth of field, catch-lights in eyes, warm skin tones, fine detail on skin texture and facial features. ${styleHint ? 'Style: ' + styleHint + '.' : ''} Soft studio lighting, slight rim light. White background. Photorealistic, 8K detail. No text, no watermark.`,
          aspect: '1:1'
        },
        {
          label: 'fullbody-side',
          prompt: `Full body pure side profile, 90 degree angle. ${description}. ${wardrobe ? 'Wearing: ' + wardrobe + '.' : ''} Standing tall, natural relaxed posture. Sharp head-to-toe focus, even studio lighting. White seamless background. Hyperrealistic, photographic quality. No text, no watermark.`,
          aspect: '9:16'
        }
      ];
    }

    const newImageUrls = [];
    // Phase 5 — sheet_variants captures arc-state → { hero, closeup } URL map
    // when CharacterSheetDirector ran. BeatRouter consumes this to pick the
    // right variant per beat based on beat.arc_position. Empty in legacy mode.
    const sheetVariants = {};
    let heroInputImages = [...inputImages];

    for (let v = 0; v < views.length; v++) {
      const view = views[v];

      // fal.ai Flux 2 Max via FluxFalService — handles both text-only and
      // reference-image paths internally (switches between fal-ai/flux-2-max
      // and fal-ai/flux-2-max/edit based on whether referenceImages is empty).
      let imageBuffer;
      try {
        const portraitResult = await fluxFalService.generatePortrait({
          prompt: view.prompt,
          referenceImages: heroInputImages,
          options: {
            aspectRatio: view.aspect,
            seed: baseSeed + v
          }
        });
        imageBuffer = portraitResult.imageBuffer;
      } catch (err) {
        logger.warn(`${name} ${view.label} view: fal.ai Flux 2 Max failed — ${err.message} — skipping`);
        continue;
      }

      const filename = `char-sheet-${Date.now()}-${personaIndex}-${view.label}.webp`;
      const imageUrl = await this._uploadBufferToStorage(
        imageBuffer, userId, 'personas', filename, 'image/webp'
      );
      newImageUrls.push(imageUrl);

      // V4 P-character-sheet-richness — record per-arc-state URL into
      // sheet_variants under the angle slot (front34 / rear / side90).
      // Legacy hero/closeup slots remain readable for back-compat with the
      // legacy fallback path below (which uses hero/closeup labels).
      if (view.arc_state) {
        if (!sheetVariants[view.arc_state]) sheetVariants[view.arc_state] = {};
        const slot =
          view.angle_slot ||
          (view.label.includes('closeup') ? 'closeup' : 'hero');
        sheetVariants[view.arc_state][slot] = imageUrl;
        // Last write wins for the prompt field — when 3-axis grid is used,
        // this captures whichever angle finished last for that arc state.
        // It's used downstream for diagnostics, not routing.
        sheetVariants[view.arc_state].prompt = view.prompt;
      }

      // After hero shot, add it as reference for subsequent views
      if (v === 0) {
        heroInputImages = [imageUrl, ...inputImages].slice(0, 8);
      }

      logger.info(`  ${name} ${view.label} uploaded: ${imageUrl}`);
    }

    if (newImageUrls.length === 0) {
      logger.warn(`Failed to generate character sheet for ${name}`);
      return persona; // Return unchanged
    }

    // 6. Merge: Flux-harmonized views FIRST, original uploads second.
    //
    // V4 Phase 9 character-sheet ordering fix (per Director's notes 2026-04-23):
    // previously we put user uploads first, which meant downstream
    // `reference_image_urls.slice(0, N)` calls pulled the user's DIVERSE
    // raw uploads (different hair/makeup/outfit/event magazine shots) before
    // the Flux-generated harmonized views. Result: face drifted per beat
    // because Kling/Veo averaged across inconsistent looks.
    //
    // New ordering puts the internally-consistent Flux views first so any
    // slice/cap picks the harmonized identity before the diverse originals.
    // The originals stay in the array as style context, but no longer win
    // the identity anchor selection.
    const allRefs = [...newImageUrls, ...existingImages];

    // V4 P-character-sheet-richness — face-bearing subset for the CIP front
    // anchor. The CIP front prompt explicitly says "extract the constant
    // facial structure" — rear views contribute zero face data AND fal.ai's
    // content checker can flag fitted-clothing rear views (logs.txt
    // 2026-04-29: persona shipped without ANY CIP because the CIP front call
    // included rear views that tripped content moderation).
    //
    // Filter rules:
    //   • Include `*-front34` (face front-on)
    //   • Include `*-side90` (jawline visible)
    //   • Include `detail-head` (closest face reference)
    //   • Include all user originals (face visible by design)
    //   • EXCLUDE `*-rear` (no face data + content-checker risk)
    //   • EXCLUDE `detail-chest`, `detail-signature`, `detail-boots` (no face)
    //
    // Order: face-richest first so ref[0] is the best face anchor.
    const isFaceBearing = (url) =>
      typeof url === 'string' && (
        url.includes('-front34') ||
        url.includes('-side90') ||
        url.includes('detail-head')
      );
    const fluxFaceRefs = newImageUrls.filter(isFaceBearing);
    const detailHeadFirst = fluxFaceRefs.filter(u => u.includes('detail-head'));
    const front34Refs = fluxFaceRefs.filter(u => u.includes('-front34'));
    const side90Refs = fluxFaceRefs.filter(u => u.includes('-side90'));
    const cipFaceRefs = [
      ...detailHeadFirst,   // closest face reference at slot 0 (heaviest weight)
      ...front34Refs,       // front-facing across arc states
      ...side90Refs,        // jawline reference
      ...existingImages     // user originals (natural-light ground truth)
    ];

    logger.info(`Character sheet for ${name}: ${newImageUrls.length} Flux views (identity-anchored) + ${existingImages.length} originals (style context) = ${allRefs.length} total refs (CIP face refs: ${cipFaceRefs.length})`);

    // 7. V4 Phase 9 — Canonical Identity Portrait (CIP) stage.
    //
    // Even with Flux views front-loaded, different beats pull different
    // subsets — hero for B-roll, closeup for TALKING_HEAD, fullbody-side
    // for action. Subtle facial drift accumulates across beats.
    //
    // The CIP stage runs one MORE Flux pass that distills all refs into a
    // SINGLE neutral-lit front-facing canonical portrait, then generates
    // 2 companion views (3/4 left + 3/4 right) from that canon. The result
    // is a 3-view Identity Anchor Set where the ONLY variance between views
    // is angle — no stylistic variance. This is the AI-pipeline equivalent
    // of a casting "screen test" reference.
    //
    // Opt-out via V4_CIP_STAGE=false for debug / cost-conscious runs.
    let canonicalIdentityUrls = [];
    if (process.env.V4_CIP_STAGE !== 'false') {
      try {
        canonicalIdentityUrls = await this._generateCanonicalIdentityPortrait({
          name,
          personaIndex,
          description,
          styleHint,
          allRefs,
          // CIP-quality fix (2026-04-29) — boundary between Flux-generated
          // sheets and user-uploaded originals in allRefs. The CIP three-quarter
          // tier-3 ref-stack uses this to pick exactly ONE act1 sheet and ONE
          // user original (the rest are dropped to keep the call under fal.ai's
          // 10MP input+output cap AND to avoid arc-state averaging that muddies
          // the angle-lock).
          numFluxViews: newImageUrls.length,
          // V4 P-character-sheet-richness — face-bearing subset for the CIP
          // front anchor (excludes rear views that have no face data and
          // can trip fal.ai's content checker on fitted clothing).
          faceRefs: cipFaceRefs,
          userId,
          baseSeed,
          // V4 Phase 7 — thread commercial_brief so non-photoreal styles get
          // a stylized CIP (cel-shaded screen test) instead of the photoreal
          // default. Identity (visual_anchor + facial structure) still drives
          // identity layer; style governs RENDERING.
          commercialBrief: story?.commercial_brief || null
        });
        if (canonicalIdentityUrls.length > 0) {
          logger.info(`  ${name} CIP: ${canonicalIdentityUrls.length} canonical view(s) generated — identity locked`);
        }
      } catch (cipErr) {
        logger.warn(`CIP stage failed for ${name} — falling back to ordered reference_image_urls: ${cipErr.message}`);
        canonicalIdentityUrls = [];
      }
    }

    return {
      ...persona,
      reference_image_urls: allRefs,
      canonical_identity_urls: canonicalIdentityUrls,
      omnihuman_seed_image_url: newImageUrls[0], // hero shot
      // Phase 5 — arc-state variant map (empty when legacy mode is active)
      sheet_variants: Object.keys(sheetVariants).length > 0 ? sheetVariants : (persona.sheet_variants || null),
      character_sheet_director_meta: csdMeta
    };
  }

  /**
   * V4 Phase 9 — Canonical Identity Portrait stage.
   *
   * Produces a 3-view Identity Anchor Set (front, 3/4 left, 3/4 right) where
   * the ONLY variance between views is camera angle. No wardrobe / hair /
   * makeup / lighting variance — this is the pure identity anchor used to
   * eliminate face drift across beats.
   *
   * Step 1: One Flux Edit pass with all refs → single neutral portrait
   * Step 2: That portrait becomes the anchor ref for 2 more angled views
   *
   * Returns an array of 1-3 public URLs, ordered [front, left-3/4, right-3/4].
   * Returns empty array if Flux isn't available — caller falls back to
   * ordered reference_image_urls.
   */
  async _generateCanonicalIdentityPortrait({ name, personaIndex, description, styleHint, allRefs, numFluxViews = null, faceRefs = null, userId, baseSeed, commercialBrief = null }) {
    if (!fluxFalService.isAvailable()) return [];

    logger.info(`  ${name}: canonicalizing identity (CIP stage)...`);

    // V4 Phase 7 — when commercial_brief.style_category is non-photoreal-strong,
    // generate the CIP in the target style (cel-shaded screen test, painterly
    // screen test, etc.) so beats that reference the CIP downstream get a
    // stylized identity anchor instead of a photoreal one being repeatedly
    // re-stylized per beat. Identity (visual_anchor.gender / age / facial
    // structure) still drives the face; style governs RENDERING.
    const stylizedCip = isStylizedStrong(commercialBrief);
    const semiStyleCip = !stylizedCip && isNonPhotorealStyle(commercialBrief);
    const cipStyleCategory = resolveStyleCategory(commercialBrief);

    // Neutral-lit front-facing portrait that distills all refs into ONE face.
    // The prompt explicitly negates stylistic variance and instructs the model
    // to produce a "screen test" reference — flat even lighting, neutral
    // expression, neutral hair, neutral wardrobe. The point is to strip away
    // everything that varies across the input refs so only the facial
    // structure remains.
    let cipFrontPrompt;
    if (stylizedCip) {
      // Stylized CIP — render in target art style. Identity language preserved
      // (same facial structure, same hair, same gender/age) but the rendering
      // language switches to cel-shaded / painterly / etc.
      const stylePresetLanguage = ({
        hand_doodle_animated: 'cel-shaded portrait, Studio-Ghibli-style line work, flat shadow planes, ink-line edges, hand-drawn texture',
        surreal_dreamlike:    'painterly portrait, soft impasto brushstrokes, dreamlike chiaroscuro, hand-rendered surface texture, oil-on-canvas feel'
      })[cipStyleCategory] || `${cipStyleCategory} stylized portrait`;
      cipFrontPrompt = [
        `CANONICAL IDENTITY PORTRAIT (${cipStyleCategory} stylization) — screen test reference frame in target art style.`,
        'Front-facing, straight-on, eye-level, neutral relaxed expression (slight closed mouth, no smile, no frown).',
        'Even lighting at art-direction level (flat shadow planes, no dramatic studio shadows).',
        'Neutral hair (styled simply), neutral clean wardrobe (plain garment, no distinctive details).',
        'Clean uniform background, character fully isolated.',
        `Subject: ${description}.`,
        styleHint ? `Style context: ${styleHint}.` : '',
        `Render in ${stylePresetLanguage}. NOT photoreal.`,
        'IMPORTANT: preserve facial STRUCTURE from reference images (inter-ocular distance, nose geometry, jawline, lip shape, ear placement) — these are invariant; only the rendering style changes. Same person, same character, stylized rendering.',
        'Reference images describe the actor in photoreal form; render the actor reinterpreted in the target art style — same archetype, same face structure, stylized surface treatment.',
        'Sharp facial detail at the art-direction level, head-and-shoulders framing, VERTICAL 9:16 portrait.',
        'No text, no watermark, no letterbox.'
      ].filter(Boolean).join(' ');
    } else {
      // Photoreal CIP path — unchanged from Phase 9 baseline. Semi-stylized
      // (vaporwave_nostalgic / painterly_prestige) keeps photoreal identity
      // since the style is grade-level / texture-level, not rendering-level.
      cipFrontPrompt = [
        'CANONICAL IDENTITY PORTRAIT — screen test reference frame.',
        'Front-facing, straight-on, eye-level camera, neutral relaxed expression (slight closed mouth, no smile, no frown).',
        'Flat even studio lighting, no dramatic shadows, no rim light, no colored gels — pure identity reference.',
        'Neutral hair (styled simply, no elaborate styling), neutral clean wardrobe (plain shirt or blouse, no distinctive details).',
        'Clean pure white seamless background, fully isolated.',
        `Subject: ${description}.`,
        styleHint ? `Style context: ${styleHint}.` : '',
        semiStyleCip ? `Style note: brief.style_category = "${cipStyleCategory}" — CIP stays photoreal; style applies later in grade/texture, not at the identity-anchor stage.` : '',
        'IMPORTANT: preserve exact facial structure from reference images — inter-ocular distance, nose geometry, jawline, lip shape, brow arch, ear placement. These are invariant.',
        'Reference images may show the subject in varied hair / makeup / wardrobe across different events — extract the CONSTANT facial structure and render it under neutral conditions.',
        'Hyperrealistic photographic quality, sharp facial detail, 85mm lens equivalent, head-and-shoulders framing, VERTICAL 9:16 portrait.',
        'No text, no watermark, no letterbox.'
      ].filter(Boolean).join(' ');
    }

    let frontUrl = null;
    try {
      // V4 P-character-sheet-richness — CIP front uses face-bearing refs only
      // (excludes rear views that contribute zero face data + trip fal.ai's
      // content checker on fitted-clothing rear views). Falls back to
      // allRefs.slice when caller didn't pass faceRefs (legacy fallback path).
      const cipFrontRefs = (Array.isArray(faceRefs) && faceRefs.length > 0)
        ? faceRefs.slice(0, 6)   // 6 face refs ≈ 4MP + 5×1MP + 2MP output ≈ 11MP-ish; fal downsizes refs[2+] further so stays under 10MP cap in practice
        : allRefs.slice(0, 8);
      const frontResult = await fluxFalService.generatePortrait({
        prompt: cipFrontPrompt,
        referenceImages: cipFrontRefs,
        options: {
          aspectRatio: '9:16',
          seed: baseSeed + 100 // offset from character sheet seeds to get a distinct roll
        }
      });
      const frontFilename = `cip-${Date.now()}-${personaIndex}-front.webp`;
      frontUrl = await this._uploadBufferToStorage(
        frontResult.imageBuffer, userId, 'personas/cip', frontFilename, 'image/webp'
      );
      logger.info(`  ${name} CIP front anchor ready: ${frontUrl}`);
    } catch (err) {
      logger.warn(`  ${name} CIP front anchor failed: ${err.message}`);
      return [];
    }

    // Now generate 2 angled views using the CIP front as the DOMINANT
    // reference (appears twice in the input stack to heavily weight it).
    // The result: 3 views, same face, different angles, same conditions.
    //
    // V4 Phase 7 — when CIP front was rendered in stylized form (cel-shaded /
    // painterly), the angle views must preserve that rendering — otherwise
    // the angle views come back photoreal and the 3-view set becomes
    // inconsistent. The "same lighting" / "clean white background" language
    // is replaced with "same rendering style" language.
    const stylizedSuffix = stylizedCip
      ? ` In the SAME ${cipStyleCategory} rendering style as reference image 1 — same line work, same shadow plane treatment, same surface texture.`
      : '';
    const stylizedBg = stylizedCip
      ? 'Clean uniform background matching reference image 1.'
      : 'Clean white background.';
    const angledViews = [
      { label: 'three-quarter-left', prompt: `Same exact person as reference image 1, same exact face, same hair, same wardrobe.${stylizedSuffix} Turn head 3/4 to camera-left (approximately 45 degrees). Neutral relaxed expression. ${stylizedBg} VERTICAL 9:16 portrait. Head-and-shoulders framing.` },
      { label: 'three-quarter-right', prompt: `Same exact person as reference image 1, same exact face, same hair, same wardrobe.${stylizedSuffix} Turn head 3/4 to camera-right (approximately 45 degrees). Neutral relaxed expression. ${stylizedBg} VERTICAL 9:16 portrait. Head-and-shoulders framing.` }
    ];

    const angledUrls = [];

    // CIP three-quarter ref-stack — quality-first 3-ref tier (2026-04-29 fix).
    //
    // Previously: [frontUrl, frontUrl, ...allRefs].slice(0, 8) — packed 8 refs
    // (front doubled + 4 act1/act3 sheets + 3 originals capped to 2). Two
    // production failures observed:
    //   (1) fal.ai 422 errors at the 10MP input+output cap. Story 757e371c
    //       2026-04-29 had 2 of 3 angle calls fail this way, leaving CIP
    //       with only the front view → downstream side-angle beats had no
    //       proper anchor and re-derived sides from the frontal reference
    //       (visible identity drift across cuts).
    //   (2) Quality regression even when the call succeeded: act3 sheets
    //       show the persona with the WOUND EXPOSED (per
    //       CharacterSheetDirector.js:266-270 — "body still, eyes wet or
    //       unfocused"). Asking Flux 2 Max for a NEUTRAL three-quarter
    //       angle-lock with act3 in the ref stack averages the act1 (open,
    //       hopeful) and act3 (broken) emotional registers, muddying the
    //       expression on the rendered angle.
    //
    // New stack: 3 carefully-chosen refs.
    //   ref[0]: frontUrl (cip-front)         — fresh identity authority. Flux
    //                                          weights ref[0] heaviest; this
    //                                          is the primary identity signal.
    //   ref[1]: first Flux character sheet   — by CharacterSheetDirector
    //           (allRefs[0])                   convention this is act1-hero
    //                                          (matching arc state, open
    //                                          register). Wardrobe + lighting
    //                                          context.
    //   ref[2]: first user original          — natural-light ground truth.
    //           (allRefs[numFluxViews])        Anchor against drift toward
    //                                          generated-only artifacts.
    //
    // Megapixel math: 4MP (ref[0]) + 1MP + 1MP + 2MP output = 8MP
    // (well under fal.ai's 10MP cap; ~2MP of headroom).
    const act1HeroRef = allRefs[0] || null;
    const firstOriginalRef = (numFluxViews != null && allRefs[numFluxViews]) || null;
    const cipRefs = [frontUrl, act1HeroRef, firstOriginalRef].filter(Boolean);
    for (let v = 0; v < angledViews.length; v++) {
      const view = angledViews[v];
      try {
        const result = await fluxFalService.generatePortrait({
          prompt: view.prompt + ` IMPORTANT: preserve exact facial structure from reference 1 — inter-ocular distance, nose geometry, jawline, lip shape, brow arch. Facial bone structure is invariant; only the angle changes.`,
          referenceImages: cipRefs,
          options: {
            aspectRatio: '9:16',
            seed: baseSeed + 200 + v
          }
        });
        const filename = `cip-${Date.now()}-${personaIndex}-${view.label}.webp`;
        const url = await this._uploadBufferToStorage(
          result.imageBuffer, userId, 'personas/cip', filename, 'image/webp'
        );
        angledUrls.push(url);
      } catch (err) {
        logger.warn(`  ${name} CIP ${view.label} failed: ${err.message} — continuing with partial CIP set`);
      }
    }

    return [frontUrl, ...angledUrls];
  }

  // ═══════════════════════════════════════════════════
  // DIRECTOR'S HINTS AUTO-GENERATION
  // ═══════════════════════════════════════════════════

  /**
   * Pure prompt-builder for the wizard director's hint. Extracted from
   * `generateDirectorsHint` so prompt construction is unit-testable without
   * mocking Vertex.
   *
   * The REFERENCE PALETTE framing line is load-bearing: the three explicit
   * moves (borrow / blend / transcend) and the "do NOT pick the nearest match"
   * guard against Gemini latching onto the closest-matching named exemplar
   * and parroting it without thinking.
   */
  _buildDirectorsHintPrompt({
    storyFocus = 'product',
    genre = 'drama',
    tone = 'engaging',
    targetAudience = 'young professionals',
    subjectContext = '',
    personaContext = '',
    brandContext = '',
    genreRegister = '',
    referencePalette = '',
    variation = 1
  } = {}) {
    const angles = {
      1: 'Focus on CINEMATOGRAPHY: Describe the lens, lighting setup, color grading, camera movements, and film stock. Reference specific cinematographers (Roger Deakins, Bradford Young). Be technical and visual.',
      2: 'Focus on EMOTION & PACING: Describe the emotional rhythm, tension curve, silence vs intensity. Reference pacing styles (Thelma Schoonmaker jump cuts, Terrence Malick contemplative, Edgar Wright kinetic).',
      3: 'Focus on FILM REFERENCES: Name 2-3 specific films or directors whose style should inspire this. Describe what to borrow from each — the specific visual/tonal quality.',
      4: 'Focus on SENSORY EXPERIENCE: Describe textures, sounds, temperature of each frame. Reference sensory-rich filmmakers (Wong Kar-Wai, Sofia Coppola, Denis Villeneuve).',
      5: 'WILDCARD — find an unexpected creative angle. Maybe a musical analogy, an architectural principle, a painting movement. Surprise the user.'
    };

    return `You are an Oscar-winning film director writing a 2-3 sentence creative brief for a branded short film series.

STORY CONTEXT:
- Focus: ${storyFocus} (${storyFocus === 'person' ? 'character-driven' : storyFocus === 'landscape' ? 'location cinema' : 'character story featuring this product as a naturalistic prop (Hollywood placement, not commercial showcase)'})
- Genre: ${genre}
- Tone: ${tone}
- Target audience: ${targetAudience}
${subjectContext ? '\n' + subjectContext : ''}
${personaContext ? '\n' + personaContext : ''}
${brandContext}

${genreRegister}

REFERENCE PALETTE — Cannes-Lion / Super Bowl / D&AD-caliber commercial work, included to spark synthesis. This is a PALETTE, not a multiple-choice menu and not a checklist. Your move can be any of: (a) borrow one whole-cloth if it genuinely fits this story, (b) blend two or three into a new gesture, (c) reject the lot and invent something new at the same caliber. Do NOT pick the nearest match by default — the goal is the right idea for THIS story, not the closest available. The library exists to raise the altitude of your thinking:
${referencePalette}

YOUR CREATIVE ANGLE:
${angles[variation] || angles[1]}

Write a vivid, specific, 2-3 sentence director's creative brief. It should read like a director pitching their vision to a cinematographer — precise, evocative, referencing specific techniques, films, or visual languages. NO generic advice. NO lists. Just a concentrated cinematic vision statement.

Respond with ONLY the director's brief text — no quotes, no labels, no JSON.`;
  }

  /**
   * Generate a director's creative brief using all available story context.
   * Each variation (1-5) focuses on a different creative angle.
   */
  async generateDirectorsHint(userId, options = {}) {
    const {
      storyFocus = 'product', genre = 'drama', tone = 'engaging',
      targetAudience = 'young professionals', brandKitJobId,
      subject, personas = [], variation = 1
    } = options;

    let brandContext = '';
    if (brandKitJobId) {
      try {
        const job = await getMediaTrainingJobById(brandKitJobId, userId);
        if (job?.brand_kit) brandContext = _buildBrandKitContextBlock(job.brand_kit);
      } catch (e) { /* fine */ }
    }

    const subjectContext = subject?.name
      ? `SUBJECT: "${subject.name}" (${subject.category || ''}). ${subject.description || ''} Visual: ${subject.visual_description || ''}`
      : '';

    const personaContext = personas.length > 0
      ? `CHARACTERS: ${personas.join('; ')}`
      : '';

    // V4 enrichment: genre-specific cinematic register + curated commercial
    // reference palette. Both come from the same modules CreativeBriefDirector
    // and the four checkpoint rubrics use, so the hint endpoint inherits the
    // V4 source of truth automatically when the library or genre map evolves.
    const genreRegister = buildGenreRegisterHint(genre);
    const referencePalette = formatReferenceLibraryForPrompt({ limit: 6 });

    const prompt = this._buildDirectorsHintPrompt({
      storyFocus, genre, tone, targetAudience,
      subjectContext, personaContext, brandContext,
      genreRegister, referencePalette,
      variation
    });

    // V4 uses Vertex AI Gemini (not AI Studio).
    if (!isVertexGeminiConfigured()) {
      throw new Error('Vertex Gemini not configured — set GCP_PROJECT_ID and GOOGLE_APPLICATION_CREDENTIALS_JSON (or ADC)');
    }

    // Token budget: 4096 (was 512). Gemini 3 Flash Preview uses thinking
    // tokens before the visible output; 512 truncates even short prompts.
    // See Day 0 2026-04-11 fix notes in services/v4/VoiceAcquisition.js.
    // Timeout: 90s — thinking-token latency on Gemini 3 Flash regularly
    // exceeds the 30s previously hard-coded here, causing ECONNABORTED.
    const hint = (await callVertexGeminiText({
      userPrompt: prompt,
      config: {
        maxOutputTokens: 4096,
        temperature: 1.0
      },
      timeoutMs: 90000
    }))?.trim();

    if (!hint) throw new Error('Gemini returned empty hint');

    logger.info(`Director's hint (variation ${variation}): ${hint.slice(0, 80)}...`);
    return hint;
  }

  // ═══════════════════════════════════════════════════
  // AUTO-GENERATE PERSONA FROM BRAND KIT
  // ═══════════════════════════════════════════════════

  /**
   * Generate persona(s) that match a Brand Kit's identity.
   * Uses Gemini to design the character(s) from brand analysis,
   * then Flux 2 Max to generate a reference portrait.
   *
   * @param {string} brandKitJobId - ID of the Brand Kit media training job
   * @param {string} userId
   * @param {Object} options - { count: 1-3, storyFocus: 'person'|'product'|'landscape' }
   * @returns {Promise<Object[]>} Array of persona objects with reference_image_urls
   */
  async generatePersonaFromBrandKit(brandKitJobId, userId, options = {}) {
    const { count = 1, storyFocus = 'product' } = options;

    // Load Brand Kit analysis
    const job = await getMediaTrainingJobById(brandKitJobId, userId);
    if (!job?.brand_kit) throw new Error('Brand Kit has no analysis — run Brand Kit analysis first');

    const brandKit = job.brand_kit;
    const brandContext = _buildBrandKitContextBlock(brandKit);

    // Step 1: Vertex AI Gemini generates persona descriptions that fit the brand.
    // If the Brand Kit has real people photos, Gemini describes each one so the
    // generated persona LOOKS LIKE the actual brand person (not a random face).
    if (!isVertexGeminiConfigured()) {
      throw new Error('Vertex Gemini not configured — set GCP_PROJECT_ID and GOOGLE_APPLICATION_CREDENTIALS_JSON (or ADC)');
    }

    // Collect real people from Brand Kit extracted assets + descriptions
    const extractedPeople = (brandKit.extracted_assets || []).filter(a => a.type === 'person');
    const peopleDescriptions = brandKit.people || [];

    const focusGuidance = storyFocus === 'person'
      ? 'This persona IS the star — a compelling, camera-ready individual whose face and presence will anchor every episode. Design someone who looks like a lead actor in a prestige TV series.'
      : storyFocus === 'landscape'
        ? 'This persona is a GUIDE through a beautiful space — think travel host, architecture narrator, or real estate presenter. They should look approachable, expressive, and photogenic but not steal focus from the environment.'
        : 'This persona interacts with a PRODUCT — think lifestyle model, product reviewer, or brand ambassador. They should look authentic, relatable to the target audience, and complement the product aesthetically.';

    // If the brand has real people, tell Gemini to design personas BASED ON them
    // — each person photo is a DIFFERENT individual.
    const realPeopleBlock = extractedPeople.length > 0
      ? `\nREAL BRAND PEOPLE (${extractedPeople.length} distinct individuals found in brand assets):
${extractedPeople.map((p, i) => {
  const desc = peopleDescriptions[i]?.description || p.description || '';
  const role = peopleDescriptions[i]?.role || '';
  return `  Person ${i + 1}: ${desc}${role ? ` (role: ${role})` : ''}`;
}).join('\n')}

CRITICAL: Each person above is a DIFFERENT real individual from the brand's own photos.
Your generated persona(s) must closely MATCH these real people — describe their ACTUAL
appearance as seen in the brand photos (skin tone, hair color/style, approximate age,
build, facial features). The AI portrait generator will use the real person's photo as
a reference image, so your text description must align with what's in that photo.
Do NOT invent a completely different-looking person — describe the real person you see,
then add personality, wardrobe, and character depth on top.
${count <= extractedPeople.length ? `Generate exactly ${count} persona(s), one for each of the first ${count} brand person(s) above.` : `Generate ${count} persona(s) — use the ${extractedPeople.length} real brand person(s) first, then create additional character(s) that complement them.`}\n`
      : '';

    const systemPrompt = `You are the show-runner casting the leads of a prestige limited series. You are not writing ad copy. You are building CHARACTERS — the kind an Emmy-nominated actor would sign on to play. Each character must have interiority, contradiction, a voice you can hear in one line, and a specific reason to exist in THIS brand's world.

Design ${count} character(s) whose appearance, vibe, voice, and interior life match the brand below. The characters will speak on camera across 8-12 episodes. They must be able to sustain conflict, comedy, revelation, and escalation — not just say one tagline.

${brandContext}
${realPeopleBlock}
${focusGuidance}

For each character produce a full character bible. Every field is load-bearing — none are decoration.

1. name — fitting first name (cultural fit with brand).
2. appearance — Detailed physical description for AI image generation (age range, ethnicity, build, hair, facial features, expression, clothing style). Be SPECIFIC — this drives a portrait generator. 100+ words.${extractedPeople.length > 0 ? ' For personas based on real brand people, describe what you see in their photos — the generator will use their actual photo as input.' : ''}
3. wardrobe_hint — One-line wardrobe for the first episode (matches brand aesthetic).
4. personality — Three adjectives, each paired with a behavioural specific (NOT "charming" but "charming — disarms hostility with unexpected honesty").
5. dramatic_archetype — choose ONE of: HERO | ANTIHERO | MENTOR | TRICKSTER | SKEPTIC | ZEALOT | INGENUE | OUTSIDER | AUTHORITY | REBEL | WOUNDED_HEALER | GATEKEEPER.
6. want — What they pursue consciously. One sentence. Must be visible on screen within the first two episodes.
7. need — What they actually require to grow, usually at odds with the want. One sentence. The secret engine of their arc.
8. wound — One past fact, never a vague "trauma". Must be a sentence containing a SPECIFIC NOUN (a person, a place, a date, an object). This is the pressure point that shapes their subtext.
9. flaw — The mistake they repeat under pressure. One sentence.
10. core_contradiction — The productive tension inside them (e.g. "an optimist who keeps their bags packed", "a cynic who cannot stop hoping").
11. moral_code — One sentence. The line they CLAIM they won't cross, or actually won't.
12. relationship_to_subject — 1-2 sentences tying them to the brand's subject / product / place in a STORY-BEARING way. Not "enjoys the product"; something like "inherited the shop from her grandmother and is one bad quarter away from closing it".
13. relationships — If other characters exist, one entry per pairing: { other_persona_index, dynamic: "sibling rivalry with love underneath", unresolved: "the thing they never said aloud" }. The unresolved line drives subtext.
14. speech_patterns — the character's voice as a craft weapon:
    - vocabulary: register (e.g. "precise corporate", "working-class Dublin", "academic hedged", "street laconic", "theatrical baroque")
    - sentence_length: rhythm (e.g. "clipped 3-6 word fragments", "long unfurling sentences", "starts long, snaps short when cornered")
    - tics: array of 2-4 recurring verbal habits — a filler, a deflection, a sign-off, a metaphor family
    - avoids: array of 2-3 linguistic moves they never do (e.g. "never says I love you", "never swears", "never uses first names — only titles")
    - signature_line: ONE example line only THEY would say, in their own voice. This is a tuning-fork the screenwriter matches against.
15. voice_brief — delivery direction for the synthesis layer:
    - emotional_default (e.g. "quietly amused", "coiled patience", "brittle cheer")
    - pace: slow | medium | fast | variable
    - warmth: cold | neutral | warm
    - power: low-status | equal | high-status
    - vocal_color: breathy | resonant | nasal | gravelly

HARD RULES:
- Two characters in the same cast MUST have distinct vocabularies, sentence rhythms, archetypes, AND avoidance lists. If two characters sound alike, rewrite one.
- Characters derived from real brand people keep their PHYSICAL likeness; interiority is invented to FIT what's visible in the photo.
- No "quirky" for quirky's sake. Every tic must be justifiable as a defence mechanism, a power move, a class marker, or a wound symptom.
- Genre-neutral fields. Do not assume drama — the same schema serves action, comedy, thriller, mystery, warm-heart, horror. Tone sits in the brand context, not in the character.
- The appearance must feel AUTHENTIC to the brand's target audience. A luxury brand gets refined, elegant personas. A streetwear brand gets edgy, urban personas. A wellness brand gets serene, natural personas.

Respond with ONLY valid JSON:
{ "personas": [ { "name", "appearance", "wardrobe_hint", "personality", "dramatic_archetype", "want", "need", "wound", "flaw", "core_contradiction", "moral_code", "relationship_to_subject", "relationships", "speech_patterns", "voice_brief" } ] }`;

    const raw = await callVertexGeminiText({
      userPrompt: systemPrompt,
      config: {
        maxOutputTokens: 4096,
        temperature: 0.9,
        responseMimeType: 'application/json'
      },
      timeoutMs: 90000
    });
    if (!raw) throw new Error('Gemini returned empty response for persona generation');

    const parsed = this._parseGeminiJson(raw);
    const geminiPersonas = parsed.personas || [parsed];

    // Step 2: Generate a portrait for each persona via fal.ai Flux 2 Max
    // (migrated from Replicate on 2026-04-11 — same model, unified vendor surface).
    if (!fluxFalService.isAvailable()) {
      throw new Error('FAL_GCS_API_KEY not set — required for V4 auto-persona character sheet generation via Flux 2 Max');
    }

    // Build per-persona reference image arrays.
    // Priority: the matching real person's cutout (strongest identity signal) first,
    // then other brand people photos (style/ethnicity context), NO logos (waste slots).
    // Flux 2 Max accepts up to 8 input_images — use all available.
    const allPersonCutouts = extractedPeople.map(p => p.url).filter(Boolean);

    const sc = brandKit.style_characteristics || {};
    const styleHint = [sc.overall_aesthetic, sc.photography_style, sc.mood].filter(Boolean).join(', ');

    const results = [];
    for (let i = 0; i < Math.min(geminiPersonas.length, count); i++) {
      const p = geminiPersonas[i];
      const baseSeed = Math.floor(Math.random() * 2147483647);

      // Build input_images for THIS persona:
      // 1st: this persona's own brand person cutout (if exists) — strongest identity anchor
      // 2nd-Nth: other brand person cutouts (for style/demographic context, not identity)
      // This ensures Flux generates a face that matches the real brand person.
      const thisPersonCutout = allPersonCutouts[i] || null;
      const otherPeopleCutouts = allPersonCutouts.filter((_, idx) => idx !== i);
      const personaInputImages = [
        thisPersonCutout,
        ...otherPeopleCutouts
      ].filter(Boolean).slice(0, 8);

      logger.info(`[Persona ${i + 1}] input_images: ${thisPersonCutout ? '1 primary cutout' : 'no cutout'} + ${Math.max(0, personaInputImages.length - (thisPersonCutout ? 1 : 0))} other refs = ${personaInputImages.length} total`);

      // Character sheet views — inspired by Imagine.art's character design workflow.
      // Multiple views of the same character give Kling's @Element stronger identity data.
      const views = [
        {
          label: 'hero',
          prompt: `Cinematic film still portrait, full body shot, 3/4 front view at 45 degrees. ${p.appearance}. ${p.wardrobe_hint ? 'Wearing: ' + p.wardrobe_hint + '.' : ''} ${styleHint ? 'Style: ' + styleHint + '.' : ''} Hyperrealistic, soft wrap-around studio lighting, subtle rim light from behind, even full-body illumination, slight cinematic contrast. Eye-level camera, 85mm equivalent, sharp head-to-toe focus. Pure white seamless studio background, fully isolated character. 8K, sharp material textures, photographic quality. No text, no watermark.`,
          aspect: '9:16'
        },
        {
          label: 'closeup',
          prompt: `Close-up cinematic portrait, head and shoulders, looking directly at camera. ${p.appearance}. Dramatic shallow depth of field, catch-lights in eyes, warm skin tones, fine detail on skin texture and facial features. ${styleHint ? 'Style: ' + styleHint + '.' : ''} Soft studio lighting, slight rim light. White background. Photorealistic, 8K detail. No text, no watermark.`,
          aspect: '1:1'
        },
        {
          label: 'fullbody-side',
          prompt: `Full body pure side profile, 90 degree angle. ${p.appearance}. ${p.wardrobe_hint ? 'Wearing: ' + p.wardrobe_hint + '.' : ''} Standing tall, natural relaxed posture. Sharp head-to-toe focus, even studio lighting. White seamless background. Hyperrealistic, photographic quality. No text, no watermark.`,
          aspect: '9:16'
        }
      ];

      logger.info(`Generating character sheet for ${p.name} (${views.length} views)...`);

      const personaImageUrls = [];
      let heroInputImages = [...personaInputImages]; // Start with this persona's brand person refs

      for (let v = 0; v < views.length; v++) {
        const view = views[v];

        // V4 migration 2026-04-11: auto-persona character sheets now go through
        // fal.ai Flux 2 Max via FluxFalService (FAL_GCS_API_KEY) instead of
        // Replicate. Same model, unified vendor surface with the rest of V4.
        let imageBuffer;
        try {
          const portraitResult = await fluxFalService.generatePortrait({
            prompt: view.prompt,
            referenceImages: heroInputImages,
            options: {
              aspectRatio: view.aspect,
              seed: baseSeed + v
            }
          });
          imageBuffer = portraitResult.imageBuffer;
        } catch (err) {
          logger.warn(`${p.name} ${view.label} view: fal.ai Flux 2 Max failed — ${err.message} — skipping`);
          continue;
        }

        const filename = `auto-persona-${Date.now()}-${i}-${view.label}.webp`;
        const imageUrl = await this._uploadBufferToStorage(
          imageBuffer, userId, 'personas', filename, 'image/webp'
        );
        personaImageUrls.push(imageUrl);

        // After hero shot, prepend it as the strongest identity anchor for subsequent views.
        // The generated hero IS this persona — subsequent views must match it exactly.
        if (v === 0) {
          heroInputImages = [imageUrl, ...personaInputImages].slice(0, 8);
        }

        logger.info(`  ${p.name} ${view.label} uploaded: ${imageUrl}`);
      }

      if (personaImageUrls.length === 0) {
        logger.warn(`Failed to generate any views for persona ${p.name} — skipping`);
        continue;
      }

      results.push({
        name: p.name,
        description: `${p.name} — ${p.personality}`,
        personality: p.personality,
        appearance: p.appearance,
        wardrobe_hint: p.wardrobe_hint,
        reference_image_urls: personaImageUrls,
        omnihuman_seed_image_url: personaImageUrls[0], // hero shot
        // Store the original brand person cutout URL so downstream (storyboard, Kling)
        // can use the REAL person photo alongside the generated character sheet
        brand_person_source_url: thisPersonCutout || null,

        // V4 character-bible fields — optional, consumed by the screenplay cheat-sheet
        // and downstream (VoiceAcquisition, validator). All fields fall back to null
        // for legacy personas where Gemini returns only the old schema.
        dramatic_archetype: p.dramatic_archetype || null,
        want: p.want || null,
        need: p.need || null,
        wound: p.wound || null,
        flaw: p.flaw || null,
        core_contradiction: p.core_contradiction || null,
        moral_code: p.moral_code || null,
        relationship_to_subject: p.relationship_to_subject || null,
        relationships: Array.isArray(p.relationships) ? p.relationships : [],
        speech_patterns: p.speech_patterns || null,
        voice_brief: p.voice_brief || null
      });

      logger.info(`Character sheet for ${p.name}: ${personaImageUrls.length} views ready`);
    }

    if (results.length === 0) throw new Error('Failed to generate any persona character sheets');
    return results;
  }

  // ═══════════════════════════════════════════════════
  // V4 PIPELINE (scene → beat architecture)
  // ═══════════════════════════════════════════════════

  /**
   * V4 episode generation pipeline.
   *
   * The full sequence:
   *   1. Acquire persona voices (Gemini brief → ElevenLabs preset, idempotent)
   *   2. Match Brand Kit → LUT (cached on story.brand_kit_lut_id, idempotent)
   *   3. Gemini scene-graph generation (per-scene, per-beat)
   *   4. Brand safety filter (validate generated dialogue lines)
   *   5. BeatRouter preflight (expand SHOT_REVERSE_SHOT, sum cost, enforce cap)
   *   6. Generate Scene Master panels (Seedream 5 Lite × scenes, parallel)
   *   7. Generate beats sequentially within each scene (endframe chaining for continuity)
   *   8. Generate music bed (ElevenLabs Music sized to assembled duration)
   *   9. Run post-production (correction LUTs → assembly → creative LUT → music mix)
   *   10. Upload final episode video, mark ready, update story_so_far
   *
   * Beat-level resume: every successful beat persists its generated_video_url
   * and endframe_url onto episode.scene_description so partial failures can
   * resume from the next beat instead of restarting the episode.
   *
   * @param {string} storyId
   * @param {string} userId
   * @param {Function} [onProgress] - optional progress callback (stage, detail)
   * @returns {Promise<Object>} the completed episode record
   */
  async runV4Pipeline(storyId, userId, onProgress, resumeOptions = null) {
    // V4 hotfix 2026-05-01 — Resume mode (`resumeOptions.episodeId` set):
    // skip screenplay generation + Lens A + episode creation; pick up the
    // pipeline at Step 6 (Scene Master generation) using the persisted
    // scene_description from the existing episode. Used by Edit & Retry on
    // Lens B halts so the user's synthesized directive lands on the failed
    // scene without losing the episode's prior screenplay/cast/voice work.
    //
    // resumeOptions shape:
    //   { episodeId: string, sceneEdits?: { sceneId, notes?, edited_anchor? } }
    const isResume = !!resumeOptions?.episodeId;

    // SSE emitter is created lazily once we know the episode_id (after the
    // first DB insert). For pre-episode-creation stages we still log + call
    // the legacy callback, but the SSE stream starts at the moment the
    // episode record exists. This matches the natural URL shape:
    // /api/brand-stories/:id/episodes/:episodeId/stream
    let emitter = null;
    if (isResume) {
      try { emitter = getOrCreateProgressEmitter(resumeOptions.episodeId); } catch {}
    }

    const progress = (stage, detail, extras = {}) => {
      logger.info(`[V4Pipeline] ${stage}: ${detail}`);
      if (typeof onProgress === 'function') {
        try { onProgress(stage, detail); } catch {}
      }
      if (emitter) {
        try { emitter.emit(stage, detail, extras); } catch {}
      }
    };

    progress('start', isResume
      ? `V4 pipeline RESUMING for story ${storyId} from episode ${resumeOptions.episodeId}`
      : `V4 pipeline starting for story ${storyId}`);

    // ─── Load story + validate ───
    const story = await getBrandStoryById(storyId, userId);
    if (!story) throw new Error(`V4: story ${storyId} not found`);
    if (!story.storyline) throw new Error(`V4: story ${storyId} has no storyline (run generateStoryline first)`);

    // V4 hotfix 2026-05-01 — Resume mode: load the existing episode now so
    // downstream Steps 3/3b/3c/5 can pull persisted state (sceneGraph,
    // qualityReport, directorReport, episode_number) and skip the
    // upstream-only work (screenplay generation, Lens A judging, episode
    // creation). Apply user edits from `resumeOptions.sceneEdits` to the
    // failed scene right here so the rest of the pipeline sees a clean,
    // edited scene-graph.
    let existingEpisodeForResume = null;
    if (isResume) {
      existingEpisodeForResume = await getBrandStoryEpisodeById(resumeOptions.episodeId, userId);
      if (!existingEpisodeForResume) {
        throw new Error(`V4 resume: episode ${resumeOptions.episodeId} not found`);
      }
      const persisted = existingEpisodeForResume.scene_description || {};
      if (!Array.isArray(persisted.scenes) || persisted.scenes.length === 0) {
        throw new Error(`V4 resume: episode ${resumeOptions.episodeId} has no scene-graph to resume from`);
      }
      // Apply sceneEdits (notes / edited_anchor) to the failed scene IN-PLACE
      // on the persisted scene_description. The mutated copy becomes the
      // sceneGraph the pipeline operates on; the DB write happens at Step 5.
      if (resumeOptions.sceneEdits?.sceneId) {
        const sceneEdits = resumeOptions.sceneEdits;
        const targetScene = (persisted.scenes || []).find(s => s.scene_id === sceneEdits.sceneId);
        if (targetScene) {
          const baseAnchor = sceneEdits.edited_anchor || targetScene.scene_visual_anchor_prompt || targetScene.location || '';
          if (sceneEdits.notes) {
            targetScene.scene_visual_anchor_prompt = `${baseAnchor}. DIRECTOR'S RETAKE NOTE: ${sceneEdits.notes}`.trim();
          } else if (sceneEdits.edited_anchor) {
            targetScene.scene_visual_anchor_prompt = sceneEdits.edited_anchor;
          }
          targetScene.scene_master_url = null;
          progress('resume', `applied user edits to scene ${sceneEdits.sceneId} (notes=${!!sceneEdits.notes}, anchor_rewrite=${!!sceneEdits.edited_anchor})`, {
            episode_id: resumeOptions.episodeId,
            scene_id: sceneEdits.sceneId,
            resume: true
          });
        } else {
          logger.warn(`V4 resume: scene ${sceneEdits.sceneId} not found in persisted scene-graph — proceeding without edits`);
        }
      }
      // Stash the mutated scene-graph back on the episode object for the
      // downstream Step 3 resume branch.
      existingEpisodeForResume.scene_description = persisted;
    }

    // Persist persona_config mutations from voice acquisition / LUT matching
    let personas = Array.isArray(story.persona_config?.personas)
      ? story.persona_config.personas
      : (story.persona_config ? [story.persona_config] : []);

    // Default placeholder names for personas that didn't carry one through
    // the wizard. Only the brand_kit_auto path generates a real name via
    // Gemini; the described/uploaded/brand_kit paths have no name field at
    // all. Without this, every log line about the persona says "unnamed"
    // which makes multi-persona runs nearly unreadable. Assigns "Persona 1",
    // "Persona 2", etc. in the order personas were added to the story.
    // Caught 2026-04-21 — cosmetic only, no downstream dependency on .name.
    personas.forEach((p, i) => {
      if (!p.name || !String(p.name).trim()) p.name = `Persona ${i + 1}`;
    });

    // V4 Audio Layer Overhaul Day 3 — propagate story.language → persona.language.
    //
    // story.language is the user's authorship-language choice from the wizard
    // (ISO 639-1: 'en', 'he', etc.). Personas that already declare a language
    // are preserved verbatim — wizard-explicit always wins. Personas without a
    // language inherit story.language so the dialogue authorship layer (Hebrew
    // masterclass) and the audio layer (eleven-v3 with language_code) both
    // receive a consistent signal.
    //
    // Resolution order (matches _generateV4Screenplay):
    //   story.language → story.subject?.language → null (no propagation)
    // Today the wizard at public/js/marketing.js bundles `language` into
    // creativeSettings → enrichedSubject → story.subject.language. A future
    // top-level `brand_stories.language` column is read first if present.
    //
    // This is a write-back-to-personas pass that runs BEFORE voice acquisition
    // (Day 4 picker filters on persona.language) and BEFORE screenplay
    // generation (Day 3 storyLanguage block reads from story.language with
    // persona[0].language as fallback). Order matters here: personas[] is
    // mutated in-place; the persisted update happens after voice acquisition
    // so a single DB write captures both the language sync and the voice IDs.
    const _rawLang = story.language || story.subject?.language || null;
    const storyLanguage = (_rawLang && typeof _rawLang === 'string')
      ? String(_rawLang).trim().toLowerCase()
      : null;
    if (storyLanguage) {
      let synced = 0;
      personas.forEach((p) => {
        if (!p.language || typeof p.language !== 'string' || !p.language.trim()) {
          p.language = storyLanguage;
          synced++;
        }
      });
      if (synced > 0) {
        progress('voices', `language sync: ${synced} persona(s) inherited story.language="${storyLanguage}"`);
      }
    }

    // ─── Phase 6 — COMMERCIAL pre-flight (runs ONCE per story BEFORE everything else) ───
    //
    // When the story's genre is 'commercial' AND the COMMERCIAL pipeline flag is on,
    // run CreativeBriefDirector first. The brief becomes the foundation for every
    // downstream stage:
    //   • episode-count justification (cap 1-2 vs prestige 3-12)
    //   • visual_style_brief → bespoke per-episode LUT (bypasses BrandKitLutMatcher)
    //   • product_integration_style auto-set to 'commercial' (relaxed dialogue)
    //   • Lens A/D rubrics swap to commercialRubric (creative_bravery / brand_recall / etc.)
    //
    // Cached on story.commercial_brief; subsequent runs skip the Gemini call.
    if (isCommercialGenre(story) && isCommercialPipelineEnabled() && !story.commercial_brief) {
      progress('commercial_brief', 'authoring commercial creative brief (one-time per story)');
      try {
        let brandKitForBrief = null;
        if (story.brand_kit_job_id) {
          try {
            const job = await getMediaTrainingJobById(story.brand_kit_job_id, userId);
            brandKitForBrief = job?.brand_kit || null;
          } catch { /* fine */ }
        }
        const brief = await generateCommercialBrief({
          story,
          brandKit: brandKitForBrief,
          personas
        });
        const { count, reasoning } = resolveCommercialEpisodeCount(brief);
        progress('commercial_brief',
          `brief: concept="${(brief.creative_concept || '').slice(0, 60)}" style=${brief.style_category} episodes=${count}`);
        // Persist on the story so subsequent stages + the screenplay writer
        // can read it. commercial_brief is the source of truth.
        const briefUpdates = {
          commercial_brief: brief,
          // Auto-set product_integration_style to 'commercial' so the screenplay
          // prompt + ScreenplayValidator + reference-stack priority all switch
          // to commercial-register mode.
          product_integration_style: 'commercial',
          // Mirror the count + reasoning at the top level for easy UI access
          commercial_episode_count: count,
          commercial_episode_reasoning: reasoning
        };
        await updateBrandStory(storyId, userId, briefUpdates);
        Object.assign(story, briefUpdates);
      } catch (err) {
        logger.warn(`commercial brief generation failed (${err.message}) — falling through to legacy pipeline`);
      }
    }

    // ─── Step 0b: PersonaVisualAnchor extraction (V4 Phase 5b) ───
    //
    // V4 Wave 6 / hotfix-2026-04-29 — this is now DEFENSE-IN-DEPTH only.
    // The load-bearing extraction site moved up to _autoSetupAvatar (BEFORE
    // CharacterSheetDirector / Flux 2 Max generation at story creation time).
    // This Step 0b backfills:
    //   • legacy stories created before the hotfix-2026-04-29 ordering fix
    //   • personas whose reference_image_urls changed after the avatar setup ran
    // Idempotent — _ensureVisualAnchorsForPersonas skips personas whose anchor
    // already matches the current photo set (vision_call_id cache check).
    {
      const before = personas.filter(p => !p?.visual_anchor?.apparent_gender_presentation).length;
      progress('visual_anchor', `Step 0b backfill check (${before} persona(s) without anchor of ${personas.length} total)`);
      try {
        const result = await this._ensureVisualAnchorsForPersonas(storyId, userId, story, personas);
        if (result.extracted > 0) {
          progress('visual_anchor', `${result.extracted} persona(s) anchored at Step 0b backfill${result.lowConfidence > 0 ? ` — ${result.lowConfidence} low-confidence` : ''}`);
        }
      } catch (err) {
        // Inversion-escalation propagates — surface to the orchestrator's
        // outer try/catch so the episode is marked awaiting_user_review.
        throw err;
      }
    }

    // ─── Step 1: Persona voice acquisition (idempotent) ───
    progress('voices', `acquiring ${personas.length} persona voice(s)`);
    const voiceResult = await acquirePersonaVoicesForStory(personas);
    progress('voices', `acquired=${voiceResult.acquired}, already_assigned=${voiceResult.already_assigned}, failed=${voiceResult.failed}`);
    if (voiceResult.acquired > 0) {
      // Persist newly-acquired voices back to the story
      await updateBrandStory(storyId, userId, {
        persona_config: { ...(story.persona_config || {}), personas }
      });
    }

    // ─── Step 1b: Cast Bible (lazy-derive + idempotent) ───
    //
    // Derive a structural snapshot of the show's cast from storyline.characters[] +
    // persona_config.personas[]. NO Gemini call — purely structural.
    //
    // Sits ABOVE the future Phase-6 commercial-genre branch (per the Cast Bible plan)
    // so commercials also receive a bible. Voice IDs are already on personas at
    // this point thanks to Step 1.
    //
    // Idempotency (Failure Mode #5 in plan): re-derive when bible is missing OR
    // has empty principals AND _generated_by !== 'manual_override'. This protects
    // partial-failure runs (sticky-broken empty bibles) AND preserves manual
    // overrides set via PATCH /cast-bible.
    //
    // Phase 3.5: deriveCastBibleFromStory uses inferPersonaGenderForCast which
    // reads BOTH persona + storyline.characters[i] fields, salvaging gender
    // signal for sparse "Persona N" placeholder personas (the bug surfaced in
    // 2026-04-28 production logs).
    {
      const existing = story.cast_bible;
      const needsDerive = !existing
        || !Array.isArray(existing.principals)
        || existing.principals.length === 0;
      const isManualOverride = existing?._generated_by === 'manual_override';
      if (needsDerive && !isManualOverride) {
        progress('cast_bible', 'deriving cast bible from storyline + personas');
        const bible = deriveCastBibleFromStory({ ...story, persona_config: { ...(story.persona_config || {}), personas } });
        await updateBrandStory(storyId, userId, { cast_bible: bible });
        story.cast_bible = bible;
        const principalCount = bible.principals.length;
        const unknownGenderCount = bible.principals.filter(p => p.gender_inferred === 'unknown').length;
        const mismatchCount = bible.principals.filter(p => p.voice_gender_match === false).length;
        progress('cast_bible', `bible derived (${principalCount} principal(s), unknown_gender=${unknownGenderCount}, voice_mismatch=${mismatchCount})`);

        // V4 Phase 5b — Fix 6. Auto-recast on voice_gender_match=false.
        // Closes the detection-action gap that produced the wrong-gender voice
        // in story `77d6eaaf` (logs.txt 2026-04-28: voice_mismatch=1 detected
        // but no remediation — the cut shipped with the mismatch).
        //
        // The remediation re-runs voice acquisition with force=true on the
        // mismatched personas only. acquirePersonaVoicesForStory's pass-1
        // logic re-evaluates each persona's gender (which now reads
        // visual_anchor first per Fix 1+2) and excludes the wrong-gender
        // voice from the candidate pool, so Gemini casts from a correct-gender
        // shortlist.
        //
        // V4 Wave 6 / F3 — TWO guards layered on the trigger:
        //
        // (1) LOCKED-BIBLE GUARD (correctness — Failure Mode #3 contract).
        // When cast_bible.status === 'locked', auto-recast must NOT mutate
        // voice assignments. The lock is total per the manual-override
        // contract; the user explicitly chose those voices and a silent
        // overwrite would surprise them. Surface the mismatch as a Director
        // Panel chip (F8 "Locked — clear bible to re-cast") instead.
        //
        // (2) VISUAL_ANCHOR CONFIDENCE GUARD (UX-quality). Auto-recast ONLY
        // when the mismatched principal's gender_resolved_from === 'visual_anchor'.
        // Storyline_signal / persona_signal mismatches with voice may reflect
        // intentional cross-casting (storyline says "Marcus" but the persona's
        // wardrobe code reads female — a defensible artistic choice). For
        // those cases, surface an F8 "Voice mismatch — Re-pick" chip and let
        // the user decide manually.
        const bibleLocked = story.cast_bible?.status === 'locked';
        if (bibleLocked && mismatchCount > 0) {
          logger.warn(
            `cast_bible: ${mismatchCount} principal(s) voice-mismatched but bible is LOCKED — ` +
            `skipping auto-recast (lock is total per Failure Mode #3). User must clear the lock ` +
            `via PATCH /cast-bible {bible:null} to re-cast.`
          );
        }
        const mismatchedHighConfidence = bibleLocked
          ? []
          : bible.principals.filter(p =>
              p.voice_gender_match === false
              && p.gender_resolved_from === 'visual_anchor'
            );
        if (mismatchedHighConfidence.length > 0) {
          const mismatchedIndexes = mismatchedHighConfidence.map(p => p.persona_index);
          progress('cast_bible', `auto-recasting ${mismatchedIndexes.length} high-confidence mismatched voice(s) (visual_anchor + unlocked): persona_index=[${mismatchedIndexes.join(',')}]`);

          // Clear stored voice on the mismatched personas so the re-acquire
          // pass treats them as unassigned. The pass-1 hasExistingVoice/
          // existingIsValid block already handles the gender-mismatch case,
          // but explicitly clearing makes the remediation symmetric and the
          // resulting log line clean.
          mismatchedIndexes.forEach(idx => {
            if (personas[idx]) {
              personas[idx].elevenlabs_voice_id = null;
              personas[idx].elevenlabs_voice_brief = null;
              personas[idx].elevenlabs_voice_name = null;
              personas[idx].elevenlabs_voice_justification = null;
              personas[idx].elevenlabs_voice_gender = null;
            }
          });

          const recastResult = await acquirePersonaVoicesForStory(personas, { force: false });
          progress('cast_bible', `recast: acquired=${recastResult.acquired}, remediated=${recastResult.remediated}, failed=${recastResult.failed}`);
          await updateBrandStory(storyId, userId, {
            persona_config: { ...(story.persona_config || {}), personas }
          });

          // Re-derive bible to capture the new voice ids + new
          // voice_gender_match status. Idempotent re-derivation.
          const reBible = deriveCastBibleFromStory({ ...story, persona_config: { ...(story.persona_config || {}), personas } });
          await updateBrandStory(storyId, userId, { cast_bible: reBible });
          story.cast_bible = reBible;
          // V4 Wave 6 / F3 — only count HIGH-CONFIDENCE post-recast mismatches
          // for the "auto-recast failed" warning. Weak-signal residual mismatches
          // are user decisions surfaced via the F8 Director Panel chip, not
          // pipeline-side failures.
          const reMismatchHighConfidence = reBible.principals.filter(p =>
            p.voice_gender_match === false
            && p.gender_resolved_from === 'visual_anchor'
          ).length;
          progress('cast_bible', `post-recast bible: high-confidence voice_mismatch=${reMismatchHighConfidence}`);

          // If STILL high-confidence mismatched after recast (extreme edge
          // case — no voices of correct gender available in the library),
          // log as warning. Story still ships; the cast_bible row carries
          // the unresolved flag for the Director Panel.
          if (reMismatchHighConfidence > 0) {
            logger.warn(
              `cast_bible: ${reMismatchHighConfidence} high-confidence principal(s) still voice-mismatched after auto-recast. ` +
              `Library may lack voices of the required gender. Manual override required via PATCH ` +
              `/api/brand-stories/:id/personas/:idx/voice.`
            );
          }
        }
      }
    }

    // ─── Step 2: Brand Kit → LUT (cached, idempotent) ───
    let brandKit = null;
    if (story.brand_kit_job_id) {
      try {
        const job = await getMediaTrainingJobById(story.brand_kit_job_id, userId);
        brandKit = job?.brand_kit || null;
      } catch (err) {
        logger.warn(`V4: brand kit load failed: ${err.message}`);
      }
    }

    // V4 Phase 5b — Director Agent's verdict (2026-04-29). The previous gate
    // (`if (brandKit && !story.brand_kit_lut_id && !story.locked_lut_id)`) was
    // a root-cause bug: when a story had NO brandKit, NO LUT resolution ran.
    // Gemini got the legacy 8-LUT list from the V4 prompt schema and emitted
    // arbitrary picks (story `77d6eaaf` → bs_cool_noir on a hyperreal commercial).
    //
    // New gate: ALWAYS run resolution when the spec system is on AND the story
    // is not already locked. brandKit is now optional input to the matcher.
    if (!story.brand_kit_lut_id && !story.locked_lut_id) {
      // V4 LUT resolution — TWO COEXISTING SYSTEMS gated by BRAND_STORY_LUT_SPEC_SYSTEM:
      //
      // ▸ SPEC SYSTEM ON (Phase 1+2):
      //   1. matchByGenreAndMood(story) → resolves a genre-anchored creative LUT
      //      from the declarative spec library (no brand-vertical matching)
      //   2. If BRAND_STORY_LUT_GENERATIVE_PRIMARY=true → also generate a
      //      brand-palette LUT (per-genre strength) — applied as a SECOND pass
      //      on top of the genre LUT in PostProduction stage 3
      //
      // V4 P1.2: legacy 8-LUT brand-vertical matcher is retired. Spec system
      // is the only resolution path. Brand-palette LUT trim layered on top of
      // the genre LUT is the default; set BRAND_STORY_LUT_GENERATIVE_PRIMARY=false
      // to disable the brand pass (genre LUT only).
      const generativePrimary =
        String(process.env.BRAND_STORY_LUT_GENERATIVE_PRIMARY || 'true').toLowerCase() !== 'false';

      let resolvedLutId;
      let brandLutId = null;

      // ── SPEC SYSTEM PATH (single canonical resolution) ──────────────
      // V4 Phase 5b — runs unconditionally regardless of brandKit (Fix 3).
      progress('lut', 'spec system: matching genre + mood → genre LUT');
      const genreMatch = await matchByGenreAndMood(story);
      resolvedLutId = genreMatch.lutId;
      progress('lut', `genre LUT → ${resolvedLutId}`);

      // Brand-palette LUT trim only when brandKit is present (no palette
      // → no synthesis input). V4 Phase 7: pass commercial_brief into
      // strength resolution so non-photoreal style_categories get the
      // 0.10 STYLE_BYPASS_STRENGTH instead of the photoreal genre default
      // (a hand_doodle_animated commercial graded at 0.25 commercial-genre
      // strength would smash the cel-shaded look back toward photoreal).
      if (generativePrimary) {
        const genre = story.subject?.genre || story.storyline?.genre;
        const strength = getStrengthForGenreWithStyle(genre, story.commercial_brief);

        if (brandKit) {
          // Brand-kit path — synthesize a brand-palette trim LUT from the
          // user's authored brand colors. Highest fidelity to brand identity.
          progress('lut', `synthesizing brand-palette LUT (genre=${genre}, strength=${strength.toFixed(2)})`);
          try {
            const brandGen = await generateLutFromBrandKit(brandKit, { strength });
            if (brandGen?.lutId) {
              brandLutId = brandGen.lutId;
              progress('lut', `brand trim → ${brandLutId}`);
            } else {
              progress('lut', 'brand palette ineligible (rejected by quality gates) — falling through to story-content trim');
            }
          } catch (err) {
            logger.warn(`V4: brand LUT synthesis failed (${err.message}) — falling through to story-content trim`);
          }
        }

        // V4 hotfix 2026-04-30 — story-content fallback trim layer.
        //
        // When brandKit is null OR the brand-palette path produced no usable
        // trim, derive a trim LUT from the story's GENRE register (using the
        // built-in STORY_TONAL_TRIM_PRESETS map in GenerativeLut.js). This
        // serves as the brand-palette-equivalent SECOND PASS that tempers
        // the genre creative LUT's aggression. Without it, the genre LUT
        // dominates and crushes shadows on dim Veo shots — which is exactly
        // what produced the "noir/B&W" appearance reported on story
        // `4f24ebfa...` (action genre + no brand kit + bs_action_teal_orange_punch
        // applied at full strength = near-monochrome shadow regions).
        //
        // Story-trim runs at the genre's GENRE_STRENGTH (typically 0.10-0.30,
        // same calibration as brand-trim) but uses preset palettes coherent
        // with each genre's visual register. Output id is `gen_*` (cached).
        if (!brandLutId) {
          progress('lut', `synthesizing story-content trim LUT (genre=${genre}, strength=${strength.toFixed(2)}) — no brand kit available`);
          try {
            const storyGen = await generateStoryTrimLut({ genre, brandKit: null, strengthOverride: strength });
            if (storyGen?.lutId) {
              brandLutId = storyGen.lutId;
              progress('lut', `story trim → ${brandLutId} (genre preset: ${storyGen.genrePreset || genre})`);
            } else {
              progress('lut', 'no story-content trim available for this genre — genre LUT only (may produce aggressive grade on dim shots)');
            }
          } catch (err) {
            logger.warn(`V4: story-content trim synthesis failed (${err.message}) — genre LUT only`);
          }
        }
      }

      // V4 P1.2 — spec system always runs, so resolvedLutId is always set
      // (matchByGenreAndMood returns the SPEC_SAFE_FALLBACK if no match).
      // Persist unconditionally.
      if (resolvedLutId) {
        const updates = { brand_kit_lut_id: resolvedLutId };
        if (brandLutId) updates.brand_palette_lut_id = brandLutId;
        await updateBrandStory(storyId, userId, updates);
        story.brand_kit_lut_id = resolvedLutId;
        if (brandLutId) story.brand_palette_lut_id = brandLutId;
      } else {
        progress('lut', 'no LUT resolution path ran (no spec system, no brandKit) — PostProduction will use the safe fallback');
      }
    }

    // ─── Step 2b: Sonic Series Bible (lazy + idempotent — mirrors LUT pattern) ───
    //
    // The bible is the show's sound DNA — palette + grammar + no-fly list +
    // inheritance_policy. Authored once per story by Gemini at first episode
    // generation, locked thereafter (mutable via PATCH). Every per-episode
    // sonic_world inherits from this bible per the inheritance_policy.
    //
    // Director's verdict (V4 Audio Coherence Overhaul, Phase 2): the load-bearing
    // root cause of episode audio incoherence is per-scene ambient_bed_prompt
    // re-rolled fresh by Gemini each scene. The bible eliminates the amnesia.
    //
    // Failure mode: if Gemini fails or the response is invalid, the
    // generateSonicSeriesBible() helper falls through to DEFAULT_SONIC_SERIES_BIBLE
    // (a safe naturalistic restraint default). Pipeline never blocks.
    if (!story.sonic_series_bible) {
      progress('sonic_bible', 'authoring sonic series bible (one-time per story)');
      const personaArchetypes = (personas || [])
        .map(p => p?.archetype || p?.character_summary || null)
        .filter(Boolean);
      const bibleCtx = {
        brandName: story.name,
        genre: story.subject?.genre || story.storyline?.genre,
        tone: story.subject?.tone || story.storyline?.tone,
        thematicArgument: story.storyline?.thematic_argument,
        centralDramaticQuestion: story.storyline?.central_dramatic_question,
        antagonistCurve: story.storyline?.antagonist_curve,
        brandMood: brandKit?.style_characteristics?.mood,
        brandAesthetic: brandKit?.style_characteristics?.overall_aesthetic,
        personaArchetypes,
        referenceShows: story.subject?.reference_shows || story.storyline?.reference_shows || [],
        directorsNotes: story.subject?.directors_notes
      };
      const bible = await generateSonicSeriesBible(bibleCtx);
      await updateBrandStory(storyId, userId, { sonic_series_bible: bible });
      story.sonic_series_bible = bible;
      progress('sonic_bible', `bible authored (${bible._generated_by || 'gemini'}, drone: ${bible.signature_drone?.description?.slice(0, 40) || 'n/a'}...)`);
    }

    // ─── Step 3: Gemini V4 scene-graph generation ───
    progress('screenplay', isResume
      ? `RESUME: skipping screenplay generation — using persisted scene-graph from episode ${resumeOptions.episodeId}`
      : 'generating V4 scene-graph via Gemini');
    const previousEpisodes = await getBrandStoryEpisodes(storyId, userId);
    const previousReady = previousEpisodes.filter(e => e.status === 'ready' || e.status === 'published');
    const previousVisualStyle = story.storyline?.visual_style_prefix || '';
    const lastEpisode = previousReady[previousReady.length - 1];
    const previousEmotionalState = lastEpisode?.scene_description?.emotional_state || '';
    const lastCliffhanger = lastEpisode?.scene_description?.cliffhanger || '';
    const directorsNotes = story.subject?.directors_notes || '';

    // Cost cap is now a flat $20 ceiling (not tier-based) since Brand Story
    // is Business-tier-only. The episodeOverride path is kept so a specific
    // story can opt into a higher cap for a premium campaign.
    const costCapUsd = resolveCostCap({
      episodeOverride: story.episode_cost_cap_usd_override || null
    });

    // episode_number must use ALL existing episodes (regardless of status), not
    // just ready/published ones. Using previousReady.length caused duplicate-key
    // collisions when an earlier episode was stuck in a non-ready status
    // (e.g. 'regenerating_beat' or 'failed') — it wasn't counted, so the new
    // episode got episode_number=1 and collided with the existing row.
    // Caught 2026-04-11: Episode 1 stuck in 'regenerating_beat' → Generate
    // Episode 2 → previousReady=[] → episode_number=1 → UNIQUE violation.
    const nextEpisodeNumber = isResume
      ? existingEpisodeForResume.episode_number
      : (previousEpisodes.length + 1);

    let sceneGraph = isResume ? existingEpisodeForResume.scene_description : await this._generateV4Screenplay({
      story,
      personas,
      previousEpisodes: previousReady.slice(-3), // last 3 READY episodes for continuity
      brandKit,
      previousVisualStyle,
      previousEmotionalState,
      lastCliffhanger,
      directorsNotes,
      costCapUsd,
      hasBrandKitLut: !!story.brand_kit_lut_id || !!story.locked_lut_id,
      episodeNumber: nextEpisodeNumber
    });

    progress('screenplay', `episode "${sceneGraph.title}" — ${sceneGraph.scenes?.length || 0} scenes`);

    // ─── Step 3b: Screenplay quality gate (Layer 1 validator + optional Doctor) ───
    // Layer 1: deterministic checks on the scene graph. Auto-repairs beat sizing.
    // Layer 2 (gated by env flag): Gemini script-doctor minimal-patch punch-up.
    // On any failure the pipeline proceeds with the best scene graph we have —
    // we never loop, we never block. The quality_report is persisted so the
    // Director's Panel can surface Layer-1 issues and Layer-2 edits for review.
    const storyFocus = story.story_focus || 'product';
    // Phase 4 — pass productIntegrationStyle so the validator's anti-ad-copy
    // and brand-name-in-dialogue gates apply correctly. Default is naturalistic
    // for product-focus stories; explicit setting (wizard or commercial-genre
    // override) takes precedence.
    const productIntegrationStyleForValidator = story.product_integration_style || 'naturalistic_placement';
    // Phase 3 — pass genre into validatorOpts so the genre-aware dialogue
    // floor (resolveDialogueFloor) can fire when BRAND_STORY_VALIDATOR_PARAMETERIZED
    // and BRAND_STORY_GENRE_REGISTER_LIBRARY are both true. Genre lives on the
    // storyline payload; falls back to drama if absent (matches the prompt
    // default).
    const validatorOpts = {
      genre: story.storyline?.genre || 'drama',
      storyFocus,
      sonicSeriesBible: story.sonic_series_bible || null,
      productIntegrationStyle: productIntegrationStyleForValidator,
      subject: story.subject,
      brandKit,
      // V4 Phase 5b — Fix 7. The brief-coherence validator (anchor vs
      // brief.style_category) needs the commercial_brief in scope. Other
      // validators (dialogue density, monoculture) read it for opt-out
      // signals (voiceover-heavy briefs skip the dialogue-thin warning).
      commercialBrief: story.commercial_brief || null
    };
    // V4 hotfix 2026-05-01 — Resume mode: load persisted qualityReport
    // from existing episode (Layer 1 validator + Doctor already ran during
    // the original pipeline pass; re-running them on the same scene-graph
    // would be a no-op at best and could re-flag warnings the user already
    // moved past).
    let qualityReport = isResume
      ? (existingEpisodeForResume.quality_report || { validator: null, doctor: null })
      : { validator: null, doctor: null };
    if (!isResume) try {
      const layer1 = validateScreenplay(sceneGraph, story.storyline || {}, personas, validatorOpts);
      qualityReport.validator = { issues: layer1.issues, stats: layer1.stats };
      sceneGraph = layer1.repaired;
      const blockerList = layer1.issues.filter(i => isBlockerOrCritical(i.severity));
      const warningList = layer1.issues.filter(i => i.severity === 'warning');
      const blockerIds = blockerList.map(i => i.id).join(', ') || 'none';
      const warningIds = warningList.map(i => i.id).join(', ') || 'none';
      progress('screenplay_qa', `Layer-1: ${blockerList.length} blocker(s) [${blockerIds}], ${warningList.length} warning(s) [${warningIds}]`, {
        blockers: blockerList.length, warnings: warningList.length, stats: layer1.stats
      });

      if (layer1.needsPunchUp) {
        progress('screenplay_qa', 'Layer-2 Doctor pass triggered');
        const layer2 = await punchUpScreenplay(sceneGraph, personas, layer1.issues);
        qualityReport.doctor = {
          applied: layer2.applied,
          rejected: layer2.rejected,
          notes: layer2.notes,
          skipped: layer2.skipped
        };
        if (layer2.skipped) {
          progress('screenplay_qa', `Doctor skipped: ${layer2.skipped}`);
        } else {
          sceneGraph = layer2.patched;
          progress('screenplay_qa', `Doctor applied ${layer2.applied.length} edits`);
          // Re-run Layer 1 once to capture post-doctor state in the report.
          // We do NOT loop — a second blocker list just gets logged.
          const layer1b = validateScreenplay(sceneGraph, story.storyline || {}, personas, validatorOpts);
          qualityReport.validator_post_doctor = { issues: layer1b.issues, stats: layer1b.stats };
          sceneGraph = layer1b.repaired;
          const postDocBlockerList = layer1b.issues.filter(i => isBlockerOrCritical(i.severity));
          const postDocWarningList = layer1b.issues.filter(i => i.severity === 'warning');
          const postDocBlockerIds = postDocBlockerList.map(i => i.id).join(', ') || 'none';
          const postDocWarningIds = postDocWarningList.map(i => i.id).join(', ') || 'none';
          progress('screenplay_qa', `Layer-2 re-validation: ${postDocBlockerList.length} blocker(s) [${postDocBlockerIds}], ${postDocWarningList.length} warning(s) [${postDocWarningIds}]`, {
            blockers: postDocBlockerList.length, warnings: postDocWarningList.length, stats: layer1b.stats
          });
        }
      }
    } catch (err) {
      logger.warn(`V4 screenplay quality gate failed (${err.message}) — proceeding with original scene graph`);
      qualityReport.validator = qualityReport.validator || { issues: [], stats: {} };
      qualityReport.error = err.message;
    }

    // ─── Step 3c: Director Agent (Layer 3) — per-checkpoint mode resolution ───
    // L3 sits ABOVE L1 (validator) + L2 (doctor) + QC8 (quality gate).
    //   shadow    — run + persist verdict, never block
    //   blocking  — run + auto-retry once on soft_reject (per DirectorRetryPolicy);
    //               escalate to user (awaiting_user_review) on hard_reject or
    //               second-attempt fail
    //   advisory  — Lens D only (full episodes too expensive to auto-retry):
    //               persist verdict + surface as user-actionable in panel
    //
    // Env flags:
    //   BRAND_STORY_DIRECTOR_AGENT       master toggle (default 'off')
    //   BRAND_STORY_DIRECTOR_SCREENPLAY  Lens A override
    //   BRAND_STORY_DIRECTOR_SCENE_MASTER Lens B override
    //   BRAND_STORY_DIRECTOR_BEAT        Lens C override
    //   BRAND_STORY_DIRECTOR_EPISODE     Lens D override
    //
    // Plan refs: .claude/plans/v4-director-agent.md §3 §8 §13
    //            .claude/agents/branded-film-director.md §5 §7 §9
    const directorModes = {
      [DIRECTOR_CHECKPOINTS.SCREENPLAY]:   resolveDirectorMode(DIRECTOR_CHECKPOINTS.SCREENPLAY),
      [DIRECTOR_CHECKPOINTS.SCENE_MASTER]: resolveDirectorMode(DIRECTOR_CHECKPOINTS.SCENE_MASTER),
      [DIRECTOR_CHECKPOINTS.BEAT]:         resolveDirectorMode(DIRECTOR_CHECKPOINTS.BEAT),
      [DIRECTOR_CHECKPOINTS.EPISODE]:      resolveDirectorMode(DIRECTOR_CHECKPOINTS.EPISODE)
    };
    const anyDirectorEnabled = Object.values(directorModes).some(m => m !== 'off');
    let directorAgent = null;
    // V4 hotfix 2026-05-01 — Resume mode: inherit the persisted directorReport
    // from the existing episode so prior verdicts (Lens A pass), retry budgets,
    // and notes survive the resume. Clear `halt` since the user has resolved
    // it; record the resume in `resume_history` for the audit trail.
    const directorReport = isResume
      ? (() => {
          const persisted = existingEpisodeForResume.director_report || {};
          const inherited = {
            retries: persisted.retries || {},
            modes: directorModes,
            notes: Array.isArray(persisted.notes) ? persisted.notes : [],
            screenplay: persisted.screenplay || null,
            screenplay_retry: persisted.screenplay_retry || null,
            scene_master: persisted.scene_master || {},
            beat: persisted.beat || {},
            episode: persisted.episode || null,
            resume_history: Array.isArray(persisted.resume_history) ? persisted.resume_history : []
          };
          // Reset retry budget for the failed scene_master so the user
          // override counts as a fresh attempt, not a continuation of the
          // exhausted retry chain. Without this, decideDirectorRetry sees
          // retries=1 already and immediately escalates.
          if (resumeOptions.sceneEdits?.sceneId && inherited.retries?.scene_master) {
            delete inherited.retries.scene_master[resumeOptions.sceneEdits.sceneId];
          }
          inherited.resume_history.push({
            from_checkpoint: 'scene_master',
            scene_id: resumeOptions.sceneEdits?.sceneId || null,
            had_notes: !!resumeOptions.sceneEdits?.notes,
            had_anchor_rewrite: !!resumeOptions.sceneEdits?.edited_anchor,
            ts: new Date().toISOString()
          });
          return inherited;
        })()
      : { retries: {}, modes: directorModes, notes: [] };

    // V4 P1.4 — Notes-severity surfacing.
    //
    // Note-severity findings are advisory: they do not gate ship and do not
    // trigger Doctor/retake. Before P1.4 they were silently dropped. Now we
    // accumulate them into directorReport.notes[] with source context so the
    // panel can surface "the Director said X about this scene" without
    // forcing remediation. Idempotent — safe to call repeatedly per verdict.
    const accumulateNotes = (verdict, source) => {
      if (!verdict || !Array.isArray(verdict.findings)) return;
      for (const f of verdict.findings) {
        if (!f) continue;
        if (typeof f.severity !== 'string') continue;
        if (f.severity.toLowerCase() !== 'note') continue;
        directorReport.notes.push({
          source,
          id: f.id || null,
          message: f.message || '',
          dimension: f.dimension || null,
          scope: f.scope || null,
          remediation_hint: f.remediation?.prompt_delta || null
        });
      }
    };

    // Format a verdict for the SSE/log progress detail string. On error
    // (Vertex truncation / network / quota — see logs.txt 2026-04-25 for the
    // pattern), the DirectorAgent fallback now returns { verdict: null, error }
    // instead of synthesizing a `pass_with_notes` with score 0. This formatter
    // makes the progress feed reflect that distinction so dashboards and
    // calibration data don't read errored runs as low-quality passes.
    const fmtVerdict = (v) => {
      if (v?.error) return `error (${String(v.error).slice(0, 120)})`;
      const verdictStr = v?.verdict ?? 'no-verdict';
      const scoreStr = (v?.overall_score == null) ? '—' : v.overall_score;
      return `${verdictStr} (score ${scoreStr})`;
    };

    // V4 Phase 7 / B5 — per-Lens genre routing. Commercial stories run the
    // commercial-craft rubric variants (different DIMENSIONS — same verdict
    // shape, same retry contract, same N6 parallelization). The orchestrator
    // picks the method here; DirectorAgent itself is genre-stateless.
    //
    //   Lens 0/A (commercial brief)        → judgeCommercialBrief        (B1, in generateStoryline)
    //   Lens A   (screenplay)              → judgeCommercialScreenplay
    //   Lens B   (scene_master)            → judgeCommercialSceneMaster
    //   Lens C   (beat)                    → judgeCommercialBeat
    //   Lens D   (episode picture lock)    → judgeCommercialEpisode      (B2, done above)

    // Initialize the director agent FIRST so the genre-routing predicate below
    // sees the live instance, not the null placeholder declared at line 3676.
    if (anyDirectorEnabled) {
      try {
        directorAgent = new DirectorAgent();
        if (!directorAgent.isAvailable()) {
          logger.warn('V4 Director Agent enabled but Vertex Gemini not configured — skipping');
          directorAgent = null;
        }
      } catch (initErr) {
        logger.warn(`V4 Director Agent initialization failed (${initErr.message}) — skipping`);
        directorAgent = null;
      }
    }

    // V4 P4.4 — Bug fix. Before P4.4 these constants evaluated BEFORE directorAgent
    // was initialized (the conditional below ran AFTER the constant binding), so
    // `isCommercialEp` was always false even for commercial stories. That silently
    // routed commercial stories to PRESTIGE rubrics — the wrong dimensions, the
    // wrong reference library, the wrong ship gate. Moving initialization above
    // the constants fixes the routing.
    const isCommercialEp = !!(directorAgent && isCommercialGenre(story));
    const commercialJudgeExtras = isCommercialEp ? {
      commercialBrief: story.commercial_brief || null,
      brandKit: brandKit || null
    } : {};

    // Compute previous-episode final intensity once (used by Lens A judge prompt).
    let previousFinalIntensity = null;
    if (directorAgent) {
      const lastReady = previousReady?.[previousReady.length - 1];
      const ledger = lastReady?.scene_description?.emotional_intensity_ledger
        || story?.story_so_far?.emotional_intensity_ledger
        || null;
      if (ledger && typeof ledger === 'object') {
        const candidate = Number(ledger.final_intensity ?? ledger.last ?? ledger.episode_close ?? null);
        if (Number.isFinite(candidate)) previousFinalIntensity = candidate;
      }
    }

    // ─── Lens A — Table Read (post-screenplay, post-Doctor) ───
    // V4 hotfix 2026-05-01 — Skip Lens A on resume (it ran during the
    // original pipeline pass; persisted verdict is already on directorReport.screenplay).
    if (!isResume && directorAgent && directorModes[DIRECTOR_CHECKPOINTS.SCREENPLAY] !== 'off') {
      const lensAMode = directorModes[DIRECTOR_CHECKPOINTS.SCREENPLAY];
      // Phase 7 / B5 — route by genre. Commercial → judgeCommercialScreenplay
      // (different DIMENSIONS, same verdict shape).
      const lensAFn = isCommercialEp
        ? directorAgent.judgeCommercialScreenplay.bind(directorAgent)
        : directorAgent.judgeScreenplay.bind(directorAgent);
      const lensALabel = isCommercialEp ? DIRECTOR_CHECKPOINTS.COMMERCIAL_SCREENPLAY : DIRECTOR_CHECKPOINTS.SCREENPLAY;
      try {
        const verdictA = await lensAFn({
          sceneGraph,
          personas,
          storyBible: story?.storyline || null,
          sonicSeriesBible: story?.sonic_series_bible || null,
          previousEpisodesSummary: lastCliffhanger || '',
          storyFocus: isCommercialEp ? 'commercial' : (story?.story_focus || 'drama'),
          previousFinalIntensity,
          isRetry: false,
          ...commercialJudgeExtras
        });
        directorReport.screenplay = verdictA;
        accumulateNotes(verdictA, 'lens_a:screenplay');
        progress('director:screenplay', fmtVerdict(verdictA), {
          checkpoint: lensALabel,
          mode: lensAMode,
          verdict: verdictA?.verdict,
          score: verdictA?.overall_score,
          findings: (verdictA?.findings || []).length
        });

        // V4 hotfix 2026-04-30 — Advisory and Blocking BOTH auto-retry on
        // soft_reject. Only Blocking halts on retry-exhausted / hard_reject.
        // The retry path below runs whenever decision.shouldRetry is true
        // regardless of mode; the halt path is gated on `lensAMode === 'blocking'`.
        if (lensAMode === 'blocking' || lensAMode === 'advisory') {
          const decision = decideDirectorRetry({
            verdict: verdictA,
            checkpoint: DIRECTOR_CHECKPOINTS.SCREENPLAY,
            retriesState: directorReport.retries
          });

          if (decision.shouldEscalate && !decision.shouldRetry) {
            if (lensAMode === 'blocking') {
              // BLOCKING — halt before episode row creation. The route handler
              // logs but does NOT create a row to mark, so the user never sees
              // a partial episode. The director_report is intentionally not
              // persisted in this path; the next attempt is a clean retry.
              throw new DirectorBlockingHaltError({
                checkpoint: DIRECTOR_CHECKPOINTS.SCREENPLAY,
                verdict: verdictA,
                reason: decision.reason
              });
            } else {
              // ADVISORY — log the verdict and proceed with the rejected
              // screenplay. Verdict is already in directorReport.screenplay
              // for panel surfacing; user decides whether to ship.
              logger.info(
                `[V4Pipeline] director:screenplay advisory mode — ` +
                `escalation triggered (${decision.reason}) but proceeding without halt`
              );
            }
          }

          if (decision.shouldRetry) {
            progress('director:screenplay', `auto-retry triggered: ${decision.reason}`, {
              checkpoint: DIRECTOR_CHECKPOINTS.SCREENPLAY,
              retry: true,
              nudge_chars: (decision.nudgePromptDelta || '').length
            });
            // Convert director critical findings into Doctor-compatible issue
            // shape and force-run punchUpScreenplay (bypasses the doctor env
            // flag — the user's blocking-mode opt-in IS the trigger).
            // V4 P0.1 — emit canonical 'critical'. The Doctor accepts both
            // 'critical' (canonical) and 'blocker' (legacy alias) via
            // isBlockerOrCritical(), so this is an in-place vocabulary
            // unification with zero behavioral change.
            const doctorIssues = (verdictA.findings || [])
              .filter(f => f.severity === 'critical')
              .map(f => ({
                id: f.id,
                severity: 'critical',
                scope: f.scope,
                message: f.message,
                hint: f.remediation?.prompt_delta || ''
              }));
            try {
              const layer2b = await punchUpScreenplay(sceneGraph, personas, doctorIssues, { force: true });
              if (!layer2b.skipped && layer2b.patched) {
                sceneGraph = layer2b.patched;
                directorReport.screenplay_doctor_director = {
                  applied: layer2b.applied,
                  rejected: layer2b.rejected,
                  notes: layer2b.notes
                };
                // Re-run L1 once to capture the post-director-doctor state.
                try {
                  const layer1c = validateScreenplay(
                    sceneGraph,
                    story.storyline || {},
                    personas,
                    validatorOpts
                  );
                  sceneGraph = layer1c.repaired;
                  qualityReport.validator_post_director = {
                    issues: layer1c.issues,
                    stats: layer1c.stats
                  };
                } catch (revalErr) {
                  logger.warn(`V4 Director-driven re-validation failed: ${revalErr.message}`);
                }
              } else if (layer2b.skipped) {
                progress('director:screenplay', `doctor skipped: ${layer2b.skipped}`);
              }
            } catch (docErr) {
              logger.warn(`V4 Director Lens A re-doctor failed (non-fatal): ${docErr.message}`);
            }

            // Re-judge with isRetry=true (forces retry_authorization=false in verdict)
            const verdictA2 = await lensAFn({
              sceneGraph,
              personas,
              storyBible: story?.storyline || null,
              sonicSeriesBible: story?.sonic_series_bible || null,
              previousEpisodesSummary: lastCliffhanger || '',
              storyFocus: isCommercialEp ? 'commercial' : (story?.story_focus || 'drama'),
              previousFinalIntensity,
              isRetry: true,
              ...commercialJudgeExtras
            });
            directorReport.screenplay_retry = verdictA2;
            accumulateNotes(verdictA2, 'lens_a:screenplay_retry');
            directorReport.retries = decision.nextRetriesState;
            progress('director:screenplay', `retry verdict: ${fmtVerdict(verdictA2)}`, {
              checkpoint: lensALabel,
              retry: true,
              verdict: verdictA2?.verdict,
              score: verdictA2?.overall_score
            });

            // Second attempt failure → escalate
            const finalDecision = decideDirectorRetry({
              verdict: verdictA2,
              checkpoint: DIRECTOR_CHECKPOINTS.SCREENPLAY,
              retriesState: directorReport.retries
            });
            if (finalDecision.shouldEscalate || finalDecision.shouldRetry === false && verdictA2?.verdict !== 'pass' && verdictA2?.verdict !== 'pass_with_notes') {
              throw new DirectorBlockingHaltError({
                checkpoint: DIRECTOR_CHECKPOINTS.SCREENPLAY,
                verdict: verdictA2,
                reason: `retry attempt ${verdictA2?.verdict || 'no verdict'} — escalating`
              });
            }
          }
        }
      } catch (dirErr) {
        if (dirErr instanceof DirectorBlockingHaltError) throw dirErr; // surface to outer pipeline
        logger.warn(`V4 Director Agent Lens A failed (non-fatal): ${dirErr.message}`);
        directorReport.screenplay_error = dirErr.message;
      }
    }

    // ─── Step 4: Brand safety filter (lightweight validation pass) ───
    this._brandSafetyFilter(sceneGraph);

    // ─── Step 5: Create episode record + run BeatRouter preflight ───
    // V4 hotfix 2026-05-01 — Resume mode: reuse the existing episode (do
    // NOT insert a new row, which would collide on episode_number unique
    // index AND lose the user's halt-resolution audit trail). Just update
    // status + persist the edited scene-graph + cleared directorReport.
    const newEpisode = isResume
      ? { id: resumeOptions.episodeId }
      : await createBrandStoryEpisode(storyId, userId, {
          episode_number: nextEpisodeNumber,
          scene_description: sceneGraph,
          pipeline_version: 'v4',
          status: 'generating_scene_masters',
          cost_cap_usd: costCapUsd,
          quality_report: qualityReport,
          director_report: directorReport
        });
    if (isResume) {
      await updateBrandStoryEpisode(resumeOptions.episodeId, userId, {
        status: 'generating_scene_masters',
        scene_description: sceneGraph,
        director_report: directorReport,
        error_message: null
      });
    }

    // Activate SSE emitter now that we have the episode_id. From this point
    // onward every progress(...) call also broadcasts to any connected
    // SSE clients via /api/brand-stories/:id/episodes/:episodeId/stream
    emitter = getOrCreateProgressEmitter(newEpisode.id);
    progress('episode_created', `episode_id=${newEpisode.id}`, { episode_id: newEpisode.id });

    const router = new BeatRouter({
      falServices: {
        kling: klingFalService,
        veo: veoService, // Vertex AI backend (free under GCP quota), NOT fal.ai
        syncLipsync: syncLipsyncFalService,
        seedream: seedreamFalService,
        flux: fluxFalService,
        omniHuman: omniHumanService
      },
      tts: ttsService,
      // V4 Audio Layer Overhaul Day 2 — multi-speaker dialogue endpoint.
      // GROUP_DIALOGUE_TWOSHOT routes through this service for shared
      // prosodic context across speakers. Falls back to per-beat TTS
      // (this.tts) when the beat exceeds the 2,000-char or 10-voice limit.
      dialogueTTS: dialogueTTSService
    });

    const preflight = router.preflight({
      scenes: sceneGraph.scenes,
      costCapUsd,
      // V4 Phase 5b — N3. Genre threading lets the router enforce the
      // commercial-only ref-stack precondition (no scene_master_url → mark
      // beats as requires_scene_master_remediation).
      genre: story.subject?.genre || story.storyline?.genre || ''
    });

    progress('preflight', `${preflight.beatCount} beats, est $${preflight.totalEstimatedCost.toFixed(2)} / cap $${costCapUsd.toFixed(2)}`);

    if (!preflight.withinCap) {
      await updateBrandStoryEpisode(newEpisode.id, userId, {
        status: 'failed',
        error_message: `Cost cap exceeded: estimated $${preflight.totalEstimatedCost.toFixed(2)} > cap $${costCapUsd.toFixed(2)}`
      });
      throw new Error(`V4: cost cap exceeded ($${preflight.totalEstimatedCost.toFixed(2)} > $${costCapUsd.toFixed(2)})`);
    }

    // ─── Step 6: Scene Master generation ───
    progress('scene_masters', `generating ${sceneGraph.scenes.length} Scene Master panel(s)`);
    const subjectReferenceImages = (story.subject?.reference_image_urls || []).filter(Boolean);
    const uploadBufferToStorage = (buffer, subfolder, filename, mimeType) =>
      this._uploadBufferToStorage(buffer, userId, subfolder, filename, mimeType);

    try {
      await generateSceneMasters({
        scenes: sceneGraph.scenes,
        visualStylePrefix: sceneGraph.visual_style_prefix,
        personas,
        subjectReferenceImages,
        storyFocus: story.story_focus || 'product',
        // Phase 6 (2026-04-28) — feed genre + integration style so Scene Master
        // ref ordering / cap can switch to commercial mode (persona-first, cap 4).
        genre: story.subject?.genre || story.storyline?.genre || '',
        productIntegrationStyle: story.product_integration_style || '',
        // V4 Phase 7 — thread commercial_brief so Scene Master directive can
        // branch identity language on style_category (non-photoreal styles get
        // archetype-preserving directive instead of "preserve exact facial structure").
        commercialBrief: story.commercial_brief || null,
        userId,
        uploadBuffer: uploadBufferToStorage,
        baseSeed: previousReady.length * 100 // varies per episode, deterministic across retries
      });
    } catch (smErr) {
      // V4 Phase 5b — N1 hard gate. For commercial stories, Scene Master
      // failure across all 5 tiers (Tier 0 sanitize → Tier 2 Gemini rewrite
      // → Tier 3 model fallback) is fatal. Mark the episode awaiting_user_review
      // and halt — do NOT ship a 6-of-8 cut as we did for story `77d6eaaf`
      // (logs.txt 2026-04-28).
      if (smErr instanceof SceneMasterFatalError) {
        progress('scene_masters', `FATAL: ${smErr.message} — escalating to user_review`);
        await updateBrandStoryEpisode(newEpisode.id, userId, {
          status: 'awaiting_user_review',
          error_message: `Scene Master generation FAILED for commercial. ${smErr.message}`
        }).catch(() => {});
        throw smErr;
      }
      // Non-fatal Scene Master failures are surfaced via scene.scene_master_error
      // (legacy degradation path for non-commercial); rethrow others.
      throw smErr;
    }

    // V4 Phase 5b — N1 hard gate (orchestrator layer). Defense-in-depth:
    // assert that EVERY commercial scene has a non-null scene_master_url after
    // the Tier chain. If any scene still lacks one (e.g. Tier 3 returned a
    // result the upload pipeline silently dropped), halt + escalate.
    {
      const isCommercialStory = String(story.subject?.genre || story.storyline?.genre || '').toLowerCase().trim() === 'commercial';
      if (isCommercialStory) {
        const orphanScenes = (sceneGraph.scenes || []).filter(s => !s?.scene_master_url);
        if (orphanScenes.length > 0) {
          const ids = orphanScenes.map(s => s.scene_id || '?').join(', ');
          progress('scene_masters', `FATAL: ${orphanScenes.length} commercial scene(s) lack scene_master_url after Tier chain (scene_ids=[${ids}]) — escalating to user_review`);
          await updateBrandStoryEpisode(newEpisode.id, userId, {
            status: 'awaiting_user_review',
            error_message: `Scene Master availability gate failed for commercial: ${orphanScenes.length} scene(s) without scene_master_url (scene_ids=[${ids}])`
          }).catch(() => {});
          throw new SceneMasterFatalError(
            `Scene Master availability gate failed: ${orphanScenes.length} commercial scene(s) without scene_master_url`,
            { scene_ids: orphanScenes.map(s => s.scene_id) }
          );
        }
      }
    }

    // ─── Step 6.5: Director Agent (Layer 3) — Lens B "Look Dev Review" ───
    // Per-scene multimodal critique. Per-checkpoint mode resolution:
    //   shadow   — judge + persist; never block
    //   blocking — soft_reject triggers ONE auto-retry with director nudge
    //              spliced into scene's anchor prompt; second fail escalates
    //              the episode to awaiting_user_review
    if (directorAgent && directorModes[DIRECTOR_CHECKPOINTS.SCENE_MASTER] !== 'off') {
      const lensBMode = directorModes[DIRECTOR_CHECKPOINTS.SCENE_MASTER];
      directorReport.scene_master = {};
      const lutId = story?.brand_kit_lut_id || story?.locked_lut_id || null;

      // V4 Phase 5b — N6 (Phase 1) + N1 (third layer). First-pass verdicts
      // run in parallel via Promise.allSettled (per-scene verdicts are
      // independent). Retries stay sequential below — they mutate scene
      // state and call generateSceneMasters which is rare path.
      //
      // Plus: scenes with null scene_master_url emit a SYNTHETIC hard_reject
      // verdict so the judge layer's audit trail captures the failure even
      // when the upstream Tier chain (Fix 9 + N4) couldn't produce a panel
      // for non-commercial degradation. Without this, story-level audit
      // queries showed "no Lens B verdict" for the failed scene rather than
      // the actual failure mode.
      const firstPassPromises = sceneGraph.scenes.map(async (scene) => {
        if (!scene?.scene_master_url) {
          // Synthetic hard_reject — captures the upstream failure in the
          // Director audit trail. For commercial this is unreachable (N1
          // halts the orchestrator before this point); for non-commercial
          // this records the degradation explicitly.
          return {
            scene,
            verdictB: {
              verdict: 'hard_reject',
              overall_score: 0,
              findings: [{
                id: 'scene_master_unavailable',
                severity: 'critical',
                scope: `scene:${scene.scene_id}`,
                message: `Scene Master generation failed across all 5 tiers (Tier 0/2/3 exhausted) — scene shipped without canonical panel.`,
                evidence: scene.scene_master_error || 'no error message captured',
                remediation: {
                  action: 'user_review',
                  prompt_delta: '',
                  target_fields: ['scene_visual_anchor_prompt'],
                  target: 'anchor'
                }
              }],
              commendations: [],
              retry_authorization: false,
              judge_model: 'synthetic',
              latency_ms: 0,
              cost_usd: 0,
              error: scene.scene_master_error || 'scene_master_url is null'
            }
          };
        }
        try {
          // Phase 7 / B5 — route by genre. Commercial → judgeCommercialSceneMaster.
          const lensBFn = isCommercialEp
            ? directorAgent.judgeCommercialSceneMaster.bind(directorAgent)
            : directorAgent.judgeSceneMaster.bind(directorAgent);
          const verdictB = await lensBFn({
            scene,
            sceneMasterImage: scene.scene_master_url,
            sceneMasterMime: 'image/jpeg',
            personas,
            lutId,
            visualStylePrefix: sceneGraph.visual_style_prefix || '',
            storyFocus: isCommercialEp ? 'commercial' : (story.story_focus || 'drama'),
            isRetry: false,
            ...commercialJudgeExtras
          });
          return { scene, verdictB };
        } catch (firstPassErr) {
          return { scene, verdictB: { verdict: null, error: firstPassErr.message }, error: firstPassErr };
        }
      });

      const firstPassResults = await Promise.allSettled(firstPassPromises);

      // Now walk the results sequentially. Retries (which call
      // generateSceneMasters and re-judge) stay one-at-a-time so they don't
      // race on shared state like the seed counter or the upload bucket.
      for (const settled of firstPassResults) {
        if (settled.status !== 'fulfilled') {
          logger.warn(`Lens B first-pass settle rejected: ${settled.reason?.message || settled.reason}`);
          continue;
        }
        const { scene, verdictB: firstVerdict, error: firstErr } = settled.value;
        if (!scene) continue;
        if (firstErr) {
          logger.warn(`V4 Director Agent Lens B (scene ${scene.scene_id}) failed (non-fatal): ${firstErr.message}`);
          directorReport.scene_master[scene.scene_id] = { error: firstErr.message };
          continue;
        }
        // Synthetic verdict for null SM — record + continue (no retry path).
        if (firstVerdict?.judge_model === 'synthetic') {
          directorReport.scene_master[scene.scene_id] = firstVerdict;
          progress('director:scene_master', `scene ${scene.scene_id}: SYNTHETIC hard_reject (scene_master unavailable)`, {
            checkpoint: DIRECTOR_CHECKPOINTS.SCENE_MASTER,
            mode: lensBMode,
            scene_id: scene.scene_id,
            verdict: 'hard_reject',
            score: 0,
            synthetic: true
          });
          continue;
        }
        if (!scene?.scene_master_url) continue;
        try {
          // V4 Phase 5b — N6. Reuse the first-pass verdict from the parallel
          // batch above instead of re-judging. The retry path below (which
          // mutates scene state) stays sequential and unchanged.
          let verdictB = firstVerdict;
          directorReport.scene_master[scene.scene_id] = verdictB;
          accumulateNotes(verdictB, `lens_b:scene_master:${scene.scene_id}`);
          progress('director:scene_master', `scene ${scene.scene_id}: ${fmtVerdict(verdictB)}`, {
            checkpoint: DIRECTOR_CHECKPOINTS.SCENE_MASTER,
            mode: lensBMode,
            scene_id: scene.scene_id,
            verdict: verdictB?.verdict,
            score: verdictB?.overall_score,
            findings: (verdictB?.findings || []).length
          });

          // V4 hotfix 2026-04-30 — Advisory and Blocking BOTH auto-retry on
          // soft_reject. Halt path is gated to blocking-only.
          if (lensBMode === 'blocking' || lensBMode === 'advisory') {
            const decision = decideDirectorRetry({
              verdict: verdictB,
              checkpoint: DIRECTOR_CHECKPOINTS.SCENE_MASTER,
              artifactKey: scene.scene_id,
              retriesState: directorReport.retries
            });

            if (decision.shouldEscalate && !decision.shouldRetry) {
              if (lensBMode === 'blocking') {
                // BLOCKING — halt + persist context for the panel.
                directorReport.halt = {
                  checkpoint: DIRECTOR_CHECKPOINTS.SCENE_MASTER,
                  scene_id: scene.scene_id,
                  artifactKey: scene.scene_id,
                  verdict: verdictB,
                  reason: decision.reason,
                  pass: 'first',
                  ts: new Date().toISOString()
                };
                await updateBrandStoryEpisode(newEpisode.id, userId, {
                  status: 'awaiting_user_review',
                  director_report: directorReport
                });
                throw new DirectorBlockingHaltError({
                  checkpoint: DIRECTOR_CHECKPOINTS.SCENE_MASTER,
                  verdict: verdictB,
                  artifactKey: scene.scene_id,
                  reason: decision.reason
                });
              } else {
                // ADVISORY — log + proceed with the rejected scene master.
                logger.info(
                  `[V4Pipeline] director:scene_master advisory mode — scene ${scene.scene_id} ` +
                  `escalation triggered (${decision.reason}) but proceeding without halt`
                );
              }
            }

            if (decision.shouldRetry) {
              progress('director:scene_master', `scene ${scene.scene_id} auto-retry: ${decision.reason}`, {
                checkpoint: DIRECTOR_CHECKPOINTS.SCENE_MASTER,
                scene_id: scene.scene_id,
                retry: true
              });

              // V4 hotfix 2026-05-01 — Smart retry for Lens B (mirrors the
              // Lens C wiring at ~line 5085). Replaces the cheap concat of
              // `decision.nudgePromptDelta` with a Gemini-synthesized
              // directive that has access to the scene's full content
              // (anchor prompt, persona names, LUT, visual style) AND the
              // verdict findings. Smart synth produces a richer remediation
              // ("the lighting reads as overcast vs. the screenplay's golden
              // hour — push warmer key light from camera right, soften
              // shadows on the principal's face") vs. the cheap concat
              // ("framing too wide; add character closer"). Set
              // V4_SMART_RETRY=false to fall back to cheap concat.
              let lensBRetryDirective = decision.nudgePromptDelta;
              let lensBEditedAnchor = null;
              if (process.env.V4_SMART_RETRY !== 'false') {
                progress('director:scene_master', `scene ${scene.scene_id} smart-retry: synthesizing director directive`, {
                  checkpoint: DIRECTOR_CHECKPOINTS.SCENE_MASTER,
                  scene_id: scene.scene_id,
                  smart_retry: true
                });
                try {
                  const sceneArtifactContent = {
                    type: 'scene_master',
                    scene_id: scene.scene_id,
                    location: scene.location || null,
                    scene_visual_anchor_prompt: scene.scene_visual_anchor_prompt || null,
                    visual_style_prefix: sceneGraph.visual_style_prefix || null,
                    lut_id: lutId || null,
                    persona_names: (personas || []).map(p => p.name).filter(Boolean),
                    beat_count: Array.isArray(scene.beats) ? scene.beats.length : 0
                  };
                  const synthB = await this._synthesizeEditFromContext({
                    verdict: verdictB,
                    checkpoint: 'scene_master',
                    artifactId: scene.scene_id,
                    artifactContent: sceneArtifactContent
                  });
                  lensBRetryDirective = synthB.notes || decision.nudgePromptDelta;
                  lensBEditedAnchor = synthB.edited_anchor || null;
                  directorReport.scene_master[scene.scene_id + '_smart_retry'] = {
                    source: synthB.source,
                    directive: synthB.notes,
                    edited_anchor: synthB.edited_anchor || null,
                    attempted_at: new Date().toISOString()
                  };
                  progress('director:scene_master',
                    `scene ${scene.scene_id} smart-retry directive synthesized (source: ${synthB.source})`,
                    { scene_id: scene.scene_id, smart_retry: true, synth_source: synthB.source }
                  );
                  if (synthB.edited_anchor) {
                    progress('director:scene_master',
                      `scene ${scene.scene_id} smart-retry: anchor rewritten by synthesis`,
                      { scene_id: scene.scene_id, smart_retry: true }
                    );
                  }
                } catch (synthErr) {
                  logger.warn(
                    `scene ${scene.scene_id} smart synthesis failed (${synthErr.message}) — ` +
                    `falling back to cheap concat directive for the retry`
                  );
                }
              }

              // Splice director directive into the scene's anchor prompt for
              // the re-render. If smart synthesis produced a full anchor
              // rewrite, use that as the base instead of the original.
              // Clearing scene_master_url forces generateSceneMasters to
              // regenerate this scene; other scenes (which already have
              // URLs) are skipped by the helper's resume-path check.
              const originalAnchor = scene.scene_visual_anchor_prompt || scene.location || '';
              const baseAnchor = lensBEditedAnchor || originalAnchor;
              scene.scene_visual_anchor_prompt = `${baseAnchor}. DIRECTOR'S RETAKE NOTE: ${lensBRetryDirective}`.trim();
              scene.scene_master_url = null;
              try {
                await generateSceneMasters({
                  scenes: [scene],
                  visualStylePrefix: sceneGraph.visual_style_prefix,
                  personas,
                  subjectReferenceImages,
                  storyFocus: story.story_focus || 'product',
                  // Phase 6 — same commercial-mode plumbing as the main call.
                  genre: story.subject?.genre || story.storyline?.genre || '',
                  productIntegrationStyle: story.product_integration_style || '',
                  // V4 Phase 7 — thread commercial_brief so the retake honors
                  // the same style-aware identity directive as the first pass.
                  commercialBrief: story.commercial_brief || null,
                  userId,
                  uploadBuffer: uploadBufferToStorage,
                  baseSeed: (previousReady.length * 100) + 1 // shift seed for the retry
                });
              } catch (regenErr) {
                logger.warn(`V4 Director Lens B retake render failed (scene ${scene.scene_id}): ${regenErr.message}`);
              }
              // Restore original anchor on the scene record so downstream code
              // doesn't see the nudge text — the regenerated PNG embeds the
              // direction; the prompt stays clean for resume paths.
              scene.scene_visual_anchor_prompt = originalAnchor;

              // Re-judge with isRetry=true (forces retry_authorization=false)
              if (scene.scene_master_url) {
                // Phase 7 / B5 — route by genre.
                const lensBRetryFn = isCommercialEp
                  ? directorAgent.judgeCommercialSceneMaster.bind(directorAgent)
                  : directorAgent.judgeSceneMaster.bind(directorAgent);
                const lensBLabel = isCommercialEp ? DIRECTOR_CHECKPOINTS.COMMERCIAL_SCENE_MASTER : DIRECTOR_CHECKPOINTS.SCENE_MASTER;
                verdictB = await lensBRetryFn({
                  scene,
                  sceneMasterImage: scene.scene_master_url,
                  sceneMasterMime: 'image/jpeg',
                  personas,
                  lutId,
                  visualStylePrefix: sceneGraph.visual_style_prefix || '',
                  storyFocus: isCommercialEp ? 'commercial' : (story.story_focus || 'drama'),
                  isRetry: true,
                  ...commercialJudgeExtras
                });
                directorReport.scene_master[scene.scene_id] = verdictB;
                directorReport.retries = decision.nextRetriesState;
                progress('director:scene_master', `scene ${scene.scene_id} retry verdict: ${fmtVerdict(verdictB)}`, {
                  checkpoint: lensBLabel,
                  scene_id: scene.scene_id,
                  retry: true,
                  verdict: verdictB?.verdict,
                  score: verdictB?.overall_score
                });

                // Second-attempt failure → escalate
                const final = decideDirectorRetry({
                  verdict: verdictB,
                  checkpoint: DIRECTOR_CHECKPOINTS.SCENE_MASTER,
                  artifactKey: scene.scene_id,
                  retriesState: directorReport.retries
                });
                if (final.shouldEscalate) {
                  if (lensBMode === 'blocking') {
                    // BLOCKING — halt + persist context for the panel.
                    directorReport.halt = {
                      checkpoint: DIRECTOR_CHECKPOINTS.SCENE_MASTER,
                      scene_id: scene.scene_id,
                      artifactKey: scene.scene_id,
                      verdict: verdictB,
                      reason: `retake still ${verdictB?.verdict} — escalating`,
                      pass: 'retry',
                      ts: new Date().toISOString()
                    };
                    await updateBrandStoryEpisode(newEpisode.id, userId, {
                      status: 'awaiting_user_review',
                      director_report: directorReport
                    });
                    throw new DirectorBlockingHaltError({
                      checkpoint: DIRECTOR_CHECKPOINTS.SCENE_MASTER,
                      verdict: verdictB,
                      artifactKey: scene.scene_id,
                      reason: `retake still ${verdictB?.verdict} — escalating`
                    });
                  } else {
                    // ADVISORY — proceed with the post-retry verdict; user
                    // sees the failed verdict in the panel.
                    logger.info(
                      `[V4Pipeline] director:scene_master advisory mode — scene ${scene.scene_id} ` +
                      `retake still ${verdictB?.verdict} — proceeding without halt`
                    );
                  }
                }
              }
            }
          }
        } catch (dirErr) {
          if (dirErr instanceof DirectorBlockingHaltError) throw dirErr;
          logger.warn(`V4 Director Agent Lens B (scene ${scene.scene_id}) failed (non-fatal): ${dirErr.message}`);
          directorReport.scene_master[scene.scene_id] = { error: dirErr.message };
        }
      }
    }

    // Persist scene master URLs to the episode
    await updateBrandStoryEpisode(newEpisode.id, userId, {
      scene_description: sceneGraph,
      status: 'generating_beats',
      director_report: directorReport
    });

    // ─── Step 7: Beat generation (sequential within scene for endframe chaining) ───
    progress('beats', `generating beats sequentially within each scene`);
    const beatVideoBuffers = [];
    const beatMetadata = [];

    // Episode context shared across all beat generators
    const episodeContext = {
      visual_style_prefix: sceneGraph.visual_style_prefix || '',
      storyId,
      episodeId: newEpisode.id,
      userId,
      subjectReferenceImages,
      subject: story.subject || null,
      // V4 Phase 5b — N3. Generators read episodeContext.genre to enforce
      // commercial-only ref-stack precondition.
      genre: story.subject?.genre || story.storyline?.genre || '',
      // V4 Phase 7 — commercial_brief threads style_category through to the
      // persona-lock pre-pass identity directive (StoryboardHelpers) and to
      // the per-beat generators' style-aware paths.
      commercial_brief: story.commercial_brief || null,
      // Subject Bible (Phase 1.1) — persistent cross-episode subject spec
      subject_bible: story.subject?.subject_bible || story.subject_bible || null,
      // Location Bible (Phase 1.2) — persistent cross-episode location dictionary
      locationBible: story.location_bible || null,
      // Brand Kit — drives branded title/end cards, subtitle styling, color-aware overlays
      brandKit: brandKit || null,
      defaultNarratorVoiceId: personas[0]?.elevenlabs_voice_id
        || pickFallbackVoiceIdForPersonaInList(personas, 0, { reason: 'v4_default_narrator' })
        || 'nPczCjzI2devNBz1zQrb',
      // Audio uploader injected so beat generators can stash TTS to a public URL
      uploadAudio: async ({ buffer, filename, mimeType }) => {
        return this._uploadBufferToStorage(buffer, userId, 'audio/v4', filename, mimeType);
      },
      // Generic buffer uploader — used by Phase 2's persona-locked first frame
      // helper (Seedream PNG → Supabase) and any future beat-level intermediate
      // artifacts that need a public URL.
      uploadBuffer: uploadBufferToStorage
    };

    // ─── Phase 6 (2026-04-28) — commercial scene-failure halt guardrail ───
    //
    // For non-commercial stories, a failed scene is non-fatal — the pipeline
    // continues with the surviving scenes (the assembled cut may have a hole
    // but a 12-episode prestige series can absorb that). For COMMERCIAL spots
    // (1-2 episodes, 1-3 scenes per episode), a single scene failure means
    // losing 33-100% of the spot. The pipeline must halt and escalate to
    // user_review instead of shipping a half-spot.
    //
    // Caught: 2026-04-28 logs.txt — `plaza_tactile_walk` montage failed with
    // a Kling 422 (now fixed at the source), pipeline kept going to scene 3,
    // would have produced a final cut missing the entire middle scene.
    const isCommercialStory = String(story?.subject?.genre || story?.storyline?.genre || '').toLowerCase().trim() === 'commercial';
    let sceneFailureCount = 0;
    const failedSceneIds = [];

    // Helper: count usable beats in a scene (a scene "succeeded" if at least
    // one beat produced a video). Called after each scene to detect failure.
    const countSceneBeatsWithVideo = (scn) =>
      (scn.beats || []).filter(b => b.generated_video_url && b.status !== 'failed').length;

    // Sequential generation within scenes to support endframe chaining,
    // parallel between scenes for speed.
    for (const scene of sceneGraph.scenes) {
      let previousBeat = null;
      const beatsWithVideoBefore = countSceneBeatsWithVideo(scene);

      // ─── Commercial halt check (before each scene's work begins) ───
      // If a previous scene failed and this is a commercial spot, abort
      // the rest of the loop and escalate. We check at the TOP of each
      // iteration so the failed-scene's halting work isn't wasted on the
      // remaining scenes (saves money + time).
      if (isCommercialStory && sceneFailureCount > 0) {
        logger.error(`commercial halt: ${sceneFailureCount} scene(s) failed [${failedSceneIds.join(', ')}] — refusing to ship a half-spot. Aborting remaining scenes; episode will be marked awaiting_user_review.`);
        progress('beats', `commercial halt: ${sceneFailureCount} scene failure(s) — aborting`, {
          failedSceneIds,
          remainingScenes: sceneGraph.scenes.length - sceneGraph.scenes.indexOf(scene)
        });
        break;
      }

      // MONTAGE_SEQUENCE handling: scenes flagged as 'montage' are generated
      // as a single Kling V3 Pro multi-shot call instead of per-beat.
      if (scene.type === 'montage') {
        progress('beats', `scene ${scene.scene_id} → MONTAGE (single multi-shot call)`);
        const montageGen = new MontageSequenceGenerator({
          falServices: {
            kling: klingFalService,
            veo: veoService, // Vertex AI (free under GCP quota), NOT fal.ai
            syncLipsync: syncLipsyncFalService,
            omniHuman: omniHumanService
          },
          tts: ttsService
        });

        try {
          const result = await montageGen.generateScene({
            scene,
            personas,
            episodeContext,
            previousScene: null
          });

          // Upload the montage video and treat it as ONE virtual beat
          const publicUrl = await uploadBufferToStorage(
            result.videoBuffer,
            'videos/v4-beats',
            `montage-${scene.scene_id}.mp4`,
            'video/mp4'
          );

          // Extract endframe for the next scene's anchoring
          let endframeUrl = null;
          try {
            const endframeBuffer = await extractBeatEndframe(result.videoBuffer);
            endframeUrl = await uploadBufferToStorage(
              endframeBuffer,
              'videos/v4-endframes',
              `montage-${scene.scene_id}-end.jpg`,
              'image/jpeg'
            );
          } catch (err) {
            logger.warn(`montage endframe extraction failed: ${err.message}`);
          }

          // Mark all child beats as satisfied via this single call
          for (const beat of scene.beats) {
            beat.generated_video_url = publicUrl;
            beat.endframe_url = endframeUrl;
          }
          beatVideoBuffers.push(result.videoBuffer);
          beatMetadata.push({
            beat_id: `${scene.scene_id}_montage`,
            model_used: result.modelUsed,
            duration_seconds: result.durationSec,
            actual_duration_sec: result.durationSec
          });
          previousBeat = { endframe_url: endframeUrl };
        } catch (err) {
          logger.error(`montage scene ${scene.scene_id} failed: ${err.message}`);
          for (const beat of scene.beats) {
            beat.status = 'failed';
            beat.error_message = err.message;
          }
          sceneFailureCount++;
          failedSceneIds.push(scene.scene_id || '(unnamed)');
        }
        continue; // skip per-beat loop for this scene
      }

      // Standard scene: generate beats sequentially with endframe chaining
      for (const beat of scene.beats) {
        // Skip non-generative beat types (text overlays, speed ramps) — handled in post
        if (beat.type === 'SPEED_RAMP_TRANSITION') continue;

        // Resume check: if this beat already has a generated_video_url from a
        // prior failed run, fetch the buffer and skip generation.
        if (beat.generated_video_url && beat.status === 'generated') {
          progress('beats', `beat ${beat.beat_id} → reusing prior generated_video_url`);
          try {
            const cached = await axios.get(beat.generated_video_url, { responseType: 'arraybuffer', timeout: 60000 });
            const cachedBuffer = Buffer.from(cached.data);
            beatVideoBuffers.push(cachedBuffer);
            beatMetadata.push({
              beat_id: beat.beat_id,
              model_used: beat.model_used,
              duration_seconds: beat.duration_seconds,
              actual_duration_sec: beat.actual_duration_sec || beat.duration_seconds
            });
            previousBeat = { endframe_url: beat.endframe_url };
            continue;
          } catch (err) {
            logger.warn(`beat ${beat.beat_id} cached fetch failed, regenerating: ${err.message}`);
          }
        }

        // Build the reference stack for this beat. Phase 1.4 extends the stack
        // to include subject refs (user-uploaded imagery) on subject-anchored
        // beats and the Location Bible master when scene.location_id resolves.
        const refStack = buildBeatRefStack({
          beat,
          scene,
          previousBeat,
          personas,
          subjectReferenceImages,
          locationBible: story.location_bible || null
        });

        // Route + generate
        try {
          const result = await router.generate({
            beat,
            scene,
            refStack,
            personas,
            episodeContext,
            previousBeat
          });

          // Phase 8 — Quality Gate: run deterministic QC on the beat before
          // uploading / chaining forward. Critical issues (mostly-black,
          // corrupt dimensions) mark the beat as failed-qc so the Director
          // Panel surfaces the caution chip; orchestrator currently logs and
          // continues so the user can choose to regenerate via the Director
          // Panel's per-beat regenerate endpoint. Auto-retry is a Phase 8.b
          // enhancement that will reuse the persona-lock path for REACTION /
          // B_ROLL and nudged prompts for INSERT_SHOT.
          try {
            const qc = await runQualityGate({ videoBuffer: result.videoBuffer, beat });
            beat.quality_gate = qc;
            if (!qc.passed) {
              logger.warn(
                `beat ${beat.beat_id} quality gate FAILED: ${qc.issues.map(i => `${i.id}:${i.severity}`).join(', ')}`
              );
            } else if (qc.issues.length > 0) {
              logger.info(
                `beat ${beat.beat_id} quality gate passed with ${qc.issues.length} warning(s)`
              );
            }
          } catch (qcErr) {
            // QC gate is a soft layer — a gate failure MUST NOT block the beat.
            logger.warn(`beat ${beat.beat_id} quality gate threw: ${qcErr.message}`);
            beat.quality_gate_error = qcErr.message;
          }

          // Upload the generated video buffer
          const publicUrl = await uploadBufferToStorage(
            result.videoBuffer,
            'videos/v4-beats',
            `${beat.beat_id}.mp4`,
            'video/mp4'
          );
          beat.generated_video_url = publicUrl;

          // Extract endframe for next-beat continuity
          try {
            const endframeBuffer = await extractBeatEndframe(result.videoBuffer);
            const endframeUrl = await uploadBufferToStorage(
              endframeBuffer,
              'videos/v4-endframes',
              `${beat.beat_id}-end.jpg`,
              'image/jpeg'
            );
            beat.endframe_url = endframeUrl;
          } catch (err) {
            logger.warn(`beat ${beat.beat_id} endframe extraction failed: ${err.message}`);
          }

          // ─── Director Agent (Layer 3) — Lens C "Dailies" (per beat) ───
          // Runs AFTER QC8 deterministic gate. Multimodal: endframe + scene
          // master thumb + previous endframe + beat metadata.
          //   shadow   — judge + persist; never block
          //   blocking — soft_reject triggers ONE auto-retry: stamp
          //              director_nudge onto the beat, re-route through
          //              BeatRouter, re-extract endframe, re-judge isRetry=true.
          //              Second fail OR hard_reject → episode awaiting_user_review.
          if (directorAgent && directorModes[DIRECTOR_CHECKPOINTS.BEAT] !== 'off' && beat.endframe_url) {
            const lensCMode = directorModes[DIRECTOR_CHECKPOINTS.BEAT];
            // Phase 7 / B5 — route by genre. Commercial → judgeCommercialBeat.
            const lensCFn = isCommercialEp
              ? directorAgent.judgeCommercialBeat.bind(directorAgent)
              : directorAgent.judgeBeat.bind(directorAgent);
            const lensCLabel = isCommercialEp ? DIRECTOR_CHECKPOINTS.COMMERCIAL_BEAT : DIRECTOR_CHECKPOINTS.BEAT;
            try {
              if (!directorReport.beat) directorReport.beat = {};
              let verdictC = await lensCFn({
                beat,
                scene,
                endframeImage: beat.endframe_url,
                endframeMime: 'image/jpeg',
                previousEndframeImage: previousBeat?.endframe_url || null,
                previousEndframeMime: 'image/jpeg',
                sceneMasterThumbnail: scene?.scene_master_url || null,
                sceneMasterMime: 'image/jpeg',
                personas,
                routingMetadata: {
                  modelUsed: result.modelUsed,
                  costUsd: result.costUsd || null,
                  metadata: result.metadata || null
                },
                storyFocus: isCommercialEp ? 'commercial' : (story.story_focus || 'drama'),
                // Phase 4 — context for product_identity_lock + product_subtlety
                productIntegrationStyle: story.product_integration_style || 'naturalistic_placement',
                productSignatureFeatures: story.subject?.signature_features || [],
                subjectName: story.subject?.name || null,
                isRetry: false,
                ...commercialJudgeExtras
              });
              directorReport.beat[beat.beat_id] = verdictC;
              accumulateNotes(verdictC, `lens_c:beat:${beat.beat_id}`);
              progress('director:beat', `beat ${beat.beat_id}: ${fmtVerdict(verdictC)}`, {
                checkpoint: lensCLabel,
                mode: lensCMode,
                beat_id: beat.beat_id,
                verdict: verdictC?.verdict,
                score: verdictC?.overall_score,
                findings: (verdictC?.findings || []).length
              });

              // V4 hotfix 2026-04-30 — Advisory and Blocking BOTH auto-retry
              // on soft_reject. Halt path is gated to blocking-only.
              if (lensCMode === 'blocking' || lensCMode === 'advisory') {
                // V4 Wave 6 / F6 — compose the beat's effective "brief" for
                // the nudge_to_brief_ratio anti-runaway telemetry. Ratio
                // compares the proposed nudge mass against the beat's
                // composed directive that flowed through to the generator
                // on the first pass. > 1.5× → halt+escalate (auto-fix is
                // working AGAINST quality).
                const beatBriefForRatio = [
                  beat.dialogue || '',
                  beat.expression_notes || '',
                  beat.action_notes || '',
                  beat.subtext || '',
                  scene?.scene_visual_anchor_prompt || '',
                  sceneGraph?.visual_style_prefix || ''
                ].filter(Boolean).join(' ');
                const decision = decideDirectorRetry({
                  verdict: verdictC,
                  checkpoint: DIRECTOR_CHECKPOINTS.BEAT,
                  artifactKey: beat.beat_id,
                  retriesState: directorReport.retries,
                  // V4 Phase 5b — Fix 8. Enables hard_reject auto-fix on
                  // commercial stories (default-on per user-confirmed plan
                  // 2026-04-29). Non-commercial honors the legacy escalate-
                  // immediately behavior unless BRAND_STORY_AUTOFIX_BEAT_HARDREJECT
                  // is set in env.
                  isCommercialStory: !!story.commercial_brief,
                  originalBrief: beatBriefForRatio
                });

                // V4 Wave 6 / F6 — persist the ratio for telemetry queries
                // and Director Panel chip surfacing. Column added in the
                // add_auto_fix_attempts.sql migration.
                if (Number.isFinite(decision.nudgeToBriefRatio)) {
                  beat.nudge_to_brief_ratio = Number(decision.nudgeToBriefRatio.toFixed(3));
                  await updateBrandStoryEpisode(newEpisode.id, userId, {
                    last_nudge_to_brief_ratio: beat.nudge_to_brief_ratio,
                    last_auto_fix_class: decision.targetClass || null
                  }).catch(() => {});
                }

                // V4 Phase 5b — Fix 8 + N5. When the auto-fix decision targets
                // the IDENTITY class, route the second attempt through a
                // different model (OmniHuman 1.5 for dialogue beats, Veo 3.1
                // for non-dialogue) by stamping beat.preferred_generator.
                // The router resolves the override via GENERATOR_NAME_MAP at
                // route time. First identity failure: rebuild ref stack, same
                // model. Second failure: this fallback route.
                //
                // V4 Wave 6 / F1 — GROUP_DIALOGUE_TWOSHOT EXPLICITLY EXCLUDED from
                // the OmniHuman fallback path. OmniHuman 1.5 takes ONE imageUrl
                // + ONE audioUrl ([services/OmniHumanService.js:47]) — it cannot
                // render two faces in one shot. A two-shot beat carries two
                // personas and combined dialogue audio; routing it to OmniHuman
                // would crash at the input-shape boundary. The proper fallback
                // is SRS-decompile-on-the-fly (zip persona_indexes[] + dialogues[]
                // into exchanges[] → ShotReverseShotCompiler.expandBeat → N
                // alternating closeups, each routed to OmniHuman individually).
                // That's a Phase 8 structural enhancement (requires in-place
                // beat-array mutation during iteration). For Wave 6 we mark the
                // beat as requires_decompile_for_retake and escalate cleanly so
                // the Director Panel can offer the manual decompile affordance.
                if (decision.shouldRetry && decision.targetClass === 'identity') {
                  if (beat.type === 'GROUP_DIALOGUE_TWOSHOT') {
                    beat.requires_decompile_for_retake = true;
                    progress('director:beat',
                      `beat ${beat.beat_id} IDENTITY on GROUP_DIALOGUE_TWOSHOT: ` +
                      `auto-fix unsafe (OmniHuman is single-portrait). ` +
                      `Marking for manual SRS decompile + escalating to user_review.`
                    );
                    // Force escalation rather than the unsafe OmniHuman route.
                    decision.shouldRetry = false;
                    decision.shouldEscalate = true;
                    decision.reason = 'GROUP_DIALOGUE_TWOSHOT IDENTITY-class — auto-fix unsafe; recommend manual SRS decompile retake';
                  } else {
                    const isDialogueType = ['TALKING_HEAD_CLOSEUP', 'DIALOGUE_IN_SCENE', 'SHOT_REVERSE_SHOT_CHILD'].includes(beat.type);
                    if (isDialogueType) {
                      beat.preferred_generator = 'TalkingHeadCloseupGenerator';
                      progress('director:beat', `beat ${beat.beat_id} IDENTITY auto-fix: routing to OmniHuman 1.5 (Mode A fallback)`);
                    } else {
                      // Non-dialogue IDENTITY → Veo 3.1 with persona-locked first frame.
                      // BRollGenerator already uses Veo and supports first-frame
                      // anchoring. ReactionGenerator + InsertShotGenerator also
                      // route through Veo; for non-dialogue beats keeping the
                      // existing generator and stamping director_nudge is
                      // sufficient (Veo retries with the corrective hint).
                      progress('director:beat', `beat ${beat.beat_id} IDENTITY auto-fix: rebuilding ref stack on Veo (same generator)`);
                    }
                  }
                }

                if (decision.shouldEscalate && !decision.shouldRetry) {
                  if (lensCMode === 'blocking') {
                    // BLOCKING — halt + persist context for the panel.
                    directorReport.halt = {
                      checkpoint: DIRECTOR_CHECKPOINTS.BEAT,
                      beat_id: beat.beat_id,
                      scene_id: scene?.scene_id || null,
                      artifactKey: beat.beat_id,
                      verdict: verdictC,
                      reason: decision.reason,
                      pass: 'first',
                      ts: new Date().toISOString()
                    };
                    await updateBrandStoryEpisode(newEpisode.id, userId, {
                      status: 'awaiting_user_review',
                      scene_description: sceneGraph,
                      director_report: directorReport
                    });
                    throw new DirectorBlockingHaltError({
                      checkpoint: DIRECTOR_CHECKPOINTS.BEAT,
                      verdict: verdictC,
                      artifactKey: beat.beat_id,
                      reason: decision.reason
                    });
                  } else {
                    // ADVISORY — log + ship the beat as-is. Verdict is in
                    // directorReport.beat for panel surfacing.
                    logger.info(
                      `[V4Pipeline] director:beat advisory mode — beat ${beat.beat_id} ` +
                      `escalation triggered (${decision.reason}) but proceeding without halt`
                    );
                  }
                }

                if (decision.shouldRetry) {
                  progress('director:beat', `beat ${beat.beat_id} auto-retry: ${decision.reason}`, {
                    checkpoint: DIRECTOR_CHECKPOINTS.BEAT,
                    beat_id: beat.beat_id,
                    retry: true
                  });

                  // V4 hotfix 2026-05-01 — Smart retry replaces cheap retry as
                  // the SOLE retry mechanism. Previously the pipeline ran two
                  // retries: (1) cheap concat of `finding.remediation.prompt_delta`
                  // strings, then (2) smart Gemini synthesis if cheap also failed.
                  // But the cost differential was ~$0.01 (one Gemini synth call)
                  // and the time differential was ~5s (synth call latency) —
                  // negligible compared to the ~170s of Kling+Sync rendering
                  // per retry. Running cheap-then-smart added an entire wasted
                  // ~170s + ~$1.10 retry attempt for marginal benefit. One
                  // smart retry beats two retries on every dimension that
                  // matters (latency, cost, fix probability).
                  //
                  // Set V4_SMART_RETRY=false to fall back to cheap concat
                  // (escape hatch for cost-conscious runs OR if Gemini synth
                  // quality regresses). Default: smart retry on.
                  let retryDirective = decision.nudgePromptDelta;
                  let retryEditedDialogue = null;
                  if (process.env.V4_SMART_RETRY !== 'false') {
                    progress('director:beat', `beat ${beat.beat_id} smart-retry: synthesizing director directive`, {
                      checkpoint: DIRECTOR_CHECKPOINTS.BEAT,
                      beat_id: beat.beat_id,
                      smart_retry: true
                    });
                    try {
                      const artifactContent = {
                        type: 'beat',
                        beat_id: beat.beat_id,
                        beat_type: beat.type,
                        dialogue: beat.dialogue || beat.voiceover_text || null,
                        subtext: beat.subtext || null,
                        expression_notes: beat.expression_notes || null,
                        emotion: beat.emotion || null,
                        duration_seconds: beat.duration_seconds || null,
                        scene_id: scene?.scene_id || null,
                        scene_anchor: scene?.scene_visual_anchor_prompt || scene?.location || null,
                        ambient_bed_prompt: scene?.ambient_bed_prompt || null
                      };
                      const synth = await this._synthesizeEditFromContext({
                        verdict: verdictC,
                        checkpoint: 'beat',
                        artifactId: beat.beat_id,
                        artifactContent
                      });
                      retryDirective = synth.notes;
                      retryEditedDialogue = synth.edited_dialogue;
                      directorReport.beat[beat.beat_id + '_smart_retry'] = {
                        source: synth.source,
                        directive: synth.notes,
                        edited_dialogue: synth.edited_dialogue || null,
                        attempted_at: new Date().toISOString()
                      };
                      progress('director:beat',
                        `beat ${beat.beat_id} smart-retry directive synthesized (source: ${synth.source})`,
                        { beat_id: beat.beat_id, smart_retry: true, synth_source: synth.source }
                      );
                      if (synth.edited_dialogue) {
                        progress('director:beat',
                          `beat ${beat.beat_id} smart-retry: dialogue rewritten by synthesis`,
                          { beat_id: beat.beat_id, smart_retry: true }
                        );
                      }
                    } catch (synthErr) {
                      logger.warn(
                        `beat ${beat.beat_id} smart synthesis failed (${synthErr.message}) — ` +
                        `falling back to cheap concat directive for the retry`
                      );
                      // retryDirective stays as decision.nudgePromptDelta (cheap concat).
                    }
                  }

                  // Stamp director_nudge so generators splice it into the model
                  // prompt via BaseBeatGenerator._appendDirectorNudge / per-generator
                  // prompt builders. Optionally swap dialogue if smart synthesis
                  // produced a rewrite (restored after the render so Lens A
                  // coherence sees the authored line on the record).
                  beat.director_nudge = retryDirective;
                  const originalRetryDialogue = beat.dialogue || null;
                  if (retryEditedDialogue) {
                    beat.dialogue = retryEditedDialogue;
                  }
                  beat.generated_video_url = null;
                  beat.endframe_url = null;

                  try {
                    const result2 = await router.generate({
                      beat,
                      scene,
                      refStack,
                      personas,
                      episodeContext,
                      previousBeat
                    });

                    // V4 hotfix 2026-05-01 — Restore the original authored
                    // dialogue on the beat record now that the render captured
                    // the smart-synthesized version in audio. Lens A coherence
                    // checks + downstream consumers should see the authored
                    // line on `beat.dialogue`; the synthesized rewrite lives
                    // only in the rendered audio stream + the audit row at
                    // directorReport.beat[<id>_smart_retry].edited_dialogue.
                    if (retryEditedDialogue && originalRetryDialogue) {
                      beat.dialogue = originalRetryDialogue;
                    }

                    // Re-run QC8 (cheap) and replace the buffer
                    let qc2 = null;
                    try {
                      qc2 = await runQualityGate({ videoBuffer: result2.videoBuffer, beat });
                      beat.quality_gate = qc2;
                    } catch (qcErr) {
                      logger.warn(`beat ${beat.beat_id} QC8 retake threw: ${qcErr.message}`);
                    }

                    // Replace the previously-pushed buffer + metadata with the retake.
                    // We push only AFTER the judge accepts the retry; if the second
                    // pass also fails, we escalate without persisting the retake.
                    const retakeUrl = await uploadBufferToStorage(
                      result2.videoBuffer,
                      'videos/v4-beats',
                      `${beat.beat_id}-retake.mp4`,
                      'video/mp4'
                    );
                    beat.generated_video_url = retakeUrl;

                    try {
                      const endframeBuffer2 = await extractBeatEndframe(result2.videoBuffer);
                      beat.endframe_url = await uploadBufferToStorage(
                        endframeBuffer2,
                        'videos/v4-endframes',
                        `${beat.beat_id}-retake-end.jpg`,
                        'image/jpeg'
                      );
                    } catch (endErr) {
                      logger.warn(`beat ${beat.beat_id} retake endframe extraction failed: ${endErr.message}`);
                    }

                    // Re-judge with isRetry=true (Phase 7 / B5 — same lensCFn helper).
                    verdictC = await lensCFn({
                      beat,
                      scene,
                      endframeImage: beat.endframe_url || retakeUrl,
                      endframeMime: 'image/jpeg',
                      previousEndframeImage: previousBeat?.endframe_url || null,
                      previousEndframeMime: 'image/jpeg',
                      sceneMasterThumbnail: scene?.scene_master_url || null,
                      sceneMasterMime: 'image/jpeg',
                      personas,
                      routingMetadata: {
                        modelUsed: result2.modelUsed,
                        costUsd: result2.costUsd || null,
                        metadata: result2.metadata || null
                      },
                      storyFocus: isCommercialEp ? 'commercial' : (story.story_focus || 'drama'),
                      productIntegrationStyle: story.product_integration_style || 'naturalistic_placement',
                      productSignatureFeatures: story.subject?.signature_features || [],
                      subjectName: story.subject?.name || null,
                      isRetry: true,
                      ...commercialJudgeExtras
                    });
                    directorReport.beat[beat.beat_id] = verdictC;
                    accumulateNotes(verdictC, `lens_c:beat:${beat.beat_id}:retry`);
                    directorReport.retries = decision.nextRetriesState;
                    progress('director:beat', `beat ${beat.beat_id} retry verdict: ${fmtVerdict(verdictC)}`, {
                      checkpoint: DIRECTOR_CHECKPOINTS.BEAT,
                      beat_id: beat.beat_id,
                      retry: true,
                      verdict: verdictC?.verdict,
                      score: verdictC?.overall_score
                    });

                    // Replace the previously-pushed buffer (the failed first attempt
                    // is still in beatVideoBuffers — overwrite the last entry).
                    beatVideoBuffers[beatVideoBuffers.length - 1] = result2.videoBuffer;
                    beatMetadata[beatMetadata.length - 1] = {
                      beat_id: beat.beat_id,
                      model_used: result2.modelUsed,
                      duration_seconds: beat.duration_seconds,
                      actual_duration_sec: result2.durationSec
                    };

                    // Second-attempt failure → escalate
                    const final = decideDirectorRetry({
                      verdict: verdictC,
                      checkpoint: DIRECTOR_CHECKPOINTS.BEAT,
                      artifactKey: beat.beat_id,
                      retriesState: directorReport.retries
                    });


                    if (final.shouldEscalate) {
                      if (lensCMode === 'blocking') {
                        // BLOCKING — halt + persist context for the panel.
                        directorReport.halt = {
                          checkpoint: DIRECTOR_CHECKPOINTS.BEAT,
                          beat_id: beat.beat_id,
                          scene_id: scene?.scene_id || null,
                          artifactKey: beat.beat_id,
                          verdict: verdictC,
                          reason: `retake still ${verdictC?.verdict} — escalating`,
                          pass: 'retry',
                          ts: new Date().toISOString()
                        };
                        await updateBrandStoryEpisode(newEpisode.id, userId, {
                          status: 'awaiting_user_review',
                          scene_description: sceneGraph,
                          director_report: directorReport
                        });
                        throw new DirectorBlockingHaltError({
                          checkpoint: DIRECTOR_CHECKPOINTS.BEAT,
                          verdict: verdictC,
                          artifactKey: beat.beat_id,
                          reason: `retake still ${verdictC?.verdict} — escalating`
                        });
                      } else {
                        // ADVISORY — log + ship the post-retry beat. The
                        // verdict is in directorReport.beat for panel surfacing.
                        logger.info(
                          `[V4Pipeline] director:beat advisory mode — beat ${beat.beat_id} ` +
                          `retake still ${verdictC?.verdict} — proceeding without halt`
                        );
                      }
                    }
                  } catch (regenErr) {
                    if (regenErr instanceof DirectorBlockingHaltError) throw regenErr;
                    logger.warn(`V4 Director Lens C retake failed (beat ${beat.beat_id}): ${regenErr.message}`);
                    directorReport.beat[beat.beat_id + '_retry_error'] = regenErr.message;
                  }
                }
              }
            } catch (dirErr) {
              if (dirErr instanceof DirectorBlockingHaltError) throw dirErr;
              logger.warn(`V4 Director Agent Lens C (beat ${beat.beat_id}) failed (non-fatal): ${dirErr.message}`);
              if (!directorReport.beat) directorReport.beat = {};
              directorReport.beat[beat.beat_id] = { error: dirErr.message };
            }
          }

          beatVideoBuffers.push(result.videoBuffer);
          beatMetadata.push({
            beat_id: beat.beat_id,
            model_used: result.modelUsed,
            duration_seconds: beat.duration_seconds,
            actual_duration_sec: result.durationSec
          });
          previousBeat = beat;

          // Persist beat-level progress so partial failures can resume
          await updateBrandStoryEpisode(newEpisode.id, userId, {
            scene_description: sceneGraph,
            director_report: directorReport
          });
        } catch (err) {
          // V4 hotfix 2026-04-30 — Director blocking-mode halt MUST propagate.
          // Before this fix, the per-beat catch swallowed DirectorBlockingHaltError
          // along with all other errors, which meant `BRAND_STORY_DIRECTOR_AGENT=blocking`
          // did NOT halt the episode at the offending beat — the pipeline marked
          // the beat 'failed' and marched on through the remaining beats, only
          // eventually halting at Lens D (post-assembly). This wasted cost on
          // beats that would never ship and confused the user (logs showed
          // "halted" but pipeline continued). The Scene Master loop at
          // line 4528 already had the same instanceof guard; the beat loop
          // was missing it. Producing the halt outward to the runV4Pipeline
          // outer catch is what marks the episode awaiting_user_review per the
          // halt-context persistence shipped in P0.5.
          if (err instanceof DirectorBlockingHaltError) {
            logger.error(`beat ${beat.beat_id} HALTED (blocking-mode propagation): ${err.message}`);
            // Mark the beat failed before re-throwing so the panel reflects which
            // beat triggered the halt; the halt-context on directorReport.halt was
            // already persisted at the originating Lens C halt site.
            beat.status = 'failed';
            beat.error_message = err.message;
            await updateBrandStoryEpisode(newEpisode.id, userId, {
              scene_description: sceneGraph
            });
            throw err; // surface to outer pipeline → episode awaiting_user_review
          }
          logger.error(`beat ${beat.beat_id} failed: ${err.message}`);
          beat.status = 'failed';
          beat.error_message = err.message;
          await updateBrandStoryEpisode(newEpisode.id, userId, {
            scene_description: sceneGraph
          });
        }
      }

      // ─── V4 Phase 6.1 — Narrative bridge beat ───
      // When Gemini emitted scene.bridge_to_next, render a 2-3s Veo B-roll
      // connector that shows HOW the story transitions from this scene's
      // endframe to the next scene's master. The bridge is spliced into the
      // beat stream as a synthetic SCENE_BRIDGE beat so the assembly picks
      // it up without any additional post-production wiring.
      // ─── End-of-scene failure detection (per-beat scenes) ───
      // A scene that emerges from the per-beat loop with zero usable beat
      // videos counts as a failure. Track it for the commercial halt guardrail
      // (the next iteration's top-of-loop check will trigger the halt).
      const beatsWithVideoAfter = countSceneBeatsWithVideo(scene);
      if (scene.type !== 'montage' && beatsWithVideoAfter === beatsWithVideoBefore) {
        // No new beats produced video this scene → scene failed.
        const generativeBeatCount = (scene.beats || []).filter(b => b.type !== 'SPEED_RAMP_TRANSITION' && b.type !== 'TEXT_OVERLAY_CARD').length;
        if (generativeBeatCount > 0) {
          // Only flag as failure if there were generative beats expected.
          sceneFailureCount++;
          failedSceneIds.push(scene.scene_id || '(unnamed)');
          logger.warn(`scene ${scene.scene_id} produced 0/${generativeBeatCount} beat videos — flagged as failed scene${isCommercialStory ? ' (commercial halt may trigger on next scene)' : ''}`);
        }
      }

      // V4 hotfix 2026-04-30 — auto-bridge fallback. When the screenplay
      // generator did NOT emit `scene.bridge_to_next` BUT scenes are in
      // distinct locations, synthesize a default bridge spec so the viewer
      // gets narrative connective tissue instead of an unexplained jump.
      // The user reported "the video made no viewing sense" on a story where
      // only 1 of 2 scene boundaries had a bridge — the other was a hard
      // cut between Plaza → Pavilion with no transit.
      //
      // Detection: distinct location strings (case-insensitive trim) is the
      // primary signal. If scene.location isn't reliably populated, fall
      // back to "always bridge unless the next scene is in the same scope"
      // which is generous but cheap — bridge clips cost ~$0 (Veo tier 1).
      //
      // Set V4_BRIDGE_BEATS_AUTO=false to disable the auto-fallback and
      // restore the strict "only when Gemini emitted bridge_to_next" path.
      const sceneIdxForBridge = sceneGraph.scenes.indexOf(scene);
      const nextSceneForBridge = sceneGraph.scenes[sceneIdxForBridge + 1];
      const autoBridgeEnabled = process.env.V4_BRIDGE_BEATS_AUTO !== 'false';
      const _normLoc = (s) => String(s?.location || '').toLowerCase().trim();
      const locationsDiffer = nextSceneForBridge
        && _normLoc(scene) && _normLoc(nextSceneForBridge)
        && _normLoc(scene) !== _normLoc(nextSceneForBridge);
      const shouldAutoBridge =
        autoBridgeEnabled &&
        nextSceneForBridge &&
        !scene.bridge_to_next &&
        locationsDiffer;
      if (shouldAutoBridge) {
        scene.bridge_to_next = {
          framing: 'bridge_transit',
          duration_seconds: 2.5,
          visual_prompt:
            `Transit shot connecting "${scene.location || 'previous location'}" to ` +
            `"${nextSceneForBridge.location || 'next location'}". ` +
            'Smooth movement, naturalistic lighting register matching the originating scene\'s ambient mood. ' +
            'No persona on-screen; environmental B-roll only. Veo first-frame anchored to the scene endframe; ' +
            'last-frame hint is the next scene\'s master.',
          ambient_sound: scene.ambient_bed_prompt || '',
          _auto_generated: true
        };
        logger.info(
          `[V4Pipeline] auto-bridge: scene ${scene.scene_id || `s${sceneIdxForBridge}`} → ` +
          `${nextSceneForBridge.scene_id || `s${sceneIdxForBridge + 1}`} ` +
          `(distinct locations) — synthesizing default bridge_to_next spec`
        );
      }

      if (process.env.V4_BRIDGE_BEATS !== 'false' && scene.bridge_to_next && typeof scene.bridge_to_next === 'object') {
        const sceneIdx = sceneGraph.scenes.indexOf(scene);
        const nextScene = sceneGraph.scenes[sceneIdx + 1];
        if (nextScene) {
          const bridgeBeat = {
            beat_id: `${scene.scene_id || `s${sceneIdx}`}_bridge`,
            type: 'SCENE_BRIDGE',
            framing: scene.bridge_to_next.framing || 'bridge_transit',
            duration_seconds: Math.max(2, Math.min(4, scene.bridge_to_next.duration_seconds || 2.5)),
            visual_prompt: scene.bridge_to_next.visual_prompt || '',
            ambient_sound: scene.bridge_to_next.ambient_sound || '',
            bridge_from_scene_endframe_url: previousBeat?.endframe_url || null,
            bridge_to_scene_master_url: nextScene.scene_master_url || null,
            personas_present: [],
            _auto_generated: scene.bridge_to_next._auto_generated === true
          };
          try {
            const result = await router.generate({
              beat: bridgeBeat,
              scene,
              refStack: [],
              personas,
              episodeContext,
              previousBeat
            });
            const bridgeUrl = await uploadBufferToStorage(
              result.videoBuffer,
              'videos/v4-beats',
              `${bridgeBeat.beat_id}.mp4`,
              'video/mp4'
            );
            bridgeBeat.generated_video_url = bridgeUrl;
            try {
              const endframeBuffer = await extractBeatEndframe(result.videoBuffer);
              bridgeBeat.endframe_url = await uploadBufferToStorage(
                endframeBuffer,
                'videos/v4-endframes',
                `${bridgeBeat.beat_id}-end.jpg`,
                'image/jpeg'
              );
            } catch {}
            beatVideoBuffers.push(result.videoBuffer);
            beatMetadata.push({
              beat_id: bridgeBeat.beat_id,
              model_used: result.modelUsed,
              duration_seconds: bridgeBeat.duration_seconds,
              actual_duration_sec: result.durationSec
            });
            // Splice the bridge into the scene's beats list so the Director
            // Panel sees it and resume paths can find it.
            scene.beats.push(bridgeBeat);
            previousBeat = bridgeBeat;
            await updateBrandStoryEpisode(newEpisode.id, userId, {
              scene_description: sceneGraph
            });
          } catch (err) {
            logger.warn(`scene ${scene.scene_id} bridge beat failed — falling back to xfade: ${err.message}`);
          }
        }
      }
    }

    if (beatVideoBuffers.length === 0) {
      await updateBrandStoryEpisode(newEpisode.id, userId, {
        status: 'failed',
        error_message: 'no beats generated successfully'
      });
      throw new Error('V4: no beats generated successfully');
    }

    // ─── Commercial halt escalation (post-loop) ───
    // If the commercial halt fired (one or more scenes failed for a commercial
    // spot), mark the episode awaiting_user_review and STOP the pipeline.
    // We do NOT proceed to music / LUT / assembly / Lens D for a half-spot —
    // there's nothing for the Director to grade and shipping it would be worse
    // than not shipping at all.
    if (isCommercialStory && sceneFailureCount > 0) {
      const reason = `commercial halt: ${sceneFailureCount} scene(s) failed [${failedSceneIds.join(', ')}]. Episode aborted; user must review and trigger fixes via Director Panel.`;
      logger.error(reason);
      await updateBrandStoryEpisode(newEpisode.id, userId, {
        status: 'awaiting_user_review',
        error_message: reason
      });
      progress('halt', reason, { failedSceneIds, sceneFailureCount });
      throw new Error(`V4: ${reason}`);
    }

    // ─── Step 8: Music bed (ElevenLabs Music sized to assembled duration) ───
    let musicBedBuffer = null;
    let musicBedUrl = null;
    if (sceneGraph.music_bed_intent && musicService.isAvailable()) {
      const totalDuration = estimateEpisodeDuration(beatMetadata);
      progress('music', `generating music bed (${totalDuration.toFixed(0)}s)`);
      try {
        const musicResult = await musicService.generateMusicBed({
          musicBedIntent: sceneGraph.music_bed_intent,
          durationSec: totalDuration
        });
        musicBedBuffer = musicResult.audioBuffer;
        musicBedUrl = await uploadBufferToStorage(
          musicResult.audioBuffer,
          'audio/v4-music',
          `episode-${newEpisode.id}-music.mp3`,
          'audio/mpeg'
        );
      } catch (err) {
        logger.warn(`V4: music generation failed (non-fatal): ${err.message}`);
      }
    }

    // ─── Step 9: Post-production (assembly + 2-pass LUT + music mix) ───
    progress('post_production', `assembly + 2-pass LUT grade${musicBedBuffer ? ' + music mix' : ''}`);
    await updateBrandStoryEpisode(newEpisode.id, userId, {
      status: 'applying_lut',
      music_bed_url: musicBedUrl
    });

    const episodeLutId = resolveEpisodeLut(story, { ...newEpisode, scene_description: sceneGraph });
    const brandLutId = story.brand_palette_lut_id || null;
    progress('post_production', `resolved LUT → ${episodeLutId}${brandLutId ? ` (+ brand trim ${brandLutId})` : ''}`);

    // Build beatMetadata with dialogue fields so the subtitle burn-in + music
    // ducking can use them. beatMetadata is currently a thin object, but the
    // scene-graph beats (inside sceneGraph.scenes[].beats) carry the dialogue.
    // Match index-for-index because beat generation iterated scenes in order.
    const enrichedBeatMetadata = [];
    let idx = 0;
    for (const scene of sceneGraph.scenes) {
      for (const beat of (scene.beats || [])) {
        if (beat.type === 'SPEED_RAMP_TRANSITION') continue;
        if (!beat.generated_video_url) continue;
        const base = beatMetadata[idx] || {};
        enrichedBeatMetadata.push({
          ...base,
          beat_id: beat.beat_id,
          dialogue: beat.dialogue || null,
          dialogues: beat.dialogues || null,
          exchanges: beat.exchanges || null,
          voiceover_text: beat.voiceover_text || null,
          ambient_sound: beat.ambient_sound || null
        });
        idx++;
      }
    }

    const episodeMeta = {
      series_title: story.storyline?.title || story.name || 'Untitled Series',
      episode_title: sceneGraph.title || `Episode ${newEpisode.episode_number}`,
      cliffhanger: sceneGraph.cliffhanger || '',
      // Phase 6.4 — branded cards. Brand kit drives font + color palette on
      // title/end cards; CTA text appears as the 3rd line on the end card
      // when the story has one configured.
      brand_kit: brandKit || null,
      cta_text: story.cta_text || story.storyline?.cta_text || null
    };

    const postProductionResult = await runPostProduction({
      beatVideoBuffers,
      beatMetadata: enrichedBeatMetadata,
      episodeLutId,
      brandLutId,
      musicBedBuffer,
      sceneGraph: sceneGraph.scenes,
      sceneDescription: sceneGraph,
      episodeMeta,
      burnSubtitles: true
    });
    const finalVideoBuffer = postProductionResult.finalBuffer;

    // Upload the SRT separately so the UI can expose it as a download
    let subtitleUrl = null;
    if (postProductionResult.srtContent) {
      try {
        subtitleUrl = await uploadBufferToStorage(
          Buffer.from(postProductionResult.srtContent, 'utf-8'),
          'srt/v4',
          `episode-${newEpisode.episode_number}.srt`,
          'text/plain'
        );
      } catch (err) {
        logger.warn(`V4: SRT upload failed (non-fatal): ${err.message}`);
      }
    }

    // ─── Step 10: Upload final + mark ready ───
    progress('upload', 'uploading final episode video');
    // V4 Wave 6 / F2 — `let` instead of `const` so the Lens D auto-reassemble
    // path below can reassign to the reassembled URL when re-judge passes.
    let finalVideoUrl = await uploadBufferToStorage(
      finalVideoBuffer,
      'videos/v4-final',
      `episode-${newEpisode.episode_number}-final.mp4`,
      'video/mp4'
    );

    // ─── Step 10.5: Director Agent (Layer 3) — Lens D "Picture Lock" ───
    // Multimodal full-video critique. ADVISORY ONLY — Lens D never auto-retries
    // (full episodes are too expensive); findings recommend targeted scene/beat
    // regenerate actions surfaced via the Director Panel's Lens D card.
    // resolveDirectorMode() downgrades 'blocking' → 'advisory' for this lens.
    if (directorAgent && finalVideoUrl && directorModes[DIRECTOR_CHECKPOINTS.EPISODE] !== 'off') {
      const lensDMode = directorModes[DIRECTOR_CHECKPOINTS.EPISODE];
      // V4 Phase 7 / B2 — route Lens D by genre. Commercial stories get
      // judgeCommercialEpisode (commercial dimensions: creative_bravery /
      // brand_recall / hook_first_1_5s / tagline_landing / etc.) instead
      // of the prestige judgeEpisode (rhythm / music_ducking / cliffhanger_sting).
      // The verdict integrates into N2's ship-gate lifecycle below — same
      // verdict.kind / verdict.overall_score contract; the SCORING DIMENSIONS
      // are commercial-calibrated.
      const isCommercialEp = isCommercialGenre(story);
      const lensDFn = isCommercialEp
        ? directorAgent.judgeCommercialEpisode.bind(directorAgent)
        : directorAgent.judgeEpisode.bind(directorAgent);
      const lensDLabel = isCommercialEp ? DIRECTOR_CHECKPOINTS.COMMERCIAL_EPISODE : DIRECTOR_CHECKPOINTS.EPISODE;
      try {
        // judgeCommercialEpisode and judgeEpisode share buildEpisode-style args;
        // commercialEpisode uses { episodeVideoBuffer, sceneGraph, episodeMeta }.
        // We pass a superset that satisfies both; extra fields are ignored.
        const verdictD = await lensDFn({
          // 2026-04-28 fix: Vertex rejects arbitrary HTTPS URIs in file_data
          // for video (returns 400 INVALID_ARGUMENT). Pass the buffer for
          // inline_data transport — works reliably for assembled episodes
          // (typically 5-20MB, well under Vertex's inline limit).
          episodeVideoBuffer: finalVideoBuffer,
          episodeVideoUrl: finalVideoUrl,  // kept as gs:// fallback if ever supplied
          videoMime: 'video/mp4',
          sceneGraph,
          sonicSeriesBible: story?.sonic_series_bible || null,
          sonicWorld: sceneGraph?.sonic_world || null,
          postProductionManifest: {
            lutId: episodeLutId,
            musicBedUrl,
            subtitleUrl,
            beatCount: enrichedBeatMetadata.length,
            sceneCount: sceneGraph.scenes?.length || 0
          },
          // For judgeCommercialEpisode (Phase 6 contract): episodeMeta carries
          // the commercial-craft dimensions context that the rubric reads.
          episodeMeta: isCommercialEp ? {
            commercial_brief: story.commercial_brief || null,
            brand_kit: brandKit || null,
            episode_number: newEpisode.episode_number,
            episode_title: sceneGraph.title || `Episode ${newEpisode.episode_number}`,
            cta_text: story.cta_text || story.storyline?.cta_text || null
          } : undefined,
          storyFocus: isCommercialEp ? 'commercial' : (story.story_focus || 'drama')
        });
        directorReport.episode = verdictD;
        accumulateNotes(verdictD, 'lens_d:episode');
        progress('director:episode', `episode: ${fmtVerdict(verdictD)}`, {
          checkpoint: lensDLabel,
          mode: lensDMode,
          verdict: verdictD?.verdict,
          score: verdictD?.overall_score,
          findings: (verdictD?.findings || []).length
        });
      } catch (dirErr) {
        logger.warn(`V4 Director Agent Lens D (${lensDLabel}) failed (non-fatal): ${dirErr.message}`);
        directorReport.episode = { error: dirErr.message };
      }
    }

    // V4 P1.3 — Lens D ship gate, full parity across all genres.
    //
    // User-confirmed 2026-04-29: reverses the earlier commercial-only Wave 5
    // scoping. Reassemble cost (~$0.10-0.50 per soft-reject in compute,
    // ffmpeg-only stages 3/4/6, no model calls) is acceptable for the quality
    // gain on non-commercial work. Quality-first principle.
    //
    // Decision matrix (applies to all genres):
    //   pass | pass_with_notes (score >= 75) → ship
    //   soft_reject (60-75) → ONE auto-reassemble (LUT swap + music re-mix
    //                          + sub re-burn) → re-judge:
    //                          ↳ score >= 75 → ship
    //                          ↳ score 60-75 → ready_with_director_warning
    //                          ↳ score < 60  → awaiting_user_review
    //   soft_reject (< 60)  → straight to awaiting_user_review
    //   hard_reject         → awaiting_user_review
    //
    // Score-only ladder, no regression-protection rule (user-confirmed):
    // post-reassemble score is trusted absolutely. If reassemble lands at 76
    // and the original was 80, ship at 76 — the gate cares about absolute
    // craft bar, not relative motion.
    let finalEpisodeStatus = 'ready';
    const verdictDFinal = directorReport.episode || null;
    const lensDScore = Number.isFinite(verdictDFinal?.overall_score) ? verdictDFinal.overall_score : null;
    const lensDVerdict = verdictDFinal?.verdict || null;

    // V4 Wave 6 / F2 — Lens D auto-reassemble path. Wires the soft_reject
    // 60-75 case to actually invoke this.reassembleEpisode (which re-runs
    // post-production stages 3/4/6) and re-judge before escalating.
    // Replaces the Wave 5 stub that queued the remediation but always
    // escalated. The reassembleEpisode infrastructure has existed since
    // Phase 1b ([services/BrandStoryService.js reassembleEpisode]) — we
    // just weren't calling it from the ship-gate.
    let lensDAutoReassembleAttempted = false;
    let reassembledFinalVideoUrl = null;
    let reassembledFinalVideoBuffer = null;

    // V4 P1.3 — full-parity ship gate runs for ALL genres now (commercial
    // and prestige). Lens D advisory-only path retired.
    if (lensDVerdict) {
      const passes = (lensDVerdict === 'pass' || lensDVerdict === 'pass_with_notes') && (lensDScore == null || lensDScore >= 75);
      if (!passes) {
        if (lensDVerdict === 'hard_reject' || (lensDScore != null && lensDScore < 60)) {
          finalEpisodeStatus = 'awaiting_user_review';
          progress('director:episode', `Lens D ship gate: ${lensDVerdict} (score=${lensDScore}) — escalating to user_review`);
        } else if (lensDVerdict === 'soft_reject' && lensDScore != null && lensDScore >= 60) {
          // Score 60-75 — try ONE auto-reassemble. Identify which axes are
          // remediable via post-production-only stages (no beat re-render).
          const findingIds = new Set((verdictDFinal.findings || []).map(f => f.id));
          const lutMismatch = findingIds.has('lut_mismatch') || findingIds.has('lut_consistency_cross_scene') || findingIds.has('lut_mood_fit');
          const musicMissing = findingIds.has('music_dialogue_ducking_feel');
          const subsMissing = findingIds.has('subtitle_legibility_taste');
          const remediable = lutMismatch || musicMissing || subsMissing;

          if (!remediable) {
            // No post-production-only fix path. Escalate.
            finalEpisodeStatus = 'awaiting_user_review';
            progress('director:episode', `Lens D ship gate: soft_reject (score=${lensDScore}) — no remediable axes — escalating to user_review`);
          } else {
            // Persist the in-progress final + LUT override BEFORE reassemble
            // so reassembleEpisode picks them up from the episode row.
            const overrideUpdates = {
              scene_description: sceneGraph,
              final_video_url: finalVideoUrl,
              subtitle_url: subtitleUrl,
              status: 'regenerating_beat', // transient; reassembleEpisode sets this too
              director_report: directorReport
            };
            // LUT override: when Lens D flagged LUT mismatch, swap to the
            // genre default for the next pass. The genre-pool validator
            // (N7) accepts this since it's the genre default by definition.
            if (lutMismatch) {
              const genreForOverride = story.subject?.genre || story.storyline?.genre;
              const genreDefault = getDefaultLutForGenre(genreForOverride);
              if (genreDefault?.id && genreDefault.id !== episodeLutId) {
                overrideUpdates.lut_id = genreDefault.id;
                progress('director:episode', `Lens D auto-reassemble: LUT override ${episodeLutId} → ${genreDefault.id} (genre=${genreForOverride})`);
              } else {
                overrideUpdates.lut_id = episodeLutId;
              }
            } else {
              overrideUpdates.lut_id = episodeLutId;
            }

            await updateBrandStoryEpisode(newEpisode.id, userId, overrideUpdates).catch((persistErr) => {
              logger.warn(`Lens D auto-reassemble: pre-persist failed (non-fatal): ${persistErr.message}`);
            });

            try {
              progress('director:episode', `Lens D ship gate: soft_reject (score=${lensDScore}) — invoking auto-reassemble (lut=${lutMismatch}, music=${musicMissing}, subs=${subsMissing})`);
              await this.reassembleEpisode(storyId, userId, newEpisode.id, onProgress);
              lensDAutoReassembleAttempted = true;

              // Reload the episode to capture the new final_video_url written
              // by reassembleEpisode (it suffixes -reassemble-{ts}).
              const reassembledEpisode = await getBrandStoryEpisodeById(newEpisode.id, userId);
              reassembledFinalVideoUrl = reassembledEpisode?.final_video_url || finalVideoUrl;

              // Download the reassembled buffer for re-judging (Vertex needs
              // inline_data for video, not a URL).
              try {
                const reassembledResp = await axios.get(reassembledFinalVideoUrl, { responseType: 'arraybuffer', timeout: 90000 });
                reassembledFinalVideoBuffer = Buffer.from(reassembledResp.data);
              } catch (downloadErr) {
                logger.warn(`Lens D auto-reassemble: failed to download new final for re-judge (${downloadErr.message}) — escalating`);
                finalEpisodeStatus = 'awaiting_user_review';
              }

              // Re-judge with the reassembled cut.
              if (reassembledFinalVideoBuffer && directorAgent) {
                // V4 P1.3 — genre-aware re-judge (matches the original verdict's
                // rubric path, regardless of commercial vs prestige).
                const lensDFn2 = isCommercialEp
                  ? directorAgent.judgeCommercialEpisode.bind(directorAgent)
                  : directorAgent.judgeEpisode.bind(directorAgent);
                try {
                  const verdictD2 = await lensDFn2({
                    episodeVideoBuffer: reassembledFinalVideoBuffer,
                    episodeVideoUrl: reassembledFinalVideoUrl,
                    videoMime: 'video/mp4',
                    sceneGraph,
                    sonicSeriesBible: story?.sonic_series_bible || null,
                    sonicWorld: sceneGraph?.sonic_world || null,
                    postProductionManifest: {
                      lutId: overrideUpdates.lut_id,
                      musicBedUrl: null,
                      subtitleUrl,
                      beatCount: enrichedBeatMetadata?.length || 0,
                      sceneCount: sceneGraph.scenes?.length || 0
                    },
                    storyFocus: story.story_focus || 'drama',
                    isRetry: true
                  });
                  directorReport.episode_reassembled = verdictD2;
                  const reScore = Number.isFinite(verdictD2?.overall_score) ? verdictD2.overall_score : null;
                  const reVerdict = verdictD2?.verdict || null;
                  // V4 P1.3 — score-only ladder, no regression rule (user-confirmed):
                  //   re-verdict pass | pass_with_notes ≥ 75 → ready
                  //   re-verdict 60-75                       → ready_with_director_warning (new status)
                  //   re-verdict < 60 OR hard_reject         → awaiting_user_review
                  const rePass = (reVerdict === 'pass' || reVerdict === 'pass_with_notes') && (reScore == null || reScore >= 75);
                  const reInWarningBand = reScore != null && reScore >= 60 && reScore < 75;
                  progress('director:episode', `Lens D re-judge after reassemble: ${reVerdict} (score=${reScore})`);
                  if (rePass) {
                    finalEpisodeStatus = 'ready';
                    finalVideoUrl = reassembledFinalVideoUrl;
                  } else if (reInWarningBand && reVerdict !== 'hard_reject') {
                    finalEpisodeStatus = 'ready_with_director_warning';
                    finalVideoUrl = reassembledFinalVideoUrl;
                    progress('director:episode',
                      `re-verdict ${reVerdict} score=${reScore} in 60-75 warning band → ` +
                      `status=ready_with_director_warning (verdict drilldown surfaces in panel)`
                    );
                  } else {
                    finalEpisodeStatus = 'awaiting_user_review';
                    // Keep reassembled URL as the user-review candidate (better
                    // than the original — even if not passing, it's the more-
                    // remediated cut).
                    finalVideoUrl = reassembledFinalVideoUrl;
                  }
                } catch (reJudgeErr) {
                  logger.warn(`Lens D re-judge failed after reassemble (${reJudgeErr.message}) — escalating to user_review`);
                  finalEpisodeStatus = 'awaiting_user_review';
                  finalVideoUrl = reassembledFinalVideoUrl;
                }
              } else if (!reassembledFinalVideoBuffer) {
                finalEpisodeStatus = 'awaiting_user_review';
              }
            } catch (reassembleErr) {
              logger.warn(`Lens D auto-reassemble FAILED (${reassembleErr.message}) — escalating to user_review`);
              finalEpisodeStatus = 'awaiting_user_review';
            }
          }
        }
      }
    }

    const completedEpisode = await updateBrandStoryEpisode(newEpisode.id, userId, {
      scene_description: sceneGraph,
      final_video_url: finalVideoUrl,
      subtitle_url: subtitleUrl,
      status: finalEpisodeStatus,
      lut_id: episodeLutId,
      director_report: directorReport,
      lens_d_auto_reassemble_attempted: lensDAutoReassembleAttempted
    });

    if (finalEpisodeStatus === 'ready') {
      progress('complete', `Episode ${newEpisode.episode_number} ready: ${finalVideoUrl}`);
    } else {
      progress('awaiting_user_review', `Episode ${newEpisode.episode_number} flagged by Lens D ship gate — user review required`);
    }

    // ─── Step 11: Update story_so_far appendix for continuity ───
    try {
      await this._updateStorySoFar(storyId, userId, completedEpisode);
    } catch (soFarErr) {
      logger.warn(`V4: story_so_far update failed (non-fatal): ${soFarErr.message}`);
    }

    return completedEpisode;
  }

  /**
   * V4: Regenerate a single beat inside an existing episode WITHOUT
   * regenerating the screenplay, Scene Masters, or creating a new episode row.
   *
   * Flow:
   *   1. Load the story + episode + personas
   *   2. For EVERY beat in scene order:
   *        - If beat.beat_id === target: run it fresh through the router
   *        - Otherwise: download its existing generated_video_url and reuse
   *   3. Re-run full post-production (assembly + LUT + music mix + overlays)
   *   4. Upload new final_video_url, mark episode ready
   *
   * This method is the correct endpoint for the Director's Panel "Regenerate
   * beat" button. It replaces the Phase 1b stub that incorrectly invoked
   * runV4Pipeline() — which always tries to INSERT a new episode row and
   * fails on `brand_story_episodes_story_id_episode_number_key` the moment
   * the source episode isn't in `ready` status.
   *
   * Caught on 2026-04-11 first Director's Panel test: both s2b3 and s3b2
   * regenerate attempts hit duplicate-key errors because runV4Pipeline's
   * previousReady filter excluded the in-progress source episode, making
   * it compute episode_number = 1 and collide with itself.
   *
   * @param {string} storyId
   * @param {string} userId
   * @param {string} episodeId
   * @param {string} beatId
   * @param {Object} [overrides] - editable beat fields from req.body
   * @param {Function} [onProgress] - SSE-style progress callback
   * @returns {Promise<Object>} the updated episode record
   */
  async regenerateBeatInEpisode(storyId, userId, episodeId, beatId, overrides = {}, onProgress) {
    let emitter = null;
    try {
      emitter = getOrCreateProgressEmitter(episodeId);
    } catch {}

    const progress = (stage, detail, extras = {}) => {
      logger.info(`[V4Regenerate] ${stage}: ${detail}`);
      if (typeof onProgress === 'function') {
        try { onProgress(stage, detail); } catch {}
      }
      if (emitter) {
        try { emitter.emit(stage, detail, extras); } catch {}
      }
    };

    progress('regenerate_start', `beat=${beatId} episode=${episodeId}`);

    // ─── Step 1: load story + episode + personas ───
    const story = await getBrandStoryById(storyId, userId);
    if (!story) throw new Error(`V4 regen: story ${storyId} not found`);

    const episode = await getBrandStoryEpisodeById(episodeId, userId);
    if (!episode) throw new Error(`V4 regen: episode ${episodeId} not found`);

    const sceneGraph = episode.scene_description || {};
    if (!Array.isArray(sceneGraph.scenes)) throw new Error(`V4 regen: episode has no scene-graph`);

    const personas = Array.isArray(story.persona_config?.personas)
      ? story.persona_config.personas
      : (story.persona_config ? [story.persona_config] : []);

    // Find the target beat (mutated in place below)
    let targetBeat = null;
    for (const scene of sceneGraph.scenes) {
      for (const beat of (scene.beats || [])) {
        if (beat.beat_id === beatId) {
          targetBeat = beat;
          break;
        }
      }
      if (targetBeat) break;
    }
    if (!targetBeat) throw new Error(`V4 regen: beat ${beatId} not found in episode`);

    // Apply allowed field overrides from the Director's Panel edit form
    const ALLOWED_OVERRIDES = [
      'dialogue', 'expression_notes', 'action_prompt', 'lens', 'emotion',
      'duration_seconds', 'subject_focus', 'lighting_intent', 'camera_move',
      'ambient_sound', 'location', 'atmosphere', 'gaze_direction',
      'voiceover_text'
    ];
    for (const k of ALLOWED_OVERRIDES) {
      if (overrides[k] !== undefined) targetBeat[k] = overrides[k];
    }

    // V4 Director Agent — directorNotes carry-through. When the Director's Panel
    // (or Phase 2 auto-retry) supplies a prompt_delta from a soft_reject finding,
    // we stamp it onto the beat as `director_nudge` so beat generators can splice
    // it into the model prompt. In shadow mode this is observational (verdicts
    // collect in director_report); in blocking mode (Phase 2+) the orchestrator
    // computes the nudge from DirectorRetryPolicy.decideRetry and passes it here.
    if (typeof overrides.directorNotes === 'string' && overrides.directorNotes.length > 0) {
      targetBeat.director_nudge = overrides.directorNotes;
      progress('director_nudge', `beat ${beatId} regenerating with director nudge (${overrides.directorNotes.length} chars)`);
    }

    // Clear the generated state so downstream code knows to actually generate
    targetBeat.generated_video_url = null;
    targetBeat.endframe_url = null;
    targetBeat.status = 'generating';
    targetBeat.error_message = null;

    // ─── Step 2: mark episode status ───
    await updateBrandStoryEpisode(episodeId, userId, {
      status: 'regenerating_beat',
      scene_description: sceneGraph
    });

    // ─── Step 3: build the BeatRouter with shared deps ───
    const router = new BeatRouter({
      falServices: {
        kling: klingFalService,
        veo: veoService,
        syncLipsync: syncLipsyncFalService,
        seedream: seedreamFalService,
        flux: fluxFalService,
        omniHuman: omniHumanService
      },
      tts: ttsService,
      // V4 Audio Layer Overhaul Day 2 — same multi-speaker service as the
      // primary pipeline so per-beat retakes pick up the dialogue endpoint
      // when the user regenerates a GROUP_DIALOGUE_TWOSHOT beat.
      dialogueTTS: dialogueTTSService
    });

    const subjectReferenceImages = (story.subject?.reference_image_urls || []).filter(Boolean);
    const episodeContext = {
      visual_style_prefix: sceneGraph.visual_style_prefix || '',
      storyId,
      episodeId,
      userId,
      subjectReferenceImages,
      defaultNarratorVoiceId: personas[0]?.elevenlabs_voice_id
        || pickFallbackVoiceIdForPersonaInList(personas, 0, { reason: 'v4_default_narrator' })
        || 'nPczCjzI2devNBz1zQrb',
      uploadAudio: async ({ buffer, filename, mimeType }) => {
        return this._uploadBufferToStorage(buffer, userId, 'audio/v4', filename, mimeType);
      }
    };

    // ─── Step 4: assemble beatVideoBuffers in canonical scene order ───
    // For every beat in the scene-graph: if it's the target, run it fresh;
    // otherwise, fetch its existing Supabase URL and reuse the buffer.
    // This preserves beat order and previousBeat chaining for endframes.
    const beatVideoBuffers = [];
    const beatMetadata = [];
    const uploadBufferToStorage = (buffer, subfolder, filename, mimeType) =>
      this._uploadBufferToStorage(buffer, userId, subfolder, filename, mimeType);

    for (const scene of sceneGraph.scenes) {
      let previousBeat = null;

      // MONTAGE_SEQUENCE scenes are atomic — they don't support per-beat
      // regen in Phase 1b because the whole scene is one multi-shot call.
      // If the target beat is inside a montage scene, throw a clear error
      // rather than silently regenerating the whole montage.
      if (scene.type === 'montage') {
        for (const beat of (scene.beats || [])) {
          if (beat.beat_id === beatId) {
            throw new Error(`V4 regen: beat ${beatId} is inside a MONTAGE scene — montage scenes regenerate as a unit, not per-beat`);
          }
          // Pull the existing montage video for non-target beats
          if (beat.generated_video_url) {
            const cached = await axios.get(beat.generated_video_url, { responseType: 'arraybuffer', timeout: 60000 });
            beatVideoBuffers.push(Buffer.from(cached.data));
            beatMetadata.push({
              beat_id: beat.beat_id,
              model_used: beat.model_used,
              duration_seconds: beat.duration_seconds,
              actual_duration_sec: beat.actual_duration_sec || beat.duration_seconds
            });
            previousBeat = { endframe_url: beat.endframe_url };
            break; // montage is one beat-equivalent, skip the rest
          }
        }
        continue;
      }

      for (const beat of (scene.beats || [])) {
        if (beat.type === 'SPEED_RAMP_TRANSITION') continue;

        if (beat.beat_id === beatId) {
          // ─── This IS the target: regenerate ───
          progress('regenerating_beat', `beat ${beatId} [${beat.type}]`);
          const refStack = buildBeatRefStack({ beat, scene, previousBeat, personas });

          const result = await router.generate({
            beat,
            scene,
            refStack,
            personas,
            episodeContext,
            previousBeat
          });

          const publicUrl = await uploadBufferToStorage(
            result.videoBuffer,
            'videos/v4-beats',
            `${beat.beat_id}-regen-${Date.now()}.mp4`,
            'video/mp4'
          );
          beat.generated_video_url = publicUrl;

          // Extract + upload a fresh endframe (the next beat's previousBeat
          // chain isn't used on regen, but we keep the endframe field
          // consistent so future regens of the NEXT beat can chain correctly).
          try {
            const endframeBuffer = await extractBeatEndframe(result.videoBuffer);
            const endframeUrl = await uploadBufferToStorage(
              endframeBuffer,
              'videos/v4-endframes',
              `${beat.beat_id}-regen-${Date.now()}-end.jpg`,
              'image/jpeg'
            );
            beat.endframe_url = endframeUrl;
          } catch (err) {
            logger.warn(`V4 regen: endframe extraction failed for ${beat.beat_id}: ${err.message}`);
          }

          beatVideoBuffers.push(result.videoBuffer);
          beatMetadata.push({
            beat_id: beat.beat_id,
            model_used: result.modelUsed,
            duration_seconds: beat.duration_seconds,
            actual_duration_sec: result.durationSec
          });
          previousBeat = beat;
          continue;
        }

        // ─── Not the target: reuse the existing generated video ───
        if (!beat.generated_video_url) {
          // This beat failed on the original run and is missing — skip.
          // Post-production will assemble without it, which matches the
          // original episode's shape.
          logger.warn(`V4 regen: beat ${beat.beat_id} has no generated_video_url — skipping`);
          continue;
        }
        try {
          const cached = await axios.get(beat.generated_video_url, { responseType: 'arraybuffer', timeout: 60000 });
          beatVideoBuffers.push(Buffer.from(cached.data));
          beatMetadata.push({
            beat_id: beat.beat_id,
            model_used: beat.model_used,
            duration_seconds: beat.duration_seconds,
            actual_duration_sec: beat.actual_duration_sec || beat.duration_seconds
          });
          previousBeat = { endframe_url: beat.endframe_url };
        } catch (err) {
          logger.warn(`V4 regen: failed to fetch beat ${beat.beat_id} from ${beat.generated_video_url}: ${err.message}`);
        }
      }
    }

    if (beatVideoBuffers.length === 0) {
      throw new Error('V4 regen: no beat buffers assembled — cannot re-run post-production');
    }

    // Persist the regenerated beat URL before heading into post-production
    await updateBrandStoryEpisode(episodeId, userId, {
      scene_description: sceneGraph
    });

    // ─── Step 5: music bed — reuse if already generated on the original run ───
    let musicBedBuffer = null;
    let musicBedUrl = episode.music_bed_url || null;
    if (musicBedUrl) {
      try {
        const cached = await axios.get(musicBedUrl, { responseType: 'arraybuffer', timeout: 60000 });
        musicBedBuffer = Buffer.from(cached.data);
      } catch (err) {
        logger.warn(`V4 regen: failed to fetch cached music bed: ${err.message}`);
      }
    }
    if (!musicBedBuffer && sceneGraph.music_bed_intent && musicService.isAvailable()) {
      const totalDuration = estimateEpisodeDuration(beatMetadata);
      progress('music', `generating music bed (${totalDuration.toFixed(0)}s)`);
      try {
        const musicResult = await musicService.generateMusicBed({
          musicBedIntent: sceneGraph.music_bed_intent,
          durationSec: totalDuration
        });
        musicBedBuffer = musicResult.audioBuffer;
        musicBedUrl = await uploadBufferToStorage(
          musicResult.audioBuffer,
          'audio/v4-music',
          `episode-${episodeId}-music-regen-${Date.now()}.mp3`,
          'audio/mpeg'
        );
      } catch (err) {
        logger.warn(`V4 regen: music gen failed (non-fatal): ${err.message}`);
      }
    }

    // V4 hotfix 2026-04-30 — load brand_kit for episodeMeta. Before this fix
    // the regenerate-beat path referenced `brandKit` in episodeMeta below
    // without ever loading it, throwing ReferenceError("brandKit is not defined")
    // at the post-production call. Manual reassemble (reassembleEpisode) loaded
    // it correctly; only this regenerate path was broken. The pattern mirrors
    // runV4Pipeline's brand_kit load (lines 918-921).
    let brandKit = null;
    if (story.brand_kit_job_id) {
      try {
        const job = await getMediaTrainingJobById(story.brand_kit_job_id, userId);
        if (job?.brand_kit) brandKit = job.brand_kit;
      } catch (err) {
        logger.warn(`V4 regen: failed to load brand_kit (non-fatal): ${err.message}`);
      }
    }

    // ─── Step 6: enrich metadata for subtitles/ducking + re-run post-prod ───
    progress('post_production', 'reassembling episode with regenerated beat');
    await updateBrandStoryEpisode(episodeId, userId, {
      status: 'applying_lut',
      music_bed_url: musicBedUrl
    });

    const episodeLutId = resolveEpisodeLut(story, { ...episode, scene_description: sceneGraph });
    const brandLutId = story.brand_palette_lut_id || null;
    progress('post_production', `resolved LUT → ${episodeLutId}${brandLutId ? ` (+ brand trim ${brandLutId})` : ''}`);

    const enrichedBeatMetadata = [];
    let idx = 0;
    for (const scene of sceneGraph.scenes) {
      for (const beat of (scene.beats || [])) {
        if (beat.type === 'SPEED_RAMP_TRANSITION') continue;
        if (!beat.generated_video_url) continue;
        const base = beatMetadata[idx] || {};
        enrichedBeatMetadata.push({
          ...base,
          beat_id: beat.beat_id,
          dialogue: beat.dialogue || null,
          dialogues: beat.dialogues || null,
          exchanges: beat.exchanges || null,
          voiceover_text: beat.voiceover_text || null,
          ambient_sound: beat.ambient_sound || null
        });
        idx++;
      }
    }

    const episodeMeta = {
      series_title: story.storyline?.title || story.name || 'Untitled Series',
      episode_title: sceneGraph.title || `Episode ${episode.episode_number}`,
      cliffhanger: sceneGraph.cliffhanger || '',
      brand_kit: brandKit || null,
      cta_text: story.cta_text || story.storyline?.cta_text || null
    };

    const postProductionResult = await runPostProduction({
      beatVideoBuffers,
      beatMetadata: enrichedBeatMetadata,
      episodeLutId,
      brandLutId,
      musicBedBuffer,
      sceneGraph: sceneGraph.scenes,
      sceneDescription: sceneGraph,
      episodeMeta,
      burnSubtitles: true
    });
    const finalVideoBuffer = postProductionResult.finalBuffer;

    let subtitleUrl = null;
    if (postProductionResult.srtContent) {
      try {
        subtitleUrl = await uploadBufferToStorage(
          Buffer.from(postProductionResult.srtContent, 'utf-8'),
          'srt/v4',
          `episode-${episode.episode_number}-regen-${Date.now()}.srt`,
          'text/plain'
        );
      } catch (err) {
        logger.warn(`V4 regen: SRT upload failed (non-fatal): ${err.message}`);
      }
    }

    // ─── Step 7: upload final video, mark ready ───
    progress('upload', 'uploading regenerated final episode video');
    const finalVideoUrl = await uploadBufferToStorage(
      finalVideoBuffer,
      'videos/v4-final',
      `episode-${episode.episode_number}-regen-${Date.now()}.mp4`,
      'video/mp4'
    );

    const completedEpisode = await updateBrandStoryEpisode(episodeId, userId, {
      scene_description: sceneGraph,
      final_video_url: finalVideoUrl,
      subtitle_url: subtitleUrl,
      status: 'ready',
      lut_id: episodeLutId
    });

    progress('complete', `Beat ${beatId} regenerated: ${finalVideoUrl}`);
    return completedEpisode;
  }

  /**
   * V4: Re-run post-production on an existing episode WITHOUT regenerating
   * any beats and WITHOUT calling Gemini/Seedream/Veo/Kling.
   *
   * This is the Director's Panel "Reassemble" button. Use cases:
   *   - A post-production stage (SFX, LUT, subtitles, music mix) had a
   *     transient failure, you've fixed the underlying issue, and want to
   *     retry WITHOUT paying for beat generation again.
   *   - You changed the episode's LUT in the Director's Panel and want the
   *     new grade applied.
   *   - You dropped new correction/creative .cube files onto disk and want
   *     the existing episode to benefit from them.
   *
   * Flow:
   *   1. Load the existing episode + story + personas
   *   2. Download every beat's existing generated_video_url from Supabase
   *   3. Reuse existing music_bed_url if present (skip regeneration)
   *   4. Re-run the full post-production pipeline
   *   5. Upload a new final_video_url (with -reassemble-{timestamp} suffix)
   *   6. Update the SAME episode row — never creates a new one
   *
   * Replaces the Phase 1b stub that invoked runV4Pipeline() which tried to
   * INSERT a new brand_story_episodes row and collided on
   * UNIQUE(story_id, episode_number).
   *
   * Cost: $0 beat generation + whatever post-production API calls retry
   * (SFX via fal.ai ElevenLabs at ~$0.03/beat and music bed regen only if
   * the cached music_bed_url is missing).
   *
   * @param {string} storyId
   * @param {string} userId
   * @param {string} episodeId
   * @param {Function} [onProgress] - SSE-style progress callback
   * @returns {Promise<Object>} the updated episode record
   */
  /**
   * V4 P0.5 — Director Review Resolution Layer.
   *
   * Resolve a Director-Agent BLOCKING-MODE halt that landed an episode in
   * `awaiting_user_review`. The user provides one of three actions:
   *
   *   • approve         — clear halt at face value. Only meaningful at Lens D
   *                       (when final_video_url exists). For Lens A/B/C halts
   *                       there is no rendered video to ship; falls through
   *                       to the same outcome as discard with a friendly
   *                       error_message noting nothing was assembled.
   *
   *   • edit_and_retry  — re-run from the halted checkpoint with the user's
   *                       notes spliced into the next director nudge AND
   *                       optional anchor/dialogue overrides applied. Bypasses
   *                       the standard auto-retry budget (this is a manual
   *                       override). MVP: implemented as a SOFT clear that
   *                       flips status to 'failed' and instructs the user to
   *                       re-trigger episode generation. Full resume-from-
   *                       checkpoint orchestration (snapshot-based pipeline
   *                       resumption) is deferred — see plan P0.5.2 option (a)
   *                       for the snapshot persistence work that unlocks
   *                       in-place resume.
   *
   *   • discard         — mark episode 'failed' with user reason in
   *                       error_message. No resumption.
   *
   * Every resolution is recorded in director_halt_resolutions for telemetry
   * (see add_director_halt_resolutions.sql migration).
   *
   * @param {string} storyId
   * @param {string} userId
   * @param {string} episodeId
   * @param {Object} decision
   * @param {'approve' | 'edit_and_retry' | 'discard'} decision.action
   * @param {string} [decision.notes]            user remediation note
   * @param {string} [decision.edited_anchor]    Lens B halts only — anchor override
   * @param {string} [decision.edited_dialogue]  Lens C halts only — dialogue override
   * @returns {Promise<{ success: boolean, status: string, message: string, resolutionId: string }>}
   */
  /**
   * V4 hotfix 2026-04-30 — Auto-synthesize an Edit & Retry directive from the
   * halt verdict + the failed artifact's content. Replaces the previous flow
   * where the user had to type free-form director notes (which they don't have
   * the directing knowledge to write).
   *
   * Strategy:
   *   1. CHEAP layer — collect every finding's `remediation.prompt_delta`
   *      from the halt verdict. These are already generator-actionable
   *      hints emitted by the Director Agent rubric. If we have ≥1 prompt_delta,
   *      we have a usable baseline.
   *   2. RICH layer — feed [verdict findings + dimension scores + halted beat
   *      dialogue/anchor + scene context] to Vertex Gemini and ask it to
   *      synthesize ONE sharp, actionable edit directive that addresses the
   *      critical findings. Returns a 1-3 sentence directive, plus optional
   *      anchor/dialogue overrides for Lens B/C respectively.
   *
   * Cheap layer always runs (offline, deterministic). Rich layer runs when
   * Vertex is configured. If rich layer fails, falls back to cheap.
   *
   * @param {Object} params
   * @param {string} params.storyId
   * @param {string} params.userId
   * @param {string} params.episodeId
   * @returns {Promise<{ notes: string, edited_anchor: string|null, edited_dialogue: string|null, source: 'rich'|'cheap' }>}
   */
  async synthesizeDirectorReviewEdit({ storyId, userId, episodeId } = {}) {
    const { supabaseAdmin } = await import('./supabase.js');
    const { data: episode, error } = await supabaseAdmin
      .from('brand_story_episodes')
      .select('id, status, scene_description, director_report')
      .eq('id', episodeId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error(`synthesizeDirectorReviewEdit: read failed: ${error.message}`);
    if (!episode) throw new Error('Episode not found or access denied');
    if (episode.status !== 'awaiting_user_review') {
      throw new Error(`Episode is not in awaiting_user_review state (current: ${episode.status})`);
    }

    const dr = episode.director_report || {};
    const halt = dr.halt || {};
    const verdict = halt.verdict || null;
    const findings = Array.isArray(verdict?.findings) ? verdict.findings : [];
    const checkpoint = halt.checkpoint || 'unknown';
    const artifactId = halt.scene_id || halt.beat_id || halt.artifactKey || null;

    // ── Cheap layer: collect existing prompt_delta hints from findings ──
    const promptDeltas = findings
      .map(f => f?.remediation?.prompt_delta)
      .filter(s => typeof s === 'string' && s.trim().length > 0);
    const messages = findings.map(f => `- [${f.severity}] ${f.message}`).filter(Boolean).join('\n');

    let cheapNotes;
    if (promptDeltas.length > 0) {
      cheapNotes = [
        `Director-flagged issues at Lens ${checkpoint}${artifactId ? ` (${artifactId})` : ''}:`,
        messages,
        '',
        'Apply these corrective directives to the next render:',
        ...promptDeltas.map((d, i) => `${i + 1}. ${d}`)
      ].filter(Boolean).join('\n');
    } else if (messages) {
      cheapNotes = `Director-flagged issues at Lens ${checkpoint}:\n${messages}\n\nAddress these in the next render.`;
    } else {
      cheapNotes = `Director halted at Lens ${checkpoint} but emitted no specific findings. Re-run with care.`;
    }

    // ── Find the failed artifact's content for the rich-layer Gemini call ──
    let artifactContent = null;
    const sceneGraph = episode.scene_description || {};
    if (checkpoint === 'beat' && halt.beat_id) {
      for (const scene of (sceneGraph.scenes || [])) {
        const beat = (scene.beats || []).find(b => b.beat_id === halt.beat_id);
        if (beat) {
          artifactContent = {
            type: 'beat',
            beat_id: beat.beat_id,
            beat_type: beat.type,
            dialogue: beat.dialogue || beat.voiceover_text || null,
            subtext: beat.subtext || null,
            expression_notes: beat.expression_notes || null,
            emotion: beat.emotion || null,
            duration_seconds: beat.duration_seconds || null,
            scene_id: scene.scene_id || null,
            scene_anchor: scene.scene_visual_anchor_prompt || scene.location || null,
            ambient_bed_prompt: scene.ambient_bed_prompt || null
          };
          break;
        }
      }
    } else if ((checkpoint === 'scene_master' || checkpoint === 'commercial_scene_master') && halt.scene_id) {
      const scene = (sceneGraph.scenes || []).find(s => s.scene_id === halt.scene_id);
      if (scene) {
        artifactContent = {
          type: 'scene_master',
          scene_id: scene.scene_id,
          scene_master_url: scene.scene_master_url || null,
          location: scene.location || null,
          scene_anchor: scene.scene_visual_anchor_prompt || null,
          opposing_intents: scene.opposing_intents || null,
          beats: (scene.beats || []).slice(0, 5).map(b => ({
            beat_id: b.beat_id, type: b.type, dialogue: b.dialogue
          }))
        };
      }
    }

    // ── Rich layer: ask Vertex Gemini to cross-analyze and synthesize ──
    let richResult = null;
    try {
      if (isVertexGeminiConfigured() && (findings.length > 0 || promptDeltas.length > 0)) {
        const systemPrompt = [
          'You are a film DIRECTOR resolving a halted V4 brand-story pipeline.',
          'The Director Agent (Lens A/B/C/D rubric) flagged a halt at the checkpoint below.',
          'Your job: synthesize ONE sharp, generator-actionable edit directive that addresses the CRITICAL findings, drawn from BOTH the verdict findings AND the actual artifact content.',
          '',
          'Output ONLY a JSON object with this shape (no markdown, no prose):',
          '{',
          '  "directive": "<2-4 sentences, generator-actionable, sharp directorial language; combines the most important findings into ONE coherent retake note>",',
          '  "edited_anchor": "<for scene_master halts: a rewritten scene_visual_anchor_prompt that solves the flagged issues; null for non-scene halts>",',
          '  "edited_dialogue": "<for beat halts where dialogue is the issue: a rewritten dialogue line; null otherwise>"',
          '}',
          '',
          'Constraints:',
          '- Directive MUST address all CRITICAL findings (do not drop any).',
          '- Use cinematography vocabulary when relevant (lens choice, blocking, composition, light direction, performance).',
          '- DO NOT add new unrelated craft directions; stay focused on what the verdict flagged.',
          '- Edited anchor/dialogue should be drop-in replacements for the originals.'
        ].join('\n');

        const userPayload = {
          checkpoint,
          artifact_id: artifactId,
          verdict_score: verdict?.overall_score ?? null,
          verdict_kind: verdict?.verdict ?? null,
          findings: findings.map(f => ({
            severity: f.severity,
            dimension: f.dimension || null,
            message: f.message,
            evidence: f.evidence || null,
            remediation_hint: f.remediation?.prompt_delta || null,
            target: f.remediation?.target || null
          })),
          dimension_scores: verdict?.dimension_scores || null,
          artifact: artifactContent
        };

        const parsed = await callVertexGeminiJson({
          systemPrompt,
          userPrompt: JSON.stringify(userPayload),
          config: { temperature: 0.5, maxOutputTokens: 1024 },
          timeoutMs: 30000
        });
        if (parsed && typeof parsed.directive === 'string' && parsed.directive.trim().length > 0) {
          richResult = {
            directive: parsed.directive.trim(),
            edited_anchor: typeof parsed.edited_anchor === 'string' && parsed.edited_anchor.trim() ? parsed.edited_anchor.trim() : null,
            edited_dialogue: typeof parsed.edited_dialogue === 'string' && parsed.edited_dialogue.trim() ? parsed.edited_dialogue.trim() : null
          };
        }
      }
    } catch (err) {
      logger.warn(`[P0.5] synthesizeDirectorReviewEdit: rich layer failed (${err.message}) — falling back to cheap layer`);
    }

    if (richResult) {
      // Compose final notes by combining the rich directive with the cheap
      // findings list (so the audit trail shows both human-readable findings
      // AND the synthesized directive).
      const composedNotes = [
        richResult.directive,
        '',
        '— Synthesized from director findings:',
        messages
      ].filter(Boolean).join('\n');
      logger.info(`[P0.5] synthesizeDirectorReviewEdit ${episodeId}: rich layer succeeded (${composedNotes.length} chars)`);
      return {
        notes: composedNotes.slice(0, 4000),
        edited_anchor: richResult.edited_anchor ? richResult.edited_anchor.slice(0, 4000) : null,
        edited_dialogue: richResult.edited_dialogue ? richResult.edited_dialogue.slice(0, 4000) : null,
        source: 'rich'
      };
    }

    logger.info(`[P0.5] synthesizeDirectorReviewEdit ${episodeId}: cheap layer (${cheapNotes.length} chars)`);
    return {
      notes: cheapNotes.slice(0, 4000),
      edited_anchor: null,
      edited_dialogue: null,
      source: 'cheap'
    };
  }

  /**
   * V4 Option C — Pure synthesis helper for the auto-smart-retry path.
   *
   * Same logic as `synthesizeDirectorReviewEdit` but takes the verdict +
   * artifact context directly (in-memory) instead of reading from the DB.
   * The auto-smart-retry path calls this from inside the Lens C beat-loop
   * BEFORE the halt is persisted (because we're trying to RECOVER from the
   * soft_reject, not surface it for user review).
   *
   * @param {Object}   params
   * @param {Object}   params.verdict           - the failing Lens C/B/A verdict
   * @param {string}   params.checkpoint        - 'beat' | 'scene_master' | 'screenplay' | etc.
   * @param {string}   params.artifactId        - beat_id or scene_id (for log + payload)
   * @param {Object}   [params.artifactContent] - in-memory artifact (beat or scene) — for the rich layer
   * @returns {Promise<{ notes: string, edited_anchor: string|null, edited_dialogue: string|null, source: 'rich'|'cheap' }>}
   */
  async _synthesizeEditFromContext({ verdict, checkpoint, artifactId, artifactContent = null } = {}) {
    const findings = Array.isArray(verdict?.findings) ? verdict.findings : [];

    // Cheap layer
    const promptDeltas = findings
      .map(f => f?.remediation?.prompt_delta)
      .filter(s => typeof s === 'string' && s.trim().length > 0);
    const messages = findings.map(f => `- [${f.severity}] ${f.message}`).filter(Boolean).join('\n');

    let cheapNotes;
    if (promptDeltas.length > 0) {
      cheapNotes = [
        `Director-flagged issues at Lens ${checkpoint}${artifactId ? ` (${artifactId})` : ''}:`,
        messages,
        '',
        'Apply these corrective directives to the next render:',
        ...promptDeltas.map((d, i) => `${i + 1}. ${d}`)
      ].filter(Boolean).join('\n');
    } else if (messages) {
      cheapNotes = `Director-flagged issues at Lens ${checkpoint}:\n${messages}\n\nAddress these in the next render.`;
    } else {
      cheapNotes = `Director halted at Lens ${checkpoint} but emitted no specific findings. Re-run with care.`;
    }

    // Rich layer — Gemini cross-analysis
    let richResult = null;
    try {
      if (isVertexGeminiConfigured() && (findings.length > 0 || promptDeltas.length > 0)) {
        const systemPrompt = [
          'You are a film DIRECTOR resolving a halted V4 brand-story pipeline.',
          'The Director Agent (Lens A/B/C/D rubric) flagged a halt at the checkpoint below.',
          'Your job: synthesize ONE sharp, generator-actionable edit directive that addresses the CRITICAL findings, drawn from BOTH the verdict findings AND the actual artifact content.',
          '',
          'Output ONLY a JSON object with this shape (no markdown, no prose):',
          '{',
          '  "directive": "<2-4 sentences, generator-actionable, sharp directorial language; combines the most important findings into ONE coherent retake note>",',
          '  "edited_anchor": "<for scene_master halts: a rewritten scene_visual_anchor_prompt that solves the flagged issues; null for non-scene halts>",',
          '  "edited_dialogue": "<for beat halts where dialogue is the issue: a rewritten dialogue line; null otherwise>"',
          '}',
          '',
          'Constraints:',
          '- Directive MUST address all CRITICAL findings (do not drop any).',
          '- Use cinematography vocabulary when relevant (lens choice, blocking, composition, light direction, performance).',
          '- DO NOT add new unrelated craft directions; stay focused on what the verdict flagged.',
          '- Edited anchor/dialogue should be drop-in replacements for the originals.'
        ].join('\n');

        const userPayload = {
          checkpoint,
          artifact_id: artifactId,
          verdict_score: verdict?.overall_score ?? null,
          verdict_kind: verdict?.verdict ?? null,
          findings: findings.map(f => ({
            severity: f.severity,
            dimension: f.dimension || null,
            message: f.message,
            evidence: f.evidence || null,
            remediation_hint: f.remediation?.prompt_delta || null,
            target: f.remediation?.target || null
          })),
          dimension_scores: verdict?.dimension_scores || null,
          artifact: artifactContent
        };

        // V4 hotfix 2026-04-30 — maxOutputTokens budget calibration.
        //
        // Original 1024 hit MAX_TOKENS in production: Gemini 3 Flash Preview's
        // HIDDEN thinking consumed 981 tokens of the 1024 budget, leaving only
        // 29 for visible candidate JSON → Vertex dropped the partial structured
        // response. Same defect documented in DirectorAgent.js:60-143
        // (thinkingLevel='minimal' silently ignored; hidden thinking takes
        // ~87% of budget regardless). User-confirmed 2026-04-30: skip 8192
        // first-attempt and go straight to 12288 to avoid the wasted call.
        //
        // 12288 budget @ thinkingLevel='low' → ~6000 hidden thinking + ~6288
        // visible → directive + edited_anchor + edited_dialogue payload fits
        // with comfortable margin (~600-800 chars actual, ~1200-1600 tokens).
        const parsed = await callVertexGeminiJson({
          systemPrompt,
          userPrompt: JSON.stringify(userPayload),
          config: {
            temperature: 0.5,
            maxOutputTokens: 12288,
            thinkingLevel: 'low'
          },
          timeoutMs: 90000
        });
        if (parsed && typeof parsed.directive === 'string' && parsed.directive.trim().length > 0) {
          richResult = {
            directive: parsed.directive.trim(),
            edited_anchor: typeof parsed.edited_anchor === 'string' && parsed.edited_anchor.trim() ? parsed.edited_anchor.trim() : null,
            edited_dialogue: typeof parsed.edited_dialogue === 'string' && parsed.edited_dialogue.trim() ? parsed.edited_dialogue.trim() : null
          };
        }
      }
    } catch (err) {
      logger.warn(`[P0.5/auto-smart-retry] _synthesizeEditFromContext: rich layer failed (${err.message}) — falling back to cheap layer`);
    }

    if (richResult) {
      const composedNotes = [
        richResult.directive,
        '',
        '— Synthesized from director findings:',
        messages
      ].filter(Boolean).join('\n');
      return {
        notes: composedNotes.slice(0, 4000),
        edited_anchor: richResult.edited_anchor ? richResult.edited_anchor.slice(0, 4000) : null,
        edited_dialogue: richResult.edited_dialogue ? richResult.edited_dialogue.slice(0, 4000) : null,
        source: 'rich'
      };
    }
    return {
      notes: cheapNotes.slice(0, 4000),
      edited_anchor: null,
      edited_dialogue: null,
      source: 'cheap'
    };
  }

  async resolveDirectorReview(storyId, userId, episodeId, decision = {}) {
    const { action, notes = null, edited_anchor = null, edited_dialogue = null } = decision;

    if (!['approve', 'edit_and_retry', 'discard'].includes(action)) {
      throw new Error(`resolveDirectorReview: invalid action "${action}" (expected approve | edit_and_retry | discard)`);
    }

    // Read the episode + verify ownership + halt state.
    const { supabaseAdmin } = await import('./supabase.js');
    const { data: episode, error: readErr } = await supabaseAdmin
      .from('brand_story_episodes')
      .select('id, story_id, status, final_video_url, director_report, episode_number')
      .eq('id', episodeId)
      .eq('user_id', userId)
      .maybeSingle();
    if (readErr) throw new Error(`Failed to read episode: ${readErr.message}`);
    if (!episode) throw new Error('Episode not found or access denied');
    if (episode.story_id !== storyId) throw new Error('Episode does not belong to this story');
    if (episode.status !== 'awaiting_user_review') {
      throw new Error(`Episode is not in awaiting_user_review state (current: ${episode.status}). Nothing to resolve.`);
    }

    // Extract halt context from director_report. Halt sites populate this
    // (see plan P0.5.2 — when full snapshot persistence ships, the haltContext
    // also includes a snapshot_uri for in-place resume). For MVP we just read
    // checkpoint + artifact_id + verdict for the audit row.
    const dr = episode.director_report || {};
    const halt = dr.halt || {};
    const haltCheckpoint =
      halt.checkpoint ||
      // Fallback: infer from which lens last produced a verdict.
      (dr.episode ? 'episode' :
       dr.beat ? 'beat' :
       dr.scene_master ? 'scene_master' :
       dr.screenplay ? 'screenplay' : 'unknown');
    const haltArtifactId = halt.scene_id || halt.beat_id || halt.artifactKey || null;
    const haltVerdict = halt.verdict || null;
    const haltScore = Number.isFinite(haltVerdict?.overall_score) ? haltVerdict.overall_score : null;
    const haltKind = haltVerdict?.verdict || null;

    // Determine new episode status based on action + has_video.
    const hasFinalVideo = !!episode.final_video_url;
    let newStatus;
    let newErrorMessage = null;
    let resumptionOutcome = null;
    let userMessage;

    if (action === 'approve') {
      if (hasFinalVideo) {
        // Lens D-equivalent: video exists, user accepts the verdict — ship it.
        newStatus = 'ready';
        resumptionOutcome = 'shipped';
        userMessage = 'Approved — episode shipped at user discretion despite director verdict.';
      } else {
        // No video to ship — approving an A/B/C halt is meaningless.
        // Treat as discard with a clarifying message.
        newStatus = 'failed';
        newErrorMessage = `User approved halt at Lens ${haltCheckpoint} but no video was assembled — nothing to ship. Re-trigger episode generation to retry.`;
        resumptionOutcome = 'failed';
        userMessage = 'Approve action mapped to discard — there was no rendered video to ship at the halt point. Re-trigger episode generation.';
      }
    } else if (action === 'edit_and_retry') {
      // V4 hotfix 2026-05-01 — Real in-place retry (replaces MVP record-and-mark-failed).
      //
      // For Lens C beat halts (the most common halt class), apply the
      // synthesized directive + optional dialogue/anchor overrides directly
      // to the beat in scene_description, clear the failed render artifacts,
      // and trigger `regenerateBeatInEpisode` in the background. That route
      // already handles single-beat re-render + reassemble + upload.
      //
      // For Lens A (screenplay) and Lens B (scene_master) halts, in-place
      // resume requires more orchestration (re-running the screenplay
      // generator OR re-rendering a scene master + downstream beats); kept
      // as record-notes-and-mark-failed until the snapshot-resume work lands.
      // For Lens D (episode), reassembleEpisode is the right tool but it's
      // already exposed as a separate manual route.

      const updatedDirectorReport = {
        ...dr,
        user_review_resolution: {
          action,
          notes,
          edited_anchor,
          edited_dialogue,
          resolved_at: new Date().toISOString(),
          halt_checkpoint: haltCheckpoint,
          halt_artifact_id: haltArtifactId
        }
      };

      // ── Lens C beat in-place retry ──
      if (haltCheckpoint === 'beat' && halt.beat_id) {
        const sceneGraph = episode.scene_description || {};
        let targetBeat = null;
        let targetScene = null;
        for (const scene of (sceneGraph.scenes || [])) {
          const beat = (scene.beats || []).find(b => b.beat_id === halt.beat_id);
          if (beat) {
            targetBeat = beat;
            targetScene = scene;
            break;
          }
        }
        if (!targetBeat) {
          throw new Error(`edit_and_retry: beat ${halt.beat_id} not found in episode scene_description`);
        }

        // Apply user-provided / synthesized overrides to the beat in-place.
        if (notes && typeof notes === 'string') {
          targetBeat.director_nudge = notes;
        }
        if (edited_dialogue && typeof edited_dialogue === 'string') {
          targetBeat.dialogue = edited_dialogue;
        }
        if (edited_anchor && typeof edited_anchor === 'string' && targetScene) {
          targetScene.scene_visual_anchor_prompt = edited_anchor;
        }
        // Clear failed-render artifacts so the regenerate path treats the
        // beat as un-rendered.
        targetBeat.generated_video_url = null;
        targetBeat.endframe_url = null;
        targetBeat.status = 'pending';
        targetBeat.error_message = null;

        // Flip episode out of awaiting_user_review into a regenerating state
        // so the panel + status badge reflect that work is in progress.
        const { error: updateErr } = await supabaseAdmin
          .from('brand_story_episodes')
          .update({
            status: 'regenerating_beat',
            scene_description: sceneGraph,
            director_report: updatedDirectorReport,
            error_message: null
          })
          .eq('id', episodeId)
          .eq('user_id', userId);
        if (updateErr) throw new Error(`Failed to update episode: ${updateErr.message}`);

        // Kick the regenerate path in the BACKGROUND. The route handler
        // already returned 200 to the user before this point in the
        // resolveDirectorReview flow; this Promise is fire-and-forget so the
        // user sees an immediate response, and the panel polls for updates
        // via the SSE/refresh path.
        this.regenerateBeatInEpisode(storyId, userId, episodeId, halt.beat_id)
          .then(() => {
            logger.info(`[P0.5] edit_and_retry ${episodeId}: beat ${halt.beat_id} regenerate completed`);
          })
          .catch((regenErr) => {
            logger.error(`[P0.5] edit_and_retry ${episodeId}: beat ${halt.beat_id} regenerate failed: ${regenErr.message}`);
            // Mark episode failed if regenerate path itself crashed (it has
            // its own error handling but defense-in-depth).
            supabaseAdmin
              .from('brand_story_episodes')
              .update({
                status: 'failed',
                error_message: `Edit & Retry regenerate failed: ${regenErr.message}`
              })
              .eq('id', episodeId)
              .eq('user_id', userId)
              .then(() => {})
              .catch(() => {});
          });

        newStatus = 'regenerating_beat';
        userMessage = `Edit & Retry: beat ${halt.beat_id} re-rendering with ${notes ? 'synthesized directive' : 'no notes'}${edited_dialogue ? ' + dialogue rewrite' : ''}${edited_anchor ? ' + anchor rewrite' : ''}. Watch the panel for progress.`;
        resumptionOutcome = 'in_place_retry_running';

        const resolutionId = await this._recordHaltResolution({
          episodeId, storyId, userId,
          haltCheckpoint, haltArtifactId, haltScore, haltKind, haltReason: halt.reason || null,
          action, notes, editedAnchor: edited_anchor, editedDialogue: edited_dialogue,
          resumptionOutcome
        });
        logger.info(`[P0.5] resolveDirectorReview ${episodeId}: ${action} (Lens C in-place retry) → beat ${halt.beat_id} regenerating (resolution=${resolutionId})`);
        return { success: true, status: newStatus, message: userMessage, resolutionId };
      }

      // ── Lens B scene_master in-place resume ──
      // V4 hotfix 2026-05-01 — Lens B halts now resume in-place by re-running
      // the V4 pipeline from the Scene Master step (`runV4Pipeline` accepts
      // `resumeOptions = { episodeId, sceneEdits }`). The resume path skips
      // screenplay generation, Lens A judging, and episode creation; it
      // applies the user's synthesized notes / edited_anchor to the failed
      // scene, clears scene_master_url, resets that scene's retry budget,
      // and lets the pipeline regenerate + re-judge from there onward.
      if (haltCheckpoint === 'scene_master' && halt.scene_id) {
        // Persist the resolution row + flip status BEFORE kicking the
        // background pipeline so the panel sees the regenerating state.
        const { error: updateErrLensB } = await supabaseAdmin
          .from('brand_story_episodes')
          .update({
            status: 'generating_scene_masters',
            director_report: updatedDirectorReport,
            error_message: null
          })
          .eq('id', episodeId)
          .eq('user_id', userId);
        if (updateErrLensB) throw new Error(`Failed to update episode: ${updateErrLensB.message}`);

        // Kick the resume pipeline in the BACKGROUND so the route handler
        // returns 200 immediately. The panel polls + the SSE stream
        // re-engages now that the episode has flipped out of awaiting_user_review.
        const sceneEdits = {
          sceneId: halt.scene_id,
          notes: (notes && typeof notes === 'string') ? notes : null,
          edited_anchor: (edited_anchor && typeof edited_anchor === 'string') ? edited_anchor : null
        };
        this.runV4Pipeline(storyId, userId, null, { episodeId, sceneEdits })
          .then(() => {
            logger.info(`[P0.5] edit_and_retry ${episodeId}: Lens B resume completed for scene ${halt.scene_id}`);
          })
          .catch((resumeErr) => {
            // Halt-on-retry inside the resume pipeline is a normal outcome
            // (the user's edit might still not pass) — surface the new halt
            // via the persisted directorReport.halt that the resume pipeline
            // already wrote. Only mark failed if the error is NOT a halt.
            const isExpectedHalt = resumeErr?.constructor?.name === 'DirectorBlockingHaltError';
            if (isExpectedHalt) {
              logger.info(`[P0.5] edit_and_retry ${episodeId}: Lens B resume re-halted at ${resumeErr.checkpoint || halt.scene_id} — panel shows new verdict`);
              return;
            }
            logger.error(`[P0.5] edit_and_retry ${episodeId}: Lens B resume failed: ${resumeErr.message}`);
            supabaseAdmin
              .from('brand_story_episodes')
              .update({
                status: 'failed',
                error_message: `Edit & Retry resume failed: ${resumeErr.message}`
              })
              .eq('id', episodeId)
              .eq('user_id', userId)
              .then(() => {})
              .catch(() => {});
          });

        newStatus = 'generating_scene_masters';
        userMessage = `Edit & Retry: scene ${halt.scene_id} re-rendering with ${notes ? 'synthesized directive' : 'no notes'}${edited_anchor ? ' + anchor rewrite' : ''}. Watch the panel for progress.`;
        resumptionOutcome = 'in_place_resume_running';

        const resolutionId = await this._recordHaltResolution({
          episodeId, storyId, userId,
          haltCheckpoint, haltArtifactId, haltScore, haltKind, haltReason: halt.reason || null,
          action, notes, editedAnchor: edited_anchor, editedDialogue: edited_dialogue,
          resumptionOutcome
        });
        logger.info(`[P0.5] resolveDirectorReview ${episodeId}: ${action} (Lens B in-place resume) → scene ${halt.scene_id} regenerating (resolution=${resolutionId})`);
        return { success: true, status: newStatus, message: userMessage, resolutionId };
      }

      // ── Lens A/D halts — record notes, mark failed (in-place resume
      // for screenplay-stage halts (Lens A) requires re-running screenplay
      // generation with notes spliced into the prompt; assembly-stage halts
      // (Lens D) have a separate `reassembleEpisode` route).
      newStatus = 'failed';
      newErrorMessage = `User requested edit_and_retry at Lens ${haltCheckpoint}` +
        (notes ? ` with notes: "${notes.slice(0, 200)}"` : '') +
        `. In-place resume from Lens ${haltCheckpoint} is not yet supported (Lens C beat halts get in-place retry; other lens halts need re-trigger generation).`;
      resumptionOutcome = 'pending_retry';
      userMessage = `Edit notes recorded for Lens ${haltCheckpoint} halt. In-place resume not yet supported at this checkpoint — re-trigger episode generation; notes will be carried into the next run.`;

      const { error: updateErr } = await supabaseAdmin
        .from('brand_story_episodes')
        .update({
          status: newStatus,
          error_message: newErrorMessage,
          director_report: updatedDirectorReport
        })
        .eq('id', episodeId)
        .eq('user_id', userId);
      if (updateErr) throw new Error(`Failed to update episode: ${updateErr.message}`);

      const resolutionId = await this._recordHaltResolution({
        episodeId, storyId, userId,
        haltCheckpoint, haltArtifactId, haltScore, haltKind, haltReason: halt.reason || null,
        action, notes, editedAnchor: edited_anchor, editedDialogue: edited_dialogue,
        resumptionOutcome
      });
      logger.info(`[P0.5] resolveDirectorReview ${episodeId}: ${action} (Lens ${haltCheckpoint} record-notes) → status=${newStatus} (resolution=${resolutionId})`);
      return { success: true, status: newStatus, message: userMessage, resolutionId };
    } else {
      // discard
      newStatus = 'failed';
      newErrorMessage = notes
        ? `Discarded by user at Lens ${haltCheckpoint}: ${notes.slice(0, 200)}`
        : `Discarded by user at Lens ${haltCheckpoint}.`;
      resumptionOutcome = null; // discard has no resumption outcome
      userMessage = 'Episode discarded. Re-trigger episode generation when ready.';
    }

    // Single update for approve and discard paths.
    const { error: updateErr } = await supabaseAdmin
      .from('brand_story_episodes')
      .update({
        status: newStatus,
        error_message: newErrorMessage
      })
      .eq('id', episodeId)
      .eq('user_id', userId);
    if (updateErr) throw new Error(`Failed to update episode: ${updateErr.message}`);

    const resolutionId = await this._recordHaltResolution({
      episodeId, storyId, userId,
      haltCheckpoint, haltArtifactId, haltScore, haltKind, haltReason: halt.reason || null,
      action, notes, editedAnchor: edited_anchor, editedDialogue: edited_dialogue,
      resumptionOutcome
    });
    logger.info(`[P0.5] resolveDirectorReview ${episodeId}: ${action} → status=${newStatus} (resolution=${resolutionId})`);
    return { success: true, status: newStatus, message: userMessage, resolutionId };
  }

  /**
   * V4 P0.5 — Internal helper to record a halt-resolution audit row.
   * Best-effort: if the audit table write fails, log it but don't fail the
   * resolution itself. The episode status update is the load-bearing operation.
   */
  async _recordHaltResolution({
    episodeId, storyId, userId,
    haltCheckpoint, haltArtifactId, haltScore, haltKind, haltReason,
    action, notes, editedAnchor, editedDialogue,
    resumptionOutcome
  }) {
    try {
      const { supabaseAdmin } = await import('./supabase.js');
      const { data, error } = await supabaseAdmin
        .from('director_halt_resolutions')
        .insert({
          episode_id: episodeId,
          story_id: storyId,
          user_id: userId,
          halted_at_checkpoint: haltCheckpoint,
          halted_artifact_id: haltArtifactId,
          halt_verdict_score: haltScore,
          halt_verdict_kind: haltKind,
          halt_reason: haltReason,
          user_action: action,
          user_notes: notes,
          user_edited_anchor: editedAnchor,
          user_edited_dialogue: editedDialogue,
          resumption_outcome: resumptionOutcome,
          resolved_at: action === 'discard' ? new Date().toISOString() : null
        })
        .select('id')
        .single();
      if (error) {
        logger.warn(`[P0.5] halt resolution audit insert failed (non-fatal): ${error.message}`);
        return null;
      }
      return data?.id || null;
    } catch (err) {
      logger.warn(`[P0.5] halt resolution audit failed (non-fatal): ${err.message}`);
      return null;
    }
  }

  async reassembleEpisode(storyId, userId, episodeId, onProgress) {
    let emitter = null;
    try {
      emitter = getOrCreateProgressEmitter(episodeId);
    } catch {}

    const progress = (stage, detail, extras = {}) => {
      logger.info(`[V4Reassemble] ${stage}: ${detail}`);
      if (typeof onProgress === 'function') {
        try { onProgress(stage, detail); } catch {}
      }
      if (emitter) {
        try { emitter.emit(stage, detail, extras); } catch {}
      }
    };

    progress('reassemble_start', `episode=${episodeId}`);

    // ─── Step 1: load story + episode ───
    const story = await getBrandStoryById(storyId, userId);
    if (!story) throw new Error(`V4 reassemble: story ${storyId} not found`);

    const episode = await getBrandStoryEpisodeById(episodeId, userId);
    if (!episode) throw new Error(`V4 reassemble: episode ${episodeId} not found`);

    const sceneGraph = episode.scene_description || {};
    if (!Array.isArray(sceneGraph.scenes)) throw new Error(`V4 reassemble: episode has no scene-graph`);

    let brandKit = {};
    if (story.brand_kit_job_id) {
      try {
        const job = await getMediaTrainingJobById(story.brand_kit_job_id, userId);
        if (job?.brand_kit) brandKit = job.brand_kit;
      } catch (err) {
        logger.warn(`V4 reassemble: failed to load brand kit (non-fatal): ${err.message}`);
      }
    }

    // Mark episode as regenerating_beat (closest existing status — means
    // "some in-place mutation is happening on this episode"). We could add
    // a dedicated 'reassembling' status but that requires a DB migration
    // and this state is transient anyway.
    await updateBrandStoryEpisode(episodeId, userId, {
      status: 'regenerating_beat',
      error_message: null
    });

    // ─── Step 2: download every beat's existing video ───
    // Walk the scene-graph in canonical order, fetch each beat's buffer from
    // its generated_video_url. We also collect beat metadata for the
    // subtitle/SFX/ducking pipeline to consume.
    progress('loading_beats', `fetching ${sceneGraph.scenes.length} scene(s) of existing beats`);

    const beatVideoBuffers = [];
    const beatMetadata = [];

    for (const scene of sceneGraph.scenes) {
      for (const beat of (scene.beats || [])) {
        if (beat.type === 'SPEED_RAMP_TRANSITION') continue;
        if (!beat.generated_video_url) {
          logger.warn(`V4 reassemble: beat ${beat.beat_id} has no generated_video_url — skipping`);
          continue;
        }
        try {
          const cached = await axios.get(beat.generated_video_url, { responseType: 'arraybuffer', timeout: 60000 });
          beatVideoBuffers.push(Buffer.from(cached.data));
          beatMetadata.push({
            beat_id: beat.beat_id,
            model_used: beat.model_used,
            duration_seconds: beat.duration_seconds,
            actual_duration_sec: beat.actual_duration_sec || beat.duration_seconds
          });
        } catch (err) {
          logger.warn(`V4 reassemble: failed to fetch beat ${beat.beat_id} from ${beat.generated_video_url}: ${err.message}`);
        }
      }
    }

    if (beatVideoBuffers.length === 0) {
      throw new Error('V4 reassemble: no beat buffers downloaded — episode may have no successful beats');
    }

    progress('loading_beats', `loaded ${beatVideoBuffers.length} beat video(s)`);

    // ─── Step 3: music bed — reuse cached URL if present ───
    let musicBedBuffer = null;
    let musicBedUrl = episode.music_bed_url || null;
    if (musicBedUrl) {
      try {
        const cached = await axios.get(musicBedUrl, { responseType: 'arraybuffer', timeout: 60000 });
        musicBedBuffer = Buffer.from(cached.data);
        progress('music', `reusing cached music bed`);
      } catch (err) {
        logger.warn(`V4 reassemble: failed to fetch cached music bed: ${err.message} — regenerating`);
      }
    }
    const uploadBufferToStorage = (buffer, subfolder, filename, mimeType) =>
      this._uploadBufferToStorage(buffer, userId, subfolder, filename, mimeType);

    if (!musicBedBuffer && sceneGraph.music_bed_intent && musicService.isAvailable()) {
      const totalDuration = estimateEpisodeDuration(beatMetadata);
      progress('music', `regenerating music bed (${totalDuration.toFixed(0)}s)`);
      try {
        const musicResult = await musicService.generateMusicBed({
          musicBedIntent: sceneGraph.music_bed_intent,
          durationSec: totalDuration
        });
        musicBedBuffer = musicResult.audioBuffer;
        musicBedUrl = await uploadBufferToStorage(
          musicResult.audioBuffer,
          'audio/v4-music',
          `episode-${episodeId}-music-reassemble-${Date.now()}.mp3`,
          'audio/mpeg'
        );
      } catch (err) {
        logger.warn(`V4 reassemble: music gen failed (non-fatal): ${err.message}`);
      }
    }

    // ─── Step 4: resolve LUT + enrich metadata for subtitles/ducking ───
    progress('post_production', 'reassembling episode');
    await updateBrandStoryEpisode(episodeId, userId, {
      status: 'applying_lut',
      music_bed_url: musicBedUrl
    });

    const episodeLutId = resolveEpisodeLut(story, { ...episode, scene_description: sceneGraph });
    const brandLutId = story.brand_palette_lut_id || null;
    progress('post_production', `resolved LUT → ${episodeLutId}${brandLutId ? ` (+ brand trim ${brandLutId})` : ''}`);

    const enrichedBeatMetadata = [];
    let idx = 0;
    for (const scene of sceneGraph.scenes) {
      for (const beat of (scene.beats || [])) {
        if (beat.type === 'SPEED_RAMP_TRANSITION') continue;
        if (!beat.generated_video_url) continue;
        const base = beatMetadata[idx] || {};
        enrichedBeatMetadata.push({
          ...base,
          beat_id: beat.beat_id,
          dialogue: beat.dialogue || null,
          dialogues: beat.dialogues || null,
          exchanges: beat.exchanges || null,
          voiceover_text: beat.voiceover_text || null,
          ambient_sound: beat.ambient_sound || null
        });
        idx++;
      }
    }

    const episodeMeta = {
      series_title: story.storyline?.title || story.name || 'Untitled Series',
      episode_title: sceneGraph.title || `Episode ${episode.episode_number}`,
      cliffhanger: sceneGraph.cliffhanger || '',
      brand_kit: brandKit || null,
      cta_text: story.cta_text || story.storyline?.cta_text || null
    };

    const postProductionResult = await runPostProduction({
      beatVideoBuffers,
      beatMetadata: enrichedBeatMetadata,
      episodeLutId,
      brandLutId,
      musicBedBuffer,
      sceneGraph: sceneGraph.scenes,
      sceneDescription: sceneGraph,
      episodeMeta,
      burnSubtitles: true
    });
    const finalVideoBuffer = postProductionResult.finalBuffer;

    let subtitleUrl = episode.subtitle_url || null;
    if (postProductionResult.srtContent) {
      try {
        subtitleUrl = await uploadBufferToStorage(
          Buffer.from(postProductionResult.srtContent, 'utf-8'),
          'srt/v4',
          `episode-${episode.episode_number}-reassemble-${Date.now()}.srt`,
          'text/plain'
        );
      } catch (err) {
        logger.warn(`V4 reassemble: SRT upload failed (non-fatal): ${err.message}`);
      }
    }

    // ─── Step 5: upload fresh final video, mark ready ───
    progress('upload', 'uploading reassembled final episode video');
    const finalVideoUrl = await uploadBufferToStorage(
      finalVideoBuffer,
      'videos/v4-final',
      `episode-${episode.episode_number}-reassemble-${Date.now()}.mp4`,
      'video/mp4'
    );

    const completedEpisode = await updateBrandStoryEpisode(episodeId, userId, {
      final_video_url: finalVideoUrl,
      subtitle_url: subtitleUrl,
      status: 'ready',
      lut_id: episodeLutId
    });

    progress('complete', `Episode ${episode.episode_number} reassembled: ${finalVideoUrl}`);
    return completedEpisode;
  }

  /**
   * V4: Generate the scene-graph screenplay via Gemini using brandStoryPromptsV4.
   * Returns the parsed JSON scene-graph that the rest of the V4 pipeline consumes.
   *
   * @private
   */
  async _generateV4Screenplay({
    story,
    personas,
    previousEpisodes,
    brandKit,
    previousVisualStyle,
    previousEmotionalState,
    lastCliffhanger,
    directorsNotes,
    costCapUsd,
    hasBrandKitLut,
    episodeNumber
  }) {
    // V4 uses Vertex AI for Gemini (NOT AI Studio). Require Vertex creds
    // (GCP_PROJECT_ID + GOOGLE_APPLICATION_CREDENTIALS_JSON or ADC) at call time.
    if (!isVertexGeminiConfigured()) {
      throw new Error('V4: Vertex Gemini not configured — set GCP_PROJECT_ID and GOOGLE_APPLICATION_CREDENTIALS_JSON (or use ADC)');
    }

    // Phase 4 — resolve product_integration_style. Default for product-focus
    // stories is `naturalistic_placement` (Hollywood-prop grammar). Stories
    // explicitly set to other styles (via wizard or auto-set by commercial
    // genre in Phase 6) override the default. Person- and landscape-focus
    // stories don't use this axis (subject is not a product).
    const productIntegrationStyle = story.product_integration_style
      || ((story.story_focus || 'product') === 'product' ? 'naturalistic_placement' : 'naturalistic_placement');

    // V4 Phase 5b — resolve the genre LUT pool from the spec library and pass
    // it to BOTH the system prompt (for the lutBlock instructions) AND the
    // user prompt (for the lut_id schema enum). This eliminates the legacy
    // 8-LUT bypass that produced bs_cool_noir on the hyperreal commercial in
    // story `77d6eaaf` (logs.txt 2026-04-28). When hasBrandKitLut is true the
    // pool is unused (Gemini emits no lut_id), but we resolve it anyway for
    // logging clarity.
    const screenplayGenre = story.subject?.genre || story.storyline?.genre || null;
    // V4 P1.2 — spec system is the only LUT system; no flag check needed.
    const genreLutPool = screenplayGenre
      ? getGenreLutPool(screenplayGenre).map(l => ({
          id: l.id,
          look: l.look,
          mood_keywords: l.mood_keywords,
          reference_films: l.reference_films
        }))
      : null;

    const systemPrompt = getEpisodeSystemPromptV4(story.storyline, previousEpisodes, personas, {
      subject: story.subject,
      storyFocus: story.story_focus || 'product',
      brandKit,
      previousVisualStyle,
      previousEmotionalState,
      directorsNotes,
      costCapUsd,
      hasBrandKitLut,
      // Phase 3 — pass the locked sonic series bible so the prompt can teach
      // Gemini to inherit from it. resolveBibleForStory returns the safe
      // default if the story doesn't have one yet (legacy stories).
      sonicSeriesBible: story.sonic_series_bible || null,
      // Phase 4 — product placement mode (controls THE MONEY BEAT mandate,
      // anti-ad-copy bans, and reference-stack priority).
      productIntegrationStyle,
      // Phase 6 (2026-04-28) — pass the commercial brief so the screenplay
      // writer inherits the creative_concept / visual_signature / music_intent
      // / brand_world_lock / anti_brief authored by CreativeBriefDirector.
      // Without this the brief was dead weight (root cause of incoherent
      // commercials in 2026-04-28 logs).
      commercialBrief: story.commercial_brief || null,
      // Cast Bible Phase 3 — pass the story-level cast bible so the screenplay
      // prompt can quote it as a HARD CONSTRAINT (permitted persona_index
      // values). Eliminates phantom-character invention at source. When null
      // (legacy stories without a derived bible), _buildCastBibleBlock emits
      // empty string and behavior is identical to today.
      castBible: story.cast_bible || null,
      // V4 Audio Layer Overhaul Day 3 — Hebrew authorship register.
      // Resolution order:
      //   1. story.language (top-level column, future-proof)
      //   2. story.subject?.language (current wizard path: marketing.js
      //      bundles `language` into creativeSettings → enrichedSubject
      //      → story.subject.language at story-creation time)
      //   3. personas[0].language (legacy stories with persona-level language)
      //   4. 'en' default
      // _buildHebrewMasterclassBlock emits an empty string for any
      // non-Hebrew language so English stories see no change.
      storyLanguage: story.language
        || story.subject?.language
        || (personas?.[0]?.language)
        || 'en',
      // V4 Phase 5b — genre LUT pool eliminates the legacy 8-LUT bypass.
      genreLutPool
    });

    const userPrompt = getEpisodeUserPromptV4(story.storyline, lastCliffhanger, episodeNumber, {
      hasBrandKitLut,
      sonicSeriesBible: story.sonic_series_bible || null,
      // V4 Phase 5b — same pool so the lut_id enum in the JSON schema is
      // genre-pool-only (no legacy 8-LUT enum).
      genreLutPool
    });

    // V4 hotfix 2026-04-30 — retry on Gemini structured-output truncation.
    //
    // Production failure mode (logs.txt 2026-04-30 episode 2 generation):
    // Gemini 3 Flash returns finishReason=STOP with total_output=4523/8192
    // (well under cap) but the JSON is truncated mid-string at position 10383
    // — Gemini just stopped emitting text mid-narrative-beat with no closing
    // quote/comma/brace. The shared parseGeminiJson repair chain handles
    // markdown fences, raw newlines in strings, and trailing commas, but it
    // cannot reconstruct content Gemini never emitted.
    //
    // This is non-deterministic: re-running the same prompt at slightly
    // different sampling produces a complete output most of the time. The
    // retry uses (a) bumped maxOutputTokens for more headroom, (b) lower
    // temperature for more deterministic emission, (c) a fresh sampling roll.
    // We retry exactly ONCE — if Gemini still emits truncated JSON, surface
    // the original error with full diagnostic context (prompt size, output
    // token count, finishReason). Most failures recover on the first retry.
    let parsed;
    let firstAttemptError = null;
    try {
      parsed = await callVertexGeminiJson({
        systemPrompt,
        userPrompt,
        config: {
          temperature: 0.85,
          maxOutputTokens: 8192
        },
        timeoutMs: 90000
      });
    } catch (err) {
      // Only retry on parse-failure or response-truncation errors. Other
      // errors (auth, network, quota) won't be helped by a retry.
      const msg = err?.message || '';
      const isParseFailure = msg.includes('unparseable JSON');
      const isTruncation = msg.includes('truncated') || msg.includes('MAX_TOKENS');
      if (!isParseFailure && !isTruncation) throw err;

      firstAttemptError = err;
      logger.warn(
        `V4 screenplay: first Gemini attempt failed (${msg.slice(0, 200)}). ` +
        `Retrying with higher token budget + lower temperature for determinism.`
      );

      try {
        parsed = await callVertexGeminiJson({
          systemPrompt,
          userPrompt,
          config: {
            temperature: 0.65,         // lower → more deterministic on retry
            maxOutputTokens: 12288     // bump from 8192 to give Gemini room to complete the JSON
          },
          timeoutMs: 120000             // longer timeout for the higher-budget call
        });
        logger.info(`V4 screenplay: retry succeeded after first attempt's truncation`);
      } catch (retryErr) {
        logger.error(
          `V4 screenplay: retry also failed (${retryErr.message}). ` +
          `Original error: ${firstAttemptError.message}`
        );
        // Surface the retry error (it has the same shape as the original);
        // include the original in the message for full diagnostic context.
        throw new Error(
          `V4 screenplay generation failed after 1 retry. ` +
          `First attempt: ${firstAttemptError.message.slice(0, 250)} | ` +
          `Retry: ${retryErr.message.slice(0, 250)}`
        );
      }
    }

    if (!Array.isArray(parsed.scenes) || parsed.scenes.length === 0) {
      throw new Error('V4: Gemini returned no scenes');
    }

    for (const scene of parsed.scenes) {
      if (!Array.isArray(scene.beats)) scene.beats = [];
      for (const beat of scene.beats) {
        if (!beat.status) beat.status = 'pending';
        if (beat.generated_video_url == null) beat.generated_video_url = null;
        if (beat.endframe_url == null) beat.endframe_url = null;
        if (beat.model_used == null) beat.model_used = null;
        if (beat.cost_usd == null) beat.cost_usd = null;
      }
    }

    return parsed;
  }

  /**
   * V4: Lightweight in-process brand safety filter.
   * Phase 1a: simple keyword block list as a safety rail.
   * Phase 2 upgrade: Gemini semantic safety check.
   *
   * @private
   */
  _brandSafetyFilter(sceneGraph) {
    const blockedPatterns = [
      /\bf[u\*]ck/i,
      /\bsh[i\*]t/i,
      /\bb[i\*]tch/i,
      /\bn[i\*]gg/i,
      /\bc[u\*]nt/i
    ];

    let flagged = 0;
    for (const scene of sceneGraph.scenes || []) {
      for (const beat of scene.beats || []) {
        const lines = [];
        if (beat.dialogue) lines.push(beat.dialogue);
        if (Array.isArray(beat.dialogues)) lines.push(...beat.dialogues);
        if (Array.isArray(beat.exchanges)) {
          for (const ex of beat.exchanges) if (ex.dialogue) lines.push(ex.dialogue);
        }
        if (beat.voiceover_text) lines.push(beat.voiceover_text);

        for (const line of lines) {
          for (const pattern of blockedPatterns) {
            if (pattern.test(line)) {
              logger.warn(`V4 brand safety: flagged dialogue in beat ${beat.beat_id}: "${line.slice(0, 60)}..."`);
              flagged++;
              break;
            }
          }
        }
      }
    }

    if (flagged > 0) {
      logger.warn(`V4 brand safety: ${flagged} dialogue line(s) flagged (warning only — Phase 2 will replace with semantic Gemini check)`);
    }
  }

  // ═══════════════════════════════════════════════════
  // CINEMATIC V2 PIPELINE
  // ═══════════════════════════════════════════════════

  /**
   * V2 cinematic pipeline — generates a Hollywood-feel short film episode.
   * Uses Kling multi_prompt for one coherent multi-shot video, Flux 2 Max
   * for storyboard panels, ElevenLabs for full-episode narration, and
   * ffmpeg for audio mixing post-production.
   */
  async runCinematicPipeline(storyId, userId, onProgress) {
    const progress = (stage, detail) => {
      logger.info(`[CinematicV2] ${stage}: ${detail}`);
      if (onProgress) onProgress(stage, detail);
    };

    try {
      // ── RESUMABLE PIPELINE ──
      // On failure, generated artifacts are stashed on story.pending_resume and the
      // failed episode is deleted. Next "Generate" creates a fresh episode but reuses
      // any saved content (screenplay, narration, storyboard, raw video).

      // Check if we have resume data from a previous failed attempt
      const storyForResume = await getBrandStoryById(storyId, userId);
      const resume = storyForResume?.pending_resume || null;
      if (resume) {
        logger.info(`[CinematicV2] Found resume data from failed attempt (error: ${resume.error?.slice(0, 60)})`);
      }

      // Step 1: Gemini writes cinematic screenplay — reuse from resume if available
      let episode;
      if (resume?.scene_description?.shots?.length > 0) {
        progress('writing_script', 'Resuming from previous screenplay...');
        // Create a new episode record with the saved screenplay
        const episodeData = {
          episode_number: (await getBrandStoryEpisodes(storyId, userId)).length + 1,
          scene_description: resume.scene_description,
          status: 'generating_narration',
          pipeline_version: 'v2'
        };
        episode = await createBrandStoryEpisode(storyId, userId, episodeData);
        episode.scene_description = resume.scene_description;
      } else {
        progress('writing_script', 'Writing cinematic screenplay...');
        episode = await this._generateCinematicEpisode(storyId, userId);
      }

      const scene = episode.scene_description || {};
      const shots = scene.shots || [];
      progress('writing_script', `Episode ${episode.episode_number}: ${shots.length} shots, style: ${(scene.visual_style_prefix || '').slice(0, 60)}...`);

      // Step 2: TTS narration — reuse from resume if available
      let narrationResult;
      if (resume?.narration_audio_url) {
        logger.info(`[CinematicV2] Reusing saved narration: ${resume.narration_audio_url}`);
        const narResp = await axios.get(resume.narration_audio_url, { responseType: 'arraybuffer', timeout: 30000 });
        narrationResult = { audioBuffer: Buffer.from(narResp.data), publicUrl: resume.narration_audio_url };
        await updateBrandStoryEpisode(episode.id, userId, { narration_audio_url: resume.narration_audio_url });
      } else {
        progress('generating_narration', 'Recording voice-over narration...');
        narrationResult = await this._generateFullNarration(episode, storyId, userId);
        await updateBrandStoryEpisode(episode.id, userId, { narration_audio_url: narrationResult.publicUrl });
      }

      // Step 3: Storyboard panels — reuse from resume if available
      let storyboardPanels;
      if (Array.isArray(resume?.storyboard_panels) && resume.storyboard_panels.length >= shots.length) {
        logger.info(`[CinematicV2] Reusing saved storyboard: ${resume.storyboard_panels.length} panels`);
        storyboardPanels = resume.storyboard_panels;
      } else {
        progress('generating_storyboard', 'Creating storyboard panels...');
        storyboardPanels = await this._generateEpisodeStoryboard(episode, storyId, userId);
      }

      // Save storyboard + narration + style to episode
      await updateBrandStoryEpisode(episode.id, userId, {
        storyboard_panels: storyboardPanels,
        narration_audio_url: narrationResult.publicUrl,
        visual_style_prefix: scene.visual_style_prefix || '',
        pipeline_version: 'v2',
        status: 'generating_video'
      });

      // Step 4: Video generation — reuse raw video from resume if available
      let videoResult;
      if (resume?.scene_video_url) {
        logger.info(`[CinematicV2] Reusing saved raw video: ${resume.scene_video_url}`);
        const vidResp = await axios.get(resume.scene_video_url, { responseType: 'arraybuffer', timeout: 120000 });
        videoResult = { videoBuffer: Buffer.from(vidResp.data), duration: 15, model: 'reused' };
      } else {
        // TODO: Re-enable Kling primary path after Veo testing
        progress('generating_video', 'Generating cinematic video (Veo 3.1 Standard)...');
        const story = await getBrandStoryById(storyId, userId);
        // Kling disabled for Veo testing — go straight to Veo 3.1 Standard
        videoResult = await this._runVeoFallbackPipeline(shots, scene, storyboardPanels, story, episode, userId);
        /* KLING PRIMARY PATH (re-enable after testing):
        try {
          videoResult = await this._generateKlingMultiShot(shots, scene, storyboardPanels, story, userId);
        } catch (klingErr) {
          logger.warn(`Kling multi-shot failed, falling back to Veo 3.1 Standard: ${klingErr.message}`);
          progress('generating_video', 'Kling unavailable — using Veo 3.1 Standard fallback...');
          videoResult = await this._runVeoFallbackPipeline(shots, scene, storyboardPanels, story, episode, userId);
        }
        */
      }

      // Upload raw video to Supabase
      const rawVideoUrl = resume?.scene_video_url || await this._uploadBufferToStorage(
        videoResult.videoBuffer, userId, 'videos', `ep${episode.episode_number}-raw.mp4`, 'video/mp4'
      );

      await updateBrandStoryEpisode(episode.id, userId, {
        scene_video_url: rawVideoUrl,
        status: 'post_production'
      });

      // Step 4.5: Align narration duration to actual video duration.
      // When Kling fails and Veo fallback runs, the video may be significantly
      // shorter/longer than the TTS narration (Kling does 3-15s shots, Veo does 4-8s).
      // Use atempo to stretch/compress narration so it fills the video naturally.
      let alignedNarrationBuffer = narrationResult.audioBuffer;
      if (alignedNarrationBuffer) {
        try {
          alignedNarrationBuffer = await this._alignNarrationToVideo(
            videoResult.videoBuffer, narrationResult.audioBuffer, episode
          );
        } catch (alignErr) {
          logger.warn(`Narration alignment failed (non-fatal): ${alignErr.message}`);
        }
      }

      // Step 5: Post-production (with title card + end card)
      progress('post_production', 'Mixing narration over cinematic audio...');
      const storyForPostProd = await getBrandStoryById(storyId, userId);
      const finalVideoUrl = await this._postProduction(
        videoResult.videoBuffer, alignedNarrationBuffer, episode, userId, storyForPostProd
      );

      // Clear resume data on success
      await updateBrandStory(storyId, userId, { pending_resume: null });

      // Finalize
      await updateBrandStoryEpisode(episode.id, userId, {
        final_video_url: finalVideoUrl,
        status: 'ready'
      });

      // Update the season bible with a running "story so far" appendix.
      // This prevents late-episode amnesia by keeping a compressed record of
      // key events, unresolved threads, and character state changes.
      try {
        await this._updateStorySoFar(storyId, userId, episode);
      } catch (soFarErr) {
        logger.warn(`story_so_far update failed (non-fatal): ${soFarErr.message}`);
      }

      progress('complete', `Episode ${episode.episode_number} ready!`);
      return getBrandStoryEpisodeById(episode.id, userId);

    } catch (error) {
      logger.error(`Cinematic v2 pipeline failed for story ${storyId}: ${error.message}`);
      // Save generated artifacts to the STORY record for resume, then DELETE the failed episode.
      // Next "Generate" click will create a fresh episode but reuse saved content.
      try {
        const allEps = await getBrandStoryEpisodes(storyId, userId);
        const failedEp = allEps[allEps.length - 1];
        if (failedEp && failedEp.status !== 'ready') {
          // Stash whatever was generated so far on the story for next attempt
          const resume = {
            scene_description: failedEp.scene_description || null,
            narration_audio_url: failedEp.narration_audio_url || null,
            storyboard_panels: failedEp.storyboard_panels || null,
            visual_style_prefix: failedEp.visual_style_prefix || null,
            scene_video_url: failedEp.scene_video_url || null,
            failed_at: new Date().toISOString(),
            error: error.message
          };
          await updateBrandStory(storyId, userId, { pending_resume: resume });
          // Delete the failed episode — user sees a clean slate
          const { supabaseAdmin } = await import('./supabase.js');
          await supabaseAdmin.from('brand_story_episodes').delete().eq('id', failedEp.id).eq('user_id', userId);
          // Update total_episodes count
          const remaining = await getBrandStoryEpisodes(storyId, userId);
          await updateBrandStory(storyId, userId, { total_episodes: remaining.length });
          logger.info(`[CinematicV2] Failed episode ${failedEp.episode_number} deleted. Resume data saved on story.`);
        }
      } catch (cleanupErr) {
        logger.error(`[CinematicV2] Cleanup after failure failed: ${cleanupErr.message}`);
      }
      throw error;
    }
  }

  /**
   * Generate a cinematic episode scene description using v2 prompts.
   * Returns the created episode record with scene_description containing
   * visual_style_prefix, storyboard_prompt per shot, narration_lines, etc.
   */
  async _generateCinematicEpisode(storyId, userId) {
    const story = await getBrandStoryById(storyId, userId);
    if (!story) throw new Error(`Story ${storyId} not found`);
    if (!story.storyline) throw new Error('Story has no generated storyline');

    const allEpisodes = await getBrandStoryEpisodes(storyId, userId);
    // Only use completed episodes for continuity — skip failed/in-progress ones
    const previousEpisodes = allEpisodes.filter(ep =>
      ep.scene_description?.shots?.length > 0 && ['ready', 'published'].includes(ep.status)
    );
    const prevScenes = previousEpisodes.map(ep => ep.scene_description);
    const lastCliffhanger = previousEpisodes.length > 0
      ? previousEpisodes[previousEpisodes.length - 1]?.scene_description?.cliffhanger || ''
      : '';
    // Episode number = total records in DB + 1 (including failed ones, to avoid duplicates)
    const episodeNumber = allEpisodes.length + 1;

    const storyPersonas = story.persona_config?.personas || [];
    let brandKit = null;
    if (story.brand_kit_job_id) {
      try {
        const job = await getMediaTrainingJobById(story.brand_kit_job_id, userId);
        if (job?.brand_kit) brandKit = job.brand_kit;
      } catch (e) { /* no brand kit — fine */ }
    }

    // Extract visual style and emotional state from the most recent completed episode
    const lastCompletedEp = previousEpisodes[previousEpisodes.length - 1];
    const previousVisualStyle = lastCompletedEp?.scene_description?.visual_style_prefix || '';
    const previousEmotionalState = lastCompletedEp?.scene_description?.emotional_state || '';

    const systemPrompt = getEpisodeSystemPromptV2(story.storyline, prevScenes, storyPersonas, {
      subject: story.subject,
      storyFocus: story.story_focus || 'product',
      brandKit,
      previousVisualStyle,
      previousEmotionalState,
      directorsNotes: story.subject?.directors_notes || ''
    });
    const userPrompt = getEpisodeUserPromptV2(story.storyline, lastCliffhanger, episodeNumber);

    const apiKey = process.env.GOOGLE_AI_STUDIO_API_KEY;
    if (!apiKey) throw new Error('GOOGLE_AI_STUDIO_API_KEY not set');

    const response = await axios.post(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
      contents: [
        { role: 'user', parts: [{ text: systemPrompt }] },
        { role: 'model', parts: [{ text: 'I understand. I will generate the next cinematic episode as valid JSON.' }] },
        { role: 'user', parts: [{ text: userPrompt }] }
      ],
      generationConfig: {
        maxOutputTokens: 8192,
        temperature: 0.85,
        responseMimeType: 'application/json'
      }
    }, { timeout: 120000 });

    const raw = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) throw new Error('Gemini returned empty response for cinematic episode');

    let sceneDescription = this._parseGeminiJson(raw);

    // Gemini sometimes wraps the episode in an array. Unwrap it.
    if (Array.isArray(sceneDescription)) {
      logger.warn(`Gemini returned array instead of object — unwrapping first element`);
      sceneDescription = sceneDescription[0] || {};
    }
    // Sometimes Gemini nests it under episode/response/data keys
    if (!sceneDescription.shots && sceneDescription.episode?.shots) {
      sceneDescription = sceneDescription.episode;
    }

    logger.info(`Gemini cinematic response keys: ${Object.keys(sceneDescription).join(', ')}`);
    if (!sceneDescription.shots || sceneDescription.shots.length === 0) {
      logger.error(`Gemini cinematic response (no shots): ${JSON.stringify(sceneDescription).slice(0, 500)}`);
      throw new Error('Gemini cinematic episode missing shots array');
    }

    // Create episode record
    const episodeData = {
      episode_number: episodeNumber,
      scene_description: sceneDescription,
      status: 'generating_storyboard',
      pipeline_version: 'v2'
    };

    const created = await createBrandStoryEpisode(storyId, userId, episodeData);
    await updateBrandStory(storyId, userId, { total_episodes: episodeNumber });

    logger.info(`Cinematic episode ${episodeNumber} created: "${sceneDescription.title}" — ${sceneDescription.shots.length} shots`);
    return { ...created, scene_description: sceneDescription };
  }

  /**
   * Generate full-episode TTS narration via ElevenLabs.
   * Concatenates all shots' narration_lines into one continuous script.
   */
  // Video provider max duration per shot — used to calculate target narration length
  static get VIDEO_DURATION_CONFIG() {
    return {
      kling: { maxPerShot: 15, numShots: 3 },   // Kling Omni 3: 15s × 3 = 45s
      veo: { maxPerShot: 8, numShots: 3 }        // Veo 3.1 Standard I2V: 8s × 3 = 24s
    };
  }

  async _generateFullNarration(episode, storyId, userId) {
    const scene = episode.scene_description || {};
    const shots = scene.shots || [];

    // Build full narration from per-shot narration_lines
    const fullScript = shots
      .map(s => s.narration_line || '')
      .filter(Boolean)
      .join(' ');

    if (!fullScript) {
      logger.warn(`Episode ${episode.episode_number}: no narration text — skipping TTS`);
      return { audioBuffer: null, publicUrl: null };
    }

    // Calculate target narration duration based on video provider
    // Primary = Kling, fallback = Veo. Target the PRIMARY provider's length.
    const isKlingDisabled = false; // TODO: flip when Kling is re-enabled
    const provider = isKlingDisabled ? 'veo' : 'kling';
    const config = BrandStoryService.VIDEO_DURATION_CONFIG[provider];
    const targetDurationSec = config.maxPerShot * config.numShots;

    // Estimate natural speech duration (avg ~2.5 words/sec at speed=1.0)
    const wordCount = fullScript.split(/\s+/).length;
    const naturalDurationSec = wordCount / 2.5;

    // Calculate TTS speed to match target video length
    // speed < 1.0 = slower (stretches), speed > 1.0 = faster (compresses)
    // Clamp between 0.5 (very slow) and 2.0 (very fast)
    let ttsSpeed = naturalDurationSec / targetDurationSec;
    ttsSpeed = Math.min(Math.max(ttsSpeed, 0.5), 2.0);

    logger.info(`Narration target: ${targetDurationSec}s (${provider}: ${config.maxPerShot}s × ${config.numShots} shots). Script: ${wordCount} words, natural ~${naturalDurationSec.toFixed(0)}s, TTS speed=${ttsSpeed.toFixed(2)}`);

    // Determine voice from persona config
    const story = await getBrandStoryById(storyId, userId);
    const personas = story?.persona_config?.personas || [];
    // Cast Bible follow-up — intelligent fallback when personas[0] has no voice.
    // Picker is gender + persona-aware; respects collisions with other personas.
    const voiceId = personas[0]?.elevenlabs_voice_id
      || pickFallbackVoiceIdForPersonaInList(personas, 0, { reason: 'v3_narration' })
      || undefined;

    const ttsResult = await ttsService.synthesize({
      text: fullScript,
      options: {
        voiceId,
        language: personas[0]?.language || 'en',
        speed: ttsSpeed
      }
    });

    // Upload narration to Supabase
    const publicUrl = await this._uploadBufferToStorage(
      ttsResult.audioBuffer, userId, 'audio', `ep${episode.episode_number}-narration.mp3`, 'audio/mpeg'
    );

    logger.info(`Narration generated: ~${ttsResult.durationEstimate}s (target: ${targetDurationSec}s), uploaded to ${publicUrl}`);
    return { audioBuffer: ttsResult.audioBuffer, publicUrl };
  }

  /**
   * Generate episode storyboard panels via Replicate Seedream 5 Lite.
   * Produces one panel per shot (3 total) with style coherence via
   * shared visual_style_prefix, up to 14 character/subject references,
   * seed proximity, and sequential generation for inter-panel coherence.
   * Uses 3K resolution (3072px) for maximum detail — these panels serve
   * as first/last frames for Kling/Veo video generation.
   */
  async _generateEpisodeStoryboard(episode, storyId, userId) {
    const scene = episode.scene_description || {};
    const shots = scene.shots || [];
    const stylePrefix = scene.visual_style_prefix || '';
    const story = await getBrandStoryById(storyId, userId);

    // Collect reference images for Seedream 5 Lite image_input — ordered by story focus.
    // Seedream supports up to 14 refs (vs Flux's 8) for stronger identity lock.
    // Person focus: persona refs first (character is the star of every frame)
    // Product/landscape focus: subject refs first (product/place dominates the storyboard)
    const personaRefs = this._collectPersonaReferenceImages(story);
    const subjectRefs = this._collectSubjectReferenceImages(story);
    const focus = story.story_focus || 'product';
    const inputImages = focus === 'person'
      ? [...personaRefs, ...subjectRefs].slice(0, 14)
      : [...subjectRefs, ...personaRefs].slice(0, 14);

    // Initialize Replicate client
    const replicateToken = process.env.REPLICATE_API_TOKEN;
    if (!replicateToken) throw new Error('REPLICATE_API_TOKEN not set — cannot generate storyboard');
    const replicate = new Replicate({ auth: replicateToken });

    // Use deterministic seed for cross-episode visual consistency.
    // Same story always uses the same seed family, with episode/shot offsets.
    const baseSeed = this._getStoryboardSeed(story, episode.episode_number, 0);
    const panels = [];

    // Generate first panel with sequential_image_generation enabled.
    // This primes Seedream's internal coherence model so subsequent panels
    // (sharing the same seed family + reference images) maintain visual continuity.
    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const storyboardPrompt = shot.storyboard_prompt || shot.visual_direction || '';
      const fullPrompt = stylePrefix
        ? `${stylePrefix}. ${storyboardPrompt}`
        : storyboardPrompt;

      logger.info(`Generating storyboard panel ${i + 1}/${shots.length}: ${fullPrompt.slice(0, 100)}...`);

      const output = await replicate.run('bytedance/seedream-5-lite', {
        input: {
          prompt: fullPrompt,
          ...(inputImages.length > 0 ? { image_input: inputImages } : {}),
          aspect_ratio: '9:16',
          size: '3K',
          sequential_image_generation: 'auto',
          seed: baseSeed + i
        }
      });

      // Seedream 5 Lite returns a single FileOutput or URL
      const imageSource = Array.isArray(output) ? output[0] : output;
      let imageBuffer;

      if (typeof imageSource === 'string') {
        const response = await axios.get(imageSource, { responseType: 'arraybuffer' });
        imageBuffer = Buffer.from(response.data);
      } else if (imageSource && typeof imageSource.blob === 'function') {
        const blob = await imageSource.blob();
        imageBuffer = Buffer.from(await blob.arrayBuffer());
      } else {
        logger.warn(`Storyboard panel ${i + 1}: unexpected output format — skipping`);
        continue;
      }

      // Upload to Supabase
      const filename = `ep${episode.episode_number}-panel${i + 1}-${Date.now()}.png`;
      const imageUrl = await this._uploadBufferToStorage(
        imageBuffer, userId, 'storyboard', filename, 'image/png'
      );

      panels.push({
        shot_index: i,
        image_url: imageUrl,
        prompt: fullPrompt.slice(0, 500)
      });

      logger.info(`Storyboard panel ${i + 1} uploaded: ${imageUrl}`);
    }

    if (panels.length === 0) throw new Error('Failed to generate any storyboard panels');
    return panels;
  }

  /**
   * Generate multi-shot video via Kling 3.0 Pro multi_prompt API.
   * Panel 1 from storyboard becomes the start frame; persona/subject refs
   * become @Element identity locks.
   */
  async _generateKlingMultiShot(shots, scene, storyboardPanels, story, userId) {
    if (!klingService.isAvailable()) throw new Error('Kling service not available');

    const stylePrefix = scene.visual_style_prefix || '';

    // Build reference images — Replicate Kling Omni 3 supports up to 7 refs.
    // More refs = stronger identity lock. Order by focus priority:
    //   1. Persona/subject source photos (identity anchors)
    //   2. Storyboard panels (composition + identity reinforcement — panels were
    //      generated WITH the same persona/subject refs, so they carry baked-in
    //      identity data while also guiding Kling on scene composition)
    const personaRefs = this._collectPersonaReferenceImages(story);
    const subjectRefs = this._collectSubjectReferenceImages(story);
    const focus = story.story_focus || 'product';
    const identityRefs = focus === 'person'
      ? [...personaRefs, ...subjectRefs]
      : [...subjectRefs, ...personaRefs];
    const uniqueIdentityRefs = [...new Set(identityRefs)];

    // Fill remaining Kling ref slots (up to 7) with storyboard panels
    const panelUrls = storyboardPanels
      .map(p => p.image_url)
      .filter(url => url && !uniqueIdentityRefs.includes(url));
    const refs = [...uniqueIdentityRefs, ...panelUrls].slice(0, 7);

    // Start frame = first storyboard panel
    const startImageUrl = storyboardPanels[0]?.image_url;
    if (!startImageUrl) throw new Error('No storyboard panel 1 for Kling start frame');

    // Shot prompts have a 512-char limit in Kling multi_prompt.
    // <<<image_N>>> tags are NOT needed in shot prompts — reference_images handles identity lock.
    // Condense style prefix to ~150 chars to leave ~350 chars for shot-specific content.
    const condensedStyle = stylePrefix.length > 150
      ? stylePrefix.slice(0, 150).replace(/,?\s*$/, '')
      : stylePrefix;

    const multiPrompt = shots.map(shot => {
      const shotContent = [
        shot.visual_direction || '',
        shot.camera_notes ? `Camera: ${shot.camera_notes}` : '',
        shot.ambient_sound ? `Sound: ${shot.ambient_sound}` : '',
        shot.mood ? `Mood: ${shot.mood}` : ''
      ].filter(Boolean).join('. ');
      const prompt = `${condensedStyle}. ${shotContent}`.slice(0, 512);
      return { prompt, duration: 15 }; // Max out Kling shot duration (15s per shot)
    });

    logger.info(`Kling multi-shot: ${multiPrompt.length} shots, ${refs.length} refs, start frame: ${startImageUrl.slice(0, 60)}...`);

    const result = await klingService.generateMultiShotVideo({
      imageUrl: startImageUrl,
      referenceImages: refs,
      multiPrompt,
      options: {
        aspectRatio: '9:16',
        generateAudio: true
      }
    });

    return result;
  }

  /**
   * Seedance fallback pipeline — used when Kling multi_prompt is unavailable.
   * Uses frame chaining: each shot's start frame = last frame of previous shot.
   * Storyboard panels serve as end_image_url targets for guided motion.
   */
  /**
   * Veo 3.1 Standard fallback pipeline — used when Kling multi-shot fails.
   * Uses storyboard panels as first+last frame anchors for perfect shot-to-shot continuity.
   * No fragile frame extraction — panels drive both ends of every shot.
   *
   * Flow: Panel1→Shot1→Panel2, Panel2→Shot2→Panel3, Panel3→Shot3→(open)
   */
  async _runVeoFallbackPipeline(shots, scene, storyboardPanels, story, episode, userId) {
    const { VideoGenerationService } = await import('./VideoGenerationService.js');

    const stylePrefix = scene.visual_style_prefix || '';
    const generatedShots = [];

    // Check for previously generated shots from resume data (per-shot resume)
    const storyForResume = await getBrandStoryById(story.id, userId);
    const resumeShots = storyForResume?.pending_resume?.generated_shots || [];

    for (let i = 0; i < shots.length; i++) {
      // Per-shot resume: if this shot was already generated, reuse it
      if (resumeShots[i]?.video_url) {
        logger.info(`Veo shot ${i + 1}/${shots.length}: reusing saved shot from resume (${resumeShots[i].video_url.slice(-40)})`);
        const vidResp = await axios.get(resumeShots[i].video_url, { responseType: 'arraybuffer', timeout: 60000 });
        generatedShots.push({
          index: i,
          videoBuffer: Buffer.from(vidResp.data),
          duration: resumeShots[i].duration || 8
        });
        continue;
      }

      const shot = shots[i];

      // Build rich prompt (Veo allows ~1400 chars).
      // Include storyboard_prompt — it describes the KEY FRAME composition (characters,
      // poses, lighting, framing, colors) in 100+ words. Even when first/last frame images
      // are provided, this text gives Veo richer guidance about WHAT to animate.
      const prompt = [
        stylePrefix,
        shot.storyboard_prompt || '',
        shot.visual_direction || '',
        shot.camera_notes ? `Camera movement: ${shot.camera_notes}` : '',
        shot.ambient_sound ? `Ambient sound: ${shot.ambient_sound}` : '',
        shot.mood ? `Mood: ${shot.mood}` : '',
        'Photorealistic, cinematic lighting, 9:16 vertical short film.'
      ].filter(Boolean).join('. ').slice(0, 1400);

      // Enriched prompts for fallback tiers — when image anchors are stripped,
      // maximize the textual composition guidance to compensate.
      const promptWithEndFrame = [
        stylePrefix,
        shot.storyboard_prompt || '',
        shot.visual_direction || '',
        shot.end_frame_description ? `The shot ends on: ${shot.end_frame_description}` : '',
        shot.camera_notes ? `Camera movement: ${shot.camera_notes}` : '',
        shot.ambient_sound ? `Ambient sound: ${shot.ambient_sound}` : '',
        shot.mood ? `Mood: ${shot.mood}` : '',
        'Photorealistic, cinematic lighting, 9:16 vertical short film.'
      ].filter(Boolean).join('. ').slice(0, 1400);

      const firstImageUrl = storyboardPanels[i]?.image_url;
      const lastImageUrl = (i < storyboardPanels.length - 1) ? storyboardPanels[i + 1]?.image_url : null;
      const cameraControl = VideoGenerationService.mapCameraControl(shot.camera_notes);
      const duration = 8;

      logger.info(`Veo fallback shot ${i + 1}/${shots.length}: first_frame=${firstImageUrl ? 'yes' : 'no'}, last_frame=${lastImageUrl ? 'yes' : 'no'}, camera=${cameraControl || 'auto'}, ${duration}s`);

      let result;
      try {
        result = await videoGenerationService.generateWithFirstLastFrame({
          firstImageUrl,
          lastImageUrl,
          prompt,
          cameraControl,
          options: { durationSeconds: duration, aspectRatio: '9:16' }
        });
      } catch (shotErr) {
        if (shotErr.message?.includes('usage guidelines') || shotErr.message?.includes('content filter') || shotErr.isContentFilter) {
          // Tier 2: drop last frame, keep first. Use enriched prompt with end_frame_description
          // since we lost the visual end target.
          logger.warn(`Veo shot ${i + 1} content-filtered — retrying without lastFrame (enriched prompt)...`);
          try {
            result = await videoGenerationService.generateWithFirstLastFrame({
              firstImageUrl,
              lastImageUrl: null,
              prompt: promptWithEndFrame,
              cameraControl,
              options: { durationSeconds: duration, aspectRatio: '9:16' }
            });
          } catch (retryErr) {
            if (retryErr.message?.includes('usage guidelines') || retryErr.isContentFilter) {
              // Tier 3: pure text-only. Use maximum enriched prompt — the storyboard_prompt
              // text is now the ONLY composition guidance Veo has.
              logger.warn(`Veo shot ${i + 1} firstFrame also filtered — text-only with full storyboard prompt...`);
              result = await videoGenerationService.generateWithFirstLastFrame({
                firstImageUrl: null,
                lastImageUrl: null,
                prompt: promptWithEndFrame,
                cameraControl: null,
                options: { durationSeconds: duration, aspectRatio: '9:16' }
              });
            } else {
              throw retryErr;
            }
          }
        } else {
          throw shotErr;
        }
      }

      // Upload this shot immediately so it's saved for per-shot resume
      const shotUrl = await this._uploadBufferToStorage(
        result.videoBuffer, userId, 'videos',
        `ep${episode.episode_number}-veo-shot${i + 1}-${Date.now()}.mp4`, 'video/mp4'
      );

      // Save per-shot progress to story.pending_resume.generated_shots
      const currentResume = (await getBrandStoryById(story.id, userId))?.pending_resume || {};
      const savedShots = currentResume.generated_shots || [];
      savedShots[i] = { video_url: shotUrl, duration: result.duration };
      await updateBrandStory(story.id, userId, {
        pending_resume: { ...currentResume, generated_shots: savedShots }
      });

      generatedShots.push({
        index: i,
        videoBuffer: result.videoBuffer,
        duration: result.duration
      });

      logger.info(`Veo shot ${i + 1} saved for resume: ${shotUrl}`);
    }

    // Assemble with xfade transitions (reuse existing method)
    const transitions = shots.map(s => s.transition_to_next || 'dissolve');
    const assembledBuffer = await this._assembleWithTransitions(generatedShots, transitions, episode, userId);

    return {
      videoBuffer: assembledBuffer,
      duration: generatedShots.reduce((sum, s) => sum + s.duration, 0),
      model: 'veo-3.1-standard-frame-chained'
    };
  }

  /**
   * Assemble shots with ffmpeg xfade transitions (replaces raw concat).
   * Uses dissolve/fadeblack transitions between shots instead of hard cuts.
   */
  async _assembleWithTransitions(generatedShots, transitions, episode, userId) {
    if (generatedShots.length === 0) throw new Error('No shots to assemble');
    if (generatedShots.length === 1) return generatedShots[0].videoBuffer;

    const tmpDir = os.tmpdir();
    const shotFiles = [];
    const transitionDuration = 0.5; // seconds

    // Write each shot to temp file and normalize
    for (let i = 0; i < generatedShots.length; i++) {
      const rawPath = path.join(tmpDir, `xfade-raw-${episode.episode_number}-${i}.mp4`);
      const normPath = path.join(tmpDir, `xfade-norm-${episode.episode_number}-${i}.mp4`);
      await fs.writeFile(rawPath, generatedShots[i].videoBuffer);

      // Normalize: consistent codec, resolution, framerate
      await execFileAsync('ffmpeg', [
        '-y', '-i', rawPath,
        '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
        '-profile:v', 'high', '-level', '4.2', '-pix_fmt', 'yuv420p', '-r', '30',
        '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-ac', '2',
        normPath
      ]);

      shotFiles.push(normPath);
      await fs.unlink(rawPath).catch(() => {});
    }

    // Build xfade filter chain
    // For 3 shots: [0][1]xfade=dissolve:duration=0.5:offset=T1[v01]; [v01][2]xfade=dissolve:duration=0.5:offset=T2[vout]
    let filterParts = [];
    let currentOffset = 0;
    const inputs = shotFiles.map((f, i) => ['-i', f]).flat();

    for (let i = 0; i < shotFiles.length - 1; i++) {
      const shotDuration = generatedShots[i].duration || 5;
      currentOffset += shotDuration - transitionDuration;
      const transType = (transitions[i] === 'fadeblack') ? 'fadeblack'
        : (transitions[i] === 'cut') ? 'fade' // 'cut' = very short fade
        : 'dissolve';
      const dur = transitions[i] === 'cut' ? 0.1 : transitionDuration;

      const inputA = i === 0 ? `[${i}:v]` : '[vtemp]';
      const outputLabel = i === shotFiles.length - 2 ? '[vout]' : '[vtemp]';
      filterParts.push(`${inputA}[${i + 1}:v]xfade=transition=${transType}:duration=${dur}:offset=${currentOffset}${outputLabel}`);
    }

    // Audio: concatenate with acrossfade
    let audioFilter = '';
    for (let i = 0; i < shotFiles.length - 1; i++) {
      const inputA = i === 0 ? `[${i}:a]` : '[atemp]';
      const outputLabel = i === shotFiles.length - 2 ? '[aout]' : '[atemp]';
      audioFilter += `${inputA}[${i + 1}:a]acrossfade=d=${transitionDuration}${outputLabel};`;
    }

    const outputPath = path.join(tmpDir, `xfade-assembled-${episode.episode_number}.mp4`);
    const filterComplex = filterParts.join(';') + ';' + audioFilter.replace(/;$/, '');

    try {
      await execFileAsync('ffmpeg', [
        '-y', ...inputs,
        '-filter_complex', filterComplex,
        '-map', '[vout]', '-map', '[aout]',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
        '-c:a', 'aac', '-b:a', '256k',
        '-movflags', '+faststart',
        outputPath
      ]);
    } catch (xfadeErr) {
      // Fallback: simple concat if xfade fails
      logger.warn(`xfade assembly failed, falling back to concat: ${xfadeErr.message}`);
      const listFile = path.join(tmpDir, `xfade-list-${episode.episode_number}.txt`);
      await fs.writeFile(listFile, shotFiles.map(f => `file '${f}'`).join('\n'));
      await execFileAsync('ffmpeg', [
        '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
        '-c', 'copy', '-movflags', '+faststart', outputPath
      ]);
      await fs.unlink(listFile).catch(() => {});
    }

    const assembled = await fs.readFile(outputPath);

    // Cleanup
    for (const f of shotFiles) await fs.unlink(f).catch(() => {});
    await fs.unlink(outputPath).catch(() => {});

    return assembled;
  }

  /**
   * Post-production: mix TTS narration over the cinematic video's ambient audio,
   * add opening title card and end card with cliffhanger text.
   *
   * @param {Buffer} videoBuffer - Raw cinematic video
   * @param {Buffer|null} narrationBuffer - TTS narration audio
   * @param {Object} episode - Episode record with scene_description
   * @param {string} userId
   * @param {Object} [story] - Story record (for title card text). Optional for backward compat.
   */
  async _postProduction(videoBuffer, narrationBuffer, episode, userId, story = null) {
    const tmpDir = os.tmpdir();
    const epNum = episode.episode_number;
    const videoPath = path.join(tmpDir, `postprod-video-${epNum}.mp4`);
    const mixedPath = path.join(tmpDir, `postprod-mixed-${epNum}.mp4`);
    const outputPath = path.join(tmpDir, `postprod-final-${epNum}.mp4`);
    await fs.writeFile(videoPath, videoBuffer);

    if (!narrationBuffer) {
      // No narration — just add title/end cards to the raw video
      const withCards = await this._addTitleAndEndCards(videoPath, outputPath, episode, story);
      const finalBuffer = await fs.readFile(withCards);
      const publicUrl = await this._uploadBufferToStorage(
        finalBuffer, userId, 'videos', `ep${epNum}-final.mp4`, 'video/mp4'
      );
      await fs.unlink(videoPath).catch(() => {});
      await fs.unlink(withCards).catch(() => {});
      return publicUrl;
    }

    const narrationPath = path.join(tmpDir, `postprod-narration-${epNum}.mp3`);
    await fs.writeFile(narrationPath, narrationBuffer);

    try {
      // Build narration volume expression with ducking at shot transitions.
      // At each visual cut point, the narration dips briefly (J/L cut feel).
      // Ambient audio rises slightly at those points for a "breathing" effect.
      const narrationVolExpr = this._buildDuckingVolumeExpr(episode, 0.85);
      const ambientVolExpr = this._buildAmbientSwellExpr(episode, 0.12);

      await execFileAsync('ffmpeg', [
        '-y',
        '-i', videoPath,
        '-i', narrationPath,
        '-filter_complex',
        `[0:a]volume='${ambientVolExpr}':eval=frame[ambient];[1:a]volume='${narrationVolExpr}':eval=frame,apad[narr];[ambient][narr]amix=inputs=2:duration=first[aout]`,
        '-map', '0:v',
        '-map', '[aout]',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
        '-c:a', 'aac', '-b:a', '256k', '-ar', '48000',
        '-movflags', '+faststart',
        mixedPath
      ]);
    } catch (mixErr) {
      logger.warn(`Audio mix with ducking failed, trying flat mix: ${mixErr.message}`);
      try {
        // Fallback: flat mix without ducking expressions
        await execFileAsync('ffmpeg', [
          '-y',
          '-i', videoPath,
          '-i', narrationPath,
          '-filter_complex',
          '[0:a]volume=0.12[ambient];[1:a]volume=0.85,apad[narr];[ambient][narr]amix=inputs=2:duration=first[aout]',
          '-map', '0:v',
          '-map', '[aout]',
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
          '-c:a', 'aac', '-b:a', '256k', '-ar', '48000',
          '-movflags', '+faststart',
          mixedPath
        ]);
      } catch (flatMixErr) {
        logger.warn(`Flat audio mix also failed, using narration only: ${flatMixErr.message}`);
        await execFileAsync('ffmpeg', [
          '-y',
          '-i', videoPath,
          '-i', narrationPath,
          '-map', '0:v', '-map', '1:a',
          '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k',
          '-shortest', '-movflags', '+faststart',
          mixedPath
        ]);
      }
    }

    // Add title card + end card overlays
    const cardSource = await this._addTitleAndEndCards(mixedPath, outputPath, episode, story);

    // Generate and burn subtitles
    const subtitledPath = path.join(tmpDir, `postprod-subtitled-${epNum}.mp4`);
    let finalSource = cardSource;
    try {
      const { srtPath, srtUrl } = await this._generateSubtitles(cardSource, episode, userId);
      if (srtPath) {
        finalSource = await this._burnSubtitles(cardSource, srtPath, subtitledPath);
        // Store SRT URL on the episode for user download
        await updateBrandStoryEpisode(episode.id, userId, { subtitle_url: srtUrl });
        await fs.unlink(srtPath).catch(() => {});
      }
    } catch (subErr) {
      logger.warn(`Subtitle generation failed (non-fatal): ${subErr.message}`);
    }

    const finalBuffer = await fs.readFile(finalSource);
    const publicUrl = await this._uploadBufferToStorage(
      finalBuffer, userId, 'videos', `ep${epNum}-final.mp4`, 'video/mp4'
    );

    // Cleanup
    await Promise.allSettled([
      fs.unlink(videoPath),
      fs.unlink(narrationPath),
      fs.unlink(mixedPath),
      fs.unlink(outputPath),
      fs.unlink(subtitledPath)
    ]);

    logger.info(`Post-production complete: ${publicUrl}`);
    return publicUrl;
  }

  /**
   * Add title card (first 2.8s) and end card (last 2.5s) text overlays to a video.
   * Title card: series title + "Episode N: Title" centered on screen.
   * End card: cliffhanger text + "Next episode..." over a dark scrim at bottom.
   *
   * Uses sharp to render text as transparent PNG overlays, then ffmpeg overlay filter
   * to composite them. This avoids drawtext (requires --enable-libfreetype) and
   * subtitles (requires --enable-libass) — neither is available in this ffmpeg build.
   *
   * @returns {string} Path to the output file with overlays applied
   */
  async _addTitleAndEndCards(inputPath, outputPath, episode, story) {
    const scene = episode.scene_description || {};
    const seriesTitle = story?.storyline?.title || story?.name || '';
    const epTitle = `Episode ${episode.episode_number}: ${scene.title || 'Untitled'}`;
    const cliffhanger = scene.cliffhanger || '';

    if (!seriesTitle && !cliffhanger) {
      return inputPath;
    }

    const tmpDir = os.tmpdir();
    const tmpFiles = [];

    try {
      const sharp = (await import('sharp')).default;

      // Get video dimensions and duration
      const probeResult = await execFileAsync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-show_entries', 'stream=width,height',
        '-of', 'json', inputPath
      ]);
      const probeJson = JSON.parse(probeResult.stdout);
      const duration = parseFloat(probeJson.format?.duration) || 15;
      const videoStream = (probeJson.streams || []).find(s => s.width);
      const W = videoStream?.width || 1080;
      const H = videoStream?.height || 1920;
      const endCardStart = Math.max(duration - 2.5, duration * 0.7);

      // Helper: render text as transparent PNG via sharp SVG
      const escXml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

      const renderTextOverlay = async (texts, bgColor = null) => {
        // texts: [{ text, fontSize, color, y }]
        const svgLines = texts.map(t =>
          `<text x="50%" y="${t.y}" font-family="Arial, Helvetica, sans-serif" font-size="${t.fontSize}" fill="${t.color}" text-anchor="middle" dominant-baseline="middle">${escXml(t.text)}</text>`
        ).join('\n');

        const bgRect = bgColor
          ? `<rect x="0" y="0" width="${W}" height="${H}" fill="${bgColor}"/>`
          : '';

        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
          ${bgRect}
          ${svgLines}
        </svg>`;

        return sharp(Buffer.from(svg)).png().toBuffer();
      };

      // Generate title card overlay (centered text on transparent bg)
      let titleOverlayPath = null;
      if (seriesTitle) {
        const titlePng = await renderTextOverlay([
          { text: seriesTitle, fontSize: 42, color: 'white', y: Math.round(H / 2) - 40 },
          { text: epTitle, fontSize: 24, color: 'rgba(255,255,255,0.85)', y: Math.round(H / 2) + 20 }
        ]);
        titleOverlayPath = path.join(tmpDir, `title-overlay-${episode.episode_number}.png`);
        await fs.writeFile(titleOverlayPath, titlePng);
        tmpFiles.push(titleOverlayPath);
      }

      // Generate end card overlay (dark scrim at bottom + text)
      let endOverlayPath = null;
      if (cliffhanger) {
        const cliffText = cliffhanger.length > 70 ? cliffhanger.slice(0, 67) + '...' : cliffhanger;
        const endPng = await renderTextOverlay([
          { text: cliffText, fontSize: 22, color: 'white', y: Math.round(H * 0.82) },
          { text: 'Next episode...', fontSize: 18, color: 'rgba(255,255,255,0.7)', y: Math.round(H * 0.90) }
        ], 'rgba(0,0,0,0.55)');
        endOverlayPath = path.join(tmpDir, `end-overlay-${episode.episode_number}.png`);
        await fs.writeFile(endOverlayPath, endPng);
        tmpFiles.push(endOverlayPath);
      }

      // Build ffmpeg filter_complex using overlay filter (always available, no libfreetype needed)
      const inputs = ['-i', inputPath];
      const filterParts = [];
      let currentLabel = '[0:v]';
      let inputIdx = 1;

      if (titleOverlayPath) {
        inputs.push('-loop', '1', '-t', '3', '-i', titleOverlayPath);
        // Fade in 0.3-0.8s, hold, fade out 2.3-2.8s
        filterParts.push(
          `[${inputIdx}:v]format=rgba,fade=in:st=0.3:d=0.5:alpha=1,fade=out:st=2.3:d=0.5:alpha=1[title]`
        );
        filterParts.push(
          `${currentLabel}[title]overlay=0:0:enable='between(t,0.3,2.8)'[v${inputIdx}]`
        );
        currentLabel = `[v${inputIdx}]`;
        inputIdx++;
      }

      if (endOverlayPath) {
        inputs.push('-loop', '1', '-t', '3', '-i', endOverlayPath);
        filterParts.push(
          `[${inputIdx}:v]format=rgba,fade=in:st=0:d=0.5:alpha=1[endcard]`
        );
        filterParts.push(
          `${currentLabel}[endcard]overlay=0:0:enable='gte(t,${endCardStart.toFixed(2)})'[vfinal]`
        );
        currentLabel = '[vfinal]';
        inputIdx++;
      }

      if (filterParts.length === 0) return inputPath;

      const filterComplex = filterParts.join(';');

      await execFileAsync('ffmpeg', [
        '-y',
        ...inputs,
        '-filter_complex', filterComplex,
        '-map', currentLabel,
        '-map', '0:a',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        '-shortest',
        outputPath
      ], { timeout: 120000 });

      return outputPath;
    } catch (cardErr) {
      logger.warn(`Title/end card overlay failed (non-fatal): ${cardErr.message}`);
      return inputPath;
    } finally {
      await Promise.allSettled(tmpFiles.map(f => fs.unlink(f)));
    }
  }

  // ═══════════════════════════════════════════════════
  // SUBTITLE / CAPTION GENERATION
  // ═══════════════════════════════════════════════════

  /**
   * Generate an SRT subtitle file from the episode's dialogue and burn it into the video.
   * Short-form platforms heavily favor captioned content — this increases engagement.
   *
   * Timing strategy: distribute narration lines proportionally across the episode duration,
   * using shot durations as guides. Each line is split into segments of ~8 words for readability.
   *
   * @param {string} videoPath - Path to the video file (for duration probing)
   * @param {Object} episode - Episode record with scene_description.shots
   * @param {string} userId
   * @returns {Promise<{srtPath: string, srtUrl: string}>} Path to local SRT and public URL
   */
  async _generateSubtitles(videoPath, episode, userId) {
    const scene = episode.scene_description || {};
    const shots = scene.shots || [];

    // Collect narration text with timing info from shots
    const dialogueScript = scene.dialogue_script || '';
    if (!dialogueScript || dialogueScript.trim().length === 0) {
      return { srtPath: null, srtUrl: null };
    }

    // Get actual video duration
    let videoDuration = 15;
    try {
      const probeResult = await execFileAsync('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', videoPath
      ]);
      videoDuration = parseFloat(probeResult.stdout) || 15;
    } catch (e) {
      // Use sum of shot durations as fallback
      videoDuration = shots.reduce((sum, s) => sum + (s.duration_seconds || 5), 0) || 15;
    }

    // Split dialogue into word chunks (max ~8 words per subtitle line for readability)
    const words = dialogueScript.trim().split(/\s+/);
    const WORDS_PER_LINE = 7;
    const segments = [];
    for (let i = 0; i < words.length; i += WORDS_PER_LINE) {
      segments.push(words.slice(i, i + WORDS_PER_LINE).join(' '));
    }

    if (segments.length === 0) return { srtPath: null, srtUrl: null };

    // Distribute segments evenly across the video duration (leaving 0.5s buffer at start/end)
    const startOffset = 0.5;
    const endBuffer = 0.5;
    const totalTextDuration = videoDuration - startOffset - endBuffer;
    const segDuration = totalTextDuration / segments.length;

    // Build SRT content
    let srt = '';
    segments.forEach((text, i) => {
      const start = startOffset + (i * segDuration);
      const end = start + segDuration - 0.05; // tiny gap between subtitles
      srt += `${i + 1}\n`;
      srt += `${this._formatSrtTime(start)} --> ${this._formatSrtTime(end)}\n`;
      srt += `${text}\n\n`;
    });

    // Write SRT to temp file
    const tmpDir = os.tmpdir();
    const srtPath = path.join(tmpDir, `ep${episode.episode_number}-subs.srt`);
    await fs.writeFile(srtPath, srt, 'utf-8');

    // Upload SRT to Supabase for user download
    const srtBuffer = Buffer.from(srt, 'utf-8');
    const srtUrl = await this._uploadBufferToStorage(
      srtBuffer, userId, 'subtitles', `ep${episode.episode_number}-subtitles.srt`, 'text/plain'
    );

    logger.info(`Subtitles generated: ${segments.length} segments, SRT: ${srtUrl}`);
    return { srtPath, srtUrl };
  }

  /**
   * Align narration duration to the actual video duration using ffmpeg atempo.
   * When the video model falls back (e.g. Kling → Veo), the actual video duration
   * may differ significantly from the planned duration the TTS was generated for.
   *
   * If the ratio is within 0.85-1.15 (±15%), skip — the difference is negligible.
   * If outside that range, stretch/compress the narration using atempo.
   * atempo supports 0.5-2.0 range; for larger ratios, chain multiple atempo filters.
   *
   * @param {Buffer} videoBuffer - The actual generated video
   * @param {Buffer} narrationBuffer - Original TTS narration
   * @param {Object} episode - Episode record
   * @returns {Promise<Buffer>} Aligned narration buffer (or original if no change needed)
   */
  async _alignNarrationToVideo(videoBuffer, narrationBuffer, episode) {
    const tmpDir = os.tmpdir();
    const epNum = episode.episode_number;
    const videoTmp = path.join(tmpDir, `align-video-${epNum}.mp4`);
    const narTmp = path.join(tmpDir, `align-nar-${epNum}.mp3`);
    const outTmp = path.join(tmpDir, `align-out-${epNum}.mp3`);

    try {
      await fs.writeFile(videoTmp, videoBuffer);
      await fs.writeFile(narTmp, narrationBuffer);

      // Probe both durations
      const [videoProbe, narProbe] = await Promise.all([
        execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoTmp]),
        execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', narTmp])
      ]);

      const videoDur = parseFloat(videoProbe.stdout) || 0;
      const narDur = parseFloat(narProbe.stdout) || 0;

      if (!videoDur || !narDur) return narrationBuffer;

      const ratio = narDur / videoDur;
      logger.info(`Narration alignment: video=${videoDur.toFixed(1)}s, narration=${narDur.toFixed(1)}s, ratio=${ratio.toFixed(2)}`);

      // Skip if within ±15% — close enough
      if (ratio >= 0.85 && ratio <= 1.15) {
        logger.info(`Narration alignment: ratio ${ratio.toFixed(2)} within tolerance — no adjustment needed`);
        return narrationBuffer;
      }

      // Build atempo filter chain. atempo supports 0.5-2.0 per instance.
      // For ratios outside that range, chain multiple atempos.
      // ratio > 1 means narration is longer → speed it up (atempo > 1)
      // ratio < 1 means narration is shorter → slow it down (atempo < 1)
      const tempoFilters = [];
      let remaining = ratio;
      while (remaining > 2.0) {
        tempoFilters.push('atempo=2.0');
        remaining /= 2.0;
      }
      while (remaining < 0.5) {
        tempoFilters.push('atempo=0.5');
        remaining /= 0.5;
      }
      tempoFilters.push(`atempo=${remaining.toFixed(4)}`);

      const filterStr = tempoFilters.join(',');
      logger.info(`Narration alignment: applying ${filterStr} to match video duration`);

      await execFileAsync('ffmpeg', [
        '-y',
        '-i', narTmp,
        '-af', filterStr,
        '-c:a', 'libmp3lame', '-q:a', '2',
        outTmp
      ], { timeout: 30000 });

      const aligned = await fs.readFile(outTmp);
      return aligned;
    } finally {
      await Promise.allSettled([
        fs.unlink(videoTmp),
        fs.unlink(narTmp),
        fs.unlink(outTmp)
      ]);
    }
  }

  /**
   * Build an ffmpeg volume expression for narration that dips at shot transition points.
   * Creates a J/L cut feel — the narration breathes at each visual transition.
   *
   * At each transition timestamp, volume drops from baseVol to baseVol*0.3 over 0.2s,
   * then recovers over 0.3s. This creates a natural editorial rhythm.
   *
   * @param {Object} episode - Episode with scene_description.shots[]
   * @param {number} baseVol - Base narration volume (e.g. 0.85)
   * @returns {string} ffmpeg volume expression (for eval=frame mode)
   */
  _buildDuckingVolumeExpr(episode, baseVol) {
    const shots = episode.scene_description?.shots || [];
    if (shots.length <= 1) return String(baseVol);

    // Calculate cumulative timestamps where visual transitions occur
    const transitionDuration = 0.5; // matches xfade duration in _assembleWithTransitions
    const transitionPoints = [];
    let cumulative = 0;
    for (let i = 0; i < shots.length - 1; i++) {
      cumulative += (shots[i].duration_seconds || 5) - transitionDuration;
      transitionPoints.push(cumulative);
    }

    if (transitionPoints.length === 0) return String(baseVol);

    // Build nested if() expression that dips volume around each transition point.
    // Duck shape: ramp down 0.2s before transition, hold low for 0.1s, ramp up 0.3s after.
    const duckLow = baseVol * 0.35;
    const duckHalf = 0.2; // seconds before transition to start ducking
    const duckHold = 0.1; // seconds at minimum
    const duckRecover = 0.3; // seconds to recover after transition

    // For each transition, add a piecewise expression
    // The general form: if(between(t, T-0.2, T+0.4), <duck_curve>, <else>)
    // Duck curve: ramp_down from T-0.2 to T, hold from T to T+0.1, ramp_up from T+0.1 to T+0.4
    const parts = transitionPoints.map(T => {
      const start = (T - duckHalf).toFixed(3);
      const holdEnd = (T + duckHold).toFixed(3);
      const end = (T + duckHold + duckRecover).toFixed(3);
      // Piecewise: if in range, compute duck; else pass through
      return `if(between(t,${start},${end}),` +
        `if(lt(t,${T.toFixed(3)}),${baseVol}-(${baseVol}-${duckLow})*(t-${start})/${duckHalf},` +
        `if(lt(t,${holdEnd}),${duckLow},` +
        `${duckLow}+(${baseVol}-${duckLow})*(t-${holdEnd})/${duckRecover}))`;
    });

    // Chain parts: if duck1 applies, use it; else if duck2 applies, use it; else baseVol
    // Build from innermost out
    let expr = String(baseVol);
    for (let i = parts.length - 1; i >= 0; i--) {
      expr = `${parts[i]},${expr})`;
    }

    return expr;
  }

  /**
   * Build ambient audio volume expression that swells slightly at transitions.
   * The inverse of narration ducking — ambient rises when narration dips,
   * creating a natural soundscape shift at visual cuts.
   */
  _buildAmbientSwellExpr(episode, baseVol) {
    const shots = episode.scene_description?.shots || [];
    if (shots.length <= 1) return String(baseVol);

    const transitionDuration = 0.5;
    const transitionPoints = [];
    let cumulative = 0;
    for (let i = 0; i < shots.length - 1; i++) {
      cumulative += (shots[i].duration_seconds || 5) - transitionDuration;
      transitionPoints.push(cumulative);
    }

    if (transitionPoints.length === 0) return String(baseVol);

    // Ambient swells to ~3x base at transitions (e.g. 0.12 → 0.35)
    const swellPeak = Math.min(baseVol * 3, 0.4);

    const parts = transitionPoints.map(T => {
      const start = (T - 0.2).toFixed(3);
      const end = (T + 0.4).toFixed(3);
      return `if(between(t,${start},${end}),` +
        `${baseVol}+(${swellPeak}-${baseVol})*` +
        `if(lt(t,${T.toFixed(3)}),(t-${start})/0.2,1.0-(t-${T.toFixed(3)})/0.4)`;
    });

    let expr = String(baseVol);
    for (let i = parts.length - 1; i >= 0; i--) {
      expr = `${parts[i]},${expr})`;
    }

    return expr;
  }

  /**
   * Format seconds to SRT time format: HH:MM:SS,mmm
   */
  _formatSrtTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.round((seconds % 1) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  }

  /**
   * Burn subtitles into a video using drawtext filter_script.
   * Avoids the libass-dependent `subtitles` filter (not available on all ffmpeg builds).
   * Instead, parses the SRT and generates drawtext filters per segment written to a
   * filter_script file (sidesteps all escaping issues).
   */
  /**
   * Burn subtitles into a video using sharp-rendered PNG overlays + ffmpeg overlay filter.
   * Each subtitle segment becomes a transparent PNG with white text + black outline,
   * composited at the correct time range via ffmpeg overlay enable expressions.
   *
   * For episodes with many segments (typical: 10-15), we batch into groups of 4
   * to avoid ffmpeg filter_complex input limits, doing multiple overlay passes.
   */
  async _burnSubtitles(videoPath, srtPath, outputPath) {
    if (!srtPath) return videoPath;

    const tmpDir = os.tmpdir();
    const tmpFiles = [];

    try {
      const sharp = (await import('sharp')).default;

      // Parse SRT into timed segments
      const srtContent = await fs.readFile(srtPath, 'utf-8');
      const segments = this._parseSrt(srtContent);
      if (segments.length === 0) return videoPath;

      // Get video dimensions
      const probeResult = await execFileAsync('ffprobe', [
        '-v', 'error', '-show_entries', 'stream=width,height',
        '-of', 'json', videoPath
      ]);
      const probeJson = JSON.parse(probeResult.stdout);
      const videoStream = (probeJson.streams || []).find(s => s.width);
      const W = videoStream?.width || 1080;
      const H = videoStream?.height || 1920;

      const escXml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

      // Render each subtitle segment as a transparent PNG
      const segmentPngs = [];
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const yPos = Math.round(H * 0.88);
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
          <text x="50%" y="${yPos}" font-family="Arial, Helvetica, sans-serif" font-size="22" font-weight="bold"
                fill="white" stroke="black" stroke-width="2" paint-order="stroke"
                text-anchor="middle" dominant-baseline="middle">${escXml(seg.text)}</text>
        </svg>`;
        const pngBuf = await sharp(Buffer.from(svg)).png().toBuffer();
        const pngPath = path.join(tmpDir, `sub-${i}.png`);
        await fs.writeFile(pngPath, pngBuf);
        tmpFiles.push(pngPath);
        segmentPngs.push({ path: pngPath, start: seg.start, end: seg.end });
      }

      // Apply overlays in batches of 4 (ffmpeg handles many inputs but gets slow with 15+)
      let currentVideoPath = videoPath;
      const BATCH_SIZE = 4;
      for (let batch = 0; batch < segmentPngs.length; batch += BATCH_SIZE) {
        const batchSegs = segmentPngs.slice(batch, batch + BATCH_SIZE);
        const batchOutput = batch + BATCH_SIZE >= segmentPngs.length
          ? outputPath
          : path.join(tmpDir, `sub-batch-${batch}.mp4`);
        if (batchOutput !== outputPath) tmpFiles.push(batchOutput);

        const inputs = ['-i', currentVideoPath];
        const filterParts = [];
        let currentLabel = '[0:v]';

        for (let j = 0; j < batchSegs.length; j++) {
          const seg = batchSegs[j];
          const inputIdx = j + 1;
          inputs.push('-loop', '1', '-t', (seg.end - seg.start + 0.1).toFixed(2), '-i', seg.path);
          const outLabel = j === batchSegs.length - 1 ? '[vout]' : `[vs${batch + j}]`;
          filterParts.push(
            `${currentLabel}[${inputIdx}:v]overlay=0:0:enable='between(t,${seg.start.toFixed(3)},${seg.end.toFixed(3)})'${outLabel}`
          );
          currentLabel = outLabel;
        }

        await execFileAsync('ffmpeg', [
          '-y', ...inputs,
          '-filter_complex', filterParts.join(';'),
          '-map', '[vout]', '-map', '0:a',
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
          '-c:a', 'copy', '-movflags', '+faststart', '-shortest',
          batchOutput
        ], { timeout: 180000 });

        currentVideoPath = batchOutput;
      }

      return outputPath;
    } catch (subErr) {
      logger.warn(`Subtitle burn failed (non-fatal): ${subErr.message}`);
      return videoPath;
    } finally {
      await Promise.allSettled(tmpFiles.map(f => fs.unlink(f)));
    }
  }

  /**
   * Parse SRT content into an array of { start, end, text } segments.
   * Times are in seconds (float).
   */
  _parseSrt(srtContent) {
    const segments = [];
    const blocks = srtContent.trim().split(/\n\n+/);
    for (const block of blocks) {
      const lines = block.trim().split('\n');
      if (lines.length < 3) continue;
      const timeLine = lines[1];
      const match = timeLine.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
      if (!match) continue;
      const start = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]) + parseInt(match[4]) / 1000;
      const end = parseInt(match[5]) * 3600 + parseInt(match[6]) * 60 + parseInt(match[7]) + parseInt(match[8]) / 1000;
      const text = lines.slice(2).join(' ');
      segments.push({ start, end, text });
    }
    return segments;
  }

  // ═══════════════════════════════════════════════════
  // STORY-SO-FAR APPENDIX (running continuity memory)
  // ═══════════════════════════════════════════════════

  /**
   * After each episode is finalized, append a compressed summary to the storyline's
   * season_bible. This prevents late-episode amnesia — by Episode 8+, the "previously on"
   * block compresses early episodes to one-liners, but key narrative threads (planted in
   * Ep 2, payoff in Ep 10) would be forgotten. The story_so_far keeps the writer's room
   * memory fresh without bloating the prompt.
   */
  async _updateStorySoFar(storyId, userId, episode) {
    const story = await getBrandStoryById(storyId, userId);
    if (!story?.storyline) return;

    const scene = episode.scene_description || {};
    const epSummary = `Ep${episode.episode_number} "${scene.title || ''}": ${scene.narrative_beat || ''}. Mood: ${scene.mood || ''}. Cliffhanger: ${scene.cliffhanger || ''}. Emotional state: ${scene.emotional_state || 'not recorded'}.`;

    // Build or append to the running story_so_far
    const existingSoFar = story.storyline.story_so_far || '';
    const updatedSoFar = existingSoFar
      ? `${existingSoFar}\n${epSummary}`
      : `STORY SO FAR:\n${epSummary}`;

    // ─── V4 cross-episode memory streams ───
    // When the episode is a V4 scene-graph (scenes[]→beats[]), extract:
    //   1. previously_on_keyframes — one structured anchor per episode
    //   2. character_voice_samples — rolling cap of 6 characteristic lines per persona
    //   3. emotional_intensity_ledger — 1-10 closing intensity per episode
    // For legacy v2/v3 episodes these fields just carry forward untouched.
    const existingKeyframes = Array.isArray(story.storyline.previously_on_keyframes)
      ? story.storyline.previously_on_keyframes
      : [];
    const existingVoiceSamples = story.storyline.character_voice_samples && typeof story.storyline.character_voice_samples === 'object'
      ? { ...story.storyline.character_voice_samples }
      : {};
    const existingLedger = story.storyline.emotional_intensity_ledger && typeof story.storyline.emotional_intensity_ledger === 'object'
      ? { ...story.storyline.emotional_intensity_ledger }
      : {};

    const updatedKeyframes = [...existingKeyframes];
    const updatedVoiceSamples = existingVoiceSamples;
    const updatedLedger = existingLedger;

    // Explicit V4 gate — see plan
    // .claude/plans/regarding-this-infrastructure-i-magical-flame.md.
    // The previous code branched on Array.isArray(scene.scenes), which silently
    // fell back to the v3 path if a V4 episode shipped a malformed scene_description
    // and corrupted the cross-episode emotional ledger. Now: only V4 episodes take
    // the V4 path; if a V4 episode arrives without a valid scenes[] array we surface
    // a warning so the malformation is caught instead of absorbed.
    const declaredV4 = episode.pipeline_version === 'v4';
    const hasV4Scenes = Array.isArray(scene.scenes) && scene.scenes.length > 0;
    if (declaredV4 && !hasV4Scenes) {
      logger.warn(`Episode ${episode.id || ''} (story ${storyId}, ep ${episode.episode_number}) declared pipeline_version='v4' but scene_description.scenes[] is missing or empty — falling back to legacy story-so-far extraction. Investigate the screenplay output.`);
    }
    const v4Scenes = (declaredV4 && hasV4Scenes) ? scene.scenes : null;

    if (v4Scenes && v4Scenes.length > 0) {
      // Keyframe: prefer the episode's own cliffhanger line or a standout dialogue line
      const allDialogueBeats = [];
      for (const sc of v4Scenes) {
        for (const beat of sc.beats || []) {
          if (beat.dialogue && typeof beat.dialogue === 'string' && beat.dialogue.trim()) {
            allDialogueBeats.push({
              persona_index: Number.isInteger(beat.persona_index) ? beat.persona_index : null,
              dialogue: beat.dialogue.trim(),
              subtext: beat.subtext || null,
              emotion: beat.emotion || null,
              words: beat.dialogue.trim().split(/\s+/).length
            });
          }
          if (Array.isArray(beat.exchanges)) {
            for (const ex of beat.exchanges) {
              if (ex.dialogue && typeof ex.dialogue === 'string' && ex.dialogue.trim()) {
                allDialogueBeats.push({
                  persona_index: Number.isInteger(ex.persona_index) ? ex.persona_index : null,
                  dialogue: ex.dialogue.trim(),
                  subtext: ex.subtext || null,
                  emotion: ex.emotion || null,
                  words: ex.dialogue.trim().split(/\s+/).length
                });
              }
            }
          }
        }
      }

      // Keyframe: use the cliffhanger if provided, else the last dialogue line of the episode
      const keyframeAnchor = scene.cliffhanger
        ? `Ep${episode.episode_number}: ${scene.cliffhanger}`
        : allDialogueBeats.length > 0
          ? `Ep${episode.episode_number}: "${allDialogueBeats[allDialogueBeats.length - 1].dialogue}"`
          : `Ep${episode.episode_number}: ${scene.narrative_beat || scene.title || ''}`;
      updatedKeyframes.push(keyframeAnchor);

      // Voice samples: per persona, pick 2-3 characteristic lines
      //   heuristic: longest line + shortest line + one line with subtext (if any)
      const byPersona = {};
      for (const d of allDialogueBeats) {
        if (d.persona_index === null) continue;
        const key = String(d.persona_index);
        if (!byPersona[key]) byPersona[key] = [];
        byPersona[key].push(d);
      }

      for (const [idxKey, lines] of Object.entries(byPersona)) {
        if (lines.length === 0) continue;
        const sorted = [...lines].sort((a, b) => b.words - a.words);
        const longest = sorted[0];
        const shortest = sorted[sorted.length - 1];
        const withSubtext = lines.find(l => l.subtext && l.subtext.length > 0);
        const picks = [longest, shortest, withSubtext].filter(Boolean);
        const uniquePicks = [];
        const seen = new Set();
        for (const p of picks) {
          if (!seen.has(p.dialogue)) {
            seen.add(p.dialogue);
            uniquePicks.push(p.dialogue);
          }
        }
        const prior = Array.isArray(updatedVoiceSamples[idxKey]) ? updatedVoiceSamples[idxKey] : [];
        const combined = [...prior, ...uniquePicks];
        // Rolling cap: keep the 6 most recent per persona
        updatedVoiceSamples[idxKey] = combined.slice(-6);
      }
    } else if (scene.dialogue_script) {
      // Legacy v2/v3 episode — one narration block. Store as persona 0's sample if the
      // story has personas. This preserves *some* voice continuity for older flows.
      updatedKeyframes.push(`Ep${episode.episode_number}: ${scene.cliffhanger || scene.narrative_beat || scene.title || ''}`);
    } else {
      updatedKeyframes.push(`Ep${episode.episode_number}: ${scene.narrative_beat || scene.title || ''}`);
    }

    // Intensity ledger: extract a rough 1-10 signal from emotional_state keywords.
    // Intentionally simple and genre-agnostic — the screenplay prompt can override
    // with explicit closing_intensity when the bible starts emitting it.
    const closingIntensity = this._estimateEmotionalIntensity(scene.emotional_state || scene.mood || '');
    if (closingIntensity !== null) {
      updatedLedger[String(episode.episode_number)] = closingIntensity;
    }

    // Also track the latest visual_style_prefix for cross-episode continuity
    const updatedStoryline = {
      ...story.storyline,
      story_so_far: updatedSoFar,
      last_visual_style_prefix: scene.visual_style_prefix || story.storyline.last_visual_style_prefix || '',
      last_emotional_state: scene.emotional_state || '',
      previously_on_keyframes: updatedKeyframes,
      character_voice_samples: updatedVoiceSamples,
      emotional_intensity_ledger: updatedLedger
    };

    await updateBrandStory(storyId, userId, { storyline: updatedStoryline });
    logger.info(`Story-so-far updated for story ${storyId} after episode ${episode.episode_number} (${updatedKeyframes.length} keyframes, ${Object.keys(updatedVoiceSamples).length} personas with voice samples)`);
  }

  /**
   * Rough 1-10 intensity estimate from a free-text emotional_state string.
   * Genre-agnostic keyword map. Returns null if nothing matches — caller treats
   * null as "no signal recorded for this episode" and the validator skips the ramp
   * check for that datapoint.
   */
  _estimateEmotionalIntensity(text) {
    if (!text || typeof text !== 'string') return null;
    const t = text.toLowerCase();
    // Descending severity — first match wins
    const buckets = [
      { score: 10, keys: ['devastat', 'catastroph', 'ruined', 'shatter', 'annihilat'] },
      { score: 9,  keys: ['reelin', 'breakdown', 'crushed', 'unravel', 'heartbroken'] },
      { score: 8,  keys: ['furious', 'terror', 'despair', 'horrified', 'betrayed'] },
      { score: 7,  keys: ['stunned', 'tense', 'bracing', 'anxious', 'urgent', 'dread', 'panicked'] },
      { score: 6,  keys: ['suspicious', 'wary', 'uneasy', 'apprehensive', 'brittle', 'heartbreak'] },
      { score: 5,  keys: ['ambivalent', 'unsettled', 'uncertain', 'melanchol', 'bittersweet', 'guarded'] },
      { score: 4,  keys: ['reflective', 'quiet', 'subdued', 'contempl'] },
      { score: 3,  keys: ['curious', 'intrig', 'hopeful', 'calm'] },
      { score: 2,  keys: ['warm', 'relieved', 'content', 'gentle', 'tender'] },
      { score: 1,  keys: ['serene', 'peaceful', 'settled', 'resolved'] }
    ];
    for (const b of buckets) {
      for (const k of b.keys) {
        if (t.includes(k)) return b.score;
      }
    }
    return null;
  }

  // ═══════════════════════════════════════════════════
  // CROSS-EPISODE STORYBOARD SEED CONTINUITY
  // ═══════════════════════════════════════════════════

  /**
   * Get a deterministic base seed for storyboard generation that maintains
   * visual consistency across episodes. Uses the story ID hash as a stable
   * root, with episode and shot offsets for variation within consistency.
   */
  _getStoryboardSeed(story, episodeNumber, shotIndex) {
    // Deterministic hash from story ID — same story always gets same visual family
    const hash = [...story.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0);
    const baseSeed = Math.abs(hash) % 2147483647;
    // Offset by episode * 100 + shot to get variation within the same visual family
    return baseSeed + (episodeNumber * 100) + shotIndex;
  }
}

// Singleton export
const brandStoryService = new BrandStoryService();
export default brandStoryService;
export { BrandStoryService };
