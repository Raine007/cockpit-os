/**
 * CapabilityRegistry — the central lookup table.
 *
 * Capabilities register themselves at module-load time; the MCP server, the
 * SKILL compiler, and the dispatcher all read from the same registry. There
 * is intentionally only one registry; if you need scoping, do it via tags or
 * an allowlist filter, not multiple registries.
 */

import type { AnyCapability } from './types.js';

class CapabilityRegistry {
  private readonly map = new Map<string, AnyCapability>();

  register(cap: AnyCapability): void {
    if (this.map.has(cap.id)) {
      throw new Error(
        `Capability "${cap.id}" is already registered. ` +
          `Each capability id must be unique across the whole project.`,
      );
    }
    this.map.set(cap.id, cap);
  }

  get(id: string): AnyCapability | undefined {
    return this.map.get(id);
  }

  list(): AnyCapability[] {
    return [...this.map.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Filter by tag — used by per-agent allowlists. */
  byTag(tag: string): AnyCapability[] {
    return this.list().filter((c) => c.tags?.includes(tag));
  }

  /** Reset — only for tests. */
  _resetForTesting(): void {
    this.map.clear();
  }
}

export const capabilityRegistry = new CapabilityRegistry();

/** Convenience: register and return the same capability. */
export function register<T extends AnyCapability>(cap: T): T {
  capabilityRegistry.register(cap);
  return cap;
}
