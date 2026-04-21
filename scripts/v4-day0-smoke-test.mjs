#!/usr/bin/env node
/**
 * V4 Phase 1a Day 0 Smoke Test
 *
 * Validates the 7 Day 0 blockers from sunny-wishing-teacup.md before ANY beat
 * generator or BeatRouter code is written. Run this FIRST after the fal.ai
 * foundation services are in place.
 *
 * Day 0 blockers:
 *   1. Mode B end-to-end (Kling O3 Omni Standard → Sync Lipsync v3) ⭐ most important
 *   2. Sync Lipsync v3 standalone (Veo talking shot → Sync v3 relipsync)
 *   3. Kling O3 Omni non-dialogue smoke (5 action/B-roll scenes)
 *   4. OmniHuman 1.5 smoke (Mode A fallback viability)
 *   5. Veo 3.1 Fast tier toggle verification
 *   6. Endframe extraction sanity (20 test beats)
 *   7. fal.ai Kling Elements 3.0 preflight shape verification
 *
 * Usage:
 *   node scripts/v4-day0-smoke-test.mjs --test modeB
 *   node scripts/v4-day0-smoke-test.mjs --test sync
 *   node scripts/v4-day0-smoke-test.mjs --test kling-action
 *   node scripts/v4-day0-smoke-test.mjs --test omnihuman
 *   node scripts/v4-day0-smoke-test.mjs --test veo-tiers
 *   node scripts/v4-day0-smoke-test.mjs --test endframe
 *   node scripts/v4-day0-smoke-test.mjs --test elements
 *   node scripts/v4-day0-smoke-test.mjs --test all
 *
 * Requirements:
 *   - FAL_GCS_API_KEY set in .env (V4 credential)
 *   - ELEVENLABS_API_KEY set in .env
 *   - A test persona image URL + subject image URL (passed via --persona and --subject flags
 *     OR hardcoded in the SAMPLE_ASSETS block below before running)
 *
 * Output: writes all generated clips to /tmp/v4-day0/ so you can eyeball them.
 * Each clip is named so the filename tells you which test produced it.
 */

import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { execFileSync } from 'child_process';

// Load .env before importing services (they read env at construction time)
dotenv.config();

import klingFalService from '../services/KlingFalService.js';
// V4 routes Veo through Vertex AI (FREE under GCP quota), NOT fal.ai.
// The old fal.ai wrapper still exists on disk but is dead code — deleted in Phase 1c cleanup.
import veoService from '../services/VeoService.js';
import syncLipsyncFalService from '../services/SyncLipsyncFalService.js';
import seedreamFalService from '../services/SeedreamFalService.js';
import fluxFalService from '../services/FluxFalService.js';
import omniHumanService from '../services/OmniHumanService.js';
import ttsService from '../services/TTSService.js';
import musicService from '../services/MusicService.js';

// ─────────────────────────────────────────────────────────────────────
// Sample assets — replace with your own before running
// (These are placeholders; update to real public URLs when running.)
// ─────────────────────────────────────────────────────────────────────
const SAMPLE_ASSETS = {
  personaImageUrl: process.env.V4_SMOKE_PERSONA_URL || '',
  subjectImageUrl: process.env.V4_SMOKE_SUBJECT_URL || '',
  // V4_SMOKE_VOICE_ID is now a MANUAL OVERRIDE only. By default the Mode B
  // test calls the REAL V4 voice acquisition pipeline (services/v4/VoiceAcquisition.js)
  // to have Gemini pick the right ElevenLabs preset from the persona description.
  // Set this env var to skip voice casting and force a specific preset.
  testVoiceIdOverride: process.env.V4_SMOKE_VOICE_ID || null,
  // Dialogue tuned to ~6s speech (22 words) so the Mode B output has a real
  // window for eyeballing lip-sync + micro-expressions. Emotionally charged
  // so Sync Lipsync v3's mouth-shape precision matters.
  testDialogue: 'I kept telling myself I had more time, that the decision could wait. But standing here now, I finally understand it never could.',
  // The persona description fed to Gemini voice casting. This matches what the
  // real V4 pipeline emits from Brand Kit analysis — name + personality + role
  // + appearance. Gemini reads it and picks a gender/age-appropriate voice
  // from services/voice-library/elevenlabs-presets.json.
  testPersona: {
    name: 'Maya',
    role: 'contemplative protagonist',
    personality: 'introspective, guarded but emotionally honest when she chooses to speak, mid-30s warmth',
    appearance: 'mid-30s woman, thoughtful expression, natural warmth, approachable but reserved',
    description: 'A woman in her mid-30s who has been carrying a private decision for a long time. She finally speaks it out loud.'
  },
  testActionPrompt: 'A lone figure walks through a neon-lit alley at night, rain reflecting the signs, slow tracking shot alongside.',
  testSceneMasterPrompt: 'Wide establishing shot of a rooftop bar at golden hour, neon signage reflecting in rain-slicked tiles, warm amber key light with cool cyan fill, anamorphic lens feel, shallow DOF, Kodak Portra 400 grain.',
  testReactionFirstFrame: '', // fill with a public portrait URL
  testReactionLastFrame: ''   // fill with a public portrait URL (or leave blank for text-only fallback)
};

const OUTPUT_DIR = '/tmp/v4-day0';

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

async function ensureOutputDir() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
}

async function saveBuffer(buffer, filename) {
  const fullPath = path.join(OUTPUT_DIR, filename);
  await fs.writeFile(fullPath, buffer);
  console.log(`  → saved ${fullPath} (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`);
  return fullPath;
}

/**
 * Upload a buffer to Supabase Storage under v4-smoke-tests/ and return the
 * public URL. Used by the Mode B chain to make the TTS audio reachable by
 * fal.ai's Sync Lipsync v3 endpoint without the user having to manually host
 * the mp3 somewhere.
 */
async function uploadBufferToTempUrl(buffer, filename, contentType = 'audio/mpeg') {
  const { supabaseAdmin } = await import('../services/supabase.js');
  if (!supabaseAdmin) {
    throw new Error('Supabase admin client not configured — SUPABASE_URL + SUPABASE_SECRET_KEY required');
  }

  const storageKey = `v4-smoke-tests/runtime/${Date.now()}-${filename}`;
  const { error: uploadError } = await supabaseAdmin.storage
    .from('media-assets')
    .upload(storageKey, buffer, { contentType, upsert: true });
  if (uploadError) throw new Error(`Supabase upload failed: ${uploadError.message}`);

  const { data: urlData } = supabaseAdmin.storage
    .from('media-assets')
    .getPublicUrl(storageKey);

  console.log(`  ↑ uploaded to Supabase: ${urlData.publicUrl}`);

  // Also save a local copy for inspection
  const localPath = await saveBuffer(buffer, filename);
  return { localPath, publicUrl: urlData.publicUrl };
}

function preflightChecks() {
  const missing = [];
  if (!process.env.FAL_GCS_API_KEY && !process.env.FAL_API_KEY) {
    missing.push('FAL_GCS_API_KEY (or legacy FAL_API_KEY)');
  }
  if (!process.env.ELEVENLABS_API_KEY) missing.push('ELEVENLABS_API_KEY');
  if (missing.length) {
    console.error('❌ Missing env vars:', missing.join(', '));
    process.exit(1);
  }
  console.log('✅ Env preflight passed');
  console.log(`   FAL_GCS_API_KEY: ${process.env.FAL_GCS_API_KEY ? 'set' : 'not set (using legacy FAL_API_KEY)'}`);
  console.log(`   ELEVENLABS_API_KEY: set`);
}

function requireAsset(key) {
  if (!SAMPLE_ASSETS[key]) {
    console.error(`❌ Missing sample asset: ${key}`);
    console.error(`   Set V4_SMOKE_${key.toUpperCase().replace(/([A-Z])/g, '_$1').replace(/^_/, '')} in .env or hardcode in SAMPLE_ASSETS block`);
    process.exit(1);
  }
  return SAMPLE_ASSETS[key];
}

// ─────────────────────────────────────────────────────────────────────
// Test 1 — Mode B end-to-end (Kling O3 Omni → Sync Lipsync v3)
// The most important smoke test. Determines if V4's dialogue strategy works.
// ─────────────────────────────────────────────────────────────────────
async function testModeB() {
  console.log('\n━━━ Test 1: Mode B end-to-end (Kling O3 Omni → Sync Lipsync v3) ━━━');
  console.log('  Mode: Option B — real V4 voice casting via services/v4/VoiceAcquisition.js');
  const personaImageUrl = requireAsset('personaImageUrl');

  // Dynamically import V4 helpers so the script only pays the module-load
  // cost for the test path it's actually running.
  const { buildKlingElementsFromPersonas } = await import('../services/KlingFalService.js');
  const { acquirePersonaVoice, getVoiceLibrary } = await import('../services/v4/VoiceAcquisition.js');

  // ─── Stage 0 — V4 voice acquisition (the bug Option A would have missed) ───
  // In real V4, this runs at story creation for every persona. The smoke test
  // mirrors that exact path: pass Gemini the persona description, have it
  // pick the right ElevenLabs preset from the curated library, then use the
  // returned voice_id for the TTS call. This validates:
  //   1. Vertex Gemini is reachable + can read the curated voice library
  //   2. Gemini picks a voice that matches the persona's gender/age/personality
  //   3. The picked voice_id actually exists in the library and is usable by TTS
  //
  // An override env var (V4_SMOKE_VOICE_ID) is still supported for reruns
  // where you want to pin a specific voice and isolate the Kling→Sync chain
  // from the voice-picking step.
  let resolvedVoiceId;
  let resolvedVoiceMeta;
  if (SAMPLE_ASSETS.testVoiceIdOverride) {
    resolvedVoiceId = SAMPLE_ASSETS.testVoiceIdOverride;
    resolvedVoiceMeta = { voiceName: 'manual override', justification: 'V4_SMOKE_VOICE_ID env override' };
    console.log(`[Stage 0] voice override in env → skipping V4 voice acquisition`);
    console.log(`  voice_id: ${resolvedVoiceId}`);
  } else {
    console.log(`[Stage 0] V4 voice acquisition — persona "${SAMPLE_ASSETS.testPersona.name}"`);
    console.log(`  library size: ${getVoiceLibrary().length} curated ElevenLabs presets`);
    try {
      const voiceResult = await acquirePersonaVoice(SAMPLE_ASSETS.testPersona);
      resolvedVoiceId = voiceResult.voiceId;
      resolvedVoiceMeta = voiceResult;
      console.log(`  ✅ Gemini picked: ${voiceResult.voiceName} (${voiceResult.voiceId})`);
      console.log(`  brief: "${voiceResult.voiceBrief}"`);
      console.log(`  why: ${voiceResult.justification}`);
    } catch (err) {
      console.error(`  ❌ V4 voice acquisition failed: ${err.message}`);
      console.error(`     Stage 0 is a hard gate — skipping Stages A/B/C so the smoke test doesn't`);
      console.error(`     burn money generating a female persona with a fallback male voice.`);
      return;
    }
  }

  // Build the Kling elements[] array from the persona (frontal_image_url +
  // reference_image_urls). Real V4 has 3 character sheet views per persona;
  // for smoke we use the single seed image.
  const smokePersona = {
    name: SAMPLE_ASSETS.testPersona.name,
    reference_image_urls: [personaImageUrl, personaImageUrl]
  };
  const { elements } = buildKlingElementsFromPersonas([smokePersona]);

  // ─── Stage A — ElevenLabs TTS for the dialogue line in the resolved voice ───
  console.log('[Stage A] ElevenLabs TTS + Supabase upload...');
  const tts = await ttsService.synthesizeBeat({
    text: SAMPLE_ASSETS.testDialogue,
    voiceId: resolvedVoiceId,
    durationTarget: 6 // target ~6s so the eyeball window is meaningful
  });
  console.log(`  actualDurationSec: ${tts.actualDurationSec.toFixed(2)}`);
  const ttsUpload = await uploadBufferToTempUrl(tts.audioBuffer, 'modeB-01-tts-b.mp3', 'audio/mpeg');

  // ─── Stage B — Kling O3 Omni Standard with persona elements + dialogue prompt ───
  console.log('[Stage B] Kling O3 Omni Standard dialogue beat...');
  const klingPrompt = `@Element1 is a ${SAMPLE_ASSETS.testPersona.appearance}. She speaks to camera with quiet honesty and contemplative weight. Medium closeup, 85mm lens, shallow depth of field, warm key light from camera-left, soft bounce fill. Subtle breathing, micro-expressions of resignation and release. The character says: "${SAMPLE_ASSETS.testDialogue}"`;
  const kling = await klingFalService.generateDialogueBeat({
    startFrameUrl: personaImageUrl,
    elements,
    prompt: klingPrompt,
    options: {
      duration: Math.max(3, Math.min(8, Math.round(tts.actualDurationSec))),
      aspectRatio: '9:16',
      generateAudio: true
    }
  });
  await saveBuffer(kling.videoBuffer, 'modeB-02-kling-raw-b.mp4');
  console.log(`  kling video (fal.ai CDN, public): ${kling.videoUrl}`);

  // ─── Stage C — Sync Lipsync v3 corrective pass ───
  console.log('[Stage C] Sync Lipsync v3 corrective pass...');
  const sync = await syncLipsyncFalService.applyLipsync({
    videoUrl: kling.videoUrl,
    audioUrl: ttsUpload.publicUrl,
    options: { syncMode: 'cut_off' }
  });
  await saveBuffer(sync.videoBuffer, 'modeB-03-final-b.mp4');
  console.log(`  final video: ${sync.videoUrl}`);

  console.log('\n✅ Mode B chain complete (Option B path) — eyeball modeB-03-final-b.mp4');
  console.log(`   Voice cast: ${resolvedVoiceMeta.voiceName} (${resolvedVoiceId})`);
  console.log(`   Duration: ${tts.actualDurationSec.toFixed(1)}s (target 6s)`);
  console.log('\n   Decision gates:');
  console.log('   (a) Voice/persona gender match — is the voice female for a female persona?');
  console.log('   (b) Lip-sync accuracy after Sync v3 pass');
  console.log('   (c) Cinematic BG quality vs a static talking head');
  console.log('   (d) Identity preservation vs the seed image');
  console.log('   (e) Micro-expression believability (breathing, eye movement, subtle resignation)');
}

// ─────────────────────────────────────────────────────────────────────
// Test 2 — Sync Lipsync v3 standalone (separate from Kling)
// ─────────────────────────────────────────────────────────────────────
async function testSyncStandalone() {
  console.log('\n━━━ Test 2: Sync Lipsync v3 standalone ━━━');
  const sourceVideoUrl = process.env.V4_SMOKE_SOURCE_VIDEO_URL;
  const targetAudioUrl = process.env.V4_SMOKE_AUDIO_URL;

  if (!sourceVideoUrl || !targetAudioUrl) {
    console.log('  ⚠️  needs V4_SMOKE_SOURCE_VIDEO_URL (a talking video) + V4_SMOKE_AUDIO_URL (a different audio track)');
    console.log('  skipping');
    return;
  }

  const result = await syncLipsyncFalService.applyLipsync({
    videoUrl: sourceVideoUrl,
    audioUrl: targetAudioUrl
  });
  await saveBuffer(result.videoBuffer, 'sync-standalone.mp4');
  console.log('✅ Sync Lipsync v3 standalone complete');
}

// ─────────────────────────────────────────────────────────────────────
// Test 3 — Kling O3 Omni non-dialogue action beat
// ─────────────────────────────────────────────────────────────────────
async function testKlingAction() {
  console.log('\n━━━ Test 3: Kling O3 Omni action beat (non-dialogue) ━━━');
  const personaImageUrl = requireAsset('personaImageUrl');

  const result = await klingFalService.generateActionBeat({
    startFrameUrl: personaImageUrl,
    prompt: SAMPLE_ASSETS.testActionPrompt,
    options: {
      duration: 5,
      aspectRatio: '9:16',
      generateAudio: true
    }
  });
  await saveBuffer(result.videoBuffer, 'kling-action.mp4');
  console.log('✅ Kling V3 Pro action beat complete — validates ACTION_NO_DIALOGUE primary');
}

// ─────────────────────────────────────────────────────────────────────
// Test 4 — OmniHuman 1.5 Mode A smoke
// ─────────────────────────────────────────────────────────────────────
async function testOmniHuman() {
  console.log('\n━━━ Test 4: OmniHuman 1.5 Mode A fallback ━━━');
  const personaImageUrl = requireAsset('personaImageUrl');
  const audioUrl = process.env.V4_SMOKE_AUDIO_URL;

  if (!audioUrl) {
    console.log('  ⚠️  needs V4_SMOKE_AUDIO_URL (a public TTS mp3 URL)');
    console.log('  skipping');
    return;
  }

  const result = await omniHumanService.generateTalkingHead({
    imageUrl: personaImageUrl,
    audioUrl,
    options: {
      resolution: '720p',
      prompt: 'Character speaks with quiet intensity, warm key light, shallow DOF'
    }
  });
  await saveBuffer(result.videoBuffer, 'omnihuman-modeA.mp4');
  console.log('✅ OmniHuman Mode A complete — eyeball vs modeB-03-final.mp4 for quality comparison');
}

// ─────────────────────────────────────────────────────────────────────
// Test 5 — Veo 3.1 Standard via Vertex AI (FREE under the user's GCP quota)
//
// V4 routes Veo through Vertex AI, NOT fal.ai. Vertex only exposes one tier
// for Veo 3.1 Standard (veo-3.1-generate-001), so this test is a single call
// validating:
//   - GCP_PROJECT_ID + GOOGLE_APPLICATION_CREDENTIALS_JSON are configured
//   - Vertex LRO submission + polling works end-to-end
//   - First-frame anchoring (subject image) is accepted
//   - Native ambient audio is generated (Vertex Veo has this built-in)
//
// Output: /tmp/v4-day0/veo-vertex.mp4 (eyeball for quality + confirm audio track present)
// ─────────────────────────────────────────────────────────────────────
async function testVeoTiers() {
  console.log('\n━━━ Test 5: Veo 3.1 Standard via Vertex AI ━━━');

  if (!veoService.isAvailable()) {
    console.error('  ❌ VeoService: Vertex AI not configured');
    console.error('     Required env vars: GCP_PROJECT_ID + GOOGLE_APPLICATION_CREDENTIALS_JSON');
    return;
  }

  const subjectImageUrl = requireAsset('subjectImageUrl');

  console.log('[Vertex AI, first-frame anchored]');
  try {
    const result = await veoService.generateWithFrames({
      firstFrameUrl: subjectImageUrl,
      prompt: 'Slow dolly forward on the subject resting on a polished surface, soft golden key light with warm bounce fill, shallow depth of field, product photography cinematic feel',
      options: { duration: 4, aspectRatio: '9:16', generateAudio: true }
    });
    await saveBuffer(result.videoBuffer, 'veo-vertex.mp4');
    console.log(`  ✅ Vertex Veo model: ${result.model}, duration: ${result.duration}s`);
    console.log(`  → eyeball /tmp/v4-day0/veo-vertex.mp4 — expect clean motion + native ambient audio track`);
  } catch (err) {
    console.error(`  ❌ Vertex Veo failed: ${err.message}`);
    if (err.response?.data) {
      console.error(`     Response: ${JSON.stringify(err.response.data).slice(0, 400)}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Test 6 — Endframe extraction sanity
// ─────────────────────────────────────────────────────────────────────
async function testEndframeExtraction() {
  console.log('\n━━━ Test 6: Endframe extraction (production helper) ━━━');
  const testVideoPath = process.env.V4_SMOKE_TEST_VIDEO_PATH;

  if (!testVideoPath) {
    console.log('  ⚠️  set V4_SMOKE_TEST_VIDEO_PATH to a local mp4 file first');
    console.log('  (ideally a Mode B output like /tmp/v4-day0/modeB-03-final.mp4)');
    return;
  }

  // Test the ACTUAL production helper (services/v4/StoryboardHelpers.js)
  // instead of an inline ffmpeg call — that way we're validating the exact
  // code path the orchestrator uses.
  const { extractBeatEndframe } = await import('../services/v4/StoryboardHelpers.js');
  const fsNode = await import('fs');

  try {
    const videoBuffer = fsNode.readFileSync(testVideoPath);
    console.log(`  source: ${testVideoPath} (${(videoBuffer.length / (1024 * 1024)).toFixed(1)}MB)`);

    const start = Date.now();
    const jpgBuffer = await extractBeatEndframe(videoBuffer);
    const elapsed = ((Date.now() - start) / 1000).toFixed(2);

    const outPath = path.join(OUTPUT_DIR, 'endframe.jpg');
    await fs.writeFile(outPath, jpgBuffer);
    console.log(`  ✅ Extracted endframe: ${outPath} (${(jpgBuffer.length / 1024).toFixed(0)}KB, ${elapsed}s)`);
    console.log('  Decision gate: open the jpg — is it mid-gesture/mid-blink/mid-motion?');
    console.log('    - If clean → production helper is reliable');
    console.log('    - If mid-motion → bump the 0.08s offset higher or add candidate-frame classifier (Phase 2)');
  } catch (err) {
    console.error(`  ❌ extractBeatEndframe failed: ${err.message}`);
    if (err.stack) console.error(err.stack);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Test 7 — Kling Elements 3.0 preflight shape verification
// ─────────────────────────────────────────────────────────────────────
async function testKlingElements() {
  console.log('\n━━━ Test 7: Kling Elements 3.0 preflight ━━━');
  console.log('  ⚠️  Not implemented — KlingFalService.createVoice() and createElement()');
  console.log('      are stubbed pending fal.ai schema verification.');
  console.log('      Phase 1b task: check fal.ai documentation for:');
  console.log('        - voice creation endpoint slug');
  console.log('        - element creation endpoint slug');
  console.log('        - required fields (audio_sample_url? reference_images? voice_id?)');
  console.log('        - response shape (voice_id/element_id location)');
  console.log('  SKIPPED');
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const testArg = args.includes('--test') ? args[args.indexOf('--test') + 1] : 'all';

  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   V4 Phase 1a Day 0 Smoke Test              ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`Test: ${testArg}`);
  console.log(`Output dir: ${OUTPUT_DIR}`);

  preflightChecks();
  await ensureOutputDir();

  const tests = {
    modeB: testModeB,
    sync: testSyncStandalone,
    'kling-action': testKlingAction,
    omnihuman: testOmniHuman,
    'veo-tiers': testVeoTiers,
    endframe: testEndframeExtraction,
    elements: testKlingElements
  };

  if (testArg === 'all') {
    for (const [name, fn] of Object.entries(tests)) {
      try {
        await fn();
      } catch (err) {
        console.error(`\n❌ ${name} failed: ${err.message}`);
        if (err.stack) console.error(err.stack);
      }
    }
  } else if (tests[testArg]) {
    try {
      await tests[testArg]();
    } catch (err) {
      console.error(`\n❌ ${testArg} failed: ${err.message}`);
      if (err.stack) console.error(err.stack);
      process.exit(1);
    }
  } else {
    console.error(`Unknown test: ${testArg}`);
    console.error(`Available: ${Object.keys(tests).join(', ')}, all`);
    process.exit(1);
  }

  console.log('\n✅ Smoke test complete');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
