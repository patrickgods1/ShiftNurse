/** Argument schemas for `conflicts`. */

import { z } from 'zod';
import { id, money, object, type ResourceSchemas, text } from './primitives.js';

const policy = object({
  enabled: z.boolean(),
  maxCostDelta: money,
  maxFairnessDrop: z.number().min(0),
});

export const conflictsSchemas = {
  analyse: z.tuple([id]),
  policy: z.tuple([id]),
  savePolicy: z.tuple([id, policy]),
  resolve: z.tuple([id, z.string().min(1), text]),
  autoResolve: z.tuple([id]),
} satisfies ResourceSchemas<'conflicts'>;
