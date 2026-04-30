# Obsidian vault integration

## What this is

The bridge can read and write a local Obsidian vault — your notes, tasks,
daily log entries — on behalf of Cockpit OS in the cloud. Cockpit OS
itself never touches the filesystem. All disk operations happen on the
machine running the bridge, against a single configured vault folder.

## Phase 1 (current): vault module + path safety

This phase ships the `vault.js` module and its 27-test suite. It's a
library only — no API routes are exposed yet, no chat capture is wired
up. You can test it standalone before any network surface comes online.

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

## What's coming next (not in this phase)

Phase 2 will add API routes on Cockpit OS that the bridge polls /
responds to:

- `POST /api/vault/append` — append text to a path inside the vault
- `GET  /api/vault/flight-log` — list parsed entries from `Flying/`
- `GET  /api/vault/tasks` — list task lines parsed from `Tasks/Inbox.md`
- `POST /api/vault/tasks` — append a new task with a stable ID

Phase 3: two-way task sync (stable IDs embedded as HTML comments in
markdown lines).

Phase 4: chat capture — every Cockpit chat message appends to today's
daily note.

Each phase ships independently, with tests, and behind dry-run until
verified.

## Uninstall

Stop the bridge. Remove the four env vars from its environment. The
five subfolders inside your vault stay where they are — your notes are
unaffected.
