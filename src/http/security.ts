/**
 * Phase 6.1 — production hardening primitives.
 *
 * Pure functions only. No I/O, no node:http coupling. Each adapter wires
 * these into its request pipeline.
 *
 * Provides:
 *   - admin token check (separate from inbound hooks token)
 *   - in-memory token-bucket rate limiter
 *   - default security headers
 *   - error normalization (no stack leaks to clients)
 *   - request-ID generation
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';

import type { CockpitHttpRequest, CockpitHttpResponse } from './types.js';

/* -------------------------------------------------------------------------- */
/* Admin auth                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Admin-only routes (`/api/identities*`, `/api/dashboard/*`) check
 * `COCKPIT_ADMIN_TOKEN` first; if unset, they fall back to
 * `OPENCLAW_HOOKS_TOKEN` so single-secret deployments still work. Production
 * deployments should set both for defence in depth.
 */
export function checkAdminAuth(authHeader: string | undefined): boolean {
  const adminToken = process.env.COCKPIT_ADMIN_TOKEN;
  const hooksToken = process.env.OPENCLAW_HOOKS_TOKEN;
  const expected = adminToken && adminToken.length > 0 ? adminToken : hooksToken ?? '';
  if (!expected) return false; // closed by default
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) return false;
  const provided = authHeader.slice('bearer '.length).trim();
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/* -------------------------------------------------------------------------- */
/* Rate limiting (token bucket, per key)                                       */
/* -------------------------------------------------------------------------- */

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export interface RateLimitConfig {
  /** Max tokens (burst capacity). */
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the next token is available. 0 if allowed. */
  retryAfterSeconds: number;
  /** Tokens remaining after this decision. */
  remaining: number;
}

/**
 * In-memory token-bucket rate limiter. Fine for single-process Cloud Run /
 * Functions instances; for multi-instance deployments behind a load balancer,
 * the limiter applies per instance — set `RATELIMIT_DISABLED=1` and use the
 * platform's native rate limiting instead.
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  /** Maximum number of distinct keys we'll track. Beyond this we evict oldest. */
  private readonly maxKeys: number;

  constructor(cfg: RateLimitConfig, maxKeys = 10_000) {
    if (cfg.capacity <= 0) throw new Error('capacity must be > 0');
    if (cfg.refillPerSecond <= 0) throw new Error('refillPerSecond must be > 0');
    this.capacity = cfg.capacity;
    this.refillPerSecond = cfg.refillPerSecond;
    this.maxKeys = maxKeys;
  }

  check(key: string, nowMs = Date.now()): RateLimitDecision {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) {
        // Evict an arbitrary key (Map iteration order = insertion order).
        const first = this.buckets.keys().next();
        if (!first.done) this.buckets.delete(first.value);
      }
      bucket = { tokens: this.capacity, lastRefillMs: nowMs };
      this.buckets.set(key, bucket);
    }
    // Refill.
    const elapsedSec = Math.max(0, (nowMs - bucket.lastRefillMs) / 1000);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSec * this.refillPerSecond);
    bucket.lastRefillMs = nowMs;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterSeconds: 0, remaining: Math.floor(bucket.tokens) };
    }
    const deficit = 1 - bucket.tokens;
    const retryAfterSeconds = Math.ceil(deficit / this.refillPerSecond);
    return { allowed: false, retryAfterSeconds, remaining: 0 };
  }

  /** For tests. */
  _resetForTesting(): void {
    this.buckets.clear();
  }

  /** For tests/observability. */
  size(): number {
    return this.buckets.size;
  }
}

/**
 * Pull a stable client identifier from headers. Prefers the upstream
 * load balancer header, falls back to `x-real-ip`, then the literal "anon".
 *
 * Cloud Run sets `x-forwarded-for` with a trustworthy chain; we take the
 * left-most entry (the original client). On bare Node deployments this
 * header is empty and everyone shares the "anon" bucket — that's a feature,
 * because rate limiting is still useful as a global brake.
 */
export function clientKey(req: CockpitHttpRequest): string {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = req.headers['x-real-ip'];
  if (real) return real;
  return 'anon';
}

/* -------------------------------------------------------------------------- */
/* Default rate-limit configs                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Reads rate-limit config from env, with sensible defaults.
 *
 *   COCKPIT_RATELIMIT_HOOKS_RPM      (default 600 = 10/sec)
 *   COCKPIT_RATELIMIT_HOOKS_BURST    (default 30)
 *   COCKPIT_RATELIMIT_API_RPM        (default 300 = 5/sec)
 *   COCKPIT_RATELIMIT_API_BURST      (default 20)
 *   COCKPIT_RATELIMIT_DISABLED=1     disables the limiter entirely.
 */
export function rateLimitConfigFromEnv(): {
  enabled: boolean;
  hooks: RateLimitConfig;
  api: RateLimitConfig;
} {
  const enabled = process.env.COCKPIT_RATELIMIT_DISABLED !== '1';
  const num = (k: string, fallback: number): number => {
    const raw = process.env[k];
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    enabled,
    hooks: {
      capacity: num('COCKPIT_RATELIMIT_HOOKS_BURST', 30),
      refillPerSecond: num('COCKPIT_RATELIMIT_HOOKS_RPM', 600) / 60,
    },
    api: {
      capacity: num('COCKPIT_RATELIMIT_API_BURST', 20),
      refillPerSecond: num('COCKPIT_RATELIMIT_API_RPM', 300) / 60,
    },
  };
}

export function rateLimitedResponse(decision: RateLimitDecision): CockpitHttpResponse {
  return {
    status: 429,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'retry-after': String(decision.retryAfterSeconds),
    },
    body: { ok: false, error: 'rate limit exceeded', retryAfterSeconds: decision.retryAfterSeconds },
  };
}

/* -------------------------------------------------------------------------- */
/* Security headers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Default security headers applied to every response.
 *
 * CSP notes:
 * - The dashboard ships inline <style> and <script> blocks (no separate CSS/JS
 *   build artifacts), so 'unsafe-inline' is required for style-src and
 *   script-src. This is acceptable here because the dashboard is admin-only
 *   (token-gated API), the HTML is server-rendered from our own template,
 *   and there is no untrusted user content reflected into the page.
 * - Google Fonts is allowlisted (fonts.googleapis.com for the stylesheet,
 *   fonts.gstatic.com for the actual woff2 files) because the dashboard uses
 *   DM Sans / DM Mono. Remove these if you self-host the fonts.
 * - Override the entire CSP via the COCKPIT_CSP env var if you embed Cockpit
 *   OS elsewhere or want to lock it down further.
 */
export function defaultSecurityHeaders(): Record<string, string> {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
    'content-security-policy':
      process.env.COCKPIT_CSP ??
      [
        "default-src 'self'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "script-src 'self' 'unsafe-inline'",
        "font-src 'self' https://fonts.gstatic.com data:",
        "connect-src 'self'",
        "img-src 'self' data:",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
  };
}

/** Merge security headers into a response without overwriting explicit ones. */
export function withSecurityHeaders(response: CockpitHttpResponse): CockpitHttpResponse {
  const sec = defaultSecurityHeaders();
  const merged: Record<string, string> = { ...sec, ...(response.headers ?? {}) };
  return { ...response, headers: merged };
}

/* -------------------------------------------------------------------------- */
/* Request ID                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Returns a stable request ID. Honors the upstream `x-request-id` header
 * if present (so distributed traces line up), otherwise mints a fresh UUID.
 */
export function requestIdFor(req: CockpitHttpRequest): string {
  const upstream = req.headers['x-request-id'];
  if (upstream && upstream.length <= 200 && /^[a-zA-Z0-9._\-:]+$/.test(upstream)) {
    return upstream;
  }
  return randomUUID();
}

/* -------------------------------------------------------------------------- */
/* Error normalization                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Normalize a thrown error into a 500 response. Never leaks the raw error
 * message or stack to the client — the full detail goes to the logger.
 */
export function internalErrorResponse(requestId: string): CockpitHttpResponse {
  return {
    status: 500,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: { ok: false, error: 'internal error', requestId },
  };
}
