/** Argument schemas for `solver`. */

import { z } from 'zod';
import { id, none, object, type ResourceSchemas } from './primitives.js';

/** Mirrors `SolverId` in core's solver registry. */
const solverId = z.enum(['hybrid', 'sa-lns', 'cp-sat']);

/** `count` is not required to be whole: main floors and clamps it, and a check stricter than
 * main would refuse a call that works. Only NaN and out-of-range values are turned away. */
const solveBatchOptions = object({
  count: z.number().min(1).max(10).optional(),
  continueAfter: id.optional(),
  seed: z.number().int().optional(),
  maxIterations: z.number().int().gt(0).optional(),
  solver: solverId.optional(),
  deterministicTime: z.number().gt(0).optional(),
});

const index = z.number().int().min(0);

export const solverSchemas = {
  start: z.tuple([id, solveBatchOptions.optional()]),
  status: z.tuple([id]),
  cancel: z.tuple([id]),
  current: z.tuple([id]),
  discard: z.tuple([id]),
  estimate: z.tuple([id, solveBatchOptions.optional()]),
  candidate: z.tuple([id, index]),
  compare: z.tuple([id]),
  save: z.tuple([id, index]),
  available: none,
} satisfies ResourceSchemas<'solver'>;
