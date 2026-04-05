/**
 * Shared Ambient Backgrounds Module — Premium Playable Ads
 *
 * Animated backgrounds, parallax layers, vignettes, and atmospheric effects.
 * All create visual depth and premium feel.
 *
 * Exported via window.SHARED_FX.ambient when concatenated by TemplateRenderer.
 */

(function () {
  'use strict';

  var ambient = {};

  function hexToInt(hex) {
    return parseInt(hex.replace('#', ''), 16);
  }

  function lerpColor(a, b, t) {
    var ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
    var br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
    var rr = Math.round(ar + (br - ar) * t);
    var rg = Math.round(ag + (bg - ag) * t);
    var rb = Math.round(ab + (bb - ab) * t);
    return (rr << 16) | (rg << 8) | rb;
  }

  // ── Gradient Background ─────────────────────────────────────
  /**
   * Animated vertical gradient that shifts between two brand colors.
   * Returns an object with update() method — call in scene update or tween.
   */
  ambient.GradientBackground = function (scene, opts) {
    opts = opts || {};
    var w = scene.scale.width;
    var h = scene.scale.height;
    var colorA = hexToInt(opts.colorTop || '#6366F1');
    var colorB = hexToInt(opts.colorBottom || '#1E293B');
    var colorC = opts.colorShift ? hexToInt(opts.colorShift) : null;
    var animDuration = opts.duration || 8000;

    var gfx = scene.add.graphics().setDepth(-100);

    function drawGradient(topColor, bottomColor) {
      gfx.clear();
      var steps = 32;
      var stepH = Math.ceil(h / steps);
      for (var i = 0; i < steps; i++) {
        var t = i / (steps - 1);
        var color = lerpColor(topColor, bottomColor, t);
        gfx.fillStyle(color, 1);
        gfx.fillRect(0, i * stepH, w, stepH + 1);
      }
    }

    drawGradient(colorA, colorB);

    var self = { gfx: gfx };

    // Optional animated shift
    if (colorC) {
      var progress = { t: 0 };
      scene.tweens.add({
        targets: progress,
        t: 1,
        duration: animDuration,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
        onUpdate: function () {
          var topNow = lerpColor(colorA, colorC, progress.t);
          drawGradient(topNow, colorB);
        }
      });
    }

    self.destroy = function () { gfx.destroy(); };
    return self;
  };

  // ── Floating Shapes ─────────────────────────────────────────
  /**
   * Geometric shapes drifting at varying speeds/alphas for depth.
   */
  ambient.FloatingShapes = function (scene, opts) {
    opts = opts || {};
    var w = scene.scale.width;
    var h = scene.scale.height;
    var color = hexToInt(opts.color || '#6366F1');
    var count = opts.count || 12;
    var shapes = [];

    for (var i = 0; i < count; i++) {
      var size = Phaser.Math.Between(8, 30);
      var sx = Phaser.Math.Between(0, w);
      var sy = Phaser.Math.Between(0, h);
      var alpha = Phaser.Math.FloatBetween(0.03, 0.12);
      var shape;

      // Alternate between circles and rounded rects
      if (i % 3 === 0) {
        shape = scene.add.circle(sx, sy, size, color, alpha);
      } else {
        var gfx = scene.add.graphics();
        gfx.fillStyle(color, alpha);
        gfx.fillRoundedRect(-size, -size, size * 2, size * 2, size * 0.3);
        gfx.setPosition(sx, sy);
        shape = gfx;
      }
      shape.setDepth(-50);

      // Slow drift
      var duration = Phaser.Math.Between(6000, 14000);
      var targetY = sy - Phaser.Math.Between(40, 120);

      scene.tweens.add({
        targets: shape,
        y: targetY,
        x: sx + Phaser.Math.Between(-30, 30),
        alpha: { from: alpha, to: alpha * 0.3 },
        duration: duration,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
        delay: Phaser.Math.Between(0, 3000)
      });

      // Slow rotation for rectangles
      if (shape.angle !== undefined) {
        scene.tweens.add({
          targets: shape,
          angle: Phaser.Math.Between(-20, 20),
          duration: duration * 1.5,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut'
        });
      }

      shapes.push(shape);
    }

    return {
      shapes: shapes,
      destroy: function () { shapes.forEach(function (s) { s.destroy(); }); }
    };
  };

  // ── Parallax Layers ─────────────────────────────────────────
  /**
   * 2-3 depth layers of decorative dots/shapes at different speeds.
   * Returns object with update(deltaX) to scroll layers.
   */
  ambient.ParallaxLayers = function (scene, opts) {
    opts = opts || {};
    var w = scene.scale.width;
    var h = scene.scale.height;
    var color = hexToInt(opts.color || '#6366F1');
    var layerCount = opts.layers || 3;
    var layers = [];

    for (var l = 0; l < layerCount; l++) {
      var depth = -90 + l * 10;
      var alpha = 0.04 + l * 0.03;
      var speed = 0.2 + l * 0.3;
      var dotCount = 8 - l * 2;
      var container = scene.add.container(0, 0).setDepth(depth);

      for (var d = 0; d < dotCount; d++) {
        var dx = Phaser.Math.Between(0, w);
        var dy = Phaser.Math.Between(0, h);
        var size = Phaser.Math.Between(3, 8 + l * 4);
        var dot = scene.add.circle(dx, dy, size, color, alpha);
        container.add(dot);
      }

      layers.push({ container: container, speed: speed });

      // Auto-drift vertically
      scene.tweens.add({
        targets: container,
        y: -20 * (l + 1),
        duration: 10000 + l * 5000,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut'
      });
    }

    return {
      layers: layers,
      update: function (deltaX) {
        layers.forEach(function (layer) {
          layer.container.x += deltaX * layer.speed;
        });
      },
      destroy: function () { layers.forEach(function (l) { l.container.destroy(); }); }
    };
  };

  // ── Vignette Overlay ────────────────────────────────────────
  /**
   * Dark edge overlay for cinematic feel.
   */
  ambient.VignetteOverlay = function (scene, opts) {
    opts = opts || {};
    var w = scene.scale.width;
    var h = scene.scale.height;
    var intensity = opts.intensity || 0.4;

    var gfx = scene.add.graphics().setDepth(500);

    // Top edge
    gfx.fillGradientStyle(0x000000, 0x000000, 0x000000, 0x000000, intensity, intensity, 0, 0);
    gfx.fillRect(0, 0, w, h * 0.15);

    // Bottom edge
    gfx.fillGradientStyle(0x000000, 0x000000, 0x000000, 0x000000, 0, 0, intensity, intensity);
    gfx.fillRect(0, h * 0.85, w, h * 0.15);

    // Left edge
    gfx.fillGradientStyle(0x000000, 0x000000, 0x000000, 0x000000, intensity * 0.5, 0, intensity * 0.5, 0);
    gfx.fillRect(0, 0, w * 0.05, h);

    // Right edge
    gfx.fillGradientStyle(0x000000, 0x000000, 0x000000, 0x000000, 0, intensity * 0.5, 0, intensity * 0.5);
    gfx.fillRect(w * 0.95, 0, w * 0.05, h);

    return {
      gfx: gfx,
      destroy: function () { gfx.destroy(); }
    };
  };

  // ── Light Rays ──────────────────────────────────────────────
  /**
   * Diagonal animated light streaks for premium atmosphere.
   */
  ambient.LightRays = function (scene, opts) {
    opts = opts || {};
    var w = scene.scale.width;
    var h = scene.scale.height;
    var color = hexToInt(opts.color || '#FFFFFF');
    var count = opts.count || 3;
    var rays = [];

    for (var i = 0; i < count; i++) {
      var gfx = scene.add.graphics().setDepth(-30);
      var rayWidth = Phaser.Math.Between(40, 100);
      var startX = Phaser.Math.Between(-50, w);
      var alpha = Phaser.Math.FloatBetween(0.02, 0.06);

      gfx.fillStyle(color, alpha);
      // Draw diagonal parallelogram
      gfx.fillPoints([
        { x: startX, y: -20 },
        { x: startX + rayWidth, y: -20 },
        { x: startX + rayWidth - 80, y: h + 20 },
        { x: startX - 80, y: h + 20 }
      ], true);

      // Slow horizontal drift
      scene.tweens.add({
        targets: gfx,
        x: Phaser.Math.Between(30, 80),
        alpha: { from: 1, to: 0.3 },
        duration: Phaser.Math.Between(8000, 15000),
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
        delay: i * 2000
      });

      rays.push(gfx);
    }

    return {
      rays: rays,
      destroy: function () { rays.forEach(function (r) { r.destroy(); }); }
    };
  };

  // ── Floating Particles Background ───────────────────────────
  /**
   * Gentle particle drift across the entire scene.
   */
  ambient.FloatingParticles = function (scene, opts) {
    opts = opts || {};
    var w = scene.scale.width;
    var h = scene.scale.height;
    var color = hexToInt(opts.color || '#FFFFFF');
    var density = opts.density || 'medium';
    var freq = density === 'high' ? 150 : density === 'low' ? 500 : 300;

    var emitter = scene.add.particles(w / 2, h / 2, 'particle', {
      speed: { min: 5, max: 20 },
      lifespan: { min: 4000, max: 8000 },
      scale: { start: 0.3, end: 0 },
      alpha: { start: 0.15, end: 0 },
      tint: color,
      frequency: freq,
      emitZone: {
        type: 'random',
        source: new Phaser.Geom.Rectangle(-w / 2, -h / 2, w, h)
      }
    });
    emitter.setDepth(-40);

    return {
      emitter: emitter,
      destroy: function () { emitter.destroy(); }
    };
  };

  // ── Expose ──────────────────────────────────────────────────
  window.SHARED_FX = window.SHARED_FX || {};
  window.SHARED_FX.ambient = ambient;
})();
