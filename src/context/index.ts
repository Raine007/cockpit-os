/**
 * Context factory — produces a fresh CockpitContext per call. Capability
 * handlers should never share context across invocations.
 */

import { getFirebase } from './firebase.js';
import { logger } from './logger.js';
import type { CockpitContext } from './types.js';

export interface CreateContextOptions {
  uid: string;
  source: CockpitContext['source'];
  /** Override dryRun. Defaults to whatever the Firebase env decided. */
  dryRun?: boolean;
}

export function createContext(opts: CreateContextOptions): CockpitContext {
  const { db, dryRun: envDryRun } = getFirebase();
  return {
    uid: opts.uid,
    db,
    dryRun: opts.dryRun ?? envDryRun,
    log: logger,
    startedAt: new Date().toISOString(),
    source: opts.source,
  };
}

export type { CockpitContext, Logger } from './types.js';
