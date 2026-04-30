/**
 * CockpitContext — what every capability handler receives.
 *
 * Always pass the context through; never reach for a global Firestore client
 * inside a handler. That keeps handlers testable and lets the dispatcher
 * inject a dry-run or authenticated-as-someone-else variant cleanly.
 */

import type { Firestore } from 'firebase-admin/firestore';

export interface CockpitContext {
  /** User the action runs on behalf of. 'system' for cron / webhook events. */
  readonly uid: string;

  /** Firestore handle. Always present; in dry-run mode writes are intercepted. */
  readonly db: Firestore;

  /**
   * When true, capabilities should plan but not commit. Useful for:
   *   - skill testing under OpenClaw without polluting Firestore
   *   - CI smoke tests
   *   - "what would happen if" previews from the dispatcher
   *
   * Capabilities are responsible for honoring this — read paths can ignore it,
   * write paths must check it before calling .add()/.set()/.delete().
   */
  readonly dryRun: boolean;

  /** Structured logger; writes to stderr to keep stdout clean for MCP. */
  readonly log: Logger;

  /** ISO timestamp of when the call started. Useful for audit + idempotency. */
  readonly startedAt: string;

  /** Source that triggered this call — surfaces in audit logs. */
  readonly source: 'mcp' | 'rpc' | 'webhook' | 'cron' | 'test';
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}
