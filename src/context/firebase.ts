/**
 * Firebase Admin bootstrap with a dry-run fallback.
 *
 * Real Firestore: when GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_PROJECT_ID
 *   is set and COCKPIT_DRY_RUN is not '1'.
 * In-memory dry-run: otherwise. Keeps OpenClaw skill tests and local dev
 *   from ever touching production data.
 *
 * The dry-run client is intentionally a tiny shim — only the handful of
 * methods the example capabilities use are stubbed. Add more as you wire
 * more handlers; intentionally do NOT reimplement the whole SDK surface.
 */

import { initializeApp, getApps, cert, applicationDefault } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

import { logger } from './logger.js';

let cached: { db: Firestore; dryRun: boolean } | null = null;

export function getFirebase(): { db: Firestore; dryRun: boolean } {
  if (cached) return cached;

  const forceDryRun = process.env.COCKPIT_DRY_RUN === '1';
  const hasCreds =
    !!process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    !!process.env.FIREBASE_PROJECT_ID;

  if (forceDryRun || !hasCreds) {
    logger.warn('Firebase running in DRY-RUN mode (in-memory).', {
      reason: forceDryRun ? 'COCKPIT_DRY_RUN=1' : 'no credentials',
    });
    cached = { db: createDryRunFirestore(), dryRun: true };
    return cached;
  }

  if (getApps().length === 0) {
    // Credential resolution order:
    //   1. Explicit service-account JSON env vars (FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY)
    //   2. Application Default Credentials (Cloud Run/GCE runtime SA, or GOOGLE_APPLICATION_CREDENTIALS file)
    // On Cloud Run we want #2 — the runtime service account is auto-injected and we don't ship a key file.
    const hasExplicitServiceAccount =
      !!process.env.FIREBASE_CLIENT_EMAIL && !!process.env.FIREBASE_PRIVATE_KEY;

    initializeApp({
      credential: hasExplicitServiceAccount
        ? cert({
            projectId: process.env.FIREBASE_PROJECT_ID!,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL!,
            privateKey: process.env.FIREBASE_PRIVATE_KEY!.replace(/\\n/g, '\n'),
          })
        : applicationDefault(),
      ...(process.env.FIREBASE_PROJECT_ID && { projectId: process.env.FIREBASE_PROJECT_ID }),
    });
  }

  cached = { db: getFirestore(), dryRun: false };
  return cached;
}

/* -------------------------------------------------------------------------- */
/* Dry-run shim                                                                */
/* -------------------------------------------------------------------------- */

interface DryDoc {
  id: string;
  data: Record<string, unknown>;
}

function createDryRunFirestore(): Firestore {
  const collections = new Map<string, Map<string, DryDoc>>();

  const ensure = (path: string) => {
    if (!collections.has(path)) collections.set(path, new Map());
    return collections.get(path)!;
  };

  const collection = (path: string): unknown => {
    const docs = ensure(path);
    return {
      add: async (data: Record<string, unknown>) => {
        const id = `dry_${Math.random().toString(36).slice(2, 10)}`;
        docs.set(id, { id, data: { ...data } });
        logger.debug('dry-run add', { path, id });
        return {
          id,
          get: async () => ({ id, exists: true, data: () => docs.get(id)!.data }),
        };
      },
      doc: (id: string) => ({
        id,
        set: async (data: Record<string, unknown>) => {
          docs.set(id, { id, data: { ...data } });
          logger.debug('dry-run set', { path, id });
        },
        get: async () => {
          const found = docs.get(id);
          return {
            id,
            exists: !!found,
            data: () => found?.data,
          };
        },
        delete: async () => {
          docs.delete(id);
          logger.debug('dry-run delete', { path, id });
        },
      }),
      where: (_field: string, _op: string, _val: unknown) => collection(path),
      orderBy: (_field: string, _dir?: 'asc' | 'desc') => collection(path),
      limit: (n: number) => ({
        get: async () => {
          const items = [...docs.values()].slice(0, n);
          return {
            size: items.length,
            empty: items.length === 0,
            docs: items.map((d) => ({
              id: d.id,
              exists: true,
              data: () => d.data,
            })),
            forEach: (cb: (doc: { id: string; data: () => Record<string, unknown> }) => void) => {
              for (const d of items) cb({ id: d.id, data: () => d.data });
            },
          };
        },
      }),
      get: async () => {
        const items = [...docs.values()];
        return {
          size: items.length,
          empty: items.length === 0,
          docs: items.map((d) => ({
            id: d.id,
            exists: true,
            data: () => d.data,
          })),
          forEach: (cb: (doc: { id: string; data: () => Record<string, unknown> }) => void) => {
            for (const d of items) cb({ id: d.id, data: () => d.data });
          },
        };
      },
    };
  };

  return { collection } as unknown as Firestore;
}
