/**
 * Phase 6 — Cockpit HTTP router.
 *
 * Builds the standard Cockpit OS HTTP surface:
 *
 *   POST /hooks/cockpit-:mappingId    \u2192 inbound webhook (auth + dispatch)
 *   POST /hooks/computer-done         \u2192 Computer task callback
 *   GET  /api/dashboard/summary       \u2192 audit-log counters
 *   GET  /api/dashboard/recent        \u2192 recent activity feed
 *   GET  /api/dashboard/jobs          \u2192 job-status histogram
 *   GET  /api/dashboard/identities    \u2192 list identities for a uid
 *   POST /api/identities              \u2192 admin: bind identity (token-gated)
 *   POST /api/identities/revoke       \u2192 admin: revoke identity (token-gated)
 *   GET  /healthz                     \u2192 liveness
 *   GET  /                            \u2192 dashboard UI (Phase 7)
 *
 * The router is pure: it takes a normalized request, calls into the
 * Cockpit handlers (which read/write Firestore), and returns a normalized
 * response. Real adapters (node:http, Express, Cloud Functions) live in
 * sibling files and only translate request/response shapes.
 */

import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  bindIdentity,
  listIdentitiesForUid,
  revokeIdentity,
} from '../identity/resolver.js';
import { IDENTITY_CHANNELS, type IdentityChannel } from '../identity/types.js';
import {
  dashboardSummary,
  jobStatusHistogram,
  recentForUid,
  recentSystemActivity,
} from '../observability/dashboard.js';
import { handleComputerCallback } from '../computer/callback.js';
import {
  checkInboundAuth,
  handleInboundEvent,
  inboundRegistry,
} from '../webhooks/inbound.js';
import { createContext } from '../context/index.js';
import { logger } from '../context/logger.js';
import type { CockpitContext } from '../context/types.js';
import {
  getAllState,
  getState,
  setState,
  deleteState,
  getChatMessages,
  appendChatMessage,
  getPendingJobs,
  upsertPendingJob,
  getFeedbackRequests,
  upsertFeedbackRequest,
  getVaultJobs,
  upsertVaultJob,
  getVaultStatus,
  setVaultStatus,
  getTasks,
  setTasks,
  upsertTask,
  getTaskById,
  type ChatMessage,
  type PendingJob,
  type FeedbackRequest,
  type VaultJob,
  type VaultJobKind,
  type VaultStatus,
  type Task,
  type TaskOwner,
  type TaskPriority,
  type TaskFeedback,
  type TaskEscalation,
} from '../state/store.js';

import {
  TokenBucketLimiter,
  checkAdminAuth,
  clientKey,
  internalErrorResponse,
  rateLimitConfigFromEnv,
  rateLimitedResponse,
  requestIdFor,
  withSecurityHeaders,
} from './security.js';
import type {
  CockpitHttpRequest,
  CockpitHttpResponse,
  CockpitRoute,
} from './types.js';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function jsonResponse(status: number, body: unknown): CockpitHttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body,
  };
}

function unauthorized(): CockpitHttpResponse {
  return jsonResponse(401, { ok: false, error: 'unauthorized' });
}

function badRequest(error: string): CockpitHttpResponse {
  return jsonResponse(400, { ok: false, error });
}

function notFound(): CockpitHttpResponse {
  return jsonResponse(404, { ok: false, error: 'not found' });
}

function methodNotAllowed(): CockpitHttpResponse {
  return jsonResponse(405, { ok: false, error: 'method not allowed' });
}

/* -------------------------------------------------------------------------- */
/* Hook prefix matcher                                                         */
/* -------------------------------------------------------------------------- */

/**
 * `/hooks/cockpit-:mappingId` is the only path family that accepts a path
 * parameter. We match it with a deliberately small custom matcher instead
 * of a regex library so behavior is obvious from the source.
 */
function matchInboundHook(p: string): string | null {
  const prefix = '/hooks/cockpit-';
  if (!p.startsWith(prefix)) return null;
  const rest = p.slice(prefix.length);
  if (!rest || rest.includes('/')) return null;
  return rest;
}

/**
 * `/api/state/:key` — matches if the path has exactly one segment after /api/state/.
 * Returns the decoded key, or null if not a state-keyed path.
 */
function matchStateKey(p: string): string | null {
  const prefix = '/api/state/';
  if (!p.startsWith(prefix)) return null;
  const rest = p.slice(prefix.length);
  // Must be non-empty and must not contain more slashes (no sub-resources).
  if (!rest || rest.includes('/')) return null;
  return decodeURIComponent(rest);
}

/* -------------------------------------------------------------------------- */
/* Auth                                                                        */
/* -------------------------------------------------------------------------- */

function authHeader(req: CockpitHttpRequest): string | undefined {
  return req.headers['authorization'];
}

/**
 * Admin endpoints check `COCKPIT_ADMIN_TOKEN` first and fall back to
 * `OPENCLAW_HOOKS_TOKEN` if it's unset \u2014 set both for defence in depth.
 */
function checkAdmin(req: CockpitHttpRequest): boolean {
  return checkAdminAuth(authHeader(req));
}

/* -------------------------------------------------------------------------- */
/* Rate limiting                                                               */
/* -------------------------------------------------------------------------- */

const rlConfig = rateLimitConfigFromEnv();
const hooksLimiter = new TokenBucketLimiter(rlConfig.hooks);
const apiLimiter = new TokenBucketLimiter(rlConfig.api);

function enforceRateLimit(
  req: CockpitHttpRequest,
  family: 'hooks' | 'api',
): CockpitHttpResponse | null {
  if (!rlConfig.enabled) return null;
  const limiter = family === 'hooks' ? hooksLimiter : apiLimiter;
  const key = `${family}:${clientKey(req)}`;
  const decision = limiter.check(key);
  if (!decision.allowed) {
    logger.warn('rate limit exceeded', {
      family,
      key,
      retryAfterSeconds: decision.retryAfterSeconds,
    });
    return rateLimitedResponse(decision);
  }
  return null;
}

/** Test-only helper. */
export function _resetRateLimitersForTesting(): void {
  hooksLimiter._resetForTesting();
  apiLimiter._resetForTesting();
}

/* -------------------------------------------------------------------------- */
/* Static UI loader                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Resolves the dashboard UI directory. The compiled output lives in
 * `dist/http/ui` next to this file. In dev (tsx) we look for the source
 * `src/http/ui` instead. Both paths are static \u2014 we never serve user
 * content from this loader.
 */
function uiDir(): string {
  const here = fileURLToPath(import.meta.url);
  const distUi = path.resolve(path.dirname(here), 'ui');
  // path.resolve handles both dist/http/router.js and src/http/router.ts
  return distUi;
}

async function readUiAsset(name: string): Promise<string | null> {
  const safe = name.replace(/\\/g, '/');
  if (safe.includes('..') || safe.startsWith('/')) return null;
  const candidates = [
    path.join(uiDir(), safe),
    // tsx in dev: dist/ doesn't exist yet; fall back to src/http/ui
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'http', 'ui', safe),
  ];
  for (const c of candidates) {
    try {
      return await fs.readFile(c, 'utf8');
    } catch {
      // try next
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                    */
/* -------------------------------------------------------------------------- */

async function handleInboundHook(
  req: CockpitHttpRequest,
  mappingId: string,
): Promise<CockpitHttpResponse> {
  if (!checkInboundAuth(authHeader(req))) return unauthorized();
  const ctx = createContext({ uid: 'system', source: 'webhook' });
  // Splice the parsed mappingId into the body so handlers don't need to
  // re-parse the URL.
  const raw =
    typeof req.body === 'object' && req.body !== null
      ? { ...(req.body as Record<string, unknown>), mappingId }
      : { mappingId };
  const result = await handleInboundEvent(ctx, raw);
  return jsonResponse(result.ok ? 200 : 400, result);
}

async function handleComputerHook(
  req: CockpitHttpRequest,
): Promise<CockpitHttpResponse> {
  if (!checkInboundAuth(authHeader(req))) return unauthorized();
  const ctx = createContext({ uid: 'system', source: 'webhook' });
  const result = await handleComputerCallback(ctx, req.body);
  return jsonResponse(result.ok ? 200 : 400, result);
}

async function handleDashboardSummary(
  req: CockpitHttpRequest,
): Promise<CockpitHttpResponse> {
  if (!checkAdmin(req)) return unauthorized();
  const ctx = createContext({ uid: 'system', source: 'rpc' });
  const q = req.query ?? {};
  const summary = await dashboardSummary(ctx, {
    ...(q.uid && { uid: q.uid }),
    ...(q.since && { since: q.since }),
    ...(q.until && { until: q.until }),
    ...(q.scanLimit && { scanLimit: Number(q.scanLimit) }),
  });
  return jsonResponse(200, { ok: true, summary });
}

async function handleDashboardRecent(
  req: CockpitHttpRequest,
): Promise<CockpitHttpResponse> {
  if (!checkAdmin(req)) return unauthorized();
  const ctx = createContext({ uid: 'system', source: 'rpc' });
  const q = req.query ?? {};
  const limit = q.limit ? Number(q.limit) : 50;
  const events = q.uid
    ? await recentForUid(ctx, q.uid, limit)
    : await recentSystemActivity(ctx, limit);
  return jsonResponse(200, { ok: true, events });
}

async function handleDashboardJobs(
  req: CockpitHttpRequest,
): Promise<CockpitHttpResponse> {
  if (!checkAdmin(req)) return unauthorized();
  const ctx = createContext({ uid: 'system', source: 'rpc' });
  const q = req.query ?? {};
  const histogram = await jobStatusHistogram(ctx, q.uid);
  return jsonResponse(200, { ok: true, histogram });
}

async function handleDashboardIdentities(
  req: CockpitHttpRequest,
): Promise<CockpitHttpResponse> {
  if (!checkAdmin(req)) return unauthorized();
  const q = req.query ?? {};
  if (!q.uid) return badRequest('missing query param "uid"');
  const ctx = createContext({ uid: 'system', source: 'rpc' });
  const identities = await listIdentitiesForUid(ctx, q.uid);
  return jsonResponse(200, { ok: true, identities });
}

async function handleBindIdentity(
  req: CockpitHttpRequest,
): Promise<CockpitHttpResponse> {
  if (!checkAdmin(req)) return unauthorized();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const channel = body.channel as IdentityChannel | undefined;
  const handle = body.handle as string | undefined;
  const uid = body.uid as string | undefined;
  const label = body.label as string | undefined;
  if (!channel || !IDENTITY_CHANNELS.includes(channel)) {
    return badRequest('invalid or missing "channel"');
  }
  if (!handle) return badRequest('missing "handle"');
  if (!uid) return badRequest('missing "uid"');
  const ctx = createContext({ uid: 'system', source: 'rpc' });
  const input: Parameters<typeof bindIdentity>[1] = { channel, handle, uid };
  if (label !== undefined) input.label = label;
  const identity = await bindIdentity(ctx, input);
  return jsonResponse(200, { ok: true, identity });
}

async function handleRevokeIdentity(
  req: CockpitHttpRequest,
): Promise<CockpitHttpResponse> {
  if (!checkAdmin(req)) return unauthorized();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const channel = body.channel as IdentityChannel | undefined;
  const handle = body.handle as string | undefined;
  if (!channel || !IDENTITY_CHANNELS.includes(channel)) {
    return badRequest('invalid or missing "channel"');
  }
  if (!handle) return badRequest('missing "handle"');
  const ctx = createContext({ uid: 'system', source: 'rpc' });
  const result = await revokeIdentity(ctx, channel, handle);
  return jsonResponse(200, { ok: true, identity: result });
}

async function handleHealthz(): Promise<CockpitHttpResponse> {
  // Liveness: process is up. No I/O, no auth.
  return jsonResponse(200, { ok: true, at: new Date().toISOString() });
}

async function handleReadyz(): Promise<CockpitHttpResponse> {
  // Readiness: confirm we have an auth secret configured. We do not probe
  // Firestore here \u2014 a transient Firestore blip should not flap us out
  // of the load balancer; queue retries handle that on the data path.
  const haveToken =
    !!process.env.OPENCLAW_HOOKS_TOKEN || process.env.COCKPIT_ALLOW_NO_TOKEN === '1';
  if (!haveToken) {
    return jsonResponse(503, {
      ok: false,
      ready: false,
      error: 'OPENCLAW_HOOKS_TOKEN not set',
    });
  }
  return jsonResponse(200, { ok: true, ready: true, at: new Date().toISOString() });
}

/* -------------------------------------------------------------------------- */
/* State store handlers                                                        */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/state \u2014 returns all key-value pairs for the authenticated user.
 * Query param `uid` defaults to "default" for the single-user deployment;
 * present as a forward-compat hook for multi-user future.
 */
async function handleGetAllState(
  req: CockpitHttpRequest,
): Promise<CockpitHttpResponse> {
  if (!checkAdmin(req)) return unauthorized();
  const ctx = createContext({ uid: 'system', source: 'rpc' });
  const uid = req.query?.uid ?? 'default';
  const state = await getAllState(ctx, uid);
  return jsonResponse(200, { ok: true, state });
}

/** GET /api/state/:key */
async function handleGetState(
  req: CockpitHttpRequest,
  key: string,
): Promise<CockpitHttpResponse> {
  if (!checkAdmin(req)) return unauthorized();
  const ctx = createContext({ uid: 'system', source: 'rpc' });
  const uid = req.query?.uid ?? 'default';
  const value = await getState(ctx, uid, key);
  return jsonResponse(200, { ok: true, key, value });
}

/** PUT /api/state/:key \u2014 body: { value: ... } */
async function handleSetState(
  req: CockpitHttpRequest,
  key: string,
): Promise<CockpitHttpResponse> {
  if (!checkAdmin(req)) return unauthorized();
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!('value' in body)) return badRequest('missing "value" in body');
  const ctx = createContext({ uid: 'system', source: 'rpc' });
  const uid = req.query?.uid ?? 'default';
  await setState(ctx, uid, key, body.value);
  return jsonResponse(200, { ok: true });
}

/** DELETE /api/state/:key */
async function handleDeleteState(
  req: CockpitHttpRequest,
  key: string,
): Promise<CockpitHttpResponse> {
  if (!checkAdmin(req)) return unauthorized();
  const ctx = createContext({ uid: 'system', source: 'rpc' });
  const uid = req.query?.uid ?? 'default';
  await deleteState(ctx, uid, key);
  return jsonResponse(200, { ok: true });
}

/* -------------------------------------------------------------------------- */
/* Computer offload handler                                                    */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/computer/offload \u2014 enqueue a computer-offload job.
 *
 * Body: { title: string, instructions: string, callbackKey?: string }
 *
 * Implementation choice: we write a job document directly to the `jobs`
 * Firestore collection with kind="computer-offload" and status="queued".
 * The existing /api/dashboard/jobs endpoint surfaces it. This simpler path
 * avoids wiring up the full dispatcher router (which requires a registered
 * intent and matching worker), keeping the diff minimal.
 */
async function handleComputerOffload(
  req: CockpitHttpRequest,
): Promise<CockpitHttpResponse> {
  if (!checkAdmin(req)) return unauthorized();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const title = body.title as string | undefined;
  const instructions = body.instructions as string | undefined;
  if (!title || typeof title !== 'string') return badRequest('missing or invalid "title"');
  if (!instructions || typeof instructions !== 'string')
    return badRequest('missing or invalid "instructions"');
  const callbackKey = body.callbackKey as string | undefined;

  const ctx = createContext({ uid: 'system', source: 'rpc' });
  const id = `offload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ts = new Date().toISOString();
  const jobDoc = {
    id,
    uid: 'default',
    intent: 'computer-offload',
    kind: 'computer-offload',
    status: 'queued',
    worker: 'computer',
    payload: { title, instructions, ...(callbackKey ? { callbackKey } : {}) },
    artifacts: [],
    context: {},
    attempts: 0,
    maxAttempts: 1,
    lastError: null,
    version: 0,
    source: 'rpc',
    createdAt: ts,
    updatedAt: ts,
    finishedAt: null,
    externalTaskId: null,
  };
  await ctx.db.collection('jobs').doc(id).set(jobDoc);
  ctx.log.info('computer offload job created', { id, title });
  return jsonResponse(200, { ok: true, jobId: id });
}

/* -------------------------------------------------------------------------- */
/* Chat handlers                                                               */
/* -------------------------------------------------------------------------- */

function genId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Phase 4: Enqueue a daily-note vault job. Best-effort; swallows errors so a
 * vault failure never breaks chat. Skips silently when vault is disabled.
 */
async function enqueueDailyNoteJob(
  ctx: CockpitContext,
  ts: string,
  text: string,
  source = 'chat',
): Promise<void> {
  try {
    const status = await getVaultStatus(ctx);
    if (!status?.enabled) return;
    const job: VaultJob = {
      id: genId('vjob'),
      kind: 'daily-note',
      payload: { text, source },
      status: 'queued',
      created_at: ts,
      updated_at: ts,
    };
    await upsertVaultJob(ctx, job);
  } catch (_) {
    /* never let vault enqueue failure surface to chat callers */
  }
}

/**
 * POST /api/chat/message
 * body: { text: string, role: "user" }
 * Appends to chat_messages and enqueues a pending_job.
 */
async function handlePostChatMessage(
  req: CockpitHttpRequest,
): Promise<CockpitHttpResponse> {
  if (!checkAdmin(req)) return unauthorized();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const text = body.text as string | undefined;
  const role = (body.role as string | undefined) ?? 'user';
  if (!text || typeof text !== 'string') return badRequest('missing "text"');
  if (role !== 'user') return badRequest('role must be "user" for incoming messages');
  const rawTab = body.context_tab as string | undefined;
  const contextTab: 'today' | 'money' | 'flight' | undefined =
    rawTab === 'today' || rawTab === 'money' || rawTab === 'flight' ? rawTab : undefined;
  const tabContext = body.tab_context;

  const ctx = createContext({ uid: 'system', source: 'rpc' });
  const ts = new Date().toISOString();
  const messageId = genId('msg');
  const jobId = genId('job');

  const msg: ChatMessage = { id: messageId, text, role: 'user', ts };
  if (contextTab) msg.context_tab = contextTab;
  if (tabContext !== undefined && tabContext !== null) msg.tab_context = tabContext;
  await appendChatMessage(ctx, msg);

  // Phase 4: capture every chat message into Daily Notes via vault job.
  await enqueueDailyNoteJob(ctx, ts, `[user] ${text}`, 'chat');

  const job: PendingJob = {
    id: jobId,
    kind: 'chat',
    message_id: messageId,
    status: 'queued',
    created_at: ts,
    updated_at: ts,
  };
  if (contextTab) job.context_tab = contextTab;
  if (tabContext !== undefined && tabContext !== null) job.tab_context = tabContext;
  await upsertPendingJob(ctx, job);

  return jsonResponse(200, { ok: true, message_id: messageId, job_id: jobId });
}

/**
 * GET /api/chat/messages?since=<iso-ts>
 * Returns full message log, optionally filtered to messages after `since`.
 */
async function handleGetChatMessages(
  req: CockpitHttpRequest,
): Promise<CockpitHttpResponse> {
  if (!checkAdmin(req)) return unauthorized();
  const ctx = createContext({ uid: 'system', source: 'rpc' });
  let msgs = await getChatMessages(ctx);
  const since = req.query?.since;
  if (since) {
    msgs = msgs.filter((m) => m.ts > since);
  }
  return jsonResponse(200, { ok: true, messages: msgs });
}

/**
 * GET /api/chat/pending?status=<status>
 * Returns pending_jobs with the given status (default: queued).
 */
async function handleGetChatPending(
  req: CockpitHttpRequest,
): Promise<CockpitHttpResponse> {
  if (!checkAdmin(req)) return unauthorized();
  const ctx = createContext({ uid: 'system', source: 'rpc' });
  const jobs = await getPendingJobs(ctx);
  const statusFilter = (req.query?.status as string | undefined) ?? 'queued';
  const filtered = jobs.filter((j) => j.status === statusFilter);
  return jsonResponse(200, { ok: true, jobs: filtered });
}

/**
 * POST /api/chat/reply
 * body: { message_id, reply_text, role: "assistant"|"computer", task_created?: { todoist_id, project } }
 * Appends reply to chat_messages, marks pending_job done.
 */
async function handlePostChatReply(
  req: CockpitHttpRequest,
): Promise<CockpitHttpResponse> {
  if (!checkAdmin(req)) return unauthorized();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const message_id = body.message_id as string | undefined;
  const reply_text = body.reply_text as string | undefined;
  const role = (body.role as string | undefined) ?? 'assistant';
  if (!message_id) return badRequest('missing "message_id"');
  if (!reply_text) return badRequest('missing "reply_text"');
  if (role !== 'assistant' && role !== 'computer')
    return badRequest('role must be "assistant" or "computer"');

  const ctx = createContext({ uid: 'system', source: 'rpc' });
  const ts = new Date().toISOString();
  const replyId = genId('msg');

  const replyMsg: ChatMessage = {
    id: replyId,
    text: reply_text,
    role: role as 'assistant' | 'computer',
    ts,
    message_id,
    ...(body.task_created ? { task_created: body.task_created as { todoist_id: string; project: string } } : {}),
  };
  await appendChatMessage(ctx, replyMsg);

  // Phase 4: capture replies into Daily Notes too. Uses the role as the speaker tag.
  const speaker = role === 'computer' ? 'computer' : 'OC';
  await enqueueDailyNoteJob(ctx, ts, `[${speaker}] ${reply_text}`, 'chat');

  // Mark the pending_job for this message_id as done.
  const jobs = await getPendingJobs(ctx);
  const job = jobs.find((j) => j.message_id === message_id && j.status !== 'done');
  if (job) {
    await upsertPendingJob(ctx, { ...job, status: 'done', updated_at: ts });
  }

  return jsonResponse(200, { ok: true, reply_id: replyId });
}

/**
 * POST /api/chat/escalate
 * body: { message_id, reason, task_payload }
 * Marks pending_job as escalated_to_computer and records a feedback_request.
 */
async function handlePostChatEscalate(
  req: CockpitHttpRequest,
): Promise<CockpitHttpResponse> {
  if (!checkAdmin(req)) return unauthorized();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const message_id = body.message_id as string | undefined;
  const reason = (body.reason as string | undefined) ?? 'escalated';
  if (!message_id) return badRequest('missing "message_id"');

  const ctx = createContext({ uid: 'system', source: 'rpc' });
  const ts = new Date().toISOString();

  const jobs = await getPendingJobs(ctx);
  const job = jobs.find((j) => j.message_id === message_id);
  if (!job) return badRequest('no pending_job found for message_id');

  await upsertPendingJob(ctx, {
    ...job,
    status: 'escalated_to_computer',
    reason,
    task_payload: body.task_payload,
    updated_at: ts,
  });

  // Write to feedback_requests so Raine sees it.
  const feedbackId = genId('fb');
  const fbReq: FeedbackRequest = {
    id: feedbackId,
    message_id,
    question: `[Escalated] ${reason}`,
    resolved: false,
    created_at: ts,
    updated_at: ts,
  };
  await upsertFeedbackRequest(ctx, fbReq);

  return jsonResponse(200, { ok: true, feedback_id: feedbackId });
}

/* -------------------------------------------------------------------------- */
/* Feedback handlers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/feedback/ask
 * body: { message_id, question }
 * OpenClaw uses this to ask Raine a clarifying question.
 */
async function handleFeedbackAsk(
  req: CockpitHttpRequest,
): Promise<CockpitHttpResponse> {
  if (!checkAdmin(req)) return unauthorized();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const message_id = body.message_id as string | undefined;
  const question = body.question as string | undefined;
  if (!message_id) return badRequest('missing "message_id"');
  if (!question) return badRequest('missing "question"');

  const ctx = createContext({ uid: 'system', source: 'rpc' });
  const ts = new Date().toISOString();
  const feedbackId = genId('fb');

  const fbReq: FeedbackRequest = {
    id: feedbackId,
    message_id,
    question,
    resolved: false,
    created_at: ts,
    updated_at: ts,
  };
  await upsertFeedbackRequest(ctx, fbReq);

  return jsonResponse(200, { ok: true, feedback_id: feedbackId });
}

/**
 * POST /api/feedback/answer
 * body: { feedback_id, answer }
 * Raine answers from the Feedback tab. Marks resolved, re-queues original message.
 */
async function handleFeedbackAnswer(
  req: CockpitHttpRequest,
): Promise<CockpitHttpResponse> {
  if (!checkAdmin(req)) return unauthorized();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const feedback_id = body.feedback_id as string | undefined;
  const answer = body.answer as string | undefined;
  if (!feedback_id) return badRequest('missing "feedback_id"');
  if (!answer) return badRequest('missing "answer"');

  const ctx = createContext({ uid: 'system', source: 'rpc' });
  const ts = new Date().toISOString();

  // Mark feedback resolved.
  const reqs = await getFeedbackRequests(ctx);
  const fbReq = reqs.find((r) => r.id === feedback_id);
  if (!fbReq) return badRequest('feedback_id not found');
  await upsertFeedbackRequest(ctx, {
    ...fbReq,
    answer,
    resolved: true,
    updated_at: ts,
  });

  // Re-queue the original pending_job with the answer attached.
  const jobs = await getPendingJobs(ctx);
  const job = jobs.find((j) => j.message_id === fbReq.message_id);
  if (job) {
    const newJobId = genId('job');
    const requeuedJob: PendingJob = {
      id: newJobId,
      kind: 'chat',
      message_id: fbReq.message_id,
      status: 'queued',
      created_at: ts,
      updated_at: ts,
      feedback_answer: answer,
    };
    await upsertPendingJob(ctx, requeuedJob);
    return jsonResponse(200, { ok: true, requeued_job_id: newJobId });
  }

  return jsonResponse(200, { ok: true, requeued_job_id: null });
}

/* -------------------------------------------------------------------------- */
/* Vault handlers                                                              */
/*                                                                             */
/* Pull-based: Cockpit creates jobs, the OpenClaw bridge polls for queued      */
/* ones, executes them against the local Obsidian vault, and posts the result */
/* back. The bridge also heartbeats /api/vault/status so the dashboard tile    */
/* shows "connected" without needing a job to run.                             */
/* -------------------------------------------------------------------------- */

const VAULT_JOB_KINDS: ReadonlyArray<VaultJobKind> = [
  'append',
  'read',
  'list',
  'daily-note',
];

/**
 * Validates a vault job payload. Returns null on success or an error string
 * to send back as a 400. Path validation lives in the bridge (vault.js)
 * — this only enforces shape so we can reject malformed jobs early.
 */
function validateVaultJobPayload(
  kind: VaultJobKind,
  payload: Record<string, unknown>,
): string | null {
  if (kind === 'append') {
    if (typeof payload.path !== 'string' || !payload.path) return 'append: missing "path"';
    if (typeof payload.text !== 'string') return 'append: missing "text"';
    return null;
  }
  if (kind === 'read') {
    if (typeof payload.path !== 'string' || !payload.path) return 'read: missing "path"';
    return null;
  }
  if (kind === 'list') {
    if (typeof payload.folder !== 'string' || !payload.folder)
      return 'list: missing "folder"';
    return null;
  }
  if (kind === 'daily-note') {
    if (typeof payload.text !== 'string' || !payload.text)
      return 'daily-note: missing "text"';
    return null;
  }
  return `unknown kind "${kind}"`;
}

/**
 * POST /api/vault/jobs
 * body: { kind: 'append'|'read'|'list'|'daily-note', payload: {...} }
 * Returns: { ok, job_id }
 */
async function handleVaultJobCreate(
  req: CockpitHttpRequest,
): Promise<CockpitHttpResponse> {
  if (!checkAdmin(req)) return unauthorized();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const kind = body.kind as VaultJobKind | undefined;
  if (!kind || !VAULT_JOB_KINDS.includes(kind)) {
    return badRequest(`invalid "kind" (must be one of: ${VAULT_JOB_KINDS.join(', ')})`);
  }
  const payload = body.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return badRequest('missing or invalid "payload" object');
  }
  const validation = validateVaultJobPayload(kind, payload as Record<string, unknown>);
  if (validation) return badRequest(validation);

  const ctx = createContext({ uid: 'system', source: 'rpc' });
  const ts = new Date().toISOString();
  const job: VaultJob = {
    id: genId('vjob'),
    kind,
    payload: payload as Record<string, unknown>,
    status: 'queued',
    created_at: ts,
    updated_at: ts,
  };
  await upsertVaultJob(ctx, job);
  return jsonResponse(200, { ok: true, job_id: job.id });
}

/**
 * GET /api/vault/jobs/pending
 * The bridge polls this every few seconds. Returns queued jobs only.
 * Side effect: heartbeats vault_status.last_seen so the dashboard tile
 * stays green even when no jobs are flowing.
 */
async function handleVaultJobsPending(
  req: CockpitHttpRequest,
): Promise<CockpitHttpResponse> {
  if (!checkAdmin(req)) return unauthorized();
  const ctx = createContext({ uid: 'system', source: 'rpc' });
  const jobs = await getVaultJobs(ctx);
  const queued = jobs.filter((j) => j.status === 'queued');

  // Heartbeat: record that the bridge polled. Status defaults preserved.
  const status = await getVaultStatus(ctx);
  await setVaultStatus(ctx, { ...status, last_seen: new Date().toISOString() });

  return jsonResponse(200, { ok: true, jobs: queued });
}

/**
 * POST /api/vault/jobs/:id/result
 * body: { ok: bool, result?: any, error?: string, dry_run?: bool }
 * The bridge calls this after executing a job. Side effect: updates
 * vault_status counters (last_write, writes_today) when a write succeeds.
 */
async function handleVaultJobResult(
  req: CockpitHttpRequest,
  jobId: string,
): Promise<CockpitHttpResponse> {
  if (!checkAdmin(req)) return unauthorized();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const okFlag = body.ok;
  if (typeof okFlag !== 'boolean') return badRequest('missing boolean "ok"');
  const dryRun = typeof body.dry_run === 'boolean' ? body.dry_run : undefined;
  const error = typeof body.error === 'string' ? body.error : undefined;

  const ctx = createContext({ uid: 'system', source: 'rpc' });
  const jobs = await getVaultJobs(ctx);
  const job = jobs.find((j) => j.id === jobId);
  if (!job) return badRequest(`vault job "${jobId}" not found`);

  const ts = new Date().toISOString();
  const updated: VaultJob = {
    ...job,
    status: okFlag ? 'done' : 'error',
    updated_at: ts,
    ...(body.result !== undefined ? { result: body.result } : {}),
    ...(error ? { error } : {}),
    ...(dryRun !== undefined ? { dry_run: dryRun } : {}),
  };
  await upsertVaultJob(ctx, updated);

  // Update aggregate status. Only count successful, non-dry-run writes.
  const status = await getVaultStatus(ctx);
  const next: VaultStatus = { ...status, last_seen: ts };
  if (okFlag) {
    next.last_error = undefined;
    if ((job.kind === 'append' || job.kind === 'daily-note') && dryRun !== true) {
      next.last_write = ts;
      const today = ts.slice(0, 10); // YYYY-MM-DD UTC
      if (next.writes_today_date === today) {
        next.writes_today = (next.writes_today ?? 0) + 1;
      } else {
        next.writes_today = 1;
        next.writes_today_date = today;
      }
    }
  } else if (error) {
    next.last_error = error;
  }
  await setVaultStatus(ctx, next);

  return jsonResponse(200, { ok: true });
}

/**
 * GET /api/vault/status
 * Dashboard tile reads this every ~10s. Cheap, no side effects.
 */
async function handleVaultStatusGet(
  req: CockpitHttpRequest,
): Promise<CockpitHttpResponse> {
  if (!checkAdmin(req)) return unauthorized();
  const ctx = createContext({ uid: 'system', source: 'rpc' });
  const status = await getVaultStatus(ctx);
  return jsonResponse(200, { ok: true, status });
}

/**
 * POST /api/vault/status
 * The bridge posts its diagnostic() snapshot here on startup so the
 * dashboard knows the vault is enabled, where it points, and dry-run state.
 * body: { enabled, dry_run, vault_root? }
 */
async function handleVaultStatusPost(
  req: CockpitHttpRequest,
): Promise<CockpitHttpResponse> {
  if (!checkAdmin(req)) return unauthorized();
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.enabled !== 'boolean') return badRequest('missing boolean "enabled"');
  if (typeof body.dry_run !== 'boolean') return badRequest('missing boolean "dry_run"');
  const vaultRoot = typeof body.vault_root === 'string' ? body.vault_root : undefined;

  const ctx = createContext({ uid: 'system', source: 'rpc' });
  const prev = await getVaultStatus(ctx);
  const next: VaultStatus = {
    ...prev,
    enabled: body.enabled,
    dry_run: body.dry_run,
    last_seen: new Date().toISOString(),
    ...(vaultRoot ? { vault_root: vaultRoot } : {}),
  };
  await setVaultStatus(ctx, next);
  return jsonResponse(200, { ok: true, status: next });
}

/**
 * `/api/vault/jobs/:id/result` — matches if the path is exactly
 * /api/vault/jobs/<id>/result. Returns the decoded job id, or null.
 */
function matchVaultJobResult(p: string): string | null {
  const prefix = '/api/vault/jobs/';
  const suffix = '/result';
  if (!p.startsWith(prefix) || !p.endsWith(suffix)) return null;
  const middle = p.slice(prefix.length, p.length - suffix.length);
  if (!middle || middle.includes('/')) return null;
  return decodeURIComponent(middle);
}

/* -------------------------------------------------------------------------- */
/* Task endpoints (Phase 3: Obsidian-first task system)                        */
/*                                                                             */
/* The vault is source of truth. The server holds a Firestore-backed cache so  */
/* the dashboard renders fast. The bridge reconciler keeps both in sync via    */
/* GET/PUT /api/tasks/snapshot. All other endpoints are convenience writers    */
/* that bump updated_at; the bridge will then push the change into Active.md.  */
/* -------------------------------------------------------------------------- */

const VALID_TASK_OWNERS: ReadonlyArray<TaskOwner> = [
  'openclaw',
  'claude',
  'raine',
  'perplexity',
];
const VALID_TASK_PRIORITIES: ReadonlyArray<Exclude<TaskPriority, null>> = [
  'high',
  'medium-high',
  'low',
];

function normalizeTaskInput(
  input: Partial<Task>,
  fallback?: Task,
): Task {
  const now = new Date().toISOString();
  const owner: TaskOwner =
    typeof input.owner === 'string' && VALID_TASK_OWNERS.includes(input.owner as TaskOwner)
      ? (input.owner as TaskOwner)
      : fallback?.owner ?? 'openclaw';
  const priority: TaskPriority =
    input.priority === null
      ? null
      : typeof input.priority === 'string' &&
        VALID_TASK_PRIORITIES.includes(input.priority as Exclude<TaskPriority, null>)
      ? (input.priority as TaskPriority)
      : fallback?.priority ?? null;
  return {
    id: input.id ?? fallback?.id ?? genId('t'),
    title: typeof input.title === 'string' ? input.title : fallback?.title ?? '',
    done: typeof input.done === 'boolean' ? input.done : fallback?.done ?? false,
    due: typeof input.due === 'string' ? input.due : fallback?.due ?? null,
    completed_on:
      typeof input.completed_on === 'string'
        ? input.completed_on
        : fallback?.completed_on ?? null,
    priority,
    tags: Array.isArray(input.tags)
      ? (input.tags as unknown[]).filter((t): t is string => typeof t === 'string')
      : fallback?.tags ?? [],
    owner,
    updated_at: now,
    notes: typeof input.notes === 'string' ? input.notes : fallback?.notes ?? '',
    feedback: Array.isArray(input.feedback)
      ? (input.feedback as TaskFeedback[])
      : fallback?.feedback ?? [],
    escalations: Array.isArray(input.escalations)
      ? (input.escalations as TaskEscalation[])
      : fallback?.escalations ?? [],
    artifacts: Array.isArray(input.artifacts)
      ? input.artifacts as Task['artifacts']
      : fallback?.artifacts ?? [],
  };
}

/** GET /api/tasks — active tasks for dashboard. */
async function handleTasksList(
  req: CockpitHttpRequest,
): Promise<CockpitHttpResponse> {
  if (!checkAdmin(req)) return unauthorized();
  const ctx = createContext({ uid: 'system', source: 'rpc' });
  const tasks = await getTasks(ctx);
  return jsonResponse(200, { ok: true, tasks: tasks.filter((t) => !t.done) });
}

/** GET /api/tasks/all — all tasks including done. */
async function handleTasksAll(
  req: CockpitHttpRequest,
): Promise<CockpitHttpResponse> {
  if (!checkAdmin(req)) return unauthorized();
  const ctx = createContext({ uid: 'system', source: 'rpc' });
  const tasks = await getTasks(ctx);
  return jsonResponse(200, { ok: true, tasks });
}

/** POST /api/tasks — create a task. Server generates id + updated_at. */
async function handleTaskCreate(
  req: CockpitHttpRequest,
): Promise<CockpitHttpResponse> {
  if (!checkAdmin(req)) return unauthorized();
  const body = (req.body ?? {}) as Partial<Task>;
  if (!body.title || typeof body.title !== 'string') {
    return badRequest('missing string "title"');
  }
  const ctx = createContext({ uid: 'system', source: 'rpc' });
  const task = normalizeTaskInput({ ...body, id: genId('t') });
  await upsertTask(ctx, task);
  return jsonResponse(200, { ok: true, task });
}

/** PATCH /api/tasks/:id — partial update; bumps updated_at. */
async function handleTaskPatch(
  req: CockpitHttpRequest,
  taskId: string,
): Promise<CockpitHttpResponse> {
  if (!checkAdmin(req)) return unauthorized();
  const ctx = createContext({ uid: 'system', source: 'rpc' });
  const existing = await getTaskById(ctx, taskId);
  if (!existing) return badRequest(`task "${taskId}" not found`);
  const body = (req.body ?? {}) as Partial<Task>;
  const merged = normalizeTaskInput({ ...body, id: taskId }, existing);
  await upsertTask(ctx, merged);
  return jsonResponse(200, { ok: true, task: merged });
}

/** POST /api/tasks/:id/done — marks done with completed_on=today. */
async function handleTaskDone(
  req: CockpitHttpRequest,
  taskId: string,
): Promise<CockpitHttpResponse> {
  if (!checkAdmin(req)) return unauthorized();
  const ctx = createContext({ uid: 'system', source: 'rpc' });
  const existing = await getTaskById(ctx, taskId);
  if (!existing) return badRequest(`task "${taskId}" not found`);
  const today = new Date().toISOString().slice(0, 10);
  const updated = normalizeTaskInput(
    { ...existing, done: true, completed_on: today },
    existing,
  );
  await upsertTask(ctx, updated);
  return jsonResponse(200, { ok: true, task: updated });
}

/** POST /api/tasks/:id/feedback — body { author, text } appends to feedback[]. */
async function handleTaskFeedback(
  req: CockpitHttpRequest,
  taskId: string,
): Promise<CockpitHttpResponse> {
  if (!checkAdmin(req)) return unauthorized();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const author = typeof body.author === 'string' ? body.author : '';
  const text = typeof body.text === 'string' ? body.text : '';
  if (!author) return badRequest('missing string "author"');
  if (!text) return badRequest('missing string "text"');
  const ctx = createContext({ uid: 'system', source: 'rpc' });
  const existing = await getTaskById(ctx, taskId);
  if (!existing) return badRequest(`task "${taskId}" not found`);
  const ts = new Date().toISOString();
  const fb: TaskFeedback = { author, ts, text };
  const updated = normalizeTaskInput(
    { ...existing, feedback: [...existing.feedback, fb] },
    existing,
  );
  await upsertTask(ctx, updated);
  return jsonResponse(200, { ok: true, task: updated });
}

/** POST /api/tasks/:id/escalate — body { to, reason }; appends + updates owner. */
async function handleTaskEscalate(
  req: CockpitHttpRequest,
  taskId: string,
): Promise<CockpitHttpResponse> {
  if (!checkAdmin(req)) return unauthorized();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const to = typeof body.to === 'string' ? (body.to as TaskOwner) : null;
  const reason = typeof body.reason === 'string' ? body.reason : '';
  if (!to || !VALID_TASK_OWNERS.includes(to)) {
    return badRequest(`invalid "to" (must be one of: ${VALID_TASK_OWNERS.join(', ')})`);
  }
  const ctx = createContext({ uid: 'system', source: 'rpc' });
  const existing = await getTaskById(ctx, taskId);
  if (!existing) return badRequest(`task "${taskId}" not found`);
  const ts = new Date().toISOString();
  const esc: TaskEscalation = { from: existing.owner, to, ts, reason };
  const updated = normalizeTaskInput(
    { ...existing, owner: to, escalations: [...existing.escalations, esc] },
    existing,
  );
  await upsertTask(ctx, updated);
  return jsonResponse(200, { ok: true, task: updated });
}

/** GET /api/tasks/snapshot — bridge reads canonical state for reconcile. */
async function handleTasksSnapshotGet(
  req: CockpitHttpRequest,
): Promise<CockpitHttpResponse> {
  if (!checkAdmin(req)) return unauthorized();
  const ctx = createContext({ uid: 'system', source: 'rpc' });
  const tasks = await getTasks(ctx);
  return jsonResponse(200, { ok: true, tasks });
}

/** PUT /api/tasks/snapshot — bridge writes merged state back. */
async function handleTasksSnapshotPut(
  req: CockpitHttpRequest,
): Promise<CockpitHttpResponse> {
  if (!checkAdmin(req)) return unauthorized();
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(body.tasks)) {
    return badRequest('missing array "tasks"');
  }
  const ctx = createContext({ uid: 'system', source: 'rpc' });
  const incoming = (body.tasks as Partial<Task>[]).map((t) => normalizeTaskInput(t));
  // Bridge has already applied last-write-wins; trust its merged output but
  // preserve our updated_at if the bridge sent the same value back (avoids
  // bouncing timestamps forward on every reconcile).
  const existing = await getTasks(ctx);
  const existingMap = new Map(existing.map((t) => [t.id, t]));
  const finalTasks = incoming.map((t) => {
    const prev = existingMap.get(t.id);
    if (
      prev &&
      prev.updated_at &&
      // If the new task is the same as the previous one (modulo updated_at),
      // keep the previous timestamp to prevent reconcile loops.
      JSON.stringify({ ...prev, updated_at: '' }) ===
        JSON.stringify({ ...t, updated_at: '' })
    ) {
      return { ...t, updated_at: prev.updated_at };
    }
    return t;
  });
  await setTasks(ctx, finalTasks);
  return jsonResponse(200, { ok: true, count: finalTasks.length });
}

/** Match `/api/tasks/:id` (PATCH). */
function matchTaskId(p: string): string | null {
  const prefix = '/api/tasks/';
  if (!p.startsWith(prefix)) return null;
  const rest = p.slice(prefix.length);
  if (!rest || rest.includes('/')) return null;
  // Reserve special paths
  if (rest === 'snapshot' || rest === 'all') return null;
  return decodeURIComponent(rest);
}

/** Match `/api/tasks/:id/done`, `/api/tasks/:id/feedback`, `/api/tasks/:id/escalate`. */
function matchTaskAction(p: string): { id: string; action: string } | null {
  const prefix = '/api/tasks/';
  if (!p.startsWith(prefix)) return null;
  const rest = p.slice(prefix.length);
  const parts = rest.split('/');
  if (parts.length !== 2) return null;
  const [id, action] = parts;
  if (!id || !action) return null;
  if (!['done', 'feedback', 'escalate'].includes(action)) return null;
  return { id: decodeURIComponent(id), action };
}

/**
 * GET /api/feedback/pending
 * Returns unresolved feedback_requests.
 */
async function handleFeedbackPending(
  req: CockpitHttpRequest,
): Promise<CockpitHttpResponse> {
  if (!checkAdmin(req)) return unauthorized();
  const ctx = createContext({ uid: 'system', source: 'rpc' });
  const reqs = await getFeedbackRequests(ctx);
  const pending = reqs.filter((r) => !r.resolved);
  return jsonResponse(200, { ok: true, feedback_requests: pending });
}

async function handleRoot(
  req: CockpitHttpRequest,
): Promise<CockpitHttpResponse> {
  // Serve the rich Cockpit UI. Auth is enforced by the API routes \u2014 the
  // static shell is intentionally public (token is entered client-side).
  const html = await readUiAsset('cockpit.html');
  if (!html) {
    // Fall back to admin dashboard if cockpit.html isn't present yet.
    const fallback = await readUiAsset('index.html');
    if (fallback) {
      return {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: fallback,
      };
    }
    return jsonResponse(200, {
      ok: true,
      service: 'cockpit-os',
      routes: listRoutes().map((r) => `${r.method} ${r.path}`),
    });
  }
  return {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: html,
  };
}

async function handleAdmin(
  req: CockpitHttpRequest,
): Promise<CockpitHttpResponse> {
  // Serve the minimal admin dashboard (the original index.html).
  const html = await readUiAsset('index.html');
  if (!html) return notFound();
  return {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: html,
  };
}

async function handleStatic(
  name: string,
  contentType: string,
): Promise<CockpitHttpResponse> {
  const content = await readUiAsset(name);
  if (!content) return notFound();
  return {
    status: 200,
    headers: { 'content-type': contentType },
    body: content,
  };
}

/* -------------------------------------------------------------------------- */
/* Route table                                                                 */
/* -------------------------------------------------------------------------- */

export interface RouteInfo {
  method: string;
  path: string;
  description: string;
}

const STATIC_ROUTES: CockpitRoute[] = [
  {
    method: 'GET',
    path: '/healthz',
    description: 'Liveness probe (note: Google Frontend may intercept on Cloud Run)',
    handler: handleHealthz,
  },
  {
    method: 'GET',
    path: '/_health',
    description: 'Liveness probe (Cloud Run-safe alias of /healthz)',
    handler: handleHealthz,
  },
  {
    method: 'GET',
    path: '/readyz',
    description: 'Readiness probe',
    handler: handleReadyz,
  },
  {
    method: 'POST',
    path: '/hooks/computer-done',
    description: 'Computer worker callback',
    handler: handleComputerHook,
  },
  {
    method: 'GET',
    path: '/api/dashboard/summary',
    description: 'Audit-log counters by kind/source',
    handler: handleDashboardSummary,
  },
  {
    method: 'GET',
    path: '/api/dashboard/recent',
    description: 'Recent audit events',
    handler: handleDashboardRecent,
  },
  {
    method: 'GET',
    path: '/api/dashboard/jobs',
    description: 'Job-status histogram',
    handler: handleDashboardJobs,
  },
  {
    method: 'GET',
    path: '/api/dashboard/identities',
    description: 'List identities for a uid',
    handler: handleDashboardIdentities,
  },
  {
    method: 'POST',
    path: '/api/identities',
    description: 'Bind a channel identity (admin)',
    handler: handleBindIdentity,
  },
  {
    method: 'POST',
    path: '/api/identities/revoke',
    description: 'Revoke a channel identity (admin)',
    handler: handleRevokeIdentity,
  },
  {
    method: 'GET',
    path: '/api/state',
    description: 'Get all user state entries (admin)',
    handler: handleGetAllState,
  },
  {
    method: 'POST',
    path: '/api/computer/offload',
    description: 'Enqueue a Computer offload job (admin)',
    handler: handleComputerOffload,
  },
  // Chat endpoints
  {
    method: 'POST',
    path: '/api/chat/message',
    description: 'Append a user message and enqueue pending_job (admin)',
    handler: handlePostChatMessage,
  },
  {
    method: 'GET',
    path: '/api/chat/messages',
    description: 'Get chat message log, optionally filtered by since= (admin)',
    handler: handleGetChatMessages,
  },
  {
    method: 'GET',
    path: '/api/chat/pending',
    description: 'Get pending_jobs by status (admin)',
    handler: handleGetChatPending,
  },
  {
    method: 'POST',
    path: '/api/chat/reply',
    description: 'Append assistant/computer reply and mark job done (admin)',
    handler: handlePostChatReply,
  },
  {
    method: 'POST',
    path: '/api/chat/escalate',
    description: 'Escalate a chat job to Computer (admin)',
    handler: handlePostChatEscalate,
  },
  // Vault endpoints (Phase 2: poll-based bridge integration)
  {
    method: 'POST',
    path: '/api/vault/jobs',
    description: 'Enqueue a vault job (append/read/list/daily-note) (admin)',
    handler: handleVaultJobCreate,
  },
  {
    method: 'GET',
    path: '/api/vault/jobs/pending',
    description: 'Bridge poll: returns queued vault jobs (admin)',
    handler: handleVaultJobsPending,
  },
  {
    method: 'GET',
    path: '/api/vault/status',
    description: 'Dashboard tile: vault subsystem status (admin)',
    handler: handleVaultStatusGet,
  },
  {
    method: 'POST',
    path: '/api/vault/status',
    description: 'Bridge heartbeat: posts diagnostic snapshot (admin)',
    handler: handleVaultStatusPost,
  },
  // Task endpoints (Phase 3)
  {
    method: 'GET',
    path: '/api/tasks',
    description: 'List active (not-done) tasks (admin)',
    handler: handleTasksList,
  },
  {
    method: 'POST',
    path: '/api/tasks',
    description: 'Create a new task (admin)',
    handler: handleTaskCreate,
  },
  {
    method: 'GET',
    path: '/api/tasks/all',
    description: 'List all tasks including done (admin)',
    handler: handleTasksAll,
  },
  {
    method: 'GET',
    path: '/api/tasks/snapshot',
    description: 'Bridge: read canonical task snapshot (admin)',
    handler: handleTasksSnapshotGet,
  },
  {
    method: 'PUT',
    path: '/api/tasks/snapshot',
    description: 'Bridge: write merged task snapshot (admin)',
    handler: handleTasksSnapshotPut,
  },
  // Feedback endpoints
  {
    method: 'POST',
    path: '/api/feedback/ask',
    description: 'OpenClaw asks Raine a clarifying question (admin)',
    handler: handleFeedbackAsk,
  },
  {
    method: 'POST',
    path: '/api/feedback/answer',
    description: 'Raine answers a feedback question; re-queues job (admin)',
    handler: handleFeedbackAnswer,
  },
  {
    method: 'GET',
    path: '/api/feedback/pending',
    description: 'Get unresolved feedback_requests (admin)',
    handler: handleFeedbackPending,
  },
  {
    method: 'GET',
    path: '/',
    description: 'Cockpit UI',
    handler: handleRoot,
  },
  {
    method: 'GET',
    path: '/_admin',
    description: 'Minimal admin dashboard',
    handler: handleAdmin,
  },
  {
    method: 'GET',
    path: '/dashboard.css',
    description: 'Dashboard stylesheet',
    handler: () => handleStatic('dashboard.css', 'text/css; charset=utf-8'),
  },
  {
    method: 'GET',
    path: '/dashboard.js',
    description: 'Dashboard client script',
    handler: () =>
      handleStatic('dashboard.js', 'application/javascript; charset=utf-8'),
  },
];

export function listRoutes(): RouteInfo[] {
  const dynamic: RouteInfo[] = [
    {
      method: 'POST',
      path: '/hooks/cockpit-:mappingId',
      description: 'Inbound webhook from OpenClaw gateway',
    },
  ];
  return [
    ...dynamic,
    ...STATIC_ROUTES.map((r) => ({
      method: r.method,
      path: r.path,
      description: r.description ?? '',
    })),
  ];
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Path family classifier \u2014 tells the rate limiter which bucket to use
 * and the access logger which surface this request hit.
 */
function classifyPath(p: string): 'hooks' | 'api' | 'static' | 'health' {
  if (p === '/healthz' || p === '/_health' || p === '/readyz') return 'health';
  if (p.startsWith('/hooks/')) return 'hooks';
  if (p.startsWith('/api/')) return 'api';
  return 'static';
}

/**
 * Single entry point used by every adapter. Resolves the route, runs the
 * handler, and returns a normalized response. Errors never leak details to
 * the client \u2014 they\u2019re logged with the request ID and surface as a
 * generic 500.
 */
export async function routeRequest(
  req: CockpitHttpRequest,
): Promise<CockpitHttpResponse> {
  const requestId = requestIdFor(req);
  const startedMs = Date.now();
  const family = classifyPath(req.path);

  let response: CockpitHttpResponse;
  try {
    // Rate limit hooks/api families before any work.
    if (family === 'hooks' || family === 'api') {
      const limited = enforceRateLimit(req, family);
      if (limited) {
        response = limited;
      } else {
        response = await dispatch(req);
      }
    } else {
      response = await dispatch(req);
    }
  } catch (err) {
    logger.error('http handler crashed', {
      requestId,
      method: req.method,
      path: req.path,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    response = internalErrorResponse(requestId);
  }

  // Attach request ID + security headers, then log access line.
  const headers: Record<string, string> = {
    ...(response.headers ?? {}),
    'x-request-id': requestId,
  };
  const finalResponse = withSecurityHeaders({ ...response, headers });

  // Skip access log for healthz/readyz \u2014 those are noisy load-balancer probes.
  if (family !== 'health') {
    logger.info('http', {
      requestId,
      method: req.method,
      path: req.path,
      status: finalResponse.status,
      durationMs: Date.now() - startedMs,
      family,
    });
  }
  return finalResponse;
}

async function dispatch(req: CockpitHttpRequest): Promise<CockpitHttpResponse> {
  // Hooks: parse :mappingId.
  const mappingId = matchInboundHook(req.path);
  if (mappingId !== null) {
    if (req.method !== 'POST') return methodNotAllowed();
    return await handleInboundHook(req, mappingId);
  }

  // Vault job result: /api/vault/jobs/:id/result dynamic route.
  const vaultResultId = matchVaultJobResult(req.path);
  if (vaultResultId !== null) {
    if (req.method !== 'POST') return methodNotAllowed();
    return await handleVaultJobResult(req, vaultResultId);
  }

  // Task action: /api/tasks/:id/{done,feedback,escalate} dynamic routes.
  const taskAction = matchTaskAction(req.path);
  if (taskAction !== null) {
    if (req.method !== 'POST') return methodNotAllowed();
    if (taskAction.action === 'done') return await handleTaskDone(req, taskAction.id);
    if (taskAction.action === 'feedback')
      return await handleTaskFeedback(req, taskAction.id);
    if (taskAction.action === 'escalate')
      return await handleTaskEscalate(req, taskAction.id);
  }

  // Task PATCH: /api/tasks/:id
  const taskId = matchTaskId(req.path);
  if (taskId !== null) {
    if (req.method !== 'PATCH') return methodNotAllowed();
    return await handleTaskPatch(req, taskId);
  }

  // State store: /api/state/:key dynamic routes.
  const stateKey = matchStateKey(req.path);
  if (stateKey !== null) {
    if (req.method === 'GET') return await handleGetState(req, stateKey);
    if (req.method === 'PUT') return await handleSetState(req, stateKey);
    if (req.method === 'DELETE') return await handleDeleteState(req, stateKey);
    return methodNotAllowed();
  }

  // Some paths (e.g. /api/vault/status) accept multiple methods. We resolve
  // path → method-set first so a wrong method on a real path returns 405,
  // while an unknown path returns 404.
  const samePath = STATIC_ROUTES.filter((r) => r.path === req.path);
  if (samePath.length === 0) return notFound();
  const match = samePath.find((r) => r.method === req.method);
  if (!match) return methodNotAllowed();
  return await match.handler(req);
}

/** Convenience for tests: explicitly drop and re-register inbound mappings. */
export function _resetInboundRegistryForTesting(): void {
  inboundRegistry._resetForTesting();
}

/** Re-export for adapters that want to thread context manually. */
export type { CockpitContext };
