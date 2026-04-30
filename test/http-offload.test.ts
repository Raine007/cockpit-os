/**
 * Tests for POST /api/computer/offload.
 *
 * Covers: 401 without auth, valid request creates a job, malformed body → 400.
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

describe('POST /api/computer/offload', () => {
  it('returns 401 without auth', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/computer/offload',
      headers: {},
      body: { title: 'Test task', instructions: 'Do the thing' },
    });
    assert.equal(res.status, 401);
    const body = res.body as { ok: boolean };
    assert.equal(body.ok, false);
  });

  it('returns 400 when title is missing', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/computer/offload',
      headers: auth(),
      body: { instructions: 'Do the thing' },
    });
    assert.equal(res.status, 400);
    const body = res.body as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.match(body.error, /title/);
  });

  it('returns 400 when instructions is missing', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/computer/offload',
      headers: auth(),
      body: { title: 'My task' },
    });
    assert.equal(res.status, 400);
    const body = res.body as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.match(body.error, /instructions/);
  });

  it('returns 400 when body is empty', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/computer/offload',
      headers: auth(),
      body: {},
    });
    assert.equal(res.status, 400);
  });

  it('creates a job and returns jobId on valid request', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/computer/offload',
      headers: auth(),
      body: {
        title: 'Research quantum computing',
        instructions: 'Summarize the latest breakthroughs in quantum computing.',
      },
    });
    assert.equal(res.status, 200);
    const body = res.body as { ok: boolean; jobId: string };
    assert.equal(body.ok, true);
    assert.ok(body.jobId, 'should return a jobId');
    assert.match(body.jobId, /^offload_/, 'jobId should start with offload_');
  });

  it('creates a job with optional callbackKey', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/computer/offload',
      headers: auth(),
      body: {
        title: 'Do research',
        instructions: 'Look into something interesting.',
        callbackKey: 'research_result',
      },
    });
    assert.equal(res.status, 200);
    const body = res.body as { ok: boolean; jobId: string };
    assert.equal(body.ok, true);
    assert.ok(body.jobId);
  });

  it('created job appears in dashboard jobs histogram', async () => {
    // Enqueue a job first
    await routeRequest({
      method: 'POST',
      path: '/api/computer/offload',
      headers: auth(),
      body: {
        title: 'Histogram test',
        instructions: 'Check that this shows up in the histogram.',
      },
    });

    // Check histogram
    const res = await routeRequest({
      method: 'GET',
      path: '/api/dashboard/jobs',
      headers: auth(),
    });
    assert.equal(res.status, 200);
    const body = res.body as { ok: boolean; histogram: Record<string, number> };
    assert.equal(body.ok, true);
    // The offload job has status 'queued'
    assert.ok(body.histogram.queued >= 1, 'at least one job should be queued');
  });
});
