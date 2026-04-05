/**
 * PRODUCT REVEAL — Premium Cinematic Template
 *
 * A multi-phase interactive product/service reveal with dramatic
 * animations, brand-themed transitions, parallax depth layers,
 * and Apple-keynote-level visual polish.
 *
 * Phases:
 *   Boot  → Dramatic dark splash, logo pulse, teaser text, "Tap to Reveal"
 *   Phase 1 (Tease)      → Glowing mystery circle, edge particles, tap prompt
 *   Phase 2 (Reveal)     → Circle explodes, product scales in with spotlight
 *   Phase 3 (Features)   → Feature badges slide in from alternating sides
 *   Phase 4 (Statement)  → Brand statement with word-by-word animation
 *   Phase 5 (CTA)        → Product floats up, logo, CTA button, confetti
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
   * Darkens a hex color by the given factor (0 = black, 1 = unchanged).
   */
  function darkenHex(hex, factor) {
    var c = hexToInt(hex);
    var r = Math.round(((c >> 16) & 255) * factor);
    var g = Math.round(((c >> 8) & 255) * factor);
    var b = Math.round((c & 255) * factor);
    return (r << 16) | (g << 8) | b;
  }

  // ═══════════════════════════════════════════════════════════
  // BOOT SCENE — Dramatic dark splash with logo pulse
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

      // Dark cinematic background
      this.cameras.main.setBackgroundColor(colors.background);
      FX.ambient.GradientBackground(this, {
        colorTop: colors.background,
        colorBottom: colors.primary,
        colorShift: colors.accent,
        duration: 8000
      });

      // Parallax depth layers for atmosphere
      FX.ambient.ParallaxLayers(this, { color: colors.primary, layers: 3 });

      // Ambient particles — low density for mysterious feel
      FX.ambient.FloatingParticles(this, { color: colors.accent, density: 'low' });

      // Light rays for drama
      FX.ambient.LightRays(this, { color: colors.accent, count: 2 });

      // Vignette for cinematic framing
      FX.ambient.VignetteOverlay(this, { intensity: 0.45 });

      // Logo pulse-in (if available)
      var logoKey = CONFIG.assets.logo;
      if (logoKey && this.textures.exists(logoKey)) {
        var logo = this.add.image(W / 2, H * 0.33, logoKey).setDepth(10);
        var maxDim = 120;
        var scale = Math.min(maxDim / logo.width, maxDim / logo.height, 1);
        logo.setScale(0).setAlpha(0);

        // Pulse in with dramatic timing
        this.tweens.add({
          targets: logo,
          scale: scale,
          alpha: 1,
          duration: 1000,
          ease: 'Back.easeOut',
          delay: 400
        });

        // Idle float after entrance
        this.time.delayedCall(1400, function () {
          FX.effects.floatIdle(this, logo, 5);
        }.bind(this));

        // Glow ring behind logo
        FX.effects.glowRing(this, W / 2, H * 0.33, 80, colors.primary);
      }

      // Teaser text — dramatic fade-in
      var teaser = this.add.text(W / 2, H * 0.50, texts.teaserText, {
        fontSize: '34px',
        fontFamily: 'Arial',
        fontStyle: 'bold',
        color: colors.secondary,
        align: 'center',
        wordWrap: { width: W - 100 }
      }).setOrigin(0.5).setDepth(10).setAlpha(0);
      teaser.setShadow(2, 2, 'rgba(0,0,0,0.5)', 8);

      this.tweens.add({
        targets: teaser,
        alpha: 1,
        y: H * 0.49,
        duration: 800,
        ease: 'Power2',
        delay: 800
      });

      // Subtle shimmer on teaser text
      this.time.delayedCall(1600, function () {
        FX.effects.shimmerEffect(this, teaser);
      }.bind(this));

      // "Tap to Reveal" — pulsing prompt
      var tapPrompt = texts.tapPrompt || 'Tap to Reveal';
      var tapText = this.add.text(W / 2, H * 0.72, tapPrompt, {
        fontSize: '20px',
        fontFamily: 'Arial',
        fontStyle: 'bold',
        color: colors.accent
      }).setOrigin(0.5).setDepth(10).setAlpha(0);

      this.tweens.add({
        targets: tapText,
        alpha: { from: 0.4, to: 1 },
        duration: 900,
        yoyo: true,
        repeat: -1,
        delay: 1800
      });

      // Decorative horizontal line above tap prompt
      var lineGfx = this.add.graphics().setDepth(10).setAlpha(0);
      lineGfx.lineStyle(1, hexToInt(colors.accent), 0.3);
      lineGfx.lineBetween(W * 0.3, H * 0.66, W * 0.7, H * 0.66);
      this.tweens.add({
        targets: lineGfx,
        alpha: 1,
        duration: 600,
        delay: 1500
      });

      // Mute button
      FX.audio.createMuteButton(this, { x: W - 35, y: 35, size: 22 });

      // Tap to transition to RevealScene
      var started = false;
      this.input.on('pointerdown', function () {
        if (started) return;
        started = true;
        FX.audio.playTap();

        var transition = CONFIG.theme.transitionStyle;
        if (transition === 'zoom') {
          FX.transitions.zoomOut(this, 'RevealScene', {});
        } else if (transition === 'wipe') {
          FX.transitions.wipeTransition(this, 'RevealScene', {}, 'left');
        } else if (transition === 'flash') {
          FX.transitions.flashTransition(this, 'RevealScene', {});
        } else {
          FX.transitions.cinematicFade(this, 'RevealScene', {});
        }
      }, this);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // REVEAL SCENE — Multi-phase cinematic product reveal
  // ═══════════════════════════════════════════════════════════
  class RevealScene extends Phaser.Scene {
    constructor() { super('RevealScene'); }

    create() {
      var self = this;
      FX.transitions.fadeIn(this);

      var colors = CONFIG.colors;
      var texts = CONFIG.texts;
      var revealConfig = CONFIG.reveal || {};

      this.currentPhase = 0;
      this.animating = false;
      this.phaseObjects = [];

      // ── Background setup ──────────────────────────────────
      this.cameras.main.setBackgroundColor(colors.background);

      var bgStyle = CONFIG.theme.backgroundStyle;
      if (bgStyle === 'gradient_shift') {
        this.bgGradient = FX.ambient.GradientBackground(this, {
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

      // Parallax layers always present for depth
      this.parallax = FX.ambient.ParallaxLayers(this, {
        color: colors.primary,
        layers: 2
      });

      // Ambient particles
      FX.ambient.FloatingParticles(this, {
        color: colors.accent,
        density: CONFIG.theme.particleDensity || 'medium'
      });

      // Vignette overlay for cinematic feel
      FX.ambient.VignetteOverlay(this, { intensity: 0.35 });

      // Mute button
      FX.audio.createMuteButton(this, { x: W - 35, y: 35, size: 18 });

      // ── Tap handler ───────────────────────────────────────
      this.input.on('pointerdown', function (pointer) {
        if (self.animating) return;
        FX.audio.playTap();
        FX.transitions.tapFeedback(self, pointer.x, pointer.y, colors.accent);
        self.advancePhase();
      });

      // ── Start Phase 1 ─────────────────────────────────────
      this.startPhase1();
    }

    // ─────────────────────────────────────────────────────────
    // PHASE 1 — Tease: Mystery circle with glowing edges
    // ─────────────────────────────────────────────────────────
    startPhase1() {
      var self = this;
      var colors = CONFIG.colors;
      var texts = CONFIG.texts;
      this.currentPhase = 1;
      this.animating = true;

      // Container for all phase 1 objects (easy cleanup)
      var p1 = this.add.container(0, 0).setDepth(20);
      this.phaseObjects.push(p1);

      // Glowing edge particles — ring around center
      var edgeEmitter = this.add.particles(W / 2, H * 0.42, 'glow_particle', {
        speed: { min: 3, max: 12 },
        lifespan: { min: 1500, max: 3000 },
        scale: { start: 0.4, end: 0 },
        alpha: { start: 0.4, end: 0 },
        tint: hexToInt(colors.accent),
        frequency: 120,
        emitZone: {
          type: 'edge',
          source: new Phaser.Geom.Circle(0, 0, 80),
          quantity: 24
        }
      });
      edgeEmitter.setDepth(19);
      this.p1EdgeEmitter = edgeEmitter;

      // Mystery circle background — dark with brand tint
      var mysteryBg = this.add.circle(W / 2, H * 0.42, 70,
        darkenHex(colors.primary, 0.3), 0.8).setDepth(20);
      p1.add(mysteryBg);

      // Pulsing glow ring behind circle
      var glowRing = this.add.circle(W / 2, H * 0.42, 85,
        hexToInt(colors.primary), 0.12).setDepth(18);
      this.tweens.add({
        targets: glowRing,
        scale: { from: 0.9, to: 1.2 },
        alpha: { from: 0.15, to: 0.04 },
        duration: 1800,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut'
      });
      p1.add(glowRing);

      // Second glow ring — offset timing for layered effect
      var glowRing2 = this.add.circle(W / 2, H * 0.42, 95,
        hexToInt(colors.accent), 0.06).setDepth(17);
      this.tweens.add({
        targets: glowRing2,
        scale: { from: 1.0, to: 1.3 },
        alpha: { from: 0.08, to: 0.02 },
        duration: 2200,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
        delay: 400
      });
      p1.add(glowRing2);

      // "?" symbol — pulsing scale
      var questionMark = this.add.text(W / 2, H * 0.42, '?', {
        fontSize: '64px',
        fontFamily: 'Arial',
        fontStyle: 'bold',
        color: colors.accent
      }).setOrigin(0.5).setDepth(22).setScale(0);

      this.tweens.add({
        targets: questionMark,
        scale: 1,
        duration: 600,
        ease: 'Back.easeOut',
        delay: 200,
        onComplete: function () {
          // Continuous pulse
          self.tweens.add({
            targets: questionMark,
            scale: { from: 0.9, to: 1.1 },
            duration: 1000,
            yoyo: true,
            repeat: -1,
            ease: 'Sine.easeInOut'
          });
        }
      });
      p1.add(questionMark);

      // "Tap to reveal" prompt below circle
      var tapPrompt = texts.tapPrompt || 'Tap to Reveal';
      var promptText = this.add.text(W / 2, H * 0.58, tapPrompt, {
        fontSize: '20px',
        fontFamily: 'Arial',
        fontStyle: 'bold',
        color: colors.secondary
      }).setOrigin(0.5).setDepth(22).setAlpha(0);

      this.tweens.add({
        targets: promptText,
        alpha: { from: 0.4, to: 1 },
        duration: 800,
        yoyo: true,
        repeat: -1,
        delay: 800
      });
      p1.add(promptText);

      // Small upward arrow indicator
      var arrow = this.add.text(W / 2, H * 0.54, '\u25B2', {
        fontSize: '14px',
        color: colors.accent
      }).setOrigin(0.5).setDepth(22).setAlpha(0);
      this.tweens.add({
        targets: arrow,
        alpha: { from: 0.3, to: 0.8 },
        y: H * 0.53,
        duration: 600,
        yoyo: true,
        repeat: -1,
        delay: 1000
      });
      p1.add(arrow);

      // Animation entrance complete
      this.time.delayedCall(900, function () {
        self.animating = false;
        self.scheduleAutoAdvance();
      });
    }

    // ─────────────────────────────────────────────────────────
    // PHASE 2 — First Reveal: Circle explodes, product appears
    // ─────────────────────────────────────────────────────────
    startPhase2() {
      var self = this;
      var colors = CONFIG.colors;
      var texts = CONFIG.texts;
      this.currentPhase = 2;
      this.animating = true;

      // Destroy phase 1 elements
      this.cleanupPhaseObjects();
      if (this.p1EdgeEmitter) {
        this.p1EdgeEmitter.stop();
        this.time.delayedCall(500, function () {
          if (self.p1EdgeEmitter) self.p1EdgeEmitter.destroy();
        });
      }

      // Explosion particle burst at circle location
      var revealStyle = CONFIG.theme.revealStyle || 'explosion';
      var burstCount = revealStyle === 'explosion' ? 40 : 25;

      FX.effects.sparkleBurst(this, W / 2, H * 0.42, colors.accent, burstCount);
      FX.effects.confettiBurst(this, W / 2, H * 0.42,
        [colors.primary, colors.accent, colors.secondary, '#FFFFFF'], 30);

      // Screen flash for impact
      this.cameras.main.flash(150, 255, 255, 255, true);
      FX.audio.playSuccess();

      // Brief camera shake
      FX.effects.screenShake(this, 0.01, 120);

      // Phase 2 container
      var p2 = this.add.container(0, 0).setDepth(30);
      this.phaseObjects.push(p2);

      // Spotlight glow ring behind product position
      var spotlight = this.add.circle(W / 2, H * 0.42, 110,
        hexToInt(colors.primary), 0.1).setDepth(25).setScale(0);
      this.tweens.add({
        targets: spotlight,
        scale: 1.2,
        alpha: 0.15,
        duration: 800,
        ease: 'Cubic.easeOut'
      });
      // Breathing animation
      this.time.delayedCall(800, function () {
        self.tweens.add({
          targets: spotlight,
          scale: { from: 1.1, to: 1.3 },
          alpha: { from: 0.15, to: 0.06 },
          duration: 2000,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut'
        });
      });
      p2.add(spotlight);

      // Second spotlight ring — outer
      var spotlightOuter = this.add.circle(W / 2, H * 0.42, 140,
        hexToInt(colors.accent), 0.04).setDepth(24).setScale(0);
      this.tweens.add({
        targets: spotlightOuter,
        scale: 1,
        duration: 1000,
        ease: 'Cubic.easeOut',
        delay: 200
      });
      this.time.delayedCall(1200, function () {
        self.tweens.add({
          targets: spotlightOuter,
          scale: { from: 1.0, to: 1.2 },
          alpha: { from: 0.05, to: 0.02 },
          duration: 2500,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut'
        });
      });
      p2.add(spotlightOuter);

      // Product sprite — dramatic scale from 0 to full
      var productKey = CONFIG.assets.product;
      var product;
      var productTargetScale = 1;

      if (productKey && this.textures.exists(productKey)) {
        product = this.add.image(W / 2, H * 0.42, productKey).setDepth(35);
        var maxDim = 200;
        productTargetScale = Math.min(maxDim / product.width, maxDim / product.height, 1);
      } else {
        // Fallback: branded circle with product icon
        product = this.add.circle(W / 2, H * 0.42, 70,
          hexToInt(colors.primary), 1).setDepth(35);
        productTargetScale = 1;
      }
      product.setScale(0).setAlpha(0);
      this.product = product;
      this.productTargetScale = productTargetScale;

      // Dramatic scale-up with delay for explosion to settle
      this.tweens.add({
        targets: product,
        scale: productTargetScale,
        alpha: 1,
        duration: 700,
        ease: 'Back.easeOut',
        delay: 250
      });
      p2.add(product);

      // Shimmer particles around product
      var shimmerEmitter = this.add.particles(W / 2, H * 0.42, 'star_particle', {
        speed: { min: 8, max: 25 },
        lifespan: { min: 1500, max: 3000 },
        scale: { start: 0.5, end: 0 },
        alpha: { start: 0.5, end: 0 },
        tint: hexToInt(colors.accent),
        frequency: 200,
        emitZone: {
          type: 'random',
          source: new Phaser.Geom.Circle(0, 0, 100)
        }
      });
      shimmerEmitter.setDepth(32);
      this.p2ShimmerEmitter = shimmerEmitter;

      // Product name — typewriter effect below product
      var nameY = H * 0.60;
      var productNameText = this.add.text(W / 2, nameY, '', {
        fontSize: '36px',
        fontFamily: 'Arial',
        fontStyle: 'bold',
        color: colors.secondary,
        align: 'center',
        wordWrap: { width: W - 80 }
      }).setOrigin(0.5).setDepth(35);
      productNameText.setShadow(2, 2, 'rgba(0,0,0,0.4)', 6);
      p2.add(productNameText);

      // Typewriter animation
      var fullName = texts.productName;
      var charIndex = 0;
      this.time.addEvent({
        delay: 60,
        repeat: fullName.length - 1,
        startAt: 600,
        callback: function () {
          charIndex++;
          productNameText.setText(fullName.substring(0, charIndex));
          // Subtle tick sound every few chars
          if (charIndex % 3 === 0) {
            FX.audio.playTick();
          }
        }
      });

      // Subtle underline under product name
      var underline = this.add.graphics().setDepth(34).setAlpha(0);
      underline.lineStyle(2, hexToInt(colors.accent), 0.5);
      var textWidth = Math.min(fullName.length * 18, W - 120);
      underline.lineBetween(W / 2 - textWidth / 2, nameY + 26, W / 2 + textWidth / 2, nameY + 26);
      this.tweens.add({
        targets: underline,
        alpha: 1,
        duration: 400,
        delay: 600 + fullName.length * 60 + 200
      });
      p2.add(underline);

      // Tap prompt for next phase
      var nextPrompt = this.add.text(W / 2, H * 0.88, 'Tap to continue', {
        fontSize: '16px',
        fontFamily: 'Arial',
        color: colors.secondary
      }).setOrigin(0.5).setDepth(35).setAlpha(0);
      this.tweens.add({
        targets: nextPrompt,
        alpha: { from: 0.3, to: 0.7 },
        duration: 800,
        yoyo: true,
        repeat: -1,
        delay: 600 + fullName.length * 60 + 600
      });
      p2.add(nextPrompt);

      // Resolve animation lock
      var totalEntrance = 600 + fullName.length * 60 + 400;
      this.time.delayedCall(totalEntrance, function () {
        self.animating = false;
        self.scheduleAutoAdvance();
      });
    }

    // ─────────────────────────────────────────────────────────
    // PHASE 3 — Feature Highlights: Badges slide in
    // ─────────────────────────────────────────────────────────
    startPhase3() {
      var self = this;
      var colors = CONFIG.colors;
      var texts = CONFIG.texts;
      var revealConfig = CONFIG.reveal || {};
      this.currentPhase = 3;
      this.animating = true;

      // Don't fully clean up — keep product visible from phase 2
      // Just remove phase 2 specific UI (prompt text etc.)
      this.cleanupPhaseObjects();
      if (this.p2ShimmerEmitter) {
        this.p2ShimmerEmitter.stop();
        this.time.delayedCall(500, function () {
          if (self.p2ShimmerEmitter) self.p2ShimmerEmitter.destroy();
        });
      }

      var p3 = this.add.container(0, 0).setDepth(40);
      this.phaseObjects.push(p3);

      // Re-add product at a slightly higher position for feature layout
      var product = this.product;
      if (product && product.active) {
        // Ken Burns slow zoom effect on product
        this.tweens.add({
          targets: product,
          scale: this.productTargetScale * 1.08,
          duration: 6000,
          ease: 'Linear'
        });
        // Nudge product up
        this.tweens.add({
          targets: product,
          y: H * 0.30,
          duration: 600,
          ease: 'Power2'
        });
      }

      // Spotlight glow follows product up
      var spotGlow = this.add.circle(W / 2, H * 0.30, 120,
        hexToInt(colors.primary), 0.08).setDepth(25);
      this.tweens.add({
        targets: spotGlow,
        scale: { from: 0.9, to: 1.15 },
        alpha: { from: 0.1, to: 0.03 },
        duration: 2000,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut'
      });
      p3.add(spotGlow);

      // Feature badges
      var features = texts.features || [];
      var featureCount = Math.min(
        revealConfig.featureCount || 3,
        features.length
      );
      var badgeStartY = H * 0.52;
      var badgeSpacing = 80;
      var staggerDelay = 500;

      for (var i = 0; i < featureCount; i++) {
        (function (idx) {
          var feature = features[idx];
          var fromLeft = idx % 2 === 0;
          var startX = fromLeft ? -300 : W + 300;
          var targetX = W / 2;
          var targetY = badgeStartY + idx * badgeSpacing;

          // Badge container
          var badge = self.add.container(startX, targetY).setDepth(45).setAlpha(0);

          // Badge background — rounded rectangle
          var badgeBg = self.add.graphics();
          var badgeWidth = 340;
          var badgeHeight = 56;
          badgeBg.fillStyle(hexToInt(colors.primary), 0.15);
          badgeBg.fillRoundedRect(-badgeWidth / 2, -badgeHeight / 2, badgeWidth, badgeHeight, 14);
          // Subtle border
          badgeBg.lineStyle(1, hexToInt(colors.accent), 0.25);
          badgeBg.strokeRoundedRect(-badgeWidth / 2, -badgeHeight / 2, badgeWidth, badgeHeight, 14);
          badge.add(badgeBg);

          // Icon circle
          var iconBg = self.add.circle(-badgeWidth / 2 + 34, 0, 18,
            hexToInt(colors.accent), 0.2);
          badge.add(iconBg);

          // Icon emoji
          var icon = self.add.text(-badgeWidth / 2 + 34, 0, feature.icon || '\u2713', {
            fontSize: '20px'
          }).setOrigin(0.5);
          badge.add(icon);

          // Feature text
          var featureText = self.add.text(-badgeWidth / 2 + 64, 0, feature.text || '', {
            fontSize: '18px',
            fontFamily: 'Arial',
            fontStyle: 'bold',
            color: colors.secondary,
            wordWrap: { width: badgeWidth - 80 }
          }).setOrigin(0, 0.5);
          badge.add(featureText);

          // Slide in animation
          self.tweens.add({
            targets: badge,
            x: targetX,
            alpha: 1,
            duration: 600,
            ease: 'Back.easeOut',
            delay: 200 + idx * staggerDelay
          });

          // Subtle idle float after landing
          self.time.delayedCall(800 + idx * staggerDelay, function () {
            FX.effects.floatIdle(self, badge, 3);
          });

          // Sparkle on arrival
          self.time.delayedCall(700 + idx * staggerDelay, function () {
            FX.effects.sparkleBurst(self, targetX, targetY, colors.accent, 6);
            FX.audio.playScore();
          });

          p3.add(badge);
        })(i);
      }

      // Tap prompt
      var totalBadgeTime = 200 + featureCount * staggerDelay + 600;
      var nextPrompt = this.add.text(W / 2, H * 0.90, 'Tap to continue', {
        fontSize: '16px',
        fontFamily: 'Arial',
        color: colors.secondary
      }).setOrigin(0.5).setDepth(45).setAlpha(0);
      this.tweens.add({
        targets: nextPrompt,
        alpha: { from: 0.3, to: 0.7 },
        duration: 800,
        yoyo: true,
        repeat: -1,
        delay: totalBadgeTime + 200
      });
      p3.add(nextPrompt);

      // Resolve animation lock
      this.time.delayedCall(totalBadgeTime, function () {
        self.animating = false;
        self.scheduleAutoAdvance();
      });
    }

    // ─────────────────────────────────────────────────────────
    // PHASE 4 — Brand Statement: Word-by-word animation
    // ─────────────────────────────────────────────────────────
    startPhase4() {
      var self = this;
      var colors = CONFIG.colors;
      var texts = CONFIG.texts;
      this.currentPhase = 4;
      this.animating = true;

      // Clean up phase 3 badges
      this.cleanupPhaseObjects();

      var p4 = this.add.container(0, 0).setDepth(50);
      this.phaseObjects.push(p4);

      // Shift background to brand primary color
      var bgOverlay = this.add.rectangle(W / 2, H / 2, W, H,
        hexToInt(colors.primary), 0).setDepth(15);
      this.tweens.add({
        targets: bgOverlay,
        alpha: 0.15,
        duration: 1000,
        ease: 'Power2'
      });
      p4.add(bgOverlay);

      // Move product up and scale down slightly
      var product = this.product;
      if (product && product.active) {
        this.tweens.add({
          targets: product,
          y: H * 0.25,
          scale: this.productTargetScale * 0.85,
          duration: 600,
          ease: 'Power2'
        });
      }

      // Intensified ambient particles
      var intenseParts = this.add.particles(W / 2, H / 2, 'glow_particle', {
        speed: { min: 8, max: 30 },
        lifespan: { min: 2000, max: 5000 },
        scale: { start: 0.3, end: 0 },
        alpha: { start: 0.2, end: 0 },
        tint: hexToInt(colors.accent),
        frequency: 100,
        emitZone: {
          type: 'random',
          source: new Phaser.Geom.Rectangle(-W / 2, -H / 2, W, H)
        }
      });
      intenseParts.setDepth(16);
      this.p4ParticleEmitter = intenseParts;

      // Brand statement — word-by-word animation
      var statement = texts.brandStatement;
      var words = statement.split(' ');
      var statementY = H * 0.52;

      // Pre-calculate layout: measure approximate total width to determine
      // if we need line wrapping
      var fontSize = 30;
      var maxLineWidth = W - 100;

      // Create invisible measurement text to determine line breaks
      var measurer = this.add.text(0, 0, '', {
        fontSize: fontSize + 'px',
        fontFamily: 'Arial',
        fontStyle: 'bold',
        wordWrap: { width: maxLineWidth }
      }).setOrigin(0.5).setAlpha(0);
      measurer.setText(statement);
      var totalHeight = measurer.height;
      measurer.destroy();

      // Word-by-word container
      var wordContainer = this.add.container(W / 2, statementY).setDepth(55);
      p4.add(wordContainer);

      // Create each word as separate text, arrange in lines
      var lineWords = [];
      var currentLine = [];
      var currentLineWidth = 0;
      var spaceWidth = fontSize * 0.35;

      // Build lines
      for (var w = 0; w < words.length; w++) {
        var testText = this.add.text(0, 0, words[w], {
          fontSize: fontSize + 'px',
          fontFamily: 'Arial',
          fontStyle: 'bold'
        }).setOrigin(0).setAlpha(0);
        var wordWidth = testText.width;
        testText.destroy();

        if (currentLineWidth + wordWidth + (currentLine.length > 0 ? spaceWidth : 0) > maxLineWidth && currentLine.length > 0) {
          lineWords.push({ words: currentLine.slice(), width: currentLineWidth });
          currentLine = [];
          currentLineWidth = 0;
        }

        currentLine.push({ word: words[w], width: wordWidth });
        currentLineWidth += wordWidth + (currentLine.length > 1 ? spaceWidth : 0);
      }
      if (currentLine.length > 0) {
        lineWords.push({ words: currentLine.slice(), width: currentLineWidth });
      }

      // Render words with staggered fade-in
      var lineHeight = fontSize * 1.4;
      var totalLinesHeight = lineWords.length * lineHeight;
      var startLineY = -totalLinesHeight / 2;
      var wordIndex = 0;
      var wordDelay = 120;

      for (var li = 0; li < lineWords.length; li++) {
        var line = lineWords[li];
        var lineX = -line.width / 2;

        for (var wi = 0; wi < line.words.length; wi++) {
          var wordData = line.words[wi];
          var wordObj = this.add.text(lineX, startLineY + li * lineHeight, wordData.word, {
            fontSize: fontSize + 'px',
            fontFamily: 'Arial',
            fontStyle: 'bold',
            color: colors.secondary
          }).setOrigin(0, 0.5).setAlpha(0).setScale(0.8);
          wordObj.setShadow(2, 2, 'rgba(0,0,0,0.4)', 4);

          // Staggered entrance
          (function (obj, idx) {
            self.tweens.add({
              targets: obj,
              alpha: 1,
              scale: 1,
              duration: 350,
              ease: 'Back.easeOut',
              delay: 400 + idx * wordDelay
            });
          })(wordObj, wordIndex);

          wordContainer.add(wordObj);
          lineX += wordData.width + spaceWidth;
          wordIndex++;
        }
      }

      // Decorative lines above and below statement
      var decorLineTop = this.add.graphics().setDepth(54).setAlpha(0);
      decorLineTop.lineStyle(1, hexToInt(colors.accent), 0.4);
      decorLineTop.lineBetween(W * 0.2, statementY - totalLinesHeight / 2 - 25,
        W * 0.8, statementY - totalLinesHeight / 2 - 25);
      this.tweens.add({
        targets: decorLineTop,
        alpha: 1,
        duration: 500,
        delay: 300
      });
      p4.add(decorLineTop);

      var decorLineBottom = this.add.graphics().setDepth(54).setAlpha(0);
      decorLineBottom.lineStyle(1, hexToInt(colors.accent), 0.4);
      decorLineBottom.lineBetween(W * 0.2, statementY + totalLinesHeight / 2 + 25,
        W * 0.8, statementY + totalLinesHeight / 2 + 25);
      this.tweens.add({
        targets: decorLineBottom,
        alpha: 1,
        duration: 500,
        delay: 400 + wordIndex * wordDelay + 200
      });
      p4.add(decorLineBottom);

      // Tap prompt
      var totalWordTime = 400 + wordIndex * wordDelay + 600;
      var nextPrompt = this.add.text(W / 2, H * 0.90, 'Tap to continue', {
        fontSize: '16px',
        fontFamily: 'Arial',
        color: colors.secondary
      }).setOrigin(0.5).setDepth(55).setAlpha(0);
      this.tweens.add({
        targets: nextPrompt,
        alpha: { from: 0.3, to: 0.7 },
        duration: 800,
        yoyo: true,
        repeat: -1,
        delay: totalWordTime
      });
      p4.add(nextPrompt);

      // Resolve animation lock
      this.time.delayedCall(totalWordTime, function () {
        self.animating = false;
        self.scheduleAutoAdvance();
      });
    }

    // ─────────────────────────────────────────────────────────
    // PHASE 5 — CTA: Product floats up, logo, CTA, confetti
    // ─────────────────────────────────────────────────────────
    startPhase5() {
      var self = this;
      var colors = CONFIG.colors;
      var texts = CONFIG.texts;
      this.currentPhase = 5;
      this.animating = true;

      // Clean up phase 4 elements
      this.cleanupPhaseObjects();
      if (this.p4ParticleEmitter) {
        this.p4ParticleEmitter.stop();
        this.time.delayedCall(500, function () {
          if (self.p4ParticleEmitter) self.p4ParticleEmitter.destroy();
        });
      }

      var p5 = this.add.container(0, 0).setDepth(60);
      this.phaseObjects.push(p5);

      // Move product to upper area with gentle float
      var product = this.product;
      if (product && product.active) {
        this.tweens.add({
          targets: product,
          y: H * 0.24,
          scale: this.productTargetScale * 0.9,
          duration: 700,
          ease: 'Power2'
        });
        // Idle float
        this.time.delayedCall(700, function () {
          FX.effects.floatIdle(self, product, 6);
        });
      }

      // Glow behind product
      var ctaGlow = this.add.circle(W / 2, H * 0.24, 100,
        hexToInt(colors.primary), 0.1).setDepth(55);
      this.tweens.add({
        targets: ctaGlow,
        scale: { from: 0.9, to: 1.2 },
        alpha: { from: 0.12, to: 0.04 },
        duration: 1800,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut'
      });
      p5.add(ctaGlow);

      // Product name text
      var nameText = this.add.text(W / 2, H * 0.42, texts.productName, {
        fontSize: '28px',
        fontFamily: 'Arial',
        fontStyle: 'bold',
        color: colors.secondary,
        align: 'center'
      }).setOrigin(0.5).setDepth(65).setAlpha(0);
      nameText.setShadow(2, 2, 'rgba(0,0,0,0.3)', 4);
      this.tweens.add({
        targets: nameText,
        alpha: 1,
        duration: 500,
        ease: 'Power2',
        delay: 300
      });
      p5.add(nameText);

      // Logo below product name (if available)
      var logoKey = CONFIG.assets.logo;
      if (logoKey && this.textures.exists(logoKey)) {
        var logo = this.add.image(W / 2, H * 0.50, logoKey).setDepth(65);
        var ls = Math.min(70 / logo.width, 70 / logo.height, 1);
        logo.setScale(0);
        this.tweens.add({
          targets: logo,
          scale: ls,
          duration: 500,
          ease: 'Back.easeOut',
          delay: 600
        });
        p5.add(logo);
      }

      // Confetti burst
      this.time.delayedCall(800, function () {
        FX.effects.confettiBurst(self, W / 2, H * 0.35,
          [colors.primary, colors.accent, colors.secondary, '#FFFFFF'], 50);
        FX.audio.playSuccess();
      });

      // CTA Button — scales in with glow pulse
      var ctaBtn = FX.ui.CTAButton(this, W / 2, H * 0.66, texts.ctaText || 'Explore Now', {
        width: 260,
        height: 60,
        color: colors.primary,
        textColor: '#FFFFFF'
      });
      ctaBtn.onClick = function () {
        if (window.mraidAction) window.mraidAction();
      };
      ctaBtn.container.setScale(0).setDepth(70);
      this.tweens.add({
        targets: ctaBtn.container,
        scale: 1,
        duration: 600,
        ease: 'Back.easeOut',
        delay: 1000
      });

      // "Tap to explore" pulsing text below CTA
      var exploreText = this.add.text(W / 2, H * 0.75, 'Tap to explore', {
        fontSize: '16px',
        fontFamily: 'Arial',
        color: colors.accent
      }).setOrigin(0.5).setDepth(70).setAlpha(0);
      this.tweens.add({
        targets: exploreText,
        alpha: { from: 0.4, to: 1 },
        duration: 900,
        yoyo: true,
        repeat: -1,
        delay: 1600
      });
      p5.add(exploreText);

      // Replay option
      var replayText = texts.replayText || 'Replay';
      var replay = this.add.text(W / 2, H * 0.86, replayText, {
        fontSize: '18px',
        fontFamily: 'Arial',
        fontStyle: 'bold',
        color: colors.secondary
      }).setOrigin(0.5).setDepth(70).setAlpha(0)
        .setInteractive({ useHandCursor: true });

      this.tweens.add({
        targets: replay,
        alpha: 0.6,
        duration: 400,
        delay: 2000
      });

      replay.on('pointerdown', function () {
        FX.audio.playTap();
        FX.transitions.cinematicFade(self, 'BootScene', {});
      });
      replay.on('pointerover', function () { replay.setAlpha(1); });
      replay.on('pointerout', function () { replay.setAlpha(0.6); });
      p5.add(replay);

      // Ambient shimmer particles around entire CTA area
      var ctaShimmer = this.add.particles(W / 2, H * 0.66, 'star_particle', {
        speed: { min: 5, max: 18 },
        lifespan: { min: 2000, max: 4000 },
        scale: { start: 0.3, end: 0 },
        alpha: { start: 0.3, end: 0 },
        tint: hexToInt(colors.accent),
        frequency: 250,
        emitZone: {
          type: 'random',
          source: new Phaser.Geom.Rectangle(-150, -50, 300, 100)
        }
      });
      ctaShimmer.setDepth(65);

      // Phase 5 does not auto-advance — it's the final phase
      this.time.delayedCall(1600, function () {
        self.animating = false;
      });
    }

    // ─────────────────────────────────────────────────────────
    // Phase management utilities
    // ─────────────────────────────────────────────────────────

    /**
     * Advances to the next phase. Called on tap (when not animating)
     * or by auto-advance timer.
     */
    advancePhase() {
      switch (this.currentPhase) {
        case 1: this.startPhase2(); break;
        case 2: this.startPhase3(); break;
        case 3: this.startPhase4(); break;
        case 4: this.startPhase5(); break;
        case 5:
          // Phase 5 tap goes to CTA — handled by CTA button
          if (window.mraidAction) window.mraidAction();
          break;
      }
    }

    /**
     * Schedules auto-advance if configured. Only applies to phases 1-4.
     */
    scheduleAutoAdvance() {
      var self = this;
      var revealConfig = CONFIG.reveal || {};
      if (!revealConfig.autoAdvance) return;
      if (this.currentPhase >= 5) return;

      var delay = revealConfig.autoAdvanceDelay || 3000;
      this.autoAdvanceTimer = this.time.delayedCall(delay, function () {
        if (!self.animating && self.currentPhase < 5) {
          self.advancePhase();
        }
      });
    }

    /**
     * Destroys all objects in the phaseObjects array with a fade-out.
     */
    cleanupPhaseObjects() {
      var self = this;
      if (this.autoAdvanceTimer) {
        this.autoAdvanceTimer.remove(false);
        this.autoAdvanceTimer = null;
      }

      this.phaseObjects.forEach(function (obj) {
        if (obj && obj.active) {
          self.tweens.add({
            targets: obj,
            alpha: 0,
            duration: 300,
            ease: 'Power2',
            onComplete: function () {
              obj.destroy();
            }
          });
        }
      });
      this.phaseObjects = [];
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
    scene: [BootScene, RevealScene]
  };
})();
