/**
 * Phase 5 — Observability dashboard tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.COCKPIT_DRY_RUN = '1';
process.env.COCKPIT_LOG_LEVEL = 'error';

import { emitAuditEvent } from '../src/audit/log.js';
import { createContext } from '../src/context/index.js';
import { submit } from '../src/dispatcher/engine.js';
import {
  dashboardSummary,
  jobStatusHistogram,
  recentForUid,
} from '../src/observability/dashboard.js';

describe('observability dashboard', () => {
  it('counts events by kind and source for a uid', async () => {
    const ctx = createContext({ uid: 'system', source: 'queue' });
    const uid = 'user_obs_summary';
    await emitAuditEvent(ctx, { kind: 'job.enqueued', uid, source: 'queue' });
    await emitAuditEvent(ctx, { kind: 'job.enqueued', uid, source: 'queue' });
    await emitAuditEvent(ctx, { kind: 'job.done', uid, source: 'queue' });
    await emitAuditEvent(ctx, {
      kind: 'webhook.inbound.received',
      uid,
      source: 'webhook',
    });

    const summary = await dashboardSummary(ctx, { uid });
    const enqueued = summary.byKind.find((k) => k.kind === 'job.enqueued');
    const done = summary.byKind.find((k) => k.kind === 'job.done');
    const queueSrc = summary.bySource.find((s) => s.source === 'queue');
    const webhookSrc = summary.bySource.find((s) => s.source === 'webhook');

    assert.equal(enqueued?.count, 2);
    assert.equal(done?.count, 1);
    assert.equal(queueSrc?.count, 3);
    assert.equal(webhookSrc?.count, 1);
    assert.ok(summary.totalEvents >= 4);
    assert.ok(summary.firstAt && summary.lastAt);
  });

  it('byKind is sorted by count descending', async () => {
    const ctx = createContext({ uid: 'system', source: 'queue' });
    const uid = 'user_obs_sort';
    for (let i = 0; i < 3; i += 1) {
      await emitAuditEvent(ctx, { kind: 'job.done', uid, source: 'queue' });
    }
    await emitAuditEvent(ctx, { kind: 'job.failed', uid, source: 'queue' });

    const summary = await dashboardSummary(ctx, { uid });
    // Highest count first.
    for (let i = 1; i < summary.byKind.length; i += 1) {
      const prev = summary.byKind[i - 1]!;
      const cur = summary.byKind[i]!;
      assert.ok(prev.count >= cur.count, 'byKind must be non-increasing');
    }
  });

  it('recentForUid returns most recent N events for a uid', async () => {
    const ctx = createContext({ uid: 'system', source: 'queue' });
    const uid = 'user_obs_recent';
    for (let i = 0; i < 5; i += 1) {
      await emitAuditEvent(ctx, {
        kind: 'job.enqueued',
        uid,
        source: 'queue',
        ref: `job_${i}`,
      });
      await new Promise((r) => setTimeout(r, 2));
    }
    const rows = await recentForUid(ctx, uid, 3);
    assert.equal(rows.length, 3);
    // newest first
    assert.equal(rows[0]?.ref, 'job_4');
  });

  it('jobStatusHistogram buckets jobs by current status', async () => {
    const ctx = createContext({ uid: 'system', source: 'queue' });
    const uid = 'user_obs_hist';
    // Submit some jobs without driving them — they remain 'queued'.
    await submit(
      { uid, intent: 'note', payload: { text: 'a' }, source: 'webhook' },
      { drive: false },
    );
    await submit(
      { uid, intent: 'note', payload: { text: 'b' }, source: 'webhook' },
      { drive: false },
    );

    const hist = await jobStatusHistogram(ctx, uid);
    assert.equal(hist.queued >= 2, true);
    assert.equal(typeof hist.done, 'number');
    assert.equal(typeof hist.failed, 'number');
    assert.equal(typeof hist.awaiting_input, 'number');
  });

  it('dashboardSummary respects since/until window', async () => {
    const ctx = createContext({ uid: 'system', source: 'queue' });
    const uid = 'user_obs_window';
    const before = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    await emitAuditEvent(ctx, { kind: 'job.done', uid, source: 'queue' });
    await new Promise((r) => setTimeout(r, 5));

    const empty = await dashboardSummary(ctx, { uid, until: before });
    assert.equal(empty.totalEvents, 0);
    assert.equal(empty.firstAt, null);
    assert.equal(empty.lastAt, null);

    const inWindow = await dashboardSummary(ctx, { uid });
    assert.ok(inWindow.totalEvents >= 1);
  });
});
