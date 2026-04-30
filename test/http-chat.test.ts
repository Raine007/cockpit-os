/**
 * Tests for chat + feedback HTTP endpoints.
 *
 * Covers:
 *  - POST /api/chat/message   (auth, happy path, validation)
 *  - GET  /api/chat/messages  (auth, since filter)
 *  - GET  /api/chat/pending   (auth, status filter)
 *  - POST /api/chat/reply     (auth, happy path, validation)
 *  - POST /api/chat/escalate  (auth, escalation flow)
 *  - POST /api/feedback/ask   (auth, happy path)
 *  - POST /api/feedback/answer (auth, re-queue flow)
 *  - GET  /api/feedback/pending (auth, filter)
 *  - Full round-trip: chat append + retrieval
 *  - Full round-trip: escalation flow
 *  - Full round-trip: feedback ask / answer cycle
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.COCKPIT_DRY_RUN = '1';
process.env.COCKPIT_LOG_LEVEL = 'error';
process.env.OPENCLAW_HOOKS_TOKEN = 'test-token-test-token-1234';
// Disable rate limiting so high-volume tests don't get throttled.
process.env.COCKPIT_RATELIMIT_DISABLED = '1';

import { routeRequest, _resetRateLimitersForTesting } from '../src/http/router.js';

// Reset rate limiters before each test so previous test runs don't exhaust the bucket.
// beforeEach at file scope applies to every it() in this file in Node's test runner.
beforeEach(() => _resetRateLimitersForTesting());

const TOKEN = 'test-token-test-token-1234';
const auth = (extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${TOKEN}`,
  'content-type': 'application/json',
  ...extra,
});

/* ------------------------------------------------------------------ */
/* POST /api/chat/message                                               */
/* ------------------------------------------------------------------ */

describe('POST /api/chat/message — auth', () => {
  it('returns 401 without bearer token', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/chat/message',
      headers: { 'content-type': 'application/json' },
      body: { text: 'hello', role: 'user' },
    });
    assert.equal(res.status, 401);
    assert.equal((res.body as { ok: boolean }).ok, false);
  });

  it('returns 401 with wrong token', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/chat/message',
      headers: { authorization: 'Bearer wrong-token-000000000000' },
      body: { text: 'hello', role: 'user' },
    });
    assert.equal(res.status, 401);
  });
});

describe('POST /api/chat/message — validation', () => {
  it('returns 400 when text is missing', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/chat/message',
      headers: auth(),
      body: { role: 'user' },
    });
    assert.equal(res.status, 400);
    const body = res.body as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.match(body.error, /text/);
  });

  it('returns 400 when role is not "user"', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/chat/message',
      headers: auth(),
      body: { text: 'hi', role: 'assistant' },
    });
    assert.equal(res.status, 400);
    const body = res.body as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.match(body.error, /user/);
  });
});

describe('POST /api/chat/message — happy path', () => {
  it('appends message and returns message_id + job_id', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/chat/message',
      headers: auth(),
      body: { text: 'What should I post next?', role: 'user' },
    });
    assert.equal(res.status, 200);
    const body = res.body as { ok: boolean; message_id: string; job_id: string };
    assert.equal(body.ok, true);
    assert.ok(typeof body.message_id === 'string' && body.message_id.length > 0);
    assert.ok(typeof body.job_id === 'string' && body.job_id.length > 0);
  });
});

/* ------------------------------------------------------------------ */
/* GET /api/chat/messages                                              */
/* ------------------------------------------------------------------ */

describe('GET /api/chat/messages — auth', () => {
  it('returns 401 without token', async () => {
    const res = await routeRequest({
      method: 'GET',
      path: '/api/chat/messages',
      headers: {},
    });
    assert.equal(res.status, 401);
  });
});

describe('GET /api/chat/messages — happy path', () => {
  it('returns messages array after posting', async () => {
    // Post a message first
    await routeRequest({
      method: 'POST',
      path: '/api/chat/message',
      headers: auth(),
      body: { text: 'Get-messages test', role: 'user' },
    });

    const res = await routeRequest({
      method: 'GET',
      path: '/api/chat/messages',
      headers: auth(),
    });
    assert.equal(res.status, 200);
    const body = res.body as { ok: boolean; messages: unknown[] };
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.messages));
    assert.ok(body.messages.length >= 1);
  });

  it('since filter returns only newer messages', async () => {
    // Post to ensure there's at least one message
    await routeRequest({
      method: 'POST',
      path: '/api/chat/message',
      headers: auth(),
      body: { text: 'Before-since message', role: 'user' },
    });

    // Use a far-future timestamp so no messages are returned
    const futureSince = new Date(Date.now() + 60_000).toISOString();
    const res = await routeRequest({
      method: 'GET',
      path: '/api/chat/messages',
      headers: auth(),
      query: { since: futureSince },
    });
    assert.equal(res.status, 200);
    const body = res.body as { ok: boolean; messages: unknown[] };
    assert.equal(body.ok, true);
    assert.equal(body.messages.length, 0);
  });
});

/* ------------------------------------------------------------------ */
/* GET /api/chat/pending                                               */
/* ------------------------------------------------------------------ */

describe('GET /api/chat/pending — auth', () => {
  it('returns 401 without token', async () => {
    const res = await routeRequest({
      method: 'GET',
      path: '/api/chat/pending',
      headers: {},
    });
    assert.equal(res.status, 401);
  });
});

describe('GET /api/chat/pending — happy path', () => {
  it('returns jobs array with status filter', async () => {
    // Post a message to create a queued job
    await routeRequest({
      method: 'POST',
      path: '/api/chat/message',
      headers: auth(),
      body: { text: 'Pending poll test', role: 'user' },
    });

    const res = await routeRequest({
      method: 'GET',
      path: '/api/chat/pending',
      headers: auth(),
      query: { status: 'queued' },
    });
    assert.equal(res.status, 200);
    const body = res.body as { ok: boolean; jobs: { status: string }[] };
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.jobs));
    // All returned jobs must have status=queued
    for (const job of body.jobs) {
      assert.equal(job.status, 'queued');
    }
  });

  it('defaults to queued status when no query param given', async () => {
    const res = await routeRequest({
      method: 'GET',
      path: '/api/chat/pending',
      headers: auth(),
    });
    assert.equal(res.status, 200);
    const body = res.body as { ok: boolean; jobs: { status: string }[] };
    assert.equal(body.ok, true);
    for (const job of body.jobs) {
      assert.equal(job.status, 'queued');
    }
  });
});

/* ------------------------------------------------------------------ */
/* POST /api/chat/reply                                                */
/* ------------------------------------------------------------------ */

describe('POST /api/chat/reply — auth', () => {
  it('returns 401 without token', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/chat/reply',
      headers: {},
      body: { message_id: 'x', reply_text: 'hi', role: 'assistant' },
    });
    assert.equal(res.status, 401);
  });
});

describe('POST /api/chat/reply — validation', () => {
  it('returns 400 when message_id missing', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/chat/reply',
      headers: auth(),
      body: { reply_text: 'hi', role: 'assistant' },
    });
    assert.equal(res.status, 400);
    assert.match((res.body as { error: string }).error, /message_id/);
  });

  it('returns 400 when reply_text missing', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/chat/reply',
      headers: auth(),
      body: { message_id: 'msg_1', role: 'assistant' },
    });
    assert.equal(res.status, 400);
    assert.match((res.body as { error: string }).error, /reply_text/);
  });

  it('returns 400 for invalid role', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/chat/reply',
      headers: auth(),
      body: { message_id: 'msg_1', reply_text: 'hi', role: 'user' },
    });
    assert.equal(res.status, 400);
    assert.match((res.body as { error: string }).error, /assistant.*computer|computer.*assistant/i);
  });
});

describe('POST /api/chat/reply — happy path', () => {
  it('appends reply with role=assistant and returns reply_id', async () => {
    // First post a message to get a message_id
    const postRes = await routeRequest({
      method: 'POST',
      path: '/api/chat/message',
      headers: auth(),
      body: { text: 'Reply test message', role: 'user' },
    });
    const { message_id } = postRes.body as { message_id: string };

    const replyRes = await routeRequest({
      method: 'POST',
      path: '/api/chat/reply',
      headers: auth(),
      body: { message_id, reply_text: 'Here is my answer', role: 'assistant' },
    });
    assert.equal(replyRes.status, 200);
    const body = replyRes.body as { ok: boolean; reply_id: string };
    assert.equal(body.ok, true);
    assert.ok(typeof body.reply_id === 'string' && body.reply_id.length > 0);
  });

  it('appends reply with role=computer', async () => {
    const postRes = await routeRequest({
      method: 'POST',
      path: '/api/chat/message',
      headers: auth(),
      body: { text: 'Computer reply test', role: 'user' },
    });
    const { message_id } = postRes.body as { message_id: string };

    const replyRes = await routeRequest({
      method: 'POST',
      path: '/api/chat/reply',
      headers: auth(),
      body: {
        message_id,
        reply_text: 'Video editing task complete',
        role: 'computer',
        task_created: { todoist_id: 'td_123', project: '6gVQ8Hq54XHQ7FcW' },
      },
    });
    assert.equal(replyRes.status, 200);
    assert.equal((replyRes.body as { ok: boolean }).ok, true);
  });
});

/* ------------------------------------------------------------------ */
/* POST /api/chat/escalate                                             */
/* ------------------------------------------------------------------ */

describe('POST /api/chat/escalate — auth', () => {
  it('returns 401 without token', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/chat/escalate',
      headers: {},
      body: { message_id: 'x', reason: 'test' },
    });
    assert.equal(res.status, 401);
  });
});

describe('POST /api/chat/escalate — validation', () => {
  it('returns 400 when message_id missing', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/chat/escalate',
      headers: auth(),
      body: { reason: 'video editing needed' },
    });
    assert.equal(res.status, 400);
    assert.match((res.body as { error: string }).error, /message_id/);
  });

  it('returns 400 when no pending_job found for message_id', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/chat/escalate',
      headers: auth(),
      body: { message_id: 'nonexistent_msg_xyz', reason: 'video editing' },
    });
    assert.equal(res.status, 400);
    assert.match((res.body as { error: string }).error, /pending_job/);
  });
});

describe('POST /api/chat/escalate — happy path (escalation flow)', () => {
  it('escalates a real queued job and creates a feedback_request', async () => {
    // Create a message (and thus a pending_job)
    const postRes = await routeRequest({
      method: 'POST',
      path: '/api/chat/message',
      headers: auth(),
      body: { text: 'Edit my reel please', role: 'user' },
    });
    assert.equal(postRes.status, 200);
    const { message_id } = postRes.body as { message_id: string };

    // Escalate
    const escalRes = await routeRequest({
      method: 'POST',
      path: '/api/chat/escalate',
      headers: auth(),
      body: {
        message_id,
        reason: 'video editing required',
        task_payload: { dropbox_link: 'https://dropbox.com/test' },
      },
    });
    assert.equal(escalRes.status, 200);
    const escalBody = escalRes.body as { ok: boolean; feedback_id: string };
    assert.equal(escalBody.ok, true);
    assert.ok(typeof escalBody.feedback_id === 'string' && escalBody.feedback_id.length > 0);

    // Confirm job is now escalated_to_computer
    const pendRes = await routeRequest({
      method: 'GET',
      path: '/api/chat/pending',
      headers: auth(),
      query: { status: 'escalated_to_computer' },
    });
    assert.equal(pendRes.status, 200);
    const pendBody = pendRes.body as { ok: boolean; jobs: { message_id: string; status: string }[] };
    assert.equal(pendBody.ok, true);
    const escalJob = pendBody.jobs.find((j) => j.message_id === message_id);
    assert.ok(escalJob, 'escalated job should appear in status=escalated_to_computer list');
    assert.equal(escalJob!.status, 'escalated_to_computer');
  });
});

/* ------------------------------------------------------------------ */
/* POST /api/feedback/ask                                              */
/* ------------------------------------------------------------------ */

describe('POST /api/feedback/ask — auth', () => {
  it('returns 401 without token', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/feedback/ask',
      headers: {},
      body: { message_id: 'x', question: 'what vibe?' },
    });
    assert.equal(res.status, 401);
  });
});

describe('POST /api/feedback/ask — validation', () => {
  it('returns 400 when message_id missing', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/feedback/ask',
      headers: auth(),
      body: { question: 'what vibe?' },
    });
    assert.equal(res.status, 400);
    assert.match((res.body as { error: string }).error, /message_id/);
  });

  it('returns 400 when question missing', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/feedback/ask',
      headers: auth(),
      body: { message_id: 'msg_abc' },
    });
    assert.equal(res.status, 400);
    assert.match((res.body as { error: string }).error, /question/);
  });
});

describe('POST /api/feedback/ask — happy path', () => {
  it('creates a feedback_request and returns feedback_id', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/feedback/ask',
      headers: auth(),
      body: { message_id: 'msg_test_fb_001', question: 'Which vibe do you want for the reel?' },
    });
    assert.equal(res.status, 200);
    const body = res.body as { ok: boolean; feedback_id: string };
    assert.equal(body.ok, true);
    assert.ok(typeof body.feedback_id === 'string' && body.feedback_id.length > 0);
  });
});

/* ------------------------------------------------------------------ */
/* GET /api/feedback/pending                                           */
/* ------------------------------------------------------------------ */

describe('GET /api/feedback/pending — auth', () => {
  it('returns 401 without token', async () => {
    const res = await routeRequest({
      method: 'GET',
      path: '/api/feedback/pending',
      headers: {},
    });
    assert.equal(res.status, 401);
  });
});

describe('GET /api/feedback/pending — happy path', () => {
  it('returns unresolved feedback_requests', async () => {
    // Ask a question to ensure there's at least one
    await routeRequest({
      method: 'POST',
      path: '/api/feedback/ask',
      headers: auth(),
      body: { message_id: 'msg_poll_fb_001', question: 'What audio track should I use?' },
    });

    const res = await routeRequest({
      method: 'GET',
      path: '/api/feedback/pending',
      headers: auth(),
    });
    assert.equal(res.status, 200);
    const body = res.body as { ok: boolean; feedback_requests: { resolved: boolean }[] };
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.feedback_requests));
    // All returned requests must be unresolved
    for (const r of body.feedback_requests) {
      assert.equal(r.resolved, false);
    }
  });
});

/* ------------------------------------------------------------------ */
/* POST /api/feedback/answer                                           */
/* ------------------------------------------------------------------ */

describe('POST /api/feedback/answer — auth', () => {
  it('returns 401 without token', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/feedback/answer',
      headers: {},
      body: { feedback_id: 'x', answer: 'y' },
    });
    assert.equal(res.status, 401);
  });
});

describe('POST /api/feedback/answer — validation', () => {
  it('returns 400 when feedback_id missing', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/feedback/answer',
      headers: auth(),
      body: { answer: 'use the calm one' },
    });
    assert.equal(res.status, 400);
    assert.match((res.body as { error: string }).error, /feedback_id/);
  });

  it('returns 400 when answer missing', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/feedback/answer',
      headers: auth(),
      body: { feedback_id: 'fb_xxx' },
    });
    assert.equal(res.status, 400);
    assert.match((res.body as { error: string }).error, /answer/);
  });

  it('returns 400 when feedback_id not found', async () => {
    const res = await routeRequest({
      method: 'POST',
      path: '/api/feedback/answer',
      headers: auth(),
      body: { feedback_id: 'nonexistent_fb_xxxxxxxx', answer: 'test' },
    });
    assert.equal(res.status, 400);
    assert.match((res.body as { error: string }).error, /not found/);
  });
});

/* ------------------------------------------------------------------ */
/* Full round-trip: chat append + retrieval                           */
/* ------------------------------------------------------------------ */

describe('chat round-trip — append + retrieval', () => {
  it('message appears in GET /api/chat/messages after POST', async () => {
    const text = `round-trip-chat-${Date.now()}`;

    // Post
    const postRes = await routeRequest({
      method: 'POST',
      path: '/api/chat/message',
      headers: auth(),
      body: { text, role: 'user' },
    });
    assert.equal(postRes.status, 200);
    const { message_id } = postRes.body as { message_id: string };

    // Read all messages
    const getRes = await routeRequest({
      method: 'GET',
      path: '/api/chat/messages',
      headers: auth(),
    });
    assert.equal(getRes.status, 200);
    const msgs = (getRes.body as { messages: { id: string; text: string; role: string }[] }).messages;
    const found = msgs.find((m) => m.id === message_id);
    assert.ok(found, 'posted message should appear in message list');
    assert.equal(found!.text, text);
    assert.equal(found!.role, 'user');
  });

  it('reply appears in messages after POST /api/chat/reply', async () => {
    const text = `reply-rt-${Date.now()}`;

    const postRes = await routeRequest({
      method: 'POST',
      path: '/api/chat/message',
      headers: auth(),
      body: { text, role: 'user' },
    });
    const { message_id } = postRes.body as { message_id: string };

    await routeRequest({
      method: 'POST',
      path: '/api/chat/reply',
      headers: auth(),
      body: { message_id, reply_text: 'Got it, processing!', role: 'assistant' },
    });

    const getRes = await routeRequest({
      method: 'GET',
      path: '/api/chat/messages',
      headers: auth(),
    });
    const msgs = (getRes.body as { messages: { message_id?: string; role: string; text: string }[] }).messages;
    const reply = msgs.find((m) => m.message_id === message_id && m.role === 'assistant');
    assert.ok(reply, 'assistant reply should appear in message list');
    assert.equal(reply!.text, 'Got it, processing!');
  });

  it('job is marked done after POST /api/chat/reply', async () => {
    const postRes = await routeRequest({
      method: 'POST',
      path: '/api/chat/message',
      headers: auth(),
      body: { text: 'job-done-test', role: 'user' },
    });
    const { message_id } = postRes.body as { message_id: string };

    await routeRequest({
      method: 'POST',
      path: '/api/chat/reply',
      headers: auth(),
      body: { message_id, reply_text: 'done!', role: 'assistant' },
    });

    // Confirm the job no longer appears in queued list
    const pendRes = await routeRequest({
      method: 'GET',
      path: '/api/chat/pending',
      headers: auth(),
      query: { status: 'queued' },
    });
    const jobs = (pendRes.body as { jobs: { message_id: string; status: string }[] }).jobs;
    const stillQueued = jobs.find((j) => j.message_id === message_id);
    assert.ok(!stillQueued, 'job should not be queued after reply');
  });
});

/* ------------------------------------------------------------------ */
/* Full round-trip: feedback ask / answer cycle                       */
/* ------------------------------------------------------------------ */

describe('feedback ask/answer cycle', () => {
  it('ask creates pending feedback; answer resolves it and re-queues job', async () => {
    // Create a message (creates a pending_job we can re-queue later)
    const msgRes = await routeRequest({
      method: 'POST',
      path: '/api/chat/message',
      headers: auth(),
      body: { text: 'feedback-cycle-test', role: 'user' },
    });
    const { message_id } = msgRes.body as { message_id: string };

    // Ask a clarifying question
    const askRes = await routeRequest({
      method: 'POST',
      path: '/api/feedback/ask',
      headers: auth(),
      body: { message_id, question: 'Which reel clip should I use?' },
    });
    assert.equal(askRes.status, 200);
    const { feedback_id } = askRes.body as { feedback_id: string };

    // Confirm it shows in pending
    const pendingRes = await routeRequest({
      method: 'GET',
      path: '/api/feedback/pending',
      headers: auth(),
    });
    const pendingFbs = (pendingRes.body as { feedback_requests: { id: string }[] }).feedback_requests;
    assert.ok(pendingFbs.some((r) => r.id === feedback_id), 'feedback should appear in pending list');

    // Answer it
    const ansRes = await routeRequest({
      method: 'POST',
      path: '/api/feedback/answer',
      headers: auth(),
      body: { feedback_id, answer: 'Use the sunset taxi clip' },
    });
    assert.equal(ansRes.status, 200);
    const ansBody = ansRes.body as { ok: boolean; requeued_job_id: string | null };
    assert.equal(ansBody.ok, true);
    // Should have re-queued a job
    assert.ok(typeof ansBody.requeued_job_id === 'string' && ansBody.requeued_job_id.length > 0);

    // Feedback should no longer appear in pending
    const pendingAfterRes = await routeRequest({
      method: 'GET',
      path: '/api/feedback/pending',
      headers: auth(),
    });
    const pendingAfterFbs = (pendingAfterRes.body as { feedback_requests: { id: string }[] }).feedback_requests;
    assert.ok(!pendingAfterFbs.some((r) => r.id === feedback_id), 'answered feedback should not be in pending');

    // Re-queued job should appear in GET /api/chat/pending?status=queued
    const requeuedPendRes = await routeRequest({
      method: 'GET',
      path: '/api/chat/pending',
      headers: auth(),
      query: { status: 'queued' },
    });
    const requeuedJobs = (requeuedPendRes.body as { jobs: { id: string; feedback_answer: string }[] }).jobs;
    const requeuedJob = requeuedJobs.find((j) => j.id === ansBody.requeued_job_id);
    assert.ok(requeuedJob, 're-queued job should appear in queued jobs list');
    assert.equal(requeuedJob!.feedback_answer, 'Use the sunset taxi clip');
  });
});

/* ------------------------------------------------------------------ */
/* Phase 4: chat → daily-note vault job                                */
/* ------------------------------------------------------------------ */

describe('Phase 4: chat capture to Daily Notes', () => {
  it('enqueues a daily-note vault job for incoming user messages when vault is enabled', async () => {
    // Enable vault
    const enableRes = await routeRequest({
      method: 'POST',
      path: '/api/vault/status',
      headers: auth(),
      body: { enabled: true, dry_run: true, vault_root: '/mnt/f/Vault' },
    });
    assert.equal(enableRes.status, 200);

    // Snapshot pending count before
    const beforeRes = await routeRequest({
      method: 'GET',
      path: '/api/vault/jobs/pending',
      headers: auth(),
    });
    const before = ((beforeRes.body as { jobs: unknown[] }).jobs || []).length;

    // Send a chat message
    const msgRes = await routeRequest({
      method: 'POST',
      path: '/api/chat/message',
      headers: auth(),
      body: { text: 'Phase 4 capture probe', role: 'user' },
    });
    assert.equal(msgRes.status, 200);

    // The daily-note job should now be queued
    const afterRes = await routeRequest({
      method: 'GET',
      path: '/api/vault/jobs/pending',
      headers: auth(),
    });
    const after = (afterRes.body as { jobs: { kind: string; payload: { text: string; source?: string } }[] }).jobs;
    assert.ok(after.length > before, 'a new vault job should be enqueued');
    const dailyNote = after.find((j) => j.kind === 'daily-note' && j.payload.text.includes('Phase 4 capture probe'));
    assert.ok(dailyNote, 'a daily-note job with the chat text should be present');
    assert.equal(dailyNote!.payload.text, '[user] Phase 4 capture probe');
    assert.equal(dailyNote!.payload.source, 'chat');
  });

  it('enqueues a daily-note vault job for replies', async () => {
    // Vault already enabled from prior test; explicit just in case test runs alone.
    await routeRequest({
      method: 'POST',
      path: '/api/vault/status',
      headers: auth(),
      body: { enabled: true, dry_run: true, vault_root: '/mnt/f/Vault' },
    });

    // First create a chat message to reply to
    const msgRes = await routeRequest({
      method: 'POST',
      path: '/api/chat/message',
      headers: auth(),
      body: { text: 'parent message', role: 'user' },
    });
    const { message_id } = msgRes.body as { message_id: string };

    // Post a reply
    const replyRes = await routeRequest({
      method: 'POST',
      path: '/api/chat/reply',
      headers: auth(),
      body: { message_id, reply_text: 'reply body', role: 'assistant' },
    });
    assert.equal(replyRes.status, 200);

    const pendingRes = await routeRequest({
      method: 'GET',
      path: '/api/vault/jobs/pending',
      headers: auth(),
    });
    const jobs = (pendingRes.body as { jobs: { kind: string; payload: { text: string; source?: string } }[] }).jobs;
    const replyJob = jobs.find((j) => j.kind === 'daily-note' && j.payload.text.includes('reply body'));
    assert.ok(replyJob, 'reply should produce a daily-note vault job');
    assert.equal(replyJob!.payload.text, '[OC] reply body');
  });

  it('does NOT enqueue when vault is disabled', async () => {
    // Disable vault
    await routeRequest({
      method: 'POST',
      path: '/api/vault/status',
      headers: auth(),
      body: { enabled: false, dry_run: true },
    });

    const beforeRes = await routeRequest({
      method: 'GET',
      path: '/api/vault/jobs/pending',
      headers: auth(),
    });
    const before = ((beforeRes.body as { jobs: unknown[] }).jobs || []).length;

    const msgRes = await routeRequest({
      method: 'POST',
      path: '/api/chat/message',
      headers: auth(),
      body: { text: 'should not capture', role: 'user' },
    });
    assert.equal(msgRes.status, 200);

    const afterRes = await routeRequest({
      method: 'GET',
      path: '/api/vault/jobs/pending',
      headers: auth(),
    });
    const after = ((afterRes.body as { jobs: unknown[] }).jobs || []).length;
    assert.equal(after, before, 'no new vault jobs should be enqueued when vault is disabled');
  });
});
