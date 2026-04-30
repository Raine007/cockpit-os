import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.COCKPIT_LOG_LEVEL = 'error';

import { dispatchOutbound } from '../src/webhooks/outbound.js';
import type {
  OutboundClient,
  OutboundResponse,
} from '../src/webhooks/outbound.js';
import type { OutboundDelivery } from '../src/notifications/types.js';

function fakeClient(responses: OutboundResponse[]): OutboundClient & {
  calls: Array<{ url: string; payload: unknown }>;
} {
  const calls: Array<{ url: string; payload: unknown }> = [];
  return {
    calls,
    async post(url, payload) {
      calls.push({ url, payload });
      const next = responses.shift();
      if (!next) throw new Error('no more responses queued');
      return next;
    },
  };
}

const delivery: OutboundDelivery = {
  channel: 'imessage',
  to: '+15555550199',
  message: { text: 'hi' },
  notificationId: 'ntf_x',
  sentAt: new Date().toISOString(),
};

describe('dispatchOutbound', () => {
  it('succeeds on first 200', async () => {
    const c = fakeClient([{ ok: true, status: 200, body: 'ok' }]);
    const r = await dispatchOutbound(
      delivery,
      { gatewayBaseUrl: 'http://gw', mappingPath: 'cockpit-notify' },
      c,
    );
    assert.equal(r.ok, true);
    assert.equal(r.attempts, 1);
    assert.equal(c.calls[0]!.url, 'http://gw/hooks/cockpit-notify');
  });

  it('retries on 5xx and eventually succeeds', async () => {
    const c = fakeClient([
      { ok: false, status: 503, body: 'busy' },
      { ok: true, status: 200, body: 'ok' },
    ]);
    const r = await dispatchOutbound(
      delivery,
      {
        gatewayBaseUrl: 'http://gw',
        mappingPath: 'cockpit-notify',
        backoffMs: [1, 1, 1],
      },
      c,
    );
    assert.equal(r.ok, true);
    assert.equal(r.attempts, 2);
  });

  it('does not retry on 4xx', async () => {
    const c = fakeClient([{ ok: false, status: 401, body: 'unauthorized' }]);
    const r = await dispatchOutbound(
      delivery,
      { gatewayBaseUrl: 'http://gw', mappingPath: 'cockpit-notify' },
      c,
    );
    assert.equal(r.ok, false);
    assert.equal(r.attempts, 1);
    assert.equal(r.lastStatus, 401);
  });

  it('exhausts retries and reports failure', async () => {
    const c = fakeClient([
      { ok: false, status: 503, body: 'a' },
      { ok: false, status: 503, body: 'b' },
      { ok: false, status: 503, body: 'c' },
    ]);
    const r = await dispatchOutbound(
      delivery,
      {
        gatewayBaseUrl: 'http://gw',
        mappingPath: 'cockpit-notify',
        maxAttempts: 3,
        backoffMs: [1, 1, 1],
      },
      c,
    );
    assert.equal(r.ok, false);
    assert.equal(r.attempts, 3);
  });
});
