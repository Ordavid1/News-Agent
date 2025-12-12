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
        // Remove token from URL for security (preserve other params like tab)
        const cleanUrl = new URL(window.location);
        cleanUrl.searchParams.delete('token');
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

    // Load user data, connections, and agents
    await Promise.all([
        loadUserProfile(),
        loadConnections(),
        loadAgents()
    ]);

    // Setup event handlers
    setupEventHandlers();

    // Check URL params for tab navigation
    if (tab) {
        showTab(tab);
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

    if (subscriptionBadge && isPaidUser) {
        subscriptionBadge.textContent = tier.toUpperCase();
        subscriptionBadge.classList.remove('hidden');
    }

    // Update subscription info
    const currentPlanName = document.getElementById('currentPlanName');
    const postsRemaining = document.getElementById('postsRemaining');
    const subscriptionStatus = document.getElementById('subscriptionStatus');

    if (currentPlanName) {
        currentPlanName.textContent = tier.charAt(0).toUpperCase() + tier.slice(1);
    }

    if (postsRemaining) {
        const remaining = currentUser.subscription?.postsRemaining ?? 1;
        const limit = currentUser.subscription?.dailyLimit ?? 1;
        postsRemaining.textContent = `${remaining}/${limit}`;
    }

    if (subscriptionStatus) {
        if (isPaidUser) {
            subscriptionStatus.textContent = `Your ${tier} plan is active. You have access to all features.`;
        } else {
            subscriptionStatus.textContent = 'Upgrade to unlock unlimited posts and advanced features';
        }
    }

    // Update subscription management actions visibility
    updateSubscriptionActions(tier, currentUser.subscription);

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
    const platforms = ['twitter', 'linkedin', 'reddit', 'facebook', 'telegram'];
    let connectedCount = 0;

    platforms.forEach(platform => {
        const connection = connections.find(c => c.platform === platform);
        const card = document.getElementById(`platform-${platform}`);
        const statusEl = document.getElementById(`${platform}-status`);
        const btn = document.getElementById(`${platform}-btn`);

        if (connection && connection.status === 'active') {
            connectedCount++;
            if (card) card.classList.add('connected');
            if (statusEl) {
                statusEl.textContent = `Connected as @${connection.username || connection.displayName || 'user'}`;
                statusEl.classList.remove('text-gray-400');
                statusEl.classList.add('text-green-400');
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
                // Telegram uses a modal instead of OAuth redirect
                if (platform === 'telegram') {
                    btn.onclick = () => openTelegramModal();
                } else {
                    btn.onclick = () => connectPlatform(platform);
                }
            }
        }
    });

    // Update connection count badge
    // Total connectable platforms: Twitter, LinkedIn, Reddit, Telegram, Instagram, TikTok, YouTube = 7
    // (Facebook, Threads, WhatsApp are disabled/Coming Soon and not counted)
    const connectionCount = document.getElementById('connectionCount');
    if (connectionCount) {
        connectionCount.textContent = `${connectedCount}/7`;
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
    const plans = ['starter', 'growth', 'professional', 'business'];
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

// Tab navigation
function showTab(tabName) {
    // Hide all tab contents
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.add('hidden');
    });

    // Remove active class from all tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('tab-active');
    });

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
        'professional': 'professional',
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
                        showPaymentSuccessMessage();
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
                'starter': 'Starter ($49/mo)',
                'growth': 'Growth ($149/mo)',
                'professional': 'Professional ($399/mo)',
                'business': 'Business ($799/mo)'
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

    // New subscription - Production checkout flow via Lemon Squeezy
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
            // Redirect to Lemon Squeezy hosted checkout
            window.location.href = data.checkoutUrl;
        } else {
            console.error('Checkout error:', data);
            alert(data.error || 'Failed to create checkout session. Please try again.');
            // Reset button
            if (button) {
                button.disabled = false;
                button.innerHTML = originalText;
            }
        }
    } catch (error) {
        console.error('Checkout error:', error);
        alert('An error occurred during checkout. Please try again.');
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

// Close Telegram modal on escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeTelegramModal();
    }
});

// Close Telegram modal on background click
document.addEventListener('click', (e) => {
    if (e.target.id === 'telegramModal') {
        closeTelegramModal();
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
        const bgColor = platformColors[agent.platform] || 'bg-gray-700';
        const statusColor = agent.status === 'active' ? 'text-green-400' : 'text-yellow-400';
        const statusBg = agent.status === 'active' ? 'bg-green-500/20' : 'bg-yellow-500/20';
        const lastPosted = agent.last_posted_at
            ? new Date(agent.last_posted_at).toLocaleDateString()
            : 'Never';

        // Check if test was already used (persisted server-side)
        const testUsed = !!agent.test_used_at;
        const testDisabled = agent.status !== 'active' || testUsed;
        const testButtonClass = testUsed
            ? 'bg-gray-700/50 text-gray-500 cursor-not-allowed'
            : 'bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30';
        const testButtonText = testUsed ? 'Used' : 'Test';

        return `
            <div class="platform-card rounded-xl p-6" id="agent-${agent.id}">
                <div class="flex items-center justify-between mb-4">
                    <div class="flex items-center gap-4">
                        <div class="w-12 h-12 rounded-xl ${bgColor} flex items-center justify-center">
                            ${icon}
                        </div>
                        <div>
                            <h4 class="font-semibold">${escapeHtml(agent.name)}</h4>
                            <p class="text-sm text-gray-400 capitalize">${agent.platform}</p>
                        </div>
                    </div>
                    <span class="${statusBg} ${statusColor} px-3 py-1 rounded-full text-xs font-medium capitalize">
                        ${agent.status}
                    </span>
                </div>

                <div class="grid grid-cols-2 gap-4 mb-4 text-sm">
                    <div>
                        <p class="text-gray-500">Posts Today</p>
                        <p class="font-medium">${agent.posts_today || 0}</p>
                    </div>
                    <div>
                        <p class="text-gray-500">Last Posted</p>
                        <p class="font-medium">${lastPosted}</p>
                    </div>
                </div>

                <div class="flex gap-2">
                    <button onclick="testAgentPost('${agent.id}')"
                            class="flex-1 py-2 rounded-lg ${testButtonClass} text-sm font-medium transition-all flex items-center justify-center gap-1"
                            ${testDisabled ? 'disabled' : ''}
                            title="${testUsed ? 'Test already used for this agent' : 'Test post to this platform'}">
                        <span>${testButtonText}</span>
                    </button>
                    <button onclick="window.location.href='/settings.html?agent=${agent.id}'"
                            class="flex-1 py-2 rounded-lg bg-purple-500/20 text-purple-400 text-sm font-medium hover:bg-purple-500/30 transition-all">
                        Configure
                    </button>
                    <button onclick="toggleAgentStatus('${agent.id}', '${agent.status}')"
                            class="px-3 py-2 rounded-lg border border-gray-700 text-gray-400 text-sm hover:text-white transition-all"
                            title="${agent.status === 'active' ? 'Pause' : 'Resume'}">
                        ${agent.status === 'active'
                            ? '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>'
                            : '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>'
                        }
                    </button>
                    <button onclick="deleteAgent('${agent.id}', '${escapeHtml(agent.name)}')"
                            class="px-3 py-2 rounded-lg border border-red-500/50 text-red-400 text-sm hover:bg-red-500/20 transition-all"
                            title="Delete">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                        </svg>
                    </button>
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

    // Show loading state
    if (testBtn) {
        testBtn.disabled = true;
        testBtn.innerHTML = '<span class="loading-spinner"></span>';
    }

    try {
        const response = await fetch(`/api/agents/${agentId}/test`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'X-CSRF-Token': getCsrfToken()
            }
        });

        const result = await response.json();
        showAgentTestResults(result, response.ok);

    } catch (error) {
        console.error('Agent test error:', error);
        showAgentTestResults({
            success: false,
            error: 'Network error',
            message: error.message
        }, false);
    } finally {
        if (testBtn) {
            testBtn.disabled = false;
            testBtn.innerHTML = '<span>Test</span>';
        }
        // Refresh agents to update post counts
        await loadAgents();
    }
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
                        <div class="mt-4 p-3 bg-black/50 rounded-lg">
                            <p class="text-white whitespace-pre-wrap">${escapeHtml(result.post.content)}</p>
                        </div>
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
    const planOrder = ['free', 'starter', 'growth', 'professional', 'business'];
    return planOrder.indexOf(tier);
}

// Show plan change notification
function showPlanChangeNotification(message, isUpgrade) {
    const notification = document.createElement('div');
    notification.id = 'planChangeNotification';
    const colorClass = isUpgrade ? 'from-blue-500/20 to-purple-500/20 border-blue-500/50' : 'from-orange-500/20 to-yellow-500/20 border-orange-500/50';
    const iconColor = isUpgrade ? 'text-blue-400' : 'text-orange-400';
    const titleColor = isUpgrade ? 'text-blue-400' : 'text-orange-400';
    const title = isUpgrade ? 'Plan Upgrade Scheduled' : 'Plan Change Scheduled';

    notification.className = `fixed top-4 right-4 z-50 max-w-md p-6 rounded-xl bg-gradient-to-r ${colorClass} border shadow-2xl animate-slide-in`;
    notification.innerHTML = `
        <div class="flex items-start gap-4">
            <div class="flex-shrink-0 w-12 h-12 rounded-full bg-${isUpgrade ? 'blue' : 'orange'}-500/20 flex items-center justify-center">
                <svg class="w-6 h-6 ${iconColor}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
                </svg>
            </div>
            <div class="flex-1">
                <h3 class="text-lg font-semibold ${titleColor} mb-1">${title}</h3>
                <p class="text-gray-300 text-sm mb-3">${message}</p>
                <button onclick="closePlanChangeNotification()" class="text-sm ${titleColor} hover:opacity-80 transition-colors">
                    Got it
                </button>
            </div>
            <button onclick="closePlanChangeNotification()" class="text-gray-500 hover:text-white transition-colors">
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

function showPaymentSuccessMessage() {
    // Create and show success notification
    const notification = document.createElement('div');
    notification.id = 'paymentSuccessNotification';
    notification.className = 'fixed top-4 right-4 z-50 max-w-md p-6 rounded-xl bg-gradient-to-r from-green-500/20 to-emerald-500/20 border border-green-500/50 shadow-2xl animate-slide-in';
    notification.innerHTML = `
        <div class="flex items-start gap-4">
            <div class="flex-shrink-0 w-12 h-12 rounded-full bg-green-500/20 flex items-center justify-center">
                <svg class="w-6 h-6 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
                </svg>
            </div>
            <div class="flex-1">
                <h3 class="text-lg font-semibold text-green-400 mb-1">Payment Successful!</h3>
                <p class="text-gray-300 text-sm mb-3" id="paymentSuccessText">Your subscription has been activated. Enjoy your new features!</p>
                <button onclick="closePaymentNotification()" class="text-sm text-green-400 hover:text-green-300 transition-colors">
                    Dismiss
                </button>
            </div>
            <button onclick="closePaymentNotification()" class="text-gray-500 hover:text-white transition-colors">
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
    notification.className = 'fixed top-4 right-4 z-50 max-w-md p-6 rounded-xl bg-gradient-to-r from-yellow-500/20 to-orange-500/20 border border-yellow-500/50 shadow-2xl animate-slide-in';
    notification.innerHTML = `
        <div class="flex items-start gap-4">
            <div class="flex-shrink-0 w-12 h-12 rounded-full bg-yellow-500/20 flex items-center justify-center">
                <svg class="w-6 h-6 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>
                </svg>
            </div>
            <div class="flex-1">
                <h3 class="text-lg font-semibold text-yellow-400 mb-1">Payment Cancelled</h3>
                <p class="text-gray-300 text-sm mb-3">No worries! You can upgrade anytime when you're ready.</p>
                <button onclick="closePaymentCancelledNotification()" class="text-sm text-yellow-400 hover:text-yellow-300 transition-colors">
                    Dismiss
                </button>
            </div>
            <button onclick="closePaymentCancelledNotification()" class="text-gray-500 hover:text-white transition-colors">
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
// Subscription Management UI
// ============================================

function updateSubscriptionActions(tier, subscription) {
    const actionsContainer = document.getElementById('subscriptionActions');
    const cancelBtn = document.getElementById('cancelSubscriptionBtn');
    const resumeBtn = document.getElementById('resumeSubscriptionBtn');
    const downgradeBtn = document.getElementById('downgradeToFreeBtn');
    const endDateEl = document.getElementById('subscriptionEndDate');

    if (!actionsContainer) return;

    const isPaidUser = tier !== 'free';

    if (isPaidUser) {
        // Show subscription management actions for paid users
        actionsContainer.classList.remove('hidden');

        const isCancelled = subscription?.cancelAtPeriodEnd || subscription?.status === 'cancelled';

        if (isCancelled) {
            // Subscription is cancelled - show resume button, hide cancel/downgrade
            cancelBtn?.classList.add('hidden');
            downgradeBtn?.classList.add('hidden');
            resumeBtn?.classList.remove('hidden');

            // Show end date if available
            if (subscription?.endsAt && endDateEl) {
                const endDate = new Date(subscription.endsAt).toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric'
                });
                endDateEl.textContent = `Your subscription will end on ${endDate}. You can resume anytime before then.`;
                endDateEl.classList.remove('hidden');
            }
        } else {
            // Active subscription - show cancel and downgrade buttons
            cancelBtn?.classList.remove('hidden');
            downgradeBtn?.classList.remove('hidden');
            resumeBtn?.classList.add('hidden');
            endDateEl?.classList.add('hidden');
        }
    } else {
        // Free user - hide subscription management actions
        actionsContainer.classList.add('hidden');
    }
}

async function downgradeToFree() {
    const confirmed = confirm(
        'Are you sure you want to downgrade to the Free plan?\n\n' +
        'This will:\n' +
        '- Cancel your current subscription immediately\n' +
        '- Change your plan to Free (1 post per week)\n' +
        '- You will lose access to paid features\n\n' +
        'This action cannot be undone.'
    );

    if (!confirmed) return;

    const token = localStorage.getItem('token');
    const downgradeBtn = document.getElementById('downgradeToFreeBtn');

    if (downgradeBtn) {
        downgradeBtn.disabled = true;
        downgradeBtn.innerHTML = '<span class="animate-pulse">Downgrading...</span>';
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
            alert(data.message || 'Successfully downgraded to Free plan.');
            // Reload profile to update UI
            await loadUserProfile();
        } else {
            alert(data.error || 'Failed to downgrade. Please try again.');
        }
    } catch (error) {
        console.error('Downgrade error:', error);
        alert('Failed to downgrade. Please try again.');
    } finally {
        if (downgradeBtn) {
            downgradeBtn.disabled = false;
            downgradeBtn.innerHTML = 'Downgrade to Free';
        }
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
            // Open customer portal in new tab
            window.open(data.portalUrl, '_blank');
        } else {
            alert(data.error || 'Unable to access billing portal. Please try again.');
        }
    } catch (error) {
        console.error('Portal error:', error);
        alert('Failed to open billing portal. Please try again.');
    } finally {
        if (portalBtn) {
            portalBtn.disabled = false;
            portalBtn.innerHTML = 'Manage Billing';
        }
    }
}

async function cancelSubscription() {
    if (!confirm('Are you sure you want to cancel your subscription? You will retain access until the end of your current billing period.')) {
        return;
    }

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
            alert(data.message || 'Your subscription has been cancelled. You will retain access until the end of your billing period.');
            // Reload profile to update UI
            await loadUserProfile();
        } else {
            alert(data.error || 'Failed to cancel subscription. Please try again.');
        }
    } catch (error) {
        console.error('Cancel error:', error);
        alert('Failed to cancel subscription. Please try again.');
    } finally {
        if (cancelBtn) {
            cancelBtn.disabled = false;
            cancelBtn.innerHTML = 'Cancel Subscription';
        }
    }
}

async function resumeSubscription() {
    const token = localStorage.getItem('token');
    const resumeBtn = document.getElementById('resumeSubscriptionBtn');

    if (resumeBtn) {
        resumeBtn.disabled = true;
        resumeBtn.innerHTML = '<span class="animate-pulse">Resuming...</span>';
    }

    try {
        const response = await fetch('/api/subscriptions/resume', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'X-CSRF-Token': getCsrfToken()
            }
        });

        const data = await response.json();

        if (response.ok) {
            alert(data.message || 'Your subscription has been resumed!');
            // Reload profile to update UI
            await loadUserProfile();
        } else {
            alert(data.error || 'Failed to resume subscription. Please try again.');
        }
    } catch (error) {
        console.error('Resume error:', error);
        alert('Failed to resume subscription. Please try again.');
    } finally {
        if (resumeBtn) {
            resumeBtn.disabled = false;
            resumeBtn.innerHTML = 'Resume Subscription';
        }
    }
}

// Make functions globally available
window.showTab = showTab;
window.connectPlatform = connectPlatform;
window.disconnectPlatform = disconnectPlatform;
window.selectPlan = selectPlan;
window.openTelegramModal = openTelegramModal;
window.closeTelegramModal = closeTelegramModal;
window.connectTelegram = connectTelegram;
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
window.resumeSubscription = resumeSubscription;
window.downgradeToFree = downgradeToFree;
