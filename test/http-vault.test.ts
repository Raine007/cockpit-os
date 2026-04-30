/**
 * Tests for the vault HTTP endpoints (Phase 2 of Obsidian vault integration).
 *
 * Covers:
 *  - POST /api/vault/jobs                    (auth, validation, happy path)
 *  - GET  /api/vault/jobs/pending            (auth, queued filter, heartbeat)
 *  - POST /api/vault/jobs/:id/result         (auth, dynamic route, status update)
 *  - GET  /api/vault/status                  (auth, default + populated)
 *  - POST /api/vault/status                  (auth, validation, heartbeat from bridge)
 *  - Full round-trip: enqueue \u2192 poll \u2192 result \u2192 status reflects write counter
 *  - Dry-run results do NOT bump writes_today
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.COCKPIT_DRY_RUN = '1';
process.env.COCKPIT_LOG_LEVEL = 'error';
process.env.OPENCLAW_HOOKS_TOKEN = 'test-token-test-token-1234';
process.env.COCKPIT_RATELIMIT_DISABLED = '1';

import { routeRequest, _resetRateLimitersForTesting } from '../src/http/router.js';

beforeEach(() => _resetRateLimitersForTesting());

const TOKEN = 'test-token-test-token-1234';
const auth = (extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${TOKEN}`,
  'content-type': 'application/json',
  ...extra,
});

/* ------------------------------------------------------------------ */
/* POST /api/vault/jobs                                                 */
/* ------------------------------------------------------------------ */

describe('POST /api/vault/jobs — auth', () => {
  it('returns 401 without bearer token', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/vault/jobs',
      headers: { 'content-type': 'application/json' },
      body: { kind: 'append', payload: { path: 'Daily Notes/x.md', text: 'hi' } },
    });
    assert.equal(res.status, 401);
  });
});

describe('POST /api/vault/jobs — validation', () => {
  it('returns 400 for invalid kind', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/vault/jobs',
      headers: auth(),
      body: { kind: 'delete', payload: { path: 'x' } },
    });
    assert.equal(res.status, 400);
    assert.match((res.body as { error: string }).error, /kind/);
  });

  it('returns 400 when payload is missing', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/vault/jobs',
      headers: auth(),
      body: { kind: 'append' },
    });
    assert.equal(res.status, 400);
    assert.match((res.body as { error: string }).error, /payload/);
  });

  it('returns 400 when append payload is missing path', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/vault/jobs',
      headers: auth(),
      body: { kind: 'append', payload: { text: 'hello' } },
    });
    assert.equal(res.status, 400);
    assert.match((res.body as { error: string }).error, /path/);
  });

  it('returns 400 when daily-note payload is missing text', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/vault/jobs',
      headers: auth(),
      body: { kind: 'daily-note', payload: {} },
    });
    assert.equal(res.status, 400);
    assert.match((res.body as { error: string }).error, /text/);
  });
});

describe('POST /api/vault/jobs — happy path', () => {
  it('enqueues an append job and returns job_id', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/vault/jobs',
      headers: auth(),
      body: {
        kind: 'append',
        payload: { path: 'Daily Notes/2026-04-30.md', text: 'phase 2 test' },
      },
    });
    assert.equal(res.status, 200);
    const body = res.body as { ok: boolean; job_id: string };
    assert.equal(body.ok, true);
    assert.ok(typeof body.job_id === 'string' && body.job_id.startsWith('vjob_'));
  });

  it('enqueues a daily-note job', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/vault/jobs',
      headers: auth(),
      body: {
        kind: 'daily-note',
        payload: { text: 'Captured from chat', source: 'chat' },
      },
    });
    assert.equal(res.status, 200);
    assert.equal((res.body as { ok: boolean }).ok, true);
  });
});

/* ------------------------------------------------------------------ */
/* GET /api/vault/jobs/pending                                         */
/* ------------------------------------------------------------------ */

describe('GET /api/vault/jobs/pending — auth', () => {
  it('returns 401 without token', async () => {
    const res = await routeRequest({
      method: 'GET',
      path: '/api/vault/jobs/pending',
      headers: {},
    });
    assert.equal(res.status, 401);
  });
});

describe('GET /api/vault/jobs/pending — happy path', () => {
  it('returns only queued jobs and heartbeats status', async () => {
    // Enqueue one
    const postRes = await routeRequest({
      method: 'POST',
      path: '/api/vault/jobs',
      headers: auth(),
      body: {
        kind: 'append',
        payload: { path: 'Daily Notes/poll-test.md', text: 'poll test' },
      },
    });
    const { job_id } = postRes.body as { job_id: string };

    // Poll
    const pollRes = await routeRequest({
      method: 'GET',
      path: '/api/vault/jobs/pending',
      headers: auth(),
    });
    assert.equal(pollRes.status, 200);
    const pollBody = pollRes.body as { ok: boolean; jobs: { id: string; status: string }[] };
    assert.equal(pollBody.ok, true);
    assert.ok(Array.isArray(pollBody.jobs));
    const found = pollBody.jobs.find((j) => j.id === job_id);
    assert.ok(found, 'enqueued job should appear in pending list');
    assert.equal(found!.status, 'queued');
    for (const j of pollBody.jobs) assert.equal(j.status, 'queued');

    // Heartbeat: polling should populate vault_status.last_seen
    const statusRes = await routeRequest({
      method: 'GET',
      path: '/api/vault/status',
      headers: auth(),
    });
    const statusBody = statusRes.body as {
      ok: boolean;
      status: { last_seen?: string };
    };
    assert.ok(typeof statusBody.status.last_seen === 'string');
  });
});

/* ------------------------------------------------------------------ */
/* POST /api/vault/jobs/:id/result                                     */
/* ------------------------------------------------------------------ */

describe('POST /api/vault/jobs/:id/result — auth', () => {
  it('returns 401 without token', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/vault/jobs/vjob_xxx/result',
      headers: {},
      body: { ok: true },
    });
    assert.equal(res.status, 401);
  });
});

describe('POST /api/vault/jobs/:id/result — validation', () => {
  it('returns 400 when ok flag missing', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/vault/jobs/vjob_xxx/result',
      headers: auth(),
      body: { result: 'something' },
    });
    assert.equal(res.status, 400);
    assert.match((res.body as { error: string }).error, /ok/);
  });

  it('returns 400 when job id not found', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/vault/jobs/vjob_does_not_exist_xxx/result',
      headers: auth(),
      body: { ok: true, result: { written: false } },
    });
    assert.equal(res.status, 400);
    assert.match((res.body as { error: string }).error, /not found/);
  });
});

describe('POST /api/vault/jobs/:id/result — happy path', () => {
  it('completes a job and bumps writes_today for real append', async () => {
    // Enqueue
    const postRes = await routeRequest({
      method: 'POST',
      path: '/api/vault/jobs',
      headers: auth(),
      body: {
        kind: 'append',
        payload: { path: 'Daily Notes/result-test.md', text: 'r' },
      },
    });
    const { job_id } = postRes.body as { job_id: string };

    // Read writes_today before
    const beforeRes = await routeRequest({
      method: 'GET',
      path: '/api/vault/status',
      headers: auth(),
    });
    const before = (beforeRes.body as { status: { writes_today?: number } }).status
      .writes_today ?? 0;

    // Bridge posts a successful, real (non-dry-run) result
    const resultRes = await routeRequest({
      method: 'POST',
      path: `/api/vault/jobs/${job_id}/result`,
      headers: auth(),
      body: {
        ok: true,
        result: { written: true, bytes: 1, path: '/mnt/f/Vault/Daily Notes/result-test.md' },
        dry_run: false,
      },
    });
    assert.equal(resultRes.status, 200);
    assert.equal((resultRes.body as { ok: boolean }).ok, true);

    // Status should reflect last_write + writes_today incremented
    const afterRes = await routeRequest({
      method: 'GET',
      path: '/api/vault/status',
      headers: auth(),
    });
    const afterStatus = (afterRes.body as {
      status: { last_write?: string; writes_today?: number };
    }).status;
    assert.ok(typeof afterStatus.last_write === 'string', 'last_write should be set');
    assert.ok(
      (afterStatus.writes_today ?? 0) >= before + 1,
      `writes_today should increment by at least 1 (was ${before}, is ${afterStatus.writes_today})`,
    );

    // The job should no longer be in the queued list
    const pollRes = await routeRequest({
      method: 'GET',
      path: '/api/vault/jobs/pending',
      headers: auth(),
    });
    const stillQueued = (pollRes.body as { jobs: { id: string }[] }).jobs.find(
      (j) => j.id === job_id,
    );
    assert.ok(!stillQueued, 'completed job should not appear in queued list');
  });

  it('does NOT bump writes_today when dry_run=true', async () => {
    // Enqueue
    const postRes = await routeRequest({
      method: 'POST',
      path: '/api/vault/jobs',
      headers: auth(),
      body: {
        kind: 'append',
        payload: { path: 'Daily Notes/dry-test.md', text: 'd' },
      },
    });
    const { job_id } = postRes.body as { job_id: string };

    const beforeRes = await routeRequest({
      method: 'GET',
      path: '/api/vault/status',
      headers: auth(),
    });
    const before = (beforeRes.body as { status: { writes_today?: number } }).status
      .writes_today ?? 0;

    await routeRequest({
      method: 'POST',
      path: `/api/vault/jobs/${job_id}/result`,
      headers: auth(),
      body: { ok: true, result: { written: false }, dry_run: true },
    });

    const afterRes = await routeRequest({
      method: 'GET',
      path: '/api/vault/status',
      headers: auth(),
    });
    const after = (afterRes.body as { status: { writes_today?: number } }).status
      .writes_today ?? 0;
    assert.equal(after, before, 'dry-run results must not bump writes_today');
  });

  it('records last_error on failure', async () => {
    const postRes = await routeRequest({
      method: 'POST',
      path: '/api/vault/jobs',
      headers: auth(),
      body: { kind: 'read', payload: { path: 'Daily Notes/missing.md' } },
    });
    const { job_id } = postRes.body as { job_id: string };

    await routeRequest({
      method: 'POST',
      path: `/api/vault/jobs/${job_id}/result`,
      headers: auth(),
      body: { ok: false, error: 'ENOENT: file not found' },
    });

    const statusRes = await routeRequest({
      method: 'GET',
      path: '/api/vault/status',
      headers: auth(),
    });
    const status = (statusRes.body as { status: { last_error?: string } }).status;
    assert.match(status.last_error ?? '', /ENOENT/);
  });
});

/* ------------------------------------------------------------------ */
/* GET /api/vault/status                                               */
/* ------------------------------------------------------------------ */

describe('GET /api/vault/status — auth', () => {
  it('returns 401 without token', async () => {
    const res = await routeRequest({
      method: 'GET',
      path: '/api/vault/status',
      headers: {},
    });
    assert.equal(res.status, 401);
  });

  it('returns a status shape with required fields', async () => {
    const res = await routeRequest({
      method: 'GET',
      path: '/api/vault/status',
      headers: auth(),
    });
    assert.equal(res.status, 200);
    const body = res.body as {
      ok: boolean;
      status: { enabled: boolean; dry_run: boolean };
    };
    assert.equal(body.ok, true);
    assert.equal(typeof body.status.enabled, 'boolean');
    assert.equal(typeof body.status.dry_run, 'boolean');
  });
});

/* ------------------------------------------------------------------ */
/* POST /api/vault/status (bridge heartbeat)                           */
/* ------------------------------------------------------------------ */

describe('POST /api/vault/status — auth', () => {
  it('returns 401 without token', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/vault/status',
      headers: {},
      body: { enabled: true, dry_run: false },
    });
    assert.equal(res.status, 401);
  });
});

describe('POST /api/vault/status — validation', () => {
  it('returns 400 when enabled missing', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/vault/status',
      headers: auth(),
      body: { dry_run: false },
    });
    assert.equal(res.status, 400);
    assert.match((res.body as { error: string }).error, /enabled/);
  });

  it('returns 400 when dry_run missing', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/vault/status',
      headers: auth(),
      body: { enabled: true },
    });
    assert.equal(res.status, 400);
    assert.match((res.body as { error: string }).error, /dry_run/);
  });
});

describe('POST /api/vault/status — happy path', () => {
  it('persists bridge diagnostic and returns updated status', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/vault/status',
      headers: auth(),
      body: { enabled: true, dry_run: false, vault_root: '/mnt/f/Vault' },
    });
    assert.equal(res.status, 200);
    const body = res.body as {
      ok: boolean;
      status: { enabled: boolean; dry_run: boolean; vault_root?: string; last_seen?: string };
    };
    assert.equal(body.ok, true);
    assert.equal(body.status.enabled, true);
    assert.equal(body.status.dry_run, false);
    assert.equal(body.status.vault_root, '/mnt/f/Vault');
    assert.ok(typeof body.status.last_seen === 'string');

    // Subsequent GET returns same values
    const getRes = await routeRequest({
      method: 'GET',
      path: '/api/vault/status',
      headers: auth(),
    });
    const got = (getRes.body as { status: { vault_root?: string } }).status;
    assert.equal(got.vault_root, '/mnt/f/Vault');
  });
});
