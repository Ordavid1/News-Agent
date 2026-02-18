/**
 * Theme Manager for News Agent
 * Handles Light / Dark / System theme switching
 * Preferences stored in localStorage under 'theme' key
 * Values: 'light' | 'dark' | 'system' (default)
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'theme';
  const TRANSITION_CLASS = 'theme-transitioning';
  const TRANSITION_DURATION = 300;
  const THEME_COLORS = {
    light: '#6366F1',
    dark: '#1E1B4B'
  };

  function getStoredPreference() {
    try {
      return localStorage.getItem(STORAGE_KEY) || 'system';
    } catch (e) {
      return 'system';
    }
  }

  function getSystemTheme() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function resolveTheme(preference) {
    if (preference === 'dark' || preference === 'light') return preference;
    return getSystemTheme();
  }

  function applyTheme(effective, animate) {
    var root = document.documentElement;

    if (animate) {
      root.classList.add(TRANSITION_CLASS);
    }

    if (effective === 'dark') {
      root.setAttribute('data-theme', 'dark');
    } else {
      root.setAttribute('data-theme', 'light');
    }

    // Update meta theme-color
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute('content', THEME_COLORS[effective] || THEME_COLORS.light);
    }

    // Remove transition class after animation completes
    if (animate) {
      setTimeout(function () {
        root.classList.remove(TRANSITION_CLASS);
      }, TRANSITION_DURATION);
    }
  }

  function updateToggleUI(preference) {
    var buttons = document.querySelectorAll('.theme-toggle-btn');
    buttons.forEach(function (btn) {
      var mode = btn.getAttribute('data-theme-mode');
      if (mode === preference) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }

  var ThemeManager = {
    /**
     * Set theme preference
     * @param {'light'|'dark'|'system'} preference
     */
    setTheme: function (preference) {
      if (preference !== 'light' && preference !== 'dark' && preference !== 'system') {
        preference = 'system';
      }

      try {
        localStorage.setItem(STORAGE_KEY, preference);
      } catch (e) { /* quota exceeded or private mode */ }

      var effective = resolveTheme(preference);
      applyTheme(effective, true);
      updateToggleUI(preference);
    },

    /**
     * Get stored preference ('light', 'dark', or 'system')
     */
    getPreference: function () {
      return getStoredPreference();
    },

    /**
     * Get the currently active theme ('light' or 'dark')
     */
    getEffectiveTheme: function () {
      return resolveTheme(getStoredPreference());
    },

    /**
     * Initialize — call after DOM is ready to wire up toggle buttons
     */
    init: function () {
      var preference = getStoredPreference();
      var effective = resolveTheme(preference);

      // Apply without animation on init (inline script already set data-theme)
      applyTheme(effective, false);
      updateToggleUI(preference);

      // Listen for OS preference changes (matters in "system" mode)
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var handleChange = function () {
        if (getStoredPreference() === 'system') {
          applyTheme(getSystemTheme(), true);
        }
      };
      if (mq.addEventListener) {
        mq.addEventListener('change', handleChange);
      } else if (mq.addListener) {
        mq.addListener(handleChange);
      }

      // Wire up toggle buttons
      document.addEventListener('click', function (e) {
        var btn = e.target.closest('.theme-toggle-btn');
        if (btn) {
          var mode = btn.getAttribute('data-theme-mode');
          if (mode) {
            ThemeManager.setTheme(mode);
          }
        }
      });
    }
  };

  // Expose globally
  window.ThemeManager = ThemeManager;

  // Auto-init when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ThemeManager.init);
  } else {
    ThemeManager.init();
  }
})();
