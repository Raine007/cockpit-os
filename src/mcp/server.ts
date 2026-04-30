#!/usr/bin/env node
/**
 * Cockpit OS MCP server.
 *
 * Exposes every registered capability as an MCP tool over stdio. OpenClaw
 * connects to this via `openclaw mcp set cockpit ...` and lists each
 * capability as a callable tool.
 *
 * The same server can be reused by other MCP clients (Perplexity Computer,
 * Claude Desktop, Codex, etc.) — that is the point of having one source of
 * truth for capabilities.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Importing the barrel triggers capability registration.
import '../capabilities/index.js';
import { capabilityRegistry } from '../framework/index.js';
import type { AnyCapability } from '../framework/index.js';
import { createContext } from '../context/index.js';
import { logger } from '../context/logger.js';

const SERVER_NAME = 'cockpit-os';
const SERVER_VERSION = '0.1.0';

/**
 * Resolve the uid the call is acting on behalf of.
 *
 * MCP doesn't carry user identity per request natively. Cockpit OS embeds
 * uid via the COCKPIT_UID env var (set by OpenClaw per-agent or by Cockpit
 * OS when it spawns the MCP child). For multi-tenant servers, switch this
 * to a token-validation scheme.
 */
function resolveUid(): string {
  return process.env.COCKPIT_UID ?? 'system';
}

/**
 * Convert a capability's Zod object schema into the raw shape MCP expects.
 * We require capabilities to use z.object() at the top level so the MCP
 * tool advertises a real input schema.
 */
function toRawShape(cap: AnyCapability): z.ZodRawShape {
  const schema = cap.input;
  if (!(schema instanceof z.ZodObject)) {
    throw new Error(
      `Capability "${cap.id}" must use z.object() at the top level so MCP can ` +
        `advertise a structured input schema. Got: ${schema.constructor.name}`,
    );
  }
  return schema.shape as z.ZodRawShape;
}

function registerCapabilityAsTool(server: McpServer, cap: AnyCapability): void {
  const shape = toRawShape(cap);

  server.registerTool(
    cap.id,
    {
      description: cap.description,
      inputSchema: shape,
      annotations: {
        title: cap.id,
        readOnlyHint: cap.effect === 'read',
        destructiveHint: cap.effect === 'destroy',
        idempotentHint: cap.effect === 'read',
        openWorldHint: cap.effect === 'external',
      },
    },
    async (args) => {
      // Re-validate even though MCP already did, so the handler always sees
      // a fully-typed value (transforms etc. apply).
      const parsed = cap.input.parse(args);
      const ctx = createContext({ uid: resolveUid(), source: 'mcp' });

      try {
        const result = await cap.handler(parsed, ctx);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.log.error('capability failed', { id: cap.id, error: message });
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Capability "${cap.id}" failed: ${message}`,
            },
          ],
        };
      }
    },
  );
}

export async function main(): Promise<void> {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  const caps = capabilityRegistry.list();
  for (const cap of caps) {
    registerCapabilityAsTool(server, cap);
  }

  logger.info('cockpit-os MCP server starting', {
    capabilities: caps.map((c) => c.id),
    uid: resolveUid(),
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('/server.ts') ||
  process.argv[1]?.endsWith('/server.js');

if (isDirectRun) {
  main().catch((err) => {
    logger.error('mcp server crashed', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}
