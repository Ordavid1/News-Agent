/**
 * Shared Navigation Utilities
 * - Mobile menu toggle
 * - Scroll-based nav styling
 * - Active link highlighting
 */

(function () {
  'use strict';

  // ===== MOBILE MENU =====
  function initMobileMenu() {
    const toggle = document.getElementById('mobile-menu-toggle');
    const menu = document.getElementById('mobile-menu');
    if (!toggle || !menu) return;

    let isOpen = false;

    toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      isOpen = !isOpen;
      menu.classList.toggle('hidden', !isOpen);

      // Animate hamburger to X
      const bars = toggle.querySelectorAll('.menu-bar');
      if (bars.length === 3) {
        if (isOpen) {
          bars[0].style.transform = 'rotate(45deg) translate(5px, 5px)';
          bars[1].style.opacity = '0';
          bars[2].style.transform = 'rotate(-45deg) translate(5px, -5px)';
        } else {
          bars[0].style.transform = '';
          bars[1].style.opacity = '1';
          bars[2].style.transform = '';
        }
      }

      // Update aria
      toggle.setAttribute('aria-expanded', isOpen);
    });

    // Close on outside click
    document.addEventListener('click', function (e) {
      if (isOpen && !menu.contains(e.target) && !toggle.contains(e.target)) {
        isOpen = false;
        menu.classList.add('hidden');
        toggle.setAttribute('aria-expanded', 'false');
        const bars = toggle.querySelectorAll('.menu-bar');
        if (bars.length === 3) {
          bars[0].style.transform = '';
          bars[1].style.opacity = '1';
          bars[2].style.transform = '';
        }
      }
    });

    // Close on Escape
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen) {
        isOpen = false;
        menu.classList.add('hidden');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.focus();
      }
    });

    // Close on link click
    menu.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', function () {
        isOpen = false;
        menu.classList.add('hidden');
        toggle.setAttribute('aria-expanded', 'false');
      });
    });
  }

  // ===== SCROLL NAV EFFECT =====
  function initScrollNav() {
    const nav = document.querySelector('.nav-glass');
    if (!nav) return;

    let ticking = false;

    function updateNav() {
      if (window.scrollY > 10) {
        nav.classList.add('nav-glass-scrolled');
      } else {
        nav.classList.remove('nav-glass-scrolled');
      }
      ticking = false;
    }

    window.addEventListener('scroll', function () {
      if (!ticking) {
        requestAnimationFrame(updateNav);
        ticking = true;
      }
    }, { passive: true });

    // Initial check
    updateNav();
  }

  // ===== ACTIVE LINK =====
  function initActiveLinks() {
    const currentPath = window.location.pathname;
    document.querySelectorAll('.nav-link').forEach(link => {
      const href = link.getAttribute('href');
      if (href === currentPath || (href !== '/' && currentPath.startsWith(href))) {
        link.classList.add('text-brand-600', 'font-semibold');
        link.classList.remove('text-ink-600');
      }
    });
  }

  // ===== INIT =====
  function init() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', run);
    } else {
      run();
    }
  }

  function run() {
    initMobileMenu();
    initScrollNav();
    initActiveLinks();
  }

  init();

})();
