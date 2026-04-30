/**
 * Capability: task-list — read open tasks. Pure read; safe to auto-invoke.
 */

import { z } from 'zod';
import { defineCapability, register } from '../framework/index.js';

const TaskShape = z.object({
  id: z.string(),
  title: z.string(),
  notes: z.string().nullable(),
  due: z.string().nullable(),
  tags: z.array(z.string()),
  status: z.enum(['open', 'done', 'archived']),
  createdAt: z.string(),
});

export const taskList = register(
  defineCapability({
    id: 'task-list',
    description:
      'List open tasks in Cockpit OS for the current user. Optionally filter ' +
      'by tag or status. Use when the user asks "what is on my list", "what is ' +
      'next", or wants a snapshot of their queue.',
    emoji: '📋',
    effect: 'read',
    tags: ['cockpit', 'tasks'],
    input: z.object({
      status: z.enum(['open', 'done', 'archived']).default('open'),
      tag: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(25),
    }),
    handler: async (input, ctx) => {
      let q: FirebaseFirestore.Query = ctx.db
        .collection('tasks')
        .where('uid', '==', ctx.uid)
        .where('status', '==', input.status);

      if (input.tag) q = q.where('tags', 'array-contains', input.tag);

      const snap = await q.orderBy('createdAt', 'desc').limit(input.limit).get();
      const tasks: z.infer<typeof TaskShape>[] = [];
      snap.forEach((d) => {
        const data = d.data() as Record<string, unknown>;
        tasks.push({
          id: d.id,
          title: String(data.title ?? ''),
          notes: (data.notes as string | null) ?? null,
          due: (data.due as string | null) ?? null,
          tags: (data.tags as string[]) ?? [],
          status: (data.status as 'open' | 'done' | 'archived') ?? 'open',
          createdAt: String(data.createdAt ?? ''),
        });
      });

      ctx.log.debug('task-list', { count: tasks.length });
      return { count: tasks.length, tasks };
    },
  }),
);
