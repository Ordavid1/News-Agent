// auth.js - Authentication handling
document.addEventListener('DOMContentLoaded', async () => {
    const loginForm = document.getElementById('loginForm');
    const googleSignInBtn = document.getElementById('googleSignIn');
    const showRegisterBtn = document.getElementById('showRegister');
    
    // Check if test mode is enabled
    try {
        const response = await fetch('/api/test/mode');
        if (response.ok) {
            const data = await response.json();
            if (data.testMode) {
                const indicator = document.getElementById('testModeIndicator');
                if (indicator) {
                    indicator.classList.remove('hidden');
                }
            }
        }
    } catch (error) {
        console.log('Could not check test mode');
    }

    // Google Sign In
    if (googleSignInBtn) {
        googleSignInBtn.addEventListener('click', () => {
            window.location.href = '/auth/google';
        });
    }

    // Handle login form submission
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const email = document.getElementById('email').value;
            const password = document.getElementById('password').value;

            try {
                const response = await fetch('/auth/login', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ email, password })
                });

                const data = await response.json();

                if (response.ok) {
                    // Store token in localStorage
                    localStorage.setItem('token', data.token);
                    localStorage.setItem('user', JSON.stringify(data.user));
                    
                    // Check if user had an intended plan
                    const intendedPlan = localStorage.getItem('intendedPlan');
                    if (intendedPlan) {
                        localStorage.removeItem('intendedPlan');
                        window.location.href = `/payment.html?plan=${intendedPlan}`;
                    } else {
                        // Redirect to profile page
                        window.location.href = '/profile.html';
                    }
                } else {
                    alert(data.error || 'Login failed');
                }
            } catch (error) {
                console.error('Login error:', error);
                alert('An error occurred during login');
            }
        });
    }

    // Toggle between login and register (for future implementation)
    if (showRegisterBtn) {
        showRegisterBtn.addEventListener('click', (e) => {
            e.preventDefault();
            alert('Registration will be available soon!');
        });
    }

    // Check for token in URL (from OAuth callback)
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('token');
    const error = urlParams.get('error');
    
    if (error) {
        console.error('Auth error:', error);
        if (error === 'test_mode_active') {
            showError('OAuth callback reached in test mode - please use the test login instead');
        } else {
            showError('Authentication failed: ' + error);
        }
        // Remove error from URL
        window.history.replaceState({}, document.title, window.location.pathname);
    }
    
    if (token) {
        console.log('Token received, logging in...');
        localStorage.setItem('token', token);
        // Remove token from URL
        window.history.replaceState({}, document.title, window.location.pathname);
        
        // Check if user had an intended plan
        const intendedPlan = localStorage.getItem('intendedPlan');
        if (intendedPlan) {
            localStorage.removeItem('intendedPlan');
            window.location.href = `/payment.html?plan=${intendedPlan}`;
        } else {
            // Redirect to profile page
            window.location.href = '/profile.html';
        }
    }
});

// Show error message
function showError(message) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'fixed top-4 right-4 bg-red-500/20 border border-red-500 text-red-400 px-6 py-3 rounded-lg z-50';
    errorDiv.textContent = message;
    document.body.appendChild(errorDiv);
    
    setTimeout(() => {
        errorDiv.remove();
    }, 5000);
}