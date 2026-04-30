/**
 * Inbound webhook handler. The OpenClaw gateway POSTs to /hooks/cockpit-*
 * when something happens on its side (a chat message arrived, a permission
 * was granted, etc.) and Cockpit OS turns that into a job.
 *
 * This module is transport-agnostic. A Cloud Function or Express handler
 * unwraps the HTTP request, validates the auth header, and calls
 * `handleInboundEvent`. We never bind to an HTTP framework here.
 *
 * Security:
 *   - Bearer token, constant-time compared, read from env.
 *   - Idempotency via Firestore `webhook_events/{eventId}`. Replays are
 *     short-circuited; they return the original result.
 *   - Unknown mappings are rejected with a clear error so misconfigured
 *     hooks fail loudly instead of silently spawning garbage jobs.
 */

import { timingSafeEqual } from 'node:crypto';

import { emitAuditEvent } from '../audit/log.js';
import { submit } from '../dispatcher/engine.js';
import { resolveIdentity } from '../identity/resolver.js';
import type { CockpitContext } from '../context/types.js';
import {
  InboundEventSchema,
  type InboundEvent,
  type InboundResult,
} from '../notifications/types.js';

const EVENTS_COLLECTION = 'webhook_events';

/**
 * One mapping = one inbound event id + a handler that returns a job spec.
 * Phase 3 ships a small built-in registry; future phases can register more.
 */
export interface InboundMapping {
  /** Path suffix; full URL is /hooks/cockpit-<id>. */
  id: string;
  /** Friendly description; surfaces in the rendered openclaw.json. */
  description: string;
  /**
   * Build a job spec from the inbound payload. Return null to drop the
   * event without an error (e.g. filtered by content).
   */
  toJob(event: InboundEvent): {
    uid: string;
    intent: string;
    payload?: Record<string, unknown>;
    deliver?: { channel: string; to: string };
  } | null;
}

class InboundRegistry {
  private map = new Map<string, InboundMapping>();

  register(m: InboundMapping): void {
    if (this.map.has(m.id)) {
      throw new Error(`Inbound mapping "${m.id}" already registered.`);
    }
    this.map.set(m.id, m);
  }
  get(id: string): InboundMapping | undefined {
    return this.map.get(id);
  }
  list(): InboundMapping[] {
    return [...this.map.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
  _resetForTesting(): void {
    this.map.clear();
  }
}

export const inboundRegistry = new InboundRegistry();
export function registerInbound(m: InboundMapping): InboundMapping {
  inboundRegistry.register(m);
  return m;
}

/* -------------------------------------------------------------------------- */
/* Auth                                                                        */
/* -------------------------------------------------------------------------- */

export function checkInboundAuth(authHeader: string | undefined): boolean {
  const expected = process.env.OPENCLAW_HOOKS_TOKEN ?? '';
  if (!expected) {
    // No token configured = closed by default. Better than silently allowing.
    return false;
  }
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return false;
  }
  const provided = authHeader.slice('bearer '.length).trim();
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/* -------------------------------------------------------------------------- */
/* Handler                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Validate, dedupe, route. Returns a result the HTTP transport can serialize.
 */
export async function handleInboundEvent(
  ctx: CockpitContext,
  raw: unknown,
): Promise<InboundResult> {
  let event: InboundEvent;
  try {
    event = InboundEventSchema.parse(raw);
  } catch (err) {
    await emitAuditEvent(ctx, {
      kind: 'webhook.inbound.rejected',
      uid: 'system',
      source: 'webhook',
      data: {
        reason: 'schema',
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return {
      ok: false,
      error: `invalid event payload: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Idempotency: if eventId is provided, check the events collection.
  if (event.eventId) {
    const existing = await ctx.db
      .collection(EVENTS_COLLECTION)
      .doc(event.eventId)
      .get();
    if (existing.exists) {
      const data = existing.data() as { jobId?: string } | undefined;
      ctx.log.info('inbound replay short-circuited', {
        eventId: event.eventId,
        jobId: data?.jobId ?? null,
      });
      await emitAuditEvent(ctx, {
        kind: 'webhook.inbound.deduped',
        uid: event.uid ?? 'system',
        source: 'webhook',
        ref: event.eventId,
        data: {
          mappingId: event.mappingId,
          jobId: data?.jobId ?? null,
        },
      });
      const out: InboundResult = { ok: true };
      if (data?.jobId) out.jobId = data.jobId;
      return out;
    }
  }

  const mapping = inboundRegistry.get(event.mappingId);
  if (!mapping) {
    await emitAuditEvent(ctx, {
      kind: 'webhook.inbound.rejected',
      uid: event.uid ?? 'system',
      source: 'webhook',
      ...(event.eventId && { ref: event.eventId }),
      data: { reason: 'unknown_mapping', mappingId: event.mappingId },
    });
    return { ok: false, error: `unknown mapping "${event.mappingId}"` };
  }

  // Resolve identity from channel metadata when present. The resolved uid
  // takes precedence over both the gateway-claimed uid and the mapping's
  // own uid — only the registry is authoritative for who owns a handle.
  let resolvedUid: string | null = null;
  if (event.channel && event.handle) {
    const result = await resolveIdentity(ctx, {
      channel: event.channel,
      handle: event.handle,
    });
    if (!result.uid) {
      await emitAuditEvent(ctx, {
        kind: 'webhook.inbound.rejected',
        uid: 'system',
        source: 'webhook',
        ...(event.eventId && { ref: event.eventId }),
        data: {
          reason: result.reason ?? 'unknown_identity',
          channel: event.channel,
          handle: event.handle,
          mappingId: event.mappingId,
        },
      });
      return {
        ok: false,
        error: `identity ${result.reason ?? 'unknown'} for ${event.channel}:${event.handle}`,
      };
    }
    resolvedUid = result.uid;
  }

  const spec = mapping.toJob(event);
  if (!spec) {
    ctx.log.info('inbound dropped by mapping', { mappingId: event.mappingId });
    await emitAuditEvent(ctx, {
      kind: 'webhook.inbound.received',
      uid: resolvedUid ?? event.uid ?? 'system',
      source: 'webhook',
      ...(event.eventId && { ref: event.eventId }),
      data: { mappingId: event.mappingId, dropped: true },
    });
    return { ok: true };
  }

  // Pre-resolved channel uid wins. Otherwise trust the mapping's spec.
  const finalUid = resolvedUid ?? spec.uid;

  // Cloud-topology friendly: enqueue but don't drive synchronously. The
  // Firestore trigger handles execution.
  const submitted = await submit(
    {
      uid: finalUid,
      intent: spec.intent,
      source: 'webhook',
      payload: spec.payload ?? {},
      deliver: spec.deliver as InboundResult['jobId'] extends never
        ? never
        : Parameters<typeof submit>[0]['deliver'],
    },
    { drive: false },
  );

  if (event.eventId) {
    await ctx.db
      .collection(EVENTS_COLLECTION)
      .doc(event.eventId)
      .set({
        eventId: event.eventId,
        mappingId: event.mappingId,
        jobId: submitted.job.id,
        receivedAt: new Date().toISOString(),
      });
  }

  await emitAuditEvent(ctx, {
    kind: 'webhook.inbound.received',
    uid: finalUid,
    source: 'webhook',
    ref: event.eventId ?? submitted.job.id,
    data: {
      mappingId: event.mappingId,
      jobId: submitted.job.id,
      identityResolved: resolvedUid !== null,
    },
  });

  return { ok: true, jobId: submitted.job.id };
}
