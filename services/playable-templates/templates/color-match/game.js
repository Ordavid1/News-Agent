/**
 * COLOR MATCH MEMORY — Premium Hybrid Template
 *
 * A polished memory card matching game using the brand's color palette.
 * Players flip face-down cards to find matching color pairs before time
 * runs out, with smooth 3D-like flip animations and premium visual polish.
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
   * Generates a shuffled array of color pairs for the card grid.
   * Uses brand colors and procedurally derived complementary shades
   * to fill the required number of pairs.
   */
  function generateCardColors(numPairs, brandColors) {
    // Start with distinct brand colors
    var baseColors = [
      brandColors.primary,
      brandColors.accent,
      brandColors.secondary
    ];

    // Generate additional harmonious colors derived from brand palette
    var extraColors = [
      shiftHue(brandColors.primary, 40),
      shiftHue(brandColors.primary, -40),
      shiftHue(brandColors.accent, 60),
      shiftHue(brandColors.accent, -60),
      shiftHue(brandColors.primary, 120),
      shiftHue(brandColors.accent, 120),
      shiftHue(brandColors.secondary, 80),
      shiftHue(brandColors.primary, 180),
      shiftHue(brandColors.accent, -120)
    ];

    var palette = baseColors.concat(extraColors);

    // Pick the needed number of unique colors
    var selected = [];
    for (var i = 0; i < numPairs && i < palette.length; i++) {
      selected.push(palette[i]);
    }

    // If we still need more, generate random saturated colors
    while (selected.length < numPairs) {
      var hue = Math.round((selected.length / numPairs) * 360);
      selected.push(hslToHex(hue, 70, 55));
    }

    // Create pairs and shuffle
    var cards = [];
    for (var j = 0; j < selected.length; j++) {
      cards.push(selected[j], selected[j]);
    }

    return shuffleArray(cards);
  }

  /**
   * Shifts a hex color's hue by the given degrees.
   */
  function shiftHue(hex, degrees) {
    var rgb = hexToRgb(hex);
    var hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
    hsl.h = ((hsl.h + degrees) % 360 + 360) % 360;
    // Ensure good saturation and lightness for card visibility
    hsl.s = Math.max(45, Math.min(85, hsl.s));
    hsl.l = Math.max(35, Math.min(65, hsl.l));
    return hslToHex(hsl.h, hsl.s, hsl.l);
  }

  function hexToRgb(hex) {
    var c = parseInt(hex.replace('#', ''), 16);
    return { r: (c >> 16) & 255, g: (c >> 8) & 255, b: c & 255 };
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
        case g: h = ((b - r) / d + 2); break;
        case b: h = ((r - g) / d + 4); break;
      }
      h *= 60;
    }
    return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
  }

  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs((h / 60) % 2 - 1));
    var m = l - c / 2;
    var r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    r = Math.round((r + m) * 255);
    g = Math.round((g + m) * 255);
    b = Math.round((b + m) * 255);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1).toUpperCase();
  }

  function shuffleArray(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = a[i];
      a[i] = a[j];
      a[j] = tmp;
    }
    return a;
  }

  /**
   * Darkens a hex color by a percentage (0-100).
   */
  function darkenHex(hex, percent) {
    var rgb = hexToRgb(hex);
    var factor = 1 - (percent / 100);
    var r = Math.round(rgb.r * factor);
    var g = Math.round(rgb.g * factor);
    var b = Math.round(rgb.b * factor);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1).toUpperCase();
  }

  /**
   * Lightens a hex color by a percentage (0-100).
   */
  function lightenHex(hex, percent) {
    var rgb = hexToRgb(hex);
    var factor = percent / 100;
    var r = Math.round(rgb.r + (255 - rgb.r) * factor);
    var g = Math.round(rgb.g + (255 - rgb.g) * factor);
    var b = Math.round(rgb.b + (255 - rgb.b) * factor);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1).toUpperCase();
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

      // Decorative card preview — show 4 mini cards fanned in the splash
      this._createSplashCards(colors);

      // Logo (if available)
      var logoKey = CONFIG.assets.logo;
      if (logoKey && this.textures.exists(logoKey)) {
        var logo = this.add.image(W / 2, H * 0.26, logoKey).setDepth(10);
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
        FX.effects.glowRing(this, W / 2, H * 0.26, 90, colors.primary);
      }

      // Title text
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

    /**
     * Creates decorative mini card previews on the splash screen.
     */
    _createSplashCards(colors) {
      var cardColors = [colors.primary, colors.accent, colors.primary, colors.accent];
      var startX = W / 2 - 90;
      var y = H * 0.64;

      for (var i = 0; i < 4; i++) {
        var container = this.add.container(startX + i * 60, y).setDepth(8);
        var angle = -12 + i * 8;

        // Card shadow
        var shadow = this.add.graphics();
        shadow.fillStyle(0x000000, 0.1);
        shadow.fillRoundedRect(-24, -32, 48, 64, 8);
        shadow.setPosition(3, 3);
        container.add(shadow);

        // Card body
        var bg = this.add.graphics();
        bg.fillStyle(hexToInt(colors.background), 1);
        bg.fillRoundedRect(-24, -32, 48, 64, 8);
        container.add(bg);

        // Card border
        var border = this.add.graphics();
        border.lineStyle(2, hexToInt(colors.primary), 0.3);
        border.strokeRoundedRect(-24, -32, 48, 64, 8);
        container.add(border);

        // Color swatch on face
        var swatch = this.add.graphics();
        swatch.fillStyle(hexToInt(cardColors[i]), 1);
        swatch.fillRoundedRect(-14, -18, 28, 36, 6);
        container.add(swatch);

        container.setAngle(angle).setScale(0);

        this.tweens.add({
          targets: container,
          scale: 1,
          duration: 500,
          ease: 'Back.easeOut',
          delay: 700 + i * 100
        });

        FX.effects.floatIdle(this, container, 4 + i * 2);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // GAME SCENE — Memory card matching gameplay
  // ═══════════════════════════════════════════════════════════
  class GameScene extends Phaser.Scene {
    constructor() { super('GameScene'); }

    create() {
      var self = this;
      FX.transitions.fadeIn(this);

      var colors = CONFIG.colors;
      var gameplay = CONFIG.gameplay;

      this.score = 0;
      this.matchesFound = 0;
      this.gameActive = false; // Will be set true after optional preview
      this.isFlipping = false; // Lock during flip animations
      this.flippedCards = []; // Currently face-up cards (0, 1, or 2)
      this.matchedPairs = []; // Indices of matched cards

      var cols = gameplay.gridCols || 4;
      var rows = gameplay.gridRows || 3;
      this.totalPairs = Math.floor((cols * rows) / 2);
      var totalCards = this.totalPairs * 2;

      // Generate card color assignments
      this.cardColors = generateCardColors(this.totalPairs, colors);
      // Trim to exact card count needed (in case grid is odd, drop last)
      this.cardColors = this.cardColors.slice(0, totalCards);

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

      // Timer
      this.timer = FX.ui.CircularTimer(this, 56, 50, {
        radius: 24,
        thickness: 5,
        fillColor: colors.primary,
        textColor: colors.secondary
      });
      this.timer.onComplete = function () {
        self.endGame(false);
      };

      // Matches progress indicator
      this.matchLabel = this.add.text(W - 56, 42, '0/' + this.totalPairs, {
        fontSize: '18px',
        fontFamily: 'Arial',
        fontStyle: 'bold',
        color: colors.secondary
      }).setOrigin(0.5).setDepth(100).setAlpha(0.7);

      var matchIcon = this.add.text(W - 56, 22, '\u2B50', {
        fontSize: '14px'
      }).setOrigin(0.5).setDepth(100).setAlpha(0.6);

      // Build card grid
      this.cards = [];
      this._buildGrid(cols, rows, totalCards, colors, gameplay);

      // Mute button
      FX.audio.createMuteButton(this, { x: W - 35, y: 88, size: 18 });

      // Handle optional card preview
      var previewDuration = CONFIG.difficulty.previewDuration || 0;
      if (previewDuration > 0) {
        // Briefly show all card faces
        this._revealAllCards();
        this.time.delayedCall(previewDuration, function () {
          self._hideAllCards(function () {
            self.gameActive = true;
            self.timer.start(gameplay.duration);
          });
        });
      } else {
        this.gameActive = true;
        this.timer.start(gameplay.duration);
      }
    }

    /**
     * Builds the card grid layout centered on screen.
     */
    _buildGrid(cols, rows, totalCards, colors, gameplay) {
      var self = this;

      // Calculate card dimensions to fit the available area
      var gridTop = 100;
      var gridBottom = H - 60;
      var gridLeft = 30;
      var gridRight = W - 30;
      var availW = gridRight - gridLeft;
      var availH = gridBottom - gridTop;

      var gapX = 12;
      var gapY = 12;
      var cardW = Math.floor((availW - (cols - 1) * gapX) / cols);
      var cardH = Math.floor((availH - (rows - 1) * gapY) / rows);

      // Clamp to reasonable aspect ratio (roughly 3:4)
      var maxCardW = 130;
      var maxCardH = 170;
      cardW = Math.min(cardW, maxCardW);
      cardH = Math.min(cardH, maxCardH);

      // Center the grid
      var totalGridW = cols * cardW + (cols - 1) * gapX;
      var totalGridH = rows * cardH + (rows - 1) * gapY;
      var offsetX = (W - totalGridW) / 2 + cardW / 2;
      var offsetY = gridTop + (availH - totalGridH) / 2 + cardH / 2;

      this.cardWidth = cardW;
      this.cardHeight = cardH;

      for (var idx = 0; idx < totalCards; idx++) {
        var col = idx % cols;
        var row = Math.floor(idx / cols);
        var cx = offsetX + col * (cardW + gapX);
        var cy = offsetY + row * (cardH + gapY);

        var card = this._createCard(idx, cx, cy, cardW, cardH, this.cardColors[idx], colors);
        this.cards.push(card);

        // Staggered entrance animation
        card.container.setScale(0).setAlpha(0);
        this.tweens.add({
          targets: card.container,
          scale: 1,
          alpha: 1,
          duration: 400,
          ease: 'Back.easeOut',
          delay: 80 + idx * 50
        });
      }
    }

    /**
     * Creates a single memory card with back and face graphics.
     * Returns a card descriptor object.
     */
    _createCard(index, x, y, w, h, faceColor, brandColors) {
      var self = this;
      var container = this.add.container(x, y).setDepth(10);

      // Drop shadow
      var shadow = this.add.graphics();
      shadow.fillStyle(0x000000, 0.08);
      shadow.fillRoundedRect(-w / 2 + 3, -h / 2 + 3, w, h, 12);
      container.add(shadow);

      // === CARD BACK (visible when face-down) ===
      var backGroup = this.add.container(0, 0);

      // Back base
      var backBg = this.add.graphics();
      backBg.fillStyle(hexToInt(brandColors.primary), 1);
      backBg.fillRoundedRect(-w / 2, -h / 2, w, h, 12);
      backGroup.add(backBg);

      // Back border glow
      var backBorder = this.add.graphics();
      backBorder.lineStyle(2, 0xffffff, 0.25);
      backBorder.strokeRoundedRect(-w / 2, -h / 2, w, h, 12);
      backGroup.add(backBorder);

      // Back pattern — diamond pattern for premium look
      var pattern = this.add.graphics();
      var patternColor = hexToInt(lightenHex(brandColors.primary, 15));
      pattern.fillStyle(patternColor, 0.15);
      var diamondSize = Math.min(w, h) * 0.12;
      for (var py = -h / 2 + diamondSize * 2; py < h / 2 - diamondSize; py += diamondSize * 2.5) {
        for (var px = -w / 2 + diamondSize * 2; px < w / 2 - diamondSize; px += diamondSize * 2.5) {
          pattern.fillPoints([
            { x: px, y: py - diamondSize },
            { x: px + diamondSize, y: py },
            { x: px, y: py + diamondSize },
            { x: px - diamondSize, y: py }
          ], true);
        }
      }
      backGroup.add(pattern);

      // Back center emblem — use cardBack asset if available, otherwise a stylized question mark
      var cardBackKey = CONFIG.assets.cardBack;
      if (cardBackKey && this.textures.exists(cardBackKey)) {
        var backImg = this.add.image(0, 0, cardBackKey);
        var maxDim = Math.min(w, h) * 0.5;
        var imgScale = Math.min(maxDim / backImg.width, maxDim / backImg.height, 1);
        backImg.setScale(imgScale).setAlpha(0.6);
        backGroup.add(backImg);
      } else {
        var emblem = this.add.text(0, 0, '?', {
          fontSize: Math.round(Math.min(w, h) * 0.4) + 'px',
          fontFamily: 'Arial',
          fontStyle: 'bold',
          color: '#FFFFFF'
        }).setOrigin(0.5).setAlpha(0.4);
        backGroup.add(emblem);
      }

      container.add(backGroup);

      // === CARD FACE (visible when face-up) ===
      var faceGroup = this.add.container(0, 0);
      faceGroup.setScale(0, 1); // Hidden via scaleX = 0

      // Face base (lighter than background)
      var faceBg = this.add.graphics();
      faceBg.fillStyle(hexToInt(lightenHex(brandColors.background, 5)), 1);
      faceBg.fillRoundedRect(-w / 2, -h / 2, w, h, 12);
      faceGroup.add(faceBg);

      // Face border
      var faceBorder = this.add.graphics();
      faceBorder.lineStyle(2, hexToInt(faceColor), 0.4);
      faceBorder.strokeRoundedRect(-w / 2, -h / 2, w, h, 12);
      faceGroup.add(faceBorder);

      // Color swatch — the main identifiable element
      var swatchPadding = Math.min(w, h) * 0.18;
      var swatchW = w - swatchPadding * 2;
      var swatchH = h - swatchPadding * 2;
      var swatch = this.add.graphics();
      swatch.fillStyle(hexToInt(faceColor), 1);
      swatch.fillRoundedRect(-swatchW / 2, -swatchH / 2, swatchW, swatchH, 10);
      faceGroup.add(swatch);

      // Subtle inner highlight on the swatch
      var highlight = this.add.graphics();
      highlight.fillStyle(0xffffff, 0.12);
      highlight.fillRoundedRect(-swatchW / 2 + 4, -swatchH / 2 + 4, swatchW - 8, swatchH * 0.4, 8);
      faceGroup.add(highlight);

      container.add(faceGroup);

      // Interactive hit area
      var hitZone = this.add.rectangle(0, 0, w, h, 0x000000, 0)
        .setInteractive({ useHandCursor: true });
      container.add(hitZone);

      var card = {
        index: index,
        container: container,
        backGroup: backGroup,
        faceGroup: faceGroup,
        faceColor: faceColor,
        hitZone: hitZone,
        isRevealed: false,
        isMatched: false
      };

      hitZone.on('pointerdown', function () {
        self._onCardTap(card);
      });

      // Hover feedback
      hitZone.on('pointerover', function () {
        if (!card.isRevealed && !card.isMatched && self.gameActive) {
          self.tweens.add({
            targets: container,
            scale: 1.05,
            duration: 100,
            ease: 'Quad.easeOut'
          });
        }
      });
      hitZone.on('pointerout', function () {
        if (!card.isRevealed && !card.isMatched) {
          self.tweens.add({
            targets: container,
            scale: 1,
            duration: 100,
            ease: 'Quad.easeOut'
          });
        }
      });

      return card;
    }

    /**
     * Handles tapping a card — flip logic and match checking.
     */
    _onCardTap(card) {
      if (!this.gameActive) return;
      if (this.isFlipping) return;
      if (card.isRevealed) return;
      if (card.isMatched) return;
      if (this.flippedCards.length >= 2) return;

      FX.audio.playTap();
      this._flipCardUp(card);
      this.flippedCards.push(card);

      if (this.flippedCards.length === 2) {
        this.isFlipping = true;
        var self = this;
        var cardA = this.flippedCards[0];
        var cardB = this.flippedCards[1];

        // Check match after a brief pause for player to see
        this.time.delayedCall(350, function () {
          if (cardA.faceColor === cardB.faceColor) {
            self._handleMatch(cardA, cardB);
          } else {
            self._handleMismatch(cardA, cardB);
          }
        });
      }
    }

    /**
     * Flips a card face-up using a 3D-like scaleX tween (1 -> 0, swap graphics, 0 -> 1).
     */
    _flipCardUp(card) {
      var self = this;
      card.isRevealed = true;

      // Phase 1: Scale back to 0 horizontally
      this.tweens.add({
        targets: card.backGroup,
        scaleX: 0,
        duration: 150,
        ease: 'Quad.easeIn',
        onComplete: function () {
          card.backGroup.setVisible(false);
          // Phase 2: Scale face from 0 to 1
          card.faceGroup.setScale(0, 1).setVisible(true);
          self.tweens.add({
            targets: card.faceGroup,
            scaleX: 1,
            duration: 150,
            ease: 'Quad.easeOut'
          });
        }
      });
    }

    /**
     * Flips a card face-down (reverse of flipCardUp).
     */
    _flipCardDown(card, callback) {
      var self = this;
      card.isRevealed = false;

      // Phase 1: Scale face to 0
      this.tweens.add({
        targets: card.faceGroup,
        scaleX: 0,
        duration: 150,
        ease: 'Quad.easeIn',
        onComplete: function () {
          card.faceGroup.setVisible(false);
          // Phase 2: Scale back from 0 to 1
          card.backGroup.setVisible(true).setScaleX(0);
          self.tweens.add({
            targets: card.backGroup,
            scaleX: 1,
            duration: 150,
            ease: 'Quad.easeOut',
            onComplete: function () {
              if (callback) callback();
            }
          });
        }
      });
    }

    /**
     * Handles a successful match — sparkle effects, score, check win condition.
     */
    _handleMatch(cardA, cardB) {
      var self = this;
      var colors = CONFIG.colors;
      var texts = CONFIG.texts;
      var gameplay = CONFIG.gameplay;

      cardA.isMatched = true;
      cardB.isMatched = true;
      this.matchesFound++;

      // Score
      var points = gameplay.pointsPerMatch;
      this.score += points;
      this.scoreDisplay.add(points);

      // Update match counter
      this.matchLabel.setText(this.matchesFound + '/' + this.totalPairs);

      // Score popups
      FX.effects.scorePopup(this, cardA.container.x, cardA.container.y - 20, '+' + points, colors.accent);

      // Sparkle bursts on both cards
      FX.effects.sparkleBurst(this, cardA.container.x, cardA.container.y, colors.accent, 10);
      FX.effects.sparkleBurst(this, cardB.container.x, cardB.container.y, colors.accent, 10);

      // Scale punch both cards
      FX.effects.scalePunch(this, cardA.container, 1.12, 150);
      FX.effects.scalePunch(this, cardB.container, 1.12, 150);

      // Match sound
      FX.audio.playScore();

      // Encouragement message
      if (texts.matchMessage && texts.matchMessage.length > 0) {
        var msg = texts.matchMessage[Phaser.Math.Between(0, texts.matchMessage.length - 1)];
        var enc = this.add.text(W / 2, H * 0.45, msg, {
          fontSize: '32px', fontFamily: 'Arial', fontStyle: 'bold',
          color: colors.accent, stroke: colors.secondary, strokeThickness: 3
        }).setOrigin(0.5).setDepth(200).setScale(0);

        this.tweens.add({
          targets: enc,
          scale: 1.2,
          alpha: { from: 1, to: 0 },
          y: H * 0.40,
          duration: 1000,
          ease: 'Power2',
          onComplete: function () { enc.destroy(); }
        });
      }

      // Bonus time
      if (gameplay.bonusTimePerMatch > 0 && this.timer.isRunning()) {
        var currentRemaining = this.timer.getRemaining();
        this.timer.stop();
        this.timer.start(currentRemaining + gameplay.bonusTimePerMatch);

        // Visual bonus time indicator
        var bonusText = this.add.text(56, 80, '+' + gameplay.bonusTimePerMatch + 's', {
          fontSize: '16px', fontFamily: 'Arial', fontStyle: 'bold',
          color: '#22C55E'
        }).setOrigin(0.5).setDepth(200);

        this.tweens.add({
          targets: bonusText,
          y: 65,
          alpha: { from: 1, to: 0 },
          duration: 800,
          ease: 'Power2',
          onComplete: function () { bonusText.destroy(); }
        });
      }

      // Matched cards: subtle glow then reduce opacity slightly
      this.time.delayedCall(300, function () {
        self.tweens.add({
          targets: [cardA.container, cardB.container],
          alpha: 0.65,
          duration: 400,
          ease: 'Sine.easeOut'
        });
      });

      // Clear flipped array and unlock
      this.flippedCards = [];
      this.isFlipping = false;

      // Check win condition
      if (this.matchesFound >= this.totalPairs) {
        this.time.delayedCall(500, function () {
          self.endGame(true);
        });
      }
    }

    /**
     * Handles a mismatch — brief show then flip both cards back.
     */
    _handleMismatch(cardA, cardB) {
      var self = this;
      var colors = CONFIG.colors;
      var texts = CONFIG.texts;
      var difficulty = CONFIG.difficulty;
      var gameplay = CONFIG.gameplay;
      var flipBackDelay = gameplay.flipBackDelay || 800;

      // Camera shake (subtle)
      FX.effects.screenShake(this, 0.005, 60);

      // Red flash (subtle)
      this.cameras.main.flash(60, 239, 68, 68, true);

      FX.audio.playFail();

      // Show no-match message briefly
      if (texts.noMatchMessage) {
        var noMsg = this.add.text(W / 2, H * 0.45, texts.noMatchMessage, {
          fontSize: '22px', fontFamily: 'Arial', fontStyle: 'bold',
          color: '#EF4444', stroke: '#000000', strokeThickness: 2
        }).setOrigin(0.5).setDepth(200).setAlpha(0);

        this.tweens.add({
          targets: noMsg,
          alpha: { from: 0.8, to: 0 },
          y: H * 0.42,
          duration: 700,
          ease: 'Power2',
          onComplete: function () { noMsg.destroy(); }
        });
      }

      // Penalty
      if (difficulty.penaltyOnMiss > 0) {
        this.score = Math.max(0, this.score - difficulty.penaltyOnMiss);
        this.scoreDisplay.set(this.score);
        FX.effects.scorePopup(this, W / 2, H * 0.35, '-' + difficulty.penaltyOnMiss, '#EF4444');
      }

      // After delay, flip both cards back
      this.time.delayedCall(flipBackDelay, function () {
        var done = 0;
        var total = 2;
        function onDone() {
          done++;
          if (done >= total) {
            self.flippedCards = [];
            self.isFlipping = false;
          }
        }
        self._flipCardDown(cardA, onDone);
        self._flipCardDown(cardB, onDone);
      });
    }

    /**
     * Reveals all cards simultaneously (for preview at game start).
     */
    _revealAllCards() {
      var self = this;
      for (var i = 0; i < this.cards.length; i++) {
        var card = this.cards[i];
        card.isRevealed = true;
        card.backGroup.setVisible(false);
        card.faceGroup.setScale(1, 1).setVisible(true);
      }
    }

    /**
     * Hides all non-matched cards (flip them back to face-down).
     */
    _hideAllCards(callback) {
      var self = this;
      var done = 0;
      var toHide = [];

      for (var i = 0; i < this.cards.length; i++) {
        if (!this.cards[i].isMatched) {
          toHide.push(this.cards[i]);
        }
      }

      if (toHide.length === 0) {
        if (callback) callback();
        return;
      }

      for (var j = 0; j < toHide.length; j++) {
        (function (card, idx) {
          self.time.delayedCall(idx * 30, function () {
            self._flipCardDown(card, function () {
              done++;
              if (done >= toHide.length && callback) {
                callback();
              }
            });
          });
        })(toHide[j], j);
      }
    }

    /**
     * Ends the game — triggers transition to EndScene.
     */
    endGame(won) {
      if (!this.gameActive) return;
      this.gameActive = false;
      this.timer.stop();

      FX.audio.playWhoosh();

      var self = this;
      var timeRemaining = this.timer.getRemaining();

      // Flip all unmatched cards face-up as a reveal
      for (var i = 0; i < this.cards.length; i++) {
        if (!this.cards[i].isMatched && !this.cards[i].isRevealed) {
          (function (card, delay) {
            self.time.delayedCall(delay, function () {
              self._flipCardUp(card);
            });
          })(this.cards[i], i * 40);
        }
      }

      this.time.delayedCall(600, function () {
        var transition = CONFIG.theme.transitionStyle;
        var data = {
          score: self.score,
          won: won,
          matchesFound: self.matchesFound,
          totalPairs: self.totalPairs,
          timeRemaining: timeRemaining
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
      var won = data.won || false;
      var matchesFound = data.matchesFound || 0;
      var totalPairs = data.totalPairs || 0;
      var timeRemaining = data.timeRemaining || 0;

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

      // Headline
      var headline = won
        ? (texts.winMessage || 'You Did It!')
        : (texts.timeUpMessage || "Time's Up!");

      var title = this.add.text(W / 2, H * 0.16, headline, {
        fontSize: '38px', fontFamily: 'Arial', fontStyle: 'bold',
        color: colors.secondary
      }).setOrigin(0.5).setDepth(10);
      title.setShadow(2, 2, 'rgba(0,0,0,0.2)', 4);
      FX.effects.bounceIn(this, title, 100);

      // Matches sub-headline
      var matchText = this.add.text(W / 2, H * 0.23, matchesFound + '/' + totalPairs + ' pairs found', {
        fontSize: '18px', fontFamily: 'Arial',
        color: colors.secondary
      }).setOrigin(0.5).setDepth(10).setAlpha(0);

      this.tweens.add({
        targets: matchText,
        alpha: 0.6,
        duration: 400,
        delay: 500
      });

      // Score count-up
      var scoreDisplay = FX.ui.AnimatedScore(this, W / 2, H * 0.34, {
        label: texts.scoreLabel || 'Score',
        color: colors.secondary,
        accentColor: colors.accent,
        fontSize: 48
      });
      this.time.delayedCall(500, function () {
        scoreDisplay.countUpFrom(0, score, 1500);
      });

      // Star rating based on performance
      // 3 stars: won with lots of time remaining
      // 2 stars: won or found most pairs
      // 1 star: found some pairs
      var starCount;
      if (won) {
        var duration = CONFIG.gameplay.duration;
        var timePct = duration > 0 ? timeRemaining / duration : 0;
        starCount = timePct >= 0.35 ? 3 : timePct >= 0.1 ? 2 : 1;
        // Always at least 2 stars for winning
        starCount = Math.max(2, starCount);
      } else {
        var matchPct = totalPairs > 0 ? matchesFound / totalPairs : 0;
        starCount = matchPct >= 0.75 ? 2 : matchPct >= 0.3 ? 1 : 0;
      }

      if (starCount > 0) {
        var stars = FX.ui.StarRating(this, W / 2, H * 0.47, {
          maxStars: 3,
          starSize: 42,
          filledColor: colors.accent,
          emptyColor: '#CBD5E1'
        });
        this.time.delayedCall(2000, function () {
          stars.fill(starCount);
        });
      }

      // Confetti for a win (3 stars)
      if (won && starCount === 3) {
        this.time.delayedCall(2800, function () {
          FX.effects.confettiBurst(this, W / 2, H * 0.4,
            [colors.primary, colors.accent, colors.secondary, '#FFFFFF'], 50);
          FX.audio.playSuccess();
        }.bind(this));
      } else if (won) {
        // Smaller celebration for win with fewer stars
        this.time.delayedCall(2800, function () {
          FX.effects.confettiBurst(this, W / 2, H * 0.4,
            [colors.primary, colors.accent], 25);
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
