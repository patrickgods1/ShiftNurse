/** Argument schemas for `solverSettings`. */

import { z } from 'zod';
import { id, object, type ResourceSchemas } from './primitives.js';

const solverSettings = object({
  solverId: z.enum(['hybrid', 'sa-lns', 'cp-sat']),
  maxIterations: z.number().int().min(1).optional(),
});

export const solverSettingsSchemas = {
  get: z.tuple([id]),
  save: z.tuple([id, solverSettings]),
} satisfies ResourceSchemas<'solverSettings'>;
