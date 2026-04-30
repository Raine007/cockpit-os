/**
 * Supervisor types — kept separate from implementation so tests can stub
 * the spawn function and config renderer without pulling in node:child_process.
 */

export interface OpenClawConfig {
  /** Path to the openclaw binary (or anything that responds to the same args). */
  binary: string;
  /** Arguments passed to the gateway subprocess. */
  args: readonly string[];
  /** Workspace directory; capabilities compile their SKILL.md into this. */
  workspaceDir: string;
  /** Path to the openclaw.json config the supervisor renders + writes. */
  configPath: string;
  /** Environment variables passed through to the child process. */
  env?: Readonly<Record<string, string>>;
  /** Restart backoff in ms (capped exponential). Defaults: 500, 1000, ... 30000. */
  backoffMs?: readonly number[];
  /** Stop restarting after this many consecutive failures. Default: Infinity. */
  maxRestarts?: number;
}

export type SupervisorState =
  | { status: 'stopped' }
  | { status: 'starting' }
  | { status: 'running'; pid: number; startedAt: string }
  | { status: 'crashed'; error: string; restartIn: number; restartCount: number }
  | { status: 'gave_up'; error: string; restartCount: number };

export interface ChildHandle {
  pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

export interface Spawner {
  spawn(
    command: string,
    args: readonly string[],
    env: Record<string, string>,
  ): ChildHandle;
}
