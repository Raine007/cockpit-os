/**
 * Phase 6 \u2014 node:http adapter.
 *
 * Wraps the pure router in a Node HTTP server so you can:
 *   - run `cockpit-serve` locally
 *   - drop the same handler into Express (`app.use(toExpress(routeRequest))`)
 *   - host on Cloud Run / Fly.io / a plain VM
 *
 * The adapter does three things and nothing else:
 *   1. Read the body and try to JSON.parse it.
 *   2. Lower-case all header names so the router sees a stable shape.
 *   3. Translate the router's response back into a node:http write.
 *
 * No middleware, no logging frameworks. Logging happens inside the router
 * via the structured logger.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { URL } from 'node:url';

import { logger } from '../context/logger.js';

import { routeRequest } from './router.js';
import type { CockpitHttpRequest, CockpitHttpResponse } from './types.js';

const MAX_BODY_BYTES = 1_000_000; // 1 MB \u2014 webhooks should be tiny.

async function readBody(req: IncomingMessage): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        // Not JSON \u2014 hand the raw string through. The router will reject if
        // it expected a structured payload.
        resolve(raw);
      }
    });
    req.on('error', reject);
  });
}

function lowerHeaders(headers: IncomingMessage['headers']): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (Array.isArray(v)) out[k.toLowerCase()] = v.join(', ');
    else if (v === undefined) out[k.toLowerCase()] = undefined;
    else out[k.toLowerCase()] = v;
  }
  return out;
}

function parseQuery(url: string): { path: string; query: Record<string, string> } {
  const u = new URL(url, 'http://placeholder');
  const query: Record<string, string> = {};
  for (const [k, v] of u.searchParams.entries()) {
    query[k] = v;
  }
  return { path: u.pathname, query };
}

async function toCockpitRequest(req: IncomingMessage): Promise<CockpitHttpRequest> {
  const { path, query } = parseQuery(req.url ?? '/');
  const body = await readBody(req);
  return {
    method: (req.method ?? 'GET').toUpperCase(),
    path,
    headers: lowerHeaders(req.headers),
    body,
    query,
  };
}

function writeResponse(res: ServerResponse, response: CockpitHttpResponse): void {
  for (const [k, v] of Object.entries(response.headers ?? {})) {
    res.setHeader(k, v);
  }
  res.statusCode = response.status;
  if (response.body === undefined || response.body === null) {
    res.end();
    return;
  }
  if (typeof response.body === 'string') {
    res.end(response.body);
    return;
  }
  // JSON: stringify and ensure content-type if not already set.
  if (!res.getHeader('content-type')) {
    res.setHeader('content-type', 'application/json; charset=utf-8');
  }
  res.end(JSON.stringify(response.body));
}

/** Returns a `(req,res)` listener compatible with `http.createServer`. */
export function createNodeListener(): (req: IncomingMessage, res: ServerResponse) => void {
  return async (req, res) => {
    try {
      const cockpitReq = await toCockpitRequest(req);
      const response = await routeRequest(cockpitReq);
      writeResponse(res, response);
    } catch (err) {
      logger.error('http adapter crashed', {
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: false, error: 'internal error' }));
      } catch {
        // socket already closed; nothing to do.
      }
    }
  };
}

export interface StartServerOptions {
  port?: number;
  host?: string;
}

export interface RunningServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

/** Starts a Node HTTP server and resolves when it's listening. */
export async function startCockpitServer(opts: StartServerOptions = {}): Promise<RunningServer> {
  const port = opts.port ?? Number(process.env.PORT ?? 8787);
  const host = opts.host ?? process.env.HOST ?? '0.0.0.0';
  const server = createServer(createNodeListener());
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : port;
  logger.info('cockpit http server listening', { host, port: boundPort });
  return {
    server,
    port: boundPort,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
