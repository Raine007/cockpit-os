/**
 * Phase 5 — Audit log tests.
 *
 * Covers the emit/read path, query filters, and the "never throws" guarantee.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.COCKPIT_DRY_RUN = '1';
process.env.COCKPIT_LOG_LEVEL = 'error';

import { emitAuditEvent, queryEvents, recentEvents } from '../src/audit/log.js';
import { createContext } from '../src/context/index.js';

describe('audit log', () => {
  it('emits and reads events back', async () => {
    const ctx = createContext({ uid: 'user_audit_a', source: 'queue' });
    const ev = await emitAuditEvent(ctx, {
      kind: 'job.enqueued',
      uid: 'user_audit_a',
      source: 'queue',
      ref: 'job_123',
      data: { intent: 'demo' },
    });
    assert.match(ev.id, /^aev_/);
    assert.equal(ev.kind, 'job.enqueued');
    assert.equal(ev.uid, 'user_audit_a');
    assert.equal(ev.ref, 'job_123');

    const rows = await queryEvents(ctx, { uid: 'user_audit_a' });
    assert.ok(
      rows.some((r) => r.id === ev.id),
      'emitted event must be readable',
    );
  });

  it('filters by kind, source, and uid', async () => {
    const ctx = createContext({ uid: 'system', source: 'queue' });
    await emitAuditEvent(ctx, {
      kind: 'job.done',
      uid: 'user_filter',
      source: 'queue',
      ref: 'jobF1',
    });
    await emitAuditEvent(ctx, {
      kind: 'job.failed',
      uid: 'user_filter',
      source: 'queue',
      ref: 'jobF2',
    });
    await emitAuditEvent(ctx, {
      kind: 'webhook.inbound.received',
      uid: 'user_filter',
      source: 'webhook',
      ref: 'evt1',
    });

    const onlyDone = await queryEvents(ctx, { uid: 'user_filter', kind: 'job.done' });
    assert.ok(onlyDone.every((e) => e.kind === 'job.done'));
    assert.ok(onlyDone.some((e) => e.ref === 'jobF1'));

    const onlyWebhook = await queryEvents(ctx, { uid: 'user_filter', source: 'webhook' });
    assert.ok(onlyWebhook.every((e) => e.source === 'webhook'));
  });

  it('returns events newest-first', async () => {
    const ctx = createContext({ uid: 'user_order', source: 'queue' });
    await emitAuditEvent(ctx, { kind: 'job.enqueued', uid: 'user_order', source: 'queue' });
    await new Promise((r) => setTimeout(r, 5));
    await emitAuditEvent(ctx, { kind: 'job.done', uid: 'user_order', source: 'queue' });

    const rows = await queryEvents(ctx, { uid: 'user_order' });
    assert.ok(rows.length >= 2);
    // newest first → done before enqueued
    assert.equal(rows[0]?.kind, 'job.done');
  });

  it('respects since/until bounds', async () => {
    const ctx = createContext({ uid: 'user_range', source: 'queue' });
    const before = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    await emitAuditEvent(ctx, { kind: 'job.enqueued', uid: 'user_range', source: 'queue' });
    await new Promise((r) => setTimeout(r, 5));
    const after = new Date().toISOString();

    const inWindow = await queryEvents(ctx, {
      uid: 'user_range',
      since: before,
      until: after,
    });
    assert.ok(inWindow.length >= 1);

    const beforeOnly = await queryEvents(ctx, {
      uid: 'user_range',
      until: before,
    });
    assert.equal(beforeOnly.length, 0);
  });

  it('recentEvents returns the latest N across all uids', async () => {
    const ctx = createContext({ uid: 'system', source: 'queue' });
    await emitAuditEvent(ctx, { kind: 'job.done', uid: 'user_recent', source: 'queue' });
    const rows = await recentEvents(ctx, 5);
    assert.ok(rows.length > 0);
    assert.ok(rows.length <= 5);
  });

  it('emit never throws even when the underlying write fails', async () => {
    const ctx = createContext({ uid: 'system', source: 'queue' });
    const original = ctx.db.collection;
    // Force the audit collection write to throw.
    (ctx.db as unknown as { collection: typeof original }).collection = ((name: string) => {
      if (name === 'audit_events') {
        return {
          doc: () => ({
            set: () => {
              throw new Error('boom');
            },
          }),
        } as unknown as ReturnType<typeof original>;
      }
      return original.call(ctx.db, name);
    }) as typeof original;

    try {
      // Should resolve to the (un-persisted) event without throwing.
      const ev = await emitAuditEvent(ctx, {
        kind: 'job.failed',
        uid: 'user_break',
        source: 'queue',
      });
      assert.equal(ev.kind, 'job.failed');
    } finally {
      (ctx.db as unknown as { collection: typeof original }).collection = original;
    }
  });
});
