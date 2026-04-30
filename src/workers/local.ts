/**
 * Local worker. Executes capability intents against the in-process
 * capability registry. Compound intents are out of scope here; they will
 * land in a future phase that supports multi-step orchestrators.
 *
 * Returning fatal=true tells the dispatcher to skip retries — used for
 * non-recoverable failures like an unknown capability or schema-invalid
 * payload, where retrying is pure waste.
 */

import { capabilityRegistry } from '../framework/index.js';
import {
  asCapabilityIntent,
  intentRegistry,
} from '../dispatcher/intents.js';
import type { CockpitJob, WorkerResult } from '../dispatcher/types.js';
import type { CockpitContext } from '../context/types.js';
import type { CockpitWorker } from './types.js';

export const localWorker: CockpitWorker = {
  id: 'local',

  async run(job: CockpitJob, ctx: CockpitContext): Promise<WorkerResult> {
    // Capability intent: dispatch to the capability handler.
    const capId = asCapabilityIntent(job.intent);
    if (capId) {
      const cap = capabilityRegistry.get(capId);
      if (!cap) {
        return {
          ok: false,
          error: `unknown capability "${capId}"`,
          fatal: true,
        };
      }
      try {
        const output = await cap.handler(job.payload, ctx);
        return { ok: true, output };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Validation errors are fatal — they will fail the same way next time.
        const fatal = err instanceof Error && err.name === 'ZodError';
        return { ok: false, error: message, fatal };
      }
    }

    // Compound intents are not yet executable locally.
    const compound = intentRegistry.get(job.intent);
    if (compound) {
      return {
        ok: false,
        error:
          `compound intent "${job.intent}" has no local executor yet; ` +
          `route to computer or register a local orchestrator.`,
        fatal: true,
      };
    }

    return {
      ok: false,
      error: `unknown intent "${job.intent}"`,
      fatal: true,
    };
  },
};
