/**
 * vault-tasks.test.mjs — unit tests for the markdown task parser/serializer.
 * Run: node --test bridge/vault-tasks.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTasksFile,
  serializeTasksFile,
  appendDoneSection,
  newTaskId,
  archivePath,
} from './vault-tasks.js';

test('parses empty file', () => {
  const r = parseTasksFile('');
  assert.equal(r.tasks.length, 0);
});

test('parses header-only file', () => {
  const r = parseTasksFile('# Active Tasks\n\nSome intro.\n');
  assert.equal(r.tasks.length, 0);
  assert.match(r.header, /Active Tasks/);
});

test('parses a single open task with all decorators', () => {
  const md = `# Active Tasks

- [ ] Buy milk 📅 2026-05-01 🔺 #shopping @raine
  <!-- id:t_abcd1234 updated:2026-04-30T22:00:00Z owner:raine -->
`;
  const r = parseTasksFile(md);
  assert.equal(r.tasks.length, 1);
  const t = r.tasks[0];
  assert.equal(t.id, 't_abcd1234');
  assert.equal(t.title, 'Buy milk');
  assert.equal(t.done, false);
  assert.equal(t.due, '2026-05-01');
  assert.equal(t.priority, 'high');
  assert.deepEqual(t.tags, ['shopping']);
  assert.equal(t.owner, 'raine');
  assert.equal(t.updated_at, '2026-04-30T22:00:00Z');
});

test('parses a done task with completion date', () => {
  const md = `- [x] Ship feature 📅 2026-04-29 ✅ 2026-04-30 #content @openclaw
  <!-- id:t_done1 updated:2026-04-30T15:00:00Z owner:openclaw -->
`;
  const r = parseTasksFile(md);
  assert.equal(r.tasks.length, 1);
  assert.equal(r.tasks[0].done, true);
  assert.equal(r.tasks[0].completed_on, '2026-04-30');
});

test('parses all priority glyphs', () => {
  const md = `- [ ] High 🔺
  <!-- id:t_1 updated:2026-04-30T00:00:00Z owner:openclaw -->

- [ ] MedHigh 🔼
  <!-- id:t_2 updated:2026-04-30T00:00:00Z owner:openclaw -->

- [ ] Low 🔽
  <!-- id:t_3 updated:2026-04-30T00:00:00Z owner:openclaw -->
`;
  const r = parseTasksFile(md);
  const byId = Object.fromEntries(r.tasks.map((t) => [t.id, t.priority]));
  assert.equal(byId.t_1, 'high');
  assert.equal(byId.t_2, 'medium-high');
  assert.equal(byId.t_3, 'low');
});

test('parses nested notes, feedback, escalation, artifact', () => {
  const md = `- [ ] Big task @openclaw
  <!-- id:t_big updated:2026-04-30T00:00:00Z owner:openclaw -->
  - notes: first line of notes
    second line of notes
  - feedback (raine, 2026-04-30 15:24): looks good
  - escalation: openclaw → claude (2026-04-30 15:31, reason: too heavy)
  - artifact: [output.mp4](https://dropbox/x)
`;
  const r = parseTasksFile(md);
  const t = r.tasks[0];
  assert.match(t.notes, /first line of notes/);
  assert.match(t.notes, /second line of notes/);
  assert.equal(t.feedback.length, 1);
  assert.equal(t.feedback[0].author, 'raine');
  assert.equal(t.feedback[0].text, 'looks good');
  assert.equal(t.escalations.length, 1);
  assert.equal(t.escalations[0].from, 'openclaw');
  assert.equal(t.escalations[0].to, 'claude');
  assert.equal(t.escalations[0].reason, 'too heavy');
  assert.equal(t.artifacts.length, 1);
  assert.equal(t.artifacts[0].name, 'output.mp4');
  assert.equal(t.artifacts[0].url, 'https://dropbox/x');
});

test('parses task missing metadata comment — assigns new id', () => {
  const md = `- [ ] No id task
`;
  const r = parseTasksFile(md);
  assert.equal(r.tasks.length, 1);
  assert.match(r.tasks[0].id, /^t_/);
});

test('multiple tasks separated by blank lines', () => {
  const md = `- [ ] One
  <!-- id:t_one updated:2026-04-30T00:00:00Z owner:openclaw -->

- [ ] Two
  <!-- id:t_two updated:2026-04-30T00:00:00Z owner:openclaw -->

- [x] Three
  <!-- id:t_three updated:2026-04-30T00:00:00Z owner:openclaw -->
`;
  const r = parseTasksFile(md);
  assert.equal(r.tasks.length, 3);
  assert.equal(r.tasks[2].done, true);
});

test('owner not in allowlist falls back to openclaw default', () => {
  const md = `- [ ] Stray @somerandom
  <!-- id:t_x updated:2026-04-30T00:00:00Z -->
`;
  const r = parseTasksFile(md);
  assert.equal(r.tasks[0].owner, 'openclaw');
});

test('tags collected correctly from title', () => {
  const md = `- [ ] Multi-tag #flying #urgent #content @openclaw
  <!-- id:t_m updated:2026-04-30T00:00:00Z owner:openclaw -->
`;
  const r = parseTasksFile(md);
  assert.deepEqual(r.tasks[0].tags, ['flying', 'urgent', 'content']);
});

test('round-trip: parse → serialize → parse equals original task data', () => {
  const original = {
    id: 't_round',
    title: 'Round trip me',
    done: false,
    due: '2026-05-15',
    completed_on: null,
    priority: 'high',
    tags: ['flying', 'urgent'],
    owner: 'claude',
    updated_at: '2026-04-30T20:00:00Z',
    notes: 'two\nlines',
    feedback: [{ author: 'raine', ts: '2026-04-30 15:00', text: 'hi' }],
    escalations: [{ from: 'openclaw', to: 'claude', ts: '2026-04-30 15:30', reason: 'big' }],
    artifacts: [{ name: 'out', url: 'https://x' }],
  };
  const md = serializeTasksFile([original]);
  const back = parseTasksFile(md);
  assert.equal(back.tasks.length, 1);
  const t = back.tasks[0];
  assert.equal(t.id, original.id);
  assert.equal(t.title, original.title);
  assert.equal(t.due, original.due);
  assert.equal(t.priority, original.priority);
  assert.deepEqual(t.tags, original.tags);
  assert.equal(t.owner, original.owner);
  assert.equal(t.notes, original.notes);
  assert.equal(t.feedback.length, 1);
  assert.equal(t.feedback[0].text, 'hi');
  assert.equal(t.escalations.length, 1);
  assert.equal(t.escalations[0].reason, 'big');
  assert.equal(t.artifacts.length, 1);
});

test('serialize sorts open before done, then by due ascending', () => {
  const tasks = [
    { id: 't_a', title: 'A', done: true, due: '2026-04-29', priority: null, tags: [], owner: 'openclaw', updated_at: '2026-04-30T00:00:00Z', notes: '', feedback: [], escalations: [], artifacts: [], completed_on: '2026-04-30' },
    { id: 't_b', title: 'B', done: false, due: '2026-05-10', priority: null, tags: [], owner: 'openclaw', updated_at: '2026-04-30T00:00:00Z', notes: '', feedback: [], escalations: [], artifacts: [], completed_on: null },
    { id: 't_c', title: 'C', done: false, due: '2026-05-01', priority: null, tags: [], owner: 'openclaw', updated_at: '2026-04-30T00:00:00Z', notes: '', feedback: [], escalations: [], artifacts: [], completed_on: null },
  ];
  const md = serializeTasksFile(tasks);
  const cIdx = md.indexOf('id:t_c');
  const bIdx = md.indexOf('id:t_b');
  const aIdx = md.indexOf('id:t_a');
  assert.ok(cIdx < bIdx, 'C before B');
  assert.ok(bIdx < aIdx, 'B before A (done last)');
});

test('newTaskId produces unique ids across 1000 calls', () => {
  const ids = new Set();
  for (let i = 0; i < 1000; i++) ids.add(newTaskId());
  assert.equal(ids.size, 1000);
});

test('newTaskId format is t_ + 8 hex chars', () => {
  const id = newTaskId();
  assert.match(id, /^t_[a-f0-9]{8}$/);
});

test('archivePath returns Tasks/archive/YYYY-MM.md', () => {
  const p = archivePath(new Date('2026-04-30T00:00:00Z'));
  assert.equal(p, 'Tasks/archive/2026-04.md');
});

test('appendDoneSection groups by completion date, newest first', () => {
  const existing = '# Done\n';
  const tasks = [
    { id: 't_a', title: 'A', done: true, due: null, completed_on: '2026-04-29', priority: null, tags: [], owner: 'openclaw', updated_at: '2026-04-29T00:00:00Z', notes: '', feedback: [], escalations: [], artifacts: [] },
    { id: 't_b', title: 'B', done: true, due: null, completed_on: '2026-04-30', priority: null, tags: [], owner: 'openclaw', updated_at: '2026-04-30T00:00:00Z', notes: '', feedback: [], escalations: [], artifacts: [] },
  ];
  const out = appendDoneSection(existing, tasks);
  const idx29 = out.indexOf('## 2026-04-29');
  const idx30 = out.indexOf('## 2026-04-30');
  assert.ok(idx30 < idx29, 'newest day first');
});

test('appendDoneSection on empty input returns existing markdown unchanged', () => {
  const r = appendDoneSection('# Done\n', []);
  assert.equal(r, '# Done\n');
});

test('parses task with no nested content (just title + meta)', () => {
  const md = `- [ ] Simple
  <!-- id:t_simple updated:2026-04-30T00:00:00Z owner:openclaw -->
`;
  const r = parseTasksFile(md);
  assert.equal(r.tasks[0].title, 'Simple');
  assert.equal(r.tasks[0].notes, '');
  assert.equal(r.tasks[0].feedback.length, 0);
});

test('escalation with no reason', () => {
  const md = `- [ ] X
  <!-- id:t_esc updated:2026-04-30T00:00:00Z owner:claude -->
  - escalation: openclaw → claude (2026-04-30 15:31)
`;
  const r = parseTasksFile(md);
  assert.equal(r.tasks[0].escalations[0].reason, '');
  assert.equal(r.tasks[0].escalations[0].to, 'claude');
});

test('multiple feedback entries preserve order', () => {
  const md = `- [ ] X
  <!-- id:t_fb updated:2026-04-30T00:00:00Z owner:openclaw -->
  - feedback (raine, 2026-04-30 10:00): first
  - feedback (raine, 2026-04-30 11:00): second
  - feedback (claude, 2026-04-30 12:00): third
`;
  const r = parseTasksFile(md);
  const fb = r.tasks[0].feedback;
  assert.equal(fb.length, 3);
  assert.equal(fb[0].text, 'first');
  assert.equal(fb[2].author, 'claude');
});

test('serialize writes default header when missing', () => {
  const md = serializeTasksFile([]);
  assert.match(md, /^# Active Tasks/);
});

test('parse tolerates Windows CRLF line endings', () => {
  const md = '- [ ] Win\r\n  <!-- id:t_w updated:2026-04-30T00:00:00Z owner:openclaw -->\r\n';
  const r = parseTasksFile(md);
  assert.equal(r.tasks.length, 1);
  assert.equal(r.tasks[0].id, 't_w');
});

test('unknown nested line gets folded into notes', () => {
  const md = `- [ ] X
  <!-- id:t_u updated:2026-04-30T00:00:00Z owner:openclaw -->
  - some random unknown thing
`;
  const r = parseTasksFile(md);
  assert.match(r.tasks[0].notes, /random unknown thing/);
});

test('done task without ✅ glyph still parses (completed_on stays null)', () => {
  const md = `- [x] Done but no glyph
  <!-- id:t_dn updated:2026-04-30T00:00:00Z owner:openclaw -->
`;
  const r = parseTasksFile(md);
  assert.equal(r.tasks[0].done, true);
  assert.equal(r.tasks[0].completed_on, null);
});

test('round-trip preserves tag order', () => {
  const t = {
    id: 't_tags', title: 'X', done: false, due: null, completed_on: null,
    priority: null, tags: ['z', 'a', 'm'], owner: 'openclaw',
    updated_at: '2026-04-30T00:00:00Z', notes: '', feedback: [], escalations: [], artifacts: [],
  };
  const back = parseTasksFile(serializeTasksFile([t])).tasks[0];
  assert.deepEqual(back.tags, ['z', 'a', 'm']);
});
