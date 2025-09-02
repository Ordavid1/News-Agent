// profile.js - Profile page handling
document.addEventListener('DOMContentLoaded', async () => {
    // Check if user is authenticated
    const token = localStorage.getItem('token');
    if (!token) {
        window.location.href = '/auth.html';
        return;
    }

    // Load user data
    try {
        const response = await fetch('/api/users/profile', {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (response.ok) {
            const userData = await response.json();
            updateProfileUI(userData);
        } else if (response.status === 401) {
            // Token expired or invalid
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            window.location.href = '/auth.html';
        }
    } catch (error) {
        console.error('Error loading profile:', error);
    }

    // Handle logout
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
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

    // Handle start agent button
    const startAgentBtn = document.getElementById('startAgentBtn');
    if (startAgentBtn) {
        startAgentBtn.addEventListener('click', () => {
            window.location.href = '/payment.html';
        });
    }

    // Handle configure button
    const configureBtn = document.getElementById('configureBtn');
    if (configureBtn) {
        configureBtn.addEventListener('click', () => {
            window.location.href = '/settings.html';
        });
    }
});

function updateProfileUI(userData) {
    // Update user info
    const userEmail = document.getElementById('userEmail');
    const userName = document.getElementById('userName');
    
    if (userEmail) userEmail.textContent = userData.email;
    if (userName) userName.textContent = userData.name || 'User';

    // Show appropriate UI based on subscription status
    const freeUserState = document.getElementById('freeUserState');
    const activeUserState = document.getElementById('activeUserState');
    
    if (userData.subscription && userData.subscription.status === 'active') {
        if (freeUserState) freeUserState.classList.add('hidden');
        if (activeUserState) activeUserState.classList.remove('hidden');
    } else {
        if (freeUserState) freeUserState.classList.remove('hidden');
        if (activeUserState) activeUserState.classList.add('hidden');
    }
}