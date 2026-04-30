/**
 * Channel preferences — where Cockpit OS should reach a user.
 *
 * Stored in Firestore at `users/{uid}/preferences`. The fabric falls back
 * through these in order until it finds a usable channel for the
 * notification severity. A user with `imessage` primary and `push` fallback
 * gets iMessage when they're awake and push when iMessage isn't configured.
 *
 * In dry-run mode the in-memory shim returns whatever was last written, so
 * tests can seed preferences without standing up Firebase.
 */

import { z } from 'zod';

import type { CockpitContext } from '../context/types.js';
import type { Notification, OutboundDelivery } from './types.js';

const ChannelSchema = z.object({
  channel: z.enum([
    'imessage',
    'telegram',
    'whatsapp',
    'slack',
    'discord',
    'push',
    'silent',
  ]),
  to: z.string().min(1),
  /** Lower = preferred. Multiple channels with the same priority is fine. */
  priority: z.number().int().nonnegative().default(0),
  /** Minimum severity that may use this channel. */
  minSeverity: z.enum(['info', 'success', 'warning', 'error']).default('info'),
});
export type ChannelPreference = z.infer<typeof ChannelSchema>;

export const PreferencesSchema = z.object({
  uid: z.string().min(1),
  channels: z.array(ChannelSchema).default([]),
  /** Quiet hours (UTC HH:MM-HH:MM); only severity >= warning bypasses. */
  quietHours: z
    .object({ from: z.string(), to: z.string() })
    .nullable()
    .default(null),
});
export type Preferences = z.infer<typeof PreferencesSchema>;

const COLLECTION = 'preferences';

const SEVERITY_RANK: Record<Notification['severity'], number> = {
  info: 0,
  success: 1,
  warning: 2,
  error: 3,
};

export async function getPreferences(
  ctx: CockpitContext,
  uid: string,
): Promise<Preferences> {
  const snap = await ctx.db.collection(COLLECTION).doc(uid).get();
  if (!snap.exists) {
    return PreferencesSchema.parse({ uid, channels: [] });
  }
  // Re-parse for safety; old documents may be missing fields.
  return PreferencesSchema.parse(snap.data());
}

export async function setPreferences(
  ctx: CockpitContext,
  prefs: Preferences,
): Promise<void> {
  const valid = PreferencesSchema.parse(prefs);
  await ctx.db.collection(COLLECTION).doc(valid.uid).set(valid);
}

/**
 * Pick the best channel for a notification. Returns null if every configured
 * channel is filtered out (severity too low, in quiet hours, etc.) — in that
 * case the fabric drops the notification and audit-logs the reason.
 */
export function pickChannel(
  prefs: Preferences,
  severity: Notification['severity'],
  nowIso: string = new Date().toISOString(),
): OutboundDelivery['channel'] extends infer C
  ? { channel: C; to: string } | null
  : never {
  // 1. Filter by severity.
  const eligible = prefs.channels
    .filter((c) => SEVERITY_RANK[severity] >= SEVERITY_RANK[c.minSeverity])
    .sort((a, b) => a.priority - b.priority);
  if (eligible.length === 0) return null;

  // 2. Quiet hours: only severity >= warning bypasses.
  if (prefs.quietHours && SEVERITY_RANK[severity] < SEVERITY_RANK['warning']) {
    if (insideWindow(nowIso, prefs.quietHours.from, prefs.quietHours.to)) {
      return null;
    }
  }

  const top = eligible[0]!;
  return { channel: top.channel, to: top.to } as never;
}

/** UTC-only HH:MM window check. Handles wraparound (e.g. 22:00-06:00). */
function insideWindow(iso: string, from: string, to: string): boolean {
  const m = (s: string): number => {
    const [h, mm] = s.split(':').map((n) => Number.parseInt(n, 10));
    return (h ?? 0) * 60 + (mm ?? 0);
  };
  const now = new Date(iso);
  const cur = now.getUTCHours() * 60 + now.getUTCMinutes();
  const a = m(from);
  const b = m(to);
  if (a <= b) return cur >= a && cur < b;
  return cur >= a || cur < b;
}
