/**
 * Supervisor tests using a fake spawner. We never spawn a real OpenClaw
 * binary; instead we feed the supervisor a controllable child that lets us
 * simulate exits and verify restart/backoff behavior.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.COCKPIT_LOG_LEVEL = 'error';

import '../src/capabilities/index.js';
import {
  OpenClawSupervisor,
  renderOpenclawConfig,
} from '../src/edge/index.js';
import type {
  ChildHandle,
  Spawner,
  SupervisorState,
} from '../src/edge/types.js';

class FakeChild implements ChildHandle {
  pid = Math.floor(Math.random() * 100000);
  private listeners: Array<
    (code: number | null, signal: NodeJS.Signals | null) => void
  > = [];
  killed = false;

  on(_event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.listeners.push(listener);
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true;
    queueMicrotask(() => this.exit(null, signal));
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    for (const l of [...this.listeners]) l(code, signal);
    this.listeners = [];
  }
}

class FakeSpawner implements Spawner {
  children: FakeChild[] = [];
  spawn(): ChildHandle {
    const c = new FakeChild();
    this.children.push(c);
    return c;
  }
}

const tinyBackoff = [5, 5, 5, 5];

function awaitState(
  sup: OpenClawSupervisor,
  predicate: (s: SupervisorState) => boolean,
  timeoutMs = 1_000,
): Promise<SupervisorState> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const s = sup.getState();
      if (predicate(s)) return resolve(s);
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`timed out waiting for state; last=${JSON.stringify(s)}`));
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe('OpenClawSupervisor', () => {
  it('starts the gateway and reports running', async () => {
    const spawner = new FakeSpawner();
    const sup = new OpenClawSupervisor(
      {
        binary: 'fake-openclaw',
        args: ['gateway'],
        workspaceDir: '/tmp/wsp',
        configPath: '/tmp/openclaw.json',
        backoffMs: tinyBackoff,
      },
      spawner,
    );
    await sup.start();
    assert.equal(sup.getState().status, 'running');
    assert.equal(spawner.children.length, 1);
    await sup.stop();
    assert.equal(sup.getState().status, 'stopped');
  });

  it('restarts after a crash with backoff, then stays running', async () => {
    const spawner = new FakeSpawner();
    const sup = new OpenClawSupervisor(
      {
        binary: 'fake-openclaw',
        args: [],
        workspaceDir: '/tmp/wsp',
        configPath: '/tmp/openclaw.json',
        backoffMs: tinyBackoff,
      },
      spawner,
    );
    await sup.start();

    // Crash the first child.
    spawner.children[0]!.exit(1, null);
    await awaitState(sup, (s) => s.status === 'crashed');
    await awaitState(sup, (s) => s.status === 'running');

    assert.equal(spawner.children.length, 2);
    assert.equal(sup.getState().status, 'running');
    await sup.stop();
  });

  it('gives up after maxRestarts is exceeded', async () => {
    const spawner = new FakeSpawner();
    const sup = new OpenClawSupervisor(
      {
        binary: 'fake-openclaw',
        args: [],
        workspaceDir: '/tmp/wsp',
        configPath: '/tmp/openclaw.json',
        backoffMs: tinyBackoff,
        maxRestarts: 2,
      },
      spawner,
    );
    await sup.start();
    // Crash 3 times; 2 restarts then give up.
    spawner.children[0]!.exit(1);
    await awaitState(sup, (s) => s.status === 'running');
    spawner.children[1]!.exit(1);
    await awaitState(sup, (s) => s.status === 'running');
    spawner.children[2]!.exit(1);
    await awaitState(sup, (s) => s.status === 'gave_up');
    assert.equal(sup.getState().status, 'gave_up');
  });

  it('writes the rendered config to disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cockpit-sup-'));
    try {
      const sup = new OpenClawSupervisor(
        {
          binary: 'fake',
          args: [],
          workspaceDir: dir,
          configPath: join(dir, 'openclaw.json'),
          backoffMs: tinyBackoff,
        },
        new FakeSpawner(),
      );
      const config = renderOpenclawConfig({
        workspaceDir: dir,
        mcpServerPath: '/abs/path/server.js',
        cockpitUid: 'user-123',
        hooksToken: 'tok-abc',
      });
      await sup.writeConfig(JSON.stringify(config, null, 2));
      const contents = await readFile(join(dir, 'openclaw.json'), 'utf8');
      const parsed = JSON.parse(contents);
      assert.equal(parsed.mcp.servers.cockpit.enabled, true);
      assert.equal(parsed.hooks.token, 'tok-abc');
      assert.ok(Array.isArray(parsed.cockpitOs.capabilities));
      assert.ok(parsed.cockpitOs.capabilities.length >= 4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
