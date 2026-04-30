/**
 * Phase 4 — Computer dispatch client.
 *
 * The HTTP transport is pluggable so tests never hit the network. Production
 * uses `nodeFetchComputerClient` (or omits the parameter entirely; the worker
 * defaults to it).
 *
 * Auth: bearer token from `COMPUTER_API_TOKEN`. Like the OpenClaw hooks
 * token, it's read at module init and never accepted from the caller.
 */

import { logger } from '../context/logger.js';
import {
  ComputerTaskRequestSchema,
  ComputerTaskResponseSchema,
  type ComputerTaskRequest,
  type ComputerTaskResponse,
} from './types.js';

export interface ComputerClient {
  submit(req: ComputerTaskRequest): Promise<ComputerTaskResponse>;
}

export interface ComputerClientConfig {
  /** Base URL of the Computer dispatch API. */
  endpoint: string;
  /** Bearer token; defaults to COMPUTER_API_TOKEN env. */
  token?: string;
  /** Override fetch (mostly for tests that don't want pluggable client). */
  fetchImpl?: typeof fetch;
}

export function createNodeFetchComputerClient(
  config: ComputerClientConfig,
): ComputerClient {
  const token = config.token ?? process.env.COMPUTER_API_TOKEN ?? '';
  const fetchImpl = config.fetchImpl ?? fetch;

  return {
    async submit(req: ComputerTaskRequest): Promise<ComputerTaskResponse> {
      // Validate before we send so a buggy caller fails locally, not over the wire.
      const body = ComputerTaskRequestSchema.parse(req);

      const res = await fetchImpl(config.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });

      const text = await res.text();
      if (!res.ok) {
        // 4xx: Computer rejected the spec. Mark fatal so we don't retry.
        const fatal = res.status >= 400 && res.status < 500;
        logger.warn('computer dispatch rejected', {
          status: res.status,
          fatal,
          taskId: body.taskId,
        });
        return {
          ok: false,
          error: `computer dispatch failed: ${res.status} ${text.slice(0, 200)}`,
          fatal,
        };
      }

      try {
        const parsed = ComputerTaskResponseSchema.parse(JSON.parse(text));
        return parsed;
      } catch (err) {
        // The endpoint returned 2xx but garbage. Treat as non-fatal so a
        // transient deploy mismatch can be retried.
        logger.error('computer dispatch returned malformed response', {
          taskId: body.taskId,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          ok: false,
          error: 'computer dispatch returned malformed response',
        };
      }
    },
  };
}

/**
 * Module-level singleton. The worker uses this when no explicit client is
 * passed. Initialized lazily so tests that never call into Computer don't
 * need the env vars to exist.
 */
let cachedDefaultClient: ComputerClient | null = null;

export function getDefaultComputerClient(): ComputerClient {
  if (cachedDefaultClient) return cachedDefaultClient;
  const endpoint =
    process.env.COMPUTER_DISPATCH_URL ?? 'http://127.0.0.1:18790/dispatch';
  cachedDefaultClient = createNodeFetchComputerClient({ endpoint });
  return cachedDefaultClient;
}

/** Test-only escape hatch. */
export function _setDefaultComputerClientForTesting(
  client: ComputerClient | null,
): void {
  cachedDefaultClient = client;
}
