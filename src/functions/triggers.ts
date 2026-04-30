/**
 * Firestore trigger handlers.
 *
 * These are framework-agnostic. In production you wrap each one in a Cloud
 * Functions v2 export, e.g.:
 *
 *   export const onJobCreated = onDocumentCreated('jobs/{jobId}', (e) =>
 *     handleJobCreated(e.data?.data()));
 *
 *   export const onJobUpdated = onDocumentUpdated('jobs/{jobId}', (e) =>
 *     handleJobUpdated(e.data?.before.data(), e.data?.after.data()));
 *
 * Keeping them framework-agnostic lets us unit-test the logic without
 * spinning up the Firebase emulator and lets us reuse the same handlers
 * if we ever move off Cloud Functions.
 */

import { createContext } from '../context/index.js';
import { drive } from '../dispatcher/engine.js';
import { CockpitJobSchema, type CockpitJob } from '../dispatcher/types.js';
import { notify, type NotifyOptions } from '../notifications/fabric.js';
import type { Notification } from '../notifications/types.js';

export interface TriggerOptions {
  notify?: NotifyOptions;
}

/**
 * Called when a new job appears in Firestore. Drive it through the engine.
 * Idempotent: drive() rejects jobs that are not in 'queued', so re-deliveries
 * of the create event won't double-execute.
 */
export async function handleJobCreated(
  data: unknown,
  _opts: TriggerOptions = {},
): Promise<{ status: 'ok' | 'skipped'; reason?: string }> {
  let job: CockpitJob;
  try {
    job = CockpitJobSchema.parse(data);
  } catch (err) {
    return {
      status: 'skipped',
      reason: `invalid job document: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (job.status !== 'queued') {
    return { status: 'skipped', reason: `status=${job.status}` };
  }
  await drive(job.id);
  return { status: 'ok' };
}

/**
 * Called when a job document changes. We only care about transitions into
 * a terminal state (done | failed) so we can fire the user-facing notification.
 *
 * The status check uses both before+after; if before was already terminal
 * we skip, so updates to artifacts on a done job don't re-notify.
 */
export async function handleJobUpdated(
  before: unknown,
  after: unknown,
  opts: TriggerOptions = {},
): Promise<{ status: 'notified' | 'skipped'; reason?: string }> {
  let prev: CockpitJob;
  let next: CockpitJob;
  try {
    prev = CockpitJobSchema.parse(before);
    next = CockpitJobSchema.parse(after);
  } catch (err) {
    return {
      status: 'skipped',
      reason: `invalid job document: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const wasTerminal = prev.status === 'done' || prev.status === 'failed';
  const isTerminal = next.status === 'done' || next.status === 'failed';

  if (!isTerminal || wasTerminal) {
    return { status: 'skipped', reason: `prev=${prev.status} next=${next.status}` };
  }

  const ctx = createContext({ uid: next.uid, source: 'webhook' });
  const notif = jobToNotification(next);
  await notify(ctx, notif, opts.notify ?? {});
  return { status: 'notified' };
}

/* -------------------------------------------------------------------------- */
/* Notification rendering for jobs                                             */
/* -------------------------------------------------------------------------- */

export function jobToNotification(job: CockpitJob): Notification {
  if (job.status === 'done') {
    const links = job.artifacts.map((a) => ({
      label: a.label ?? a.kind,
      url: a.url,
    }));
    return {
      uid: job.uid,
      kind: `job-done:${job.intent}`,
      title: `Done: ${job.intent}`,
      body:
        `Finished ${job.intent} (worker: ${job.worker}, attempts: ${job.attempts}).` +
        (links.length ? ` ${links.length} artifact${links.length === 1 ? '' : 's'} attached.` : ''),
      severity: 'success',
      ...(links.length > 0 && { links }),
      ...(job.deliver && { deliver: job.deliver }),
    };
  }
  // failed
  return {
    uid: job.uid,
    kind: `job-failed:${job.intent}`,
    title: `Failed: ${job.intent}`,
    body:
      `Job ${job.intent} failed after ${job.attempts} attempt${job.attempts === 1 ? '' : 's'}.` +
      (job.lastError ? ` Last error: ${job.lastError}` : ''),
    severity: 'error',
    ...(job.deliver && { deliver: job.deliver }),
  };
}
