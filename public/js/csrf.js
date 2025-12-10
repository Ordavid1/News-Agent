// csrf.js - CSRF token management for frontend
// This module handles fetching and including CSRF tokens in all state-changing requests

let csrfToken = null;

/**
 * Initialize CSRF protection by fetching a token from the server
 * Call this on page load
 */
export async function initCsrf() {
    try {
        // First check if we already have a token in the cookie
        const existingToken = getCsrfTokenFromCookie();
        if (existingToken) {
            csrfToken = existingToken;
            return csrfToken;
        }

        // Fetch a fresh token from the server
        const response = await fetch('/api/csrf-token', {
            credentials: 'include' // Important: include cookies
        });

        if (response.ok) {
            const data = await response.json();
            csrfToken = data.csrfToken;
            return csrfToken;
        } else {
            console.error('Failed to fetch CSRF token');
            return null;
        }
    } catch (error) {
        console.error('Error initializing CSRF:', error);
        return null;
    }
}

/**
 * Get the current CSRF token
 * Will return from memory or cookie
 */
export function getCsrfToken() {
    if (csrfToken) {
        return csrfToken;
    }
    // Try to get from cookie as fallback
    return getCsrfTokenFromCookie();
}

/**
 * Get CSRF token from cookie
 */
function getCsrfTokenFromCookie() {
    const cookies = document.cookie.split(';');
    for (const cookie of cookies) {
        const [name, value] = cookie.trim().split('=');
        if (name === 'csrfToken') {
            return value;
        }
    }
    return null;
}

/**
 * Get headers object with CSRF token included
 * Use this when making fetch requests
 * @param {Object} additionalHeaders - Additional headers to include
 */
export function getHeaders(additionalHeaders = {}) {
    const token = getCsrfToken();
    return {
        'Content-Type': 'application/json',
        ...(token && { 'X-CSRF-Token': token }),
        ...additionalHeaders
    };
}

/**
 * Get headers with Authorization token and CSRF
 * @param {string} authToken - The JWT auth token
 * @param {Object} additionalHeaders - Additional headers to include
 */
export function getAuthHeaders(authToken, additionalHeaders = {}) {
    const token = getCsrfToken();
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
        ...(token && { 'X-CSRF-Token': token }),
        ...additionalHeaders
    };
}

/**
 * Wrapper for fetch that automatically includes CSRF token
 * @param {string} url - The URL to fetch
 * @param {Object} options - Fetch options
 */
export async function secureFetch(url, options = {}) {
    const token = getCsrfToken();

    // Ensure we have a CSRF token for non-GET requests
    if (!token && options.method && !['GET', 'HEAD', 'OPTIONS'].includes(options.method.toUpperCase())) {
        // Try to initialize CSRF
        await initCsrf();
    }

    const headers = {
        ...options.headers,
        ...(getCsrfToken() && { 'X-CSRF-Token': getCsrfToken() })
    };

    return fetch(url, {
        ...options,
        headers,
        credentials: 'include' // Ensure cookies are sent
    });
}

// Auto-initialize on script load
initCsrf();

export default {
    initCsrf,
    getCsrfToken,
    getHeaders,
    getAuthHeaders,
    secureFetch
};
