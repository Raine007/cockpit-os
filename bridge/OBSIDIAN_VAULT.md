# Obsidian vault integration

## What this is

The bridge can read and write a local Obsidian vault — your notes, tasks,
daily log entries — on behalf of Cockpit OS in the cloud. Cockpit OS
itself never touches the filesystem. All disk operations happen on the
machine running the bridge, against a single configured vault folder.

## Phase 1: vault module + path safety (shipped)

This phase ships the `vault.js` module and its 27-test suite. It's a
library that the bridge can call directly — every disk write goes through
the five hard guarantees below.

## Phase 2: poll-based job queue + dashboard tile (shipped)

This phase wires Cockpit OS to the vault module via a poll-based queue.
Nothing in the cloud touches your disk; Cockpit only enqueues a job, the
bridge picks it up, runs it locally, and reports back.

**Cockpit OS endpoints (all admin-token-gated):**

| Method + path | Caller | Purpose |
|---|---|---|
| `POST /api/vault/jobs` | any admin client | Enqueue a job. Body: `{ kind, payload }`. Kinds: `append`, `read`, `list`, `daily-note`. |
| `GET /api/vault/jobs/pending` | the bridge | Poll for queued jobs (every 3s). Heartbeats `last_seen`. |
| `POST /api/vault/jobs/:id/result` | the bridge | Post the execution result. Updates job status + write counters. |
| `GET /api/vault/status` | the dashboard | Read for the status pill. Shape: `{ enabled, dry_run, vault_root, last_seen, last_write, writes_today, last_error }`. |
| `POST /api/vault/status` | the bridge | Heartbeat the diagnostic snapshot at startup. |

**Bridge changes:**

- New `pollVaultJobs()` runs alongside the chat poller (independent
  interval, so vault work never blocks chat).
- On startup, the bridge announces its `diagnostic()` to
  `POST /api/vault/status` so the dashboard pill turns green even before
  any job runs.
- The vault poll is silent when `COCKPIT_VAULT_PATH` isn't set.

**Dashboard pill (`Vault` next to `Sync` in the header):**

- Grey: bridge offline, or vault disabled.
- Amber: bridge connected, but in dry-run mode (no real writes).
- Green: bridge connected, real writes happening.
- Red: last reported bridge error (clears on next success).

Hover the pill for a tooltip with the vault root, last-write timestamp,
and today's write count.

## Configuration

Set these env vars on the bridge host (e.g. via the systemd unit or a
`.env` file):

| Var | Required | Default | Purpose |
|---|---|---|---|
| `COCKPIT_VAULT_PATH` | yes | _(unset)_ | Absolute path to vault root. On WSL, use `/mnt/f/Vault`. |
| `COCKPIT_VAULT_DRY_RUN` | no | `1` | `1` = log only, no writes. Flip to `0` once you've verified things look right. |
| `COCKPIT_VAULT_ALLOWLIST` | no | `Daily Notes,Flying,Tasks,Chat,Inbox` | Comma-separated list of top-level subfolders the bridge may touch. |

**Important:** dry-run is **on by default**. Nothing is written to disk
until you explicitly set `COCKPIT_VAULT_DRY_RUN=0`.

## Hard guarantees

1. **No path can escape the vault root.** All paths go through
   `path.resolve()` and a prefix check; `..`, absolute paths, and drive
   letters are rejected.
2. **No path can target a folder outside the allowlist.** Even inside
   the vault, only the configured subfolders accept reads/writes.
3. **Symlinks inside the vault are not followed for writes.** A symlink
   in any ancestor directory aborts the operation.
4. **All overwriting writes are atomic** (temp file + fsync + rename).
   No torn writes if the process dies.
5. **Dry-run is default-on.** Explicit env-var opt-in to mutate disk.

## Quick smoke test (on the bridge host)

```bash
cd ~/cockpit-os
node --test bridge/vault.test.mjs
```

Expected: `# pass 27 / # fail 0`.

To test against your real vault path (without writing):

```bash
COCKPIT_VAULT_PATH=/mnt/f/Vault \
  node -e "
    import('./bridge/vault.js').then((v) => {
      console.log(v.diagnostic());
      console.log('allowed folders:', v.listAllowedFolders());
    });
  "
```

Expected output: `enabled: true`, `dryRun: true`, the right vault root,
and the five allowed folders.

To exercise an actual append in dry-run (logs only, writes nothing):

```bash
COCKPIT_VAULT_PATH=/mnt/f/Vault \
  node -e "
    import('./bridge/vault.js').then(async (v) => {
      const r = await v.appendDailyNote('test from CLI', 'manual');
      console.log(r);
    });
  "
```

Expected output: `{ written: false, dryRun: true, ... }` and a log line
that says `DRY_RUN appendToFile`.

To enable real writes for a single command (do this only after you're
satisfied with dry-run output):

```bash
COCKPIT_VAULT_PATH=/mnt/f/Vault \
COCKPIT_VAULT_DRY_RUN=0 \
  node -e "
    import('./bridge/vault.js').then(async (v) => {
      const r = await v.appendDailyNote('first real write', 'manual');
      console.log(r);
    });
  "
```

Then check the daily note in Obsidian:
`F:\Vault\Daily Notes\YYYY-MM-DD.md` should now contain a timestamped
line.

## What's coming next

Phase 3: two-way task sync (stable IDs embedded as HTML comments in
markdown lines, last-write-wins reconciler).

Phase 4: chat capture — every Cockpit chat message appends to today's
daily note via the new `daily-note` job kind.

Each phase ships independently, with tests, and behind dry-run until
verified.

## Uninstall

Stop the bridge. Remove the four env vars from its environment. The
five subfolders inside your vault stay where they are — your notes are
unaffected.
