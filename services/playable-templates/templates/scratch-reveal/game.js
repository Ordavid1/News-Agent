/**
 * SCRATCH & REVEAL — Premium Hybrid Template
 *
 * A polished scratch card game where the player scratches over a
 * metallic overlay surface to reveal a brand message, product, or
 * prize underneath. Grid-based scratch tracking with smooth visual
 * erasure, sparkle particles, and cinematic auto-reveal on threshold.
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
   * Blends two hex-integer colors by a ratio t (0..1).
   */
  function lerpColor(a, b, t) {
    var ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
    var br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
    var rr = Math.round(ar + (br - ar) * t);
    var rg = Math.round(ag + (bg - ag) * t);
    var rb = Math.round(ab + (bb - ab) * t);
    return (rr << 16) | (rg << 8) | rb;
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
        var logo = this.add.image(W / 2, H * 0.28, logoKey).setDepth(10);
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
        FX.effects.glowRing(this, W / 2, H * 0.28, 90, colors.primary);
      }

      // Decorative scratch card preview — small tilted card silhouette
      var previewCard = this.add.graphics().setDepth(8);
      previewCard.fillStyle(hexToInt(colors.primary), 0.15);
      previewCard.fillRoundedRect(-80, -55, 160, 110, 12);
      previewCard.setPosition(W / 2, H * 0.43);
      previewCard.setAngle(-3);

      // Sparkle accent on the card preview
      var previewSparkle = this.add.text(W / 2 + 50, H * 0.41, '\u2728', {
        fontSize: '24px'
      }).setOrigin(0.5).setDepth(9).setAlpha(0);

      this.tweens.add({
        targets: previewSparkle,
        alpha: { from: 0, to: 0.8 },
        scale: { from: 0.5, to: 1.1 },
        duration: 1200,
        yoyo: true,
        repeat: -1,
        delay: 800
      });

      // Title text
      var title = this.add.text(W / 2, H * 0.54, texts.title, {
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
        var sub = this.add.text(W / 2, H * 0.61, texts.subtitle, {
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

      // "Tap to Start" — pulsing
      var tapText = this.add.text(W / 2, H * 0.75, 'Tap to Start', {
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
  // GAME SCENE — Scratch card interaction
  // ═══════════════════════════════════════════════════════════
  class GameScene extends Phaser.Scene {
    constructor() { super('GameScene'); }

    create() {
      var self = this;
      FX.transitions.fadeIn(this);

      var colors = CONFIG.colors;
      var texts = CONFIG.texts;
      var gameplay = CONFIG.gameplay;

      this.gameActive = true;
      this.revealTriggered = false;

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

      // ── Card Dimensions ──────────────────────────────────────
      var cardW = 480;
      var cardH = 400;
      var cardX = (W - cardW) / 2;
      var cardY = (H - cardH) / 2 + 30;
      var cardCX = cardX + cardW / 2;
      var cardCY = cardY + cardH / 2;

      // ── Scratch Prompt Text ──────────────────────────────────
      var promptText = this.add.text(W / 2, cardY - 50, texts.scratchPrompt || 'Scratch the card!', {
        fontSize: '24px',
        fontFamily: 'Arial',
        fontStyle: 'bold',
        color: colors.secondary
      }).setOrigin(0.5).setDepth(100);

      this.tweens.add({
        targets: promptText,
        alpha: { from: 0.6, to: 1 },
        y: cardY - 55,
        duration: 1200,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut'
      });

      // ── Card Frame (Premium Metallic Border) ─────────────────
      var framePadding = 8;
      var frameGfx = this.add.graphics().setDepth(5);

      // Outer glow
      frameGfx.fillStyle(hexToInt(colors.primary), 0.12);
      frameGfx.fillRoundedRect(
        cardX - framePadding - 6, cardY - framePadding - 6,
        cardW + (framePadding + 6) * 2, cardH + (framePadding + 6) * 2, 20
      );

      // Main frame border
      frameGfx.fillStyle(hexToInt(colors.primary), 0.3);
      frameGfx.fillRoundedRect(
        cardX - framePadding, cardY - framePadding,
        cardW + framePadding * 2, cardH + framePadding * 2, 16
      );

      // Inner border highlight
      frameGfx.lineStyle(2, 0xffffff, 0.25);
      frameGfx.strokeRoundedRect(
        cardX - framePadding + 1, cardY - framePadding + 1,
        cardW + (framePadding - 1) * 2, cardH + (framePadding - 1) * 2, 15
      );

      // Subtle animated glow pulse on the frame
      this.tweens.add({
        targets: frameGfx,
        alpha: { from: 1, to: 0.7 },
        duration: 2000,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut'
      });

      // ── Reveal Content (Under the Scratch Surface) ───────────
      // Background fill for reveal area
      var revealBg = this.add.graphics().setDepth(6);
      revealBg.fillStyle(0xffffff, 1);
      revealBg.fillRoundedRect(cardX, cardY, cardW, cardH, 12);

      // Subtle radial gradient overlay on reveal area for depth
      var revealGradient = this.add.graphics().setDepth(7);
      revealGradient.fillStyle(hexToInt(colors.accent), 0.06);
      revealGradient.fillRoundedRect(cardX, cardY, cardW, cardH, 12);

      // Reveal image (product/brand sprite)
      var revealImgKey = CONFIG.assets.revealImage;
      if (revealImgKey && this.textures.exists(revealImgKey)) {
        var revealImg = this.add.image(cardCX, cardCY - 30, revealImgKey).setDepth(8);
        var imgMaxW = cardW * 0.6;
        var imgMaxH = cardH * 0.5;
        var imgScale = Math.min(imgMaxW / revealImg.width, imgMaxH / revealImg.height, 1);
        revealImg.setScale(imgScale);
        this.revealImg = revealImg;
      }

      // Reveal message text
      var revealMsgText = this.add.text(cardCX, cardCY + (revealImgKey ? 80 : 0), texts.revealMessage, {
        fontSize: '26px',
        fontFamily: 'Arial',
        fontStyle: 'bold',
        color: colors.secondary,
        align: 'center',
        wordWrap: { width: cardW - 60 }
      }).setOrigin(0.5).setDepth(8);
      revealMsgText.setShadow(1, 1, 'rgba(0,0,0,0.1)', 3);

      // Prize text (if provided)
      if (texts.prizeText) {
        var prizeText = this.add.text(cardCX, cardCY + (revealImgKey ? 120 : 40), texts.prizeText, {
          fontSize: '18px',
          fontFamily: 'Arial',
          color: colors.accent,
          align: 'center',
          wordWrap: { width: cardW - 80 }
        }).setOrigin(0.5).setDepth(8);
      }

      // Ambient sparkle particles inside reveal area
      var revealSparkle = this.add.particles(cardCX, cardCY, 'star_particle', {
        speed: { min: 5, max: 15 },
        lifespan: { min: 2000, max: 4000 },
        scale: { start: 0.3, end: 0 },
        alpha: { start: 0.4, end: 0 },
        tint: hexToInt(colors.accent),
        frequency: 400,
        emitZone: {
          type: 'random',
          source: new Phaser.Geom.Rectangle(-cardW / 2 + 20, -cardH / 2 + 20, cardW - 40, cardH - 40)
        }
      });
      revealSparkle.setDepth(9);

      // ── Scratch Overlay (Grid-Based System) ──────────────────
      //
      // We divide the scratch area into a grid of small rectangular
      // cells. Each cell is a Graphics tile. When the pointer passes
      // over a cell, that cell fades out and is marked as scratched.
      // We track how many cells have been scratched for percentage.
      //
      var cellSize = 20;
      var cols = Math.ceil(cardW / cellSize);
      var rows = Math.ceil(cardH / cellSize);
      var totalCells = cols * rows;
      var scratchedCount = 0;

      // Pre-compute overlay colors based on style
      var overlayStyle = CONFIG.theme.overlayStyle || 'metallic';
      var overlayColorBase = hexToInt(colors.primary);
      var overlayColorLight = lerpColor(overlayColorBase, 0xffffff, 0.3);
      var overlayColorDark = lerpColor(overlayColorBase, 0x000000, 0.2);

      // Container for all scratch cells — clipped to rounded card area
      var cellContainer = this.add.container(0, 0).setDepth(50);

      // Build grid cells
      var cells = [];
      var cellMap = {}; // row_col -> index lookup for pointer tracking

      for (var row = 0; row < rows; row++) {
        for (var col = 0; col < cols; col++) {
          var cx = cardX + col * cellSize;
          var cy = cardY + row * cellSize;

          // Clip cells to the card boundary
          var cw = Math.min(cellSize, cardX + cardW - cx);
          var ch = Math.min(cellSize, cardY + cardH - cy);
          if (cw <= 0 || ch <= 0) continue;

          var cellGfx = this.add.graphics();

          // Apply overlay style per cell
          if (overlayStyle === 'metallic') {
            // Metallic shimmer: alternate subtle brightness bands
            var bandT = ((row + col) % 4) / 4;
            var cellColor = lerpColor(overlayColorDark, overlayColorLight, bandT);
            cellGfx.fillStyle(cellColor, 1);
            cellGfx.fillRect(cx, cy, cw, ch);

            // Fine metallic highlight lines on every 4th row
            if (row % 4 === 0) {
              cellGfx.fillStyle(0xffffff, 0.08);
              cellGfx.fillRect(cx, cy, cw, 1);
            }
          } else if (overlayStyle === 'gradient') {
            var gradT = row / rows;
            var gradColor = lerpColor(overlayColorLight, overlayColorDark, gradT);
            cellGfx.fillStyle(gradColor, 1);
            cellGfx.fillRect(cx, cy, cw, ch);
          } else if (overlayStyle === 'shimmer') {
            var shimmerT = ((row * 3 + col * 7) % 10) / 10;
            var shimmerColor = lerpColor(overlayColorBase, overlayColorLight, shimmerT);
            cellGfx.fillStyle(shimmerColor, 1);
            cellGfx.fillRect(cx, cy, cw, ch);
          } else {
            // Solid
            cellGfx.fillStyle(overlayColorBase, 1);
            cellGfx.fillRect(cx, cy, cw, ch);
          }

          cellContainer.add(cellGfx);

          var cellData = {
            gfx: cellGfx,
            row: row,
            col: col,
            x: cx,
            y: cy,
            w: cw,
            h: ch,
            scratched: false
          };
          cells.push(cellData);
          cellMap[row + '_' + col] = cells.length - 1;
        }
      }

      // Rounded corners mask — overlay solid corner pieces matching the background
      // to create the appearance of rounded edges without a true mask
      var cornerMask = this.add.graphics().setDepth(51);
      var cornerRadius = 12;
      var bgColorInt = hexToInt(colors.background);

      // We draw background-colored rectangles at each corner and then
      // subtract the rounded area visually. Simpler: draw 4 filled arcs
      // of background color at each corner position.
      cornerMask.fillStyle(bgColorInt, 1);

      // Top-left corner
      cornerMask.fillRect(cardX, cardY, cornerRadius, cornerRadius);
      cornerMask.fillStyle(bgColorInt, 1);

      // Top-right corner
      cornerMask.fillRect(cardX + cardW - cornerRadius, cardY, cornerRadius, cornerRadius);

      // Bottom-left corner
      cornerMask.fillRect(cardX, cardY + cardH - cornerRadius, cornerRadius, cornerRadius);

      // Bottom-right corner
      cornerMask.fillRect(cardX + cardW - cornerRadius, cardY + cardH - cornerRadius, cornerRadius, cornerRadius);

      // Now punch out rounded arcs by drawing filled circles at each corner
      // using the overlay color... Actually, simpler: draw background-colored
      // corner squares, then overlay circles at the 4 corners matching the
      // card interior. The visual effect is rounded corners.
      var cMask2 = this.add.graphics().setDepth(52);

      // Clear the corner squares by re-filling with background, then
      // draw quarter-circle cutouts. In Phaser Graphics we achieve this
      // by drawing 4 arcs of the overlay base color.
      function drawCornerArc(gfx, arcX, arcY, startAngle, endAngle) {
        gfx.fillStyle(overlayColorBase, 1);
        gfx.beginPath();
        gfx.moveTo(arcX, arcY);
        gfx.arc(arcX, arcY, cornerRadius, Phaser.Math.DegToRad(startAngle), Phaser.Math.DegToRad(endAngle), false);
        gfx.closePath();
        gfx.fillPath();
      }

      drawCornerArc(cMask2, cardX + cornerRadius, cardY + cornerRadius, 180, 270);
      drawCornerArc(cMask2, cardX + cardW - cornerRadius, cardY + cornerRadius, 270, 360);
      drawCornerArc(cMask2, cardX + cornerRadius, cardY + cardH - cornerRadius, 90, 180);
      drawCornerArc(cMask2, cardX + cardW - cornerRadius, cardY + cardH - cornerRadius, 0, 90);

      // Decorative overlay details — "SCRATCH HERE" pattern (subtle cross-hatch)
      var overlayDecor = this.add.graphics().setDepth(53);
      overlayDecor.lineStyle(1, 0xffffff, 0.06);
      for (var d = 0; d < cardW + cardH; d += 30) {
        var dx1 = cardX + d;
        var dy1 = cardY;
        var dx2 = cardX + d - cardH;
        var dy2 = cardY + cardH;
        overlayDecor.lineBetween(
          Math.max(cardX, Math.min(cardX + cardW, dx1)),
          Math.max(cardY, Math.min(cardY + cardH, dy1)),
          Math.max(cardX, Math.min(cardX + cardW, dx2)),
          Math.max(cardY, Math.min(cardY + cardH, dy2))
        );
      }

      // Central overlay label
      var overlayLabel = this.add.text(cardCX, cardCY, '\u2728 SCRATCH \u2728', {
        fontSize: '28px',
        fontFamily: 'Arial',
        fontStyle: 'bold',
        color: '#FFFFFF'
      }).setOrigin(0.5).setDepth(55).setAlpha(0.35);

      this.tweens.add({
        targets: overlayLabel,
        alpha: { from: 0.25, to: 0.5 },
        duration: 1500,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut'
      });

      // Store references for cleanup during reveal
      this.overlayElements = {
        cellContainer: cellContainer,
        cells: cells,
        cornerMask: cornerMask,
        cMask2: cMask2,
        overlayDecor: overlayDecor,
        overlayLabel: overlayLabel
      };

      // ── Progress Bar ─────────────────────────────────────────
      this.progressBar = FX.ui.ProgressBar(this, W / 2, cardY - 18, {
        width: cardW,
        height: 8,
        bgColor: colors.secondary,
        fillColor: colors.accent,
        radius: 4
      });
      this.progressBar.setDepth(100);

      // Progress percentage text
      this.progressText = this.add.text(W / 2, cardY + cardH + 30, '0% revealed', {
        fontSize: '16px',
        fontFamily: 'Arial',
        color: colors.secondary
      }).setOrigin(0.5).setDepth(100).setAlpha(0.7);

      // ── Timer (optional) ─────────────────────────────────────
      if (gameplay.timerEnabled) {
        this.timer = FX.ui.CircularTimer(this, 56, 50, {
          radius: 24,
          thickness: 5,
          fillColor: colors.primary,
          textColor: colors.secondary
        });
        this.timer.onComplete = function () {
          if (self.gameActive) {
            self.triggerReveal();
          }
        };
        this.timer.start(gameplay.duration);
      }

      // ── Scratch Interaction ──────────────────────────────────
      var scratchRadius = gameplay.scratchRadius || 28;
      var threshold = gameplay.scratchThreshold || 60;
      var isPointerDown = false;
      var lastScratchTime = 0;

      // Transparent hit area covering the card
      var hitArea = this.add.rectangle(cardCX, cardCY, cardW, cardH, 0x000000, 0)
        .setInteractive({ useHandCursor: true, draggable: true })
        .setDepth(60);

      hitArea.on('pointerdown', function () {
        isPointerDown = true;
      });

      this.input.on('pointerup', function () {
        isPointerDown = false;
      });

      this.input.on('pointermove', function (pointer) {
        if (!isPointerDown || !self.gameActive || self.revealTriggered) return;

        var px = pointer.x;
        var py = pointer.y;

        // Check if pointer is within card bounds
        if (px < cardX || px > cardX + cardW || py < cardY || py > cardY + cardH) return;

        // Determine which cells the scratch radius covers
        var scratchRadiusSq = scratchRadius * scratchRadius;
        var minCol = Math.max(0, Math.floor((px - scratchRadius - cardX) / cellSize));
        var maxCol = Math.min(cols - 1, Math.floor((px + scratchRadius - cardX) / cellSize));
        var minRow = Math.max(0, Math.floor((py - scratchRadius - cardY) / cellSize));
        var maxRow = Math.min(rows - 1, Math.floor((py + scratchRadius - cardY) / cellSize));

        var newlyScratched = false;

        for (var r = minRow; r <= maxRow; r++) {
          for (var c = minCol; c <= maxCol; c++) {
            var key = r + '_' + c;
            var idx = cellMap[key];
            if (idx === undefined) continue;
            var cell = cells[idx];
            if (cell.scratched) continue;

            // Distance from pointer to cell center
            var cellCenterX = cell.x + cell.w / 2;
            var cellCenterY = cell.y + cell.h / 2;
            var dx = px - cellCenterX;
            var dy = py - cellCenterY;

            if (dx * dx + dy * dy <= scratchRadiusSq) {
              cell.scratched = true;
              scratchedCount++;
              newlyScratched = true;

              // Fade out the cell with a quick tween
              self.tweens.add({
                targets: cell.gfx,
                alpha: 0,
                duration: 150,
                ease: 'Power2',
                onComplete: function (tween, targets) {
                  targets[0].setVisible(false);
                }
              });
            }
          }
        }

        if (newlyScratched) {
          var now = Date.now();

          // Sparkle particles at scratch point (throttled for performance)
          if (now - lastScratchTime > 80) {
            lastScratchTime = now;
            FX.effects.sparkleBurst(self, px, py, colors.accent, 4);

            // Satisfying scratch audio (throttled)
            FX.audio.playTick();
          }

          // Update progress
          var pct = Math.round((scratchedCount / totalCells) * 100);
          self.progressBar.setProgress(pct / 100);
          self.progressText.setText(pct + '% revealed');

          // Encouragement messages at milestones
          var encouragements = texts.encouragement || [];
          if (encouragements.length > 0 && pct > 0 && pct % 20 === 0 && pct < threshold) {
            var msg = encouragements[Phaser.Math.Between(0, encouragements.length - 1)];
            var enc = self.add.text(W / 2, H * 0.22, msg, {
              fontSize: '28px',
              fontFamily: 'Arial',
              fontStyle: 'bold',
              color: colors.accent,
              stroke: colors.secondary,
              strokeThickness: 3
            }).setOrigin(0.5).setDepth(200).setScale(0);

            self.tweens.add({
              targets: enc,
              scale: 1.2,
              alpha: { from: 1, to: 0 },
              y: H * 0.18,
              duration: 1000,
              ease: 'Power2',
              onComplete: function () { enc.destroy(); }
            });
          }

          // Check threshold
          if (pct >= threshold && !self.revealTriggered) {
            self.triggerReveal();
          }
        }
      });

      // Also handle pointerdown directly on the card (single tap scratch)
      hitArea.on('pointerdown', function (pointer) {
        if (!self.gameActive || self.revealTriggered) return;

        var px = pointer.x;
        var py = pointer.y;

        if (px < cardX || px > cardX + cardW || py < cardY || py > cardY + cardH) return;

        var scratchRadiusSq = scratchRadius * scratchRadius;
        var minCol = Math.max(0, Math.floor((px - scratchRadius - cardX) / cellSize));
        var maxCol = Math.min(cols - 1, Math.floor((px + scratchRadius - cardX) / cellSize));
        var minRow = Math.max(0, Math.floor((py - scratchRadius - cardY) / cellSize));
        var maxRow = Math.min(rows - 1, Math.floor((py + scratchRadius - cardY) / cellSize));

        for (var r = minRow; r <= maxRow; r++) {
          for (var c = minCol; c <= maxCol; c++) {
            var key = r + '_' + c;
            var idx = cellMap[key];
            if (idx === undefined) continue;
            var cell = cells[idx];
            if (cell.scratched) continue;

            var cellCenterX = cell.x + cell.w / 2;
            var cellCenterY = cell.y + cell.h / 2;
            var ddx = px - cellCenterX;
            var ddy = py - cellCenterY;

            if (ddx * ddx + ddy * ddy <= scratchRadiusSq) {
              cell.scratched = true;
              scratchedCount++;

              self.tweens.add({
                targets: cell.gfx,
                alpha: 0,
                duration: 150,
                ease: 'Power2',
                onComplete: function (tween, targets) {
                  targets[0].setVisible(false);
                }
              });
            }
          }
        }

        FX.effects.sparkleBurst(self, px, py, colors.accent, 5);
        FX.audio.playTick();

        var pct = Math.round((scratchedCount / totalCells) * 100);
        self.progressBar.setProgress(pct / 100);
        self.progressText.setText(pct + '% revealed');

        if (pct >= threshold && !self.revealTriggered) {
          self.triggerReveal();
        }
      });

      // Store card dimensions for use in reveal
      this.cardDimensions = { x: cardX, y: cardY, w: cardW, h: cardH, cx: cardCX, cy: cardCY };
      this.scratchData = { cells: cells, totalCells: totalCells, scratchedCount: scratchedCount };
      this.promptText = promptText;

      // Mute button
      FX.audio.createMuteButton(this, { x: W - 35, y: 35, size: 18 });
    }

    /**
     * Triggers the full reveal sequence:
     * - Fades out all remaining overlay cells
     * - Big sparkle burst
     * - Success fanfare
     * - Transitions to EndScene
     */
    triggerReveal() {
      if (this.revealTriggered) return;
      this.revealTriggered = true;
      this.gameActive = false;

      var self = this;
      var colors = CONFIG.colors;
      var cd = this.cardDimensions;
      var overlay = this.overlayElements;

      // Stop timer if running
      if (this.timer) {
        this.timer.stop();
      }

      // Complete the progress bar
      this.progressBar.setProgress(1);
      this.progressText.setText('100% revealed');

      // Hide prompt text
      this.tweens.add({
        targets: this.promptText,
        alpha: 0,
        duration: 300
      });

      // Fade out ALL remaining overlay cells with staggered delay
      var remaining = overlay.cells.filter(function (c) { return !c.scratched; });
      var staggerTotal = 600; // Total time for stagger spread
      var perCellDelay = remaining.length > 0 ? staggerTotal / remaining.length : 0;

      for (var i = 0; i < remaining.length; i++) {
        (function (cell, delay) {
          self.tweens.add({
            targets: cell.gfx,
            alpha: 0,
            duration: 300,
            delay: delay,
            ease: 'Power2',
            onComplete: function () { cell.gfx.setVisible(false); }
          });
        })(remaining[i], i * perCellDelay);
      }

      // Fade out overlay decorations
      var decorElements = [overlay.cornerMask, overlay.cMask2, overlay.overlayDecor, overlay.overlayLabel];
      for (var d = 0; d < decorElements.length; d++) {
        this.tweens.add({
          targets: decorElements[d],
          alpha: 0,
          duration: 400,
          delay: 200
        });
      }

      // After overlay clears: big sparkle burst + success sound
      this.time.delayedCall(staggerTotal + 200, function () {
        // Big sparkle burst at card center
        FX.effects.sparkleBurst(self, cd.cx, cd.cy, colors.accent, 20);

        // Confetti burst from card
        FX.effects.confettiBurst(self, cd.cx, cd.cy,
          [colors.primary, colors.accent, '#FFFFFF', colors.secondary], 35);

        // Success fanfare
        FX.audio.playSuccess();

        // Scale-punch the reveal image if it exists
        if (self.revealImg) {
          FX.effects.scalePunch(self, self.revealImg, 1.15, 200);
        }

        // Camera flash for drama
        self.cameras.main.flash(200, 255, 255, 255, true);
      });

      // Transition to EndScene after the celebration
      this.time.delayedCall(staggerTotal + 1200, function () {
        var transition = CONFIG.theme.transitionStyle;
        if (transition === 'zoom') {
          FX.transitions.zoomOut(self, 'EndScene', {});
        } else if (transition === 'flash') {
          FX.transitions.flashTransition(self, 'EndScene', {});
        } else {
          FX.transitions.cinematicFade(self, 'EndScene', {});
        }
      });
    }
  }

  // ═══════════════════════════════════════════════════════════
  // END SCENE — Revealed content showcase, brand message, CTA
  // ═══════════════════════════════════════════════════════════
  class EndScene extends Phaser.Scene {
    constructor() { super('EndScene'); }

    create() {
      FX.transitions.fadeIn(this);
      var colors = CONFIG.colors;
      var texts = CONFIG.texts;

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

      // Celebration title
      var celebTitle = this.add.text(W / 2, H * 0.12, '\u2728 Revealed! \u2728', {
        fontSize: '34px',
        fontFamily: 'Arial',
        fontStyle: 'bold',
        color: colors.accent
      }).setOrigin(0.5).setDepth(10);
      celebTitle.setShadow(2, 2, 'rgba(0,0,0,0.2)', 4);
      FX.effects.bounceIn(this, celebTitle, 100);

      // Reveal image — zoomed to full prominence
      var revealImgKey = CONFIG.assets.revealImage;
      if (revealImgKey && this.textures.exists(revealImgKey)) {
        var revealImg = this.add.image(W / 2, H * 0.34, revealImgKey).setDepth(10);
        var maxW = W * 0.55;
        var maxH = H * 0.25;
        var imgScale = Math.min(maxW / revealImg.width, maxH / revealImg.height, 1);
        revealImg.setScale(0);

        this.tweens.add({
          targets: revealImg,
          scale: imgScale,
          duration: 700,
          ease: 'Back.easeOut',
          delay: 300
        });

        // Glow ring behind product
        FX.effects.glowRing(this, W / 2, H * 0.34, 100, colors.accent);

        // Float idle
        FX.effects.floatIdle(this, revealImg, 5);
      }

      // Reveal message — the main prize/brand message
      var revealMsg = this.add.text(W / 2, H * 0.51, texts.revealMessage, {
        fontSize: '28px',
        fontFamily: 'Arial',
        fontStyle: 'bold',
        color: colors.secondary,
        align: 'center',
        wordWrap: { width: W - 100 }
      }).setOrigin(0.5).setDepth(10).setAlpha(0);

      revealMsg.setShadow(2, 2, 'rgba(0,0,0,0.15)', 4);

      this.tweens.add({
        targets: revealMsg,
        alpha: 1,
        y: H * 0.50,
        duration: 600,
        ease: 'Power2',
        delay: 600
      });

      // Prize text
      if (texts.prizeText) {
        var prize = this.add.text(W / 2, H * 0.58, texts.prizeText, {
          fontSize: '20px',
          fontFamily: 'Arial',
          fontStyle: 'bold',
          color: colors.accent,
          align: 'center',
          wordWrap: { width: W - 120 }
        }).setOrigin(0.5).setDepth(10).setAlpha(0);

        this.tweens.add({
          targets: prize,
          alpha: 1,
          duration: 500,
          delay: 900
        });
      }

      // Logo (if available)
      var logoKey = CONFIG.assets.logo;
      if (logoKey && this.textures.exists(logoKey)) {
        var logo = this.add.image(W / 2, H * 0.65, logoKey).setDepth(10);
        var ls = Math.min(70 / logo.width, 70 / logo.height, 1);
        logo.setScale(0);
        this.tweens.add({
          targets: logo,
          scale: ls,
          duration: 500,
          ease: 'Back.easeOut',
          delay: 1200
        });
      }

      // Confetti burst at center
      this.time.delayedCall(1400, function () {
        FX.effects.confettiBurst(this, W / 2, H * 0.40,
          [colors.primary, colors.accent, colors.secondary, '#FFFFFF'], 50);
        FX.audio.playSuccess();
      }.bind(this));

      // Ambient sparkle field
      FX.effects.ambientSparkle(this, W, H, colors.accent, 'medium');

      // CTA Button
      var ctaBtn = FX.ui.CTAButton(this, W / 2, H * 0.76, texts.ctaText || 'Claim Now', {
        width: 260,
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
        delay: 1800
      });

      // Play Again
      var playAgain = this.add.text(W / 2, H * 0.87, texts.playAgain || 'Play Again', {
        fontSize: '18px',
        fontFamily: 'Arial',
        fontStyle: 'bold',
        color: colors.primary
      }).setOrigin(0.5).setDepth(10).setAlpha(0)
        .setInteractive({ useHandCursor: true });

      this.tweens.add({
        targets: playAgain,
        alpha: 0.7,
        duration: 400,
        delay: 2400
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
