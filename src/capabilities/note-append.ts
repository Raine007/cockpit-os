/**
 * Capability: note-append — append to a daily journal note.
 *
 * Slightly more interesting than task-create because it demonstrates a
 * *transactional* read-modify-write pattern: capability handlers can do
 * non-trivial work, not just CRUD.
 */

import { z } from 'zod';
import { defineCapability, register } from '../framework/index.js';

function todayKey(iso: string): string {
  // YYYY-MM-DD in UTC; good enough for a daily note key.
  return iso.slice(0, 10);
}

export const noteAppend = register(
  defineCapability({
    id: 'note-append',
    description:
      'Append a line to today\'s journal note in Cockpit OS. Use for quick ' +
      'thoughts, observations, or things the user wants to remember without ' +
      'creating a full task. Creates today\'s note if it does not exist yet.',
    emoji: '🗒️',
    effect: 'write',
    tags: ['cockpit', 'notes', 'journal'],
    input: z.object({
      text: z.string().min(1).max(4000),
      day: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('YYYY-MM-DD; defaults to today (UTC).'),
    }),
    handler: async (input, ctx) => {
      const day = input.day ?? todayKey(ctx.startedAt);
      const noteId = `${ctx.uid}_${day}`;
      const ref = ctx.db.collection('notes').doc(noteId);

      if (ctx.dryRun) {
        ctx.log.info('note-append (dry-run)', { day, len: input.text.length });
        return { noteId, day, appended: input.text, dryRun: true as const };
      }

      const existing = await ref.get();
      const prev = existing.exists ? (existing.data()?.body as string) ?? '' : '';
      const stamp = new Date(ctx.startedAt).toISOString().slice(11, 16); // HH:MM UTC
      const next = prev ? `${prev}\n- [${stamp}] ${input.text}` : `- [${stamp}] ${input.text}`;

      await ref.set({
        uid: ctx.uid,
        day,
        body: next,
        updatedAt: ctx.startedAt,
      });

      ctx.log.info('note-append', { noteId, len: next.length });
      return { noteId, day, appended: input.text, dryRun: false as const };
    },
  }),
);
