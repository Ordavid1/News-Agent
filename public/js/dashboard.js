// dashboard.js - Dashboard functionality

const API_URL = window.location.origin + '/api';
let authToken = localStorage.getItem('authToken');
let currentUser = null;
let currentPost = null;

// Platform configurations
// Note: 'disabled' platforms are shown faded with "Coming Soon" - integration not yet set up
const PLATFORMS = {
    twitter: { name: 'Twitter', icon: '🐦', available: ['growth', 'professional', 'business'] },
    linkedin: { name: 'LinkedIn', icon: '💼', available: ['free', 'starter', 'growth', 'professional', 'business'] },
    reddit: { name: 'Reddit', icon: '🔴', available: ['free', 'starter', 'growth', 'professional', 'business'] },
    telegram: { name: 'Telegram', icon: '✈️', available: ['free', 'starter', 'growth', 'professional', 'business'] },
    facebook: { name: 'Facebook', icon: '📘', available: [], disabled: true, disabledReason: 'Coming Soon' },
    threads: { name: 'Threads', icon: '@', available: [], disabled: true, disabledReason: 'Coming Soon' },
    instagram: { name: 'Instagram', icon: '📸', available: ['professional', 'business'] },
    tiktok: { name: 'TikTok', icon: '🎵', available: ['business'] },
    youtube: { name: 'YouTube', icon: '▶️', available: ['business'] }
};

// Initialize dashboard
document.addEventListener('DOMContentLoaded', async () => {
    // Check if we're in demo mode
    const demoConfig = sessionStorage.getItem('demoConfig');
    if (demoConfig && !authToken) {
        // Demo mode - no auth required
        initializeDemoMode();
    } else if (!authToken) {
        window.location.href = '/';
        return;
    } else {
        await loadUserProfile();
    }
    
    setupPlatformOptions();
    showSection('posts'); // Show posts by default to see demo posts
});

// Load user profile
async function loadUserProfile() {
    try {
        const response = await fetch(`${API_URL}/users/profile`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        if (response.ok) {
            const data = await response.json();
            currentUser = data.user;
            updateUI();
        } else {
            logout();
        }
    } catch (error) {
        console.error('Failed to load profile:', error);
        logout();
    }
}

// Update UI with user data
function updateUI() {
    if (!currentUser) return;
    
    // Update posts remaining
    document.getElementById('postsRemaining').textContent = 
        `${currentUser.subscription.postsRemaining}/${currentUser.subscription.dailyLimit || getTierLimit(currentUser.subscription.tier)}`;
    document.getElementById('subPostsRemaining').textContent = currentUser.subscription.postsRemaining;
    
    // Update subscription info
    document.getElementById('currentTier').textContent = 
        currentUser.subscription.tier.charAt(0).toUpperCase() + currentUser.subscription.tier.slice(1);
    
    // Update reset time countdown
    updateResetCountdown();
    
    // Update profile
    document.getElementById('userName').value = currentUser.name;
    
    // Load API key
    loadApiKey();
}

// Helper function to get tier limits
function getTierLimit(tier) {
    const limits = {
        free: 5,
        starter: 10,
        growth: 20,
        professional: 30,
        business: 45
    };
    return limits[tier] || 5;
}

// Update countdown to next reset
function updateResetCountdown() {
    const updateCountdown = () => {
        const now = new Date();
        const resetDate = new Date(currentUser.subscription.resetDate);
        const diff = resetDate - now;
        
        if (diff <= 0) {
            // Time to reset - reload user data
            loadUserProfile();
            return;
        }
        
        const hours = Math.floor(diff / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        
        document.getElementById('resetTime').textContent = `${hours}h ${minutes}m`;
    };
    
    updateCountdown();
    // Update every minute
    setInterval(updateCountdown, 60000);
}

// Setup platform options based on user tier
function setupPlatformOptions() {
    const container = document.getElementById('platformOptions');
    container.innerHTML = '';

    const userTier = currentUser?.subscription?.tier || 'free';

    Object.entries(PLATFORMS).forEach(([platform, config]) => {
        const isDisabled = config.disabled === true;
        const isAvailable = !isDisabled && config.available.includes(userTier);

        const label = document.createElement('label');
        label.className = `flex items-center gap-2 px-4 py-2 rounded-lg border ${
            isAvailable
                ? 'border-purple-500/50 hover:bg-purple-500/20 cursor-pointer'
                : 'border-gray-700 opacity-50 cursor-not-allowed'
        }`;

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.name = 'platforms';
        checkbox.value = platform;
        checkbox.disabled = !isAvailable;
        checkbox.className = 'rounded text-purple-500';

        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(`${config.icon} ${config.name}`));

        if (isDisabled) {
            // Platform is globally disabled (e.g., integration not set up)
            const disabledText = document.createElement('span');
            disabledText.className = 'text-xs text-gray-500 ml-2';
            disabledText.textContent = `(${config.disabledReason || 'Unavailable'})`;
            label.appendChild(disabledText);
        } else if (!isAvailable) {
            // Platform requires higher tier
            const tier = config.available[0];
            const tierText = document.createElement('span');
            tierText.className = 'text-xs text-gray-500 ml-2';
            tierText.textContent = `(${tier}+)`;
            label.appendChild(tierText);
        }

        container.appendChild(label);
    });
}

// Show/hide sections
function showSection(section) {
    // Hide all sections
    document.querySelectorAll('section').forEach(s => s.classList.add('hidden'));
    
    // Show selected section
    document.getElementById(`${section}Section`).classList.remove('hidden');
    
    // Load section-specific data
    switch(section) {
        case 'posts':
            loadPosts();
            break;
        case 'analytics':
            loadAnalytics();
            break;
        case 'subscription':
            loadSubscription();
            break;
    }
}

// Generate post
async function generatePost(event) {
    event.preventDefault();
    
    if (currentUser.subscription.postsRemaining <= 0) {
        showError('You have no posts remaining. Please upgrade your subscription.');
        return;
    }
    
    const formData = new FormData(event.target);
    const platforms = Array.from(formData.getAll('platforms'));
    
    if (platforms.length === 0) {
        showError('Please select at least one platform');
        return;
    }
    
    const generateBtn = event.target.querySelector('button[type="submit"]');
    const originalText = generateBtn.textContent;
    generateBtn.disabled = true;
    generateBtn.innerHTML = '<div class="loader mx-auto"></div>';
    
    try {
        // Check if we're in demo mode
        const isDemoMode = currentUser && currentUser.id === 'demo-user';
        const endpoint = isDemoMode ? '/api/demo/generate' : `${API_URL}/posts/generate`;
        const headers = {
            'Content-Type': 'application/json'
        };
        
        if (!isDemoMode) {
            headers['Authorization'] = `Bearer ${authToken}`;
        }
        
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({
                topic: formData.get('topic'),
                topics: [formData.get('topic')], // For demo endpoint
                platforms: platforms,
                plan: currentUser.subscription.tier
            })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            currentPost = data.post;
            displayGeneratedPost(data.post);
            
            // If demo mode, save to sessionStorage
            if (currentUser && currentUser.id === 'demo-user') {
                const existingPosts = JSON.parse(sessionStorage.getItem('demoPosts') || '[]');
                existingPosts.unshift(data.post); // Add new post at the beginning
                sessionStorage.setItem('demoPosts', JSON.stringify(existingPosts));
                
                // Update posts remaining for demo
                currentUser.subscription.postsRemaining--;
            } else {
                // Update posts remaining from server response
                currentUser.subscription.postsRemaining = data.postsRemaining;
            }
            
            document.getElementById('postsRemaining').textContent = 
                `${currentUser.subscription.postsRemaining}/${currentUser.subscription.dailyLimit || getTierLimit(currentUser.subscription.tier)}`;
            document.getElementById('subPostsRemaining').textContent = currentUser.subscription.postsRemaining;
            
            showSuccess('Post generated successfully!');
        } else {
            showError(data.error || 'Failed to generate post');
        }
    } catch (error) {
        showError('Network error. Please try again.');
    } finally {
        generateBtn.disabled = false;
        generateBtn.textContent = originalText;
    }
}

// Display generated post
function displayGeneratedPost(post) {
    const container = document.getElementById('generatedPost');
    container.classList.remove('hidden');
    
    document.getElementById('postContent').textContent = post.content;
    
    const platformsContainer = document.getElementById('postPlatforms');
    platformsContainer.innerHTML = '';
    
    post.platforms.forEach(platform => {
        const badge = document.createElement('span');
        badge.className = `platform-badge platform-${platform}`;
        badge.textContent = PLATFORMS[platform]?.name || platform;
        platformsContainer.appendChild(badge);
    });
    
    // Scroll to preview
    container.scrollIntoView({ behavior: 'smooth' });
}

// Load posts
async function loadPosts() {
    // Check if we're in demo mode
    if (currentUser && currentUser.id === 'demo-user') {
        loadDemoPosts();
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/posts`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        if (response.ok) {
            const data = await response.json();
            displayPosts(data.posts);
        }
    } catch (error) {
        console.error('Failed to load posts:', error);
    }
}

// Display posts list
function displayPosts(posts) {
    const container = document.getElementById('postsList');
    
    if (posts.length === 0) {
        container.innerHTML = '<p class="text-gray-400">No posts yet. Generate your first post!</p>';
        return;
    }
    
    container.innerHTML = posts.map(post => `
        <div class="neon-border p-6">
            <div class="flex justify-between items-start mb-4">
                <div>
                    <h3 class="text-lg font-semibold">${post.topic}</h3>
                    <p class="text-gray-400 text-sm">${new Date(post.createdAt).toLocaleString()}</p>
                </div>
                <div class="flex gap-2">
                    ${post.platforms.map(p => `
                        <span class="platform-badge platform-${p}">${PLATFORMS[p]?.name || p}</span>
                    `).join('')}
                </div>
            </div>
            <p class="text-gray-300">${post.content.substring(0, 200)}...</p>
        </div>
    `).join('');
}

// Load analytics
async function loadAnalytics() {
    try {
        const response = await fetch(`${API_URL}/analytics/overview`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        if (response.ok) {
            const data = await response.json();
            displayAnalytics(data.analytics);
        }
    } catch (error) {
        console.error('Failed to load analytics:', error);
    }
}

// Display analytics
function displayAnalytics(analytics) {
    document.getElementById('totalPosts').textContent = analytics.totalPosts;
    document.getElementById('successRate').textContent = analytics.successRate.toFixed(0) + '%';
    
    // Find most used platform
    const platforms = Object.entries(analytics.platformBreakdown);
    if (platforms.length > 0) {
        const topPlatform = platforms.reduce((a, b) => a[1] > b[1] ? a : b);
        document.getElementById('topPlatform').textContent = PLATFORMS[topPlatform[0]]?.name || topPlatform[0];
    }
    
    // Platform breakdown
    const breakdownContainer = document.getElementById('platformBreakdown');
    breakdownContainer.innerHTML = platforms.map(([platform, count]) => `
        <div class="flex justify-between items-center py-2">
            <span>${PLATFORMS[platform]?.icon} ${PLATFORMS[platform]?.name || platform}</span>
            <span class="text-purple-400">${count} posts</span>
        </div>
    `).join('');
}

// Load subscription details
async function loadSubscription() {
    try {
        const response = await fetch(`${API_URL}/subscriptions/current`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        if (response.ok) {
            const data = await response.json();
            // Subscription data is already displayed from user profile
        }
    } catch (error) {
        console.error('Failed to load subscription:', error);
    }
}

// Load API key
async function loadApiKey() {
    try {
        const response = await fetch(`${API_URL}/users/api-key`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        if (response.ok) {
            const data = await response.json();
            document.getElementById('apiKey').value = data.apiKey;
        }
    } catch (error) {
        console.error('Failed to load API key:', error);
    }
}

// Update profile
async function updateProfile(event) {
    event.preventDefault();
    const formData = new FormData(event.target);
    
    try {
        const response = await fetch(`${API_URL}/users/profile`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({
                name: formData.get('name')
            })
        });
        
        if (response.ok) {
            showSuccess('Profile updated successfully!');
            await loadUserProfile();
        } else {
            const data = await response.json();
            showError(data.error || 'Failed to update profile');
        }
    } catch (error) {
        showError('Network error. Please try again.');
    }
}

// Copy API key
function copyApiKey() {
    const apiKeyInput = document.getElementById('apiKey');
    apiKeyInput.select();
    document.execCommand('copy');
    showSuccess('API key copied to clipboard!');
}

// Utility functions
function showError(message) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'fixed top-4 right-4 bg-red-500/20 border border-red-500 text-red-400 px-6 py-3 rounded-lg z-50';
    errorDiv.textContent = message;
    document.body.appendChild(errorDiv);
    
    setTimeout(() => errorDiv.remove(), 3000);
}

function showSuccess(message) {
    const successDiv = document.createElement('div');
    successDiv.className = 'fixed top-4 right-4 bg-green-500/20 border border-green-500 text-green-400 px-6 py-3 rounded-lg z-50';
    successDiv.textContent = message;
    document.body.appendChild(successDiv);
    
    setTimeout(() => successDiv.remove(), 3000);
}

function logout() {
    localStorage.removeItem('authToken');
    sessionStorage.clear(); // Clear demo data too
    window.location.href = '/';
}

// Demo mode functions
function initializeDemoMode() {
    const config = JSON.parse(sessionStorage.getItem('demoConfig'));
    
    // Create mock user for demo
    currentUser = {
        id: 'demo-user',
        email: 'demo@example.com',
        name: 'Demo User',
        subscription: {
            tier: config.plan || 'starter',
            postsRemaining: 10,
            dailyLimit: getTierLimit(config.plan || 'starter'),
            resetDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        }
    };
    
    // Display demo configuration
    const demoConfigDisplay = document.getElementById('demoConfigDisplay');
    if (demoConfigDisplay) {
        demoConfigDisplay.classList.remove('hidden');
        document.getElementById('demoPlan').textContent = config.plan.charAt(0).toUpperCase() + config.plan.slice(1);
        document.getElementById('demoTopics').textContent = config.topics.join(', ');
        document.getElementById('demoPlatforms').textContent = config.platforms.join(', ');
    }
    
    updateUI();
    loadDemoPosts();
}

// Load demo posts from sessionStorage
function loadDemoPosts() {
    const demoPosts = JSON.parse(sessionStorage.getItem('demoPosts') || '[]');
    if (demoPosts.length > 0) {
        displayPosts(demoPosts);
    }
}

// Add loader styles
const style = document.createElement('style');
style.textContent = `
    .loader {
        width: 20px;
        height: 20px;
        border: 2px solid transparent;
        border-top-color: white;
        border-radius: 50%;
        animation: spin 1s linear infinite;
    }
    
    @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
    }
`;
document.head.appendChild(style);

// Expose functions to global scope for onclick handlers
window.showSection = showSection;
window.generatePost = generatePost;
window.publishPost = publishPost;
window.updateProfile = updateProfile;
window.copyApiKey = copyApiKey;
window.logout = logout;