/**
 * Phase 4 — Computer worker adapter unit tests.
 *
 * Drives the worker in isolation (no engine, no callback) to lock down its
 * dispatch contract: it must POST a well-formed request, accept a sync
 * dispatch response, and return WorkerResult with awaitingInput=true.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.COCKPIT_DRY_RUN = '1';
process.env.COCKPIT_LOG_LEVEL = 'error';
process.env.OPENCLAW_GATEWAY_BASE_URL = 'http://gw.test';

import { createContext } from '../src/context/index.js';
import { CockpitJobSchema, type CockpitJob } from '../src/dispatcher/types.js';
import {
  computerWorker,
  setComputerWorkerClientForTesting,
} from '../src/workers/index.js';
import type { ComputerTaskRequest } from '../src/computer/index.js';

function makeJob(overrides: Partial<CockpitJob> = {}): CockpitJob {
  const ts = new Date().toISOString();
  return CockpitJobSchema.parse({
    id: 'job_test_1',
    uid: 'u1',
    intent: 'flight-anomaly-report',
    payload: { window: '7d' },
    worker: 'computer',
    status: 'running',
    version: 2,
    artifacts: [],
    context: { capabilities: ['flight-log', 'note-append'] },
    attempts: 1,
    maxAttempts: 3,
    lastError: null,
    createdAt: ts,
    updatedAt: ts,
    finishedAt: null,
    source: 'test',
    externalTaskId: null,
    ...overrides,
  });
}

describe('computerWorker.run', () => {
  it('parks the job and surfaces externalTaskId from a successful dispatch', async () => {
    let captured: ComputerTaskRequest | null = null;
    setComputerWorkerClientForTesting({
      async submit(req) {
        captured = req;
        return { ok: true, taskId: 'computer-side-id-99' };
      },
    });
    try {
      const ctx = createContext({ uid: 'u1', source: 'test' });
      const r = await computerWorker.run(makeJob(), ctx);
      assert.equal(r.ok, true);
      assert.equal(r.awaitingInput, true);
      assert.equal(r.externalTaskId, 'computer-side-id-99');
      assert.ok(captured, 'client.submit was called');
      const req = captured as ComputerTaskRequest;
      assert.equal(req.jobId, 'job_test_1');
      assert.equal(req.intent, 'flight-anomaly-report');
      assert.deepEqual(req.payload, { window: '7d' });
      assert.deepEqual(req.capabilities, ['flight-log', 'note-append']);
      assert.equal(req.callbackUrl, 'http://gw.test/hooks/computer-done');
      assert.match(req.taskId, /^ct_job_test_1_/);
    } finally {
      setComputerWorkerClientForTesting(null);
    }
  });

  it('falls back to the cockpit-side taskId when computer omits one', async () => {
    setComputerWorkerClientForTesting({
      async submit() {
        return { ok: true };
      },
    });
    try {
      const ctx = createContext({ uid: 'u1', source: 'test' });
      const r = await computerWorker.run(makeJob(), ctx);
      assert.equal(r.awaitingInput, true);
      assert.match(r.externalTaskId ?? '', /^ct_job_test_1_/);
    } finally {
      setComputerWorkerClientForTesting(null);
    }
  });

  it('surfaces fatal=true on 4xx-style dispatch failures', async () => {
    setComputerWorkerClientForTesting({
      async submit() {
        return { ok: false, error: 'unauthorized', fatal: true };
      },
    });
    try {
      const ctx = createContext({ uid: 'u1', source: 'test' });
      const r = await computerWorker.run(makeJob(), ctx);
      assert.equal(r.ok, false);
      assert.equal(r.fatal, true);
      assert.match(r.error ?? '', /unauthorized/);
    } finally {
      setComputerWorkerClientForTesting(null);
    }
  });

  it('returns non-fatal failure when dispatch throws (network)', async () => {
    setComputerWorkerClientForTesting({
      async submit() {
        throw new Error('ECONNREFUSED');
      },
    });
    try {
      const ctx = createContext({ uid: 'u1', source: 'test' });
      const r = await computerWorker.run(makeJob(), ctx);
      assert.equal(r.ok, false);
      assert.equal(r.fatal, undefined);
      assert.match(r.error ?? '', /ECONNREFUSED/);
    } finally {
      setComputerWorkerClientForTesting(null);
    }
  });

  it('passes deadlineAt through when set on the job context', async () => {
    let captured: ComputerTaskRequest | null = null;
    setComputerWorkerClientForTesting({
      async submit(req) {
        captured = req;
        return { ok: true };
      },
    });
    try {
      const ctx = createContext({ uid: 'u1', source: 'test' });
      const job = makeJob({
        context: {
          capabilities: ['flight-log'],
          deadlineAt: '2026-12-31T23:59:00Z',
        },
      });
      await computerWorker.run(job, ctx);
      assert.ok(captured);
      assert.equal((captured as ComputerTaskRequest).deadlineAt, '2026-12-31T23:59:00Z');
    } finally {
      setComputerWorkerClientForTesting(null);
    }
  });
});
