/**
 * SWIPE TO SORT — Premium Hybrid Template
 *
 * A polished hyper-casual sorting game with cinematic splash,
 * swipe/drag mechanics, streak bonuses, progressive difficulty,
 * particle effects, and animated end screen.
 *
 * Items appear on screen and the player swipes left or right to
 * sort them into matching categories. Correct sorts earn points
 * and streaks; wrong sorts trigger feedback and reset the streak.
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

  /**
   * Deterministic shuffle of an array of items to build a play queue.
   * Repeats/cycles through sortableItems until we reach the desired count.
   */
  function buildItemQueue(sortableItems, count) {
    var queue = [];
    for (var i = 0; i < count; i++) {
      queue.push(sortableItems[i % sortableItems.length]);
    }
    // Fisher-Yates shuffle
    for (var j = queue.length - 1; j > 0; j--) {
      var k = Math.floor(Math.random() * (j + 1));
      var tmp = queue[j];
      queue[j] = queue[k];
      queue[k] = tmp;
    }
    return queue;
  }

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

      // Title text
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

      // Category preview labels
      var leftLabel = this.add.text(W * 0.22, H * 0.66, '\u2190 ' + texts.leftCategory, {
        fontSize: '16px',
        fontFamily: 'Arial',
        fontStyle: 'bold',
        color: colors.primary
      }).setOrigin(0.5).setDepth(10).setAlpha(0);

      var rightLabel = this.add.text(W * 0.78, H * 0.66, texts.rightCategory + ' \u2192', {
        fontSize: '16px',
        fontFamily: 'Arial',
        fontStyle: 'bold',
        color: colors.accent
      }).setOrigin(0.5).setDepth(10).setAlpha(0);

      this.tweens.add({
        targets: [leftLabel, rightLabel],
        alpha: 0.6,
        duration: 500,
        delay: 1000
      });

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
  // GAME SCENE — Core swipe-sort gameplay
  // ═══════════════════════════════════════════════════════════
  class GameScene extends Phaser.Scene {
    constructor() { super('GameScene'); }

    create() {
      var self = this;
      FX.transitions.fadeIn(this);

      var colors = CONFIG.colors;
      var gameplay = CONFIG.gameplay;
      var difficulty = CONFIG.difficulty;
      var texts = CONFIG.texts;

      this.score = 0;
      this.streak = 0;
      this.itemIndex = 0;
      this.itemsSorted = 0;
      this.gameActive = true;
      this.cardBusy = false;
      this.currentTimePerItem = 4000; // ms, initial time per item

      // Build play queue
      var sortableItems = CONFIG.assets.sortableItems || [];
      this.itemQueue = buildItemQueue(sortableItems, gameplay.itemCount);

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

      // ── Category Zones ──────────────────────────────────────
      this.createCategoryZones(colors, texts);

      // ── HUD: Score, Timer, Streak ───────────────────────────
      this.scoreDisplay = FX.ui.AnimatedScore(this, W / 2, 45, {
        label: texts.scoreLabel || 'Score',
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

      // Streak counter
      this.streakContainer = this.add.container(W - 60, 95).setDepth(100).setAlpha(0);
      var streakBg = this.add.graphics();
      streakBg.fillStyle(hexToInt(colors.accent), 0.15);
      streakBg.fillRoundedRect(-40, -16, 80, 32, 10);
      this.streakContainer.add(streakBg);

      this.streakLabel = this.add.text(0, -14, 'STREAK', {
        fontSize: '9px',
        fontFamily: 'Arial',
        fontStyle: 'bold',
        color: colors.accent
      }).setOrigin(0.5);
      this.streakContainer.add(this.streakLabel);

      this.streakText = this.add.text(0, 6, '0', {
        fontSize: '20px',
        fontFamily: 'Arial',
        fontStyle: 'bold',
        color: colors.accent
      }).setOrigin(0.5);
      this.streakText.setShadow(1, 1, 'rgba(0,0,0,0.2)', 3);
      this.streakContainer.add(this.streakText);

      // Item count progress
      this.itemProgress = FX.ui.ProgressBar(this, W / 2, 88, {
        width: 160,
        height: 6,
        bgColor: colors.secondary,
        fillColor: colors.primary,
        radius: 3
      });

      // ── Per-item timer bar ──────────────────────────────────
      this.itemTimerBg = this.add.graphics().setDepth(90);
      this.itemTimerFill = this.add.graphics().setDepth(91);
      this.itemTimerWidth = 200;
      this.itemTimerHeight = 5;
      var timerBarX = W / 2 - this.itemTimerWidth / 2;
      var timerBarY = H * 0.38;
      this.itemTimerBg.fillStyle(hexToInt(colors.secondary), 0.1);
      this.itemTimerBg.fillRoundedRect(timerBarX, timerBarY, this.itemTimerWidth, this.itemTimerHeight, 2);
      this.itemTimerBarX = timerBarX;
      this.itemTimerBarY = timerBarY;
      this.itemTimerActive = false;
      this.itemTimerRemaining = 0;
      this.itemTimerTotal = 0;

      // ── Swipe hint arrows (animated, shown briefly) ─────────
      this.showSwipeHint(colors);

      // Mute button
      FX.audio.createMuteButton(this, { x: W - 35, y: 35, size: 18 });

      // Present first item
      this.time.delayedCall(400, function () {
        self.presentNextItem();
      });
    }

    createCategoryZones(colors, texts) {
      var zoneY = H * 0.50;
      var zoneWidth = 130;
      var zoneHeight = 280;

      // Left zone
      var leftZoneGfx = this.add.graphics().setDepth(2);
      leftZoneGfx.fillStyle(hexToInt(colors.primary), 0.06);
      leftZoneGfx.fillRoundedRect(15, zoneY - zoneHeight / 2, zoneWidth, zoneHeight, 16);
      leftZoneGfx.lineStyle(2, hexToInt(colors.primary), 0.15);
      leftZoneGfx.strokeRoundedRect(15, zoneY - zoneHeight / 2, zoneWidth, zoneHeight, 16);

      var leftLabel = this.add.text(15 + zoneWidth / 2, zoneY - zoneHeight / 2 + 24, texts.leftCategory, {
        fontSize: '14px',
        fontFamily: 'Arial',
        fontStyle: 'bold',
        color: colors.primary,
        align: 'center',
        wordWrap: { width: zoneWidth - 16 }
      }).setOrigin(0.5).setDepth(3).setAlpha(0.7);

      var leftArrow = this.add.text(15 + zoneWidth / 2, zoneY, '\u2190', {
        fontSize: '28px',
        fontFamily: 'Arial',
        color: colors.primary
      }).setOrigin(0.5).setDepth(3).setAlpha(0.2);

      this.tweens.add({
        targets: leftArrow,
        x: leftArrow.x - 8,
        alpha: { from: 0.2, to: 0.4 },
        duration: 1200,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut'
      });

      // Right zone
      var rightZoneGfx = this.add.graphics().setDepth(2);
      rightZoneGfx.fillStyle(hexToInt(colors.accent), 0.06);
      rightZoneGfx.fillRoundedRect(W - 15 - zoneWidth, zoneY - zoneHeight / 2, zoneWidth, zoneHeight, 16);
      rightZoneGfx.lineStyle(2, hexToInt(colors.accent), 0.15);
      rightZoneGfx.strokeRoundedRect(W - 15 - zoneWidth, zoneY - zoneHeight / 2, zoneWidth, zoneHeight, 16);

      var rightLabel = this.add.text(W - 15 - zoneWidth / 2, zoneY - zoneHeight / 2 + 24, texts.rightCategory, {
        fontSize: '14px',
        fontFamily: 'Arial',
        fontStyle: 'bold',
        color: colors.accent,
        align: 'center',
        wordWrap: { width: zoneWidth - 16 }
      }).setOrigin(0.5).setDepth(3).setAlpha(0.7);

      var rightArrow = this.add.text(W - 15 - zoneWidth / 2, zoneY, '\u2192', {
        fontSize: '28px',
        fontFamily: 'Arial',
        color: colors.accent
      }).setOrigin(0.5).setDepth(3).setAlpha(0.2);

      this.tweens.add({
        targets: rightArrow,
        x: rightArrow.x + 8,
        alpha: { from: 0.2, to: 0.4 },
        duration: 1200,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut'
      });

      // Store zone centers for fly-to animations
      this.leftZoneCenter = { x: 15 + zoneWidth / 2, y: zoneY };
      this.rightZoneCenter = { x: W - 15 - zoneWidth / 2, y: zoneY };
    }

    showSwipeHint(colors) {
      var hintLeft = this.add.text(W * 0.30, H * 0.55, '\u25C0', {
        fontSize: '36px', color: colors.primary
      }).setOrigin(0.5).setDepth(200).setAlpha(0);

      var hintRight = this.add.text(W * 0.70, H * 0.55, '\u25B6', {
        fontSize: '36px', color: colors.accent
      }).setOrigin(0.5).setDepth(200).setAlpha(0);

      // Animate hints in, pulse, then fade out
      this.tweens.add({
        targets: hintLeft,
        alpha: 0.5,
        x: W * 0.25,
        duration: 600,
        yoyo: true,
        hold: 400,
        ease: 'Sine.easeInOut',
        onComplete: function () { hintLeft.destroy(); }
      });

      this.tweens.add({
        targets: hintRight,
        alpha: 0.5,
        x: W * 0.75,
        duration: 600,
        yoyo: true,
        hold: 400,
        ease: 'Sine.easeInOut',
        onComplete: function () { hintRight.destroy(); }
      });
    }

    presentNextItem() {
      if (!this.gameActive) return;

      if (this.itemIndex >= this.itemQueue.length) {
        this.endGame();
        return;
      }

      var self = this;
      var colors = CONFIG.colors;
      var gameplay = CONFIG.gameplay;
      var difficulty = CONFIG.difficulty;
      var itemData = this.itemQueue[this.itemIndex];

      this.cardBusy = false;

      // Calculate difficulty ramp: reduce time per item at intervals
      var rampSteps = Math.floor(this.itemsSorted / difficulty.rampInterval);
      this.currentTimePerItem = Math.max(1500, 4000 - rampSteps * difficulty.timePerItemDecrease);

      // ── Build Item Card ─────────────────────────────────────
      var card = this.add.container(W / 2, H + 120).setDepth(50);
      this.currentCard = card;
      this.currentItemData = itemData;

      // Card background
      var cardW = 160;
      var cardH = 190;
      var cardBg = this.add.graphics();
      cardBg.fillStyle(0xffffff, 1);
      cardBg.fillRoundedRect(-cardW / 2, -cardH / 2, cardW, cardH, 16);
      cardBg.lineStyle(3, hexToInt(colors.primary), 0.2);
      cardBg.strokeRoundedRect(-cardW / 2, -cardH / 2, cardW, cardH, 16);
      card.add(cardBg);

      // Card shadow (subtle drop shadow behind)
      var cardShadow = this.add.graphics().setDepth(49);
      cardShadow.fillStyle(0x000000, 0.08);
      cardShadow.fillRoundedRect(W / 2 - cardW / 2 + 4, H * 0.50 - cardH / 2 + 6, cardW, cardH, 16);
      this.currentCardShadow = cardShadow;

      // Item sprite or colored shape
      var assetKey = itemData.key;
      if (assetKey && this.textures.exists(assetKey)) {
        var sprite = this.add.image(0, -20, assetKey);
        var maxSize = 80;
        var s = Math.min(maxSize / sprite.width, maxSize / sprite.height, 1);
        sprite.setScale(s);
        card.add(sprite);
      } else {
        // Colored shape fallback — use category color
        var shapeColor = itemData.category === 'left' ?
          hexToInt(colors.primary) : hexToInt(colors.accent);
        var shape = this.add.circle(0, -20, 35, shapeColor, 0.8);
        card.add(shape);

        // Icon text on shape (first letter)
        var iconChar = itemData.label.charAt(0).toUpperCase();
        var iconText = this.add.text(0, -20, iconChar, {
          fontSize: '28px',
          fontFamily: 'Arial',
          fontStyle: 'bold',
          color: '#FFFFFF'
        }).setOrigin(0.5);
        card.add(iconText);
      }

      // Item label
      var label = this.add.text(0, cardH / 2 - 36, itemData.label, {
        fontSize: '18px',
        fontFamily: 'Arial',
        fontStyle: 'bold',
        color: colors.secondary,
        align: 'center',
        wordWrap: { width: cardW - 20 }
      }).setOrigin(0.5);
      label.setShadow(1, 1, 'rgba(0,0,0,0.1)', 2);
      card.add(label);

      // ── Slide card in from bottom with bounce ───────────────
      var targetY = H * 0.50;
      this.tweens.add({
        targets: card,
        y: targetY,
        duration: 400,
        ease: 'Back.easeOut',
        onComplete: function () {
          // Start item timer
          self.startItemTimer();
          // Enable drag
          self.enableCardDrag(card, itemData);
        }
      });

      // Shadow slides in too
      cardShadow.setAlpha(0);
      this.tweens.add({
        targets: cardShadow,
        alpha: 1,
        duration: 400,
        ease: 'Power2'
      });

      // Update progress bar
      this.itemProgress.setProgress(this.itemIndex / this.itemQueue.length);
    }

    startItemTimer() {
      var self = this;
      var colors = CONFIG.colors;

      this.itemTimerRemaining = this.currentTimePerItem;
      this.itemTimerTotal = this.currentTimePerItem;
      this.itemTimerActive = true;

      // Redraw timer fill each 50ms
      if (this.itemTimerEvent) this.itemTimerEvent.remove(false);
      this.itemTimerEvent = this.time.addEvent({
        delay: 50,
        callback: function () {
          if (!self.itemTimerActive) return;
          self.itemTimerRemaining -= 50;
          var pct = Math.max(0, self.itemTimerRemaining / self.itemTimerTotal);

          self.itemTimerFill.clear();
          var fillW = pct * self.itemTimerWidth;
          if (fillW > 0) {
            var fillColor = pct > 0.3 ? hexToInt(colors.primary) : hexToInt('#EF4444');
            self.itemTimerFill.fillStyle(fillColor, 0.6);
            self.itemTimerFill.fillRoundedRect(
              self.itemTimerBarX, self.itemTimerBarY,
              fillW, self.itemTimerHeight, 2
            );
          }

          if (self.itemTimerRemaining <= 0) {
            self.itemTimerActive = false;
            self.onItemTimeout();
          }
        },
        loop: true
      });
    }

    stopItemTimer() {
      this.itemTimerActive = false;
      if (this.itemTimerEvent) this.itemTimerEvent.remove(false);
      this.itemTimerFill.clear();
    }

    onItemTimeout() {
      if (this.cardBusy || !this.gameActive) return;
      this.cardBusy = true;

      var self = this;
      var colors = CONFIG.colors;

      // Timeout = wrong sort (no streak, camera shake)
      this.streak = 0;
      this.updateStreakDisplay();

      FX.effects.screenShake(this, 0.006, 60);
      this.cameras.main.flash(60, 239, 68, 68, true);
      FX.audio.playFail();

      // Card falls down and fades
      if (this.currentCard) {
        this.tweens.add({
          targets: this.currentCard,
          y: H + 150,
          alpha: 0,
          angle: Phaser.Math.Between(-15, 15),
          duration: 400,
          ease: 'Power2',
          onComplete: function () {
            if (self.currentCard) self.currentCard.destroy();
            if (self.currentCardShadow) self.currentCardShadow.destroy();
            self.itemIndex++;
            self.time.delayedCall(200, function () { self.presentNextItem(); });
          }
        });
      }
    }

    enableCardDrag(card, itemData) {
      if (!this.gameActive) return;
      var self = this;
      var colors = CONFIG.colors;
      var gameplay = CONFIG.gameplay;
      var startX = card.x;
      var startY = card.y;
      var dragging = false;
      var pointerStartX = 0;

      // Invisible hit area over the card
      var hitArea = this.add.rectangle(card.x, card.y, 180, 220, 0x000000, 0)
        .setInteractive({ draggable: true }).setDepth(55);
      this.currentHitArea = hitArea;

      hitArea.on('dragstart', function (pointer) {
        if (self.cardBusy) return;
        dragging = true;
        pointerStartX = pointer.x;
      });

      hitArea.on('drag', function (pointer, dragX, dragY) {
        if (!dragging || self.cardBusy) return;

        var dx = dragX - startX;
        card.x = dragX;
        hitArea.x = dragX;

        // Tilt card based on drag direction
        card.angle = Phaser.Math.Clamp(dx * 0.08, -15, 15);

        // Update shadow position
        if (self.currentCardShadow) {
          self.currentCardShadow.x = dx + 4;
        }

        // Visual feedback: tint category zones
        var threshold = gameplay.swipeThreshold;
        if (dx < -threshold * 0.5) {
          card.setAlpha(1 - Math.abs(dx) / (W * 0.6) * 0.3);
        } else if (dx > threshold * 0.5) {
          card.setAlpha(1 - Math.abs(dx) / (W * 0.6) * 0.3);
        } else {
          card.setAlpha(1);
        }
      });

      hitArea.on('dragend', function (pointer) {
        if (!dragging || self.cardBusy) return;
        dragging = false;

        var dx = card.x - startX;
        var threshold = gameplay.swipeThreshold;

        if (dx < -threshold) {
          // Sorted LEFT
          self.handleSort('left', itemData, card);
        } else if (dx > threshold) {
          // Sorted RIGHT
          self.handleSort('right', itemData, card);
        } else {
          // Didn't pass threshold — bounce back
          self.tweens.add({
            targets: [card, hitArea],
            x: startX,
            duration: 300,
            ease: 'Back.easeOut'
          });
          self.tweens.add({
            targets: card,
            angle: 0,
            alpha: 1,
            duration: 300,
            ease: 'Power2'
          });
          if (self.currentCardShadow) {
            self.tweens.add({
              targets: self.currentCardShadow,
              x: 0,
              duration: 300,
              ease: 'Power2'
            });
          }
        }
      });
    }

    handleSort(direction, itemData, card) {
      if (this.cardBusy || !this.gameActive) return;
      this.cardBusy = true;
      this.stopItemTimer();

      var self = this;
      var colors = CONFIG.colors;
      var gameplay = CONFIG.gameplay;
      var texts = CONFIG.texts;
      var isCorrect = (itemData.category === direction);

      if (isCorrect) {
        this.onCorrectSort(direction, card);
      } else {
        this.onWrongSort(direction, card);
      }
    }

    onCorrectSort(direction, card) {
      var self = this;
      var colors = CONFIG.colors;
      var gameplay = CONFIG.gameplay;
      var texts = CONFIG.texts;

      // Update streak
      this.streak++;
      this.updateStreakDisplay();

      // Calculate points
      var points = gameplay.pointsPerSort + (this.streak > 1 ? (this.streak - 1) * gameplay.streakBonus : 0);
      this.score += points;
      this.scoreDisplay.add(points);
      this.itemsSorted++;

      // Target zone
      var target = direction === 'left' ? this.leftZoneCenter : this.rightZoneCenter;
      var zoneColor = direction === 'left' ? colors.primary : colors.accent;

      // Score popup
      var popupText = '+' + points;
      if (this.streak > 1) popupText += ' x' + this.streak;
      FX.effects.scorePopup(this, card.x, card.y - 60, popupText, colors.accent);

      // Sparkle burst at card position
      FX.effects.sparkleBurst(this, card.x, card.y, zoneColor, 10);

      // Trail particles as card flies to zone
      var trail = FX.effects.trailParticles(this, card, zoneColor);

      // Fly card to category zone
      this.tweens.add({
        targets: card,
        x: target.x,
        y: target.y,
        scale: 0.3,
        alpha: 0,
        angle: direction === 'left' ? -25 : 25,
        duration: 350,
        ease: 'Power3',
        onComplete: function () {
          trail.destroy();
          card.destroy();
          if (self.currentCardShadow) self.currentCardShadow.destroy();
          if (self.currentHitArea) self.currentHitArea.destroy();

          // Sparkle at destination
          FX.effects.sparkleBurst(self, target.x, target.y, zoneColor, 6);
        }
      });

      FX.audio.playScore();

      // Encouragement message on streaks
      if (this.streak > 0 && this.streak % 3 === 0 && texts.encouragement) {
        var msg = texts.encouragement[Phaser.Math.Between(0, texts.encouragement.length - 1)];
        var enc = this.add.text(W / 2, H * 0.35, msg, {
          fontSize: '32px', fontFamily: 'Arial', fontStyle: 'bold',
          color: colors.accent, stroke: colors.secondary, strokeThickness: 3
        }).setOrigin(0.5).setDepth(200).setScale(0);

        this.tweens.add({
          targets: enc,
          scale: 1.2,
          alpha: { from: 1, to: 0 },
          y: H * 0.30,
          duration: 1000,
          ease: 'Power2',
          onComplete: function () { enc.destroy(); }
        });
      }

      // Next item
      this.itemIndex++;
      this.time.delayedCall(350, function () {
        self.presentNextItem();
      });
    }

    onWrongSort(direction, card) {
      var self = this;
      var colors = CONFIG.colors;

      // Reset streak
      this.streak = 0;
      this.updateStreakDisplay();

      // Camera shake + red flash
      FX.effects.screenShake(this, 0.012, 120);
      this.cameras.main.flash(100, 239, 68, 68, true);
      FX.audio.playFail();

      // Red X indicator
      var wrongX = this.add.text(card.x, card.y - 50, '\u2716', {
        fontSize: '40px', color: '#EF4444'
      }).setOrigin(0.5).setDepth(300).setScale(0);

      this.tweens.add({
        targets: wrongX,
        scale: 1.5,
        alpha: { from: 1, to: 0 },
        y: card.y - 90,
        duration: 600,
        ease: 'Power2',
        onComplete: function () { wrongX.destroy(); }
      });

      // Bounce card back to center
      var startX = W / 2;
      this.tweens.add({
        targets: card,
        x: startX,
        angle: 0,
        alpha: 1,
        duration: 400,
        ease: 'Bounce.easeOut',
        onComplete: function () {
          if (self.currentCardShadow) {
            self.currentCardShadow.x = 0;
          }
          if (self.currentHitArea) {
            self.currentHitArea.x = startX;
          }
          self.cardBusy = false;
          // Restart item timer for another attempt
          self.startItemTimer();
        }
      });

      // Red border flash on card
      var flashOverlay = this.add.graphics().setDepth(55);
      flashOverlay.lineStyle(4, 0xEF4444, 0.8);
      flashOverlay.strokeRoundedRect(-80, -95, 160, 190, 16);
      card.add(flashOverlay);

      this.tweens.add({
        targets: flashOverlay,
        alpha: 0,
        duration: 400,
        onComplete: function () { flashOverlay.destroy(); }
      });
    }

    updateStreakDisplay() {
      this.streakText.setText(this.streak);
      if (this.streak >= 2) {
        this.streakContainer.setAlpha(1);
        FX.effects.scalePunch(this, this.streakContainer, 1.2, 150);
      } else if (this.streak === 0) {
        this.tweens.add({
          targets: this.streakContainer,
          alpha: 0,
          duration: 200
        });
      }
    }

    endGame() {
      if (!this.gameActive) return;
      this.gameActive = false;
      this.stopItemTimer();
      this.timer.stop();

      FX.audio.playWhoosh();

      var self = this;

      // Fly current card off screen if present
      if (this.currentCard && this.currentCard.active) {
        this.tweens.add({
          targets: this.currentCard,
          y: H + 200,
          alpha: 0,
          duration: 300,
          ease: 'Power2'
        });
      }
      if (this.currentCardShadow) {
        this.tweens.add({
          targets: this.currentCardShadow,
          alpha: 0,
          duration: 300
        });
      }
      if (this.currentHitArea) {
        this.currentHitArea.disableInteractive();
      }

      this.time.delayedCall(400, function () {
        var transition = CONFIG.theme.transitionStyle;
        var data = {
          score: self.score,
          itemsSorted: self.itemsSorted,
          totalItems: self.itemQueue.length,
          bestStreak: self.streak
        };
        if (transition === 'zoom') {
          FX.transitions.zoomOut(self, 'EndScene', data);
        } else if (transition === 'flash') {
          FX.transitions.flashTransition(self, 'EndScene', data);
        } else {
          FX.transitions.cinematicFade(self, 'EndScene', data);
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
      var itemsSorted = data.itemsSorted || 0;
      var totalItems = data.totalItems || 1;

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

      // Accuracy stat
      var accuracy = totalItems > 0 ? Math.round((itemsSorted / totalItems) * 100) : 0;
      var accText = this.add.text(W / 2, H * 0.42, itemsSorted + '/' + totalItems + ' sorted  \u00B7  ' + accuracy + '% accuracy', {
        fontSize: '16px', fontFamily: 'Arial', color: colors.secondary
      }).setOrigin(0.5).setDepth(10).setAlpha(0);

      this.tweens.add({
        targets: accText,
        alpha: 0.6,
        duration: 500,
        delay: 1600
      });

      // Star rating based on accuracy
      var pct = itemsSorted / totalItems;
      var starCount = pct >= 0.85 ? 3 : pct >= 0.5 ? 2 : 1;

      var stars = FX.ui.StarRating(this, W / 2, H * 0.50, {
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
          FX.effects.confettiBurst(this, W / 2, H * 0.45,
            [colors.primary, colors.accent, colors.secondary, '#FFFFFF'], 50);
          FX.audio.playSuccess();
        }.bind(this));
      }

      // Logo (if available)
      var logoKey = CONFIG.assets.logo;
      if (logoKey && this.textures.exists(logoKey)) {
        var logo = this.add.image(W / 2, H * 0.61, logoKey).setDepth(10);
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
      var ctaBtn = FX.ui.CTAButton(this, W / 2, H * 0.74, texts.cta || 'Learn More', {
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
      var playAgain = this.add.text(W / 2, H * 0.86, texts.playAgain || 'Play Again', {
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
