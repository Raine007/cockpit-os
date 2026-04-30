/**
 * Router — local vs computer.
 *
 * The decision is small and deterministic on purpose. We can graduate to
 * a smarter policy (token estimates, current Computer queue depth, user
 * preferences) without changing this file's signature.
 */

import { capabilityRegistry } from '../framework/index.js';
import { asCapabilityIntent, intentRegistry } from './intents.js';
import type { Worker } from './types.js';
import type { NewJob } from './types.js';

/** Token threshold above which we always offload. Tunable. */
export const COMPUTER_TOKEN_THRESHOLD = 50_000;

export interface RouteDecision {
  worker: Worker;
  /** Why the router chose this worker. Surfaces in logs and audit. */
  reason: string;
}

export function routeJob(job: NewJob): RouteDecision {
  // Explicit override always wins. Used by tests and webhook ingress.
  if (job.worker) {
    return { worker: job.worker, reason: 'explicit-override' };
  }

  // Tight deadline → keep local; the network round-trip to Computer alone
  // would blow the budget.
  const deadline = job.context?.deadlineAt;
  if (deadline) {
    const msLeft = new Date(deadline).getTime() - Date.now();
    if (msLeft > 0 && msLeft < 30_000) {
      return { worker: 'local', reason: 'tight-deadline' };
    }
  }

  // Capability intents: always local. The point of capabilities is they
  // run in-process against Firestore; offloading them would be silly.
  const capId = asCapabilityIntent(job.intent);
  if (capId) {
    if (!capabilityRegistry.get(capId)) {
      // Unknown capability — still route local; the worker will fail loudly
      // and the dispatcher will mark the job failed with a clear error.
      return { worker: 'local', reason: 'capability-unknown' };
    }
    return { worker: 'local', reason: 'capability-intent' };
  }

  // Compound intent → use its preferred worker.
  const compound = intentRegistry.get(job.intent);
  if (compound) {
    return { worker: compound.preferredWorker, reason: 'compound-intent' };
  }

  // Token-budget heuristic for unregistered intents (e.g. ad-hoc dispatches).
  const tokens = job.context?.estimatedTokens ?? 0;
  if (tokens > COMPUTER_TOKEN_THRESHOLD) {
    return { worker: 'computer', reason: 'token-budget' };
  }

  // Fall back to local. Better to refuse cheaply than silently spend.
  return { worker: 'local', reason: 'default-local' };
}
