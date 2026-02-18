/**
 * Shared Animation & UI Utilities
 * - Scroll-triggered animations (IntersectionObserver)
 * - Unified toast notification system
 * - Modal open/close helpers
 * - Counter animation
 */

(function () {
  'use strict';

  // ===== SCROLL ANIMATIONS =====
  function initScrollAnimations() {
    const elements = document.querySelectorAll('.animate-on-scroll, .stagger-children');
    if (!elements.length) return;

    // Respect reduced motion preference
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      elements.forEach(el => {
        el.classList.add('visible');
        el.style.opacity = '1';
        el.style.transform = 'none';
      });
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const delay = parseInt(entry.target.dataset.delay) || 0;
          setTimeout(() => {
            entry.target.classList.add('visible');
          }, delay);
          observer.unobserve(entry.target);
        }
      });
    }, {
      threshold: 0.1,
      rootMargin: '0px 0px -40px 0px'
    });

    elements.forEach(el => observer.observe(el));
  }

  // ===== TOAST NOTIFICATIONS =====
  let toastContainer = null;

  function getToastContainer() {
    if (!toastContainer || !document.body.contains(toastContainer)) {
      toastContainer = document.createElement('div');
      toastContainer.className = 'toast-container';
      toastContainer.setAttribute('role', 'alert');
      toastContainer.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastContainer);
    }
    return toastContainer;
  }

  const toastIcons = {
    success: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="10" fill="#22C55E" opacity="0.15"/><path d="M6.5 10.5L9 13L14 7" stroke="#22C55E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    error: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="10" fill="#EF4444" opacity="0.15"/><path d="M7 7L13 13M13 7L7 13" stroke="#EF4444" stroke-width="2" stroke-linecap="round"/></svg>',
    warning: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="10" fill="#F59E0B" opacity="0.15"/><path d="M10 6V11M10 14V14.5" stroke="#F59E0B" stroke-width="2" stroke-linecap="round"/></svg>',
    info: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="10" fill="#3B82F6" opacity="0.15"/><path d="M10 9V14M10 6V6.5" stroke="#3B82F6" stroke-width="2" stroke-linecap="round"/></svg>'
  };

  function showToast(message, type = 'info', duration = 4000) {
    const container = getToastContainer();
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
      <span class="flex-shrink-0 mt-0.5">${toastIcons[type] || toastIcons.info}</span>
      <p class="flex-1 text-sm text-ink-700">${escapeHtml(message)}</p>
      <button onclick="this.closest('.toast').remove()" class="flex-shrink-0 p-1 rounded-full hover:bg-surface-100 text-ink-400 hover:text-ink-600 transition-colors" aria-label="Close">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M4 4L10 10M10 4L4 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>
    `;
    container.appendChild(toast);

    // Auto-dismiss
    if (duration > 0) {
      setTimeout(() => {
        if (toast.parentNode) {
          toast.classList.add('toast-exit');
          setTimeout(() => toast.remove(), 300);
        }
      }, duration);
    }

    // Limit visible toasts
    const toasts = container.querySelectorAll('.toast');
    if (toasts.length > 5) {
      toasts[0].remove();
    }

    return toast;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ===== MODAL HELPERS =====
  function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;

    modal.style.display = 'flex';
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    // Focus trap setup
    const focusableElements = modal.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (focusableElements.length) {
      setTimeout(() => focusableElements[0].focus(), 100);
    }

    // Close on overlay click
    modal.addEventListener('click', function handler(e) {
      if (e.target === modal) {
        closeModal(modalId);
        modal.removeEventListener('click', handler);
      }
    });

    // Close on Escape
    function escHandler(e) {
      if (e.key === 'Escape') {
        closeModal(modalId);
        document.removeEventListener('keydown', escHandler);
      }
    }
    document.addEventListener('keydown', escHandler);
  }

  function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;

    const content = modal.querySelector('.modal-content');
    if (content) {
      content.style.animation = 'modalOut 0.2s ease-in forwards';
    }
    modal.style.animation = 'fadeOut 0.2s ease-in forwards';

    setTimeout(() => {
      modal.style.display = 'none';
      modal.classList.add('hidden');
      modal.style.animation = '';
      if (content) content.style.animation = '';
      document.body.style.overflow = '';
    }, 200);
  }

  // ===== COUNTER ANIMATION =====
  function animateCounter(element, target, duration = 1500) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      element.textContent = target.toLocaleString();
      return;
    }

    const start = 0;
    const startTime = performance.now();

    function update(currentTime) {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = Math.floor(start + (target - start) * eased);
      element.textContent = current.toLocaleString();

      if (progress < 1) {
        requestAnimationFrame(update);
      } else {
        element.textContent = target.toLocaleString();
      }
    }

    requestAnimationFrame(update);
  }

  function initCounters() {
    const counters = document.querySelectorAll('[data-counter]');
    if (!counters.length) return;

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const target = parseInt(entry.target.dataset.counter) || 0;
          const duration = parseInt(entry.target.dataset.counterDuration) || 1500;
          animateCounter(entry.target, target, duration);
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.3 });

    counters.forEach(el => observer.observe(el));
  }

  // ===== SMOOTH SCROLL =====
  function initSmoothScroll() {
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
      anchor.addEventListener('click', function (e) {
        const targetId = this.getAttribute('href');
        if (targetId === '#') return;
        const target = document.querySelector(targetId);
        if (target) {
          e.preventDefault();
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
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
    initScrollAnimations();
    initCounters();
    initSmoothScroll();
  }

  init();

  // Expose globally
  window.showToast = showToast;
  window.showSuccess = function (msg) { return showToast(msg, 'success'); };
  window.showError = function (msg) { return showToast(msg, 'error', 6000); };
  window.showWarning = function (msg) { return showToast(msg, 'warning'); };
  window.showInfo = function (msg) { return showToast(msg, 'info'); };
  window.openModal = openModal;
  window.closeModal = closeModal;
  window.animateCounter = animateCounter;

})();
