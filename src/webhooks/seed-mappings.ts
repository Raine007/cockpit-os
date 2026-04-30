/**
 * Phase 6 \u2014 Seed inbound mappings.
 *
 * A starter set of `InboundMapping`s so the gateway has real targets to hit
 * out of the box. Each one is intentionally small \u2014 the body shape is
 * documented in-line, the handler builds a job spec, and the inbound
 * webhook handler takes it from there.
 *
 * `registerSeedMappings()` is idempotent across calls so the same process
 * can call it multiple times during boot without throwing on duplicate
 * registration.
 */

import type { InboundEvent } from '../notifications/types.js';

import { inboundRegistry, registerInbound, type InboundMapping } from './inbound.js';

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/* -------------------------------------------------------------------------- */
/* Mappings                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * cockpit-imessage-inbound \u2014 a chat message arrived on iMessage.
 *
 * Expected body: `{ text: string, attachments?: [...] }`. The inbound
 * handler resolves uid from `channel:'imessage'` + `handle` (phone number)
 * before this mapping ever runs, so `event.uid` is already trusted.
 */
export const imessageInboundMapping: InboundMapping = {
  id: 'imessage-inbound',
  description: 'iMessage arrived for the user',
  toJob(event: InboundEvent) {
    const body = asRecord(event.body);
    const text = asString(body.text);
    if (!text) return null; // Empty messages drop silently.
    return {
      uid: event.uid ?? 'system',
      intent: 'chat.message.received',
      payload: {
        channel: 'imessage',
        handle: event.handle,
        text,
        attachments: body.attachments ?? [],
      },
      // Echo back to the same channel by default. Capability handlers can
      // override this if they want a different surface.
      ...(event.handle && {
        deliver: { channel: 'imessage' as const, to: event.handle },
      }),
    };
  },
};

/**
 * cockpit-telegram-inbound \u2014 same shape as iMessage but on Telegram.
 */
export const telegramInboundMapping: InboundMapping = {
  id: 'telegram-inbound',
  description: 'Telegram message arrived for the user',
  toJob(event: InboundEvent) {
    const body = asRecord(event.body);
    const text = asString(body.text);
    if (!text) return null;
    return {
      uid: event.uid ?? 'system',
      intent: 'chat.message.received',
      payload: {
        channel: 'telegram',
        handle: event.handle,
        text,
      },
      ...(event.handle && {
        deliver: { channel: 'telegram' as const, to: event.handle },
      }),
    };
  },
};

/**
 * cockpit-slack-inbound \u2014 Slack message / mention.
 */
export const slackInboundMapping: InboundMapping = {
  id: 'slack-inbound',
  description: 'Slack message or mention',
  toJob(event: InboundEvent) {
    const body = asRecord(event.body);
    const text = asString(body.text);
    if (!text) return null;
    return {
      uid: event.uid ?? 'system',
      intent: 'chat.message.received',
      payload: {
        channel: 'slack',
        handle: event.handle,
        text,
        threadTs: body.threadTs,
      },
      ...(event.handle && {
        deliver: { channel: 'slack' as const, to: event.handle },
      }),
    };
  },
};

/**
 * cockpit-task-due \u2014 a task is due. Body: `{ taskId, title, dueAt }`.
 *
 * Spawns a `task.due` job which the dispatcher routes to the right
 * capability (notification + optional automated handling).
 */
export const taskDueMapping: InboundMapping = {
  id: 'task-due',
  description: 'A task hit its due date',
  toJob(event: InboundEvent) {
    const body = asRecord(event.body);
    const taskId = asString(body.taskId);
    if (!taskId) return null;
    if (!event.uid) return null; // Tasks without a uid have nowhere to go.
    return {
      uid: event.uid,
      intent: 'task.due',
      payload: {
        taskId,
        title: asString(body.title, 'Task'),
        dueAt: asString(body.dueAt),
      },
    };
  },
};

/**
 * cockpit-permission-granted \u2014 the user just granted a permission on the
 * gateway side (e.g. accepted a Dropbox OAuth flow). Cockpit logs it and
 * notifies the user that the grant is live.
 */
export const permissionGrantedMapping: InboundMapping = {
  id: 'permission-granted',
  description: 'User granted a permission on the gateway',
  toJob(event: InboundEvent) {
    const body = asRecord(event.body);
    const scope = asString(body.scope);
    if (!scope) return null;
    if (!event.uid) return null;
    return {
      uid: event.uid,
      intent: 'permission.granted',
      payload: {
        scope,
        provider: asString(body.provider, 'unknown'),
      },
    };
  },
};

/**
 * cockpit-intent \u2014 generic escape hatch. Body: `{ intent, payload?, deliver? }`.
 *
 * Useful for ad-hoc integrations and CLI testing where you want to fire a
 * specific Cockpit intent without writing a mapping for it. The intent
 * must already exist in the dispatcher router \u2014 unknown intents fail
 * loudly when the engine tries to dispatch.
 */
export const genericIntentMapping: InboundMapping = {
  id: 'intent',
  description: 'Generic intent dispatcher (CLI / test)',
  toJob(event: InboundEvent) {
    const body = asRecord(event.body);
    const intent = asString(body.intent);
    if (!intent) return null;
    if (!event.uid) return null;
    const deliver = body.deliver as
      | { channel: string; to: string }
      | undefined;
    return {
      uid: event.uid,
      intent,
      payload: asRecord(body.payload),
      ...(deliver && {
        deliver: deliver as { channel: 'imessage'; to: string },
      }),
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Registration                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The seed set, in registration order. Exported so callers can inspect or
 * reorder before registering.
 */
export const seedMappings: readonly InboundMapping[] = [
  imessageInboundMapping,
  telegramInboundMapping,
  slackInboundMapping,
  taskDueMapping,
  permissionGrantedMapping,
  genericIntentMapping,
] as const;

/**
 * Register every seed mapping, skipping any whose id is already registered.
 * Safe to call multiple times.
 */
export function registerSeedMappings(): InboundMapping[] {
  const registered: InboundMapping[] = [];
  for (const m of seedMappings) {
    if (inboundRegistry.get(m.id)) continue;
    registered.push(registerInbound(m));
  }
  return registered;
}
