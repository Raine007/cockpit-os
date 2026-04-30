/**
 * Notification fabric types.
 *
 * Two flows touch this layer:
 *
 *  1. **Inbound**: OpenClaw gateway POSTs to Cockpit OS webhooks (e.g. a user
 *     message arrived, a permission was granted). We turn that into a job.
 *
 *  2. **Outbound**: Cockpit OS publishes a notification (e.g. a job completed,
 *     a Firestore trigger fired). We render it for the user's preferred
 *     channel and POST to OpenClaw's /hooks/cockpit-* endpoint, which the
 *     gateway then sends to iMessage/Telegram/Slack/etc.
 *
 * Both directions go through the same fabric so the routing logic, retry
 * policy, and audit trail are consistent.
 */

import { z } from 'zod';

import { JobDeliverySchema } from '../dispatcher/types.js';

/** What Cockpit OS wants to tell the user. Channel-agnostic. */
export const NotificationSchema = z.object({
  /** uid the notification is for. Used to look up channel preferences. */
  uid: z.string().min(1),

  /** Stable kind id; the renderer picks a template by kind. */
  kind: z.string().min(1),

  /** Short title — used as iMessage/Telegram heading or push title. */
  title: z.string().min(1).max(140),

  /** Long-form body. Markdown allowed; the channel renderer downgrades it. */
  body: z.string().min(1).max(4000),

  /**
   * Structured fields the renderer can interpolate. Stays JSON so the
   * outbound webhook payload remains stable across versions.
   */
  data: z.record(z.string(), z.unknown()).optional(),

  /** Optional artifact links (PDF, Dropbox, etc.) surfaced in the message. */
  links: z
    .array(
      z.object({
        label: z.string().min(1).max(80),
        url: z.string().url(),
      }),
    )
    .max(8)
    .optional(),

  /** Severity nudge for the channel — affects formatting and grouping. */
  severity: z.enum(['info', 'success', 'warning', 'error']).default('info'),

  /**
   * Override delivery instead of looking up the user's preferences. Used by
   * job.deliver and by callers that already know exactly where to send.
   */
  deliver: JobDeliverySchema.optional(),
});
export type Notification = z.infer<typeof NotificationSchema>;

/** What a channel renderer produces for the outbound payload. */
export interface RenderedMessage {
  /** Plain-text body. Always populated; some channels only accept text. */
  text: string;
  /** Optional markdown body for channels that render it (Slack, Telegram). */
  markdown?: string;
  /** Optional rich attachments (Slack blocks, Telegram inline keyboards). */
  attachments?: Array<{ label: string; url: string }>;
}

/** Channel-specific outbound payload posted to /hooks/cockpit-*. */
export interface OutboundDelivery {
  channel: 'imessage' | 'telegram' | 'whatsapp' | 'slack' | 'discord' | 'push' | 'silent';
  to: string;
  message: RenderedMessage;
  /** Echoed to the gateway for idempotency / dedup. */
  notificationId: string;
  /** ISO timestamp for ordering / replay detection. */
  sentAt: string;
}

/** What we receive from the gateway. */
export const InboundEventSchema = z.object({
  /** Mapping id from openclaw.json hooks.mappings, e.g. "cockpit-task-due". */
  mappingId: z.string().min(1),
  /** uid the gateway thinks this event is on behalf of. We re-validate. */
  uid: z.string().min(1).optional(),
  /**
   * Channel the event arrived on. When provided alongside `handle`, the
   * inbound handler resolves it to a Cockpit uid via the identity registry
   * and prefers that result over any uid the gateway claimed.
   */
  channel: z
    .enum(['imessage', 'telegram', 'whatsapp', 'slack', 'discord', 'email', 'push'])
    .optional(),
  /** Channel-native handle (phone, chat id, workspace member id, ...). */
  handle: z.string().min(1).optional(),
  /** Free-form payload — each mapping owns its shape. */
  body: z.record(z.string(), z.unknown()).default({}),
  /** Optional gateway-provided idempotency key. */
  eventId: z.string().min(1).optional(),
});
export type InboundEvent = z.infer<typeof InboundEventSchema>;

/** Result of handling an inbound event. */
export interface InboundResult {
  ok: boolean;
  /** When the event spawned a job, the job id is here. */
  jobId?: string;
  /** Why the event was rejected. */
  error?: string;
}
