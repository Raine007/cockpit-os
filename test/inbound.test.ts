/**
 * Inbound webhook: auth, validation, dedup, mapping → job.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.COCKPIT_DRY_RUN = '1';
process.env.COCKPIT_LOG_LEVEL = 'error';

import '../src/capabilities/index.js';
import {
  checkInboundAuth,
  handleInboundEvent,
  inboundRegistry,
  registerInbound,
} from '../src/webhooks/inbound.js';
import { createContext } from '../src/context/index.js';

function withToken<T>(token: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env.OPENCLAW_HOOKS_TOKEN;
  process.env.OPENCLAW_HOOKS_TOKEN = token;
  return Promise.resolve(fn()).finally(() => {
    if (prev === undefined) delete process.env.OPENCLAW_HOOKS_TOKEN;
    else process.env.OPENCLAW_HOOKS_TOKEN = prev;
  });
}

describe('checkInboundAuth', () => {
  it('rejects when no token configured', async () => {
    delete process.env.OPENCLAW_HOOKS_TOKEN;
    assert.equal(checkInboundAuth('Bearer anything'), false);
  });

  it('accepts the configured token (case-insensitive scheme)', async () => {
    await withToken('hunter2hunter2hunter2', () => {
      assert.equal(checkInboundAuth('Bearer hunter2hunter2hunter2'), true);
      assert.equal(checkInboundAuth('bearer hunter2hunter2hunter2'), true);
    });
  });

  it('rejects mismatched and missing tokens', async () => {
    await withToken('hunter2hunter2hunter2', () => {
      assert.equal(checkInboundAuth(undefined), false);
      assert.equal(checkInboundAuth('Bearer wrongwrongwrongwrong'), false);
      assert.equal(checkInboundAuth('hunter2hunter2hunter2'), false); // no scheme
    });
  });
});

describe('handleInboundEvent', () => {
  it('rejects unknown mapping with a clear error', async () => {
    inboundRegistry._resetForTesting();
    const ctx = createContext({ uid: 'system', source: 'webhook' });
    const r = await handleInboundEvent(ctx, {
      mappingId: 'no-such-thing',
      body: {},
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /unknown mapping/);
  });

  it('rejects malformed payloads', async () => {
    const ctx = createContext({ uid: 'system', source: 'webhook' });
    const r = await handleInboundEvent(ctx, { not: 'a valid event' });
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /invalid event/);
  });

  it('routes a registered mapping to a job (queue-only)', async () => {
    inboundRegistry._resetForTesting();
    registerInbound({
      id: 'task-due',
      description: 'fixture',
      toJob: (event) => ({
        uid: (event.uid ?? 'webhook-user') as string,
        intent: 'cap:task-create',
        payload: { title: `Reminder: ${(event.body.title as string) ?? '?'}` },
      }),
    });

    const ctx = createContext({ uid: 'system', source: 'webhook' });
    const r = await handleInboundEvent(ctx, {
      mappingId: 'task-due',
      uid: 'user-123',
      body: { title: 'pre-flight checklist' },
      eventId: 'evt-1',
    });
    assert.equal(r.ok, true);
    assert.ok(r.jobId, 'expected a jobId');
  });

  it('short-circuits replays via eventId', async () => {
    inboundRegistry._resetForTesting();
    registerInbound({
      id: 'noop',
      description: 'fixture',
      toJob: () => ({ uid: 'user-123', intent: 'cap:task-create', payload: { title: 'x' } }),
    });

    const ctx = createContext({ uid: 'system', source: 'webhook' });
    const first = await handleInboundEvent(ctx, {
      mappingId: 'noop',
      body: {},
      eventId: 'evt-replay',
    });
    const second = await handleInboundEvent(ctx, {
      mappingId: 'noop',
      body: {},
      eventId: 'evt-replay',
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.jobId, first.jobId);
  });

  it('honors mappings that drop the event (return null)', async () => {
    inboundRegistry._resetForTesting();
    registerInbound({
      id: 'filter',
      description: 'fixture',
      toJob: () => null,
    });

    const ctx = createContext({ uid: 'system', source: 'webhook' });
    const r = await handleInboundEvent(ctx, { mappingId: 'filter', body: {} });
    assert.equal(r.ok, true);
    assert.equal(r.jobId, undefined);
  });
});
