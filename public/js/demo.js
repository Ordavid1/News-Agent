// demo.js - Interactive demo functionality
console.log('Demo.js file loading...');

let selectedPlan = 'growth';
let selectedTopics = [];
let selectedPlatforms = [];

// Utility functions - define early
function showError(message) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'fixed top-4 right-4 bg-red-500/20 border border-red-500 text-red-400 px-6 py-3 rounded-lg z-50';
    errorDiv.textContent = message;
    document.body.appendChild(errorDiv);
    
    setTimeout(() => {
        errorDiv.remove();
    }, 3000);
}

function showSuccess(message) {
    const successDiv = document.createElement('div');
    successDiv.className = 'fixed top-4 right-4 bg-green-500/20 border border-green-500 text-green-400 px-6 py-3 rounded-lg z-50';
    successDiv.textContent = message;
    document.body.appendChild(successDiv);
    
    setTimeout(() => {
        successDiv.remove();
    }, 3000);
}

// Platform availability by tier
const platformTiers = {
    twitter: ['free', 'starter', 'growth', 'professional', 'business'],
    linkedin: ['starter', 'growth', 'professional', 'business'],
    reddit: ['growth', 'professional', 'business'],
    facebook: ['professional', 'business'],
    instagram: ['professional', 'business'],
    tiktok: ['business']
};

// Daily limits by plan
const planLimits = {
    starter: 10,
    growth: 20,
    professional: 30,
    business: 45
};

// Sample content for preview
const sampleContent = {
    ai: {
        twitter: "🤖 Breaking: OpenAI announces GPT-5 with unprecedented reasoning capabilities! The AI revolution continues to accelerate. What's your take on the future of AI? #AI #GPT5 #TechNews",
        linkedin: "🚀 The AI Revolution Continues!\n\nOpenAI just announced GPT-5, marking another milestone in artificial intelligence. Key highlights:\n\n• Advanced reasoning capabilities\n• Improved contextual understanding\n• Enhanced creativity\n• Better safety measures\n\nAs AI professionals, we're witnessing history. The implications for business automation, content creation, and problem-solving are immense.\n\nHow is your organization preparing for the next wave of AI innovation?\n\n#ArtificialIntelligence #Innovation #TechLeadership",
        reddit: {
            title: "OpenAI Announces GPT-5: Game Changer or Hype?",
            content: "Just saw the announcement about GPT-5's new reasoning capabilities. As someone working in AI, I'm both excited and cautious. The benchmarks look impressive, but real-world application is what matters. What are your thoughts on this? Are we getting closer to AGI or is this just incremental improvement?"
        }
    },
    tech: {
        twitter: "💻 Apple's M4 chip benchmarks are insane! 40% faster than M3, with 50% better energy efficiency. The future of computing is here! 🔥 #AppleSilicon #TechNews",
        linkedin: "Tech Innovation Alert: Apple M4 Chip Sets New Standards\n\nThe latest benchmarks are in, and they're remarkable:\n• 40% performance increase\n• 50% better energy efficiency\n• Enhanced AI processing\n\nThis isn't just about speed – it's about redefining what's possible in mobile computing. The implications for developers and creators are massive.\n\n#Technology #Innovation #Apple",
        reddit: {
            title: "Apple M4 Benchmarks Are Out - Mind Blown!",
            content: "Just ran some tests on the new M4 MacBook. The performance jump is real. Compile times cut in half, video rendering is butter smooth. Anyone else getting similar results?"
        }
    },
    startup: {
        twitter: "🚀 Startup tip: Your first 100 customers will teach you more than any MBA. Listen, iterate, and build what they actually need, not what you think they want. #StartupLife #Entrepreneurship",
        linkedin: "Startup Wisdom: The Power of Your First 100 Customers\n\nAfter mentoring 50+ startups, one truth stands out: Your early customers are your best teachers.\n\nWhy the first 100 matter:\n• They're risk-takers who believe in your vision\n• Their feedback is brutally honest\n• They help shape your product-market fit\n• They become your biggest advocates\n\nRemember: Build for them, not for everyone.\n\n#Startups #Entrepreneurship #ProductMarketFit",
        reddit: {
            title: "First 100 Customers: Lessons Learned",
            content: "Running a SaaS startup for 2 years now. Our first 100 customers completely changed our product direction. We thought we were building project management software, turns out we were solving a workflow automation problem. Anyone else pivot based on early customer feedback?"
        }
    }
};

// Initialize demo
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOMContentLoaded - Initializing demo...');
    
    // Clear any previous selections and set defaults
    selectedPlan = 'starter'; // Start with free plan for testing
    selectedTopics = [];
    selectedPlatforms = [];
    
    // Clear any selected topics from previous sessions
    document.querySelectorAll('[id^="topic-"]').forEach(el => {
        el.classList.remove('selected');
    });
    
    // Clear any selected platforms
    document.querySelectorAll('[id^="platform-"]').forEach(el => {
        el.classList.remove('selected');
    });
    
    // Update UI to reflect starter plan
    selectPlan('starter');
    updatePlatformAvailability();
    
    // Add event listeners since onclick might be blocked by CSP
    setupEventListeners();
});

// Setup event listeners
function setupEventListeners() {
    console.log('Setting up event listeners...');
    
    // Plan selection - Remove onclick attribute to avoid double firing
    document.querySelectorAll('[id^="plan-"]').forEach(el => {
        const plan = el.id.replace('plan-', '');
        el.removeAttribute('onclick'); // Remove inline handler
        el.addEventListener('click', () => selectPlan(plan));
        console.log(`Added listener for plan: ${plan}`);
    });
    
    // Topic selection - Remove onclick attribute to avoid double firing
    document.querySelectorAll('[id^="topic-"]').forEach(el => {
        const topic = el.id.replace('topic-', '');
        el.removeAttribute('onclick'); // Remove inline handler
        el.addEventListener('click', () => toggleTopic(topic));
        console.log(`Added listener for topic: ${topic}`);
    });
    
    // Platform selection - Remove onclick attribute to avoid double firing
    document.querySelectorAll('[id^="platform-"]').forEach(el => {
        const platform = el.id.replace('platform-', '');
        el.removeAttribute('onclick'); // Remove inline handler
        el.addEventListener('click', () => togglePlatform(platform));
        console.log(`Added listener for platform: ${platform}`);
    });
    
    // Button listeners - Fix generate preview button
    const generateBtns = document.querySelectorAll('button');
    generateBtns.forEach(btn => {
        if (btn.textContent.includes('Generate Sample')) {
            btn.removeAttribute('onclick');
            btn.addEventListener('click', generatePreview);
            console.log('Added listener for generate preview button');
        }
    });
    
    const startTrialBtn = document.querySelector('button[onclick*="startFreeTrial"]');
    if (startTrialBtn) {
        startTrialBtn.removeAttribute('onclick');
        startTrialBtn.addEventListener('click', startFreeTrial);
    }
    
    // Posts per day slider
    const postsSlider = document.getElementById('postsPerDay');
    if (postsSlider) {
        postsSlider.addEventListener('input', updatePostsPerDay);
        postsSlider.addEventListener('change', updatePostsPerDay);
        console.log('Added listeners for posts per day slider');
    }
}

// Plan selection
function selectPlan(plan) {
    console.log('selectPlan called with:', plan);
    // showSuccess(`Plan clicked: ${plan}`); // Commented out for debugging
    
    // Remove previous selection
    document.querySelectorAll('[id^="plan-"]').forEach(el => {
        el.classList.remove('selected');
    });
    
    // Add selection to new plan
    const planElement = document.getElementById(`plan-${plan}`);
    if (planElement) {
        planElement.classList.add('selected');
        selectedPlan = plan;
        console.log('Plan selected:', selectedPlan);
    } else {
        console.error('Plan element not found:', `plan-${plan}`);
    }
    
    // Update platform availability
    updatePlatformAvailability();
    
    // Update daily limit
    document.getElementById('dailyLimit').textContent = planLimits[plan];
    document.getElementById('postsPerDay').max = planLimits[plan];
    
    // Adjust posts per day if it exceeds new limit
    const currentValue = parseInt(document.getElementById('postsPerDay').value);
    if (currentValue > planLimits[plan]) {
        document.getElementById('postsPerDay').value = planLimits[plan];
        updatePostsPerDay();
    }
}

// Update platform availability based on selected plan
function updatePlatformAvailability() {
    Object.keys(platformTiers).forEach(platform => {
        const element = document.getElementById(`platform-${platform}`);
        const availableInPlan = platformTiers[platform].includes(selectedPlan);
        
        element.classList.remove('available', 'unavailable', 'selected');
        
        if (availableInPlan) {
            element.classList.add('available');
        } else {
            element.classList.add('unavailable');
            // Remove from selected if it was selected
            const index = selectedPlatforms.indexOf(platform);
            if (index > -1) {
                selectedPlatforms.splice(index, 1);
            }
        }
    });
}

// Topic selection - Only allow one topic at a time
function toggleTopic(topic) {
    console.log('toggleTopic called with:', topic);
    const element = document.getElementById(`topic-${topic}`);
    
    if (!element) {
        console.error('Topic element not found:', `topic-${topic}`);
        return;
    }
    
    // Clear all previously selected topics
    document.querySelectorAll('[id^="topic-"]').forEach(el => {
        el.classList.remove('selected');
    });
    
    // Clear the array and add only the new topic
    selectedTopics = [topic];
    element.classList.add('selected');
    
    console.log('Current selected topic:', selectedTopics[0]);
}

// Platform selection
function togglePlatform(platform) {
    console.log('togglePlatform called with:', platform);
    const element = document.getElementById(`platform-${platform}`);
    
    if (!element) {
        console.error('Platform element not found:', `platform-${platform}`);
        return;
    }
    
    // Check if platform is available in current plan
    if (!platformTiers[platform].includes(selectedPlan)) {
        console.log('Platform not available in plan, showing upgrade prompt');
        showUpgradePrompt(platform);
        return;
    }
    
    if (selectedPlatforms.includes(platform)) {
        selectedPlatforms = selectedPlatforms.filter(p => p !== platform);
        element.classList.remove('selected');
    } else {
        selectedPlatforms.push(platform);
        element.classList.add('selected');
    }
}

// Update posts per day display
function updatePostsPerDay() {
    const slider = document.getElementById('postsPerDay');
    const value = slider.value;
    document.getElementById('postsPerDayValue').textContent = value;
    console.log('Posts per day updated to:', value);
}

// Generate preview
async function generatePreview() {
    console.log('generatePreview called');
    console.log('Selected topics:', selectedTopics);
    console.log('Selected platforms:', selectedPlatforms);
    
    // Clear any previous preview
    document.getElementById('previewContainer').classList.add('hidden');
    
    if (selectedTopics.length === 0) {
        showError('Please select a topic');
        return;
    }
    
    // Platform selection is optional since we show all platforms in demo
    // if (selectedPlatforms.length === 0) {
    //     showError('Please select at least one platform');
    //     return;
    // }
    
    // Show loading state
    const generateBtn = document.querySelector('button[onclick*="generatePreview"]') || 
                        document.querySelector('button.bg-gradient-to-r');
    const generateBtnText = document.getElementById('generateBtnText');
    const loadingSpinner = document.getElementById('loadingSpinner');
    
    const originalText = generateBtnText.textContent;
    generateBtnText.textContent = 'Fetching real news...';
    loadingSpinner.classList.remove('hidden');
    generateBtn.disabled = true;
    
    try {
        // Debug: Log what we're sending
        console.log('Sending to API:', {
            topics: selectedTopics,
            platforms: selectedPlatforms,
            plan: selectedPlan
        });
        
        // Fetch real news content from the API
        const response = await fetch('/api/demo/generate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                topics: selectedTopics,
                platforms: selectedPlatforms,
                plan: selectedPlan
            })
        });
        
        if (!response.ok) {
            throw new Error('Failed to generate content');
        }
        
        // Update loading text
        generateBtnText.textContent = 'Generating content...';
        
        const data = await response.json();
        console.log('Server response:', data);
        const generatedPost = data.post;
        
        // Show preview container
        document.getElementById('previewContainer').classList.remove('hidden');
        // Use the first selected topic from our local state, not what server returns
        const displayTopic = selectedTopics[0] || generatedPost.topic;
        document.getElementById('previewTopic').textContent = displayTopic.toUpperCase();
        
        // Show all platform previews for demo
        const demoPlatforms = ['twitter', 'linkedin', 'reddit'];
        
        // Check if we have platform-specific content
        const hasPlatformContent = generatedPost.platforms && typeof generatedPost.platforms === 'object';
        
        demoPlatforms.forEach((platform, index) => {
            setTimeout(() => {
                // Use platform-specific content
                const content = hasPlatformContent ? generatedPost.platforms[platform] : generatedPost.content;
                
                if (platform === 'twitter' && content) {
                    showTwitterPreview(content);
                } else if (platform === 'linkedin' && content) {
                    showLinkedInPreview(content);
                } else if (platform === 'reddit' && content) {
                    showRedditPreview(content);
                }
            }, index * 500);
        });
        
    } catch (error) {
        console.error('Error generating preview:', error);
        showError('Failed to fetch real news. Please try again.');
    } finally {
        // Restore button state
        generateBtnText.textContent = originalText;
        loadingSpinner.classList.add('hidden');
        generateBtn.disabled = false;
        
        // Clear topic and platform selections after generation attempt
        selectedTopics = [];
        selectedPlatforms = [];
        
        // Clear visual selections
        document.querySelectorAll('[id^="topic-"]').forEach(el => {
            el.classList.remove('selected');
        });
        document.querySelectorAll('[id^="platform-"]').forEach(el => {
            el.classList.remove('selected');
        });
        
        console.log('Cleared all selections after generation');
    }
}

// Show platform-specific previews
function showTwitterPreview(content) {
    const preview = document.getElementById('twitterPreview');
    const contentEl = document.getElementById('twitterContent');
    const charsEl = document.getElementById('twitterChars');
    
    preview.classList.remove('hidden');
    contentEl.textContent = '';
    
    // Typing animation
    let i = 0;
    const typing = setInterval(() => {
        if (i < content.length) {
            contentEl.textContent += content[i];
            charsEl.textContent = i + 1;
            i++;
        } else {
            clearInterval(typing);
        }
    }, 20);
}

function showLinkedInPreview(content) {
    const preview = document.getElementById('linkedinPreview');
    const contentEl = document.getElementById('linkedinContent');
    
    preview.classList.remove('hidden');
    contentEl.textContent = '';
    
    // Typing animation
    let i = 0;
    const typing = setInterval(() => {
        if (i < content.length) {
            contentEl.textContent += content[i];
            i++;
        } else {
            clearInterval(typing);
        }
    }, 10);
}

function showRedditPreview(content) {
    const preview = document.getElementById('redditPreview');
    const titleEl = document.getElementById('redditTitle');
    const contentEl = document.getElementById('redditContent');
    
    preview.classList.remove('hidden');
    
    // Handle both object format (with title/content) and string format
    let title = '';
    let body = '';
    
    if (typeof content === 'string') {
        // Parse the string format "Title: ...\nContent: ..."
        const lines = content.split('\n');
        const titleLine = lines.find(line => line.startsWith('Title:'));
        const contentStart = lines.findIndex(line => line.startsWith('Content:'));
        
        if (titleLine) {
            title = titleLine.replace('Title:', '').trim();
        }
        if (contentStart !== -1) {
            body = lines.slice(contentStart).join('\n').replace('Content:', '').trim();
        } else {
            // If no specific format, use the whole content
            title = 'Discussion';
            body = content;
        }
    } else if (content.title && content.content) {
        title = content.title;
        body = content.content;
    } else {
        title = 'Discussion';
        body = content.toString();
    }
    
    titleEl.textContent = title;
    contentEl.textContent = '';
    
    // Typing animation for content
    let i = 0;
    const typing = setInterval(() => {
        if (i < body.length) {
            contentEl.textContent += body[i];
            i++;
        } else {
            clearInterval(typing);
        }
    }, 10);
}

// Show upgrade prompt
function showUpgradePrompt(platform) {
    const requiredPlan = platformTiers[platform].find(tier => 
        tier !== 'free' && tier !== 'starter'
    ) || 'growth';
    
    const modal = `
        <div class="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4" onclick="closeModal(event)">
            <div class="neon-border p-8 max-w-md w-full" onclick="event.stopPropagation()">
                <h2 class="text-2xl font-bold mb-4 glow-text">Upgrade Required 🚀</h2>
                <p class="text-gray-300 mb-6">
                    ${platform.charAt(0).toUpperCase() + platform.slice(1)} is available in the 
                    <span class="text-purple-400 font-semibold">${requiredPlan}</span> plan and above.
                </p>
                <div class="flex gap-4">
                    <button onclick="selectPlan('${requiredPlan}'); closeModal();" class="flex-1 bg-gradient-to-r from-purple-500 to-pink-500 py-3 rounded-full font-semibold hover:scale-105 transition">
                        Upgrade to ${requiredPlan}
                    </button>
                    <button onclick="closeModal()" class="flex-1 border border-gray-600 py-3 rounded-full hover:bg-gray-900 transition">
                        Cancel
                    </button>
                </div>
            </div>
        </div>
    `;
    document.getElementById('modalContainer').innerHTML = modal;
}

// Start free trial
async function startFreeTrial() {
    if (selectedTopics.length === 0 || selectedPlatforms.length === 0) {
        showError('Please complete your configuration first');
        return;
    }
    
    // Store configuration in session
    const config = {
        plan: selectedPlan,
        topics: selectedTopics,
        platforms: selectedPlatforms,
        postsPerDay: document.getElementById('postsPerDay').value
    };
    
    sessionStorage.setItem('demoConfig', JSON.stringify(config));
    
    // Show loading state - get the button that was clicked
    const button = document.querySelector('button[onclick="startFreeTrial()"]');
    const originalText = button.textContent;
    button.textContent = 'Generating your first post...';
    button.disabled = true;
    
    try {
        // Generate a demo post
        const response = await fetch('/api/demo/generate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                topics: selectedTopics,
                platforms: selectedPlatforms,
                plan: selectedPlan
            })
        });
        
        if (!response.ok) {
            throw new Error('Failed to generate post');
        }
        
        const data = await response.json();
        
        // Show success message and redirect to dashboard
        showSuccess(`Demo post created! Topic: ${data.post.topic}`);
        
        // Store the generated post in sessionStorage for the dashboard
        const existingPosts = JSON.parse(sessionStorage.getItem('demoPosts') || '[]');
        existingPosts.push(data.post);
        sessionStorage.setItem('demoPosts', JSON.stringify(existingPosts));
        
        // Redirect to dashboard after a short delay
        setTimeout(() => {
            window.location.href = '/dashboard.html';
        }, 2000);
        
    } catch (error) {
        console.error('Error generating demo post:', error);
        showError('Failed to generate demo post. Please try again.');
        button.textContent = originalText;
        button.disabled = false;
    }
}

// Show signup modal
function showSignup() {
    window.location.href = '/#signup';
}

// Utility functions
function closeModal(event) {
    if (event && event.target !== event.currentTarget) return;
    document.getElementById('modalContainer').innerHTML = '';
}

// Expose functions to global scope for onclick handlers
window.selectPlan = selectPlan;
window.toggleTopic = toggleTopic;
window.togglePlatform = togglePlatform;
window.updatePostsPerDay = updatePostsPerDay;
window.generatePreview = generatePreview;
window.startFreeTrial = startFreeTrial;
window.showSignup = showSignup;
window.closeModal = closeModal;

console.log('Demo.js loaded successfully');