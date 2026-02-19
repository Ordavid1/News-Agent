// marketing.js - Marketing dashboard logic (embedded in profile.html)
//
// Shared variables (csrfToken, currentUser) and CSRF functions are provided
// by profile.js. Marketing init is triggered via the showTab wrapper in
// profile.html when the Marketing tab is shown.

// Marketing-specific state
var adAccounts = [];
var selectedAdAccount = null;
var marketingAddonLimits = { maxAdAccounts: 1 };
var boostablePosts = [];
var campaigns = [];
var audiences = [];
var rules = [];
var overviewData = null;

// Current modal state
var currentBoostPost = null;
var editingAudienceId = null;
var editingRuleId = null;

// Boost builder state
var boostLocations = [];
var boostInterests = [];

// Audience builder state
var audienceLocations = [];
var audienceInterests = [];

// Search debounce timers
var locationSearchTimer = null;
var interestSearchTimer = null;

// ============================================
// INITIALIZATION
// ============================================

// Marketing initialization - called from DOMContentLoaded or profile.js
async function initMarketing() {
    // Detect if user just returned from marketing payment
    const urlParams = new URLSearchParams(window.location.search);
    const isPaymentReturn = urlParams.get('payment') === 'marketing_success';

    // Check marketing addon status
    let hasAddon = await checkMarketingAddon();

    // If returning from payment but addon not active yet, the webhook
    // may not have arrived. Poll a few times before giving up.
    if (!hasAddon && isPaymentReturn) {
        hasAddon = await pollForMarketingAddon();

        // Clean the payment param from URL regardless of outcome
        const cleanUrl = new URL(window.location);
        cleanUrl.searchParams.delete('payment');
        window.history.replaceState({}, document.title, cleanUrl.pathname + cleanUrl.search);
    }

    if (hasAddon) {
        // Load ad accounts first
        await loadAdAccounts();

        // Load initial data
        await loadOverview();
    }
}

/**
 * Poll for marketing addon activation after payment redirect.
 * The Lemon Squeezy webhook may take a few seconds to arrive and be processed.
 */
async function pollForMarketingAddon() {
    const banner = document.getElementById('addonRequiredBanner');
    const activeBanner = document.getElementById('addonActiveBanner');

    // Show a processing state in the purchase banner
    if (banner) {
        banner.classList.remove('hidden');
        banner.innerHTML = `
            <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
                    <div class="loader-sm"></div>
                </div>
                <div>
                    <h4 class="font-semibold text-ink-800">Activating Marketing Add-on...</h4>
                    <p class="text-sm text-ink-500">Your payment was received. Setting up your marketing tools — this usually takes a few seconds.</p>
                </div>
            </div>
        `;
    }
    if (activeBanner) activeBanner.classList.add('hidden');

    // Poll up to 10 times with 3-second intervals (30 seconds total)
    for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        const active = await checkMarketingAddon();
        if (active) {
            showToast('Marketing add-on activated successfully!', 'success');
            return true;
        }
    }

    // Still not active after polling — restore the original purchase banner
    if (banner) {
        banner.innerHTML = `
            <div class="flex items-center justify-between">
                <div class="flex items-center gap-3">
                    <div class="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
                        <svg class="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>
                        </svg>
                    </div>
                    <div>
                        <h4 class="font-semibold text-ink-800">Payment Processing</h4>
                        <p class="text-sm text-ink-500">Your payment was received but activation is still processing. Please refresh the page in a minute or contact support if it doesn't activate.</p>
                    </div>
                </div>
                <button onclick="location.reload()" class="btn-primary btn-sm whitespace-nowrap">
                    Refresh
                </button>
            </div>
        `;
    }
    return false;
}

// DOMContentLoaded: set up event listeners that don't depend on marketing init
document.addEventListener('DOMContentLoaded', () => {
    // Boost cost update listeners
    ['boostBudget', 'boostStartDate', 'boostEndDate'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', updateBoostCostSummary);
    });
    document.querySelectorAll('input[name="budgetType"]').forEach(radio => {
        radio.addEventListener('change', updateBoostCostSummary);
    });
});

// ============================================
// MARKETING ADDON CHECK
// ============================================

async function checkMarketingAddon() {
    const token = localStorage.getItem('token');
    try {
        const response = await fetch('/api/subscriptions/marketing-addon', {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (response.ok) {
            const data = await response.json();
            if (data.addon && data.addon.status === 'active') {
                // Store addon limits for use in UI enforcement
                marketingAddonLimits = {
                    maxAdAccounts: data.addon.max_ad_accounts || 1
                };

                // Hide the purchase banner
                document.getElementById('addonRequiredBanner').classList.add('hidden');

                // Show the active banner with green theme
                const activeBanner = document.getElementById('addonActiveBanner');
                if (activeBanner) {
                    activeBanner.classList.remove('hidden');
                    populateAdAccountDropdown();
                }

                return true;
            }
        }
    } catch (error) {
        console.error('Error checking marketing addon:', error);
    }

    // Show addon required banner, hide active banner
    document.getElementById('addonRequiredBanner').classList.remove('hidden');
    const activeBanner = document.getElementById('addonActiveBanner');
    if (activeBanner) activeBanner.classList.add('hidden');
    return false;
}

async function purchaseAddon() {
    const token = localStorage.getItem('token');
    try {
        const response = await fetch('/api/subscriptions/marketing-checkout', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'X-CSRF-Token': getCsrfToken()
            }
        });

        if (response.ok) {
            const data = await response.json();
            if (data.checkoutUrl) {
                window.location.href = data.checkoutUrl;
            }
        } else {
            const err = await response.json();
            showToast(err.error || 'Failed to start checkout', 'error');
        }
    } catch (error) {
        showToast('Network error. Please try again.', 'error');
    }
}

async function cancelAddon() {
    if (!confirm('Are you sure you want to cancel your Marketing add-on? You will lose access to all marketing features at the end of your current billing period.')) {
        return;
    }

    const btn = document.getElementById('cancelAddonBtn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Cancelling...';
    }

    const token = localStorage.getItem('token');
    try {
        const response = await fetch('/api/subscriptions/marketing-cancel', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'X-CSRF-Token': getCsrfToken()
            }
        });

        if (response.ok) {
            showToast('Marketing add-on cancelled. Access continues until end of billing period.', 'success');
            // Re-check addon status to update the banner
            await checkMarketingAddon();
        } else {
            const err = await response.json();
            showToast(err.error || 'Failed to cancel add-on', 'error');
        }
    } catch (error) {
        showToast('Network error. Please try again.', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Cancel Subscription';
        }
    }
}

// ============================================
// AD ACCOUNT MANAGEMENT
// ============================================

async function loadAdAccounts() {
    const token = localStorage.getItem('token');
    try {
        const response = await apiGet('/api/marketing/ad-accounts');
        if (response.success) {
            adAccounts = response.accounts || [];
            selectedAdAccount = adAccounts.find(a => a.is_selected);

            if (!selectedAdAccount && adAccounts.length === 0) {
                showAdAccountBanner('No ad account found. Connect your Facebook account with marketing permissions.', true);
            } else if (!selectedAdAccount && adAccounts.length > 0) {
                showAdAccountBanner('Please select an ad account to use for marketing.', false);
            } else {
                document.getElementById('adAccountBanner').classList.add('hidden');
            }
        }
    } catch (error) {
        console.error('Error loading ad accounts:', error);
    }
}

function showAdAccountBanner(message, needsSetup) {
    const banner = document.getElementById('adAccountBanner');
    const messageEl = document.getElementById('adAccountBannerMessage');
    const btn = document.getElementById('setupAdAccountBtn');

    banner.classList.remove('hidden');
    messageEl.textContent = message;
    btn.textContent = needsSetup ? 'Set Up Now' : 'Select Account';
}

async function setupAdAccount() {
    if (adAccounts.length === 0) {
        // Need to initiate marketing OAuth flow
        const token = localStorage.getItem('token');
        try {
            const response = await fetch('/api/connections/facebook/marketing/initiate', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (response.ok) {
                const data = await response.json();
                if (data.authUrl) {
                    window.location.href = data.authUrl;
                }
            } else {
                const err = await response.json();
                showToast(err.error || 'Failed to start marketing setup', 'error');
            }
        } catch (error) {
            showToast('Network error. Please try again.', 'error');
        }
    } else {
        // Select first available account
        try {
            const response = await apiPost(`/api/marketing/ad-accounts/${adAccounts[0].id}/select`);
            if (response.success) {
                await loadAdAccounts();
                showToast('Ad account selected', 'success');
            }
        } catch (error) {
            showToast('Failed to select ad account', 'error');
        }
    }
}

// ============================================
// AD ACCOUNT DROPDOWN (Banner)
// ============================================

function toggleAdAccountDropdown() {
    const dropdown = document.getElementById('adAccountDropdown');
    const chevron = document.getElementById('adAccountChevron');
    const isOpen = !dropdown.classList.contains('hidden');

    if (isOpen) {
        dropdown.classList.add('hidden');
        chevron.style.transform = '';
    } else {
        dropdown.classList.remove('hidden');
        chevron.style.transform = 'rotate(180deg)';
        populateAdAccountDropdown();
    }
}

function populateAdAccountDropdown() {
    const list = document.getElementById('adAccountDropdownList');
    if (!list) return;

    const maxAccounts = marketingAddonLimits.maxAdAccounts;
    const atLimit = adAccounts.length >= maxAccounts;

    // Update the header with count
    const header = document.getElementById('adAccountDropdownHeader');
    if (header) {
        header.textContent = `Ad Accounts (${adAccounts.length}/${maxAccounts})`;
    }

    // Toggle the Add Account button based on limit
    const addBtn = document.getElementById('addAdAccountBtn');
    if (addBtn) {
        if (atLimit) {
            addBtn.disabled = true;
            addBtn.classList.add('opacity-50', 'cursor-not-allowed');
            addBtn.classList.remove('hover:bg-brand-50');
            addBtn.innerHTML = `
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
                </svg>
                Limit reached (${maxAccounts})
            `;
        } else {
            addBtn.disabled = false;
            addBtn.classList.remove('opacity-50', 'cursor-not-allowed');
            addBtn.classList.add('hover:bg-brand-50');
            addBtn.innerHTML = `
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
                </svg>
                Add Account
            `;
        }
    }

    if (adAccounts.length === 0) {
        list.innerHTML = `
            <div class="px-3 py-3 text-sm text-ink-400 text-center">
                No ad accounts connected yet.
            </div>
        `;
        return;
    }

    list.innerHTML = adAccounts.map(account => {
        const isSelected = account.is_selected;
        const statusColor = account.account_status === 1 ? 'green' : 'amber';
        const statusLabel = account.account_status === 1 ? 'Active' : 'Inactive';
        return `
            <button onclick="selectAdAccountFromDropdown('${account.id}')"
                class="w-full text-left px-3 py-2.5 hover:bg-surface-50 transition-colors flex items-center justify-between gap-2 ${isSelected ? 'bg-brand-50' : ''}">
                <div class="min-w-0">
                    <p class="text-sm font-medium text-ink-700 truncate">${escapeHtml(account.account_name || account.account_id)}</p>
                    <p class="text-xs text-ink-400">${escapeHtml(account.account_id)} · <span class="text-${statusColor}-600">${statusLabel}</span></p>
                </div>
                ${isSelected ? `
                    <svg class="w-4 h-4 text-brand-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
                    </svg>
                ` : ''}
            </button>
        `;
    }).join('');
}

async function selectAdAccountFromDropdown(accountId) {
    try {
        const response = await apiPost(`/api/marketing/ad-accounts/${accountId}/select`);
        if (response.success) {
            await loadAdAccounts();
            populateAdAccountDropdown();

            // Close the dropdown
            document.getElementById('adAccountDropdown').classList.add('hidden');
            document.getElementById('adAccountChevron').style.transform = '';

            // Refresh data for the currently active marketing tab
            const activeTab = document.querySelector('.mkt-tab-btn.tab-active');
            if (activeTab) {
                const tabId = activeTab.id.replace('mkt-tab-', '');
                showMarketingTab(tabId);
            }

            showToast('Ad account selected', 'success');
        }
    } catch (error) {
        showToast('Failed to select ad account', 'error');
    }
}

function addAdAccount() {
    // Check limit before initiating
    if (adAccounts.length >= marketingAddonLimits.maxAdAccounts) {
        showToast(`Ad account limit reached (${marketingAddonLimits.maxAdAccounts}). Remove an existing account to add a new one.`, 'error');
        return;
    }
    // Close the dropdown
    document.getElementById('adAccountDropdown').classList.add('hidden');
    document.getElementById('adAccountChevron').style.transform = '';
    // Initiate the marketing OAuth flow to discover new ad accounts
    setupAdAccount();
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
    const wrapper = document.getElementById('adAccountDropdownWrapper');
    if (wrapper && !wrapper.contains(e.target)) {
        const dropdown = document.getElementById('adAccountDropdown');
        const chevron = document.getElementById('adAccountChevron');
        if (dropdown && !dropdown.classList.contains('hidden')) {
            dropdown.classList.add('hidden');
            chevron.style.transform = '';
        }
    }
});

// ============================================
// TAB NAVIGATION
// ============================================

function showMarketingTab(tabName) {
    // Scoped to marketing sub-tabs only (uses mkt- prefixed classes)
    document.querySelectorAll('.mkt-tab-content').forEach(content => {
        content.classList.add('hidden');
    });

    document.querySelectorAll('.mkt-tab-btn').forEach(btn => {
        btn.classList.remove('tab-active');
    });

    // Show selected tab content
    const selectedContent = document.getElementById(`mkt-content-${tabName}`);
    if (selectedContent) selectedContent.classList.remove('hidden');

    // Add active class to selected tab
    const selectedTab = document.getElementById(`mkt-tab-${tabName}`);
    if (selectedTab) selectedTab.classList.add('tab-active');

    // Load tab-specific data
    switch (tabName) {
        case 'overview':
            loadOverview();
            break;
        case 'boost':
            loadBoostTab();
            break;
        case 'campaigns':
            loadCampaigns();
            break;
        case 'audiences':
            loadAudiences();
            break;
        case 'rules':
            loadRules();
            break;
    }
}

// ============================================
// OVERVIEW TAB
// ============================================

async function loadOverview() {
    const days = document.getElementById('overviewDateRange')?.value || 30;
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    try {
        const response = await apiGet(`/api/marketing/analytics/overview?startDate=${startDate}&endDate=${endDate}`);
        if (response.success) {
            overviewData = response.overview;
            renderOverview(response.overview, days);
        }
    } catch (error) {
        console.error('Error loading overview:', error);
    }

    // Also load campaigns for the summary
    try {
        const response = await apiGet('/api/marketing/campaigns?status=active');
        if (response.success) {
            renderOverviewCampaigns(response.campaigns || []);
        }
    } catch (error) {
        console.error('Error loading overview campaigns:', error);
    }
}

function renderOverview(data, days) {
    document.getElementById('overviewSpend').textContent = formatCurrency(data.total_spend || 0);
    document.getElementById('overviewSpendPeriod').textContent = `Last ${days} days`;
    document.getElementById('overviewReach').textContent = formatNumber(data.total_reach || 0);
    document.getElementById('overviewClicks').textContent = formatNumber(data.total_clicks || 0);
    document.getElementById('overviewImpressions').textContent = formatNumber(data.total_impressions || 0);

    const ctr = data.total_impressions > 0
        ? ((data.total_clicks / data.total_impressions) * 100).toFixed(2)
        : '0.00';
    document.getElementById('overviewCTR').textContent = `${ctr}% CTR`;

    const cpc = data.total_clicks > 0
        ? (data.total_spend / data.total_clicks).toFixed(2)
        : '0.00';
    document.getElementById('overviewCPC').textContent = `$${cpc}`;

    const cpm = data.total_impressions > 0
        ? ((data.total_spend / data.total_impressions) * 1000).toFixed(2)
        : '0.00';
    document.getElementById('overviewCPM').textContent = `$${cpm}`;

    document.getElementById('overviewActiveCampaigns').textContent = data.activeCampaigns || 0;
    document.getElementById('overviewTotalCampaigns').textContent = `${data.totalCampaigns || 0} total`;
    document.getElementById('overviewActiveAds').textContent = data.activeAds || 0;
}

function renderOverviewCampaigns(activeCampaigns) {
    const list = document.getElementById('overviewCampaignsList');
    const empty = document.getElementById('overviewCampaignsEmpty');

    if (activeCampaigns.length === 0) {
        list.innerHTML = '';
        empty.classList.remove('hidden');
        return;
    }

    empty.classList.add('hidden');
    list.innerHTML = activeCampaigns.slice(0, 5).map(c => `
        <div class="flex items-center justify-between py-3">
            <div>
                <p class="font-medium text-ink-800 text-sm">${escapeHtml(c.name)}</p>
                <p class="text-xs text-ink-400">${c.objective || 'Engagement'} &middot; ${formatCurrency(c.daily_budget || 0)}/day</p>
            </div>
            <div class="text-right">
                <p class="text-sm font-medium text-ink-800">${formatCurrency(c.total_spend || 0)}</p>
                <p class="text-xs text-ink-400">${formatNumber(c.total_reach || 0)} reach</p>
            </div>
        </div>
    `).join('');
}

async function syncMetrics() {
    const btn = document.getElementById('syncMetricsBtn');
    btn.disabled = true;
    btn.innerHTML = '<div class="loader-sm mx-auto"></div>';

    try {
        const response = await apiPost('/api/marketing/sync-metrics');
        if (response.success) {
            showToast('Metrics synced successfully', 'success');
            await loadOverview();
        } else {
            showToast('Failed to sync metrics', 'error');
        }
    } catch (error) {
        showToast('Failed to sync metrics', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg> Sync`;
    }
}

// ============================================
// BOOST TAB
// ============================================

async function loadBoostTab() {
    await Promise.all([loadBoostablePosts(), loadActiveBoosts()]);
}

async function loadBoostablePosts() {
    const list = document.getElementById('boostablePostsList');
    const loading = document.getElementById('boostablePostsLoading');
    const empty = document.getElementById('boostablePostsEmpty');

    if (loading) loading.classList.remove('hidden');
    empty.classList.add('hidden');

    try {
        const response = await apiGet('/api/marketing/boostable-posts?limit=50');
        if (response.success) {
            boostablePosts = response.posts || [];

            if (loading) loading.classList.add('hidden');

            if (boostablePosts.length === 0) {
                list.innerHTML = '';
                empty.classList.remove('hidden');
                return;
            }

            list.innerHTML = boostablePosts.map(post => renderBoostablePost(post)).join('');
        }
    } catch (error) {
        console.error('Error loading boostable posts:', error);
        if (loading) loading.classList.add('hidden');
        list.innerHTML = '<p class="text-ink-400 text-center py-8">Failed to load posts. Please try again.</p>';
    }
}

function renderBoostablePost(post) {
    const content = post.content || post.generated_content || '';
    const preview = content.length > 150 ? content.substring(0, 150) + '...' : content;
    const platform = post.platform || 'facebook';
    const platformLabel = platform.charAt(0).toUpperCase() + platform.slice(1);
    const date = post.published_at ? new Date(post.published_at).toLocaleDateString() : '';
    const engagement = post.engagement || {};
    const likes = engagement.likes || engagement.like_count || 0;
    const comments = engagement.comments || engagement.comments_count || 0;

    return `
        <div class="card-static p-5">
            <div class="flex items-start justify-between gap-4">
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 mb-2">
                        <span class="badge-primary text-xs">${escapeHtml(platformLabel)}</span>
                        <span class="text-xs text-ink-400">${escapeHtml(date)}</span>
                        ${likes > 0 || comments > 0 ? `<span class="text-xs text-ink-400">${likes} likes &middot; ${comments} comments</span>` : ''}
                    </div>
                    <p class="text-sm text-ink-700 line-clamp-2">${escapeHtml(preview)}</p>
                </div>
                <button onclick="openBoostModal('${escapeHtml(post.id)}', '${escapeHtml(post.platform_post_id || '')}', '${escapeHtml(platform)}')"
                    class="btn-primary btn-sm whitespace-nowrap flex items-center gap-1">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"></path>
                    </svg>
                    Boost
                </button>
            </div>
        </div>
    `;
}

async function loadActiveBoosts() {
    try {
        const response = await apiGet('/api/marketing/boosts');
        if (response.success && response.boosts && response.boosts.length > 0) {
            const section = document.getElementById('activeBoostsSection');
            const list = document.getElementById('activeBoostsList');
            section.classList.remove('hidden');

            list.innerHTML = response.boosts.map(boost => `
                <div class="card-static p-5">
                    <div class="flex items-center justify-between">
                        <div>
                            <p class="font-medium text-ink-800 text-sm">${escapeHtml(boost.name)}</p>
                            <p class="text-xs text-ink-400 mt-1">
                                ${formatCurrency(boost.total_spend || 0)} spent &middot;
                                ${formatNumber(boost.total_reach || 0)} reach &middot;
                                ${formatNumber(boost.total_clicks || 0)} clicks
                            </p>
                        </div>
                        <div class="flex items-center gap-2">
                            <span class="text-xs px-2 py-1 rounded-full ${getStatusClasses(boost.status)}">${boost.status}</span>
                            ${boost.status === 'active' ? `
                                <button onclick="pauseBoost('${boost.id}')" class="btn-outline btn-sm text-xs" title="Pause">Pause</button>
                            ` : ''}
                            ${boost.status === 'paused' ? `
                                <button onclick="resumeBoost('${boost.id}')" class="btn-outline btn-sm text-xs" title="Resume">Resume</button>
                            ` : ''}
                            <button onclick="deleteBoost('${boost.id}')" class="text-red-500 hover:text-red-700 transition-colors" title="Delete">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>
            `).join('');
        } else {
            document.getElementById('activeBoostsSection').classList.add('hidden');
        }
    } catch (error) {
        console.error('Error loading boosts:', error);
    }
}

async function pauseBoost(boostId) {
    try {
        await apiPut(`/api/marketing/boosts/${boostId}/pause`);
        showToast('Boost paused', 'success');
        await loadBoostTab();
    } catch (error) {
        showToast('Failed to pause boost', 'error');
    }
}

async function resumeBoost(boostId) {
    try {
        await apiPut(`/api/marketing/boosts/${boostId}/resume`);
        showToast('Boost resumed', 'success');
        await loadBoostTab();
    } catch (error) {
        showToast('Failed to resume boost', 'error');
    }
}

async function deleteBoost(boostId) {
    if (!confirm('Are you sure you want to delete this boost? This will also delete the ad on Meta.')) return;
    try {
        await apiDelete(`/api/marketing/boosts/${boostId}`);
        showToast('Boost deleted', 'success');
        await loadBoostTab();
    } catch (error) {
        showToast('Failed to delete boost', 'error');
    }
}

// ============================================
// BOOST MODAL
// ============================================

function openBoostModal(publishedPostId, platformPostId, platform) {
    const post = boostablePosts.find(p => p.id === publishedPostId);
    if (!post) return;

    currentBoostPost = { ...post, platformPostId, platform };
    boostLocations = [];
    boostInterests = [];

    // Populate modal
    document.getElementById('boostPostPlatform').textContent = platform.charAt(0).toUpperCase() + platform.slice(1);
    document.getElementById('boostPostDate').textContent = post.published_at ? new Date(post.published_at).toLocaleDateString() : '';
    document.getElementById('boostPostContent').textContent = post.content || post.generated_content || '';

    // Set default dates
    const today = new Date();
    const startStr = today.toISOString().split('T')[0];
    document.getElementById('boostStartDate').value = startStr;
    setBoostDuration(7);

    // Load saved audiences into dropdown
    populateAudienceDropdown('boostAudienceSelect');

    // Reset state
    document.getElementById('boostSelectedLocations').innerHTML = '';
    document.getElementById('boostSelectedInterests').innerHTML = '';
    document.getElementById('boostError').classList.add('hidden');

    updateBoostCostSummary();

    // Show modal
    const modal = document.getElementById('boostModal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function closeBoostModal() {
    const modal = document.getElementById('boostModal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    currentBoostPost = null;
}

function setBoostDuration(days) {
    // Update button states
    document.querySelectorAll('.boost-duration-btn').forEach(btn => {
        btn.classList.remove('btn-primary');
        btn.classList.add('btn-outline');
    });
    const activeBtn = document.querySelector(`.boost-duration-btn[data-days="${days}"]`);
    if (activeBtn) {
        activeBtn.classList.remove('btn-outline');
        activeBtn.classList.add('btn-primary');
    }

    if (days > 0) {
        const start = new Date();
        const end = new Date(start);
        end.setDate(end.getDate() + days);
        document.getElementById('boostStartDate').value = start.toISOString().split('T')[0];
        document.getElementById('boostEndDate').value = end.toISOString().split('T')[0];
    }
    updateBoostCostSummary();
}

function updateBoostCostSummary() {
    const budgetType = document.querySelector('input[name="budgetType"]:checked')?.value || 'daily';
    const budget = parseFloat(document.getElementById('boostBudget').value) || 0;
    const start = new Date(document.getElementById('boostStartDate').value);
    const end = new Date(document.getElementById('boostEndDate').value);

    const days = Math.max(1, Math.ceil((end - start) / (1000 * 60 * 60 * 24)));

    let totalCost, breakdown;
    if (budgetType === 'daily') {
        totalCost = budget * days;
        breakdown = `$${budget.toFixed(2)}/day x ${days} days`;
    } else {
        totalCost = budget;
        breakdown = `Lifetime budget over ${days} days`;
    }

    document.getElementById('boostTotalCost').textContent = formatCurrency(totalCost);
    document.getElementById('boostCostBreakdown').textContent = breakdown;
}

function handleAudienceSelect() {
    const val = document.getElementById('boostAudienceSelect').value;
    const builder = document.getElementById('boostAudienceBuilder');
    if (val === 'new') {
        builder.classList.remove('hidden');
    } else {
        builder.classList.add('hidden');
    }
}

async function submitBoost() {
    if (!currentBoostPost) return;

    const btn = document.getElementById('submitBoostBtn');
    const errorEl = document.getElementById('boostError');
    const errorText = document.getElementById('boostErrorText');

    const budgetType = document.querySelector('input[name="budgetType"]:checked')?.value || 'daily';
    const budgetAmount = parseFloat(document.getElementById('boostBudget').value);
    const startDate = document.getElementById('boostStartDate').value;
    const endDate = document.getElementById('boostEndDate').value;

    if (!budgetAmount || budgetAmount < 1) {
        errorText.textContent = 'Budget must be at least $1.00';
        errorEl.classList.remove('hidden');
        return;
    }
    if (!startDate || !endDate) {
        errorText.textContent = 'Please set start and end dates';
        errorEl.classList.remove('hidden');
        return;
    }

    // Build audience targeting
    let audience;
    const selectedAudienceId = document.getElementById('boostAudienceSelect').value;
    if (selectedAudienceId !== 'new') {
        const savedAudience = audiences.find(a => a.id === selectedAudienceId);
        audience = savedAudience?.targeting || {};
    } else {
        const gender = document.querySelector('input[name="boostGender"]:checked')?.value || 'all';
        audience = {
            geo_locations: boostLocations.length > 0 ? { countries: boostLocations.filter(l => l.type === 'country').map(l => l.key) } : undefined,
            age_min: parseInt(document.getElementById('boostAgeMin').value) || 18,
            age_max: parseInt(document.getElementById('boostAgeMax').value) || 65,
            genders: gender === 'all' ? undefined : (gender === 'male' ? [1] : [2]),
            interests: boostInterests.length > 0 ? boostInterests.map(i => ({ id: i.id, name: i.name })) : undefined
        };
    }

    btn.disabled = true;
    btn.textContent = 'Boosting...';
    errorEl.classList.add('hidden');

    try {
        const response = await apiPost('/api/marketing/boost', {
            platformPostId: currentBoostPost.platformPostId || currentBoostPost.platform_post_id,
            sourcePlatform: currentBoostPost.platform,
            sourcePublishedPostId: currentBoostPost.id,
            budget: { type: budgetType, amount: budgetAmount },
            duration: {
                startTime: new Date(startDate).toISOString(),
                endTime: new Date(endDate).toISOString()
            },
            audience
        });

        if (response.success) {
            closeBoostModal();
            showToast('Post boosted successfully!', 'success');
            await loadBoostTab();
        } else {
            errorText.textContent = response.error || 'Failed to boost post';
            errorEl.classList.remove('hidden');
        }
    } catch (error) {
        errorText.textContent = error.message || 'Failed to boost post';
        errorEl.classList.remove('hidden');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Start Boost';
    }
}

// ============================================
// CAMPAIGNS TAB
// ============================================

async function loadCampaigns() {
    const statusFilter = document.getElementById('campaignStatusFilter')?.value || '';
    const list = document.getElementById('campaignsList');
    const loading = document.getElementById('campaignsLoading');
    const empty = document.getElementById('campaignsEmpty');
    const detail = document.getElementById('campaignDetail');

    detail.classList.add('hidden');
    if (loading) loading.classList.remove('hidden');
    empty.classList.add('hidden');

    try {
        const url = statusFilter
            ? `/api/marketing/campaigns?status=${statusFilter}`
            : '/api/marketing/campaigns';
        const response = await apiGet(url);

        if (response.success) {
            campaigns = response.campaigns || [];
            if (loading) loading.classList.add('hidden');

            // Update campaign count badge
            const badge = document.getElementById('campaignCount');
            if (badge) {
                badge.textContent = campaigns.length;
                badge.classList.toggle('hidden', campaigns.length === 0);
            }

            if (campaigns.length === 0) {
                list.innerHTML = '';
                empty.classList.remove('hidden');
                return;
            }

            list.innerHTML = campaigns.map(campaign => renderCampaignCard(campaign)).join('');
        }
    } catch (error) {
        console.error('Error loading campaigns:', error);
        if (loading) loading.classList.add('hidden');
        list.innerHTML = '<p class="text-ink-400 text-center py-8">Failed to load campaigns.</p>';
    }
}

function renderCampaignCard(campaign) {
    const platforms = (campaign.platforms || ['facebook']).join(', ');
    const budget = campaign.daily_budget
        ? `$${parseFloat(campaign.daily_budget).toFixed(2)}/day`
        : campaign.lifetime_budget
            ? `$${parseFloat(campaign.lifetime_budget).toFixed(2)} lifetime`
            : 'No budget set';

    return `
        <div class="card-static p-5 cursor-pointer hover:border-brand-300 transition-colors" onclick="openCampaignDetail('${campaign.id}')">
            <div class="flex items-center justify-between">
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 mb-1">
                        <p class="font-medium text-ink-800">${escapeHtml(campaign.name)}</p>
                        <span class="text-xs px-2 py-0.5 rounded-full ${getStatusClasses(campaign.status)}">${campaign.status}</span>
                        ${campaign.metadata?.boostType ? '<span class="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">Boost</span>' : ''}
                    </div>
                    <p class="text-xs text-ink-400">
                        ${campaign.objective || 'Engagement'} &middot; ${budget} &middot; ${platforms}
                    </p>
                </div>
                <div class="text-right ml-4">
                    <p class="text-sm font-medium text-ink-800">${formatCurrency(campaign.total_spend || 0)}</p>
                    <p class="text-xs text-ink-400">${formatNumber(campaign.total_reach || 0)} reach</p>
                </div>
            </div>
        </div>
    `;
}

async function openCampaignDetail(campaignId) {
    const list = document.getElementById('campaignsList');
    const empty = document.getElementById('campaignsEmpty');
    const detail = document.getElementById('campaignDetail');
    const content = document.getElementById('campaignDetailContent');

    list.classList.add('hidden');
    empty.classList.add('hidden');
    detail.classList.remove('hidden');

    content.innerHTML = '<div class="text-center py-8"><div class="loader mx-auto"></div></div>';

    try {
        const response = await apiGet(`/api/marketing/campaigns/${campaignId}`);
        if (response.success) {
            content.innerHTML = renderCampaignDetail(response.campaign, response.adSets || []);
        }
    } catch (error) {
        content.innerHTML = '<p class="text-ink-400 text-center py-8">Failed to load campaign details.</p>';
    }
}

function renderCampaignDetail(campaign, adSets) {
    const budget = campaign.daily_budget
        ? `$${parseFloat(campaign.daily_budget).toFixed(2)}/day`
        : campaign.lifetime_budget
            ? `$${parseFloat(campaign.lifetime_budget).toFixed(2)} lifetime`
            : 'No budget';

    let html = `
        <div class="card-static p-6 mb-6">
            <div class="flex items-center justify-between mb-4">
                <div>
                    <h3 class="text-xl font-bold text-ink-800">${escapeHtml(campaign.name)}</h3>
                    <p class="text-sm text-ink-400">${campaign.objective || 'Engagement'} &middot; ${budget}</p>
                </div>
                <div class="flex items-center gap-2">
                    <span class="text-xs px-2 py-1 rounded-full ${getStatusClasses(campaign.status)}">${campaign.status}</span>
                    ${campaign.status === 'active' ? `<button onclick="updateCampaignStatus('${campaign.id}', 'paused')" class="btn-outline btn-sm">Pause</button>` : ''}
                    ${campaign.status === 'paused' ? `<button onclick="updateCampaignStatus('${campaign.id}', 'active')" class="btn-primary btn-sm">Activate</button>` : ''}
                </div>
            </div>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div class="bg-surface-50 rounded-lg p-3">
                    <p class="text-xs text-ink-400">Spend</p>
                    <p class="text-lg font-bold text-ink-800">${formatCurrency(campaign.total_spend || 0)}</p>
                </div>
                <div class="bg-surface-50 rounded-lg p-3">
                    <p class="text-xs text-ink-400">Impressions</p>
                    <p class="text-lg font-bold text-ink-800">${formatNumber(campaign.total_impressions || 0)}</p>
                </div>
                <div class="bg-surface-50 rounded-lg p-3">
                    <p class="text-xs text-ink-400">Reach</p>
                    <p class="text-lg font-bold text-ink-800">${formatNumber(campaign.total_reach || 0)}</p>
                </div>
                <div class="bg-surface-50 rounded-lg p-3">
                    <p class="text-xs text-ink-400">Clicks</p>
                    <p class="text-lg font-bold text-ink-800">${formatNumber(campaign.total_clicks || 0)}</p>
                </div>
            </div>
        </div>
    `;

    // Ad Sets
    html += '<h4 class="font-semibold text-ink-800 mb-3">Ad Sets</h4>';
    if (adSets.length === 0) {
        html += '<p class="text-ink-400 text-sm mb-6">No ad sets in this campaign.</p>';
    } else {
        html += '<div class="space-y-4 mb-6">';
        adSets.forEach(adSet => {
            const ads = adSet.ads || [];
            html += `
                <div class="card-static p-4">
                    <div class="flex items-center justify-between mb-2">
                        <div>
                            <p class="font-medium text-ink-800 text-sm">${escapeHtml(adSet.name)}</p>
                            <p class="text-xs text-ink-400">${adSet.billing_event || 'IMPRESSIONS'} &middot; ${adSet.bid_strategy || 'LOWEST_COST'}</p>
                        </div>
                        <span class="text-xs px-2 py-0.5 rounded-full ${getStatusClasses(adSet.status)}">${adSet.status}</span>
                    </div>
                    <div class="grid grid-cols-4 gap-2 text-center text-xs mb-3">
                        <div><p class="text-ink-400">Spend</p><p class="font-medium">${formatCurrency(adSet.spend || 0)}</p></div>
                        <div><p class="text-ink-400">Impressions</p><p class="font-medium">${formatNumber(adSet.impressions || 0)}</p></div>
                        <div><p class="text-ink-400">Reach</p><p class="font-medium">${formatNumber(adSet.reach || 0)}</p></div>
                        <div><p class="text-ink-400">Clicks</p><p class="font-medium">${formatNumber(adSet.clicks || 0)}</p></div>
                    </div>
                    ${ads.length > 0 ? `
                        <div class="border-t border-surface-200 pt-2 mt-2">
                            <p class="text-xs text-ink-500 mb-2">Ads (${ads.length})</p>
                            ${ads.map(ad => `
                                <div class="flex items-center justify-between py-1">
                                    <span class="text-xs text-ink-600">${escapeHtml(ad.name)}</span>
                                    <span class="text-xs px-2 py-0.5 rounded-full ${getStatusClasses(ad.status)}">${ad.status}</span>
                                </div>
                            `).join('')}
                        </div>
                    ` : ''}
                </div>
            `;
        });
        html += '</div>';
    }

    return html;
}

function closeCampaignDetail() {
    document.getElementById('campaignDetail').classList.add('hidden');
    document.getElementById('campaignsList').classList.remove('hidden');
}

async function updateCampaignStatus(campaignId, newStatus) {
    try {
        await apiPut(`/api/marketing/campaigns/${campaignId}`, { status: newStatus });
        showToast(`Campaign ${newStatus}`, 'success');
        await openCampaignDetail(campaignId);
    } catch (error) {
        showToast('Failed to update campaign', 'error');
    }
}

// Create Campaign Modal
function openCreateCampaignModal() {
    // Set default dates
    const now = new Date();
    const start = new Date(now);
    start.setHours(start.getHours() + 1);
    const end = new Date(start);
    end.setDate(end.getDate() + 30);

    document.getElementById('campaignName').value = '';
    document.getElementById('campaignDailyBudget').value = '';
    document.getElementById('campaignLifetimeBudget').value = '';
    document.getElementById('campaignStartTime').value = formatDateTimeLocal(start);
    document.getElementById('campaignEndTime').value = formatDateTimeLocal(end);
    document.getElementById('createCampaignError').classList.add('hidden');

    const modal = document.getElementById('createCampaignModal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function closeCreateCampaignModal() {
    const modal = document.getElementById('createCampaignModal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

async function submitCreateCampaign() {
    const btn = document.getElementById('submitCampaignBtn');
    const errorEl = document.getElementById('createCampaignError');
    const errorText = document.getElementById('createCampaignErrorText');

    const name = document.getElementById('campaignName').value.trim();
    const objective = document.getElementById('campaignObjective').value;
    const platforms = Array.from(document.querySelectorAll('input[name="campaignPlatform"]:checked')).map(cb => cb.value);
    const dailyBudget = parseFloat(document.getElementById('campaignDailyBudget').value) || null;
    const lifetimeBudget = parseFloat(document.getElementById('campaignLifetimeBudget').value) || null;
    const startTime = document.getElementById('campaignStartTime').value;
    const endTime = document.getElementById('campaignEndTime').value;

    if (!name) {
        errorText.textContent = 'Campaign name is required';
        errorEl.classList.remove('hidden');
        return;
    }
    if (platforms.length === 0) {
        errorText.textContent = 'Select at least one platform';
        errorEl.classList.remove('hidden');
        return;
    }
    if (!dailyBudget && !lifetimeBudget) {
        errorText.textContent = 'Set either a daily or lifetime budget';
        errorEl.classList.remove('hidden');
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Creating...';
    errorEl.classList.add('hidden');

    try {
        const response = await apiPost('/api/marketing/campaigns', {
            name, objective, platforms,
            dailyBudget, lifetimeBudget,
            startTime: startTime ? new Date(startTime).toISOString() : undefined,
            endTime: endTime ? new Date(endTime).toISOString() : undefined
        });

        if (response.success) {
            closeCreateCampaignModal();
            showToast('Campaign created', 'success');
            await loadCampaigns();
        } else {
            errorText.textContent = response.error || 'Failed to create campaign';
            errorEl.classList.remove('hidden');
        }
    } catch (error) {
        errorText.textContent = error.message || 'Failed to create campaign';
        errorEl.classList.remove('hidden');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Create Campaign';
    }
}

// ============================================
// AUDIENCES TAB
// ============================================

async function loadAudiences() {
    const list = document.getElementById('audiencesList');
    const loading = document.getElementById('audiencesLoading');
    const empty = document.getElementById('audiencesEmpty');

    if (loading) loading.classList.remove('hidden');
    empty.classList.add('hidden');

    try {
        const response = await apiGet('/api/marketing/audiences');
        if (response.success) {
            audiences = response.audiences || [];
            if (loading) loading.classList.add('hidden');

            if (audiences.length === 0) {
                list.innerHTML = '';
                empty.classList.remove('hidden');
                return;
            }

            list.innerHTML = audiences.map(audience => renderAudienceCard(audience)).join('');
        }
    } catch (error) {
        console.error('Error loading audiences:', error);
        if (loading) loading.classList.add('hidden');
    }
}

function renderAudienceCard(audience) {
    const targeting = audience.targeting || {};
    const ageRange = `${targeting.age_min || 18}-${targeting.age_max || 65}`;
    const locationCount = targeting.geo_locations?.countries?.length || 0;
    const interestCount = targeting.interests?.length || 0;
    const platforms = (audience.platforms || []).join(', ');

    return `
        <div class="card-static p-5">
            <div class="flex items-center justify-between mb-3">
                <div>
                    <p class="font-medium text-ink-800">${escapeHtml(audience.name)}</p>
                    ${audience.description ? `<p class="text-xs text-ink-400 mt-0.5">${escapeHtml(audience.description)}</p>` : ''}
                </div>
                <div class="flex items-center gap-2">
                    ${audience.is_default ? '<span class="text-xs px-2 py-0.5 rounded-full bg-brand-100 text-brand-700">Default</span>' : ''}
                    <button onclick="editAudience('${audience.id}')" class="text-ink-400 hover:text-brand-600 transition-colors" title="Edit">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path>
                        </svg>
                    </button>
                    <button onclick="deleteAudience('${audience.id}')" class="text-ink-400 hover:text-red-600 transition-colors" title="Delete">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                        </svg>
                    </button>
                </div>
            </div>
            <div class="flex flex-wrap gap-2 text-xs">
                <span class="bg-surface-100 text-ink-600 px-2 py-1 rounded">Age: ${ageRange}</span>
                ${locationCount > 0 ? `<span class="bg-surface-100 text-ink-600 px-2 py-1 rounded">${locationCount} location${locationCount > 1 ? 's' : ''}</span>` : ''}
                ${interestCount > 0 ? `<span class="bg-surface-100 text-ink-600 px-2 py-1 rounded">${interestCount} interest${interestCount > 1 ? 's' : ''}</span>` : ''}
                ${audience.estimated_reach ? `<span class="bg-brand-50 text-brand-700 px-2 py-1 rounded">~${formatNumber(audience.estimated_reach)} reach</span>` : ''}
            </div>
        </div>
    `;
}

// Audience Modal
function openAudienceModal(audienceId) {
    editingAudienceId = audienceId || null;
    audienceLocations = [];
    audienceInterests = [];

    const title = document.getElementById('audienceModalTitle');
    const btn = document.getElementById('submitAudienceBtn');

    if (audienceId) {
        title.textContent = 'Edit Audience';
        btn.textContent = 'Save Changes';
        const audience = audiences.find(a => a.id === audienceId);
        if (audience) {
            document.getElementById('audienceName').value = audience.name;
            document.getElementById('audienceDescription').value = audience.description || '';
            document.getElementById('audienceAgeMin').value = audience.targeting?.age_min || 18;
            document.getElementById('audienceAgeMax').value = audience.targeting?.age_max || 65;

            // Populate locations
            if (audience.targeting?.geo_locations?.countries) {
                audienceLocations = audience.targeting.geo_locations.countries.map(c => ({ key: c, type: 'country', name: c }));
                renderSelectedItems('audienceSelectedLocations', audienceLocations, 'audience-location');
            }
            // Populate interests
            if (audience.targeting?.interests) {
                audienceInterests = audience.targeting.interests;
                renderSelectedItems('audienceSelectedInterests', audienceInterests, 'audience-interest');
            }

            const gender = audience.targeting?.genders;
            if (gender && gender.includes(1) && !gender.includes(2)) {
                document.querySelector('input[name="audienceGender"][value="male"]').checked = true;
            } else if (gender && gender.includes(2) && !gender.includes(1)) {
                document.querySelector('input[name="audienceGender"][value="female"]').checked = true;
            } else {
                document.querySelector('input[name="audienceGender"][value="all"]').checked = true;
            }
        }
    } else {
        title.textContent = 'Create Audience';
        btn.textContent = 'Save Audience';
        document.getElementById('audienceName').value = '';
        document.getElementById('audienceDescription').value = '';
        document.getElementById('audienceAgeMin').value = 18;
        document.getElementById('audienceAgeMax').value = 65;
        document.querySelector('input[name="audienceGender"][value="all"]').checked = true;
        document.getElementById('audienceSelectedLocations').innerHTML = '';
        document.getElementById('audienceSelectedInterests').innerHTML = '';
    }

    document.getElementById('audienceError').classList.add('hidden');
    document.getElementById('audienceReachEstimate').classList.add('hidden');

    const modal = document.getElementById('audienceModal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function editAudience(id) {
    openAudienceModal(id);
}

function closeAudienceModal() {
    const modal = document.getElementById('audienceModal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    editingAudienceId = null;
}

function buildAudienceTargeting(prefix) {
    const locations = prefix === 'audience' ? audienceLocations : boostLocations;
    const interests = prefix === 'audience' ? audienceInterests : boostInterests;
    const gender = document.querySelector(`input[name="${prefix}Gender"]:checked`)?.value || 'all';

    return {
        geo_locations: locations.length > 0 ? { countries: locations.filter(l => l.type === 'country').map(l => l.key) } : undefined,
        age_min: parseInt(document.getElementById(`${prefix}AgeMin`).value) || 18,
        age_max: parseInt(document.getElementById(`${prefix}AgeMax`).value) || 65,
        genders: gender === 'all' ? undefined : (gender === 'male' ? [1] : [2]),
        interests: interests.length > 0 ? interests.map(i => ({ id: i.id, name: i.name })) : undefined
    };
}

async function estimateAudienceReach() {
    const targeting = buildAudienceTargeting('audience');
    const estimateEl = document.getElementById('audienceReachEstimate');
    const valueEl = document.getElementById('audienceReachValue');

    try {
        const response = await apiPost('/api/marketing/audiences/estimate-reach', { targeting });
        if (response.success) {
            estimateEl.classList.remove('hidden');
            const low = response.users_lower_bound || 0;
            const high = response.users_upper_bound || 0;
            valueEl.textContent = `${formatNumber(low)} - ${formatNumber(high)}`;
        }
    } catch (error) {
        showToast('Failed to estimate reach', 'error');
    }
}

async function submitAudience() {
    const btn = document.getElementById('submitAudienceBtn');
    const errorEl = document.getElementById('audienceError');
    const errorText = document.getElementById('audienceErrorText');

    const name = document.getElementById('audienceName').value.trim();
    const description = document.getElementById('audienceDescription').value.trim();
    const targeting = buildAudienceTargeting('audience');
    const platforms = Array.from(document.querySelectorAll('input[name="audiencePlatform"]:checked')).map(cb => cb.value);

    if (!name) {
        errorText.textContent = 'Audience name is required';
        errorEl.classList.remove('hidden');
        return;
    }

    btn.disabled = true;
    btn.textContent = editingAudienceId ? 'Saving...' : 'Creating...';
    errorEl.classList.add('hidden');

    try {
        let response;
        if (editingAudienceId) {
            response = await apiPut(`/api/marketing/audiences/${editingAudienceId}`, { name, description, targeting, platforms });
        } else {
            response = await apiPost('/api/marketing/audiences', { name, description, targeting, platforms });
        }

        if (response.success) {
            closeAudienceModal();
            showToast(editingAudienceId ? 'Audience updated' : 'Audience created', 'success');
            await loadAudiences();
        } else {
            errorText.textContent = response.error || 'Failed to save audience';
            errorEl.classList.remove('hidden');
        }
    } catch (error) {
        errorText.textContent = error.message || 'Failed to save audience';
        errorEl.classList.remove('hidden');
    } finally {
        btn.disabled = false;
        btn.textContent = editingAudienceId ? 'Save Changes' : 'Save Audience';
    }
}

async function deleteAudience(audienceId) {
    if (!confirm('Delete this audience template?')) return;
    try {
        await apiDelete(`/api/marketing/audiences/${audienceId}`);
        showToast('Audience deleted', 'success');
        await loadAudiences();
    } catch (error) {
        showToast('Failed to delete audience', 'error');
    }
}

// ============================================
// RULES TAB
// ============================================

async function loadRules() {
    const list = document.getElementById('rulesList');
    const loading = document.getElementById('rulesLoading');
    const empty = document.getElementById('rulesEmpty');

    if (loading) loading.classList.remove('hidden');
    empty.classList.add('hidden');

    try {
        const response = await apiGet('/api/marketing/rules');
        if (response.success) {
            rules = response.rules || [];
            if (loading) loading.classList.add('hidden');

            if (rules.length === 0) {
                list.innerHTML = '';
                empty.classList.remove('hidden');
                return;
            }

            list.innerHTML = rules.map(rule => renderRuleCard(rule)).join('');
        }
    } catch (error) {
        console.error('Error loading rules:', error);
        if (loading) loading.classList.add('hidden');
    }
}

function renderRuleCard(rule) {
    const conditions = rule.conditions || {};
    const actions = rule.actions || {};
    const conditionText = `${conditions.metric || 'reach'} ${conditions.operator || '>'} ${conditions.value || 0}`;
    const withinText = conditions.within_hours ? ` within ${conditions.within_hours}h` : '';
    const actionText = rule.rule_type === 'auto_boost'
        ? `Boost with $${actions.budget || 10}/day for ${actions.duration_days || 7} days`
        : rule.rule_type === 'pause_if'
            ? 'Pause the ad'
            : 'Custom action';

    return `
        <div class="card-static p-5">
            <div class="flex items-center justify-between mb-3">
                <div>
                    <div class="flex items-center gap-2">
                        <p class="font-medium text-ink-800">${escapeHtml(rule.name)}</p>
                        <span class="text-xs px-2 py-0.5 rounded-full ${rule.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-surface-200 text-ink-500'}">${rule.status}</span>
                    </div>
                    <p class="text-xs text-ink-400 mt-1">${rule.rule_type === 'auto_boost' ? 'Auto-Boost' : rule.rule_type === 'pause_if' ? 'Auto-Pause' : rule.rule_type}</p>
                </div>
                <div class="flex items-center gap-2">
                    <button onclick="toggleRuleStatus('${rule.id}', '${rule.status === 'active' ? 'paused' : 'active'}')"
                        class="btn-outline btn-sm text-xs">${rule.status === 'active' ? 'Pause' : 'Activate'}</button>
                    <button onclick="editRule('${rule.id}')" class="text-ink-400 hover:text-brand-600 transition-colors" title="Edit">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path>
                        </svg>
                    </button>
                    <button onclick="deleteRule('${rule.id}')" class="text-ink-400 hover:text-red-600 transition-colors" title="Delete">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                        </svg>
                    </button>
                </div>
            </div>
            <div class="bg-surface-50 rounded-lg p-3 text-sm">
                <p class="text-ink-600"><span class="font-medium">When:</span> ${conditionText}${withinText}</p>
                <p class="text-ink-600"><span class="font-medium">Then:</span> ${actionText}</p>
                <p class="text-xs text-ink-400 mt-1">Cooldown: ${rule.cooldown_hours || 24}h &middot; Triggered ${rule.trigger_count || 0} times</p>
            </div>
        </div>
    `;
}

// Rule Modal
function openRuleModal(ruleId) {
    editingRuleId = ruleId || null;

    const title = document.getElementById('ruleModalTitle');
    const btn = document.getElementById('submitRuleBtn');

    // Populate audience dropdown
    populateAudienceDropdown('ruleAudienceSelect');

    if (ruleId) {
        title.textContent = 'Edit Rule';
        btn.textContent = 'Save Changes';
        const rule = rules.find(r => r.id === ruleId);
        if (rule) {
            document.getElementById('ruleName').value = rule.name;
            document.getElementById('ruleType').value = rule.rule_type;
            document.getElementById('ruleMetric').value = rule.conditions?.metric || 'organic_reach';
            document.getElementById('ruleOperator').value = rule.conditions?.operator || '>';
            document.getElementById('ruleValue').value = rule.conditions?.value || '';
            document.getElementById('ruleWithinHours').value = rule.conditions?.within_hours || 24;
            document.getElementById('ruleBoostBudget').value = rule.actions?.budget || 10;
            document.getElementById('ruleBoostDuration').value = rule.actions?.duration_days || 7;
            document.getElementById('ruleCooldown').value = rule.cooldown_hours || 24;
            if (rule.actions?.audience_template_id) {
                document.getElementById('ruleAudienceSelect').value = rule.actions.audience_template_id;
            }
        }
    } else {
        title.textContent = 'Create Auto-Boost Rule';
        btn.textContent = 'Create Rule';
        document.getElementById('ruleName').value = '';
        document.getElementById('ruleType').value = 'auto_boost';
        document.getElementById('ruleMetric').value = 'organic_reach';
        document.getElementById('ruleOperator').value = '>';
        document.getElementById('ruleValue').value = '';
        document.getElementById('ruleWithinHours').value = 24;
        document.getElementById('ruleBoostBudget').value = 10;
        document.getElementById('ruleBoostDuration').value = 7;
        document.getElementById('ruleCooldown').value = 24;
    }

    document.getElementById('ruleError').classList.add('hidden');
    updateRuleForm();

    const modal = document.getElementById('ruleModal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function editRule(id) {
    openRuleModal(id);
}

function closeRuleModal() {
    const modal = document.getElementById('ruleModal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    editingRuleId = null;
}

function updateRuleForm() {
    const ruleType = document.getElementById('ruleType').value;
    const boostAction = document.getElementById('ruleBoostAction');
    const withinSection = document.getElementById('ruleWithinHoursSection');

    if (ruleType === 'auto_boost') {
        boostAction.classList.remove('hidden');
        withinSection.classList.remove('hidden');
    } else if (ruleType === 'pause_if') {
        boostAction.classList.add('hidden');
        withinSection.classList.add('hidden');
    }
}

async function submitRule() {
    const btn = document.getElementById('submitRuleBtn');
    const errorEl = document.getElementById('ruleError');
    const errorText = document.getElementById('ruleErrorText');

    const name = document.getElementById('ruleName').value.trim();
    const ruleType = document.getElementById('ruleType').value;
    const metric = document.getElementById('ruleMetric').value;
    const operator = document.getElementById('ruleOperator').value;
    const value = parseFloat(document.getElementById('ruleValue').value);
    const withinHours = parseInt(document.getElementById('ruleWithinHours').value) || 24;
    const cooldownHours = parseInt(document.getElementById('ruleCooldown').value) || 24;

    if (!name) {
        errorText.textContent = 'Rule name is required';
        errorEl.classList.remove('hidden');
        return;
    }
    if (isNaN(value)) {
        errorText.textContent = 'Condition value is required';
        errorEl.classList.remove('hidden');
        return;
    }

    const conditions = { metric, operator, value, within_hours: withinHours };

    let actions = {};
    if (ruleType === 'auto_boost') {
        actions = {
            action: 'boost',
            budget: parseFloat(document.getElementById('ruleBoostBudget').value) || 10,
            duration_days: parseInt(document.getElementById('ruleBoostDuration').value) || 7
        };
        const audienceId = document.getElementById('ruleAudienceSelect').value;
        if (audienceId) {
            actions.audience_template_id = audienceId;
        }
    } else if (ruleType === 'pause_if') {
        actions = { action: 'pause' };
    }

    btn.disabled = true;
    btn.textContent = editingRuleId ? 'Saving...' : 'Creating...';
    errorEl.classList.add('hidden');

    try {
        let response;
        if (editingRuleId) {
            response = await apiPut(`/api/marketing/rules/${editingRuleId}`, {
                name, ruleType, conditions, actions, cooldownHours
            });
        } else {
            response = await apiPost('/api/marketing/rules', {
                name, ruleType, conditions, actions, cooldownHours
            });
        }

        if (response.success) {
            closeRuleModal();
            showToast(editingRuleId ? 'Rule updated' : 'Rule created', 'success');
            await loadRules();
        } else {
            errorText.textContent = response.error || 'Failed to save rule';
            errorEl.classList.remove('hidden');
        }
    } catch (error) {
        errorText.textContent = error.message || 'Failed to save rule';
        errorEl.classList.remove('hidden');
    } finally {
        btn.disabled = false;
        btn.textContent = editingRuleId ? 'Save Changes' : 'Create Rule';
    }
}

async function toggleRuleStatus(ruleId, newStatus) {
    try {
        await apiPut(`/api/marketing/rules/${ruleId}`, { status: newStatus });
        showToast(`Rule ${newStatus}`, 'success');
        await loadRules();
    } catch (error) {
        showToast('Failed to update rule', 'error');
    }
}

async function deleteRule(ruleId) {
    if (!confirm('Delete this auto-boost rule?')) return;
    try {
        await apiDelete(`/api/marketing/rules/${ruleId}`);
        showToast('Rule deleted', 'success');
        await loadRules();
    } catch (error) {
        showToast('Failed to delete rule', 'error');
    }
}

// ============================================
// LOCATION & INTEREST SEARCH
// ============================================

function searchLocations(query) {
    clearTimeout(locationSearchTimer);
    if (query.length < 2) {
        document.getElementById('boostLocationResults').classList.add('hidden');
        return;
    }
    locationSearchTimer = setTimeout(() => performLocationSearch(query, 'boost'), 300);
}

function searchLocationsForAudience(query) {
    clearTimeout(locationSearchTimer);
    if (query.length < 2) {
        document.getElementById('audienceLocationResults').classList.add('hidden');
        return;
    }
    locationSearchTimer = setTimeout(() => performLocationSearch(query, 'audience'), 300);
}

async function performLocationSearch(query, prefix) {
    const resultsEl = document.getElementById(`${prefix}LocationResults`);
    try {
        const response = await apiGet(`/api/marketing/locations/search?q=${encodeURIComponent(query)}`);
        if (response.success && response.locations) {
            resultsEl.innerHTML = response.locations.map(loc => `
                <div class="px-3 py-2 hover:bg-surface-100 cursor-pointer text-sm text-ink-700"
                     onclick="addLocation('${prefix}', '${escapeHtml(loc.key)}', '${escapeHtml(loc.type)}', '${escapeHtml(loc.name)}')">
                    ${escapeHtml(loc.name)} <span class="text-xs text-ink-400">(${loc.type})</span>
                </div>
            `).join('');
            resultsEl.classList.remove('hidden');
        }
    } catch (error) {
        resultsEl.classList.add('hidden');
    }
}

function addLocation(prefix, key, type, name) {
    const locations = prefix === 'audience' ? audienceLocations : boostLocations;
    if (locations.find(l => l.key === key)) return;

    locations.push({ key, type, name });
    renderSelectedItems(`${prefix}SelectedLocations`, locations, `${prefix}-location`);
    document.getElementById(`${prefix}LocationSearch`).value = '';
    document.getElementById(`${prefix}LocationResults`).classList.add('hidden');
}

function searchInterests(query) {
    clearTimeout(interestSearchTimer);
    if (query.length < 2) {
        document.getElementById('boostInterestResults').classList.add('hidden');
        return;
    }
    interestSearchTimer = setTimeout(() => performInterestSearch(query, 'boost'), 300);
}

function searchInterestsForAudience(query) {
    clearTimeout(interestSearchTimer);
    if (query.length < 2) {
        document.getElementById('audienceInterestResults').classList.add('hidden');
        return;
    }
    interestSearchTimer = setTimeout(() => performInterestSearch(query, 'audience'), 300);
}

async function performInterestSearch(query, prefix) {
    const resultsEl = document.getElementById(`${prefix}InterestResults`);
    try {
        const response = await apiGet(`/api/marketing/interests/search?q=${encodeURIComponent(query)}`);
        if (response.success && response.interests) {
            resultsEl.innerHTML = response.interests.map(interest => `
                <div class="px-3 py-2 hover:bg-surface-100 cursor-pointer text-sm text-ink-700"
                     onclick="addInterest('${prefix}', '${interest.id}', '${escapeHtml(interest.name)}')">
                    ${escapeHtml(interest.name)} <span class="text-xs text-ink-400">${formatNumber(interest.audience_size || 0)} people</span>
                </div>
            `).join('');
            resultsEl.classList.remove('hidden');
        }
    } catch (error) {
        resultsEl.classList.add('hidden');
    }
}

function addInterest(prefix, id, name) {
    const interests = prefix === 'audience' ? audienceInterests : boostInterests;
    if (interests.find(i => i.id === id)) return;

    interests.push({ id, name });
    renderSelectedItems(`${prefix}SelectedInterests`, interests, `${prefix}-interest`);
    document.getElementById(`${prefix}InterestSearch`).value = '';
    document.getElementById(`${prefix}InterestResults`).classList.add('hidden');
}

function renderSelectedItems(containerId, items, typePrefix) {
    const container = document.getElementById(containerId);
    container.innerHTML = items.map((item, idx) => `
        <span class="inline-flex items-center gap-1 bg-brand-50 text-brand-700 text-xs px-2 py-1 rounded-full">
            ${escapeHtml(item.name)}
            <button onclick="removeSelectedItem('${typePrefix}', ${idx})" class="hover:text-red-600">
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                </svg>
            </button>
        </span>
    `).join('');
}

function removeSelectedItem(typePrefix, index) {
    if (typePrefix === 'boost-location') {
        boostLocations.splice(index, 1);
        renderSelectedItems('boostSelectedLocations', boostLocations, 'boost-location');
    } else if (typePrefix === 'boost-interest') {
        boostInterests.splice(index, 1);
        renderSelectedItems('boostSelectedInterests', boostInterests, 'boost-interest');
    } else if (typePrefix === 'audience-location') {
        audienceLocations.splice(index, 1);
        renderSelectedItems('audienceSelectedLocations', audienceLocations, 'audience-location');
    } else if (typePrefix === 'audience-interest') {
        audienceInterests.splice(index, 1);
        renderSelectedItems('audienceSelectedInterests', audienceInterests, 'audience-interest');
    }
}

// ============================================
// HELPER: Populate audience dropdown
// ============================================

function populateAudienceDropdown(selectId) {
    const select = document.getElementById(selectId);
    if (!select) return;

    // Keep the first option (default)
    const firstOption = select.options[0];
    select.innerHTML = '';
    select.appendChild(firstOption);

    audiences.forEach(a => {
        const opt = document.createElement('option');
        opt.value = a.id;
        opt.textContent = a.name;
        select.appendChild(opt);
    });
}

// ============================================
// API HELPERS
// ============================================

async function apiGet(url) {
    const token = localStorage.getItem('token');
    const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` },
        credentials: 'include'
    });
    const data = await response.json();
    if (!response.ok) {
        if (response.status === 403 && data.error?.includes('Marketing add-on required')) {
            document.getElementById('addonRequiredBanner').classList.remove('hidden');
        }
        throw new Error(data.error || 'Request failed');
    }
    return data;
}

async function apiPost(url, body) {
    const token = localStorage.getItem('token');
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-CSRF-Token': getCsrfToken()
        },
        credentials: 'include',
        body: body ? JSON.stringify(body) : undefined
    });
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error || 'Request failed');
    }
    return data;
}

async function apiPut(url, body) {
    const token = localStorage.getItem('token');
    const response = await fetch(url, {
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-CSRF-Token': getCsrfToken()
        },
        credentials: 'include',
        body: body ? JSON.stringify(body) : undefined
    });
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error || 'Request failed');
    }
    return data;
}

async function apiDelete(url) {
    const token = localStorage.getItem('token');
    const response = await fetch(url, {
        method: 'DELETE',
        headers: {
            'Authorization': `Bearer ${token}`,
            'X-CSRF-Token': getCsrfToken()
        },
        credentials: 'include'
    });
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error || 'Request failed');
    }
    return data;
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

function formatCurrency(amount) {
    return '$' + parseFloat(amount || 0).toFixed(2);
}

function formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
}

function formatDateTimeLocal(date) {
    const pad = n => n.toString().padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function getStatusClasses(status) {
    switch (status) {
        case 'active': return 'bg-green-100 text-green-700';
        case 'paused': return 'bg-amber-100 text-amber-700';
        case 'draft': return 'bg-surface-200 text-ink-500';
        case 'completed': return 'bg-blue-100 text-blue-700';
        case 'error': return 'bg-red-100 text-red-700';
        default: return 'bg-surface-200 text-ink-500';
    }
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    const bgClass = type === 'success' ? 'bg-green-600' : type === 'error' ? 'bg-red-600' : 'bg-ink-800';

    toast.className = `${bgClass} text-white px-4 py-3 rounded-xl shadow-lg text-sm font-medium transform translate-x-full transition-transform duration-300`;
    toast.textContent = message;

    container.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => {
        toast.classList.remove('translate-x-full');
        toast.classList.add('translate-x-0');
    });

    // Remove after 4 seconds
    setTimeout(() => {
        toast.classList.remove('translate-x-0');
        toast.classList.add('translate-x-full');
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}
