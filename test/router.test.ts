import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.COCKPIT_DRY_RUN = '1';
process.env.COCKPIT_LOG_LEVEL = 'error';

import '../src/capabilities/index.js';
import {
  routeJob,
  registerIntent,
  intentRegistry,
  COMPUTER_TOKEN_THRESHOLD,
} from '../src/dispatcher/index.js';

describe('routeJob', () => {
  it('honors explicit worker overrides', () => {
    const r = routeJob({
      uid: 'u',
      intent: 'cap:task-create',
      source: 'test',
      worker: 'computer',
    });
    assert.equal(r.worker, 'computer');
    assert.equal(r.reason, 'explicit-override');
  });

  it('routes capability intents local', () => {
    const r = routeJob({ uid: 'u', intent: 'cap:task-create', source: 'test' });
    assert.equal(r.worker, 'local');
    assert.equal(r.reason, 'capability-intent');
  });

  it('routes unknown capability intents local with a clear reason', () => {
    const r = routeJob({ uid: 'u', intent: 'cap:does-not-exist', source: 'test' });
    assert.equal(r.worker, 'local');
    assert.equal(r.reason, 'capability-unknown');
  });

  it('routes registered compound intents to their preferred worker', () => {
    intentRegistry._resetForTesting();
    registerIntent({
      id: 'weekly-review-test',
      description: 'Weekly review fixture',
      preferredWorker: 'computer',
    });
    const r = routeJob({ uid: 'u', intent: 'weekly-review-test', source: 'test' });
    assert.equal(r.worker, 'computer');
    assert.equal(r.reason, 'compound-intent');
  });

  it('uses the token-budget heuristic for unregistered intents', () => {
    intentRegistry._resetForTesting();
    const r = routeJob({
      uid: 'u',
      intent: 'ad-hoc',
      source: 'test',
      context: { estimatedTokens: COMPUTER_TOKEN_THRESHOLD + 1 },
    });
    assert.equal(r.worker, 'computer');
    assert.equal(r.reason, 'token-budget');
  });

  it('keeps tight-deadline jobs local even when compound says otherwise', () => {
    intentRegistry._resetForTesting();
    registerIntent({
      id: 'weekly-review-test',
      description: 'Weekly review fixture',
      preferredWorker: 'computer',
    });
    const deadline = new Date(Date.now() + 5_000).toISOString();
    const r = routeJob({
      uid: 'u',
      intent: 'weekly-review-test',
      source: 'test',
      context: { deadlineAt: deadline },
    });
    assert.equal(r.worker, 'local');
    assert.equal(r.reason, 'tight-deadline');
  });

  it('falls back to local for unknown intents below threshold', () => {
    intentRegistry._resetForTesting();
    const r = routeJob({ uid: 'u', intent: 'nope', source: 'test' });
    assert.equal(r.worker, 'local');
    assert.equal(r.reason, 'default-local');
  });
});
