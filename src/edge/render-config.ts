/**
 * Render the openclaw.json the gateway will load.
 *
 * Single function, no IO. The supervisor calls this then writes the result
 * to disk. Keeping it pure makes the config trivially snapshot-testable.
 */

import { capabilityRegistry } from '../framework/index.js';
import { inboundRegistry } from '../webhooks/inbound.js';

export interface RenderConfigInput {
  /** Where the supervisor will mount Cockpit OS skills. Becomes a SKILL load path. */
  workspaceDir: string;
  /** Path to the compiled MCP server js file. */
  mcpServerPath: string;
  /** uid the MCP server should act on behalf of. Set per Cockpit OS user. */
  cockpitUid: string;
  /** Optional Firebase service-account path. Omitted → MCP runs dry-run. */
  googleApplicationCredentials?: string;
  /** Hooks token for the inbound /hooks endpoint. Required for Phase 3. */
  hooksToken?: string;
  /** Optional gateway port override. */
  port?: number;
}

export interface OpenclawConfigDocument {
  $schema?: string;
  skills: {
    load: {
      watch: boolean;
      extraDirs: string[];
    };
  };
  mcp: {
    servers: Record<
      string,
      {
        enabled: boolean;
        command: string;
        args: string[];
        env: Record<string, string>;
      }
    >;
  };
  hooks?: {
    enabled: boolean;
    path: string;
    token: string;
    mappings: Array<{
      id: string;
      match: { path: string };
      action: 'agent' | 'wake';
      name?: string;
      messageTemplate?: string;
    }>;
  };
  gateway?: { port: number };
  /** Cockpit OS metadata; OpenClaw ignores unknown keys. */
  cockpitOs: {
    version: number;
    capabilities: string[];
    renderedAt: string;
  };
}

export function renderOpenclawConfig(input: RenderConfigInput): OpenclawConfigDocument {
  const env: Record<string, string> = { COCKPIT_UID: input.cockpitUid };
  if (input.googleApplicationCredentials) {
    env.GOOGLE_APPLICATION_CREDENTIALS = input.googleApplicationCredentials;
  }

  const config: OpenclawConfigDocument = {
    skills: {
      load: {
        watch: true,
        extraDirs: [input.workspaceDir],
      },
    },
    mcp: {
      servers: {
        cockpit: {
          enabled: true,
          command: 'node',
          args: [input.mcpServerPath],
          env,
        },
      },
    },
    cockpitOs: {
      version: 1,
      capabilities: capabilityRegistry.list().map((c) => c.id),
      renderedAt: new Date().toISOString(),
    },
  };

  if (input.hooksToken) {
    // Inbound mappings: one per registered InboundMapping. Each becomes a
    // gateway endpoint at /hooks/cockpit-<id> that POSTs into Cockpit OS.
    const mappings = inboundRegistry.list().map((m) => ({
      id: `cockpit-${m.id}`,
      match: { path: `cockpit-${m.id}` },
      action: 'agent' as const,
      name: 'Cockpit',
      messageTemplate: `Cockpit event: ${m.id}`,
    }));
    config.hooks = {
      enabled: true,
      path: '/hooks',
      token: input.hooksToken,
      mappings,
    };
  }

  if (input.port) {
    config.gateway = { port: input.port };
  }

  return config;
}
