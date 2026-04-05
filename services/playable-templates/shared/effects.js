/**
 * Shared Visual Effects Module — Premium Playable Ads
 *
 * All functions receive a Phaser.Scene instance and operate using
 * the Phaser 3.80 particle API (this.add.particles(x, y, key, config)).
 *
 * Exported via window.SHARED_FX.effects when concatenated by TemplateRenderer.
 */

(function () {
  'use strict';

  var effects = {};

  // ── Hex helpers ─────────────────────────────────────────────
  function hexToInt(hex) {
    return parseInt(hex.replace('#', ''), 16);
  }

  function hexToRGB(hex) {
    var c = hexToInt(hex);
    return { r: (c >> 16) & 255, g: (c >> 8) & 255, b: c & 255 };
  }

  // ── Texture generation (call once in BootScene.create) ─────
  effects.generateTextures = function (scene) {
    // Small circle particle (8x8)
    var g = scene.make.graphics({ x: 0, y: 0, add: false });
    g.fillStyle(0xffffff);
    g.fillCircle(4, 4, 4);
    g.generateTexture('particle', 8, 8);
    g.destroy();

    // Soft glow circle (32x32, radial falloff)
    var glow = scene.make.graphics({ x: 0, y: 0, add: false });
    glow.fillStyle(0xffffff, 0.6);
    glow.fillCircle(16, 16, 16);
    glow.fillStyle(0xffffff, 0.3);
    glow.fillCircle(16, 16, 12);
    glow.fillStyle(0xffffff, 1);
    glow.fillCircle(16, 16, 6);
    glow.generateTexture('glow_particle', 32, 32);
    glow.destroy();

    // Small square (6x6) for confetti
    var sq = scene.make.graphics({ x: 0, y: 0, add: false });
    sq.fillStyle(0xffffff);
    sq.fillRect(0, 0, 6, 6);
    sq.generateTexture('confetti_particle', 6, 6);
    sq.destroy();

    // Star shape (12x12)
    var star = scene.make.graphics({ x: 0, y: 0, add: false });
    star.fillStyle(0xffffff);
    star.fillCircle(6, 6, 3);
    star.fillTriangle(6, 0, 4, 4, 8, 4);
    star.fillTriangle(6, 12, 4, 8, 8, 8);
    star.fillTriangle(0, 6, 4, 4, 4, 8);
    star.fillTriangle(12, 6, 8, 4, 8, 8);
    star.generateTexture('star_particle', 12, 12);
    star.destroy();
  };

  // ── Confetti burst ──────────────────────────────────────────
  /**
   * Multi-colored confetti rectangles falling with rotation.
   * @param {Phaser.Scene} scene
   * @param {number} x
   * @param {number} y
   * @param {string[]} colors — array of hex strings
   * @param {number} [count=40]
   */
  effects.confettiBurst = function (scene, x, y, colors, count) {
    count = count || 40;
    var tints = colors.map(hexToInt);
    var emitter = scene.add.particles(x, y, 'confetti_particle', {
      speed: { min: 100, max: 300 },
      angle: { min: 220, max: 320 },
      gravityY: 350,
      lifespan: { min: 1500, max: 2500 },
      scale: { start: 1, end: 0.3 },
      alpha: { start: 1, end: 0 },
      rotate: { min: 0, max: 360 },
      tint: tints,
      quantity: count,
      frequency: -1 // manual explode
    });
    emitter.explode(count, x, y);
    scene.time.delayedCall(3000, function () { emitter.destroy(); });
    return emitter;
  };

  // ── Sparkle burst ───────────────────────────────────────────
  /**
   * 8-12 star particles expanding + fading.
   */
  effects.sparkleBurst = function (scene, x, y, color, count) {
    count = count || 10;
    var tint = hexToInt(color);
    var emitter = scene.add.particles(x, y, 'star_particle', {
      speed: { min: 60, max: 180 },
      lifespan: { min: 400, max: 800 },
      scale: { start: 0.8, end: 0 },
      alpha: { start: 1, end: 0 },
      tint: tint,
      quantity: count,
      frequency: -1
    });
    emitter.explode(count, x, y);
    scene.time.delayedCall(1200, function () { emitter.destroy(); });
    return emitter;
  };

  // ── Score popup ─────────────────────────────────────────────
  /**
   * Floating "+10" text that rises and fades.
   */
  effects.scorePopup = function (scene, x, y, text, color) {
    var popup = scene.add.text(x, y, text, {
      fontSize: '24px',
      fontFamily: 'Arial',
      fontStyle: 'bold',
      color: color || '#FFFFFF',
      stroke: '#000000',
      strokeThickness: 3
    }).setOrigin(0.5).setDepth(1000);

    scene.tweens.add({
      targets: popup,
      y: y - 60,
      alpha: 0,
      scale: 1.4,
      duration: 800,
      ease: 'Power2',
      onComplete: function () { popup.destroy(); }
    });
    return popup;
  };

  // ── Scale punch ─────────────────────────────────────────────
  /**
   * Quick scale punch feedback (1.0 → peak → 1.0).
   */
  effects.scalePunch = function (scene, target, peak, duration) {
    peak = peak || 1.3;
    duration = duration || 150;
    scene.tweens.add({
      targets: target,
      scale: peak,
      duration: duration * 0.4,
      ease: 'Quad.easeOut',
      yoyo: true,
      onComplete: function () { target.setScale(1); }
    });
  };

  // ── Screen shake ────────────────────────────────────────────
  effects.screenShake = function (scene, intensity, duration) {
    scene.cameras.main.shake(duration || 100, intensity || 0.01);
  };

  // ── Trail particles ─────────────────────────────────────────
  /**
   * Attaches a trailing particle emitter to a moving game object.
   * Returns the emitter so the caller can stop/destroy it.
   */
  effects.trailParticles = function (scene, target, color) {
    var tint = hexToInt(color);
    var emitter = scene.add.particles(0, 0, 'particle', {
      speed: { min: 5, max: 20 },
      lifespan: 400,
      scale: { start: 0.6, end: 0 },
      alpha: { start: 0.6, end: 0 },
      tint: tint,
      frequency: 50,
      follow: target
    });
    return emitter;
  };

  // ── Shimmer effect ──────────────────────────────────────────
  /**
   * Subtle brightness oscillation on a target.
   */
  effects.shimmerEffect = function (scene, target) {
    return scene.tweens.add({
      targets: target,
      alpha: { from: 1, to: 0.7 },
      duration: 1200,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut'
    });
  };

  // ── Celebration particles (ambient) ─────────────────────────
  /**
   * Slow ambient sparkle field across a region.
   */
  effects.ambientSparkle = function (scene, width, height, color, density) {
    density = density || 'medium';
    var qty = density === 'high' ? 2 : density === 'low' ? 0.5 : 1;
    var tint = hexToInt(color);
    var emitter = scene.add.particles(width / 2, height / 2, 'star_particle', {
      speed: { min: 8, max: 25 },
      lifespan: { min: 3000, max: 6000 },
      scale: { start: 0.4, end: 0 },
      alpha: { start: 0.5, end: 0 },
      tint: tint,
      frequency: Math.round(600 / qty),
      emitZone: {
        type: 'random',
        source: new Phaser.Geom.Rectangle(-width / 2, -height / 2, width, height)
      }
    });
    return emitter;
  };

  // ── Glow ring behind object ─────────────────────────────────
  effects.glowRing = function (scene, x, y, radius, color) {
    var tint = hexToInt(color);
    var ring = scene.add.circle(x, y, radius, tint, 0.15).setDepth(-1);
    scene.tweens.add({
      targets: ring,
      scale: { from: 0.9, to: 1.15 },
      alpha: { from: 0.2, to: 0.08 },
      duration: 1500,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut'
    });
    return ring;
  };

  // ── Bounce-in entrance ──────────────────────────────────────
  effects.bounceIn = function (scene, target, delay) {
    target.setScale(0).setAlpha(0);
    return scene.tweens.add({
      targets: target,
      scale: 1,
      alpha: 1,
      duration: 600,
      ease: 'Back.easeOut',
      delay: delay || 0
    });
  };

  // ── Float animation (idle bob) ──────────────────────────────
  effects.floatIdle = function (scene, target, amplitude) {
    amplitude = amplitude || 5;
    var startY = target.y;
    return scene.tweens.add({
      targets: target,
      y: startY - amplitude,
      duration: 2000,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut'
    });
  };

  // ── Expose ──────────────────────────────────────────────────
  window.SHARED_FX = window.SHARED_FX || {};
  window.SHARED_FX.effects = effects;
})();
