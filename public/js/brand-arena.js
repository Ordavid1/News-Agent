/**
 * Brand Arena Tab Controller
 *
 * Owns the Brand Arena top-level tab and its four sub-tabs:
 *   Brand Voice / Brand Assets / Playables / Brand Story
 *
 * The four panels were previously sub-tabs of Marketing Pro+ scoped to a Meta
 * `ad_accounts.id`. They have been decoupled: the backend now accepts a null
 * `ad_account_id` and returns user-scoped data, so a user can produce brand
 * creatives without ever connecting Meta.
 *
 * The actual data loaders (`loadBrandVoiceProfiles`, `loadMediaAssets`,
 * `loadPlayables`, `loadBrandStories`) live in `marketing.js` and are reused
 * verbatim — they automatically omit the `adAccountId` query param when no
 * ad account is selected.
 *
 * This module only handles tab visibility (CSS class swap on `.ba-tab-*`)
 * and dispatch.
 */

(function () {
  'use strict';

  /**
   * Show the named Brand Arena sub-tab.
   * Mirrors `showMarketingTab` but operates on `ba-` prefixed selectors and
   * does NOT gate on a Meta ad account.
   */
  function showBrandArenaTab(tabName) {
    document.querySelectorAll('.ba-tab-content').forEach((el) => {
      el.classList.add('hidden');
    });
    document.querySelectorAll('.ba-tab-btn').forEach((btn) => {
      btn.classList.remove('tab-active');
    });

    const selectedContent = document.getElementById(`ba-content-${tabName}`);
    if (selectedContent) selectedContent.classList.remove('hidden');

    const selectedBtn = document.getElementById(`ba-tab-${tabName}`);
    if (selectedBtn) selectedBtn.classList.add('tab-active');

    // Brand Story is gated to Business-tier users only — same enforcement as in
    // Marketing Pro+. The function lives in marketing.js and is exposed globally.
    if (tabName === 'brandstory' && typeof window.enforceBrandStoryTierAccess === 'function') {
      if (!window.enforceBrandStoryTierAccess()) return;
    }

    // Dispatch to the existing loader. Each loader transparently handles a
    // null `selectedAdAccount` and omits `adAccountId` from its API calls.
    switch (tabName) {
      case 'brandvoice':
        if (typeof window.loadBrandVoiceProfiles === 'function') window.loadBrandVoiceProfiles();
        break;
      case 'mediaassets':
        if (typeof window.loadMediaAssets === 'function') window.loadMediaAssets();
        break;
      case 'playables':
        if (typeof window.loadPlayables === 'function') window.loadPlayables();
        break;
      case 'brandstory':
        if (typeof window.loadBrandStories === 'function') window.loadBrandStories();
        break;
    }
  }

  // Expose globally so inline `onclick="showBrandArenaTab(...)"` and
  // `showTab('brandarena')` can invoke it.
  window.showBrandArenaTab = showBrandArenaTab;
})();
