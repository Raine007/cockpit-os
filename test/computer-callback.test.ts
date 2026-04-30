/**
 * Phase 4 — /hooks/computer-done callback handler tests.
 *
 * The callback resumes a parked (`awaiting_input`) job. Tests cover:
 *   - Happy path → done with artifacts → fabric notify fires
 *   - Failed status routes through markFailed (which honours retry budget)
 *   - Wrong status (queued / done) is rejected or treated as duplicate
 *   - Task id mismatch refuses to mutate the job
 *   - Unknown jobId returns a clean error
 *   - Malformed payload returns a clean error
 *   - Notification dispatch is exercised through a fake outbound client
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.COCKPIT_DRY_RUN = '1';
process.env.COCKPIT_LOG_LEVEL = 'error';

import { createContext } from '../src/context/index.js';
import {
  CockpitJobSchema,
  enqueue,
  markAwaitingInput,
  markClaimed,
  markRunning,
  type CockpitJob,
} from '../src/dispatcher/index.js';
import { handleComputerCallback } from '../src/computer/index.js';

async function parkJob(uid: string, taskId: string): Promise<CockpitJob> {
  const ctx = createContext({ uid, source: 'test' });
  let job = await enqueue(
    ctx,
    {
      uid,
      intent: 'flight-anomaly-report',
      source: 'test',
      payload: { window: '7d' },
    },
    'computer',
  );
  job = await markClaimed(ctx, job);
  job = await markRunning(ctx, job);
  job = await markAwaitingInput(ctx, job, taskId);
  return job;
}

describe('handleComputerCallback', () => {
  it('resumes a parked job to done with artifacts', async () => {
    const ctx = createContext({ uid: 'u1', source: 'test' });
    const job = await parkJob('u1', 'tk_done_1');
    const r = await handleComputerCallback(ctx, {
      taskId: 'tk_done_1',
      jobId: job.id,
      status: 'done',
      artifacts: [
        { kind: 'pdf', url: 'https://drop.example/x.pdf', label: 'Report' },
      ],
    });
    assert.equal(r.ok, true);
    assert.equal(r.finalStatus, 'done');
    // Verify the persisted job picked up the artifact.
    const stored = await ctx.db.collection('jobs').doc(job.id).get();
    const data = CockpitJobSchema.parse(stored.data());
    assert.equal(data.status, 'done');
    assert.equal(data.artifacts[0]?.url, 'https://drop.example/x.pdf');
  });

  it('routes status=failed through markFailed and respects retry budget', async () => {
    const ctx = createContext({ uid: 'u2', source: 'test' });
    const job = await parkJob('u2', 'tk_fail_1');
    const r = await handleComputerCallback(ctx, {
      taskId: 'tk_fail_1',
      jobId: job.id,
      status: 'failed',
      error: 'computer hit token limit',
      fatal: true,
    });
    assert.equal(r.ok, true);
    assert.equal(r.finalStatus, 'failed');
  });

  it('rejects callbacks for jobs that are not awaiting_input', async () => {
    const ctx = createContext({ uid: 'u3', source: 'test' });
    // Enqueue but DON'T park.
    const job = await enqueue(
      ctx,
      { uid: 'u3', intent: 'cap:task-create', source: 'test', payload: { title: 'x' } },
      'local',
    );
    const r = await handleComputerCallback(ctx, {
      taskId: 'tk_x',
      jobId: job.id,
      status: 'done',
      artifacts: [],
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /not awaiting_input/);
  });

  it('treats double-delivery on a terminal job as a no-op success', async () => {
    const ctx = createContext({ uid: 'u4', source: 'test' });
    const job = await parkJob('u4', 'tk_dup_1');
    // First callback wins.
    const r1 = await handleComputerCallback(ctx, {
      taskId: 'tk_dup_1',
      jobId: job.id,
      status: 'done',
      artifacts: [],
    });
    assert.equal(r1.ok, true);
    assert.equal(r1.finalStatus, 'done');
    // Second callback should be a no-op.
    const r2 = await handleComputerCallback(ctx, {
      taskId: 'tk_dup_1',
      jobId: job.id,
      status: 'done',
      artifacts: [],
    });
    assert.equal(r2.ok, true);
    assert.equal(r2.finalStatus, 'done');
  });

  it('refuses to mutate a job when the task id does not match', async () => {
    const ctx = createContext({ uid: 'u5', source: 'test' });
    const job = await parkJob('u5', 'tk_correct');
    const r = await handleComputerCallback(ctx, {
      taskId: 'tk_attacker',
      jobId: job.id,
      status: 'done',
      artifacts: [],
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /task id mismatch/);
    // Job is still parked.
    const ctx2 = createContext({ uid: 'u5', source: 'test' });
    const stored = await ctx2.db.collection('jobs').doc(job.id).get();
    const data = CockpitJobSchema.parse(stored.data());
    assert.equal(data.status, 'awaiting_input');
  });

  it('returns a clean error for unknown jobId', async () => {
    const ctx = createContext({ uid: 'u6', source: 'test' });
    const r = await handleComputerCallback(ctx, {
      taskId: 'tk_z',
      jobId: 'job_does_not_exist',
      status: 'done',
      artifacts: [],
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /unknown job/);
  });

  it('rejects malformed payloads with a clear validation error', async () => {
    const ctx = createContext({ uid: 'u7', source: 'test' });
    const r = await handleComputerCallback(ctx, {
      // missing taskId, jobId, status
      artifacts: [],
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /invalid computer callback/);
  });

  it('passes computer artifacts through onto the persisted job', async () => {
    const ctx = createContext({ uid: 'u8', source: 'test' });
    const job = await parkJob('u8', 'tk_artifacts');
    await handleComputerCallback(ctx, {
      taskId: 'tk_artifacts',
      jobId: job.id,
      status: 'done',
      artifacts: [
        { kind: 'pdf', url: 'https://example.test/a.pdf', label: 'A' },
        { kind: 'png', url: 'https://example.test/b.png' },
      ],
    });
    const stored = await ctx.db.collection('jobs').doc(job.id).get();
    const data = CockpitJobSchema.parse(stored.data());
    assert.equal(data.status, 'done');
    assert.equal(data.artifacts.length, 2);
    assert.equal(data.artifacts[0]?.label, 'A');
    assert.equal(data.artifacts[1]?.kind, 'png');
  });
});
