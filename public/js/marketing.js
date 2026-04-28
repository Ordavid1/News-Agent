// marketing.js - Marketing dashboard logic (embedded in profile.html)
//
// Shared variables (csrfToken, currentUser) and CSRF functions are provided
// by profile.js. Marketing init is triggered via the showTab wrapper in
// profile.html when the Marketing tab is shown.

// Marketing-specific state
var adAccounts = [];
var selectedAdAccount = null;
var isFacebookActive = true;
var marketingAddonLimits = { maxAdAccounts: 1, pricePerAccount: 19 };
var boostablePosts = [];
var campaigns = [];
var audiences = [];
var rules = [];
var overviewData = null;

// Brand Voice state
var brandVoiceProfiles = [];
var currentBrandVoiceProfile = null;
var brandVoicePollingTimer = null;

// Media Assets state
var mediaAssets = [];
var mediaTrainingJobs = [];          // All training sessions (history)
var activeTrainingJob = null;         // Currently in-progress training (if any)
var selectedTrainingJob = null;       // Which completed model to generate from
var generatedMedia = [];
var mediaTrainingPollingTimer = null;
var latestGeneratedImageUrl = null;
var mediaViewMode = 'new';           // 'new' (fresh upload) or 'view' (past model context)
var mediaGenCredits = 0;             // Remaining Brand Asset generation credits
var bvImageGenCredits = 0;           // Remaining Brand Voice image gen credits (shared pool with Brand Media)
var brandPromptStyle = 'concise';    // 'concise' or 'elaborated' — brand kit prompt injection style
var _trainingEligibility = null;     // Cached free-first-use eligibility

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

// Auto-sync tracking
var lastCampaignSync = 0;
var lastAudienceSync = 0;
const AUTO_SYNC_INTERVAL = 10 * 60 * 1000; // 10 minutes

// ============================================
// FREE FIRST-USE ELIGIBILITY
// ============================================

async function getTrainingEligibility(forceRefresh = false) {
    if (!_trainingEligibility || forceRefresh) {
        try {
            _trainingEligibility = await apiGet('/api/subscriptions/free-training-eligibility');
        } catch (e) {
            // On error, assume not eligible (safe default — user pays)
            _trainingEligibility = { freeModelTraining: false, freeVoiceTraining: false };
        }
    }
    return _trainingEligibility;
}

// ============================================
// INITIALIZATION
// ============================================

// Marketing initialization - called from DOMContentLoaded or profile.js
async function initMarketing() {
    // Check marketing addon status
    const hasAddon = await checkMarketingAddon();

    if (hasAddon) {
        // Load ad accounts first
        await loadAdAccounts();

        // Load initial data
        await loadOverview();
    }
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

    // Mount Ad Accounts selector into the initially-active sub-tab's title row
    const initialContent = document.querySelector('.mkt-tab-content:not(.hidden)');
    if (initialContent) mountAdAccountsInActiveTitleRow(initialContent);
});

// ============================================
// MARKETING ADDON CHECK
// ============================================

async function checkMarketingAddon() {
    // DEPRECATED: Marketing tab is now free — no addon check needed.
    // Hide both legacy addon banners.
    const requiredBanner = document.getElementById('addonRequiredBanner');
    if (requiredBanner) requiredBanner.classList.add('hidden');
    const activeBanner = document.getElementById('addonActiveBanner');
    if (activeBanner) activeBanner.classList.add('hidden');
    return true;
}

// DEPRECATED: Marketing addon paywall removed. Kept for existing subscribers.
async function purchaseAddon() {
    const btn = document.querySelector('#addonRequiredBanner button');
    const originalHtml = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<div class="loader" style="width:16px;height:16px;"></div> Preparing...';
    }

    try {
        // 1. Create LS checkout via backend (pre-filled, embed mode)
        const { checkoutUrl } = await apiPost('/api/subscriptions/marketing-checkout');

        // 2. Open LS checkout in new tab (standard payment page)
        window.open(checkoutUrl, '_blank');

        // 3. Poll for webhook confirmation while user completes payment in the other tab
        if (btn) btn.innerHTML = '<div class="loader" style="width:16px;height:16px;"></div> Waiting for payment...';
        let activated = false;
        for (let attempt = 0; attempt < 60; attempt++) {
            await new Promise(r => setTimeout(r, 3000));
            try {
                activated = await checkMarketingAddon();
                if (activated) break;
            } catch (e) { /* continue polling */ }
        }

        if (!activated) {
            showToast('Still waiting for payment confirmation. Please refresh after completing payment.', 'warning');
            if (btn) { btn.disabled = false; btn.innerHTML = originalHtml; }
            return;
        }

        // 4. Addon activated — load marketing data
        showToast('Marketing add-on activated successfully!', 'success');
        await loadAdAccounts();
        await loadOverview();

    } catch (error) {
        showToast(error.message || 'Payment failed. Please try again.', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = originalHtml; }
    }
}

async function openMarketingPortal() {
    const token = localStorage.getItem('token');
    try {
        const response = await fetch('/api/subscriptions/marketing-portal', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (response.ok) {
            const data = await response.json();
            if (data.portalUrl) {
                window.open(data.portalUrl, '_blank');
            }
        } else {
            showToast('Unable to open billing portal', 'error');
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
    try {
        const response = await apiGet('/api/marketing/ad-accounts');
        if (response.success) {
            adAccounts = response.accounts || [];
            selectedAdAccount = adAccounts.find(a => a.is_selected);
            isFacebookActive = response.facebookActive !== false;

            // Auto-select the first account if none is selected but accounts exist
            if (!selectedAdAccount && adAccounts.length > 0) {
                try {
                    await apiPost(`/api/marketing/ad-accounts/${adAccounts[0].id}/select`);
                    selectedAdAccount = adAccounts[0];
                    selectedAdAccount.is_selected = true;
                } catch (e) {
                    console.warn('Auto-select ad account failed:', e.message);
                    // Still use the first account locally so data loads
                    selectedAdAccount = adAccounts[0];
                }
            }

            if (response.needsConnection) {
                // No Facebook connection AND no existing accounts
                showAdAccountBanner('Connect your Facebook account with marketing permissions to get started.', true);
            } else if (selectedAdAccount && !response.facebookActive) {
                // Has ad accounts and data, but Facebook is disconnected —
                // show a non-blocking warning while still allowing data access
                showAdAccountBanner('Facebook connection is inactive. Your saved data is still accessible, but syncing and boosting are unavailable until you reconnect.', true);
            } else if (selectedAdAccount) {
                // Has a selected ad account and Facebook is active — everything is working
                document.getElementById('adAccountBanner').classList.add('hidden');
            } else if (response.marketingEnabled === false) {
                // No accounts and marketing scopes not authorized
                showAdAccountBanner('Facebook is connected but marketing permissions are not authorized. Click to authorize ads management.', true);
            } else {
                // No accounts but marketing is enabled — prompt to set up
                showAdAccountBanner('No ad account found. Connect your Facebook account with marketing permissions.', true);
            }

            // Update dropdown to reflect current state
            populateAdAccountDropdown();

            // Update create button states based on ad account availability
            updateCreateButtonStates();
        }
    } catch (error) {
        console.error('Error loading ad accounts:', error);
    }
}

/**
 * Enable/disable create buttons based on ad account selection and Facebook connection.
 * Local data buttons (audiences, rules, brand voice) only need an ad account.
 * Meta-specific buttons (sync, campaigns) also need an active Facebook connection.
 */
function updateCreateButtonStates() {
    const noAccount = !selectedAdAccount;

    // Local data creation — only needs an ad account
    const localBtnIds = ['createAudienceBtn', 'createRuleBtn', 'createBvProfileBtn'];
    localBtnIds.forEach(id => {
        const btn = document.getElementById(id);
        if (btn) {
            btn.disabled = noAccount;
            btn.title = noAccount ? 'Select an ad account first' : '';
        }
    });

    // Meta-specific actions — need ad account AND active Facebook connection
    const metaBtnIds = ['createCampaignBtn', 'syncCampaignsBtn', 'syncAudiencesBtn', 'syncMetricsBtn'];
    const metaDisabled = noAccount || !isFacebookActive;
    metaBtnIds.forEach(id => {
        const btn = document.getElementById(id);
        if (btn) {
            btn.disabled = metaDisabled;
            btn.title = metaDisabled
                ? (noAccount ? 'Select an ad account first' : 'Facebook connection is inactive')
                : '';
        }
    });
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
                if (data.alreadyAuthorized) {
                    // Marketing was enabled using the existing Facebook connection — no redirect needed
                    showToast(data.message || 'Marketing enabled!', 'success');
                    await loadAdAccounts();
                } else if (data.authUrl) {
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

async function discoverNewAdAccounts() {
    const token = localStorage.getItem('token');
    try {
        showToast('Discovering ad accounts...', 'info');
        const response = await fetch('/api/marketing/ad-accounts/discover', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken
            }
        });
        if (response.ok) {
            const data = await response.json();
            await loadAdAccounts();
            populateAdAccountDropdown();
            if (data.stored && data.stored.length > 0) {
                showToast(`${data.stored.length} new ad account(s) added`, 'success');
            } else {
                showToast('No new ad accounts found. You may need to re-authorize Facebook.', 'warning');
            }
        } else {
            const err = await response.json();
            if (response.status === 403 && err.error?.includes('limit')) {
                // Limit still not refreshed on server — reload addon
                await checkMarketingAddon();
                showToast('Please try adding the account again.', 'warning');
            } else {
                showToast(err.error || 'Failed to discover ad accounts', 'error');
            }
        }
    } catch (error) {
        console.error('Error discovering ad accounts:', error);
        showToast('Network error discovering accounts', 'error');
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

    // Update the header with count
    const header = document.getElementById('adAccountDropdownHeader');
    if (header) {
        header.textContent = `Ad Accounts (${adAccounts.length})`;
    }

    // Add Account button — always enabled, no payment required
    const addBtn = document.getElementById('addAdAccountBtn');
    if (addBtn) {
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
    // Close the dropdown
    document.getElementById('adAccountDropdown').classList.add('hidden');
    document.getElementById('adAccountChevron').style.transform = '';

    // Go straight to Facebook OAuth to pick an account (no payment required)
    initiateAdAccountOAuth();
}

let addAccountQuantity = 1;

function openAddAdAccountModal() {
    // Use paid slots (max_ad_accounts) as the base, not connected accounts count
    // This matches what the backend sends to LS for pricing
    const paidSlots = marketingAddonLimits.maxAdAccounts || 1;
    addAccountQuantity = 1;

    document.getElementById('addAccModalCurrent').textContent = paidSlots;
    updateAddAccountTotal();

    const modal = document.getElementById('addAdAccountModal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function updateAddAccountTotal() {
    const price = marketingAddonLimits.pricePerAccount || 19;
    const paidSlots = marketingAddonLimits.maxAdAccounts || 1;
    const newTotal = (paidSlots + addAccountQuantity) * price;

    document.getElementById('addAccModalQuantity').textContent = addAccountQuantity;
    document.getElementById('addAccModalNewTotal').textContent = `$${newTotal}/mo`;

    // Disable minus at 1
    const minusBtn = document.getElementById('addAccQuantityMinus');
    if (minusBtn) minusBtn.disabled = addAccountQuantity <= 1;
}

function changeAddAccountQuantity(delta) {
    const newQty = addAccountQuantity + delta;
    if (newQty < 1 || newQty > 20) return;
    addAccountQuantity = newQty;
    updateAddAccountTotal();
}

function closeAddAdAccountModal() {
    const modal = document.getElementById('addAdAccountModal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

async function confirmAddAdAccount() {
    const btn = document.getElementById('confirmAddAccBtn');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Preparing checkout...';

    try {
        // 1. Get checkout URL from backend (includes user-selected quantity)
        const response = await apiPost('/api/subscriptions/marketing-add-account-checkout', {
            additionalAccounts: addAccountQuantity
        });

        if (!response.checkoutUrl) {
            showToast(response.error || 'Failed to create checkout', 'error');
            return;
        }

        // 2. Open LS checkout overlay via existing compact checkout popup
        btn.textContent = 'Complete payment...';
        const paid = await showCompactCheckout(
            response.checkoutUrl,
            btn,
            { direction: 'up' }
        );

        if (!paid) {
            // User closed/cancelled the checkout
            return;
        }

        // 3. Close the info modal and poll for webhook confirmation
        closeAddAdAccountModal();
        showToast('Payment received! Activating new account slot...', 'info');

        let activated = false;
        const previousMax = response.currentAccounts;
        for (let attempt = 0; attempt < 15; attempt++) {
            await new Promise(r => setTimeout(r, 2000));
            try {
                const addonActive = await checkMarketingAddon();
                if (addonActive && marketingAddonLimits.maxAdAccounts > previousMax) {
                    activated = true;
                    break;
                }
            } catch (e) { /* continue polling */ }
        }

        if (!activated) {
            showToast('Payment received but activation pending. Please refresh in a moment.', 'warning');
            return;
        }

        // 4. Success — trigger Facebook OAuth to connect the new account
        showToast(`Account slot added! Monthly total: $${response.newMonthlyTotal}/mo`, 'success');
        initiateAdAccountOAuth();

    } catch (error) {
        console.error('Error in add account checkout:', error);
        showToast(error.message || 'Failed to start checkout', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

async function initiateAdAccountOAuth() {
    const token = localStorage.getItem('token');
    try {
        const response = await fetch('/api/connections/facebook/marketing/initiate', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (response.ok) {
            const data = await response.json();
            if (data.alreadyAuthorized) {
                // Already authorized — discover new accounts directly
                await discoverNewAdAccounts();
            } else if (data.authUrl) {
                // Redirect to Facebook OAuth so user can authorize/pick accounts
                window.location.href = data.authUrl;
            }
        } else {
            const err = await response.json();
            showToast(err.error || 'Failed to start Facebook authorization', 'error');
        }
    } catch (error) {
        showToast('Network error. Please try again.', 'error');
    }
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

// Moves the Ad Accounts dropdown into the active sub-tab's title row (rightmost action).
// Falls back to leaving it in its default container if no title row is found.
function mountAdAccountsInActiveTitleRow(activeContent) {
    const wrapper = document.getElementById('adAccountDropdownWrapper');
    if (!wrapper || !activeContent) return;

    // Each sub-tab's title row is the first direct-child flex row with justify-between.
    const titleRow = activeContent.querySelector(':scope > div.flex.justify-between, :scope > div.sm\\:justify-between, :scope > div[class*="justify-between"]');
    if (!titleRow) return;

    // Ensure wrapper sits inline within the title row's right-aligned action group
    wrapper.classList.remove('absolute', 'top-0', 'right-0', 'z-10');
    wrapper.classList.add('relative', 'flex-shrink-0');

    // Locate or create an action group (flex container) on the right side of the title row,
    // then append Ad Accounts as its rightmost child.
    const directChildren = Array.from(titleRow.children).filter(el => el !== wrapper);
    let actionGroup = null;
    if (directChildren.length >= 2) {
        const last = directChildren[directChildren.length - 1];
        // An action group must be a DIV container (not a button/link with flex layout classes)
        if (last && last.tagName === 'DIV' && last.classList.contains('flex')) {
            // Existing flex action group — reuse it
            actionGroup = last;
        } else {
            // Wrap the last child (single button/element) + Ad Accounts in a new flex group
            // Reuse a previously-created wrapper if present
            const existing = titleRow.querySelector(':scope > [data-ad-account-action-group="1"]');
            if (existing) {
                actionGroup = existing;
            } else {
                actionGroup = document.createElement('div');
                actionGroup.className = 'flex items-center gap-2 flex-shrink-0';
                actionGroup.setAttribute('data-ad-account-action-group', '1');
                titleRow.insertBefore(actionGroup, last);
                actionGroup.appendChild(last);
            }
        }
    }
    if (actionGroup) {
        actionGroup.appendChild(wrapper);
    } else {
        titleRow.appendChild(wrapper);
    }
}

/**
 * Brand Story is exclusive to the Business subscription tier ($250/month) — the same plan
 * that unlocks unlimited Autonomous News Agents. When a non-Business user lands on the
 * Brand Story sub-tab, render an upgrade gate in place of the normal content and short-circuit
 * any data loading. The backend (`routes/brand-stories.js`) enforces the same tier check, so
 * this is purely UX — defense in depth, not the source of truth.
 *
 * Returns true when the user is allowed; false when the gate has been shown.
 */
function enforceBrandStoryTierAccess() {
    const tier = (window.currentUser && window.currentUser.subscription && window.currentUser.subscription.tier) || 'free';
    const gate = document.getElementById('brandStoryTierGate');
    const header = document.getElementById('brandStoryHeader');
    const listEl = document.getElementById('brandStoryList');
    const emptyEl = document.getElementById('brandStoryEmpty');
    const wizardEl = document.getElementById('brandStoryWizard');
    const detailEl = document.getElementById('brandStoryDetail');

    if (tier !== 'business') {
        if (gate) gate.classList.remove('hidden');
        if (header) header.classList.add('hidden');
        if (listEl) listEl.classList.add('hidden');
        if (emptyEl) emptyEl.classList.add('hidden');
        if (wizardEl) wizardEl.classList.add('hidden');
        if (detailEl) detailEl.classList.add('hidden');
        return false;
    }

    // Business-tier user: hide the gate and let loadBrandStories() manage list/empty/wizard/detail visibility.
    if (gate) gate.classList.add('hidden');
    if (header) header.classList.remove('hidden');
    return true;
}

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

    // Relocate Ad Accounts selector into the active tab's title row as the rightmost action
    mountAdAccountsInActiveTitleRow(selectedContent);

    // Brand Story is gated to Business-tier users only — enforce *before* the ad-account
    // check so non-Business users always see the upgrade gate, regardless of ad-account state.
    if (tabName === 'brandstory' && !enforceBrandStoryTierAccess()) {
        return;
    }

    // Zero-trust: if no ad account selected, don't load data.
    // The adAccountBanner (shown by loadAdAccounts) handles the prompt.
    if (!selectedAdAccount) {
        return;
    }

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
        case 'brandvoice':
            loadBrandVoiceProfiles();
            break;
        case 'mediaassets':
            loadMediaAssets();
            break;
        case 'playables':
            loadPlayables();
            break;
        case 'brandstory':
            loadBrandStories();
            break;
    }
}

// ============================================
// OVERVIEW TAB
// ============================================

async function loadOverview() {
    if (!selectedAdAccount) {
        // Zero-trust: clear all overview metrics when no ad account
        const zeroIds = ['overviewSpend', 'overviewReach', 'overviewClicks', 'overviewImpressions'];
        zeroIds.forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '0'; });
        const el = document.getElementById('overviewSpend'); if (el) el.textContent = '$0.00';
        const ctr = document.getElementById('overviewCTR'); if (ctr) ctr.textContent = '0.00% CTR';
        const cpc = document.getElementById('overviewCPC'); if (cpc) cpc.textContent = '$0.00';
        const cpm = document.getElementById('overviewCPM'); if (cpm) cpm.textContent = '$0.00';
        const ac = document.getElementById('overviewActiveCampaigns'); if (ac) ac.textContent = '0';
        const tc = document.getElementById('overviewTotalCampaigns'); if (tc) tc.textContent = '0 total';
        const aa = document.getElementById('overviewActiveAds'); if (aa) aa.textContent = '0';
        renderOverviewCampaigns([]);
        return;
    }

    const days = document.getElementById('overviewDateRange')?.value || 30;
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    try {
        const acctParam = `&adAccountId=${selectedAdAccount.id}`;
        const response = await apiGet(`/api/marketing/analytics/overview?startDate=${startDate}&endDate=${endDate}${acctParam}`);
        if (response.success) {
            overviewData = response.overview;
            renderOverview(response.overview, days);
        }
    } catch (error) {
        console.error('Error loading overview:', error);
    }

    // Also load campaigns for the summary (scoped to ad account)
    try {
        const response = await apiGet(`/api/marketing/campaigns?status=active&adAccountId=${selectedAdAccount.id}`);
        if (response.success) {
            renderOverviewCampaigns(response.campaigns || []);
        }
    } catch (error) {
        console.error('Error loading overview campaigns:', error);
    }
}

function renderOverview(data, days) {
    document.getElementById('overviewSpend').textContent = formatCurrency(data.totalSpend || 0);
    document.getElementById('overviewSpendPeriod').textContent = `Last ${days} days`;
    document.getElementById('overviewReach').textContent = formatNumber(data.totalReach || 0);
    document.getElementById('overviewClicks').textContent = formatNumber(data.totalClicks || 0);
    document.getElementById('overviewImpressions').textContent = formatNumber(data.totalImpressions || 0);

    const ctr = data.totalImpressions > 0
        ? ((data.totalClicks / data.totalImpressions) * 100).toFixed(2)
        : '0.00';
    document.getElementById('overviewCTR').textContent = `${ctr}% CTR`;

    const cpc = data.totalClicks > 0
        ? (data.totalSpend / data.totalClicks)
        : 0;
    document.getElementById('overviewCPC').textContent = formatCurrency(cpc);

    const cpm = data.totalImpressions > 0
        ? (data.totalSpend / data.totalImpressions * 1000)
        : 0;
    document.getElementById('overviewCPM').textContent = formatCurrency(cpm);

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
    if (!selectedAdAccount) {
        // Zero-trust: show empty states for boost sub-sections
        const list = document.getElementById('boostablePostsList');
        const empty = document.getElementById('boostablePostsEmpty');
        const loading = document.getElementById('boostablePostsLoading');
        if (list) list.innerHTML = '';
        if (empty) empty.classList.remove('hidden');
        if (loading) loading.classList.add('hidden');
        const boostSection = document.getElementById('activeBoostsSection');
        if (boostSection) boostSection.classList.add('hidden');
        return;
    }
    initBoostPeriodSelector();
    await Promise.all([loadBoostablePosts(), loadActiveBoosts()]);
}

let boostPostsDays = 90; // default period

function initBoostPeriodSelector() {
    document.querySelectorAll('.boost-period-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const days = parseInt(btn.dataset.boostDays);
            if (days === boostPostsDays) return;
            boostPostsDays = days;

            // Update active button styling
            document.querySelectorAll('.boost-period-btn').forEach(b => {
                b.classList.remove('bg-white', 'text-ink-800', 'shadow-sm');
                b.classList.add('text-ink-500');
            });
            btn.classList.add('bg-white', 'text-ink-800', 'shadow-sm');
            btn.classList.remove('text-ink-500');

            loadBoostablePosts(days);
        });
    });
}

async function loadBoostablePosts(days) {
    if (days === undefined) days = boostPostsDays;
    const list = document.getElementById('boostablePostsList');
    const loading = document.getElementById('boostablePostsLoading');
    const empty = document.getElementById('boostablePostsEmpty');

    if (loading) loading.classList.remove('hidden');
    empty.classList.add('hidden');

    try {
        // Fetch both app-published posts and Meta page posts in parallel
        const [appResponse, metaResponse] = await Promise.allSettled([
            apiGet(`/api/marketing/boostable-posts?limit=50&days=${days}`),
            apiGet(`/api/marketing/page-posts?days=${days}`)
        ]);

        const appPosts = appResponse.status === 'fulfilled' && appResponse.value.success
            ? (appResponse.value.posts || []).map(p => ({ ...p, source: 'app' }))
            : [];
        const metaPosts = metaResponse.status === 'fulfilled' && metaResponse.value.success
            ? (metaResponse.value.posts || [])
            : [];

        // Log source counts for debugging
        if (appResponse.status === 'rejected') {
            console.warn('App posts fetch failed:', appResponse.reason);
        }
        if (metaResponse.status === 'rejected') {
            console.warn('Meta posts fetch failed:', metaResponse.reason);
        } else if (metaResponse.status === 'fulfilled' && !metaResponse.value.success) {
            console.warn('Meta posts returned error:', metaResponse.value.error);
        }
        console.log(`Boost posts: ${appPosts.length} from app DB, ${metaPosts.length} from Meta API (${days} days)`);

        // Deduplicate by platform_post_id — prefer Meta version (fresher engagement data)
        const seenIds = new Set();
        const merged = [];

        for (const post of metaPosts) {
            if (post.platform_post_id) seenIds.add(post.platform_post_id);
            merged.push(post);
        }
        for (const post of appPosts) {
            if (post.platform_post_id && !seenIds.has(post.platform_post_id)) {
                merged.push(post);
            }
        }

        // Sort by date descending
        merged.sort((a, b) => new Date(b.published_at || b.created_time || 0) - new Date(a.published_at || a.created_time || 0));

        boostablePosts = merged;
        if (loading) loading.classList.add('hidden');

        // Show post count
        const countEl = document.getElementById('boostPostsCount');
        if (countEl) {
            countEl.textContent = boostablePosts.length > 0 ? `(${boostablePosts.length})` : '';
        }

        if (boostablePosts.length === 0) {
            list.innerHTML = '';
            empty.classList.remove('hidden');
            return;
        }

        list.innerHTML = boostablePosts.map(post => renderBoostablePost(post)).join('');
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
    const likes = engagement.reactions || engagement.likes || engagement.like_count || 0;
    const comments = engagement.comments || engagement.comments_count || 0;
    const shares = engagement.shares || 0;
    const isFromMeta = post.source === 'meta';
    const sourceBadge = isFromMeta
        ? '<span class="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 font-medium">From Page</span>'
        : '<span class="text-xs px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-600 font-medium">App Published</span>';
    const thumbnail = post.full_picture
        ? `<img src="${escapeHtml(post.full_picture)}" alt="" class="w-16 h-16 rounded-lg object-cover flex-shrink-0">`
        : '';
    const permalink = post.permalink_url
        ? `<a href="${escapeHtml(post.permalink_url)}" target="_blank" rel="noopener" class="text-xs text-blue-500 hover:underline ml-2">View</a>`
        : '';

    return `
        <div class="card-static p-5">
            <div class="flex items-start justify-between gap-4">
                ${thumbnail}
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 mb-2 flex-wrap">
                        <span class="badge-primary text-xs">${escapeHtml(platformLabel)}</span>
                        ${sourceBadge}
                        <span class="text-xs text-ink-400">${escapeHtml(date)}</span>
                        ${permalink}
                    </div>
                    <p class="text-sm text-ink-700 line-clamp-2">${escapeHtml(preview)}</p>
                    ${likes > 0 || comments > 0 || shares > 0 ? `
                        <div class="flex items-center gap-3 mt-2 text-xs text-ink-400">
                            ${likes > 0 ? `<span>${likes} reactions</span>` : ''}
                            ${comments > 0 ? `<span>${comments} comments</span>` : ''}
                            ${shares > 0 ? `<span>${shares} shares</span>` : ''}
                        </div>
                    ` : ''}
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
        const acctParam = selectedAdAccount ? `?adAccountId=${selectedAdAccount.id}` : '';
        const response = await apiGet(`/api/marketing/boosts${acctParam}`);
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

    currentBoostPost = { ...post, platformPostId, platform, publishedPostId: post.source !== 'meta' ? post.id : null };
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

    // Set currency from ad account
    const currSym = getCurrencySymbol(getAdAccountCurrency());
    const currCode = getAdAccountCurrency();
    document.getElementById('boostCurrencySymbol').textContent = currSym;
    document.getElementById('boostMinBudgetHint').textContent = `Minimum ${currSym}1.00 per day (${currCode})`;

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
    const sym = getCurrencySymbol(getAdAccountCurrency());
    if (budgetType === 'daily') {
        totalCost = budget * days;
        breakdown = `${sym}${budget.toFixed(2)}/day x ${days} days`;
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
        errorText.textContent = `Budget must be at least ${getCurrencySymbol(getAdAccountCurrency())}1.00`;
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
        if (savedAudience?.source === 'meta' && savedAudience?.fb_audience_id) {
            // Meta Custom Audience — reference by ID
            audience = { custom_audiences: [{ id: savedAudience.fb_audience_id }] };
        } else {
            audience = savedAudience?.targeting || {};
        }
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
            sourcePublishedPostId: currentBoostPost.publishedPostId || null,
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

    if (!selectedAdAccount) {
        if (loading) loading.classList.add('hidden');
        list.innerHTML = '';
        empty.classList.remove('hidden');
        return;
    }

    if (loading) loading.classList.remove('hidden');
    empty.classList.add('hidden');

    // Auto-sync from Meta if not recently synced and Facebook connection is active
    if (isFacebookActive && selectedAdAccount && Date.now() - lastCampaignSync > AUTO_SYNC_INTERVAL) {
        try {
            await apiPost('/api/marketing/campaigns/sync');
            lastCampaignSync = Date.now();
        } catch (e) {
            console.warn('Auto-sync campaigns failed:', e.message);
        }
    }

    try {
        const params = new URLSearchParams();
        if (statusFilter) params.set('status', statusFilter);
        if (selectedAdAccount) params.set('adAccountId', selectedAdAccount.id);
        const qs = params.toString();
        const url = `/api/marketing/campaigns${qs ? '?' + qs : ''}`;
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

async function syncCampaigns() {
    const btn = document.getElementById('syncCampaignsBtn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<div class="loader-sm mx-auto"></div> Syncing...';
    }

    try {
        const response = await apiPost('/api/marketing/campaigns/sync');
        if (response.success) {
            lastCampaignSync = Date.now();
            showToast(`Synced ${response.synced} campaigns from Meta (${response.created} new, ${response.updated} updated)`, 'success');
            await loadCampaigns();
        }
    } catch (error) {
        showToast(error.message || 'Failed to sync campaigns', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
            </svg> Sync from Meta`;
        }
    }
}

function renderCampaignCard(campaign) {
    const platforms = (campaign.platforms || ['facebook']).join(', ');
    const budget = campaign.daily_budget
        ? `${formatCurrency(campaign.daily_budget)}/day`
        : campaign.lifetime_budget
            ? `${formatCurrency(campaign.lifetime_budget)} lifetime`
            : 'No budget set';
    const isSynced = campaign.metadata?.source === 'meta_sync';

    return `
        <div class="card-static p-5 cursor-pointer hover:border-brand-300 transition-colors" onclick="openCampaignDetail('${campaign.id}')">
            <div class="flex items-center justify-between">
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 mb-1 flex-wrap">
                        <p class="font-medium text-ink-800">${escapeHtml(campaign.name)}</p>
                        <span class="text-xs px-2 py-0.5 rounded-full ${getStatusClasses(campaign.status)}">${campaign.status}</span>
                        ${campaign.metadata?.boostType ? '<span class="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">Boost</span>' : ''}
                        ${isSynced ? '<span class="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-600">Synced from Meta</span>' : ''}
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
        ? `${formatCurrency(campaign.daily_budget)}/day`
        : campaign.lifetime_budget
            ? `${formatCurrency(campaign.lifetime_budget)} lifetime`
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

    if (!selectedAdAccount) {
        if (loading) loading.classList.add('hidden');
        list.innerHTML = '';
        empty.classList.remove('hidden');
        return;
    }

    if (loading) loading.classList.remove('hidden');
    empty.classList.add('hidden');

    // Auto-sync from Meta if not recently synced and Facebook connection is active
    if (isFacebookActive && Date.now() - lastAudienceSync > AUTO_SYNC_INTERVAL) {
        try {
            await apiPost('/api/marketing/audiences/sync');
            lastAudienceSync = Date.now();
        } catch (e) {
            console.warn('Auto-sync audiences failed:', e.message);
        }
    }

    try {
        const response = await apiGet(`/api/marketing/audiences?adAccountId=${selectedAdAccount.id}`);
        if (response.success) {
            audiences = response.audiences || [];
            if (loading) loading.classList.add('hidden');

            const localAudiences = audiences.filter(a => !a.source || a.source === 'local');
            const metaAudiences = audiences.filter(a => a.source === 'meta');

            if (localAudiences.length === 0 && metaAudiences.length === 0) {
                list.innerHTML = '';
                empty.classList.remove('hidden');
                return;
            }

            let html = '';

            if (metaAudiences.length > 0) {
                html += '<div class="col-span-full"><h4 class="font-semibold text-ink-800 mb-3 flex items-center gap-2"><svg class="w-4 h-4 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"></path></svg>Meta Custom Audiences</h4></div>';
                html += metaAudiences.map(a => renderMetaAudienceCard(a)).join('');
            }

            if (localAudiences.length > 0) {
                if (metaAudiences.length > 0) {
                    html += '<div class="col-span-full mt-4"><h4 class="font-semibold text-ink-800 mb-3">Your Templates</h4></div>';
                }
                html += localAudiences.map(a => renderAudienceCard(a)).join('');
            }

            list.innerHTML = html;
        }
    } catch (error) {
        console.error('Error loading audiences:', error);
        if (loading) loading.classList.add('hidden');
    }
}

async function syncAudiences() {
    const btn = document.getElementById('syncAudiencesBtn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<div class="loader-sm mx-auto"></div> Syncing...';
    }

    try {
        const response = await apiPost('/api/marketing/audiences/sync');
        if (response.success) {
            lastAudienceSync = Date.now();
            showToast(`Synced ${response.synced} audiences from Meta (${response.created} new, ${response.updated} updated)`, 'success');
            await loadAudiences();
        }
    } catch (error) {
        showToast(error.message || 'Failed to sync audiences', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
            </svg> Sync from Meta`;
        }
    }
}

function renderMetaAudienceCard(audience) {
    const sizeLabel = audience.approximate_count
        ? formatNumber(audience.approximate_count) + ' people'
        : 'Unknown size';
    const subtypeLabel = audience.subtype
        ? audience.subtype.replace(/_/g, ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase())
        : 'Custom';

    return `
        <div class="card-static p-5">
            <div class="flex items-center justify-between mb-3">
                <div>
                    <p class="font-medium text-ink-800">${escapeHtml(audience.name)}</p>
                    ${audience.description ? `<p class="text-xs text-ink-400 mt-0.5">${escapeHtml(audience.description)}</p>` : ''}
                </div>
                <span class="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-600">Meta</span>
            </div>
            <div class="flex flex-wrap gap-2 text-xs">
                <span class="bg-surface-100 text-ink-600 px-2 py-1 rounded">${escapeHtml(subtypeLabel)}</span>
                <span class="bg-surface-100 text-ink-600 px-2 py-1 rounded">~${escapeHtml(sizeLabel)}</span>
            </div>
        </div>
    `;
}

function renderAudienceCard(audience) {
    const targeting = audience.targeting || {};
    const ageRange = `${targeting.age_min || 18}-${targeting.age_max || 65}`;
    const locationCount = targeting.geo_locations?.countries?.length || 0;
    const interestCount = targeting.interests?.length || 0;
    const platforms = (audience.platforms || []).join(', ');

    const isSynced = audience.source === 'synced';
    const canPush = audience.source === 'local' && isFacebookActive;

    return `
        <div class="card-static p-5">
            <div class="flex items-center justify-between mb-3">
                <div>
                    <p class="font-medium text-ink-800">${escapeHtml(audience.name)}</p>
                    ${audience.description ? `<p class="text-xs text-ink-400 mt-0.5">${escapeHtml(audience.description)}</p>` : ''}
                </div>
                <div class="flex items-center gap-2">
                    ${audience.is_default ? '<span class="text-xs px-2 py-0.5 rounded-full bg-brand-100 text-brand-700">Default</span>' : ''}
                    ${isSynced ? '<span class="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-600">Synced to Meta</span>' : ''}
                    ${canPush ? `<button onclick="pushAudienceToMeta('${audience.id}')" class="text-ink-400 hover:text-blue-600 transition-colors" title="Save to Meta Ads Manager">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"></path>
                        </svg>
                    </button>` : ''}
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

async function pushAudienceToMeta(audienceId) {
    if (!confirm('Push this audience template to your Meta Ad Account as a Saved Audience?')) return;
    try {
        const response = await apiPost(`/api/marketing/audiences/${audienceId}/push-to-meta`);
        if (response.success) {
            showToast('Audience saved to Meta successfully', 'success');
            await loadAudiences();
        }
    } catch (error) {
        showToast(error.message || 'Failed to push audience to Meta', 'error');
    }
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
            response = await apiPost('/api/marketing/audiences', { name, description, targeting, platforms, adAccountId: selectedAdAccount?.id });
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

    if (!selectedAdAccount) {
        if (loading) loading.classList.add('hidden');
        list.innerHTML = '';
        empty.classList.remove('hidden');
        return;
    }

    if (loading) loading.classList.remove('hidden');
    empty.classList.add('hidden');

    try {
        const response = await apiGet(`/api/marketing/rules?adAccountId=${selectedAdAccount.id}`);
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
        ? `Boost with ${formatCurrency(actions.budget || 10)}/day for ${actions.duration_days || 7} days`
        : rule.rule_type === 'pause_if'
            ? 'Pause the ad'
            : 'Custom action';

    const isMetaManaged = rule.meta_rule_id && rule.meta_sync_status === 'synced';
    const isMetaError = rule.meta_rule_id && rule.meta_sync_status === 'error';
    const canPush = rule.rule_type !== 'auto_boost' && !rule.meta_rule_id && isFacebookActive;

    return `
        <div class="card-static p-5">
            <div class="flex items-center justify-between mb-3">
                <div>
                    <div class="flex items-center gap-2">
                        <p class="font-medium text-ink-800">${escapeHtml(rule.name)}</p>
                        <span class="text-xs px-2 py-0.5 rounded-full ${rule.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-surface-200 text-ink-500'}">${rule.status}</span>
                        ${isMetaManaged ? '<span class="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-600" title="This rule is evaluated by Meta\'s Ad Rules engine">Meta-Managed</span>' : ''}
                        ${isMetaError ? '<span class="text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-600" title="Meta sync failed — rule is evaluated locally as fallback">Sync Error</span>' : ''}
                    </div>
                    <p class="text-xs text-ink-400 mt-1">${rule.rule_type === 'auto_boost' ? 'Auto-Boost' : rule.rule_type === 'pause_if' ? 'Auto-Pause' : rule.rule_type}${rule.rule_type === 'auto_boost' ? ' (evaluated locally)' : ''}</p>
                </div>
                <div class="flex items-center gap-2">
                    ${canPush ? `<button onclick="pushRuleToMeta('${rule.id}')" class="text-ink-400 hover:text-blue-600 transition-colors" title="Push to Meta Ad Rules">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"></path>
                        </svg>
                    </button>` : ''}
                    ${isMetaError ? `<button onclick="pushRuleToMeta('${rule.id}')" class="text-ink-400 hover:text-amber-600 transition-colors" title="Retry push to Meta">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
                        </svg>
                    </button>` : ''}
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

async function pushRuleToMeta(ruleId) {
    if (!confirm('Push this rule to Meta? Meta will evaluate and execute it on its own schedule.')) return;
    try {
        const response = await apiPost(`/api/marketing/rules/${ruleId}/push-to-meta`);
        if (response.success) {
            showToast('Rule pushed to Meta successfully', 'success');
            await loadRules();
        }
    } catch (error) {
        showToast(error.message || 'Failed to push rule to Meta', 'error');
    }
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
                name, ruleType, conditions, actions, cooldownHours, adAccountId: selectedAdAccount?.id
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

    // Keep the first option (default "Build new targeting")
    const firstOption = select.options[0];
    select.innerHTML = '';
    select.appendChild(firstOption);

    const localAudiences = audiences.filter(a => !a.source || a.source === 'local');
    const metaAudiences = audiences.filter(a => a.source === 'meta');

    // Local targeting templates
    if (localAudiences.length > 0) {
        const group = document.createElement('optgroup');
        group.label = 'Your Templates';
        localAudiences.forEach(a => {
            const opt = document.createElement('option');
            opt.value = a.id;
            opt.textContent = a.name;
            group.appendChild(opt);
        });
        select.appendChild(group);
    }

    // Meta Custom Audiences
    if (metaAudiences.length > 0) {
        const group = document.createElement('optgroup');
        group.label = 'Meta Custom Audiences';
        metaAudiences.forEach(a => {
            const opt = document.createElement('option');
            opt.value = a.id;
            opt.dataset.source = 'meta';
            opt.dataset.fbAudienceId = a.fb_audience_id;
            const sizeStr = a.approximate_count ? ` (~${formatNumber(a.approximate_count)})` : '';
            opt.textContent = `${a.name}${sizeStr}`;
            group.appendChild(opt);
        });
        select.appendChild(group);
    }
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

async function apiPatch(url, body) {
    const token = localStorage.getItem('token');
    const response = await fetch(url, {
        method: 'PATCH',
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

// ============================================
// UTILITY FUNCTIONS
// ============================================

function getAdAccountCurrency() {
    return selectedAdAccount?.currency || 'USD';
}

function getCurrencySymbol(currencyCode) {
    try {
        const parts = new Intl.NumberFormat('en', { style: 'currency', currency: currencyCode }).formatToParts(0);
        return parts.find(p => p.type === 'currency')?.value || currencyCode;
    } catch {
        return currencyCode;
    }
}

function formatCurrency(amount) {
    const code = getAdAccountCurrency();
    try {
        return new Intl.NumberFormat('en', { style: 'currency', currency: code }).format(parseFloat(amount || 0));
    } catch {
        return '$' + parseFloat(amount || 0).toFixed(2);
    }
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

// ============================================
// BRAND VOICE
// ============================================

async function loadBrandVoiceProfiles() {
    const listEl = document.getElementById('brandVoiceProfilesList');
    const emptyEl = document.getElementById('brandVoiceEmpty');
    const loadingEl = document.getElementById('brandVoiceLoading');
    const detailEl = document.getElementById('brandVoiceDetail');

    // If viewing a profile detail, don't reload the list
    if (detailEl && !detailEl.classList.contains('hidden')) return;

    if (!selectedAdAccount) {
        if (loadingEl) loadingEl.classList.add('hidden');
        if (listEl) listEl.innerHTML = '';
        if (emptyEl) emptyEl.classList.remove('hidden');
        return;
    }

    if (loadingEl) loadingEl.classList.remove('hidden');
    if (emptyEl) emptyEl.classList.add('hidden');

    try {
        const response = await apiGet(`/api/marketing/brand-voice/profiles?adAccountId=${selectedAdAccount.id}`);
        brandVoiceProfiles = response.profiles || [];

        if (loadingEl) loadingEl.classList.add('hidden');

        if (brandVoiceProfiles.length === 0) {
            listEl.innerHTML = '';
            emptyEl.classList.remove('hidden');
            return;
        }

        emptyEl.classList.add('hidden');
        renderBrandVoiceProfiles(brandVoiceProfiles);

    } catch (error) {
        if (loadingEl) loadingEl.classList.add('hidden');
        showToast(error.message, 'error');
    }
}

function renderBrandVoiceProfiles(profiles) {
    const listEl = document.getElementById('brandVoiceProfilesList');

    listEl.innerHTML = profiles.map(profile => {
        const statusBadge = getBrandVoiceStatusBadge(profile.status);
        const platformTags = (profile.platforms_analyzed || [])
            .map(p => `<span class="text-xs bg-surface-100 text-ink-500 px-2 py-0.5 rounded-full">${p}</span>`)
            .join(' ');
        const lastAnalyzed = profile.last_analyzed_at
            ? new Date(profile.last_analyzed_at).toLocaleDateString()
            : 'Never';

        // Validation score badge
        const validation = profile.profile_data?._validation;
        const scoreBadge = validation
            ? `<span class="text-xs font-medium px-2 py-0.5 rounded-full ${validation.score >= 80 ? 'bg-green-100 text-green-700' : validation.score >= 70 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}">${validation.score}/100</span>`
            : '';

        return `
            <div class="card-gradient p-5 cursor-pointer hover:shadow-md transition-shadow" onclick="openBrandVoiceDetail('${profile.id}')">
                <div class="flex items-center justify-between mb-3">
                    <h4 class="font-semibold text-ink-800">${escapeHtml(profile.name)}</h4>
                    <div class="flex items-center gap-2">
                        ${scoreBadge}
                        ${statusBadge}
                    </div>
                </div>
                <div class="space-y-2 text-sm text-ink-500">
                    <div class="flex items-center gap-2">
                        <span>Posts analyzed:</span>
                        <span class="font-medium text-ink-700">${profile.posts_analyzed_count || 0}</span>
                    </div>
                    <div class="flex items-center gap-2 flex-wrap">
                        <span>Platforms:</span>
                        ${platformTags || '<span class="text-ink-400">None yet</span>'}
                    </div>
                    <div class="text-xs text-ink-400">Last analyzed: ${lastAnalyzed}</div>
                </div>
            </div>
        `;
    }).join('');
}

function getBrandVoiceStatusBadge(status) {
    const badges = {
        pending: '<span class="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">Pending</span>',
        collecting: '<span class="text-xs bg-blue-100 text-blue-600 px-2 py-0.5 rounded-full animate-pulse">Collecting posts...</span>',
        analyzing: '<span class="text-xs bg-amber-100 text-amber-600 px-2 py-0.5 rounded-full animate-pulse">Analyzing voice...</span>',
        ready: '<span class="text-xs bg-green-100 text-green-600 px-2 py-0.5 rounded-full">Ready</span>',
        failed: '<span class="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full">Failed</span>'
    };
    return badges[status] || badges.pending;
}

function openCreateProfileModal() {
    const modal = document.getElementById('createBvProfileModal');
    document.getElementById('bvProfileNameInput').value = '';

    // Platforms with full API history access (all posts, not just app-published)
    const fullApiPlatforms = ['twitter', 'facebook', 'instagram', 'reddit', 'threads'];

    const platformConfig = [
        { key: 'twitter',   name: 'Twitter/X',  color: '#1DA1F2' },
        { key: 'linkedin',  name: 'LinkedIn',    color: '#0A66C2' },
        { key: 'facebook',  name: 'Facebook',    color: '#1877F2' },
        { key: 'instagram', name: 'Instagram',   color: '#E4405F' },
        { key: 'reddit',    name: 'Reddit',      color: '#FF4500' },
        { key: 'telegram',  name: 'Telegram',    color: '#0088cc' },
        { key: 'whatsapp',  name: 'WhatsApp',    color: '#25D366' },
        { key: 'tiktok',    name: 'TikTok',      color: '#010101' },
        { key: 'threads',   name: 'Threads',     color: '#000000' }
    ];

    const checkboxesEl = document.getElementById('bvPlatformCheckboxes');
    checkboxesEl.innerHTML = platformConfig.map(p => {
        const hasFullApi = fullApiPlatforms.includes(p.key);
        return `
        <label class="flex items-center gap-2 p-2 rounded-lg border border-surface-200 hover:bg-surface-50 cursor-pointer transition-colors">
            <input type="checkbox" name="bvPlatform" value="${p.key}" class="rounded text-brand-600 focus:ring-brand-500">
            <div class="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0" style="background: ${p.color}15">
                <div class="w-2.5 h-2.5 rounded-full" style="background: ${p.color}"></div>
            </div>
            <span class="text-sm text-ink-700 flex-1">${p.name}</span>
            <span class="text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0 ${hasFullApi
                ? 'bg-green-50 text-green-600' : 'bg-surface-100 text-ink-400'}">${hasFullApi ? 'All posts' : 'App posts'}</span>
        </label>`;
    }).join('');

    // Update button label based on free eligibility
    const submitBtn = document.getElementById('submitCreateBvProfileBtn');
    if (submitBtn) {
        getTrainingEligibility().then(elig => {
            const priceLabel = elig.freeVoiceTraining ? 'Free' : '$9.90';
            submitBtn.innerHTML = `Create & Start Analysis &mdash; ${priceLabel}`;
        });
    }

    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function closeCreateBvProfileModal() {
    const modal = document.getElementById('createBvProfileModal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

async function submitCreateBvProfile() {
    const name = document.getElementById('bvProfileNameInput').value.trim();
    if (!name) {
        showToast('Please enter a profile name', 'error');
        return;
    }

    const checkboxes = document.querySelectorAll('input[name="bvPlatform"]:checked');
    const platforms = Array.from(checkboxes).map(cb => cb.value);

    const btn = document.getElementById('submitCreateBvProfileBtn');
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = 'Preparing checkout...';

    try {
        // Check free first-use eligibility
        const eligibility = await getTrainingEligibility();
        let purchase = null;

        if (eligibility.freeVoiceTraining) {
            // First profile is free — claim system purchase directly
            btn.textContent = 'Preparing...';
            const result = await apiPost('/api/subscriptions/claim-free-training', { purchaseType: 'voice_training' });
            purchase = result.purchase;
            await getTrainingEligibility(true); // Refresh cached eligibility
        } else {
            // Paid flow — LS checkout
            const { checkoutUrl } = await apiPost('/api/subscriptions/voice-training-checkout');

            btn.textContent = 'Pay $9.90...';
            const paid = await showCompactCheckout(checkoutUrl, btn);

            if (!paid) {
                btn.disabled = false;
                btn.innerHTML = originalHtml;
                return;
            }

            // Poll for webhook confirmation
            btn.textContent = 'Confirming payment...';
            for (let attempt = 0; attempt < 15; attempt++) {
                await new Promise(r => setTimeout(r, 2000));
                try {
                    const result = await apiGet('/api/subscriptions/voice-training-purchase-status');
                    if (result.hasPurchase) {
                        purchase = result.purchase;
                        break;
                    }
                } catch (e) { /* continue polling */ }
            }

            if (!purchase) {
                showToast('Payment received but confirmation pending. Please try again in a moment.', 'warning');
                btn.disabled = false;
                btn.innerHTML = originalHtml;
                return;
            }
        }

        // Create profile with confirmed purchase
        showToast(`${eligibility.freeVoiceTraining ? 'Free trial!' : 'Payment confirmed!'} Creating profile...`, 'success');
        btn.textContent = 'Creating profile...';

        const body = { name, adAccountId: selectedAdAccount?.id, purchaseId: purchase.id };
        if (platforms.length > 0) body.platforms = platforms;

        const response = await apiPost('/api/marketing/brand-voice/profiles', body);
        showToast('Profile created! Analyzing your posts...', 'success');
        closeCreateBvProfileModal();
        await loadBrandVoiceProfiles();
        startBrandVoicePolling(response.profile.id);
    } catch (error) {
        showToast(error.message, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
    }
}

function startBrandVoicePolling(profileId) {
    if (brandVoicePollingTimer) clearInterval(brandVoicePollingTimer);

    brandVoicePollingTimer = setInterval(async () => {
        try {
            const response = await apiGet(`/api/marketing/brand-voice/profiles/${profileId}`);
            const profile = response.profile;

            if (profile.status === 'ready' || profile.status === 'failed') {
                clearInterval(brandVoicePollingTimer);
                brandVoicePollingTimer = null;

                if (profile.status === 'ready') {
                    showToast('Brand voice analysis complete!', 'success');
                } else {
                    showToast(`Analysis failed: ${profile.error_message || 'Unknown error'}`, 'error');
                }

                // Refresh the view
                if (currentBrandVoiceProfile && currentBrandVoiceProfile.id === profileId) {
                    openBrandVoiceDetail(profileId);
                } else {
                    loadBrandVoiceProfiles();
                }
            } else {
                // Update the status badge inline (avoid full list reload to save rate limit)
                const statusBadge = document.querySelector(`[data-bv-profile-id="${profileId}"] .bv-status-badge`);
                if (statusBadge) {
                    statusBadge.textContent = profile.status === 'building' ? 'Analyzing...' : profile.status;
                }
            }
        } catch (err) {
            // Silently continue polling
        }
    }, 10000); // Poll every 10 seconds
}

async function openBrandVoiceDetail(profileId) {
    try {
        const response = await apiGet(`/api/marketing/brand-voice/profiles/${profileId}`);
        currentBrandVoiceProfile = response.profile;

        // Load image generation credits for the BV tab
        loadBvImageGenCredits();

        // Hide list, show detail
        document.getElementById('brandVoiceProfilesList').classList.add('hidden');
        document.getElementById('brandVoiceEmpty').classList.add('hidden');
        document.getElementById('brandVoiceDetail').classList.remove('hidden');

        // Fill in detail header
        document.getElementById('bvDetailName').textContent = currentBrandVoiceProfile.name;
        const platforms = (currentBrandVoiceProfile.platforms_analyzed || []).join(', ') || 'None';
        document.getElementById('bvDetailMeta').textContent =
            `${currentBrandVoiceProfile.posts_analyzed_count || 0} posts analyzed across ${platforms} | Status: ${currentBrandVoiceProfile.status}`;

        // Render profile summary
        renderBrandVoiceProfileSummary(currentBrandVoiceProfile);

        // Load generated posts history
        loadBvHistory(profileId);

        // Show/hide Build Voice Agent button based on profile readiness
        const buildAgentBtn = document.getElementById('bvBuildAgentBtn');
        if (buildAgentBtn) {
            if (currentBrandVoiceProfile.status === 'ready') {
                buildAgentBtn.classList.remove('hidden');
                buildAgentBtn.classList.add('flex');
            } else {
                buildAgentBtn.classList.add('hidden');
                buildAgentBtn.classList.remove('flex');
            }
        }

        // If still processing, start polling
        if (['pending', 'collecting', 'analyzing'].includes(currentBrandVoiceProfile.status)) {
            startBrandVoicePolling(profileId);
        }
    } catch (error) {
        showToast(error.message, 'error');
    }
}

const BV_EDIT_ICON = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg>';

function bvEditHeader(title, sectionKey) {
    return `<div class="flex items-center justify-between mb-2">
        <h5 class="font-medium text-ink-700">${title}</h5>
        <button onclick="editBvSection('${sectionKey}')" class="text-ink-400 hover:text-brand-600 transition-colors p-1" title="Edit">${BV_EDIT_ICON}</button>
    </div>`;
}

function bvEditActions(sectionKey) {
    return `<div class="flex gap-2 mt-3">
        <button onclick="saveBvSection('${sectionKey}')" class="btn-primary btn-sm">Save</button>
        <button onclick="cancelBvEdit('${sectionKey}')" class="btn-outline btn-sm">Cancel</button>
    </div>`;
}

function renderBrandVoiceProfileSummary(profile) {
    const summaryEl = document.getElementById('bvProfileSummary');
    const data = profile.profile_data;

    if (!data || Object.keys(data).length === 0) {
        summaryEl.innerHTML = `
            <div class="text-center py-6 text-ink-400">
                <p>${profile.status === 'failed' ? (profile.error_message || 'Analysis failed. Try refreshing.') : 'Profile is still being analyzed...'}</p>
            </div>
        `;
        return;
    }

    const sections = [];

    // Validation score card (not editable)
    if (data._validation) {
        const v = data._validation;
        const scoreColor = v.score >= 80 ? 'green' : v.score >= 70 ? 'amber' : 'red';

        sections.push(`
            <div class="bg-${scoreColor}-50 border border-${scoreColor}-200 rounded-xl p-4">
                <div class="flex items-center justify-between mb-3">
                    <h5 class="font-medium text-ink-700">Voice Accuracy Score</h5>
                    <div class="flex items-center gap-2">
                        <span class="text-2xl font-bold text-${scoreColor}-600">${v.score}</span>
                        <span class="text-sm text-${scoreColor}-600">/100</span>
                    </div>
                </div>
                <div class="grid grid-cols-5 gap-2 mb-3">
                    ${Object.entries(v.scores || {}).map(([key, val]) => `
                        <div class="text-center">
                            <div class="text-lg font-semibold text-ink-700">${val}</div>
                            <div class="text-xs text-ink-400">${key.replace(/_/g, ' ')}</div>
                        </div>
                    `).join('')}
                </div>
                ${v.strengths?.length ? `<div class="text-sm text-green-700 mb-1"><span class="font-medium">Strengths:</span> ${v.strengths.map(s => escapeHtml(s)).join('; ')}</div>` : ''}
                ${v.weaknesses?.length ? `<div class="text-sm text-${scoreColor}-700"><span class="font-medium">Areas to improve:</span> ${v.weaknesses.map(w => escapeHtml(w)).join('; ')}</div>` : ''}
                ${!v.passed ? `<p class="text-xs text-${scoreColor}-500 mt-2">Tip: Add more posts or refresh to improve accuracy.</p>` : ''}
            </div>
        `);
    }

    // Overall Tone — editable
    if (data.overall_tone) {
        sections.push(`
            <div class="bg-surface-50 rounded-xl p-4" data-bv-section="overall_tone">
                ${bvEditHeader('Overall Tone', 'overall_tone')}
                <div class="bv-section-display">
                    <p class="text-sm text-ink-600">${escapeHtml(data.overall_tone)}</p>
                </div>
                <div class="bv-section-edit hidden space-y-3">
                    <textarea class="input-field w-full text-sm min-h-[80px] resize-y" id="bvEdit_overall_tone">${escapeHtml(data.overall_tone)}</textarea>
                    ${bvEditActions('overall_tone')}
                </div>
            </div>
        `);
    }

    // Writing Style — editable
    if (data.writing_style) {
        const ws = data.writing_style;
        sections.push(`
            <div class="bg-surface-50 rounded-xl p-4" data-bv-section="writing_style">
                ${bvEditHeader('Writing Style', 'writing_style')}
                <div class="bv-section-display">
                    <div class="grid grid-cols-2 gap-2 text-sm">
                        ${ws.formality_level ? `<div><span class="text-ink-400">Formality:</span> <span class="text-ink-600">${escapeHtml(ws.formality_level)}</span></div>` : ''}
                        ${ws.voice ? `<div><span class="text-ink-400">Voice:</span> <span class="text-ink-600">${escapeHtml(ws.voice)}</span></div>` : ''}
                        ${ws.sentence_length ? `<div><span class="text-ink-400">Sentences:</span> <span class="text-ink-600">${escapeHtml(ws.sentence_length)}</span></div>` : ''}
                        ${ws.paragraph_structure ? `<div class="col-span-2"><span class="text-ink-400">Structure:</span> <span class="text-ink-600">${escapeHtml(ws.paragraph_structure)}</span></div>` : ''}
                    </div>
                </div>
                <div class="bv-section-edit hidden space-y-3">
                    <div class="grid grid-cols-2 gap-3">
                        <div><label class="block text-xs text-ink-400 mb-1">Formality</label><input class="input-field w-full text-sm" id="bvEdit_ws_formality" value="${escapeHtml(ws.formality_level || '')}"></div>
                        <div><label class="block text-xs text-ink-400 mb-1">Voice</label><input class="input-field w-full text-sm" id="bvEdit_ws_voice" value="${escapeHtml(ws.voice || '')}"></div>
                        <div><label class="block text-xs text-ink-400 mb-1">Sentence length</label><input class="input-field w-full text-sm" id="bvEdit_ws_sentences" value="${escapeHtml(ws.sentence_length || '')}"></div>
                        <div class="col-span-2"><label class="block text-xs text-ink-400 mb-1">Paragraph structure</label><input class="input-field w-full text-sm" id="bvEdit_ws_structure" value="${escapeHtml(ws.paragraph_structure || '')}"></div>
                    </div>
                    ${bvEditActions('writing_style')}
                </div>
            </div>
        `);
    }

    // Content Themes — editable
    if (data.content_themes && data.content_themes.length > 0) {
        sections.push(`
            <div class="bg-surface-50 rounded-xl p-4" data-bv-section="content_themes">
                ${bvEditHeader('Content Themes', 'content_themes')}
                <div class="bv-section-display">
                    <div class="flex flex-wrap gap-2">
                        ${data.content_themes.map(t => `<span class="text-xs bg-brand-50 text-brand-700 px-2 py-1 rounded-full">${escapeHtml(t)}</span>`).join('')}
                    </div>
                </div>
                <div class="bv-section-edit hidden space-y-3">
                    <div>
                        <label class="block text-xs text-ink-400 mb-1">Comma-separated themes</label>
                        <textarea class="input-field w-full text-sm min-h-[80px] resize-y" id="bvEdit_content_themes">${data.content_themes.map(t => escapeHtml(t)).join(', ')}</textarea>
                    </div>
                    ${bvEditActions('content_themes')}
                </div>
            </div>
        `);
    }

    // Vocabulary — editable
    if (data.vocabulary) {
        const vocab = data.vocabulary;
        sections.push(`
            <div class="bg-surface-50 rounded-xl p-4" data-bv-section="vocabulary">
                ${bvEditHeader('Vocabulary', 'vocabulary')}
                <div class="bv-section-display">
                    ${vocab.common_phrases?.length ? `<div class="mb-2"><span class="text-xs text-ink-400 uppercase">Common phrases:</span><div class="flex flex-wrap gap-1 mt-1">${vocab.common_phrases.map(p => `<span class="text-xs bg-surface-200 text-ink-600 px-2 py-0.5 rounded">"${escapeHtml(p)}"</span>`).join('')}</div></div>` : ''}
                    ${vocab.power_words?.length ? `<div><span class="text-xs text-ink-400 uppercase">Power words:</span><div class="flex flex-wrap gap-1 mt-1">${vocab.power_words.map(w => `<span class="text-xs bg-amber-50 text-amber-700 px-2 py-0.5 rounded">${escapeHtml(w)}</span>`).join('')}</div></div>` : ''}
                </div>
                <div class="bv-section-edit hidden space-y-3">
                    <div class="space-y-3">
                        <div><label class="block text-xs text-ink-400 mb-1">Common phrases (comma-separated)</label><textarea class="input-field w-full text-sm min-h-[70px] resize-y" id="bvEdit_vocab_phrases">${(vocab.common_phrases || []).join(', ')}</textarea></div>
                        <div><label class="block text-xs text-ink-400 mb-1">Power words (comma-separated)</label><textarea class="input-field w-full text-sm min-h-[70px] resize-y" id="bvEdit_vocab_power">${(vocab.power_words || []).join(', ')}</textarea></div>
                    </div>
                    ${bvEditActions('vocabulary')}
                </div>
            </div>
        `);
    }

    // Formatting — editable
    if (data.formatting) {
        const fmt = data.formatting;
        sections.push(`
            <div class="bg-surface-50 rounded-xl p-4" data-bv-section="formatting">
                ${bvEditHeader('Formatting', 'formatting')}
                <div class="bv-section-display">
                    <div class="space-y-1 text-sm">
                        ${fmt.emoji_usage ? `<div><span class="text-ink-400">Emojis:</span> <span class="text-ink-600">${escapeHtml(fmt.emoji_usage)}</span></div>` : ''}
                        ${fmt.hashtag_style ? `<div><span class="text-ink-400">Hashtags:</span> <span class="text-ink-600">${escapeHtml(fmt.hashtag_style)}</span></div>` : ''}
                        ${fmt.call_to_action_style ? `<div><span class="text-ink-400">CTA style:</span> <span class="text-ink-600">${escapeHtml(fmt.call_to_action_style)}</span></div>` : ''}
                    </div>
                </div>
                <div class="bv-section-edit hidden space-y-3">
                    <div class="space-y-3">
                        <div><label class="block text-xs text-ink-400 mb-1">Emoji usage</label><input class="input-field w-full text-sm" id="bvEdit_fmt_emoji" value="${escapeHtml(fmt.emoji_usage || '')}"></div>
                        <div><label class="block text-xs text-ink-400 mb-1">Hashtag style</label><input class="input-field w-full text-sm" id="bvEdit_fmt_hashtag" value="${escapeHtml(fmt.hashtag_style || '')}"></div>
                        <div><label class="block text-xs text-ink-400 mb-1">CTA style</label><input class="input-field w-full text-sm" id="bvEdit_fmt_cta" value="${escapeHtml(fmt.call_to_action_style || '')}"></div>
                    </div>
                    ${bvEditActions('formatting')}
                </div>
            </div>
        `);
    }

    // Emotional Register — editable
    if (data.emotional_register) {
        sections.push(`
            <div class="bg-surface-50 rounded-xl p-4" data-bv-section="emotional_register">
                ${bvEditHeader('Emotional Register', 'emotional_register')}
                <div class="bv-section-display">
                    <p class="text-sm text-ink-600">${escapeHtml(data.emotional_register)}</p>
                </div>
                <div class="bv-section-edit hidden space-y-3">
                    <textarea class="input-field w-full text-sm min-h-[80px] resize-y" id="bvEdit_emotional">${escapeHtml(data.emotional_register)}</textarea>
                    ${bvEditActions('emotional_register')}
                </div>
            </div>
        `);
    }

    // Unique Characteristics — editable
    if (data.unique_characteristics && data.unique_characteristics.length > 0) {
        sections.push(`
            <div class="bg-surface-50 rounded-xl p-4" data-bv-section="unique_characteristics">
                ${bvEditHeader('Unique Characteristics', 'unique_characteristics')}
                <div class="bv-section-display">
                    <ul class="text-sm text-ink-600 space-y-1">
                        ${data.unique_characteristics.map(c => `<li class="flex items-start gap-2"><span class="text-brand-500 mt-1">&#x2022;</span> ${escapeHtml(c)}</li>`).join('')}
                    </ul>
                </div>
                <div class="bv-section-edit hidden space-y-3">
                    <div>
                        <label class="block text-xs text-ink-400 mb-1">One characteristic per line</label>
                        <textarea class="input-field w-full text-sm min-h-[100px] resize-y" id="bvEdit_unique">${data.unique_characteristics.join('\n')}</textarea>
                    </div>
                    ${bvEditActions('unique_characteristics')}
                </div>
            </div>
        `);
    }

    summaryEl.innerHTML = sections.join('');
}

function editBvSection(sectionKey) {
    const card = document.querySelector(`[data-bv-section="${sectionKey}"]`);
    if (!card) return;
    card.querySelector('.bv-section-display').classList.add('hidden');
    card.querySelector('.bv-section-edit').classList.remove('hidden');
}

function cancelBvEdit(sectionKey) {
    const card = document.querySelector(`[data-bv-section="${sectionKey}"]`);
    if (!card) return;
    card.querySelector('.bv-section-display').classList.remove('hidden');
    card.querySelector('.bv-section-edit').classList.add('hidden');
}

async function saveBvSection(sectionKey) {
    if (!currentBrandVoiceProfile) return;

    const profileData = JSON.parse(JSON.stringify(currentBrandVoiceProfile.profile_data));

    switch (sectionKey) {
        case 'overall_tone':
            profileData.overall_tone = document.getElementById('bvEdit_overall_tone').value.trim();
            break;
        case 'writing_style':
            profileData.writing_style = {
                ...profileData.writing_style,
                formality_level: document.getElementById('bvEdit_ws_formality').value.trim(),
                voice: document.getElementById('bvEdit_ws_voice').value.trim(),
                sentence_length: document.getElementById('bvEdit_ws_sentences').value.trim(),
                paragraph_structure: document.getElementById('bvEdit_ws_structure').value.trim()
            };
            break;
        case 'content_themes':
            profileData.content_themes = document.getElementById('bvEdit_content_themes').value
                .split(',').map(t => t.trim()).filter(t => t.length > 0);
            break;
        case 'vocabulary':
            profileData.vocabulary = {
                ...profileData.vocabulary,
                common_phrases: document.getElementById('bvEdit_vocab_phrases').value
                    .split(',').map(p => p.trim()).filter(p => p.length > 0),
                power_words: document.getElementById('bvEdit_vocab_power').value
                    .split(',').map(w => w.trim()).filter(w => w.length > 0)
            };
            break;
        case 'formatting':
            profileData.formatting = {
                ...profileData.formatting,
                emoji_usage: document.getElementById('bvEdit_fmt_emoji').value.trim(),
                hashtag_style: document.getElementById('bvEdit_fmt_hashtag').value.trim(),
                call_to_action_style: document.getElementById('bvEdit_fmt_cta').value.trim()
            };
            break;
        case 'emotional_register':
            profileData.emotional_register = document.getElementById('bvEdit_emotional').value.trim();
            break;
        case 'unique_characteristics':
            profileData.unique_characteristics = document.getElementById('bvEdit_unique').value
                .split('\n').map(c => c.trim()).filter(c => c.length > 0);
            break;
    }

    try {
        const response = await apiPatch(
            `/api/marketing/brand-voice/profiles/${currentBrandVoiceProfile.id}`,
            { profile_data: profileData }
        );
        currentBrandVoiceProfile = response.profile;
        renderBrandVoiceProfileSummary(currentBrandVoiceProfile);
        showToast('Profile updated', 'success');
    } catch (error) {
        showToast(error.message, 'error');
    }
}

function closeBrandVoiceDetail() {
    currentBrandVoiceProfile = null;
    if (brandVoicePollingTimer) {
        clearInterval(brandVoicePollingTimer);
        brandVoicePollingTimer = null;
    }
    document.getElementById('brandVoiceDetail').classList.add('hidden');
    document.getElementById('brandVoiceProfilesList').classList.remove('hidden');
    document.getElementById('bvGeneratedContent').classList.add('hidden');
    loadBrandVoiceProfiles();
}

async function refreshCurrentProfile() {
    if (!currentBrandVoiceProfile) return;
    try {
        await apiPost(`/api/marketing/brand-voice/profiles/${currentBrandVoiceProfile.id}/refresh`);
        showToast('Refreshing brand voice analysis...', 'success');
        startBrandVoicePolling(currentBrandVoiceProfile.id);
        openBrandVoiceDetail(currentBrandVoiceProfile.id);
    } catch (error) {
        showToast(error.message, 'error');
    }
}

async function deleteCurrentProfile() {
    if (!currentBrandVoiceProfile) return;
    if (!confirm(`Delete brand voice profile "${currentBrandVoiceProfile.name}"? This cannot be undone.`)) return;

    try {
        await apiDelete(`/api/marketing/brand-voice/profiles/${currentBrandVoiceProfile.id}`);
        showToast('Profile deleted', 'success');
        closeBrandVoiceDetail();
    } catch (error) {
        showToast(error.message, 'error');
    }
}

// ============================================
// BRAND VOICE — IMAGE GENERATION CREDITS
// ============================================

async function loadBvImageGenCredits() {
    try {
        const result = await apiGet('/api/marketing/media-assets/generation-credits');
        bvImageGenCredits = result.credits || 0;
        updateBvImageGenCreditsUI();
    } catch (error) {
        console.error('Failed to load BV image gen credits:', error);
        bvImageGenCredits = 0;
        updateBvImageGenCreditsUI();
    }
}

function updateBvImageGenCreditsUI() {
    const countEl = document.getElementById('bvImageGenCreditsCount');
    const bar = document.getElementById('bvImageGenCreditsBar');
    const buyBtn = document.getElementById('bvImageGenBuyCreditsBtn');
    const imageBtn = document.getElementById('bvImageGenBtn');

    if (countEl) countEl.textContent = bvImageGenCredits;

    if (bar) {
        bar.classList.remove('hidden');
        bar.classList.add('flex');
    }

    if (buyBtn) {
        if (bvImageGenCredits <= 1) {
            buyBtn.classList.remove('hidden');
            buyBtn.classList.add('flex');
        } else {
            buyBtn.classList.add('hidden');
            buyBtn.classList.remove('flex');
        }
    }

    if (imageBtn) {
        if (bvImageGenCredits <= 0) {
            imageBtn.disabled = true;
            imageBtn.title = 'No image generation credits remaining';
        } else {
            imageBtn.disabled = false;
            imageBtn.title = '';
        }
    }
}

async function purchaseBvImageGenPack() {
    const btn = document.getElementById('bvImageGenBuyCreditsBtn') || document.getElementById('bvImageGenBtn');
    if (!btn) return;
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<div class="loader" style="width:14px;height:14px;"></div> Preparing...';

    try {
        const { checkoutUrl } = await apiPost('/api/subscriptions/asset-image-gen-pack-checkout');

        btn.innerHTML = '<div class="loader" style="width:14px;height:14px;"></div> Pay $4.90...';
        const paid = await showCompactCheckout(checkoutUrl, btn, { direction: 'up' });

        if (!paid) {
            btn.disabled = false;
            btn.innerHTML = originalHtml;
            return;
        }

        btn.innerHTML = '<div class="loader" style="width:14px;height:14px;"></div> Confirming...';
        const previousCredits = bvImageGenCredits;
        let confirmed = false;
        for (let attempt = 0; attempt < 15; attempt++) {
            await new Promise(r => setTimeout(r, 2000));
            try {
                const result = await apiGet('/api/marketing/media-assets/generation-credits');
                if (result.credits > previousCredits) {
                    bvImageGenCredits = result.credits;
                    mediaGenCredits = result.credits; // Keep in sync
                    confirmed = true;
                    break;
                }
            } catch (e) { /* continue polling */ }
        }

        if (confirmed) {
            showToast(`${bvImageGenCredits} generation credits available!`, 'success');
            updateBvImageGenCreditsUI();
            updateMediaGenCreditsUI();
        } else {
            showToast('Payment received but confirmation pending. Credits will appear shortly.', 'warning');
            setTimeout(loadBvImageGenCredits, 5000);
        }
    } catch (error) {
        showToast(error.message || 'Payment failed. Please try again.', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
    }
}

/**
 * Generate post with image using asset image generation credits (shared pool with Brand Media).
 */
async function purchaseImageGeneration() {
    if (!currentBrandVoiceProfile) {
        showToast('Select a Brand Voice profile first', 'error');
        return;
    }

    if (bvImageGenCredits <= 0) {
        showToast('No image credits remaining. Purchase a credit pack to continue.', 'warning');
        await purchaseBvImageGenPack();
        return;
    }

    await generateBrandVoiceContentWithImage();
}

/**
 * Show a compact checkout popup positioned near the trigger button.
 * Embeds the LS checkout in a small iframe with genie animation.
 * Listens for postMessage from the LS iframe for payment completion.
 *
 * @param {string} checkoutUrl - LS checkout URL (embed-enabled)
 * @param {HTMLElement} anchorEl - Element to anchor the popup near
 * @param {object} [options] - Optional configuration
 * @param {'up'|'down'} [options.direction='up'] - Pop direction relative to anchor
 * @returns {Promise<boolean>} true if payment succeeded, false if cancelled
 */
function showCompactCheckout(checkoutUrl, anchorEl, options = {}) {
    // Safari's ITP blocks third-party cookies in iframes, breaking LS checkout.
    // Fall back to full-page redirect so the checkout loads as a first-party navigation.
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    if (isSafari) {
        window.location.href = checkoutUrl;
        return new Promise(() => {}); // Page is navigating away
    }

    const direction = options.direction || 'up';
    return new Promise((resolve) => {
        // Remove any existing popup
        const existing = document.getElementById('lsCheckoutPopup');
        if (existing) existing.remove();

        // Create popup container
        const popup = document.createElement('div');
        popup.id = 'lsCheckoutPopup';
        popup.className = 'ls-checkout-popup';

        // Close button
        const closeBtn = document.createElement('button');
        closeBtn.className = 'ls-checkout-close';
        closeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
        closeBtn.title = 'Close';

        // Iframe for LS checkout — strip embed=1 param to get full (two-column) layout
        const iframeUrl = new URL(checkoutUrl);
        iframeUrl.searchParams.delete('embed');
        const iframe = document.createElement('iframe');
        iframe.src = iframeUrl.toString();
        iframe.className = 'ls-checkout-iframe';
        iframe.setAttribute('allowtransparency', 'true');
        iframe.setAttribute('allow', 'payment');

        popup.appendChild(closeBtn);
        popup.appendChild(iframe);

        // Position popup near the anchor button — scale with viewport on larger screens
        const rect = anchorEl.getBoundingClientRect();
        const popupWidth = Math.min(1100, Math.max(420, Math.round(window.innerWidth * 0.7)));
        const popupHeight = Math.min(Math.round(window.innerHeight * 0.8), Math.max(560, Math.round(window.innerHeight * 0.7)));

        // Position popup relative to button based on direction
        let left = rect.left + (rect.width / 2) - (popupWidth / 2);
        let top;
        if (direction === 'down') {
            top = rect.bottom + 12;
        } else {
            top = rect.top - popupHeight - 12;
        }

        // Clamp to viewport bounds
        left = Math.max(12, Math.min(left, window.innerWidth - popupWidth - 12));
        top = Math.max(12, Math.min(top, window.innerHeight - popupHeight - 12));

        popup.style.left = left + 'px';
        popup.style.top = top + 'px';
        popup.style.width = popupWidth + 'px';
        popup.style.height = popupHeight + 'px';

        // Set transform origin for genie animation from button center
        const btnCenterX = rect.left + rect.width / 2;
        const btnCenterY = rect.top + rect.height / 2;
        const originX = btnCenterX - left;
        const originY = btnCenterY - top;
        popup.style.transformOrigin = `${originX}px ${originY}px`;

        // Backdrop overlay (semi-transparent, click to close)
        const backdrop = document.createElement('div');
        backdrop.id = 'lsCheckoutBackdrop';
        backdrop.className = 'ls-checkout-backdrop';

        document.body.appendChild(backdrop);
        document.body.appendChild(popup);

        // Trigger genie animation
        requestAnimationFrame(() => {
            backdrop.classList.add('active');
            popup.classList.add('active');
        });

        let resolved = false;

        function cleanup() {
            if (resolved) return;
            resolved = true;
            popup.classList.remove('active');
            backdrop.classList.remove('active');
            setTimeout(() => {
                popup.remove();
                backdrop.remove();
            }, 250);
            window.removeEventListener('message', messageHandler);
            clearTimeout(timeout);
        }

        function messageHandler(event) {
            // LS checkout posts messages for events
            if (event.data?.event === 'Checkout.Success') {
                cleanup();
                resolve(true);
            }
        }

        const timeout = setTimeout(() => {
            cleanup();
            resolve(false);
        }, 5 * 60 * 1000); // 5 min timeout

        window.addEventListener('message', messageHandler);

        closeBtn.addEventListener('click', () => {
            cleanup();
            resolve(false);
        });

        backdrop.addEventListener('click', () => {
            cleanup();
            resolve(false);
        });

        // Close on Escape key
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                document.removeEventListener('keydown', escHandler);
                cleanup();
                resolve(false);
            }
        };
        document.addEventListener('keydown', escHandler);
    });
}

/**
 * Generate brand voice content with image using asset image gen credits.
 * Separated so the main generateBrandVoiceContent() stays clean for text-only.
 */
async function generateBrandVoiceContentWithImage() {
    const topic = document.getElementById('bvGenerateTopic').value.trim();
    const generateBtn = document.getElementById('bvGenerateBtn');
    const imageBtn = document.getElementById('bvImageGenBtn');
    const contentDiv = document.getElementById('bvGeneratedContent');
    const textEl = document.getElementById('bvGeneratedText');

    // Disable both buttons during generation
    generateBtn.disabled = true;
    imageBtn.disabled = true;
    imageBtn.innerHTML = '<div class="loader" style="width:16px;height:16px;"></div> Generating post + image...';

    try {
        // Read generation settings from advanced panel if available (shared with Brand Media)
        const loraScaleEl = document.getElementById('mediaLoraScale');
        const guidanceScaleEl = document.getElementById('mediaGuidanceScale');

        const body = {
            profileId: currentBrandVoiceProfile.id,
            topic: topic || undefined,
            count: 1,
            generateWithImage: true,
            loraScale: loraScaleEl ? parseFloat(loraScaleEl.value) : undefined,
            guidanceScale: guidanceScaleEl ? parseFloat(guidanceScaleEl.value) : undefined,
            aspectRatio: typeof getSelectedAspectRatio === 'function' ? getSelectedAspectRatio() : undefined
        };

        const response = await apiPost('/api/marketing/brand-voice/generate', body);
        const posts = response.posts || [];
        if (posts.length > 0) {
            textEl.textContent = posts[0].text;
            contentDiv.classList.remove('hidden');
            renderBvShareButtons();

            // Show generated image if present
            const imageDiv = document.getElementById('bvGeneratedImage');
            const imagePreview = document.getElementById('bvGeneratedImagePreview');
            if (posts[0].imageUrl && imageDiv && imagePreview) {
                imagePreview.src = posts[0].imageUrl;
                imageDiv.classList.remove('hidden');
            } else if (imageDiv) {
                imageDiv.classList.add('hidden');
            }

            // Update credit count from response
            if (posts[0].creditsRemaining !== undefined) {
                bvImageGenCredits = posts[0].creditsRemaining;
                mediaGenCredits = posts[0].creditsRemaining; // Keep in sync
                updateBvImageGenCreditsUI();
                updateMediaGenCreditsUI();
            } else {
                await loadBvImageGenCredits();
            }

            // Warn if image generation failed but text was still returned
            if (posts[0].imageError) {
                showToast(posts[0].imageErrorMessage || 'Image generation failed, but your post was created.', 'warning');
            }

            // Refresh history to show the newly generated post
            loadBvHistory(currentBrandVoiceProfile.id);
        }
    } catch (error) {
        showToast(error.message || 'Failed to generate content', 'error');
    } finally {
        generateBtn.disabled = false;
        imageBtn.disabled = bvImageGenCredits <= 0;
        imageBtn.innerHTML = '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg> Generate Post +Image';
    }
}

// ============================================
// BRAND VOICE - CONTENT GENERATION
// ============================================

async function generateBrandVoiceContent() {
    if (!currentBrandVoiceProfile) return;

    const topic = document.getElementById('bvGenerateTopic').value.trim();
    const btn = document.getElementById('bvGenerateBtn');
    const imageBtn = document.getElementById('bvImageGenBtn');
    const contentDiv = document.getElementById('bvGeneratedContent');
    const textEl = document.getElementById('bvGeneratedText');

    btn.disabled = true;
    if (imageBtn) imageBtn.disabled = true;
    btn.innerHTML = '<div class="loader" style="width:16px;height:16px;"></div> Generating...';

    try {
        const body = {
            profileId: currentBrandVoiceProfile.id,
            topic: topic || undefined,
            count: 1
        };

        const response = await apiPost('/api/marketing/brand-voice/generate', body);

        const posts = response.posts || [];
        if (posts.length > 0) {
            textEl.textContent = posts[0].text;
            contentDiv.classList.remove('hidden');
            renderBvShareButtons();

            // Show generated image if present (future phase)
            const imageDiv = document.getElementById('bvGeneratedImage');
            const imagePreview = document.getElementById('bvGeneratedImagePreview');
            if (posts[0].imageUrl && imageDiv && imagePreview) {
                imagePreview.src = posts[0].imageUrl;
                imageDiv.classList.remove('hidden');
            } else if (imageDiv) {
                imageDiv.classList.add('hidden');
            }

            // Refresh history to show the newly generated post
            loadBvHistory(currentBrandVoiceProfile.id);
        }
    } catch (error) {
        showToast(error.message, 'error');
    } finally {
        btn.disabled = false;
        if (imageBtn) imageBtn.disabled = false;
        btn.innerHTML = `
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path>
            </svg>
            Generate Post
        `;
    }
}

const BV_SHARE_PLATFORMS = [
    { key: 'twitter',   name: 'Twitter/X',  color: '#1DA1F2', icon: '<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>' },
    { key: 'linkedin',  name: 'LinkedIn',    color: '#0A66C2', icon: '<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>' },
    { key: 'facebook',  name: 'Facebook',    color: '#1877F2', icon: '<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>' },
    { key: 'instagram', name: 'Instagram',   color: '#E4405F', icon: '<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/></svg>' },
    { key: 'reddit',    name: 'Reddit',      color: '#FF4500', icon: '<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 0 0 .029-.463.33.33 0 0 0-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 0 0-.232-.095z"/></svg>' },
    { key: 'telegram',  name: 'Telegram',    color: '#0088cc', icon: '<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>' },
    { key: 'whatsapp',  name: 'WhatsApp',    color: '#25D366', icon: '<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>' },
    { key: 'tiktok',    name: 'TikTok',      color: '#010101', icon: '<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></svg>' },
    { key: 'threads',   name: 'Threads',     color: '#000000', icon: '<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.03-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.589 12c.027 3.086.718 5.496 2.057 7.164 1.43 1.783 3.631 2.698 6.54 2.717 2.623-.02 4.358-.631 5.8-2.045 1.647-1.613 1.618-3.593 1.09-4.798-.31-.71-.873-1.3-1.634-1.75-.192 1.352-.622 2.446-1.284 3.272-.886 1.102-2.14 1.704-3.73 1.79-1.202.065-2.361-.218-3.259-.801-1.063-.689-1.685-1.74-1.752-2.96-.065-1.17.408-2.263 1.334-3.076.862-.757 2.063-1.196 3.395-1.242.92-.03 1.77.08 2.553.312-.025-1.268-.244-2.22-.679-2.889-.493-.757-1.272-1.14-2.317-1.14h-.037c-.748.007-1.39.211-1.847.59-.374.31-.6.7-.674 1.15l-2.03-.354c.201-1.156.795-2.1 1.72-2.726.868-.588 1.979-.903 3.218-.91h.054c1.677 0 2.96.577 3.81 1.715.706.946 1.073 2.27 1.116 3.932.536.242 1.024.54 1.46.897 1.157.944 1.928 2.263 2.23 3.812.354 1.819.044 4.074-1.673 5.757-1.862 1.826-4.175 2.622-7.268 2.644z"/></svg>' }
];

function renderBvShareButtons() {
    const container = document.getElementById('bvPlatformButtons');
    container.innerHTML = BV_SHARE_PLATFORMS.map(p => `
        <button onclick="shareBvPost('${p.key}')"
            class="flex items-center gap-2 px-3 py-2 rounded-lg border border-surface-200 transition-all text-sm font-medium
            hover:shadow-sm hover:border-surface-300"
            style="--platform-color: ${p.color}"
            onmouseenter="this.style.borderColor='${p.color}'; this.style.background='${p.color}10'"
            onmouseleave="this.style.borderColor=''; this.style.background=''"
            title="Share on ${p.name}">
            <span style="color: ${p.color}">${p.icon}</span>
            <span class="text-ink-600">${p.name}</span>
            <svg class="w-3 h-3 text-ink-300 ml-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path></svg>
        </button>
    `).join('');
}

async function shareBvPost(platform) {
    const textEl = document.getElementById('bvGeneratedText');
    const text = textEl.textContent;
    if (!text) return;

    const imagePreview = document.getElementById('bvGeneratedImagePreview');
    const imageDiv = document.getElementById('bvGeneratedImage');
    const hasImage = imageDiv && !imageDiv.classList.contains('hidden') && imagePreview?.src;

    const encoded = encodeURIComponent(text);

    // Platforms with native share URL support for pre-filled text
    const shareUrls = {
        twitter:  `https://twitter.com/intent/tweet?text=${encoded}`,
        reddit:   `https://www.reddit.com/submit?selftext=true&title=${encodeURIComponent(text.substring(0, 120))}&text=${encoded}`,
        telegram: `https://t.me/share/url?url=&text=${encoded}`,
        whatsapp: `https://wa.me/?text=${encoded}`
    };

    // Platforms that don't support pre-filled text — copy to clipboard + open compose
    const copyThenOpen = {
        linkedin:  'https://www.linkedin.com/feed/?shareActive=true',
        facebook:  'https://www.facebook.com/',
        instagram: 'https://www.instagram.com/',
        tiktok:    'https://www.tiktok.com/upload',
        threads:   'https://www.threads.net/'
    };

    if (shareUrls[platform]) {
        // These platforms support pre-filled text via URL params
        // Also copy text+image to clipboard as a bonus for manual paste
        if (hasImage) {
            await copyTextAndImage(text, imagePreview.src);
            showToast(`Post & image copied to clipboard! Opening ${getBvPlatformName(platform)}...`, 'success');
        }
        window.open(shareUrls[platform], '_blank', 'noopener,noreferrer');
    } else if (copyThenOpen[platform]) {
        // These platforms require manual paste — copy to clipboard first
        if (hasImage) {
            await copyTextAndImage(text, imagePreview.src);
        } else {
            await copyToClipboard(text);
        }
        showToast(`Post${hasImage ? ' & image' : ''} copied to clipboard! Paste it on ${getBvPlatformName(platform)}.`, 'success');
        window.open(copyThenOpen[platform], '_blank', 'noopener,noreferrer');
    }
}

async function copyTextAndImage(text, imageSrc) {
    try {
        const response = await fetch(imageSrc);
        const blob = await response.blob();
        // Use ClipboardItem API for multi-type clipboard (text + image)
        const items = [
            new ClipboardItem({
                'text/plain': new Blob([text], { type: 'text/plain' }),
                [blob.type]: blob
            })
        ];
        await navigator.clipboard.write(items);
    } catch (err) {
        // Fallback: copy text only if image clipboard fails (Safari/older browsers)
        console.warn('Image clipboard not supported, falling back to text only:', err);
        await copyToClipboard(text);
    }
}

function getBvPlatformName(key) {
    const found = BV_SHARE_PLATFORMS.find(p => p.key === key);
    return found ? found.name : key;
}

function copyToClipboard(text) {
    return navigator.clipboard.writeText(text).catch(() => {
        const temp = document.createElement('textarea');
        temp.value = text;
        document.body.appendChild(temp);
        temp.select();
        document.execCommand('copy');
        document.body.removeChild(temp);
        return Promise.resolve();
    });
}

function copyGeneratedContent() {
    const textEl = document.getElementById('bvGeneratedText');
    const text = textEl.textContent;
    copyToClipboard(text).then(() => {
        showToast('Copied to clipboard!', 'success');
    });
}

// ============================================
// BRAND VOICE — VOICE AGENT MODAL
// ============================================

const VA_PLATFORM_INFO = {
    twitter:   { name: 'Twitter/X',  color: '#1DA1F2', icon: '\uD835\uDD4F' },
    linkedin:  { name: 'LinkedIn',   color: '#0077B5', icon: 'in' },
    reddit:    { name: 'Reddit',     color: '#FF4500', icon: 'r/' },
    facebook:  { name: 'Facebook',   color: '#1877F2', icon: 'f' },
    telegram:  { name: 'Telegram',   color: '#0088cc', icon: 'tg' },
    whatsapp:  { name: 'WhatsApp',   color: '#25D366', icon: 'wa' },
    instagram: { name: 'Instagram',  color: '#E4405F', icon: 'ig' },
    threads:   { name: 'Threads',    color: '#000000', icon: '@' },
    tiktok:    { name: 'TikTok',     color: '#010101', icon: 'tk' },
    youtube:   { name: 'YouTube',    color: '#FF0000', icon: 'yt' }
};

// Only show platforms that agents table supports
const VA_ALLOWED_PLATFORMS = ['twitter', 'linkedin', 'reddit', 'facebook', 'instagram', 'tiktok', 'youtube', 'telegram', 'whatsapp', 'threads'];

const VA_VIDEO_PLATFORMS = ['tiktok', 'youtube'];

// Cached connections data for submit
let _vaConnections = [];

async function showVoiceAgentModal() {
    const modal = document.getElementById('voiceAgentModal');
    if (!modal) return;

    // Reset fields
    document.getElementById('vaName').value = '';
    document.getElementById('vaContentType').value = 'text_only';
    document.getElementById('vaContentType').disabled = false;
    document.getElementById('vaDirection').value = '';
    document.getElementById('vaLanguage').value = 'en';
    document.getElementById('vaPostsPerDay').value = '3';
    document.getElementById('vaStartTime').value = '09:00';
    document.getElementById('vaEndTime').value = '21:00';
    document.getElementById('vaSubmitBtn').textContent = 'Create';
    document.getElementById('vaSubmitBtn').disabled = false;

    const errorEl = document.getElementById('vaError');
    errorEl.classList.add('hidden');
    errorEl.textContent = '';

    const platformError = document.getElementById('vaPlatformError');
    if (platformError) { platformError.textContent = ''; platformError.classList.add('hidden'); }

    const lockEl = document.getElementById('vaContentTypeLock');
    const hintEl = document.getElementById('vaContentTypeHint');
    if (lockEl) lockEl.classList.add('hidden');
    if (hintEl) hintEl.classList.remove('hidden');

    // Load connections and render platform grid
    const grid = document.getElementById('vaPlatformGrid');
    grid.innerHTML = '<div class="col-span-2 text-center py-3 text-sm text-ink-400">Loading platforms...</div>';

    try {
        const token = localStorage.getItem('token');
        const [connResp, agentsResp] = await Promise.all([
            fetch('/api/connections', { headers: { 'Authorization': `Bearer ${token}` }, credentials: 'include' }),
            fetch('/api/agents', { headers: { 'Authorization': `Bearer ${token}` }, credentials: 'include' })
        ]);

        const connData = connResp.ok ? await connResp.json() : { connections: [] };
        const agentsData = agentsResp.ok ? await agentsResp.json() : { agents: [] };

        const connections = (connData.connections || []).filter(c => c.status === 'active' && VA_ALLOWED_PLATFORMS.includes(c.platform));
        const existingAgentConnectionIds = (agentsData.agents || []).map(a => a.connection_id);
        _vaConnections = connections;

        grid.innerHTML = '';

        if (connections.length === 0) {
            grid.innerHTML = '<div class="col-span-2 text-center py-3 text-sm text-ink-400">No platforms connected. Connect platforms in Settings first.</div>';
        } else {
            for (const conn of connections) {
                const info = VA_PLATFORM_INFO[conn.platform] || { name: conn.platform, color: '#6B7280', icon: '?' };
                const hasAgent = existingAgentConnectionIds.includes(conn.id);
                const isVideo = VA_VIDEO_PLATFORMS.includes(conn.platform);
                const username = conn.platform_username ? `@${conn.platform_username}` : '';

                // Instagram gets two checkboxes: Image (post) and Video (reels)
                if (conn.platform === 'instagram') {
                    // Instagram Image (post)
                    const cardImg = document.createElement('label');
                    cardImg.className = `flex items-center gap-2.5 p-2.5 border rounded-xl cursor-pointer transition-all duration-150 ${hasAgent ? 'border-surface-200 opacity-50 cursor-not-allowed' : 'border-surface-200 hover:border-brand-300 hover:bg-brand-50/30'}`;
                    cardImg.innerHTML = `
                        <input type="checkbox" name="vaPlatforms" value="${conn.id}" data-platform="instagram" data-ig-type="post" class="checkbox flex-shrink-0" ${hasAgent ? 'disabled' : ''}>
                        <div class="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0" style="background: ${info.color}15;">
                            <span class="font-bold text-[10px]" style="color: ${info.color};">${info.icon}</span>
                        </div>
                        <div class="min-w-0">
                            <p class="text-sm font-medium text-ink-800 leading-tight">Instagram <span class="text-[10px] text-ink-400">(image)</span></p>
                            ${username ? `<p class="text-[11px] text-ink-400 truncate">${escapeHtml(username)}</p>` : ''}
                            ${hasAgent ? '<p class="text-[10px] text-amber-600">Agent exists</p>' : ''}
                        </div>
                    `;
                    grid.appendChild(cardImg);
                    const cbImg = cardImg.querySelector('input[type="checkbox"]');
                    cbImg.addEventListener('change', () => {
                        cardImg.classList.toggle('border-brand-400', cbImg.checked);
                        cardImg.classList.toggle('bg-brand-50/40', cbImg.checked);
                        vaUpdateVideoLock();
                    });

                    // Instagram Video (reels)
                    const cardVid = document.createElement('label');
                    cardVid.className = `flex items-center gap-2.5 p-2.5 border rounded-xl cursor-pointer transition-all duration-150 ${hasAgent ? 'border-surface-200 opacity-50 cursor-not-allowed' : 'border-surface-200 hover:border-brand-300 hover:bg-brand-50/30'}`;
                    cardVid.innerHTML = `
                        <input type="checkbox" name="vaPlatforms" value="${conn.id}" data-platform="instagram" data-ig-type="reels" class="checkbox flex-shrink-0" ${hasAgent ? 'disabled' : ''}>
                        <div class="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0" style="background: ${info.color}15;">
                            <span class="font-bold text-[10px]" style="color: ${info.color};">${info.icon}</span>
                        </div>
                        <div class="min-w-0">
                            <p class="text-sm font-medium text-ink-800 leading-tight">Instagram <span class="text-[10px] text-ink-400">(video)</span></p>
                            ${username ? `<p class="text-[11px] text-ink-400 truncate">${escapeHtml(username)}</p>` : ''}
                            ${hasAgent ? '<p class="text-[10px] text-amber-600">Agent exists</p>' : ''}
                        </div>
                    `;
                    grid.appendChild(cardVid);
                    const cbVid = cardVid.querySelector('input[type="checkbox"]');
                    cbVid.addEventListener('change', () => {
                        cardVid.classList.toggle('border-brand-400', cbVid.checked);
                        cardVid.classList.toggle('bg-brand-50/40', cbVid.checked);
                        vaUpdateVideoLock();
                    });
                    continue;
                }

                const card = document.createElement('label');
                card.className = `flex items-center gap-2.5 p-2.5 border rounded-xl cursor-pointer transition-all duration-150 ${hasAgent ? 'border-surface-200 opacity-50 cursor-not-allowed' : 'border-surface-200 hover:border-brand-300 hover:bg-brand-50/30'}`;
                card.innerHTML = `
                    <input type="checkbox" name="vaPlatforms" value="${conn.id}" data-platform="${conn.platform}" class="checkbox flex-shrink-0" ${hasAgent ? 'disabled' : ''}>
                    <div class="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0" style="background: ${info.color}15;">
                        <span class="font-bold text-[10px]" style="color: ${info.color};">${info.icon}</span>
                    </div>
                    <div class="min-w-0">
                        <p class="text-sm font-medium text-ink-800 leading-tight">${info.name}${isVideo ? ' <span class="text-[10px] text-ink-400">(video)</span>' : ''}</p>
                        ${username ? `<p class="text-[11px] text-ink-400 truncate">${escapeHtml(username)}</p>` : ''}
                        ${hasAgent ? '<p class="text-[10px] text-amber-600">Agent exists</p>' : ''}
                    </div>
                `;
                grid.appendChild(card);

                // Highlight on check and trigger video lock logic
                const cb = card.querySelector('input[type="checkbox"]');
                cb.addEventListener('change', () => {
                    card.classList.toggle('border-brand-400', cb.checked);
                    card.classList.toggle('bg-brand-50/40', cb.checked);
                    vaUpdateVideoLock();
                });
            }
        }
    } catch (error) {
        console.error('Error loading connections for voice agent modal:', error);
        grid.innerHTML = '<div class="col-span-2 text-center py-3 text-sm text-red-500">Failed to load platforms</div>';
    }

    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

/** Lock content type to Post+Image when a video platform or Instagram (video) is selected */
function vaUpdateVideoLock() {
    const checked = document.querySelectorAll('input[name="vaPlatforms"]:checked');
    const hasVideo = Array.from(checked).some(cb => VA_VIDEO_PLATFORMS.includes(cb.dataset.platform));
    const hasInstagramVideo = Array.from(checked).some(cb => cb.dataset.platform === 'instagram' && cb.dataset.igType === 'reels');

    const contentSelect = document.getElementById('vaContentType');
    const lockEl = document.getElementById('vaContentTypeLock');
    const hintEl = document.getElementById('vaContentTypeHint');

    if (hasVideo || hasInstagramVideo) {
        contentSelect.value = 'text_and_image';
        contentSelect.disabled = true;
        const reasons = [];
        if (hasVideo) reasons.push('TikTok/YouTube');
        if (hasInstagramVideo) reasons.push('Instagram Video');
        if (lockEl) { lockEl.classList.remove('hidden'); lockEl.textContent = `Locked: ${reasons.join(', ')} require Post + Image.`; }
        if (hintEl) hintEl.classList.add('hidden');
    } else {
        contentSelect.disabled = false;
        if (lockEl) lockEl.classList.add('hidden');
        if (hintEl) hintEl.classList.remove('hidden');
    }
}

function closeVoiceAgentModal() {
    const modal = document.getElementById('voiceAgentModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
}

async function submitVoiceAgent() {
    const btn = document.getElementById('vaSubmitBtn');
    const errorEl = document.getElementById('vaError');
    errorEl.classList.add('hidden');
    errorEl.textContent = '';

    const name = document.getElementById('vaName').value.trim();
    const contentType = document.getElementById('vaContentType').value;
    const direction = document.getElementById('vaDirection').value.trim();
    const language = document.getElementById('vaLanguage').value;
    const postsPerDay = document.getElementById('vaPostsPerDay').value;
    const startTime = document.getElementById('vaStartTime').value;
    const endTime = document.getElementById('vaEndTime').value;

    // Get selected platforms — consolidate Instagram image/video into one agent
    const checkedPlatforms = document.querySelectorAll('input[name="vaPlatforms"]:checked');
    const agentMap = new Map(); // connectionId → { connectionId, platform, igContentTypes[] }
    for (const cb of checkedPlatforms) {
        const connId = cb.value;
        const platform = cb.dataset.platform;
        const igType = cb.dataset.igType || null;

        if (!agentMap.has(connId)) {
            agentMap.set(connId, { connectionId: connId, platform, igContentTypes: [] });
        }
        if (platform === 'instagram' && igType) {
            agentMap.get(connId).igContentTypes.push(igType);
        }
    }
    const agentsToCreate = Array.from(agentMap.values());

    // Validation
    if (!name) {
        errorEl.textContent = 'Agent name is required.';
        errorEl.classList.remove('hidden');
        return;
    }
    if (agentsToCreate.length === 0) {
        errorEl.textContent = 'Please select at least one platform.';
        errorEl.classList.remove('hidden');
        return;
    }
    if (!currentBrandVoiceProfile?.id) {
        errorEl.textContent = 'No brand voice profile selected.';
        errorEl.classList.remove('hidden');
        return;
    }

    btn.textContent = `Creating ${agentsToCreate.length} agent${agentsToCreate.length > 1 ? 's' : ''}...`;
    btn.disabled = true;

    const results = { success: [], failed: [] };

    for (const { connectionId, platform, igContentTypes } of agentsToCreate) {
        const info = VA_PLATFORM_INFO[platform] || { name: platform };
        const agentName = agentsToCreate.length > 1 ? `${name} (${info.name})` : name;

        const settings = {
            contentSource: 'brand_voice',
            brandVoiceSettings: {
                profileId: currentBrandVoiceProfile.id,
                generateWithImage: contentType === 'text_and_image',
                direction: direction || null
            },
            topics: [],
            keywords: [],
            geoFilter: {
                contentLanguage: language || 'en'
            },
            schedule: {
                postsPerDay: parseInt(postsPerDay) || 3,
                startTime: startTime || '09:00',
                endTime: endTime || '21:00'
            },
            contentStyle: {
                tone: 'brand_voice',
                includeHashtags: true
            }
        };

        // Set Instagram content types if applicable
        if (platform === 'instagram' && igContentTypes.length > 0) {
            settings.platformSettings = {
                instagram: { contentTypes: igContentTypes }
            };
        }

        try {
            await apiPost('/api/agents', { connectionId, name: agentName, settings });
            results.success.push(info.name);
        } catch (error) {
            results.failed.push(`${info.name}: ${error.message}`);
        }
    }

    btn.textContent = 'Create';
    btn.disabled = false;

    if (results.success.length > 0) {
        showToast(`Voice agent${results.success.length > 1 ? 's' : ''} created for ${results.success.join(', ')}! Check the Autonomous Agents tab.`, 'success');
    }
    if (results.failed.length > 0) {
        errorEl.textContent = `Failed: ${results.failed.join('; ')}`;
        errorEl.classList.remove('hidden');
    }
    if (results.failed.length === 0) {
        closeVoiceAgentModal();
    }
}

// ============================================
// BRAND VOICE — GENERATED POSTS HISTORY
// ============================================

const BV_PLATFORM_COLORS = {
    twitter: '#1DA1F2', linkedin: '#0A66C2', facebook: '#1877F2',
    instagram: '#E4405F', reddit: '#FF4500', telegram: '#0088cc',
    whatsapp: '#25D366', tiktok: '#010101', threads: '#000000'
};

function bvRelativeTime(dateStr) {
    const now = Date.now();
    const diff = now - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(dateStr).toLocaleDateString();
}

async function loadBvHistory(profileId) {
    const listEl = document.getElementById('bvHistoryList');
    const emptyEl = document.getElementById('bvHistoryEmpty');
    const loadingEl = document.getElementById('bvHistoryLoading');

    loadingEl.classList.remove('hidden');
    emptyEl.classList.add('hidden');
    listEl.innerHTML = '';

    try {
        const response = await apiGet(`/api/marketing/brand-voice/profiles/${profileId}/generated`);
        const posts = response.posts || [];

        loadingEl.classList.add('hidden');

        if (posts.length === 0) {
            emptyEl.classList.remove('hidden');
            return;
        }

        listEl.innerHTML = posts.map(post => renderBvHistoryCard(post)).join('');
    } catch (error) {
        loadingEl.classList.add('hidden');
        listEl.innerHTML = `<p class="text-sm text-red-500 text-center py-4">Failed to load history</p>`;
    }
}

function renderBvHistoryCard(post) {
    const platformColor = BV_PLATFORM_COLORS[post.platform] || '#6B7280';
    const platformName = getBvPlatformName(post.platform) || post.platform || 'Auto';
    const timeAgo = bvRelativeTime(post.created_at);
    const contentEscaped = escapeHtml(post.content);
    const topicLabel = post.topic ? escapeHtml(post.topic) : '';

    return `
        <div class="bg-surface-50 rounded-xl p-4 group" id="bvHistory_${post.id}">
            <div class="flex items-center justify-between mb-2">
                <div class="flex items-center gap-2">
                    <span class="text-xs font-medium px-2 py-0.5 rounded-full"
                        style="background: ${platformColor}15; color: ${platformColor}">
                        ${platformName}
                    </span>
                    ${topicLabel ? `<span class="text-xs text-ink-400">${topicLabel}</span>` : ''}
                </div>
                <div class="flex items-center gap-2">
                    <span class="text-xs text-ink-400">${timeAgo}</span>
                    <button onclick="copyBvHistoryPost('${post.id}')" class="text-ink-300 hover:text-ink-600 transition-colors p-1" title="Copy">
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"></path>
                        </svg>
                    </button>
                    <button onclick="deleteBvHistoryPost('${post.id}')" class="text-ink-300 hover:text-red-500 transition-colors p-1" title="Delete">
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                        </svg>
                    </button>
                </div>
            </div>
            <div class="text-sm text-ink-600 whitespace-pre-wrap leading-relaxed bv-history-content">${contentEscaped}</div>
            ${post.image_url ? `
                <div class="mt-3">
                    <img src="${escapeHtml(post.image_url)}" alt="Generated image" class="w-full max-w-xs rounded-lg border border-surface-200">
                </div>
            ` : ''}
        </div>
    `;
}

async function copyBvHistoryPost(postId) {
    const card = document.getElementById(`bvHistory_${postId}`);
    if (!card) return;
    const text = card.querySelector('.bv-history-content').textContent;
    const img = card.querySelector('img');
    if (img && img.src) {
        await copyTextAndImage(text, img.src);
        showToast('Post & image copied to clipboard!', 'success');
    } else {
        await copyToClipboard(text);
        showToast('Copied to clipboard!', 'success');
    }
}

async function deleteBvHistoryPost(postId) {
    if (!confirm('Delete this generated post?')) return;

    try {
        await apiDelete(`/api/marketing/brand-voice/generated/${postId}`);
        const card = document.getElementById(`bvHistory_${postId}`);
        if (card) {
            card.style.transition = 'opacity 0.2s, transform 0.2s';
            card.style.opacity = '0';
            card.style.transform = 'translateX(20px)';
            setTimeout(() => {
                card.remove();
                // Check if list is now empty
                const listEl = document.getElementById('bvHistoryList');
                if (!listEl.children.length) {
                    document.getElementById('bvHistoryEmpty').classList.remove('hidden');
                }
            }, 200);
        }
        showToast('Post deleted', 'success');
    } catch (error) {
        showToast(error.message, 'error');
    }
}

// ============================================
// MEDIA ASSETS TAB
// ============================================

/**
 * Load all media assets data for the selected ad account.
 */
async function loadMediaAssets() {
    if (!selectedAdAccount) {
        showToast('Please select an ad account first', 'error');
        return;
    }

    const acctId = selectedAdAccount.id;

    // Load assets, training history, and active training status
    // Generated media is loaded on-demand when a model is selected
    const [assetsResult, historyResult, activeResult] = await Promise.allSettled([
        apiGet(`/api/marketing/media-assets?adAccountId=${acctId}`),
        apiGet(`/api/marketing/media-assets/training/history?adAccountId=${acctId}`),
        apiGet(`/api/marketing/media-assets/training/status?adAccountId=${acctId}`)
    ]);

    // Assets
    if (assetsResult.status === 'fulfilled') {
        mediaAssets = assetsResult.value.assets || [];
    } else {
        console.error('[MediaAssets] Failed to load assets:', assetsResult.reason);
        mediaAssets = [];
    }

    // Training history (all sessions)
    if (historyResult.status === 'fulfilled') {
        mediaTrainingJobs = historyResult.value.jobs || [];
    } else {
        console.error('[MediaAssets] Failed to load training history:', historyResult.reason);
        mediaTrainingJobs = [];
    }

    // Active training (currently in-progress, if any)
    if (activeResult.status === 'fulfilled') {
        activeTrainingJob = activeResult.value.job || null;
    } else {
        console.error('[MediaAssets] Failed to load active training:', activeResult.reason);
        activeTrainingJob = null;
    }

    // Start clean — new model mode, no model selected
    mediaViewMode = 'new';
    selectedTrainingJob = null;
    generatedMedia = [];

    // In new model mode, the upload pool should be fresh (only show images not yet used in any training)
    // The aggregate pool from the API includes images that may have been used in previous trainings
    // Clear it — users upload fresh images for each new model
    if (mediaTrainingJobs.length > 0) {
        // User has existing models — start with empty pool for new model creation
        mediaAssets = [];
    }
    // If no models exist yet, keep the loaded assets (user may have uploaded but not trained yet)

    // Pre-load generation credits so they're ready when a model is selected
    loadMediaGenCredits();

    renderMediaAssetGrid();
    renderActiveTrainingStatus();
    renderTrainingHistory();
    renderGenerationSection();
    renderGeneratedMedia();

    initMediaDropZone();

    // Update training button label with free/paid pricing
    onGenerationModelChange();

    // If training is in progress, start polling
    if (activeTrainingJob && activeTrainingJob.status === 'training') {
        startTrainingPolling();
    }

    // Auto-select the default model if one exists (so credits bar and generate form are ready)
    const defaultJob = mediaTrainingJobs.find(j => j.is_default && j.status === 'completed');
    if (defaultJob && !activeTrainingJob) {
        switchToViewModelMode(defaultJob.id);
    }
}

/**
 * Switch to New Model mode — fresh state for creating a new model.
 * Called by the "+New Model" button.
 */
function switchToNewModelMode() {
    mediaViewMode = 'new';
    selectedTrainingJob = null;
    generatedMedia = [];
    latestGeneratedImageUrl = null;

    // Clear local UI state only — uploaded images stay in storage for training job references
    mediaAssets = [];

    // Re-render all sections in new-model context
    renderMediaAssetGrid();
    updateTrainButtonState();
    renderTrainingHistory();
    renderGenerationSection();
    renderGeneratedMedia();
    renderBrandKit(null); // Hide brand kit in new model mode

    // Clear any previous generation preview
    const result = document.getElementById('mediaGenerateResult');
    if (result) result.classList.add('hidden');
    const promptInput = document.getElementById('mediaGeneratePrompt');
    if (promptInput) promptInput.value = '';
}

/**
 * Switch to View Model mode — inspect a past model's context.
 * Shows read-only training image snapshots, generated images for this model, and enables generation.
 */
function switchToViewModelMode(jobId) {
    const job = mediaTrainingJobs.find(j => j.id === jobId);
    if (!job || job.status !== 'completed') return;

    mediaViewMode = 'view';
    selectedTrainingJob = job;

    // Load generation credits for the selected model context
    loadMediaGenCredits();

    // Re-render all sections in view-model context
    renderMediaAssetGrid();
    renderTrainingHistory();
    renderGenerationSection();
    renderBrandKit(job);

    // Clear previous generation preview
    const result = document.getElementById('mediaGenerateResult');
    if (result) result.classList.add('hidden');
    latestGeneratedImageUrl = null;

    // Load generated images filtered to this model
    if (selectedAdAccount) {
        apiGet(`/api/marketing/media-assets/generated?adAccountId=${selectedAdAccount.id}&trainingJobId=${jobId}`)
            .then(data => {
                generatedMedia = data.media || [];
                renderGeneratedMedia();
            })
            .catch(() => {
                generatedMedia = [];
                renderGeneratedMedia();
            });
    }
}

/**
 * Initialize drag-and-drop zone for image uploads.
 */
function initMediaDropZone() {
    const dropZone = document.getElementById('mediaDropZone');
    const fileInput = document.getElementById('mediaFileInput');

    if (!dropZone || dropZone._mediaInitialized) return;
    dropZone._mediaInitialized = true;

    // Click to browse
    dropZone.addEventListener('click', () => fileInput.click());

    // File input change
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleMediaFileSelect(e.target.files);
            e.target.value = ''; // Reset for re-selection
        }
    });

    // Drag events
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('border-brand-500', 'bg-brand-50/50');
    });

    dropZone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dropZone.classList.remove('border-brand-500', 'bg-brand-50/50');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('border-brand-500', 'bg-brand-50/50');
        if (e.dataTransfer.files.length > 0) {
            handleMediaFileSelect(e.dataTransfer.files);
        }
    });
}

/**
 * Validate selected files and upload them.
 */
function handleMediaFileSelect(fileList) {
    const files = Array.from(fileList);
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    const maxSize = 10 * 1024 * 1024; // 10MB

    const valid = [];
    const errors = [];

    for (const file of files) {
        if (!allowed.includes(file.type)) {
            errors.push(`${file.name}: Invalid type (use JPEG, PNG, or WebP)`);
        } else if (file.size > maxSize) {
            errors.push(`${file.name}: Too large (max 10MB)`);
        } else {
            valid.push(file);
        }
    }

    if (valid.length > 20) {
        showToast('Maximum 20 files per upload', 'error');
        return;
    }

    if (errors.length > 0) {
        showToast(errors[0], 'error');
    }

    if (valid.length > 0) {
        uploadMediaFiles(valid);
    }
}

/**
 * Upload files to the backend via FormData.
 */
async function uploadMediaFiles(files) {
    if (!selectedAdAccount) return;
    if (mediaViewMode !== 'new') {
        showToast('Switch to New Model mode to upload images', 'warning');
        return;
    }

    const progressEl = document.getElementById('mediaUploadProgress');
    const barEl = document.getElementById('mediaUploadBar');
    const textEl = document.getElementById('mediaUploadText');

    progressEl.classList.remove('hidden');
    barEl.style.width = '0%';
    textEl.textContent = `Uploading ${files.length} file(s)...`;

    try {
        const formData = new FormData();
        formData.append('adAccountId', selectedAdAccount.id);
        for (const file of files) {
            formData.append('images', file);
        }

        const token = localStorage.getItem('token');
        const response = await fetch('/api/marketing/media-assets/upload', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'X-CSRF-Token': getCsrfToken()
            },
            credentials: 'include',
            body: formData
        });

        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || 'Upload failed');
        }

        // Update local state with new assets
        if (data.assets && data.assets.length > 0) {
            mediaAssets = [...data.assets, ...mediaAssets];
        }

        barEl.style.width = '100%';
        textEl.textContent = `Uploaded ${data.uploaded} file(s)`;

        if (data.errors && data.errors.length > 0) {
            showToast(`${data.uploaded} uploaded, ${data.errors.length} failed`, 'warning');
        } else if (data.warnings && data.warnings.length > 0) {
            showToast(`${data.uploaded} uploaded. ${data.warnings.length} image(s) below 1024px — higher resolution recommended for best training results.`, 'warning');
        } else {
            showToast(`${data.uploaded} image(s) uploaded successfully`, 'success');
        }

        renderMediaAssetGrid();
        updateTrainButtonState();

        // Hide progress after a moment
        setTimeout(() => progressEl.classList.add('hidden'), 2000);
    } catch (error) {
        progressEl.classList.add('hidden');
        showToast(error.message, 'error');
    }
}

/**
 * Delete an uploaded media asset.
 */
async function deleteMediaAsset(assetId) {
    if (mediaViewMode !== 'new') return;
    if (!confirm('Delete this image?')) return;

    try {
        await apiDelete(`/api/marketing/media-assets/${assetId}`);
        mediaAssets = mediaAssets.filter(a => a.id !== assetId);
        renderMediaAssetGrid();
        updateTrainButtonState();
        showToast('Image deleted', 'success');
    } catch (error) {
        showToast(error.message, 'error');
    }
}

/**
 * Render the uploaded image thumbnail grid.
 */
function renderMediaAssetGrid() {
    const grid = document.getElementById('mediaAssetGrid');
    const empty = document.getElementById('mediaAssetEmpty');
    const badge = document.getElementById('mediaAssetCountBadge');
    const sectionTitle = document.getElementById('mediaRefSectionTitle');
    const sectionSubtitle = document.getElementById('mediaRefSectionSubtitle');
    const dropZone = document.getElementById('mediaDropZone');
    const trainSection = document.getElementById('mediaTrainSection');

    if (!grid) return;

    if (mediaViewMode === 'view' && selectedTrainingJob) {
        // VIEW MODE: Show read-only training image snapshots
        const urls = selectedTrainingJob.training_image_urls || [];
        const count = urls.length;

        if (sectionTitle) sectionTitle.textContent = 'Training Images';
        if (sectionSubtitle) sectionSubtitle.textContent =
            `Images used to train "${selectedTrainingJob.name || 'Untitled'}"`;
        if (badge) {
            badge.textContent = `${count} images`;
            badge.className = 'text-sm font-medium text-brand-700 bg-brand-50 px-3 py-1 rounded-full';
        }

        // Hide upload controls and train section
        if (dropZone) dropZone.classList.add('hidden');
        if (trainSection) trainSection.classList.add('hidden');

        if (count === 0) {
            grid.innerHTML = '';
            if (empty) {
                empty.classList.remove('hidden');
                const emptyP = empty.querySelector('p');
                if (emptyP) emptyP.textContent = 'No training image snapshot available for this model.';
            }
            return;
        }

        if (empty) empty.classList.add('hidden');
        grid.innerHTML = urls.map((url, idx) => `
            <div class="relative rounded-lg overflow-hidden border border-surface-200 aspect-square bg-surface-50">
                <img src="${escapeHtml(url)}" alt="Training image ${idx + 1}"
                    class="w-full h-full object-cover"
                    onerror="this.style.display='none'; this.parentElement.innerHTML='<div class=\\'flex items-center justify-center h-full text-ink-300\\'><svg class=\\'w-8 h-8\\' fill=\\'none\\' stroke=\\'currentColor\\' viewBox=\\'0 0 24 24\\'><path stroke-linecap=\\'round\\' stroke-linejoin=\\'round\\' stroke-width=\\'1.5\\' d=\\'M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z\\'></path></svg></div>';">
            </div>
        `).join('');

    } else {
        // NEW MODEL MODE: Show editable upload pool
        const count = mediaAssets.length;

        if (sectionTitle) sectionTitle.textContent = 'Reference Images';
        if (sectionSubtitle) sectionSubtitle.textContent =
            'Upload at least 10 images that represent your brand\'s visual style';
        if (badge) {
            badge.textContent = `${count} / 10 min`;
            badge.className = count >= 10
                ? 'text-sm font-medium text-green-700 bg-green-100 px-3 py-1 rounded-full'
                : 'text-sm font-medium text-ink-500 bg-surface-100 px-3 py-1 rounded-full';
        }

        // Show upload controls and train section
        if (dropZone) dropZone.classList.remove('hidden');
        if (trainSection) trainSection.classList.remove('hidden');

        if (count === 0) {
            grid.innerHTML = '';
            if (empty) {
                empty.classList.remove('hidden');
                const emptyP = empty.querySelector('p');
                if (emptyP) emptyP.textContent = 'No images uploaded yet. Start by dropping images above.';
            }
            return;
        }

        if (empty) empty.classList.add('hidden');
        grid.innerHTML = mediaAssets.map(asset => `
            <div class="group relative rounded-lg overflow-hidden border border-surface-200 aspect-square bg-surface-50">
                <img src="${escapeHtml(asset.public_url)}" alt="${escapeHtml(asset.file_name)}"
                    class="w-full h-full object-cover"
                    onerror="this.style.display='none'; this.parentElement.innerHTML='<div class=\\'flex items-center justify-center h-full text-ink-300\\'><svg class=\\'w-8 h-8\\' fill=\\'none\\' stroke=\\'currentColor\\' viewBox=\\'0 0 24 24\\'><path stroke-linecap=\\'round\\' stroke-linejoin=\\'round\\' stroke-width=\\'1.5\\' d=\\'M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z\\'></path></svg></div>';">
                <div class="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
                    <button onclick="deleteMediaAsset('${asset.id}')"
                        class="opacity-0 group-hover:opacity-100 transition-opacity bg-red-500 text-white rounded-full p-1.5 hover:bg-red-600">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                        </svg>
                    </button>
                </div>
                <div class="absolute bottom-0 left-0 right-0 bg-black/50 px-2 py-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <p class="text-[10px] text-white truncate">${escapeHtml(asset.file_name)}</p>
                </div>
            </div>
        `).join('');
    }
}

/**
 * Enable/disable Train button based on asset count.
 */
function updateTrainButtonState() {
    const btn = document.getElementById('mediaTrainBtn');
    const hint = document.getElementById('mediaTrainHint');
    if (btn) {
        btn.disabled = mediaAssets.length < 10;
    }
    if (hint) {
        hint.textContent = mediaAssets.length < 10
            ? `Upload at least ${10 - mediaAssets.length} more reference image${10 - mediaAssets.length === 1 ? '' : 's'} before training`
            : `${mediaAssets.length} reference images ready for training`;
    }
}

// ============================================
// MEDIA ASSETS - TRAINING
// ============================================

/**
 * Handle generation model type radio change (Instant Brand Model vs Custom AI Training).
 * Shows/hides LoRA-specific options and updates button text.
 */
async function onGenerationModelChange() {
    const modelRadio = document.querySelector('input[name="mediaGenerationModel"]:checked');
    const isLora = modelRadio && modelRadio.value === 'lora';
    const loraOptions = document.getElementById('mediaLoraOptions');
    const btnText = document.getElementById('mediaTrainBtnText');

    if (loraOptions) {
        loraOptions.classList.toggle('hidden', !isLora);
    }
    if (btnText) {
        const eligibility = await getTrainingEligibility();
        const priceLabel = eligibility.freeModelTraining ? 'First Free!' : '$9.90';
        btnText.textContent = isLora ? `Train New Model (${priceLabel})` : `Create Model (${priceLabel})`;
    }
}

/**
 * Start model creation for the selected ad account.
 * Opens compact LS checkout popup ($5 per-use payment), then starts training/creation on success.
 */
async function startMediaTraining() {
    if (!selectedAdAccount) return;

    const name = prompt('Name this training session:', `Training ${new Date().toLocaleDateString()}`);
    if (!name || !name.trim()) return; // User canceled or empty

    const btn = document.getElementById('mediaTrainBtn');
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<div class="loader" style="width:16px;height:16px;"></div> Preparing...';

    try {
        // Check free first-use eligibility
        const eligibility = await getTrainingEligibility();
        let purchase = null;

        if (eligibility.freeModelTraining) {
            // First model is free — claim system purchase directly
            btn.innerHTML = '<div class="loader" style="width:16px;height:16px;"></div> Preparing...';
            const result = await apiPost('/api/subscriptions/claim-free-training', { purchaseType: 'model_training' });
            purchase = result.purchase;
            await getTrainingEligibility(true); // Refresh cached eligibility
        } else {
            // Paid flow — LS checkout
            const { checkoutUrl } = await apiPost('/api/subscriptions/training-checkout', {
                adAccountId: selectedAdAccount.id
            });

            btn.innerHTML = '<div class="loader" style="width:16px;height:16px;"></div> Pay $9.90...';
            const paid = await showCompactCheckout(checkoutUrl, btn);

            if (!paid) {
                btn.disabled = false;
                btn.innerHTML = originalHtml;
                return;
            }

            // Poll for webhook confirmation
            btn.innerHTML = '<div class="loader" style="width:16px;height:16px;"></div> Confirming...';
            for (let attempt = 0; attempt < 15; attempt++) {
                await new Promise(r => setTimeout(r, 2000));
                try {
                    const result = await apiGet('/api/subscriptions/training-purchase-status');
                    if (result.hasPurchase) {
                        purchase = result.purchase;
                        break;
                    }
                } catch (e) { /* continue polling */ }
            }

            if (!purchase) {
                showToast('Payment received but confirmation pending. Please try again in a moment.', 'warning');
                btn.disabled = false;
                btn.innerHTML = originalHtml;
                return;
            }
        }

        // Start model creation with confirmed purchase
        const modelRadio = document.querySelector('input[name="mediaGenerationModel"]:checked');
        const generationModel = modelRadio ? modelRadio.value : 'flux-2-pro';
        const isFlux2Pro = generationModel === 'flux-2-pro';

        showToast(`${eligibility.freeModelTraining ? 'Free trial!' : 'Payment confirmed!'} ${isFlux2Pro ? 'Creating model...' : 'Starting model training...'}`, 'success');
        renderActiveTrainingStatus();

        const data = await apiPost('/api/marketing/media-assets/training/start', {
            adAccountId: selectedAdAccount.id,
            name: name.trim(),
            purchaseId: purchase.id,
            generationModel
        });

        if (isFlux2Pro && data.job && data.job.status === 'completed') {
            // Instant Brand Model: model is ready instantly
            mediaTrainingJobs = [data.job, ...mediaTrainingJobs];
            activeTrainingJob = null;
            renderTrainingHistory();
            renderActiveTrainingStatus();
            showToast('Brand model created! You can now generate images.', 'success');
            switchToViewModelMode(data.job.id);
            loadMediaGenCredits();
        } else {
            // LoRA: training in progress
            activeTrainingJob = data.job;
            mediaTrainingJobs = [data.job, ...mediaTrainingJobs];
            renderTrainingHistory();
            showToast('Training started! This takes about 5-10 minutes.', 'success');
            startTrainingPolling();
        }

    } catch (error) {
        showToast(error.message || 'Payment failed. Please try again.', 'error');
        renderActiveTrainingStatus();
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
    }
}

/**
 * Poll for training status every 10 seconds using the active job's ID.
 */
function startTrainingPolling() {
    if (mediaTrainingPollingTimer) clearInterval(mediaTrainingPollingTimer);
    if (!activeTrainingJob) return;

    mediaTrainingPollingTimer = setInterval(async () => {
        if (!selectedAdAccount || !activeTrainingJob) {
            clearInterval(mediaTrainingPollingTimer);
            return;
        }

        try {
            const data = await apiGet(
                `/api/marketing/media-assets/training/status?adAccountId=${selectedAdAccount.id}&jobId=${activeTrainingJob.id}`
            );
            const job = data.job;

            if (job) {
                activeTrainingJob = job;

                // Update progress bar
                if (job.progress) {
                    const pct = Math.round(job.progress.percentage * 100);
                    const bar = document.getElementById('mediaTrainingBar');
                    const pctEl = document.getElementById('mediaTrainingPercentage');
                    const textEl = document.getElementById('mediaTrainingProgressText');

                    if (bar) bar.style.width = `${pct}%`;
                    if (pctEl) pctEl.textContent = `${pct}%`;
                    if (textEl) textEl.textContent = `Step ${job.progress.current} of ${job.progress.total}`;
                }

                // Terminal state — stop polling, refresh
                if (['completed', 'failed'].includes(job.status)) {
                    clearInterval(mediaTrainingPollingTimer);
                    mediaTrainingPollingTimer = null;

                    // Update the job in the history array
                    const idx = mediaTrainingJobs.findIndex(j => j.id === job.id);
                    if (idx !== -1) mediaTrainingJobs[idx] = job;

                    // If completed, auto-switch to view mode for the new model
                    if (job.status === 'completed') {
                        mediaTrainingJobs.forEach(j => j.is_default = false);
                        job.is_default = true;
                        activeTrainingJob = null;
                        renderActiveTrainingStatus();
                        switchToViewModelMode(job.id);
                    } else {
                        activeTrainingJob = null;
                        renderActiveTrainingStatus();
                        renderTrainingHistory();
                        renderGenerationSection();
                        renderGeneratedMedia();
                    }
                }
            }
        } catch (error) {
            console.error('Training poll error:', error);
        }
    }, 10000);
}

/**
 * Render the active training status.
 * The train button is always visible. Only the progress bar is toggled.
 */
function renderActiveTrainingStatus() {
    updateTrainButtonState();

    const progress = document.getElementById('mediaTrainingProgress');
    if (!progress) return;

    if (activeTrainingJob && ['training', 'pending'].includes(activeTrainingJob.status)) {
        progress.classList.remove('hidden');
    } else {
        progress.classList.add('hidden');
    }
}

/**
 * Render the training history list — all past and current sessions.
 */
function renderTrainingHistory() {
    const container = document.getElementById('mediaTrainingHistoryList');
    if (!container) return;

    if (!mediaTrainingJobs || mediaTrainingJobs.length === 0) {
        container.innerHTML = '<p class="text-sm text-ink-400 text-center py-4">No models yet. Upload reference images and train your first model below.</p>';
        return;
    }

    container.innerHTML = mediaTrainingJobs.map(job => {
        const date = job.completed_at
            ? new Date(job.completed_at).toLocaleDateString()
            : new Date(job.created_at).toLocaleDateString();

        // Status badge
        let badgeClass, badgeText;
        switch (job.status) {
            case 'completed':
                badgeClass = 'bg-green-100 text-green-700';
                badgeText = 'Completed';
                break;
            case 'training':
            case 'pending':
                badgeClass = 'bg-amber-100 text-amber-700';
                badgeText = 'Training...';
                break;
            case 'failed':
                badgeClass = 'bg-red-100 text-red-700';
                badgeText = 'Failed';
                break;
            default:
                badgeClass = 'bg-surface-100 text-ink-500';
                badgeText = job.status;
        }

        // Is this the selected model for generation?
        const isSelected = selectedTrainingJob && selectedTrainingJob.id === job.id;
        const isDefault = !!job.is_default;

        // Center CTA button
        let centerBtn = '';
        // Right-side default badge
        let rightAction = '';

        // Delete button (available for all job statuses)
        const deleteBtn = `<button onclick="event.stopPropagation(); deleteTrainingJob('${job.id}')" class="p-1 rounded-md text-ink-300 hover:text-red-500 hover:bg-red-50 transition-colors" title="Delete model">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
            </svg>
        </button>`;

        if (job.status === 'completed') {
            const defaultBadge = isDefault
                ? `<span class="inline-flex items-center gap-1 text-[10px] font-medium text-brand-700 bg-brand-50 px-2 py-0.5 rounded-full border border-brand-200">Default</span>`
                : `<button onclick="setTrainingAsDefault('${job.id}')" class="text-[10px] text-ink-400 hover:text-brand-600 underline">Set as Default</button>`;

            if (isSelected) {
                centerBtn = `<button class="inline-flex items-center justify-center gap-2 w-full py-2.5 rounded-full text-sm font-semibold text-green-700 bg-green-50 border border-green-200 cursor-default">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
                    </svg>
                    Selected for Generation
                </button>`;
            } else {
                centerBtn = `<button onclick="selectTrainingForGeneration('${job.id}')" class="inline-flex items-center justify-center gap-2 w-full py-2.5 rounded-full text-sm font-semibold text-white bg-brand-600 hover:bg-brand-700 shadow-sm hover:shadow transition-all cursor-pointer">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"></path>
                    </svg>
                    Use for Generation
                </button>`;
            }
            rightAction = defaultBadge;
        } else if (job.status === 'failed') {
            centerBtn = `<button onclick="startMediaTraining()" class="inline-flex items-center justify-center gap-2 w-full py-2.5 rounded-full text-sm font-medium text-red-600 bg-red-50 hover:bg-red-100 border border-red-200 transition-colors cursor-pointer">Retry Training</button>`;
        }

        const imageCount = job.image_count || (job.training_image_urls ? job.training_image_urls.length : '?');
        const triggerWord = job.trigger_word ? `<span class="text-[10px] text-ink-400 font-mono">${escapeHtml(job.trigger_word)}</span>` : '';
        const typeLabel = job.training_type === 'brand' ? 'Brand' : job.training_type === 'style' ? 'Style' : job.training_type === 'subject' ? 'Subject' : 'Brand';

        return `
            <div class="p-4 rounded-xl border ${isSelected ? 'border-brand-300 bg-brand-50/30' : 'border-surface-200 bg-surface-50'} transition-colors">
                <div class="flex items-center justify-between mb-3">
                    <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-2">
                            <p class="text-sm font-medium text-ink-800 truncate">${escapeHtml(job.name || 'Untitled')}</p>
                            <span class="text-[10px] font-medium px-2 py-0.5 rounded-full ${badgeClass}">${badgeText}</span>
                        </div>
                        <div class="flex items-center gap-3 mt-1">
                            <span class="text-xs text-ink-400">${date}</span>
                            <span class="text-xs text-ink-400">${imageCount} images</span>
                            <span class="text-[10px] font-medium text-ink-400 bg-surface-100 px-1.5 py-0.5 rounded">${typeLabel}</span>
                            ${triggerWord}
                        </div>
                        ${job.status === 'failed' && job.error_message ? `<p class="text-xs text-red-500 mt-1 truncate" title="${escapeHtml(job.error_message)}">${escapeHtml(job.error_message)}</p>` : ''}
                    </div>
                    <div class="flex items-center gap-2 flex-shrink-0">
                        ${rightAction}
                        ${deleteBtn}
                    </div>
                </div>
                ${centerBtn}
            </div>
        `;
    }).join('');

    // Toggle "+New Model" button active state
    const newModelBtn = document.getElementById('newModelBtn');
    if (newModelBtn) {
        if (mediaViewMode === 'new') {
            newModelBtn.classList.add('ring-2', 'ring-brand-300', 'ring-offset-2');
        } else {
            newModelBtn.classList.remove('ring-2', 'ring-brand-300', 'ring-offset-2');
        }
    }
}

/**
 * Select a completed training session for image generation.
 * Delegates to switchToViewModelMode for full model-centric context switch.
 */
function selectTrainingForGeneration(jobId) {
    switchToViewModelMode(jobId);
}

/**
 * Mark a training job as the default model (persisted in DB).
 */
async function setTrainingAsDefault(jobId) {
    if (!selectedAdAccount) return;

    try {
        await apiPut(`/api/marketing/media-assets/training/${jobId}/set-default`, {
            adAccountId: selectedAdAccount.id
        });

        // Update local state: clear old default, set new one
        mediaTrainingJobs.forEach(j => j.is_default = false);
        const job = mediaTrainingJobs.find(j => j.id === jobId);
        if (job) {
            job.is_default = true;
            selectedTrainingJob = job;
        }

        renderTrainingHistory();
        renderGenerationSection();
        showToast('Default model updated', 'success');
    } catch (error) {
        showToast(error.message || 'Failed to set default', 'error');
    }
}

/**
 * Delete a training job and all its associated storage files / generated media.
 */
async function deleteTrainingJob(jobId) {
    if (!selectedAdAccount) return;
    const job = mediaTrainingJobs.find(j => j.id === jobId);
    if (!job) return;

    const name = job.name || 'Untitled';
    if (!confirm(`Delete model "${name}"? This will permanently remove the model, its training images, and all generated images.`)) return;

    try {
        await apiDelete(`/api/marketing/media-assets/training/${jobId}?adAccountId=${selectedAdAccount.id}`);

        // Remove from local state
        mediaTrainingJobs = mediaTrainingJobs.filter(j => j.id !== jobId);

        // If the deleted model was selected, switch to new model mode
        if (selectedTrainingJob && selectedTrainingJob.id === jobId) {
            switchToNewModelMode();
        } else {
            renderTrainingHistory();
        }

        showToast(`Model "${name}" deleted`, 'success');
    } catch (error) {
        showToast(error.message || 'Failed to delete model', 'error');
    }
}

// ============================================
// MEDIA ASSETS - GENERATION
// ============================================

/**
 * Update the generation section label and button state based on selected model.
 */
function renderGenerationSection() {
    const selectedLabel = document.getElementById('mediaGenerateSelectedModel');
    const generateBtn = document.getElementById('mediaGenerateBtn');
    const result = document.getElementById('mediaGenerateResult');

    if (mediaViewMode === 'view' && selectedTrainingJob && selectedTrainingJob.status === 'completed') {
        const isFlux2Pro = selectedTrainingJob.replicate_model_name === 'flux-2-pro';
        if (selectedLabel) {
            const typeLabel = isFlux2Pro ? 'Instant Brand Model' : 'Custom AI Training';
            const triggerInfo = selectedTrainingJob.trigger_word
                ? ` | Trigger: ${selectedTrainingJob.trigger_word}`
                : '';
            selectedLabel.innerHTML = `Generating from: <strong>${escapeHtml(selectedTrainingJob.name || 'Untitled')}</strong> <span class="text-xs text-ink-400">(${typeLabel}${triggerInfo})</span>`;
            selectedLabel.classList.remove('text-ink-400');
            selectedLabel.classList.add('text-brand-600');
        }
        // Show/hide LoRA-specific generation controls
        const loraStrength = document.getElementById('mediaLoraStrengthContainer');
        const guidanceScale = document.getElementById('mediaGuidanceScaleContainer');
        if (loraStrength) loraStrength.classList.toggle('hidden', isFlux2Pro);
        if (guidanceScale) guidanceScale.classList.toggle('hidden', isFlux2Pro);

        // Enable generate button only if credits available
        if (generateBtn) generateBtn.disabled = mediaGenCredits <= 0;
        updateMediaGenCreditsUI();
    } else {
        if (selectedLabel) {
            selectedLabel.textContent = mediaViewMode === 'new'
                ? 'Upload reference images and train a model first, then generate images.'
                : 'Select a model from Past Models to start generating images.';
            selectedLabel.classList.remove('text-brand-600');
            selectedLabel.classList.add('text-ink-400');
        }
        if (generateBtn) generateBtn.disabled = true;
        if (result) result.classList.add('hidden');
        // Hide credits bar when no model selected
        const creditsBar = document.getElementById('mediaGenCreditsBar');
        if (creditsBar) creditsBar.classList.add('hidden');
    }
}

/**
 * Select an aspect ratio button in the advanced settings panel.
 */
function selectAspectRatio(btn) {
    const container = document.getElementById('mediaAspectRatio');
    if (!container) return;
    container.querySelectorAll('.aspect-ratio-btn').forEach(b => {
        b.classList.remove('active', 'border-brand-300', 'bg-brand-50', 'text-brand-700');
        b.classList.add('border-surface-200', 'text-ink-500');
    });
    btn.classList.add('active', 'border-brand-300', 'bg-brand-50', 'text-brand-700');
    btn.classList.remove('border-surface-200', 'text-ink-500');
}

/**
 * Get the currently selected aspect ratio from the aspect ratio buttons.
 */
function getSelectedAspectRatio() {
    const active = document.querySelector('#mediaAspectRatio .aspect-ratio-btn.active');
    return active ? active.dataset.ratio : '1:1';
}

/**
 * Generate image(s) using the selected trained model.
 */
async function generateMediaImage() {
    if (!selectedAdAccount || !selectedTrainingJob) return;

    // Check credits before attempting
    if (mediaGenCredits <= 0) {
        showToast('No generation credits remaining. Purchase a credit pack to continue.', 'error');
        return;
    }

    const promptInput = document.getElementById('mediaGeneratePrompt');
    const prompt = promptInput?.value?.trim();
    if (!prompt) {
        showToast('Please enter a description for the image', 'error');
        return;
    }

    const btn = document.getElementById('mediaGenerateBtn');
    const loading = document.getElementById('mediaGenerateLoading');
    const result = document.getElementById('mediaGenerateResult');

    if (btn) btn.disabled = true;
    if (loading) loading.classList.remove('hidden');
    if (result) result.classList.add('hidden');

    try {
        // Read advanced generation settings
        const loraScaleEl = document.getElementById('mediaLoraScale');
        const guidanceScaleEl = document.getElementById('mediaGuidanceScale');
        const numOutputsEl = document.getElementById('mediaNumOutputs');
        const loraScale = loraScaleEl ? parseFloat(loraScaleEl.value) : 1.0;
        const guidanceScale = guidanceScaleEl ? parseFloat(guidanceScaleEl.value) : 3.0;
        const numOutputs = numOutputsEl ? parseInt(numOutputsEl.value, 10) : 2;
        const aspectRatio = getSelectedAspectRatio();

        const data = await apiPost('/api/marketing/media-assets/generate', {
            adAccountId: selectedAdAccount.id,
            prompt,
            trainingJobId: selectedTrainingJob.id,
            loraScale,
            guidanceScale,
            numOutputs,
            aspectRatio,
            brandPromptStyle
        });

        // Update credits from response
        if (data.credits !== undefined) {
            mediaGenCredits = data.credits;
            updateMediaGenCreditsUI();
        }

        // Response is always an array now
        const mediaArray = Array.isArray(data.media) ? data.media : [data.media];
        latestGeneratedImageUrl = mediaArray[0].public_url;

        // Add all generated images to gallery
        generatedMedia = [...mediaArray, ...generatedMedia];
        renderGeneratedMedia();

        const countMsg = mediaArray.length > 1 ? `${mediaArray.length} images` : 'Image';
        showToast(`${countMsg} generated successfully!`, 'success');
    } catch (error) {
        // Handle credits exhausted specifically
        if (error.message && error.message.includes('credits')) {
            mediaGenCredits = 0;
            updateMediaGenCreditsUI();
        }
        showToast(error.message, 'error');
    } finally {
        if (btn) btn.disabled = mediaGenCredits <= 0;
        if (loading) loading.classList.add('hidden');
    }
}

/**
 * Load the user's Brand Asset generation credit balance from the backend.
 */
async function loadMediaGenCredits() {
    try {
        const result = await apiGet('/api/marketing/media-assets/generation-credits');
        mediaGenCredits = result.credits || 0;
        updateMediaGenCreditsUI();
    } catch (error) {
        console.error('Failed to load generation credits:', error);
        mediaGenCredits = 0;
        updateMediaGenCreditsUI();
    }
}

/**
 * Update the generation credits indicator bar and button state.
 */
function updateMediaGenCreditsUI() {
    const bar = document.getElementById('mediaGenCreditsBar');
    const countEl = document.getElementById('mediaGenCreditsCount');
    const buyBtn = document.getElementById('mediaGenBuyCreditsBtn');
    const generateBtn = document.getElementById('mediaGenerateBtn');

    if (!bar) return;

    // Show credits bar only when a training job is selected
    if (selectedTrainingJob && selectedTrainingJob.status === 'completed') {
        bar.classList.remove('hidden');
        bar.classList.add('flex');
    } else {
        bar.classList.add('hidden');
        bar.classList.remove('flex');
        return;
    }

    if (countEl) countEl.textContent = mediaGenCredits;

    // Show buy button when credits are low (0 or 1 remaining)
    if (buyBtn) {
        if (mediaGenCredits <= 1) {
            buyBtn.classList.remove('hidden');
            buyBtn.classList.add('flex');
        } else {
            buyBtn.classList.add('hidden');
            buyBtn.classList.remove('flex');
        }
    }

    // Disable generate button when no credits
    if (generateBtn) {
        if (mediaGenCredits <= 0) {
            generateBtn.disabled = true;
            generateBtn.title = 'No generation credits remaining';
        } else {
            generateBtn.disabled = false;
            generateBtn.title = '';
        }
    }
}

/**
 * Purchase an 8-credit generation pack via compact LS checkout ($4.90).
 */
async function purchaseAssetImageGenPack() {
    const btn = document.getElementById('mediaGenBuyCreditsBtn');
    if (!btn) return;
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<div class="loader" style="width:14px;height:14px;"></div> Preparing...';

    try {
        const { checkoutUrl } = await apiPost('/api/subscriptions/asset-image-gen-pack-checkout');

        btn.innerHTML = '<div class="loader" style="width:14px;height:14px;"></div> Pay $4.90...';
        const paid = await showCompactCheckout(checkoutUrl, btn, { direction: 'up' });

        if (!paid) {
            btn.disabled = false;
            btn.innerHTML = originalHtml;
            return;
        }

        // Poll for webhook confirmation (credits should increase)
        btn.innerHTML = '<div class="loader" style="width:14px;height:14px;"></div> Confirming...';
        const previousCredits = mediaGenCredits;
        let confirmed = false;
        for (let attempt = 0; attempt < 15; attempt++) {
            await new Promise(r => setTimeout(r, 2000));
            try {
                const result = await apiGet('/api/marketing/media-assets/generation-credits');
                if (result.credits > previousCredits) {
                    mediaGenCredits = result.credits;
                    confirmed = true;
                    break;
                }
            } catch (e) { /* continue polling */ }
        }

        if (confirmed) {
            showToast(`${mediaGenCredits} generation credits available!`, 'success');
            updateMediaGenCreditsUI();
        } else {
            showToast('Payment received but confirmation pending. Credits will appear shortly.', 'warning');
            // Try one more load after a delay
            setTimeout(loadMediaGenCredits, 5000);
        }
    } catch (error) {
        showToast(error.message || 'Payment failed. Please try again.', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
    }
}

/**
 * Toggle the advanced generation settings panel.
 */
function toggleAdvancedGenSettings() {
    const panel = document.getElementById('advancedGenSettings');
    const chevron = document.getElementById('advancedGenChevron');
    if (!panel) return;
    const isHidden = panel.classList.contains('hidden');
    panel.classList.toggle('hidden');
    if (chevron) {
        chevron.style.transform = isHidden ? 'rotate(90deg)' : '';
    }
}

/**
 * Set the brand prompt style (concise vs elaborated) for image generation.
 */
function setBrandPromptStyle(style) {
    brandPromptStyle = style;
    const slider = document.getElementById('brandPromptSlider');
    const noneBtn = document.getElementById('brandPromptNoneBtn');
    const conciseBtn = document.getElementById('brandPromptConciseBtn');
    const elaboratedBtn = document.getElementById('brandPromptElaboratedBtn');
    const hint = document.getElementById('brandPromptStyleHint');

    const inactive = 'relative z-10 flex-1 text-xs font-medium py-1.5 px-3 rounded-md transition-colors text-blue-400';
    const active = 'relative z-10 flex-1 text-xs font-semibold py-1.5 px-3 rounded-md transition-colors text-blue-900';

    // Reset all to inactive
    if (noneBtn) noneBtn.className = inactive;
    if (conciseBtn) conciseBtn.className = inactive;
    if (elaboratedBtn) elaboratedBtn.className = inactive;

    if (style === 'none') {
        if (slider) slider.style.transform = '';
        if (noneBtn) noneBtn.className = active;
        if (hint) hint.textContent = 'Trigger word only — LoRA handles the style';
    } else if (style === 'elaborated') {
        if (slider) slider.style.transform = 'translateX(200%)';
        if (elaboratedBtn) elaboratedBtn.className = active;
        if (hint) hint.textContent = 'Full brand aesthetic, photography style, mood, and identity context';
    } else {
        if (slider) slider.style.transform = 'translateX(100%)';
        if (conciseBtn) conciseBtn.className = active;
        if (hint) hint.textContent = 'Short color codes + mood keywords';
    }
}

/**
 * Download the latest generated image.
 */
function downloadLatestGeneratedImage() {
    if (!latestGeneratedImageUrl) return;
    const a = document.createElement('a');
    a.href = latestGeneratedImageUrl;
    a.download = `generated-${Date.now()}.png`;
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

/**
 * Open lightbox to view a generated image full-size with download option.
 */
function openImageLightbox(imageUrl, prompt) {
    const lightbox = document.getElementById('mediaImageLightbox');
    const img = document.getElementById('lightboxImage');
    const downloadBtn = document.getElementById('lightboxDownload');
    const promptEl = document.getElementById('lightboxPrompt');
    if (!lightbox || !img) return;

    img.src = imageUrl;
    if (downloadBtn) {
        downloadBtn.href = imageUrl;
        downloadBtn.download = `generated-${Date.now()}.webp`;
    }
    if (promptEl) promptEl.textContent = prompt || '';
    lightbox.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}

/**
 * Close the image lightbox.
 */
function closeImageLightbox(event) {
    const lightbox = document.getElementById('mediaImageLightbox');
    if (lightbox) lightbox.classList.add('hidden');
    document.body.style.overflow = '';
}

// ============================================
// KONTEXT IMAGE EDITING
// ============================================

var kontextEditMediaId = null;
var kontextEditImageUrl = null;
var editModelChoice = 'nano-banana'; // 'nano-banana' or 'ideogram'

/**
 * Open the Kontext edit modal for a generated image.
 */
function openEditModal(mediaId, imageUrl) {
    kontextEditMediaId = mediaId;
    kontextEditImageUrl = imageUrl;

    const modal = document.getElementById('kontextEditModal');
    const sourceImg = document.getElementById('kontextSourceImage');
    const promptInput = document.getElementById('kontextEditPrompt');
    const resultPreview = document.getElementById('kontextResultPreview');
    const applyBtn = document.getElementById('kontextApplyBtn');
    const applyBtnText = document.getElementById('kontextApplyBtnText');

    if (sourceImg) sourceImg.src = imageUrl;
    if (promptInput) promptInput.value = '';
    if (resultPreview) resultPreview.classList.add('hidden');
    if (applyBtn) applyBtn.disabled = false;
    if (applyBtnText) applyBtnText.textContent = 'Apply Edit';
    if (modal) modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}

/**
 * Set the edit model (nano-banana or ideogram).
 */
function setEditModel(model) {
    editModelChoice = model;
    const slider = document.getElementById('editModelSlider');
    const nanoBananaBtn = document.getElementById('editModelNanoBananaBtn');
    const ideogramBtn = document.getElementById('editModelIdeogramBtn');
    const hint = document.getElementById('editModelHint');

    const inactive = 'relative z-10 flex-1 text-xs font-medium py-1.5 px-3 rounded-md transition-colors text-blue-400';
    const active = 'relative z-10 flex-1 text-xs font-semibold py-1.5 px-3 rounded-md transition-colors text-blue-900';

    if (model === 'ideogram') {
        if (slider) slider.style.transform = 'translateX(100%)';
        if (nanoBananaBtn) nanoBananaBtn.className = inactive;
        if (ideogramBtn) ideogramBtn.className = active;
        if (hint) hint.textContent = 'Targeted regional edits — specify position (top, bottom, left, right)';
    } else {
        if (slider) slider.style.transform = '';
        if (nanoBananaBtn) nanoBananaBtn.className = active;
        if (ideogramBtn) ideogramBtn.className = inactive;
        if (hint) hint.textContent = 'Best for general edits — no position needed';
    }
}

/**
 * Close the Kontext edit modal.
 */
function closeEditModal(event) {
    const modal = document.getElementById('kontextEditModal');
    if (modal) modal.classList.add('hidden');
    document.body.style.overflow = '';
    kontextEditMediaId = null;
    kontextEditImageUrl = null;
}

/**
 * Apply a Kontext edit to the selected image.
 */
async function applyKontextEdit() {
    if (!kontextEditMediaId || !selectedAdAccount) return;

    const promptInput = document.getElementById('kontextEditPrompt');
    const editPrompt = promptInput?.value?.trim();
    if (!editPrompt) {
        showToast('Please describe what you want to change', 'error');
        return;
    }

    // Ideogram requires position keywords for inpainting; Nano Banana does not
    if (editModelChoice === 'ideogram') {
        const hasQuotes = /["''""][^"''""]{1,100}["''"""]/.test(editPrompt);
        const hasPosition = /\b(top|bottom|left|right|center|middle|corner)\b/i.test(editPrompt);
        if (!hasQuotes && !hasPosition) {
            showToast('Ideogram requires a position (e.g., "at the top right"). Switch to Nano Banana Pro for general edits.', 'error');
            return;
        }
    }

    const applyBtn = document.getElementById('kontextApplyBtn');
    const applyBtnText = document.getElementById('kontextApplyBtnText');
    const resultPreview = document.getElementById('kontextResultPreview');
    const resultImage = document.getElementById('kontextResultImage');

    if (applyBtn) applyBtn.disabled = true;
    if (applyBtnText) applyBtnText.textContent = 'Applying...';

    try {
        const data = await apiPost('/api/marketing/media-assets/edit', {
            adAccountId: selectedAdAccount.id,
            mediaId: kontextEditMediaId,
            editPrompt,
            editModel: editModelChoice
        });

        // Show result in modal
        if (resultImage && data.media) {
            resultImage.src = data.media.public_url;
            if (resultPreview) resultPreview.classList.remove('hidden');
        }

        // Add to gallery
        if (data.media) {
            generatedMedia = [data.media, ...generatedMedia];
            renderGeneratedMedia();
        }

        // Update credits
        if (data.credits !== undefined) {
            mediaGenCredits = data.credits;
            updateMediaGenCreditsUI();
        }

        if (applyBtn) applyBtn.disabled = false;
        if (applyBtn) applyBtn.onclick = () => closeEditModal();
        if (applyBtnText) applyBtnText.textContent = 'Done!';
        showToast('Image edited successfully!', 'success');
    } catch (error) {
        showToast(error.message || 'Failed to edit image', 'error');
        if (applyBtn) applyBtn.disabled = false;
        if (applyBtnText) applyBtnText.textContent = 'Apply Edit';
    }
}

/**
 * Render the generated images gallery.
 */
function renderGeneratedMedia() {
    const grid = document.getElementById('mediaGalleryGrid');
    const empty = document.getElementById('mediaGalleryEmpty');
    const loading = document.getElementById('mediaGalleryLoading');

    if (loading) loading.classList.add('hidden');

    if (!generatedMedia || generatedMedia.length === 0) {
        if (grid) grid.innerHTML = '';
        if (empty) empty.classList.remove('hidden');
        return;
    }

    if (empty) empty.classList.add('hidden');

    if (grid) {
        grid.innerHTML = generatedMedia.map(media => `
            <div class="group relative rounded-xl overflow-hidden border border-surface-200 bg-surface-50">
                <div class="aspect-square cursor-pointer" onclick="openImageLightbox('${escapeHtml(media.public_url)}', '${escapeHtml(media.prompt)}')">
                    <img src="${escapeHtml(media.public_url)}" alt="Generated image"
                        class="w-full h-full object-cover">
                </div>
                <div class="p-3 border-t border-surface-200">
                    <p class="text-xs text-ink-500 truncate" title="${escapeHtml(media.prompt)}">${escapeHtml(media.prompt)}</p>
                    <p class="text-[10px] text-ink-300 mt-1">${new Date(media.created_at).toLocaleDateString()}</p>
                </div>
                <div class="absolute top-2 right-2 flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onclick="openImageLightbox('${escapeHtml(media.public_url)}', '${escapeHtml(media.prompt)}')"
                        class="bg-white/90 backdrop-blur rounded-full p-3 hover:bg-white shadow-sm" title="View full size">
                        <svg class="w-7 h-7 text-ink-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7"></path>
                        </svg>
                    </button>
                    <button onclick="openEditModal('${media.id}', '${escapeHtml(media.public_url)}')"
                        class="bg-white/90 backdrop-blur rounded-full p-3 hover:bg-brand-50 shadow-sm" title="Edit with Kontext">
                        <svg class="w-7 h-7 text-brand-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path>
                        </svg>
                    </button>
                    <a href="${escapeHtml(media.public_url)}" download="generated-${media.id}.webp"
                        class="bg-white/90 backdrop-blur rounded-full p-3 hover:bg-white shadow-sm" title="Download">
                        <svg class="w-7 h-7 text-ink-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path>
                        </svg>
                    </a>
                    <button onclick="deleteGeneratedMedia('${media.id}')"
                        class="bg-white/90 backdrop-blur rounded-full p-3 hover:bg-red-50 shadow-sm" title="Delete">
                        <svg class="w-7 h-7 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                        </svg>
                    </button>
                </div>
            </div>
        `).join('');
    }
}

/**
 * Delete a generated image.
 */
async function deleteGeneratedMedia(mediaId) {
    if (!confirm('Delete this generated image?')) return;

    try {
        await apiDelete(`/api/marketing/media-assets/generated/${mediaId}`);
        generatedMedia = generatedMedia.filter(m => m.id !== mediaId);
        renderGeneratedMedia();
        showToast('Image deleted', 'success');
    } catch (error) {
        showToast(error.message, 'error');
    }
}

// ============================================
// BRAND KIT
// ============================================

/**
 * Render the Brand Kit section for a completed training job.
 * Shows color palette, people, logos, style profile, and brand summary.
 */
function renderBrandKit(job) {
    const container = document.getElementById('mediaBrandKit');
    const loading = document.getElementById('brandKitLoading');
    const content = document.getElementById('brandKitContent');
    if (!container || !loading || !content) return;

    // Hide if no job or not completed
    if (!job || job.status !== 'completed') {
        container.classList.add('hidden');
        return;
    }

    container.classList.remove('hidden');

    // If brand_kit data not yet available, show loading and poll
    if (!job.brand_kit) {
        loading.classList.remove('hidden');
        content.classList.add('hidden');
        // Poll for brand kit data
        startBrandKitPolling(job.id);
        return;
    }

    loading.classList.add('hidden');
    content.classList.remove('hidden');

    const kit = job.brand_kit;

    // Show status bar if visual extraction is still running
    const statusBar = document.getElementById('brandKitStatusBar');
    const statusText = document.getElementById('brandKitStatusText');
    if (statusBar) {
        const assetStatus = kit.asset_extraction_status;
        if (assetStatus === 'pending' || assetStatus === 'processing') {
            statusBar.classList.remove('hidden');
            if (statusText) statusText.textContent = 'Extracting visual assets...';
            startAssetExtractionPolling(job.id);
        } else {
            statusBar.classList.add('hidden');
        }
    }

    // Render Color Palette
    const swatchesEl = document.getElementById('brandKitColorSwatches');
    if (swatchesEl && kit.color_palette && kit.color_palette.length > 0) {
        document.getElementById('brandKitColorsSection').classList.remove('hidden');
        swatchesEl.innerHTML = kit.color_palette.map(color => {
            const roleLabel = color.usage || color.role || '';
            const textColor = isLightColor(color.hex) ? 'text-ink-700' : 'text-white';
            return `
                <div class="flex flex-col items-center gap-1.5">
                    <div class="w-14 h-14 rounded-xl shadow-sm border border-surface-200 flex items-center justify-center cursor-pointer transition-transform hover:scale-110"
                         style="background-color: ${escapeHtml(color.hex)}"
                         title="${escapeHtml(color.name || color.hex)}"
                         onclick="navigator.clipboard.writeText('${escapeHtml(color.hex)}'); showToast('Copied ${escapeHtml(color.hex)}', 'success')">
                        <span class="text-[9px] font-mono ${textColor} opacity-80">${escapeHtml(color.hex)}</span>
                    </div>
                    <span class="text-[10px] text-ink-400 max-w-[60px] text-center truncate">${escapeHtml(color.name || '')}</span>
                    ${roleLabel ? `<span class="text-[9px] font-medium text-brand-500 bg-brand-50 px-1.5 py-0.5 rounded-full">${escapeHtml(roleLabel)}</span>` : ''}
                </div>`;
        }).join('');
    } else {
        document.getElementById('brandKitColorsSection').classList.add('hidden');
    }

    // Render People / Personas
    const peopleSection = document.getElementById('brandKitPeopleSection');
    const peopleList = document.getElementById('brandKitPeopleList');
    const hasPeopleCutouts = (kit.extracted_assets || []).some(a => a.type === 'person');
    if (peopleSection && peopleList && ((kit.people && kit.people.length > 0) || hasPeopleCutouts)) {
        peopleSection.classList.remove('hidden');
        peopleList.innerHTML = kit.people.map(person => `
            <div class="bg-surface-50 border border-surface-200 rounded-xl p-3">
                <div class="flex items-start gap-2">
                    <div class="w-8 h-8 rounded-full bg-brand-100 flex items-center justify-center shrink-0">
                        <svg class="w-4 h-4 text-brand-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"></path>
                        </svg>
                    </div>
                    <div>
                        <p class="text-sm text-ink-700">${escapeHtml(person.description)}</p>
                        <div class="flex items-center gap-2 mt-1">
                            ${person.role ? `<span class="text-[10px] font-medium text-ink-400 bg-surface-100 px-1.5 py-0.5 rounded">${escapeHtml(person.role)}</span>` : ''}
                            ${person.appears_in ? `<span class="text-[10px] text-ink-400">Appears in ${person.appears_in} image${person.appears_in > 1 ? 's' : ''}</span>` : ''}
                        </div>
                    </div>
                </div>
            </div>
        `).join('');
    } else if (peopleSection) {
        peopleSection.classList.add('hidden');
    }

    // Render Logos & Brand Marks
    const logosSection = document.getElementById('brandKitLogosSection');
    const logosList = document.getElementById('brandKitLogosList');
    const hasLogoCutouts = (kit.extracted_assets || []).some(a => a.type === 'logo');
    if (logosSection && logosList && ((kit.logos && kit.logos.length > 0) || hasLogoCutouts)) {
        logosSection.classList.remove('hidden');
        logosList.innerHTML = kit.logos.map(logo => `
            <div class="bg-surface-50 border border-surface-200 rounded-xl p-3">
                <div class="flex items-start gap-2">
                    <div class="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
                        <svg class="w-4 h-4 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"></path>
                        </svg>
                    </div>
                    <div>
                        <p class="text-sm text-ink-700">${escapeHtml(logo.description)}</p>
                        <div class="flex items-center gap-2 mt-1">
                            ${logo.style ? `<span class="text-[10px] font-medium text-ink-400 bg-surface-100 px-1.5 py-0.5 rounded">${escapeHtml(logo.style)}</span>` : ''}
                            ${logo.colors && logo.colors.length ? `<div class="flex gap-1">${logo.colors.map(c => `<div class="w-3 h-3 rounded-full border border-surface-300" style="background-color:${escapeHtml(c)}" title="${escapeHtml(c)}"></div>`).join('')}</div>` : ''}
                        </div>
                    </div>
                </div>
            </div>
        `).join('');
    } else if (logosSection) {
        logosSection.classList.add('hidden');
    }

    // Render extracted visual assets — distributed into People, Logos, and Graphics sections
    const assetsLoading = document.getElementById('brandKitAssetsLoading');
    const assets = kit.extracted_assets || [];
    const assetStatus = kit.asset_extraction_status;

    if (assetStatus === 'pending' || assetStatus === 'processing') {
        if (assetsLoading) assetsLoading.classList.remove('hidden');
        startAssetExtractionPolling(job.id);
    } else {
        if (assetsLoading) assetsLoading.classList.add('hidden');
    }

    // Distribute cutouts into their respective sections
    const peopleCutouts = assets.filter(a => a.type === 'person');
    const logoCutouts = assets.filter(a => a.type === 'logo');
    const graphicCutouts = assets.filter(a => a.type === 'graphic');

    // Person cutouts → inside People section (collapsed by default)
    const peopleCutoutsEl = document.getElementById('brandKitPeopleCutouts');
    const peopleCutoutsToggle = document.getElementById('brandKitPeopleCutoutsToggle');
    if (peopleCutoutsEl) {
        if (peopleCutouts.length > 0) {
            peopleCutoutsEl.innerHTML = renderCutoutGrid(peopleCutouts, 'person');
            peopleCutoutsEl.classList.add('hidden'); // Start collapsed
            if (peopleCutoutsToggle) {
                peopleCutoutsToggle.classList.remove('hidden');
                document.getElementById('brandKitPeopleCutoutsLabel').textContent = `Show extracted assets (${peopleCutouts.length})`;
                document.getElementById('brandKitPeopleCutoutsArrow').style.transform = '';
            }
        } else {
            peopleCutoutsEl.classList.add('hidden');
            if (peopleCutoutsToggle) peopleCutoutsToggle.classList.add('hidden');
        }
    }

    // Logo cutouts → inside Logos section (collapsed by default)
    const logoCutoutsEl = document.getElementById('brandKitLogoCutouts');
    const logoCutoutsToggle = document.getElementById('brandKitLogoCutoutsToggle');
    if (logoCutoutsEl) {
        if (logoCutouts.length > 0) {
            logoCutoutsEl.innerHTML = renderCutoutGrid(logoCutouts, 'logo');
            logoCutoutsEl.classList.add('hidden'); // Start collapsed
            if (logoCutoutsToggle) {
                logoCutoutsToggle.classList.remove('hidden');
                document.getElementById('brandKitLogoCutoutsLabel').textContent = `Show extracted assets (${logoCutouts.length})`;
                document.getElementById('brandKitLogoCutoutsArrow').style.transform = '';
            }
        } else {
            logoCutoutsEl.classList.add('hidden');
            if (logoCutoutsToggle) logoCutoutsToggle.classList.add('hidden');
        }
    }

    // Graphics/backgrounds → own section (collapsed by default)
    const graphicsSection = document.getElementById('brandKitGraphicsSection');
    const graphicsCutoutsEl = document.getElementById('brandKitGraphicsCutouts');
    const graphicsCutoutsToggle = document.getElementById('brandKitGraphicsCutoutsToggle');
    if (graphicsSection && graphicsCutoutsEl) {
        if (graphicCutouts.length > 0) {
            graphicsSection.classList.remove('hidden');
            graphicsCutoutsEl.innerHTML = renderCutoutGrid(graphicCutouts, 'graphic');
            graphicsCutoutsEl.classList.add('hidden'); // Start collapsed
            if (graphicsCutoutsToggle) {
                graphicsCutoutsToggle.classList.remove('hidden');
                document.getElementById('brandKitGraphicsCutoutsLabel').textContent = `Show extracted assets (${graphicCutouts.length})`;
                document.getElementById('brandKitGraphicsCutoutsArrow').style.transform = '';
            }
        } else {
            graphicsSection.classList.add('hidden');
        }
    }

    // Render Style Profile
    const styleDetails = document.getElementById('brandKitStyleDetails');
    if (styleDetails && kit.style_characteristics) {
        const sc = kit.style_characteristics;
        const items = [];
        if (sc.overall_aesthetic) items.push({ label: 'Aesthetic', value: sc.overall_aesthetic });
        if (sc.photography_style) items.push({ label: 'Photography', value: sc.photography_style });
        if (sc.illustration_style) items.push({ label: 'Illustration', value: sc.illustration_style });
        if (sc.typography_hints) items.push({ label: 'Typography', value: sc.typography_hints });
        if (sc.mood) items.push({ label: 'Mood', value: sc.mood });
        if (sc.visual_motifs) items.push({ label: 'Visual Motifs', value: sc.visual_motifs });

        if (items.length > 0) {
            document.getElementById('brandKitStyleSection').classList.remove('hidden');
            styleDetails.innerHTML = items.map(item => `
                <div class="flex items-start gap-2">
                    <span class="text-xs font-medium text-ink-500 min-w-[90px] shrink-0">${escapeHtml(item.label)}</span>
                    <span class="text-xs text-ink-600">${escapeHtml(item.value)}</span>
                </div>
            `).join('');
        } else {
            document.getElementById('brandKitStyleSection').classList.add('hidden');
        }
    }

    // Render Brand Summary
    const summaryEl = document.getElementById('brandKitSummary');
    if (summaryEl && kit.brand_summary) {
        document.getElementById('brandKitSummarySection').classList.remove('hidden');
        summaryEl.textContent = kit.brand_summary;
    } else if (summaryEl) {
        document.getElementById('brandKitSummarySection').classList.add('hidden');
    }
}

/**
 * Render a grid of cutout asset thumbnails with transparency background, download overlay, and description.
 */
function renderCutoutGrid(assets, type) {
    return assets.map((asset, i) => `
        <div class="group relative">
            <div class="aspect-square rounded-xl border border-surface-200 overflow-hidden cursor-pointer"
                 style="background: repeating-conic-gradient(#e5e7eb 0% 25%, #fff 0% 50%) 50% / 16px 16px"
                 onclick="window.open('${escapeHtml(asset.url)}', '_blank')"
                 title="${escapeHtml(asset.description)}">
                <img src="${escapeHtml(asset.url)}" alt="${escapeHtml(asset.description)}"
                     class="w-full h-full object-contain p-1" loading="lazy">
            </div>
            <div class="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity rounded-xl flex items-center justify-center">
                <a href="${escapeHtml(asset.url)}" download="${escapeHtml(type)}-${i}.png"
                   class="bg-white/90 text-ink-700 text-xs px-3 py-1.5 rounded-lg font-medium hover:bg-white transition-colors flex items-center gap-1"
                   onclick="event.stopPropagation()">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path>
                    </svg>
                    PNG
                </a>
            </div>
            <div class="mt-1.5 flex items-center gap-1">
                <span class="text-[9px] font-medium px-1.5 py-0.5 rounded ${asset.type === 'person' ? 'bg-blue-50 text-blue-600' : asset.type === 'logo' ? 'bg-amber-50 text-amber-600' : 'bg-green-50 text-green-600'}">#${escapeHtml(asset.type)}</span>
            </div>
            <p class="text-[10px] text-ink-400 truncate mt-0.5" title="${escapeHtml(asset.description)}">${escapeHtml(asset.description)}</p>
        </div>`).join('');
}

/**
 * Toggle a cutout section open/closed.
 */
function toggleCutoutSection(name) {
    const grid = document.getElementById(`brandKit${name}Cutouts`);
    const arrow = document.getElementById(`brandKit${name}CutoutsArrow`);
    const label = document.getElementById(`brandKit${name}CutoutsLabel`);
    if (!grid) return;

    const isHidden = grid.classList.contains('hidden');
    grid.classList.toggle('hidden');
    if (arrow) arrow.style.transform = isHidden ? 'rotate(90deg)' : '';
    if (label) {
        const count = grid.children.length;
        label.textContent = isHidden ? `Hide extracted assets (${count})` : `Show extracted assets (${count})`;
    }
}

/**
 * Check if a hex color is light (for text contrast).
 */
function isLightColor(hex) {
    const c = hex.replace('#', '');
    const r = parseInt(c.substr(0, 2), 16);
    const g = parseInt(c.substr(2, 2), 16);
    const b = parseInt(c.substr(4, 2), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 > 150;
}

var brandKitPollingTimer = null;

function startBrandKitPolling(jobId) {
    stopBrandKitPolling();
    let attempts = 0;
    const maxAttempts = 24; // ~4 minutes (10s intervals)

    brandKitPollingTimer = setInterval(async () => {
        attempts++;
        if (attempts > maxAttempts) {
            stopBrandKitPolling();
            const loading = document.getElementById('brandKitLoading');
            if (loading) loading.innerHTML = '<p class="text-sm text-ink-400 text-center py-4">Brand analysis is taking longer than expected. Use the re-analyze button to try again.</p>';
            return;
        }

        try {
            if (!selectedAdAccount) return;
            const data = await apiGet(`/api/marketing/media-assets/training/status?adAccountId=${selectedAdAccount.id}&jobId=${jobId}`);
            if (data.job && data.job.brand_kit) {
                // Update local state
                const idx = mediaTrainingJobs.findIndex(j => j.id === jobId);
                if (idx !== -1) mediaTrainingJobs[idx].brand_kit = data.job.brand_kit;
                if (selectedTrainingJob && selectedTrainingJob.id === jobId) {
                    selectedTrainingJob.brand_kit = data.job.brand_kit;
                }

                // Check if visual extraction is still running
                const assetStatus = data.job.brand_kit.asset_extraction_status;
                const extractionDone = assetStatus === 'completed' || assetStatus === 'failed' || assetStatus === 'skipped';

                // Render the brand kit content
                renderBrandKit(selectedTrainingJob);

                // Only stop polling when EVERYTHING is done (text + extraction)
                if (extractionDone) {
                    stopBrandKitPolling();
                }
            }
        } catch (e) {
            // Silent — keep polling
        }
    }, 10000);
}

function stopBrandKitPolling() {
    if (brandKitPollingTimer) {
        clearInterval(brandKitPollingTimer);
        brandKitPollingTimer = null;
    }
}

var assetExtractionPollingTimer = null;

/**
 * Poll for visual asset extraction completion.
 * Reuses the same pattern as brand kit polling but checks asset_extraction_status specifically.
 */
function startAssetExtractionPolling(jobId) {
    if (assetExtractionPollingTimer) clearInterval(assetExtractionPollingTimer);
    let attempts = 0;
    const maxAttempts = 30; // ~5 minutes (10s intervals)

    assetExtractionPollingTimer = setInterval(async () => {
        attempts++;
        if (attempts > maxAttempts) {
            clearInterval(assetExtractionPollingTimer);
            assetExtractionPollingTimer = null;
            const loading = document.getElementById('brandKitAssetsLoading');
            if (loading) loading.innerHTML = '<p class="text-xs text-ink-400 text-center py-4">Asset extraction is taking longer than expected. Use the re-analyze button to try again.</p>';
            const statusBar = document.getElementById('brandKitStatusBar');
            if (statusBar) statusBar.classList.add('hidden');
            return;
        }

        try {
            if (!selectedAdAccount) return;
            const data = await apiGet(`/api/marketing/media-assets/training/status?adAccountId=${selectedAdAccount.id}&jobId=${jobId}`);
            if (data.job && data.job.brand_kit) {
                const status = data.job.brand_kit.asset_extraction_status;
                if (status && status !== 'pending' && status !== 'processing') {
                    clearInterval(assetExtractionPollingTimer);
                    assetExtractionPollingTimer = null;
                    // Update local state and re-render
                    const idx = mediaTrainingJobs.findIndex(j => j.id === jobId);
                    if (idx !== -1) mediaTrainingJobs[idx].brand_kit = data.job.brand_kit;
                    if (selectedTrainingJob && selectedTrainingJob.id === jobId) {
                        selectedTrainingJob.brand_kit = data.job.brand_kit;
                    }
                    renderBrandKit(selectedTrainingJob);
                }
            }
        } catch (e) {
            // Silent — keep polling
        }
    }, 10000);
}

/**
 * Re-analyze brand kit for the currently selected training job.
 */
async function reanalyzeBrandKit() {
    if (!selectedTrainingJob || !selectedAdAccount) return;

    const btn = document.getElementById('brandKitReanalyzeBtn');
    if (btn) btn.disabled = true;

    try {
        showToast('Re-analyzing brand assets...', 'info');
        await apiPost(`/api/marketing/media-assets/training/${selectedTrainingJob.id}/analyze-brand-kit`, {
            adAccountId: selectedAdAccount.id
        });

        // Mark asset extraction as pending (keeps existing text data visible while re-analyzing)
        if (selectedTrainingJob.brand_kit) {
            selectedTrainingJob.brand_kit.asset_extraction_status = 'pending';
            selectedTrainingJob.brand_kit.extracted_assets = [];
        }
        renderBrandKit(selectedTrainingJob);
        // Start polling for updated results
        startBrandKitPolling(selectedTrainingJob.id);
    } catch (error) {
        showToast(error.message || 'Failed to start brand analysis', 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

// ============================================
// PLAYABLE ADS TAB
// ============================================

let playableState = {
    templates: [],
    selectedTemplate: null,
    selectedContentType: 'mini_game',
    selectedJobId: null,
    currentContentId: null,
    sseSource: null,
    credits: 0
};

/**
 * Load the Playables tab: populate job selector, fetch templates.
 */
async function loadPlayables() {
    if (!selectedAdAccount) return;

    const jobSelect = document.getElementById('playableJobSelect');
    const noBrandKit = document.getElementById('playableNoBrandKit');
    const contentTypeToggle = document.getElementById('playableContentTypeToggle');
    const templateGrid = document.getElementById('playableTemplateGrid');
    const configPanel = document.getElementById('playableConfigPanel');
    const progressPanel = document.getElementById('playableProgressPanel');
    const previewPanel = document.getElementById('playablePreviewPanel');

    // Reset panels
    [configPanel, progressPanel, previewPanel].forEach(p => p?.classList.add('hidden'));

    // Load training jobs for the job selector
    try {
        const resp = await apiGet(`/api/marketing/media-assets/training/history?adAccountId=${selectedAdAccount.id}`);
        const jobs = (resp.jobs || []).filter(j => j.brand_kit && j.status === 'completed');

        if (jobs.length === 0) {
            jobSelect.innerHTML = '<option value="">No models with Brand Kit available</option>';
            noBrandKit?.classList.remove('hidden');
            contentTypeToggle?.classList.add('hidden');
            templateGrid?.classList.add('hidden');
            document.getElementById('playableHistorySection')?.classList.add('hidden');
            return;
        }

        noBrandKit?.classList.add('hidden');

        jobSelect.innerHTML = jobs.map(j => {
            const name = j.name || `Model ${j.id.substring(0, 8)}`;
            const assetCount = j.brand_kit?.extracted_assets?.length || 0;
            return `<option value="${j.id}">${escapeHtml(name)} (${assetCount} assets)</option>`;
        }).join('');

        // Auto-select first or previously selected
        if (playableState.selectedJobId && jobs.find(j => j.id === playableState.selectedJobId)) {
            jobSelect.value = playableState.selectedJobId;
        } else {
            playableState.selectedJobId = jobs[0].id;
            jobSelect.value = jobs[0].id;
        }

        // Attach change listener after populating (avoids race from innerHTML-triggered onchange)
        jobSelect.onchange = onPlayableJobChange;

        await loadPlayableTemplates();
        await loadPlayableHistory();
    } catch (error) {
        showToast(error.message || 'Failed to load playable ads data', 'error');
    }
}

/**
 * Handle job selector change.
 */
async function onPlayableJobChange() {
    const jobSelect = document.getElementById('playableJobSelect');
    playableState.selectedJobId = jobSelect.value || null;
    playableState.selectedTemplate = null;
    playableState.currentContentId = null;

    // Zero-trust: clear all panels when switching models
    document.getElementById('playableConfigPanel')?.classList.add('hidden');
    document.getElementById('playableProgressPanel')?.classList.add('hidden');
    document.getElementById('playablePreviewPanel')?.classList.add('hidden');
    document.getElementById('playableTemplateGrid').innerHTML = '';
    document.getElementById('playableHistoryList').innerHTML = '';
    document.getElementById('playableHistoryEmpty')?.classList.add('hidden');

    if (playableState.selectedJobId) {
        await loadPlayableTemplates();
        await loadPlayableHistory();
    }
}

/**
 * Fetch templates for the selected training job.
 */
async function loadPlayableTemplates() {
    if (!playableState.selectedJobId || playableState.selectedJobId === 'undefined') return;

    const contentTypeToggle = document.getElementById('playableContentTypeToggle');
    const templateGrid = document.getElementById('playableTemplateGrid');

    try {
        const resp = await apiGet(`/api/marketing/playable-content/templates?trainingJobId=${playableState.selectedJobId}&contentType=${playableState.selectedContentType}`);
        playableState.templates = resp.templates || [];
        playableState.credits = resp.credits || 0;

        contentTypeToggle?.classList.remove('hidden');
        templateGrid?.classList.remove('hidden');

        updatePlayableCreditsUI();
        renderPlayableTemplateGrid();
    } catch (error) {
        showToast(error.message || 'Failed to load templates', 'error');
    }
}

/**
 * Set the content type filter (mini_game or interactive_story).
 */
function setPlayableContentType(type) {
    playableState.selectedContentType = type;
    playableState.selectedTemplate = null;
    document.getElementById('playableConfigPanel')?.classList.add('hidden');

    // Update toggle buttons
    const gameBtn = document.getElementById('playableTypeGameBtn');
    const storyBtn = document.getElementById('playableTypeStoryBtn');
    if (type === 'mini_game') {
        gameBtn.className = 'px-5 py-2.5 text-sm font-medium transition-colors bg-brand-600 text-white';
        storyBtn.className = 'px-5 py-2.5 text-sm font-medium transition-colors bg-white text-ink-600 hover:bg-surface-50';
    } else {
        storyBtn.className = 'px-5 py-2.5 text-sm font-medium transition-colors bg-brand-600 text-white';
        gameBtn.className = 'px-5 py-2.5 text-sm font-medium transition-colors bg-white text-ink-600 hover:bg-surface-50';
    }

    loadPlayableTemplates();
}

/**
 * Render the template grid.
 */
function renderPlayableTemplateGrid() {
    const grid = document.getElementById('playableTemplateGrid');
    if (!grid) return;

    const templates = playableState.templates;
    if (templates.length === 0) {
        grid.innerHTML = '<p class="col-span-full text-center text-ink-400 py-6">No templates available for this content type.</p>';
        return;
    }

    const iconMap = {
        catch_falling: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 14l-7 7m0 0l-7-7m7 7V3"></path>',
        tap_the_logo: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122"></path>',
        color_match: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01"></path>',
        swipe_sort: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"></path>',
        brand_story: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"></path>',
        product_reveal: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v13m0-13V6a2 2 0 112 2h-2zm0 0V5.5A2.5 2.5 0 109.5 8H12zm-7 4h14M5 12a2 2 0 110-4h14a2 2 0 110 4M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7"></path>',
        scratch_reveal: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path>',
        quiz_trivia: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>',
        endless_runner: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 5l7 7-7 7M5 5l7 7-7 7"></path>',
        match_three: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16"></path>',
        tower_stack: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h12a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h12a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2z"></path>'
    };

    grid.innerHTML = templates.map(t => {
        const icon = iconMap[t.id] || iconMap.catch_falling;
        const disabled = !t.available;
        const disabledClass = disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:border-brand-400 hover:shadow-md';
        const isPremium = (t.tier === 'premium') && Array.isArray(t.engines) && t.engines.includes('hybrid');

        return `
        <div class="card-gradient p-5 rounded-xl border border-surface-200 transition-all relative ${disabledClass}"
             ${disabled ? '' : `onclick="selectPlayableTemplate('${t.id}')"`}>
            ${isPremium ? '<span class="absolute top-2 right-2 text-[10px] font-bold uppercase tracking-wider bg-gradient-to-r from-amber-400 to-amber-600 text-white px-2 py-0.5 rounded-full shadow-sm">\u2728 Premium</span>' : ''}
            <div class="flex items-center gap-3 mb-3">
                <div class="w-10 h-10 rounded-lg ${disabled ? 'bg-surface-200' : 'bg-brand-100'} flex items-center justify-center">
                    <svg class="w-5 h-5 ${disabled ? 'text-ink-400' : 'text-brand-600'}" fill="none" stroke="currentColor" viewBox="0 0 24 24">${icon}</svg>
                </div>
                <div>
                    <h5 class="text-base font-semibold text-ink-800">${escapeHtml(t.name)}</h5>
                    <span class="text-xs text-ink-400">${escapeHtml(t.duration)}</span>
                </div>
            </div>
            <p class="text-sm text-ink-500 mb-3">${escapeHtml(t.description)}</p>
            ${disabled ? `<p class="text-xs text-amber-600 bg-amber-50 rounded-lg px-2 py-1">${escapeHtml(t.missingReason || 'Not available')}</p>` :
              `<div class="flex gap-2">
                ${t.mechanics.slice(0, 3).map(m => `<span class="text-xs bg-surface-100 text-ink-500 rounded-full px-2 py-0.5">${escapeHtml(m)}</span>`).join('')}
              </div>`}
        </div>`;
    }).join('');
}

/**
 * Select a template and show the configuration panel.
 */
function selectPlayableTemplate(templateId) {
    const template = playableState.templates.find(t => t.id === templateId);
    if (!template || !template.available) return;

    playableState.selectedTemplate = template;

    // Show config panel
    const configPanel = document.getElementById('playableConfigPanel');
    configPanel?.classList.remove('hidden');

    // Fill template summary
    const summaryEl = document.getElementById('playableSelectedTemplate');
    if (summaryEl) {
        summaryEl.innerHTML = `
            <div class="flex items-center gap-2">
                <span class="text-sm font-medium text-brand-700">${escapeHtml(template.name)}</span>
                <span class="text-xs text-ink-400">${escapeHtml(template.duration)}</span>
            </div>`;
    }

    // Auto-suggest title
    const titleInput = document.getElementById('playableTitleInput');
    if (titleInput && !titleInput.value) {
        titleInput.value = template.name;
    }

    // Show/hide story options
    const storyOpts = document.getElementById('playableStoryOptions');
    if (storyOpts) {
        storyOpts.classList.toggle('hidden', template.type !== 'interactive_story');
    }

    // Constrain engine selection based on template support
    // Hybrid-only templates (new game types) force hybrid mode
    const engineSelector = document.getElementById('playableEngineSelector');
    const hybridRadio = document.getElementById('playableGenModeHybrid');
    const classicRadio = document.getElementById('playableGenModeClassic');
    const engines = template.engines || ['ai_classic'];
    const supportsHybrid = engines.includes('hybrid');
    const supportsClassic = engines.includes('ai_classic');

    if (hybridRadio && classicRadio) {
        // If only one engine supported, select it and disable switching
        if (supportsHybrid && !supportsClassic) {
            hybridRadio.checked = true;
            classicRadio.disabled = true;
            classicRadio.parentElement.classList.add('opacity-40', 'cursor-not-allowed');
        } else if (supportsClassic && !supportsHybrid) {
            classicRadio.checked = true;
            hybridRadio.disabled = true;
            hybridRadio.parentElement.classList.add('opacity-40', 'cursor-not-allowed');
        } else {
            // Both supported — enable both, default to hybrid
            classicRadio.disabled = false;
            hybridRadio.disabled = false;
            classicRadio.parentElement.classList.remove('opacity-40', 'cursor-not-allowed');
            hybridRadio.parentElement.classList.remove('opacity-40', 'cursor-not-allowed');
            if (!hybridRadio.checked && !classicRadio.checked) hybridRadio.checked = true;
        }
    }

    // Scroll to config
    configPanel?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/**
 * Cancel template configuration.
 */
function cancelPlayableConfig() {
    playableState.selectedTemplate = null;
    document.getElementById('playableConfigPanel')?.classList.add('hidden');
}

/**
 * Start playable generation.
 */
async function startPlayableGeneration() {
    if (!playableState.selectedTemplate || !playableState.selectedJobId) return;

    const title = document.getElementById('playableTitleInput')?.value?.trim();
    if (!title) {
        showToast('Please enter a title', 'error');
        return;
    }

    const ctaUrl = document.getElementById('playableCtaInput')?.value?.trim() || '';
    const storyDirection = document.getElementById('playableStoryDirection')?.value?.trim() || '';

    // Collect MRAID formats
    const mraidFormats = [];
    if (document.getElementById('playableFmtGoogle')?.checked) mraidFormats.push('google');
    if (document.getElementById('playableFmtMeta')?.checked) mraidFormats.push('meta');
    if (document.getElementById('playableFmtUnity')?.checked) mraidFormats.push('unity');
    if (mraidFormats.length === 0) mraidFormats.push('google');

    const btn = document.getElementById('playableGenerateBtn');
    if (btn) btn.disabled = true;

    // Read selected generation mode (defaults to hybrid)
    const selectedModeRadio = document.querySelector('input[name="playableGenMode"]:checked');
    const generationMode = selectedModeRadio ? selectedModeRadio.value : 'hybrid';

    try {
        const resp = await apiPost('/api/marketing/playable-content/generate', {
            adAccountId: selectedAdAccount.id,
            trainingJobId: playableState.selectedJobId,
            templateId: playableState.selectedTemplate.id,
            contentType: playableState.selectedContentType,
            title,
            ctaUrl,
            mraidFormats,
            storyOptions: storyDirection ? { direction: storyDirection } : {},
            generationMode
        });

        playableState.currentContentId = resp.content.id;

        // Hide config, show progress
        document.getElementById('playableConfigPanel')?.classList.add('hidden');
        document.getElementById('playablePreviewPanel')?.classList.add('hidden');
        document.getElementById('playableProgressPanel')?.classList.remove('hidden');

        // Connect to SSE
        connectPlayableSSE(resp.content.id);

    } catch (error) {
        const msg = error.message || 'Failed to start generation';
        if (error.status === 402 || msg.includes('credits')) {
            showToast('No generation credits remaining. Purchase more to continue.', 'error');
        } else {
            showToast(msg, 'error');
        }
    } finally {
        if (btn) btn.disabled = false;
    }
}

/**
 * Connect to SSE progress stream for a generating playable.
 */
function connectPlayableSSE(contentId) {
    // Close any existing connection
    if (playableState.sseSource) {
        playableState.sseSource.close();
        playableState.sseSource = null;
    }

    const progressBar = document.getElementById('playableProgressBar');
    const progressText = document.getElementById('playableProgressText');

    const phaseProgress = {
        connected: 5,
        preparing: 10,
        encoding_assets: 25,
        generating_code: 50,
        validating: 65,
        retry: 55,
        packaging: 80,
        uploading: 90,
        complete: 100,
        error: 100
    };

    const source = new EventSource(`/api/marketing/playable-content/${contentId}/progress`);
    playableState.sseSource = source;

    source.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            const pct = phaseProgress[data.phase] || 50;

            if (progressBar) progressBar.style.width = `${pct}%`;
            if (progressText) progressText.textContent = data.message || data.phase;

            if (data.phase === 'complete') {
                source.close();
                playableState.sseSource = null;

                // Show preview + refresh credits (consumed on success)
                setTimeout(async () => {
                    document.getElementById('playableProgressPanel')?.classList.add('hidden');
                    showPlayablePreview(contentId);
                    loadPlayableHistory();
                    try {
                        const result = await apiGet('/api/marketing/playable-content/credits');
                        playableState.credits = result.credits;
                        updatePlayableCreditsUI();
                    } catch {}
                }, 500);
            }

            if (data.phase === 'error') {
                source.close();
                playableState.sseSource = null;
                if (progressBar) progressBar.classList.replace('bg-brand-600', 'bg-red-500');
                if (progressText) progressText.textContent = `Error: ${data.message}`;

                setTimeout(() => {
                    document.getElementById('playableProgressPanel')?.classList.add('hidden');
                    showToast(data.message || 'Generation failed', 'error');
                    loadPlayableHistory();
                }, 2000);
            }
        } catch { /* ignore parse errors */ }
    };

    source.onerror = () => {
        source.close();
        playableState.sseSource = null;
        // Fall back to polling
        pollPlayableStatus(contentId);
    };
}

/**
 * Fallback: poll status if SSE disconnects.
 */
async function pollPlayableStatus(contentId) {
    const progressBar = document.getElementById('playableProgressBar');
    let attempts = 0;
    const maxAttempts = 60; // 5 minutes at 5s intervals

    const poll = setInterval(async () => {
        attempts++;
        try {
            const resp = await apiGet(`/api/marketing/playable-content/${contentId}/status`);
            const { status, error_message } = resp.content;

            if (status === 'completed') {
                clearInterval(poll);
                if (progressBar) progressBar.style.width = '100%';
                document.getElementById('playableProgressPanel')?.classList.add('hidden');
                showPlayablePreview(contentId);
                loadPlayableHistory();
                try {
                    const cr = await apiGet('/api/marketing/playable-content/credits');
                    playableState.credits = cr.credits;
                    updatePlayableCreditsUI();
                } catch {}
            } else if (status === 'failed') {
                clearInterval(poll);
                document.getElementById('playableProgressPanel')?.classList.add('hidden');
                showToast(error_message || 'Generation failed', 'error');
                loadPlayableHistory();
            }
        } catch { /* ignore */ }

        if (attempts >= maxAttempts) {
            clearInterval(poll);
            document.getElementById('playableProgressPanel')?.classList.add('hidden');
            showToast('Generation timed out. Check history for results.', 'error');
        }
    }, 5000);
}

/**
 * Show the preview panel with iframe.
 */
function showPlayablePreview(contentId) {
    playableState.currentContentId = contentId;
    const panel = document.getElementById('playablePreviewPanel');
    const iframe = document.getElementById('playablePreviewIframe');
    const meta = document.getElementById('playablePreviewMeta');

    panel?.classList.remove('hidden');
    if (iframe) {
        iframe.src = `/api/marketing/playable-content/${contentId}/preview`;
    }
    if (meta) {
        meta.textContent = '320 x 480 — Interactive preview (sandboxed)';
    }
    panel?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/**
 * Download the playable as a .zip.
 */
function downloadPlayable() {
    if (!playableState.currentContentId) return;
    window.open(`/api/marketing/playable-content/${playableState.currentContentId}/download`, '_blank');
}

/**
 * Regenerate the current playable.
 */
async function regeneratePlayable() {
    if (!playableState.currentContentId) return;

    const btn = document.getElementById('playableRegenBtn');
    if (btn) btn.disabled = true;

    try {
        const resp = await apiPost(`/api/marketing/playable-content/${playableState.currentContentId}/regenerate`);
        playableState.currentContentId = resp.content.id;

        // Show progress
        document.getElementById('playablePreviewPanel')?.classList.add('hidden');
        document.getElementById('playableProgressPanel')?.classList.remove('hidden');
        const progressBar = document.getElementById('playableProgressBar');
        if (progressBar) {
            progressBar.style.width = '0%';
            progressBar.classList.replace('bg-red-500', 'bg-brand-600');
        }

        connectPlayableSSE(resp.content.id);
    } catch (error) {
        showToast(error.message || 'Failed to regenerate', 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

/**
 * Load playable content history.
 */
async function loadPlayableHistory() {
    const section = document.getElementById('playableHistorySection');
    const list = document.getElementById('playableHistoryList');
    const empty = document.getElementById('playableHistoryEmpty');
    if (!section || !list) return;

    try {
        const jobFilter = playableState.selectedJobId ? `&trainingJobId=${playableState.selectedJobId}` : '';
        const resp = await apiGet(`/api/marketing/playable-content/history?adAccountId=${selectedAdAccount.id}${jobFilter}&limit=20`);
        const items = resp.items || [];

        section.classList.remove('hidden');

        if (items.length === 0) {
            list.innerHTML = '';
            empty?.classList.remove('hidden');
            return;
        }
        empty?.classList.add('hidden');

        list.innerHTML = items.map(item => {
            const statusColors = {
                completed: 'bg-green-100 text-green-700',
                failed: 'bg-red-100 text-red-700',
                generating: 'bg-blue-100 text-blue-700',
                pending: 'bg-surface-100 text-ink-500',
                validating: 'bg-yellow-100 text-yellow-700',
                packaging: 'bg-blue-100 text-blue-700'
            };
            const statusClass = statusColors[item.status] || statusColors.pending;
            const date = new Date(item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            const sizeKB = item.file_size_bytes ? `${(item.file_size_bytes / 1024).toFixed(0)}KB` : '';
            const durationSec = item.generation_duration_ms ? `${(item.generation_duration_ms / 1000).toFixed(1)}s` : '';
            const formats = (item.mraid_formats || []).join(', ');

            return `
            <div class="card-gradient p-4 rounded-lg border border-surface-200 flex items-center justify-between gap-4">
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 mb-1">
                        <span class="text-base font-medium text-ink-800 truncate">${escapeHtml(item.title)}</span>
                        <span class="text-xs px-2 py-0.5 rounded-full ${statusClass}">${item.status}</span>
                    </div>
                    <div class="flex items-center gap-3 text-xs text-ink-400">
                        <span>${escapeHtml(item.template_id.replace(/_/g, ' '))}</span>
                        <span>${date}</span>
                        ${sizeKB ? `<span>${sizeKB}</span>` : ''}
                        ${durationSec ? `<span>${durationSec}</span>` : ''}
                        ${formats ? `<span>${formats}</span>` : ''}
                    </div>
                </div>
                <div class="flex items-center gap-2 flex-shrink-0">
                    ${item.status === 'completed' ? `
                        <button onclick="showPlayablePreview('${item.id}')" class="btn-secondary btn-sm px-2.5 py-1.5 text-xs" title="Preview">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg>
                        </button>
                        <button onclick="window.open('/api/marketing/playable-content/${item.id}/download', '_blank')" class="btn-secondary btn-sm px-2.5 py-1.5 text-xs" title="Download">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                        </button>
                    ` : ''}
                    <button onclick="deletePlayable('${item.id}')" class="btn-secondary btn-sm px-2.5 py-1.5 text-xs text-red-600 hover:bg-red-50" title="Delete">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                    </button>
                </div>
            </div>`;
        }).join('');
    } catch (error) {
        // Non-blocking: history load failure shouldn't break the tab
        console.error('Failed to load playable history:', error);
    }
}

/**
 * Delete a playable content item.
 */
async function deletePlayable(contentId) {
    if (!confirm('Delete this playable? This cannot be undone.')) return;

    try {
        await apiDelete(`/api/marketing/playable-content/${contentId}`);
        showToast('Playable deleted', 'success');

        // If it was the previewed one, hide preview
        if (playableState.currentContentId === contentId) {
            document.getElementById('playablePreviewPanel')?.classList.add('hidden');
            playableState.currentContentId = null;
        }

        loadPlayableHistory();
    } catch (error) {
        showToast(error.message || 'Failed to delete', 'error');
    }
}

// ============================================
// PLAYABLE CREDITS & PAYMENT
// ============================================

const PLAYABLE_PACK_PRICE_CENTS = 990; // $9.90 per pack of 3 credits
const PLAYABLE_CREDITS_PER_PACK = 3;

/**
 * Update the credits UI: count, purchase controls visibility, locked overlay.
 */
function updatePlayableCreditsUI() {
    const countEl = document.getElementById('playableCreditsCount');
    const purchaseControls = document.getElementById('playablePurchaseControls');
    const overlay = document.getElementById('playableLockedOverlay');
    const generateBtn = document.getElementById('playableGenerateBtn');

    if (countEl) countEl.textContent = playableState.credits;

    // Show purchase controls when credits <= 1
    if (purchaseControls) {
        if (playableState.credits <= 1) {
            purchaseControls.classList.remove('hidden');
            purchaseControls.classList.add('flex');
        } else {
            purchaseControls.classList.add('hidden');
            purchaseControls.classList.remove('flex');
        }
    }

    // Show locked overlay when credits = 0
    if (overlay) {
        if (playableState.credits <= 0) {
            overlay.classList.remove('hidden');
        } else {
            overlay.classList.add('hidden');
        }
    }

    // Disable generate button when no credits
    if (generateBtn) {
        if (playableState.credits <= 0) {
            generateBtn.disabled = true;
            generateBtn.title = 'No generation credits remaining';
        } else {
            generateBtn.disabled = false;
            generateBtn.title = '';
        }
    }

    // Sync totals
    updatePlayableCreditTotal();
}

/**
 * Update the total price display based on quantity selector.
 */
function updatePlayableCreditTotal() {
    // Get quantity from whichever selector is visible
    const qtyMain = document.getElementById('playableCreditQty');
    const qtyOverlay = document.getElementById('playableCreditQtyOverlay');
    const qty = parseInt(qtyMain?.value || qtyOverlay?.value || '3');

    // Sync both selectors
    if (qtyMain) qtyMain.value = qty;
    if (qtyOverlay) qtyOverlay.value = qty;

    const total = ((PLAYABLE_PACK_PRICE_CENTS * qty) / 100).toFixed(2);
    const credits = qty * PLAYABLE_CREDITS_PER_PACK;

    const totalMain = document.getElementById('playableCreditTotal');
    const totalOverlay = document.getElementById('playableCreditTotalOverlay');
    if (totalMain) totalMain.textContent = `${credits} for $${total}`;
    if (totalOverlay) totalOverlay.textContent = `${credits} for $${total}`;
}

/**
 * Purchase playable content credits via LS compact checkout.
 */
async function purchasePlayableCredits() {
    const btn = document.getElementById('playableBuyCreditsBtn');
    const originalHtml = btn?.innerHTML;

    const qtyMain = document.getElementById('playableCreditQty');
    const qtyOverlay = document.getElementById('playableCreditQtyOverlay');
    const packs = parseInt(qtyMain?.value || qtyOverlay?.value || '1');

    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<div class="loader" style="width:14px;height:14px;"></div> Preparing...';
    }

    try {
        const { checkoutUrl } = await apiPost('/api/subscriptions/playable-gen-checkout', { packs });

        const total = ((PLAYABLE_PACK_PRICE_CENTS * packs) / 100).toFixed(2);
        if (btn) btn.innerHTML = `<div class="loader" style="width:14px;height:14px;"></div> Pay $${total}...`;

        const paid = await showCompactCheckout(checkoutUrl, btn || document.getElementById('playableLockedOverlay'), { direction: 'up' });

        if (!paid) {
            if (btn) { btn.disabled = false; btn.innerHTML = originalHtml; }
            return;
        }

        // Poll for webhook confirmation
        if (btn) btn.innerHTML = '<div class="loader" style="width:14px;height:14px;"></div> Confirming...';
        const previousCredits = playableState.credits;
        let confirmed = false;
        for (let attempt = 0; attempt < 15; attempt++) {
            await new Promise(r => setTimeout(r, 2000));
            try {
                const result = await apiGet('/api/marketing/playable-content/credits');
                if (result.credits > previousCredits) {
                    playableState.credits = result.credits;
                    confirmed = true;
                    break;
                }
            } catch (e) { /* continue polling */ }
        }

        if (confirmed) {
            showToast(`${playableState.credits} playable credits available!`, 'success');
            updatePlayableCreditsUI();
        } else {
            showToast('Payment received but confirmation pending. Credits will appear shortly.', 'warning');
            setTimeout(async () => {
                try {
                    const result = await apiGet('/api/marketing/playable-content/credits');
                    playableState.credits = result.credits;
                    updatePlayableCreditsUI();
                } catch {}
            }, 5000);
        }
    } catch (error) {
        showToast(error.message || 'Payment failed. Please try again.', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = originalHtml; }
    }
}

// ============================================
// BRAND STORY TAB
// ============================================

let brandStoryState = {
    stories: [],
    currentStoryId: null,
    currentStoryEpisodes: [],  // Cached episode array for the open story; used to
                               // detect when a newly-generated episode has landed.
    currentStoryPersonas: [],
    brandKitPersonas: null,
    wizardStep: 1,
    stockAvatars: [],
    storyFocus: 'person',  // 'person' | 'product' | 'landscape' — selected at Step 1
    voices: [],            // All HeyGen voices (loaded once per wizard open)
    selectedVoiceId: ''    // Optional override; empty = auto-match
};

// All non-terminal episode statuses, across v2/v3/V4 pipelines. Single source
// of truth — every "is this episode mid-pipeline?" check must read from here
// to prevent the lists from drifting apart as new pipeline stages ship.
const IN_PROGRESS_EPISODE_STATUSES = new Set([
    'pending',
    // v2/v3 pipeline
    'writing_script', 'generating_narration', 'generating_scene',
    'generating_storyboard', 'generating_avatar', 'generating_video',
    'compositing', 'post_production', 'publishing',
    // V4 pipeline
    'brand_safety_check', 'generating_scene_masters', 'generating_beats',
    'assembling', 'applying_lut'
]);

const isEpisodeInProgress = (ep) => IN_PROGRESS_EPISODE_STATUSES.has(ep?.status);

/**
 * Single source of truth for the "Generating..." spinner + Generate-Episode
 * button disabled state. Calling sites just say "polling is active / not
 * active" and this function keeps both DOM bits in sync, so the spinner
 * cannot drift out of step with the actual pipeline state — even across
 * full-detail re-renders that happen during a long V4 run.
 */
function setEpisodeGeneratingIndicator(visible) {
    const btn = document.getElementById('generateEpisodeBtn');
    const statusEl = document.getElementById('episodeGeneratingStatus');
    if (btn) btn.disabled = !!visible;
    if (statusEl) statusEl.classList.toggle('hidden', !visible);
}

/**
 * Load and display all brand stories for the current user.
 */
async function loadBrandStories() {
    const listEl = document.getElementById('brandStoryList');
    const emptyEl = document.getElementById('brandStoryEmpty');
    const wizardEl = document.getElementById('brandStoryWizard');
    const detailEl = document.getElementById('brandStoryDetail');

    // Hide wizard and detail views
    if (wizardEl) wizardEl.classList.add('hidden');
    if (detailEl) detailEl.classList.add('hidden');
    if (listEl) listEl.classList.remove('hidden');

    try {
        const result = await apiGet('/api/brand-stories');
        brandStoryState.stories = result.stories || [];

        if (brandStoryState.stories.length === 0) {
            if (listEl) listEl.classList.add('hidden');
            if (emptyEl) emptyEl.classList.remove('hidden');
            return;
        }

        if (emptyEl) emptyEl.classList.add('hidden');
        if (listEl) {
            listEl.innerHTML = brandStoryState.stories.map(story => renderStoryCard(story)).join('');
            listEl.classList.remove('hidden');
        }
    } catch (error) {
        console.error('Error loading brand stories:', error);
        if (listEl) listEl.innerHTML = '<p class="text-red-500 text-center py-4">Failed to load brand stories.</p>';
    }
}

/**
 * Render a story card for the list view.
 */
function renderStoryCard(story) {
    const statusColors = {
        draft: 'bg-surface-100 text-ink-500',
        active: 'bg-green-100 text-green-700',
        paused: 'bg-yellow-100 text-yellow-700',
        completed: 'bg-blue-100 text-blue-700'
    };
    const statusClass = statusColors[story.status] || statusColors.draft;

    const platforms = (story.target_platforms || []).map(p =>
        `<span class="text-xs bg-surface-100 text-ink-500 px-2 py-0.5 rounded">${escapeHtml(p)}</span>`
    ).join(' ');

    return `
        <div class="card-gradient p-5 hover:shadow-md transition-shadow relative group">
            <div class="flex items-start justify-between cursor-pointer" onclick="showStoryDetail('${story.id}')">
                <div class="flex-1 min-w-0 pr-10">
                    <div class="flex items-center gap-2 mb-1">
                        <h4 class="text-lg font-semibold text-ink-800 truncate">${escapeHtml(story.name)}</h4>
                        <span class="px-2.5 py-0.5 text-xs font-medium rounded-full ${statusClass}">${story.status}</span>
                    </div>
                    <p class="text-sm text-ink-500 mb-2">${story.storyline?.logline || story.storyline?.theme || 'Storyline not generated yet'}</p>
                    <div class="flex items-center gap-3 text-xs text-ink-400">
                        <span>${story.total_episodes || 0} episodes</span>
                        <span>${(story.publish_frequency || 'daily').replace(/_/g, ' ')}</span>
                        ${platforms}
                    </div>
                </div>
                <svg class="w-5 h-5 text-ink-300 flex-shrink-0 ml-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path>
                </svg>
            </div>
            <button onclick="event.stopPropagation(); deleteBrandStory('${story.id}', '${escapeHtml(story.name).replace(/'/g, '&#39;')}')"
                    class="absolute top-3 right-3 p-1.5 text-ink-300 hover:text-red-500 hover:bg-red-50 rounded-md transition-colors opacity-0 group-hover:opacity-100"
                    title="Delete story">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                </svg>
            </button>
        </div>
    `;
}

/**
 * Delete the currently-viewed story from the detail view.
 */
async function deleteCurrentStory() {
    const storyId = brandStoryState.currentStoryId;
    if (!storyId) return;
    const story = (brandStoryState.stories || []).find(s => s.id === storyId);
    const name = story?.name || 'this story';
    return deleteBrandStory(storyId, name);
}

/**
 * Delete a brand story with confirmation.
 */
async function deleteBrandStory(storyId, storyName) {
    if (!confirm(`Delete brand story "${storyName}"? This will also delete all episodes. This cannot be undone.`)) {
        return;
    }

    try {
        const result = await apiDelete(`/api/brand-stories/${storyId}`);
        if (!result.success) throw new Error(result.error || 'Delete failed');

        showToast('Story deleted', 'success');

        // If we're viewing this story's detail, go back to list
        if (brandStoryState.currentStoryId === storyId) {
            backToStoryList();
        } else {
            loadBrandStories();
        }
    } catch (error) {
        showToast(error.message || 'Failed to delete story', 'error');
    }
}

/**
 * Show the 5-step story creation wizard (Focus → Persona → Subject → Settings → Review).
 */
function showCreateStoryWizard() {
    document.getElementById('brandStoryList')?.classList.add('hidden');
    document.getElementById('brandStoryEmpty')?.classList.add('hidden');
    document.getElementById('brandStoryDetail')?.classList.add('hidden');
    document.getElementById('brandStoryWizard')?.classList.remove('hidden');

    brandStoryState.wizardStep = 1;
    brandStoryState.storyFocus = 'person';
    wizardShowStep(1);

    // Load Brand Kit models for Settings step
    loadBrandKitOptionsForWizard();

    // Set up focus radio listeners — changes filter the Persona step's allowed persona_types
    document.querySelectorAll('input[name="storyFocus"]').forEach(radio => {
        radio.addEventListener('change', () => {
            brandStoryState.storyFocus = radio.value;
            applyFocusToPersonaStep(radio.value);
        });
    });
    // Force-check the default "person" radio and apply its rules
    const personRadio = document.querySelector('input[name="storyFocus"][value="person"]');
    if (personRadio) personRadio.checked = true;

    // Set up persona type radio listeners
    document.querySelectorAll('input[name="personaType"]').forEach(radio => {
        radio.addEventListener('change', () => updatePersonaFields(radio.value));
    });

    // Reset persona selection state + apply initial focus filter (defaults to person)
    resetPersonaSelectionState();
    applyFocusToPersonaStep('person');

    // Set up subject upload handlers
    setupSubjectUploadHandlers();

    // Reset subject state
    subjectState = { source: 'upload', uploadFiles: [], selectedBrandKitAssets: [], brandKitAssets: [] };
    document.getElementById('subjectAnalyzedJson').value = '';
    document.getElementById('subjectAnalysisResult')?.classList.add('hidden');
    document.getElementById('subjectNextBtn')?.setAttribute('disabled', 'disabled');
}

/**
 * Apply focus rules to the Persona step: hide/show persona_type radio options
 * and the Auto-Assign button based on what's allowed for the chosen story focus.
 *
 * Focus → allowed persona_types:
 *   person    → uploaded, brand_kit
 *   product   → selected
 *   landscape → selected
 */
function applyFocusToPersonaStep(focus) {
    // V3 cinematic pipeline: all persona types available for all focuses.
    // HeyGen stock ('selected') is kept for v1/v2 backward compat but deprioritized.
    const pipelineVersion = (typeof process !== 'undefined' && process.env?.BRAND_STORY_PIPELINE) || 'v2';
    const allowedByFocus = pipelineVersion === 'v1'
        ? { person: ['uploaded', 'brand_kit'], product: ['selected'], landscape: ['selected'] }
        : {
            // V3: all options available for all focuses. HeyGen 'selected' removed.
            person:    ['described', 'uploaded', 'brand_kit', 'brand_kit_auto'],
            product:   ['brand_kit_auto', 'described', 'uploaded', 'brand_kit'],
            landscape: ['brand_kit_auto', 'described', 'uploaded', 'brand_kit']
        };
    const allowed = allowedByFocus[focus] || ['described'];

    // Hide/show each persona_type radio's parent <label>
    document.querySelectorAll('input[name="personaType"]').forEach(radio => {
        const label = radio.closest('label');
        if (!label) return;
        const isAllowed = allowed.includes(radio.value);
        label.classList.toggle('hidden', !isAllowed);
        if (!isAllowed) radio.checked = false;
    });

    // Auto-select the first allowed persona_type and render its panel
    const firstAllowedRadio = document.querySelector(
        `input[name="personaType"][value="${allowed[0]}"]`
    );
    if (firstAllowedRadio) {
        firstAllowedRadio.checked = true;
        updatePersonaFields(firstAllowedRadio.value);
    }

    // Toggle Auto-Assign button — only for HeyGen stock selection path
    const autoBtn = document.getElementById('autoAssignAvatarBtn');
    const autoHint = document.getElementById('autoAssignAvatarHint');
    const showAutoAssign = false; // Deprecated in v3 — HeyGen auto-assign no longer primary
    if (autoBtn) autoBtn.classList.toggle('hidden', !showAutoAssign);
    if (autoHint) autoHint.classList.toggle('hidden', !showAutoAssign);

    // NOTE: do NOT reset persona state here. The wizard intentionally keeps
    // generated personas when the user navigates back-and-forth or toggles
    // the Focus radio. All persona_types (described/uploaded/brand_kit/
    // brand_kit_auto) are allowed for all 3 focuses, so there is no stale-
    // data risk to defend against. A blanket reset here caused the
    // "Please generate a persona first" error on Submit when the user:
    //   1. Picked a focus, generated a Brand Kit Auto persona
    //   2. Went back to Step 1 to double-check something
    //   3. Came forward again — the focus-radio change event fired and
    //      wiped personaSelectionState.brand_kit_auto
    // State is still correctly reset on wizard OPEN at showCreateStoryWizard().
    // Caught 2026-04-12.

    // Lazy-load HeyGen voices into the voice picker (first time the Persona step is shown)
    loadVoices();
}

/**
 * Call the backend to auto-pick a stock avatar best fitting the story focus + subject.
 * Populates personaSelectionState.selected[0] so the user can proceed without manual browsing.
 */
async function autoAssignBestFitCharacter() {
    const btn = document.getElementById('autoAssignAvatarBtn');
    const txt = document.getElementById('autoAssignAvatarBtnText');
    if (btn) btn.disabled = true;
    if (txt) txt.textContent = 'Auto-picking...';

    try {
        // Pull subject hint from previously analyzed subject (if available)
        let subjectHint = '';
        try {
            const analyzed = document.getElementById('subjectAnalyzedJson')?.value;
            if (analyzed) {
                const s = JSON.parse(analyzed);
                subjectHint = s.category || s.name || '';
            }
        } catch (e) { /* ignore */ }

        const params = new URLSearchParams({
            focus: brandStoryState.storyFocus,
            subject_hint: subjectHint
        });
        const result = await apiGet(`/api/brand-stories/avatars/auto-pick?${params.toString()}`);
        if (!result.success || !result.avatar) {
            throw new Error(result.error || 'No avatar returned');
        }

        // Ensure stock avatars are loaded (so the grid renders a checkmark on the chosen one)
        if (brandStoryState.stockAvatars.length === 0) {
            await loadStockAvatars();
        }

        // Populate personaSelectionState.selected[0] with the auto-picked avatar
        personaSelectionState.selected = [{
            heygen_avatar_id: result.avatar.avatarId,
            avatar_name: result.avatar.name
        }];
        renderStockAvatarGrid();

        showToast(`Auto-selected: ${result.avatar.name}`, 'success');
    } catch (err) {
        showToast(err.message || 'Auto-pick failed', 'error');
    } finally {
        if (btn) btn.disabled = false;
        if (txt) txt.textContent = 'Auto Assign Best Fit Character';
    }
}

/**
 * Update visible persona fields based on selected type.
 */
function updatePersonaFields(type) {
    document.getElementById('personaDescribeFields')?.classList.toggle('hidden', type !== 'described');
    document.getElementById('personaSelectFields')?.classList.toggle('hidden', type !== 'selected');
    document.getElementById('personaUploadFields')?.classList.toggle('hidden', type !== 'uploaded');
    document.getElementById('personaBrandKitFields')?.classList.toggle('hidden', type !== 'brand_kit');
    document.getElementById('personaBrandKitAutoFields')?.classList.toggle('hidden', type !== 'brand_kit_auto');

    if (type === 'described') {
        renderDescribedPersonas();
    } else if (type === 'selected') {
        if (brandStoryState.stockAvatars.length === 0) loadStockAvatars();
        else renderStockAvatarGrid();
    } else if (type === 'uploaded') {
        renderUploadedPersonas();
    } else if (type === 'brand_kit') {
        if (!brandStoryState.brandKitPersonas) loadBrandKitPersonas();
        else renderBrandKitPersonaGrid();
    } else if (type === 'brand_kit_auto') {
        loadBrandKitOptionsForAutoPersona();
    }
}

/**
 * Load person cutouts extracted from the user's Brand Kits.
 */
// ─────────────────────────────────────────────────────
// MULTI-PERSONA SUPPORT (up to MAX_PERSONAS personas per story — currently 4)
// ─────────────────────────────────────────────────────

// Selection state for each persona type
let personaSelectionState = {
    described: [],        // [{ description, personality }]
    selected: [],         // [{ heygen_avatar_id, avatar_name }]  (HeyGen avatars)
    uploaded: [],         // [{ reference_image_urls: [File] }]   (File objects, keeping them as Files for now)
    brand_kit: [],        // [{ cutout_url, description, brand_kit_job_id }]
    brand_kit_auto: []    // [{ description, personality, appearance, reference_image_urls }]
};

/**
 * Load brand kit options into the auto-generate persona selector.
 */
async function loadBrandKitOptionsForAutoPersona() {
    const select = document.getElementById('brandKitAutoSelect');
    if (!select) return;

    try {
        const result = await apiGet('/api/brand-stories/brand-kits');
        const kits = result.brandKits || [];
        select.textContent = '';
        if (kits.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = 'No Brand Kits available — create one first';
            select.appendChild(opt);
            return;
        }
        kits.forEach(kit => {
            const opt = document.createElement('option');
            opt.value = kit.id;
            opt.textContent = kit.name || kit.brand_summary?.slice(0, 50) || 'Brand Kit ' + kit.id.slice(0, 6);
            select.appendChild(opt);
        });
    } catch (e) {
        console.error('Failed to load brand kits for auto persona:', e);
    }
}

/**
 * Generate persona(s) from Brand Kit context via backend.
 * Calls the new /api/brand-stories/personas/auto-generate endpoint.
 */
async function generateBrandKitAutoPersona() {
    const btn = document.getElementById('brandKitAutoGenerateBtn');
    const btnText = document.getElementById('brandKitAutoGenerateBtnText');
    const brandKitId = document.getElementById('brandKitAutoSelect')?.value;
    const count = parseInt(document.querySelector('input[name="brandKitAutoCount"]:checked')?.value || '1', 10);

    if (!brandKitId) {
        showToast('Please select a Brand Kit first', 'error');
        return;
    }

    if (btn) btn.disabled = true;
    if (btnText) btnText.textContent = 'Generating persona...';

    try {
        const result = await apiPost('/api/brand-stories/personas/auto-generate', {
            brand_kit_job_id: brandKitId,
            count,
            story_focus: document.querySelector('input[name="storyFocus"]:checked')?.value || 'product'
        });

        if (!result.success) throw new Error(result.error || 'Failed to generate persona');

        const personas = result.personas || [];
        personaSelectionState.brand_kit_auto = personas;

        // Show result cards
        const resultEl = document.getElementById('brandKitAutoResult');
        const cardsEl = document.getElementById('brandKitAutoPersonaCards');
        if (resultEl) resultEl.classList.remove('hidden');
        if (cardsEl) {
            cardsEl.textContent = '';
            personas.forEach((p, i) => {
                const card = document.createElement('div');
                card.className = 'p-3 bg-surface-50 rounded-lg border border-surface-200 flex gap-3';

                // Show all character sheet views (hero, close-up, side profile)
                if (Array.isArray(p.reference_image_urls) && p.reference_image_urls.length > 0) {
                    const imgStrip = document.createElement('div');
                    imgStrip.className = 'flex gap-1.5 flex-shrink-0';
                    const viewLabels = ['Hero', 'Close-up', 'Side'];
                    p.reference_image_urls.forEach((url, vi) => {
                        const imgWrap = document.createElement('div');
                        imgWrap.className = 'text-center';
                        const img = document.createElement('img');
                        img.src = url;
                        img.alt = (viewLabels[vi] || 'View ' + (vi + 1));
                        img.className = 'w-14 h-20 object-cover rounded-lg border border-surface-200 cursor-pointer hover:border-brand-400';
                        img.onclick = () => window.open(url, '_blank');
                        imgWrap.appendChild(img);
                        const label = document.createElement('span');
                        label.className = 'block text-[9px] text-ink-400 mt-0.5';
                        label.textContent = viewLabels[vi] || '';
                        imgWrap.appendChild(label);
                        imgStrip.appendChild(imgWrap);
                    });
                    card.appendChild(imgStrip);
                }

                const info = document.createElement('div');
                info.className = 'flex-1 min-w-0';

                const nameEl = document.createElement('p');
                nameEl.className = 'font-medium text-sm text-ink-800';
                nameEl.textContent = p.name || 'Persona ' + (i + 1);
                info.appendChild(nameEl);

                if (p.appearance) {
                    const appEl = document.createElement('p');
                    appEl.className = 'text-xs text-ink-600 mt-0.5';
                    appEl.textContent = p.appearance;
                    info.appendChild(appEl);
                }
                if (p.personality) {
                    const persEl = document.createElement('p');
                    persEl.className = 'text-xs text-ink-500 mt-0.5 italic';
                    persEl.textContent = p.personality;
                    info.appendChild(persEl);
                }

                card.appendChild(info);
                cardsEl.appendChild(card);
            });
        }

        showToast(`${personas.length} persona(s) generated from Brand Kit!`, 'success');
    } catch (e) {
        showToast(e.message || 'Persona generation failed', 'error');
        console.error('Auto persona generation error:', e);
    } finally {
        if (btn) btn.disabled = false;
        if (btnText) btnText.textContent = 'Generate Persona';
    }
}

// Cast Bible Phase 5a (2026-04-28) — bumped 3 → 4 to enable ensemble pairings
// (protag + antag + foil + mentor). Backend audit (cast-bible-n-audit-report.md)
// confirmed all downstream code paths are N-aware. Bumps beyond 4 require
// re-auditing voice library size + Kling element packing.
const MAX_PERSONAS = 4;

// ═══ DESCRIBED TYPE ═══

/**
 * Render the list of described persona cards.
 */
function renderDescribedPersonas() {
    const list = document.getElementById('describedPersonaList');
    const countEl = document.getElementById('describedPersonaCount');
    const addBtn = document.getElementById('addDescribedBtn');
    if (!list) return;

    if (personaSelectionState.described.length === 0) {
        // Start with one empty persona
        personaSelectionState.described.push({ description: '', personality: '' });
    }

    list.innerHTML = personaSelectionState.described.map((p, i) => `
        <div class="p-4 border border-surface-200 rounded-lg bg-surface-50 space-y-3">
            <div class="flex items-center justify-between">
                <h5 class="text-sm font-semibold text-ink-700">Persona ${i + 1}${i === 0 ? ' <span class="text-xs font-normal text-brand-600">(Primary Narrator)</span>' : ''}</h5>
                ${i > 0 ? `<button type="button" onclick="removeDescribedPersona(${i})" class="text-xs text-red-500 hover:text-red-600">Remove</button>` : ''}
            </div>
            <div>
                <label class="block text-xs font-medium text-ink-600 mb-1">Description</label>
                <textarea oninput="updateDescribedPersona(${i}, 'description', this.value)" rows="2" class="w-full rounded-lg border border-surface-300 bg-white text-ink-800 py-2 px-3 text-sm focus:ring-2 focus:ring-brand-500" placeholder="A confident woman in her 30s with warm brown eyes...">${escapeHtml(p.description || '')}</textarea>
            </div>
            <div>
                <label class="block text-xs font-medium text-ink-600 mb-1">Personality / Voice Style</label>
                <input type="text" oninput="updateDescribedPersona(${i}, 'personality', this.value)" value="${escapeHtml(p.personality || '')}" class="w-full rounded-lg border border-surface-300 bg-white text-ink-800 py-2 px-3 text-sm focus:ring-2 focus:ring-brand-500" placeholder="Charismatic, warm, knowledgeable">
            </div>
        </div>
    `).join('');

    if (countEl) countEl.textContent = personaSelectionState.described.length;
    if (addBtn) addBtn.disabled = personaSelectionState.described.length >= MAX_PERSONAS;
}

function addDescribedPersona() {
    if (personaSelectionState.described.length >= MAX_PERSONAS) return;
    personaSelectionState.described.push({ description: '', personality: '' });
    renderDescribedPersonas();
}

function removeDescribedPersona(i) {
    personaSelectionState.described.splice(i, 1);
    if (personaSelectionState.described.length === 0) {
        personaSelectionState.described.push({ description: '', personality: '' });
    }
    renderDescribedPersonas();
}

function updateDescribedPersona(i, field, value) {
    if (personaSelectionState.described[i]) {
        personaSelectionState.described[i][field] = value;
    }
}

// ═══ SELECTED (HeyGen stock) TYPE ═══

async function loadStockAvatars() {
    const grid = document.getElementById('stockAvatarGrid');
    if (!grid) return;

    try {
        const result = await apiGet('/api/brand-stories/avatars/stock');
        brandStoryState.stockAvatars = result.avatars || [];

        if (brandStoryState.stockAvatars.length === 0) {
            grid.innerHTML = '<p class="col-span-full text-center text-ink-400 py-4">No stock avatars available. Configure HEYGEN_API_KEY.</p>';
            return;
        }

        renderStockAvatarGrid();
    } catch (error) {
        grid.innerHTML = '<p class="col-span-full text-center text-red-500 py-4">Failed to load avatars</p>';
    }
}

/**
 * Load HeyGen voices into the voice picker dropdown.
 * Called lazily when the Persona step is shown.
 */
async function loadVoices() {
    if (brandStoryState.voices.length > 0) {
        _renderVoiceOptions(brandStoryState.voices);
        return;
    }
    try {
        const result = await apiGet('/api/brand-stories/voices?language=en');
        brandStoryState.voices = result.voices || [];
        _renderVoiceOptions(brandStoryState.voices);
    } catch (err) {
        console.error('Failed to load voices:', err);
    }
}

/**
 * Populate the voice <select> with filtered options.
 */
function _renderVoiceOptions(voices) {
    const sel = document.getElementById('personaVoiceSelect');
    if (!sel) return;
    const currentValue = sel.value;
    const opts = ['<option value="">Auto (match avatar)</option>'];
    for (const v of voices) {
        const gender = v.gender ? ` (${v.gender})` : '';
        opts.push(`<option value="${escapeHtml(v.voice_id)}">${escapeHtml(v.name || 'Voice')}${gender}</option>`);
    }
    sel.innerHTML = opts.join('');
    // Preserve selection if still valid
    if (currentValue && voices.some(v => v.voice_id === currentValue)) {
        sel.value = currentValue;
    }
    onVoiceSelectChange();
}

/**
 * Filter voices by gender (radio onChange handler).
 */
function filterVoicesByGender(gender) {
    const filtered = !gender
        ? brandStoryState.voices
        : brandStoryState.voices.filter(v => (v.gender || '').toLowerCase() === gender.toLowerCase());
    _renderVoiceOptions(filtered);
}

/**
 * Called when user picks a voice — updates state + preview button.
 */
function onVoiceSelectChange() {
    const sel = document.getElementById('personaVoiceSelect');
    const btn = document.getElementById('voicePreviewBtn');
    if (!sel) return;
    brandStoryState.selectedVoiceId = sel.value || '';
    if (btn) btn.disabled = !brandStoryState.selectedVoiceId;
}

/**
 * Play the selected voice's preview audio sample.
 */
function previewSelectedVoice() {
    const sel = document.getElementById('personaVoiceSelect');
    const audio = document.getElementById('voicePreviewAudio');
    if (!sel || !audio || !sel.value) return;
    const voice = brandStoryState.voices.find(v => v.voice_id === sel.value);
    if (!voice?.preview_audio) {
        showToast('No preview available for this voice', 'warning');
        return;
    }
    audio.src = voice.preview_audio;
    audio.play().catch(err => {
        console.error('Voice preview playback failed:', err);
        showToast('Failed to play voice preview', 'error');
    });
}

function renderStockAvatarGrid() {
    const grid = document.getElementById('stockAvatarGrid');
    if (!grid) return;

    grid.innerHTML = brandStoryState.stockAvatars.map(avatar => {
        const selectedIdx = personaSelectionState.selected.findIndex(s => s.heygen_avatar_id === avatar.avatarId);
        const isSelected = selectedIdx >= 0;
        return `
            <div class="border rounded-lg p-2 cursor-pointer transition-colors text-center relative ${isSelected ? 'border-brand-500 bg-brand-50' : 'border-surface-200 hover:border-brand-400'}"
                 onclick="toggleStockAvatar(this, '${avatar.avatarId}', '${escapeHtml(avatar.name)}')">
                ${avatar.previewUrl ? `<img src="${avatar.previewUrl}" alt="${escapeHtml(avatar.name)}" class="w-full aspect-square object-cover rounded mb-1">` : '<div class="w-full aspect-square bg-surface-100 rounded mb-1 flex items-center justify-center text-ink-300 text-2xl">?</div>'}
                <p class="text-xs text-ink-600 truncate">${escapeHtml(avatar.name)}</p>
                ${isSelected ? `<div class="absolute top-1 left-1 w-5 h-5 rounded-full bg-brand-600 text-white flex items-center justify-center text-xs font-bold">${selectedIdx + 1}</div>` : ''}
            </div>
        `;
    }).join('');

    const countEl = document.getElementById('selectedAvatarCount');
    if (countEl) countEl.textContent = personaSelectionState.selected.length;
    document.getElementById('selectedAvatarsJson').value = JSON.stringify(personaSelectionState.selected);
}

function toggleStockAvatar(el, avatarId, name) {
    const idx = personaSelectionState.selected.findIndex(s => s.heygen_avatar_id === avatarId);

    if (idx >= 0) {
        personaSelectionState.selected.splice(idx, 1);
    } else {
        if (personaSelectionState.selected.length >= MAX_PERSONAS) {
            showToast('Maximum 3 avatars allowed', 'warning');
            return;
        }
        personaSelectionState.selected.push({ heygen_avatar_id: avatarId, avatar_name: name });
    }

    renderStockAvatarGrid();
}

// ═══ UPLOADED TYPE ═══

function renderUploadedPersonas() {
    const list = document.getElementById('uploadedPersonaList');
    const countEl = document.getElementById('uploadedPersonaCount');
    const addBtn = document.getElementById('addUploadedBtn');
    if (!list) return;

    if (personaSelectionState.uploaded.length === 0) {
        personaSelectionState.uploaded.push({ reference_image_files: [] });
    }

    list.innerHTML = personaSelectionState.uploaded.map((p, i) => {
        const files = p.reference_image_files || [];
        return `
            <div class="p-4 border border-surface-200 rounded-lg bg-surface-50 space-y-3">
                <div class="flex items-center justify-between">
                    <h5 class="text-sm font-semibold text-ink-700">Person ${i + 1}${i === 0 ? ' <span class="text-xs font-normal text-brand-600">(Primary Narrator)</span>' : ''}</h5>
                    ${i > 0 ? `<button type="button" onclick="removeUploadedPersona(${i})" class="text-xs text-red-500 hover:text-red-600">Remove</button>` : ''}
                </div>
                <div class="border-2 border-dashed border-surface-300 rounded-lg p-4 text-center hover:border-brand-400 transition-colors cursor-pointer" onclick="document.getElementById('uploadedFileInput${i}').click()">
                    <p class="text-ink-500 text-xs">Drop or click: 1+ clear face photo (only the first is used for the talking avatar)</p>
                    <input type="file" id="uploadedFileInput${i}" multiple accept="image/jpeg,image/png" class="hidden" onchange="handleUploadedFiles(${i}, this.files)">
                </div>
                ${files.length > 0 ? `
                    <div class="grid grid-cols-5 gap-2">
                        ${files.map((f, fi) => `
                            <div class="relative aspect-square">
                                <img src="${URL.createObjectURL(f)}" class="w-full h-full object-cover rounded border border-surface-200">
                                <button onclick="removeUploadedFile(${i}, ${fi})" class="absolute top-0.5 right-0.5 w-4 h-4 bg-red-500 text-white rounded-full flex items-center justify-center text-[10px]">\u00d7</button>
                            </div>
                        `).join('')}
                    </div>
                ` : ''}
            </div>
        `;
    }).join('');

    if (countEl) countEl.textContent = personaSelectionState.uploaded.length;
    if (addBtn) addBtn.disabled = personaSelectionState.uploaded.length >= MAX_PERSONAS;
}

function addUploadedPersona() {
    if (personaSelectionState.uploaded.length >= MAX_PERSONAS) return;
    personaSelectionState.uploaded.push({ reference_image_files: [] });
    renderUploadedPersonas();
}

function removeUploadedPersona(i) {
    personaSelectionState.uploaded.splice(i, 1);
    if (personaSelectionState.uploaded.length === 0) {
        personaSelectionState.uploaded.push({ reference_image_files: [] });
    }
    renderUploadedPersonas();
}

function handleUploadedFiles(personaIdx, fileList) {
    const files = [...fileList].filter(f => f.type.startsWith('image/')).slice(0, 15);
    if (personaSelectionState.uploaded[personaIdx]) {
        personaSelectionState.uploaded[personaIdx].reference_image_files = files;
        renderUploadedPersonas();
    }
}

function removeUploadedFile(personaIdx, fileIdx) {
    const p = personaSelectionState.uploaded[personaIdx];
    if (p?.reference_image_files) {
        p.reference_image_files.splice(fileIdx, 1);
        renderUploadedPersonas();
    }
}

// ═══ BRAND KIT TYPE ═══

async function loadBrandKitPersonas() {
    const grid = document.getElementById('brandKitPersonaGrid');
    if (!grid) return;

    try {
        const result = await apiGet('/api/brand-stories/personas/brand-kit');
        const personas = result.personas || [];
        brandStoryState.brandKitPersonas = personas;

        if (personas.length === 0) {
            grid.innerHTML = `
                <div class="col-span-full text-center py-6">
                    <p class="text-ink-500 text-sm mb-2">No person cutouts found in your Brand Kits.</p>
                    <p class="text-ink-400 text-xs">Train a model in Brand Asset Gen. tab, then run Brand Kit analysis to extract person cutouts.</p>
                </div>
            `;
            return;
        }

        renderBrandKitPersonaGrid();
    } catch (error) {
        console.error('Error loading Brand Kit personas:', error);
        grid.innerHTML = '<p class="col-span-full text-center text-red-500 py-4">Failed to load Brand Kit personas</p>';
    }
}

function renderBrandKitPersonaGrid() {
    const grid = document.getElementById('brandKitPersonaGrid');
    if (!grid || !brandStoryState.brandKitPersonas) return;

    grid.innerHTML = brandStoryState.brandKitPersonas.map(persona => {
        const selectedIdx = personaSelectionState.brand_kit.findIndex(s => s.cutout_url === persona.url);
        const isSelected = selectedIdx >= 0;
        return `
            <div class="border rounded-lg p-2 cursor-pointer transition-colors relative ${isSelected ? 'border-brand-500 bg-brand-50' : 'border-surface-200 hover:border-brand-400'}"
                 onclick="toggleBrandKitPersona(this, '${escapeHtml(persona.url)}', '${escapeHtml(persona.description)}', '${escapeHtml(persona.brand_kit_job_id)}')">
                <img src="${escapeHtml(persona.url)}" alt="${escapeHtml(persona.description)}" class="w-full aspect-square object-cover rounded mb-2 bg-surface-100">
                <p class="text-xs font-medium text-ink-700 truncate">${escapeHtml(persona.description.slice(0, 40))}</p>
                <p class="text-xs text-ink-400 truncate">${escapeHtml(persona.brand_kit_name)}</p>
                ${isSelected ? `<div class="absolute top-1 left-1 w-5 h-5 rounded-full bg-brand-600 text-white flex items-center justify-center text-xs font-bold">${selectedIdx + 1}</div>` : ''}
            </div>
        `;
    }).join('');

    const countEl = document.getElementById('selectedBrandKitCount');
    if (countEl) countEl.textContent = personaSelectionState.brand_kit.length;
    document.getElementById('selectedBrandKitPersonasJson').value = JSON.stringify(personaSelectionState.brand_kit);
}

function toggleBrandKitPersona(el, url, description, brandKitJobId) {
    const idx = personaSelectionState.brand_kit.findIndex(s => s.cutout_url === url);

    if (idx >= 0) {
        personaSelectionState.brand_kit.splice(idx, 1);
    } else {
        if (personaSelectionState.brand_kit.length >= MAX_PERSONAS) {
            showToast(`Maximum ${MAX_PERSONAS} personas allowed`, 'warning');
            return;
        }
        personaSelectionState.brand_kit.push({ cutout_url: url, description, brand_kit_job_id: brandKitJobId });
    }

    renderBrandKitPersonaGrid();
}

// ═══ STATE RESET (called when wizard opens) ═══

function resetPersonaSelectionState() {
    personaSelectionState = {
        described: [],
        selected: [],
        uploaded: [],
        brand_kit: [],
        brand_kit_auto: []
    };
    renderDescribedPersonas();
    // Reset auto-generate UI if present
    const autoResult = document.getElementById('brandKitAutoResult');
    if (autoResult) autoResult.classList.add('hidden');
    const autoCards = document.getElementById('brandKitAutoPersonaCards');
    if (autoCards) autoCards.textContent = '';
}

// ─────────────────────────────────────────────────────
// DIRECTOR'S HINTS AUTO-GENERATION
// ─────────────────────────────────────────────────────

let directorsHintCount = 0;
const MAX_DIRECTORS_HINTS = 5;

/**
 * Generate a director's hint using AI, leveraging all available context
 * from the wizard (focus, genre, tone, audience, brand kit, subject, personas).
 * Each click generates a different creative angle (up to 5 total).
 */
async function generateDirectorsHint() {
    if (directorsHintCount >= MAX_DIRECTORS_HINTS) return;

    const btn = document.getElementById('directorsHintBtn');
    const btnText = document.getElementById('directorsHintBtnText');
    const counter = document.getElementById('directorsHintCounter');
    const cardsContainer = document.getElementById('directorsHintCards');

    if (btn) btn.disabled = true;
    if (btnText) btnText.textContent = 'Generating...';

    try {
        // Collect all available context from the wizard
        const storyFocus = document.querySelector('input[name="storyFocus"]:checked')?.value || 'product';
        const genre = document.getElementById('storyGenre')?.value || 'drama';
        const tone = document.getElementById('storyTone')?.value || 'engaging';
        const targetAudience = document.getElementById('storyAudience')?.value || 'young professionals';
        const brandKitJobId = document.getElementById('storyBrandKit')?.value || null;

        // Subject data from Step 3
        let subject = null;
        try {
            const subjectJson = document.getElementById('subjectAnalyzedJson')?.value;
            if (subjectJson) subject = JSON.parse(subjectJson);
        } catch (e) { /* no subject yet */ }

        // Persona descriptions from Step 2
        const personaType = document.querySelector('input[name="personaType"]:checked')?.value || 'described';
        const personas = (personaSelectionState[personaType] || [])
            .map(p => p.description || p.avatar_name || p.appearance || '')
            .filter(Boolean);

        const result = await apiPost('/api/brand-stories/generate-directors-hint', {
            story_focus: storyFocus,
            genre,
            tone,
            target_audience: targetAudience,
            brand_kit_job_id: brandKitJobId,
            subject,
            personas,
            variation: directorsHintCount + 1
        });

        if (!result.success) throw new Error(result.error || 'Failed to generate hint');

        directorsHintCount++;
        if (counter) counter.textContent = `${directorsHintCount}/${MAX_DIRECTORS_HINTS}`;

        // Show cards container
        if (cardsContainer) cardsContainer.classList.remove('hidden');

        // Create hint card
        const card = document.createElement('label');
        card.className = 'flex items-start gap-3 p-3 border border-surface-200 rounded-lg cursor-pointer hover:border-brand-300 transition-colors has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50';

        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'directorsHintChoice';
        radio.value = directorsHintCount;
        radio.className = 'mt-1 text-brand-600 focus:ring-brand-500';
        radio.checked = true; // auto-select latest
        radio.addEventListener('change', () => {
            document.getElementById('storyDirectorsNotes').value = result.hint;
        });

        const textDiv = document.createElement('div');
        textDiv.className = 'flex-1';

        const badge = document.createElement('span');
        badge.className = 'text-[10px] text-ink-400 uppercase tracking-wider';
        badge.textContent = ['Cinematography', 'Emotion & Pacing', 'Film References', 'Sensory & Atmosphere', 'Wildcard'][directorsHintCount - 1] || 'Variation';

        const text = document.createElement('p');
        text.className = 'text-sm text-ink-700 mt-0.5';
        text.textContent = result.hint;

        textDiv.appendChild(badge);
        textDiv.appendChild(text);
        card.appendChild(radio);
        card.appendChild(textDiv);
        cardsContainer.appendChild(card);

        // Auto-populate textarea with this hint
        document.getElementById('storyDirectorsNotes').value = result.hint;

        if (directorsHintCount >= MAX_DIRECTORS_HINTS) {
            if (btn) btn.disabled = true;
            if (btnText) btnText.textContent = 'Max hints reached';
            return;
        }

    } catch (e) {
        showToast(e.message || 'Failed to generate hint', 'error');
    } finally {
        if (btn && directorsHintCount < MAX_DIRECTORS_HINTS) btn.disabled = false;
        if (btnText && directorsHintCount < MAX_DIRECTORS_HINTS) btnText.textContent = 'Suggest Director\'s Hints';
    }
}

/**
 * Load Brand Kit model options for the wizard's step 3 dropdown.
 * Fetches all of the user's completed Brand Kits across all ad accounts.
 */
async function loadBrandKitOptionsForWizard() {
    const select = document.getElementById('storyBrandKit');
    if (!select) return;

    try {
        const result = await apiGet('/api/brand-stories/brand-kits');
        const brandKits = result.brandKits || [];

        select.innerHTML = '<option value="">None (generate without brand context)</option>';

        if (brandKits.length === 0) {
            const opt = document.createElement('option');
            opt.disabled = true;
            opt.textContent = 'No Brand Kits available — analyze one in Brand Asset Gen. tab';
            select.appendChild(opt);
            return;
        }

        brandKits.forEach(kit => {
            const opt = document.createElement('option');
            opt.value = kit.id;
            const summary = kit.brand_summary ? ` \u2014 ${kit.brand_summary.slice(0, 40)}...` : '';
            opt.textContent = `${kit.name}${summary}`;
            select.appendChild(opt);
        });
    } catch (error) {
        console.error('Failed to load Brand Kit options:', error);
        select.innerHTML = '<option value="">Failed to load Brand Kits</option>';
    }
}

/**
 * Wizard navigation.
 */
function wizardNext(step) {
    // Validate focus is selected before leaving Step 1 (Focus) for Step 2 (Persona)
    if (step === 2 && !document.querySelector('input[name="storyFocus"]:checked')) {
        showToast('Please select a story focus', 'warning');
        return;
    }
    brandStoryState.wizardStep = step;
    wizardShowStep(step);

    // Populate review summary on the final step (5)
    if (step === 5) populateWizardReview();
}

function wizardBack(step) {
    brandStoryState.wizardStep = step;
    wizardShowStep(step);
}

function wizardShowStep(step) {
    for (let i = 1; i <= 5; i++) {
        const stepEl = document.getElementById(`wizardStep${i}`);
        if (stepEl) stepEl.classList.toggle('hidden', i !== step);

        // Update step indicator
        const indicator = document.getElementById(`wizStep${i}`);
        if (indicator) {
            const circle = indicator.querySelector('span');
            if (i < step) {
                indicator.className = indicator.className.replace('text-ink-400', 'text-brand-600');
                if (!indicator.className.includes('text-brand-600')) indicator.classList.add('text-brand-600');
                indicator.classList.remove('text-ink-400');
                if (circle) { circle.className = 'w-6 h-6 rounded-full bg-brand-600 text-white flex items-center justify-center text-xs'; circle.textContent = '\u2713'; }
            } else if (i === step) {
                indicator.className = indicator.className.replace('text-ink-400', 'text-brand-600');
                if (!indicator.className.includes('text-brand-600')) indicator.classList.add('text-brand-600');
                indicator.classList.remove('text-ink-400');
                if (circle) { circle.className = 'w-6 h-6 rounded-full bg-brand-600 text-white flex items-center justify-center text-xs'; circle.textContent = i; }
            } else {
                indicator.className = indicator.className.replace('text-brand-600', 'text-ink-400');
                if (!indicator.className.includes('text-ink-400')) indicator.classList.add('text-ink-400');
                indicator.classList.remove('text-brand-600');
                if (circle) { circle.className = 'w-6 h-6 rounded-full bg-surface-200 text-ink-500 flex items-center justify-center text-xs'; circle.textContent = i; }
            }
        }
    }
}

/**
 * Populate the review summary on step 5.
 */
function populateWizardReview() {
    const summary = document.getElementById('wizardReviewSummary');
    if (!summary) return;

    const storyFocus = document.querySelector('input[name="storyFocus"]:checked')?.value || 'person';
    const personaType = document.querySelector('input[name="personaType"]:checked')?.value || 'described';
    const storyName = document.getElementById('storyName')?.value || 'Untitled';
    let subjectName = 'Not specified';
    try {
        const analyzed = document.getElementById('subjectAnalyzedJson')?.value;
        if (analyzed) subjectName = JSON.parse(analyzed).name || 'Not specified';
    } catch (e) { /* ignore */ }
    const frequency = document.getElementById('storyFrequency')?.value || 'daily';
    const platforms = [...document.querySelectorAll('input[name="storyPlatforms"]:checked')].map(c => c.value);
    const genre = document.getElementById('storyGenre')?.value || 'drama';
    const tone = document.getElementById('storyTone')?.value || 'engaging';
    const audience = document.getElementById('storyAudience')?.value || 'young professionals';
    const directorsNotes = document.getElementById('storyDirectorsNotes')?.value || '';

    const container = document.createElement('div');
    container.className = 'p-3 bg-surface-50 rounded-lg';
    const grid = document.createElement('div');
    grid.className = 'grid grid-cols-2 gap-3 text-sm';
    const items = [
        ['Focus', storyFocus],
        ['Story Name', storyName],
        ['Genre', genre.replace(/-/g, ' ')],
        ['Tone', tone.replace(/-/g, ' ')],
        ['Audience', audience],
        ['Persona', personaType],
        ['Subject', subjectName],
        ['Frequency', frequency.replace(/_/g, ' ')]
    ];
    items.forEach(([label, value]) => {
        const div = document.createElement('div');
        const labelSpan = document.createElement('span');
        labelSpan.className = 'text-ink-400';
        labelSpan.textContent = label + ':';
        const valueSpan = document.createElement('span');
        valueSpan.className = 'font-medium text-ink-800 capitalize';
        valueSpan.textContent = ' ' + value;
        div.appendChild(labelSpan);
        div.appendChild(valueSpan);
        grid.appendChild(div);
    });
    const platformDiv = document.createElement('div');
    platformDiv.className = 'col-span-2';
    const pLabel = document.createElement('span');
    pLabel.className = 'text-ink-400';
    pLabel.textContent = 'Platforms:';
    const pValue = document.createElement('span');
    pValue.className = 'font-medium text-ink-800';
    pValue.textContent = ' ' + (platforms.join(', ') || 'none selected');
    platformDiv.appendChild(pLabel);
    platformDiv.appendChild(pValue);
    grid.appendChild(platformDiv);
    if (directorsNotes) {
        const notesDiv = document.createElement('div');
        notesDiv.className = 'col-span-2';
        const nLabel = document.createElement('span');
        nLabel.className = 'text-ink-400';
        nLabel.textContent = "Director's Notes:";
        const nValue = document.createElement('span');
        nValue.className = 'font-medium text-ink-800';
        nValue.textContent = ' ' + directorsNotes;
        notesDiv.appendChild(nLabel);
        notesDiv.appendChild(nValue);
        grid.appendChild(notesDiv);
    }
    container.appendChild(grid);
    summary.replaceChildren(container);
}

/**
 * Create the brand story and trigger storyline generation.
 */
async function createBrandStory() {
    const btn = document.getElementById('wizardCreateBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<svg class="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> Creating...'; }

    try {
        const personaType = document.querySelector('input[name="personaType"]:checked')?.value || 'described';
        let personaConfig = {};

        // Build personas array (up to MAX_PERSONAS) from persona selection state
        let personas = [];
        if (personaType === 'described') {
            personas = personaSelectionState.described
                .filter(p => (p.description || '').trim().length > 0)
                .map(p => ({ description: p.description, personality: p.personality }));
        } else if (personaType === 'selected') {
            personas = personaSelectionState.selected.map(p => ({
                heygen_avatar_id: p.heygen_avatar_id,
                avatar_name: p.avatar_name
            }));
        } else if (personaType === 'brand_kit') {
            personas = personaSelectionState.brand_kit.map(p => ({
                cutout_url: p.cutout_url,
                description: p.description,
                brand_kit_job_id: p.brand_kit_job_id
            }));
        } else if (personaType === 'uploaded') {
            // Upload each persona's photos to Supabase Storage via the API
            const personasWithFiles = personaSelectionState.uploaded.filter(p => (p.reference_image_files || []).length > 0);
            if (personasWithFiles.length === 0) {
                throw new Error('Please upload at least one photo per person');
            }

            showToast('Uploading persona photos...', 'info');

            for (const p of personasWithFiles) {
                const formData = new FormData();
                p.reference_image_files.forEach(f => formData.append('images', f));

                const resp = await fetch('/api/brand-stories/personas/upload', {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'X-CSRF-Token': getCsrfToken() },
                    body: formData
                });
                const uploadResult = await resp.json();
                if (!uploadResult.success) throw new Error(uploadResult.error || 'Photo upload failed');
                personas.push({ reference_image_urls: uploadResult.urls });
            }
        } else if (personaType === 'brand_kit_auto') {
            // Already generated via generateBrandKitAutoPersona() — use stored results
            if (personaSelectionState.brand_kit_auto.length === 0) {
                throw new Error('Please generate a persona first using the "Generate Persona" button');
            }
            personas = personaSelectionState.brand_kit_auto.map(p => ({
                name: p.name,
                description: p.description,
                personality: p.personality,
                appearance: p.appearance,
                reference_image_urls: p.reference_image_urls,
                omnihuman_seed_image_url: p.omnihuman_seed_image_url
            }));
        }

        if (personas.length === 0) {
            throw new Error('Please add at least one persona');
        }

        // Apply the selected HeyGen voice_id to every persona so the HeyGen
        // narrator matches the user's gender/style preference. Empty value
        // means "auto-match" — backend falls back to gender-matched English voice.
        const chosenVoiceId = brandStoryState.selectedVoiceId || '';
        if (chosenVoiceId) {
            personas = personas.map(p => ({ ...p, heygen_voice_id: chosenVoiceId }));
        }

        personaConfig = { personas };

        // Subject is produced by Gemini image analysis (Step 2)
        let subject = {};
        try {
            const analyzedJson = document.getElementById('subjectAnalyzedJson')?.value || '';
            if (analyzedJson) subject = JSON.parse(analyzedJson);
        } catch (e) {
            console.warn('Failed to parse analyzed subject JSON:', e);
        }

        const platforms = [...document.querySelectorAll('input[name="storyPlatforms"]:checked')].map(c => c.value);

        // Merge creative settings into the subject so the storyline prompt can access them
        const creativeSettings = {
            tone: document.getElementById('storyTone')?.value || 'engaging',
            genre: document.getElementById('storyGenre')?.value || 'drama',
            target_audience: document.getElementById('storyAudience')?.value || 'young professionals',
            directors_notes: document.getElementById('storyDirectorsNotes')?.value || '',
            // V4 Audio Layer Overhaul Day 3 — language is read by:
            //   • screenplay system prompt (Hebrew register block when 'he')
            //   • runV4Pipeline (propagates to persona.language)
            //   • TTSService (eleven-v3 always; multilingual-v2 cannot do Hebrew)
            //   • VoiceAcquisition picker (filters voice library by languages[])
            language: document.getElementById('storyLanguage')?.value || 'en'
        };
        const enrichedSubject = { ...subject, ...creativeSettings };

        const payload = {
            name: document.getElementById('storyName')?.value || 'Untitled Story',
            story_focus: document.querySelector('input[name="storyFocus"]:checked')?.value || 'person',
            persona_type: personaType,
            persona_config: personaConfig,
            subject: enrichedSubject,
            brand_kit_job_id: document.getElementById('storyBrandKit')?.value || null,
            target_platforms: platforms,
            publish_frequency: document.getElementById('storyFrequency')?.value || 'daily'
        };

        // Step 1: Create the story
        const createResult = await apiPost('/api/brand-stories', payload);
        if (!createResult.success) throw new Error(createResult.error || 'Failed to create story');

        const storyId = createResult.story.id;
        showToast('Story created! Generating storyline...', 'success');

        // Step 2: Generate the storyline
        const storylineResult = await apiPost(`/api/brand-stories/${storyId}/generate-storyline`);
        if (!storylineResult.success) throw new Error(storylineResult.error || 'Storyline generation failed');

        showToast('Storyline generated!', 'success');

        // Show the story detail view
        showStoryDetail(storyId);
    } catch (error) {
        showToast(error.message || 'Failed to create brand story', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg> Create Story & Generate Storyline'; }
    }
}

/**
 * Show the detail view for a specific story.
 */
async function showStoryDetail(storyId) {
    brandStoryState.currentStoryId = storyId;

    // Hide other views
    document.getElementById('brandStoryList')?.classList.add('hidden');
    document.getElementById('brandStoryEmpty')?.classList.add('hidden');
    document.getElementById('brandStoryWizard')?.classList.add('hidden');
    document.getElementById('brandStoryDetail')?.classList.remove('hidden');

    try {
        const result = await apiGet(`/api/brand-stories/${storyId}`);
        const story = result.story;

        // Cache story personas for narrator-name lookup in episode cards
        brandStoryState.currentStoryPersonas = Array.isArray(story.persona_config?.personas)
          ? story.persona_config.personas
          : [story.persona_config];

        // Populate header
        document.getElementById('storyDetailTitle').textContent = story.name;
        document.getElementById('storyDetailLogline').textContent = story.storyline?.logline || story.storyline?.theme || '';

        // Status badge
        const statusEl = document.getElementById('storyDetailStatus');
        const statusColors = { draft: 'bg-surface-100 text-ink-500', active: 'bg-green-100 text-green-700', paused: 'bg-yellow-100 text-yellow-700', completed: 'bg-blue-100 text-blue-700' };
        statusEl.className = `px-3 py-1 text-xs font-medium rounded-full ${statusColors[story.status] || statusColors.draft}`;
        statusEl.textContent = story.status;

        // Automation button
        const autoBtn = document.getElementById('storyAutomationBtn');
        if (story.status === 'active') {
            autoBtn.textContent = 'Pause';
            autoBtn.onclick = () => toggleStoryAutomation(storyId, 'pause');
        } else {
            autoBtn.textContent = 'Activate';
            autoBtn.onclick = () => toggleStoryAutomation(storyId, 'activate');
        }

        // Full storyline overview
        if (story.storyline) {
            renderStorylineDetail(story);
        }

        // Avatar training banner
        updateAvatarTrainingBanner(story);

        // Episodes
        const episodes = story.episodes || [];
        brandStoryState.currentStoryEpisodes = episodes;
        renderEpisodeTimeline(episodes);

        // Update generate button with the next episode number
        const genBtn = document.getElementById('generateEpisodeBtn');
        const genBtnText = document.getElementById('generateEpisodeBtnText');
        if (genBtn) genBtn.onclick = () => generateNextEpisode(storyId);
        if (genBtnText) {
            const nextEpisodeNum = episodes.length + 1;
            genBtnText.textContent = `Generate ${ordinalSuffix(nextEpisodeNum)} Episode`;
        }

        // Auto-resume polling if any episode is still mid-pipeline.
        // This handles the case where the user navigates away, refreshes the page,
        // or reopens the story detail view while an episode is being generated.
        if (episodes.some(isEpisodeInProgress)) {
            setEpisodeGeneratingIndicator(true);
            pollStoryUpdates(storyId);
        }

    } catch (error) {
        showToast('Failed to load story details', 'error');
        console.error('Error loading story detail:', error);
    }
}

/**
 * Render the full storyline overview (meta chips, arc, characters,
 * planned episodes, season bible) inside the story detail view.
 */
function renderStorylineDetail(story) {
    const storyline = story.storyline || {};
    const overviewEl = document.getElementById('storyDetailOverview');
    if (!overviewEl) return;
    overviewEl.classList.remove('hidden');

    // 1) Meta chips (genre, tone, target_audience)
    const chipsEl = document.getElementById('storyMetaChips');
    if (chipsEl) {
        const chips = [];
        if (storyline.genre) chips.push({ label: 'Genre', value: storyline.genre });
        if (storyline.tone) chips.push({ label: 'Tone', value: storyline.tone });
        if (storyline.target_audience) chips.push({ label: 'Audience', value: storyline.target_audience });
        chipsEl.innerHTML = chips.map(c =>
            `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-surface-100 text-xs text-ink-700"><span class="text-ink-400">${c.label}:</span> <span class="font-medium">${escapeHtml(c.value)}</span></span>`
        ).join('');
    }

    // 2) Full 5-part arc
    const arcEl = document.getElementById('storyArcContent');
    const arc = storyline.arc || {};
    if (arcEl) {
        const rows = [
            ['Premise', arc.premise],
            ['Inciting Incident', arc.inciting_incident],
            ['Rising Action', arc.rising_action],
            ['Climax', arc.climax_hints],
            ['Resolution', arc.resolution_hints]
        ].filter(([_, v]) => v);
        arcEl.innerHTML = rows.map(([label, v]) =>
            `<div><dt class="text-xs font-semibold text-ink-500 uppercase tracking-wider">${label}</dt><dd class="mt-0.5">${escapeHtml(v)}</dd></div>`
        ).join('');
    }

    // 3) Characters
    const charsEl = document.getElementById('storyCharactersContent');
    const characters = storyline.characters || [];
    if (charsEl) {
        if (characters.length === 0) {
            charsEl.innerHTML = '<p class="text-sm text-ink-400">No characters defined.</p>';
        } else {
            charsEl.innerHTML = characters.map(c => `
                <div class="p-3 bg-surface-50 rounded-lg border border-surface-200">
                    <div class="flex items-center gap-2 mb-1">
                        <span class="font-semibold text-ink-800 text-sm">${escapeHtml(c.name || 'Unnamed')}</span>
                        ${c.role ? `<span class="px-2 py-0.5 text-xs bg-brand-100 text-brand-700 rounded">${escapeHtml(c.role)}</span>` : ''}
                    </div>
                    ${c.personality ? `<p class="text-xs text-ink-600 mb-1"><span class="text-ink-400">Personality:</span> ${escapeHtml(c.personality)}</p>` : ''}
                    ${c.visual_description ? `<p class="text-xs text-ink-600 mb-1"><span class="text-ink-400">Visual:</span> ${escapeHtml(c.visual_description)}</p>` : ''}
                    ${c.arc ? `<p class="text-xs text-ink-600 mb-1"><span class="text-ink-400">Arc:</span> ${escapeHtml(c.arc)}</p>` : ''}
                    ${c.relationship_to_product ? `<p class="text-xs text-ink-600"><span class="text-ink-400">Connection:</span> ${escapeHtml(c.relationship_to_product)}</p>` : ''}
                </div>
            `).join('');
        }
    }

    // 3b) Persona Seed Images — show the reference/seed images used for video generation
    _renderPersonaSeedImages(story);

    // 4) Planned episodes (with generated vs. upcoming distinction)
    const plannedEl = document.getElementById('storyPlannedEpisodes');
    const planned = storyline.episodes || [];
    const generatedCount = (story.episodes || []).length;
    if (plannedEl) {
        if (planned.length === 0) {
            plannedEl.innerHTML = '<p class="col-span-full text-sm text-ink-400">No planned episodes.</p>';
        } else {
            plannedEl.innerHTML = planned.map((ep, i) => {
                const isGenerated = i < generatedCount;
                return `
                    <div class="p-3 rounded-lg border ${isGenerated ? 'bg-green-50 border-green-200' : 'bg-white border-surface-200'}">
                        <div class="flex items-center gap-2 mb-1">
                            <span class="inline-flex items-center justify-center w-5 h-5 rounded-full text-xs font-bold ${isGenerated ? 'bg-green-600 text-white' : 'bg-surface-200 text-ink-500'}">${isGenerated ? '\u2713' : (i + 1)}</span>
                            <span class="font-semibold text-ink-800 text-sm truncate">${escapeHtml(ep.title || 'Untitled')}</span>
                            ${ep.mood ? `<span class="ml-auto px-1.5 py-0.5 text-xs bg-surface-100 text-ink-500 rounded">${escapeHtml(ep.mood)}</span>` : ''}
                        </div>
                        ${ep.hook ? `<p class="text-xs text-ink-600 mb-1"><span class="text-ink-400">Hook:</span> ${escapeHtml(ep.hook)}</p>` : ''}
                        ${ep.narrative_beat ? `<p class="text-xs text-ink-600 mb-1"><span class="text-ink-400">Beat:</span> ${escapeHtml(ep.narrative_beat)}</p>` : ''}
                        ${ep.cliffhanger ? `<p class="text-xs text-ink-600"><span class="text-ink-400">Cliff:</span> ${escapeHtml(ep.cliffhanger)}</p>` : ''}
                    </div>
                `;
            }).join('');
        }
    }

    // 5) Season bible — render but keep collapsed
    const bibleEl = document.getElementById('seasonBibleContent');
    if (bibleEl) {
        bibleEl.textContent = storyline.season_bible || 'No season bible written.';
    }
}

/**
 * Toggle the season bible collapsible section.
 */
function toggleSeasonBible() {
    const content = document.getElementById('seasonBibleContent');
    const chevron = document.getElementById('seasonBibleChevron');
    if (!content) return;
    const isHidden = content.classList.contains('hidden');
    content.classList.toggle('hidden');
    if (chevron) chevron.style.transform = isHidden ? 'rotate(90deg)' : '';
}

/**
 * Show/hide the avatar training banner based on training_status.
 */
function updateAvatarTrainingBanner(story) {
    const banner = document.getElementById('avatarTrainingBanner');
    const msg = document.getElementById('avatarTrainingMsg');
    if (!banner || !msg) return;

    const status = story.persona_config?.training_status;
    const messages = {
        pending: 'Preparing avatar setup...',
        generating_persona_image: 'Creating your persona image via AI...',
        processing: 'Uploading avatar to HeyGen...',
        failed: null,  // handled separately
        completed: null,
        skipped: null
    };

    if (status === 'failed') {
        banner.className = 'mt-3 p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-sm text-red-800';
        const errMsg = story.persona_config?.training_error || 'Unknown error';
        msg.textContent = `Avatar setup failed: ${errMsg}`;
        banner.classList.remove('hidden');
    } else if (messages[status]) {
        banner.className = 'mt-3 p-3 bg-blue-50 border border-blue-200 rounded-lg flex items-center gap-2 text-sm text-blue-800';
        msg.innerHTML = `
            <svg class="w-4 h-4 animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
            </svg>
            <span>${messages[status]}</span>
        `;
        banner.classList.remove('hidden');
        // Start polling if not already running
        if (!banner.dataset.polling) {
            banner.dataset.polling = '1';
            pollAvatarTraining(story.id);
        }
    } else {
        banner.classList.add('hidden');
        delete banner.dataset.polling;
    }
}

/**
 * Poll the story every 20s to refresh the avatar training status.
 */
async function pollAvatarTraining(storyId, attempt = 0) {
    if (attempt > 30) return;  // Max 10 minutes
    if (storyId !== brandStoryState.currentStoryId) return; // User left the detail view

    await new Promise(resolve => setTimeout(resolve, 20000));

    try {
        const result = await apiGet(`/api/brand-stories/${storyId}`);
        const story = result.story;
        updateAvatarTrainingBanner(story);
        const status = story.persona_config?.training_status;
        if (status && !['completed', 'failed', 'skipped'].includes(status)) {
            pollAvatarTraining(storyId, attempt + 1);
        }
    } catch (err) {
        console.error('Avatar polling error:', err);
        pollAvatarTraining(storyId, attempt + 1);
    }
}

/**
 * Resolve the narrator's display name from the cached story personas.
 */
function _narratorName(idx) {
    const personas = brandStoryState.currentStoryPersonas || [];
    const p = personas[Math.max(0, Math.min(idx, personas.length - 1))];
    if (!p) return `Persona ${idx + 1}`;
    // Try description, avatar_name, or fall back
    const name = (p.description || '').slice(0, 30).trim() || p.avatar_name || `Persona ${idx + 1}`;
    return name;
}

/**
 * Render persona seed images and subject reference images in the story detail view.
 * Shows all reference material that feeds into video generation — so the user can
 * see exactly what Kling/Flux/Seedance are working from.
 */
function _renderPersonaSeedImages(story) {
    const container = document.getElementById('storyPersonaSeedImages');
    if (!container) return;

    const personas = story.persona_config?.personas || [];
    const items = [];

    // Collect persona images
    personas.forEach((p, i) => {
        const name = (p.description || '').slice(0, 25).trim() || p.avatar_name || ('Persona ' + (i + 1));
        if (p.omnihuman_seed_image_url) items.push({ url: p.omnihuman_seed_image_url, label: name + ' (seed)' });
        else if (p.cutout_url) items.push({ url: p.cutout_url, label: name + ' (cutout)' });
        else if (p.avatar_preview_url) items.push({ url: p.avatar_preview_url, label: name + ' (avatar)' });
        if (Array.isArray(p.reference_image_urls)) {
            p.reference_image_urls.forEach((url, ri) => items.push({ url, label: name + ' ref ' + (ri + 1) }));
        }
    });

    // Collect subject images
    const subject = story.subject || {};
    if (Array.isArray(subject.reference_image_urls)) {
        subject.reference_image_urls.forEach((url, si) => items.push({ url, label: 'Subject ' + (si + 1) }));
    }

    if (items.length === 0) {
        container.textContent = '';
        return;
    }

    // Build DOM safely using createElement
    const wrapper = document.createElement('div');
    wrapper.className = 'flex gap-3 overflow-x-auto pb-2';

    items.forEach(img => {
        const card = document.createElement('div');
        card.className = 'flex-shrink-0 text-center cursor-pointer';
        card.onclick = () => window.open(img.url, '_blank');

        const imgEl = document.createElement('img');
        imgEl.src = img.url;
        imgEl.alt = img.label;
        imgEl.className = 'w-20 h-28 object-cover rounded-lg border border-surface-200 hover:border-brand-400 transition-colors';

        const labelEl = document.createElement('span');
        labelEl.className = 'block mt-1 text-[10px] text-ink-400 truncate max-w-[80px]';
        labelEl.textContent = img.label;

        card.appendChild(imgEl);
        card.appendChild(labelEl);
        wrapper.appendChild(card);
    });

    container.textContent = '';
    container.appendChild(wrapper);
}

/**
 * Render storyboard filmstrip for v2 cinematic episodes.
 * Shows all Flux 2 Max panels in a horizontal row.
 */
function _renderStoryboardFilmstrip(ep) {
    const panels = ep.storyboard_panels;
    if (!Array.isArray(panels) || panels.length === 0) return '';

    const scene = ep.scene_description || {};
    const shots = scene.shots || [];

    return `
        <div class="mt-2 flex gap-2 overflow-x-auto pb-1">
            ${panels.map((panel, i) => {
                const shotType = shots[i]?.shot_type || 'shot';
                const duration = shots[i]?.duration_seconds || '?';
                return `
                    <div class="flex-shrink-0 relative group cursor-pointer" onclick="window.open('${escapeHtml(panel.image_url)}', '_blank')">
                        <img src="${escapeHtml(panel.image_url)}" alt="Shot ${i + 1}" class="w-20 h-36 object-cover rounded-lg border border-surface-200 group-hover:border-brand-400 transition-colors">
                        <span class="absolute bottom-1 left-1 text-[10px] px-1 py-0.5 rounded bg-black/60 text-white">${i + 1}. ${escapeHtml(shotType)} ${duration}s</span>
                    </div>`;
            }).join('')}
        </div>`;
}

/**
 * V4 minimum observability: render the scene-graph for a V4 episode.
 * Shows scenes as horizontal cards, with beat counts and per-beat type chips.
 * Phase 1a — just enough for the user to see what V4 produced. The rich
 * Director's Panel (per-beat regen, model override, prompt edit) is Phase 1b.
 */
function _renderV4SceneGraph(ep) {
    const scene = ep.scene_description || {};
    const scenes = Array.isArray(scene.scenes) ? scene.scenes : [];
    if (scenes.length === 0) return '';

    // Beat type → emoji icon (compact visual cue for the type)
    const beatTypeIcon = {
        TALKING_HEAD_CLOSEUP: '\uD83C\uDFAD',  // 🎭
        DIALOGUE_IN_SCENE: '\uD83D\uDDE3',     // 🗣
        GROUP_DIALOGUE_TWOSHOT: '\uD83D\uDC65', // 👥
        SHOT_REVERSE_SHOT: '\uD83D\uDD04',     // 🔄
        SILENT_STARE: '\uD83D\uDC41',          // 👁
        REACTION: '\uD83D\uDE32',              // 😲
        INSERT_SHOT: '\uD83C\uDFAF',           // 🎯
        ACTION_NO_DIALOGUE: '\u26A1',          // ⚡
        MONTAGE_SEQUENCE: '\uD83C\uDFAC',      // 🎬
        B_ROLL_ESTABLISHING: '\uD83C\uDFD9',   // 🏙
        VOICEOVER_OVER_BROLL: '\uD83C\uDFA4',  // 🎤
        TEXT_OVERLAY_CARD: '\uD83D\uDCDD',     // 📝
        SPEED_RAMP_TRANSITION: '\u23E9'        // ⏩
    };

    const beatStatusColor = {
        pending: 'bg-surface-100 text-ink-500',
        generating: 'bg-blue-100 text-blue-700 animate-pulse',
        generated: 'bg-green-100 text-green-700',
        failed: 'bg-red-100 text-red-700'
    };

    const totalBeats = scenes.reduce((n, s) => n + (s.beats?.length || 0), 0);
    const totalCost = scenes.reduce((sum, s) =>
        sum + (s.beats || []).reduce((bs, b) => bs + (b.cost_usd || b.estimated_cost_usd || 0), 0)
    , 0);

    return `
        <div class="mt-2">
            <div class="flex items-center gap-3 text-xs text-ink-500 mb-1.5">
                <span class="font-semibold text-ink-700">V4 Scene-Graph</span>
                <span>${scenes.length} scene${scenes.length !== 1 ? 's' : ''}</span>
                <span>${totalBeats} beat${totalBeats !== 1 ? 's' : ''}</span>
                ${totalCost > 0 ? `<span class="text-green-700">~$${totalCost.toFixed(2)}</span>` : ''}
                ${ep.lut_id ? `<span class="px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 font-mono text-[10px]">${escapeHtml(ep.lut_id)}</span>` : ''}
            </div>
            <div class="space-y-1.5">
                ${scenes.map((scn, sceneIdx) => {
                    const beats = scn.beats || [];
                    const sceneType = scn.type === 'montage' ? '\uD83C\uDFAC montage' : '';
                    return `
                        <div class="border border-surface-200 rounded px-2 py-1.5 bg-surface-50">
                            <div class="flex items-center gap-2 mb-1">
                                <span class="text-[10px] font-mono text-ink-400">scene ${sceneIdx + 1}</span>
                                <span class="text-xs text-ink-700 truncate flex-1">${escapeHtml(scn.location || scn.scene_synopsis || '')}</span>
                                ${sceneType ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">${sceneType}</span>` : ''}
                                ${scn.scene_master_url ? `<a href="${escapeHtml(scn.scene_master_url)}" target="_blank" class="text-[10px] text-brand-600 hover:underline">scene master</a>` : ''}
                            </div>
                            <div class="flex flex-wrap gap-1">
                                ${beats.map(beat => {
                                    const icon = beatTypeIcon[beat.type] || '\u2753';
                                    const statusClass = beatStatusColor[beat.status] || beatStatusColor.pending;
                                    const dur = beat.actual_duration_sec || beat.duration_seconds;
                                    const durStr = dur ? `\u00B7${typeof dur === 'number' ? dur.toFixed(0) : dur}s` : '';
                                    const tooltip = beat.dialogue || beat.action_prompt || beat.subject_focus || beat.location || beat.text || beat.type;
                                    return `<span class="px-1.5 py-0.5 text-[10px] rounded ${statusClass} cursor-help" title="${escapeHtml(beat.beat_id + ': ' + tooltip)}">${icon}\u00A0${escapeHtml(beat.type.split('_').join(' ').toLowerCase())}${durStr}</span>`;
                                }).join('')}
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;
}

/**
 * Render the shot sequence chips for an episode card.
 * Shows the multi-shot composition Gemini planned (e.g. [broll 5s] \u2192 [dialogue 8s] \u2192 [cinematic 7s]).
 * Falls back to the single shot_type if the episode doesn't have a shots[] array.
 */
function _renderShotChips(scene) {
    const shotColors = {
        dialogue: 'bg-purple-100 text-purple-700',
        cinematic: 'bg-indigo-100 text-indigo-700',
        broll: 'bg-amber-100 text-amber-700'
    };

    const shots = Array.isArray(scene.shots) && scene.shots.length > 0
        ? scene.shots
        : (scene.shot_type ? [{ shot_type: scene.shot_type, duration_seconds: scene.duration_target_seconds || 10, narrator_persona_index: scene.narrator_persona_index }] : []);

    if (shots.length === 0) return '';

    return shots.map((shot, i) => {
        const color = shotColors[shot.shot_type] || 'bg-surface-100 text-ink-600';
        const duration = shot.duration_seconds ? `\u00B7${shot.duration_seconds}s` : '';
        const narrator = shot.shot_type === 'dialogue' && typeof shot.narrator_persona_index === 'number'
            ? ` \uD83C\uDFA4${escapeHtml(_narratorName(shot.narrator_persona_index))}`
            : '';
        const arrow = i < shots.length - 1
            ? '<span class="text-ink-300 text-xs">\u2192</span>'
            : '';
        return `<span class="px-2 py-0.5 text-xs rounded ${color}">${escapeHtml(shot.shot_type || '?')}${duration}${narrator}</span>${arrow}`;
    }).join('');
}

/**
 * Render the episode timeline in the story detail view.
 */
function renderEpisodeTimeline(episodes) {
    const timelineEl = document.getElementById('episodeTimeline');
    const noEpisodesEl = document.getElementById('noEpisodesMsg');

    if (!episodes || episodes.length === 0) {
        if (timelineEl) timelineEl.classList.add('hidden');
        if (noEpisodesEl) noEpisodesEl.classList.remove('hidden');
        return;
    }

    if (noEpisodesEl) noEpisodesEl.classList.add('hidden');
    if (!timelineEl) return;
    timelineEl.classList.remove('hidden');

    timelineEl.innerHTML = episodes.map(ep => {
        const scene = ep.scene_description || {};
        const statusIcons = {
            pending: '<span class="text-ink-400">Pending</span>',
            writing_script: '<span class="text-blue-500">Writing screenplay...</span>',
            generating_narration: '<span class="text-blue-500">Recording narration...</span>',
            generating_scene: '<span class="text-blue-500">Writing scene...</span>',
            generating_storyboard: '<span class="text-blue-500">Creating storyboard...</span>',
            generating_avatar: '<span class="text-blue-500">Recording avatar...</span>',
            generating_video: '<span class="text-blue-500">Generating video...</span>',
            post_production: '<span class="text-blue-500">Post-production...</span>',
            compositing: '<span class="text-blue-500">Compositing...</span>',
            ready: '<span class="text-green-600 font-medium">Ready</span>',
            publishing: '<span class="text-blue-500">Publishing...</span>',
            published: '<span class="text-green-700 font-medium">Published</span>',
            failed: '<span class="text-red-500">Failed</span>'
        };

        const isReady = ep.status === 'ready' || ep.status === 'published';
        const videoPlayable = ep.final_video_url && ep.final_video_url.includes('supabase');
        const title = scene.title || 'Episode ' + ep.episode_number;
        const isV4 = ep.pipeline_version === 'v4';

        // V4 status icon overlay (extends the v2/v3 statusIcons map with V4-specific stages)
        const v4StatusIcons = {
            brand_safety_check: '<span class="text-blue-500">Brand safety check...</span>',
            generating_scene_masters: '<span class="text-blue-500">Generating Scene Masters...</span>',
            generating_beats: '<span class="text-blue-500">Generating beats...</span>',
            assembling: '<span class="text-blue-500">Assembling episode...</span>',
            applying_lut: '<span class="text-blue-500">Applying color grade...</span>'
        };
        const statusHtml = v4StatusIcons[ep.status] || statusIcons[ep.status] || statusIcons.pending;

        return `
            <div class="card-gradient p-4 flex gap-4" data-episode-id="${ep.id}" data-story-id="${escapeHtml(ep.story_id || '')}" data-video-url="${escapeHtml(ep.final_video_url || '')}" data-video-title="${escapeHtml(title)}">
                <div class="flex-shrink-0 w-10 h-10 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center font-bold text-sm">
                    ${ep.episode_number}
                </div>
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 mb-1 flex-wrap">
                        <h5 class="font-semibold text-ink-800 truncate">${escapeHtml(title)}</h5>
                        ${statusHtml}
                        ${isV4 ? '<span class="px-1.5 py-0.5 text-[10px] rounded bg-brand-600 text-white font-mono">V4</span>' : ''}
                    </div>
                    ${isV4 ? '' : `
                    <div class="flex items-center gap-1.5 flex-wrap mb-1">
                        ${_renderShotChips(scene)}
                    </div>`}
                    <p class="text-sm text-ink-500 line-clamp-2">${escapeHtml(scene.narrative_beat || scene.hook || '')}</p>
                    ${ep.error_message ? `<p class="mt-1 text-xs text-red-500">${escapeHtml(ep.error_message)}</p>` : ''}
                    ${isV4 ? _renderV4SceneGraph(ep) : _renderStoryboardFilmstrip(ep)}
                    ${ep.narration_audio_url ? `
                    <div class="mt-1.5 flex items-center gap-2">
                        <button onclick="this.nextElementSibling.paused ? this.nextElementSibling.play() : this.nextElementSibling.pause(); this.textContent = this.nextElementSibling.paused ? '▶ Narration' : '⏸ Narration'" class="px-2 py-1 text-xs bg-surface-100 text-ink-600 rounded hover:bg-surface-200">▶ Narration</button>
                        <audio src="${escapeHtml(ep.narration_audio_url)}" preload="none" class="hidden"></audio>
                    </div>` : ''}
                    ${scene.visual_style_prefix ? `<p class="mt-1 text-xs text-ink-400 italic line-clamp-1">${escapeHtml(scene.visual_style_prefix)}</p>` : ''}
                    <div class="mt-2 flex gap-2 items-start">
                        ${ep.storyboard_frame_url && !ep.storyboard_panels?.length ? `<img src="${escapeHtml(ep.storyboard_frame_url)}" alt="Storyboard" class="w-20 h-auto rounded border border-surface-200">` : ''}
                        ${isReady && ep.final_video_url ? `
                            <div class="flex flex-col gap-1.5">
                                <button data-action="play" class="px-3 py-1.5 text-xs bg-brand-600 text-white rounded hover:bg-brand-700 flex items-center gap-1">
                                    <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                                    Play
                                </button>
                                <a href="${escapeHtml(ep.final_video_url)}" download="episode-${ep.episode_number}.mp4" target="_blank" class="px-3 py-1.5 text-xs bg-white border border-surface-300 text-ink-700 rounded hover:bg-surface-50 flex items-center gap-1">
                                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
                                    Download
                                </a>
                            </div>
                        ` : ''}
                        ${isV4 ? `
                            <button data-action="director" class="px-3 py-1.5 text-xs bg-purple-600 text-white rounded hover:bg-purple-700 flex items-center gap-1">
                                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
                                Direct
                            </button>
                        ` : ''}
                    </div>
                </div>
                <div class="flex-shrink-0 flex flex-col items-end gap-2">
                    ${videoPlayable
                        ? `<video src="${escapeHtml(ep.final_video_url)}" data-action="play" class="w-20 h-36 object-cover rounded-lg border border-surface-200 cursor-pointer" muted playsinline></video>`
                        : (ep.final_video_url
                            ? '<div class="w-20 h-36 bg-surface-100 rounded-lg flex items-center justify-center text-ink-300 text-xs text-center p-1">Video not playable in browser</div>'
                            : '<div class="w-20 h-36 bg-surface-100 rounded-lg flex items-center justify-center text-ink-300 text-xs">No video</div>')
                    }
                    <button data-action="delete" class="text-xs text-red-500 hover:text-red-600 flex items-center gap-1">
                        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                        Delete
                    </button>
                </div>
            </div>
        `;
    }).join('');

    // Wire up event delegation (avoids HTML-escaping issues with inline onclick)
    timelineEl.onclick = (e) => {
        const actionEl = e.target.closest('[data-action]');
        if (!actionEl) return;
        const card = actionEl.closest('[data-episode-id]');
        if (!card) return;

        const action = actionEl.dataset.action;
        const episodeId = card.dataset.episodeId;
        const videoUrl = card.dataset.videoUrl;
        const videoTitle = card.dataset.videoTitle;

        if (action === 'play' && videoUrl) {
            openEpisodeVideo(videoUrl, videoTitle);
        } else if (action === 'delete') {
            deleteEpisode(episodeId);
        } else if (action === 'director') {
            const storyId = card.dataset.storyId;
            if (typeof window.openDirectorPanel === 'function') {
                window.openDirectorPanel(episodeId, storyId);
            } else {
                console.warn('Director\'s Panel not loaded');
            }
        }
    };
}

/**
 * Open the episode video in a full-screen modal player.
 */
function openEpisodeVideo(url, title) {
    // Simple modal-based player
    const modal = document.createElement('div');
    modal.className = 'fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    modal.innerHTML = `
        <div class="bg-black rounded-lg overflow-hidden max-w-md w-full max-h-[90vh] flex flex-col">
            <div class="flex items-center justify-between p-3 bg-ink-900 text-white">
                <span class="font-medium text-sm truncate">${title}</span>
                <button onclick="this.closest('.fixed').remove()" class="text-white hover:text-ink-300">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                </button>
            </div>
            <video src="${url}" controls autoplay class="w-full bg-black" style="max-height: 80vh"></video>
        </div>
    `;
    document.body.appendChild(modal);
}

/**
 * Delete a single episode with confirmation.
 */
async function deleteEpisode(episodeId) {
    if (!confirm('Delete this episode? This cannot be undone.')) return;

    const storyId = brandStoryState.currentStoryId;
    if (!storyId) return;

    try {
        const result = await apiDelete(`/api/brand-stories/${storyId}/episodes/${episodeId}`);
        if (!result.success) throw new Error(result.error || 'Delete failed');
        showToast('Episode deleted', 'success');
        showStoryDetail(storyId);
    } catch (error) {
        showToast(error.message || 'Failed to delete episode', 'error');
    }
}

/**
 * Generate the next episode for the current story.
 */
async function generateNextEpisode(storyId) {
    const targetId = storyId || brandStoryState.currentStoryId;
    if (!targetId) return;

    setEpisodeGeneratingIndicator(true);

    try {
        // Snapshot the pre-POST episode count so the poller can tell when the
        // newly-requested episode lands — defeats the race where the V4 pipeline
        // hasn't written the new row by the time the first GET returns.
        const expectedMinEpisodes = (brandStoryState.currentStoryEpisodes?.length || 0) + 1;

        const result = await apiPost(`/api/brand-stories/${targetId}/generate-episode`);
        if (!result.success) throw new Error(result.error || 'Failed to start episode generation');

        showToast('Episode generation started! This may take a few minutes.', 'success');

        // Poll for updates. minAttempts gives ~25s of grace when no in-progress
        // status is visible yet (status set lags or pipeline-stage drift).
        pollStoryUpdates(targetId, 0, { expectedMinEpisodes, minAttempts: 5 });
    } catch (error) {
        showToast(error.message || 'Failed to generate episode', 'error');
        setEpisodeGeneratingIndicator(false);
    }
}

/**
 * Poll for story updates (episode generation progress).
 *
 * Continues polling while ANY of:
 *   - an episode is in a non-terminal status (IN_PROGRESS_EPISODE_STATUSES)
 *   - episodes.length is still below the count expected after a generate POST
 *   - we haven't yet hit the minimum number of attempts requested by the caller
 *
 * The latter two guards exist because the V4 pipeline writes the new episode
 * row asynchronously and the first GET can race ahead of it.
 */
async function pollStoryUpdates(storyId, attempt = 0, opts = {}) {
    const { expectedMinEpisodes = 0, minAttempts = 0 } = opts;

    if (attempt > 60) {
        setEpisodeGeneratingIndicator(false);
        return;
    }

    try {
        const result = await apiGet(`/api/brand-stories/${storyId}`);
        const story = result.story;
        const episodes = story.episodes || [];
        brandStoryState.currentStoryEpisodes = episodes;
        renderEpisodeTimeline(episodes);

        const generating = episodes.some(isEpisodeInProgress);
        const stillWaitingForNewEpisode = episodes.length < expectedMinEpisodes;
        const withinMinAttempts = attempt < minAttempts;

        if (generating || stillWaitingForNewEpisode || withinMinAttempts) {
            // Re-assert visibility every iteration so any drift caused by
            // intervening renders (e.g. showStoryDetail, director-panel close)
            // is corrected. The spinner stays visible from the moment the user
            // clicks Generate until the pipeline truly terminates.
            setEpisodeGeneratingIndicator(true);
            setTimeout(() => pollStoryUpdates(storyId, attempt + 1, opts), 5000);
        } else {
            setEpisodeGeneratingIndicator(false);

            const latest = episodes.slice(-1)[0];
            if (latest?.status === 'ready' || latest?.status === 'published') {
                showToast(`Episode ${latest.episode_number} is ready!`, 'success');
            } else if (latest?.status === 'failed') {
                showToast(`Episode generation failed: ${latest.error_message || 'Unknown error'}`, 'error');
            }

            // Refresh the full detail view so the "Generate Nth Episode" button
            // label and any other derived UI (counts, season bible) update too.
            showStoryDetail(storyId);
        }
    } catch (error) {
        // Keep the spinner up across transient fetch errors — pipeline is still
        // running on the backend; we just couldn't reach it for one cycle.
        setEpisodeGeneratingIndicator(true);
        setTimeout(() => pollStoryUpdates(storyId, attempt + 1, opts), 5000);
    }
}

/**
 * Toggle story automation (activate / pause).
 */
async function toggleStoryAutomation(storyId, action) {
    const targetId = storyId || brandStoryState.currentStoryId;
    if (!targetId) return;

    try {
        const result = await apiPost(`/api/brand-stories/${targetId}/${action}`);
        if (!result.success) throw new Error(result.error || `Failed to ${action} story`);

        showToast(`Story ${action === 'activate' ? 'activated' : 'paused'}`, 'success');
        showStoryDetail(targetId);
    } catch (error) {
        showToast(error.message || `Failed to ${action} story`, 'error');
    }
}

/**
 * Convert a number to an ordinal string: 1 → "1st", 2 → "2nd", 3 → "3rd", 4 → "4th", etc.
 */
function ordinalSuffix(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/**
 * Navigate back to the story list from detail view.
 */
function backToStoryList() {
    brandStoryState.currentStoryId = null;
    document.getElementById('brandStoryDetail')?.classList.add('hidden');
    document.getElementById('brandStoryWizard')?.classList.add('hidden');
    loadBrandStories();
}

// ============================================
// SUBJECT ANALYSIS (Step 2 of Brand Story wizard)
// ============================================

// State for subject image selection
let subjectState = {
    source: 'upload',                   // 'upload' | 'brand_kit'
    uploadFiles: [],                    // File objects (max 3)
    selectedBrandKitAssets: [],         // [{ id, url, brand_kit_job_id }]
    brandKitAssets: []                  // All available Brand Kit assets
};

/**
 * Toggle between "Upload Images" and "From Brand Kit" tabs.
 */
function setSubjectSource(src) {
    subjectState.source = src;
    const uploadBtn = document.getElementById('subjectSrcUploadBtn');
    const bkBtn = document.getElementById('subjectSrcBrandKitBtn');
    const uploadVariant = document.getElementById('subjectUploadVariant');
    const bkVariant = document.getElementById('subjectBrandKitVariant');

    if (src === 'upload') {
        uploadBtn?.classList.replace('bg-white', 'bg-brand-600');
        uploadBtn?.classList.replace('text-ink-600', 'text-white');
        bkBtn?.classList.replace('bg-brand-600', 'bg-white');
        bkBtn?.classList.replace('text-white', 'text-ink-600');
        uploadVariant?.classList.remove('hidden');
        bkVariant?.classList.add('hidden');
    } else {
        bkBtn?.classList.replace('bg-white', 'bg-brand-600');
        bkBtn?.classList.replace('text-ink-600', 'text-white');
        uploadBtn?.classList.replace('bg-brand-600', 'bg-white');
        uploadBtn?.classList.replace('text-white', 'text-ink-600');
        bkVariant?.classList.remove('hidden');
        uploadVariant?.classList.add('hidden');

        // Lazy-load Brand Kit assets
        if (subjectState.brandKitAssets.length === 0) loadBrandKitSubjects();
    }

    updateAnalyzeButtonState();
}

/**
 * Load non-person assets (logos, graphics, products) from user's Brand Kits.
 */
async function loadBrandKitSubjects() {
    const grid = document.getElementById('brandKitSubjectGrid');
    if (!grid) return;

    try {
        const result = await apiGet('/api/brand-stories/subjects/brand-kit');
        subjectState.brandKitAssets = result.subjects || [];

        if (subjectState.brandKitAssets.length === 0) {
            grid.innerHTML = `
                <div class="col-span-full text-center py-6">
                    <p class="text-ink-500 text-sm mb-2">No subject assets found in your Brand Kits.</p>
                    <p class="text-ink-400 text-xs">Train a model in Brand Asset Gen. tab and run Brand Kit analysis to extract logos and graphics.</p>
                </div>
            `;
            return;
        }

        grid.innerHTML = subjectState.brandKitAssets.map(asset => `
            <div class="border border-surface-200 rounded-lg p-2 cursor-pointer hover:border-brand-400 transition-colors relative"
                 data-asset-id="${escapeHtml(asset.id)}"
                 onclick="toggleBrandKitSubject(this, '${escapeHtml(asset.id)}', '${escapeHtml(asset.url)}', '${escapeHtml(asset.brand_kit_job_id)}')">
                <img src="${escapeHtml(asset.url)}" alt="${escapeHtml(asset.description)}" class="w-full aspect-square object-contain rounded mb-1 bg-surface-100">
                <p class="text-xs text-ink-600 truncate">${escapeHtml(asset.type)} · ${escapeHtml(asset.description.slice(0, 30))}</p>
                <div class="absolute top-1 right-1 w-5 h-5 rounded-full border-2 border-white bg-surface-300 hidden" data-check></div>
            </div>
        `).join('');
    } catch (error) {
        console.error('Error loading Brand Kit subjects:', error);
        grid.innerHTML = '<p class="col-span-full text-center text-red-500 py-4">Failed to load assets</p>';
    }
}

/**
 * Toggle selection of a Brand Kit asset (max 3).
 */
function toggleBrandKitSubject(el, assetId, url, brandKitJobId) {
    const idx = subjectState.selectedBrandKitAssets.findIndex(a => a.id === assetId);

    if (idx >= 0) {
        // Deselect
        subjectState.selectedBrandKitAssets.splice(idx, 1);
        el.classList.remove('border-brand-500', 'bg-brand-50');
        el.classList.add('border-surface-200');
        el.querySelector('[data-check]')?.classList.add('hidden');
    } else {
        // Select (enforce max 3)
        if (subjectState.selectedBrandKitAssets.length >= 3) {
            showToast('Maximum 3 assets allowed', 'warning');
            return;
        }
        subjectState.selectedBrandKitAssets.push({ id: assetId, url, brand_kit_job_id: brandKitJobId });
        el.classList.add('border-brand-500', 'bg-brand-50');
        el.classList.remove('border-surface-200');
        const check = el.querySelector('[data-check]');
        if (check) {
            check.classList.remove('hidden', 'bg-surface-300');
            check.classList.add('bg-brand-600');
            check.innerHTML = '<svg class="w-3 h-3 text-white m-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"></path></svg>';
        }
    }

    updateAnalyzeButtonState();
}

/**
 * Attach file input listener when wizard shows step 2.
 */
function setupSubjectUploadHandlers() {
    const fileInput = document.getElementById('subjectFileInput');
    if (!fileInput || fileInput.dataset.bound === '1') return;

    fileInput.dataset.bound = '1';
    fileInput.addEventListener('change', (e) => {
        const files = [...e.target.files].slice(0, 3);
        subjectState.uploadFiles = files;
        renderSubjectUploadPreview();
        updateAnalyzeButtonState();
    });

    // Drag-and-drop
    const zone = document.getElementById('subjectDropZone');
    if (zone && zone.dataset.bound !== '1') {
        zone.dataset.bound = '1';
        zone.addEventListener('dragover', (e) => {
            e.preventDefault();
            zone.classList.add('border-brand-500', 'bg-brand-50');
        });
        zone.addEventListener('dragleave', () => {
            zone.classList.remove('border-brand-500', 'bg-brand-50');
        });
        zone.addEventListener('drop', (e) => {
            e.preventDefault();
            zone.classList.remove('border-brand-500', 'bg-brand-50');
            const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/')).slice(0, 3);
            subjectState.uploadFiles = files;
            renderSubjectUploadPreview();
            updateAnalyzeButtonState();
        });
    }
}

/**
 * Render thumbnails of uploaded files.
 */
function renderSubjectUploadPreview() {
    const preview = document.getElementById('subjectUploadPreview');
    if (!preview) return;

    if (subjectState.uploadFiles.length === 0) {
        preview.classList.add('hidden');
        preview.innerHTML = '';
        return;
    }

    preview.classList.remove('hidden');
    preview.innerHTML = subjectState.uploadFiles.map((file, idx) => {
        const url = URL.createObjectURL(file);
        return `
            <div class="relative border border-surface-200 rounded-lg overflow-hidden">
                <img src="${url}" alt="Upload ${idx + 1}" class="w-full aspect-square object-contain bg-surface-100">
                <button onclick="removeSubjectUploadFile(${idx})" class="absolute top-1 right-1 w-6 h-6 bg-red-500 text-white rounded-full flex items-center justify-center text-xs hover:bg-red-600">\u00d7</button>
            </div>
        `;
    }).join('');
}

function removeSubjectUploadFile(idx) {
    subjectState.uploadFiles.splice(idx, 1);
    document.getElementById('subjectFileInput').value = '';
    renderSubjectUploadPreview();
    updateAnalyzeButtonState();
}

/**
 * Enable/disable Analyze button based on whether images are selected.
 */
function updateAnalyzeButtonState() {
    const btn = document.getElementById('analyzeSubjectBtn');
    if (!btn) return;

    const hasImages = subjectState.source === 'upload'
        ? subjectState.uploadFiles.length > 0
        : subjectState.selectedBrandKitAssets.length > 0;

    btn.disabled = !hasImages;
}

/**
 * Call the backend to analyze the selected images via Gemini.
 */
async function analyzeSubjectImages() {
    const btn = document.getElementById('analyzeSubjectBtn');
    const btnText = document.getElementById('analyzeSubjectBtnText');
    const statusEl = document.getElementById('analyzeSubjectStatus');

    if (btn) btn.disabled = true;
    if (btnText) btnText.textContent = 'Analyzing...';
    if (statusEl) {
        statusEl.classList.remove('hidden');
        statusEl.textContent = 'Gemini is analyzing your images...';
    }

    try {
        let result;

        if (subjectState.source === 'upload') {
            // Upload images as multipart/form-data
            const formData = new FormData();
            subjectState.uploadFiles.forEach(f => formData.append('images', f));

            // Attach brand kit context if a Brand Kit is selected in step 3
            const brandKitJobId = document.getElementById('storyBrandKit')?.value;
            if (brandKitJobId) formData.append('brandKitJobId', brandKitJobId);

            const resp = await fetch('/api/brand-stories/subjects/analyze', {
                method: 'POST',
                credentials: 'include',
                headers: { 'X-CSRF-Token': getCsrfToken() },
                body: formData
            });
            result = await resp.json();
        } else {
            // Brand Kit asset URLs
            const payload = {
                imageUrls: subjectState.selectedBrandKitAssets.map(a => a.url),
                brandKitJobId: subjectState.selectedBrandKitAssets[0]?.brand_kit_job_id || null
            };
            result = await apiPost('/api/brand-stories/subjects/analyze', payload);
        }

        if (!result.success) throw new Error(result.error || 'Analysis failed');

        const subject = result.subject;

        // Store the analyzed subject JSON
        document.getElementById('subjectAnalyzedJson').value = JSON.stringify(subject);

        // Display result
        document.getElementById('subjectResultName').textContent = subject.name || '';
        document.getElementById('subjectResultCategory').textContent = subject.category || '';
        document.getElementById('subjectResultDescription').textContent = subject.description || '';
        document.getElementById('subjectResultFeatures').textContent = (subject.key_features || []).join(', ');
        document.getElementById('subjectResultVisual').textContent = subject.visual_description || '';
        document.getElementById('subjectAnalysisResult').classList.remove('hidden');

        // Enable "Next" button
        document.getElementById('subjectNextBtn').disabled = false;

        showToast('Subject analyzed successfully', 'success');
    } catch (error) {
        showToast(error.message || 'Failed to analyze subject', 'error');
    } finally {
        if (btn) btn.disabled = false;
        if (btnText) btnText.textContent = 'Analyze Subject';
        if (statusEl) statusEl.classList.add('hidden');
    }
}

/**
 * Reset subject analysis to allow re-analysis with different images.
 */
function resetSubjectAnalysis() {
    document.getElementById('subjectAnalyzedJson').value = '';
    document.getElementById('subjectAnalysisResult').classList.add('hidden');
    document.getElementById('subjectNextBtn').disabled = true;
}
