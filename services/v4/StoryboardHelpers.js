// services/v4/StoryboardHelpers.js
// V4 storyboard helpers — Scene Master generation, beat reference stack
// builder, and endframe extraction.
//
// These are the 3-level hierarchy pieces from sunny-wishing-teacup.md:
//   L1 Character Sheet   (per persona, story-level, already built)
//   L2 Scene Master      (per scene, episode-level, NEW in V4)
//   L3 Beat Ref Stack    (per beat, derived, NEW in V4)
//
// Plus the endframe extraction that feeds cross-beat visual continuity.
// Pure helpers, no class state — called by the runV4Pipeline orchestrator.

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import seedreamFalService, { SceneAnchorOverDeterminedError } from '../SeedreamFalService.js';
import { rewriteAnchorForContentPolicy } from './SceneMasterContentRewriter.js';
import { generatePanelViaFallbackChain } from './SceneMasterModelFallback.js';
import { isStylizedStrong, isNonPhotorealStyle, resolveStyleCategory } from './CreativeBriefDirector.js';

// ─────────────────────────────────────────────────────────────────────
// Scene Master generation (Level 2 of the 3-level hierarchy)
// ─────────────────────────────────────────────────────────────────────

/**
 * Generate Scene Master panels for every scene in an episode, in parallel.
 *
 * Each scene gets ONE Seedream 5 Lite Edit panel at 9:16 / 3K, conditioned on:
 *   - visual_style_prefix (episode-level cinematic brief)
 *   - scene.scene_visual_anchor_prompt (Gemini-written scene description)
 *   - persona character sheets (for character blocking + identity lock)
 *   - subject reference images (for product-focus stories)
 *
 * The Scene Master URL is written back to each scene object in place.
 *
 * @param {Object} params
 * @param {Object[]} params.scenes - scene_description.scenes[] (mutated in place)
 * @param {string} params.visualStylePrefix
 * @param {Object[]} params.personas - persona_config.personas[]
 * @param {string[]} [params.subjectReferenceImages] - product/brand kit assets
 * @param {string} params.storyFocus - 'person' | 'product' | 'landscape'
 * @param {string} params.userId
 * @param {Function} params.uploadBuffer - (buffer, subfolder, filename, mimeType) => Promise<publicUrl>
 * @param {number} [params.baseSeed] - deterministic seed family for cross-scene coherence
 * @returns {Promise<void>}
 */
export async function generateSceneMasters({
  scenes,
  visualStylePrefix = '',
  personas = [],
  subjectReferenceImages = [],
  storyFocus = 'product',
  // Phase 6 (2026-04-28) — when supplied, switches reference ordering AND cap
  // for commercial-genre stories. Commercial gets persona-first ordering AND
  // a tighter cap (4 instead of 10). The 10-ref soup was a root cause of
  // muddy Scene Masters in commercials (logs.txt 2026-04-28): with 2 personas
  // × multiple sheet variants × subject refs, Seedream averaged across too
  // many conflicting visual states and produced incoherent panels.
  genre = '',
  productIntegrationStyle = '',
  // V4 Phase 7 — commercialBrief threads style_category into the verticalDirective
  // so non-photoreal styles (hand_doodle_animated, surreal_dreamlike) get a
  // stylized-identity directive ("preserve archetype, not photographic likeness")
  // instead of the photoreal "preserve exact facial structure" language that
  // fights animated brief intent.
  commercialBrief = null,
  userId,
  uploadBuffer,
  baseSeed
}) {
  if (!Array.isArray(scenes)) throw new Error('generateSceneMasters: scenes array required');
  if (!uploadBuffer) throw new Error('generateSceneMasters: uploadBuffer helper required');

  const genreLower = String(genre).toLowerCase().trim();
  const styleLower = String(productIntegrationStyle).toLowerCase().trim();
  const isCommercial = genreLower === 'commercial' || styleLower === 'commercial';

  // Collect all persona reference images (character sheet views) into one flat list.
  // Seedream accepts up to 10 reference images — ordering matters because
  // Seedream weights earlier refs slightly higher.
  const personaRefs = personas
    .flatMap(p => p.reference_image_urls || [])
    .filter(Boolean);

  // Ordering by story focus + commercial override:
  //   - person                                  → personas first
  //   - product (default)                       → subject first (legacy)
  //   - product + commercial (Phase 6 override) → personas first (talent identity matters most for ad spots)
  //   - landscape                               → subject first
  const personaFirst = storyFocus === 'person' || isCommercial;
  const baseRefs = personaFirst
    ? [...personaRefs, ...subjectReferenceImages]
    : [...subjectReferenceImages, ...personaRefs];

  // Cap: 4 for commercial (matches Kling's per-beat cap → consistent identity
  // anchoring across Scene Master + beats), 10 for everything else (Seedream's
  // technical max).
  const refCap = isCommercial ? 4 : 10;
  const refsCapped = baseRefs.slice(0, refCap);

  const seed = baseSeed != null ? baseSeed : Math.floor(Math.random() * 1_000_000);

  // Generate all scene masters in parallel. Per-scene Seedream calls are
  // independent; failures are isolated to the one scene.
  const tasks = scenes.map(async (scene, i) => {
    if (scene.scene_master_url) {
      // Already has a master (resume path) — skip
      return;
    }

    const anchorPrompt = scene.scene_visual_anchor_prompt || scene.location || 'establishing shot';
    // V4 Phase 9 — vertical framing directive on every Scene Master. Seedream
    // respects aspect_ratio=9:16 but (same as Veo) will compose a wide-scope
    // panel inside a vertical canvas unless explicitly told to use vertical
    // stacking and fill the vertical axis.
    //
    // V4 Phase 7 — split into framing clause + identity clause. The identity
    // clause now branches on commercial_brief.style_category. For non-photoreal
    // styles (hand_doodle_animated, surreal_dreamlike), demanding "exact facial
    // structure from reference images (inter-ocular distance, nose geometry,
    // jawline, lip shape)" forces Seedream to render photoreal facial features
    // even when the brief said cel-shaded — the very style the brief asked
    // for is fought by the directive. Stylized variant preserves CHARACTER
    // ARCHETYPE (silhouette, hair, wardrobe, signature accessory) instead.
    const framingClause =
      'VERTICAL 9:16 composition. Subject fills the full vertical axis of the frame. ' +
      'Visual elements stacked along the Y axis (foreground/midground/background vertical). ' +
      'Subject occupies 70-90% of frame height. Tight headroom. ' +
      'No letterbox, no cinemascope bars, no horizontal-wide shot placed in a vertical canvas. ' +
      'Portrait-native framing — TikTok / Instagram Reels aspect. ' +
      'If architecture is present, use low-angle looking UP with ceiling in upper third.';

    let identityClause;
    if (isStylizedStrong(commercialBrief)) {
      const styleCategory = resolveStyleCategory(commercialBrief);
      identityClause =
        `If characters present, preserve the CHARACTER ARCHETYPE in the ${styleCategory} art style — ` +
        'silhouette, hair shape, wardrobe motif, signature accessory. ' +
        'Stylized interpretation, not photographic likeness. ' +
        'The reference images describe the actor; the rendered character is the actor reinterpreted in ' +
        `${styleCategory} grammar — same archetype, same wardrobe motif, but rendered in the target art style.`;
    } else if (isNonPhotorealStyle(commercialBrief)) {
      const styleCategory = resolveStyleCategory(commercialBrief);
      identityClause =
        'If characters present, preserve recognizable facial structure consistent with the reference images, ' +
        `allowing for the ${styleCategory} art-direction interpretation in lighting, grade, and texture. ` +
        'Identity is invariant; rendering style follows the brief.';
    } else {
      identityClause =
        'If characters present, preserve exact facial structure from reference images ' +
        '(inter-ocular distance, nose geometry, jawline, lip shape) — identity is invariant across shots.';
    }

    const verticalDirective = `${framingClause} ${identityClause}`;
    const fullPrompt = [verticalDirective, visualStylePrefix, anchorPrompt].filter(Boolean).join('. ');

    // V4 Phase 5b — Fix 9 + N4. 5-tier Scene Master content-policy chain.
    // Tier 0 (Seedream regex sanitize) lives inside SeedreamFalService.
    // When Tier 0 exhausts, Seedream throws SceneAnchorOverDeterminedError.
    // We then walk Tier 1 → 2 → 3 here.
    let result = null;
    let panelTier = 'tier0';
    let panelPrompt = fullPrompt;

    try {
      result = await seedreamFalService.generatePanel({
        prompt: fullPrompt,
        referenceImages: refsCapped,
        options: {
          aspectRatio: '9:16',
          size: '3K',
          seed: seed + i,
          sequentialGeneration: 'auto'
        },
        label: 'scene master'
      });
    } catch (err) {
      if (!(err instanceof SceneAnchorOverDeterminedError)) {
        // Non-content-policy failure — don't run Tier 1/2/3. Surface as
        // before so non-commercial stories degrade gracefully.
        scene.scene_master_error = err.message || String(err);
        return;
      }

      // ── Tier 2 — Gemini-rewrite generic prompt ──
      // Tier 1 (anchor-rewrite via Director finding) is dispatched by the
      // ORCHESTRATOR (BrandStoryService Fix 8 auto-fix loop) once the beat
      // pass surfaces the over-determination. At Scene Master generation
      // time we don't have a Director verdict yet, so we go straight to
      // Tier 2 here. The orchestrator-driven Tier 1 path catches any
      // surviving anchor-class issue post-Lens-A.
      try {
        const rewritten = await rewriteAnchorForContentPolicy({
          prompt: err.originalPrompt || fullPrompt,
          sanitizedPrompt: err.sanitizedPrompt || '',
          label: 'scene master'
        });
        panelPrompt = rewritten;
        result = await seedreamFalService.generatePanel({
          prompt: rewritten,
          referenceImages: refsCapped,
          options: {
            aspectRatio: '9:16',
            size: '3K',
            seed: seed + i,
            sequentialGeneration: 'auto'
          },
          label: 'scene master (Tier 2 rewrite)'
        });
        panelTier = 'tier2_gemini_rewrite';
      } catch (tier2Err) {
        // ── Tier 3 — different-model fallback (Nano Banana Pro → Flux 2 Max edit) ──
        // Even after Gemini rewrite, Seedream may still refuse. The Tier 3
        // chain tries a model with a different content filter.
        try {
          const fallbackPrompt = panelPrompt; // use whichever rewrite worked best
          const fallbackResult = await generatePanelViaFallbackChain({
            prompt: fallbackPrompt,
            referenceImages: refsCapped,
            label: 'scene master'
          });
          result = fallbackResult;
          panelTier = fallbackResult.fallback_tier || 'tier3';
        } catch (tier3Err) {
          // ── Tier 4 — escalation. All five tiers exhausted. ──
          // For commercial stories (N1 hard gate, user-confirmed 2026-04-29)
          // we MUST throw so the episode escalates to user_review rather
          // than ship with a null Scene Master. For non-commercial we
          // preserve the legacy non-fatal behavior (beats fall back to
          // character sheets / endframes).
          scene.scene_master_error = `Tier chain exhausted (T0/T2/T3): ${tier3Err.message}`;
          if (isCommercial) {
            // N1: commercial Scene Master failure is FATAL. Throw so the
            // outer Promise.all rejects and the orchestrator halts.
            const fatalErr = new SceneMasterFatalError(
              `Scene Master generation FAILED for commercial scene "${scene.scene_id || i}" — all 5 tiers exhausted. Original: ${err.message}; Tier2: ${tier2Err.message}; Tier3: ${tier3Err.message}`,
              { scene_id: scene.scene_id, original_error: err, tier2_error: tier2Err, tier3_error: tier3Err }
            );
            throw fatalErr;
          }
          // Non-commercial: preserve legacy non-fatal degradation.
          return;
        }
      }
    }

    // Persist the panel — same path for Tier 0 / Tier 2 / Tier 3 results.
    const publicUrl = await uploadBuffer(
      result.imageBuffer,
      `storyboard/scene-masters`,
      `scene-${scene.scene_id || i}-master.png`,
      'image/png'
    );

    scene.scene_master_url = publicUrl;
    scene.scene_master_prompt = panelPrompt;
    scene.scene_master_tier = panelTier;
    if (result.model && result.model !== 'seedream-5-lite-edit') {
      scene.scene_master_fallback_model = result.model;
    }
  });

  // V4 Phase 5b — N1 hard gate. For commercial, scene-level fatal errors
  // bubble up as SceneMasterFatalError. We rethrow to the orchestrator so
  // the episode is marked awaiting_user_review rather than shipping a 6-of-8
  // cut. Non-commercial stories preserve their per-scene degradation.
  if (isCommercial) {
    // Use Promise.allSettled here (not Promise.all) so we can collect ALL
    // fatal errors in one shot rather than only the first to reject. Then
    // throw the first SceneMasterFatalError if any present.
    const settled = await Promise.allSettled(tasks);
    const fatals = settled.filter(s => s.status === 'rejected' && s.reason instanceof SceneMasterFatalError);
    if (fatals.length > 0) {
      const firstFatal = fatals[0].reason;
      // Re-throw with aggregated detail so the orchestrator sees the count.
      throw new SceneMasterFatalError(
        `${fatals.length} commercial scene master(s) failed all 5 tiers. First: ${firstFatal.message}`,
        { fatals: fatals.map(f => f.reason.context) }
      );
    }
    // Surface other rejections as warnings — non-fatal but logged.
    settled
      .filter(s => s.status === 'rejected' && !(s.reason instanceof SceneMasterFatalError))
      .forEach(s => logger.warn(`commercial scene master non-fatal rejection: ${s.reason?.message || s.reason}`));
    return;
  }

  await Promise.all(tasks);
}

/**
 * V4 Phase 5b — N1. Fatal Scene Master failure for commercial stories.
 * Thrown when all 5 tiers (regex sanitize → anchor rewrite → Gemini rewrite
 * → model fallback chain) exhaust without producing a valid panel. The
 * orchestrator catches this and marks the episode awaiting_user_review,
 * rather than shipping with a null Scene Master and a 6-of-8 cut.
 */
export class SceneMasterFatalError extends Error {
  constructor(message, context = {}) {
    super(message);
    this.name = 'SceneMasterFatalError';
    this.context = context;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Beat reference stack builder (Level 3 of the hierarchy)
// ─────────────────────────────────────────────────────────────────────

/**
 * Build the reference image stack for a single beat at generation time.
 *
 * Composition (ordered by priority — Kling/Veo weight earlier refs higher):
 *   1. Persona character sheets (for characters in this beat)
 *   2. Subject reference images (user-uploaded product/landscape assets) when
 *      beat.subject_present is true OR the beat type is subject-anchored
 *      (INSERT_SHOT / B_ROLL_ESTABLISHING)
 *   3. Location bible entry (if scene.location_id resolves to a known location)
 *   4. Scene Master (for scene-level lighting/color/blocking)
 *   5. Previous beat endframe (for frame-level continuity)
 *
 * Capped at 7 (Kling's limit) — the most relevant refs win.
 *
 * @param {Object} params
 * @param {Object} params.beat
 * @param {Object} params.scene
 * @param {Object} [params.previousBeat]
 * @param {Object[]} params.personas
 * @param {string[]} [params.subjectReferenceImages] - user-uploaded subject imagery
 * @param {Object} [params.locationBible] - { locations: [{ id, scene_master_url, ... }] }
 * @returns {string[]} ordered list of reference image URLs
 */
export function buildBeatRefStack({
  beat,
  scene,
  previousBeat,
  personas,
  subjectReferenceImages = [],
  locationBible = null
}) {
  const refs = [];

  // 1. Persona character sheets — which personas are in this beat?
  const personaIndexes = [];
  if (typeof beat.persona_index === 'number') personaIndexes.push(beat.persona_index);
  if (Array.isArray(beat.persona_indexes)) personaIndexes.push(...beat.persona_indexes);
  if (Array.isArray(beat.voiceover_persona_index != null ? [beat.voiceover_persona_index] : [])) {
    personaIndexes.push(beat.voiceover_persona_index);
  }

  for (const idx of personaIndexes) {
    const persona = personas[idx];
    // 2026-05-07 — Director Agent prestige mandate: CIP (Canonical Identity
    // Portrait) is now included in the DEFAULT ref stack as the highest-
    // priority persona ref. Previously CIP only fed the persona-locked
    // first-frame pre-pass (Veo identity anchor, see buildPersonaLockedFirstFrame
    // at line 489). That meant Kling-routed beats (dialogue, group two-shot,
    // talking head closeup, action) drew identity from the diverse magazine-
    // shot reference_image_urls, which produces averaged-face drift past
    // beat 3-4. Promoting the front-facing CIP into every beat's ref stack
    // gives Kling the same single-face ground truth the persona-locked
    // first-frame uses — face stability across the whole episode.
    //
    // Order: 1 CIP front-view first (priority slot), then up to 2 legacy
    // reference views (hero + closeup). Total 3 refs per persona, dedupe
    // catches overlaps. Falls back to reference_image_urls only when CIP
    // is unauthored (legacy personas / opt-out).
    const cip = Array.isArray(persona?.canonical_identity_urls)
      ? persona.canonical_identity_urls
      : null;
    if (cip && cip.length > 0) {
      // Front view = first canonical entry (per CharacterSheetDirector convention)
      refs.push(cip[0]);
    }
    if (persona?.reference_image_urls?.length) {
      // Up to 2 views per persona (hero + closeup) — dedupe caught at the end
      refs.push(...persona.reference_image_urls.slice(0, 2));
    }
  }

  // 2. Subject reference images — the user's uploaded product/landscape assets
  //    must be respected on beats that feature the subject, not only on Scene
  //    Master generation. This is the single biggest win for "user choices &
  //    uploads must be highly respected": the actual product pixels ride into
  //    the beat ref stack.
  const SUBJECT_ANCHORED_TYPES = new Set(['INSERT_SHOT', 'B_ROLL_ESTABLISHING']);
  const subjectRelevant =
    beat?.subject_present === true ||
    SUBJECT_ANCHORED_TYPES.has(beat?.type);
  if (subjectRelevant && Array.isArray(subjectReferenceImages) && subjectReferenceImages.length) {
    // Up to 2 subject refs — preserves room for personas + scene master
    refs.push(...subjectReferenceImages.slice(0, 2));
  }

  // 3. Location bible — reusing the master for a known location delivers the
  //    "same physical place renders the same way across scenes/episodes" promise.
  //
  // V4 Tier 2.5 (2026-05-06) — widened gate. Previously only fired when
  // `beat.location_hero === true`, which narrowed reuse to beats Gemini
  // explicitly flagged as "location matters here" — a tiny fraction. As a
  // result, reused locations across scenes drifted visually (each scene
  // generated a fresh Scene Master, ignoring the cached one). Per the
  // Director's Tier 2.5 note, reuse now fires whenever scene.location_id
  // resolves to a known location, regardless of the per-beat flag. The
  // location_hero flag is now a WRITE-side gate ("this scene defines /
  // refreshes the bible entry") not a read-side one. Falls back gracefully
  // when the location is unknown.
  if (scene?.location_id && locationBible?.locations) {
    const loc = locationBible.locations.find(l => l.id === scene.location_id);
    if (loc?.scene_master_url) refs.push(loc.scene_master_url);
    if (Array.isArray(loc?.reference_urls)) refs.push(...loc.reference_urls.slice(0, 1));
  }

  // 4. Scene Master — the canonical scene look
  if (scene?.scene_master_url) {
    refs.push(scene.scene_master_url);
  }

  // 5. Previous beat endframe — frame-level continuity
  if (previousBeat?.endframe_url) {
    refs.push(previousBeat.endframe_url);
  }

  // Dedupe (in case same URL appears from multiple sources)
  const seen = new Set();
  const deduped = refs.filter(url => {
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  });

  // Cap at 7 for Kling's limit
  return deduped.slice(0, 7);
}

// ─────────────────────────────────────────────────────────────────────
// Persona-Locked First Frame (Veo identity anchor)
// ─────────────────────────────────────────────────────────────────────

/**
 * Build a persona-locked first frame for a Veo beat.
 *
 * Veo 3.1's API rejects reference images — it only accepts text + first/last
 * frame URLs. That means REACTION / B_ROLL / VOICEOVER_OVER_BROLL beats that
 * feature a persona had zero identity anchoring, producing drifting faces
 * across beats ("characters appear out of thin air").
 *
 * The fix is to synthesize a 9:16 still via Seedream that shows the required
 * persona(s) inside the scene master's look at the beat's emotional/blocking
 * state, and feed that still as Veo's first_frame. Veo then propagates the
 * locked identity forward for its clip duration while preserving its native
 * ambient audio and cinematic camera motion.
 *
 * This is architecturally consistent with Scene Master generation — same
 * Seedream endpoint, same reference-stack pattern — so identity fidelity is
 * at least as good as the Scene Master we already trust.
 *
 * @param {Object} params
 * @param {Object[]} params.personas - the persona objects featured in this beat
 * @param {Object} [params.scene] - { scene_master_url, scene_master_prompt, ... }
 * @param {Object} [params.previousBeat] - { endframe_url }
 * @param {string[]} [params.subjectReferenceImages] - subject refs for location anchoring
 * @param {Object} params.beat - the beat itself (for visual_prompt / expression / blocking)
 * @param {string} [params.visualStylePrefix]
 * @param {Function} params.uploadBuffer - (buffer, subfolder, filename, mimeType) => Promise<publicUrl>
 * @param {number} [params.seed]
 * @returns {Promise<{first_frame_url: string, refs_used: string[], prompt: string}>}
 */
export async function buildPersonaLockedFirstFrame({
  personas,
  scene,
  previousBeat,
  subjectReferenceImages = [],
  beat,
  visualStylePrefix = '',
  // V4 Phase 7 — same style branching as generateSceneMasters. Non-photoreal
  // briefs swap the photoreal "preserve EXACT facial structure" identity
  // directive for an archetype-preserving directive.
  commercialBrief = null,
  uploadBuffer,
  seed,
  // 2026-05-01 — Director Agent verdict A1.1 (Rec 1 amendment).
  // Optional textual posture directive that REPLACES the default
  // head-and-shoulders portrait composition language. Set to a kinetic
  // posture (e.g. "mid-action posture: weight already shifted, one foot
  // off ground, hand mid-arc, torso pre-rotated. NOT a portrait.") for
  // ACTION_NO_DIALOGUE beats so Veo's first frame reads as 1/24th of a
  // second already in motion (Drive elevator-fight ignition), not a
  // yearbook photo. Defaults to null = portrait composition (current
  // behavior for REACTION/INSERT/B_ROLL/VO_BROLL).
  postureDirective = null
}) {
  if (!Array.isArray(personas) || personas.length === 0) {
    throw new Error('buildPersonaLockedFirstFrame: at least one persona required');
  }
  if (!beat) throw new Error('buildPersonaLockedFirstFrame: beat required');
  if (!uploadBuffer) throw new Error('buildPersonaLockedFirstFrame: uploadBuffer helper required');

  // Ref stack for the Seedream call: persona sheets + scene master + prior endframe.
  // Subject refs added when the beat is subject-anchored (e.g. B_ROLL of a building
  // with an agent standing in it).
  const refs = [];
  // V4 Phase 9 identity lock — prefer the Canonical Identity Portrait (CIP)
  // set when the persona has been canonicalized. CIP is 3 neutral-lit views
  // (front, 3/4 left, 3/4 right) of ONE consistent face, harmonized from the
  // user's diverse uploads. It eliminates the "averaged across different
  // magazine shots" drift. When no CIP exists (legacy personas / opt-out),
  // fall back to the first 3 reference_image_urls.
  for (const p of personas) {
    const cip = Array.isArray(p?.canonical_identity_urls) ? p.canonical_identity_urls : null;
    if (cip && cip.length > 0) {
      refs.push(...cip.slice(0, 3));
    } else if (p?.reference_image_urls?.length) {
      refs.push(...p.reference_image_urls.slice(0, 3));
    }
  }
  if (scene?.scene_master_url) refs.push(scene.scene_master_url);
  if (previousBeat?.endframe_url) refs.push(previousBeat.endframe_url);
  if (beat?.subject_present === true && Array.isArray(subjectReferenceImages)) {
    refs.push(...subjectReferenceImages.slice(0, 1));
  }

  // Dedupe + cap at Seedream's 10 limit
  const seen = new Set();
  const refsCapped = refs.filter(u => u && !seen.has(u) && seen.add(u)).slice(0, 10);

  // Compose a prompt that explicitly describes the persona in the scene at
  // the emotional/blocking state of THIS beat. Seedream conditions on both
  // text + refs, so the textual persona name + state is important.
  const personaDescriptor = personas
    .map(p => {
      const nameFragment = p?.name ? p.name : 'the character';
      const appearance = p?.appearance || p?.character_sheet?.appearance || '';
      return appearance ? `${nameFragment} (${appearance})` : nameFragment;
    })
    .join(' and ');

  const sceneLook = scene?.scene_master_prompt
    || beat?.environment
    || scene?.scene_visual_anchor_prompt
    || 'cinematic scene';

  const blocking = beat?.blocking_notes
    || beat?.action_notes
    || '';
  const expression = beat?.expression_notes
    || beat?.emotion
    || '';
  const beatVisual = beat?.visual_prompt || '';

  // V4 Phase 9 — explicit vertical + identity directives in the pre-pass prompt.
  // The resulting Seedream panel becomes Veo's first_frame, so any drift here
  // propagates into the animated beat. Worth the prompt bloat.
  //
  // V4 Phase 7 — identity directive split (same logic as generateSceneMasters).
  // Non-photoreal styles get archetype-preserving language; photoreal stays
  // on the existing facial-structure language.
  // 2026-05-01 — A1.1: when caller passes a postureDirective, replace the
  // default portrait composition language with kinetic-posture language.
  // ACTION beats ride this branch; REACTION/INSERT/B_ROLL/VO_BROLL keep the
  // default portrait (which is correct for those beat types).
  const verticalDirective = postureDirective
    ? `VERTICAL 9:16 composition. ${postureDirective} Character fills the vertical axis. No letterbox, no wide cinemascope framing. Social-media vertical.`
    : 'VERTICAL 9:16 portrait composition. Character fills the vertical axis (head-and-shoulders to waist-up). ' +
      'No letterbox, no wide cinemascope framing. Social-media vertical.';
  let identityDirective;
  if (isStylizedStrong(commercialBrief)) {
    const styleCategory = resolveStyleCategory(commercialBrief);
    identityDirective =
      `Identity anchoring (${styleCategory} stylization): preserve the CHARACTER ARCHETYPE — ` +
      'silhouette, hair shape, wardrobe motif, signature accessory. ' +
      'Stylized rendering, not photographic likeness. ' +
      'The reference images describe the actor; render the actor reinterpreted in ' +
      `${styleCategory} grammar — same archetype across shots.`;
  } else if (isNonPhotorealStyle(commercialBrief)) {
    const styleCategory = resolveStyleCategory(commercialBrief);
    identityDirective =
      `Identity anchoring (${styleCategory} stylized look): preserve recognizable facial structure ` +
      'consistent with the reference images, allowing for the art-direction interpretation in lighting, ' +
      'grade, and texture. Same person, same face; rendering style follows the brief.';
  } else {
    identityDirective =
      'Identity anchoring: preserve EXACT facial structure from reference images — ' +
      'inter-ocular distance, nose geometry, jawline, lip shape, brow arch, ear placement. ' +
      'Hair / makeup / wardrobe / lighting may vary per scene but facial bone structure is INVARIANT. ' +
      'Same person, same face, same age. Reference images are the canonical identity anchor.';
  }

  // 2026-04-25 — subject mention disabled by default. The textual nudge in
  // the Seedream pre-pass prompt was over-steering the panel — Seedream
  // would build the entire frame around the subject rather than the persona,
  // which then propagated into Veo as a subject-centric beat (not the
  // persona moment the screenplay intended). The subject ref image stays in
  // refsCapped so it's still available as visual influence; we just don't
  // call it out textually anymore. To re-enable: V4_PERSONA_LOCK_SUBJECT_MENTION=true.
  const subjectMention = (
    process.env.V4_PERSONA_LOCK_SUBJECT_MENTION === 'true' &&
    beat?.subject_present === true &&
    subjectReferenceImages.length > 0
  )
    ? `${beat.subject_focus || 'the subject'} is visible in the scene — maintain its exact appearance from reference images.`
    : '';

  const promptParts = [
    verticalDirective,
    identityDirective,
    visualStylePrefix,
    `${personaDescriptor} in the scene look: ${sceneLook}.`,
    blocking ? `Blocking: ${blocking}.` : '',
    expression ? `Expression: ${expression}.` : '',
    beatVisual,
    subjectMention,
    'Cinematic composition, lighting and palette consistent with the scene master.'
  ].filter(Boolean).join(' ');

  // Lazy-import the singleton to avoid a circular require if helpers run during bootstrap
  const { default: seedreamService } = await import('../SeedreamFalService.js');

  const panel = await seedreamService.generatePanel({
    prompt: promptParts,
    referenceImages: refsCapped,
    options: {
      aspectRatio: '9:16',
      size: '3K',
      seed: typeof seed === 'number' ? seed : Math.floor(Math.random() * 1_000_000),
      sequentialGeneration: 'auto'
    },
    label: 'persona-lock'
  });

  const beatId = beat?.beat_id || 'unknown';
  const publicUrl = await uploadBuffer(
    panel.imageBuffer,
    'storyboard/persona-locks',
    `beat-${beatId}-persona-lock.png`,
    'image/png'
  );

  return {
    first_frame_url: publicUrl,
    refs_used: refsCapped,
    prompt: promptParts
  };
}

// ─────────────────────────────────────────────────────────────────────
// Scene-Integrated Product Lock (SIPL) — V4 Phase 9
// ─────────────────────────────────────────────────────────────────────

/**
 * V4 Phase 9 — Scene-Integrated Product Lock (per Director's notes 2026-04-23).
 *
 * The Problem: INSERT_SHOT beats feed the user's pristine product reference
 * image (studio white / gravel) directly as Veo's first_frame. Veo animates
 * from there and produces a beat where the product appears in studio limbo
 * mid-story — visually disconnected from the brutalist concrete safehouse
 * (or whatever the scene world actually looks like). That's an infomercial
 * grammar break — "and now, a word about the product" — the diegetic
 * contract is shattered.
 *
 * The Fix: Seedream pre-pass that COMPOSITES the subject (from uploaded
 * product refs) INTO the scene master's environment. Output is a still of
 * the product sitting on the actual scene surface, under the actual scene
 * lighting, in the actual scene color palette. That still becomes Veo's
 * first_frame. Veo then can't drift back to studio — it's rendering FROM
 * an already-integrated frame.
 *
 * This is architecturally identical to `buildPersonaLockedFirstFrame` —
 * same pre-pass pattern, same Seedream dependency, same caching via
 * beat.scene_integrated_product_frame_url. "Lock upstream, render
 * downstream" is the V4 core philosophy.
 *
 * @param {Object} params
 * @param {string[]} params.subjectReferenceImages - user-uploaded product photos
 * @param {Object} params.scene - { scene_master_url, scene_master_prompt, scene_visual_anchor_prompt }
 * @param {Object} params.beat - { beat_id, subject_focus, camera_move, lighting_intent }
 * @param {string} [params.visualStylePrefix]
 * @param {Function} params.uploadBuffer
 * @param {number} [params.seed]
 * @returns {Promise<{first_frame_url: string, refs_used: string[], prompt: string} | null>}
 */
export async function buildSceneIntegratedProductFrame({
  subjectReferenceImages,
  scene,
  beat,
  visualStylePrefix = '',
  uploadBuffer,
  seed,
  intent = 'hero'  // 'hero'    → product fills 60% of frame (INSERT_SHOT macro)
                   // 'ambient' → subject visible in scene as supporting element (legacy, env-gated)
                   // 'natural' → subject placed in scene with NO compositional emphasis (default for B_ROLL / VO_BROLL when subject_focus is set)
}) {
  if (!Array.isArray(subjectReferenceImages) || subjectReferenceImages.length === 0) {
    return null;
  }
  if (!uploadBuffer) {
    throw new Error('buildSceneIntegratedProductFrame: uploadBuffer helper required');
  }

  // Ref stack for SIPL — product refs are TOP priority (preserve exact
  // industrial design), scene master is second priority (preserve environment
  // lighting / palette / materials). We prefer 2 product refs so Seedream sees
  // multiple angles of the subject; 1 scene master is enough for environment.
  const refs = [];
  refs.push(...subjectReferenceImages.slice(0, 3));
  if (scene?.scene_master_url) refs.push(scene.scene_master_url);
  const seen = new Set();
  const refsCapped = refs.filter(u => u && !seen.has(u) && seen.add(u)).slice(0, 10);

  if (refsCapped.length === 0) return null;

  const subjectFocus = beat?.subject_focus || 'the subject';
  const cameraMove = beat?.camera_move || 'overhead three-quarter angle looking down at the object';
  const lightingIntent = beat?.lighting_intent || 'match scene lighting exactly';
  const sceneLook = scene?.scene_master_prompt
    || scene?.scene_visual_anchor_prompt
    || scene?.location
    || 'the scene environment';
  const beatVisual = beat?.visual_prompt || '';

  // Two distinct Seedream prompt strategies depending on intent:
  //
  //   'hero'    → INSERT_SHOT macro. Product is the primary subject: centered,
  //               60% frame width, foregrounded, full materiality emphasis.
  //               This is the existing SIPL path (unchanged behavior).
  //
  //   'ambient' → Subject visible inside the scene as a supporting element.
  //               NOT the hero — it occupies 20-35% of frame, sits naturally
  //               in the environment. Maintains EXACT appearance (logo, color,
  //               proportions) but doesn't dominate the composition. Used for
  //               B_ROLL and VOICEOVER_OVER_BROLL beats where the subject
  //               should be "in the world" without upstaging the atmosphere.
  let promptParts;
  if (intent === 'natural') {
    // Non-invasive subject anchoring — terse prompt with NO compositional
    // emphasis. Used on Veo B_ROLL / VOICEOVER_OVER_BROLL when the screenplay
    // explicitly sets subject_focus. Avoids the noir/surveillance-coded
    // language that trips Vertex's image classifier on the 'hero' intent.
    promptParts = [
      `Place ${subjectFocus} naturally into the existing scene: ${sceneLook}.`,
      'Preserve exact appearance from reference images — same design, logo, color, proportions.',
      'Match scene lighting and color grade exactly.',
      'No compositional emphasis. Subject sits in the world as a naturally occurring element, not centered, not hero-framed.',
      visualStylePrefix
    ].filter(Boolean).join(' ');
  } else if (intent === 'ambient') {
    promptParts = [
      'Scene-integrated subject presence.',
      `${subjectFocus} (from reference images — preserve exact industrial design, logo, color, and proportions) appears naturally within the scene: ${sceneLook}.`,
      'Subject is visible but NOT the primary focus — a supporting element in the environment.',
      'Maintain EXACT appearance from reference images: same design, same logo, same color, same proportions.',
      'Subject occupies 20-35% of frame. Scene composition and scale remain natural.',
      'Match the scene\'s lighting exactly — same direction, hardness, color temperature, and shadow fall-off.',
      'Match the scene\'s color grade and palette exactly.',
      visualStylePrefix,
      beatVisual,
      'Photorealistic, cinematic. Reference images 1-3 are the subject (preserve exactly). Scene master is the environment.',
      'NO studio white backgrounds, NO studio gravel, NO isolation. Subject is IN-WORLD as a naturally placed element.'
    ].filter(Boolean).join(' ');
  } else {
    // 'hero' — existing INSERT_SHOT behavior (every phrase is load-bearing)
    promptParts = [
      'Scene-integrated product still.',
      `Place ${subjectFocus} (from reference images — preserve exact industrial design, logo, proportions, and color) onto the surface of ${sceneLook}.`,
      'Match the scene\'s lighting exactly — same direction, hardness, color temperature, and shadow fall-off as the scene master.',
      'Match the scene\'s color grade and palette exactly.',
      'Product is IN-WORLD, not studio-lit. Product surface reflects the actual environment, not a studio softbox.',
      `Camera: ${cameraMove}.`,
      `Lighting: ${lightingIntent} (inherited from the scene master).`,
      'VERTICAL 9:16 still frame. Product centered, filling 60% of frame width. Environmental surface texture visible above and below. Tactile materiality.',
      visualStylePrefix,
      beatVisual,
      'Photorealistic, cinematic, high detail. Reference image 1 is the product (preserve exactly). The scene master reference is the environment (preserve lighting, palette, materials).',
      'NO studio white backgrounds, NO studio gravel, NO isolation — the product must sit inside the scene\'s actual world.'
    ].filter(Boolean).join(' ');
  }

  // Lazy-import Seedream singleton (same pattern as persona-lock)
  const { default: seedreamService } = await import('../SeedreamFalService.js');

  const panel = await seedreamService.generatePanel({
    prompt: promptParts,
    referenceImages: refsCapped,
    options: {
      aspectRatio: '9:16',
      size: '3K',
      seed: typeof seed === 'number' ? seed : Math.floor(Math.random() * 1_000_000),
      sequentialGeneration: 'auto'
    },
    label: intent === 'ambient' ? 'SIPL-ambient' : (intent === 'natural' ? 'SIPL-natural' : 'SIPL-hero')
  });

  const beatId = beat?.beat_id || 'unknown';
  const subfolder = intent === 'ambient'
    ? 'storyboard/subject-ambient'
    : (intent === 'natural' ? 'storyboard/subject-natural' : 'storyboard/product-locks');
  const filename = intent === 'ambient'
    ? `beat-${beatId}-subject-ambient.png`
    : (intent === 'natural'
      ? `beat-${beatId}-subject-natural.png`
      : `beat-${beatId}-product-lock.png`);
  const publicUrl = await uploadBuffer(
    panel.imageBuffer,
    subfolder,
    filename,
    'image/png'
  );

  return {
    first_frame_url: publicUrl,
    refs_used: refsCapped,
    prompt: promptParts
  };
}

// ─────────────────────────────────────────────────────────────────────
// Endframe extraction (the continuity machine)
// ─────────────────────────────────────────────────────────────────────

/**
 * Extract the last frame from a video buffer using ffmpeg.
 *
 * Two-step strategy (verified via Day 0 smoke test against real Kling output):
 *   1. Probe duration with ffprobe
 *   2. Seek FROM START to (duration - 0.08) with -ss, extract one frame
 *
 * This replaces the simpler -sseof -0.04 approach, which fails on Kling's
 * output because:
 *   a) -sseof reads past EOF when the file duration has sub-frame precision
 *      (Kling mp4s frequently report e.g. 3.041667s) → 0 frames captured
 *   b) -sseof + mjpeg encoder trips on Kling's non-standard YUV range unless
 *      -pix_fmt yuvj420p is forced
 *
 * The forward-seek approach is rock-solid across all V4 source models
 * (Kling O3 Omni, Kling V3 Pro, Sync Lipsync v3, Veo 3.1 Vertex, OmniHuman).
 * Validated on Day 0.
 *
 * @param {Buffer} videoBuffer - mp4 buffer from any beat generator
 * @returns {Promise<Buffer>} JPG buffer of the last frame (full-range YUV)
 */
export async function extractBeatEndframe(videoBuffer) {
  if (!videoBuffer || !Buffer.isBuffer(videoBuffer)) {
    throw new Error('extractBeatEndframe: videoBuffer (Buffer) required');
  }

  const tmpDir = os.tmpdir();
  const runId = crypto.randomBytes(4).toString('hex');
  const mp4Path = path.join(tmpDir, `v4-endframe-src-${runId}.mp4`);
  const jpgPath = path.join(tmpDir, `v4-endframe-out-${runId}.jpg`);

  try {
    fs.writeFileSync(mp4Path, videoBuffer);

    // Step 1: probe duration
    let durationSec;
    try {
      const probeOut = execFileSync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        mp4Path
      ], { encoding: 'utf-8' });
      durationSec = parseFloat(probeOut.trim());
      if (!isFinite(durationSec) || durationSec <= 0) {
        throw new Error(`ffprobe returned invalid duration: "${probeOut.trim()}"`);
      }
    } catch (probeErr) {
      throw new Error(`extractBeatEndframe: ffprobe failed — ${probeErr.message}`);
    }

    // Step 2: seek from start to (duration - 0.08) so we land safely inside
    // the last rendered frame without risking EOF read-past.
    // 0.08s offset handles 24fps (~0.042s/frame), 30fps (~0.033s/frame),
    // and 60fps (~0.017s/frame) with a safety margin.
    //
    // Phase 1.5 — fail-loud + retry: silently returning a null endframe
    // breaks continuity for the NEXT beat (which falls back to scene master
    // and loses the frame-level visual link). We now retry with progressively
    // larger seek offsets before giving up. If the video is intact, one of
    // these offsets will land on a non-black, non-corrupt frame. The caller
    // can still catch and fall back to scene master, but most real failures
    // now resolve on the first retry.
    const SEEK_OFFSETS = [0.08, 0.15, 0.25, 0.40];
    let lastError = null;
    for (const offset of SEEK_OFFSETS) {
      const seekSec = Math.max(0, durationSec - offset);
      try {
        execFileSync('ffmpeg', [
          '-y',
          '-ss', seekSec.toFixed(3),
          '-i', mp4Path,
          '-frames:v', '1',
          '-update', '1',
          '-pix_fmt', 'yuvj420p',
          '-q:v', '2',
          jpgPath
        ], { stdio: ['ignore', 'ignore', 'pipe'] });

        const jpgBuffer = fs.readFileSync(jpgPath);
        if (!jpgBuffer || jpgBuffer.length < 2000) {
          // JPG under ~2KB is almost always a single-color (often black) frame
          // from a bad seek — retry with larger offset.
          lastError = new Error(
            `extractBeatEndframe: suspicious output (${jpgBuffer?.length || 0} bytes) at offset ${offset}s`
          );
          continue;
        }
        return jpgBuffer;
      } catch (err) {
        lastError = err;
        // fall through to next offset
      }
    }
    // All retry offsets failed — surface the real error
    throw new Error(
      `extractBeatEndframe: all ${SEEK_OFFSETS.length} seek offsets failed — ${lastError?.message || 'unknown'}`
    );
  } finally {
    try { if (fs.existsSync(mp4Path)) fs.unlinkSync(mp4Path); } catch {}
    try { if (fs.existsSync(jpgPath)) fs.unlinkSync(jpgPath); } catch {}
  }
}

// ─────────────────────────────────────────────────────────────────────
// Veo tier 2.5 — safe-mode first-frame regeneration
// ─────────────────────────────────────────────────────────────────────

/**
 * Regenerate a Veo first frame using a minimal, safe-mode Seedream pass.
 * Called by VeoService's tier 2.5 path when Vertex rejects a persona-lock
 * or product-lock first frame with an IMAGE content violation. The goal is
 * to preserve persona/product visual identity on the retry while reducing
 * the likelihood of triggering Vertex's image-safety filter a second time.
 *
 * Safe-mode strategy:
 *   - Use ONLY the CIP front view (persona) or the first product image
 *     (product) as the reference — drops scene master and additional refs
 *     that may compound into a safety-sensitive composition.
 *   - Append explicit safe-mode composition directives to the prompt:
 *     neutral pose, conservative framing, studio-clean background.
 *   - Use a fresh random seed (distinct from the original persona-lock seed).
 *   - No SIPL compositing — the frame is a clean, standalone reference.
 *
 * @param {Object} params
 * @param {'persona' | 'product'} params.kind        - which reference type to regenerate
 * @param {Object[]} [params.personas]               - persona bibles (for kind='persona')
 * @param {string[]} [params.subjectReferenceImages] - product URLs (for kind='product')
 * @param {Object} params.beat                        - beat record (for beat_id + prompt context)
 * @param {Function} params.uploadBuffer              - (buffer, path, filename, mime) → publicUrl
 * @returns {Promise<string | null>} public URL of the safer first frame, or null on failure
 */
export async function regenerateSafeFirstFrame({
  kind,
  personas = [],
  subjectReferenceImages = [],
  beat,
  uploadBuffer
}) {
  if (!beat) throw new Error('regenerateSafeFirstFrame: beat required');
  if (!uploadBuffer) throw new Error('regenerateSafeFirstFrame: uploadBuffer required');

  // Minimal reference stack: single cleanest ref image only.
  let safeRefs = [];
  if (kind === 'persona') {
    const p = personas[0];
    const cip = Array.isArray(p?.canonical_identity_urls) ? p.canonical_identity_urls : null;
    const cipFront = cip?.[0] || p?.reference_image_urls?.[0] || null;
    if (cipFront) safeRefs = [cipFront];
  } else if (kind === 'product') {
    const first = subjectReferenceImages[0] || null;
    if (first) safeRefs = [first];
  }

  if (safeRefs.length === 0) return null; // no reference to work from

  // Safe-mode prompt: conservative composition that avoids common filter triggers
  // (exposed skin, aggressive expressions, suggestive poses, tight body crops).
  const safeDirective =
    'SAFE MODE: neutral pose, eyes-on-camera, conservative professional framing, ' +
    'no body parts focus, no exposed skin, fully clothed, clean studio background, ' +
    'professional headshot composition, VERTICAL 9:16 portrait.';

  const entityDescriptor = kind === 'persona'
    ? (() => {
        const p = personas[0];
        const name = p?.name || 'the character';
        const appearance = p?.appearance || p?.character_sheet?.appearance || '';
        return appearance ? `${name} (${appearance})` : name;
      })()
    : (beat?.subject_focus || 'the product');

  const prompt = [
    safeDirective,
    `${entityDescriptor}, neutral expression, front-facing.`,
    'Cinematic still, clean background.'
  ].join(' ');

  const { default: seedreamService } = await import('../SeedreamFalService.js');

  const panel = await seedreamService.generatePanel({
    prompt,
    referenceImages: safeRefs,
    options: {
      aspectRatio: '9:16',
      size: '3K',
      seed: Math.floor(Math.random() * 1_000_000), // always a fresh seed
      sequentialGeneration: 'auto'
    },
    label: `${kind}-lock-safe-regen`
  });

  const beatId = beat?.beat_id || 'unknown';
  return uploadBuffer(
    panel.imageBuffer,
    'storyboard/persona-locks',
    `beat-${beatId}-${kind}-lock-safe.png`,
    'image/png'
  );
}
