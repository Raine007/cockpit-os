/**
 * Phase 4 — Computer callback handler.
 *
 * Computer POSTs a `ComputerCallbackPayload` back to the OpenClaw gateway
 * at /hooks/computer-done. The gateway forwards it to Cockpit OS, the
 * inbound auth check runs (shared OPENCLAW_HOOKS_TOKEN), and we land here.
 *
 * Responsibilities:
 *   1. Parse + validate the payload.
 *   2. Look up the parked job and verify it's actually awaiting input AND
 *      that the task id matches what we persisted at park time. A stray
 *      callback with a wrong task id never resumes a job.
 *   3. Apply the result through the same queue helpers a normal worker
 *      run would use. `markFailed` honours retry budget, so a failed
 *      Computer task that still has attempts left is requeued.
 *   4. Notify completion via the Phase 3 fabric, exactly the way the
 *      Firestore trigger does for local jobs.
 *
 * Idempotency:
 *   The version check inside `transition()` makes double-deliveries safe:
 *   the second one fails with a version mismatch and we return `ok:true`
 *   with the already-final status.
 */

import { emitAuditEvent } from '../audit/log.js';
import type { JobArtifact } from '../dispatcher/types.js';
import {
  getJob,
  markDone,
  markFailed,
} from '../dispatcher/queue.js';
import { jobToNotification } from '../functions/triggers.js';
import { notify } from '../notifications/fabric.js';
import type { CockpitContext } from '../context/types.js';
import {
  ComputerCallbackPayloadSchema,
  type ComputerCallbackPayload,
  type ComputerCallbackResult,
} from './types.js';

export async function handleComputerCallback(
  ctx: CockpitContext,
  raw: unknown,
): Promise<ComputerCallbackResult> {
  let payload: ComputerCallbackPayload;
  try {
    payload = ComputerCallbackPayloadSchema.parse(raw);
  } catch (err) {
    await emitAuditEvent(ctx, {
      kind: 'computer.callback.rejected',
      uid: 'system',
      source: 'computer',
      data: {
        reason: 'schema',
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return {
      ok: false,
      error: `invalid computer callback: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const job = await getJob(ctx, payload.jobId);
  if (!job) {
    ctx.log.warn('computer callback for unknown job', { jobId: payload.jobId });
    await emitAuditEvent(ctx, {
      kind: 'computer.callback.rejected',
      uid: 'system',
      source: 'computer',
      ref: payload.jobId,
      data: { reason: 'unknown_job', taskId: payload.taskId },
    });
    return { ok: false, error: `unknown job "${payload.jobId}"` };
  }

  // Wrong status — either the job was already completed (duplicate delivery)
  // or it never parked. Treat duplicate-on-terminal as ok; everything else
  // is an error so we can spot routing mistakes.
  if (job.status !== 'awaiting_input') {
    if (job.status === 'done' || job.status === 'failed') {
      ctx.log.info('computer callback ignored: job already terminal', {
        jobId: job.id,
        status: job.status,
      });
      await emitAuditEvent(ctx, {
        kind: 'computer.callback.rejected',
        uid: job.uid,
        source: 'computer',
        ref: job.id,
        data: { reason: 'duplicate_on_terminal', terminalStatus: job.status },
      });
      return { ok: true, jobId: job.id, finalStatus: job.status };
    }
    await emitAuditEvent(ctx, {
      kind: 'computer.callback.rejected',
      uid: job.uid,
      source: 'computer',
      ref: job.id,
      data: { reason: 'wrong_status', status: job.status },
    });
    return {
      ok: false,
      error: `job ${job.id} is in status "${job.status}", not awaiting_input`,
    };
  }

  // Correlation check: the parked job must have the task id we're claiming
  // to be a callback for. Belt-and-suspenders against confused-deputy.
  if (job.externalTaskId && job.externalTaskId !== payload.taskId) {
    ctx.log.warn('computer callback task id mismatch', {
      jobId: job.id,
      expected: job.externalTaskId,
      provided: payload.taskId,
    });
    await emitAuditEvent(ctx, {
      kind: 'computer.callback.rejected',
      uid: job.uid,
      source: 'computer',
      ref: job.id,
      data: {
        reason: 'task_id_mismatch',
        expected: job.externalTaskId,
        provided: payload.taskId,
      },
    });
    return {
      ok: false,
      error: `task id mismatch on job ${job.id}`,
    };
  }

  await emitAuditEvent(ctx, {
    kind: 'computer.callback.received',
    uid: job.uid,
    source: 'computer',
    ref: job.id,
    data: { taskId: payload.taskId, status: payload.status },
  });

  let final;
  if (payload.status === 'done') {
    final = await markDone(ctx, job, payload.artifacts as JobArtifact[]);
  } else {
    final = await markFailed(ctx, job, payload.error ?? 'computer reported failure', {
      fatal: payload.fatal,
    });
  }

  // markFailed may have re-queued; only notify on truly terminal states.
  if (final.status === 'done' || final.status === 'failed') {
    try {
      await notify(ctx, jobToNotification(final));
    } catch (err) {
      ctx.log.error('computer callback: notification failed', {
        jobId: final.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    ok: true,
    jobId: final.id,
    finalStatus: final.status as 'done' | 'failed' | 'queued',
  };
}
