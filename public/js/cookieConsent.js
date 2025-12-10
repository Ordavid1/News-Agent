/**
 * Cookie Consent Manager for News Agent
 * Provides GDPR/CCPA compliant cookie consent with granular controls
 */

(function() {
    'use strict';

    const CONSENT_KEY = 'newsagent_cookie_consent';
    const CONSENT_VERSION = '1.0';

    // Default consent state
    const defaultConsent = {
        version: CONSENT_VERSION,
        timestamp: null,
        essential: true, // Always required
        analytics: false,
        functional: false,
        interacted: false
    };

    // Get stored consent
    function getStoredConsent() {
        try {
            const stored = localStorage.getItem(CONSENT_KEY);
            if (stored) {
                const consent = JSON.parse(stored);
                // Check version - if outdated, show banner again
                if (consent.version !== CONSENT_VERSION) {
                    return null;
                }
                return consent;
            }
        } catch (e) {
            console.error('Error reading cookie consent:', e);
        }
        return null;
    }

    // Save consent
    function saveConsent(consent) {
        consent.timestamp = new Date().toISOString();
        consent.version = CONSENT_VERSION;
        try {
            localStorage.setItem(CONSENT_KEY, JSON.stringify(consent));
        } catch (e) {
            console.error('Error saving cookie consent:', e);
        }
    }

    // Update Google Analytics consent
    function updateGAConsent(analyticsAllowed) {
        if (typeof gtag === 'function') {
            gtag('consent', 'update', {
                'analytics_storage': analyticsAllowed ? 'granted' : 'denied',
                'ad_storage': 'denied' // We don't use ads
            });
        }
    }

    // Create banner HTML
    function createBannerHTML() {
        return `
            <div id="cookie-consent-banner" class="cookie-banner" role="dialog" aria-labelledby="cookie-banner-title" aria-describedby="cookie-banner-desc">
                <div class="cookie-banner-content">
                    <div class="cookie-banner-text">
                        <h3 id="cookie-banner-title" class="cookie-banner-heading">We value your privacy</h3>
                        <p id="cookie-banner-desc" class="cookie-banner-description">
                            We use cookies to enhance your browsing experience, analyze site traffic, and personalize content.
                            By clicking "Accept All", you consent to our use of cookies.
                            <a href="/privacy.html#cookies" class="cookie-link">Learn more</a>
                        </p>
                    </div>
                    <div class="cookie-banner-actions">
                        <button id="cookie-accept-all" class="cookie-btn cookie-btn-accept">Accept All</button>
                        <button id="cookie-reject-nonessential" class="cookie-btn cookie-btn-reject">Essential Only</button>
                        <button id="cookie-customize" class="cookie-btn cookie-btn-customize">Customize</button>
                    </div>
                </div>
            </div>
        `;
    }

    // Create settings modal HTML
    function createSettingsHTML(consent) {
        return `
            <div id="cookie-settings-overlay" class="cookie-overlay" role="dialog" aria-labelledby="cookie-settings-title" aria-modal="true">
                <div class="cookie-settings-modal">
                    <div class="cookie-settings-header">
                        <h2 id="cookie-settings-title" class="cookie-settings-heading">Cookie Preferences</h2>
                        <button id="cookie-settings-close" class="cookie-settings-close" aria-label="Close">&times;</button>
                    </div>
                    <div class="cookie-settings-body">
                        <p class="cookie-settings-intro">
                            Manage your cookie preferences below. Essential cookies are required for the site to function and cannot be disabled.
                        </p>

                        <div class="cookie-category">
                            <div class="cookie-category-header">
                                <div class="cookie-category-info">
                                    <h3 class="cookie-category-title">Essential Cookies</h3>
                                    <p class="cookie-category-desc">Required for authentication, security, and basic site functionality. These cannot be disabled.</p>
                                </div>
                                <label class="cookie-toggle cookie-toggle-disabled">
                                    <input type="checkbox" checked disabled>
                                    <span class="cookie-toggle-slider"></span>
                                    <span class="cookie-toggle-label">Always Active</span>
                                </label>
                            </div>
                        </div>

                        <div class="cookie-category">
                            <div class="cookie-category-header">
                                <div class="cookie-category-info">
                                    <h3 class="cookie-category-title">Analytics Cookies</h3>
                                    <p class="cookie-category-desc">Help us understand how visitors interact with our website by collecting anonymous information. We use Google Analytics for this purpose.</p>
                                </div>
                                <label class="cookie-toggle">
                                    <input type="checkbox" id="cookie-analytics" ${consent.analytics ? 'checked' : ''}>
                                    <span class="cookie-toggle-slider"></span>
                                    <span class="cookie-toggle-label">${consent.analytics ? 'Enabled' : 'Disabled'}</span>
                                </label>
                            </div>
                        </div>

                        <div class="cookie-category">
                            <div class="cookie-category-header">
                                <div class="cookie-category-info">
                                    <h3 class="cookie-category-title">Functional Cookies</h3>
                                    <p class="cookie-category-desc">Enable enhanced functionality and personalization, such as remembering your preferences and settings.</p>
                                </div>
                                <label class="cookie-toggle">
                                    <input type="checkbox" id="cookie-functional" ${consent.functional ? 'checked' : ''}>
                                    <span class="cookie-toggle-slider"></span>
                                    <span class="cookie-toggle-label">${consent.functional ? 'Enabled' : 'Disabled'}</span>
                                </label>
                            </div>
                        </div>
                    </div>
                    <div class="cookie-settings-footer">
                        <button id="cookie-save-preferences" class="cookie-btn cookie-btn-accept">Save Preferences</button>
                        <button id="cookie-accept-all-modal" class="cookie-btn cookie-btn-customize">Accept All</button>
                    </div>
                </div>
            </div>
        `;
    }

    // Show banner
    function showBanner() {
        // Remove existing banner if any
        const existingBanner = document.getElementById('cookie-consent-banner');
        if (existingBanner) {
            existingBanner.remove();
        }

        // Create and insert banner
        const bannerContainer = document.createElement('div');
        bannerContainer.innerHTML = createBannerHTML();
        document.body.appendChild(bannerContainer.firstElementChild);

        // Attach event listeners
        document.getElementById('cookie-accept-all').addEventListener('click', acceptAll);
        document.getElementById('cookie-reject-nonessential').addEventListener('click', rejectNonEssential);
        document.getElementById('cookie-customize').addEventListener('click', showSettings);
    }

    // Hide banner
    function hideBanner() {
        const banner = document.getElementById('cookie-consent-banner');
        if (banner) {
            banner.classList.add('cookie-banner-hidden');
            setTimeout(() => banner.remove(), 300);
        }
    }

    // Show settings modal
    function showSettings() {
        const consent = getStoredConsent() || { ...defaultConsent };

        // Remove existing modal if any
        const existingModal = document.getElementById('cookie-settings-overlay');
        if (existingModal) {
            existingModal.remove();
        }

        // Create and insert modal
        const modalContainer = document.createElement('div');
        modalContainer.innerHTML = createSettingsHTML(consent);
        document.body.appendChild(modalContainer.firstElementChild);

        // Prevent body scroll
        document.body.style.overflow = 'hidden';

        // Attach event listeners
        document.getElementById('cookie-settings-close').addEventListener('click', hideSettings);
        document.getElementById('cookie-save-preferences').addEventListener('click', savePreferences);
        document.getElementById('cookie-accept-all-modal').addEventListener('click', acceptAllFromModal);

        // Update toggle labels on change
        document.getElementById('cookie-analytics').addEventListener('change', function() {
            this.parentElement.querySelector('.cookie-toggle-label').textContent = this.checked ? 'Enabled' : 'Disabled';
        });
        document.getElementById('cookie-functional').addEventListener('change', function() {
            this.parentElement.querySelector('.cookie-toggle-label').textContent = this.checked ? 'Enabled' : 'Disabled';
        });

        // Close on overlay click
        document.getElementById('cookie-settings-overlay').addEventListener('click', function(e) {
            if (e.target === this) {
                hideSettings();
            }
        });

        // Close on Escape key
        document.addEventListener('keydown', handleEscapeKey);
    }

    // Hide settings modal
    function hideSettings() {
        const modal = document.getElementById('cookie-settings-overlay');
        if (modal) {
            modal.classList.add('cookie-overlay-hidden');
            document.body.style.overflow = '';
            setTimeout(() => modal.remove(), 300);
        }
        document.removeEventListener('keydown', handleEscapeKey);
    }

    // Handle Escape key
    function handleEscapeKey(e) {
        if (e.key === 'Escape') {
            hideSettings();
        }
    }

    // Accept all cookies
    function acceptAll() {
        const consent = {
            ...defaultConsent,
            analytics: true,
            functional: true,
            interacted: true
        };
        saveConsent(consent);
        updateGAConsent(true);
        hideBanner();
    }

    // Accept all from modal
    function acceptAllFromModal() {
        acceptAll();
        hideSettings();
    }

    // Reject non-essential cookies
    function rejectNonEssential() {
        const consent = {
            ...defaultConsent,
            analytics: false,
            functional: false,
            interacted: true
        };
        saveConsent(consent);
        updateGAConsent(false);
        hideBanner();
    }

    // Save preferences from modal
    function savePreferences() {
        const analyticsChecked = document.getElementById('cookie-analytics').checked;
        const functionalChecked = document.getElementById('cookie-functional').checked;

        const consent = {
            ...defaultConsent,
            analytics: analyticsChecked,
            functional: functionalChecked,
            interacted: true
        };
        saveConsent(consent);
        updateGAConsent(analyticsChecked);
        hideBanner();
        hideSettings();
    }

    // Initialize
    function init() {
        const consent = getStoredConsent();

        if (consent && consent.interacted) {
            // User has already made a choice, apply their preferences
            updateGAConsent(consent.analytics);
        } else {
            // Show banner for new visitors
            // Wait for DOM to be ready
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', showBanner);
            } else {
                showBanner();
            }
        }
    }

    // Expose public API
    window.CookieConsent = {
        showSettings: showSettings,
        getConsent: getStoredConsent,
        acceptAll: acceptAll,
        rejectNonEssential: rejectNonEssential,
        reset: function() {
            localStorage.removeItem(CONSENT_KEY);
            showBanner();
        }
    };

    // Initialize on load
    init();

})();
