/**
 * INTERACTIVE BRAND STORY — Premium Hybrid Template
 *
 * A cinematic interactive narrative with tap-to-advance story pages,
 * typewriter text reveals, choice points, parallax depth, and
 * Ken Burns zoom. Apple-keynote-level polish for brand storytelling.
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
   * Darken a hex color by a factor (0 = black, 1 = unchanged).
   */
  function darkenHex(hex, factor) {
    var c = hexToInt(hex);
    var r = Math.round(((c >> 16) & 255) * factor);
    var g = Math.round(((c >> 8) & 255) * factor);
    var b = Math.round((c & 255) * factor);
    return (r << 16) | (g << 8) | b;
  }

  /**
   * Lighten a hex color toward white by a factor (0 = unchanged, 1 = white).
   */
  function lightenHex(hex, factor) {
    var c = hexToInt(hex);
    var r = ((c >> 16) & 255);
    var g = ((c >> 8) & 255);
    var b = (c & 255);
    r = Math.round(r + (255 - r) * factor);
    g = Math.round(g + (255 - g) * factor);
    b = Math.round(b + (255 - b) * factor);
    return (r << 16) | (g << 8) | b;
  }

  /**
   * Convert integer color to hex string.
   */
  function intToHex(c) {
    return '#' + ('000000' + c.toString(16)).slice(-6);
  }

  // ═══════════════════════════════════════════════════════════
  // BOOT SCENE — Cinematic splash with animated gradient,
  // logo float-in, letterbox title reveal, ambient particles
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

      // Background — animated gradient
      this.cameras.main.setBackgroundColor(colors.background);
      FX.ambient.GradientBackground(this, {
        colorTop: colors.primary,
        colorBottom: colors.background,
        colorShift: colors.accent,
        duration: 6000
      });

      // Floating ambient shapes for depth
      FX.ambient.FloatingShapes(this, { color: colors.primary, count: 10 });

      // Diagonal light rays
      FX.ambient.LightRays(this, { color: colors.accent, count: 2 });

      // Vignette for cinematic framing
      FX.ambient.VignetteOverlay(this, { intensity: 0.35 });

      // Ambient particles
      FX.ambient.FloatingParticles(this, { color: colors.accent, density: 'low' });

      // Letterbox bars (cinematic framing)
      var barHeight = 50;
      var topBar = this.add.rectangle(W / 2, barHeight / 2, W, barHeight, 0x000000, 0.85).setDepth(400);
      var bottomBar = this.add.rectangle(W / 2, H - barHeight / 2, W, barHeight, 0x000000, 0.85).setDepth(400);
      topBar.setAlpha(0);
      bottomBar.setAlpha(0);
      this.tweens.add({ targets: topBar, alpha: 1, duration: 800, delay: 100, ease: 'Power2' });
      this.tweens.add({ targets: bottomBar, alpha: 1, duration: 800, delay: 100, ease: 'Power2' });

      // Logo (if available) — float in from above
      var logoKey = CONFIG.assets.logo;
      if (logoKey && this.textures.exists(logoKey)) {
        var logo = this.add.image(W / 2, H * 0.30, logoKey).setDepth(10);
        var maxDim = 140;
        var scale = Math.min(maxDim / logo.width, maxDim / logo.height, 1);
        logo.setScale(0).setAlpha(0);
        this.tweens.add({
          targets: logo,
          scale: scale,
          alpha: 1,
          y: H * 0.32,
          duration: 1000,
          ease: 'Back.easeOut',
          delay: 300
        });
        FX.effects.floatIdle(this, logo, 6);
        FX.effects.glowRing(this, W / 2, H * 0.32, 90, colors.primary);
      }

      // Title text — letterbox reveal with scale
      var title = this.add.text(W / 2, H * 0.48, texts.title, {
        fontSize: '44px',
        fontFamily: 'Arial',
        fontStyle: 'bold',
        color: colors.secondary,
        align: 'center',
        wordWrap: { width: W - 80 }
      }).setOrigin(0.5).setDepth(10).setScale(0).setAlpha(0);
      title.setShadow(3, 3, 'rgba(0,0,0,0.25)', 6);

      this.tweens.add({
        targets: title,
        scale: 1,
        alpha: 1,
        duration: 700,
        ease: 'Back.easeOut',
        delay: 600
      });

      // Subtitle
      if (texts.subtitle) {
        var sub = this.add.text(W / 2, H * 0.56, texts.subtitle, {
          fontSize: '20px',
          fontFamily: 'Arial',
          color: colors.secondary,
          align: 'center',
          wordWrap: { width: W - 100 }
        }).setOrigin(0.5).setDepth(10).setAlpha(0);

        this.tweens.add({
          targets: sub,
          alpha: 0.7,
          duration: 500,
          delay: 1100
        });
      }

      // Decorative divider line below subtitle
      var divider = this.add.graphics().setDepth(10).setAlpha(0);
      divider.lineStyle(2, hexToInt(colors.accent), 0.6);
      divider.lineBetween(W * 0.3, H * 0.61, W * 0.7, H * 0.61);
      this.tweens.add({
        targets: divider,
        alpha: 1,
        duration: 500,
        delay: 1300
      });

      // "Tap to Begin" — pulsing
      var tapText = this.add.text(W / 2, H * 0.75, 'Tap to Begin', {
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
        delay: 1600
      });

      // Mute button
      FX.audio.createMuteButton(this, { x: W - 35, y: 35, size: 22 });

      // Tap to start story
      var started = false;
      this.input.on('pointerdown', function () {
        if (started) return;
        started = true;
        FX.audio.playTap();

        var transition = CONFIG.theme.transitionStyle;
        if (transition === 'zoom') {
          FX.transitions.zoomOut(this, 'StoryScene', {});
        } else if (transition === 'wipe') {
          FX.transitions.wipeTransition(this, 'StoryScene', {}, 'left');
        } else if (transition === 'flash') {
          FX.transitions.flashTransition(this, 'StoryScene', {});
        } else {
          FX.transitions.cinematicFade(this, 'StoryScene', {});
        }
      }, this);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // STORY SCENE — Multi-page narrative engine
  //
  // Manages all story pages within a single Phaser scene.
  // Features: typewriter text, emphasis highlighting, sprite
  // animations, choice cards, Ken Burns zoom, parallax depth,
  // tap-to-advance with feedback, page transitions.
  // ═══════════════════════════════════════════════════════════
  class StoryScene extends Phaser.Scene {
    constructor() { super('StoryScene'); }

    create() {
      var self = this;

      FX.transitions.fadeIn(this);

      var colors = CONFIG.colors;
      var texts = CONFIG.texts;
      var story = CONFIG.story;
      var pages = texts.pages || [];

      this.colors = colors;
      this.texts = texts;
      this.story = story;
      this.pages = pages;
      this.currentPage = -1;
      this.isAnimating = false;
      this.playerChoice = null;
      this.pageContainer = null;

      // Determine which page index is the choice page (-1 if disabled)
      this.choicePageIndex = story.choiceEnabled ? Math.min(3, pages.length - 2) : -1;
      // The last page is always the CTA/end page
      this.totalPages = pages.length;

      // Master container for Ken Burns zoom
      this.masterContainer = this.add.container(0, 0).setDepth(0);

      // Parallax layers (persistent behind pages)
      this.parallaxLayers = FX.ambient.ParallaxLayers(this, {
        color: colors.primary,
        layers: 3
      });

      // Vignette (persistent overlay)
      FX.ambient.VignetteOverlay(this, { intensity: 0.3 });

      // Ambient floating particles (persistent)
      FX.ambient.FloatingParticles(this, {
        color: colors.accent,
        density: CONFIG.theme.particleDensity || 'medium'
      });

      // Page progress indicator
      this.progressDots = this.createProgressDots();

      // "Tap to continue" hint at bottom
      this.tapHint = this.add.text(W / 2, H - 55, 'tap to continue', {
        fontSize: '15px',
        fontFamily: 'Arial',
        fontStyle: 'italic',
        color: intToHex(lightenHex(colors.primary, 0.3))
      }).setOrigin(0.5).setDepth(600).setAlpha(0);

      this.tapHintTween = this.tweens.add({
        targets: this.tapHint,
        alpha: { from: 0.3, to: 0.8 },
        duration: 900,
        yoyo: true,
        repeat: -1,
        paused: true
      });

      // Mute button
      FX.audio.createMuteButton(this, { x: W - 35, y: 35, size: 18 });

      // Tap to advance handler
      this.input.on('pointerdown', function (pointer) {
        // Tap feedback circle
        FX.transitions.tapFeedback(self, pointer.x, pointer.y, colors.accent);

        if (self.isAnimating) return;

        // If on choice page, let choice cards handle input
        if (self.currentPage === self.choicePageIndex && self.story.choiceEnabled && !self.playerChoice) {
          return;
        }

        self.advancePage();
      });

      // Start the first page
      this.advancePage();
    }

    /**
     * Create progress dots at the top of the screen.
     */
    createProgressDots() {
      var total = this.totalPages;
      var dotSize = 6;
      var spacing = 16;
      var totalWidth = total * dotSize + (total - 1) * spacing;
      var startX = (W - totalWidth) / 2 + dotSize / 2;
      var y = 30;
      var dots = [];

      for (var i = 0; i < total; i++) {
        var dot = this.add.circle(
          startX + i * (dotSize + spacing),
          y,
          dotSize,
          hexToInt(this.colors.primary),
          0.25
        ).setDepth(700);
        dots.push(dot);
      }

      return dots;
    }

    /**
     * Update progress dots to reflect current page.
     */
    updateProgressDots() {
      var accent = hexToInt(this.colors.accent);
      var primary = hexToInt(this.colors.primary);
      for (var i = 0; i < this.progressDots.length; i++) {
        if (i <= this.currentPage) {
          this.progressDots[i].setFillStyle(accent, 1);
          if (i === this.currentPage) {
            this.tweens.add({
              targets: this.progressDots[i],
              scale: { from: 0.5, to: 1.3 },
              duration: 300,
              ease: 'Back.easeOut',
              yoyo: true,
              hold: 100
            });
          }
        } else {
          this.progressDots[i].setFillStyle(primary, 0.25);
        }
      }
    }

    /**
     * Advance to the next page.
     */
    advancePage() {
      var self = this;
      var nextPage = this.currentPage + 1;

      if (nextPage >= this.totalPages) {
        // Already on last page — do nothing (CTA handles exit)
        return;
      }

      this.isAnimating = true;
      this.hideTapHint();

      // Fade out current page container
      if (this.pageContainer) {
        var oldContainer = this.pageContainer;
        this.tweens.add({
          targets: oldContainer,
          alpha: 0,
          duration: 300,
          ease: 'Power2',
          onComplete: function () { oldContainer.destroy(); }
        });
      }

      // Short delay then build new page
      this.time.delayedCall(this.currentPage < 0 ? 100 : 350, function () {
        self.currentPage = nextPage;
        self.updateProgressDots();
        self.buildPage(nextPage);
      });
    }

    /**
     * Build a specific story page by index.
     */
    buildPage(pageIndex) {
      var self = this;
      var pageData = this.pages[pageIndex];
      var isLastPage = (pageIndex === this.totalPages - 1);
      var isChoicePage = (pageIndex === this.choicePageIndex && this.story.choiceEnabled);

      // Create page container
      this.pageContainer = this.add.container(0, 0).setDepth(50).setAlpha(0);

      // Page background color (full screen overlay)
      var bgColor = pageData.bgColor ? hexToInt(pageData.bgColor) : hexToInt(this.colors.primary);
      var pageBg = this.add.rectangle(W / 2, H / 2, W, H, bgColor, 0.85).setDepth(-5);
      this.pageContainer.add(pageBg);

      // Ken Burns zoom effect on the page container
      var kenBurnsTarget = this.pageContainer;
      var kbDuration = this.story.kenBurnsDuration || 3000;
      var kbScale = this.story.kenBurnsScale || 1.03;
      this.pageContainer.setScale(1);
      var kenBurnsTween = this.tweens.add({
        targets: kenBurnsTarget,
        scale: kbScale,
        duration: kbDuration,
        ease: 'Linear'
      });

      // Fade the page container in
      this.tweens.add({
        targets: this.pageContainer,
        alpha: 1,
        duration: 400,
        ease: 'Power2'
      });

      // Dispatch to the correct page builder
      if (isChoicePage) {
        this.buildChoicePage(pageData, pageIndex);
      } else if (isLastPage) {
        this.buildEndPage(pageData, pageIndex);
      } else {
        this.buildNarrativePage(pageData, pageIndex);
      }
    }

    // ─────────────────────────────────────────────────────────
    // NARRATIVE PAGE — Headline + body with typewriter + sprite
    // ─────────────────────────────────────────────────────────
    buildNarrativePage(pageData, pageIndex) {
      var self = this;
      var colors = this.colors;
      var story = this.story;
      var container = this.pageContainer;

      var isFirstPage = (pageIndex === 0);
      var isTensionPage = (pageIndex === 2); // Page 3 = problem/tension
      var isIntroPage = (pageIndex === 1);
      var hasHero = CONFIG.assets.hero && this.textures.exists(CONFIG.assets.hero);

      // --- Headline ---
      var headlineY = H * 0.22;
      var headline = this.add.text(W / 2, headlineY, '', {
        fontSize: isFirstPage ? '48px' : '38px',
        fontFamily: 'Arial',
        fontStyle: 'bold',
        color: '#FFFFFF',
        align: 'center',
        wordWrap: { width: W - 80 }
      }).setOrigin(0.5).setDepth(60).setAlpha(0);
      headline.setShadow(2, 3, 'rgba(0,0,0,0.35)', 8);
      container.add(headline);

      // Headline entrance animation
      headline.setY(headlineY + 20);
      this.tweens.add({
        targets: headline,
        alpha: 1,
        y: headlineY,
        duration: 600,
        ease: 'Power3',
        delay: 100
      });

      // --- Typewriter reveal for headline on first page ---
      var headlineText = pageData.headline || '';
      if (isFirstPage) {
        this.typewriterReveal(headline, headlineText, (story.typewriterSpeed || 40) * 0.7, 200);
      } else {
        headline.setText(headlineText);
      }

      // --- Hero sprite (if available and on intro/resolution pages) ---
      var heroSprite = null;
      var spriteY = H * 0.48;
      if (hasHero && (isIntroPage || pageIndex === this.totalPages - 2)) {
        heroSprite = this.add.image(W / 2, spriteY + 80, CONFIG.assets.hero).setDepth(55);
        var maxDim = 160;
        var heroScale = Math.min(maxDim / heroSprite.width, maxDim / heroSprite.height, 1);
        heroSprite.setScale(0).setAlpha(0);
        container.add(heroSprite);

        // Spotlight glow behind sprite
        var spotlight = this.add.circle(W / 2, spriteY, 100, hexToInt(colors.accent), 0.08).setDepth(54);
        container.add(spotlight);
        this.tweens.add({
          targets: spotlight,
          scale: { from: 0.8, to: 1.2 },
          alpha: { from: 0.12, to: 0.04 },
          duration: 2000,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut'
        });

        // Sprite entrance: slide up + fade
        this.tweens.add({
          targets: heroSprite,
          y: spriteY,
          scale: heroScale,
          alpha: 1,
          duration: 700,
          ease: 'Back.easeOut',
          delay: 400
        });

        // Idle float after entrance
        this.time.delayedCall(1100, function () {
          if (heroSprite && heroSprite.active) {
            FX.effects.floatIdle(self, heroSprite, 5);
          }
        });
      }

      // --- Tension page: shake on the hero sprite ---
      if (isTensionPage && hasHero) {
        heroSprite = this.add.image(W / 2, spriteY, CONFIG.assets.hero).setDepth(55);
        var tMaxDim = 140;
        var tScale = Math.min(tMaxDim / heroSprite.width, tMaxDim / heroSprite.height, 1);
        heroSprite.setScale(tScale).setAlpha(0);
        container.add(heroSprite);

        this.tweens.add({
          targets: heroSprite,
          alpha: 1,
          duration: 400,
          delay: 300
        });

        // Shake reaction after body text appears
        this.time.delayedCall(1800, function () {
          if (heroSprite && heroSprite.active) {
            FX.effects.screenShake(self, 0.006, 200);
            self.tweens.add({
              targets: heroSprite,
              x: { from: W / 2 - 4, to: W / 2 + 4 },
              duration: 60,
              yoyo: true,
              repeat: 4,
              onComplete: function () { heroSprite.setX(W / 2); }
            });
          }
        });
      }

      // --- Body text with emphasis words ---
      var bodyY = hasHero && (isIntroPage || isTensionPage || pageIndex === this.totalPages - 2)
        ? H * 0.68
        : H * 0.45;

      var bodyText = pageData.body || '';
      var emphasisWords = pageData.emphasisWords || [];

      // For first page: character-by-character typewriter
      // For other pages: word-by-word reveal with emphasis highlighting
      var bodyContainer = this.add.container(0, bodyY).setDepth(60);
      container.add(bodyContainer);

      if (isFirstPage) {
        var bodyDisplay = this.add.text(W / 2, 0, '', {
          fontSize: '20px',
          fontFamily: 'Arial',
          color: '#FFFFFF',
          align: 'center',
          wordWrap: { width: W - 100 },
          lineSpacing: 6
        }).setOrigin(0.5).setDepth(60).setAlpha(0.9);
        bodyContainer.add(bodyDisplay);

        this.typewriterReveal(bodyDisplay, bodyText, story.typewriterSpeed || 40, 800);

        // Signal animation complete after typewriter finishes
        var charTime = bodyText.length * (story.typewriterSpeed || 40);
        this.time.delayedCall(800 + charTime + 300, function () {
          self.onPageAnimationComplete();
        });
      } else {
        this.wordByWordReveal(bodyContainer, bodyText, emphasisWords, 500, function () {
          self.onPageAnimationComplete();
        });
      }
    }

    // ─────────────────────────────────────────────────────────
    // CHOICE PAGE — Two cards slide in from left/right
    // ─────────────────────────────────────────────────────────
    buildChoicePage(pageData, pageIndex) {
      var self = this;
      var colors = this.colors;
      var texts = this.texts;
      var container = this.pageContainer;

      // Headline
      var headline = this.add.text(W / 2, H * 0.18, pageData.headline || 'Your Choice', {
        fontSize: '36px',
        fontFamily: 'Arial',
        fontStyle: 'bold',
        color: '#FFFFFF',
        align: 'center',
        wordWrap: { width: W - 80 }
      }).setOrigin(0.5).setDepth(60);
      headline.setShadow(2, 3, 'rgba(0,0,0,0.3)', 6);
      FX.effects.bounceIn(this, headline, 100);
      container.add(headline);

      // Body text
      if (pageData.body) {
        var body = this.add.text(W / 2, H * 0.28, pageData.body, {
          fontSize: '18px',
          fontFamily: 'Arial',
          color: '#FFFFFF',
          align: 'center',
          wordWrap: { width: W - 100 },
          lineSpacing: 4
        }).setOrigin(0.5).setDepth(60).setAlpha(0);
        container.add(body);
        this.tweens.add({ targets: body, alpha: 0.8, duration: 400, delay: 400 });
      }

      // Card dimensions
      var cardW = 240;
      var cardH = 260;
      var cardY = H * 0.55;

      // Card A — slides in from left
      var cardA = this.createChoiceCard(
        -cardW, cardY,
        texts.choiceA || 'Option A',
        '\u2728', // sparkles icon
        colors.primary,
        'A'
      );
      container.add(cardA.container);

      this.tweens.add({
        targets: cardA.container,
        x: W * 0.27,
        duration: 600,
        ease: 'Back.easeOut',
        delay: 500
      });

      // Card B — slides in from right
      var cardB = this.createChoiceCard(
        W + cardW, cardY,
        texts.choiceB || 'Option B',
        '\u{1F680}', // rocket icon
        colors.accent,
        'B'
      );
      container.add(cardB.container);

      this.tweens.add({
        targets: cardB.container,
        x: W * 0.73,
        duration: 600,
        ease: 'Back.easeOut',
        delay: 650
      });

      // Enable interaction after cards land
      this.time.delayedCall(1300, function () {
        self.isAnimating = false;

        cardA.hitZone.on('pointerdown', function () {
          self.selectChoice('A', cardA, cardB);
        });

        cardB.hitZone.on('pointerdown', function () {
          self.selectChoice('B', cardB, cardA);
        });
      });
    }

    /**
     * Create a choice card with rounded rect background, icon, and label.
     */
    createChoiceCard(x, y, label, icon, color, id) {
      var cardW = 220;
      var cardH = 240;
      var colorInt = hexToInt(color);

      var container = this.add.container(x, y).setDepth(70);

      // Card background (rounded rect)
      var bg = this.add.graphics();
      bg.fillStyle(0x000000, 0.3);
      bg.fillRoundedRect(-cardW / 2, -cardH / 2, cardW, cardH, 20);
      container.add(bg);

      // Card border
      var border = this.add.graphics();
      border.lineStyle(2, colorInt, 0.6);
      border.strokeRoundedRect(-cardW / 2, -cardH / 2, cardW, cardH, 20);
      container.add(border);

      // Inner fill (subtle gradient overlay)
      var innerFill = this.add.graphics();
      innerFill.fillStyle(colorInt, 0.15);
      innerFill.fillRoundedRect(-cardW / 2 + 4, -cardH / 2 + 4, cardW - 8, cardH - 8, 18);
      container.add(innerFill);

      // Icon
      var iconText = this.add.text(0, -40, icon, {
        fontSize: '52px'
      }).setOrigin(0.5);
      container.add(iconText);

      // Label
      var labelText = this.add.text(0, 40, label, {
        fontSize: '22px',
        fontFamily: 'Arial',
        fontStyle: 'bold',
        color: '#FFFFFF',
        align: 'center',
        wordWrap: { width: cardW - 30 }
      }).setOrigin(0.5);
      labelText.setShadow(1, 1, 'rgba(0,0,0,0.3)', 3);
      container.add(labelText);

      // Hit zone
      var hitZone = this.add.rectangle(0, 0, cardW + 10, cardH + 10, 0x000000, 0)
        .setInteractive({ useHandCursor: true });
      container.add(hitZone);

      // Hover effects
      hitZone.on('pointerover', function () {
        border.clear();
        border.lineStyle(3, colorInt, 1);
        border.strokeRoundedRect(-cardW / 2, -cardH / 2, cardW, cardH, 20);
      });
      hitZone.on('pointerout', function () {
        border.clear();
        border.lineStyle(2, colorInt, 0.6);
        border.strokeRoundedRect(-cardW / 2, -cardH / 2, cardW, cardH, 20);
      });

      return { container: container, hitZone: hitZone, border: border, id: id };
    }

    /**
     * Handle a choice selection: glow chosen card, fade the other, particle burst.
     */
    selectChoice(choiceId, chosen, other) {
      var self = this;
      if (this.playerChoice) return; // Already chose

      this.playerChoice = choiceId;
      this.isAnimating = true;

      FX.audio.playScore();

      // Chosen card: glow + scale up
      this.tweens.add({
        targets: chosen.container,
        scale: 1.15,
        duration: 400,
        ease: 'Back.easeOut'
      });

      // Particle burst on chosen card
      FX.effects.sparkleBurst(this, chosen.container.x, chosen.container.y, this.colors.accent, 14);
      FX.effects.confettiBurst(this,
        chosen.container.x, chosen.container.y,
        [this.colors.primary, this.colors.accent, '#FFFFFF'], 20
      );

      // Other card: fade away
      this.tweens.add({
        targets: other.container,
        alpha: 0,
        scale: 0.7,
        x: other.id === 'A' ? -200 : W + 200,
        duration: 500,
        ease: 'Power3'
      });

      // After animation, allow advancing
      this.time.delayedCall(1200, function () {
        self.onPageAnimationComplete();
      });
    }

    // ─────────────────────────────────────────────────────────
    // END PAGE — Logo, key message, CTA button, confetti
    // ─────────────────────────────────────────────────────────
    buildEndPage(pageData, pageIndex) {
      var self = this;
      var colors = this.colors;
      var texts = this.texts;
      var container = this.pageContainer;
      var hasHero = CONFIG.assets.hero && this.textures.exists(CONFIG.assets.hero);

      // Logo drop-in at top
      var logoKey = CONFIG.assets.logo;
      if (logoKey && this.textures.exists(logoKey)) {
        var logo = this.add.image(W / 2, H * 0.12, logoKey).setDepth(60);
        var ls = Math.min(80 / logo.width, 80 / logo.height, 1);
        logo.setScale(0);
        container.add(logo);
        this.tweens.add({
          targets: logo,
          scale: ls,
          duration: 600,
          ease: 'Back.easeOut',
          delay: 200
        });
      }

      // Hero sprite centered with bounce (resolution page feel)
      if (hasHero) {
        var hero = this.add.image(W / 2, H * 0.36, CONFIG.assets.hero).setDepth(55);
        var hMaxDim = 180;
        var hScale = Math.min(hMaxDim / hero.width, hMaxDim / hero.height, 1);
        hero.setScale(0);
        container.add(hero);

        this.tweens.add({
          targets: hero,
          scale: hScale,
          duration: 700,
          ease: 'Bounce.easeOut',
          delay: 400
        });

        // Sparkle particles around hero
        this.time.delayedCall(1100, function () {
          FX.effects.ambientSparkle(self, 200, 200, colors.accent, 'medium');
        });

        FX.effects.glowRing(this, W / 2, H * 0.36, 110, colors.accent);
      }

      // Key message headline (typewriter)
      var headlineY = hasHero ? H * 0.54 : H * 0.30;
      var headline = this.add.text(W / 2, headlineY, '', {
        fontSize: '36px',
        fontFamily: 'Arial',
        fontStyle: 'bold',
        color: '#FFFFFF',
        align: 'center',
        wordWrap: { width: W - 80 }
      }).setOrigin(0.5).setDepth(60).setAlpha(1);
      headline.setShadow(2, 3, 'rgba(0,0,0,0.3)', 6);
      container.add(headline);

      this.typewriterReveal(headline, pageData.headline || 'Begin Today', (this.story.typewriterSpeed || 40) * 0.6, 600);

      // Body text
      if (pageData.body) {
        var bodyY = headlineY + 60;
        var body = this.add.text(W / 2, bodyY, pageData.body, {
          fontSize: '18px',
          fontFamily: 'Arial',
          color: '#FFFFFF',
          align: 'center',
          wordWrap: { width: W - 100 },
          lineSpacing: 6
        }).setOrigin(0.5).setDepth(60).setAlpha(0);
        container.add(body);
        this.tweens.add({
          targets: body,
          alpha: 0.85,
          duration: 500,
          delay: 1200
        });
      }

      // CTA Button with glow pulse
      var ctaDelay = 1600;
      var ctaBtn = FX.ui.CTAButton(this, W / 2, H * 0.78, texts.ctaText || 'Learn More', {
        width: 260,
        height: 60,
        color: colors.accent,
        textColor: '#FFFFFF'
      });
      ctaBtn.onClick = function () {
        if (window.mraidAction) window.mraidAction();
      };
      ctaBtn.container.setScale(0).setDepth(100);
      container.add(ctaBtn.container);

      this.tweens.add({
        targets: ctaBtn.container,
        scale: 1,
        duration: 600,
        ease: 'Back.easeOut',
        delay: ctaDelay
      });

      // Confetti burst after CTA appears
      this.time.delayedCall(ctaDelay + 400, function () {
        FX.effects.confettiBurst(self, W / 2, H * 0.65,
          [colors.primary, colors.accent, '#FFFFFF', '#FFD700'], 40);
        FX.audio.playSuccess();
      });

      // Replay option
      var replay = this.add.text(W / 2, H * 0.90, texts.replayText || 'Replay', {
        fontSize: '16px',
        fontFamily: 'Arial',
        fontStyle: 'bold',
        color: intToHex(lightenHex(colors.primary, 0.4))
      }).setOrigin(0.5).setDepth(100).setAlpha(0)
        .setInteractive({ useHandCursor: true });
      container.add(replay);

      this.tweens.add({
        targets: replay,
        alpha: 0.6,
        duration: 400,
        delay: ctaDelay + 800
      });

      replay.on('pointerdown', function () {
        FX.audio.playTap();
        FX.transitions.cinematicFade(self, 'StoryScene', {});
      });
      replay.on('pointerover', function () { replay.setAlpha(1); });
      replay.on('pointerout', function () { replay.setAlpha(0.6); });

      // This is the final page — no tap-to-advance needed
      this.isAnimating = false;
    }

    // ─────────────────────────────────────────────────────────
    // TYPEWRITER REVEAL — Character-by-character text animation
    // ─────────────────────────────────────────────────────────
    typewriterReveal(textObject, fullText, speed, delay) {
      speed = speed || 40;
      delay = delay || 0;
      var scene = this;
      var charIndex = 0;

      scene.time.delayedCall(delay, function () {
        var timer = scene.time.addEvent({
          delay: speed,
          callback: function () {
            charIndex++;
            textObject.setText(fullText.substring(0, charIndex));
            // Subtle tick sound every few characters
            if (charIndex % 4 === 0) {
              FX.audio.playTick();
            }
            if (charIndex >= fullText.length) {
              timer.remove(false);
            }
          },
          loop: true
        });
      });
    }

    // ─────────────────────────────────────────────────────────
    // WORD-BY-WORD REVEAL — With emphasis word highlighting
    // ─────────────────────────────────────────────────────────
    wordByWordReveal(parentContainer, bodyText, emphasisWords, delay, onComplete) {
      var scene = this;
      var colors = this.colors;
      var words = bodyText.split(' ');
      var wordObjects = [];
      var lineWidth = W - 120;
      var fontSize = 20;
      var lineSpacing = 8;

      // Pre-calculate word positions
      var lines = [];
      var currentLine = [];
      var currentLineWidth = 0;
      var spaceWidth = fontSize * 0.35;

      for (var i = 0; i < words.length; i++) {
        var wordWidth = words[i].length * fontSize * 0.52;
        if (currentLineWidth + wordWidth > lineWidth && currentLine.length > 0) {
          lines.push(currentLine);
          currentLine = [];
          currentLineWidth = 0;
        }
        currentLine.push({ text: words[i], width: wordWidth });
        currentLineWidth += wordWidth + spaceWidth;
      }
      if (currentLine.length > 0) lines.push(currentLine);

      var totalHeight = lines.length * (fontSize + lineSpacing);
      var startY = -totalHeight / 2;

      // Create text objects for each word
      var allWordData = [];
      for (var li = 0; li < lines.length; li++) {
        var line = lines[li];
        var lineTotalWidth = 0;
        for (var wi = 0; wi < line.length; wi++) {
          lineTotalWidth += line[wi].width + (wi < line.length - 1 ? spaceWidth : 0);
        }
        var wordX = (W - lineTotalWidth) / 2;

        for (var wj = 0; wj < line.length; wj++) {
          var wordData = line[wj];
          var isEmphasis = false;
          var lowerWord = wordData.text.toLowerCase().replace(/[^a-z]/g, '');
          for (var e = 0; e < emphasisWords.length; e++) {
            var emphLower = emphasisWords[e].toLowerCase().replace(/[^a-z ]/g, '');
            // Support multi-word emphasis
            if (emphLower.indexOf(' ') >= 0) {
              // Multi-word emphasis handled below
              continue;
            }
            if (lowerWord === emphLower) {
              isEmphasis = true;
              break;
            }
          }

          var wordColor = isEmphasis ? colors.accent : '#FFFFFF';
          var wordStyle = isEmphasis ? 'bold' : 'normal';

          var wordObj = scene.add.text(wordX, startY + li * (fontSize + lineSpacing), wordData.text, {
            fontSize: fontSize + 'px',
            fontFamily: 'Arial',
            fontStyle: wordStyle,
            color: wordColor
          }).setOrigin(0, 0.5).setDepth(65).setAlpha(0).setScale(0.8);

          if (isEmphasis) {
            wordObj.setShadow(0, 0, colors.accent, 6);
          }

          parentContainer.add(wordObj);
          allWordData.push({ obj: wordObj, isEmphasis: isEmphasis });

          wordX += wordData.width + spaceWidth;
        }
      }

      // Stagger reveal each word
      var wordDelay = 60;
      var startDelay = delay || 500;

      for (var k = 0; k < allWordData.length; k++) {
        (function (idx, wd) {
          scene.time.delayedCall(startDelay + idx * wordDelay, function () {
            scene.tweens.add({
              targets: wd.obj,
              alpha: wd.isEmphasis ? 1 : 0.9,
              scale: 1,
              duration: 200,
              ease: 'Power2'
            });

            // Extra emphasis effect: brief scale punch
            if (wd.isEmphasis) {
              scene.tweens.add({
                targets: wd.obj,
                scale: { from: 1.2, to: 1.0 },
                duration: 300,
                ease: 'Back.easeOut',
                delay: 50
              });
            }
          });
        })(k, allWordData[k]);
      }

      // Call onComplete after all words are revealed
      var totalWordTime = startDelay + allWordData.length * wordDelay + 400;
      scene.time.delayedCall(totalWordTime, function () {
        if (onComplete) onComplete();
      });
    }

    // ─────────────────────────────────────────────────────────
    // PAGE ANIMATION COMPLETE — Show tap hint or auto-advance
    // ─────────────────────────────────────────────────────────
    onPageAnimationComplete() {
      var self = this;
      this.isAnimating = false;

      // If this is the last page, don't show tap hint
      if (this.currentPage >= this.totalPages - 1) return;

      this.showTapHint();

      // Auto-advance if configured
      var autoDelay = this.story.autoAdvanceDelay || 0;
      if (autoDelay > 0) {
        this.time.delayedCall(autoDelay, function () {
          if (!self.isAnimating && self.currentPage < self.totalPages - 1) {
            self.advancePage();
          }
        });
      }
    }

    showTapHint() {
      this.tapHint.setAlpha(0);
      this.tweens.add({
        targets: this.tapHint,
        alpha: 0.6,
        duration: 400,
        ease: 'Power2'
      });
      this.tapHintTween.resume();
    }

    hideTapHint() {
      this.tapHintTween.pause();
      this.tapHint.setAlpha(0);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // GAME CONFIG — Phaser initialization
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
    scene: [BootScene, StoryScene]
  };
})();
