/**
 * TOWER STACK — Premium Hybrid Template
 *
 * A polished tap-to-drop tower stacker with cinematic splash,
 * slice physics, perfect-drop bonuses, camera scroll, and animated end screen.
 *
 * Reads config from window.GAME_TEMPLATE_CONFIG.
 * Uses shared modules from window.SHARED_FX.
 */

(function () {
  'use strict';

  var CONFIG = window.GAME_TEMPLATE_CONFIG;
  var FX = window.SHARED_FX;
  var W = 640, H = 960;

  function hexToInt(hex) { return parseInt(hex.replace('#', ''), 16); }

  // ───────────────────────────────────────────────────────────
  // Color helpers — HSV interpolation for per-block hue variation
  // ───────────────────────────────────────────────────────────
  function hexToRgb(hex) {
    var n = parseInt(hex.replace('#', ''), 16);
    return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
  }
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h, s, v = max;
    var d = max - min;
    s = max === 0 ? 0 : d / max;
    if (max === min) { h = 0; }
    else {
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        case b: h = (r - g) / d + 4; break;
      }
      h /= 6;
    }
    return { h: h, s: s, v: v };
  }
  function hsvToInt(h, s, v) {
    var r, g, b;
    var i = Math.floor(h * 6);
    var f = h * 6 - i;
    var p = v * (1 - s);
    var q = v * (1 - f * s);
    var t = v * (1 - (1 - f) * s);
    switch (i % 6) {
      case 0: r = v; g = t; b = p; break;
      case 1: r = q; g = v; b = p; break;
      case 2: r = p; g = v; b = t; break;
      case 3: r = p; g = q; b = v; break;
      case 4: r = t; g = p; b = v; break;
      case 5: r = v; g = p; b = q; break;
    }
    return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
  }
  function blockColorForIndex(baseHex, accentHex, index) {
    var base = rgbToHsv.apply(null, Object.values(hexToRgb(baseHex)));
    var acc = rgbToHsv.apply(null, Object.values(hexToRgb(accentHex)));
    // Sinusoidal drift between base and accent hue over the tower
    var t = (Math.sin(index * 0.35) + 1) * 0.5 * 0.45; // 0..0.45
    var h = base.h + (acc.h - base.h) * t;
    // Keep hue in range
    if (h < 0) h += 1;
    if (h > 1) h -= 1;
    var s = Phaser.Math.Clamp(base.s + (t - 0.225) * 0.2, 0.25, 0.95);
    var v = Phaser.Math.Clamp(base.v + (index % 2 === 0 ? 0.05 : -0.05), 0.35, 0.95);
    return hsvToInt(h, s, v);
  }

  // ───────────────────────────────────────────────────────────
  // Draw a styled block into a Graphics object
  // ───────────────────────────────────────────────────────────
  function drawBlock(g, width, height, colorInt, style) {
    g.clear();
    var hw = width / 2, hh = height / 2;
    if (style === 'sharp') {
      g.fillStyle(colorInt, 1);
      g.fillRect(-hw, -hh, width, height);
      g.lineStyle(2, 0xffffff, 0.18);
      g.strokeRect(-hw, -hh, width, height);
      // Top highlight
      g.fillStyle(0xffffff, 0.12);
      g.fillRect(-hw, -hh, width, Math.max(3, height * 0.15));
    } else if (style === 'beveled') {
      // Bevel: lighter top, darker bottom strip
      g.fillStyle(colorInt, 1);
      g.fillRect(-hw, -hh, width, height);
      g.fillStyle(0xffffff, 0.18);
      g.fillRect(-hw, -hh, width, Math.max(4, height * 0.22));
      g.fillStyle(0x000000, 0.18);
      g.fillRect(-hw, hh - Math.max(4, height * 0.22), width, Math.max(4, height * 0.22));
      g.lineStyle(2, 0xffffff, 0.25);
      g.strokeRect(-hw, -hh, width, height);
    } else {
      // rounded (default)
      var r = Math.min(8, height * 0.35);
      g.fillStyle(colorInt, 1);
      g.fillRoundedRect(-hw, -hh, width, height, r);
      g.lineStyle(2, 0xffffff, 0.22);
      g.strokeRoundedRect(-hw, -hh, width, height, r);
      // Top highlight
      g.fillStyle(0xffffff, 0.12);
      g.fillRoundedRect(-hw + 2, -hh + 2, width - 4, Math.max(3, height * 0.22),
        { tl: r, tr: r, bl: 0, br: 0 });
    }
  }

  // ═══════════════════════════════════════════════════════════
  // BOOT SCENE — Cinematic splash with sample tower + logo + title
  // ═══════════════════════════════════════════════════════════
  class BootScene extends Phaser.Scene {
    constructor() { super('BootScene'); }

    preload() {
      var uris = window.ASSET_DATA_URIS || {};
      var keys = Object.keys(uris);
      for (var i = 0; i < keys.length; i++) {
        this.load.image(keys[i], uris[keys[i]]);
      }
    }

    create() {
      // Generate shared textures
      FX.effects.generateTextures(this);

      // Init audio
      FX.audio.init(this);

      var colors = CONFIG.colors;
      var texts = CONFIG.texts;
      var theme = CONFIG.theme || {};
      var style = theme.blockStyle || 'rounded';

      // Background
      this.cameras.main.setBackgroundColor(colors.background);
      FX.ambient.GradientBackground(this, {
        colorTop: colors.primary,
        colorBottom: colors.background,
        colorShift: colors.accent,
        duration: 6000
      });
      FX.ambient.FloatingShapes(this, { color: colors.primary, count: 10 });
      FX.ambient.LightRays(this, { color: colors.accent, count: 2 });
      FX.ambient.VignetteOverlay(this, { intensity: 0.3 });
      FX.ambient.FloatingParticles(this, { color: colors.accent, density: 'low' });

      // Sample tower visualization — tiered, decorative
      var sampleCount = 7;
      var towerCenterX = W / 2;
      var towerBaseY = H * 0.88;
      var sampleH = 26;
      var sampleGap = 1;
      for (var i = 0; i < sampleCount; i++) {
        var wVar = 150 - i * 12 + Math.sin(i * 0.9) * 8;
        var xOff = Math.sin(i * 0.7) * (i * 2);
        var tinted = blockColorForIndex(colors.primary, colors.accent, i);
        var g = this.add.graphics();
        drawBlock(g, wVar, sampleH, tinted, style);
        g.x = towerCenterX + xOff;
        g.y = towerBaseY - i * (sampleH + sampleGap);
        g.setDepth(4).setAlpha(0);
        this.tweens.add({
          targets: g,
          alpha: 0.85,
          y: g.y,
          duration: 400,
          delay: 120 + i * 70,
          ease: 'Sine.easeOut'
        });
        // Subtle idle sway
        this.tweens.add({
          targets: g,
          x: g.x + (i % 2 === 0 ? 3 : -3),
          duration: 1800 + i * 80,
          ease: 'Sine.easeInOut',
          yoyo: true,
          repeat: -1,
          delay: 600
        });
      }

      // Logo
      var logoKey = CONFIG.assets && CONFIG.assets.logo;
      if (logoKey && this.textures.exists(logoKey)) {
        var logo = this.add.image(W / 2, H * 0.28, logoKey).setDepth(10);
        var maxDim = 130;
        var scale = Math.min(maxDim / logo.width, maxDim / logo.height, 1);
        logo.setScale(0);
        this.tweens.add({
          targets: logo,
          scale: scale,
          duration: 800,
          ease: 'Back.easeOut',
          delay: 200
        });
        FX.effects.floatIdle(this, logo, 6);
        FX.effects.glowRing(this, W / 2, H * 0.28, 84, colors.primary);
      }

      // Title
      var title = this.add.text(W / 2, H * 0.44, texts.title, {
        fontSize: '42px',
        fontFamily: 'Arial',
        fontStyle: 'bold',
        color: colors.secondary,
        align: 'center',
        wordWrap: { width: W - 80 }
      }).setOrigin(0.5).setDepth(10).setScale(0);
      title.setShadow(3, 3, 'rgba(0,0,0,0.2)', 6);

      this.tweens.add({
        targets: title,
        scale: 1,
        duration: 600,
        ease: 'Back.easeOut',
        delay: 500
      });

      // Subtitle
      if (texts.subtitle) {
        var sub = this.add.text(W / 2, H * 0.51, texts.subtitle, {
          fontSize: '20px',
          fontFamily: 'Arial',
          color: colors.secondary
        }).setOrigin(0.5).setDepth(10).setAlpha(0);

        this.tweens.add({
          targets: sub,
          alpha: 0.7,
          duration: 500,
          delay: 900
        });
      }

      // "Tap to Start"
      var tapText = this.add.text(W / 2, H * 0.60, 'Tap to Start', {
        fontSize: '24px',
        fontFamily: 'Arial',
        fontStyle: 'bold',
        color: colors.primary
      }).setOrigin(0.5).setDepth(10).setAlpha(0);

      this.tweens.add({
        targets: tapText,
        alpha: { from: 0.4, to: 1 },
        duration: 800,
        yoyo: true,
        repeat: -1,
        delay: 1200
      });

      // Mute button
      FX.audio.createMuteButton(this, { x: W - 35, y: 35, size: 22 });

      // Tap to start
      var started = false;
      this.input.on('pointerdown', function () {
        if (started) return;
        started = true;
        FX.audio.playTap();

        var transition = CONFIG.theme.transitionStyle;
        if (transition === 'zoom') {
          FX.transitions.zoomOut(this, 'GameScene', {});
        } else if (transition === 'wipe') {
          FX.transitions.wipeTransition(this, 'GameScene', {}, 'left');
        } else if (transition === 'flash') {
          FX.transitions.flashTransition(this, 'GameScene', {});
        } else {
          FX.transitions.cinematicFade(this, 'GameScene', {});
        }
      }, this);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // GAME SCENE — Tower stacker gameplay
  // ═══════════════════════════════════════════════════════════
  class GameScene extends Phaser.Scene {
    constructor() { super('GameScene'); }

    create() {
      var self = this;
      FX.transitions.fadeIn(this);

      var colors = CONFIG.colors;
      var gameplay = CONFIG.gameplay;
      var difficulty = CONFIG.difficulty || { speedIncrease: 10, speedIncreaseInterval: 3 };
      var theme = CONFIG.theme || {};
      this.blockStyle = theme.blockStyle || 'rounded';

      // World dimensions: game world is taller than the camera so it can scroll up.
      // We use a large virtual height. Y axis grows downward as usual.
      var WORLD_H = 200000;
      this.WORLD_H = WORLD_H;
      this.cameras.main.setBackgroundColor(colors.background);

      // Ambient (UI camera — ignored by main camera later)
      var bgStyle = theme.backgroundStyle || 'gradient_shift';
      if (bgStyle === 'gradient_shift') {
        FX.ambient.GradientBackground(this, {
          colorTop: colors.background,
          colorBottom: colors.primary,
          colorShift: colors.accent,
          duration: 10000
        });
      } else if (bgStyle === 'floating_shapes') {
        FX.ambient.FloatingShapes(this, { color: colors.primary, count: 8 });
      } else if (bgStyle === 'parallax') {
        FX.ambient.ParallaxLayers(this, { color: colors.primary, layers: 3 });
      }
      FX.ambient.FloatingParticles(this, {
        color: colors.accent,
        density: theme.particleDensity || 'medium'
      });

      // World container — everything inside the world (tower, moving block, slices) is a child.
      this.world = this.add.container(0, 0);
      this.world.setDepth(10);

      // Camera anchors: base sits near bottom of camera view
      this.baseY = WORLD_H - 200;  // world-space Y of top of the base block
      this.world.y = 0;            // vertical offset — moves down to scroll camera up

      // Gameplay state
      this.score = 0;
      this.blocks = [];              // { x, y, w, h, color, gfx }  — y is world-space Y of block CENTER
      this.gameActive = true;
      this.currentSpeed = gameplay.initialSpeed;
      this.movingBlock = null;
      this.movingDir = 1;            // 1 = right, -1 = left
      this.sweepMargin = 40;         // px from screen edge

      // Place the base block at the bottom of the world.
      var baseW = gameplay.blockWidth;
      var baseH = gameplay.blockHeight;
      var baseColor = hexToInt(colors.primary);
      var baseGfx = this.add.graphics();
      drawBlock(baseGfx, baseW, baseH, baseColor, this.blockStyle);
      baseGfx.x = W / 2;
      baseGfx.y = this.baseY - baseH / 2;  // center of base block
      this.world.add(baseGfx);
      this.blocks.push({
        x: W / 2,
        y: baseGfx.y,
        w: baseW,
        h: baseH,
        color: baseColor,
        gfx: baseGfx
      });

      // Decorative ground shadow under the base — in world container
      var ground = this.add.graphics();
      ground.fillStyle(hexToInt(colors.secondary), 0.08);
      ground.fillEllipse(W / 2, this.baseY + 8, baseW * 1.3, 18);
      this.world.add(ground);
      this.world.sendToBack(ground);

      // UI overlay (fixed to camera)
      this.ui = this.add.container(0, 0).setDepth(500);
      this.ui.setScrollFactor(0);

      // Score display (center-top)
      this.scoreDisplay = FX.ui.AnimatedScore(this, W / 2, 45, {
        label: CONFIG.texts.scoreLabel || 'Score',
        color: colors.secondary,
        accentColor: colors.accent,
        fontSize: 30
      });

      // Height counter (top-right)
      var heightLabel = CONFIG.texts.heightLabel || 'Height';
      this.heightLabelText = this.add.text(W - 22, 24, heightLabel, {
        fontSize: '12px', fontFamily: 'Arial', fontStyle: 'bold',
        color: colors.secondary
      }).setOrigin(1, 0).setDepth(510).setAlpha(0.75);
      this.heightValueText = this.add.text(W - 22, 42, '0', {
        fontSize: '28px', fontFamily: 'Arial', fontStyle: 'bold',
        color: colors.accent
      }).setOrigin(1, 0).setDepth(510);
      this.heightLabelText.setScrollFactor(0);
      this.heightValueText.setScrollFactor(0);

      // Hint text (fades out after first tap)
      this.hintText = this.add.text(W / 2, H - 60, 'Tap anywhere to drop', {
        fontSize: '18px', fontFamily: 'Arial', fontStyle: 'bold',
        color: colors.primary
      }).setOrigin(0.5).setDepth(510).setAlpha(0);
      this.hintText.setScrollFactor(0);
      this.tweens.add({
        targets: this.hintText,
        alpha: { from: 0.3, to: 0.9 },
        duration: 700,
        yoyo: true,
        repeat: -1
      });

      // Mute button
      FX.audio.createMuteButton(this, { x: 35, y: 35, size: 18 });

      // Scroll world so the base sits at the right camera position.
      // Camera shows [0..H]; we want the base to appear around y ≈ H - 160.
      var initialCameraY = H - 160; // screen-space y for base top
      this.world.y = initialCameraY - this.baseY;

      // Spawn first moving block on top of the base.
      this.spawnMovingBlock();

      // Tap to drop
      this.input.on('pointerdown', function () {
        if (!self.gameActive || !self.movingBlock) return;
        self.dropBlock();
      });
    }

    // ─────────────────────────────────────────────────────────
    // Spawn a moving block above the previous top block.
    // Width inherits from previous block; sweeps across screen.
    // ─────────────────────────────────────────────────────────
    spawnMovingBlock() {
      if (!this.gameActive) return;
      var self = this;
      var colors = CONFIG.colors;
      var prev = this.blocks[this.blocks.length - 1];
      var h = CONFIG.gameplay.blockHeight;

      var blockW = prev.w;
      var blockY = prev.y - prev.h / 2 - h / 2 - 2; // sit 2px above previous
      var color = blockColorForIndex(colors.primary, colors.accent, this.blocks.length);

      var gfx = this.add.graphics();
      drawBlock(gfx, blockW, h, color, this.blockStyle);
      gfx.y = blockY;

      // Start position alternates sides each spawn for variety
      var startLeft = (this.blocks.length % 2 === 0);
      gfx.x = startLeft ? (this.sweepMargin + blockW / 2) : (W - this.sweepMargin - blockW / 2);
      this.movingDir = startLeft ? 1 : -1;

      // Subtle spawn scale-in
      gfx.setScale(1, 0);
      this.tweens.add({
        targets: gfx,
        scaleY: 1,
        duration: 150,
        ease: 'Back.easeOut'
      });

      this.world.add(gfx);

      this.movingBlock = {
        x: gfx.x,
        y: blockY,
        w: blockW,
        h: h,
        color: color,
        gfx: gfx
      };
    }

    update(time, delta) {
      if (!this.gameActive || !this.movingBlock) return;
      var dt = delta / 1000;
      var mb = this.movingBlock;
      var hw = mb.w / 2;
      var leftBound = this.sweepMargin + hw;
      var rightBound = W - this.sweepMargin - hw;

      mb.x += this.movingDir * this.currentSpeed * dt;

      if (mb.x <= leftBound) {
        mb.x = leftBound;
        this.movingDir = 1;
      } else if (mb.x >= rightBound) {
        mb.x = rightBound;
        this.movingDir = -1;
      }

      mb.gfx.x = mb.x;
    }

    // ─────────────────────────────────────────────────────────
    // Drop: lock moving block, compute overlap with previous block,
    // slice overhang(s) and spawn falling piece(s). If no overlap → game over.
    // ─────────────────────────────────────────────────────────
    dropBlock() {
      if (!this.gameActive || !this.movingBlock) return;
      var self = this;
      var colors = CONFIG.colors;
      var gameplay = CONFIG.gameplay;

      var mb = this.movingBlock;
      var prev = this.blocks[this.blocks.length - 1];

      // Hide the hint after first drop
      if (this.hintText) {
        this.tweens.killTweensOf(this.hintText);
        this.tweens.add({
          targets: this.hintText,
          alpha: 0,
          duration: 250,
          onComplete: function () { self.hintText.destroy(); self.hintText = null; }
        });
      }

      // Compute overlap on the x axis
      var mbLeft = mb.x - mb.w / 2;
      var mbRight = mb.x + mb.w / 2;
      var prevLeft = prev.x - prev.w / 2;
      var prevRight = prev.x + prev.w / 2;

      var overlapLeft = Math.max(mbLeft, prevLeft);
      var overlapRight = Math.min(mbRight, prevRight);
      var overlapW = overlapRight - overlapLeft;

      // No overlap → miss → game over
      if (overlapW <= 0) {
        this.missedDrop(mb);
        return;
      }

      var overlapCenter = (overlapLeft + overlapRight) / 2;
      var offset = Math.abs(mb.x - prev.x);
      var isPerfect = offset <= gameplay.perfectThreshold;

      // Stop the moving block reference
      this.movingBlock = null;

      // ─── PERFECT: snap to previous x, keep width, bonus ───
      if (isPerfect) {
        // Snap graphics to prev.x
        mb.gfx.x = prev.x;
        mb.x = prev.x;
        // Keep current width — redraw unchanged
        this.blocks.push({
          x: mb.x, y: mb.y, w: mb.w, h: mb.h,
          color: mb.color, gfx: mb.gfx
        });

        this.score += gameplay.pointsPerBlock + gameplay.perfectBonus;
        this.scoreDisplay.add(gameplay.pointsPerBlock + gameplay.perfectBonus);

        // Perfect popup
        var perfect = this.add.text(W / 2, H * 0.35, CONFIG.texts.perfectMessage || 'PERFECT!', {
          fontSize: '40px', fontFamily: 'Arial', fontStyle: 'bold',
          color: colors.accent, stroke: colors.secondary, strokeThickness: 4
        }).setOrigin(0.5).setDepth(600).setScale(0).setScrollFactor(0);

        this.tweens.add({
          targets: perfect,
          scale: 1.2,
          duration: 220,
          ease: 'Back.easeOut',
          yoyo: true,
          onComplete: function () {
            self.tweens.add({
              targets: perfect,
              alpha: 0,
              y: H * 0.30,
              duration: 450,
              onComplete: function () { perfect.destroy(); }
            });
          }
        });

        // Sparkle burst at block (world space → screen space)
        var worldScreenY = mb.y + this.world.y;
        FX.effects.sparkleBurst(this, mb.x, worldScreenY, colors.accent, 16);

        // Small halo pulse around the block
        var halo = this.add.graphics().setDepth(15);
        halo.lineStyle(3, hexToInt(colors.accent), 1);
        halo.strokeRoundedRect(-mb.w / 2 - 4, -mb.h / 2 - 4, mb.w + 8, mb.h + 8, 6);
        halo.x = mb.x; halo.y = mb.y;
        this.world.add(halo);
        this.tweens.add({
          targets: halo,
          alpha: 0,
          scaleX: 1.25, scaleY: 1.35,
          duration: 420,
          onComplete: function () { halo.destroy(); }
        });

        FX.audio.playSuccess();
        FX.effects.screenShake(this, 0.004, 60);
      } else {
        // ─── REGULAR: slice overhang(s) on one or both sides ───
        // The new block width is overlapW, centered at overlapCenter.
        var newW = overlapW;
        var newX = overlapCenter;

        // Redraw the moving block gfx at the new width/position.
        drawBlock(mb.gfx, newW, mb.h, mb.color, this.blockStyle);
        mb.gfx.x = newX;
        mb.x = newX;
        mb.w = newW;

        this.blocks.push({
          x: mb.x, y: mb.y, w: mb.w, h: mb.h,
          color: mb.color, gfx: mb.gfx
        });

        // Spawn falling overhang piece(s)
        // Left overhang: from mbLeft to prevLeft (if mbLeft < prevLeft)
        if (mbLeft < prevLeft) {
          var leftW = prevLeft - mbLeft;
          var leftCx = (mbLeft + prevLeft) / 2;
          this.spawnSlicePiece(leftCx, mb.y, leftW, mb.h, mb.color, -1);
        }
        // Right overhang: from prevRight to mbRight (if mbRight > prevRight)
        if (mbRight > prevRight) {
          var rightW = mbRight - prevRight;
          var rightCx = (prevRight + mbRight) / 2;
          this.spawnSlicePiece(rightCx, mb.y, rightW, mb.h, mb.color, 1);
        }

        // Score
        this.score += gameplay.pointsPerBlock;
        this.scoreDisplay.add(gameplay.pointsPerBlock);

        FX.audio.playScore();
        FX.effects.scalePunch(this, mb.gfx, 1.06, 100);
        FX.effects.screenShake(this, 0.003, 50);
      }

      // Update height counter
      this.heightValueText.setText(String(this.blocks.length - 1));
      FX.effects.scalePunch(this, this.heightValueText, 1.25, 140);

      // Scroll camera up smoothly to keep the new top block in view
      this.scrollCameraUp();

      // Speed ramp
      if ((this.blocks.length - 1) % CONFIG.difficulty.speedIncreaseInterval === 0) {
        this.currentSpeed = Math.min(
          CONFIG.gameplay.maxSpeed,
          this.currentSpeed + CONFIG.difficulty.speedIncrease
        );
      }

      // Encouragement messages every 10 blocks
      var stackCount = this.blocks.length - 1;
      if (stackCount > 0 && stackCount % 10 === 0 && CONFIG.texts.encouragement) {
        var arr = CONFIG.texts.encouragement;
        var msg = arr[Phaser.Math.Between(0, arr.length - 1)];
        var enc = this.add.text(W / 2, H * 0.48, msg, {
          fontSize: '32px', fontFamily: 'Arial', fontStyle: 'bold',
          color: colors.accent, stroke: colors.secondary, strokeThickness: 3
        }).setOrigin(0.5).setDepth(550).setScale(0).setScrollFactor(0);
        this.tweens.add({
          targets: enc,
          scale: 1.2,
          alpha: { from: 1, to: 0 },
          y: H * 0.42,
          duration: 1100,
          ease: 'Power2',
          onComplete: function () { enc.destroy(); }
        });
      }

      // Spawn next moving block after a short beat
      this.time.delayedCall(120, function () {
        if (self.gameActive) self.spawnMovingBlock();
      });
    }

    // ─────────────────────────────────────────────────────────
    // Spawn a falling slice piece that tweens down, rotates, fades
    // ─────────────────────────────────────────────────────────
    spawnSlicePiece(x, y, w, h, color, dir) {
      if (w <= 0) return;
      var slice = this.add.graphics();
      drawBlock(slice, w, h, color, this.blockStyle);
      slice.x = x;
      slice.y = y;
      this.world.add(slice);

      var fallDistance = 900;
      this.tweens.add({
        targets: slice,
        y: y + fallDistance,
        angle: dir * Phaser.Math.Between(60, 120),
        alpha: 0,
        x: x + dir * Phaser.Math.Between(20, 60),
        duration: 900,
        ease: 'Quad.easeIn',
        onComplete: function () { slice.destroy(); }
      });
    }

    // ─────────────────────────────────────────────────────────
    // Scroll the world container down (so camera effectively pans up)
    // Keeps the most-recent block near screen middle-upper area.
    // ─────────────────────────────────────────────────────────
    scrollCameraUp() {
      var top = this.blocks[this.blocks.length - 1];
      var targetScreenY = H * 0.55; // screen-space y we want the top block center at
      var desiredWorldY = targetScreenY - top.y; // world.y such that top.y + world.y == targetScreenY
      // Only pan when needed (don't move world downward past start)
      if (desiredWorldY < this.world.y) {
        this.tweens.add({
          targets: this.world,
          y: desiredWorldY,
          duration: 300,
          ease: 'Cubic.easeOut'
        });
      }
    }

    // ─────────────────────────────────────────────────────────
    // Missed drop: the moving block fully missed the previous block.
    // It plummets off-screen and the game ends.
    // ─────────────────────────────────────────────────────────
    missedDrop(mb) {
      this.gameActive = false;
      var self = this;
      var colors = CONFIG.colors;

      FX.audio.playFail();
      FX.effects.screenShake(this, 0.012, 180);
      this.cameras.main.flash(120, 239, 68, 68, true);

      // Let the missed block fall away
      var dir = (mb.x < W / 2) ? -1 : 1;
      this.tweens.add({
        targets: mb.gfx,
        y: mb.y + 1100,
        angle: dir * 80,
        alpha: 0,
        x: mb.gfx.x + dir * 50,
        duration: 900,
        ease: 'Quad.easeIn'
      });

      // Small delay, then shake the tower and transition
      this.time.delayedCall(350, function () {
        // Wobble the top few blocks for drama
        var topN = Math.min(3, self.blocks.length);
        for (var i = self.blocks.length - 1; i >= self.blocks.length - topN; i--) {
          var b = self.blocks[i];
          var w = (i % 2 === 0 ? 1 : -1) * 6;
          self.tweens.add({
            targets: b.gfx,
            x: b.x + w,
            angle: w * 0.8,
            duration: 110,
            yoyo: true,
            repeat: 2
          });
        }
      });

      this.time.delayedCall(900, function () {
        var transition = CONFIG.theme.transitionStyle;
        var payload = { score: self.score, height: self.blocks.length - 1 };
        if (transition === 'zoom') {
          FX.transitions.zoomOut(self, 'EndScene', payload);
        } else if (transition === 'flash') {
          FX.transitions.flashTransition(self, 'EndScene', payload);
        } else {
          FX.transitions.cinematicFade(self, 'EndScene', payload);
        }
      });
    }
  }

  // ═══════════════════════════════════════════════════════════
  // END SCENE — Final height/score, star rating, CTA, play again
  // ═══════════════════════════════════════════════════════════
  class EndScene extends Phaser.Scene {
    constructor() { super('EndScene'); }

    create(data) {
      FX.transitions.fadeIn(this);
      var colors = CONFIG.colors;
      var texts = CONFIG.texts;
      var theme = CONFIG.theme || {};
      var style = theme.blockStyle || 'rounded';
      var score = data.score || 0;
      var height = data.height || 0;

      this.cameras.main.setBackgroundColor(colors.background);
      FX.ambient.GradientBackground(this, {
        colorTop: colors.primary,
        colorBottom: colors.background,
        colorShift: colors.accent,
        duration: 5000
      });
      FX.ambient.FloatingParticles(this, { color: colors.accent, density: 'medium' });
      FX.ambient.VignetteOverlay(this, { intensity: 0.25 });

      // Final tower visualization — mini tower on the right
      var miniX = W - 110;
      var miniBaseY = H * 0.62;
      var visCount = Math.min(height + 1, 12);
      var visH = 14;
      var visGap = 1;
      for (var i = 0; i < visCount; i++) {
        var wVar = 78 - i * 3 + Math.sin(i * 0.6) * 5;
        wVar = Math.max(22, wVar);
        var tinted = blockColorForIndex(colors.primary, colors.accent, i);
        var g = this.add.graphics();
        drawBlock(g, wVar, visH, tinted, style);
        g.x = miniX + Math.sin(i * 0.5) * 3;
        g.y = miniBaseY - i * (visH + visGap);
        g.setDepth(4).setAlpha(0);
        this.tweens.add({
          targets: g,
          alpha: 0.9,
          duration: 250,
          delay: 300 + i * 60,
          ease: 'Sine.easeOut'
        });
      }

      // Headline
      var titleText = (height <= 0) ? (texts.gameOver || 'Tower Fell!') : (texts.gameOver || 'Tower Fell!');
      var title = this.add.text(W / 2, H * 0.14, titleText, {
        fontSize: '38px', fontFamily: 'Arial', fontStyle: 'bold',
        color: colors.secondary
      }).setOrigin(0.5).setDepth(10);
      title.setShadow(2, 2, 'rgba(0,0,0,0.2)', 4);
      FX.effects.bounceIn(this, title, 100);

      // Height big number
      var heightLabel = texts.heightLabel || 'Height';
      var hLabel = this.add.text(W * 0.33, H * 0.26, heightLabel, {
        fontSize: '16px', fontFamily: 'Arial', fontStyle: 'bold',
        color: colors.secondary
      }).setOrigin(0.5).setDepth(10).setAlpha(0.7);
      var hVal = this.add.text(W * 0.33, H * 0.31, '0', {
        fontSize: '52px', fontFamily: 'Arial', fontStyle: 'bold',
        color: colors.accent
      }).setOrigin(0.5).setDepth(10);
      void hLabel; // retain reference
      this.time.delayedCall(400, function () {
        this.tweens.add({
          targets: { v: 0 },
          v: height,
          duration: 900,
          ease: 'Cubic.easeOut',
          onUpdate: function (tw, tgt) { hVal.setText(String(Math.floor(tgt.v))); }
        });
      }.bind(this));

      // Score count-up (left side under height)
      var scoreDisplay = FX.ui.AnimatedScore(this, W / 2, H * 0.44, {
        label: texts.scoreLabel || 'Score',
        color: colors.secondary,
        accentColor: colors.accent,
        fontSize: 40
      });
      this.time.delayedCall(500, function () {
        scoreDisplay.countUpFrom(0, score, 1400);
      });

      // Star rating — thresholds based on tower height
      var starCount = height >= 20 ? 3 : height >= 10 ? 2 : height >= 3 ? 1 : 0;
      var stars = FX.ui.StarRating(this, W / 2, H * 0.56, {
        maxStars: 3,
        starSize: 42,
        filledColor: colors.accent,
        emptyColor: '#CBD5E1'
      });
      this.time.delayedCall(1800, function () {
        stars.fill(starCount);
      });

      // Confetti if 3 stars
      if (starCount === 3) {
        this.time.delayedCall(2500, function () {
          FX.effects.confettiBurst(this, W / 2, H * 0.5,
            [colors.primary, colors.accent, colors.secondary, '#FFFFFF'], 60);
          FX.audio.playSuccess();
        }.bind(this));
      }

      // Logo
      var logoKey = CONFIG.assets && CONFIG.assets.logo;
      if (logoKey && this.textures.exists(logoKey)) {
        var logo = this.add.image(W / 2, H * 0.66, logoKey).setDepth(10);
        var ls = Math.min(70 / logo.width, 70 / logo.height, 1);
        logo.setScale(0);
        this.tweens.add({
          targets: logo,
          scale: ls,
          duration: 500,
          ease: 'Back.easeOut',
          delay: 1700
        });
      }

      // CTA Button
      var ctaBtn = FX.ui.CTAButton(this, W / 2, H * 0.78, texts.cta || 'Learn More', {
        width: 240,
        height: 58,
        color: colors.primary,
        textColor: '#FFFFFF'
      });
      ctaBtn.onClick = function () {
        if (window.mraidAction) window.mraidAction();
      };
      ctaBtn.container.setScale(0);
      this.tweens.add({
        targets: ctaBtn.container,
        scale: 1,
        duration: 500,
        ease: 'Back.easeOut',
        delay: 2100
      });

      // Play Again
      var playAgain = this.add.text(W / 2, H * 0.88, texts.playAgain || 'Play Again', {
        fontSize: '18px', fontFamily: 'Arial', fontStyle: 'bold',
        color: colors.primary
      }).setOrigin(0.5).setDepth(10).setAlpha(0)
        .setInteractive({ useHandCursor: true });

      this.tweens.add({
        targets: playAgain,
        alpha: 0.7,
        duration: 400,
        delay: 2700
      });

      playAgain.on('pointerdown', function () {
        FX.audio.playTap();
        FX.transitions.cinematicFade(this, 'GameScene', {});
      }, this);

      playAgain.on('pointerover', function () { playAgain.setAlpha(1); });
      playAgain.on('pointerout', function () { playAgain.setAlpha(0.7); });

      // Mute
      FX.audio.createMuteButton(this, { x: W - 35, y: 35, size: 18 });
    }
  }

  // ═══════════════════════════════════════════════════════════
  // GAME CONFIG
  // ═══════════════════════════════════════════════════════════
  window.GAME_CONFIG = {
    type: Phaser.AUTO,
    width: W,
    height: H,
    backgroundColor: CONFIG.colors.background,
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH
    },
    scene: [BootScene, GameScene, EndScene]
  };
})();
