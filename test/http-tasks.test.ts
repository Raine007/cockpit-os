/**
 * Tests for the task HTTP endpoints (Phase 3 of Obsidian vault integration).
 *
 * Covers:
 *  - GET  /api/tasks                  (auth, filter done)
 *  - GET  /api/tasks/all              (auth, includes done)
 *  - POST /api/tasks                  (auth, validation, generates id + ts)
 *  - PATCH /api/tasks/:id             (auth, partial update, bumps updated_at)
 *  - POST /api/tasks/:id/done         (auth, sets completed_on)
 *  - POST /api/tasks/:id/feedback     (auth, validation, appends)
 *  - POST /api/tasks/:id/escalate     (auth, validation, appends + updates owner)
 *  - GET  /api/tasks/snapshot         (bridge read)
 *  - PUT  /api/tasks/snapshot         (bridge write, preserves timestamps on no-op)
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
/* Auth                                                                 */
/* ------------------------------------------------------------------ */

describe('GET /api/tasks — auth', () => {
  it('returns 401 without bearer token', async () => {
    const res = await routeRequest({
      method: 'GET',
      path: '/api/tasks',
      headers: { 'content-type': 'application/json' },
      body: null,
    });
    assert.equal(res.status, 401);
  });
});

/* ------------------------------------------------------------------ */
/* POST /api/tasks                                                      */
/* ------------------------------------------------------------------ */

describe('POST /api/tasks — create', () => {
  it('returns 400 without title', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/tasks',
      headers: auth(),
      body: { notes: 'no title' },
    });
    assert.equal(res.status, 400);
  });

  it('creates task with generated id and timestamp', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/tasks',
      headers: auth(),
      body: { title: 'New task', tags: ['flying'] },
    });
    assert.equal(res.status, 200);
    const body = (res.body as any);
    assert.equal(body.ok, true);
    assert.match(body.task.id, /^t_/);
    assert.equal(body.task.title, 'New task');
    assert.deepEqual(body.task.tags, ['flying']);
    assert.equal(body.task.owner, 'openclaw');
    assert.equal(body.task.done, false);
    assert.match(body.task.updated_at, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('respects provided owner if valid', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/tasks',
      headers: auth(),
      body: { title: 'X', owner: 'claude' },
    });
    const body = (res.body as any);
    assert.equal(body.task.owner, 'claude');
  });

  it('falls back to default owner if invalid', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/tasks',
      headers: auth(),
      body: { title: 'X', owner: 'bogus' },
    });
    const body = (res.body as any);
    assert.equal(body.task.owner, 'openclaw');
  });
});

/* ------------------------------------------------------------------ */
/* GET /api/tasks                                                       */
/* ------------------------------------------------------------------ */

describe('GET /api/tasks — list', () => {
  it('lists only active (not-done) tasks', async () => {
    // Create one open and mark another done
    const a = await routeRequest({
      method: 'POST', path: '/api/tasks', headers: auth(),
      body: { title: 'Open task' },
    });
    const aBody = (a.body as any);

    const b = await routeRequest({
      method: 'POST', path: '/api/tasks', headers: auth(),
      body: { title: 'To be done' },
    });
    const bBody = (b.body as any);

    await routeRequest({
      method: 'POST', path: `/api/tasks/${bBody.task.id}/done`, headers: auth(),
      body: {},
    });

    const list = await routeRequest({
      method: 'GET', path: '/api/tasks', headers: auth(), body: null,
    });
    assert.equal(list.status, 200);
    const lBody = (list.body as any);
    const ids = lBody.tasks.map((t: { id: string }) => t.id);
    assert.ok(ids.includes(aBody.task.id), 'open task present');
    assert.ok(!ids.includes(bBody.task.id), 'done task excluded');
  });
});

describe('GET /api/tasks/all — includes done', () => {
  it('returns all tasks including done', async () => {
    const res = await routeRequest({
      method: 'GET', path: '/api/tasks/all', headers: auth(), body: null,
    });
    assert.equal(res.status, 200);
    const body = (res.body as any);
    assert.ok(Array.isArray(body.tasks));
  });
});

/* ------------------------------------------------------------------ */
/* PATCH /api/tasks/:id                                                 */
/* ------------------------------------------------------------------ */

describe('PATCH /api/tasks/:id — update', () => {
  it('updates title and bumps updated_at', async () => {
    const c = await routeRequest({
      method: 'POST', path: '/api/tasks', headers: auth(),
      body: { title: 'Original' },
    });
    const created = (c.body as any).task;
    const initialTs = created.updated_at;

    // Wait 5ms so the new ISO timestamp differs
    await new Promise((r) => setTimeout(r, 5));

    const u = await routeRequest({
      method: 'PATCH', path: `/api/tasks/${created.id}`, headers: auth(),
      body: { title: 'Updated' },
    });
    assert.equal(u.status, 200);
    const updated = (u.body as any).task;
    assert.equal(updated.title, 'Updated');
    assert.notEqual(updated.updated_at, initialTs);
  });

  it('returns 400 for unknown task id', async () => {
    const res = await routeRequest({
      method: 'PATCH', path: '/api/tasks/t_doesntexist', headers: auth(),
      body: { title: 'x' },
    });
    assert.equal(res.status, 400);
  });

  it('rejects wrong method (GET) on /api/tasks/:id', async () => {
    const res = await routeRequest({
      method: 'GET', path: '/api/tasks/t_some', headers: auth(), body: null,
    });
    assert.equal(res.status, 405);
  });
});

/* ------------------------------------------------------------------ */
/* /done                                                                */
/* ------------------------------------------------------------------ */

describe('POST /api/tasks/:id/done', () => {
  it('marks task done and sets completed_on', async () => {
    const c = await routeRequest({
      method: 'POST', path: '/api/tasks', headers: auth(),
      body: { title: 'Finish me' },
    });
    const created = (c.body as any).task;

    const d = await routeRequest({
      method: 'POST', path: `/api/tasks/${created.id}/done`, headers: auth(), body: {},
    });
    assert.equal(d.status, 200);
    const done = (d.body as any).task;
    assert.equal(done.done, true);
    assert.match(done.completed_on, /^\d{4}-\d{2}-\d{2}$/);
  });
});

/* ------------------------------------------------------------------ */
/* /feedback                                                            */
/* ------------------------------------------------------------------ */

describe('POST /api/tasks/:id/feedback', () => {
  it('appends feedback entry', async () => {
    const c = await routeRequest({
      method: 'POST', path: '/api/tasks', headers: auth(),
      body: { title: 'FB target' },
    });
    const created = (c.body as any).task;

    const f = await routeRequest({
      method: 'POST', path: `/api/tasks/${created.id}/feedback`, headers: auth(),
      body: { author: 'raine', text: 'use the same blur radius' },
    });
    assert.equal(f.status, 200);
    const updated = (f.body as any).task;
    assert.equal(updated.feedback.length, 1);
    assert.equal(updated.feedback[0].author, 'raine');
    assert.equal(updated.feedback[0].text, 'use the same blur radius');
  });

  it('400 on missing author', async () => {
    const c = await routeRequest({
      method: 'POST', path: '/api/tasks', headers: auth(),
      body: { title: 'FB target 2' },
    });
    const created = (c.body as any).task;
    const r = await routeRequest({
      method: 'POST', path: `/api/tasks/${created.id}/feedback`, headers: auth(),
      body: { text: 'hi' },
    });
    assert.equal(r.status, 400);
  });

  it('400 on missing text', async () => {
    const c = await routeRequest({
      method: 'POST', path: '/api/tasks', headers: auth(),
      body: { title: 'FB target 3' },
    });
    const created = (c.body as any).task;
    const r = await routeRequest({
      method: 'POST', path: `/api/tasks/${created.id}/feedback`, headers: auth(),
      body: { author: 'raine' },
    });
    assert.equal(r.status, 400);
  });
});

/* ------------------------------------------------------------------ */
/* /escalate                                                            */
/* ------------------------------------------------------------------ */

describe('POST /api/tasks/:id/escalate', () => {
  it('appends escalation entry and changes owner', async () => {
    const c = await routeRequest({
      method: 'POST', path: '/api/tasks', headers: auth(),
      body: { title: 'Escalate me' },
    });
    const created = (c.body as any).task;
    assert.equal(created.owner, 'openclaw');

    const e = await routeRequest({
      method: 'POST', path: `/api/tasks/${created.id}/escalate`, headers: auth(),
      body: { to: 'claude', reason: 'too heavy' },
    });
    assert.equal(e.status, 200);
    const updated = (e.body as any).task;
    assert.equal(updated.owner, 'claude');
    assert.equal(updated.escalations.length, 1);
    assert.equal(updated.escalations[0].from, 'openclaw');
    assert.equal(updated.escalations[0].to, 'claude');
    assert.equal(updated.escalations[0].reason, 'too heavy');
  });

  it('400 on invalid owner', async () => {
    const c = await routeRequest({
      method: 'POST', path: '/api/tasks', headers: auth(),
      body: { title: 'X' },
    });
    const created = (c.body as any).task;
    const r = await routeRequest({
      method: 'POST', path: `/api/tasks/${created.id}/escalate`, headers: auth(),
      body: { to: 'bogus' },
    });
    assert.equal(r.status, 400);
  });

  it('multiple escalations preserve full chain', async () => {
    const c = await routeRequest({
      method: 'POST', path: '/api/tasks', headers: auth(),
      body: { title: 'Chain task' },
    });
    const created = (c.body as any).task;

    await routeRequest({
      method: 'POST', path: `/api/tasks/${created.id}/escalate`, headers: auth(),
      body: { to: 'claude', reason: 'first' },
    });
    const e2 = await routeRequest({
      method: 'POST', path: `/api/tasks/${created.id}/escalate`, headers: auth(),
      body: { to: 'perplexity', reason: 'second' },
    });
    const updated = (e2.body as any).task;
    assert.equal(updated.escalations.length, 2);
    assert.equal(updated.escalations[1].from, 'claude');
    assert.equal(updated.escalations[1].to, 'perplexity');
  });
});

/* ------------------------------------------------------------------ */
/* /snapshot                                                            */
/* ------------------------------------------------------------------ */

describe('GET/PUT /api/tasks/snapshot — bridge round-trip', () => {
  it('PUT replaces and GET reads back', async () => {
    const tasks = [
      {
        id: 't_aaa1',
        title: 'A',
        done: false,
        due: null,
        completed_on: null,
        priority: null,
        tags: [],
        owner: 'openclaw',
        updated_at: '2026-04-30T20:00:00Z',
        notes: '',
        feedback: [],
        escalations: [],
        artifacts: [],
      },
    ];
    const put = await routeRequest({
      method: 'PUT', path: '/api/tasks/snapshot', headers: auth(),
      body: { tasks },
    });
    assert.equal(put.status, 200);
    const putBody = (put.body as any);
    assert.equal(putBody.count, 1);

    const get = await routeRequest({
      method: 'GET', path: '/api/tasks/snapshot', headers: auth(), body: null,
    });
    assert.equal(get.status, 200);
    const getBody = (get.body as any);
    assert.ok(getBody.tasks.some((t: { id: string }) => t.id === 't_aaa1'));
  });

  it('PUT requires array of tasks', async () => {
    const r = await routeRequest({
      method: 'PUT', path: '/api/tasks/snapshot', headers: auth(),
      body: { not_tasks: [] },
    });
    assert.equal(r.status, 400);
  });
});
