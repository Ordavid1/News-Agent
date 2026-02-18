// app.js - Main application JavaScript

const API_URL = window.location.origin + '/api';
let currentUser = null;
let authToken = localStorage.getItem('token');

// Check if user is logged in on page load
document.addEventListener('DOMContentLoaded', async () => {
    if (authToken) {
        await checkAuth();
    }
    
    // Check if user was redirected after OAuth login
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('token');
    if (token) {
        localStorage.setItem('token', token);
        authToken = token;
        // Remove token from URL
        window.history.replaceState({}, document.title, window.location.pathname);
        await checkAuth();
    }
});

// Authentication check
async function checkAuth() {
    try {
        const response = await fetch(`${API_URL}/users/profile`, {
            headers: {
                'Authorization': `Bearer ${authToken}`
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            currentUser = data.user;
            showDashboard();
        } else {
            logout();
        }
    } catch (error) {
        console.error('Auth check failed:', error);
        logout();
    }
}

// Show login modal - redirect to auth page
function showLogin() {
    window.location.href = '/auth.html';
}

// Show signup modal - redirect to auth page
function showSignup() {
    window.location.href = '/auth.html';
}

// Handle login
async function handleLogin(event) {
    event.preventDefault();
    const formData = new FormData(event.target);
    
    try {
        const response = await fetch(`${API_URL}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: formData.get('email'),
                password: formData.get('password')
            })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            authToken = data.token;
            localStorage.setItem('token', authToken);
            currentUser = data.user;
            closeModal();
            showDashboard();
        } else {
            showError(data.error || 'Login failed');
        }
    } catch (error) {
        showError('Network error. Please try again.');
    }
}

// Handle signup
async function handleSignup(event) {
    event.preventDefault();
    const formData = new FormData(event.target);
    
    try {
        const response = await fetch(`${API_URL}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: formData.get('name'),
                email: formData.get('email'),
                password: formData.get('password')
            })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            authToken = data.token;
            localStorage.setItem('token', authToken);
            currentUser = data.user;
            closeModal();
            showDashboard();
        } else {
            showError(data.error || 'Signup failed');
        }
    } catch (error) {
        showError('Network error. Please try again.');
    }
}

// Show dashboard
function showDashboard() {
    window.location.href = '/profile.html';
}

// Subscribe to a plan
async function subscribe(tier) {
    if (!currentUser) {
        // Store intended plan in localStorage and redirect to auth
        localStorage.setItem('intendedPlan', tier);
        window.location.href = '/auth.html';
        return;
    }
    
    // Redirect to payment page with the selected plan
    window.location.href = `/payment.html?plan=${tier}`;
}

// Utility functions
function closeModal(event) {
    if (event && event.target !== event.currentTarget) return;
    document.getElementById('modalContainer').innerHTML = '';
}

function showError(message) {
    if (window.showToast) {
        window.showToast(message, 'error', 6000);
    } else {
        const errorDiv = document.createElement('div');
        errorDiv.className = 'fixed top-4 right-4 bg-red-50 border border-red-200 text-red-700 px-6 py-3 rounded-xl z-50 shadow-lg text-sm';
        errorDiv.textContent = message;
        document.body.appendChild(errorDiv);
        setTimeout(() => errorDiv.remove(), 3000);
    }
}

function showSuccess(message) {
    if (window.showToast) {
        window.showToast(message, 'success');
    } else {
        const successDiv = document.createElement('div');
        successDiv.className = 'fixed top-4 right-4 bg-green-50 border border-green-200 text-green-700 px-6 py-3 rounded-xl z-50 shadow-lg text-sm';
        successDiv.textContent = message;
        document.body.appendChild(successDiv);
        setTimeout(() => successDiv.remove(), 3000);
    }
}

function logout() {
    localStorage.removeItem('token');
    currentUser = null;
    authToken = null;
    window.location.href = '/';
}

// Expose functions to global scope for onclick handlers
window.showLogin = showLogin;
window.showSignup = showSignup;
window.subscribe = subscribe;
window.handleLogin = handleLogin;
window.handleSignup = handleSignup;
window.closeModal = closeModal;
window.logout = logout;