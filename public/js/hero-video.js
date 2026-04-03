/**
 * Hero Split-Screen Video Interaction
 *
 * Two video panels side by side. On hover/focus:
 * - The hovered panel's video plays, its label fades
 * - The other panel dims with a messaging overlay
 * On leave: both return to idle state
 * Mobile: tap to toggle instead of hover
 *
 * Controls: play/pause, progress scrubbing, mute/unmute
 */
(function () {
    'use strict';

    var panelNews = document.getElementById('panel-news');
    var panelMarketing = document.getElementById('panel-marketing');
    var videoNews = document.getElementById('video-news');
    var videoMarketing = document.getElementById('video-marketing');
    var splitContainer = document.getElementById('hero-split');

    if (!panelNews || !panelMarketing || !splitContainer) return;

    var isTouchDevice = function () { return 'ontouchstart' in window || navigator.maxTouchPoints > 0; };
    var prefersReducedMotion = function () { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; };

    // ============================================================
    // Panel activation / dimming
    // ============================================================

    function playVideo(video, thenUnmute) {
        if (!video || prefersReducedMotion()) return;
        // Always start muted so autoplay is allowed by the browser
        video.muted = true;
        function doPlay() {
            video.play().then(function () {
                // Unmute after playback has started successfully
                if (thenUnmute) {
                    video.muted = false;
                    syncMuteIcon(video);
                }
            }).catch(function () {});
        }
        if (video.readyState >= 2) {
            doPlay();
        } else {
            video.addEventListener('canplay', function onCanPlay() {
                video.removeEventListener('canplay', onCanPlay);
                doPlay();
            });
        }
    }

    function pauseVideo(video) {
        if (!video) return;
        video.pause();
    }

    function activatePanel(activePanel, dimmedPanel, activeVideo, dimmedVideo) {
        activePanel.classList.add('panel-active');
        activePanel.classList.remove('panel-dimmed');
        dimmedPanel.classList.add('panel-dimmed');
        dimmedPanel.classList.remove('panel-active');

        playVideo(activeVideo, true);
        pauseVideo(dimmedVideo);

        if (dimmedVideo) { dimmedVideo.muted = true; syncMuteIcon(dimmedVideo); }

        syncPlayPauseIcon(activeVideo);
        syncPlayPauseIcon(dimmedVideo);
    }

    function resetPanels() {
        panelNews.classList.remove('panel-active', 'panel-dimmed');
        panelMarketing.classList.remove('panel-active', 'panel-dimmed');
        pauseVideo(videoNews);
        pauseVideo(videoMarketing);

        // Re-mute both on reset
        if (videoNews) { videoNews.muted = true; syncMuteIcon(videoNews); }
        if (videoMarketing) { videoMarketing.muted = true; syncMuteIcon(videoMarketing); }

        syncPlayPauseIcon(videoNews);
        syncPlayPauseIcon(videoMarketing);
    }

    // ============================================================
    // Video Controls — play/pause, progress, mute
    // ============================================================

    function getControlsForVideo(video) {
        var id = video.id;
        var bar = document.querySelector('.hero-video-controls[data-for="' + id + '"]');
        if (!bar) return null;
        return {
            bar: bar,
            playBtn: bar.querySelector('.hero-ctrl-play'),
            iconPlay: bar.querySelector('.hero-icon-play'),
            iconPause: bar.querySelector('.hero-icon-pause'),
            progressTrack: bar.querySelector('.hero-ctrl-progress'),
            progressFilled: bar.querySelector('.hero-progress-filled'),
            progressThumb: bar.querySelector('.hero-progress-thumb'),
            muteBtn: bar.querySelector('.hero-ctrl-mute'),
            iconMuted: bar.querySelector('.hero-icon-muted'),
            iconUnmuted: bar.querySelector('.hero-icon-unmuted')
        };
    }

    function syncPlayPauseIcon(video) {
        var c = getControlsForVideo(video);
        if (!c) return;
        var playing = !video.paused && !video.ended;
        c.iconPlay.classList.toggle('hidden', playing);
        c.iconPause.classList.toggle('hidden', !playing);
    }

    function syncMuteIcon(video) {
        var c = getControlsForVideo(video);
        if (!c) return;
        c.iconMuted.classList.toggle('hidden', !video.muted);
        c.iconUnmuted.classList.toggle('hidden', video.muted);
    }

    function updateProgress(video) {
        var c = getControlsForVideo(video);
        if (!c || !video.duration) return;
        var pct = (video.currentTime / video.duration) * 100;
        c.progressFilled.style.width = pct + '%';
        c.progressThumb.style.left = pct + '%';
    }

    function seekVideo(video, progressTrack, clientX) {
        var rect = progressTrack.getBoundingClientRect();
        var pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        if (video.duration) {
            video.currentTime = pct * video.duration;
        }
        updateProgress(video);
    }

    function initControls(video) {
        var c = getControlsForVideo(video);
        if (!c) return;

        // Play / Pause
        c.playBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            if (video.paused) {
                video.play().catch(function () {});
            } else {
                video.pause();
            }
        });

        // Mute / Unmute
        c.muteBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            video.muted = !video.muted;
            syncMuteIcon(video);
        });

        // Progress bar — click to seek
        c.progressTrack.addEventListener('click', function (e) {
            e.stopPropagation();
            seekVideo(video, c.progressTrack, e.clientX);
        });

        // Progress bar — drag to scrub
        var dragging = false;

        c.progressTrack.addEventListener('mousedown', function (e) {
            e.stopPropagation();
            e.preventDefault();
            dragging = true;
            seekVideo(video, c.progressTrack, e.clientX);
        });

        document.addEventListener('mousemove', function (e) {
            if (!dragging) return;
            seekVideo(video, c.progressTrack, e.clientX);
        });

        document.addEventListener('mouseup', function () {
            dragging = false;
        });

        // Touch drag for mobile
        c.progressTrack.addEventListener('touchstart', function (e) {
            e.stopPropagation();
            dragging = true;
            seekVideo(video, c.progressTrack, e.touches[0].clientX);
        }, { passive: true });

        document.addEventListener('touchmove', function (e) {
            if (!dragging) return;
            seekVideo(video, c.progressTrack, e.touches[0].clientX);
        }, { passive: true });

        document.addEventListener('touchend', function () {
            dragging = false;
        });

        // Time update → sync progress bar
        video.addEventListener('timeupdate', function () {
            if (!dragging) updateProgress(video);
        });

        // Play/pause events → sync icon
        video.addEventListener('play', function () { syncPlayPauseIcon(video); });
        video.addEventListener('pause', function () { syncPlayPauseIcon(video); });

        // Init icons
        syncPlayPauseIcon(video);
        syncMuteIcon(video);
    }

    initControls(videoNews);
    initControls(videoMarketing);

    // ============================================================
    // Desktop: hover events
    // ============================================================

    panelNews.addEventListener('mouseenter', function () {
        if (isTouchDevice()) return;
        activatePanel(panelNews, panelMarketing, videoNews, videoMarketing);
    });

    panelMarketing.addEventListener('mouseenter', function () {
        if (isTouchDevice()) return;
        activatePanel(panelMarketing, panelNews, videoMarketing, videoNews);
    });

    splitContainer.addEventListener('mouseleave', function () {
        if (isTouchDevice()) return;
        resetPanels();
    });

    // ============================================================
    // Keyboard: focus / blur
    // ============================================================

    panelNews.addEventListener('focus', function () {
        activatePanel(panelNews, panelMarketing, videoNews, videoMarketing);
    });

    panelMarketing.addEventListener('focus', function () {
        activatePanel(panelMarketing, panelNews, videoMarketing, videoNews);
    });

    [panelNews, panelMarketing].forEach(function (panel) {
        panel.addEventListener('blur', function () {
            setTimeout(function () {
                if (
                    document.activeElement !== panelNews &&
                    document.activeElement !== panelMarketing &&
                    !panelNews.contains(document.activeElement) &&
                    !panelMarketing.contains(document.activeElement)
                ) {
                    resetPanels();
                }
            }, 10);
        });
    });

    // ============================================================
    // Mobile: tap to toggle
    // ============================================================

    if (isTouchDevice()) {
        var activePanelRef = null;

        function handleTap(tapped, other, tappedVideo, otherVideo, e) {
            // Don't intercept taps on control buttons
            if (e.target.closest('.hero-video-controls')) return;
            e.preventDefault();
            e.stopPropagation();
            if (activePanelRef === tapped) {
                resetPanels();
                activePanelRef = null;
            } else {
                activatePanel(tapped, other, tappedVideo, otherVideo);
                activePanelRef = tapped;
            }
        }

        panelNews.addEventListener('click', function (e) {
            handleTap(panelNews, panelMarketing, videoNews, videoMarketing, e);
        });

        panelMarketing.addEventListener('click', function (e) {
            handleTap(panelMarketing, panelNews, videoMarketing, videoNews, e);
        });

        document.addEventListener('click', function (e) {
            if (activePanelRef && !panelNews.contains(e.target) && !panelMarketing.contains(e.target)) {
                resetPanels();
                activePanelRef = null;
            }
        });
    }
})();
