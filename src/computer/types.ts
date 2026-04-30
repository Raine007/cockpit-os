/**
 * Phase 4 — Computer adapter types.
 *
 * The Computer worker submits a `ComputerTaskRequest` to a Perplexity
 * Computer dispatch endpoint and returns immediately with an
 * `awaiting_input` result. Computer eventually POSTs a
 * `ComputerCallbackPayload` back to /hooks/computer-done (forwarded by
 * the OpenClaw gateway as an inbound mapping). The callback handler
 * matches it to the parked job and resumes it.
 *
 * Both directions are Zod-validated so a misbehaving Computer build
 * can't corrupt the job queue.
 */

import { z } from 'zod';

import { JobArtifactSchema } from '../dispatcher/types.js';

/* -------------------------------------------------------------------------- */
/* Request: Cockpit OS → Computer                                              */
/* -------------------------------------------------------------------------- */

export const ComputerTaskRequestSchema = z.object({
  /** Stable handle for this task; mirrored back in the callback. */
  taskId: z.string().min(1),
  /** Cockpit job id; lets Computer surface it in audit logs. */
  jobId: z.string().min(1),
  /** Cockpit user id. Computer uses this to scope its own state. */
  uid: z.string().min(1),
  /** The intent that produced this task; mirrors job.intent. */
  intent: z.string().min(1),
  /** The job payload, passed through verbatim. */
  payload: z.record(z.string(), z.unknown()).default({}),
  /** Capabilities Computer is allowed to call back into via MCP. */
  capabilities: z.array(z.string()).default([]),
  /** Where Computer should POST results. Includes the gateway base URL. */
  callbackUrl: z.string().url(),
  /** Optional ISO deadline; Computer should give up past this. */
  deadlineAt: z.string().datetime({ offset: true }).optional(),
});
export type ComputerTaskRequest = z.infer<typeof ComputerTaskRequestSchema>;

export const ComputerTaskResponseSchema = z.object({
  ok: z.boolean(),
  /** Computer's own task id; we persist it so we can correlate later. */
  taskId: z.string().min(1).optional(),
  /** When ok=false. */
  error: z.string().optional(),
  /**
   * If true, the request itself is malformed — the engine should mark
   * the job failed without retrying.
   */
  fatal: z.boolean().optional(),
});
export type ComputerTaskResponse = z.infer<typeof ComputerTaskResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Callback: Computer → Cockpit OS (via gateway)                               */
/* -------------------------------------------------------------------------- */

export const ComputerCallbackStatus = z.enum(['done', 'failed']);

export const ComputerCallbackPayloadSchema = z.object({
  /** Task id Cockpit handed Computer at submission. */
  taskId: z.string().min(1),
  /** Job id Cockpit handed Computer; both are checked on resume. */
  jobId: z.string().min(1),
  status: ComputerCallbackStatus,
  /** Free-form output bag (logs, summary, structured data). */
  output: z.unknown().optional(),
  /** Files Computer produced; surfaced in notifications + saved on the job. */
  artifacts: z.array(JobArtifactSchema).default([]),
  /** Set when status='failed'. */
  error: z.string().optional(),
  /** When true, callback handler skips retry even if attempts remain. */
  fatal: z.boolean().optional(),
});
export type ComputerCallbackPayload = z.infer<typeof ComputerCallbackPayloadSchema>;

export interface ComputerCallbackResult {
  ok: boolean;
  /** Cockpit job id the callback resolved. */
  jobId?: string;
  /** Final status the engine moved the job to. */
  finalStatus?: 'done' | 'failed' | 'queued';
  error?: string;
}
