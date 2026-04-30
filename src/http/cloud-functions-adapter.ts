/**
 * Phase 6 \u2014 Cloud Functions / Express adapter.
 *
 * Google Cloud Functions (gen 2) and Firebase Functions both pass an
 * Express-style `(req, res)` handler. Express itself uses the same shape.
 * This file provides one adapter that works for all three.
 *
 * Usage (Cloud Functions gen 2 with the functions framework):
 *   import { http } from '@google-cloud/functions-framework';
 *   import { cloudFunctionsHandler } from '@cockpit-os/core';
 *   http('cockpit', cloudFunctionsHandler);
 *
 * Usage (Express):
 *   app.use(cloudFunctionsHandler);
 */

import { logger } from '../context/logger.js';

import { routeRequest } from './router.js';
import type { CockpitHttpRequest, CockpitHttpResponse } from './types.js';

/**
 * Minimal Express-compatible request shape we depend on. We avoid taking
 * an Express type dependency so this module compiles without `@types/express`.
 */
interface ExpressLikeRequest {
  method?: string;
  path?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
}

interface ExpressLikeResponse {
  status(code: number): ExpressLikeResponse;
  setHeader(name: string, value: string): void;
  send(body: string): void;
  end(): void;
}

function lowerHeaders(
  headers: ExpressLikeRequest['headers'] | undefined,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  if (!headers) return out;
  for (const [k, v] of Object.entries(headers)) {
    if (Array.isArray(v)) out[k.toLowerCase()] = v.join(', ');
    else if (v === undefined) out[k.toLowerCase()] = undefined;
    else out[k.toLowerCase()] = v;
  }
  return out;
}

function flattenQuery(
  query: ExpressLikeRequest['query'] | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!query) return out;
  for (const [k, v] of Object.entries(query)) {
    if (typeof v === 'string') out[k] = v;
    else if (Array.isArray(v) && typeof v[0] === 'string') out[k] = v[0];
  }
  return out;
}

function pathFromRequest(req: ExpressLikeRequest): string {
  if (typeof req.path === 'string' && req.path.length > 0) return req.path;
  const url = req.url ?? '/';
  const q = url.indexOf('?');
  return q >= 0 ? url.slice(0, q) : url;
}

function toCockpitRequest(req: ExpressLikeRequest): CockpitHttpRequest {
  return {
    method: (req.method ?? 'GET').toUpperCase(),
    path: pathFromRequest(req),
    headers: lowerHeaders(req.headers),
    body: req.body,
    query: flattenQuery(req.query),
  };
}

function writeExpressResponse(
  res: ExpressLikeResponse,
  response: CockpitHttpResponse,
): void {
  for (const [k, v] of Object.entries(response.headers ?? {})) {
    res.setHeader(k, v);
  }
  res.status(response.status);
  if (response.body === undefined || response.body === null) {
    res.end();
    return;
  }
  if (typeof response.body === 'string') {
    res.send(response.body);
    return;
  }
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(response.body));
}

/**
 * Express-style handler. Works under Express, Firebase Functions, and
 * Google Cloud Functions (gen 2 with the functions framework).
 */
export async function cloudFunctionsHandler(
  req: ExpressLikeRequest,
  res: ExpressLikeResponse,
): Promise<void> {
  try {
    const cockpitReq = toCockpitRequest(req);
    const response = await routeRequest(cockpitReq);
    writeExpressResponse(res, response);
  } catch (err) {
    logger.error('cloud-functions adapter crashed', {
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      res.status(500);
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.send(JSON.stringify({ ok: false, error: 'internal error' }));
    } catch {
      // ignore
    }
  }
}
