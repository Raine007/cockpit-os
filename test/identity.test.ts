/**
 * Phase 5 — Identity resolver tests.
 *
 * Covers bind/revoke/resolve, the createdAt-preservation on rebind, and the
 * "never silently fall back" security property.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.COCKPIT_DRY_RUN = '1';
process.env.COCKPIT_LOG_LEVEL = 'error';

import {
  bindIdentity,
  revokeIdentity,
  resolveIdentity,
  listIdentitiesForUid,
} from '../src/identity/resolver.js';
import { identityDocId } from '../src/identity/types.js';
import { createContext } from '../src/context/index.js';

describe('identity resolver', () => {
  it('binds, resolves, and exposes the underlying identity', async () => {
    const ctx = createContext({ uid: 'system', source: 'webhook' });
    const id = await bindIdentity(ctx, {
      channel: 'imessage',
      handle: '+15551234',
      uid: 'user_alice',
      label: 'Alice phone',
    });
    assert.equal(id.id, identityDocId('imessage', '+15551234'));
    assert.equal(id.uid, 'user_alice');
    assert.equal(id.revokedAt, null);

    const r = await resolveIdentity(ctx, { channel: 'imessage', handle: '+15551234' });
    assert.equal(r.uid, 'user_alice');
    assert.equal(r.identity?.label, 'Alice phone');
  });

  it('returns uid:null with reason "unknown" for unknown handles', async () => {
    const ctx = createContext({ uid: 'system', source: 'webhook' });
    const r = await resolveIdentity(ctx, { channel: 'telegram', handle: 'no-such-id' });
    assert.equal(r.uid, null);
    assert.equal(r.reason, 'unknown');
  });

  it('returns uid:null with reason "revoked" after revokeIdentity', async () => {
    const ctx = createContext({ uid: 'system', source: 'webhook' });
    await bindIdentity(ctx, {
      channel: 'slack',
      handle: 'U-revoked',
      uid: 'user_bob',
    });
    await revokeIdentity(ctx, 'slack', 'U-revoked');
    const r = await resolveIdentity(ctx, { channel: 'slack', handle: 'U-revoked' });
    assert.equal(r.uid, null);
    assert.equal(r.reason, 'revoked');
    assert.ok(r.identity, 'revoked binding still surfaces the identity record');
  });

  it('preserves createdAt when re-binding the same handle', async () => {
    const ctx = createContext({ uid: 'system', source: 'webhook' });
    const first = await bindIdentity(ctx, {
      channel: 'discord',
      handle: 'D-rebind',
      uid: 'user_a',
    });
    // Small delay so timestamps would differ if the resolver mistakenly reset.
    await new Promise((r) => setTimeout(r, 5));
    const second = await bindIdentity(ctx, {
      channel: 'discord',
      handle: 'D-rebind',
      uid: 'user_b',
    });
    assert.equal(second.createdAt, first.createdAt);
    assert.equal(second.uid, 'user_b');
  });

  it('listIdentitiesForUid returns all live + revoked bindings for a uid', async () => {
    const ctx = createContext({ uid: 'system', source: 'webhook' });
    await bindIdentity(ctx, {
      channel: 'imessage',
      handle: '+15551111',
      uid: 'user_multi',
    });
    await bindIdentity(ctx, {
      channel: 'telegram',
      handle: 'tg-multi',
      uid: 'user_multi',
    });
    const all = await listIdentitiesForUid(ctx, 'user_multi');
    assert.equal(all.length >= 2, true);
    const channels = all.map((i) => i.channel).sort();
    assert.ok(channels.includes('imessage'));
    assert.ok(channels.includes('telegram'));
  });

  it('revokeIdentity on missing handle returns null', async () => {
    const ctx = createContext({ uid: 'system', source: 'webhook' });
    const r = await revokeIdentity(ctx, 'whatsapp', 'never-bound');
    assert.equal(r, null);
  });
});
