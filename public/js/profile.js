// profile.js - Dashboard page handling

// Global state
let currentUser = null;
let connections = [];

document.addEventListener('DOMContentLoaded', async () => {
    // Check if user is authenticated
    const token = localStorage.getItem('token');
    if (!token) {
        window.location.href = '/auth.html';
        return;
    }

    // Load user data and connections
    await Promise.all([
        loadUserProfile(),
        loadConnections()
    ]);

    // Setup event handlers
    setupEventHandlers();

    // Check URL params for tab navigation
    const urlParams = new URLSearchParams(window.location.search);
    const tab = urlParams.get('tab');
    if (tab) {
        showTab(tab);
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
        const remaining = currentUser.subscription?.postsRemaining ?? 5;
        const limit = currentUser.subscription?.dailyLimit ?? 5;
        postsRemaining.textContent = `${remaining}/${limit}`;
    }

    if (subscriptionStatus) {
        if (isPaidUser) {
            subscriptionStatus.textContent = `Your ${tier} plan is active. You have access to all features.`;
        } else {
            subscriptionStatus.textContent = 'Upgrade to unlock unlimited posts and advanced features';
        }
    }

    // Update dashboard stats
    const postsLeftToday = document.getElementById('postsLeftToday');
    if (postsLeftToday) {
        postsLeftToday.textContent = currentUser.subscription?.postsRemaining ?? 5;
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
    const connectionCount = document.getElementById('connectionCount');
    if (connectionCount) {
        connectionCount.textContent = `${connectedCount}/5`;
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
                        'Authorization': `Bearer ${token}`
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
    const plans = ['starter', 'growth', 'professional'];
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
                'Authorization': `Bearer ${token}`
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

// Select plan
function selectPlan(plan) {
    // Redirect to payment page with selected plan
    window.location.href = `/payment.html?plan=${plan}`;
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
    if (modal) modal.classList.add('hidden');
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
                'Content-Type': 'application/json'
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
                'Authorization': `Bearer ${token}`
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
}

function closeTestModal() {
    const modal = document.getElementById('testResultModal');
    if (modal) modal.classList.add('hidden');
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
