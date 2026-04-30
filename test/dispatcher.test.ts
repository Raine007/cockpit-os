/**
 * End-to-end dispatcher test: submit() → enqueue → drive → done.
 * Runs entirely in dry-run mode against the in-memory Firestore shim.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.COCKPIT_DRY_RUN = '1';
process.env.COCKPIT_LOG_LEVEL = 'error';

import '../src/capabilities/index.js';
import { submit } from '../src/dispatcher/index.js';
import { setComputerWorkerClientForTesting } from '../src/workers/index.js';

describe('dispatcher.submit (sync drive)', () => {
  it('runs a capability intent end-to-end', async () => {
    const r = await submit({
      uid: 'u1',
      intent: 'cap:task-create',
      source: 'test',
      payload: { title: 'phase 2 ready' },
    });
    assert.equal(r.job.status, 'done');
    assert.equal(r.job.worker, 'local');
    assert.equal(r.job.attempts, 1);
    assert.equal(r.result?.ok, true);
  });

  it('marks fatal failures as failed without retrying', async () => {
    const r = await submit({
      uid: 'u1',
      intent: 'cap:does-not-exist',
      source: 'test',
    });
    assert.equal(r.job.status, 'failed');
    assert.equal(r.job.attempts, 1);
    assert.match(r.job.lastError ?? '', /unknown capability/);
  });

  it('rejects bad payloads via Zod and stops (fatal=true)', async () => {
    const r = await submit({
      uid: 'u1',
      intent: 'cap:flight-log',
      source: 'test',
      payload: { tail: '!!!', route: 'A → B', hours: 1 },
    });
    assert.equal(r.job.status, 'failed');
    // Zod validation errors are fatal, so attempts is exactly 1.
    assert.equal(r.job.attempts, 1);
  });

  it('routes computer-bound jobs and parks them awaiting callback', async () => {
    setComputerWorkerClientForTesting({
      async submit(req) {
        return { ok: true, taskId: req.taskId };
      },
    });
    try {
      const r = await submit({
        uid: 'u1',
        intent: 'manual-computer-job',
        source: 'test',
        worker: 'computer',
      });
      assert.equal(r.job.worker, 'computer');
      assert.equal(r.job.status, 'awaiting_input');
      assert.equal(r.result?.ok, true);
      assert.equal(r.result?.awaitingInput, true);
      assert.match(r.job.externalTaskId ?? '', /^ct_/);
    } finally {
      setComputerWorkerClientForTesting(null);
    }
  });

  it('marks computer dispatch failures fatal when the API rejects 4xx-style', async () => {
    setComputerWorkerClientForTesting({
      async submit() {
        return { ok: false, error: 'bad request', fatal: true };
      },
    });
    try {
      const r = await submit({
        uid: 'u1',
        intent: 'manual-computer-job',
        source: 'test',
        worker: 'computer',
      });
      assert.equal(r.job.status, 'failed');
      assert.equal(r.job.attempts, 1);
      assert.match(r.job.lastError ?? '', /bad request/);
    } finally {
      setComputerWorkerClientForTesting(null);
    }
  });

  it('queue-only mode does not drive', async () => {
    const r = await submit(
      {
        uid: 'u1',
        intent: 'cap:task-create',
        source: 'test',
        payload: { title: 'queued only' },
      },
      { drive: false },
    );
    assert.equal(r.job.status, 'queued');
    assert.equal(r.result, undefined);
  });
});
