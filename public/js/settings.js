// settings.js - Settings page handling

// Global state for connected platforms
let connectedPlatforms = [];

document.addEventListener('DOMContentLoaded', async () => {
    // Check if user is authenticated
    const token = localStorage.getItem('token');
    if (!token) {
        window.location.href = '/auth.html';
        return;
    }

    // Load connected platforms first, then settings
    await loadConnectedPlatforms();
    await loadSettings();

    // Handle form submission
    const settingsForm = document.getElementById('settingsForm');
    if (settingsForm) {
        settingsForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            await saveSettings();
        });
    }
});

/**
 * Fetch user's connected social platforms from the API
 */
async function loadConnectedPlatforms() {
    const token = localStorage.getItem('token');

    try {
        const response = await fetch('/api/connections', {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (response.ok) {
            const data = await response.json();
            connectedPlatforms = (data.connections || [])
                .filter(c => c.status === 'active')
                .map(c => c.platform);

            updatePlatformUI();
        }
    } catch (error) {
        console.error('Error loading connections:', error);
    }
}

/**
 * Update the platform checkboxes to show connection status
 */
function updatePlatformUI() {
    const allPlatforms = ['twitter', 'linkedin', 'reddit', 'facebook', 'telegram'];
    const disconnected = [];

    allPlatforms.forEach(platform => {
        const checkbox = document.querySelector(`input[name="platforms"][value="${platform}"]`);
        const label = checkbox?.closest('label');

        if (!checkbox || !label) return;

        const isConnected = connectedPlatforms.includes(platform);

        if (isConnected) {
            // Platform is connected - enable and show green indicator
            checkbox.disabled = false;
            label.classList.remove('opacity-50');

            // Add connected indicator if not already present
            if (!label.querySelector('.connection-status')) {
                const statusBadge = document.createElement('span');
                statusBadge.className = 'connection-status text-xs bg-green-500/20 text-green-400 px-2 py-1 rounded-full ml-2';
                statusBadge.textContent = 'Connected';
                label.querySelector('.font-medium').appendChild(statusBadge);
            }
        } else {
            // Platform not connected - disable and show indicator
            checkbox.disabled = true;
            checkbox.checked = false;
            label.classList.add('opacity-50');
            disconnected.push(platform);

            // Add not connected indicator if not already present
            if (!label.querySelector('.connection-status')) {
                const statusBadge = document.createElement('span');
                statusBadge.className = 'connection-status text-xs bg-gray-500/20 text-gray-400 px-2 py-1 rounded-full ml-2';
                statusBadge.textContent = 'Not connected';
                label.querySelector('.font-medium').appendChild(statusBadge);
            }
        }
    });

    // Show hint if some platforms are not connected
    const hintDiv = document.getElementById('connectionHint');
    const hintText = document.getElementById('connectionHintText');

    if (hintDiv && hintText && disconnected.length > 0) {
        hintText.innerHTML = `
            <a href="/profile.html?tab=connections" class="text-yellow-400 hover:text-yellow-300 underline">
                Connect more platforms
            </a> to enable them for posting. Currently disconnected: ${disconnected.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(', ')}
        `;
        hintDiv.classList.remove('hidden');
    } else if (hintDiv) {
        hintDiv.classList.add('hidden');
    }
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

    // Schedule
    if (settings.schedule) {
        const postsPerDay = document.querySelector('select[name="postsPerDay"]');
        const startTime = document.querySelector('input[name="startTime"]');
        const endTime = document.querySelector('input[name="endTime"]');

        if (postsPerDay && settings.schedule.postsPerDay) {
            postsPerDay.value = settings.schedule.postsPerDay;
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
}

async function saveSettings() {
    const token = localStorage.getItem('token');

    // Collect form data
    const topics = Array.from(document.querySelectorAll('input[name="topics"]:checked'))
        .map(cb => cb.value);

    const platforms = Array.from(document.querySelectorAll('input[name="platforms"]:checked'))
        .map(cb => cb.value);

    const settings = {
        topics,
        schedule: {
            postsPerDay: document.querySelector('select[name="postsPerDay"]').value,
            startTime: document.querySelector('input[name="startTime"]').value,
            endTime: document.querySelector('input[name="endTime"]').value
        },
        contentStyle: {
            tone: document.querySelector('select[name="tone"]').value,
            includeHashtags: document.querySelector('input[name="includeHashtags"]').checked
        },
        platforms
    };

    try {
        const response = await fetch('/api/users/settings', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(settings)
        });

        if (response.ok) {
            alert('Settings saved successfully! Use "Try One Post" from the dashboard to test.');
            window.location.href = '/profile.html';
        } else {
            const error = await response.json();
            alert(error.error || 'Failed to save settings');
        }
    } catch (error) {
        console.error('Error saving settings:', error);
        alert('An error occurred while saving settings');
    }
}