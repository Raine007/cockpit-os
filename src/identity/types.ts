/**
 * Phase 5 — Identity types.
 *
 * Cockpit OS jobs and notifications are scoped by `uid`. The OpenClaw
 * gateway, however, knows the user by a *channel handle* — a phone number
 * for iMessage, a chat id for Telegram, an email for an inbound mailer,
 * a workspace id for Slack, and so on.
 *
 * The identity resolver is the layer that turns "this came in over channel
 * X with handle Y" into "Cockpit user U". It's deliberately small: a
 * handful of types, a Firestore-backed registry, and a single
 * `resolveIdentity()` function that the inbound webhook calls before
 * handing the event off to a mapping.
 *
 * Security note: a missing or unknown handle does NOT silently fall back
 * to a default user. The resolver returns `null` and the inbound handler
 * rejects the event so we never spawn jobs against the wrong identity.
 */

import { z } from 'zod';

/** Supported channel kinds for identity lookup. Mirrors job delivery channels. */
export const IDENTITY_CHANNELS = [
  'imessage',
  'telegram',
  'whatsapp',
  'slack',
  'discord',
  'email',
  'push',
] as const;
export type IdentityChannel = (typeof IDENTITY_CHANNELS)[number];

/**
 * One Firestore document per (channel, handle) pair. The `id` is the
 * concatenation `${channel}:${handle}` so lookup is O(1) by document id
 * with no compound query.
 */
export const ChannelIdentitySchema = z.object({
  /** Document id; equals `${channel}:${handle}`. */
  id: z.string().min(1),
  channel: z.enum(IDENTITY_CHANNELS),
  /** Channel-native handle: phone, chat id, workspace member id, etc. */
  handle: z.string().min(1),
  /** Cockpit uid this handle resolves to. */
  uid: z.string().min(1),
  /** Human-readable label, surfaced in the dashboard. */
  label: z.string().optional(),
  /** When this binding was first established. */
  createdAt: z.string().datetime({ offset: true }),
  /** Soft revoke without deleting the row. Resolver treats this as unknown. */
  revokedAt: z.string().datetime({ offset: true }).nullable().default(null),
});
export type ChannelIdentity = z.infer<typeof ChannelIdentitySchema>;

/** Input shape for binding a new identity. */
export const NewChannelIdentitySchema = z.object({
  channel: z.enum(IDENTITY_CHANNELS),
  handle: z.string().min(1),
  uid: z.string().min(1),
  label: z.string().optional(),
});
export type NewChannelIdentity = z.infer<typeof NewChannelIdentitySchema>;

/** What the resolver consumes from the gateway. */
export interface ResolveRequest {
  /** Channel the event arrived on. */
  channel: IdentityChannel;
  /** Channel-native handle. */
  handle: string;
}

export interface ResolveResult {
  /** Resolved Cockpit uid, or null when no live binding exists. */
  uid: string | null;
  /** The resolved identity document, when found. */
  identity?: ChannelIdentity;
  /** Why the resolve failed; only populated when uid is null. */
  reason?: 'unknown' | 'revoked';
}

export function identityDocId(channel: IdentityChannel, handle: string): string {
  return `${channel}:${handle}`;
}
