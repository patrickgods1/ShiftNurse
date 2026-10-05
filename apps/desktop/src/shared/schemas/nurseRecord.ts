/** Argument schemas for `nurseRecord`. */

import { z } from 'zod';
import { id, isoDate, type ResourceSchemas } from './primitives.js';

export const nurseRecordSchemas = {
  exportToFile: z.tuple([id, isoDate, isoDate, z.enum(['csv', 'pdf'])]),
} satisfies ResourceSchemas<'nurseRecord'>;
