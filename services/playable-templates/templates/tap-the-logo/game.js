/**
 * TAP THE LOGO — Premium Hybrid Template
 *
 * A polished hyper-casual tap game with cinematic splash,
 * particle effects, progressive difficulty, and animated end screen.
 * Brand logos appear at random positions and the player taps them
 * before they vanish. Speed increases over time.
 *
 * Reads config from window.GAME_TEMPLATE_CONFIG.
 * Uses shared modules from window.SHARED_FX.
 */

(function () {
  'use strict';

  var CONFIG = window.GAME_TEMPLATE_CONFIG;
  var FX = window.SHARED_FX;
  var W = 640, H = 960;

  // Safe zone margins to keep targets fully tappable
  var MARGIN_X = 60;
  var MARGIN_TOP = 100;
  var MARGIN_BOTTOM = 120;

  function hexToInt(hex) { return parseInt(hex.replace('#', ''), 16); }

  // ═══════════════════════════════════════════════════════════
  // BOOT SCENE — Cinematic splash with logo + title
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

      // Background
      this.cameras.main.setBackgroundColor(colors.background);
      FX.ambient.GradientBackground(this, {
        colorTop: colors.primary,
        colorBottom: colors.background,
        colorShift: colors.accent,
        duration: 6000
      });

      // Floating ambient shapes
      FX.ambient.FloatingShapes(this, { color: colors.primary, count: 10 });

      // Light rays
      FX.ambient.LightRays(this, { color: colors.accent, count: 2 });

      // Vignette
      FX.ambient.VignetteOverlay(this, { intensity: 0.3 });

      // Ambient particles
      FX.ambient.FloatingParticles(this, { color: colors.accent, density: 'low' });

      // Logo (if available)
      var logoKey = CONFIG.assets.logo;
      if (logoKey && this.textures.exists(logoKey)) {
        var logo = this.add.image(W / 2, H * 0.32, logoKey).setDepth(10);
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
        FX.effects.glowRing(this, W / 2, H * 0.32, 90, colors.primary);
      }

      // Title text — letterbox reveal
      var title = this.add.text(W / 2, H * 0.50, texts.title, {
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
        var sub = this.add.text(W / 2, H * 0.57, texts.subtitle, {
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

      // "Tap to Play" — pulsing
      var tapText = this.add.text(W / 2, H * 0.75, 'Tap to Play', {
        fontSize: '22px',
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
  // GAME SCENE — Core gameplay: tap targets before they vanish
  // ═══════════════════════════════════════════════════════════
  class GameScene extends Phaser.Scene {
    constructor() { super('GameScene'); }

    create() {
      var self = this;
      FX.transitions.fadeIn(this);

      var colors = CONFIG.colors;
      var gameplay = CONFIG.gameplay;
      var difficulty = CONFIG.difficulty;

      this.score = 0;
      this.tapsHit = 0;
      this.tapsMissed = 0;
      this.totalSpawned = 0;
      this.currentSpawnRate = gameplay.spawnRate;
      this.currentVisibleTime = gameplay.visibleTime;
      this.gameActive = true;
      this.activeTargets = [];

      // Background
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
      } else if (bgStyle === 'parallax') {
        FX.ambient.ParallaxLayers(this, { color: colors.primary, layers: 3 });
      }

      FX.ambient.FloatingParticles(this, {
        color: colors.accent,
        density: CONFIG.theme.particleDensity || 'medium'
      });

      // Score display
      this.scoreDisplay = FX.ui.AnimatedScore(this, W / 2, 45, {
        label: CONFIG.texts.scoreLabel || 'Score',
        color: colors.secondary,
        accentColor: colors.accent,
        fontSize: 32
      });

      // Circular timer
      this.timer = FX.ui.CircularTimer(this, 56, 50, {
        radius: 24,
        thickness: 5,
        fillColor: colors.primary,
        textColor: colors.secondary
      });
      this.timer.onComplete = function () {
        self.endGame();
      };
      this.timer.start(gameplay.duration);

      // Crosshair / tap ripple feedback layer
      this.rippleLayer = this.add.container(0, 0).setDepth(200);

      // Spawn timer
      this.spawnEvent = this.time.addEvent({
        delay: this.currentSpawnRate,
        callback: function () { self.spawnTarget(); },
        loop: true
      });

      // Difficulty ramp
      this.time.addEvent({
        delay: difficulty.rampInterval * 1000,
        callback: function () {
          // Decrease visible time (targets vanish faster)
          self.currentVisibleTime = Math.max(400, self.currentVisibleTime - difficulty.visibleTimeDecrease);
          // Decrease spawn rate (targets appear more frequently)
          self.currentSpawnRate = Math.max(300, self.currentSpawnRate - difficulty.spawnRateDecrease);
          self.spawnEvent.reset({
            delay: self.currentSpawnRate,
            callback: function () { self.spawnTarget(); },
            loop: true
          });

          // Visual pulse to indicate difficulty increase
          self.cameras.main.flash(100, hexToInt(colors.accent) >> 16 & 0xFF, hexToInt(colors.accent) >> 8 & 0xFF, hexToInt(colors.accent) & 0xFF, true);
        },
        loop: true
      });

      // Tap anywhere on screen — check if hitting a target, else penalize
      this.input.on('pointerdown', function (pointer) {
        if (!self.gameActive) return;
        self.handleTap(pointer.x, pointer.y);
      });

      // Mute button
      FX.audio.createMuteButton(this, { x: W - 35, y: 35, size: 18 });

      // Spawn first target immediately
      this.spawnTarget();
    }

    spawnTarget() {
      if (!this.gameActive) return;
      var self = this;
      var colors = CONFIG.colors;
      var gameplay = CONFIG.gameplay;
      var targets = CONFIG.assets.targets || ['sprite_0'];

      // Random position within safe zone
      var x = Phaser.Math.Between(MARGIN_X, W - MARGIN_X);
      var y = Phaser.Math.Between(MARGIN_TOP, H - MARGIN_BOTTOM);

      // Avoid overlapping existing targets (simple rejection sampling)
      var attempts = 0;
      while (attempts < 8) {
        var tooClose = false;
        for (var i = 0; i < this.activeTargets.length; i++) {
          var existing = this.activeTargets[i];
          if (existing.container.active) {
            var dx = existing.container.x - x;
            var dy = existing.container.y - y;
            if (Math.sqrt(dx * dx + dy * dy) < 90) {
              tooClose = true;
              break;
            }
          }
        }
        if (!tooClose) break;
        x = Phaser.Math.Between(MARGIN_X, W - MARGIN_X);
        y = Phaser.Math.Between(MARGIN_TOP, H - MARGIN_BOTTOM);
        attempts++;
      }

      this.totalSpawned++;

      // Pick a random target asset
      var assetKey = targets[Phaser.Math.Between(0, targets.length - 1)];

      // Build target container
      var container = this.add.container(x, y).setDepth(30);

      // Glow ring behind the target
      var glowRing = this.add.graphics();
      glowRing.lineStyle(3, hexToInt(colors.accent), 0.4);
      glowRing.strokeCircle(0, 0, 42);
      container.add(glowRing);

      // Pulsing ring animation
      this.tweens.add({
        targets: glowRing,
        scaleX: 1.3,
        scaleY: 1.3,
        alpha: 0,
        duration: this.currentVisibleTime * 0.8,
        ease: 'Quad.easeOut'
      });

      // Target image or fallback
      var targetSprite;
      if (this.textures.exists(assetKey)) {
        targetSprite = this.add.image(0, 0, assetKey);
        var maxSize = 64;
        var s = Math.min(maxSize / targetSprite.width, maxSize / targetSprite.height, 1);
        targetSprite.setScale(s);
        targetSprite.setData('targetScale', s);
      } else {
        // Fallback: styled circle with brand color
        targetSprite = this.add.circle(0, 0, 28, hexToInt(colors.accent));
        targetSprite.setData('targetScale', 1);
      }
      container.add(targetSprite);

      // Bounce-in entrance animation
      container.setScale(0);
      this.tweens.add({
        targets: container,
        scale: 1,
        duration: 250,
        ease: 'Back.easeOut'
      });

      // Gentle floating idle
      this.tweens.add({
        targets: container,
        y: y + Phaser.Math.Between(-6, 6),
        duration: Phaser.Math.Between(800, 1200),
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut'
      });

      // Shrink warning before vanishing
      var visibleTime = this.currentVisibleTime;
      var shrinkEnabled = gameplay.shrinkBeforeVanish !== false;

      if (shrinkEnabled) {
        // Start shrink warning at 70% of visible time
        this.time.delayedCall(visibleTime * 0.7, function () {
          if (!container.active || container.getData('tapped')) return;
          // Flashing warning
          self.tweens.add({
            targets: container,
            alpha: { from: 1, to: 0.3 },
            scale: { from: 1, to: 0.6 },
            duration: visibleTime * 0.3,
            ease: 'Quad.easeIn'
          });
        });
      }

      // Vanish timer — target disappears if not tapped
      var vanishTimer = this.time.delayedCall(visibleTime, function () {
        if (!container.active || container.getData('tapped')) return;
        self.targetMissed(container);
      });

      // Store target data
      var targetData = {
        container: container,
        sprite: targetSprite,
        vanishTimer: vanishTimer,
        x: x,
        y: y,
        radius: 42
      };
      container.setData('targetData', targetData);
      this.activeTargets.push(targetData);
    }

    handleTap(pointerX, pointerY) {
      var self = this;
      var colors = CONFIG.colors;

      // Check if pointer hit any active target
      var hitTarget = null;
      var hitIndex = -1;

      for (var i = 0; i < this.activeTargets.length; i++) {
        var target = this.activeTargets[i];
        if (!target.container.active || target.container.getData('tapped')) continue;

        var dx = target.container.x - pointerX;
        var dy = target.container.y - pointerY;
        var dist = Math.sqrt(dx * dx + dy * dy);

        // Generous hit area for mobile-friendly tapping
        if (dist < target.radius + 20) {
          hitTarget = target;
          hitIndex = i;
          break;
        }
      }

      if (hitTarget) {
        this.targetTapped(hitTarget, hitIndex);
      } else {
        // Missed tap — penalize only if there are active targets on screen
        var hasActiveTargets = false;
        for (var j = 0; j < this.activeTargets.length; j++) {
          if (this.activeTargets[j].container.active && !this.activeTargets[j].container.getData('tapped')) {
            hasActiveTargets = true;
            break;
          }
        }
        if (hasActiveTargets) {
          this.tapMissed(pointerX, pointerY);
        }
      }
    }

    targetTapped(target, index) {
      var container = target.container;
      if (!container.active || container.getData('tapped')) return;
      container.setData('tapped', true);

      var colors = CONFIG.colors;
      var texts = CONFIG.texts;
      var points = CONFIG.gameplay.pointsPerTap;

      // Cancel vanish timer
      if (target.vanishTimer) target.vanishTimer.remove(false);

      this.tapsHit++;
      this.score += points;
      this.scoreDisplay.add(points);

      // Score popup
      FX.effects.scorePopup(this, container.x, container.y, '+' + points, colors.accent);

      // Sparkle burst at tap location
      FX.effects.sparkleBurst(this, container.x, container.y, colors.accent, 10);

      // Scale punch the score area
      FX.effects.scalePunch(this, this.scoreDisplay.container || this.scoreDisplay, 1.15, 120);

      // Encouragement message (every N successful taps)
      if (this.tapsHit % 5 === 0 && texts.encouragement) {
        var msg = texts.encouragement[Phaser.Math.Between(0, texts.encouragement.length - 1)];
        var enc = this.add.text(W / 2, H * 0.4, msg, {
          fontSize: '32px', fontFamily: 'Arial', fontStyle: 'bold',
          color: colors.accent, stroke: colors.secondary, strokeThickness: 3
        }).setOrigin(0.5).setDepth(200).setScale(0);

        this.tweens.add({
          targets: enc,
          scale: 1.2,
          alpha: { from: 1, to: 0 },
          y: H * 0.35,
          duration: 1000,
          ease: 'Power2',
          onComplete: function () { enc.destroy(); }
        });
      }

      // Sound
      FX.audio.playScore();

      // Target pop-out animation (scale up then vanish)
      var self = this;
      this.tweens.killTweensOf(container);
      this.tweens.add({
        targets: container,
        scale: 1.4,
        alpha: 0,
        duration: 200,
        ease: 'Quad.easeOut',
        onComplete: function () {
          container.destroy();
          self.cleanupTarget(index);
        }
      });
    }

    targetMissed(container) {
      if (!container.active || container.getData('tapped')) return;
      container.setData('tapped', true);

      var colors = CONFIG.colors;
      this.tapsMissed++;

      // Camera shake
      FX.effects.screenShake(this, 0.008, 80);

      // Red flash
      this.cameras.main.flash(80, 239, 68, 68, true);

      FX.audio.playFail();

      // Shatter particles where target was
      var emitter = this.add.particles(container.x, container.y, 'particle', {
        speed: { min: 30, max: 100 },
        angle: { min: 0, max: 360 },
        gravityY: 200,
        lifespan: 500,
        scale: { start: 0.4, end: 0 },
        tint: hexToInt(colors.accent),
        quantity: 6,
        frequency: -1
      });
      emitter.explode(6, container.x, container.y);
      var self = this;
      this.time.delayedCall(800, function () { emitter.destroy(); });

      // Vanish animation
      this.tweens.killTweensOf(container);
      this.tweens.add({
        targets: container,
        scale: 0,
        alpha: 0,
        duration: 150,
        ease: 'Quad.easeIn',
        onComplete: function () {
          container.destroy();
        }
      });

      // Cleanup from active list
      for (var i = 0; i < this.activeTargets.length; i++) {
        if (this.activeTargets[i].container === container) {
          this.activeTargets.splice(i, 1);
          break;
        }
      }
    }

    tapMissed(x, y) {
      var colors = CONFIG.colors;

      // Subtle red X indicator at tap location
      var missMarker = this.add.text(x, y, '\u2716', {
        fontSize: '28px',
        color: '#EF4444'
      }).setOrigin(0.5).setDepth(150).setAlpha(0.8);

      this.tweens.add({
        targets: missMarker,
        alpha: 0,
        scale: 1.5,
        y: y - 20,
        duration: 400,
        ease: 'Quad.easeOut',
        onComplete: function () { missMarker.destroy(); }
      });

      // Light camera shake for wasted tap
      FX.effects.screenShake(this, 0.004, 50);
    }

    cleanupTarget(index) {
      if (index >= 0 && index < this.activeTargets.length) {
        this.activeTargets.splice(index, 1);
      }
    }

    endGame() {
      if (!this.gameActive) return;
      this.gameActive = false;
      this.timer.stop();
      if (this.spawnEvent) this.spawnEvent.remove(false);

      FX.audio.playWhoosh();

      // Pop out all remaining targets
      var self = this;
      this.activeTargets.forEach(function (target) {
        if (target.container.active) {
          if (target.vanishTimer) target.vanishTimer.remove(false);
          self.tweens.killTweensOf(target.container);
          self.tweens.add({
            targets: target.container,
            scale: 0,
            alpha: 0,
            duration: 300,
            ease: 'Back.easeIn'
          });
        }
      });

      this.time.delayedCall(400, function () {
        var transition = CONFIG.theme.transitionStyle;
        var sceneData = {
          score: self.score,
          tapsHit: self.tapsHit,
          tapsMissed: self.tapsMissed,
          totalSpawned: self.totalSpawned
        };
        if (transition === 'zoom') {
          FX.transitions.zoomOut(self, 'EndScene', sceneData);
        } else if (transition === 'flash') {
          FX.transitions.flashTransition(self, 'EndScene', sceneData);
        } else {
          FX.transitions.cinematicFade(self, 'EndScene', sceneData);
        }
      });
    }
  }

  // ═══════════════════════════════════════════════════════════
  // END SCENE — Score reveal, star rating, CTA
  // ═══════════════════════════════════════════════════════════
  class EndScene extends Phaser.Scene {
    constructor() { super('EndScene'); }

    create(data) {
      FX.transitions.fadeIn(this);
      var colors = CONFIG.colors;
      var texts = CONFIG.texts;
      var score = data.score || 0;
      var tapsHit = data.tapsHit || 0;
      var totalSpawned = data.totalSpawned || 1;

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
      var title = this.add.text(W / 2, H * 0.18, texts.gameOver || "Time's Up!", {
        fontSize: '38px', fontFamily: 'Arial', fontStyle: 'bold',
        color: colors.secondary
      }).setOrigin(0.5).setDepth(10);
      title.setShadow(2, 2, 'rgba(0,0,0,0.2)', 4);
      FX.effects.bounceIn(this, title, 100);

      // Score count-up
      var scoreDisplay = FX.ui.AnimatedScore(this, W / 2, H * 0.32, {
        label: texts.scoreLabel || 'Score',
        color: colors.secondary,
        accentColor: colors.accent,
        fontSize: 48
      });
      this.time.delayedCall(500, function () {
        scoreDisplay.countUpFrom(0, score, 1500);
      });

      // Star rating based on hit accuracy
      var accuracy = totalSpawned > 0 ? tapsHit / totalSpawned : 0;
      var starCount = accuracy >= 0.7 ? 3 : accuracy >= 0.4 ? 2 : 1;

      var stars = FX.ui.StarRating(this, W / 2, H * 0.46, {
        maxStars: 3,
        starSize: 42,
        filledColor: colors.accent,
        emptyColor: '#CBD5E1'
      });
      this.time.delayedCall(2000, function () {
        stars.fill(starCount);
      });

      // Confetti for 3 stars
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
        var logo = this.add.image(W / 2, H * 0.58, logoKey).setDepth(10);
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
      var ctaBtn = FX.ui.CTAButton(this, W / 2, H * 0.72, texts.cta || 'Learn More', {
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
      var playAgain = this.add.text(W / 2, H * 0.84, texts.playAgain || 'Play Again', {
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
