/**
 * reconciler.js — last-write-wins reconciliation between vault markdown
 * and the Cockpit server's task snapshot.
 *
 * Pure functions. No I/O. Caller (bridge) provides parsed inputs and
 * writes outputs back.
 *
 * Conflict rule:
 *   For any task id present in both sides, the side with the newer
 *   `updated_at` wins entire object. Ties are broken by treating server
 *   as canonical (server tends to lag the user's vault edits, so on
 *   identical timestamps we prefer not to clobber a fresh vault edit).
 *
 * Output partitions:
 *   merged  — canonical post-merge active task list
 *   archived — tasks to move from Active.md → Done.md
 *   toServer — tasks the server needs to upsert (vault-newer or vault-only)
 *   toVault  — tasks the vault needs to be rewritten with (server-newer or server-only)
 */

function tsKey(t) {
  return t && typeof t.updated_at === 'string' ? t.updated_at : '';
}

function pickWinner(server, vault) {
  if (!server) return vault;
  if (!vault) return server;
  // Newer updated_at wins; on tie, vault wins (user just edited markdown).
  return tsKey(vault) > tsKey(server) ? vault : tsKey(server) > tsKey(vault) ? server : vault;
}

/**
 * @param {Task[]} serverTasks  All tasks (active + recently-done) from server snapshot.
 * @param {Task[]} vaultTasks   Tasks parsed from Active.md.
 * @param {Date}   now          Current time, for archive cutoff. Defaults to now.
 * @param {number} archiveAfterMs  Archive done tasks once they've been done this long. Default 0 (immediately).
 */
export function mergeTaskLists(serverTasks, vaultTasks, now = new Date(), archiveAfterMs = 0) {
  const serverMap = new Map((serverTasks || []).map((t) => [t.id, t]));
  const vaultMap = new Map((vaultTasks || []).map((t) => [t.id, t]));
  const allIds = new Set([...serverMap.keys(), ...vaultMap.keys()]);

  const merged = [];
  const archived = [];
  const toServer = [];
  const toVault = [];

  const archiveCutoff = now.getTime() - archiveAfterMs;

  for (const id of allIds) {
    const s = serverMap.get(id);
    const v = vaultMap.get(id);
    const winner = pickWinner(s, v);

    // Archive decision first — if archived, the task does NOT need to round-trip
    // back into Active.md, but the server still needs to know about it (so the
    // server-side snapshot reflects done state).
    let willArchive = false;
    if (winner.done) {
      const completedTs = winner.completed_on
        ? new Date(winner.completed_on + 'T23:59:59Z').getTime()
        : new Date(winner.updated_at || 0).getTime();
      if (completedTs <= archiveCutoff || archiveAfterMs === 0) {
        willArchive = true;
      }
    }

    // Routing: where does the winner need to be propagated?
    // Skip toVault routing for archived tasks (they're moving to Done.md, not Active.md).
    if (!s) {
      // New on vault only — push to server
      toServer.push(winner);
    } else if (!v) {
      // New on server only — push to vault Active.md only if not archiving
      if (!willArchive) toVault.push(winner);
    } else if (tsKey(v) > tsKey(s)) {
      // Vault is newer — server needs the update
      toServer.push(winner);
    } else if (tsKey(s) > tsKey(v)) {
      // Server is newer — vault needs the update (if not archiving)
      if (!willArchive) toVault.push(winner);
    }
    // tie → no propagation needed (both sides already match)

    if (willArchive) {
      archived.push(winner);
      continue;
    }
    merged.push(winner);
  }

  // Stable ordering for deterministic output
  merged.sort((a, b) => a.id.localeCompare(b.id));
  archived.sort((a, b) => a.id.localeCompare(b.id));
  toServer.sort((a, b) => a.id.localeCompare(b.id));
  toVault.sort((a, b) => a.id.localeCompare(b.id));

  return { merged, archived, toServer, toVault };
}

/**
 * Determines whether a vault rewrite is needed.
 * Avoids unnecessary disk writes when nothing changed.
 */
export function vaultNeedsRewrite(currentVaultTasks, mergedTasks) {
  if (currentVaultTasks.length !== mergedTasks.length) return true;
  const currentMap = new Map(currentVaultTasks.map((t) => [t.id, t.updated_at || '']));
  for (const t of mergedTasks) {
    if (currentMap.get(t.id) !== (t.updated_at || '')) return true;
  }
  return false;
}
