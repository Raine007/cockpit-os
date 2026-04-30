/**
 * Dispatcher engine.
 *
 * Two entry points:
 *
 *  - submit(): user-facing. Takes a NewJob, runs it through the router,
 *    enqueues, and (in the in-process model) immediately drives the job
 *    through claim → run → done/failed. In the cloud model (Phase 3+),
 *    submit() will only enqueue and rely on a Firestore trigger to drive
 *    execution. Same call site, two deployment topologies.
 *
 *  - drive(): internal. Picks up a queued job and runs one attempt. Safe
 *    to invoke from a Cloud Function on document create/update.
 *
 * The engine never executes capability code itself; it asks a worker to.
 */

import { createContext } from '../context/index.js';
import { getWorker } from '../workers/index.js';
import { routeJob } from './router.js';
import {
  enqueue,
  getJob,
  markAwaitingInput,
  markClaimed,
  markDone,
  markFailed,
  markRunning,
} from './queue.js';
import type { CockpitJob, NewJob, WorkerResult } from './types.js';

export interface SubmitOptions {
  /** When true (default outside production), drive the job synchronously. */
  drive?: boolean;
}

export interface SubmitResult {
  job: CockpitJob;
  /** Present when drive=true. */
  result?: WorkerResult;
}

export async function submit(
  input: NewJob,
  opts: SubmitOptions = {},
): Promise<SubmitResult> {
  const decision = routeJob(input);
  const ctx = createContext({ uid: input.uid, source: 'rpc' });
  ctx.log.info('routing job', {
    intent: input.intent,
    worker: decision.worker,
    reason: decision.reason,
  });

  const job = await enqueue(ctx, input, decision.worker);

  if (opts.drive ?? true) {
    const driven = await drive(job.id);
    return { job: driven.job, result: driven.result };
  }
  return { job };
}

export interface DriveResult {
  job: CockpitJob;
  result: WorkerResult;
}

export async function drive(jobId: string): Promise<DriveResult> {
  // Each drive() runs in its own context so retries see a fresh logger /
  // startedAt and the audit trail stays clean.
  let ctx = createContext({ uid: 'system', source: 'rpc' });
  let job = await getJob(ctx, jobId);
  if (!job) {
    throw new Error(`job ${jobId} not found`);
  }

  // Recreate context on the job's behalf so capability handlers see the
  // right uid (Firestore security rules will care about this in production).
  ctx = createContext({ uid: job.uid, source: 'rpc' });

  if (job.status !== 'queued') {
    return {
      job,
      result: {
        ok: false,
        error: `job ${jobId} is in status "${job.status}", not queued`,
        fatal: true,
      },
    };
  }

  job = await markClaimed(ctx, job);
  job = await markRunning(ctx, job);

  const worker = getWorker(job.worker);
  let result: WorkerResult;
  try {
    result = await worker.run(job, ctx);
  } catch (err) {
    // Workers shouldn't throw, but if they do we treat it as a non-fatal
    // failure unless they explicitly say otherwise.
    const message = err instanceof Error ? err.message : String(err);
    ctx.log.error('worker threw', { jobId, worker: worker.id, error: message });
    result = { ok: false, error: `worker threw: ${message}` };
  }

  // Async-worker park: the worker accepted the job but completion will
  // arrive via an external callback (e.g. /hooks/computer-done). We don't
  // mark done or failed here.
  if (result.awaitingInput) {
    job = await markAwaitingInput(ctx, job, result.externalTaskId ?? null);
    ctx.log.info('job parked awaiting external callback', {
      jobId: job.id,
      worker: worker.id,
      externalTaskId: job.externalTaskId,
    });
    return { job, result };
  }

  if (result.ok) {
    job = await markDone(ctx, job, result.artifacts ?? []);
  } else {
    job = await markFailed(ctx, job, result.error ?? 'unknown error', {
      fatal: result.fatal,
    });
  }

  return { job, result };
}
