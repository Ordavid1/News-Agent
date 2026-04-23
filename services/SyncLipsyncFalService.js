// services/SyncLipsyncFalService.js
// fal.ai Sync Lipsync v3 wrapper — THE corrective lip-sync post-pass for V4 Mode B.
//
// Mode B architecture:
//   Stage 1: Kling O3 Omni Standard generates cinematic dialogue beat
//            (rich background, character motion, identity-locked) with rough lip-sync
//   Stage 2: Sync Lipsync v3 post-processes Stage 1's video against ElevenLabs TTS audio
//            to produce perfect mouth shapes while preserving everything else
//
// This is how Hollywood does ADR — generate the picture, fix dialogue in post.
// It solves the static-background trap that retired the v1 OmniHuman-only path:
//   - ✅ cinematic backgrounds from Kling (not OmniHuman's static drape)
//   - ✅ perfect lip-sync from Sync v3 (not Kling's rough native lip-sync)
//   - ✅ identity locked across the season via Kling Elements
//   - ✅ multi-character scenes (Kling supports 3+ coreference; OmniHuman single-only)
//
// Endpoint: fal-ai/sync-lipsync/v3
// Cost: ~$0.50 per 5s corrective pass
// Unique capability: "native visual intelligence" — preserves non-mouth regions
//
// Two API calls per dialogue beat = doubled latency. SSE progress reporting in
// Phase 1b becomes important so the user sees both sub-stages complete.

import FalAiBaseService from './FalAiBaseService.js';

const ENDPOINT_SYNC_LIPSYNC_V3 = 'fal-ai/sync-lipsync/v3';

class SyncLipsyncFalService extends FalAiBaseService {
  constructor() {
    super({
      modelSlug: ENDPOINT_SYNC_LIPSYNC_V3,
      displayName: 'SyncLipsyncV3',
      // Corrective passes are typically fast (30-90s), but poll generously
      // to handle fal.ai queue fluctuations during peak hours.
      pollIntervalMs: 6000,
      maxPollDurationMs: 600000 // 10 min
    });
  }

  /**
   * Apply the Sync Lipsync v3 corrective pass to an existing video.
   * Takes a video with talking content + a new audio track → produces the
   * same video with mouth shapes resynced to the new audio.
   *
   * Preserves: background, body motion, camera movement, lighting, all non-mouth regions.
   * Replaces: mouth shapes to match the provided audio.
   *
   * @param {Object} params
   * @param {string} params.videoUrl - public URL of the source video (from Kling Stage 1)
   * @param {string} params.audioUrl - public URL of the target audio (ElevenLabs TTS in persona voice)
   * @param {Object} [params.options]
   * @param {string} [params.options.syncMode='bounce'] - behavior when video/audio durations mismatch.
   *                                                      'bounce' mirrors the final frame back-and-forth to
   *                                                      pad tail gaps instead of hard-clipping them, which
   *                                                      eliminates the "mouth cut mid-phoneme" artifact that
   *                                                      'cut_off' produced when TTS ran a few frames longer
   *                                                      than Kling's rounded duration. Valid fal.ai values:
   *                                                      'cut_off' | 'loop' | 'bounce' | 'silence' | 'remap'.
   * @returns {Promise<{videoUrl: string, videoBuffer: Buffer, model: string}>}
   */
  async applyLipsync({ videoUrl, audioUrl, options = {} }) {
    if (!this.apiKey) throw new Error('FAL_GCS_API_KEY is not configured');
    if (!videoUrl) throw new Error('SyncLipsyncFalService: videoUrl is required');
    if (!audioUrl) throw new Error('SyncLipsyncFalService: audioUrl is required');

    const {
      syncMode = 'bounce'
    } = options;

    this.logger.info(`corrective lipsync pass — syncMode: ${syncMode}`);
    this.logger.info(`Source video: ${videoUrl.slice(0, 80)}...`);
    this.logger.info(`Target audio: ${audioUrl.slice(0, 80)}...`);

    const inputPayload = {
      video_url: videoUrl,
      audio_url: audioUrl,
      sync_mode: syncMode
    };

    const result = await this.run(inputPayload);

    // fal.ai Sync Lipsync v3 returns: { video: { url, ... } }
    const outVideoUrl = result?.video?.url;
    if (!outVideoUrl) {
      this.logger.error(`completed but no video URL: ${JSON.stringify(result)}`);
      throw new Error('Sync Lipsync v3 did not return a video URL');
    }

    const videoBuffer = await this.downloadToBuffer(outVideoUrl, 'video');

    return {
      videoUrl: outVideoUrl,
      videoBuffer,
      model: 'sync-lipsync-v3'
    };
  }
}

// Singleton export
const syncLipsyncFalService = new SyncLipsyncFalService();
export default syncLipsyncFalService;
export { SyncLipsyncFalService };
