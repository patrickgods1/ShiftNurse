/** Argument schemas for `nurseRecord`. */

import { z } from 'zod';
import { id, isoDate, type ResourceSchemas, readRange } from './primitives.js';

export const nurseRecordSchemas = {
  exportToFile: z
    .tuple([id, isoDate, isoDate, z.enum(['csv', 'pdf'])])
    .superRefine(readRange(3660)),
} satisfies ResourceSchemas<'nurseRecord'>;
