/**
 * Shared Audio Module — Premium Playable Ads
 *
 * Lightweight audio sprite manager for playable ads.
 * Generates procedural audio using Web Audio API (no external files needed).
 * MRAID-compatible: respects visibility and user mute.
 *
 * Exported via window.SHARED_FX.audio when concatenated by TemplateRenderer.
 */

(function () {
  'use strict';

  var audio = {};
  var _ctx = null;
  var _muted = false;
  var _initialized = false;
  var _masterGain = null;

  function getContext() {
    if (!_ctx) {
      try {
        _ctx = new (window.AudioContext || window.webkitAudioContext)();
        _masterGain = _ctx.createGain();
        _masterGain.connect(_ctx.destination);
        _masterGain.gain.value = _muted ? 0 : 0.5;
      } catch (e) {
        // Audio not supported — fail silently
      }
    }
    return _ctx;
  }

  /**
   * Initialize audio system. Call once in BootScene.create().
   * Resumes AudioContext on first user interaction.
   */
  audio.init = function (scene) {
    if (_initialized) return;
    _initialized = true;

    scene.input.once('pointerdown', function () {
      var ctx = getContext();
      if (ctx && ctx.state === 'suspended') {
        ctx.resume();
      }
    });
  };

  /**
   * Toggle mute state.
   */
  audio.toggleMute = function () {
    _muted = !_muted;
    if (_masterGain) {
      _masterGain.gain.value = _muted ? 0 : 0.5;
    }
    return _muted;
  };

  audio.isMuted = function () { return _muted; };

  // ── Procedural Sound Effects ────────────────────────────────

  /**
   * Short tap/click sound.
   */
  audio.playTap = function () {
    var ctx = getContext();
    if (!ctx || _muted) return;
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(_masterGain);
    osc.frequency.setValueAtTime(800, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(400, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.1);
  };

  /**
   * Score increment chime — rising tone.
   */
  audio.playScore = function () {
    var ctx = getContext();
    if (!ctx || _muted) return;
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = 'sine';
    osc.connect(gain);
    gain.connect(_masterGain);
    osc.frequency.setValueAtTime(523, ctx.currentTime);        // C5
    osc.frequency.setValueAtTime(659, ctx.currentTime + 0.06); // E5
    osc.frequency.setValueAtTime(784, ctx.currentTime + 0.12); // G5
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.25);
  };

  /**
   * Success / win fanfare — two-tone ascending.
   */
  audio.playSuccess = function () {
    var ctx = getContext();
    if (!ctx || _muted) return;

    [523, 659, 784, 1047].forEach(function (freq, i) {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = 'sine';
      osc.connect(gain);
      gain.connect(_masterGain);
      var t = ctx.currentTime + i * 0.1;
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.2, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      osc.start(t);
      osc.stop(t + 0.35);
    });
  };

  /**
   * Fail / miss sound — descending tone.
   */
  audio.playFail = function () {
    var ctx = getContext();
    if (!ctx || _muted) return;
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = 'square';
    osc.connect(gain);
    gain.connect(_masterGain);
    osc.frequency.setValueAtTime(300, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(100, ctx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.25);
  };

  /**
   * Whoosh / transition sound.
   */
  audio.playWhoosh = function () {
    var ctx = getContext();
    if (!ctx || _muted) return;

    var bufferSize = ctx.sampleRate * 0.2;
    var buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    var data = buffer.getChannelData(0);
    for (var i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    }

    var noise = ctx.createBufferSource();
    noise.buffer = buffer;

    var filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(2000, ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(500, ctx.currentTime + 0.15);
    filter.Q.value = 2;

    var gain = ctx.createGain();
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(_masterGain);
    noise.start(ctx.currentTime);
    noise.stop(ctx.currentTime + 0.25);
  };

  /**
   * Gentle tick/timer sound.
   */
  audio.playTick = function () {
    var ctx = getContext();
    if (!ctx || _muted) return;
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = 'sine';
    osc.connect(gain);
    gain.connect(_masterGain);
    osc.frequency.setValueAtTime(1200, ctx.currentTime);
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.03);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.05);
  };

  // ── Mute Button Creator ─────────────────────────────────────
  /**
   * Creates a small mute toggle icon in the corner of the scene.
   * Returns the container.
   */
  audio.createMuteButton = function (scene, opts) {
    opts = opts || {};
    var x = opts.x || 30;
    var y = opts.y || 30;
    var size = opts.size || 20;

    var btn = scene.add.text(x, y, _muted ? '\uD83D\uDD07' : '\uD83D\uDD0A', {
      fontSize: size + 'px'
    }).setOrigin(0.5).setInteractive({ useHandCursor: true }).setDepth(9000).setAlpha(0.6);

    btn.on('pointerdown', function () {
      var nowMuted = audio.toggleMute();
      btn.setText(nowMuted ? '\uD83D\uDD07' : '\uD83D\uDD0A');
      audio.playTap();
    });

    btn.on('pointerover', function () { btn.setAlpha(1); });
    btn.on('pointerout', function () { btn.setAlpha(0.6); });

    return btn;
  };

  // ── Expose ──────────────────────────────────────────────────
  window.SHARED_FX = window.SHARED_FX || {};
  window.SHARED_FX.audio = audio;
})();
