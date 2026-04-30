/**
 * Tests for the /api/state/* endpoints.
 *
 * Covers: 401 without auth, 200 with auth, set→get round trip, delete.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.COCKPIT_DRY_RUN = '1';
process.env.COCKPIT_LOG_LEVEL = 'error';
process.env.OPENCLAW_HOOKS_TOKEN = 'test-token-test-token-1234';

import { routeRequest } from '../src/http/router.js';

const TOKEN = 'test-token-test-token-1234';
const auth = (h: Record<string, string | undefined> = {}) => ({
  authorization: `Bearer ${TOKEN}`,
  ...h,
});

describe('GET /api/state — all state', () => {
  it('returns 401 without auth', async () => {
    const res = await routeRequest({
      method: 'GET',
      path: '/api/state',
      headers: {},
    });
    assert.equal(res.status, 401);
    const body = res.body as { ok: boolean };
    assert.equal(body.ok, false);
  });

  it('returns 200 with auth and state object', async () => {
    const res = await routeRequest({
      method: 'GET',
      path: '/api/state',
      headers: auth(),
    });
    assert.equal(res.status, 200);
    const body = res.body as { ok: boolean; state: Record<string, unknown> };
    assert.equal(body.ok, true);
    assert.equal(typeof body.state, 'object');
  });
});

describe('GET /api/state/:key', () => {
  it('returns 401 without auth', async () => {
    const res = await routeRequest({
      method: 'GET',
      path: '/api/state/some-key',
      headers: {},
    });
    assert.equal(res.status, 401);
  });

  it('returns 200 with auth, value null for missing key', async () => {
    const res = await routeRequest({
      method: 'GET',
      path: '/api/state/nonexistent-key-xyz',
      headers: auth(),
    });
    assert.equal(res.status, 200);
    const body = res.body as { ok: boolean; key: string; value: unknown };
    assert.equal(body.ok, true);
    assert.equal(body.key, 'nonexistent-key-xyz');
    assert.equal(body.value, null);
  });
});

describe('PUT /api/state/:key', () => {
  it('returns 401 without auth', async () => {
    const res = await routeRequest({
      method: 'PUT',
      path: '/api/state/mykey',
      headers: {},
      body: { value: 42 },
    });
    assert.equal(res.status, 401);
  });

  it('returns 400 when value is missing from body', async () => {
    const res = await routeRequest({
      method: 'PUT',
      path: '/api/state/mykey',
      headers: auth(),
      body: {},
    });
    assert.equal(res.status, 400);
    const body = res.body as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.match(body.error, /value/);
  });

  it('returns 200 on successful write', async () => {
    const res = await routeRequest({
      method: 'PUT',
      path: '/api/state/test-put-key',
      headers: auth(),
      body: { value: { hello: 'world' } },
    });
    assert.equal(res.status, 200);
    const body = res.body as { ok: boolean };
    assert.equal(body.ok, true);
  });
});

describe('set → get round trip', () => {
  it('writes a value then reads it back', async () => {
    const key = `roundtrip-key-${Date.now()}`;
    const value = { foo: 'bar', count: 7 };

    // Write
    const putRes = await routeRequest({
      method: 'PUT',
      path: `/api/state/${key}`,
      headers: auth(),
      body: { value },
    });
    assert.equal(putRes.status, 200);

    // Read back
    const getRes = await routeRequest({
      method: 'GET',
      path: `/api/state/${key}`,
      headers: auth(),
    });
    assert.equal(getRes.status, 200);
    const body = getRes.body as { ok: boolean; key: string; value: unknown };
    assert.equal(body.ok, true);
    assert.equal(body.key, key);
    assert.deepEqual(body.value, value);

    // Also appears in getAllState
    const allRes = await routeRequest({
      method: 'GET',
      path: '/api/state',
      headers: auth(),
    });
    assert.equal(allRes.status, 200);
    const allBody = allRes.body as { ok: boolean; state: Record<string, unknown> };
    assert.equal(allBody.ok, true);
    assert.ok(key in allBody.state, 'key should appear in getAllState');
    assert.deepEqual(allBody.state[key], value);
  });
});

describe('DELETE /api/state/:key', () => {
  it('returns 401 without auth', async () => {
    const res = await routeRequest({
      method: 'DELETE',
      path: '/api/state/some-key',
      headers: {},
    });
    assert.equal(res.status, 401);
  });

  it('deletes a previously set key', async () => {
    const key = `delete-key-${Date.now()}`;

    // Set the key first
    await routeRequest({
      method: 'PUT',
      path: `/api/state/${key}`,
      headers: auth(),
      body: { value: 'to-be-deleted' },
    });

    // Delete it
    const delRes = await routeRequest({
      method: 'DELETE',
      path: `/api/state/${key}`,
      headers: auth(),
    });
    assert.equal(delRes.status, 200);
    const delBody = delRes.body as { ok: boolean };
    assert.equal(delBody.ok, true);

    // Should be gone
    const getRes = await routeRequest({
      method: 'GET',
      path: `/api/state/${key}`,
      headers: auth(),
    });
    assert.equal(getRes.status, 200);
    const getBody = getRes.body as { ok: boolean; value: unknown };
    assert.equal(getBody.value, null);
  });
});
