/**
 * Notification fabric — the single entry point Cockpit OS uses to reach the
 * user. Does *not* know about Firestore beyond reading prefs; does *not*
 * know about HTTP beyond a pluggable client. That keeps the fabric pure and
 * trivially testable.
 *
 * Flow:
 *   notify()
 *     \u2192 lookup prefs (or honor explicit deliver override)
 *     \u2192 pick channel
 *     \u2192 render
 *     \u2192 hand to outbound dispatcher
 *
 * Audit: every call \u2014 delivered, dropped, or failed \u2014 is logged with the
 * notification id so we can trace why a given message did or didn't appear
 * on a channel.
 */

import { emitAuditEvent } from '../audit/log.js';
import { logger } from '../context/logger.js';
import type { CockpitContext } from '../context/types.js';
import {
  dispatchOutbound,
  type DispatchOptions,
  type OutboundClient,
} from '../webhooks/outbound.js';
import { getPreferences, pickChannel } from './preferences.js';
import { renderForChannel } from './render.js';
import {
  NotificationSchema,
  type Notification,
  type OutboundDelivery,
} from './types.js';

export interface NotifyOptions {
  /** Where the gateway lives. Defaults to env or 127.0.0.1:18789. */
  dispatch?: Partial<DispatchOptions> & { mappingPath?: string };
  /** HTTP client, for tests. */
  client?: OutboundClient;
  /** Override "now" for deterministic quiet-hours tests. */
  nowIso?: string;
}

export interface NotifyResult {
  status: 'delivered' | 'dropped' | 'failed';
  notificationId: string;
  channel?: OutboundDelivery['channel'];
  to?: string;
  reason?: string;
  attempts?: number;
}

const DEFAULT_GATEWAY =
  process.env.OPENCLAW_GATEWAY_BASE_URL ?? 'http://127.0.0.1:18789';
const DEFAULT_MAPPING_PATH =
  process.env.OPENCLAW_HOOKS_OUTBOUND_PATH ?? 'cockpit-notify';

function newNotificationId(): string {
  return `ntf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function notify(
  ctx: CockpitContext,
  input: Notification,
  opts: NotifyOptions = {},
): Promise<NotifyResult> {
  const notif = NotificationSchema.parse(input);
  const id = newNotificationId();
  const now = opts.nowIso ?? new Date().toISOString();

  // 1. Decide channel.
  let channel: OutboundDelivery['channel'];
  let to: string;

  if (notif.deliver) {
    channel = notif.deliver.channel;
    to = notif.deliver.to;
  } else {
    const prefs = await getPreferences(ctx, notif.uid);
    const pick = pickChannel(prefs, notif.severity, now);
    if (!pick) {
      const reason = prefs.channels.length
        ? 'filtered by severity or quiet hours'
        : 'no channels configured';
      logger.warn('notification dropped', { id, uid: notif.uid, reason });
      await emitAuditEvent(ctx, {
        kind: 'notification.dropped',
        uid: notif.uid,
        source: 'fabric',
        ref: id,
        data: { kind: notif.kind, severity: notif.severity, reason },
      });
      return { status: 'dropped', notificationId: id, reason };
    }
    channel = pick.channel;
    to = pick.to;
  }

  // 2. Silent channel: log + done. Useful for audit-only notifications.
  if (channel === 'silent') {
    logger.info('notification silent', { id, uid: notif.uid, kind: notif.kind });
    await emitAuditEvent(ctx, {
      kind: 'notification.delivered',
      uid: notif.uid,
      source: 'fabric',
      ref: id,
      data: { channel: 'silent', kind: notif.kind },
    });
    return { status: 'delivered', notificationId: id, channel, to };
  }

  // 3. Render.
  const message = renderForChannel(notif, channel);
  const delivery: OutboundDelivery = {
    channel,
    to,
    message,
    notificationId: id,
    sentAt: now,
  };

  // 4. Dispatch.
  const dispatchOpts: DispatchOptions = {
    gatewayBaseUrl: opts.dispatch?.gatewayBaseUrl ?? DEFAULT_GATEWAY,
    mappingPath: opts.dispatch?.mappingPath ?? DEFAULT_MAPPING_PATH,
    ...(opts.dispatch?.maxAttempts !== undefined && { maxAttempts: opts.dispatch.maxAttempts }),
    ...(opts.dispatch?.backoffMs !== undefined && { backoffMs: opts.dispatch.backoffMs }),
  };
  const result = await dispatchOutbound(delivery, dispatchOpts, opts.client);

  if (result.ok) {
    await emitAuditEvent(ctx, {
      kind: 'notification.delivered',
      uid: notif.uid,
      source: 'fabric',
      ref: id,
      data: { channel, kind: notif.kind, attempts: result.attempts },
    });
    return {
      status: 'delivered',
      notificationId: id,
      channel,
      to,
      attempts: result.attempts,
    };
  }

  const failReason = result.lastError ?? `status ${result.lastStatus}`;
  await emitAuditEvent(ctx, {
    kind: 'notification.failed',
    uid: notif.uid,
    source: 'fabric',
    ref: id,
    data: {
      channel,
      kind: notif.kind,
      attempts: result.attempts,
      reason: failReason,
    },
  });
  return {
    status: 'failed',
    notificationId: id,
    channel,
    to,
    attempts: result.attempts,
    reason: failReason,
  };
}
