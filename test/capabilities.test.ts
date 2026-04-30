/**
 * Black-box capability tests. We run handlers against the dry-run Firestore
 * shim so they never need credentials.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.COCKPIT_DRY_RUN = '1';
process.env.COCKPIT_LOG_LEVEL = 'error';

import { taskCreate, taskList, flightLog, noteAppend } from '../src/capabilities/index.js';
import { createContext } from '../src/context/index.js';

function ctx() {
  return createContext({ uid: 'test-user', source: 'test', dryRun: true });
}

describe('task-create', () => {
  it('produces a task document', async () => {
    const result = await taskCreate.handler(
      { title: 'ship cockpit-os v0.1' },
      ctx(),
    );
    assert.equal(result.dryRun, true);
    assert.equal(result.task.title, 'ship cockpit-os v0.1');
    assert.equal(result.task.status, 'open');
    assert.equal(result.task.uid, 'test-user');
  });

  it('rejects empty titles', async () => {
    await assert.rejects(() =>
      taskCreate.handler({ title: '' }, ctx()),
    );
  });
});

describe('task-list', () => {
  it('returns a count and an array', async () => {
    const result = await taskList.handler(
      { status: 'open', limit: 10 },
      ctx(),
    );
    assert.ok('count' in result);
    assert.ok(Array.isArray(result.tasks));
  });
});

describe('flight-log', () => {
  it('uppercases tail numbers', async () => {
    const result = await flightLog.handler(
      { tail: 'n12345', route: 'KSDL → KSEZ', hours: 1.4 },
      ctx(),
    );
    assert.equal(result.flight.tail, 'N12345');
    assert.equal(result.flight.hours, 1.4);
  });

  it('rejects invalid tails', async () => {
    await assert.rejects(() =>
      flightLog.handler(
        { tail: '!!!', route: 'KSDL → KSEZ', hours: 1.4 },
        ctx(),
      ),
    );
  });
});

describe('note-append', () => {
  it('returns the appended text', async () => {
    const result = await noteAppend.handler(
      { text: 'cleared right pattern at SDL' },
      ctx(),
    );
    assert.equal(result.appended, 'cleared right pattern at SDL');
    assert.match(result.day, /^\d{4}-\d{2}-\d{2}$/);
  });
});
