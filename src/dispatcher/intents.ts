/**
 * Intent registry.
 *
 * An intent is the verb the dispatcher routes on. Two flavors:
 *
 *  1. Capability intents — `cap:<capability-id>`. The local worker resolves
 *     these directly against the capability registry. No registration needed.
 *
 *  2. Compound intents — multi-step work that doesn't map 1:1 to a capability.
 *     E.g. `weekly-review`, `flight-anomaly-report`. These are registered
 *     here with metadata that drives routing (preferred worker, expected
 *     cost, required capabilities).
 *
 * Keeping the two namespaces separate means dropping a new capability never
 * accidentally creates a new compound intent, and vice versa.
 */

export const CAPABILITY_INTENT_PREFIX = 'cap:';

export interface CompoundIntent {
  id: string;
  description: string;
  /**
   * Hard worker preference. The router still has the final say (e.g. a job
   * with deadlineAt < 30s will stay local), but this is the default.
   */
  preferredWorker: 'local' | 'computer';
  /** Capabilities the intent will need at runtime; surfaced for allowlists. */
  requiredCapabilities?: readonly string[];
  /** Tags used by observability and audit. */
  tags?: readonly string[];
}

class IntentRegistry {
  private readonly map = new Map<string, CompoundIntent>();

  register(intent: CompoundIntent): void {
    if (intent.id.startsWith(CAPABILITY_INTENT_PREFIX)) {
      throw new Error(
        `Compound intent id "${intent.id}" must not use the reserved ` +
          `"${CAPABILITY_INTENT_PREFIX}" prefix.`,
      );
    }
    if (this.map.has(intent.id)) {
      throw new Error(`Compound intent "${intent.id}" already registered.`);
    }
    this.map.set(intent.id, intent);
  }

  get(id: string): CompoundIntent | undefined {
    return this.map.get(id);
  }

  list(): CompoundIntent[] {
    return [...this.map.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  _resetForTesting(): void {
    this.map.clear();
  }
}

export const intentRegistry = new IntentRegistry();

/** Convenience helper. */
export function registerIntent(intent: CompoundIntent): CompoundIntent {
  intentRegistry.register(intent);
  return intent;
}

/** Returns the capability id if `intent` is `cap:<id>`, else null. */
export function asCapabilityIntent(intent: string): string | null {
  if (!intent.startsWith(CAPABILITY_INTENT_PREFIX)) return null;
  return intent.slice(CAPABILITY_INTENT_PREFIX.length);
}
