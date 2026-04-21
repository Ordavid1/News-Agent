// services/v4/ProgressEmitter.js
// V4 SSE progress emitter — replaces the v3 5-minute polling timeout.
//
// Architecture:
//   - One ProgressEmitter instance PER episode generation run
//   - Stored in a process-wide registry keyed by episode_id
//   - The runV4Pipeline orchestrator emits events at every stage transition
//   - The SSE route handler in routes/brand-stories.js subscribes by episode_id
//     and streams events to the connected client
//   - When the episode reaches 'ready' or 'failed', the emitter unregisters
//     itself after a short grace period (so reconnecting clients still see
//     the final event)
//
// Events emitted (event names map directly to V4 pipeline stages):
//   - voices            — persona voice acquisition progress
//   - lut               — Brand Kit LUT match
//   - screenplay        — Gemini scene-graph generation
//   - preflight         — BeatRouter cost cap check
//   - scene_masters     — Seedream Scene Master panel generation
//   - beats             — per-beat generation (most frequent)
//   - music             — ElevenLabs Music bed
//   - post_production   — assembly + LUT + mix + cards + subs
//   - upload            — final video upload
//   - complete          — episode ready (terminal)
//   - failed            — episode failed (terminal)
//
// Each event has a `stage`, `detail`, optional `beat_id`, and optional
// `progress` (0-100). The orchestrator's existing onProgress callback is
// wrapped to call emitter.emit() in addition to logging.

import { EventEmitter } from 'events';

// Process-wide registry — one entry per active episode generation
const REGISTRY = new Map();
const TERMINAL_TTL_MS = 60_000; // keep terminal emitters around for 60s for late reconnects

class ProgressEmitter extends EventEmitter {
  constructor(episodeId) {
    super();
    this.episodeId = episodeId;
    this.events = []; // replay buffer for late subscribers
    this.terminal = false;
    this.terminalTimer = null;
    this.startedAt = Date.now();
  }

  /**
   * Emit a progress event. Records it in the replay buffer + broadcasts to
   * any connected SSE clients.
   *
   * @param {string} stage - one of the documented stage names
   * @param {string} detail - human-readable description
   * @param {Object} [extras] - { beat_id?, progress?, model?, ... }
   */
  emit(stage, detail, extras = {}) {
    const event = {
      ts: Date.now(),
      episode_id: this.episodeId,
      stage,
      detail,
      ...extras
    };

    // Cap the replay buffer at 500 events (a typical episode is < 100 events)
    this.events.push(event);
    if (this.events.length > 500) this.events.shift();

    // Forward to all SSE subscribers
    super.emit('event', event);

    // Detect terminal states and start the cleanup timer
    if ((stage === 'complete' || stage === 'failed') && !this.terminal) {
      this.terminal = true;
      super.emit('event', { ts: Date.now(), episode_id: this.episodeId, stage: '__terminal__', detail: 'stream closing' });
      this.terminalTimer = setTimeout(() => {
        REGISTRY.delete(this.episodeId);
      }, TERMINAL_TTL_MS);
    }
  }

  /**
   * Subscribe to events. Returns an unsubscribe function.
   * On subscribe, the listener is immediately called with every replay event
   * (so late connectors catch up to current state).
   *
   * @param {Function} listener - (event) => void
   * @returns {Function} unsubscribe
   */
  subscribe(listener) {
    // Replay history first
    for (const event of this.events) {
      try { listener(event); } catch {}
    }
    // Then live events
    this.on('event', listener);
    return () => this.off('event', listener);
  }
}

/**
 * Get or create the ProgressEmitter for an episode.
 */
export function getOrCreateProgressEmitter(episodeId) {
  if (!episodeId) throw new Error('getOrCreateProgressEmitter: episodeId required');
  let emitter = REGISTRY.get(episodeId);
  if (!emitter) {
    emitter = new ProgressEmitter(episodeId);
    REGISTRY.set(episodeId, emitter);
  }
  return emitter;
}

/**
 * Get an existing ProgressEmitter (or null). Used by SSE subscribers.
 */
export function getProgressEmitter(episodeId) {
  return REGISTRY.get(episodeId) || null;
}

/**
 * Snapshot of the registry (for debugging / observability endpoints).
 */
export function listActiveEmitters() {
  return Array.from(REGISTRY.keys());
}

/**
 * Wrap a legacy onProgress(stage, detail) callback to also emit through a
 * ProgressEmitter. The orchestrator already calls onProgress(...) at every
 * stage; this wrapper makes those calls dual-purpose: log + SSE.
 *
 * @param {ProgressEmitter} emitter
 * @param {Function} [legacyCallback]
 * @returns {Function} a new (stage, detail) callback
 */
export function bridgeOnProgressToEmitter(emitter, legacyCallback) {
  return (stage, detail, extras) => {
    if (typeof legacyCallback === 'function') {
      try { legacyCallback(stage, detail); } catch {}
    }
    if (emitter) {
      try { emitter.emit(stage, detail, extras || {}); } catch {}
    }
  };
}

export default ProgressEmitter;
