/**
 * Capability: task-create — quick capture from any channel.
 */

import { z } from 'zod';
import { defineCapability, register } from '../framework/index.js';

export const taskCreate = register(
  defineCapability({
    id: 'task-create',
    description:
      'Create a task in Cockpit OS. Use when the user wants to add, capture, ' +
      'log, queue, or remember a to-do item. Accepts a short title and optional ' +
      'notes, due date, and tags.',
    emoji: '📝',
    effect: 'write',
    tags: ['cockpit', 'tasks', 'capture'],
    input: z.object({
      title: z.string().min(1).max(200).describe('Short title for the task.'),
      notes: z.string().max(2000).optional().describe('Long-form notes.'),
      due: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe('ISO 8601 due date (e.g. 2026-04-30T17:00:00-07:00).'),
      tags: z.array(z.string().min(1).max(40)).max(10).optional(),
    }),
    handler: async (input, ctx) => {
      const doc = {
        uid: ctx.uid,
        title: input.title,
        notes: input.notes ?? null,
        due: input.due ?? null,
        tags: input.tags ?? [],
        status: 'open' as const,
        createdAt: ctx.startedAt,
        source: ctx.source,
      };

      if (ctx.dryRun) {
        ctx.log.info('task-create (dry-run)', { title: input.title });
        return { id: 'dry_run', task: doc, dryRun: true as const };
      }

      const ref = await ctx.db.collection('tasks').add(doc);
      ctx.log.info('task-create', { id: ref.id });
      return { id: ref.id, task: doc, dryRun: false as const };
    },
  }),
);
