// tests/v4/PipelineStartupRecovery.test.mjs
//
// Unit tests for services/v4/PipelineStartupRecovery.js — public API surface
// only. The orphan-scan + kick paths talk to Supabase, which we don't mock
// here (no clean ESM module-mock in node 20's test runner). The
// integration paths are validated end-to-end by actual server boot — when
// the server starts and orphans are present, the logs surface the scan
// + kick activity. Anti-thrash + cleanup behavior is documented in the
// module header and verified manually.
//
// Tests in this file MUST NOT touch the real DB. The "idempotent within a
// process" test does NOT need a Supabase call to validate — the
// _hasRunOnce flag flips before the supabase query runs, so we only need
// to validate that the SECOND call short-circuits.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { recoverInflightV4Episodes, _resetForTests } from '../../services/v4/PipelineStartupRecovery.js';

describe('PipelineStartupRecovery — public API surface', () => {
  beforeEach(() => _resetForTests());

  it('exports recoverInflightV4Episodes + _resetForTests', () => {
    assert.equal(typeof recoverInflightV4Episodes, 'function');
    assert.equal(typeof _resetForTests, 'function');
  });

  it('returns skipped when no brandStoryService is provided', async () => {
    const result = await recoverInflightV4Episodes({});
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'no_service');
    // Importantly: this MUST flip the _hasRunOnce guard so the next test
    // can validate idempotency without needing a real DB.
  });

  it('returns skipped when brandStoryService lacks runV4Pipeline', async () => {
    const result = await recoverInflightV4Episodes({ brandStoryService: { foo: 'bar' } });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'no_service');
  });

  it('returns skipped when brandStoryService.runV4Pipeline is not a function', async () => {
    const result = await recoverInflightV4Episodes({
      brandStoryService: { runV4Pipeline: 'not a function' }
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'no_service');
  });

  it('idempotent within a process — second call returns already_ran', async () => {
    // First call: short-circuits at no_service guard (no DB hit). Sets _hasRunOnce.
    const r1 = await recoverInflightV4Episodes({});
    assert.equal(r1.reason, 'no_service');
    // Second call: short-circuits at already_ran guard, BEFORE the no_service
    // check. The already_ran check is the first thing the function does.
    const r2 = await recoverInflightV4Episodes({});
    assert.equal(r2.skipped, true);
    assert.equal(r2.reason, 'already_ran');
  });

  it('_resetForTests clears the dedupe so subsequent calls do not skip', async () => {
    await recoverInflightV4Episodes({});
    _resetForTests();
    const r = await recoverInflightV4Episodes({});
    assert.notEqual(r.reason, 'already_ran');
    assert.equal(r.reason, 'no_service'); // back to the no_service guard
  });
});
