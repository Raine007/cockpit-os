/**
 * End-to-end MCP smoke test. Spawns the MCP server as a child process,
 * speaks the protocol over stdio, and confirms:
 *   - the server initializes successfully
 *   - it advertises every registered capability as a tool
 *   - calling a tool returns a structured-content payload
 *
 * This is the highest-value test because it exercises the same path
 * OpenClaw and Computer will use in production.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';

const SERVER_PATH = resolve(import.meta.dirname, '..', 'src', 'mcp', 'server.ts');

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

class McpClient {
  private buf = '';
  private pending = new Map<number, (msg: JsonRpcResponse) => void>();
  private nextId = 1;
  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as JsonRpcResponse;
          if (typeof msg.id === 'number') {
            const cb = this.pending.get(msg.id);
            if (cb) {
              this.pending.delete(msg.id);
              cb(msg);
            }
          }
        } catch {
          // notifications / non-JSON lines — ignore.
        }
      }
    });
  }

  send(method: string, params: unknown = {}): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolveResp) => {
      this.pending.set(id, resolveResp);
      this.child.stdin.write(frame);
    });
  }

  notify(method: string, params: unknown = {}): void {
    const frame = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    this.child.stdin.write(frame);
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

function spawnServer(): { child: ChildProcessWithoutNullStreams; client: McpClient } {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', SERVER_PATH],
    {
      env: {
        ...process.env,
        COCKPIT_DRY_RUN: '1',
        COCKPIT_LOG_LEVEL: 'error',
        COCKPIT_UID: 'smoke-test',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  return { child, client: new McpClient(child) };
}

describe('MCP server (stdio)', () => {
  it('initializes and lists every capability as a tool', async () => {
    const { client } = spawnServer();
    try {
      const init = await client.send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'cockpit-smoke', version: '0.0.0' },
      });
      assert.ok(!init.error, `initialize errored: ${JSON.stringify(init.error)}`);
      client.notify('notifications/initialized');

      const list = await client.send('tools/list');
      assert.ok(!list.error, `tools/list errored: ${JSON.stringify(list.error)}`);
      const tools = (list.result as { tools: { name: string }[] }).tools;
      const names = tools.map((t) => t.name).sort();
      assert.deepEqual(names, ['flight-log', 'note-append', 'task-create', 'task-list']);
    } finally {
      client.close();
    }
  });

  it('invokes a write capability and returns a result', async () => {
    const { client } = spawnServer();
    try {
      await client.send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'cockpit-smoke', version: '0.0.0' },
      });
      client.notify('notifications/initialized');

      const call = await client.send('tools/call', {
        name: 'task-create',
        arguments: { title: 'wire up Cockpit OS' },
      });
      assert.ok(!call.error, `tools/call errored: ${JSON.stringify(call.error)}`);
      const content = (call.result as { content: { type: string; text: string }[] }).content;
      assert.ok(content.length > 0);
      assert.equal(content[0]!.type, 'text');
      const payload = JSON.parse(content[0]!.text) as {
        dryRun: boolean;
        task: { title: string };
      };
      assert.equal(payload.dryRun, true);
      assert.equal(payload.task.title, 'wire up Cockpit OS');
    } finally {
      client.close();
    }
  });

  it('rejects an invalid input with isError', async () => {
    const { client } = spawnServer();
    try {
      await client.send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'cockpit-smoke', version: '0.0.0' },
      });
      client.notify('notifications/initialized');

      const call = await client.send('tools/call', {
        name: 'flight-log',
        arguments: { tail: '!!!', route: 'A → B', hours: 1 },
      });
      // Either MCP framework refuses (response.error) or the handler returns isError.
      const result = call.result as { isError?: boolean } | undefined;
      const ok = !!call.error || result?.isError === true;
      assert.ok(ok, `expected validation failure, got: ${JSON.stringify(call)}`);
    } finally {
      client.close();
    }
  });
});
