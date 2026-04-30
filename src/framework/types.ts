/**
 * Framework types — kept minimal and stable. Capabilities, MCP, and the SKILL
 * compiler all depend on these; do not break shape without updating all three.
 */

import type { z } from 'zod';
import type { CockpitContext } from '../context/types.js';

/**
 * A capability is the *single source of truth* for one thing Cockpit OS can do.
 * One definition becomes:
 *   - an MCP tool (callable by OpenClaw and remote agents)
 *   - a SKILL.md runbook (callable from OpenClaw chat as a slash command)
 *   - an in-process RPC handler (callable by Cockpit OS itself)
 *
 * Keep handlers pure-ish: read inputs + ctx, return a typed result. No side
 * channels, no globals.
 */
export interface CapabilityDefinition<
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput = unknown,
> {
  /** Stable id, kebab-case. Becomes the MCP tool name and SKILL folder name. */
  readonly id: string;

  /**
   * Short, model-facing description. The LLM uses this to decide when to call.
   * Write it like an API docstring, not marketing.
   */
  readonly description: string;

  /** Optional emoji used in the OpenClaw macOS UI. */
  readonly emoji?: string;

  /** Zod schema for inputs. The MCP tool advertises this as JSON Schema. */
  readonly input: TInput;

  /**
   * Side-effect classification. Used by the dispatcher to decide whether the
   * action needs human approval, can run in parallel, can be retried, etc.
   *
   *  - 'read'    — pure read, idempotent
   *  - 'write'   — creates or modifies state
   *  - 'destroy' — deletes; always requires approval in non-trusted contexts
   *  - 'external'— hits a third party; may have rate limits or cost
   */
  readonly effect: 'read' | 'write' | 'destroy' | 'external';

  /**
   * Whether the LLM is allowed to invoke this without explicit user confirmation.
   * Defaults vary by `effect`: read=true, write=true, destroy=false, external=false.
   * Override only when you really mean it.
   */
  readonly autoInvocable?: boolean;

  /** Tags surface in SKILL.md and help routing. */
  readonly tags?: readonly string[];

  /**
   * The actual work. Receives validated input and a Cockpit context (Firestore,
   * uid, logger, dryRun). Must return a JSON-serializable value.
   */
  readonly handler: (
    input: z.infer<TInput>,
    ctx: CockpitContext,
  ) => Promise<TOutput>;
}

/** Erased version used inside the registry. */
export type AnyCapability = CapabilityDefinition<z.ZodTypeAny, unknown>;

/** Default auto-invocability per effect class. */
export const DEFAULT_AUTO_INVOCABLE: Record<
  CapabilityDefinition['effect'],
  boolean
> = {
  read: true,
  write: true,
  destroy: false,
  external: false,
};
