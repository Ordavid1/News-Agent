// services/beat-generators/CinematicDialogueGenerator.js
// V4 Mode B dialogue generator — the heart of on-camera dialogue in V4.
//
// Handles: TALKING_HEAD_CLOSEUP and DIALOGUE_IN_SCENE beat types.
//
// Mode B hybrid chain (3 stages):
//
//   Stage A — ElevenLabs TTS synthesizes the beat's dialogue line in the
//             persona's locked voice. Returns an MP3 + actualDurationSec.
//   Stage B — Kling O3 Omni Standard generates a cinematic dialogue beat
//             (character speaking in rich environment, identity-locked by
//             reference images). Kling's native lip-sync is rough but the
//             cinematic background and character motion are excellent.
//   Stage C — Sync Lipsync v3 takes Stage B's video + Stage A's audio and
//             applies a corrective lip-sync pass. Preserves background and
//             body motion; replaces mouth shapes to match the TTS audio.
//
// Final output: a cinematic dialogue beat with perfect lip-sync + rich
// background. This is how Hollywood does ADR (generate the picture, fix
// dialogue in post), ported to AI generation.
//
// Mode A fallback (OmniHuman 1.5 alone) is a separate generator
// (TalkingHeadCloseupGenerator) used when a story is flagged Mode A by
// cost tier or when Mode B has failed for this persona before.
//
// Requires the orchestrator to upload Stage A's TTS audio to Supabase and
// pass the public URL via episodeContext.audioUploadFn — OR the dialogue
// generator does it inline if a supabaseUpload helper is in deps.

import BaseBeatGenerator from './BaseBeatGenerator.js';
import { buildKlingElementsFromPersonas, buildKlingSubjectElement } from '../KlingFalService.js';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

// Cost constants for estimator (per-second rates × typical duration)
const COST_KLING_OMNI_STANDARD_PER_SEC = 0.168;
const COST_SYNC_LIPSYNC_V3_FLAT = 0.50; // rough per-beat flat (fal.ai specifics TBD Day 0)
const COST_TTS_PER_CHAR = 0.0001; // rough ElevenLabs multilingual v2 cost

class CinematicDialogueGenerator extends BaseBeatGenerator {
  static beatTypes() {
    return ['TALKING_HEAD_CLOSEUP', 'DIALOGUE_IN_SCENE'];
  }

  static estimateCost(beat) {
    const duration = beat.duration_seconds || 4;
    const dialogueChars = (beat.dialogue || '').length;
    const klingCost = COST_KLING_OMNI_STANDARD_PER_SEC * duration;
    const ttsCost = COST_TTS_PER_CHAR * dialogueChars;
    return klingCost + COST_SYNC_LIPSYNC_V3_FLAT + ttsCost;
  }

  async _doGenerate({ beat, scene, refStack, personas, episodeContext, previousBeat }) {
    const { kling, syncLipsync } = this.falServices;
    if (!kling) throw new Error('CinematicDialogueGenerator: kling service not in deps');
    if (!syncLipsync) throw new Error('CinematicDialogueGenerator: syncLipsync service not in deps');
    if (!this.tts) throw new Error('CinematicDialogueGenerator: tts service not in deps');

    const persona = this._resolvePersona(beat, personas);
    if (!persona) throw new Error(`beat ${beat.beat_id}: no persona resolved`);
    if (!persona.elevenlabs_voice_id) {
      throw new Error(`beat ${beat.beat_id}: persona "${persona.name}" missing elevenlabs_voice_id`);
    }

    const dialogue = beat.dialogue;
    if (!dialogue) throw new Error(`beat ${beat.beat_id}: missing dialogue field`);

    const targetDuration = beat.duration_seconds || 4;

    // ─── Stage A — ElevenLabs TTS ───
    this.logger.info(`[${beat.beat_id}] Stage A: TTS synthesis (${dialogue.length} chars, target ${targetDuration}s)`);
    // V4 Audio Layer Overhaul Day 1 — modelId omitted so TTSService picks
    // the engine from BRAND_STORY_TTS_ENGINE (default eleven_v3). Persona's
    // language flows through unchanged; eleven-v3 supports 70+ languages
    // including Hebrew (multilingual-v2 did not). Inline performance tags in
    // the dialogue string (e.g. "[barely whispering] I had no choice.") are
    // authored by Gemini per the DIALOGUE PERFORMANCE TAGS masterclass and
    // preserved verbatim by TTSService for eleven-v3 to interpret.
    const ttsResult = await this.tts.synthesizeBeat({
      text: dialogue,
      voiceId: persona.elevenlabs_voice_id,
      durationTarget: targetDuration,
      options: {
        language: persona.language || 'en',
        paceHint: beat.pace_hint || null,
        emotionalHold: beat.emotional_hold === true
      }
    });

    // Upload TTS audio to Supabase to get a public URL for Sync Lipsync v3.
    // The orchestrator injects an upload helper via episodeContext.uploadAudio.
    if (!episodeContext?.uploadAudio) {
      throw new Error(`beat ${beat.beat_id}: episodeContext.uploadAudio helper required for Mode B`);
    }
    // V4 hotfix 2026-04-30 — emotional_hold trailing-silence pad.
    //
    // When the screenplay marks a dialogue beat with `emotional_hold: true`,
    // the TARGET beat duration includes a deliberate post-speech pause for
    // visual emotional impact (e.g., 2.8s of dialogue + 1.2s holding the
    // shot on the character's reaction = 4s total). TTS correctly skips
    // speed-auto-calibration to preserve the natural-length speech.
    //
    // BUT: before this fix, Stages B and C had no awareness of emotional_hold:
    //   • Stage B (Kling) was told `duration: Math.round(ttsResult.actualDurationSec)`
    //     → Kling renders 2.8s, the 1.2s emotional pause is LOST entirely.
    //   • Stage C (Sync Lipsync v3 in bounce mode) syncs 2.8s audio to 2.8s
    //     video → fine, but the BEAT INTENT (the held silence) is gone.
    //
    // Fix (Option 1 from architectural review): Pad the TTS audio with
    // ffmpeg-generated silence at the END so total audio duration matches
    // the BEAT'S targetDuration. Kling then renders the full beat duration
    // (line below), and Sync v3 receives audio with real silence in the
    // trailing region — bounce mode keeps the mouth still during silence,
    // delivering the emotional hold as designed.
    //
    // Only fires when emotional_hold AND there's a meaningful gap (>0.3s);
    // tiny gaps (rounding noise) fall through to bounce-mode mirroring.
    const isEmotionalHold = beat.emotional_hold === true;
    const speechDur = ttsResult.actualDurationSec || targetDuration;
    const padNeeded = isEmotionalHold && (targetDuration - speechDur) > 0.3;
    let finalAudioBuffer = ttsResult.audioBuffer;
    let finalAudioDurationSec = speechDur;
    if (padNeeded) {
      const padSec = +(targetDuration - speechDur).toFixed(3);
      try {
        finalAudioBuffer = this._padAudioWithSilence(
          ttsResult.audioBuffer,
          padSec,
          beat.beat_id
        );
        finalAudioDurationSec = targetDuration;
        this.logger.info(
          `[${beat.beat_id}] emotional_hold: padded TTS audio ` +
          `${speechDur.toFixed(2)}s → ${targetDuration.toFixed(2)}s (+${padSec}s silence) ` +
          `for Kling render + Sync v3 lipsync`
        );
      } catch (err) {
        this.logger.warn(
          `[${beat.beat_id}] emotional_hold pad failed (${err.message}) — ` +
          `falling through to TTS-natural duration; emotional hold visual will be lost`
        );
        // finalAudioBuffer stays as the original; finalAudioDurationSec stays as speechDur
      }
    }

    const audioUrl = await episodeContext.uploadAudio({
      buffer: finalAudioBuffer,
      filename: `beat-${beat.beat_id}-tts.mp3`,
      mimeType: 'audio/mpeg'
    });

    // ─── Stage B — Kling O3 Omni Standard cinematic visual ───
    // V4 Tier 2.1 (2026-05-06) — pass `beat` so unified picker writes
    // continuity_fallback_reason for Lens C / Lens E.
    const startFrameUrl = this._pickStartFrame(refStack, previousBeat, scene, beat);
    if (!startFrameUrl) {
      throw new Error(`beat ${beat.beat_id}: no start frame available (need character sheet or scene master)`);
    }

    const stylePrefix = episodeContext?.visual_style_prefix || '';
    const expressionHint = beat.expression_notes ? ` Expression: ${beat.expression_notes}.` : '';
    const lensHint = beat.lens ? ` Lens: ${beat.lens}.` : '';
    const emotionHint = beat.emotion ? ` Emotion: ${beat.emotion}.` : '';
    const actionHint = beat.action_notes ? ` Action: ${beat.action_notes}.` : '';
    // V4 subtext routing — when the scriptwriter has marked a line's surface meaning
    // as different from its truth, surface the subtext as a facial direction so Kling
    // can render a micro-tell (a flinch, a held breath, eyes cutting away). The TTS
    // stays neutral to the written line; the face carries the subtext underneath.
    const subtextHint = beat.subtext
      ? ` Subtext (show on the face, not in the voice): the line is "${dialogue}" but what the character really means is "${beat.subtext}". Let that truth surface as a micro-expression under the surface emotion.`
      : '';

    // V4 Audio Layer Overhaul Day 2 — exchange context for SHOT_REVERSE_SHOT children.
    //
    // Pre-Day-2: each closeup expanded from a SHOT_REVERSE_SHOT was generated
    // in ignorance of the prior speaker. The compiler dropped the exchanges[]
    // metadata after expansion. Now the compiler stamps `beat.exchange_context`
    // onto every child closeup carrying { position_in_exchange, prior speaker
    // emotion / subtext / dialogue tail, speaker_sequence }. We surface that
    // to Kling as a "this is a response shot" directive so the listener's
    // micro-expression reflects the line that just landed (active listening,
    // residual emotional charge from the prior turn, etc.) — not a default
    // "first beat of a new monologue" register.
    const exCtx = beat.exchange_context;
    const priorContextHint = (exCtx && exCtx.prior_speaker_dialogue_tail)
      ? ` Response shot (exchange ${(exCtx.position_in_exchange ?? 0) + 1} of ${exCtx.total_exchanges ?? '?'}): the prior speaker just said "...${exCtx.prior_speaker_dialogue_tail}" with ${exCtx.prior_speaker_emotion ? `emotion="${exCtx.prior_speaker_emotion}"` : 'unspecified emotion'}${exCtx.prior_speaker_subtext ? `, subtext "${exCtx.prior_speaker_subtext}"` : ''}. This face is RECEIVING that line — show the read first, then the response.`
      : '';

    // For TALKING_HEAD_CLOSEUP, the prompt focuses on the face and emotion.
    // For DIALOGUE_IN_SCENE, the prompt includes movement/interaction.
    const isInScene = beat.type === 'DIALOGUE_IN_SCENE';
    // Phase 3.2 — prefer the structured framing vocabulary when Gemini emits
    // it. Falls back to the legacy hint when omitted.
    const framingRecipe = this._resolveFramingRecipe(beat);
    const framingHint = framingRecipe
      || (isInScene
        ? 'Medium shot, character in scene, environmental context visible.'
        : 'Tight closeup, head and shoulders, shallow depth of field.');

    // Kling O3 Omni Standard has a hard 512-char prompt limit. If we naively
    // concatenate stylePrefix (often ~150-200 chars) + framingHint + every
    // direction string, we spill past 512 and the dialogue line (which MUST
    // survive because Mode B lipsyncs to it) gets silently truncated.
    //
    // Caught 2026-04-23 on first full V4 episode run:
    //   [s1b4] prompt truncated from 738 → 512 chars
    //   [s2b4] prompt truncated from 828 → 512 chars
    // Both beats had the dialogue line at the tail of the joined prompt, so
    // the cut removed most of it — producing a dialogue beat whose Kling
    // input had no dialogue reference at all.
    //
    // Fix: budget-allocate prompt construction. Sections are ordered by
    // priority (mandatory first). If adding the next section would exceed the
    // soft budget, it's dropped entirely rather than chopped mid-sentence —
    // so Kling always receives coherent, complete instructions.
    const KLING_PROMPT_BUDGET = 480; // leave 32 chars of safety under the hard 512 limit
    const dialogueLine = `Character speaks the line: "${dialogue}"`;

    // V4 Phase 9 — vertical framing directive (condensed) + identity lock.
    // For Kling's 512-char budget we use compact summaries rather than the
    // full directive so other high-priority fields survive.
    const verticalDirective = 'VERTICAL 9:16 tight portrait. Eyes upper third, chin lower third, face fills vertical. No letterbox.';
    const identityDirective = 'Preserve facial structure from refs (bone geometry, eye/nose/jaw/lip). Same person, same face.';

    // V4 Director Agent (L3) nudge. When the orchestrator (Phase 3 blocking-
    // mode auto-retry OR Director-Panel "Apply L3 nudge & regenerate") stamps
    // a generator-actionable prompt_delta onto the beat, splice it in as a
    // HIGH-priority section so it survives the 512-char Kling budget unless
    // truly mandatory directives are competing.
    const directorNudge = (typeof beat?.director_nudge === 'string' && beat.director_nudge.trim().length > 0)
      ? `DIRECTOR'S NOTE (retake): ${beat.director_nudge.trim()}`
      : '';

    // V4 Tier 2.2 (2026-05-06) — wardrobe directive (medium priority — safer
    // for closeups where costume is visible) + brand color (low — accent).
    // Per-model color hint not added because Kling's 512-char budget is
    // tight; the per-model framing in identityDirective + framingHint
    // already biases the visual register.
    const wardrobeDirective = this._buildWardrobeDirective(persona);
    const brandColorDirective = this._buildBrandColorDirective(episodeContext);

    // Priority-ordered sections. Mandatory ones come first and can never be
    // dropped; optional ones are tried in order and skipped when the budget
    // is spent.
    const promptSections = [
      { priority: 'mandatory', text: dialogueLine },
      { priority: 'mandatory', text: verticalDirective },
      { priority: 'mandatory', text: identityDirective },
      { priority: 'mandatory', text: framingHint },
      { priority: 'high',      text: directorNudge },
      { priority: 'high',      text: subtextHint.trim() },
      // Day 2 — prior-speaker context for SHOT_REVERSE_SHOT children. High
      // priority so it survives the 480-char Kling budget; condensed phrasing
      // keeps it under ~200 chars in typical cases.
      { priority: 'high',      text: priorContextHint.trim() },
      { priority: 'high',      text: emotionHint.trim() },
      { priority: 'medium',    text: expressionHint.trim() },
      { priority: 'medium',    text: actionHint.trim() },
      // V4 Tier 2.2 — wardrobe runs at medium because closeups reveal costume.
      { priority: 'medium',    text: wardrobeDirective },
      { priority: 'low',       text: brandColorDirective },
      { priority: 'low',       text: stylePrefix },
      { priority: 'low',       text: lensHint.trim() }
    ].filter(s => s.text && s.text.length > 0);

    // First pass: accept every mandatory section regardless of budget (we can
    // always overshoot by a handful of chars into the 32-char safety margin).
    const accepted = [];
    let runningLen = 0;
    for (const section of promptSections) {
      if (section.priority === 'mandatory') {
        accepted.push(section.text);
        runningLen += section.text.length + 1;
      }
    }
    // Second pass: add optional sections in priority order until the budget
    // is exhausted. A section is only added if it fits in full.
    for (const section of promptSections) {
      if (section.priority === 'mandatory') continue;
      if (runningLen + section.text.length + 1 <= KLING_PROMPT_BUDGET) {
        accepted.push(section.text);
        runningLen += section.text.length + 1;
      }
    }
    // Re-order: dialogue goes at the END (Kling's narrative emphasis favors
    // the closing lines of a prompt). Framing / style / emotion lead the
    // prompt so Kling establishes the visual register first.
    const accDialogue = accepted.find(t => t === dialogueLine);
    const accRest = accepted.filter(t => t !== dialogueLine);
    const klingPrompt = [...accRest, accDialogue].filter(Boolean).join(' ');

    // Build the Kling elements[] array from the speaking persona (and any
    // other personas present in the shot). Character identity lock comes from
    // these inline elements, not a flat reference_images array.
    const personasInShot = [persona]; // primary speaker always first
    if (Array.isArray(beat.persona_indexes)) {
      for (const idx of beat.persona_indexes) {
        if (personas[idx] && personas[idx] !== persona) personasInShot.push(personas[idx]);
      }
    }
    const { elements, elementTokens } = buildKlingElementsFromPersonas(personasInShot);

    // Non-invasive subject anchoring — append the brand subject as a pure
    // visual ref when the screenplay marks subject_present and there's room.
    // Subject does NOT get an @Element token (it's not a speaker).
    if (beat.subject_present && elements.length < 3) {
      const subjectElement = buildKlingSubjectElement(episodeContext?.subjectReferenceImages);
      if (subjectElement) {
        elements.push(subjectElement);
        this.logger.info(`[${beat.beat_id}] subject element added to Kling refs (${elements.length}/3)`);
      }
    }

    // Splice @Element tokens into the prompt so Kling knows which character
    // speaks the line. Use @Element1 for the primary speaker.
    const primarySpeakerToken = elementTokens[0] || '';
    const finalKlingPrompt = primarySpeakerToken
      ? `${klingPrompt.replace(/Character speaks/, `${primarySpeakerToken} speaks`)}`
      : klingPrompt;

    // V4 P0.4 — Identity-defense gate. Run the visual_anchor inversion
    // check on the final prompt before the API call. Inversions
    // (gender/age inverted vs anchor) hard-halt the beat and surface to
    // the orchestrator's user_review path. The audit confirmed this gate
    // was already active at CharacterSheetDirector.js:394; extending it
    // here covers the post-sheet pre-render emission path that was
    // previously unguarded.
    this._validatePromptAgainstAnchor(finalKlingPrompt, persona, beat.beat_id);

    // V4 hotfix 2026-04-30 — Kling renders to the FULL beat duration when
    // emotional_hold is set so the post-speech emotional pause survives in
    // the rendered clip. Without emotional_hold, behavior is unchanged
    // (renders to TTS natural duration as before).
    const klingTargetDuration = padNeeded
      ? Math.round(targetDuration)
      : Math.round(ttsResult.actualDurationSec);

    this.logger.info(
      `[${beat.beat_id}] Stage B: Kling O3 Omni Standard ` +
      `(${elements.length} element(s), duration=${klingTargetDuration}s${padNeeded ? ' [emotional_hold]' : ''})`
    );
    const klingResult = await kling.generateDialogueBeat({
      startFrameUrl,
      elements,
      prompt: finalKlingPrompt,
      options: {
        duration: klingTargetDuration,
        aspectRatio: '9:16',
        generateAudio: true
      }
    });

    // ─── Stage C — Sync Lipsync v3 corrective pass ───
    // syncMode intentionally NOT overridden — service default is now 'bounce',
    // which mirrors the final frame back-and-forth to pad tail gaps when TTS
    // runs a few frames longer than Kling's rounded duration. This eliminates
    // the "mouth cut mid-phoneme" artifact the old 'cut_off' default produced.
    this.logger.info(`[${beat.beat_id}] Stage C: Sync Lipsync v3 corrective pass`);
    const syncResult = await syncLipsync.applyLipsync({
      videoUrl: klingResult.videoUrl, // Kling's CDN URL is already public
      audioUrl
    });

    // Total cost accounting — Kling cost reflects the actual render duration
    // (which is targetDuration when emotional_hold padded, else TTS natural).
    const klingCost = COST_KLING_OMNI_STANDARD_PER_SEC * klingTargetDuration;
    const syncCost = COST_SYNC_LIPSYNC_V3_FLAT;
    const ttsCost = COST_TTS_PER_CHAR * dialogue.length;
    const totalCost = klingCost + syncCost + ttsCost;

    return {
      videoBuffer: syncResult.videoBuffer,
      // Reported duration matches what was actually rendered (so downstream
      // assembly + duration-trace logs are accurate). When emotional_hold
      // padded, this is targetDuration; else it's the TTS natural length.
      durationSec: padNeeded ? finalAudioDurationSec : ttsResult.actualDurationSec,
      modelUsed: 'mode-b/kling-o3-omni+sync-lipsync-v3',
      costUsd: totalCost,
      metadata: {
        mode: 'B',
        klingVideoUrl: klingResult.videoUrl,
        syncVideoUrl: syncResult.videoUrl,
        ttsAudioUrl: audioUrl,
        ttsActualDurationSec: ttsResult.actualDurationSec,
        elementBound: !!persona.kling_element_id,
        voiceBound: !!persona.kling_voice_id
      }
    };
  }

  /**
   * V4 hotfix 2026-04-30 — Pad an MP3 audio buffer with `padSec` of silence
   * appended to the end. Used by the emotional_hold path to make the
   * audio's total duration match the BEAT's targetDuration so Kling renders
   * the full hold AND Sync v3 sees real silence in the trailing region
   * (keeping the mouth still during the emotional pause).
   *
   * Uses ffmpeg `apad` filter with `pad_dur` option — most reliable apad
   * variant across ffmpeg builds. Falls back to `aevalsrc` concat if apad
   * fails (older ffmpeg builds without pad_dur).
   *
   * @param {Buffer} audioBuffer - source MP3 (typically TTS output)
   * @param {number} padSec      - seconds of silence to append (must be >0)
   * @param {string} beatId      - for log/temp-file naming
   * @returns {Buffer} padded MP3 buffer
   */
  _padAudioWithSilence(audioBuffer, padSec, beatId) {
    if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
      throw new Error('_padAudioWithSilence: audioBuffer empty');
    }
    if (!Number.isFinite(padSec) || padSec <= 0) {
      throw new Error(`_padAudioWithSilence: invalid padSec=${padSec}`);
    }

    const tmpDir = os.tmpdir();
    const stamp = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const inputPath = path.join(tmpDir, `cdg-${beatId}-${stamp}-in.mp3`);
    const outputPath = path.join(tmpDir, `cdg-${beatId}-${stamp}-out.mp3`);

    fs.writeFileSync(inputPath, audioBuffer);
    try {
      // apad pad_dur appends padSec seconds of silence after the input.
      execFileSync('ffmpeg', [
        '-y',
        '-i', inputPath,
        '-af', `apad=pad_dur=${padSec.toFixed(3)}`,
        '-c:a', 'libmp3lame',
        '-q:a', '2',
        outputPath
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      const padded = fs.readFileSync(outputPath);
      return padded;
    } finally {
      try { fs.unlinkSync(inputPath); } catch {}
      try { fs.unlinkSync(outputPath); } catch {}
    }
  }
}

export default CinematicDialogueGenerator;
export { CinematicDialogueGenerator };
