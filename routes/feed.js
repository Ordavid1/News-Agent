/**
 * Feed API Routes
 *
 * Public endpoints serving the cross-user showcase feed of all
 * successfully published posts across the platform.
 */

import express from 'express';
import { supabaseAdmin } from '../services/supabase.js';
import rateLimit from 'express-rate-limit';

const router = express.Router();

// Rate limiter: generous but prevents abuse
const feedLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 60,
  message: { error: 'Too many requests. Please try again shortly.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const VIDEO_PLATFORMS = ['youtube', 'tiktok'];

/**
 * GET /api/feed
 *
 * Returns paginated feed of all successful published posts, cross-user.
 * Video posts (YouTube, TikTok) are floated to the top.
 *
 * Query params:
 *   - page     (default 1)
 *   - limit    (default 30, max 60)
 *   - platform (optional filter)
 */
router.get('/', feedLimiter, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(60, Math.max(1, parseInt(req.query.limit) || 30));
    const offset = (page - 1) * limit;
    const platformFilter = req.query.platform || null;

    let query = supabaseAdmin
      .from('published_posts')
      .select('id, platform, platform_url, content, topic, trend_topic, image_url, trend, published_at', { count: 'exact' })
      .eq('success', true)
      .not('platform_url', 'is', null)
      .order('published_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (platformFilter && typeof platformFilter === 'string') {
      query = query.eq('platform', platformFilter.toLowerCase());
    }

    const { data: posts, error, count } = await query;

    if (error) {
      console.error('[Feed] Query error:', error);
      return res.status(500).json({ error: 'Failed to fetch feed' });
    }

    // Enrich: resolve images from multiple sources, truncate content
    const enrichedPosts = (posts || []).map(post => {
      const enriched = { ...post };

      // Resolve image from fallback chain:
      // 1. image_url column (set by newer publish flows)
      // 2. trend JSONB → imageUrl (stored by automation for all historical posts)
      // 3. YouTube: derive thumbnail from platform_url
      if (!enriched.image_url && post.trend) {
        const trendObj = typeof post.trend === 'string' ? JSON.parse(post.trend) : post.trend;
        if (trendObj?.imageUrl) {
          enriched.image_url = trendObj.imageUrl;
        }
      }

      if (!enriched.image_url && post.platform === 'youtube' && post.platform_url) {
        const videoId = extractYouTubeVideoId(post.platform_url);
        if (videoId) {
          enriched.image_url = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
        }
      }

      // Truncate content for preview
      if (enriched.content && enriched.content.length > 280) {
        enriched.content_preview = enriched.content.substring(0, 280) + '...';
      } else {
        enriched.content_preview = enriched.content;
      }

      // Strip full content and raw trend from response to keep payload small
      delete enriched.content;
      delete enriched.trend;

      return enriched;
    });

    // Sort: video posts float to top, then by published_at desc
    enrichedPosts.sort((a, b) => {
      const aIsVideo = VIDEO_PLATFORMS.includes(a.platform) ? 1 : 0;
      const bIsVideo = VIDEO_PLATFORMS.includes(b.platform) ? 1 : 0;
      if (aIsVideo !== bIsVideo) return bIsVideo - aIsVideo;
      return new Date(b.published_at) - new Date(a.published_at);
    });

    res.json({
      posts: enrichedPosts,
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit),
        hasMore: offset + limit < (count || 0)
      }
    });

  } catch (error) {
    console.error('[Feed] Endpoint error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/feed/stats
 *
 * Aggregate stats for the feed header.
 */
router.get('/stats', feedLimiter, async (req, res) => {
  try {
    // Total successful posts with URLs
    const { count: totalPosts } = await supabaseAdmin
      .from('published_posts')
      .select('id', { count: 'exact', head: true })
      .eq('success', true)
      .not('platform_url', 'is', null);

    // Distinct platforms
    const { data: platformData } = await supabaseAdmin
      .from('published_posts')
      .select('platform')
      .eq('success', true)
      .not('platform_url', 'is', null);

    const uniquePlatforms = [...new Set((platformData || []).map(p => p.platform))];

    // Posts in last 24h
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count: recentPosts } = await supabaseAdmin
      .from('published_posts')
      .select('id', { count: 'exact', head: true })
      .eq('success', true)
      .gte('published_at', since24h);

    res.json({
      totalPosts: totalPosts || 0,
      activePlatforms: uniquePlatforms.length,
      platforms: uniquePlatforms,
      postsLast24h: recentPosts || 0
    });

  } catch (error) {
    console.error('[Feed] Stats error:', error);
    res.status(500).json({ error: 'Failed to fetch feed stats' });
  }
});

/**
 * Extract YouTube video ID from various URL formats.
 */
function extractYouTubeVideoId(url) {
  if (!url) return null;
  const patterns = [
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/,
    /youtube\.com\/watch\?v=([a-zA-Z0-9_-]+)/,
    /youtu\.be\/([a-zA-Z0-9_-]+)/
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

export default router;
