// services/beat-generators/GroupTwoShotGenerator.js
// V4 GROUP_DIALOGUE_TWOSHOT beat generator.
//
// ⚠️ RARE — reserved for emotional peaks only. V4's default for multi-character
// dialogue is SHOT_REVERSE_SHOT (expanded to alternating closeups). Two-shots
// are used when the emotional payoff REQUIRES both faces in the same frame.
//
// Generates via Kling O3 Omni Standard with both personas in the reference
// stack + multi-shot mode + native audio. Sync Lipsync v3 post-pass runs
// twice (once per speaker) to correct both mouths against the respective
// ElevenLabs TTS audio.
//
// If either sync pass fails, the generator returns the Kling-raw video with
// a warning — the beat is still usable, just with Kling's native lip-sync.

import BaseBeatGenerator from './BaseBeatGenerator.js';
import { buildKlingElementsFromPersonas, buildKlingSubjectElement } from '../KlingFalService.js';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

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

    // Render TTS for each speaker in parallel
    this.logger.info(`[${beat.beat_id}] Stage A: TTS × ${resolvedPersonas.length} (parallel)`);
    const ttsResults = await Promise.all(
      resolvedPersonas.map((persona, i) => {
        if (!persona.elevenlabs_voice_id) {
          throw new Error(`beat ${beat.beat_id}: persona ${i} missing elevenlabs_voice_id`);
        }
        return this.tts.synthesizeBeat({
          text: dialogues[i],
          voiceId: persona.elevenlabs_voice_id,
          durationTarget: duration / 2, // rough half each
          options: {
            language: persona.language || 'en',
            modelId: 'eleven_multilingual_v2'
          }
        });
      })
    );

    // Upload audio files
    if (!episodeContext?.uploadAudio) {
      throw new Error(`beat ${beat.beat_id}: episodeContext.uploadAudio required`);
    }
    const audioUrls = await Promise.all(
      ttsResults.map((tts, i) => episodeContext.uploadAudio({
        buffer: tts.audioBuffer,
        filename: `beat-${beat.beat_id}-speaker${i}.mp3`,
        mimeType: 'audio/mpeg'
      }))
    );

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

    const startFrameUrl = scene?.scene_master_url
      || previousBeat?.endframe_url
      || elements[0]?.frontal_image_url;
    if (!startFrameUrl) {
      throw new Error(`beat ${beat.beat_id}: no start frame available`);
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

    // Stage C — Sync Lipsync v3 corrective pass.
    //
    // Phase 4.3: we concatenate the two speaker TTS tracks time-aligned
    // (speaker 1 → 0.3s breath → speaker 2) into ONE combined audio track and
    // feed that to Sync Lipsync v3. The corrective pass then sees audio for
    // both speakers sequentially and repairs both mouth regions in a single
    // pass — eliminating the old "only speaker 1 is lipsynced" artifact.
    //
    // If ffmpeg concat fails, we gracefully fall back to speaker 1's track
    // only (the pre-Phase-4.3 behavior) rather than losing the beat.
    let finalVideoBuffer = klingResult.videoBuffer;
    let finalVideoUrl = klingResult.videoUrl;
    let syncPassSucceeded = false;
    let combinedAudioUrl = null;

    if (syncLipsync && audioUrls.length > 0) {
      try {
        this.logger.info(`[${beat.beat_id}] Stage C: concatenating ${ttsResults.length} speaker track(s) for combined lipsync pass`);
        let audioUrlForSync = audioUrls[0];
        if (ttsResults.length >= 2) {
          try {
            const combinedBuffer = concatSpeakerAudioBuffers(
              ttsResults.map(r => r.audioBuffer),
              0.3
            );
            combinedAudioUrl = await episodeContext.uploadAudio({
              buffer: combinedBuffer,
              filename: `beat-${beat.beat_id}-twoshot-combined.mp3`,
              mimeType: 'audio/mpeg'
            });
            audioUrlForSync = combinedAudioUrl;
          } catch (concatErr) {
            this.logger.warn(`[${beat.beat_id}] audio concat failed, falling back to speaker 0: ${concatErr.message}`);
          }
        }

        const syncResult = await syncLipsync.applyLipsync({
          videoUrl: klingResult.videoUrl,
          audioUrl: audioUrlForSync
          // syncMode default 'bounce' applies — mirrors final frame back-and-forth
          // on tail mismatch instead of clipping mid-phoneme.
        });
        finalVideoBuffer = syncResult.videoBuffer;
        finalVideoUrl = syncResult.videoUrl;
        syncPassSucceeded = true;
      } catch (err) {
        this.logger.warn(`[${beat.beat_id}] Sync pass failed, falling back to Kling raw: ${err.message}`);
      }
    }

    const klingCost = COST_KLING_OMNI_STANDARD_PER_SEC * duration;
    const ttsCost = dialogues.reduce((n, d) => n + (d || '').length * COST_TTS_PER_CHAR, 0);
    const syncCost = syncPassSucceeded ? COST_SYNC_LIPSYNC_V3_FLAT : 0;
    const totalCost = klingCost + ttsCost + syncCost;

    return {
      videoBuffer: finalVideoBuffer,
      durationSec: duration,
      modelUsed: syncPassSucceeded ? 'kling-o3-omni-twoshot+sync' : 'kling-o3-omni-twoshot',
      costUsd: totalCost,
      metadata: {
        personaCount: resolvedPersonas.length,
        klingVideoUrl: klingResult.videoUrl,
        finalVideoUrl,
        syncPassSucceeded,
        audioUrls,
        combinedAudioUrl
      }
    };
  }
}

export default GroupTwoShotGenerator;
export { GroupTwoShotGenerator };
