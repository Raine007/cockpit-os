/**
 * reconciler.test.mjs — unit tests for last-write-wins merge logic.
 * Run: node --test bridge/reconciler.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeTaskLists, vaultNeedsRewrite } from './reconciler.js';

function task(id, opts = {}) {
  return {
    id,
    title: opts.title || id,
    done: opts.done || false,
    due: opts.due || null,
    completed_on: opts.completed_on || null,
    priority: opts.priority || null,
    tags: opts.tags || [],
    owner: opts.owner || 'openclaw',
    updated_at: opts.updated_at || '2026-04-30T00:00:00Z',
    notes: opts.notes || '',
    feedback: opts.feedback || [],
    escalations: opts.escalations || [],
    artifacts: opts.artifacts || [],
  };
}

test('new task on server only → toVault', () => {
  const s = [task('t_a')];
  const v = [];
  const r = mergeTaskLists(s, v);
  assert.equal(r.merged.length, 1);
  assert.equal(r.toVault.length, 1);
  assert.equal(r.toServer.length, 0);
});

test('new task on vault only → toServer', () => {
  const s = [];
  const v = [task('t_b')];
  const r = mergeTaskLists(s, v);
  assert.equal(r.merged.length, 1);
  assert.equal(r.toServer.length, 1);
  assert.equal(r.toVault.length, 0);
});

test('conflict: server newer wins, queued for vault', () => {
  const s = [task('t_x', { title: 'server', updated_at: '2026-04-30T15:00:00Z' })];
  const v = [task('t_x', { title: 'vault', updated_at: '2026-04-30T14:00:00Z' })];
  const r = mergeTaskLists(s, v);
  assert.equal(r.merged[0].title, 'server');
  assert.equal(r.toVault.length, 1);
  assert.equal(r.toServer.length, 0);
});

test('conflict: vault newer wins, queued for server', () => {
  const s = [task('t_x', { title: 'server', updated_at: '2026-04-30T14:00:00Z' })];
  const v = [task('t_x', { title: 'vault', updated_at: '2026-04-30T15:00:00Z' })];
  const r = mergeTaskLists(s, v);
  assert.equal(r.merged[0].title, 'vault');
  assert.equal(r.toServer.length, 1);
  assert.equal(r.toVault.length, 0);
});

test('tie on updated_at: vault wins (user-facing)', () => {
  const s = [task('t_x', { title: 'server', updated_at: '2026-04-30T15:00:00Z' })];
  const v = [task('t_x', { title: 'vault', updated_at: '2026-04-30T15:00:00Z' })];
  const r = mergeTaskLists(s, v);
  assert.equal(r.merged[0].title, 'vault');
});

test('done task is archived (default archiveAfter=0)', () => {
  const s = [task('t_d', { done: true, completed_on: '2026-04-29' })];
  const v = [task('t_d', { done: true, completed_on: '2026-04-29' })];
  const r = mergeTaskLists(s, v);
  assert.equal(r.merged.length, 0);
  assert.equal(r.archived.length, 1);
});

test('done task within archive grace window stays in merged', () => {
  const now = new Date('2026-04-30T15:00:00Z');
  const s = [task('t_d', { done: true, completed_on: '2026-04-30', updated_at: '2026-04-30T14:30:00Z' })];
  const v = [task('t_d', { done: true, completed_on: '2026-04-30', updated_at: '2026-04-30T14:30:00Z' })];
  // Grace: archive only after 24h
  const r = mergeTaskLists(s, v, now, 24 * 60 * 60 * 1000);
  assert.equal(r.merged.length, 1);
  assert.equal(r.archived.length, 0);
});

test('mixed: open + done + new on each side', () => {
  const s = [
    task('t_open', { title: 'open' }),
    task('t_done', { done: true, completed_on: '2026-04-29' }),
    task('t_only_server'),
  ];
  const v = [
    task('t_open', { title: 'open' }),
    task('t_only_vault'),
  ];
  const r = mergeTaskLists(s, v);
  assert.equal(r.merged.length, 3); // t_open, t_only_server, t_only_vault
  assert.equal(r.archived.length, 1); // t_done
  assert.equal(r.toServer.length, 1); // t_only_vault
  assert.equal(r.toVault.length, 1); // t_only_server
});

test('preserves feedback history when winner has more entries', () => {
  const s = [task('t_f', {
    updated_at: '2026-04-30T15:00:00Z',
    feedback: [{ author: 'raine', ts: '2026-04-30 10:00', text: 'first' }],
  })];
  const v = [task('t_f', {
    updated_at: '2026-04-30T16:00:00Z',
    feedback: [
      { author: 'raine', ts: '2026-04-30 10:00', text: 'first' },
      { author: 'raine', ts: '2026-04-30 16:00', text: 'second' },
    ],
  })];
  const r = mergeTaskLists(s, v);
  assert.equal(r.merged[0].feedback.length, 2);
});

test('empty inputs both sides', () => {
  const r = mergeTaskLists([], []);
  assert.equal(r.merged.length, 0);
  assert.equal(r.archived.length, 0);
  assert.equal(r.toServer.length, 0);
  assert.equal(r.toVault.length, 0);
});

test('merged output is sorted by id (deterministic)', () => {
  const s = [task('t_z'), task('t_a'), task('t_m')];
  const r = mergeTaskLists(s, []);
  assert.deepEqual(r.merged.map((t) => t.id), ['t_a', 't_m', 't_z']);
});

test('vaultNeedsRewrite: identical lists → false', () => {
  const a = [task('t_1', { updated_at: '2026-04-30T00:00:00Z' })];
  const b = [task('t_1', { updated_at: '2026-04-30T00:00:00Z' })];
  assert.equal(vaultNeedsRewrite(a, b), false);
});

test('vaultNeedsRewrite: different timestamp → true', () => {
  const a = [task('t_1', { updated_at: '2026-04-30T00:00:00Z' })];
  const b = [task('t_1', { updated_at: '2026-04-30T01:00:00Z' })];
  assert.equal(vaultNeedsRewrite(a, b), true);
});

test('vaultNeedsRewrite: different lengths → true', () => {
  const a = [task('t_1')];
  const b = [task('t_1'), task('t_2')];
  assert.equal(vaultNeedsRewrite(a, b), true);
});

test('vaultNeedsRewrite: same length, different ids → true', () => {
  const a = [task('t_1')];
  const b = [task('t_2')];
  assert.equal(vaultNeedsRewrite(a, b), true);
});

test('archiving: completed_on missing falls back to updated_at', () => {
  const s = [task('t_d', { done: true, updated_at: '2026-04-29T12:00:00Z' })];
  const r = mergeTaskLists(s, []);
  assert.equal(r.archived.length, 1);
});
