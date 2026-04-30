/**
 * Phase 6 — Seed mappings tests.
 *
 * Each mapping translates an InboundEvent into a job spec; we test that
 * translation directly, plus the registration helper.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.COCKPIT_DRY_RUN = '1';
process.env.COCKPIT_LOG_LEVEL = 'error';

import {
  imessageInboundMapping,
  permissionGrantedMapping,
  registerSeedMappings,
  seedMappings,
  taskDueMapping,
  telegramInboundMapping,
  slackInboundMapping,
  genericIntentMapping,
} from '../src/webhooks/seed-mappings.js';
import { inboundRegistry } from '../src/webhooks/inbound.js';

beforeEach(() => {
  inboundRegistry._resetForTesting();
});

describe('imessageInboundMapping', () => {
  it('builds a chat.message.received job', () => {
    const spec = imessageInboundMapping.toJob({
      mappingId: 'imessage-inbound',
      uid: 'user_im',
      handle: '+15551234',
      body: { text: 'hello' },
    });
    assert.ok(spec);
    assert.equal(spec?.intent, 'chat.message.received');
    assert.equal(spec?.uid, 'user_im');
    assert.equal(spec?.deliver?.channel, 'imessage');
    assert.equal(spec?.deliver?.to, '+15551234');
    assert.equal((spec?.payload as { text: string }).text, 'hello');
  });

  it('drops empty messages', () => {
    const spec = imessageInboundMapping.toJob({
      mappingId: 'imessage-inbound',
      uid: 'user_im',
      handle: '+15551234',
      body: { text: '' },
    });
    assert.equal(spec, null);
  });

  it('falls back to system uid if missing', () => {
    const spec = imessageInboundMapping.toJob({
      mappingId: 'imessage-inbound',
      handle: '+15551234',
      body: { text: 'orphan' },
    });
    assert.equal(spec?.uid, 'system');
  });
});

describe('telegramInboundMapping', () => {
  it('returns null without text', () => {
    const spec = telegramInboundMapping.toJob({
      mappingId: 'telegram-inbound',
      body: {},
    });
    assert.equal(spec, null);
  });
  it('builds spec with handle echo-back', () => {
    const spec = telegramInboundMapping.toJob({
      mappingId: 'telegram-inbound',
      uid: 'u',
      handle: 'tg-1',
      body: { text: 'hi' },
    });
    assert.equal(spec?.deliver?.channel, 'telegram');
    assert.equal(spec?.deliver?.to, 'tg-1');
  });
});

describe('slackInboundMapping', () => {
  it('captures threadTs', () => {
    const spec = slackInboundMapping.toJob({
      mappingId: 'slack-inbound',
      uid: 'u',
      handle: 'U-slack',
      body: { text: 'hi', threadTs: '1234.5678' },
    });
    assert.equal(
      (spec?.payload as { threadTs: string }).threadTs,
      '1234.5678',
    );
  });
});

describe('taskDueMapping', () => {
  it('requires uid and taskId', () => {
    assert.equal(
      taskDueMapping.toJob({
        mappingId: 'task-due',
        body: { title: 'no uid' },
      }),
      null,
    );
    assert.equal(
      taskDueMapping.toJob({
        mappingId: 'task-due',
        uid: 'u',
        body: {},
      }),
      null,
    );
  });

  it('builds a task.due job', () => {
    const spec = taskDueMapping.toJob({
      mappingId: 'task-due',
      uid: 'user_task',
      body: { taskId: 't1', title: 'Do thing', dueAt: '2026-05-01T10:00:00Z' },
    });
    assert.equal(spec?.intent, 'task.due');
    assert.equal((spec?.payload as { taskId: string }).taskId, 't1');
  });
});

describe('permissionGrantedMapping', () => {
  it('drops without scope', () => {
    const spec = permissionGrantedMapping.toJob({
      mappingId: 'permission-granted',
      uid: 'u',
      body: {},
    });
    assert.equal(spec, null);
  });
  it('builds a permission.granted job', () => {
    const spec = permissionGrantedMapping.toJob({
      mappingId: 'permission-granted',
      uid: 'user_perm',
      body: { scope: 'dropbox.write', provider: 'dropbox' },
    });
    assert.equal(spec?.intent, 'permission.granted');
  });
});

describe('genericIntentMapping', () => {
  it('forwards intent verbatim', () => {
    const spec = genericIntentMapping.toJob({
      mappingId: 'intent',
      uid: 'user_g',
      body: { intent: 'cap:noop', payload: { foo: 1 } },
    });
    assert.equal(spec?.intent, 'cap:noop');
    assert.equal((spec?.payload as { foo: number }).foo, 1);
  });
  it('drops without intent', () => {
    const spec = genericIntentMapping.toJob({
      mappingId: 'intent',
      uid: 'u',
      body: {},
    });
    assert.equal(spec, null);
  });
});

describe('registerSeedMappings', () => {
  it('registers every seed mapping by id', () => {
    const reg = registerSeedMappings();
    assert.equal(reg.length, seedMappings.length);
    for (const m of seedMappings) {
      assert.ok(inboundRegistry.get(m.id));
    }
  });

  it('is idempotent across calls', () => {
    registerSeedMappings();
    const second = registerSeedMappings();
    // Second call should be a no-op (everything already registered).
    assert.equal(second.length, 0);
  });
});
