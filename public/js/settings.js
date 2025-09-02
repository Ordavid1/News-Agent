// settings.js - Settings page handling
document.addEventListener('DOMContentLoaded', async () => {
    // Check if user is authenticated
    const token = localStorage.getItem('token');
    if (!token) {
        window.location.href = '/auth.html';
        return;
    }

    // Load current settings
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

    // Platforms
    if (settings.platforms) {
        settings.platforms.forEach(platform => {
            const checkbox = document.querySelector(`input[name="platforms"][value="${platform}"]`);
            if (checkbox) checkbox.checked = true;
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
            alert('Settings saved successfully!');
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