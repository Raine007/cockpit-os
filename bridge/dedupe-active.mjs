/**
 * dedupe-active.mjs — one-shot fix.
 *
 * Reads Tasks/Active.md, drops duplicate-by-title tasks (keeping the
 * lexicographically-first id), and writes the file back atomically.
 *
 * Run with the bridge stopped to avoid a race:
 *
 *   systemctl --user stop cockpit-bridge
 *   COCKPIT_VAULT_PATH=/mnt/f/Vault \
 *   COCKPIT_VAULT_DRY_RUN=0 \
 *   node bridge/dedupe-active.mjs
 *   systemctl --user start cockpit-bridge
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as vault from './vault.js';
import { parseTasksFile, serializeTasksFile } from './vault-tasks.js';

if (!vault.isEnabled()) {
  console.error('vault is disabled — set COCKPIT_VAULT_PATH first');
  process.exit(1);
}

const ACTIVE = 'Tasks/Active.md';
const md = await vault.readFile(ACTIVE);
const { tasks } = parseTasksFile(md);
console.log(`[dedupe] before: ${tasks.length} tasks`);

const byTitle = new Map();
for (const t of tasks) {
  const key = (t.title || '').trim() || t.id;
  const existing = byTitle.get(key);
  if (!existing || t.id < existing.id) byTitle.set(key, t);
}
const deduped = [...byTitle.values()].sort((a, b) => a.id.localeCompare(b.id));
console.log(`[dedupe] after:  ${deduped.length} tasks`);

if (deduped.length === tasks.length) {
  console.log('[dedupe] no duplicates found — nothing to do');
  process.exit(0);
}

const out = serializeTasksFile(deduped);
const res = await vault.writeFileAtomic(ACTIVE, out);
console.log(`[dedupe] wrote Active.md: ${res.bytes} bytes (dryRun=${res.dryRun})`);
console.log('[dedupe] done. Restart the bridge to push the canonical list.');
