/**
 * Phase 6 — node:http adapter integration test.
 *
 * Boots a real server on an ephemeral port, makes real HTTP requests, and
 * verifies the round-trip. This is the only place in the test suite that
 * touches sockets — everything else uses the pure router.
 */

import { describe, it, after, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.COCKPIT_DRY_RUN = '1';
process.env.COCKPIT_LOG_LEVEL = 'error';
process.env.OPENCLAW_HOOKS_TOKEN = 'integration-token-integration-token';

import { startCockpitServer, type RunningServer } from '../src/http/node-adapter.js';
import {
  inboundRegistry,
  registerInbound,
} from '../src/webhooks/inbound.js';

let server: RunningServer;
let baseUrl: string;
const TOKEN = 'integration-token-integration-token';

before(async () => {
  inboundRegistry._resetForTesting();
  registerInbound({
    id: 'http-int',
    description: 'http integration test',
    toJob(event) {
      return {
        uid: event.uid ?? 'system',
        intent: 'cap:noop',
        payload: { ...(event.body as Record<string, unknown>) },
      };
    },
  });
  server = await startCockpitServer({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

after(async () => {
  await server.close();
});

describe('node:http adapter', () => {
  it('GET /healthz round-trips', async () => {
    const r = await fetch(`${baseUrl}/healthz`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as { ok: boolean };
    assert.equal(body.ok, true);
  });

  it('POST /hooks/cockpit-:id with auth + body works', async () => {
    const r = await fetch(`${baseUrl}/hooks/cockpit-http-int`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ uid: 'user_http', body: { hello: 'world' } }),
    });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { ok: boolean; jobId?: string };
    assert.equal(body.ok, true);
    assert.ok(body.jobId);
  });

  it('rejects oversized bodies', async () => {
    // 2 MB body, well above the 1 MB cap.
    const huge = 'x'.repeat(2_000_000);
    let status = 0;
    try {
      const r = await fetch(`${baseUrl}/hooks/cockpit-http-int`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ uid: 'u', body: { huge } }),
      });
      status = r.status;
    } catch {
      // Connection reset is also acceptable — adapter destroys the socket.
      status = -1;
    }
    assert.ok(status === -1 || status >= 400, `expected error, got ${status}`);
  });

  it('lower-cases header lookup (case-insensitive auth)', async () => {
    const r = await fetch(`${baseUrl}/api/dashboard/summary`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(r.status, 200);
  });

  it('parses query strings', async () => {
    const r = await fetch(
      `${baseUrl}/api/dashboard/recent?limit=3&uid=nonexistent_uid`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    assert.equal(r.status, 200);
    const body = (await r.json()) as { ok: boolean; events: unknown[] };
    assert.equal(body.ok, true);
    assert.ok(body.events.length <= 3);
  });
});
