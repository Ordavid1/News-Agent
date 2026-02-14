// settings.js - Settings page handling

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

// Global state for connected platforms
let connectedPlatforms = [];
let allConnections = []; // Full connection objects

// Global state for keywords
let keywords = [];

// Reddit subreddit requirements state
let currentSubredditRequirements = null;

// Agent mode state
let agentId = null;
let currentAgent = null;
let existingAgents = []; // To track which platforms already have agents

// User subscription state
let currentUser = null;

// Plan limits configuration (must match server-side PRICING_TIERS)
// Note: free tier is 1 post/week, paid tiers are posts/day
const PLAN_POST_LIMITS = {
    free: 1,          // 1 post/week
    starter: 10,      // 10 posts/day
    growth: 20,       // 20 posts/day
    professional: 30, // 30 posts/day
    business: 45      // 45 posts/day
};

document.addEventListener('DOMContentLoaded', async () => {
    // Check if user is authenticated
    const token = localStorage.getItem('token');
    if (!token) {
        window.location.href = '/auth.html';
        return;
    }

    // Initialize CSRF token first
    await initCsrf();

    // Check for agent ID in URL
    const urlParams = new URLSearchParams(window.location.search);
    agentId = urlParams.get('agent');

    // Load user profile first to get subscription tier for plan limits
    await loadUserProfile();

    // Always load connections first for the platform dropdown
    await loadAllConnections();

    if (agentId) {
        // Editing existing agent - load agent settings
        await loadAgentSettings();
    } else {
        // New agent mode - load any existing agents to know which platforms are taken
        await loadExistingAgents();
    }

    // Handle form submission
    const settingsForm = document.getElementById('settingsForm');
    if (settingsForm) {
        settingsForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            await saveAgentWithSettings();
        });
    }

    // Initialize keyword input handlers
    initializeKeywordHandlers();

    // Initialize platform-specific toggles
    initializeRedditSubredditToggle();
    initializeTwitterPremiumToggle();
});

/**
 * Initialize Reddit subreddit configuration toggle
 * Shows/hides the subreddit input when Reddit checkbox is toggled
 * Also handles auto-fetching subreddit requirements on Enter
 */
function initializeRedditSubredditToggle() {
    const redditCheckbox = document.querySelector('input[name="platforms"][value="reddit"]');
    const subredditConfig = document.getElementById('redditSubredditConfig');
    const subredditInput = document.getElementById('redditSubreddit');

    if (redditCheckbox && subredditConfig) {
        // Initial state
        subredditConfig.classList.toggle('hidden', !redditCheckbox.checked);

        // Toggle on change
        redditCheckbox.addEventListener('change', (e) => {
            subredditConfig.classList.toggle('hidden', !e.target.checked);
            // Reset requirements state when toggling
            if (!e.target.checked) {
                resetSubredditRequirementsUI();
            }
        });
    }

    // Validate and sanitize subreddit input
    if (subredditInput) {
        subredditInput.addEventListener('input', (e) => {
            // Remove r/ prefix if user types it
            let value = e.target.value.replace(/^r\//, '');
            // Remove spaces and special characters (only allow alphanumeric and underscore)
            value = value.replace(/[^a-zA-Z0-9_]/g, '');
            // Limit to 21 characters (Reddit's max subreddit name length)
            value = value.slice(0, 21);
            e.target.value = value;

            // Reset status icons when user starts typing
            resetSubredditRequirementsUI();
        });

        // Handle Enter key to fetch subreddit requirements
        subredditInput.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                await fetchSubredditRequirements(subredditInput.value.trim());
            }
        });

        // Also fetch on blur (when user clicks away)
        subredditInput.addEventListener('blur', async (e) => {
            let value = e.target.value.replace(/^r\//, '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 21);
            e.target.value = value;

            if (value && value !== currentSubredditRequirements?.subreddit) {
                await fetchSubredditRequirements(value);
            }
        });
    }

    // Add click handler for warning icon to re-open modal
    const warningIcon = document.getElementById('redditSubredditWarning');
    if (warningIcon) {
        warningIcon.addEventListener('click', () => {
            if (currentSubredditRequirements) {
                openSubredditModal(currentSubredditRequirements);
            }
        });
    }
}

/**
 * Reset the subreddit requirements UI state
 */
function resetSubredditRequirementsUI() {
    const loadingEl = document.getElementById('redditSubredditLoading');
    const successEl = document.getElementById('redditSubredditSuccess');
    const warningEl = document.getElementById('redditSubredditWarning');
    const flairConfig = document.getElementById('redditFlairConfig');
    const errorEl = document.getElementById('redditSubredditError');

    if (loadingEl) loadingEl.classList.add('hidden');
    if (successEl) successEl.classList.add('hidden');
    if (warningEl) warningEl.classList.add('hidden');
    if (flairConfig) flairConfig.classList.add('hidden');
    if (errorEl) errorEl.classList.add('hidden');

    currentSubredditRequirements = null;
}

/**
 * Fetch subreddit requirements from the API
 */
async function fetchSubredditRequirements(subreddit) {
    if (!subreddit) return;

    const token = localStorage.getItem('token');
    const loadingEl = document.getElementById('redditSubredditLoading');
    const successEl = document.getElementById('redditSubredditSuccess');
    const warningEl = document.getElementById('redditSubredditWarning');
    const errorEl = document.getElementById('redditSubredditError');

    // Show loading state
    resetSubredditRequirementsUI();
    if (loadingEl) loadingEl.classList.remove('hidden');

    try {
        const response = await fetch(`/api/reddit/subreddit/${encodeURIComponent(subreddit)}/requirements`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'X-CSRF-Token': getCsrfToken()
            }
        });

        const data = await response.json();

        // Hide loading
        if (loadingEl) loadingEl.classList.add('hidden');

        if (!response.ok) {
            // Handle specific error codes
            if (data.code === 'REDDIT_NOT_CONNECTED') {
                showSubredditError('Please connect your Reddit account first');
            } else if (data.code === 'REDDIT_TOKEN_INVALID') {
                showSubredditError('Reddit credentials invalid. Please disconnect and reconnect your Reddit account in Connections.');
            } else if (data.code === 'SUBREDDIT_NOT_FOUND') {
                showSubredditError(`Subreddit r/${subreddit} not found`);
            } else if (data.code === 'SUBREDDIT_RESTRICTED') {
                showSubredditError(`Cannot access r/${subreddit} (private or restricted)`);
            } else {
                showSubredditError(data.error || 'Failed to fetch requirements');
            }
            return;
        }

        // Store requirements
        currentSubredditRequirements = data;

        // Log the requirements for debugging
        console.log(`[Reddit] r/${subreddit} requirements:`, {
            flairRequired: data.requirements?.flairRequired,
            flairsCount: data.requirements?.flairs?.length || 0,
            titleLimits: `${data.requirements?.titleMinLength || 0}-${data.requirements?.titleMaxLength || 300}`,
            bodyRestriction: data.requirements?.bodyRestriction,
            linkRestriction: data.requirements?.linkRestriction
        });

        // Check if there are any requirements that need user attention
        const hasRequirements = data.requirements?.flairRequired && data.requirements?.flairs?.length > 0;

        if (hasRequirements) {
            // Show warning icon and open modal
            if (warningEl) warningEl.classList.remove('hidden');
            openSubredditModal(data);
        } else {
            // Show success checkmark
            if (successEl) {
                successEl.classList.remove('hidden');
                successEl.title = 'No special requirements';
            }
        }

    } catch (error) {
        console.error('Error fetching subreddit requirements:', error);
        if (loadingEl) loadingEl.classList.add('hidden');
        showSubredditError('Failed to fetch subreddit requirements');
    }
}

/**
 * Show error message for subreddit input
 */
function showSubredditError(message) {
    const errorEl = document.getElementById('redditSubredditError');
    if (errorEl) {
        errorEl.textContent = message;
        errorEl.classList.remove('hidden');
    }
}

/**
 * Open the subreddit requirements modal
 */
function openSubredditModal(data) {
    const modal = document.getElementById('subredditRequirementsModal');
    const modalSubredditName = document.getElementById('modalSubredditName');
    const modalFlairWarning = document.getElementById('modalFlairWarning');
    const modalFlairSection = document.getElementById('modalFlairSection');
    const modalFlairSelect = document.getElementById('modalFlairSelect');
    const modalRequirementsList = document.getElementById('modalRequirementsList');
    const modalGuidelines = document.getElementById('modalGuidelines');
    const modalGuidelinesText = document.getElementById('modalGuidelinesText');

    if (!modal) return;

    // Set subreddit name
    if (modalSubredditName) {
        modalSubredditName.textContent = `r/${data.subreddit}`;
    }

    // Handle flair requirements
    const requirements = data.requirements || {};

    if (requirements.flairRequired && requirements.flairs?.length > 0) {
        if (modalFlairWarning) modalFlairWarning.classList.remove('hidden');
        if (modalFlairSection) modalFlairSection.classList.remove('hidden');

        // Populate flair dropdown
        if (modalFlairSelect) {
            modalFlairSelect.innerHTML = '<option value="">Choose a flair...</option>';
            requirements.flairs.forEach(flair => {
                const option = document.createElement('option');
                option.value = flair.id;
                option.textContent = flair.text || '(No text)';
                option.dataset.flairText = flair.text || '';
                modalFlairSelect.appendChild(option);
            });

            // Pre-select if we have a saved flair
            const savedFlairId = getSavedFlairId();
            if (savedFlairId) {
                modalFlairSelect.value = savedFlairId;
            }
        }
    } else {
        if (modalFlairWarning) modalFlairWarning.classList.add('hidden');
        if (modalFlairSection) modalFlairSection.classList.add('hidden');
    }

    // Build requirements list
    if (modalRequirementsList) {
        const items = [];

        if (requirements.titleMinLength > 0 || requirements.titleMaxLength < 300) {
            items.push(`Title: ${requirements.titleMinLength || 0}-${requirements.titleMaxLength || 300} characters`);
        }

        if (requirements.bodyRestriction === 'required') {
            items.push('Body text is required');
        } else if (requirements.bodyRestriction === 'notAllowed') {
            items.push('Body text is not allowed (link posts only)');
        } else if (requirements.bodyMinLength > 0) {
            items.push(`Body: minimum ${requirements.bodyMinLength} characters`);
        }

        if (requirements.linkRestriction === 'required') {
            items.push('Link is required');
        } else if (requirements.linkRestriction === 'notAllowed') {
            items.push('Links not allowed (text posts only)');
        }

        if (requirements.domainWhitelist?.length > 0) {
            items.push(`Only allowed domains: ${requirements.domainWhitelist.slice(0, 3).join(', ')}${requirements.domainWhitelist.length > 3 ? '...' : ''}`);
        }

        if (requirements.titleBlacklist?.length > 0) {
            items.push(`Blacklisted words in title: ${requirements.titleBlacklist.slice(0, 3).join(', ')}${requirements.titleBlacklist.length > 3 ? '...' : ''}`);
        }

        if (items.length === 0) {
            items.push('No specific content restrictions');
        }

        modalRequirementsList.innerHTML = items.map(item => `<li>• ${item}</li>`).join('');
    }

    // Show guidelines if present
    if (requirements.guidelines && modalGuidelines && modalGuidelinesText) {
        modalGuidelines.classList.remove('hidden');
        modalGuidelinesText.textContent = requirements.guidelines;
    } else if (modalGuidelines) {
        modalGuidelines.classList.add('hidden');
    }

    // Show modal
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}

/**
 * Close the subreddit requirements modal
 */
function closeSubredditModal() {
    const modal = document.getElementById('subredditRequirementsModal');
    if (modal) {
        modal.classList.add('hidden');
        document.body.style.overflow = '';
    }
}

/**
 * Save subreddit settings from the modal
 */
function saveSubredditSettings() {
    const modalFlairSelect = document.getElementById('modalFlairSelect');
    const requirements = currentSubredditRequirements?.requirements;

    // Validate flair selection if required
    if (requirements?.flairRequired && requirements?.flairs?.length > 0) {
        if (!modalFlairSelect?.value) {
            alert('Please select a flair for this subreddit');
            return;
        }
    }

    // Save the selected flair to the inline selector as well
    const flairSelect = document.getElementById('redditFlairSelect');
    const flairConfig = document.getElementById('redditFlairConfig');

    if (modalFlairSelect?.value && requirements?.flairRequired) {
        // Show inline flair config
        if (flairConfig) flairConfig.classList.remove('hidden');

        // Populate inline flair select
        if (flairSelect) {
            flairSelect.innerHTML = '<option value="">Select a flair...</option>';
            requirements.flairs.forEach(flair => {
                const option = document.createElement('option');
                option.value = flair.id;
                option.textContent = flair.text || '(No text)';
                option.dataset.flairText = flair.text || '';
                flairSelect.appendChild(option);
            });
            flairSelect.value = modalFlairSelect.value;
        }

        // Update warning icon to show configured state
        const warningEl = document.getElementById('redditSubredditWarning');
        const successEl = document.getElementById('redditSubredditSuccess');
        if (warningEl) warningEl.classList.add('hidden');
        if (successEl) {
            successEl.classList.remove('hidden');
            successEl.title = 'Requirements configured';
        }
    }

    closeSubredditModal();
}

/**
 * Get the currently saved flair ID from settings
 */
function getSavedFlairId() {
    // Check inline select first
    const flairSelect = document.getElementById('redditFlairSelect');
    if (flairSelect?.value) {
        return flairSelect.value;
    }
    return null;
}

/**
 * Initialize Twitter Premium configuration toggle
 * Shows/hides the Premium checkbox when Twitter checkbox is toggled
 */
function initializeTwitterPremiumToggle() {
    const twitterCheckbox = document.querySelector('input[name="platforms"][value="twitter"]');
    const premiumConfig = document.getElementById('twitterPremiumConfig');

    if (twitterCheckbox && premiumConfig) {
        // Initial state
        premiumConfig.classList.toggle('hidden', !twitterCheckbox.checked);

        // Toggle on change
        twitterCheckbox.addEventListener('change', (e) => {
            premiumConfig.classList.toggle('hidden', !e.target.checked);
        });
    }
}

/**
 * Initialize keyword input event handlers
 */
function initializeKeywordHandlers() {
    const keywordInput = document.getElementById('keywordInput');
    const addKeywordBtn = document.getElementById('addKeywordBtn');

    if (keywordInput && addKeywordBtn) {
        // Handle input - check for comma to auto-add keyword
        keywordInput.addEventListener('input', (e) => {
            const value = e.target.value;
            if (value.includes(',')) {
                // Split by comma and process each part
                const parts = value.split(',');
                // Process all parts except the last one (which might be incomplete)
                for (let i = 0; i < parts.length - 1; i++) {
                    addKeywordFromValue(parts[i]);
                }
                // Keep the last part in the input (user might still be typing)
                keywordInput.value = parts[parts.length - 1].trim();
            }
        });

        // Handle Enter key press
        keywordInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                addKeywordFromValue(keywordInput.value);
                keywordInput.value = '';
            }
        });

        // Handle Add button click
        addKeywordBtn.addEventListener('click', () => {
            addKeywordFromValue(keywordInput.value);
            keywordInput.value = '';
        });
    }
}

/**
 * Maximum number of keywords allowed
 */
const MAX_KEYWORDS = 10;

/**
 * Add a keyword from a given value
 */
function addKeywordFromValue(value) {
    if (!value) return;

    let keyword = value.trim();
    if (!keyword) return;

    // Check if we've reached the limit
    if (keywords.length >= MAX_KEYWORDS) {
        showKeywordLimitMessage();
        return;
    }

    // Remove # if present (we'll add it back for display)
    keyword = keyword.replace(/^#/, '').trim();

    // Remove any remaining commas
    keyword = keyword.replace(/,/g, '').trim();

    if (!keyword) return;

    // Check for duplicates (case-insensitive)
    if (keywords.some(k => k.replace(/^#/, '').toLowerCase() === keyword.toLowerCase())) {
        return;
    }

    // Add to keywords array with # prefix for display
    keywords.push(`#${keyword}`);

    // Update UI
    renderKeywordTags();
    updateKeywordCounter();
}

/**
 * Show message when keyword limit is reached
 */
function showKeywordLimitMessage() {
    const container = document.getElementById('keywordTags');
    if (!container) return;

    // Check if message already exists
    if (document.getElementById('keywordLimitMsg')) return;

    const msg = document.createElement('div');
    msg.id = 'keywordLimitMsg';
    msg.className = 'text-yellow-400 text-sm mt-2';
    msg.textContent = `Maximum ${MAX_KEYWORDS} keywords allowed`;
    container.parentNode.appendChild(msg);

    // Remove message after 3 seconds
    setTimeout(() => {
        msg.remove();
    }, 3000);
}

/**
 * Update keyword counter display
 */
function updateKeywordCounter() {
    const counterEl = document.getElementById('keywordCounter');
    if (counterEl) {
        counterEl.textContent = `${keywords.length}/${MAX_KEYWORDS}`;
        counterEl.className = keywords.length >= MAX_KEYWORDS
            ? 'text-yellow-400 text-sm'
            : 'text-gray-500 text-sm';
    }
}

/**
 * Remove a keyword from the list
 */
function removeKeyword(index) {
    keywords.splice(index, 1);
    renderKeywordTags();
    updateKeywordCounter();
}

/**
 * Render keyword tags in the UI
 */
function renderKeywordTags() {
    const container = document.getElementById('keywordTags');
    if (!container) return;

    container.innerHTML = keywords.map((keyword, index) => `
        <span class="inline-flex items-center gap-1 px-3 py-1 bg-purple-600/30 border border-purple-500/50 rounded-full text-sm">
            <span>${keyword}</span>
            <button type="button" onclick="removeKeyword(${index})" class="text-gray-400 hover:text-white transition-colors ml-1">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                </svg>
            </button>
        </span>
    `).join('');
}

/**
 * Load user profile to get subscription tier for plan limits
 */
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
            // Populate the posts per day dropdown based on user's plan
            populatePostsPerDayDropdown();
        } else if (response.status === 401) {
            localStorage.removeItem('token');
            window.location.href = '/auth.html';
        }
    } catch (error) {
        console.error('Error loading user profile:', error);
    }
}

/**
 * Get the maximum posts per day limit for the user's current plan
 */
function getUserPostLimit() {
    const tier = currentUser?.subscription?.tier || 'free';
    return PLAN_POST_LIMITS[tier] || PLAN_POST_LIMITS.free;
}

/**
 * Populate the posts per day dropdown based on user's subscription plan
 * Only shows options up to their plan's maximum limit
 */
function populatePostsPerDayDropdown() {
    const postsPerDaySelect = document.querySelector('select[name="postsPerDay"]');
    if (!postsPerDaySelect) return;

    const maxPosts = getUserPostLimit();
    const currentValue = postsPerDaySelect.value;

    // Define all possible post options
    const allOptions = [
        { value: 3, label: '3 posts' },
        { value: 5, label: '5 posts' },
        { value: 10, label: '10 posts' },
        { value: 15, label: '15 posts' },
        { value: 20, label: '20 posts' },
        { value: 30, label: '30 posts' },
        { value: 45, label: '45 posts' }
    ];

    // Filter options to only show those within the user's plan limit
    const availableOptions = allOptions.filter(opt => opt.value <= maxPosts);

    // Clear existing options
    postsPerDaySelect.innerHTML = '';

    // Add filtered options
    availableOptions.forEach(opt => {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.label;
        postsPerDaySelect.appendChild(option);
    });

    // Restore the previous value if it's still valid, otherwise use the first option
    const previousValueStillValid = availableOptions.some(opt => opt.value === parseInt(currentValue));
    if (previousValueStillValid) {
        postsPerDaySelect.value = currentValue;
    } else if (availableOptions.length > 0) {
        // If previous value exceeds new limit, set to the maximum available
        postsPerDaySelect.value = availableOptions[availableOptions.length - 1].value;
    }

    // Add a hint showing the plan limit
    updatePostsPerDayHint(maxPosts);
}

/**
 * Update or create a hint below the posts per day dropdown showing plan limit
 */
function updatePostsPerDayHint(maxPosts) {
    const postsPerDaySelect = document.querySelector('select[name="postsPerDay"]');
    if (!postsPerDaySelect) return;

    const parentDiv = postsPerDaySelect.closest('div');
    if (!parentDiv) return;

    // Remove existing hint if present
    const existingHint = parentDiv.querySelector('.posts-limit-hint');
    if (existingHint) {
        existingHint.remove();
    }

    // Add hint showing plan limit
    const tier = currentUser?.subscription?.tier || 'free';
    const hint = document.createElement('p');
    hint.className = 'posts-limit-hint text-xs text-gray-500 mt-2';
    hint.textContent = `Your ${tier.charAt(0).toUpperCase() + tier.slice(1)} plan allows up to ${maxPosts} posts per day`;
    parentDiv.appendChild(hint);
}

/**
 * Load all connections and update platform checkboxes
 */
async function loadAllConnections() {
    const token = localStorage.getItem('token');

    try {
        const response = await fetch('/api/connections', {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (response.ok) {
            const data = await response.json();
            allConnections = (data.connections || []).filter(c => c.status === 'active');
            connectedPlatforms = allConnections.map(c => c.platform);

            // Update the platform checkboxes
            updatePlatformCheckboxes();
        }
    } catch (error) {
        console.error('Error loading connections:', error);
    }
}

/**
 * Load existing agents to know which platforms already have agents
 */
async function loadExistingAgents() {
    const token = localStorage.getItem('token');

    try {
        const response = await fetch('/api/agents', {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (response.ok) {
            const data = await response.json();
            existingAgents = data.agents || [];

            // Update checkboxes to show which platforms have agents
            updatePlatformCheckboxes();
        }
    } catch (error) {
        console.error('Error loading agents:', error);
    }
}

/**
 * Update platform checkboxes to show connection status
 */
function updatePlatformCheckboxes() {
    const platformCheckboxes = document.querySelectorAll('input[name="platforms"]');

    platformCheckboxes.forEach(checkbox => {
        const platform = checkbox.value;
        const connection = allConnections.find(c => c.platform === platform);
        const label = checkbox.closest('label');

        if (connection) {
            // Platform is connected - enable checkbox
            checkbox.disabled = false;
            if (label) {
                label.classList.remove('opacity-50', 'cursor-not-allowed');
                label.classList.add('cursor-pointer');
                // Show username if available
                const platformName = label.querySelector('p.font-medium');
                const platformDesc = label.querySelector('p.text-sm.text-gray-400');
                if (platformDesc && connection.platform_username) {
                    platformDesc.textContent = `@${connection.platform_username}`;
                }
            }
        } else {
            // Platform not connected - disable checkbox
            checkbox.disabled = true;
            checkbox.checked = false;
            if (label) {
                label.classList.add('opacity-50', 'cursor-not-allowed');
                label.classList.remove('cursor-pointer');
            }
        }

        // Check if platform already has an agent
        const existingAgent = existingAgents.find(a => a.platform === platform);
        if (existingAgent && label) {
            const platformDesc = label.querySelector('p.text-sm.text-gray-400');
            if (platformDesc) {
                platformDesc.textContent = `Agent: ${existingAgent.name}`;
            }
        }
    });

    // Show connection hint if no platforms connected
    const connectionHint = document.getElementById('connectionHint');
    const connectionHintText = document.getElementById('connectionHintText');
    if (allConnections.length === 0 && connectionHint && connectionHintText) {
        connectionHint.classList.remove('hidden');
        connectionHintText.innerHTML = 'No platforms connected. <a href="/profile.html?tab=connections" class="text-purple-400 hover:underline">Connect a platform first</a>.';
    } else if (connectionHint) {
        connectionHint.classList.add('hidden');
    }
}

/**
 * Reset form to default values
 */
function resetFormToDefaults() {
    // Clear topics
    document.querySelectorAll('input[name="topics"]').forEach(cb => cb.checked = false);

    // Clear keywords
    keywords = [];
    renderKeywordTags();
    updateKeywordCounter();

    // Reset geo filter
    const geoRegion = document.querySelector('select[name="geoRegion"]');
    if (geoRegion) geoRegion.value = '';
    const includeGlobal = document.querySelector('input[name="includeGlobalNews"]');
    if (includeGlobal) includeGlobal.checked = true;

    // Reset schedule
    const postsPerDay = document.querySelector('select[name="postsPerDay"]');
    if (postsPerDay) postsPerDay.value = '3';
    const startTime = document.querySelector('input[name="startTime"]');
    if (startTime) startTime.value = '09:00';
    const endTime = document.querySelector('input[name="endTime"]');
    if (endTime) endTime.value = '21:00';

    // Reset content style
    const tone = document.querySelector('select[name="tone"]');
    if (tone) tone.value = 'professional';
    const includeHashtags = document.querySelector('input[name="includeHashtags"]');
    if (includeHashtags) includeHashtags.checked = true;
}

/**
 * Capitalize first letter
 */
function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

async function loadSettings() {
    const token = localStorage.getItem('token');
    
    try {
        const response = await fetch('/api/users/settings', {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (response.ok) {
            const settings = await response.json();
            populateForm(settings);
        } else if (response.status === 401) {
            localStorage.removeItem('token');
            window.location.href = '/auth.html';
        }
    } catch (error) {
        console.error('Error loading settings:', error);
    }
}

function populateForm(settings) {
    if (!settings) return;

    // Topics
    if (settings.topics) {
        settings.topics.forEach(topic => {
            const checkbox = document.querySelector(`input[name="topics"][value="${topic}"]`);
            if (checkbox) checkbox.checked = true;
        });
    }

    // Keywords
    if (settings.keywords && Array.isArray(settings.keywords)) {
        // Ensure all keywords have # prefix for consistency
        keywords = settings.keywords.map(k => k.startsWith('#') ? k : `#${k}`);
        renderKeywordTags();
        updateKeywordCounter();
    }

    // Geographic Filter
    if (settings.geoFilter) {
        const geoRegion = document.querySelector('select[name="geoRegion"]');
        const includeGlobalNews = document.querySelector('input[name="includeGlobalNews"]');

        if (geoRegion && settings.geoFilter.region !== undefined) {
            geoRegion.value = settings.geoFilter.region || '';
        }
        if (includeGlobalNews && settings.geoFilter.includeGlobal !== undefined) {
            includeGlobalNews.checked = settings.geoFilter.includeGlobal;
        }
    }

    // Schedule
    if (settings.schedule) {
        const postsPerDay = document.querySelector('select[name="postsPerDay"]');
        const startTime = document.querySelector('input[name="startTime"]');
        const endTime = document.querySelector('input[name="endTime"]');

        if (postsPerDay && settings.schedule.postsPerDay) {
            // Ensure the value doesn't exceed the user's plan limit
            const maxPosts = getUserPostLimit();
            const savedValue = parseInt(settings.schedule.postsPerDay);
            const valueToSet = Math.min(savedValue, maxPosts);

            // Check if the value exists as an option, otherwise use the closest available
            const optionExists = Array.from(postsPerDay.options).some(opt => parseInt(opt.value) === valueToSet);
            if (optionExists) {
                postsPerDay.value = valueToSet;
            } else {
                // Find the closest available option that doesn't exceed the limit
                const availableValues = Array.from(postsPerDay.options).map(opt => parseInt(opt.value));
                const closestValue = availableValues.reduce((prev, curr) =>
                    (curr <= valueToSet && curr > prev) ? curr : prev, availableValues[0]);
                postsPerDay.value = closestValue;
            }
        }
        if (startTime && settings.schedule.startTime) {
            startTime.value = settings.schedule.startTime;
        }
        if (endTime && settings.schedule.endTime) {
            endTime.value = settings.schedule.endTime;
        }
    }

    // Content style
    if (settings.contentStyle) {
        const tone = document.querySelector('select[name="tone"]');
        const includeHashtags = document.querySelector('input[name="includeHashtags"]');

        if (tone && settings.contentStyle.tone) {
            tone.value = settings.contentStyle.tone;
        }
        if (includeHashtags && settings.contentStyle.includeHashtags !== undefined) {
            includeHashtags.checked = settings.contentStyle.includeHashtags;
        }
    }

    // Platforms - only check if actually connected
    if (settings.platforms) {
        settings.platforms.forEach(platform => {
            const checkbox = document.querySelector(`input[name="platforms"][value="${platform}"]`);
            // Only check if the platform is connected (checkbox is not disabled)
            if (checkbox && !checkbox.disabled) {
                checkbox.checked = true;
            }
        });
    }

    // Platform-specific settings
    if (settings.platformSettings) {
        // Reddit subreddit
        if (settings.platformSettings.reddit?.subreddit) {
            const redditSubredditInput = document.getElementById('redditSubreddit');
            if (redditSubredditInput) {
                redditSubredditInput.value = settings.platformSettings.reddit.subreddit;
            }
            // Show the subreddit config if Reddit is checked
            const redditCheckbox = document.querySelector('input[name="platforms"][value="reddit"]');
            const subredditConfig = document.getElementById('redditSubredditConfig');
            if (redditCheckbox?.checked && subredditConfig) {
                subredditConfig.classList.remove('hidden');
            }
        }

        // Twitter Premium
        if (settings.platformSettings.twitter?.isPremium !== undefined) {
            const twitterPremiumCheckbox = document.getElementById('twitterPremium');
            if (twitterPremiumCheckbox) {
                twitterPremiumCheckbox.checked = settings.platformSettings.twitter.isPremium;
            }
            // Show the premium config if Twitter is checked
            const twitterCheckbox = document.querySelector('input[name="platforms"][value="twitter"]');
            const premiumConfig = document.getElementById('twitterPremiumConfig');
            if (twitterCheckbox?.checked && premiumConfig) {
                premiumConfig.classList.remove('hidden');
            }
        }
    }
}

/**
 * Save agent with settings - creates new agents for selected platforms or updates existing one
 */
async function saveAgentWithSettings() {
    const token = localStorage.getItem('token');

    // Get agent name
    const agentNameInput = document.getElementById('agentName');
    const agentName = agentNameInput?.value?.trim();

    // Get selected platforms from checkboxes
    const selectedPlatforms = Array.from(document.querySelectorAll('input[name="platforms"]:checked'))
        .map(cb => cb.value);

    // Validation
    if (!agentName) {
        showAgentIdentityError('Please enter an agent name');
        return;
    }
    if (selectedPlatforms.length === 0) {
        showAgentIdentityError('Please select at least one platform in the Platform Settings section below');
        return;
    }

    // Validate Reddit subreddit is required when Reddit is selected
    if (selectedPlatforms.includes('reddit')) {
        const redditSubredditInput = document.getElementById('redditSubreddit');
        const redditSubreddit = redditSubredditInput?.value?.trim().replace(/^r\//, '') || '';
        if (!redditSubreddit) {
            // Show error on the subreddit field
            const errorEl = document.getElementById('redditSubredditError');
            if (errorEl) {
                errorEl.classList.remove('hidden');
            }
            // Also highlight the input
            if (redditSubredditInput) {
                redditSubredditInput.classList.add('border-red-500');
                redditSubredditInput.focus();
            }
            showAgentIdentityError('Please enter a subreddit name for Reddit posting');
            return;
        }
    }

    // Hide any previous errors
    hideAgentIdentityError();
    // Hide subreddit error if it was shown
    const subredditErrorEl = document.getElementById('redditSubredditError');
    if (subredditErrorEl) {
        subredditErrorEl.classList.add('hidden');
    }
    const redditInput = document.getElementById('redditSubreddit');
    if (redditInput) {
        redditInput.classList.remove('border-red-500');
    }

    // Collect form settings
    const topics = Array.from(document.querySelectorAll('input[name="topics"]:checked'))
        .map(cb => cb.value);

    // Validate: require at least one topic OR one keyword
    if (topics.length === 0 && keywords.length === 0) {
        showAgentIdentityError('Please select at least one topic or add at least one keyword for the agent to find content.');
        // Scroll to topics section
        const topicsSection = document.querySelector('input[name="topics"]');
        if (topicsSection) {
            topicsSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        return;
    }

    const geoRegionSelect = document.querySelector('select[name="geoRegion"]');
    const includeGlobalNewsCheckbox = document.querySelector('input[name="includeGlobalNews"]');

    // Get Reddit subreddit if specified
    const redditSubredditInput = document.getElementById('redditSubreddit');
    const redditSubreddit = redditSubredditInput?.value?.trim().replace(/^r\//, '') || '';

    // Get Reddit flair settings
    const redditFlairSelect = document.getElementById('redditFlairSelect');
    const redditFlairId = redditFlairSelect?.value || null;
    const redditFlairText = redditFlairSelect?.options[redditFlairSelect?.selectedIndex]?.dataset?.flairText || null;

    // Get Twitter Premium setting
    const twitterPremiumCheckbox = document.getElementById('twitterPremium');
    const twitterIsPremium = twitterPremiumCheckbox?.checked || false;

    const settings = {
        topics,
        keywords: keywords,
        geoFilter: {
            region: geoRegionSelect ? geoRegionSelect.value : '',
            includeGlobal: includeGlobalNewsCheckbox ? includeGlobalNewsCheckbox.checked : true
        },
        schedule: {
            postsPerDay: parseInt(document.querySelector('select[name="postsPerDay"]')?.value) || 3,
            startTime: document.querySelector('input[name="startTime"]')?.value || '09:00',
            endTime: document.querySelector('input[name="endTime"]')?.value || '21:00'
        },
        contentStyle: {
            tone: document.querySelector('select[name="tone"]')?.value || 'professional',
            includeHashtags: document.querySelector('input[name="includeHashtags"]')?.checked ?? true
        },
        platformSettings: {
            reddit: {
                subreddit: redditSubreddit,
                flairId: redditFlairId,
                flairText: redditFlairText
            },
            twitter: {
                isPremium: twitterIsPremium
            }
        }
    };

    // Show loading state
    const saveBtn = document.querySelector('button[type="submit"]');
    const originalBtnText = saveBtn?.textContent;
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';
    }

    try {
        // If editing an existing agent (via URL param), just update it
        if (agentId) {
            const response = await fetch(`/api/agents/${agentId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                    'X-CSRF-Token': getCsrfToken()
                },
                body: JSON.stringify({ name: agentName, settings })
            });

            const result = await response.json();
            if (result.success) {
                alert(`Agent "${agentName}" updated successfully!`);
                window.location.href = '/profile.html?tab=agents';
            } else {
                showAgentIdentityError(result.error || 'Failed to update agent');
            }
            return;
        }

        // For new agents, create one for each selected platform
        const results = [];
        const errors = [];

        for (const platform of selectedPlatforms) {
            // Find the connection for this platform
            const connection = allConnections.find(c => c.platform === platform);
            if (!connection) {
                errors.push(`No connection found for ${platform}`);
                continue;
            }

            // Check if agent already exists for this connection
            const existingAgent = existingAgents.find(a => a.connection_id === connection.id);
            if (existingAgent) {
                // Update existing agent
                const response = await fetch(`/api/agents/${existingAgent.id}`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`,
                        'X-CSRF-Token': getCsrfToken()
                    },
                    body: JSON.stringify({ name: `${agentName} (${capitalize(platform)})`, settings })
                });
                const result = await response.json();
                if (result.success) {
                    results.push({ platform, action: 'updated', agent: result.agent });
                } else {
                    errors.push(`${platform}: ${result.error}`);
                }
            } else {
                // Create new agent
                const response = await fetch('/api/agents', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`,
                        'X-CSRF-Token': getCsrfToken()
                    },
                    body: JSON.stringify({
                        connectionId: connection.id,
                        name: selectedPlatforms.length > 1 ? `${agentName} (${capitalize(platform)})` : agentName,
                        settings
                    })
                });
                const result = await response.json();
                if (result.success) {
                    results.push({ platform, action: 'created', agent: result.agent });
                } else {
                    errors.push(`${platform}: ${result.error}`);
                }
            }
        }

        // Show results
        if (results.length > 0 && errors.length === 0) {
            const message = results.length === 1
                ? `Agent "${results[0].agent.name}" ${results[0].action} successfully!`
                : `${results.length} agents saved successfully!`;
            alert(message);
            window.location.href = '/profile.html?tab=agents';
        } else if (results.length > 0 && errors.length > 0) {
            alert(`Saved ${results.length} agent(s), but some failed:\n${errors.join('\n')}`);
            window.location.href = '/profile.html?tab=agents';
        } else {
            showAgentIdentityError(errors.join('\n') || 'Failed to save agents');
        }
    } catch (error) {
        console.error('Error saving agent:', error);
        showAgentIdentityError('An error occurred while saving. Please try again.');
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = originalBtnText;
        }
    }
}

/**
 * Show error in the agent identity section
 */
function showAgentIdentityError(message) {
    const errorDiv = document.getElementById('agentIdentityError');
    const errorText = document.getElementById('agentIdentityErrorText');
    if (errorDiv && errorText) {
        errorText.textContent = message;
        errorDiv.classList.remove('hidden');
        // Scroll to error
        errorDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

/**
 * Hide the agent identity error
 */
function hideAgentIdentityError() {
    const errorDiv = document.getElementById('agentIdentityError');
    if (errorDiv) {
        errorDiv.classList.add('hidden');
    }
}

// Legacy function - kept for backwards compatibility
async function saveSettings() {
    // Redirect to new unified save function
    await saveAgentWithSettings();
}

// ============================================
// Agent Mode Functions
// ============================================

/**
 * Load agent settings and set up agent mode UI
 */
async function loadAgentSettings() {
    const token = localStorage.getItem('token');

    try {
        const response = await fetch(`/api/agents/${agentId}`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (response.ok) {
            const data = await response.json();
            currentAgent = data.agent;

            // Populate the Agent Identity section
            const agentNameInput = document.getElementById('agentName');
            if (agentNameInput) {
                agentNameInput.value = currentAgent.name;
            }

            // Select the platform checkbox for this agent's platform
            const platformCheckbox = document.querySelector(`input[name="platforms"][value="${currentAgent.platform}"]`);
            if (platformCheckbox) {
                platformCheckbox.checked = true;
            }

            // Set up agent mode UI (header display)
            setupAgentModeUI();

            // Populate form with agent settings
            populateFormWithAgentSettings(currentAgent.settings);
        } else if (response.status === 401) {
            localStorage.removeItem('token');
            window.location.href = '/auth.html';
        } else if (response.status === 404) {
            alert('Agent not found');
            window.location.href = '/profile.html?tab=agents';
        } else {
            const error = await response.json();
            alert(error.error || 'Failed to load agent');
            window.location.href = '/profile.html?tab=agents';
        }
    } catch (error) {
        console.error('Error loading agent settings:', error);
        alert('Failed to load agent settings');
        window.location.href = '/profile.html?tab=agents';
    }
}

/**
 * Set up the UI for agent mode
 */
function setupAgentModeUI() {
    if (!currentAgent) return;

    // Update back link
    const backLink = document.getElementById('backLink');
    if (backLink) {
        backLink.href = '/profile.html?tab=agents';
        backLink.textContent = '← Back to Agents';
    }

    // Show agent mode header
    const agentModeHeader = document.getElementById('agentModeHeader');
    if (agentModeHeader) {
        agentModeHeader.classList.remove('hidden');
    }

    // Set agent name
    const agentNameDisplay = document.getElementById('agentNameDisplay');
    if (agentNameDisplay) {
        agentNameDisplay.textContent = currentAgent.name;
    }

    // Set platform name
    const agentPlatformDisplay = document.getElementById('agentPlatformDisplay');
    if (agentPlatformDisplay) {
        agentPlatformDisplay.textContent = currentAgent.platform;
    }

    // Set platform icon
    const agentPlatformIcon = document.getElementById('agentPlatformIcon');
    if (agentPlatformIcon) {
        const platformIcons = {
            twitter: { bg: 'bg-[#1DA1F2]/20', svg: '<svg class="w-6 h-6 text-[#1DA1F2]" fill="currentColor" viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>' },
            linkedin: { bg: 'bg-[#0A66C2]/20', svg: '<svg class="w-6 h-6 text-[#0A66C2]" fill="currentColor" viewBox="0 0 24 24"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>' },
            reddit: { bg: 'bg-[#FF4500]/20', svg: '<svg class="w-6 h-6 text-[#FF4500]" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0z"/></svg>' },
            facebook: { bg: 'bg-[#1877F2]/20', svg: '<svg class="w-6 h-6 text-[#1877F2]" fill="currentColor" viewBox="0 0 24 24"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>' },
            instagram: { bg: 'bg-[#E4405F]/20', svg: '<svg class="w-6 h-6 text-[#E4405F]" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0C8.74 0 8.333.015 7.053.072 5.775.132 4.905.333 4.14.63c-.789.306-1.459.717-2.126 1.384S.935 3.35.63 4.14C.333 4.905.131 5.775.072 7.053.012 8.333 0 8.74 0 12s.015 3.667.072 4.947c.06 1.277.261 2.148.558 2.913.306.788.717 1.459 1.384 2.126.667.666 1.336 1.079 2.126 1.384.766.296 1.636.499 2.913.558C8.333 23.988 8.74 24 12 24s3.667-.015 4.947-.072c1.277-.06 2.148-.262 2.913-.558.788-.306 1.459-.718 2.126-1.384.666-.667 1.079-1.335 1.384-2.126.296-.765.499-1.636.558-2.913.06-1.28.072-1.687.072-4.947s-.015-3.667-.072-4.947c-.06-1.277-.262-2.149-.558-2.913-.306-.789-.718-1.459-1.384-2.126C21.319 1.347 20.651.935 19.86.63c-.765-.297-1.636-.499-2.913-.558C15.667.012 15.26 0 12 0zm0 2.16c3.203 0 3.585.016 4.85.071 1.17.055 1.805.249 2.227.415.562.217.96.477 1.382.896.419.42.679.819.896 1.381.164.422.36 1.057.413 2.227.057 1.266.07 1.646.07 4.85s-.015 3.585-.074 4.85c-.061 1.17-.256 1.805-.421 2.227-.224.562-.479.96-.899 1.382-.419.419-.824.679-1.38.896-.42.164-1.065.36-2.235.413-1.274.057-1.649.07-4.859.07-3.211 0-3.586-.015-4.859-.074-1.171-.061-1.816-.256-2.236-.421-.569-.224-.96-.479-1.379-.899-.421-.419-.69-.824-.9-1.38-.165-.42-.359-1.065-.42-2.235-.045-1.26-.061-1.649-.061-4.844 0-3.196.016-3.586.061-4.861.061-1.17.255-1.814.42-2.234.21-.57.479-.96.9-1.381.419-.419.81-.689 1.379-.898.42-.166 1.051-.361 2.221-.421 1.275-.045 1.65-.06 4.859-.06l.045.03zm0 3.678c-3.405 0-6.162 2.76-6.162 6.162 0 3.405 2.76 6.162 6.162 6.162 3.405 0 6.162-2.76 6.162-6.162 0-3.405-2.76-6.162-6.162-6.162zM12 16c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4zm7.846-10.405c0 .795-.646 1.44-1.44 1.44-.795 0-1.44-.646-1.44-1.44 0-.794.646-1.439 1.44-1.439.793-.001 1.44.645 1.44 1.439z"/></svg>' },
            telegram: { bg: 'bg-[#0088cc]/20', svg: '<svg class="w-6 h-6 text-[#0088cc]" fill="currentColor" viewBox="0 0 24 24"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0z"/></svg>' }
        };

        const icon = platformIcons[currentAgent.platform] || { bg: 'bg-gray-700', svg: '' };
        agentPlatformIcon.className = `w-12 h-12 rounded-xl flex items-center justify-center ${icon.bg}`;
        agentPlatformIcon.innerHTML = icon.svg;
    }

    // Update page title
    const settingsTitle = document.getElementById('settingsTitle');
    if (settingsTitle) {
        settingsTitle.textContent = `Configure "${currentAgent.name}"`;
    }

    const settingsSubtitle = document.getElementById('settingsSubtitle');
    if (settingsSubtitle) {
        settingsSubtitle.textContent = `Customize settings for your ${currentAgent.platform} agent`;
    }

    // Hide platform settings section in agent mode (platform is already determined)
    const platformSection = document.querySelector('[data-section="platforms"]');
    if (platformSection) {
        platformSection.classList.add('hidden');
    }
}

/**
 * Populate form with agent-specific settings
 */
function populateFormWithAgentSettings(settings) {
    if (!settings) return;

    // Topics
    if (settings.topics && Array.isArray(settings.topics)) {
        settings.topics.forEach(topic => {
            const checkbox = document.querySelector(`input[name="topics"][value="${topic}"]`);
            if (checkbox) checkbox.checked = true;
        });
    }

    // Keywords
    if (settings.keywords && Array.isArray(settings.keywords)) {
        keywords = settings.keywords.map(k => k.startsWith('#') ? k : `#${k}`);
        renderKeywordTags();
        updateKeywordCounter();
    }

    // Geographic Filter
    if (settings.geoFilter) {
        const geoRegion = document.querySelector('select[name="geoRegion"]');
        const includeGlobalNews = document.querySelector('input[name="includeGlobalNews"]');

        if (geoRegion && settings.geoFilter.region !== undefined) {
            geoRegion.value = settings.geoFilter.region || '';
        }
        if (includeGlobalNews && settings.geoFilter.includeGlobal !== undefined) {
            includeGlobalNews.checked = settings.geoFilter.includeGlobal;
        }
    }

    // Schedule
    if (settings.schedule) {
        const postsPerDay = document.querySelector('select[name="postsPerDay"]');
        const startTime = document.querySelector('input[name="startTime"]');
        const endTime = document.querySelector('input[name="endTime"]');

        if (postsPerDay && settings.schedule.postsPerDay) {
            // Ensure the value doesn't exceed the user's plan limit
            const maxPosts = getUserPostLimit();
            const savedValue = parseInt(settings.schedule.postsPerDay);
            const valueToSet = Math.min(savedValue, maxPosts);

            // Check if the value exists as an option, otherwise use the closest available
            const optionExists = Array.from(postsPerDay.options).some(opt => parseInt(opt.value) === valueToSet);
            if (optionExists) {
                postsPerDay.value = valueToSet;
            } else {
                // Find the closest available option that doesn't exceed the limit
                const availableValues = Array.from(postsPerDay.options).map(opt => parseInt(opt.value));
                const closestValue = availableValues.reduce((prev, curr) =>
                    (curr <= valueToSet && curr > prev) ? curr : prev, availableValues[0]);
                postsPerDay.value = closestValue;
            }
        }
        if (startTime && settings.schedule.startTime) {
            startTime.value = settings.schedule.startTime;
        }
        if (endTime && settings.schedule.endTime) {
            endTime.value = settings.schedule.endTime;
        }
    }

    // Content style
    if (settings.contentStyle) {
        const tone = document.querySelector('select[name="tone"]');
        const includeHashtags = document.querySelector('input[name="includeHashtags"]');

        if (tone && settings.contentStyle.tone) {
            tone.value = settings.contentStyle.tone;
        }
        if (includeHashtags && settings.contentStyle.includeHashtags !== undefined) {
            includeHashtags.checked = settings.contentStyle.includeHashtags;
        }
    }

    // Platform-specific settings
    if (settings.platformSettings) {
        // Reddit subreddit
        if (settings.platformSettings.reddit?.subreddit) {
            const redditSubredditInput = document.getElementById('redditSubreddit');
            if (redditSubredditInput) {
                redditSubredditInput.value = settings.platformSettings.reddit.subreddit;
            }
            // Show the subreddit config if Reddit is the agent's platform
            const subredditConfig = document.getElementById('redditSubredditConfig');
            if (currentAgent?.platform === 'reddit' && subredditConfig) {
                subredditConfig.classList.remove('hidden');
            }
        }

        // Reddit flair settings
        if (settings.platformSettings.reddit?.flairId) {
            const flairSelect = document.getElementById('redditFlairSelect');
            const flairConfig = document.getElementById('redditFlairConfig');

            if (flairSelect && flairConfig) {
                // Show flair config
                flairConfig.classList.remove('hidden');

                // Add the saved flair as an option and select it
                const savedFlairId = settings.platformSettings.reddit.flairId;
                const savedFlairText = settings.platformSettings.reddit.flairText || 'Selected Flair';

                flairSelect.innerHTML = '<option value="">Select a flair...</option>';
                const option = document.createElement('option');
                option.value = savedFlairId;
                option.textContent = savedFlairText;
                option.dataset.flairText = savedFlairText;
                flairSelect.appendChild(option);
                flairSelect.value = savedFlairId;

                // Show success indicator
                const successEl = document.getElementById('redditSubredditSuccess');
                if (successEl) {
                    successEl.classList.remove('hidden');
                    successEl.title = 'Requirements configured';
                }
            }
        }

        // Twitter Premium
        if (settings.platformSettings.twitter?.isPremium !== undefined) {
            const twitterPremiumCheckbox = document.getElementById('twitterPremium');
            if (twitterPremiumCheckbox) {
                twitterPremiumCheckbox.checked = settings.platformSettings.twitter.isPremium;
            }
            // Show the premium config if Twitter is the agent's platform
            const premiumConfig = document.getElementById('twitterPremiumConfig');
            if (currentAgent?.platform === 'twitter' && premiumConfig) {
                premiumConfig.classList.remove('hidden');
            }
        }
    }
}

/**
 * Save agent settings
 */
async function saveAgentSettings() {
    const token = localStorage.getItem('token');

    // Validate Reddit subreddit is required when agent platform is Reddit
    if (currentAgent?.platform === 'reddit') {
        const redditSubredditInput = document.getElementById('redditSubreddit');
        const redditSubreddit = redditSubredditInput?.value?.trim().replace(/^r\//, '') || '';
        if (!redditSubreddit) {
            // Show error on the subreddit field
            const errorEl = document.getElementById('redditSubredditError');
            if (errorEl) {
                errorEl.classList.remove('hidden');
            }
            // Also highlight the input
            if (redditSubredditInput) {
                redditSubredditInput.classList.add('border-red-500');
                redditSubredditInput.focus();
            }
            alert('Please enter a subreddit name for Reddit posting');
            return;
        }
    }

    // Collect form data
    const topics = Array.from(document.querySelectorAll('input[name="topics"]:checked'))
        .map(cb => cb.value);

    // Validate: require at least one topic OR one keyword
    if (topics.length === 0 && keywords.length === 0) {
        alert('Please select at least one topic or add at least one keyword for the agent to find content.');
        // Scroll to topics section
        const topicsSection = document.querySelector('input[name="topics"]');
        if (topicsSection) {
            topicsSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        return;
    }

    // Collect geo-filter settings
    const geoRegionSelect = document.querySelector('select[name="geoRegion"]');
    const includeGlobalNewsCheckbox = document.querySelector('input[name="includeGlobalNews"]');

    // Get Reddit subreddit if specified
    const redditSubredditInput = document.getElementById('redditSubreddit');
    const redditSubreddit = redditSubredditInput?.value?.trim().replace(/^r\//, '') || '';

    // Get Reddit flair settings
    const redditFlairSelect = document.getElementById('redditFlairSelect');
    const redditFlairId = redditFlairSelect?.value || null;
    const redditFlairText = redditFlairSelect?.options[redditFlairSelect?.selectedIndex]?.dataset?.flairText || null;

    // Get Twitter Premium setting
    const twitterPremiumCheckbox = document.getElementById('twitterPremium');
    const twitterIsPremium = twitterPremiumCheckbox?.checked || false;

    const settings = {
        topics,
        keywords: keywords,
        geoFilter: {
            region: geoRegionSelect ? geoRegionSelect.value : '',
            includeGlobal: includeGlobalNewsCheckbox ? includeGlobalNewsCheckbox.checked : true
        },
        schedule: {
            postsPerDay: parseInt(document.querySelector('select[name="postsPerDay"]').value) || 3,
            startTime: document.querySelector('input[name="startTime"]').value || '09:00',
            endTime: document.querySelector('input[name="endTime"]').value || '21:00'
        },
        contentStyle: {
            tone: document.querySelector('select[name="tone"]').value || 'professional',
            includeHashtags: document.querySelector('input[name="includeHashtags"]').checked
        },
        platformSettings: {
            reddit: {
                subreddit: redditSubreddit,
                flairId: redditFlairId,
                flairText: redditFlairText
            },
            twitter: {
                isPremium: twitterIsPremium
            }
        }
    };

    try {
        const response = await fetch(`/api/agents/${agentId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'X-CSRF-Token': getCsrfToken()
            },
            body: JSON.stringify({ settings })
        });

        if (response.ok) {
            alert('Agent settings saved successfully!');
            window.location.href = '/profile.html?tab=agents';
        } else {
            const error = await response.json();
            alert(error.error || 'Failed to save agent settings');
        }
    } catch (error) {
        console.error('Error saving agent settings:', error);
        alert('An error occurred while saving settings');
    }
}