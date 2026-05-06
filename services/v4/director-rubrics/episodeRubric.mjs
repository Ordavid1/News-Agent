// services/v4/director-rubrics/episodeRubric.mjs
//
// Lens D — Picture Lock. Post-assembly, MULTIMODAL (full assembled MP4 video).
// Advisory-only in current rollout: never auto-retries a full episode.
// Returns targeted scene/beat regenerate suggestions for the user to act on.

import { buildSharedSystemHeader, buildGenreRegisterHint } from './sharedHeader.mjs';

const LENS_D_BLOCK = `CHECKPOINT D — Picture Lock (post-assembly, full episode). LENS D. ADVISORY ONLY — retry_authorization MUST always be false in this lens. Findings recommend specific scene/beat regenerate actions for the user; the pipeline does not auto-retry full episodes.

DIMENSIONS TO SCORE (each 0-100). Use these EXACT keys in dimension_scores:
  rhythm                          — three-movement arc (20%/55%/25%) lands? Act 2 actually escalates? are any beats holding too long?
  music_dialogue_ducking_feel     — ducking happens at the right MOMENTS (not just the right -dB)? base bed CONTINUOUS across ALL scene boundaries (no abrupt timbre cliffs)? J-cut overlays blend in/out audibly without jarring onset? does the bed support the dialogue or fight it?
  sonic_continuity                — does the episode feel like ONE sonic world from start to finish? spectral anchor audible throughout? scene overlay transitions non-jarring? foley events discrete and diegetic (never a wash/drone/atmosphere description in a per-beat slot)?
  lut_consistency_cross_scene     — does the grade hold across scenes, or does one scene drift?
  transition_intent               — xfade vs fadeblack vs cut vs speed_ramp choices land on a beat or mid-gesture?
  subtitle_legibility_taste       — subs readable, well-timed, don't fight composition?
  title_endcard_taste             — cards feel like the show, not slapped on?
  cross_scene_continuity          — props / wardrobe / time-of-day / weather coherent across scenes?
  cliffhanger_sting               — does the final 2 seconds *land*? would a viewer hit "next episode"?

  ─── AUDIO DESIGNER EVALUATION (Rec 3 Phase A — make the SonicSeriesBible enforceable) ───

  audio_coherence_episode         — does the episode feel like ONE sonic world from start to finish? Spectral profile (LF + HF presence) consistent across all scenes? Base palette ambient keywords from sonic_world.base_palette woven throughout? Intentional shifts at scene transitions are FEATURES (motivated by genre register); accidental drift is a fail. Score 100 if no SonicSeriesBible exists (no inheritance contract to break). Score 60-80 if base palette holds but per-beat sources (Veo native vs Kling silence vs EL SFX overlay) sound four-handed. 90+ requires designed coherence — not just absence of cliffs.
  dB_consistency_inter_beat       — mix levels stable across beat boundaries? No abrupt level jumps between adjacent beats? Dialogue at 0dB reference (intelligible despite ducking). Per-beat SFX at -10dB relative to native. Music bed at -18dB (ducked to -24dB during dialogue). Scene ambient bed at -18dB without popping on scene boundaries. Per-beat loudnorm at I=-23 LUFS but episode-level RMS holds. Currently the failure mode is per-beat normalize without inter-beat balance — listen for the "different room" feel between adjacent beats.
  sfx_motivation_coherence        — every per-beat SFX event feels like a diegetic consequence of beat action (footstep on the actual stride, glass clink on the actual touch), not sprayed decoration. Foley events 1-3s discrete (not muddled with ambient bed). No orphaned SFX (SFX unrelated to beat action). Score: deduct 15 pts per unmotivated or misplaced SFX event. Better Call Saul foley discipline is the bar — sound on actual frame of impact, not beat midpoint.
  sound_design_intent_match       — does the realized sonic_world match the authored music_bed_intent? Instrumentation/mood/arc delivered? prohibited_instruments absent (when SonicSeriesBible.no_fly_list present)? diegetic_ratio reflected in the foley/diegetic balance? transition_grammar (j_cut vs hard_cut_with_room_tone vs musical_match_cut) honored at scene boundaries?
  spectral_anchor_adherence       — SonicSeriesBible's spectral_anchor (LF + HF anchor signal) audibly present across every scene boundary. 90+ = anchor never drops below -22dB in any 500ms window. Grade by listening for the seam-hider — if you can identify the cut by audio alone, the anchor failed. Sicario / Jóhannsson model: a single ground tone sustains across all scene cuts. Score 100 if no SonicSeriesBible.
  no_fly_list_violations          — whether prohibited_instruments / prohibited_tropes / prohibited_frequencies_hz from SonicSeriesBible.no_fly_list appear in the mix. 100 = clean. Deduct 25 per violation: prohibited solo instrument audible (e.g. "no acoustic guitar" + audible acoustic guitar = -25), prohibited trope present (e.g. "no needle-drop pop" + recognizable pop song = -25), prohibited frequency band active. Score 100 if no SonicSeriesBible.

WHAT TO LOOK AT FIRST (in order):
  1. WATCH THE FULL CUT ONCE AT SPEED — register an emotional response. Was the emotional spine intact?
  2. RE-WATCH THE CLIFFHANGER ×3.
  3. TRANSITION AUDIT — pause at each scene boundary; does the transition serve the cut or fight it?
  4. LUT DRIFT SWEEP — pause at each scene's first beat, compare grades.
  5. SUBTITLE / CARD PASS — pause and read each card / sub.
  6. CONTINUITY SWEEP — props, wardrobe, weather, time-of-day, score.

DEFER TO LOWER LAYERS (do NOT re-emit):
  - per-beat aspect / duration / mostly-black (QC8 owns)
  - per-beat face identity (QC8 owns)
  - per-scene Scene Master composition (Lens B owns)
  - per-beat performance (Lens C owns)
  - screenplay-level dramatic structure (Lens A owns)
  Your scope is what only emerges when the cut is assembled: rhythm, transitions, music feel, cross-scene drift.

EVIDENCE FORMAT:
  scope = "episode" | "scene:<scene_id>" | "beat:<beat_id>"
  evidence = TIMECODES (e.g. "02:13–02:17: scene change xfade lands mid-gesture; should hold for 4 more frames")

REMEDIATION DISCIPLINE FOR LENS D:
  - Use action="reassemble" for transitions / music / LUT / card / subtitle issues (post-production-fixable without regenerating clips)
  - Use action="regenerate_beat" only when a specific beat is the broken element
  - Use action="regenerate_scene_master" when LUT drift is the scene's source-frame issue
  - Always set retry_authorization=false. The user reviews and triggers fixes manually.`;

/**
 * Build the multimodal prompt parts for Lens D.
 *
 * VIDEO TRANSPORT (2026-04-28 fix): Vertex AI's `file_data.file_uri` only
 * accepts gs:// URIs or Files API URIs — arbitrary public HTTPS URLs (e.g.
 * Supabase storage URLs) trigger 400 INVALID_ARGUMENT for video MIME types.
 * Always prefer `episodeVideoBuffer` (inline_data, base64) when available;
 * fall back to file_uri only if a gs:// URI is supplied. Inline limit is
 * ~20MB per Vertex docs — Lens D episodes typically come in well under that.
 *
 * @param {Object} params
 * @param {Buffer} [params.episodeVideoBuffer] - assembled MP4 buffer (PREFERRED — sent as inline_data)
 * @param {string} [params.episodeVideoUrl]   - gs:// URI (file_data) — used only when buffer not supplied
 * @param {string} [params.videoMime='video/mp4']
 * @param {Object} params.sceneGraph        - the final scene-graph used to assemble (post-judging)
 * @param {Object} [params.postProductionManifest] - { transitions, lutId, musicBedIntent, titleCard, endCard, subtitleConfig }
 * @param {string} [params.storyFocus='drama']
 */
export function buildEpisodeJudgePrompt({
  episodeVideoBuffer = null,
  episodeVideoUrl = null,
  videoMime = 'video/mp4',
  sceneGraph,
  postProductionManifest = null,
  sonicWorld = null,
  sonicSeriesBible = null,
  storyFocus = 'drama'
} = {}) {
  if (!episodeVideoBuffer && !episodeVideoUrl) {
    throw new Error('buildEpisodeJudgePrompt: episodeVideoBuffer (preferred) or episodeVideoUrl required');
  }

  const systemPrompt = [
    buildSharedSystemHeader(),
    '',
    LENS_D_BLOCK,
    '',
    buildGenreRegisterHint(storyFocus)
  ].filter(Boolean).join('\n');

  const userParts = [
    { text: `<scene_graph>\n${JSON.stringify(sceneGraph, null, 2)}\n</scene_graph>` }
  ];
  if (postProductionManifest) {
    userParts.push({ text: `<post_production_manifest>\n${JSON.stringify(postProductionManifest, null, 2)}\n</post_production_manifest>` });
  }
  if (sonicSeriesBible) {
    userParts.push({ text: `<sonic_series_bible>\n${JSON.stringify(sonicSeriesBible, null, 2)}\n</sonic_series_bible>` });
  }
  if (sonicWorld) {
    userParts.push({ text: `<episode_sonic_world>\n${JSON.stringify(sonicWorld, null, 2)}\n</episode_sonic_world>` });
  }
  userParts.push({ text: 'Assembled episode video:' });

  if (Buffer.isBuffer(episodeVideoBuffer) && episodeVideoBuffer.length > 0) {
    // Inline base64 — works reliably for video < ~20MB.
    userParts.push({
      inline_data: {
        mime_type: videoMime,
        data: episodeVideoBuffer.toString('base64')
      }
    });
  } else if (typeof episodeVideoUrl === 'string' && episodeVideoUrl.startsWith('gs://')) {
    // gs:// URIs are accepted by Vertex file_data for video.
    userParts.push({
      file_data: {
        file_uri: episodeVideoUrl,
        mime_type: videoMime
      }
    });
  } else {
    throw new Error('buildEpisodeJudgePrompt: episodeVideoBuffer required (file_uri only supports gs:// for video)');
  }

  userParts.push({ text: 'Grade per Lens D. Output ONLY the verdict JSON. retry_authorization MUST be false.' });

  return { systemPrompt, userParts };
}
