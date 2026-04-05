/**
 * Shared UI Components Module — Premium Playable Ads
 *
 * Reusable Phaser 3.80 UI widgets: circular timer, animated score,
 * CTA button with glow, star rating, progress bar.
 *
 * Exported via window.SHARED_FX.ui when concatenated by TemplateRenderer.
 */

(function () {
  'use strict';

  var ui = {};

  function hexToInt(hex) {
    return parseInt(hex.replace('#', ''), 16);
  }

  // ── Circular Timer ──────────────────────────────────────────
  /**
   * Graphics-based arc timer that smoothly depletes.
   *
   * Usage:
   *   var timer = ui.CircularTimer(scene, x, y, opts);
   *   timer.start(seconds);            // begins countdown
   *   timer.onComplete = function(){}; // called when time is up
   */
  ui.CircularTimer = function (scene, x, y, opts) {
    opts = opts || {};
    var radius = opts.radius || 28;
    var thickness = opts.thickness || 6;
    var bgColor = hexToInt(opts.bgColor || '#334155');
    var fillColor = hexToInt(opts.fillColor || '#6366F1');
    var textColor = opts.textColor || '#FFFFFF';

    var container = scene.add.container(x, y).setDepth(100);

    // Background ring
    var bgGfx = scene.add.graphics();
    bgGfx.lineStyle(thickness, bgColor, 0.3);
    bgGfx.beginPath();
    bgGfx.arc(0, 0, radius, Phaser.Math.DegToRad(0), Phaser.Math.DegToRad(360), false);
    bgGfx.strokePath();
    container.add(bgGfx);

    // Fill ring (redrawn each frame)
    var fillGfx = scene.add.graphics();
    container.add(fillGfx);

    // Center text
    var label = scene.add.text(0, 0, '', {
      fontSize: (radius * 0.7) + 'px',
      fontFamily: 'Arial',
      fontStyle: 'bold',
      color: textColor
    }).setOrigin(0.5);
    container.add(label);

    var totalTime = 0;
    var remaining = 0;
    var running = false;
    var timerEvent = null;
    var self = { container: container, onComplete: null };

    function redraw() {
      fillGfx.clear();
      var pct = (totalTime > 0) ? remaining / totalTime : 1;
      var endAngle = -90 + (360 * pct);
      fillGfx.lineStyle(thickness, fillColor, 1);
      fillGfx.beginPath();
      fillGfx.arc(0, 0, radius, Phaser.Math.DegToRad(-90), Phaser.Math.DegToRad(endAngle), false);
      fillGfx.strokePath();
      label.setText(Math.ceil(remaining));

      // Urgency: pulse when <=5s
      if (remaining <= 5 && remaining > 0) {
        var urgencyColor = remaining <= 3 ? '#EF4444' : '#F59E0B';
        label.setColor(urgencyColor);
        fillGfx.clear();
        fillGfx.lineStyle(thickness, hexToInt(urgencyColor), 1);
        fillGfx.beginPath();
        fillGfx.arc(0, 0, radius, Phaser.Math.DegToRad(-90), Phaser.Math.DegToRad(endAngle), false);
        fillGfx.strokePath();
      }
    }

    self.start = function (seconds) {
      totalTime = seconds;
      remaining = seconds;
      running = true;
      label.setColor(textColor);
      redraw();
      timerEvent = scene.time.addEvent({
        delay: 100,
        callback: function () {
          remaining = Math.max(0, remaining - 0.1);
          redraw();
          if (remaining <= 0) {
            running = false;
            if (timerEvent) timerEvent.remove(false);
            if (self.onComplete) self.onComplete();
          }
        },
        loop: true
      });
    };

    self.stop = function () {
      running = false;
      if (timerEvent) timerEvent.remove(false);
    };

    self.getRemaining = function () { return remaining; };
    self.isRunning = function () { return running; };
    self.destroy = function () {
      self.stop();
      container.destroy();
    };
    self.setPosition = function (nx, ny) { container.setPosition(nx, ny); return self; };
    self.setDepth = function (d) { container.setDepth(d); return self; };

    return self;
  };

  // ── Animated Score ──────────────────────────────────────────
  /**
   * Score display with count-up animation and scale punch on change.
   *
   * Usage:
   *   var score = ui.AnimatedScore(scene, x, y, opts);
   *   score.add(10);
   *   score.set(100);
   */
  ui.AnimatedScore = function (scene, x, y, opts) {
    opts = opts || {};
    var label = opts.label || 'Score';
    var color = opts.color || '#FFFFFF';
    var accentColor = opts.accentColor || '#F59E0B';
    var fontSize = opts.fontSize || 28;

    var currentValue = 0;
    var displayValue = 0;

    var container = scene.add.container(x, y).setDepth(100);

    var labelText = scene.add.text(0, -16, label, {
      fontSize: Math.round(fontSize * 0.5) + 'px',
      fontFamily: 'Arial',
      color: color,
      alpha: 0.7
    }).setOrigin(0.5);
    container.add(labelText);

    var valueText = scene.add.text(0, 8, '0', {
      fontSize: fontSize + 'px',
      fontFamily: 'Arial',
      fontStyle: 'bold',
      color: color
    }).setOrigin(0.5);
    valueText.setShadow(2, 2, 'rgba(0,0,0,0.3)', 4);
    container.add(valueText);

    var self = { container: container };

    function animateTo(target) {
      scene.tweens.addCounter({
        from: displayValue,
        to: target,
        duration: 400,
        ease: 'Power2',
        onUpdate: function (tween) {
          displayValue = Math.round(tween.getValue());
          valueText.setText(displayValue);
        },
        onComplete: function () {
          displayValue = target;
          valueText.setText(target);
        }
      });
      // Scale punch
      scene.tweens.add({
        targets: valueText,
        scale: 1.3,
        duration: 100,
        yoyo: true,
        ease: 'Quad.easeOut'
      });
      // Color flash
      valueText.setColor(accentColor);
      scene.time.delayedCall(200, function () { valueText.setColor(color); });
    }

    self.add = function (amount) {
      currentValue += amount;
      animateTo(currentValue);
      return self;
    };

    self.set = function (val) {
      currentValue = val;
      animateTo(val);
      return self;
    };

    self.getValue = function () { return currentValue; };

    self.countUpFrom = function (startVal, endVal, duration) {
      duration = duration || 1500;
      scene.tweens.addCounter({
        from: startVal,
        to: endVal,
        duration: duration,
        ease: 'Power2',
        onUpdate: function (tween) {
          var v = Math.round(tween.getValue());
          valueText.setText(v);
        },
        onComplete: function () {
          valueText.setText(endVal);
          currentValue = endVal;
          displayValue = endVal;
        }
      });
    };

    self.setPosition = function (nx, ny) { container.setPosition(nx, ny); return self; };
    self.setDepth = function (d) { container.setDepth(d); return self; };
    self.destroy = function () { container.destroy(); };

    return self;
  };

  // ── CTA Button ──────────────────────────────────────────────
  /**
   * Rounded rectangle CTA with glow border, pulse animation, bloom on hover.
   *
   * Usage:
   *   var cta = ui.CTAButton(scene, x, y, text, opts);
   *   cta.onClick = function() { window.mraidAction(); };
   */
  ui.CTAButton = function (scene, x, y, text, opts) {
    opts = opts || {};
    var width = opts.width || 220;
    var height = opts.height || 56;
    var color = opts.color || '#6366F1';
    var textColor = opts.textColor || '#FFFFFF';
    var colorInt = hexToInt(color);

    var container = scene.add.container(x, y).setDepth(200);

    // Glow background (larger, semi-transparent)
    var glowBg = scene.add.graphics();
    glowBg.fillStyle(colorInt, 0.2);
    glowBg.fillRoundedRect(-width / 2 - 8, -height / 2 - 8, width + 16, height + 16, 20);
    container.add(glowBg);

    // Main button background
    var bg = scene.add.graphics();
    bg.fillStyle(colorInt, 1);
    bg.fillRoundedRect(-width / 2, -height / 2, width, height, 14);
    container.add(bg);

    // Button border (animated glow)
    var border = scene.add.graphics();
    border.lineStyle(2, 0xffffff, 0.4);
    border.strokeRoundedRect(-width / 2, -height / 2, width, height, 14);
    container.add(border);

    // Button text
    var btnText = scene.add.text(0, 0, text, {
      fontSize: '22px',
      fontFamily: 'Arial',
      fontStyle: 'bold',
      color: textColor
    }).setOrigin(0.5);
    btnText.setShadow(1, 1, 'rgba(0,0,0,0.3)', 3);
    container.add(btnText);

    // Hit area
    var hitZone = scene.add.rectangle(0, 0, width + 20, height + 20, 0x000000, 0)
      .setInteractive({ useHandCursor: true });
    container.add(hitZone);

    // Pulse animation
    scene.tweens.add({
      targets: container,
      scale: { from: 1, to: 1.05 },
      duration: 800,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut'
    });

    // Glow pulse
    scene.tweens.add({
      targets: glowBg,
      alpha: { from: 1, to: 0.4 },
      duration: 1200,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut'
    });

    var self = { container: container, onClick: null };

    hitZone.on('pointerdown', function () {
      scene.tweens.add({
        targets: container,
        scale: 0.92,
        duration: 80,
        yoyo: true,
        onComplete: function () {
          if (self.onClick) self.onClick();
        }
      });
    });

    hitZone.on('pointerover', function () {
      scene.tweens.add({ targets: border, alpha: 0.8, duration: 150 });
    });
    hitZone.on('pointerout', function () {
      scene.tweens.add({ targets: border, alpha: 1, duration: 150 });
    });

    self.setPosition = function (nx, ny) { container.setPosition(nx, ny); return self; };
    self.destroy = function () { container.destroy(); };

    return self;
  };

  // ── Star Rating ─────────────────────────────────────────────
  /**
   * 1-5 stars that fill in sequence with particle bursts.
   */
  ui.StarRating = function (scene, x, y, opts) {
    opts = opts || {};
    var maxStars = opts.maxStars || 3;
    var starSize = opts.starSize || 36;
    var spacing = opts.spacing || 10;
    var filledColor = opts.filledColor || '#F59E0B';
    var emptyColor = opts.emptyColor || '#475569';

    var container = scene.add.container(x, y).setDepth(100);
    var totalWidth = maxStars * starSize + (maxStars - 1) * spacing;
    var startX = -totalWidth / 2 + starSize / 2;

    var stars = [];
    for (var i = 0; i < maxStars; i++) {
      var sx = startX + i * (starSize + spacing);
      var starBg = scene.add.text(sx, 0, '\u2605', {
        fontSize: starSize + 'px',
        color: emptyColor
      }).setOrigin(0.5).setAlpha(0.4);
      container.add(starBg);
      stars.push(starBg);
    }

    var self = { container: container };

    /**
     * Fill stars up to `count` with staggered animation.
     */
    self.fill = function (count) {
      for (var i = 0; i < Math.min(count, maxStars); i++) {
        (function (idx) {
          scene.time.delayedCall(idx * 300, function () {
            stars[idx].setColor(filledColor).setAlpha(1);
            scene.tweens.add({
              targets: stars[idx],
              scale: { from: 0, to: 1.2 },
              duration: 300,
              ease: 'Back.easeOut',
              yoyo: true,
              hold: 100
            });
            // Sparkle burst behind star
            if (window.SHARED_FX && window.SHARED_FX.effects) {
              var worldPos = stars[idx].getWorldTransformMatrix();
              window.SHARED_FX.effects.sparkleBurst(scene,
                container.x + stars[idx].x,
                container.y + stars[idx].y,
                filledColor, 6);
            }
          });
        })(i);
      }
    };

    self.setPosition = function (nx, ny) { container.setPosition(nx, ny); return self; };
    self.destroy = function () { container.destroy(); };

    return self;
  };

  // ── Progress Bar ────────────────────────────────────────────
  /**
   * Smooth-fill bar with gradient and shine animation.
   */
  ui.ProgressBar = function (scene, x, y, opts) {
    opts = opts || {};
    var width = opts.width || 200;
    var height = opts.height || 12;
    var bgColor = hexToInt(opts.bgColor || '#1E293B');
    var fillColor = hexToInt(opts.fillColor || '#6366F1');
    var radius = opts.radius || 6;

    var container = scene.add.container(x, y).setDepth(100);

    // Background
    var bgGfx = scene.add.graphics();
    bgGfx.fillStyle(bgColor, 0.4);
    bgGfx.fillRoundedRect(-width / 2, -height / 2, width, height, radius);
    container.add(bgGfx);

    // Fill (mask via cropping)
    var fillGfx = scene.add.graphics();
    container.add(fillGfx);

    var currentPct = 0;
    var self = { container: container };

    function draw(pct) {
      fillGfx.clear();
      var w = Math.max(0, Math.min(1, pct)) * width;
      if (w > 0) {
        fillGfx.fillStyle(fillColor, 1);
        fillGfx.fillRoundedRect(-width / 2, -height / 2, w, height, radius);
      }
    }

    self.setProgress = function (pct, animate) {
      if (animate === false) {
        currentPct = pct;
        draw(pct);
        return self;
      }
      scene.tweens.addCounter({
        from: currentPct * 100,
        to: pct * 100,
        duration: 400,
        ease: 'Power2',
        onUpdate: function (tween) { draw(tween.getValue() / 100); },
        onComplete: function () { currentPct = pct; }
      });
      return self;
    };

    self.setPosition = function (nx, ny) { container.setPosition(nx, ny); return self; };
    self.destroy = function () { container.destroy(); };

    draw(0);
    return self;
  };

  // ── Expose ──────────────────────────────────────────────────
  window.SHARED_FX = window.SHARED_FX || {};
  window.SHARED_FX.ui = ui;
})();
