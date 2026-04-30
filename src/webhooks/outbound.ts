/**
 * Outbound webhook client — POSTs to OpenClaw's /hooks/cockpit-* endpoint.
 *
 * The HTTP transport is pluggable so tests can swap a fake without touching
 * the global `fetch`. Production passes `nodeFetchClient` (or omits it,
 * since that's the default).
 *
 * Auth: shared bearer token, configured at supervisor render time and on
 * the gateway side. We never accept a token from the caller; it's read
 * from env at module init.
 */

import { logger } from '../context/logger.js';
import type { OutboundDelivery } from '../notifications/types.js';

export interface OutboundClient {
  post(url: string, payload: unknown): Promise<OutboundResponse>;
}

export interface OutboundResponse {
  ok: boolean;
  status: number;
  body: string;
}

export const nodeFetchClient: OutboundClient = {
  async post(url, payload) {
    const token = process.env.OPENCLAW_HOOKS_TOKEN ?? '';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  },
};

export interface DispatchOptions {
  /** Base URL of the OpenClaw gateway, e.g. http://127.0.0.1:18789 */
  gatewayBaseUrl: string;
  /** Mapping path under /hooks; e.g. "cockpit-notify". */
  mappingPath: string;
  /** Max attempts on transient (5xx, network) failures. Default: 3. */
  maxAttempts?: number;
  /** Backoff for retries in ms. */
  backoffMs?: readonly number[];
}

const DEFAULT_BACKOFF = [200, 800, 2_000];

export async function dispatchOutbound(
  delivery: OutboundDelivery,
  opts: DispatchOptions,
  client: OutboundClient = nodeFetchClient,
): Promise<{ ok: boolean; attempts: number; lastStatus?: number; lastError?: string }> {
  const url = `${opts.gatewayBaseUrl.replace(/\/$/, '')}/hooks/${opts.mappingPath}`;
  const maxAttempts = opts.maxAttempts ?? 3;
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF;

  let attempt = 0;
  let lastStatus: number | undefined;
  let lastError: string | undefined;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const res = await client.post(url, delivery);
      lastStatus = res.status;
      if (res.ok) {
        logger.info('outbound delivered', { url, status: res.status, attempt });
        return { ok: true, attempts: attempt, lastStatus };
      }
      // 4xx is fatal — retrying won't help.
      if (res.status >= 400 && res.status < 500) {
        const out: { ok: false; attempts: number; lastStatus: number; lastError: string } = {
          ok: false,
          attempts: attempt,
          lastStatus: res.status,
          lastError: `gateway rejected: ${res.status} ${res.body.slice(0, 200)}`,
        };
        logger.warn('outbound rejected', out);
        return out;
      }
      lastError = `gateway error: ${res.status} ${res.body.slice(0, 200)}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    if (attempt < maxAttempts) {
      const delay = backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 1_000;
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  logger.error('outbound exhausted retries', {
    url,
    attempts: attempt,
    lastStatus,
    lastError,
  });
  return {
    ok: false,
    attempts: attempt,
    ...(lastStatus !== undefined && { lastStatus }),
    ...(lastError !== undefined && { lastError }),
  };
}
