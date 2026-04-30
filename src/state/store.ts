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
const VAULT_JOBS_KEY = 'vault_jobs';
const VAULT_STATUS_KEY = 'vault_status';
const TASKS_KEY = 'tasks';

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

/* -------------------------------------------------------------------------- */
/* Vault jobs                                                                  */
/*                                                                             */
/* Pull-based queue: Cockpit OS enqueues a vault job; the OpenClaw bridge      */
/* polls /api/vault/jobs/pending, executes against the local Obsidian vault,   */
/* and posts the result back. Storage is the same Firestore-backed KV store    */
/* as chat — keys: vault_jobs (VaultJob[]), vault_status (VaultStatus).        */
/* -------------------------------------------------------------------------- */

export type VaultJobKind = 'append' | 'read' | 'list' | 'daily-note';
export type VaultJobStatus = 'queued' | 'running' | 'done' | 'error';

export interface VaultJob {
  id: string;
  kind: VaultJobKind;
  /** Job input. Shape depends on kind:
   *  append:     { path: string, text: string }
   *  read:       { path: string }
   *  list:       { folder: string, recursive?: boolean }
   *  daily-note: { text: string, source?: string }
   */
  payload: Record<string, unknown>;
  status: VaultJobStatus;
  /** Bridge populates these fields on completion. */
  result?: unknown;
  error?: string;
  /** True if the bridge ran in dry-run mode (no disk write). */
  dry_run?: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Aggregate dashboard status for the vault subsystem. The bridge updates
 * this on every successful poll/result so the dashboard tile can show
 * "connected" without waiting for a vault job to run.
 */
export interface VaultStatus {
  enabled: boolean;
  dry_run: boolean;
  vault_root?: string;
  /** ISO timestamp of the last bridge heartbeat (poll or result). */
  last_seen?: string;
  /** ISO timestamp of the last successful write (append or daily-note). */
  last_write?: string;
  /** Count of writes that happened today (UTC date). */
  writes_today?: number;
  /** Date (YYYY-MM-DD UTC) the writes_today counter is for. */
  writes_today_date?: string;
  /** Last error reported by the bridge, if any. Cleared on next success. */
  last_error?: string;
}

export async function getVaultJobs(ctx: CockpitContext): Promise<VaultJob[]> {
  const v = await getState(ctx, CHAT_UID, VAULT_JOBS_KEY);
  return Array.isArray(v) ? (v as VaultJob[]) : [];
}

export async function upsertVaultJob(
  ctx: CockpitContext,
  job: VaultJob,
): Promise<void> {
  const jobs = await getVaultJobs(ctx);
  const idx = jobs.findIndex((j) => j.id === job.id);
  if (idx >= 0) {
    jobs[idx] = job;
  } else {
    jobs.push(job);
  }
  await setState(ctx, CHAT_UID, VAULT_JOBS_KEY, jobs);
}

export async function getVaultStatus(
  ctx: CockpitContext,
): Promise<VaultStatus> {
  const v = await getState(ctx, CHAT_UID, VAULT_STATUS_KEY);
  if (v && typeof v === 'object') return v as VaultStatus;
  return { enabled: false, dry_run: true };
}

export async function setVaultStatus(
  ctx: CockpitContext,
  status: VaultStatus,
): Promise<void> {
  await setState(ctx, CHAT_UID, VAULT_STATUS_KEY, status);
}

/* -------------------------------------------------------------------------- */
/* Tasks                                                                       */
/*                                                                             */
/* Vault is source of truth (Tasks/Active.md). The server holds a cache so the */
/* dashboard can render fast without hitting the bridge on every page load.    */
/* The bridge reconciler keeps this cache in sync via                          */
/*   GET  /api/tasks/snapshot  → reads cache                                   */
/*   PUT  /api/tasks/snapshot  → writes cache (last-write-wins applied)        */
/* Storage key: `tasks` (single document containing the whole Task[] array).   */
/* -------------------------------------------------------------------------- */

export type TaskOwner = 'openclaw' | 'claude' | 'raine' | 'perplexity';
export type TaskPriority = 'high' | 'medium-high' | 'low' | null;

export interface TaskFeedback {
  author: string;
  ts: string;
  text: string;
}

export interface TaskEscalation {
  from: string;
  to: string;
  ts: string;
  reason: string;
}

export interface TaskArtifact {
  name: string;
  url: string;
}

export interface Task {
  id: string;
  title: string;
  done: boolean;
  due: string | null;
  completed_on: string | null;
  priority: TaskPriority;
  tags: string[];
  owner: TaskOwner;
  /** ISO timestamp; bumped on every server-side mutation. Used by reconciler. */
  updated_at: string;
  notes: string;
  feedback: TaskFeedback[];
  escalations: TaskEscalation[];
  artifacts: TaskArtifact[];
}

export async function getTasks(ctx: CockpitContext): Promise<Task[]> {
  const v = await getState(ctx, CHAT_UID, TASKS_KEY);
  return Array.isArray(v) ? (v as Task[]) : [];
}

export async function setTasks(
  ctx: CockpitContext,
  tasks: Task[],
): Promise<void> {
  await setState(ctx, CHAT_UID, TASKS_KEY, tasks);
}

export async function upsertTask(
  ctx: CockpitContext,
  task: Task,
): Promise<void> {
  const tasks = await getTasks(ctx);
  const idx = tasks.findIndex((t) => t.id === task.id);
  if (idx >= 0) {
    tasks[idx] = task;
  } else {
    tasks.push(task);
  }
  await setTasks(ctx, tasks);
}

export async function getTaskById(
  ctx: CockpitContext,
  id: string,
): Promise<Task | null> {
  const tasks = await getTasks(ctx);
  return tasks.find((t) => t.id === id) || null;
}
