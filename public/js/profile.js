// profile.js - Dashboard page handling

// CSRF token management
let csrfToken = null;

async function initCsrf() {
    try {
        // First check if we already have a token in the cookie
        const existingToken = getCsrfTokenFromCookie();
        if (existingToken) {
            csrfToken = existingToken;
            return csrfToken;
        }
        // Fetch a fresh token from the server
        const response = await fetch('/api/csrf-token', { credentials: 'include' });
        if (response.ok) {
            const data = await response.json();
            csrfToken = data.csrfToken;
            return csrfToken;
        }
    } catch (error) {
        console.error('Error initializing CSRF:', error);
    }
    return null;
}

function getCsrfTokenFromCookie() {
    const cookies = document.cookie.split(';');
    for (const cookie of cookies) {
        const [name, value] = cookie.trim().split('=');
        if (name === 'csrfToken') return value;
    }
    return null;
}

function getCsrfToken() {
    return csrfToken || getCsrfTokenFromCookie();
}

// Global state
let currentUser = null;
let connections = [];
let agents = [];
let agentLimit = 1;
let availableConnections = [];

document.addEventListener('DOMContentLoaded', async () => {
    // Parse URL params once at the start
    const urlParams = new URLSearchParams(window.location.search);
    const urlToken = urlParams.get('token');
    const tab = urlParams.get('tab');
    const payment = urlParams.get('payment');

    if (urlToken) {
        // Store token from OAuth callback
        localStorage.setItem('token', urlToken);

        // Track sign-up conversion for new OAuth users only
        const isNewUser = urlParams.get('new_user');
        if (isNewUser && typeof gtag === 'function') {
            gtag('event', 'sign_up', { method: 'google_oauth' });
            gtag('event', 'conversion', { send_to: 'AW-18053463418', event_category: 'sign_up' });
        }

        // Remove token and new_user from URL for security (preserve other params like tab)
        const cleanUrl = new URL(window.location);
        cleanUrl.searchParams.delete('token');
        cleanUrl.searchParams.delete('new_user');
        window.history.replaceState({}, document.title, cleanUrl.pathname + cleanUrl.search);
    }

    // Check if user is authenticated
    const token = localStorage.getItem('token');
    if (!token) {
        window.location.href = '/auth.html';
        return;
    }

    // Initialize CSRF token first
    await initCsrf();

    // Load user profile first (needed for tier-gating in connections)
    await loadUserProfile();

    // Then load connections and agents in parallel
    await Promise.all([
        loadConnections(),
        loadAgents()
    ]);

    // Setup event handlers
    setupEventHandlers();

    // Handle connection success/error from OAuth callback
    const connectionError = urlParams.get('error');
    const connectionPlatform = urlParams.get('platform');
    const connectedPlatform = urlParams.get('connected');
    const connectedUsername = urlParams.get('username');

    if (connectedPlatform) {
        showConnectionSuccessMessage(connectedPlatform, connectedUsername);
        // Clean up connection params from URL
        const cleanUrl = new URL(window.location);
        cleanUrl.searchParams.delete('connected');
        cleanUrl.searchParams.delete('username');
        window.history.replaceState({}, document.title, cleanUrl.pathname + cleanUrl.search);
    } else if (connectionError) {
        showConnectionErrorMessage(connectionPlatform, connectionError);
        // Clean up error params from URL
        const cleanUrl = new URL(window.location);
        cleanUrl.searchParams.delete('error');
        cleanUrl.searchParams.delete('platform');
        window.history.replaceState({}, document.title, cleanUrl.pathname + cleanUrl.search);
    }

    // Check URL params for tab navigation
    if (tab) {
        showTab(tab);
        // Auto-expand subscription section if requested via URL
        const section = urlParams.get('section');
        if (section === 'subscription' && (tab === 'agents' || tab === 'subscription')) {
            requestAnimationFrame(() => toggleSubscriptionPanel(true));
        }
    }

    // Handle payment success/cancel
    if (payment === 'success') {
        showPaymentSuccessMessage();
        // Clean up URL
        const cleanUrl = new URL(window.location);
        cleanUrl.searchParams.delete('payment');
        window.history.replaceState({}, document.title, cleanUrl.pathname + cleanUrl.search);
    } else if (payment === 'cancelled') {
        showPaymentCancelledMessage();
        // Clean up URL
        const cleanUrl = new URL(window.location);
        cleanUrl.searchParams.delete('payment');
        window.history.replaceState({}, document.title, cleanUrl.pathname + cleanUrl.search);
    }
});

async function loadUserProfile() {
    const token = localStorage.getItem('token');

    try {
        const response = await fetch('/api/users/profile', {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (response.ok) {
            const data = await response.json();
            currentUser = data.user || data;
            window.currentUser = currentUser; // Expose for analytics module
            updateProfileUI();
        } else if (response.status === 401) {
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            window.location.href = '/auth.html';
        }
    } catch (error) {
        console.error('Error loading profile:', error);
    }
}

async function loadConnections() {
    const token = localStorage.getItem('token');

    try {
        const response = await fetch('/api/connections', {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (response.ok) {
            const data = await response.json();
            connections = data.connections || [];
            updateConnectionsUI();
        }
    } catch (error) {
        console.error('Error loading connections:', error);
    }
}

function updateProfileUI() {
    if (!currentUser) return;

    // Update header info
    const userEmail = document.getElementById('userEmail');
    const userName = document.getElementById('userName');
    const subscriptionBadge = document.getElementById('subscriptionBadge');

    if (userEmail) userEmail.textContent = currentUser.email;
    if (userName) userName.textContent = currentUser.name || 'User';

    // Show subscription badge for paid users
    const tier = currentUser.subscription?.tier || 'free';
    const isPaidUser = tier !== 'free';

    if (subscriptionBadge) {
        if (isPaidUser) {
            subscriptionBadge.textContent = tier.toUpperCase();
            subscriptionBadge.classList.remove('hidden');
        } else {
            subscriptionBadge.classList.add('hidden');
        }
    }

    // Update subscription info
    const currentPlanName = document.getElementById('currentPlanName');
    const postsRemaining = document.getElementById('postsRemaining');
    const subscriptionStatus = document.getElementById('subscriptionStatus');

    if (currentPlanName) {
        currentPlanName.textContent = tier.charAt(0).toUpperCase() + tier.slice(1);
    }

    // Update collapsed subscription banner summary
    const currentPlanBadge = document.getElementById('currentPlanBadge');
    if (currentPlanBadge) {
        currentPlanBadge.textContent = tier.charAt(0).toUpperCase() + tier.slice(1);
    }

    if (postsRemaining) {
        const remaining = currentUser.subscription?.postsRemaining ?? 1;
        const limit = currentUser.subscription?.dailyLimit ?? 1;
        postsRemaining.textContent = `${remaining}/${limit}`;

        const postsRemainingBadge = document.getElementById('postsRemainingBadge');
        if (postsRemainingBadge) {
            postsRemainingBadge.textContent = `${remaining}/${limit}`;
        }
    }

    if (subscriptionStatus) {
        if (isPaidUser) {
            const sub = currentUser.subscription;
            if (sub?.pendingTier) {
                const changeTier = sub.pendingTier.charAt(0).toUpperCase() + sub.pendingTier.slice(1);
                const changeDate = sub.pendingChangeAt
                    ? new Date(sub.pendingChangeAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
                    : 'next billing cycle';
                subscriptionStatus.textContent = `Your plan will change to ${changeTier} on ${changeDate}.`;
            } else {
                subscriptionStatus.textContent = `Your ${tier} plan is active. You have access to all features.`;
            }
        } else {
            subscriptionStatus.textContent = 'Upgrade to unlock unlimited posts and advanced features';
        }
    }

    // Update subscription management actions visibility
    updateSubscriptionActions(tier);

    // Update dashboard stats
    const postsLeftToday = document.getElementById('postsLeftToday');
    if (postsLeftToday) {
        postsLeftToday.textContent = currentUser.subscription?.postsRemaining ?? 1;
    }

    // Highlight current plan
    highlightCurrentPlan(tier);

    // Update agent status section
    updateAgentStatus();
}

function updateConnectionsUI() {
    const platforms = ['twitter', 'linkedin', 'reddit', 'facebook', 'instagram', 'threads', 'telegram', 'whatsapp', 'tiktok', 'youtube'];
    let connectedCount = 0;

    // Tier hierarchy for gating comparisons
    const TIER_ORDER = ['free', 'starter', 'growth', 'business'];
    const userTier = currentUser?.subscription?.tier || 'free';
    const userTierIndex = TIER_ORDER.indexOf(userTier);

    platforms.forEach(platform => {
        const connection = connections.find(c => c.platform === platform);
        const card = document.getElementById(`platform-${platform}`);
        const statusEl = document.getElementById(`${platform}-status`);
        const btn = document.getElementById(`${platform}-btn`);

        // Check tier-gating: if card has data-min-tier, enforce it
        if (card && card.dataset.minTier) {
            const requiredTierIndex = TIER_ORDER.indexOf(card.dataset.minTier);
            if (userTierIndex < requiredTierIndex) {
                const requiredTierName = card.dataset.minTier.charAt(0).toUpperCase() + card.dataset.minTier.slice(1);
                card.classList.add('tier-gated');
                if (statusEl) {
                    statusEl.textContent = `${requiredTierName}+ plan required`;
                    statusEl.classList.remove('text-green-400');
                    statusEl.classList.add('text-gray-400');
                }
                if (btn) {
                    btn.textContent = `Upgrade to ${requiredTierName}`;
                    btn.className = 'px-4 py-2 rounded-lg bg-gradient-to-r from-brand-500 to-purple-500 text-white text-sm font-medium hover:from-brand-600 hover:to-purple-600 transition-all';
                    btn.onclick = (e) => {
                        e.preventDefault();
                        showTab('subscription');
                    };
                }
                return; // Skip normal connection rendering for gated platforms
            } else {
                card.classList.remove('tier-gated');
            }
        }

        if (connection && connection.status === 'active') {
            connectedCount++;
            if (card) card.classList.add('connected');
            if (statusEl) {
                statusEl.classList.remove('text-gray-400');
                statusEl.classList.add('text-green-400');

                if (platform === 'whatsapp') {
                    const displayName = connection.displayName || connection.username || 'group';
                    statusEl.textContent = `Connected to ${displayName}`;
                } else if (['facebook', 'instagram'].includes(platform)) {
                    // For Meta platforms: show page/account name with clickable selector
                    const pageName = connection.activePage?.name
                        || connection.username || connection.displayName || 'Page';
                    statusEl.innerHTML = '';
                    statusEl.appendChild(document.createTextNode('Connected as '));
                    const pageSpan = document.createElement('span');
                    pageSpan.textContent = `@${pageName}`;
                    pageSpan.className = 'cursor-pointer underline decoration-dotted hover:text-green-300 transition-colors';
                    pageSpan.title = 'Click to switch page';
                    pageSpan.onclick = (e) => {
                        e.stopPropagation();
                        openPageSelector(platform, connection);
                    };
                    statusEl.appendChild(pageSpan);
                } else {
                    const displayName = `@${connection.username || connection.displayName || 'user'}`;
                    statusEl.textContent = `Connected as ${displayName}`;
                }
            }
            if (btn) {
                btn.textContent = 'Disconnect';
                btn.classList.remove('connect-btn');
                btn.classList.add('disconnect-btn');
                btn.onclick = () => disconnectPlatform(platform, connection.id);
            }
        } else {
            if (card) card.classList.remove('connected');
            if (statusEl) {
                statusEl.textContent = 'Not connected';
                statusEl.classList.remove('text-green-400');
                statusEl.classList.add('text-gray-400');
            }
            if (btn) {
                btn.textContent = 'Connect';
                btn.classList.remove('disconnect-btn');
                btn.classList.add('connect-btn');
                // Telegram and WhatsApp use modals instead of OAuth redirect
                if (platform === 'telegram') {
                    btn.onclick = () => openTelegramModal();
                } else if (platform === 'whatsapp') {
                    btn.onclick = () => openWhatsAppModal();
                } else {
                    btn.onclick = () => connectPlatform(platform);
                }
            }
        }
    });

    // Update connection count badge
    // Total connectable platforms: Twitter, LinkedIn, Reddit, Telegram, WhatsApp, Instagram, TikTok, YouTube = 8
    const connectionCount = document.getElementById('connectionCount');
    if (connectionCount) {
        connectionCount.textContent = `${connectedCount}/${platforms.length}`;
        if (connectedCount > 0) {
            connectionCount.classList.remove('bg-gray-700');
            connectionCount.classList.add('bg-green-500/20', 'text-green-400');
        }
    }

    // Update connected platforms count in dashboard
    const connectedPlatforms = document.getElementById('connectedPlatforms');
    if (connectedPlatforms) {
        connectedPlatforms.textContent = connectedCount;
    }

    // Hide hint if user has connections
    const connectionsHint = document.getElementById('connectionsHint');
    if (connectionsHint && connectedCount > 0) {
        connectionsHint.classList.add('hidden');
    }

    // Update agent status based on connections
    updateAgentStatus();
}

function updateAgentStatus() {
    const freeUserState = document.getElementById('freeUserState');
    const activeUserState = document.getElementById('activeUserState');
    const launchAgentBtn = document.getElementById('launchAgentBtn');
    const launchHint = document.getElementById('launchHint');

    if (!currentUser) return;

    const tier = currentUser.subscription?.tier || 'free';
    const isPaidUser = tier !== 'free';
    const hasConnections = connections.length > 0;
    const isAgentActive = isPaidUser && hasConnections && currentUser.automation?.enabled;

    if (isAgentActive) {
        // Show active agent state
        if (freeUserState) freeUserState.classList.add('hidden');
        if (activeUserState) activeUserState.classList.remove('hidden');
    } else {
        // Show launch agent state
        if (freeUserState) freeUserState.classList.remove('hidden');
        if (activeUserState) activeUserState.classList.add('hidden');

        // Update hint based on what's missing
        if (launchHint) {
            if (!isPaidUser && !hasConnections) {
                launchHint.textContent = 'Connect a social platform and upgrade to get started';
            } else if (!isPaidUser) {
                launchHint.textContent = 'Upgrade your plan to activate the agent';
            } else if (!hasConnections) {
                launchHint.textContent = 'Connect at least one social platform to get started';
            } else {
                launchHint.textContent = 'Click to configure and activate your agent';
            }
        }
    }
}

function setupEventHandlers() {
    // Logout button
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            const token = localStorage.getItem('token');
            try {
                await fetch('/auth/logout', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'X-CSRF-Token': getCsrfToken()
                    }
                });
            } catch (error) {
                console.error('Logout error:', error);
            } finally {
                localStorage.removeItem('token');
                localStorage.removeItem('user');
                window.location.href = '/';
            }
        });
    }

    // Launch Agent button
    const launchAgentBtn = document.getElementById('launchAgentBtn');
    if (launchAgentBtn) {
        launchAgentBtn.addEventListener('click', () => {
            const tier = currentUser?.subscription?.tier || 'free';
            const isPaidUser = tier !== 'free';
            const hasConnections = connections.length > 0;

            if (!hasConnections) {
                // Redirect to connections tab
                showTab('connections');
            } else if (!isPaidUser) {
                // Redirect to subscription tab
                showTab('subscription');
            } else {
                // Redirect to settings/agent configuration
                window.location.href = '/settings.html';
            }
        });
    }
}

function highlightCurrentPlan(tier) {
    // Handle free tier card badge visibility
    const freeCard = document.getElementById('plan-card-free');
    if (freeCard) {
        const freeBadge = freeCard.querySelector('.bg-green-100');
        if (freeBadge) {
            freeBadge.style.display = tier === 'free' ? '' : 'none';
        }
    }

    const plans = ['starter', 'growth', 'business'];
    plans.forEach(plan => {
        const card = document.getElementById(`plan-card-${plan}`);
        if (card) {
            if (plan === tier) {
                card.classList.add('current');
                const btn = card.querySelector('button');
                if (btn) {
                    btn.textContent = 'Current Plan';
                    btn.disabled = true;
                }
            } else {
                card.classList.remove('current');
            }
        }
    });
}

// Toggle subscription panel expand/collapse
function toggleSubscriptionPanel(forceOpen) {
    const panel = document.getElementById('subscriptionPanel');
    const chevron = document.getElementById('subscriptionChevron');
    const label = document.getElementById('subscriptionExpandLabel');
    if (!panel) return;
    const shouldOpen = forceOpen === true || (forceOpen === undefined && panel.classList.contains('hidden'));
    if (shouldOpen) {
        panel.classList.remove('hidden');
        if (chevron) chevron.style.transform = 'rotate(180deg)';
        if (label) label.textContent = 'Close';
    } else {
        panel.classList.add('hidden');
        if (chevron) chevron.style.transform = '';
        if (label) label.textContent = 'Manage Plan';
    }
}

// Tab navigation
function showTab(tabName) {
    // Subscription is now embedded in the agents tab
    if (tabName === 'subscription') {
        tabName = 'agents';
        requestAnimationFrame(() => toggleSubscriptionPanel(true));
    }

    // Scope to profile-level tabs only (exclude marketing sub-tabs)
    const tabsWrapper = document.getElementById('tabsScrollWrapper');

    // Hide all profile-level tab contents
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.add('hidden');
    });

    // Remove active class from profile-level tab buttons only
    if (tabsWrapper) {
        tabsWrapper.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.remove('tab-active');
        });
    }

    // Show selected tab content
    const selectedContent = document.getElementById(`content-${tabName}`);
    if (selectedContent) {
        selectedContent.classList.remove('hidden');
    }

    // Add active class to selected tab
    const selectedTab = document.getElementById(`tab-${tabName}`);
    if (selectedTab) {
        selectedTab.classList.add('tab-active');
    }

    // Update URL without reload
    const url = new URL(window.location);
    url.searchParams.set('tab', tabName);
    window.history.replaceState({}, '', url);

    // Load analytics dashboard when analytics tab is shown
    if (tabName === 'analytics' && typeof window.loadAnalyticsSection === 'function') {
        window.loadAnalyticsSection();
    }
}

// Connect platform
async function connectPlatform(platform) {
    const token = localStorage.getItem('token');

    try {
        const response = await fetch(`/api/connections/${platform}/initiate`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (response.ok) {
            const data = await response.json();
            if (data.authUrl) {
                // Redirect to OAuth authorization
                window.location.href = data.authUrl;
            }
        } else {
            const error = await response.json();
            alert(error.error || `Failed to connect ${platform}`);
        }
    } catch (error) {
        console.error(`Error connecting ${platform}:`, error);
        alert(`Failed to connect ${platform}. Please try again.`);
    }
}

// Disconnect platform
async function disconnectPlatform(platform, connectionId) {
    if (!confirm(`Are you sure you want to disconnect ${platform}?`)) {
        return;
    }

    const token = localStorage.getItem('token');

    try {
        const response = await fetch(`/api/connections/${platform}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${token}`,
                'X-CSRF-Token': getCsrfToken()
            }
        });

        if (response.ok) {
            // Reload connections
            await loadConnections();
        } else {
            const error = await response.json();
            alert(error.error || `Failed to disconnect ${platform}`);
        }
    } catch (error) {
        console.error(`Error disconnecting ${platform}:`, error);
        alert(`Failed to disconnect ${platform}. Please try again.`);
    }
}

// ============================================
// Page Selector for Meta Platforms (Facebook/Instagram)
// ============================================

let pageSelectorActive = null;

/**
 * Open the page selector dropdown for a Meta platform connection.
 * Fetches fresh page list from the Graph API and renders a dropdown.
 */
async function openPageSelector(platform, connection) {
    // Close any existing selector
    closePageSelector();

    const statusEl = document.getElementById(`${platform}-status`);
    if (!statusEl) return;

    // Use the clickable page name span as anchor for positioning
    const anchor = statusEl.querySelector('span') || statusEl;
    const rect = anchor.getBoundingClientRect();

    // Create dropdown as a fixed-position popover on document.body
    // (platform-card has overflow:hidden which clips absolute children)
    const dropdown = document.createElement('div');
    dropdown.id = 'pageSelectorDropdown';
    dropdown.style.cssText = `position:fixed; left:${rect.left}px; top:${rect.bottom + 6}px; z-index:9999;`;
    dropdown.className = 'w-72 bg-white border border-surface-200 rounded-xl shadow-lg overflow-hidden';

    const headerLabel = platform === 'facebook' ? 'Facebook Pages' : 'Instagram Accounts';
    dropdown.innerHTML = `
        <div class="px-3 py-2 border-b border-surface-100 bg-surface-50">
            <p class="text-xs font-medium text-ink-400 uppercase tracking-wider">${headerLabel}</p>
        </div>
        <div id="pageSelectorContent" class="px-3 py-3 text-center">
            <span class="text-sm text-ink-400 animate-pulse">Loading pages...</span>
        </div>
    `;

    document.body.appendChild(dropdown);

    // Ensure dropdown doesn't overflow below viewport
    requestAnimationFrame(() => {
        const dropdownRect = dropdown.getBoundingClientRect();
        if (dropdownRect.bottom > window.innerHeight) {
            // Position above the anchor instead
            dropdown.style.top = `${rect.top - dropdownRect.height - 6}px`;
        }
        // Ensure it doesn't overflow right
        if (dropdownRect.right > window.innerWidth) {
            dropdown.style.left = `${window.innerWidth - dropdownRect.width - 12}px`;
        }
    });

    pageSelectorActive = platform;

    // Close on outside click (deferred so the current click doesn't close it)
    setTimeout(() => {
        document.addEventListener('click', handlePageSelectorOutsideClick);
    }, 0);

    // Close on scroll or resize (fixed-position dropdown would drift)
    window.addEventListener('scroll', closePageSelector, true);
    window.addEventListener('resize', closePageSelector);

    // Fetch pages
    try {
        const token = localStorage.getItem('token');
        const response = await fetch(`/api/connections/${platform}/pages`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();
        const contentEl = document.getElementById('pageSelectorContent');
        if (!contentEl) return;

        if (!data.success) {
            contentEl.innerHTML = `<p class="text-sm text-red-500">${escapeHtml(data.error || 'Failed to load pages')}</p>`;
            return;
        }

        if (!data.pages || data.pages.length === 0) {
            contentEl.innerHTML = `<p class="text-sm text-ink-400">${escapeHtml(data.message || 'No pages found. Ensure you granted page access during authorization.')}</p>`;
            return;
        }

        // Build the list
        const list = document.createElement('div');
        list.className = 'max-h-48 overflow-y-auto';

        if (platform === 'facebook') {
            list.innerHTML = data.pages.map(page => `
                <button onclick="selectPage('facebook', '${escapeHtml(page.id)}')"
                    class="w-full text-left px-3 py-2.5 hover:bg-surface-50 transition-colors flex items-center justify-between gap-2 ${page.isActive ? 'bg-brand-50' : ''}">
                    <div class="flex items-center gap-2.5 min-w-0">
                        ${page.pictureUrl ? `<img src="${escapeHtml(page.pictureUrl)}" class="w-7 h-7 rounded-lg flex-shrink-0 object-cover" alt="">` : `<div class="w-7 h-7 rounded-lg bg-[#1877F2]/10 flex items-center justify-center flex-shrink-0"><span class="text-xs text-[#1877F2] font-bold">${escapeHtml(page.name.charAt(0))}</span></div>`}
                        <p class="text-sm font-medium text-ink-700 truncate">${escapeHtml(page.name)}</p>
                    </div>
                    ${page.isActive ? '<svg class="w-4 h-4 text-green-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>' : ''}
                </button>
            `).join('');
        } else {
            // Instagram: show IG username with page name subtitle
            list.innerHTML = data.pages.map(page => `
                <button onclick="selectPage('instagram', '${escapeHtml(page.pageId)}')"
                    class="w-full text-left px-3 py-2.5 hover:bg-surface-50 transition-colors flex items-center justify-between gap-2 ${page.isActive ? 'bg-brand-50' : ''}">
                    <div class="flex items-center gap-2.5 min-w-0">
                        ${page.igAccount.profilePictureUrl ? `<img src="${escapeHtml(page.igAccount.profilePictureUrl)}" class="w-7 h-7 rounded-full flex-shrink-0 object-cover" alt="">` : `<div class="w-7 h-7 rounded-full bg-[#E4405F]/10 flex items-center justify-center flex-shrink-0"><span class="text-xs text-[#E4405F] font-bold">${escapeHtml((page.igAccount.username || '?').charAt(0))}</span></div>`}
                        <div class="min-w-0">
                            <p class="text-sm font-medium text-ink-700 truncate">@${escapeHtml(page.igAccount.username)}</p>
                            <p class="text-xs text-ink-400 truncate">via ${escapeHtml(page.pageName)}</p>
                        </div>
                    </div>
                    ${page.isActive ? '<svg class="w-4 h-4 text-green-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>' : ''}
                </button>
            `).join('');
        }

        contentEl.replaceWith(list);
    } catch (error) {
        console.error('Error loading pages:', error);
        const contentEl = document.getElementById('pageSelectorContent');
        if (contentEl) {
            contentEl.innerHTML = `<p class="text-sm text-red-500">Failed to load pages. Please try again.</p>`;
        }
    }
}

function handlePageSelectorOutsideClick(e) {
    const dropdown = document.getElementById('pageSelectorDropdown');
    if (dropdown && !dropdown.contains(e.target) && !e.target.closest('.page-selector-trigger')) {
        closePageSelector();
    }
}

function closePageSelector() {
    const dropdown = document.getElementById('pageSelectorDropdown');
    if (dropdown) dropdown.remove();
    pageSelectorActive = null;
    document.removeEventListener('click', handlePageSelectorOutsideClick);
    window.removeEventListener('scroll', closePageSelector, true);
    window.removeEventListener('resize', closePageSelector);
}

/**
 * Switch the active page for a Meta platform connection.
 * Calls the PATCH endpoint and refreshes the UI on success.
 */
async function selectPage(platform, pageId) {
    const token = localStorage.getItem('token');
    const dropdown = document.getElementById('pageSelectorDropdown');

    // Show loading state
    if (dropdown) {
        const list = dropdown.querySelector('.max-h-48') || dropdown.querySelector('#pageSelectorContent');
        if (list) {
            list.innerHTML = `
                <div class="px-3 py-3 text-center">
                    <span class="text-sm text-ink-400 animate-pulse">Switching page...</span>
                </div>
            `;
        }
    }

    try {
        const response = await fetch(`/api/connections/${platform}/active-page`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'X-CSRF-Token': getCsrfToken()
            },
            body: JSON.stringify({ pageId })
        });

        const data = await response.json();

        if (data.success) {
            closePageSelector();
            // Reload connections to reflect the change
            await loadConnections();
        } else {
            if (dropdown) {
                const list = dropdown.querySelector('.max-h-48') || dropdown.querySelector('#pageSelectorContent');
                if (list) {
                    list.innerHTML = `
                        <div class="px-3 py-3">
                            <p class="text-sm text-red-500">${escapeHtml(data.error || 'Failed to switch page')}</p>
                        </div>
                    `;
                }
            }
        }
    } catch (error) {
        console.error('Error selecting page:', error);
        if (dropdown) {
            const list = dropdown.querySelector('.max-h-48') || dropdown.querySelector('#pageSelectorContent');
            if (list) {
                list.innerHTML = `
                    <div class="px-3 py-3">
                        <p class="text-sm text-red-500">Network error. Please try again.</p>
                    </div>
                `;
            }
        }
    }
}

// Select plan - initiates Lemon Squeezy checkout or plan change
async function selectPlan(plan) {
    const token = localStorage.getItem('token');
    if (!token) {
        window.location.href = '/auth.html';
        return;
    }

    // Map frontend plan names to backend tier names
    const tierMap = {
        'basic': 'starter',
        'starter': 'starter',
        'pro': 'growth',
        'growth': 'growth',
        'enterprise': 'business',
        'business': 'business'
    };

    const tier = tierMap[plan.toLowerCase()] || plan.toLowerCase();
    const currentTier = currentUser?.subscription?.tier || 'free';

    // Check if user already has a paid subscription (not free)
    const hasActiveSubscription = currentTier !== 'free' &&
                                   currentUser?.subscription?.status === 'active';

    // Show loading state on the clicked button
    const planCard = document.getElementById(`plan-card-${plan}`);
    const button = planCard?.querySelector('button');
    const originalText = button?.innerHTML;
    if (button) {
        button.disabled = true;
        button.innerHTML = '<span class="animate-pulse">Processing...</span>';
    }

    // Check if test mode is enabled
    try {
        const testResponse = await fetch('/api/test/mode');
        if (testResponse.ok) {
            const testData = await testResponse.json();
            if (testData.testMode) {
                // Test mode: simulate successful payment
                if (confirm(`Test Mode: Simulate payment for ${tier} plan?`)) {
                    const subResponse = await fetch('/api/subscriptions/test-activate', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`,
                            'X-CSRF-Token': getCsrfToken()
                        },
                        body: JSON.stringify({ tier: tier })
                    });

                    if (subResponse.ok) {
                        alert('Test payment successful!');
                        await loadUserProfile();
                        showPaymentSuccessMessage(tier);
                    } else {
                        const error = await subResponse.json();
                        alert('Failed to activate subscription: ' + (error.error || 'Unknown error'));
                    }
                }
                // Reset button
                if (button) {
                    button.disabled = false;
                    button.innerHTML = originalText;
                }
                return;
            }
        }
    } catch (error) {
        console.log('Could not check test mode, proceeding with live checkout');
    }

    // If user has an active subscription, use the change-plan endpoint
    if (hasActiveSubscription) {
        try {
            // Confirm the change with the user
            const tierNames = {
                'starter': 'Starter ($25/mo)',
                'growth': 'Growth ($75/mo)',
                'business': 'Business ($250/mo)'
            };
            const isUpgrade = getPlanIndex(tier) > getPlanIndex(currentTier);
            const actionText = isUpgrade ? 'upgrade' : 'change';

            if (!confirm(`Are you sure you want to ${actionText} to ${tierNames[tier]}?\n\nThe change will take effect at the start of your next billing cycle.`)) {
                if (button) {
                    button.disabled = false;
                    button.innerHTML = originalText;
                }
                return;
            }

            const response = await fetch('/api/subscriptions/change-plan', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                    'X-CSRF-Token': getCsrfToken()
                },
                body: JSON.stringify({ tier: tier })
            });

            const data = await response.json();

            if (response.ok && data.success) {
                // Show success notification with effective date
                showPlanChangeNotification(data.message, data.isUpgrade);
                // Reload profile to show pending change
                await loadUserProfile();
            } else {
                alert(data.error || 'Failed to change plan. Please try again.');
            }

            // Reset button
            if (button) {
                button.disabled = false;
                button.innerHTML = originalText;
            }
            return;
        } catch (error) {
            console.error('Plan change error:', error);
            alert('An error occurred while changing your plan. Please try again.');
            if (button) {
                button.disabled = false;
                button.innerHTML = originalText;
            }
            return;
        }
    }

    // New subscription - Production checkout flow via Lemon Squeezy (embedded popup)
    try {
        const response = await fetch('/api/subscriptions/create-checkout', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'X-CSRF-Token': getCsrfToken()
            },
            body: JSON.stringify({ tier: tier })
        });

        const data = await response.json();

        if (response.ok && data.checkoutUrl) {
            // Show compact checkout popup (same as marketing tab payments)
            if (typeof showCompactCheckout === 'function') {
                const anchorEl = button || planCard || document.body;
                const paid = await showCompactCheckout(data.checkoutUrl, anchorEl, { direction: 'down' });
                if (paid) {
                    showPaymentSuccessMessage(tier);
                    await loadUserProfile();
                }
            } else {
                // Fallback to redirect if marketing.js not loaded
                window.location.href = data.checkoutUrl;
            }
        } else {
            console.error('Checkout error:', data);
            alert(data.error || 'Failed to create checkout session. Please try again.');
        }
    } catch (error) {
        console.error('Checkout error:', error);
        alert('An error occurred during checkout. Please try again.');
    } finally {
        // Reset button
        if (button) {
            button.disabled = false;
            button.innerHTML = originalText;
        }
    }
}

// ============================================
// Telegram Modal Functions
// ============================================
let telegramBotUsername = null;

async function openTelegramModal() {
    const modal = document.getElementById('telegramModal');
    const botDisplay = document.getElementById('botUsernameDisplay');
    const errorDiv = document.getElementById('telegramError');
    const input = document.getElementById('telegramChannelInput');

    // Reset state
    if (errorDiv) errorDiv.classList.add('hidden');
    if (input) input.value = '';

    // Show modal
    modal.classList.remove('hidden');
    modal.classList.add('flex');

    // Fetch bot info if not already loaded
    if (!telegramBotUsername) {
        try {
            const response = await fetch('/api/connections/telegram/bot-info');
            const data = await response.json();

            if (data.success && data.configured) {
                telegramBotUsername = data.bot.username;
                if (botDisplay) botDisplay.textContent = telegramBotUsername;
            } else {
                if (botDisplay) botDisplay.textContent = 'Bot not configured';
                showTelegramError('Telegram integration is not available');
            }
        } catch (error) {
            console.error('Error fetching bot info:', error);
            if (botDisplay) botDisplay.textContent = 'Error loading';
        }
    } else {
        if (botDisplay) botDisplay.textContent = telegramBotUsername;
    }
}

function closeTelegramModal() {
    const modal = document.getElementById('telegramModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
}

function showTelegramError(message) {
    const errorDiv = document.getElementById('telegramError');
    const errorText = document.getElementById('telegramErrorText');
    if (errorDiv && errorText) {
        errorText.textContent = message;
        errorDiv.classList.remove('hidden');
    }
}

async function connectTelegram() {
    const token = localStorage.getItem('token');
    const input = document.getElementById('telegramChannelInput');
    const btn = document.getElementById('telegramConnectBtn');
    const errorDiv = document.getElementById('telegramError');

    const channelIdentifier = input.value.trim();

    if (!channelIdentifier) {
        showTelegramError('Please enter a channel username or chat ID');
        return;
    }

    // Hide previous error
    if (errorDiv) errorDiv.classList.add('hidden');

    // Show loading state
    const originalText = btn.textContent;
    btn.textContent = 'Connecting...';
    btn.disabled = true;

    try {
        const response = await fetch('/api/connections/telegram', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'X-CSRF-Token': getCsrfToken()
            },
            body: JSON.stringify({ channelIdentifier })
        });

        const data = await response.json();

        if (data.success) {
            closeTelegramModal();
            await loadConnections();  // Refresh connection list
        } else {
            showTelegramError(data.error || 'Failed to connect channel');
        }
    } catch (error) {
        console.error('Error connecting Telegram:', error);
        showTelegramError('Connection failed. Please try again.');
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
}

// ============================================
// WhatsApp Modal Functions
// ============================================
let whatsappPhoneNumber = null;
let whatsappVerificationCode = null;
let whatsappCodeExpiresAt = null;

async function openWhatsAppModal() {
    const modal = document.getElementById('whatsappModal');

    // Reset modal state
    resetWhatsAppModal();

    // Show modal with loading state
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    document.getElementById('whatsappLoading').classList.remove('hidden');
    document.getElementById('whatsappCancelBtn').classList.add('hidden');

    // Immediately fetch verification code + QR
    await getWhatsAppCode();
}

function closeWhatsAppModal() {
    const modal = document.getElementById('whatsappModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
}

function resetWhatsAppModal() {
    // Hide all pages
    const pages = ['whatsappLoading', 'whatsappPage1', 'whatsappPage2', 'whatsappGroupsSection', 'whatsappError', 'whatsappSuccess'];
    pages.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    });

    // Reset step indicator
    document.getElementById('whatsappStepDot1')?.classList.replace('bg-surface-300', 'bg-green-500');
    document.getElementById('whatsappStepDot2')?.classList.replace('bg-green-500', 'bg-surface-300');
    document.getElementById('whatsappStepIndicator')?.classList.remove('hidden');
    document.getElementById('whatsappCancelBtn')?.classList.remove('hidden');
}

function goToWhatsAppPage1() {
    document.getElementById('whatsappPage2').classList.add('hidden');
    document.getElementById('whatsappPage1').classList.remove('hidden');
    document.getElementById('whatsappStepDot1')?.classList.replace('bg-surface-300', 'bg-green-500');
    document.getElementById('whatsappStepDot2')?.classList.replace('bg-green-500', 'bg-surface-300');
}

function goToWhatsAppPage2() {
    document.getElementById('whatsappPage1').classList.add('hidden');
    document.getElementById('whatsappPage2').classList.remove('hidden');
    document.getElementById('whatsappStepDot1')?.classList.replace('bg-green-500', 'bg-surface-300');
    document.getElementById('whatsappStepDot2')?.classList.replace('bg-surface-300', 'bg-green-500');
}

function showWhatsAppError(message) {
    const errorDiv = document.getElementById('whatsappError');
    const errorText = document.getElementById('whatsappErrorText');
    if (errorDiv && errorText) {
        errorText.textContent = message;
        errorDiv.classList.remove('hidden');
    }
}

function showWhatsAppSuccess(message) {
    const successDiv = document.getElementById('whatsappSuccess');
    const successText = document.getElementById('whatsappSuccessText');
    if (successDiv && successText) {
        successText.textContent = message;
        successDiv.classList.remove('hidden');
    }
}

async function getWhatsAppCode() {
    const token = localStorage.getItem('token');

    try {
        const response = await fetch('/api/connections/whatsapp/initiate', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'X-CSRF-Token': getCsrfToken()
            }
        });

        const data = await response.json();

        if (data.success) {
            // Store the code and phone number
            whatsappPhoneNumber = data.phoneNumber;
            whatsappVerificationCode = data.verificationCode;
            whatsappCodeExpiresAt = new Date(data.expiresAt);

            // Populate Page 1 (Contact)
            document.getElementById('whatsappPhoneNumber').textContent = data.phoneNumber;
            document.getElementById('whatsappWaLink').href = data.waLink;
            document.getElementById('whatsappQrCode').src = data.qrCode;

            // Populate Page 2 (Verification Code)
            document.getElementById('whatsappPhoneNumberInstructions').textContent = data.phoneNumber;
            document.getElementById('whatsappVerificationCode').textContent = data.verificationCode;
            updateWhatsAppCodeExpiry();

            // Hide loading, show Page 1
            document.getElementById('whatsappLoading').classList.add('hidden');
            document.getElementById('whatsappPage1').classList.remove('hidden');
            document.getElementById('whatsappCancelBtn').classList.remove('hidden');
        } else {
            document.getElementById('whatsappLoading').classList.add('hidden');
            document.getElementById('whatsappCancelBtn').classList.remove('hidden');
            showWhatsAppError(data.error || 'Failed to generate verification code');
        }
    } catch (error) {
        console.error('Error getting WhatsApp code:', error);
        document.getElementById('whatsappLoading').classList.add('hidden');
        document.getElementById('whatsappCancelBtn').classList.remove('hidden');
        showWhatsAppError('Failed to generate code. Please try again.');
    }
}

function updateWhatsAppCodeExpiry() {
    if (!whatsappCodeExpiresAt) return;

    const expirySpan = document.getElementById('whatsappCodeExpiry');
    if (!expirySpan) return;

    const now = new Date();
    const diff = whatsappCodeExpiresAt - now;

    if (diff <= 0) {
        expirySpan.textContent = 'expired';
        return;
    }

    const minutes = Math.floor(diff / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    expirySpan.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;

    // Update every second
    setTimeout(updateWhatsAppCodeExpiry, 1000);
}

function copyWhatsAppCode(e) {
    if (!whatsappVerificationCode) return;

    navigator.clipboard.writeText(whatsappVerificationCode).then(() => {
        // Brief visual feedback
        const btn = e?.target?.closest('button') || document.querySelector('#whatsappCodeSection button[title="Copy code"]');
        if (btn) {
            btn.classList.add('bg-green-600');
            setTimeout(() => btn.classList.remove('bg-green-600'), 500);
        }
    }).catch(err => {
        console.error('Failed to copy:', err);
    });
}

async function checkWhatsAppStatus() {
    const token = localStorage.getItem('token');
    const btn = document.getElementById('whatsappCheckStatusBtn');
    const errorDiv = document.getElementById('whatsappError');
    const groupsSection = document.getElementById('whatsappGroupsSection');
    const groupsList = document.getElementById('whatsappGroupsList');

    // Hide previous messages
    if (errorDiv) errorDiv.classList.add('hidden');

    // Show loading state
    const originalText = btn.textContent;
    btn.textContent = 'Checking...';
    btn.disabled = true;

    try {
        const response = await fetch('/api/connections/whatsapp/pending', {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        const data = await response.json();

        if (data.success) {
            if (data.pending && data.pending.length > 0) {
                // Show detected groups
                groupsSection.classList.remove('hidden');
                groupsList.innerHTML = data.pending.map(group => `
                    <div class="flex items-center justify-between bg-gray-800 rounded-lg p-3">
                        <div>
                            <p class="font-medium text-white">${escapeHtml(group.groupName)}</p>
                            <p class="text-xs text-gray-400">${group.participantCount || 0} participants</p>
                        </div>
                        <button onclick="claimWhatsAppGroup('${group.id}')" class="px-3 py-1 bg-green-600 hover:bg-green-500 rounded text-sm font-medium transition-all">
                            Connect
                        </button>
                    </div>
                `).join('');
            } else {
                showWhatsAppError('No groups detected yet. Make sure you sent the verification code in your WhatsApp group.');
            }
        } else {
            showWhatsAppError(data.error || 'Failed to check status');
        }
    } catch (error) {
        console.error('Error checking WhatsApp status:', error);
        showWhatsAppError('Failed to check status. Please try again.');
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
}

async function claimWhatsAppGroup(pendingId) {
    const token = localStorage.getItem('token');

    try {
        const response = await fetch('/api/connections/whatsapp/claim', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'X-CSRF-Token': getCsrfToken()
            },
            body: JSON.stringify({ pendingId })
        });

        const data = await response.json();

        if (data.success) {
            showWhatsAppSuccess(`Connected to ${data.group.name}!`);
            // Hide pages and groups
            document.getElementById('whatsappPage2').classList.add('hidden');
            document.getElementById('whatsappGroupsSection').classList.add('hidden');
            document.getElementById('whatsappStepIndicator').classList.add('hidden');

            // Refresh connections and close modal after delay
            setTimeout(async () => {
                closeWhatsAppModal();
                await loadConnections();
            }, 1500);
        } else {
            showWhatsAppError(data.error || 'Failed to connect group');
        }
    } catch (error) {
        console.error('Error claiming WhatsApp group:', error);
        showWhatsAppError('Failed to connect group. Please try again.');
    }
}

// Helper function to escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Close Telegram modal on escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeTelegramModal();
        closeWhatsAppModal();
    }
});

// Close Telegram modal on background click
document.addEventListener('click', (e) => {
    if (e.target.id === 'telegramModal') {
        closeTelegramModal();
    }
    if (e.target.id === 'whatsappModal') {
        closeWhatsAppModal();
    }
    if (e.target.id === 'testResultModal') {
        closeTestModal();
    }
});

// ============================================
// Test Agent Functions (Try One Post)
// ============================================

async function testAgent() {
    const token = localStorage.getItem('token');
    const tryOneBtn = document.getElementById('tryOneBtn');
    const tryOneIcon = document.getElementById('tryOneIcon');

    // Check if user has any connections
    if (connections.length === 0) {
        alert('Please connect at least one social platform first.');
        showTab('connections');
        return;
    }

    // Show loading state
    if (tryOneBtn) tryOneBtn.disabled = true;
    if (tryOneIcon) tryOneIcon.innerHTML = '<svg class="animate-spin h-6 w-6" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>';

    try {
        console.log('Starting test post...');

        const response = await fetch('/api/posts/test', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'X-CSRF-Token': getCsrfToken()
            }
        });

        const result = await response.json();
        console.log('Test result:', result);

        // Show results in modal
        showTestResults(result, response.ok);

    } catch (error) {
        console.error('Test error:', error);
        showTestResults({
            success: false,
            error: 'Network error',
            message: error.message
        }, false);
    } finally {
        // Reset button state
        if (tryOneBtn) tryOneBtn.disabled = false;
        if (tryOneIcon) tryOneIcon.textContent = '🧪';
    }
}

function showTestResults(result, isSuccess) {
    const modal = document.getElementById('testResultModal');
    const content = document.getElementById('testResultContent');
    const title = document.getElementById('testModalTitle');

    // Set title based on success
    title.textContent = isSuccess && result.success ? '✅ Post Published!' : '⚠️ Test Results';

    // Build result HTML
    let html = '';

    if (result.success) {
        html += `
            <div class="mb-6 p-4 rounded-lg bg-green-500/10 border border-green-500/30">
                <p class="text-green-400 font-medium">${result.message}</p>
            </div>
        `;

        // Show generated content
        if (result.post) {
            html += `
                <div class="mb-6">
                    <h4 class="text-lg font-semibold text-purple-400 mb-2">Generated Content</h4>
                    <div class="p-4 rounded-lg bg-gray-900/50 border border-gray-700">
                        <p class="text-sm text-gray-400 mb-2">Topic: <span class="text-white">${result.post.topic}</span></p>
                        <p class="text-sm text-gray-400 mb-2">Tone: <span class="text-white">${result.post.tone}</span></p>
                        <p class="text-sm text-gray-400 mb-2">Source: <span class="text-white">${result.post.trend || 'Generated'}</span></p>
                        <div class="mt-4 p-3 bg-black/50 rounded-lg">
                            <p class="text-white whitespace-pre-wrap">${result.post.content}</p>
                        </div>
                    </div>
                </div>
            `;
        }

        // Show platform results
        if (result.results) {
            html += `<h4 class="text-lg font-semibold text-purple-400 mb-2">Platform Results</h4>`;

            const accounts = result.debug?.platformAccounts || {};

            if (result.results.success && result.results.success.length > 0) {
                html += `<div class="space-y-2 mb-4">`;
                result.results.success.forEach(r => {
                    const account = accounts[r.platform];
                    html += `
                        <div class="flex items-center gap-3 p-3 rounded-lg bg-green-500/10 border border-green-500/30">
                            <span class="text-green-400">✓</span>
                            <div class="flex flex-col">
                                <span class="text-white capitalize">${r.platform}</span>
                                ${account ? `<span class="text-xs text-gray-400">Posted as @${account}</span>` : ''}
                            </div>
                            ${r.url ? `<a href="${r.url}" target="_blank" class="text-cyan-400 text-sm hover:underline ml-auto">View Post →</a>` : ''}
                        </div>
                    `;
                });
                html += `</div>`;
            }

            if (result.results.failed && result.results.failed.length > 0) {
                html += `<div class="space-y-2">`;
                result.results.failed.forEach(r => {
                    const account = accounts[r.platform];
                    html += `
                        <div class="flex items-center gap-3 p-3 rounded-lg bg-red-500/10 border border-red-500/30">
                            <span class="text-red-400">✗</span>
                            <div class="flex flex-col">
                                <span class="text-white capitalize">${r.platform}</span>
                                ${account ? `<span class="text-xs text-gray-400">Account: @${account}</span>` : ''}
                            </div>
                            <span class="text-red-400 text-sm ml-auto">${r.error}</span>
                        </div>
                    `;
                });
                html += `</div>`;
            }
        }
    } else {
        // Error state
        html += `
            <div class="mb-6 p-4 rounded-lg bg-red-500/10 border border-red-500/30">
                <p class="text-red-400 font-medium">${result.message || result.error || 'Test failed'}</p>
            </div>
        `;

        if (result.step === 'connections') {
            html += `
                <div class="p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
                    <p class="text-yellow-400">You need to connect at least one social platform first.</p>
                    <button onclick="closeTestModal(); showTab('connections');" class="inline-block mt-3 px-4 py-2 bg-purple-500/20 border border-purple-500 rounded-lg text-purple-400 hover:bg-purple-500/30 transition-colors">
                        Connect Platforms →
                    </button>
                </div>
            `;
        }
    }

    // Debug info (collapsed by default)
    if (result.debug) {
        html += `
            <details class="mt-6">
                <summary class="cursor-pointer text-gray-400 hover:text-white">Debug Info</summary>
                <pre class="mt-2 p-3 rounded-lg bg-black/50 text-xs text-gray-400 overflow-x-auto">${JSON.stringify(result.debug, null, 2)}</pre>
            </details>
        `;
    }

    content.innerHTML = html;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function closeTestModal() {
    const modal = document.getElementById('testResultModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
}

// ============================================
// Agent Management Functions
// ============================================

async function loadAgents() {
    const token = localStorage.getItem('token');

    try {
        const response = await fetch('/api/agents', {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (response.ok) {
            const data = await response.json();
            agents = data.agents || [];
            agentLimit = data.limit === 'unlimited' ? -1 : data.limit;
            updateAgentsUI();
        }
    } catch (error) {
        console.error('Error loading agents:', error);
    }
}

async function loadAvailableConnections() {
    const token = localStorage.getItem('token');

    try {
        const response = await fetch('/api/agents/available-connections', {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (response.ok) {
            const data = await response.json();
            availableConnections = data.connections || [];
            return availableConnections;
        }
    } catch (error) {
        console.error('Error loading available connections:', error);
    }
    return [];
}

function updateAgentsUI() {
    // Update agent count badge
    const agentCountEl = document.getElementById('agentCount');
    if (agentCountEl) {
        const limitText = agentLimit === -1 ? '∞' : agentLimit;
        agentCountEl.textContent = `${agents.length}/${limitText}`;

        if (agents.length > 0) {
            agentCountEl.classList.remove('bg-gray-700');
            agentCountEl.classList.add('bg-purple-500/20', 'text-purple-400');
        } else {
            agentCountEl.classList.add('bg-gray-700');
            agentCountEl.classList.remove('bg-purple-500/20', 'text-purple-400');
        }
    }

    // Show/hide empty state
    const emptyState = document.getElementById('agentsEmptyState');
    const agentsGrid = document.getElementById('agentsGrid');

    if (agents.length === 0) {
        if (emptyState) emptyState.classList.remove('hidden');
        if (agentsGrid) agentsGrid.innerHTML = '';

        // Update empty message based on connections
        const emptyMsg = document.getElementById('agentsEmptyMessage');
        if (emptyMsg) {
            if (connections.filter(c => c.status === 'active').length === 0) {
                emptyMsg.textContent = 'Connect a social platform first, then create an agent to start posting';
            } else {
                emptyMsg.textContent = 'Create an agent to start posting to your connected platforms';
            }
        }
    } else {
        if (emptyState) emptyState.classList.add('hidden');
        renderAgentsGrid();
    }

    // Show/hide limit hint
    const limitHint = document.getElementById('agentLimitHint');
    const limitMsg = document.getElementById('agentLimitMessage');
    if (limitHint && agentLimit !== -1) {
        if (agents.length >= agentLimit) {
            limitHint.classList.remove('hidden');
            if (limitMsg) {
                limitMsg.textContent = `You've reached your agent limit (${agentLimit}). Upgrade your plan to create more agents.`;
            }
        } else {
            limitHint.classList.add('hidden');
        }
    }

    // Enable/disable create button based on limit
    const createBtn = document.getElementById('createAgentBtn');
    const createFirstBtn = document.getElementById('createFirstAgentBtn');
    const canCreate = agentLimit === -1 || agents.length < agentLimit;

    if (createBtn) {
        createBtn.disabled = !canCreate;
        if (!canCreate) {
            createBtn.classList.add('opacity-50', 'cursor-not-allowed');
        } else {
            createBtn.classList.remove('opacity-50', 'cursor-not-allowed');
        }
    }
    if (createFirstBtn) {
        createFirstBtn.disabled = !canCreate;
    }
}

function renderAgentsGrid() {
    const grid = document.getElementById('agentsGrid');
    if (!grid) return;

    const platformIcons = {
        twitter: `<svg class="w-6 h-6 text-[#1DA1F2]" fill="currentColor" viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`,
        linkedin: `<svg class="w-6 h-6 text-[#0A66C2]" fill="currentColor" viewBox="0 0 24 24"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>`,
        reddit: `<svg class="w-6 h-6 text-[#FF4500]" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.701z"/></svg>`,
        facebook: `<svg class="w-6 h-6 text-[#1877F2]" fill="currentColor" viewBox="0 0 24 24"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>`,
        telegram: `<svg class="w-6 h-6 text-[#0088cc]" fill="currentColor" viewBox="0 0 24 24"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>`
    };

    const platformColors = {
        twitter: 'bg-[#1DA1F2]/20',
        linkedin: 'bg-[#0A66C2]/20',
        reddit: 'bg-[#FF4500]/20',
        facebook: 'bg-[#1877F2]/20',
        telegram: 'bg-[#0088cc]/20'
    };

    grid.innerHTML = agents.map(agent => {
        const icon = platformIcons[agent.platform] || '';
        const bgColor = platformColors[agent.platform] || 'bg-surface-200';
        const statusColor = agent.status === 'active' ? 'text-green-700' : 'text-amber-700';
        const statusBg = agent.status === 'active' ? 'bg-green-50' : 'bg-amber-50';
        const lastPosted = agent.last_posted_at
            ? new Date(agent.last_posted_at).toLocaleDateString()
            : 'Never';

        // Check if test was already used (persisted server-side)
        const testUsed = !!agent.test_used_at;
        const testDisabled = agent.status !== 'active' || testUsed;
        const testButtonClass = testUsed
            ? 'bg-surface-200 text-ink-400 cursor-not-allowed'
            : 'bg-cyan-50 text-cyan-700 hover:bg-cyan-100 border border-cyan-200';
        const testButtonText = testUsed ? 'Used' : 'Test';

        return `
            <div class="platform-card rounded-xl p-6" id="agent-${agent.id}">
                <div class="flex items-center justify-between mb-4">
                    <div class="flex items-center gap-4">
                        <div class="w-12 h-12 rounded-xl ${bgColor} flex items-center justify-center">
                            ${icon}
                        </div>
                        <div>
                            <h4 class="font-semibold text-ink-800">${escapeHtml(agent.name)}</h4>
                            <div class="flex items-center gap-2">
                                <p class="text-sm text-ink-500 capitalize">${agent.platform}</p>
                                ${(agent.settings?.contentSource === 'affiliate_products')
                                    ? '<span class="text-[10px] bg-orange-50 text-orange-600 px-1.5 py-0.5 rounded font-medium">AE Affiliate</span>'
                                    : (agent.settings?.contentSource === 'brand_voice')
                                    ? '<span class="text-[10px] bg-purple-50 text-purple-600 px-1.5 py-0.5 rounded font-medium">Brand Voice</span>'
                                    : '<span class="text-[10px] bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded font-medium">News</span>'
                                }
                            </div>
                        </div>
                    </div>
                    <span class="${statusBg} ${statusColor} px-3 py-1 rounded-full text-xs font-medium capitalize">
                        ${agent.status}
                    </span>
                </div>

                <div class="grid grid-cols-2 gap-4 mb-4 text-sm">
                    <div>
                        <p class="text-ink-500">Posts Today</p>
                        <p class="font-medium text-ink-800">${agent.posts_today || 0}</p>
                    </div>
                    <div>
                        <p class="text-ink-500">Last Posted</p>
                        <p class="font-medium text-ink-800">${lastPosted}</p>
                    </div>
                </div>

                <div class="flex gap-2">
                    <button onclick="testAgentPost('${agent.id}')"
                            class="flex-1 py-2 rounded-lg ${testButtonClass} text-sm font-medium transition-all flex items-center justify-center gap-1"
                            ${testDisabled ? 'disabled' : ''}
                            title="${testUsed ? 'Test already used for this agent' : 'Test post to this platform'}">
                        <span>${testButtonText}</span>
                    </button>
                    <button onclick="window.location.href='${agent.settings?.contentSource === 'affiliate_products'
                            ? `/profile.html?tab=affiliate&editKeyword=${agent.settings?.affiliateSettings?.keywordSetIds?.[0] || ''}`
                            : `/settings.html?agent=${agent.id}`}'"
                            class="flex-1 py-2 rounded-lg bg-brand-50 text-brand-600 text-sm font-medium hover:bg-brand-100 border border-brand-200 transition-all">
                        Configure
                    </button>
                    <button onclick="toggleAgentStatus('${agent.id}', '${agent.status}')"
                            class="px-3 py-2 rounded-lg border border-surface-300 text-ink-500 text-sm hover:text-ink-700 hover:bg-surface-100 transition-all"
                            title="${agent.status === 'active' ? 'Pause' : 'Resume'}">
                        ${agent.status === 'active'
                            ? '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>'
                            : '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>'
                        }
                    </button>
                    <button onclick="deleteAgent('${agent.id}', '${escapeHtml(agent.name)}')"
                            class="px-3 py-2 rounded-lg border border-red-200 text-red-500 text-sm hover:bg-red-50 transition-all"
                            title="Delete">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                        </svg>
                    </button>
                </div>

                <!-- Test progress status line (hidden by default) -->
                <div id="agent-progress-${agent.id}"
                     class="test-progress-line mt-3 hidden"
                     aria-live="polite" aria-atomic="true">
                    <div class="flex items-center gap-2 px-1">
                        <span class="test-progress-dot"></span>
                        <span class="test-progress-text text-xs text-ink-500 font-medium"></span>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

async function openCreateAgentModal() {
    const modal = document.getElementById('createAgentModal');
    const select = document.getElementById('agentPlatformSelect');
    const nameInput = document.getElementById('agentNameInput');
    const errorDiv = document.getElementById('createAgentError');
    const noPlatformsWarning = document.getElementById('noPlatformsWarning');
    const submitBtn = document.getElementById('createAgentSubmitBtn');

    // Reset state
    if (errorDiv) errorDiv.classList.add('hidden');
    if (nameInput) nameInput.value = '';

    // Load available connections
    await loadAvailableConnections();

    // Populate select
    if (select) {
        select.innerHTML = '<option value="">Select a connected platform...</option>';

        if (availableConnections.length === 0) {
            if (noPlatformsWarning) noPlatformsWarning.classList.remove('hidden');
            if (submitBtn) submitBtn.disabled = true;
        } else {
            if (noPlatformsWarning) noPlatformsWarning.classList.add('hidden');
            if (submitBtn) submitBtn.disabled = false;

            availableConnections.forEach(conn => {
                const option = document.createElement('option');
                option.value = conn.id;
                option.textContent = `${conn.platform.charAt(0).toUpperCase() + conn.platform.slice(1)} - @${conn.username || conn.displayName || 'connected'}`;
                option.dataset.platform = conn.platform;
                select.appendChild(option);
            });
        }
    }

    // Show modal
    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
    }
}

function closeCreateAgentModal() {
    const modal = document.getElementById('createAgentModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
}

async function createAgent() {
    const token = localStorage.getItem('token');
    const select = document.getElementById('agentPlatformSelect');
    const nameInput = document.getElementById('agentNameInput');
    const errorDiv = document.getElementById('createAgentError');
    const errorText = document.getElementById('createAgentErrorText');
    const submitBtn = document.getElementById('createAgentSubmitBtn');

    const connectionId = select?.value;
    const name = nameInput?.value?.trim();

    // Validate
    if (!connectionId) {
        showCreateAgentError('Please select a platform');
        return;
    }
    if (!name) {
        showCreateAgentError('Please enter an agent name');
        return;
    }

    // Hide error
    if (errorDiv) errorDiv.classList.add('hidden');

    // Show loading
    const originalText = submitBtn.textContent;
    submitBtn.textContent = 'Creating...';
    submitBtn.disabled = true;

    try {
        const response = await fetch('/api/agents', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'X-CSRF-Token': getCsrfToken()
            },
            body: JSON.stringify({ connectionId, name })
        });

        const data = await response.json();

        if (data.success) {
            closeCreateAgentModal();
            await loadAgents();
            // Redirect to settings for the new agent
            window.location.href = `/settings.html?agent=${data.agent.id}`;
        } else {
            showCreateAgentError(data.error || 'Failed to create agent');
        }
    } catch (error) {
        console.error('Error creating agent:', error);
        showCreateAgentError('Network error. Please try again.');
    } finally {
        submitBtn.textContent = originalText;
        submitBtn.disabled = false;
    }
}

function showCreateAgentError(message) {
    const errorDiv = document.getElementById('createAgentError');
    const errorText = document.getElementById('createAgentErrorText');
    if (errorDiv && errorText) {
        errorText.textContent = message;
        errorDiv.classList.remove('hidden');
    }
}

async function toggleAgentStatus(agentId, currentStatus) {
    const token = localStorage.getItem('token');
    const newStatus = currentStatus === 'active' ? 'paused' : 'active';

    try {
        const response = await fetch(`/api/agents/${agentId}/status`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'X-CSRF-Token': getCsrfToken()
            },
            body: JSON.stringify({ status: newStatus })
        });

        if (response.ok) {
            await loadAgents();
        } else {
            const data = await response.json();
            alert(data.error || 'Failed to update agent status');
        }
    } catch (error) {
        console.error('Error toggling agent status:', error);
        alert('Failed to update agent status');
    }
}

async function deleteAgent(agentId, agentName) {
    if (!confirm(`Are you sure you want to delete "${agentName}"? This cannot be undone.`)) {
        return;
    }

    const token = localStorage.getItem('token');

    try {
        const response = await fetch(`/api/agents/${agentId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${token}`,
                'X-CSRF-Token': getCsrfToken()
            }
        });

        if (response.ok) {
            await loadAgents();
        } else {
            const data = await response.json();
            alert(data.error || 'Failed to delete agent');
        }
    } catch (error) {
        console.error('Error deleting agent:', error);
        alert('Failed to delete agent');
    }
}

async function testAgentPost(agentId) {
    const token = localStorage.getItem('token');
    const agentCard = document.getElementById(`agent-${agentId}`);
    const testBtn = agentCard?.querySelector('button');
    const progressContainer = document.getElementById(`agent-progress-${agentId}`);
    const progressText = progressContainer?.querySelector('.test-progress-text');
    const progressDot = progressContainer?.querySelector('.test-progress-dot');

    // Show loading state on button
    if (testBtn) {
        testBtn.disabled = true;
        testBtn.innerHTML = '<span class="loading-spinner"></span>';
    }

    // Show progress line with entrance animation
    if (progressContainer) {
        progressContainer.classList.remove('hidden', 'test-progress-exiting');
        // Force reflow to trigger CSS transition from max-height:0 to active state
        progressContainer.offsetHeight;
        progressContainer.classList.add('test-progress-active');
    }

    // Open SSE connection for real-time progress updates
    let eventSource = null;
    try {
        eventSource = new EventSource(`/api/agents/${agentId}/test/progress?token=${encodeURIComponent(token)}`);

        eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (progressText && data.message && data.phase !== 'connected') {
                    updateProgressText(progressText, progressDot, data.message, data.phase);
                }
            } catch (e) {
                console.warn('Failed to parse SSE event:', e);
            }
        };

        eventSource.onerror = () => {
            // Don't close immediately — the POST might still be in flight.
            // SSE will auto-reconnect or we close it when POST completes.
        };
    } catch (sseError) {
        console.warn('Failed to open SSE connection:', sseError);
        // Graceful degradation: test still proceeds without live progress
    }

    // Fire the actual test POST request
    // 15-minute abort timeout — video platforms (TikTok, YouTube) require video generation
    // which can take 5-10 minutes. Without an explicit timeout the browser/proxy may cut
    // the connection prematurely.
    const abortController = new AbortController();
    const fetchTimeoutId = setTimeout(() => abortController.abort(), 15 * 60 * 1000);
    try {
        const response = await fetch(`/api/agents/${agentId}/test`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'X-CSRF-Token': getCsrfToken()
            },
            signal: abortController.signal
        });
        clearTimeout(fetchTimeoutId);

        const result = await response.json();

        // Close SSE connection
        if (eventSource) {
            eventSource.close();
        }

        // Show final status briefly
        if (progressText) {
            const finalMessage = result.success
                ? 'Post published successfully!'
                : (result.error || 'Test completed');
            const finalPhase = result.success ? 'complete' : 'error';
            updateProgressText(progressText, progressDot, finalMessage, finalPhase);
        }

        // Show detailed results modal
        showAgentTestResults(result, response.ok);

        // Fade out progress line after delay
        setTimeout(() => {
            hideProgressLine(progressContainer);
        }, 3000);

    } catch (error) {
        clearTimeout(fetchTimeoutId);
        console.error('Agent test error:', error);

        if (eventSource) {
            eventSource.close();
        }

        const isTimeout = error.name === 'AbortError';
        if (progressText) {
            updateProgressText(progressText, progressDot,
                isTimeout ? 'Request timed out — video generation may have exceeded 15 minutes' : 'Network error occurred',
                'error'
            );
        }

        showAgentTestResults({
            success: false,
            error: 'Network error',
            message: error.message
        }, false);

        setTimeout(() => {
            hideProgressLine(progressContainer);
        }, 3000);

    } finally {
        if (testBtn) {
            testBtn.disabled = false;
            testBtn.innerHTML = '<span>Test</span>';
        }
        // Refresh agents to update post counts
        await loadAgents();
    }
}

/**
 * Animate progress text transition with a slide-up carousel effect.
 * Current text slides up and fades out, new text slides in from below.
 */
function updateProgressText(textElement, dotElement, newMessage, phase) {
    // Phase-to-dot-color mapping
    const phaseColors = {
        validating: '#60a5fa',  // blue-400
        trends:     '#818cf8',  // indigo-400
        generating: '#a78bfa',  // purple-400
        media:      '#f472b6',  // pink-400
        publishing: '#22d3ee',  // cyan-400
        saving:     '#2dd4bf',  // teal-400
        complete:   '#22c55e',  // green-500
        error:      '#ef4444',  // red-500
        timeout:    '#f59e0b'   // amber-500
    };

    // Update dot color
    if (dotElement) {
        dotElement.style.backgroundColor = phaseColors[phase] || '';
    }

    // Animate text: slide out current, slide in new
    textElement.classList.add('test-progress-text-exit');

    setTimeout(() => {
        textElement.textContent = newMessage;
        textElement.classList.remove('test-progress-text-exit');
        textElement.classList.add('test-progress-text-enter');

        setTimeout(() => {
            textElement.classList.remove('test-progress-text-enter');
        }, 300);
    }, 200);
}

/**
 * Fade out and hide the progress line with exit animation.
 */
function hideProgressLine(container) {
    if (!container) return;
    container.classList.add('test-progress-exiting');
    setTimeout(() => {
        container.classList.remove('test-progress-active', 'test-progress-exiting');
        container.classList.add('hidden');
    }, 400);
}

function showAgentTestResults(result, isSuccess) {
    const modal = document.getElementById('agentTestResultModal');
    const content = document.getElementById('agentTestResultContent');
    const title = document.getElementById('agentTestModalTitle');

    if (title) {
        title.textContent = isSuccess && result.success ? 'Post Published!' : 'Test Results';
    }

    let html = '';

    if (result.success) {
        html += `
            <div class="mb-6 p-4 rounded-lg bg-green-500/10 border border-green-500/30">
                <p class="text-green-400 font-medium">${result.message}</p>
            </div>
        `;

        if (result.agent) {
            html += `
                <div class="mb-4 p-3 rounded-lg bg-gray-900/50">
                    <p class="text-sm text-gray-400">Agent: <span class="text-white">${escapeHtml(result.agent.name)}</span></p>
                    <p class="text-sm text-gray-400">Platform: <span class="text-white capitalize">${result.agent.platform}</span></p>
                </div>
            `;
        }

        if (result.post) {
            html += `
                <div class="mb-6">
                    <h4 class="text-lg font-semibold text-purple-400 mb-2">Generated Content</h4>
                    <div class="p-4 rounded-lg bg-gray-900/50 border border-gray-700">
                        <p class="text-sm text-gray-400 mb-2">Topic: <span class="text-white">${escapeHtml(result.post.topic)}</span></p>
                        <p class="text-sm text-gray-400 mb-2">Trend: <span class="text-white">${escapeHtml(result.post.trend)}</span></p>
                        ${result.post.articleUrl ? `<p class="text-sm text-gray-400 mb-2">Source: <a href="${result.post.articleUrl}" target="_blank" rel="noopener noreferrer" class="text-blue-400 hover:text-blue-300 underline">${escapeHtml(result.post.trend)} ↗</a></p>` : ''}
                        <div class="mt-4 p-3 bg-black/50 rounded-lg">
                            <p class="text-white whitespace-pre-wrap">${escapeHtml(result.post.content)}</p>
                        </div>
                    </div>
                </div>
            `;
        }

        if (result.post?.videoUrl) {
            html += `
                <div class="mb-4 p-4 rounded-lg bg-gray-900/50 border border-gray-700">
                    <h4 class="text-sm font-semibold text-gray-300 mb-2">Generated Video</h4>
                    <div class="flex gap-3">
                        <a href="${result.post.videoUrl}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-2 px-4 py-2 bg-blue-500/20 border border-blue-500/50 rounded-lg text-blue-400 hover:bg-blue-500/30 transition-colors text-sm">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                            View Video
                        </a>
                        <a href="${result.post.videoUrl}" download class="inline-flex items-center gap-2 px-4 py-2 bg-gray-700/50 border border-gray-600 rounded-lg text-gray-300 hover:bg-gray-700 transition-colors text-sm">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
                            Download
                        </a>
                    </div>
                </div>
            `;
        }

        if (result.result?.url) {
            html += `
                <a href="${result.result.url}" target="_blank" class="inline-block px-4 py-2 bg-purple-500/20 border border-purple-500 rounded-lg text-purple-400 hover:bg-purple-500/30 transition-colors">
                    View Post →
                </a>
            `;
        }
    } else {
        html += `
            <div class="mb-6 p-4 rounded-lg bg-red-500/10 border border-red-500/30">
                <p class="text-red-400 font-medium">${result.message || result.error || 'Test failed'}</p>
            </div>
        `;

        if (result.step === 'status') {
            html += `
                <p class="text-gray-400">Activate the agent first to test posting.</p>
            `;
        } else if (result.step === 'test_limit') {
            html += `
                <p class="text-gray-400">Each agent can only be tested once. This test was already used.</p>
            `;
        }
    }

    if (content) content.innerHTML = html;

    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
    }
}

function closeAgentTestModal() {
    const modal = document.getElementById('agentTestResultModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
}

// Close modals on escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeCreateAgentModal();
        closeAgentTestModal();
    }
});

// Close modals on background click
document.addEventListener('click', (e) => {
    if (e.target.id === 'createAgentModal') {
        closeCreateAgentModal();
    }
    if (e.target.id === 'agentTestResultModal') {
        closeAgentTestModal();
    }
});

// ============================================
// Plan Helper Functions
// ============================================

// Get plan index for comparison (higher = more expensive)
function getPlanIndex(tier) {
    const planOrder = ['free', 'starter', 'growth', 'business'];
    return planOrder.indexOf(tier);
}

// Show plan change notification
function showPlanChangeNotification(message, isUpgrade) {
    const notification = document.createElement('div');
    notification.id = 'planChangeNotification';
    const borderColor = isUpgrade ? 'border-l-blue-500 border-blue-200' : 'border-l-amber-500 border-amber-200';
    const iconColor = isUpgrade ? 'text-blue-600' : 'text-amber-600';
    const iconBg = isUpgrade ? 'bg-blue-50' : 'bg-amber-50';
    const titleColor = isUpgrade ? 'text-blue-700' : 'text-amber-700';
    const title = isUpgrade ? 'Plan Upgrade Scheduled' : 'Plan Change Scheduled';

    notification.className = `fixed top-4 right-4 z-50 max-w-md p-6 rounded-xl bg-surface-0 border border-l-4 ${borderColor} shadow-2xl animate-slide-in`;
    notification.innerHTML = `
        <div class="flex items-start gap-4">
            <div class="flex-shrink-0 w-12 h-12 rounded-full ${iconBg} flex items-center justify-center">
                <svg class="w-6 h-6 ${iconColor}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
                </svg>
            </div>
            <div class="flex-1">
                <h3 class="text-lg font-semibold ${titleColor} mb-1">${title}</h3>
                <p class="text-ink-600 text-sm mb-3">${message}</p>
                <button onclick="closePlanChangeNotification()" class="text-sm ${titleColor} hover:opacity-80 transition-colors">
                    Got it
                </button>
            </div>
            <button onclick="closePlanChangeNotification()" class="text-ink-400 hover:text-ink-700 transition-colors">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                </svg>
            </button>
        </div>
    `;
    document.body.appendChild(notification);

    // Auto-dismiss after 10 seconds
    setTimeout(() => {
        closePlanChangeNotification();
    }, 10000);
}

function closePlanChangeNotification() {
    const notification = document.getElementById('planChangeNotification');
    if (notification) {
        notification.classList.add('animate-slide-out');
        setTimeout(() => notification.remove(), 300);
    }
}

// ============================================
// Payment Success/Cancel Handling
// ============================================

function showPaymentSuccessMessage(tier) {
    // Track purchase conversion
    if (typeof gtag === 'function') {
        const tierPrices = { starter: 25, growth: 75, business: 250 };
        const purchaseTier = tier || currentUser?.subscription?.tier || 'unknown';
        const value = tierPrices[purchaseTier] || 0;
        gtag('event', 'purchase', {
            currency: 'USD',
            value: value,
            items: [{ item_name: purchaseTier + '_plan', price: value }]
        });
        gtag('event', 'conversion', {
            send_to: 'AW-18053463418',
            value: value,
            currency: 'USD'
        });
    }
    // Create and show success notification
    const notification = document.createElement('div');
    notification.id = 'paymentSuccessNotification';
    notification.className = 'fixed top-4 right-4 z-50 max-w-md p-6 rounded-xl bg-surface-0 border border-l-4 border-l-green-500 border-green-200 shadow-2xl animate-slide-in';
    notification.innerHTML = `
        <div class="flex items-start gap-4">
            <div class="flex-shrink-0 w-12 h-12 rounded-full bg-green-50 flex items-center justify-center">
                <svg class="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
                </svg>
            </div>
            <div class="flex-1">
                <h3 class="text-lg font-semibold text-green-700 mb-1">Payment Successful!</h3>
                <p class="text-ink-600 text-sm mb-3" id="paymentSuccessText">Your subscription has been activated. Enjoy your new features!</p>
                <button onclick="closePaymentNotification()" class="text-sm text-green-600 hover:text-green-700 transition-colors">
                    Dismiss
                </button>
            </div>
            <button onclick="closePaymentNotification()" class="text-ink-400 hover:text-ink-700 transition-colors">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                </svg>
            </button>
        </div>
    `;
    document.body.appendChild(notification);

    // Auto-dismiss after 15 seconds
    setTimeout(() => {
        closePaymentNotification();
    }, 15000);

    // Poll for subscription update (webhook may take a few seconds)
    pollForSubscriptionUpdate();
}

// Poll for subscription update after payment
async function pollForSubscriptionUpdate() {
    const maxAttempts = 15; // Increased to allow more time for webhook
    const pollInterval = 2000; // 2 seconds between attempts
    let attempts = 0;
    const initialTier = currentUser?.subscription?.tier || 'free';

    console.log('[Payment] Starting subscription polling, initial tier:', initialTier);

    const poll = async () => {
        attempts++;
        const token = localStorage.getItem('token');

        console.log(`[Payment] Poll attempt ${attempts}/${maxAttempts}`);

        try {
            const response = await fetch('/api/users/profile', {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (response.ok) {
                const data = await response.json();
                const newTier = data.user?.subscription?.tier || 'free';
                const newStatus = data.user?.subscription?.status;

                console.log(`[Payment] Polled tier: ${newTier}, status: ${newStatus}`);

                // Check if subscription has been updated to a paid tier
                // For new users: initialTier is 'free', we're looking for any paid tier
                // For upgrades: initialTier is paid, we're looking for a different tier
                const hasPaidSubscription = newTier !== 'free' && (newStatus === 'active' || !newStatus);
                const tierChanged = newTier !== initialTier;

                if (hasPaidSubscription && tierChanged) {
                    console.log(`[Payment] Subscription updated! ${initialTier} -> ${newTier}`);
                    // Subscription updated! Refresh the UI
                    currentUser = data.user;
                    updateProfileUI();

                    // Update the success message
                    const successText = document.getElementById('paymentSuccessText');
                    if (successText) {
                        successText.textContent = `Your ${newTier.charAt(0).toUpperCase() + newTier.slice(1)} plan is now active!`;
                    }
                    return; // Stop polling
                }
            }
        } catch (error) {
            console.error('[Payment] Poll error:', error);
        }

        // Continue polling if not yet updated and haven't exceeded attempts
        if (attempts < maxAttempts) {
            setTimeout(poll, pollInterval);
        } else {
            console.log('[Payment] Max poll attempts reached, forcing profile reload');
            // Final attempt - just reload the profile anyway
            await loadUserProfile();
        }
    };

    // Start polling after initial delay (give webhook time to arrive)
    setTimeout(poll, 2000);
}

function showPaymentCancelledMessage() {
    // Create and show cancelled notification
    const notification = document.createElement('div');
    notification.id = 'paymentCancelledNotification';
    notification.className = 'fixed top-4 right-4 z-50 max-w-md p-6 rounded-xl bg-surface-0 border border-l-4 border-l-amber-500 border-amber-200 shadow-2xl animate-slide-in';
    notification.innerHTML = `
        <div class="flex items-start gap-4">
            <div class="flex-shrink-0 w-12 h-12 rounded-full bg-amber-50 flex items-center justify-center">
                <svg class="w-6 h-6 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>
                </svg>
            </div>
            <div class="flex-1">
                <h3 class="text-lg font-semibold text-amber-700 mb-1">Payment Cancelled</h3>
                <p class="text-ink-600 text-sm mb-3">No worries! You can upgrade anytime when you're ready.</p>
                <button onclick="closePaymentCancelledNotification()" class="text-sm text-amber-600 hover:text-amber-700 transition-colors">
                    Dismiss
                </button>
            </div>
            <button onclick="closePaymentCancelledNotification()" class="text-ink-400 hover:text-ink-700 transition-colors">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                </svg>
            </button>
        </div>
    `;
    document.body.appendChild(notification);

    // Auto-dismiss after 8 seconds
    setTimeout(() => {
        closePaymentCancelledNotification();
    }, 8000);
}

function closePaymentNotification() {
    const notification = document.getElementById('paymentSuccessNotification');
    if (notification) {
        notification.classList.add('animate-slide-out');
        setTimeout(() => notification.remove(), 300);
    }
}

function closePaymentCancelledNotification() {
    const notification = document.getElementById('paymentCancelledNotification');
    if (notification) {
        notification.classList.add('animate-slide-out');
        setTimeout(() => notification.remove(), 300);
    }
}

// ============================================
// Connection Success/Error Handling
// ============================================

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showConnectionSuccessMessage(platform, username) {
    const displayName = escapeHtml(platform.charAt(0).toUpperCase() + platform.slice(1));
    const usernameText = username ? ` as ${escapeHtml(username)}` : '';

    const notification = document.createElement('div');
    notification.id = 'connectionSuccessNotification';
    notification.className = 'fixed top-4 right-4 z-50 max-w-md p-6 rounded-xl bg-surface-0 border border-l-4 border-l-green-500 border-green-200 shadow-2xl animate-slide-in';
    notification.innerHTML = `
        <div class="flex items-start gap-4">
            <div class="flex-shrink-0 w-12 h-12 rounded-full bg-green-50 flex items-center justify-center">
                <svg class="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
                </svg>
            </div>
            <div class="flex-1">
                <h3 class="text-lg font-semibold text-green-700 mb-1">${displayName} Connected!</h3>
                <p class="text-ink-600 text-sm mb-3">Successfully connected to ${displayName}${usernameText}.</p>
                <button onclick="closeConnectionNotification()" class="text-sm text-green-600 hover:text-green-700 transition-colors">
                    Dismiss
                </button>
            </div>
            <button onclick="closeConnectionNotification()" class="text-ink-400 hover:text-ink-700 transition-colors">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                </svg>
            </button>
        </div>
    `;
    document.body.appendChild(notification);

    setTimeout(() => {
        closeConnectionNotification();
    }, 10000);
}

function showConnectionErrorMessage(platform, error) {
    const displayName = platform ? escapeHtml(platform.charAt(0).toUpperCase() + platform.slice(1)) : 'Platform';
    // Decode and clean up the error message for display
    const errorMessage = escapeHtml(decodeURIComponent(error).replace(/_/g, ' '));

    const notification = document.createElement('div');
    notification.id = 'connectionErrorNotification';
    notification.className = 'fixed top-4 right-4 z-50 max-w-md p-6 rounded-xl bg-surface-0 border border-l-4 border-l-red-500 border-red-200 shadow-2xl animate-slide-in';
    notification.innerHTML = `
        <div class="flex items-start gap-4">
            <div class="flex-shrink-0 w-12 h-12 rounded-full bg-red-50 flex items-center justify-center">
                <svg class="w-6 h-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>
                </svg>
            </div>
            <div class="flex-1">
                <h3 class="text-lg font-semibold text-red-700 mb-1">${displayName} Connection Failed</h3>
                <p class="text-ink-600 text-sm mb-3">${errorMessage}</p>
                <button onclick="closeConnectionNotification()" class="text-sm text-red-600 hover:text-red-700 transition-colors">
                    Dismiss
                </button>
            </div>
            <button onclick="closeConnectionNotification()" class="text-ink-400 hover:text-ink-700 transition-colors">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                </svg>
            </button>
        </div>
    `;
    document.body.appendChild(notification);

    setTimeout(() => {
        closeConnectionNotification();
    }, 15000);
}

function closeConnectionNotification() {
    const notification = document.getElementById('connectionSuccessNotification') || document.getElementById('connectionErrorNotification');
    if (notification) {
        notification.classList.add('animate-slide-out');
        setTimeout(() => notification.remove(), 300);
    }
}

// ============================================
// Subscription Management UI
// ============================================

function updateSubscriptionActions(tier) {
    const actionsContainer = document.getElementById('subscriptionActions');
    const cancelBtn = document.getElementById('cancelSubscriptionBtn');
    const manageBillingBtn = document.getElementById('manageBillingBtn');

    if (!actionsContainer) return;

    const isPaidUser = tier !== 'free';

    if (isPaidUser) {
        // Show subscription management actions for paid users
        actionsContainer.classList.remove('hidden');
        cancelBtn?.classList.remove('hidden');
        manageBillingBtn?.classList.remove('hidden');
    } else {
        // Free user - hide subscription management actions
        actionsContainer.classList.add('hidden');
    }
}

// ============================================
// Customer Portal (Lemon Squeezy)
// ============================================

async function openCustomerPortal() {
    const token = localStorage.getItem('token');

    // Show loading state
    const portalBtn = document.getElementById('manageBillingBtn');
    if (portalBtn) {
        portalBtn.disabled = true;
        portalBtn.innerHTML = '<span class="animate-pulse">Loading...</span>';
    }

    try {
        const response = await fetch('/api/subscriptions/portal', {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        const data = await response.json();

        if (response.ok && data.portalUrl) {
            window.open(data.portalUrl, '_blank');
        } else if (data.stale) {
            showToast('Unable to access billing portal. If this persists, please contact support.', 'error');
            await loadUserProfile();
        } else {
            showToast(data.error || 'Unable to access billing portal. Please try again.', 'error');
        }
    } catch (error) {
        console.error('Portal error:', error);
        showToast('Failed to open billing portal. Please try again.', 'error');
    } finally {
        if (portalBtn) {
            portalBtn.disabled = false;
            portalBtn.innerHTML = 'Manage Billing';
        }
    }
}

/**
 * Cancel subscription — presents a choice dialog:
 *   Option A: Cancel at period end (keep access until billing period ends, no refund)
 *   Option B: Cancel now & get pro-rata refund (immediate cancellation)
 */
async function cancelSubscription() {
    // Build and show the choice modal
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4';
    overlay.id = 'cancelChoiceOverlay';

    overlay.innerHTML = `
        <div class="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 space-y-5">
            <div class="text-center">
                <h3 class="text-lg font-semibold text-gray-900">Cancel Subscription</h3>
                <p class="text-sm text-gray-500 mt-1">Choose how you'd like to cancel your plan.</p>
            </div>

            <div class="space-y-3">
                <button id="cancelAtPeriodEndBtn"
                    class="w-full text-left p-4 rounded-xl border-2 border-gray-200 hover:border-blue-400 hover:bg-blue-50/50 transition-all group">
                    <div class="font-medium text-gray-900 group-hover:text-blue-700">Cancel at period end</div>
                    <p class="text-sm text-gray-500 mt-1">Keep access until your current billing period ends. No refund.</p>
                </button>

                <button id="cancelNowRefundBtn"
                    class="w-full text-left p-4 rounded-xl border-2 border-gray-200 hover:border-amber-400 hover:bg-amber-50/50 transition-all group">
                    <div class="font-medium text-gray-900 group-hover:text-amber-700">Cancel now & get refund</div>
                    <p class="text-sm text-gray-500 mt-1">Cancel immediately and receive a pro-rata refund for the remaining days.</p>
                </button>
            </div>

            <button id="cancelChoiceDismiss"
                class="w-full py-2.5 text-sm text-gray-500 hover:text-gray-700 transition-colors">
                Never mind, keep my plan
            </button>
        </div>
    `;

    document.body.appendChild(overlay);

    // Wire up buttons
    const dismiss = () => { overlay.remove(); };

    document.getElementById('cancelChoiceDismiss').onclick = dismiss;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(); });

    document.getElementById('cancelAtPeriodEndBtn').onclick = async () => {
        dismiss();
        await executeCancelAtPeriodEnd();
    };

    document.getElementById('cancelNowRefundBtn').onclick = async () => {
        dismiss();
        await executeCancelNowWithRefund();
    };
}

/**
 * Cancel at period end — PATCH cancelled:true via LS, then downgrade locally to free.
 */
async function executeCancelAtPeriodEnd() {
    const token = localStorage.getItem('token');
    const cancelBtn = document.getElementById('cancelSubscriptionBtn');

    if (cancelBtn) {
        cancelBtn.disabled = true;
        cancelBtn.innerHTML = '<span class="animate-pulse">Cancelling...</span>';
    }

    try {
        const response = await fetch('/api/subscriptions/cancel', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'X-CSRF-Token': getCsrfToken()
            }
        });

        const data = await response.json();

        if (response.ok) {
            showToast(data.message || 'Your subscription has been cancelled.', 'success');
            await loadUserProfile();
        } else if (data.stale) {
            showToast('Unable to cancel. If this persists, please contact support.', 'error');
            await loadUserProfile();
        } else {
            showToast(data.error || 'Failed to cancel subscription. Please try again.', 'error');
        }
    } catch (error) {
        console.error('Cancel error:', error);
        showToast('Failed to cancel subscription. Please try again.', 'error');
    } finally {
        if (cancelBtn) {
            cancelBtn.disabled = false;
            cancelBtn.innerHTML = 'Cancel Subscription';
        }
    }
}

/**
 * Cancel now with pro-rata refund — DELETE subscription via LS + issue partial refund.
 */
async function executeCancelNowWithRefund() {
    const token = localStorage.getItem('token');
    const cancelBtn = document.getElementById('cancelSubscriptionBtn');

    if (cancelBtn) {
        cancelBtn.disabled = true;
        cancelBtn.innerHTML = '<span class="animate-pulse">Processing refund...</span>';
    }

    try {
        const response = await fetch('/api/subscriptions/downgrade-to-free', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'X-CSRF-Token': getCsrfToken()
            }
        });

        const data = await response.json();

        if (response.ok) {
            const refundMsg = data.refundedAmount
                ? ` A refund of $${(data.refundedAmount / 100).toFixed(2)} has been issued.`
                : '';
            showToast(`Successfully cancelled and downgraded to Free plan.${refundMsg}`, 'success');
            await loadUserProfile();
        } else if (data.stale) {
            showToast('Unable to process cancellation. If this persists, please contact support.', 'error');
            await loadUserProfile();
        } else {
            showToast(data.error || 'Failed to cancel subscription. Please try again.', 'error');
        }
    } catch (error) {
        console.error('Cancel & refund error:', error);
        showToast('Failed to cancel subscription. Please try again.', 'error');
    } finally {
        if (cancelBtn) {
            cancelBtn.disabled = false;
            cancelBtn.innerHTML = 'Cancel Subscription';
        }
    }
}

// ============================================
// Beta Plan Modal Functions
// ============================================

// Track which plan the modal is currently showing
let currentBetaPlan = null;

function openBetaPlanModal(plan) {
    currentBetaPlan = plan;
    const modal = document.getElementById('betaPlanModal');
    const confirmationEl = document.getElementById('planInterestConfirmation');
    const interestBtn = document.getElementById('planInterestBtn');

    // Reset state
    if (confirmationEl) confirmationEl.classList.add('hidden');
    if (interestBtn) {
        interestBtn.disabled = false;
        interestBtn.innerHTML = '<span class="text-xl">+1</span><span>I want this!</span>';
    }

    // Show modal
    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
    }
}

function closeBetaPlanModal() {
    const modal = document.getElementById('betaPlanModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
    currentBetaPlan = null;
}

async function trackPlanInterest() {
    if (!currentBetaPlan) return;

    const token = localStorage.getItem('token');
    const interestBtn = document.getElementById('planInterestBtn');
    const confirmationEl = document.getElementById('planInterestConfirmation');

    // Show loading state
    if (interestBtn) {
        interestBtn.disabled = true;
        interestBtn.innerHTML = '<span class="loading-spinner"></span>';
    }

    try {
        const response = await fetch('/api/subscriptions/plan-interest', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'X-CSRF-Token': getCsrfToken()
            },
            body: JSON.stringify({ plan: currentBetaPlan })
        });

        const data = await response.json();

        // Show confirmation regardless of response (graceful degradation)
        if (confirmationEl) {
            confirmationEl.classList.remove('hidden');
        }
        if (interestBtn) {
            interestBtn.innerHTML = '<span class="text-xl">+1</span><span>Noted!</span>';
            interestBtn.disabled = true;
            interestBtn.style.opacity = '0.7';
        }

        console.log(`[PLAN-INTEREST] Tracked interest for plan: ${currentBetaPlan}`);

    } catch (error) {
        console.error('[PLAN-INTEREST] Error tracking interest:', error);
        // Still show confirmation for better UX (we don't want to discourage users)
        if (confirmationEl) {
            confirmationEl.classList.remove('hidden');
        }
        if (interestBtn) {
            interestBtn.innerHTML = '<span class="text-xl">+1</span><span>Noted!</span>';
        }
    }
}

// Close beta plan modal on escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeBetaPlanModal();
    }
});

// Close beta plan modal on background click
document.addEventListener('click', (e) => {
    if (e.target.id === 'betaPlanModal') {
        closeBetaPlanModal();
    }
});

// Make functions globally available
window.showTab = showTab;
window.toggleSubscriptionPanel = toggleSubscriptionPanel;
window.connectPlatform = connectPlatform;
window.disconnectPlatform = disconnectPlatform;
// Page selector functions (Facebook/Instagram)
window.openPageSelector = openPageSelector;
window.closePageSelector = closePageSelector;
window.selectPage = selectPage;
window.selectPlan = selectPlan;
window.openTelegramModal = openTelegramModal;
window.closeTelegramModal = closeTelegramModal;
window.connectTelegram = connectTelegram;
// WhatsApp functions
window.openWhatsAppModal = openWhatsAppModal;
window.closeWhatsAppModal = closeWhatsAppModal;
window.goToWhatsAppPage1 = goToWhatsAppPage1;
window.goToWhatsAppPage2 = goToWhatsAppPage2;
window.getWhatsAppCode = getWhatsAppCode;
window.copyWhatsAppCode = copyWhatsAppCode;
window.checkWhatsAppStatus = checkWhatsAppStatus;
window.claimWhatsAppGroup = claimWhatsAppGroup;
window.testAgent = testAgent;
window.closeTestModal = closeTestModal;
// Agent functions
window.openCreateAgentModal = openCreateAgentModal;
window.closeCreateAgentModal = closeCreateAgentModal;
window.createAgent = createAgent;
window.toggleAgentStatus = toggleAgentStatus;
window.deleteAgent = deleteAgent;
window.testAgentPost = testAgentPost;
window.closeAgentTestModal = closeAgentTestModal;
// Payment/billing functions
window.closePaymentNotification = closePaymentNotification;
window.closePaymentCancelledNotification = closePaymentCancelledNotification;
window.closePlanChangeNotification = closePlanChangeNotification;
window.openCustomerPortal = openCustomerPortal;
window.cancelSubscription = cancelSubscription;
// Beta plan modal functions
window.openBetaPlanModal = openBetaPlanModal;
window.closeBetaPlanModal = closeBetaPlanModal;
window.trackPlanInterest = trackPlanInterest;
