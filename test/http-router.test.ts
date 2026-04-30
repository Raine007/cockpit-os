/**
 * Phase 6 — HTTP router tests.
 *
 * Drives the pure router with synthetic requests; no sockets involved.
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.COCKPIT_DRY_RUN = '1';
process.env.COCKPIT_LOG_LEVEL = 'error';
process.env.OPENCLAW_HOOKS_TOKEN = 'test-token-test-token-1234';

import { routeRequest, listRoutes, _resetInboundRegistryForTesting } from '../src/http/router.js';
import { registerInbound } from '../src/webhooks/inbound.js';
import { bindIdentity } from '../src/identity/resolver.js';
import { createContext } from '../src/context/index.js';

const TOKEN = 'test-token-test-token-1234';
const auth = (h: Record<string, string | undefined> = {}) => ({
  authorization: `Bearer ${TOKEN}`,
  ...h,
});

before(() => {
  _resetInboundRegistryForTesting();
  registerInbound({
    id: 'router-test',
    description: 'router test mapping',
    toJob(event) {
      return {
        uid: event.uid ?? 'system',
        intent: 'cap:noop',
        payload: { ...(event.body as Record<string, unknown>) },
      };
    },
  });
});

describe('routeRequest — basics', () => {
  it('returns route table', () => {
    const routes = listRoutes();
    assert.ok(routes.some((r) => r.path === '/healthz'));
    assert.ok(routes.some((r) => r.path === '/hooks/cockpit-:mappingId'));
    assert.ok(routes.some((r) => r.path === '/api/dashboard/summary'));
  });

  it('GET /healthz returns 200 + ok', async () => {
    const res = await routeRequest({
      method: 'GET',
      path: '/healthz',
      headers: {},
    });
    assert.equal(res.status, 200);
    assert.equal((res.body as { ok: boolean }).ok, true);
  });

  it('returns 404 for unknown paths', async () => {
    const res = await routeRequest({
      method: 'GET',
      path: '/no-such-thing',
      headers: {},
    });
    assert.equal(res.status, 404);
  });

  it('returns 405 when method is wrong', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/healthz',
      headers: {},
    });
    assert.equal(res.status, 405);
  });
});

describe('routeRequest — inbound hooks', () => {
  it('rejects without bearer token', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/hooks/cockpit-router-test',
      headers: {},
      body: { body: { hello: 'world' } },
    });
    assert.equal(res.status, 401);
  });

  it('rejects with the wrong token', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/hooks/cockpit-router-test',
      headers: { authorization: 'Bearer wrong-token-wrong-token12' },
      body: { body: { hello: 'world' } },
    });
    assert.equal(res.status, 401);
  });

  it('dispatches a known mapping with valid token', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/hooks/cockpit-router-test',
      headers: auth(),
      body: { uid: 'user_router', body: { hello: 'world' } },
    });
    assert.equal(res.status, 200);
    const body = res.body as { ok: boolean; jobId?: string };
    assert.equal(body.ok, true);
    assert.ok(body.jobId);
  });

  it('rejects unknown mapping', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/hooks/cockpit-no-such-mapping',
      headers: auth(),
      body: { uid: 'user_router', body: {} },
    });
    assert.equal(res.status, 400);
    const body = res.body as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.match(body.error, /unknown mapping/);
  });

  it('rejects malformed hook path (extra slashes)', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/hooks/cockpit-foo/bar',
      headers: auth(),
      body: {},
    });
    assert.equal(res.status, 404);
  });
});

describe('routeRequest — computer callback', () => {
  it('rejects without bearer token', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/hooks/computer-done',
      headers: {},
      body: { jobId: 'x', taskId: 'y', status: 'done' },
    });
    assert.equal(res.status, 401);
  });

  it('returns 400 for unknown job with bearer token', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/hooks/computer-done',
      headers: auth(),
      body: { jobId: 'job_does_not_exist', taskId: 't1', status: 'done' },
    });
    assert.equal(res.status, 400);
    const body = res.body as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.match(body.error, /unknown job/);
  });
});

describe('routeRequest — dashboard endpoints', () => {
  it('GET /api/dashboard/summary requires auth', async () => {
    const res = await routeRequest({
      method: 'GET',
      path: '/api/dashboard/summary',
      headers: {},
    });
    assert.equal(res.status, 401);
  });

  it('GET /api/dashboard/summary returns counters with auth', async () => {
    const res = await routeRequest({
      method: 'GET',
      path: '/api/dashboard/summary',
      headers: auth(),
    });
    assert.equal(res.status, 200);
    const body = res.body as { ok: boolean; summary: { totalEvents: number } };
    assert.equal(body.ok, true);
    assert.equal(typeof body.summary.totalEvents, 'number');
  });

  it('GET /api/dashboard/jobs returns histogram', async () => {
    const res = await routeRequest({
      method: 'GET',
      path: '/api/dashboard/jobs',
      headers: auth(),
    });
    assert.equal(res.status, 200);
    const body = res.body as {
      ok: boolean;
      histogram: Record<string, number>;
    };
    assert.equal(body.ok, true);
    assert.ok('queued' in body.histogram);
    assert.ok('done' in body.histogram);
  });

  it('GET /api/dashboard/recent returns events', async () => {
    const res = await routeRequest({
      method: 'GET',
      path: '/api/dashboard/recent',
      headers: auth(),
      query: { limit: '5' },
    });
    assert.equal(res.status, 200);
    const body = res.body as { ok: boolean; events: unknown[] };
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.events));
  });

  it('GET /api/dashboard/identities requires uid', async () => {
    const res = await routeRequest({
      method: 'GET',
      path: '/api/dashboard/identities',
      headers: auth(),
    });
    assert.equal(res.status, 400);
  });

  it('GET /api/dashboard/identities returns list for a uid', async () => {
    const ctx = createContext({ uid: 'system', source: 'rpc' });
    await bindIdentity(ctx, {
      channel: 'imessage',
      handle: '+15550000',
      uid: 'user_dash_id',
    });
    const res = await routeRequest({
      method: 'GET',
      path: '/api/dashboard/identities',
      headers: auth(),
      query: { uid: 'user_dash_id' },
    });
    assert.equal(res.status, 200);
    const body = res.body as { ok: boolean; identities: unknown[] };
    assert.equal(body.ok, true);
    assert.ok(body.identities.length >= 1);
  });
});

describe('routeRequest — identity admin endpoints', () => {
  it('POST /api/identities binds an identity', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/identities',
      headers: auth(),
      body: {
        channel: 'telegram',
        handle: 'tg-router-1',
        uid: 'user_router_admin',
      },
    });
    assert.equal(res.status, 200);
    const body = res.body as { ok: boolean; identity: { uid: string } };
    assert.equal(body.ok, true);
    assert.equal(body.identity.uid, 'user_router_admin');
  });

  it('POST /api/identities rejects bad channel', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/identities',
      headers: auth(),
      body: { channel: 'pigeon', handle: 'x', uid: 'y' },
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/identities/revoke marks an identity revoked', async () => {
    // First bind, then revoke.
    await routeRequest({
      method: 'POST',
      path: '/api/identities',
      headers: auth(),
      body: { channel: 'discord', handle: 'd-revoke', uid: 'user_revoke' },
    });
    const res = await routeRequest({
      method: 'POST',
      path: '/api/identities/revoke',
      headers: auth(),
      body: { channel: 'discord', handle: 'd-revoke' },
    });
    assert.equal(res.status, 200);
    const body = res.body as { ok: boolean; identity: { revokedAt: string } };
    assert.equal(body.ok, true);
    assert.ok(body.identity.revokedAt);
  });

  it('admin endpoints require auth', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/identities',
      headers: {},
      body: { channel: 'imessage', handle: 'x', uid: 'y' },
    });
    assert.equal(res.status, 401);
  });
});

describe('routeRequest — root and static', () => {
  it('GET / returns dashboard HTML or JSON fallback', async () => {
    const res = await routeRequest({ method: 'GET', path: '/', headers: {} });
    assert.equal(res.status, 200);
    // In source/dev mode the UI loads from src/http/ui/index.html.
    // In a totally stripped install, we get the JSON fallback. Either is fine.
    const ct = res.headers?.['content-type'] ?? '';
    assert.ok(
      ct.includes('text/html') || ct.includes('application/json'),
      `unexpected content-type: ${ct}`,
    );
  });
});
