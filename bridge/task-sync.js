/**
 * task-sync.js — bridges Tasks/Active.md ↔ Cockpit server.
 *
 * Owned by the bridge process. Pure reconciler logic lives in reconciler.js;
 * this file does the I/O: read markdown → parse → fetch server snapshot →
 * merge → write markdown + push to server.
 *
 * Sync triggers:
 *   1. Periodic poll every TASK_POLL_INTERVAL_MS (default 60s).
 *   2. fs.watch event on Tasks/Active.md (debounced 1.5s).
 *
 * Concurrency: a single in-flight reconcile is enforced via _running flag.
 * If a watch event fires while a reconcile is in progress, _pending=true is
 * set so we re-run as soon as the current one finishes.
 *
 * Atomicity: vault writes use vault.writeFileAtomic. Done.md gets appended,
 * Active.md gets replaced.
 */

import { promises as fs, watch as fsWatch } from 'node:fs';
import path from 'node:path';
import * as vault from './vault.js';
import {
  parseTasksFile,
  serializeTasksFile,
  appendDoneSection,
} from './vault-tasks.js';
import { mergeTaskLists, vaultNeedsRewrite } from './reconciler.js';

const ACTIVE_REL = 'Tasks/Active.md';
const DONE_REL = 'Tasks/Done.md';
const POLL_INTERVAL_MS = Number(process.env.COCKPIT_TASK_POLL_MS || 60_000);
const WATCH_DEBOUNCE_MS = 1_500;

/* In-flight + pending guards. */
let _running = false;
let _pending = false;
let _debounceTimer = null;

function logFn(level, msg, data) {
  const prefix = `[task-sync][${level}] ${new Date().toISOString()} `;
  if (data !== undefined) {
    console[level === 'error' ? 'error' : 'log'](prefix + msg, JSON.stringify(data));
  } else {
    console[level === 'error' ? 'error' : 'log'](prefix + msg);
  }
}

/**
 * Reconcile once. Reads vault Active.md + server snapshot, merges, writes
 * back the diff. No-op (skip writes) if nothing changed on either side.
 *
 * @param {{ get: (path) => Promise<any>, put: (path, body) => Promise<any> }} client
 *   Thin Cockpit HTTP client. Provided by the bridge.
 */
export async function reconcileOnce(client) {
  if (_running) {
    _pending = true;
    return { skipped: true, reason: 'in-flight' };
  }
  _running = true;
  try {
    if (!vault.isEnabled()) return { skipped: true, reason: 'vault-disabled' };

    // 1. Read Active.md from disk (auto-creates if missing).
    const activeRaw = await readOrEmpty(ACTIVE_REL);
    const { tasks: vaultTasks } = parseTasksFile(activeRaw);

    // 2. Fetch server snapshot.
    const snap = await client.get('/api/tasks/snapshot');
    const serverTasks = (snap && Array.isArray(snap.tasks)) ? snap.tasks : [];

    // 3. Merge with last-write-wins. Use 24h archive grace so freshly-done
    //    tasks stay visible in Active.md for a day before moving to Done.
    const archiveGraceMs = 24 * 60 * 60 * 1000;
    const { merged, archived, toServer, toVault } = mergeTaskLists(
      serverTasks,
      vaultTasks,
      new Date(),
      archiveGraceMs,
    );

    // 4. Decide whether vault Active.md needs to be rewritten. Compare
    //    current vault tasks against `merged` (the canonical post-merge
    //    active list). If unchanged, skip the write.
    const needRewrite = vaultNeedsRewrite(vaultTasks, merged);

    // 5. Write Active.md atomically if needed.
    if (needRewrite) {
      const md = serializeTasksFile(merged);
      const res = await vault.writeFileAtomic(ACTIVE_REL, md);
      logFn('info', 'wrote Active.md', { tasks: merged.length, dryRun: res.dryRun });
    }

    // 6. Append archived tasks to Done.md (if any).
    if (archived.length > 0) {
      const existingDone = await readOrEmpty(DONE_REL);
      const newDone = appendDoneSection(existingDone, archived);
      const res = await vault.writeFileAtomic(DONE_REL, newDone);
      logFn('info', 'archived to Done.md', {
        count: archived.length,
        dryRun: res.dryRun,
      });
    }

    // 7. Push the canonical list (merged + archived) to the server so its
    //    cache reflects all known tasks (active + recently-done).
    if (toServer.length > 0 || archived.length > 0 || toVault.length > 0) {
      const all = [...merged, ...archived];
      await client.put('/api/tasks/snapshot', { tasks: all });
      logFn('info', 'pushed snapshot', {
        active: merged.length,
        archived: archived.length,
        toServer: toServer.length,
        toVault: toVault.length,
      });
    } else {
      logFn('debug', 'nothing to sync');
    }

    return { ok: true, merged: merged.length, archived: archived.length };
  } catch (err) {
    logFn('error', 'reconcile failed', { error: String(err && err.stack || err) });
    return { ok: false, error: String(err) };
  } finally {
    _running = false;
    if (_pending) {
      _pending = false;
      // Run again on next tick, but don't block the caller.
      setImmediate(() => reconcileOnce(client).catch(() => {}));
    }
  }
}

async function readOrEmpty(rel) {
  try {
    return await vault.readFile(rel);
  } catch (e) {
    return '';
  }
}

/**
 * Set up the file watcher on the Tasks/ folder. Debounced 1.5s.
 * Calls reconcileOnce(client) when Active.md or Done.md changes.
 *
 * Returns a stop() function for tests.
 */
export function startTaskWatcher(client) {
  if (!vault.isEnabled()) {
    logFn('info', 'task watcher disabled (vault not enabled)');
    return () => {};
  }
  const tasksFolder = path.join(vault.getVaultRoot(), 'Tasks');

  // Make sure the folder exists so fs.watch doesn't throw.
  fs.mkdir(tasksFolder, { recursive: true }).catch(() => {});

  let watcher;
  try {
    watcher = fsWatch(tasksFolder, { persistent: false }, (eventType, filename) => {
      if (!filename) return;
      if (!filename.endsWith('.md')) return;
      // Debounce
      if (_debounceTimer) clearTimeout(_debounceTimer);
      _debounceTimer = setTimeout(() => {
        _debounceTimer = null;
        logFn('debug', 'watch event → reconcile', { filename, eventType });
        reconcileOnce(client).catch((e) =>
          logFn('error', 'watch reconcile crashed', { error: String(e) }),
        );
      }, WATCH_DEBOUNCE_MS);
    });
    logFn('info', 'task watcher armed', { folder: tasksFolder });
  } catch (e) {
    logFn('error', 'task watcher setup failed', { error: String(e) });
    return () => {};
  }
  return () => {
    try { watcher && watcher.close(); } catch (_) {}
    if (_debounceTimer) clearTimeout(_debounceTimer);
  };
}

/**
 * Start the periodic reconcile loop. Returns a stop() function.
 */
export function startTaskPoller(client) {
  if (!vault.isEnabled()) return () => {};
  // Run once immediately so the dashboard picks up disk content on bridge start.
  reconcileOnce(client).catch((e) =>
    logFn('error', 'initial reconcile crashed', { error: String(e) }),
  );
  const id = setInterval(() => {
    reconcileOnce(client).catch((e) =>
      logFn('error', 'periodic reconcile crashed', { error: String(e) }),
    );
  }, POLL_INTERVAL_MS);
  logFn('info', 'task poll loop enabled', { intervalMs: POLL_INTERVAL_MS });
  return () => clearInterval(id);
}

export const _internal = {
  ACTIVE_REL,
  DONE_REL,
  POLL_INTERVAL_MS,
};
