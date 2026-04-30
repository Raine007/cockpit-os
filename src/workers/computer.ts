/**
 * Phase 4 — Computer worker adapter.
 *
 * Heavy-lift jobs route here. The flow:
 *
 *   1. Build a `ComputerTaskRequest` from the parked job + the registry's
 *      capability list (so Computer knows which Cockpit MCP tools it may
 *      call back into).
 *   2. POST it to the Computer dispatch endpoint via a pluggable client.
 *   3. Return `{ ok: true, awaitingInput: true }` so the engine parks the
 *      job in `awaiting_input`. We do NOT block waiting for completion —
 *      Computer eventually POSTs `/hooks/computer-done`, which lands in
 *      `handleComputerCallback()` and resumes the job.
 *
 * If dispatch itself fails:
 *   - 4xx (malformed request, auth, etc.): `fatal: true` so the engine
 *     marks the job failed and doesn't burn retries on a request that
 *     will never succeed.
 *   - 5xx / network: non-fatal — the engine re-queues until attempts
 *     are exhausted.
 *
 * Test injection:
 *   `setComputerWorkerClientForTesting(client)` swaps the dispatch client
 *   without touching env or the singleton. Tests rely on this.
 */

import { randomUUID } from 'node:crypto';

import {
  getDefaultComputerClient,
  type ComputerClient,
} from '../computer/client.js';
import type { ComputerTaskRequest } from '../computer/types.js';
import type { CockpitContext } from '../context/types.js';
import type { CockpitJob, WorkerResult } from '../dispatcher/types.js';
import type { CockpitWorker } from './types.js';

let injectedClient: ComputerClient | null = null;

export function setComputerWorkerClientForTesting(client: ComputerClient | null): void {
  injectedClient = client;
}

function resolveClient(): ComputerClient {
  return injectedClient ?? getDefaultComputerClient();
}

function buildCallbackUrl(): string {
  const base = process.env.OPENCLAW_GATEWAY_BASE_URL ?? 'http://127.0.0.1:18789';
  return `${base.replace(/\/$/, '')}/hooks/computer-done`;
}

function buildTaskRequest(job: CockpitJob): ComputerTaskRequest {
  const taskId = `ct_${job.id}_${randomUUID().slice(0, 8)}`;
  return {
    taskId,
    jobId: job.id,
    uid: job.uid,
    intent: job.intent,
    payload: job.payload,
    capabilities: job.context.capabilities ?? [],
    callbackUrl: buildCallbackUrl(),
    ...(job.context.deadlineAt && { deadlineAt: job.context.deadlineAt }),
  };
}

export const computerWorker: CockpitWorker = {
  id: 'computer',

  async run(job: CockpitJob, ctx: CockpitContext): Promise<WorkerResult> {
    const client = resolveClient();
    const req = buildTaskRequest(job);

    ctx.log.info('computer worker dispatching', {
      jobId: job.id,
      intent: job.intent,
      taskId: req.taskId,
    });

    let res;
    try {
      res = await client.submit(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error('computer dispatch threw', { jobId: job.id, error: message });
      return { ok: false, error: `computer dispatch threw: ${message}` };
    }

    if (!res.ok) {
      return {
        ok: false,
        error: res.error ?? 'computer dispatch failed',
        ...(res.fatal && { fatal: true }),
      };
    }

    // Successfully dispatched. Park the job; the callback will resume it.
    return {
      ok: true,
      awaitingInput: true,
      externalTaskId: res.taskId ?? req.taskId,
    };
  },
};
