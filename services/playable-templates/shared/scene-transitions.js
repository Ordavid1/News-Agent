/**
 * Shared Scene Transitions Module — Premium Playable Ads
 *
 * Cinematic scene transition helpers for Phaser 3.80.
 * All transitions handle camera fade + scene lifecycle correctly.
 *
 * Exported via window.SHARED_FX.transitions when concatenated by TemplateRenderer.
 */

(function () {
  'use strict';

  var transitions = {};

  // ── Cinematic Fade ──────────────────────────────────────────
  /**
   * Fade to black, pause briefly, then start next scene (which fades in).
   * @param {Phaser.Scene} scene     Current scene
   * @param {string}       nextScene Scene key to start
   * @param {object}       [data]    Data to pass to next scene
   * @param {number}       [duration=400] Fade duration per half (ms)
   */
  transitions.cinematicFade = function (scene, nextScene, data, duration) {
    duration = duration || 400;
    scene.cameras.main.fadeOut(duration, 0, 0, 0);
    scene.cameras.main.once('camerafadeoutcomplete', function () {
      scene.time.delayedCall(100, function () {
        scene.scene.start(nextScene, data || {});
      });
    });
  };

  /**
   * Called in the new scene's create() to fade in.
   */
  transitions.fadeIn = function (scene, duration) {
    scene.cameras.main.fadeIn(duration || 400, 0, 0, 0);
  };

  // ── Wipe Transition ─────────────────────────────────────────
  /**
   * Horizontal or vertical wipe using a rectangle overlay.
   * @param {string} direction 'left'|'right'|'up'|'down'
   */
  transitions.wipeTransition = function (scene, nextScene, data, direction, duration) {
    direction = direction || 'left';
    duration = duration || 500;
    var w = scene.scale.width;
    var h = scene.scale.height;

    var overlay = scene.add.rectangle(0, 0, w, h, 0x000000, 0).setOrigin(0, 0).setDepth(9999);

    var tweenConfig = { targets: overlay, duration: duration, ease: 'Power2' };

    switch (direction) {
      case 'left':
        overlay.setPosition(w, 0).setSize(w, h);
        tweenConfig.x = 0;
        break;
      case 'right':
        overlay.setPosition(-w, 0).setSize(w, h);
        tweenConfig.x = 0;
        break;
      case 'up':
        overlay.setPosition(0, h).setSize(w, h);
        tweenConfig.y = 0;
        break;
      case 'down':
        overlay.setPosition(0, -h).setSize(w, h);
        tweenConfig.y = 0;
        break;
    }

    overlay.setAlpha(1).fillColor = 0x000000;
    overlay.setFillStyle(0x000000, 1);

    // Animate overlay covering the screen
    scene.tweens.add(Object.assign({}, tweenConfig, {
      onComplete: function () {
        scene.scene.start(nextScene, data || {});
      }
    }));
  };

  // ── Zoom Transition ─────────────────────────────────────────
  /**
   * Camera zooms into center, then next scene starts and zooms out.
   */
  transitions.zoomOut = function (scene, nextScene, data, duration) {
    duration = duration || 500;
    scene.tweens.add({
      targets: scene.cameras.main,
      zoom: 3,
      alpha: 0,
      duration: duration,
      ease: 'Power3',
      onComplete: function () {
        scene.scene.start(nextScene, data || {});
      }
    });
  };

  /**
   * Called in the new scene to zoom in from magnified.
   */
  transitions.zoomIn = function (scene, duration) {
    duration = duration || 500;
    scene.cameras.main.setZoom(3).setAlpha(0);
    scene.tweens.add({
      targets: scene.cameras.main,
      zoom: 1,
      alpha: 1,
      duration: duration,
      ease: 'Power3'
    });
  };

  // ── Slide Transition ────────────────────────────────────────
  /**
   * Slides all scene content off-screen in the given direction.
   */
  transitions.slideOut = function (scene, nextScene, data, direction, duration) {
    direction = direction || 'left';
    duration = duration || 400;
    var w = scene.scale.width;
    var h = scene.scale.height;

    var targetX = 0;
    var targetY = 0;

    switch (direction) {
      case 'left':  targetX = -w; break;
      case 'right': targetX = w;  break;
      case 'up':    targetY = -h; break;
      case 'down':  targetY = h;  break;
    }

    scene.tweens.add({
      targets: scene.cameras.main,
      scrollX: -targetX,
      scrollY: -targetY,
      duration: duration,
      ease: 'Power2',
      onComplete: function () {
        scene.scene.start(nextScene, data || {});
      }
    });
  };

  // ── Flash Transition ────────────────────────────────────────
  /**
   * Quick white flash then scene change.
   */
  transitions.flashTransition = function (scene, nextScene, data, duration) {
    duration = duration || 200;
    scene.cameras.main.flash(duration, 255, 255, 255);
    scene.cameras.main.once('cameraflashcomplete', function () {
      scene.scene.start(nextScene, data || {});
    });
  };

  // ── Tap-to-advance feedback ─────────────────────────────────
  /**
   * Small expanding circle at tap point for story-style games.
   */
  transitions.tapFeedback = function (scene, x, y, color) {
    var c = parseInt((color || '#FFFFFF').replace('#', ''), 16);
    var circle = scene.add.circle(x, y, 5, c, 0.4).setDepth(5000);
    scene.tweens.add({
      targets: circle,
      scale: 4,
      alpha: 0,
      duration: 400,
      ease: 'Power2',
      onComplete: function () { circle.destroy(); }
    });
  };

  // ── Expose ──────────────────────────────────────────────────
  window.SHARED_FX = window.SHARED_FX || {};
  window.SHARED_FX.transitions = transitions;
})();
