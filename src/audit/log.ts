/**
 * Phase 5 — Audit log writer + reader.
 *
 * Writes go to `audit_events/{auto-id}`. Reads are deliberately tiny:
 * `recentEvents()` returns the last N events for the dashboard, and
 * `queryEvents()` covers the rest. Production swaps these for indexed
 * Firestore queries; the dry-run shim does linear scan over the in-memory
 * Map, which is fine for tests.
 *
 * Failure policy: emit() never throws — a broken audit pipe must not break
 * a job. We log at error level if the underlying write fails and move on.
 */

import { logger } from '../context/logger.js';
import type { CockpitContext } from '../context/types.js';
import {
  AuditEmitInputSchema,
  AuditEventSchema,
  type AuditEmitInput,
  type AuditEvent,
  type AuditQuery,
} from './types.js';

const COLLECTION = 'audit_events';

function nowIso(): string {
  return new Date().toISOString();
}

function newEventId(): string {
  // Sortable id so a forEach-iterated dry-run shim returns events in
  // approximate chronological order. Real Firestore uses orderBy('at').
  return `aev_${Date.now().toString().padStart(13, '0')}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/**
 * Emit a single audit event. Best-effort: a write failure logs + returns
 * the (un-persisted) event so the caller can still observe it.
 */
export async function emitAuditEvent(
  ctx: CockpitContext,
  input: AuditEmitInput,
): Promise<AuditEvent> {
  const parsedInput = AuditEmitInputSchema.parse(input);
  const ev = AuditEventSchema.parse({
    id: newEventId(),
    at: nowIso(),
    kind: parsedInput.kind,
    uid: parsedInput.uid,
    source: parsedInput.source,
    ref: parsedInput.ref ?? null,
    data: parsedInput.data ?? {},
  });

  try {
    await ctx.db.collection(COLLECTION).doc(ev.id).set(ev);
  } catch (err) {
    logger.error('audit emit failed', {
      kind: ev.kind,
      uid: ev.uid,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return ev;
}

/**
 * Read events matching a query. Defaults to last 100, newest first.
 */
export async function queryEvents(
  ctx: CockpitContext,
  query: AuditQuery = {},
): Promise<AuditEvent[]> {
  const snap = await ctx.db.collection(COLLECTION).get();
  const out: AuditEvent[] = [];
  for (const doc of snap.docs) {
    try {
      const ev = AuditEventSchema.parse(doc.data());
      if (query.uid && ev.uid !== query.uid) continue;
      if (query.kind && ev.kind !== query.kind) continue;
      if (query.source && ev.source !== query.source) continue;
      if (query.since && ev.at < query.since) continue;
      if (query.until && ev.at > query.until) continue;
      out.push(ev);
    } catch {
      // Skip un-parseable rows. Real Firestore migrations should surface them.
    }
  }
  out.sort((a, b) => b.at.localeCompare(a.at)); // newest first
  return out.slice(0, query.limit ?? 100);
}

/** Convenience: most recent N events (any uid). */
export async function recentEvents(
  ctx: CockpitContext,
  limit = 25,
): Promise<AuditEvent[]> {
  return queryEvents(ctx, { limit });
}
