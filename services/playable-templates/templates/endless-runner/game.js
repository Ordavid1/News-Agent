/**
 * ENDLESS RUNNER — Premium Hybrid Template
 *
 * A polished side-scrolling runner with cinematic splash, multi-layer
 * parallax, progressive speed ramp, lives system, and animated end screen.
 *
 * Reads config from window.GAME_TEMPLATE_CONFIG.
 * Uses shared modules from window.SHARED_FX.
 */

(function () {
  'use strict';

  var CONFIG = window.GAME_TEMPLATE_CONFIG;
  var FX = window.SHARED_FX;
  var W = 640, H = 960;

  // Fixed layout constants
  var GROUND_Y = H - 170;          // Character foot line
  var GROUND_THICKNESS = 170;      // Ground strip height
  var CHARACTER_X = W * 0.28;      // Character fixed x (left third)
  var CHARACTER_RADIUS = 30;       // Hitbox radius reference
  var OBSTACLE_CULL_X = -120;      // Off-screen left cull line

  function hexToInt(hex) { return parseInt(hex.replace('#', ''), 16); }

  // ═══════════════════════════════════════════════════════════
  // BOOT SCENE — Cinematic splash with scrolling hint + tap prompt
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

      // Background + atmospheric stack
      this.cameras.main.setBackgroundColor(colors.background);
      FX.ambient.GradientBackground(this, {
        colorTop: colors.primary,
        colorBottom: colors.background,
        colorShift: colors.accent,
        duration: 6000
      });

      // Parallax hint layers (dots drifting)
      FX.ambient.ParallaxLayers(this, { color: colors.primary, layers: 3 });

      // A scrolling ground hint strip at bottom
      var splashGround = this.add.graphics().setDepth(5);
      splashGround.fillStyle(hexToInt(colors.secondary), 0.12);
      splashGround.fillRect(0, GROUND_Y + 20, W, GROUND_THICKNESS);

      // Decorative scrolling dash marks on ground (tween loop)
      var dashGroup = this.add.container(0, 0).setDepth(6);
      var dashCount = 10;
      for (var d = 0; d < dashCount; d++) {
        var dx = d * (W / dashCount);
        var dash = this.add.rectangle(dx, GROUND_Y + 50, 30, 4, hexToInt(colors.primary), 0.35);
        dashGroup.add(dash);
      }
      this.tweens.add({
        targets: dashGroup,
        x: -(W / dashCount),
        duration: 1400,
        repeat: -1,
        ease: 'Linear'
      });

      // Light rays
      FX.ambient.LightRays(this, { color: colors.accent, count: 2 });

      // Vignette
      FX.ambient.VignetteOverlay(this, { intensity: 0.3 });

      // Ambient particles
      FX.ambient.FloatingParticles(this, { color: colors.accent, density: 'low' });

      // Logo (if available)
      var logoKey = CONFIG.assets.logo;
      if (logoKey && this.textures.exists(logoKey)) {
        var logo = this.add.image(W / 2, H * 0.30, logoKey).setDepth(10);
        var maxDim = 140;
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
        FX.effects.glowRing(this, W / 2, H * 0.30, 90, colors.primary);
      }

      // Title text
      var title = this.add.text(W / 2, H * 0.48, texts.title, {
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
        var sub = this.add.text(W / 2, H * 0.55, texts.subtitle, {
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

      // Preview character icon on the splash (idle bob)
      var previewCharY = H * 0.66;
      var charAssetKey = CONFIG.assets.character;
      var preview;
      if (charAssetKey && this.textures.exists(charAssetKey)) {
        preview = this.add.image(W / 2, previewCharY, charAssetKey).setDepth(10);
        var ms = Math.min(90 / preview.width, 90 / preview.height, 1);
        preview.setScale(0);
        this.tweens.add({ targets: preview, scale: ms, duration: 500, delay: 1100, ease: 'Back.easeOut' });
      } else {
        preview = this.add.circle(W / 2, previewCharY, 36, hexToInt(colors.primary)).setDepth(10).setScale(0);
        this.tweens.add({ targets: preview, scale: 1, duration: 500, delay: 1100, ease: 'Back.easeOut' });
      }
      this.tweens.add({
        targets: preview,
        y: previewCharY - 12,
        duration: 900,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
        delay: 1600
      });
      this.tweens.add({
        targets: preview,
        angle: { from: -6, to: 6 },
        duration: 1400,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
        delay: 1600
      });

      // "Tap to Run!" — pulsing
      var tapLabel = texts.tapToStart || 'Tap to Run!';
      var tapText = this.add.text(W / 2, H * 0.80, tapLabel, {
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
        delay: 1400
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
  // GAME SCENE — Side-scrolling runner
  // ═══════════════════════════════════════════════════════════
  class GameScene extends Phaser.Scene {
    constructor() { super('GameScene'); }

    create() {
      var self = this;
      FX.transitions.fadeIn(this);

      var colors = CONFIG.colors;
      var gameplay = CONFIG.gameplay;
      var difficulty = CONFIG.difficulty;

      // ── State ──
      this.score = 0;
      this.distance = 0;
      this.lives = gameplay.lives;
      this.currentSpeed = gameplay.initialSpeed;
      this.currentObstacleRate = gameplay.obstacleSpawnRate;
      this.currentCollectibleRate = gameplay.collectibleSpawnRate;
      this.gameActive = true;
      this.invulnerable = false;
      this.isJumping = false;
      this.jumpVelocity = 0;
      this.characterY = GROUND_Y;
      this.combo = 0;
      this.lastTime = 0;

      this.obstacles = [];
      this.collectibles = [];

      // ── Background stack ──
      this.cameras.main.setBackgroundColor(colors.background);

      var bgStyle = CONFIG.theme.backgroundStyle;
      if (bgStyle === 'gradient_shift') {
        FX.ambient.GradientBackground(this, {
          colorTop: colors.background,
          colorBottom: colors.primary,
          colorShift: colors.accent,
          duration: 10000
        });
      } else if (bgStyle === 'floating_shapes') {
        FX.ambient.FloatingShapes(this, { color: colors.primary, count: 8 });
      } else {
        // Default / "parallax": gradient sky + parallax layers
        FX.ambient.GradientBackground(this, {
          colorTop: colors.background,
          colorBottom: colors.primary,
          colorShift: colors.accent,
          duration: 12000
        });
      }

      // ── Multi-layer custom scrolling parallax (geometric shapes) ──
      // Far layer: large translucent silhouettes (slow)
      // Mid layer: medium rounded rects (medium)
      // Near layer: small thin poles (fast)
      this.parallaxFar  = this._buildParallaxLayer(colors.primary, 0.08, 32, 60, -80, 0.25, H * 0.35, H * 0.55);
      this.parallaxMid  = this._buildParallaxLayer(colors.secondary, 0.14, 20, 40, -75, 0.55, H * 0.55, H * 0.68);
      this.parallaxNear = this._buildParallaxLayer(colors.secondary, 0.22, 10, 24, -70, 0.90, H * 0.68, GROUND_Y - 10);

      // Dot field far parallax
      FX.ambient.ParallaxLayers(this, { color: colors.primary, layers: 2 });

      // Ambient particles
      FX.ambient.FloatingParticles(this, {
        color: colors.accent,
        density: CONFIG.theme.particleDensity || 'medium'
      });

      // ── Ground ──
      var groundGfx = this.add.graphics().setDepth(8);
      groundGfx.fillStyle(hexToInt(colors.secondary), 0.18);
      groundGfx.fillRect(0, GROUND_Y + 20, W, GROUND_THICKNESS);
      // Ground horizon line
      groundGfx.lineStyle(2, hexToInt(colors.secondary), 0.4);
      groundGfx.lineBetween(0, GROUND_Y + 20, W, GROUND_Y + 20);

      // Scrolling ground pattern
      this.groundDashes = this.add.container(0, 0).setDepth(9);
      var pattern = CONFIG.theme.groundStyle || 'striped';
      var tileCount = 14;
      var tileWidth = W / tileCount;
      this._groundTileWidth = tileWidth;
      for (var i = 0; i < tileCount + 2; i++) {
        var tx = i * tileWidth;
        var shape;
        if (pattern === 'dotted') {
          shape = this.add.circle(tx + tileWidth / 2, GROUND_Y + 50, 4, hexToInt(colors.primary), 0.5);
        } else if (pattern === 'dashed') {
          shape = this.add.rectangle(tx + tileWidth / 2, GROUND_Y + 50, tileWidth * 0.3, 4, hexToInt(colors.primary), 0.5);
        } else if (pattern === 'solid') {
          shape = this.add.rectangle(tx + tileWidth / 2, GROUND_Y + 50, tileWidth, 3, hexToInt(colors.primary), 0.3);
        } else {
          // striped
          shape = this.add.rectangle(tx + tileWidth / 2, GROUND_Y + 50, tileWidth * 0.55, 4, hexToInt(colors.primary), 0.5);
        }
        this.groundDashes.add(shape);
      }

      // ── Character ──
      var character = this.add.container(CHARACTER_X, GROUND_Y).setDepth(50);
      var charAssetKey = CONFIG.assets.character;
      var charVisual;
      if (charAssetKey && this.textures.exists(charAssetKey)) {
        charVisual = this.add.image(0, 0, charAssetKey);
        var maxDim = 72;
        var s = Math.min(maxDim / charVisual.width, maxDim / charVisual.height, 1);
        charVisual.setScale(s);
      } else {
        // Fallback circle with glow underlay
        var glow = this.add.circle(0, 0, CHARACTER_RADIUS + 6, hexToInt(colors.primary), 0.2);
        character.add(glow);
        charVisual = this.add.circle(0, 0, CHARACTER_RADIUS, hexToInt(colors.primary));
      }
      character.add(charVisual);
      this.character = character;
      this.characterVisual = charVisual;

      // Idle bob + tilt (only when grounded)
      this.idleBob = this.tweens.add({
        targets: charVisual,
        y: -6,
        duration: 500,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut'
      });
      this.idleTilt = this.tweens.add({
        targets: charVisual,
        angle: { from: -4, to: 4 },
        duration: 700,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut'
      });

      // Character shadow
      this.characterShadow = this.add.ellipse(CHARACTER_X, GROUND_Y + 32, 58, 12, 0x000000, 0.25).setDepth(48);

      // Trail particles behind character
      this.charTrail = this.add.particles(0, 0, 'particle', {
        speed: { min: 20, max: 60 },
        angle: { min: 170, max: 190 },
        lifespan: 400,
        scale: { start: 0.5, end: 0 },
        alpha: { start: 0.5, end: 0 },
        tint: hexToInt(colors.accent),
        frequency: 80,
        follow: this.character,
        followOffset: { x: -18, y: 6 }
      }).setDepth(49);

      // ── HUD ──
      // Score (top-center)
      this.scoreDisplay = FX.ui.AnimatedScore(this, W / 2, 45, {
        label: CONFIG.texts.scoreLabel || 'Score',
        color: colors.secondary,
        accentColor: colors.accent,
        fontSize: 30
      });

      // Distance (top-left)
      var distContainer = this.add.container(85, 45).setDepth(100);
      var distLabelTxt = this.add.text(0, -16, CONFIG.texts.distanceLabel || 'Distance', {
        fontSize: '13px',
        fontFamily: 'Arial',
        color: colors.secondary,
        alpha: 0.7
      }).setOrigin(0.5);
      distContainer.add(distLabelTxt);
      this.distanceText = this.add.text(0, 8, '0m', {
        fontSize: '26px',
        fontFamily: 'Arial',
        fontStyle: 'bold',
        color: colors.secondary
      }).setOrigin(0.5);
      this.distanceText.setShadow(2, 2, 'rgba(0,0,0,0.3)', 4);
      distContainer.add(this.distanceText);

      // Lives display (top-right hearts)
      this.livesIcons = [];
      var heartsX = W - 110;
      var heartsY = 40;
      for (var hIdx = 0; hIdx < gameplay.lives; hIdx++) {
        var heart = this.add.text(heartsX + hIdx * 26, heartsY, '\u2764', {
          fontSize: '22px',
          fontFamily: 'Arial',
          color: '#EF4444'
        }).setOrigin(0.5).setDepth(100);
        heart.setShadow(1, 1, 'rgba(0,0,0,0.3)', 2);
        this.livesIcons.push(heart);
      }

      // ── Input: tap anywhere to jump ──
      this.input.on('pointerdown', function () {
        self._tryJump();
      });

      // ── Spawners ──
      this.obstacleEvent = this.time.addEvent({
        delay: this.currentObstacleRate,
        callback: function () { self._spawnObstacle(); },
        loop: true
      });

      this.collectibleEvent = this.time.addEvent({
        delay: this.currentCollectibleRate,
        callback: function () { self._spawnCollectible(); },
        loop: true
      });

      // ── Difficulty ramp ──
      this.rampEvent = this.time.addEvent({
        delay: (difficulty.rampInterval || 8) * 1000,
        callback: function () { self._rampDifficulty(); },
        loop: true
      });

      // ── Mute button ──
      FX.audio.createMuteButton(this, { x: W - 35, y: 80, size: 18 });
    }

    // ── Build a custom parallax layer of geometric silhouettes ──
    _buildParallaxLayer(color, alpha, minSize, maxSize, duration, speedMul, yMin, yMax) {
      var items = [];
      var count = 5;
      var spacing = W / 3;
      for (var i = 0; i < count; i++) {
        var size = Phaser.Math.Between(minSize, maxSize);
        var gx = i * spacing + Phaser.Math.Between(-40, 40);
        var gy = Phaser.Math.Between(yMin, yMax);
        var shape;
        var pick = i % 3;
        if (pick === 0) {
          shape = this.add.rectangle(gx, gy, size, size * 1.6, hexToInt(color), alpha);
        } else if (pick === 1) {
          shape = this.add.circle(gx, gy, size * 0.6, hexToInt(color), alpha);
        } else {
          var gfx = this.add.graphics();
          gfx.fillStyle(hexToInt(color), alpha);
          gfx.fillTriangle(gx, gy - size * 0.7, gx - size * 0.7, gy + size * 0.5, gx + size * 0.7, gy + size * 0.5);
          shape = gfx;
        }
        if (shape.setDepth) shape.setDepth(-50);
        items.push({ obj: shape, x: gx, speedMul: speedMul });
      }
      return items;
    }

    // ── Jump input ──
    _tryJump() {
      if (!this.gameActive) return;
      if (this.isJumping) return;

      this.isJumping = true;
      var colors = CONFIG.colors;
      var jumpHeight = CONFIG.gameplay.jumpHeight;

      // Pause idle bob/tilt during jump
      if (this.idleBob) this.idleBob.pause();
      if (this.idleTilt) this.idleTilt.pause();
      this.characterVisual.y = 0;

      FX.audio.playTap();

      // Squash before launch
      var self = this;
      this.tweens.add({
        targets: this.characterVisual,
        scaleY: this.characterVisual.scaleY * 0.85,
        scaleX: this.characterVisual.scaleX * 1.1,
        duration: 60,
        yoyo: true,
        ease: 'Quad.easeOut'
      });

      // Up phase: Back.easeOut
      this.tweens.add({
        targets: this.character,
        y: GROUND_Y - jumpHeight,
        duration: 380,
        ease: 'Back.easeOut',
        onComplete: function () {
          // Down phase: Bounce.easeIn for weighty gravity feel
          self.tweens.add({
            targets: self.character,
            y: GROUND_Y,
            duration: 380,
            ease: 'Bounce.easeIn',
            onComplete: function () {
              self.isJumping = false;
              self.character.y = GROUND_Y;
              if (self.idleBob) self.idleBob.resume();
              if (self.idleTilt) self.idleTilt.resume();
              // Tiny landing squash
              self.tweens.add({
                targets: self.characterVisual,
                scaleY: self.characterVisual.scaleY * 0.9,
                scaleX: self.characterVisual.scaleX * 1.08,
                duration: 70,
                yoyo: true,
                ease: 'Quad.easeOut'
              });
              // Landing dust
              if (self.textures.exists('particle')) {
                var dust = self.add.particles(self.character.x, GROUND_Y + 30, 'particle', {
                  speed: { min: 30, max: 90 },
                  angle: { min: 200, max: 340 },
                  lifespan: 380,
                  scale: { start: 0.5, end: 0 },
                  alpha: { start: 0.6, end: 0 },
                  tint: hexToInt(CONFIG.colors.secondary),
                  quantity: 5,
                  frequency: -1
                }).setDepth(47);
                dust.explode(5, self.character.x, GROUND_Y + 30);
                self.time.delayedCall(500, function () { dust.destroy(); });
              }
            }
          });
        }
      });

      // Spin a bit in air (visual flair)
      this.tweens.add({
        targets: this.characterVisual,
        angle: { from: 0, to: 360 },
        duration: 760,
        ease: 'Cubic.easeInOut',
        onComplete: function () { self.characterVisual.angle = 0; }
      });
    }

    // ── Spawn obstacle ──
    _spawnObstacle() {
      if (!this.gameActive) return;
      var colors = CONFIG.colors;
      var kindRoll = Phaser.Math.Between(0, 100);
      var self = this;

      if (kindRoll < 40) {
        // Small rock (short)
        this._createObstacle({ type: 'rock', w: 44, h: 32, x: W + 60 });
      } else if (kindRoll < 75) {
        // Tall pole
        this._createObstacle({ type: 'pole', w: 28, h: 90, x: W + 60 });
      } else {
        // Group of 2-3 rocks spaced
        var groupCount = Phaser.Math.Between(2, 3);
        for (var g = 0; g < groupCount; g++) {
          (function (gi) {
            self.time.delayedCall(gi * 180, function () {
              if (!self.gameActive) return;
              self._createObstacle({ type: 'rock', w: 40, h: 28, x: W + 60 });
            });
          })(g);
        }
      }
    }

    _createObstacle(opts) {
      var colors = CONFIG.colors;
      var container = this.add.container(opts.x, GROUND_Y + 20 - opts.h / 2).setDepth(30);

      var body = this.add.graphics();
      body.fillStyle(hexToInt(colors.secondary), 1);
      body.fillRoundedRect(-opts.w / 2, -opts.h / 2, opts.w, opts.h, 6);
      container.add(body);

      var highlight = this.add.graphics();
      highlight.fillStyle(0xffffff, 0.2);
      highlight.fillRoundedRect(-opts.w / 2 + 2, -opts.h / 2 + 2, opts.w * 0.35, opts.h - 4, 4);
      container.add(highlight);

      // Border
      var border = this.add.graphics();
      border.lineStyle(2, 0x000000, 0.2);
      border.strokeRoundedRect(-opts.w / 2, -opts.h / 2, opts.w, opts.h, 6);
      container.add(border);

      // Scale-in entrance
      container.setScale(0);
      this.tweens.add({
        targets: container,
        scale: 1,
        duration: 180,
        ease: 'Back.easeOut'
      });

      this.obstacles.push({
        container: container,
        w: opts.w,
        h: opts.h,
        collided: false
      });
    }

    // ── Spawn collectible ──
    _spawnCollectible() {
      if (!this.gameActive) return;
      var colors = CONFIG.colors;
      var collectibles = CONFIG.assets.collectibles || [];
      var heightOptions = [GROUND_Y - 40, GROUND_Y - 110, GROUND_Y - 180];
      var y = heightOptions[Phaser.Math.Between(0, heightOptions.length - 1)];

      var assetKey = collectibles.length ? collectibles[Phaser.Math.Between(0, collectibles.length - 1)] : null;
      var container = this.add.container(W + 60, y).setDepth(35);

      var visual;
      if (assetKey && this.textures.exists(assetKey)) {
        visual = this.add.image(0, 0, assetKey);
        var maxDim = 48;
        var s = Math.min(maxDim / visual.width, maxDim / visual.height, 1);
        visual.setScale(s);
      } else {
        // Fallback: accent coin
        var ring = this.add.circle(0, 0, 22, hexToInt(colors.accent), 0.3);
        container.add(ring);
        visual = this.add.circle(0, 0, 16, hexToInt(colors.accent));
      }
      container.add(visual);

      // Entrance pop
      container.setScale(0);
      this.tweens.add({
        targets: container,
        scale: 1,
        duration: 220,
        ease: 'Back.easeOut'
      });

      // Float bobbing
      this.tweens.add({
        targets: container,
        y: y - 10,
        duration: 600,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut'
      });

      // Spin
      this.tweens.add({
        targets: visual,
        angle: 360,
        duration: 1600,
        repeat: -1,
        ease: 'Linear'
      });

      this.collectibles.push({
        container: container,
        visual: visual,
        active: true,
        r: 26
      });
    }

    // ── Difficulty ramp ──
    _rampDifficulty() {
      if (!this.gameActive) return;
      var difficulty = CONFIG.difficulty;
      var gameplay = CONFIG.gameplay;
      var self = this;

      this.currentSpeed = Math.min(gameplay.maxSpeed, this.currentSpeed + (difficulty.speedIncrease || 30));
      this.currentObstacleRate = Math.max(500, this.currentObstacleRate - (difficulty.spawnRateDecrease || 80));
      this.currentCollectibleRate = Math.max(450, this.currentCollectibleRate - (difficulty.spawnRateDecrease || 80));

      if (this.obstacleEvent) {
        this.obstacleEvent.reset({
          delay: this.currentObstacleRate,
          callback: function () { self._spawnObstacle(); },
          loop: true
        });
      }
      if (this.collectibleEvent) {
        this.collectibleEvent.reset({
          delay: this.currentCollectibleRate,
          callback: function () { self._spawnCollectible(); },
          loop: true
        });
      }

      // Brief ramp flash cue
      var colors = CONFIG.colors;
      var cue = this.add.text(W / 2, H * 0.25, 'SPEED UP!', {
        fontSize: '30px', fontFamily: 'Arial', fontStyle: 'bold',
        color: colors.accent, stroke: colors.secondary, strokeThickness: 3
      }).setOrigin(0.5).setDepth(200).setScale(0).setAlpha(0);

      this.tweens.add({
        targets: cue,
        scale: 1.2,
        alpha: 1,
        duration: 260,
        ease: 'Back.easeOut',
        yoyo: true,
        hold: 300,
        onComplete: function () { cue.destroy(); }
      });
      FX.audio.playWhoosh();
    }

    // ── Main update loop ──
    update(time, delta) {
      if (!this.gameActive) return;
      var dt = delta / 1000;
      var dx = this.currentSpeed * dt;

      // Distance counter
      this.distance += dx * 0.1;
      this.distanceText.setText(Math.floor(this.distance) + 'm');

      // Accumulate distance points (sparingly)
      var distPts = CONFIG.gameplay.pointsPerDistance || 0;
      if (distPts > 0) {
        // Add 1 point per 20 distance units (scaled by pointsPerDistance)
        if (Math.floor(this.distance) > 0 && Math.floor(this.distance) % Math.max(1, Math.round(20 / distPts)) === 0) {
          if (!this._lastDistanceTick || Math.floor(this.distance) !== this._lastDistanceTick) {
            this._lastDistanceTick = Math.floor(this.distance);
            this.score += distPts;
            this.scoreDisplay.set(this.score);
          }
        }
      }

      // Scroll ground pattern
      if (this.groundDashes) {
        this.groundDashes.x -= dx;
        if (this.groundDashes.x <= -this._groundTileWidth) {
          this.groundDashes.x += this._groundTileWidth;
        }
      }

      // Scroll custom parallax layers
      this._scrollParallax(this.parallaxFar, dx);
      this._scrollParallax(this.parallaxMid, dx);
      this._scrollParallax(this.parallaxNear, dx);

      // Update shadow scale based on jump height
      var airT = Phaser.Math.Clamp((GROUND_Y - this.character.y) / CONFIG.gameplay.jumpHeight, 0, 1);
      this.characterShadow.scaleX = 1 - airT * 0.5;
      this.characterShadow.scaleY = 1 - airT * 0.5;
      this.characterShadow.alpha = 0.25 - airT * 0.15;

      // Scroll and check obstacles
      for (var i = this.obstacles.length - 1; i >= 0; i--) {
        var ob = this.obstacles[i];
        ob.container.x -= dx;
        if (!ob.collided && this._aabbCollides(ob)) {
          ob.collided = true;
          this._hitObstacle(ob);
        }
        if (ob.container.x < OBSTACLE_CULL_X) {
          ob.container.destroy();
          this.obstacles.splice(i, 1);
        }
      }

      // Scroll and check collectibles
      for (var j = this.collectibles.length - 1; j >= 0; j--) {
        var cl = this.collectibles[j];
        cl.container.x -= dx;
        if (cl.active && this._circleCollides(cl)) {
          cl.active = false;
          this._collect(cl);
        }
        if (cl.container.x < OBSTACLE_CULL_X) {
          cl.container.destroy();
          this.collectibles.splice(j, 1);
        }
      }
    }

    _scrollParallax(layer, baseDx) {
      if (!layer) return;
      for (var i = 0; i < layer.length; i++) {
        var entry = layer[i];
        var delta = baseDx * entry.speedMul;
        entry.obj.x -= delta;
        // Wrap
        if (entry.obj.x < -80) {
          entry.obj.x += W + 160;
        }
      }
    }

    // ── AABB collision for obstacles ──
    _aabbCollides(ob) {
      if (this.invulnerable) return false;
      var cx = this.character.x;
      var cy = this.character.y;
      var charHalfW = 24;
      var charHalfH = 28;
      var obX = ob.container.x;
      var obY = ob.container.y;
      var obHalfW = ob.w / 2;
      var obHalfH = ob.h / 2;

      return Math.abs(cx - obX) < (charHalfW + obHalfW) &&
             Math.abs(cy - obY) < (charHalfH + obHalfH);
    }

    // ── Circle-ish collision for collectibles ──
    _circleCollides(cl) {
      var dx = this.character.x - cl.container.x;
      var dy = this.character.y - cl.container.y;
      var r = cl.r + 26;
      return (dx * dx + dy * dy) < (r * r);
    }

    // ── Hit obstacle ──
    _hitObstacle(ob) {
      if (this.invulnerable || !this.gameActive) return;
      var self = this;
      var colors = CONFIG.colors;

      this.lives = Math.max(0, this.lives - 1);
      this.combo = 0;

      // Update heart icons
      if (this.livesIcons[this.lives]) {
        var heart = this.livesIcons[this.lives];
        this.tweens.add({
          targets: heart,
          scale: 0,
          alpha: 0,
          angle: 180,
          duration: 300,
          ease: 'Power2'
        });
      }

      // Camera shake + red flash
      FX.effects.screenShake(this, 0.012, 180);
      this.cameras.main.flash(120, 239, 68, 68, true);
      FX.audio.playFail();

      // Hit burst
      if (this.textures.exists('particle')) {
        var burst = this.add.particles(this.character.x, this.character.y, 'particle', {
          speed: { min: 80, max: 200 },
          lifespan: 500,
          scale: { start: 0.7, end: 0 },
          alpha: { start: 1, end: 0 },
          tint: 0xEF4444,
          quantity: 12,
          frequency: -1
        }).setDepth(150);
        burst.explode(12, this.character.x, this.character.y);
        this.time.delayedCall(900, function () { burst.destroy(); });
      }

      // Destroy the obstacle that was hit (so we don't get re-hit)
      ob.container.destroy();
      var idx = this.obstacles.indexOf(ob);
      if (idx >= 0) this.obstacles.splice(idx, 1);

      // Game over?
      if (this.lives <= 0) {
        this._endGame();
        return;
      }

      // Invulnerability + flash
      this.invulnerable = true;
      this.characterVisual.setAlpha(0.4);
      var flashTween = this.tweens.add({
        targets: this.characterVisual,
        alpha: { from: 0.4, to: 1 },
        duration: 140,
        yoyo: true,
        repeat: 6,
        ease: 'Linear'
      });

      this.time.delayedCall(1600, function () {
        self.invulnerable = false;
        if (flashTween) flashTween.stop();
        self.characterVisual.setAlpha(1);
      });
    }

    // ── Collect item ──
    _collect(cl) {
      var colors = CONFIG.colors;
      var texts = CONFIG.texts;
      var points = CONFIG.gameplay.pointsPerCollectible;

      this.score += points;
      this.combo += 1;
      this.scoreDisplay.add(points);

      // Score popup
      FX.effects.scorePopup(this, cl.container.x, cl.container.y, '+' + points, colors.accent);

      // Sparkle burst
      FX.effects.sparkleBurst(this, cl.container.x, cl.container.y, colors.accent, 10);

      // Small trail burst from character
      if (this.textures.exists('particle')) {
        var trail = this.add.particles(this.character.x, this.character.y, 'particle', {
          speed: { min: 40, max: 120 },
          lifespan: 500,
          scale: { start: 0.6, end: 0 },
          alpha: { start: 0.9, end: 0 },
          tint: hexToInt(colors.accent),
          quantity: 6,
          frequency: -1
        }).setDepth(51);
        trail.explode(6, this.character.x, this.character.y);
        this.time.delayedCall(700, function () { trail.destroy(); });
      }

      // Character scale punch
      FX.effects.scalePunch(this, this.characterVisual, 1.18, 140);

      // Encouragement every 5 combo
      if (this.combo > 0 && this.combo % 5 === 0 && texts.encouragement && texts.encouragement.length) {
        var msg = texts.encouragement[Phaser.Math.Between(0, texts.encouragement.length - 1)];
        var enc = this.add.text(W / 2, H * 0.35, msg, {
          fontSize: '32px', fontFamily: 'Arial', fontStyle: 'bold',
          color: colors.accent, stroke: colors.secondary, strokeThickness: 3
        }).setOrigin(0.5).setDepth(200).setScale(0);

        this.tweens.add({
          targets: enc,
          scale: 1.3,
          alpha: { from: 1, to: 0 },
          y: H * 0.30,
          duration: 1000,
          ease: 'Power2',
          onComplete: function () { enc.destroy(); }
        });
      }

      FX.audio.playScore();

      // Collect animation: fly toward score display
      this.tweens.add({
        targets: cl.container,
        x: W / 2,
        y: 45,
        scale: 0,
        alpha: 0,
        duration: 320,
        ease: 'Cubic.easeIn',
        onComplete: function () { cl.container.destroy(); }
      });
    }

    // ── End game ──
    _endGame() {
      if (!this.gameActive) return;
      this.gameActive = false;
      var self = this;

      if (this.obstacleEvent) this.obstacleEvent.remove(false);
      if (this.collectibleEvent) this.collectibleEvent.remove(false);
      if (this.rampEvent) this.rampEvent.remove(false);

      FX.audio.playWhoosh();

      // Character dramatic fall + fade
      this.tweens.add({
        targets: this.character,
        y: GROUND_Y + 60,
        angle: 90,
        alpha: 0,
        duration: 500,
        ease: 'Cubic.easeIn'
      });

      // Push remaining obstacles/collectibles off screen
      this.obstacles.forEach(function (ob) {
        self.tweens.add({
          targets: ob.container, alpha: 0, duration: 300, ease: 'Power2'
        });
      });
      this.collectibles.forEach(function (cl) {
        self.tweens.add({
          targets: cl.container, alpha: 0, duration: 300, ease: 'Power2'
        });
      });

      this.time.delayedCall(700, function () {
        var transition = CONFIG.theme.transitionStyle;
        var payload = { score: self.score, distance: Math.floor(self.distance) };
        if (transition === 'zoom') {
          FX.transitions.zoomOut(self, 'EndScene', payload);
        } else if (transition === 'flash') {
          FX.transitions.flashTransition(self, 'EndScene', payload);
        } else if (transition === 'wipe') {
          FX.transitions.wipeTransition(self, 'EndScene', payload, 'left');
        } else {
          FX.transitions.cinematicFade(self, 'EndScene', payload);
        }
      });
    }
  }

  // ═══════════════════════════════════════════════════════════
  // END SCENE — Score + distance reveal, star rating, CTA
  // ═══════════════════════════════════════════════════════════
  class EndScene extends Phaser.Scene {
    constructor() { super('EndScene'); }

    create(data) {
      FX.transitions.fadeIn(this);
      var colors = CONFIG.colors;
      var texts = CONFIG.texts;
      var score = data.score || 0;
      var distance = data.distance || 0;

      // Background
      this.cameras.main.setBackgroundColor(colors.background);
      FX.ambient.GradientBackground(this, {
        colorTop: colors.primary,
        colorBottom: colors.background,
        colorShift: colors.accent,
        duration: 5000
      });
      FX.ambient.FloatingParticles(this, { color: colors.accent, density: 'medium' });
      FX.ambient.VignetteOverlay(this, { intensity: 0.25 });

      // Game Over title
      var title = this.add.text(W / 2, H * 0.16, texts.gameOver || 'Game Over!', {
        fontSize: '38px', fontFamily: 'Arial', fontStyle: 'bold',
        color: colors.secondary
      }).setOrigin(0.5).setDepth(10);
      title.setShadow(2, 2, 'rgba(0,0,0,0.2)', 4);
      FX.effects.bounceIn(this, title, 100);

      // Distance display
      var distContainer = this.add.container(W / 2, H * 0.27).setDepth(10);
      var distLabel = this.add.text(0, -18, texts.distanceLabel || 'Distance', {
        fontSize: '15px', fontFamily: 'Arial',
        color: colors.secondary, alpha: 0.7
      }).setOrigin(0.5);
      distContainer.add(distLabel);
      var distVal = this.add.text(0, 10, '0m', {
        fontSize: '36px', fontFamily: 'Arial', fontStyle: 'bold',
        color: colors.secondary
      }).setOrigin(0.5);
      distVal.setShadow(2, 2, 'rgba(0,0,0,0.3)', 4);
      distContainer.add(distVal);

      // Distance count-up
      var self = this;
      this.time.delayedCall(400, function () {
        self.tweens.addCounter({
          from: 0,
          to: distance,
          duration: 1200,
          ease: 'Power2',
          onUpdate: function (tween) {
            distVal.setText(Math.round(tween.getValue()) + 'm');
          },
          onComplete: function () { distVal.setText(distance + 'm'); }
        });
      });

      // Score count-up
      var scoreDisplay = FX.ui.AnimatedScore(this, W / 2, H * 0.38, {
        label: texts.scoreLabel || 'Score',
        color: colors.secondary,
        accentColor: colors.accent,
        fontSize: 48
      });
      this.time.delayedCall(700, function () {
        scoreDisplay.countUpFrom(0, score, 1400);
      });

      // Star rating (based on combined distance+score metric)
      // 3 stars: covered good distance AND scored well
      var perDistPts = CONFIG.gameplay.pointsPerDistance || 0;
      var approxCollected = Math.max(0, score - distance * perDistPts);
      var collectTarget = 15 * CONFIG.gameplay.pointsPerCollectible;
      var distTarget = 400;
      var pct = (approxCollected / collectTarget) * 0.6 + (distance / distTarget) * 0.4;
      pct = Phaser.Math.Clamp(pct, 0, 1);
      var starCount = pct >= 0.7 ? 3 : pct >= 0.4 ? 2 : 1;

      var stars = FX.ui.StarRating(this, W / 2, H * 0.50, {
        maxStars: 3,
        starSize: 42,
        filledColor: colors.accent,
        emptyColor: '#CBD5E1'
      });
      this.time.delayedCall(2000, function () {
        stars.fill(starCount);
      });

      // Confetti for 3 stars / high score
      if (starCount === 3) {
        this.time.delayedCall(2800, function () {
          FX.effects.confettiBurst(this, W / 2, H * 0.4,
            [colors.primary, colors.accent, colors.secondary, '#FFFFFF'], 50);
          FX.audio.playSuccess();
        }.bind(this));
      }

      // Logo (if available)
      var logoKey = CONFIG.assets.logo;
      if (logoKey && this.textures.exists(logoKey)) {
        var logo = this.add.image(W / 2, H * 0.60, logoKey).setDepth(10);
        var ls = Math.min(80 / logo.width, 80 / logo.height, 1);
        logo.setScale(0);
        this.tweens.add({
          targets: logo,
          scale: ls,
          duration: 500,
          ease: 'Back.easeOut',
          delay: 1800
        });
      }

      // CTA Button
      var ctaBtn = FX.ui.CTAButton(this, W / 2, H * 0.73, texts.cta || 'Learn More', {
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
        delay: 2200
      });

      // Play Again
      var playAgain = this.add.text(W / 2, H * 0.85, texts.playAgain || 'Play Again', {
        fontSize: '18px', fontFamily: 'Arial', fontStyle: 'bold',
        color: colors.primary
      }).setOrigin(0.5).setDepth(10).setAlpha(0)
        .setInteractive({ useHandCursor: true });

      this.tweens.add({
        targets: playAgain,
        alpha: 0.7,
        duration: 400,
        delay: 2800
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
