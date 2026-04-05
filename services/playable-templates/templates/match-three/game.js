/**
 * MATCH THREE PUZZLE — Premium Hybrid Template
 *
 * A polished match-3 puzzle with cinematic splash, brand-colored gems
 * in distinct shapes, swap-to-match mechanics, cascades with combo
 * multipliers, sparkle explosions, and gravity drop animations.
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

  // Mix two hex colors (0..1)
  function mixInt(aInt, bInt, t) {
    var ar = (aInt >> 16) & 0xff, ag = (aInt >> 8) & 0xff, ab = aInt & 0xff;
    var br = (bInt >> 16) & 0xff, bg = (bInt >> 8) & 0xff, bb = bInt & 0xff;
    var r = Math.round(ar + (br - ar) * t);
    var g = Math.round(ag + (bg - ag) * t);
    var b = Math.round(ab + (bb - ab) * t);
    return (r << 16) | (g << 8) | b;
  }

  // Lighten/darken color by amount (-1..1)
  function shade(intColor, amount) {
    var r = (intColor >> 16) & 0xff;
    var g = (intColor >> 8) & 0xff;
    var b = intColor & 0xff;
    if (amount >= 0) {
      r = Math.round(r + (255 - r) * amount);
      g = Math.round(g + (255 - g) * amount);
      b = Math.round(b + (255 - b) * amount);
    } else {
      r = Math.round(r * (1 + amount));
      g = Math.round(g * (1 + amount));
      b = Math.round(b * (1 + amount));
    }
    return (r << 16) | (g << 8) | b;
  }

  // Derive a palette of N gem colors from brand colors
  function deriveGemPalette(colors, n) {
    var p = hexToInt(colors.primary);
    var s = hexToInt(colors.secondary);
    var a = hexToInt(colors.accent);
    // Base candidates: primary, accent, mix, shaded variants
    var candidates = [
      p,
      a,
      mixInt(p, a, 0.5),
      shade(p, 0.35),
      shade(a, -0.25),
      mixInt(p, s, 0.4)
    ];
    // Ensure visual separation: if a candidate is too close to a neighbour, shade it
    var out = [];
    for (var i = 0; i < n; i++) {
      out.push(candidates[i % candidates.length]);
    }
    return out;
  }

  // Gem shape names
  var GEM_SHAPES = ['diamond', 'circle', 'square', 'hexagon', 'triangle', 'star'];

  // Draw a gem shape into a Graphics object at (0,0), scaled to fit radius r
  function drawGemShape(g, shape, r, fillColor, alpha) {
    alpha = (alpha == null) ? 1 : alpha;
    g.fillStyle(fillColor, alpha);
    if (shape === 'circle') {
      g.fillCircle(0, 0, r);
    } else if (shape === 'square') {
      g.fillRoundedRect(-r, -r, r * 2, r * 2, r * 0.22);
    } else if (shape === 'diamond') {
      g.fillPoints([
        { x: 0, y: -r },
        { x: r, y: 0 },
        { x: 0, y: r },
        { x: -r, y: 0 }
      ], true);
    } else if (shape === 'hexagon') {
      var hexPts = [];
      for (var i = 0; i < 6; i++) {
        var ang = Math.PI / 2 + i * (Math.PI * 2 / 6);
        hexPts.push({ x: Math.cos(ang) * r, y: -Math.sin(ang) * r });
      }
      g.fillPoints(hexPts, true);
    } else if (shape === 'triangle') {
      g.fillPoints([
        { x: 0, y: -r },
        { x: r * 0.95, y: r * 0.75 },
        { x: -r * 0.95, y: r * 0.75 }
      ], true);
    } else if (shape === 'star') {
      var starPts = [];
      for (var j = 0; j < 10; j++) {
        var rr = (j % 2 === 0) ? r : r * 0.48;
        var a2 = Math.PI / 2 + j * (Math.PI / 5);
        starPts.push({ x: Math.cos(a2) * rr, y: -Math.sin(a2) * rr });
      }
      g.fillPoints(starPts, true);
    }
  }

  // Build a premium gem container (shadow + shape + highlight + inner sparkle)
  function buildGem(scene, shape, color, r) {
    var c = scene.add.container(0, 0);

    // Drop shadow
    var shadow = scene.add.graphics();
    shadow.fillStyle(0x000000, 0.18);
    if (shape === 'circle') {
      shadow.fillCircle(2, 4, r);
    } else if (shape === 'square') {
      shadow.fillRoundedRect(-r + 2, -r + 4, r * 2, r * 2, r * 0.22);
    } else {
      drawGemShape(shadow, shape, r, 0x000000, 0.18);
      shadow.x = 2; shadow.y = 4;
    }
    c.add(shadow);

    // Base fill (darker edge)
    var base = scene.add.graphics();
    drawGemShape(base, shape, r, shade(color, -0.22), 1);
    c.add(base);

    // Main fill
    var main = scene.add.graphics();
    drawGemShape(main, shape, r * 0.94, color, 1);
    c.add(main);

    // Inner highlight (top-left glossy)
    var gloss = scene.add.graphics();
    gloss.fillStyle(0xffffff, 0.35);
    if (shape === 'circle') {
      gloss.fillEllipse(-r * 0.32, -r * 0.38, r * 0.55, r * 0.35);
    } else {
      gloss.fillEllipse(-r * 0.3, -r * 0.38, r * 0.5, r * 0.28);
    }
    c.add(gloss);

    // Tiny sparkle dot
    var dot = scene.add.graphics();
    dot.fillStyle(0xffffff, 0.8);
    dot.fillCircle(-r * 0.18, -r * 0.44, r * 0.07);
    c.add(dot);

    c.setSize(r * 2, r * 2);
    c._shape = shape;
    c._color = color;
    c._radius = r;
    return c;
  }

  // ═══════════════════════════════════════════════════════════
  // BOOT SCENE — Cinematic splash with floating gems demo
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
      FX.effects.generateTextures(this);
      FX.audio.init(this);

      var colors = CONFIG.colors;
      var texts = CONFIG.texts;
      var gameplay = CONFIG.gameplay;

      // Background
      this.cameras.main.setBackgroundColor(colors.background);
      FX.ambient.GradientBackground(this, {
        colorTop: colors.primary,
        colorBottom: colors.background,
        colorShift: colors.accent,
        duration: 6000
      });
      FX.ambient.FloatingShapes(this, { color: colors.primary, count: 8 });
      FX.ambient.LightRays(this, { color: colors.accent, count: 2 });
      FX.ambient.VignetteOverlay(this, { intensity: 0.28 });
      FX.ambient.FloatingParticles(this, { color: colors.accent, density: 'low' });

      // Floating demo gems drifting in the background
      var palette = deriveGemPalette(colors, gameplay.gemTypes);
      var demoGems = [];
      for (var i = 0; i < 7; i++) {
        var shape = GEM_SHAPES[i % gameplay.gemTypes];
        var color = palette[i % palette.length];
        var gx = Phaser.Math.Between(60, W - 60);
        var gy = Phaser.Math.Between(H * 0.15, H * 0.9);
        var size = Phaser.Math.Between(22, 34);
        var gem = buildGem(this, shape, color, size);
        gem.x = gx; gem.y = gy;
        gem.setAlpha(0.35);
        gem.setDepth(2);
        this.add.existing(gem);
        demoGems.push(gem);

        // Gentle float + rotate
        this.tweens.add({
          targets: gem,
          y: gy - Phaser.Math.Between(18, 30),
          duration: Phaser.Math.Between(2200, 3400),
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut',
          delay: i * 120
        });
        this.tweens.add({
          targets: gem,
          angle: Phaser.Math.Between(-12, 12),
          duration: Phaser.Math.Between(2600, 3800),
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut'
        });
      }

      // Logo
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

      // Title
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

      // Tap to Start
      var tapText = this.add.text(W / 2, H * 0.76, 'Tap to Start', {
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

      FX.audio.createMuteButton(this, { x: W - 35, y: 35, size: 22 });

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
  // GAME SCENE — Match-3 puzzle core
  // ═══════════════════════════════════════════════════════════
  class GameScene extends Phaser.Scene {
    constructor() { super('GameScene'); }

    create() {
      var self = this;
      FX.transitions.fadeIn(this);

      var colors = CONFIG.colors;
      var gameplay = CONFIG.gameplay;

      this.score = 0;
      this.gameActive = true;
      this.busy = false; // prevents input during animations
      this.cols = Phaser.Math.Clamp(gameplay.gridCols || 6, 4, 8);
      this.rows = Phaser.Math.Clamp(gameplay.gridRows || 6, 4, 8);
      this.gemTypes = Phaser.Math.Clamp(gameplay.gemTypes || 5, 4, 6);
      this.palette = deriveGemPalette(colors, this.gemTypes);
      this.shapes = GEM_SHAPES.slice(0, this.gemTypes);

      // Background
      this.cameras.main.setBackgroundColor(colors.background);
      var bgStyle = CONFIG.theme.backgroundStyle;
      if (bgStyle === 'gradient_shift') {
        FX.ambient.GradientBackground(this, {
          colorTop: colors.background,
          colorBottom: colors.primary,
          colorShift: colors.accent,
          duration: 12000
        });
      } else if (bgStyle === 'floating_shapes') {
        FX.ambient.FloatingShapes(this, { color: colors.primary, count: 6 });
      } else if (bgStyle === 'parallax') {
        FX.ambient.ParallaxLayers(this, { color: colors.primary, layers: 3 });
      }
      FX.ambient.FloatingParticles(this, {
        color: colors.accent,
        density: CONFIG.theme.particleDensity || 'medium'
      });

      // HUD
      this.scoreDisplay = FX.ui.AnimatedScore(this, W / 2, 48, {
        label: CONFIG.texts.scoreLabel || 'Score',
        color: colors.secondary,
        accentColor: colors.accent,
        fontSize: 28
      });

      // Target label (under score area, top-right)
      var targetText = this.add.text(W - 24, 32,
        (CONFIG.texts.targetLabel || 'Target') + ': ' + gameplay.targetScore, {
        fontSize: '16px', fontFamily: 'Arial', fontStyle: 'bold',
        color: colors.secondary
      }).setOrigin(1, 0.5).setDepth(100).setAlpha(0.85);
      this.targetText = targetText;

      // Circular countdown timer (top-left)
      this.timer = FX.ui.CircularTimer(this, 56, 50, {
        radius: 24,
        thickness: 5,
        fillColor: colors.primary,
        textColor: colors.secondary
      });
      this.timer.onComplete = function () { self.endGame(); };
      this.timer.start(gameplay.duration);

      // Compute grid layout
      var padding = 24;
      var boardTop = 110;
      var boardBottom = H - 60;
      var availW = W - padding * 2;
      var availH = boardBottom - boardTop;
      this.cell = Math.floor(Math.min(availW / this.cols, availH / this.rows));
      this.gemRadius = Math.floor(this.cell * 0.42);
      this.boardX = Math.floor((W - this.cell * this.cols) / 2);
      this.boardY = Math.floor(boardTop + (availH - this.cell * this.rows) / 2);

      // Board background panel
      var panelW = this.cell * this.cols + 16;
      var panelH = this.cell * this.rows + 16;
      var panel = this.add.graphics().setDepth(3);
      panel.fillStyle(0x000000, 0.06);
      panel.fillRoundedRect(
        this.boardX - 8, this.boardY - 8,
        panelW, panelH, 14
      );
      panel.lineStyle(2, hexToInt(colors.primary), 0.15);
      panel.strokeRoundedRect(
        this.boardX - 8, this.boardY - 8,
        panelW, panelH, 14
      );

      // Grid cell hints
      var hints = this.add.graphics().setDepth(4);
      hints.fillStyle(0xffffff, 0.35);
      for (var r = 0; r < this.rows; r++) {
        for (var c = 0; c < this.cols; c++) {
          if ((r + c) % 2 === 0) {
            hints.fillRoundedRect(
              this.boardX + c * this.cell + 2,
              this.boardY + r * this.cell + 2,
              this.cell - 4, this.cell - 4, 6
            );
          }
        }
      }

      // Generate initial board (no matches at start)
      this.grid = this.generateInitialGrid();
      this.renderBoard();

      // Input
      this.selected = null;
      this.selectedRing = null;

      this.input.on('pointerdown', function (pointer) {
        if (!self.gameActive || self.busy) return;
        self.handleTap(pointer.x, pointer.y);
      });

      // Combo tracker
      this.cascadeCount = 0;

      FX.audio.createMuteButton(this, { x: 24, y: H - 30, size: 16 });
    }

    // ─────────────────────────────────────────────────────────
    // Grid generation — no initial matches
    // ─────────────────────────────────────────────────────────
    generateInitialGrid() {
      var grid = [];
      for (var r = 0; r < this.rows; r++) {
        grid[r] = [];
        for (var c = 0; c < this.cols; c++) {
          var forbidden = {};
          // Same as two to the left
          if (c >= 2 && grid[r][c - 1] === grid[r][c - 2]) {
            forbidden[grid[r][c - 1]] = true;
          }
          // Same as two above
          if (r >= 2 && grid[r - 1][c] === grid[r - 2][c]) {
            forbidden[grid[r - 1][c]] = true;
          }
          var t;
          var attempts = 0;
          do {
            t = Phaser.Math.Between(0, this.gemTypes - 1);
            attempts++;
          } while (forbidden[t] && attempts < 20);
          grid[r][c] = t;
        }
      }
      return grid;
    }

    // ─────────────────────────────────────────────────────────
    // Render board — create gem objects matching grid
    // ─────────────────────────────────────────────────────────
    renderBoard() {
      this.gems = [];
      for (var r = 0; r < this.rows; r++) {
        this.gems[r] = [];
        for (var c = 0; c < this.cols; c++) {
          var type = this.grid[r][c];
          var gem = this.createGem(type);
          var pos = this.cellToXY(r, c);
          gem.x = pos.x;
          gem.y = pos.y - 240;
          gem.setDepth(10);
          this.gems[r][c] = gem;

          // Drop-in entrance
          this.tweens.add({
            targets: gem,
            y: pos.y,
            duration: 520,
            ease: 'Bounce.easeOut',
            delay: (r * 40) + (c * 25)
          });
        }
      }
    }

    createGem(type) {
      var shape = this.shapes[type];
      var color = this.palette[type];
      var gem = buildGem(this, shape, color, this.gemRadius);
      gem._type = type;
      this.add.existing(gem);
      return gem;
    }

    cellToXY(r, c) {
      return {
        x: this.boardX + c * this.cell + this.cell / 2,
        y: this.boardY + r * this.cell + this.cell / 2
      };
    }

    xyToCell(x, y) {
      var c = Math.floor((x - this.boardX) / this.cell);
      var r = Math.floor((y - this.boardY) / this.cell);
      if (r < 0 || r >= this.rows || c < 0 || c >= this.cols) return null;
      return { r: r, c: c };
    }

    // ─────────────────────────────────────────────────────────
    // Input handling
    // ─────────────────────────────────────────────────────────
    handleTap(x, y) {
      var cell = this.xyToCell(x, y);
      if (!cell) { this.clearSelection(); return; }

      if (!this.selected) {
        this.setSelection(cell.r, cell.c);
        return;
      }

      // Tapped same — deselect
      if (this.selected.r === cell.r && this.selected.c === cell.c) {
        this.clearSelection();
        return;
      }

      // Tapped adjacent — attempt swap
      var dr = Math.abs(cell.r - this.selected.r);
      var dc = Math.abs(cell.c - this.selected.c);
      if (dr + dc === 1) {
        var a = this.selected;
        this.clearSelection();
        this.attemptSwap(a.r, a.c, cell.r, cell.c);
      } else {
        // Non-adjacent — reselect
        this.setSelection(cell.r, cell.c);
      }
    }

    setSelection(r, c) {
      this.clearSelection();
      this.selected = { r: r, c: c };
      var pos = this.cellToXY(r, c);
      var colors = CONFIG.colors;

      var ring = this.add.graphics().setDepth(15);
      ring.lineStyle(3, hexToInt(colors.accent), 1);
      ring.strokeCircle(0, 0, this.gemRadius + 8);
      ring.x = pos.x; ring.y = pos.y;
      this.selectedRing = ring;

      this.tweens.add({
        targets: ring,
        scale: { from: 0.85, to: 1.1 },
        alpha: { from: 1, to: 0.5 },
        duration: 600,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut'
      });

      // Scale pulse on selected gem
      var gem = this.gems[r][c];
      if (gem) {
        this.tweens.add({
          targets: gem,
          scale: { from: 1, to: 1.12 },
          duration: 400,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut'
        });
      }

      FX.audio.playTap();
    }

    clearSelection() {
      if (this.selectedRing) {
        this.selectedRing.destroy();
        this.selectedRing = null;
      }
      if (this.selected) {
        var g = this.gems[this.selected.r] && this.gems[this.selected.r][this.selected.c];
        if (g) {
          this.tweens.killTweensOf(g);
          g.setScale(1);
        }
      }
      this.selected = null;
    }

    // ─────────────────────────────────────────────────────────
    // Swap logic
    // ─────────────────────────────────────────────────────────
    attemptSwap(r1, c1, r2, c2) {
      var self = this;
      this.busy = true;

      var g1 = this.gems[r1][c1];
      var g2 = this.gems[r2][c2];
      if (!g1 || !g2) { this.busy = false; return; }

      var p1 = this.cellToXY(r1, c1);
      var p2 = this.cellToXY(r2, c2);

      // Swap in grid + gems arrays immediately
      var tmpT = this.grid[r1][c1];
      this.grid[r1][c1] = this.grid[r2][c2];
      this.grid[r2][c2] = tmpT;
      this.gems[r1][c1] = g2;
      this.gems[r2][c2] = g1;

      // Animate positions
      var done = 0;
      var finish = function () {
        done++;
        if (done < 2) return;
        // Check for matches
        var matches = self.findMatches();
        if (matches.length === 0) {
          // Swap back
          FX.audio.playFail();
          var tT = self.grid[r1][c1];
          self.grid[r1][c1] = self.grid[r2][c2];
          self.grid[r2][c2] = tT;
          self.gems[r1][c1] = g1;
          self.gems[r2][c2] = g2;

          var back = 0;
          var bf = function () { back++; if (back >= 2) self.busy = false; };
          self.tweens.add({ targets: g1, x: p1.x, y: p1.y, duration: 260, ease: 'Back.easeOut', onComplete: bf });
          self.tweens.add({ targets: g2, x: p2.x, y: p2.y, duration: 260, ease: 'Back.easeOut', onComplete: bf });
        } else {
          // Resolve matches with cascades
          self.cascadeCount = 0;
          self.resolveMatches(matches);
        }
      };

      this.tweens.add({ targets: g1, x: p2.x, y: p2.y, duration: 300, ease: 'Sine.easeInOut', onComplete: finish });
      this.tweens.add({ targets: g2, x: p1.x, y: p1.y, duration: 300, ease: 'Sine.easeInOut', onComplete: finish });

      FX.audio.playTap();
    }

    // ─────────────────────────────────────────────────────────
    // Match detection — scan rows & cols for 3+ runs
    // Returns array of { cells: [{r,c}...], length }
    // ─────────────────────────────────────────────────────────
    findMatches() {
      var matches = [];
      var marked = {};
      var key = function (r, c) { return r + '_' + c; };

      // Horizontal runs
      for (var r = 0; r < this.rows; r++) {
        var runStart = 0;
        for (var c = 1; c <= this.cols; c++) {
          var curr = (c < this.cols) ? this.grid[r][c] : -1;
          var prev = this.grid[r][c - 1];
          if (curr !== prev || prev == null) {
            var len = c - runStart;
            if (len >= 3) {
              var cells = [];
              for (var k = runStart; k < c; k++) {
                cells.push({ r: r, c: k });
                marked[key(r, k)] = true;
              }
              matches.push({ cells: cells, length: len });
            }
            runStart = c;
          }
        }
      }

      // Vertical runs
      for (var col = 0; col < this.cols; col++) {
        var rs = 0;
        for (var rr = 1; rr <= this.rows; rr++) {
          var cu = (rr < this.rows) ? this.grid[rr][col] : -1;
          var pv = this.grid[rr - 1][col];
          if (cu !== pv || pv == null) {
            var ll = rr - rs;
            if (ll >= 3) {
              var cellsV = [];
              for (var m = rs; m < rr; m++) {
                cellsV.push({ r: m, c: col });
                marked[key(m, col)] = true;
              }
              matches.push({ cells: cellsV, length: ll });
            }
            rs = rr;
          }
        }
      }

      return matches;
    }

    // ─────────────────────────────────────────────────────────
    // Resolve matches — explode, drop, refill, re-scan
    // ─────────────────────────────────────────────────────────
    resolveMatches(matches) {
      var self = this;
      var gameplay = CONFIG.gameplay;
      var colors = CONFIG.colors;
      this.cascadeCount++;

      // Calculate points
      var basePts = 0;
      var totalGems = 0;
      for (var i = 0; i < matches.length; i++) {
        var m = matches[i];
        totalGems += m.cells.length;
        if (m.length === 3) basePts += gameplay.pointsPer3;
        else if (m.length === 4) basePts += gameplay.pointsPer4;
        else basePts += gameplay.pointsPer5;
      }

      var multiplier = 1 + (this.cascadeCount - 1) * (gameplay.comboMultiplier - 1);
      var awarded = Math.round(basePts * multiplier);
      this.score += awarded;
      this.scoreDisplay.add(awarded);

      // Score popup at first match center
      var first = matches[0].cells[Math.floor(matches[0].cells.length / 2)];
      var fxy = this.cellToXY(first.r, first.c);
      FX.effects.scorePopup(this, fxy.x, fxy.y, '+' + awarded, colors.accent);

      // Combo message on cascade
      if (this.cascadeCount >= 2) {
        var template = CONFIG.texts.comboMessage || 'Combo x{x}!';
        var msg = template.replace('{x}', this.cascadeCount);
        var cmb = this.add.text(W / 2, H * 0.35, msg, {
          fontSize: '38px', fontFamily: 'Arial', fontStyle: 'bold',
          color: colors.accent, stroke: colors.secondary, strokeThickness: 4
        }).setOrigin(0.5).setDepth(200).setScale(0);
        this.tweens.add({
          targets: cmb,
          scale: 1.2,
          alpha: { from: 1, to: 0 },
          y: H * 0.30,
          duration: 900,
          ease: 'Power2',
          onComplete: function () { cmb.destroy(); }
        });
      }

      // Random encouragement on large matches
      var biggest = 0;
      for (var b = 0; b < matches.length; b++) {
        if (matches[b].length > biggest) biggest = matches[b].length;
      }
      if (biggest >= 4 && CONFIG.texts.encouragement && CONFIG.texts.encouragement.length) {
        var enc = CONFIG.texts.encouragement[
          Phaser.Math.Between(0, CONFIG.texts.encouragement.length - 1)
        ];
        var et = this.add.text(W / 2, H * 0.42, enc, {
          fontSize: '26px', fontFamily: 'Arial', fontStyle: 'bold',
          color: colors.primary, stroke: '#ffffff', strokeThickness: 3
        }).setOrigin(0.5).setDepth(200).setScale(0);
        this.tweens.add({
          targets: et,
          scale: 1.1,
          alpha: { from: 1, to: 0 },
          y: H * 0.38,
          duration: 800,
          ease: 'Power2',
          onComplete: function () { et.destroy(); }
        });
      }

      FX.audio.playScore();
      FX.effects.screenShake(this, 0.004, 100);

      // Build set of matched cells
      var removeSet = {};
      var keyOf = function (r, c) { return r + '_' + c; };
      for (var x = 0; x < matches.length; x++) {
        for (var y = 0; y < matches[x].cells.length; y++) {
          var cc = matches[x].cells[y];
          removeSet[keyOf(cc.r, cc.c)] = cc;
        }
      }

      // Explode all matched gems
      var matchedKeys = Object.keys(removeSet);
      for (var mk = 0; mk < matchedKeys.length; mk++) {
        var ck = removeSet[matchedKeys[mk]];
        var gem = this.gems[ck.r][ck.c];
        if (!gem) continue;
        var gxy = this.cellToXY(ck.r, ck.c);
        FX.effects.sparkleBurst(this, gxy.x, gxy.y, colors.accent, 7);
        this.tweens.add({
          targets: gem,
          scale: 1.5,
          alpha: 0,
          angle: Phaser.Math.Between(-90, 90),
          duration: 200,
          ease: 'Power2',
          onComplete: function (tween, targets) { targets[0].destroy(); }
        });
        this.grid[ck.r][ck.c] = null;
        this.gems[ck.r][ck.c] = null;
      }

      // After explosion, drop & refill
      this.time.delayedCall(220, function () {
        self.dropAndRefill(function () {
          // Check for cascade
          var newMatches = self.findMatches();
          if (newMatches.length > 0) {
            self.resolveMatches(newMatches);
          } else {
            self.cascadeCount = 0;
            self.busy = false;
            // Check for deadlock
            if (!self.hasValidMoves()) {
              self.reshuffleBoard();
            }
          }
        });
      });
    }

    // ─────────────────────────────────────────────────────────
    // Drop gems into gaps, spawn new ones at top
    // ─────────────────────────────────────────────────────────
    dropAndRefill(onDone) {
      var self = this;
      var pending = 0;
      var completed = 0;
      var finished = false;

      var tryDone = function () {
        if (!finished && completed >= pending) {
          finished = true;
          onDone();
        }
      };

      for (var c = 0; c < this.cols; c++) {
        // Compact existing gems downward per column
        var writeRow = this.rows - 1;
        for (var r = this.rows - 1; r >= 0; r--) {
          if (this.grid[r][c] != null) {
            if (writeRow !== r) {
              this.grid[writeRow][c] = this.grid[r][c];
              this.grid[r][c] = null;
              var gm = this.gems[r][c];
              this.gems[writeRow][c] = gm;
              this.gems[r][c] = null;

              var targetPos = this.cellToXY(writeRow, c);
              pending++;
              var drop = writeRow - r;
              this.tweens.add({
                targets: gm,
                y: targetPos.y,
                duration: 300 + drop * 60,
                ease: 'Bounce.easeOut',
                delay: c * 20,
                onComplete: function () { completed++; tryDone(); }
              });
            }
            writeRow--;
          }
        }
        // Fill empty rows at top with new gems
        for (var nr = writeRow; nr >= 0; nr--) {
          var newType = Phaser.Math.Between(0, this.gemTypes - 1);
          this.grid[nr][c] = newType;
          var newGem = this.createGem(newType);
          var endPos = this.cellToXY(nr, c);
          // Start above board
          newGem.x = endPos.x;
          newGem.y = this.boardY - (writeRow - nr + 1) * this.cell - 20;
          newGem.setDepth(10);
          this.gems[nr][c] = newGem;

          pending++;
          var dist = endPos.y - newGem.y;
          var dur = 380 + (dist / this.cell) * 45;
          this.tweens.add({
            targets: newGem,
            y: endPos.y,
            duration: dur,
            ease: 'Bounce.easeOut',
            delay: c * 20 + 40,
            onComplete: function () { completed++; tryDone(); }
          });
        }
      }

      if (pending === 0) {
        onDone();
      }
    }

    // ─────────────────────────────────────────────────────────
    // Check if any valid swap creates a match (deadlock detection)
    // ─────────────────────────────────────────────────────────
    hasValidMoves() {
      for (var r = 0; r < this.rows; r++) {
        for (var c = 0; c < this.cols; c++) {
          // Try swap right
          if (c + 1 < this.cols) {
            var t = this.grid[r][c];
            this.grid[r][c] = this.grid[r][c + 1];
            this.grid[r][c + 1] = t;
            var hasM = this.findMatches().length > 0;
            t = this.grid[r][c];
            this.grid[r][c] = this.grid[r][c + 1];
            this.grid[r][c + 1] = t;
            if (hasM) return true;
          }
          // Try swap down
          if (r + 1 < this.rows) {
            var t2 = this.grid[r][c];
            this.grid[r][c] = this.grid[r + 1][c];
            this.grid[r + 1][c] = t2;
            var hasM2 = this.findMatches().length > 0;
            t2 = this.grid[r][c];
            this.grid[r][c] = this.grid[r + 1][c];
            this.grid[r + 1][c] = t2;
            if (hasM2) return true;
          }
        }
      }
      return false;
    }

    reshuffleBoard() {
      var self = this;
      this.busy = true;
      // Fade out all gems, regenerate, fade in
      var all = [];
      for (var r = 0; r < this.rows; r++) {
        for (var c = 0; c < this.cols; c++) {
          if (this.gems[r][c]) all.push(this.gems[r][c]);
        }
      }
      this.tweens.add({
        targets: all,
        alpha: 0,
        scale: 0,
        angle: 180,
        duration: 300,
        ease: 'Power2',
        onComplete: function () {
          for (var i = 0; i < all.length; i++) all[i].destroy();
          self.grid = self.generateInitialGrid();
          self.renderBoard();
          self.time.delayedCall(self.rows * 40 + self.cols * 25 + 600, function () {
            self.busy = false;
          });
        }
      });
    }

    // ─────────────────────────────────────────────────────────
    // End game
    // ─────────────────────────────────────────────────────────
    endGame() {
      if (!this.gameActive) return;
      this.gameActive = false;
      this.busy = true;
      if (this.timer) this.timer.stop();
      this.clearSelection();

      FX.audio.playWhoosh();

      var self = this;
      this.time.delayedCall(300, function () {
        var transition = CONFIG.theme.transitionStyle;
        var data = { score: self.score };
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
  // END SCENE — Score, stars, confetti, CTA
  // ═══════════════════════════════════════════════════════════
  class EndScene extends Phaser.Scene {
    constructor() { super('EndScene'); }

    create(data) {
      FX.transitions.fadeIn(this);
      var colors = CONFIG.colors;
      var texts = CONFIG.texts;
      var gameplay = CONFIG.gameplay;
      var score = data.score || 0;
      var target = gameplay.targetScore;
      var won = score >= target;

      this.cameras.main.setBackgroundColor(colors.background);
      FX.ambient.GradientBackground(this, {
        colorTop: colors.primary,
        colorBottom: colors.background,
        colorShift: colors.accent,
        duration: 5000
      });
      FX.ambient.FloatingParticles(this, { color: colors.accent, density: 'medium' });
      FX.ambient.VignetteOverlay(this, { intensity: 0.25 });

      // Title
      var headline = won ? (texts.winMessage || 'You Won!') : (texts.loseMessage || 'So Close!');
      var title = this.add.text(W / 2, H * 0.18, headline, {
        fontSize: '40px', fontFamily: 'Arial', fontStyle: 'bold',
        color: colors.secondary
      }).setOrigin(0.5).setDepth(10);
      title.setShadow(2, 2, 'rgba(0,0,0,0.2)', 4);
      FX.effects.bounceIn(this, title, 100);

      // Score count-up
      var scoreDisplay = FX.ui.AnimatedScore(this, W / 2, H * 0.30, {
        label: texts.scoreLabel || 'Score',
        color: colors.secondary,
        accentColor: colors.accent,
        fontSize: 48
      });
      this.time.delayedCall(500, function () {
        scoreDisplay.countUpFrom(0, score, 1500);
      });

      // Target line under score
      this.add.text(W / 2, H * 0.38,
        (texts.targetLabel || 'Target') + ': ' + target, {
        fontSize: '18px', fontFamily: 'Arial', fontStyle: 'bold',
        color: colors.secondary
      }).setOrigin(0.5).setDepth(10).setAlpha(0.7);

      // Star rating based on score/target
      var pct = target > 0 ? score / target : 0;
      var starCount = pct >= 1.3 ? 3 : pct >= 1.0 ? 2 : pct >= 0.6 ? 1 : 0;

      var stars = FX.ui.StarRating(this, W / 2, H * 0.46, {
        maxStars: 3,
        starSize: 42,
        filledColor: colors.accent,
        emptyColor: '#CBD5E1'
      });
      this.time.delayedCall(2000, function () {
        stars.fill(Math.max(starCount, won ? 1 : 0));
      });

      // Confetti if target met
      if (won) {
        this.time.delayedCall(2600, function () {
          FX.effects.confettiBurst(this, W / 2, H * 0.4,
            [colors.primary, colors.accent, colors.secondary, '#FFFFFF'], 55);
          FX.audio.playSuccess();
        }.bind(this));
      }

      // Logo
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

      // CTA
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
