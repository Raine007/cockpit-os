/**
 * defineCapability — the only way capabilities should be created.
 *
 * - Validates the id at definition time so typos surface during build.
 * - Wraps the handler in a Zod parse so EVERY caller (MCP, RPC, tests, the
 *   dispatcher) sees validated input. Capabilities should never get to
 *   choose whether their inputs are validated.
 */

import type { z } from 'zod';
import type { CapabilityDefinition } from './types.js';

const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function defineCapability<
  TInput extends z.ZodTypeAny,
  TOutput,
>(def: CapabilityDefinition<TInput, TOutput>): CapabilityDefinition<TInput, TOutput> {
  if (!ID_PATTERN.test(def.id)) {
    throw new Error(
      `Invalid capability id "${def.id}". Use kebab-case: lowercase letters, ` +
        `digits, and single hyphens (e.g. "log-flight").`,
    );
  }
  if (!def.description || def.description.trim().length < 10) {
    throw new Error(
      `Capability "${def.id}" needs a descriptive description (≥10 chars). ` +
        `The LLM uses this to decide when to call you.`,
    );
  }

  const userHandler = def.handler;
  return {
    ...def,
    handler: async (input, ctx) => {
      // Always validate. parse() throws on failure, which is what we want.
      const parsed = def.input.parse(input) as z.infer<TInput>;
      return userHandler(parsed, ctx);
    },
  };
}
