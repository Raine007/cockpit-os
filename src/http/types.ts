/**
 * Phase 6 — HTTP transport types.
 *
 * Cockpit OS does not bind to any specific HTTP framework. Instead, the
 * router accepts a normalized request shape and returns a normalized
 * response shape. Adapters (node:http, Express, Cloud Functions, Fastify)
 * are thin shims that translate between the framework's request/response
 * objects and these types.
 *
 * That keeps the routing logic pure and trivially testable — every test
 * passes a `CockpitHttpRequest` literal and asserts against the returned
 * `CockpitHttpResponse`.
 */

export interface CockpitHttpRequest {
  /** Uppercase HTTP method, e.g. "POST". */
  method: string;
  /** Path only — no query string, no host. e.g. "/hooks/cockpit-task-due". */
  path: string;
  /** Lowercased header names to values; multi-values joined by ", ". */
  headers: Record<string, string | undefined>;
  /** Already-parsed JSON body, or undefined for non-JSON / no body. */
  body?: unknown;
  /** Raw query-string params (decoded, single-value-only). */
  query?: Record<string, string>;
}

export interface CockpitHttpResponse {
  status: number;
  /** Header names to values. JSON body sets content-type automatically. */
  headers?: Record<string, string>;
  /** Either a JSON value (will be stringified) or a raw string body. */
  body?: unknown;
}

export type CockpitRouteHandler = (
  req: CockpitHttpRequest,
) => Promise<CockpitHttpResponse> | CockpitHttpResponse;

export interface CockpitRoute {
  method: string;
  /** Exact path match. Wildcards are not supported by design — keep it boring. */
  path: string;
  handler: CockpitRouteHandler;
  /** Friendly label, surfaces in the route table on GET /. */
  description?: string;
}
