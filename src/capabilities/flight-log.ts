/**
 * Capability: flight-log — write a flight entry. Aviation-domain example.
 */

import { z } from 'zod';
import { defineCapability, register } from '../framework/index.js';

export const flightLog = register(
  defineCapability({
    id: 'flight-log',
    description:
      'Log a flight entry: tail number, route (ICAO codes preferred), hours, ' +
      'and an optional anomaly note. Use when the user reports completing a ' +
      'flight or wants to add a logbook entry.',
    emoji: '✈️',
    effect: 'write',
    tags: ['cockpit', 'aviation', 'logbook'],
    input: z.object({
      tail: z
        .string()
        .regex(/^[A-Z0-9-]{2,10}$/i, 'Tail number must be 2-10 alphanumerics or hyphens.')
        .transform((v) => v.toUpperCase()),
      route: z
        .string()
        .min(3)
        .max(120)
        .describe('Free-form route, e.g. "KSDL → KSEZ → KSDL" or "KPHX-KFLG".'),
      hours: z.number().positive().max(24),
      anomaly: z.string().max(2000).optional(),
      flownAt: z.string().datetime({ offset: true }).optional(),
    }),
    handler: async (input, ctx) => {
      const doc = {
        uid: ctx.uid,
        tail: input.tail,
        route: input.route,
        hours: input.hours,
        anomaly: input.anomaly ?? null,
        flownAt: input.flownAt ?? ctx.startedAt,
        loggedAt: ctx.startedAt,
        source: ctx.source,
      };

      if (ctx.dryRun) {
        ctx.log.info('flight-log (dry-run)', { tail: input.tail, hours: input.hours });
        return { id: 'dry_run', flight: doc, dryRun: true as const };
      }

      const ref = await ctx.db.collection('flights').add(doc);
      ctx.log.info('flight-log', { id: ref.id, tail: input.tail });
      return { id: ref.id, flight: doc, dryRun: false as const };
    },
  }),
);
