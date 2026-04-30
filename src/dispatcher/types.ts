/**
 * Job types — the contract between the dispatcher, the workers, and Firestore.
 *
 * Keep this stable. Adding a new field is fine; renaming or removing one
 * breaks every queued job in flight, and webhooks in Phase 3 will inspect
 * these shapes too.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Status & worker enums                                                       */
/* -------------------------------------------------------------------------- */

export const JOB_STATUSES = [
  'queued',
  'claimed',
  'running',
  'awaiting_input',
  'done',
  'failed',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const WORKERS = ['local', 'computer'] as const;
export type Worker = (typeof WORKERS)[number];

/* -------------------------------------------------------------------------- */
/* Schema                                                                      */
/* -------------------------------------------------------------------------- */

export const JobArtifactSchema = z.object({
  kind: z.string().min(1),
  url: z.string().url(),
  label: z.string().optional(),
});
export type JobArtifact = z.infer<typeof JobArtifactSchema>;

export const JobDeliverySchema = z.object({
  channel: z.enum(['imessage', 'telegram', 'whatsapp', 'slack', 'discord', 'push', 'silent']),
  to: z.string().min(1),
  /** Optional template id; renderer in Phase 3 picks the right format. */
  template: z.string().optional(),
});
export type JobDelivery = z.infer<typeof JobDeliverySchema>;

/**
 * The intent is the verb. The dispatcher's router maps intent → worker.
 * We deliberately keep payload typing loose at the queue level; each intent
 * handler validates its own payload via Zod.
 */
export const CockpitJobSchema = z.object({
  id: z.string().min(1),
  uid: z.string().min(1),
  intent: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),

  worker: z.enum(WORKERS),
  status: z.enum(JOB_STATUSES),

  /** Monotonic counter; bumped on every status transition for optimistic locking. */
  version: z.number().int().nonnegative().default(0),

  artifacts: z.array(JobArtifactSchema).default([]),
  deliver: JobDeliverySchema.optional(),

  /** Optional bag for the router and workers; survives across retries. */
  context: z
    .object({
      capabilities: z.array(z.string()).optional(),
      memoryKeys: z.array(z.string()).optional(),
      estimatedTokens: z.number().int().nonnegative().optional(),
      deadlineAt: z.string().datetime({ offset: true }).optional(),
    })
    .default({}),

  /** Retry / lifecycle bookkeeping. */
  attempts: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().min(1).default(3),
  lastError: z.string().nullable().default(null),

  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  /** Set when the job entered a terminal state. */
  finishedAt: z.string().datetime({ offset: true }).nullable().default(null),

  /** Source that submitted the job; useful for audit and routing nudges. */
  source: z.enum(['openclaw', 'webhook', 'cron', 'rpc', 'test']),

  /**
   * Set by async workers (Computer) when the job is parked in `awaiting_input`.
   * The callback handler verifies its inbound payload matches this id before
   * resuming, so a stray /hooks/computer-done can't poison an unrelated job.
   */
  externalTaskId: z.string().nullable().default(null),
});
export type CockpitJob = z.infer<typeof CockpitJobSchema>;

/** Input for creating a job — most fields are filled in by the queue. */
export const NewJobSchema = z.object({
  uid: z.string().min(1),
  intent: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).optional(),
  source: CockpitJobSchema.shape.source,
  deliver: JobDeliverySchema.optional(),
  context: CockpitJobSchema.shape.context.optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  /** Override worker selection. Almost never set by hand. */
  worker: z.enum(WORKERS).optional(),
});
export type NewJob = z.infer<typeof NewJobSchema>;

/** Result returned by a worker for a single attempt. */
export interface WorkerResult {
  ok: boolean;
  output?: unknown;
  artifacts?: JobArtifact[];
  error?: string;
  /** When true, the dispatcher will not retry even if attempts < maxAttempts. */
  fatal?: boolean;
  /**
   * The worker accepted the job but execution is asynchronous. The engine
   * will park the job in `awaiting_input` and rely on an external callback
   * (e.g. `/hooks/computer-done`) to resume it. When `awaitingInput` is true,
   * `ok` and `error` are ignored.
   */
  awaitingInput?: boolean;
  /**
   * Optional handle the async worker hands back so the callback can correlate
   * its response. Persisted on the job so the callback handler can verify it.
   */
  externalTaskId?: string;
}

export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set([
  'done',
  'failed',
  'cancelled',
]);
