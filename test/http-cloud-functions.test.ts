/**
 * Phase 6 — Cloud Functions / Express adapter test.
 *
 * Uses a tiny fake (req, res) pair so we don't pull Express into devDeps.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.COCKPIT_DRY_RUN = '1';
process.env.COCKPIT_LOG_LEVEL = 'error';
process.env.OPENCLAW_HOOKS_TOKEN = 'cf-token-cf-token-cf-token';

import { cloudFunctionsHandler } from '../src/http/cloud-functions-adapter.js';
import { inboundRegistry, registerInbound } from '../src/webhooks/inbound.js';

const TOKEN = 'cf-token-cf-token-cf-token';

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  ended: boolean;
  status(code: number): FakeRes;
  setHeader(name: string, value: string): void;
  send(body: string): void;
  end(): void;
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 0,
    headers: {},
    body: '',
    ended: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    send(body: string) {
      this.body = body;
      this.ended = true;
    },
    end() {
      this.ended = true;
    },
  };
  return res;
}

before(() => {
  inboundRegistry._resetForTesting();
  registerInbound({
    id: 'cf-test',
    description: 'cloud functions test',
    toJob(event) {
      return {
        uid: event.uid ?? 'system',
        intent: 'cap:noop',
        payload: { ...(event.body as Record<string, unknown>) },
      };
    },
  });
});

describe('cloudFunctionsHandler', () => {
  it('handles GET /healthz', async () => {
    const res = makeRes();
    await cloudFunctionsHandler(
      {
        method: 'GET',
        path: '/healthz',
        headers: {},
      },
      res,
    );
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { ok: boolean };
    assert.equal(body.ok, true);
  });

  it('threads body, headers, and query through correctly', async () => {
    const res = makeRes();
    await cloudFunctionsHandler(
      {
        method: 'GET',
        path: '/api/dashboard/recent',
        headers: { authorization: `Bearer ${TOKEN}` },
        query: { limit: '7' },
      },
      res,
    );
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { ok: boolean; events: unknown[] };
    assert.equal(body.ok, true);
    assert.ok(body.events.length <= 7);
  });

  it('handles inbound hook with already-parsed body', async () => {
    const res = makeRes();
    await cloudFunctionsHandler(
      {
        method: 'POST',
        path: '/hooks/cockpit-cf-test',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        body: { uid: 'user_cf', body: { hello: 'cf' } },
      },
      res,
    );
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { ok: boolean };
    assert.equal(body.ok, true);
  });

  it('falls back to URL parsing when path missing', async () => {
    const res = makeRes();
    await cloudFunctionsHandler(
      {
        method: 'GET',
        url: '/healthz?foo=bar',
        headers: {},
      },
      res,
    );
    assert.equal(res.statusCode, 200);
  });

  it('handles array-valued headers and query', async () => {
    const res = makeRes();
    await cloudFunctionsHandler(
      {
        method: 'GET',
        path: '/api/dashboard/recent',
        headers: { authorization: [`Bearer ${TOKEN}`] },
        query: { limit: ['5'] },
      },
      res,
    );
    assert.equal(res.statusCode, 200);
  });

  it('returns 404 for unknown paths', async () => {
    const res = makeRes();
    await cloudFunctionsHandler(
      {
        method: 'GET',
        path: '/nope',
        headers: {},
      },
      res,
    );
    assert.equal(res.statusCode, 404);
  });
});
