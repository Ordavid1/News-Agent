/**
 * CATCH THE FALLING ITEMS — Premium Hybrid Template
 *
 * A polished hyper-casual catch game with cinematic splash,
 * particle effects, progressive difficulty, and animated end screen.
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
  // GAME SCENE — Core gameplay
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
      this.misses = 0;
      this.currentSpawnRate = gameplay.spawnRate;
      this.currentSpeedMin = gameplay.fallSpeedMin;
      this.currentSpeedMax = gameplay.fallSpeedMax;
      this.gameActive = true;

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

      // Catch zone line
      var zoneY = H - 140;
      var zoneLine = this.add.graphics().setDepth(5);
      zoneLine.lineStyle(2, hexToInt(colors.primary), 0.15);
      zoneLine.lineBetween(20, zoneY + 40, W - 20, zoneY + 40);

      // Basket (paddle)
      var basket = this.add.container(W / 2, zoneY).setDepth(50);

      var basketBg = this.add.graphics();
      basketBg.fillStyle(hexToInt(colors.primary), 1);
      basketBg.fillRoundedRect(-55, -18, 110, 36, 10);
      basket.add(basketBg);

      var basketBorder = this.add.graphics();
      basketBorder.lineStyle(2, 0xffffff, 0.3);
      basketBorder.strokeRoundedRect(-55, -18, 110, 36, 10);
      basket.add(basketBorder);

      // Basket label
      var basketLabel = this.add.text(0, 0, '\u{1F6D2}', {
        fontSize: '22px'
      }).setOrigin(0.5);
      basket.add(basketLabel);

      this.basket = basket;
      this.basketY = zoneY;

      // Drag the basket
      var hitZone = this.add.rectangle(W / 2, zoneY, W, 120, 0x000000, 0)
        .setInteractive({ draggable: true }).setDepth(45);

      this.input.on('drag', function (pointer, gameObject, dragX) {
        var cx = Phaser.Math.Clamp(dragX, 60, W - 60);
        basket.x = cx;
      });

      // Also follow pointer anywhere on screen
      this.input.on('pointermove', function (pointer) {
        if (!self.gameActive) return;
        var cx = Phaser.Math.Clamp(pointer.x, 60, W - 60);
        self.tweens.add({
          targets: basket,
          x: cx,
          duration: 60,
          ease: 'Linear'
        });
      });

      // Score display
      this.scoreDisplay = FX.ui.AnimatedScore(this, W / 2, 45, {
        label: CONFIG.texts.scoreLabel || 'Score',
        color: colors.secondary,
        accentColor: colors.accent,
        fontSize: 32
      });

      // Timer
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

      // Miss counter (if limit set)
      if (gameplay.missLimit > 0) {
        this.missText = this.add.text(W - 40, 50, '\u2764 ' + gameplay.missLimit, {
          fontSize: '18px', fontFamily: 'Arial', fontStyle: 'bold', color: '#EF4444'
        }).setOrigin(0.5).setDepth(100);
      }

      // Falling items group
      this.fallingItems = [];

      // Spawn timer
      this.spawnEvent = this.time.addEvent({
        delay: this.currentSpawnRate,
        callback: function () { self.spawnItem(); },
        loop: true
      });

      // Difficulty ramp
      this.time.addEvent({
        delay: difficulty.rampInterval * 1000,
        callback: function () {
          self.currentSpeedMin *= difficulty.speedMultiplier;
          self.currentSpeedMax *= difficulty.speedMultiplier;
          self.currentSpawnRate = Math.max(300, self.currentSpawnRate - difficulty.spawnRateDecrease);
          self.spawnEvent.reset({
            delay: self.currentSpawnRate,
            callback: function () { self.spawnItem(); },
            loop: true
          });
        },
        loop: true
      });

      // Mute button
      FX.audio.createMuteButton(this, { x: W - 35, y: 35, size: 18 });

      // Spawn first item immediately
      this.spawnItem();
    }

    spawnItem() {
      if (!this.gameActive) return;
      var self = this;
      var colors = CONFIG.colors;
      var collectibles = CONFIG.assets.collectibles || ['sprite_0'];

      var x = Phaser.Math.Between(50, W - 50);
      var speed = Phaser.Math.Between(this.currentSpeedMin, this.currentSpeedMax);
      var duration = (H / speed) * 1000;

      // Pick a random asset
      var assetKey = collectibles[Phaser.Math.Between(0, collectibles.length - 1)];
      var item;

      if (this.textures.exists(assetKey)) {
        item = this.add.image(x, -40, assetKey).setDepth(20);
        var maxSize = 64;
        var s = Math.min(maxSize / item.width, maxSize / item.height, 1);
        item.setScale(s);
      } else {
        // Fallback: colored circle
        item = this.add.circle(x, -40, 22, hexToInt(colors.accent)).setDepth(20);
      }

      // Scale-in entrance
      var targetScale = item.scale || 1;
      item.setScale(0);
      this.tweens.add({
        targets: item,
        scale: targetScale,
        duration: 200,
        ease: 'Back.easeOut'
      });

      // Gentle rotation
      this.tweens.add({
        targets: item,
        angle: Phaser.Math.Between(-15, 15),
        duration: duration,
        ease: 'Sine.easeInOut'
      });

      // Fall tween
      var fallTween = this.tweens.add({
        targets: item,
        y: H + 40,
        duration: duration,
        ease: 'Quad.easeIn',
        onUpdate: function () {
          // Check catch collision
          if (item.active && item.y >= self.basketY - 25 && item.y <= self.basketY + 25) {
            var dist = Math.abs(item.x - self.basket.x);
            if (dist < 65) {
              self.catchItem(item, fallTween);
            }
          }
        },
        onComplete: function () {
          if (item.active) {
            self.missItem(item);
          }
        }
      });

      this.fallingItems.push({ item: item, tween: fallTween });
    }

    catchItem(item, tween) {
      if (!item.active) return;
      item.active = false;
      tween.stop();

      var colors = CONFIG.colors;
      var texts = CONFIG.texts;
      var points = CONFIG.gameplay.pointsPerCatch;

      this.score += points;
      this.scoreDisplay.add(points);

      // Score popup
      FX.effects.scorePopup(this, item.x, item.y, '+' + points, colors.accent);

      // Sparkle burst
      FX.effects.sparkleBurst(this, item.x, item.y, colors.accent, 8);

      // Scale punch the basket
      FX.effects.scalePunch(this, this.basket, 1.15, 120);

      // Encouragement message (random)
      if (this.score % 30 === 0 && texts.encouragement) {
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

      // Remove item
      this.tweens.add({
        targets: item,
        scale: 0,
        alpha: 0,
        duration: 150,
        onComplete: function () { item.destroy(); }
      });
    }

    missItem(item) {
      if (!item.active) return;
      item.active = false;
      var colors = CONFIG.colors;
      var gameplay = CONFIG.gameplay;

      // Camera shake
      FX.effects.screenShake(this, 0.008, 80);

      // Red flash
      this.cameras.main.flash(80, 239, 68, 68, true);

      FX.audio.playFail();

      // Shatter particles at ground
      var emitter = this.add.particles(item.x, H - 130, 'particle', {
        speed: { min: 40, max: 120 },
        angle: { min: 200, max: 340 },
        gravityY: 300,
        lifespan: 500,
        scale: { start: 0.5, end: 0 },
        tint: hexToInt(colors.accent),
        quantity: 6,
        frequency: -1
      });
      emitter.explode(6, item.x, H - 130);
      this.time.delayedCall(800, function () { emitter.destroy(); });

      item.destroy();

      // Track misses
      if (gameplay.missLimit > 0) {
        this.misses++;
        var remaining = gameplay.missLimit - this.misses;
        if (this.missText) this.missText.setText('\u2764 ' + Math.max(0, remaining));
        if (remaining <= 0) {
          this.endGame();
        }
      }
    }

    endGame() {
      if (!this.gameActive) return;
      this.gameActive = false;
      this.timer.stop();
      if (this.spawnEvent) this.spawnEvent.remove(false);

      FX.audio.playWhoosh();

      // Fly all items off screen
      var self = this;
      this.fallingItems.forEach(function (entry) {
        if (entry.item.active) {
          entry.tween.stop();
          self.tweens.add({
            targets: entry.item,
            y: H + 100,
            alpha: 0,
            duration: 300,
            ease: 'Power2'
          });
        }
      });

      this.time.delayedCall(400, function () {
        var transition = CONFIG.theme.transitionStyle;
        if (transition === 'zoom') {
          FX.transitions.zoomOut(self, 'EndScene', { score: self.score });
        } else if (transition === 'flash') {
          FX.transitions.flashTransition(self, 'EndScene', { score: self.score });
        } else {
          FX.transitions.cinematicFade(self, 'EndScene', { score: self.score });
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

      // Star rating
      var maxPossible = CONFIG.gameplay.duration * (1000 / CONFIG.gameplay.spawnRate) * CONFIG.gameplay.pointsPerCatch;
      var pct = maxPossible > 0 ? score / maxPossible : 0;
      var starCount = pct >= 0.6 ? 3 : pct >= 0.35 ? 2 : 1;

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
