// tests/v4/BeatLifecycle.test.mjs
//
// V4 Tier 1 — Beat Lifecycle Architecture unit tests.
//
// Run: node --test tests/v4/BeatLifecycle.test.mjs
//
// Coverage:
//   • BEAT_STATUS enum + LIVE_STATUSES set membership
//   • ensureLifecycleFields backfills legacy beats without losing data
//   • transition() enforces allowed graph + optimistic concurrency
//   • quarantineBeat snapshots video into attempts_log + nulls canonical row
//   • promoteFromQuarantine restores most recent attempt
//   • supersedeBeat archives + nulls + transitions to superseded
//   • selectLiveBeats walks scene-graph in (scene_index, beat_index) order
//     and filters on status ∈ {generated, ready} AND non-null video_url
//   • Regression: enrichedBeatMetadata index drift symptom is impossible
//     when both buffer-push loop and metadata loop walk selectLiveBeats

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  BEAT_STATUS,
  LIVE_STATUSES,
  QUARANTINED_STATUSES,
  BeatLifecycleError,
  isLiveStatus,
  isQuarantinedStatus,
  isKnownStatus,
  ensureLifecycleFields,
  transition,
  appendAttemptLog,
  quarantineBeat,
  promoteFromQuarantine,
  supersedeBeat,
  selectLiveBeats
} from '../../services/v4/BeatLifecycle.js';

// ─────────────────────────────────────────────────────────────────────
// Enum + membership
// ─────────────────────────────────────────────────────────────────────

describe('BEAT_STATUS enum', () => {
  test('exports the canonical 7-state set', () => {
    assert.deepEqual(Object.values(BEAT_STATUS).sort(), [
      'failed', 'generated', 'generating', 'hard_rejected', 'pending', 'ready', 'superseded'
    ]);
  });

  test('LIVE_STATUSES is exactly {generated, ready}', () => {
    assert.equal(LIVE_STATUSES.size, 2);
    assert.ok(LIVE_STATUSES.has('generated'));
    assert.ok(LIVE_STATUSES.has('ready'));
  });

  test('QUARANTINED_STATUSES is {hard_rejected, superseded, failed}', () => {
    assert.equal(QUARANTINED_STATUSES.size, 3);
    assert.ok(QUARANTINED_STATUSES.has('hard_rejected'));
    assert.ok(QUARANTINED_STATUSES.has('superseded'));
    assert.ok(QUARANTINED_STATUSES.has('failed'));
  });

  test('helpers correctly classify known + unknown values', () => {
    assert.ok(isLiveStatus('generated'));
    assert.ok(isLiveStatus('ready'));
    assert.ok(!isLiveStatus('hard_rejected'));
    assert.ok(!isLiveStatus(undefined));
    assert.ok(isQuarantinedStatus('hard_rejected'));
    assert.ok(!isQuarantinedStatus('ready'));
    assert.ok(isKnownStatus('generated'));
    assert.ok(!isKnownStatus('weird'));
  });
});

// ─────────────────────────────────────────────────────────────────────
// ensureLifecycleFields
// ─────────────────────────────────────────────────────────────────────

describe('ensureLifecycleFields', () => {
  test('backfills missing fields on a legacy beat', () => {
    const beat = { beat_id: 'b1' };
    ensureLifecycleFields(beat);
    assert.equal(beat.status, 'pending');
    assert.equal(beat.version, 0);
    assert.deepEqual(beat.attempts_log, []);
  });

  test('infers status=generated when generated_video_url already set', () => {
    const beat = { beat_id: 'b1', generated_video_url: 'https://x/y.mp4' };
    ensureLifecycleFields(beat);
    assert.equal(beat.status, 'generated');
  });

  test('preserves existing fields and is idempotent', () => {
    const beat = {
      beat_id: 'b1',
      status: 'ready',
      version: 7,
      attempts_log: [{ attempt_uuid: 'u1' }]
    };
    ensureLifecycleFields(beat);
    ensureLifecycleFields(beat);
    assert.equal(beat.status, 'ready');
    assert.equal(beat.version, 7);
    assert.equal(beat.attempts_log.length, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// transition
// ─────────────────────────────────────────────────────────────────────

describe('transition()', () => {
  test('happy path pending → generating → generated', () => {
    const beat = { beat_id: 'b1' };
    transition(beat, 'generating');
    assert.equal(beat.status, 'generating');
    assert.equal(beat.version, 1);
    transition(beat, 'generated', { expectedFrom: 'generating' });
    assert.equal(beat.status, 'generated');
    assert.equal(beat.version, 2);
  });

  test('throws BeatLifecycleError on illegal transition', () => {
    const beat = { beat_id: 'b1', status: 'pending', version: 0, attempts_log: [] };
    assert.throws(
      () => transition(beat, 'ready'), // pending → ready is illegal
      (err) => err instanceof BeatLifecycleError && err.code === 'illegal_transition'
    );
    // beat is unchanged
    assert.equal(beat.status, 'pending');
    assert.equal(beat.version, 0);
  });

  test('throws on status mismatch when expectedFrom provided', () => {
    const beat = { beat_id: 'b1', status: 'generated', version: 1, attempts_log: [] };
    assert.throws(
      () => transition(beat, 'ready', { expectedFrom: 'generating' }),
      (err) => err instanceof BeatLifecycleError && err.code === 'status_mismatch'
    );
  });

  test('throws on version mismatch (optimistic concurrency)', () => {
    const beat = { beat_id: 'b1', status: 'generated', version: 5, attempts_log: [] };
    assert.throws(
      () => transition(beat, 'ready', { expectedVersion: 4 }),
      (err) => err instanceof BeatLifecycleError && err.code === 'version_mismatch'
    );
  });

  test('throws on unknown target status', () => {
    const beat = { beat_id: 'b1' };
    assert.throws(
      () => transition(beat, 'mystery_state'),
      (err) => err instanceof BeatLifecycleError && err.code === 'unknown_status'
    );
  });

  test('superseded is terminal — no outgoing transitions', () => {
    const beat = { beat_id: 'b1', status: 'superseded', version: 3, attempts_log: [] };
    assert.throws(
      () => transition(beat, 'generating'),
      (err) => err instanceof BeatLifecycleError && err.code === 'illegal_transition'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// quarantineBeat — the core Tier 1 fix
// ─────────────────────────────────────────────────────────────────────

describe('quarantineBeat()', () => {
  test('snapshots canonical clip into attempts_log and nulls the row', () => {
    const beat = {
      beat_id: 'b1',
      status: 'generated',
      version: 1,
      attempts_log: [],
      generated_video_url: 'https://x/clip.mp4',
      endframe_url: 'https://x/end.jpg',
      model_used: 'kling-v3-pro/action'
    };
    const verdict = { verdict: 'hard_reject', overall_score: 35 };
    quarantineBeat(beat, { verdict, reason: 'lens_c_first_attempt' });

    // Canonical row null'd
    assert.equal(beat.generated_video_url, null);
    assert.equal(beat.endframe_url, null);
    // Status flipped + version bumped
    assert.equal(beat.status, 'hard_rejected');
    assert.equal(beat.version, 2);
    // Attempts log captured the clip
    assert.equal(beat.attempts_log.length, 1);
    const entry = beat.attempts_log[0];
    assert.equal(entry.video_url, 'https://x/clip.mp4');
    assert.equal(entry.endframe_url, 'https://x/end.jpg');
    assert.equal(entry.model_used, 'kling-v3-pro/action');
    assert.equal(entry.lens_c_verdict.verdict, 'hard_reject');
    assert.equal(entry.reason, 'lens_c_first_attempt');
    assert.ok(entry.attempt_uuid);
    assert.ok(entry.started_at);
  });

  test('idempotent — calling twice records both attempts but stays quarantined', () => {
    const beat = {
      beat_id: 'b1',
      status: 'generated',
      version: 1,
      attempts_log: [],
      generated_video_url: 'https://x/clip1.mp4'
    };
    quarantineBeat(beat, { reason: 'first_call' });
    quarantineBeat(beat, { reason: 'second_call' });
    assert.equal(beat.status, 'hard_rejected');
    assert.equal(beat.attempts_log.length, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────
// promoteFromQuarantine — the user-approve = restore contract
// ─────────────────────────────────────────────────────────────────────

describe('promoteFromQuarantine()', () => {
  test('restores most recent quarantined clip onto the canonical row', () => {
    const beat = {
      beat_id: 'b1',
      status: 'generated',
      version: 1,
      attempts_log: [],
      generated_video_url: 'https://x/clip.mp4',
      endframe_url: 'https://x/end.jpg',
      model_used: 'kling-v3-pro/action'
    };
    quarantineBeat(beat, { reason: 'rejected_once' });
    promoteFromQuarantine(beat);

    assert.equal(beat.status, 'ready');
    assert.equal(beat.generated_video_url, 'https://x/clip.mp4');
    assert.equal(beat.endframe_url, 'https://x/end.jpg');
    assert.equal(beat.model_used, 'kling-v3-pro/action');
    // Audit log now has both the quarantine and promotion records
    assert.equal(beat.attempts_log.length, 2);
    assert.equal(beat.attempts_log[0].status, 'hard_rejected');
    assert.equal(beat.attempts_log[1].status, 'ready');
    assert.equal(beat.attempts_log[1].reason, 'user_approve_promote_from_quarantine');
  });

  test('walks attempts_log in reverse — restores LAST quarantined clip not first', () => {
    const beat = {
      beat_id: 'b1',
      status: 'generated',
      version: 1,
      attempts_log: [],
      generated_video_url: 'https://x/oldclip.mp4'
    };
    quarantineBeat(beat, { reason: 'first' });
    // Simulate a regenerate that produced a NEW clip and was also rejected
    beat.generated_video_url = 'https://x/newclip.mp4';
    beat.status = 'generated';
    quarantineBeat(beat, { reason: 'second' });
    promoteFromQuarantine(beat);
    // Should restore the SECOND (newer) clip
    assert.equal(beat.generated_video_url, 'https://x/newclip.mp4');
  });

  test('throws no_restorable_attempt when log has no clip', () => {
    const beat = {
      beat_id: 'b1',
      status: 'hard_rejected',
      version: 2,
      attempts_log: [{ attempt_uuid: 'u1', video_url: null }]
    };
    assert.throws(
      () => promoteFromQuarantine(beat),
      (err) => err instanceof BeatLifecycleError && err.code === 'no_restorable_attempt'
    );
  });

  test('throws not_quarantined when called on a non-hard_rejected beat', () => {
    const beat = { beat_id: 'b1', status: 'ready', version: 1, attempts_log: [] };
    assert.throws(
      () => promoteFromQuarantine(beat),
      (err) => err instanceof BeatLifecycleError && err.code === 'not_quarantined'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// supersedeBeat
// ─────────────────────────────────────────────────────────────────────

describe('supersedeBeat()', () => {
  test('archives current clip and nulls canonical row', () => {
    const beat = {
      beat_id: 'b1',
      status: 'generated',
      version: 3,
      attempts_log: [],
      generated_video_url: 'https://x/old.mp4',
      endframe_url: 'https://x/end.jpg'
    };
    supersedeBeat(beat, { reason: 'user_regenerate' });
    assert.equal(beat.status, 'superseded');
    assert.equal(beat.version, 4);
    assert.equal(beat.generated_video_url, null);
    assert.equal(beat.endframe_url, null);
    assert.equal(beat.attempts_log.length, 1);
    assert.equal(beat.attempts_log[0].video_url, 'https://x/old.mp4');
    assert.equal(beat.attempts_log[0].reason, 'user_regenerate');
  });
});

// ─────────────────────────────────────────────────────────────────────
// selectLiveBeats — the loader contract
// ─────────────────────────────────────────────────────────────────────

describe('selectLiveBeats()', () => {
  test('returns beats in (scene_index, beat_index) order', () => {
    const sceneGraph = {
      scenes: [
        {
          scene_id: 's1',
          beats: [
            { beat_id: 's1b1', type: 'B_ROLL', status: 'generated', generated_video_url: 'a.mp4' },
            { beat_id: 's1b2', type: 'TALKING_HEAD', status: 'ready', generated_video_url: 'b.mp4' }
          ]
        },
        {
          scene_id: 's2',
          beats: [
            { beat_id: 's2b1', type: 'REACTION', status: 'generated', generated_video_url: 'c.mp4' }
          ]
        }
      ]
    };
    const live = selectLiveBeats(sceneGraph);
    assert.equal(live.length, 3);
    assert.deepEqual(live.map(e => e.beat.beat_id), ['s1b1', 's1b2', 's2b1']);
    assert.deepEqual(live.map(e => e.scene_index), [0, 0, 1]);
    assert.deepEqual(live.map(e => e.beat_index), [0, 1, 0]);
  });

  test('skips hard_rejected, superseded, failed, pending, generating', () => {
    const sceneGraph = {
      scenes: [{
        scene_id: 's1',
        beats: [
          { beat_id: 'b1', type: 'B_ROLL', status: 'generated',     generated_video_url: 'a.mp4' },
          { beat_id: 'b2', type: 'B_ROLL', status: 'hard_rejected', generated_video_url: 'b.mp4' },
          { beat_id: 'b3', type: 'B_ROLL', status: 'superseded',    generated_video_url: 'c.mp4' },
          { beat_id: 'b4', type: 'B_ROLL', status: 'failed',        generated_video_url: 'd.mp4' },
          { beat_id: 'b5', type: 'B_ROLL', status: 'pending',       generated_video_url: null    },
          { beat_id: 'b6', type: 'B_ROLL', status: 'generating',    generated_video_url: null    },
          { beat_id: 'b7', type: 'B_ROLL', status: 'ready',         generated_video_url: 'e.mp4' }
        ]
      }]
    };
    const live = selectLiveBeats(sceneGraph);
    assert.deepEqual(live.map(e => e.beat.beat_id), ['b1', 'b7']);
  });

  test('skips SPEED_RAMP_TRANSITION beats', () => {
    const sceneGraph = {
      scenes: [{
        scene_id: 's1',
        beats: [
          { beat_id: 'b1', type: 'B_ROLL_ESTABLISHING', status: 'generated', generated_video_url: 'a.mp4' },
          { beat_id: 'b2', type: 'SPEED_RAMP_TRANSITION', status: 'generated', generated_video_url: null },
          { beat_id: 'b3', type: 'TALKING_HEAD_CLOSEUP', status: 'generated', generated_video_url: 'c.mp4' }
        ]
      }]
    };
    const live = selectLiveBeats(sceneGraph);
    assert.deepEqual(live.map(e => e.beat.beat_id), ['b1', 'b3']);
  });

  test('defense-in-depth: skips even live-status beats with null video_url', () => {
    const sceneGraph = {
      scenes: [{
        scene_id: 's1',
        beats: [
          { beat_id: 'b1', type: 'B_ROLL', status: 'generated', generated_video_url: null }
        ]
      }]
    };
    assert.equal(selectLiveBeats(sceneGraph).length, 0);
  });

  test('treats null/empty sceneGraph safely', () => {
    assert.deepEqual(selectLiveBeats(null), []);
    assert.deepEqual(selectLiveBeats({}), []);
    assert.deepEqual(selectLiveBeats({ scenes: [] }), []);
    assert.deepEqual(selectLiveBeats({ scenes: [{ scene_id: 'x', beats: null }] }), []);
  });

  test('backfills lifecycle fields on legacy beats with no status field', () => {
    const sceneGraph = {
      scenes: [{
        scene_id: 's1',
        beats: [
          { beat_id: 'b1', type: 'B_ROLL', generated_video_url: 'a.mp4' }
        ]
      }]
    };
    const live = selectLiveBeats(sceneGraph);
    assert.equal(live.length, 1); // ensureLifecycleFields infers 'generated' from URL
    assert.equal(live[0].beat.status, 'generated');
  });
});

// ─────────────────────────────────────────────────────────────────────
// REGRESSION TEST — the duplicate-beat-in-reassembly symptom
// ─────────────────────────────────────────────────────────────────────

describe('Regression: enrichedBeatMetadata index drift impossible', () => {
  test('liveBeats walked twice produces 1:1 alignment regardless of mid-list quarantine', () => {
    // Scenario from logs.txt 2026-04-30: scene_2 had 4 beats; b4 was
    // hard_rejected during the original run AND a regenerated copy was
    // appended. Under the OLD contract, the loader walked one filter and
    // the metadata loop walked another, producing an index drift that put
    // the regenerated b4 at position 9 in beatVideoBuffers but position 5
    // in enrichedBeatMetadata — silently misaligning subtitles / SFX.
    //
    // Under the NEW contract, both loops walk selectLiveBeats(sceneGraph)
    // → identical filter → identical order → impossible to drift.
    const sceneGraph = {
      scenes: [
        {
          scene_id: 's1',
          beats: [
            { beat_id: 's1b1', type: 'ACTION', status: 'generated', generated_video_url: 'v1.mp4', dialogue: null },
            { beat_id: 's1b2', type: 'TALKING_HEAD', status: 'generated', generated_video_url: 'v2.mp4', dialogue: 'Hello.' }
          ]
        },
        {
          scene_id: 's2',
          beats: [
            { beat_id: 's2b1', type: 'B_ROLL', status: 'generated', generated_video_url: 'v3.mp4', dialogue: null },
            { beat_id: 's2b2', type: 'REACTION', status: 'generated', generated_video_url: 'v4.mp4', dialogue: null },
            { beat_id: 's2b3', type: 'INSERT_SHOT', status: 'generated', generated_video_url: 'v5.mp4', dialogue: null },
            // The previously-failed s2b4 is now quarantined — invisible to
            // both loops. The post-promote-quarantine s2b4 is a separate
            // attempt; in this scenario assume the user clicked Regenerate
            // and the new clip is what the canonical row carries.
            { beat_id: 's2b4', type: 'TALKING_HEAD', status: 'generated', generated_video_url: 'v6.mp4', dialogue: 'Goodbye.', attempts_log: [{ video_url: 'v6_old.mp4', status: 'hard_rejected' }] }
          ]
        }
      ]
    };

    const live = selectLiveBeats(sceneGraph);
    // 6 beats, in canonical order, no duplicates of s2b4
    assert.equal(live.length, 6);
    assert.deepEqual(live.map(e => e.beat.beat_id),
      ['s1b1', 's1b2', 's2b1', 's2b2', 's2b3', 's2b4']);

    // Simulate the orchestrator pushing buffers in the same order, then
    // walking again to enrich metadata. Both arrays MUST align by index.
    const beatVideoBuffers = live.map((_, i) => `buffer${i}`);
    const beatMetadata = live.map(({ beat }) => ({
      beat_id: beat.beat_id,
      model_used: null
    }));
    const enrichedBeatMetadata = live.map(({ beat }, i) => ({
      ...beatMetadata[i],
      beat_id: beat.beat_id,
      dialogue: beat.dialogue || null
    }));

    assert.equal(beatVideoBuffers.length, enrichedBeatMetadata.length);
    for (let i = 0; i < beatVideoBuffers.length; i++) {
      assert.equal(enrichedBeatMetadata[i].beat_id, live[i].beat.beat_id,
        `enrichedBeatMetadata[${i}] must align with live[${i}]`);
    }
    // The dialogue for s1b2 ('Hello.') must NOT drift onto another beat's row
    const s1b2Meta = enrichedBeatMetadata.find(m => m.beat_id === 's1b2');
    assert.equal(s1b2Meta.dialogue, 'Hello.');
    // Dialogue for s2b4 ('Goodbye.') stays on s2b4
    const s2b4Meta = enrichedBeatMetadata.find(m => m.beat_id === 's2b4');
    assert.equal(s2b4Meta.dialogue, 'Goodbye.');
  });

  test('quarantined-then-promoted beat appears exactly once in the live cut', () => {
    const beat = {
      beat_id: 's2b4',
      type: 'TALKING_HEAD',
      status: 'generated',
      generated_video_url: 'first_take.mp4',
      endframe_url: 'first_end.jpg'
    };
    // Lens C hard-rejects → quarantine
    quarantineBeat(beat, { verdict: { verdict: 'hard_reject', overall_score: 35 } });
    assert.equal(beat.status, 'hard_rejected');
    assert.equal(beat.generated_video_url, null);
    // User clicks Approve → promote
    promoteFromQuarantine(beat);
    assert.equal(beat.status, 'ready');
    assert.equal(beat.generated_video_url, 'first_take.mp4');

    // Loader sees ONE beat in the cut — not two
    const sceneGraph = { scenes: [{ scene_id: 's2', beats: [beat] }] };
    const live = selectLiveBeats(sceneGraph);
    assert.equal(live.length, 1);
    assert.equal(live[0].beat.generated_video_url, 'first_take.mp4');
  });
});
