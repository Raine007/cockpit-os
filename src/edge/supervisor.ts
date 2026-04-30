/**
 * Supervisor — manages the OpenClaw gateway as a child process of Cockpit OS.
 *
 * Responsibilities:
 *   1. Render and write openclaw.json from Cockpit OS state.
 *   2. Spawn the gateway with our env (uid, Firebase creds, hooks token).
 *   3. Restart on crash with capped exponential backoff.
 *   4. Expose state for the dashboard / health endpoint.
 *
 * The Spawner interface is pluggable so tests don't need a real binary.
 * Callers in production pass the node:child_process-backed spawner from
 * `nodeSpawner` below.
 */

import { spawn as childSpawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { logger } from '../context/logger.js';
import type {
  ChildHandle,
  OpenClawConfig,
  Spawner,
  SupervisorState,
} from './types.js';

const DEFAULT_BACKOFF_MS: readonly number[] = [
  500, 1_000, 2_000, 5_000, 10_000, 30_000,
];

export const nodeSpawner: Spawner = {
  spawn(command, args, env) {
    return childSpawn(command, [...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'inherit', 'inherit'],
    }) as unknown as ChildHandle;
  },
};

export class OpenClawSupervisor {
  private child: ChildHandle | null = null;
  private state: SupervisorState = { status: 'stopped' };
  private restartCount = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private readonly backoff: readonly number[];
  private readonly maxRestarts: number;
  private stopping = false;

  /** Snapshots taken whenever state changes. Useful for dashboards + tests. */
  readonly history: SupervisorState[] = [];

  constructor(
    private readonly config: OpenClawConfig,
    private readonly spawner: Spawner = nodeSpawner,
  ) {
    this.backoff = config.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.maxRestarts = config.maxRestarts ?? Number.POSITIVE_INFINITY;
  }

  getState(): SupervisorState {
    return this.state;
  }

  /**
   * Persist the rendered openclaw.json. Call this *before* start() the first
   * time, and any time Cockpit OS state that affects the config changes.
   */
  async writeConfig(jsonText: string): Promise<void> {
    await mkdir(dirname(this.config.configPath), { recursive: true });
    await writeFile(this.config.configPath, jsonText, 'utf8');
    logger.info('openclaw config written', { path: this.config.configPath });
  }

  async start(): Promise<void> {
    if (this.state.status === 'running' || this.state.status === 'starting') {
      return;
    }
    this.stopping = false;
    // Reset the crash counter only on a fresh manual start. Within a single
    // run, every crash counts toward maxRestarts — otherwise a flapping
    // gateway would loop forever as long as it stayed up briefly.
    this.restartCount = 0;
    this.setState({ status: 'starting' });
    this.spawnNow();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
    this.setState({ status: 'stopped' });
  }

  private spawnNow(): void {
    const child = this.spawner.spawn(
      this.config.binary,
      this.config.args,
      { ...(this.config.env ?? {}) },
    );
    this.child = child;
    const pid = child.pid;
    this.setState({
      status: 'running',
      pid: pid ?? -1,
      startedAt: new Date().toISOString(),
    });

    child.on('exit', (code, signal) => this.handleExit(code, signal));
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.child = null;
    if (this.stopping) return;

    const error = `gateway exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
    logger.warn('openclaw gateway exited', { code, signal });
    this.restartCount += 1;

    if (this.restartCount > this.maxRestarts) {
      this.setState({ status: 'gave_up', error, restartCount: this.restartCount });
      return;
    }

    const delay =
      this.backoff[Math.min(this.restartCount - 1, this.backoff.length - 1)] ?? 1_000;
    this.setState({
      status: 'crashed',
      error,
      restartIn: delay,
      restartCount: this.restartCount,
    });

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) this.spawnNow();
    }, delay);
    // In test environments we don't want a stray timer keeping the loop alive.
    this.restartTimer.unref?.();
  }

  private setState(next: SupervisorState): void {
    this.state = next;
    this.history.push(next);
  }
}
