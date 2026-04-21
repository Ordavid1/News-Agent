// services/beat-generators/TextOverlayCardGenerator.js
// V4 TEXT_OVERLAY_CARD beat generator — pure ffmpeg, no API cost.
//
// Renders title/chapter/location/epigraph/logo_reveal cards as standalone
// video clips that slot into the episode timeline like any other beat.
// These are the "THREE WEEKS LATER" cards, the chapter dividers, the brand
// logo reveal at episode end.
//
// Strategy: render the card as an SVG → convert to PNG via sharp → generate
// an MP4 of configurable duration with the PNG as the entire visible frame.
// ffmpeg's `-loop 1 -t duration` with an image input is the canonical way.
//
// The existing `_addTitleAndEndCards()` logic at BrandStoryService.js:3316
// already uses sharp → PNG → ffmpeg overlay for episode-level title/end
// cards. This generator borrows the same pattern but outputs a standalone
// clip instead of overlaying on an existing video.

import BaseBeatGenerator from './BaseBeatGenerator.js';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

// Style presets — maps beat.style to visual treatment
const STYLE_PRESETS = {
  title: {
    bg: 'black',
    fontSize: 84,
    fontColor: '#FFFFFF',
    fontWeight: 'bold',
    maxWidth: 900
  },
  chapter: {
    bg: 'black',
    fontSize: 72,
    fontColor: '#F5C518', // warm gold
    fontWeight: 'normal',
    maxWidth: 900
  },
  location: {
    bg: 'transparent',
    fontSize: 56,
    fontColor: '#FFFFFF',
    fontWeight: 'normal',
    maxWidth: 900
  },
  epigraph: {
    bg: 'dark_scrim',
    fontSize: 48,
    fontColor: '#E0E0E0',
    fontWeight: 'italic',
    maxWidth: 800
  },
  logo_reveal: {
    bg: 'black',
    fontSize: 96,
    fontColor: '#FFFFFF',
    fontWeight: 'bold',
    maxWidth: 900
  }
};

// Resolution for output clips — matches v3 episode resolution
const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1920;
const OUTPUT_FPS = 30;

class TextOverlayCardGenerator extends BaseBeatGenerator {
  static beatTypes() {
    return ['TEXT_OVERLAY_CARD'];
  }

  static estimateCost() {
    // ffmpeg is free
    return 0;
  }

  async _doGenerate({ beat }) {
    const { ffmpeg: ffmpegDeps } = this.deps;

    if (!beat.text) throw new Error(`beat ${beat.beat_id}: TEXT_OVERLAY_CARD requires text field`);

    const style = STYLE_PRESETS[beat.style] || STYLE_PRESETS.title;
    const duration = Math.max(1, Math.min(5, beat.duration_seconds || 2));
    const position = beat.position || 'center';
    const background = beat.background || style.bg;

    // Render text as SVG → PNG via sharp (which BrandStoryService already uses)
    const pngBuffer = await this._renderCardPng({ text: beat.text, style, background, position });

    // ffmpeg: still image → mp4 of specified duration
    const tmpDir = os.tmpdir();
    const runId = crypto.randomBytes(4).toString('hex');
    const pngPath = path.join(tmpDir, `v4-card-${runId}.png`);
    const mp4Path = path.join(tmpDir, `v4-card-${runId}.mp4`);

    try {
      fs.writeFileSync(pngPath, pngBuffer);

      // ffmpeg arg ordering is strict: ALL input specifications (with their
      // own -i flags) must come before ANY output options, otherwise an
      // output option like -vf gets misattributed to the next input.
      //
      // Previous order was:
      //   -loop 1 -i png [output opts incl. -vf] -f lavfi -i anullsrc [output opts]
      // Which made ffmpeg 8.1 attribute -vf to the anullsrc input and throw:
      //   "Option vf cannot be applied to input url anullsrc=..."
      //
      // Fixed order: [input#0 png] [input#1 anullsrc] [output opts] outfile
      //
      // Also: the PNG is already rendered at OUTPUT_WIDTH×OUTPUT_HEIGHT by
      // sharp (see _renderCardPng), so the scale+pad -vf is redundant on
      // the happy path. We keep it as a defensive-coding safety net in case
      // the SVG template ever drifts from 1080×1920, but it's a no-op today.
      // -vf now lives in its correct spot (after both inputs).
      execFileSync('ffmpeg', [
        '-y',
        // --- input 0: looping still image ---
        '-loop', '1',
        '-t', String(duration),
        '-i', pngPath,
        // --- input 1: silent stereo audio bed ---
        '-f', 'lavfi',
        '-t', String(duration),
        '-i', `anullsrc=channel_layout=stereo:sample_rate=44100`,
        // --- output options ---
        '-vf', `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease,pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black`,
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-r', String(OUTPUT_FPS),
        '-c:a', 'aac',
        '-shortest',
        mp4Path
      ], { stdio: ['ignore', 'ignore', 'pipe'] });

      const videoBuffer = fs.readFileSync(mp4Path);

      this.logger.info(`[${beat.beat_id}] text card rendered (${beat.style || 'title'}, ${duration}s, ${(videoBuffer.length / 1024).toFixed(0)}KB)`);

      return {
        videoBuffer,
        durationSec: duration,
        modelUsed: 'ffmpeg/text-card',
        costUsd: 0,
        metadata: {
          style: beat.style || 'title',
          text: beat.text,
          position,
          background
        }
      };
    } finally {
      // Cleanup tmp files
      try { if (fs.existsSync(pngPath)) fs.unlinkSync(pngPath); } catch {}
      try { if (fs.existsSync(mp4Path)) fs.unlinkSync(mp4Path); } catch {}
    }
  }

  /**
   * Render the card as a PNG buffer using sharp + SVG.
   * Uses the same pattern as BrandStoryService._addTitleAndEndCards().
   */
  async _renderCardPng({ text, style, background, position }) {
    let sharp;
    try {
      sharp = (await import('sharp')).default;
    } catch (err) {
      throw new Error('TextOverlayCardGenerator requires the `sharp` package (already used by _addTitleAndEndCards)');
    }

    const width = OUTPUT_WIDTH;
    const height = OUTPUT_HEIGHT;

    // Background fill
    let bgFill;
    let bgOpacity = 1.0;
    if (background === 'black' || background === 'dark_scrim') {
      bgFill = '#000000';
      if (background === 'dark_scrim') bgOpacity = 0.75;
    } else if (background === 'transparent') {
      bgFill = '#000000';
      bgOpacity = 0.0;
    } else {
      bgFill = background.startsWith('#') ? background : '#000000';
    }

    // Text positioning
    let textY;
    if (position === 'center') textY = height / 2;
    else if (position === 'lower_left' || position === 'lower_right') textY = height * 0.85;
    else if (position === 'upper_left' || position === 'upper_right') textY = height * 0.15;
    else textY = height / 2;

    let textX;
    if (position === 'lower_left' || position === 'upper_left') textX = 100;
    else if (position === 'lower_right' || position === 'upper_right') textX = width - 100;
    else textX = width / 2;

    let textAnchor;
    if (position.includes('left')) textAnchor = 'start';
    else if (position.includes('right')) textAnchor = 'end';
    else textAnchor = 'middle';

    // Escape XML chars in text
    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

    const fontStyle = style.fontWeight === 'italic' ? 'italic' : 'normal';
    const fontWeight = style.fontWeight === 'bold' ? '700' : '400';

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <rect width="100%" height="100%" fill="${bgFill}" fill-opacity="${bgOpacity}"/>
      <text x="${textX}" y="${textY}"
            font-family="Helvetica, Arial, sans-serif"
            font-size="${style.fontSize}"
            font-weight="${fontWeight}"
            font-style="${fontStyle}"
            fill="${style.fontColor}"
            text-anchor="${textAnchor}"
            dominant-baseline="middle">${escaped}</text>
    </svg>`;

    return await sharp(Buffer.from(svg)).png().toBuffer();
  }
}

export default TextOverlayCardGenerator;
export { TextOverlayCardGenerator };
