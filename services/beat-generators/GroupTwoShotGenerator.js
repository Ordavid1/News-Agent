// services/beat-generators/GroupTwoShotGenerator.js
// V4 GROUP_DIALOGUE_TWOSHOT beat generator.
//
// ⚠️ RARE — reserved for emotional peaks only. V4's default for multi-character
// dialogue is SHOT_REVERSE_SHOT (expanded to alternating closeups). Two-shots
// are used when the emotional payoff REQUIRES both faces in the same frame.
//
// Generates via Kling O3 Omni Standard with both personas in the reference
// stack + multi-shot mode + native audio. Sync Lipsync v3 post-pass runs
// over the combined dialogue audio.
//
// V4 Audio Layer Overhaul Day 2 — TWO Stage A paths:
//
//   PATH 1 (PREFERRED): eleven-v3 dialogue endpoint
//     Single call with both speakers; shared prosodic context — turn-taking,
//     response-to-emotion, natural breath rhythm are LEARNED across the
//     dialogue rather than stitched. One combined audio file out, fed
//     directly to Sync Lipsync v3. Runs when:
//       (a) deps.dialogueTTS is wired (BrandStoryService passes it),
//       (b) total dialogue chars ≤ 2,000,
//       (c) all speakers share a language,
//       (d) BRAND_STORY_DIALOGUE_ENDPOINT is not set to 'false' (rollback).
//
//   PATH 2 (FALLBACK): legacy parallel TTS + concat
//     Per-speaker TTS in parallel, time-aligned with 0.3s silence gap, fed
//     to Sync Lipsync v3 as a single combined track. Used when path 1 is
//     unavailable (no deps.dialogueTTS, char overflow, mixed-language,
//     rollback flag, or any path-1 failure). Preserves the pre-Day-2
//     behavior so retakes and tests work without the new service.
//
// If the sync pass fails, the generator returns the Kling-raw video with
// a warning — the beat is still usable, just with Kling's native lip-sync.

import BaseBeatGenerator from './BaseBeatGenerator.js';
import { buildKlingElementsFromPersonas, buildKlingSubjectElement } from '../KlingFalService.js';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const DIALOGUE_ENDPOINT_MAX_CHARS = 2000;
const NO_TAG_ANNOTATION_RE = /\[no_tag_intentional\s*:\s*[^\]]+\]\s*/gi;

/** Strip the internal `[no_tag_intentional: ...]` marker for char-count math. */
function _spokenCharLength(text) {
  if (!text || typeof text !== 'string') return 0;
  return text.replace(NO_TAG_ANNOTATION_RE, '').trim().length;
}

function isDialogueEndpointEnabled() {
  // Default ON. Set BRAND_STORY_DIALOGUE_ENDPOINT=false to revert the
  // GROUP_DIALOGUE_TWOSHOT path to the legacy parallel-TTS-concat behavior.
  return String(process.env.BRAND_STORY_DIALOGUE_ENDPOINT || 'true').toLowerCase() !== 'false';
}

/**
 * Phase 4.3 — time-align two speaker audio tracks into ONE mp3 that Sync
 * Lipsync v3 can correct in a single pass. Placeholder silence between the
 * two tracks preserves the natural beat pacing: speaker 1 speaks → short
 * breath → speaker 2 speaks. A 0.3s gap reads as a real conversational turn.
 *
 * Returns the merged mp3 Buffer; caller uploads and hands the URL to Sync v3.
 */
function concatSpeakerAudioBuffers(buffers, gapSec = 0.3) {
  if (!Array.isArray(buffers) || buffers.length === 0) {
    throw new Error('concatSpeakerAudioBuffers: at least one buffer required');
  }
  const tmpDir = os.tmpdir();
  const runId = crypto.randomBytes(4).toString('hex');
  const outPath = path.join(tmpDir, `v4-twoshot-audio-${runId}.mp3`);
  const partPaths = buffers.map((buf, i) =>
    path.join(tmpDir, `v4-twoshot-audio-${runId}-part${i}.mp3`)
  );

  try {
    // Write each TTS buffer to disk
    buffers.forEach((buf, i) => fs.writeFileSync(partPaths[i], buf));

    // Build ffmpeg filter graph: decode each part → insert silence gap → concat
    // Example for 2 speakers: [0:a][silence][1:a]concat=n=3:v=0:a=1
    const inputArgs = [];
    for (const p of partPaths) inputArgs.push('-i', p);
    // aevalsrc for silence: we generate a single silence input that we reuse
    inputArgs.push('-f', 'lavfi', '-i', `aevalsrc=0:d=${gapSec.toFixed(3)}`);

    const silenceIdx = partPaths.length;
    const segments = [];
    for (let i = 0; i < partPaths.length; i++) {
      segments.push(`[${i}:a]`);
      if (i < partPaths.length - 1) segments.push(`[${silenceIdx}:a]`);
    }
    const filter = `${segments.join('')}concat=n=${segments.length}:v=0:a=1[out]`;

    execFileSync('ffmpeg', [
      '-y',
      ...inputArgs,
      '-filter_complex', filter,
      '-map', '[out]',
      '-c:a', 'libmp3lame',
      '-q:a', '2',
      outPath
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    return fs.readFileSync(outPath);
  } finally {
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
    for (const p of partPaths) {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
    }
  }
}

const COST_KLING_OMNI_STANDARD_PER_SEC = 0.168;
const COST_SYNC_LIPSYNC_V3_FLAT = 0.50;
const COST_TTS_PER_CHAR = 0.0001;

class GroupTwoShotGenerator extends BaseBeatGenerator {
  static beatTypes() {
    return ['GROUP_DIALOGUE_TWOSHOT'];
  }

  static estimateCost(beat) {
    const duration = beat.duration_seconds || 6;
    const dialoguesChars = (beat.dialogues || []).reduce((n, d) => n + (d || '').length, 0);
    const klingCost = COST_KLING_OMNI_STANDARD_PER_SEC * duration;
    // Two sync passes × sync flat + two TTS renders
    return klingCost + (COST_SYNC_LIPSYNC_V3_FLAT * 2) + (COST_TTS_PER_CHAR * dialoguesChars);
  }

  async _doGenerate({ beat, scene, refStack, personas, episodeContext, previousBeat }) {
    const { kling, syncLipsync } = this.falServices;
    if (!kling) throw new Error('GroupTwoShotGenerator: kling service not in deps');
    if (!this.tts) throw new Error('GroupTwoShotGenerator: tts service not in deps');

    const personaIndexes = Array.isArray(beat.persona_indexes) ? beat.persona_indexes : [];
    if (personaIndexes.length < 2) {
      throw new Error(`beat ${beat.beat_id}: GROUP_DIALOGUE_TWOSHOT needs persona_indexes[] with at least 2 entries`);
    }
    const dialogues = Array.isArray(beat.dialogues) ? beat.dialogues : [];
    if (dialogues.length < 2) {
      throw new Error(`beat ${beat.beat_id}: GROUP_DIALOGUE_TWOSHOT needs dialogues[] with at least 2 entries`);
    }

    const resolvedPersonas = personaIndexes.map(i => personas[i]).filter(Boolean);
    if (resolvedPersonas.length < 2) {
      throw new Error(`beat ${beat.beat_id}: couldn't resolve both personas from indexes`);
    }

    const duration = beat.duration_seconds || 6;

    // Pre-flight per-speaker voice + language sanity (used by both Stage A paths).
    for (let i = 0; i < resolvedPersonas.length; i++) {
      if (!resolvedPersonas[i].elevenlabs_voice_id) {
        throw new Error(`beat ${beat.beat_id}: persona ${i} missing elevenlabs_voice_id`);
      }
    }
    if (!episodeContext?.uploadAudio) {
      throw new Error(`beat ${beat.beat_id}: episodeContext.uploadAudio required`);
    }

    // ─── Stage A — multi-speaker dialogue audio ───
    //
    // Decide which Stage A path to take. The dialogue endpoint is preferred
    // because it gives shared prosodic context (turn-taking, breath, response
    // to emotion). Per-beat single-speaker TTS is the fallback that preserves
    // legacy behavior when the endpoint is unavailable or overflows its limits.
    let combinedAudioUrl = null;
    let combinedAudioBuffer = null;
    let perSpeakerAudioUrls = []; // populated only on the fallback path
    let stageAPath = 'unknown';
    let dialogueEndpointAttempted = false;
    let dialogueEndpointError = null;

    // Total spoken chars across all speakers (after stripping internal markers).
    const totalSpokenChars = dialogues.reduce((n, d) => n + _spokenCharLength(d), 0);
    // All speakers must share a language for the dialogue endpoint (single
    // language_code per request).
    const personaLangs = new Set(resolvedPersonas.map(p => String(p.language || 'en').toLowerCase()));
    const sharedLanguage = personaLangs.size === 1 ? [...personaLangs][0] : null;

    const canUseDialogueEndpoint = !!this.dialogueTTS
      && this.dialogueTTS.isAvailable()
      && isDialogueEndpointEnabled()
      && totalSpokenChars > 0
      && totalSpokenChars <= DIALOGUE_ENDPOINT_MAX_CHARS
      && sharedLanguage !== null;

    if (canUseDialogueEndpoint) {
      dialogueEndpointAttempted = true;
      try {
        this.logger.info(
          `[${beat.beat_id}] Stage A: eleven-v3 dialogue endpoint — ${resolvedPersonas.length} speakers, ` +
          `${totalSpokenChars} chars, lang=${sharedLanguage}`
        );
        const dialogueInputs = resolvedPersonas.map((persona, i) => ({
          text: dialogues[i],
          voice: persona.elevenlabs_voice_id
        }));
        const dialogueResult = await this.dialogueTTS.synthesizeDialogue({
          inputs: dialogueInputs,
          options: {
            stability: 0.5,
            useSpeakerBoost: true,
            languageCode: sharedLanguage
          }
        });
        combinedAudioBuffer = dialogueResult.audioBuffer;
        combinedAudioUrl = await episodeContext.uploadAudio({
          buffer: combinedAudioBuffer,
          filename: `beat-${beat.beat_id}-dialogue.mp3`,
          mimeType: 'audio/mpeg'
        });
        // Per-speaker URLs intentionally empty — eleven-v3 dialogue returns
        // ONE combined file. Sync Lipsync v3 sees the whole exchange.
        stageAPath = 'dialogue_endpoint';
      } catch (err) {
        dialogueEndpointError = err.message;
        this.logger.warn(`[${beat.beat_id}] dialogue endpoint failed (${err.message}); falling back to per-speaker TTS + concat`);
      }
    } else if (this.dialogueTTS) {
      this.logger.info(
        `[${beat.beat_id}] dialogue endpoint NOT used — ` +
        `chars=${totalSpokenChars}/${DIALOGUE_ENDPOINT_MAX_CHARS}, ` +
        `langs=${[...personaLangs].join('|')}, ` +
        `enabled=${isDialogueEndpointEnabled()}, ` +
        `available=${this.dialogueTTS.isAvailable()}`
      );
    }

    // ─── Stage A FALLBACK — legacy parallel TTS + concat ───
    let ttsResults = null;
    if (stageAPath !== 'dialogue_endpoint') {
      this.logger.info(`[${beat.beat_id}] Stage A: TTS × ${resolvedPersonas.length} (parallel, fallback path)`);
      ttsResults = await Promise.all(
        resolvedPersonas.map((persona, i) =>
          this.tts.synthesizeBeat({
            text: dialogues[i],
            voiceId: persona.elevenlabs_voice_id,
            durationTarget: duration / 2,
            options: {
              language: persona.language || 'en'
            }
          })
        )
      );
      perSpeakerAudioUrls = await Promise.all(
        ttsResults.map((tts, i) => episodeContext.uploadAudio({
          buffer: tts.audioBuffer,
          filename: `beat-${beat.beat_id}-speaker${i}.mp3`,
          mimeType: 'audio/mpeg'
        }))
      );
      stageAPath = dialogueEndpointAttempted ? 'fallback_after_endpoint_failure' : 'fallback_per_beat_tts';
    }

    // Build the Kling two-shot prompt
    const stylePrefix = episodeContext?.visual_style_prefix || '';
    const blockingHint = beat.blocking_notes || 'Two characters in frame, eye-level medium two-shot';
    const emotionHint = beat.emotion ? ` ${beat.emotion} tone.` : '';
    const dialogueHint = dialogues
      .map((line, i) => `${resolvedPersonas[i].name || `Character ${i + 1}`} says: "${line}"`)
      .join(' ');
    // V4 subtext → facial direction (same routing as the closeup generator).
    // Two-shots carry the subtext of the whole exchange; Kling reads it as a
    // micro-tell on both faces.
    const subtextHint = beat.subtext
      ? ` Subtext (show on faces, not in voices): the surface lines differ from what they really mean — "${beat.subtext}". Let that truth surface as micro-expressions under the surface emotion.`
      : '';

    // See CinematicDialogueGenerator for the budget-allocation rationale —
    // Kling O3 Omni Standard truncates silently at 512 chars, so we drop
    // lower-priority sections rather than chopping mid-sentence. dialogueHint
    // is mandatory because it binds both character tokens to their lines.
    //
    // V4 Phase 9 — vertical framing + identity anchoring (condensed).
    // Two-shot vertical stacking is critical: characters must be arranged so
    // BOTH faces read in 9:16 (one slightly forward, one back — NOT side-by-side).
    const verticalDirective = 'VERTICAL 9:16 two-shot. Characters stacked for portrait: one slightly forward, one back. Both faces read.';
    const identityDirective = 'Preserve facial structure from refs. Each character matches own reference, no face-swap.';

    const KLING_PROMPT_BUDGET = 480;
    const directorNudge = (typeof beat?.director_nudge === 'string' && beat.director_nudge.trim().length > 0)
      ? `DIRECTOR'S NOTE (retake): ${beat.director_nudge.trim()}`
      : '';
    const twoShotSections = [
      { priority: 'mandatory', text: dialogueHint },
      { priority: 'mandatory', text: verticalDirective },
      { priority: 'mandatory', text: identityDirective },
      { priority: 'mandatory', text: blockingHint },
      { priority: 'high',      text: directorNudge },
      { priority: 'high',      text: subtextHint.trim() },
      { priority: 'medium',    text: emotionHint.trim() },
      { priority: 'low',       text: stylePrefix }
    ].filter(s => s.text && s.text.length > 0);

    const accepted = [];
    let runningLen = 0;
    for (const section of twoShotSections) {
      if (section.priority === 'mandatory') {
        accepted.push(section.text);
        runningLen += section.text.length + 1;
      }
    }
    for (const section of twoShotSections) {
      if (section.priority === 'mandatory') continue;
      if (runningLen + section.text.length + 1 <= KLING_PROMPT_BUDGET) {
        accepted.push(section.text);
        runningLen += section.text.length + 1;
      }
    }
    const accDialogueHint = accepted.find(t => t === dialogueHint);
    const accRest = accepted.filter(t => t !== dialogueHint);
    const klingPrompt = [...accRest, accDialogueHint].filter(Boolean).join(' ');

    // Build Kling elements[] from both personas — the character identity lock
    // comes from these inline elements (frontal + reference_image_urls), not
    // from a flat reference_images array.
    const { elements, elementTokens } = buildKlingElementsFromPersonas(resolvedPersonas);

    // Non-invasive subject anchoring — append brand subject as a pure visual
    // ref when subject_present and there's room. Two-shots typically use 2
    // persona elements, leaving slot 3 free for the subject.
    if (beat.subject_present && elements.length < 3) {
      const subjectElement = buildKlingSubjectElement(episodeContext?.subjectReferenceImages);
      if (subjectElement) {
        elements.push(subjectElement);
        this.logger.info(`[${beat.beat_id}] subject element added to Kling refs (${elements.length}/3)`);
      }
    }

    // V4 Tier 2.1 (2026-05-06) — DOCUMENTED EXCEPTION to the unified
    // _pickStartFrame waterfall. GroupTwoShot prefers scene_master OVER
    // previous endframe because two-shots need both characters in frame:
    // the scene-master Seedream panel is staged for multi-character
    // composition, while the previous endframe (typically a single-character
    // closeup) won't show the second speaker. Continuity is preserved via
    // Kling Omni's element binding (both personas in elements[]). Set
    // continuity_fallback_reason directly so Lens C / Lens E still see why
    // we diverged from the canonical chain.
    const startFrameUrl = scene?.scene_master_url
      || previousBeat?.endframe_url
      || elements[0]?.frontal_image_url;
    if (!startFrameUrl) {
      throw new Error(`beat ${beat.beat_id}: no start frame available`);
    }
    if (scene?.scene_master_url) {
      beat.continuity_fallback_reason = previousBeat
        ? 'group_twoshot_prefers_scene_master_over_endframe'
        : 'scene_master_first_beat';
    } else if (previousBeat?.endframe_url) {
      beat.continuity_fallback_reason = 'previous_endframe_used';
    } else {
      beat.continuity_fallback_reason = 'group_twoshot_persona_element_fallback';
    }

    // Splice @Element1/@Element2 tokens into the prompt so Kling binds the
    // dialogue lines to the correct characters in the two-shot.
    const taggedPrompt = elementTokens.length >= 2
      ? `${klingPrompt} ${elementTokens[0]} speaks first, then ${elementTokens[1]} responds.`
      : klingPrompt;

    this.logger.info(`[${beat.beat_id}] Stage B: Kling O3 Omni two-shot (${elements.length} element(s))`);
    const klingResult = await kling.generateDialogueBeat({
      startFrameUrl,
      elements,
      prompt: taggedPrompt,
      options: {
        duration,
        aspectRatio: '9:16',
        generateAudio: true
      }
    });

    // ─── Stage C — Sync Lipsync v3 corrective pass ───
    //
    // The dialogue-endpoint path already produced one combined audio file
    // with shared prosodic context — we feed it directly to Sync v3.
    // The fallback path requires the legacy ffmpeg concat (speaker 1 →
    // 0.3s breath → speaker 2) so Sync v3 sees both speakers sequentially.
    let finalVideoBuffer = klingResult.videoBuffer;
    let finalVideoUrl = klingResult.videoUrl;
    let syncPassSucceeded = false;

    if (syncLipsync) {
      try {
        let audioUrlForSync = combinedAudioUrl;
        if (!audioUrlForSync && ttsResults && ttsResults.length > 0) {
          // Fallback path — concatenate per-speaker tracks with a small gap.
          this.logger.info(`[${beat.beat_id}] Stage C: ffmpeg concat ${ttsResults.length} speaker track(s) for combined lipsync`);
          if (ttsResults.length >= 2) {
            try {
              const concatBuffer = concatSpeakerAudioBuffers(
                ttsResults.map(r => r.audioBuffer),
                0.3
              );
              combinedAudioUrl = await episodeContext.uploadAudio({
                buffer: concatBuffer,
                filename: `beat-${beat.beat_id}-twoshot-combined.mp3`,
                mimeType: 'audio/mpeg'
              });
              audioUrlForSync = combinedAudioUrl;
            } catch (concatErr) {
              this.logger.warn(`[${beat.beat_id}] audio concat failed, falling back to speaker 0: ${concatErr.message}`);
              audioUrlForSync = perSpeakerAudioUrls[0];
            }
          } else {
            audioUrlForSync = perSpeakerAudioUrls[0];
          }
        }

        if (audioUrlForSync) {
          this.logger.info(`[${beat.beat_id}] Stage C: Sync Lipsync v3 (path=${stageAPath})`);
          const syncResult = await syncLipsync.applyLipsync({
            videoUrl: klingResult.videoUrl,
            audioUrl: audioUrlForSync
            // syncMode default 'bounce' applies — mirrors final frame
            // back-and-forth on tail mismatch instead of clipping mid-phoneme.
          });
          finalVideoBuffer = syncResult.videoBuffer;
          finalVideoUrl = syncResult.videoUrl;
          syncPassSucceeded = true;
        } else {
          this.logger.warn(`[${beat.beat_id}] no audio URL available for Sync v3 — using Kling raw`);
        }
      } catch (err) {
        this.logger.warn(`[${beat.beat_id}] Sync pass failed, falling back to Kling raw: ${err.message}`);
      }
    }

    // Cost — dialogue endpoint and fallback path both bill at $0.0001/char.
    // The dialogue endpoint replaces 2 separate TTS calls with 1 combined
    // call but the underlying ElevenLabs char-billing is identical.
    const klingCost = COST_KLING_OMNI_STANDARD_PER_SEC * duration;
    const ttsCost = dialogues.reduce((n, d) => n + (d || '').length * COST_TTS_PER_CHAR, 0);
    const syncCost = syncPassSucceeded ? COST_SYNC_LIPSYNC_V3_FLAT : 0;
    const totalCost = klingCost + ttsCost + syncCost;

    const modelUsed = stageAPath === 'dialogue_endpoint'
      ? (syncPassSucceeded ? 'kling-o3-omni-twoshot+dialogue-v3+sync' : 'kling-o3-omni-twoshot+dialogue-v3')
      : (syncPassSucceeded ? 'kling-o3-omni-twoshot+sync' : 'kling-o3-omni-twoshot');

    return {
      videoBuffer: finalVideoBuffer,
      durationSec: duration,
      modelUsed,
      costUsd: totalCost,
      metadata: {
        personaCount: resolvedPersonas.length,
        klingVideoUrl: klingResult.videoUrl,
        finalVideoUrl,
        syncPassSucceeded,
        audioPath: stageAPath,
        dialogueEndpointAttempted,
        dialogueEndpointError,
        audioUrls: perSpeakerAudioUrls,
        combinedAudioUrl
      }
    };
  }
}

export default GroupTwoShotGenerator;
export { GroupTwoShotGenerator };
