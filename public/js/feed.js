/**
 * Feed Module
 *
 * Renders the public showcase feed of all published posts across the platform.
 * Lazy-loaded when the Feed tab is first shown.
 */

// ============================================
// STATE
// ============================================

let feedLoaded = false;
let feedCurrentPage = 1;
let feedCurrentPlatform = '';
let feedAllPosts = [];
let feedHasMore = false;

// Platform display config
const FEED_PLATFORM_CONFIG = {
  twitter:   { name: 'Twitter / X', color: '#1DA1F2', bg: 'bg-[#1DA1F2]/10', text: 'text-[#1DA1F2]',
    svg: '<svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>' },
  linkedin:  { name: 'LinkedIn',  color: '#0A66C2', bg: 'bg-[#0A66C2]/10', text: 'text-[#0A66C2]',
    svg: '<svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>' },
  reddit:    { name: 'Reddit',    color: '#FF4500', bg: 'bg-[#FF4500]/10', text: 'text-[#FF4500]',
    svg: '<svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 0 0 .029-.463.33.33 0 0 0-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 0 0-.232-.095z"/></svg>' },
  telegram:  { name: 'Telegram',  color: '#0088cc', bg: 'bg-[#0088cc]/10', text: 'text-[#0088cc]',
    svg: '<svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>' },
  facebook:  { name: 'Facebook',  color: '#1877F2', bg: 'bg-[#1877F2]/10', text: 'text-[#1877F2]',
    svg: '<svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>' },
  threads:   { name: 'Threads',   color: '#000000', bg: 'bg-ink-900/10',    text: 'text-ink-800',
    svg: '<svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.03-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.589 12c.027 3.086.718 5.496 2.057 7.164 1.43 1.783 3.631 2.698 6.54 2.717 2.623-.02 4.358-.631 5.8-2.045 1.647-1.613 1.618-3.593 1.09-4.798-.31-.71-.873-1.3-1.634-1.75-.192 1.352-.622 2.446-1.284 3.272-.886 1.102-2.14 1.704-3.73 1.79-1.202.065-2.361-.218-3.259-.801-1.063-.689-1.685-1.74-1.752-2.96-.065-1.182.408-2.256 1.332-3.023.899-.746 2.13-1.109 3.79-1.083 1.03.016 1.98.108 2.855.27-.025-.996-.085-1.871-.478-2.59-.437-.798-1.182-1.186-2.275-1.186h-.039c-.844.008-1.54.263-2.07.759l-1.391-1.545c.857-.77 2.008-1.18 3.424-1.22h.062c1.734 0 3.088.587 4.024 1.746.838 1.035 1.241 2.474 1.2 4.28l.006.406c1.063.571 1.9 1.376 2.457 2.385.786 1.427.903 3.503-.487 5.869-1.837 3.122-5.139 4.039-8.478 4.057zm-1.391-8.23c-.936-.016-1.674.152-2.198.498-.46.303-.681.693-.66 1.16.037.794.759 1.399 1.867 1.338 1.112-.06 1.926-.478 2.42-1.241.364-.563.597-1.33.677-2.294-.668-.117-1.38-.18-2.106-.18v.72z"/></svg>' },
  whatsapp:  { name: 'WhatsApp',  color: '#25D366', bg: 'bg-[#25D366]/10', text: 'text-[#25D366]',
    svg: '<svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>' },
  instagram: { name: 'Instagram', color: '#E4405F', bg: 'bg-[#E4405F]/10', text: 'text-[#E4405F]',
    svg: '<svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0C8.74 0 8.333.015 7.053.072 5.775.132 4.905.333 4.14.63c-.789.306-1.459.717-2.126 1.384S.935 3.35.63 4.14C.333 4.905.131 5.775.072 7.053.012 8.333 0 8.74 0 12s.015 3.667.072 4.947c.06 1.277.261 2.148.558 2.913.306.788.717 1.459 1.384 2.126.667.666 1.336 1.079 2.126 1.384.766.296 1.636.499 2.913.558C8.333 23.988 8.74 24 12 24s3.667-.015 4.947-.072c1.277-.06 2.148-.262 2.913-.558.788-.306 1.459-.718 2.126-1.384.666-.667 1.079-1.335 1.384-2.126.296-.765.499-1.636.558-2.913.06-1.28.072-1.687.072-4.947s-.015-3.667-.072-4.947c-.06-1.277-.262-2.149-.558-2.913-.306-.789-.718-1.459-1.384-2.126C21.319 1.347 20.651.935 19.86.63c-.765-.297-1.636-.499-2.913-.558C15.667.012 15.26 0 12 0zm0 2.16c3.203 0 3.585.016 4.85.071 1.17.055 1.805.249 2.227.415.562.217.96.477 1.382.896.419.42.679.819.896 1.381.164.422.36 1.057.413 2.227.057 1.266.07 1.646.07 4.85s-.015 3.585-.074 4.85c-.061 1.17-.256 1.805-.421 2.227a3.81 3.81 0 01-.899 1.382 3.744 3.744 0 01-1.38.896c-.42.164-1.065.36-2.235.413-1.274.057-1.649.07-4.859.07-3.211 0-3.586-.015-4.859-.074-1.171-.061-1.816-.256-2.236-.421a3.716 3.716 0 01-1.379-.899 3.644 3.644 0 01-.9-1.38c-.165-.42-.359-1.065-.42-2.235-.045-1.26-.061-1.649-.061-4.844 0-3.196.016-3.586.061-4.861.061-1.17.255-1.814.42-2.234.21-.57.479-.96.9-1.381.419-.419.81-.689 1.379-.898.42-.166 1.051-.361 2.221-.421 1.275-.045 1.65-.06 4.859-.06l.045.03zm0 3.678c-3.405 0-6.162 2.76-6.162 6.162 0 3.405 2.76 6.162 6.162 6.162 3.405 0 6.162-2.76 6.162-6.162 0-3.405-2.76-6.162-6.162-6.162zM12 16c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4zm7.846-10.405c0 .795-.646 1.44-1.44 1.44-.795 0-1.44-.646-1.44-1.44 0-.794.646-1.439 1.44-1.439.793-.001 1.44.645 1.44 1.439z"/></svg>' },
  tiktok:    { name: 'TikTok',    color: '#010101', bg: 'bg-[#010101]/10', text: 'text-[#010101]',
    svg: '<svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1v-3.5a6.37 6.37 0 00-.79-.05A6.34 6.34 0 003.15 15.2a6.34 6.34 0 0010.86 4.46V13a8.28 8.28 0 005.58 2.15v-3.44a4.85 4.85 0 01-2.65-.78V6.69h2.65z"/></svg>' },
  youtube:   { name: 'YouTube',   color: '#FF0000', bg: 'bg-[#FF0000]/10', text: 'text-[#FF0000]',
    svg: '<svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>' }
};

// ============================================
// HELPERS
// ============================================

function getFeedApiUrl() {
  return window.location.origin + '/api/feed';
}

function feedTimeAgo(dateStr) {
  const now = new Date();
  const date = new Date(dateStr);
  const seconds = Math.floor((now - date) / 1000);

  if (seconds < 60)    return 'just now';
  if (seconds < 3600)  return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  if (seconds < 604800) return Math.floor(seconds / 86400) + 'd ago';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function feedEscapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function feedFormatNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000)    return (num / 1000).toFixed(1) + 'K';
  return num.toString();
}

// Video ID extraction for inline embeds
function extractYouTubeId(url) {
  if (!url) return null;
  const patterns = [
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/,
    /youtube\.com\/watch\?v=([a-zA-Z0-9_-]+)/,
    /youtu\.be\/([a-zA-Z0-9_-]+)/
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function extractTikTokId(url) {
  if (!url) return null;
  const m = url.match(/tiktok\.com\/@[^/]+\/video\/(\d+)/);
  return m ? m[1] : null;
}

/**
 * IntersectionObserver: auto-activate video embeds when they scroll into view.
 * Once activated, the iframe stays loaded (no deactivation on scroll-out).
 */
const feedVideoObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    const container = entry.target;
    const embedSrc = container.dataset.embedSrc;
    if (!embedSrc) return;

    // Stop observing — activate only once
    feedVideoObserver.unobserve(container);

    // Fixed height for both platforms — gives vertical Shorts/TikToks
    // room to display without making cards excessively tall in masonry
    const iframeClass = 'w-full';
    const iframeStyle = 'height:480px;';

    container.innerHTML = `<iframe
      src="${embedSrc}"
      frameborder="0" allow="autoplay; encrypted-media" allowfullscreen
      class="${iframeClass}" style="${iframeStyle}"></iframe>`;
    container.classList.remove('feed-video-trigger');
    container.classList.add('feed-video-embed');
  });
}, { rootMargin: '200px 0px', threshold: 0.1 });

/**
 * Build the embed src URL for a video post.
 */
function getVideoEmbedSrc(post) {
  if (post.platform === 'youtube') {
    const videoId = extractYouTubeId(post.platform_url);
    if (!videoId) return null;
    return `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&loop=1&playlist=${videoId}&playsinline=1&rel=0`;
  }
  if (post.platform === 'tiktok') {
    const postId = extractTikTokId(post.platform_url);
    if (!postId) return null;
    return `https://www.tiktok.com/player/v1/${postId}?autoplay=1&mute=1&loop=1&music_info=0&description=0&rel=0`;
  }
  return null;
}

// ============================================
// MAIN LOADER
// ============================================

async function loadFeedSection() {
  const container = document.getElementById('content-feed');
  if (!container) return;

  showFeedLoading(true);

  try {
    // Load stats and first page in parallel
    const [statsRes, postsRes] = await Promise.all([
      fetch(`${getFeedApiUrl()}/stats`).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`${getFeedApiUrl()}?page=1&limit=30${feedCurrentPlatform ? '&platform=' + feedCurrentPlatform : ''}`)
        .then(r => r.ok ? r.json() : null).catch(() => null)
    ]);

    // Render stats
    if (statsRes) {
      renderFeedStats(statsRes);
    }

    // Render posts
    if (postsRes && postsRes.posts && postsRes.posts.length > 0) {
      feedAllPosts = postsRes.posts;
      feedCurrentPage = 1;
      feedHasMore = postsRes.pagination.hasMore;
      renderFeedPosts(feedAllPosts, false);
      toggleFeedLoadMore(feedHasMore);
      document.getElementById('feedEmpty')?.classList.add('hidden');
    } else {
      const feedContent = document.getElementById('feedContent');
      if (feedContent) feedContent.innerHTML = '';
      document.getElementById('feedEmpty')?.classList.remove('hidden');
      toggleFeedLoadMore(false);
    }

    // Show upgrade CTA for free tier
    const tier = window.currentUser?.subscription?.tier || 'free';
    const cta = document.getElementById('feedUpgradeCta');
    if (cta) {
      cta.classList.toggle('hidden', tier !== 'free');
    }

    feedLoaded = true;

  } catch (error) {
    console.error('[Feed] Load error:', error);
    const feedContent = document.getElementById('feedContent');
    if (feedContent) {
      feedContent.innerHTML = `
        <div class="card-static p-8 text-center break-inside-avoid">
          <p class="text-ink-600 mb-4">Failed to load feed.</p>
          <button onclick="loadFeedSection()" class="btn-primary btn-sm">Retry</button>
        </div>`;
    }
  } finally {
    showFeedLoading(false);
  }
}

// ============================================
// RENDER
// ============================================

function renderFeedStats(stats) {
  const totalEl = document.getElementById('feedTotalPosts');
  const recentEl = document.getElementById('feedRecentPosts');

  if (totalEl) {
    totalEl.textContent = `${feedFormatNumber(stats.totalPosts)} posts published`;
  }
  if (recentEl && stats.postsLast24h > 0) {
    recentEl.textContent = `+${stats.postsLast24h} in 24h`;
    recentEl.classList.remove('hidden');
  }
}

function renderFeedPosts(posts, append) {
  const container = document.getElementById('feedContent');
  if (!container) return;

  if (!append) {
    container.innerHTML = '';
  }

  const fragment = document.createDocumentFragment();
  posts.forEach(post => {
    fragment.appendChild(createFeedCard(post));
  });
  container.appendChild(fragment);
}

function createFeedCard(post) {
  const config = FEED_PLATFORM_CONFIG[post.platform] || {
    name: post.platform, color: '#6B7280', bg: 'bg-gray-100', text: 'text-gray-600',
    svg: '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101"/></svg>'
  };
  const isVideo = ['youtube', 'tiktok'].includes(post.platform);

  // Determine if this video post can be embedded inline
  const canEmbed = isVideo && post.platform_url && (
    (post.platform === 'youtube' && extractYouTubeId(post.platform_url)) ||
    (post.platform === 'tiktok' && extractTikTokId(post.platform_url))
  );

  const card = document.createElement('div');
  card.className = 'overflow-hidden rounded-xl break-inside-avoid mb-4 hover:shadow-card-hover transition-all duration-200 group cursor-pointer bg-surface-0';
  card.style.border = `2px solid ${config.color}`;

  // Build image / video section
  let mediaHtml = '';
  const embedSrc = canEmbed ? getVideoEmbedSrc(post) : null;

  if (embedSrc) {
    // Video post → placeholder that auto-embeds when scrolled into view
    const thumbSrc = post.image_url ? feedEscapeHtml(post.image_url) : '';
    const thumbImg = thumbSrc
      ? `<img src="${thumbSrc}" alt="" class="w-full h-auto object-cover" loading="lazy"
              onerror="this.style.display='none'">`
      : '';

    const minHeight = 'height:480px;';

    mediaHtml = `
      <div class="feed-video-trigger relative overflow-hidden" data-embed-src="${feedEscapeHtml(embedSrc)}" data-embed-platform="${post.platform}" style="${minHeight}">
        ${thumbImg}
        <div class="absolute inset-0 flex items-center justify-center bg-black/10">
          <div class="w-12 h-12 rounded-full bg-white/80 flex items-center justify-center shadow animate-pulse">
            <svg class="w-6 h-6 text-ink-600 ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
          </div>
        </div>
        <div class="absolute bottom-2 left-2 inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-black/60 text-white">
          ${config.svg}
          ${post.platform === 'youtube' ? 'YouTube Short' : 'TikTok'}
        </div>
      </div>`;
  } else if (post.image_url) {
    // Non-video post or video without embeddable URL → static thumbnail
    const playOverlay = isVideo
      ? `<div class="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/30 transition-colors">
           <svg class="w-12 h-12 text-white/90 drop-shadow-lg" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
         </div>`
      : '';
    mediaHtml = `
      <div class="relative overflow-hidden">
        <img src="${feedEscapeHtml(post.image_url)}" alt="" class="w-full h-auto object-cover" loading="lazy"
             onerror="this.parentElement.remove()">
        ${playOverlay}
      </div>`;
  }

  // Build topic tag
  const topicText = post.topic || post.trend_topic || '';
  const topicHtml = topicText
    ? `<span class="text-xs text-ink-400 truncate max-w-[140px]">${feedEscapeHtml(topicText)}</span>`
    : '';

  card.innerHTML = `
    ${mediaHtml}
    <div class="p-4">
      <div class="flex items-center gap-2 mb-2">
        <span class="inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full ${config.bg} ${config.text}">
          ${config.svg}
          ${config.name}
        </span>
        <span class="text-xs text-ink-400 ml-auto flex-shrink-0">${feedTimeAgo(post.published_at)}</span>
      </div>
      ${post.content_preview ? `<p class="text-sm text-ink-700 leading-relaxed line-clamp-4 mb-3">${feedEscapeHtml(post.content_preview)}</p>` : ''}
      <div class="flex items-center justify-between">
        ${topicHtml}
        <a href="${feedEscapeHtml(post.platform_url)}" target="_blank" rel="noopener noreferrer"
           class="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700 opacity-0 group-hover:opacity-100 transition-opacity ml-auto">
          View Post
          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
        </a>
      </div>
    </div>`;

  // Click handling
  card.addEventListener('click', (e) => {
    // Let anchor links work normally
    if (e.target.closest('a')) return;
    // Don't navigate away when an iframe is playing
    if (e.target.closest('.feed-video-embed')) return;
    // Everything else → open platform URL externally
    if (post.platform_url) {
      window.open(post.platform_url, '_blank', 'noopener,noreferrer');
    }
  });

  // Register video trigger with IntersectionObserver for auto-embed
  // (must happen after innerHTML is set so the .feed-video-trigger element exists)
  if (embedSrc) {
    const trigger = card.querySelector('.feed-video-trigger');
    if (trigger) feedVideoObserver.observe(trigger);
  }

  return card;
}

// ============================================
// PAGINATION & FILTERING
// ============================================

async function loadMoreFeedPosts() {
  const btn = document.getElementById('feedLoadMoreBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Loading...';
  }

  try {
    feedCurrentPage++;
    const res = await fetch(
      `${getFeedApiUrl()}?page=${feedCurrentPage}&limit=30${feedCurrentPlatform ? '&platform=' + feedCurrentPlatform : ''}`
    );

    if (!res.ok) throw new Error('Fetch failed');
    const data = await res.json();

    if (data.posts && data.posts.length > 0) {
      feedAllPosts = feedAllPosts.concat(data.posts);
      renderFeedPosts(data.posts, true);
      feedHasMore = data.pagination.hasMore;
      toggleFeedLoadMore(feedHasMore);
    } else {
      toggleFeedLoadMore(false);
    }

  } catch (error) {
    console.error('[Feed] Load more error:', error);
    feedCurrentPage--;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Load More Posts';
    }
  }
}

function filterFeedByPlatform(platform) {
  feedCurrentPlatform = platform;
  feedCurrentPage = 1;
  feedAllPosts = [];
  feedLoaded = false;
  loadFeedSection();
}

// ============================================
// UI HELPERS
// ============================================

function showFeedLoading(show) {
  const loading = document.getElementById('feedLoading');
  const content = document.getElementById('feedContent');
  if (loading) loading.classList.toggle('hidden', !show);
  if (content) content.classList.toggle('hidden', show);
}

function toggleFeedLoadMore(show) {
  const el = document.getElementById('feedLoadMore');
  if (el) el.classList.toggle('hidden', !show);
}

// ============================================
// GLOBAL EXPORTS
// ============================================

window.loadFeedSection = loadFeedSection;
window.loadMoreFeedPosts = loadMoreFeedPosts;
window.filterFeedByPlatform = filterFeedByPlatform;
