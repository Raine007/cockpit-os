/**
 * vault-tasks.js — Markdown parser/serializer for Tasks/Active.md and Done.md.
 *
 * Pure functions only. No I/O. The bridge calls these from reconciler.js.
 *
 * Format spec (Obsidian Tasks plugin compatible):
 *
 *   - [ ] Title text 📅 2026-05-03 🔺 #flying @openclaw
 *     <!-- id:t_8f2a updated:2026-04-30T22:24:00Z owner:openclaw -->
 *     - notes: free text, may continue on
 *       another indented line
 *     - feedback (raine, 2026-04-30 15:24): comment text
 *     - escalation: openclaw → claude (2026-04-30 15:31, reason: too heavy)
 *     - artifact: [name](https://example/url)
 *
 * Top-level "- [ ]" / "- [x]" starts a new task. Anything indented underneath
 * belongs to the preceding task until the next top-level bullet or a blank line
 * followed by a top-level bullet. We tolerate blank lines inside a task block
 * if the next line is still indented.
 *
 * Round-trip guarantee: parseTasksFile(serializeTasksFile(tasks)) returns
 * an equivalent task list (same ids, same field values).
 */

import crypto from 'node:crypto';

/* ─────────────── Constants ─────────────── */

const PRIORITY_GLYPHS = {
  '🔺': 'high',
  '🔼': 'medium-high',
  '🔽': 'low',
};
const PRIORITY_TO_GLYPH = Object.fromEntries(
  Object.entries(PRIORITY_GLYPHS).map(([g, p]) => [p, g]),
);

const VALID_OWNERS = ['openclaw', 'claude', 'raine', 'perplexity'];

const DATE_DUE_RE = /📅\s*(\d{4}-\d{2}-\d{2})/;
const DATE_DONE_RE = /✅\s*(\d{4}-\d{2}-\d{2})/;
const TAG_RE = /(?:^|\s)#([a-zA-Z0-9_\-]+)/g;
const OWNER_RE = /(?:^|\s)@([a-zA-Z0-9_\-]+)/;
const META_RE = /^\s*<!--\s*(.+?)\s*-->\s*$/;
const TASK_OPEN_RE = /^- \[ \]\s+(.*)$/;
const TASK_DONE_RE = /^- \[x\]\s+(.*)$/i;
const NESTED_RE = /^\s+-\s+(.*)$/;
const NOTE_RE = /^notes?:\s*(.*)$/i;
const FEEDBACK_RE = /^feedback\s*\(([^,]+),\s*([^)]+)\):\s*(.*)$/i;
const ESCALATION_RE =
  /^escalation:\s*([a-zA-Z0-9_\-]+)\s*(?:→|->)\s*([a-zA-Z0-9_\-]+)\s*\(([^,)]+)(?:,\s*reason:\s*([^)]*))?\)\s*$/i;
const ARTIFACT_RE = /^artifact:\s*\[([^\]]+)\]\(([^)]+)\)\s*$/i;

/* ─────────────── Helpers ─────────────── */

export function newTaskId() {
  return 't_' + crypto.randomBytes(4).toString('hex');
}

export function nowIso() {
  return new Date().toISOString();
}

export function archivePath(date) {
  const d = date instanceof Date ? date : new Date(date);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `Tasks/archive/${yyyy}-${mm}.md`;
}

function parseMetaComment(line) {
  const m = META_RE.exec(line);
  if (!m) return null;
  const out = {};
  for (const tok of m[1].split(/\s+/)) {
    const eq = tok.indexOf(':');
    if (eq <= 0) continue;
    const k = tok.slice(0, eq).trim();
    const v = tok.slice(eq + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

function extractTagsAndOwner(text) {
  const tags = [];
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(text)) !== null) {
    tags.push(m[1]);
  }
  const ownerMatch = OWNER_RE.exec(text);
  const owner = ownerMatch && VALID_OWNERS.includes(ownerMatch[1]) ? ownerMatch[1] : null;
  return { tags, owner };
}

function extractPriority(text) {
  for (const glyph of Object.keys(PRIORITY_GLYPHS)) {
    if (text.includes(glyph)) return PRIORITY_GLYPHS[glyph];
  }
  return null;
}

function stripDecorators(title) {
  return title
    .replace(DATE_DUE_RE, '')
    .replace(DATE_DONE_RE, '')
    .replace(/🔺|🔼|🔽/g, '')
    .replace(TAG_RE, ' ')
    .replace(OWNER_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function emptyTask() {
  return {
    id: '',
    title: '',
    done: false,
    due: null,
    completed_on: null,
    priority: null,
    tags: [],
    owner: 'openclaw',
    updated_at: nowIso(),
    notes: '',
    feedback: [],
    escalations: [],
    artifacts: [],
  };
}

function applyNested(task, content) {
  const note = NOTE_RE.exec(content);
  if (note) {
    task.notes = task.notes ? task.notes + '\n' + note[1] : note[1];
    task._lastNested = 'notes';
    return;
  }
  const fb = FEEDBACK_RE.exec(content);
  if (fb) {
    task.feedback.push({
      author: fb[1].trim(),
      ts: fb[2].trim(),
      text: fb[3].trim(),
    });
    task._lastNested = 'feedback';
    return;
  }
  const esc = ESCALATION_RE.exec(content);
  if (esc) {
    task.escalations.push({
      from: esc[1].trim(),
      to: esc[2].trim(),
      ts: esc[3].trim(),
      reason: (esc[4] || '').trim(),
    });
    task._lastNested = 'escalation';
    return;
  }
  const art = ARTIFACT_RE.exec(content);
  if (art) {
    task.artifacts.push({ name: art[1].trim(), url: art[2].trim() });
    task._lastNested = 'artifact';
    return;
  }
  // Unknown nested line — append to notes for forward compatibility.
  task.notes = task.notes ? task.notes + '\n' + content : content;
  task._lastNested = 'notes';
}

/* ─────────────── parseTasksFile ─────────────── */

export function parseTasksFile(markdown) {
  const tasks = [];
  const lines = (markdown || '').split(/\r?\n/);
  let header = '';
  let trailing = '';
  let current = null;
  let headerDone = false;
  const warnings = [];

  // Capture header (everything before the first task line).
  let i = 0;
  for (; i < lines.length; i++) {
    if (TASK_OPEN_RE.test(lines[i]) || TASK_DONE_RE.test(lines[i])) break;
    header += (header ? '\n' : '') + lines[i];
  }
  headerDone = true;

  function commit() {
    if (!current) return;
    if (!current.id) {
      // Tasks without IDs are still emitted (caller will assign one); they
      // came from a human editing the file directly.
      current.id = newTaskId();
      current._neededId = true;
    }
    delete current._lastNested;
    tasks.push(current);
    current = null;
  }

  for (; i < lines.length; i++) {
    const raw = lines[i];
    const openM = TASK_OPEN_RE.exec(raw);
    const doneM = TASK_DONE_RE.exec(raw);

    if (openM || doneM) {
      commit();
      current = emptyTask();
      current.done = !!doneM;
      const titleRaw = (openM || doneM)[1];
      current.due = (DATE_DUE_RE.exec(titleRaw) || [])[1] || null;
      current.completed_on = (DATE_DONE_RE.exec(titleRaw) || [])[1] || null;
      current.priority = extractPriority(titleRaw);
      const { tags, owner } = extractTagsAndOwner(titleRaw);
      current.tags = tags;
      if (owner) current.owner = owner;
      current.title = stripDecorators(titleRaw);
      continue;
    }

    if (!current) {
      // Stray content between tasks — tack onto trailing.
      trailing += (trailing ? '\n' : '') + raw;
      continue;
    }

    // Metadata comment line(s)
    const meta = parseMetaComment(raw);
    if (meta) {
      if (meta.id) current.id = meta.id;
      if (meta.updated) current.updated_at = meta.updated;
      if (meta.owner && VALID_OWNERS.includes(meta.owner)) current.owner = meta.owner;
      continue;
    }

    // Nested bullet
    const nested = NESTED_RE.exec(raw);
    if (nested) {
      applyNested(current, nested[1]);
      continue;
    }

    // Continuation of a nested bullet (deeper indent, no leading dash)
    if (/^\s{2,}\S/.test(raw) && current._lastNested === 'notes') {
      const trimmed = raw.replace(/^\s+/, '');
      current.notes = current.notes ? current.notes + '\n' + trimmed : trimmed;
      continue;
    }

    // Blank line — keep current open for potential continuation
    if (raw.trim() === '') continue;

    // Anything else terminates the task block.
    commit();
    trailing += (trailing ? '\n' : '') + raw;
  }
  commit();

  return { tasks, header: header.trim(), trailing: trailing.trim(), warnings };
}

/* ─────────────── serializeTasksFile ─────────────── */

function serializeTask(t) {
  const checkbox = t.done ? '- [x]' : '- [ ]';
  const parts = [t.title];
  if (t.due) parts.push(`📅 ${t.due}`);
  if (t.priority && PRIORITY_TO_GLYPH[t.priority]) parts.push(PRIORITY_TO_GLYPH[t.priority]);
  for (const tag of t.tags || []) parts.push(`#${tag}`);
  if (t.owner) parts.push(`@${t.owner}`);
  if (t.completed_on) parts.push(`✅ ${t.completed_on}`);

  const headLine = `${checkbox} ${parts.join(' ')}`;
  const metaLine = `  <!-- id:${t.id} updated:${t.updated_at} owner:${t.owner || 'openclaw'} -->`;
  const out = [headLine, metaLine];

  if (t.notes && t.notes.trim()) {
    const noteLines = t.notes.split('\n');
    out.push(`  - notes: ${noteLines[0]}`);
    for (let i = 1; i < noteLines.length; i++) out.push(`    ${noteLines[i]}`);
  }
  for (const fb of t.feedback || []) {
    out.push(`  - feedback (${fb.author}, ${fb.ts}): ${fb.text}`);
  }
  for (const esc of t.escalations || []) {
    const reason = esc.reason ? `, reason: ${esc.reason}` : '';
    out.push(`  - escalation: ${esc.from} → ${esc.to} (${esc.ts}${reason})`);
  }
  for (const art of t.artifacts || []) {
    out.push(`  - artifact: [${art.name}](${art.url})`);
  }
  return out.join('\n');
}

function sortKey(t) {
  // Open before done; then due ascending (no due last); then priority high-first.
  const doneRank = t.done ? 1 : 0;
  const dueRank = t.due ? t.due : '9999-99-99';
  const prioRank =
    t.priority === 'high' ? 0 : t.priority === 'medium-high' ? 1 : t.priority === 'low' ? 3 : 2;
  return `${doneRank}|${dueRank}|${prioRank}|${t.title}`;
}

export function serializeTasksFile(tasks, header) {
  const sorted = [...(tasks || [])].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const headerOut = header && header.trim() ? header.trim() : '# Active Tasks';
  const body = sorted.map(serializeTask).join('\n\n');
  return body ? `${headerOut}\n\n${body}\n` : `${headerOut}\n`;
}

/* ─────────────── Done.md helpers ─────────────── */

/**
 * Append-only Done.md. Each archived task is appended as a new block,
 * grouped under a `## YYYY-MM-DD` heading by completion date so the file
 * stays scannable. Caller must read existing Done.md first and pass it.
 */
export function appendDoneSection(existingDoneMarkdown, tasksToArchive) {
  if (!tasksToArchive || tasksToArchive.length === 0) {
    return existingDoneMarkdown || '# Done\n';
  }
  const grouped = new Map();
  for (const t of tasksToArchive) {
    const day = t.completed_on || (t.updated_at || '').slice(0, 10) || 'undated';
    if (!grouped.has(day)) grouped.set(day, []);
    grouped.get(day).push(t);
  }
  const days = [...grouped.keys()].sort().reverse();
  let appended = '';
  for (const day of days) {
    appended += `\n## ${day}\n\n`;
    for (const t of grouped.get(day)) {
      appended += serializeTask(t) + '\n\n';
    }
  }
  const base = existingDoneMarkdown && existingDoneMarkdown.trim()
    ? existingDoneMarkdown.replace(/\s+$/, '')
    : '# Done';
  return base + '\n' + appended.trimEnd() + '\n';
}
