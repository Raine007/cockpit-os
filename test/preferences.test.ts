import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { pickChannel } from '../src/notifications/preferences.js';
import type { Preferences } from '../src/notifications/preferences.js';

function prefs(p: Partial<Preferences> = {}): Preferences {
  return {
    uid: 'u',
    channels: [],
    quietHours: null,
    ...p,
  };
}

describe('pickChannel', () => {
  it('returns null when no channels configured', () => {
    assert.equal(pickChannel(prefs(), 'info'), null);
  });

  it('picks the lowest-priority channel meeting severity', () => {
    const p = prefs({
      channels: [
        { channel: 'push', to: 't1', priority: 1, minSeverity: 'info' },
        { channel: 'imessage', to: 't2', priority: 0, minSeverity: 'info' },
      ],
    });
    const r = pickChannel(p, 'info');
    assert.equal(r!.channel, 'imessage');
  });

  it('skips channels whose minSeverity is too high', () => {
    const p = prefs({
      channels: [
        { channel: 'imessage', to: 't1', priority: 0, minSeverity: 'error' },
        { channel: 'push', to: 't2', priority: 1, minSeverity: 'info' },
      ],
    });
    const r = pickChannel(p, 'info');
    assert.equal(r!.channel, 'push');
  });

  it('respects quiet hours for low severity', () => {
    const p = prefs({
      channels: [{ channel: 'imessage', to: 't1', priority: 0, minSeverity: 'info' }],
      quietHours: { from: '00:00', to: '23:59' },
    });
    // 12:00 UTC, severity info → suppressed
    const r = pickChannel(p, 'info', '2026-04-29T12:00:00Z');
    assert.equal(r, null);
  });

  it('warning severity bypasses quiet hours', () => {
    const p = prefs({
      channels: [{ channel: 'imessage', to: 't1', priority: 0, minSeverity: 'info' }],
      quietHours: { from: '00:00', to: '23:59' },
    });
    const r = pickChannel(p, 'warning', '2026-04-29T12:00:00Z');
    assert.equal(r!.channel, 'imessage');
  });

  it('handles wraparound quiet windows (22:00-06:00)', () => {
    const p = prefs({
      channels: [{ channel: 'imessage', to: 't1', priority: 0, minSeverity: 'info' }],
      quietHours: { from: '22:00', to: '06:00' },
    });
    // 02:00 UTC is in the window
    assert.equal(pickChannel(p, 'info', '2026-04-29T02:00:00Z'), null);
    // 12:00 UTC is outside
    assert.equal(pickChannel(p, 'info', '2026-04-29T12:00:00Z')!.channel, 'imessage');
  });
});
