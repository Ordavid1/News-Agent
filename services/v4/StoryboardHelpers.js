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
import seedreamFalService from '../SeedreamFalService.js';

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
  userId,
  uploadBuffer,
  baseSeed
}) {
  if (!Array.isArray(scenes)) throw new Error('generateSceneMasters: scenes array required');
  if (!uploadBuffer) throw new Error('generateSceneMasters: uploadBuffer helper required');

  // Collect all persona reference images (character sheet views) into one flat list.
  // Seedream accepts up to 10 reference images — ordering matters because
  // Seedream weights earlier refs slightly higher.
  const personaRefs = personas
    .flatMap(p => p.reference_image_urls || [])
    .filter(Boolean);

  // Ordering by story focus: person → personas first, product → subject first
  const baseRefs = storyFocus === 'product'
    ? [...subjectReferenceImages, ...personaRefs]
    : [...personaRefs, ...subjectReferenceImages];

  const refsCapped = baseRefs.slice(0, 10); // Seedream limit

  const seed = baseSeed != null ? baseSeed : Math.floor(Math.random() * 1_000_000);

  // Generate all scene masters in parallel. Per-scene Seedream calls are
  // independent; failures are isolated to the one scene.
  const tasks = scenes.map(async (scene, i) => {
    if (scene.scene_master_url) {
      // Already has a master (resume path) — skip
      return;
    }

    const anchorPrompt = scene.scene_visual_anchor_prompt || scene.location || 'establishing shot';
    const fullPrompt = [visualStylePrefix, anchorPrompt].filter(Boolean).join('. ');

    try {
      const result = await seedreamFalService.generatePanel({
        prompt: fullPrompt,
        referenceImages: refsCapped,
        options: {
          aspectRatio: '9:16',
          size: '3K',
          seed: seed + i,
          sequentialGeneration: 'auto'
        }
      });

      const publicUrl = await uploadBuffer(
        result.imageBuffer,
        `storyboard/scene-masters`,
        `scene-${scene.scene_id || i}-master.png`,
        'image/png'
      );

      scene.scene_master_url = publicUrl;
      scene.scene_master_prompt = fullPrompt;
    } catch (err) {
      // Don't throw — Scene Master failure should not kill the whole episode.
      // The affected scene's beats will fall back to prior-beat endframes
      // or raw character sheets as their reference stack.
      scene.scene_master_error = err.message || String(err);
    }
  });

  await Promise.all(tasks);
}

// ─────────────────────────────────────────────────────────────────────
// Beat reference stack builder (Level 3 of the hierarchy)
// ─────────────────────────────────────────────────────────────────────

/**
 * Build the reference image stack for a single beat at generation time.
 *
 * Composition (ordered by priority — Kling/Veo weight earlier refs higher):
 *   1. Persona character sheets (for characters in this beat)
 *   2. Scene Master (for scene-level lighting/color/blocking)
 *   3. Previous beat endframe (for frame-level continuity)
 *
 * Capped at 7 (Kling's limit) — the most relevant refs win.
 *
 * @param {Object} params
 * @param {Object} params.beat
 * @param {Object} params.scene
 * @param {Object} [params.previousBeat]
 * @param {Object[]} params.personas
 * @returns {string[]} ordered list of reference image URLs
 */
export function buildBeatRefStack({ beat, scene, previousBeat, personas }) {
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
    if (persona?.reference_image_urls?.length) {
      // Add up to 2 views per persona (hero + closeup) — leaves room for other refs
      refs.push(...persona.reference_image_urls.slice(0, 2));
    }
  }

  // 2. Scene Master — the canonical scene look
  if (scene?.scene_master_url) {
    refs.push(scene.scene_master_url);
  }

  // 3. Previous beat endframe — frame-level continuity
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
    const seekSec = Math.max(0, durationSec - 0.08);

    execFileSync('ffmpeg', [
      '-y',
      '-ss', seekSec.toFixed(3),
      '-i', mp4Path,
      '-frames:v', '1',
      '-update', '1',
      '-pix_fmt', 'yuvj420p',  // force full-range YUV to avoid mjpeg encoder errors on Kling output
      '-q:v', '2',              // high-quality JPEG (1-31 scale, 2 is near-lossless)
      jpgPath
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    const jpgBuffer = fs.readFileSync(jpgPath);
    if (!jpgBuffer || jpgBuffer.length === 0) {
      throw new Error('extractBeatEndframe: ffmpeg produced empty output');
    }
    return jpgBuffer;
  } finally {
    try { if (fs.existsSync(mp4Path)) fs.unlinkSync(mp4Path); } catch {}
    try { if (fs.existsSync(jpgPath)) fs.unlinkSync(jpgPath); } catch {}
  }
}
