/**
 * Firestore-backed job queue.
 *
 * The queue's only responsibility is durable persistence + atomic state
 * transitions. It does NOT decide who runs the job (that's the router) or
 * actually run it (that's a worker). Keeping the seams sharp means we can
 * swap Firestore for something else later without touching the workers.
 *
 * In dry-run mode (no Firebase creds), the in-memory shim from src/context
 * is used — every test in this repo exercises the same code paths as
 * production, just against the shim.
 */

import { emitAuditEvent } from '../audit/log.js';
import type { CockpitContext } from '../context/types.js';
import {
  CockpitJobSchema,
  NewJobSchema,
  TERMINAL_STATUSES,
  type CockpitJob,
  type JobArtifact,
  type JobStatus,
  type NewJob,
  type Worker,
} from './types.js';

const COLLECTION = 'jobs';

function now(): string {
  return new Date().toISOString();
}

function newId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Insert a new job. Status is always 'queued'; worker is set by the router
 * caller before it lands here so the queue stays dumb.
 */
export async function enqueue(
  ctx: CockpitContext,
  input: NewJob,
  worker: Worker,
): Promise<CockpitJob> {
  const parsed = NewJobSchema.parse(input);
  const id = newId();
  const ts = now();

  const job: CockpitJob = CockpitJobSchema.parse({
    id,
    uid: parsed.uid,
    intent: parsed.intent,
    payload: parsed.payload ?? {},
    worker: parsed.worker ?? worker,
    status: 'queued' as JobStatus,
    version: 0,
    artifacts: [],
    deliver: parsed.deliver,
    context: parsed.context ?? {},
    attempts: 0,
    maxAttempts: parsed.maxAttempts ?? 3,
    lastError: null,
    createdAt: ts,
    updatedAt: ts,
    finishedAt: null,
    source: parsed.source,
  });

  await ctx.db.collection(COLLECTION).doc(id).set(job);
  ctx.log.info('job enqueued', { id, intent: job.intent, worker: job.worker });
  await emitAuditEvent(ctx, {
    kind: 'job.enqueued',
    uid: job.uid,
    source: 'queue',
    ref: job.id,
    data: { intent: job.intent, worker: job.worker, source: job.source },
  });
  return job;
}

/** Fetch a job by id; returns null if missing. */
export async function getJob(
  ctx: CockpitContext,
  id: string,
): Promise<CockpitJob | null> {
  const snap = await ctx.db.collection(COLLECTION).doc(id).get();
  if (!snap.exists) return null;
  // Re-parse: protects against schema drift and stale documents.
  return CockpitJobSchema.parse(snap.data());
}

/**
 * Atomic-ish state transition. The dry-run shim does not implement real
 * transactions, but the optimistic-version check still detects local races.
 * In production with real Firestore, swap this to runTransaction().
 */
async function transition(
  ctx: CockpitContext,
  id: string,
  expectedVersion: number,
  patch: Partial<CockpitJob>,
): Promise<CockpitJob> {
  const current = await getJob(ctx, id);
  if (!current) throw new Error(`job ${id} not found`);
  if (current.version !== expectedVersion) {
    throw new Error(
      `job ${id} version mismatch: expected ${expectedVersion}, found ${current.version}`,
    );
  }
  const next: CockpitJob = CockpitJobSchema.parse({
    ...current,
    ...patch,
    version: current.version + 1,
    updatedAt: now(),
    finishedAt: TERMINAL_STATUSES.has((patch.status ?? current.status) as JobStatus)
      ? now()
      : current.finishedAt,
  });
  await ctx.db.collection(COLLECTION).doc(id).set(next);
  return next;
}

export async function markClaimed(
  ctx: CockpitContext,
  job: CockpitJob,
): Promise<CockpitJob> {
  const next = await transition(ctx, job.id, job.version, {
    status: 'claimed',
    attempts: job.attempts + 1,
  });
  await emitAuditEvent(ctx, {
    kind: 'job.claimed',
    uid: next.uid,
    source: 'queue',
    ref: next.id,
    data: { worker: next.worker, attempt: next.attempts },
  });
  return next;
}

export async function markRunning(
  ctx: CockpitContext,
  job: CockpitJob,
): Promise<CockpitJob> {
  return transition(ctx, job.id, job.version, { status: 'running' });
}

export async function markDone(
  ctx: CockpitContext,
  job: CockpitJob,
  artifacts: JobArtifact[] = [],
): Promise<CockpitJob> {
  const next = await transition(ctx, job.id, job.version, {
    status: 'done',
    artifacts: [...job.artifacts, ...artifacts],
    lastError: null,
  });
  await emitAuditEvent(ctx, {
    kind: 'job.done',
    uid: next.uid,
    source: 'queue',
    ref: next.id,
    data: {
      worker: next.worker,
      attempts: next.attempts,
      artifacts: next.artifacts.length,
    },
  });
  return next;
}

export async function markFailed(
  ctx: CockpitContext,
  job: CockpitJob,
  error: string,
  opts: { fatal?: boolean } = {},
): Promise<CockpitJob> {
  // If we still have attempts and the failure isn't fatal, requeue.
  const willRetry = !opts.fatal && job.attempts < job.maxAttempts;
  const next = await transition(ctx, job.id, job.version, {
    status: willRetry ? 'queued' : 'failed',
    lastError: error,
  });
  await emitAuditEvent(ctx, {
    kind: willRetry ? 'job.requeued' : 'job.failed',
    uid: next.uid,
    source: 'queue',
    ref: next.id,
    data: {
      worker: next.worker,
      attempts: next.attempts,
      maxAttempts: next.maxAttempts,
      fatal: !!opts.fatal,
      error,
    },
  });
  return next;
}

export async function markCancelled(
  ctx: CockpitContext,
  job: CockpitJob,
): Promise<CockpitJob> {
  return transition(ctx, job.id, job.version, {
    status: 'cancelled',
    lastError: 'cancelled by user',
  });
}

/**
 * Park a job that an async worker accepted but hasn't completed yet. The
 * external callback (e.g. /hooks/computer-done) is responsible for moving
 * it to a terminal state.
 */
export async function markAwaitingInput(
  ctx: CockpitContext,
  job: CockpitJob,
  externalTaskId: string | null = null,
): Promise<CockpitJob> {
  const next = await transition(ctx, job.id, job.version, {
    status: 'awaiting_input',
    externalTaskId,
  });
  await emitAuditEvent(ctx, {
    kind: 'job.awaiting',
    uid: next.uid,
    source: 'queue',
    ref: next.id,
    data: { worker: next.worker, externalTaskId: externalTaskId ?? null },
  });
  return next;
}
