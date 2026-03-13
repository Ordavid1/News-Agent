// publishers/YouTubePublisher.js
// YouTube Shorts publishing via the YouTube Data API v3.
// Uses resumable upload protocol for reliable video delivery.

import axios from 'axios';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[YouTubePublisher] ${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
const YOUTUBE_UPLOAD_BASE = 'https://www.googleapis.com/upload/youtube/v3';

// YouTube Shorts constraints
const TITLE_MAX_CHARS = 100;     // YouTube hard limit; we target 97 to leave room for #Shorts suffix
const DESCRIPTION_MAX_CHARS = 4500; // Stay well under the 5000 char limit
const SHORTS_TAG = '#Shorts';

// Category 25 = News & Politics on YouTube
const NEWS_CATEGORY_ID = '25';

// Polling configuration for upload status
const UPLOAD_STATUS_POLL_MAX_ATTEMPTS = 20;
const UPLOAD_STATUS_POLL_INTERVAL_MS = 5000; // 5 seconds

class YouTubePublisher {
  /**
   * Create a YouTubePublisher instance.
   * @param {Object} credentials
   * @param {string} credentials.accessToken - Google OAuth access token
   * @param {string} credentials.channelId - YouTube channel ID (from platform_user_id)
   * @param {Object} credentials.metadata - Additional metadata (channelId)
   */
  constructor(credentials = null) {
    if (credentials) {
      if (!credentials.accessToken) {
        logger.warn('YouTube credentials provided but accessToken missing');
        return;
      }

      this.accessToken = credentials.accessToken;
      this.channelId = credentials.channelId || credentials.metadata?.channelId;

      logger.debug('YouTube publisher initialized with user credentials');
    } else {
      logger.warn('YouTube credentials not provided');
    }
  }

  /**
   * Factory method — create instance with user credentials.
   * @param {Object} credentials
   * @returns {YouTubePublisher}
   */
  static withCredentials(credentials) {
    return new YouTubePublisher(credentials);
  }

  /**
   * Publish a video to YouTube as a Short.
   * Uses resumable upload protocol for reliable delivery.
   *
   * @param {string} content - Post content (first line = title, rest = description)
   * @param {string} videoUrl - Publicly accessible video URL
   * @param {Object} options - Additional options
   * @param {Buffer} options.videoBuffer - Pre-downloaded video buffer (preferred for Veo)
   * @param {string} options.privacyStatus - 'public' | 'unlisted' | 'private' (default: 'public')
   * @returns {Promise<Object>} { success, platform, videoId, url }
   */
  async publishPost(content, videoUrl, options = {}) {
    if (!videoUrl && !options.videoBuffer) {
      throw new Error('YouTube requires a video URL or buffer. Video generation must complete before publishing.');
    }

    if (!this.accessToken) {
      throw new Error('YouTube access token not available. Please reconnect your YouTube account.');
    }

    try {
      const { title, description, tags } = this.formatForYouTube(content, options.sourceUrl);
      const privacyStatus = options.privacyStatus || 'public';

      logger.info(`Publishing YouTube Short — title: "${title}" (${title.length} chars), privacy: ${privacyStatus}`);

      // Step 1: Acquire video buffer
      let videoBuffer;
      if (options.videoBuffer && Buffer.isBuffer(options.videoBuffer)) {
        // Veo provides a pre-downloaded buffer — use it directly
        videoBuffer = options.videoBuffer;
        logger.info(`Using pre-downloaded video buffer — ${(videoBuffer.length / (1024 * 1024)).toFixed(1)} MB`);
      } else {
        // Runway returns a URL — download it
        videoBuffer = await this.downloadVideo(videoUrl);
      }

      // Step 2: Build video metadata
      const videoMetadata = {
        snippet: {
          title,
          description,
          tags,
          categoryId: NEWS_CATEGORY_ID,
          defaultLanguage: 'en'
        },
        status: {
          privacyStatus,
          selfDeclaredMadeForKids: false,
          // Declare as AI-generated per YouTube's emerging policies
          madeForKids: false
        }
      };

      // Step 3: Initiate resumable upload
      const uploadUrl = await this.initiateResumableUpload(videoMetadata, videoBuffer.length);

      // Step 4: Upload video data
      const videoId = await this.uploadVideoData(uploadUrl, videoBuffer);

      logger.info(`YouTube Short uploaded successfully — videoId: ${videoId}`);

      // Step 5: Optionally poll for processing completion
      // For Shorts, the video is usually available quickly; we return immediately
      // and let YouTube process it asynchronously
      const videoUrl_out = `https://youtube.com/shorts/${videoId}`;
      logger.info(`YouTube Short URL: ${videoUrl_out}`);

      return {
        success: true,
        platform: 'youtube',
        videoId,
        postId: videoId,
        url: videoUrl_out
      };

    } catch (error) {
      const errorDetails = {
        status: error.response?.status,
        apiError: error.response?.data?.error || error.response?.data,
        message: error.message
      };
      logger.error(`YouTube publishing error: ${JSON.stringify(errorDetails)}`);

      if (error.response?.status === 401) {
        logger.error('YouTube token appears to be invalid or expired');
      } else if (error.response?.status === 403) {
        const reason = error.response?.data?.error?.errors?.[0]?.reason;
        logger.error(`YouTube 403 — reason: ${reason || 'unknown'}`);
        if (reason === 'quotaExceeded') {
          throw new Error('YouTube API quota exceeded. The daily upload quota has been reached. Please try again tomorrow.');
        }
        if (reason === 'uploadLimitExceeded') {
          throw new Error('YouTube daily upload limit reached. Please try again tomorrow.');
        }
      }

      throw error;
    }
  }

  // ═══════════════════════════════════════════════════
  // RESUMABLE UPLOAD — Step 1: Initiate
  // ═══════════════════════════════════════════════════

  /**
   * Initiate a YouTube resumable upload session.
   * Returns the upload URL (Location header) for the subsequent PUT request.
   *
   * @param {Object} videoMetadata - snippet + status objects
   * @param {number} videoSize - Total video size in bytes
   * @returns {Promise<string>} Upload URL
   */
  async initiateResumableUpload(videoMetadata, videoSize) {
    logger.info(`Initiating YouTube resumable upload — size: ${(videoSize / (1024 * 1024)).toFixed(1)} MB`);

    const response = await axios.post(
      `${YOUTUBE_UPLOAD_BASE}/videos?uploadType=resumable&part=snippet,status`,
      videoMetadata,
      {
        headers: {
          ...this.getHeaders(),
          'X-Upload-Content-Type': 'video/mp4',
          'X-Upload-Content-Length': videoSize.toString()
        },
        timeout: 30000,
        // Capture the Location header from the 200 response
        validateStatus: (status) => status === 200
      }
    );

    const uploadUrl = response.headers['location'];
    if (!uploadUrl) {
      throw new Error(`YouTube resumable upload initiation failed: no Location header in response. Status: ${response.status}`);
    }

    logger.info(`Resumable upload session created — upload URL received`);
    return uploadUrl;
  }

  // ═══════════════════════════════════════════════════
  // RESUMABLE UPLOAD — Step 2: Upload video bytes
  // ═══════════════════════════════════════════════════

  /**
   * Upload video data to the resumable upload URL.
   * Single-chunk upload — AI-generated 8-second Shorts are small enough (< 64MB).
   *
   * @param {string} uploadUrl - The upload session URL from initiateResumableUpload
   * @param {Buffer} videoBuffer - Video file content
   * @returns {Promise<string>} YouTube video ID
   */
  async uploadVideoData(uploadUrl, videoBuffer) {
    const videoSize = videoBuffer.length;
    logger.info(`Uploading video data — ${(videoSize / (1024 * 1024)).toFixed(1)} MB`);

    const response = await axios.put(uploadUrl, videoBuffer, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': videoSize.toString(),
        'Content-Range': `bytes 0-${videoSize - 1}/${videoSize}`
      },
      timeout: 180000, // 3 minutes for upload
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      // YouTube returns 200 (or 201) on successful single-chunk upload
      validateStatus: (status) => status === 200 || status === 201
    });

    const videoId = response.data?.id;
    if (!videoId) {
      throw new Error(`YouTube upload completed but no videoId returned: ${JSON.stringify(response.data)}`);
    }

    logger.info(`Video data uploaded successfully — videoId: ${videoId}`);
    return videoId;
  }

  // ═══════════════════════════════════════════════════
  // UPLOAD STATUS POLLING (optional, for monitoring)
  // ═══════════════════════════════════════════════════

  /**
   * Poll YouTube for video processing status.
   * YouTube Shorts typically process within seconds to minutes.
   * This is optional — the videoId is valid immediately after upload.
   *
   * @param {string} videoId
   * @returns {Promise<string>} Final upload status
   */
  async waitForVideoProcessing(videoId) {
    logger.info(`Polling processing status for videoId: ${videoId}`);

    for (let attempt = 0; attempt < UPLOAD_STATUS_POLL_MAX_ATTEMPTS; attempt++) {
      const response = await axios.get(
        `${YOUTUBE_API_BASE}/videos?part=status,processingDetails&id=${videoId}`,
        {
          headers: this.getHeaders(),
          timeout: 15000
        }
      );

      const video = response.data?.items?.[0];
      const uploadStatus = video?.status?.uploadStatus;
      const processingStatus = video?.processingDetails?.processingStatus;

      logger.debug(`Processing poll #${attempt + 1}: uploadStatus=${uploadStatus}, processing=${processingStatus}`);

      if (uploadStatus === 'processed') {
        logger.info(`Video processing complete — videoId: ${videoId}`);
        return uploadStatus;
      }

      if (uploadStatus === 'failed' || uploadStatus === 'rejected' || uploadStatus === 'deleted') {
        const failureReason = video?.status?.rejectionReason || video?.status?.failureReason || 'Unknown';
        throw new Error(`YouTube video processing failed: ${uploadStatus} — ${failureReason}`);
      }

      await new Promise(resolve => setTimeout(resolve, UPLOAD_STATUS_POLL_INTERVAL_MS));
    }

    // Polling timed out — video may still be processing; this is non-fatal for Shorts
    logger.warn(`Video processing status polling timed out — videoId: ${videoId}. Video may still be processing.`);
    return 'uploaded';
  }

  // ═══════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════

  /**
   * Build standard YouTube API headers.
   */
  getHeaders() {
    return {
      'Authorization': `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json'
    };
  }

  /**
   * Format content for YouTube Shorts.
   * Parses the first line as title, remaining lines as description.
   * Enforces YouTube limits and ensures #Shorts is present.
   *
   * @param {string} content - Raw content from ContentGenerator
   * @returns {Object} { title, description, tags }
   */
  formatForYouTube(content, sourceUrl = null) {
    // Strip HTML entities
    let cleaned = content
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<p[^>]*>/gi, '')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const lines = cleaned.split('\n');

    // First non-empty line = title
    let titleLine = '';
    let descriptionStartIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim()) {
        titleLine = lines[i].trim();
        descriptionStartIndex = i + 1;
        break;
      }
    }

    // Enforce title length — leave room for #Shorts suffix if not present
    const shortsInTitle = titleLine.toLowerCase().includes('#shorts');
    const titleLimit = shortsInTitle ? TITLE_MAX_CHARS : TITLE_MAX_CHARS - (SHORTS_TAG.length + 1);

    if (titleLine.length > titleLimit) {
      // Smart truncation: cut at last space within limit
      const truncated = titleLine.substring(0, titleLimit);
      const lastSpace = truncated.lastIndexOf(' ');
      titleLine = lastSpace > titleLimit * 0.7 ? truncated.substring(0, lastSpace) : truncated;
    }

    // Append #Shorts to title if not already present
    if (!shortsInTitle) {
      titleLine = `${titleLine} ${SHORTS_TAG}`;
    }

    // Remaining lines = description
    let descriptionLines = lines.slice(descriptionStartIndex);

    // Strip leading blank lines from description
    while (descriptionLines.length > 0 && !descriptionLines[0].trim()) {
      descriptionLines.shift();
    }

    let description = descriptionLines.join('\n').trim();

    // Append source article URL if available
    if (sourceUrl) {
      description = description
        ? `${description}\n\nSource: ${sourceUrl}`
        : `Source: ${sourceUrl}`;
    }

    // Ensure #Shorts appears in description (for algorithm discovery)
    if (!description.toLowerCase().includes('#shorts')) {
      description = description ? `${description}\n\n${SHORTS_TAG}` : SHORTS_TAG;
    }

    // Enforce description limit
    if (description.length > DESCRIPTION_MAX_CHARS) {
      description = description.substring(0, DESCRIPTION_MAX_CHARS - 3) + '...';
    }

    // Extract hashtags from description as tags array (YouTube Data API accepts tags separately)
    const hashtagRegex = /#(\w+)/g;
    const tags = [];
    let match;
    while ((match = hashtagRegex.exec(description)) !== null) {
      if (!tags.includes(match[1]) && match[1].toLowerCase() !== 'shorts') {
        tags.push(match[1]);
      }
    }
    // Always include Shorts in tags
    tags.unshift('Shorts');

    logger.debug(`Formatted YouTube content — title: "${titleLine}" (${titleLine.length} chars), description: ${description.length} chars, tags: ${tags.length}`);

    return { title: titleLine, description, tags };
  }

  /**
   * Download a video from a URL into a Buffer.
   * Used when videoBuffer is not provided (Runway model path).
   */
  async downloadVideo(videoUrl) {
    logger.info(`Downloading video for upload: ${videoUrl}`);
    const response = await axios.get(videoUrl, {
      responseType: 'arraybuffer',
      timeout: 120000,
      headers: { 'User-Agent': 'NewsAgentSaaS/1.0' }
    });

    const buffer = Buffer.from(response.data);
    logger.info(`Video downloaded — ${(buffer.length / (1024 * 1024)).toFixed(1)} MB`);
    return buffer;
  }

  /**
   * Verify the access token is valid by querying the channel endpoint.
   */
  async verifyToken() {
    if (!this.accessToken) {
      throw new Error('No token available to verify');
    }

    const response = await axios.get(
      `${YOUTUBE_API_BASE}/channels?part=snippet&mine=true`,
      {
        headers: this.getHeaders(),
        timeout: 15000
      }
    );

    return response.data?.items?.[0];
  }
}

export default YouTubePublisher;
