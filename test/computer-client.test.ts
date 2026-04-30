/**
 * Phase 4 — Computer dispatch HTTP client.
 *
 * Tests use a fake `fetch` so we can assert the wire format (URL, headers,
 * body shape) without standing up a real server.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.COCKPIT_LOG_LEVEL = 'error';

import { createNodeFetchComputerClient } from '../src/computer/index.js';
import type { ComputerTaskRequest } from '../src/computer/index.js';

function fakeFetch(
  responses: Array<{ status: number; body: string }>,
): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let i = 0;
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[i++] ?? { status: 500, body: '' };
    return new Response(r.body, { status: r.status });
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

const baseRequest: ComputerTaskRequest = {
  taskId: 'tk_42',
  jobId: 'job_42',
  uid: 'u1',
  intent: 'flight-anomaly-report',
  payload: { window: '7d' },
  capabilities: ['flight-log'],
  callbackUrl: 'http://gw.test/hooks/computer-done',
};

describe('createNodeFetchComputerClient', () => {
  it('POSTs JSON with bearer auth and parses a 200', async () => {
    const { fetch: f, calls } = fakeFetch([
      { status: 200, body: JSON.stringify({ ok: true, taskId: 'remote-1' }) },
    ]);
    const client = createNodeFetchComputerClient({
      endpoint: 'http://computer.test/dispatch',
      token: 'secret-token',
      fetchImpl: f,
    });
    const r = await client.submit(baseRequest);
    assert.equal(r.ok, true);
    assert.equal(r.taskId, 'remote-1');
    const call = calls[0];
    assert.ok(call);
    assert.equal(call.url, 'http://computer.test/dispatch');
    const headers = (call.init?.headers ?? {}) as Record<string, string>;
    assert.equal(headers['content-type'], 'application/json');
    assert.equal(headers['authorization'], 'Bearer secret-token');
    const sent = JSON.parse(String(call.init?.body));
    assert.equal(sent.jobId, 'job_42');
    assert.equal(sent.callbackUrl, 'http://gw.test/hooks/computer-done');
    assert.deepEqual(sent.capabilities, ['flight-log']);
  });

  it('omits authorization header when no token is configured', async () => {
    const { fetch: f, calls } = fakeFetch([
      { status: 200, body: JSON.stringify({ ok: true }) },
    ]);
    const client = createNodeFetchComputerClient({
      endpoint: 'http://computer.test/dispatch',
      token: '',
      fetchImpl: f,
    });
    await client.submit(baseRequest);
    const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
    assert.equal(headers['authorization'], undefined);
  });

  it('marks 4xx responses fatal', async () => {
    const { fetch: f } = fakeFetch([{ status: 401, body: 'no auth' }]);
    const client = createNodeFetchComputerClient({
      endpoint: 'http://computer.test/dispatch',
      token: 't',
      fetchImpl: f,
    });
    const r = await client.submit(baseRequest);
    assert.equal(r.ok, false);
    assert.equal(r.fatal, true);
    assert.match(r.error ?? '', /401/);
  });

  it('marks 5xx responses non-fatal', async () => {
    const { fetch: f } = fakeFetch([{ status: 503, body: 'busy' }]);
    const client = createNodeFetchComputerClient({
      endpoint: 'http://computer.test/dispatch',
      token: 't',
      fetchImpl: f,
    });
    const r = await client.submit(baseRequest);
    assert.equal(r.ok, false);
    assert.notEqual(r.fatal, true);
  });

  it('reports a clear error on malformed 2xx response bodies', async () => {
    const { fetch: f } = fakeFetch([{ status: 200, body: 'not-json' }]);
    const client = createNodeFetchComputerClient({
      endpoint: 'http://computer.test/dispatch',
      token: 't',
      fetchImpl: f,
    });
    const r = await client.submit(baseRequest);
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /malformed/);
  });
});
