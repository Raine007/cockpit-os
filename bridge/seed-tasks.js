/**
 * seed-tasks.js — One-shot tool to seed Tasks/Active.md from the legacy
 * GTASKS const baked into src/http/ui/cockpit.html.
 *
 * Run ONCE after Phase 3 deploy:
 *   COCKPIT_VAULT_PATH=/mnt/f/Vault node bridge/seed-tasks.js
 *
 * Idempotent: if Tasks/Active.md already contains tasks (parser sees > 0),
 * the script refuses to overwrite. Pass --force to clobber anyway.
 *
 * Mapping from old GTASKS → new Task:
 *   id:       legacy Todoist id → fresh t_xxx (Todoist is being abandoned)
 *   title:    title
 *   cat:      → tags[0]
 *   urgent:   true → priority='high', false → no priority
 *   notes:    notes (preserved verbatim)
 *   list:     → tags[1] (lightly normalized: emoji + space stripped, lower-kebab)
 *   pts:      DROPPED (not part of new model)
 *   owner:    'openclaw' for all (default routing)
 *   due:      undefined (legacy has no per-task due dates)
 *   updated_at: now (script run time)
 */

import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import url from 'node:url';
import * as vault from './vault.js';
import {
  parseTasksFile,
  serializeTasksFile,
  newTaskId,
  nowIso,
} from './vault-tasks.js';

const ACTIVE_REL = 'Tasks/Active.md';
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const COCKPIT_HTML_REL = 'src/http/ui/cockpit.html';
// The Phase 3 commit deleted the GTASKS literal from cockpit.html. We pull
// the last copy from git history. Override with --commit=<sha> if needed.
const DEFAULT_FALLBACK_COMMIT = '3c49d71';

/**
 * Read cockpit.html. First try the working tree; if the GTASKS literal is
 * gone (Phase 3+), fall back to the named git commit that still contains it.
 */
async function readCockpitHtml() {
  const live = path.join(REPO_ROOT, COCKPIT_HTML_REL);
  try {
    const html = await fs.readFile(live, 'utf-8');
    if (html.includes('const GTASKS = [{')) return { html, source: 'working-tree' };
    if (/const GTASKS = \[\s*\{/.test(html)) return { html, source: 'working-tree' };
  } catch (_) {}
  // Fall back to git history.
  const commit = process.argv.find((a) => a.startsWith('--commit='))?.split('=')[1] || DEFAULT_FALLBACK_COMMIT;
  console.log(`[seed-tasks] working tree has no GTASKS literal; reading from commit ${commit}`);
  const stdout = execFileSync('git', ['show', `${commit}:${COCKPIT_HTML_REL}`], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { html: stdout, source: `git:${commit}` };
}

/**
 * Extract the GTASKS array literal from cockpit.html and eval it in a
 * sandbox. Walks brackets while tracking string state so quotes / escapes
 * inside the array don't confuse the parser.
 */
async function extractGtasks() {
  const { html, source } = await readCockpitHtml();
  console.log(`[seed-tasks] cockpit.html source: ${source}`);
  const startMarker = 'const GTASKS = [';
  const startIdx = html.indexOf(startMarker);
  if (startIdx === -1) throw new Error('GTASKS const not found in cockpit.html');
  // Walk forward, tracking bracket depth, until we close the outer [.
  let depth = 0;
  let i = startIdx + startMarker.length - 1; // position of the opening [
  let end = -1;
  let inStr = null; // null | "'" | '"' | '`'
  let escape = false;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (ch === '\\') { escape = true; continue; }
      if (ch === inStr) { inStr = null; }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) throw new Error('Failed to locate end of GTASKS array');
  const arrayLiteral = html.slice(startIdx + 'const GTASKS = '.length, end + 1);
  // Eval in a Function so we don't pollute the module scope.
  // eslint-disable-next-line no-new-func
  const fn = new Function(`return ${arrayLiteral};`);
  const arr = fn();
  if (!Array.isArray(arr)) throw new Error('GTASKS did not eval to an array');
  return arr;
}

function listToTag(list) {
  if (!list) return null;
  // Strip emoji and leading whitespace, then kebab-case.
  const stripped = list
    .replace(/[\p{Extended_Pictographic}\u{1F3F4}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}]/gu, '')
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return stripped || null;
}

function mapGtaskToTask(g) {
  const tags = [];
  if (g.cat) tags.push(g.cat);
  const listTag = listToTag(g.list);
  if (listTag && listTag !== g.cat) tags.push(listTag);
  const task = {
    id: newTaskId(),
    title: g.title || 'Untitled',
    done: false,
    owner: 'openclaw',
    priority: g.urgent ? 'high' : null,
    tags,
    notes: g.notes || '',
    feedback: [],
    escalations: [],
    artifacts: [],
    updated_at: nowIso(),
  };
  // Strip null priority (parser tolerates absence).
  if (!task.priority) delete task.priority;
  return task;
}

async function main() {
  const force = process.argv.includes('--force');
  const dryRun = process.argv.includes('--dry-run');

  if (!vault.isEnabled()) {
    console.error('[seed-tasks] vault not enabled. Set COCKPIT_VAULT_PATH first.');
    process.exit(2);
  }

  console.log('[seed-tasks] vault root:', vault.getVaultRoot());
  console.log('[seed-tasks] dry-run:', dryRun, '| force:', force);

  // 1. Check existing Active.md.
  let existingMd = '';
  try {
    existingMd = await vault.readFile(ACTIVE_REL);
  } catch (_) { existingMd = ''; }
  const { tasks: existingTasks } = parseTasksFile(existingMd);
  if (existingTasks.length > 0 && !force) {
    console.error(
      `[seed-tasks] Active.md already has ${existingTasks.length} tasks. ` +
      `Refusing to overwrite. Pass --force to clobber.`,
    );
    process.exit(1);
  }

  // 2. Pull GTASKS from cockpit.html.
  const gtasks = await extractGtasks();
  console.log(`[seed-tasks] extracted ${gtasks.length} legacy tasks from cockpit.html`);

  // 3. Map.
  const tasks = gtasks.map(mapGtaskToTask);
  const urgent = tasks.filter((t) => t.priority === 'high').length;
  console.log(`[seed-tasks] mapped ${tasks.length} tasks (${urgent} urgent)`);

  // 4. Serialize.
  const md = serializeTasksFile(tasks);
  console.log(`[seed-tasks] markdown length: ${md.length} bytes`);

  if (dryRun) {
    console.log('--- preview (first 80 lines) ---');
    console.log(md.split('\n').slice(0, 80).join('\n'));
    console.log('--- end preview ---');
    console.log('[seed-tasks] dry-run: not writing.');
    return;
  }

  // 5. Write atomically.
  const res = await vault.writeFileAtomic(ACTIVE_REL, md);
  console.log(`[seed-tasks] wrote ${ACTIVE_REL} (dryRun=${res.dryRun})`);
  console.log('[seed-tasks] done. The bridge will pick this up on its next reconcile.');
}

main().catch((e) => {
  console.error('[seed-tasks] FAILED:', e && e.stack || e);
  process.exit(1);
});
