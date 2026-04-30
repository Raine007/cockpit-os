/**
 * End-to-end notification fabric: lookup prefs → render → outbound dispatch.
 * Uses dry-run Firestore + a fake outbound client.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.COCKPIT_DRY_RUN = '1';
process.env.COCKPIT_LOG_LEVEL = 'error';

import { createContext } from '../src/context/index.js';
import { setPreferences } from '../src/notifications/preferences.js';
import { notify } from '../src/notifications/fabric.js';
import type { OutboundClient } from '../src/webhooks/outbound.js';

function captureClient(): OutboundClient & {
  calls: Array<{ url: string; payload: any }>;
  status: number;
} {
  const calls: Array<{ url: string; payload: any }> = [];
  return {
    calls,
    status: 200,
    async post(url, payload) {
      calls.push({ url, payload });
      return { ok: this.status === 200, status: this.status, body: '' };
    },
  };
}

describe('notify fabric', () => {
  it('drops when no channels configured', async () => {
    const ctx = createContext({ uid: 'u-empty', source: 'rpc' });
    const r = await notify(ctx, {
      uid: 'u-empty',
      kind: 'test',
      title: 't',
      body: 'b',
      severity: 'info',
    });
    assert.equal(r.status, 'dropped');
    assert.match(r.reason ?? '', /no channels configured/);
  });

  it('honors explicit deliver override and skips prefs lookup', async () => {
    const ctx = createContext({ uid: 'u-override', source: 'rpc' });
    const client = captureClient();
    const r = await notify(
      ctx,
      {
        uid: 'u-override',
        kind: 'test',
        title: 'hello',
        body: 'world',
        severity: 'info',
        deliver: { channel: 'imessage', to: '+15555550199' },
      },
      { client, dispatch: { gatewayBaseUrl: 'http://gw' } },
    );
    assert.equal(r.status, 'delivered');
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0]!.payload.channel, 'imessage');
  });

  it('uses preferences when no override', async () => {
    const ctx = createContext({ uid: 'u-prefs', source: 'rpc' });
    await setPreferences(ctx, {
      uid: 'u-prefs',
      quietHours: null,
      channels: [
        { channel: 'telegram', to: '@me', priority: 0, minSeverity: 'info' },
      ],
    });
    const client = captureClient();
    const r = await notify(
      ctx,
      {
        uid: 'u-prefs',
        kind: 'test',
        title: 'pref',
        body: 'use telegram',
        severity: 'info',
      },
      { client, dispatch: { gatewayBaseUrl: 'http://gw' } },
    );
    assert.equal(r.status, 'delivered');
    assert.equal(client.calls[0]!.payload.channel, 'telegram');
    assert.equal(client.calls[0]!.payload.to, '@me');
  });

  it('reports failed when gateway returns 4xx', async () => {
    const ctx = createContext({ uid: 'u-fail', source: 'rpc' });
    const client = captureClient();
    client.status = 401;
    const r = await notify(
      ctx,
      {
        uid: 'u-fail',
        kind: 'test',
        title: 't',
        body: 'b',
        severity: 'info',
        deliver: { channel: 'imessage', to: '+1' },
      },
      { client, dispatch: { gatewayBaseUrl: 'http://gw' } },
    );
    assert.equal(r.status, 'failed');
    assert.match(r.reason ?? '', /401|gateway rejected/);
  });

  it('silent channel never POSTs but reports delivered', async () => {
    const ctx = createContext({ uid: 'u-silent', source: 'rpc' });
    const client = captureClient();
    const r = await notify(
      ctx,
      {
        uid: 'u-silent',
        kind: 'audit',
        title: 't',
        body: 'b',
        severity: 'info',
        deliver: { channel: 'silent', to: 'audit-log' },
      },
      { client, dispatch: { gatewayBaseUrl: 'http://gw' } },
    );
    assert.equal(r.status, 'delivered');
    assert.equal(r.channel, 'silent');
    assert.equal(client.calls.length, 0);
  });
});
