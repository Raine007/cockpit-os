/**
 * Phase 5 — Observability dashboard data layer.
 *
 * Read-only views over the audit log + job queue. The dashboard front-end
 * (rendered by the OpenClaw gateway or any web UI) hits these helpers; they
 * collapse a stream of audit events into a small set of counters and
 * recent-events lists that humans can scan.
 *
 * Why these specific shapes:
 *   - `kindCounts` answers "what's happening overall?" — useful for the
 *     "system pulse" tile on the home dashboard.
 *   - `sourceCounts` answers "which surface is most active?" — webhook-heavy
 *     means lots of inbound traffic, queue-heavy means lots of work running.
 *   - `jobStatusHistogram` answers "what's the queue look like right now?" —
 *     it reads the `jobs` collection directly (not the audit log) because
 *     status is current state, not history.
 *   - `recentForUid` is the per-user activity feed.
 *
 * All queries run against the dry-run shim in tests, real Firestore in
 * production. The shape doesn't change between modes.
 */

import { queryEvents, recentEvents } from '../audit/log.js';
import type { AuditEvent, AuditEventKind } from '../audit/types.js';
import type { CockpitContext } from '../context/types.js';
import { JOB_STATUSES, type JobStatus } from '../dispatcher/types.js';

const JOBS_COLLECTION = 'jobs';

/* -------------------------------------------------------------------------- */
/* Counters                                                                    */
/* -------------------------------------------------------------------------- */

export interface KindCount {
  kind: AuditEventKind;
  count: number;
}

export interface SourceCount {
  source: AuditEvent['source'];
  count: number;
}

export interface DashboardSummary {
  /** Total audit events in the requested window. */
  totalEvents: number;
  /** Counts grouped by event kind, sorted descending. */
  byKind: KindCount[];
  /** Counts grouped by source surface, sorted descending. */
  bySource: SourceCount[];
  /** ISO timestamps of the first and last event in the window, if any. */
  firstAt: string | null;
  lastAt: string | null;
}

export interface SummaryQuery {
  /** Filter to a single uid. Omit for system-wide. */
  uid?: string;
  /** Inclusive ISO lower bound. */
  since?: string;
  /** Inclusive ISO upper bound. */
  until?: string;
  /** Hard cap on rows scanned; defaults to 1000 to keep the dashboard quick. */
  scanLimit?: number;
}

/**
 * Group + count the audit events matching a query. Single-pass over the
 * events so dry-run + production behave the same.
 */
export async function dashboardSummary(
  ctx: CockpitContext,
  query: SummaryQuery = {},
): Promise<DashboardSummary> {
  const events = await queryEvents(ctx, {
    ...(query.uid && { uid: query.uid }),
    ...(query.since && { since: query.since }),
    ...(query.until && { until: query.until }),
    limit: query.scanLimit ?? 1000,
  });

  const kindMap = new Map<AuditEventKind, number>();
  const sourceMap = new Map<AuditEvent['source'], number>();
  let firstAt: string | null = null;
  let lastAt: string | null = null;

  for (const ev of events) {
    kindMap.set(ev.kind, (kindMap.get(ev.kind) ?? 0) + 1);
    sourceMap.set(ev.source, (sourceMap.get(ev.source) ?? 0) + 1);
    if (!lastAt || ev.at > lastAt) lastAt = ev.at;
    if (!firstAt || ev.at < firstAt) firstAt = ev.at;
  }

  const byKind: KindCount[] = [...kindMap.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));

  const bySource: SourceCount[] = [...sourceMap.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));

  return {
    totalEvents: events.length,
    byKind,
    bySource,
    firstAt,
    lastAt,
  };
}

/* -------------------------------------------------------------------------- */
/* Per-uid recent activity                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The N most recent audit events for a uid. Convenience wrapper so callers
 * don't have to think about query shape.
 */
export async function recentForUid(
  ctx: CockpitContext,
  uid: string,
  limit = 25,
): Promise<AuditEvent[]> {
  return queryEvents(ctx, { uid, limit });
}

/** Most recent N events, all uids. Useful for the "everything happening" feed. */
export async function recentSystemActivity(
  ctx: CockpitContext,
  limit = 50,
): Promise<AuditEvent[]> {
  return recentEvents(ctx, limit);
}

/* -------------------------------------------------------------------------- */
/* Job status histogram                                                        */
/* -------------------------------------------------------------------------- */

export type JobStatusHistogram = Record<JobStatus, number>;

/**
 * Read the jobs collection and bucket by current status. Independent from
 * the audit log because status is current state — the audit log gives
 * history, this gives now.
 */
export async function jobStatusHistogram(
  ctx: CockpitContext,
  uid?: string,
): Promise<JobStatusHistogram> {
  const histogram = Object.fromEntries(
    JOB_STATUSES.map((s) => [s, 0]),
  ) as JobStatusHistogram;

  const snap = await ctx.db.collection(JOBS_COLLECTION).get();
  for (const doc of snap.docs) {
    const data = doc.data() as { uid?: string; status?: JobStatus } | undefined;
    if (!data) continue;
    if (uid && data.uid !== uid) continue;
    const status = data.status;
    if (status && status in histogram) {
      histogram[status] += 1;
    }
  }
  return histogram;
}
