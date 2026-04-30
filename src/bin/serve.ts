#!/usr/bin/env node
/**
 * `cockpit-serve` \u2014 local dev server.
 *
 * Boots the HTTP transport with the seed inbound mappings registered.
 * Listens on $PORT (default 8787). Auth still requires
 * $OPENCLAW_HOOKS_TOKEN to be set; the server refuses to start without it
 * unless $COCKPIT_ALLOW_NO_TOKEN=1 is also set (dev override only).
 */

import { logger } from '../context/logger.js';
import { registerSeedMappings } from '../webhooks/seed-mappings.js';
import { startCockpitServer } from '../http/node-adapter.js';
import { listRoutes } from '../http/router.js';

async function main(): Promise<void> {
  const haveToken = !!process.env.OPENCLAW_HOOKS_TOKEN;
  const allowNoToken = process.env.COCKPIT_ALLOW_NO_TOKEN === '1';
  if (!haveToken && !allowNoToken) {
    process.stderr.write(
      'cockpit-serve: refusing to start without OPENCLAW_HOOKS_TOKEN.\n' +
        '  set COCKPIT_ALLOW_NO_TOKEN=1 to override for local-only dev.\n',
    );
    process.exit(2);
  }

  const seeded = registerSeedMappings();
  logger.info('cockpit-serve: registered seed mappings', {
    count: seeded.length,
    ids: seeded.map((m) => m.id),
  });

  const portEnv = process.env.PORT;
  const opts = portEnv ? { port: Number(portEnv) } : {};
  const running = await startCockpitServer(opts);

  const adminTokenSet = !!process.env.COCKPIT_ADMIN_TOKEN;
  const banner = [
    '',
    `  cockpit-os http listening on :${running.port}`,
    `  ${seeded.length} seed mappings registered`,
    `  ${listRoutes().length} routes`,
    `  dashboard:  http://127.0.0.1:${running.port}/`,
    `  health:     http://127.0.0.1:${running.port}/_health  (also /healthz)`,
    `  ready:      http://127.0.0.1:${running.port}/readyz`,
    `  hooks:      POST /hooks/cockpit-:mappingId  (Bearer OPENCLAW_HOOKS_TOKEN)`,
    `  admin:      ${adminTokenSet ? 'COCKPIT_ADMIN_TOKEN set (recommended)' : 'using OPENCLAW_HOOKS_TOKEN \u2014 set COCKPIT_ADMIN_TOKEN to split admin auth'}`,
    haveToken ? '' : '  WARNING: running without OPENCLAW_HOOKS_TOKEN \u2014 all writes will 401.',
    '',
  ]
    .filter((line) => line !== undefined)
    .join('\n');
  process.stderr.write(banner + '\n');

  const shutdown = (signal: string) => {
    logger.info('cockpit-serve: shutting down', { signal });
    running.close().then(
      () => process.exit(0),
      (err: unknown) => {
        logger.error('cockpit-serve: close failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  process.stderr.write(
    `cockpit-serve: fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
