/**
 * Firestore trigger handlers — onJobCreated drives the engine,
 * onJobUpdated fires terminal-state notifications.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.COCKPIT_DRY_RUN = '1';
process.env.COCKPIT_LOG_LEVEL = 'error';

import '../src/capabilities/index.js';
import { submit, getJob } from '../src/dispatcher/index.js';
import { createContext } from '../src/context/index.js';
import {
  handleJobCreated,
  handleJobUpdated,
  jobToNotification,
} from '../src/functions/triggers.js';
import type { OutboundClient } from '../src/webhooks/outbound.js';

function captureClient(): OutboundClient & {
  calls: Array<{ url: string; payload: any }>;
} {
  const calls: Array<{ url: string; payload: any }> = [];
  return {
    calls,
    async post(url, payload) {
      calls.push({ url, payload });
      return { ok: true, status: 200, body: '' };
    },
  };
}

describe('handleJobCreated', () => {
  it('drives a queued job through the engine', async () => {
    const submitted = await submit(
      {
        uid: 'u',
        intent: 'cap:task-create',
        source: 'rpc',
        payload: { title: 'driven by trigger' },
      },
      { drive: false },
    );
    assert.equal(submitted.job.status, 'queued');

    const result = await handleJobCreated(submitted.job);
    assert.equal(result.status, 'ok');

    const ctx = createContext({ uid: 'u', source: 'rpc' });
    const after = await getJob(ctx, submitted.job.id);
    assert.equal(after?.status, 'done');
  });

  it('skips non-queued jobs (idempotent against re-delivery)', async () => {
    const submitted = await submit(
      {
        uid: 'u',
        intent: 'cap:task-create',
        source: 'rpc',
        payload: { title: 'already done' },
      },
      { drive: true },
    );
    const r = await handleJobCreated(submitted.job);
    assert.equal(r.status, 'skipped');
  });

  it('skips invalid documents without throwing', async () => {
    const r = await handleJobCreated({ not: 'a job' });
    assert.equal(r.status, 'skipped');
    assert.match(r.reason ?? '', /invalid job/);
  });
});

describe('handleJobUpdated', () => {
  it('notifies when a job transitions to done', async () => {
    const submitted = await submit(
      {
        uid: 'u',
        intent: 'cap:task-create',
        source: 'rpc',
        payload: { title: 'notify me' },
        deliver: { channel: 'imessage', to: '+15555550199' },
      },
      { drive: false },
    );
    const before = submitted.job;
    await handleJobCreated(before); // drives to done

    const ctx = createContext({ uid: 'u', source: 'rpc' });
    const after = await getJob(ctx, before.id);
    assert.ok(after);

    const client = captureClient();
    const r = await handleJobUpdated(before, after!, {
      notify: { client, dispatch: { gatewayBaseUrl: 'http://gw' } },
    });
    assert.equal(r.status, 'notified');
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0]!.payload.channel, 'imessage');
    assert.match(client.calls[0]!.payload.message.text, /Done: cap:task-create/);
  });

  it('does not re-notify when prev was already terminal', async () => {
    const submitted = await submit(
      {
        uid: 'u',
        intent: 'cap:task-create',
        source: 'rpc',
        payload: { title: 'no double notify' },
      },
      { drive: true },
    );
    const job = submitted.job;
    const client = captureClient();
    const r = await handleJobUpdated(job, job, {
      notify: { client, dispatch: { gatewayBaseUrl: 'http://gw' } },
    });
    assert.equal(r.status, 'skipped');
    assert.equal(client.calls.length, 0);
  });
});

describe('jobToNotification', () => {
  it('renders done jobs with success severity and artifact links', () => {
    const n = jobToNotification({
      id: 'j1',
      uid: 'u',
      intent: 'flight-anomaly-report',
      payload: {},
      worker: 'computer',
      status: 'done',
      version: 4,
      artifacts: [{ kind: 'pdf', url: 'https://example.com/r.pdf', label: 'Report' }],
      attempts: 1,
      maxAttempts: 3,
      lastError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      source: 'rpc',
      context: {},
    });
    assert.equal(n.severity, 'success');
    assert.equal(n.links?.length, 1);
    assert.equal(n.links![0]!.label, 'Report');
  });

  it('renders failed jobs with error severity and last error', () => {
    const n = jobToNotification({
      id: 'j2',
      uid: 'u',
      intent: 'cap:task-create',
      payload: {},
      worker: 'local',
      status: 'failed',
      version: 2,
      artifacts: [],
      attempts: 3,
      maxAttempts: 3,
      lastError: 'boom',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      source: 'rpc',
      context: {},
    });
    assert.equal(n.severity, 'error');
    assert.match(n.body, /boom/);
  });
});
