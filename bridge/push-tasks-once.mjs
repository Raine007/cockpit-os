/**
 * push-tasks-once.mjs — one-shot diagnostic.
 *
 * Reads Tasks/Active.md from the configured vault, parses it, and pushes
 * everything to /api/tasks/snapshot. Use this when the bridge isn't
 * syncing for some reason.
 *
 *   COCKPIT_VAULT_PATH=/mnt/f/Vault \
 *   COCKPIT_BACKEND_URL=https://cockpit-os-646650189890.us-central1.run.app \
 *   COCKPIT_ADMIN_TOKEN=<token> \
 *   node bridge/push-tasks-once.mjs
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseTasksFile } from './vault-tasks.js';

const VAULT = process.env.COCKPIT_VAULT_PATH;
const BACKEND = (process.env.COCKPIT_BACKEND_URL || '').replace(/\/$/, '');
const TOKEN = process.env.COCKPIT_ADMIN_TOKEN || '';

if (!VAULT) { console.error('COCKPIT_VAULT_PATH is required'); process.exit(1); }
if (!BACKEND) { console.error('COCKPIT_BACKEND_URL is required'); process.exit(1); }
if (!TOKEN) { console.error('COCKPIT_ADMIN_TOKEN is required'); process.exit(1); }

const activePath = path.join(VAULT, 'Tasks', 'Active.md');
console.log('[push-tasks] reading', activePath);
const md = await fs.readFile(activePath, 'utf-8');
const { tasks } = parseTasksFile(md);
console.log(`[push-tasks] parsed ${tasks.length} tasks`);

if (tasks.length === 0) {
  console.error('[push-tasks] no tasks parsed — aborting');
  process.exit(1);
}

console.log(`[push-tasks] pushing to ${BACKEND}/api/tasks/snapshot ...`);
const res = await fetch(`${BACKEND}/api/tasks/snapshot`, {
  method: 'PUT',
  headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ tasks }),
});
const text = await res.text();
console.log('[push-tasks] status:', res.status);
console.log('[push-tasks] body:', text);
if (!res.ok) process.exit(1);
console.log('[push-tasks] done. Refresh the dashboard.');
