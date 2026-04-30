/**
 * Phase 5 — Identity resolver.
 *
 * Looks up `${channel}:${handle}` in `channelIdentities/` and returns the
 * Cockpit uid (or null if no live binding exists). Revoked bindings count
 * as unknown — they're kept for audit but never resolve.
 *
 * Bindings are managed via `bindIdentity()` / `revokeIdentity()`. In
 * production the dashboard exposes these as admin-only operations; in
 * dry-run / tests the same calls work against the in-memory shim.
 */

import { emitAuditEvent } from '../audit/log.js';
import type { CockpitContext } from '../context/types.js';
import {
  ChannelIdentitySchema,
  NewChannelIdentitySchema,
  identityDocId,
  type ChannelIdentity,
  type IdentityChannel,
  type NewChannelIdentity,
  type ResolveRequest,
  type ResolveResult,
} from './types.js';

const COLLECTION = 'channelIdentities';

function nowIso(): string {
  return new Date().toISOString();
}

/** Bind a (channel, handle) → uid. Idempotent; replaces any existing binding. */
export async function bindIdentity(
  ctx: CockpitContext,
  input: NewChannelIdentity,
): Promise<ChannelIdentity> {
  const parsed = NewChannelIdentitySchema.parse(input);
  const id = identityDocId(parsed.channel, parsed.handle);
  const ts = nowIso();

  // Preserve createdAt across re-binds so the audit trail is honest.
  const existingSnap = await ctx.db.collection(COLLECTION).doc(id).get();
  let createdAt = ts;
  if (existingSnap.exists) {
    const prev = existingSnap.data() as { createdAt?: string };
    if (prev?.createdAt) createdAt = prev.createdAt;
  }

  const identity = ChannelIdentitySchema.parse({
    id,
    channel: parsed.channel,
    handle: parsed.handle,
    uid: parsed.uid,
    label: parsed.label,
    createdAt,
    revokedAt: null,
  });
  await ctx.db.collection(COLLECTION).doc(id).set(identity);
  ctx.log.info('identity bound', { id, uid: parsed.uid });
  await emitAuditEvent(ctx, {
    kind: 'identity.bound',
    uid: parsed.uid,
    source: 'identity',
    ref: id,
    data: { channel: parsed.channel, handle: parsed.handle, label: parsed.label ?? null },
  });
  return identity;
}

/** Mark an identity as revoked. Subsequent resolve() calls return null. */
export async function revokeIdentity(
  ctx: CockpitContext,
  channel: IdentityChannel,
  handle: string,
): Promise<ChannelIdentity | null> {
  const id = identityDocId(channel, handle);
  const snap = await ctx.db.collection(COLLECTION).doc(id).get();
  if (!snap.exists) return null;
  const current = ChannelIdentitySchema.parse(snap.data());
  if (current.revokedAt) return current;
  const next = ChannelIdentitySchema.parse({
    ...current,
    revokedAt: nowIso(),
  });
  await ctx.db.collection(COLLECTION).doc(id).set(next);
  ctx.log.info('identity revoked', { id });
  await emitAuditEvent(ctx, {
    kind: 'identity.revoked',
    uid: current.uid,
    source: 'identity',
    ref: id,
    data: { channel, handle },
  });
  return next;
}

/** Look up the Cockpit uid for a channel handle. */
export async function resolveIdentity(
  ctx: CockpitContext,
  req: ResolveRequest,
): Promise<ResolveResult> {
  const id = identityDocId(req.channel, req.handle);
  const snap = await ctx.db.collection(COLLECTION).doc(id).get();
  if (!snap.exists) {
    return { uid: null, reason: 'unknown' };
  }
  const identity = ChannelIdentitySchema.parse(snap.data());
  if (identity.revokedAt) {
    return { uid: null, reason: 'revoked', identity };
  }
  return { uid: identity.uid, identity };
}

/** Convenience: list all identities for a uid (for the dashboard / debug). */
export async function listIdentitiesForUid(
  ctx: CockpitContext,
  uid: string,
): Promise<ChannelIdentity[]> {
  // The dry-run shim doesn't index, so iterate. Real Firestore uses where().
  const snap = await ctx.db.collection(COLLECTION).get();
  const out: ChannelIdentity[] = [];
  for (const doc of snap.docs) {
    try {
      const data = ChannelIdentitySchema.parse(doc.data());
      if (data.uid === uid) out.push(data);
    } catch {
      // Skip rows that don't parse — schema drift, deletion in progress, etc.
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
