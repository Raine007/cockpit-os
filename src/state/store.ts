/**
 * User state store — Firestore-backed key-value store scoped per-user.
 *
 * Collection: `user_state`
 * Document ID: sanitized storage key (with uid prefix to avoid collisions).
 * Fields: { uid, key, value, updatedAt }
 *
 * This backs the /api/state/* endpoints so the Cockpit UI can persist
 * arbitrary state through the backend instead of a public Firebase RTDB.
 */

import type { CockpitContext } from '../context/types.js';

const COLLECTION = 'user_state';

/** Sanitize a key so it's safe as a Firestore document ID. */
function docId(uid: string, key: string): string {
  // Replace characters that Firestore disallows in document IDs with underscores.
  const safeUid = uid.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeKey = key.replace(/[^a-zA-Z0-9_.\-]/g, '_');
  return `${safeUid}__${safeKey}`;
}

interface StateDoc {
  uid: string;
  key: string;
  value: unknown;
  updatedAt: string;
}

export async function getAllState(
  ctx: CockpitContext,
  uid: string,
): Promise<Record<string, unknown>> {
  const snap = await ctx.db.collection(COLLECTION).get();
  const result: Record<string, unknown> = {};
  for (const doc of snap.docs) {
    const data = doc.data() as StateDoc | undefined;
    if (!data || data.uid !== uid) continue;
    result[data.key] = data.value;
  }
  return result;
}

export async function getState(
  ctx: CockpitContext,
  uid: string,
  key: string,
): Promise<unknown | null> {
  const snap = await ctx.db.collection(COLLECTION).doc(docId(uid, key)).get();
  if (!snap.exists) return null;
  const data = snap.data() as StateDoc | undefined;
  if (!data || data.uid !== uid) return null;
  return data.value;
}

export async function setState(
  ctx: CockpitContext,
  uid: string,
  key: string,
  value: unknown,
): Promise<void> {
  const doc: StateDoc = {
    uid,
    key,
    value,
    updatedAt: new Date().toISOString(),
  };
  await ctx.db.collection(COLLECTION).doc(docId(uid, key)).set(doc as unknown as Record<string, unknown>);
}

export async function deleteState(
  ctx: CockpitContext,
  uid: string,
  key: string,
): Promise<void> {
  await ctx.db.collection(COLLECTION).doc(docId(uid, key)).delete();
}

/* -------------------------------------------------------------------------- */
/* Chat / feedback typed helpers                                               */
/*                                                                             */
/* These use the same Firestore-backed KV store, with well-known keys:        */
/*   chat_messages     — ChatMessage[]                                         */
/*   pending_jobs      — PendingJob[]                                          */
/*   feedback_requests — FeedbackRequest[]                                     */
/* -------------------------------------------------------------------------- */

export interface ChatMessage {
  id: string;
  text: string;
  role: 'user' | 'assistant' | 'computer';
  ts: string;
  message_id?: string;      // links a reply back to the original
  task_created?: { todoist_id: string; project: string };
  context_tab?: 'today' | 'money' | 'flight';
  tab_context?: unknown;
}

export interface PendingJob {
  id: string;
  kind: 'chat';
  message_id: string;
  status: 'queued' | 'done' | 'escalated_to_computer';
  created_at: string;
  updated_at: string;
  // extra context attached on escalation or when feedback answer is appended
  reason?: string;
  task_payload?: unknown;
  feedback_answer?: string;
  context_tab?: 'today' | 'money' | 'flight';
  tab_context?: unknown;
}

export interface FeedbackRequest {
  id: string;
  message_id: string;
  question: string;
  answer?: string;
  resolved: boolean;
  created_at: string;
  updated_at: string;
}

const CHAT_UID = 'system';
const CHAT_MESSAGES_KEY = 'chat_messages';
const PENDING_JOBS_KEY = 'pending_jobs';
const FEEDBACK_REQUESTS_KEY = 'feedback_requests';

/* ── chat_messages ── */

export async function getChatMessages(
  ctx: CockpitContext,
): Promise<ChatMessage[]> {
  const v = await getState(ctx, CHAT_UID, CHAT_MESSAGES_KEY);
  return Array.isArray(v) ? (v as ChatMessage[]) : [];
}

export async function appendChatMessage(
  ctx: CockpitContext,
  msg: ChatMessage,
): Promise<void> {
  const msgs = await getChatMessages(ctx);
  msgs.push(msg);
  await setState(ctx, CHAT_UID, CHAT_MESSAGES_KEY, msgs);
}

/* ── pending_jobs ── */

export async function getPendingJobs(
  ctx: CockpitContext,
): Promise<PendingJob[]> {
  const v = await getState(ctx, CHAT_UID, PENDING_JOBS_KEY);
  return Array.isArray(v) ? (v as PendingJob[]) : [];
}

export async function upsertPendingJob(
  ctx: CockpitContext,
  job: PendingJob,
): Promise<void> {
  const jobs = await getPendingJobs(ctx);
  const idx = jobs.findIndex((j) => j.id === job.id);
  if (idx >= 0) {
    jobs[idx] = job;
  } else {
    jobs.push(job);
  }
  await setState(ctx, CHAT_UID, PENDING_JOBS_KEY, jobs);
}

/* ── feedback_requests ── */

export async function getFeedbackRequests(
  ctx: CockpitContext,
): Promise<FeedbackRequest[]> {
  const v = await getState(ctx, CHAT_UID, FEEDBACK_REQUESTS_KEY);
  return Array.isArray(v) ? (v as FeedbackRequest[]) : [];
}

export async function upsertFeedbackRequest(
  ctx: CockpitContext,
  req: FeedbackRequest,
): Promise<void> {
  const reqs = await getFeedbackRequests(ctx);
  const idx = reqs.findIndex((r) => r.id === req.id);
  if (idx >= 0) {
    reqs[idx] = req;
  } else {
    reqs.push(req);
  }
  await setState(ctx, CHAT_UID, FEEDBACK_REQUESTS_KEY, reqs);
}
