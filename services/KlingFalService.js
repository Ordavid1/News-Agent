// services/KlingFalService.js
// fal.ai Kling wrapper for the V4 Brand Story pipeline.
//
// V4 uses TWO Kling models, each routed to its strength:
//
//   1. Kling O3 Omni Standard — fal-ai/kling-video/o3/standard/image-to-video
//      Used for: dialogue beats (TALKING_HEAD_CLOSEUP, DIALOGUE_IN_SCENE,
//      GROUP_DIALOGUE_TWOSHOT, SILENT_STARE). Character identity lock via
//      inline elements[] (NOT a preflight element_id — elements are embedded
//      per request with frontal_image_url + reference_image_urls).
//      Pricing: $0.168/s
//      Duration: 3–15s flexible
//
//   2. Kling V3 Pro image-to-video — fal-ai/kling-video/v3/pro/image-to-video
//      Used for: ACTION_NO_DIALOGUE, MONTAGE_SEQUENCE (Custom Multi-Shot mode),
//      and any beat with requires_text_rendering: true.
//      Prompt-first workflow.
//      Pricing: $0.224/s base, +$0.056/s with audio
//      Duration: up to 15s continuous
//
// Routing principle: reference-first + dialogue + character identity → Omni.
// Prompt-first + action + montage + on-screen text → V3 Pro.
//
// REAL fal.ai API shapes (verified Phase 1b):
//   - start_image_url (NOT image_url) — the primary anchor frame
//   - elements[] where each element = { frontal_image_url, reference_image_urls[] }
//     referenced in the prompt via @Element1, @Element2 syntax
//   - NO reference_images[] as a flat array (characters go in elements[])
//   - NO element_id / voice_id direct fields on V3 Omni — voice binding is
//     V2.6 Pro only. For V4, voice identity comes from the Mode B Sync Lipsync v3
//     post-pass which retargets mouth shapes to ElevenLabs TTS audio regardless
//     of what voice Kling originally generated.
//   - create-voice endpoint: fal-ai/kling-video/create-voice — body {voice_url},
//     response {voice_id}. Voice IDs work on V2.6 Pro endpoints only.

import FalAiBaseService from './FalAiBaseService.js';

// Model endpoint slugs — live-verified Phase 4
const ENDPOINT_OMNI_STANDARD = 'fal-ai/kling-video/o3/standard/image-to-video';
const ENDPOINT_OMNI_PRO = 'fal-ai/kling-video/o3/pro/image-to-video';
const ENDPOINT_V3_PRO = 'fal-ai/kling-video/v3/pro/image-to-video';
const ENDPOINT_V3_PRO_TEXT = 'fal-ai/kling-video/v3/pro/text-to-video';

// Kling limits
const KLING_MAX_ELEMENTS = 3;             // V3 Omni elements[] cap (characters)
const KLING_MAX_REFS_PER_ELEMENT = 3;     // reference_image_urls per element
const KLING_MAX_PROMPT_CHARS_PER_SHOT = 512;
const KLING_MIN_DURATION = 3;
const KLING_MAX_DURATION = 15;

/**
 * Clamp a value to [min, max].
 */
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/**
 * Truncate a string to maxChars, adding an ellipsis if cut.
 */
function truncate(str, maxChars) {
  if (!str) return '';
  if (str.length <= maxChars) return str;
  return str.slice(0, maxChars - 1) + '…';
}

/**
 * Build a Kling V3 elements[] array from a list of persona character sheets.
 * Each persona becomes ONE element with:
 *   - frontal_image_url = the hero/closeup portrait (priority: closeup → hero → first available)
 *   - reference_image_urls = up to 3 additional angles (side-3/4, full body, etc.)
 *
 * Personas without any reference_image_urls are skipped.
 * Returns the elements array (up to KLING_MAX_ELEMENTS) + the corresponding
 * @Element tokens that can be spliced into a prompt.
 *
 * @param {Object[]} personas - persona_config.personas[] entries to convert
 * @returns {{elements: Array, elementTokens: string[]}}
 */
export function buildKlingElementsFromPersonas(personas) {
  const elements = [];
  const elementTokens = [];

  const capped = Array.isArray(personas) ? personas.slice(0, KLING_MAX_ELEMENTS) : [];
  for (let i = 0; i < capped.length; i++) {
    const persona = capped[i];

    // V4 Phase 9 identity lock — prefer the Canonical Identity Portrait (CIP)
    // set when persona has been canonicalized. CIP is a 3-view neutral-lit
    // set of ONE harmonized face (front / 3/4 left / 3/4 right), built in the
    // character-canonicalization stage to eliminate the "averaged across
    // different magazine shots" drift. When CIP is present, we use it
    // EXCLUSIVELY — no mixing with diverse source uploads that would dilute
    // the identity anchor.
    //
    // Fallback: legacy path uses reference_image_urls directly (untouched
    // behavior for personas built before the CIP stage shipped).
    const cip = Array.isArray(persona?.canonical_identity_urls)
      ? persona.canonical_identity_urls.filter(Boolean)
      : [];
    const refs = cip.length > 0
      ? cip
      : (Array.isArray(persona?.reference_image_urls) ? persona.reference_image_urls.filter(Boolean) : []);
    if (refs.length === 0) continue;

    // CIP ordering: [front, 3/4-left, 3/4-right] — front is the frontal anchor,
    // other two are additional refs. Legacy ordering: index 1 (closeup) as
    // frontal, index 0 + 2+ as additional.
    const frontal = cip.length > 0 ? refs[0] : (refs[1] || refs[0]);
    const additional = refs.filter(url => url !== frontal).slice(0, KLING_MAX_REFS_PER_ELEMENT);

    elements.push({
      frontal_image_url: frontal,
      ...(additional.length > 0 ? { reference_image_urls: additional } : {})
    });
    elementTokens.push(`@Element${elements.length}`);
  }

  return { elements, elementTokens };
}

/**
 * Build a Kling elements[] entry for the brand SUBJECT (product/object).
 *
 * Used for non-invasive subject anchoring on Kling beats: when the screenplay
 * marks a beat with `subject_present: true`, the subject can be appended to
 * the existing personas-derived elements[] (room permitting, max 3 total).
 * No prompt change is needed — Kling locks the form factor via the visual
 * reference alone.
 *
 * @param {string[]} subjectReferenceImages - public URLs of the subject's
 *   reference images (story.subject.reference_image_urls).
 * @returns {Object|null} `{ frontal_image_url, reference_image_urls? }` or
 *   null when no usable refs are present.
 */
export function buildKlingSubjectElement(subjectReferenceImages) {
  const refs = Array.isArray(subjectReferenceImages)
    ? subjectReferenceImages.filter(Boolean)
    : [];
  if (refs.length === 0) return null;
  const frontal = refs[0];
  const additional = refs.slice(1, 1 + KLING_MAX_REFS_PER_ELEMENT);
  return {
    frontal_image_url: frontal,
    ...(additional.length > 0 ? { reference_image_urls: additional } : {})
  };
}

class KlingFalService {
  constructor() {
    // Three independent base services, one per endpoint. Each has its own
    // logger so fal.ai traffic from dialogue/action/montage is easy to
    // separate in logs.
    this.omniStandard = new FalAiBaseService({
      modelSlug: ENDPOINT_OMNI_STANDARD,
      displayName: 'KlingOmniStandard',
      maxPollDurationMs: 900000 // 15 min — Kling can queue during peak
    });

    this.omniPro = new FalAiBaseService({
      modelSlug: ENDPOINT_OMNI_PRO,
      displayName: 'KlingOmniPro',
      maxPollDurationMs: 900000
    });

    this.v3Pro = new FalAiBaseService({
      modelSlug: ENDPOINT_V3_PRO,
      displayName: 'KlingV3Pro',
      maxPollDurationMs: 900000
    });

    this.v3ProText = new FalAiBaseService({
      modelSlug: ENDPOINT_V3_PRO_TEXT,
      displayName: 'KlingV3ProText',
      maxPollDurationMs: 900000
    });
  }

  /**
   * True if fal.ai credentials are configured (same for all sub-services).
   */
  isAvailable() {
    return this.omniStandard.isAvailable();
  }

  // ─────────────────────────────────────────────────────────────────────
  // KLING O3 OMNI — dialogue/character beats (Mode B primary)
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Generate a dialogue/character beat via Kling O3 Omni Standard.
   * This is the VISUAL step of V4's Mode B hybrid — the lip-sync correction
   * happens afterwards via SyncLipsyncFalService on the returned video.
   *
   * Uses image-to-video with inline elements[] for character identity lock.
   * Each element is referenced in the prompt via @Element1, @Element2, ...
   *
   * @param {Object} params
   * @param {string} params.startFrameUrl - start_image_url (the opening frame)
   * @param {Array} [params.elements=[]] - KlingV3ComboElementInput entries:
   *   each { frontal_image_url, reference_image_urls?: string[] }
   *   Use buildKlingElementsFromPersonas() to construct from persona refs.
   * @param {string} params.prompt - scene description (action, emotion, camera, lens);
   *   reference characters via @Element1, @Element2 if elements are provided
   * @param {Object} [params.options]
   * @param {number} [params.options.duration=5] - 3–15s
   * @param {string} [params.options.aspectRatio='9:16'] - '9:16' | '16:9' | '1:1'
   * @param {boolean} [params.options.generateAudio=true] - Omni's native audio (replaced by Sync Lipsync v3 in Mode B)
   * @param {string} [params.options.negativePrompt]
   * @param {string} [params.options.endImageUrl] - optional end_image_url anchor
   * @param {string} [params.options.tier='standard'] - 'standard' | 'pro'
   * @returns {Promise<{videoUrl: string, videoBuffer: Buffer, duration: number, model: string}>}
   */
  async generateDialogueBeat({ startFrameUrl, elements = [], prompt, options = {} }) {
    if (!startFrameUrl) throw new Error('KlingFalService: startFrameUrl is required for Omni dialogue beat');
    if (!prompt) throw new Error('KlingFalService: prompt is required for Omni dialogue beat');

    const {
      duration = 5,
      aspectRatio = '9:16',
      generateAudio = true,
      negativePrompt = '',
      endImageUrl = null,
      tier = 'standard'
    } = options;

    const clampedDuration = clamp(duration, KLING_MIN_DURATION, KLING_MAX_DURATION);
    const truncatedPrompt = truncate(prompt, KLING_MAX_PROMPT_CHARS_PER_SHOT);

    if (truncatedPrompt.length < prompt.length) {
      this.omniStandard.logger.warn(
        `prompt truncated from ${prompt.length} → ${KLING_MAX_PROMPT_CHARS_PER_SHOT} chars`
      );
    }

    const cappedElements = Array.isArray(elements) ? elements.slice(0, KLING_MAX_ELEMENTS) : [];

    // Kling O3 Omni Standard image-to-video uses `image_url` (NOT `start_image_url`
    // like V3 Pro). Verified against real 422 error from fal.ai on 2026-04-11:
    //   {"detail":[{"type":"missing","loc":["body","image_url"],"msg":"Field required"}]}
    // The two endpoints diverged in their input schema; don't conflate them.
    const inputPayload = {
      prompt: truncatedPrompt,
      image_url: startFrameUrl,
      duration: clampedDuration,
      aspect_ratio: aspectRatio,
      generate_audio: generateAudio
    };

    if (cappedElements.length > 0) inputPayload.elements = cappedElements;
    // O3 Omni image-to-video does NOT accept end_image_url (that's V3 Pro territory).
    // Skipping it on Omni to avoid another 422.
    if (negativePrompt) inputPayload.negative_prompt = negativePrompt;

    const service = tier === 'pro' ? this.omniPro : this.omniStandard;
    service.logger.info(
      `dialogue beat — ${clampedDuration}s, ${aspectRatio}, ${cappedElements.length} element(s), audio=${generateAudio}`
    );

    const result = await service.run(inputPayload);

    // fal.ai Kling returns: { video: { url, content_type, file_size, ... }, ... }
    const videoUrl = result?.video?.url;
    if (!videoUrl) {
      service.logger.error(`completed but no video URL: ${JSON.stringify(result)}`);
      throw new Error('Kling Omni API did not return a video URL');
    }

    const videoBuffer = await service.downloadToBuffer(videoUrl, 'video');

    return {
      videoUrl,
      videoBuffer,
      duration: clampedDuration,
      model: tier === 'pro' ? 'kling-o3-omni-pro' : 'kling-o3-omni-standard'
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // KLING V3 PRO — action/montage/text-rendering beats (prompt-first)
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Generate an action beat via Kling V3 Pro (prompt-first cinematic).
   * Used for ACTION_NO_DIALOGUE beats and any beat flagged with
   * requires_text_rendering: true.
   *
   * @param {Object} params
   * @param {string} [params.startFrameUrl] - optional start_image_url anchor
   * @param {Array} [params.elements=[]] - optional inline character elements
   *   ({ frontal_image_url, reference_image_urls?: string[] })
   * @param {string} params.prompt - cinematic action description
   * @param {Object} [params.options]
   * @param {number} [params.options.duration=5]
   * @param {string} [params.options.aspectRatio='9:16']
   * @param {boolean} [params.options.generateAudio=false]
   * @param {string} [params.options.negativePrompt]
   * @returns {Promise<{videoUrl: string, videoBuffer: Buffer, duration: number, model: string}>}
   */
  async generateActionBeat({ startFrameUrl = null, elements = [], prompt, options = {} }) {
    if (!prompt) throw new Error('KlingFalService: prompt is required for V3 Pro action beat');

    const {
      duration = 5,
      aspectRatio = '9:16',
      generateAudio = false,
      negativePrompt = ''
    } = options;

    const clampedDuration = clamp(duration, KLING_MIN_DURATION, KLING_MAX_DURATION);
    const truncatedPrompt = truncate(prompt, KLING_MAX_PROMPT_CHARS_PER_SHOT);

    // V3 Pro image-to-video needs a start frame; without one, fall through
    // to text-to-video.
    if (!startFrameUrl) {
      return this._generateTextToVideoV3Pro({
        prompt: truncatedPrompt,
        duration: clampedDuration,
        aspectRatio,
        generateAudio,
        negativePrompt
      });
    }

    const cappedElements = Array.isArray(elements) ? elements.slice(0, KLING_MAX_ELEMENTS) : [];

    const inputPayload = {
      prompt: truncatedPrompt,
      start_image_url: startFrameUrl,
      duration: clampedDuration,
      aspect_ratio: aspectRatio,
      generate_audio: generateAudio
    };
    if (cappedElements.length > 0) inputPayload.elements = cappedElements;
    if (negativePrompt) inputPayload.negative_prompt = negativePrompt;

    this.v3Pro.logger.info(
      `action beat — ${clampedDuration}s, ${aspectRatio}, ${cappedElements.length} element(s), audio=${generateAudio}`
    );

    const result = await this.v3Pro.run(inputPayload);

    const videoUrl = result?.video?.url;
    if (!videoUrl) {
      this.v3Pro.logger.error(`completed but no video URL: ${JSON.stringify(result)}`);
      throw new Error('Kling V3 Pro API did not return a video URL');
    }

    const videoBuffer = await this.v3Pro.downloadToBuffer(videoUrl, 'video');

    return {
      videoUrl,
      videoBuffer,
      duration: clampedDuration,
      model: 'kling-v3-pro'
    };
  }

  /**
   * Internal: text-to-video fallback when no start frame available.
   */
  async _generateTextToVideoV3Pro({ prompt, duration, aspectRatio, generateAudio, negativePrompt }) {
    const inputPayload = {
      prompt,
      duration,
      aspect_ratio: aspectRatio,
      generate_audio: generateAudio
    };
    if (negativePrompt) inputPayload.negative_prompt = negativePrompt;

    this.v3ProText.logger.info(`text-to-video action beat — ${duration}s, ${aspectRatio}`);
    const result = await this.v3ProText.run(inputPayload);

    const videoUrl = result?.video?.url;
    if (!videoUrl) throw new Error('Kling V3 Pro text-to-video did not return a video URL');

    const videoBuffer = await this.v3ProText.downloadToBuffer(videoUrl, 'video');

    return {
      videoUrl,
      videoBuffer,
      duration,
      model: 'kling-v3-pro-text'
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // KLING V3 PRO CUSTOM MULTI-SHOT — montage sequences
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Generate a MONTAGE_SEQUENCE scene via Kling V3 Pro's Custom Multi-Shot mode.
   * Produces 4–6 chronological shots in a SINGLE API call, each with its own
   * prompt and duration.
   *
   * @param {Object} params
   * @param {Array<{prompt: string, duration: number}>} params.shots - 2–6 shot entries
   * @param {string} [params.startFrameUrl] - optional start_image_url anchor for shot 1
   * @param {Array} [params.elements=[]] - optional inline character elements
   * @param {Object} [params.options]
   * @param {string} [params.options.aspectRatio='9:16']
   * @param {boolean} [params.options.generateAudio=true]
   * @returns {Promise<{videoUrl: string, videoBuffer: Buffer, duration: number, model: string}>}
   */
  async generateMontageSequence({ shots, startFrameUrl = null, elements = [], options = {} }) {
    if (!Array.isArray(shots) || shots.length < 2) {
      throw new Error('KlingFalService: montage requires at least 2 shots');
    }
    if (shots.length > 6) {
      throw new Error('KlingFalService: montage supports max 6 shots per call');
    }

    const {
      aspectRatio = '9:16',
      generateAudio = true
    } = options;

    const multiPrompt = shots.map((s, i) => {
      if (!s.prompt) throw new Error(`KlingFalService: shot ${i} missing prompt`);
      return {
        prompt: truncate(s.prompt, KLING_MAX_PROMPT_CHARS_PER_SHOT),
        duration: clamp(s.duration || 3, 2, 8)
      };
    });

    const totalDuration = multiPrompt.reduce((sum, s) => sum + s.duration, 0);

    const inputPayload = {
      multi_prompt: multiPrompt,
      aspect_ratio: aspectRatio,
      generate_audio: generateAudio
    };

    if (startFrameUrl) inputPayload.start_image_url = startFrameUrl;
    const cappedElements = Array.isArray(elements) ? elements.slice(0, KLING_MAX_ELEMENTS) : [];
    if (cappedElements.length > 0) inputPayload.elements = cappedElements;

    this.v3Pro.logger.info(
      `montage sequence — ${multiPrompt.length} shots, ${totalDuration}s total, ${cappedElements.length} element(s), ${aspectRatio}`
    );

    const result = await this.v3Pro.run(inputPayload);

    const videoUrl = result?.video?.url;
    if (!videoUrl) {
      this.v3Pro.logger.error(`montage completed but no video URL: ${JSON.stringify(result)}`);
      throw new Error('Kling V3 Pro montage did not return a video URL');
    }

    const videoBuffer = await this.v3Pro.downloadToBuffer(videoUrl, 'video');

    return {
      videoUrl,
      videoBuffer,
      duration: totalDuration,
      model: 'kling-v3-pro-multishot'
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // VOICE PREFLIGHT — fal-ai/kling-video/create-voice
  //
  // Real fal.ai endpoint verified Phase 1b. Input: {voice_url}. Output: {voice_id}.
  // Audio constraints: .mp3/.wav/.mp4/.mov, 5-30s, clean single-voice.
  //
  // IMPORTANT caveat for V4:
  //   Kling voice_ids ONLY work on the V2.6 Pro endpoint family (via a
  //   voice_ids[] array on image-to-video and the <<<voice_1>>>/<<<voice_2>>>
  //   prompt markers). V3 Omni/V3 Pro do NOT accept voice_ids — V4's Mode B
  //   relies on Sync Lipsync v3 to retarget mouth shapes to ElevenLabs TTS audio.
  //
  //   So why ship createVoice at all?
  //     (a) A/B testing Mode B vs a V2.6 Pro voice-bound Mode C pathway
  //     (b) Future V4.1 / V5 when Kling adds voice_ids to V3 endpoints
  //     (c) Completes the Phase 1b checklist without a stubbed throw
  //
  // There is NO createElement endpoint. Elements on V3 Omni are inline per
  // request (see buildKlingElementsFromPersonas + the elements[] field).
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Clone a voice from a 5-30s reference audio clip.
   *
   * @param {Object} params
   * @param {string} params.audioSampleUrl - public URL of the reference audio
   *   (.mp3/.wav/.mp4/.mov, 5-30s, clean single-voice)
   * @returns {Promise<{voiceId: string}>}
   */
  async createVoice({ audioSampleUrl }) {
    if (!this.isAvailable()) throw new Error('KlingFalService.createVoice: FAL_GCS_API_KEY not configured');
    if (!audioSampleUrl) throw new Error('KlingFalService.createVoice: audioSampleUrl is required');

    // Use a one-off FalAiBaseService pointed at the create-voice slug.
    // Not cached on `this` because voice creation is a rare per-persona
    // preflight step, not a hot path.
    const voiceService = new FalAiBaseService({
      modelSlug: 'fal-ai/kling-video/create-voice',
      displayName: 'KlingCreateVoice',
      // Voice creation is fast (typically <30s) but still goes through queue/poll.
      maxPollDurationMs: 300000
    });

    voiceService.logger.info(`cloning Kling voice from ${audioSampleUrl.slice(0, 80)}...`);

    const inputPayload = {
      voice_url: audioSampleUrl
    };

    const result = await voiceService.run(inputPayload);

    // Response shape: { voice_id: string }
    const voiceId = result?.voice_id;
    if (!voiceId) {
      voiceService.logger.error(`create-voice returned no voice_id: ${JSON.stringify(result)}`);
      throw new Error('KlingFalService.createVoice: no voice_id in response');
    }

    voiceService.logger.info(`cloned Kling voice_id: ${voiceId}`);
    return { voiceId };
  }
}

// Singleton export
const klingFalService = new KlingFalService();
export default klingFalService;
export { KlingFalService };
