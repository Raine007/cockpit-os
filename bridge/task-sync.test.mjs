/**
 * task-sync.test.mjs — integration tests for the bridge reconciler loop.
 *
 * We point COCKPIT_VAULT_PATH at a tmp dir, stub the Cockpit client with an
 * in-memory snapshot, and assert the round-trip behavior:
 *   - vault is single source of truth on disk
 *   - server snapshot reflects the merged + archived list
 *   - Active.md is rewritten only when the merged list differs
 *   - Done.md gets new entries appended once tasks pass the archive grace
 *
 * Run: node --test bridge/task-sync.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function freshVault() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-sync-test-'));
  await fs.mkdir(path.join(dir, 'Tasks'), { recursive: true });
  return dir;
}

function makeClient(initialTasks = []) {
  let tasks = [...initialTasks];
  return {
    state: () => tasks,
    setState: (next) => { tasks = [...next]; },
    get: async (p) => {
      if (p === '/api/tasks/snapshot') return { ok: true, tasks };
      throw new Error('unexpected GET ' + p);
    },
    put: async (p, body) => {
      if (p === '/api/tasks/snapshot') {
        tasks = Array.isArray(body && body.tasks) ? [...body.tasks] : [];
        return { ok: true };
      }
      throw new Error('unexpected PUT ' + p);
    },
  };
}

async function loadFreshTaskSync(vaultDir) {
  // Reset vault env BEFORE module import so vault.js picks up the new path.
  process.env.COCKPIT_VAULT_PATH = vaultDir;
  process.env.COCKPIT_VAULT_DRY_RUN = '0';
  // Cache-bust ALL three modules so each test gets clean state. vault.js
  // captures COCKPIT_VAULT_PATH at module import time, so the import URL
  // must change for it to re-read the env var.
  const stamp = Date.now() + Math.random();
  // task-sync re-imports vault.js + vault-tasks.js + reconciler.js by relative
  // specifier, which resolves to the cached copies. We must force a fresh
  // graph by importing task-sync via a unique URL AND threading the stamp
  // through to vault.js. Easiest: use Node's --experimental-loader is overkill;
  // instead we copy the bridge files into the tmp vault dir and import from there.
  return null; // unused; tests use loadIsolated below
}

// loadIsolated copies the three bridge modules into a fresh tmp dir so each
// test gets a completely isolated module graph (and therefore picks up the
// per-test COCKPIT_VAULT_PATH at import time).
async function loadIsolated(vaultDir, vaultEnabled = true) {
  if (vaultEnabled) {
    process.env.COCKPIT_VAULT_PATH = vaultDir;
  } else {
    delete process.env.COCKPIT_VAULT_PATH;
  }
  process.env.COCKPIT_VAULT_DRY_RUN = '0';
  const tmpModDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-sync-mod-'));
  for (const f of ['vault.js', 'vault-tasks.js', 'reconciler.js', 'task-sync.js']) {
    const src = path.join(path.resolve('bridge'), f);
    const dst = path.join(tmpModDir, f);
    await fs.copyFile(src, dst);
  }
  const sync = await import(path.join(tmpModDir, 'task-sync.js'));
  return sync;
}

/* ---- tests ---- */

test('reconcileOnce: empty vault + empty server → no-op', async () => {
  const vaultDir = await freshVault();
  const sync = await loadIsolated(vaultDir);
  const client = makeClient([]);
  const res = await sync.reconcileOnce(client);
  assert.equal(res.ok, true);
  assert.equal(res.merged, 0);
  assert.equal(res.archived, 0);
  // No file written
  const dirents = await fs.readdir(path.join(vaultDir, 'Tasks'));
  assert.deepEqual(dirents, []);
});

test('reconcileOnce: server has tasks → vault gets seeded', async () => {
  const vaultDir = await freshVault();
  const sync = await loadIsolated(vaultDir);
  const t = {
    id: 't_aaa',
    title: 'Hello world',
    done: false,
    owner: 'openclaw',
    tags: ['flying'],
    priority: 'high',
    notes: 'first task',
    feedback: [],
    escalations: [],
    artifacts: [],
    updated_at: '2026-04-30T22:00:00.000Z',
  };
  const client = makeClient([t]);
  const res = await sync.reconcileOnce(client);
  assert.equal(res.ok, true);
  assert.equal(res.merged, 1);
  // Active.md exists with our task in it.
  const md = await fs.readFile(path.join(vaultDir, 'Tasks', 'Active.md'), 'utf-8');
  assert.match(md, /Hello world/);
  assert.match(md, /id:t_aaa/);
  assert.match(md, /@openclaw/);
});

test('reconcileOnce: vault edit beats older server task', async () => {
  const vaultDir = await freshVault();
  const sync = await loadIsolated(vaultDir);
  // Disk has the newer version.
  await fs.writeFile(
    path.join(vaultDir, 'Tasks', 'Active.md'),
    `# Active Tasks\n\n- [ ] Edited by hand 🔺 #flying @openclaw\n  <!-- id:t_aaa updated:2026-05-01T00:00:00.000Z owner:openclaw -->\n`,
  );
  // Server has the stale version.
  const stale = {
    id: 't_aaa',
    title: 'Old title',
    done: false,
    owner: 'openclaw',
    tags: ['flying'],
    priority: 'high',
    feedback: [], escalations: [], artifacts: [],
    updated_at: '2026-04-30T00:00:00.000Z',
  };
  const client = makeClient([stale]);
  const res = await sync.reconcileOnce(client);
  assert.equal(res.ok, true);
  // After reconcile, server should now have the vault version.
  const after = client.state();
  assert.equal(after.length, 1);
  assert.equal(after[0].title, 'Edited by hand');
});

test('reconcileOnce: done task within grace window stays in Active', async () => {
  const vaultDir = await freshVault();
  const sync = await loadIsolated(vaultDir);
  const justNowIso = new Date().toISOString();
  const justDone = {
    id: 't_done1', title: 'Just finished', done: true, owner: 'openclaw',
    tags: ['flying'], completed_on: justNowIso.slice(0, 10),
    feedback: [], escalations: [], artifacts: [],
    updated_at: justNowIso,
  };
  const client = makeClient([justDone]);
  const res = await sync.reconcileOnce(client);
  assert.equal(res.ok, true);
  assert.equal(res.archived, 0, 'should NOT archive within 24h grace');
  // Active.md should contain the done task (it's still within grace).
  const active = await fs.readFile(path.join(vaultDir, 'Tasks', 'Active.md'), 'utf-8');
  assert.match(active, /Just finished/);
});

test('reconcileOnce: stale done task gets archived to Done.md', async () => {
  const vaultDir = await freshVault();
  const sync = await loadIsolated(vaultDir);
  const oldIso = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const stale = {
    id: 't_old1', title: 'Done two days ago', done: true, owner: 'openclaw',
    tags: ['flying'], completed_on: oldIso.slice(0, 10),
    feedback: [], escalations: [], artifacts: [],
    updated_at: oldIso,
  };
  const client = makeClient([stale]);
  const res = await sync.reconcileOnce(client);
  assert.equal(res.ok, true);
  assert.equal(res.archived, 1, 'should archive past 24h grace');
  // Done.md should exist with the entry.
  const done = await fs.readFile(path.join(vaultDir, 'Tasks', 'Done.md'), 'utf-8');
  assert.match(done, /Done two days ago/);
});

test('reconcileOnce: vault disabled returns skipped', async () => {
  const sync = await loadIsolated(null, false);
  const client = makeClient([]);
  const res = await sync.reconcileOnce(client);
  assert.equal(res.skipped, true);
  assert.equal(res.reason, 'vault-disabled');
});
