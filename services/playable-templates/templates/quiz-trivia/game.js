/**
 * QUIZ TRIVIA — Premium Hybrid Template
 *
 * A polished brand quiz game with cinematic splash, animated question cards,
 * per-question timers, speed bonuses, correct/incorrect feedback, and a
 * star-rated end screen with confetti.
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

  function clampQuestions(all, count) {
    if (!Array.isArray(all) || all.length === 0) return [];
    var n = Math.max(1, Math.min(count || all.length, all.length));
    return all.slice(0, n);
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

      // Light rays for cinematic feel
      FX.ambient.LightRays(this, { color: colors.accent, count: 2 });

      // Vignette
      FX.ambient.VignetteOverlay(this, { intensity: 0.3 });

      // Ambient particles
      FX.ambient.FloatingParticles(this, { color: colors.accent, density: 'low' });

      // Logo (if available)
      var logoKey = CONFIG.assets && CONFIG.assets.logo;
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

      // Title text — scale reveal
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
        var sub = this.add.text(W / 2, H * 0.56, texts.subtitle, {
          fontSize: '20px',
          fontFamily: 'Arial',
          color: colors.secondary,
          align: 'center',
          wordWrap: { width: W - 100 }
        }).setOrigin(0.5).setDepth(10).setAlpha(0);

        this.tweens.add({
          targets: sub,
          alpha: 0.75,
          duration: 500,
          delay: 900
        });
      }

      // Decorative quiz badges "?" floating
      for (var i = 0; i < 3; i++) {
        var bx = W * (0.18 + i * 0.32);
        var by = H * 0.66;
        var badge = this.add.container(bx, by).setDepth(8).setAlpha(0);
        var ring = this.add.graphics();
        ring.fillStyle(hexToInt(colors.primary), 0.15);
        ring.fillCircle(0, 0, 26);
        ring.lineStyle(2, hexToInt(colors.primary), 0.5);
        ring.strokeCircle(0, 0, 26);
        badge.add(ring);
        var q = this.add.text(0, 0, '?', {
          fontSize: '28px', fontFamily: 'Arial', fontStyle: 'bold',
          color: colors.primary
        }).setOrigin(0.5);
        badge.add(q);
        this.tweens.add({
          targets: badge,
          alpha: 1,
          y: by - 6,
          duration: 500,
          delay: 1000 + i * 120,
          ease: 'Power2'
        });
        FX.effects.floatIdle(this, badge, 5);
      }

      // "Tap to Start" — pulsing
      var tapText = this.add.text(W / 2, H * 0.80, texts.tapToStart || 'Tap to Start', {
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
  // GAME SCENE — Quiz gameplay
  // ═══════════════════════════════════════════════════════════
  class GameScene extends Phaser.Scene {
    constructor() { super('GameScene'); }

    create() {
      var self = this;
      FX.transitions.fadeIn(this);

      var colors = CONFIG.colors;
      var gameplay = CONFIG.gameplay;

      // Resolve questions (trim to questionCount)
      this.questions = clampQuestions(CONFIG.questions, gameplay.questionCount);
      this.totalQuestions = this.questions.length;
      this.currentIndex = 0;
      this.score = 0;
      this.correctCount = 0;
      this.locked = false;
      this.questionTimer = null;
      this.timeRemaining = gameplay.timePerQuestion;

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
        FX.ambient.FloatingShapes(this, { color: colors.primary, count: 8 });
      } else if (bgStyle === 'parallax') {
        FX.ambient.ParallaxLayers(this, { color: colors.primary, layers: 3 });
      }

      FX.ambient.FloatingParticles(this, {
        color: colors.accent,
        density: CONFIG.theme.particleDensity || 'medium'
      });

      FX.ambient.VignetteOverlay(this, { intensity: 0.2 });

      // ── Top HUD ─────────────────────────────────────────────
      // Progress bar across top
      this.progressBar = FX.ui.ProgressBar(this, W / 2, 28, {
        width: W - 120,
        height: 10,
        bgColor: colors.secondary,
        fillColor: colors.accent,
        radius: 5
      });
      this.progressBar.setProgress(0, false);

      // Question counter (Q 1/5) — left
      var counterLabel = CONFIG.texts.questionLabel || 'Q';
      this.counterText = this.add.text(60, 28, counterLabel + ' 1/' + this.totalQuestions, {
        fontSize: '16px', fontFamily: 'Arial', fontStyle: 'bold',
        color: colors.secondary
      }).setOrigin(0.5).setDepth(100);

      // Circular score display — right corner
      this.scoreContainer = this.add.container(W - 60, 68).setDepth(100);
      var scoreRingBg = this.add.graphics();
      scoreRingBg.fillStyle(hexToInt(colors.primary), 1);
      scoreRingBg.fillCircle(0, 0, 32);
      scoreRingBg.lineStyle(3, hexToInt(colors.accent), 1);
      scoreRingBg.strokeCircle(0, 0, 32);
      this.scoreContainer.add(scoreRingBg);

      this.scoreValueText = this.add.text(0, -2, '0', {
        fontSize: '22px', fontFamily: 'Arial', fontStyle: 'bold',
        color: '#FFFFFF'
      }).setOrigin(0.5);
      this.scoreContainer.add(this.scoreValueText);

      var scoreLabel = this.add.text(0, 14, 'PTS', {
        fontSize: '9px', fontFamily: 'Arial', fontStyle: 'bold',
        color: '#FFFFFF'
      }).setOrigin(0.5).setAlpha(0.85);
      this.scoreContainer.add(scoreLabel);

      // ── Timer bar at bottom ─────────────────────────────────
      var barWidth = W - 100;
      var barY = H - 50;
      this.timerBarBg = this.add.graphics().setDepth(100);
      this.timerBarBg.fillStyle(hexToInt(colors.secondary), 0.25);
      this.timerBarBg.fillRoundedRect(W / 2 - barWidth / 2, barY - 6, barWidth, 12, 6);

      this.timerBarFill = this.add.graphics().setDepth(101);
      this.timerBarWidth = barWidth;
      this.timerBarY = barY;

      this.timerLabel = this.add.text(W / 2, barY - 24, '', {
        fontSize: '14px', fontFamily: 'Arial', fontStyle: 'bold',
        color: colors.secondary
      }).setOrigin(0.5).setDepth(100).setAlpha(0.7);

      // Question card container — will hold current question UI
      this.questionLayer = this.add.container(0, 0).setDepth(50);

      // Mute button
      FX.audio.createMuteButton(this, { x: 35, y: H - 90, size: 18 });

      // Kick off first question
      this.time.delayedCall(300, function () { self.showQuestion(); });
    }

    drawTimerBar(pct) {
      var colors = CONFIG.colors;
      var warnColor = pct < 0.25 ? (colors.incorrect || '#EF4444')
                   : pct < 0.5  ? (colors.accent || '#F59E0B')
                   : (colors.primary || '#6366F1');
      this.timerBarFill.clear();
      var w = Math.max(0, Math.min(1, pct)) * this.timerBarWidth;
      if (w > 0) {
        this.timerBarFill.fillStyle(hexToInt(warnColor), 1);
        this.timerBarFill.fillRoundedRect(
          W / 2 - this.timerBarWidth / 2,
          this.timerBarY - 6,
          w, 12, 6
        );
      }
    }

    showQuestion() {
      var self = this;
      var colors = CONFIG.colors;
      var gameplay = CONFIG.gameplay;
      var q = this.questions[this.currentIndex];
      if (!q) { this.finishQuiz(); return; }

      this.locked = false;
      this.timeRemaining = gameplay.timePerQuestion;

      // Update counter
      var counterLabel = CONFIG.texts.questionLabel || 'Q';
      this.counterText.setText(counterLabel + ' ' + (this.currentIndex + 1) + '/' + this.totalQuestions);

      // Update progress bar
      this.progressBar.setProgress((this.currentIndex) / this.totalQuestions, true);

      // Build the question card group (slides in from right)
      var group = this.add.container(W, 0).setDepth(50);
      this.currentGroup = group;

      // Question background panel
      var qPanelW = W - 60;
      var qPanelH = 180;
      var qPanelY = H * 0.20;

      var qPanel = this.add.graphics();
      qPanel.fillStyle(0xFFFFFF, 0.96);
      qPanel.fillRoundedRect(-qPanelW / 2, -qPanelH / 2, qPanelW, qPanelH, 20);
      qPanel.lineStyle(3, hexToInt(colors.primary), 0.9);
      qPanel.strokeRoundedRect(-qPanelW / 2, -qPanelH / 2, qPanelW, qPanelH, 20);
      var qPanelContainer = this.add.container(W / 2, qPanelY);
      qPanelContainer.add(qPanel);

      // Question text
      var qText = this.add.text(0, 0, q.question, {
        fontSize: '24px',
        fontFamily: 'Arial',
        fontStyle: 'bold',
        color: colors.secondary,
        align: 'center',
        wordWrap: { width: qPanelW - 40 },
        lineSpacing: 6
      }).setOrigin(0.5);
      qPanelContainer.add(qText);

      group.add(qPanelContainer);

      // Option cards in 2x2 grid
      var options = q.options || [];
      var optionLetters = ['A', 'B', 'C', 'D'];
      var cardW = 260, cardH = 120;
      var gapX = 20, gapY = 20;
      var gridY = H * 0.56;
      var optionContainers = [];

      for (var i = 0; i < options.length; i++) {
        var col = i % 2;
        var row = Math.floor(i / 2);
        var cx = W / 2 + (col === 0 ? -(cardW / 2 + gapX / 2) : (cardW / 2 + gapX / 2));
        var cy = gridY + (row === 0 ? -(cardH / 2 + gapY / 2) : (cardH / 2 + gapY / 2));

        var card = this.makeOptionCard(cx, cy, cardW, cardH, optionLetters[i], options[i], i);
        group.add(card.container);
        optionContainers.push(card);
      }

      this.currentOptions = optionContainers;
      this.currentQuestion = q;

      // Slide group in from right
      group.x = W;
      this.tweens.add({
        targets: group,
        x: 0,
        duration: 420,
        ease: 'Cubic.easeOut'
      });

      // Start per-question timer
      this.startQuestionTimer();
    }

    makeOptionCard(x, y, w, h, letter, text, index) {
      var self = this;
      var colors = CONFIG.colors;

      // Brand color variants per card
      var variants = [colors.primary, colors.accent, colors.secondary, colors.primary];
      var cardColor = variants[index % variants.length];

      var container = this.add.container(x, y);

      // Shadow
      var shadow = this.add.graphics();
      shadow.fillStyle(0x000000, 0.12);
      shadow.fillRoundedRect(-w / 2 + 3, -h / 2 + 5, w, h, 16);
      container.add(shadow);

      // Card background
      var cardBg = this.add.graphics();
      cardBg.fillStyle(0xFFFFFF, 1);
      cardBg.fillRoundedRect(-w / 2, -h / 2, w, h, 16);
      cardBg.lineStyle(2, hexToInt(cardColor), 0.85);
      cardBg.strokeRoundedRect(-w / 2, -h / 2, w, h, 16);
      container.add(cardBg);

      // Border glow graphics (hidden until feedback)
      var borderGlow = this.add.graphics();
      container.add(borderGlow);

      // Letter badge
      var badge = this.add.graphics();
      badge.fillStyle(hexToInt(cardColor), 1);
      badge.fillCircle(-w / 2 + 32, 0, 22);
      container.add(badge);

      var letterText = this.add.text(-w / 2 + 32, 0, letter, {
        fontSize: '22px', fontFamily: 'Arial', fontStyle: 'bold',
        color: '#FFFFFF'
      }).setOrigin(0.5);
      container.add(letterText);

      // Option text
      var optText = this.add.text(8, 0, text, {
        fontSize: '18px',
        fontFamily: 'Arial',
        fontStyle: 'bold',
        color: colors.secondary,
        align: 'left',
        wordWrap: { width: w - 80 }
      }).setOrigin(0, 0.5);
      container.add(optText);

      // Interactive hit area
      var hit = this.add.rectangle(0, 0, w, h, 0x000000, 0)
        .setInteractive({ useHandCursor: true });
      container.add(hit);

      hit.on('pointerdown', function () {
        if (self.locked) return;
        self.handleAnswer(index);
      });

      // Hover subtle scale
      hit.on('pointerover', function () {
        if (self.locked) return;
        self.tweens.add({ targets: container, scale: 1.03, duration: 120, ease: 'Power2' });
      });
      hit.on('pointerout', function () {
        if (self.locked) return;
        self.tweens.add({ targets: container, scale: 1, duration: 120, ease: 'Power2' });
      });

      return {
        container: container,
        cardBg: cardBg,
        borderGlow: borderGlow,
        index: index,
        w: w, h: h,
        color: cardColor
      };
    }

    startQuestionTimer() {
      var self = this;
      var gameplay = CONFIG.gameplay;
      this.timeRemaining = gameplay.timePerQuestion;
      this.drawTimerBar(1);
      if (this.timerLabel) this.timerLabel.setText(Math.ceil(this.timeRemaining) + 's');

      if (this.questionTimer) this.questionTimer.remove(false);

      var tickMs = 50;
      this.questionTimer = this.time.addEvent({
        delay: tickMs,
        loop: true,
        callback: function () {
          if (self.locked) return;
          self.timeRemaining -= tickMs / 1000;
          if (self.timeRemaining <= 0) {
            self.timeRemaining = 0;
            self.drawTimerBar(0);
            if (self.timerLabel) self.timerLabel.setText('0s');
            self.questionTimer.remove(false);
            self.questionTimer = null;
            self.handleTimeout();
            return;
          }
          var pct = self.timeRemaining / gameplay.timePerQuestion;
          self.drawTimerBar(pct);
          if (self.timerLabel) self.timerLabel.setText(Math.ceil(self.timeRemaining) + 's');
        }
      });
    }

    handleAnswer(chosenIndex) {
      if (this.locked) return;
      this.locked = true;

      if (this.questionTimer) {
        this.questionTimer.remove(false);
        this.questionTimer = null;
      }

      var colors = CONFIG.colors;
      var gameplay = CONFIG.gameplay;
      var texts = CONFIG.texts;
      var q = this.currentQuestion;
      var correct = (chosenIndex === q.correctIndex);

      var correctColor = colors.correct || '#10B981';
      var incorrectColor = colors.incorrect || '#EF4444';

      var chosenCard = this.currentOptions[chosenIndex];
      var correctCard = this.currentOptions[q.correctIndex];

      if (correct) {
        // Score with speed bonus
        var basePoints = gameplay.pointsPerCorrect;
        var speedPct = this.timeRemaining / gameplay.timePerQuestion;
        var bonus = Math.round((gameplay.bonusForSpeed || 0) * speedPct);
        var points = basePoints + bonus;

        this.score += points;
        this.correctCount += 1;
        this.animateScoreTo(this.score);

        // Green border glow on chosen card
        this.glowCard(chosenCard, correctColor);
        // Scale up the chosen card
        this.tweens.add({
          targets: chosenCard.container,
          scale: 1.08,
          duration: 180,
          ease: 'Back.easeOut',
          yoyo: true
        });

        // Sparkle burst on card
        FX.effects.sparkleBurst(this,
          chosenCard.container.x,
          chosenCard.container.y,
          colors.accent, 12);

        // Score popup
        FX.effects.scorePopup(this,
          chosenCard.container.x,
          chosenCard.container.y - 40,
          '+' + points,
          colors.accent);

        // "Correct!" message
        this.showFeedbackBanner(texts.correctMessage || 'Correct!', correctColor);

        FX.audio.playScore();
      } else {
        // Red border + shake on chosen card
        this.glowCard(chosenCard, incorrectColor);
        this.shakeCard(chosenCard);

        // Highlight the correct card in green
        this.glowCard(correctCard, correctColor);
        this.tweens.add({
          targets: correctCard.container,
          scale: 1.05,
          duration: 300,
          ease: 'Sine.easeInOut',
          yoyo: true,
          repeat: 1
        });

        // Red flash + shake
        FX.effects.screenShake(this, 0.006, 120);
        this.cameras.main.flash(100, 239, 68, 68, true);

        this.showFeedbackBanner(texts.incorrectMessage || 'Not quite!', incorrectColor);

        FX.audio.playFail();
      }

      // Dim non-relevant cards
      for (var i = 0; i < this.currentOptions.length; i++) {
        if (i !== chosenIndex && i !== q.correctIndex) {
          this.tweens.add({
            targets: this.currentOptions[i].container,
            alpha: 0.45,
            duration: 250
          });
        }
      }

      // Move to next question after reveal delay
      var self = this;
      var delay = gameplay.revealDelay || 1400;
      this.time.delayedCall(delay, function () { self.advance(); });
    }

    handleTimeout() {
      if (this.locked) return;
      this.locked = true;

      var colors = CONFIG.colors;
      var texts = CONFIG.texts;
      var q = this.currentQuestion;
      var correctColor = colors.correct || '#10B981';
      var incorrectColor = colors.incorrect || '#EF4444';

      var correctCard = this.currentOptions[q.correctIndex];

      // Highlight correct answer
      this.glowCard(correctCard, correctColor);
      this.tweens.add({
        targets: correctCard.container,
        scale: 1.05,
        duration: 300,
        ease: 'Sine.easeInOut',
        yoyo: true,
        repeat: 1
      });

      this.showFeedbackBanner(texts.incorrectMessage || "Time's up!", incorrectColor);

      FX.effects.screenShake(this, 0.005, 100);
      FX.audio.playFail();

      // Dim non-correct cards
      for (var i = 0; i < this.currentOptions.length; i++) {
        if (i !== q.correctIndex) {
          this.tweens.add({
            targets: this.currentOptions[i].container,
            alpha: 0.45,
            duration: 250
          });
        }
      }

      var self = this;
      var delay = (CONFIG.gameplay.revealDelay || 1400);
      this.time.delayedCall(delay, function () { self.advance(); });
    }

    glowCard(card, colorHex) {
      card.borderGlow.clear();
      card.borderGlow.lineStyle(5, hexToInt(colorHex), 1);
      card.borderGlow.strokeRoundedRect(-card.w / 2 - 1, -card.h / 2 - 1, card.w + 2, card.h + 2, 17);

      // Outer soft glow
      var soft = this.add.graphics();
      soft.lineStyle(10, hexToInt(colorHex), 0.35);
      soft.strokeRoundedRect(-card.w / 2 - 4, -card.h / 2 - 4, card.w + 8, card.h + 8, 19);
      card.container.add(soft);
      card.container.sendToBack(soft);

      this.tweens.add({
        targets: soft,
        alpha: { from: 0.6, to: 0 },
        duration: 900,
        ease: 'Sine.easeOut'
      });
    }

    shakeCard(card) {
      var origX = card.container.x;
      this.tweens.add({
        targets: card.container,
        x: origX + 10,
        duration: 50,
        yoyo: true,
        repeat: 4,
        ease: 'Sine.easeInOut',
        onComplete: function () { card.container.x = origX; }
      });
    }

    showFeedbackBanner(msg, colorHex) {
      var colors = CONFIG.colors;
      var banner = this.add.text(W / 2, H * 0.42, msg, {
        fontSize: '38px',
        fontFamily: 'Arial',
        fontStyle: 'bold',
        color: colorHex,
        stroke: '#FFFFFF',
        strokeThickness: 4
      }).setOrigin(0.5).setDepth(300).setScale(0);

      banner.setShadow(2, 2, 'rgba(0,0,0,0.25)', 6);

      this.tweens.add({
        targets: banner,
        scale: 1.1,
        duration: 280,
        ease: 'Back.easeOut'
      });

      this.tweens.add({
        targets: banner,
        alpha: 0,
        y: H * 0.38,
        duration: 600,
        delay: 700,
        ease: 'Power2',
        onComplete: function () { banner.destroy(); }
      });
    }

    animateScoreTo(target) {
      var self = this;
      var from = parseInt(this.scoreValueText.text, 10) || 0;
      if (from === target) return;
      this.tweens.addCounter({
        from: from,
        to: target,
        duration: 500,
        ease: 'Cubic.easeOut',
        onUpdate: function (tween) {
          self.scoreValueText.setText(Math.floor(tween.getValue()).toString());
        },
        onComplete: function () {
          self.scoreValueText.setText(String(target));
        }
      });
      // Pop score container
      FX.effects.scalePunch(this, this.scoreContainer, 1.18, 140);
    }

    advance() {
      var self = this;
      var group = this.currentGroup;

      // Slide out to the left
      this.tweens.add({
        targets: group,
        x: -W,
        alpha: 0.2,
        duration: 380,
        ease: 'Cubic.easeIn',
        onComplete: function () {
          if (group && group.destroy) group.destroy();
        }
      });

      this.currentIndex += 1;

      if (this.currentIndex >= this.totalQuestions) {
        // Final progress update then finish
        this.progressBar.setProgress(1, true);
        this.time.delayedCall(500, function () { self.finishQuiz(); });
      } else {
        this.time.delayedCall(420, function () { self.showQuestion(); });
      }
    }

    finishQuiz() {
      var self = this;
      if (this.questionTimer) {
        this.questionTimer.remove(false);
        this.questionTimer = null;
      }

      FX.audio.playWhoosh();

      this.time.delayedCall(300, function () {
        var transition = CONFIG.theme.transitionStyle;
        var payload = {
          score: self.score,
          correct: self.correctCount,
          total: self.totalQuestions
        };
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
  // END SCENE — Score reveal, star rating, result message, CTA
  // ═══════════════════════════════════════════════════════════
  class EndScene extends Phaser.Scene {
    constructor() { super('EndScene'); }

    create(data) {
      FX.transitions.fadeIn(this);
      var colors = CONFIG.colors;
      var texts = CONFIG.texts;
      var gameplay = CONFIG.gameplay;

      var score = (data && data.score) || 0;
      var correct = (data && data.correct) || 0;
      var total = (data && data.total) || 1;

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

      // Result Title
      var ratio = total > 0 ? correct / total : 0;
      var starCount = ratio >= 0.85 ? 3 : ratio >= 0.5 ? 2 : ratio >= 0.25 ? 1 : 0;

      // Pick result message by tier (0..3)
      var msgs = texts.resultMessages || ['Keep trying!', 'Nice!', 'Great!', 'Expert!'];
      var tier = ratio >= 0.85 ? 3 : ratio >= 0.6 ? 2 : ratio >= 0.3 ? 1 : 0;
      var resultMessage = msgs[Math.min(tier, msgs.length - 1)] || '';

      var title = this.add.text(W / 2, H * 0.14, resultMessage, {
        fontSize: '40px', fontFamily: 'Arial', fontStyle: 'bold',
        color: colors.secondary, align: 'center',
        wordWrap: { width: W - 80 }
      }).setOrigin(0.5).setDepth(10);
      title.setShadow(2, 2, 'rgba(0,0,0,0.2)', 4);
      FX.effects.bounceIn(this, title, 100);

      // "X / Y correct" subtitle
      var sub = this.add.text(W / 2, H * 0.22, correct + ' / ' + total + ' correct', {
        fontSize: '22px', fontFamily: 'Arial', fontStyle: 'bold',
        color: colors.primary
      }).setOrigin(0.5).setDepth(10).setAlpha(0);
      this.tweens.add({
        targets: sub,
        alpha: 0.9,
        duration: 500,
        delay: 400
      });

      // Score count-up
      var scoreDisplay = FX.ui.AnimatedScore(this, W / 2, H * 0.34, {
        label: texts.scoreLabel || 'Score',
        color: colors.secondary,
        accentColor: colors.accent,
        fontSize: 52
      });
      this.time.delayedCall(600, function () {
        scoreDisplay.countUpFrom(0, score, 1500);
      });

      // Star rating
      var stars = FX.ui.StarRating(this, W / 2, H * 0.48, {
        maxStars: 3,
        starSize: 46,
        filledColor: colors.accent,
        emptyColor: '#CBD5E1'
      });
      this.time.delayedCall(2100, function () {
        stars.fill(starCount);
      });

      // Confetti for high score (3 stars)
      if (starCount === 3) {
        this.time.delayedCall(2900, function () {
          FX.effects.confettiBurst(this, W / 2, H * 0.4,
            [colors.primary, colors.accent, colors.secondary, '#FFFFFF'], 60);
          FX.audio.playSuccess();
        }.bind(this));
      }

      // Logo (if available)
      var logoKey = CONFIG.assets && CONFIG.assets.logo;
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
      var ctaBtn = FX.ui.CTAButton(this, W / 2, H * 0.74, texts.cta || 'Learn More', {
        width: 260,
        height: 60,
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
        delay: 2300
      });

      // Play Again
      var playAgain = this.add.text(W / 2, H * 0.86, texts.playAgain || 'Play Again', {
        fontSize: '18px', fontFamily: 'Arial', fontStyle: 'bold',
        color: colors.primary
      }).setOrigin(0.5).setDepth(10).setAlpha(0)
        .setInteractive({ useHandCursor: true });

      this.tweens.add({
        targets: playAgain,
        alpha: 0.75,
        duration: 400,
        delay: 2900
      });

      playAgain.on('pointerdown', function () {
        FX.audio.playTap();
        FX.transitions.cinematicFade(this, 'GameScene', {});
      }, this);

      playAgain.on('pointerover', function () { playAgain.setAlpha(1); });
      playAgain.on('pointerout', function () { playAgain.setAlpha(0.75); });

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
